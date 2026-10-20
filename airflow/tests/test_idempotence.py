"""
Tests d'integration du chargement MongoDB (idempotence et doublons).

Ils utilisent une base dediee (ventes_db_test) definie par la variable
ETL_MONGO_URI_TEST, positionnee dans le conteneur Airflow par docker-compose.
Sans cette variable, les tests sont ignores.
"""

import os
from datetime import datetime

import pytest

from etl_ventes import chargement, transformation

URI = os.environ.get("ETL_MONGO_URI_TEST")
pytestmark = pytest.mark.skipif(not URI, reason="ETL_MONGO_URI_TEST non defini")

MAINTENANT = datetime(2026, 10, 19, 12, 0, 0)


@pytest.fixture()
def db():
    from pymongo import MongoClient

    client = MongoClient(URI, serverSelectionTimeoutMS=5000)
    base = client.get_default_database()
    for nom in (chargement.COLL_CLIENTS, chargement.COLL_VENTES, chargement.COLL_REJETS):
        base[nom].drop()
    chargement.assurer_index(base)
    base[chargement.COLL_CLIENTS].insert_one({"code_client": "CLI-0001", "nom": "KABORE"})
    yield base
    client.close()


def lignes(n=5, **surcharges):
    resultat = []
    for i in range(1, n + 1):
        ligne = {
            "reference": f"VTE-20261001-{i:04d}", "date_vente": "2026-10-01 10:00:00",
            "code_client": "CLI-0001", "code_produit": "PRD-002", "libelle_produit": "Huile végétale 5 L",
            "categorie": "Alimentation", "quantite": "1", "prix_unitaire": "6500", "remise_pct": "0",
            "mode_paiement": "ESPECES", "canal": "BOUTIQUE", "point_vente": "OUAGA-2000",
            "statut": "VALIDEE", "date_maj": "2026-10-01 10:05:00",
            "_fichier": "ventes_2026-10-01.csv", "_ligne": i + 1,
        }
        ligne.update(surcharges)
        resultat.append(ligne)
    return resultat


def charger(db, brutes, run_id):
    valides, _, _ = transformation.transformer_ventes(brutes, {"CLI-0001"}, MAINTENANT)
    return chargement.charger_ventes(db, valides, run_id)[0]


def test_second_passage_sans_ecriture(db):
    premier = charger(db, lignes(), "run-1")
    second = charger(db, lignes(), "run-2")
    assert premier["inserees"] == 5
    assert second == {"inserees": 0, "mises_a_jour": 0, "inchangees": 5, "ignorees_supprimees": 0, "conflits": 0}
    assert db.ventes.count_documents({}) == 5
    # le run-2 n'a modifie aucun document : la trace etl.run_id reste celle du run-1
    assert db.ventes.count_documents({"etl.run_id": "run-1"}) == 5


def test_modification_source_incremente_la_version(db):
    charger(db, lignes(), "run-1")
    bilan = charger(db, lignes(quantite="3"), "run-2")
    assert bilan["mises_a_jour"] == 5
    vente = db.ventes.find_one({"reference": "VTE-20261001-0001"})
    assert vente["quantite"] == 3
    assert vente["montant_net"] == 19500
    assert vente["version"] == 2


def test_vente_supprimee_non_recreee(db):
    charger(db, lignes(), "run-1")
    db.ventes.update_one({"reference": "VTE-20261001-0001"}, {"$set": {"supprime": True}})
    bilan = charger(db, lignes(quantite="2"), "run-2")
    assert bilan["ignorees_supprimees"] == 1
    assert db.ventes.find_one({"reference": "VTE-20261001-0001"})["quantite"] == 1


def test_vente_saisie_par_api_non_ecrasee(db):
    db.ventes.insert_one({"reference": "VTE-20261001-0001", "source": "API", "quantite": 9})
    bilan = charger(db, lignes(), "run-1")
    assert bilan["conflits"] == 1
    assert db.ventes.find_one({"reference": "VTE-20261001-0001"})["quantite"] == 9


def test_rejets_rejouables(db):
    brutes = lignes(2) + lignes(1, reference="VTE-20261001-0099", code_client="CLI-9999", _ligne=50)
    _, rejets, doublons = transformation.transformer_ventes(brutes, {"CLI-0001"}, MAINTENANT)
    chargement.enregistrer_rejets(db, "run-1", "vente", rejets, doublons)
    chargement.enregistrer_rejets(db, "run-1", "vente", rejets, doublons)  # retry de la tache
    assert db.ventes_rejets.count_documents({"run_id": "run-1"}) == 1


def test_controles_conformes(db):
    charger(db, lignes(), "run-1")
    resultats = chargement.controler_chargement(db, [f"VTE-20261001-{i:04d}" for i in range(1, 6)])
    assert all(r["conforme"] for r in resultats), resultats

"""Tests unitaires des regles de normalisation (aucune dependance externe)."""

from datetime import datetime

import pytest

from etl_ventes import transformation as t

CLIENTS = {"CLI-0001", "CLI-0002"}
MAINTENANT = datetime(2026, 10, 19, 12, 0, 0)


def ligne_vente(**surcharges):
    ligne = {
        "reference": "VTE-20261001-0001",
        "date_vente": "2026-10-01 09:15:00",
        "code_client": "CLI-0001",
        "code_produit": "PRD-001",
        "libelle_produit": "Riz parfumé 25 kg",
        "categorie": "Alimentation",
        "quantite": "2",
        "prix_unitaire": "17500",
        "remise_pct": "10",
        "mode_paiement": "Orange Money",
        "canal": "boutique",
        "point_vente": "ouaga-centre",
        "statut": "VALIDEE",
        "date_maj": "2026-10-01 09:20:00",
        "_fichier": "ventes_2026-10-01.csv",
        "_ligne": 2,
    }
    ligne.update(surcharges)
    return ligne


def codes(motifs):
    return {m["code"] for m in motifs}


class TestNormalisationVente:
    def test_ligne_valide_est_normalisee(self):
        doc, motifs = t.normaliser_vente(ligne_vente(), CLIENTS, MAINTENANT)
        assert motifs == []
        assert doc["mode_paiement"] == "MOBILE_MONEY"
        assert doc["canal"] == "BOUTIQUE"
        assert doc["point_vente"] == "OUAGA-CENTRE"
        assert doc["montant_brut"] == 35000
        assert doc["montant_remise"] == 3500
        assert doc["montant_net"] == 31500
        assert doc["devise"] == "XOF"
        assert doc["date_vente"] == "2026-10-01T09:15:00"
        assert len(doc["hash"]) == 64

    @pytest.mark.parametrize("brut, attendu", [("17 500", 17500), ("17500,00", 17500), ("17 500", 17500)])
    def test_formats_de_montant(self, brut, attendu):
        doc, motifs = t.normaliser_vente(ligne_vente(prix_unitaire=brut), CLIENTS, MAINTENANT)
        assert motifs == []
        assert doc["prix_unitaire"] == attendu

    def test_date_au_format_francais(self):
        doc, _ = t.normaliser_vente(ligne_vente(date_vente="01/10/2026 09:15"), CLIENTS, MAINTENANT)
        assert doc["date_vente"] == "2026-10-01T09:15:00"

    @pytest.mark.parametrize("brut, attendu", [
        ("ALIMENTATION", "Alimentation"), ("électroménager", "Électroménager"), ("HYGIENE", "Hygiène"),
    ])
    def test_categories_harmonisees(self, brut, attendu):
        doc, _ = t.normaliser_vente(ligne_vente(categorie=brut), CLIENTS, MAINTENANT)
        assert doc["produit"]["categorie"] == attendu

    @pytest.mark.parametrize("surcharge, motif", [
        ({"code_client": "CLI-9999"}, "CLIENT_INCONNU"),
        ({"quantite": "0"}, "QUANTITE_INVALIDE"),
        ({"quantite": "deux"}, "QUANTITE_INVALIDE"),
        ({"quantite": "1.5"}, "QUANTITE_INVALIDE"),
        ({"prix_unitaire": "-100"}, "PRIX_INVALIDE"),
        ({"remise_pct": "80"}, "REMISE_INVALIDE"),
        ({"date_vente": "2026-13-45 10:00:00"}, "DATE_INVALIDE"),
        ({"date_vente": "2027-01-01 10:00:00"}, "DATE_FUTURE"),
        ({"code_produit": ""}, "CHAMP_OBLIGATOIRE"),
        ({"reference": ""}, "CHAMP_OBLIGATOIRE"),
        ({"reference": "V-1"}, "FORMAT_REFERENCE"),
        ({"mode_paiement": "Bitcoin"}, "MODE_PAIEMENT_INCONNU"),
        ({"canal": "Pigeon"}, "CANAL_INCONNU"),
        ({"statut": "EN_ATTENTE"}, "STATUT_INCONNU"),
    ])
    def test_lignes_invalides_rejetees(self, surcharge, motif):
        doc, motifs = t.normaliser_vente(ligne_vente(**surcharge), CLIENTS, MAINTENANT)
        assert doc is None
        assert motif in codes(motifs)

    def test_plusieurs_motifs_sont_cumules(self):
        _, motifs = t.normaliser_vente(ligne_vente(code_client="CLI-9999", quantite="0"), CLIENTS, MAINTENANT)
        assert codes(motifs) == {"CLIENT_INCONNU", "QUANTITE_INVALIDE"}

    def test_empreinte_ignore_date_maj_et_origine(self):
        a, _ = t.normaliser_vente(ligne_vente(), CLIENTS, MAINTENANT)
        b, _ = t.normaliser_vente(ligne_vente(date_maj="2026-10-02 08:00:00", _fichier="autre.csv", _ligne=40),
                                  CLIENTS, MAINTENANT)
        assert a["hash"] == b["hash"]

    def test_empreinte_change_avec_le_contenu(self):
        a, _ = t.normaliser_vente(ligne_vente(), CLIENTS, MAINTENANT)
        b, _ = t.normaliser_vente(ligne_vente(quantite="3"), CLIENTS, MAINTENANT)
        assert a["hash"] != b["hash"]


class TestDedoublonnage:
    def test_doublon_exact_et_version_obsolete(self):
        correction = {"quantite": "5", "date_maj": "2026-10-01 11:00:00"}
        lignes = [
            ligne_vente(_ligne=2),                 # version initiale
            ligne_vente(_ligne=3, **correction),   # correction posterieure
            ligne_vente(_ligne=4, **correction),   # copie exacte de la correction
            ligne_vente(_ligne=5, reference="VTE-20261001-0002"),
        ]
        retenus, rejets, ecartes = t.transformer_ventes(lignes, CLIENTS, MAINTENANT)
        assert rejets == []
        assert [d["reference"] for d in retenus] == ["VTE-20261001-0001", "VTE-20261001-0002"]
        assert retenus[0]["quantite"] == 5  # la version la plus recente est conservee
        assert sorted(code for _, code in ecartes) == ["DOUBLON_EXACT", "VERSION_OBSOLETE"]

    def test_chevauchement_entre_fichiers(self):
        lignes = [
            ligne_vente(_fichier="ventes_2026-10-01.csv", _ligne=2),
            ligne_vente(_fichier="ventes_2026-10-02.csv", _ligne=17),
        ]
        retenus, _, ecartes = t.transformer_ventes(lignes, CLIENTS, MAINTENANT)
        assert len(retenus) == 1
        assert ecartes[0][1] == "DOUBLON_EXACT"

    def test_transformation_deterministe(self):
        lignes = [ligne_vente(_ligne=n, reference=f"VTE-20261001-{n:04d}") for n in range(2, 30)]
        premier = t.transformer_ventes(lignes, CLIENTS, MAINTENANT)
        second = t.transformer_ventes(list(reversed(lignes)), CLIENTS, MAINTENANT)
        assert [d["hash"] for d in premier[0]] == [d["hash"] for d in second[0]]


class TestClients:
    def test_client_normalise(self):
        doc, motifs = t.normaliser_client({
            "code_client": "cli-0001", "nom": "ouedraogo", "prenom": "  AMINATA ",
            "email": " Aminata.Ouedraogo@Exemple.BF ", "telephone": "+226 70 12 34 56",
            "ville": "ouagadougou", "type_client": "particulier", "date_inscription": "2025-01-15",
        })
        assert motifs == []
        assert doc["code_client"] == "CLI-0001"
        assert doc["nom"] == "OUEDRAOGO"
        assert doc["prenom"] == "Aminata"
        assert doc["email"] == "aminata.ouedraogo@exemple.bf"
        assert doc["telephone"] == "+22670123456"
        assert doc["ville"] == "Ouagadougou"

    @pytest.mark.parametrize("surcharge, motif", [
        ({"nom": ""}, "CHAMP_OBLIGATOIRE"),
        ({"email": "pas-un-email"}, "EMAIL_INVALIDE"),
        ({"telephone": "123"}, "TELEPHONE_INVALIDE"),
        ({"code_client": "C1"}, "FORMAT_CODE_CLIENT"),
    ])
    def test_client_invalide(self, surcharge, motif):
        ligne = {"code_client": "CLI-0001", "nom": "KABORE", "prenom": "Ali", "email": "",
                 "telephone": "", "ville": "", "type_client": "", "date_inscription": ""}
        ligne.update(surcharge)
        doc, motifs = t.normaliser_client(ligne)
        assert doc is None
        assert motif in codes(motifs)

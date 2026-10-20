"""
Chargement idempotent dans MongoDB.

Principe : chaque document porte une cle metier unique (code_client,
reference) et l'empreinte SHA-256 de son contenu (etl.hash). Pour chaque
ligne valide :

  - cle absente de la base          -> insertion ;
  - cle presente, empreinte egale   -> aucune ecriture (inchangee) ;
  - cle presente, empreinte differente -> mise a jour, version + 1.

Rejouer le DAG sur les memes fichiers ne produit donc aucune ecriture sur
les collections metier. Les ecritures passent par des upserts sur la cle
metier : meme une relance partielle (retry de tache) ne cree pas de doublon,
et l'index unique sur la cle metier sert de dernier garde-fou.
"""

from datetime import datetime, timezone

from pymongo import ASCENDING, DESCENDING, UpdateOne

COLL_CLIENTS = "clients"
COLL_VENTES = "ventes"
COLL_REJETS = "ventes_rejets"
COLL_EXECUTIONS = "etl_executions"

CHAMPS_CLIENT = ("nom", "prenom", "email", "telephone", "ville", "type_client")
CHAMPS_VENTE = (
    "code_client", "produit", "quantite", "prix_unitaire", "remise_pct",
    "montant_brut", "montant_remise", "montant_net", "devise", "mode_paiement",
    "canal", "point_vente", "statut",
)


def maintenant_utc():
    return datetime.now(timezone.utc)


def iso_vers_date(valeur):
    """Les dates sources sont exprimees a l'heure de Ouagadougou (UTC+0)."""
    if not valeur:
        return None
    return datetime.fromisoformat(valeur).replace(tzinfo=timezone.utc)


def assurer_index(db):
    """Creation idempotente des index (create_index ne fait rien s'il existe deja)."""
    db[COLL_CLIENTS].create_index([("code_client", ASCENDING)], unique=True, name="uk_code_client")
    db[COLL_VENTES].create_index([("reference", ASCENDING)], unique=True, name="uk_reference")
    db[COLL_VENTES].create_index([("date_vente", DESCENDING)], name="ix_date_vente")
    db[COLL_VENTES].create_index([("code_client", ASCENDING), ("date_vente", DESCENDING)], name="ix_client_date")
    db[COLL_REJETS].create_index(
        [("run_id", ASCENDING), ("entite", ASCENDING), ("fichier", ASCENDING), ("ligne", ASCENDING)],
        unique=True, name="uk_rejet_run_ligne",
    )
    db[COLL_EXECUTIONS].create_index([("run_id", ASCENDING)], unique=True, name="uk_run_id")
    db[COLL_EXECUTIONS].create_index([("debut", DESCENDING)], name="ix_debut")


def _metadonnees_etl(doc, run_id, horodatage):
    origine = doc.get("origine") or {}
    return {
        "hash": doc["hash"],
        "run_id": run_id,
        "fichier": origine.get("fichier"),
        "ligne": origine.get("ligne"),
        "charge_le": horodatage,
    }


def charger_clients(db, clients, run_id):
    horodatage = maintenant_utc()
    codes = [c["code_client"] for c in clients]
    existants = {
        d["code_client"]: (d.get("etl") or {}).get("hash")
        for d in db[COLL_CLIENTS].find({"code_client": {"$in": codes}}, {"code_client": 1, "etl.hash": 1})
    }

    operations = []
    bilan = {"inseres": 0, "mis_a_jour": 0, "inchanges": 0}
    for client in clients:
        code = client["code_client"]
        champs = {k: client[k] for k in CHAMPS_CLIENT}
        champs["date_inscription"] = iso_vers_date(client["date_inscription"])
        champs["etl"] = _metadonnees_etl(client, run_id, horodatage)
        champs["modifie_le"] = horodatage

        if code not in existants:
            bilan["inseres"] += 1
            operations.append(UpdateOne(
                {"code_client": code},
                {"$set": champs, "$setOnInsert": {"code_client": code, "cree_le": horodatage}},
                upsert=True,
            ))
        elif existants[code] != client["hash"]:
            bilan["mis_a_jour"] += 1
            operations.append(UpdateOne({"code_client": code}, {"$set": champs}))
        else:
            bilan["inchanges"] += 1

    if operations:
        db[COLL_CLIENTS].bulk_write(operations, ordered=False)
    return bilan


def charger_ventes(db, ventes, run_id):
    """
    Retourne le bilan du chargement et la liste des conflits.

    Regles particulieres :
      - une vente supprimee via l'API (supprime = true) n'est jamais recreee
        ni modifiee par l'ETL ;
      - une vente creee via l'API (source = "API") n'est pas ecrasee par un
        export de caisse portant la meme reference : la ligne est signalee
        en conflit et journalisee dans les rejets.
    """
    horodatage = maintenant_utc()
    references = [v["reference"] for v in ventes]
    existants = {
        d["reference"]: d
        for d in db[COLL_VENTES].find(
            {"reference": {"$in": references}},
            {"reference": 1, "etl.hash": 1, "source": 1, "supprime": 1},
        )
    }

    operations, conflits = [], []
    bilan = {"inserees": 0, "mises_a_jour": 0, "inchangees": 0, "ignorees_supprimees": 0, "conflits": 0}
    for vente in ventes:
        reference = vente["reference"]
        champs = {k: vente[k] for k in CHAMPS_VENTE}
        champs["date_vente"] = iso_vers_date(vente["date_vente"])
        etl = _metadonnees_etl(vente, run_id, horodatage)
        etl["date_maj_source"] = iso_vers_date(vente.get("date_maj"))
        champs["etl"] = etl
        champs["modifie_le"] = horodatage

        existant = existants.get(reference)
        if existant is None:
            bilan["inserees"] += 1
            operations.append(UpdateOne(
                {"reference": reference},
                {
                    "$set": champs,
                    "$setOnInsert": {
                        "reference": reference, "source": "ETL", "supprime": False,
                        "version": 1, "cree_le": horodatage,
                    },
                },
                upsert=True,
            ))
        elif existant.get("supprime"):
            bilan["ignorees_supprimees"] += 1
        elif existant.get("source") == "API":
            bilan["conflits"] += 1
            conflits.append(vente)
        elif (existant.get("etl") or {}).get("hash") != vente["hash"]:
            bilan["mises_a_jour"] += 1
            operations.append(UpdateOne(
                {"reference": reference, "supprime": {"$ne": True}},
                {"$set": champs, "$inc": {"version": 1}},
            ))
        else:
            bilan["inchangees"] += 1

    if operations:
        db[COLL_VENTES].bulk_write(operations, ordered=False)
    return bilan, conflits


def enregistrer_rejets(db, run_id, entite, rejets, doublons=(), conflits=()):
    """
    Historise les lignes ecartees. La cle (run_id, entite, fichier, ligne)
    rend l'operation rejouable sans duplication.
    """
    horodatage = maintenant_utc()
    operations = []

    def ajouter(categorie, fichier, ligne, cle_metier, motifs, donnees):
        operations.append(UpdateOne(
            {"run_id": run_id, "entite": entite, "fichier": fichier, "ligne": ligne},
            {"$set": {
                "categorie": categorie,
                "cle_metier": cle_metier or None,
                "motifs": motifs,
                "donnees": donnees,
                "horodatage": horodatage,
            }},
            upsert=True,
        ))

    cle = "reference" if entite == "vente" else "code_client"
    for rejet in rejets:
        ligne = rejet["ligne"]
        donnees = {k: v for k, v in ligne.items() if not k.startswith("_")}
        ajouter("INVALIDE", ligne.get("_fichier"), ligne.get("_ligne"), ligne.get(cle), rejet["motifs"], donnees)
    for doc, code in doublons:
        origine = doc.get("origine") or {}
        ajouter("DOUBLON", origine.get("fichier"), origine.get("ligne"), doc.get(cle),
                [{"code": code, "champ": cle, "message": "une autre version de la ligne a ete retenue"}], None)
    for doc in conflits:
        origine = doc.get("origine") or {}
        ajouter("CONFLIT", origine.get("fichier"), origine.get("ligne"), doc.get(cle),
                [{"code": "CONFLIT_SOURCE_API", "champ": cle,
                  "message": "reference deja utilisee par une vente saisie via l'API"}], None)

    if operations:
        db[COLL_REJETS].bulk_write(operations, ordered=False)
    return len(operations)


def controler_chargement(db, references_attendues):
    """
    Controles de coherence executes apres le chargement.
    Retourne une liste de resultats {controle, conforme, detail}.
    """
    resultats = []
    ventes = db[COLL_VENTES]

    presentes = ventes.count_documents({"reference": {"$in": references_attendues}})
    resultats.append({
        "controle": "presence_des_ventes_valides",
        "conforme": presentes == len(references_attendues),
        "detail": f"{presentes}/{len(references_attendues)} references presentes",
    })

    doublons = list(ventes.aggregate([
        {"$group": {"_id": "$reference", "n": {"$sum": 1}}},
        {"$match": {"n": {"$gt": 1}}},
        {"$count": "total"},
    ]))
    nb_doublons = doublons[0]["total"] if doublons else 0
    resultats.append({
        "controle": "unicite_des_references",
        "conforme": nb_doublons == 0,
        "detail": f"{nb_doublons} reference(s) en double",
    })

    incoherents = ventes.count_documents({
        "supprime": {"$ne": True},
        "$or": [
            {"montant_net": {"$lt": 0}},
            {"$expr": {"$ne": ["$montant_net", {"$subtract": ["$montant_brut", "$montant_remise"]}]}},
            {"$expr": {"$ne": ["$montant_brut", {"$multiply": ["$quantite", "$prix_unitaire"]}]}},
        ],
    })
    resultats.append({
        "controle": "coherence_des_montants",
        "conforme": incoherents == 0,
        "detail": f"{incoherents} vente(s) aux montants incoherents",
    })

    orphelines = list(ventes.aggregate([
        {"$match": {"supprime": {"$ne": True}}},
        {"$lookup": {"from": COLL_CLIENTS, "localField": "code_client", "foreignField": "code_client", "as": "c"}},
        {"$match": {"c": {"$size": 0}}},
        {"$count": "total"},
    ]))
    nb_orphelines = orphelines[0]["total"] if orphelines else 0
    resultats.append({
        "controle": "integrite_referentielle_clients",
        "conforme": nb_orphelines == 0,
        "detail": f"{nb_orphelines} vente(s) sans client associe",
    })
    return resultats


def enregistrer_execution(db, execution):
    db[COLL_EXECUTIONS].update_one({"run_id": execution["run_id"]}, {"$set": execution}, upsert=True)

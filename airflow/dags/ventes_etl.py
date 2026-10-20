"""
DAG ventes_etl : extraction des exports de caisse (CSV), controle,
normalisation et chargement idempotent des clients et des ventes dans MongoDB.

Enchainement :

    verifier_sources >> extraire >> traiter_clients >> transformer_ventes
        >> charger_ventes >> controler_chargement >> publier_rapport

publier_rapport s'execute dans tous les cas (trigger_rule all_done) afin que
chaque execution, reussie ou non, laisse une trace dans la collection
etl_executions. Il echoue lui-meme si une tache amont a echoue, pour que le
statut du DAG run reste fidele.
"""

import json
import logging
import re
import shutil
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path

import pendulum
from airflow.decorators import dag, task
from airflow.exceptions import AirflowFailException
from airflow.models.param import Param
from airflow.utils.state import TaskInstanceState
from airflow.utils.trigger_rule import TriggerRule

from etl_ventes import chargement, extraction, transformation

MONGO_CONN_ID = "mongo_ventes"
REPERTOIRE_SOURCE = "/opt/airflow/data/source"
REPERTOIRE_STAGING = Path("/opt/airflow/staging")

log = logging.getLogger("airflow.task")


@contextmanager
def base_mongo():
    """Ouvre une connexion via la connexion Airflow mongo_ventes et la ferme en sortie."""
    from airflow.providers.mongo.hooks.mongo import MongoHook

    with MongoHook(mongo_conn_id=MONGO_CONN_ID) as hook:
        yield hook.get_conn()[hook.connection.schema or "ventes_db"]


def repertoire_execution(run_id):
    """Repertoire de travail propre a un DAG run (caracteres non surs remplaces)."""
    return REPERTOIRE_STAGING / re.sub(r"[^A-Za-z0-9_.-]", "_", run_id)


def ecrire_json(chemin, contenu):
    chemin.parent.mkdir(parents=True, exist_ok=True)
    with open(chemin, "w", encoding="utf-8") as f:
        json.dump(contenu, f, ensure_ascii=False, default=str)


@contextmanager
def echec_definitif_si_source_invalide():
    """Un fichier source invalide ne se corrige pas en relancant la tache : echec sans nouvelle tentative."""
    try:
        yield
    except extraction.FichierSourceInvalide as err:
        raise AirflowFailException(str(err)) from err


def lire_json(chemin):
    with open(chemin, encoding="utf-8") as f:
        return json.load(f)


@dag(
    dag_id="ventes_etl",
    description="Chargement idempotent des ventes et clients dans MongoDB",
    schedule="0 2 * * *",
    start_date=pendulum.datetime(2026, 10, 1, tz="Africa/Ouagadougou"),
    catchup=False,
    max_active_runs=1,
    default_args={
        "owner": "groupe4-sie",
        "retries": 2,
        "retry_delay": timedelta(seconds=30),
    },
    params={
        "repertoire_source": Param(REPERTOIRE_SOURCE, type="string",
                                   description="Repertoire contenant clients.csv et ventes_*.csv"),
    },
    tags=["ventes", "mongodb", "etl"],
    doc_md=__doc__,
)
def ventes_etl():

    @task
    def verifier_sources(params=None):
        with echec_definitif_si_source_invalide():
            clients, ventes = extraction.lister_sources(params["repertoire_source"])
        log.info("Sources detectees : %s et %d export(s) de ventes", clients.name, len(ventes))
        return {"clients": str(clients), "ventes": [str(v) for v in ventes]}

    @task
    def extraire(sources, run_id=None):
        dossier = repertoire_execution(run_id)
        with echec_definitif_si_source_invalide():
            lignes_clients = extraction.lire_csv(sources["clients"], extraction.COLONNES_CLIENTS)
        lignes_ventes, fichiers = [], []
        for chemin in sources["ventes"]:
            with echec_definitif_si_source_invalide():
                lignes = extraction.lire_csv(chemin, extraction.COLONNES_VENTES)
            lignes_ventes.extend(lignes)
            fichiers.append({
                "nom": Path(chemin).name,
                "lignes": len(lignes),
                "sha256": extraction.empreinte_fichier(chemin),
            })
            log.info("%s : %d ligne(s) lue(s)", Path(chemin).name, len(lignes))

        ecrire_json(dossier / "clients_bruts.json", lignes_clients)
        ecrire_json(dossier / "ventes_brutes.json", lignes_ventes)
        return {
            "dossier": str(dossier),
            "fichiers": fichiers,
            "lignes_clients": len(lignes_clients),
            "lignes_ventes": len(lignes_ventes),
        }

    @task
    def traiter_clients(extrait, run_id=None):
        lignes = lire_json(Path(extrait["dossier"]) / "clients_bruts.json")
        valides, rejets, doublons = transformation.transformer_clients(lignes)
        with base_mongo() as db:
            chargement.assurer_index(db)
            bilan = chargement.charger_clients(db, valides, run_id)
            chargement.enregistrer_rejets(db, run_id, "client", rejets, doublons)
        bilan.update({
            "lus": len(lignes), "valides": len(valides),
            "rejetes": len(rejets), "doublons": len(doublons),
        })
        log.info("Clients : %s", json.dumps(bilan))
        return bilan

    @task
    def transformer_ventes(extrait, bilan_clients):
        dossier = Path(extrait["dossier"])
        lignes = lire_json(dossier / "ventes_brutes.json")
        with base_mongo() as db:
            clients_connus = set(db[chargement.COLL_CLIENTS].distinct("code_client"))
        log.info("%d client(s) dans le referentiel MongoDB", len(clients_connus))

        valides, rejets, doublons = transformation.transformer_ventes(lignes, clients_connus)
        ecrire_json(dossier / "ventes_valides.json", valides)
        ecrire_json(dossier / "ventes_rejetees.json", rejets)
        ecrire_json(dossier / "ventes_doublons.json", [[doc, code] for doc, code in doublons])

        motifs = {}
        for rejet in rejets:
            for m in rejet["motifs"]:
                motifs[m["code"]] = motifs.get(m["code"], 0) + 1
        resultat = {
            "lues": len(lignes),
            "valides": len(valides),
            "rejetees": len(rejets),
            "doublons_exacts": sum(1 for _, c in doublons if c == "DOUBLON_EXACT"),
            "versions_obsoletes": sum(1 for _, c in doublons if c == "VERSION_OBSOLETE"),
            "motifs_rejet": motifs,
        }
        log.info("Transformation des ventes : %s", json.dumps(resultat, ensure_ascii=False))
        return resultat

    @task
    def charger_ventes(extrait, transforme, run_id=None):
        dossier = Path(extrait["dossier"])
        valides = lire_json(dossier / "ventes_valides.json")
        rejets = lire_json(dossier / "ventes_rejetees.json")
        doublons = [(doc, code) for doc, code in lire_json(dossier / "ventes_doublons.json")]
        with base_mongo() as db:
            bilan, conflits = chargement.charger_ventes(db, valides, run_id)
            bilan["lignes_journalisees"] = chargement.enregistrer_rejets(
                db, run_id, "vente", rejets, doublons, conflits)
        log.info("Chargement des ventes : %s", json.dumps(bilan))
        return bilan

    @task
    def controler_chargement(extrait, bilan_ventes):
        references = [v["reference"] for v in lire_json(Path(extrait["dossier"]) / "ventes_valides.json")]
        with base_mongo() as db:
            resultats = chargement.controler_chargement(db, references)
        for r in resultats:
            log.info("Controle %-35s %s  (%s)", r["controle"], "OK" if r["conforme"] else "ECHEC", r["detail"])
        echecs = [r["controle"] for r in resultats if not r["conforme"]]
        if echecs:
            # Le resultat est pousse avant l'echec pour que le rapport puisse l'exploiter.
            from airflow.operators.python import get_current_context
            get_current_context()["ti"].xcom_push(key="return_value", value=resultats)
            raise AirflowFailException(f"Controle(s) non conforme(s) : {', '.join(echecs)}")
        return resultats

    @task(trigger_rule=TriggerRule.ALL_DONE)
    def publier_rapport(dag_run=None, ti=None, run_id=None):
        def xcom(task_id):
            return ti.xcom_pull(task_ids=task_id) or {}

        etats = {
            t.task_id: t.state
            for t in dag_run.get_task_instances()
            if t.task_id != ti.task_id
        }
        en_echec = sorted(k for k, v in etats.items() if v == TaskInstanceState.FAILED)
        non_executees = sorted(k for k, v in etats.items() if v == TaskInstanceState.UPSTREAM_FAILED)
        extrait = xcom("extraire")
        execution = {
            "run_id": run_id,
            "dag_id": dag_run.dag_id,
            "type_declenchement": dag_run.run_type,
            "date_logique": dag_run.logical_date,
            "debut": dag_run.start_date,
            "fin": pendulum.now("UTC"),
            "statut": "ECHEC" if en_echec else "SUCCES",
            "taches_en_echec": en_echec,
            "taches_non_executees": non_executees,
            "fichiers": extrait.get("fichiers", []),
            "clients": xcom("traiter_clients"),
            "ventes": {
                "lignes_lues": extrait.get("lignes_ventes"),
                **xcom("transformer_ventes"),
                **xcom("charger_ventes"),
            },
            "controles": ti.xcom_pull(task_ids="controler_chargement") or [],
        }
        execution["ventes"].pop("lues", None)
        execution["duree_secondes"] = round((execution["fin"] - execution["debut"]).total_seconds(), 1)

        with base_mongo() as db:
            chargement.enregistrer_execution(db, execution)

        log.info("BILAN_ETL %s", json.dumps(execution, default=str, ensure_ascii=False))
        if extrait.get("dossier"):
            shutil.rmtree(extrait["dossier"], ignore_errors=True)
        if en_echec:
            raise AirflowFailException(f"Execution en echec ({', '.join(en_echec)})")
        return {"statut": execution["statut"]}

    sources = verifier_sources()
    extrait = extraire(sources)
    bilan_clients = traiter_clients(extrait)
    transforme = transformer_ventes(extrait, bilan_clients)
    bilan_ventes = charger_ventes(extrait, transforme)
    controles = controler_chargement(extrait, bilan_ventes)
    controles >> publier_rapport()


ventes_etl()

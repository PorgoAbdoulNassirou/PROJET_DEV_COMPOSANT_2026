"""Tests d'integrite du DAG : import sans erreur et structure attendue."""

import os

import pytest

DAGS = os.path.join(os.path.dirname(__file__), "..", "dags")


@pytest.fixture(scope="module")
def dagbag():
    from airflow.models import DagBag

    return DagBag(dag_folder=os.environ.get("AIRFLOW__CORE__DAGS_FOLDER", DAGS), include_examples=False)


def test_aucune_erreur_import(dagbag):
    assert dagbag.import_errors == {}


def test_dag_present(dagbag):
    dag = dagbag.get_dag("ventes_etl")
    assert dag is not None
    assert dag.max_active_runs == 1
    assert dag.catchup is False


def test_enchainement_des_taches(dagbag):
    dag = dagbag.get_dag("ventes_etl")
    ordre = [
        "verifier_sources", "extraire", "traiter_clients", "transformer_ventes",
        "charger_ventes", "controler_chargement", "publier_rapport",
    ]
    assert set(ordre) == set(dag.task_ids)
    for amont, aval in zip(ordre, ordre[1:]):
        assert aval in dag.get_task(amont).downstream_task_ids, f"{amont} -> {aval} attendu"


def test_rapport_toujours_execute(dagbag):
    assert dagbag.get_dag("ventes_etl").get_task("publier_rapport").trigger_rule == "all_done"

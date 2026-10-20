#!/usr/bin/env bash
# Active le DAG ventes_etl, declenche une execution via l'API REST d'Airflow,
# attend sa fin puis affiche le bilan enregistre par le DAG.
#
# Usage : ./scripts/declencher-dag.sh
# Variables : AIRFLOW_URL, AIRFLOW_USER, AIRFLOW_PASSWORD, API_URL
set -euo pipefail

AIRFLOW_URL="${AIRFLOW_URL:-http://localhost:8080}"
AIRFLOW_USER="${AIRFLOW_USER:-admin}"
AIRFLOW_PASSWORD="${AIRFLOW_PASSWORD:-admin}"
API_URL="${API_URL:-http://localhost:3000}"
DAG="ventes_etl"
RUN_ID="manuel__$(date -u +%Y%m%dT%H%M%S)"

airflow() {
  curl -sf -u "${AIRFLOW_USER}:${AIRFLOW_PASSWORD}" -H 'Content-Type: application/json' "$@"
}

champ() {
  # extrait la valeur d'un champ texte d'une reponse JSON (sans dependance a jq)
  sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" | head -1
}

airflow -X PATCH "${AIRFLOW_URL}/api/v1/dags/${DAG}" -d '{"is_paused": false}' > /dev/null
airflow -X POST "${AIRFLOW_URL}/api/v1/dags/${DAG}/dagRuns" -d "{\"dag_run_id\": \"${RUN_ID}\"}" > /dev/null
echo "Execution ${RUN_ID} declenchee"

etat=""
for _ in $(seq 1 120); do
  etat=$(airflow "${AIRFLOW_URL}/api/v1/dags/${DAG}/dagRuns/${RUN_ID}" | tr -d '\n' | champ state)
  case "$etat" in
    success|failed) break ;;
  esac
  sleep 3
done
echo "Etat final : ${etat}"

echo "Bilan :"
curl -s "${API_URL}/api/v1/etl/executions/derniere"
echo
[ "$etat" = "success" ]

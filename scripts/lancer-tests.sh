#!/usr/bin/env bash
# Execute toutes les campagnes de test sur la plateforme demarree
# (docker compose up -d --build) et affiche un recapitulatif.
#
# Usage : ./scripts/lancer-tests.sh
set -uo pipefail

cd "$(dirname "$0")/.."
export MSYS_NO_PATHCONV=1   # Git Bash sous Windows : ne pas convertir les chemins des conteneurs

declare -a resultats=()

campagne() {
  local nom="$1"; shift
  echo
  echo "=================================================================="
  echo " ${nom}"
  echo "=================================================================="
  if "$@"; then
    resultats+=("OK      ${nom}")
  else
    resultats+=("ECHEC   ${nom}")
  fi
}

campagne "API - Jest/Supertest" docker compose --profile test run --rm --build api-tests
campagne "DAG - pytest" docker compose exec -T airflow-scheduler python -m pytest /opt/airflow/tests -v -p no:cacheprovider
campagne "Chaine complete - bout en bout" docker compose --profile test run --rm e2e
campagne "Routes API - Postman/Newman" docker compose --profile test run --rm newman

echo
echo "Recapitulatif"
printf '  %s\n' "${resultats[@]}"
! printf '%s\n' "${resultats[@]}" | grep -q '^ECHEC'

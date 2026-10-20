#!/bin/bash
# Initialisation de la pile ELK (executee par le conteneur elk-setup) :
#   1. modeles d'index Elasticsearch (types des champs, 0 replique) ;
#   2. objets Kibana : vues de donnees, recherches enregistrees, tableau de bord.
# Le script est rejouable : les objets existants sont ecrases.
set -euo pipefail

ES_URL="${ES_URL:-http://elasticsearch:9200}"
KIBANA_URL="${KIBANA_URL:-http://kibana:5601}"
DOSSIER="$(cd "$(dirname "$0")" && pwd)"

attendre() {
  local nom="$1" url="$2" motif="$3"
  echo "Attente de ${nom}..."
  for _ in $(seq 1 90); do
    if curl -s "$url" | grep -q "$motif"; then
      echo "${nom} disponible"
      return 0
    fi
    sleep 5
  done
  echo "${nom} indisponible apres 450 s" >&2
  exit 1
}

attendre "Elasticsearch" "${ES_URL}/_cluster/health" '"status":"\(green\|yellow\)"'
for modele in api-ventes airflow; do
  curl -sf -X PUT "${ES_URL}/_index_template/${modele}-logs" \
    -H 'Content-Type: application/json' --data-binary "@${DOSSIER}/template-${modele}.json" > /dev/null
  echo "Modele d'index ${modele}-logs installe"
done

attendre "Kibana" "${KIBANA_URL}/api/status" '"level":"available"'
reponse=$(curl -s -X POST "${KIBANA_URL}/api/saved_objects/_import?overwrite=true" \
  -H 'kbn-xsrf: true' --form "file=@/kibana/objets-kibana.ndjson")
echo "$reponse" | grep -q '"success":true' || { echo "Echec de l'import Kibana : $reponse" >&2; exit 1; }
echo "Objets Kibana importes : $(echo "$reponse" | grep -o '"successCount":[0-9]*')"

curl -sf -X POST "${KIBANA_URL}/api/kibana/settings" -H 'kbn-xsrf: true' -H 'Content-Type: application/json' \
  -d '{"changes":{"defaultIndex":"api-ventes-logs","dateFormat:tz":"Africa/Ouagadougou"}}' > /dev/null
echo "Initialisation ELK terminee"

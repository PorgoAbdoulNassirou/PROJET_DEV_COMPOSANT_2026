# Centralisation des journaux (ELK)

## 1. Chaîne de collecte

```
API Express ──(winston, JSON)──▶ volume api_logs ──────┐
                                                       ├──▶ Filebeat ──beats:5044──▶ Logstash ──▶ Elasticsearch ──▶ Kibana
Tâches Airflow ──(fichiers)──▶ volume airflow_logs ────┘
```

| Étape | Configuration | Rôle |
|---|---|---|
| API | [api/src/config/logger.js](../api/src/config/logger.js), [middlewares/journalisation.js](../api/src/middlewares/journalisation.js) | Une ligne JSON par requête, par exception et par opération métier |
| Filebeat | [elk/filebeat/filebeat.yml](../elk/filebeat/filebeat.yml) | Lecture des deux volumes ; décodage JSON pour l'API ; regroupement multi-lignes et extraction `dag_id`, `run_id`, `task_id` depuis le chemin pour Airflow |
| Logstash | [elk/logstash/pipeline/logstash.conf](../elk/logstash/pipeline/logstash.conf) | Horodatage, catégorie de statut (`2xx-3xx`, `4xx`, `5xx`), analyse du format Airflow, décodage du bilan `BILAN_ETL`, choix de l'index |
| Elasticsearch | [elk/setup/template-*.json](../elk/setup/) | Modèles d'index : types explicites (`http.statut` entier, `request_id` mot-clé...), 1 shard, 0 réplique |
| Kibana | [elk/kibana/objets-kibana.ndjson](../elk/kibana/objets-kibana.ndjson) | Vues de données, recherches enregistrées, tableau de bord |

Index produits (un par jour) : `api-ventes-logs-AAAA.MM.JJ` et `airflow-logs-AAAA.MM.JJ`.

## 2. Format des journaux de l'API

Journal d'accès (une ligne par requête, niveau `info`, `warn` pour 4xx, `error` pour 5xx) :

```json
{
  "@timestamp": "2026-10-19T12:46:02.457Z",
  "level": "warn",
  "message": "POST /api/v1/ventes 422 9.41ms",
  "service": "api-ventes",
  "environnement": "production",
  "type": "acces",
  "request_id": "e2e-4f1a2b3c-erreurs",
  "http": {
    "methode": "POST", "url": "/api/v1/ventes", "route": "/api/v1/ventes",
    "statut": 422, "duree_ms": 9.41, "taille_reponse": 214,
    "ip": "172.18.0.12", "user_agent": "node"
  },
  "erreur": { "code": "CLIENT_INCONNU", "message": "Le client 'CLI-9999' n'existe pas dans le referentiel" },
  "categorie_statut": "4xx"
}
```

Autres types d'événements :

| `type` | Contenu |
|---|---|
| `exception` | Erreur 5xx : `erreur.code`, `erreur.nom`, `erreur.message`, `erreur.pile` (pile d'appel, jamais renvoyée au client) |
| `metier` | Création, remplacement, modification, suppression d'une vente : `action`, `reference` |
| `database` | Connexion, perte et reprise de la connexion MongoDB |
| `demarrage`, `arret` | Cycle de vie du processus |

Les sondes `/sante` réussies ne sont pas journalisées pour ne pas noyer les journaux utiles.

## 3. Journaux Airflow

Chaque ligne au format `[horodatage] {fichier.py:ligne} NIVEAU - message` devient un document avec `level`, `source_code`, `contenu`, `airflow.dag_id`, `airflow.run_id`, `airflow.task_id`, `airflow.tentative`. Les traces Python multi-lignes restent groupées dans un seul document.

La tâche `publier_rapport` écrit une ligne `BILAN_ETL {...}` ; Logstash la décode dans le champ `bilan`, ce qui permet de suivre dans Kibana les compteurs de chaque exécution (`bilan.ventes.inserees`, `bilan.ventes.rejetees`, `bilan.statut`...).

## 4. Objets Kibana fournis

Importés automatiquement par le service `elk-setup` (réimport possible : `docker compose run --rm elk-setup`).

| Type | Nom | Requête KQL |
|---|---|---|
| Vue de données | API ventes - journaux | `api-ventes-logs-*` |
| Vue de données | Airflow - journaux des taches | `airflow-logs-*` |
| Recherche | API ventes - erreurs (4xx et 5xx) | `http.statut >= 400` |
| Recherche | API ventes - erreurs serveur et exceptions | `http.statut >= 500 or type : "exception"` |
| Recherche | API ventes - journal des acces | `type : "acces"` |
| Recherche | Airflow - journaux du DAG ventes_etl | `airflow.dag_id : "ventes_etl"` |
| Recherche | Airflow - bilans des executions ventes_etl | `bilan.run_id : *` |
| Recherche | Airflow - erreurs des taches | `airflow.dag_id : "ventes_etl" and level : ("error" or "critical")` |
| Tableau de bord | Supervision - API ventes et pipeline Airflow | regroupe les erreurs API, les bilans et les erreurs des tâches |

## 5. Vérifier les erreurs de l'API

### Procédure dans Kibana

1. Provoquer une erreur, par exemple un client inconnu :
   ```bash
   curl -i -X POST http://localhost:3000/api/v1/ventes -H "Content-Type: application/json" \
        -H "X-Request-Id: demo-erreur-0001" \
        -d '{"date_vente":"2026-10-15T10:00:00Z","code_client":"CLI-9999","produit":{"code":"PRD-001","libelle":"Riz"},"quantite":1,"prix_unitaire":17500,"mode_paiement":"ESPECES","canal":"BOUTIQUE"}'
   ```
   Réponse : `422`, `X-Request-Id: demo-erreur-0001`.
2. Dans Kibana, *Discover*, vue **API ventes - journaux**, saisir `request_id : "demo-erreur-0001"` : le document apparaît en quelques secondes avec `http.statut = 422` et `erreur.code = CLIENT_INCONNU`.
3. Pour une vue d'ensemble : recherche **API ventes - erreurs (4xx et 5xx)** ou tableau de bord **Supervision**.

Requêtes KQL utiles :

| Besoin | KQL |
|---|---|
| Toutes les erreurs | `http.statut >= 400` |
| Erreurs de validation | `erreur.code : "VALIDATION_ECHOUEE"` |
| Indisponibilités de la base | `erreur.code : "BASE_INDISPONIBLE"` |
| Requêtes lentes | `type : "acces" and http.duree_ms > 500` |
| Historique d'une vente | `reference : "VTE-20261001-0001" or http.url : *VTE-20261001-0001*` |

### Vérification en ligne de commande

```bash
# Nombre d'erreurs par code applicatif
curl -s -H "Content-Type: application/json" "http://localhost:9200/api-ventes-logs-*/_search" -d '{
  "size": 0,
  "query": { "range": { "http.statut": { "gte": 400 } } },
  "aggs": { "par_code": { "terms": { "field": "erreur.code" } } }
}'

# Dernier bilan du DAG
curl -s "http://localhost:9200/airflow-logs-*/_search?q=bilan.run_id:*&size=1&sort=@timestamp:desc"
```

### Scénario d'indisponibilité

```bash
docker compose stop mongo
curl -i -H "X-Request-Id: panne-mongo-0001" http://localhost:3000/api/v1/ventes   # 503 BASE_INDISPONIBLE
docker compose start mongo                                                        # reconnexion automatique
```

Dans Kibana : `request_id : "panne-mongo-0001"` renvoie le journal d'accès (`level: error`, `categorie_statut: 5xx`) et l'événement `exception`. Les événements `database` montrent la perte puis la reprise de la connexion.

Ce scénario a été exécuté pendant la recette : réponse 503 avec `Retry-After: 10`, indexation des deux événements, puis retour à 200 dès le redémarrage de MongoDB, sans redémarrer l'API.

## 6. Limites assumées

- Sécurité Elastic désactivée (pas de TLS ni d'authentification) : acceptable en local, à activer en production.
- Pas de politique de cycle de vie (ILM) : les index journaliers s'accumulent ; en production, une politique de suppression à 30 jours serait ajoutée.
- Filebeat lit des fichiers partagés plutôt que les sorties standard des conteneurs, pour rester indépendant de l'hôte Docker (Windows, macOS, Linux).

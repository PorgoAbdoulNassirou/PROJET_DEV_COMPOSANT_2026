# API REST de ventes avec Express.js, Airflow, MongoDB et ELK

Projet de fin de module **Développement à base de composants et services web**, IBAM, Master 1, 2026.
Groupe 4, filière SIE, thème n° 5.

Membres du groupe :

- KOBENDE Pégdwendé Evrard
- PORGO Abdoul Nassirou
- BAMBARA Mireille Epiphanie Joëlle Guerla
- OUEDRAOGO Armand Hendrix
- THIOMBIANO Yempabou Romaric Johan

## Sommaire

1. [Objectif](#objectif)
2. [Architecture](#architecture)
3. [Contenu du dépôt](#contenu-du-dépôt)
4. [Prérequis](#prérequis)
5. [Installation](#installation)
6. [Utilisation](#utilisation)
7. [Tests](#tests)
8. [Arrêt et réinitialisation](#arrêt-et-réinitialisation)
9. [Dépannage](#dépannage)
10. [Documentation détaillée](#documentation-détaillée)

## Objectif

Une chaîne de distribution fictive (boutiques à Ouagadougou, Bobo-Dioulasso, Koudougou, vente en ligne et centre d'appel) exporte chaque jour ses ventes de caisse au format CSV. Le projet met en place :

| Travail demandé (énoncé, exercice 5) | Réalisation |
|---|---|
| 1. Créer les données de ventes et les clients associés | Générateur déterministe [data/generer_donnees.py](data/generer_donnees.py) : 60 clients, 14 exports journaliers, 843 lignes de ventes avec anomalies volontaires |
| 2. Construire un DAG Airflow d'extraction, transformation et chargement | DAG `ventes_etl` ([airflow/dags/ventes_etl.py](airflow/dags/ventes_etl.py)) en 7 tâches, chargement dans MongoDB |
| 3. Garantir l'idempotence et définir le traitement des doublons | Upsert sur clé métier + empreinte SHA-256 du contenu, dédoublonnage intra et inter-fichiers, rejets historisés ([docs/ETL_IDEMPOTENCE.md](docs/ETL_IDEMPOTENCE.md)) |
| 4. Développer l'API CRUD des ventes | API Express.js 5 + Mongoose, validation Joi, pagination, filtres, contrat OpenAPI 3 ([api/](api/)) |
| 5. Centraliser les logs et vérifier les erreurs de l'API | Journaux JSON corrélés (`X-Request-Id`) → Filebeat → Logstash → Elasticsearch → Kibana, recherches et tableau de bord fournis ([docs/JOURNALISATION_ELK.md](docs/JOURNALISATION_ELK.md)) |
| 6. Tester les routes et les exécutions du DAG | Jest/Supertest (47 tests), pytest (43 tests), Postman/Newman (30 requêtes, 60 assertions), test de bout en bout (5 étapes) ([docs/TESTS.md](docs/TESTS.md)) |

## Architecture

```
                     ┌─────────────────────────── Airflow 2.10 (LocalExecutor) ───────────────────────────┐
 data/source/        │ verifier_sources → extraire → traiter_clients → transformer_ventes → charger_ventes │
 clients.csv  ──────▶│                                         → controler_chargement → publier_rapport   │
 ventes_*.csv        └───────────────┬────────────────────────────────────────────────────────┬───────────┘
                                     │ upserts idempotents (MongoHook)                         │ journaux des tâches
                                     ▼                                                         │
                          ┌──────────────────────┐                                             │
                          │      MongoDB 7       │  clients, ventes,                           │
                          │      ventes_db       │  ventes_rejets, etl_executions              │
                          └──────────▲───────────┘                                             │
                                     │ Mongoose                                                │
                          ┌──────────┴───────────┐                                             │
  Postman / Newman ─────▶ │  API Express.js 5    │  /api/v1/ventes (CRUD)                      │
  navigateur (Swagger)    │  port 3000           │  /api/v1/clients, /api/v1/etl/...           │
                          └──────────┬───────────┘                                             │
                                     │ journaux JSON (api.log)                                 │
                                     ▼                                                         ▼
                          ┌──────────────────────────────────────────────────────────────────────┐
                          │ Filebeat ──▶ Logstash ──▶ Elasticsearch 8.15 ──▶ Kibana (port 5601)  │
                          └──────────────────────────────────────────────────────────────────────┘
```

| Composant | Image / version | Rôle | Port hôte |
|---|---|---|---|
| MongoDB | `mongo:7.0` | Base de référence des ventes et clients | 27017 |
| API | `node:22-alpine`, Express 5, Mongoose 8 | API REST CRUD, contrat OpenAPI | 3000 |
| Airflow | `apache/airflow:2.10.5-python3.12` + fournisseur Mongo | Orchestration ETL (webserver, scheduler) | 8080 |
| PostgreSQL | `postgres:16-alpine` | Base de métadonnées d'Airflow uniquement | — |
| Elasticsearch | 8.15.3, nœud unique, sécurité désactivée | Stockage et recherche des journaux | 9200 |
| Logstash | 8.15.3 | Analyse et enrichissement des journaux | — |
| Kibana | 8.15.3 | Exploration des journaux, tableau de bord | 5601 |
| Filebeat | 8.15.3 | Collecte des fichiers de journaux | — |

Les choix d'architecture sont détaillés dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contenu du dépôt

```
.
├── docker-compose.yml          Orchestration de tous les services (+ profil "test")
├── .env.example                Variables surchargeables (ports, mots de passe)
├── data/
│   ├── generer_donnees.py      Générateur du jeu de données fictif
│   └── source/                 Exports CSV utilisés par le DAG (clients.csv, ventes_*.csv)
├── mongo/init/                 Script d'initialisation : utilisateurs, validateurs $jsonSchema, index
├── airflow/
│   ├── Dockerfile, requirements.txt
│   ├── dags/ventes_etl.py      Définition du DAG
│   ├── dags/etl_ventes/        Extraction, transformation (règles), chargement (MongoDB)
│   └── tests/                  pytest : règles, intégrité du DAG, idempotence
├── api/
│   ├── Dockerfile, package.json
│   ├── openapi/openapi.yaml    Contrat d'API
│   ├── src/                    Application Express (routes, contrôleurs, services, modèles)
│   └── tests/                  Jest + Supertest
├── elk/
│   ├── filebeat/filebeat.yml
│   ├── logstash/               Configuration et pipeline
│   ├── kibana/                 Objets Kibana (vues de données, recherches, tableau de bord)
│   └── setup/                  Modèles d'index et script d'initialisation
├── tests/
│   ├── postman/                Collection et environnements Postman
│   └── e2e/                    Test de bout en bout de la chaîne
├── scripts/                    Déclenchement du DAG, exécution de tous les tests
├── docs/                       Documentation technique
└── presentation/               Support de soutenance (Groupe4_SIE_Theme5_API_Ventes.pptx)
```

## Prérequis

| Outil | Version minimale | Remarque |
|---|---|---|
| Docker Engine ou Docker Desktop | 24 | Docker Desktop sous Windows et macOS (moteur WSL 2 sous Windows) |
| Docker Compose | v2.20 | Inclus dans Docker Desktop |
| Git | 2.30 | |
| Mémoire allouée à Docker | 6 Go (8 Go conseillés) | Elasticsearch, Logstash, Kibana et Airflow sont les plus gourmands |
| Espace disque libre | 15 Go | Images (≈ 7 Go) et volumes |

Ports à laisser libres sur la machine : 3000, 5601, 8080, 9200, 27017 (modifiables dans `.env`).

Sous Linux uniquement, Elasticsearch exige :

```bash
sudo sysctl -w vm.max_map_count=262144
```

Node.js 20+ et Python 3.12 ne sont nécessaires que pour lancer les tests ou le générateur en dehors des conteneurs.

## Installation

Toutes les étapes ci-dessous ont été vérifiées sur une installation vierge de la plateforme (volumes supprimés).

```bash
# 1. Récupérer le projet
git clone https://github.com/PorgoAbdoulNassirou/PROJET_DEV_COMPOSANT_2026.git
cd PROJET_DEV_COMPOSANT_2026

# 2. (Facultatif) personnaliser les ports et mots de passe
cp .env.example .env

# 3. Construire les images et démarrer la plateforme
docker compose up -d --build

# 4. Suivre le démarrage (2 à 4 minutes la première fois)
docker compose ps
```

Le démarrage est terminé lorsque `mongo`, `api`, `elasticsearch`, `kibana`, `airflow-webserver` et `airflow-scheduler` sont `healthy`, et que `airflow-init` et `elk-setup` sont `Exited (0)`.

Ce qui est fait automatiquement au premier démarrage :

- MongoDB exécute [mongo/init/01-init-ventes.js](mongo/init/01-init-ventes.js) : création de `ventes_db`, des utilisateurs `api_ventes` et `etl_airflow` (droits limités à la base), des collections avec validateurs `$jsonSchema` et des index uniques ;
- `airflow-init` migre la base de métadonnées et crée le compte administrateur ;
- `elk-setup` installe les modèles d'index Elasticsearch puis importe les objets Kibana.

| Interface | URL | Identifiants |
|---|---|---|
| API (documentation Swagger) | http://localhost:3000/docs | — |
| Contrat OpenAPI (JSON) | http://localhost:3000/openapi.json | — |
| Airflow | http://localhost:8080 | `admin` / `admin` |
| Kibana | http://localhost:5601 | — |
| Elasticsearch | http://localhost:9200 | — |
| MongoDB | `mongodb://localhost:27017` | `admin` / `admin_mdp` (administrateur) |

Les mots de passe par défaut sont destinés à un environnement de démonstration ; ils se changent dans `.env`.

## Utilisation

### 1. Charger les données avec le DAG

Le DAG est en pause à sa création. Deux possibilités :

- **Interface Airflow** : ouvrir http://localhost:8080, activer `ventes_etl`, puis *Trigger DAG*.
- **Script** (API REST d'Airflow) :

```bash
./scripts/declencher-dag.sh
```

Le DAG est aussi planifié tous les jours à 02:00 (heure de Ouagadougou). Le bilan de chaque exécution est consultable dans l'API :

```bash
curl http://localhost:3000/api/v1/etl/executions/derniere
```

Résultat attendu au premier chargement : 843 lignes lues, 711 ventes valides insérées, 38 lignes rejetées, 94 doublons écartés, 4 contrôles conformes. Une nouvelle exécution sur les mêmes fichiers donne 0 insertion, 0 mise à jour et 711 ventes inchangées.

### 2. Utiliser l'API

```bash
# Lister les ventes de mobile money d'un client sur une période
curl "http://localhost:3000/api/v1/ventes?code_client=CLI-0012&mode_paiement=MOBILE_MONEY&date_debut=2026-10-01T00:00:00Z&limite=5"

# Créer une vente (les montants sont calculés par le serveur)
curl -X POST http://localhost:3000/api/v1/ventes -H "Content-Type: application/json" -d '{
  "date_vente": "2026-10-15T10:30:00Z", "code_client": "CLI-0012",
  "produit": {"code": "PRD-002", "libelle": "Huile végétale 5 L", "categorie": "Alimentation"},
  "quantite": 3, "prix_unitaire": 6500, "remise_pct": 5,
  "mode_paiement": "MOBILE_MONEY", "canal": "BOUTIQUE", "point_vente": "OUAGA-CENTRE"}'

# Modifier partiellement, puis supprimer
curl -X PATCH http://localhost:3000/api/v1/ventes/<reference> -H "Content-Type: application/json" -d '{"statut":"ANNULEE"}'
curl -X DELETE http://localhost:3000/api/v1/ventes/<reference>

# Indicateurs
curl http://localhost:3000/api/v1/ventes/statistiques
```

La liste complète des routes, paramètres et codes d'erreur se trouve dans [docs/API.md](docs/API.md) et dans Swagger.

### 3. Vérifier les erreurs de l'API dans Kibana

1. Ouvrir http://localhost:5601, menu *Analytics > Dashboards*, tableau de bord **Supervision - API ventes et pipeline Airflow**.
2. Ou *Discover*, recherche enregistrée **API ventes - erreurs (4xx et 5xx)**.
3. Pour retrouver une requête précise, filtrer sur l'identifiant renvoyé dans l'en-tête `X-Request-Id` : `request_id : "<valeur>"`.

Depuis un terminal :

```bash
curl -s "http://localhost:9200/api-ventes-logs-*/_search?q=http.statut:>=400&size=5&sort=@timestamp:desc"
```

## Tests

```bash
./scripts/lancer-tests.sh
```

Le script enchaîne les quatre campagnes ci-dessous ; chacune peut aussi être lancée seule :

| Campagne | Commande | Résultat attendu |
|---|---|---|
| API, unitaires et intégration | `docker compose --profile test run --rm --build api-tests` | 47 tests réussis |
| DAG, règles et idempotence | `docker compose exec airflow-scheduler python -m pytest /opt/airflow/tests -v` | 43 tests réussis |
| Bout en bout (DAG → MongoDB → API → ELK) | `docker compose --profile test run --rm e2e` | 5 étapes réussies |
| Routes de l'API (Postman) | `docker compose --profile test run --rm newman` | 30 requêtes, 60 assertions, 0 échec |

La collection [tests/postman/ventes-api.postman_collection.json](tests/postman/ventes-api.postman_collection.json) s'importe aussi dans Postman avec l'environnement `local.postman_environment.json`. Le détail des scénarios et des résultats attendus est dans [docs/TESTS.md](docs/TESTS.md).

## Arrêt et réinitialisation

```bash
docker compose stop            # arrêt, données conservées
docker compose down            # suppression des conteneurs, données conservées
docker compose down -v         # suppression complète, y compris MongoDB, Elasticsearch et Airflow
```

Pour régénérer le jeu de données (résultat identique, le générateur étant déterministe) :

```bash
python data/generer_donnees.py
```

## Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| `elasticsearch` redémarre en boucle (Linux) | `vm.max_map_count` trop bas | `sudo sysctl -w vm.max_map_count=262144` |
| Conteneurs arrêtés avec le code 137 | Mémoire insuffisante | Allouer au moins 6 Go à Docker |
| `port is already allocated` | Port déjà utilisé | Modifier `API_PORT`, `AIRFLOW_PORT`, etc. dans `.env` |
| `elk-setup` : `bash\r: No such file` | Fins de ligne converties en CRLF par Git sous Windows | Le fichier `.gitattributes` force LF ; recloner ou `git config core.autocrlf input` |
| L'API répond `503 BASE_INDISPONIBLE` | MongoDB arrêté ou en cours de démarrage | L'API se reconnecte seule ; vérifier `docker compose ps mongo` |
| Aucun journal dans Kibana | Période d'affichage | Choisir *Last 24 hours* ; vérifier `docker compose logs filebeat logstash` |
| Échec de construction ou fichiers vides dans une image | Disque saturé pendant un téléchargement | Libérer de l'espace, `docker builder prune`, supprimer l'image et la retélécharger |

## Documentation détaillée

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) : composants, flux, modèle de données, choix techniques
- [docs/ETL_IDEMPOTENCE.md](docs/ETL_IDEMPOTENCE.md) : DAG, règles de contrôle, doublons, idempotence, reprise
- [docs/API.md](docs/API.md) : routes, paramètres, format des erreurs
- [docs/JOURNALISATION_ELK.md](docs/JOURNALISATION_ELK.md) : format des journaux, pipeline, vérification des erreurs
- [docs/TESTS.md](docs/TESTS.md) : stratégie de test, scénarios et résultats attendus
- [api/openapi/openapi.yaml](api/openapi/openapi.yaml) : contrat OpenAPI 3.0
- [presentation/Groupe4_SIE_Theme5_API_Ventes.pptx](presentation/Groupe4_SIE_Theme5_API_Ventes.pptx) : présentation PowerPoint (15 diapositives, notes de l'orateur incluses)

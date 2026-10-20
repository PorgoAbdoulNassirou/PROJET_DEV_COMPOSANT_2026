# Architecture

## 1. Vue d'ensemble

La plateforme est composée de quatre blocs indépendants qui communiquent uniquement par des interfaces réseau ou des fichiers :

| Bloc | Composants | Responsabilité |
|---|---|---|
| Source | Exports CSV de caisse (`data/source`) | Données brutes, non fiables |
| Intégration | Airflow (webserver, scheduler, PostgreSQL de métadonnées) | Contrôle, normalisation, dédoublonnage, chargement idempotent |
| Service | MongoDB, API Express.js | Base de référence et exposition REST |
| Observabilité | Filebeat, Logstash, Elasticsearch, Kibana | Centralisation et analyse des journaux de l'API et des tâches Airflow |

Tous les services sont décrits dans `docker-compose.yml` et communiquent sur le réseau Docker du projet (`ventes-plateforme_default`) par leur nom de service (`mongo`, `api`, `elasticsearch`, ...).

## 2. Flux de données

```
 caisses ──CSV──▶ data/source ──lecture──▶ DAG ventes_etl ──upsert──▶ MongoDB ◀──CRUD── API ◀── clients HTTP
                                              │                                       │
                                              └── journaux de tâches ──┐   ┌── api.log (JSON)
                                                                       ▼   ▼
                                                              Filebeat ──▶ Logstash ──▶ Elasticsearch ──▶ Kibana
```

1. Les exports `ventes_AAAA-MM-JJ.csv` et le référentiel `clients.csv` sont déposés dans `data/source` (monté en lecture dans Airflow).
2. Le DAG `ventes_etl` lit tous les fichiers, contrôle et normalise chaque ligne, écarte les doublons, puis écrit dans MongoDB par upsert sur la clé métier.
3. L'API lit et modifie les mêmes collections. Elle est la seule porte d'entrée pour les applications clientes.
4. Chaque requête HTTP produit une ligne de journal JSON ; chaque tâche Airflow produit un fichier de journal. Filebeat lit les deux, Logstash les structure, Elasticsearch les indexe, Kibana les présente.

## 3. Modèle de données (MongoDB `ventes_db`)

### `clients` (alimentée par le DAG, lecture seule pour l'API)

| Champ | Type | Règle |
|---|---|---|
| `code_client` | string | `CLI-0000`, index unique `uk_code_client` |
| `nom`, `prenom` | string | obligatoires ; nom en majuscules |
| `email` | string \| null | minuscules, format vérifié |
| `telephone` | string \| null | normalisé `+226XXXXXXXX` |
| `ville` | string \| null | |
| `type_client` | `PARTICULIER` \| `PROFESSIONNEL` | |
| `date_inscription` | date \| null | |
| `etl` | objet | `hash`, `run_id`, `fichier`, `ligne`, `charge_le` |

### `ventes`

| Champ | Type | Règle |
|---|---|---|
| `reference` | string | `VTE-AAAAMMJJ-XXXX`, index unique `uk_reference` |
| `date_vente` | date | non future |
| `code_client` | string | doit exister dans `clients` |
| `produit` | objet | `code` (`PRD-000`), `libelle`, `categorie` |
| `quantite` | entier | 1 à 1000 |
| `prix_unitaire` | entier | XOF, 1 à 10 000 000 |
| `remise_pct` | nombre | 0 à 50 |
| `montant_brut`, `montant_remise`, `montant_net` | nombre | calculés, jamais saisis |
| `devise` | `XOF` | |
| `mode_paiement` | `ESPECES` \| `MOBILE_MONEY` \| `CARTE_BANCAIRE` \| `VIREMENT` | |
| `canal` | `BOUTIQUE` \| `EN_LIGNE` \| `TELEPHONE` | |
| `point_vente` | string \| null | |
| `statut` | `VALIDEE` \| `ANNULEE` | |
| `source` | `ETL` \| `API` | origine de la vente |
| `supprime`, `supprime_le` | booléen, date | suppression logique |
| `version` | entier | incrémentée à chaque modification |
| `etl` | objet | traçabilité du dernier chargement (`hash`, `run_id`, `fichier`, `ligne`, `date_maj_source`) |
| `cree_le`, `modifie_le` | date | |

Index secondaires : `ix_date_vente`, `ix_client_date` (`code_client`, `date_vente`), `ix_statut_paiement`.

Les collections `clients` et `ventes` sont protégées par un validateur `$jsonSchema` (niveau `strict`) : même une écriture qui contournerait l'API ou le DAG ne peut pas insérer une valeur hors domaine.

### `ventes_rejets`

Une entrée par ligne écartée et par exécution : `run_id`, `entite` (`vente` ou `client`), `categorie` (`INVALIDE`, `DOUBLON`, `CONFLIT`), `fichier`, `ligne`, `cle_metier`, `motifs[]` (`code`, `champ`, `message`), `donnees` (ligne brute). Index unique (`run_id`, `entite`, `fichier`, `ligne`).

### `etl_executions`

Une entrée par DAG run : statut, durée, fichiers lus (avec empreinte SHA-256), compteurs clients et ventes, motifs de rejet, résultats des contrôles. Index unique sur `run_id`.

## 4. Choix techniques

| Sujet | Choix | Justification |
|---|---|---|
| Base de référence | MongoDB | Imposée par l'énoncé ; le document `vente` embarque le produit, ce qui évite une jointure pour chaque lecture |
| Validation en base | `$jsonSchema` + index uniques | Dernière ligne de défense indépendante du code applicatif |
| Moteur Airflow | `LocalExecutor` + PostgreSQL | Suffisant pour un DAG séquentiel, sans Redis ni Celery |
| Accès MongoDB depuis Airflow | Connexion Airflow `mongo_ventes` + `MongoHook` | Identifiants hors du code, gérés par Airflow |
| Échanges entre tâches | Fichiers JSON dans un volume de travail propre au run, XCom limité aux compteurs | Les XCom ne sont pas faits pour transporter des centaines de lignes |
| Idempotence | Upsert sur clé métier + empreinte du contenu | Voir [ETL_IDEMPOTENCE.md](ETL_IDEMPOTENCE.md) |
| Framework API | Express 5 | Gestion native des erreurs des gestionnaires asynchrones |
| Validation API | Joi, messages en français, `abortEarly: false` | Tous les champs invalides sont renvoyés en une seule réponse |
| Suppression | Logique (`supprime: true`) | La vente n'est jamais recréée par un rechargement ; l'historique est conservé |
| Montants | Calculés côté serveur et côté ETL avec la même règle | Un client ne peut pas imposer un montant incohérent |
| Journaux | JSON, une ligne par requête, `X-Request-Id` | Exploitables sans analyse par expression régulière ; corrélation client / serveur |
| Collecte | Filebeat sur fichiers partagés par volume | Ne nécessite pas d'accès au socket Docker, fonctionne à l'identique sous Windows, macOS et Linux |
| Sécurité Elastic | Désactivée | Environnement de démonstration local ; à activer avec TLS et comptes en production |

## 5. Sécurité

- Deux comptes MongoDB applicatifs à privilèges limités (`readWrite` sur `ventes_db` et sa base de test) : `api_ventes` pour l'API, `etl_airflow` pour le DAG. Le compte administrateur n'est utilisé par aucun service.
- L'API applique les en-têtes de `helmet`, limite le corps des requêtes à 100 Ko, refuse les champs inconnus, et ne renvoie jamais la pile d'appel au client (elle est uniquement journalisée).
- Les secrets ont des valeurs par défaut de démonstration, surchargeables par `.env` (non versionné).

## 6. Ressources et ports

| Service | Port interne | Port hôte | Mémoire indicative |
|---|---|---|---|
| mongo | 27017 | 27017 | 200 Mo |
| api | 3000 | 3000 | 80 Mo |
| airflow-webserver | 8080 | 8080 | 700 Mo |
| airflow-scheduler | 8974 (santé) | — | 400 Mo |
| airflow-postgres | 5432 | — | 50 Mo |
| elasticsearch | 9200 | 9200 | 1 Go (tas de 512 Mo) |
| logstash | 5044 | — | 600 Mo (tas de 256 Mo) |
| kibana | 5601 | 5601 | 700 Mo |
| filebeat | — | — | 50 Mo |

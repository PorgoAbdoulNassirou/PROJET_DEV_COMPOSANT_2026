# Tests et résultats attendus

## 1. Stratégie

| Niveau | Outil | Périmètre | Emplacement |
|---|---|---|---|
| Unitaire | pytest | Règles de contrôle, normalisation, calcul des montants, dédoublonnage | [airflow/tests/test_transformation.py](../airflow/tests/test_transformation.py) |
| Intégrité | pytest + DagBag | Import du DAG sans erreur, ordre des tâches, paramètres | [airflow/tests/test_dag.py](../airflow/tests/test_dag.py) |
| Intégration | pytest + MongoDB | Idempotence, mises à jour, suppressions, conflits, rejeu des rejets | [airflow/tests/test_idempotence.py](../airflow/tests/test_idempotence.py) |
| Intégration | Jest + Supertest + MongoDB | Toutes les routes de l'API, validation, erreurs, indisponibilité de la base | [api/tests/](../api/tests/) |
| Fonctionnel | Postman / Newman | Routes de l'API sur les données chargées par le DAG | [tests/postman/](../tests/postman/) |
| Bout en bout | `node:test` | Chaîne complète CSV → Airflow → MongoDB → API → Elasticsearch | [tests/e2e/chaine-complete.test.mjs](../tests/e2e/chaine-complete.test.mjs) |

Les tests d'intégration utilisent des bases dédiées (`ventes_db_test`) : ils ne modifient pas les données de démonstration.

## 2. Exécution

Prérequis : plateforme démarrée (`docker compose up -d --build`).

```bash
./scripts/lancer-tests.sh                                        # toutes les campagnes

docker compose --profile test run --rm --build api-tests          # API (Jest)
docker compose exec airflow-scheduler python -m pytest /opt/airflow/tests -v   # DAG (pytest)
docker compose --profile test run --rm e2e                        # bout en bout
docker compose --profile test run --rm newman                     # Postman
```

Sous Git Bash (Windows), préfixer la commande pytest par `MSYS_NO_PATHCONV=1` pour éviter la conversion du chemin `/opt/airflow/tests`.

Le rapport JUnit de Newman est écrit dans `tests/postman/resultats/newman-resultats.xml`.

## 3. Test de bout en bout (chaîne principale)

Le test pilote les composants uniquement par leurs API HTTP (Airflow REST, API ventes, Elasticsearch), depuis un conteneur du réseau Docker.

| Étape | Actions | Résultat attendu |
|---|---|---|
| 1. Chargement | Active le DAG, déclenche une exécution, attend la fin, lit le bilan via `/api/v1/etl/executions/derniere` | DAG run `success` ; 843 lignes lues, 711 valides, 38 rejetées dont 14 `CLIENT_INCONNU`, 94 doublons ; 60 clients valides, 2 rejetés ; 4 contrôles conformes |
| 2. Idempotence | Nouvelle exécution sur les mêmes fichiers | 0 insertion, 0 mise à jour, 711 inchangées ; nombre de ventes de l'API identique |
| 3. Correctif | Dépose un export modifiant 3 ventes existantes et en ajoutant 2, exécute le DAG ; retire l'export et exécute de nouveau | 3 mises à jour et 2 insertions, `version` incrémentée, montants recalculés ; puis 3 mises à jour de réalignement sur les exports d'origine |
| 4. CRUD et erreurs | Création, lecture, PATCH, suppression ; puis 4 requêtes en erreur avec un `X-Request-Id` connu | 201, 200, 200 (montant recalculé), 204, 404 ; erreurs 400, 422, 400 (JSON), 404 |
| 5. ELK | Recherche dans Elasticsearch par `request_id` et par `bilan.run_id` | Les 4 erreurs sont indexées avec `erreur.code` = `VALIDATION_ECHOUEE`, `CLIENT_INCONNU`, `JSON_INVALIDE`, `RESSOURCE_INTROUVABLE`, `categorie_statut = 4xx` ; le bilan du rejeu (`inserees = 0`) est indexé depuis la tâche `publier_rapport` |

Sortie obtenue lors de la recette :

```
✔ 1. le DAG charge les ventes valides et ecarte les lignes invalides (9747ms)
✔ 2. une seconde execution sur les memes fichiers ne modifie rien (idempotence) (9547ms)
✔ 3. un export correctif met a jour les ventes existantes et ajoute les nouvelles (22163ms)
✔ 4. CRUD des ventes et gestion des erreurs par l'API (42ms)
✔ 5. les erreurs de l'API et les bilans du DAG sont centralises dans Elasticsearch (10102ms)
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

Le test est rejouable : il nettoie le fichier correctif et supprime les ventes qu'il a créées.

## 4. Tests de l'API (Jest + Supertest) : 47 tests

| Groupe | Cas vérifiés |
|---|---|
| Création | montants calculés, référence générée et `Location`, normalisation de la casse, 409 sur référence existante, 422 client inconnu, 400 avec un détail par champ invalide, refus des montants imposés, refus d'une date future, 400 JSON mal formé |
| Liste | pagination et tri par défaut, filtres client, statut, mode de paiement (casse indifférente), catégorie, période, montant minimum, tri par montant, 400 sur paramètres incohérents |
| Statistiques | seules les ventes validées et non supprimées sont comptées |
| Détail / PUT / PATCH / DELETE | lecture, référence en minuscules, 404 et 400, remplacement complet avec valeurs par défaut, champs obligatoires du PUT, référence non modifiable, PATCH partiel avec recalcul, 422 sur client inconnu, suppression logique (404 ensuite, référence réservée) |
| Transversal | propagation de `X-Request-Id`, génération d'un identifiant, 404 sur route inconnue |
| Clients et ETL | liste, recherche, filtre ville, résumé des achats, ventes d'un client, 404 ; dernière exécution, filtre par statut, rejets par motif |
| Indisponibilité | 503 `BASE_INDISPONIBLE` avec `Retry-After`, sonde de santé `DEGRADE`, documentation toujours servie |
| Calcul | `calculerMontants` sur 3 cas dont un arrondi |

Résultat attendu : `Tests: 47 passed, 47 total`.

## 5. Tests du DAG (pytest) : 43 tests

| Fichier | Cas | Nombre |
|---|---|---|
| `test_transformation.py` | ligne valide normalisée ; formats de montant (`17 500`, `17500,00`, espace insécable) ; date JJ/MM/AAAA ; catégories ; 14 types de lignes invalides ; cumul des motifs ; empreinte indépendante de `date_maj` et de l'origine ; empreinte sensible au contenu ; doublon exact et version obsolète ; chevauchement entre fichiers ; déterminisme ; normalisation et rejets des clients | 33 |
| `test_dag.py` | import sans erreur, DAG présent (`max_active_runs = 1`, `catchup = False`), enchaînement des 7 tâches, `publier_rapport` en `all_done` | 4 |
| `test_idempotence.py` (MongoDB réel) | second passage sans écriture, modification source → `version = 2`, vente supprimée non recréée, vente API non écrasée, rejets rejouables, contrôles conformes | 6 |

Résultat attendu : `43 passed`.

## 6. Collection Postman : 30 requêtes, 60 assertions

À exécuter après au moins un chargement par le DAG.

| Dossier | Requêtes | Vérifications principales |
|---|---|---|
| 01 - Supervision | 2 | santé, contrat OpenAPI |
| 02 - Consultation des ventes | 6 | pagination (> 700 ventes), tri, filtres combinés, montant minimum, traçabilité `etl`, statistiques |
| 03 - Cycle de vie (CRUD) | 6 | 201 avec montants 19 500 / 975 / 18 525, PUT (version 2), PATCH (version 3), DELETE 204, puis 404 |
| 04 - Cas d'erreur | 10 | 400 (validation, montant imposé, JSON, référence, pagination), 404 (vente, route), 409, 422, corrélation `X-Request-Id` |
| 05 - Clients et suivi ETL | 6 | 60 clients, filtres, détail, ventes d'un client, dernière exécution réussie et cohérente, rejets `CLIENT_INCONNU` tracés |

Résultat attendu :

```
│              requests │   30 │    0 │
│            assertions │   60 │    0 │
```

## 7. Scénarios manuels complémentaires

| Scénario | Procédure | Résultat attendu |
|---|---|---|
| Panne de MongoDB | `docker compose stop mongo`, appeler `/api/v1/ventes`, `docker compose start mongo` | 503 `BASE_INDISPONIBLE` puis 200 sans redémarrer l'API ; événements visibles dans Kibana |
| Échec du DAG | `docker compose stop mongo`, déclencher le DAG | `traiter_clients` échoue après 2 nouvelles tentatives, DAG run `failed` ; après redémarrage de MongoDB, *Clear* sur la tâche : exécution complète sans doublon |
| Fichier mal formé | Déposer un `ventes_test.csv` sans colonne `quantite` | `extraire` échoue avec `colonnes manquantes ['quantite']` |
| Rejet consulté | `GET /api/v1/etl/rejets?motif=QUANTITE_INVALIDE` | lignes avec fichier, numéro de ligne, motif et données brutes |

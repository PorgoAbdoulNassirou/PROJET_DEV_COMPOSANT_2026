# API REST des ventes

Base : `http://localhost:3000`. Contrat complet : [api/openapi/openapi.yaml](../api/openapi/openapi.yaml), consultable dans Swagger UI à http://localhost:3000/docs.

## 1. Routes

| Méthode | Route | Description | Codes |
|---|---|---|---|
| GET | `/sante` | État de l'API et de la connexion MongoDB | 200, 503 |
| GET | `/openapi.json` | Contrat OpenAPI | 200 |
| GET | `/api/v1/ventes` | Liste paginée, filtrée et triée | 200, 400, 503 |
| POST | `/api/v1/ventes` | Création | 201, 400, 409, 422, 503 |
| GET | `/api/v1/ventes/statistiques` | Chiffre d'affaires et répartitions (ventes validées) | 200, 400 |
| GET | `/api/v1/ventes/{reference}` | Détail | 200, 400, 404 |
| PUT | `/api/v1/ventes/{reference}` | Remplacement complet | 200, 400, 404, 422 |
| PATCH | `/api/v1/ventes/{reference}` | Modification partielle | 200, 400, 404, 422 |
| DELETE | `/api/v1/ventes/{reference}` | Suppression logique | 204, 400, 404 |
| GET | `/api/v1/clients` | Liste paginée, recherche `q`, filtres `ville`, `type_client` | 200, 400 |
| GET | `/api/v1/clients/{code}` | Détail et résumé des achats | 200, 400, 404 |
| GET | `/api/v1/clients/{code}/ventes` | Ventes d'un client | 200, 400, 404 |
| GET | `/api/v1/etl/executions` | Historique des exécutions du DAG (filtre `statut`) | 200, 400 |
| GET | `/api/v1/etl/executions/derniere` | Bilan de la dernière exécution | 200, 404 |
| GET | `/api/v1/etl/rejets` | Lignes écartées (filtres `run_id`, `entite`, `categorie`, `motif`) | 200, 400 |

Les clients et le suivi ETL sont en lecture seule : ces données sont produites par le DAG.

## 2. Liste des ventes : paramètres

| Paramètre | Type | Défaut | Exemple |
|---|---|---|---|
| `page` | entier ≥ 1 | 1 | `page=3` |
| `limite` | entier 1 à 100 | 20 | `limite=50` |
| `code_client` | `CLI-0000` | | `code_client=CLI-0012` |
| `code_produit` | `PRD-000` | | `code_produit=PRD-011` |
| `categorie` | texte, insensible à la casse | | `categorie=téléphonie` |
| `statut` | `VALIDEE`, `ANNULEE` | | |
| `mode_paiement` | `ESPECES`, `MOBILE_MONEY`, `CARTE_BANCAIRE`, `VIREMENT` | | |
| `canal` | `BOUTIQUE`, `EN_LIGNE`, `TELEPHONE` | | |
| `point_vente` | texte | | `point_vente=OUAGA-2000` |
| `source` | `ETL`, `API` | | |
| `date_debut`, `date_fin` | ISO 8601 ; `date_fin ≥ date_debut` | | `date_debut=2026-10-01T00:00:00Z` |
| `montant_min`, `montant_max` | nombre ≥ 0, sur `montant_net` | | `montant_min=100000` |
| `tri` | `date_vente`, `montant_net`, `reference`, préfixe `-` pour décroissant | `-date_vente` | `tri=-montant_net` |

Les valeurs énumérées sont acceptées sans tenir compte de la casse. Réponse :

```json
{
  "donnees": [ { "reference": "VTE-20261014-0042", "...": "..." } ],
  "pagination": { "page": 1, "limite": 20, "total": 711, "pages": 36 }
}
```

## 3. Création et modification

Champs acceptés :

| Champ | Création / PUT | PATCH | Règle |
|---|---|---|---|
| `reference` | facultatif (création seulement) | interdit | `VTE-AAAAMMJJ-XXXX` ; générée si absente |
| `date_vente` | obligatoire | facultatif | ISO 8601, pas dans le futur |
| `code_client` | obligatoire | facultatif | client existant (sinon 422) |
| `produit` | obligatoire | facultatif | `{ code, libelle, categorie }` |
| `quantite` | obligatoire | facultatif | entier 1 à 1000 |
| `prix_unitaire` | obligatoire | facultatif | entier 1 à 10 000 000 |
| `remise_pct` | défaut 0 | facultatif | 0 à 50 |
| `mode_paiement` | obligatoire | facultatif | énumération |
| `canal` | obligatoire | facultatif | énumération |
| `point_vente` | défaut `null` | facultatif | 40 caractères max |
| `statut` | défaut `VALIDEE` | facultatif | énumération |

Tout autre champ (notamment `montant_net`, `source`, `version`) est refusé avec une erreur 400. Les montants sont recalculés à chaque écriture et `version` est incrémentée.

`PUT` remplace la vente : les champs facultatifs omis reprennent leur valeur par défaut. `PATCH` ne modifie que les champs transmis.

`DELETE` marque la vente `supprime: true`. Elle n'apparaît plus dans l'API, sa référence reste réservée (une création avec la même référence renvoie 409) et le DAG ne la recrée pas.

## 4. Format des erreurs

Toutes les erreurs ont la même structure :

```json
{
  "erreur": {
    "code": "VALIDATION_ECHOUEE",
    "message": "Les donnees envoyees sont invalides",
    "details": [
      { "champ": "quantite", "message": "quantite doit etre superieur ou egal a 1" },
      { "champ": "mode_paiement", "message": "mode_paiement doit valoir : ESPECES, MOBILE_MONEY, CARTE_BANCAIRE, VIREMENT" }
    ],
    "request_id": "0b6f3c5e-7d0a-4a7a-9d39-6f2f6f0c9a11",
    "horodatage": "2026-10-19T10:00:00.000Z"
  }
}
```

| HTTP | Code applicatif | Cause |
|---|---|---|
| 400 | `VALIDATION_ECHOUEE` | Champ ou paramètre invalide, manquant ou non autorisé (`details` liste chaque problème) |
| 400 | `JSON_INVALIDE` | Corps de requête qui n'est pas du JSON valide |
| 404 | `RESSOURCE_INTROUVABLE` | Vente, client ou exécution inexistant(e) ou supprimé(e) |
| 404 | `ROUTE_INTROUVABLE` | Route inconnue |
| 409 | `REFERENCE_EXISTANTE` | Référence déjà utilisée (y compris par une vente supprimée) |
| 413 | `CORPS_TROP_VOLUMINEUX` | Corps supérieur à 100 Ko |
| 422 | `CLIENT_INCONNU` | `code_client` absent du référentiel |
| 503 | `BASE_INDISPONIBLE` | MongoDB injoignable ; en-tête `Retry-After: 10` |
| 500 | `ERREUR_INTERNE` | Erreur non prévue ; détail technique uniquement dans les journaux |

## 5. Corrélation

Chaque réponse contient l'en-tête `X-Request-Id`. Un client peut fournir le sien (8 à 64 caractères `A-Z a-z 0-9 . _ -`) ; il est alors repris tel quel dans la réponse, dans le corps des erreurs et dans les journaux. C'est la clé pour retrouver une erreur précise dans Kibana (voir [JOURNALISATION_ELK.md](JOURNALISATION_ELK.md)).

## 6. Organisation du code

```
api/src/
├── server.js               démarrage, reconnexion MongoDB, arrêt propre
├── app.js                  assemblage des middlewares et des routes
├── config/                 variables d'environnement, journalisation (winston), connexion MongoDB
├── routes/index.js         déclaration des routes et des validations
├── validators/             schémas Joi et messages en français
├── controllers/            traduction HTTP <-> service
├── services/               règles métier (calcul des montants, contrôle du client, suppression logique)
├── models/                 schémas Mongoose (ventes, clients, collections ETL)
├── middlewares/            corrélation, journal d'accès, validation, disponibilité de la base, erreurs
└── utils/erreurs.js        erreurs métier typées
```

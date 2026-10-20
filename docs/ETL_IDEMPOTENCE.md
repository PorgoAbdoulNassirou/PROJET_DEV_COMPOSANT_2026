# DAG `ventes_etl` : contrôles, doublons et idempotence

## 1. Données sources

Les fichiers sont produits par [data/generer_donnees.py](../data/generer_donnees.py) (graine fixe : deux exécutions donnent des fichiers identiques).

| Fichier | Contenu | Format |
|---|---|---|
| `clients.csv` | 63 lignes : 60 clients, 1 doublon exact, 2 lignes invalides | CSV `;`, UTF-8 |
| `ventes_2026-10-01.csv` … `ventes_2026-10-14.csv` | 843 lignes au total | CSV `;`, UTF-8 |

Colonnes des ventes : `reference`, `date_vente`, `code_client`, `code_produit`, `libelle_produit`, `categorie`, `quantite`, `prix_unitaire`, `remise_pct`, `mode_paiement`, `canal`, `point_vente`, `statut`, `date_maj`.

Anomalies injectées volontairement :

| Anomalie | Exemple | Traitement attendu |
|---|---|---|
| Formats de date hétérogènes | `02/10/2026 17:25` | normalisée |
| Montants formatés | `17 500`, `6500,00` | normalisés en entier |
| Libellés non normalisés | `Orange Money`, `especes`, `Magasin`, `Web` | ramenés aux valeurs de référence |
| Catégorie en majuscules | `ALIMENTATION` | `Alimentation` |
| Doublon exact (ticket envoyé deux fois) | même ligne deux fois | `DOUBLON_EXACT` |
| Chevauchement d'exports | ventes de la veille reprises le lendemain | `DOUBLON_EXACT` |
| Correction de vente | même référence, `date_maj` plus récente, quantité modifiée | la plus récente est retenue, l'autre est `VERSION_OBSOLETE` |
| Client inconnu | `CLI-9999` | rejet `CLIENT_INCONNU` |
| Quantité nulle ou non numérique | `0`, `deux` | rejet `QUANTITE_INVALIDE` |
| Date impossible | `2026-13-45` | rejet `DATE_INVALIDE` |
| Champ obligatoire vide | `code_produit` vide, référence vide | rejet `CHAMP_OBLIGATOIRE` |
| Remise hors bornes | `80` | rejet `REMISE_INVALIDE` |

## 2. Enchaînement des tâches

| Tâche | Rôle | Sortie |
|---|---|---|
| `verifier_sources` | Vérifie la présence de `clients.csv` et d'au moins un `ventes_*.csv` | liste des fichiers |
| `extraire` | Lit les CSV, contrôle les en-têtes, trace fichier et numéro de ligne, calcule l'empreinte SHA-256 de chaque fichier | JSON brut dans le répertoire de travail du run |
| `traiter_clients` | Normalise, dédoublonne et charge le référentiel clients ; historise les rejets | compteurs clients |
| `transformer_ventes` | Contrôle et normalise chaque vente (référentiel clients lu dans MongoDB), dédoublonne | ventes valides, rejets, doublons |
| `charger_ventes` | Upsert idempotent dans `ventes`, historisation des rejets, doublons et conflits | compteurs de chargement |
| `controler_chargement` | 4 contrôles de cohérence après chargement | résultats ; échec du DAG si un contrôle n'est pas conforme |
| `publier_rapport` | Écrit le bilan dans `etl_executions`, journalise `BILAN_ETL {...}`, nettoie le répertoire de travail | s'exécute toujours (`trigger_rule = all_done`) |

Paramètres du DAG : planification quotidienne à 02:00 (`Africa/Ouagadougou`), `catchup=False`, `max_active_runs=1` (deux exécutions ne peuvent pas écrire en même temps), 2 nouvelles tentatives par tâche à 30 s d'intervalle. Le paramètre `repertoire_source` permet de pointer un autre dossier au déclenchement.

## 3. Règles de contrôle des ventes

| Champ | Règle | Code de rejet |
|---|---|---|
| `reference` | obligatoire, `VTE-AAAAMMJJ-XXXX` | `CHAMP_OBLIGATOIRE`, `FORMAT_REFERENCE` |
| `date_vente` | date lisible, au plus J+1 par rapport au traitement | `DATE_INVALIDE`, `DATE_FUTURE` |
| `code_client` | obligatoire, présent dans `clients` | `CHAMP_OBLIGATOIRE`, `CLIENT_INCONNU` |
| `code_produit` | obligatoire, `PRD-000` | `CHAMP_OBLIGATOIRE`, `FORMAT_CODE_PRODUIT` |
| `libelle_produit` | obligatoire | `CHAMP_OBLIGATOIRE` |
| `quantite` | entier de 1 à 1000 | `QUANTITE_INVALIDE` |
| `prix_unitaire` | entier de 1 à 10 000 000 XOF | `PRIX_INVALIDE` |
| `remise_pct` | 0 à 50 (vide = 0) | `REMISE_INVALIDE` |
| `mode_paiement` | valeur reconnue | `MODE_PAIEMENT_INCONNU` |
| `canal` | valeur reconnue | `CANAL_INCONNU` |
| `statut` | `VALIDEE` ou `ANNULEE` (vide = `VALIDEE`) | `STATUT_INCONNU` |

Tous les motifs d'une ligne sont cumulés, ce qui permet de corriger une ligne en une seule fois. Les montants sont recalculés : `montant_brut = quantite × prix_unitaire`, `montant_remise = arrondi(montant_brut × remise_pct / 100)`, `montant_net = montant_brut − montant_remise`.

## 4. Traitement des doublons

Le dédoublonnage s'applique **après** le contrôle, sur les lignes valides, et sur **l'ensemble des fichiers** d'une exécution :

1. les lignes sont regroupées par `reference` ;
2. la version retenue est celle dont `date_maj` est la plus récente (à égalité : fichier le plus récent, puis ligne la plus basse) ;
3. chaque autre version est classée :
   - `DOUBLON_EXACT` si son contenu métier est identique à la version retenue ;
   - `VERSION_OBSOLETE` s'il diffère (elle a été remplacée par une correction).

Les versions écartées sont historisées dans `ventes_rejets` (catégorie `DOUBLON`) avec leur fichier et leur ligne : aucune ligne source ne disparaît sans trace.

Le même principe s'applique aux clients, avec `code_client` comme clé.

## 5. Idempotence

### Mécanisme

Chaque document chargé porte l'empreinte SHA-256 de son **contenu métier** (`etl.hash`). Les champs techniques (`date_maj`, fichier, ligne) sont exclus du calcul : un export qui reprend une vente sans la modifier produit la même empreinte.

Au chargement, pour chaque vente valide :

| Situation en base | Action | Compteur |
|---|---|---|
| Référence absente | insertion (`upsert`, `version = 1`) | `inserees` |
| Présente, même empreinte | aucune écriture | `inchangees` |
| Présente, empreinte différente | mise à jour, `version + 1` | `mises_a_jour` |
| Présente et supprimée via l'API | aucune écriture | `ignorees_supprimees` |
| Présente et créée via l'API (`source = API`) | aucune écriture, ligne tracée en `CONFLIT` | `conflits` |

Garanties :

- **rejouer une exécution** sur les mêmes fichiers ne produit aucune écriture dans `ventes` ni `clients` (vérifié par le test de bout en bout et par `test_second_passage_sans_ecriture`) ;
- **une nouvelle tentative de tâche** (retry après une coupure) ne crée pas de doublon : toutes les écritures sont des upserts filtrés sur la clé métier ;
- **l'index unique** `uk_reference` empêche, en dernier recours, deux documents de même référence ;
- les rejets sont indexés par (`run_id`, `entite`, `fichier`, `ligne`) : relancer `charger_ventes` dans le même run ne duplique pas l'historique ;
- `max_active_runs = 1` empêche deux exécutions concurrentes.

### Reprise après erreur

| Incident | Comportement |
|---|---|
| MongoDB indisponible pendant une tâche | La tâche échoue, Airflow la relance 2 fois à 30 s ; en cas d'échec définitif, `publier_rapport` enregistre l'exécution en `ECHEC` et le DAG run est en échec |
| Fichier source sans les colonnes attendues | `extraire` échoue immédiatement avec le nom des colonnes manquantes |
| Contrôle après chargement non conforme | `controler_chargement` échoue sans nouvelle tentative (`AirflowFailException`) ; les résultats sont conservés dans le bilan |
| Relance manuelle (*Clear* dans Airflow) | Sans risque grâce à l'idempotence ; seules les différences sont écrites |

## 6. Coexistence avec l'API

| Cas | Règle |
|---|---|
| Une vente chargée par l'ETL est modifiée via l'API | La modification est conservée tant que la ligne source ne change pas (même empreinte). Si la caisse renvoie une version corrigée, l'ETL l'applique : le système de caisse reste la source de vérité des ventes qu'il émet |
| Une vente chargée par l'ETL est supprimée via l'API | Suppression logique ; l'ETL ne la recrée jamais et ne la modifie plus |
| Une vente créée via l'API porte une référence ensuite présente dans un export | L'ETL n'écrase pas la vente ; la ligne est historisée en `CONFLIT_SOURCE_API` pour analyse |
| Les références générées par l'API | `VTE-AAAAMMJJ-XXXXXX` (6 caractères hexadécimaux) : elles ne peuvent pas entrer en collision avec celles des caisses (4 chiffres) |

## 7. Contrôles après chargement

| Contrôle | Condition de conformité |
|---|---|
| `presence_des_ventes_valides` | chaque référence valide du lot existe en base |
| `unicite_des_references` | aucune référence en double dans `ventes` |
| `coherence_des_montants` | `montant_brut = quantite × prix_unitaire` et `montant_net = montant_brut − montant_remise ≥ 0` |
| `integrite_referentielle_clients` | toute vente non supprimée référence un client existant |

## 8. Résultats de référence

Sur le jeu de données fourni :

| Indicateur | 1re exécution (base vide) | Exécution suivante |
|---|---|---|
| Lignes de ventes lues | 843 | 843 |
| Ventes valides (uniques) | 711 | 711 |
| Lignes rejetées | 38 | 38 |
| Doublons exacts + versions obsolètes | 94 | 94 |
| Ventes insérées | 711 | 0 |
| Ventes mises à jour | 0 | 0 |
| Ventes inchangées | 0 | 711 |
| Clients valides / rejetés / doublons | 60 / 2 / 1 | 60 / 2 / 1 |
| Contrôles conformes | 4 / 4 | 4 / 4 |

Répartition des motifs de rejet : `CLIENT_INCONNU` 14, `QUANTITE_INVALIDE` 14, `DATE_INVALIDE` 4, `CHAMP_OBLIGATOIRE` 4, `REMISE_INVALIDE` 2.

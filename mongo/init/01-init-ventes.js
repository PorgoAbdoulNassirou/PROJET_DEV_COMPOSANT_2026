// Initialisation de la base ventes_db (executee une seule fois, au premier
// demarrage du conteneur, par /docker-entrypoint-initdb.d).
//
// - utilisateurs applicatifs a privileges restreints (API et ETL) ;
// - collections avec validation de schema ($jsonSchema) ;
// - index, dont les index uniques garantissant l'unicite des cles metier.

const nomBase = process.env.MONGO_DB || 'ventes_db';
const base = db.getSiblingDB(nomBase);

// ---------------------------------------------------------------------------
// Utilisateurs
// ---------------------------------------------------------------------------
base.createUser({
  user: process.env.MONGO_API_USER || 'api_ventes',
  pwd: process.env.MONGO_API_PASSWORD || 'api_ventes_mdp',
  roles: [
    { role: 'readWrite', db: nomBase },
    { role: 'readWrite', db: `${nomBase}_test` },
  ],
});

base.createUser({
  user: process.env.MONGO_ETL_USER || 'etl_airflow',
  pwd: process.env.MONGO_ETL_PASSWORD || 'etl_airflow_mdp',
  roles: [
    { role: 'readWrite', db: nomBase },
    { role: 'readWrite', db: `${nomBase}_test` },
  ],
});

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------
const MODES_PAIEMENT = ['ESPECES', 'MOBILE_MONEY', 'CARTE_BANCAIRE', 'VIREMENT'];
const CANAUX = ['BOUTIQUE', 'EN_LIGNE', 'TELEPHONE'];
const STATUTS = ['VALIDEE', 'ANNULEE'];

base.createCollection('clients', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['code_client', 'nom', 'prenom'],
      properties: {
        code_client: { bsonType: 'string', pattern: '^CLI-[0-9]{4}$' },
        nom: { bsonType: 'string', minLength: 1 },
        prenom: { bsonType: 'string', minLength: 1 },
        email: { bsonType: ['string', 'null'] },
        telephone: { bsonType: ['string', 'null'], pattern: '^\\+226[0-9]{8}$' },
        ville: { bsonType: ['string', 'null'] },
        type_client: { enum: ['PARTICULIER', 'PROFESSIONNEL'] },
        date_inscription: { bsonType: ['date', 'null'] },
      },
    },
  },
  validationLevel: 'strict',
  validationAction: 'error',
});

base.createCollection('ventes', {
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        'reference', 'date_vente', 'code_client', 'produit', 'quantite',
        'prix_unitaire', 'montant_brut', 'montant_net', 'mode_paiement',
        'canal', 'statut', 'source',
      ],
      properties: {
        reference: { bsonType: 'string', pattern: '^VTE-[0-9]{8}-[A-Z0-9]{4,10}$' },
        date_vente: { bsonType: 'date' },
        code_client: { bsonType: 'string', pattern: '^CLI-[0-9]{4}$' },
        produit: {
          bsonType: 'object',
          required: ['code', 'libelle'],
          properties: {
            code: { bsonType: 'string', pattern: '^PRD-[0-9]{3}$' },
            libelle: { bsonType: 'string' },
            categorie: { bsonType: ['string', 'null'] },
          },
        },
        quantite: { bsonType: ['int', 'long'], minimum: 1, maximum: 1000 },
        prix_unitaire: { bsonType: ['int', 'long', 'double'], minimum: 0, exclusiveMinimum: true },
        remise_pct: { bsonType: ['int', 'long', 'double'], minimum: 0, maximum: 50 },
        montant_brut: { bsonType: ['int', 'long', 'double'], minimum: 0 },
        montant_remise: { bsonType: ['int', 'long', 'double'], minimum: 0 },
        montant_net: { bsonType: ['int', 'long', 'double'], minimum: 0 },
        devise: { enum: ['XOF'] },
        mode_paiement: { enum: MODES_PAIEMENT },
        canal: { enum: CANAUX },
        statut: { enum: STATUTS },
        source: { enum: ['ETL', 'API'] },
        supprime: { bsonType: 'bool' },
        version: { bsonType: ['int', 'long'], minimum: 1 },
      },
    },
  },
  validationLevel: 'strict',
  validationAction: 'error',
});

base.createCollection('ventes_rejets');
base.createCollection('etl_executions');

// ---------------------------------------------------------------------------
// Index (les memes sont recrees de facon idempotente par le DAG)
// ---------------------------------------------------------------------------
base.clients.createIndex({ code_client: 1 }, { unique: true, name: 'uk_code_client' });
base.clients.createIndex({ nom: 1, prenom: 1 }, { name: 'ix_nom_prenom' });

base.ventes.createIndex({ reference: 1 }, { unique: true, name: 'uk_reference' });
base.ventes.createIndex({ date_vente: -1 }, { name: 'ix_date_vente' });
base.ventes.createIndex({ code_client: 1, date_vente: -1 }, { name: 'ix_client_date' });
base.ventes.createIndex({ statut: 1, mode_paiement: 1 }, { name: 'ix_statut_paiement' });

base.ventes_rejets.createIndex(
  { run_id: 1, entite: 1, fichier: 1, ligne: 1 },
  { unique: true, name: 'uk_rejet_run_ligne' },
);
base.etl_executions.createIndex({ run_id: 1 }, { unique: true, name: 'uk_run_id' });
base.etl_executions.createIndex({ debut: -1 }, { name: 'ix_debut' });

print(`[init] base ${nomBase} initialisee : collections, validateurs, index et utilisateurs crees`);

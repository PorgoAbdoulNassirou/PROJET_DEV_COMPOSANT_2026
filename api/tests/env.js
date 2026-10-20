// Variables d'environnement des tests : base dediee et journaux silencieux.
process.env.NODE_ENV = 'test';
process.env.LOG_CONSOLE = 'false';
process.env.MONGO_URI_TEST = process.env.MONGO_URI_TEST
  || 'mongodb://api_ventes:api_ventes_mdp@localhost:27017/ventes_db_test?authSource=ventes_db';

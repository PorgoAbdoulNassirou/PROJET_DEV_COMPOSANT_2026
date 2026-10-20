'use strict';

const env = process.env;

const config = {
  env: env.NODE_ENV || 'development',
  port: Number(env.PORT || 3000),
  mongo: {
    uri: env.MONGO_URI || 'mongodb://api_ventes:api_ventes_mdp@localhost:27017/ventes_db?authSource=ventes_db',
    serverSelectionTimeoutMS: Number(env.MONGO_TIMEOUT_MS || 5000),
  },
  log: {
    niveau: env.LOG_LEVEL || 'info',
    fichier: env.LOG_FILE || null,
    console: env.LOG_CONSOLE !== 'false',
  },
  pagination: {
    limiteParDefaut: 20,
    limiteMax: 100,
  },
};

module.exports = config;

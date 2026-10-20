'use strict';

const mongoose = require('mongoose');
const config = require('./index');
const logger = require('./logger');

// Sans connexion active, les requetes echouent immediatement (503) au lieu
// d'etre mises en file d'attente par Mongoose.
mongoose.set('bufferCommands', false);
mongoose.set('strictQuery', true);

mongoose.connection.on('connected', () => logger.info('Connexion MongoDB etablie', { type: 'database' }));
mongoose.connection.on('disconnected', () => logger.warn('Connexion MongoDB perdue', { type: 'database' }));
mongoose.connection.on('error', (err) => logger.error('Erreur MongoDB', { type: 'database', error: { message: err.message } }));

async function connecter(uri = config.mongo.uri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: config.mongo.serverSelectionTimeoutMS });
  return mongoose.connection;
}

async function deconnecter() {
  await mongoose.disconnect();
}

function estConnecte() {
  return mongoose.connection.readyState === 1;
}

module.exports = { connecter, deconnecter, estConnecte };

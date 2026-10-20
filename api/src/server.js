'use strict';

const config = require('./config');
const logger = require('./config/logger');
const { connecter, deconnecter } = require('./config/database');
const creerApplication = require('./app');

const DELAI_RECONNEXION_MS = 5000;

// L'API demarre meme si MongoDB n'est pas encore pret : elle repond 503 sur les
// routes metier et retente la connexion jusqu'a ce que la base soit disponible.
async function connecterAvecReprise() {
  for (let tentative = 1; ; tentative += 1) {
    try {
      await connecter();
      return;
    } catch (err) {
      logger.warn(`MongoDB indisponible (tentative ${tentative}), nouvel essai dans ${DELAI_RECONNEXION_MS / 1000} s`, {
        type: 'database', erreur: { message: err.message },
      });
      await new Promise((r) => setTimeout(r, DELAI_RECONNEXION_MS));
    }
  }
}

const app = creerApplication();
const serveur = app.listen(config.port, () => {
  logger.info(`API ventes demarree sur le port ${config.port}`, { type: 'demarrage', environnement: config.env });
});
connecterAvecReprise();

function arreter(signal) {
  logger.info(`Signal ${signal} recu, arret de l'API`, { type: 'arret' });
  serveur.close(async () => {
    await deconnecter().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => arreter('SIGTERM'));
process.on('SIGINT', () => arreter('SIGINT'));
process.on('unhandledRejection', (raison) => {
  logger.error('Promesse rejetee non geree', { type: 'exception', erreur: { message: String(raison) } });
});

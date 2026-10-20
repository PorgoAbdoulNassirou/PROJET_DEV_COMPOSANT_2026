'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');

const routes = require('./routes');
const { estConnecte } = require('./config/database');
const { identifiantRequete, journalAcces } = require('./middlewares/journalisation');
const { routeIntrouvable, gestionnaireErreurs } = require('./middlewares/erreurs');
const { version } = require('../package.json');

const CHEMIN_OPENAPI = path.join(__dirname, '..', 'openapi', 'openapi.yaml');

function creerApplication() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(identifiantRequete);
  app.use(journalAcces);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ exposedHeaders: ['X-Request-Id', 'Location'] }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/', (req, res) => res.redirect('/docs'));

  app.get('/sante', (req, res) => {
    const base = estConnecte();
    res.status(base ? 200 : 503).json({
      statut: base ? 'OK' : 'DEGRADE',
      service: 'api-ventes',
      version,
      mongodb: base ? 'connecte' : 'deconnecte',
      uptime_s: Math.round(process.uptime()),
    });
  });

  const contrat = yaml.load(fs.readFileSync(CHEMIN_OPENAPI, 'utf8'));
  app.get('/openapi.json', (req, res) => res.json(contrat));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(contrat, { customSiteTitle: 'API Ventes - documentation' }));

  app.use('/api/v1', routes);

  app.use(routeIntrouvable);
  app.use(gestionnaireErreurs);
  return app;
}

module.exports = creerApplication;

'use strict';

const { Router } = require('express');
const valider = require('../middlewares/valider');
const exigerBase = require('../middlewares/exigerBase');
const ventes = require('../controllers/vente.controller');
const consultation = require('../controllers/consultation.controller');
const v = require('../validators/vente.validator');
const c = require('../validators/consultation.validator');

const routeur = Router();
routeur.use(exigerBase);

// Ventes (CRUD)
routeur.get('/ventes', valider(v.recherche, 'query'), ventes.lister);
routeur.get('/ventes/statistiques', valider(v.periode, 'query'), ventes.statistiques);
routeur.get('/ventes/:reference', valider(v.parametreReference, 'params'), ventes.obtenir);
routeur.post('/ventes', valider(v.creation), ventes.creer);
routeur.put('/ventes/:reference', valider(v.parametreReference, 'params'), valider(v.remplacement), ventes.remplacer);
routeur.patch('/ventes/:reference', valider(v.parametreReference, 'params'), valider(v.modification), ventes.modifier);
routeur.delete('/ventes/:reference', valider(v.parametreReference, 'params'), ventes.supprimer);

// Clients (lecture seule, alimentes par le DAG)
routeur.get('/clients', valider(c.rechercheClients, 'query'), consultation.listerClients);
routeur.get('/clients/:code', valider(c.parametreClient, 'params'), consultation.obtenirClient);
routeur.get('/clients/:code/ventes', valider(c.parametreClient, 'params'), valider(c.paginationSeule, 'query'),
  consultation.ventesDuClient);

// Suivi du pipeline Airflow
routeur.get('/etl/executions', valider(c.rechercheExecutions, 'query'), consultation.listerExecutions);
routeur.get('/etl/executions/derniere', consultation.derniereExecution);
routeur.get('/etl/rejets', valider(c.rechercheRejets, 'query'), consultation.listerRejets);

module.exports = routeur;

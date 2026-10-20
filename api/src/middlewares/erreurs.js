'use strict';

const mongoose = require('mongoose');
const logger = require('../config/logger');
const { ErreurApi, erreurs } = require('../utils/erreurs');

const ERREURS_CONNEXION = new Set([
  'MongoNetworkError', 'MongoServerSelectionError', 'MongoNotConnectedError',
  'MongoTopologyClosedError', 'MongoNetworkTimeoutError', 'MongoPoolClearedError',
]);

function routeIntrouvable(req, res, next) {
  next(new ErreurApi(404, 'ROUTE_INTROUVABLE', `Aucune route ${req.method} ${req.path}`));
}

/** Convertit toute erreur en ErreurApi (code HTTP + code applicatif). */
function normaliser(err) {
  if (err instanceof ErreurApi) return err;
  if (err.type === 'entity.parse.failed') {
    return new ErreurApi(400, 'JSON_INVALIDE', 'Le corps de la requete n\'est pas un JSON valide');
  }
  if (err.type === 'entity.too.large') {
    return new ErreurApi(413, 'CORPS_TROP_VOLUMINEUX', 'Le corps de la requete depasse la taille autorisee');
  }
  if (err.type === 'charset.unsupported' || err.type === 'encoding.unsupported') {
    return new ErreurApi(415, 'ENCODAGE_NON_SUPPORTE', 'Encodage de la requete non supporte');
  }
  if (err instanceof mongoose.Error.ValidationError) {
    return erreurs.validation(Object.values(err.errors).map((e) => ({ champ: e.path, message: e.message })));
  }
  if (err instanceof mongoose.Error.CastError) {
    return erreurs.validation([{ champ: err.path, message: `valeur '${err.value}' invalide` }]);
  }
  if (err.code === 11000) {
    return erreurs.conflit('Cette ressource existe deja');
  }
  if (err.code === 121) {
    return new ErreurApi(422, 'SCHEMA_BASE_NON_RESPECTE', 'Le document ne respecte pas le schema de la base');
  }
  if (ERREURS_CONNEXION.has(err.name) || /buffering timed out|not connected/i.test(err.message || '')) {
    return erreurs.baseIndisponible();
  }
  return null;
}

function gestionnaireErreurs(err, req, res, next) {
  const erreur = normaliser(err);

  if (!erreur || erreur.statut >= 500) {
    logger.error(err.message, {
      type: 'exception',
      request_id: req.id,
      http: { methode: req.method, url: req.originalUrl },
      erreur: {
        code: erreur ? erreur.code : 'ERREUR_INTERNE',
        nom: err.name,
        message: err.message,
        pile: err.stack,
      },
    });
  }

  const finale = erreur || new ErreurApi(500, 'ERREUR_INTERNE', 'Une erreur interne est survenue');
  res.locals.erreur = { code: finale.code, message: finale.message };
  if (finale.statut === 503) res.set('Retry-After', '10');

  res.status(finale.statut).json({
    erreur: {
      code: finale.code,
      message: finale.message,
      ...(finale.details ? { details: finale.details } : {}),
      request_id: req.id,
      horodatage: new Date().toISOString(),
    },
  });
}

module.exports = { routeIntrouvable, gestionnaireErreurs };

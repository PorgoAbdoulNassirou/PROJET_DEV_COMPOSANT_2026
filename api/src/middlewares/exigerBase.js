'use strict';

const { estConnecte } = require('../config/database');
const { erreurs } = require('../utils/erreurs');

/** Refuse immediatement (503) les requetes metier lorsque MongoDB est injoignable. */
module.exports = function exigerBase(req, res, next) {
  if (!estConnecte()) return next(erreurs.baseIndisponible());
  return next();
};

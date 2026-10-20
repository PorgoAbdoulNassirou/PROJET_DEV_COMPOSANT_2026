'use strict';

const { optionsValidation } = require('../validators/messages');
const { erreurs } = require('../utils/erreurs');

/**
 * Valide req[source] avec un schema Joi. Les valeurs converties et completees
 * (valeurs par defaut) sont placees dans req.valide[source] : depuis Express 5,
 * req.query est en lecture seule.
 */
function valider(schema, source = 'body') {
  return (req, res, next) => {
    const { value, error } = schema.validate(req[source] ?? {}, optionsValidation);
    if (error) {
      return next(erreurs.validation(error.details.map((d) => ({
        champ: d.path.join('.') || source,
        message: d.message,
      }))));
    }
    req.valide = { ...(req.valide || {}), [source]: value };
    return next();
  };
}

module.exports = valider;

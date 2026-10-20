'use strict';

// Messages de validation Joi en francais.
const messages = {
  'any.required': '{{#label}} est obligatoire',
  'any.only': '{{#label}} doit valoir : {{#valids}}',
  'any.unknown': '{{#label}} n\'est pas autorise',
  'object.unknown': '{{#label}} n\'est pas un champ autorise',
  'object.min': 'au moins un champ doit etre fourni',
  'object.base': '{{#label}} doit etre un objet',
  'string.base': '{{#label}} doit etre une chaine de caracteres',
  'string.empty': '{{#label}} ne peut pas etre vide',
  'string.max': '{{#label}} ne doit pas depasser {{#limit}} caracteres',
  'string.pattern.base': '{{#label}} a un format invalide',
  'number.base': '{{#label}} doit etre un nombre',
  'number.integer': '{{#label}} doit etre un entier',
  'number.min': '{{#label}} doit etre superieur ou egal a {{#limit}}',
  'number.max': '{{#label}} doit etre inferieur ou egal a {{#limit}}',
  'date.base': '{{#label}} doit etre une date valide',
  'date.format': '{{#label}} doit etre une date au format ISO 8601',
  'date.max': '{{#label}} ne peut pas etre dans le futur',
  'date.min': '{{#label}} doit etre posterieure ou egale a {{#limit}}',
};

const optionsValidation = {
  abortEarly: false,
  convert: true,
  errors: { wrap: { label: false } },
};

module.exports = { messages, optionsValidation };

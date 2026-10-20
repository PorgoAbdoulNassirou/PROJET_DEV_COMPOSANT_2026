'use strict';

const Joi = require('joi');
const { messages } = require('./messages');

const pagination = {
  page: Joi.number().integer().min(1).default(1),
  limite: Joi.number().integer().min(1).max(100).default(20),
};

const paginationSeule = Joi.object(pagination).messages(messages);

const rechercheClients = Joi.object({
  ...pagination,
  q: Joi.string().trim().min(2).max(60),
  ville: Joi.string().trim(),
  type_client: Joi.string().trim().uppercase().valid('PARTICULIER', 'PROFESSIONNEL'),
}).messages(messages);

const parametreClient = Joi.object({
  code: Joi.string().trim().uppercase().pattern(/^CLI-\d{4}$/).required(),
}).messages(messages);

const rechercheExecutions = Joi.object({
  ...pagination,
  statut: Joi.string().trim().uppercase().valid('SUCCES', 'ECHEC'),
}).messages(messages);

const rechercheRejets = Joi.object({
  ...pagination,
  run_id: Joi.string().trim(),
  entite: Joi.string().trim().lowercase().valid('vente', 'client'),
  categorie: Joi.string().trim().uppercase().valid('INVALIDE', 'DOUBLON', 'CONFLIT'),
  motif: Joi.string().trim().uppercase(),
}).messages(messages);

module.exports = { paginationSeule, rechercheClients, parametreClient, rechercheExecutions, rechercheRejets };

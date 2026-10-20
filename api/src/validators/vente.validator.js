'use strict';

const Joi = require('joi');
const { MODES_PAIEMENT, CANAUX, STATUTS } = require('../models/vente.model');
const { messages } = require('./messages');

const RE_REFERENCE = /^VTE-\d{8}-[A-Z0-9]{4,10}$/;
const RE_CLIENT = /^CLI-\d{4}$/;
const RE_PRODUIT = /^PRD-\d{3}$/;

const produit = Joi.object({
  code: Joi.string().trim().uppercase().pattern(RE_PRODUIT).required(),
  libelle: Joi.string().trim().min(1).max(150).required(),
  categorie: Joi.string().trim().max(60).allow(null),
});

// Les montants (brut, remise, net) ne sont jamais acceptes en entree :
// ils sont recalcules par le serveur a partir de la quantite, du prix et de la remise.
const champs = {
  date_vente: Joi.date().iso().max('now'),
  code_client: Joi.string().trim().uppercase().pattern(RE_CLIENT),
  produit,
  quantite: Joi.number().integer().min(1).max(1000),
  prix_unitaire: Joi.number().integer().min(1).max(10_000_000),
  remise_pct: Joi.number().min(0).max(50),
  mode_paiement: Joi.string().trim().uppercase().valid(...MODES_PAIEMENT),
  canal: Joi.string().trim().uppercase().valid(...CANAUX),
  point_vente: Joi.string().trim().uppercase().max(40).allow(null),
  statut: Joi.string().trim().uppercase().valid(...STATUTS),
};

const obligatoires = ['date_vente', 'code_client', 'produit', 'quantite', 'prix_unitaire', 'mode_paiement', 'canal'];

function avecObligatoires() {
  const schema = { ...champs };
  for (const nom of obligatoires) schema[nom] = schema[nom].required();
  schema.remise_pct = schema.remise_pct.default(0);
  schema.point_vente = schema.point_vente.default(null);
  schema.statut = schema.statut.default('VALIDEE');
  return schema;
}

const creation = Joi.object({
  reference: Joi.string().trim().uppercase().pattern(RE_REFERENCE),
  ...avecObligatoires(),
}).messages(messages);

const remplacement = Joi.object(avecObligatoires()).messages(messages);

const modification = Joi.object(champs).min(1).messages(messages);

const parametreReference = Joi.object({
  reference: Joi.string().trim().uppercase().pattern(RE_REFERENCE).required(),
}).messages(messages);

const TRIS = ['date_vente', '-date_vente', 'montant_net', '-montant_net', 'reference', '-reference'];

const recherche = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limite: Joi.number().integer().min(1).max(100).default(20),
  code_client: Joi.string().trim().uppercase().pattern(RE_CLIENT),
  code_produit: Joi.string().trim().uppercase().pattern(RE_PRODUIT),
  categorie: Joi.string().trim(),
  statut: Joi.string().trim().uppercase().valid(...STATUTS),
  mode_paiement: Joi.string().trim().uppercase().valid(...MODES_PAIEMENT),
  canal: Joi.string().trim().uppercase().valid(...CANAUX),
  point_vente: Joi.string().trim().uppercase(),
  source: Joi.string().trim().uppercase().valid('ETL', 'API'),
  date_debut: Joi.date().iso(),
  date_fin: Joi.date().iso().when('date_debut', { is: Joi.exist(), then: Joi.date().min(Joi.ref('date_debut')) }),
  montant_min: Joi.number().min(0),
  montant_max: Joi.number().min(0).when('montant_min', { is: Joi.exist(), then: Joi.number().min(Joi.ref('montant_min')) }),
  tri: Joi.string().valid(...TRIS).default('-date_vente'),
}).messages(messages);

const periode = Joi.object({
  date_debut: Joi.date().iso(),
  date_fin: Joi.date().iso().when('date_debut', { is: Joi.exist(), then: Joi.date().min(Joi.ref('date_debut')) }),
}).messages(messages);

module.exports = { creation, remplacement, modification, parametreReference, recherche, periode };

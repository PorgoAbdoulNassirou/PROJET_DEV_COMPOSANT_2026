'use strict';

const service = require('../services/vente.service');
const logger = require('../config/logger');

async function lister(req, res) {
  res.json(await service.lister(req.valide.query));
}

async function obtenir(req, res) {
  res.json(await service.trouverActive(req.valide.params.reference));
}

async function creer(req, res) {
  const vente = await service.creer(req.valide.body);
  logger.info('Vente creee', { type: 'metier', action: 'creation', reference: vente.reference, request_id: req.id });
  res.status(201).location(`/api/v1/ventes/${vente.reference}`).json(vente);
}

async function remplacer(req, res) {
  const vente = await service.mettreAJour(req.valide.params.reference, req.valide.body);
  logger.info('Vente remplacee', { type: 'metier', action: 'remplacement', reference: vente.reference, request_id: req.id });
  res.json(vente);
}

async function modifier(req, res) {
  const vente = await service.mettreAJour(req.valide.params.reference, req.valide.body);
  logger.info('Vente modifiee', {
    type: 'metier', action: 'modification', reference: vente.reference,
    champs: Object.keys(req.valide.body), request_id: req.id,
  });
  res.json(vente);
}

async function supprimer(req, res) {
  await service.supprimer(req.valide.params.reference);
  logger.info('Vente supprimee', { type: 'metier', action: 'suppression', reference: req.valide.params.reference, request_id: req.id });
  res.status(204).end();
}

async function statistiques(req, res) {
  res.json(await service.statistiques(req.valide.query));
}

module.exports = { lister, obtenir, creer, remplacer, modifier, supprimer, statistiques };

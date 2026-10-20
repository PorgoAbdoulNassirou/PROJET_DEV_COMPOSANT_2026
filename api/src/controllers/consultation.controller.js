'use strict';

// Ressources en lecture seule : clients et suivi des executions du DAG.

const Client = require('../models/client.model');
const { Vente } = require('../models/vente.model');
const { ExecutionEtl, RejetEtl } = require('../models/etl.model');
const { erreurs } = require('../utils/erreurs');

function echapper(texte) {
  return texte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function paginer(modele, filtre, tri, { page, limite }) {
  const [total, donnees] = await Promise.all([
    modele.countDocuments(filtre),
    modele.find(filtre).sort(tri).skip((page - 1) * limite).limit(limite),
  ]);
  return { donnees, pagination: { page, limite, total, pages: Math.ceil(total / limite) } };
}

async function listerClients(req, res) {
  const { q, ville, type_client: typeClient } = req.valide.query;
  const filtre = {};
  if (q) {
    const motif = new RegExp(echapper(q), 'i');
    filtre.$or = [{ code_client: motif }, { nom: motif }, { prenom: motif }, { email: motif }];
  }
  if (ville) filtre.ville = new RegExp(`^${echapper(ville)}$`, 'i');
  if (typeClient) filtre.type_client = typeClient;
  res.json(await paginer(Client, filtre, { code_client: 1 }, req.valide.query));
}

async function obtenirClient(req, res) {
  const { code } = req.valide.params;
  const client = await Client.findOne({ code_client: code });
  if (!client) throw erreurs.nonTrouvee('Client', code);
  const [resume] = await Vente.aggregate([
    { $match: { code_client: code, supprime: { $ne: true }, statut: 'VALIDEE' } },
    { $group: { _id: null, nombre_ventes: { $sum: 1 }, total_achats: { $sum: '$montant_net' }, derniere_vente: { $max: '$date_vente' } } },
    { $project: { _id: 0 } },
  ]);
  res.json({ ...client.toJSON(), resume_achats: resume || { nombre_ventes: 0, total_achats: 0, derniere_vente: null } });
}

async function ventesDuClient(req, res) {
  const { code } = req.valide.params;
  if (!(await Client.exists({ code_client: code }))) throw erreurs.nonTrouvee('Client', code);
  res.json(await paginer(Vente, { code_client: code, supprime: { $ne: true } }, { date_vente: -1 }, req.valide.query));
}

async function listerExecutions(req, res) {
  const filtre = req.valide.query.statut ? { statut: req.valide.query.statut } : {};
  res.json(await paginer(ExecutionEtl, filtre, { debut: -1 }, req.valide.query));
}

async function derniereExecution(req, res) {
  const execution = await ExecutionEtl.findOne({}).sort({ debut: -1 });
  if (!execution) throw erreurs.nonTrouvee('Execution', 'derniere');
  res.json(execution);
}

async function listerRejets(req, res) {
  const { run_id: runId, entite, categorie, motif } = req.valide.query;
  const filtre = {};
  if (runId) filtre.run_id = runId;
  if (entite) filtre.entite = entite;
  if (categorie) filtre.categorie = categorie;
  if (motif) filtre['motifs.code'] = motif;
  res.json(await paginer(RejetEtl, filtre, { horodatage: -1, fichier: 1, ligne: 1 }, req.valide.query));
}

module.exports = {
  listerClients, obtenirClient, ventesDuClient, listerExecutions, derniereExecution, listerRejets,
};

'use strict';

const { connecter, deconnecter } = require('../src/config/database');
const { Vente } = require('../src/models/vente.model');
const Client = require('../src/models/client.model');
const { ExecutionEtl, RejetEtl } = require('../src/models/etl.model');

const CLIENTS = [
  { code_client: 'CLI-0001', nom: 'OUEDRAOGO', prenom: 'Aminata', ville: 'Ouagadougou', type_client: 'PARTICULIER' },
  { code_client: 'CLI-0002', nom: 'SAWADOGO', prenom: 'Issouf', ville: 'Bobo-Dioulasso', type_client: 'PROFESSIONNEL' },
  { code_client: 'CLI-0003', nom: 'KABORE', prenom: 'Mariam', ville: 'Koudougou', type_client: 'PARTICULIER' },
];

function venteValide(surcharges = {}) {
  return {
    date_vente: '2026-10-10T10:30:00Z',
    code_client: 'CLI-0001',
    produit: { code: 'PRD-002', libelle: 'Huile végétale 5 L', categorie: 'Alimentation' },
    quantite: 3,
    prix_unitaire: 6500,
    remise_pct: 10,
    mode_paiement: 'MOBILE_MONEY',
    canal: 'BOUTIQUE',
    point_vente: 'OUAGA-CENTRE',
    ...surcharges,
  };
}

function viderTout() {
  return Promise.all([Vente.deleteMany({}), Client.deleteMany({}), ExecutionEtl.deleteMany({}), RejetEtl.deleteMany({})]);
}

async function demarrerBase() {
  await connecter(process.env.MONGO_URI_TEST);
  await viderTout();
  await Promise.all([Vente.syncIndexes(), Client.syncIndexes()]);
  await Client.insertMany(CLIENTS);
}

async function viderVentes() {
  await Vente.deleteMany({});
}

async function arreterBase() {
  await viderTout();
  await deconnecter();
}

module.exports = { CLIENTS, venteValide, demarrerBase, viderVentes, arreterBase };

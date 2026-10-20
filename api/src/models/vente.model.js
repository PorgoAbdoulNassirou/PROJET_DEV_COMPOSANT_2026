'use strict';

const mongoose = require('mongoose');

const MODES_PAIEMENT = ['ESPECES', 'MOBILE_MONEY', 'CARTE_BANCAIRE', 'VIREMENT'];
const CANAUX = ['BOUTIQUE', 'EN_LIGNE', 'TELEPHONE'];
const STATUTS = ['VALIDEE', 'ANNULEE'];

const produitSchema = new mongoose.Schema({
  code: { type: String, required: true, match: /^PRD-\d{3}$/ },
  libelle: { type: String, required: true, trim: true },
  categorie: { type: String, default: null },
}, { _id: false });

const venteSchema = new mongoose.Schema({
  reference: { type: String, required: true, match: /^VTE-\d{8}-[A-Z0-9]{4,10}$/ },
  date_vente: { type: Date, required: true },
  code_client: { type: String, required: true, match: /^CLI-\d{4}$/ },
  produit: { type: produitSchema, required: true },
  quantite: { type: Number, required: true, min: 1, max: 1000 },
  prix_unitaire: { type: Number, required: true, min: 1 },
  remise_pct: { type: Number, default: 0, min: 0, max: 50 },
  montant_brut: { type: Number, required: true },
  montant_remise: { type: Number, required: true },
  montant_net: { type: Number, required: true },
  devise: { type: String, default: 'XOF', enum: ['XOF'] },
  mode_paiement: { type: String, required: true, enum: MODES_PAIEMENT },
  canal: { type: String, required: true, enum: CANAUX },
  point_vente: { type: String, default: null },
  statut: { type: String, default: 'VALIDEE', enum: STATUTS },
  source: { type: String, required: true, enum: ['ETL', 'API'] },
  supprime: { type: Boolean, default: false },
  supprime_le: { type: Date },
  version: { type: Number, default: 1 },
  etl: { type: mongoose.Schema.Types.Mixed },
}, {
  collection: 'ventes',
  timestamps: { createdAt: 'cree_le', updatedAt: 'modifie_le' },
  versionKey: false,
  toJSON: {
    transform(doc, ret) {
      delete ret._id;
      return ret;
    },
  },
});

// Memes noms et definitions que mongo/init : la creation automatique par
// Mongoose est alors sans effet sur la base initialisee.
venteSchema.index({ reference: 1 }, { unique: true, name: 'uk_reference' });
venteSchema.index({ date_vente: -1 }, { name: 'ix_date_vente' });
venteSchema.index({ code_client: 1, date_vente: -1 }, { name: 'ix_client_date' });

/** Montants en francs CFA, arrondis a l'unite (meme regle que l'ETL). */
function calculerMontants(quantite, prixUnitaire, remisePct = 0) {
  const brut = quantite * prixUnitaire;
  const remise = Math.round((brut * remisePct) / 100);
  return { montant_brut: brut, montant_remise: remise, montant_net: brut - remise };
}

const Vente = mongoose.model('Vente', venteSchema);

module.exports = { Vente, calculerMontants, MODES_PAIEMENT, CANAUX, STATUTS };

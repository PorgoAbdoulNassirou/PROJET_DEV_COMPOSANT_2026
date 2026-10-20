'use strict';

const crypto = require('crypto');
const { Vente, calculerMontants } = require('../models/vente.model');
const Client = require('../models/client.model');
const { erreurs } = require('../utils/erreurs');

const NON_SUPPRIMEE = { supprime: { $ne: true } };

function construireFiltre(criteres) {
  const filtre = { ...NON_SUPPRIMEE };
  const egalites = ['code_client', 'statut', 'mode_paiement', 'canal', 'point_vente', 'source'];
  for (const champ of egalites) {
    if (criteres[champ]) filtre[champ] = criteres[champ];
  }
  if (criteres.code_produit) filtre['produit.code'] = criteres.code_produit;
  if (criteres.categorie) {
    filtre['produit.categorie'] = { $regex: `^${criteres.categorie.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' };
  }
  if (criteres.date_debut || criteres.date_fin) {
    filtre.date_vente = {};
    if (criteres.date_debut) filtre.date_vente.$gte = criteres.date_debut;
    if (criteres.date_fin) filtre.date_vente.$lte = criteres.date_fin;
  }
  if (criteres.montant_min !== undefined || criteres.montant_max !== undefined) {
    filtre.montant_net = {};
    if (criteres.montant_min !== undefined) filtre.montant_net.$gte = criteres.montant_min;
    if (criteres.montant_max !== undefined) filtre.montant_net.$lte = criteres.montant_max;
  }
  return filtre;
}

function triMongo(tri) {
  const sens = tri.startsWith('-') ? -1 : 1;
  const champ = tri.replace(/^-/, '');
  return champ === 'reference' ? { reference: sens } : { [champ]: sens, reference: 1 };
}

async function lister(criteres) {
  const { page, limite, tri } = criteres;
  const filtre = construireFiltre(criteres);
  const [total, ventes] = await Promise.all([
    Vente.countDocuments(filtre),
    Vente.find(filtre).sort(triMongo(tri)).skip((page - 1) * limite).limit(limite),
  ]);
  return {
    donnees: ventes,
    pagination: { page, limite, total, pages: Math.ceil(total / limite) },
  };
}

async function trouverActive(reference) {
  const vente = await Vente.findOne({ reference, ...NON_SUPPRIMEE });
  if (!vente) throw erreurs.nonTrouvee('Vente', reference);
  return vente;
}

async function verifierClient(codeClient) {
  const existe = await Client.exists({ code_client: codeClient });
  if (!existe) throw erreurs.clientInconnu(codeClient);
}

function genererReference(dateVente) {
  const jour = dateVente.toISOString().slice(0, 10).replace(/-/g, '');
  return `VTE-${jour}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function creer(donnees) {
  await verifierClient(donnees.code_client);
  const reference = donnees.reference || genererReference(donnees.date_vente);
  try {
    return await Vente.create({
      ...donnees,
      reference,
      ...calculerMontants(donnees.quantite, donnees.prix_unitaire, donnees.remise_pct),
      source: 'API',
    });
  } catch (err) {
    if (err.code === 11000) {
      throw erreurs.conflit(`Une vente portant la reference '${reference}' existe deja`);
    }
    throw err;
  }
}

/**
 * Met a jour une vente active. Pour un PUT, `donnees` contient tous les champs
 * (valeurs par defaut comprises) ; pour un PATCH, seulement ceux transmis.
 * Les montants sont toujours recalcules.
 */
async function mettreAJour(reference, donnees) {
  const vente = await trouverActive(reference);
  if (donnees.code_client && donnees.code_client !== vente.code_client) {
    await verifierClient(donnees.code_client);
  }
  vente.set(donnees);
  vente.set(calculerMontants(vente.quantite, vente.prix_unitaire, vente.remise_pct));
  vente.version = (vente.version || 1) + 1;
  return vente.save();
}

/**
 * Suppression logique : la vente disparait de l'API mais reste en base,
 * ce qui empeche le DAG de la recreer lors d'un prochain chargement.
 */
async function supprimer(reference) {
  const vente = await trouverActive(reference);
  vente.supprime = true;
  vente.supprime_le = new Date();
  vente.version = (vente.version || 1) + 1;
  await vente.save();
}

async function statistiques({ date_debut: debut, date_fin: fin }) {
  const filtre = { ...NON_SUPPRIMEE, statut: 'VALIDEE' };
  if (debut || fin) {
    filtre.date_vente = {};
    if (debut) filtre.date_vente.$gte = debut;
    if (fin) filtre.date_vente.$lte = fin;
  }
  const regrouper = (champ) => [
    { $group: { _id: champ, nombre: { $sum: 1 }, chiffre_affaires: { $sum: '$montant_net' } } },
    { $sort: { chiffre_affaires: -1 } },
    { $project: { _id: 0, cle: '$_id', nombre: 1, chiffre_affaires: 1 } },
  ];
  const [resultat] = await Vente.aggregate([
    { $match: filtre },
    {
      $facet: {
        global: [
          {
            $group: {
              _id: null,
              nombre_ventes: { $sum: 1 },
              chiffre_affaires: { $sum: '$montant_net' },
              remises_accordees: { $sum: '$montant_remise' },
              panier_moyen: { $avg: '$montant_net' },
              premiere_vente: { $min: '$date_vente' },
              derniere_vente: { $max: '$date_vente' },
            },
          },
          { $project: { _id: 0 } },
        ],
        par_mode_paiement: regrouper('$mode_paiement'),
        par_categorie: regrouper('$produit.categorie'),
        par_point_vente: regrouper('$point_vente'),
      },
    },
  ]);
  const global = resultat.global[0] || { nombre_ventes: 0, chiffre_affaires: 0, remises_accordees: 0, panier_moyen: 0 };
  global.panier_moyen = Math.round(global.panier_moyen || 0);
  return {
    devise: 'XOF',
    periode: { date_debut: debut || null, date_fin: fin || null },
    ...global,
    par_mode_paiement: resultat.par_mode_paiement,
    par_categorie: resultat.par_categorie,
    par_point_vente: resultat.par_point_vente,
  };
}

module.exports = { lister, trouverActive, creer, mettreAJour, supprimer, statistiques };

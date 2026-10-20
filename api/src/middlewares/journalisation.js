'use strict';

const crypto = require('crypto');
const logger = require('../config/logger');

const RE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Attribue un identifiant de correlation a chaque requete (en-tete X-Request-Id
 * repris s'il est fourni et valide), puis journalise la requete a la fin de son
 * traitement : une ligne JSON par requete, enrichie du code d'erreur eventuel.
 */
function identifiantRequete(req, res, next) {
  const fourni = req.get('X-Request-Id');
  req.id = fourni && RE_ID.test(fourni) ? fourni : crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  next();
}

function journalAcces(req, res, next) {
  const debut = process.hrtime.bigint();
  res.on('finish', () => {
    const statut = res.statusCode;
    if (req.path === '/sante' && statut < 400) return; // sondes de supervision

    const dureeMs = Number(process.hrtime.bigint() - debut) / 1e6;
    const niveau = statut >= 500 ? 'error' : statut >= 400 ? 'warn' : 'info';
    const evenement = {
      type: 'acces',
      request_id: req.id,
      http: {
        methode: req.method,
        url: req.originalUrl,
        route: req.route ? `${req.baseUrl}${req.route.path}` : null,
        statut,
        duree_ms: Math.round(dureeMs * 100) / 100,
        taille_reponse: Number(res.get('Content-Length')) || 0,
        ip: req.ip,
        user_agent: req.get('User-Agent') || null,
      },
    };
    if (res.locals.erreur) evenement.erreur = res.locals.erreur;
    logger.log(niveau, `${req.method} ${req.originalUrl} ${statut} ${evenement.http.duree_ms}ms`, evenement);
  });
  next();
}

module.exports = { identifiantRequete, journalAcces };

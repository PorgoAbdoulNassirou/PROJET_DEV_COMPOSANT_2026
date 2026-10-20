'use strict';

/**
 * Erreur metier renvoyee au client avec un code HTTP et un code applicatif
 * stable (utilise dans les tests et pour filtrer les journaux dans Kibana).
 */
class ErreurApi extends Error {
  constructor(statut, code, message, details) {
    super(message);
    this.name = 'ErreurApi';
    this.statut = statut;
    this.code = code;
    this.details = details;
  }
}

const erreurs = {
  validation: (details) => new ErreurApi(400, 'VALIDATION_ECHOUEE', 'Les donnees envoyees sont invalides', details),
  nonTrouvee: (ressource, id) => new ErreurApi(404, 'RESSOURCE_INTROUVABLE', `${ressource} '${id}' introuvable`),
  conflit: (message) => new ErreurApi(409, 'REFERENCE_EXISTANTE', message),
  clientInconnu: (code) => new ErreurApi(422, 'CLIENT_INCONNU', `Le client '${code}' n'existe pas dans le referentiel`),
  baseIndisponible: () => new ErreurApi(503, 'BASE_INDISPONIBLE', 'La base de donnees est momentanement indisponible'),
};

module.exports = { ErreurApi, erreurs };

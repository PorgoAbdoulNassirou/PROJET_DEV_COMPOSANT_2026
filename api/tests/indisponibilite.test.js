'use strict';

// Comportement de l'API lorsque MongoDB est injoignable (aucune connexion ouverte).

const request = require('supertest');
const creerApplication = require('../src/app');
const { calculerMontants } = require('../src/models/vente.model');

const app = creerApplication();

test('les routes metier repondent 503 avec Retry-After', async () => {
  const res = await request(app).get('/api/v1/ventes').expect(503);
  expect(res.body.erreur.code).toBe('BASE_INDISPONIBLE');
  expect(res.headers['retry-after']).toBe('10');
});

test('la sonde de sante signale l\'etat degrade', async () => {
  const res = await request(app).get('/sante').expect(503);
  expect(res.body).toMatchObject({ statut: 'DEGRADE', mongodb: 'deconnecte' });
});

test('la documentation reste accessible', async () => {
  await request(app).get('/openapi.json').expect(200);
});

describe('calculerMontants', () => {
  test.each([
    [3, 6500, 10, { montant_brut: 19500, montant_remise: 1950, montant_net: 17550 }],
    [1, 999, 5, { montant_brut: 999, montant_remise: 50, montant_net: 949 }],
    [2, 17500, 0, { montant_brut: 35000, montant_remise: 0, montant_net: 35000 }],
  ])('%i x %i avec %i %% de remise', (q, p, r, attendu) => {
    expect(calculerMontants(q, p, r)).toEqual(attendu);
  });
});

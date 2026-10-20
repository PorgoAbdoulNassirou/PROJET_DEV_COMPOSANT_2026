'use strict';

const request = require('supertest');
const creerApplication = require('../src/app');
const { ExecutionEtl, RejetEtl } = require('../src/models/etl.model');
const { venteValide, demarrerBase, arreterBase } = require('./outils');

const app = creerApplication();

beforeAll(async () => {
  await demarrerBase();
  await request(app).post('/api/v1/ventes').send(venteValide()).expect(201);
  await request(app).post('/api/v1/ventes').send(venteValide({ statut: 'ANNULEE' })).expect(201);
});
afterAll(arreterBase);

describe('Clients', () => {
  test('liste paginee triee par code', async () => {
    const res = await request(app).get('/api/v1/clients').expect(200);
    expect(res.body.donnees.map((c) => c.code_client)).toEqual(['CLI-0001', 'CLI-0002', 'CLI-0003']);
    expect(res.body.pagination.total).toBe(3);
  });

  test('recherche plein texte et filtre par ville', async () => {
    const parNom = await request(app).get('/api/v1/clients').query({ q: 'sawa' }).expect(200);
    expect(parNom.body.donnees.map((c) => c.code_client)).toEqual(['CLI-0002']);
    const parVille = await request(app).get('/api/v1/clients').query({ ville: 'koudougou' }).expect(200);
    expect(parVille.body.donnees.map((c) => c.code_client)).toEqual(['CLI-0003']);
  });

  test('detail avec resume des achats (ventes validees)', async () => {
    const res = await request(app).get('/api/v1/clients/CLI-0001').expect(200);
    expect(res.body.resume_achats).toMatchObject({ nombre_ventes: 1, total_achats: 17550 });
  });

  test('ventes du client', async () => {
    const res = await request(app).get('/api/v1/clients/CLI-0001/ventes').expect(200);
    expect(res.body.pagination.total).toBe(2);
  });

  test('client inexistant', async () => {
    await request(app).get('/api/v1/clients/CLI-0999').expect(404);
    await request(app).get('/api/v1/clients/CLI-0999/ventes').expect(404);
  });
});

describe('Suivi ETL', () => {
  test('404 tant qu\'aucune execution n\'est enregistree', async () => {
    await request(app).get('/api/v1/etl/executions/derniere').expect(404);
  });

  test('historique et derniere execution', async () => {
    await ExecutionEtl.collection.insertMany([
      { run_id: 'manual__1', statut: 'SUCCES', debut: new Date('2026-10-15T02:00:00Z') },
      { run_id: 'manual__2', statut: 'ECHEC', debut: new Date('2026-10-16T02:00:00Z') },
    ]);
    const derniere = await request(app).get('/api/v1/etl/executions/derniere').expect(200);
    expect(derniere.body.run_id).toBe('manual__2');
    const succes = await request(app).get('/api/v1/etl/executions').query({ statut: 'succes' }).expect(200);
    expect(succes.body.donnees.map((e) => e.run_id)).toEqual(['manual__1']);
  });

  test('rejets filtres par motif', async () => {
    await RejetEtl.collection.insertMany([
      { run_id: 'manual__1', entite: 'vente', fichier: 'a.csv', ligne: 2, categorie: 'INVALIDE', motifs: [{ code: 'CLIENT_INCONNU' }] },
      { run_id: 'manual__1', entite: 'vente', fichier: 'a.csv', ligne: 3, categorie: 'DOUBLON', motifs: [{ code: 'DOUBLON_EXACT' }] },
    ]);
    const res = await request(app).get('/api/v1/etl/rejets').query({ motif: 'client_inconnu' }).expect(200);
    expect(res.body.donnees).toHaveLength(1);
    expect(res.body.donnees[0].ligne).toBe(2);
  });
});

describe('Supervision et documentation', () => {
  test('sonde de sante', async () => {
    const res = await request(app).get('/sante').expect(200);
    expect(res.body).toMatchObject({ statut: 'OK', mongodb: 'connecte' });
  });

  test('contrat OpenAPI publie', async () => {
    const res = await request(app).get('/openapi.json').expect(200);
    expect(res.body.openapi).toBe('3.0.3');
    expect(Object.keys(res.body.paths)).toContain('/api/v1/ventes/{reference}');
  });
});

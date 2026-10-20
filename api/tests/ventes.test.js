'use strict';

const request = require('supertest');
const creerApplication = require('../src/app');
const { Vente } = require('../src/models/vente.model');
const { venteValide, demarrerBase, viderVentes, arreterBase } = require('./outils');

const app = creerApplication();
const URL = '/api/v1/ventes';

beforeAll(demarrerBase);
afterEach(viderVentes);
afterAll(arreterBase);

describe('POST /api/v1/ventes', () => {
  test('cree une vente, calcule les montants et genere la reference', async () => {
    const res = await request(app).post(URL).send(venteValide()).expect(201);

    expect(res.body.reference).toMatch(/^VTE-20261010-[A-F0-9]{6}$/);
    expect(res.headers.location).toBe(`${URL}/${res.body.reference}`);
    expect(res.body).toMatchObject({
      montant_brut: 19500,
      montant_remise: 1950,
      montant_net: 17550,
      devise: 'XOF',
      statut: 'VALIDEE',
      source: 'API',
      version: 1,
    });
    expect(res.body._id).toBeUndefined();
  });

  test('normalise la casse des valeurs enumerees', async () => {
    const res = await request(app).post(URL)
      .send(venteValide({ mode_paiement: 'especes', canal: 'en_ligne', code_client: 'cli-0002' }))
      .expect(201);
    expect(res.body.mode_paiement).toBe('ESPECES');
    expect(res.body.canal).toBe('EN_LIGNE');
    expect(res.body.code_client).toBe('CLI-0002');
  });

  test('refuse une reference deja utilisee (409)', async () => {
    const corps = venteValide({ reference: 'VTE-20261010-TEST01' });
    await request(app).post(URL).send(corps).expect(201);
    const res = await request(app).post(URL).send(corps).expect(409);
    expect(res.body.erreur.code).toBe('REFERENCE_EXISTANTE');
  });

  test('refuse un client absent du referentiel (422)', async () => {
    const res = await request(app).post(URL).send(venteValide({ code_client: 'CLI-9999' })).expect(422);
    expect(res.body.erreur.code).toBe('CLIENT_INCONNU');
  });

  test('retourne le detail de chaque champ invalide (400)', async () => {
    const res = await request(app).post(URL)
      .send(venteValide({ quantite: 0, prix_unitaire: -5, mode_paiement: 'CHEQUE', code_client: undefined }))
      .expect(400);
    expect(res.body.erreur.code).toBe('VALIDATION_ECHOUEE');
    const champs = res.body.erreur.details.map((d) => d.champ).sort();
    expect(champs).toEqual(['code_client', 'mode_paiement', 'prix_unitaire', 'quantite']);
  });

  test('refuse les montants fournis par le client', async () => {
    const res = await request(app).post(URL).send(venteValide({ montant_net: 1 })).expect(400);
    expect(res.body.erreur.details[0]).toEqual({ champ: 'montant_net', message: "montant_net n'est pas un champ autorise" });
  });

  test('refuse une date de vente future', async () => {
    const res = await request(app).post(URL).send(venteValide({ date_vente: '2099-01-01T00:00:00Z' })).expect(400);
    expect(res.body.erreur.details[0].champ).toBe('date_vente');
  });

  test('refuse un JSON mal forme', async () => {
    const res = await request(app).post(URL)
      .set('Content-Type', 'application/json')
      .send('{"quantite": 3,')
      .expect(400);
    expect(res.body.erreur.code).toBe('JSON_INVALIDE');
  });
});

describe('GET /api/v1/ventes', () => {
  beforeEach(async () => {
    const corps = [
      venteValide({ reference: 'VTE-20261001-A001', date_vente: '2026-10-01T09:00:00Z', quantite: 1 }),
      venteValide({ reference: 'VTE-20261002-A002', date_vente: '2026-10-02T09:00:00Z', code_client: 'CLI-0002', mode_paiement: 'ESPECES' }),
      venteValide({ reference: 'VTE-20261003-A003', date_vente: '2026-10-03T09:00:00Z', statut: 'ANNULEE' }),
      venteValide({ reference: 'VTE-20261004-A004', date_vente: '2026-10-04T09:00:00Z', quantite: 10 }),
      venteValide({ reference: 'VTE-20261005-A005', date_vente: '2026-10-05T09:00:00Z', produit: { code: 'PRD-011', libelle: 'Smartphone', categorie: 'Téléphonie' }, prix_unitaire: 75000, remise_pct: 0 }),
    ];
    for (const c of corps) await request(app).post(URL).send(c).expect(201);
  });

  test('pagine les resultats', async () => {
    const res = await request(app).get(URL).query({ limite: 2, page: 2 }).expect(200);
    expect(res.body.donnees).toHaveLength(2);
    expect(res.body.pagination).toEqual({ page: 2, limite: 2, total: 5, pages: 3 });
    // tri par defaut : date decroissante
    expect(res.body.donnees.map((v) => v.reference)).toEqual(['VTE-20261003-A003', 'VTE-20261002-A002']);
  });

  test.each([
    [{ code_client: 'CLI-0002' }, ['VTE-20261002-A002']],
    [{ statut: 'ANNULEE' }, ['VTE-20261003-A003']],
    [{ mode_paiement: 'especes' }, ['VTE-20261002-A002']],
    [{ categorie: 'téléphonie' }, ['VTE-20261005-A005']],
    [{ date_debut: '2026-10-02T00:00:00Z', date_fin: '2026-10-03T23:59:59Z' }, ['VTE-20261003-A003', 'VTE-20261002-A002']],
    [{ montant_min: 50000 }, ['VTE-20261005-A005', 'VTE-20261004-A004']],
  ])('filtre %o', async (filtre, attendues) => {
    const res = await request(app).get(URL).query(filtre).expect(200);
    expect(res.body.donnees.map((v) => v.reference)).toEqual(attendues);
  });

  test('trie par montant croissant', async () => {
    const res = await request(app).get(URL).query({ tri: 'montant_net' }).expect(200);
    const montants = res.body.donnees.map((v) => v.montant_net);
    expect(montants).toEqual([...montants].sort((a, b) => a - b));
  });

  test('refuse des parametres incoherents', async () => {
    const res = await request(app).get(URL)
      .query({ limite: 500, date_debut: '2026-10-05T00:00:00Z', date_fin: '2026-10-01T00:00:00Z' })
      .expect(400);
    expect(res.body.erreur.details.map((d) => d.champ).sort()).toEqual(['date_fin', 'limite']);
  });

  test('calcule les statistiques sur les ventes validees uniquement', async () => {
    const res = await request(app).get(`${URL}/statistiques`).expect(200);
    expect(res.body.nombre_ventes).toBe(4);
    expect(res.body.chiffre_affaires).toBe(5850 + 17550 + 58500 + 225000);
    expect(res.body.par_mode_paiement.map((r) => r.cle).sort()).toEqual(['ESPECES', 'MOBILE_MONEY']);
  });
});

describe('GET / PUT / PATCH / DELETE /api/v1/ventes/:reference', () => {
  const REF = 'VTE-20261010-B001';
  beforeEach(() => request(app).post(URL).send(venteValide({ reference: REF })).expect(201));

  test('consulte une vente', async () => {
    const res = await request(app).get(`${URL}/${REF}`).expect(200);
    expect(res.body.reference).toBe(REF);
  });

  test('accepte la reference en minuscules', async () => {
    await request(app).get(`${URL}/${REF.toLowerCase()}`).expect(200);
  });

  test('404 sur une reference inexistante, 400 sur un format invalide', async () => {
    const absente = await request(app).get(`${URL}/VTE-20261010-ZZZZ`).expect(404);
    expect(absente.body.erreur.code).toBe('RESSOURCE_INTROUVABLE');
    const invalide = await request(app).get(`${URL}/abc`).expect(400);
    expect(invalide.body.erreur.details[0].champ).toBe('reference');
  });

  test('PUT remplace la vente et recalcule les montants', async () => {
    const res = await request(app).put(`${URL}/${REF}`)
      .send(venteValide({ quantite: 4, remise_pct: undefined, point_vente: undefined }))
      .expect(200);
    expect(res.body).toMatchObject({ quantite: 4, remise_pct: 0, montant_net: 26000, point_vente: null, version: 2 });
  });

  test('PUT exige tous les champs obligatoires', async () => {
    const res = await request(app).put(`${URL}/${REF}`).send({ quantite: 4 }).expect(400);
    expect(res.body.erreur.details.length).toBeGreaterThanOrEqual(5);
  });

  test('PUT refuse de changer la reference', async () => {
    await request(app).put(`${URL}/${REF}`).send(venteValide({ reference: 'VTE-20261010-AUTRE' })).expect(400);
  });

  test('PATCH modifie un champ et conserve les autres', async () => {
    const res = await request(app).patch(`${URL}/${REF}`).send({ statut: 'ANNULEE' }).expect(200);
    expect(res.body).toMatchObject({ statut: 'ANNULEE', quantite: 3, montant_net: 17550, version: 2 });
  });

  test('PATCH recalcule les montants si la quantite change', async () => {
    const res = await request(app).patch(`${URL}/${REF}`).send({ quantite: 2 }).expect(200);
    expect(res.body.montant_net).toBe(11700);
  });

  test('PATCH refuse un corps vide et un client inconnu', async () => {
    await request(app).patch(`${URL}/${REF}`).send({}).expect(400);
    const res = await request(app).patch(`${URL}/${REF}`).send({ code_client: 'CLI-0404' }).expect(422);
    expect(res.body.erreur.code).toBe('CLIENT_INCONNU');
  });

  test('DELETE effectue une suppression logique', async () => {
    await request(app).delete(`${URL}/${REF}`).expect(204);
    await request(app).get(`${URL}/${REF}`).expect(404);
    await request(app).delete(`${URL}/${REF}`).expect(404);

    const enBase = await Vente.findOne({ reference: REF }).lean();
    expect(enBase.supprime).toBe(true);
    expect(enBase.supprime_le).toBeInstanceOf(Date);

    // la reference reste reservee
    await request(app).post(URL).send(venteValide({ reference: REF })).expect(409);
  });
});

describe('Transversal', () => {
  test('propage l\'identifiant de correlation fourni', async () => {
    const res = await request(app).get(`${URL}/VTE-20261010-NONE`).set('X-Request-Id', 'test-correlation-001').expect(404);
    expect(res.headers['x-request-id']).toBe('test-correlation-001');
    expect(res.body.erreur.request_id).toBe('test-correlation-001');
  });

  test('genere un identifiant si absent', async () => {
    const res = await request(app).get(URL).expect(200);
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('route inconnue', async () => {
    const res = await request(app).get('/api/v1/produits').expect(404);
    expect(res.body.erreur.code).toBe('ROUTE_INTROUVABLE');
  });
});

// Test de bout en bout de la chaine principale :
//
//   fichiers CSV -> DAG Airflow ventes_etl -> MongoDB -> API Express -> journaux ELK
//
// Scenario :
//   1. execution du DAG et verification du bilan (insertions, rejets, doublons) ;
//   2. seconde execution sur les memes fichiers : aucune ecriture (idempotence) ;
//   3. depot d'un export correctif : mises a jour et insertions attendues ;
//   4. operations CRUD sur l'API, y compris les cas d'erreur ;
//   5. presence des erreurs de l'API et des bilans du DAG dans Elasticsearch.
//
// Le test s'execute dans le reseau Docker (service "e2e" du profil test) et
// n'utilise que les API HTTP des composants.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL || 'http://localhost:3000';
const AIRFLOW = process.env.AIRFLOW_URL || 'http://localhost:8080';
const ES = process.env.ES_URL || 'http://localhost:9200';
const SOURCE = process.env.REPERTOIRE_SOURCE || '../../data/source';
const AUTH = 'Basic ' + Buffer.from(`${process.env.AIRFLOW_USER || 'admin'}:${process.env.AIRFLOW_PASSWORD || 'admin'}`).toString('base64');
const DAG = 'ventes_etl';
const ID_SCENARIO = randomUUID().slice(0, 8);
const FICHIER_CORRECTIF = `${SOURCE}/ventes_9999-12-31_e2e.csv`;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function appel(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const texte = await res.text();
  let corps = null;
  try { corps = texte ? JSON.parse(texte) : null; } catch { corps = texte; }
  return { statut: res.status, corps, entetes: res.headers };
}

const api = (chemin, options) => appel(`${API}${chemin}`, options);
const airflow = (chemin, options = {}) => appel(`${AIRFLOW}/api/v1${chemin}`, {
  ...options, headers: { Authorization: AUTH, ...(options.headers || {}) },
});

async function attendre(description, verifier, { delaiMs = 240000, intervalleMs = 3000 } = {}) {
  const limite = Date.now() + delaiMs;
  let dernier;
  while (Date.now() < limite) {
    try {
      dernier = await verifier();
      if (dernier) return dernier;
    } catch (err) {
      dernier = err.message;
    }
    await pause(intervalleMs);
  }
  throw new Error(`Delai depasse : ${description} (dernier etat : ${JSON.stringify(dernier)})`);
}

/** Declenche le DAG, attend la fin et retourne le bilan enregistre par publier_rapport. */
async function executerDag(libelle) {
  const runId = `e2e__${ID_SCENARIO}__${libelle}`;
  const declenchement = await airflow(`/dags/${DAG}/dagRuns`, {
    method: 'POST', body: JSON.stringify({ dag_run_id: runId, conf: {} }),
  });
  assert.equal(declenchement.statut, 200, `declenchement du DAG : ${JSON.stringify(declenchement.corps)}`);

  const etat = await attendre(`fin du DAG run ${runId}`, async () => {
    const { corps } = await airflow(`/dags/${DAG}/dagRuns/${encodeURIComponent(runId)}`);
    return ['success', 'failed'].includes(corps.state) ? corps.state : null;
  }, { delaiMs: 300000 });
  assert.equal(etat, 'success', `le DAG run ${runId} doit reussir`);

  const { corps: bilan } = await api('/api/v1/etl/executions/derniere');
  assert.equal(bilan.run_id, runId);
  assert.equal(bilan.statut, 'SUCCES');
  return bilan;
}

async function rechercherJournaux(index, requete) {
  const { corps } = await appel(`${ES}/${index}/_search`, {
    method: 'POST', body: JSON.stringify({ size: 50, query: requete }),
  });
  return corps?.hits?.hits?.map((h) => h._source) || [];
}

before(async () => {
  await attendre('API disponible', async () => (await api('/sante')).statut === 200);
  await attendre('Airflow disponible', async () => (await airflow(`/dags/${DAG}`)).statut === 200);
  const { statut } = await airflow(`/dags/${DAG}`, { method: 'PATCH', body: JSON.stringify({ is_paused: false }) });
  assert.equal(statut, 200, 'activation du DAG');
});

after(async () => {
  await rm(FICHIER_CORRECTIF, { force: true });
});

let bilanInitial;

test('1. le DAG charge les ventes valides et ecarte les lignes invalides', async () => {
  bilanInitial = await executerDag('initial');
  const { ventes, clients, controles } = bilanInitial;

  assert.ok(bilanInitial.fichiers.length >= 14, 'les 14 exports journaliers sont lus');
  assert.equal(clients.valides, 60);
  assert.equal(clients.rejetes, 2);
  assert.equal(ventes.lignes_lues, 843);
  assert.equal(ventes.valides, 711);
  assert.equal(ventes.rejetees, 38);
  assert.equal(ventes.doublons_exacts + ventes.versions_obsoletes, 94);
  assert.equal(ventes.motifs_rejet.CLIENT_INCONNU, 14);
  // Selon l'etat de la base avant le test, les ventes sont inserees, mises a jour ou deja a jour.
  assert.equal(ventes.inserees + ventes.mises_a_jour + ventes.inchangees + ventes.ignorees_supprimees + ventes.conflits, 711);
  assert.ok(controles.every((c) => c.conforme), JSON.stringify(controles));

  const { corps } = await api('/api/v1/ventes?source=ETL&limite=1');
  assert.ok(corps.pagination.total >= 700);
});

test('2. une seconde execution sur les memes fichiers ne modifie rien (idempotence)', async () => {
  const avant = (await api('/api/v1/ventes?limite=1')).corps.pagination.total;
  const { ventes } = await executerDag('rejeu');
  assert.equal(ventes.inserees, 0);
  assert.equal(ventes.mises_a_jour, 0);
  assert.equal(ventes.inchangees + ventes.ignorees_supprimees + ventes.conflits, 711);
  const apres = (await api('/api/v1/ventes?limite=1')).corps.pagination.total;
  assert.equal(apres, avant, 'le nombre de ventes est inchange');
});

test('3. un export correctif met a jour les ventes existantes et ajoute les nouvelles', async () => {
  const { corps } = await api('/api/v1/ventes?source=ETL&statut=VALIDEE&limite=3&tri=reference');
  const cibles = corps.donnees;
  const maintenant = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const entete = 'reference;date_vente;code_client;code_produit;libelle_produit;categorie;quantite;prix_unitaire;remise_pct;mode_paiement;canal;point_vente;statut;date_maj';
  const ligne = (v, quantite, reference = v.reference) => [
    reference, v.date_vente.slice(0, 19).replace('T', ' '), v.code_client, v.produit.code, v.produit.libelle,
    v.produit.categorie, quantite, v.prix_unitaire, v.remise_pct, v.mode_paiement, v.canal, v.point_vente,
    v.statut, maintenant,
  ].join(';');
  const nouvelles = [`VTE-20261015-E${ID_SCENARIO.slice(0, 5).toUpperCase()}1`, `VTE-20261015-E${ID_SCENARIO.slice(0, 5).toUpperCase()}2`];
  const contenu = [
    entete,
    ...cibles.map((v) => ligne(v, v.quantite + 100)),
    ...nouvelles.map((ref) => ligne(cibles[0], 2, ref)),
  ].join('\n');
  await writeFile(FICHIER_CORRECTIF, `${contenu}\n`, 'utf8');

  const { ventes } = await executerDag('correctif');
  assert.equal(ventes.mises_a_jour, 3);
  assert.equal(ventes.inserees, 2);

  const corrigee = (await api(`/api/v1/ventes/${cibles[0].reference}`)).corps;
  assert.equal(corrigee.quantite, cibles[0].quantite + 100);
  assert.equal(corrigee.version, cibles[0].version + 1);
  assert.equal(corrigee.montant_brut, corrigee.quantite * corrigee.prix_unitaire);

  // Retrait du correctif : l'execution suivante realigne la base sur les exports d'origine.
  await rm(FICHIER_CORRECTIF, { force: true });
  const realignement = await executerDag('realignement');
  assert.equal(realignement.ventes.mises_a_jour, 3);
  assert.equal((await api(`/api/v1/ventes/${cibles[0].reference}`)).corps.quantite, cibles[0].quantite);

  // Les deux ventes de test sont retirees (suppression logique, jamais recreees par le DAG).
  for (const ref of nouvelles) {
    assert.equal((await api(`/api/v1/ventes/${ref}`, { method: 'DELETE' })).statut, 204);
  }
});

test('4. CRUD des ventes et gestion des erreurs par l\'API', async () => {
  const entete = { 'X-Request-Id': `e2e-${ID_SCENARIO}-crud` };
  const nouvelle = {
    date_vente: '2026-10-16T09:30:00Z', code_client: 'CLI-0007',
    produit: { code: 'PRD-013', libelle: 'Panneau solaire 100 W', categorie: 'Énergie' },
    quantite: 2, prix_unitaire: 45000, remise_pct: 10, mode_paiement: 'VIREMENT', canal: 'EN_LIGNE', point_vente: 'WEB',
  };

  const creation = await api('/api/v1/ventes', { method: 'POST', body: JSON.stringify(nouvelle), headers: entete });
  assert.equal(creation.statut, 201);
  assert.equal(creation.corps.montant_net, 81000);
  const ref = creation.corps.reference;

  assert.equal((await api(`/api/v1/ventes/${ref}`)).corps.source, 'API');
  const maj = await api(`/api/v1/ventes/${ref}`, { method: 'PATCH', body: JSON.stringify({ quantite: 3 }) });
  assert.equal(maj.statut, 200);
  assert.equal(maj.corps.montant_net, 121500);
  assert.equal((await api(`/api/v1/ventes/${ref}`, { method: 'DELETE' })).statut, 204);
  assert.equal((await api(`/api/v1/ventes/${ref}`)).statut, 404);

  // Erreurs volontaires, retrouvees ensuite dans Elasticsearch
  const idErreur = `e2e-${ID_SCENARIO}-erreurs`;
  const h = { 'X-Request-Id': idErreur };
  assert.equal((await api('/api/v1/ventes', { method: 'POST', body: JSON.stringify({ ...nouvelle, quantite: 0 }), headers: h })).statut, 400);
  assert.equal((await api('/api/v1/ventes', { method: 'POST', body: JSON.stringify({ ...nouvelle, code_client: 'CLI-9999' }), headers: h })).statut, 422);
  assert.equal((await api('/api/v1/ventes', { method: 'POST', body: '{"quantite":', headers: h })).statut, 400);
  assert.equal((await api('/api/v1/ventes/VTE-20991231-XXXX', { headers: h })).statut, 404);
});

test('5. les erreurs de l\'API et les bilans du DAG sont centralises dans Elasticsearch', async () => {
  const idErreur = `e2e-${ID_SCENARIO}-erreurs`;
  const erreurs = await attendre('indexation des erreurs de l\'API', async () => {
    const docs = await rechercherJournaux('api-ventes-logs-*', { term: { request_id: idErreur } });
    return docs.length >= 4 ? docs : null;
  }, { delaiMs: 120000, intervalleMs: 5000 });

  const codes = erreurs.map((d) => d.erreur?.code).sort();
  assert.deepEqual(codes, ['CLIENT_INCONNU', 'JSON_INVALIDE', 'RESSOURCE_INTROUVABLE', 'VALIDATION_ECHOUEE']);
  assert.ok(erreurs.every((d) => d.http.statut >= 400 && d.level === 'warn' && d.categorie_statut === '4xx'));

  const bilans = await attendre('indexation du bilan du DAG', async () => {
    const docs = await rechercherJournaux('airflow-logs-*', { term: { 'bilan.run_id': `e2e__${ID_SCENARIO}__rejeu` } });
    return docs.length ? docs : null;
  }, { delaiMs: 120000, intervalleMs: 5000 });
  assert.equal(bilans[0].bilan.ventes.inserees, 0);
  assert.equal(bilans[0].airflow.task_id, 'publier_rapport');
});

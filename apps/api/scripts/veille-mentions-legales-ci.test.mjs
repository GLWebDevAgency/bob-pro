import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  echapperAnnotation,
  rapport,
  regimeDominant,
  TITRE_ANNOTATION,
} from './veille-mentions-legales-ci.mjs';

// Le canal de l'ÉTAGE 1 du régime d'alarme des mentions légales. Ce qui est prouvé ici, c'est
// exactement ce qui a fait défaut au dispositif précédent : qu'un PRÉAVIS se voie sans bloquer, que
// seule une ÉCHÉANCE ATTEINTE bloque, et qu'aucun interrupteur ne permette de contourner l'un ou
// l'autre. Le calcul du régime, lui, appartient au domaine (@bob/core) et y est testé.

const echeance = (over = {}) => ({
  id: 'cibs-decret-formulation-franchise',
  echeance: '2027-01-01',
  objet: 'Entrée en vigueur du transfert de la TVA dans le CIBS.',
  aFaire: 'Vérifier la parution du décret, ajouter sa rédaction verbatim à REDACTIONS_FRANCHISE.',
  sources: ['Ordonnance n° 2026-671 du 27/07/2026'],
  verifieLe: '2026-07-28',
  ...over,
});

const alerte = (regime, over = {}) => ({
  echeance: echeance(),
  regime,
  niveau: regime === 'blocage' ? 'echue' : regime === 'avertissement' ? 'preavis' : 'apaisee',
  joursRestants: regime === 'blocage' ? -12 : 90,
  joursDepuisVerification: regime === 'information' ? 3 : 67,
  reArmementLe: regime === 'information' ? '2026-11-05' : null,
  ...over,
});

test('silence : aucune annotation, aucun résumé, sortie verte — l’alarme ne crie pas pour rien', () => {
  const r = rapport([], 'Veille mentions légales : aucune échéance en préavis ni échue.', '2026-07-28');
  assert.equal(r.regime, 'silence');
  assert.equal(r.code, 0);
  assert.equal(r.annotation, null);
  assert.equal(r.resume, null);
  assert.match(r.journal, /aucune échéance/u);
});

test('ÉTAGE 1 — préavis : annotation ::warning, résumé lisible, et surtout SORTIE 0', () => {
  const r = rapport([alerte('avertissement')], 'message de préavis', '2026-10-03');
  assert.equal(r.regime, 'avertissement');
  assert.equal(
    r.code,
    0,
    'un préavis qui fait échouer la PR est exactement l’alarme permanente qu’on a démontée',
  );
  assert.ok(r.annotation.startsWith(`::warning title=${TITRE_ANNOTATION} — préavis (non bloquant)::`));
  assert.match(r.resume, /\*\*PRÉAVIS\*\* — dans 90 jour\(s\), non bloquant/u);
  assert.match(r.resume, /REDACTIONS_FRANCHISE/u);
  assert.match(r.resume, /Ordonnance n° 2026-671 du 27\/07\/2026/u);
  // Le geste d'apaisement est écrit là où on lit l'alarme, pas seulement dans le code.
  assert.match(r.resume, /mettre `verifieLe`/u);
  assert.match(r.resume, /se ré-arme seule 30 jours/u);
});

test('ÉTAGE 2 — échéance atteinte : annotation ::error et SORTIE 1, sans apaisement possible', () => {
  const r = rapport([alerte('blocage')], 'message bloquant', '2027-01-13');
  assert.equal(r.regime, 'blocage');
  assert.equal(r.code, 1);
  assert.ok(r.annotation.startsWith('::error title='));
  assert.match(r.resume, /\*\*ÉCHUE — BLOQUANT\*\* \(depuis 12 jour\(s\)\)/u);
});

test('apaisée : visible en ::notice avec sa date de ré-armement — un apaisement muet serait un interrupteur', () => {
  const r = rapport([alerte('information')], 'message apaisé', '2026-10-05');
  assert.equal(r.code, 0);
  assert.ok(r.annotation.startsWith('::notice title='));
  assert.match(r.resume, /APAISÉE jusqu’au 2026-11-05/u);
  assert.match(r.resume, /Vérifié le : 2026-07-28 \(il y a 3 jour\(s\)\)/u);
});

test('le régime dominant est le plus fort : un préavis à côté d’une échéance atteinte ne dédramatise rien', () => {
  assert.equal(regimeDominant([alerte('information'), alerte('avertissement')]), 'avertissement');
  assert.equal(regimeDominant([alerte('avertissement'), alerte('blocage')]), 'blocage');
  assert.equal(regimeDominant([alerte('information')]), 'information');
  assert.equal(regimeDominant([]), 'silence');
  assert.equal(rapport([alerte('avertissement'), alerte('blocage')], 'm', '2027-01-01').code, 1);
});

test('échappement des annotations : le geste à faire survit au multiligne (sinon il est tronqué)', () => {
  assert.equal(echapperAnnotation('a\nb'), 'a%0Ab');
  assert.equal(echapperAnnotation('a\r\nb'), 'a%0D%0Ab');
  // Le pourcent doit être échappé EN PREMIER, sinon « %0A » redeviendrait un saut de ligne littéral.
  assert.equal(echapperAnnotation('100 % \n'), '100 %25 %0A');
  const r = rapport([alerte('avertissement')], 'ligne 1\nligne 2', '2026-10-03');
  assert.ok(r.annotation.endsWith('ligne 1%0Aligne 2'));
  assert.ok(!r.annotation.includes('\n'), 'une annotation sur deux lignes n’en est plus une');
});

test('AUCUN interrupteur : le rapporteur ne lit qu’une seule variable d’environnement, et elle n’éteint rien', async () => {
  const source = await readFile(new URL('./veille-mentions-legales-ci.mjs', import.meta.url), 'utf8');
  const variables = [...source.matchAll(/process\.env\.([A-Z0-9_]+)/gu)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(variables)],
    ['GITHUB_STEP_SUMMARY'],
    'toute autre variable d’environnement serait un moyen non tracé de faire taire la veille : '
      + 'le seul apaisement admis est la mise à jour datée de `verifieLe` dans le registre',
  );
  assert.ok(
    !/process\.argv\.(?:includes|slice|indexOf)/u.test(source),
    'aucun drapeau de ligne de commande : un contournement non tracé serait un défaut, pas une option',
  );
});

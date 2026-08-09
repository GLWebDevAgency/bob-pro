import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./content.ts', import.meta.url), 'utf8');
const terms = readFileSync(
  new URL('../../../../../design_handoff_bob_pro/legal/conditions-utilisation.md', import.meta.url),
  'utf8',
).trimEnd();
const prefix = 'export const CONDITIONS_UTILISATION_MD = `';
const start = source.indexOf(prefix);
const end = source.lastIndexOf('`;');

test('la page publique sert exactement les CGU autoritaires', () => {
  assert.notEqual(start, -1);
  assert.ok(end > start);
  assert.equal(source.slice(start + prefix.length, end), terms);
});

test('les CGU décrivent la clôture réellement livrée sans promettre une purge', () => {
  assert.match(terms, /clôturer définitivement votre accès/);
  assert.match(terms, /n'est pas une suppression automatique/);
  assert.match(terms, /aucune purge ou\s+anonymisation complète n'est livrée/);
  assert.match(terms, /\[BLOQUÉ FONDATEUR :/);
  assert.doesNotMatch(terms, /La clôture de votre compte entraîne la suppression/);
});

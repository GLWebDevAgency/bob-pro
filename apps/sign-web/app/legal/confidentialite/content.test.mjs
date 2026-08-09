import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./content.ts', import.meta.url), 'utf8');
const policy = readFileSync(
  new URL('../../../../../design_handoff_bob_pro/legal/politique-confidentialite.md', import.meta.url),
  'utf8',
).trimEnd();
const prefix = 'export const POLITIQUE_CONFIDENTIALITE_MD = `';
const start = source.indexOf(prefix);
const end = source.lastIndexOf('`;');

test('la page publique sert exactement la politique autoritaire', () => {
  assert.notEqual(start, -1);
  assert.ok(end > start);
  assert.equal(source.slice(start + prefix.length, end), policy);
});

test('la notice reste honnête sur les capacités et les blocages de publication', () => {
  assert.match(policy, /\[BLOQUÉ FONDATEUR :/);
  assert.doesNotMatch(policy, /\[EN ATTENTE :/);
  assert.match(policy, /GPT Realtime/);
  assert.match(policy, /Voxtral tour-par-tour V1/);
  assert.match(policy, /ancien binaire compatible peut encore envoyer un enregistrement/);
  assert.match(policy, /Mistral AI[\s\S]*commandes textuelles minimisées/);
  assert.match(policy, /Mistral AI[\s\S]*extraction de documents/);
  assert.match(policy, /n'existe pas encore\s+d'interrupteur global/);
  assert.doesNotMatch(policy, /mode de reconnaissance simplifié/);
  assert.match(policy, /Sentry/);
  assert.match(policy, /EAS Observe/);
  assert.match(policy, /au minimum 60 jours/);
  assert.doesNotMatch(policy, /mesure d'usage \*\*interne\*\*/);
  assert.match(policy, /15 minutes/);
  assert.match(policy, /30 jours/);
  assert.match(policy, /clôture irréversible de l'accès/);
  assert.match(policy, /Aucune anonymisation ou purge complète/);
  assert.doesNotMatch(policy, /tout le reste disparaît/i);
});

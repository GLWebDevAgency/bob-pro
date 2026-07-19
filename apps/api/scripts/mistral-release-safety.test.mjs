import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const MUTATION_FLAGS = Object.freeze([
  'RUN_POSTGRES_MISTRAL_CONVERSATION_MUTATION_CERT',
  'RUN_POSTGRES_MISTRAL_KEY_ROTATION_MUTATION_CERT',
]);

test('une release live refuse puis neutralise les certifications PostgreSQL destructives', async () => {
  const [environmentGate, release] = await Promise.all([
    readFile(new URL('./check-release-env.sh', import.meta.url), 'utf8'),
    readFile(new URL('./release.sh', import.meta.url), 'utf8'),
  ]);

  for (const flag of MUTATION_FLAGS) {
    assert.match(environmentGate, new RegExp(`'${flag}'`, 'u'));
    assert.match(
      release,
      new RegExp(`${flag}=false`, 'u'),
      `${flag} doit être forcé à false à la frontière d’exécution`,
    );
  }
  assert.match(environmentGate, /value !== undefined && value !== 'false'/u);
  assert.match(
    release,
    /RUN_POSTGRES_MISTRAL_CONVERSATION_MUTATION_CERT=false[\s\\]+RUN_POSTGRES_MISTRAL_KEY_ROTATION_MUTATION_CERT=false[\s\\]+DATABASE_URL=/u,
  );
});

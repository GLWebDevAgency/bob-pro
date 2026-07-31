import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const validator = resolve(import.meta.dirname, 'validate-m2a3-railway-transport-evidence.mjs');

async function createHarness(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'bob-m2a3-transport-evidence-test-'));
  const evidence = resolve(root, 'evidence.json');
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return {
    evidence,
    root,
    run(path = evidence) {
      return spawnSync(process.execPath, [validator, path], {
        encoding: 'utf8',
      });
    },
  };
}

function validEvidence(providerFailure = 'decode_response_body_expected_ident') {
  return {
    schemaVersion: 1,
    status: 'failed',
    failureKind: 'railway_control_plane_fetch_unavailable',
    providerFailure,
    attempts: 3,
    childStarted: false,
  };
}

test('une preuve absente est un état honnête sans artefact', async (t) => {
  const harness = await createHarness(t);
  const result = harness.run();

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'present=false\n');
  assert.equal(result.stderr, '');
});

test('accepte uniquement les deux classes Railway fermées', async (t) => {
  for (const providerFailure of [
    'problem_processing_request',
    'decode_response_body_expected_ident',
  ]) {
    await t.test(providerFailure, async (nested) => {
      const harness = await createHarness(nested);
      await writeFile(harness.evidence, `${JSON.stringify(validEvidence(providerFailure))}\n`, {
        mode: 0o600,
      });
      const result = harness.run();

      assert.equal(result.status, 0);
      assert.equal(result.stdout, 'present=true\n');
      assert.equal(result.stderr, '');
    });
  }
});

test('refuse une forme ou une valeur non exacte', async (t) => {
  for (const evidence of [
    { ...validEvidence(), transcript: 'secret' },
    { ...validEvidence(), childStarted: true },
    { ...validEvidence(), attempts: 2 },
    { ...validEvidence(), providerFailure: 'unknown' },
  ]) {
    await t.test(JSON.stringify(evidence), async (nested) => {
      const harness = await createHarness(nested);
      await writeFile(harness.evidence, JSON.stringify(evidence), { mode: 0o600 });
      const result = harness.run();

      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /invalid Railway transport evidence/u);
      assert.doesNotMatch(result.stderr, /secret/u);
    });
  }
});

test('refuse les fichiers surdimensionnés et les liens symboliques', async (t) => {
  const oversized = await createHarness(t);
  await writeFile(oversized.evidence, 'x'.repeat(1_025), { mode: 0o600 });
  assert.equal(oversized.run().status, 1);

  const linked = await createHarness(t);
  const target = resolve(linked.root, 'target.json');
  await writeFile(target, JSON.stringify(validEvidence()), { mode: 0o600 });
  await symlink(target, linked.evidence);
  assert.equal(linked.run().status, 1);
});

test('refuse un appel sans chemin unique', () => {
  for (const args of [[], ['one', 'two']]) {
    const result = spawnSync(process.execPath, [validator, ...args], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /Usage:/u);
  }
});

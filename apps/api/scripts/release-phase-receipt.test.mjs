import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  assertPrivateSecretBindingMatches,
  assertReceiptMatches,
  computeReleaseSurfaceDigest,
  createPrivateSecretBinding,
  createReceipt,
  migrationStateDigest,
  parseDatabaseSnapshot,
  parseReceipt,
  readPrivateSecretBinding,
  readReceipt,
  requiredEnvironment,
  runtimeConfigurationDigest,
  runtimeSecretMaterialDigest,
  writeReceiptAtomically,
} from './release-phase-receipt.mjs';

const SHA = 'a'.repeat(40);
const DIGEST_A = 'b'.repeat(64);
const DIGEST_B = 'c'.repeat(64);
const DIGEST_C = 'd'.repeat(64);
const NOW = new Date('2026-07-28T12:00:00.000Z');
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const context = Object.freeze({
  releaseSha: SHA,
  releaseEnvironment: 'staging',
  runId: '30351623978',
  runAttempt: 1,
  certificationMode: 'nonproduction-full',
});
const databaseSnapshot = Object.freeze({
  systemIdentifier: '7662742571317219726',
  databaseOid: 16_384,
  databaseName: 'postgres',
  capacityMode: 'closed',
  usedSessions: 0,
});

function receipt() {
  return createReceipt({
    context,
    databaseSnapshot,
    migrationDigest: DIGEST_A,
    runtimeDigest: DIGEST_C,
    surfaceDigest: DIGEST_B,
    completedAt: NOW,
  });
}

test('normalise le contexte GitHub et dérive un mode sans fixture pour production', () => {
  assert.deepEqual(
    requiredEnvironment({
      GITHUB_SHA: SHA,
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '2',
      CABINET_RELEASE_ENV: 'staging',
      BOB_RELEASE_EXPECTED_ENV: 'staging',
    }),
    {
      releaseSha: SHA,
      releaseEnvironment: 'staging',
      runId: '42',
      runAttempt: 2,
      certificationMode: 'nonproduction-full',
    },
  );
  assert.equal(
    requiredEnvironment({
      BOB_RELEASE_SHA: SHA,
      BOB_RELEASE_RUN_ID: '43',
      BOB_RELEASE_RUN_ATTEMPT: '1',
      CABINET_RELEASE_ENV: 'production',
      BOB_RELEASE_EXPECTED_ENV: 'production',
    }).certificationMode,
    'production-readonly',
  );
  for (const environment of [
    {},
    {
      GITHUB_SHA: 'main',
      GITHUB_RUN_ID: '1',
      GITHUB_RUN_ATTEMPT: '1',
      CABINET_RELEASE_ENV: 'staging',
      BOB_RELEASE_EXPECTED_ENV: 'staging',
    },
    {
      GITHUB_SHA: SHA,
      GITHUB_RUN_ID: '0',
      GITHUB_RUN_ATTEMPT: '1',
      CABINET_RELEASE_ENV: 'staging',
      BOB_RELEASE_EXPECTED_ENV: 'staging',
    },
    {
      GITHUB_SHA: SHA,
      GITHUB_RUN_ID: '1',
      GITHUB_RUN_ATTEMPT: '0',
      CABINET_RELEASE_ENV: 'staging',
      BOB_RELEASE_EXPECTED_ENV: 'staging',
    },
    {
      GITHUB_SHA: SHA,
      GITHUB_RUN_ID: '1',
      GITHUB_RUN_ATTEMPT: '1',
      CABINET_RELEASE_ENV: 'preview',
      BOB_RELEASE_EXPECTED_ENV: 'preview',
    },
    {
      GITHUB_SHA: SHA,
      GITHUB_RUN_ID: '1',
      GITHUB_RUN_ATTEMPT: '1',
      CABINET_RELEASE_ENV: 'production',
      BOB_RELEASE_EXPECTED_ENV: 'staging',
    },
  ]) {
    assert.throws(() => requiredEnvironment(environment), /release_phase_receipt:/u);
  }
});

test('lie sans les exposer les réglages runtime et les autorités de clés', () => {
  const first = runtimeConfigurationDigest({
    BOB_LIVE_ENABLED: 'true',
    BOB_LIVE_PROVIDER: 'openai',
    BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS: '50',
    BOB_LIVE_MISTRAL_WEBSOCKET_URL: 'wss://mistral.example.test/realtime',
    BOB_LIVE_PROOF_KEYRING: '{"1":"secret-a"}',
    OPENAI_TTS_MODEL: 'gpt-4o-mini-tts-2025-12-15',
    OPENAI_API_KEY: 'provider-secret-a',
    BOB_LIVE_LOCAL_AUDIT_TOKEN: 'audit-secret-a',
    MISTRAL_STT_CONTEXT_BIAS: 'client-confidentiel-a',
    UNRELATED_SETTING: 'ignored-a',
  });
  const same = runtimeConfigurationDigest({
    UNRELATED_SETTING: 'ignored-b',
    OPENAI_API_KEY: 'provider-secret-a',
    BOB_LIVE_PROOF_KEYRING: '{"1":"secret-a"}',
    BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS: '50',
    BOB_LIVE_MISTRAL_WEBSOCKET_URL: 'wss://mistral.example.test/realtime',
    BOB_LIVE_PROVIDER: 'openai',
    BOB_LIVE_ENABLED: 'true',
    BOB_LIVE_LOCAL_AUDIT_TOKEN: 'audit-secret-b',
    MISTRAL_STT_CONTEXT_BIAS: 'client-confidentiel-b',
    OPENAI_TTS_MODEL: 'gpt-4o-mini-tts-2025-12-15',
  });
  assert.equal(first, same);
  assert.notEqual(
    first,
    runtimeConfigurationDigest({
      BOB_LIVE_ENABLED: 'true',
      BOB_LIVE_PROVIDER: 'openai',
      BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS: '51',
      BOB_LIVE_PROOF_KEYRING: '{"1":"secret-a"}',
      OPENAI_API_KEY: 'provider-secret-a',
    }),
  );
  assert.notEqual(
    first,
    runtimeConfigurationDigest({
      BOB_LIVE_ENABLED: 'true',
      BOB_LIVE_PROVIDER: 'openai',
      BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS: '50',
      BOB_LIVE_MISTRAL_WEBSOCKET_URL: 'wss://mistral-alt.example.test/realtime',
      BOB_LIVE_PROOF_KEYRING: '{"1":"secret-a"}',
      OPENAI_TTS_MODEL: 'gpt-4o-mini-tts-2025-12-15',
    }),
  );
  assert.notEqual(
    first,
    runtimeConfigurationDigest({
      BOB_LIVE_ENABLED: 'true',
      BOB_LIVE_PROVIDER: 'openai',
      BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS: '50',
      BOB_LIVE_MISTRAL_WEBSOCKET_URL: 'wss://mistral.example.test/realtime',
      BOB_LIVE_PROOF_KEYRING: '{"1":"secret-a"}',
      OPENAI_TTS_MODEL: 'gpt-4o-mini-tts-next',
    }),
  );
  assert.equal(
    first,
    runtimeConfigurationDigest({
      BOB_LIVE_ENABLED: 'true',
      BOB_LIVE_PROVIDER: 'openai',
      BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS: '50',
      BOB_LIVE_MISTRAL_WEBSOCKET_URL: 'wss://mistral.example.test/realtime',
      BOB_LIVE_PROOF_KEYRING: '{"1":"secret-b"}',
      OPENAI_TTS_MODEL: 'gpt-4o-mini-tts-2025-12-15',
      OPENAI_API_KEY: 'provider-secret-b',
      BOB_LIVE_LOCAL_AUDIT_TOKEN: 'audit-secret-b',
      MISTRAL_STT_CONTEXT_BIAS: 'autre-contexte-confidentiel',
    }),
  );
  assert.notEqual(
    first,
    runtimeConfigurationDigest({
      BOB_LIVE_ENABLED: 'true',
      BOB_LIVE_PROVIDER: 'openai',
      BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS: '50',
      BOB_LIVE_MISTRAL_WEBSOCKET_URL: 'wss://mistral.example.test/realtime',
      BOB_LIVE_PROOF_KEYRING: '{"1":"secret-b","2":"secret-c"}',
      OPENAI_TTS_MODEL: 'gpt-4o-mini-tts-2025-12-15',
      OPENAI_API_KEY: 'provider-secret-a',
    }),
  );
  assert.doesNotMatch(first, /secret/u);
});

test('lie en privé les secrets scalaires et le matériau canonique des keyrings', () => {
  const first = runtimeSecretMaterialDigest({
    BOB_LIVE_USAGE_HMAC_SECRET: 'usage-secret-a',
    BOB_LIVE_CONTROL_ENCRYPTION_SECRET: 'control-secret-a',
    OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET: 'legacy-control-secret-a',
    BOB_LIVE_PROOF_KEYRING: '{"2":"proof-secret-b","1":"proof-secret-a"}',
  });
  assert.equal(
    first,
    runtimeSecretMaterialDigest({
      OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET: 'legacy-control-secret-a',
      BOB_LIVE_CONTROL_ENCRYPTION_SECRET: 'control-secret-a',
      BOB_LIVE_USAGE_HMAC_SECRET: 'usage-secret-a',
      BOB_LIVE_PROOF_KEYRING: '{"1":"proof-secret-a","2":"proof-secret-b"}',
      UNRELATED_SETTING: 'ignored',
    }),
  );
  assert.notEqual(
    first,
    runtimeSecretMaterialDigest({
      BOB_LIVE_USAGE_HMAC_SECRET: 'usage-secret-b',
      BOB_LIVE_CONTROL_ENCRYPTION_SECRET: 'control-secret-a',
      OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET: 'legacy-control-secret-a',
      BOB_LIVE_PROOF_KEYRING: '{"1":"proof-secret-a","2":"proof-secret-b"}',
    }),
  );
  assert.notEqual(
    first,
    runtimeSecretMaterialDigest({
      BOB_LIVE_USAGE_HMAC_SECRET: 'usage-secret-a',
      BOB_LIVE_CONTROL_ENCRYPTION_SECRET: 'control-secret-b',
      OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET: 'legacy-control-secret-a',
      BOB_LIVE_PROOF_KEYRING: '{"1":"proof-secret-a","2":"proof-secret-b"}',
    }),
  );
  assert.notEqual(
    first,
    runtimeSecretMaterialDigest({
      BOB_LIVE_USAGE_HMAC_SECRET: 'usage-secret-a',
      BOB_LIVE_CONTROL_ENCRYPTION_SECRET: 'control-secret-a',
      OPENAI_REALTIME_CONTROL_ENCRYPTION_SECRET: 'legacy-control-secret-a',
      BOB_LIVE_PROOF_KEYRING: '{"1":"proof-secret-rotated","2":"proof-secret-b"}',
    }),
  );
  assert.doesNotMatch(first, /proof-secret|usage-secret|control-secret/u);
  assert.equal('secretMaterialDigest' in receipt(), false);
});

test('la liaison secrète privée est atomique, contextuelle et non publiable', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bob-release-secret-binding-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const path = join(directory, 'binding.json');
  const binding = createPrivateSecretBinding({
    context,
    secretDigest: DIGEST_A,
    completedAt: NOW,
  });
  writeReceiptAtomically(binding, path);
  assert.deepEqual(readPrivateSecretBinding(path), binding);
  assert.equal(
    assertPrivateSecretBindingMatches({
      binding,
      context,
      secretDigest: DIGEST_A,
      now: new Date('2026-07-28T12:30:00.000Z'),
    }),
    binding,
  );
  assert.throws(
    () =>
      assertPrivateSecretBindingMatches({
        binding,
        context,
        secretDigest: DIGEST_B,
        now: new Date('2026-07-28T12:30:00.000Z'),
      }),
    /release_phase_receipt:private_binding_secret_material_drift/u,
  );
});

test('les preuves privées ne peuvent entrer ni dans l’upload Railway ni dans l’image', () => {
  for (const ignoreFile of ['.dockerignore', '.railwayignore']) {
    const source = readFileSync(resolve(REPOSITORY_ROOT, ignoreFile), 'utf8');
    assert.match(source, /^\.release-evidence$/mu);
    assert.match(source, /^\.release-evidence-private$/mu);
  }
  const workflow = readFileSync(
    resolve(REPOSITORY_ROOT, '.github/workflows/railway-api.yml'),
    'utf8',
  );
  assert.match(workflow, /path: \.release-evidence\/api\/predeploy-receipt\.json/u);
  assert.doesNotMatch(workflow, /path: \.release-evidence\/api\/\s*$/mu);
});

test('parse strictement la cible PostgreSQL fermée', () => {
  assert.deepEqual(parseDatabaseSnapshot(JSON.stringify(databaseSnapshot)), databaseSnapshot);
  for (const candidate of [
    '',
    '{}',
    JSON.stringify({ ...databaseSnapshot, capacityMode: 'active' }),
    JSON.stringify({ ...databaseSnapshot, usedSessions: -1 }),
    JSON.stringify({ ...databaseSnapshot, unexpected: true }),
  ]) {
    assert.throws(
      () => parseDatabaseSnapshot(candidate),
      /release_phase_receipt:database_snapshot/u,
    );
  }
});

test('le digest de migrations est canonique et refuse toute ligne ambiguë', () => {
  const first = `20260701000000_alpha|${DIGEST_A}`;
  const second = `20260702000000_beta|${DIGEST_B}`;
  assert.equal(
    migrationStateDigest(`${first}\n${second}\n`),
    migrationStateDigest(`${second}\n${first}\n`),
  );
  for (const raw of ['', `${first}\n${first}\n`, 'migration|checksum\n']) {
    assert.throws(() => migrationStateDigest(raw), /release_phase_receipt:migration_state/u);
  }
});

test('le reçu JSON refuse les champs inconnus, les modes incohérents et les tailles non bornées', () => {
  const valid = receipt();
  assert.deepEqual(parseReceipt(JSON.stringify(valid)), valid);
  assert.throws(
    () => parseReceipt(JSON.stringify({ ...valid, unknown: true })),
    /release_phase_receipt:receipt_shape_invalid/u,
  );
  assert.throws(
    () => parseReceipt(JSON.stringify({ ...valid, certificationMode: 'production-readonly' })),
    /release_phase_receipt:receipt_mode_invalid/u,
  );
  assert.throws(
    () => parseReceipt(`{"padding":"${'x'.repeat(9_000)}"}`),
    /release_phase_receipt:receipt_too_large/u,
  );
});

test('la vérification lie SHA, run, environnement, base, digests, capacité et fraîcheur', () => {
  const valid = receipt();
  assert.equal(
    assertReceiptMatches({
      receipt: valid,
      context,
      databaseSnapshot,
      migrationDigest: DIGEST_A,
      runtimeDigest: DIGEST_C,
      surfaceDigest: DIGEST_B,
      now: new Date('2026-07-28T12:30:00.000Z'),
    }),
    valid,
  );
  const base = {
    receipt: valid,
    context,
    databaseSnapshot,
    migrationDigest: DIGEST_A,
    runtimeDigest: DIGEST_C,
    surfaceDigest: DIGEST_B,
    now: new Date('2026-07-28T12:30:00.000Z'),
  };
  assert.throws(
    () => assertReceiptMatches({ ...base, context: { ...context, releaseSha: 'd'.repeat(40) } }),
    /release_phase_receipt:receipt_context_mismatch/u,
  );
  assert.throws(
    () =>
      assertReceiptMatches({
        ...base,
        databaseSnapshot: { ...databaseSnapshot, systemIdentifier: '8662742571317219726' },
      }),
    /release_phase_receipt:receipt_database_mismatch/u,
  );
  assert.throws(
    () =>
      assertReceiptMatches({
        ...base,
        databaseSnapshot: { ...databaseSnapshot, capacityMode: 'active' },
      }),
    /release_phase_receipt:receipt_capacity_not_closed/u,
  );
  assert.throws(
    () => assertReceiptMatches({ ...base, migrationDigest: 'd'.repeat(64) }),
    /release_phase_receipt:receipt_migration_drift/u,
  );
  assert.throws(
    () => assertReceiptMatches({ ...base, runtimeDigest: 'e'.repeat(64) }),
    /release_phase_receipt:receipt_runtime_configuration_drift/u,
  );
  assert.throws(
    () => assertReceiptMatches({ ...base, surfaceDigest: 'd'.repeat(64) }),
    /release_phase_receipt:receipt_surface_drift/u,
  );
  assert.throws(
    () => assertReceiptMatches({ ...base, now: new Date('2026-07-29T00:00:00.000Z') }),
    /release_phase_receipt:receipt_expired/u,
  );
});

test('l’écriture est atomique, privée et la lecture refuse un lien symbolique', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bob-release-receipt-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const path = join(directory, 'receipt.json');
  writeReceiptAtomically(receipt(), path);
  assert.equal(lstatSync(path).mode & 0o077, 0);
  assert.deepEqual(readReceipt(path), receipt());
  assert.equal(readFileSync(path, 'utf8').endsWith('\n'), true);

  const target = join(directory, 'target.json');
  const link = join(directory, 'link.json');
  writeFileSync(target, `${JSON.stringify(receipt())}\n`, { mode: 0o600 });
  symlinkSync(target, link);
  assert.throws(() => readReceipt(link), /release_phase_receipt:receipt_file_unsafe/u);
  assert.throws(
    () => readReceipt(join(directory, 'missing.json')),
    /release_phase_receipt:receipt_missing/u,
  );
});

test('le digest des surfaces de release est déterministe et non vide', () => {
  const first = computeReleaseSurfaceDigest();
  const second = computeReleaseSurfaceDigest();
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(first, second);
});

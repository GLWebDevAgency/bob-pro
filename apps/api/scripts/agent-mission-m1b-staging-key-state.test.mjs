import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  M1B_STAGING_KEY_STATE_SQL,
  assertM1BStagingKeyState,
  certifyM1BStagingKeyState,
  decodeM1BStagingKeyRows,
  parseM1BStagingKeyStateEnvironment,
} from './agent-mission-m1b-staging-key-state.mjs';

const FIRST = Buffer.alloc(32, 21).toString('base64url');
const SECOND = Buffer.alloc(32, 22).toString('base64url');
const DOMAIN = Buffer.from('bob.agent-mission.fingerprint-hmac-key.v1\0', 'utf8');

function fingerprint(secret) {
  return createHash('sha256')
    .update(DOMAIN)
    .update(Buffer.from(secret, 'base64url'))
    .digest('hex');
}

function environment(overrides = {}) {
  return {
    DIRECT_URL: 'postgresql://postgres.staging:secret@db.example.test/postgres',
    BOB_LIVE_ENABLED: 'true',
    BOB_LIVE_PROVIDER: 'openai',
    BOB_M1B_STAGING_HMAC_KEY_VERSION: '1',
    BOB_M1B_STAGING_HMAC_KEYRING: JSON.stringify({ 1: FIRST }),
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    keyVersion: 1,
    keyFingerprint: fingerprint(FIRST),
    retained: false,
    minimumWriterVersion: 1,
    highestWriterVersion: 1,
    writerEnabled: false,
    ...overrides,
  };
}

test('résout le keyring staging stable et refuse un saut ou une troisième version', () => {
  const parsed = parseM1BStagingKeyStateEnvironment(environment());
  assert.equal(parsed.currentVersion, 1);
  assert.equal(parsed.bindings[0].fingerprint, fingerprint(FIRST));
  assert.throws(
    () => parseM1BStagingKeyStateEnvironment(environment({
      BOB_M1B_STAGING_HMAC_KEY_VERSION: '3',
      BOB_M1B_STAGING_HMAC_KEYRING: JSON.stringify({
        1: FIRST,
        2: SECOND,
        3: Buffer.alloc(32, 23).toString('base64url'),
      }),
    })),
    /only the current version and optional predecessor/u,
  );
});

test('préflight autorise seulement un keyspace vierge version 1 ou un floor désarmé exact', () => {
  const config = parseM1BStagingKeyStateEnvironment(environment());
  const pristine = decodeM1BStagingKeyRows([row({
    keyFingerprint: null,
    minimumWriterVersion: null,
    highestWriterVersion: null,
    writerEnabled: null,
  })]);
  assert.deepEqual(assertM1BStagingKeyState('preflight', pristine, config), {
    mode: 'preflight',
    passed: true,
    keyVersion: 1,
    writerEnabled: null,
    pristine: true,
  });
  assert.deepEqual(assertM1BStagingKeyState('preflight', [row()], config), {
    mode: 'preflight',
    passed: true,
    keyVersion: 1,
    writerEnabled: false,
    pristine: false,
  });
  assert.throws(
    () => assertM1BStagingKeyState('preflight', [row({
      writerEnabled: true,
    })], config),
    /writer fence is not disabled/u,
  );
});

test('état actif/off exige le même binding et interdit tout floor de rotation', () => {
  const config = parseM1BStagingKeyStateEnvironment(environment());
  assert.deepEqual(
    assertM1BStagingKeyState('active', [row({ writerEnabled: true })], config),
    {
      mode: 'active',
      passed: true,
      keyVersion: 1,
      writerEnabled: true,
      pristine: false,
    },
  );
  assert.deepEqual(assertM1BStagingKeyState('off', [row()], config), {
    mode: 'off',
    passed: true,
    keyVersion: 1,
    writerEnabled: false,
    pristine: false,
  });
  assert.throws(
    () => assertM1BStagingKeyState('active', [row({
      minimumWriterVersion: 1,
      highestWriterVersion: 2,
      writerEnabled: true,
    })], config),
    /refuses every key rotation/u,
  );
  assert.throws(
    () => assertM1BStagingKeyState('off', [row({
      keyFingerprint: fingerprint(SECOND),
    })], config),
    /does not match/u,
  );
});

test('une version N peut conserver uniquement son prédécesseur retenu et couvert', () => {
  const config = parseM1BStagingKeyStateEnvironment(environment({
    BOB_M1B_STAGING_HMAC_KEY_VERSION: '2',
    BOB_M1B_STAGING_HMAC_KEYRING: JSON.stringify({ 1: FIRST, 2: SECOND }),
  }));
  const rows = decodeM1BStagingKeyRows([
    row({
      retained: true,
      minimumWriterVersion: 2,
      highestWriterVersion: 2,
    }),
    row({
      keyVersion: 2,
      keyFingerprint: fingerprint(SECOND),
      minimumWriterVersion: 2,
      highestWriterVersion: 2,
    }),
  ]);
  assert.equal(assertM1BStagingKeyState('off', rows, config).keyVersion, 2);
  assert.throws(
    () => assertM1BStagingKeyState('off', [
      ...rows,
      row({
        keyVersion: 3,
        keyFingerprint: null,
        retained: true,
        minimumWriterVersion: 2,
        highestWriterVersion: 2,
      }),
    ], config),
    /does not cover every retained/u,
  );
});

test('certification utilise la fonction readiness sous rôle dédié sans exposer le secret', () => {
  const calls = [];
  const result = certifyM1BStagingKeyState('off', environment(), {
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return {
        status: 0,
        stdout: `${JSON.stringify([row()])}\n`,
        stderr: '',
      };
    },
  });
  assert.equal(result.passed, true);
  assert.equal(calls[0].command, 'psql');
  assert.equal(calls[0].options.input, M1B_STAGING_KEY_STATE_SQL);
  assert.equal(calls[0].options.input.includes(FIRST), false);
  assert.equal(calls[0].args.includes('versions_csv=1'), true);
});

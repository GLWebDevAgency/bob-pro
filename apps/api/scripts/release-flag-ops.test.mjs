import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseReleaseFlagArgs,
  runReleaseFlagOperation,
  sqlForReleaseFlagOperation,
  validateCabinetPilotActivation,
} from './release-flag-ops.mjs';

test('parse une opération de ciblage auditée et stricte', () => {
  assert.deepEqual(parseReleaseFlagArgs([
    'set-subject', '--key', 'cabinet.slice0', '--environment', 'staging', '--enabled', 'true',
    '--subject-type', 'cabinet', '--subject-id', 'cabinet-pilot', '--actor', 'release@example.test',
    '--reason', 'Pilote validé par le cabinet',
  ]), {
    operation: 'set-subject',
    key: 'cabinet.slice0',
    environment: 'staging',
    enabled: 'true',
    subjectType: 'cabinet',
    subjectId: 'cabinet-pilot',
    actor: 'release@example.test',
    reason: 'Pilote validé par le cabinet',
    expectedVersion: undefined,
  });
});

test('refuse options inconnues, booléens ambigus et raisons trop courtes', () => {
  assert.throws(() => parseReleaseFlagArgs([
    'set-global', '--key', 'cabinet.slice0', '--environment', 'production', '--enabled', 'yes',
    '--actor', 'ops', '--reason', 'go',
  ]));
  assert.throws(() => parseReleaseFlagArgs([
    'set-global', '--key', 'cabinet.slice0', '--environment', 'production', '--enabled', 'true',
    '--actor', 'ops', '--reason', 'raison valide', '--unknown', 'value',
  ]));
});

test('chaque mutation verrouille, versionne et journalise dans une transaction', () => {
  for (const operation of ['set-global', 'set-kill-switch', 'set-subject', 'remove-subject']) {
    const sql = sqlForReleaseFlagOperation(operation);
    assert.match(sql, /BEGIN;/);
    assert.match(sql, /FOR UPDATE/);
    assert.match(sql, /release_flag_audit_events/);
    assert.match(sql, /COMMIT;/);
  }
});

test('ne transmet pas DIRECT_URL dans stdin et échoue fermé sans résultat', () => {
  const calls = [];
  const base = {
    operation: 'set-global', key: 'cabinet.slice0', environment: 'production', enabled: 'false',
    actor: 'ops', reason: 'Arrêt de sécurité',
  };
  assert.throws(() => runReleaseFlagOperation(base, {
    directUrl: 'postgresql://postgres:secret@db.example.test/postgres',
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: '', stderr: '' };
    },
  }), /target was not found/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.input.includes('secret'), false);
  assert.equal(calls[0].options.input.includes('FOR UPDATE'), true);
});

test('bloque toute activation live sans couverture explicite du worker', () => {
  const base = {
    operation: 'set-subject', key: 'cabinet.slice0', environment: 'production', enabled: 'true',
    subjectType: 'cabinet', subjectId: 'cabinet-pilot', actor: 'ops', reason: 'Activation pilote',
  };
  assert.throws(() => validateCabinetPilotActivation(base, {
    CABINET_INVITATION_WORKER_ENABLED: 'false', JOB_CABINET_IDS: '',
  }), /requires the invitation worker/);
  assert.doesNotThrow(() => validateCabinetPilotActivation(base, {
    CABINET_INVITATION_WORKER_ENABLED: 'true',
    CABINET_INVITATION_WORKER_USER_ID: '79e27b85-d458-445e-a759-e8b1a49e1641',
    JOB_CABINET_IDS: 'cabinet-pilot',
  }));
  assert.throws(() => validateCabinetPilotActivation({ ...base, operation: 'set-global' }, {}), /globally enabled/);
});

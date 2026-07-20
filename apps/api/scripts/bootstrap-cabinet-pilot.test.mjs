import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePilotArgs, PILOT_BOOTSTRAP_SQL, validatePilotEnvironment } from './bootstrap-cabinet-pilot.mjs';

const cabinetId = '11111111-1111-4111-8111-111111111111';
const founderId = '22222222-2222-4222-8222-222222222222';
const workerId = '33333333-3333-4333-8333-333333333333';

test('valide un bootstrap pilote strict', () => {
  const input = parsePilotArgs([
    '--cabinet-id', cabinetId, '--name', 'Cabinet Pilote', '--founder-user-id', founderId,
    '--worker-user-id', workerId, '--environment', 'staging', '--expected-flag-version', '1',
    '--actor', 'ops@example.test', '--reason', 'Pilote approuvé',
  ]);
  assert.equal(input.timeZone, 'Europe/Paris');
  assert.doesNotThrow(() => validatePilotEnvironment(input, {
    CABINET_INVITATION_WORKER_ENABLED: 'true',
    CABINET_INVITATION_WORKER_USER_ID: workerId,
    JOB_CABINET_IDS: cabinetId,
  }));
});

test('refuse un bootstrap non couvert par le worker', () => {
  const input = parsePilotArgs([
    '--cabinet-id', cabinetId, '--name', 'Cabinet Pilote', '--founder-user-id', founderId,
    '--worker-user-id', workerId, '--environment', 'production', '--expected-flag-version', '1',
    '--actor', 'ops', '--reason', 'Pilote approuvé',
  ]);
  assert.throws(() => validatePilotEnvironment(input, {
    CABINET_INVITATION_WORKER_ENABLED: 'true',
    CABINET_INVITATION_WORKER_USER_ID: workerId,
    JOB_CABINET_IDS: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }));
});

test('la transaction provisionne tenant, deux admins, audit et override ensemble', () => {
  assert.match(PILOT_BOOTSTRAP_SQL, /BEGIN;/);
  assert.match(PILOT_BOOTSTRAP_SQL, /cabinet_members/);
  assert.match(PILOT_BOOTSTRAP_SQL, /cabinet_admin_guards/);
  assert.match(PILOT_BOOTSTRAP_SQL, /release_flag_audit_events/);
  assert.match(PILOT_BOOTSTRAP_SQL, /COMMIT;/);
});

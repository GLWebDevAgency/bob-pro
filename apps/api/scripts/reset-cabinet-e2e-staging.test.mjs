import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseResetArgs,
  RESET_CABINET_E2E_SQL,
  RESET_CONFIRMATION,
  resetCabinetE2EStaging,
  validateResetEnvironment,
} from './reset-cabinet-e2e-staging.mjs';

const cabinetId = '11111111-1111-4111-8111-111111111111';
const founderUserId = '22222222-2222-4222-8222-222222222222';
const collaboratorUserId = '33333333-3333-4333-8333-333333333333';
const adminUserId = '44444444-4444-4444-8444-444444444444';
const collaboratorEmail = 'cabinet-e2e@example.test';

const validArgs = [
  '--cabinet-id', cabinetId,
  '--founder-user-id', founderUserId,
  '--collaborator-user-id', collaboratorUserId,
  '--admin-user-id', adminUserId,
  '--collaborator-email', collaboratorEmail,
  '--confirm', RESET_CONFIRMATION,
];

test('parse les identités staging avec une confirmation littérale', () => {
  assert.deepEqual(parseResetArgs(validArgs), {
    cabinetId,
    founderUserId,
    collaboratorUserId,
    adminUserId,
    collaboratorEmail,
  });
  assert.doesNotThrow(() => parseResetArgs([
    ...validArgs.slice(0, 6), '--admin-user-id', founderUserId, ...validArgs.slice(8),
  ]));
});

test('refuse UUID, email, options et confirmation ambigus', () => {
  assert.throws(() => parseResetArgs(validArgs.with(1, 'not-a-uuid')), /cabinet-id/);
  assert.throws(() => parseResetArgs(validArgs.with(9, 'Cabinet-E2E@example.test')), /normalized ASCII email/);
  assert.throws(() => parseResetArgs(validArgs.with(11, 'yes')), /--confirm must be exactly/);
  assert.throws(() => parseResetArgs([...validArgs, '--cabinet-id', cabinetId]), /duplicate option/);
  assert.throws(() => parseResetArgs([...validArgs, '--force', 'true']), /unknown option/);
  assert.throws(() => parseResetArgs(validArgs.with(5, founderUserId)), /collaborator identity/);
});

test('refuse tout environnement hors staging et exige la couverture JOB_CABINET_IDS', () => {
  const input = parseResetArgs(validArgs);
  assert.throws(() => validateResetEnvironment(input, {
    CABINET_RELEASE_ENV: 'production',
    JOB_CABINET_IDS: cabinetId,
  }), /must be staging/);
  assert.throws(() => validateResetEnvironment(input, {
    CABINET_RELEASE_ENV: 'staging',
    JOB_CABINET_IDS: founderUserId,
  }), /must be listed/);
  assert.throws(() => validateResetEnvironment(input, {
    CABINET_RELEASE_ENV: 'staging',
    JOB_CABINET_IDS: `${cabinetId},${cabinetId}`,
  }), /must not contain duplicates/);
  assert.doesNotThrow(() => validateResetEnvironment(input, {
    CABINET_RELEASE_ENV: 'staging',
    JOB_CABINET_IDS: `${founderUserId}, ${cabinetId}`,
  }));
});

test('le SQL est transactionnel, verrouillé et borné au collaborateur E2E', () => {
  assert.match(RESET_CABINET_E2E_SQL, /BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE/);
  assert.match(RESET_CABINET_E2E_SQL, /pg_advisory_xact_lock/);
  assert.match(RESET_CABINET_E2E_SQL, /cabinet\.name LIKE 'E2E STAGING%'/);
  assert.match(RESET_CABINET_E2E_SQL, /cabinet\."createdByUserId" = :'founder_user_id'/);
  assert.match(RESET_CABINET_E2E_SQL, /member\.role = 'collaborator'/);
  assert.match(RESET_CABINET_E2E_SQL, /invitation\."acceptedByUserId" <> :'collaborator_user_id'/);
  assert.match(RESET_CABINET_E2E_SQL, /count\(\*\) <= 10 FROM e2e_reset_audits/);
  assert.match(RESET_CABINET_E2E_SQL, /ON DELETE CASCADE/);

  const auditDelete = RESET_CABINET_E2E_SQL.indexOf('DELETE FROM public.cabinet_audit_events');
  const membershipDelete = RESET_CABINET_E2E_SQL.indexOf('DELETE FROM public.cabinet_members');
  const invitationDelete = RESET_CABINET_E2E_SQL.indexOf('DELETE FROM public.cabinet_invitations');
  assert.ok(auditDelete > 0 && auditDelete < membershipDelete && membershipDelete < invitationDelete);
  assert.doesNotMatch(RESET_CABINET_E2E_SQL, /DELETE FROM public\.(?:cabinets|release_flags|release_flag_subjects|cabinet_admin_guards)/);
});

test('utilise psql privilégié et ne retourne que le compte total', () => {
  const input = parseResetArgs(validArgs);
  const calls = [];
  const affected = resetCabinetE2EStaging(input, {
    environment: { CABINET_RELEASE_ENV: 'staging', JOB_CABINET_IDS: cabinetId },
    directUrl: 'postgresql://postgres:secret@db.example.test/postgres',
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: '4\n', stderr: '' };
    },
  });
  assert.equal(affected, 4);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'psql');
  assert.equal(calls[0].options.input, RESET_CABINET_E2E_SQL);
  assert.equal(calls[0].options.input.includes('secret'), false);
  assert.throws(() => resetCabinetE2EStaging(input, {
    environment: { CABINET_RELEASE_ENV: 'staging', JOB_CABINET_IDS: cabinetId },
    directUrl: 'postgresql://runtime:secret@db.example.test/postgres',
    spawnSync: () => ({ status: 0, stdout: '0\n', stderr: '' }),
  }), /privileged postgres role/);
});

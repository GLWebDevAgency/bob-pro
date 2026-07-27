import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildM1BStagingReport,
  writeM1BStagingReport,
} from './agent-mission-m1b-staging-report.mjs';

const SHA = 'a'.repeat(40);
const BASELINE = '11111111-1111-4111-8111-111111111111';
const ACTIVE = '22222222-2222-4222-8222-222222222222';
const OFF = '33333333-3333-4333-8333-333333333333';

function environment(overrides = {}) {
  return {
    BOB_M1B_RELEASE_SHA: SHA,
    BOB_M1B_WORKFLOW_RUN_ID: '123456789',
    BOB_M1B_WORKFLOW_RUN_ATTEMPT: '2',
    BOB_M1B_STARTED_AT: '2026-07-27T12:00:00.000Z',
    BOB_M1B_FINISHED_AT: '2026-07-27T12:30:00.000Z',
    BOB_M1B_BASELINE_DEPLOYMENT_ID: BASELINE,
    BOB_M1B_ACTIVE_DEPLOYMENT_ID: ACTIVE,
    BOB_M1B_OFF_DEPLOYMENT_ID: OFF,
    BOB_M1B_CERTIFY_RESULT: 'success',
    BOB_M1B_CLEANUP_RESULT: 'success',
    BOB_M1B_VARIABLES_OWNED: 'true',
    BOB_M1B_OVERRIDE_OWNED: 'true',
    BOB_M1B_VARIABLES_REMOVED: 'true',
    BOB_M1B_OVERRIDE_REMOVED: 'true',
    ...overrides,
  };
}

test('rapport borné contient les preuves opérationnelles sans identité utilisateur', () => {
  const report = buildM1BStagingReport(environment());
  assert.equal(report.releaseSha, SHA);
  assert.equal(report.deployments.active, ACTIVE);
  assert.equal(report.workflowRun.actorReference, 'github-actions-run:123456789');
  assert.deepEqual(report.cleanupMutations, {
    variablesRemoved: true,
    overrideRemoved: true,
  });
  assert.deepEqual(report.dataPolicy, {
    containsRawUserId: false,
    containsRawCompanyId: false,
    containsEmail: false,
    containsTokenSecretOrSdp: false,
  });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('m1b-staging@bob.test'), false);
  assert.equal(serialized.includes('BOB_M1B_STAGING_USER_ID'), false);
});

test('accepte un deployment OFF non créé lorsque le circuit a échoué avant mutation', () => {
  const report = buildM1BStagingReport(environment({
    BOB_M1B_OFF_DEPLOYMENT_ID: 'not-created',
    BOB_M1B_CERTIFY_RESULT: 'failure',
    BOB_M1B_VARIABLES_OWNED: 'false',
    BOB_M1B_OVERRIDE_OWNED: 'false',
    BOB_M1B_VARIABLES_REMOVED: 'false',
    BOB_M1B_OVERRIDE_REMOVED: 'false',
  }));
  assert.equal(report.deployments.off, null);
  assert.equal(report.jobs.certify, 'failure');
});

test('refuse les temps, résultats et identifiants de déploiement non canoniques', () => {
  assert.throws(
    () => buildM1BStagingReport(environment({
      BOB_M1B_FINISHED_AT: '2026-07-27T11:59:59.000Z',
    })),
    /cannot precede/u,
  );
  assert.throws(
    () => buildM1BStagingReport(environment({
      BOB_M1B_CLEANUP_RESULT: '',
    })),
    /CLEANUP_RESULT/u,
  );
  assert.throws(
    () => buildM1BStagingReport(environment({
      BOB_M1B_ACTIVE_DEPLOYMENT_ID: 'latest',
    })),
    /deployment UUID/u,
  );
});

test('écrit uniquement dans le répertoire d’évidence dédié avec permissions bornées', () => {
  const calls = [];
  const report = writeM1BStagingReport(
    `.release-evidence/agent-mission-m1b/${SHA}.json`,
    environment(),
    {
      cwd: '/tmp/bob-report-test',
      mkdirSync: (...args) => calls.push(['mkdir', ...args]),
      writeFileSync: (...args) => calls.push(['write', ...args]),
    },
  );
  assert.equal(report.schemaVersion, 1);
  assert.equal(calls[0][0], 'mkdir');
  assert.equal(calls[1][0], 'write');
  assert.equal(calls[1][3].mode, 0o600);
  assert.throws(
    () => writeM1BStagingReport('../report.json', environment()),
    /release-evidence/u,
  );
});

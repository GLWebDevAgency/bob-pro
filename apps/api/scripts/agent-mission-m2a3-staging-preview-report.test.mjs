import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildM2A3StagingPreviewReport,
  validateM2A3StagingPreviewReport,
} from './agent-mission-m2a3-staging-preview-report.mjs';

const SHA = 'a'.repeat(40);
const DEPLOYMENT_ID = '123e4567-e89b-42d3-a456-426614174000';
const SOURCE_DEPLOYMENT_ID = '223e4567-e89b-42d3-a456-426614174000';
const SERVICE_ID = '33333333-3333-4333-8333-333333333333';
const DECISION_DIGEST = 'd'.repeat(64);
const REPORT_CLI = fileURLToPath(
  new URL('./agent-mission-m2a3-staging-preview-report.mjs', import.meta.url),
);

function flagReceipt(command, m2aVersion) {
  const canary = command === 'assert-canary';
  const active = command === 'assert-active';
  return JSON.stringify({
    schema: 'bob.agent-mission.m2a3.staging-preview-flag-observation',
    version: 1,
    command,
    state: canary ? 'canary' : active ? 'active' : 'off',
    changed: false,
    observed: {
      m2a: {
        version: m2aVersion,
        enabled: active,
        killSwitch: false,
        subjectCount: canary ? 1 : 0,
        enabledSubjectCount: canary ? 1 : 0,
      },
      legacyV1: {
        version: 4,
        enabled: false,
        killSwitch: false,
        subjectCount: 0,
        enabledSubjectCount: 0,
      },
    },
  });
}

function activeSmoke() {
  return JSON.stringify({
    mode: 'preview-v2',
    passed: true,
    protocolVersion: 2,
    speechDelivery: 'audited-signed-url-v1',
    bootstrapReceipt: 'acknowledged',
    mutation: 'none',
    cleanup: 'complete',
    hangupAccepted: true,
    bootstrapAttempts: 1,
    recoveredTimeout: false,
  });
}

function offSmoke() {
  return JSON.stringify({
    mode: 'preview-v2-off',
    passed: true,
    protocolVersion: 2,
    agentMission: 'off',
    cleanup: 'complete',
    hangupAccepted: true,
    bootstrapAttempts: 1,
    recoveredTimeout: false,
  });
}

function environment(overrides = {}) {
  const mode = overrides.BOB_M2A3_PREVIEW_MODE ?? 'activate';
  const active = mode === 'activate';
  return {
    BOB_M2A3_PREVIEW_MODE: mode,
    BOB_M2A3_PREVIEW_RELEASE_SHA: SHA,
    BOB_M2A3_PREVIEW_NORMAL_RELEASE_RUN_ID: active ? '123450000' : '',
    BOB_M2A3_PREVIEW_RUN_ID: '123456789',
    BOB_M2A3_PREVIEW_RUN_ATTEMPT: '2',
    BOB_M2A3_PREVIEW_DEPLOYMENT_ID: DEPLOYMENT_ID,
    BOB_M2A3_PREVIEW_STARTED_AT: '2026-07-31T12:00:00.000Z',
    BOB_M2A3_PREVIEW_FINISHED_AT: '2026-07-31T12:04:00.000Z',
    BOB_M2A3_PREVIEW_RUNTIME_OBSERVATION: active
      ? 'agent-mission-m1b-staging-railway:ok:assert-active:active:run-123456789'
      : 'agent-mission-m1b-staging-railway:ok:assert-off:off',
    BOB_M2A3_STAGING_FOUNDER_AUTH_DATE: active ? '2026-07-31' : '',
    BOB_M2A3_STAGING_FOUNDER_AUTH_CHANNEL: active ? 'conversation-codex' : '',
    BOB_M2A3_STAGING_FOUNDER_AUTH_REF: active ? 'decision:M2A3-20260731#founder' : '',
    BOB_M2A3_STAGING_CLAUDE_COUNTERSIGN_REF: active ? 'decision:M2A3-20260731#claude' : '',
    BOB_M2A3_STAGING_GPT_COUNTERSIGN_REF: active ? 'decision:M2A3-20260731#gpt' : '',
    BOB_M2A3_PREVIEW_DECISION_DOCUMENT_SHA256: active ? DECISION_DIGEST : '',
    BOB_M2A3_PREVIEW_CONTROL_SHA: SHA,
    BOB_M2A3_PREVIEW_SOURCE_DEPLOYMENT_ID: SOURCE_DEPLOYMENT_ID,
    BOB_M2A3_PREVIEW_SOURCE_RELEASE_SHA: SHA,
    BOB_M2A3_PREVIEW_SOURCE_RUNTIME_STATE: active ? '' : 'active-owned',
    BOB_M2A3_PREVIEW_SOURCE_OWNED_RELEASE_SHA: active ? '' : SHA,
    BOB_M2A3_PREVIEW_DEPLOYMENT_ACTION: active ? '' : 'exact-source-rebuild',
    BOB_M2A3_PREVIEW_FLAG_OBSERVATION: flagReceipt(
      active ? 'assert-active' : 'assert-off',
      active ? 9 : 10,
    ),
    BOB_M2A3_PREVIEW_KEY_OBSERVATION: `agent-mission-m1b-staging-key-state:ok:${active ? 'active' : 'off'}:v1:writer-${active ? 'true' : 'false'}`,
    BOB_M2A3_PREVIEW_TOPOLOGY_OBSERVATION: `railway-single-replica-ok:staging:${SERVICE_ID}`,
    BOB_M2A3_PREVIEW_READINESS_OBSERVATION: `agent-mission-m1b-staging-readiness:ok:staging:${SHA}`,
    BOB_M2A3_PREVIEW_SMOKE_OBSERVATION: active ? activeSmoke() : offSmoke(),
    BOB_M2A3_PREVIEW_CANARY_FLAG_OBSERVATION: active ? flagReceipt('assert-canary', 7) : '',
    BOB_M2A3_PREVIEW_CANARY_SMOKE_OBSERVATION: active ? activeSmoke() : '',
    ...overrides,
  };
}

test('construit une preuve globale staging V2 depuis les observations live exactes', () => {
  const report = buildM2A3StagingPreviewReport(environment());
  assert.deepEqual(report, {
    schema: 'bob.agent-mission.m2a3.staging-preview-evidence',
    version: 3,
    environment: 'staging',
    mode: 'activate',
    status: 'active',
    releaseSha: SHA,
    normalStagingReleaseRunId: '123450000',
    githubRunId: '123456789',
    githubRunAttempt: 2,
    deploymentId: DEPLOYMENT_ID,
    governance: {
      decisionId: 'M2A3_STAGING_PREVIEW_GLOBAL_ON',
      authority: 'founder-and-dual-agent',
      authorizationDate: '2026-07-31',
      channel: 'conversation-codex',
      founderRef: 'decision:M2A3-20260731#founder',
      claudeCountersignRef: 'decision:M2A3-20260731#claude',
      gptCountersignRef: 'decision:M2A3-20260731#gpt',
      decisionDocumentSha256: DECISION_DIGEST,
    },
    deactivation: null,
    runtimeMasters: { legacyV1: 'on', m2a: 'on' },
    runtimeActivationRunId: '123456789',
    m2aFlag: {
      version: 9,
      enabled: true,
      killSwitch: false,
      subjectCount: 0,
      enabledSubjectCount: 0,
    },
    legacyV1Flag: {
      version: 4,
      enabled: false,
      killSwitch: false,
      subjectCount: 0,
      enabledSubjectCount: 0,
    },
    keyState: { version: 1, writerEnabled: true },
    topology: 'single-replica',
    readiness: 'exact-sha',
    protocolVersion: 2,
    canary: { status: 'passed-before-global', flagVersion: 7, cleanup: 'complete' },
    finalSmoke: {
      mode: 'preview-v2',
      passed: true,
      cleanup: 'complete',
      outcome: 'read-only-no-mutation',
    },
    startedAt: '2026-07-31T12:00:00.000Z',
    finishedAt: '2026-07-31T12:04:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(report), /email|password|keyring|userId/iu);
  assert.equal(validateM2A3StagingPreviewReport(report, SHA), report);
});

test('construit la preuve OFF uniquement depuis une désactivation live vérifiée', () => {
  const report = buildM2A3StagingPreviewReport(
    environment({ BOB_M2A3_PREVIEW_MODE: 'deactivate' }),
  );
  assert.equal(report.status, 'off');
  assert.deepEqual(report.runtimeMasters, { legacyV1: 'off', m2a: 'off' });
  assert.equal(report.m2aFlag.enabled, false);
  assert.equal(report.legacyV1Flag.enabled, false);
  assert.equal(report.keyState.writerEnabled, false);
  assert.equal(report.canary.status, 'not-applicable');
  assert.equal(report.normalStagingReleaseRunId, null);
  assert.deepEqual(report.governance, {
    decisionId: 'M2A3_STAGING_PREVIEW_GLOBAL_OFF_FAIL_SAFE',
    authority: 'fail-safe-control-plane',
    authorizationDate: null,
    channel: null,
    founderRef: null,
    claudeCountersignRef: null,
    gptCountersignRef: null,
    decisionDocumentSha256: null,
  });
  assert.equal(report.runtimeActivationRunId, null);
  assert.deepEqual(report.deactivation, {
    controlSha: SHA,
    sourceDeploymentId: SOURCE_DEPLOYMENT_ID,
    sourceReleaseSha: SHA,
    sourceRuntimeState: 'active-owned',
    sourceOwnedReleaseSha: SHA,
    deploymentAction: 'exact-source-rebuild',
  });
  assert.equal(validateM2A3StagingPreviewReport(report, SHA), report);
  const rollbackReport = buildM2A3StagingPreviewReport(
    environment({
      BOB_M2A3_PREVIEW_MODE: 'deactivate',
      BOB_M2A3_PREVIEW_DEPLOYMENT_ACTION: 'captured-baseline-source-rebuild',
    }),
  );
  assert.equal(rollbackReport.deactivation.deploymentAction, 'captured-baseline-source-rebuild');
  assert.equal(validateM2A3StagingPreviewReport(rollbackReport, SHA), rollbackReport);
  for (const historicalAction of ['exact-serving-redeploy', 'captured-baseline-redeploy']) {
    const historicalReport = structuredClone(report);
    historicalReport.deactivation.deploymentAction = historicalAction;
    assert.equal(validateM2A3StagingPreviewReport(historicalReport, SHA), historicalReport);
    assert.throws(
      () =>
        buildM2A3StagingPreviewReport(
          environment({
            BOB_M2A3_PREVIEW_MODE: 'deactivate',
            BOB_M2A3_PREVIEW_DEPLOYMENT_ACTION: historicalAction,
          }),
        ),
      /deactivation source provenance is invalid/u,
    );
  }
});

test('refuse le mauvais SHA, les temps non canoniques et toute clé supplémentaire', () => {
  assert.throws(
    () =>
      buildM2A3StagingPreviewReport(environment({ BOB_M2A3_PREVIEW_RELEASE_SHA: 'A'.repeat(40) })),
    /release SHA must be exact/u,
  );
  assert.throws(
    () =>
      buildM2A3StagingPreviewReport(
        environment({ BOB_M2A3_PREVIEW_STARTED_AT: '2026-07-31T12:00:00Z' }),
      ),
    /canonical ISO instant/u,
  );
  assert.throws(
    () =>
      buildM2A3StagingPreviewReport(
        environment({ BOB_M2A3_STAGING_FOUNDER_AUTH_DATE: '2026-02-31' }),
      ),
    /authorization date is invalid/u,
  );
  const report = buildM2A3StagingPreviewReport(environment());
  assert.throws(
    () => validateM2A3StagingPreviewReport({ ...report, userId: 'forbidden' }, SHA),
    /not an exact non-PII/u,
  );
  assert.throws(
    () =>
      validateM2A3StagingPreviewReport(
        {
          ...report,
          governance: { ...report.governance, authorizationDate: '2026-02-31' },
        },
        SHA,
      ),
    /not an exact non-PII/u,
  );
});

test('refuse les observations maquillées et une séquence de versions non consécutive', () => {
  for (const mutation of [
    { BOB_M2A3_PREVIEW_RUNTIME_OBSERVATION: 'agent-mission-m1b-staging-railway:ok:assert-off:off' },
    {
      BOB_M2A3_PREVIEW_RUNTIME_OBSERVATION:
        'agent-mission-m1b-staging-railway:ok:assert-active:active:run-987654321',
    },
    { BOB_M2A3_PREVIEW_DECISION_DOCUMENT_SHA256: 'e'.repeat(63) },
    {
      BOB_M2A3_STAGING_CLAUDE_COUNTERSIGN_REF: 'decision:M2A3-20260731#founder',
    },
    { BOB_M2A3_PREVIEW_FLAG_OBSERVATION: flagReceipt('assert-off', 9) },
    { BOB_M2A3_PREVIEW_CANARY_FLAG_OBSERVATION: flagReceipt('assert-canary', 6) },
    {
      BOB_M2A3_PREVIEW_KEY_OBSERVATION:
        'agent-mission-m1b-staging-key-state:ok:active:v1:writer-false',
    },
    { BOB_M2A3_PREVIEW_SMOKE_OBSERVATION: offSmoke() },
  ]) {
    assert.throws(
      () => buildM2A3StagingPreviewReport(environment(mutation)),
      /agent-mission-m2a3-staging-preview-report/u,
    );
  }
  const report = buildM2A3StagingPreviewReport(environment());
  assert.throws(
    () =>
      validateM2A3StagingPreviewReport(
        {
          ...report,
          governance: { ...report.governance, decisionDocumentSha256: 'f'.repeat(63) },
        },
        SHA,
      ),
    /not an exact non-PII/u,
  );
  assert.throws(
    () =>
      buildM2A3StagingPreviewReport(
        environment({
          BOB_M2A3_PREVIEW_MODE: 'deactivate',
          BOB_M2A3_PREVIEW_SOURCE_OWNED_RELEASE_SHA: 'b'.repeat(40),
        }),
      ),
    /owner provenance/u,
  );
});

test('le CLI écrit en 0600 puis relit la preuve bornée', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bob-m2a3-preview-report-'));
  const file = join(directory, 'receipt.json');
  try {
    const write = spawnSync(process.execPath, [REPORT_CLI, 'write', file], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment() },
      encoding: 'utf8',
    });
    assert.equal(write.status, 0, write.stderr);
    assert.equal(
      validateM2A3StagingPreviewReport(readFileSync(file, 'utf8'), SHA).status,
      'active',
    );
    const verify = spawnSync(process.execPath, [REPORT_CLI, 'verify', file], {
      cwd: process.cwd(),
      env: { ...process.env, ...environment() },
      encoding: 'utf8',
    });
    assert.equal(verify.status, 0, verify.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

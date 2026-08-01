#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,19}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const REPORT_KEYS = Object.freeze([
  'schema',
  'version',
  'environment',
  'mode',
  'status',
  'releaseSha',
  'normalStagingReleaseRunId',
  'githubRunId',
  'githubRunAttempt',
  'deploymentId',
  'governance',
  'deactivation',
  'runtimeMasters',
  'runtimeActivationRunId',
  'm2aFlag',
  'legacyV1Flag',
  'keyState',
  'topology',
  'readiness',
  'protocolVersion',
  'canary',
  'finalSmoke',
  'startedAt',
  'finishedAt',
]);
const GOVERNANCE_KEYS = Object.freeze([
  'decisionId',
  'authority',
  'authorizationDate',
  'channel',
  'founderRef',
  'claudeCountersignRef',
  'gptCountersignRef',
  'decisionDocumentSha256',
]);
const DEACTIVATION_KEYS = Object.freeze([
  'controlSha',
  'sourceDeploymentId',
  'sourceReleaseSha',
  'sourceRuntimeState',
  'sourceOwnedReleaseSha',
  'deploymentAction',
]);
const FLAG_KEYS = Object.freeze([
  'version',
  'enabled',
  'killSwitch',
  'subjectCount',
  'enabledSubjectCount',
]);

function fail(message) {
  throw new Error(`agent-mission-m2a3-staging-preview-report:${message}`);
}

function required(environment, name, maximum = 4_096) {
  const value = environment[name];
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${name} is missing or invalid`);
  }
  return value;
}

function instant(value, name) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail(`${name} must be a canonical ISO instant`);
  }
  return value;
}

function canonicalDate(value) {
  return (
    typeof value === 'string' &&
    DATE.test(value) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
  );
}

function exactObject(value, keys) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function parseJsonReceipt(environment, name) {
  try {
    return JSON.parse(required(environment, name));
  } catch {
    fail(`${name} must be canonical JSON`);
  }
}

function positiveVersion(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${name} is invalid`);
  return value;
}

function parseFlagObservation(environment, name, command) {
  const receipt = parseJsonReceipt(environment, name);
  const expectedState =
    command === 'assert-active' ? 'active' : command === 'assert-canary' ? 'canary' : 'off';
  if (
    !exactObject(receipt, ['schema', 'version', 'command', 'state', 'changed', 'observed']) ||
    receipt.schema !== 'bob.agent-mission.m2a3.staging-preview-flag-observation' ||
    receipt.version !== 1 ||
    receipt.command !== command ||
    receipt.state !== expectedState ||
    receipt.changed !== false ||
    !exactObject(receipt.observed, ['m2a', 'legacyV1']) ||
    !exactObject(receipt.observed.m2a, FLAG_KEYS) ||
    !exactObject(receipt.observed.legacyV1, FLAG_KEYS)
  ) {
    fail(`${name} is not an exact flag observation`);
  }
  const m2a = receipt.observed.m2a;
  const legacyV1 = receipt.observed.legacyV1;
  positiveVersion(m2a.version, `${name}.m2a.version`);
  positiveVersion(legacyV1.version, `${name}.legacyV1.version`);
  for (const flag of [m2a, legacyV1]) {
    if (
      typeof flag.enabled !== 'boolean' ||
      typeof flag.killSwitch !== 'boolean' ||
      !Number.isSafeInteger(flag.subjectCount) ||
      flag.subjectCount < 0 ||
      !Number.isSafeInteger(flag.enabledSubjectCount) ||
      flag.enabledSubjectCount < 0 ||
      flag.enabledSubjectCount > flag.subjectCount
    ) {
      fail(`${name} contains an invalid flag state`);
    }
  }
  if (
    legacyV1.enabled ||
    legacyV1.killSwitch ||
    legacyV1.subjectCount !== 0 ||
    legacyV1.enabledSubjectCount !== 0
  ) {
    fail(`${name} did not prove legacy V1 dormant`);
  }
  if (command === 'assert-canary') {
    if (m2a.enabled || m2a.killSwitch || m2a.subjectCount !== 1 || m2a.enabledSubjectCount !== 1) {
      fail(`${name} did not prove the unique M2-A canary`);
    }
  } else if (
    m2a.enabled !== (command === 'assert-active') ||
    m2a.killSwitch ||
    m2a.subjectCount !== 0 ||
    m2a.enabledSubjectCount !== 0
  ) {
    fail(`${name} did not prove the exact global M2-A state`);
  }
  return Object.freeze({
    m2a: Object.freeze({ ...m2a }),
    legacyV1: Object.freeze({ ...legacyV1 }),
  });
}

function parseRuntimeObservation(environment, mode, githubRunId) {
  const expected = mode === 'activate' ? 'active' : 'off';
  const receipt = required(environment, 'BOB_M2A3_PREVIEW_RUNTIME_OBSERVATION', 200);
  const expectedReceipt =
    mode === 'activate'
      ? `agent-mission-m1b-staging-railway:ok:assert-active:active:run-${githubRunId}`
      : 'agent-mission-m1b-staging-railway:ok:assert-off:off';
  if (receipt !== expectedReceipt) {
    fail('runtime observation does not match the requested live state');
  }
  return Object.freeze({
    masters: Object.freeze({
      legacyV1: expected === 'active' ? 'on' : 'off',
      m2a: expected === 'active' ? 'on' : 'off',
    }),
    activationRunId: mode === 'activate' ? githubRunId : null,
  });
}

function parseGovernance(environment, active) {
  if (!active) {
    return Object.freeze({
      decisionId: 'M2A3_STAGING_PREVIEW_GLOBAL_OFF_FAIL_SAFE',
      authority: 'fail-safe-control-plane',
      authorizationDate: null,
      channel: null,
      founderRef: null,
      claudeCountersignRef: null,
      gptCountersignRef: null,
      decisionDocumentSha256: null,
    });
  }
  const authorizationDate = required(environment, 'BOB_M2A3_STAGING_FOUNDER_AUTH_DATE', 10);
  if (!canonicalDate(authorizationDate)) {
    fail('founder authorization date is invalid');
  }
  const decisionDocumentSha256 = required(
    environment,
    'BOB_M2A3_PREVIEW_DECISION_DOCUMENT_SHA256',
    64,
  );
  if (!DIGEST.test(decisionDocumentSha256)) fail('decision document digest is invalid');
  const founderRef = required(environment, 'BOB_M2A3_STAGING_FOUNDER_AUTH_REF', 200);
  const claudeCountersignRef = required(
    environment,
    'BOB_M2A3_STAGING_CLAUDE_COUNTERSIGN_REF',
    200,
  );
  const gptCountersignRef = required(environment, 'BOB_M2A3_STAGING_GPT_COUNTERSIGN_REF', 200);
  if (new Set([founderRef, claudeCountersignRef, gptCountersignRef]).size !== 3) {
    fail('governance references must be distinct');
  }
  return Object.freeze({
    decisionId: 'M2A3_STAGING_PREVIEW_GLOBAL_ON',
    authority: 'founder-and-dual-agent',
    authorizationDate,
    channel: required(environment, 'BOB_M2A3_STAGING_FOUNDER_AUTH_CHANNEL', 100),
    founderRef,
    claudeCountersignRef,
    gptCountersignRef,
    decisionDocumentSha256,
  });
}

function parseDeactivation(environment, active, releaseSha, deploymentId) {
  if (active) return null;
  const controlSha = required(environment, 'BOB_M2A3_PREVIEW_CONTROL_SHA', 40);
  const sourceDeploymentId = required(environment, 'BOB_M2A3_PREVIEW_SOURCE_DEPLOYMENT_ID', 80);
  const sourceReleaseSha = required(environment, 'BOB_M2A3_PREVIEW_SOURCE_RELEASE_SHA', 40);
  const sourceRuntimeState = required(environment, 'BOB_M2A3_PREVIEW_SOURCE_RUNTIME_STATE', 32);
  const deploymentAction = required(environment, 'BOB_M2A3_PREVIEW_DEPLOYMENT_ACTION', 40);
  if (
    !SHA.test(controlSha) ||
    !UUID.test(sourceDeploymentId) ||
    sourceDeploymentId === deploymentId ||
    sourceReleaseSha !== releaseSha ||
    !SHA.test(sourceReleaseSha) ||
    !['active-owned', 'already-off'].includes(sourceRuntimeState) ||
    !['captured-baseline-source-rebuild', 'exact-source-rebuild'].includes(deploymentAction)
  ) {
    fail('deactivation source provenance is invalid');
  }
  const rawOwnedReleaseSha = environment.BOB_M2A3_PREVIEW_SOURCE_OWNED_RELEASE_SHA ?? '';
  const sourceOwnedReleaseSha = rawOwnedReleaseSha === '' ? null : rawOwnedReleaseSha;
  if (
    (sourceRuntimeState === 'active-owned' && sourceOwnedReleaseSha !== releaseSha) ||
    (sourceRuntimeState === 'already-off' && sourceOwnedReleaseSha !== null)
  ) {
    fail('deactivation owner provenance does not match the served release');
  }
  return Object.freeze({
    controlSha,
    sourceDeploymentId,
    sourceReleaseSha,
    sourceRuntimeState,
    sourceOwnedReleaseSha,
    deploymentAction,
  });
}

function parseKeyObservation(environment, mode) {
  const expectedMode = mode === 'activate' ? 'active' : 'off';
  const expectedWriter = mode === 'activate' ? 'true' : 'false';
  const receipt = required(environment, 'BOB_M2A3_PREVIEW_KEY_OBSERVATION', 200);
  const match =
    /^agent-mission-m1b-staging-key-state:ok:(active|off):v([1-9][0-9]*):writer-(true|false)$/u.exec(
      receipt,
    );
  if (match === null || match[1] !== expectedMode || match[3] !== expectedWriter) {
    fail('key observation does not match the requested live state');
  }
  return Object.freeze({
    version: positiveVersion(Number(match[2]), 'key version'),
    writerEnabled: expectedWriter === 'true',
  });
}

function parseReadinessObservation(environment, releaseSha) {
  const receipt = required(environment, 'BOB_M2A3_PREVIEW_READINESS_OBSERVATION', 200);
  if (receipt !== `agent-mission-m1b-staging-readiness:ok:staging:${releaseSha}`) {
    fail('readiness observation does not bind the exact staging SHA');
  }
  return 'exact-sha';
}

function parseTopologyObservation(environment) {
  const receipt = required(environment, 'BOB_M2A3_PREVIEW_TOPOLOGY_OBSERVATION', 200);
  const expectedServiceId = required(environment, 'RAILWAY_API_SERVICE_ID', 36);
  if (!UUID.test(expectedServiceId) || expectedServiceId !== expectedServiceId.toLowerCase()) {
    fail('configured Railway service id is invalid');
  }
  const match = /^railway-single-replica-ok:staging:([0-9a-f-]{36})$/u.exec(receipt);
  if (match === null || !UUID.test(match[1]) || match[1] !== expectedServiceId)
    fail('topology observation is not single-replica staging');
  return 'single-replica';
}

function parseSmokeObservation(environment, name, expectedMode) {
  const receipt = parseJsonReceipt(environment, name);
  const active = expectedMode === 'preview-v2';
  const keys = active
    ? [
        'mode',
        'passed',
        'protocolVersion',
        'speechDelivery',
        'bootstrapReceipt',
        'mutation',
        'cleanup',
        'hangupAccepted',
        'bootstrapAttempts',
        'recoveredTimeout',
      ]
    : [
        'mode',
        'passed',
        'protocolVersion',
        'agentMission',
        'cleanup',
        'hangupAccepted',
        'bootstrapAttempts',
        'recoveredTimeout',
      ];
  if (
    !exactObject(receipt, keys) ||
    receipt.mode !== expectedMode ||
    receipt.passed !== true ||
    receipt.protocolVersion !== 2 ||
    receipt.cleanup !== 'complete' ||
    typeof receipt.hangupAccepted !== 'boolean' ||
    !Number.isSafeInteger(receipt.bootstrapAttempts) ||
    receipt.bootstrapAttempts < 1 ||
    receipt.bootstrapAttempts > 2 ||
    typeof receipt.recoveredTimeout !== 'boolean' ||
    (active &&
      (receipt.speechDelivery !== 'audited-signed-url-v1' ||
        receipt.bootstrapReceipt !== 'acknowledged' ||
        receipt.mutation !== 'none')) ||
    (!active && receipt.agentMission !== 'off')
  ) {
    fail(`${name} is not an exact authenticated WebRTC observation`);
  }
  return Object.freeze({
    mode: receipt.mode,
    passed: true,
    cleanup: 'complete',
    outcome: active ? 'read-only-no-mutation' : 'capability-refused',
  });
}

export function buildM2A3StagingPreviewReport(environment = process.env) {
  const mode = required(environment, 'BOB_M2A3_PREVIEW_MODE', 16);
  if (mode !== 'activate' && mode !== 'deactivate') fail('mode must be activate or deactivate');
  const releaseSha = required(environment, 'BOB_M2A3_PREVIEW_RELEASE_SHA', 40);
  if (!SHA.test(releaseSha)) fail('release SHA must be exact');
  const runId = required(environment, 'BOB_M2A3_PREVIEW_RUN_ID', 20);
  const runAttempt = required(environment, 'BOB_M2A3_PREVIEW_RUN_ATTEMPT', 10);
  if (!POSITIVE_INTEGER.test(runId) || !POSITIVE_INTEGER.test(runAttempt)) {
    fail('GitHub run identity must be positive integers');
  }
  const deploymentId = required(environment, 'BOB_M2A3_PREVIEW_DEPLOYMENT_ID', 80);
  if (!UUID.test(deploymentId)) fail('deployment ID must be a UUID');
  const startedAt = instant(required(environment, 'BOB_M2A3_PREVIEW_STARTED_AT', 40), 'startedAt');
  const finishedAt = instant(
    required(environment, 'BOB_M2A3_PREVIEW_FINISHED_AT', 40),
    'finishedAt',
  );
  if (Date.parse(finishedAt) < Date.parse(startedAt)) fail('report time range is reversed');

  const active = mode === 'activate';
  const normalReleaseRunId = active
    ? required(environment, 'BOB_M2A3_PREVIEW_NORMAL_RELEASE_RUN_ID', 20)
    : null;
  if (normalReleaseRunId !== null && !POSITIVE_INTEGER.test(normalReleaseRunId)) {
    fail('normal staging release run id must be a positive integer');
  }
  const flag = parseFlagObservation(
    environment,
    'BOB_M2A3_PREVIEW_FLAG_OBSERVATION',
    active ? 'assert-active' : 'assert-off',
  );
  const runtime = parseRuntimeObservation(environment, mode, runId);
  const finalSmoke = parseSmokeObservation(
    environment,
    'BOB_M2A3_PREVIEW_SMOKE_OBSERVATION',
    active ? 'preview-v2' : 'preview-v2-off',
  );
  let canary;
  if (active) {
    const canaryFlag = parseFlagObservation(
      environment,
      'BOB_M2A3_PREVIEW_CANARY_FLAG_OBSERVATION',
      'assert-canary',
    );
    parseSmokeObservation(environment, 'BOB_M2A3_PREVIEW_CANARY_SMOKE_OBSERVATION', 'preview-v2');
    if (flag.m2a.version !== canaryFlag.m2a.version + 2) {
      fail('the canary removal and global activation versions are not consecutive');
    }
    canary = Object.freeze({
      status: 'passed-before-global',
      flagVersion: canaryFlag.m2a.version,
      cleanup: 'complete',
    });
  } else {
    canary = Object.freeze({ status: 'not-applicable', flagVersion: null, cleanup: 'complete' });
  }

  return Object.freeze({
    schema: 'bob.agent-mission.m2a3.staging-preview-evidence',
    version: 3,
    environment: 'staging',
    mode,
    status: active ? 'active' : 'off',
    releaseSha,
    normalStagingReleaseRunId: normalReleaseRunId,
    githubRunId: runId,
    githubRunAttempt: Number(runAttempt),
    deploymentId,
    governance: parseGovernance(environment, active),
    deactivation: parseDeactivation(environment, active, releaseSha, deploymentId),
    runtimeMasters: runtime.masters,
    runtimeActivationRunId: runtime.activationRunId,
    m2aFlag: flag.m2a,
    legacyV1Flag: flag.legacyV1,
    keyState: parseKeyObservation(environment, mode),
    topology: parseTopologyObservation(environment),
    readiness: parseReadinessObservation(environment, releaseSha),
    protocolVersion: 2,
    canary,
    finalSmoke,
    startedAt,
    finishedAt,
  });
}

export function validateM2A3StagingPreviewReport(value, expectedSha) {
  const report = typeof value === 'string' ? JSON.parse(value) : value;
  const active = report?.mode === 'activate';
  if (
    !exactObject(report, REPORT_KEYS) ||
    report.schema !== 'bob.agent-mission.m2a3.staging-preview-evidence' ||
    report.version !== 3 ||
    report.environment !== 'staging' ||
    !['activate', 'deactivate'].includes(report.mode) ||
    report.status !== (active ? 'active' : 'off') ||
    report.releaseSha !== expectedSha ||
    !SHA.test(report.releaseSha ?? '') ||
    (active
      ? !POSITIVE_INTEGER.test(report.normalStagingReleaseRunId ?? '')
      : report.normalStagingReleaseRunId !== null) ||
    !POSITIVE_INTEGER.test(report.githubRunId ?? '') ||
    !Number.isSafeInteger(report.githubRunAttempt) ||
    report.githubRunAttempt < 1 ||
    !UUID.test(report.deploymentId ?? '') ||
    !exactObject(report.governance, GOVERNANCE_KEYS) ||
    report.governance.decisionId !==
      (active ? 'M2A3_STAGING_PREVIEW_GLOBAL_ON' : 'M2A3_STAGING_PREVIEW_GLOBAL_OFF_FAIL_SAFE') ||
    report.governance.authority !==
      (active ? 'founder-and-dual-agent' : 'fail-safe-control-plane') ||
    (active
      ? !canonicalDate(report.governance.authorizationDate) ||
        typeof report.governance.channel !== 'string' ||
        report.governance.channel.length < 1 ||
        typeof report.governance.founderRef !== 'string' ||
        typeof report.governance.claudeCountersignRef !== 'string' ||
        typeof report.governance.gptCountersignRef !== 'string' ||
        new Set([
          report.governance.founderRef,
          report.governance.claudeCountersignRef,
          report.governance.gptCountersignRef,
        ]).size !== 3 ||
        !DIGEST.test(report.governance.decisionDocumentSha256 ?? '')
      : report.governance.authorizationDate !== null ||
        report.governance.channel !== null ||
        report.governance.founderRef !== null ||
        report.governance.claudeCountersignRef !== null ||
        report.governance.gptCountersignRef !== null ||
        report.governance.decisionDocumentSha256 !== null) ||
    (active
      ? report.deactivation !== null
      : !exactObject(report.deactivation, DEACTIVATION_KEYS) ||
        !SHA.test(report.deactivation.controlSha ?? '') ||
        !UUID.test(report.deactivation.sourceDeploymentId ?? '') ||
        report.deactivation.sourceDeploymentId === report.deploymentId ||
        report.deactivation.sourceReleaseSha !== report.releaseSha ||
        !['active-owned', 'already-off'].includes(report.deactivation.sourceRuntimeState) ||
        (report.deactivation.sourceRuntimeState === 'active-owned'
          ? report.deactivation.sourceOwnedReleaseSha !== report.releaseSha
          : report.deactivation.sourceOwnedReleaseSha !== null) ||
        ![
          'captured-baseline-redeploy',
          'exact-serving-redeploy',
          'captured-baseline-source-rebuild',
          'exact-source-rebuild',
        ].includes(report.deactivation.deploymentAction)) ||
    !exactObject(report.runtimeMasters, ['legacyV1', 'm2a']) ||
    report.runtimeMasters.legacyV1 !== (active ? 'on' : 'off') ||
    report.runtimeMasters.m2a !== (active ? 'on' : 'off') ||
    report.runtimeActivationRunId !== (active ? report.githubRunId : null) ||
    !exactObject(report.m2aFlag, FLAG_KEYS) ||
    !exactObject(report.legacyV1Flag, FLAG_KEYS) ||
    !Number.isSafeInteger(report.m2aFlag.version) ||
    report.m2aFlag.version < 1 ||
    !Number.isSafeInteger(report.legacyV1Flag.version) ||
    report.legacyV1Flag.version < 1 ||
    report.m2aFlag.enabled !== active ||
    report.m2aFlag.killSwitch !== false ||
    report.m2aFlag.subjectCount !== 0 ||
    report.m2aFlag.enabledSubjectCount !== 0 ||
    report.legacyV1Flag.enabled !== false ||
    report.legacyV1Flag.killSwitch !== false ||
    report.legacyV1Flag.subjectCount !== 0 ||
    report.legacyV1Flag.enabledSubjectCount !== 0 ||
    !exactObject(report.keyState, ['version', 'writerEnabled']) ||
    !Number.isSafeInteger(report.keyState.version) ||
    report.keyState.version < 1 ||
    report.keyState.writerEnabled !== active ||
    report.topology !== 'single-replica' ||
    report.readiness !== 'exact-sha' ||
    report.protocolVersion !== 2 ||
    !exactObject(report.canary, ['status', 'flagVersion', 'cleanup']) ||
    report.canary.status !== (active ? 'passed-before-global' : 'not-applicable') ||
    (active
      ? !Number.isSafeInteger(report.canary.flagVersion) ||
        report.m2aFlag.version !== report.canary.flagVersion + 2
      : report.canary.flagVersion !== null) ||
    report.canary.cleanup !== 'complete' ||
    !exactObject(report.finalSmoke, ['mode', 'passed', 'cleanup', 'outcome']) ||
    report.finalSmoke.mode !== (active ? 'preview-v2' : 'preview-v2-off') ||
    report.finalSmoke.passed !== true ||
    report.finalSmoke.cleanup !== 'complete' ||
    report.finalSmoke.outcome !== (active ? 'read-only-no-mutation' : 'capability-refused') ||
    !Number.isFinite(Date.parse(report.startedAt ?? '')) ||
    new Date(Date.parse(report.startedAt ?? '')).toISOString() !== report.startedAt ||
    !Number.isFinite(Date.parse(report.finishedAt ?? '')) ||
    new Date(Date.parse(report.finishedAt ?? '')).toISOString() !== report.finishedAt ||
    Date.parse(report.finishedAt) < Date.parse(report.startedAt)
  ) {
    fail('evidence is not an exact non-PII staging preview receipt');
  }
  return report;
}

function main() {
  const [command, file] = process.argv.slice(2);
  if (typeof file !== 'string' || file.length < 1 || file.length > 4_096) {
    fail('an evidence path is required');
  }
  if (command === 'write') {
    const report = buildM2A3StagingPreviewReport();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    validateM2A3StagingPreviewReport(report, report.releaseSha);
    process.stdout.write('agent-mission-m2a3-staging-preview-report:ok:written\n');
    return;
  }
  if (command === 'verify') {
    const expectedSha = required(process.env, 'BOB_M2A3_PREVIEW_RELEASE_SHA', 40);
    validateM2A3StagingPreviewReport(readFileSync(file, 'utf8'), expectedSha);
    process.stdout.write('agent-mission-m2a3-staging-preview-report:ok:verified\n');
    return;
  }
  fail('command must be write or verify');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'agent-mission-m2a3-staging-preview-report:unknown error'}\n`,
    );
    process.exitCode = 1;
  }
}

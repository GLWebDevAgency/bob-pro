#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const JOB_RESULT = new Set(['success', 'failure', 'cancelled', 'skipped']);

function fail(message) {
  throw new Error(`agent-mission-m1b-staging-report:${message}`);
}

function required(environment, name, maximum = 200) {
  const value = environment[name];
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(`${name} is missing or invalid`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!/^[1-9][0-9]{0,18}$/u.test(value)) fail(`${name} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${name} is invalid`);
  return parsed;
}

function instant(value, name) {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    fail(`${name} must be a canonical ISO instant`);
  }
  return value;
}

function deployment(value, name) {
  if (value === 'not-created') return null;
  if (!UUID.test(value)) fail(`${name} must be a deployment UUID or not-created`);
  return value.toLowerCase();
}

function result(value, name) {
  if (!JOB_RESULT.has(value)) fail(`${name} is invalid`);
  return value;
}

function boolean(value, name) {
  if (value !== 'true' && value !== 'false') fail(`${name} is invalid`);
  return value === 'true';
}

function optionalDuration(value, name) {
  if (value === 'not-measured') return null;
  const milliseconds = positiveInteger(value, name);
  if (milliseconds > 600_000) fail(`${name} exceeds the bounded window`);
  return milliseconds;
}

export function buildM1BStagingReport(environment = process.env) {
  const releaseSha = required(environment, 'BOB_M1B_RELEASE_SHA', 40);
  if (!SHA.test(releaseSha)) fail('BOB_M1B_RELEASE_SHA must be lowercase 40-hex');
  const startedAt = instant(required(environment, 'BOB_M1B_STARTED_AT', 40), 'startedAt');
  const finishedAt = instant(
    required(environment, 'BOB_M1B_FINISHED_AT', 40),
    'finishedAt',
  );
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    fail('finishedAt cannot precede startedAt');
  }
  const certifyResult = result(
    required(environment, 'BOB_M1B_CERTIFY_RESULT'),
    'certifyResult',
  );
  const baselineDeploymentId = deployment(
    required(environment, 'BOB_M1B_BASELINE_DEPLOYMENT_ID'),
    'baselineDeploymentId',
  );
  const baselineDeploymentAcknowledged = boolean(
    required(environment, 'BOB_M1B_BASELINE_DEPLOYMENT_ACKNOWLEDGED'),
    'baselineDeploymentAcknowledged',
  );
  const whisperDeploymentId = deployment(
    required(environment, 'BOB_M1B_WHISPER_DEPLOYMENT_ID'),
    'whisperDeploymentId',
  );
  const acousticReadinessMs = optionalDuration(
    required(environment, 'BOB_M1B_ACOUSTIC_READINESS_MS'),
    'acousticReadinessMs',
  );
  if (
    certifyResult === 'success'
    && (
      !baselineDeploymentAcknowledged ||
      whisperDeploymentId === null ||
      acousticReadinessMs === null
    )
  ) {
    fail(
      'successful certification requires baseline ACK, Whisper deployment and acoustic readiness evidence',
    );
  }
  if (baselineDeploymentAcknowledged && baselineDeploymentId === null) {
    fail('baseline deployment ACK requires its exact deployment ID');
  }
  return Object.freeze({
    schemaVersion: 3,
    objective: 'O4.M1-B',
    environment: 'staging',
    releaseSha,
    workflowRun: {
      id: positiveInteger(required(environment, 'BOB_M1B_WORKFLOW_RUN_ID'), 'workflowRun.id'),
      attempt: positiveInteger(
        required(environment, 'BOB_M1B_WORKFLOW_RUN_ATTEMPT'),
        'workflowRun.attempt',
      ),
      actorReference: `github-actions-run:${required(
        environment,
        'BOB_M1B_WORKFLOW_RUN_ID',
      )}`,
    },
    startedAt,
    finishedAt,
    deployments: {
      baseline: baselineDeploymentId,
      baselineAcknowledged: baselineDeploymentAcknowledged,
      active: deployment(
        required(environment, 'BOB_M1B_ACTIVE_DEPLOYMENT_ID'),
        'activeDeploymentId',
      ),
      whisper: whisperDeploymentId,
      off: deployment(
        required(environment, 'BOB_M1B_OFF_DEPLOYMENT_ID'),
        'offDeploymentId',
      ),
    },
    jobs: {
      certify: certifyResult,
      cleanup: result(required(environment, 'BOB_M1B_CLEANUP_RESULT'), 'cleanupResult'),
    },
    speechAudit: {
      verdict: certifyResult === 'success' ? 'ready' : 'not_proven',
      activeReadinessMilliseconds: acousticReadinessMs,
      engine: {
        id: 'whisper.cpp',
        version: 'v1.9.1',
        sourceSha256:
          '147267177eef7b22ec3d2476dd514d1b12e160e176230b740e3d1bd600118447',
      },
      model: {
        id: 'whisper-large-v3-turbo',
        sha256:
          '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
      },
    },
    ownership: {
      variables: boolean(
        required(environment, 'BOB_M1B_VARIABLES_OWNED'),
        'variablesOwned',
      ),
      override: boolean(
        required(environment, 'BOB_M1B_OVERRIDE_OWNED'),
        'overrideOwned',
      ),
    },
    cleanupMutations: {
      variablesRemoved: boolean(
        required(environment, 'BOB_M1B_VARIABLES_REMOVED'),
        'variablesRemoved',
      ),
      overrideRemoved: boolean(
        required(environment, 'BOB_M1B_OVERRIDE_REMOVED'),
        'overrideRemoved',
      ),
    },
    dataPolicy: {
      containsRawUserId: false,
      containsRawCompanyId: false,
      containsEmail: false,
      containsTokenSecretOrSdp: false,
      containsAudioOrTranscript: false,
      containsSignedUrl: false,
    },
  });
}

export function writeM1BStagingReport(
  outputPath,
  environment = process.env,
  dependencies = {},
) {
  if (
    typeof outputPath !== 'string'
    || !outputPath.startsWith('.release-evidence/agent-mission-m1b/')
    || !outputPath.endsWith('.json')
    || outputPath.includes('..')
  ) {
    fail('output path must stay inside the M1-B release-evidence directory');
  }
  const report = buildM1BStagingReport(environment);
  const absolutePath = resolve(dependencies.cwd ?? process.cwd(), outputPath);
  (dependencies.mkdirSync ?? mkdirSync)(dirname(absolutePath), {
    recursive: true,
    mode: 0o700,
  });
  (dependencies.writeFileSync ?? writeFileSync)(
    absolutePath,
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return report;
}

function main() {
  const report = writeM1BStagingReport(process.argv[2]);
  process.stdout.write(
    `agent-mission-m1b-staging-report:ok:${report.releaseSha}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error
        ? error.message
        : 'agent-mission-m1b-staging-report:unknown error'}\n`,
    );
    process.exitCode = 1;
  }
}

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
  return Object.freeze({
    schemaVersion: 1,
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
      baseline: deployment(
        required(environment, 'BOB_M1B_BASELINE_DEPLOYMENT_ID'),
        'baselineDeploymentId',
      ),
      active: deployment(
        required(environment, 'BOB_M1B_ACTIVE_DEPLOYMENT_ID'),
        'activeDeploymentId',
      ),
      off: deployment(
        required(environment, 'BOB_M1B_OFF_DEPLOYMENT_ID'),
        'offDeploymentId',
      ),
    },
    jobs: {
      certify: result(required(environment, 'BOB_M1B_CERTIFY_RESULT'), 'certifyResult'),
      cleanup: result(required(environment, 'BOB_M1B_CLEANUP_RESULT'), 'cleanupResult'),
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

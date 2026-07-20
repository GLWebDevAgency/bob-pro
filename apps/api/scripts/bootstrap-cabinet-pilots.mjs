#!/usr/bin/env node
import { bootstrapPilot, parsePilotArgs } from './bootstrap-cabinet-pilot.mjs';

const CONFIG_NAME = 'CABINET_PILOT_BOOTSTRAP_CONFIG';
const MAX_PILOTS = 100;

function fail(message) {
  throw new Error(`bootstrap-cabinet-pilots:${message}`);
}

function hasOwn(environment, name) {
  return Object.prototype.hasOwnProperty.call(environment, name);
}

function requiredString(item, name) {
  const value = item[name];
  if (typeof value !== 'string') fail(`${name} must be a string`);
  return value;
}

function parseItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    fail('each item must be an object');
  }

  const allowed = new Set([
    'cabinetId',
    'name',
    'timeZone',
    'founderUserId',
    'expectedFlagVersion',
    'actor',
    'reason',
  ]);
  for (const name of Object.keys(item)) {
    if (!allowed.has(name)) fail('an item contains an unknown field');
  }
  if (!Number.isInteger(item.expectedFlagVersion) || item.expectedFlagVersion < 1) {
    fail('expectedFlagVersion must be a positive integer');
  }

  const argv = [
    '--cabinet-id', requiredString(item, 'cabinetId'),
    '--name', requiredString(item, 'name'),
    '--founder-user-id', requiredString(item, 'founderUserId'),
    '--worker-user-id', '',
    '--environment', '',
    '--expected-flag-version', String(item.expectedFlagVersion),
    '--actor', requiredString(item, 'actor'),
    '--reason', requiredString(item, 'reason'),
  ];
  if (item.timeZone !== undefined) {
    argv.push('--time-zone', requiredString(item, 'timeZone'));
  }
  return argv;
}

export function parsePilotBootstrapEnvironment(environment = process.env) {
  if (!hasOwn(environment, CONFIG_NAME)) return [];

  let decoded;
  try {
    decoded = JSON.parse(environment[CONFIG_NAME]);
  } catch {
    fail(`${CONFIG_NAME} must be valid JSON`);
  }
  if (!Array.isArray(decoded) || decoded.length === 0) {
    fail(`${CONFIG_NAME} must be a non-empty JSON array`);
  }
  if (decoded.length > MAX_PILOTS) fail(`${CONFIG_NAME} is limited to ${MAX_PILOTS} pilots`);
  if (environment.CABINET_INVITATION_WORKER_ENABLED !== 'true') {
    fail('invitation worker must be enabled when bootstrap config is present');
  }
  if (environment.CABINET_RELEASE_ENV !== 'staging' && environment.CABINET_RELEASE_ENV !== 'production') {
    fail('CABINET_RELEASE_ENV must be staging or production when bootstrap config is present');
  }

  const workerUserId = environment.CABINET_INVITATION_WORKER_USER_ID ?? '';
  const inputs = decoded.map((item) => {
    const argv = parseItem(item);
    const workerIndex = argv.indexOf('--worker-user-id') + 1;
    const environmentIndex = argv.indexOf('--environment') + 1;
    argv[workerIndex] = workerUserId;
    argv[environmentIndex] = environment.CABINET_RELEASE_ENV;
    return parsePilotArgs(argv);
  });

  const configuredIds = inputs.map((input) => input.cabinetId);
  const configuredIdSet = new Set(configuredIds);
  if (configuredIdSet.size !== configuredIds.length) fail('cabinetId values must be unique');

  const jobIds = (environment.JOB_CABINET_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const jobIdSet = new Set(jobIds);
  if (jobIdSet.size !== jobIds.length) fail('JOB_CABINET_IDS values must be unique');
  const sameIds = jobIdSet.size === configuredIdSet.size
    && [...configuredIdSet].every((id) => jobIdSet.has(id));
  if (!sameIds) fail(`${CONFIG_NAME} cabinet IDs must exactly match JOB_CABINET_IDS`);

  return inputs;
}

export function bootstrapConfiguredPilots(environment = process.env, dependencies = {}) {
  const inputs = parsePilotBootstrapEnvironment(environment);
  const runBootstrap = dependencies.bootstrapPilot ?? bootstrapPilot;
  for (const input of inputs) runBootstrap(input, { environment });
  return inputs.length;
}

function main() {
  try {
    const count = bootstrapConfiguredPilots();
    console.log(`bootstrap-cabinet-pilots:ok:${count}`);
  } catch {
    // Deliberately suppress config, identities and database diagnostics from release logs.
    console.error('bootstrap-cabinet-pilots:error');
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('bootstrap-cabinet-pilots.mjs')) main();

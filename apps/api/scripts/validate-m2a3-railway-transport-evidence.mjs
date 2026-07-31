#!/usr/bin/env node

import { lstat, readFile } from 'node:fs/promises';

const MAXIMUM_EVIDENCE_BYTES = 1_024;
const EXPECTED_KEYS = Object.freeze(
  ['attempts', 'childStarted', 'failureKind', 'providerFailure', 'schemaVersion', 'status'].sort(),
);
const PROVIDER_FAILURES = new Set([
  'problem_processing_request',
  'decode_response_body_expected_ident',
]);

function fail(message) {
  throw new Error(`invalid Railway transport evidence: ${message}`);
}

async function validate(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    fail('metadata unavailable');
  }

  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail('expected a regular non-symbolic file');
  }
  if (metadata.size < 1 || metadata.size > MAXIMUM_EVIDENCE_BYTES) {
    fail('size is outside the closed budget');
  }

  let evidence;
  try {
    evidence = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail('JSON cannot be parsed');
  }
  if (evidence === null || Array.isArray(evidence) || typeof evidence !== 'object') {
    fail('root must be an object');
  }

  const actualKeys = Object.keys(evidence).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(EXPECTED_KEYS)) {
    fail('shape is not exact');
  }
  if (
    evidence.schemaVersion !== 1 ||
    evidence.status !== 'failed' ||
    evidence.failureKind !== 'railway_control_plane_fetch_unavailable' ||
    !PROVIDER_FAILURES.has(evidence.providerFailure) ||
    evidence.attempts !== 3 ||
    evidence.childStarted !== false
  ) {
    fail('values are not exact');
  }
  return true;
}

if (process.argv.length !== 3) {
  console.error('Usage: validate-m2a3-railway-transport-evidence.mjs <evidence-path>');
  process.exit(64);
}

try {
  const present = await validate(process.argv[2]);
  process.stdout.write(`present=${present}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'invalid Railway transport evidence');
  process.exit(1);
}

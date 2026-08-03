#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { certifyM1BStagingDatabase } from './agent-mission-m1b-staging-database.mjs';
import { boundedPsqlSpawnOptions, withPsqlChildEnvironment } from './psql-child-environment.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const EXPECTED_ON_SEQUENCE = Object.freeze([
  'session_ready',
  'context_applied',
  'turn_transcript_final',
  'turn_semantic_plan',
  'turn_agent_result',
  'turn_speech_ready',
  'turn_interrupted',
  'session_closed',
]);
const FAILURE_EVENTS = new Set([
  'provider_failed',
  'security_rejected',
  'session_bootstrap_failed',
]);
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function fail(message) {
  throw new Error(`realtime-voice-trace-v2-staging-evidence:${message}`);
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

export function parseRealtimeVoiceTraceV2StagingEvidenceEnvironment(
  environment = process.env,
  dependencies = {},
  options = {},
) {
  if (environment.CABINET_RELEASE_ENV !== 'staging') fail('only staging is allowed');
  const companyId = required(environment, 'BOB_M1B_STAGING_COMPANY_ID', 64);
  const userId = required(environment, 'BOB_M1B_STAGING_USER_ID', 80).toLowerCase();
  const runId = required(environment, 'BOB_REALTIME_VOICE_TRACE_V2_RUN_ID', 20);
  if (!COMPANY_ID.test(companyId) || !UUID.test(userId) || !RUN_ID.test(runId)) {
    fail('the dedicated canary identity or run is invalid');
  }
  const requireSession = options.requireSession !== false;
  const sessionFile = environment.BOB_REALTIME_VOICE_TRACE_V2_CANARY_SESSION_FILE;
  const directSessionHandle = environment.BOB_REALTIME_VOICE_TRACE_V2_CANARY_SESSION_HANDLE;
  const hasSessionFile = typeof sessionFile === 'string' && sessionFile.length > 0;
  const hasDirectSessionHandle =
    typeof directSessionHandle === 'string' && directSessionHandle.length > 0;
  if (!requireSession) {
    return Object.freeze({
      directUrl: required(environment, 'DIRECT_URL'),
      psql: environment.PSQL_BIN ?? 'psql',
      companyId,
      userId,
      runId,
      sessionHandle: null,
    });
  }
  if (hasSessionFile === hasDirectSessionHandle) {
    fail('exactly one private canary session receipt source is required');
  }
  let sessionHandle;
  if (hasDirectSessionHandle) {
    sessionHandle = required(
      environment,
      'BOB_REALTIME_VOICE_TRACE_V2_CANARY_SESSION_HANDLE',
      64,
    ).toLowerCase();
  } else {
    const validatedSessionFile = required(
      environment,
      'BOB_REALTIME_VOICE_TRACE_V2_CANARY_SESSION_FILE',
      1_024,
    );
    const readFile = dependencies.readFileSync ?? readFileSync;
    try {
      sessionHandle = readFile(validatedSessionFile, 'utf8').trim().toLowerCase();
    } catch {
      fail('the private canary session receipt is unavailable');
    }
  }
  if (!UUID.test(sessionHandle)) fail('the private canary session receipt is invalid');
  return Object.freeze({
    directUrl: required(environment, 'DIRECT_URL'),
    psql: environment.PSQL_BIN ?? 'psql',
    companyId,
    userId,
    runId,
    sessionHandle,
  });
}

function executePsql(input, sql, variables, environment, dependencies) {
  const spawn = dependencies.spawnSync ?? spawnSync;
  const args = [
    '--no-psqlrc',
    '--quiet',
    '--tuples-only',
    '--no-align',
    '--set=ON_ERROR_STOP=1',
    ...Object.entries(variables).map(([name, value]) => `--set=${name}=${value}`),
  ];
  const result = withPsqlChildEnvironment(input.directUrl, environment, (childEnvironment) =>
    spawn(
      input.psql,
      args,
      boundedPsqlSpawnOptions(childEnvironment, {
        input: sql,
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
      }),
    ),
  );
  if (result?.status !== 0 || typeof result.stdout !== 'string') {
    fail('database operation failed');
  }
  if (Buffer.byteLength(result.stdout, 'utf8') > MAX_OUTPUT_BYTES) {
    fail('database output exceeded the bound');
  }
  return result.stdout
    .split('\n')
    .filter((line) => line.length > 0 && !['BEGIN', 'COMMIT', 'SET'].includes(line));
}

function readTraceRows(input, environment, dependencies) {
  const requestId = (dependencies.randomUUID ?? randomUUID)().toLowerCase();
  if (!UUID.test(requestId)) fail('request id generator is invalid');
  const lines = executePsql(
    input,
    String.raw`
SET statement_timeout = '6s';
SELECT pg_catalog.row_to_json(trace)::TEXT
  FROM public.read_realtime_voice_trace_session_v3(
    :'request_id'::UUID,
    :'company_id'::TEXT,
    :'user_id'::UUID,
    :'session_handle'::UUID,
    'investigate_staging_voice_failure',
    :'ticket'::TEXT,
    FALSE
  ) AS trace;
`,
    {
      request_id: requestId,
      company_id: input.companyId,
      user_id: input.userId,
      session_handle: input.sessionHandle,
      ticket: `O5-TRACE-${input.runId}`,
    },
    environment,
    dependencies,
  );
  try {
    return lines.map((line) => JSON.parse(line));
  } catch {
    fail('database trace snapshot is invalid');
  }
}

function isIncreasingOrdinals(rows) {
  return rows.every((row, index) => row.eventOrdinal === index + 1);
}

function sameNonNull(rows, key) {
  const values = rows
    .map((row) => row[key])
    .filter((value) => value !== null && value !== undefined);
  return values.length > 0 && new Set(values).size === 1;
}

export function certifyRealtimeVoiceTraceV2OnRows(rows) {
  if (!Array.isArray(rows) || rows.length < EXPECTED_ON_SEQUENCE.length || rows.length > 64) {
    fail('ON trace cardinality is invalid');
  }
  if (
    !isIncreasingOrdinals(rows) ||
    !sameNonNull(rows, 'traceAttemptId') ||
    !sameNonNull(rows, 'sessionHandle') ||
    rows.some((row) => row.ownerEpoch !== 1) ||
    rows.some((row) => FAILURE_EVENTS.has(row.eventKind)) ||
    rows.some((row) => row.eventKind === 'turn_speech_delivered')
  ) {
    fail('ON trace fences or failure state are invalid');
  }
  let cursor = -1;
  for (const eventKind of EXPECTED_ON_SEQUENCE) {
    cursor = rows.findIndex((row, index) => index > cursor && row.eventKind === eventKind);
    if (cursor < 0) fail('ON trace sequence is incomplete');
  }
  const turnRows = rows.filter((row) =>
    [
      'turn_transcript_final',
      'turn_semantic_plan',
      'turn_agent_result',
      'turn_speech_ready',
      'turn_interrupted',
    ].includes(row.eventKind),
  );
  if (
    !sameNonNull(turnRows, 'turnId') ||
    !sameNonNull(turnRows, 'contextRevision') ||
    !sameNonNull(turnRows, 'contextDigest')
  ) {
    fail('ON trace turn/context fences diverged');
  }
  const transcript = rows.find((row) => row.eventKind === 'turn_transcript_final');
  const result = rows.find((row) => row.eventKind === 'turn_agent_result');
  const speechReady = rows.find((row) => row.eventKind === 'turn_speech_ready');
  const interrupted = rows.find((row) => row.eventKind === 'turn_interrupted');
  const closed = rows.find((row) => row.eventKind === 'session_closed');
  if (
    !Number.isSafeInteger(transcript?.encryptionKeyVersion) ||
    !Number.isSafeInteger(result?.encryptionKeyVersion) ||
    transcript.transcriptCiphertext !== null ||
    result.canonicalReplyCiphertext !== null ||
    (speechReady.outcome !== 'ready' && speechReady.outcome !== 'already_ready') ||
    interrupted.interruptionReason !== 'session_end' ||
    closed.outcome !== 'closed' ||
    typeof closed.sessionCloseReason !== 'string' ||
    closed.sessionCloseReason.length === 0
  ) {
    fail('ON trace terminal/content proof is invalid');
  }
  return Object.freeze({
    sequence: 'ready_context_transcript_plan_result_speech_interrupted_closed',
    eventCount: rows.length,
    delivered: false,
    encryptedContentEvents: 2,
  });
}

function cleanupDedicatedSubject(input, environment, dependencies) {
  const lines = executePsql(
    input,
    String.raw`
BEGIN;
SET LOCAL ROLE bob_realtime_voice_trace_maintenance;
SELECT pg_catalog.set_config('app.current_company_id', :'company_id', TRUE);
SELECT pg_catalog.set_config('app.current_user_id', :'user_id', TRUE);
SELECT pg_catalog.row_to_json(result)::TEXT
  FROM public.erase_realtime_voice_trace_subject_v2(
    :'company_id'::TEXT,
    :'user_id'::UUID,
    'subject_erasure'
  ) AS result;
COMMIT;
`,
    { company_id: input.companyId, user_id: input.userId },
    environment,
    dependencies,
  );
  let receipt;
  try {
    receipt = JSON.parse(lines.at(-1));
  } catch {
    fail('cleanup receipt is invalid');
  }
  if (
    !Number.isSafeInteger(receipt.deletedEvents) ||
    receipt.deletedEvents < 0 ||
    !Number.isSafeInteger(receipt.deletedAccessAudits) ||
    receipt.deletedAccessAudits < 0
  ) {
    fail('cleanup receipt is invalid');
  }
  return Object.freeze({
    cleanup: 'dedicated_subject_erased',
    eventsRemoved: receipt.deletedEvents,
    auditsRemoved: receipt.deletedAccessAudits,
  });
}

function certifyClean(input, environment, dependencies) {
  const lines = executePsql(
    input,
    String.raw`
BEGIN;
SET LOCAL ROLE bob_realtime_voice_trace_maintenance;
SELECT pg_catalog.json_build_object(
  'events', (
    SELECT pg_catalog.count(*) FROM public.realtime_voice_trace_events AS trace
     WHERE trace."companyId" = :'company_id'::TEXT AND trace."userId" = :'user_id'::UUID
  ),
  'audits', (
    SELECT pg_catalog.count(*) FROM public.realtime_voice_trace_access_audits AS audit
     WHERE audit."companyId" = :'company_id'::TEXT AND audit."subjectUserId" = :'user_id'::UUID
  )
)::TEXT;
ROLLBACK;
`,
    { company_id: input.companyId, user_id: input.userId },
    environment,
    dependencies,
  );
  let counts;
  try {
    counts = JSON.parse(lines.at(-1));
  } catch {
    fail('cleanliness receipt is invalid');
  }
  if (Number(counts.events) !== 0 || Number(counts.audits) !== 0) {
    fail('dedicated canary trace subject is not clean');
  }
  return Object.freeze({ cleanup: 'verified', events: 0, audits: 0 });
}

export function runRealtimeVoiceTraceV2StagingEvidence(
  command,
  environment = process.env,
  dependencies = {},
) {
  if (!['verify-on', 'verify-off', 'cleanup', 'verify-clean'].includes(command)) {
    fail('command must be verify-on, verify-off, cleanup or verify-clean');
  }
  const input = parseRealtimeVoiceTraceV2StagingEvidenceEnvironment(environment, dependencies, {
    requireSession: command === 'verify-on' || command === 'verify-off',
  });
  (dependencies.certifyDatabase ?? certifyM1BStagingDatabase)(environment, dependencies);
  if (command === 'verify-on') {
    return {
      command,
      ...certifyRealtimeVoiceTraceV2OnRows(readTraceRows(input, environment, dependencies)),
    };
  }
  if (command === 'verify-off') {
    const rows = readTraceRows(input, environment, dependencies);
    if (rows.length !== 0) fail('OFF canary produced trace rows');
    return { command, eventCount: 0 };
  }
  if (command === 'cleanup') {
    return { command, ...cleanupDedicatedSubject(input, environment, dependencies) };
  }
  if (command === 'verify-clean') {
    return { command, ...certifyClean(input, environment, dependencies) };
  }
  fail('unreachable command');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = runRealtimeVoiceTraceV2StagingEvidence(process.argv[2]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'evidence failed'}\n`);
    process.exitCode = 1;
  }
}

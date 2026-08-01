#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_INPUT_BYTES = 1_048_576;

function fail(message) {
  throw new Error(`realtime-voice-trace-v2-receipt:${message}`);
}

function plainObject(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function integer(value, name, minimum = 0, maximum = 1_000_000) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${name} is invalid`);
  }
  return value;
}

function required(environment, name, pattern, maximum = 1_024) {
  const value = environment[name];
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    !pattern.test(value)
  ) {
    fail(`${name} is missing or invalid`);
  }
  return value;
}

function canonicalEvidence(receipt, expectedCommand) {
  if (!plainObject(receipt) || receipt.command !== expectedCommand) {
    fail('evidence command does not match');
  }
  if (expectedCommand === 'verify-on') {
    if (
      receipt.sequence !== 'ready_context_transcript_plan_result_speech_interrupted_closed' ||
      receipt.delivered !== false ||
      receipt.encryptedContentEvents !== 2
    ) {
      fail('ON evidence is invalid');
    }
    return Object.freeze({
      command: expectedCommand,
      sequence: receipt.sequence,
      eventCount: integer(receipt.eventCount, 'eventCount', 8, 64),
      delivered: false,
      encryptedContentEvents: 2,
    });
  }
  if (expectedCommand === 'verify-off') {
    if (receipt.eventCount !== 0) fail('OFF evidence is invalid');
    return Object.freeze({ command: expectedCommand, eventCount: 0 });
  }
  if (expectedCommand === 'cleanup') {
    if (receipt.cleanup !== 'dedicated_subject_erased') fail('cleanup evidence is invalid');
    return Object.freeze({
      command: expectedCommand,
      cleanup: receipt.cleanup,
      eventsRemoved: integer(receipt.eventsRemoved, 'eventsRemoved'),
      auditsRemoved: integer(receipt.auditsRemoved, 'auditsRemoved'),
    });
  }
  if (expectedCommand === 'verify-clean') {
    if (receipt.cleanup !== 'verified' || receipt.events !== 0 || receipt.audits !== 0) {
      fail('cleanliness evidence is invalid');
    }
    return Object.freeze({
      command: expectedCommand,
      cleanup: 'verified',
      events: 0,
      audits: 0,
    });
  }
  fail('unsupported evidence command');
}

export function normalizeRealtimeVoiceTraceV2EvidenceOutput(raw, expectedCommand) {
  if (
    typeof raw !== 'string' ||
    Buffer.byteLength(raw, 'utf8') < 2 ||
    Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES
  ) {
    fail('evidence output is invalid');
  }
  const candidates = [];
  for (const line of raw.split('\n')) {
    if (line.length < 2 || line.length > 65_536 || line[0] !== '{') continue;
    try {
      const parsed = JSON.parse(line);
      if (plainObject(parsed) && parsed.command === expectedCommand) candidates.push(parsed);
    } catch {
      // Railway may emit bounded non-JSON status lines around the remote command output.
    }
  }
  if (candidates.length !== 1) fail('evidence output is ambiguous');
  return canonicalEvidence(candidates[0], expectedCommand);
}

export function deriveRealtimeVoiceTraceV2StagingOutputs({ on, cleanup, clean }) {
  const onReceipt = canonicalEvidence(on, 'verify-on');
  const cleanupReceipt = canonicalEvidence(cleanup, 'cleanup');
  const cleanReceipt = canonicalEvidence(clean, 'verify-clean');
  if (cleanupReceipt.eventsRemoved !== onReceipt.eventCount || cleanupReceipt.auditsRemoved < 1) {
    fail('cleanup counters do not match the final ON canary');
  }
  return Object.freeze({
    canaryEventCount: onReceipt.eventCount,
    encryptedContentEvents: onReceipt.encryptedContentEvents,
    cleanupEventsRemoved: cleanupReceipt.eventsRemoved,
    cleanupAuditsRemoved: cleanupReceipt.auditsRemoved,
    cleanupFinalEvents: cleanReceipt.events,
    cleanupFinalAudits: cleanReceipt.audits,
  });
}

export function createRealtimeVoiceTraceV2FinalReceipt(environment) {
  const beforeDigest = required(environment, 'PRODUCTION_BEFORE_DIGEST', DIGEST, 64);
  const afterDigest = required(environment, 'PRODUCTION_AFTER_DIGEST', DIGEST, 64);
  if (beforeDigest !== afterDigest) fail('production digest changed');
  if (environment.STAGING_RESULT !== 'success' || environment.ROLLBACK_RESULT !== 'skipped') {
    fail('staging drill did not finish in the certified state');
  }
  const cleanupFinalEvents = Number(environment.CLEANUP_FINAL_EVENTS);
  const cleanupFinalAudits = Number(environment.CLEANUP_FINAL_AUDITS);
  if (cleanupFinalEvents !== 0 || cleanupFinalAudits !== 0) {
    fail('canary subject was not left clean');
  }
  const canaryEventCount = integer(
    Number(environment.CANARY_EVENT_COUNT),
    'CANARY_EVENT_COUNT',
    8,
    64,
  );
  const cleanupEventsRemoved = integer(
    Number(environment.CLEANUP_EVENTS_REMOVED),
    'CLEANUP_EVENTS_REMOVED',
    8,
    64,
  );
  const cleanupAuditsRemoved = integer(
    Number(environment.CLEANUP_AUDITS_REMOVED),
    'CLEANUP_AUDITS_REMOVED',
    1,
    64,
  );
  if (cleanupEventsRemoved !== canaryEventCount) {
    fail('archived cleanup counters do not match the final ON canary');
  }
  return Object.freeze({
    schemaVersion: 2,
    objective: 'O5-REALTIME-TRACE-V2',
    verdict: 'certified',
    environment: 'staging',
    releaseSha: required(environment, 'GITHUB_SHA', SHA, 40),
    githubRunId: required(environment, 'GITHUB_RUN_ID', RUN_ID, 20),
    githubRunAttempt: required(environment, 'GITHUB_RUN_ATTEMPT', RUN_ID, 20),
    normalStagingReleaseRunId: required(environment, 'NORMAL_STAGING_RELEASE_RUN_ID', RUN_ID, 20),
    sequence: Object.freeze(['off', 'on', 'off', 'on']),
    finalState: 'active',
    finalDeploymentId: required(environment, 'FINAL_DEPLOYMENT_ID', UUID, 80).toLowerCase(),
    migrations: Object.freeze({ exactChecksumInventory: 'verified', pendingCount: 0 }),
    flag: Object.freeze({ state: 'active', allowlist: 'dedicated_canary_subject' }),
    canary: Object.freeze({
      eventCount: canaryEventCount,
      encryptedContentEvents: integer(
        Number(environment.ENCRYPTED_CONTENT_EVENTS),
        'ENCRYPTED_CONTENT_EVENTS',
        2,
        2,
      ),
      delivered: false,
      audioStored: false,
      transcriptInCi: false,
    }),
    cleanup: Object.freeze({
      eventsRemoved: cleanupEventsRemoved,
      auditsRemoved: cleanupAuditsRemoved,
      finalEvents: cleanupFinalEvents,
      finalAudits: cleanupFinalAudits,
    }),
    production: Object.freeze({
      unchanged: true,
      beforeDigest,
      afterDigest,
    }),
  });
}

function boundedStdin() {
  const raw = readFileSync(0, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES) fail('stdin is oversized');
  return raw;
}

function parseJsonEnvironment(name) {
  try {
    return JSON.parse(required(process.env, name, /^\{[\s\S]*\}$/u, 65_536));
  } catch {
    fail(`${name} is invalid`);
  }
}

function main() {
  const command = process.argv[2];
  if (command === 'normalize-evidence') {
    const normalized = normalizeRealtimeVoiceTraceV2EvidenceOutput(boundedStdin(), process.argv[3]);
    process.stdout.write(`${JSON.stringify(normalized)}\n`);
    return;
  }
  if (command === 'emit-staging-outputs') {
    const output = deriveRealtimeVoiceTraceV2StagingOutputs({
      on: parseJsonEnvironment('ON_EVIDENCE_JSON'),
      cleanup: parseJsonEnvironment('CLEANUP_EVIDENCE_JSON'),
      clean: parseJsonEnvironment('CLEAN_EVIDENCE_JSON'),
    });
    process.stdout.write(
      [
        `canary_event_count=${output.canaryEventCount}`,
        `encrypted_content_events=${output.encryptedContentEvents}`,
        `cleanup_events_removed=${output.cleanupEventsRemoved}`,
        `cleanup_audits_removed=${output.cleanupAuditsRemoved}`,
        `cleanup_final_events=${output.cleanupFinalEvents}`,
        `cleanup_final_audits=${output.cleanupFinalAudits}`,
      ].join('\n') + '\n',
    );
    return;
  }
  if (command === 'final-receipt') {
    process.stdout.write(
      `${JSON.stringify(createRealtimeVoiceTraceV2FinalReceipt(process.env), null, 2)}\n`,
    );
    return;
  }
  fail('command is invalid');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'receipt failed'}\n`);
    process.exitCode = 1;
  }
}

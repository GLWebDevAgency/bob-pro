import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRealtimeVoiceTraceV2FinalReceipt,
  deriveRealtimeVoiceTraceV2StagingOutputs,
  normalizeRealtimeVoiceTraceV2EvidenceOutput,
} from './realtime-voice-trace-v2-receipt.mjs';

const on = {
  command: 'verify-on',
  sequence: 'ready_context_transcript_plan_result_speech_interrupted_closed',
  eventCount: 11,
  delivered: false,
  encryptedContentEvents: 2,
};
const cleanup = {
  command: 'cleanup',
  cleanup: 'dedicated_subject_erased',
  eventsRemoved: 11,
  auditsRemoved: 1,
};
const clean = {
  command: 'verify-clean',
  cleanup: 'verified',
  events: 0,
  audits: 0,
};

test('normalise une unique preuve distante bornee au milieu des lignes Railway', () => {
  assert.deepEqual(
    normalizeRealtimeVoiceTraceV2EvidenceOutput(
      `Connecting…\n${JSON.stringify(on)}\nCommand finished\n`,
      'verify-on',
    ),
    on,
  );
  assert.throws(
    () =>
      normalizeRealtimeVoiceTraceV2EvidenceOutput(
        `${JSON.stringify(on)}\n${JSON.stringify(on)}\n`,
        'verify-on',
      ),
    /ambiguous/u,
  );
  assert.throws(
    () =>
      normalizeRealtimeVoiceTraceV2EvidenceOutput(
        `${JSON.stringify({ ...on, delivered: true })}\n`,
        'verify-on',
      ),
    /ON evidence/u,
  );
});

test('derive uniquement des compteurs non-PII apres nettoyage total', () => {
  assert.deepEqual(deriveRealtimeVoiceTraceV2StagingOutputs({ on, cleanup, clean }), {
    canaryEventCount: 11,
    encryptedContentEvents: 2,
    cleanupEventsRemoved: 11,
    cleanupAuditsRemoved: 1,
    cleanupFinalEvents: 0,
    cleanupFinalAudits: 0,
  });
});

function environment(overrides = {}) {
  return {
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '1234',
    GITHUB_RUN_ATTEMPT: '1',
    NORMAL_STAGING_RELEASE_RUN_ID: '1200',
    FINAL_DEPLOYMENT_ID: '10000000-0000-4000-8000-000000000001',
    PRODUCTION_BEFORE_DIGEST: 'b'.repeat(64),
    PRODUCTION_AFTER_DIGEST: 'b'.repeat(64),
    STAGING_RESULT: 'success',
    ROLLBACK_RESULT: 'skipped',
    CANARY_EVENT_COUNT: '11',
    ENCRYPTED_CONTENT_EVENTS: '2',
    CLEANUP_EVENTS_REMOVED: '11',
    CLEANUP_AUDITS_REMOVED: '1',
    CLEANUP_FINAL_EVENTS: '0',
    CLEANUP_FINAL_AUDITS: '0',
    ...overrides,
  };
}

test('le recu final lie SHA, migrations, compteurs, cleanup et production inchangee', () => {
  const receipt = createRealtimeVoiceTraceV2FinalReceipt(environment());
  assert.equal(receipt.verdict, 'certified');
  assert.deepEqual(receipt.sequence, ['off', 'on', 'off', 'on']);
  assert.deepEqual(receipt.migrations, {
    exactChecksumInventory: 'verified',
    pendingCount: 0,
  });
  assert.equal(receipt.canary.eventCount, 11);
  assert.equal(receipt.cleanup.finalEvents, 0);
  assert.equal(receipt.cleanup.finalAudits, 0);
  assert.equal(receipt.production.unchanged, true);
  assert.equal(receipt.production.beforeDigest, receipt.production.afterDigest);
  assert.equal(JSON.stringify(receipt).includes('Je souhaite'), false);
});

test('aucun recu certifie ne sort si staging, rollback, cleanup ou production divergent', () => {
  for (const overrides of [
    { STAGING_RESULT: 'failure' },
    { ROLLBACK_RESULT: 'success' },
    { CLEANUP_FINAL_EVENTS: '1' },
    { CLEANUP_EVENTS_REMOVED: '10' },
    { PRODUCTION_AFTER_DIGEST: 'c'.repeat(64) },
  ]) {
    assert.throws(() => createRealtimeVoiceTraceV2FinalReceipt(environment(overrides)));
  }
});

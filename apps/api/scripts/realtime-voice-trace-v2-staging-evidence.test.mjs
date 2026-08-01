import assert from 'node:assert/strict';
import test from 'node:test';
import {
  certifyRealtimeVoiceTraceV2OnRows,
  runRealtimeVoiceTraceV2StagingEvidence,
} from './realtime-voice-trace-v2-staging-evidence.mjs';

const COMPANY_ID = 'trace-company';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TRACE_ID = '33333333-3333-4333-8333-333333333333';
const TURN_ID = '44444444-4444-4444-8444-444444444444';
const REQUEST_ID = '55555555-5555-4555-8555-555555555555';

function environment() {
  return {
    CABINET_RELEASE_ENV: 'staging',
    DIRECT_URL: 'postgresql://deployer@staging.invalid/bob',
    BOB_M1B_STAGING_COMPANY_ID: COMPANY_ID,
    BOB_M1B_STAGING_USER_ID: USER_ID,
    BOB_REALTIME_VOICE_TRACE_V2_RUN_ID: '123456789',
    BOB_REALTIME_VOICE_TRACE_V2_CANARY_SESSION_FILE: '/tmp/o5-session',
  };
}

function onRows() {
  const kinds = [
    'session_ready',
    'context_applied',
    'turn_transcript_final',
    'turn_semantic_plan',
    'turn_agent_result',
    'turn_speech_ready',
    'turn_interrupted',
    'session_closed',
  ];
  return kinds.map((eventKind, index) => ({
    id: `0000000${index + 1}-0000-4000-8000-00000000000${index + 1}`,
    traceAttemptId: TRACE_ID,
    sessionHandle: SESSION_ID,
    ownerEpoch: 1,
    eventOrdinal: index + 1,
    eventKind,
    turnId: index >= 2 && index <= 6 ? TURN_ID : null,
    occurredAt: `2026-08-01T10:00:0${index}.000+00:00`,
    durationMs: null,
    contextRevision: index >= 1 && index <= 6 ? 1 : null,
    contextDigest: index >= 1 && index <= 6 ? 'a'.repeat(64) : null,
    speechDelivery: eventKind === 'turn_speech_ready' ? 'openai-native-webrtc-v1' : null,
    plannerDisposition: eventKind === 'turn_semantic_plan' ? 'global' : null,
    plannerAuthority: eventKind === 'turn_semantic_plan' ? 'llm' : null,
    plannerIntent: eventKind === 'turn_semantic_plan' ? 'navigate' : null,
    missionKind: null,
    runKind: eventKind === 'turn_agent_result' ? 'answer' : null,
    controlKind: eventKind === 'turn_agent_result' ? 'none' : null,
    stage: eventKind === 'session_closed' ? 'session' : null,
    outcome:
      eventKind === 'turn_speech_ready'
        ? 'ready'
        : eventKind === 'turn_interrupted'
          ? 'cancelled'
          : eventKind === 'session_closed'
            ? 'closed'
            : 'ready',
    failureClass: null,
    interruptionReason: eventKind === 'turn_interrupted' ? 'session_end' : null,
    eventDigestKeyVersion: 1,
    encryptionKeyVersion: ['turn_transcript_final', 'turn_agent_result'].includes(eventKind)
      ? 1
      : null,
    transcriptCiphertext: null,
    canonicalReplyCiphertext: null,
  }));
}

function dependenciesForRows(rows) {
  return {
    certifyDatabase: () => ({ databaseName: 'postgres' }),
    readFileSync: () => SESSION_ID,
    randomUUID: () => REQUEST_ID,
    spawnSync(_command, args) {
      assert.equal(
        args.some((argument) => argument.includes(COMPANY_ID)),
        true,
      );
      return { status: 0, stdout: `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` };
    },
  };
}

test('preuve ON lie ordre, tentative, owner, tour, contexte et absence de faux delivered', () => {
  const receipt = certifyRealtimeVoiceTraceV2OnRows(onRows());
  assert.deepEqual(receipt, {
    sequence: 'ready_context_transcript_plan_result_speech_interrupted_closed',
    eventCount: 8,
    delivered: false,
    encryptedContentEvents: 2,
  });
  assert.throws(
    () =>
      certifyRealtimeVoiceTraceV2OnRows([
        ...onRows(),
        { ...onRows()[5], eventOrdinal: 9, eventKind: 'turn_speech_delivered' },
      ]),
    /fences or failure state/u,
  );
  const drifted = onRows();
  drifted[4] = { ...drifted[4], traceAttemptId: REQUEST_ID };
  assert.throws(() => certifyRealtimeVoiceTraceV2OnRows(drifted), /fences/u);
});

test('runner ON ne publie aucune identité ni contenu dans son reçu', () => {
  const result = runRealtimeVoiceTraceV2StagingEvidence(
    'verify-on',
    environment(),
    dependenciesForRows(onRows()),
  );
  assert.equal(result.eventCount, 8);
  const receipt = JSON.stringify(result);
  for (const forbidden of [COMPANY_ID, USER_ID, SESSION_ID, TRACE_ID, TURN_ID]) {
    assert.equal(receipt.includes(forbidden), false);
  }
});

test('le reçu distant accepte un handle direct mais refuse deux sources ou aucune', () => {
  const directEnvironment = {
    ...environment(),
    BOB_REALTIME_VOICE_TRACE_V2_CANARY_SESSION_FILE: undefined,
    BOB_REALTIME_VOICE_TRACE_V2_CANARY_SESSION_HANDLE: SESSION_ID,
  };
  const direct = runRealtimeVoiceTraceV2StagingEvidence(
    'verify-on',
    directEnvironment,
    dependenciesForRows(onRows()),
  );
  assert.equal(direct.eventCount, 8);

  assert.throws(
    () =>
      runRealtimeVoiceTraceV2StagingEvidence(
        'verify-on',
        {
          ...environment(),
          BOB_REALTIME_VOICE_TRACE_V2_CANARY_SESSION_HANDLE: SESSION_ID,
        },
        dependenciesForRows(onRows()),
      ),
    /exactly one private canary session receipt source/u,
  );
  assert.throws(
    () =>
      runRealtimeVoiceTraceV2StagingEvidence(
        'verify-on',
        {
          ...environment(),
          BOB_REALTIME_VOICE_TRACE_V2_CANARY_SESSION_FILE: undefined,
        },
        dependenciesForRows(onRows()),
      ),
    /exactly one private canary session receipt source/u,
  );
});

test('preuve OFF exige zéro ligne puis le cleanup et la vérification restent bornés', () => {
  const off = runRealtimeVoiceTraceV2StagingEvidence(
    'verify-off',
    environment(),
    dependenciesForRows([]),
  );
  assert.deepEqual(off, { command: 'verify-off', eventCount: 0 });

  const cleanupEnvironment = {
    ...environment(),
    BOB_REALTIME_VOICE_TRACE_V2_CANARY_SESSION_FILE: undefined,
  };
  const cleanup = runRealtimeVoiceTraceV2StagingEvidence('cleanup', cleanupEnvironment, {
    certifyDatabase: () => ({ databaseName: 'postgres' }),
    spawnSync() {
      return {
        status: 0,
        stdout: `${COMPANY_ID}\n${USER_ID}\n{"deletedEvents":8,"deletedAccessAudits":2}\n`,
      };
    },
  });
  assert.deepEqual(cleanup, {
    command: 'cleanup',
    cleanup: 'dedicated_subject_erased',
    eventsRemoved: 8,
    auditsRemoved: 2,
  });

  const clean = runRealtimeVoiceTraceV2StagingEvidence('verify-clean', cleanupEnvironment, {
    certifyDatabase: () => ({ databaseName: 'postgres' }),
    spawnSync() {
      return { status: 0, stdout: '{"events":0,"audits":0}\n' };
    },
  });
  assert.deepEqual(clean, { command: 'verify-clean', cleanup: 'verified', events: 0, audits: 0 });
});

test('preuve OFF et cleanup échouent fermés sur toute donnée restante ou erreur SQL privée', () => {
  assert.throws(
    () =>
      runRealtimeVoiceTraceV2StagingEvidence(
        'verify-off',
        environment(),
        dependenciesForRows(onRows().slice(0, 1)),
      ),
    /OFF canary produced trace rows/u,
  );
  assert.throws(
    () =>
      runRealtimeVoiceTraceV2StagingEvidence('verify-clean', environment(), {
        certifyDatabase: () => ({ databaseName: 'postgres' }),
        readFileSync: () => SESSION_ID,
        spawnSync() {
          return { status: 0, stdout: '{"events":1,"audits":0}\n' };
        },
      }),
    /not clean/u,
  );
  const privateFailure = 'private SQL failure';
  assert.throws(
    () =>
      runRealtimeVoiceTraceV2StagingEvidence('verify-on', environment(), {
        certifyDatabase: () => ({ databaseName: 'postgres' }),
        readFileSync: () => SESSION_ID,
        randomUUID: () => REQUEST_ID,
        spawnSync() {
          return { status: 1, stdout: '', stderr: privateFailure };
        },
      }),
    (error) => {
      assert.match(error.message, /database operation failed/u);
      assert.equal(error.message.includes(privateFailure), false);
      return true;
    },
  );
});

test('la preuve d identité Supabase staging précède toute lecture ou destruction SQL', () => {
  let sqlCalled = false;
  const cleanupEnvironment = {
    ...environment(),
    BOB_REALTIME_VOICE_TRACE_V2_CANARY_SESSION_FILE: undefined,
  };
  assert.throws(
    () =>
      runRealtimeVoiceTraceV2StagingEvidence('cleanup', cleanupEnvironment, {
        certifyDatabase() {
          throw new Error('staging database pin rejected');
        },
        spawnSync() {
          sqlCalled = true;
          return { status: 0, stdout: '' };
        },
      }),
    /staging database pin rejected/u,
  );
  assert.equal(sqlCalled, false);
});

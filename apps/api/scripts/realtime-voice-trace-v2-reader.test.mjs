import assert from 'node:assert/strict';
import { createCipheriv, hkdfSync } from 'node:crypto';
import test from 'node:test';
import {
  decryptRealtimeVoiceTraceV2Field,
  parseRealtimeVoiceTraceV2ReaderInput,
  runRealtimeVoiceTraceV2Reader,
} from './realtime-voice-trace-v2-reader.mjs';

const COMPANY_ID = 'trace-company';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TRACE_ID = '33333333-3333-4333-8333-333333333333';
const EVENT_ID = '44444444-4444-4444-8444-444444444444';
const TURN_ID = '55555555-5555-4555-8555-555555555555';
const REQUEST_ID = '66666666-6666-4666-8666-666666666666';
const ROOT = Buffer.alloc(32, 23);
const ROOT_BASE64 = ROOT.toString('base64url');
const SALT = Buffer.from('bob-pro:realtime-voice-trace:v2:hkdf', 'utf8');
const INFO = Buffer.from('bob-pro:realtime-voice-trace:v2:aes-256-gcm', 'utf8');

function environment(overrides = {}) {
  return {
    CABINET_RELEASE_ENV: 'staging',
    DIRECT_URL: 'postgresql://reader@staging.invalid/bob',
    VOICE_TRACE_REALTIME_V2_ENCRYPTION_KEYRING: JSON.stringify({ 1: ROOT_BASE64 }),
    PATH: '/usr/bin',
    ...overrides,
  };
}

function args(includeContent = false) {
  return [
    '--company-id',
    COMPANY_ID,
    '--user-id',
    USER_ID,
    '--session-handle',
    SESSION_ID,
    '--actor',
    'staging_deployer',
    '--reason',
    'investigate_staging_voice_failure',
    '--ticket',
    'O5-TRACE-2026',
    ...(includeContent ? ['--include-content'] : []),
  ];
}

function traceRow(overrides = {}) {
  return {
    id: EVENT_ID,
    companyId: COMPANY_ID,
    userId: USER_ID,
    traceAttemptId: TRACE_ID,
    sessionHandle: SESSION_ID,
    ownerEpoch: 1,
    eventOrdinal: 4,
    eventKind: 'turn_transcript_final',
    turnId: TURN_ID,
    occurredAt: '2026-08-01T10:00:00.123Z',
    durationMs: 310,
    contextRevision: 1,
    contextDigest: 'a'.repeat(64),
    speechDelivery: null,
    plannerDisposition: null,
    plannerAuthority: null,
    plannerIntent: null,
    missionKind: null,
    runKind: null,
    controlKind: null,
    stage: 'transcription',
    outcome: 'ready',
    failureClass: null,
    interruptionReason: null,
    sessionCloseReason: null,
    eventDigestKeyVersion: 1,
    encryptionKeyVersion: 1,
    transcriptCiphertext: null,
    canonicalReplyCiphertext: null,
    ...overrides,
  };
}

function encrypt(row, field, plaintext) {
  const nonce = Buffer.alloc(12, 7);
  const key = Buffer.from(hkdfSync('sha256', ROOT, SALT, INFO, 32));
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(
    Buffer.from(
      JSON.stringify([
        1,
        row.id,
        COMPANY_ID,
        USER_ID,
        row.traceAttemptId,
        row.sessionHandle,
        row.ownerEpoch,
        row.eventOrdinal,
        row.turnId,
        row.eventKind,
        row.occurredAt,
        row.encryptionKeyVersion,
        field,
      ]),
      'utf8',
    ),
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${nonce.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
}

test('reader refuse CI, production et tout flux non interactif', () => {
  assert.throws(
    () =>
      parseRealtimeVoiceTraceV2ReaderInput(args(), environment({ CI: 'true' }), {
        stdin: true,
        stdout: true,
      }),
    /CI execution is forbidden/u,
  );
  assert.throws(
    () =>
      parseRealtimeVoiceTraceV2ReaderInput(
        args(),
        environment({ CABINET_RELEASE_ENV: 'production' }),
        {
          stdin: true,
          stdout: true,
        },
      ),
    /only staging/u,
  );
  assert.throws(
    () =>
      parseRealtimeVoiceTraceV2ReaderInput(args(), environment(), {
        stdin: false,
        stdout: true,
      }),
    /interactive TTY/u,
  );
});

test('lecture sans contenu audite l acteur et ne republie jamais les ciphertexts', () => {
  const row = traceRow({ transcriptCiphertext: 'v1.private.ciphertext.private' });
  const calls = [];
  const result = runRealtimeVoiceTraceV2Reader(args(), environment(), {
    tty: { stdin: true, stdout: true },
    randomUUID: () => REQUEST_ID,
    certifyDatabase: () => calls.push({ command: 'database-certification' }),
    spawnSync(command, commandArgs, options) {
      calls.push({ command, commandArgs, options });
      return {
        status: 0,
        stdout: `${JSON.stringify({ kind: 'reader', actor: 'staging_deployer' })}\n${JSON.stringify(row)}\n`,
      };
    },
  });
  assert.equal(result.length, 1);
  assert.equal(Object.hasOwn(result[0], 'transcriptCiphertext'), false);
  assert.equal(Object.hasOwn(result[0], 'canonicalReplyCiphertext'), false);
  assert.equal(result[0].occurredAt, '2026-08-01T10:00:00.123Z');
  assert.equal(result[0].sessionCloseReason, null);
  assert.equal(calls[0].command, 'database-certification');
  assert.equal(calls[1].command, 'psql');
  assert.equal(calls[1].commandArgs.includes('--set=include_content=false'), true);
  assert.match(calls[1].options.input, /read_realtime_voice_trace_session_v3/u);
  assert.equal(calls[1].options.env.DIRECT_URL, undefined);
});

test('le lecteur sanctionné expose le motif policy sans contenu sensible', () => {
  const row = traceRow({
    eventKind: 'session_closed',
    turnId: null,
    stage: 'session',
    outcome: 'closed',
    sessionCloseReason: 'policy',
    encryptionKeyVersion: null,
  });
  const result = runRealtimeVoiceTraceV2Reader(args(), environment(), {
    tty: { stdin: true, stdout: true },
    randomUUID: () => REQUEST_ID,
    certifyDatabase: () => ({ databaseName: 'postgres' }),
    spawnSync() {
      return {
        status: 0,
        stdout: `${JSON.stringify({ kind: 'reader', actor: 'staging_deployer' })}\n${JSON.stringify(row)}\n`,
      };
    },
  });

  assert.equal(result[0].sessionCloseReason, 'policy');
  assert.equal(Object.hasOwn(result[0], 'transcriptCiphertext'), false);
  assert.equal(Object.hasOwn(result[0], 'canonicalReplyCiphertext'), false);
});

test('verbatim explicite authentifie AES-GCM avec toutes les fences de la ligne', () => {
  const row = traceRow();
  const plaintext = 'Phrase française de diagnostic.';
  row.transcriptCiphertext = encrypt(row, 'transcript', plaintext);
  assert.equal(
    decryptRealtimeVoiceTraceV2Field(row, 'transcript', new Map([[1, ROOT]])),
    plaintext,
  );
  assert.throws(
    () =>
      decryptRealtimeVoiceTraceV2Field(
        { ...row, ownerEpoch: 2 },
        'transcript',
        new Map([[1, ROOT]]),
      ),
    /authentication failed/u,
  );

  const result = runRealtimeVoiceTraceV2Reader(args(true), environment(), {
    tty: { stdin: true, stdout: true },
    randomUUID: () => REQUEST_ID,
    certifyDatabase: () => ({ databaseName: 'postgres' }),
    spawnSync() {
      return {
        status: 0,
        stdout: `${JSON.stringify({ kind: 'reader', actor: 'staging_deployer' })}\n${JSON.stringify(row)}\n`,
      };
    },
  });
  assert.equal(result[0].transcript, plaintext);
  assert.equal(result[0].canonicalReply, null);
  assert.equal(JSON.stringify(result).includes(row.transcriptCiphertext), false);
});

test('une erreur psql reste fermée et ne republie ni URL ni stderr contrôlé', () => {
  const secret = 'private-database-diagnostic';
  assert.throws(
    () =>
      runRealtimeVoiceTraceV2Reader(args(), environment(), {
        tty: { stdin: true, stdout: true },
        randomUUID: () => REQUEST_ID,
        certifyDatabase: () => ({ databaseName: 'postgres' }),
        spawnSync() {
          return { status: 2, stdout: '', stderr: secret };
        },
      }),
    (error) => {
      assert.match(error.message, /database operation failed/u);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes('postgresql://'), false);
      return true;
    },
  );
});

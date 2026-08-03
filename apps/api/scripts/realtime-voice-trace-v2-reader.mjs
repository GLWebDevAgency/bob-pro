#!/usr/bin/env node
import { createDecipheriv, hkdfSync, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { certifyM1BStagingDatabase } from './agent-mission-m1b-staging-database.mjs';
import { boundedPsqlSpawnOptions, withPsqlChildEnvironment } from './psql-child-environment.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const ACTOR = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/u;
const TICKET = /^[A-Za-z0-9][A-Za-z0-9_.-]{7,63}$/u;
const KEY_VERSION = /^[1-9][0-9]{0,9}$/u;
const TRACE_HKDF_SALT = Buffer.from('bob-pro:realtime-voice-trace:v2:hkdf', 'utf8');
const TRACE_ENCRYPTION_INFO = Buffer.from('bob-pro:realtime-voice-trace:v2:aes-256-gcm', 'utf8');
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function fail(message) {
  throw new Error(`realtime-voice-trace-v2-reader:${message}`);
}

function required(environment, name, maximum = 16_384) {
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

function optionMap(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--include-content') {
      if (options.has(name)) fail('duplicate option');
      options.set(name, true);
      continue;
    }
    if (!name?.startsWith('--') || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      fail('invalid command line');
    }
    if (options.has(name)) fail('duplicate option');
    options.set(name, argv[index + 1]);
    index += 1;
  }
  return options;
}

function parseKeyring(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail('encryption keyring is invalid');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    fail('encryption keyring is invalid');
  }
  const keyring = new Map();
  for (const [version, secret] of Object.entries(parsed)) {
    if (
      !KEY_VERSION.test(version) ||
      typeof secret !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/u.test(secret)
    ) {
      fail('encryption keyring is invalid');
    }
    const bytes = Buffer.from(secret, 'base64url');
    if (bytes.byteLength !== 32 || bytes.toString('base64url') !== secret) {
      fail('encryption keyring is invalid');
    }
    keyring.set(Number(version), bytes);
  }
  if (keyring.size < 1 || keyring.size > 8) fail('encryption keyring is invalid');
  return keyring;
}

export function parseRealtimeVoiceTraceV2ReaderInput(
  argv,
  environment = process.env,
  tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY },
) {
  if (environment.CI !== undefined || environment.GITHUB_ACTIONS !== undefined) {
    fail('CI execution is forbidden');
  }
  if (tty.stdin !== true || tty.stdout !== true) fail('interactive TTY is required');
  if (environment.CABINET_RELEASE_ENV !== 'staging') fail('only staging is readable');
  const options = optionMap(argv);
  const expectedNames = new Set([
    '--company-id',
    '--user-id',
    '--session-handle',
    '--actor',
    '--reason',
    '--ticket',
    '--include-content',
  ]);
  if ([...options.keys()].some((name) => !expectedNames.has(name))) fail('unknown option');
  const companyId = options.get('--company-id');
  const userId = options.get('--user-id');
  const sessionHandle = options.get('--session-handle');
  const actor = options.get('--actor');
  const reason = options.get('--reason');
  const ticket = options.get('--ticket');
  if (typeof companyId !== 'string' || !COMPANY_ID.test(companyId)) fail('company id is invalid');
  if (typeof userId !== 'string' || !UUID.test(userId)) fail('user id is invalid');
  if (typeof sessionHandle !== 'string' || !UUID.test(sessionHandle)) fail('session is invalid');
  if (typeof actor !== 'string' || !ACTOR.test(actor)) fail('actor is invalid');
  if (reason !== 'investigate_staging_voice_failure') fail('reason is invalid');
  if (typeof ticket !== 'string' || !TICKET.test(ticket)) fail('ticket is invalid');
  const includeContent = options.get('--include-content') === true;
  return Object.freeze({
    directUrl: required(environment, 'DIRECT_URL', 4_096),
    psql: environment.PSQL_BIN ?? 'psql',
    companyId,
    userId: userId.toLowerCase(),
    sessionHandle: sessionHandle.toLowerCase(),
    actor,
    reason,
    ticket,
    includeContent,
    keyring: includeContent
      ? parseKeyring(required(environment, 'VOICE_TRACE_REALTIME_V2_ENCRYPTION_KEYRING'))
      : new Map(),
  });
}

function deriveEncryptionKey(root) {
  return Buffer.from(hkdfSync('sha256', root, TRACE_HKDF_SALT, TRACE_ENCRYPTION_INFO, 32));
}

export function decryptRealtimeVoiceTraceV2Field(row, field, keyring) {
  const ciphertext =
    field === 'transcript' ? row.transcriptCiphertext : row.canonicalReplyCiphertext;
  if (ciphertext === null || ciphertext === undefined) return null;
  if (typeof ciphertext !== 'string' || typeof row.encryptionKeyVersion !== 'number') {
    fail('encrypted row contract is invalid');
  }
  const parts = ciphertext.split('.');
  if (parts.length !== 4 || parts[0] !== `v${row.encryptionKeyVersion}`) {
    fail('ciphertext envelope is invalid');
  }
  const root = keyring.get(row.encryptionKeyVersion);
  if (root === undefined) fail('retained encryption key version is unavailable');
  const nonce = Buffer.from(parts[1], 'base64url');
  const encrypted = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  if (nonce.byteLength !== 12 || tag.byteLength !== 16) fail('ciphertext envelope is invalid');
  const aad = Buffer.from(
    JSON.stringify([
      1,
      row.id,
      row.companyId,
      row.userId,
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
  );
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveEncryptionKey(root), nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    fail('ciphertext authentication failed');
  }
}

function readerSql() {
  return String.raw`
SET statement_timeout = '5s';
SELECT pg_catalog.json_build_object('kind', 'reader', 'actor', session_user)::TEXT;
SELECT pg_catalog.row_to_json(trace)::TEXT
  FROM public.read_realtime_voice_trace_session_v3(
    :'request_id'::UUID,
    :'company_id'::TEXT,
    :'user_id'::UUID,
    :'session_handle'::UUID,
    :'reason'::TEXT,
    :'ticket'::TEXT,
    :'include_content'::BOOLEAN
  ) AS trace;
`;
}

function parseDatabaseOutput(stdout, input) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
    fail('database output is invalid');
  }
  const lines = stdout.split('\n').filter((line) => line.length > 0 && line !== 'SET');
  if (lines.length < 1) fail('database output is incomplete');
  let marker;
  let rows;
  try {
    marker = JSON.parse(lines[0]);
    rows = lines.slice(1).map((line) => JSON.parse(line));
  } catch {
    fail('database output is invalid');
  }
  if (marker?.kind !== 'reader' || marker.actor !== input.actor) {
    fail('database actor does not match the explicit operator');
  }
  return rows.map((row) => {
    const occurredAt = new Date(row.occurredAt);
    if (!Number.isFinite(occurredAt.getTime())) fail('database row timestamp is invalid');
    const safe = {
      ...row,
      occurredAt: occurredAt.toISOString(),
      companyId: input.companyId,
      userId: input.userId,
    };
    if (!input.includeContent) {
      delete safe.transcriptCiphertext;
      delete safe.canonicalReplyCiphertext;
      return safe;
    }
    const transcript = decryptRealtimeVoiceTraceV2Field(safe, 'transcript', input.keyring);
    const canonicalReply = decryptRealtimeVoiceTraceV2Field(safe, 'canonicalReply', input.keyring);
    delete safe.transcriptCiphertext;
    delete safe.canonicalReplyCiphertext;
    return { ...safe, transcript, canonicalReply };
  });
}

export function runRealtimeVoiceTraceV2Reader(argv, environment = process.env, dependencies = {}) {
  const input = parseRealtimeVoiceTraceV2ReaderInput(argv, environment, dependencies.tty);
  (dependencies.certifyDatabase ?? certifyM1BStagingDatabase)(environment, dependencies);
  const spawn = dependencies.spawnSync ?? spawnSync;
  const requestId = (dependencies.randomUUID ?? randomUUID)().toLowerCase();
  if (!UUID.test(requestId)) fail('request id generator is invalid');
  const result = withPsqlChildEnvironment(input.directUrl, environment, (childEnvironment) =>
    spawn(
      input.psql,
      [
        '--no-psqlrc',
        '--quiet',
        '--tuples-only',
        '--no-align',
        '--set=ON_ERROR_STOP=1',
        `--set=request_id=${requestId}`,
        `--set=company_id=${input.companyId}`,
        `--set=user_id=${input.userId}`,
        `--set=session_handle=${input.sessionHandle}`,
        `--set=reason=${input.reason}`,
        `--set=ticket=${input.ticket}`,
        `--set=include_content=${input.includeContent ? 'true' : 'false'}`,
      ],
      boundedPsqlSpawnOptions(childEnvironment, {
        input: readerSql(),
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
      }),
    ),
  );
  if (result?.status !== 0) fail('database operation failed');
  return parseDatabaseOutput(result.stdout, input);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const rows = runRealtimeVoiceTraceV2Reader(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'reader failed'}\n`);
    process.exitCode = 1;
  }
}

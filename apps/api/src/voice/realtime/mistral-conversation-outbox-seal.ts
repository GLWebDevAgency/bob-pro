import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import type { MistralConversationDurableCommand } from './mistral-conversation-gateway-v2';

const POSTGRES_INT_MAX = 2_147_483_647;
const UINT32_MAX = 0xffff_ffff;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const SESSION_HANDLE = /^[A-Za-z0-9_-]{16,128}$/u;
const EVENT_TYPE = /^[a-z][a-z0-9_.]{0,63}$/u;
const COMMAND_ID = /^[A-Za-z0-9:_.-]{1,200}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_EVENT_BYTES = 16_384;

export interface MistralConversationPersistenceKeyRing {
  readonly currentVersion: number;
  /** Clés 256 bits brutes ; versions anciennes gardées jusqu'à purge de leur dernière mission. */
  secret(version: number): Uint8Array | null;
}

export interface MistralConversationOutboxBinding {
  readonly companyId: string;
  readonly sessionHandle: string;
  readonly serverSequence: number;
  readonly eventType: string;
  readonly payloadBytes: number;
}

export interface MistralConversationSealedOutboxPayload {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly tag: Uint8Array;
  readonly keyVersion: number;
}

export interface MistralConversationCommandFingerprint {
  readonly commandIdHash: string;
  readonly payloadHmac: string;
  readonly proofKeyVersion: number;
}

export interface MistralConversationCommandBinding {
  readonly companyId: string;
  readonly sessionHandle: string;
  readonly missionConnectionEpoch: number;
}

function validVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= POSTGRES_INT_MAX;
}

function validSecret(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === 32;
}

function secretFor(
  keyRing: MistralConversationPersistenceKeyRing,
  version: number,
): Buffer | null {
  try {
    const secret = keyRing.secret(version);
    return validSecret(secret) ? Buffer.from(secret) : null;
  } catch {
    return null;
  }
}

export function validateMistralConversationPersistenceKeyRing(
  keyRing: MistralConversationPersistenceKeyRing,
): void {
  if (!validVersion(keyRing.currentVersion) || secretFor(keyRing, keyRing.currentVersion) === null) {
    throw new Error('Invalid Mistral conversation persistence key ring.');
  }
}

function validBinding(binding: MistralConversationOutboxBinding): boolean {
  return COMPANY_ID.test(binding.companyId)
    && SESSION_HANDLE.test(binding.sessionHandle)
    && Number.isSafeInteger(binding.serverSequence)
    && binding.serverSequence >= 0
    && binding.serverSequence <= UINT32_MAX
    && EVENT_TYPE.test(binding.eventType)
    && Number.isSafeInteger(binding.payloadBytes)
    && binding.payloadBytes >= 1
    && binding.payloadBytes <= MAX_EVENT_BYTES;
}

function key(secret: Uint8Array, version: number, purpose: 'outbox' | 'command-proof'): Buffer {
  return createHmac('sha256', secret)
    .update(`bob-pro:mistral-conversation:${purpose}:key:v1\u0000${version}`, 'utf8')
    .digest();
}

function outboxAad(binding: MistralConversationOutboxBinding, keyVersion: number): Buffer {
  return Buffer.from([
    'bob.mistral-pcm.v2',
    'outbox-aad-v1',
    String(keyVersion),
    binding.companyId,
    binding.sessionHandle,
    String(binding.serverSequence),
    binding.eventType,
    String(binding.payloadBytes),
  ].join('\u0000'), 'utf8');
}

export function sealMistralConversationOutboxPayload(
  encodedEvent: string,
  binding: MistralConversationOutboxBinding,
  keyRing: MistralConversationPersistenceKeyRing,
  nonceFactory: () => Uint8Array = () => randomBytes(12),
): MistralConversationSealedOutboxPayload {
  const payload = Buffer.from(encodedEvent, 'utf8');
  const version = keyRing.currentVersion;
  const secret = validVersion(version) ? secretFor(keyRing, version) : null;
  if (!validBinding(binding) || payload.byteLength !== binding.payloadBytes || secret === null) {
    throw new Error('Invalid Mistral conversation outbox payload.');
  }
  const nonce = Uint8Array.from(nonceFactory());
  if (nonce.byteLength !== 12) throw new Error('Invalid Mistral conversation outbox nonce.');
  const cipher = createCipheriv('aes-256-gcm', key(secret, version, 'outbox'), nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(outboxAad(binding, version));
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Object.freeze({
    ciphertext: new Uint8Array(ciphertext),
    nonce,
    tag: new Uint8Array(cipher.getAuthTag()),
    keyVersion: version,
  });
}

export function openMistralConversationOutboxPayload(
  sealed: MistralConversationSealedOutboxPayload,
  binding: MistralConversationOutboxBinding,
  keyRing: MistralConversationPersistenceKeyRing,
): string | null {
  try {
    if (
      !validBinding(binding)
      || !validVersion(sealed.keyVersion)
      || !(sealed.ciphertext instanceof Uint8Array)
      || sealed.ciphertext.byteLength !== binding.payloadBytes
      || !(sealed.nonce instanceof Uint8Array)
      || sealed.nonce.byteLength !== 12
      || !(sealed.tag instanceof Uint8Array)
      || sealed.tag.byteLength !== 16
    ) return null;
    const secret = secretFor(keyRing, sealed.keyVersion);
    if (secret === null) return null;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key(secret, sealed.keyVersion, 'outbox'),
      sealed.nonce,
      { authTagLength: 16 },
    );
    decipher.setAAD(outboxAad(binding, sealed.keyVersion));
    decipher.setAuthTag(sealed.tag);
    const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
    if (plaintext.byteLength !== binding.payloadBytes) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch {
    return null;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error('Invalid command number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new Error('Invalid command value.');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((name) => (
    `${JSON.stringify(name)}:${canonicalJson(record[name])}`
  )).join(',')}}`;
}

export function fingerprintMistralConversationCommand(
  command: MistralConversationDurableCommand,
  binding: MistralConversationCommandBinding,
  keyRing: MistralConversationPersistenceKeyRing,
  proofKeyVersion = keyRing.currentVersion,
): MistralConversationCommandFingerprint {
  if (
    !COMPANY_ID.test(binding.companyId)
    || !SESSION_HANDLE.test(binding.sessionHandle)
    || !Number.isSafeInteger(binding.missionConnectionEpoch)
    || binding.missionConnectionEpoch < 1
    || binding.missionConnectionEpoch > POSTGRES_INT_MAX
    || !COMMAND_ID.test(command.commandId)
    || !validVersion(proofKeyVersion)
  ) throw new Error('Invalid Mistral conversation command fingerprint input.');
  const secret = secretFor(keyRing, proofKeyVersion);
  if (secret === null) throw new Error('Mistral conversation command proof key unavailable.');
  const canonical = canonicalJson(command);
  const payloadHmac = createHmac('sha256', key(secret, proofKeyVersion, 'command-proof'))
    .update([
      'bob.mistral-pcm.v2',
      'command-proof-v1',
      binding.companyId,
      binding.sessionHandle,
      String(binding.missionConnectionEpoch),
      canonical,
    ].join('\u0000'), 'utf8')
    .digest('hex');
  return {
    commandIdHash: createHash('sha256').update(command.commandId, 'utf8').digest('hex'),
    payloadHmac,
    proofKeyVersion,
  };
}

export function isMistralConversationPersistenceHash(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

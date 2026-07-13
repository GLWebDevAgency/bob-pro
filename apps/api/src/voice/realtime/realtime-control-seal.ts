import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { isAllowedAgentNavigationRoute, type AgentRunKind } from '@bob/ai';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const MAX_CONTROL_BYTES = 32 * 1024;
const MAX_ROUTE_BYTES = 1_024;

export interface RealtimeControlBinding {
  readonly companyId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly artifactId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
}

export interface RealtimeActionableControl {
  readonly turnId: string;
  readonly kind: AgentRunKind;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly navigate?: string;
  readonly proposalId?: string;
  readonly proposalExpiresAt?: string;
}

export interface RealtimeSealedControl {
  readonly controlKind: 'navigate' | 'proposal';
  readonly sealedControl: Uint8Array;
  readonly controlNonce: Uint8Array;
  readonly controlTag: Uint8Array;
  readonly controlPayloadHmac: string;
  readonly encryptionKeyVersion: number;
  readonly proofKeyVersion: number;
}

export interface RealtimeControlSealKeys {
  readonly encryptionSecret: string;
  readonly encryptionKeyVersion: number;
  readonly proofSecret: string;
  readonly proofKeyVersion: number;
}

export interface RealtimeControlKeyRing {
  encryptionSecret(version: number): string | null;
  proofSecret(version: number): string | null;
}

function validVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
}

function validSecret(value: string): boolean {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') >= 32
    && !value.includes('[')
    && !value.includes(']');
}

function validBinding(binding: RealtimeControlBinding): boolean {
  return COMPANY_ID.test(binding.companyId)
    && UUID.test(binding.sessionId)
    && UUID.test(binding.turnId)
    && UUID.test(binding.artifactId)
    && Number.isSafeInteger(binding.contextRevision)
    && binding.contextRevision >= 1
    && binding.contextRevision <= 2_147_483_647
    && SHA256_HEX.test(binding.contextDigest);
}

function aad(binding: RealtimeControlBinding, controlKind: 'navigate' | 'proposal', keyVersion: number): Buffer {
  return Buffer.from([
    'bob-pro:realtime-control:aad:v1',
    String(keyVersion),
    binding.companyId,
    binding.sessionId.toLowerCase(),
    binding.turnId.toLowerCase(),
    binding.artifactId.toLowerCase(),
    String(binding.contextRevision),
    binding.contextDigest,
    controlKind,
  ].join('\u0000'), 'utf8');
}

function key(secret: string, version: number): Buffer {
  return createHmac('sha256', secret)
    .update(`bob-pro:realtime-control:encryption-key:v1\u0000${version}`, 'utf8')
    .digest();
}

function payloadMac(
  secret: string,
  proofKeyVersion: number,
  encryptionKeyVersion: number,
  binding: RealtimeControlBinding,
  controlKind: 'navigate' | 'proposal',
  plaintext: Uint8Array,
): string {
  return createHmac('sha256', secret)
    .update(
      `bob-pro:realtime-control:payload:v1\u0000${proofKeyVersion}\u0000${encryptionKeyVersion}`,
      'utf8',
    )
    .update('\u0000', 'utf8')
    .update(aad(binding, controlKind, encryptionKeyVersion))
    .update('\u0000', 'utf8')
    .update(plaintext)
    .digest('hex');
}

function actionKind(control: RealtimeActionableControl): 'navigate' | 'proposal' | null {
  if (control.proposalId !== undefined) return 'proposal';
  if (control.navigate !== undefined) return 'navigate';
  return null;
}

function canonicalControl(
  control: RealtimeActionableControl,
  binding: RealtimeControlBinding,
): Record<string, unknown> | null {
  const allowedKind = control.kind === 'answer' || control.kind === 'proposed' || control.kind === 'done';
  if (!allowedKind
    || control.turnId !== binding.turnId
    || control.contextRevision !== binding.contextRevision
    || control.contextDigest !== binding.contextDigest
    || (control.navigate !== undefined && (
      Buffer.byteLength(control.navigate, 'utf8') > MAX_ROUTE_BYTES
      || !isAllowedAgentNavigationRoute(control.navigate)
    ))
    || (control.proposalId !== undefined && !UUID.test(control.proposalId))
    || (control.proposalExpiresAt !== undefined && (
      control.proposalId === undefined
      || control.proposalExpiresAt.length > 40
      || !Number.isFinite(Date.parse(control.proposalExpiresAt))
    ))) return null;
  const kind = actionKind(control);
  if (kind === null) return null;
  return {
    version: 1,
    turnId: binding.turnId.toLowerCase(),
    kind: control.kind,
    contextRevision: binding.contextRevision,
    contextDigest: binding.contextDigest,
    ...(control.navigate === undefined ? {} : { navigate: control.navigate }),
    ...(control.proposalId === undefined ? {} : { proposalId: control.proposalId.toLowerCase() }),
    ...(control.proposalExpiresAt === undefined ? {} : { proposalExpiresAt: control.proposalExpiresAt }),
  };
}

export function sealRealtimeControl(
  control: RealtimeActionableControl,
  binding: RealtimeControlBinding,
  keys: RealtimeControlSealKeys,
  nonceFactory: () => Uint8Array = () => randomBytes(12),
): RealtimeSealedControl {
  if (!validBinding(binding)
    || !validSecret(keys.encryptionSecret)
    || !validSecret(keys.proofSecret)
    || !validVersion(keys.encryptionKeyVersion)
    || !validVersion(keys.proofKeyVersion)) {
    throw new Error('Invalid realtime control seal input.');
  }
  const canonical = canonicalControl(control, binding);
  const controlKind = actionKind(control);
  if (canonical === null || controlKind === null) throw new Error('Invalid realtime control payload.');
  const plaintext = Buffer.from(JSON.stringify(canonical), 'utf8');
  if (plaintext.byteLength < 1 || plaintext.byteLength > MAX_CONTROL_BYTES) {
    throw new Error('Invalid realtime control payload size.');
  }
  const nonce = new Uint8Array(nonceFactory());
  if (nonce.byteLength !== 12) throw new Error('Invalid realtime control nonce.');
  const cipher = createCipheriv(
    'aes-256-gcm',
    key(keys.encryptionSecret, keys.encryptionKeyVersion),
    nonce,
    { authTagLength: 16 },
  );
  cipher.setAAD(aad(binding, controlKind, keys.encryptionKeyVersion));
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Object.freeze({
    controlKind,
    sealedControl: new Uint8Array(sealed),
    controlNonce: new Uint8Array(nonce),
    controlTag: new Uint8Array(tag),
    controlPayloadHmac: payloadMac(
      keys.proofSecret,
      keys.proofKeyVersion,
      keys.encryptionKeyVersion,
      binding,
      controlKind,
      plaintext,
    ),
    encryptionKeyVersion: keys.encryptionKeyVersion,
    proofKeyVersion: keys.proofKeyVersion,
  });
}

function safeJson(value: Uint8Array): unknown {
  if (value.byteLength < 1 || value.byteLength > MAX_CONTROL_BYTES) return null;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value)) as unknown;
  } catch {
    return null;
  }
}

function decodedControl(
  value: unknown,
  binding: RealtimeControlBinding,
  now: number,
): RealtimeActionableControl | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'version', 'turnId', 'kind', 'contextRevision', 'contextDigest',
    'navigate', 'proposalId', 'proposalExpiresAt',
  ]);
  if (Object.keys(record).some((field) => !allowed.has(field))
    || record.version !== 1
    || record.turnId !== binding.turnId.toLowerCase()
    || (record.kind !== 'answer' && record.kind !== 'proposed' && record.kind !== 'done')
    || record.contextRevision !== binding.contextRevision
    || record.contextDigest !== binding.contextDigest
    || (record.navigate !== undefined && (
      typeof record.navigate !== 'string'
      || Buffer.byteLength(record.navigate, 'utf8') > MAX_ROUTE_BYTES
      || !isAllowedAgentNavigationRoute(record.navigate)
    ))
    || (record.proposalId !== undefined && (
      typeof record.proposalId !== 'string' || !UUID.test(record.proposalId)
    ))
    || (record.proposalExpiresAt !== undefined && (
      typeof record.proposalExpiresAt !== 'string'
      || record.proposalExpiresAt.length > 40
      || !Number.isFinite(Date.parse(record.proposalExpiresAt))
      || Date.parse(record.proposalExpiresAt) <= now
      || record.proposalId === undefined
    ))
    || (record.navigate === undefined && record.proposalId === undefined)) return null;
  return {
    turnId: binding.turnId,
    kind: record.kind,
    contextRevision: binding.contextRevision,
    contextDigest: binding.contextDigest,
    ...(typeof record.navigate === 'string' ? { navigate: record.navigate } : {}),
    ...(typeof record.proposalId === 'string' ? { proposalId: record.proposalId } : {}),
    ...(typeof record.proposalExpiresAt === 'string' ? { proposalExpiresAt: record.proposalExpiresAt } : {}),
  };
}

export function openRealtimeControl(
  sealed: RealtimeSealedControl,
  binding: RealtimeControlBinding,
  keys: RealtimeControlKeyRing,
  now: number = Date.now(),
): RealtimeActionableControl | null {
  try {
    if (!validBinding(binding)
      || !validVersion(sealed.encryptionKeyVersion)
      || !validVersion(sealed.proofKeyVersion)
      || (sealed.controlKind !== 'navigate' && sealed.controlKind !== 'proposal')
      || !(sealed.sealedControl instanceof Uint8Array)
      || sealed.sealedControl.byteLength < 1
      || sealed.sealedControl.byteLength > MAX_CONTROL_BYTES
      || !(sealed.controlNonce instanceof Uint8Array)
      || sealed.controlNonce.byteLength !== 12
      || !(sealed.controlTag instanceof Uint8Array)
      || sealed.controlTag.byteLength !== 16
      || !SHA256_HEX.test(sealed.controlPayloadHmac)
      || !Number.isFinite(now)) return null;
    const encryptionSecret = keys.encryptionSecret(sealed.encryptionKeyVersion);
    const proofSecret = keys.proofSecret(sealed.proofKeyVersion);
    if (encryptionSecret === null || proofSecret === null
      || !validSecret(encryptionSecret) || !validSecret(proofSecret)) return null;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key(encryptionSecret, sealed.encryptionKeyVersion),
      sealed.controlNonce,
      { authTagLength: 16 },
    );
    decipher.setAAD(aad(binding, sealed.controlKind, sealed.encryptionKeyVersion));
    decipher.setAuthTag(sealed.controlTag);
    const plaintext = Buffer.concat([
      decipher.update(sealed.sealedControl),
      decipher.final(),
    ]);
    const expectedMac = payloadMac(
      proofSecret,
      sealed.proofKeyVersion,
      sealed.encryptionKeyVersion,
      binding,
      sealed.controlKind,
      plaintext,
    );
    const actual = Buffer.from(sealed.controlPayloadHmac, 'hex');
    const expected = Buffer.from(expectedMac, 'hex');
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return null;
    const control = decodedControl(safeJson(plaintext), binding, now);
    if (control === null || actionKind(control) !== sealed.controlKind) return null;
    return control;
  } catch {
    return null;
  }
}

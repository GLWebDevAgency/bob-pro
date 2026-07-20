import { createHmac, timingSafeEqual, type Hmac } from 'node:crypto';
import {
  hashMistralConversationResumeTicket,
  isMistralConversationResumeTicket,
} from './mistral-conversation-resume-ticket';

const POSTGRES_INT_MAX = 0x7fff_ffff;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const SUBJECT_HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SESSION_HANDLE = /^[A-Za-z0-9_-]{16,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TICKET_DERIVATION_DOMAIN =
  'bob-pro:mistral-conversation-bootstrap-reconciliation:resume-ticket:v1';
const TICKET_ID_DERIVATION_DOMAIN =
  'bob-pro:mistral-conversation-bootstrap-reconciliation:resume-ticket-id:v1';

export const MISTRAL_CONVERSATION_BOOTSTRAP_RECONCILIATION_MAX_ATTEMPTS = 8;

export const MISTRAL_CONVERSATION_BOOTSTRAP_RECONCILIATION_RESULT = Object.freeze({
  retryInitial: 'retry_initial',
  issued: 'issued',
  attemptConsumed: 'attempt_consumed',
} as const);

export type MistralConversationBootstrapReconciliationResultStatus =
  typeof MISTRAL_CONVERSATION_BOOTSTRAP_RECONCILIATION_RESULT[
    keyof typeof MISTRAL_CONVERSATION_BOOTSTRAP_RECONCILIATION_RESULT
  ];

export type MistralConversationBootstrapReconciliationDecision =
  | {
      readonly status:
        typeof MISTRAL_CONVERSATION_BOOTSTRAP_RECONCILIATION_RESULT.retryInitial;
    }
  | {
      readonly status:
        typeof MISTRAL_CONVERSATION_BOOTSTRAP_RECONCILIATION_RESULT.issued;
    }
  | {
      readonly status:
        typeof MISTRAL_CONVERSATION_BOOTSTRAP_RECONCILIATION_RESULT.attemptConsumed;
    };

export interface MistralConversationBootstrapReconciliationDerivationInput {
  /** Copié avant usage ; le buffer fourni par l'appelant n'est jamais modifié. */
  readonly secret: Uint8Array;
  readonly keyVersion: number;
  readonly companyId: string;
  readonly subjectHash: string;
  readonly initialBootstrapId: string;
  readonly sessionHandle: string;
  readonly attempt: number;
}

/** Capacité transitoire à rendre au client ; ne doit jamais être sérialisée en BDD. */
export interface MistralConversationBootstrapReconciliationCapability {
  readonly ticketId: string;
  readonly ticket: string;
  readonly ticketHash: string;
  readonly keyVersion: number;
  readonly attempt: number;
}

/** Projection persistable : le ticket brut est volontairement absent de ce contrat. */
export interface MistralConversationBootstrapReconciliationSnapshot {
  readonly ticketId: string;
  readonly ticketHash: string;
  readonly keyVersion: number;
  readonly attempt: number;
}

export function isMistralConversationBootstrapReconciliationAttempt(
  value: unknown,
): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && value >= 1
    && value <= MISTRAL_CONVERSATION_BOOTSTRAP_RECONCILIATION_MAX_ATTEMPTS;
}

function isPositivePostgresInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && value >= 1
    && value <= POSTGRES_INT_MAX;
}

function isDerivationInput(
  value: unknown,
): value is MistralConversationBootstrapReconciliationDerivationInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Partial<MistralConversationBootstrapReconciliationDerivationInput>;
  return input.secret instanceof Uint8Array
    && input.secret.byteLength === 32
    && isPositivePostgresInteger(input.keyVersion)
    && typeof input.companyId === 'string'
    && COMPANY_ID.test(input.companyId)
    && typeof input.subjectHash === 'string'
    && SUBJECT_HASH.test(input.subjectHash)
    && typeof input.initialBootstrapId === 'string'
    && UUID.test(input.initialBootstrapId)
    && typeof input.sessionHandle === 'string'
    && SESSION_HANDLE.test(input.sessionHandle)
    && isMistralConversationBootstrapReconciliationAttempt(input.attempt);
}

/**
 * Ajoute un champ auto-délimité. Le nom et la valeur sont tous deux préfixés par leur longueur,
 * afin qu'aucun déplacement de frontière entre deux champs ne puisse conserver le même MAC.
 */
function updateLengthPrefixedField(mac: Hmac, name: string, value: string): void {
  let nameBytes: Buffer | null = null;
  let valueBytes: Buffer | null = null;
  let length: Buffer | null = null;
  try {
    nameBytes = Buffer.from(name, 'utf8');
    valueBytes = Buffer.from(value, 'utf8');
    length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(nameBytes.byteLength, 0);
    mac.update(length);
    mac.update(nameBytes);
    length.writeUInt32BE(valueBytes.byteLength, 0);
    mac.update(length);
    mac.update(valueBytes);
  } finally {
    // Best effort : les chaînes JS appartiennent à l'appelant, mais nos copies locales non.
    length?.fill(0);
    nameBytes?.fill(0);
    valueBytes?.fill(0);
  }
}

function deriveDigest(
  secret: Buffer,
  domain: string,
  input: MistralConversationBootstrapReconciliationDerivationInput,
): Buffer {
  const mac = createHmac('sha256', secret);
  updateLengthPrefixedField(mac, 'domain', domain);
  updateLengthPrefixedField(mac, 'keyVersion', String(input.keyVersion));
  updateLengthPrefixedField(mac, 'companyId', input.companyId);
  updateLengthPrefixedField(mac, 'subjectHash', input.subjectHash);
  updateLengthPrefixedField(mac, 'initialBootstrapId', input.initialBootstrapId);
  updateLengthPrefixedField(mac, 'sessionHandle', input.sessionHandle);
  updateLengthPrefixedField(mac, 'attempt', String(input.attempt));
  return mac.digest();
}

function uuidFromDigest(digest: Buffer): string {
  // Le digest HMAC est pseudo-aléatoire ; on lui applique le layout UUID v4 et le variant RFC4122.
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x40;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Reconstruit la même capacité après une réponse initiale perdue, tout en séparant chaque tenant,
 * sujet, bootstrap, session, tentative et version de clé. Seule la projection sans `ticket` est
 * destinée à la persistance.
 */
export function deriveMistralConversationBootstrapReconciliationCapability(
  input: MistralConversationBootstrapReconciliationDerivationInput,
): MistralConversationBootstrapReconciliationCapability {
  if (!isDerivationInput(input)) {
    throw new Error('Invalid Mistral conversation bootstrap reconciliation input.');
  }

  const secret = Buffer.from(input.secret);
  let ticketDigest: Buffer | null = null;
  let ticketIdDigest: Buffer | null = null;
  try {
    ticketDigest = deriveDigest(secret, TICKET_DERIVATION_DOMAIN, input);
    ticketIdDigest = deriveDigest(secret, TICKET_ID_DERIVATION_DOMAIN, input);
    const ticket = `r2_${ticketDigest.toString('base64url')}`;
    return Object.freeze({
      ticketId: uuidFromDigest(ticketIdDigest),
      ticket,
      ticketHash: hashMistralConversationResumeTicket(ticket),
      keyVersion: input.keyVersion,
      attempt: input.attempt,
    });
  } finally {
    ticketDigest?.fill(0);
    ticketIdDigest?.fill(0);
    secret.fill(0);
  }
}

export function snapshotMistralConversationBootstrapReconciliationCapability(
  capability: MistralConversationBootstrapReconciliationCapability,
): MistralConversationBootstrapReconciliationSnapshot {
  if (
    !UUID.test(capability.ticketId)
    || !isMistralConversationResumeTicket(capability.ticket)
    || !SHA256.test(capability.ticketHash)
    || !areMistralConversationBootstrapReconciliationTicketHashesEqual(
      capability.ticketHash,
      hashMistralConversationResumeTicket(capability.ticket),
    )
    || !isPositivePostgresInteger(capability.keyVersion)
    || !isMistralConversationBootstrapReconciliationAttempt(capability.attempt)
  ) throw new Error('Invalid Mistral conversation bootstrap reconciliation capability.');
  return Object.freeze({
    ticketId: capability.ticketId,
    ticketHash: capability.ticketHash,
    keyVersion: capability.keyVersion,
    attempt: capability.attempt,
  });
}

/** Compare deux empreintes persistées sans comparaison de chaînes dépendante du premier écart. */
export function areMistralConversationBootstrapReconciliationTicketHashesEqual(
  expected: unknown,
  actual: unknown,
): boolean {
  if (
    typeof expected !== 'string'
    || typeof actual !== 'string'
    || !SHA256.test(expected)
    || !SHA256.test(actual)
  ) return false;
  const expectedBytes = Buffer.from(expected, 'hex');
  const actualBytes = Buffer.from(actual, 'hex');
  try {
    return timingSafeEqual(expectedBytes, actualBytes);
  } finally {
    expectedBytes.fill(0);
    actualBytes.fill(0);
  }
}

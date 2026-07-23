import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createCanonicalSpeechEnvelope } from '@bob/ai';
import {
  OPENAI_NATIVE_SPEECH_DELIVERY_MAX_TTL_MS,
  OPENAI_NATIVE_SPEECH_POLICY_VERSION,
  OpenAiNativeSpeechDeliveryError,
  assertOpenAiNativeSpeechDeliveryState,
  createOpenAiNativeSpeechDelivery,
  isOpenAiNativeLocalObservation,
  isOpenAiNativeSpeechSlo,
  openAiNativeSpeechDeliveryKey,
  transitionOpenAiNativeSpeechDelivery,
  type OpenAiNativeSpeechCancellationReason,
  type OpenAiNativeSpeechDeliveryCompareAndSwapInput,
  type OpenAiNativeSpeechDeliveryCompareAndSwapResult,
  type OpenAiNativeSpeechDeliveryEvent,
  type OpenAiNativeSpeechDeliveryKey,
  type OpenAiNativeSpeechDeliveryPrepareResult,
  type OpenAiNativeSpeechDeliveryReadResult,
  type OpenAiNativeSpeechDeliveryRepositoryPort,
  type OpenAiNativeSpeechDeliveryState,
  type OpenAiNativeSpeechFailureReason,
  type OpenAiNativeLocalObservation,
  type OpenAiNativeSpeechSlo,
} from './openai-native-speech-delivery';
import {
  createOpenAiNativeProviderResponseIdHmac,
  createOpenAiNativeSpeechPreparationProof,
  createOpenAiNativeSpeechTranscriptHmac,
  type OpenAiNativeSpeechProofBinding,
} from './openai-native-speech-proof';
import type { OpenAiNativeResponseRequest } from './openai-native-response-protocol';
import {
  OPENAI_NATIVE_ELIGIBLE_SPEECH_V1,
  deriveOpenAiNativeSpeechRisk,
  type OpenAiNativeSpeechRiskDecision,
  type OpenAiNativeSpeechRiskInput,
} from './openai-native-speech-risk';

const POSTGRES_INT_MAX = 2_147_483_647;
const DEFAULT_TTL_MS = 120_000;
const MIN_TTL_MS = 10_000;
const MAX_CAS_ATTEMPTS = 5;
const MAX_PREPARE_ATTEMPTS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HMAC_SHA256 = /^[a-f0-9]{64}$/u;
const TENANT_ID = /^[A-Za-z0-9-]{1,64}$/u;
const RISK_KEYS = [
  'purpose',
  'source',
  'runKind',
  'hasTenantContext',
  'hasControl',
] as const;
const RISK_PURPOSES = new Set([
  'generic_assistance',
  'business_answer',
  'structured_choice',
  'navigation',
  'action_proposal',
  'action_result',
]);
const RISK_SOURCES = new Set(['spoken_prompt', 'natural_body', 'card_body', 'card_title']);
const RUN_KINDS = new Set(['answer', 'proposed', 'done']);

export interface OpenAiNativeSpeechProofKeyRing {
  readonly currentVersion: number;
  /** Une ancienne version reste lisible jusqu'a expiration de toutes ses preuves. */
  secret(version: number): string | null;
}

export interface OpenAiNativeSpeechAuthorityConfig {
  readonly proofKeys: OpenAiNativeSpeechProofKeyRing;
  readonly ttlMs?: number;
}

export interface OpenAiNativeSpeechAuthorityEntropy {
  deliveryId(): string;
  requestNonce(): string;
  dispatchClaimId(): string;
}

/**
 * Fence complet d'une parole. Chaque transition le reverifie apres lecture durable et avant CAS.
 * Il ne contient aucun texte, route, proposition ou fait metier.
 */
export interface OpenAiNativeSpeechAuthorityBinding {
  readonly companyId: string;
  readonly subjectHmac: string;
  readonly deliveryId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly sidebandOwnerEpoch: number;
  readonly sidebandOwnerTokenHmac: string;
}

type PreparationBinding = Omit<OpenAiNativeSpeechAuthorityBinding, 'deliveryId'>;

export interface OpenAiNativeSpeechTurnPreparationInput extends PreparationBinding {
  readonly subjectKeyVersion: number;
  readonly canonicalSpeech: string;
  readonly model: string;
  readonly voice: string;
  /** Les signaux proviennent du resultat Bob ; l'autorite recalcule elle-meme la decision. */
  readonly risk: Omit<OpenAiNativeSpeechRiskInput, 'envelope'>;
}

export type OpenAiNativeSpeechTurnPreparationOutcome =
  | {
      readonly status: 'prepared';
      readonly persistence: 'created' | 'already_prepared';
      readonly state: OpenAiNativeSpeechDeliveryState;
      /** Seul objet ephemere contenant la phrase et le nonce non hache. */
      readonly request: OpenAiNativeResponseRequest;
    }
  | {
      readonly status: 'audited_required';
      readonly risk: Extract<OpenAiNativeSpeechRiskDecision, { readonly mode: 'audited_exact' }>;
    }
  | { readonly status: 'conflict' | 'unavailable' };

export type OpenAiNativeSpeechDispatchOutcome =
  | {
      readonly status: 'authorized';
      readonly dispatchClaimId: string;
      readonly state: OpenAiNativeSpeechDeliveryState;
      /** Exact frozen request snapshot whose durable proof was verified before the claim CAS. */
      readonly request: Readonly<OpenAiNativeResponseRequest>;
    }
  | { readonly status: 'not_authorized' | 'not_found' | 'unavailable' };

export interface OpenAiNativeSpeechDispatchClaimInput
  extends OpenAiNativeSpeechAuthorityBinding {
  /** Ephemeral request returned by prepareTurn; verified against durable HMACs before CAS. */
  readonly request: OpenAiNativeResponseRequest;
}

export type OpenAiNativeSpeechTransitionOutcome =
  | {
      readonly status: 'applied' | 'idempotent';
      readonly state: OpenAiNativeSpeechDeliveryState;
    }
  | { readonly status: 'not_found' | 'rejected' | 'unavailable' };

export interface OpenAiNativeSpeechRequestedInput extends OpenAiNativeSpeechAuthorityBinding {
  readonly dispatchClaimId: string;
}

export interface OpenAiNativeSpeechProviderEventInput
  extends OpenAiNativeSpeechAuthorityBinding {
  readonly providerResponseId: string;
}

export interface OpenAiNativeSpeechResponseDoneInput
  extends OpenAiNativeSpeechProviderEventInput {
  readonly providerTranscript: string;
}

export interface OpenAiNativeSpeechAcknowledgementInput
  extends OpenAiNativeSpeechAuthorityBinding {
  readonly acknowledgementId: string;
  readonly localObservation: OpenAiNativeLocalObservation;
  readonly slo: OpenAiNativeSpeechSlo | null;
}

/**
 * Capability etroite exposee au service HTTP mobile. L'owner sideband reste un secret serveur :
 * l'autorite le relit dans la preuve durable au lieu de l'accepter depuis le wire.
 */
interface OpenAiNativeSpeechMobileAcknowledgementFields {
  readonly companyId: string;
  readonly deliveryId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly acknowledgementId: string;
  readonly localObservation: OpenAiNativeLocalObservation;
  readonly slo: OpenAiNativeSpeechSlo | null;
}

/**
 * Le service HTTP passe toute la keyring sujet sous forme de HMAC deja derives afin que
 * l'autorite fasse une seule lecture durable. La forme singuliere reste acceptee uniquement pour
 * les adapters internes V1 ; elle suit exactement le meme chemin et ne declenche jamais une
 * seconde lecture.
 */
export interface OpenAiNativeSpeechMobileAcknowledgementInput
  extends OpenAiNativeSpeechMobileAcknowledgementFields {
  /** Forme production : toutes les versions configurées, courant d'abord. */
  readonly subjectHmacCandidates?: readonly Readonly<{
    readonly version: number;
    readonly subjectHmac: string;
  }>[];
  /** Compatibilité legacy interne : utilisable uniquement pour une ligne N-1 sans version. */
  readonly subjectHmac?: string;
}

export type OpenAiNativeSpeechMobileAcknowledgementOutcome =
  | {
      readonly status: 'applied' | 'idempotent';
      readonly state: OpenAiNativeSpeechDeliveryState;
    }
  | { readonly status: 'not_ready' | 'not_found' | 'conflict' | 'unavailable' };

/**
 * Relecture owner-only après une complétion fournisseur. Elle rend le fast-path HTTP optionnel :
 * l'ACK peut être écrit par une autre réplique et l'owner sideband relit ensuite PostgreSQL.
 */
export type OpenAiNativeSpeechOwnerReconciliationOutcome =
  | {
      readonly status: 'delivered';
      readonly acknowledgementId: string;
      readonly state: OpenAiNativeSpeechDeliveryState;
    }
  | {
      readonly status:
        | 'pending'
        | 'terminal_without_proof'
        | 'not_found'
        | 'rejected'
        | 'unavailable';
    };

export interface OpenAiNativeSpeechCancellationInput
  extends OpenAiNativeSpeechAuthorityBinding {
  /** Cle d'idempotence creee une seule fois par l'appelant puis reutilisee sur retry. */
  readonly cancellationId: string;
  readonly reason: OpenAiNativeSpeechCancellationReason;
}

export interface OpenAiNativeSpeechFailureInput extends OpenAiNativeSpeechAuthorityBinding {
  /** Cle d'idempotence creee une seule fois par l'appelant puis reutilisee sur retry. */
  readonly failureId: string;
  readonly reason: OpenAiNativeSpeechFailureReason;
}

const secureEntropy: OpenAiNativeSpeechAuthorityEntropy = Object.freeze({
  deliveryId: randomUUID,
  requestNonce: () => randomBytes(32).toString('base64url'),
  dispatchClaimId: randomUUID,
});

function validVersion(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && !Object.is(value, -0)
    && value >= 1
    && value <= POSTGRES_INT_MAX;
}

function hasExactRiskSignals(
  value: unknown,
): value is OpenAiNativeSpeechTurnPreparationInput['risk'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== RISK_KEYS.length || keys.some((key) => !RISK_KEYS.includes(
    key as (typeof RISK_KEYS)[number],
  ))) return false;
  const candidate = value as Record<string, unknown>;
  return RISK_PURPOSES.has(candidate.purpose as string)
    && RISK_SOURCES.has(candidate.source as string)
    && RUN_KINDS.has(candidate.runKind as string)
    && typeof candidate.hasTenantContext === 'boolean'
    && typeof candidate.hasControl === 'boolean';
}

function invalidEnvelopeDecision(): Extract<
OpenAiNativeSpeechRiskDecision,
{ readonly mode: 'audited_exact' }
> {
  return Object.freeze({
    version: 1,
    mode: 'audited_exact',
    reasons: Object.freeze(['invalid_envelope'] as const),
  });
}

function factsSha256ForEligibleEnvelope(facts: readonly unknown[]): string {
  // Le chemin natif V1 interdit tout fait. Garder ce calcul local evite une dependance au renderer.
  if (facts.length !== 0) throw new Error('Native speech facts are forbidden.');
  return createHash('sha256').update('[]', 'utf8').digest('hex');
}

function proofBinding(
  state: Pick<
  OpenAiNativeSpeechDeliveryState,
  | 'companyId'
  | 'deliveryId'
  | 'sessionId'
  | 'turnId'
  | 'contextRevision'
  | 'contextDigest'
  | 'speechPolicyVersion'
  | 'speechScenarioId'
  >,
): OpenAiNativeSpeechProofBinding {
  return {
    companyId: state.companyId,
    deliveryId: state.deliveryId,
    sessionId: state.sessionId,
    turnId: state.turnId,
    contextRevision: state.contextRevision,
    contextDigest: state.contextDigest,
    speechPolicyVersion: state.speechPolicyVersion,
    speechScenarioId: state.speechScenarioId,
  };
}

function exactState(
  left: OpenAiNativeSpeechDeliveryState,
  right: OpenAiNativeSpeechDeliveryState,
): boolean {
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length
    && keys.every((key) => {
      const leftValue = leftRecord[key];
      const rightValue = rightRecord[key];
      return Array.isArray(leftValue) && Array.isArray(rightValue)
        ? leftValue.length === rightValue.length
          && leftValue.every((value, index) => Object.is(value, rightValue[index]))
        : Object.is(leftValue, rightValue);
    });
}

function stateMatchesBinding(
  state: OpenAiNativeSpeechDeliveryState,
  binding: OpenAiNativeSpeechAuthorityBinding,
): boolean {
  return state.companyId === binding.companyId
    && state.subjectHmac === binding.subjectHmac
    && state.deliveryId === binding.deliveryId
    && state.sessionId === binding.sessionId
    && state.turnId === binding.turnId
    && state.contextRevision === binding.contextRevision
    && state.contextDigest === binding.contextDigest
    && state.sidebandOwnerEpoch === binding.sidebandOwnerEpoch
    && state.sidebandOwnerTokenHmac === binding.sidebandOwnerTokenHmac;
}

function exactHmac(left: string, right: string): boolean {
  try {
    const leftBytes = Buffer.from(left, 'hex');
    const rightBytes = Buffer.from(right, 'hex');
    return leftBytes.byteLength === 32
      && rightBytes.byteLength === 32
      && timingSafeEqual(leftBytes, rightBytes);
  } catch {
    return false;
  }
}

function requestMatchesPreparedProof(
  state: OpenAiNativeSpeechDeliveryState,
  request: OpenAiNativeResponseRequest,
  secret: string,
): boolean {
  if (
    request.deliveryId !== state.deliveryId
    || request.turnId !== state.turnId
    || request.contextRevision !== state.contextRevision
    || request.contextDigest !== state.contextDigest
    || request.canonicalSpeech !== OPENAI_NATIVE_ELIGIBLE_SPEECH_V1[state.speechScenarioId]
  ) return false;
  try {
    const proof = createOpenAiNativeSpeechPreparationProof({
      secret,
      proofKeyVersion: state.proofKeyVersion,
      binding: proofBinding(state),
      canonicalSpeech: request.canonicalSpeech,
      factsSha256: factsSha256ForEligibleEnvelope([]),
      requestNonce: request.requestNonce,
    });
    return proof.proofFormatVersion === state.proofFormatVersion
      && proof.proofKeyVersion === state.proofKeyVersion
      && exactHmac(proof.canonicalSpeechHmac, state.canonicalSpeechHmac)
      && exactHmac(proof.factsHmac, state.factsHmac)
      && exactHmac(proof.requestNonceHmac, state.requestNonceHmac);
  } catch {
    return false;
  }
}

/**
 * Capture every caller-owned value synchronously, before the first await (and before entropy can
 * invoke arbitrary user code). The authorized capability returns this same frozen request, so a
 * dispatcher never has to trust or reread the caller's mutable object after proof verification.
 */
function snapshotDispatchClaimInput(
  input: OpenAiNativeSpeechDispatchClaimInput,
): Readonly<OpenAiNativeSpeechDispatchClaimInput> | null {
  try {
    const request = Object.freeze({
      deliveryId: input.request.deliveryId,
      turnId: input.request.turnId,
      contextRevision: input.request.contextRevision,
      contextDigest: input.request.contextDigest,
      requestNonce: input.request.requestNonce,
      canonicalSpeech: input.request.canonicalSpeech,
    });
    return Object.freeze({
      companyId: input.companyId,
      subjectHmac: input.subjectHmac,
      deliveryId: input.deliveryId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      contextRevision: input.contextRevision,
      contextDigest: input.contextDigest,
      sidebandOwnerEpoch: input.sidebandOwnerEpoch,
      sidebandOwnerTokenHmac: input.sidebandOwnerTokenHmac,
      request,
    });
  } catch {
    return null;
  }
}

const MOBILE_ACKNOWLEDGEMENT_COMMON_KEYS = [
  'companyId',
  'deliveryId',
  'sessionId',
  'turnId',
  'contextRevision',
  'contextDigest',
  'acknowledgementId',
  'localObservation',
  'slo',
] as const;
const MOBILE_ACKNOWLEDGEMENT_CANDIDATE_KEYS = [
  ...MOBILE_ACKNOWLEDGEMENT_COMMON_KEYS,
  'subjectHmacCandidates',
] as const;
const MOBILE_ACKNOWLEDGEMENT_SINGLE_KEYS = [
  ...MOBILE_ACKNOWLEDGEMENT_COMMON_KEYS,
  'subjectHmac',
] as const;
const MAX_SUBJECT_HMAC_CANDIDATES = 32;

interface OpenAiNativeSpeechMobileAcknowledgementSnapshot
  extends OpenAiNativeSpeechMobileAcknowledgementFields {
  readonly subjectHmacCandidates: readonly Readonly<{
    readonly version: number | null;
    readonly subjectHmac: string;
  }>[];
}

function hasExactObjectKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function copyExactSubjectHmacCandidates(
  value: unknown,
  legacySingle: boolean,
): OpenAiNativeSpeechMobileAcknowledgementSnapshot['subjectHmacCandidates'] | null {
  if (!Array.isArray(value)) return null;
  const length = value.length;
  if (
    !Number.isSafeInteger(length)
    || length < 1
    || length > MAX_SUBJECT_HMAC_CANDIDATES
  ) return null;

  // Refuse trous, proprietes/symboles annexes et tableaux exotiques : la liste authentifiee est
  // une valeur exacte et bornee, pas un conteneur extensible controle par l'appelant.
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== length + 1
    || !ownKeys.includes('length')
    || Array.from({ length }, (_, index) => String(index))
      .some((key) => !ownKeys.includes(key))
  ) return null;

  const copy: Array<Readonly<{ version: number | null; subjectHmac: string }>> = [];
  for (let index = 0; index < length; index += 1) {
    const candidate = value[index];
    if (legacySingle) {
      if (typeof candidate !== 'string' || !HMAC_SHA256.test(candidate)) return null;
      copy.push(Object.freeze({ version: null, subjectHmac: candidate }));
      continue;
    }
    if (
      typeof candidate !== 'object'
      || candidate === null
      || Array.isArray(candidate)
      || !hasExactObjectKeys(candidate, ['version', 'subjectHmac'])
    ) return null;
    const record = candidate as Record<string, unknown>;
    if (
      !validVersion(record.version)
      || typeof record.subjectHmac !== 'string'
      || !HMAC_SHA256.test(record.subjectHmac)
    ) return null;
    copy.push(Object.freeze({
      version: record.version as number,
      subjectHmac: record.subjectHmac,
    }));
  }
  if (
    new Set(copy.map((candidate) => candidate.version)).size !== copy.length
    || new Set(copy.map((candidate) => candidate.subjectHmac)).size !== copy.length
  ) return null;
  return Object.freeze(copy);
}

function cloneSpeechSlo(slo: OpenAiNativeSpeechSlo): OpenAiNativeSpeechSlo {
  const pending = slo.pendingBargeIn;
  return Object.freeze({
    ...(slo.speechStoppedEventToFirstInboundRtpMs === undefined
      ? {}
      : { speechStoppedEventToFirstInboundRtpMs: slo.speechStoppedEventToFirstInboundRtpMs }),
    ...(pending === undefined
      ? {}
      : {
          pendingBargeIn: pending.status === 'overflowed'
            ? Object.freeze({ status: 'overflowed' as const })
            : Object.freeze({
                status: 'complete' as const,
                durationsMs: Object.freeze([...pending.durationsMs]),
              }),
        }),
  });
}

/** Capture et valide chaque valeur appelee avant la premiere lecture durable. */
function snapshotMobileAcknowledgementInput(
  input: OpenAiNativeSpeechMobileAcknowledgementInput,
): Readonly<OpenAiNativeSpeechMobileAcknowledgementSnapshot> | null {
  try {
    if (
      typeof input !== 'object'
      || input === null
    ) return null;
    const hasCandidates = hasExactObjectKeys(input, MOBILE_ACKNOWLEDGEMENT_CANDIDATE_KEYS);
    const hasSingle = hasExactObjectKeys(input, MOBILE_ACKNOWLEDGEMENT_SINGLE_KEYS);
    if (hasCandidates === hasSingle) return null;
    const record = input as unknown as Record<string, unknown>;
    // Chaque getter est lu une seule fois avant le premier await. Le service HTTP fournit des
    // objets geles, mais l'autorite reste robuste face a un autre adapter interne mutable.
    const companyId = record.companyId;
    const subjectHmacCandidates = copyExactSubjectHmacCandidates(
      hasCandidates ? record.subjectHmacCandidates : [record.subjectHmac],
      hasSingle,
    );
    const deliveryId = record.deliveryId;
    const sessionId = record.sessionId;
    const turnId = record.turnId;
    const contextRevision = record.contextRevision;
    const contextDigest = record.contextDigest;
    const acknowledgementId = record.acknowledgementId;
    const localObservation = record.localObservation;
    const slo = record.slo;
    if (
      typeof companyId !== 'string'
      || !TENANT_ID.test(companyId)
      || subjectHmacCandidates === null
      || typeof deliveryId !== 'string'
      || !UUID.test(deliveryId.toLowerCase())
      || typeof sessionId !== 'string'
      || !UUID.test(sessionId.toLowerCase())
      || typeof turnId !== 'string'
      || !UUID.test(turnId.toLowerCase())
      || !validVersion(contextRevision)
      || typeof contextDigest !== 'string'
      || !HMAC_SHA256.test(contextDigest)
      || typeof acknowledgementId !== 'string'
      || !UUID.test(acknowledgementId.toLowerCase())
      || !isOpenAiNativeLocalObservation(localObservation)
      || (slo !== null && !isOpenAiNativeSpeechSlo(slo))
    ) return null;
    return Object.freeze({
      companyId,
      subjectHmacCandidates,
      deliveryId: deliveryId.toLowerCase(),
      sessionId: sessionId.toLowerCase(),
      turnId: turnId.toLowerCase(),
      contextRevision,
      contextDigest,
      acknowledgementId: acknowledgementId.toLowerCase(),
      localObservation: Object.freeze({
        formatVersion: localObservation.formatVersion,
        kind: localObservation.kind,
      }),
      slo: slo === null ? null : cloneSpeechSlo(slo),
    });
  } catch {
    return null;
  }
}

function stateMatchesMobileAcknowledgement(
  state: OpenAiNativeSpeechDeliveryState,
  input: OpenAiNativeSpeechMobileAcknowledgementSnapshot,
): boolean {
  let subjectMatches = false;
  for (const candidate of input.subjectHmacCandidates) {
    // Une ligne versionnee n'accepte que le matériau associé à sa version durable. Le parcours
    // complet est réservé aux lignes N-1 dont la version ne peut pas être inventée.
    const versionMatches = state.subjectKeyVersion === null
      || candidate.version === state.subjectKeyVersion;
    const hmacMatches = exactHmac(state.subjectHmac, candidate.subjectHmac);
    subjectMatches = (versionMatches && hmacMatches) || subjectMatches;
  }
  return state.companyId === input.companyId
    && subjectMatches
    && state.deliveryId === input.deliveryId
    && state.sessionId === input.sessionId
    && state.turnId === input.turnId
    && state.contextRevision === input.contextRevision
    && state.contextDigest === input.contextDigest;
}

const OWNER_RECONCILIATION_KEYS = [
  'companyId',
  'subjectHmac',
  'deliveryId',
  'sessionId',
  'turnId',
  'contextRevision',
  'contextDigest',
  'sidebandOwnerEpoch',
  'sidebandOwnerTokenHmac',
] as const;

function snapshotOwnerReconciliationBinding(
  input: OpenAiNativeSpeechAuthorityBinding,
): Readonly<OpenAiNativeSpeechAuthorityBinding> | null {
  try {
    if (
      typeof input !== 'object'
      || input === null
      || !hasExactObjectKeys(input, OWNER_RECONCILIATION_KEYS)
    ) return null;
    const snapshot = Object.freeze({
      companyId: input.companyId,
      subjectHmac: input.subjectHmac,
      deliveryId: input.deliveryId.toLowerCase(),
      sessionId: input.sessionId.toLowerCase(),
      turnId: input.turnId.toLowerCase(),
      contextRevision: input.contextRevision,
      contextDigest: input.contextDigest,
      sidebandOwnerEpoch: input.sidebandOwnerEpoch,
      sidebandOwnerTokenHmac: input.sidebandOwnerTokenHmac,
    });
    return TENANT_ID.test(snapshot.companyId)
      && HMAC_SHA256.test(snapshot.subjectHmac)
      && UUID.test(snapshot.deliveryId)
      && UUID.test(snapshot.sessionId)
      && UUID.test(snapshot.turnId)
      && validVersion(snapshot.contextRevision)
      && HMAC_SHA256.test(snapshot.contextDigest)
      && validVersion(snapshot.sidebandOwnerEpoch)
      && HMAC_SHA256.test(snapshot.sidebandOwnerTokenHmac)
      ? snapshot
      : null;
  } catch {
    return null;
  }
}

function safeState(
  state: OpenAiNativeSpeechDeliveryState,
  key: OpenAiNativeSpeechDeliveryKey,
): boolean {
  try {
    assertOpenAiNativeSpeechDeliveryState(state);
    return state.companyId === key.companyId && state.deliveryId === key.deliveryId;
  } catch {
    return false;
  }
}

/**
 * Autorite pure de la restitution GPT Realtime native.
 *
 * Elle ne connait ni socket, ni Prisma, ni Nest. Le repository est le seul adaptateur. Le texte
 * canonique et le nonce ne sont renvoyes que dans la requete ephemere ; l'etat durable ne contient
 * que des HMAC. Un appelant ne peut envoyer `response.create` que si `claimDispatch` retourne
 * `authorized`, resultat reserve a un CAS effectivement `applied` pendant cet appel.
 */
export class OpenAiNativeSpeechAuthority {
  private readonly ttlMs: number;

  constructor(
    private readonly repository: OpenAiNativeSpeechDeliveryRepositoryPort,
    private readonly config: OpenAiNativeSpeechAuthorityConfig,
    private readonly entropy: OpenAiNativeSpeechAuthorityEntropy = secureEntropy,
    private readonly now: () => number = Date.now,
  ) {
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    const currentSecret = config.proofKeys.secret(config.proofKeys.currentVersion);
    if (
      !validVersion(config.proofKeys.currentVersion)
      || typeof currentSecret !== 'string'
      || Buffer.byteLength(currentSecret, 'utf8') < 32
      || !Number.isSafeInteger(this.ttlMs)
      || this.ttlMs < MIN_TTL_MS
      || this.ttlMs > OPENAI_NATIVE_SPEECH_DELIVERY_MAX_TTL_MS
    ) throw new Error('Invalid OpenAI native speech authority configuration.');
  }

  async prepareTurn(
    input: OpenAiNativeSpeechTurnPreparationInput,
  ): Promise<OpenAiNativeSpeechTurnPreparationOutcome> {
    if (!hasExactRiskSignals(input.risk)) {
      return { status: 'audited_required', risk: invalidEnvelopeDecision() };
    }
    let envelope: ReturnType<typeof createCanonicalSpeechEnvelope>;
    try {
      envelope = createCanonicalSpeechEnvelope(input.canonicalSpeech);
    } catch {
      return { status: 'audited_required', risk: invalidEnvelopeDecision() };
    }

    const risk = deriveOpenAiNativeSpeechRisk({
      envelope,
      purpose: input.risk.purpose,
      source: input.risk.source,
      runKind: input.risk.runKind,
      hasTenantContext: input.risk.hasTenantContext,
      hasControl: input.risk.hasControl,
    });
    if (risk.mode !== 'native_conversational') {
      return { status: 'audited_required', risk };
    }

    // Defense en profondeur : aucune evolution du routeur ne doit elargir silencieusement V1.
    const canonicalSpeech = OPENAI_NATIVE_ELIGIBLE_SPEECH_V1[risk.scenarioId];
    if (
      input.canonicalSpeech !== canonicalSpeech
      || envelope.text !== canonicalSpeech
      || envelope.facts.length !== 0
      || input.risk.hasTenantContext !== false
      || input.risk.hasControl !== false
    ) {
      return { status: 'audited_required', risk: invalidEnvelopeDecision() };
    }

    const deliveryId = this.entropy.deliveryId().toLowerCase();
    const requestNonce = this.entropy.requestNonce();
    const createdAtMs = this.now();
    const proofKeyVersion = this.config.proofKeys.currentVersion;
    const secret = this.config.proofKeys.secret(proofKeyVersion);
    if (
      !UUID.test(deliveryId)
      || typeof requestNonce !== 'string'
      || !Number.isSafeInteger(createdAtMs)
      || createdAtMs < 0
      || secret === null
    ) return { status: 'unavailable' };

    let state: OpenAiNativeSpeechDeliveryState;
    try {
      const binding: OpenAiNativeSpeechProofBinding = {
        companyId: input.companyId,
        deliveryId,
        sessionId: input.sessionId.toLowerCase(),
        turnId: input.turnId.toLowerCase(),
        contextRevision: input.contextRevision,
        contextDigest: input.contextDigest,
        speechPolicyVersion: OPENAI_NATIVE_SPEECH_POLICY_VERSION,
        speechScenarioId: risk.scenarioId,
      };
      const proof = createOpenAiNativeSpeechPreparationProof({
        secret,
        proofKeyVersion,
        binding,
        canonicalSpeech,
        factsSha256: factsSha256ForEligibleEnvelope(envelope.facts),
        requestNonce,
      });
      state = createOpenAiNativeSpeechDelivery({
        ...binding,
        subjectHmac: input.subjectHmac,
        subjectKeyVersion: input.subjectKeyVersion,
        sidebandOwnerEpoch: input.sidebandOwnerEpoch,
        sidebandOwnerTokenHmac: input.sidebandOwnerTokenHmac,
        proofFormatVersion: proof.proofFormatVersion,
        proofKeyVersion: proof.proofKeyVersion,
        canonicalSpeechHmac: proof.canonicalSpeechHmac,
        factsHmac: proof.factsHmac,
        requestNonceHmac: proof.requestNonceHmac,
        provider: 'openai',
        model: input.model,
        voice: input.voice,
        createdAtMs,
        expiresAtMs: createdAtMs + this.ttlMs,
      });
    } catch {
      return { status: 'unavailable' };
    }

    let persisted: OpenAiNativeSpeechDeliveryPrepareResult = { status: 'unavailable' };
    // Une reponse DB perdue est rejouee avec exactement le meme state, nonce et HMAC. Un crash
    // de processus ne peut pas reconstruire le nonce en clair : le nouvel appel echouera alors
    // en conflit sur session/tour, sans doubler la parole, et devra recreer un nouveau tour.
    for (let attempt = 0; attempt < MAX_PREPARE_ATTEMPTS; attempt += 1) {
      try {
        persisted = await this.repository.prepare(state);
      } catch {
        persisted = { status: 'unavailable' };
      }
      if (persisted.status !== 'unavailable') break;
    }
    if (persisted.status !== 'created' && persisted.status !== 'already_prepared') {
      return persisted.status === 'conflict'
        ? { status: 'conflict' }
        : { status: 'unavailable' };
    }
    if (!safeState(persisted.state, openAiNativeSpeechDeliveryKey(state))) {
      return { status: 'unavailable' };
    }
    if (!exactState(persisted.state, state)) return { status: 'conflict' };

    return {
      status: 'prepared',
      persistence: persisted.status,
      state: persisted.state,
      request: {
        deliveryId: state.deliveryId,
        turnId: state.turnId,
        contextRevision: state.contextRevision,
        contextDigest: state.contextDigest,
        requestNonce,
        canonicalSpeech,
      },
    };
  }

  async claimDispatch(
    input: OpenAiNativeSpeechDispatchClaimInput,
  ): Promise<OpenAiNativeSpeechDispatchOutcome> {
    const claim = snapshotDispatchClaimInput(input);
    if (claim === null) return { status: 'not_authorized' };
    const dispatchClaimId = this.entropy.dispatchClaimId().toLowerCase();
    if (!UUID.test(dispatchClaimId)) return { status: 'unavailable' };
    const key = this.key(claim);

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const read = await this.safeRead(key);
      if (read.status !== 'found') {
        return read.status === 'not_found'
          ? { status: 'not_found' }
          : { status: 'unavailable' };
      }
      if (!stateMatchesBinding(read.state, claim)) return { status: 'not_authorized' };
      const secret = this.config.proofKeys.secret(read.state.proofKeyVersion);
      if (
        typeof secret !== 'string'
        || Buffer.byteLength(secret, 'utf8') < 32
        || !requestMatchesPreparedProof(read.state, claim.request, secret)
      ) return { status: 'not_authorized' };

      let reduction;
      try {
        reduction = transitionOpenAiNativeSpeechDelivery(read.state, {
          type: 'CLAIM_DISPATCH',
          dispatchClaimId,
          atMs: this.now(),
        });
      } catch (error) {
        return error instanceof OpenAiNativeSpeechDeliveryError
          ? { status: 'not_authorized' }
          : { status: 'unavailable' };
      }
      if (reduction.status !== 'applied') return { status: 'not_authorized' };

      const swapped = await this.safeCompareAndSwap({
        key,
        expectedRevision: read.state.revision,
        next: reduction.state,
      });
      if (swapped.status === 'applied') {
        if (!exactState(swapped.state, reduction.state)) return { status: 'unavailable' };
        return {
          status: 'authorized',
          dispatchClaimId,
          state: swapped.state,
          request: claim.request,
        };
      }
      // Un ACK CAS perdu ou rejoue ne cree jamais un second droit reseau.
      if (swapped.status === 'already_applied') return { status: 'not_authorized' };
      if (swapped.status === 'not_found') return { status: 'not_found' };
      if (swapped.status === 'unavailable') return { status: 'unavailable' };
    }
    return { status: 'not_authorized' };
  }

  markRequested(
    input: OpenAiNativeSpeechRequestedInput,
  ): Promise<OpenAiNativeSpeechTransitionOutcome> {
    return this.applyBound(input, () => ({
      type: 'MARK_REQUESTED',
      dispatchClaimId: input.dispatchClaimId.toLowerCase(),
      atMs: this.now(),
    }));
  }

  acceptProviderResponse(
    input: OpenAiNativeSpeechProviderEventInput,
  ): Promise<OpenAiNativeSpeechTransitionOutcome> {
    return this.applyBound(input, (state, secret) => ({
      type: 'ACCEPT_RESPONSE',
      providerResponseIdHmac: createOpenAiNativeProviderResponseIdHmac({
        secret,
        proofKeyVersion: state.proofKeyVersion,
        binding: proofBinding(state),
        providerResponseId: input.providerResponseId,
      }),
      atMs: this.now(),
    }));
  }

  startStreaming(
    input: OpenAiNativeSpeechProviderEventInput,
  ): Promise<OpenAiNativeSpeechTransitionOutcome> {
    return this.applyBound(input, (state, secret) => ({
      type: 'START_STREAMING',
      providerResponseIdHmac: createOpenAiNativeProviderResponseIdHmac({
        secret,
        proofKeyVersion: state.proofKeyVersion,
        binding: proofBinding(state),
        providerResponseId: input.providerResponseId,
      }),
      atMs: this.now(),
    }));
  }

  responseDone(
    input: OpenAiNativeSpeechResponseDoneInput,
  ): Promise<OpenAiNativeSpeechTransitionOutcome> {
    return this.applyBound(input, (state, secret) => ({
      type: 'RESPONSE_DONE',
      providerResponseIdHmac: createOpenAiNativeProviderResponseIdHmac({
        secret,
        proofKeyVersion: state.proofKeyVersion,
        binding: proofBinding(state),
        providerResponseId: input.providerResponseId,
      }),
      outputTranscriptHmac: createOpenAiNativeSpeechTranscriptHmac({
        secret,
        proofKeyVersion: state.proofKeyVersion,
        binding: proofBinding(state),
        transcript: input.providerTranscript,
      }),
      atMs: this.now(),
    }));
  }

  outputStopped(
    input: OpenAiNativeSpeechProviderEventInput,
  ): Promise<OpenAiNativeSpeechTransitionOutcome> {
    return this.applyBound(input, (state, secret) => ({
      type: 'OUTPUT_STOPPED',
      providerResponseIdHmac: createOpenAiNativeProviderResponseIdHmac({
        secret,
        proofKeyVersion: state.proofKeyVersion,
        binding: proofBinding(state),
        providerResponseId: input.providerResponseId,
      }),
      atMs: this.now(),
    }));
  }

  acknowledgeDelivery(
    input: OpenAiNativeSpeechAcknowledgementInput,
  ): Promise<OpenAiNativeSpeechTransitionOutcome> {
    return this.applyBound(input, () => ({
      type: 'ACK_DELIVERY',
      acknowledgementId: input.acknowledgementId.toLowerCase(),
      deliveryId: input.deliveryId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      contextRevision: input.contextRevision,
      contextDigest: input.contextDigest,
      localObservation: input.localObservation,
      slo: input.slo,
      atMs: this.now(),
    }), { terminalReplayDoesNotRequireProofKey: true });
  }

  /**
   * Acquitte une livraison native observee par le mobile sans jamais faire confiance a un owner
   * sideband fourni par le client. Le mismatch d'identite ou de binding est volontairement
   * indistinguable d'une absence afin de ne pas transformer l'endpoint en oracle inter-tenant.
   */
  async acknowledgeMobileDelivery(
    input: OpenAiNativeSpeechMobileAcknowledgementInput,
  ): Promise<OpenAiNativeSpeechMobileAcknowledgementOutcome> {
    const acknowledgement = snapshotMobileAcknowledgementInput(input);
    if (acknowledgement === null) return { status: 'not_found' };
    const key = this.key(acknowledgement);

    const read = await this.safeRead(key);
    if (read.status !== 'found') {
      return read.status === 'not_found'
        ? { status: 'not_found' }
        : { status: 'unavailable' };
    }
    if (!stateMatchesMobileAcknowledgement(read.state, acknowledgement)) {
      return { status: 'not_found' };
    }

    if (
      read.state.phase !== 'completed'
      && read.state.phase !== 'delivered'
      && read.state.phase !== 'cancelled'
      && read.state.phase !== 'failed'
      && read.state.phase !== 'expired'
    ) return { status: 'not_ready' };

    // Une transition completed -> delivered reste liee a sa key de preuve. En revanche, un
    // terminal est deja une autorite immuable : son replay exact ou son conflit se determinent
    // uniquement depuis la preuve durable, y compris apres retrait legitime de l'ancienne key.
    if (read.state.phase === 'completed') {
      const secret = this.config.proofKeys.secret(read.state.proofKeyVersion);
      if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
        return { status: 'unavailable' };
      }
    }

    let reduction;
    try {
      reduction = transitionOpenAiNativeSpeechDelivery(read.state, {
        type: 'ACK_DELIVERY',
        acknowledgementId: acknowledgement.acknowledgementId,
        deliveryId: acknowledgement.deliveryId,
        sessionId: acknowledgement.sessionId,
        turnId: acknowledgement.turnId,
        contextRevision: acknowledgement.contextRevision,
        contextDigest: acknowledgement.contextDigest,
        localObservation: acknowledgement.localObservation,
        slo: acknowledgement.slo,
        atMs: this.now(),
      });
    } catch (error) {
      return error instanceof OpenAiNativeSpeechDeliveryError
        ? { status: 'conflict' }
        : { status: 'unavailable' };
    }
    if (reduction.status === 'idempotent') {
      return { status: 'idempotent', state: reduction.state };
    }

    // Un seul CAS : l'adapter reconnait deja `already_applied`. Un conflit concurrent est rendu
    // retryable au client avec le meme acknowledgementId, sans boucle PostgreSQL interne.
    const swapped = await this.safeCompareAndSwap({
      key,
      expectedRevision: read.state.revision,
      next: reduction.state,
    });
    if (swapped.status === 'applied' || swapped.status === 'already_applied') {
      if (!exactState(swapped.state, reduction.state)) return { status: 'unavailable' };
      return {
        status: swapped.status === 'applied' ? 'applied' : 'idempotent',
        state: swapped.state,
      };
    }
    if (swapped.status === 'not_found') return { status: 'not_found' };
    return { status: 'unavailable' };
  }

  /**
   * Réconcilie une livraison depuis l'unique owner sideband. Aucun texte n'est relu en base :
   * l'owner ne publiera que son `canonicalSpeech` local, après cette preuve durable exacte.
   */
  async reconcileOwnerDelivery(
    input: OpenAiNativeSpeechAuthorityBinding,
  ): Promise<OpenAiNativeSpeechOwnerReconciliationOutcome> {
    const binding = snapshotOwnerReconciliationBinding(input);
    if (binding === null) return { status: 'rejected' };
    const read = await this.safeRead(this.key(binding));
    if (read.status !== 'found') return read;
    if (!stateMatchesBinding(read.state, binding)) return { status: 'rejected' };

    if (read.state.phase === 'delivered') {
      // NULL/NULL est uniquement une forme N-1 lisible pendant l'expand. Ce n'est jamais une
      // preuve de lecture V1 et ne doit pas être promu en historique canonique.
      if (
        read.state.acknowledgementId === null
        || read.state.localObservationFormatVersion === null
        || read.state.localObservationKind === null
      ) return { status: 'terminal_without_proof' };
      return {
        status: 'delivered',
        acknowledgementId: read.state.acknowledgementId,
        state: read.state,
      };
    }
    if (
      read.state.phase === 'cancelled'
      || read.state.phase === 'failed'
      || read.state.phase === 'expired'
    ) return { status: 'terminal_without_proof' };

    // Les appels en vol (completed inclus) restent lies a leur ancienne key jusqu'au drain. Un
    // retrait premature echoue ferme et aucune histoire/UI n'est publiee.
    const secret = this.config.proofKeys.secret(read.state.proofKeyVersion);
    if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
      return { status: 'unavailable' };
    }
    return { status: 'pending' };
  }

  cancel(
    input: OpenAiNativeSpeechCancellationInput,
  ): Promise<OpenAiNativeSpeechTransitionOutcome> {
    return this.applyBound(input, () => ({
      type: 'CANCEL',
      cancellationId: input.cancellationId.toLowerCase(),
      reason: input.reason,
      atMs: this.now(),
    }));
  }

  fail(
    input: OpenAiNativeSpeechFailureInput,
  ): Promise<OpenAiNativeSpeechTransitionOutcome> {
    return this.applyBound(input, () => ({
      type: 'FAIL',
      failureId: input.failureId.toLowerCase(),
      reason: input.reason,
      atMs: this.now(),
    }));
  }

  key(binding: Pick<OpenAiNativeSpeechAuthorityBinding, 'companyId' | 'deliveryId'>): OpenAiNativeSpeechDeliveryKey {
    return { companyId: binding.companyId, deliveryId: binding.deliveryId.toLowerCase() };
  }

  private async applyBound(
    binding: OpenAiNativeSpeechAuthorityBinding,
    derive: (
      state: OpenAiNativeSpeechDeliveryState,
      secret: string,
    ) => OpenAiNativeSpeechDeliveryEvent,
    options: Readonly<{
      terminalReplayDoesNotRequireProofKey?: boolean;
    }> = {},
  ): Promise<OpenAiNativeSpeechTransitionOutcome> {
    const key = this.key(binding);
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const read = await this.safeRead(key);
      if (read.status !== 'found') {
        return read.status === 'not_found'
          ? { status: 'not_found' }
          : { status: 'unavailable' };
      }
      if (!stateMatchesBinding(read.state, binding)) return { status: 'rejected' };

      const terminalWithoutKey = options.terminalReplayDoesNotRequireProofKey === true
        && (
          read.state.phase === 'delivered'
          || read.state.phase === 'cancelled'
          || read.state.phase === 'failed'
          || read.state.phase === 'expired'
        );
      const proofSecret = terminalWithoutKey
        ? ''
        : this.config.proofKeys.secret(read.state.proofKeyVersion);
      if (
        !terminalWithoutKey
        && (typeof proofSecret !== 'string' || Buffer.byteLength(proofSecret, 'utf8') < 32)
      ) {
        return { status: 'unavailable' };
      }
      let reduction;
      try {
        reduction = transitionOpenAiNativeSpeechDelivery(
          read.state,
          derive(read.state, proofSecret ?? ''),
        );
      } catch (error) {
        return error instanceof OpenAiNativeSpeechDeliveryError
          ? { status: 'rejected' }
          : { status: 'unavailable' };
      }
      if (reduction.status === 'idempotent') {
        return { status: 'idempotent', state: reduction.state };
      }

      const swapped = await this.safeCompareAndSwap({
        key,
        expectedRevision: read.state.revision,
        next: reduction.state,
      });
      if (swapped.status === 'applied' || swapped.status === 'already_applied') {
        if (!exactState(swapped.state, reduction.state)) return { status: 'unavailable' };
        return {
          status: swapped.status === 'applied' ? 'applied' : 'idempotent',
          state: swapped.state,
        };
      }
      if (swapped.status === 'not_found') return { status: 'not_found' };
      if (swapped.status === 'unavailable') return { status: 'unavailable' };
    }
    return { status: 'unavailable' };
  }

  private async safeRead(
    key: OpenAiNativeSpeechDeliveryKey,
  ): Promise<OpenAiNativeSpeechDeliveryReadResult> {
    try {
      const result = await this.repository.read(key);
      if (result.status !== 'found') return result;
      return safeState(result.state, key) ? result : { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  private async safeCompareAndSwap(
    input: OpenAiNativeSpeechDeliveryCompareAndSwapInput,
  ): Promise<OpenAiNativeSpeechDeliveryCompareAndSwapResult> {
    try {
      const result = await this.repository.compareAndSwap(input);
      if (result.status !== 'applied' && result.status !== 'already_applied') return result;
      return safeState(result.state, input.key) ? result : { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    }
  }
}

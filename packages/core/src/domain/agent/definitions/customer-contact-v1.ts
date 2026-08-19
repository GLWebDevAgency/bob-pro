/**
 * Définition `customer_contact@1` (spec Jarvis §9.1) — lot U1-b, SPEC_U1B_DOMAINE_CORE.
 *
 * Transitions RÉELLES de création (`client-creer@1`) et de modification (`client-modifier@1`)
 * de la fiche client. Module PUR au sens §4.3 : aucune I/O, aucun port/repository/provider,
 * aucune horloge ambiante — `occurredAt` et l'`effectId` préalloué viennent exclusivement du
 * contexte d'admission (§5.4). Les contacts CRUD et la communication sont `customer_contact@2`.
 *
 * Invariants portés ici :
 * - un update exige une cible RÉELLE (`customerId` + `revision`) fournie par l'admission puis
 *   revérifiée en `resolving_customer` (§8, relecture avant proposition) — jamais inventée ;
 * - les doublons produisent des candidats bornés (≤ 5) scellés par un digest ; AUCUNE commande
 *   de fusion n'existe (FD-06 la ferme PAR CONSTRUCTION du type `CustomerContactDuplicateDecision`) :
 *   le run peut seulement continuer la création ou choisir un client existant ;
 * - cycle de confirmation §7.1 complet : issued -> presented -> consumed | rejected | expired |
 *   invalidated ; une mutation TVA/canal de facturation/adresse/destinataire entre présentation
 *   et confirm INVALIDE la proposition (jamais `consumed`) — nouvelle proposition requise ;
 * - la cible d'une modification n'est JAMAIS certifiée par le wire (U1-e §2) : la mise en
 *   proposition scelle `targetRevision` + `targetSensitiveDigest` d'une fiche RELUE par
 *   l'admission sous verrou, et le confirm compare ce sceau à une relecture fraîche, produite
 *   dans LA transaction qui consomme — le contexte les porte, la commande ne les porte pas ;
 * - UN SEUL `effectId` par run : `context.allocatedEffectIds[0]` pincé au démarrage, seul id
 *   jamais émis dans un work item ; `record_effect_receipt` est idempotent (même `customerId`
 *   au replay) ; un run terminal est figé et la définition n'émet JAMAIS le statut `expired` ;
 * - budget §4.3 : `cancel_run` et `record_effect_receipt` sont EXEMPTS de `maxSteps` (§5.3 —
 *   un run se ferme TOUJOURS et un résultat d'effet ne se perd jamais ; compteur borné au
 *   budget pour que le state produit demeure parsable).
 */

import { jsonUtf8ByteLength } from '../../../shared-kernel/json-size';
import { sha256Hex } from '../../../shared-kernel/sha256';
import { type Instant } from '../../../shared-kernel/time';
import { AGENT_MISSION_INT4_MAX } from '../agent-mission';
import {
  JARVIS_RUN_LEASE_RELEASING_STATUSES,
  JARVIS_RUN_TERMINAL_STATUSES,
  deriveNextWakeAt,
  type JarvisDefinitionLimits,
  type JarvisRunEnvelope,
  type JarvisRunStatus,
  type JarvisWake,
} from '../jarvis-run';
import {
  registerJarvisDefinition,
  type JarvisDefinitionModule,
  type JarvisReduceContext,
  type JarvisReduceResult,
} from '../jarvis-run-reducer';
import { type JarvisWorkItemIntent } from '../jarvis-work-item';

// ---------------------------------------------------------------------------
// Vocabulaire fermé de la définition
// ---------------------------------------------------------------------------

export const CUSTOMER_CONTACT_STATE_SCHEMA = 'bob.jarvis-run.customer-contact' as const;
export const CUSTOMER_CONTACT_STATE_VERSION = 1 as const;
export const CUSTOMER_CONTACT_DEFINITION_VERSION = 1 as const;

/** Actions cataloguées pincées par le run (catalog.data.ts : `client-creer@1`, `client-modifier@1`). */
export const CUSTOMER_CONTACT_CREATE_ACTION_ID = 'client-creer' as const;
export const CUSTOMER_CONTACT_UPDATE_ACTION_ID = 'client-modifier' as const;
export const CUSTOMER_CONTACT_ACTION_VERSION = 1 as const;

export const CUSTOMER_CONTACT_MAX_DUPLICATE_CANDIDATES = 5;
export const CUSTOMER_CONTACT_CONFIRMATION_TTL_MS = 5 * 60_000;
export const CUSTOMER_CONTACT_EXECUTE_BY_MS = 15 * 60_000;

/** Bornes fermées §4.3 — fixées par la définition, jamais par le modèle. */
export const CUSTOMER_CONTACT_LIMITS: JarvisDefinitionLimits = Object.freeze({
  maxSteps: 24,
  maxOpenWorkItems: 1,
  maxStateBytes: 65_536,
  idleTtlMs: 24 * 60 * 60 * 1_000,
  hardTtlMs: 7 * 24 * 60 * 60 * 1_000,
  maxWakes: 4,
});

export const CUSTOMER_CONTACT_PHASES = Object.freeze([
  'resolving_customer',
  'awaiting_duplicate_review',
  'preparing_proposal',
  'awaiting_confirmation',
  'committing',
  'awaiting_receipt',
  'cancelling',
  'completed',
  'cancelled',
  'failed',
] as const);
export type CustomerContactPhase = (typeof CUSTOMER_CONTACT_PHASES)[number];

/**
 * Champs sensibles §9.1 : leur mutation entre présentation et confirmation invalide toute
 * proposition aval devenue stale (TVA, canal de facturation, adresse, destinataire).
 */
export const CUSTOMER_CONTACT_SENSITIVE_FIELDS = Object.freeze([
  'vat_profile',
  'billing_channel',
  'address',
  'recipient',
] as const);
export type CustomerContactSensitiveField = (typeof CUSTOMER_CONTACT_SENSITIVE_FIELDS)[number];

export const CUSTOMER_CONTACT_CONFIRMATION_STATUSES = Object.freeze([
  'issued',
  'presented',
  'consumed',
  'rejected',
  'expired',
  'invalidated',
] as const);
export type CustomerContactConfirmationStatus =
  (typeof CUSTOMER_CONTACT_CONFIRMATION_STATUSES)[number];

/** Projection totale phase -> statut §5.1. La définition n'émet JAMAIS `expired`. */
export function customerContactStatusForPhase(phase: CustomerContactPhase): JarvisRunStatus {
  switch (phase) {
    case 'resolving_customer':
    case 'preparing_proposal':
      return 'active';
    case 'awaiting_duplicate_review':
    case 'awaiting_confirmation':
      return 'waiting_user';
    case 'committing':
    case 'awaiting_receipt':
      return 'waiting_external';
    case 'cancelling':
      return 'cancelling';
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed_terminal';
  }
}

// ---------------------------------------------------------------------------
// State fermé v1 — références, digests et checkpoints, jamais un transcript (§5.1)
// ---------------------------------------------------------------------------

export interface CustomerContactTargetV1 {
  /** Cible RÉELLE fournie par l'admission (résolution §8) — jamais inventée par le modèle. */
  readonly customerId: string;
  readonly revision: number;
}

export type CustomerContactIntentV1 =
  | { readonly mode: 'create' }
  | { readonly mode: 'update'; readonly target: CustomerContactTargetV1 };

export interface CustomerContactDuplicateCandidateV1 {
  readonly choiceId: string;
  readonly customerId: string;
  /** Digest de l'évidence de correspondance (SIREN/nom/email/téléphone) — jamais le PII. */
  readonly matchDigest: string;
}

export interface CustomerContactDuplicateReviewV1 {
  readonly reviewId: string;
  readonly candidates: readonly CustomerContactDuplicateCandidateV1[];
  readonly candidateSetHash: string;
}

export interface CustomerContactProposalV1 {
  readonly proposalId: string;
  readonly proposalCommandId: string;
  /** Digest canonique de TOUS les champs proposés (calculé côté admission, scellé ici). */
  readonly fieldsDigest: string;
  /** Digest du sous-ensemble sensible (TVA/facturation/adresse/destinataire) — garde stale §9.1. */
  readonly sensitiveDigest: string;
  /** Update : révision de la cible relue juste avant proposition ; create : null. */
  readonly targetRevision: number | null;
  /**
   * SCEAU DE CIBLE (§9.1) — update : digest sensible de la fiche RELUE sous verrou par
   * l'admission au moment de la mise en proposition ; create : null. C'est LUI que le confirm
   * compare à une relecture fraîche : le digest des champs PROPOSÉS (`sensitiveDigest`) ne
   * pourrait rien prouver de la cible, il ne parle que de ce que l'artisan veut écrire.
   */
  readonly targetSensitiveDigest: string | null;
  readonly proposalHash: string;
}

export interface CustomerContactConfirmationV1 {
  readonly confirmationId: string;
  readonly status: CustomerContactConfirmationStatus;
  readonly issuedAt: Instant;
  readonly presentedAt: Instant | null;
  readonly expiresAt: Instant;
  readonly consumedByCommandId: string | null;
  /** `wakeId` stable §5.1 du réveil `confirmation_ttl` — `nextWakeAt` n'est qu'un index dérivé. */
  readonly wakeId: string;
}

export interface CustomerContactEffectReceiptV1 {
  readonly effectId: string;
  readonly customerId: string;
  readonly customerRevision: number;
  readonly recordedAt: Instant;
}

export interface CustomerContactStateV1 {
  readonly schema: typeof CUSTOMER_CONTACT_STATE_SCHEMA;
  readonly version: typeof CUSTOMER_CONTACT_STATE_VERSION;
  readonly phase: CustomerContactPhase;
  readonly steps: number;
  /** L'UNIQUE effectId du run — `context.allocatedEffectIds[0]` pincé au démarrage (§5.4). */
  readonly effectId: string;
  readonly intent: CustomerContactIntentV1;
  readonly duplicateReview: CustomerContactDuplicateReviewV1 | null;
  readonly proposal: CustomerContactProposalV1 | null;
  readonly confirmation: CustomerContactConfirmationV1 | null;
  readonly receipt: CustomerContactEffectReceiptV1 | null;
  /** Issue FD-06 « choisir un existant » : le run se termine sur ce client, sans effet. */
  readonly resolvedExistingCustomerId: string | null;
  /** Référence du job soumis à l'outbox canonique — observation, jamais une outbox propre (§5.3). */
  readonly submittedJobRef: string | null;
  readonly wakes: readonly JarvisWake[];
  readonly wakesScheduled: number;
  readonly cancelReason: 'user_cancelled' | 'manual_handoff' | null;
  readonly failureReason: string | null;
}

const STATE_KEYS = [
  'schema',
  'version',
  'phase',
  'steps',
  'effectId',
  'intent',
  'duplicateReview',
  'proposal',
  'confirmation',
  'receipt',
  'resolvedExistingCustomerId',
  'submittedJobRef',
  'wakes',
  'wakesScheduled',
  'cancelReason',
  'failureReason',
] as const;

// ---------------------------------------------------------------------------
// Commandes fermées — FD-06 : la fusion n'existe pas dans l'union, par construction
// ---------------------------------------------------------------------------

export type CustomerContactResolutionOutcome =
  | { readonly kind: 'no_duplicates' }
  | {
      readonly kind: 'duplicate_candidates';
      readonly reviewId: string;
      readonly candidates: readonly CustomerContactDuplicateCandidateV1[];
    }
  /**
   * §8 — L'AUTORITÉ D'UNE ENTITÉ NE VIENT JAMAIS DU CLIENT. La variante ne porte QUE l'identité
   * de la cible : la révision vérifiée est celle que l'admission RELIT SOUS VERROU dans sa
   * transaction (`context.targetRevalidation`). Un champ `revision` ici serait une affirmation
   * que nul émetteur ne peut prouver — et le premier à s'y fier scellerait une cible périmée.
   */
  | { readonly kind: 'target_verified'; readonly customerId: string };

/**
 * FD-06 : union à DEUX membres — continuer la création ou choisir un existant. Aucune variante
 * `merge` n'existe ; une fusion éventuelle est une action distincte, destructive et renforcée,
 * hors de ce run (§9.1).
 */
export type CustomerContactDuplicateDecision =
  | { readonly kind: 'continue_create' }
  | { readonly kind: 'use_existing'; readonly choiceId: string };

export type CustomerContactEffectOutcome =
  | { readonly kind: 'succeeded'; readonly customerId: string; readonly customerRevision: number }
  | { readonly kind: 'failed_terminal'; readonly reasonCode: string };

export type CustomerContactCommand =
  | { readonly type: 'start_run'; readonly intent: CustomerContactIntentV1 }
  | {
      readonly type: 'record_customer_resolution';
      readonly resolution: CustomerContactResolutionOutcome;
    }
  | {
      readonly type: 'choose_duplicate_resolution';
      readonly reviewId: string;
      readonly decision: CustomerContactDuplicateDecision;
    }
  | {
      readonly type: 'stage_proposal';
      readonly proposalId: string;
      readonly confirmationId: string;
      readonly fieldsDigest: string;
      readonly sensitiveDigest: string;
      readonly targetRevision: number | null;
    }
  | {
      readonly type: 'record_presentation_ack';
      readonly confirmationId: string;
      readonly ack: 'screen_ack' | 'voice_presentation_ack';
    }
  | {
      /**
       * Le wire s'arrête ICI : `confirmationId` + `proposalHash`, rien d'autre. La cible relue
       * (§7.1) N'EST PLUS une donnée de commande — un client ne peut pas certifier l'état de sa
       * propre cible. Elle entre par le CONTEXTE, produite par l'admission sous verrou.
       */
      readonly type: 'confirm';
      readonly confirmationId: string;
      readonly proposalHash: string;
    }
  | { readonly type: 'reject_proposal'; readonly confirmationId: string }
  | {
      readonly type: 'record_target_mutation';
      readonly mutatedField: CustomerContactSensitiveField;
      readonly targetRevision: number;
    }
  | {
      readonly type: 'record_effect_submitted';
      readonly effectId: string;
      readonly submittedJobRef: string | null;
    }
  | {
      readonly type: 'record_effect_receipt';
      readonly effectId: string;
      readonly outcome: CustomerContactEffectOutcome;
    }
  | { readonly type: 'cancel_run'; readonly reason: 'user_cancelled' | 'manual_handoff' }
  | { readonly type: 'wake_run'; readonly wakeId: string };

/** Raisons fermées portées par l'erreur `invalid_command` du reducer racine. */
export type CustomerContactInvalidCommandReason =
  | 'kind_mismatch'
  | 'command_shape'
  | 'state_shape'
  | 'run_not_started'
  | 'already_started'
  | 'missing_allocated_effect_id'
  | 'resolution_mode_mismatch'
  | 'target_mismatch'
  | 'review_mismatch'
  | 'choice_unknown'
  | 'no_update_target'
  | 'target_revision_stale'
  /** Update sans cible relue par l'admission (§7.1) : cible disparue ou relecture non câblée. */
  | 'target_revalidation_missing'
  /** Create avec une cible relue : un run de création n'a pas de cible — état sans sens. */
  | 'target_revalidation_forbidden'
  | 'max_wakes_exhausted'
  | 'max_steps_exceeded'
  | 'state_too_large'
  | 'revision_overflow'
  | 'confirmation_mismatch'
  | 'confirmation_not_presented'
  | 'confirmation_already_presented'
  | 'confirmation_expired'
  | 'confirmation_already_consumed'
  | 'proposal_hash_mismatch'
  | 'effect_id_mismatch'
  | 'receipt_conflict'
  | 'invalid_phase_for_command'
  | 'invalid_value';

// ---------------------------------------------------------------------------
// Gardes de forme (patron requireExactInput/exact-keys d'agent-mission.ts — helpers privés
// non exportés par l'agrégat, redéclarés localement à l'identique)
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_IDENTIFIER_LENGTH = 200;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point < 32 || (point >= 127 && point <= 159));
  });
}

function isCanonicalIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && value === value.trim()
    && !hasControlCharacter(value)
  );
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= AGENT_MISSION_INT4_MAX;
}

function instantEpoch(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) return null;
  return epoch;
}

function instantFromEpoch(epoch: number): Instant {
  return new Date(epoch).toISOString();
}

function fail(reason: CustomerContactInvalidCommandReason): JarvisReduceResult {
  return { ok: false, error: { code: 'invalid_command', reason } };
}

// ---------------------------------------------------------------------------
// Digests canoniques (patron computeQuoteMissionChoiceSetHash — ordonnancement explicite)
// ---------------------------------------------------------------------------

/** Scelle l'ensemble borné des candidats doublons — l'UI et la voix présentent le même set. */
export function computeCustomerContactCandidateSetHash(input: {
  readonly runId: string;
  readonly reviewId: string;
  readonly candidates: readonly CustomerContactDuplicateCandidateV1[];
}): string {
  return sha256Hex(JSON.stringify([
    'bob.jarvis-run.customer-contact.candidate-set.v1',
    input.runId,
    input.reviewId,
    input.candidates.map((candidate) => [candidate.choiceId, candidate.customerId, candidate.matchDigest]),
  ]));
}

/** Scelle la proposition digestée — le gateway U1-c le recalcule pour la présenter/confirmer. */
export function computeCustomerContactProposalHash(input: {
  readonly runId: string;
  readonly proposalId: string;
  readonly actionId: string;
  readonly fieldsDigest: string;
  readonly sensitiveDigest: string;
  readonly targetRevision: number | null;
  readonly effectId: string;
}): string {
  return sha256Hex(JSON.stringify([
    'bob.jarvis-run.customer-contact.proposal.v1',
    input.runId,
    input.proposalId,
    input.actionId,
    input.fieldsDigest,
    input.sensitiveDigest,
    input.targetRevision,
    input.effectId,
  ]));
}

function computeUpdateTargetDigest(customerId: string, revision: number): string {
  return sha256Hex(JSON.stringify([
    'bob.jarvis-run.customer-contact.target.v1',
    customerId,
    revision,
  ]));
}

// ---------------------------------------------------------------------------
// Parse du state persisté — exact-keys, cohérence de phase, jamais de tolérance
// ---------------------------------------------------------------------------

function parseIntent(value: unknown): CustomerContactIntentV1 | null {
  if (!isPlainRecord(value)) return null;
  if (value['mode'] === 'create') {
    return exactKeys(value, ['mode']) ? Object.freeze({ mode: 'create' as const }) : null;
  }
  if (value['mode'] !== 'update' || !exactKeys(value, ['mode', 'target'])) return null;
  const target = value['target'];
  if (!isPlainRecord(target) || !exactKeys(target, ['customerId', 'revision'])) return null;
  if (!isCanonicalIdentifier(target['customerId']) || !isRevision(target['revision'])) return null;
  return Object.freeze({
    mode: 'update' as const,
    target: Object.freeze({ customerId: target['customerId'], revision: target['revision'] }),
  });
}

function parseCandidates(value: unknown): readonly CustomerContactDuplicateCandidateV1[] | null {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > CUSTOMER_CONTACT_MAX_DUPLICATE_CANDIDATES
  ) {
    return null;
  }
  const choiceIds = new Set<string>();
  const customerIds = new Set<string>();
  const candidates: CustomerContactDuplicateCandidateV1[] = [];
  for (const entry of value) {
    if (!isPlainRecord(entry) || !exactKeys(entry, ['choiceId', 'customerId', 'matchDigest'])) return null;
    if (!isCanonicalUuid(entry['choiceId']) || !isCanonicalIdentifier(entry['customerId'])) return null;
    if (!isSha256Digest(entry['matchDigest'])) return null;
    if (choiceIds.has(entry['choiceId']) || customerIds.has(entry['customerId'])) return null;
    choiceIds.add(entry['choiceId']);
    customerIds.add(entry['customerId']);
    candidates.push(Object.freeze({
      choiceId: entry['choiceId'],
      customerId: entry['customerId'],
      matchDigest: entry['matchDigest'],
    }));
  }
  return Object.freeze(candidates);
}

function parseDuplicateReview(value: unknown): CustomerContactDuplicateReviewV1 | null {
  if (!isPlainRecord(value) || !exactKeys(value, ['reviewId', 'candidates', 'candidateSetHash'])) return null;
  if (!isCanonicalUuid(value['reviewId']) || !isSha256Digest(value['candidateSetHash'])) return null;
  const candidates = parseCandidates(value['candidates']);
  if (candidates === null) return null;
  return Object.freeze({
    reviewId: value['reviewId'],
    candidates,
    candidateSetHash: value['candidateSetHash'],
  });
}

function parseProposal(value: unknown): CustomerContactProposalV1 | null {
  if (!isPlainRecord(value) || !exactKeys(value, [
    'proposalId',
    'proposalCommandId',
    'fieldsDigest',
    'sensitiveDigest',
    'targetRevision',
    'targetSensitiveDigest',
    'proposalHash',
  ])) {
    return null;
  }
  if (!isCanonicalUuid(value['proposalId']) || !isCanonicalUuid(value['proposalCommandId'])) return null;
  if (!isSha256Digest(value['fieldsDigest']) || !isSha256Digest(value['sensitiveDigest'])) return null;
  if (value['targetRevision'] !== null && !isRevision(value['targetRevision'])) return null;
  if (value['targetSensitiveDigest'] !== null && !isSha256Digest(value['targetSensitiveDigest'])) {
    return null;
  }
  // Les deux moitiés du sceau de cible vont ENSEMBLE : une révision sans digest (ou l'inverse)
  // serait une garde §9.1 à moitié armée — refus de forme, jamais une tolérance.
  if ((value['targetRevision'] === null) !== (value['targetSensitiveDigest'] === null)) return null;
  if (!isSha256Digest(value['proposalHash'])) return null;
  return Object.freeze({
    proposalId: value['proposalId'],
    proposalCommandId: value['proposalCommandId'],
    fieldsDigest: value['fieldsDigest'],
    sensitiveDigest: value['sensitiveDigest'],
    targetRevision: value['targetRevision'],
    targetSensitiveDigest: value['targetSensitiveDigest'],
    proposalHash: value['proposalHash'],
  });
}

function parseConfirmation(value: unknown): CustomerContactConfirmationV1 | null {
  if (!isPlainRecord(value) || !exactKeys(value, [
    'confirmationId',
    'status',
    'issuedAt',
    'presentedAt',
    'expiresAt',
    'consumedByCommandId',
    'wakeId',
  ])) {
    return null;
  }
  if (!isCanonicalUuid(value['confirmationId']) || !isCanonicalUuid(value['wakeId'])) return null;
  const status = value['status'];
  if (
    typeof status !== 'string'
    || !(CUSTOMER_CONTACT_CONFIRMATION_STATUSES as readonly string[]).includes(status)
  ) {
    return null;
  }
  if (instantEpoch(value['issuedAt']) === null || instantEpoch(value['expiresAt']) === null) return null;
  if (value['presentedAt'] !== null && instantEpoch(value['presentedAt']) === null) return null;
  if (value['consumedByCommandId'] !== null && !isCanonicalUuid(value['consumedByCommandId'])) return null;
  return Object.freeze({
    confirmationId: value['confirmationId'],
    status: status as CustomerContactConfirmationStatus,
    issuedAt: value['issuedAt'] as Instant,
    presentedAt: value['presentedAt'] as Instant | null,
    expiresAt: value['expiresAt'] as Instant,
    consumedByCommandId: value['consumedByCommandId'] as string | null,
    wakeId: value['wakeId'],
  });
}

function parseReceipt(value: unknown): CustomerContactEffectReceiptV1 | null {
  if (!isPlainRecord(value) || !exactKeys(value, ['effectId', 'customerId', 'customerRevision', 'recordedAt'])) {
    return null;
  }
  if (!isCanonicalUuid(value['effectId']) || !isCanonicalIdentifier(value['customerId'])) return null;
  if (!isRevision(value['customerRevision']) || instantEpoch(value['recordedAt']) === null) return null;
  return Object.freeze({
    effectId: value['effectId'],
    customerId: value['customerId'],
    customerRevision: value['customerRevision'],
    recordedAt: value['recordedAt'] as Instant,
  });
}

const WAKE_KINDS = ['confirmation_ttl', 'retry', 'external_deadline', 'park_review'] as const;

function parseWakes(value: unknown): readonly JarvisWake[] | null {
  if (!Array.isArray(value) || value.length > CUSTOMER_CONTACT_LIMITS.maxWakes) return null;
  const wakes: JarvisWake[] = [];
  const wakeIds = new Set<string>();
  for (const entry of value) {
    if (!isPlainRecord(entry) || !exactKeys(entry, ['wakeId', 'kind', 'dueAt'])) return null;
    if (!isCanonicalUuid(entry['wakeId']) || wakeIds.has(entry['wakeId'])) return null;
    if (
      typeof entry['kind'] !== 'string'
      || !(WAKE_KINDS as readonly string[]).includes(entry['kind'])
    ) {
      return null;
    }
    if (instantEpoch(entry['dueAt']) === null) return null;
    wakeIds.add(entry['wakeId']);
    wakes.push(Object.freeze({
      wakeId: entry['wakeId'],
      kind: entry['kind'] as JarvisWake['kind'],
      dueAt: entry['dueAt'] as Instant,
    }));
  }
  return Object.freeze(wakes);
}

/** Parse exact-keys + cohérence de phase du state persisté. `null` = state corrompu, refus. */
export function parseCustomerContactState(value: unknown): CustomerContactStateV1 | null {
  if (!isPlainRecord(value) || !exactKeys(value, STATE_KEYS)) return null;
  if (value['schema'] !== CUSTOMER_CONTACT_STATE_SCHEMA || value['version'] !== CUSTOMER_CONTACT_STATE_VERSION) {
    return null;
  }
  const phase = value['phase'];
  if (
    typeof phase !== 'string'
    || !(CUSTOMER_CONTACT_PHASES as readonly string[]).includes(phase)
  ) {
    return null;
  }
  const steps = value['steps'];
  if (!Number.isSafeInteger(steps) || (steps as number) < 1 || (steps as number) > CUSTOMER_CONTACT_LIMITS.maxSteps) {
    return null;
  }
  if (!isCanonicalUuid(value['effectId'])) return null;
  const intent = parseIntent(value['intent']);
  if (intent === null) return null;
  const duplicateReview = value['duplicateReview'] === null ? null : parseDuplicateReview(value['duplicateReview']);
  if (value['duplicateReview'] !== null && duplicateReview === null) return null;
  const proposal = value['proposal'] === null ? null : parseProposal(value['proposal']);
  if (value['proposal'] !== null && proposal === null) return null;
  const confirmation = value['confirmation'] === null ? null : parseConfirmation(value['confirmation']);
  if (value['confirmation'] !== null && confirmation === null) return null;
  const receipt = value['receipt'] === null ? null : parseReceipt(value['receipt']);
  if (value['receipt'] !== null && receipt === null) return null;
  if (value['resolvedExistingCustomerId'] !== null && !isCanonicalIdentifier(value['resolvedExistingCustomerId'])) {
    return null;
  }
  if (value['submittedJobRef'] !== null && !isCanonicalIdentifier(value['submittedJobRef'])) return null;
  const wakes = parseWakes(value['wakes']);
  if (wakes === null) return null;
  const wakesScheduled = value['wakesScheduled'];
  if (
    !Number.isSafeInteger(wakesScheduled)
    || (wakesScheduled as number) < 0
    || (wakesScheduled as number) > CUSTOMER_CONTACT_LIMITS.maxWakes
  ) {
    return null;
  }
  const cancelReason = value['cancelReason'];
  if (cancelReason !== null && cancelReason !== 'user_cancelled' && cancelReason !== 'manual_handoff') return null;
  if (value['failureReason'] !== null && !isCanonicalIdentifier(value['failureReason'])) return null;

  const typedPhase = phase as CustomerContactPhase;
  // Cohérence structurelle par phase — un state qui les viole est refusé, jamais rattrapé.
  if (typedPhase === 'awaiting_duplicate_review' && (duplicateReview === null || intent.mode !== 'create')) return null;
  if (
    typedPhase === 'awaiting_confirmation'
    && (proposal === null
      || confirmation === null
      || (confirmation.status !== 'issued' && confirmation.status !== 'presented'))
  ) {
    return null;
  }
  if (
    (typedPhase === 'committing' || typedPhase === 'awaiting_receipt' || typedPhase === 'cancelling')
    && (proposal === null || confirmation === null || confirmation.status !== 'consumed')
  ) {
    return null;
  }
  if (typedPhase === 'completed' && receipt === null && value['resolvedExistingCustomerId'] === null) return null;
  if ((typedPhase === 'cancelled' || typedPhase === 'cancelling') && cancelReason === null) return null;
  if (typedPhase === 'failed' && value['failureReason'] === null) return null;

  return Object.freeze({
    schema: CUSTOMER_CONTACT_STATE_SCHEMA,
    version: CUSTOMER_CONTACT_STATE_VERSION,
    phase: typedPhase,
    steps: steps as number,
    effectId: value['effectId'],
    intent,
    duplicateReview,
    proposal,
    confirmation,
    receipt,
    resolvedExistingCustomerId: value['resolvedExistingCustomerId'] as string | null,
    submittedJobRef: value['submittedJobRef'] as string | null,
    wakes,
    wakesScheduled: wakesScheduled as number,
    cancelReason: cancelReason as CustomerContactStateV1['cancelReason'],
    failureReason: value['failureReason'] as string | null,
  });
}

// ---------------------------------------------------------------------------
// Parse des commandes — union fermée, exact-keys, fusion impossible par construction
// ---------------------------------------------------------------------------

function parseResolutionOutcome(value: unknown): CustomerContactResolutionOutcome | null {
  if (!isPlainRecord(value)) return null;
  if (value['kind'] === 'no_duplicates') {
    return exactKeys(value, ['kind']) ? Object.freeze({ kind: 'no_duplicates' as const }) : null;
  }
  if (value['kind'] === 'duplicate_candidates') {
    if (!exactKeys(value, ['kind', 'reviewId', 'candidates'])) return null;
    if (!isCanonicalUuid(value['reviewId'])) return null;
    const candidates = parseCandidates(value['candidates']);
    if (candidates === null) return null;
    return Object.freeze({ kind: 'duplicate_candidates' as const, reviewId: value['reviewId'], candidates });
  }
  if (value['kind'] === 'target_verified') {
    if (!exactKeys(value, ['kind', 'customerId'])) return null;
    if (!isCanonicalIdentifier(value['customerId'])) return null;
    return Object.freeze({
      kind: 'target_verified' as const,
      customerId: value['customerId'],
    });
  }
  return null;
}

function parseDuplicateDecision(value: unknown): CustomerContactDuplicateDecision | null {
  if (!isPlainRecord(value)) return null;
  if (value['kind'] === 'continue_create') {
    return exactKeys(value, ['kind']) ? Object.freeze({ kind: 'continue_create' as const }) : null;
  }
  if (value['kind'] === 'use_existing') {
    if (!exactKeys(value, ['kind', 'choiceId']) || !isCanonicalUuid(value['choiceId'])) return null;
    return Object.freeze({ kind: 'use_existing' as const, choiceId: value['choiceId'] });
  }
  // Toute autre variante — `merge` comprise — n'existe pas : refus de forme (FD-06).
  return null;
}

function parseEffectOutcome(value: unknown): CustomerContactEffectOutcome | null {
  if (!isPlainRecord(value)) return null;
  if (value['kind'] === 'succeeded') {
    if (!exactKeys(value, ['kind', 'customerId', 'customerRevision'])) return null;
    if (!isCanonicalIdentifier(value['customerId']) || !isRevision(value['customerRevision'])) return null;
    return Object.freeze({
      kind: 'succeeded' as const,
      customerId: value['customerId'],
      customerRevision: value['customerRevision'],
    });
  }
  if (value['kind'] === 'failed_terminal') {
    if (!exactKeys(value, ['kind', 'reasonCode']) || !isCanonicalIdentifier(value['reasonCode'])) return null;
    return Object.freeze({ kind: 'failed_terminal' as const, reasonCode: value['reasonCode'] });
  }
  return null;
}

export function parseCustomerContactCommand(value: unknown): CustomerContactCommand | null {
  if (!isPlainRecord(value)) return null;
  switch (value['type']) {
    case 'start_run': {
      if (!exactKeys(value, ['type', 'intent'])) return null;
      const intent = parseIntent(value['intent']);
      return intent === null ? null : Object.freeze({ type: 'start_run' as const, intent });
    }
    case 'record_customer_resolution': {
      if (!exactKeys(value, ['type', 'resolution'])) return null;
      const resolution = parseResolutionOutcome(value['resolution']);
      return resolution === null
        ? null
        : Object.freeze({ type: 'record_customer_resolution' as const, resolution });
    }
    case 'choose_duplicate_resolution': {
      if (!exactKeys(value, ['type', 'reviewId', 'decision']) || !isCanonicalUuid(value['reviewId'])) return null;
      const decision = parseDuplicateDecision(value['decision']);
      return decision === null
        ? null
        : Object.freeze({
            type: 'choose_duplicate_resolution' as const,
            reviewId: value['reviewId'],
            decision,
          });
    }
    case 'stage_proposal': {
      if (!exactKeys(value, [
        'type',
        'proposalId',
        'confirmationId',
        'fieldsDigest',
        'sensitiveDigest',
        'targetRevision',
      ])) {
        return null;
      }
      if (!isCanonicalUuid(value['proposalId']) || !isCanonicalUuid(value['confirmationId'])) return null;
      if (!isSha256Digest(value['fieldsDigest']) || !isSha256Digest(value['sensitiveDigest'])) return null;
      if (value['targetRevision'] !== null && !isRevision(value['targetRevision'])) return null;
      return Object.freeze({
        type: 'stage_proposal' as const,
        proposalId: value['proposalId'],
        confirmationId: value['confirmationId'],
        fieldsDigest: value['fieldsDigest'],
        sensitiveDigest: value['sensitiveDigest'],
        targetRevision: value['targetRevision'],
      });
    }
    case 'record_presentation_ack': {
      if (!exactKeys(value, ['type', 'confirmationId', 'ack']) || !isCanonicalUuid(value['confirmationId'])) {
        return null;
      }
      if (value['ack'] !== 'screen_ack' && value['ack'] !== 'voice_presentation_ack') return null;
      return Object.freeze({
        type: 'record_presentation_ack' as const,
        confirmationId: value['confirmationId'],
        ack: value['ack'],
      });
    }
    case 'confirm': {
      // EXACTEMENT trois clés : une commande qui prétendrait porter la révision ou le digest
      // revalidés de la cible est REFUSÉE DE FORME — la relecture n'est pas une donnée du wire.
      if (!exactKeys(value, ['type', 'confirmationId', 'proposalHash'])) return null;
      if (!isCanonicalUuid(value['confirmationId']) || !isSha256Digest(value['proposalHash'])) return null;
      return Object.freeze({
        type: 'confirm' as const,
        confirmationId: value['confirmationId'],
        proposalHash: value['proposalHash'],
      });
    }
    case 'reject_proposal': {
      if (!exactKeys(value, ['type', 'confirmationId']) || !isCanonicalUuid(value['confirmationId'])) return null;
      return Object.freeze({ type: 'reject_proposal' as const, confirmationId: value['confirmationId'] });
    }
    case 'record_target_mutation': {
      if (!exactKeys(value, ['type', 'mutatedField', 'targetRevision'])) return null;
      if (
        typeof value['mutatedField'] !== 'string'
        || !(CUSTOMER_CONTACT_SENSITIVE_FIELDS as readonly string[]).includes(value['mutatedField'])
      ) {
        return null;
      }
      if (!isRevision(value['targetRevision'])) return null;
      return Object.freeze({
        type: 'record_target_mutation' as const,
        mutatedField: value['mutatedField'] as CustomerContactSensitiveField,
        targetRevision: value['targetRevision'],
      });
    }
    case 'record_effect_submitted': {
      if (!exactKeys(value, ['type', 'effectId', 'submittedJobRef']) || !isCanonicalUuid(value['effectId'])) {
        return null;
      }
      if (value['submittedJobRef'] !== null && !isCanonicalIdentifier(value['submittedJobRef'])) return null;
      return Object.freeze({
        type: 'record_effect_submitted' as const,
        effectId: value['effectId'],
        submittedJobRef: value['submittedJobRef'],
      });
    }
    case 'record_effect_receipt': {
      if (!exactKeys(value, ['type', 'effectId', 'outcome']) || !isCanonicalUuid(value['effectId'])) return null;
      const outcome = parseEffectOutcome(value['outcome']);
      return outcome === null
        ? null
        : Object.freeze({ type: 'record_effect_receipt' as const, effectId: value['effectId'], outcome });
    }
    case 'cancel_run': {
      if (!exactKeys(value, ['type', 'reason'])) return null;
      if (value['reason'] !== 'user_cancelled' && value['reason'] !== 'manual_handoff') return null;
      return Object.freeze({ type: 'cancel_run' as const, reason: value['reason'] });
    }
    case 'wake_run': {
      if (!exactKeys(value, ['type', 'wakeId']) || !isCanonicalUuid(value['wakeId'])) return null;
      return Object.freeze({ type: 'wake_run' as const, wakeId: value['wakeId'] });
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Réduction — transitions pures ; toute sortie est le miroir 1:1 de la persistance U1-c
// ---------------------------------------------------------------------------

type CustomerContactRunEnvelope = Extract<
  JarvisRunEnvelope,
  { readonly kind: 'single_business_action' | 'customer_contact' }
>;

const EMPTY_INTENTS: readonly JarvisWorkItemIntent[] = Object.freeze([]);
const EMPTY_WAKES: readonly JarvisWake[] = Object.freeze([]);
const CUSTOMER_CONTACT_EVENT_VERSION = 1;

function freezeState(state: CustomerContactStateV1): CustomerContactStateV1 {
  return Object.freeze(state);
}

function withState(
  state: CustomerContactStateV1,
  patch: Partial<CustomerContactStateV1>,
): CustomerContactStateV1 {
  return freezeState({ ...state, ...patch, steps: state.steps + 1 });
}

/**
 * Variante de `withState` pour les SEULES commandes exemptes du budget de pas (§5.3) :
 * `cancel_run` et `record_effect_receipt`. Un run doit TOUJOURS pouvoir se fermer et un
 * résultat d'effet ne se perd JAMAIS — même à `maxSteps` (patron single_business_action_v1
 * qui exempte le cancel). Le compteur reste borné au budget pour que le state produit
 * demeure parsable (le parse exige `steps <= maxSteps`).
 */
function withBudgetExemptState(
  state: CustomerContactStateV1,
  patch: Partial<CustomerContactStateV1>,
): CustomerContactStateV1 {
  return freezeState({
    ...state,
    ...patch,
    steps: Math.min(state.steps + 1, CUSTOMER_CONTACT_LIMITS.maxSteps),
  });
}

function commit(
  run: CustomerContactRunEnvelope,
  context: JarvisReduceContext,
  nextState: CustomerContactStateV1,
  eventType: string,
  eventData: Readonly<Record<string, unknown>>,
  intents: readonly JarvisWorkItemIntent[],
): JarvisReduceResult {
  if (nextState.steps > CUSTOMER_CONTACT_LIMITS.maxSteps) return fail('max_steps_exceeded');
  const nextRevision = run.revision + 1;
  if (nextRevision > AGENT_MISSION_INT4_MAX) return fail('revision_overflow');
  const stateBytes = jsonUtf8ByteLength(nextState);
  if (stateBytes === null || stateBytes > CUSTOMER_CONTACT_LIMITS.maxStateBytes) return fail('state_too_large');
  const status = customerContactStatusForPhase(nextState.phase);
  const terminal = JARVIS_RUN_TERMINAL_STATUSES.has(status);
  const postimage: CustomerContactRunEnvelope = Object.freeze({
    kind: run.kind,
    runId: run.runId,
    companyId: run.companyId,
    createdBy: run.createdBy,
    definitionVersion: run.definitionVersion,
    status,
    revision: nextRevision,
    stateVersion: CUSTOMER_CONTACT_STATE_VERSION,
    state: nextState,
    nextWakeAt: deriveNextWakeAt(nextState.wakes),
    terminalAt: terminal ? context.occurredAt : null,
  });
  return {
    ok: true,
    value: Object.freeze({
      postimage,
      event: Object.freeze({
        type: eventType,
        version: CUSTOMER_CONTACT_EVENT_VERSION,
        data: Object.freeze(eventData),
      }),
      workItemIntents: intents,
      wakes: nextState.wakes,
      releasedForegroundLease: terminal || JARVIS_RUN_LEASE_RELEASING_STATUSES.has(status),
    }),
  };
}

/** No-op idempotent : postimage inchangée, aucun intent — l'admission peut n'auditer que l'événement. */
function noop(
  run: CustomerContactRunEnvelope,
  state: CustomerContactStateV1,
  eventType: string,
  eventData: Readonly<Record<string, unknown>>,
): JarvisReduceResult {
  return {
    ok: true,
    value: Object.freeze({
      postimage: run,
      event: Object.freeze({
        type: eventType,
        version: CUSTOMER_CONTACT_EVENT_VERSION,
        data: Object.freeze(eventData),
      }),
      workItemIntents: EMPTY_INTENTS,
      wakes: state.wakes,
      releasedForegroundLease: false,
    }),
  };
}

function startRun(
  run: CustomerContactRunEnvelope,
  command: Extract<CustomerContactCommand, { type: 'start_run' }>,
  context: JarvisReduceContext,
): JarvisReduceResult {
  // §5.4 : l'effectId est préalloué par le SERVEUR dans la transaction d'admission — un seul par run.
  const effectId = context.allocatedEffectIds[0];
  if (effectId === undefined || !isCanonicalUuid(effectId)) return fail('missing_allocated_effect_id');
  const state = freezeState({
    schema: CUSTOMER_CONTACT_STATE_SCHEMA,
    version: CUSTOMER_CONTACT_STATE_VERSION,
    phase: 'resolving_customer',
    steps: 1,
    effectId,
    intent: command.intent,
    duplicateReview: null,
    proposal: null,
    confirmation: null,
    receipt: null,
    resolvedExistingCustomerId: null,
    submittedJobRef: null,
    wakes: EMPTY_WAKES,
    wakesScheduled: 0,
    cancelReason: null,
    failureReason: null,
  });
  return commit(run, context, state, 'cc_run_started', {
    mode: command.intent.mode,
    effectId,
    targetCustomerId: command.intent.mode === 'update' ? command.intent.target.customerId : null,
    targetRevision: command.intent.mode === 'update' ? command.intent.target.revision : null,
  }, EMPTY_INTENTS);
}

function reduceResolution(
  run: CustomerContactRunEnvelope,
  state: CustomerContactStateV1,
  command: Extract<CustomerContactCommand, { type: 'record_customer_resolution' }>,
  context: JarvisReduceContext,
): JarvisReduceResult {
  const resolution = command.resolution;
  if (state.intent.mode === 'create') {
    if (resolution.kind === 'target_verified') return fail('resolution_mode_mismatch');
    if (resolution.kind === 'no_duplicates') {
      return commit(
        run,
        context,
        withState(state, { phase: 'preparing_proposal' }),
        'cc_customer_resolution_recorded',
        { outcome: 'no_duplicates' },
        EMPTY_INTENTS,
      );
    }
    const candidateSetHash = computeCustomerContactCandidateSetHash({
      runId: run.runId,
      reviewId: resolution.reviewId,
      candidates: resolution.candidates,
    });
    const duplicateReview: CustomerContactDuplicateReviewV1 = Object.freeze({
      reviewId: resolution.reviewId,
      candidates: resolution.candidates,
      candidateSetHash,
    });
    return commit(
      run,
      context,
      withState(state, { phase: 'awaiting_duplicate_review', duplicateReview }),
      'cc_customer_resolution_recorded',
      {
        outcome: 'duplicate_candidates',
        reviewId: resolution.reviewId,
        candidateCount: resolution.candidates.length,
        candidateSetHash,
      },
      EMPTY_INTENTS,
    );
  }
  if (resolution.kind !== 'target_verified') return fail('resolution_mode_mismatch');
  // La cible relue doit être LA cible admise au démarrage — jamais substituée en cours de run.
  if (resolution.customerId !== state.intent.target.customerId) return fail('target_mismatch');
  // §8 — LA RÉVISION VÉRIFIÉE EST CELLE DE LA BASE, RELUE SOUS VERROU par l'admission dans CETTE
  // transaction. L'émetteur (la route d'ouverture, demain la voix) ne l'apporte pas : il ne peut
  // pas la prouver. Sans relecture, la résolution est REFUSÉE plutôt que scellée sur une graine —
  // sceller ici une révision fausse ne corromprait rien tout de suite, mais condamnerait toute
  // proposition ultérieure en `target_revision_stale`, sans que rien ne dise pourquoi.
  const revalidation = context.targetRevalidation ?? null;
  if (revalidation === null) return fail('target_revalidation_missing');
  const intent: CustomerContactIntentV1 = Object.freeze({
    mode: 'update' as const,
    target: Object.freeze({ customerId: resolution.customerId, revision: revalidation.revision }),
  });
  return commit(
    run,
    context,
    withState(state, { phase: 'preparing_proposal', intent }),
    'cc_customer_resolution_recorded',
    { outcome: 'target_verified', targetCustomerId: resolution.customerId, targetRevision: revalidation.revision },
    EMPTY_INTENTS,
  );
}

function reduceDuplicateDecision(
  run: CustomerContactRunEnvelope,
  state: CustomerContactStateV1,
  command: Extract<CustomerContactCommand, { type: 'choose_duplicate_resolution' }>,
  context: JarvisReduceContext,
): JarvisReduceResult {
  const review = state.duplicateReview;
  if (review === null || command.reviewId !== review.reviewId) return fail('review_mismatch');
  if (command.decision.kind === 'continue_create') {
    return commit(
      run,
      context,
      withState(state, { phase: 'preparing_proposal' }),
      'cc_duplicate_resolution_chosen',
      { reviewId: review.reviewId, decision: 'continue_create' },
      EMPTY_INTENTS,
    );
  }
  const choiceId = command.decision.choiceId;
  const candidate = review.candidates.find((entry) => entry.choiceId === choiceId);
  if (candidate === undefined) return fail('choice_unknown');
  // FD-06 : choisir un existant TERMINE le run sur ce client — aucun effet, aucune fusion.
  return commit(
    run,
    context,
    withState(state, { phase: 'completed', resolvedExistingCustomerId: candidate.customerId }),
    'cc_duplicate_resolution_chosen',
    { reviewId: review.reviewId, decision: 'use_existing', customerId: candidate.customerId },
    EMPTY_INTENTS,
  );
}

function reduceStageProposal(
  run: CustomerContactRunEnvelope,
  state: CustomerContactStateV1,
  command: Extract<CustomerContactCommand, { type: 'stage_proposal' }>,
  context: JarvisReduceContext,
): JarvisReduceResult {
  // §7.1 — LE SCEAU DE CIBLE naît ici, d'une relecture SOUS VERROU faite par l'admission dans
  // sa transaction : c'est ce sceau que le confirm comparera à une relecture fraîche. Sans lui,
  // la garde §9.1 n'aurait rien à comparer et resterait une promesse creuse.
  const revalidation = context.targetRevalidation ?? null;
  if (state.intent.mode === 'create') {
    if (command.targetRevision !== null) return fail('invalid_value');
    if (revalidation !== null) return fail('target_revalidation_forbidden');
  } else {
    if (command.targetRevision !== state.intent.target.revision) {
      // La proposition doit sceller la révision vérifiée courante — sinon elle naîtrait stale.
      return fail('target_revision_stale');
    }
    if (revalidation === null) return fail('target_revalidation_missing');
    // La cible RELUE fait autorité sur la révision vérifiée en §8 : si elle a bougé entre la
    // résolution et la mise en proposition, la proposition naîtrait déjà périmée.
    if (revalidation.revision !== state.intent.target.revision)
      return fail('target_revision_stale');
  }
  if (state.wakesScheduled >= CUSTOMER_CONTACT_LIMITS.maxWakes) return fail('max_wakes_exhausted');
  const epoch = instantEpoch(context.occurredAt);
  if (epoch === null) return fail('invalid_value');
  const actionId = state.intent.mode === 'create'
    ? CUSTOMER_CONTACT_CREATE_ACTION_ID
    : CUSTOMER_CONTACT_UPDATE_ACTION_ID;
  const proposalHash = computeCustomerContactProposalHash({
    runId: run.runId,
    proposalId: command.proposalId,
    actionId,
    fieldsDigest: command.fieldsDigest,
    sensitiveDigest: command.sensitiveDigest,
    targetRevision: command.targetRevision,
    effectId: state.effectId,
  });
  const proposal: CustomerContactProposalV1 = Object.freeze({
    proposalId: command.proposalId,
    proposalCommandId: context.commandId,
    fieldsDigest: command.fieldsDigest,
    sensitiveDigest: command.sensitiveDigest,
    targetRevision: command.targetRevision,
    // Le sceau de cible n'entre PAS dans `proposalHash` : ce hash est ce que le client rejoue
    // pour prouver qu'il confirme la proposition qu'il a VUE. La cible relue, elle, est une
    // affaire de serveur — un client n'a ni à la connaître ni à la répéter.
    targetSensitiveDigest: revalidation === null ? null : revalidation.sensitiveDigest,
    proposalHash,
  });
  const expiresAt = instantFromEpoch(epoch + CUSTOMER_CONTACT_CONFIRMATION_TTL_MS);
  const confirmation: CustomerContactConfirmationV1 = Object.freeze({
    confirmationId: command.confirmationId,
    status: 'issued' as const,
    issuedAt: context.occurredAt,
    presentedAt: null,
    expiresAt,
    consumedByCommandId: null,
    wakeId: command.confirmationId,
  });
  const wakes: readonly JarvisWake[] = Object.freeze([
    Object.freeze({ wakeId: command.confirmationId, kind: 'confirmation_ttl' as const, dueAt: expiresAt }),
  ]);
  return commit(
    run,
    context,
    withState(state, {
      phase: 'awaiting_confirmation',
      proposal,
      confirmation,
      wakes,
      wakesScheduled: state.wakesScheduled + 1,
    }),
    'cc_proposal_staged',
    {
      proposalId: command.proposalId,
      confirmationId: command.confirmationId,
      actionId,
      fieldsDigest: command.fieldsDigest,
      sensitiveDigest: command.sensitiveDigest,
      targetRevision: command.targetRevision,
      proposalHash,
      expiresAt,
    },
    EMPTY_INTENTS,
  );
}

/** Ferme la proposition courante (§7.1 : rejected | expired | invalidated) et rouvre la préparation. */
function closeProposal(
  run: CustomerContactRunEnvelope,
  state: CustomerContactStateV1,
  context: JarvisReduceContext,
  confirmationStatus: 'rejected' | 'expired' | 'invalidated',
  patch: Partial<CustomerContactStateV1>,
  eventType: string,
  eventData: Readonly<Record<string, unknown>>,
): JarvisReduceResult {
  const confirmation = state.confirmation;
  if (confirmation === null) return fail('confirmation_mismatch');
  return commit(
    run,
    context,
    withState(state, {
      phase: 'preparing_proposal',
      proposal: null,
      confirmation: Object.freeze({ ...confirmation, status: confirmationStatus }),
      wakes: EMPTY_WAKES,
      ...patch,
    }),
    eventType,
    eventData,
    EMPTY_INTENTS,
  );
}

function reduceConfirm(
  run: CustomerContactRunEnvelope,
  state: CustomerContactStateV1,
  command: Extract<CustomerContactCommand, { type: 'confirm' }>,
  context: JarvisReduceContext,
): JarvisReduceResult {
  const proposal = state.proposal;
  const confirmation = state.confirmation;
  if (proposal === null || confirmation === null) return fail('confirmation_mismatch');
  if (command.confirmationId !== confirmation.confirmationId) return fail('confirmation_mismatch');
  // §7.1 : seul `presented` se consomme — un reçu de présentation réel précède toute confirmation.
  if (confirmation.status !== 'presented') return fail('confirmation_not_presented');
  const occurredEpoch = instantEpoch(context.occurredAt);
  const expiresEpoch = instantEpoch(confirmation.expiresAt);
  if (occurredEpoch === null || expiresEpoch === null) return fail('invalid_value');
  if (occurredEpoch >= expiresEpoch) {
    // TTL atteint (frontière incluse : à l'instant EXACT d'expiration on refuse déjà) : la
    // confirmation expire — jamais `consumed`, le run ne devient jamais `expired`.
    return closeProposal(run, state, context, 'expired', {}, 'cc_proposal_expired', {
      confirmationId: confirmation.confirmationId,
      proposalId: proposal.proposalId,
      expiresAt: confirmation.expiresAt,
      via: 'confirm_attempt',
    });
  }
  if (command.proposalHash !== proposal.proposalHash) return fail('proposal_hash_mismatch');
  // §7.1/§9.1 — LA GARDE RÉELLE : la cible est RELUE par l'admission dans la transaction qui
  // consomme, sous le verrou de sa ligne ; on compare cette lecture au sceau posé à la mise en
  // proposition. Rien de ce qui est comparé ici ne vient du client.
  const revalidation = context.targetRevalidation ?? null;
  if (state.intent.mode === 'update') {
    // Cible non relue (disparue, ou admission qui ne la fournit pas) : on ne confirme JAMAIS
    // une modification à l'aveugle — refus nommé, zéro effet, proposition intacte.
    if (revalidation === null) return fail('target_revalidation_missing');
    if (
      revalidation.revision !== proposal.targetRevision
      || revalidation.sensitiveDigest !== proposal.targetSensitiveDigest
    ) {
      // §9.1 : cible mutée entre présentation et confirm => invalidated, JAMAIS consumed.
      const intent: CustomerContactIntentV1 = Object.freeze({
        mode: 'update' as const,
        target: Object.freeze({
          customerId: state.intent.target.customerId,
          revision: revalidation.revision,
        }),
      });
      return closeProposal(run, state, context, 'invalidated', { intent }, 'cc_proposal_invalidated', {
        confirmationId: confirmation.confirmationId,
        proposalId: proposal.proposalId,
        cause: 'stale_target',
        revalidatedTargetRevision: revalidation.revision,
      });
    }
  } else if (revalidation !== null) {
    return fail('target_revalidation_forbidden');
  }
  const actionId = state.intent.mode === 'create'
    ? CUSTOMER_CONTACT_CREATE_ACTION_ID
    : CUSTOMER_CONTACT_UPDATE_ACTION_ID;
  const workItemIntent: JarvisWorkItemIntent = Object.freeze({
    effectId: state.effectId,
    actionId,
    actionVersion: CUSTOMER_CONTACT_ACTION_VERSION,
    authorizationSource: Object.freeze({ source: 'confirmation' as const, receiptId: context.commandId }),
    actingPrincipalId: context.actingPrincipalId,
    targetDigest: state.intent.mode === 'update' && proposal.targetRevision !== null
      ? computeUpdateTargetDigest(state.intent.target.customerId, proposal.targetRevision)
      : null,
    payloadRef: Object.freeze({ proposalId: proposal.proposalId, fieldsDigest: proposal.fieldsDigest }),
    executeBy: instantFromEpoch(occurredEpoch + CUSTOMER_CONTACT_EXECUTE_BY_MS),
  });
  return commit(
    run,
    context,
    withState(state, {
      phase: 'committing',
      confirmation: Object.freeze({
        ...confirmation,
        status: 'consumed' as const,
        consumedByCommandId: context.commandId,
      }),
      wakes: EMPTY_WAKES,
    }),
    'cc_confirmation_consumed',
    {
      confirmationId: confirmation.confirmationId,
      proposalId: proposal.proposalId,
      proposalHash: proposal.proposalHash,
      effectId: state.effectId,
      actionId,
      actionVersion: CUSTOMER_CONTACT_ACTION_VERSION,
    },
    Object.freeze([workItemIntent]),
  );
}

function reduceEffectReceipt(
  run: CustomerContactRunEnvelope,
  state: CustomerContactStateV1,
  command: Extract<CustomerContactCommand, { type: 'record_effect_receipt' }>,
  context: JarvisReduceContext,
): JarvisReduceResult {
  // Staleness par effectId (§5.3) — jamais par la seule révision globale du run.
  if (command.effectId !== state.effectId) return fail('effect_id_mismatch');
  if (command.outcome.kind === 'succeeded') {
    if (
      state.intent.mode === 'update'
      && command.outcome.customerId !== state.intent.target.customerId
    ) {
      return fail('receipt_conflict');
    }
    const receipt: CustomerContactEffectReceiptV1 = Object.freeze({
      effectId: command.effectId,
      customerId: command.outcome.customerId,
      customerRevision: command.outcome.customerRevision,
      recordedAt: context.occurredAt,
    });
    // §5.3 : un succès externe n'est JAMAIS masqué — même si l'annulation a été demandée,
    // le run se termine `completed` et l'événement porte la demande d'annulation.
    return commit(
      run,
      context,
      withBudgetExemptState(state, { phase: 'completed', receipt }),
      'cc_effect_receipt_recorded',
      {
        effectId: command.effectId,
        customerId: command.outcome.customerId,
        customerRevision: command.outcome.customerRevision,
        cancellationRequested: state.phase === 'cancelling',
      },
      EMPTY_INTENTS,
    );
  }
  if (state.phase === 'cancelling') {
    // Effet échoué alors que l'annulation était demandée : le terminal honnête est
    // `cancelled` (cancelReason déjà scellé par cc_cancel_requested) ; le reasonCode de
    // l'échec est SCELLÉ dans failureReason pour que le replay du même reçu sur ce
    // terminal reste un no-op idempotent audité (§5.3) — jamais un receipt_conflict.
    return commit(
      run,
      context,
      withBudgetExemptState(state, { phase: 'cancelled', failureReason: command.outcome.reasonCode }),
      'cc_effect_failed',
      {
        effectId: command.effectId,
        reasonCode: command.outcome.reasonCode,
        cancellationRequested: true,
      },
      EMPTY_INTENTS,
    );
  }
  return commit(
    run,
    context,
    withBudgetExemptState(state, { phase: 'failed', failureReason: command.outcome.reasonCode }),
    'cc_effect_failed',
    { effectId: command.effectId, reasonCode: command.outcome.reasonCode },
    EMPTY_INTENTS,
  );
}

/**
 * Terminal figé, à l'unique exception §5.3 : le replay du reçu d'effet (même effectId, même
 * customerId) est un no-op explicite audité qui conserve le reçu — jamais un effet aval.
 */
function reduceOnTerminal(
  run: CustomerContactRunEnvelope,
  state: CustomerContactStateV1,
  command: CustomerContactCommand,
): JarvisReduceResult {
  if (command.type === 'record_effect_receipt') {
    if (command.effectId !== state.effectId) return fail('effect_id_mismatch');
    if (
      state.phase === 'completed'
      && state.receipt !== null
      && command.outcome.kind === 'succeeded'
      && command.outcome.customerId === state.receipt.customerId
      && command.outcome.customerRevision === state.receipt.customerRevision
    ) {
      return noop(run, state, 'cc_effect_receipt_replayed', {
        effectId: state.effectId,
        customerId: state.receipt.customerId,
      });
    }
    if (
      state.phase === 'failed'
      && command.outcome.kind === 'failed_terminal'
      && command.outcome.reasonCode === state.failureReason
    ) {
      return noop(run, state, 'cc_effect_receipt_replayed', {
        effectId: state.effectId,
        reasonCode: command.outcome.reasonCode,
      });
    }
    // `cancelled` issu de `cancelling` (failureReason scellé par le reçu failed) : le replay
    // du MÊME reçu (même effectId, même outcome failed) est un no-op idempotent audité —
    // jamais un receipt_conflict (§5.3, redélivrance level-triggered).
    if (
      state.phase === 'cancelled'
      && state.failureReason !== null
      && command.outcome.kind === 'failed_terminal'
      && command.outcome.reasonCode === state.failureReason
    ) {
      return noop(run, state, 'cc_effect_receipt_replayed', {
        effectId: state.effectId,
        reasonCode: command.outcome.reasonCode,
      });
    }
    // Un reçu divergent ne masque JAMAIS un résultat externe : conflit typé, escalade humaine.
    return fail('receipt_conflict');
  }
  return { ok: false, error: { code: 'run_terminal', status: run.status } };
}

function reduceStarted(
  run: CustomerContactRunEnvelope,
  state: CustomerContactStateV1,
  command: CustomerContactCommand,
  context: JarvisReduceContext,
): JarvisReduceResult {
  switch (command.type) {
    case 'start_run':
      return fail('already_started');
    case 'record_customer_resolution':
      if (state.phase !== 'resolving_customer') return fail('invalid_phase_for_command');
      return reduceResolution(run, state, command, context);
    case 'choose_duplicate_resolution':
      if (state.phase !== 'awaiting_duplicate_review') return fail('invalid_phase_for_command');
      return reduceDuplicateDecision(run, state, command, context);
    case 'stage_proposal':
      if (state.phase !== 'preparing_proposal') return fail('invalid_phase_for_command');
      return reduceStageProposal(run, state, command, context);
    case 'record_presentation_ack': {
      if (state.phase !== 'awaiting_confirmation') return fail('invalid_phase_for_command');
      const confirmation = state.confirmation;
      if (confirmation === null || command.confirmationId !== confirmation.confirmationId) {
        return fail('confirmation_mismatch');
      }
      if (confirmation.status !== 'issued') return fail('confirmation_already_presented');
      // §7.1 (patron SBA) : un ACK arrivé À ou APRÈS `expiresAt` n'atteint JAMAIS `presented` —
      // refus typé ; le wake TTL (ou un confirm tardif) expirera la proposition.
      const ackEpoch = instantEpoch(context.occurredAt);
      const ackExpiresEpoch = instantEpoch(confirmation.expiresAt);
      if (ackEpoch === null || ackExpiresEpoch === null) return fail('invalid_value');
      if (ackEpoch >= ackExpiresEpoch) return fail('confirmation_expired');
      return commit(
        run,
        context,
        withState(state, {
          confirmation: Object.freeze({
            ...confirmation,
            status: 'presented' as const,
            presentedAt: context.occurredAt,
          }),
        }),
        'cc_proposal_presented',
        { confirmationId: confirmation.confirmationId, ack: command.ack },
        EMPTY_INTENTS,
      );
    }
    case 'confirm': {
      // One-shot §7.1 (patron SBA) : une confirmation consommée ne se reconsomme JAMAIS.
      // Même commandId ⇒ le reçu d'admission REJOUE : no-op idempotent audité, l'intent
      // n'est jamais ré-émis ; autre commandId ⇒ conflit typé dédié.
      const consumedConfirmation = state.confirmation;
      if (
        consumedConfirmation !== null
        && consumedConfirmation.status === 'consumed'
        && command.confirmationId === consumedConfirmation.confirmationId
      ) {
        if (
          consumedConfirmation.consumedByCommandId === context.commandId
          && state.proposal !== null
          && command.proposalHash === state.proposal.proposalHash
        ) {
          return noop(run, state, 'cc_confirm_replayed', {
            confirmationId: consumedConfirmation.confirmationId,
            consumedByCommandId: consumedConfirmation.consumedByCommandId,
          });
        }
        return fail('confirmation_already_consumed');
      }
      if (state.phase !== 'awaiting_confirmation') return fail('invalid_phase_for_command');
      return reduceConfirm(run, state, command, context);
    }
    case 'reject_proposal': {
      if (state.phase !== 'awaiting_confirmation') return fail('invalid_phase_for_command');
      const confirmation = state.confirmation;
      const proposal = state.proposal;
      if (
        confirmation === null
        || proposal === null
        || command.confirmationId !== confirmation.confirmationId
      ) {
        return fail('confirmation_mismatch');
      }
      return closeProposal(run, state, context, 'rejected', {}, 'cc_proposal_rejected', {
        confirmationId: confirmation.confirmationId,
        proposalId: proposal.proposalId,
      });
    }
    case 'record_target_mutation': {
      if (state.intent.mode !== 'update') return fail('no_update_target');
      const intent: CustomerContactIntentV1 = Object.freeze({
        mode: 'update' as const,
        target: Object.freeze({
          customerId: state.intent.target.customerId,
          revision: command.targetRevision,
        }),
      });
      if (state.phase === 'preparing_proposal') {
        return commit(
          run,
          context,
          withState(state, { intent }),
          'cc_target_mutation_recorded',
          { mutatedField: command.mutatedField, targetRevision: command.targetRevision },
          EMPTY_INTENTS,
        );
      }
      if (state.phase === 'awaiting_confirmation') {
        const proposal = state.proposal;
        const confirmation = state.confirmation;
        if (proposal === null || confirmation === null) return fail('confirmation_mismatch');
        // §9.1 : champ sensible muté pendant la fenêtre de confirmation => invalidated, jamais consumed.
        return closeProposal(run, state, context, 'invalidated', { intent }, 'cc_proposal_invalidated', {
          confirmationId: confirmation.confirmationId,
          proposalId: proposal.proposalId,
          cause: 'target_mutation',
          mutatedField: command.mutatedField,
          targetRevision: command.targetRevision,
        });
      }
      // committing/awaiting_receipt : l'effet est autorisé (§7.1) — l'invalidation n'est jamais rétroactive.
      return fail('invalid_phase_for_command');
    }
    case 'record_effect_submitted': {
      if (state.phase !== 'committing') return fail('invalid_phase_for_command');
      if (command.effectId !== state.effectId) return fail('effect_id_mismatch');
      return commit(
        run,
        context,
        withState(state, { phase: 'awaiting_receipt', submittedJobRef: command.submittedJobRef }),
        'cc_effect_submitted',
        { effectId: state.effectId, submittedJobRef: command.submittedJobRef },
        EMPTY_INTENTS,
      );
    }
    case 'record_effect_receipt':
      // Le reçu peut arriver avant l'ACK de soumission (redélivrance level-triggered §5.3).
      if (
        state.phase !== 'committing'
        && state.phase !== 'awaiting_receipt'
        && state.phase !== 'cancelling'
      ) {
        return fail('invalid_phase_for_command');
      }
      return reduceEffectReceipt(run, state, command, context);
    case 'cancel_run': {
      if (state.phase === 'committing' || state.phase === 'awaiting_receipt') {
        // §5.3 : la confirmation est consommée, l'effet possiblement parti — on ne prétend
        // JAMAIS qu'il est annulé : le run passe en `cancelling` et continue d'observer
        // jusqu'au reçu (aligné sur single_business_action_v1).
        return commit(
          run,
          context,
          withBudgetExemptState(state, { phase: 'cancelling', cancelReason: command.reason }),
          'cc_cancel_requested',
          { reason: command.reason },
          EMPTY_INTENTS,
        );
      }
      if (state.phase === 'cancelling') {
        return fail('invalid_phase_for_command');
      }
      // §7.1 : le cycle se ferme dans le MÊME commit (patron SBA) — une confirmation encore
      // pendante (issued | presented) passe `invalidated`, cause authorization_revoked.
      const pendingConfirmation = state.confirmation !== null
        && (state.confirmation.status === 'issued' || state.confirmation.status === 'presented')
        ? state.confirmation
        : null;
      return commit(
        run,
        context,
        withBudgetExemptState(state, {
          phase: 'cancelled',
          cancelReason: command.reason,
          confirmation: pendingConfirmation === null
            ? state.confirmation
            : Object.freeze({ ...pendingConfirmation, status: 'invalidated' as const }),
          wakes: EMPTY_WAKES,
        }),
        'cc_run_cancelled',
        {
          reason: command.reason,
          invalidatedConfirmationId:
            pendingConfirmation === null ? null : pendingConfirmation.confirmationId,
          invalidationCause: pendingConfirmation === null ? null : 'authorization_revoked',
        },
        EMPTY_INTENTS,
      );
    }
    case 'wake_run': {
      const confirmation = state.confirmation;
      const pendingWake = state.wakes.find((wake) => wake.wakeId === command.wakeId);
      if (
        state.phase === 'awaiting_confirmation'
        && pendingWake !== undefined
        && confirmation !== null
        && pendingWake.wakeId === confirmation.wakeId
        && (confirmation.status === 'issued' || confirmation.status === 'presented')
      ) {
        const occurredEpoch = instantEpoch(context.occurredAt);
        const dueEpoch = instantEpoch(pendingWake.dueAt);
        if (occurredEpoch === null || dueEpoch === null) return fail('invalid_value');
        if (occurredEpoch >= dueEpoch) {
          const proposal = state.proposal;
          if (proposal === null) return fail('confirmation_mismatch');
          return closeProposal(run, state, context, 'expired', {}, 'cc_proposal_expired', {
            confirmationId: confirmation.confirmationId,
            proposalId: proposal.proposalId,
            expiresAt: confirmation.expiresAt,
            via: 'wake',
          });
        }
      }
      // Wake inconnu, périmé ou prématuré : no-op idempotent — le scanner ne mute jamais un run.
      return noop(run, state, 'cc_wake_noop', { wakeId: command.wakeId });
    }
  }
}

function reduceCustomerContact(
  run: CustomerContactRunEnvelope,
  command: unknown,
  context: JarvisReduceContext,
): JarvisReduceResult {
  if (run.kind !== 'customer_contact') return fail('kind_mismatch');
  // Canonicité §5.4 AVANT toute transition : `context.commandId` et `context.occurredAt` sont
  // scellés TELS QUELS dans le state (proposalCommandId, consumedByCommandId, presentedAt,
  // recordedAt, ...) alors que le parse exige un UUID canonique et un instant round-trip —
  // un contexte non canonique produirait un state qui ne reparserait JAMAIS (run briqué en
  // `state_shape`). Refus typé immédiat, aucune postimage.
  if (!isCanonicalUuid(context.commandId) || instantEpoch(context.occurredAt) === null) {
    return fail('invalid_value');
  }
  const parsed = parseCustomerContactCommand(command);
  if (parsed === null) return fail('command_shape');
  if (context.expectedRevision !== run.revision) {
    return {
      ok: false,
      error: {
        code: 'revision_conflict',
        expectedRevision: context.expectedRevision,
        actualRevision: run.revision,
      },
    };
  }
  if (run.state === null) {
    if (parsed.type !== 'start_run') return fail('run_not_started');
    return startRun(run, parsed, context);
  }
  if (run.stateVersion !== CUSTOMER_CONTACT_STATE_VERSION) return fail('state_shape');
  const state = parseCustomerContactState(run.state);
  if (state === null) return fail('state_shape');
  if (JARVIS_RUN_TERMINAL_STATUSES.has(run.status)) {
    return reduceOnTerminal(run, state, parsed);
  }
  return reduceStarted(run, state, parsed, context);
}

// ---------------------------------------------------------------------------
// Module de définition §4.3 — enregistré dans le registre gelé du reducer racine
// ---------------------------------------------------------------------------

export const CUSTOMER_CONTACT_V1: JarvisDefinitionModule = Object.freeze({
  kind: 'customer_contact' as const,
  definitionVersion: CUSTOMER_CONTACT_DEFINITION_VERSION,
  stateVersion: CUSTOMER_CONTACT_STATE_VERSION,
  limits: CUSTOMER_CONTACT_LIMITS,
  reduce: reduceCustomerContact,
});

registerJarvisDefinition(CUSTOMER_CONTACT_V1);

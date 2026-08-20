/**
 * Définition `single_business_action@1` (spec Jarvis §4.3) — lot U1-b.
 *
 * Une action cataloguée ISOLÉE, pincée `actionId@version` au démarrage du run, avec AU PLUS UN
 * effet mutant sur toute la vie du run (prouvé par property test). Module de transitions PURES :
 * aucune I/O, aucun aléa, aucune horloge ambiante — `occurredAt` et les `effectId` préalloués
 * viennent exclusivement du `JarvisReduceContext` d'admission (§5.4). Le module n'importe RIEN
 * hors de `domain/agent/*` et du shared-kernel.
 *
 * Phases fermées : `preparing -> awaiting_confirmation -> committing -> awaiting_receipt ->
 * completed`, plus les branches `failed_terminal` (échec du reçu d'effet), `cancelled` (cancel
 * AVANT autorisation) et `cancelling` (cancel APRÈS autorisation : le run OBSERVE le reçu — il ne
 * prétend JAMAIS annulé un appel possiblement parti, §5.3). Le cycle de confirmation §7.1 est
 * complet : `issued -> presented -> consumed | rejected | expired | invalidated`, consommation
 * one-shot, invalidation jamais rétroactive.
 */

import { jsonUtf8Fits } from '../../../shared-kernel/json-size';
import { type Instant } from '../../../shared-kernel/time';
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
  type JarvisDefinitionActionReference,
  type JarvisDefinitionModule,
  type JarvisReduceContext,
  type JarvisReduceResult,
  type JarvisRunEventDraft,
} from '../jarvis-run-reducer';
import type { JarvisWorkItemIntent } from '../jarvis-work-item';

// ---------------------------------------------------------------------------
// Vocabulaire fermé
// ---------------------------------------------------------------------------

export const SINGLE_BUSINESS_ACTION_KIND = 'single_business_action' as const;
export const SINGLE_BUSINESS_ACTION_DEFINITION_VERSION = 1 as const;
export const SINGLE_BUSINESS_ACTION_STATE_SCHEMA = 'bob.jarvis-run.single-business-action' as const;
export const SINGLE_BUSINESS_ACTION_STATE_VERSION = 1 as const;

/** Bornes fermées §4.3 — fixées par la définition, jamais par le modèle. */
export const SINGLE_BUSINESS_ACTION_LIMITS: JarvisDefinitionLimits = Object.freeze({
  maxSteps: 32,
  maxOpenWorkItems: 1,
  maxStateBytes: 64 * 1024,
  idleTtlMs: 24 * 60 * 60 * 1_000,
  hardTtlMs: 7 * 24 * 60 * 60 * 1_000,
  maxWakes: 4,
});

export const SINGLE_BUSINESS_ACTION_PHASES = Object.freeze([
  'preparing',
  'awaiting_confirmation',
  'committing',
  'awaiting_receipt',
  'cancelling',
  'completed',
  'failed_terminal',
  'cancelled',
] as const);
export type SingleBusinessActionPhase = (typeof SINGLE_BUSINESS_ACTION_PHASES)[number];

export const SINGLE_BUSINESS_ACTION_TERMINAL_PHASES: ReadonlySet<SingleBusinessActionPhase> =
  new Set(['completed', 'failed_terminal', 'cancelled']);

/** Cycle §7.1 : `issued -> presented -> consumed | rejected | expired | invalidated`. */
export const SINGLE_BUSINESS_ACTION_PROPOSAL_STATUSES = Object.freeze([
  'issued',
  'presented',
  'consumed',
  'rejected',
  'expired',
  'invalidated',
] as const);
export type SingleBusinessActionProposalStatus =
  (typeof SINGLE_BUSINESS_ACTION_PROPOSAL_STATUSES)[number];

/** Reçus de présentation §7.1 — `screen_ack` obligatoire n'est JAMAIS atteint par la voix. */
export const SINGLE_BUSINESS_ACTION_PRESENTATION_ACKS = Object.freeze([
  'screen_ack',
  'voice_presentation_ack',
] as const);
export type SingleBusinessActionPresentationAck =
  (typeof SINGLE_BUSINESS_ACTION_PRESENTATION_ACKS)[number];

/** Motifs fermés d'invalidation §7.1 — jamais une confirmation rétroactive. */
export const SINGLE_BUSINESS_ACTION_INVALIDATION_REASONS = Object.freeze([
  'target_mutated',
  'authorization_revoked',
  'recipient_changed',
  'amount_drifted',
  'session_not_authorized',
  'stale_presentation',
] as const);
export type SingleBusinessActionInvalidationReason =
  (typeof SINGLE_BUSINESS_ACTION_INVALIDATION_REASONS)[number];

export const SINGLE_BUSINESS_ACTION_CANCEL_REASONS = Object.freeze([
  'user_cancelled',
  'manual_handoff',
] as const);
export type SingleBusinessActionCancelReason =
  (typeof SINGLE_BUSINESS_ACTION_CANCEL_REASONS)[number];

/** Types d'événements namespacés `sba_` (un seul élargissement de CHECK en U1-c). */
export const SINGLE_BUSINESS_ACTION_EVENT_TYPES = Object.freeze([
  'sba_proposal_staged',
  'sba_presentation_acknowledged',
  'sba_proposal_rejected',
  'sba_proposal_invalidated',
  'sba_proposal_expired',
  'sba_confirmed',
  'sba_effect_submitted',
  'sba_effect_succeeded',
  'sba_effect_failed',
  'sba_effect_receipt_deduplicated',
  'sba_run_cancelled',
  'sba_run_cancelling',
  'sba_wake_ignored',
] as const);
export type SingleBusinessActionEventType = (typeof SINGLE_BUSINESS_ACTION_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// State fermé v1
// ---------------------------------------------------------------------------

/**
 * Proposition digestée §7.1 : le state ne porte JAMAIS le contenu de l'action — uniquement
 * digests, références et bornes. `ttlWakeId` est stable (§5.1 : `nextWakeAt` n'est qu'un index).
 */
export interface SingleBusinessActionProposalV1 {
  readonly proposalId: string;
  readonly proposalCommandId: string;
  readonly canonicalInputDigest: string;
  readonly proposalHash: string;
  readonly presentationRequirement: SingleBusinessActionPresentationAck;
  readonly targetDigest: string | null;
  readonly payloadRef: Readonly<Record<string, string>> | null;
  readonly confirmationTtlMs: number;
  readonly executeWindowMs: number;
  readonly status: SingleBusinessActionProposalStatus;
  readonly issuedAt: Instant;
  readonly presentedAt: Instant | null;
  readonly presentationAck: SingleBusinessActionPresentationAck | null;
  readonly expiresAt: Instant;
  readonly ttlWakeId: string;
  readonly consumedByCommandId: string | null;
  readonly invalidationReason: SingleBusinessActionInvalidationReason | null;
}

/**
 * Checkpoint d'effet unique (§5.3) : `effectId` préalloué serveur, `submittedJobRef` = ID du
 * job/reçu de l'outbox métier canonique observée (jamais une seconde outbox), résultat immuable.
 */
export interface SingleBusinessActionEffectV1 {
  readonly effectId: string;
  readonly proposalId: string;
  readonly authorizationReceiptId: string;
  readonly actingPrincipalId: string;
  readonly executeBy: Instant;
  readonly submittedJobRef: string | null;
  readonly outcome: 'succeeded' | 'failed' | null;
  readonly resultDigest: string | null;
}

export interface SingleBusinessActionCancellationV1 {
  readonly reason: SingleBusinessActionCancelReason;
  readonly requestedAt: Instant;
}

export interface SingleBusinessActionStateV1 {
  readonly schema: typeof SINGLE_BUSINESS_ACTION_STATE_SCHEMA;
  readonly version: typeof SINGLE_BUSINESS_ACTION_STATE_VERSION;
  readonly phase: SingleBusinessActionPhase;
  /** Action cataloguée pincée au démarrage — un déploiement ne la remplace jamais (§5.1). */
  readonly action: { readonly actionId: string; readonly actionVersion: number };
  readonly stepCount: number;
  readonly registeredWakeCount: number;
  readonly proposal: SingleBusinessActionProposalV1 | null;
  readonly effect: SingleBusinessActionEffectV1 | null;
  readonly cancellation: SingleBusinessActionCancellationV1 | null;
}

const STATE_KEYS = [
  'schema',
  'version',
  'phase',
  'action',
  'stepCount',
  'registeredWakeCount',
  'proposal',
  'effect',
  'cancellation',
] as const;
const ACTION_KEYS = ['actionId', 'actionVersion'] as const;
const PROPOSAL_KEYS = [
  'proposalId',
  'proposalCommandId',
  'canonicalInputDigest',
  'proposalHash',
  'presentationRequirement',
  'targetDigest',
  'payloadRef',
  'confirmationTtlMs',
  'executeWindowMs',
  'status',
  'issuedAt',
  'presentedAt',
  'presentationAck',
  'expiresAt',
  'ttlWakeId',
  'consumedByCommandId',
  'invalidationReason',
] as const;
const EFFECT_KEYS = [
  'effectId',
  'proposalId',
  'authorizationReceiptId',
  'actingPrincipalId',
  'executeBy',
  'submittedJobRef',
  'outcome',
  'resultDigest',
] as const;
const CANCELLATION_KEYS = ['reason', 'requestedAt'] as const;

// ---------------------------------------------------------------------------
// Commandes fermées
// ---------------------------------------------------------------------------

export type SingleBusinessActionCommand =
  | {
      readonly type: 'stage_proposal';
      readonly proposalId: string;
      readonly canonicalInputDigest: string;
      readonly proposalHash: string;
      readonly presentationRequirement: SingleBusinessActionPresentationAck;
      readonly targetDigest: string | null;
      readonly payloadRef: Readonly<Record<string, string>> | null;
      /** TTL de confirmation de l'action cataloguée (§7.1) — dérivé du catalogue par l'admission. */
      readonly confirmationTtlMs: number;
      /** Fenêtre de dispatch de l'effet (`executeBy`, §5.3) — dérivée du catalogue par l'admission. */
      readonly executeWindowMs: number;
    }
  | {
      readonly type: 'record_presentation_ack';
      readonly proposalId: string;
      readonly ack: SingleBusinessActionPresentationAck;
    }
  | { readonly type: 'confirm'; readonly proposalId: string; readonly proposalHash: string }
  | { readonly type: 'reject'; readonly proposalId: string }
  | {
      readonly type: 'invalidate_proposal';
      readonly proposalId: string;
      readonly reason: SingleBusinessActionInvalidationReason;
    }
  | {
      readonly type: 'record_effect_receipt';
      readonly effectId: string;
      readonly receipt:
        | { readonly kind: 'submitted'; readonly jobRef: string }
        | { readonly kind: 'succeeded'; readonly resultDigest: string }
        | { readonly kind: 'failed_terminal'; readonly failureDigest: string };
    }
  | { readonly type: 'cancel_run'; readonly reason: SingleBusinessActionCancelReason }
  | { readonly type: 'wake_run'; readonly wakeId: string };

const COMMAND_KEYS: Record<SingleBusinessActionCommand['type'], readonly string[]> = {
  stage_proposal: [
    'type',
    'proposalId',
    'canonicalInputDigest',
    'proposalHash',
    'presentationRequirement',
    'targetDigest',
    'payloadRef',
    'confirmationTtlMs',
    'executeWindowMs',
  ],
  record_presentation_ack: ['type', 'proposalId', 'ack'],
  confirm: ['type', 'proposalId', 'proposalHash'],
  reject: ['type', 'proposalId'],
  invalidate_proposal: ['type', 'proposalId', 'reason'],
  record_effect_receipt: ['type', 'effectId', 'receipt'],
  cancel_run: ['type', 'reason'],
  wake_run: ['type', 'wakeId'],
};
const RECEIPT_KEYS = {
  submitted: ['kind', 'jobRef'],
  succeeded: ['kind', 'resultDigest'],
  failed_terminal: ['kind', 'failureDigest'],
} as const;

// ---------------------------------------------------------------------------
// Erreurs typées fermées (embarquées dans `delegated_error` du reducer racine)
// ---------------------------------------------------------------------------

export type SingleBusinessActionError =
  | {
      readonly code: 'single_business_action_invalid_command';
      readonly field: string;
      readonly reason:
        | 'invalid_shape'
        | 'unknown_type'
        | 'invalid_identifier'
        | 'invalid_uuid'
        | 'invalid_digest'
        | 'invalid_value'
        | 'invalid_instant';
    }
  | { readonly code: 'single_business_action_invalid_state'; readonly field: string }
  | {
      readonly code: 'single_business_action_invalid_transition';
      readonly phase: SingleBusinessActionPhase;
      readonly command: SingleBusinessActionCommand['type'];
    }
  | {
      readonly code: 'single_business_action_confirmation_conflict';
      readonly reason:
        | 'proposal_unknown'
        | 'proposal_hash_mismatch'
        | 'not_presented'
        | 'already_presented'
        | 'ack_channel_insufficient'
        | 'expired'
        | 'already_consumed'
        | 'already_consumed_same_command'
        | 'not_pending';
    }
  | {
      readonly code: 'single_business_action_effect_conflict';
      readonly reason:
        | 'effect_id_not_allocated'
        | 'unknown_effect_id'
        | 'job_ref_mismatch'
        | 'result_mismatch';
    }
  | {
      readonly code: 'single_business_action_limit_exceeded';
      readonly limit: 'max_steps' | 'max_wakes' | 'max_state_bytes';
    }
  | { readonly code: 'single_business_action_cancel_conflict'; readonly reason: 'already_cancelling' };

export function isSingleBusinessActionError(value: unknown): value is SingleBusinessActionError {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { code?: unknown }).code === 'string'
    && (value as { code: string }).code.startsWith('single_business_action_')
  );
}

function fail(error: SingleBusinessActionError): JarvisReduceResult {
  return { ok: false, error: { code: 'delegated_error', error } };
}

// ---------------------------------------------------------------------------
// Helpers de validation (idiome maison : exact-keys, identifiants canoniques)
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

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function isInstant(value: unknown): value is Instant {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** Instant CANONIQUE (§5.4) : round-trip exact `toISOString` — même garde que customer-contact. */
function isCanonicalInstant(value: unknown): value is Instant {
  if (typeof value !== 'string') return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPayloadRef(value: unknown): value is Readonly<Record<string, string>> {
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) => isCanonicalIdentifier(key) && isCanonicalIdentifier(entry),
  );
}

/** Conversion pure Instant + durée — jamais d'horloge ambiante (`new Date()` sans argument). */
function addMillis(instant: Instant, ms: number): Instant {
  return new Date(Date.parse(instant) + ms).toISOString();
}

/** `wakeId` stable dérivé de la proposition (§5.1) — déterministe, jamais tiré au hasard. */
function confirmationTtlWakeId(proposalId: string): string {
  return `sba-confirmation-ttl:${proposalId}`;
}

// ---------------------------------------------------------------------------
// Parse du state (exact-keys + invariants de cohérence phase/proposition/effet)
// ---------------------------------------------------------------------------

function invalidState(field: string): { readonly ok: false; readonly error: SingleBusinessActionError } {
  return { ok: false, error: { code: 'single_business_action_invalid_state', field } };
}

export function parseSingleBusinessActionState(
  value: unknown,
):
  | { readonly ok: true; readonly value: SingleBusinessActionStateV1 }
  | { readonly ok: false; readonly error: SingleBusinessActionError } {
  if (!isPlainRecord(value) || !exactKeys(value, STATE_KEYS)) return invalidState('$');
  if (value['schema'] !== SINGLE_BUSINESS_ACTION_STATE_SCHEMA) return invalidState('schema');
  if (value['version'] !== SINGLE_BUSINESS_ACTION_STATE_VERSION) return invalidState('version');
  const phase = value['phase'];
  if (!(SINGLE_BUSINESS_ACTION_PHASES as readonly unknown[]).includes(phase)) {
    return invalidState('phase');
  }
  const action = value['action'];
  if (!isPlainRecord(action) || !exactKeys(action, ACTION_KEYS)) return invalidState('action');
  if (!isCanonicalIdentifier(action['actionId'])) return invalidState('action.actionId');
  if (!isPositiveInt(action['actionVersion'])) return invalidState('action.actionVersion');
  if (!isNonNegativeInt(value['stepCount'])) return invalidState('stepCount');
  if (!isNonNegativeInt(value['registeredWakeCount'])) return invalidState('registeredWakeCount');

  const proposal = value['proposal'];
  if (proposal !== null) {
    if (!isPlainRecord(proposal) || !exactKeys(proposal, PROPOSAL_KEYS)) {
      return invalidState('proposal');
    }
    if (!isCanonicalUuid(proposal['proposalId'])) return invalidState('proposal.proposalId');
    if (!isCanonicalIdentifier(proposal['proposalCommandId'])) {
      return invalidState('proposal.proposalCommandId');
    }
    if (!isSha256Digest(proposal['canonicalInputDigest'])) {
      return invalidState('proposal.canonicalInputDigest');
    }
    if (!isSha256Digest(proposal['proposalHash'])) return invalidState('proposal.proposalHash');
    if (
      !(SINGLE_BUSINESS_ACTION_PRESENTATION_ACKS as readonly unknown[]).includes(
        proposal['presentationRequirement'],
      )
    ) {
      return invalidState('proposal.presentationRequirement');
    }
    if (proposal['targetDigest'] !== null && !isSha256Digest(proposal['targetDigest'])) {
      return invalidState('proposal.targetDigest');
    }
    if (proposal['payloadRef'] !== null && !isPayloadRef(proposal['payloadRef'])) {
      return invalidState('proposal.payloadRef');
    }
    if (!isPositiveInt(proposal['confirmationTtlMs'])) {
      return invalidState('proposal.confirmationTtlMs');
    }
    if (!isPositiveInt(proposal['executeWindowMs'])) return invalidState('proposal.executeWindowMs');
    if (
      !(SINGLE_BUSINESS_ACTION_PROPOSAL_STATUSES as readonly unknown[]).includes(proposal['status'])
    ) {
      return invalidState('proposal.status');
    }
    if (!isInstant(proposal['issuedAt'])) return invalidState('proposal.issuedAt');
    if (proposal['presentedAt'] !== null && !isInstant(proposal['presentedAt'])) {
      return invalidState('proposal.presentedAt');
    }
    if (
      proposal['presentationAck'] !== null
      && !(SINGLE_BUSINESS_ACTION_PRESENTATION_ACKS as readonly unknown[]).includes(
        proposal['presentationAck'],
      )
    ) {
      return invalidState('proposal.presentationAck');
    }
    if (!isInstant(proposal['expiresAt'])) return invalidState('proposal.expiresAt');
    if (proposal['ttlWakeId'] !== confirmationTtlWakeId(proposal['proposalId'] as string)) {
      return invalidState('proposal.ttlWakeId');
    }
    if (
      proposal['consumedByCommandId'] !== null
      && !isCanonicalIdentifier(proposal['consumedByCommandId'])
    ) {
      return invalidState('proposal.consumedByCommandId');
    }
    if (
      proposal['invalidationReason'] !== null
      && !(SINGLE_BUSINESS_ACTION_INVALIDATION_REASONS as readonly unknown[]).includes(
        proposal['invalidationReason'],
      )
    ) {
      return invalidState('proposal.invalidationReason');
    }
  }

  const effect = value['effect'];
  if (effect !== null) {
    if (!isPlainRecord(effect) || !exactKeys(effect, EFFECT_KEYS)) return invalidState('effect');
    if (!isCanonicalIdentifier(effect['effectId'])) return invalidState('effect.effectId');
    if (!isCanonicalUuid(effect['proposalId'])) return invalidState('effect.proposalId');
    if (!isCanonicalIdentifier(effect['authorizationReceiptId'])) {
      return invalidState('effect.authorizationReceiptId');
    }
    if (!isCanonicalIdentifier(effect['actingPrincipalId'])) {
      return invalidState('effect.actingPrincipalId');
    }
    if (!isInstant(effect['executeBy'])) return invalidState('effect.executeBy');
    if (effect['submittedJobRef'] !== null && !isCanonicalIdentifier(effect['submittedJobRef'])) {
      return invalidState('effect.submittedJobRef');
    }
    if (
      effect['outcome'] !== null
      && effect['outcome'] !== 'succeeded'
      && effect['outcome'] !== 'failed'
    ) {
      return invalidState('effect.outcome');
    }
    if (effect['resultDigest'] !== null && !isSha256Digest(effect['resultDigest'])) {
      return invalidState('effect.resultDigest');
    }
  }

  const cancellation = value['cancellation'];
  if (cancellation !== null) {
    if (!isPlainRecord(cancellation) || !exactKeys(cancellation, CANCELLATION_KEYS)) {
      return invalidState('cancellation');
    }
    if (
      !(SINGLE_BUSINESS_ACTION_CANCEL_REASONS as readonly unknown[]).includes(cancellation['reason'])
    ) {
      return invalidState('cancellation.reason');
    }
    if (!isInstant(cancellation['requestedAt'])) return invalidState('cancellation.requestedAt');
  }

  const state = value as unknown as SingleBusinessActionStateV1;
  // Invariants croisés phase/proposition/effet — un state incohérent est refusé, jamais toléré.
  const pendingProposal =
    state.proposal !== null && (state.proposal.status === 'issued' || state.proposal.status === 'presented');
  switch (state.phase) {
    case 'preparing':
      if (state.effect !== null) return invalidState('effect');
      if (pendingProposal) return invalidState('proposal.status');
      break;
    case 'awaiting_confirmation':
      if (state.effect !== null) return invalidState('effect');
      if (!pendingProposal) return invalidState('proposal.status');
      break;
    case 'committing':
      if (state.effect === null || state.effect.outcome !== null || state.effect.submittedJobRef !== null) {
        return invalidState('effect');
      }
      break;
    case 'awaiting_receipt':
      if (state.effect === null || state.effect.outcome !== null || state.effect.submittedJobRef === null) {
        return invalidState('effect');
      }
      break;
    case 'cancelling':
      if (state.effect === null || state.effect.outcome !== null) return invalidState('effect');
      if (state.cancellation === null) return invalidState('cancellation');
      break;
    case 'completed':
      if (state.effect === null || state.effect.outcome !== 'succeeded') return invalidState('effect');
      break;
    case 'failed_terminal':
      if (state.effect === null || state.effect.outcome !== 'failed') return invalidState('effect');
      break;
    case 'cancelled':
      if (state.cancellation === null) return invalidState('cancellation');
      if (state.effect !== null && state.effect.outcome !== 'failed') return invalidState('effect');
      break;
  }
  if (state.effect !== null) {
    if (state.proposal === null || state.proposal.status !== 'consumed') {
      return invalidState('proposal.status');
    }
    if (state.effect.proposalId !== state.proposal.proposalId) {
      return invalidState('effect.proposalId');
    }
  }
  return { ok: true, value: state };
}

/** State initial `preparing` — l'action cataloguée est pincée ici et plus jamais remplacée. */
export function initialSingleBusinessActionState(input: {
  readonly actionId: string;
  readonly actionVersion: number;
}):
  | { readonly ok: true; readonly value: SingleBusinessActionStateV1 }
  | { readonly ok: false; readonly error: SingleBusinessActionError } {
  if (!isCanonicalIdentifier(input.actionId)) {
    return {
      ok: false,
      error: {
        code: 'single_business_action_invalid_command',
        field: 'actionId',
        reason: 'invalid_identifier',
      },
    };
  }
  if (!isPositiveInt(input.actionVersion)) {
    return {
      ok: false,
      error: {
        code: 'single_business_action_invalid_command',
        field: 'actionVersion',
        reason: 'invalid_value',
      },
    };
  }
  return {
    ok: true,
    value: freezeState({
      schema: SINGLE_BUSINESS_ACTION_STATE_SCHEMA,
      version: SINGLE_BUSINESS_ACTION_STATE_VERSION,
      phase: 'preparing',
      action: { actionId: input.actionId, actionVersion: input.actionVersion },
      stepCount: 0,
      registeredWakeCount: 0,
      proposal: null,
      effect: null,
      cancellation: null,
    }),
  };
}

// ---------------------------------------------------------------------------
// Parse des commandes (exact-keys, unions fermées)
// ---------------------------------------------------------------------------

function invalidCommand(
  field: string,
  reason: Extract<
    SingleBusinessActionError,
    { code: 'single_business_action_invalid_command' }
  >['reason'],
): { readonly ok: false; readonly error: SingleBusinessActionError } {
  return { ok: false, error: { code: 'single_business_action_invalid_command', field, reason } };
}

export function parseSingleBusinessActionCommand(
  value: unknown,
):
  | { readonly ok: true; readonly value: SingleBusinessActionCommand }
  | { readonly ok: false; readonly error: SingleBusinessActionError } {
  if (!isPlainRecord(value)) return invalidCommand('$', 'invalid_shape');
  const type = value['type'];
  if (typeof type !== 'string' || !Object.hasOwn(COMMAND_KEYS, type)) {
    return invalidCommand('type', 'unknown_type');
  }
  const commandType = type as SingleBusinessActionCommand['type'];
  if (!exactKeys(value, COMMAND_KEYS[commandType])) return invalidCommand('$', 'invalid_shape');
  switch (commandType) {
    case 'stage_proposal': {
      if (!isCanonicalUuid(value['proposalId'])) return invalidCommand('proposalId', 'invalid_uuid');
      if (!isSha256Digest(value['canonicalInputDigest'])) {
        return invalidCommand('canonicalInputDigest', 'invalid_digest');
      }
      if (!isSha256Digest(value['proposalHash'])) return invalidCommand('proposalHash', 'invalid_digest');
      if (
        !(SINGLE_BUSINESS_ACTION_PRESENTATION_ACKS as readonly unknown[]).includes(
          value['presentationRequirement'],
        )
      ) {
        return invalidCommand('presentationRequirement', 'invalid_value');
      }
      if (value['targetDigest'] !== null && !isSha256Digest(value['targetDigest'])) {
        return invalidCommand('targetDigest', 'invalid_digest');
      }
      if (value['payloadRef'] !== null && !isPayloadRef(value['payloadRef'])) {
        return invalidCommand('payloadRef', 'invalid_shape');
      }
      if (
        !isPositiveInt(value['confirmationTtlMs'])
        || value['confirmationTtlMs'] > SINGLE_BUSINESS_ACTION_LIMITS.idleTtlMs
      ) {
        return invalidCommand('confirmationTtlMs', 'invalid_value');
      }
      if (
        !isPositiveInt(value['executeWindowMs'])
        || value['executeWindowMs'] > SINGLE_BUSINESS_ACTION_LIMITS.hardTtlMs
      ) {
        return invalidCommand('executeWindowMs', 'invalid_value');
      }
      break;
    }
    case 'record_presentation_ack': {
      if (!isCanonicalUuid(value['proposalId'])) return invalidCommand('proposalId', 'invalid_uuid');
      if (!(SINGLE_BUSINESS_ACTION_PRESENTATION_ACKS as readonly unknown[]).includes(value['ack'])) {
        return invalidCommand('ack', 'invalid_value');
      }
      break;
    }
    case 'confirm': {
      if (!isCanonicalUuid(value['proposalId'])) return invalidCommand('proposalId', 'invalid_uuid');
      if (!isSha256Digest(value['proposalHash'])) return invalidCommand('proposalHash', 'invalid_digest');
      break;
    }
    case 'reject': {
      if (!isCanonicalUuid(value['proposalId'])) return invalidCommand('proposalId', 'invalid_uuid');
      break;
    }
    case 'invalidate_proposal': {
      if (!isCanonicalUuid(value['proposalId'])) return invalidCommand('proposalId', 'invalid_uuid');
      if (
        !(SINGLE_BUSINESS_ACTION_INVALIDATION_REASONS as readonly unknown[]).includes(value['reason'])
      ) {
        return invalidCommand('reason', 'invalid_value');
      }
      break;
    }
    case 'record_effect_receipt': {
      if (!isCanonicalIdentifier(value['effectId'])) {
        return invalidCommand('effectId', 'invalid_identifier');
      }
      const receipt = value['receipt'];
      if (!isPlainRecord(receipt)) return invalidCommand('receipt', 'invalid_shape');
      const kind = receipt['kind'];
      if (kind !== 'submitted' && kind !== 'succeeded' && kind !== 'failed_terminal') {
        return invalidCommand('receipt.kind', 'invalid_value');
      }
      if (!exactKeys(receipt, RECEIPT_KEYS[kind])) return invalidCommand('receipt', 'invalid_shape');
      if (kind === 'submitted' && !isCanonicalIdentifier(receipt['jobRef'])) {
        return invalidCommand('receipt.jobRef', 'invalid_identifier');
      }
      if (kind === 'succeeded' && !isSha256Digest(receipt['resultDigest'])) {
        return invalidCommand('receipt.resultDigest', 'invalid_digest');
      }
      if (kind === 'failed_terminal' && !isSha256Digest(receipt['failureDigest'])) {
        return invalidCommand('receipt.failureDigest', 'invalid_digest');
      }
      break;
    }
    case 'cancel_run': {
      if (!(SINGLE_BUSINESS_ACTION_CANCEL_REASONS as readonly unknown[]).includes(value['reason'])) {
        return invalidCommand('reason', 'invalid_value');
      }
      break;
    }
    case 'wake_run': {
      if (!isCanonicalIdentifier(value['wakeId'])) return invalidCommand('wakeId', 'invalid_identifier');
      break;
    }
  }
  return { ok: true, value: value as unknown as SingleBusinessActionCommand };
}

// ---------------------------------------------------------------------------
// Projection phase -> statut §5.1 (totale)
// ---------------------------------------------------------------------------

/** Totale et fermée — cette définition n'émet JAMAIS le legacy `expired`. */
export function singleBusinessActionStatusForState(
  state: SingleBusinessActionStateV1,
): JarvisRunStatus {
  switch (state.phase) {
    case 'preparing':
      return 'active';
    case 'awaiting_confirmation':
      // §7.1 : screen_ack obligatoire non encore présenté ⇒ le run attend l'ÉCRAN, pas l'humain.
      return state.proposal !== null
        && state.proposal.status === 'issued'
        && state.proposal.presentationRequirement === 'screen_ack'
        ? 'waiting_screen'
        : 'waiting_user';
    case 'committing':
    case 'awaiting_receipt':
      return 'waiting_external';
    case 'cancelling':
      return 'cancelling';
    case 'completed':
      return 'completed';
    case 'failed_terminal':
      return 'failed_terminal';
    case 'cancelled':
      return 'cancelled';
  }
}

// ---------------------------------------------------------------------------
// Réduction
// ---------------------------------------------------------------------------

type SbaRunEnvelope = Extract<
  JarvisRunEnvelope,
  { readonly kind: 'single_business_action' | 'customer_contact' }
>;

function freezeState(state: SingleBusinessActionStateV1): SingleBusinessActionStateV1 {
  return Object.freeze({
    ...state,
    action: Object.freeze({ ...state.action }),
    proposal:
      state.proposal === null
        ? null
        : Object.freeze({
            ...state.proposal,
            payloadRef:
              state.proposal.payloadRef === null ? null : Object.freeze({ ...state.proposal.payloadRef }),
          }),
    effect: state.effect === null ? null : Object.freeze({ ...state.effect }),
    cancellation: state.cancellation === null ? null : Object.freeze({ ...state.cancellation }),
  });
}

function pendingWakes(state: SingleBusinessActionStateV1): readonly JarvisWake[] {
  if (
    state.phase === 'awaiting_confirmation'
    && state.proposal !== null
    && (state.proposal.status === 'issued' || state.proposal.status === 'presented')
  ) {
    return Object.freeze([
      Object.freeze({
        wakeId: state.proposal.ttlWakeId,
        kind: 'confirmation_ttl' as const,
        dueAt: state.proposal.expiresAt,
      }),
    ]);
  }
  return Object.freeze([]);
}

function buildTransition(
  run: SbaRunEnvelope,
  context: JarvisReduceContext,
  nextState: SingleBusinessActionStateV1,
  event: { readonly type: SingleBusinessActionEventType; readonly data: Readonly<Record<string, unknown>> },
  workItemIntents: readonly JarvisWorkItemIntent[] = Object.freeze([]),
): JarvisReduceResult {
  const state = freezeState(nextState);
  if (!jsonUtf8Fits(state, SINGLE_BUSINESS_ACTION_LIMITS.maxStateBytes)) {
    return fail({ code: 'single_business_action_limit_exceeded', limit: 'max_state_bytes' });
  }
  const status = singleBusinessActionStatusForState(state);
  const terminal = JARVIS_RUN_TERMINAL_STATUSES.has(status);
  const wakes = pendingWakes(state);
  const draft: JarvisRunEventDraft = Object.freeze({
    type: event.type,
    version: 1,
    data: Object.freeze({ ...event.data }),
  });
  return {
    ok: true,
    value: Object.freeze({
      postimage: Object.freeze({
        kind: run.kind,
        runId: run.runId,
        companyId: run.companyId,
        createdBy: run.createdBy,
        definitionVersion: run.definitionVersion,
        status,
        revision: run.revision + 1,
        stateVersion: SINGLE_BUSINESS_ACTION_STATE_VERSION,
        state,
        nextWakeAt: deriveNextWakeAt(wakes),
        terminalAt: terminal ? context.occurredAt : null,
      }),
      event: draft,
      workItemIntents: Object.freeze([...workItemIntents]),
      wakes,
      releasedForegroundLease:
        terminal || JARVIS_RUN_LEASE_RELEASING_STATUSES.has(status),
    }),
  };
}

const EMPTY_INTENTS: readonly JarvisWorkItemIntent[] = Object.freeze([]);

/**
 * No-op idempotent STRICT (§5.1, patron `noop()` de customer-contact) : postimage INCHANGÉE —
 * même révision, aucun intent, bail conservé. Le scanner ne fait JAMAIS avancer le CAS d'un run ;
 * l'événement est rendu pour l'audit d'admission, sans append de révision.
 */
function noop(
  run: SbaRunEnvelope,
  state: SingleBusinessActionStateV1,
  event: {
    readonly type: SingleBusinessActionEventType;
    readonly data: Readonly<Record<string, unknown>>;
  },
): JarvisReduceResult {
  return {
    ok: true,
    value: Object.freeze({
      postimage: run,
      event: Object.freeze({ type: event.type, version: 1, data: Object.freeze({ ...event.data }) }),
      workItemIntents: EMPTY_INTENTS,
      wakes: pendingWakes(state),
      releasedForegroundLease: false,
    }),
  };
}

function invalidTransition(
  phase: SingleBusinessActionPhase,
  command: SingleBusinessActionCommand['type'],
): JarvisReduceResult {
  return fail({ code: 'single_business_action_invalid_transition', phase, command });
}

function confirmationConflict(
  reason: Extract<
    SingleBusinessActionError,
    { code: 'single_business_action_confirmation_conflict' }
  >['reason'],
): JarvisReduceResult {
  return fail({ code: 'single_business_action_confirmation_conflict', reason });
}

function effectConflict(
  reason: Extract<
    SingleBusinessActionError,
    { code: 'single_business_action_effect_conflict' }
  >['reason'],
): JarvisReduceResult {
  return fail({ code: 'single_business_action_effect_conflict', reason });
}

function isProposalPending(proposal: SingleBusinessActionProposalV1 | null): boolean {
  return proposal !== null && (proposal.status === 'issued' || proposal.status === 'presented');
}

function reduceSingleBusinessAction(
  run: SbaRunEnvelope,
  rawCommand: unknown,
  context: JarvisReduceContext,
): JarvisReduceResult {
  if (run.kind !== SINGLE_BUSINESS_ACTION_KIND) {
    return { ok: false, error: { code: 'invalid_command', reason: 'kind_mismatch' } };
  }
  if (run.definitionVersion !== SINGLE_BUSINESS_ACTION_DEFINITION_VERSION) {
    return { ok: false, error: { code: 'invalid_command', reason: 'definition_version_mismatch' } };
  }
  // §5.4 : le contexte d'admission est CANONIQUE — commandId UUID, occurredAt round-trip exact.
  // Même garde que customer-contact : un contexte difforme est refusé, jamais normalisé.
  if (!isCanonicalUuid(context.commandId) || !isCanonicalInstant(context.occurredAt)) {
    return { ok: false, error: { code: 'invalid_command', reason: 'invalid_value' } };
  }
  const parsedState = parseSingleBusinessActionState(run.state);
  if (!parsedState.ok) return fail(parsedState.error);
  const state = parsedState.value;
  const parsedCommand = parseSingleBusinessActionCommand(rawCommand);
  if (!parsedCommand.ok) return fail(parsedCommand.error);
  const command = parsedCommand.value;

  // Terminal figé : `terminalAt` posé ⇒ plus AUCUNE transition (§5.1). Un signal tardif est
  // acquitté comme no-op au niveau gateway/receipt — jamais réadmis dans le domaine.
  if (JARVIS_RUN_TERMINAL_STATUSES.has(run.status)) {
    return { ok: false, error: { code: 'run_terminal', status: run.status } };
  }
  // CAS : même contrat que l'agrégat AgentMission — conflit typé sans postimage.
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
  // Budget de pas §4.3 : borné dur ; restent possibles cancel_run (fermer le run) et
  // record_effect_receipt (§5.3 : le reçu d'un effet possiblement parti doit TOUJOURS pouvoir
  // être observé — sinon un run épuisé en awaiting_receipt ne se fermerait jamais honnêtement).
  if (
    state.stepCount >= SINGLE_BUSINESS_ACTION_LIMITS.maxSteps
    && command.type !== 'cancel_run'
    && command.type !== 'record_effect_receipt'
  ) {
    return fail({ code: 'single_business_action_limit_exceeded', limit: 'max_steps' });
  }

  switch (command.type) {
    case 'stage_proposal': {
      if (state.phase !== 'preparing') return invalidTransition(state.phase, command.type);
      if (state.registeredWakeCount >= SINGLE_BUSINESS_ACTION_LIMITS.maxWakes) {
        return fail({ code: 'single_business_action_limit_exceeded', limit: 'max_wakes' });
      }
      const expiresAt = addMillis(context.occurredAt, command.confirmationTtlMs);
      const proposal: SingleBusinessActionProposalV1 = {
        proposalId: command.proposalId,
        proposalCommandId: context.commandId,
        canonicalInputDigest: command.canonicalInputDigest,
        proposalHash: command.proposalHash,
        presentationRequirement: command.presentationRequirement,
        targetDigest: command.targetDigest,
        payloadRef: command.payloadRef,
        confirmationTtlMs: command.confirmationTtlMs,
        executeWindowMs: command.executeWindowMs,
        status: 'issued',
        issuedAt: context.occurredAt,
        presentedAt: null,
        presentationAck: null,
        expiresAt,
        ttlWakeId: confirmationTtlWakeId(command.proposalId),
        consumedByCommandId: null,
        invalidationReason: null,
      };
      return buildTransition(
        run,
        context,
        {
          ...state,
          phase: 'awaiting_confirmation',
          stepCount: state.stepCount + 1,
          registeredWakeCount: state.registeredWakeCount + 1,
          proposal,
        },
        {
          type: 'sba_proposal_staged',
          data: {
            proposalId: proposal.proposalId,
            actionId: state.action.actionId,
            actionVersion: state.action.actionVersion,
            canonicalInputDigest: proposal.canonicalInputDigest,
            proposalHash: proposal.proposalHash,
            presentationRequirement: proposal.presentationRequirement,
            expiresAt,
            ttlWakeId: proposal.ttlWakeId,
          },
        },
      );
    }

    case 'record_presentation_ack': {
      if (state.phase !== 'awaiting_confirmation' || state.proposal === null) {
        return invalidTransition(state.phase, command.type);
      }
      const proposal = state.proposal;
      if (command.proposalId !== proposal.proposalId) return confirmationConflict('proposal_unknown');
      if (proposal.status === 'presented') return confirmationConflict('already_presented');
      if (proposal.status !== 'issued') return confirmationConflict('not_pending');
      // §7.1 : screen_ack obligatoire ⇒ une restitution vocale, même complète, ne suffit JAMAIS.
      if (proposal.presentationRequirement === 'screen_ack' && command.ack !== 'screen_ack') {
        return confirmationConflict('ack_channel_insufficient');
      }
      // ACK tardif : n'atteint jamais `presented` — le wake TTL expirera la proposition.
      if (Date.parse(context.occurredAt) >= Date.parse(proposal.expiresAt)) {
        return confirmationConflict('expired');
      }
      return buildTransition(
        run,
        context,
        {
          ...state,
          stepCount: state.stepCount + 1,
          proposal: {
            ...proposal,
            status: 'presented',
            presentedAt: context.occurredAt,
            presentationAck: command.ack,
          },
        },
        {
          type: 'sba_presentation_acknowledged',
          data: { proposalId: proposal.proposalId, ack: command.ack, presentedAt: context.occurredAt },
        },
      );
    }

    case 'confirm': {
      // One-shot §7.1 : une proposition consommée ne se reconsomme JAMAIS. Même commandId ⇒ le
      // reçu d'admission rejoue ; le domaine le signale distinctement pour ne jamais ré-émettre.
      if (state.proposal !== null && state.proposal.status === 'consumed') {
        return confirmationConflict(
          state.proposal.consumedByCommandId === context.commandId
            ? 'already_consumed_same_command'
            : 'already_consumed',
        );
      }
      if (state.phase !== 'awaiting_confirmation' || state.proposal === null) {
        return invalidTransition(state.phase, command.type);
      }
      const proposal = state.proposal;
      if (command.proposalId !== proposal.proposalId) return confirmationConflict('proposal_unknown');
      if (command.proposalHash !== proposal.proposalHash) {
        return confirmationConflict('proposal_hash_mismatch');
      }
      if (proposal.status !== 'presented') return confirmationConflict('not_presented');
      if (Date.parse(context.occurredAt) >= Date.parse(proposal.expiresAt)) {
        return confirmationConflict('expired');
      }
      // ≤ 1 effet mutant par run : l'unique effectId est le PREMIER préalloué serveur (§5.4).
      // (state.effect ⇒ proposition consommée, déjà refusé plus haut — invariant de parse.)
      const effectId = context.allocatedEffectIds[0];
      if (effectId === undefined) return effectConflict('effect_id_not_allocated');
      const executeBy = addMillis(context.occurredAt, proposal.executeWindowMs);
      const effect: SingleBusinessActionEffectV1 = {
        effectId,
        proposalId: proposal.proposalId,
        authorizationReceiptId: context.commandId,
        actingPrincipalId: context.actingPrincipalId,
        executeBy,
        submittedJobRef: null,
        outcome: null,
        resultDigest: null,
      };
      const intent: JarvisWorkItemIntent = Object.freeze({
        effectId,
        actionId: state.action.actionId,
        actionVersion: state.action.actionVersion,
        authorizationSource: Object.freeze({
          source: 'confirmation' as const,
          receiptId: context.commandId,
        }),
        actingPrincipalId: context.actingPrincipalId,
        targetDigest: proposal.targetDigest,
        payloadRef: proposal.payloadRef,
        executeBy,
      });
      return buildTransition(
        run,
        context,
        {
          ...state,
          phase: 'committing',
          stepCount: state.stepCount + 1,
          proposal: { ...proposal, status: 'consumed', consumedByCommandId: context.commandId },
          effect,
        },
        {
          type: 'sba_confirmed',
          data: {
            proposalId: proposal.proposalId,
            proposalHash: proposal.proposalHash,
            effectId,
            authorizationReceiptId: context.commandId,
            executeBy,
          },
        },
        [intent],
      );
    }

    case 'reject': {
      if (state.phase !== 'awaiting_confirmation' || state.proposal === null) {
        return invalidTransition(state.phase, command.type);
      }
      if (command.proposalId !== state.proposal.proposalId) {
        return confirmationConflict('proposal_unknown');
      }
      if (!isProposalPending(state.proposal)) return confirmationConflict('not_pending');
      return buildTransition(
        run,
        context,
        {
          ...state,
          phase: 'preparing',
          stepCount: state.stepCount + 1,
          proposal: { ...state.proposal, status: 'rejected' },
        },
        { type: 'sba_proposal_rejected', data: { proposalId: state.proposal.proposalId } },
      );
    }

    case 'invalidate_proposal': {
      if (state.proposal === null || command.proposalId !== state.proposal.proposalId) {
        return confirmationConflict('proposal_unknown');
      }
      // JAMAIS rétroactif (§7.1) : une proposition consommée reste consommée — l'effet autorisé
      // suit sa propre voie (cancel_run -> cancelling qui observe), pas une invalidation.
      if (state.proposal.status === 'consumed') return confirmationConflict('already_consumed');
      if (!isProposalPending(state.proposal)) return confirmationConflict('not_pending');
      return buildTransition(
        run,
        context,
        {
          ...state,
          phase: 'preparing',
          stepCount: state.stepCount + 1,
          proposal: { ...state.proposal, status: 'invalidated', invalidationReason: command.reason },
        },
        {
          type: 'sba_proposal_invalidated',
          data: { proposalId: state.proposal.proposalId, reason: command.reason },
        },
      );
    }

    case 'record_effect_receipt': {
      if (state.effect === null) return invalidTransition(state.phase, command.type);
      const effect = state.effect;
      // Idempotence liée à l'effectId DU STATE : tout autre effectId est refusé sans mutation.
      if (command.effectId !== effect.effectId) return effectConflict('unknown_effect_id');
      const receipt = command.receipt;
      const cancelling = state.phase === 'cancelling';
      if (state.phase !== 'committing' && state.phase !== 'awaiting_receipt' && !cancelling) {
        return invalidTransition(state.phase, command.type);
      }
      if (receipt.kind === 'submitted') {
        if (effect.submittedJobRef !== null) {
          if (effect.submittedJobRef !== receipt.jobRef) return effectConflict('job_ref_mismatch');
          // Même reçu déjà appliqué ⇒ no-op EXPLICITE audité (§5.3), jamais silencieux.
          return buildTransition(
            run,
            context,
            { ...state },
            {
              type: 'sba_effect_receipt_deduplicated',
              data: { effectId: effect.effectId, kind: 'submitted' },
            },
          );
        }
        return buildTransition(
          run,
          context,
          {
            ...state,
            phase: cancelling ? 'cancelling' : 'awaiting_receipt',
            stepCount: state.stepCount + 1,
            effect: { ...effect, submittedJobRef: receipt.jobRef },
          },
          {
            type: 'sba_effect_submitted',
            data: { effectId: effect.effectId, jobRef: receipt.jobRef },
          },
        );
      }
      if (receipt.kind === 'succeeded') {
        // Un cancel tardif n'a JAMAIS gagné contre un effet parti : le run se termine `completed`
        // avec le reçu conservé — il ne masque pas un succès externe (§5.3).
        return buildTransition(
          run,
          context,
          {
            ...state,
            phase: 'completed',
            stepCount: state.stepCount + 1,
            effect: { ...effect, outcome: 'succeeded', resultDigest: receipt.resultDigest },
          },
          {
            type: 'sba_effect_succeeded',
            data: {
              effectId: effect.effectId,
              resultDigest: receipt.resultDigest,
              cancellationRequested: state.cancellation !== null,
            },
          },
        );
      }
      // failed_terminal : si une annulation observait l'effet, elle gagne honnêtement (`cancelled`,
      // rien n'est parti) ; sinon le run échoue terminal.
      return buildTransition(
        run,
        context,
        {
          ...state,
          phase: cancelling ? 'cancelled' : 'failed_terminal',
          stepCount: state.stepCount + 1,
          effect: { ...effect, outcome: 'failed', resultDigest: receipt.failureDigest },
        },
        {
          type: 'sba_effect_failed',
          data: {
            effectId: effect.effectId,
            failureDigest: receipt.failureDigest,
            cancellationRequested: state.cancellation !== null,
          },
        },
      );
    }

    case 'cancel_run': {
      if (state.phase === 'cancelling') {
        return fail({ code: 'single_business_action_cancel_conflict', reason: 'already_cancelling' });
      }
      const cancellation: SingleBusinessActionCancellationV1 = {
        reason: command.reason,
        requestedAt: context.occurredAt,
      };
      // AVANT autorisation (aucun effet émis) : annulation franche, proposition pendante invalidée.
      if (state.phase === 'preparing' || state.phase === 'awaiting_confirmation') {
        return buildTransition(
          run,
          context,
          {
            ...state,
            phase: 'cancelled',
            stepCount: state.stepCount + 1,
            proposal: isProposalPending(state.proposal)
              ? {
                  ...(state.proposal as SingleBusinessActionProposalV1),
                  status: 'invalidated',
                  invalidationReason: 'authorization_revoked',
                }
              : state.proposal,
            cancellation,
          },
          {
            type: 'sba_run_cancelled',
            data: { reason: command.reason, phase: state.phase },
          },
        );
      }
      // APRÈS autorisation : `cancelling` OBSERVE le reçu — jamais prétendre annulé (§5.3).
      return buildTransition(
        run,
        context,
        {
          ...state,
          phase: 'cancelling',
          stepCount: state.stepCount + 1,
          cancellation,
        },
        { type: 'sba_run_cancelling', data: { reason: command.reason, phase: state.phase } },
      );
    }

    case 'wake_run': {
      if (
        state.phase === 'awaiting_confirmation'
        && state.proposal !== null
        && isProposalPending(state.proposal)
        && command.wakeId === state.proposal.ttlWakeId
        // Garde d'échéance (§7.1, alignée customer-contact) : le wake n'expire QUE si l'instant
        // d'admission a atteint expiresAt — un réveil prématuré est ignoré, jamais expirateur.
        && Date.parse(context.occurredAt) >= Date.parse(state.proposal.expiresAt)
      ) {
        return buildTransition(
          run,
          context,
          {
            ...state,
            phase: 'preparing',
            stepCount: state.stepCount + 1,
            proposal: { ...state.proposal, status: 'expired' },
          },
          {
            type: 'sba_proposal_expired',
            data: { proposalId: state.proposal.proposalId, wakeId: command.wakeId },
          },
        );
      }
      // wakeId inconnu, périmé ou prématuré ⇒ no-op idempotent STRICT (§5.1) : audité, postimage
      // INCHANGÉE (même révision) — le scanner ne fait jamais échouer une commande interactive
      // concurrente en avançant le CAS du run.
      return noop(run, state, { type: 'sba_wake_ignored', data: { wakeId: command.wakeId } });
    }
  }
}

/** SBA est toujours créé avec un state initial qui pince déjà son action. */
function singleBusinessActionReference(
  run: SbaRunEnvelope,
  _command: unknown,
): JarvisDefinitionActionReference | null {
  const parsed = parseSingleBusinessActionState(run.state);
  return parsed.ok ? Object.freeze({ ...parsed.value.action }) : null;
}

// ---------------------------------------------------------------------------
// Module de définition + enregistrement (registre gelé du reducer racine)
// ---------------------------------------------------------------------------

export const SINGLE_BUSINESS_ACTION_V1: JarvisDefinitionModule = Object.freeze({
  kind: SINGLE_BUSINESS_ACTION_KIND,
  definitionVersion: SINGLE_BUSINESS_ACTION_DEFINITION_VERSION,
  stateVersion: SINGLE_BUSINESS_ACTION_STATE_VERSION,
  limits: SINGLE_BUSINESS_ACTION_LIMITS,
  actionReference: singleBusinessActionReference,
  reduce: reduceSingleBusinessAction,
});

registerJarvisDefinition(SINGLE_BUSINESS_ACTION_V1);

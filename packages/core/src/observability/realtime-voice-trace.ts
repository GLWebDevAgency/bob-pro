/**
 * Contrat pur du journal Bob Live Realtime V2.
 *
 * Ce module ne chiffre et ne persiste rien. Il ferme la forme métier de l'observation avant que
 * l'adapter API applique le chiffrement et la RLS. Aucun objet libre n'est admis : ajouter un champ
 * exige de modifier cette source, ses tests et le CHECK SQL généré dans le même train.
 */

import { isMissionKindId, type MissionKindId } from '../domain/agent/mission-kind';

export const REALTIME_VOICE_TRACE_RETENTION_DAYS = 30;
export const REALTIME_VOICE_TRACE_MAX_TRANSCRIPT_CHARS = 4_000;
export const REALTIME_VOICE_TRACE_MAX_TRANSCRIPT_BYTES = 16_000;
export const REALTIME_VOICE_TRACE_MAX_REPLY_CHARS = 2_400;
export const REALTIME_VOICE_TRACE_MAX_REPLY_BYTES = 9_600;
export const REALTIME_VOICE_TRACE_MAX_ORDINAL = 2_147_483_647;

export const REALTIME_VOICE_TRACE_PROVIDERS = ['openai'] as const;
export const REALTIME_VOICE_TRACE_TRANSPORTS = ['webrtc'] as const;
export const REALTIME_VOICE_TRACE_SPEECH_DELIVERIES = [
  'audited-signed-url-v1',
  'openai-native-webrtc-v1',
] as const;

export const REALTIME_VOICE_TRACE_EVENT_KINDS = [
  'session_bootstrap_failed',
  'session_ready',
  'context_applied',
  'turn_transcript_final',
  'turn_semantic_plan',
  'turn_agent_result',
  'turn_speech_ready',
  'turn_speech_delivered',
  'turn_interrupted',
  'provider_failed',
  'security_rejected',
  'session_closed',
] as const;

export const REALTIME_VOICE_TRACE_STAGES = [
  'admission',
  'provider_call',
  'sideband_bootstrap',
  'sideband_owner',
  'context',
  'transcription',
  'planner',
  'agent',
  'speech_prepare',
  'speech_dispatch',
  'speech_delivery',
  'security',
  'session',
] as const;

export const REALTIME_VOICE_TRACE_OUTCOMES = [
  'ready',
  'failed',
  'aborted',
  'rejected',
  'unavailable',
  'already_ready',
  'delivered',
  'cancelled',
  'closed',
] as const;

export const REALTIME_VOICE_TRACE_FAILURE_CLASSES = [
  'admission_rejected',
  'bootstrap_aborted',
  'provider_create_failed',
  'provider_registration_missing',
  'sideband_timeout',
  'sideband_send_failed',
  'sideband_policy_drift',
  'sideband_provider_error',
  'sideband_network_error',
  'sideband_closed_before_ready',
  'sideband_activation_failed',
  'sideband_owner_busy',
  'sideband_owner_rejected',
  'sideband_owner_unavailable',
  'sideband_context_lost',
  'sideband_context_stale',
  'sideband_context_rejected',
  'sideband_context_unavailable',
  'context_fence_rejected',
  'planner_unavailable',
  'planner_rejected',
  'transcription_failed',
  'agent_failed',
  'speech_publish_failed',
  'speech_delivery_failed',
  'control_seal_failed',
  'speech_cancel_failed',
  'provider_event_error',
  'hangup_failed',
  'unexpected_tool_call',
  'session_policy_drift',
  'malformed_event',
  'unauthorized_response',
  'dangerous_conversation_item',
  'turn_budget_exceeded',
  'owner_lease_lost',
  'unknown',
] as const;

export const REALTIME_VOICE_TRACE_INTERRUPTION_REASONS = [
  'barge_in',
  'user_cancel',
  'context_changed',
  'superseded',
  'session_end',
  'playback_error',
] as const;

export const REALTIME_VOICE_TRACE_PLANNER_DISPOSITIONS = [
  'mission_frame',
  'global_plan',
  'out_of_scope',
  'rejected',
  'unavailable',
] as const;

export const REALTIME_VOICE_TRACE_PLANNER_AUTHORITIES = ['mission', 'global', 'none'] as const;

export const REALTIME_VOICE_TRACE_RUN_KINDS = ['answer', 'proposed', 'done', 'failed'] as const;

export const REALTIME_VOICE_TRACE_CONTROL_KINDS = [
  'none',
  'navigate',
  'proposal',
  'navigate_proposal',
] as const;

export const REALTIME_VOICE_TRACE_SESSION_CLOSE_REASONS = [
  'user',
  'kill_switch',
  'superseded',
  'max_duration',
  'shutdown',
] as const;

export type RealtimeVoiceTraceEventKind = (typeof REALTIME_VOICE_TRACE_EVENT_KINDS)[number];
export type RealtimeVoiceTraceProvider = (typeof REALTIME_VOICE_TRACE_PROVIDERS)[number];
export type RealtimeVoiceTraceTransport = (typeof REALTIME_VOICE_TRACE_TRANSPORTS)[number];
export type RealtimeVoiceTraceSpeechDelivery =
  (typeof REALTIME_VOICE_TRACE_SPEECH_DELIVERIES)[number];
export type RealtimeVoiceTraceStage = (typeof REALTIME_VOICE_TRACE_STAGES)[number];
export type RealtimeVoiceTraceOutcome = (typeof REALTIME_VOICE_TRACE_OUTCOMES)[number];
export type RealtimeVoiceTraceFailureClass = (typeof REALTIME_VOICE_TRACE_FAILURE_CLASSES)[number];
export type RealtimeVoiceTraceInterruptionReason =
  (typeof REALTIME_VOICE_TRACE_INTERRUPTION_REASONS)[number];
export type RealtimeVoiceTracePlannerDisposition =
  (typeof REALTIME_VOICE_TRACE_PLANNER_DISPOSITIONS)[number];
export type RealtimeVoiceTracePlannerAuthority =
  (typeof REALTIME_VOICE_TRACE_PLANNER_AUTHORITIES)[number];
export type RealtimeVoiceTraceRunKind = (typeof REALTIME_VOICE_TRACE_RUN_KINDS)[number];
export type RealtimeVoiceTraceControlKind = (typeof REALTIME_VOICE_TRACE_CONTROL_KINDS)[number];
export type RealtimeVoiceTraceSessionCloseReason =
  (typeof REALTIME_VOICE_TRACE_SESSION_CLOSE_REASONS)[number];

export interface RealtimeVoiceTraceEvent {
  readonly version: 1;
  readonly eventKind: RealtimeVoiceTraceEventKind;
  readonly companyId: string;
  readonly userId: string;
  readonly traceAttemptId: string;
  readonly sessionHandle?: string;
  readonly ownerEpoch: number;
  readonly eventOrdinal: number;
  readonly turnId?: string;
  readonly occurredAt: string;
  readonly durationMs?: number;
  readonly contextRevision?: number;
  readonly contextDigest?: string;
  readonly provider?: RealtimeVoiceTraceProvider;
  readonly transport?: RealtimeVoiceTraceTransport;
  readonly speechDelivery?: RealtimeVoiceTraceSpeechDelivery;
  readonly realtimeModel?: string;
  readonly plannerDisposition?: RealtimeVoiceTracePlannerDisposition;
  readonly plannerAuthority?: RealtimeVoiceTracePlannerAuthority;
  readonly plannerModel?: string;
  readonly plannerStepIndex?: number;
  readonly plannerStepCount?: number;
  /** Identifiant BobIntent validé par l'adapter @bob/ai ; jamais la référence métier parlée. */
  readonly plannerIntent?: string;
  readonly missionKind?: MissionKindId;
  readonly runKind?: RealtimeVoiceTraceRunKind;
  readonly controlKind?: RealtimeVoiceTraceControlKind;
  readonly stage?: RealtimeVoiceTraceStage;
  readonly outcome?: RealtimeVoiceTraceOutcome;
  readonly failureClass?: RealtimeVoiceTraceFailureClass;
  readonly interruptionReason?: RealtimeVoiceTraceInterruptionReason;
  readonly sessionCloseReason?: RealtimeVoiceTraceSessionCloseReason;
  readonly transcript?: string;
  readonly canonicalReply?: string;
}

export type RealtimeVoiceTraceValidation =
  | { readonly ok: true; readonly value: RealtimeVoiceTraceEvent }
  | { readonly ok: false; readonly issues: readonly string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const CLOSED_IDENTIFIER = /^[a-z][a-z0-9_.-]{0,99}$/u;
const PLANNER_INTENT = /^[a-z][a-z0-9_]{0,63}$/u;

const valueSet = <T extends readonly string[]>(values: T): ReadonlySet<string> =>
  new Set<string>(values);

const EVENT_KINDS = valueSet(REALTIME_VOICE_TRACE_EVENT_KINDS);
const PROVIDERS = valueSet(REALTIME_VOICE_TRACE_PROVIDERS);
const TRANSPORTS = valueSet(REALTIME_VOICE_TRACE_TRANSPORTS);
const SPEECH_DELIVERIES = valueSet(REALTIME_VOICE_TRACE_SPEECH_DELIVERIES);
const STAGES = valueSet(REALTIME_VOICE_TRACE_STAGES);
const OUTCOMES = valueSet(REALTIME_VOICE_TRACE_OUTCOMES);
const FAILURE_CLASSES = valueSet(REALTIME_VOICE_TRACE_FAILURE_CLASSES);
const INTERRUPTION_REASONS = valueSet(REALTIME_VOICE_TRACE_INTERRUPTION_REASONS);
const PLANNER_DISPOSITIONS = valueSet(REALTIME_VOICE_TRACE_PLANNER_DISPOSITIONS);
const PLANNER_AUTHORITIES = valueSet(REALTIME_VOICE_TRACE_PLANNER_AUTHORITIES);
const RUN_KINDS = valueSet(REALTIME_VOICE_TRACE_RUN_KINDS);
const CONTROL_KINDS = valueSet(REALTIME_VOICE_TRACE_CONTROL_KINDS);
const SESSION_CLOSE_REASONS = valueSet(REALTIME_VOICE_TRACE_SESSION_CLOSE_REASONS);

function isCanonicalIsoTimestamp(value: string): boolean {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function boundedText(value: string | undefined, maxChars: number, maxBytes: number): boolean {
  return (
    value === undefined ||
    (value.length > 0 &&
      value.length <= maxChars &&
      utf8ByteLength(value) <= maxBytes &&
      // Le sideband a déjà transformé les contrôles ; leur retour indique une dérive.
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f]/u.test(value))
  );
}

/** Compteur UTF-8 pur et déterministe, sans Buffer/DOM afin de garder @bob/core portable. */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0) as number;
    if (point <= 0x7f) bytes += 1;
    else if (point <= 0x7ff) bytes += 2;
    else if (point <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function hasSession(event: RealtimeVoiceTraceEvent): boolean {
  return typeof event.sessionHandle === 'string' && UUID.test(event.sessionHandle);
}

function hasTurn(event: RealtimeVoiceTraceEvent): boolean {
  return typeof event.turnId === 'string' && UUID.test(event.turnId);
}

function pushIf(issues: string[], invalid: boolean, issue: string): void {
  if (invalid) issues.push(issue);
}

/** Validation exhaustive de la frontière avant chiffrement/persistance. */
export function validateRealtimeVoiceTraceEvent(
  event: RealtimeVoiceTraceEvent,
): RealtimeVoiceTraceValidation {
  const issues: string[] = [];
  pushIf(issues, event.version !== 1, 'version');
  pushIf(issues, !EVENT_KINDS.has(event.eventKind), 'eventKind');
  pushIf(issues, !COMPANY_ID.test(event.companyId), 'companyId');
  pushIf(issues, !UUID.test(event.userId), 'userId');
  pushIf(issues, !UUID.test(event.traceAttemptId), 'traceAttemptId');
  pushIf(
    issues,
    !Number.isSafeInteger(event.ownerEpoch) ||
      event.ownerEpoch < 0 ||
      event.ownerEpoch > REALTIME_VOICE_TRACE_MAX_ORDINAL,
    'ownerEpoch',
  );
  pushIf(
    issues,
    !Number.isSafeInteger(event.eventOrdinal) ||
      event.eventOrdinal < 1 ||
      event.eventOrdinal > REALTIME_VOICE_TRACE_MAX_ORDINAL,
    'eventOrdinal',
  );
  pushIf(issues, !isCanonicalIsoTimestamp(event.occurredAt), 'occurredAt');
  pushIf(
    issues,
    event.durationMs !== undefined &&
      (!Number.isSafeInteger(event.durationMs) ||
        event.durationMs < 0 ||
        event.durationMs > 86_400_000),
    'durationMs',
  );
  pushIf(
    issues,
    event.contextRevision !== undefined &&
      (!Number.isSafeInteger(event.contextRevision) ||
        event.contextRevision < 1 ||
        event.contextRevision > REALTIME_VOICE_TRACE_MAX_ORDINAL),
    'contextRevision',
  );
  pushIf(
    issues,
    event.contextDigest !== undefined && !SHA256_HEX.test(event.contextDigest),
    'contextDigest',
  );
  pushIf(
    issues,
    (event.contextRevision === undefined) !== (event.contextDigest === undefined),
    'contextFence',
  );
  pushIf(issues, event.provider !== undefined && !PROVIDERS.has(event.provider), 'provider');
  pushIf(issues, event.transport !== undefined && !TRANSPORTS.has(event.transport), 'transport');
  pushIf(
    issues,
    event.speechDelivery !== undefined && !SPEECH_DELIVERIES.has(event.speechDelivery),
    'speechDelivery',
  );
  pushIf(
    issues,
    event.realtimeModel !== undefined && !CLOSED_IDENTIFIER.test(event.realtimeModel),
    'realtimeModel',
  );
  pushIf(
    issues,
    event.plannerDisposition !== undefined && !PLANNER_DISPOSITIONS.has(event.plannerDisposition),
    'plannerDisposition',
  );
  pushIf(
    issues,
    event.plannerAuthority !== undefined && !PLANNER_AUTHORITIES.has(event.plannerAuthority),
    'plannerAuthority',
  );
  pushIf(
    issues,
    event.plannerModel !== undefined &&
      (!CLOSED_IDENTIFIER.test(event.plannerModel) || event.plannerModel.length > 100),
    'plannerModel',
  );
  pushIf(
    issues,
    event.plannerStepIndex !== undefined &&
      (!Number.isSafeInteger(event.plannerStepIndex) ||
        event.plannerStepIndex < 0 ||
        event.plannerStepIndex > 7),
    'plannerStepIndex',
  );
  pushIf(
    issues,
    event.plannerStepCount !== undefined &&
      (!Number.isSafeInteger(event.plannerStepCount) ||
        event.plannerStepCount < 1 ||
        event.plannerStepCount > 8),
    'plannerStepCount',
  );
  pushIf(
    issues,
    event.plannerStepIndex !== undefined &&
      (event.plannerStepCount === undefined || event.plannerStepIndex >= event.plannerStepCount),
    'plannerStepRange',
  );
  pushIf(
    issues,
    event.plannerIntent !== undefined && !PLANNER_INTENT.test(event.plannerIntent),
    'plannerIntent',
  );
  pushIf(
    issues,
    event.missionKind !== undefined && !isMissionKindId(event.missionKind),
    'missionKind',
  );
  pushIf(issues, event.runKind !== undefined && !RUN_KINDS.has(event.runKind), 'runKind');
  pushIf(
    issues,
    event.controlKind !== undefined && !CONTROL_KINDS.has(event.controlKind),
    'controlKind',
  );
  pushIf(issues, event.stage !== undefined && !STAGES.has(event.stage), 'stage');
  pushIf(issues, event.outcome !== undefined && !OUTCOMES.has(event.outcome), 'outcome');
  pushIf(
    issues,
    event.failureClass !== undefined && !FAILURE_CLASSES.has(event.failureClass),
    'failureClass',
  );
  pushIf(
    issues,
    event.interruptionReason !== undefined && !INTERRUPTION_REASONS.has(event.interruptionReason),
    'interruptionReason',
  );
  pushIf(
    issues,
    event.sessionCloseReason !== undefined && !SESSION_CLOSE_REASONS.has(event.sessionCloseReason),
    'sessionCloseReason',
  );
  pushIf(
    issues,
    !boundedText(
      event.transcript,
      REALTIME_VOICE_TRACE_MAX_TRANSCRIPT_CHARS,
      REALTIME_VOICE_TRACE_MAX_TRANSCRIPT_BYTES,
    ),
    'transcript',
  );
  pushIf(
    issues,
    !boundedText(
      event.canonicalReply,
      REALTIME_VOICE_TRACE_MAX_REPLY_CHARS,
      REALTIME_VOICE_TRACE_MAX_REPLY_BYTES,
    ),
    'canonicalReply',
  );

  const bootstrapOnly = event.eventKind === 'session_bootstrap_failed';
  pushIf(issues, !bootstrapOnly && !hasSession(event), 'sessionHandleRequired');
  pushIf(issues, event.sessionHandle !== undefined && !hasSession(event), 'sessionHandle');
  pushIf(
    issues,
    !bootstrapOnly &&
      event.eventKind !== 'provider_failed' &&
      event.eventKind !== 'security_rejected' &&
      event.ownerEpoch < 1,
    'ownerEpochRequired',
  );
  pushIf(
    issues,
    event.ownerEpoch === 0 &&
      event.eventKind !== 'session_bootstrap_failed' &&
      event.eventKind !== 'provider_failed' &&
      event.eventKind !== 'security_rejected',
    'ownerEpochZeroForbidden',
  );

  const turnRequired = new Set<RealtimeVoiceTraceEventKind>([
    'turn_transcript_final',
    'turn_semantic_plan',
    'turn_agent_result',
    'turn_speech_ready',
    'turn_speech_delivered',
    'turn_interrupted',
  ]);
  pushIf(issues, turnRequired.has(event.eventKind) && !hasTurn(event), 'turnIdRequired');
  pushIf(issues, event.turnId !== undefined && !hasTurn(event), 'turnId');

  pushIf(
    issues,
    (event.eventKind === 'turn_transcript_final') !== (event.transcript !== undefined),
    'transcriptEventMismatch',
  );
  pushIf(
    issues,
    (event.eventKind === 'turn_agent_result') !== (event.canonicalReply !== undefined),
    'canonicalReplyEventMismatch',
  );
  pushIf(
    issues,
    event.eventKind === 'turn_semantic_plan' &&
      (event.plannerDisposition === undefined ||
        event.plannerAuthority === undefined ||
        (event.plannerDisposition !== 'rejected' &&
          event.plannerDisposition !== 'unavailable' &&
          event.plannerModel === undefined)),
    'semanticPlanShape',
  );
  pushIf(
    issues,
    event.eventKind !== 'turn_semantic_plan' &&
      (event.plannerDisposition !== undefined ||
        event.plannerAuthority !== undefined ||
        event.plannerModel !== undefined ||
        event.plannerStepIndex !== undefined ||
        event.plannerStepCount !== undefined ||
        event.plannerIntent !== undefined),
    'semanticPlanFieldMismatch',
  );
  pushIf(
    issues,
    event.eventKind !== 'turn_semantic_plan' && event.missionKind !== undefined,
    'missionKindMismatch',
  );
  pushIf(
    issues,
    event.eventKind === 'session_ready' &&
      (event.provider !== 'openai' ||
        event.transport !== 'webrtc' ||
        event.speechDelivery === undefined ||
        event.realtimeModel === undefined ||
        event.outcome !== 'ready'),
    'sessionReadyShape',
  );
  pushIf(
    issues,
    event.eventKind !== 'session_ready' && event.realtimeModel !== undefined,
    'realtimeModelMismatch',
  );
  pushIf(
    issues,
    event.eventKind === 'context_applied' &&
      (event.contextRevision === undefined ||
        event.contextDigest === undefined ||
        event.outcome !== 'ready'),
    'contextAppliedShape',
  );
  pushIf(
    issues,
    event.eventKind === 'turn_semantic_plan' && event.durationMs === undefined,
    'semanticPlanDurationRequired',
  );
  pushIf(
    issues,
    event.eventKind === 'turn_agent_result' &&
      (event.runKind === undefined ||
        event.controlKind === undefined ||
        (event.outcome !== 'ready' && event.outcome !== 'failed')),
    'agentResultShape',
  );
  pushIf(
    issues,
    event.eventKind !== 'turn_agent_result' &&
      (event.runKind !== undefined || event.controlKind !== undefined),
    'agentResultFieldMismatch',
  );
  pushIf(
    issues,
    (event.eventKind === 'turn_speech_ready' || event.eventKind === 'turn_speech_delivered') &&
      event.speechDelivery === undefined,
    'speechDeliveryRequired',
  );
  pushIf(
    issues,
    event.eventKind === 'turn_speech_ready' &&
      event.outcome !== 'ready' &&
      event.outcome !== 'already_ready',
    'speechReadyOutcome',
  );
  pushIf(
    issues,
    event.eventKind === 'turn_speech_delivered' && event.outcome !== 'delivered',
    'speechDeliveredOutcome',
  );
  pushIf(
    issues,
    event.eventKind === 'turn_interrupted' && event.interruptionReason === undefined,
    'interruptionReasonRequired',
  );
  pushIf(
    issues,
    event.eventKind !== 'turn_interrupted' && event.interruptionReason !== undefined,
    'interruptionReasonMismatch',
  );
  pushIf(
    issues,
    (event.eventKind === 'session_closed') !== (event.sessionCloseReason !== undefined) ||
      (event.eventKind === 'session_closed' && event.outcome !== 'closed'),
    'sessionCloseReasonMismatch',
  );
  pushIf(
    issues,
    (event.eventKind === 'session_bootstrap_failed' ||
      event.eventKind === 'provider_failed' ||
      event.eventKind === 'security_rejected') &&
      (event.stage === undefined || event.failureClass === undefined),
    'failureShape',
  );

  return issues.length === 0
    ? { ok: true, value: Object.freeze({ ...event }) }
    : { ok: false, issues: Object.freeze([...new Set(issues)]) };
}

/** Matériau canonique pour le HMAC d'idempotence ; ordre fixé, aucune sérialisation d'objet libre. */
export function realtimeVoiceTraceDigestMaterial(event: RealtimeVoiceTraceEvent): string {
  const validated = validateRealtimeVoiceTraceEvent(event);
  if (!validated.ok) {
    throw new Error(`Événement Realtime Voice Trace invalide : ${validated.issues.join(', ')}.`);
  }
  const value = validated.value;
  return JSON.stringify([
    value.version,
    value.eventKind,
    value.companyId,
    value.userId,
    value.traceAttemptId,
    value.sessionHandle ?? null,
    value.ownerEpoch,
    value.eventOrdinal,
    value.turnId ?? null,
    value.occurredAt,
    value.durationMs ?? null,
    value.contextRevision ?? null,
    value.contextDigest ?? null,
    value.provider ?? null,
    value.transport ?? null,
    value.speechDelivery ?? null,
    value.realtimeModel ?? null,
    value.plannerDisposition ?? null,
    value.plannerAuthority ?? null,
    value.plannerModel ?? null,
    value.plannerStepIndex ?? null,
    value.plannerStepCount ?? null,
    value.plannerIntent ?? null,
    value.missionKind ?? null,
    value.runKind ?? null,
    value.controlKind ?? null,
    value.stage ?? null,
    value.outcome ?? null,
    value.failureClass ?? null,
    value.interruptionReason ?? null,
    value.sessionCloseReason ?? null,
    value.transcript ?? null,
    value.canonicalReply ?? null,
  ]);
}

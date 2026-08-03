import { createHmac } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { MISTRAL_CONVERSATION_PROTOCOL, isAllowedAgentNavigationRoute } from '@bob/ai';
import {
  appConflict,
  appForbidden,
  appNotFound,
  appRateLimited,
  appUnavailable,
  ok,
  parseRealtimeVoiceClientTerminationDiagnostic,
  type AppError,
  type Result,
} from '@bob/core';
import { Metrics } from '../../observability/metrics';
import { AppLogger, getPrincipal } from '../../observability/logger';
import {
  isRealtimeSessionId,
  prepareRealtimeContext,
  REALTIME_CONTEXT_SCHEMA_VERSION,
  type RealtimeAdmissionLease,
  type RealtimeAdmissionPort,
  type RealtimeAdmissionReserveInput,
  type RealtimeAdmissionResult,
  type RealtimeAdmissionSessionLookupInput,
} from './realtime-admission';
import { RealtimeCallLifecycle } from './realtime-call-lifecycle';
import {
  RealtimeProviderCallCompensatedError,
  RealtimeProviderCleanupError,
} from './openai-realtime-call.adapter';
import {
  buildOpenAiNativeRealtimeSessionConfig,
  buildOpenAiRealtimeSessionConfig,
} from './realtime-session-config';
import {
  OPENAI_REALTIME_CALL_PROVIDER,
  REALTIME_ADMISSION,
  REALTIME_AGENT_MISSION_ADMISSION,
  REALTIME_AGENT_TURN,
  REALTIME_ENTITLEMENT,
  REALTIME_DURABLE_CONTROLS,
  REALTIME_PROVIDER_TERMINATION_REGISTRY,
  MISTRAL_REALTIME_INGRESS_TICKETS,
  MISTRAL_CONVERSATION_BOOTSTRAP_AUTHORITY,
  MISTRAL_CONVERSATION_RESUME_AUTHORITY,
  MISTRAL_CONVERSATION_TERMINAL_REPLAY_RUNTIME,
  REALTIME_SIDEBAND,
  REALTIME_VOICE_SETTINGS,
  REALTIME_SPEECH_SOURCE_POLICY,
  REALTIME_VOICE_TRACE_V2,
} from './realtime.tokens';
import {
  realtimeAgentContextVersion,
  type RealtimeAgentContextVersion,
  type RealtimeAgentTurnPort,
} from './realtime-agent-turn';
import {
  BOB_REALTIME_CONFIG_VERSION,
  BOB_REALTIME_CONFIG_VERSION_N_MINUS_ONE,
  type OpenAiRealtimeCallProvider,
  type RealtimeVoiceBootstrapReconciliation,
  type RealtimeCallBootstrap,
  type RealtimeVoiceResumeTicket,
  type RealtimeVoicePublicConfig,
  type RealtimeVoiceSettings,
} from './realtime.types';
import {
  RealtimeProviderTerminationRegistry,
  realtimeProviderTerminationAdapter,
} from './realtime-provider-registry';
import type {
  RealtimeApprovedAgentControl,
  RealtimeSidebandControl,
} from './realtime-sideband';
import type { RealtimeEntitlementPort } from './realtime-entitlement';
import {
  DisabledRealtimeDurableControlAuthority,
  type RealtimeDurableControlPort,
} from './realtime-control';
import {
  DisabledMistralRealtimeIngressTicketAuthority,
  type MistralRealtimeIngressTicketAuthority,
} from './realtime-mistral-ingress-ticket';
import type {
  RealtimeSpeechSourcePolicy,
  RealtimeSpeechSourcePolicyPort,
} from './realtime-speech-storage';
import {
  DisabledMistralConversationResumeAuthority,
  isMistralConversationSessionHandle,
  isMistralConversationResumeTicket,
  isMistralConversationTerminalReceipt,
  type MistralConversationResumeAuthority,
} from './mistral-conversation-resume-ticket';
import {
  DisabledMistralConversationBootstrapTicketAuthority,
  isMistralConversationBootstrapTicket,
  type MistralConversationBootstrapTicketAuthority,
} from './mistral-conversation-bootstrap-ticket';
import { isMistralConversationBootstrapReconciliationAttempt } from './mistral-conversation-bootstrap-reconciliation';
import type { MistralConversationRuntimeCapability } from './mistral-conversation-terminal-replay';
import {
  hashRealtimeAgentMissionCapability,
  isRealtimeAgentMissionCapability,
  parseRealtimeAgentMissionNegotiation,
  realtimeAgentMissionCapabilityProtocolVersion,
  realtimeAgentMissionBootstrapBinding,
  type RealtimeAgentMissionNegotiationRequest,
} from './realtime-agent-mission-negotiation';
import {
  agentMissionPrincipalBindingHash,
  DisabledRealtimeAgentMissionAdmissionGate,
  type RealtimeAgentMissionAdmissionGate,
  type RealtimeAgentMissionAdmissionPreparation,
} from './realtime-agent-mission-admission';
import { realtimeSubjectBindings } from './realtime-principal-binding';
import { RealtimeVoiceTraceFactory } from './realtime-voice-trace';
import type { RealtimeVoiceTraceFailureClass, RealtimeVoiceTraceStage } from '@bob/core';

export { admissionSubjectHash } from './realtime-principal-binding';

const MAX_OFFER_SDP_CHARS = 64 * 1024;
const REALTIME_CONTROL_CONTEXT_TIMEOUT_MS = 1_000;
const REALTIME_TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REALTIME_CONTEXT_DIGEST = /^[a-f0-9]{64}$/;
const MISTRAL_CONVERSATION_MAX_EPOCH = 0x7fff_ffff;
const MISTRAL_CONVERSATION_CURSOR_END = 0x1_0000_0000;

type RealtimeBootstrapWireBinding =
  | {
      wireContract: 'v4';
      configVersion: typeof BOB_REALTIME_CONFIG_VERSION;
      speechDelivery: 'openai-native-webrtc-v1' | 'audited-signed-url-v1';
    }
  | {
      wireContract: 'v3-legacy';
      configVersion: typeof BOB_REALTIME_CONFIG_VERSION_N_MINUS_ONE;
      speechDelivery: 'audited-signed-url-v1';
    };

function parseRealtimeBootstrapWireBinding(
  record: Record<string, unknown>,
): Result<RealtimeBootstrapWireBinding, AppError> {
  const hasConfigVersion = Object.hasOwn(record, 'configVersion');
  const hasSpeechDelivery = Object.hasOwn(record, 'speechDelivery');
  if (!hasConfigVersion && !hasSpeechDelivery) {
    return ok({
      wireContract: 'v3-legacy',
      configVersion: BOB_REALTIME_CONFIG_VERSION_N_MINUS_ONE,
      speechDelivery: 'audited-signed-url-v1',
    });
  }
  if (!hasConfigVersion || !hasSpeechDelivery) {
    return {
      ok: false,
      error: {
        kind: 'validation',
        issues: [{ field: 'body', message: 'Version et livraison Bob Live doivent être fournies ensemble.' }],
      },
    };
  }
  if (record.configVersion !== BOB_REALTIME_CONFIG_VERSION) {
    return {
      ok: false,
      error: { kind: 'validation', issues: [{ field: 'configVersion', message: 'Version Bob Live incompatible.' }] },
    };
  }
  if (
    record.speechDelivery !== 'openai-native-webrtc-v1'
    && record.speechDelivery !== 'audited-signed-url-v1'
  ) {
    return {
      ok: false,
      error: { kind: 'validation', issues: [{ field: 'speechDelivery', message: 'Livraison audio incompatible.' }] },
    };
  }
  return ok({
    wireContract: 'v4',
    configVersion: BOB_REALTIME_CONFIG_VERSION,
    speechDelivery: record.speechDelivery,
  });
}

export function safetyIdentifier(secret: string, userId: string): string {
  const digest = createHmac('sha256', secret)
    .update(`bob-pro:openai-safety:v1:${userId}`, 'utf8')
    .digest('base64url');
  return `bob_${digest}`;
}

export function parseRealtimeCallBody(
  body: unknown,
): Result<{
  sdp: string;
  sessionHandle?: string;
  agentMissionNegotiation: RealtimeAgentMissionNegotiationRequest;
} & RealtimeBootstrapWireBinding, AppError> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'body', message: 'Corps JSON objet requis.' }] } };
  }
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => (
      key !== 'sdp'
      && key !== 'sessionHandle'
      && key !== 'configVersion'
      && key !== 'speechDelivery'
      && key !== 'agentMissionProtocolVersion'
    ))
  ) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'body', message: 'Champ non autorisé.' }] } };
  }
  const sdp = record.sdp;
  if (
    typeof sdp !== 'string'
    || sdp.length < 16
    || sdp.length > MAX_OFFER_SDP_CHARS
    || sdp.includes('\u0000')
    || !sdp.startsWith('v=0')
    || !/(?:^|\r?\n)m=audio\s/m.test(sdp)
  ) {
    return {
      ok: false,
      error: { kind: 'validation', issues: [{ field: 'sdp', message: 'Offre SDP audio invalide ou trop volumineuse.' }] },
    };
  }
  const sessionHandle = record.sessionHandle;
  if (sessionHandle !== undefined && (typeof sessionHandle !== 'string' || !isRealtimeSessionId(sessionHandle))) {
    return {
      ok: false,
      error: { kind: 'validation', issues: [{ field: 'sessionHandle', message: 'Identifiant de session invalide.' }] },
    };
  }
  const binding = parseRealtimeBootstrapWireBinding(record);
  if (!binding.ok) return binding;
  const agentMissionNegotiation = parseRealtimeAgentMissionNegotiation(record);
  if (!agentMissionNegotiation.ok) return agentMissionNegotiation;
  return ok({
    sdp,
    ...binding.value,
    agentMissionNegotiation: agentMissionNegotiation.value,
    ...(sessionHandle === undefined ? {} : { sessionHandle }),
  });
}

export function parseMistralRealtimeCallBody(
  body: unknown,
): Result<{
  sessionHandle?: string;
  protocol: 'bob.mistral-pcm.v1' | 'bob.mistral-pcm.v2';
  context: { version: 1; revision: number; context: unknown };
  agentMissionNegotiation: RealtimeAgentMissionNegotiationRequest;
} & RealtimeBootstrapWireBinding, AppError> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'body', message: 'Corps JSON objet requis.' }] } };
  }
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => (
      key !== 'sessionHandle' && key !== 'context' && key !== 'protocol'
      && key !== 'configVersion' && key !== 'speechDelivery'
      && key !== 'agentMissionProtocolVersion'
    ))
    || !Object.hasOwn(record, 'context')
  ) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'body', message: 'Champ non autorisé ou contexte absent.' }] } };
  }
  const context = parseRealtimeContextBody(record.context);
  if (!context.ok) return context;
  const protocol = record.protocol ?? 'bob.mistral-pcm.v1';
  if (protocol !== 'bob.mistral-pcm.v1' && protocol !== MISTRAL_CONVERSATION_PROTOCOL) {
    return {
      ok: false,
      error: {
        kind: 'validation',
        issues: [{ field: 'protocol', message: 'Protocole Mistral non supporté.' }],
      },
    };
  }
  const binding = parseRealtimeBootstrapWireBinding(record);
  if (!binding.ok) return binding;
  const agentMissionNegotiation = parseRealtimeAgentMissionNegotiation(record);
  if (!agentMissionNegotiation.ok) return agentMissionNegotiation;
  if (binding.value.speechDelivery !== 'audited-signed-url-v1') {
    return {
      ok: false,
      error: { kind: 'validation', issues: [{ field: 'speechDelivery', message: 'Livraison audio Mistral incompatible.' }] },
    };
  }
  const sessionHandle = record.sessionHandle;
  if (sessionHandle !== undefined && (typeof sessionHandle !== 'string' || !isRealtimeSessionId(sessionHandle))) {
    return {
      ok: false,
      error: { kind: 'validation', issues: [{ field: 'sessionHandle', message: 'Identifiant de session invalide.' }] },
    };
  }
  return ok({
    protocol,
    context: context.value,
    ...binding.value,
    agentMissionNegotiation: agentMissionNegotiation.value,
    ...(sessionHandle === undefined ? {} : { sessionHandle }),
  });
}

export type AgentMissionNegotiationMetricLabels = Readonly<{
  requested: 'omitted' | 'null' | 'v1' | 'v2' | 'unknown';
  outcome: 'historical' | 'accepted' | 'refused' | 'error';
  provider: 'openai' | 'mistral' | 'unknown';
  transport: 'webrtc' | 'mistral_pcm' | 'unknown';
}>;

function requestedAgentMissionProtocol(
  body: unknown,
): AgentMissionNegotiationMetricLabels['requested'] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return 'unknown';
  const record = body as Record<string, unknown>;
  if (!Object.hasOwn(record, 'agentMissionProtocolVersion')) return 'omitted';
  if (record.agentMissionProtocolVersion === null) return 'null';
  if (record.agentMissionProtocolVersion === 1) return 'v1';
  return record.agentMissionProtocolVersion === 2 ? 'v2' : 'unknown';
}

export function agentMissionNegotiationMetricLabels(
  body: unknown,
  provider: RealtimeVoiceSettings['provider'],
  result: Result<RealtimeCallBootstrap, AppError>,
): AgentMissionNegotiationMetricLabels {
  const requested = requestedAgentMissionProtocol(body);
  const providerLabel = provider === 'openai' || provider === 'mistral'
    ? provider
    : 'unknown';
  const transport = provider === 'openai'
    ? 'webrtc'
    : provider === 'mistral'
      ? 'mistral_pcm'
      : 'unknown';
  if (!result.ok) {
    const unsupportedVersion = result.error.kind === 'validation'
      && result.error.issues.some(
        (issue) => issue.field === 'agentMissionProtocolVersion',
      );
    return Object.freeze({
      requested,
      outcome: unsupportedVersion ? 'refused' : 'error',
      provider: providerLabel,
      transport,
    });
  }
  if (requested === 'omitted' || requested === 'null') {
    return Object.freeze({
      requested,
      outcome: 'historical',
      provider: providerLabel,
      transport,
    });
  }
  const requestedVersion = requested === 'v1'
    ? 1
    : requested === 'v2'
      ? 2
      : null;
  const accepted = requestedVersion !== null
    && result.value.agentMissionProtocolVersion === requestedVersion
    && isRealtimeAgentMissionCapability(result.value.agentMissionCapability);
  return Object.freeze({
    requested,
    outcome: accepted ? 'accepted' : 'refused',
    provider: providerLabel,
    transport,
  });
}

export function parseRealtimeResumeTicketBody(
  body: unknown,
): Result<{ missionConnectionEpoch: number; nextServerSequence: number }, AppError> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      error: { kind: 'validation', issues: [{ field: 'body', message: 'Objet requis.' }] },
    };
  }
  const value = body as Record<string, unknown>;
  const allowed = new Set(['missionConnectionEpoch', 'nextServerSequence']);
  if (
    Object.keys(value).length !== allowed.size
    || Object.keys(value).some((key) => !allowed.has(key))
    || !Number.isSafeInteger(value.missionConnectionEpoch)
    || Object.is(value.missionConnectionEpoch, -0)
    || (value.missionConnectionEpoch as number) < 1
    || (value.missionConnectionEpoch as number) > MISTRAL_CONVERSATION_MAX_EPOCH
    || !Number.isSafeInteger(value.nextServerSequence)
    || Object.is(value.nextServerSequence, -0)
    || (value.nextServerSequence as number) < 0
    || (value.nextServerSequence as number) > MISTRAL_CONVERSATION_CURSOR_END
  ) {
    return {
      ok: false,
      error: {
        kind: 'validation',
        issues: [{ field: 'resume', message: 'Epoch ou curseur de reprise invalide.' }],
      },
    };
  }
  return ok({
    missionConnectionEpoch: value.missionConnectionEpoch as number,
    nextServerSequence: value.nextServerSequence as number,
  });
}

export function parseRealtimeBootstrapReconciliationBody(
  body: unknown,
): Result<{
  protocol: typeof MISTRAL_CONVERSATION_PROTOCOL;
  bootstrapTicket: string;
  attempt: number;
}, AppError> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      error: { kind: 'validation', issues: [{ field: 'body', message: 'Objet requis.' }] },
    };
  }
  const value = body as Record<string, unknown>;
  const allowed = new Set(['protocol', 'bootstrapTicket', 'attempt']);
  if (
    Object.keys(value).length !== allowed.size
    || Object.keys(value).some((key) => !allowed.has(key))
    || value.protocol !== MISTRAL_CONVERSATION_PROTOCOL
    || !isMistralConversationBootstrapTicket(value.bootstrapTicket)
    || !isMistralConversationBootstrapReconciliationAttempt(value.attempt)
  ) {
    return {
      ok: false,
      error: {
        kind: 'validation',
        issues: [{ field: 'reconciliation', message: 'Demande de réconciliation invalide.' }],
      },
    };
  }
  return ok({
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    bootstrapTicket: value.bootstrapTicket,
    attempt: value.attempt,
  });
}

function isCanonicalRealtimeIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isCanonicalMistralConversationResumeTicket(value: unknown): value is string {
  if (!isMistralConversationResumeTicket(value)) return false;
  try {
    const payload = value.slice(3);
    const decoded = Buffer.from(payload, 'base64url');
    return decoded.byteLength === 32 && decoded.toString('base64url') === payload;
  } catch {
    return false;
  }
}

export function parseRealtimeContextBody(
  body: unknown,
): Result<{ version: 1; revision: number; context: unknown }, AppError> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'body', message: 'Contexte JSON objet requis.' }] } };
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set(['version', 'revision', 'context']);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'body', message: 'Champ non autorisé.' }] } };
  }
  if (record.version !== REALTIME_CONTEXT_SCHEMA_VERSION) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'version', message: 'Version de contexte non supportée.' }] } };
  }
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1 || (record.revision as number) > 2_147_483_647) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'revision', message: 'Révision de contexte invalide.' }] } };
  }
  if (record.context === null || typeof record.context !== 'object' || Array.isArray(record.context)) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'context', message: 'Contexte écran invalide.' }] } };
  }
  return ok({ version: REALTIME_CONTEXT_SCHEMA_VERSION, revision: record.revision as number, context: record.context });
}

export function parseRealtimeControlAcknowledgementBody(
  body: unknown,
): Result<{
  turnId: string;
  acknowledgementId: string;
  contextRevision: number;
  contextDigest: string;
}, AppError> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'body', message: 'Demande d’acquittement objet requise.' }] } };
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set(['turnId', 'acknowledgementId', 'contextRevision', 'contextDigest']);
  if (Object.keys(record).length !== allowed.size || Object.keys(record).some((key) => !allowed.has(key))) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'body', message: 'Champs d’acquittement invalides.' }] } };
  }
  if (typeof record.turnId !== 'string' || !REALTIME_TURN_ID.test(record.turnId)) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'turnId', message: 'Identifiant de tour invalide.' }] } };
  }
  if (
    typeof record.acknowledgementId !== 'string'
    || !REALTIME_TURN_ID.test(record.acknowledgementId)
  ) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'acknowledgementId', message: 'Identifiant d’acquittement audio invalide.' }] } };
  }
  if (
    !Number.isSafeInteger(record.contextRevision)
    || (record.contextRevision as number) < 1
    || (record.contextRevision as number) > 2_147_483_647
  ) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'contextRevision', message: 'Révision de contexte invalide.' }] } };
  }
  if (typeof record.contextDigest !== 'string' || !REALTIME_CONTEXT_DIGEST.test(record.contextDigest)) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'contextDigest', message: 'Empreinte de contexte invalide.' }] } };
  }
  return ok({
    turnId: record.turnId,
    acknowledgementId: record.acknowledgementId,
    contextRevision: record.contextRevision as number,
    contextDigest: record.contextDigest,
  });
}

function safeApprovedControl(
  value: unknown,
  expected: { turnId: string; contextRevision: number; contextDigest: string },
): RealtimeApprovedAgentControl | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const control = value as Record<string, unknown>;
  const allowed = new Set([
    'turnId',
    'kind',
    'contextRevision',
    'contextDigest',
    'navigate',
    'proposalId',
    'proposalExpiresAt',
  ]);
  if (
    Object.keys(control).some((key) => !allowed.has(key))
    || control.turnId !== expected.turnId
    || control.contextRevision !== expected.contextRevision
    || control.contextDigest !== expected.contextDigest
    || (control.kind !== 'answer' && control.kind !== 'proposed' && control.kind !== 'done')
    || (control.navigate !== undefined && !isAllowedAgentNavigationRoute(control.navigate))
    || (control.proposalId !== undefined && (
      typeof control.proposalId !== 'string'
      || !REALTIME_TURN_ID.test(control.proposalId)
    ))
    || (control.proposalExpiresAt !== undefined && (
      typeof control.proposalExpiresAt !== 'string'
      || control.proposalExpiresAt.length > 40
      || !Number.isFinite(Date.parse(control.proposalExpiresAt))
      || Date.parse(control.proposalExpiresAt) <= Date.now()
      || control.proposalId === undefined
    ))
  ) return null;
  return {
    turnId: expected.turnId,
    kind: control.kind,
    contextRevision: expected.contextRevision,
    contextDigest: expected.contextDigest,
    ...(typeof control.navigate === 'string' ? { navigate: control.navigate } : {}),
    ...(typeof control.proposalId === 'string' ? { proposalId: control.proposalId } : {}),
    ...(typeof control.proposalExpiresAt === 'string' ? { proposalExpiresAt: control.proposalExpiresAt } : {}),
  };
}

function admissionSessionLookup(
  settings: RealtimeVoiceSettings,
  companyId: string,
  userId: string,
  sessionId: string,
): RealtimeAdmissionSessionLookupInput | null {
  const bindings = realtimeSubjectBindings(settings, companyId, userId);
  if (bindings === null) return null;
  return {
    companyId,
    subjectHashCandidates: [
      bindings.subjectHash,
      ...bindings.historicalSubjectBindings.map((binding) => binding.subjectHash),
    ],
    principalBindingHash: agentMissionPrincipalBindingHash(companyId, userId),
    sessionId,
  };
}

/**
 * Corrèle le secret conservé par l'orchestrateur avec la preuve effectivement écrite par
 * l'admission. Toute divergence ferme le bootstrap avant le premier appel provider.
 */
export function admittedAgentMissionCapability(
  prepared: RealtimeAgentMissionAdmissionPreparation,
  proof: Extract<RealtimeAdmissionResult, { allowed: true }>['agentMissionProof'],
): string | null {
  if (prepared.binding === null) {
    if (proof !== null) {
      throw new Error('AgentMission admission returned an unexpected durable proof.');
    }
    return null;
  }
  if (
    proof === null
    || proof.protocolVersion !== prepared.binding.protocolVersion
    || proof.capabilityHash !== prepared.binding.capabilityHash
    || proof.releaseFlagVersion !== prepared.binding.releaseFlagVersion
  ) {
    throw new Error('AgentMission admission proof does not match the prepared capability.');
  }
  return prepared.capability;
}

function retryAfterSeconds(retryAt: string | null, fallback: number): number {
  const at = retryAt === null ? Number.NaN : Date.parse(retryAt);
  if (!Number.isFinite(at)) return fallback;
  return Math.max(1, Math.min(3_600, Math.ceil((at - Date.now()) / 1_000)));
}

function admissionDenial(result: Exclude<RealtimeAdmissionResult, { allowed: true }>): AppError {
  const retry = retryAfterSeconds(result.retryAt, result.denial.includes('hour') ? 3_600 : 60);
  if (
    result.denial === 'user_minute'
    || result.denial === 'user_hour'
    || result.denial === 'tenant_minute'
    || result.denial === 'tenant_hour'
  ) {
    return appRateLimited('Trop de connexions Bob Live.', retry);
  }
  if (result.denial === 'active_lease') {
    return appConflict('realtime_session', 'Une session Bob Live est déjà active.');
  }
  return appUnavailable('bob-live-admission', retry);
}

function providerErrorClass(error: unknown): string {
  const value = error instanceof Error ? error.message : '';
  const allowed = new Set([
    'provider_timeout',
    'provider_network_error',
    'provider_http_4xx',
    'provider_http_5xx',
    'provider_response_too_large',
    'provider_response_read_error',
    'provider_call_id_missing',
    'provider_call_id_invalid',
    'provider_invalid_sdp',
    'provider_create_callback_failed',
    'provider_call_registration_missing',
    'provider_not_configured',
    'provider_hangup_failed',
    'provider_hangup_http_4xx',
    'provider_hangup_http_5xx',
    'provider_hangup_timeout',
    'provider_hangup_network_error',
    'sideband_timeout',
    'sideband_send_failed',
    'sideband_network_error',
    'sideband_closed_before_ready',
    'sideband_invalid_call_id',
    'sideband_invalid_base_url',
    'sideband_not_configured',
    'sideband_policy_drift',
    'sideband_malformed_event',
    'sideband_provider_error',
    'sideband_activation_failed',
    'sideband_owner_busy',
    'sideband_owner_rejected',
    'sideband_owner_unavailable',
    'sideband_context_lost',
    'sideband_context_stale',
    'sideband_context_rejected',
    'sideband_context_unavailable',
    'sideband_superseded',
    'sideband_unknown',
    'bootstrap_aborted',
    'realtime_admission_bind_rejected',
    'realtime_admission_bind_expired',
    'realtime_admission_bind_unavailable',
    'realtime_bootstrap_fenced',
  ]);
  return allowed.has(value) ? value : 'provider_unknown';
}

function traceProviderFailure(errorClass: string): {
  readonly stage: RealtimeVoiceTraceStage;
  readonly failureClass: RealtimeVoiceTraceFailureClass;
} {
  if (errorClass === 'bootstrap_aborted') {
    return { stage: 'provider_call', failureClass: 'bootstrap_aborted' };
  }
  if (errorClass === 'provider_call_registration_missing') {
    return { stage: 'provider_call', failureClass: 'provider_registration_missing' };
  }
  const sideband = errorClass.startsWith('sideband_');
  const allowedSideband = new Set<RealtimeVoiceTraceFailureClass>([
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
  ]);
  if (sideband && allowedSideband.has(errorClass as RealtimeVoiceTraceFailureClass)) {
    return {
      stage: errorClass.startsWith('sideband_owner_')
        ? 'sideband_owner'
        : errorClass.startsWith('sideband_context_')
          ? 'context'
          : 'sideband_bootstrap',
      failureClass: errorClass as RealtimeVoiceTraceFailureClass,
    };
  }
  return {
    stage: sideband ? 'sideband_bootstrap' : 'provider_call',
    failureClass: sideband ? 'unknown' : 'provider_create_failed',
  };
}

@Injectable()
export class RealtimeVoiceService {
  private readonly providerTerminations: RealtimeProviderTerminationRegistry;

  constructor(
    @Inject(REALTIME_VOICE_SETTINGS) private readonly settings: RealtimeVoiceSettings,
    @Inject(OPENAI_REALTIME_CALL_PROVIDER) private readonly provider: OpenAiRealtimeCallProvider,
    @Inject(REALTIME_ADMISSION) private readonly admission: RealtimeAdmissionPort,
    @Inject(REALTIME_SIDEBAND) private readonly sideband: RealtimeSidebandControl,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    @Inject(REALTIME_AGENT_TURN) private readonly agentTurns: RealtimeAgentTurnPort = {
      run: async () => ({
        status: 'failed',
        canonicalSpeech: 'Bob Live n’est pas encore relié au moteur métier.',
      }),
    },
    @Inject(REALTIME_ENTITLEMENT) private readonly entitlements: RealtimeEntitlementPort = {
      check: async () => { throw new Error('realtime_entitlement_missing'); },
    },
    @Inject(MISTRAL_REALTIME_INGRESS_TICKETS)
    private readonly mistralTickets: MistralRealtimeIngressTicketAuthority =
      new DisabledMistralRealtimeIngressTicketAuthority(),
    @Optional()
    @Inject(REALTIME_PROVIDER_TERMINATION_REGISTRY)
    providerTerminations?: RealtimeProviderTerminationRegistry,
    @Optional()
    @Inject(REALTIME_DURABLE_CONTROLS)
    private readonly controls: RealtimeDurableControlPort =
      new DisabledRealtimeDurableControlAuthority(),
    @Optional()
    @Inject(REALTIME_SPEECH_SOURCE_POLICY)
    private readonly speechSourcePolicy: RealtimeSpeechSourcePolicyPort | null = null,
    @Optional()
    @Inject(MISTRAL_CONVERSATION_RESUME_AUTHORITY)
    private readonly conversationResume: MistralConversationResumeAuthority =
      new DisabledMistralConversationResumeAuthority(),
    @Optional()
    @Inject(MISTRAL_CONVERSATION_BOOTSTRAP_AUTHORITY)
    private readonly conversationBootstrap: MistralConversationBootstrapTicketAuthority =
      new DisabledMistralConversationBootstrapTicketAuthority(),
    @Optional()
    @Inject(MISTRAL_CONVERSATION_TERMINAL_REPLAY_RUNTIME)
    private readonly conversationRuntime: MistralConversationRuntimeCapability | null = null,
    @Optional()
    @Inject(REALTIME_AGENT_MISSION_ADMISSION)
    private readonly agentMissionAdmission: RealtimeAgentMissionAdmissionGate =
      new DisabledRealtimeAgentMissionAdmissionGate(),
    @Optional()
    @Inject(REALTIME_VOICE_TRACE_V2)
    private readonly voiceTrace: RealtimeVoiceTraceFactory | null = null,
  ) {
    // Les tests unitaires et les compositions historiques construisent encore le service
    // directement. Le fallback doit capturer le paramètre `provider` déjà initialisé : une
    // valeur par défaut de paramètre ne peut pas dépendre fiablement d'une parameter-property.
    this.providerTerminations = providerTerminations
      ?? new RealtimeProviderTerminationRegistry(
        settings.provider === 'openai'
          ? [realtimeProviderTerminationAdapter('openai', provider)]
          : [],
      );
  }

  async publicConfig(): Promise<RealtimeVoicePublicConfig> {
    const mistralV2LiveAvailable = this.settings.mistralV2InitialBootstrapEnabled
      && this.conversationRuntime?.liveTurnsAvailable === true;
    const technicallyAvailable = this.settings.enabled
      && Boolean(this.settings.apiKey)
      && Boolean(this.settings.safetySecret);
    let available = false;
    let availabilityReason: RealtimeVoicePublicConfig['availabilityReason'] = technicallyAvailable
      ? 'entitlement_unavailable'
      : 'disabled';
    const principal = getPrincipal();
    if (technicallyAvailable && principal?.userId && principal.companyId) {
      try {
        const entitlement = await this.entitlements.check({
          userId: principal.userId,
          companyId: principal.companyId,
        });
        available = entitlement.allowed;
        availabilityReason = entitlement.allowed ? undefined : 'not_entitled';
        this.metrics.bobLiveEntitlementChecks.inc({
          outcome: entitlement.allowed ? 'preflight_allowed' : 'preflight_denied',
          plan: entitlement.plan,
        });
      } catch {
        this.metrics.bobLiveEntitlementChecks.inc({ outcome: 'preflight_error', plan: 'unknown' });
      }
    }
    const diagnosticTrace =
      principal?.companyId && principal.userId
        ? (this.voiceTrace?.disclosureFor(principal.companyId, principal.userId) ?? null)
        : null;
    const common = {
      available,
      ...(availabilityReason === undefined ? {} : { availabilityReason }),
      model: this.settings.model,
      voice: this.settings.voice,
      configVersion: BOB_REALTIME_CONFIG_VERSION,
      requiresDevelopmentBuild: true,
      maxSessionSeconds: this.settings.maxSessionSeconds,
      ...(diagnosticTrace === null ? {} : { diagnosticTrace }),
    } as const;
    if (this.settings.provider === 'mistral') {
      return {
        ...common,
        transport: 'mistral-pcm',
        speechDelivery: 'audited-signed-url-v1',
        protocol: mistralV2LiveAvailable
          ? MISTRAL_CONVERSATION_PROTOCOL
          : ('bob.mistral-pcm.v1' as const),
      };
    }
    return {
      ...common,
      transport: 'webrtc',
      speechDelivery: this.settings.speechDelivery,
    };
  }

  async acknowledgeAgentMissionBootstrap(
    sessionHandle: string,
    presentedCapability: unknown,
  ): Promise<Result<{ acknowledged: true; replayed: boolean }, AppError>> {
    const principal = getPrincipal();
    if (
      !principal?.userId
      || !principal.companyId
      || !isRealtimeSessionId(sessionHandle)
      || !isRealtimeAgentMissionCapability(presentedCapability)
    ) {
      this.metrics.agentMissionCapabilityRejections.inc({
        operation: 'bootstrap_ack',
        reason: presentedCapability === undefined ? 'missing' : 'malformed',
      });
      this.metrics.agentMissionBootstrapReceipts.inc({ outcome: 'refused' });
      return { ok: false, error: appForbidden('agent_mission_bootstrap_receipt_rejected') };
    }
    const lookup = admissionSessionLookup(
      this.settings,
      principal.companyId,
      principal.userId,
      sessionHandle,
    );
    if (lookup === null) {
      this.metrics.agentMissionBootstrapReceipts.inc({ outcome: 'error' });
      return {
        ok: false,
        error: appUnavailable('agent_mission_bootstrap_receipt', 5),
      };
    }

    const acknowledgement = await this.admission.acknowledgeAgentMissionBootstrap({
      ...lookup,
      protocolVersion:
        realtimeAgentMissionCapabilityProtocolVersion(presentedCapability)!,
      capabilityHash: hashRealtimeAgentMissionCapability(presentedCapability),
    });
    if (!acknowledgement.ok) {
      const unavailable = acknowledgement.reason === 'unavailable';
      this.metrics.agentMissionBootstrapReceipts.inc({
        outcome: unavailable ? 'error' : 'refused',
      });
      if (!unavailable) {
        this.metrics.agentMissionCapabilityRejections.inc({
          operation: 'bootstrap_ack',
          reason: acknowledgement.reason,
        });
      }
      return unavailable
        ? {
            ok: false,
            error: appUnavailable('agent_mission_bootstrap_receipt', 5),
          }
        : {
            ok: false,
            error: appForbidden('agent_mission_bootstrap_receipt_rejected'),
          };
    }
    this.metrics.agentMissionBootstrapReceipts.inc({
      outcome: acknowledgement.status,
    });
    this.logger.audit('bob.live.agent_mission.bootstrap_receipt', {
      outcome: acknowledgement.status,
    });
    return ok({
      acknowledged: true,
      replayed: acknowledgement.status === 'replayed',
    });
  }

  async createCall(
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeCallBootstrap, AppError>> {
    try {
      const result = await this.createCallWithoutAgentMissionMetric(body, signal);
      this.metrics.agentMissionNegotiations.inc(
        agentMissionNegotiationMetricLabels(body, this.settings.provider, result),
      );
      return result;
    } catch (cause) {
      this.metrics.agentMissionNegotiations.inc({
        requested: requestedAgentMissionProtocol(body),
        outcome: 'error',
        provider: this.settings.provider === 'openai' || this.settings.provider === 'mistral'
          ? this.settings.provider
          : 'unknown',
        transport: this.settings.provider === 'openai'
          ? 'webrtc'
          : this.settings.provider === 'mistral'
            ? 'mistral_pcm'
            : 'unknown',
      });
      throw cause;
    }
  }

  private async createCallWithoutAgentMissionMetric(
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeCallBootstrap, AppError>> {
    const startedAt = performance.now();
    if (!this.settings.enabled) return this.finishError('disabled', startedAt, appForbidden('Bob Live est désactivé.'));
    if (this.settings.provider === 'mistral') {
      return this.createMistralCall(body, startedAt, signal);
    }
    const parsed = parseRealtimeCallBody(body);
    if (!parsed.ok) return this.finishError('validation', startedAt, parsed.error);
    if (parsed.value.speechDelivery !== this.settings.speechDelivery) {
      return this.finishError('validation', startedAt, {
        kind: 'validation',
        issues: [{ field: 'speechDelivery', message: 'Contrat audio différent du config négocié.' }],
      });
    }

    const principal = getPrincipal();
    if (!principal?.userId || !principal.companyId) {
      return this.finishError('identity_missing', startedAt, appForbidden('Session utilisateur et espace de travail requis.'));
    }
    let trace: ReturnType<RealtimeVoiceTraceFactory['begin']> = null;
    try {
      trace = this.voiceTrace?.begin(principal.companyId, principal.userId) ?? null;
    } catch {
      // Observateur strictement non autoritaire : aucune panne locale du journal ne coupe Bob.
      this.logger.error(
        'bob.live.trace.v2.failed class=attempt_initialization',
        undefined,
        'BobLiveTraceV2',
      );
    }
    if (
      parsed.value.agentMissionNegotiation.requested === 'v2'
      && principal.confirmedTimeZone === undefined
    ) {
      trace?.record({
        eventKind: 'session_bootstrap_failed',
        stage: 'admission',
        outcome: 'rejected',
        failureClass: 'admission_rejected',
      });
      return this.finishError(
        'time_zone_confirmation_required',
        startedAt,
        appForbidden('Confirmez votre fuseau horaire avant de démarrer Bob Live.'),
      );
    }
    if (!this.settings.safetySecret || !this.settings.apiKey) {
      trace?.record({
        eventKind: 'session_bootstrap_failed',
        stage: 'provider_call',
        outcome: 'unavailable',
        failureClass: 'provider_create_failed',
      });
      return this.finishError('misconfigured', startedAt, {
        kind: 'dependency',
        port: 'openai-realtime',
        cause: 'configuration_missing',
      });
    }
    let entitlement: Awaited<ReturnType<RealtimeEntitlementPort['check']>>;
    try {
      entitlement = await this.entitlements.check({
        userId: principal.userId,
        companyId: principal.companyId,
      });
    } catch {
      this.metrics.bobLiveEntitlementChecks.inc({ outcome: 'error', plan: 'unknown' });
      trace?.record({
        eventKind: 'session_bootstrap_failed',
        stage: 'admission',
        outcome: 'unavailable',
        failureClass: 'admission_rejected',
      });
      return this.finishError(
        'entitlement_unavailable',
        startedAt,
        appUnavailable('bob-live-entitlement', 60),
      );
    }
    if (!entitlement.allowed) {
      this.metrics.bobLiveEntitlementChecks.inc({ outcome: 'denied', plan: entitlement.plan });
      trace?.record({
        eventKind: 'session_bootstrap_failed',
        stage: 'admission',
        outcome: 'rejected',
        failureClass: 'admission_rejected',
      });
      return this.finishError(
        'entitlement_denied',
        startedAt,
        appForbidden('Bob Live nécessite un abonnement compatible.'),
      );
    }
    this.metrics.bobLiveEntitlementChecks.inc({ outcome: 'allowed', plan: entitlement.plan });

    const subjectBindings = realtimeSubjectBindings(
      this.settings,
      principal.companyId,
      principal.userId,
    );
    if (subjectBindings === null) {
      trace?.record({
        eventKind: 'session_bootstrap_failed',
        stage: 'admission',
        outcome: 'unavailable',
        failureClass: 'admission_rejected',
      });
      return this.finishError(
        'misconfigured',
        startedAt,
        appUnavailable('bob-live-admission-identity', 60),
      );
    }
    const principalBindingHash = agentMissionPrincipalBindingHash(
      principal.companyId,
      principal.userId,
    );
    let preparedAgentMission: RealtimeAgentMissionAdmissionPreparation;
    try {
      preparedAgentMission = await this.agentMissionAdmission.prepare({
        negotiation: parsed.value.agentMissionNegotiation,
        companyId: principal.companyId,
        userId: principal.userId,
        providerId: 'openai',
        transport: 'webrtc',
        speechDelivery: parsed.value.speechDelivery,
      });
    } catch {
      trace?.record({
        eventKind: 'session_bootstrap_failed',
        stage: 'admission',
        outcome: 'unavailable',
        failureClass: 'admission_rejected',
      });
      return this.finishError(
        'admission_unavailable',
        startedAt,
        appUnavailable('bob-live-agent-mission-admission', 5),
      );
    }
    const reserveInput: RealtimeAdmissionReserveInput = {
      companyId: principal.companyId,
      subjectHash: subjectBindings.subjectHash,
      subjectHashCandidates: [
        subjectBindings.subjectHash,
        ...subjectBindings.historicalSubjectBindings.map((binding) => binding.subjectHash),
      ],
      principalBindingHash,
      agentMissionBinding: preparedAgentMission.binding,
      maxSessionSeconds: this.settings.maxSessionSeconds,
      ...(parsed.value.sessionHandle === undefined ? {} : { sessionId: parsed.value.sessionHandle }),
    };
    const admission = await this.reserveAfterCleanup(reserveInput);
    if (!admission.allowed) {
      this.metrics.bobLiveRateLimited.inc({ scope: admission.denial ?? 'unknown' });
      const error = admissionDenial(admission);
      trace?.record({
        eventKind: 'session_bootstrap_failed',
        stage: 'admission',
        outcome: 'rejected',
        failureClass: 'admission_rejected',
      });
      return this.finishError(error.kind, startedAt, error);
    }

    const lease = admission.lease;
    trace?.bindSession(lease.sessionId);
    const agentMissionAuthority = admission.agentMissionProof === null
      ? undefined
      : Object.freeze({
          owner: Object.freeze({
            companyId: principal.companyId,
            ownerUserId: principal.userId,
          }),
          proof: Object.freeze({
            protocolVersion: admission.agentMissionProof.protocolVersion,
            subjectHashCandidates: Object.freeze([
              ...reserveInput.subjectHashCandidates,
            ]),
            principalBindingHash: reserveInput.principalBindingHash,
            capabilityHash: admission.agentMissionProof.capabilityHash,
          }),
          realtimeSessionId: lease.sessionId,
        });
    let agentMissionBinding: ReturnType<typeof realtimeAgentMissionBootstrapBinding>;
    try {
      agentMissionBinding = realtimeAgentMissionBootstrapBinding(
        parsed.value.agentMissionNegotiation,
        admittedAgentMissionCapability(
          preparedAgentMission,
          admission.agentMissionProof,
        ),
      );
    } catch {
      await this.admission.release({
        ...lease,
        providerTermination: 'not_created',
      }).catch(() => undefined);
      trace?.record({
        eventKind: 'session_bootstrap_failed',
        stage: 'admission',
        outcome: 'unavailable',
        failureClass: 'admission_rejected',
      });
      return this.finishError(
        'admission_unavailable',
        startedAt,
        appUnavailable('bob-live-agent-mission-admission', 5),
      );
    }
    let speechSourcePolicy: RealtimeSpeechSourcePolicy | null = null;
    if (parsed.value.speechDelivery === 'audited-signed-url-v1') {
      try {
        if (!this.speechSourcePolicy) throw new Error('speech_source_policy_missing');
        speechSourcePolicy = this.speechSourcePolicy.policyForSession(
          principal.companyId,
          lease.sessionId,
        );
      } catch {
        await this.admission.release({ ...lease, providerTermination: 'not_created' }).catch(() => undefined);
        trace?.record({
          eventKind: 'session_bootstrap_failed',
          stage: 'speech_prepare',
          outcome: 'unavailable',
          failureClass: 'speech_publish_failed',
        });
        return this.finishError(
          'speech_unavailable',
          startedAt,
          appUnavailable('bob-live-speech', 5),
        );
      }
    }
    let created: Awaited<ReturnType<OpenAiRealtimeCallProvider['createCall']>> | null = null;
    let registeredProviderCallId: string | null = null;
    let lifecycle: RealtimeCallLifecycle | null = null;
    try {
      if (signal?.aborted) throw new Error('bootstrap_aborted');
      const session = parsed.value.speechDelivery === 'openai-native-webrtc-v1'
        ? buildOpenAiNativeRealtimeSessionConfig(this.settings)
        : buildOpenAiRealtimeSessionConfig(this.settings);
      created = await this.provider.createCall({
        offerSdp: parsed.value.sdp,
        safetyIdentifier: safetyIdentifier(this.settings.safetySecret, principal.userId),
        session,
        ...(signal === undefined ? {} : { signal }),
        onCallCreated: async (callId) => {
          // Une implémentation provider ne doit publier qu'une seule identité. Refuser un second
          // callback empêche notamment deux binds successifs sur le même bail.
          if (registeredProviderCallId !== null) throw new Error('provider_create_callback_failed');
          registeredProviderCallId = callId;
          if (signal?.aborted) throw new Error('bootstrap_aborted');
          const bound = await this.admission.bindProvider({
            ...lease,
            providerId: this.settings.provider,
            providerCallId: callId,
          });
          if (!bound.ok) {
            throw new Error(`realtime_admission_bind_${bound.reason ?? 'rejected'}`);
          }
          if (signal?.aborted) throw new Error('bootstrap_aborted');
        },
      });
      if (signal?.aborted) throw new Error('bootstrap_aborted');
      if (registeredProviderCallId === null || registeredProviderCallId !== created.callId) {
        throw new Error('provider_call_registration_missing');
      }
      lifecycle = new RealtimeCallLifecycle({
        admission: this.admission,
        provider: this.provider,
        lease,
        terminationLookup: {
          companyId: lease.companyId,
          subjectHashCandidates: reserveInput.subjectHashCandidates,
          principalBindingHash: reserveInput.principalBindingHash,
          sessionId: lease.sessionId,
        },
        providerId: this.settings.provider,
        providerCallId: registeredProviderCallId,
        hardExpiresAt: lease.hardExpiresAt,
        heartbeatSeconds: this.settings.heartbeatSeconds,
        metrics: this.metrics,
        logger: this.logger,
      });
      await this.sideband.attach({
        callId: registeredProviderCallId,
        userId: principal.userId,
        companyId: principal.companyId,
        sessionHandle: lease.sessionId,
        speechDelivery: parsed.value.speechDelivery,
        plan: entitlement.plan,
        subjectKeyVersion: this.settings.subjectKeyVersion,
        session,
        lifecycle,
        ...(trace === null ? {} : { trace }),
        turn: {
          run: async ({ turnId, transcript, history, signal: turnSignal }) => {
            const contextIdentity = {
              companyId: principal.companyId!,
              subjectHash: lease.subjectHash,
              sessionId: lease.sessionId,
            };
            const stored = await this.admission.readContext(contextIdentity);
            if (turnSignal.aborted) return { status: 'aborted' as const };
            if (!stored.ok) {
              return {
                status: 'failed' as const,
                canonicalSpeech: 'Je ne peux pas vérifier le contexte de cet écran. Rien n’a été exécuté.',
              };
            }
            const expectedContext = realtimeAgentContextVersion(stored.snapshot);
            return this.agentTurns.run({
              turnId,
              userId: principal.userId,
              companyId: principal.companyId!,
              transcript,
              history,
              ...(principal.confirmedTimeZone === undefined
                ? {}
                : { confirmedTimeZone: principal.confirmedTimeZone }),
              ...(stored.snapshot?.context === undefined ? {} : { context: stored.snapshot.context }),
              ...(agentMissionAuthority === undefined
                ? {}
                : { agentMissionAuthority }),
              contextFence: {
                expected: expectedContext,
                revalidate: async (signal) => {
                  signal.throwIfAborted();
                  const current = await this.admission.readContext(contextIdentity);
                  signal.throwIfAborted();
                  if (!current.ok) throw new Error(`realtime_context_revalidate_${current.reason}`);
                  return realtimeAgentContextVersion(current.snapshot);
                },
              },
              ...(trace === null ? {} : { trace }),
              signal: turnSignal,
            });
          },
        },
        controlContext: {
          isCurrent: (expected, contextSignal) => this.isCurrentContextVersion(
            {
              companyId: principal.companyId!,
              subjectHash: lease.subjectHash,
              sessionId: lease.sessionId,
            },
            expected,
            contextSignal,
          ),
        },
      });
      if (signal?.aborted) throw new Error('bootstrap_aborted');
      const finalResolution = await this.admission.resolveSession({
        companyId: lease.companyId,
        subjectHashCandidates: reserveInput.subjectHashCandidates,
        principalBindingHash: reserveInput.principalBindingHash,
        sessionId: lease.sessionId,
      });
      if (
        !finalResolution.ok
        || finalResolution.identity === null
        || finalResolution.identity.companyId !== lease.companyId
        || finalResolution.identity.subjectHash !== lease.subjectHash
        || finalResolution.identity.sessionId !== lease.sessionId
      ) {
        throw new Error('realtime_bootstrap_fenced');
      }
      if (signal?.aborted) throw new Error('bootstrap_aborted');
      const elapsedSeconds = (performance.now() - startedAt) / 1_000;
      this.metrics.bobLiveBootstrapRequests.inc({ model: this.settings.model, outcome: 'ok' });
      this.metrics.bobLiveBootstrapDuration.observe({ model: this.settings.model, outcome: 'ok' }, elapsedSeconds);
      this.logger.audit('bob.live.bootstrap.succeeded', {
        model: this.settings.model,
        transport: 'webrtc',
        ms: Math.round(elapsedSeconds * 1_000),
      });
      const bootstrap = {
        transport: 'webrtc',
        answerSdp: created.answerSdp,
        sessionHandle: lease.sessionId,
        hardExpiresAt: lease.hardExpiresAt,
        model: this.settings.model,
        voice: this.settings.voice,
        configVersion: BOB_REALTIME_CONFIG_VERSION,
        maxSessionSeconds: this.settings.maxSessionSeconds,
        ...(trace === null
          ? {}
          : {
              diagnosticTrace: this.voiceTrace!.disclosureFor(
                principal.companyId,
                principal.userId,
              )!,
            }),
      } as const;
      if (parsed.value.speechDelivery === 'openai-native-webrtc-v1') {
        return ok({
          ...bootstrap,
          ...agentMissionBinding,
          speechDelivery: 'openai-native-webrtc-v1',
        });
      }
      if (speechSourcePolicy === null) throw new Error('speech_source_policy_missing');
      return ok({
        ...bootstrap,
        ...agentMissionBinding,
        ...(parsed.value.wireContract === 'v4'
          ? { speechDelivery: 'audited-signed-url-v1' as const }
          : {}),
        speechSourcePolicy,
      });
    } catch (error) {
      const errorClass = providerErrorClass(error);
      const traceFailure = traceProviderFailure(errorClass);
      trace?.record({
        eventKind: 'provider_failed',
        stage: traceFailure.stage,
        outcome: signal?.aborted ? 'aborted' : 'failed',
        failureClass: traceFailure.failureClass,
      });
      const providerTermination = error instanceof RealtimeProviderCallCompensatedError
        ? 'confirmed'
        : error instanceof RealtimeProviderCleanupError
          ? 'unconfirmed'
          : 'not_attempted';
      await this.cleanupFailedBootstrap(
        lease,
        registeredProviderCallId ?? created?.callId ?? null,
        lifecycle,
        providerTermination,
      );
      if (error instanceof RealtimeProviderCleanupError) {
        this.metrics.bobLiveProviderErrors.inc({ class: `orphan_${error.cleanupErrorClass}` });
      }
      this.metrics.bobLiveProviderErrors.inc({ class: errorClass });
      this.logger.warn(`bob.live.bootstrap.failed class=${errorClass}`, 'BobLive');
      return this.finishError('provider_error', startedAt, {
        kind: 'dependency',
        port: 'openai-realtime',
        cause: errorClass,
      });
    }
  }

  async requestResumeTicket(
    sessionHandle: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Result<RealtimeVoiceResumeTicket, AppError>> {
    if (!isMistralConversationSessionHandle(sessionHandle)) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          issues: [{ field: 'sessionHandle', message: 'Session de reprise invalide.' }],
        },
      };
    }
    const parsed = parseRealtimeResumeTicketBody(body);
    if (!parsed.ok) return parsed;
    const principal = getPrincipal();
    if (!principal?.userId || !principal.companyId) {
      return { ok: false, error: appForbidden('Session utilisateur et espace de travail requis.') };
    }
    if (
      !this.settings.enabled
      || this.settings.provider !== 'mistral'
      || !this.settings.safetySecret
      || signal.aborted
    ) return { ok: false, error: appUnavailable('bob-live-mistral-resume', 5) };

    const subjectBindings = realtimeSubjectBindings(
      this.settings,
      principal.companyId,
      principal.userId,
    );
    if (!subjectBindings) {
      return { ok: false, error: appUnavailable('bob-live-mistral-resume', 5) };
    }
    const issued = await this.conversationResume.issue({
      companyId: principal.companyId,
      ...subjectBindings,
      sessionHandle,
      clientAcceptedMissionConnectionEpoch: parsed.value.missionConnectionEpoch,
      resumeNextServerSequence: parsed.value.nextServerSequence,
      signal,
    });
    if (issued.status === 'terminal_complete') {
      const receipt = issued.receipt;
      if (
        !isMistralConversationTerminalReceipt(receipt)
        || receipt.companyId !== principal.companyId
        || receipt.sessionHandle !== sessionHandle
        || receipt.protocol !== MISTRAL_CONVERSATION_PROTOCOL
        || receipt.missionConnectionEpoch < parsed.value.missionConnectionEpoch
        || receipt.nextServerSequence < parsed.value.nextServerSequence
        || (
          receipt.missionConnectionEpoch > parsed.value.missionConnectionEpoch
          && receipt.nextServerSequence <= parsed.value.nextServerSequence
        )
      ) return { ok: false, error: appUnavailable('bob-live-mistral-resume', 5) };
      this.logger.audit('bob.live.mistral.resume.terminal_complete', { sessionHandle });
      return ok({
        status: 'terminal_complete',
        companyId: receipt.companyId,
        sessionHandle: receipt.sessionHandle,
        protocol: receipt.protocol,
        missionConnectionEpoch: receipt.missionConnectionEpoch,
        nextServerSequence: receipt.nextServerSequence,
        reason: receipt.reason,
        closedAt: receipt.closedAt,
      });
    }
    if (issued.status === 'issued') {
      const bootstrap = issued.bootstrap;
      if (
        bootstrap.companyId !== principal.companyId
        || bootstrap.sessionHandle !== sessionHandle
        || bootstrap.protocol !== MISTRAL_CONVERSATION_PROTOCOL
        || bootstrap.scope !== 'terminal_replay'
        || bootstrap.clientAcceptedMissionConnectionEpoch
          !== parsed.value.missionConnectionEpoch
        || bootstrap.resumeNextServerSequence !== parsed.value.nextServerSequence
      ) return { ok: false, error: appUnavailable('bob-live-mistral-resume', 5) };
      this.logger.audit('bob.live.mistral.resume.ticket_issued', {
        sessionHandle,
        scope: bootstrap.scope,
      });
      return ok({
        status: 'issued',
        websocketUrl: this.settings.mistralWebsocketUrl,
        ...bootstrap,
        scope: 'terminal_replay',
      });
    }
    if (issued.status === 'not_found' || issued.status === 'forbidden') {
      return { ok: false, error: appNotFound('realtime_session', sessionHandle) };
    }
    if (
      issued.status === 'expired'
      || issued.status === 'stale_epoch'
      || issued.status === 'invalid_cursor'
      || issued.status === 'history_unavailable'
    ) {
      return {
        ok: false,
        error: appConflict('realtime_session_resume', `Reprise impossible (${issued.status}).`),
      };
    }
    if (issued.status === 'invalid') {
      return {
        ok: false,
        error: {
          kind: 'validation',
          issues: [{ field: 'resume', message: 'Demande de reprise invalide.' }],
        },
      };
    }
    return { ok: false, error: appUnavailable('bob-live-mistral-resume', 5) };
  }

  async reconcileInitialBootstrap(
    sessionHandle: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Result<RealtimeVoiceBootstrapReconciliation, AppError>> {
    if (!isMistralConversationSessionHandle(sessionHandle)) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          issues: [{ field: 'sessionHandle', message: 'Session de réconciliation invalide.' }],
        },
      };
    }
    const parsed = parseRealtimeBootstrapReconciliationBody(body);
    if (!parsed.ok) return parsed;
    const principal = getPrincipal();
    if (!principal?.userId || !principal.companyId) {
      return { ok: false, error: appForbidden('Session utilisateur et espace de travail requis.') };
    }
    if (
      !this.settings.enabled
      || this.settings.provider !== 'mistral'
      || !this.settings.safetySecret
      || this.conversationRuntime?.liveTurnsAvailable !== true
      || signal.aborted
    ) return { ok: false, error: appUnavailable('bob-live-mistral-reconciliation', 5) };

    let reconciled: Awaited<
      ReturnType<MistralConversationResumeAuthority['reconcileInitialBootstrap']>
    >;
    try {
      reconciled = await this.conversationResume.reconcileInitialBootstrap({
        companyId: principal.companyId,
        userId: principal.userId,
        sessionHandle,
        protocol: parsed.value.protocol,
        bootstrapTicket: parsed.value.bootstrapTicket,
        attempt: parsed.value.attempt,
        signal,
      });
    } catch {
      this.logger.warn(
        'bob.live.mistral.bootstrap_reconciliation.failed class=authority_exception',
        'BobLive',
      );
      return { ok: false, error: appUnavailable('bob-live-mistral-reconciliation', 5) };
    }
    if (signal.aborted) {
      return { ok: false, error: appUnavailable('bob-live-mistral-reconciliation', 5) };
    }

    if (reconciled.status === 'retry_initial' || reconciled.status === 'attempt_consumed') {
      this.logger.audit('bob.live.mistral.bootstrap_reconciliation.completed', {
        sessionHandle,
        attempt: parsed.value.attempt,
        status: reconciled.status,
      });
      return ok({ status: reconciled.status });
    }
    if (reconciled.status === 'issued') {
      const bootstrap = reconciled.bootstrap;
      if (
        bootstrap.companyId !== principal.companyId
        || bootstrap.sessionHandle !== sessionHandle
        || bootstrap.protocol !== MISTRAL_CONVERSATION_PROTOCOL
        || (bootstrap.scope !== 'live_takeover' && bootstrap.scope !== 'terminal_replay')
        || !isCanonicalMistralConversationResumeTicket(bootstrap.ticket)
        || !isCanonicalRealtimeIsoTimestamp(bootstrap.ticketExpiresAt)
        || !Number.isSafeInteger(bootstrap.expectedMissionConnectionEpoch)
        || Object.is(bootstrap.expectedMissionConnectionEpoch, -0)
        || bootstrap.expectedMissionConnectionEpoch < 1
        || bootstrap.expectedMissionConnectionEpoch > MISTRAL_CONVERSATION_MAX_EPOCH
        || bootstrap.clientAcceptedMissionConnectionEpoch !== 0
        || bootstrap.resumeNextServerSequence !== 0
      ) {
        this.logger.warn(
          'bob.live.mistral.bootstrap_reconciliation.failed class=invalid_authority_result',
          'BobLive',
        );
        return { ok: false, error: appUnavailable('bob-live-mistral-reconciliation', 5) };
      }
      this.logger.audit('bob.live.mistral.bootstrap_reconciliation.completed', {
        sessionHandle,
        attempt: parsed.value.attempt,
        status: 'issued',
        scope: bootstrap.scope,
      });
      return ok({
        status: 'issued',
        websocketUrl: this.settings.mistralWebsocketUrl,
        companyId: bootstrap.companyId,
        sessionHandle: bootstrap.sessionHandle,
        ticket: bootstrap.ticket,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        scope: bootstrap.scope,
        ticketExpiresAt: bootstrap.ticketExpiresAt,
        expectedMissionConnectionEpoch: bootstrap.expectedMissionConnectionEpoch,
        clientAcceptedMissionConnectionEpoch: 0,
        resumeNextServerSequence: 0,
      });
    }
    if (reconciled.status === 'not_found' || reconciled.status === 'forbidden') {
      return { ok: false, error: appNotFound('realtime_session', sessionHandle) };
    }
    if (reconciled.status === 'expired') {
      return {
        ok: false,
        error: appConflict(
          'realtime_session_bootstrap_reconciliation',
          'La fenêtre de réconciliation est expirée.',
        ),
      };
    }
    if (reconciled.status === 'invalid') {
      return {
        ok: false,
        error: {
          kind: 'validation',
          issues: [{ field: 'reconciliation', message: 'Demande de réconciliation invalide.' }],
        },
      };
    }
    return { ok: false, error: appUnavailable('bob-live-mistral-reconciliation', 5) };
  }

  async hangup(
    sessionHandle: string,
    diagnosticBody?: unknown,
  ): Promise<Result<{ ended: true }, AppError>> {
    const principal = getPrincipal();
    if (!principal?.userId || !principal.companyId || !this.settings.safetySecret) {
      return { ok: false, error: appForbidden('Session utilisateur et espace de travail requis.') };
    }
    if (!isRealtimeSessionId(sessionHandle)) {
      return {
        ok: false,
        error: { kind: 'validation', issues: [{ field: 'sessionHandle', message: 'Identifiant de session invalide.' }] },
      };
    }
    // Android/OkHttp conserve parfois `content-type: application/json` sur un DELETE sans
    // payload ; express.json matérialise alors le corps historique en `{}`. Cet objet vide exact
    // signifie « ancien client sans diagnostic », jamais un diagnostic permissif.
    const diagnosticAbsent = diagnosticBody === undefined
      || (
        typeof diagnosticBody === 'object'
        && diagnosticBody !== null
        && !Array.isArray(diagnosticBody)
        && Object.keys(diagnosticBody).length === 0
      );
    const clientDiagnostic = diagnosticAbsent
      ? null
      : parseRealtimeVoiceClientTerminationDiagnostic(diagnosticBody);
    if (!diagnosticAbsent && clientDiagnostic === null) {
      return {
        ok: false,
        error: {
          kind: 'validation',
          issues: [{
            field: 'diagnostic',
            message: 'Le diagnostic terminal Bob Live est invalide.',
          }],
        },
      };
    }

    const lookup = admissionSessionLookup(
      this.settings,
      principal.companyId,
      principal.userId,
      sessionHandle,
    );
    if (lookup === null) {
      return { ok: false, error: appUnavailable('bob-live-admission-identity', 60) };
    }

    const termination = await this.admission.claimTermination(lookup);
    if (!termination.ok) return { ok: false, error: appUnavailable('bob-live-admission', 10) };
    // Le fence durable précède toute fermeture process-local : un bootstrap concurrent, y
    // compris sur une autre réplique, doit perdre la course avant que l’UI puisse croire la
    // session terminée. Ce détachement ne touche ni provider ni lease : le claim ci-dessus est
    // désormais leur unique propriétaire.
    let detachedTermination: ReturnType<RealtimeSidebandControl['fenceAndDetachSession']> =
      'not_found';
    try {
      const sidebandCloseReason = clientDiagnostic === null
        ? 'user'
        : clientDiagnostic.terminationSource;
      detachedTermination = this.sideband.fenceAndDetachSession({
        userId: principal.userId,
        companyId: principal.companyId,
        sessionHandle,
        reason: sidebandCloseReason,
      });
    } catch {
      // Une autre réplique ou le reaper durable reprend ci-dessous.
    }
    if (!termination.claim) {
      if (termination.pending) {
        if (detachedTermination !== 'not_found') {
          // Un claim détenu par une autre réplique n'est pas un échec fournisseur observé.
          // Laisser la trace sans terminal vaut mieux qu'inventer un diagnostic ou un hangup.
          detachedTermination.settle('unconfirmed');
        }
        this.metrics.bobLiveProviderErrors.inc({ class: 'explicit_hangup_pending_reaper' });
        return { ok: false, error: appUnavailable('bob-live-hangup', 10) };
      }
      if (detachedTermination !== 'not_found') detachedTermination.settle('confirmed');
      return ok({ ended: true });
    }
    // Seul le claim atomique non nul prouve qu'une session de ce principal existait et que
    // cette requête possède sa terminaison. Un UUID inconnu ou un replay ne doit jamais pouvoir
    // fabriquer une fausse preuve client dans le journal d'audit.
    if (clientDiagnostic !== null) {
      this.logger.audit('bob.live.client.termination', {
        sessionHandle,
        ...clientDiagnostic,
      });
    }

    try {
      await this.providerTerminations.hangupCall({
        companyId: termination.claim.companyId,
        subjectHash: termination.claim.subjectHash,
        sessionId: termination.claim.sessionId,
        providerId: termination.claim.providerId,
        providerCallId: termination.claim.providerCallId,
        reaperToken: termination.claim.reaperToken,
        reaperLeaseExpiresAt: termination.claim.reaperLeaseExpiresAt,
        terminationCause: 'explicit_hangup',
        hardExpiryProof: termination.claim.hardExpiryProof,
      });
    } catch {
      if (detachedTermination !== 'not_found') {
        detachedTermination.settle('provider_failed');
      }
      this.metrics.bobLiveProviderErrors.inc({ class: 'explicit_hangup_pending_reaper' });
      return { ok: false, error: appUnavailable('bob-live-hangup', 10) };
    }
    if (detachedTermination !== 'not_found') detachedTermination.settle('confirmed');
    const completed = await this.admission.completeReaping({
      companyId: termination.claim.companyId,
      subjectHash: termination.claim.subjectHash,
      sessionId: termination.claim.sessionId,
      reaperToken: termination.claim.reaperToken,
    });
    return completed.ok
      ? ok({ ended: true })
      : { ok: false, error: appUnavailable('bob-live-admission', 10) };
  }

  async updateContext(
    sessionHandle: string,
    body: unknown,
  ): Promise<Result<{ revision: number; contextDigest: string }, AppError>> {
    const principal = getPrincipal();
    if (!principal?.userId || !principal.companyId || !this.settings.safetySecret) {
      return { ok: false, error: appForbidden('Session utilisateur et espace de travail requis.') };
    }
    if (!isRealtimeSessionId(sessionHandle)) {
      return { ok: false, error: { kind: 'validation', issues: [{ field: 'sessionHandle', message: 'Identifiant de session invalide.' }] } };
    }
    const parsed = parseRealtimeContextBody(body);
    if (!parsed.ok) return parsed;
    const prepared = prepareRealtimeContext(parsed.value);
    if (!prepared) {
      return {
        ok: false,
        error: { kind: 'validation', issues: [{ field: 'context', message: 'Contexte écran invalide ou trop volumineux.' }] },
      };
    }
    const lookup = admissionSessionLookup(
      this.settings,
      principal.companyId,
      principal.userId,
      sessionHandle,
    );
    if (lookup === null) {
      return { ok: false, error: appUnavailable('bob-live-admission-identity', 60) };
    }
    const resolved = await this.admission.resolveSession(lookup);
    if (!resolved.ok) {
      return { ok: false, error: appUnavailable('bob-live-admission', 5) };
    }
    if (resolved.identity === null) {
      return { ok: false, error: appNotFound('realtime_session', 'redacted') };
    }
    const result = await this.admission.updateContext({
      ...resolved.identity,
      ...parsed.value,
    });
    if (result.ok) {
      if (this.settings.provider === 'openai') {
        let application: Awaited<ReturnType<RealtimeSidebandControl['contextChanged']>>;
        try {
          application = await this.sideband.contextChanged({
            userId: principal.userId,
            companyId: principal.companyId,
            sessionHandle,
            revision: result.revision,
            digest: prepared.digest,
          });
        } catch {
          this.metrics.bobLiveContextUpdates.inc({ outcome: 'unavailable' });
          this.logger.warn(
            'bob.live.context.application.failed class=sideband_exception',
            'BobLive',
          );
          return {
            ok: false,
            error: appUnavailable('bob-live-context-application', 1),
          };
        }
        if (application.status === 'superseded') {
          this.metrics.bobLiveContextUpdates.inc({ outcome: 'conflict' });
          return {
            ok: false,
            error: appConflict(
              'realtime_context',
              'Le contexte écran a changé. Republie l’état courant.',
            ),
          };
        }
        if (
          application.status !== 'applied'
          || application.revision !== result.revision
          || application.digest !== prepared.digest
        ) {
          this.metrics.bobLiveContextUpdates.inc({ outcome: 'unavailable' });
          this.logger.warn(
            `bob.live.context.application.failed class=${
              application.status === 'applied' ? 'invalid_ack' : application.status
            }`,
            'BobLive',
          );
          return {
            ok: false,
            error: appUnavailable('bob-live-context-application', 1),
          };
        }
      }
      this.metrics.bobLiveContextUpdates.inc({ outcome: 'ok' });
      // Le digest est calculé par la même autorité que le sideband. Le mobile le conserve
      // seulement comme fence de fraîcheur. En OpenAI, cet ACK prouve aussi que le propriétaire
      // sideband a appliqué exactement cette révision ; en Mistral, le transport WSS fournit
      // ensuite son propre ACK d'application avant l'ouverture du microphone.
      return ok({ revision: result.revision, contextDigest: prepared.digest });
    }
    if (result.reason === 'stale' || result.reason === 'conflict') {
      this.metrics.bobLiveContextUpdates.inc({ outcome: result.reason });
      return { ok: false, error: appConflict('realtime_context', 'Le contexte écran a changé. Republie l’état courant.') };
    }
    if (result.reason === 'rejected' || result.reason === 'expired') {
      this.metrics.bobLiveContextUpdates.inc({ outcome: result.reason });
      return { ok: false, error: appNotFound('realtime_session', 'redacted') };
    }
    this.metrics.bobLiveContextUpdates.inc({ outcome: 'unavailable' });
    return { ok: false, error: appUnavailable('bob-live-context', 5) };
  }

  async acknowledgeControl(
    sessionHandle: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeApprovedAgentControl & { readonly acknowledgementId: string }, AppError>> {
    const principal = getPrincipal();
    if (!principal?.userId || !principal.companyId || !this.settings.safetySecret) {
      return { ok: false, error: appForbidden('Session utilisateur et espace de travail requis.') };
    }
    if (!isRealtimeSessionId(sessionHandle)) {
      return {
        ok: false,
        error: { kind: 'validation', issues: [{ field: 'sessionHandle', message: 'Identifiant de session invalide.' }] },
      };
    }
    const parsed = parseRealtimeControlAcknowledgementBody(body);
    if (!parsed.ok) return parsed;
    const lookup = admissionSessionLookup(
      this.settings,
      principal.companyId,
      principal.userId,
      sessionHandle,
    );
    if (lookup === null) {
      return { ok: false, error: appUnavailable('bob-live-admission-identity', 60) };
    }
    const resolved = await this.admission.resolveSession(lookup);
    if (!resolved.ok) {
      return { ok: false, error: appUnavailable('bob-live-admission', 1) };
    }
    if (resolved.identity === null) {
      return { ok: false, error: appNotFound('realtime_control', 'redacted') };
    }
    let consumed: Awaited<ReturnType<RealtimeDurableControlPort['consume']>>;
    try {
      consumed = await this.controls.consume({
        ...resolved.identity,
        turnId: parsed.value.turnId,
        acknowledgementId: parsed.value.acknowledgementId,
        contextRevision: parsed.value.contextRevision,
        contextDigest: parsed.value.contextDigest,
      });
    } catch {
      return { ok: false, error: appUnavailable('bob-live-control', 1) };
    }
    if (consumed.status === 'unavailable') {
      return { ok: false, error: appUnavailable('bob-live-control', 1) };
    }
    if (consumed.status !== 'approved') {
      return { ok: false, error: appNotFound('realtime_control', 'redacted') };
    }
    const control = safeApprovedControl(consumed.control, parsed.value);
    if (!control) return { ok: false, error: appNotFound('realtime_control', 'redacted') };
    const stillCurrent = await this.isCurrentContextVersion(
      resolved.identity,
      {
        version: 1,
        revision: control.contextRevision,
        digest: control.contextDigest,
      },
      signal,
    );
    return stillCurrent
      ? ok({ ...control, acknowledgementId: parsed.value.acknowledgementId })
      : { ok: false, error: appNotFound('realtime_control', 'redacted') };
  }

  private async isCurrentContextVersion(
    identity: { companyId: string; subjectHash: string; sessionId: string },
    expected: RealtimeAgentContextVersion,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    const read = Promise.resolve()
      .then(() => this.admission.readContext(identity))
      .catch(() => null);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let onAbort: (() => void) | null = null;
    const unavailable = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), REALTIME_CONTROL_CONTEXT_TIMEOUT_MS);
      if (signal) {
        onAbort = () => resolve(null);
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    const current = await Promise.race([read, unavailable]);
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    if (signal?.aborted || !current || !current.ok) return false;
    const version = realtimeAgentContextVersion(current.snapshot);
    return version.version === expected.version
      && version.revision === expected.revision
      && version.digest === expected.digest;
  }

  private async reserveAfterCleanup(input: RealtimeAdmissionReserveInput): Promise<RealtimeAdmissionResult> {
    const first = await this.admission.reserve(input);
    if (first.allowed || !first.reapingClaim) return first;
    try {
      await this.providerTerminations.hangupCall({
        companyId: first.reapingClaim.companyId,
        subjectHash: first.reapingClaim.subjectHash,
        sessionId: first.reapingClaim.sessionId,
        providerId: first.reapingClaim.providerId,
        providerCallId: first.reapingClaim.providerCallId,
        reaperToken: first.reapingClaim.reaperToken,
        reaperLeaseExpiresAt: first.reapingClaim.reaperLeaseExpiresAt,
        terminationCause: 'reservation_recovery',
        hardExpiryProof: first.reapingClaim.hardExpiryProof,
      });
    } catch {
      return first;
    }
    const completed = await this.admission.completeReaping({
      companyId: first.reapingClaim.companyId,
      subjectHash: first.reapingClaim.subjectHash,
      sessionId: first.reapingClaim.sessionId,
      reaperToken: first.reapingClaim.reaperToken,
    });
    return completed.ok
      ? this.admission.reserve(input)
      : { allowed: false, denial: 'unavailable', retryAt: null };
  }

  private async createMistralCall(
    body: unknown,
    startedAt: number,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeCallBootstrap, AppError>> {
    const parsed = parseMistralRealtimeCallBody(body);
    if (!parsed.ok) return this.finishError('validation', startedAt, parsed.error);
    const agentMissionBinding = realtimeAgentMissionBootstrapBinding(
      parsed.value.agentMissionNegotiation,
    );
    const principal = getPrincipal();
    if (!principal?.userId || !principal.companyId) {
      return this.finishError('identity_missing', startedAt, appForbidden('Session utilisateur et espace de travail requis.'));
    }
    if (!this.settings.safetySecret || !this.settings.apiKey) {
      return this.finishError('misconfigured', startedAt, {
        kind: 'dependency',
        port: 'mistral-realtime',
        cause: 'configuration_missing',
      });
    }
    if (
      parsed.value.protocol === MISTRAL_CONVERSATION_PROTOCOL
      && (
        !this.settings.mistralV2InitialBootstrapEnabled
        || this.conversationRuntime?.liveTurnsAvailable !== true
      )
    ) {
      return this.finishError(
        'disabled',
        startedAt,
        appUnavailable('bob-live-mistral-v2-live-runtime', 5),
      );
    }

    let entitlement: Awaited<ReturnType<RealtimeEntitlementPort['check']>>;
    try {
      entitlement = await this.entitlements.check({
        userId: principal.userId,
        companyId: principal.companyId,
      });
    } catch {
      this.metrics.bobLiveEntitlementChecks.inc({ outcome: 'error', plan: 'unknown' });
      return this.finishError(
        'entitlement_unavailable',
        startedAt,
        appUnavailable('bob-live-entitlement', 60),
      );
    }
    if (!entitlement.allowed) {
      this.metrics.bobLiveEntitlementChecks.inc({ outcome: 'denied', plan: entitlement.plan });
      return this.finishError(
        'entitlement_denied',
        startedAt,
        appForbidden('Bob Live nécessite un abonnement compatible.'),
      );
    }
    this.metrics.bobLiveEntitlementChecks.inc({ outcome: 'allowed', plan: entitlement.plan });

    const subjectBindings = realtimeSubjectBindings(
      this.settings,
      principal.companyId,
      principal.userId,
    );
    if (subjectBindings === null) {
      return this.finishError(
        'misconfigured',
        startedAt,
        appUnavailable('bob-live-admission-identity', 60),
      );
    }
    const reserveInput: RealtimeAdmissionReserveInput = {
      companyId: principal.companyId,
      subjectHash: subjectBindings.subjectHash,
      subjectHashCandidates: [
        subjectBindings.subjectHash,
        ...subjectBindings.historicalSubjectBindings.map((binding) => binding.subjectHash),
      ],
      principalBindingHash: agentMissionPrincipalBindingHash(
        principal.companyId,
        principal.userId,
      ),
      agentMissionBinding: null,
      maxSessionSeconds: this.settings.maxSessionSeconds,
      ...(parsed.value.sessionHandle === undefined ? {} : { sessionId: parsed.value.sessionHandle }),
    };
    const admission = await this.reserveAfterCleanup(reserveInput);
    if (!admission.allowed) {
      this.metrics.bobLiveRateLimited.inc({ scope: admission.denial ?? 'unknown' });
      const error = admissionDenial(admission);
      return this.finishError(error.kind, startedAt, error);
    }
    const lease = admission.lease;
    try {
      admittedAgentMissionCapability(
        { capability: null, binding: null },
        admission.agentMissionProof,
      );
    } catch {
      await this.admission.release({
        ...lease,
        providerTermination: 'not_created',
      }).catch(() => undefined);
      return this.finishError(
        'admission_unavailable',
        startedAt,
        appUnavailable('bob-live-agent-mission-admission', 5),
      );
    }
    let speechSourcePolicy: RealtimeSpeechSourcePolicy;
    try {
      if (!this.speechSourcePolicy) throw new Error('speech_source_policy_missing');
      speechSourcePolicy = this.speechSourcePolicy.policyForSession(
        principal.companyId,
        lease.sessionId,
      );
    } catch {
      await this.admission.release({ ...lease, providerTermination: 'not_created' }).catch(() => undefined);
      return this.finishError(
        'speech_unavailable',
        startedAt,
        appUnavailable('bob-live-speech', 5),
      );
    }
    if (signal?.aborted) {
      await this.admission.release({ ...lease, providerTermination: 'not_created' }).catch(() => undefined);
      return this.finishError('aborted', startedAt, appUnavailable('bob-live-bootstrap', 1));
    }

    if (parsed.value.protocol === MISTRAL_CONVERSATION_PROTOCOL) {
      let initial: Awaited<ReturnType<MistralConversationBootstrapTicketAuthority['issue']>>;
      try {
        initial = await this.conversationBootstrap.issue({
          lease,
          userId: principal.userId,
          subjectKeyVersion: this.settings.subjectKeyVersion,
          plan: entitlement.plan,
          contextSchemaVersion: parsed.value.context.version,
          contextRevision: parsed.value.context.revision,
          context: parsed.value.context.context,
        });
      } catch {
        initial = { status: 'unavailable' };
      }
      if (initial.status !== 'issued' || signal?.aborted) {
        await this.admission.release({ ...lease, providerTermination: 'not_created' }).catch(() => undefined);
        const error = initial.status === 'quota'
          ? appRateLimited('Trop de connexions Bob Live.', 60)
          : appUnavailable('bob-live-mistral-v2-bootstrap', 5);
        return this.finishError(error.kind, startedAt, error);
      }
      const bootstrap = initial.bootstrap;
      const elapsedSeconds = (performance.now() - startedAt) / 1_000;
      this.metrics.bobLiveBootstrapRequests.inc({ model: this.settings.model, outcome: 'ok' });
      this.metrics.bobLiveBootstrapDuration.observe(
        { model: this.settings.model, outcome: 'ok' },
        elapsedSeconds,
      );
      this.logger.audit('bob.live.mistral.v2.bootstrap.succeeded', {
        transport: 'mistral-pcm',
        protocol: bootstrap.protocol,
        ms: Math.round(elapsedSeconds * 1_000),
      });
      return ok({
        transport: 'mistral-pcm',
        ...agentMissionBinding,
        websocketUrl: this.settings.mistralWebsocketUrl,
        ...bootstrap,
        model: this.settings.model,
        voice: this.settings.voice,
        configVersion: BOB_REALTIME_CONFIG_VERSION,
        maxSessionSeconds: this.settings.maxSessionSeconds,
        ...(parsed.value.wireContract === 'v4'
          ? { speechDelivery: 'audited-signed-url-v1' as const }
          : {}),
        speechSourcePolicy,
      });
    }

    let issued: Awaited<ReturnType<MistralRealtimeIngressTicketAuthority['issue']>>;
    try {
      issued = await this.mistralTickets.issue({
        ...lease,
        userId: principal.userId,
        subjectKeyVersion: this.settings.subjectKeyVersion,
        plan: entitlement.plan,
        contextSchemaVersion: parsed.value.context.version,
        contextRevision: parsed.value.context.revision,
        context: parsed.value.context.context,
      });
    } catch {
      issued = { ok: false, reason: 'unavailable' };
    }
    if (!issued.ok || signal?.aborted) {
      await this.admission.release({ ...lease, providerTermination: 'not_created' }).catch(() => undefined);
      const error = issued.ok
        ? appUnavailable('bob-live-bootstrap', 1)
        : issued.reason === 'quota'
          ? appRateLimited('Trop de connexions Bob Live.', 60)
          : appUnavailable('mistral-realtime-ingress', 5);
      return this.finishError(error.kind, startedAt, error);
    }

    const elapsedSeconds = (performance.now() - startedAt) / 1_000;
    this.metrics.bobLiveBootstrapRequests.inc({ model: this.settings.model, outcome: 'ok' });
    this.metrics.bobLiveBootstrapDuration.observe({ model: this.settings.model, outcome: 'ok' }, elapsedSeconds);
    this.logger.audit('bob.live.bootstrap.succeeded', {
      model: this.settings.model,
      transport: 'mistral-pcm',
      ms: Math.round(elapsedSeconds * 1_000),
    });
    return ok({
      transport: 'mistral-pcm',
      ...agentMissionBinding,
      websocketUrl: this.settings.mistralWebsocketUrl,
      companyId: issued.bootstrap.companyId,
      ticket: issued.bootstrap.ticket,
      protocol: issued.bootstrap.protocol,
      ticketExpiresAt: issued.bootstrap.ticketExpiresAt,
      maxAudioBytes: issued.bootstrap.maxAudioBytes,
      contextRevision: issued.bootstrap.contextRevision,
      contextDigest: issued.bootstrap.contextDigest,
      sessionHandle: issued.bootstrap.sessionId,
      hardExpiresAt: issued.bootstrap.hardExpiresAt,
      model: this.settings.model,
      voice: this.settings.voice,
      configVersion: BOB_REALTIME_CONFIG_VERSION,
      maxSessionSeconds: this.settings.maxSessionSeconds,
      ...(parsed.value.wireContract === 'v4'
        ? { speechDelivery: 'audited-signed-url-v1' as const }
        : {}),
      speechSourcePolicy,
    });
  }

  private async cleanupFailedBootstrap(
    lease: RealtimeAdmissionLease,
    providerCallId: string | null,
    lifecycle: RealtimeCallLifecycle | null,
    providerTermination: 'not_attempted' | 'confirmed' | 'unconfirmed',
  ): Promise<void> {
    if (lifecycle) {
      await lifecycle.terminate('bootstrap_failed');
      return;
    }
    if (providerTermination === 'confirmed') {
      await this.admission.release({ ...lease, providerTermination: 'confirmed' }).catch(() => undefined);
      return;
    }
    if (providerTermination === 'unconfirmed') {
      // L'adapter a déjà épuisé son hangup borné. Ne jamais doubler l'appel ici : si le bind
      // a abouti, le bail durable reste intentionnellement disponible pour le reaper.
      return;
    }
    if (providerCallId === null) {
      await this.admission.release({ ...lease, providerTermination: 'not_created' }).catch(() => undefined);
      return;
    }
    try {
      await this.provider.hangupCall(providerCallId);
    } catch {
      this.metrics.bobLiveProviderErrors.inc({ class: 'orphan_hangup_failed' });
      this.logger.warn('bob.live.provider.error class=orphan_hangup_failed', 'BobLive');
      return;
    }
    await this.admission.release({ ...lease, providerTermination: 'confirmed' }).catch(() => undefined);
  }

  private finishError<T>(outcome: string, startedAt: number, error: AppError): Result<T, AppError> {
    const elapsedSeconds = (performance.now() - startedAt) / 1_000;
    this.metrics.bobLiveBootstrapRequests.inc({ model: this.settings.model, outcome });
    this.metrics.bobLiveBootstrapDuration.observe({ model: this.settings.model, outcome }, elapsedSeconds);
    return { ok: false, error };
  }
}

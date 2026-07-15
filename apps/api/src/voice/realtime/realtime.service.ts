import { createHmac } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { isAllowedAgentNavigationRoute } from '@bob/ai';
import {
  appConflict,
  appForbidden,
  appNotFound,
  appRateLimited,
  appUnavailable,
  ok,
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
} from './realtime-admission';
import { RealtimeCallLifecycle } from './realtime-call-lifecycle';
import {
  RealtimeProviderCallCompensatedError,
  RealtimeProviderCleanupError,
} from './openai-realtime-call.adapter';
import { buildOpenAiRealtimeSessionConfig } from './realtime-session-config';
import {
  OPENAI_REALTIME_CALL_PROVIDER,
  REALTIME_ADMISSION,
  REALTIME_AGENT_TURN,
  REALTIME_ENTITLEMENT,
  REALTIME_DURABLE_CONTROLS,
  REALTIME_PROVIDER_TERMINATION_REGISTRY,
  MISTRAL_REALTIME_INGRESS_TICKETS,
  REALTIME_SIDEBAND,
  REALTIME_VOICE_SETTINGS,
  REALTIME_SPEECH_SOURCE_POLICY,
} from './realtime.tokens';
import {
  realtimeAgentContextVersion,
  type RealtimeAgentContextVersion,
  type RealtimeAgentTurnPort,
} from './realtime-agent-turn';
import {
  BOB_REALTIME_CONFIG_VERSION,
  type OpenAiRealtimeCallProvider,
  type RealtimeCallBootstrap,
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

const MAX_OFFER_SDP_CHARS = 64 * 1024;
const REALTIME_CONTROL_CONTEXT_TIMEOUT_MS = 1_000;
const REALTIME_TURN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REALTIME_CONTEXT_DIGEST = /^[a-f0-9]{64}$/;

export function safetyIdentifier(secret: string, userId: string): string {
  const digest = createHmac('sha256', secret)
    .update(`bob-pro:openai-safety:v1:${userId}`, 'utf8')
    .digest('base64url');
  return `bob_${digest}`;
}

export function parseRealtimeCallBody(
  body: unknown,
): Result<{ sdp: string; sessionHandle?: string }, AppError> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'body', message: 'Corps JSON objet requis.' }] } };
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'sdp' && key !== 'sessionHandle')) {
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
  return ok({ sdp, ...(sessionHandle === undefined ? {} : { sessionHandle }) });
}

export function parseMistralRealtimeCallBody(
  body: unknown,
): Result<{
  sessionHandle?: string;
  context: { version: 1; revision: number; context: unknown };
}, AppError> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'body', message: 'Corps JSON objet requis.' }] } };
  }
  const record = body as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== 'sessionHandle' && key !== 'context')
    || !Object.hasOwn(record, 'context')
  ) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'body', message: 'Champ non autorisé ou contexte absent.' }] } };
  }
  const context = parseRealtimeContextBody(record.context);
  if (!context.ok) return context;
  const sessionHandle = record.sessionHandle;
  if (sessionHandle !== undefined && (typeof sessionHandle !== 'string' || !isRealtimeSessionId(sessionHandle))) {
    return {
      ok: false,
      error: { kind: 'validation', issues: [{ field: 'sessionHandle', message: 'Identifiant de session invalide.' }] },
    };
  }
  return ok({
    context: context.value,
    ...(sessionHandle === undefined ? {} : { sessionHandle }),
  });
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

export function admissionSubjectHash(secret: string, companyId: string, userId: string): string {
  return createHmac('sha256', secret)
    .update('bob-pro:realtime-admission:v1\u0000', 'utf8')
    .update(companyId, 'utf8')
    .update('\u0000', 'utf8')
    .update(userId, 'utf8')
    .digest('hex');
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
    'sideband_superseded',
    'sideband_unknown',
    'bootstrap_aborted',
    'realtime_admission_bind_rejected',
    'realtime_admission_bind_expired',
    'realtime_admission_bind_unavailable',
  ]);
  return allowed.has(value) ? value : 'provider_unknown';
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
    return {
      available,
      ...(availabilityReason === undefined ? {} : { availabilityReason }),
      transport: this.settings.provider === 'mistral' ? 'mistral-pcm' : 'webrtc',
      model: this.settings.model,
      voice: this.settings.voice,
      configVersion: BOB_REALTIME_CONFIG_VERSION,
      requiresDevelopmentBuild: true,
      maxSessionSeconds: this.settings.maxSessionSeconds,
      speechDelivery: 'audited-signed-url-v1',
    };
  }

  async createCall(body: unknown, signal?: AbortSignal): Promise<Result<RealtimeCallBootstrap, AppError>> {
    const startedAt = performance.now();
    if (!this.settings.enabled) return this.finishError('disabled', startedAt, appForbidden('Bob Live est désactivé.'));
    if (this.settings.provider === 'mistral') {
      return this.createMistralCall(body, startedAt, signal);
    }
    const parsed = parseRealtimeCallBody(body);
    if (!parsed.ok) return this.finishError('validation', startedAt, parsed.error);

    const principal = getPrincipal();
    if (!principal?.userId || !principal.companyId) {
      return this.finishError('identity_missing', startedAt, appForbidden('Session utilisateur et espace de travail requis.'));
    }
    if (!this.settings.safetySecret || !this.settings.apiKey) {
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

    const reserveInput: RealtimeAdmissionReserveInput = {
      companyId: principal.companyId,
      subjectHash: admissionSubjectHash(this.settings.safetySecret, principal.companyId, principal.userId),
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
    let created: Awaited<ReturnType<OpenAiRealtimeCallProvider['createCall']>> | null = null;
    let registeredProviderCallId: string | null = null;
    let lifecycle: RealtimeCallLifecycle | null = null;
    try {
      if (signal?.aborted) throw new Error('bootstrap_aborted');
      const session = buildOpenAiRealtimeSessionConfig(this.settings);
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
        session,
        lifecycle,
        turn: {
          run: async ({ transcript, history, signal: turnSignal }) => {
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
              userId: principal.userId,
              companyId: principal.companyId!,
              transcript,
              history,
              ...(stored.snapshot?.context === undefined ? {} : { context: stored.snapshot.context }),
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
      const elapsedSeconds = (performance.now() - startedAt) / 1_000;
      this.metrics.bobLiveBootstrapRequests.inc({ model: this.settings.model, outcome: 'ok' });
      this.metrics.bobLiveBootstrapDuration.observe({ model: this.settings.model, outcome: 'ok' }, elapsedSeconds);
      this.logger.audit('bob.live.bootstrap.succeeded', {
        model: this.settings.model,
        transport: 'webrtc',
        ms: Math.round(elapsedSeconds * 1_000),
      });
      return ok({
        transport: 'webrtc',
        answerSdp: created.answerSdp,
        sessionHandle: lease.sessionId,
        hardExpiresAt: lease.hardExpiresAt,
        model: this.settings.model,
        voice: this.settings.voice,
        configVersion: BOB_REALTIME_CONFIG_VERSION,
        maxSessionSeconds: this.settings.maxSessionSeconds,
        speechSourcePolicy,
      });
    } catch (error) {
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
      const errorClass = providerErrorClass(error);
      this.metrics.bobLiveProviderErrors.inc({ class: errorClass });
      this.logger.warn(`bob.live.bootstrap.failed class=${errorClass}`, 'BobLive');
      return this.finishError('provider_error', startedAt, {
        kind: 'dependency',
        port: 'openai-realtime',
        cause: errorClass,
      });
    }
  }

  async hangup(sessionHandle: string): Promise<Result<{ ended: true }, AppError>> {
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

    try {
      const local = await this.sideband.closeSession({
        userId: principal.userId,
        companyId: principal.companyId,
        sessionHandle,
      });
      if (local === 'confirmed') return ok({ ended: true });
      if (local === 'pending_reaper') {
        this.metrics.bobLiveProviderErrors.inc({ class: 'explicit_hangup_pending_reaper' });
        return { ok: false, error: appUnavailable('bob-live-hangup', 10) };
      }
    } catch {
      // Une autre réplique ou le reaper durable reprend ci-dessous.
    }

    const subjectHash = admissionSubjectHash(this.settings.safetySecret, principal.companyId, principal.userId);
    const termination = await this.admission.claimTermination({
      companyId: principal.companyId,
      subjectHash,
      sessionId: sessionHandle,
    });
    if (!termination.ok) return { ok: false, error: appUnavailable('bob-live-admission', 10) };
    if (!termination.claim) {
      return termination.pending
        ? { ok: false, error: appUnavailable('bob-live-hangup', 10) }
        : ok({ ended: true });
    }

    try {
      await this.providerTerminations.hangupCall({
        companyId: termination.claim.companyId,
        subjectHash: termination.claim.subjectHash,
        sessionId: termination.claim.sessionId,
        providerId: termination.claim.providerId,
        providerCallId: termination.claim.providerCallId,
        hardExpiryProof: termination.claim.hardExpiryProof,
      });
    } catch {
      this.metrics.bobLiveProviderErrors.inc({ class: 'explicit_hangup_pending_reaper' });
      return { ok: false, error: appUnavailable('bob-live-hangup', 10) };
    }
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
    const result = await this.admission.updateContext({
      companyId: principal.companyId,
      subjectHash: admissionSubjectHash(this.settings.safetySecret, principal.companyId, principal.userId),
      sessionId: sessionHandle,
      ...parsed.value,
    });
    if (result.ok) {
      this.metrics.bobLiveContextUpdates.inc({ outcome: 'ok' });
      const contextVersion = realtimeAgentContextVersion(prepared.snapshot);
      this.sideband.contextChanged({
        userId: principal.userId,
        companyId: principal.companyId,
        sessionHandle,
        revision: result.revision,
        digest: contextVersion.digest,
      });
      // Le digest est calculé par la même autorité que le sideband. Le mobile le conserve
      // seulement comme fence de fraîcheur ; il ne tente jamais de réimplémenter la
      // canonicalisation serveur du contexte.
      return ok({ revision: result.revision, contextDigest: contextVersion.digest });
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
    let consumed: Awaited<ReturnType<RealtimeDurableControlPort['consume']>>;
    try {
      consumed = await this.controls.consume({
        companyId: principal.companyId,
        subjectHash: admissionSubjectHash(
          this.settings.safetySecret,
          principal.companyId,
          principal.userId,
        ),
        sessionId: sessionHandle,
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
      {
        companyId: principal.companyId,
        subjectHash: admissionSubjectHash(this.settings.safetySecret, principal.companyId, principal.userId),
        sessionId: sessionHandle,
      },
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

    const reserveInput: RealtimeAdmissionReserveInput = {
      companyId: principal.companyId,
      subjectHash: admissionSubjectHash(
        this.settings.safetySecret,
        principal.companyId,
        principal.userId,
      ),
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

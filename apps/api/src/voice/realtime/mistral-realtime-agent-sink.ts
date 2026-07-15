import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AgentContext } from '@bob/ai';
import type { PlanTier } from '@bob/core';
import type { MistralRealtimeTranscriptionSink } from './mistral-realtime-gateway';
import {
  prepareRealtimeContext,
  type RealtimeAdmissionPort,
  type RealtimeContextSnapshot,
} from './realtime-admission';
import {
  realtimeAgentContextVersion,
  type RealtimeAgentContextVersion,
  type RealtimeAgentTurnPort,
} from './realtime-agent-turn';
import {
  isRealtimeSidebandOwnerIdentity,
  type RealtimeSidebandOwnerIdentity,
  type RealtimeSidebandOwnerPort,
} from './realtime-sideband-owner';
import type { RealtimeSpeechPublisher } from './realtime-speech-publisher';
import type { RealtimeVoiceUsageWriterPort } from './realtime-voice-usage';
import type { RealtimeDurableControlAuthority } from './realtime-control';
import type { RealtimeSpeechDeliveryRepositoryPort } from './realtime-speech-delivery.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const LANGUAGE = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8}){0,3}$/u;
const PLANS = new Set<PlanTier>(['free', 'solo', 'pro', 'business']);
const POSTGRES_INT_MAX = 2_147_483_647;
const MAX_TRANSCRIPT_CHARS = 4_000;
const MAX_TRANSCRIPT_UTF8_BYTES = 12_000;
const DEFAULT_OWNER_LEASE_SECONDS = 300;
const DEFAULT_MAX_TRACKED_REDEMPTIONS = 1_024;
const USAGE_SOURCE = 'mistral.voxtral.realtime.stt';

export type MistralRealtimeAgentSinkErrorCode =
  | 'aborted'
  | 'invalid_input'
  | 'capacity_exceeded'
  | 'owner_unavailable'
  | 'identity_drift'
  | 'context_unavailable'
  | 'context_drift'
  | 'usage_unavailable'
  | 'turn_unavailable'
  | 'speech_unavailable'
  | 'control_unavailable';

/** Erreur opaque : elle ne contient jamais de transcript, d'identité ni de détail fournisseur. */
export class MistralRealtimeAgentSinkError extends Error {
  constructor(readonly code: MistralRealtimeAgentSinkErrorCode) {
    super(code);
    this.name = 'MistralRealtimeAgentSinkError';
  }
}

export interface MistralRealtimeAgentSinkEntropy {
  /** 256 bits minimum en production ; la valeur brute n'est jamais persistée. */
  ownerInstanceToken(): string;
  /** Token distinct par redemption, transformé en SHA-256 avant le port durable. */
  ownerToken(): string;
  /** Identité idempotente d'une annulation fail-closed après échec du seal. */
  cancellationId(): string;
}

export interface MistralRealtimeAgentSinkDependencies {
  readonly admission: Pick<RealtimeAdmissionPort, 'readContext'>;
  readonly owners: RealtimeSidebandOwnerPort;
  readonly agentTurns: RealtimeAgentTurnPort;
  readonly speech: Pick<RealtimeSpeechPublisher, 'publish'>;
  readonly controls: Pick<RealtimeDurableControlAuthority, 'issue'>;
  readonly cancellation: Pick<RealtimeSpeechDeliveryRepositoryPort, 'cancel'>;
  /** Obligatoire : une session Mistral ne peut jamais exécuter le cerveau sans registre durable. */
  readonly usage: RealtimeVoiceUsageWriterPort;
  readonly entropy?: MistralRealtimeAgentSinkEntropy;
  readonly ownerLeaseSeconds?: number;
  readonly maxTrackedRedemptions?: number;
}

interface TrackedRedemption {
  readonly fingerprint: string;
  readonly promise: Promise<void>;
  state: 'running' | 'completed';
}

type SinkInput = Parameters<MistralRealtimeTranscriptionSink['publish']>[0];
type FinalSinkInput = Extract<SinkInput, { readonly event: { readonly type: 'transcript_final' } }>;

interface AuthoritativeContext {
  readonly context: AgentContext;
  readonly agentVersion: RealtimeAgentContextVersion;
}

const secureEntropy: MistralRealtimeAgentSinkEntropy = Object.freeze({
  ownerInstanceToken: () => randomBytes(32).toString('base64url'),
  ownerToken: () => randomBytes(32).toString('base64url'),
  cancellationId: randomUUID,
});

function safeTokenHash(token: string, purpose: 'instance' | 'owner'): string | null {
  if (
    typeof token !== 'string'
    || Buffer.byteLength(token, 'utf8') < 32
    || Buffer.byteLength(token, 'utf8') > 256
    // eslint-disable-next-line no-control-regex
    || /[\u0000-\u001f\u007f]/u.test(token)
  ) return null;
  return createHash('sha256')
    .update(`bob-pro:mistral-realtime-agent-owner:${purpose}:v1\u0000`, 'utf8')
    .update(token, 'utf8')
    .digest('hex');
}

function validVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= POSTGRES_INT_MAX;
}

function validUserId(value: string): boolean {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 256
    && Buffer.byteLength(value, 'utf8') <= 512
    // eslint-disable-next-line no-control-regex
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function normalizeTranscript(value: string): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized.length >= 1
    && normalized.length <= MAX_TRANSCRIPT_CHARS
    && Buffer.byteLength(normalized, 'utf8') <= MAX_TRANSCRIPT_UTF8_BYTES
    ? normalized
    : null;
}

function validFinalInput(input: FinalSinkInput): boolean {
  const usage = input.event.usage;
  const occurredAt = Date.parse(input.occurredAt);
  return UUID.test(input.redemptionId)
    && COMPANY_ID.test(input.companyId)
    && validUserId(input.userId)
    && SHA256_HEX.test(input.subjectHash)
    && validVersion(input.subjectKeyVersion)
    && PLANS.has(input.plan)
    && UUID.test(input.sessionId)
    && validVersion(input.contextRevision)
    && SHA256_HEX.test(input.contextDigest)
    && input.event.type === 'transcript_final'
    && (input.event.language === null || LANGUAGE.test(input.event.language))
    && (usage.inputAudioSeconds === null || (
      Number.isSafeInteger(usage.inputAudioSeconds)
      && usage.inputAudioSeconds >= 0
      && usage.inputAudioSeconds <= 86_400
    ))
    && Number.isSafeInteger(usage.totalTokens)
    && usage.totalTokens >= 0
    && usage.totalTokens <= 10_000_000
    && Number.isFinite(occurredAt)
    && new Date(occurredAt).toISOString() === input.occurredAt
    && input.signal instanceof AbortSignal;
}

function sameAgentContextVersion(
  left: RealtimeAgentContextVersion,
  right: RealtimeAgentContextVersion,
): boolean {
  return left.version === right.version
    && left.revision === right.revision
    && left.digest === right.digest;
}

function sameDurableContext(
  actual: { readonly revision: number; readonly digest: string } | null,
  input: Pick<FinalSinkInput, 'contextRevision' | 'contextDigest'>,
): boolean {
  return actual?.revision === input.contextRevision && actual.digest === input.contextDigest;
}

function assertNotAborted(...signals: readonly AbortSignal[]): void {
  if (signals.some((signal) => signal.aborted)) {
    throw new MistralRealtimeAgentSinkError('aborted');
  }
}

function redemptionFingerprint(input: FinalSinkInput, transcript: string): string {
  return createHash('sha256').update(JSON.stringify([
    'bob-pro:mistral-realtime-agent-redemption:v1',
    input.redemptionId.toLowerCase(),
    input.companyId,
    input.userId,
    input.subjectHash,
    input.subjectKeyVersion,
    input.plan,
    input.sessionId.toLowerCase(),
    input.contextRevision,
    input.contextDigest,
    transcript,
    input.event.language,
    input.event.usage.inputAudioSeconds,
    input.event.usage.totalTokens,
    input.occurredAt,
  ]), 'utf8').digest('hex');
}

/**
 * Pont Mistral -> cerveau métier -> parole auditée.
 *
 * `redemptionId` est l'identité one-shot durable du ticket. Il sert volontairement de `turnId`
 * acoustique : un retry exact retrouve le même artefact sans créer une seconde parole. Les
 * deltas/segments restent de l'UX de transcription et ne peuvent jamais déclencher le cerveau.
 */
export class MistralRealtimeAgentSink implements MistralRealtimeTranscriptionSink {
  private readonly ownerInstanceHash: string;
  private readonly entropy: MistralRealtimeAgentSinkEntropy;
  private readonly ownerLeaseSeconds: number;
  private readonly maxTrackedRedemptions: number;
  private readonly tracked = new Map<string, TrackedRedemption>();

  constructor(private readonly dependencies: MistralRealtimeAgentSinkDependencies) {
    if (!dependencies.usage || typeof dependencies.usage.record !== 'function') {
      throw new Error('Mistral realtime usage writer is required.');
    }
    if (!dependencies.controls || typeof dependencies.controls.issue !== 'function') {
      throw new Error('Mistral realtime durable control authority is required.');
    }
    if (!dependencies.cancellation || typeof dependencies.cancellation.cancel !== 'function') {
      throw new Error('Mistral realtime speech cancellation is required.');
    }
    this.entropy = dependencies.entropy ?? secureEntropy;
    const instanceHash = safeTokenHash(this.entropy.ownerInstanceToken(), 'instance');
    if (!instanceHash) throw new Error('Invalid Mistral realtime agent sink entropy.');
    this.ownerInstanceHash = instanceHash;
    this.ownerLeaseSeconds = dependencies.ownerLeaseSeconds ?? DEFAULT_OWNER_LEASE_SECONDS;
    this.maxTrackedRedemptions = dependencies.maxTrackedRedemptions
      ?? DEFAULT_MAX_TRACKED_REDEMPTIONS;
    if (
      !Number.isSafeInteger(this.ownerLeaseSeconds)
      || this.ownerLeaseSeconds < 5
      || this.ownerLeaseSeconds > 300
      || !Number.isSafeInteger(this.maxTrackedRedemptions)
      || this.maxTrackedRedemptions < 1
      || this.maxTrackedRedemptions > 100_000
    ) throw new Error('Invalid Mistral realtime agent sink configuration.');
  }

  publish(input: Parameters<MistralRealtimeTranscriptionSink['publish']>[0]): Promise<void> {
    if (input.event.type !== 'transcript_final') return Promise.resolve();
    const finalInput = input as FinalSinkInput;
    const transcript = normalizeTranscript(finalInput.event.text);
    if (!validFinalInput(finalInput) || transcript === null) {
      return Promise.reject(new MistralRealtimeAgentSinkError('invalid_input'));
    }
    if (finalInput.signal.aborted) {
      return Promise.reject(new MistralRealtimeAgentSinkError('aborted'));
    }

    const key = finalInput.redemptionId.toLowerCase();
    const fingerprint = redemptionFingerprint(finalInput, transcript);
    const existing = this.tracked.get(key);
    if (existing) {
      return existing.fingerprint === fingerprint
        ? existing.promise
        : Promise.reject(new MistralRealtimeAgentSinkError('identity_drift'));
    }
    this.makeCapacity();
    if (this.tracked.size >= this.maxTrackedRedemptions) {
      return Promise.reject(new MistralRealtimeAgentSinkError('capacity_exceeded'));
    }

    const promise = this.processFinal(finalInput, transcript);
    const tracked: TrackedRedemption = { fingerprint, promise, state: 'running' };
    this.tracked.set(key, tracked);
    void promise.then(
      () => { tracked.state = 'completed'; },
      () => {
        if (this.tracked.get(key) === tracked) this.tracked.delete(key);
      },
    );
    return promise;
  }

  private makeCapacity(): void {
    if (this.tracked.size < this.maxTrackedRedemptions) return;
    for (const [key, tracked] of this.tracked) {
      if (tracked.state === 'completed') {
        this.tracked.delete(key);
        return;
      }
    }
  }

  private async processFinal(input: FinalSinkInput, transcript: string): Promise<void> {
    let owner: RealtimeSidebandOwnerIdentity | null = null;
    let retainForDelivery = false;
    try {
      assertNotAborted(input.signal);
      await this.recordUsage(input);
      assertNotAborted(input.signal);
      const candidateOwnerTokenHash = safeTokenHash(this.entropy.ownerToken(), 'owner');
      if (!candidateOwnerTokenHash) {
        throw new MistralRealtimeAgentSinkError('owner_unavailable');
      }
      const acquired = await this.dependencies.owners.acquire({
        companyId: input.companyId,
        sessionId: input.sessionId,
        ownerInstanceHash: this.ownerInstanceHash,
        candidateOwnerTokenHash,
        leaseSeconds: this.ownerLeaseSeconds,
      });
      assertNotAborted(input.signal);
      if (acquired.status !== 'acquired') {
        throw new MistralRealtimeAgentSinkError('owner_unavailable');
      }
      owner = acquired.owner;
      if (
        !isRealtimeSidebandOwnerIdentity(owner)
        || owner.companyId !== input.companyId
        || owner.subjectHash !== input.subjectHash
        || owner.sessionId.toLowerCase() !== input.sessionId.toLowerCase()
        || owner.ownerInstanceHash !== this.ownerInstanceHash
        || owner.ownerTokenHash !== candidateOwnerTokenHash
      ) throw new MistralRealtimeAgentSinkError('identity_drift');
      if (!sameDurableContext(acquired.currentContext, input)) {
        throw new MistralRealtimeAgentSinkError('context_drift');
      }

      const applied = await this.dependencies.owners.applyContext(owner, {
        revision: input.contextRevision,
        digest: input.contextDigest,
      });
      assertNotAborted(input.signal);
      if (applied.status !== 'applied') {
        throw new MistralRealtimeAgentSinkError(
          applied.status === 'stale_context' ? 'context_drift' : 'context_unavailable',
        );
      }
      const authoritative = await this.readAuthoritativeContext(input, owner, input.signal);

      let outcome: Awaited<ReturnType<RealtimeAgentTurnPort['run']>>;
      try {
        outcome = await this.dependencies.agentTurns.run({
          userId: input.userId,
          companyId: input.companyId,
          transcript,
          history: [],
          context: authoritative.context,
          contextFence: {
            expected: authoritative.agentVersion,
            revalidate: async (signal) => (
              await this.readAuthoritativeContext(input, owner!, signal, input.signal)
            ).agentVersion,
          },
          signal: input.signal,
        });
      } catch {
        assertNotAborted(input.signal);
        throw new MistralRealtimeAgentSinkError('turn_unavailable');
      }
      assertNotAborted(input.signal);
      if (outcome.status === 'aborted') {
        throw new MistralRealtimeAgentSinkError('aborted');
      }
      if (
        outcome.status === 'ready'
        && !sameAgentContextVersion(outcome.contextVersion, authoritative.agentVersion)
      ) throw new MistralRealtimeAgentSinkError('context_drift');

      // Fence explicite entre le cerveau et la première des quatre fences du publisher.
      await this.readAuthoritativeContext(input, owner, input.signal);
      let published: Awaited<ReturnType<RealtimeSpeechPublisher['publish']>>;
      try {
        published = await this.dependencies.speech.publish({
          companyId: input.companyId,
          subjectHash: input.subjectHash,
          sessionId: input.sessionId,
          // Stable par construction : un ticket one-shot possède un unique redemptionId UUID.
          turnId: input.redemptionId,
          segmentIndex: 0,
          canonicalSpeech: outcome.canonicalSpeech,
          contextRevision: input.contextRevision,
          contextDigest: input.contextDigest,
          sidebandOwnerTokenHash: owner.ownerTokenHash,
          signal: input.signal,
          abortReason: 'session_end',
          revalidateContext: async (signal) => {
            await this.readAuthoritativeContext(input, owner!, signal, input.signal);
            return {
              contextRevision: input.contextRevision,
              contextDigest: input.contextDigest,
            };
          },
        });
      } catch {
        assertNotAborted(input.signal);
        throw new MistralRealtimeAgentSinkError('speech_unavailable');
      }
      assertNotAborted(input.signal);
      if (published.status !== 'ready' && published.status !== 'already_ready') {
        throw new MistralRealtimeAgentSinkError(
          published.status === 'aborted' ? 'aborted' : 'speech_unavailable',
        );
      }
      if (outcome.status === 'ready') {
        let control;
        try {
          control = await this.dependencies.controls.issue({
            companyId: input.companyId,
            subjectHash: input.subjectHash,
            sessionId: input.sessionId,
            // Le contrat acoustique Mistral est one-shot : redemptionId est le seul turn public.
            turnId: input.redemptionId,
            artifactId: published.artifactId,
            contextRevision: input.contextRevision,
            contextDigest: input.contextDigest,
            sidebandOwnerEpoch: owner.ownerEpoch,
            sidebandOwnerTokenHash: owner.ownerTokenHash,
            kind: outcome.kind,
            ...(outcome.navigate === undefined ? {} : { navigate: outcome.navigate }),
            ...(outcome.proposalId === undefined ? {} : { proposalId: outcome.proposalId }),
            ...(outcome.proposalExpiresAt === undefined
              ? {}
              : { proposalExpiresAt: outcome.proposalExpiresAt }),
          });
        } catch {
          control = { status: 'unavailable' as const };
        }
        if (
          control.status !== 'not_required'
          && control.status !== 'issued'
          && control.status !== 'already_issued'
        ) {
          await this.cancelUnsafeArtifact(input, published.artifactId);
          throw new MistralRealtimeAgentSinkError('control_unavailable');
        }
      }
      // L'ACK mobile reste à venir : libérer ici invaliderait durablement l'artefact ready.
      retainForDelivery = true;
    } finally {
      if (owner && !retainForDelivery) {
        await this.dependencies.owners.release(owner).catch(() => undefined);
      }
    }
  }

  private async cancelUnsafeArtifact(
    input: FinalSinkInput,
    artifactId: string,
  ): Promise<void> {
    const cancellationId = this.entropy.cancellationId();
    if (!UUID.test(cancellationId)) return;
    try {
      await this.dependencies.cancellation.cancel({
        companyId: input.companyId,
        subjectHash: input.subjectHash,
        sessionId: input.sessionId,
        turnId: input.redemptionId,
        artifactId,
        cancellationId: cancellationId.toLowerCase(),
        reason: 'session_end',
      });
    } catch {
      // La libération de l'owner dans finally invalide aussi l'artefact si ce cleanup échoue.
    }
  }

  private async recordUsage(input: FinalSinkInput): Promise<void> {
    const common = {
      companyId: input.companyId,
      subjectHash: input.subjectHash,
      subjectKeyVersion: input.subjectKeyVersion,
      sessionId: input.sessionId,
      turnId: input.redemptionId,
      plan: input.plan,
      source: USAGE_SOURCE,
      // La portée est opaque, stable et ne contient ni transcript ni identifiant provider.
      dedupeScope: `mistral-transcript-final:${input.redemptionId.toLowerCase()}`,
      occurredAt: input.occurredAt,
    } as const;
    const measures = [
      ...(input.event.usage.inputAudioSeconds === null ? [] : [{
        kind: 'stt_seconds' as const,
        amount: input.event.usage.inputAudioSeconds,
      }]),
      {
        kind: 'realtime_tokens_in' as const,
        amount: input.event.usage.totalTokens,
      },
    ];
    for (const measure of measures) {
      let result: Awaited<ReturnType<RealtimeVoiceUsageWriterPort['record']>>;
      try {
        result = await this.dependencies.usage.record({ ...common, ...measure });
      } catch {
        throw new MistralRealtimeAgentSinkError('usage_unavailable');
      }
      if (result.status !== 'recorded' && result.status !== 'duplicate') {
        throw new MistralRealtimeAgentSinkError('usage_unavailable');
      }
    }
  }

  private async readAuthoritativeContext(
    input: FinalSinkInput,
    owner: RealtimeSidebandOwnerIdentity,
    signal: AbortSignal,
    sessionSignal: AbortSignal = signal,
  ): Promise<AuthoritativeContext> {
    assertNotAborted(signal, sessionSignal);
    const current = await this.dependencies.owners.readCurrentContext(owner);
    assertNotAborted(signal, sessionSignal);
    if (current.status !== 'current') {
      throw new MistralRealtimeAgentSinkError('context_unavailable');
    }
    if (!sameDurableContext(current.context, input)) {
      throw new MistralRealtimeAgentSinkError('context_drift');
    }

    const read = await this.dependencies.admission.readContext({
      companyId: input.companyId,
      subjectHash: input.subjectHash,
      sessionId: input.sessionId,
    });
    assertNotAborted(signal, sessionSignal);
    if (!read.ok || read.snapshot === null) {
      throw new MistralRealtimeAgentSinkError('context_unavailable');
    }
    this.assertSnapshotMatches(input, read.snapshot);
    return {
      context: read.snapshot.context,
      agentVersion: realtimeAgentContextVersion(read.snapshot),
    };
  }

  private assertSnapshotMatches(input: FinalSinkInput, snapshot: RealtimeContextSnapshot): void {
    const prepared = prepareRealtimeContext({
      version: snapshot.version,
      revision: snapshot.revision,
      context: snapshot.context,
    });
    if (
      !prepared
      || prepared.snapshot.revision !== input.contextRevision
      || prepared.digest !== input.contextDigest
    ) throw new MistralRealtimeAgentSinkError('context_drift');
  }
}

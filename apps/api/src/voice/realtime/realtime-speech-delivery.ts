import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  appConflict,
  appForbidden,
  appNotFound,
  appUnavailable,
  ok,
  type AppError,
  type Result,
} from '@bob/core';
import { getPrincipal, type AppLogger } from '../../observability/logger';
import { admissionSubjectHash } from './realtime.service';
import type { RealtimeSpeechCancellationReason } from './realtime-speech-publisher';
import {
  buildRealtimeSpeechStorageKey,
  type RealtimeSpeechStoragePort,
} from './realtime-speech-storage';
import type {
  RealtimeSpeechDeliveryArtifact,
  RealtimeSpeechDeliveryRepositoryPort,
} from './realtime-speech-delivery.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const POSTGRES_INT_MAX = 2_147_483_647;
const MAX_WAIT_MS = 2_500;
const DEFAULT_WAIT_MS = MAX_WAIT_MS;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_SIGNED_URL_TTL_SECONDS = 15;
const CANCELLATION_REASONS = new Set<RealtimeSpeechCancellationReason>([
  'barge_in',
  'user_cancel',
  'context_changed',
  'session_end',
  'superseded',
  'playback_error',
]);

export interface RealtimeSpeechDeliveryConfig {
  readonly enabled: boolean;
  readonly subjectHmacSecret: string | null;
  readonly proofSecret: string | null;
  readonly proofKeyVersion: number;
  readonly signedUrlTtlSeconds?: number;
  readonly pollIntervalMs?: number;
}

export interface RealtimeSpeechBindingResponse {
  readonly artifactId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly contextRevision: number;
  readonly contextDigest: string;
}

export type RealtimeSpeechFeedResponse =
  | { readonly status: 'none' }
  | ({ readonly status: 'rendering' } & RealtimeSpeechBindingResponse)
  | ({
      readonly status: 'ready';
      readonly audioUrl: string;
      readonly audioSha256: string;
      readonly mimeType: 'audio/mpeg' | 'audio/wav';
      readonly byteSize: number;
      readonly durationMs: number;
    } & RealtimeSpeechBindingResponse)
  | ({
      readonly status: 'terminal';
      readonly reason: 'cancelled' | 'failed' | 'expired' | 'delivered';
    } & RealtimeSpeechBindingResponse);

export interface RealtimeSpeechDeliveryAcknowledgement {
  readonly controlReference?: {
    readonly turnId: string;
    readonly acknowledgementId: string;
    readonly contextRevision: number;
    readonly contextDigest: string;
  };
}

export function parseRealtimeSpeechFeedQuery(
  query: unknown,
): Result<{ afterSequence: number; waitMs: number }, AppError> {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) {
    return validation('query', 'Paramètres de feed Bob Live requis.');
  }
  const record = query as Record<string, unknown>;
  const allowed = new Set(['afterSequence', 'waitMs']);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    return validation('query', 'Paramètre de feed Bob Live non autorisé.');
  }
  const afterSequence = parseCanonicalInteger(record.afterSequence, 0, POSTGRES_INT_MAX);
  const waitMs = record.waitMs === undefined
    ? DEFAULT_WAIT_MS
    : parseCanonicalInteger(record.waitMs, 0, MAX_WAIT_MS);
  if (afterSequence === null) {
    return validation('afterSequence', 'La séquence Bob Live doit être un entier canonique.');
  }
  if (waitMs === null) {
    return validation('waitMs', 'Le long-poll Bob Live doit être compris entre 0 et 2500 ms.');
  }
  return ok({ afterSequence, waitMs });
}

export function parseRealtimeSpeechDeliveryBody(
  body: unknown,
): Result<{ deliveryId: string; audioSha256: string }, AppError> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return validation('body', 'Acquittement de livraison Bob Live requis.');
  }
  const record = body as Record<string, unknown>;
  if (!hasExactKeys(record, ['deliveryId', 'audioSha256'])
    || typeof record.deliveryId !== 'string'
    || !UUID.test(record.deliveryId)
    || typeof record.audioSha256 !== 'string'
    || !SHA256_HEX.test(record.audioSha256)) {
    return validation('body', 'Acquittement de livraison Bob Live invalide.');
  }
  return ok({ deliveryId: record.deliveryId.toLowerCase(), audioSha256: record.audioSha256 });
}

export function parseRealtimeSpeechCancellationBody(
  body: unknown,
): Result<{ cancellationId: string; reason: RealtimeSpeechCancellationReason }, AppError> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return validation('body', 'Annulation vocale Bob Live requise.');
  }
  const record = body as Record<string, unknown>;
  if (!hasExactKeys(record, ['cancellationId', 'reason'])
    || typeof record.cancellationId !== 'string'
    || !UUID.test(record.cancellationId)
    || typeof record.reason !== 'string'
    || !CANCELLATION_REASONS.has(record.reason as RealtimeSpeechCancellationReason)) {
    return validation('body', 'Annulation vocale Bob Live invalide.');
  }
  return ok({
    cancellationId: record.cancellationId.toLowerCase(),
    reason: record.reason as RealtimeSpeechCancellationReason,
  });
}

function validation(field: string, message: string): Result<never, AppError> {
  return { ok: false, error: { kind: 'validation', issues: [{ field, message }] } };
}

function parseCanonicalInteger(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function proofMac(secret: string, values: readonly (string | number | null)[]): string {
  const mac = createHmac('sha256', secret);
  mac.update('bob-pro:realtime-speech:evidence:v1', 'utf8');
  for (const value of values) {
    mac.update('\u0000', 'utf8');
    mac.update(value === null ? '-' : String(value), 'utf8');
  }
  return mac.digest('hex');
}

function constantTimeHexEqual(expected: string, actual: string): boolean {
  if (!SHA256_HEX.test(expected) || !SHA256_HEX.test(actual)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

/** Vérifie la preuve acoustique persistée sans avoir besoin de conserver le texte canonique. */
export function verifyRealtimeSpeechDeliveryProof(
  artifact: RealtimeSpeechDeliveryArtifact,
  config: Pick<RealtimeSpeechDeliveryConfig, 'proofSecret' | 'proofKeyVersion'>,
): boolean {
  const proofSecret = config.proofSecret;
  if (!proofSecret
    || Buffer.byteLength(proofSecret, 'utf8') < 32
    || artifact.proofKeyVersion !== config.proofKeyVersion
    || !Number.isSafeInteger(artifact.proofKeyVersion)
    || !COMPANY_ID.test(artifact.companyId)
    || !UUID.test(artifact.sessionId)
    || !UUID.test(artifact.turnId)
    || !UUID.test(artifact.artifactId)
    || !Number.isSafeInteger(artifact.sequence)
    || artifact.sequence < 1
    || artifact.sequence > POSTGRES_INT_MAX
    || !Number.isSafeInteger(artifact.contextRevision)
    || artifact.contextRevision < 1
    || artifact.contextRevision > POSTGRES_INT_MAX
    || !SHA256_HEX.test(artifact.subjectHash)
    || !SHA256_HEX.test(artifact.contextDigest)
    || !SHA256_HEX.test(artifact.canonicalSpeechHmac)
    || !SHA256_HEX.test(artifact.factsHmac)
    || artifact.evidenceHmac === null
    || !SHA256_HEX.test(artifact.evidenceHmac)
    || artifact.audioSha256 === null
    || !SHA256_HEX.test(artifact.audioSha256)
    || artifact.storageKey === null
    || artifact.storageExpiresAt === null
    || Number.isNaN(artifact.storageExpiresAt.getTime())
    || artifact.storageExpiresAt.getTime() <= artifact.databaseNow.getTime()
    || artifact.objectPurgedAt !== null
    || artifact.mimeType === null
    || artifact.byteLength === null
    || !Number.isSafeInteger(artifact.byteLength)
    || artifact.byteLength < 256
    || artifact.byteLength > 2 * 1024 * 1024
    || artifact.durationMs === null
    || !Number.isSafeInteger(artifact.durationMs)
    || artifact.durationMs < 100
    || artifact.durationMs > 45_000
    || artifact.synthesisAdapterId === null
    || !SAFE_ID.test(artifact.synthesisAdapterId)
    || artifact.synthesisTrustDomain === null
    || !SAFE_ID.test(artifact.synthesisTrustDomain)) return false;

  let expectedStorageKey: string;
  try {
    expectedStorageKey = buildRealtimeSpeechStorageKey({
      companyId: artifact.companyId,
      sessionId: artifact.sessionId.toLowerCase(),
      turnId: artifact.turnId.toLowerCase(),
      artifactId: artifact.artifactId.toLowerCase(),
    });
  } catch {
    return false;
  }
  if (artifact.storageKey !== expectedStorageKey) return false;

  if (artifact.source === 'preapproved_static') {
    if (artifact.classification !== 'fixed_safe'
      || artifact.auditTranscriptHmac !== null
      || artifact.auditAdapterId !== null
      || artifact.auditTrustDomain !== null) return false;
  } else if (artifact.source === 'synthesized_audited') {
    if (artifact.auditTranscriptHmac === null
      || !SHA256_HEX.test(artifact.auditTranscriptHmac)
      || artifact.auditAdapterId === null
      || !SAFE_ID.test(artifact.auditAdapterId)
      || artifact.auditTrustDomain === null
      || !SAFE_ID.test(artifact.auditTrustDomain)
      || artifact.auditTrustDomain === artifact.synthesisTrustDomain) return false;
  } else {
    return false;
  }

  const expectedEvidence = proofMac(proofSecret, [
    artifact.proofKeyVersion,
    artifact.companyId,
    artifact.subjectHash,
    artifact.sessionId.toLowerCase(),
    artifact.turnId.toLowerCase(),
    artifact.artifactId.toLowerCase(),
    artifact.sequence,
    artifact.contextRevision,
    artifact.contextDigest,
    artifact.classification,
    artifact.source,
    artifact.storageKey,
    artifact.canonicalSpeechHmac,
    artifact.factsHmac,
    artifact.auditTranscriptHmac,
    artifact.audioSha256,
    artifact.mimeType,
    artifact.byteLength,
    artifact.durationMs,
    artifact.synthesisAdapterId,
    artifact.synthesisTrustDomain,
    artifact.auditAdapterId,
    artifact.auditTrustDomain,
  ]);
  return constantTimeHexEqual(expectedEvidence, artifact.evidenceHmac);
}

function binding(artifact: RealtimeSpeechDeliveryArtifact): RealtimeSpeechBindingResponse {
  return {
    artifactId: artifact.artifactId,
    turnId: artifact.turnId,
    sequence: artifact.sequence,
    contextRevision: artifact.contextRevision,
    contextDigest: artifact.contextDigest,
  };
}

function validPathIds(sessionId: string, turnId?: string, artifactId?: string): boolean {
  return UUID.test(sessionId)
    && (turnId === undefined || UUID.test(turnId))
    && (artifactId === undefined || UUID.test(artifactId));
}

function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    const abort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class RealtimeSpeechDeliveryService {
  private readonly signedUrlTtlSeconds: number;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly repository: RealtimeSpeechDeliveryRepositoryPort,
    private readonly storage: RealtimeSpeechStoragePort | null,
    private readonly config: RealtimeSpeechDeliveryConfig,
    private readonly logger?: Pick<AppLogger, 'warn' | 'audit'>,
  ) {
    this.signedUrlTtlSeconds = config.signedUrlTtlSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(this.signedUrlTtlSeconds)
      || this.signedUrlTtlSeconds < 1
      || this.signedUrlTtlSeconds > 30
      || !Number.isSafeInteger(this.pollIntervalMs)
      || this.pollIntervalMs < 25
      || this.pollIntervalMs > 500) {
      throw new Error('Invalid realtime speech delivery configuration.');
    }
  }

  async next(
    sessionHandle: string,
    query: unknown,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeSpeechFeedResponse, AppError>> {
    const identity = this.identity(sessionHandle);
    if (!identity.ok) return identity;
    const parsed = parseRealtimeSpeechFeedQuery(query);
    if (!parsed.ok) return parsed;
    if (!this.ready()) return { ok: false, error: appUnavailable('bob-live-speech', 5) };

    const deadline = performance.now() + parsed.value.waitMs;
    do {
      if (signal?.aborted) return { ok: false, error: appUnavailable('bob-live-speech', 1) };
      const read = await this.repository.readNext({
        ...identity.value,
        afterSequence: parsed.value.afterSequence,
      });
      if (read.status === 'unavailable') {
        return { ok: false, error: appUnavailable('bob-live-speech', 1) };
      }
      if (read.status === 'found') return this.feedForArtifact(read.artifact, signal);
      const remaining = deadline - performance.now();
      if (remaining <= 0) return ok({ status: 'none' });
      await pause(Math.min(this.pollIntervalMs, Math.ceil(remaining)), signal);
    } while (!signal?.aborted);
    return { ok: false, error: appUnavailable('bob-live-speech', 1) };
  }

  async acknowledgeDelivery(
    sessionHandle: string,
    turnId: string,
    artifactId: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeSpeechDeliveryAcknowledgement, AppError>> {
    const identity = this.identity(sessionHandle, turnId, artifactId);
    if (!identity.ok) return identity;
    const parsed = parseRealtimeSpeechDeliveryBody(body);
    if (!parsed.ok) return parsed;
    if (!this.ready() || signal?.aborted) {
      return { ok: false, error: appUnavailable('bob-live-speech', 1) };
    }
    const read = await this.repository.readExact({ ...identity.value, turnId, artifactId });
    if (read.status === 'unavailable') {
      return { ok: false, error: appUnavailable('bob-live-speech', 1) };
    }
    if (read.status === 'none') {
      return { ok: false, error: appNotFound('realtime_speech', 'redacted') };
    }
    const artifact = read.artifact;
    if (!verifyRealtimeSpeechDeliveryProof(artifact, this.config)
      || artifact.audioSha256 !== parsed.value.audioSha256
      || artifact.storageKey === null
      || artifact.evidenceHmac === null) {
      this.logger?.warn('bob.live.speech.delivery_rejected class=proof_invalid', 'BobLive');
      return { ok: false, error: appNotFound('realtime_speech', 'redacted') };
    }
    const delivered = await this.repository.acknowledgeDelivery({
      ...identity.value,
      turnId,
      artifactId,
      version: artifact.version,
      evidenceHmac: artifact.evidenceHmac,
      audioSha256: artifact.audioSha256,
      storageKey: artifact.storageKey,
      deliveryId: parsed.value.deliveryId,
    });
    if (delivered.status === 'not_found') {
      return { ok: false, error: appNotFound('realtime_speech', 'redacted') };
    }
    if (delivered.status === 'terminal' || delivered.status === 'conflict') {
      return { ok: false, error: appConflict('realtime_speech', 'Livraison vocale déjà terminée.') };
    }
    if (delivered.status === 'unavailable') {
      return { ok: false, error: appUnavailable('bob-live-speech', 1) };
    }
    if (delivered.status !== 'delivered') {
      return { ok: false, error: appUnavailable('bob-live-speech', 1) };
    }
    this.logger?.audit('bob.live.speech.delivered', { idempotent: delivered.idempotent });
    return ok(delivered.controlCurrent
      ? {
          controlReference: {
            turnId,
            acknowledgementId: parsed.value.deliveryId,
            contextRevision: delivered.contextRevision,
            contextDigest: delivered.contextDigest,
          },
        }
      : {});
  }

  async cancel(
    sessionHandle: string,
    turnId: string,
    artifactId: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Result<void, AppError>> {
    const identity = this.identity(sessionHandle, turnId, artifactId);
    if (!identity.ok) return identity;
    const parsed = parseRealtimeSpeechCancellationBody(body);
    if (!parsed.ok) return parsed;
    if (!this.ready() || signal?.aborted) {
      return { ok: false, error: appUnavailable('bob-live-speech', 1) };
    }
    const cancelled = await this.repository.cancel({
      ...identity.value,
      turnId,
      artifactId,
      ...parsed.value,
    });
    if (cancelled.status === 'not_found') {
      return { ok: false, error: appNotFound('realtime_speech', 'redacted') };
    }
    if (cancelled.status === 'terminal' || cancelled.status === 'conflict') {
      return { ok: false, error: appConflict('realtime_speech', 'Segment vocal déjà terminé.') };
    }
    if (cancelled.status === 'unavailable') {
      return { ok: false, error: appUnavailable('bob-live-speech', 1) };
    }
    if (cancelled.status !== 'cancelled') {
      return { ok: false, error: appUnavailable('bob-live-speech', 1) };
    }
    this.logger?.audit('bob.live.speech.cancelled', {
      reason: parsed.value.reason,
      idempotent: cancelled.idempotent,
    });
    return ok(undefined);
  }

  private async feedForArtifact(
    artifact: RealtimeSpeechDeliveryArtifact,
    signal?: AbortSignal,
  ): Promise<Result<RealtimeSpeechFeedResponse, AppError>> {
    const base = binding(artifact);
    if (artifact.state === 'cancelled') return ok({ status: 'terminal', reason: 'cancelled', ...base });
    if (artifact.state === 'failed') return ok({ status: 'terminal', reason: 'failed', ...base });
    if (artifact.state === 'delivered') return ok({ status: 'terminal', reason: 'delivered', ...base });
    if (!artifact.fenceCurrent) return ok({ status: 'terminal', reason: 'expired', ...base });
    if (artifact.state === 'rendering') return ok({ status: 'rendering', ...base });
    if (!verifyRealtimeSpeechDeliveryProof(artifact, this.config)
      || artifact.storageKey === null
      || artifact.storageExpiresAt === null
      || artifact.evidenceHmac === null
      || artifact.audioSha256 === null
      || artifact.mimeType === null
      || artifact.byteLength === null
      || artifact.durationMs === null) {
      this.logger?.warn('bob.live.speech.feed_rejected class=proof_invalid', 'BobLive');
      return { ok: false, error: appUnavailable('bob-live-speech-proof', 1) };
    }
    const remainingSeconds = Math.floor(
      (artifact.storageExpiresAt.getTime() - artifact.databaseNow.getTime()) / 1_000,
    );
    if (remainingSeconds < 1) return ok({ status: 'terminal', reason: 'expired', ...base });
    let signed: Awaited<ReturnType<RealtimeSpeechStoragePort['createSignedDownload']>>;
    try {
      signed = await this.storage!.createSignedDownload({
        companyId: artifact.companyId,
        key: artifact.storageKey,
        ttlSeconds: Math.min(this.signedUrlTtlSeconds, remainingSeconds),
        signal: signal ?? new AbortController().signal,
      });
    } catch {
      return { ok: false, error: appUnavailable('bob-live-speech-storage', 1) };
    }
    if (signal?.aborted) return { ok: false, error: appUnavailable('bob-live-speech', 1) };
    const fence = await this.repository.validateReadyFence({
      companyId: artifact.companyId,
      subjectHash: artifact.subjectHash,
      sessionId: artifact.sessionId,
      turnId: artifact.turnId,
      artifactId: artifact.artifactId,
      version: artifact.version,
      evidenceHmac: artifact.evidenceHmac,
      audioSha256: artifact.audioSha256,
      storageKey: artifact.storageKey,
    });
    if (fence === 'unavailable') return { ok: false, error: appUnavailable('bob-live-speech', 1) };
    if (fence === 'terminal') return ok({ status: 'terminal', reason: 'expired', ...base });
    return ok({
      status: 'ready',
      ...base,
      audioUrl: signed.url,
      audioSha256: artifact.audioSha256,
      mimeType: artifact.mimeType,
      byteSize: artifact.byteLength,
      durationMs: artifact.durationMs,
    });
  }

  private identity(
    sessionHandle: string,
    turnId?: string,
    artifactId?: string,
  ): Result<{ companyId: string; subjectHash: string; sessionId: string }, AppError> {
    if (!validPathIds(sessionHandle, turnId, artifactId)) {
      return validation('path', 'Identifiant vocal Bob Live invalide.');
    }
    const principal = getPrincipal();
    if (!principal?.userId || !principal.companyId || !this.config.subjectHmacSecret) {
      return { ok: false, error: appForbidden('Session utilisateur et espace de travail requis.') };
    }
    return ok({
      companyId: principal.companyId,
      subjectHash: admissionSubjectHash(
        this.config.subjectHmacSecret,
        principal.companyId,
        principal.userId,
      ),
      sessionId: sessionHandle.toLowerCase(),
    });
  }

  private ready(): boolean {
    return this.config.enabled
      && this.storage !== null
      && this.config.subjectHmacSecret !== null
      && this.config.proofSecret !== null;
  }
}

import {
  createCipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  REALTIME_VOICE_TRACE_MAX_ORDINAL,
  realtimeVoiceTraceDigestMaterial,
  validateRealtimeVoiceTraceEvent,
  type RealtimeVoiceTraceEvent,
} from '@bob/core';
import type { ResolvedRealtimeVoiceTraceV2Env } from '../../config/env';
import type { AppLogger } from '../../observability/logger';
import type {
  RealtimeVoiceTraceAppendOutcome,
  RealtimeVoiceTraceAppendStore,
  RealtimeVoiceTraceStoredEvent,
} from './realtime-voice-trace.repository';

const TRACE_QUEUE_CAPACITY = 128;
const TRACE_APPEND_ATTEMPTS = 5;
const TRACE_RETRY_DELAYS_MS = [0, 25, 75, 150, 300] as const;
const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const TRACE_HKDF_SALT = Buffer.from('bob-pro:realtime-voice-trace:v2:hkdf', 'utf8');
const TRACE_ENCRYPTION_INFO = Buffer.from('bob-pro:realtime-voice-trace:v2:aes-256-gcm', 'utf8');
const TRACE_DIGEST_INFO = Buffer.from('bob-pro:realtime-voice-trace:v2:event-digest-hmac', 'utf8');

export type RealtimeVoiceTraceRecordInput = Omit<
  RealtimeVoiceTraceEvent,
  | 'version'
  | 'companyId'
  | 'userId'
  | 'traceAttemptId'
  | 'sessionHandle'
  | 'ownerEpoch'
  | 'eventOrdinal'
  | 'occurredAt'
> & {
  readonly occurredAt?: string;
};

/** Contrat étroit injecté dans la boucle live ; il rend les séquences testables sans stockage. */
export interface RealtimeVoiceTraceRecorder {
  bindSession(sessionHandle: string): boolean;
  bindOwner(ownerEpoch: number): boolean;
  record(input: RealtimeVoiceTraceRecordInput): void;
}

export interface RealtimeVoiceTraceDiagnosticDisclosure {
  readonly enabled: true;
  readonly retentionDays: 30;
  readonly purpose: 'staging_quality';
}

export const REALTIME_VOICE_TRACE_DIAGNOSTIC_DISCLOSURE = Object.freeze({
  enabled: true,
  retentionDays: 30,
  purpose: 'staging_quality',
} as const satisfies RealtimeVoiceTraceDiagnosticDisclosure);

export type RealtimeVoiceTraceIncidentClass =
  | 'append_unavailable'
  | 'circuit_open'
  | 'corrupt_replay'
  | 'event_rejected'
  | 'identity_drift'
  | 'key_unavailable'
  | 'queue_overflow';

interface RealtimeVoiceTraceEntropy {
  readonly eventId: () => string;
  readonly traceAttemptId: () => string;
  readonly nonce: () => Buffer;
}

interface RealtimeVoiceTraceAttemptDependencies {
  readonly append: RealtimeVoiceTraceAppendStore;
  readonly config: ResolvedRealtimeVoiceTraceV2Env;
  readonly logger: Pick<AppLogger, 'error'>;
  readonly clock: () => Date;
  readonly entropy: RealtimeVoiceTraceEntropy;
  readonly queueCapacity: number;
  readonly retryDelaysMs: readonly number[];
}

function traceSubject(companyId: string, userId: string): string {
  return `${companyId}:${userId.toLowerCase()}`;
}

function deriveKey(root: Uint8Array, info: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(root), TRACE_HKDF_SALT, info, 32));
}

function canonicalAad(
  event: RealtimeVoiceTraceEvent,
  eventId: string,
  keyVersion: number,
  field: 'transcript' | 'canonicalReply',
): Buffer {
  return Buffer.from(
    JSON.stringify([
      1,
      eventId,
      event.companyId,
      event.userId,
      event.traceAttemptId,
      event.sessionHandle ?? null,
      event.ownerEpoch,
      event.eventOrdinal,
      event.turnId ?? null,
      event.eventKind,
      event.occurredAt,
      keyVersion,
      field,
    ]),
    'utf8',
  );
}

function encryptText(input: {
  readonly plaintext: string;
  readonly root: Uint8Array;
  readonly version: number;
  readonly aad: Buffer;
  readonly nonce: Buffer;
}): string {
  if (input.nonce.byteLength !== AES_GCM_NONCE_BYTES) {
    throw new Error('Realtime Voice Trace V2 nonce rejected.');
  }
  const cipher = createCipheriv(
    'aes-256-gcm',
    deriveKey(input.root, TRACE_ENCRYPTION_INFO),
    input.nonce,
    {
      authTagLength: AES_GCM_TAG_BYTES,
    },
  );
  cipher.setAAD(input.aad);
  const ciphertext = Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    `v${input.version}`,
    input.nonce.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

function digestForEvent(event: RealtimeVoiceTraceEvent, root: Uint8Array): string {
  return createHmac('sha256', deriveKey(root, TRACE_DIGEST_INFO))
    .update(realtimeVoiceTraceDigestMaterial(event), 'utf8')
    .digest('hex');
}

function sameDigest(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function waitForRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

function closedIncidentMessage(kind: RealtimeVoiceTraceIncidentClass): string {
  return `bob.live.trace.v2.failed class=${kind}`;
}

/**
 * Trace d'une tentative unique. `record` n'attend jamais PostgreSQL et ne lève jamais : la voix
 * reste l'autorité de disponibilité. Une dérive du journal ouvre son propre disjoncteur.
 */
export class RealtimeVoiceTraceAttempt implements RealtimeVoiceTraceRecorder {
  readonly traceAttemptId: string;
  private sessionHandle: string | null = null;
  private ownerEpoch = 0;
  private eventOrdinal = 0;
  private pending = 0;
  private consecutiveFailures = 0;
  private circuitOpen = false;
  private incidentReported = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly companyId: string,
    readonly userId: string,
    private readonly dependencies: RealtimeVoiceTraceAttemptDependencies,
  ) {
    this.traceAttemptId = dependencies.entropy.traceAttemptId().toLowerCase();
  }

  bindSession(sessionHandle: string): boolean {
    const canonical = sessionHandle.toLowerCase();
    if (this.sessionHandle === null) {
      this.sessionHandle = canonical;
      return true;
    }
    if (this.sessionHandle === canonical) return true;
    this.openCircuit('identity_drift');
    return false;
  }

  bindOwner(ownerEpoch: number): boolean {
    if (
      !Number.isSafeInteger(ownerEpoch) ||
      ownerEpoch < 1 ||
      ownerEpoch > REALTIME_VOICE_TRACE_MAX_ORDINAL
    ) {
      this.openCircuit('identity_drift');
      return false;
    }
    if (this.ownerEpoch === 0) {
      this.ownerEpoch = ownerEpoch;
      return true;
    }
    if (this.ownerEpoch === ownerEpoch) return true;
    this.openCircuit('identity_drift');
    return false;
  }

  record(input: RealtimeVoiceTraceRecordInput): void {
    if (this.circuitOpen) return;
    if (this.pending >= this.dependencies.queueCapacity) {
      this.openCircuit('queue_overflow');
      return;
    }
    const eventOrdinal = this.eventOrdinal + 1;
    if (eventOrdinal > REALTIME_VOICE_TRACE_MAX_ORDINAL) {
      this.openCircuit('event_rejected');
      return;
    }
    const event: RealtimeVoiceTraceEvent = {
      ...input,
      version: 1,
      companyId: this.companyId,
      userId: this.userId,
      traceAttemptId: this.traceAttemptId,
      ...(this.sessionHandle === null ? {} : { sessionHandle: this.sessionHandle }),
      ownerEpoch: this.ownerEpoch,
      eventOrdinal,
      occurredAt: input.occurredAt ?? this.dependencies.clock().toISOString(),
    };
    const validated = validateRealtimeVoiceTraceEvent(event);
    if (!validated.ok) {
      this.openCircuit('event_rejected');
      return;
    }
    this.eventOrdinal = eventOrdinal;
    this.pending += 1;
    this.tail = this.tail
      .then(() => this.persist(validated.value))
      .catch(() => this.registerFailure('append_unavailable'))
      .finally(() => {
        this.pending = Math.max(0, this.pending - 1);
      });
  }

  /** Test/arrêt gracieux uniquement ; le chemin voix n'attend jamais ce drain. */
  async drain(): Promise<void> {
    await this.tail;
  }

  private async persist(event: RealtimeVoiceTraceEvent): Promise<void> {
    const currentVersion = this.dependencies.config.currentEncryptionVersion;
    if (currentVersion === null) {
      this.openCircuit('key_unavailable');
      return;
    }
    const root = this.dependencies.config.encryptionSecret(currentVersion);
    if (root === null) {
      this.openCircuit('key_unavailable');
      return;
    }
    const id = this.dependencies.entropy.eventId().toLowerCase();
    const hasPlaintext = event.transcript !== undefined || event.canonicalReply !== undefined;
    const { transcript, canonicalReply, ...plaintextFreeEvent } = event;
    const stored: RealtimeVoiceTraceStoredEvent = {
      id,
      event: plaintextFreeEvent,
      eventDigest: digestForEvent(event, root),
      eventDigestKeyVersion: currentVersion,
      encryptionKeyVersion: hasPlaintext ? currentVersion : null,
      transcriptCiphertext:
        transcript === undefined
          ? null
          : encryptText({
              plaintext: transcript,
              root,
              version: currentVersion,
              aad: canonicalAad(event, id, currentVersion, 'transcript'),
              nonce: this.dependencies.entropy.nonce(),
            }),
      canonicalReplyCiphertext:
        canonicalReply === undefined
          ? null
          : encryptText({
              plaintext: canonicalReply,
              root,
              version: currentVersion,
              aad: canonicalAad(event, id, currentVersion, 'canonicalReply'),
              nonce: this.dependencies.entropy.nonce(),
            }),
    };

    let outcome: RealtimeVoiceTraceAppendOutcome = { status: 'unavailable' };
    for (let attempt = 0; attempt < this.dependencies.retryDelaysMs.length; attempt += 1) {
      await waitForRetry(this.dependencies.retryDelaysMs[attempt] ?? 0);
      try {
        outcome = await this.dependencies.append.append(stored);
      } catch {
        outcome = { status: 'unavailable' };
      }
      if (outcome.status !== 'unavailable') break;
    }
    if (outcome.status === 'unavailable') {
      this.registerFailure('append_unavailable');
      return;
    }
    if (outcome.status === 'existing') {
      const replayRoot = this.dependencies.config.encryptionSecret(outcome.eventDigestKeyVersion);
      if (replayRoot === null) {
        this.openCircuit('key_unavailable');
        return;
      }
      const replayDigest = digestForEvent(event, replayRoot);
      if (!sameDigest(replayDigest, outcome.eventDigest)) {
        this.openCircuit('corrupt_replay');
        return;
      }
    }
    this.consecutiveFailures = 0;
  }

  private registerFailure(kind: RealtimeVoiceTraceIncidentClass): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= TRACE_APPEND_ATTEMPTS) this.openCircuit(kind);
  }

  private openCircuit(kind: RealtimeVoiceTraceIncidentClass): void {
    this.circuitOpen = true;
    if (this.incidentReported) return;
    this.incidentReported = true;
    this.dependencies.logger.error(closedIncidentMessage(kind), undefined, 'BobLiveTraceV2');
  }
}

/** Factory dormante : aucun handle/file/map n'est créé pour un sujet hors allowlist. */
export class RealtimeVoiceTraceFactory {
  private readonly entropy: RealtimeVoiceTraceEntropy;

  constructor(
    private readonly append: RealtimeVoiceTraceAppendStore,
    private readonly config: ResolvedRealtimeVoiceTraceV2Env,
    private readonly logger: Pick<AppLogger, 'error'>,
    private readonly clock: () => Date = () => new Date(),
    entropy?: Partial<RealtimeVoiceTraceEntropy>,
    private readonly queueCapacity = TRACE_QUEUE_CAPACITY,
    private readonly retryDelaysMs: readonly number[] = TRACE_RETRY_DELAYS_MS,
  ) {
    this.entropy = {
      eventId: entropy?.eventId ?? randomUUID,
      traceAttemptId: entropy?.traceAttemptId ?? randomUUID,
      nonce: entropy?.nonce ?? (() => randomBytes(AES_GCM_NONCE_BYTES)),
    };
  }

  isEnabledFor(companyId: string, userId: string): boolean {
    return this.config.enabled && this.config.subjects.has(traceSubject(companyId, userId));
  }

  disclosureFor(companyId: string, userId: string): RealtimeVoiceTraceDiagnosticDisclosure | null {
    return this.isEnabledFor(companyId, userId) ? REALTIME_VOICE_TRACE_DIAGNOSTIC_DISCLOSURE : null;
  }

  begin(companyId: string, userId: string): RealtimeVoiceTraceAttempt | null {
    if (!this.isEnabledFor(companyId, userId)) return null;
    return new RealtimeVoiceTraceAttempt(companyId, userId.toLowerCase(), {
      append: this.append,
      config: this.config,
      logger: this.logger,
      clock: this.clock,
      entropy: this.entropy,
      queueCapacity: this.queueCapacity,
      retryDelaysMs: this.retryDelaysMs,
    });
  }
}

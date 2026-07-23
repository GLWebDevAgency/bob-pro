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
import {
  OPENAI_NATIVE_BARGE_IN_MAX_MS,
  OPENAI_NATIVE_BARGE_IN_MAX_PENDING,
  OPENAI_NATIVE_SPEECH_STOPPED_EVENT_TO_FIRST_INBOUND_RTP_MAX_MS,
  isOpenAiNativeLocalObservation,
  isOpenAiNativeSpeechSlo,
  type OpenAiNativeLocalObservation,
  type OpenAiNativeSpeechSlo,
} from './openai-native-speech-delivery';
import type {
  OpenAiNativeSpeechAuthority,
  OpenAiNativeSpeechMobileAcknowledgementInput,
} from './openai-native-speech-authority';
import { admissionSubjectHash } from './realtime.service';

const POSTGRES_INT_MAX = 2_147_483_647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTEXT_DIGEST = /^[a-f0-9]{64}$/u;
const BODY_KEYS = [
  'acknowledgementId',
  'contextRevision',
  'contextDigest',
  'localObservation',
  'slo',
] as const;
const MAX_SUBJECT_HMAC_KEYS = 32;
const MAX_SUBJECT_HMAC_SECRET_BYTES = 512;

export interface OpenAiNativeSpeechAcknowledgementConfig {
  readonly enabled: boolean;
  readonly subjectHmacKeyRing: {
    readonly currentVersion: number;
    readonly versions: readonly number[];
    secret(version: number): string | null;
  } | null;
}

export interface OpenAiNativeSpeechAcknowledgementPath {
  readonly sessionId: string;
  readonly turnId: string;
  readonly deliveryId: string;
}

export interface OpenAiNativeSpeechAcknowledgementBody {
  readonly acknowledgementId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly localObservation: OpenAiNativeLocalObservation;
  readonly slo: OpenAiNativeSpeechSlo;
}

export interface OpenAiNativeSpeechAcknowledgementReceipt {
  readonly deliveryId: string;
  readonly turnId: string;
  readonly acknowledgementId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly idempotent: boolean;
}

function validation(field: string, message: string): Result<never, AppError> {
  return { ok: false, error: { kind: 'validation', issues: [{ field, message }] } };
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function copyExactSubjectKeyVersions(value: unknown): readonly number[] | null {
  if (!Array.isArray(value)) return null;
  const length = value.length;
  if (length < 1 || length > MAX_SUBJECT_HMAC_KEYS) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== length + 1
    || !ownKeys.includes('length')
    || Array.from({ length }, (_, index) => String(index))
      .some((key) => !ownKeys.includes(key))
  ) return null;

  const copy: number[] = [];
  for (let index = 0; index < length; index += 1) {
    const version = value[index];
    if (
      !Number.isSafeInteger(version)
      || Object.is(version, -0)
      || (version as number) < 1
      || (version as number) > POSTGRES_INT_MAX
    ) return null;
    copy.push(version as number);
  }
  if (new Set(copy).size !== copy.length) return null;
  return Object.freeze(copy);
}

function copySubjectHmacKeys(
  ring: NonNullable<OpenAiNativeSpeechAcknowledgementConfig['subjectHmacKeyRing']> | null,
): readonly Readonly<{ version: number; secret: string }>[] | null {
  if (ring === null) return null;
  try {
    const currentVersion = ring.currentVersion;
    const versions = copyExactSubjectKeyVersions(ring.versions);
    const secretForVersion = ring.secret;
    if (
      !Number.isSafeInteger(currentVersion)
      || Object.is(currentVersion, -0)
      || currentVersion < 1
      || currentVersion > POSTGRES_INT_MAX
      || versions === null
      || !versions.includes(currentVersion)
      || typeof secretForVersion !== 'function'
    ) return null;

    const orderedVersions = [
      currentVersion,
      ...versions.filter((version) => version !== currentVersion),
    ];
    const secrets = orderedVersions.map((version) => secretForVersion.call(ring, version));
    if (
      secrets.some((secret) => {
        if (typeof secret !== 'string') return true;
        const bytes = Buffer.byteLength(secret, 'utf8');
        return bytes < 32 || bytes > MAX_SUBJECT_HMAC_SECRET_BYTES;
      })
      || new Set(secrets).size !== secrets.length
    ) return null;
    return Object.freeze(orderedVersions.map((version, index) => Object.freeze({
      version,
      secret: secrets[index] as string,
    })));
  } catch {
    return null;
  }
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

export function parseOpenAiNativeSpeechAcknowledgementPath(
  sessionHandle: unknown,
  turnId: unknown,
  deliveryId: unknown,
): Result<OpenAiNativeSpeechAcknowledgementPath, AppError> {
  if (
    typeof sessionHandle !== 'string'
    || typeof turnId !== 'string'
    || typeof deliveryId !== 'string'
    || !UUID.test(sessionHandle)
    || !UUID.test(turnId)
    || !UUID.test(deliveryId)
  ) return validation('path', 'Identifiant de livraison vocale native invalide.');
  return ok(Object.freeze({
    sessionId: sessionHandle.toLowerCase(),
    turnId: turnId.toLowerCase(),
    deliveryId: deliveryId.toLowerCase(),
  }));
}

export function parseOpenAiNativeSpeechAcknowledgementBody(
  body: unknown,
): Result<OpenAiNativeSpeechAcknowledgementBody, AppError> {
  try {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return validation('body', 'Acquittement de livraison native Bob Live requis.');
    }
    const record = body as Record<string, unknown>;
    if (
      !hasExactKeys(record, BODY_KEYS)
      || typeof record.acknowledgementId !== 'string'
      || !UUID.test(record.acknowledgementId)
      || !Number.isSafeInteger(record.contextRevision)
      || Object.is(record.contextRevision, -0)
      || (record.contextRevision as number) < 1
      || (record.contextRevision as number) > POSTGRES_INT_MAX
      || typeof record.contextDigest !== 'string'
      || !CONTEXT_DIGEST.test(record.contextDigest)
      || !isOpenAiNativeLocalObservation(record.localObservation)
      || !isOpenAiNativeSpeechSlo(record.slo)
      || record.slo.speechStoppedEventToFirstInboundRtpMs === undefined
    ) return validation('body', 'Acquittement de livraison native Bob Live invalide.');

    return ok(Object.freeze({
      acknowledgementId: record.acknowledgementId.toLowerCase(),
      contextRevision: record.contextRevision as number,
      contextDigest: record.contextDigest,
      localObservation: Object.freeze({
        formatVersion: record.localObservation.formatVersion,
        kind: record.localObservation.kind,
      }),
      slo: cloneSpeechSlo(record.slo),
    }));
  } catch {
    return validation('body', 'Acquittement de livraison native Bob Live invalide.');
  }
}

/**
 * Rappels exportes pour rendre les bornes wire auditables sans dupliquer des nombres magiques dans
 * le client futur. Le contrat HTTP reste toutefois valide par le parseur, jamais par ces labels.
 */
export const OPENAI_NATIVE_SPEECH_ACKNOWLEDGEMENT_SLO_LIMITS = Object.freeze({
  speechStoppedEventToFirstInboundRtpMs:
    OPENAI_NATIVE_SPEECH_STOPPED_EVENT_TO_FIRST_INBOUND_RTP_MAX_MS,
  bargeInMs: OPENAI_NATIVE_BARGE_IN_MAX_MS,
  bargeInCount: OPENAI_NATIVE_BARGE_IN_MAX_PENDING,
});

export class OpenAiNativeSpeechAcknowledgementService {
  private readonly enabled: boolean;
  private readonly subjectHmacKeys: readonly Readonly<{ version: number; secret: string }>[];

  constructor(
    private readonly authority: Pick<
    OpenAiNativeSpeechAuthority,
    'acknowledgeMobileDelivery'
    > | null,
    config: OpenAiNativeSpeechAcknowledgementConfig,
    private readonly logger?: Pick<AppLogger, 'audit' | 'warn'>,
  ) {
    this.enabled = config.enabled === true;
    const keys = copySubjectHmacKeys(config.subjectHmacKeyRing);
    if (
      this.enabled
      && (
        authority === null
        || keys === null
      )
    ) throw new Error('OpenAI native delivery acknowledgement is incompletely configured.');
    this.subjectHmacKeys = keys ?? Object.freeze([]);
  }

  async acknowledge(
    sessionHandle: unknown,
    turnId: unknown,
    deliveryId: unknown,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Result<OpenAiNativeSpeechAcknowledgementReceipt, AppError>> {
    const path = parseOpenAiNativeSpeechAcknowledgementPath(sessionHandle, turnId, deliveryId);
    if (!path.ok) return path;
    const parsed = parseOpenAiNativeSpeechAcknowledgementBody(body);
    if (!parsed.ok) return parsed;

    const principal = getPrincipal();
    if (!principal?.userId || !principal.companyId) {
      return { ok: false, error: appForbidden('Session utilisateur et espace de travail requis.') };
    }
    const companyId = principal.companyId;
    const userId = principal.userId;
    if (!this.enabled || this.authority === null || this.subjectHmacKeys.length === 0) {
      return { ok: false, error: appUnavailable('bob-live-native-acknowledgement', 1) };
    }
    if (signal?.aborted) {
      return { ok: false, error: appUnavailable('bob-live-native-acknowledgement', 1) };
    }

    let delivered: Awaited<ReturnType<OpenAiNativeSpeechAuthority['acknowledgeMobileDelivery']>>;
    try {
      // Rotation sans amplification DB : tous les candidats sont derives et copies avant l'unique
      // appel authority. L'autorite relit une seule ligne puis les compare via timingSafeEqual.
      const subjectHmacCandidates = Object.freeze(this.subjectHmacKeys.map((key) => Object.freeze({
        version: key.version,
        subjectHmac: admissionSubjectHash(key.secret, companyId, userId),
      })));
      const input: OpenAiNativeSpeechMobileAcknowledgementInput = Object.freeze({
        companyId,
        subjectHmacCandidates,
        ...path.value,
        ...parsed.value,
      });
      delivered = await this.authority.acknowledgeMobileDelivery(input);
    } catch {
      delivered = { status: 'unavailable' };
    }

    if (delivered.status === 'not_found') {
      return { ok: false, error: appNotFound('realtime_native_speech', 'redacted') };
    }
    if (delivered.status === 'conflict') {
      return {
        ok: false,
        error: appConflict(
          'realtime_native_speech',
          'Livraison vocale non acquittable ou déjà terminée différemment.',
        ),
      };
    }
    if (delivered.status === 'not_ready') {
      return {
        ok: false,
        error: appUnavailable('bob-live-native-acknowledgement-not-ready', 1),
      };
    }
    if (delivered.status === 'unavailable') {
      this.logger?.warn(
        'bob.live.native_acknowledgement.failed class=authority_unavailable',
        'BobLive',
      );
      return { ok: false, error: appUnavailable('bob-live-native-acknowledgement', 1) };
    }

    const receipt = Object.freeze({
      deliveryId: path.value.deliveryId,
      turnId: path.value.turnId,
      acknowledgementId: parsed.value.acknowledgementId,
      contextRevision: parsed.value.contextRevision,
      contextDigest: parsed.value.contextDigest,
      idempotent: delivered.status === 'idempotent',
    });
    this.logger?.audit('bob.live.native_speech.delivered', {
      idempotent: receipt.idempotent,
      localObservationKind: parsed.value.localObservation.kind,
      sloIncluded: true,
    });
    return ok(receipt);
  }
}

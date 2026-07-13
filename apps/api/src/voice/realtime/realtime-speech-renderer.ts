import { createHash } from 'node:crypto';
import {
  CANONICAL_SPEECH_FACT_KINDS,
  FIXED_SAFE_SPEECH,
  createCanonicalSpeechEnvelope,
  type CanonicalSpeechEnvelope,
  type CanonicalSpeechFact,
  type FixedSafeSpeechId,
} from '@bob/ai';

/**
 * Limites de sécurité du rendu acoustique. Elles bornent les allocations et la durée pendant
 * laquelle une ressource fournisseur peut rester occupée. Un changement doit être qualifié
 * avec des mesures de latence et des fixtures audio réelles avant déploiement.
 */
export const REALTIME_SPEECH_RENDER_LIMITS = Object.freeze({
  maxTextUtf8Bytes: 12_000,
  minAudioBytes: 256,
  maxAudioBytes: 2 * 1024 * 1024,
  minEstimatedDurationMs: 100,
  maxEstimatedDurationMs: 45_000,
  minEncodedBitrateBps: 4_000,
  maxEncodedBitrateBps: 2_000_000,
  contextTimeoutMs: 2_000,
  staticAudioTimeoutMs: 2_000,
  ttsTimeoutMs: 15_000,
  asrTimeoutMs: 20_000,
} as const);

export interface RealtimeSpeechRenderLimits {
  readonly maxTextUtf8Bytes: number;
  readonly minAudioBytes: number;
  readonly maxAudioBytes: number;
  readonly minEstimatedDurationMs: number;
  readonly maxEstimatedDurationMs: number;
  readonly minEncodedBitrateBps: number;
  readonly maxEncodedBitrateBps: number;
  readonly contextTimeoutMs: number;
  readonly staticAudioTimeoutMs: number;
  readonly ttsTimeoutMs: number;
  readonly asrTimeoutMs: number;
}

export const REALTIME_SPEECH_ALLOWED_MIME_TYPES = Object.freeze([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/flac',
] as const);

export type RealtimeSpeechMimeType = (typeof REALTIME_SPEECH_ALLOWED_MIME_TYPES)[number];

export interface RealtimeRenderedAudio {
  /** Octets binaires uniquement : ce contrat ne transporte et ne retourne jamais de base64. */
  readonly audioBytes: Uint8Array;
  readonly mimeType: string;
  /** Durée issue du parseur de conteneur de l'adaptateur, jamais d'un texte fournisseur. */
  readonly estimatedDurationMs: number;
}

export interface RealtimeSpeechSynthesisPort {
  readonly id: string;
  /** Domaine de confiance réel (par ex. l'organisation fournisseur), pas seulement le modèle. */
  readonly trustDomain: string;
  synthesize(
    input: { readonly text: string; readonly signal: AbortSignal },
  ): Promise<RealtimeRenderedAudio>;
}

export interface RealtimeSpeechAuditPort {
  readonly id: string;
  /** Doit être distinct du domaine de confiance TTS pour constituer un audit indépendant. */
  readonly trustDomain: string;
  transcribe(
    input: {
      readonly audioBytes: Uint8Array;
      readonly mimeType: RealtimeSpeechMimeType;
      readonly signal: AbortSignal;
    },
  ): Promise<{ readonly text: string }>;
}

export interface RealtimeFixedSpeechPort {
  load(
    input: {
      readonly phraseId: FixedSafeSpeechId;
      readonly textSha256: string;
      readonly signal: AbortSignal;
    },
  ): Promise<RealtimeRenderedAudio & { readonly approvedTextSha256: string }>;
}

export interface RealtimeSpeechContextBinding {
  readonly sessionId: string;
  readonly turnId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
}

export interface RealtimeSpeechContextVersion {
  readonly contextRevision: number;
  readonly contextDigest: string;
}

export interface RealtimeSpeechRenderInput {
  readonly envelope: CanonicalSpeechEnvelope;
  readonly binding: RealtimeSpeechContextBinding;
  readonly signal: AbortSignal;
  /** Lecture autoritative et fail-closed du contexte durable de cette session. */
  readonly revalidateContext: (signal: AbortSignal) => Promise<RealtimeSpeechContextVersion>;
}

export type RealtimeSpeechRejectionCode =
  | 'INVALID_INPUT'
  | 'INVALID_ENVELOPE'
  | 'AUDITOR_NOT_INDEPENDENT'
  | 'CONTEXT_UNAVAILABLE'
  | 'CONTEXT_TIMEOUT'
  | 'CONTEXT_STALE'
  | 'STATIC_AUDIO_UNAVAILABLE'
  | 'STATIC_AUDIO_REJECTED'
  | 'TTS_FAILED'
  | 'TTS_TIMEOUT'
  | 'ASR_FAILED'
  | 'ASR_TIMEOUT'
  | 'ASR_INVALID_OUTPUT'
  | 'AUDIO_MIME_REJECTED'
  | 'AUDIO_FORMAT_MISMATCH'
  | 'AUDIO_SIZE_REJECTED'
  | 'AUDIO_DURATION_REJECTED'
  | 'SPEECH_FACT_MISMATCH'
  | 'SPEECH_TEXT_MISMATCH'
  | 'RENDER_FAILED';

export interface RealtimeSpeechArtifactMetadata {
  readonly version: 1;
  readonly sessionId: string;
  readonly turnId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly classification: CanonicalSpeechEnvelope['classification'];
  readonly source: 'synthesized_audited' | 'preapproved_static';
  readonly mimeType: RealtimeSpeechMimeType;
  readonly byteLength: number;
  readonly estimatedDurationMs: number;
  /** Empreintes hexadécimales ; le texte canonique et l'audio encodé ne figurent pas ici. */
  readonly textSha256: string;
  readonly factsSha256: string;
  readonly audioSha256: string;
  /** Provenance acoustique nécessaire à la preuve durable, sans contenu métier. */
  readonly synthesisAdapterId: string;
  readonly synthesisTrustDomain: string;
  readonly auditAdapterId: string | null;
  readonly auditTrustDomain: string | null;
  readonly auditTranscriptSha256: string | null;
}

export interface RealtimeSpeechArtifact {
  readonly metadata: RealtimeSpeechArtifactMetadata;
  /** Copie binaire possédée par l'artefact et prête pour un stockage privé. */
  readonly audioBytes: Uint8Array;
}

export interface RealtimeSpeechEnvelopeDigests {
  readonly textSha256: string;
  readonly factsSha256: string;
}

export type RealtimeSpeechRenderOutcome =
  | { readonly status: 'ready'; readonly artifact: RealtimeSpeechArtifact }
  | { readonly status: 'rejected'; readonly code: RealtimeSpeechRejectionCode }
  | { readonly status: 'aborted'; readonly code: 'ABORTED' };

export interface RealtimeSpeechRendererDependencies {
  readonly synthesizer: RealtimeSpeechSynthesisPort;
  readonly auditor: RealtimeSpeechAuditPort;
  readonly fixedSpeech?: RealtimeFixedSpeechPort;
  readonly limits?: Partial<RealtimeSpeechRenderLimits>;
}

type BoundedStageOutcome<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'failed' }
  | { readonly status: 'timeout' }
  | { readonly status: 'aborted' };

interface ValidatedAudio {
  readonly audioBytes: Uint8Array;
  readonly mimeType: RealtimeSpeechMimeType;
  readonly estimatedDurationMs: number;
}

const FACT_KINDS = new Set<string>(CANONICAL_SPEECH_FACT_KINDS);
const SAFE_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SHA_256_HEX = /^[a-f0-9]{64}$/u;
const INTERNAL_ABORT_REASON = Object.freeze({ code: 'bob_live_cancelled' });
const INTERNAL_TIMEOUT_REASON = Object.freeze({ code: 'bob_live_stage_timeout' });

const MIME_CANONICAL: Readonly<Record<RealtimeSpeechMimeType, RealtimeSpeechMimeType>> = Object.freeze({
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/ogg': 'audio/ogg',
  'audio/webm': 'audio/webm',
  'audio/mp4': 'audio/mp4',
  'audio/aac': 'audio/aac',
  'audio/flac': 'audio/flac',
});

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function realtimeSpeechEnvelopeDigests(
  envelope: Pick<CanonicalSpeechEnvelope, 'canonicalText' | 'facts'>,
): RealtimeSpeechEnvelopeDigests {
  if (typeof envelope?.canonicalText !== 'string' || envelope.canonicalText.length === 0) {
    throw new Error('Invalid canonical speech envelope.');
  }
  const canonicalFacts = factMultiset(envelope.facts);
  if (canonicalFacts === null) throw new Error('Invalid canonical speech facts.');
  return Object.freeze({
    textSha256: sha256(envelope.canonicalText),
    factsSha256: sha256(JSON.stringify(canonicalFacts)),
  });
}

function rejection(code: RealtimeSpeechRejectionCode): RealtimeSpeechRenderOutcome {
  return { status: 'rejected', code };
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function resolveLimits(overrides: Partial<RealtimeSpeechRenderLimits> | undefined): RealtimeSpeechRenderLimits {
  const limits = { ...REALTIME_SPEECH_RENDER_LIMITS, ...overrides };
  const integerValues = Object.values(limits);
  if (!integerValues.every(isPositiveInteger)
    || limits.minAudioBytes > limits.maxAudioBytes
    || limits.maxAudioBytes > 16 * 1024 * 1024
    || limits.maxTextUtf8Bytes > 64 * 1024
    || limits.minEstimatedDurationMs > limits.maxEstimatedDurationMs
    || limits.maxEstimatedDurationMs > 120_000
    || limits.minEncodedBitrateBps > limits.maxEncodedBitrateBps
    || limits.contextTimeoutMs > 60_000
    || limits.staticAudioTimeoutMs > 60_000
    || limits.ttsTimeoutMs > 60_000
    || limits.asrTimeoutMs > 60_000) {
    throw new Error('Invalid realtime speech renderer limits.');
  }
  return Object.freeze(limits);
}

async function runBoundedStage<T>(
  parentSignal: AbortSignal,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<BoundedStageOutcome<T>> {
  if (parentSignal.aborted) return { status: 'aborted' };

  const controller = new AbortController();
  let settleCancellation: ((outcome: BoundedStageOutcome<T>) => void) | undefined;
  let cancellationSettled = false;
  let cancellationStatus: 'timeout' | 'aborted' | null = null;
  const cancellation = new Promise<BoundedStageOutcome<T>>((resolve) => {
    settleCancellation = resolve;
  });
  const cancel = (status: 'timeout' | 'aborted'): void => {
    if (cancellationSettled) return;
    cancellationSettled = true;
    cancellationStatus = status;
    controller.abort(status === 'timeout' ? INTERNAL_TIMEOUT_REASON : INTERNAL_ABORT_REASON);
    settleCancellation?.({ status });
  };
  const onParentAbort = (): void => cancel('aborted');
  parentSignal.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => cancel('timeout'), timeoutMs);

  // Les deux branches absorbent leurs rejets : une promesse fournisseur tardive ne produit
  // jamais d'unhandled rejection après que le timeout a rendu la main.
  const operationOutcome: Promise<BoundedStageOutcome<T>> = Promise.resolve()
    .then(() => operation(controller.signal))
    .then((value): BoundedStageOutcome<T> => ({ status: 'ok', value }))
    .catch((): BoundedStageOutcome<T> => (
      cancellationStatus === null ? { status: 'failed' } : { status: cancellationStatus }
    ));

  try {
    return await Promise.race([operationOutcome, cancellation]);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', onParentAbort);
  }
}

function factMultiset(facts: readonly CanonicalSpeechFact[]): string[] | null {
  const keys: string[] = [];
  for (const fact of facts) {
    if (typeof fact !== 'object'
      || fact === null
      || !FACT_KINDS.has(fact.kind)
      || typeof fact.normalized !== 'string'
      || fact.normalized.length === 0
      || fact.normalized.length > 256) {
      return null;
    }
    keys.push(`${fact.kind}\u0000${fact.normalized}`);
  }
  return keys.sort();
}

function sameFactMultiset(
  left: readonly CanonicalSpeechFact[],
  right: readonly CanonicalSpeechFact[],
): boolean {
  const leftKeys = factMultiset(left);
  const rightKeys = factMultiset(right);
  return leftKeys !== null
    && rightKeys !== null
    && leftKeys.length === rightKeys.length
    && leftKeys.every((value, index) => value === rightKeys[index]);
}

function rebuildValidEnvelope(
  envelope: CanonicalSpeechEnvelope,
  limits: RealtimeSpeechRenderLimits,
): CanonicalSpeechEnvelope | null {
  if (typeof envelope !== 'object'
    || envelope === null
    || typeof envelope.text !== 'string'
    || typeof envelope.canonicalText !== 'string'
    || Buffer.byteLength(envelope.text, 'utf8') > limits.maxTextUtf8Bytes
    || Buffer.byteLength(envelope.canonicalText, 'utf8') > limits.maxTextUtf8Bytes
    || envelope.canonicalText.length === 0
    || !Array.isArray(envelope.facts)) {
    return null;
  }

  let rebuilt: CanonicalSpeechEnvelope;
  try {
    rebuilt = createCanonicalSpeechEnvelope(envelope.text);
  } catch {
    return null;
  }
  return envelope.version === rebuilt.version
    && envelope.canonicalText === rebuilt.canonicalText
    && envelope.classification === rebuilt.classification
    && envelope.fixedPhraseId === rebuilt.fixedPhraseId
    && sameFactMultiset(envelope.facts, rebuilt.facts)
    ? rebuilt
    : null;
}

function validBinding(binding: RealtimeSpeechContextBinding): boolean {
  return typeof binding === 'object'
    && binding !== null
    && SAFE_OPAQUE_ID.test(binding.sessionId)
    && SAFE_OPAQUE_ID.test(binding.turnId)
    && Number.isSafeInteger(binding.contextRevision)
    && binding.contextRevision >= 1
    && SHA_256_HEX.test(binding.contextDigest);
}

function sameContext(
  expected: RealtimeSpeechContextBinding,
  actual: RealtimeSpeechContextVersion,
): boolean {
  return typeof actual === 'object'
    && actual !== null
    && actual.contextRevision === expected.contextRevision
    && actual.contextDigest === expected.contextDigest;
}

function hasAudioSignature(mimeType: RealtimeSpeechMimeType, bytes: Uint8Array): boolean {
  switch (mimeType) {
    case 'audio/mpeg':
      return (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
        || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0);
    case 'audio/wav':
      return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
    case 'audio/ogg':
      return bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
    case 'audio/webm':
      return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    case 'audio/mp4':
      return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
    case 'audio/aac':
      return bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0;
    case 'audio/flac':
      return bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43;
    // Les alias ont été normalisés avant la vérification.
    case 'audio/mp3':
    case 'audio/x-wav':
      return false;
  }
}

function validateAudio(
  output: RealtimeRenderedAudio,
  limits: RealtimeSpeechRenderLimits,
): { readonly ok: true; readonly value: ValidatedAudio }
  | { readonly ok: false; readonly code: RealtimeSpeechRejectionCode } {
  if (typeof output !== 'object' || output === null || !(output.audioBytes instanceof Uint8Array)) {
    return { ok: false, code: 'AUDIO_SIZE_REJECTED' };
  }
  if (typeof output.mimeType !== 'string'
    || !Object.hasOwn(MIME_CANONICAL, output.mimeType)) {
    return { ok: false, code: 'AUDIO_MIME_REJECTED' };
  }
  const canonicalMime = MIME_CANONICAL[output.mimeType as RealtimeSpeechMimeType];
  if (canonicalMime === undefined) return { ok: false, code: 'AUDIO_MIME_REJECTED' };
  if (output.audioBytes.byteLength < limits.minAudioBytes
    || output.audioBytes.byteLength > limits.maxAudioBytes) {
    return { ok: false, code: 'AUDIO_SIZE_REJECTED' };
  }
  if (!Number.isSafeInteger(output.estimatedDurationMs)
    || output.estimatedDurationMs < limits.minEstimatedDurationMs
    || output.estimatedDurationMs > limits.maxEstimatedDurationMs) {
    return { ok: false, code: 'AUDIO_DURATION_REJECTED' };
  }
  const encodedBitrateBps = Math.ceil(
    (output.audioBytes.byteLength * 8 * 1_000) / output.estimatedDurationMs,
  );
  if (encodedBitrateBps < limits.minEncodedBitrateBps
    || encodedBitrateBps > limits.maxEncodedBitrateBps) {
    return { ok: false, code: 'AUDIO_DURATION_REJECTED' };
  }
  if (!hasAudioSignature(canonicalMime, output.audioBytes)) {
    return { ok: false, code: 'AUDIO_FORMAT_MISMATCH' };
  }
  return {
    ok: true,
    value: {
      audioBytes: new Uint8Array(output.audioBytes),
      mimeType: canonicalMime,
      estimatedDurationMs: output.estimatedDurationMs,
    },
  };
}

function fixedPhraseIsExact(envelope: CanonicalSpeechEnvelope): envelope is CanonicalSpeechEnvelope & {
  readonly fixedPhraseId: FixedSafeSpeechId;
} {
  if (envelope.classification !== 'fixed_safe' || envelope.fixedPhraseId === undefined) return false;
  const expected = FIXED_SAFE_SPEECH[envelope.fixedPhraseId];
  return envelope.text === expected && envelope.canonicalText === expected && envelope.facts.length === 0;
}

export class RealtimeSpeechRenderer {
  private readonly limits: RealtimeSpeechRenderLimits;

  constructor(private readonly dependencies: RealtimeSpeechRendererDependencies) {
    this.limits = resolveLimits(dependencies.limits);
  }

  async render(input: RealtimeSpeechRenderInput): Promise<RealtimeSpeechRenderOutcome> {
    try {
      return await this.renderChecked(input);
    } catch {
      // Dernier coupe-circuit : ni exception fournisseur, ni getter forgé, ni cause interne ne
      // traverse cette frontière et aucun artefact partiellement validé n'est libéré.
      return rejection('RENDER_FAILED');
    }
  }

  private async renderChecked(input: RealtimeSpeechRenderInput): Promise<RealtimeSpeechRenderOutcome> {
    if (typeof input !== 'object' || input === null
      || typeof input.signal !== 'object' || input.signal === null
      || typeof input.signal.aborted !== 'boolean'
      || typeof input.signal.addEventListener !== 'function'
      || typeof input.signal.removeEventListener !== 'function') {
      return rejection('INVALID_INPUT');
    }
    const signal = input.signal;
    const revalidateContext = input.revalidateContext;
    if (signal.aborted) return { status: 'aborted', code: 'ABORTED' };
    if (!validBinding(input.binding) || typeof revalidateContext !== 'function') {
      return rejection('INVALID_INPUT');
    }
    const envelope = rebuildValidEnvelope(input.envelope, this.limits);
    if (envelope === null) return rejection('INVALID_ENVELOPE');
    // Snapshot possédé avant le premier await. Un appelant forgé ne peut pas muter texte, faits ou
    // fence pendant le TTS/ASR afin de faire auditer une valeur puis d'en persister une autre.
    const checkedInput: RealtimeSpeechRenderInput = Object.freeze({
      envelope,
      binding: Object.freeze({
        sessionId: input.binding.sessionId,
        turnId: input.binding.turnId,
        contextRevision: input.binding.contextRevision,
        contextDigest: input.binding.contextDigest,
      }),
      signal,
      revalidateContext,
    });

    const digests = realtimeSpeechEnvelopeDigests(envelope);
    const textSha256 = digests.textSha256;
    const initialContext = await runBoundedStage(
      signal,
      this.limits.contextTimeoutMs,
      revalidateContext,
    );
    const initialFailure = this.contextFailure(initialContext, checkedInput.binding);
    if (initialFailure !== null) return initialFailure;

    if (fixedPhraseIsExact(envelope) && this.dependencies.fixedSpeech !== undefined) {
      return this.renderFixed(checkedInput, textSha256);
    }
    return this.renderAudited(checkedInput, textSha256);
  }

  private async renderFixed(
    input: RealtimeSpeechRenderInput,
    textSha256: string,
  ): Promise<RealtimeSpeechRenderOutcome> {
    const fixedSpeech = this.dependencies.fixedSpeech;
    if (fixedSpeech === undefined || input.envelope.fixedPhraseId === undefined) {
      return rejection('STATIC_AUDIO_UNAVAILABLE');
    }
    const loaded = await runBoundedStage(
      input.signal,
      this.limits.staticAudioTimeoutMs,
      (signal) => fixedSpeech.load({
        phraseId: input.envelope.fixedPhraseId as FixedSafeSpeechId,
        textSha256,
        signal,
      }),
    );
    if (loaded.status === 'aborted') return { status: 'aborted', code: 'ABORTED' };
    if (loaded.status !== 'ok') return rejection('STATIC_AUDIO_UNAVAILABLE');

    const finalContext = await runBoundedStage(
      input.signal,
      this.limits.contextTimeoutMs,
      input.revalidateContext,
    );
    const contextFailure = this.contextFailure(finalContext, input.binding);
    if (contextFailure !== null) return contextFailure;
    if (loaded.value.approvedTextSha256 !== textSha256) return rejection('STATIC_AUDIO_REJECTED');
    const audio = validateAudio(loaded.value, this.limits);
    if (!audio.ok) return rejection(audio.code);
    return this.readyArtifact(input, textSha256, audio.value, 'preapproved_static');
  }

  private async renderAudited(
    input: RealtimeSpeechRenderInput,
    textSha256: string,
  ): Promise<RealtimeSpeechRenderOutcome> {
    const { synthesizer, auditor } = this.dependencies;
    const synthesizerId = typeof synthesizer.id === 'string' ? synthesizer.id.trim() : '';
    const auditorId = typeof auditor.id === 'string' ? auditor.id.trim() : '';
    const synthesizerTrustDomain = typeof synthesizer.trustDomain === 'string'
      ? synthesizer.trustDomain.trim().toLowerCase()
      : '';
    const auditorTrustDomain = typeof auditor.trustDomain === 'string'
      ? auditor.trustDomain.trim().toLowerCase()
      : '';
    if (!SAFE_OPAQUE_ID.test(synthesizerId)
      || !SAFE_OPAQUE_ID.test(auditorId)
      || !SAFE_OPAQUE_ID.test(synthesizerTrustDomain)
      || !SAFE_OPAQUE_ID.test(auditorTrustDomain)
      || synthesizerTrustDomain === auditorTrustDomain) {
      return rejection('AUDITOR_NOT_INDEPENDENT');
    }

    const synthesized = await runBoundedStage(
      input.signal,
      this.limits.ttsTimeoutMs,
      (signal) => synthesizer.synthesize({ text: input.envelope.canonicalText, signal }),
    );
    if (synthesized.status === 'aborted') return { status: 'aborted', code: 'ABORTED' };
    if (synthesized.status === 'timeout') return rejection('TTS_TIMEOUT');
    if (synthesized.status === 'failed') return rejection('TTS_FAILED');

    // Fence immédiatement après le TTS : un changement d'écran évite même l'envoi à l'ASR.
    const contextAfterTts = await runBoundedStage(
      input.signal,
      this.limits.contextTimeoutMs,
      input.revalidateContext,
    );
    const contextAfterTtsFailure = this.contextFailure(contextAfterTts, input.binding);
    if (contextAfterTtsFailure !== null) return contextAfterTtsFailure;

    const audio = validateAudio(synthesized.value, this.limits);
    if (!audio.ok) return rejection(audio.code);
    const audited = await runBoundedStage(
      input.signal,
      this.limits.asrTimeoutMs,
      (signal) => auditor.transcribe({
        audioBytes: new Uint8Array(audio.value.audioBytes),
        mimeType: audio.value.mimeType,
        signal,
      }),
    );
    if (audited.status === 'aborted') return { status: 'aborted', code: 'ABORTED' };
    if (audited.status === 'timeout') return rejection('ASR_TIMEOUT');
    if (audited.status === 'failed') return rejection('ASR_FAILED');

    const finalContext = await runBoundedStage(
      input.signal,
      this.limits.contextTimeoutMs,
      input.revalidateContext,
    );
    const finalContextFailure = this.contextFailure(finalContext, input.binding);
    if (finalContextFailure !== null) return finalContextFailure;
    if (typeof audited.value !== 'object'
      || audited.value === null
      || typeof audited.value.text !== 'string'
      || audited.value.text.length === 0
      || Buffer.byteLength(audited.value.text, 'utf8') > this.limits.maxTextUtf8Bytes) {
      return rejection('ASR_INVALID_OUTPUT');
    }

    let auditedEnvelope: CanonicalSpeechEnvelope;
    try {
      auditedEnvelope = createCanonicalSpeechEnvelope(audited.value.text);
    } catch {
      return rejection('ASR_INVALID_OUTPUT');
    }
    // Les faits sont comparés comme un multiensemble avant le texte afin de distinguer les
    // corruptions métier (montant, IBAN, statut) des divergences purement linguistiques.
    if (!sameFactMultiset(input.envelope.facts, auditedEnvelope.facts)) {
      return rejection('SPEECH_FACT_MISMATCH');
    }
    if (auditedEnvelope.canonicalText !== input.envelope.canonicalText) {
      return rejection('SPEECH_TEXT_MISMATCH');
    }
    return this.readyArtifact(input, textSha256, audio.value, 'synthesized_audited', {
      synthesisAdapterId: synthesizerId,
      synthesisTrustDomain: synthesizerTrustDomain,
      auditAdapterId: auditorId,
      auditTrustDomain: auditorTrustDomain,
      auditTranscriptSha256: sha256(audited.value.text),
    });
  }

  private contextFailure<T>(
    outcome: BoundedStageOutcome<T>,
    expected: RealtimeSpeechContextBinding,
  ): RealtimeSpeechRenderOutcome | null {
    if (outcome.status === 'aborted') return { status: 'aborted', code: 'ABORTED' };
    if (outcome.status === 'timeout') return rejection('CONTEXT_TIMEOUT');
    if (outcome.status === 'failed') return rejection('CONTEXT_UNAVAILABLE');
    return sameContext(expected, outcome.value as RealtimeSpeechContextVersion)
      ? null
      : rejection('CONTEXT_STALE');
  }

  private readyArtifact(
    input: RealtimeSpeechRenderInput,
    textSha256: string,
    audio: ValidatedAudio,
    source: RealtimeSpeechArtifactMetadata['source'],
    provenance: Pick<
      RealtimeSpeechArtifactMetadata,
      | 'synthesisAdapterId'
      | 'synthesisTrustDomain'
      | 'auditAdapterId'
      | 'auditTrustDomain'
      | 'auditTranscriptSha256'
    > = {
      synthesisAdapterId: 'preapproved-static',
      synthesisTrustDomain: 'bob-pro',
      auditAdapterId: null,
      auditTrustDomain: null,
      auditTranscriptSha256: null,
    },
  ): RealtimeSpeechRenderOutcome {
    const ownedBytes = new Uint8Array(audio.audioBytes);
    return {
      status: 'ready',
      artifact: {
        metadata: {
          version: 1,
          sessionId: input.binding.sessionId,
          turnId: input.binding.turnId,
          contextRevision: input.binding.contextRevision,
          contextDigest: input.binding.contextDigest,
          classification: input.envelope.classification,
          source,
          mimeType: audio.mimeType,
          byteLength: ownedBytes.byteLength,
          estimatedDurationMs: audio.estimatedDurationMs,
          textSha256,
          factsSha256: realtimeSpeechEnvelopeDigests(input.envelope).factsSha256,
          audioSha256: sha256(ownedBytes),
          ...provenance,
        },
        audioBytes: ownedBytes,
      },
    };
  }
}

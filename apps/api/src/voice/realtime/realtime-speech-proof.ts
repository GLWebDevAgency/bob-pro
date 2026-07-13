import { createHmac } from 'node:crypto';
import type { RealtimeSpeechArtifactMetadata } from './realtime-speech-renderer';

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const AUDIO_MIME = /^audio\/[a-z0-9.+-]{1,40}$/u;
const STORAGE_KEY = /^companies\/([A-Za-z0-9-]{1,64})\/bob-live\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/iu;

export interface RealtimeSpeechProofInput {
  readonly secret: string;
  readonly keyVersion: number;
  readonly companyId: string;
  readonly subjectHash: string;
  readonly artifactId: string;
  readonly sequence: number;
  readonly storageKey: string;
  readonly metadata: RealtimeSpeechArtifactMetadata;
}

export interface RealtimeSpeechProof {
  readonly proofKeyVersion: number;
  readonly canonicalSpeechHmac: string;
  readonly factsHmac: string;
  readonly auditTranscriptHmac: string | null;
  readonly evidenceHmac: string;
}

export interface RealtimeSpeechContentProof {
  readonly canonicalSpeechHmac: string;
  readonly factsHmac: string;
  readonly auditTranscriptHmac: string | null;
}

function hmac(secret: string, domain: string, values: readonly (string | number | null)[]): string {
  const mac = createHmac('sha256', secret);
  mac.update(`bob-pro:realtime-speech:${domain}:v1`, 'utf8');
  for (const value of values) {
    mac.update('\u0000', 'utf8');
    mac.update(value === null ? '-' : String(value), 'utf8');
  }
  return mac.digest('hex');
}

function isPositivePostgresInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
}

export function createRealtimeSpeechContentProof(input: {
  readonly secret: string;
  readonly companyId: string;
  readonly textSha256: string;
  readonly factsSha256: string;
  readonly auditTranscriptSha256: string | null;
}): RealtimeSpeechContentProof {
  if (typeof input.secret !== 'string'
    || Buffer.byteLength(input.secret, 'utf8') < 32
    || input.secret.includes('[')
    || input.secret.includes(']')
    || !COMPANY_ID.test(input.companyId)
    || !SHA256_HEX.test(input.textSha256)
    || !SHA256_HEX.test(input.factsSha256)
    || (input.auditTranscriptSha256 !== null && !SHA256_HEX.test(input.auditTranscriptSha256))) {
    throw new Error('Invalid realtime speech content proof input.');
  }
  return Object.freeze({
    canonicalSpeechHmac: hmac(input.secret, 'canonical-text', [
      input.companyId,
      input.textSha256,
    ]),
    factsHmac: hmac(input.secret, 'canonical-facts', [
      input.companyId,
      input.factsSha256,
    ]),
    auditTranscriptHmac: input.auditTranscriptSha256 === null
      ? null
      : hmac(input.secret, 'audit-transcript', [
          input.companyId,
          input.auditTranscriptSha256,
        ]),
  });
}

function validMetadata(metadata: RealtimeSpeechArtifactMetadata): boolean {
  return metadata.version === 1
    && UUID.test(metadata.sessionId)
    && UUID.test(metadata.turnId)
    && isPositivePostgresInteger(metadata.contextRevision)
    && SHA256_HEX.test(metadata.contextDigest)
    && (metadata.classification === 'fixed_safe' || metadata.classification === 'dynamic_sensitive')
    && (metadata.source === 'synthesized_audited' || metadata.source === 'preapproved_static')
    && AUDIO_MIME.test(metadata.mimeType)
    && Number.isSafeInteger(metadata.byteLength)
    && metadata.byteLength >= 256
    && metadata.byteLength <= 2 * 1024 * 1024
    && Number.isSafeInteger(metadata.estimatedDurationMs)
    && metadata.estimatedDurationMs >= 100
    && metadata.estimatedDurationMs <= 45_000
    && SHA256_HEX.test(metadata.textSha256)
    && SHA256_HEX.test(metadata.factsSha256)
    && SHA256_HEX.test(metadata.audioSha256)
    && SAFE_ID.test(metadata.synthesisAdapterId)
    && SAFE_ID.test(metadata.synthesisTrustDomain)
    && (
      metadata.source === 'preapproved_static'
        ? metadata.auditAdapterId === null
          && metadata.auditTrustDomain === null
          && metadata.auditTranscriptSha256 === null
        : metadata.auditAdapterId !== null
          && SAFE_ID.test(metadata.auditAdapterId)
          && metadata.auditTrustDomain !== null
          && SAFE_ID.test(metadata.auditTrustDomain)
          && metadata.auditTrustDomain !== metadata.synthesisTrustDomain
          && metadata.auditTranscriptSha256 !== null
          && SHA256_HEX.test(metadata.auditTranscriptSha256)
    );
}

/**
 * Transforme les digests de travail du renderer en preuves persistables non dictionnarisables.
 * Le texte, les faits et le transcript ne traversent jamais ce contrat. Le MAC d'évidence lie la
 * preuve au tenant, au contexte, à la séquence et à l'objet exact : aucune colonne ne peut être
 * transplantée entre deux artefacts sans invalider l'ensemble.
 */
export function createRealtimeSpeechProof(input: RealtimeSpeechProofInput): RealtimeSpeechProof {
  if (typeof input.secret !== 'string'
    || Buffer.byteLength(input.secret, 'utf8') < 32
    || input.secret.includes('[')
    || input.secret.includes(']')
    || !isPositivePostgresInteger(input.keyVersion)
    || !COMPANY_ID.test(input.companyId)
    || !SHA256_HEX.test(input.subjectHash)
    || !UUID.test(input.artifactId)
    || !isPositivePostgresInteger(input.sequence)
    || !validMetadata(input.metadata)) {
    throw new Error('Invalid realtime speech proof input.');
  }
  const storageMatch = STORAGE_KEY.exec(input.storageKey);
  if (storageMatch?.[1] !== input.companyId
    || storageMatch[2]?.toLowerCase() !== input.metadata.sessionId.toLowerCase()
    || storageMatch[3]?.toLowerCase() !== input.metadata.turnId.toLowerCase()
    || storageMatch[4]?.toLowerCase() !== input.artifactId.toLowerCase()) {
    throw new Error('Invalid realtime speech proof storage binding.');
  }

  const content = createRealtimeSpeechContentProof({
    secret: input.secret,
    companyId: input.companyId,
    textSha256: input.metadata.textSha256,
    factsSha256: input.metadata.factsSha256,
    auditTranscriptSha256: input.metadata.auditTranscriptSha256,
  });
  const evidenceHmac = hmac(input.secret, 'evidence', [
    input.keyVersion,
    input.companyId,
    input.subjectHash,
    input.metadata.sessionId.toLowerCase(),
    input.metadata.turnId.toLowerCase(),
    input.artifactId.toLowerCase(),
    input.sequence,
    input.metadata.contextRevision,
    input.metadata.contextDigest,
    input.metadata.classification,
    input.metadata.source,
    input.storageKey,
    content.canonicalSpeechHmac,
    content.factsHmac,
    content.auditTranscriptHmac,
    input.metadata.audioSha256,
    input.metadata.mimeType,
    input.metadata.byteLength,
    input.metadata.estimatedDurationMs,
    input.metadata.synthesisAdapterId,
    input.metadata.synthesisTrustDomain,
    input.metadata.auditAdapterId,
    input.metadata.auditTrustDomain,
  ]);
  return Object.freeze({
    proofKeyVersion: input.keyVersion,
    ...content,
    evidenceHmac,
  });
}

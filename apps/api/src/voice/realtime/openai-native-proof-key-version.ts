import { createHash } from 'node:crypto';

const POSTGRES_INTEGER_MAX = 2_147_483_647;

export interface OpenAiNativeProofKeyRingAdmission {
  readonly currentVersion: number;
  readonly versions: readonly number[];
  /** Retourne la chaine exacte passee a createHmac, sans normalisation ni decodage. */
  secret(version: number): string | null;
}

export interface OpenAiNativeKeyVersionAuthorityPort {
  assertCurrentKeyVersions(): Promise<void>;
}

export function assertOpenAiNativeProofKeyVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1 || version > POSTGRES_INTEGER_MAX) {
    throw new Error('OpenAI native proof HMAC key version must be a positive integer.');
  }
}

function assertProofSecret(secret: string): void {
  if (
    typeof secret !== 'string'
    || Buffer.byteLength(secret, 'utf8') < 32
    || Buffer.byteLength(secret, 'utf8') > 512
    || secret.includes('[')
    || secret.includes(']')
    || [...secret].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x21 || codePoint > 0x7e;
    })
  ) throw new Error('OpenAI native proof HMAC key material is invalid.');
}

/** Empreinte append-only des octets UTF-8 exacts réellement consommés par createHmac. */
export function fingerprintOpenAiNativeProofKey(secret: string): string {
  assertProofSecret(secret);
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

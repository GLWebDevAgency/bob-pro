import { createHash } from 'node:crypto';

const POSTGRES_INTEGER_MAX = 2_147_483_647;

export interface BobLiveSubjectHmacKeyRingAdmission {
  readonly currentVersion: number;
  readonly versions: readonly number[];
  /** Retourne la chaîne historique exacte passée à createHmac, sans aucune normalisation. */
  secret(version: number): string | null;
}

export function assertBobLiveSubjectHmacVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1 || version > POSTGRES_INTEGER_MAX) {
    throw new Error('Bob Live subject HMAC key version must be a positive integer.');
  }
}

function assertSecret(secret: string): void {
  if (
    typeof secret !== 'string'
    || secret.length < 32
    || secret.length > 512
    || secret.includes('[')
    || secret.includes(']')
    || [...secret].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x21 || codePoint > 0x7e;
    })
  ) throw new Error('Bob Live subject HMAC key material is invalid.');
}

/**
 * Empreinte du matériau HMAC historique exact.
 *
 * Le runtime Node traite cette valeur comme une chaîne UTF-8 dans `createHmac`. Une clé legacy
 * non-base64url doit donc rester byte-for-byte identique : décoder ou normaliser ici briserait la
 * possibilité de retrouver les preuves déjà écrites.
 */
export function fingerprintBobLiveSubjectHmacKey(secret: string): string {
  assertSecret(secret);
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

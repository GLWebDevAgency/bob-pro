import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  CabinetInvitationTokenHash,
  type CabinetInvitationTokenPort,
  type IssuedCabinetInvitationToken,
} from '@bob/core';
import { isDemoMode } from '../config/env';

const DEMO_ENCRYPTION_KEY = 'bob-pro-cabinet-demo-key-not-for-production';

function decodeCanonicalBase64Url(value: string, field: string, expectedBytes?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid ${field} encoding.`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value || (expectedBytes !== undefined && decoded.length !== expectedBytes)) {
    throw new Error(`Invalid ${field} encoding.`);
  }
  return decoded;
}

export class CabinetInvitationTokenAdapter implements CabinetInvitationTokenPort {
  async issue(): Promise<IssuedCabinetInvitationToken> {
    const rawToken = `cbi_${randomBytes(32).toString('base64url')}`;
    return { rawToken, tokenHash: await this.hash(rawToken) };
  }

  async hash(rawToken: string): Promise<CabinetInvitationTokenHash> {
    const digest = createHash('sha256').update(rawToken, 'utf8').digest('hex');
    const parsed = CabinetInvitationTokenHash.of(digest);
    if (!parsed.ok) throw new Error('SHA-256 produced an invalid cabinet invitation token hash.');
    return parsed.value;
  }
}

export interface EncryptedCabinetInvitationToken {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

/**
 * AEAD pour le secret transitoire de l'outbox. La base ne voit jamais le token en clair et les
 * colonnes sont purgées après livraison. Une rotation attend le drainage de l'ancienne version.
 */
export class CabinetInvitationTokenCipher {
  private readonly key: Buffer;
  readonly keyVersion: number;

  constructor(
    secret = process.env.CABINET_INVITATION_TOKEN_ENCRYPTION_KEY,
    keyVersion = Number(process.env.CABINET_INVITATION_TOKEN_KEY_VERSION ?? '1'),
  ) {
    const resolved = secret || (isDemoMode() ? DEMO_ENCRYPTION_KEY : '');
    if (resolved.length < 32) {
      throw new Error('CABINET_INVITATION_TOKEN_ENCRYPTION_KEY must contain at least 32 characters.');
    }
    if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
      throw new Error('CABINET_INVITATION_TOKEN_KEY_VERSION must be a positive integer.');
    }
    this.key = createHash('sha256').update(resolved, 'utf8').digest();
    this.keyVersion = keyVersion;
  }

  encrypt(invitationId: string, rawToken: string): EncryptedCabinetInvitationToken {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(invitationId, this.keyVersion));
    const ciphertext = Buffer.concat([cipher.update(rawToken, 'utf8'), cipher.final()]);
    return {
      ciphertext: ciphertext.toString('base64url'),
      iv: iv.toString('base64url'),
      authTag: cipher.getAuthTag().toString('base64url'),
      keyVersion: this.keyVersion,
    };
  }

  decrypt(invitationId: string, encrypted: EncryptedCabinetInvitationToken): string {
    if (encrypted.keyVersion !== this.keyVersion) {
      throw new Error(`Unsupported cabinet invitation encryption key version: ${encrypted.keyVersion}.`);
    }
    const iv = decodeCanonicalBase64Url(encrypted.iv, 'invitation token IV', 12);
    const authTag = decodeCanonicalBase64Url(encrypted.authTag, 'invitation token authentication tag', 16);
    const ciphertext = decodeCanonicalBase64Url(encrypted.ciphertext, 'invitation token ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(this.aad(invitationId, encrypted.keyVersion));
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
  }

  private aad(invitationId: string, version: number): Buffer {
    return Buffer.from(`bob-pro:cabinet-invitation:${invitationId}:v${version}`, 'utf8');
  }
}

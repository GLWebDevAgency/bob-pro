import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  PrismaOpenAiNativeProofKeyVersionAuthority,
} from './openai-native-proof-key-version.prisma';
import { fingerprintOpenAiNativeProofKey } from './openai-native-proof-key-version';

const CURRENT_SECRET = 'openai-native-proof-current-material-2026';
const PREVIOUS_SECRET = 'openai-native-proof-previous-material-2025';
const CURRENT_FINGERPRINT = fingerprintOpenAiNativeProofKey(CURRENT_SECRET);
const PREVIOUS_FINGERPRINT = fingerprintOpenAiNativeProofKey(PREVIOUS_SECRET);

function keyRing(
  currentVersion = 1,
  secrets: Readonly<Record<number, string>> = { 1: CURRENT_SECRET },
) {
  return Object.freeze({
    currentVersion,
    versions: Object.freeze(Object.keys(secrets).map(Number)),
    secret: (version: number) => secrets[version] ?? null,
  });
}

function prismaReturning(options: {
  readonly minimumVersion?: number;
  readonly highestVersion?: number;
  readonly admitted?: readonly { keyVersion: number; keyFingerprint: string }[];
  readonly retained?: readonly { keyVersion: number; keyFingerprint: string | null }[];
  readonly inTransaction?: boolean;
  readonly missingRange?: boolean;
} = {}) {
  const minimumVersion = options.minimumVersion ?? 1;
  const highestVersion = options.highestVersion ?? minimumVersion;
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('retained_openai_native_proof_hmac_key_bindings')) {
        return options.retained ?? [];
      }
      if (sql.includes('FROM realtime_mistral_conversation_key_bindings')) {
        return options.admitted ?? [{
          keyVersion: minimumVersion,
          keyFingerprint: CURRENT_FINGERPRINT,
        }];
      }
      return options.missingRange ? [] : [{ minimumVersion, highestVersion }];
    }),
  } as unknown as Prisma.TransactionClient;
  const transaction = vi.fn(async (
    callback: (client: Prisma.TransactionClient) => Promise<void>,
  ) => callback(tx));
  const prisma = {
    inTransaction: vi.fn(() => options.inTransaction ?? false),
    $transaction: transaction,
  } as unknown as PrismaService;
  return { prisma, tx, transaction };
}

describe('PrismaOpenAiNativeProofKeyVersionAuthority', () => {
  it('empreinte exactement les octets UTF-8 consommés par createHmac', () => {
    expect(CURRENT_FINGERPRINT).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprintOpenAiNativeProofKey(`${CURRENT_SECRET}x`)).not.toBe(CURRENT_FINGERPRINT);
  });

  it('refuse versions, plages et matériaux non canoniques', () => {
    const { prisma } = prismaReturning();
    expect(() => new PrismaOpenAiNativeProofKeyVersionAuthority(
      prisma,
      keyRing(0),
    )).toThrow(/positive integer/u);
    expect(() => new PrismaOpenAiNativeProofKeyVersionAuthority(
      prisma,
      keyRing(3, { 1: PREVIOUS_SECRET, 3: CURRENT_SECRET }),
    )).toThrow(/rotation is invalid/u);
    expect(() => new PrismaOpenAiNativeProofKeyVersionAuthority(
      prisma,
      keyRing(2, { 1: CURRENT_SECRET, 2: CURRENT_SECRET }),
    )).toThrow(/reuses key material/u);
  });

  it('prend le verrou partagé et valide la plage N-1/N exacte', async () => {
    const { prisma, tx, transaction } = prismaReturning({
      minimumVersion: 1,
      highestVersion: 2,
      admitted: [
        { keyVersion: 1, keyFingerprint: PREVIOUS_FINGERPRINT },
        { keyVersion: 2, keyFingerprint: CURRENT_FINGERPRINT },
      ],
    });
    const authority = new PrismaOpenAiNativeProofKeyVersionAuthority(
      prisma,
      keyRing(2, { 1: PREVIOUS_SECRET, 2: CURRENT_SECRET }),
    );
    await expect(authority.assertCurrentVersion()).resolves.toBeUndefined();
    expect(transaction).toHaveBeenCalledOnce();
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('refuse une transaction ambiante, une plage absente ou un binding incomplet', async () => {
    const nested = prismaReturning({ inTransaction: true });
    await expect(new PrismaOpenAiNativeProofKeyVersionAuthority(
      nested.prisma,
      keyRing(),
    ).assertCurrentVersion()).rejects.toThrow(/root transaction/u);
    expect(nested.transaction).not.toHaveBeenCalled();

    const missing = prismaReturning({ missingRange: true });
    await expect(new PrismaOpenAiNativeProofKeyVersionAuthority(
      missing.prisma,
      keyRing(),
    ).assertCurrentVersion()).rejects.toThrow(/not initialized/u);

    const incomplete = prismaReturning({ admitted: [] });
    await expect(new PrismaOpenAiNativeProofKeyVersionAuthority(
      incomplete.prisma,
      keyRing(),
    ).assertCurrentVersion()).rejects.toThrow(/bindings are incomplete/u);
  });

  it('refuse A/v1 durable puis B/v1 configuré', async () => {
    const { prisma } = prismaReturning({
      admitted: [{ keyVersion: 1, keyFingerprint: CURRENT_FINGERPRINT }],
    });
    const authority = new PrismaOpenAiNativeProofKeyVersionAuthority(
      prisma,
      keyRing(1, { 1: 'replacement-proof-material-version-one'.padEnd(40, 'x') }),
    );
    await expect(authority.assertCurrentVersion()).rejects.toThrow(
      /does not match durable version 1/u,
    );
  });

  it('exige chaque ancienne clé encore retenue, mais pas une clé purgée', async () => {
    const retained = [{ keyVersion: 1, keyFingerprint: PREVIOUS_FINGERPRINT }];
    const database = () => prismaReturning({
      minimumVersion: 2,
      admitted: [{ keyVersion: 2, keyFingerprint: CURRENT_FINGERPRINT }],
      retained,
    }).prisma;
    await expect(new PrismaOpenAiNativeProofKeyVersionAuthority(
      database(),
      keyRing(2, { 2: CURRENT_SECRET }),
    ).assertCurrentVersion()).rejects.toThrow(/durable version 1/u);
    await expect(new PrismaOpenAiNativeProofKeyVersionAuthority(
      database(),
      keyRing(2, { 1: PREVIOUS_SECRET, 2: CURRENT_SECRET }),
    ).assertCurrentVersion()).resolves.toBeUndefined();
  });
});

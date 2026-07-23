import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  PrismaBobLiveSubjectHmacKeyVersionAuthority,
} from './mistral-conversation-subject-key-version.prisma';
import { fingerprintBobLiveSubjectHmacKey } from './mistral-conversation-subject-key-version';

const CURRENT_SECRET = 'legacy-HMAC-secret-kept-byte-for-byte-2026';
const CURRENT_FINGERPRINT = fingerprintBobLiveSubjectHmacKey(CURRENT_SECRET);
const HISTORICAL_SECRET = 'historical-HMAC-secret-kept-byte-for-byte-v1';
const HISTORICAL_FINGERPRINT = fingerprintBobLiveSubjectHmacKey(HISTORICAL_SECRET);

function keyRing(
  currentVersion = 1,
  secrets: Readonly<Record<number, string>> = { 1: CURRENT_SECRET },
) {
  return {
    currentVersion,
    versions: Object.keys(secrets).map(Number),
    secret: (version: number) => secrets[version] ?? null,
  };
}

function prismaReturning(
  minimumVersion: number,
  highestVersion = minimumVersion,
  inTransaction = false,
  options: {
    readonly rangePresent?: boolean;
    readonly admittedBindings?: readonly {
      readonly keyVersion: number;
      readonly keyFingerprint: string;
    }[];
    readonly retainedBindings?: readonly {
      readonly keyVersion: number;
      readonly keyFingerprint: string | null;
    }[];
  } = {},
) {
  const admittedBindings = options.admittedBindings ?? [{
    keyVersion: minimumVersion,
    keyFingerprint: CURRENT_FINGERPRINT,
  }];
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('retained_bob_live_subject_hmac_key_bindings')) {
        return options.retainedBindings ?? [];
      }
      if (sql.includes('FROM realtime_mistral_conversation_key_bindings')) {
        return admittedBindings;
      }
      return options.rangePresent === false ? [] : [{ minimumVersion, highestVersion }];
    }),
  } as unknown as Prisma.TransactionClient;
  const transaction = vi.fn(async (
    callback: (client: Prisma.TransactionClient) => Promise<void>,
  ) => callback(tx));
  const prisma = {
    inTransaction: vi.fn(() => inTransaction),
    $transaction: transaction,
  } as unknown as PrismaService;
  return { prisma, transaction, tx };
}

describe('PrismaBobLiveSubjectHmacKeyVersionAuthority', () => {
  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])(
    'refuse une version PostgreSQL invalide (%s)',
    (version) => {
      const { prisma } = prismaReturning(1);
      expect(() => new PrismaBobLiveSubjectHmacKeyVersionAuthority(
        prisma,
        keyRing(version),
      )).toThrow(/positive integer/u);
    },
  );

  it.each([
    'x'.repeat(31),
    `subject${'x'.repeat(30)} secret`,
    `[subject-${'x'.repeat(32)}]`,
    `subject-é-${'x'.repeat(32)}`,
  ])('refuse un matériau legacy invalide sans jamais le journaliser (%s)', (secret) => {
    const { prisma } = prismaReturning(1);
    expect(() => new PrismaBobLiveSubjectHmacKeyVersionAuthority(
      prisma,
      keyRing(1, { 1: secret }),
    )).toThrow('Bob Live subject HMAC key material is invalid.');
  });

  it('refuse de réutiliser le même matériau sous deux versions', () => {
    const { prisma } = prismaReturning(1);
    expect(() => new PrismaBobLiveSubjectHmacKeyVersionAuthority(
      prisma,
      keyRing(2, { 1: CURRENT_SECRET, 2: CURRENT_SECRET }),
    )).toThrow(/reuses key material/u);
  });

  it('empreinte les octets UTF-8 exacts sans décodage base64url', () => {
    expect(fingerprintBobLiveSubjectHmacKey(CURRENT_SECRET)).toBe(CURRENT_FINGERPRINT);
    expect(CURRENT_FINGERPRINT).not.toBe(
      fingerprintBobLiveSubjectHmacKey(`${CURRENT_SECRET}x`),
    );
  });

  it('refuse toute composition dans une transaction ambiante', async () => {
    const { prisma, transaction } = prismaReturning(1, 1, true);
    const authority = new PrismaBobLiveSubjectHmacKeyVersionAuthority(prisma, keyRing());

    await expect(authority.assertCurrentVersion()).rejects.toThrow(/root transaction/u);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('admet la version et son empreinte exactes dans la plage préparée', async () => {
    const { prisma, transaction, tx } = prismaReturning(1, 2, false, {
      admittedBindings: [
        { keyVersion: 1, keyFingerprint: HISTORICAL_FINGERPRINT },
        { keyVersion: 2, keyFingerprint: CURRENT_FINGERPRINT },
      ],
    });
    const authority = new PrismaBobLiveSubjectHmacKeyVersionAuthority(
      prisma,
      keyRing(2, { 1: HISTORICAL_SECRET, 2: CURRENT_SECRET }),
    );

    await expect(authority.assertCurrentVersion()).resolves.toBeUndefined();
    expect(transaction).toHaveBeenCalledOnce();
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('échoue fermée si la plage manque ou exclut la version', async () => {
    const { prisma: missing } = prismaReturning(1, 1, false, { rangePresent: false });
    await expect(new PrismaBobLiveSubjectHmacKeyVersionAuthority(
      missing,
      keyRing(),
    ).assertCurrentVersion()).rejects.toThrow(/not initialized/u);

    const { prisma: excluded } = prismaReturning(2, 3);
    await expect(new PrismaBobLiveSubjectHmacKeyVersionAuthority(
      excluded,
      keyRing(),
    ).assertCurrentVersion()).rejects.toThrow(/outside the admitted range 2-3/u);
  });

  it('refuse une empreinte absente, mal formée ou différente sans exposer le secret', async () => {
    const { prisma: missing } = prismaReturning(1, 1, false, { admittedBindings: [] });
    await expect(new PrismaBobLiveSubjectHmacKeyVersionAuthority(
      missing,
      keyRing(),
    ).assertCurrentVersion()).rejects.toThrow(/bindings are incomplete/u);

    for (const fingerprint of ['not-a-fingerprint', 'f'.repeat(64)]) {
      const { prisma } = prismaReturning(1, 1, false, {
        admittedBindings: [{ keyVersion: 1, keyFingerprint: fingerprint }],
      });
      await expect(new PrismaBobLiveSubjectHmacKeyVersionAuthority(
        prisma,
        keyRing(),
      ).assertCurrentVersion()).rejects.toThrow(
        'Bob Live subject HMAC key material does not match durable version 1.',
      );
    }
  });

  it('refuse le boot si une clé historique réellement retenue manque ou a changé', async () => {
    const retained = [{ keyVersion: 1, keyFingerprint: HISTORICAL_FINGERPRINT }];
    const database = () => prismaReturning(2, 2, false, {
      admittedBindings: [{ keyVersion: 2, keyFingerprint: CURRENT_FINGERPRINT }],
      retainedBindings: retained,
    }).prisma;

    await expect(new PrismaBobLiveSubjectHmacKeyVersionAuthority(
      database(),
      keyRing(2, { 2: CURRENT_SECRET }),
    ).assertCurrentVersion()).rejects.toThrow(/durable version 1/u);
    await expect(new PrismaBobLiveSubjectHmacKeyVersionAuthority(
      database(),
      keyRing(2, { 1: `${HISTORICAL_SECRET}x`, 2: CURRENT_SECRET }),
    ).assertCurrentVersion()).rejects.toThrow(/durable version 1/u);
  });

  it('admet le boot si chaque clé retenue est exacte, sans exiger les clés purgées', async () => {
    const { prisma } = prismaReturning(2, 2, false, {
      admittedBindings: [{ keyVersion: 2, keyFingerprint: CURRENT_FINGERPRINT }],
      retainedBindings: [{ keyVersion: 1, keyFingerprint: HISTORICAL_FINGERPRINT }],
    });
    const authority = new PrismaBobLiveSubjectHmacKeyVersionAuthority(
      prisma,
      keyRing(2, { 1: HISTORICAL_SECRET, 2: CURRENT_SECRET, 9: 'x'.repeat(40) }),
    );

    await expect(authority.assertCurrentVersion()).resolves.toBeUndefined();
  });
});

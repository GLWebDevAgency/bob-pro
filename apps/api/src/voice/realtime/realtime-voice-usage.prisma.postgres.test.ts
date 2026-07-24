import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { PrismaRealtimeVoiceUsageRepository } from './realtime-voice-usage.prisma';
import type { RealtimeVoiceUsageRepositoryInput } from './realtime-voice-usage';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_REALTIME_VOICE_USAGE_BATCH_CERT === 'true';
const CERT_DATABASE_KIND = process.env.REALTIME_VOICE_USAGE_CERT_DATABASE_KIND;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const EPHEMERAL_DATABASE = /^bob_ephemeral_[a-z0-9_]{1,48}$/u;

function certifiedEphemeralTarget(url: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} must be a canonical PostgreSQL URL.`);
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!LOOPBACK_HOSTS.has(parsed.hostname) || !EPHEMERAL_DATABASE.test(databaseName)) {
    throw new Error(
      `${label} must target loopback and a bob_ephemeral_* database; mutation certification refused.`,
    );
  }
  return databaseName;
}

if (RUN_POSTGRES_CERT) {
  if (CERT_DATABASE_KIND !== 'ephemeral') {
    throw new Error(
      'REALTIME_VOICE_USAGE_CERT_DATABASE_KIND=ephemeral is required: mutation certification refused.',
    );
  }
  const runtimeDatabase = certifiedEphemeralTarget(process.env.DATABASE_URL ?? '', 'DATABASE_URL');
  const directDatabase = certifiedEphemeralTarget(process.env.DIRECT_URL ?? '', 'DIRECT_URL');
  if (runtimeDatabase !== directDatabase) {
    throw new Error('DATABASE_URL and DIRECT_URL must target the same ephemeral database.');
  }
}

function company(id: string, discriminator: number) {
  const siren = String(randomInt(100_000_000, 999_999_999));
  return {
    id,
    name: `Realtime usage batch certification ${discriminator}`,
    legalForm: 'EI' as const,
    siren,
    siret: `${siren}${String(discriminator).padStart(5, '0')}`,
    trade: 'certification',
    vatRegime: 'reel_normal' as const,
    addrLine1: `${discriminator} rue de la Certification`,
    addrZip: '75001',
    addrCity: 'Paris',
  };
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Bob Live usage batch — certification PostgreSQL/RLS réelle',
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    const companyId = `usage-batch-${suffix}`;
    const otherCompanyId = `usage-other-${suffix}`;
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    let admin: PrismaClient;
    let runtime: PrismaService;
    let repository: PrismaRealtimeVoiceUsageRepository;

    function usage(
      dedupeKeyHmac: string,
      kind: RealtimeVoiceUsageRepositoryInput['kind'],
      amount: string,
      overrides: Partial<RealtimeVoiceUsageRepositoryInput> = {},
    ): RealtimeVoiceUsageRepositoryInput {
      const recordedAt = new Date();
      const occurredAt = new Date(recordedAt.getTime() - 1_000);
      const retentionExpiresAt = new Date(recordedAt.getTime() + 30 * 24 * 60 * 60 * 1_000);
      return {
        eventId: randomUUID(),
        companyId,
        subjectHash: 'a'.repeat(64),
        subjectKeyVersion: 1,
        sessionId,
        turnId,
        dedupeKeyHmac,
        proofKeyVersion: 1,
        plan: 'pro',
        kind,
        source: 'openai.realtime.native.response',
        amount,
        occurredAt: occurredAt.toISOString(),
        recordedAt: recordedAt.toISOString(),
        retentionExpiresAt: retentionExpiresAt.toISOString(),
        ...overrides,
      };
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
      }
      admin = new PrismaClient({ datasourceUrl: directUrl });
      runtime = new PrismaService({ datasourceUrl: runtimeUrl });
      repository = new PrismaRealtimeVoiceUsageRepository(runtime);
      await Promise.all([admin.$connect(), runtime.$connect()]);
      await admin.company.createMany({
        data: [company(companyId, 1), company(otherCompanyId, 2)],
      });
    }, 30_000);

    afterAll(async () => {
      if (admin) {
        await admin.realtimeVoiceUsageEvent.deleteMany({
          where: { companyId: { in: [companyId, otherCompanyId] } },
        }).catch(() => undefined);
        await admin.realtimeVoiceUsageDaily.deleteMany({
          where: { companyId: { in: [companyId, otherCompanyId] } },
        }).catch(() => undefined);
        await admin.company.deleteMany({
          where: { id: { in: [companyId, otherCompanyId] } },
        }).catch(() => undefined);
      }
      await Promise.allSettled([
        ...(runtime ? [runtime.$disconnect()] : []),
        ...(admin ? [admin.$disconnect()] : []),
      ]);
    });

    it('committe huit dimensions de coût, rollup exact, retry dédupliqué et RLS étanche', async () => {
      const batch = [
        usage('2'.repeat(64), 'realtime_uncached_text_tokens_in', '3.000000'),
        usage('3'.repeat(64), 'realtime_uncached_audio_tokens_in', '4.000000'),
        usage('4'.repeat(64), 'realtime_uncached_image_tokens_in', '1.000000'),
        usage('5'.repeat(64), 'realtime_cached_text_tokens_in', '1.000000'),
        usage('6'.repeat(64), 'realtime_cached_audio_tokens_in', '2.000000'),
        usage('7'.repeat(64), 'realtime_cached_image_tokens_in', '1.000000'),
        usage('8'.repeat(64), 'realtime_text_tokens_out', '2.000000'),
        usage('9'.repeat(64), 'realtime_audio_tokens_out', '6.000000'),
      ] as const;

      await expect(repository.recordBatch(batch)).resolves.toEqual({
        status: 'recorded',
        eventIds: batch.map((input) => input.eventId),
      });
      await expect(repository.recordBatch(batch)).resolves.toEqual({
        status: 'duplicate',
        eventIds: batch.map((input) => input.eventId),
      });

      const visible = await runtime.withTenant(companyId, async (tx) => {
        const [eventCount, daily] = await Promise.all([
          tx.realtimeVoiceUsageEvent.count({
            where: { companyId, dedupeKeyHmac: { in: batch.map((input) => input.dedupeKeyHmac) } },
          }),
          tx.realtimeVoiceUsageDaily.findMany({
            where: {
              companyId,
              source: 'openai.realtime.native.response',
              kind: { in: batch.map((input) => input.kind) },
            },
            orderBy: { kind: 'asc' },
          }),
        ]);
        return {
          eventCount,
          daily: daily.map((row) => ({
            kind: row.kind,
            amount: row.amount.toFixed(6),
            eventCount: Number(row.eventCount),
          })),
        };
      });
      const hidden = await runtime.withTenant(otherCompanyId, async (tx) => Promise.all([
        tx.realtimeVoiceUsageEvent.count({
          where: { companyId, dedupeKeyHmac: { in: batch.map((input) => input.dedupeKeyHmac) } },
        }),
        tx.realtimeVoiceUsageDaily.count({
          where: {
            companyId,
            source: 'openai.realtime.native.response',
            kind: { in: batch.map((input) => input.kind) },
          },
        }),
      ]));
      expect(visible).toEqual({
        eventCount: 8,
        daily: [...batch]
          .sort((left, right) => left.kind.localeCompare(right.kind))
          .map((input) => ({ kind: input.kind, amount: input.amount, eventCount: 1 })),
      });
      expect(hidden).toEqual([0, 0]);
    });

    it('rollback aussi la première insertion et son rollup si la seconde mesure est en conflit', async () => {
      const conflictingDedupe = 'f'.repeat(64);
      const existing = usage(conflictingDedupe, 'realtime_tokens_out', '8.000000');
      await expect(repository.record(existing)).resolves.toMatchObject({ status: 'recorded' });

      // Le tri du repository verrouille d'abord `1…`, puis rencontre la collision `f…` : ce cas
      // prouve qu'une insertion et son trigger ont réellement eu lieu avant le rollback.
      const firstOfRejectedBatch = usage('1'.repeat(64), 'llm_tokens_in', '4.000000');
      const conflictingSecond = usage(
        conflictingDedupe,
        'realtime_tokens_out',
        '9.000000',
        { eventId: randomUUID(), occurredAt: existing.occurredAt },
      );
      await expect(repository.recordBatch([firstOfRejectedBatch, conflictingSecond]))
        .resolves.toEqual({ status: 'conflict' });

      const [proof] = await admin.$queryRaw<Array<{ eventCount: number; rollupCount: number }>>`
        SELECT
          (SELECT count(*)::int FROM realtime_voice_usage_events
            WHERE "companyId" = ${companyId}
              AND "dedupeKeyHmac" = ${firstOfRejectedBatch.dedupeKeyHmac}) AS "eventCount",
          (SELECT count(*)::int FROM realtime_voice_usage_daily
            WHERE "companyId" = ${companyId}
              AND kind = ${firstOfRejectedBatch.kind}
              AND source = ${firstOfRejectedBatch.source}) AS "rollupCount"
      `;
      expect(proof).toEqual({ eventCount: 0, rollupCount: 0 });
    });
  },
);

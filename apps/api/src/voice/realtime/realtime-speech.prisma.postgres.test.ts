import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import type {
  RealtimeSpeechArtifactClaimInput,
  RealtimeSpeechArtifactReadyInput,
} from './realtime-speech-publisher';
import { PrismaRealtimeSpeechArtifactRepository } from './realtime-speech.prisma';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_REALTIME_SPEECH_CERT === 'true';

describe.skipIf(!RUN_POSTGRES_CERT)('Bob Live speech — certification PostgreSQL/RLS réelle', () => {
  const companyId = `speech-cert-${randomUUID()}`;
  const otherCompanyId = `speech-cert-${randomUUID()}`;
  const subjectHash = '1'.repeat(64);
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const contextDigest = '2'.repeat(64);
  const canonicalSpeechHmac = '3'.repeat(64);
  const factsHmac = '4'.repeat(64);
  const runtimeUrl = process.env.DATABASE_URL ?? '';
  const directUrl = process.env.DIRECT_URL ?? '';
  let admin: PrismaClient;
  let workers: PrismaService[] = [];
  let repositories: PrismaRealtimeSpeechArtifactRepository[] = [];

  beforeAll(async () => {
    if (!runtimeUrl || !directUrl) {
      throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
    }
    admin = new PrismaClient({ datasourceUrl: directUrl });
    workers = [
      new PrismaService({ datasourceUrl: runtimeUrl }),
      new PrismaService({ datasourceUrl: runtimeUrl }),
    ];
    repositories = workers.map((worker) => new PrismaRealtimeSpeechArtifactRepository(worker));
    await Promise.all([admin.$connect(), ...workers.map((worker) => worker.$connect())]);

    for (const [id, suffix] of [[companyId, 1], [otherCompanyId, 2]] as const) {
      const siren = String(randomInt(100_000_000, 999_999_999));
      await admin.company.create({
        data: {
          id,
          name: `Bob Speech PostgreSQL Certification ${suffix}`,
          legalForm: 'EI',
          siren,
          siret: `${siren}${String(suffix).padStart(5, '0')}`,
          trade: 'certification',
          vatRegime: 'reel_normal',
          addrLine1: `${suffix} rue de la Certification`,
          addrZip: '75001',
          addrCity: 'Paris',
        },
      });
    }

    await admin.$executeRaw`
      INSERT INTO realtime_session_leases (
        "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
        "providerCallId", "reservedAt", "leaseExpiresAt", "hardExpiresAt", "activatedAt",
        "contextSchemaVersion", "contextRevision", "contextPayload", "contextDigest",
        "contextUpdatedAt", "sidebandOwnerInstanceHash", "sidebandOwnerTokenHash",
        "sidebandOwnerLeaseExpiresAt", "contextAppliedRevision", "contextAppliedDigest",
        "contextAppliedAt", "sidebandProtocolVersion", "nextSpeechSequence", "updatedAt", version
      ) VALUES (
        ${companyId}, ${subjectHash}, ${sessionId}::uuid, ${'a'.repeat(64)}, 'active',
        ${`speech-cert-call-${sessionId}`}, clock_timestamp(),
        clock_timestamp() + interval '5 minutes', clock_timestamp() + interval '10 minutes',
        clock_timestamp(), 1, 7, ${JSON.stringify({ screen: { name: 'Certification' } })}::jsonb,
        ${contextDigest}, clock_timestamp(), ${'b'.repeat(64)}, ${'c'.repeat(64)},
        clock_timestamp() + interval '5 minutes', 7, ${contextDigest}, clock_timestamp(),
        2, 1, clock_timestamp(), 1
      )
    `;
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.$executeRaw`DELETE FROM realtime_speech_artifacts WHERE "companyId" = ${companyId}`.catch(() => undefined);
      await admin.$executeRaw`DELETE FROM realtime_session_leases WHERE "companyId" = ${companyId}`.catch(() => undefined);
      await admin.company.deleteMany({ where: { id: { in: [companyId, otherCompanyId] } } }).catch(() => undefined);
    }
    await Promise.allSettled([
      ...workers.map((worker) => worker.$disconnect()),
      ...(admin ? [admin.$disconnect()] : []),
    ]);
  });

  it('certifie le rôle runtime, FORCE RLS et la migration durable', async () => {
    const [role] = await workers[0]!.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const [shape] = await admin.$queryRaw<Array<{
      rowSecurity: boolean;
      forceRowSecurity: boolean;
      migrationApplied: boolean;
    }>>`
      SELECT cls.relrowsecurity AS "rowSecurity",
             cls.relforcerowsecurity AS "forceRowSecurity",
             EXISTS (
               SELECT 1 FROM _prisma_migrations
                WHERE migration_name = '20260713230000_realtime_durable_speech'
                  AND finished_at IS NOT NULL AND rolled_back_at IS NULL
             ) AS "migrationApplied"
        FROM pg_class AS cls
       WHERE cls.oid = 'realtime_speech_artifacts'::regclass
    `;
    expect(shape).toEqual({ rowSecurity: true, forceRowSecurity: true, migrationApplied: true });
  });

  it('sérialise les claims inter-répliques, alloue une séquence et finalise sous fence', async () => {
    const claims: RealtimeSpeechArtifactClaimInput[] = [0, 1].map((index) => ({
      companyId,
      subjectHash,
      sessionId,
      turnId,
      segmentIndex: 0,
      candidateArtifactId: randomUUID(),
      contextRevision: 7,
      contextDigest,
      classification: 'fixed_safe',
      canonicalSpeechHmac,
      factsHmac,
      renderTokenHash: String(5 + index).repeat(64),
    }));
    const results = await Promise.all(repositories.map((repository, index) => (
      repository.claimRender(claims[index]!)
    )));
    expect(results.filter((result) => result.status === 'claimed')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'busy')).toHaveLength(1);
    const winnerIndex = results.findIndex((result) => result.status === 'claimed');
    const winner = results[winnerIndex]!;
    if (winner.status !== 'claimed') throw new Error('Concurrent speech claim winner missing.');
    const winnerInput = claims[winnerIndex]!;

    const [allocation] = await admin.$queryRaw<Array<{ count: number; nextSequence: number }>>`
      SELECT count(*)::int AS count, max(lease."nextSpeechSequence")::int AS "nextSequence"
        FROM realtime_speech_artifacts AS artifact
        JOIN realtime_session_leases AS lease
          ON lease."companyId" = artifact."companyId" AND lease."sessionId" = artifact."sessionId"
       WHERE artifact."companyId" = ${companyId} AND artifact."sessionId" = ${sessionId}::uuid
    `;
    expect(allocation).toEqual({ count: 1, nextSequence: 2 });

    const ready: RealtimeSpeechArtifactReadyInput = {
      companyId,
      subjectHash,
      sessionId,
      turnId,
      artifactId: winner.artifactId,
      sequence: winner.sequence,
      renderTokenHash: winnerInput.renderTokenHash,
      contextRevision: 7,
      contextDigest,
      classification: 'fixed_safe',
      source: 'preapproved_static',
      storageKey: `companies/${companyId}/bob-live/${sessionId}/${turnId}/${winner.artifactId}`,
      mimeType: 'audio/mpeg',
      byteLength: 4_096,
      durationMs: 1_200,
      canonicalSpeechHmac,
      factsHmac,
      auditTranscriptHmac: null,
      evidenceHmac: '7'.repeat(64),
      audioSha256: '8'.repeat(64),
      proofKeyVersion: 1,
      synthesisAdapterId: 'bob.static.v1',
      synthesisTrustDomain: 'bob.assets',
      auditAdapterId: null,
      auditTrustDomain: null,
    };
    await expect(repositories[1 - winnerIndex]!.finalizeReady(ready)).resolves.toEqual({ status: 'ready' });
    await expect(repositories[winnerIndex]!.finalizeReady(ready)).resolves.toEqual({ status: 'ready' });

    const hidden = await workers[0]!.withTenant(otherCompanyId, async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count
          FROM realtime_speech_artifacts
         WHERE "companyId" = ${companyId}
      `;
      return row?.count ?? -1;
    });
    expect(hidden).toBe(0);
  }, 30_000);
});

import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { PrismaRealtimeSpeechArtifactRepository } from './realtime-speech.prisma';
import { PrismaRealtimeSpeechDeliveryRepository } from './realtime-speech-delivery.prisma';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_REALTIME_SPEECH_CERT === 'true';

describe.skipIf(!RUN_POSTGRES_CERT)('Bob Live delivery — certification PostgreSQL/RLS réelle', () => {
  const companyId = `delivery-cert-${randomUUID()}`;
  const otherCompanyId = `delivery-cert-${randomUUID()}`;
  const subjectHash = '1'.repeat(64);
  const sessionId = randomUUID();
  const contextDigest = '2'.repeat(64);
  const ownerTokenHash = '3'.repeat(64);
  const runtimeUrl = process.env.DATABASE_URL ?? '';
  const directUrl = process.env.DIRECT_URL ?? '';
  let admin: PrismaClient;
  let runtime: PrismaService;
  let publisher: PrismaRealtimeSpeechArtifactRepository;
  let delivery: PrismaRealtimeSpeechDeliveryRepository;

  beforeAll(async () => {
    if (!runtimeUrl || !directUrl) {
      throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
    }
    admin = new PrismaClient({ datasourceUrl: directUrl });
    runtime = new PrismaService({ datasourceUrl: runtimeUrl });
    publisher = new PrismaRealtimeSpeechArtifactRepository(runtime);
    delivery = new PrismaRealtimeSpeechDeliveryRepository(runtime);
    await Promise.all([admin.$connect(), runtime.$connect()]);

    for (const [id, suffix] of [[companyId, 1], [otherCompanyId, 2]] as const) {
      const siren = String(randomInt(100_000_000, 999_999_999));
      await admin.company.create({
        data: {
          id,
          name: `Bob Delivery PostgreSQL Certification ${suffix}`,
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
        "providerId", "providerCallId", "reservedAt", "leaseExpiresAt", "hardExpiresAt",
        "activatedAt", "contextSchemaVersion", "contextRevision", "contextPayload",
        "contextDigest", "contextUpdatedAt", "sidebandOwnerInstanceHash",
        "sidebandOwnerTokenHash", "sidebandOwnerLeaseExpiresAt", "sidebandOwnerEpoch",
        "contextAppliedRevision", "contextAppliedDigest", "contextAppliedAt",
        "contextAppliedOwnerEpoch", "sidebandProtocolVersion", "nextSpeechSequence",
        "updatedAt", version
      ) VALUES (
        ${companyId}, ${subjectHash}, ${sessionId}::uuid, ${'a'.repeat(64)}, 'active',
        'openai', ${`delivery-cert-call-${sessionId}`}, clock_timestamp(),
        clock_timestamp() + interval '5 minutes', clock_timestamp() + interval '10 minutes',
        clock_timestamp(), 1, 7, ${JSON.stringify({ screen: { name: 'Certification' } })}::jsonb,
        ${contextDigest}, clock_timestamp(), ${'b'.repeat(64)}, ${ownerTokenHash},
        clock_timestamp() + interval '5 minutes', 1, 7, ${contextDigest}, clock_timestamp(), 1,
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
      ...(runtime ? [runtime.$disconnect()] : []),
      ...(admin ? [admin.$disconnect()] : []),
    ]);
  });

  async function readyArtifact(turnId: string) {
    const renderTokenHash = randomUUID().replaceAll('-', '').padEnd(64, '0');
    const claim = await publisher.claimRender({
      companyId,
      subjectHash,
      sessionId,
      turnId,
      segmentIndex: 0,
      candidateArtifactId: randomUUID(),
      contextRevision: 7,
      contextDigest,
      sidebandOwnerTokenHash: ownerTokenHash,
      classification: 'fixed_safe',
      canonicalSpeechHmac: '4'.repeat(64),
      factsHmac: '5'.repeat(64),
      renderTokenHash,
    });
    if (claim.status !== 'claimed') throw new Error(`claim attendu, reçu ${claim.status}`);
    const storageKey = `companies/${companyId}/bob-live/${sessionId}/${turnId}/${claim.artifactId}`;
    const ready = {
      companyId,
      subjectHash,
      sessionId,
      turnId,
      artifactId: claim.artifactId,
      sequence: claim.sequence,
      renderTokenHash,
      contextRevision: 7,
      contextDigest,
      sidebandOwnerTokenHash: ownerTokenHash,
      classification: 'fixed_safe' as const,
      source: 'preapproved_static' as const,
      storageKey,
      mimeType: 'audio/mpeg' as const,
      byteLength: 4_096,
      durationMs: 1_200,
      canonicalSpeechHmac: '4'.repeat(64),
      factsHmac: '5'.repeat(64),
      auditTranscriptHmac: null,
      evidenceHmac: '6'.repeat(64),
      audioSha256: '7'.repeat(64),
      proofKeyVersion: 1,
      synthesisAdapterId: 'bob.static.v1',
      synthesisTrustDomain: 'bob.assets',
      auditAdapterId: null,
      auditTrustDomain: null,
    };
    await expect(publisher.finalizeReady(ready)).resolves.toEqual({ status: 'ready' });
    return ready;
  }

  it('lit sous RLS, revalide, livre une seule fois et rend le retry strictement idempotent', async () => {
    const turnId = randomUUID();
    const ready = await readyArtifact(turnId);
    const read = await delivery.readNext({ companyId, subjectHash, sessionId, afterSequence: 0 });
    expect(read.status).toBe('found');
    if (read.status !== 'found') throw new Error('artefact prêt attendu');
    expect(read.artifact).toMatchObject({
      artifactId: ready.artifactId,
      state: 'ready',
      fenceCurrent: true,
      sequence: ready.sequence,
      storageKey: ready.storageKey,
    });
    expect(await delivery.validateReadyFence({
      companyId,
      subjectHash,
      sessionId,
      turnId,
      artifactId: ready.artifactId,
      version: read.artifact.version,
      evidenceHmac: ready.evidenceHmac,
      audioSha256: ready.audioSha256,
      storageKey: ready.storageKey,
    })).toBe('current');

    const deliveryId = randomUUID();
    const mutation = {
      companyId,
      subjectHash,
      sessionId,
      turnId,
      artifactId: ready.artifactId,
      version: read.artifact.version,
      evidenceHmac: ready.evidenceHmac,
      audioSha256: ready.audioSha256,
      storageKey: ready.storageKey,
      deliveryId,
    };
    await expect(delivery.acknowledgeDelivery(mutation)).resolves.toMatchObject({
      status: 'delivered',
      idempotent: false,
      controlCurrent: false,
    });
    await expect(delivery.acknowledgeDelivery(mutation)).resolves.toMatchObject({
      status: 'delivered',
      idempotent: true,
    });
    await expect(delivery.acknowledgeDelivery({ ...mutation, deliveryId: randomUUID() }))
      .resolves.toEqual({ status: 'conflict' });

    const after = await delivery.readNext({ companyId, subjectHash, sessionId, afterSequence: 0 });
    expect(after).toMatchObject({ status: 'found', artifact: { state: 'delivered', deliveryId } });
    const hidden = await delivery.readNext({
      companyId: otherCompanyId,
      subjectHash,
      sessionId,
      afterSequence: 0,
    });
    expect(hidden).toEqual({ status: 'none' });

    const otherReady = await readyArtifact(randomUUID());
    const otherRead = await delivery.readExact({
      companyId,
      subjectHash,
      sessionId,
      turnId: otherReady.turnId,
      artifactId: otherReady.artifactId,
    });
    if (otherRead.status !== 'found') throw new Error('second artefact prêt attendu');
    await expect(delivery.acknowledgeDelivery({
      companyId,
      subjectHash,
      sessionId,
      turnId: otherReady.turnId,
      artifactId: otherReady.artifactId,
      version: otherRead.artifact.version,
      evidenceHmac: otherReady.evidenceHmac,
      audioSha256: otherReady.audioSha256,
      storageKey: otherReady.storageKey,
      deliveryId,
    })).resolves.toEqual({ status: 'conflict' });
  }, 30_000);

  it('annule ready de façon idempotente et interdit toute réécriture de cause', async () => {
    const turnId = randomUUID();
    const ready = await readyArtifact(turnId);
    const cancellationId = randomUUID();
    const input = {
      companyId,
      subjectHash,
      sessionId,
      turnId,
      artifactId: ready.artifactId,
      cancellationId,
      reason: 'barge_in' as const,
    };

    await expect(delivery.cancel(input)).resolves.toEqual({ status: 'cancelled', idempotent: false });
    await expect(delivery.cancel(input)).resolves.toEqual({ status: 'cancelled', idempotent: true });
    await expect(delivery.cancel({ ...input, cancellationId: randomUUID(), reason: 'user_cancel' }))
      .resolves.toEqual({ status: 'conflict' });
  }, 30_000);

  it('ferme le cinquième fence dès que le contexte appliqué change après lecture', async () => {
    const turnId = randomUUID();
    const ready = await readyArtifact(turnId);
    const read = await delivery.readExact({
      companyId,
      subjectHash,
      sessionId,
      turnId,
      artifactId: ready.artifactId,
    });
    expect(read.status).toBe('found');
    if (read.status !== 'found') throw new Error('artefact prêt attendu');

    const nextDigest = '8'.repeat(64);
    await admin.$executeRaw`
      UPDATE realtime_session_leases
         SET "contextRevision" = 8,
             "contextDigest" = ${nextDigest},
             "contextAppliedRevision" = 8,
             "contextAppliedDigest" = ${nextDigest},
             "contextAppliedAt" = clock_timestamp(),
             "contextAppliedOwnerEpoch" = 1,
             "contextUpdatedAt" = clock_timestamp(),
             "updatedAt" = clock_timestamp(),
             version = version + 1
       WHERE "companyId" = ${companyId} AND "sessionId" = ${sessionId}::uuid
    `;

    await expect(delivery.validateReadyFence({
      companyId,
      subjectHash,
      sessionId,
      turnId,
      artifactId: ready.artifactId,
      version: read.artifact.version,
      evidenceHmac: ready.evidenceHmac,
      audioSha256: ready.audioSha256,
      storageKey: ready.storageKey,
    })).resolves.toBe('terminal');
  }, 30_000);
});

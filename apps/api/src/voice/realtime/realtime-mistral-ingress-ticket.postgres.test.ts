import { randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import type { RealtimeAdmissionLease, RealtimeAdmissionPolicy } from './realtime-admission';
import { PrismaRealtimeAdmission } from './realtime-admission.prisma';
import {
  DEFAULT_MISTRAL_REALTIME_INGRESS_TICKET_POLICY,
  type MistralRealtimeIngressIdentityKeyRing,
  type MistralRealtimeIngressTicketBootstrap,
  type MistralRealtimeIngressTicketPolicy,
} from './realtime-mistral-ingress-ticket';
import { PrismaMistralRealtimeIngressTicketAuthority } from './realtime-mistral-ingress-ticket.prisma';
import { PrismaRealtimeSidebandOwner } from './realtime-sideband-owner.prisma';
import { PrismaRealtimeSpeechDeliveryRepository } from './realtime-speech-delivery.prisma';
import { PrismaRealtimeSpeechArtifactRepository } from './realtime-speech.prisma';
import { buildRealtimeSpeechStorageKey } from './realtime-speech-storage';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_MISTRAL_INGRESS_CERT === 'true';

const admissionPolicy: RealtimeAdmissionPolicy = {
  globalCapacity: {
    providerId: 'openai', providerModel: 'gpt-realtime-2.1',
    globalMaxSessions: 1_000, providerMaxSessions: 1_000, configVersion: 1,
  },
  userLimitPerMinute: 100,
  userLimitPerHour: 1_000,
  tenantLimitPerMinute: 1_000,
  tenantLimitPerHour: 10_000,
  reservationTtlSeconds: 30,
  activeLeaseSeconds: 60,
  heartbeatSeconds: 10,
  reaperLeaseSeconds: 30,
};

const ticketPolicy: MistralRealtimeIngressTicketPolicy = {
  ...DEFAULT_MISTRAL_REALTIME_INGRESS_TICKET_POLICY,
  maxOutstandingPerTenant: 25,
  maxIssuesPerTenantHour: 1_000,
};

const currentKeys: MistralRealtimeIngressIdentityKeyRing = {
  currentVersion: 4,
  secret: (version) => version === 4 ? 'm'.repeat(32) : null,
};

const wrongKeys: MistralRealtimeIngressIdentityKeyRing = {
  currentVersion: 5,
  secret: (version) => version === 5 ? 'w'.repeat(32) : null,
};

const context = {
  screen: { name: 'Accueil', instanceId: 'home:cert' },
  entities: [{ type: 'invoice', id: 'invoice-cert-1', label: 'Facture certification' }],
  capabilities: ['screen.read', 'invoice.read'],
};

describe.skipIf(!RUN_POSTGRES_CERT)('Bob Live Mistral ingress — certification PostgreSQL/FORCE RLS', () => {
  const companyId = `mistral-ticket-cert-${randomUUID()}`;
  const otherCompanyId = `mistral-ticket-cert-${randomUUID()}`;
  const runtimeUrl = process.env.DATABASE_URL ?? '';
  const directUrl = process.env.DIRECT_URL ?? '';
  let admin: PrismaClient;
  let workers: PrismaService[] = [];
  let admissions: PrismaRealtimeAdmission[] = [];
  let authorities: PrismaMistralRealtimeIngressTicketAuthority[] = [];

  beforeAll(async () => {
    if (!runtimeUrl || !directUrl) {
      throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
    }
    admin = new PrismaClient({ datasourceUrl: directUrl });
    workers = [
      new PrismaService({ datasourceUrl: runtimeUrl }),
      new PrismaService({ datasourceUrl: runtimeUrl }),
    ];
    admissions = workers.map((worker) => new PrismaRealtimeAdmission(worker, admissionPolicy));
    authorities = workers.map((worker) => new PrismaMistralRealtimeIngressTicketAuthority(
      worker,
      ticketPolicy,
      currentKeys,
    ));
    await Promise.all([admin.$connect(), ...workers.map((worker) => worker.$connect())]);
    for (const [id, suffix] of [[companyId, 7], [otherCompanyId, 8]] as const) {
      const siren = String(randomInt(100_000_000, 999_999_999));
      await admin.company.create({
        data: {
          id,
          name: `Bob Mistral Ticket Certification ${suffix}`,
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
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      // Le trigger de rétention bloque volontairement DELETE, y compris pour l'owner. La session
      // admin de certification le neutralise localement et uniquement pour ses propres fixtures.
      await admin.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.$executeRaw`
          DELETE FROM realtime_speech_artifacts
           WHERE "companyId" IN (${companyId}, ${otherCompanyId})
        `;
        await tx.realtimeMistralIngressTicket.deleteMany({
          where: { companyId: { in: [companyId, otherCompanyId] } },
        });
      }).catch(() => undefined);
      await admin.realtimeSessionLease.deleteMany({
        where: { companyId: { in: [companyId, otherCompanyId] } },
      }).catch(() => undefined);
      await admin.realtimeAdmissionEvent.deleteMany({
        where: { companyId: { in: [companyId, otherCompanyId] } },
      }).catch(() => undefined);
      await admin.company.deleteMany({
        where: { id: { in: [companyId, otherCompanyId] } },
      }).catch(() => undefined);
    }
    await Promise.allSettled([
      ...workers.map((worker) => worker.$disconnect()),
      ...(admin ? [admin.$disconnect()] : []),
    ]);
  });

  async function reserve(subject: string, worker = 0): Promise<RealtimeAdmissionLease> {
    const result = await admissions[worker]!.reserve({
      companyId,
      subjectHash: subject,
      maxSessionSeconds: 120,
      subjectHashCandidates: [subject],
      principalBindingHash: subject,
      agentMissionBinding: null,
    });
    if (!result.allowed) throw new Error(`Unexpected admission denial: ${result.denial}`);
    return result.lease;
  }

  async function issue(
    lease: RealtimeAdmissionLease,
    worker = 0,
    userId = 'auth-user-cert-1',
  ): Promise<MistralRealtimeIngressTicketBootstrap> {
    const result = await authorities[worker]!.issue({
      ...lease,
      userId,
      subjectKeyVersion: 9,
      plan: 'pro',
      contextSchemaVersion: 1,
      contextRevision: 7,
      context,
    });
    if (!result.ok) throw new Error(`Unexpected ticket denial: ${result.reason}`);
    return result.bootstrap;
  }

  it('certifie migration, FORCE RLS, triggers et absence de token/userId brut', async () => {
    const [role] = await workers[0]!.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const [shape] = await admin.$queryRaw<Array<{
      rowSecurity: boolean;
      forceRowSecurity: boolean;
      migrationApplied: boolean;
      transitionTrigger: boolean;
      insertTrigger: boolean;
      consumedLeaseGuard: boolean;
    }>>`
      SELECT cls.relrowsecurity AS "rowSecurity",
             cls.relforcerowsecurity AS "forceRowSecurity",
             EXISTS (
               SELECT 1 FROM _prisma_migrations
                WHERE migration_name = '20260714030000_realtime_mistral_ingress_tickets'
                  AND finished_at IS NOT NULL AND rolled_back_at IS NULL
             ) AS "migrationApplied",
             EXISTS (
               SELECT 1 FROM pg_trigger
                WHERE tgrelid = cls.oid
                  AND tgname = 'realtime_mistral_ingress_ticket_transition_guard'
                  AND NOT tgisinternal
             ) AS "transitionTrigger",
             EXISTS (
               SELECT 1 FROM pg_trigger
                WHERE tgrelid = cls.oid
                  AND tgname = 'realtime_mistral_ingress_ticket_insert_guard'
                  AND NOT tgisinternal
             ) AS "insertTrigger",
             EXISTS (
               SELECT 1 FROM pg_trigger
                WHERE tgrelid = 'realtime_session_leases'::regclass
                  AND tgname = 'realtime_session_lease_consumed_mistral_guard'
                  AND NOT tgisinternal
             ) AS "consumedLeaseGuard"
        FROM pg_class AS cls
       WHERE cls.oid = 'realtime_mistral_ingress_tickets'::regclass
    `;
    expect(shape).toEqual({
      rowSecurity: true,
      forceRowSecurity: true,
      migrationApplied: true,
      transitionTrigger: true,
      insertTrigger: true,
      consumedLeaseGuard: true,
    });
    const forbiddenColumns = await admin.$queryRaw<Array<{ columnName: string }>>`
      SELECT lower(column_name) AS "columnName"
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'realtime_mistral_ingress_tickets'
         AND lower(column_name) IN ('ticket', 'userid', 'user_id', 'leasetoken')
    `;
    expect(forbiddenColumns).toEqual([]);
  });

  it('consomme une fois, draine complete jusqu’à l’ACK puis libère atomiquement', async () => {
    const lease = await reserve('1'.repeat(64));
    const bootstrap = await issue(lease);
    const [stored] = await admin.$queryRaw<Array<{
      ciphertext: string;
      ticketHash: string;
    }>>`
      SELECT encode("userIdentityCiphertext", 'escape') AS ciphertext,
             "ticketHash"::text AS "ticketHash"
        FROM realtime_mistral_ingress_tickets
       WHERE "companyId" = ${companyId} AND "sessionId" = ${lease.sessionId}::uuid
    `;
    expect(stored?.ciphertext).not.toContain('auth-user-cert-1');
    expect(stored?.ticketHash).not.toBe(bootstrap.ticket);

    const hidden = await authorities[1]!.consume({
      companyId: otherCompanyId,
      ticket: bootstrap.ticket,
      protocol: bootstrap.protocol,
    });
    expect(hidden).toEqual({ ok: false, reason: 'invalid' });

    const results = await Promise.all(authorities.map((authority) => authority.consume({
      companyId,
      ticket: bootstrap.ticket,
      protocol: bootstrap.protocol,
    })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'replayed' }]);
    const winner = results.find((result) => result.ok);
    if (!winner?.ok) throw new Error('Ticket consume winner missing.');
    expect(winner.grant).toMatchObject({
      companyId,
      userId: 'auth-user-cert-1',
      subjectHash: '1'.repeat(64),
      subjectKeyVersion: 9,
      plan: 'pro',
      sessionId: lease.sessionId,
      contextRevision: 7,
    });
    const providerSessionId = `mistral_${randomUUID()}`;
    await expect(authorities[1]!.bindAndActivate({
      companyId,
      redemptionId: winner.grant.redemptionId,
      providerId: 'mistral',
      providerSessionId,
      contextRevision: winner.grant.contextRevision,
      contextDigest: winner.grant.contextDigest,
    })).resolves.toEqual({ ok: true });

    // Simule le sink réel : owner/context appliqué puis artefact ready lié au redemptionId.
    const ownerTokenHash = 'a'.repeat(64);
    const owners = new PrismaRealtimeSidebandOwner(workers[0]!);
    const owned = await owners.acquire({
      companyId,
      sessionId: lease.sessionId,
      ownerInstanceHash: 'b'.repeat(64),
      candidateOwnerTokenHash: ownerTokenHash,
      leaseSeconds: 300,
    });
    if (owned.status !== 'acquired') throw new Error(`Owner missing: ${owned.status}`);
    expect(await owners.applyContext(owned.owner, {
      revision: winner.grant.contextRevision,
      digest: winner.grant.contextDigest,
    })).toEqual({ status: 'applied' });
    const speech = new PrismaRealtimeSpeechArtifactRepository(workers[0]!);
    const renderTokenHash = 'c'.repeat(64);
    const claimed = await speech.claimRender({
      companyId,
      subjectHash: winner.grant.subjectHash,
      sessionId: lease.sessionId,
      turnId: winner.grant.redemptionId,
      segmentIndex: 0,
      candidateArtifactId: randomUUID(),
      contextRevision: winner.grant.contextRevision,
      contextDigest: winner.grant.contextDigest,
      sidebandOwnerTokenHash: ownerTokenHash,
      classification: 'fixed_safe',
      canonicalSpeechHmac: 'd'.repeat(64),
      factsHmac: 'e'.repeat(64),
      renderTokenHash,
    });
    if (claimed.status !== 'claimed') throw new Error(`Speech claim missing: ${claimed.status}`);
    const storageKey = buildRealtimeSpeechStorageKey({
      companyId,
      sessionId: lease.sessionId,
      turnId: winner.grant.redemptionId,
      artifactId: claimed.artifactId,
    });
    expect(await speech.finalizeReady({
      companyId,
      subjectHash: winner.grant.subjectHash,
      sessionId: lease.sessionId,
      turnId: winner.grant.redemptionId,
      artifactId: claimed.artifactId,
      sequence: claimed.sequence,
      renderTokenHash,
      contextRevision: winner.grant.contextRevision,
      contextDigest: winner.grant.contextDigest,
      sidebandOwnerTokenHash: ownerTokenHash,
      classification: 'fixed_safe',
      source: 'preapproved_static',
      storageKey,
      mimeType: 'audio/mpeg',
      byteLength: 4_096,
      durationMs: 1_000,
      canonicalSpeechHmac: 'd'.repeat(64),
      factsHmac: 'e'.repeat(64),
      auditTranscriptHmac: null,
      evidenceHmac: 'f'.repeat(64),
      audioSha256: '1'.repeat(64),
      proofKeyVersion: 1,
      synthesisAdapterId: 'bob.static.v1',
      synthesisTrustDomain: 'bob.assets',
      auditAdapterId: null,
      auditTrustDomain: null,
    })).toEqual({ status: 'ready' });

    await authorities[0]!.complete({
      companyId,
      redemptionId: winner.grant.redemptionId,
      providerSessionId,
      providerTermination: 'confirmed',
    });
    const [draining] = await admin.$queryRaw<Array<{
      state: string;
      leaseCount: number;
      leaseState: string | null;
    }>>`
      SELECT ticket.state,
             (SELECT count(*)::int FROM realtime_session_leases AS lease_row
               WHERE lease_row."companyId" = ticket."companyId"
                 AND lease_row."sessionId" = ticket."sessionId") AS "leaseCount",
             (SELECT state FROM realtime_session_leases AS lease_row
               WHERE lease_row."companyId" = ticket."companyId"
                 AND lease_row."sessionId" = ticket."sessionId") AS "leaseState"
        FROM realtime_mistral_ingress_tickets AS ticket
       WHERE ticket."companyId" = ${companyId} AND ticket.id = ${winner.grant.redemptionId}::uuid
    `;
    expect(draining).toEqual({ state: 'completed', leaseCount: 1, leaseState: 'active' });

    const delivery = new PrismaRealtimeSpeechDeliveryRepository(workers[1]!);
    const ready = await delivery.readExact({
      companyId,
      subjectHash: winner.grant.subjectHash,
      sessionId: lease.sessionId,
      turnId: winner.grant.redemptionId,
      artifactId: claimed.artifactId,
    });
    if (ready.status !== 'found') throw new Error(`Ready speech missing: ${ready.status}`);
    expect(await delivery.acknowledgeDelivery({
      companyId,
      subjectHash: winner.grant.subjectHash,
      sessionId: lease.sessionId,
      turnId: winner.grant.redemptionId,
      artifactId: claimed.artifactId,
      version: ready.artifact.version,
      evidenceHmac: 'f'.repeat(64),
      audioSha256: '1'.repeat(64),
      storageKey,
      deliveryId: randomUUID(),
    })).toMatchObject({ status: 'delivered', controlCurrent: false });
    const [released] = await admin.$queryRaw<Array<{ leaseCount: number }>>`
      SELECT count(*)::int AS "leaseCount" FROM realtime_session_leases
       WHERE "companyId" = ${companyId} AND "sessionId" = ${lease.sessionId}::uuid
    `;
    expect(released?.leaseCount).toBe(0);
    await expect(authorities[0]!.consume({
      companyId,
      ticket: bootstrap.ticket,
      protocol: bootstrap.protocol,
    })).resolves.toEqual({ ok: false, reason: 'replayed' });
  }, 30_000);

  it('ne brûle pas le one-shot si la réplique ne possède pas la keyVersion AEAD', async () => {
    const lease = await reserve('2'.repeat(64));
    const bootstrap = await issue(lease, 0, 'auth-user-rotation');
    const wrongReplica = new PrismaMistralRealtimeIngressTicketAuthority(
      workers[1]!,
      ticketPolicy,
      wrongKeys,
    );
    await expect(wrongReplica.consume({
      companyId,
      ticket: bootstrap.ticket,
      protocol: bootstrap.protocol,
    })).resolves.toEqual({ ok: false, reason: 'unavailable' });
    const [stillIssued] = await admin.$queryRaw<Array<{ state: string }>>`
      SELECT state FROM realtime_mistral_ingress_tickets
       WHERE "companyId" = ${companyId} AND "sessionId" = ${lease.sessionId}::uuid
    `;
    expect(stillIssued?.state).toBe('issued');

    const consumed = await authorities[0]!.consume({
      companyId,
      ticket: bootstrap.ticket,
      protocol: bootstrap.protocol,
    });
    if (!consumed.ok) throw new Error('Rotation recovery consume missing.');
    await authorities[1]!.abandon({
      companyId,
      redemptionId: consumed.grant.redemptionId,
      providerSessionId: null,
      providerTermination: 'not_created',
    });
  });

  it('persiste abandon unconfirmed et conserve le bail provider pour le reaper durable', async () => {
    const subjectHash = '3'.repeat(64);
    const lease = await reserve(subjectHash);
    const bootstrap = await issue(lease);
    const consumed = await authorities[0]!.consume({
      companyId,
      ticket: bootstrap.ticket,
      protocol: bootstrap.protocol,
    });
    if (!consumed.ok) throw new Error('Unconfirmed consume missing.');
    const providerSessionId = `mistral_${randomUUID()}`;
    expect(await authorities[0]!.bindAndActivate({
      companyId,
      redemptionId: consumed.grant.redemptionId,
      providerId: 'mistral',
      providerSessionId,
      contextRevision: consumed.grant.contextRevision,
      contextDigest: consumed.grant.contextDigest,
    })).toEqual({ ok: true });

    // Simule la course réelle : une autre réplique claim le bail juste avant que le gateway ne
    // persiste son abandon. Le terminal ticket doit survivre sans voler le fence du reaper.
    await admin.$executeRaw`
      UPDATE realtime_session_leases
         SET "leaseExpiresAt" = clock_timestamp(), "updatedAt" = clock_timestamp(),
             version = version + 1
       WHERE "companyId" = ${companyId} AND "sessionId" = ${lease.sessionId}::uuid
    `;
    const reaping = await admissions[0]!.claimExpired({ companyId });
    if (!reaping.ok) throw new Error('Reaping unavailable.');
    const claim = reaping.claims.find((candidate) => candidate.sessionId === lease.sessionId);
    expect(claim).toMatchObject({ providerId: 'mistral', providerCallId: providerSessionId });
    if (!claim) throw new Error('Mistral orphan reaping claim missing.');

    await authorities[1]!.abandon({
      companyId,
      redemptionId: consumed.grant.redemptionId,
      providerSessionId,
      providerTermination: 'unconfirmed',
    });
    const [persisted] = await admin.$queryRaw<Array<{
      ticketState: string;
      termination: string;
      leaseState: string;
      reaperFenced: boolean;
    }>>`
      SELECT ticket.state AS "ticketState", ticket."providerTermination" AS termination,
             lease.state AS "leaseState",
             lease."reaperTokenHash" IS NOT NULL AS "reaperFenced"
        FROM realtime_mistral_ingress_tickets AS ticket
        JOIN realtime_session_leases AS lease
          ON lease."companyId" = ticket."companyId" AND lease."sessionId" = ticket."sessionId"
       WHERE ticket."companyId" = ${companyId} AND ticket.id = ${consumed.grant.redemptionId}::uuid
    `;
    expect(persisted).toEqual({
      ticketState: 'abandoned',
      termination: 'unconfirmed',
      leaseState: 'reaping',
      reaperFenced: true,
    });
    expect(await admissions[1]!.completeReaping({
      companyId,
      subjectHash,
      sessionId: lease.sessionId,
      reaperToken: claim.reaperToken,
    })).toEqual({ ok: true, reason: null });
    const [ticketStillThere] = await admin.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM realtime_mistral_ingress_tickets
       WHERE "companyId" = ${companyId} AND id = ${consumed.grant.redemptionId}::uuid
    `;
    expect(ticketStillThere?.count).toBe(1);
  }, 30_000);

  it('empêche le cleanup admission de perdre un provider créé avant son bind durable', async () => {
    const subjectHash = '6'.repeat(64);
    const lease = await reserve(subjectHash);
    const bootstrap = await issue(lease);
    const consumed = await authorities[0]!.consume({
      companyId,
      ticket: bootstrap.ticket,
      protocol: bootstrap.protocol,
    });
    if (!consumed.ok) throw new Error('Pre-bind consume missing.');

    const deleted = await workers[1]!.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      return tx.$executeRaw`
        DELETE FROM realtime_session_leases
         WHERE "companyId" = ${companyId} AND "sessionId" = ${lease.sessionId}::uuid
      `;
    });
    expect(deleted).toBe(0);

    const providerSessionId = `mistral_${randomUUID()}`;
    await authorities[1]!.abandon({
      companyId,
      redemptionId: consumed.grant.redemptionId,
      providerSessionId,
      providerTermination: 'unconfirmed',
    });
    const [durable] = await admin.$queryRaw<Array<{
      ticketState: string;
      leaseState: string;
      providerSessionId: string;
    }>>`
      SELECT ticket.state AS "ticketState", lease.state AS "leaseState",
             lease."providerCallId" AS "providerSessionId"
        FROM realtime_mistral_ingress_tickets AS ticket
        JOIN realtime_session_leases AS lease
          ON lease."companyId" = ticket."companyId" AND lease."sessionId" = ticket."sessionId"
       WHERE ticket."companyId" = ${companyId} AND ticket.id = ${consumed.grant.redemptionId}::uuid
    `;
    expect(durable).toEqual({
      ticketState: 'abandoned',
      leaseState: 'bound',
      providerSessionId,
    });
    const reaping = await admissions[0]!.claimExpired({ companyId });
    if (!reaping.ok) throw new Error('Pre-bind reaping unavailable.');
    const claim = reaping.claims.find((candidate) => candidate.sessionId === lease.sessionId);
    if (!claim) throw new Error('Pre-bind Mistral orphan reaping claim missing.');
    await admissions[0]!.completeReaping({
      companyId,
      subjectHash,
      sessionId: lease.sessionId,
      reaperToken: claim.reaperToken,
    });
  }, 30_000);

  it('sérialise l’émission par tenant, applique le quota et protège les preuves par trigger', async () => {
    const quotaPolicy = { ...ticketPolicy, maxOutstandingPerTenant: 1 };
    const quotaAuthorities = workers.map((worker) => new PrismaMistralRealtimeIngressTicketAuthority(
      worker,
      quotaPolicy,
      currentKeys,
    ));
    const firstLease = await reserve('4'.repeat(64));
    const first = await quotaAuthorities[0]!.issue({
      ...firstLease,
      userId: 'auth-user-quota-1',
      subjectKeyVersion: 9,
      plan: 'business',
      contextSchemaVersion: 1,
      contextRevision: 1,
      context,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('First quota ticket missing.');
    const secondLease = await reserve('5'.repeat(64));
    await expect(quotaAuthorities[1]!.issue({
      ...secondLease,
      userId: 'auth-user-quota-2',
      subjectKeyVersion: 9,
      plan: 'business',
      contextSchemaVersion: 1,
      contextRevision: 1,
      context,
    })).resolves.toEqual({ ok: false, reason: 'quota' });

    await expect(admin.$executeRaw`
      UPDATE realtime_mistral_ingress_tickets
         SET "subjectKeyVersion" = "subjectKeyVersion" + 1, version = version + 1
       WHERE "companyId" = ${companyId} AND "sessionId" = ${firstLease.sessionId}::uuid
    `).rejects.toThrow(/authority evidence is immutable/u);

    const consumed = await quotaAuthorities[0]!.consume({
      companyId,
      ticket: first.bootstrap.ticket,
      protocol: first.bootstrap.protocol,
    });
    if (!consumed.ok) throw new Error('Quota cleanup consume missing.');
    await quotaAuthorities[0]!.abandon({
      companyId,
      redemptionId: consumed.grant.redemptionId,
      providerSessionId: null,
      providerTermination: 'not_created',
    });
    await admissions[0]!.release({ ...secondLease, providerTermination: 'not_created' });
  }, 30_000);
});

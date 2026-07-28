import { createHash, randomInt, randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  MISTRAL_CONVERSATION_PROTOCOL,
  encodeMistralConversationServerEvent,
} from '@bob/ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import type { RealtimeAdmissionLease, RealtimeAdmissionPolicy } from './realtime-admission';
import { PrismaRealtimeAdmission } from './realtime-admission.prisma';
import { PrismaMistralConversationDurableAuthority } from './mistral-conversation-authority.prisma';
import {
  deriveMistralConversationBootstrapReconciliationCapability,
} from './mistral-conversation-bootstrap-reconciliation';
import { PrismaMistralConversationBootstrapTicketAuthority } from './mistral-conversation-bootstrap-ticket.prisma';
import {
  DEFAULT_MISTRAL_CONVERSATION_BOOTSTRAP_TICKET_POLICY,
  hashMistralConversationBootstrapTicket,
  type MistralConversationBootstrapTicketIssueResult,
} from './mistral-conversation-bootstrap-ticket';
import type {
  MistralConversationBootstrapOpenResult,
} from './mistral-conversation-gateway-v2';
import { createMistralConversationDurableSession } from './mistral-conversation-gateway-v2';
import type {
  MistralConversationCompletionInput,
  MistralConversationCompletionResult,
  MistralConversationCompletionTransactionPort,
} from './mistral-conversation-completion';
import {
  sealMistralConversationOutboxPayload,
  type MistralConversationPersistenceKeyRing,
} from './mistral-conversation-outbox-seal';
import {
  fingerprintMistralConversationPersistenceKey,
  MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE,
} from './mistral-conversation-key-version.prisma';
import { PrismaMistralConversationResumeAuthority } from './mistral-conversation-resume-ticket.prisma';
import {
  DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY,
  hashMistralConversationResumeTicket,
  type MistralConversationBootstrapReconciliationResult,
  type MistralConversationRedeemAndOpenResult,
} from './mistral-conversation-resume-ticket';
import {
  sealMistralRealtimeUserIdentity,
  type MistralRealtimeIdentityBinding,
  type MistralRealtimeIngressIdentityKeyRing,
} from './realtime-mistral-ingress-ticket';

const RUN_POSTGRES_CERT =
  process.env.RUN_POSTGRES_MISTRAL_CONVERSATION_BOOTSTRAP_RECONCILIATION_CERT === 'true';
const CONTEXT = {
  screen: { name: '/devis/new', instanceId: 'reconciliation-postgres' },
  entities: [],
  capabilities: ['screen.read' as const],
};
const MAX_REPLAY_EVENTS = 256;
const MAX_REPLAY_BYTES = 240 * 1024;
const INT32_MAX = 0x7fff_ffff;
const RECONCILIATION_WRITER_ADVISORY_GATE = 1_904_726_114;
const admissionPolicy: RealtimeAdmissionPolicy = {
  globalCapacity: {
    providerId: 'openai', providerModel: 'gpt-realtime-2.1',
    globalMaxSessions: 1_000, providerMaxSessions: 1_000, configVersion: 1,
  },
  userLimitPerMinute: 40,
  userLimitPerHour: 200,
  tenantLimitPerMinute: 200,
  tenantLimitPerHour: 2_000,
  reservationTtlSeconds: 120,
  activeLeaseSeconds: 180,
  heartbeatSeconds: 30,
  reaperLeaseSeconds: 30,
};
const identityKeys: MistralRealtimeIngressIdentityKeyRing = {
  currentVersion: 1,
  secret: (version) => version === 1
    ? 'bootstrap-reconciliation-identity-v1'.repeat(2)
    : null,
};

class CertificationCompletionPort implements MistralConversationCompletionTransactionPort {
  async authorizeAndOpen(
    _tx: Prisma.TransactionClient,
    _input: MistralConversationCompletionInput,
  ): Promise<MistralConversationCompletionResult> {
    return { status: 'opened' };
  }
}

type IssuedBootstrap = Extract<
  MistralConversationBootstrapTicketIssueResult,
  { readonly status: 'issued' }
>;
type OpenedInitial = Extract<
  MistralConversationBootstrapOpenResult,
  { readonly status: 'opened' }
>;
type IssuedReconciliation = Extract<
  MistralConversationBootstrapReconciliationResult,
  { readonly status: 'issued' }
>;
type LiveTakeover = Extract<
  MistralConversationRedeemAndOpenResult,
  { readonly status: 'live_takeover' }
>;
type TerminalReplay = Extract<
  MistralConversationRedeemAndOpenResult,
  { readonly status: 'terminal_replay' }
>;

interface BootstrapFixture {
  readonly lease: RealtimeAdmissionLease;
  readonly issued: IssuedBootstrap;
  readonly userId: string;
}

function assertBootstrapIssued(
  result: MistralConversationBootstrapTicketIssueResult,
): asserts result is IssuedBootstrap {
  expect(result.status).toBe('issued');
  if (result.status !== 'issued') throw new Error(`Expected issued, received ${result.status}.`);
}

function assertInitialOpened(
  result: MistralConversationBootstrapOpenResult,
): asserts result is OpenedInitial {
  expect(result.status).toBe('opened');
  if (result.status !== 'opened') throw new Error(`Expected opened, received ${result.status}.`);
}

function assertReconciliationIssued(
  result: MistralConversationBootstrapReconciliationResult,
): asserts result is IssuedReconciliation {
  expect(result.status).toBe('issued');
  if (result.status !== 'issued') throw new Error(`Expected issued, received ${result.status}.`);
}

function assertLiveTakeover(
  result: MistralConversationRedeemAndOpenResult,
): asserts result is LiveTakeover {
  expect(result.status).toBe('live_takeover');
  if (result.status !== 'live_takeover') {
    throw new Error(`Expected live_takeover, received ${result.status}.`);
  }
}

function assertTerminalReplay(
  result: MistralConversationRedeemAndOpenResult,
): asserts result is TerminalReplay {
  expect(result.status).toBe('terminal_replay');
  if (result.status !== 'terminal_replay') {
    throw new Error(`Expected terminal_replay, received ${result.status}.`);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function expectPostgresError(
  error: unknown,
  sqlState: string,
  marker: string,
): void {
  const evidence = error as { code?: unknown; meta?: { code?: unknown; message?: unknown } };
  expect(evidence.code).toBe('P2010');
  expect(evidence.meta?.code).toBe(sqlState);
  expect(String(evidence.meta?.message)).toContain(marker);
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Bob Live Mistral v2 bootstrap reconciliation — certification PostgreSQL/RLS réelle',
  () => {
    const suffix = randomUUID().replaceAll('-', '');
    const companyId = `mcv2-reconcile-${suffix}`;
    const otherCompanyId = `mcv2-reconcile-other-${suffix}`;
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const completion = new CertificationCompletionPort();
    let admin: PrismaClient;
    let workers: [PrismaService, PrismaService];
    let admissions: [PrismaRealtimeAdmission, PrismaRealtimeAdmission];
    let durables: [
      PrismaMistralConversationDurableAuthority,
      PrismaMistralConversationDurableAuthority,
    ];
    let bootstraps: [
      PrismaMistralConversationBootstrapTicketAuthority,
      PrismaMistralConversationBootstrapTicketAuthority,
    ];
    let persistenceKeys: MistralConversationPersistenceKeyRing;
    let reconciliationMinimumVersion: number;
    let reconciliationKeyVersion: number;
    let reconciliationKeys: MistralConversationPersistenceKeyRing;
    let resumes: [
      PrismaMistralConversationResumeAuthority,
      PrismaMistralConversationResumeAuthority,
    ];
    let runtimeRole: string;
    let rotationAdmin: PrismaClient;

    function company(id: string, discriminator: number) {
      const siren = String(randomInt(100_000_000, 999_999_999));
      return {
        id,
        name: `Mistral reconciliation PostgreSQL certification ${discriminator}`,
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

    function digest(domain: string, label: string): string {
      return createHash('sha256')
        .update(`${domain}:${suffix}:${label}`, 'utf8')
        .digest('hex');
    }

    function subject(label: string): string {
      return digest('subject', label);
    }

    function owner(label: string): string {
      return createHash('sha256')
        .update(`owner:${suffix}:${label}`, 'utf8')
        .digest('base64url');
    }

    function reconciliationSecret(version: number): Uint8Array {
      return createHash('sha256')
        .update(`bob-cert-bootstrap-reconciliation-key-v${version}`, 'utf8')
        .digest();
    }

    function reconciliationKeyRing(
      currentVersion: number,
      retainedVersions: readonly number[],
    ): MistralConversationPersistenceKeyRing {
      const retained = new Set(retainedVersions);
      return {
        currentVersion,
        secret: (version) => retained.has(version) ? reconciliationSecret(version) : null,
      };
    }

    async function prepareReconciliationKeyRange(client: PrismaClient): Promise<{
      minimumVersion: number;
      highestVersion: number;
    }> {
      return client.$transaction(async (tx) => {
        // Cette suite est exclusivement une mutation-cert sur base jetable. Elle prépare elle-même
        // la seule transition additive nécessaire afin de ne dépendre d'aucun stage manuel externe.
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE}, 0)
          )
        `;
        const ranges = await tx.$queryRaw<Array<{
          minimumVersion: number;
          highestVersion: number;
        }>>`
          SELECT "minimumVersion", "highestVersion"
            FROM realtime_mistral_conversation_key_version_floors
           WHERE "keySpace" = ${MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE}
        `;
        const range = ranges[0];
        if (
          ranges.length !== 1
          || !range
          || !Number.isInteger(range.minimumVersion)
          || !Number.isInteger(range.highestVersion)
          || range.minimumVersion < 1
          || range.highestVersion < range.minimumVersion
          || range.highestVersion > INT32_MAX
        ) {
          throw new Error('Le registre de clé Mistral doit être initialisé avant ce test.');
        }
        if (range.highestVersion === range.minimumVersion + 1) return range;
        if (range.highestVersion !== range.minimumVersion) {
          throw new Error('La mutation-cert exige une plage Mistral stable ou additive.');
        }
        if (range.highestVersion >= INT32_MAX) {
          throw new Error('La rotation de certification exige une version de clé incrémentable.');
        }

        const nextVersion = range.highestVersion + 1;
        const fingerprint = fingerprintMistralConversationPersistenceKey(
          reconciliationSecret(nextVersion),
        );
        await tx.$executeRaw`
          INSERT INTO realtime_mistral_conversation_key_bindings (
            "keySpace", "keyVersion", "keyFingerprint"
          ) VALUES (
            ${MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE},
            ${nextVersion},
            ${fingerprint}
          )
          ON CONFLICT ("keySpace", "keyVersion") DO NOTHING
        `;
        const [binding] = await tx.$queryRaw<Array<{ keyFingerprint: string }>>`
          SELECT "keyFingerprint"
            FROM realtime_mistral_conversation_key_bindings
           WHERE "keySpace" = ${MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE}
             AND "keyVersion" = ${nextVersion}
        `;
        if (binding?.keyFingerprint !== fingerprint) {
          throw new Error(
            `Le binding Mistral v${nextVersion} ne correspond pas à la clé de certification.`,
          );
        }

        const staged = await tx.$queryRaw<Array<{
          minimumVersion: number;
          highestVersion: number;
        }>>`
          UPDATE realtime_mistral_conversation_key_version_floors
             SET "highestVersion" = ${nextVersion}
           WHERE "keySpace" = ${MISTRAL_CONVERSATION_PERSISTENCE_KEY_SPACE}
             AND "minimumVersion" = ${range.minimumVersion}
             AND "highestVersion" = ${range.highestVersion}
          RETURNING "minimumVersion", "highestVersion"
        `;
        const prepared = staged[0];
        if (
          staged.length !== 1
          || !prepared
          || prepared.minimumVersion !== range.minimumVersion
          || prepared.highestVersion !== nextVersion
        ) {
          throw new Error('La préparation additive Mistral de certification a échoué.');
        }
        return prepared;
      });
    }

    function resumeAuthority(
      worker: 0 | 1,
      keys: MistralConversationPersistenceKeyRing = reconciliationKeys,
      options: {
        readonly identityKeyRing?: MistralRealtimeIngressIdentityKeyRing;
        readonly beforeTicketConsume?: () => void | Promise<void>;
      } = {},
    ): PrismaMistralConversationResumeAuthority {
      return new PrismaMistralConversationResumeAuthority(
        workers[worker],
        durables[worker],
        {
          policy: {
            ...DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY,
            liveTakeoverEnabled: false,
          },
          reconciliationKeys: keys,
          reconciliationIdentityKeys: options.identityKeyRing ?? identityKeys,
          beforeTicketConsume: options.beforeTicketConsume,
        },
      );
    }

    async function reserve(
      worker: 0 | 1,
      label: string,
      maxSessionSeconds = 900,
      tenantId = companyId,
    ): Promise<RealtimeAdmissionLease> {
      const result = await admissions[worker].reserve({
        companyId: tenantId,
        subjectHash: subject(label),
        sessionId: randomUUID(),
        maxSessionSeconds,
        subjectHashCandidates: [subject(label)],
        principalBindingHash: subject(label),
        agentMissionBinding: null,
      });
      if (!result.allowed) throw new Error(`Unexpected admission denial: ${result.denial}`);
      return result.lease;
    }

    async function issueInitial(
      worker: 0 | 1,
      label: string,
      options: { readonly maxSessionSeconds?: number; readonly tenantId?: string } = {},
    ): Promise<BootstrapFixture> {
      const lease = await reserve(
        worker,
        label,
        options.maxSessionSeconds ?? 900,
        options.tenantId ?? companyId,
      );
      const userId = `user:${label}`;
      const result = await bootstraps[worker].issue({
        lease,
        userId,
        subjectKeyVersion: 1,
        plan: 'pro',
        contextSchemaVersion: 1,
        contextRevision: 1,
        context: CONTEXT,
      });
      assertBootstrapIssued(result);
      return { lease, issued: result, userId };
    }

    async function commitInitial(
      worker: 0 | 1,
      fixture: BootstrapFixture,
      label: string,
    ): Promise<OpenedInitial> {
      const result = await bootstraps[worker].redeemAndOpenInitial({
        companyId: fixture.lease.companyId,
        ticket: fixture.issued.bootstrap.ticket,
        protocol: fixture.issued.bootstrap.protocol,
        ownerLeaseToken: owner(label),
        resumeNextServerSequence: 0,
        maxReplayEvents: MAX_REPLAY_EVENTS,
        maxReplayBytes: MAX_REPLAY_BYTES,
        signal: new AbortController().signal,
      });
      assertInitialOpened(result);
      return result;
    }

    function reconciliationInput(
      fixture: BootstrapFixture,
      attempt: number,
      overrides: Partial<{
        readonly companyId: string;
        readonly userId: string;
      }> = {},
    ) {
      return {
        companyId: overrides.companyId ?? fixture.lease.companyId,
        userId: overrides.userId ?? fixture.userId,
        sessionHandle: fixture.issued.bootstrap.sessionHandle,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        bootstrapTicket: fixture.issued.bootstrap.ticket,
        attempt,
        signal: new AbortController().signal,
      };
    }

    async function redeem(
      authority: PrismaMistralConversationResumeAuthority,
      issued: IssuedReconciliation,
    ): Promise<MistralConversationRedeemAndOpenResult> {
      return authority.redeemAndOpen({
        companyId: issued.bootstrap.companyId,
        ticket: issued.bootstrap.ticket,
        protocol: issued.bootstrap.protocol,
        expectedScope: issued.bootstrap.scope,
        resumeNextServerSequence: issued.bootstrap.resumeNextServerSequence,
        maxReplayEvents: MAX_REPLAY_EVENTS,
        maxReplayBytes: MAX_REPLAY_BYTES,
        signal: new AbortController().signal,
      });
    }

    async function waitUntil(instant: string, marginMs = 150): Promise<void> {
      const delay = Math.max(0, Date.parse(instant) - Date.now() + marginMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    async function waitForRuntimeLockWait(timeoutMs = 5_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const [row] = await admin.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (
            SELECT 1
              FROM pg_stat_activity AS activity
             WHERE activity.datname = current_database()
               AND activity.usename = ${runtimeRole}
               AND cardinality(pg_blocking_pids(activity.pid)) > 0
          ) AS blocked
        `;
        if (row?.blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('The competing reconciliation never reached a PostgreSQL lock wait.');
    }

    async function waitForRetirementLockWait(timeoutMs = 5_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const [row] = await admin.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (
            SELECT 1
              FROM pg_stat_activity AS activity
             WHERE activity.datname = current_database()
               AND activity.query LIKE
                 '%UPDATE realtime_mistral_conversation_key_version_floors%'
               AND cardinality(pg_blocking_pids(activity.pid)) > 0
          ) AS blocked
        `;
        if (row?.blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('The retirement never waited behind the reconciliation writer.');
    }

    async function insertReplayGraceExpiredFixture(
      label: string,
    ): Promise<BootstrapFixture> {
      const bootstrapId = randomUUID();
      const admissionSessionId = randomUUID();
      const missionId = randomUUID();
      const rawTicket = `b2_${createHash('sha256')
        .update(`synthetic-b2:${suffix}:${label}`, 'utf8')
        .digest('base64url')}`;
      const subjectHash = subject(`synthetic-${label}`);
      const userId = `user:synthetic:${label}`;
      const contextDigest = digest('context', `synthetic-${label}`);
      const identityBinding: MistralRealtimeIdentityBinding = {
        companyId,
        subjectHash,
        subjectKeyVersion: 1,
        sessionId: admissionSessionId,
        redemptionId: bootstrapId,
        plan: 'pro',
        contextRevision: 1,
        contextDigest,
      };
      const identity = sealMistralRealtimeUserIdentity(
        userId,
        identityBinding,
        identityKeys,
        () => new Uint8Array(12).fill(17),
      );
      const [clock] = await admin.$queryRaw<Array<{ databaseNow: Date }>>`
        SELECT clock_timestamp() AS "databaseNow"
      `;
      if (!clock) throw new Error('Missing PostgreSQL clock.');
      const createdAt = clock.databaseNow;
      const ticketExpiresAt = new Date(createdAt.getTime() + 1_000);
      const consumedAt = new Date(createdAt.getTime() + 10);
      const hardExpiresAt = new Date(createdAt.getTime() + 4_000);
      const replayGraceExpiresAt = new Date(createdAt.getTime() + 6_000);
      const grant = {
        bootstrapId,
        admissionSessionId,
        companyId,
        subjectHash,
        subjectKeyVersion: 1,
        plan: 'pro' as const,
        sessionHandle: admissionSessionId,
        hardExpiresAt: hardExpiresAt.toISOString(),
        contextRevision: 1,
        contextDigest,
        routeMode: 'push_to_talk' as const,
        fullDuplexCertified: false as const,
        maxMissionAudioBytes: 320,
      };
      const created = createMistralConversationDurableSession({
        grant,
        missionConnectionEpoch: 1,
      });
      const ready = created.events[0];
      if (!ready) throw new Error('Missing synthetic session.ready.');
      const encodedReady = encodeMistralConversationServerEvent(ready);
      const payloadBytes = Buffer.byteLength(encodedReady, 'utf8');
      const sealedReady = sealMistralConversationOutboxPayload(
        encodedReady,
        {
          companyId,
          sessionHandle: admissionSessionId,
          serverSequence: 0,
          eventType: 'session.ready',
          payloadBytes,
        },
        persistenceKeys,
        () => new Uint8Array(12).fill(23),
      );

      await workers[0].withTenant(companyId, async (tx) => {
        // Fixture bornée dédiée à G : elle passe toutes les contraintes de production mais évite
        // d'attendre 24 h. Les preuves atomiques bootstrap/Mission sont certifiées séparément.
        await tx.$executeRaw`
          INSERT INTO realtime_mistral_conversation_bootstrap_tickets (
            id, "companyId", "admissionSessionId", "sessionHandle", "subjectHash",
            "subjectKeyVersion", "admissionLeaseTokenHash", "ticketHash", protocol, state, plan,
            "contextSchemaVersion", "contextRevision", "contextSnapshot", "contextDigest",
            "userIdentityCiphertext", "userIdentityNonce", "userIdentityTag",
            "identityEncryptionKeyVersion", "routeMode", "fullDuplexCertified",
            "maxMissionAudioBytes", "issuedAt", "ticketExpiresAt", "leaseExpiresAt",
            "hardExpiresAt", "consumedAt", "retentionExpiresAt", version, "updatedAt"
          ) VALUES (
            ${bootstrapId}::uuid, ${companyId}, ${admissionSessionId}::uuid,
            ${admissionSessionId}, ${subjectHash}, 1, ${digest('lease', label)},
            ${hashMistralConversationBootstrapTicket(rawTicket)},
            ${MISTRAL_CONVERSATION_PROTOCOL}, 'consumed', 'pro', 1, 1,
            ${JSON.stringify({ version: 1, revision: 1, context: CONTEXT })}::jsonb,
            ${contextDigest}, ${Buffer.from(identity.ciphertext)}, ${Buffer.from(identity.nonce)},
            ${Buffer.from(identity.tag)}, ${identity.keyVersion}, 'push_to_talk', false, 320,
            ${createdAt}, ${ticketExpiresAt}, ${hardExpiresAt}, ${hardExpiresAt}, ${consumedAt},
            ${replayGraceExpiresAt}, 2, ${consumedAt}
          )
        `;
        await tx.$executeRaw`
          INSERT INTO realtime_mistral_conversation_missions (
            id, "companyId", "initialBootstrapId", "admissionSessionId", protocol,
            "subjectHash", "subjectKeyVersion", plan, "sessionHandle", "ownerTokenHash",
            "ownerAcquiredAt", "missionConnectionEpoch", version,
            "acknowledgedServerSequence", "retainedFromServerSequence", "nextServerSequence",
            "nextProviderSequence", "snapshotSchemaVersion", phase, "contextRevision",
            "contextDigest", "routeMode", "fullDuplexCertified", "maxMissionAudioBytes",
            "audioBytes", "missionState", "turnState", "finalTranscriptRecorded",
            "terminalReason", "terminalServerSequence", "closedAt", "hardExpiresAt",
            "replayGraceExpiresAt", "retentionExpiresAt", "createdAt", "updatedAt"
          ) VALUES (
            ${missionId}::uuid, ${companyId}, ${bootstrapId}::uuid,
            ${admissionSessionId}::uuid, ${MISTRAL_CONVERSATION_PROTOCOL}, ${subjectHash}, 1,
            'pro', ${admissionSessionId}, ${digest('owner-token', label)}, ${createdAt}, 1, 1,
            0, 0, 1, 0, 1, 'ready', 1, ${contextDigest}, 'push_to_talk', false, 320, 0,
            ${JSON.stringify(created.snapshot.mission)}::jsonb, NULL, false, NULL, NULL, NULL,
            ${hardExpiresAt}, ${replayGraceExpiresAt}, ${replayGraceExpiresAt},
            ${createdAt}, ${createdAt}
          )
        `;
        await tx.$executeRaw`
          INSERT INTO realtime_mistral_conversation_outbox (
            "companyId", "missionId", "sessionHandle", "serverSequence", "eventType",
            "payloadCiphertext", "payloadNonce", "payloadTag", "encryptionKeyVersion",
            "payloadBytes", "createdAt", "retentionExpiresAt"
          ) VALUES (
            ${companyId}, ${missionId}::uuid, ${admissionSessionId}, 0, 'session.ready',
            ${Buffer.from(sealedReady.ciphertext)}, ${Buffer.from(sealedReady.nonce)},
            ${Buffer.from(sealedReady.tag)}, ${sealedReady.keyVersion}, ${payloadBytes},
            ${createdAt}, ${replayGraceExpiresAt}
          )
        `;
      });

      return {
        lease: {
          companyId,
          subjectHash,
          sessionId: admissionSessionId,
          leaseToken: owner(`synthetic-lease-${label}`),
          state: 'reserved',
          leaseExpiresAt: hardExpiresAt.toISOString(),
          hardExpiresAt: hardExpiresAt.toISOString(),
        },
        issued: {
          status: 'issued',
          bootstrap: {
            companyId,
            sessionHandle: admissionSessionId,
            ticket: rawTicket,
            protocol: MISTRAL_CONVERSATION_PROTOCOL,
            ticketExpiresAt: ticketExpiresAt.toISOString(),
            hardExpiresAt: hardExpiresAt.toISOString(),
            contextRevision: 1,
            contextDigest,
            routeMode: 'push_to_talk',
            fullDuplexCertified: false,
            maxMissionAudioBytes: 320,
          },
        },
        userId,
      };
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
      }
      admin = new PrismaClient({ datasourceUrl: directUrl });
      rotationAdmin = new PrismaClient({ datasourceUrl: directUrl });
      workers = [
        new PrismaService({ datasourceUrl: runtimeUrl }),
        new PrismaService({ datasourceUrl: runtimeUrl }),
      ];
      admissions = workers.map((worker) => (
        new PrismaRealtimeAdmission(worker, admissionPolicy)
      )) as typeof admissions;
      await Promise.all([
        admin.$connect(),
        rotationAdmin.$connect(),
        ...workers.map((worker) => worker.$connect()),
      ]);
      const floor = await prepareReconciliationKeyRange(rotationAdmin);
      reconciliationMinimumVersion = floor.minimumVersion;
      reconciliationKeyVersion = floor.highestVersion;
      if (reconciliationKeyVersion >= INT32_MAX) {
        throw new Error('La rotation de certification exige une version de clé encore incrémentable.');
      }
      persistenceKeys = {
        currentVersion: reconciliationKeyVersion,
        secret: (version) => version === reconciliationKeyVersion
          ? reconciliationSecret(reconciliationKeyVersion)
          : null,
      };
      reconciliationKeys = reconciliationKeyRing(
        reconciliationKeyVersion,
        [reconciliationKeyVersion],
      );
      durables = workers.map((worker) => new PrismaMistralConversationDurableAuthority(
        worker,
        completion,
        persistenceKeys,
      )) as typeof durables;
      bootstraps = workers.map((worker, index) => (
        new PrismaMistralConversationBootstrapTicketAuthority(
          worker,
          durables[index]!,
          identityKeys,
          DEFAULT_MISTRAL_CONVERSATION_BOOTSTRAP_TICKET_POLICY,
        )
      )) as typeof bootstraps;
      resumes = [resumeAuthority(0), resumeAuthority(1)];
      const [role] = await workers[0].$queryRaw<Array<{ currentRole: string }>>`
        SELECT current_user AS "currentRole"
      `;
      if (!role) throw new Error('Missing runtime role.');
      runtimeRole = role.currentRole;
      await admin.company.createMany({
        data: [company(companyId, 1), company(otherCompanyId, 2)],
      });
    }, 30_000);

    afterAll(async () => {
      // Base de certification jetable : aucune désactivation des triggers ni suppression anticipée
      // des preuves retenues. Le rituel PostgreSQL détruit la base entière après la suite.
      await Promise.allSettled([
        ...((workers ?? []) as PrismaService[]).map((worker) => worker.$disconnect()),
        ...(rotationAdmin ? [rotationAdmin.$disconnect()] : []),
        ...(admin ? [admin.$disconnect()] : []),
      ]);
    });

    it('réconcilie le commit initial tardif une fois, sous FORCE RLS, sans persister b2/r2', async () => {
      const [role] = await workers[0].$queryRaw<Array<{
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
      `;
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      const tables = await admin.$queryRaw<Array<{
        name: string;
        rowSecurity: boolean;
        forceRowSecurity: boolean;
      }>>`
        SELECT relname AS name, relrowsecurity AS "rowSecurity",
               relforcerowsecurity AS "forceRowSecurity"
          FROM pg_class
         WHERE oid IN (
           'realtime_mistral_conversation_bootstrap_tickets'::regclass,
           'realtime_mistral_conversation_resume_tickets'::regclass
         )
         ORDER BY relname
      `;
      expect(tables).toHaveLength(2);
      expect(tables.every((table) => table.rowSecurity && table.forceRowSecurity)).toBe(true);

      const fixture = await issueInitial(0, 'late-commit-idempotent');
      await expect(resumes[0].reconcileInitialBootstrap(
        reconciliationInput(fixture, 1),
      )).resolves.toEqual({ status: 'retry_initial' });
      const [beforeCommit] = await admin.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count
          FROM realtime_mistral_conversation_missions
         WHERE "companyId" = ${companyId}
           AND "sessionHandle" = ${fixture.issued.bootstrap.sessionHandle}
      `;
      expect(beforeCommit?.count).toBe(0);

      await commitInitial(0, fixture, 'late-commit-idempotent');
      const results = await Promise.all([
        resumes[0].reconcileInitialBootstrap(reconciliationInput(fixture, 1)),
        resumes[1].reconcileInitialBootstrap(reconciliationInput(fixture, 1)),
      ]);
      const first = results[0];
      const second = results[1];
      assertReconciliationIssued(first);
      assertReconciliationIssued(second);
      expect(second.bootstrap).toEqual(first.bootstrap);
      expect(first.bootstrap.scope).toBe('live_takeover');
      expect(first.bootstrap.clientAcceptedMissionConnectionEpoch).toBe(0);
      expect(first.bootstrap.resumeNextServerSequence).toBe(0);

      const [evidence] = await admin.$queryRaw<Array<{
        count: number;
        ticketHash: string;
        rowJson: string;
        keyVersion: number;
      }>>`
        SELECT count(*)::int AS count, min(btrim("ticketHash")) AS "ticketHash",
               min(to_jsonb(ticket)::text) AS "rowJson",
               min("reconciliationKeyVersion")::int AS "keyVersion"
          FROM realtime_mistral_conversation_resume_tickets AS ticket
         WHERE "companyId" = ${companyId}
           AND "initialBootstrapId" = (
             SELECT id FROM realtime_mistral_conversation_bootstrap_tickets
              WHERE "companyId" = ${companyId}
                AND "ticketHash" = ${hashMistralConversationBootstrapTicket(
                  fixture.issued.bootstrap.ticket,
                )}
           )
           AND "reconciliationAttempt" = 1
      `;
      expect(evidence).toMatchObject({
        count: 1,
        ticketHash: hashMistralConversationResumeTicket(first.bootstrap.ticket),
        keyVersion: reconciliationKeyVersion,
      });
      expect(evidence?.rowJson).not.toContain(first.bootstrap.ticket);
      expect(evidence?.rowJson).not.toContain(fixture.issued.bootstrap.ticket);
      expect(evidence?.rowJson).not.toContain(fixture.userId);
    }, 30_000);

    it('masque tenant, utilisateur et échec AEAD sans aucune mutation durable', async () => {
      const fixture = await issueInitial(0, 'identity-fences');
      await commitInitial(0, fixture, 'identity-fences');
      const evidence = async () => {
        const [row] = await admin.$queryRaw<Array<{
          bootstrapVersion: number;
          missionVersion: bigint;
          resumeCount: number;
        }>>`
          SELECT bootstrap.version AS "bootstrapVersion",
                 mission.version AS "missionVersion",
                 (SELECT count(*)::int
                    FROM realtime_mistral_conversation_resume_tickets AS resume
                   WHERE resume."companyId" = bootstrap."companyId"
                     AND resume."initialBootstrapId" = bootstrap.id) AS "resumeCount"
            FROM realtime_mistral_conversation_bootstrap_tickets AS bootstrap
            JOIN realtime_mistral_conversation_missions AS mission
              ON mission."initialBootstrapId" = bootstrap.id
           WHERE bootstrap."companyId" = ${companyId}
             AND bootstrap."ticketHash" = ${hashMistralConversationBootstrapTicket(
               fixture.issued.bootstrap.ticket,
             )}
        `;
        return row;
      };
      const before = await evidence();
      expect(before).toMatchObject({ bootstrapVersion: 2, resumeCount: 0 });

      await expect(resumes[0].reconcileInitialBootstrap(reconciliationInput(fixture, 1, {
        companyId: otherCompanyId,
      }))).resolves.toEqual({ status: 'not_found' });
      await expect(resumes[0].reconcileInitialBootstrap(reconciliationInput(fixture, 1, {
        userId: 'user:someone-else',
      }))).resolves.toEqual({ status: 'forbidden' });
      const wrongIdentityAuthority = resumeAuthority(0, reconciliationKeys, {
        identityKeyRing: {
          currentVersion: 1,
          secret: (version) => version === 1 ? 'wrong-identity-key'.repeat(4) : null,
        },
      });
      await expect(wrongIdentityAuthority.reconcileInitialBootstrap(
        reconciliationInput(fixture, 1),
      )).resolves.toEqual({ status: 'forbidden' });
      expect(await evidence()).toEqual(before);

      const crossTenantVisibility = await workers[0].withTenant(otherCompanyId, async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ count: number }>>`
          SELECT count(*)::int AS count
            FROM realtime_mistral_conversation_bootstrap_tickets
           WHERE "ticketHash" = ${hashMistralConversationBootstrapTicket(
             fixture.issued.bootstrap.ticket,
           )}
        `;
        return row?.count ?? -1;
      });
      expect(crossTenantVisibility).toBe(0);
    }, 30_000);

    it('garde la reprise standard fermée mais autorise le ticket spécial, puis avance attempt', async () => {
      const fixture = await issueInitial(0, 'special-live-only');
      const opened = await commitInitial(0, fixture, 'special-live-only');
      await expect(resumes[0].issue({
        companyId,
        subjectHash: fixture.lease.subjectHash,
        subjectKeyVersion: 1,
        sessionHandle: fixture.issued.bootstrap.sessionHandle,
        clientAcceptedMissionConnectionEpoch: opened.snapshot.missionConnectionEpoch,
        resumeNextServerSequence: 0,
        signal: new AbortController().signal,
      })).resolves.toEqual({ status: 'unavailable' });
      const [standardCount] = await admin.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count
          FROM realtime_mistral_conversation_resume_tickets
         WHERE "companyId" = ${companyId}
           AND "sessionHandle" = ${fixture.issued.bootstrap.sessionHandle}
           AND purpose = 'standard_resume'
      `;
      expect(standardCount?.count).toBe(0);

      const attempt1 = await resumes[0].reconcileInitialBootstrap(
        reconciliationInput(fixture, 1),
      );
      assertReconciliationIssued(attempt1);
      expect(attempt1.bootstrap.expectedMissionConnectionEpoch).toBe(1);
      const takeover = await redeem(resumes[1], attempt1);
      assertLiveTakeover(takeover);
      expect(takeover.snapshot.missionConnectionEpoch).toBe(2);

      await expect(resumes[0].reconcileInitialBootstrap(
        reconciliationInput(fixture, 1),
      )).resolves.toEqual({ status: 'attempt_consumed' });
      const attempt2 = await resumes[0].reconcileInitialBootstrap(
        reconciliationInput(fixture, 2),
      );
      assertReconciliationIssued(attempt2);
      expect(attempt2.bootstrap.expectedMissionConnectionEpoch).toBe(2);
      expect(attempt2.bootstrap.clientAcceptedMissionConnectionEpoch).toBe(0);
      expect(attempt2.bootstrap.ticket).not.toBe(attempt1.bootstrap.ticket);

      const rows = await admin.$queryRaw<Array<{
        attempt: number;
        state: string;
        consumedEpoch: number | null;
      }>>`
        SELECT "reconciliationAttempt" AS attempt, state,
               "consumedMissionConnectionEpoch" AS "consumedEpoch"
          FROM realtime_mistral_conversation_resume_tickets
         WHERE "companyId" = ${companyId}
           AND "sessionHandle" = ${fixture.issued.bootstrap.sessionHandle}
         ORDER BY "reconciliationAttempt"
      `;
      expect(rows).toEqual([
        { attempt: 1, state: 'consumed', consumedEpoch: 2 },
        { attempt: 2, state: 'issued', consumedEpoch: null },
      ]);
    }, 30_000);

    it('re-dérive une tentative issued avec son ancienne clé après rotation', async () => {
      const fixture = await issueInitial(0, 'key-rotation');
      await commitInitial(0, fixture, 'key-rotation');
      const beforeRotation = await resumes[0].reconcileInitialBootstrap(
        reconciliationInput(fixture, 1),
      );
      assertReconciliationIssued(beforeRotation);

      const rotatedVersion = reconciliationKeyVersion + 1;
      const rotatedAuthority = resumeAuthority(
        1,
        reconciliationKeyRing(rotatedVersion, [reconciliationKeyVersion, rotatedVersion]),
      );
      const afterRotation = await rotatedAuthority.reconcileInitialBootstrap(
        reconciliationInput(fixture, 1),
      );
      assertReconciliationIssued(afterRotation);
      expect(afterRotation.bootstrap).toEqual(beforeRotation.bootstrap);
      const expected = deriveMistralConversationBootstrapReconciliationCapability({
        secret: reconciliationSecret(reconciliationKeyVersion),
        keyVersion: reconciliationKeyVersion,
        companyId,
        subjectHash: fixture.lease.subjectHash,
        initialBootstrapId: (await admin.$queryRaw<Array<{ id: string }>>`
          SELECT id::text AS id
            FROM realtime_mistral_conversation_bootstrap_tickets
           WHERE "companyId" = ${companyId}
             AND "ticketHash" = ${hashMistralConversationBootstrapTicket(
               fixture.issued.bootstrap.ticket,
             )}
        `)[0]!.id,
        sessionHandle: fixture.issued.bootstrap.sessionHandle,
        attempt: 1,
      });
      expect(afterRotation.bootstrap.ticket).toBe(expected.ticket);
      const [persisted] = await admin.$queryRaw<Array<{ keyVersion: number }>>`
        SELECT "reconciliationKeyVersion" AS "keyVersion"
          FROM realtime_mistral_conversation_resume_tickets
         WHERE "companyId" = ${companyId}
           AND "sessionHandle" = ${fixture.issued.bootstrap.sessionHandle}
           AND "reconciliationAttempt" = 1
      `;
      expect(persisted?.keyVersion).toBe(reconciliationKeyVersion);
    }, 30_000);

    it('sérialise retirement contre un r2 ancien puis restitue le même ticket après perte de réponse', async () => {
      expect(reconciliationMinimumVersion).toBeLessThan(reconciliationKeyVersion);
      const fixture = await issueInitial(0, 'key-floor-response-loss');
      await commitInitial(0, fixture, 'key-floor-response-loss');
      const oldKeyAuthority = resumeAuthority(
        0,
        reconciliationKeyRing(
          reconciliationMinimumVersion,
          [reconciliationMinimumVersion],
        ),
      );

      await admin.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS "01_bob_test_pause_mistral_reconciliation_writer"
          ON realtime_mistral_conversation_resume_tickets
      `);
      await admin.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION bob_test_pause_mistral_reconciliation_writer()
        RETURNS trigger
        LANGUAGE plpgsql
        SET search_path = pg_catalog, public
        AS $function$
        BEGIN
          PERFORM pg_advisory_xact_lock(${RECONCILIATION_WRITER_ADVISORY_GATE});
          RETURN NEW;
        END;
        $function$
      `);
      await admin.$executeRawUnsafe(`
        CREATE TRIGGER "01_bob_test_pause_mistral_reconciliation_writer"
        BEFORE INSERT ON realtime_mistral_conversation_resume_tickets
        FOR EACH ROW EXECUTE FUNCTION bob_test_pause_mistral_reconciliation_writer()
      `);

      const gateAcquired = deferred<void>();
      const releaseGate = deferred<void>();
      let gate: Promise<unknown> | null = null;
      try {
        gate = admin.$transaction(async (tx) => {
          await tx.$executeRaw`
            SELECT pg_advisory_xact_lock(${RECONCILIATION_WRITER_ADVISORY_GATE})
          `;
          gateAcquired.resolve();
          await releaseGate.promise;
        }, { timeout: 15_000 });
        await gateAcquired.promise;

        const firstResponse = oldKeyAuthority.reconcileInitialBootstrap(
          reconciliationInput(fixture, 1),
        );
        await waitForRuntimeLockWait();

        const retirement = rotationAdmin.$queryRaw<Array<{
          minimumVersion: number;
          highestVersion: number;
        }>>`
          UPDATE realtime_mistral_conversation_key_version_floors
             SET "minimumVersion" = ${reconciliationKeyVersion}
           WHERE "keySpace" = 'mistral-conversation-persistence-v1'
             AND "minimumVersion" = ${reconciliationMinimumVersion}
             AND "highestVersion" = ${reconciliationKeyVersion}
          RETURNING "minimumVersion", "highestVersion"
        `.then(
          (value) => ({ value, error: null as unknown }),
          (error: unknown) => ({ value: null, error }),
        );
        await waitForRetirementLockWait();

        releaseGate.resolve();
        await gate;
        const issued = await firstResponse;
        assertReconciliationIssued(issued);

        const retirementResult = await retirement;
        expect(retirementResult.value).toBeNull();
        expectPostgresError(
          retirementResult.error,
          '23514',
          'MISTRAL_CONVERSATION_RECONCILIATION_KEY_VERSION_RETAINED',
        );

        // Simule la réponse HTTP perdue : le nouveau replica garde l'ancienne matière, relit la
        // ligne issued et doit restituer octet pour octet la même capacité sans second INSERT.
        const rotatedAuthority = resumeAuthority(
          1,
          reconciliationKeyRing(
            reconciliationKeyVersion,
            [reconciliationMinimumVersion, reconciliationKeyVersion],
          ),
        );
        const retried = await rotatedAuthority.reconcileInitialBootstrap(
          reconciliationInput(fixture, 1),
        );
        assertReconciliationIssued(retried);
        expect(retried.bootstrap).toEqual(issued.bootstrap);

        const [persisted] = await admin.$queryRaw<Array<{
          count: number;
          keyVersion: number;
        }>>`
          SELECT count(*)::int AS count,
                 min("reconciliationKeyVersion")::int AS "keyVersion"
            FROM realtime_mistral_conversation_resume_tickets
           WHERE "companyId" = ${companyId}
             AND "sessionHandle" = ${fixture.issued.bootstrap.sessionHandle}
             AND "reconciliationAttempt" = 1
        `;
        expect(persisted).toEqual({
          count: 1,
          keyVersion: reconciliationMinimumVersion,
        });
      } finally {
        releaseGate.resolve();
        await gate?.catch(() => undefined);
        await admin.$executeRawUnsafe(`
          DROP TRIGGER IF EXISTS "01_bob_test_pause_mistral_reconciliation_writer"
            ON realtime_mistral_conversation_resume_tickets
        `).catch(() => undefined);
        await admin.$executeRawUnsafe(`
          DROP FUNCTION IF EXISTS bob_test_pause_mistral_reconciliation_writer()
        `).catch(() => undefined);
      }
    }, 30_000);

    it('bascule à terminal_replay après H et refuse toute réconciliation à G', async () => {
      const terminalFixture = await issueInitial(0, 'terminal-h', { maxSessionSeconds: 7 });
      await commitInitial(0, terminalFixture, 'terminal-h');
      const graceExpiredFixture = await insertReplayGraceExpiredFixture('terminal-g');

      await Promise.all([
        waitUntil(terminalFixture.issued.bootstrap.hardExpiresAt),
        waitUntil(new Date(
          Date.parse(graceExpiredFixture.issued.bootstrap.hardExpiresAt) + 2_000,
        ).toISOString()),
      ]);
      const terminalTicket = await resumes[0].reconcileInitialBootstrap(
        reconciliationInput(terminalFixture, 1),
      );
      assertReconciliationIssued(terminalTicket);
      expect(terminalTicket.bootstrap.scope).toBe('terminal_replay');
      const terminal = await redeem(resumes[1], terminalTicket);
      assertTerminalReplay(terminal);
      expect(terminal.terminal.reason).toBe('expired');

      await expect(resumes[0].reconcileInitialBootstrap(
        reconciliationInput(graceExpiredFixture, 1),
      )).resolves.toEqual({ status: 'expired' });
    }, 30_000);

    it('sérialise redeem attempt1 contre issue attempt2 sans cycle de locks', async () => {
      const fixture = await issueInitial(0, 'deadlock-fence');
      await commitInitial(0, fixture, 'deadlock-fence');
      const attempt1 = await resumes[0].reconcileInitialBootstrap(
        reconciliationInput(fixture, 1),
      );
      assertReconciliationIssued(attempt1);

      let releaseConsume: (() => void) | undefined;
      let signalConsumeReached: (() => void) | undefined;
      const consumeReached = new Promise<void>((resolve) => { signalConsumeReached = resolve; });
      const consumeReleased = new Promise<void>((resolve) => { releaseConsume = resolve; });
      const pausingRedeemer = resumeAuthority(0, reconciliationKeys, {
        beforeTicketConsume: async () => {
          signalConsumeReached?.();
          await consumeReleased;
        },
      });
      const redeemPromise = redeem(pausingRedeemer, attempt1);
      await consumeReached;
      const attempt2Promise = resumes[1].reconcileInitialBootstrap(
        reconciliationInput(fixture, 2),
      );
      try {
        await waitForRuntimeLockWait();
      } finally {
        releaseConsume?.();
      }
      const [redeemed, attempt2] = await Promise.all([redeemPromise, attempt2Promise]);
      assertLiveTakeover(redeemed);
      assertReconciliationIssued(attempt2);
      expect(attempt2.bootstrap.expectedMissionConnectionEpoch).toBe(2);

      const rows = await admin.$queryRaw<Array<{ attempt: number; state: string }>>`
        SELECT "reconciliationAttempt" AS attempt, state
          FROM realtime_mistral_conversation_resume_tickets
         WHERE "companyId" = ${companyId}
           AND "sessionHandle" = ${fixture.issued.bootstrap.sessionHandle}
         ORDER BY "reconciliationAttempt"
      `;
      expect(rows).toEqual([
        { attempt: 1, state: 'consumed' },
        { attempt: 2, state: 'issued' },
      ]);
    }, 30_000);
  },
);

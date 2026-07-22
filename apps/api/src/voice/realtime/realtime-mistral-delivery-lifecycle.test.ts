import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import type { RealtimeAdmissionPolicy } from './realtime-admission';
import { PrismaRealtimeAdmission } from './realtime-admission.prisma';
import {
  DEFAULT_MISTRAL_REALTIME_INGRESS_TICKET_POLICY,
  type MistralRealtimeIngressIdentityKeyRing,
} from './realtime-mistral-ingress-ticket';
import { PrismaMistralRealtimeIngressTicketAuthority } from './realtime-mistral-ingress-ticket.prisma';
import { PrismaRealtimeSpeechDeliveryRepository } from './realtime-speech-delivery.prisma';

const COMPANY = 'company-a';
const SUBJECT = '1'.repeat(64);
const CONTEXT = '2'.repeat(64);
const OWNER = '3'.repeat(64);
const SESSION = '10000000-0000-4000-8000-000000000001';
const TURN = '20000000-0000-4000-8000-000000000002';
const ARTIFACT = '30000000-0000-4000-8000-000000000003';
const DELIVERY = '40000000-0000-4000-8000-000000000004';
const PROVIDER_SESSION = 'mistral_session_1';
const NOW = new Date('2026-07-14T10:00:00.000Z');

type SqlMock = ReturnType<typeof vi.fn>;

function sqlAt(mock: SqlMock, index: number): string {
  const strings = mock.mock.calls[index]?.[0] as readonly string[] | undefined;
  return strings?.join('?').replace(/\s+/gu, ' ').trim() ?? '';
}

function prismaHarness(input: {
  readonly queries?: readonly unknown[];
  readonly executions?: readonly unknown[];
}) {
  const queries = [...(input.queries ?? [])];
  const executions = [...(input.executions ?? [])];
  const queryRaw = vi.fn(async (strings: readonly string[]) => {
    const sql = strings.join('');
    if (sql.includes("set_config('statement_timeout'")) {
      return [{ statementTimeout: '3s', lockTimeout: '1s' }];
    }
    if (sql.includes('realtime_reaper_tenant_schedule') && sql.includes('FOR UPDATE')) {
      return [];
    }
    if (queries.length === 0) throw new Error('Unexpected query.');
    return queries.shift();
  });
  const executeRaw = vi.fn(async () => {
    if (executions.length === 0) throw new Error('Unexpected execution.');
    return executions.shift();
  });
  const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw } as unknown as Prisma.TransactionClient;
  const withTenant = vi.fn(async (
    _companyId: string,
    operation: (client: Prisma.TransactionClient) => Promise<unknown>,
  ) => operation(tx));
  const withIsolatedTenant = vi.fn(async (
    _companyId: string,
    operation: (client: Prisma.TransactionClient) => Promise<unknown>,
  ) => operation(tx));
  return {
    prisma: { withTenant, withIsolatedTenant } as unknown as PrismaService,
    queryRaw,
    executeRaw,
  };
}

function ticket(state = 'active') {
  return {
    id: TURN,
    companyId: COMPANY,
    subjectHash: SUBJECT,
    subjectKeyVersion: 1,
    sessionId: SESSION,
    state,
    plan: 'pro',
    contextRevision: 7,
    contextDigest: CONTEXT,
    userIdentityCiphertext: Uint8Array.of(1),
    userIdentityNonce: new Uint8Array(12),
    userIdentityTag: new Uint8Array(16),
    identityEncryptionKeyVersion: 1,
    maxAudioBytes: 32_000,
    providerSessionId: PROVIDER_SESSION,
    providerTermination: null,
    ticketExpiresAt: new Date(NOW.getTime() - 1_000),
    bindingExpiresAt: new Date(NOW.getTime() + 60_000),
    hardExpiresAt: new Date(NOW.getTime() + 240_000),
    consumedAt: new Date(NOW.getTime() - 20_000),
    activatedAt: new Date(NOW.getTime() - 10_000),
    finishedAt: null,
    version: 3,
  };
}

function lease() {
  return {
    state: 'active',
    providerId: 'mistral',
    providerCallId: PROVIDER_SESSION,
    leaseExpiresAt: new Date(NOW.getTime() + 240_000),
    hardExpiresAt: new Date(NOW.getTime() + 240_000),
    contextRevision: 7,
    contextDigest: CONTEXT,
    contextAppliedRevision: 7,
    contextAppliedDigest: CONTEXT,
    contextAppliedOwnerEpoch: 2,
    sidebandOwnerEpoch: 2,
    sidebandOwnerTokenHash: OWNER,
    sidebandOwnerLeaseExpiresAt: new Date(NOW.getTime() + 180_000),
    sidebandProtocolVersion: 2,
  };
}

function artifact(state: 'ready' | 'delivered' | 'cancelled' = 'ready') {
  return {
    state,
    storageExpiresAt: new Date(NOW.getTime() + 600_000),
    contextRevision: 7,
    contextDigest: CONTEXT,
    sidebandOwnerEpoch: 2,
    sidebandOwnerTokenHash: OWNER,
  };
}

const keys: MistralRealtimeIngressIdentityKeyRing = {
  currentVersion: 1,
  secret: (version) => version === 1 ? 'k'.repeat(32) : null,
};

const admissionPolicy: RealtimeAdmissionPolicy = {
  userLimitPerMinute: 10,
  userLimitPerHour: 100,
  tenantLimitPerMinute: 100,
  tenantLimitPerHour: 1_000,
  reservationTtlSeconds: 15,
  activeLeaseSeconds: 30,
  heartbeatSeconds: 10,
  reaperLeaseSeconds: 30,
};

describe('Bob Live Mistral — cycle terminaison puis livraison', () => {
  it('conserve un drain ready borné par le hard-expiry et l owner, sans DELETE précoce', async () => {
    const h = prismaHarness({
      queries: [[ticket()], [artifact()], [lease()], [{ databaseNow: NOW }]],
      executions: [1, 1],
    });
    const authority = new PrismaMistralRealtimeIngressTicketAuthority(
      h.prisma,
      DEFAULT_MISTRAL_REALTIME_INGRESS_TICKET_POLICY,
      keys,
    );

    await expect(authority.complete({
      companyId: COMPANY,
      redemptionId: TURN,
      providerSessionId: PROVIDER_SESSION,
      providerTermination: 'confirmed',
    })).resolves.toBeUndefined();

    expect(h.executeRaw).toHaveBeenCalledTimes(2);
    expect(sqlAt(h.executeRaw, 0)).toMatch(/UPDATE realtime_session_leases/u);
    expect(sqlAt(h.executeRaw, 0)).toMatch(/"sidebandOwnerLeaseExpiresAt" >=/u);
    expect(sqlAt(h.executeRaw, 0)).toMatch(/"hardExpiresAt" >=/u);
    expect(sqlAt(h.executeRaw, 1)).toMatch(/UPDATE realtime_mistral_ingress_tickets/u);
    expect(h.executeRaw.mock.calls.map((_call, index) => sqlAt(h.executeRaw, index)).join(' '))
      .not.toMatch(/DELETE FROM realtime_session_leases/u);
    const drainValues = h.executeRaw.mock.calls[0]!.slice(1);
    expect(drainValues).toContainEqual(new Date(NOW.getTime() + 180_000));
  });

  it('ACK ready -> delivered puis libère le drain completed dans la même transaction', async () => {
    const lockedArtifact = {
      state: 'ready',
      contextRevision: 7,
      contextDigest: CONTEXT,
      sidebandOwnerEpoch: 2,
      sidebandOwnerTokenHash: OWNER,
      storageKey: `companies/${COMPANY}/bob-live/${SESSION}/${TURN}/${ARTIFACT}`,
      storageExpiresAt: new Date(NOW.getTime() + 60_000),
      objectPurgedAt: null,
      evidenceHmac: '5'.repeat(64),
      audioSha256: '6'.repeat(64),
      deliveryId: null,
      cancellationId: null,
      cancellationReasonCode: null,
      version: 4,
    };
    const h = prismaHarness({
      queries: [
        [{
          state: 'completed',
          subjectHash: SUBJECT,
          providerSessionId: PROVIDER_SESSION,
          providerTermination: 'confirmed',
          contextRevision: 7,
          contextDigest: CONTEXT,
        }],
        [lockedArtifact],
        [{ ok: true }],
        [{ contextRevision: 7, contextDigest: CONTEXT }],
      ],
      executions: [1],
    });
    const repository = new PrismaRealtimeSpeechDeliveryRepository(h.prisma);

    await expect(repository.acknowledgeDelivery({
      companyId: COMPANY,
      subjectHash: SUBJECT,
      sessionId: SESSION,
      turnId: TURN,
      artifactId: ARTIFACT,
      version: 4,
      evidenceHmac: '5'.repeat(64),
      audioSha256: '6'.repeat(64),
      storageKey: lockedArtifact.storageKey,
      deliveryId: DELIVERY,
    })).resolves.toEqual({
      status: 'delivered',
      idempotent: false,
      controlCurrent: false,
      contextRevision: 7,
      contextDigest: CONTEXT,
    });

    expect(sqlAt(h.queryRaw, 0)).toMatch(/realtime_mistral_ingress_tickets/u);
    expect(sqlAt(h.queryRaw, 1)).toMatch(/realtime_speech_artifacts/u);
    expect(sqlAt(h.executeRaw, 0)).toMatch(/DELETE FROM realtime_session_leases/u);
    expect(sqlAt(h.executeRaw, 0)).toMatch(/pending\.state IN \('rendering', 'ready'\)/u);
    expect(sqlAt(h.executeRaw, 0)).toMatch(/realtime_control_grants AS control_grant/u);
    expect(sqlAt(h.executeRaw, 0)).toMatch(/realtime_control_consumptions AS consumption/u);
  });

  it('le reaper supprime un drain expiré confirmed avant la sélection des claims provider', async () => {
    const h = prismaHarness({
      queries: [[]],
      // tenant lock, journal, reserved stale, completed Mistral drain
      executions: [0, 0, 0, 1, 1],
    });
    const admission = new PrismaRealtimeAdmission(h.prisma, admissionPolicy);

    await expect(admission.claimExpired({ companyId: COMPANY, limit: 10 }))
      .resolves.toEqual({ ok: true, claims: [] });

    expect(h.executeRaw).toHaveBeenCalledTimes(5);
    const terminalCleanup = sqlAt(h.executeRaw, 3);
    expect(terminalCleanup).toMatch(/JOIN realtime_mistral_ingress_tickets AS ticket/u);
    expect(terminalCleanup).toMatch(/ticket\.state IN \('completed', 'abandoned'\)/u);
    expect(terminalCleanup).toMatch(/ticket\."providerTermination" = 'confirmed'/u);
    expect(terminalCleanup).toMatch(/FOR UPDATE OF lease SKIP LOCKED/u);
    expect(terminalCleanup).toMatch(/LIMIT \?/u);
    expect(terminalCleanup).toMatch(/DELETE FROM realtime_session_leases AS lease USING candidates/u);
    expect(sqlAt(h.queryRaw, 0)).toMatch(/set_config\('statement_timeout'/u);
    expect(sqlAt(h.queryRaw, 1)).toMatch(/FOR UPDATE SKIP LOCKED/u);
  });
});

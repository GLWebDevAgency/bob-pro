import type { Prisma } from '@prisma/client';
import { MISTRAL_CONVERSATION_PROTOCOL } from '@bob/ai';
import { describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { PrismaMistralConversationDurableAuthority } from './mistral-conversation-authority.prisma';
import {
  deriveMistralConversationBootstrapReconciliationCapability,
} from './mistral-conversation-bootstrap-reconciliation';
import {
  hashMistralConversationBootstrapTicket,
} from './mistral-conversation-bootstrap-ticket';
import { PrismaMistralConversationResumeAuthority } from './mistral-conversation-resume-ticket.prisma';
import {
  sealMistralRealtimeUserIdentity,
  type MistralRealtimeIdentityBinding,
  type MistralRealtimeIngressIdentityKeyRing,
} from './realtime-mistral-ingress-ticket';
import type { MistralConversationPersistenceKeyRing } from './mistral-conversation-outbox-seal';

const COMPANY_ID = 'company-1';
const USER_ID = 'auth-user-42';
const SUBJECT_HASH = 'a'.repeat(64);
const SESSION_HANDLE = '10000000-0000-4000-8000-000000000001';
const BOOTSTRAP_ID = '20000000-0000-4000-8000-000000000002';
const MISSION_ID = '30000000-0000-4000-8000-000000000003';
const BOOTSTRAP_TICKET = `b2_${Buffer.alloc(32, 7).toString('base64url')}`;
const NOW = new Date('2026-07-19T10:00:00.000Z');
const HARD_EXPIRES_AT = new Date('2026-07-19T10:15:00.000Z');
const REPLAY_GRACE_EXPIRES_AT = new Date('2026-07-19T10:20:00.000Z');
const RETENTION_EXPIRES_AT = new Date('2026-07-20T10:20:00.000Z');
const CONTEXT_DIGEST = 'b'.repeat(64);

const identityKeys: MistralRealtimeIngressIdentityKeyRing = {
  currentVersion: 3,
  secret: (version) => version === 3 ? 'i'.repeat(32) : null,
};
const persistenceSecret = new Uint8Array(32).fill(9);
const persistenceKeys: MistralConversationPersistenceKeyRing = {
  currentVersion: 5,
  secret: (version) => version === 5 ? Uint8Array.from(persistenceSecret) : null,
};

type RawHandler = (sql: string, values: readonly unknown[]) => unknown | Promise<unknown>;

function normalizeSql(strings: TemplateStringsArray): string {
  return strings.join('?').replace(/\s+/gu, ' ').trim();
}

class FakePrisma {
  readonly calls: string[] = [];
  readonly values: unknown[][] = [];
  private readonly tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = normalizeSql(strings);
      this.calls.push(`query:${this.kind(sql)}`);
      this.values.push(values);
      return this.query(sql, values);
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = normalizeSql(strings);
      this.calls.push(`exec:${this.kind(sql)}`);
      this.values.push(values);
      return this.execute(sql, values);
    },
  } as unknown as Prisma.TransactionClient;

  constructor(
    private readonly query: RawHandler,
    private readonly execute: RawHandler = () => {
      throw new Error('Unexpected SQL execute.');
    },
  ) {}

  inTransaction(): boolean { return false; }

  async withTenant<T>(
    companyId: string,
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    this.calls.push(`tenant:${companyId}`);
    return callback(this.tx);
  }

  private kind(sql: string): string {
    if (sql.includes('realtime_mistral_conversation_bootstrap_tickets')) return 'bootstrap';
    if (sql.includes('ORDER BY "reconciliationAttempt"')) return 'latest_attempt';
    if (sql.includes('"reconciliationAttempt" =')) return 'attempt';
    if (sql.includes('INSERT INTO realtime_mistral_conversation_resume_tickets')) return 'insert';
    if (sql.includes('FROM realtime_mistral_conversation_missions')) return 'mission';
    if (sql.includes('FROM realtime_session_leases')) return 'admission';
    if (sql.includes('clock_timestamp() AS')) return 'clock';
    if (sql.includes('SELECT EXISTS')) return 'ready_proof';
    if (sql.includes('pg_advisory_xact_lock')) return 'mission_lock';
    return 'other';
  }
}

function identityBinding(): MistralRealtimeIdentityBinding {
  return {
    companyId: COMPANY_ID,
    subjectHash: SUBJECT_HASH,
    subjectKeyVersion: 7,
    sessionId: SESSION_HANDLE,
    redemptionId: BOOTSTRAP_ID,
    plan: 'pro',
    contextRevision: 4,
    contextDigest: CONTEXT_DIGEST,
  };
}

function bootstrapRow(state: 'issued' | 'consumed' = 'consumed') {
  const identity = sealMistralRealtimeUserIdentity(
    USER_ID,
    identityBinding(),
    identityKeys,
    () => new Uint8Array(12).fill(4),
  );
  return {
    id: BOOTSTRAP_ID,
    companyId: COMPANY_ID,
    admissionSessionId: SESSION_HANDLE,
    sessionHandle: SESSION_HANDLE,
    subjectHash: SUBJECT_HASH,
    subjectKeyVersion: 7,
    admissionLeaseTokenHash: 'c'.repeat(64),
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    state,
    plan: 'pro',
    contextRevision: 4,
    contextDigest: CONTEXT_DIGEST,
    userIdentityCiphertext: identity.ciphertext,
    userIdentityNonce: identity.nonce,
    userIdentityTag: identity.tag,
    identityEncryptionKeyVersion: identity.keyVersion,
    routeMode: 'push_to_talk',
    fullDuplexCertified: false,
    maxMissionAudioBytes: 28_800_000,
    ticketExpiresAt: new Date(NOW.getTime() + 30_000),
    hardExpiresAt: HARD_EXPIRES_AT,
    consumedAt: state === 'consumed' ? NOW : null,
    retentionExpiresAt: RETENTION_EXPIRES_AT,
  };
}

function missionRow() {
  return {
    id: MISSION_ID,
    companyId: COMPANY_ID,
    initialBootstrapId: BOOTSTRAP_ID,
    admissionSessionId: SESSION_HANDLE,
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    subjectHash: SUBJECT_HASH,
    subjectKeyVersion: 7,
    plan: 'pro',
    sessionHandle: SESSION_HANDLE,
    missionConnectionEpoch: 1,
    version: 1n,
    acknowledgedServerSequence: 0n,
    retainedFromServerSequence: 0n,
    nextServerSequence: 1n,
    contextRevision: 4,
    contextDigest: CONTEXT_DIGEST,
    routeMode: 'push_to_talk',
    fullDuplexCertified: false,
    maxMissionAudioBytes: 28_800_000,
    phase: 'ready',
    hardExpiresAt: HARD_EXPIRES_AT,
    replayGraceExpiresAt: REPLAY_GRACE_EXPIRES_AT,
    retentionExpiresAt: RETENTION_EXPIRES_AT,
  };
}

function reconciliationRow(overrides: Record<string, unknown> = {}) {
  const capability = deriveMistralConversationBootstrapReconciliationCapability({
    secret: persistenceSecret,
    keyVersion: 5,
    companyId: COMPANY_ID,
    subjectHash: SUBJECT_HASH,
    initialBootstrapId: BOOTSTRAP_ID,
    sessionHandle: SESSION_HANDLE,
    attempt: 1,
  });
  return {
    id: capability.ticketId,
    companyId: COMPANY_ID,
    missionId: MISSION_ID,
    sessionHandle: SESSION_HANDLE,
    admissionSessionId: SESSION_HANDLE,
    ticketHash: capability.ticketHash,
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    purpose: 'initial_bootstrap_reconciliation',
    initialBootstrapId: BOOTSTRAP_ID,
    reconciliationAttempt: 1,
    reconciliationKeyVersion: 5,
    scope: 'live_takeover',
    state: 'issued',
    subjectHash: SUBJECT_HASH,
    subjectKeyVersion: 7,
    plan: 'pro',
    expectedMissionConnectionEpoch: 1,
    clientAcceptedMissionConnectionEpoch: 0,
    resumeNextServerSequence: 0n,
    contextRevision: 4,
    contextDigest: CONTEXT_DIGEST,
    routeMode: 'push_to_talk',
    fullDuplexCertified: false,
    maxMissionAudioBytes: 28_800_000,
    hardExpiresAt: HARD_EXPIRES_AT,
    replayGraceExpiresAt: REPLAY_GRACE_EXPIRES_AT,
    issuedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 30_000),
    consumedAt: null,
    consumedMissionConnectionEpoch: null,
    replayConnectionId: null,
    connectionLeaseExpiresAt: null,
    maxAcknowledgableServerSequence: null,
    retentionExpiresAt: RETENTION_EXPIRES_AT,
    version: 1,
    ...overrides,
  };
}

function input(userId = USER_ID) {
  return {
    companyId: COMPANY_ID,
    userId,
    sessionHandle: SESSION_HANDLE,
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    bootstrapTicket: BOOTSTRAP_TICKET,
    attempt: 1,
    signal: new AbortController().signal,
  };
}

function authority(prisma: FakePrisma): PrismaMistralConversationResumeAuthority {
  return new PrismaMistralConversationResumeAuthority(
    prisma as unknown as PrismaService,
    {} as PrismaMistralConversationDurableAuthority,
    {
      reconciliationKeys: persistenceKeys,
      reconciliationIdentityKeys: identityKeys,
    },
  );
}

describe('Prisma bootstrap reconciliation authority', () => {
  it('émet une capacité live déterministe après preuve du commit initial tardif', async () => {
    const prisma = new FakePrisma(
      (sql) => {
        if (sql.includes('realtime_mistral_conversation_bootstrap_tickets')) {
          return [bootstrapRow()];
        }
        if (sql.includes('"reconciliationAttempt" =')) return [];
        if (sql.includes('ORDER BY "reconciliationAttempt"')) return [];
        if (sql.includes('FROM realtime_mistral_conversation_missions')) return [missionRow()];
        if (sql.includes('FROM realtime_session_leases')) return [{
          state: 'active',
          providerId: 'mistral',
          providerCallId: `mcv2:${BOOTSTRAP_ID}`,
          leaseExpiresAt: new Date(NOW.getTime() + 60_000),
          hardExpiresAt: HARD_EXPIRES_AT,
        }];
        if (sql.includes('clock_timestamp() AS')) return [{ databaseNow: NOW }];
        if (sql.includes('SELECT EXISTS')) return [{ ready: true }];
        throw new Error(`Unexpected query: ${sql}`);
      },
      (sql) => {
        if (sql.includes('pg_advisory_xact_lock')) return 1;
        if (sql.includes('INSERT INTO realtime_mistral_conversation_resume_tickets')) return 1;
        throw new Error(`Unexpected execute: ${sql}`);
      },
    );

    const result = await authority(prisma).reconcileInitialBootstrap(input());
    const expected = deriveMistralConversationBootstrapReconciliationCapability({
      secret: persistenceSecret,
      keyVersion: 5,
      companyId: COMPANY_ID,
      subjectHash: SUBJECT_HASH,
      initialBootstrapId: BOOTSTRAP_ID,
      sessionHandle: SESSION_HANDLE,
      attempt: 1,
    });
    expect(result).toEqual({
      status: 'issued',
      bootstrap: {
        companyId: COMPANY_ID,
        sessionHandle: SESSION_HANDLE,
        ticket: expected.ticket,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        scope: 'live_takeover',
        ticketExpiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
        expectedMissionConnectionEpoch: 1,
        clientAcceptedMissionConnectionEpoch: 0,
        resumeNextServerSequence: 0,
      },
    });
    const serializedValues = JSON.stringify(prisma.values);
    expect(serializedValues).toContain(hashMistralConversationBootstrapTicket(BOOTSTRAP_TICKET));
    expect(serializedValues).not.toContain(BOOTSTRAP_TICKET);
    expect(serializedValues).not.toContain(expected.ticket);
    expect(serializedValues).not.toContain(USER_ID);
    expect(prisma.calls).toContain('exec:insert');
  });

  it('demande de retenter b2 quand la transaction initiale a réellement rollbacké', async () => {
    const prisma = new FakePrisma((sql) => {
      if (sql.includes('realtime_mistral_conversation_bootstrap_tickets')) {
        return [bootstrapRow('issued')];
      }
      if (sql.includes('clock_timestamp() AS')) return [{ databaseNow: NOW }];
      throw new Error(`Unexpected query: ${sql}`);
    }, (sql) => {
      if (sql.includes('pg_advisory_xact_lock')) return 1;
      throw new Error(`Unexpected execute: ${sql}`);
    });
    await expect(authority(prisma).reconcileInitialBootstrap(input()))
      .resolves.toEqual({ status: 'retry_initial' });
    expect(prisma.calls).not.toContain('query:mission');
  });

  it('restitue le même r2 issued après perte de la réponse HTTP, y compris avec clé courante rotée', async () => {
    const existing = reconciliationRow();
    const rotatedKeys: MistralConversationPersistenceKeyRing = {
      currentVersion: 6,
      secret: (version) => {
        if (version === 5) return Uint8Array.from(persistenceSecret);
        if (version === 6) return new Uint8Array(32).fill(10);
        return null;
      },
    };
    const prisma = new FakePrisma((sql) => {
      if (sql.includes('realtime_mistral_conversation_bootstrap_tickets')) {
        return [bootstrapRow()];
      }
      if (sql.includes('"reconciliationAttempt" =')) return [existing];
      if (sql.includes('FROM realtime_mistral_conversation_missions')) return [missionRow()];
      if (sql.includes('FROM realtime_session_leases')) return [{
        state: 'active',
        providerId: 'mistral',
        providerCallId: `mcv2:${BOOTSTRAP_ID}`,
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
        hardExpiresAt: HARD_EXPIRES_AT,
      }];
      if (sql.includes('clock_timestamp() AS')) return [{ databaseNow: NOW }];
      if (sql.includes('SELECT EXISTS')) return [{ ready: true }];
      throw new Error(`Unexpected query: ${sql}`);
    }, (sql) => {
      if (sql.includes('pg_advisory_xact_lock')) return 1;
      throw new Error(`Unexpected execute: ${sql}`);
    });
    const subject = new PrismaMistralConversationResumeAuthority(
      prisma as unknown as PrismaService,
      {} as PrismaMistralConversationDurableAuthority,
      {
        reconciliationKeys: rotatedKeys,
        reconciliationIdentityKeys: identityKeys,
      },
    );
    const result = await subject.reconcileInitialBootstrap(input());
    expect(result).toMatchObject({
      status: 'issued',
      bootstrap: {
        ticketExpiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
        scope: 'live_takeover',
      },
    });
    if (result.status !== 'issued') return;
    expect(result.bootstrap.ticket).toBe(
      deriveMistralConversationBootstrapReconciliationCapability({
        secret: persistenceSecret,
        keyVersion: 5,
        companyId: COMPANY_ID,
        subjectHash: SUBJECT_HASH,
        initialBootstrapId: BOOTSTRAP_ID,
        sessionHandle: SESSION_HANDLE,
        attempt: 1,
      }).ticket,
    );
    expect(prisma.calls).not.toContain('exec:insert');
  });

  it('déclare la tentative consommée quand son r2 a déjà produit un nouvel epoch', async () => {
    const prisma = new FakePrisma((sql) => {
      if (sql.includes('realtime_mistral_conversation_bootstrap_tickets')) {
        return [bootstrapRow()];
      }
      if (sql.includes('"reconciliationAttempt" =')) return [reconciliationRow({
        state: 'consumed',
        version: 2,
        consumedAt: new Date(NOW.getTime() + 1_000),
        consumedMissionConnectionEpoch: 2,
      })];
      if (sql.includes('FROM realtime_mistral_conversation_missions')) {
        return [{ ...missionRow(), missionConnectionEpoch: 2 }];
      }
      if (sql.includes('FROM realtime_session_leases')) return [{
        state: 'active',
        providerId: 'mistral',
        providerCallId: `mcv2:${BOOTSTRAP_ID}`,
        leaseExpiresAt: new Date(NOW.getTime() + 60_000),
        hardExpiresAt: HARD_EXPIRES_AT,
      }];
      if (sql.includes('clock_timestamp() AS')) return [{ databaseNow: NOW }];
      if (sql.includes('SELECT EXISTS')) return [{ ready: true }];
      throw new Error(`Unexpected query: ${sql}`);
    }, (sql) => {
      if (sql.includes('pg_advisory_xact_lock')) return 1;
      throw new Error(`Unexpected execute: ${sql}`);
    });
    await expect(authority(prisma).reconcileInitialBootstrap(input()))
      .resolves.toEqual({ status: 'attempt_consumed' });
  });

  it('refuse avant toute mission une identité authentifiée différente', async () => {
    const prisma = new FakePrisma((sql) => {
      if (sql.includes('realtime_mistral_conversation_bootstrap_tickets')) {
        return [bootstrapRow()];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    await expect(authority(prisma).reconcileInitialBootstrap(input('another-user')))
      .resolves.toEqual({ status: 'forbidden' });
    expect(prisma.calls).not.toContain('query:mission');
  });
});

import { MISTRAL_CONVERSATION_PROTOCOL } from '@bob/ai';
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  hashRealtimeLeaseToken,
  prepareRealtimeContext,
  type RealtimeAdmissionLease,
} from './realtime-admission';
import { PrismaMistralConversationDurableAuthority } from './mistral-conversation-authority.prisma';
import { PrismaMistralConversationBootstrapTicketAuthority } from './mistral-conversation-bootstrap-ticket.prisma';
import {
  DEFAULT_MISTRAL_CONVERSATION_BOOTSTRAP_TICKET_POLICY,
  hashMistralConversationBootstrapTicket,
} from './mistral-conversation-bootstrap-ticket';
import {
  createMistralConversationDurableSession,
  type MistralConversationBootstrapGrant,
  type MistralConversationDurableOpenResult,
} from './mistral-conversation-gateway-v2';
import {
  sealMistralRealtimeUserIdentity,
  type MistralRealtimeIdentityBinding,
  type MistralRealtimeIngressIdentityKeyRing,
} from './realtime-mistral-ingress-ticket';

const COMPANY_ID = 'company-1';
const SUBJECT_HASH = 'a'.repeat(64);
const SESSION_ID = '10000000-0000-4000-8000-000000000001';
const TICKET_ID = '20000000-0000-4000-8000-000000000002';
const LEASE_TOKEN = 'l'.repeat(43);
const OWNER_TOKEN = 'o'.repeat(43);
const USER_ID = 'auth-user-secret-42';
const RAW_TICKET = `b2_${Buffer.alloc(32, 7).toString('base64url')}`;
const DATABASE_NOW = new Date('2026-07-19T10:00:00.000Z');
const LEASE_EXPIRES_AT = new Date('2026-07-19T10:02:00.000Z');
const HARD_EXPIRES_AT = new Date('2026-07-19T10:15:00.000Z');
const TICKET_EXPIRES_AT = new Date('2026-07-19T10:00:30.000Z');
const CONTEXT = {
  screen: { name: '/devis/new', instanceId: 'quote-new-1' },
  entities: [],
  capabilities: ['screen.read' as const],
};
function preparedFixture() {
  const prepared = prepareRealtimeContext({ version: 1, revision: 7, context: CONTEXT });
  if (!prepared) throw new Error('Invalid test context.');
  return prepared;
}
const PREPARED = preparedFixture();

const identityKeys: MistralRealtimeIngressIdentityKeyRing = {
  currentVersion: 3,
  secret: (version) => version === 3 ? 'k'.repeat(32) : null,
};

const lease: RealtimeAdmissionLease = {
  companyId: COMPANY_ID,
  subjectHash: SUBJECT_HASH,
  sessionId: SESSION_ID,
  leaseToken: LEASE_TOKEN,
  state: 'reserved',
  leaseExpiresAt: LEASE_EXPIRES_AT.toISOString(),
  hardExpiresAt: HARD_EXPIRES_AT.toISOString(),
};

type RawHandler = (
  sql: string,
  values: readonly unknown[],
) => unknown | Promise<unknown>;

function normalizeSql(strings: TemplateStringsArray): string {
  return strings.join('?').replace(/\s+/gu, ' ').trim();
}

class FakePrisma {
  readonly calls: string[] = [];
  readonly values: unknown[][] = [];
  ambient = false;
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
    private readonly execute: RawHandler,
  ) {}

  inTransaction(): boolean {
    return this.ambient;
  }

  async withTenant<T>(companyId: string, callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    this.calls.push(`tenant:${companyId}`);
    return callback(this.tx);
  }

  transactionClient(): Prisma.TransactionClient {
    return this.tx;
  }

  private kind(sql: string): string {
    if (sql.includes('count(*) FILTER')) return 'quota';
    if (sql.includes('FROM realtime_mistral_conversation_bootstrap_tickets')) return 'ticket';
    if (sql.includes('INSERT INTO realtime_mistral_conversation_bootstrap_tickets')) return 'insert';
    if (sql.includes('UPDATE realtime_mistral_conversation_bootstrap_tickets')) return 'consume';
    if (sql.includes('FROM realtime_session_leases')) return 'lease';
    if (sql.includes("SET state = 'bound'")) return 'bind';
    if (sql.includes("SET state = 'active'")) return 'activate';
    if (sql.includes('UPDATE realtime_session_leases')) return 'context';
    if (sql.includes('clock_timestamp() AS')) return 'clock';
    if (sql.includes('pg_advisory_xact_lock')) return 'mission_lock';
    return 'other';
  }
}

function admissionRow(context: 'empty' | 'prepared' = 'prepared') {
  return {
    subjectHash: SUBJECT_HASH,
    sessionId: SESSION_ID,
    leaseTokenHash: hashRealtimeLeaseToken(LEASE_TOKEN),
    state: 'reserved',
    providerId: null,
    providerCallId: null,
    leaseExpiresAt: LEASE_EXPIRES_AT,
    hardExpiresAt: HARD_EXPIRES_AT,
    contextSchemaVersion: context === 'prepared' ? 1 : null,
    contextRevision: context === 'prepared' ? PREPARED.snapshot.revision : null,
    contextPayload: context === 'prepared' ? PREPARED.snapshot.context : null,
    contextDigest: context === 'prepared' ? PREPARED.digest : null,
    version: 4,
  };
}

function ticketRow(overrides: Record<string, unknown> = {}) {
  const binding: MistralRealtimeIdentityBinding = {
    companyId: COMPANY_ID,
    subjectHash: SUBJECT_HASH,
    subjectKeyVersion: 7,
    sessionId: SESSION_ID,
    redemptionId: TICKET_ID,
    plan: 'pro',
    contextRevision: PREPARED.snapshot.revision,
    contextDigest: PREPARED.digest,
  };
  const identity = sealMistralRealtimeUserIdentity(USER_ID, binding, identityKeys, () => new Uint8Array(12).fill(9));
  return {
    id: TICKET_ID,
    companyId: COMPANY_ID,
    admissionSessionId: SESSION_ID,
    sessionHandle: SESSION_ID,
    subjectHash: SUBJECT_HASH,
    subjectKeyVersion: 7,
    admissionLeaseTokenHash: hashRealtimeLeaseToken(LEASE_TOKEN),
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    state: 'issued',
    plan: 'pro',
    contextSchemaVersion: 1,
    contextRevision: PREPARED.snapshot.revision,
    contextSnapshot: {
      version: 1,
      revision: PREPARED.snapshot.revision,
      context: PREPARED.snapshot.context,
    },
    contextDigest: PREPARED.digest,
    userIdentityCiphertext: identity.ciphertext,
    userIdentityNonce: identity.nonce,
    userIdentityTag: identity.tag,
    identityEncryptionKeyVersion: identity.keyVersion,
    routeMode: 'push_to_talk',
    fullDuplexCertified: false,
    maxMissionAudioBytes: 28_800_000,
    issuedAt: DATABASE_NOW,
    ticketExpiresAt: TICKET_EXPIRES_AT,
    leaseExpiresAt: LEASE_EXPIRES_AT,
    hardExpiresAt: HARD_EXPIRES_AT,
    consumedAt: null,
    retentionExpiresAt: new Date('2026-07-20T10:15:00.000Z'),
    version: 1,
    ...overrides,
  };
}

function opened(grant: MistralConversationBootstrapGrant): MistralConversationDurableOpenResult {
  const created = createMistralConversationDurableSession({ grant, missionConnectionEpoch: 1 });
  return {
    status: 'opened',
    ...created,
    replayFromServerSequence: 0,
    recovery: null,
    terminal: null,
  };
}

function authority(
  prisma: FakePrisma,
  durableOpen: (tx: Prisma.TransactionClient, input: {
    readonly grant: MistralConversationBootstrapGrant;
    readonly signal: AbortSignal;
  }) => Promise<MistralConversationDurableOpenResult>,
) {
  const durable = {
    openWithinTransaction: vi.fn(durableOpen),
  } as unknown as PrismaMistralConversationDurableAuthority;
  return {
    subject: new PrismaMistralConversationBootstrapTicketAuthority(
      prisma as unknown as PrismaService,
      durable,
      identityKeys,
      DEFAULT_MISTRAL_CONVERSATION_BOOTSTRAP_TICKET_POLICY,
      { ticketId: () => TICKET_ID, ticket: () => RAW_TICKET },
    ),
    durable,
  };
}

function redeemInput(signal = new AbortController().signal) {
  return {
    companyId: COMPANY_ID,
    ticket: RAW_TICKET,
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    ownerLeaseToken: OWNER_TOKEN,
    resumeNextServerSequence: 0,
    maxReplayEvents: 256,
    maxReplayBytes: 240 * 1024,
    signal,
  };
}

describe('PrismaMistralConversationBootstrapTicketAuthority', () => {
  it('émet depuis le bail réel, persiste seulement hash + identité AEAD et force le mode PTT', async () => {
    const prisma = new FakePrisma(
      (sql) => {
        if (sql.includes('clock_timestamp() AS')) return [{ databaseNow: DATABASE_NOW }];
        if (sql.includes('count(*) FILTER')) return [{
          tenantOutstanding: 0,
          subjectOutstanding: 0,
          tenantIssuedHour: 0,
          subjectIssuedHour: 0,
        }];
        if (sql.includes('FROM realtime_session_leases')) return [admissionRow('empty')];
        if (sql.includes('INSERT INTO realtime_mistral_conversation_bootstrap_tickets')) {
          return [{ ticketExpiresAt: TICKET_EXPIRES_AT }];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      (sql) => {
        if (sql.includes('pg_advisory_xact_lock')) return 1;
        if (sql.includes('UPDATE realtime_session_leases')) return 1;
        throw new Error(`Unexpected execute: ${sql}`);
      },
    );
    const { subject, durable } = authority(prisma, async () => ({ status: 'unavailable' }));
    const result = await subject.issue({
      lease,
      userId: USER_ID,
      subjectKeyVersion: 7,
      plan: 'pro',
      contextSchemaVersion: 1,
      contextRevision: PREPARED.snapshot.revision,
      context: CONTEXT,
    });
    expect(result).toMatchObject({
      status: 'issued',
      bootstrap: {
        companyId: COMPANY_ID,
        sessionHandle: SESSION_ID,
        ticket: RAW_TICKET,
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        routeMode: 'push_to_talk',
        fullDuplexCertified: false,
        maxMissionAudioBytes: 28_800_000,
      },
    });
    expect(prisma.calls).toEqual([
      `tenant:${COMPANY_ID}`,
      'exec:mission_lock',
      'query:clock',
      'query:quota',
      'query:lease',
      'exec:context',
      'query:insert',
    ]);
    expect(durable.openWithinTransaction).not.toHaveBeenCalled();
    const serializedValues = JSON.stringify(prisma.values);
    expect(serializedValues).not.toContain(RAW_TICKET);
    expect(serializedValues).not.toContain(USER_ID);
    expect(serializedValues).toContain(hashMistralConversationBootstrapTicket(RAW_TICKET));
  });

  it('ouvre Mission + outbox dans la même transaction avant le CAS issued -> consumed', async () => {
    const row = ticketRow();
    const prisma = new FakePrisma(
      (sql) => {
        if (sql.includes('FROM realtime_mistral_conversation_bootstrap_tickets')) return [row];
        if (sql.includes('FROM realtime_session_leases')) return [admissionRow()];
        if (sql.includes('clock_timestamp() AS')) return [{ databaseNow: DATABASE_NOW }];
        throw new Error(`Unexpected query: ${sql}`);
      },
      (sql) => {
        if (sql.includes('pg_advisory_xact_lock')) return 1;
        if (sql.includes('UPDATE realtime_session_leases')) return 1;
        if (sql.includes('UPDATE realtime_mistral_conversation_bootstrap_tickets')) return 1;
        throw new Error(`Unexpected execute: ${sql}`);
      },
    );
    const { subject, durable } = authority(prisma, async (tx, input) => {
      prisma.calls.push('durable:open');
      expect(tx).toBe(prisma.transactionClient());
      return opened(input.grant);
    });
    const result = await subject.redeemAndOpenInitial(redeemInput());
    expect(result.status).toBe('opened');
    if (result.status !== 'opened') return;
    expect(result.grant).toMatchObject({
      bootstrapId: TICKET_ID,
      admissionSessionId: SESSION_ID,
      sessionHandle: SESSION_ID,
      routeMode: 'push_to_talk',
      fullDuplexCertified: false,
      contextDigest: PREPARED.digest,
    });
    expect(prisma.calls).toEqual([
      `tenant:${COMPANY_ID}`,
      'query:ticket',
      'query:lease',
      'exec:mission_lock',
      'query:clock',
      'durable:open',
      'query:clock',
      'exec:bind',
      'exec:activate',
      'exec:consume',
    ]);
    expect(durable.openWithinTransaction).toHaveBeenCalledTimes(1);
    const serializedValues = JSON.stringify(prisma.values);
    expect(serializedValues).not.toContain(RAW_TICKET);
    expect(serializedValues).not.toContain(USER_ID);
  });

  it('rollbacke logiquement tout résultat durable autre que opened et ne consomme pas le ticket', async () => {
    const prisma = new FakePrisma(
      (sql) => {
        if (sql.includes('FROM realtime_mistral_conversation_bootstrap_tickets')) return [ticketRow()];
        if (sql.includes('FROM realtime_session_leases')) return [admissionRow()];
        if (sql.includes('clock_timestamp() AS')) return [{ databaseNow: DATABASE_NOW }];
        throw new Error(`Unexpected query: ${sql}`);
      },
      (sql) => {
        if (sql.includes('pg_advisory_xact_lock')) return 1;
        throw new Error(`CAS must not run after durable failure: ${sql}`);
      },
    );
    const { subject } = authority(prisma, async () => ({ status: 'conflict' }));
    await expect(subject.redeemAndOpenInitial(redeemInput())).resolves.toEqual({ status: 'unavailable' });
    expect(prisma.calls).not.toContain('exec:consume');
  });

  it('transforme un abort observé après open en exception transactionnelle avant le CAS', async () => {
    const controller = new AbortController();
    const prisma = new FakePrisma(
      (sql) => {
        if (sql.includes('FROM realtime_mistral_conversation_bootstrap_tickets')) return [ticketRow()];
        if (sql.includes('FROM realtime_session_leases')) return [admissionRow()];
        if (sql.includes('clock_timestamp() AS')) return [{ databaseNow: DATABASE_NOW }];
        throw new Error(`Unexpected query: ${sql}`);
      },
      (sql) => {
        if (sql.includes('pg_advisory_xact_lock')) return 1;
        throw new Error(`CAS must not run after abort: ${sql}`);
      },
    );
    const { subject } = authority(prisma, async (_tx, input) => {
      controller.abort();
      return opened(input.grant);
    });
    await expect(subject.redeemAndOpenInitial(redeemInput(controller.signal)))
      .resolves.toEqual({ status: 'aborted' });
    expect(prisma.calls).not.toContain('exec:consume');
  });

  it('relit l’horloge BDD après open et rollbacke si le ticket expire pendant la création durable', async () => {
    let clockReads = 0;
    const prisma = new FakePrisma(
      (sql) => {
        if (sql.includes('FROM realtime_mistral_conversation_bootstrap_tickets')) return [ticketRow()];
        if (sql.includes('FROM realtime_session_leases')) return [admissionRow()];
        if (sql.includes('clock_timestamp() AS')) {
          clockReads += 1;
          return [{ databaseNow: clockReads === 1 ? DATABASE_NOW : TICKET_EXPIRES_AT }];
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
      (sql) => {
        if (sql.includes('pg_advisory_xact_lock')) return 1;
        throw new Error(`CAS must not run after temporal boundary: ${sql}`);
      },
    );
    const { subject } = authority(prisma, async (_tx, input) => opened(input.grant));
    await expect(subject.redeemAndOpenInitial(redeemInput())).resolves.toEqual({ status: 'expired' });
    expect(clockReads).toBe(2);
    expect(prisma.calls).not.toContain('exec:consume');
  });

  it('refuse replay, curseur initial non nul, identité AEAD corrompue et transaction ambiante', async () => {
    const prisma = new FakePrisma(
      (sql) => {
        if (sql.includes('FROM realtime_mistral_conversation_bootstrap_tickets')) {
          return [ticketRow({ state: 'consumed', consumedAt: DATABASE_NOW })];
        }
        throw new Error(`No other query expected: ${sql}`);
      },
      () => { throw new Error('No execute expected.'); },
    );
    const { subject, durable } = authority(prisma, async () => ({ status: 'unavailable' }));
    await expect(subject.redeemAndOpenInitial(redeemInput())).resolves.toEqual({ status: 'replayed' });
    await expect(subject.redeemAndOpenInitial({
      ...redeemInput(),
      resumeNextServerSequence: 1,
    })).resolves.toEqual({ status: 'invalid_cursor' });
    expect(durable.openWithinTransaction).not.toHaveBeenCalled();

    prisma.ambient = true;
    await expect(subject.redeemAndOpenInitial(redeemInput())).resolves.toEqual({ status: 'unavailable' });
    await expect(subject.issue({
      lease,
      userId: USER_ID,
      subjectKeyVersion: 7,
      plan: 'pro',
      contextSchemaVersion: 1,
      contextRevision: PREPARED.snapshot.revision,
      context: CONTEXT,
    })).resolves.toEqual({ status: 'unavailable' });
  });

  it('rejette sous lock toute dérive du contexte, du bail ou de la liaison AEAD', async () => {
    const prisma = new FakePrisma(
      (sql) => {
        if (sql.includes('FROM realtime_mistral_conversation_bootstrap_tickets')) {
          const ciphertext = Uint8Array.from(ticketRow().userIdentityCiphertext as Uint8Array);
          ciphertext[0] = ciphertext[0]! ^ 1;
          return [ticketRow({ userIdentityCiphertext: ciphertext })];
        }
        if (sql.includes('FROM realtime_session_leases')) return [admissionRow()];
        if (sql.includes('clock_timestamp() AS')) return [{ databaseNow: DATABASE_NOW }];
        throw new Error(`Unexpected query: ${sql}`);
      },
      (sql) => sql.includes('pg_advisory_xact_lock') ? 1 : 0,
    );
    const { subject, durable } = authority(prisma, async () => ({ status: 'unavailable' }));
    await expect(subject.redeemAndOpenInitial(redeemInput())).resolves.toEqual({ status: 'unavailable' });
    expect(durable.openWithinTransaction).not.toHaveBeenCalled();
  });
});

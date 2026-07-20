import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import type { MistralConversationAdmissionOwner } from './mistral-conversation-admission';
import { PrismaMistralConversationAdmissionAuthority } from './mistral-conversation-admission.prisma';

const COMPANY_ID = 'company-1';
const SUBJECT_HASH = 'a'.repeat(64);
const SESSION_ID = '30000000-0000-4000-8000-000000000002';
const BOOTSTRAP_ID = '30000000-0000-4000-8000-000000000001';
const OWNER_TOKEN = 'O'.repeat(43);
const DATABASE_NOW = new Date('2026-07-19T10:00:00.000Z');
const HARD_EXPIRES_AT = new Date('2026-07-19T10:15:00.000Z');

const owner: MistralConversationAdmissionOwner = {
  companyId: COMPANY_ID,
  subjectHash: SUBJECT_HASH,
  admissionSessionId: SESSION_ID,
  sessionHandle: SESSION_ID,
  bootstrapId: BOOTSTRAP_ID,
  missionConnectionEpoch: 2,
  ownerLeaseToken: OWNER_TOKEN,
};

function mission(phase = 'ready') {
  return {
    id: '40000000-0000-4000-8000-000000000001',
    initialBootstrapId: BOOTSTRAP_ID,
    admissionSessionId: SESSION_ID,
    subjectHash: SUBJECT_HASH,
    sessionHandle: SESSION_ID,
    ownerTokenHash: createHash('sha256').update(OWNER_TOKEN, 'utf8').digest('hex'),
    missionConnectionEpoch: 2,
    phase,
    hardExpiresAt: HARD_EXPIRES_AT,
  };
}

function admission() {
  return {
    state: 'active',
    providerId: 'mistral',
    providerCallId: `mcv2:${BOOTSTRAP_ID}`,
    leaseExpiresAt: new Date('2026-07-19T10:00:20.000Z'),
    hardExpiresAt: HARD_EXPIRES_AT,
    version: 5,
  };
}

function harness(queryResults: readonly unknown[], executeResults: readonly number[] = []) {
  const queries = [...queryResults];
  const executions = [...executeResults];
  const queryRaw = vi.fn(async () => {
    if (queries.length === 0) throw new Error('Unexpected SQL query.');
    return queries.shift();
  });
  const executeRaw = vi.fn(async () => executions.shift() ?? 1);
  const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw } as unknown as Prisma.TransactionClient;
  const withTenant = vi.fn(async (
    _companyId: string,
    operation: (client: Prisma.TransactionClient) => Promise<unknown>,
  ) => operation(tx));
  return {
    value: new PrismaMistralConversationAdmissionAuthority(
      { withTenant } as unknown as PrismaService,
      { activeLeaseSeconds: 30, heartbeatSeconds: 10 },
    ),
    queryRaw,
    executeRaw,
    withTenant,
  };
}

function sqlAt(mock: ReturnType<typeof vi.fn>, index: number): string {
  const strings = mock.mock.calls[index]?.[0] as readonly string[] | undefined;
  return strings?.join('?').replace(/\s+/gu, ' ').trim() ?? '';
}

describe('PrismaMistralConversationAdmissionAuthority', () => {
  it('renouvelle seulement le owner Mission exact et borne le lease au hard cap', async () => {
    const renewedAt = new Date('2026-07-19T10:00:30.000Z');
    const h = harness([[mission()], [admission()], [{ databaseNow: DATABASE_NOW }], [{
      leaseExpiresAt: renewedAt,
    }]]);

    await expect(h.value.renewOwner({
      ...owner,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'renewed', leaseExpiresAt: renewedAt.toISOString() });

    expect(h.withTenant).toHaveBeenCalledWith(COMPANY_ID, expect.any(Function));
    expect(sqlAt(h.queryRaw, 3)).toContain('SET "leaseExpiresAt" = LEAST');
    expect(sqlAt(h.queryRaw, 3)).toContain('AND "providerCallId" =');
    expect(sqlAt(h.queryRaw, 3)).toContain('AND version =');
  });

  it('fence un ancien epoch avant toute mutation du lease', async () => {
    const h = harness([[{ ...mission(), missionConnectionEpoch: 3 }], [admission()], [{
      databaseNow: DATABASE_NOW,
    }]]);

    await expect(h.value.renewOwner({
      ...owner,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'stale_owner' });
    expect(h.queryRaw).toHaveBeenCalledTimes(3);
  });

  it('ne libère jamais avant la fermeture durable de la Mission', async () => {
    const h = harness([[mission('draining')], [admission()], [{ databaseNow: DATABASE_NOW }]]);

    await expect(h.value.releaseClosed({
      ...owner,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'not_closed' });
    expect(h.executeRaw).toHaveBeenCalledOnce();
  });

  it('libère le lease exact après close et rejoue honnêtement une libération déjà commitée', async () => {
    const released = harness([[mission('closed')], [admission()], [{ databaseNow: DATABASE_NOW }]]);
    await expect(released.value.releaseClosed({
      ...owner,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'released' });
    expect(sqlAt(released.executeRaw, 1)).toContain('DELETE FROM realtime_session_leases');

    const replayed = harness([[mission('closed')], [], [{ databaseNow: DATABASE_NOW }]]);
    await expect(replayed.value.releaseClosed({
      ...owner,
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: 'replayed' });
  });
});

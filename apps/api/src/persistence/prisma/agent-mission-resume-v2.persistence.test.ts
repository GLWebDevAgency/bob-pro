import {
  type AgentMissionResumeV2ReadTransaction,
} from '@bob/core';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  PrismaAgentMissionResumeUnitOfWork,
} from './agent-mission.persistence';
import type {
  IsolatedOwnerTransactionOptions,
  PrismaService,
} from './prisma.service';

const OWNER = Object.freeze({
  companyId: 'company-1',
  ownerUserId: 'owner-1',
});

function sql(call: readonly unknown[]): string {
  const strings = call[0] as readonly string[] | undefined;
  if (strings === undefined) return '';
  return strings
    .map((part, index) => {
      const value = call[index + 1];
      const nestedSql = (
        typeof value === 'object'
        && value !== null
        && 'sql' in value
        && typeof value.sql === 'string'
      )
        ? value.sql
        : '?';
      return `${part}${index < strings.length - 1 ? nestedSql : ''}`;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

function harness() {
  let queryNumber = 0;
  const queryRaw = vi.fn(async () => {
    queryNumber += 1;
    if (queryNumber === 1) return [{ closedAt: null }];
    if (queryNumber === 2) {
      return [{ now: new Date('2026-07-30T08:00:00.000Z') }];
    }
    return [];
  });
  const executeRaw = vi.fn(async () => 0);
  const transaction = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
  } as unknown as Prisma.TransactionClient;
  const boundary = vi.fn(async <T>(
    _companyId: string,
    _ownerUserId: string,
    work: (transaction: Prisma.TransactionClient) => Promise<T>,
    _options?: IsolatedOwnerTransactionOptions,
  ) => work(transaction));
  const prisma = {
    withIsolatedOwner: boundary,
  } as unknown as PrismaService;
  return {
    unitOfWork: new PrismaAgentMissionResumeUnitOfWork(prisma),
    queryRaw,
    executeRaw,
    boundary,
  };
}

describe('PrismaAgentMissionResumeUnitOfWork V2', () => {
  it('fournit un snapshot owner-scopé READ ONLY sans aucun verrou de ligne', async () => {
    const h = harness();
    const callback = vi.fn(async (
      transaction: AgentMissionResumeV2ReadTransaction,
    ) => ({
      now: await transaction.databaseNow(),
      work: await transaction.quoteLineWork.list({
        ...OWNER,
        missionId: '10000000-0000-4000-8000-000000000001',
      }),
      catalogue: await transaction.catalogue.findByIds({
        companyId: OWNER.companyId,
        catalogueItemIds: ['catalogue-main-oeuvre'],
      }),
      vat: await transaction.quoteVatContext.get({
        companyId: OWNER.companyId,
        customerId: 'customer-a',
      }),
    }));

    const result = await h.unitOfWork.readQuoteCreationOwnerV2(
      OWNER,
      callback,
    );

    expect(result).toMatchObject({
      status: 'executed',
      value: {
        now: '2026-07-30T08:00:00.000Z',
        work: [],
        catalogue: [],
        vat: null,
      },
    });
    expect(h.boundary).toHaveBeenCalledWith(
      OWNER.companyId,
      OWNER.ownerUserId,
      expect.any(Function),
      expect.objectContaining({
        readOnly: true,
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      }),
    );
    expect(callback).toHaveBeenCalledOnce();
    expect(h.executeRaw).toHaveBeenCalled();

    const statements = h.queryRaw.mock.calls
      .map((call) => sql(call as readonly unknown[]))
      .join('\n');
    expect(statements).toContain('FROM public.agent_mission_quote_line_work');
    expect(statements).toContain('ORDER BY "ordinal" ASC, "id" ASC LIMIT 21');
    expect(statements).toContain('FROM public.catalogue_prestations AS c');
    expect(statements).toContain('JOIN public.customers AS customer');
    expect(statements).not.toMatch(/\bFOR\s+(?:UPDATE|SHARE)\b/iu);
    expect(statements).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE)\b/iu);
    expect(JSON.stringify(h.queryRaw.mock.calls)).toContain(OWNER.companyId);
    expect(JSON.stringify(h.queryRaw.mock.calls)).toContain(OWNER.ownerUserId);
  });

  it('rejette un lot catalogue dupliqué avant sa requête SQL', async () => {
    const h = harness();

    await expect(h.unitOfWork.readQuoteCreationOwnerV2(
      OWNER,
      async (transaction) => transaction.catalogue.findByIds({
        companyId: OWNER.companyId,
        catalogueItemIds: ['catalogue-a', 'catalogue-a'],
      }),
    )).rejects.toThrow('AGENT_MISSION_RESUME_CATALOGUE_INPUT_INVALID');

    // Société + horloge uniquement : aucune requête catalogue n'est partie.
    expect(h.queryRaw).toHaveBeenCalledTimes(2);
  });
});

import { ok, type Company } from '@bob/core';

import { CustomerUpdateAuthority } from '../customers/customer-update.authority';
import type { DocumentArchiveMutationBarrier } from '../documents/document-archive-integrity.authority';
import type {
  JarvisCustomerEffectAuthority,
  JarvisCustomerEffectTarget,
  JarvisCustomerFields,
  JarvisCustomerSnapshot,
  JarvisCustomerWriteResult,
} from '../jobs/jarvis-customer-effect.executor';
import type { Persistence } from '../persistence/persistence';
import {
  PrismaCustomerRepository,
  PrismaInvoiceRepository,
  PrismaQuoteRepository,
} from '../persistence/prisma/repositories';
import type { PrismaService } from '../persistence/prisma/prisma.service';
import { PrismaJarvisCustomerEffectAuthority } from './jarvis-customer-effect.authority';

const ARCHIVES_READY: DocumentArchiveMutationBarrier = {
  assertSignedQuoteArchivesComplete: async () => ok(undefined),
  assertIssuedInvoiceArchivesComplete: async () => ok(undefined),
};

/**
 * Composition réservée aux vieux schémas minimaux des oracles Jarvis. Elle conserve l'autorité
 * de production et son ordre transaction/verrou/CAS ; seuls les contrôles d'archives, absents de
 * ces schémas test-only, sont déclarés prêts. U1-j les prouve sur le schéma PostgreSQL courant.
 */
export function createReducedSchemaCustomerEffectAuthorityForTesting(
  prisma: PrismaService,
): PrismaJarvisCustomerEffectAuthority {
  const persistence = {
    customers: new PrismaCustomerRepository(prisma),
    quotes: new PrismaQuoteRepository(prisma),
    invoices: new PrismaInvoiceRepository(prisma),
    companies: {
      lockById: async (companyId: string): Promise<Company | null> => {
        const rows = await prisma.client().$queryRaw<Array<{ closedAt: Date | null }>>`
          SELECT "closedAt"
            FROM public.companies
           WHERE "id" = ${companyId}
           FOR UPDATE
        `;
        const row = rows[0];
        return row === undefined
          ? null
          : ({ isClosed: () => row.closedAt !== null } as Company);
      },
    },
    runWithTenant: <T>(companyId: string, work: () => Promise<T>): Promise<T> =>
      prisma.withTenant(companyId, () => work()),
    runInTransaction: <T>(work: () => Promise<T>): Promise<T> =>
      prisma.runInTransaction(work),
  } as unknown as Persistence;
  return new PrismaJarvisCustomerEffectAuthority(
    prisma,
    new CustomerUpdateAuthority(persistence, ARCHIVES_READY),
  );
}

/** Observateur de test : compte les demandes d'écriture, puis délègue sans recopier le writer. */
export class CountingJarvisCustomerEffectAuthority implements JarvisCustomerEffectAuthority {
  public writes = 0;

  constructor(private readonly delegate: JarvisCustomerEffectAuthority) {}

  readCustomer(target: JarvisCustomerEffectTarget): Promise<JarvisCustomerSnapshot | null> {
    return this.delegate.readCustomer(target);
  }

  readCustomerRevision(target: JarvisCustomerEffectTarget): Promise<number | null> {
    return this.delegate.readCustomerRevision?.(target) ?? Promise.resolve(null);
  }

  createCustomer(
    target: JarvisCustomerEffectTarget,
    fields: JarvisCustomerFields,
  ): Promise<JarvisCustomerWriteResult> {
    this.writes += 1;
    return this.delegate.createCustomer(target, fields);
  }

  updateCustomerAtRevision(
    target: JarvisCustomerEffectTarget,
    fields: JarvisCustomerFields,
    expectedRevision: number,
  ): Promise<JarvisCustomerWriteResult> {
    this.writes += 1;
    return this.delegate.updateCustomerAtRevision(target, fields, expectedRevision);
  }
}

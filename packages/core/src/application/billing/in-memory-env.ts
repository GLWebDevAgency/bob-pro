import { type Quote } from '../../domain/billing/quote/quote';
import { type Invoice } from '../../domain/billing/invoice/invoice';
import { type Payment } from '../../domain/payment/payment';
import { DocNumber } from '../../domain/billing/shared/doc-number';
import { seedCompany, seedCustomers } from '../fixtures';
import {
  type CompanyRepository,
  type CustomerRepository,
  type QuoteRepository,
  type InvoiceRepository,
  type PaymentRepository,
} from '../ports/repositories';
import {
  type PublicAccessGrant,
  type PublicAccessTokenRepository,
} from '../ports/public-access-token';
import {
  type SequenceCounterPort,
  type ClockPort,
  type IdGeneratorPort,
  type CounterKey,
} from '../ports/services';

/**
 * Environnement billing in-memory pour les TESTS (repos + horloge + compteurs déterministes).
 * Extrait de flow.integration.test.ts pour être partagé avec les tests de flows (C02).
 * Ne fait PAS partie de l'API publique du package (non exporté par src/index.ts).
 */
export function makeEnv() {
  const company = seedCompany();
  const customers = seedCustomers();
  // Client b2c du test d'or TVA 10 % chauffe-eau (HT 1480 / TVA 148 / TTC 1628 / acompte 488,40).
  // Martin est devenu b2b à l'alignement proto (C02 PARITY-FAIL #1) → on prend M. Bernard.
  const customer = customers.find((c) => c.id === 'cust-bernard')!; // M. Bernard (b2c)

  const quotesMap = new Map<string, Quote>();
  const invoicesMap = new Map<string, Invoice>();
  const paymentsArr: Payment[] = [];

  const companyRepo: CompanyRepository = {
    findById: async (id) => (id === company.id ? company : null),
    lockById: async (id) => (id === company.id ? company : null),
    lockForShareById: async (id) => (id === company.id ? company : null),
    list: async () => [company],
    save: async () => {},
  };
  const customerRepo: CustomerRepository = {
    findById: async (id) => customers.find((c) => c.id === id) ?? null,
    listByCompany: async () => customers,
    save: async () => {},
  };
  const quoteRepo: QuoteRepository = {
    findById: async (id) => quotesMap.get(id) ?? null,
    lockById: async (id) => quotesMap.get(id) ?? null,
    listByCompany: async (companyId) =>
      [...quotesMap.values()].filter((q) => q.companyId === companyId),
    save: async (q) => {
      quotesMap.set(q.id, q);
    },
  };
  const invoiceRepo: InvoiceRepository = {
    findById: async (id) => invoicesMap.get(id) ?? null,
    lockById: async (id) => invoicesMap.get(id) ?? null,
    findByParentQuoteId: async (companyId, parentQuoteId, kind) =>
      [...invoicesMap.values()].find(
        (i) => i.companyId === companyId && i.parentQuoteId === parentQuoteId && i.kind === kind,
      ) ?? null,
    findCreditNoteBySourceInvoiceId: async (companyId, sourceInvoiceId) =>
      [...invoicesMap.values()].find(
        (i) =>
          i.companyId === companyId &&
          i.kind === 'credit_note' &&
          i.creditNoteSource?.invoiceId === sourceInvoiceId,
      ) ?? null,
    listByCompany: async (companyId) =>
      [...invoicesMap.values()].filter((i) => i.companyId === companyId),
    save: async (i) => {
      const sourceId = i.creditNoteSource?.invoiceId;
      if (i.kind === 'credit_note' && sourceId) {
        const existing = [...invoicesMap.values()].find(
          (invoice) =>
            invoice.companyId === i.companyId &&
            invoice.kind === 'credit_note' &&
            invoice.creditNoteSource?.invoiceId === sourceId,
        );
        if (existing && existing.id !== i.id) return;
      }
      invoicesMap.set(i.id, i);
    },
    deleteById: async (id) => {
      invoicesMap.delete(id);
    },
  };
  const paymentRepo: PaymentRepository = {
    save: async (p) => {
      paymentsArr.push(p);
    },
    findById: async (companyId, id) =>
      paymentsArr.find((p) => p.companyId === companyId && p.id === id) ?? null,
    listByInvoice: async (invoiceId) => paymentsArr.filter((p) => p.invoiceId === invoiceId),
    listByCompany: async (companyId) => paymentsArr.filter((p) => p.companyId === companyId),
    findByIdempotencyKey: async (companyId, key) =>
      paymentsArr.find((p) => p.companyId === companyId && p.idempotencyKey === key) ?? null,
  };
  const uow = { runInTransaction: <T>(fn: () => Promise<T>): Promise<T> => fn() };

  // Jetons publics (liens de signature R4) — SignQuote exige ce port pour révoquer les grants
  // actifs DANS la transaction de signature (P0 : lien encore lisible après signature interne).
  const grants = new Map<string, PublicAccessGrant & { token: string }>();
  let grantSeq = 0;
  const publicAccessTokens: PublicAccessTokenRepository = {
    create: async (input) => {
      grantSeq += 1;
      const id = `grant-${grantSeq}`;
      const token = `pst_${grantSeq}`;
      grants.set(id, { id, token, ...input, revokedAt: null });
      return { id, token };
    },
    findActive: async (token, at) => {
      const row = [...grants.values()].find((g) => g.token === token);
      if (!row || row.revokedAt !== null || row.expiresAt <= at) return null;
      const { token: _token, ...grant } = row;
      return grant;
    },
    markUsed: async () => undefined,
    revoke: async (id, at) => {
      const row = grants.get(id);
      if (row) grants.set(id, { ...row, revokedAt: at });
    },
    revokeActiveFor: async (input) => {
      for (const [id, row] of grants) {
        if (
          row.companyId === input.companyId &&
          row.resourceType === input.resourceType &&
          row.resourceId === input.resourceId &&
          row.scope === input.scope &&
          row.revokedAt === null &&
          row.expiresAt > input.at
        ) {
          grants.set(id, { ...row, revokedAt: input.at });
        }
      }
    },
    revokeAllForCompany: async (input) => {
      for (const [id, row] of grants) {
        if (row.companyId === input.companyId && row.revokedAt === null) {
          grants.set(id, { ...row, revokedAt: input.at });
        }
      }
    },
  };

  let idCounter = 0;
  const ids: IdGeneratorPort = {
    newId: () => {
      idCounter += 1;
      return `id-${idCounter}`;
    },
  };
  const clock: ClockPort = {
    now: () => '2026-06-01T09:00:00.000Z',
    today: () => '2026-06-01',
  };
  const sequences: Record<CounterKey, number> = { quote: 0, invoice: 0, credit: 0 };
  const counters: SequenceCounterPort = {
    allocate: async ({ counterKey, fiscalYear }) => {
      sequences[counterKey] += 1;
      const prefix = counterKey === 'quote' ? 'D' : 'F';
      return {
        sequence: sequences[counterKey],
        formatted: DocNumber.format(prefix, fiscalYear, sequences[counterKey]),
      };
    },
  };

  return {
    company,
    customer,
    companyRepo,
    customerRepo,
    quoteRepo,
    invoiceRepo,
    paymentRepo,
    publicAccessTokens,
    uow,
    ids,
    clock,
    counters,
  };
}

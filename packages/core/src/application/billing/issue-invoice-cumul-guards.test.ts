import { describe, expect, it } from 'vitest';
import { IssueInvoice } from './issue-invoice';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { Quote, type QuoteSnapshot } from '../../domain/billing/quote/quote';
import { Customer } from '../../domain/customer/customer';
import { DocNumber } from '../../domain/billing/shared/doc-number';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { seedCompany } from '../fixtures';
import { type InvoiceRepository } from '../ports/repositories';

/**
 * B2 — REVÉRIFICATION à l'ÉMISSION de la garde de cumul « acompte + situations ≤ marché »
 * (P0) : un brouillon DORMANT (généré avant la finale, ou né d'une course de génération) ne
 * doit JAMAIS s'émettre au-delà du marché signé — la TVA est exigible sur chaque pièce émise
 * (art. 283 du CGI). Client B2B : ni embargo L221-10 ni gel de rétractation (les gardes A3
 * sont couvertes ailleurs — ici, seule la garde de cumul est à l'épreuve).
 */
const AT = '2026-08-01T09:00:00.000Z';
const clock = { now: () => AT, today: () => AT.slice(0, 10) };
const terms = { days: 30, endOfMonth: false, label: 'Paiement à 30 jours' } as const;
const domainTerms = (() => {
  const t = PaymentTerms.of(terms);
  if (!t.ok) throw new Error('terms');
  return t.value;
})();

function signedQuote(over: Partial<QuoteSnapshot> = {}): Quote {
  const company = seedCompany();
  return Quote.rehydrate({
    id: 'quote-1',
    companyId: company.id,
    customerId: 'cust-pro',
    status: 'signed',
    number: 'D-2026-0001',
    depositPct: 30,
    validUntil: null,
    signature: {
      signerName: 'SARL Martin',
      signedAt: '2026-06-01T09:00:00.000Z',
      method: 'onsite_draw',
      accepted: true,
    },
    lines: [
      { id: 'l1', label: 'Chauffe-eau', category: 'supply', qty: 1, unitPriceHT: 80000, vatRate: 10 },
      { id: 'l2', label: 'Pose', category: 'labor', qty: 1, unitPriceHT: 68000, vatRate: 10 },
    ],
    ...over,
  });
}

function makeEnv(quote: Quote) {
  const company = seedCompany();
  const customerR = Customer.of({
    id: 'cust-pro',
    companyId: company.id,
    type: 'b2b',
    name: 'SARL Martin',
    siren: '821503642',
    address: { line1: 'ZA des Bruyères', zip: '92140', city: 'Clamart' },
  });
  if (!customerR.ok) throw new Error('customer');
  const invoices = new Map<string, Invoice>();
  let seq = 100;
  const invoiceRepo: InvoiceRepository = {
    findById: async (id) => invoices.get(id) ?? null,
    lockById: async (id) => invoices.get(id) ?? null,
    findByParentQuoteId: async (companyId, parentQuoteId, kind) =>
      [...invoices.values()].find(
        (i) => i.companyId === companyId && i.parentQuoteId === parentQuoteId && i.kind === kind,
      ) ?? null,
    findCreditNoteBySourceInvoiceId: async () => null,
    listByCompany: async (companyId) =>
      [...invoices.values()].filter((i) => i.companyId === companyId),
    save: async (i) => {
      invoices.set(i.id, i);
    },
    deleteById: async (id) => {
      invoices.delete(id);
    },
  };
  const usecase = new IssueInvoice({
    invoices: invoiceRepo,
    companies: {
      findById: async () => company,
      lockById: async () => company,
      lockForShareById: async () => company,
      list: async () => [company],
      save: async () => {},
    },
    customers: {
      findById: async () => customerR.value,
      listByCompany: async () => [customerR.value],
      save: async () => {},
    },
    quotes: {
      findById: async (id) => (id === quote.id ? quote : null),
      lockById: async (id) => (id === quote.id ? quote : null),
    },
    counters: {
      allocate: async () => {
        seq += 1;
        return { sequence: seq, formatted: DocNumber.format('F', 2026, seq) };
      },
    },
    uow: { runInTransaction: <T>(fn: () => Promise<T>) => fn() },
    clock,
  });
  /** Sème une pièce (brouillon, ou émise avec un numéro dédié). */
  const seed = (invoice: Invoice, issue: boolean, sequence: number): void => {
    if (issue) {
      const assigned = invoice.assignNumber(DocNumber.format('F', 2026, sequence), AT);
      if (!assigned.ok) throw new Error('number');
      const issued = invoice.issue({ mentions: [], terms: domainTerms, issuedAt: '2026-08-01', at: AT });
      if (!issued.ok) throw new Error('issue seed');
    }
    invoices.set(invoice.id, invoice);
  };
  return { usecase, invoices, seed };
}

function situation(quote: Quote, id: string, order: number, targetHtCents: number): Invoice {
  const r = Invoice.situationFromSignedQuote(quote, id, { order, targetHtCents });
  if (!r.ok) throw new Error('situation');
  return r.value;
}

const validationMessage = (r: Awaited<ReturnType<IssueInvoice['execute']>>): string => {
  if (r.ok || r.error.kind !== 'domain') return '';
  const domainError = r.error.error;
  return 'message' in domainError && typeof domainError.message === 'string'
    ? domainError.message
    : '';
};

describe('IssueInvoice — revérification du cumul B2 à l’émission (P0 brouillons dormants)', () => {
  it('brouillon de situation DORMANT : émission refusée après la finale émise', async () => {
    const quote = signedQuote();
    const { usecase, seed } = makeEnv(quote);
    seed(situation(quote, 'sit-dormant', 1, 148000), false, 0); // 100 % en brouillon
    const final = Invoice.fromSignedQuote(quote, 'final', 'fin-1');
    if (!final.ok) throw new Error('final');
    seed(final.value, true, 1); // finale émise à 100 % (aucune pièce émise avant elle)

    const r = await usecase.execute({ invoiceId: 'sit-dormant', terms });
    expect(r.ok).toBe(false);
    expect(validationMessage(r)).toContain('soldé');
  });

  it('acompte DORMANT : émission refusée après la finale émise', async () => {
    const quote = signedQuote();
    const { usecase, seed } = makeEnv(quote);
    const deposit = Invoice.fromSignedQuote(quote, 'deposit', 'dep-dormant');
    if (!deposit.ok) throw new Error('deposit');
    seed(deposit.value, false, 0);
    const final = Invoice.fromSignedQuote(quote, 'final', 'fin-1');
    if (!final.ok) throw new Error('final');
    seed(final.value, true, 1);

    const r = await usecase.execute({ invoiceId: 'dep-dormant', terms });
    expect(r.ok).toBe(false);
  });

  it('deux brouillons de 60 % nés d’une course : le premier s’émet, le second est refusé (cumul)', async () => {
    const quote = signedQuote();
    const { usecase, seed } = makeEnv(quote);
    // 60 % du marché HT 148 000 = 88 800 HT (TTC 97 680) chacun — 120 % à deux.
    seed(situation(quote, 'sit-a', 1, 88800), false, 0);
    seed(situation(quote, 'sit-b', 2, 88800), false, 0);

    const first = await usecase.execute({ invoiceId: 'sit-a', terms });
    expect(first.ok).toBe(true);
    const second = await usecase.execute({ invoiceId: 'sit-b', terms });
    expect(second.ok).toBe(false);
    expect(validationMessage(second)).toContain('Cumul');
  });

  it('finale dont la déduction est PÉRIMÉE (situation émise depuis la génération) : refus, à régénérer', async () => {
    const quote = signedQuote();
    const { usecase, seed } = makeEnv(quote);
    // Finale générée SANS déduction (aucune pièce émise à ce moment-là)…
    const final = Invoice.fromSignedQuote(quote, 'final', 'fin-1');
    if (!final.ok) throw new Error('final');
    seed(final.value, false, 0);
    // …puis une situation de 30 % est émise : la déduction figée (0) est fausse.
    seed(situation(quote, 'sit-1', 1, 44400), true, 1);

    const r = await usecase.execute({ invoiceId: 'fin-1', terms });
    expect(r.ok).toBe(false);
    expect(validationMessage(r)).toContain('régénère');
  });

  it('finale dont la déduction correspond aux pièces émises : émission OK (rien de sur-bloqué)', async () => {
    const quote = signedQuote();
    const { usecase, seed, invoices } = makeEnv(quote);
    const sit = situation(quote, 'sit-1', 1, 44400);
    seed(sit, true, 1); // TTC 48 840 émis
    const final = Invoice.fromSignedQuote(quote, 'final', 'fin-1', {
      depositDeduction: { amountCents: 48840, invoiceId: 'sit-1' },
      situationDeductionCents: 48840,
    });
    if (!final.ok) throw new Error('final');
    seed(final.value, false, 0);

    const r = await usecase.execute({ invoiceId: 'fin-1', terms });
    expect(r.ok).toBe(true);
    expect(invoices.get('fin-1')!.status).toBe('issued');
  });

  it('situation exactement DANS le reste facturable : émission OK (la garde ne sur-bloque pas)', async () => {
    const quote = signedQuote();
    const { usecase, seed } = makeEnv(quote);
    seed(situation(quote, 'sit-1', 1, 44400), true, 1); // 30 % émis
    seed(situation(quote, 'sit-2', 2, 103600), false, 0); // 70 % en brouillon — pile le reste

    const r = await usecase.execute({ invoiceId: 'sit-2', terms });
    expect(r.ok).toBe(true);
  });
});

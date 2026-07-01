import { describe, expect, it } from 'vitest';
import { GenerateInvoiceFromQuote } from './generate-invoice-from-quote';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { type Quote } from '../../domain/billing/quote/quote';
import { Quote as QuoteAggregate } from '../../domain/billing/quote/quote';
import { type InvoiceRepository, type QuoteRepository } from '../ports/repositories';

function signedQuote(depositPct: number | null = 30): Quote {
  return QuoteAggregate.rehydrate({
    id: 'quote-1',
    companyId: 'co-1',
    customerId: 'cus-1',
    status: 'signed',
    number: 'D-2026-0001',
    depositPct,
    validUntil: null,
    signature: {
      signerName: 'Ada Lovelace',
      signedAt: '2026-06-01T09:00:00.000Z',
      method: 'draw',
      accepted: true,
    },
    lines: [
      {
        id: 'line-1',
        label: 'Intervention',
        category: 'labor',
        qty: 1,
        unitPriceHT: 100000,
        vatRate: 20,
      },
    ],
  });
}

function makeEnv(input: { quote?: Quote; failSaveWithConcurrentInvoice?: boolean } = {}) {
  const quote = input.quote ?? signedQuote();
  const invoices = new Map<string, Invoice>();
  let idCounter = 0;
  let saveCalls = 0;

  const quotes: QuoteRepository = {
    findById: async (id) => (id === quote.id ? quote : null),
    lockById: async (id) => (id === quote.id ? quote : null),
    listByCompany: async (companyId) => (quote.companyId === companyId ? [quote] : []),
    save: async () => {},
  };
  const invoiceRepo: InvoiceRepository = {
    findById: async (id) => invoices.get(id) ?? null,
    lockById: async (id) => invoices.get(id) ?? null,
    findByParentQuoteId: async (companyId, parentQuoteId, kind) =>
      [...invoices.values()].find((i) => i.companyId === companyId && i.parentQuoteId === parentQuoteId && i.kind === kind) ?? null,
    listByCompany: async (companyId) => [...invoices.values()].filter((i) => i.companyId === companyId),
    save: async (invoice) => {
      saveCalls += 1;
      if (input.failSaveWithConcurrentInvoice) {
        const concurrent = invoiceFromQuote(quote, invoice.kind, 'invoice-raced');
        invoices.set(concurrent.id, concurrent);
        throw new Error('unique violation');
      }
      invoices.set(invoice.id, invoice);
    },
  };

  return {
    quote,
    invoices: invoiceRepo,
    usecase: new GenerateInvoiceFromQuote({
      quotes,
      invoices: invoiceRepo,
      ids: {
        newId: () => {
          idCounter += 1;
          return `invoice-${idCounter}`;
        },
      },
    }),
    counts: () => ({ saveCalls }),
  };
}

function invoiceFromQuote(quote: Quote, kind: Invoice['kind'], id: string): Invoice {
  const created = Invoice.fromSignedQuote(quote, kind === 'deposit' ? 'deposit' : 'final', id);
  if (!created.ok) throw new Error('test quote should be invoiceable');
  return created.value;
}

describe('GenerateInvoiceFromQuote', () => {
  it('retourne la facture existante quand on rejoue la même génération', async () => {
    const env = makeEnv();

    const first = await env.usecase.execute({ quoteId: env.quote.id, mode: 'deposit' });
    const replay = await env.usecase.execute({ quoteId: env.quote.id, mode: 'deposit' });

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) return;
    expect(replay.value.invoiceId).toBe(first.value.invoiceId);
    expect(await env.invoices.listByCompany(env.quote.companyId)).toHaveLength(1);
    expect(env.counts()).toEqual({ saveCalls: 1 });
  });

  it('autorise une facture acompte et une facture finale pour le même devis', async () => {
    const env = makeEnv();

    const deposit = await env.usecase.execute({ quoteId: env.quote.id, mode: 'deposit' });
    const final = await env.usecase.execute({ quoteId: env.quote.id, mode: 'final' });

    expect(deposit.ok).toBe(true);
    expect(final.ok).toBe(true);
    if (!deposit.ok || !final.ok) return;
    expect(final.value.invoiceId).not.toBe(deposit.value.invoiceId);
    expect((await env.invoices.listByCompany(env.quote.companyId)).map((i) => i.kind).sort()).toEqual(['deposit', 'final']);
    expect(env.counts()).toEqual({ saveCalls: 2 });
  });

  it('récupère la facture concurrente si la sauvegarde échoue sur le doublon DB', async () => {
    const env = makeEnv({ failSaveWithConcurrentInvoice: true });

    const generated = await env.usecase.execute({ quoteId: env.quote.id, mode: 'final' });

    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect(generated.value.invoiceId).toBe('invoice-raced');
    expect(await env.invoices.listByCompany(env.quote.companyId)).toHaveLength(1);
    expect(env.counts()).toEqual({ saveCalls: 1 });
  });
});

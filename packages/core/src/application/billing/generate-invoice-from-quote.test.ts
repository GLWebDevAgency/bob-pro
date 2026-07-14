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
    deleteById: async (id) => {
      invoices.delete(id);
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

  // ── A5 : « déjà facturé » GÉNÉRALISÉ — la finale déduit acompte ET situations émises ──

  /** Pièce déjà émise sur le devis (acompte ou situation BTP) — snapshot minimal réaliste. */
  function issuedSibling(id: string, kind: 'deposit' | 'situation', ht: number, netToPay: number): Invoice {
    const vat = Math.round(ht * 0.2);
    return Invoice.rehydrate({
      id,
      companyId: 'co-1',
      customerId: 'cus-1',
      kind,
      status: 'issued',
      lines: [{ id: `${id}-l1`, label: 'Avancement', category: 'labor', qty: 1, unitPriceHT: ht, vatRate: 20 }],
      number: `F-${id}`,
      frozenTotals: { ht, vatByRate: { '20': vat }, vat, ttc: ht + vat, netToPay },
      mentions: [],
      issuedAt: '2026-06-10',
      dueAt: '2026-07-10',
      paid: 0,
      depositPct: null,
      parentQuoteId: 'quote-1',
    });
  }

  it('A5 : la finale déduit la SOMME acompte + situations émises, sans pièce unique citée', async () => {
    const env = makeEnv();
    // Acompte émis 36 000 c + situation émise 24 000 c (devis 120 000 c TTC).
    await env.invoices.save(issuedSibling('dep', 'deposit', 30000, 36000));
    await env.invoices.save(issuedSibling('sit', 'situation', 20000, 24000));

    const generated = await env.usecase.execute({ quoteId: env.quote.id, mode: 'final' });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const final = await env.invoices.findById(generated.value.invoiceId);
    expect(final?.totals().ttc).toBe(120000);
    // Solde exact = 120 000 − 36 000 − 24 000 ; déduction composite → pas d'invoiceId unique.
    expect(final?.totals().netToPay).toBe(60000);
    expect(final?.toSnapshot().depositDeductionCents).toBe(60000);
    expect(final?.toSnapshot().depositInvoiceId).toBeNull();
  });

  it('A5 : une pièce déjà facturée UNIQUE reste citée (invoiceId conservé) ; brouillon exclu', async () => {
    const env = makeEnv();
    await env.invoices.save(issuedSibling('dep', 'deposit', 30000, 36000));
    // Une situation restée BROUILLON n'existe pas fiscalement : elle ne se déduit pas.
    const draft = issuedSibling('sit-draft', 'situation', 20000, 24000);
    await env.invoices.save(Invoice.rehydrate({ ...draft.toSnapshot(), status: 'draft', number: null }));

    const generated = await env.usecase.execute({ quoteId: env.quote.id, mode: 'final' });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const final = await env.invoices.findById(generated.value.invoiceId);
    expect(final?.totals().netToPay).toBe(84000); // 120 000 − 36 000
    expect(final?.toSnapshot().depositInvoiceId).toBe('dep');
  });

  // ── R3 : mode INFÉRÉ sur un acompte déjà facturé doit avancer vers la finale, pas rejouer
  //    silencieusement l'acompte (bug device : le CTA disait « générée » sans rien créer). ──

  it('R3 ① mode inféré après un acompte déjà généré → CRÉE la facture FINALE (pas un rejeu de l’acompte)', async () => {
    const env = makeEnv(); // devis avec depositPct=30 : l'inférence par défaut vise 'deposit'

    const deposit = await env.usecase.execute({ quoteId: env.quote.id }); // mode inféré → deposit
    expect(deposit.ok).toBe(true);
    if (!deposit.ok) return;

    const again = await env.usecase.execute({ quoteId: env.quote.id }); // mode toujours inféré
    expect(again.ok).toBe(true);
    if (!again.ok) return;

    // Le "prochain pas" naturel : une facture FINALE, distincte de l'acompte déjà émis.
    expect(again.value.invoiceId).not.toBe(deposit.value.invoiceId);
    const kinds = (await env.invoices.listByCompany(env.quote.companyId)).map((i) => i.kind).sort();
    expect(kinds).toEqual(['deposit', 'final']);
    const createdFinal = await env.invoices.findById(again.value.invoiceId);
    expect(createdFinal?.kind).toBe('final');
  });

  it('R3 ② mode:\'deposit\' EXPLICITE avec acompte déjà généré → renvoie l’EXISTANTE (idempotence intacte)', async () => {
    const env = makeEnv();

    const first = await env.usecase.execute({ quoteId: env.quote.id, mode: 'deposit' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replay = await env.usecase.execute({ quoteId: env.quote.id, mode: 'deposit' });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;

    expect(replay.value.invoiceId).toBe(first.value.invoiceId);
    expect(await env.invoices.listByCompany(env.quote.companyId)).toHaveLength(1);
    expect(env.counts()).toEqual({ saveCalls: 1 });
  });

  it('R3 ③ mode:\'final\' EXPLICITE crée la finale, puis la renvoie de façon idempotente', async () => {
    const env = makeEnv();

    const created = await env.usecase.execute({ quoteId: env.quote.id, mode: 'final' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const finalInvoice = await env.invoices.findById(created.value.invoiceId);
    expect(finalInvoice?.kind).toBe('final');

    const replay = await env.usecase.execute({ quoteId: env.quote.id, mode: 'final' });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.invoiceId).toBe(created.value.invoiceId);
    expect(env.counts()).toEqual({ saveCalls: 1 });
  });
});

import { describe, expect, it } from 'vitest';
import { GenerateInvoiceFromQuote } from './generate-invoice-from-quote';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { Quote, type QuoteSnapshot } from '../../domain/billing/quote/quote';
import { Customer, type CustomerProps } from '../../domain/customer/customer';
import { DocNumber } from '../../domain/billing/shared/doc-number';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { type InvoiceRepository, type QuoteRepository } from '../ports/repositories';

const SIGNED_AT = '2026-06-01T09:00:00.000Z';
/** Bien APRÈS embargo (7 j) et rétractation (14 j) du devis signé le 1er juin. */
const LONG_AFTER = '2026-08-01T09:00:00.000Z';
const terms = (() => {
  const t = PaymentTerms.of({ days: 30, endOfMonth: false, label: '30 jours' });
  if (!t.ok) throw new Error('terms');
  return t.value;
})();

function signedQuote(over: Partial<QuoteSnapshot> = {}): Quote {
  return Quote.rehydrate({
    id: 'quote-1',
    companyId: 'co-1',
    customerId: 'cus-1',
    status: 'signed',
    number: 'D-2026-0001',
    depositPct: 30,
    validUntil: null,
    signature: {
      signerName: 'Martin',
      signedAt: SIGNED_AT,
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

/** Surcharges qui acceptent `undefined` pour RETIRER un champ optionnel (ex. siren en b2c). */
type CustomerOver = { [K in keyof CustomerProps]?: CustomerProps[K] | undefined };

function makeEnv(
  input: {
    quote?: Quote;
    customerOver?: CustomerOver;
    now?: string;
  } = {},
) {
  const quote = input.quote ?? signedQuote();
  const invoices = new Map<string, Invoice>();
  let seq = 0;
  const merged = {
    id: quote.customerId,
    companyId: quote.companyId,
    type: 'b2b',
    name: 'SARL Martin',
    siren: '821503646',
    address: { line1: 'ZA des Bruyères', zip: '92140', city: 'Clamart' },
    ...(input.customerOver ?? {}),
  } as Record<string, unknown>;
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  const customerR = Customer.of(merged as unknown as CustomerProps);
  if (!customerR.ok) throw new Error('customer');

  const quotes: QuoteRepository = {
    findById: async (id) => (id === quote.id ? quote : null),
    lockById: async (id) => (id === quote.id ? quote : null),
    listByCompany: async () => [quote],
    save: async () => {},
  };
  const invoiceRepo: InvoiceRepository = {
    findById: async (id) => invoices.get(id) ?? null,
    lockById: async (id) => invoices.get(id) ?? null,
    findByParentQuoteId: async (companyId, parentQuoteId, kind) =>
      [...invoices.values()].find(
        (i) => i.companyId === companyId && i.parentQuoteId === parentQuoteId && i.kind === kind,
      ) ?? null,
    findCreditNoteBySourceInvoiceId: async () => null,
    listByCompany: async (companyId) => [...invoices.values()].filter((i) => i.companyId === companyId),
    save: async (i) => {
      // Émulation FIDÈLE de l'index unique partiel uniq_invoice_parent_quote_situation_order
      // (backstop base des générations concurrentes — migration 20260720030000).
      if (i.kind === 'situation' && i.parentQuoteId !== null && i.situationOrder !== null) {
        const clash = [...invoices.values()].find(
          (other) =>
            other.id !== i.id &&
            other.kind === 'situation' &&
            other.companyId === i.companyId &&
            other.parentQuoteId === i.parentQuoteId &&
            other.situationOrder === i.situationOrder,
        );
        if (clash) throw new Error('uniq_invoice_parent_quote_situation_order');
      }
      invoices.set(i.id, i);
    },
    deleteById: async (id) => {
      invoices.delete(id);
    },
  };
  const usecase = new GenerateInvoiceFromQuote({
    quotes,
    invoices: invoiceRepo,
    customers: { findById: async () => customerR.value },
    ids: { newId: () => `gen-${(seq += 1)}` },
    clock: { now: () => input.now ?? LONG_AFTER, today: () => (input.now ?? LONG_AFTER).slice(0, 10) },
  });

  /** Sème une pièce sœur (émise ou brouillon) directement dans le repo. */
  const seed = (invoice: Invoice, issue: boolean, sequence: number) => {
    if (issue) {
      invoice.assignNumber(DocNumber.format('F', 2026, sequence), SIGNED_AT);
      const issued = invoice.issue({ mentions: [], terms, issuedAt: '2026-06-01', at: SIGNED_AT, frenchBillingMode: 'S1' });
      if (!issued.ok) throw new Error('issue seed');
    }
    invoices.set(invoice.id, invoice);
  };
  return { usecase, quote, invoices, seed };
}

describe('GenerateInvoiceFromQuote — mode situation (B2)', () => {
  it('payload situation requis avec le mode, interdit hors du mode', async () => {
    const { usecase } = makeEnv();
    const missing = await usecase.execute({ quoteId: 'quote-1', mode: 'situation' });
    expect(missing.ok).toBe(false);
    const misplaced = await usecase.execute({
      quoteId: 'quote-1',
      mode: 'final',
      situation: { percent: 30 },
    });
    expect(misplaced.ok).toBe(false);
  });
  it('percent : 30 % du marché → situation n° 1, HT 44 400 / TTC 48 840', async () => {
    const { usecase, invoices } = makeEnv();
    const r = await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 30 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const created = invoices.get(r.value.invoiceId)!;
    expect(created.kind).toBe('situation');
    expect(created.situationOrder).toBe(1);
    expect(created.totals().ht).toBe(44400);
    expect(created.totals().ttc).toBe(48840);
  });
  it('amountHtCents : montant HT direct', async () => {
    const { usecase, invoices } = makeEnv();
    const r = await usecase.execute({
      quoteId: 'quote-1',
      mode: 'situation',
      situation: { amountHtCents: 29600 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(invoices.get(r.value.invoiceId)!.totals().ht).toBe(29600);
  });
  it('percent hors bornes → refus', async () => {
    const { usecase } = makeEnv();
    expect((await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 0 } })).ok).toBe(false);
    expect((await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 101 } })).ok).toBe(false);
  });
  it('PAS d’idempotence par kind : chaque appel crée la situation SUIVANTE (n° d’ordre)', async () => {
    const { usecase, invoices } = makeEnv();
    const first = await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 20 } });
    const second = await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 20 } });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.invoiceId).not.toBe(second.value.invoiceId);
      expect(invoices.get(second.value.invoiceId)!.situationOrder).toBe(2);
    }
  });
  it('garde de CUMUL : acompte émis + situations ≤ marché TTC — le dépassement est refusé', async () => {
    const { usecase, quote, seed } = makeEnv();
    // Acompte 30 % émis : 48 840. Marché 162 800 → reste 113 960 TTC.
    const deposit = Invoice.fromSignedQuote(quote, 'deposit', 'dep-1');
    if (!deposit.ok) throw new Error('deposit');
    seed(deposit.value, true, 1);
    // Situation de 70 % (HT 103 600, TTC 113 960) : passe tout juste.
    const fits = await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 70 } });
    expect(fits.ok).toBe(true);
    // La moindre situation supplémentaire dépasse le marché : refus avec le reste facturable.
    const overflow = await usecase.execute({
      quoteId: 'quote-1',
      mode: 'situation',
      situation: { amountHtCents: 100 },
    });
    expect(overflow.ok).toBe(false);
    if (!overflow.ok && overflow.error.kind === 'domain' && overflow.error.error.code === 'VALIDATION') {
      expect(overflow.error.error.message).toContain('Cumul');
    }
  });
  it('les BROUILLONS de situation réservent leur part dans le cumul (prudence)', async () => {
    const { usecase } = makeEnv();
    const draft = await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 60 } });
    expect(draft.ok).toBe(true);
    const overflow = await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 50 } });
    expect(overflow.ok).toBe(false);
  });
  it('B5 — la retenue du devis s’applique à la situation générée', async () => {
    const quote = signedQuote({ retenueGarantiePct: 5 });
    const { usecase, invoices } = makeEnv({ quote });
    const r = await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 30 } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const t = invoices.get(r.value.invoiceId)!.totals();
      expect(t.retenueGarantieCents).toBe(2442);
      expect(t.netToPay).toBe(46398);
    }
  });
  it('B6 — client pro international : aucune situation produite', async () => {
    const { usecase } = makeEnv({ customerOver: { isInternational: true } });
    const r = await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 30 } });
    expect(r.ok).toBe(false);
  });
  it('embargo L221-10 : b2c signé à domicile, situation refusée pendant 7 jours', async () => {
    const { usecase } = makeEnv({
      customerOver: { type: 'b2c', siren: undefined },
      now: '2026-06-03T09:00:00.000Z',
    });
    const r = await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 30 } });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain') {
      expect(r.error.error.code).toBe('OFF_PREMISES_PAYMENT_EMBARGO');
    }
  });
  it('gel de rétractation : b2c à distance, situation gelée pendant 14 jours (acompte non gelé)', async () => {
    const quote = signedQuote({
      signature: { signerName: 'Martin', signedAt: SIGNED_AT, method: 'remote_link', accepted: true },
    });
    const { usecase } = makeEnv({
      quote,
      customerOver: { type: 'b2c', siren: undefined },
      now: '2026-06-05T09:00:00.000Z',
    });
    const situation = await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 30 } });
    expect(situation.ok).toBe(false);
    if (!situation.ok && situation.error.kind === 'domain') {
      expect(situation.error.error.code).toBe('RETRACTATION_PERIOD_ACTIVE');
    }
    const deposit = await usecase.execute({ quoteId: 'quote-1', mode: 'deposit' });
    expect(deposit.ok).toBe(true);
  });
});

describe('GenerateInvoiceFromQuote — finale après situations (A5 + B2)', () => {
  it('déduit acompte (net) + situations (TTC) et trace la part situations', async () => {
    // B2C : le scénario de calcul reste supporté. En B2B/B2G, la reprise d'acompte est
    // volontairement bloquée tant que le profil Factur-X Extended n'est pas certifié.
    const { usecase, quote, seed, invoices } = makeEnv({
      customerOver: { type: 'b2c', siren: undefined },
    });
    const deposit = Invoice.fromSignedQuote(quote, 'deposit', 'dep-1');
    if (!deposit.ok) throw new Error('deposit');
    seed(deposit.value, true, 1);
    const situation = Invoice.situationFromSignedQuote(quote, 'sit-1', { order: 1, targetHtCents: 44400 });
    if (!situation.ok) throw new Error('situation');
    seed(situation.value, true, 2);

    const r = await usecase.execute({ quoteId: 'quote-1', mode: 'final' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const final = invoices.get(r.value.invoiceId)!;
    expect(final.depositDeductionCents).toBe(97680); // 48 840 + 48 840
    expect(final.situationDeductionCents).toBe(48840);
    expect(final.totals().netToPay).toBe(65120); // 162 800 − 97 680
  });
  it('une situation BROUILLON ne se déduit pas de la finale (aucun effet fiscal)', async () => {
    const { usecase, quote, seed, invoices } = makeEnv();
    const situation = Invoice.situationFromSignedQuote(quote, 'sit-1', { order: 1, targetHtCents: 44400 });
    if (!situation.ok) throw new Error('situation');
    seed(situation.value, false, 0); // brouillon
    const r = await usecase.execute({ quoteId: 'quote-1', mode: 'final' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const final = invoices.get(r.value.invoiceId)!;
      expect(final.depositDeductionCents).toBe(0);
      expect(final.totals().netToPay).toBe(162800);
    }
  });
  it('B5 — situation avec retenue : la finale déduit le TTC PLEIN de la situation (la retenue reste due)', async () => {
    const quote = signedQuote({ retenueGarantiePct: 5, depositPct: null });
    const { usecase, seed, invoices } = makeEnv({ quote });
    const situation = Invoice.situationFromSignedQuote(quote, 'sit-1', { order: 1, targetHtCents: 44400 });
    if (!situation.ok) throw new Error('situation');
    seed(situation.value, true, 1);
    const r = await usecase.execute({ quoteId: 'quote-1', mode: 'final' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const final = invoices.get(r.value.invoiceId)!;
      // Déduction = 48 840 (TTC situation, PAS 46 398) : la retenue n'est jamais refacturée.
      expect(final.depositDeductionCents).toBe(48840);
      // Solde 113 960, retenue 5 % = 5 698 → net 108 262.
      expect(final.totals().retenueGarantieCents).toBe(5698);
      expect(final.totals().netToPay).toBe(108262);
    }
  });
});

describe('GenerateInvoiceFromQuote — garde « marché soldé » (P0 : la finale ferme le devis)', () => {
  it('situation REFUSÉE après la facture finale ÉMISE — même à 1 centime', async () => {
    const { usecase, quote, seed } = makeEnv();
    const final = Invoice.fromSignedQuote(quote, 'final', 'fin-1');
    if (!final.ok) throw new Error('final');
    seed(final.value, true, 1);
    const r = await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { amountHtCents: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain' && r.error.error.code === 'VALIDATION') {
      expect(r.error.error.message).toContain('soldé');
    }
  });
  it('situation REFUSÉE quand une finale en BROUILLON existe (le solde appelé doit rester exact)', async () => {
    const { usecase, quote, seed } = makeEnv();
    const final = Invoice.fromSignedQuote(quote, 'final', 'fin-1');
    if (!final.ok) throw new Error('final');
    seed(final.value, false, 0); // brouillon
    const r = await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 10 } });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain' && r.error.error.code === 'VALIDATION') {
      expect(r.error.error.message).toContain('brouillon');
    }
  });
  it('nouvel ACOMPTE refusé après la finale émise (pièce d’appel sur marché soldé)', async () => {
    const { usecase, quote, seed } = makeEnv();
    const final = Invoice.fromSignedQuote(quote, 'final', 'fin-1');
    if (!final.ok) throw new Error('final');
    seed(final.value, true, 1);
    const r = await usecase.execute({ quoteId: 'quote-1', mode: 'deposit' });
    expect(r.ok).toBe(false);
  });
  it('finale ANNULÉE ou totalement AVOIRÉE : le devis se rouvre aux situations', async () => {
    const { usecase, quote, seed, invoices } = makeEnv();
    const final = Invoice.fromSignedQuote(quote, 'final', 'fin-1');
    if (!final.ok) throw new Error('final');
    seed(final.value, true, 1);
    const cancelled = invoices.get('fin-1')!.cancel('erreur', SIGNED_AT);
    if (!cancelled.ok) throw new Error('cancel');
    const r = await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 10 } });
    expect(r.ok).toBe(true);
  });
  it('scénario du finding : finale émise à 100 % puis situation 100 % → REFUS (jamais 2× le marché)', async () => {
    const { usecase, quote, seed } = makeEnv();
    const final = Invoice.fromSignedQuote(quote, 'final', 'fin-1');
    if (!final.ok) throw new Error('final');
    seed(final.value, true, 1); // 162 800 c TTC émis
    const r = await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 100 } });
    expect(r.ok).toBe(false);
  });
});

describe('GenerateInvoiceFromQuote — n° d’ordre monotone + backstop unique (P1 concurrence)', () => {
  it('un n° d’ordre ANNULÉ n’est jamais réutilisé (max + 1 tout statut)', async () => {
    const { usecase, invoices } = makeEnv();
    const first = await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 20 } });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const cancelled = invoices.get(first.value.invoiceId)!.cancel('erreur', SIGNED_AT);
    if (!cancelled.ok) throw new Error('cancel');
    const second = await usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 20 } });
    expect(second.ok).toBe(true);
    if (second.ok) expect(invoices.get(second.value.invoiceId)!.situationOrder).toBe(2);
  });
  it('deux générations SIMULTANÉES de 60 % : jamais deux pièces au-delà du marché, jamais deux n° identiques', async () => {
    const { usecase, quote, invoices } = makeEnv();
    const [a, b] = await Promise.allSettled([
      usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 60 } }),
      usecase.execute({ quoteId: 'quote-1', mode: 'situation', situation: { percent: 60 } }),
    ]);
    // Le backstop (index unique du n° d'ordre, émulé par le repo) ou la garde de cumul doit
    // arrêter la seconde : une seule situation au plus est créée.
    const successes = [a, b].filter(
      (settled) => settled.status === 'fulfilled' && settled.value.ok,
    );
    expect(successes.length).toBeLessThanOrEqual(1);
    const situations = [...invoices.values()].filter((i) => i.kind === 'situation');
    const cumulTtc = situations.reduce((sum, i) => sum + i.totals().ttc, 0);
    expect(cumulTtc).toBeLessThanOrEqual(quote.totals().ttc);
    const orders = situations.map((i) => i.situationOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

import { describe, expect, it } from 'vitest';
import { GenerateInvoiceFromQuote } from './generate-invoice-from-quote';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { Customer } from '../../domain/customer/customer';
import { type Quote, type QuoteSnapshot } from '../../domain/billing/quote/quote';
import { Quote as QuoteAggregate } from '../../domain/billing/quote/quote';
import { type InvoiceRepository, type QuoteRepository } from '../ports/repositories';

function signedQuote(depositPct: number | null = 30, over: Partial<QuoteSnapshot> = {}): Quote {
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
      method: 'onsite_draw',
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
    ...over,
  });
}

function makeEnv(
  input: {
    quote?: Quote;
    failSaveWithConcurrentInvoice?: boolean;
    /** A3 — type du client (défaut b2b : le gel de rétractation ne concerne que le b2c). */
    customerType?: 'b2c' | 'b2b' | 'b2g';
    customerMissing?: boolean;
    /** A3 — « maintenant » injecté (défaut : bien APRÈS le délai du devis par défaut). */
    now?: string;
    /** Override L221-10 — simule un câblage SANS journal d'audit (fail-closed attendu). */
    withoutAudit?: boolean;
  } = {},
) {
  const quote = input.quote ?? signedQuote();
  const invoices = new Map<string, Invoice>();
  let idCounter = 0;
  let saveCalls = 0;
  const customerR = Customer.of({
    id: quote.customerId,
    companyId: quote.companyId,
    type: input.customerType ?? 'b2b',
    name: 'Client Test',
    address: { line1: '8 allée des Roses', zip: '92190', city: 'Meudon' },
  });
  if (!customerR.ok) throw new Error('customer');

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
    findCreditNoteBySourceInvoiceId: async () => null,
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

  // Journal de l'override L221-10 : les événements payment.embargo_overridden observés.
  const auditEvents: Parameters<
    NonNullable<
      ConstructorParameters<typeof GenerateInvoiceFromQuote>[0]['audit']
    >['embargoOverridden']
  >[0][] = [];

  return {
    quote,
    invoices: invoiceRepo,
    auditEvents,
    usecase: new GenerateInvoiceFromQuote({
      quotes,
      invoices: invoiceRepo,
      customers: {
        findById: async (id) =>
          input.customerMissing === true || id !== quote.customerId ? null : customerR.value,
      },
      ids: {
        newId: () => {
          idCounter += 1;
          return `invoice-${idCounter}`;
        },
      },
      clock: {
        now: () => input.now ?? '2026-07-15T09:00:00.000Z',
        today: () => (input.now ?? '2026-07-15T09:00:00.000Z').slice(0, 10),
      },
      ...(input.withoutAudit === true
        ? {}
        : {
            audit: {
              embargoOverridden: async (event) => {
                auditEvents.push(event);
              },
            },
          }),
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
      number: 'F-2026-0099',
      frozenTotals: { ht, vatByRate: { '20': vat }, vat, ttc: ht + vat, netToPay },
      mentions: [],
      issuedAt: '2026-06-10',
      dueAt: '2026-07-10',
      paid: 0,
      depositPct: null,
      parentQuoteId: 'quote-1',
    });
  }

  function creditFor(source: Invoice, id: string, status: 'draft' | 'issued'): Invoice {
    const created = Invoice.creditNoteFor(source, id);
    if (!created.ok) throw new Error(`credit note: ${JSON.stringify(created.error)}`);
    if (status === 'draft') return created.value;
    return Invoice.rehydrate({
      ...created.value.toSnapshot(),
      status: 'issued',
      number: 'A-2026-0099',
      issuedAt: '2026-06-11',
      dueAt: '2026-06-11',
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

  it('un avoir TOTAL émis sur un acompte annule sa déduction de la future facture finale', async () => {
    const env = makeEnv();
    const deposit = issuedSibling('dep', 'deposit', 30000, 36000);
    await env.invoices.save(deposit);
    await env.invoices.save(creditFor(deposit, 'credit-dep', 'issued'));

    const generated = await env.usecase.execute({ quoteId: env.quote.id, mode: 'final' });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const final = await env.invoices.findById(generated.value.invoiceId);
    expect(final?.totals().netToPay).toBe(120000);
    expect(final?.depositDeductionCents).toBe(0);
  });

  it("un brouillon d'avoir ne modifie jamais la déduction avant son émission", async () => {
    const env = makeEnv();
    const deposit = issuedSibling('dep', 'deposit', 30000, 36000);
    await env.invoices.save(deposit);
    await env.invoices.save(creditFor(deposit, 'credit-dep-draft', 'draft'));

    const generated = await env.usecase.execute({ quoteId: env.quote.id, mode: 'final' });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    const final = await env.invoices.findById(generated.value.invoiceId);
    expect(final?.totals().netToPay).toBe(84000);
    expect(final?.depositDeductionCents).toBe(36000);
  });

  // ── B8 : REPRISE AUTOMATIQUE du bon de commande au point de dérivation devis → facture ──

  it('B8 : la facture générée REPREND le bon de commande du devis (source unique, jamais re-saisi)', async () => {
    const po = { number: 'BC-RATP-4500123456', receivedAt: '2026-06-01T09:00:00.000Z', documentId: 'doc-bc' };
    const quote = QuoteAggregate.rehydrate({ ...signedQuote().toSnapshot(), purchaseOrder: po, revision: 2 });
    const env = makeEnv({ quote });

    const deposit = await env.usecase.execute({ quoteId: quote.id, mode: 'deposit' });
    const final = await env.usecase.execute({ quoteId: quote.id, mode: 'final' });
    expect(deposit.ok && final.ok).toBe(true);
    if (!deposit.ok || !final.ok) return;
    expect((await env.invoices.findById(deposit.value.invoiceId))?.purchaseOrder).toEqual(po);
    expect((await env.invoices.findById(final.value.invoiceId))?.purchaseOrder).toEqual(po);
  });

  it('B8 : devis sans bon de commande -> factures dérivées sans bon de commande (compat)', async () => {
    const env = makeEnv();
    const generated = await env.usecase.execute({ quoteId: env.quote.id, mode: 'final' });
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;
    expect((await env.invoices.findById(generated.value.invoiceId))?.purchaseOrder).toBeNull();
  });

  // ── R3 : chaque intention porte un mode explicite. Un retry HTTP rejoue exactement le même
  //    effet ; il ne peut jamais interpréter « prochain pas » et créer une autre pièce fiscale. ──

  it('R3 ① un retry explicite de l’acompte reste un acompte, même si une finale est possible', async () => {
    const env = makeEnv();

    const deposit = await env.usecase.execute({ quoteId: env.quote.id, mode: 'deposit' });
    expect(deposit.ok).toBe(true);
    if (!deposit.ok) return;

    const retry = await env.usecase.execute({ quoteId: env.quote.id, mode: 'deposit' });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;

    expect(retry.value.invoiceId).toBe(deposit.value.invoiceId);
    expect((await env.invoices.listByCompany(env.quote.companyId)).map((invoice) => invoice.kind)).toEqual(['deposit']);
    expect(env.counts()).toEqual({ saveCalls: 1 });
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

  // ── A3 : GEL de la facture FINALE pendant le délai de rétractation B2C (L221-18 s.) ──
  // Devis par défaut signé le 01/06/2026 (lundi) → délai jusqu'au 16/06/2026 00:00 Paris.

  it('A3 : b2c pendant le délai → finale REFUSÉE avec dates et message honnêtes', async () => {
    const env = makeEnv({ customerType: 'b2c', now: '2026-06-10T09:00:00.000Z' });

    const r = await env.usecase.execute({ quoteId: env.quote.id, mode: 'final' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('domain');
    if (r.error.kind !== 'domain') return;
    expect(r.error.error).toMatchObject({
      code: 'RETRACTATION_PERIOD_ACTIVE',
      quoteId: 'quote-1',
      expiresAt: '2026-06-15T22:00:00.000Z',
      availableFrom: '2026-06-16',
    });
    if (r.error.error.code === 'RETRACTATION_PERIOD_ACTIVE') {
      expect(r.error.error.message).toContain('16/06/2026');
      expect(r.error.error.message).toContain('L221-18');
    }
    expect(await env.invoices.listByCompany(env.quote.companyId)).toHaveLength(0);
  });

  it("A3 : b2c pendant le délai → l'ACOMPTE reste facturable (jamais gelé)", async () => {
    const env = makeEnv({ customerType: 'b2c', now: '2026-06-10T09:00:00.000Z' });

    const r = await env.usecase.execute({ quoteId: env.quote.id, mode: 'deposit' });

    expect(r.ok).toBe(true);
    expect((await env.invoices.listByCompany(env.quote.companyId)).map((i) => i.kind)).toEqual([
      'deposit',
    ]);
  });

  it('A3 : b2c avec exécution anticipée demandée à la signature → AUCUN gel (L221-25)', async () => {
    const quote = signedQuote(30, {
      signature: {
        signerName: 'Ada Lovelace',
        signedAt: '2026-06-01T09:00:00.000Z',
        method: 'remote_link',
        accepted: true,
        earlyExecution: { requestedAt: '2026-06-01T09:00:00.000Z' },
      },
    });
    const env = makeEnv({ quote, customerType: 'b2c', now: '2026-06-10T09:00:00.000Z' });

    const r = await env.usecase.execute({ quoteId: quote.id, mode: 'final' });

    expect(r.ok).toBe(true);
  });

  it('A3 : b2c APRÈS l’expiration du délai → finale possible (déblocage automatique)', async () => {
    const env = makeEnv({ customerType: 'b2c', now: '2026-06-15T22:00:00.000Z' });

    const r = await env.usecase.execute({ quoteId: env.quote.id, mode: 'final' });

    expect(r.ok).toBe(true);
  });

  it.each(['b2b', 'b2g'] as const)('A3 : %s → rien ne change, finale immédiate', async (customerType) => {
    const env = makeEnv({ customerType, now: '2026-06-01T10:00:00.000Z' });

    const r = await env.usecase.execute({ quoteId: env.quote.id, mode: 'final' });

    expect(r.ok).toBe(true);
  });

  it('A3 : signature legacy (méthode inconnue) b2c → même présomption, gel pendant le délai', async () => {
    const quote = signedQuote(null, {
      signature: {
        signerName: 'Ada Lovelace',
        signedAt: '2026-06-01T09:00:00.000Z',
        method: 'legacy_declared',
        accepted: true,
      },
    });
    const env = makeEnv({ quote, customerType: 'b2c', now: '2026-06-10T09:00:00.000Z' });

    const r = await env.usecase.execute({ quoteId: quote.id, mode: 'final' });

    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain')
      expect(r.error.error.code).toBe('RETRACTATION_PERIOD_ACTIVE');
  });

  it('A3 : une finale DÉJÀ existante est renvoyée telle quelle (idempotence avant gel)', async () => {
    // Une finale née AVANT le gel (données antérieures à A3) reste la vérité : rejouer la
    // demande pendant le délai renvoie l'EXISTANTE — on ne crée rien, on ne refuse rien.
    const env = makeEnv({ customerType: 'b2c', now: '2026-06-10T09:00:00.000Z' });
    await env.invoices.save(invoiceFromQuote(env.quote, 'final', 'final-legacy'));

    const replay = await env.usecase.execute({ quoteId: env.quote.id, mode: 'final' });

    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.value.invoiceId).toBe('final-legacy');
    expect(await env.invoices.listByCompany(env.quote.companyId)).toHaveLength(1);
  });

  it('A3 : client introuvable au moment de la finale → refus fail-closed', async () => {
    const env = makeEnv({ customerMissing: true, now: '2026-07-15T09:00:00.000Z' });

    const r = await env.usecase.execute({ quoteId: env.quote.id, mode: 'final' });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
    expect(await env.invoices.listByCompany(env.quote.companyId)).toHaveLength(0);
  });
});

describe('GenerateInvoiceFromQuote — embargo de paiement L221-10 (contrat hors établissement)', () => {
  // Devis signé SUR PLACE le 01/06/2026 → embargo jusqu'au 09/06 00:00 Paris (08/06 22:00 UTC).
  const duringEmbargo = '2026-06-03T09:00:00.000Z';

  it.each(['deposit', 'final'] as const)(
    'b2c signé sur place, pendant les 7 jours → %s BLOQUÉ (aucun paiement exigible, L221-10)',
    async (mode) => {
      const env = makeEnv({ customerType: 'b2c', now: duringEmbargo });
      const r = await env.usecase.execute({ quoteId: env.quote.id, mode });
      expect(r.ok).toBe(false);
      if (r.ok || r.error.kind !== 'domain') throw new Error('erreur domaine attendue');
      expect(r.error.error).toMatchObject({
        code: 'OFF_PREMISES_PAYMENT_EMBARGO',
        quoteId: 'quote-1',
        expiresAt: '2026-06-08T22:00:00.000Z',
        availableFrom: '2026-06-09',
      });
      if (r.error.error.code === 'OFF_PREMISES_PAYMENT_EMBARGO') {
        expect(r.error.error.message).toContain('L221-10');
        expect(r.error.error.message).toContain('09/06/2026');
      }
      expect(await env.invoices.listByCompany(env.quote.companyId)).toHaveLength(0);
    },
  );

  it("l'exécution anticipée (L221-25) ne lève PAS l'embargo : elle autorise les travaux, jamais le paiement", async () => {
    const quote = signedQuote(30, {
      signature: {
        signerName: 'Ada Lovelace',
        signedAt: '2026-06-01T09:00:00.000Z',
        method: 'onsite_draw',
        accepted: true,
        earlyExecution: { requestedAt: '2026-06-01T09:00:00.000Z' },
      },
    });
    const env = makeEnv({ quote, customerType: 'b2c', now: duringEmbargo });
    const r = await env.usecase.execute({ quoteId: quote.id, mode: 'deposit' });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain')
      expect(r.error.error.code).toBe('OFF_PREMISES_PAYMENT_EMBARGO');
  });

  it('contrat À DISTANCE (remote_link) : pas d’embargo — acompte immédiatement facturable', async () => {
    const quote = signedQuote(30, {
      signature: {
        signerName: 'Ada Lovelace',
        signedAt: '2026-06-01T09:00:00.000Z',
        method: 'remote_link',
        accepted: true,
      },
    });
    const env = makeEnv({ quote, customerType: 'b2c', now: duringEmbargo });
    const r = await env.usecase.execute({ quoteId: quote.id, mode: 'deposit' });
    expect(r.ok).toBe(true);
  });

  it('professionnel (b2b) signé sur place : hors champ L221-10 — jamais bloqué', async () => {
    const env = makeEnv({ customerType: 'b2b', now: duringEmbargo });
    const r = await env.usecase.execute({ quoteId: env.quote.id, mode: 'deposit' });
    expect(r.ok).toBe(true);
  });

  it('embargo expiré (J+8) : acompte facturable — la fenêtre est bornée', async () => {
    const env = makeEnv({ customerType: 'b2c', now: '2026-06-09T09:00:00.000Z' });
    const r = await env.usecase.execute({ quoteId: env.quote.id, mode: 'deposit' });
    expect(r.ok).toBe(true);
  });

  it('qualité FIGÉE à la conclusion : fiche passée b2b après signature b2c → embargo maintenu', async () => {
    const quote = signedQuote(30, {
      signature: {
        signerName: 'Ada Lovelace',
        signedAt: '2026-06-01T09:00:00.000Z',
        method: 'onsite_draw',
        accepted: true,
        customerType: 'b2c',
      },
    });
    // La fiche client est aujourd'hui b2b : le contrat a pourtant été conclu avec un consommateur.
    const env = makeEnv({ quote, customerType: 'b2b', now: duringEmbargo });
    const r = await env.usecase.execute({ quoteId: quote.id, mode: 'deposit' });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain')
      expect(r.error.error.code).toBe('OFF_PREMISES_PAYMENT_EMBARGO');
  });

  it('qualité FIGÉE à la conclusion : fiche passée b2c après signature b2b → aucun gel rétroactif', async () => {
    const quote = signedQuote(30, {
      signature: {
        signerName: 'Ada Lovelace',
        signedAt: '2026-06-01T09:00:00.000Z',
        method: 'onsite_draw',
        accepted: true,
        customerType: 'b2b',
      },
    });
    const env = makeEnv({ quote, customerType: 'b2c', now: duringEmbargo });
    const r = await env.usecase.execute({ quoteId: quote.id, mode: 'deposit' });
    expect(r.ok).toBe(true);
  });
});

describe('GenerateInvoiceFromQuote — contrat rétracté (fonctionnalité en ligne L221-21)', () => {
  it.each(['deposit', 'final'] as const)(
    'devis rétracté → %s refusé (le contrat ne produit plus aucune pièce)',
    async (mode) => {
      const quote = signedQuote(30, { retractedAt: '2026-06-05T10:00:00.000Z' });
      const env = makeEnv({ quote, customerType: 'b2c', now: '2026-07-15T09:00:00.000Z' });
      const r = await env.usecase.execute({ quoteId: quote.id, mode });
      expect(r.ok).toBe(false);
      if (r.ok || r.error.kind !== 'domain') throw new Error('erreur domaine attendue');
      expect(r.error.error.code).toBe('QUOTE_RETRACTED');
      if (r.error.error.code === 'QUOTE_RETRACTED')
        expect(r.error.error.message).toContain('rétractation');
      expect(await env.invoices.listByCompany(quote.companyId)).toHaveLength(0);
    },
  );
});

describe('GenerateInvoiceFromQuote — exception dépannage urgent (art. L221-10, al. 2)', () => {
  const duringEmbargo = '2026-06-03T09:00:00.000Z';

  it("intervention urgente TRACÉE à la création → pas d'embargo : acompte immédiat", async () => {
    const quote = signedQuote(30, { urgentRepair: { requestedAt: '2026-05-30T08:00:00.000Z' } });
    const env = makeEnv({ quote, customerType: 'b2c', now: duringEmbargo });
    const r = await env.usecase.execute({ quoteId: quote.id, mode: 'deposit' });
    expect(r.ok).toBe(true);
    expect(env.auditEvents).toHaveLength(0); // exception légale, pas un override
  });

  it('urgence tracée : la FINALE reste gelée pendant le délai de rétractation (prudence — strict nécessaire seulement)', async () => {
    const quote = signedQuote(30, { urgentRepair: { requestedAt: '2026-05-30T08:00:00.000Z' } });
    const env = makeEnv({ quote, customerType: 'b2c', now: duringEmbargo });
    const r = await env.usecase.execute({ quoteId: quote.id, mode: 'final' });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain')
      expect(r.error.error.code).toBe('RETRACTATION_PERIOD_ACTIVE');
  });
});

describe('GenerateInvoiceFromQuote — override responsabilisé de l’embargo L221-10', () => {
  const duringEmbargo = '2026-06-03T09:00:00.000Z';

  it("refus par défaut : l'erreur porte overridable + le risque concret (source unique)", async () => {
    const env = makeEnv({ customerType: 'b2c', now: duringEmbargo });
    const r = await env.usecase.execute({ quoteId: env.quote.id, mode: 'deposit' });
    expect(r.ok).toBe(false);
    if (r.ok || r.error.kind !== 'domain') throw new Error('erreur domaine attendue');
    expect(r.error.error).toMatchObject({ code: 'OFF_PREMISES_PAYMENT_EMBARGO', overridable: true });
    if (r.error.error.code === 'OFF_PREMISES_PAYMENT_EMBARGO') {
      expect(r.error.error.overrideRisk).toContain('L242-1');
      expect(r.error.error.overrideRisk).toContain('09/06/2026');
    }
  });

  it('embargoOverride: true EXPLICITE → la pièce est produite ET payment.embargo_overridden est journalisé', async () => {
    const env = makeEnv({ customerType: 'b2c', now: duringEmbargo });
    const r = await env.usecase.execute({
      quoteId: env.quote.id,
      mode: 'deposit',
      embargoOverride: true,
    });
    expect(r.ok).toBe(true);
    expect(env.auditEvents).toEqual([
      {
        type: 'payment.embargo_overridden',
        quoteId: 'quote-1',
        companyId: 'co-1',
        invoiceKind: 'deposit',
        embargoExpiresAt: '2026-06-08T22:00:00.000Z',
        occurredAt: duringEmbargo,
      },
    ]);
  });

  it('journal indisponible → override REFUSÉ (fail-closed : jamais de contournement sans trace)', async () => {
    const env = makeEnv({ customerType: 'b2c', now: duringEmbargo, withoutAudit: true });
    const r = await env.usecase.execute({
      quoteId: env.quote.id,
      mode: 'deposit',
      embargoOverride: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain')
      expect(r.error.error.code).toBe('OFF_PREMISES_PAYMENT_EMBARGO');
  });

  it("l'override ne lève JAMAIS le gel de rétractation de la FINALE (protection du client, non contournable)", async () => {
    const env = makeEnv({ customerType: 'b2c', now: duringEmbargo });
    const r = await env.usecase.execute({
      quoteId: env.quote.id,
      mode: 'final',
      embargoOverride: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain')
      expect(r.error.error.code).toBe('RETRACTATION_PERIOD_ACTIVE');
    // L'embargo, lui, a bien été contourné et TRACÉ — le refus vient du gel, pas de l'embargo.
    expect(env.auditEvents).toHaveLength(1);
  });

  it('hors embargo, embargoOverride est inerte : aucun événement journalisé', async () => {
    const env = makeEnv({ customerType: 'b2c', now: '2026-06-20T09:00:00.000Z' });
    const r = await env.usecase.execute({
      quoteId: env.quote.id,
      mode: 'deposit',
      embargoOverride: true,
    });
    expect(r.ok).toBe(true);
    expect(env.auditEvents).toHaveLength(0);
  });
});

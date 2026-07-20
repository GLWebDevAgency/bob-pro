import { describe, it, expect } from 'vitest';
import {
  deriveTodayPriorities,
  todayCompanyFromDiagnostic,
  type TodayInvoiceData,
  type TodayQuoteData,
  type TodayCustomerData,
  type DeriveTodayPrioritiesInput,
} from './derive-today-priorities';
import { CreateQuote } from '../billing/create-quote';
import { SendQuote } from '../billing/send-quote';
import { SignQuote } from '../billing/sign-quote';
import { GenerateInvoiceFromQuote } from '../billing/generate-invoice-from-quote';
import { IssueInvoice } from '../billing/issue-invoice';
import { RegisterPayment } from '../billing/register-payment';
import { makeEnv } from '../billing/in-memory-env';
import { runDiagnostic } from '../../domain/compliance/diagnostic';
import { type Invoice } from '../../domain/billing/invoice/invoice';
import { type Quote } from '../../domain/billing/quote/quote';
import { type Totals } from '../../domain/billing/shared/totals';

// ── Projections aggregate → données d'entrée (mêmes champs que les vues api-client) ──

function invoiceData(i: Invoice): TodayInvoiceData {
  return {
    id: i.id,
    customerId: i.customerId,
    kind: i.kind,
    status: i.status,
    number: i.number,
    parentQuoteId: i.parentQuoteId,
    totals: i.totals(),
    dueAt: i.dueAt,
    paid: i.paid,
  };
}

function quoteData(q: Quote): TodayQuoteData {
  return {
    id: q.id,
    customerId: q.customerId,
    status: q.status,
    number: q.number,
    totals: q.totals(),
  };
}

// ── Fixtures unitaires ciblées (fonction pure : données en clair suffisent) ──

function totalsOf(ttc: number, netToPay: number = ttc): Totals {
  return { ht: ttc, vatByRate: {}, vat: 0, ttc, netToPay };
}

function invoiceFixture(
  overrides: Partial<TodayInvoiceData> & Pick<TodayInvoiceData, 'id'>,
): TodayInvoiceData {
  return {
    customerId: 'cust-1',
    kind: 'final',
    status: 'issued',
    number: null,
    parentQuoteId: null,
    totals: totalsOf(100000),
    dueAt: '2026-07-01',
    paid: 0,
    ...overrides,
  };
}

const CUSTOMERS: TodayCustomerData[] = [
  { id: 'cust-1', name: 'M. Martin', email: 'martin@example.fr' },
  { id: 'cust-2', name: 'Durand SARL', email: 'compta@durand.fr' },
];

function derive(partial: Partial<DeriveTodayPrioritiesInput>) {
  return deriveTodayPriorities({
    invoices: [],
    quotes: [],
    customers: CUSTOMERS,
    today: '2026-07-10',
    ...partial,
  });
}

describe('deriveTodayPriorities', () => {
  it('cas nominal (harnais in-memory) : relance + facture finale + conformité, dans cet ordre', async () => {
    const env = makeEnv();
    const create = new CreateQuote({
      quotes: env.quoteRepo,
      companies: env.companyRepo,
      customers: env.customerRepo,
      ids: env.ids,
      clock: env.clock,
    });
    const send = new SendQuote({
      companies: env.companyRepo,
      quotes: env.quoteRepo,
      counters: env.counters,
      uow: env.uow,
      clock: env.clock,
    });
    const sign = new SignQuote({
      companies: env.companyRepo,
      customers: env.customerRepo,
      quotes: env.quoteRepo,
      publicAccessTokens: env.publicAccessTokens,
      uow: env.uow,
      clock: env.clock,
    });
    const generate = new GenerateInvoiceFromQuote({
      quotes: env.quoteRepo,
      invoices: env.invoiceRepo,
      customers: env.customerRepo,
      ids: env.ids,
      clock: env.clock,
    });
    const issue = new IssueInvoice({
      invoices: env.invoiceRepo,
      companies: env.companyRepo,
      customers: env.customerRepo,
      quotes: env.quoteRepo,
      counters: env.counters,
      uow: env.uow,
      clock: env.clock,
    });
    // Signature À DISTANCE (contrat à distance, art. L221-1, I-1°) : l'interdiction de paiement
    // de 7 jours (art. L221-10 c. conso) ne vise que le contrat HORS ÉTABLISSEMENT — le
    // scénario « facturé/émis le 01/06, jour de la signature » n'est légal que par ce canal.
    const signRemotely = async (quoteId: string, signerName: string, earlyExecutionRequested?: boolean) => {
      const grant = await env.publicAccessTokens.create({
        companyId: env.company.id,
        resourceType: 'quote',
        resourceId: quoteId,
        scope: 'quote_signature',
        expiresAt: '2026-06-02T09:00:00.000Z',
      });
      return sign.execute({
        quoteId,
        signerName,
        remoteGrant: { token: grant.token, grantId: grant.id },
        ...(earlyExecutionRequested ? { earlyExecutionRequested: true } : {}),
      });
    };

    // Devis A (Durand, acompte 30 %) : signé → facture d'acompte émise et PAYÉE, pas de facture finale.
    const quoteA = await create.execute({
      companyId: env.company.id,
      customerId: 'cust-durand',
      lines: [
        { label: 'Chauffe-eau 200 L', category: 'supply', qty: 1, unitPriceHT: 80000, vatRate: 10 },
        { label: "Main d'oeuvre", category: 'labor', qty: 1, unitPriceHT: 68000, vatRate: 10 },
      ],
      depositPct: 30,
      context: { housingOlderThan2y: true },
    });
    expect(quoteA.ok).toBe(true);
    if (!quoteA.ok) return;
    expect((await send.execute({ quoteId: quoteA.value.quoteId })).ok).toBe(true);
    expect((await signRemotely(quoteA.value.quoteId, 'Mme Durand')).ok).toBe(true);
    const depositA = await generate.execute({ quoteId: quoteA.value.quoteId, mode: 'deposit' });
    expect(depositA.ok).toBe(true);
    if (!depositA.ok) return;
    const paymentTerms = {
      days: 30,
      endOfMonth: false,
      label: 'Paiement à 30 jours',
    } as const;
    expect(
      (await issue.execute({ invoiceId: depositA.value.invoiceId, terms: paymentTerms })).ok,
    ).toBe(true);
    const paidA = await new RegisterPayment({
      invoices: env.invoiceRepo,
      payments: env.paymentRepo,
      uow: env.uow,
      ids: env.ids,
      clock: env.clock,
    }).execute({ invoiceId: depositA.value.invoiceId, amount: 48840, method: 'transfer' });
    expect(paidA.ok).toBe(true);

    // Devis B (Bernard, sans acompte) : facture finale émise le 2026-06-01, échue au 2026-07-01, JAMAIS payée.
    const quoteB = await create.execute({
      companyId: env.company.id,
      customerId: env.customer.id,
      lines: [
        { label: 'Intervention', category: 'labor', qty: 1, unitPriceHT: 50000, vatRate: 20 },
      ],
    });
    expect(quoteB.ok).toBe(true);
    if (!quoteB.ok) return;
    expect((await send.execute({ quoteId: quoteB.value.quoteId })).ok).toBe(true);
    // A3 : M. Bernard (b2c) demande l'exécution anticipée en signant (L221-25) — sans elle, la
    // facture FINALE serait légalement gelée 14 jours et le scénario « émise le 01/06 » impossible.
    expect((await signRemotely(quoteB.value.quoteId, 'M. Bernard', true)).ok).toBe(true);
    const finalB = await generate.execute({ quoteId: quoteB.value.quoteId, mode: 'final' });
    expect(finalB.ok).toBe(true);
    if (!finalB.ok) return;
    expect(
      (await issue.execute({ invoiceId: finalB.value.invoiceId, terms: paymentTerms })).ok,
    ).toBe(true);

    const invoices = (await env.invoiceRepo.listByCompany(env.company.id)).map(invoiceData);
    const quotes = (await env.quoteRepo.listByCompany(env.company.id)).map(quoteData);
    const customers = (await env.customerRepo.listByCompany(env.company.id)).map((c) => ({
      id: c.id,
      name: c.name,
    }));
    const company = todayCompanyFromDiagnostic(
      runDiagnostic({
        country: 'FR',
        trade: env.company.trade,
        vatRegime: env.company.vatRegime,
        customerTypes: ['b2b', 'b2c'],
        hasDecennale: true,
        asOf: '2026-07-10',
      }),
    );

    const priorities = deriveTodayPriorities({
      invoices,
      quotes,
      customers,
      company,
      today: '2026-07-10',
    });

    expect(priorities.map((p) => p.kind)).toEqual(['relance', 'facture_finale', 'conformite']);
    expect(priorities[0]).toMatchObject({
      kind: 'relance',
      invoiceId: finalB.value.invoiceId,
      customerName: 'M. Bernard',
      docNumber: 'F-2026-0002',
      amountCents: 60000, // netToPay entier, rien d'encaissé
      daysLate: 9, // échéance 2026-07-01 → aujourd'hui 2026-07-10
    });
    expect(priorities[1]).toMatchObject({
      kind: 'facture_finale',
      quoteId: quoteA.value.quoteId,
      customerName: 'Mme Durand',
      docNumber: 'D-2026-0001',
      amountCents: 162800 - 48840, // ttc du devis − acompte net encaissé (plafond netToPay)
    });
    expect(priorities[2]).toMatchObject({ kind: 'conformite', id: 'conformite-einvoice-2026' });
  });

  it('cas vide : aucune donnée → zéro priorité (état vide de premier rang)', () => {
    expect(derive({ customers: [] })).toEqual([]);
    expect(derive({ company: { einvoiceReceptionConfigured: true } })).toEqual([]);
  });

  it('ne fabrique aucun client pour une facture ou un devis orphelin', () => {
    const depositPaid = invoiceFixture({
      id: 'deposit-orphan',
      customerId: 'missing-customer',
      kind: 'deposit',
      status: 'paid',
      parentQuoteId: 'quote-orphan',
      paid: 30000,
      totals: totalsOf(30000),
    });
    expect(
      derive({
        invoices: [
          invoiceFixture({ id: 'late-orphan', customerId: 'missing-customer' }),
          depositPaid,
        ],
        quotes: [
          {
            id: 'quote-orphan',
            customerId: 'missing-customer',
            status: 'signed',
            number: 'D-2026-0099',
            totals: totalsOf(100000),
          },
        ],
      }),
    ).toEqual([]);
  });

  it('exclut les factures payées, annulées, non échues — et les avoirs', () => {
    const priorities = derive({
      invoices: [
        invoiceFixture({ id: 'inv-paid', status: 'paid', paid: 100000 }),
        invoiceFixture({ id: 'inv-cancelled', status: 'cancelled' }),
        invoiceFixture({ id: 'inv-not-due', dueAt: '2026-07-20' }),
        invoiceFixture({ id: 'inv-draft', status: 'draft', dueAt: null }),
        invoiceFixture({ id: 'inv-credit', kind: 'credit_note', totals: totalsOf(-50000, -50000) }),
      ],
    });
    expect(priorities).toEqual([]);
  });

  it('relance une facture partiellement payée pour le reste dû (plafond netToPay, jamais ttc)', () => {
    const priorities = derive({
      invoices: [
        invoiceFixture({
          id: 'inv-partial',
          status: 'partially_paid',
          number: 'F-2026-0088',
          totals: totalsOf(162800, 48840), // acompte 30 % : netToPay < ttc
          paid: 20000,
        }),
      ],
    });
    expect(priorities).toEqual([
      {
        kind: 'relance',
        id: 'relance-inv-partial',
        invoiceId: 'inv-partial',
        customerId: 'cust-1',
        customerName: 'M. Martin',
        docNumber: 'F-2026-0088',
        amountCents: 28840, // netToPay 48 840 − 20 000 encaissés
        daysLate: 9,
      },
    ]);
  });

  it('trie les relances par retard puis montant, avant les factures finales', () => {
    const priorities = derive({
      invoices: [
        invoiceFixture({ id: 'inv-small-9j', totals: totalsOf(1000) }),
        invoiceFixture({ id: 'inv-big-9j', totals: totalsOf(2000) }),
        invoiceFixture({ id: 'inv-20j', dueAt: '2026-06-20', totals: totalsOf(500) }),
        invoiceFixture({
          id: 'inv-deposit-paid',
          kind: 'deposit',
          status: 'paid',
          parentQuoteId: 'quote-1',
          totals: totalsOf(30000, 30000),
          paid: 30000,
        }),
      ],
      quotes: [
        {
          id: 'quote-1',
          customerId: 'cust-2',
          status: 'signed',
          number: 'D-2026-0001',
          totals: totalsOf(100000, 30000),
        },
      ],
    });
    expect(priorities.map((p) => p.id)).toEqual([
      'relance-inv-20j', // 20 j de retard d'abord
      'relance-inv-big-9j', // à retard égal, montant le plus élevé
      'relance-inv-small-9j',
      'facture-finale-quote-1', // les relances passent toujours devant
    ]);
    expect(priorities[3]).toMatchObject({
      kind: 'facture_finale',
      amountCents: 70000,
      customerName: 'Durand SARL',
    });
  });

  it("n'émet pas de facture finale si l'acompte n'est pas payé ou si une finale existe déjà (même brouillon)", () => {
    const signedQuote: TodayQuoteData = {
      id: 'quote-1',
      customerId: 'cust-2',
      status: 'signed',
      number: 'D-2026-0001',
      totals: totalsOf(100000, 30000),
    };
    const depositIssued = invoiceFixture({
      id: 'inv-deposit',
      kind: 'deposit',
      status: 'issued',
      parentQuoteId: 'quote-1',
      totals: totalsOf(30000, 30000),
      dueAt: '2026-08-01', // non échue : pas de relance parasite
    });
    // Acompte émis mais pas encaissé → rien.
    expect(derive({ invoices: [depositIssued], quotes: [signedQuote] })).toEqual([]);
    // Acompte payé mais finale déjà en brouillon → action déjà engagée, rien.
    const depositPaid = {
      ...depositIssued,
      id: 'inv-deposit-paid',
      status: 'paid' as const,
      paid: 30000,
    };
    const finalDraft = invoiceFixture({
      id: 'inv-final-draft',
      status: 'draft',
      parentQuoteId: 'quote-1',
      dueAt: null,
    });
    expect(derive({ invoices: [depositPaid, finalDraft], quotes: [signedQuote] })).toEqual([]);
    // Devis non signé → rien, même avec acompte payé.
    expect(
      derive({ invoices: [depositPaid], quotes: [{ ...signedQuote, status: 'sent' }] }),
    ).toEqual([]);
  });

  // ── Devis à transmettre (cas terrain fondateur 2026-07-20) ────────────────────
  //
  // Le serveur répond `deliveryStatus: 'skipped'` quand le client n'a PAS d'e-mail : le devis
  // passe quand même `sent` (le numéro légal est alloué, art. A1 — la machine à états ne bouge
  // pas), mais personne ne l'a reçu. La priorité se DÉRIVE de cet état, sans nouveau statut.
  describe('devis à transmettre', () => {
    const sentQuote: TodayQuoteData = {
      id: 'quote-tel',
      customerId: 'cust-3',
      status: 'sent',
      number: 'D-2026-0007',
      totals: totalsOf(240000),
    };
    /** Client dont SEUL le téléphone est connu : e-mail explicitement absent (null). */
    const phoneOnly: TodayCustomerData = { id: 'cust-3', name: 'Mme Leroy', email: null };

    it('signale un devis envoyé dont le client n’a pas d’e-mail (montant TTC en jeu)', () => {
      expect(derive({ quotes: [sentQuote], customers: [phoneOnly] })).toEqual([
        {
          kind: 'devis_a_transmettre',
          id: 'devis-a-transmettre-quote-tel',
          quoteId: 'quote-tel',
          customerId: 'cust-3',
          customerName: 'Mme Leroy',
          docNumber: 'D-2026-0007',
          amountCents: 240000,
        },
      ]);
    });

    it('ne se déclenche pas si le client a une adresse e-mail (l’envoi a bien eu lieu)', () => {
      expect(
        derive({
          quotes: [{ ...sentQuote, customerId: 'cust-1' }],
          customers: CUSTOMERS,
        }),
      ).toEqual([]);
    });

    it('ne se déclenche pas sur un e-mail vide ou seulement des espaces — mais bien sur null', () => {
      expect(
        derive({ quotes: [sentQuote], customers: [{ ...phoneOnly, email: '   ' }] }),
      ).toHaveLength(1);
      expect(derive({ quotes: [sentQuote], customers: [{ ...phoneOnly, email: '' }] })).toHaveLength(
        1,
      );
      expect(
        derive({ quotes: [sentQuote], customers: [{ ...phoneOnly, email: ' a@b.fr ' }] }),
      ).toEqual([]);
    });

    it('fail-closed : e-mail NON FOURNI par l’appelant (undefined) = inconnu, aucune priorité', () => {
      expect(derive({ quotes: [sentQuote], customers: [{ id: 'cust-3', name: 'Mme Leroy' }] })).toEqual(
        [],
      );
    });

    it('disparaît dès que le devis a été vu, signé, refusé ou expiré — et n’existe pas en brouillon', () => {
      for (const status of ['draft', 'viewed', 'signed', 'refused', 'expired'] as const) {
        expect(
          derive({ quotes: [{ ...sentQuote, status }], customers: [phoneOnly] }),
        ).toEqual([]);
      }
    });

    it('n’invente aucun client pour un devis orphelin', () => {
      expect(derive({ quotes: [sentQuote], customers: [] })).toEqual([]);
    });

    it('trie par montant décroissant et passe après relances et factures finales, avant la conformité', () => {
      const priorities = derive({
        invoices: [invoiceFixture({ id: 'inv-late' })],
        quotes: [
          { ...sentQuote, id: 'quote-small', number: 'D-2026-0008', totals: totalsOf(50000) },
          sentQuote,
        ],
        customers: [...CUSTOMERS, phoneOnly],
        company: { einvoiceReceptionConfigured: false },
      });
      expect(priorities.map((p) => p.id)).toEqual([
        'relance-inv-late',
        'devis-a-transmettre-quote-tel', // 2 400 € avant 500 €
        'devis-a-transmettre-quote-small',
        'conformite-einvoice-2026',
      ]);
    });
  });

  it('conformité : uniquement sur signal réel non configuré, une seule fois', () => {
    expect(derive({})).toEqual([]); // sans signal company, on n'invente rien
    expect(derive({ company: { einvoiceReceptionConfigured: true } })).toEqual([]);
    expect(derive({ company: { einvoiceReceptionConfigured: false } })).toEqual([
      { kind: 'conformite', id: 'conformite-einvoice-2026' },
    ]);
  });

  it('todayCompanyFromDiagnostic projette l’item einvoice-reception du diagnostic réel', () => {
    expect(
      todayCompanyFromDiagnostic({ items: [{ id: 'einvoice-reception', status: 'todo' }] }),
    ).toEqual({
      einvoiceReceptionConfigured: false,
    });
    expect(
      todayCompanyFromDiagnostic({ items: [{ id: 'einvoice-reception', status: 'ok' }] }),
    ).toEqual({
      einvoiceReceptionConfigured: true,
    });
    // Pays non couvert : pas d'item réception → rien à préparer, pas de priorité inventée.
    expect(todayCompanyFromDiagnostic({ items: [] })).toEqual({
      einvoiceReceptionConfigured: true,
    });
  });
});

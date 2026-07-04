import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { jwtVerify } from 'jose';
import { Company, Customer, MERCIER_PROPS, deriveVatPosition } from '@bob/core';
import type { OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import { SupabaseAuthGuard } from './auth/auth.guard';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

// jose mocké (même politique que fiscal-calendar.test) : on teste le CONTRAT du guard sur les
// nouveaux endpoints (JWT + tenant requis), pas la crypto — jwtVerify est piloté par chaque test.
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => async () => ({})),
  jwtVerify: vi.fn(),
}));
const jwtVerifyMock = vi.mocked(jwtVerify);

function makeService() {
  const p = new InMemoryPersistence();
  const admin: SupabaseAdminPort = { setUserCompanyId: vi.fn(async () => undefined) };
  const logger = { audit: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() } as unknown as AppLogger;
  // Livraison notifications stubée « done » : sendQuote (flow d'émission) n'atteint jamais un tiers en test.
  const notificationDelivery = {
    enqueue: vi.fn(async () => ({ id: 'job-1', status: 'done', notification: null })),
    tryDeliver: vi.fn(async () => true),
  } as unknown as NotificationDeliveryService;
  const metrics = {
    aiRequests: { inc: vi.fn() },
    aiDuration: { observe: vi.fn() },
    aiGuardViolations: { inc: vi.fn() },
  } as unknown as Metrics;
  const service = new BackendService(
    p,
    {} as PaymentGatewayPort,
    {} as PdfRendererPort,
    {} as OcrPort,
    admin,
    notificationDelivery,
    metrics,
    logger,
  );
  return { service, p };
}

/** Exécute fn avec un Principal explicite (comme le guard en requête réelle) — sync ou async. */
function asPrincipal<T>(principal: Principal | null, fn: () => T): T {
  return requestContext.run({ correlationId: 'test', ...(principal ? { principal } : {}) }, fn);
}

const MERCIER: Principal = { userId: 'u-mercier', companyId: MERCIER_PROPS.id };
const INTRUS: Principal = { userId: 'u-intrus', companyId: 'company-intrus' };

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Flow d'émission RÉEL (jamais un statut fabriqué) : devis → envoi → signature → facture → émission. */
async function issueFinalInvoice(
  service: BackendService,
  input: { customerId: string; unitPriceHT: number; vatRate: 0 | 20 },
): Promise<{ invoiceId: string; number: string }> {
  const quote = await service.createQuote({
    customerId: input.customerId,
    lines: [{ label: 'Prestation test', category: 'labor', qty: 1, unitPriceHT: input.unitPriceHT, vatRate: input.vatRate }],
  });
  if (!quote.ok) throw new Error('fixture: createQuote KO');
  const sent = await service.sendQuote(quote.value.quoteId);
  if (!sent.ok) throw new Error('fixture: sendQuote KO');
  const signed = await service.signQuote({ quoteId: quote.value.quoteId, signerName: 'Signataire Test' });
  if (!signed.ok) throw new Error('fixture: signQuote KO');
  const generated = await service.generateInvoice({ quoteId: quote.value.quoteId, mode: 'final' });
  if (!generated.ok) throw new Error('fixture: generateInvoice KO');
  const issued = await service.issueInvoice({ invoiceId: generated.value.invoiceId });
  if (!issued.ok) throw new Error('fixture: issueInvoice KO');
  return { invoiceId: generated.value.invoiceId, number: issued.value.number };
}

describe('PONT-SERVEUR v1 ① — POST /expenses/:id/pay (PayExpense : to_pay→paid + décaissement 401/512)', () => {
  it('règle la dépense : statut paid, écriture expense:{id}:paid au journal de banque (401/512), idempotent', async () => {
    const { service } = makeService();
    await asPrincipal(MERCIER, async () => {
      const recorded = await service.recordExpense({
        supplierName: 'Cedeo',
        documentDate: todayUtc(),
        totalTtcCents: 18490,
        vatCents: 3082,
        vatRatePct: 20,
        category: 'fournitures',
        source: 'manual',
      });
      expect(recorded.ok).toBe(true);
      if (!recorded.ok) return;

      const paid = await service.payExpense({ expenseId: recorded.value.id });
      expect(paid.ok).toBe(true);
      if (!paid.ok) return;
      expect(paid.value).toEqual({ status: 'paid', alreadyPaid: false });

      const expenses = await service.listExpenses();
      expect(expenses.ok && expenses.value.find((e) => e.id === recorded.value.id)?.status).toBe('paid');

      const entries = await service.listAccountingEntries();
      expect(entries.ok).toBe(true);
      if (!entries.ok) return;
      const payment = entries.value.find((e) => e.id === `expense:${recorded.value.id}:paid`);
      expect(payment).toBeDefined();
      expect(payment?.journal).toBe('bank');
      // Décaissement miroir de l'encaissement client : débit 401 (apurement), crédit 512 (banque).
      expect(payment?.lines).toEqual([
        expect.objectContaining({ account: '401', debitCents: 18490, creditCents: 0 }),
        expect.objectContaining({ account: '512', debitCents: 0, creditCents: 18490 }),
      ]);

      // Idempotent de bout en bout : re-payer ne double JAMAIS le journal.
      const again = await service.payExpense({ expenseId: recorded.value.id });
      expect(again.ok && again.value.alreadyPaid).toBe(true);
      const entriesAfter = await service.listAccountingEntries();
      expect(
        entriesAfter.ok && entriesAfter.value.filter((e) => e.id === `expense:${recorded.value.id}:paid`),
      ).toHaveLength(1);
    });
  });

  it('anti-IDOR : la dépense d’un autre tenant est INTROUVABLE (not_found, jamais une fuite d’existence)', async () => {
    const { service } = makeService();
    const recorded = await asPrincipal(MERCIER, () =>
      service.recordExpense({ supplierName: 'Cedeo', documentDate: todayUtc(), totalTtcCents: 5000, category: 'fournitures' }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    const r = await asPrincipal(INTRUS, () => service.payExpense({ expenseId: recorded.value.id }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: 'not_found', entity: 'expense', id: recorded.value.id });
  });
});

describe('PONT-SERVEUR v1 ② — recordExpense poste les écritures du cycle achats (E1, idempotent)', () => {
  it('la dépense enregistrée poste son écriture d’ACHAT 6xx/44566/401 au journal purchases', async () => {
    const { service } = makeService();
    await asPrincipal(MERCIER, async () => {
      const recorded = await service.recordExpense({
        supplierName: 'Leroy Merlin',
        documentDate: todayUtc(),
        totalTtcCents: 18490,
        vatCents: 3082,
        vatRatePct: 20,
        category: 'fournitures',
        source: 'manual',
      });
      expect(recorded.ok).toBe(true);
      if (!recorded.ok) return;

      const entries = await service.listAccountingEntries();
      expect(entries.ok).toBe(true);
      if (!entries.ok) return;
      const purchase = entries.value.find((e) => e.id === `expense:${recorded.value.id}:recorded`);
      expect(purchase).toBeDefined();
      expect(purchase?.journal).toBe('purchases');
      expect(purchase?.sourceType).toBe('expense');
      // Charge TTC−TVA au 606, TVA déductible MENTIONNÉE au 44566, contrepartie fournisseur 401.
      expect(purchase?.lines).toEqual([
        expect.objectContaining({ account: '606', debitCents: 15408, creditCents: 0 }),
        expect.objectContaining({ account: '44566', debitCents: 3082, creditCents: 0 }),
        expect.objectContaining({ account: '401', debitCents: 0, creditCents: 18490 }),
      ]);
      // Pas de décaissement : la dépense est « à payer » (le 401/512 arrive avec payExpense).
      expect(entries.value.find((e) => e.id === `expense:${recorded.value.id}:paid`)).toBeUndefined();
    });
  });
});

describe('PONT-SERVEUR v1 ③ — GET /payments (E3 : encaissements datés du tenant)', () => {
  it('liste les paiements datés du tenant (PaymentView : id, invoiceId, amountCents, method, receivedAt)', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const { invoiceId } = await issueFinalInvoice(service, { customerId: 'cust-martin', unitPriceHT: 100000, vatRate: 20 });
      const paid = await service.registerPayment({ invoiceId, amount: 48840, method: 'card', idempotencyKey: null });
      expect(paid.ok).toBe(true);

      const r = await service.listPayments();
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value).toHaveLength(1);
      expect(r.value[0]).toMatchObject({ invoiceId, amountCents: 48840, method: 'card' });
      // Encaissement DATÉ (socle E3) : receivedAt est un instant ISO réel, pas un statut décoratif.
      expect(r.value[0]?.receivedAt.slice(0, 10)).toBe(todayUtc());
    });

    // Cloison tenant : un autre tenant ne voit AUCUN paiement de Mercier.
    const other = await asPrincipal(INTRUS, () => service.listPayments());
    expect(other.ok && other.value).toEqual([]);
  });
});

describe('PONT-SERVEUR v1 ④ — GET /company/me (fiche société du tenant, CompanyProps complet)', () => {
  it('tenant seedé : renvoie la fiche BDD complète (name, legalForm, siren/siret, vatRegime, address…)', async () => {
    const { service, p } = makeService();
    await p.seed();
    const r = await asPrincipal(MERCIER, () => service.getCompanyMe());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // CompanyProps COMPLET, identique octet pour octet à la fiche en BDD — l'identité connectée
    // (useIdentity) lit ENFIN la vraie raison sociale au lieu de masquer la ligne.
    expect(r.value).toEqual(MERCIER_PROPS);
  });

  it('tenant sans société : not_found PROPRE (jamais une fiche inventée)', async () => {
    const { service } = makeService(); // pas de seed
    const r = await asPrincipal({ userId: 'u-1', companyId: 'co-fantome' }, () => service.getCompanyMe());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: 'not_found', entity: 'company', id: 'co-fantome' });
  });
});

describe('PONT-SERVEUR v1 ⑤ — getDiagnostic : annualEncaissedCents RÉEL (vigie 293 B en prod, E6)', () => {
  /** Tenant franchise en base : la surveillance des seuils doit lire les ENCAISSEMENTS réels. */
  async function seedFranchiseTenant(p: InMemoryPersistence): Promise<Principal> {
    const company = Company.of({
      ...MERCIER_PROPS,
      id: 'company-franchise',
      name: 'Petit Plombier',
      vatRegime: 'franchise',
    });
    if (!company.ok) throw new Error('fixture: company franchise invalide');
    await p.companies.save(company.value);
    const customer = Customer.of({
      id: 'cust-franchise-1',
      companyId: 'company-franchise',
      type: 'b2c',
      name: 'Mme Client',
      address: { line1: '1 rue Basse', zip: '92310', city: 'Sèvres' },
      score: 100,
      avgDelayDays: 0,
      outstanding: 0,
    });
    if (!customer.ok) throw new Error('fixture: customer franchise invalide');
    await p.customers.save(customer.value);
    return { userId: 'u-franchise', companyId: 'company-franchise' };
  }

  it('sans encaissement : item 293 B informatif (on n’invente pas une alerte sans donnée)', async () => {
    const { service, p } = makeService();
    const principal = await seedFranchiseTenant(p);
    const r = await asPrincipal(principal, () => service.getDiagnostic());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = r.value.items.find((i) => i.id === 'tva-franchise');
    // 0 € encaissé = donnée réelle : le use case rend le statut « ok » (below/approaching sous seuil).
    expect(item).toBeDefined();
    expect(item?.status).toBe('ok');
  });

  it('40 000 € ENCAISSÉS (flow réel facture 0 % + paiement) : seuil 37 500 € dépassé → alerte todo', async () => {
    const { service, p } = makeService();
    const principal = await seedFranchiseTenant(p);
    await asPrincipal(principal, async () => {
      const { invoiceId } = await issueFinalInvoice(service, {
        customerId: 'cust-franchise-1',
        unitPriceHT: 4_000_000, // 40 000 € HT, TVA 0 % (franchise) → 40 000 € TTC
        vatRate: 0,
      });
      const paid = await service.registerPayment({ invoiceId, amount: 4_000_000, method: 'transfer', idempotencyKey: null });
      expect(paid.ok).toBe(true);

      const r = await service.getDiagnostic();
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const item = r.value.items.find((i) => i.id === 'tva-franchise');
      // 40 000 € > 37 500 € (seuil de base services) et < 41 250 € (majoré) → TVA au 1er janvier.
      expect(item?.status).toBe('todo');
      expect(item?.severity).toBe('important');
      expect(item?.label).toContain('Seuil de franchise dépassé');
    });
  });
});

describe('PONT-SERVEUR v1 ⑥ — POST /invoices/:id/credit-note (avoir A6, compteur préfixe A)', () => {
  it('crée l’avoir TOTAL (brouillon), idempotent par devis parent, puis s’émet en A-AAAA-0001 sans trou', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const { invoiceId } = await issueFinalInvoice(service, { customerId: 'cust-martin', unitPriceHT: 100000, vatRate: 20 });

      const created = await service.createCreditNote({ invoiceId });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      // Idempotence de geste : re-créer l'avoir de la même facture rend LE MÊME avoir.
      const again = await service.createCreditNote({ invoiceId });
      expect(again.ok && again.value.creditNoteId).toBe(created.value.creditNoteId);

      // L'avoir s'émet par le circuit normal : CounterKey 'credit' → préfixe « A », séquence propre.
      const issued = await service.issueInvoice({ invoiceId: created.value.creditNoteId });
      expect(issued.ok).toBe(true);
      if (!issued.ok) return;
      expect(issued.value.number).toMatch(/^A-\d{4}-0001$/);

      // La facture d'origine garde SA famille F- : les séquences ne se mélangent jamais.
      const invoice = await service.getInvoice(invoiceId);
      expect(invoice.ok && invoice.value.number).toMatch(/^F-\d{4}-0001$/);
    });
  });

  it('anti-IDOR : la facture d’un autre tenant est INTROUVABLE pour créer un avoir', async () => {
    const { service, p } = makeService();
    await p.seed();
    const { invoiceId } = await asPrincipal(MERCIER, () =>
      issueFinalInvoice(service, { customerId: 'cust-martin', unitPriceHT: 100000, vatRate: 20 }),
    );
    const r = await asPrincipal(INTRUS, () => service.createCreditNote({ invoiceId }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: 'not_found', entity: 'invoice', id: invoiceId });
  });
});

describe('PONT-SERVEUR v1 ⑦ — actions Bob serveur : position_tva, balance_agee, payer_depense (parité humain↔Bob)', () => {
  beforeEach(() => {
    // Router en mode démo déterministe : aucune clé LLM — l'intention passe par la regex,
    // les outils par le registre (mêmes use cases que l'UI, c'est ce qu'on teste).
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('GLM_API_KEY', '');
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    vi.stubEnv('MISTRAL_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('position_tva : « combien de TVA je dois ? » répond avec deriveVatPosition sur les données RÉELLES du tenant', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const { invoiceId } = await issueFinalInvoice(service, { customerId: 'cust-martin', unitPriceHT: 100000, vatRate: 20 });
      const paid = await service.registerPayment({ invoiceId, amount: 120000, method: 'transfer', idempotencyKey: null });
      expect(paid.ok).toBe(true);

      const r = await service.askBob('combien de TVA je dois ?');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.intent).toBe('tva');
      expect(r.value.kind).toBe('answer');
      expect(r.value.card.title).toBe('Ta position de TVA');
      // LE même chiffre que le use case pur : 20 000 cents de TVA contenue dans l'encaissement total.
      const expected = deriveVatPosition({
        invoices: [
          {
            kind: 'final',
            status: 'paid',
            totals: { ht: 100000, vatByRate: { '20': 20000 }, vat: 20000, ttc: 120000, netToPay: 120000 },
            paid: 120000,
          },
        ],
        expenses: [],
      });
      expect(expected.collectedCents).toBe(20000);
      expect(r.value.card.body).toContain('200,00');
    });
  });

  it('balance_agee : « qui me doit de l’argent ? » lit deriveAgedBalance (facture émise impayée visible)', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      await issueFinalInvoice(service, { customerId: 'cust-martin', unitPriceHT: 100000, vatRate: 20 });

      const r = await service.askBob("qui me doit de l'argent ?");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.intent).toBe('balance');
      expect(r.value.card.title).toBe('Qui te doit quoi');
      expect(r.value.card.body).toContain('SARL Martin Rénovation');
      expect(r.value.card.body).toMatch(/1\s200,00\s€/); // 120 000 cents dus (netToPay − paid) — espace fine insécable fr-FR
    });
  });

  it('payer_depense : mutation registre accounting — PROPOSITION (dry-run) puis confirmBob exécute PayExpense', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const recorded = await service.recordExpense({
        supplierName: 'Leroy Merlin',
        documentDate: todayUtc(),
        totalTtcCents: 18490,
        vatCents: 3082,
        category: 'fournitures',
      });
      expect(recorded.ok).toBe(true);
      if (!recorded.ok) return;

      // ① Dry-run : palier accounting = PLANCHER — toujours proposé, jamais exécuté d'office.
      const proposed = await service.askBob('règle la dépense Leroy Merlin');
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      expect(proposed.value.kind).toBe('proposed');
      expect(proposed.value.pending?.tool).toBe('payer_depense');
      expect(proposed.value.pending?.args).toEqual({ expenseId: recorded.value.id });

      // ② Confirmation : exécution JOURNALISÉE — même use case PayExpense que POST /expenses/:id/pay.
      const confirmed = await service.confirmBob(proposed.value.pending!);
      expect(confirmed.ok).toBe(true);
      if (!confirmed.ok) return;
      expect(confirmed.value.kind).toBe('done');

      const expenses = await service.listExpenses();
      expect(expenses.ok && expenses.value.find((e) => e.id === recorded.value.id)?.status).toBe('paid');
      const entries = await service.listAccountingEntries();
      expect(entries.ok && entries.value.some((e) => e.id === `expense:${recorded.value.id}:paid`)).toBe(true);
    });
  });
});

describe('PONT-SERVEUR v1 — au guard : les nouveaux endpoints exigent JWT + tenant (aucune liste blanche)', () => {
  // Construit à la COLLECTION (DEMO_MODE non stubbé → storage démo) : le stub DEMO_MODE=false
  // ci-dessous ne concerne que la POLITIQUE du guard, pas la construction du service.
  const { service, p } = makeService();

  beforeEach(() => {
    vi.stubEnv('DEMO_MODE', 'false');
    vi.stubEnv('SUPABASE_JWKS_URL', 'https://exemple.supabase.co/auth/v1/.well-known/jwks.json');
    jwtVerifyMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function ctx(req: { url: string; method?: string; headers: Record<string, string | undefined> }): ExecutionContext {
    return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  }

  it.each([
    ['GET', '/company/me'],
    ['GET', '/payments'],
    ['POST', '/expenses/exp-1/pay'],
    ['POST', '/invoices/inv-1/credit-note'],
  ])('sans Authorization : %s %s est refusé (seul GET /company/lookup exact est public)', async (method, url) => {
    const guard = new SupabaseAuthGuard();
    const allowed = await requestContext.run({ correlationId: 'test' }, () =>
      guard.canActivate(ctx({ url, method, headers: {} })),
    );
    expect(allowed).toBe(false);
  });

  it('JWT valide AVEC tenant : GET /company/me admis — le Principal scope la fiche au tenant du JWT', async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: 'u-1', app_metadata: { company_id: MERCIER_PROPS.id } },
    } as never);
    const guard = new SupabaseAuthGuard();
    await p.seed();

    await requestContext.run({ correlationId: 'test' }, async () => {
      const allowed = await guard.canActivate(
        ctx({ url: '/company/me', method: 'GET', headers: { authorization: 'Bearer jwt-de-test' } }),
      );
      expect(allowed).toBe(true);
      const r = await service.getCompanyMe();
      expect(r.ok && r.value.id).toBe(MERCIER_PROPS.id);
    });
  });
});

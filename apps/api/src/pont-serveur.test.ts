import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { jwtVerify } from 'jose';
import { Company, Customer, DocumentFolder, Expense, MERCIER_PROPS, Subscription, deriveVatPosition } from '@bob/core';
import type { DocumentIntelligencePort, OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
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

function makeService(options?: { documentIntelligence?: DocumentIntelligencePort }) {
  const p = new InMemoryPersistence();
  const admin: SupabaseAdminPort = { setUserCompanyId: vi.fn(async () => undefined) };
  const logger = { audit: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() } as unknown as AppLogger;
  // Outbox stubée « pending » : sendQuote enfile mais n'atteint jamais un tiers dans la transaction test.
  const notificationDelivery = {
    enqueue: vi.fn(async (input: { notification: unknown }) => ({
      id: 'job-1',
      status: 'pending',
      notification: input.notification,
    })),
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
    options?.documentIntelligence,
  );
  return { service, p, notificationDelivery, metrics };
}

/** Exécute fn avec un Principal explicite (comme le guard en requête réelle) — sync ou async. */
function asPrincipal<T>(principal: Principal | null, fn: () => T): T {
  return requestContext.run({ correlationId: 'test', ...(principal ? { principal } : {}) }, fn);
}

const MERCIER: Principal = { userId: 'u-mercier', companyId: MERCIER_PROPS.id };
const COLLEAGUE: Principal = { userId: 'u-colleague', companyId: MERCIER_PROPS.id };
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
  it("impose le tenant authentifié même si un appel interne forge companyId à l'exécution", async () => {
    const { service, p } = makeService();
    const forgedInput = {
      supplierName: 'Cedeo',
      documentDate: todayUtc(),
      totalTtcCents: 5_000,
      category: 'fournitures' as const,
      companyId: INTRUS.companyId!,
    };

    const recorded = await asPrincipal(MERCIER, () => service.recordExpense(forgedInput));

    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const stored = await p.expenses.findById(recorded.value.id);
    expect(stored?.companyId).toBe(MERCIER.companyId);
    expect(await p.expenses.listByCompany(INTRUS.companyId!)).toHaveLength(0);
  });

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

  it('converge sous double appel et après réponse perdue : une Expense, une E1, un seul id', async () => {
    const { service, p } = makeService();
    await asPrincipal(MERCIER, async () => {
      const request = {
        supplierName: 'Cedeo',
        documentDate: todayUtc(),
        totalTtcCents: 18_490,
        vatCents: 3_082,
        vatRatePct: 20,
        category: 'fournitures' as const,
        source: 'ocr' as const,
        idempotencyKey: 'scan-expense-response-lost-1',
      };

      const [first, concurrent] = await Promise.all([
        service.recordExpense(request),
        service.recordExpense(request),
      ]);
      expect(first.ok).toBe(true);
      expect(concurrent.ok).toBe(true);
      if (!first.ok || !concurrent.ok) return;
      expect(concurrent.value.id).toBe(first.value.id);

      // Le commit du premier appel est durable même si sa réponse réseau disparaît.
      await expect(service.recordExpense(request)).resolves.toEqual(first);
      expect(await p.expenses.listByCompany(MERCIER.companyId!)).toHaveLength(1);
      const entries = await p.accountingEntries.listByCompany(MERCIER.companyId!);
      expect(entries.filter((entry) => entry.toProps().sourceId === first.value.id)).toHaveLength(1);

      const conflict = await service.recordExpense({ ...request, totalTtcCents: 18_491 });
      expect(conflict.ok).toBe(false);
      if (!conflict.ok) expect(conflict.error.kind).toBe('conflict');
      expect(await p.expenses.listByCompany(MERCIER.companyId!)).toHaveLength(1);
    });
  });

  it('rollback explicitement le candidat qui perd la publication concurrente', async () => {
    const { service, p } = makeService();
    await asPrincipal(MERCIER, async () => {
      const base = {
        supplierName: 'Cedeo',
        documentDate: todayUtc(),
        totalTtcCents: 18_490,
        category: 'fournitures' as const,
        source: 'ocr' as const,
      };
      const winner = await service.recordExpense(base);
      expect(winner.ok).toBe(true);
      if (!winner.ok) return;

      let published: Awaited<ReturnType<typeof p.expenseCreationRequests.find>> = null;
      let findCount = 0;
      vi.spyOn(p.expenseCreationRequests, 'find').mockImplementation(async () => {
        findCount += 1;
        return findCount === 1 ? null : published;
      });
      vi.spyOn(p.expenseCreationRequests, 'putIfAbsent').mockImplementation(async (candidate) => {
        published = { ...candidate, expenseId: winner.value.id };
        return published;
      });

      const replay = await service.recordExpense({ ...base, idempotencyKey: 'forced-concurrent-loser-1' });
      expect(replay).toEqual(winner);
      // Le candidat avait déjà écrit Expense + E1 avant de perdre l'index. La sentinelle doit
      // les annuler avant la relecture du gagnant, sinon ces deux assertions passeraient à 2.
      expect(await p.expenses.listByCompany(MERCIER.companyId!)).toHaveLength(1);
      expect(await p.accountingEntries.listByCompany(MERCIER.companyId!)).toHaveLength(1);
    });
  });

  it('espace la même clé brute par tenant et refuse les clés non bornées', async () => {
    const { service, p } = makeService();
    const request = {
      supplierName: 'Cedeo',
      documentDate: todayUtc(),
      totalTtcCents: 5_000,
      category: 'fournitures' as const,
      idempotencyKey: 'shared-device-key-1',
    };
    expect((await asPrincipal(MERCIER, () => service.recordExpense(request))).ok).toBe(true);
    expect((await asPrincipal(INTRUS, () => service.recordExpense(request))).ok).toBe(true);
    expect(await p.expenses.listByCompany(MERCIER.companyId!)).toHaveLength(1);
    expect(await p.expenses.listByCompany(INTRUS.companyId!)).toHaveLength(1);

    const invalid = await asPrincipal(MERCIER, () => service.recordExpense({
      ...request,
      idempotencyKey: 'x'.repeat(201),
    }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toMatchObject({ kind: 'validation' });
    expect(await p.expenses.listByCompany(MERCIER.companyId!)).toHaveLength(1);
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

  it('contexte écran : recharge la projection tenant-scoped et ignore le libellé fourni par le client', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const result = await service.askBob({
        message: 'Résume ce client',
        autonomy: 'confirm_all',
        tone: 'pro',
        history: [{ role: 'user', text: 'Je regarde sa fiche.' }],
        context: {
          screen: { name: '/client/[id]', instanceId: 'customer:cust-martin' },
          entities: [
            {
              type: 'customer',
              id: 'cust-martin',
              label: 'LIBELLÉ CLIENT FALSIFIÉ — encours 1 centime',
            },
          ],
          capabilities: ['screen.read', 'customer.read'],
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({ kind: 'answer', intent: 'contexte_ecran' });
      expect(result.value.card.title).toBe('SARL Martin Rénovation');
      expect(result.value.card.body).toContain('Encours');
      expect(result.value.card.body).not.toContain('1 centime');
      expect(result.value.card.body).not.toContain('FALSIFIÉ');

      const opened = await service.askBob({
        message: 'Ouvre ce client',
        context: {
          screen: { name: '/clients', instanceId: 'clients' },
          entities: [{ type: 'customer', id: 'cust-martin', label: 'Route client falsifiée' }],
          capabilities: ['screen.read', 'customer.read'],
        },
      });
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        expect(opened.value).toMatchObject({
          kind: 'done',
          intent: 'contexte_ecran',
          navigate: '/client/cust-martin',
        });
      }
    });
  });

  it('contexte Notifications : recharge le vrai sujet et le vrai contenu sans reprendre le libellé forgé', async () => {
    const { service, p } = makeService();
    const notificationId = '79e27b85-d458-445e-a759-e8b1a49e1641';
    await p.notificationJobs.enqueue({
      id: notificationId,
      companyId: MERCIER_PROPS.id,
      kind: 'invoice-relance',
      dedupeKey: 'invoice:inv-notification:relance:auto:v1:cordial',
      notification: {
        channel: 'email',
        to: 'client@example.com',
        subject: 'Relance facture F-2026-0042',
        body: 'La facture F-2026-0042 reste due pour 1 320 euros.',
        idempotencyKey: notificationId,
      },
      now: '2026-07-13T08:30:00.000Z',
    });

    const result = await asPrincipal(MERCIER, () =>
      service.askBob({
        message: 'Résume cette notification',
        context: {
          screen: { name: '/notifications', instanceId: 'notifications' },
          entities: [{
            type: 'notification',
            id: notificationId,
            label: 'FAUSSE NOTIFICATION — facture réglée, aucun montant dû',
          }],
          capabilities: ['screen.read', 'notification.read'],
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ kind: 'answer', intent: 'contexte_ecran' });
    expect(result.value.card.title).toBe('Relance facture F-2026-0042');
    expect(result.value.card.body).toContain('Non lue');
    expect(result.value.card.body).toContain('La facture F-2026-0042 reste due pour 1 320 euros.');
    expect(result.value.card.body).not.toContain('FAUSSE NOTIFICATION');
    expect(result.value.card.body).not.toContain('facture réglée');

    const opened = await asPrincipal(MERCIER, () =>
      service.askBob({
        message: 'Ouvre cette notification',
        context: {
          screen: { name: '/notifications', instanceId: 'notifications' },
          entities: [{ type: 'notification', id: notificationId, label: 'Lien forgé vers un autre écran' }],
          capabilities: ['screen.read', 'notification.read'],
        },
      }),
    );
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.value).toMatchObject({
        kind: 'done',
        intent: 'contexte_ecran',
        navigate: '/facture/inv-notification',
      });
    }
  });

  it('contexte Notifications : le même id publié par un autre tenant reste introuvable', async () => {
    const { service, p } = makeService();
    const notificationId = '79e27b85-d458-445e-a759-e8b1a49e1641';
    await p.notificationJobs.enqueue({
      id: notificationId,
      companyId: MERCIER_PROPS.id,
      kind: 'invoice-relance',
      dedupeKey: 'invoice:inv-notification:relance:auto:v1:cordial',
      notification: {
        channel: 'email',
        to: 'client@example.com',
        subject: 'Relance confidentielle',
        body: 'Contenu confidentiel du tenant Mercier.',
        idempotencyKey: notificationId,
      },
      now: '2026-07-13T08:30:00.000Z',
    });

    const result = await asPrincipal(INTRUS, () =>
      service.askBob({
        message: 'Résume cette notification',
        context: {
          screen: { name: '/notifications', instanceId: 'notifications' },
          entities: [{ type: 'notification', id: notificationId, label: 'Notification volée' }],
          capabilities: ['screen.read', 'notification.read'],
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ kind: 'not_found', entity: 'notification', id: notificationId });
    }
  });

  it('contexte Comptabilité : explique une écriture canonique et la masque à un autre tenant', async () => {
    const { service } = makeService();
    const recorded = await asPrincipal(MERCIER, () =>
      service.recordExpense({
        supplierName: 'Fournitures Atelier',
        documentDate: '2026-07-12',
        totalTtcCents: 12_000,
        vatCents: 2_000,
        vatRatePct: 20,
        category: 'fournitures',
        source: 'manual',
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const entryId = `expense:${recorded.value.id}:recorded`;
    const context = {
      screen: { name: '/comptabilite', instanceId: 'comptabilite' },
      entities: [{ type: 'accounting_entry' as const, id: entryId, label: 'FAUSSE ÉCRITURE — déséquilibrée' }],
      capabilities: ['screen.read' as const, 'accounting.read' as const],
    };

    const result = await asPrincipal(MERCIER, () =>
      service.askBob({ message: 'Explique cette écriture', context }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ kind: 'answer', intent: 'contexte_ecran' });
    expect(result.value.card.body).toContain('Journal : Achats');
    expect(result.value.card.body).toMatch(/Débit : 120,00\s€/);
    expect(result.value.card.body).toMatch(/Crédit : 120,00\s€/);
    expect(result.value.card.body).toContain('Écriture équilibrée');
    expect(result.value.card.body).not.toContain('FAUSSE ÉCRITURE');

    const forbidden = await asPrincipal(INTRUS, () =>
      service.askBob({ message: 'Explique cette écriture', context }),
    );
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) {
      expect(forbidden.error).toEqual({ kind: 'not_found', entity: 'accounting_entry', id: entryId });
    }
  });

  it('contexte Devis : explique une ligne par son id canonique, jamais par le libellé mobile', async () => {
    const { service, p } = makeService();
    await p.seed();
    const created = await asPrincipal(MERCIER, () =>
      service.createQuote({
        customerId: 'cust-martin',
        lines: [{ label: 'Pose chauffe-eau', category: 'labor', qty: 2, unitPriceHT: 45_000, vatRate: 20 }],
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const quotes = await asPrincipal(MERCIER, () => service.listQuotes());
    expect(quotes.ok).toBe(true);
    if (!quotes.ok) return;
    const line = quotes.value.find((quote) => quote.id === created.value.quoteId)?.lines[0];
    expect(line).toBeDefined();
    if (!line) return;
    const context = {
      screen: { name: '/devis/[id]', instanceId: `quote:${created.value.quoteId}` },
      entities: [{ type: 'quote_line' as const, id: line.id, label: 'LIGNE FALSIFIÉE — 1 centime' }],
      capabilities: ['screen.read' as const, 'quote.read' as const],
    };

    const result = await asPrincipal(MERCIER, () =>
      service.askBob({ message: 'Explique cette ligne du devis', context }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.card.title).toBe('Pose chauffe-eau');
    expect(result.value.card.body).toContain('Quantité : 2');
    expect(result.value.card.body).toMatch(/Total HT : 900,00\s€/);
    expect(result.value.card.body).toContain('TVA : 20 %');
    expect(result.value.card.body).not.toContain('FALSIFIÉE');

    const forbidden = await asPrincipal(INTRUS, () =>
      service.askBob({ message: 'Explique cette ligne du devis', context }),
    );
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) {
      expect(forbidden.error).toEqual({ kind: 'not_found', entity: 'quote_line', id: line.id });
    }
  });

  it('contexte Facture : explique une invoice_line depuis la pièce tenant-scoped', async () => {
    const { service, p } = makeService();
    await p.seed();
    const issued = await asPrincipal(MERCIER, () =>
      issueFinalInvoice(service, { customerId: 'cust-martin', unitPriceHT: 100_000, vatRate: 20 }),
    );
    const invoices = await asPrincipal(MERCIER, () => service.listInvoices());
    expect(invoices.ok).toBe(true);
    if (!invoices.ok) return;
    const line = invoices.value.find((invoice) => invoice.id === issued.invoiceId)?.lines[0];
    expect(line).toBeDefined();
    if (!line) return;

    const result = await asPrincipal(MERCIER, () =>
      service.askBob({
        message: 'Explique cette ligne de la facture',
        context: {
          screen: { name: '/facture/[id]', instanceId: `invoice:${issued.invoiceId}` },
          entities: [{ type: 'invoice_line', id: line.id, label: 'Ligne mobile non fiable' }],
          capabilities: ['screen.read', 'invoice.read'],
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.card.title).toBe('Prestation test');
    expect(result.value.card.body).toContain(`Facture : ${issued.number}`);
    expect(result.value.card.body).toMatch(/Total HT : 1\s000,00\s€/);
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
      expect(proposed.value.pending?.proposalId).toMatch(/^[A-Za-z0-9_-]{8,160}$/);
      expect(Date.parse(proposed.value.pending?.expiresAt ?? '')).toBeGreaterThan(Date.parse(todayUtc()));

      // ② Confirmation : le serveur ignore les args renvoyés par le client et recharge le dry-run
      // opaque. Une altération du DTO ne peut donc ni changer de cible ni injecter un montant.
      const tamperedPending = {
        ...proposed.value.pending!,
        tool: 'encaisser_facture',
        args: { expenseId: 'expense-attacker-controlled', amountCents: 1 },
        label: 'libellé falsifié',
      };
      const confirmed = await service.confirmBob(tamperedPending);
      expect(confirmed.ok).toBe(true);
      if (!confirmed.ok) return;
      expect(confirmed.value.kind).toBe('done');

      const expenses = await service.listExpenses();
      expect(expenses.ok && expenses.value.find((e) => e.id === recorded.value.id)?.status).toBe('paid');
      const entries = await service.listAccountingEntries();
      expect(entries.ok && entries.value.some((e) => e.id === `expense:${recorded.value.id}:paid`)).toBe(true);

      // ③ Consommation atomique : le même proposalId ne s'exécute jamais deux fois.
      const replay = await service.confirmBob(proposed.value.pending!);
      expect(replay.ok).toBe(false);
      if (!replay.ok) {
        expect(replay.error).toMatchObject({
          kind: 'validation',
          issues: [{ field: 'proposalId' }],
        });
      }
    });
  });

  it('notifications : la proposition opaque marque seulement le lot antérieur au preview', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    try {
      const { service, p } = makeService();
      const oldId = 'notif-before-preview';
      const newId = 'notif-after-preview';
      await p.notificationJobs.enqueue({
        id: oldId,
        companyId: MERCIER_PROPS.id,
        kind: 'invoice-relance',
        dedupeKey: 'invoice:inv-old:relance:auto:v1:cordial',
        notification: {
          channel: 'email',
          to: 'old@example.com',
          subject: 'Notification déjà présente',
          body: 'Avant le preview.',
          idempotencyKey: oldId,
        },
        now: '2026-07-13T09:59:59.000Z',
      });

      await asPrincipal(MERCIER, async () => {
        const proposed = await service.askBob({
          message: 'Marque toutes les notifications comme lues',
          autonomy: 'auto',
        });
        expect(proposed.ok).toBe(true);
        if (!proposed.ok || !proposed.value.pending?.proposalId) return;
        expect(proposed.value).toMatchObject({
          kind: 'proposed',
          intent: 'marquer_notifications_lues',
          pending: {
            tool: 'marquer_notifications_lues',
            args: { throughCreatedAt: '2026-07-13T10:00:00.000Z' },
          },
        });

        // Cette notification arrive pendant que la carte de consentement est affichée.
        vi.setSystemTime(new Date('2026-07-13T10:00:01.000Z'));
        await p.notificationJobs.enqueue({
          id: newId,
          companyId: MERCIER_PROPS.id,
          kind: 'invoice-relance',
          dedupeKey: 'invoice:inv-new:relance:auto:v1:cordial',
          notification: {
            channel: 'email',
            to: 'new@example.com',
            subject: 'Notification arrivée pendant la confirmation',
            body: 'Après le preview.',
            idempotencyKey: newId,
          },
          now: '2026-07-13T10:00:00.500Z',
        });

        const confirmed = await service.confirmBob({ proposalId: proposed.value.pending.proposalId });
        expect(confirmed.ok).toBe(true);
        if (!confirmed.ok) return;
        expect(confirmed.value).toMatchObject({
          kind: 'done',
          intent: 'marquer_notifications_lues',
          card: { title: 'Notifications à jour' },
        });
        expect(confirmed.value.card.body).toContain('1 notification');

        const oldNotification = await p.notificationJobs.findById(MERCIER_PROPS.id, oldId);
        const newNotification = await p.notificationJobs.findById(MERCIER_PROPS.id, newId);
        expect(oldNotification?.readAt).toBe('2026-07-13T10:00:01.000Z');
        expect(newNotification?.readAt).toBeNull();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirmBob refuse tout PendingAction historique sans proposalId serveur', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const result = await service.confirmBob({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject({
          kind: 'validation',
          issues: [{ field: 'proposalId', message: 'Proposition serveur requise.' }],
        });
      }
    });
  });

  it('isole la proposition opaque par tenant avant même la consommation', async () => {
    const { service, p } = makeService();
    await p.seed();
    const proposed = await asPrincipal(MERCIER, async () => {
      const recorded = await service.recordExpense({
        supplierName: 'Point P',
        documentDate: todayUtc(),
        totalTtcCents: 9_900,
        category: 'fournitures',
      });
      if (!recorded.ok) throw new Error('fixture: recordExpense KO');
      return service.askBob('règle la dépense Point P');
    });
    expect(proposed.ok && proposed.value.pending?.proposalId).toBeTruthy();
    if (!proposed.ok || !proposed.value.pending) return;

    const intrusion = await asPrincipal(INTRUS, () =>
      service.confirmBob({ proposalId: proposed.value.pending?.proposalId }),
    );
    expect(intrusion.ok).toBe(false);
    if (!intrusion.ok) {
      expect(intrusion.error).toEqual({ kind: 'not_found', entity: 'agent_proposal', id: 'redacted' });
    }

    // La tentative d'un autre tenant ne consomme pas la proposition du propriétaire.
    const ownerConfirmation = await asPrincipal(MERCIER, () =>
      service.confirmBob({ proposalId: proposed.value.pending?.proposalId }),
    );
    expect(ownerConfirmation.ok).toBe(true);
  });

  it('lie la proposition opaque à son utilisateur au sein du même tenant', async () => {
    const { service, p } = makeService();
    await p.seed();
    const proposed = await asPrincipal(MERCIER, async () => {
      const recorded = await service.recordExpense({
        supplierName: 'Proposition privée',
        documentDate: todayUtc(),
        totalTtcCents: 9_900,
        category: 'fournitures',
      });
      if (!recorded.ok) throw new Error('fixture: recordExpense KO');
      return service.askBob('règle la dépense Proposition privée');
    });
    expect(proposed.ok && proposed.value.pending?.proposalId).toBeTruthy();
    if (!proposed.ok || !proposed.value.pending) return;

    const colleague = await asPrincipal(COLLEAGUE, () =>
      service.confirmBob({ proposalId: proposed.value.pending?.proposalId }),
    );
    expect(colleague).toEqual({ ok: false, error: { kind: 'not_found', entity: 'agent_proposal', id: 'redacted' } });

    const owner = await asPrincipal(MERCIER, () =>
      service.confirmBob({ proposalId: proposed.value.pending?.proposalId }),
    );
    expect(owner.ok).toBe(true);
  });

  it("confirme un devis sortant via l'outbox auditée, sans réseau tiers dans la transaction", async () => {
    const { service, p, notificationDelivery } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const created = await service.createQuote({
        customerId: 'cust-martin',
        lines: [
          { label: 'Prestation à envoyer', category: 'labor', qty: 1, unitPriceHT: 10_000, vatRate: 20 },
        ],
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const proposed = await service.askBob({
        message: 'Envoie ce devis',
        autonomy: 'confirm_all',
        context: {
          screen: { name: '/devis/[id]', instanceId: `quote:${created.value.quoteId}` },
          entities: [{ type: 'quote', id: created.value.quoteId, label: 'Devis brouillon' }],
          capabilities: ['quote.read', 'quote.send'],
        },
      });
      expect(proposed.ok && proposed.value.kind).toBe('proposed');
      if (!proposed.ok || !proposed.value.pending) return;

      const confirmation = await service.confirmBob({ proposalId: proposed.value.pending.proposalId });
      expect(confirmation.ok).toBe(true);
      expect(confirmation.ok && confirmation.value.card).toMatchObject({ title: 'Envoi programmé' });
      const quotes = await service.listQuotes();
      expect(quotes.ok && quotes.value.find((quote) => quote.id === created.value.quoteId)?.status).toBe('sent');
      expect(notificationDelivery.enqueue).toHaveBeenCalledOnce();
      expect(notificationDelivery.tryDeliver).not.toHaveBeenCalled();
    });
  });

  it("l'agent annonce honnêtement un devis déjà livré par l'outbox", async () => {
    const { service, p, notificationDelivery } = makeService();
    await p.seed();
    vi.mocked(notificationDelivery.enqueue).mockResolvedValueOnce({
      id: 'job-done',
      status: 'done',
      notification: null,
    } as never);
    await asPrincipal(MERCIER, async () => {
      const created = await service.createQuote({
        customerId: 'cust-martin',
        lines: [{ label: 'Déjà livré', category: 'labor', qty: 1, unitPriceHT: 10_000, vatRate: 20 }],
      });
      if (!created.ok) throw new Error('fixture: createQuote KO');
      const proposed = await service.askBob({
        message: 'Envoie ce devis',
        autonomy: 'confirm_all',
        context: {
          screen: { name: '/devis/[id]', instanceId: `quote:${created.value.quoteId}` },
          entities: [{ type: 'quote', id: created.value.quoteId, label: 'Devis brouillon' }],
          capabilities: ['quote.read', 'quote.send'],
        },
      });
      if (!proposed.ok || !proposed.value.pending) throw new Error('fixture: proposition KO');

      const confirmation = await service.confirmBob({ proposalId: proposed.value.pending.proposalId });

      expect(confirmation.ok && confirmation.value.card).toMatchObject({ title: 'Devis envoyé' });
    });
  });

  it("l'agent signale qu'aucun email n'est programmé quand le client n'a pas d'adresse", async () => {
    const { service, p, notificationDelivery } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const customer = await service.createCustomer({
        type: 'b2b',
        name: 'Client sans email',
        address: { line1: '1 rue du Test', zip: '75001', city: 'Paris' },
        score: 100,
        avgDelayDays: 0,
        outstanding: 0,
      });
      if (!customer.ok) throw new Error('fixture: createCustomer KO');
      const created = await service.createQuote({
        customerId: customer.value.id,
        lines: [{ label: 'Sans email', category: 'labor', qty: 1, unitPriceHT: 10_000, vatRate: 20 }],
      });
      if (!created.ok) throw new Error('fixture: createQuote KO');
      const proposed = await service.askBob({
        message: 'Envoie ce devis',
        autonomy: 'confirm_all',
        context: {
          screen: { name: '/devis/[id]', instanceId: `quote:${created.value.quoteId}` },
          entities: [{ type: 'quote', id: created.value.quoteId, label: 'Devis brouillon' }],
          capabilities: ['quote.read', 'quote.send'],
        },
      });
      if (!proposed.ok || !proposed.value.pending) throw new Error('fixture: proposition KO');

      const confirmation = await service.confirmBob({ proposalId: proposed.value.pending.proposalId });

      expect(confirmation.ok && confirmation.value.card).toMatchObject({ title: 'Devis préparé' });
      expect(notificationDelivery.enqueue).not.toHaveBeenCalled();
    });
  });

  it("annonce 'queued' quand l'envoi direct d'un devis est seulement commité dans l'outbox", async () => {
    const { service, p, notificationDelivery } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const created = await service.createQuote({
        customerId: 'cust-martin',
        lines: [{ label: 'Outbox', category: 'labor', qty: 1, unitPriceHT: 10_000, vatRate: 20 }],
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const sent = await service.sendQuote(created.value.quoteId);

      expect(sent.ok && sent.value.deliveryStatus).toBe('queued');
      expect(notificationDelivery.enqueue).toHaveBeenCalledOnce();
      expect(notificationDelivery.tryDeliver).not.toHaveBeenCalled();
    });
  });

  it('refuse les formats et payloads audio invalides avant tout appel au provider STT', async () => {
    const { service } = makeService();
    await asPrincipal(MERCIER, async () => {
      const wrongMime = await service.transcribe({ audioBase64: 'YQ==', mimeType: 'text/plain' });
      expect(wrongMime.ok).toBe(false);
      if (!wrongMime.ok) {
        expect(wrongMime.error).toMatchObject({
          kind: 'validation',
          issues: [{ field: 'mimeType' }],
        });
      }

      const malformed = await service.transcribe({ audioBase64: '***not-base64***', mimeType: 'audio/m4a' });
      expect(malformed.ok).toBe(false);
      if (!malformed.ok) {
        expect(malformed.error).toMatchObject({
          kind: 'validation',
          issues: [{ field: 'audioBase64' }],
        });
      }
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

describe('PONT-SERVEUR — proposition opaque : garde temporelle TTL (audit vocal §7.6)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('une proposition expirée (TTL 10 min dépassé) est refusée et ne mute RIEN', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const recorded = await service.recordExpense({
        supplierName: 'Gedimat',
        documentDate: todayUtc(),
        totalTtcCents: 12_400,
        category: 'fournitures',
      });
      expect(recorded.ok).toBe(true);
      if (!recorded.ok) return;
      const proposed = await service.askBob('règle la dépense Gedimat');
      expect(proposed.ok && proposed.value.kind).toBe('proposed');
      if (!proposed.ok || !proposed.value.pending?.proposalId) return;

      // Le temps passe au-delà du TTL — seule l'horloge bouge, rien d'autre.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(Date.now() + 11 * 60_000));

      const confirmed = await service.confirmBob({ proposalId: proposed.value.pending.proposalId });
      expect(confirmed.ok).toBe(false);
      if (!confirmed.ok) {
        expect(confirmed.error).toMatchObject({ kind: 'validation', issues: [{ field: 'proposalId' }] });
      }
      const expenses = await service.listExpenses();
      expect(expenses.ok && expenses.value.find((e) => e.id === recorded.value.id)?.status).toBe('to_pay');
    });
  });
});

describe('PONT-SERVEUR — contexte écran : un id d’un AUTRE tenant est invisible (audit vocal §7.4)', () => {
  it('« résume cette facture » avec l’id d’un autre tenant → not_found, aucun fait divulgué', async () => {
    const { service, p } = makeService();
    await p.seed();
    // Mercier possède une facture émise bien réelle.
    const invoiceId = await asPrincipal(MERCIER, async () => {
      const customers = await service.listCustomers();
      if (!customers.ok || customers.value.length === 0) throw new Error('fixture: client Mercier manquant');
      const issued = await issueFinalInvoice(service, {
        customerId: customers.value[0]!.id,
        unitPriceHT: 100_000,
        vatRate: 20,
      });
      return issued.invoiceId;
    });

    // L'intrus « publie » cet id dans SON contexte d'écran : le contexte n'est jamais une
    // autorisation — l'hôte recharge tenant-scoped et ne trouve rien.
    const result = await asPrincipal(INTRUS, () =>
      service.askBob({
        message: 'résume cette facture',
        context: {
          screen: { name: 'facture/[id]', instanceId: `invoice:${invoiceId}` },
          entities: [{ type: 'invoice', id: invoiceId, label: 'Facture volée' }],
          capabilities: ['invoice.read'],
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
  });
});

describe('PONT-SERVEUR — coffre documentaire original-first et suppression sûre', () => {
  it('rejette les entrées documentaires incomplètes sans exception ni appel externe', async () => {
    const { service, p } = makeService();
    await p.seed();

    await asPrincipal(MERCIER, async () => {
      const intake = await service.createDocumentIntake({} as never);
      expect(intake.ok).toBe(false);
      if (!intake.ok) expect(intake.error).toMatchObject({ kind: 'validation', issues: [{ field: 'idempotencyKey' }] });

      const upload = await service.uploadDocument({} as never);
      expect(upload.ok).toBe(false);
      if (!upload.ok) expect(upload.error).toMatchObject({ kind: 'validation', issues: [{ field: 'contentBase64' }] });

      const folder = await service.createDocumentFolder({} as never);
      expect(folder.ok).toBe(false);
      if (!folder.ok) expect(folder.error.kind).toBe('domain');

      const ocr = await service.extractDocument({} as never);
      expect(ocr.ok).toBe(false);
      if (!ocr.ok) {
        expect(ocr.error).toMatchObject({
          kind: 'validation',
          issues: [{ field: 'contentBase64' }, { field: 'mimeType' }],
        });
      }
    });
  });

  it('rejette un faux type MIME avant archivage et verrouille la clé d’idempotence sur les octets initiaux', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const before = await service.listDocuments();
      expect(before.ok).toBe(true);

      const disguised = await service.createDocumentIntake({
        contentBase64: 'AQID',
        mimeType: 'image/jpeg',
        filename: 'faux-ticket.jpg',
        idempotencyKey: 'scan-signature-invalid-0001',
      });
      expect(disguised.ok).toBe(false);
      if (!disguised.ok) {
        expect(disguised.error).toMatchObject({
          kind: 'validation',
          issues: [{ field: 'mimeType' }],
        });
      }
      const afterInvalid = await service.listDocuments();
      expect(afterInvalid.ok && before.ok && afterInvalid.value).toHaveLength(before.ok ? before.value.length : 0);

      const first = await service.createDocumentIntake({
        contentBase64: '/9j/2Q==',
        mimeType: 'image/jpeg',
        filename: 'ticket.jpg',
        idempotencyKey: 'scan-content-bound-0001',
      });
      expect(first.ok).toBe(true);
      const reusedWithOtherBytes = await service.createDocumentIntake({
        contentBase64: '/9j/4A==',
        mimeType: 'image/jpeg',
        filename: 'ticket.jpg',
        idempotencyKey: 'scan-content-bound-0001',
      });
      expect(reusedWithOtherBytes).toEqual({
        ok: false,
        error: { kind: 'conflict', entity: 'document_intake', reason: 'idempotency_key_reused' },
      });

      const heicOriginal = await service.createDocumentIntake({
        contentBase64: 'AAAAGGZ0eXBoZWlj',
        mimeType: 'image/heic',
        filename: 'photo-chantier.heic',
        idempotencyKey: 'scan-heic-original-0001',
      });
      expect(heicOriginal.ok && heicOriginal.value.mimeType).toBe('image/heic');
      if (heicOriginal.ok) {
        const analysis = await service.analyzeStoredDocument(heicOriginal.value.id);
        expect(analysis.ok).toBe(false);
        if (!analysis.ok) expect(analysis.error.kind).toBe('validation');
      }
    });
  });

  it('prouve la cible avant upload/classification et masque absent et cross-tenant de la même façon', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const expense = await service.recordExpense({
        supplierName: 'Cedeo',
        documentDate: todayUtc(),
        totalTtcCents: 12_000,
        category: 'fournitures',
      });
      expect(expense.ok).toBe(true);
      if (!expense.ok) return;

      const crossTenantExpense = Expense.rehydrate({
        id: 'expense-cross-tenant',
        companyId: INTRUS.companyId!,
        supplierName: 'Cible privée',
        supplierSiren: null,
        documentDate: todayUtc(),
        totalTtcCents: 5_000,
        totalHtCents: null,
        vatCents: null,
        vatRatePct: null,
        category: 'autre',
        status: 'to_pay',
        source: 'manual',
      });
      await p.expenses.save(crossTenantExpense);
      const folders = await service.listDocumentFolders();
      expect(folders.ok).toBe(true);
      if (!folders.ok) return;
      const sameTenantFolder = folders.value.items.find((folder) => folder.systemKey === 'purchases');
      if (!sameTenantFolder) throw new Error('fixture: dossier Achats absent');
      const crossTenantFolder = DocumentFolder.create({
        id: 'folder-cross-tenant',
        companyId: INTRUS.companyId!,
        name: 'Dossier privé',
        now: new Date().toISOString(),
      });
      if (!crossTenantFolder.ok) throw new Error('fixture: dossier cross-tenant invalide');
      p.documentFolders.seed(crossTenantFolder.value);

      const before = await service.listDocuments();
      expect(before.ok).toBe(true);
      const sameTenantUpload = await service.uploadDocument({
        contentBase64: '/9j/2Q==',
        mimeType: 'image/jpeg',
        filename: 'ticket-lie.jpg',
        kind: 'expense_receipt',
        folderId: sameTenantFolder.id,
        linkedEntityType: 'expense',
        linkedEntityId: expense.value.id,
      });
      expect(sameTenantUpload.ok).toBe(true);

      for (const linkedEntityId of ['expense-absente', crossTenantExpense.id]) {
        const rejected = await service.uploadDocument({
          contentBase64: '/9j/2Q==',
          mimeType: 'image/jpeg',
          filename: `ticket-${linkedEntityId}.jpg`,
          kind: 'expense_receipt',
          linkedEntityType: 'expense',
          linkedEntityId,
        });
        expect(rejected).toEqual({
          ok: false,
          error: { kind: 'not_found', entity: 'expense', id: linkedEntityId },
        });
      }
      for (const folderId of ['folder-absent', crossTenantFolder.value.id]) {
        const rejected = await service.uploadDocument({
          contentBase64: '/9j/2Q==',
          mimeType: 'image/jpeg',
          filename: `ticket-${folderId}.jpg`,
          kind: 'expense_receipt',
          folderId,
          linkedEntityType: 'expense',
          linkedEntityId: expense.value.id,
        });
        expect(rejected).toEqual({
          ok: false,
          error: { kind: 'not_found', entity: 'document_folder', id: folderId },
        });
      }
      const afterUploads = await service.listDocuments();
      expect(afterUploads.ok && before.ok && afterUploads.value).toHaveLength((before.ok ? before.value.length : 0) + 1);

      const sameTargetDocument = await service.createDocumentIntake({
        contentBase64: '/9j/2Q==',
        mimeType: 'image/jpeg',
        filename: 'a-classer-same.jpg',
        idempotencyKey: 'document-link-same-tenant-0001',
      });
      expect(sameTargetDocument.ok).toBe(true);
      if (!sameTargetDocument.ok) return;
      const classified = await service.classifyDocument({
        documentId: sameTargetDocument.value.id,
        linkedEntityType: 'expense',
        linkedEntityId: expense.value.id,
        expectedRevision: sameTargetDocument.value.revision,
      });
      expect(classified.ok && classified.value.linkedEntityId).toBe(expense.value.id);

      for (const [suffix, linkedEntityId] of [
        ['missing', 'expense-absente'],
        ['cross', crossTenantExpense.id],
      ] as const) {
        const archived = await service.createDocumentIntake({
          contentBase64: '/9j/2Q==',
          mimeType: 'image/jpeg',
          filename: `a-classer-${suffix}.jpg`,
          idempotencyKey: `document-link-${suffix}-tenant-0001`,
        });
        expect(archived.ok).toBe(true);
        if (!archived.ok) continue;
        const rejected = await service.classifyDocument({
          documentId: archived.value.id,
          linkedEntityType: 'expense',
          linkedEntityId,
          expectedRevision: archived.value.revision,
        });
        expect(rejected).toEqual({
          ok: false,
          error: { kind: 'not_found', entity: 'expense', id: linkedEntityId },
        });
        const unchanged = await p.documents.findById(MERCIER.companyId!, archived.value.id);
        expect(unchanged?.toProps()).toMatchObject({
          linkedEntityType: null,
          linkedEntityId: null,
          revision: archived.value.revision,
        });
      }
    });
  });

  it('finalise atomiquement document -> dépense -> E1 -> dossier et converge après réponse perdue', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const archived = await service.createDocumentIntake({
        contentBase64: '/9j/2Q==',
        mimeType: 'image/jpeg',
        filename: 'facture-atomique.jpg',
        idempotencyKey: 'scan-expense-atomic-0001',
      });
      expect(archived.ok).toBe(true);
      if (!archived.ok) return;
      const folders = await service.listDocumentFolders();
      expect(folders.ok).toBe(true);
      if (!folders.ok) return;
      const purchases = folders.value.items.find((folder) => folder.systemKey === 'purchases');
      if (!purchases) throw new Error('fixture: dossier Achats absent');
      const request = {
        documentId: archived.value.id,
        expectedRevision: archived.value.revision,
        targetFolderId: purchases.id,
        expense: {
          supplierName: 'Cedeo',
          documentDate: todayUtc(),
          totalTtcCents: 18_490,
          vatCents: 3_082,
          vatRatePct: 20,
          category: 'fournitures' as const,
        },
      };

      const [first, responseLostRetry] = await Promise.all([
        service.recordDocumentExpense(request),
        service.recordDocumentExpense(request),
      ]);

      expect(first.ok).toBe(true);
      expect(responseLostRetry.ok).toBe(true);
      if (!first.ok || !responseLostRetry.ok) return;
      expect(responseLostRetry.value.expenseId).toBe(first.value.expenseId);
      expect(first.value.document).toMatchObject({
        id: archived.value.id,
        folderId: purchases.id,
        linkedEntityType: 'expense',
        linkedEntityId: first.value.expenseId,
      });
      // Le retry conserve volontairement la révision initiale : l'état final convergé gagne
      // sur le CAS devenu obsolète après une réponse HTTP perdue.
      await expect(service.recordDocumentExpense(request)).resolves.toMatchObject({
        ok: true,
        value: { expenseId: first.value.expenseId },
      });
      expect(await p.expenses.listByCompany(MERCIER.companyId!)).toHaveLength(1);
      const entries = await p.accountingEntries.listByCompany(MERCIER.companyId!);
      expect(entries.filter((entry) => entry.toProps().sourceId === first.value.expenseId)).toHaveLength(1);
      expect(p.expenseCreationRequests.snapshot().size).toBe(1);

      const laterFolder = await service.createDocumentFolder({ name: 'Contrôle ultérieur' });
      expect(laterFolder.ok).toBe(true);
      if (!laterFolder.ok) return;
      const movedLater = await service.moveDocumentToFolder({
        documentId: archived.value.id,
        folderId: laterFolder.value.id,
        expectedRevision: first.value.document.revision,
      });
      expect(movedLater.ok).toBe(true);

      // Un ancien retry ne doit pas masquer une modification postérieure du rangement : seul
      // le replay exact (même dépense ET même dossier actif) contourne le CAS devenu obsolète.
      const staleAfterMove = await service.recordDocumentExpense(request);
      expect(staleAfterMove).toEqual({
        ok: false,
        error: expect.objectContaining({ kind: 'conflict', entity: 'document' }),
      });
      expect(await p.expenses.listByCompany(MERCIER.companyId!)).toHaveLength(1);
    });
  });

  it('rollback Expense + E1 + claim + move si le classify CAS perd après les écritures financières', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const archived = await service.createDocumentIntake({
        contentBase64: '/9j/2Q==',
        mimeType: 'image/jpeg',
        filename: 'facture-cas.jpg',
        idempotencyKey: 'scan-expense-cas-rollback-0001',
      });
      expect(archived.ok).toBe(true);
      if (!archived.ok) return;
      const folders = await service.listDocumentFolders();
      if (!folders.ok) throw new Error('fixture: dossiers absents');
      const purchases = folders.value.items.find((folder) => folder.systemKey === 'purchases');
      if (!purchases) throw new Error('fixture: dossier Achats absent');

      const classify = vi.spyOn(p.documents, 'classify').mockResolvedValue('revision_conflict');
      const result = await service.recordDocumentExpense({
        documentId: archived.value.id,
        expectedRevision: archived.value.revision,
        targetFolderId: purchases.id,
        expense: {
          supplierName: 'Cedeo',
          documentDate: todayUtc(),
          totalTtcCents: 12_000,
          category: 'fournitures',
        },
      });
      classify.mockRestore();

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('conflict');
      expect(await p.expenses.listByCompany(MERCIER.companyId!)).toEqual([]);
      expect(await p.accountingEntries.listByCompany(MERCIER.companyId!)).toEqual([]);
      expect(p.expenseCreationRequests.snapshot().size).toBe(0);
      const documentAfter = await p.documents.findById(MERCIER.companyId!, archived.value.id);
      expect(documentAfter?.toProps()).toMatchObject({
        folderId: null,
        linkedEntityType: null,
        linkedEntityId: null,
        revision: archived.value.revision,
      });
    });
  });

  it('masque le document d’un autre tenant et ne crée aucune dépense ni claim', async () => {
    const { service, p } = makeService();
    await p.seed();
    const fixture = await asPrincipal(MERCIER, async () => {
      const archived = await service.createDocumentIntake({
        contentBase64: '/9j/2Q==',
        mimeType: 'image/jpeg',
        filename: 'facture-privee.jpg',
        idempotencyKey: 'scan-expense-idor-0001',
      });
      const folders = await service.listDocumentFolders();
      if (!archived.ok || !folders.ok) throw new Error('fixture: document ou dossiers absents');
      const purchases = folders.value.items.find((folder) => folder.systemKey === 'purchases');
      if (!purchases) throw new Error('fixture: dossier Achats absent');
      return { document: archived.value, targetFolderId: purchases.id };
    });

    const intrusion = await asPrincipal(INTRUS, () => service.recordDocumentExpense({
      documentId: fixture.document.id,
      expectedRevision: fixture.document.revision,
      targetFolderId: fixture.targetFolderId,
      expense: {
        supplierName: 'Cedeo',
        documentDate: todayUtc(),
        totalTtcCents: 5_000,
        category: 'fournitures',
      },
    }));

    expect(intrusion).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'document', id: fixture.document.id },
    });
    expect(await p.expenses.listByCompany(INTRUS.companyId!)).toEqual([]);
    expect(p.expenseCreationRequests.snapshot().size).toBe(0);
  });

  it('répare un ancien Expense + E1 orphelin via la clé SHA serveur sans créer de doublon', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const archived = await service.createDocumentIntake({
        contentBase64: '/9j/2Q==',
        mimeType: 'image/jpeg',
        filename: 'facture-reprise.jpg',
        idempotencyKey: 'scan-expense-orphan-repair-0001',
      });
      expect(archived.ok).toBe(true);
      if (!archived.ok) return;
      const oldFlowExpense = await service.recordExpense({
        idempotencyKey: `mobile:document-expense:v1:${archived.value.sha256}`,
        supplierName: 'Cedeo',
        documentDate: todayUtc(),
        totalTtcCents: 9_900,
        category: 'fournitures',
        source: 'ocr',
      });
      expect(oldFlowExpense.ok).toBe(true);
      if (!oldFlowExpense.ok) return;
      const folders = await service.listDocumentFolders();
      if (!folders.ok) throw new Error('fixture: dossiers absents');
      const purchases = folders.value.items.find((folder) => folder.systemKey === 'purchases');
      if (!purchases) throw new Error('fixture: dossier Achats absent');

      const repaired = await service.recordDocumentExpense({
        documentId: archived.value.id,
        expectedRevision: archived.value.revision,
        targetFolderId: purchases.id,
        expense: {
          supplierName: 'Cedeo',
          documentDate: todayUtc(),
          totalTtcCents: 9_900,
          category: 'fournitures',
        },
      });

      expect(repaired.ok && repaired.value.expenseId).toBe(oldFlowExpense.value.id);
      expect(await p.expenses.listByCompany(MERCIER.companyId!)).toHaveLength(1);
      expect(await p.accountingEntries.listByCompany(MERCIER.companyId!)).toHaveLength(1);
      if (repaired.ok) {
        expect(repaired.value.document).toMatchObject({
          linkedEntityType: 'expense',
          linkedEntityId: oldFlowExpense.value.id,
          folderId: purchases.id,
        });
      }
    });
  });

  it('analyse une version une seule fois, sert le cache immuable et expose les faits vérifiés à Bob', async () => {
    const analyzeDocument = vi.fn<DocumentIntelligencePort['analyzeDocument']>(async () => ({
      ok: true,
      value: {
        analyzerVersion: 'document-test-v1',
        analysis: {
          type: 'supplier_invoice',
          typeConfidence: 0.97,
          summary: 'Facture fournisseur Cedeo de 184,90 € TTC, à contrôler avant comptabilisation.',
          facts: [
            {
              key: 'supplier_name',
              valueType: 'text',
              value: 'Cedeo',
              confidence: 0.99,
              provenance: {
                source: 'document_text',
                evidence: [{ page: 1, excerpt: 'CEDEO', boundingBox: null }],
              },
            },
            {
              key: 'total_ttc',
              valueType: 'money',
              value: { amountMinor: 18_490, currency: 'EUR' },
              confidence: 0.98,
              provenance: {
                source: 'document_text',
                evidence: [{ page: 1, excerpt: 'Total TTC 184,90 €', boundingBox: null }],
              },
            },
          ],
          suggestedTags: ['achat', 'fournisseur'],
          suggestedFilename: 'Facture Cedeo',
          warnings: ['Vérifier la date d’échéance.'],
        },
      },
    }));
    const { service, p, metrics } = makeService({ documentIntelligence: { analyzeDocument } });
    await p.seed();

    await asPrincipal(MERCIER, async () => {
      const archived = await service.createDocumentIntake({
        contentBase64: '/9j/2Q==',
        mimeType: 'image/jpeg',
        filename: 'facture-cedeo.jpg',
        idempotencyKey: 'scan-analysis-cache-0001',
      });
      expect(archived.ok).toBe(true);
      if (!archived.ok) return;

      const first = await service.analyzeStoredDocument(archived.value.id);
      const second = await service.analyzeStoredDocument(archived.value.id);
      expect(first.ok && second.ok).toBe(true);
      expect(second).toEqual(first);
      expect(analyzeDocument).toHaveBeenCalledTimes(1);
      expect(metrics.aiRequests.inc).toHaveBeenCalledTimes(1);

      const summary = await service.askBob({
        message: 'Résume ce document',
        context: {
          screen: { name: '/documents/[id]', instanceId: `document:${archived.value.id}` },
          entities: [{ type: 'document', id: archived.value.id, label: 'FAUX RÉSUMÉ FOURNI PAR LE MOBILE' }],
          capabilities: ['screen.read', 'document.read'],
        },
      });
      expect(summary.ok).toBe(true);
      if (!summary.ok) return;
      expect(summary.value).toMatchObject({ kind: 'answer', intent: 'contexte_ecran' });
      expect(summary.value.card.body).toContain('Facture fournisseur Cedeo');
      expect(summary.value.card.body).toContain('184,90');
      expect(summary.value.card.body).not.toContain('FAUX RÉSUMÉ');

      const opened = await service.askBob({
        message: 'Ouvre ce document',
        context: {
          screen: { name: '/documents', instanceId: 'documents' },
          entities: [{ type: 'document', id: archived.value.id, label: 'Route mobile forgée' }],
          capabilities: ['screen.read', 'document.read'],
        },
      });
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        expect(opened.value).toMatchObject({
          kind: 'done',
          intent: 'contexte_ecran',
          navigate: `/documents/${archived.value.id}`,
        });
      }
    });
  });

  it('archive idempotemment, transfère via un plan opaque puis refuse son rejeu', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const source = await service.createDocumentFolder({ name: 'Archives temporaires' });
      const target = await service.createDocumentFolder({ name: 'Archives définitives' });
      expect(source.ok && target.ok).toBe(true);
      if (!source.ok || !target.ok) return;

      const intakeInput = {
        contentBase64: '/9j/2Q==',
        mimeType: 'image/jpeg',
        filename: 'preuve.jpg',
        idempotencyKey: 'scan-test-idempotent-0001',
      };
      const [first, retry] = await Promise.all([
        service.createDocumentIntake(intakeInput),
        service.createDocumentIntake(intakeInput),
      ]);
      expect(first.ok && retry.ok && retry.value.id).toBe(first.ok ? first.value.id : '');
      if (!first.ok) return;
      const moved = await service.moveDocumentToFolder({
        documentId: first.value.id,
        folderId: source.value.id,
        expectedRevision: first.value.revision,
      });
      expect(moved.ok).toBe(true);

      const preview = await service.previewDocumentFolderDeletion(source.value.id);
      expect(preview.ok && preview.value).toMatchObject({ documentCount: 1, canDeleteEmpty: false });
      if (!preview.ok) return;
      expect(preview.value).not.toHaveProperty('snapshot');
      const executed = await service.executeDocumentFolderDeletion({
        planId: preview.value.planId,
        strategy: {
          kind: 'transfer',
          targetFolderId: target.value.id,
          targetExpectedRevision: target.value.revision,
        },
      });
      expect(executed).toEqual({
        ok: true,
        value: { folderId: source.value.id, transferredDocuments: 1, transferredChildren: 0 },
      });
      const inTarget = await service.listDocuments({ folderId: target.value.id });
      expect(inTarget.ok && inTarget.value.map((document) => document.id)).toEqual([first.value.id]);

      const replay = await service.executeDocumentFolderDeletion({
        planId: preview.value.planId,
        strategy: { kind: 'empty' },
      });
      expect(replay.ok).toBe(false);
    });
  });

  it('interdit la suppression des dossiers système', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const roots = await service.listDocumentFolders();
      expect(roots.ok).toBe(true);
      if (!roots.ok) return;
      const purchases = roots.value.items.find((folder) => folder.systemKey === 'purchases');
      if (!purchases) throw new Error('fixture: dossier Achats absent');
      const preview = await service.previewDocumentFolderDeletion(purchases.id);
      expect(preview.ok).toBe(false);
      if (!preview.ok) expect(preview.error.kind).toBe('forbidden');
    });
  });

  it('rollback tout transfert tardivement conflictuel tout en brûlant le plan opaque', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asPrincipal(MERCIER, async () => {
      const source = await service.createDocumentFolder({ name: 'À reclasser' });
      const target = await service.createDocumentFolder({ name: 'Destination sûre' });
      expect(source.ok && target.ok).toBe(true);
      if (!source.ok || !target.ok) return;
      const child = await service.createDocumentFolder({ name: 'Sous-dossier', parentId: source.value.id });
      expect(child.ok).toBe(true);
      if (!child.ok) return;
      const preview = await service.previewDocumentFolderDeletion(source.value.id);
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;

      const originalRunWithTenant = p.runWithTenant.bind(p);
      let tenantTransactionAborts = 0;
      vi.spyOn(p, 'runWithTenant').mockImplementation(async (companyId, work) => {
        try {
          return await originalRunWithTenant(companyId, work);
        } catch (cause) {
          tenantTransactionAborts += 1;
          throw cause;
        }
      });
      const originalSave = p.documentFolders.save.bind(p.documentFolders);
      vi.spyOn(p.documentFolders, 'save').mockImplementation((folder, expectedRevision) => {
        if (folder.id === source.value.id && folder.status === 'deleted') {
          return Promise.resolve({ status: 'revision_conflict' });
        }
        return originalSave(folder, expectedRevision);
      });

      const result = await service.executeDocumentFolderDeletion({
        planId: preview.value.planId,
        strategy: {
          kind: 'transfer',
          targetFolderId: target.value.id,
          targetExpectedRevision: target.value.revision,
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('conflict');
      // Le marqueur d'erreur traverse bien la transaction tenant externe : Prisma rollbackera
      // les mêmes écritures ; l'adapter mémoire a déjà restauré son propre snapshot.
      expect(tenantTransactionAborts).toBe(1);

      const sourceAfter = await service.getDocumentFolder(source.value.id);
      const sourceChildren = await service.listDocumentFolders({ parentId: source.value.id });
      const targetChildren = await service.listDocumentFolders({ parentId: target.value.id });
      expect(sourceAfter.ok).toBe(true);
      expect(sourceChildren.ok && sourceChildren.value.items.map((folder) => folder.id)).toEqual([child.value.id]);
      expect(targetChildren.ok && targetChildren.value.items).toEqual([]);

      const replay = await service.executeDocumentFolderDeletion({
        planId: preview.value.planId,
        strategy: { kind: 'empty' },
      });
      expect(replay.ok).toBe(false);
    });
  });
});

describe('enforcement des offres (pilier 2) — le serveur fait foi, jamais l\'UI', () => {
  type SubscriptionAuthority = { subscriptionFor(companyId: string): unknown };
  const subscriptionOf = (tier: 'free' | 'solo' | 'pro' | 'business', status: 'active' | 'past_due' = 'active') => {
    const started = Subscription.start({ id: 'sub-test', companyId: 'co-test', tier, status });
    if (!started.ok) throw new Error('abonnement de test non constructible');
    return started.value;
  };

  it('exportFec REFUSE sous Pro (accounting_operations) avec un message d\'upsell honnête', async () => {
    const { service } = makeService();
    vi.spyOn(service as unknown as SubscriptionAuthority, 'subscriptionFor').mockReturnValue(
      subscriptionOf('solo') as never,
    );
    const result = await asPrincipal(MERCIER, () =>
      service.exportFec({ from: todayUtc(), to: todayUtc() }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('forbidden');
      expect(JSON.stringify(result.error)).toContain('offre Pro');
    }
  });

  it('exportFec PASSE à partir de Pro (et en early-access : business pour tous)', async () => {
    const { service } = makeService();
    const result = await asPrincipal(MERCIER, () =>
      service.exportFec({ from: todayUtc(), to: todayUtc() }),
    );
    // La frontière testée est l'ENFORCEMENT : à partir de Pro, jamais un refus d'offre —
    // le use case peut échouer pour d'autres raisons (harness sans société seedée).
    if (!result.ok) expect(result.error.kind).not.toBe('forbidden');
  });

  it('P1 review : un abonnement past_due ne déclenche JAMAIS de relances automatiques, même en Pro', () => {
    const { service } = makeService();
    vi.spyOn(service as unknown as SubscriptionAuthority, 'subscriptionFor').mockReturnValue(
      subscriptionOf('pro', 'past_due') as never,
    );
    expect(service.autoDunningEntitlement('co-1')).toEqual({ allowed: false, plan: 'pro' });
  });

  it('autoDunningEntitlement : solo → refus tracé avec le plan ; business → ouvert', () => {
    const { service } = makeService();
    const spy = vi.spyOn(service as unknown as SubscriptionAuthority, 'subscriptionFor');
    spy.mockReturnValue(subscriptionOf('solo') as never);
    expect(service.autoDunningEntitlement('co-1')).toEqual({ allowed: false, plan: 'solo' });
    spy.mockRestore();
    // Early-access réel : subscriptionFor rend business/active pour tous — personne n'est refusé.
    expect(service.autoDunningEntitlement('co-1')).toEqual({ allowed: true, plan: 'business' });
  });
});

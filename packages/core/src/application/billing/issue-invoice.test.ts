import { describe, expect, it } from 'vitest';
import { IssueInvoice } from './issue-invoice';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { Quote } from '../../domain/billing/quote/quote';
import { Company } from '../../domain/company/company';
import { Customer } from '../../domain/customer/customer';
import { DocNumber } from '../../domain/billing/shared/doc-number';
import { PaymentTerms } from '../../shared-kernel/payment-terms';
import { seedCompany, seedCustomers } from '../fixtures';
import {
  type CompanyRepository,
  type CustomerRepository,
  type InvoiceRepository,
} from '../ports/repositories';
import { type ClockPort, type SequenceCounterPort, type UnitOfWorkPort } from '../ports/services';

const clock: ClockPort = {
  now: () => '2026-06-30T10:00:00.000Z',
  today: () => '2026-06-30',
};
const terms = { days: 30, endOfMonth: false, label: 'Paiement à 30 jours' } as const;

function draftInvoice(id = 'inv-1'): Invoice {
  const company = seedCompany();
  const customer = seedCustomers()[1]!;
  const created = Invoice.composeStandalone({ id, companyId: company.id, customerId: customer.id });
  if (!created.ok) throw new Error('invoice');
  const invoice = created.value;
  const added = invoice.addLine({
    id: 'line-1',
    label: 'Intervention',
    category: 'labor',
    qty: 1,
    unitPriceHT: 100000,
    vatRate: 20,
  });
  if (!added.ok) throw new Error('line');
  return invoice;
}

function issuedInvoice(id = 'inv-1', number = 'F-2026-0007'): Invoice {
  const invoice = draftInvoice(id);
  const terms = PaymentTerms.of({ days: 30, endOfMonth: false, label: 'Paiement a 30 jours' });
  if (!terms.ok) throw new Error('terms');
  const parsedNumber = DocNumber.of(number);
  if (!parsedNumber.ok) throw new Error('number');
  const assigned = invoice.assignNumber(parsedNumber.value, clock.now());
  if (!assigned.ok) throw new Error('number');
  const issued = invoice.issue({
    mentions: ['Mention'],
    terms: terms.value,
    issuedAt: clock.today(),
    at: clock.now(),
  });
  if (!issued.ok) throw new Error('issue');
  return invoice;
}

function makeDeps(invoice: Invoice) {
  let company = seedCompany();
  let customers = seedCustomers();
  let allocations = 0;
  let saves = 0;
  const events: string[] = [];
  const invoices: InvoiceRepository = {
    findById: async (id) => {
      events.push('invoice:locator');
      return id === invoice.id ? invoice : null;
    },
    lockById: async (id) => {
      events.push('invoice:update');
      return id === invoice.id ? invoice : null;
    },
    findByParentQuoteId: async () => null,
    findCreditNoteBySourceInvoiceId: async () => null,
    listByCompany: async () => [invoice],
    save: async (i) => {
      events.push('invoice:save');
      saves += 1;
      invoice = i;
    },
    deleteById: async () => {},
  };
  const companies: CompanyRepository = {
    findById: async (id) => (id === company.id ? company : null),
    lockById: async (id) => (id === company.id ? company : null),
    lockForShareById: async (id) => {
      events.push('company:share');
      return id === company.id ? company : null;
    },
    list: async () => [company],
    save: async () => {},
  };
  const customerRepo: CustomerRepository = {
    findById: async (id) => {
      events.push('customer:read');
      return customers.find((c) => c.id === id) ?? null;
    },
    listByCompany: async () => customers,
    save: async () => {},
  };
  const counters: SequenceCounterPort = {
    allocate: async () => {
      events.push('counter:allocate');
      allocations += 1;
      return { sequence: allocations, formatted: DocNumber.format('F', 2026, allocations) };
    },
  };
  const uow: UnitOfWorkPort = { runInTransaction: (fn) => fn() };
  const usecase = new IssueInvoice({
    invoices,
    companies,
    customers: customerRepo,
    // Pièces composées librement (parentQuoteId null) : la revérification A3 ne lit jamais ce repo.
    quotes: { findById: async () => null, lockById: async () => null },
    counters,
    uow,
    clock,
  });
  return {
    usecase,
    events,
    counts: () => ({ allocations, saves }),
    replaceCompany: (next: Company) => {
      company = next;
    },
    replaceCustomers: (next: Customer[]) => {
      customers = next;
    },
  };
}

describe('IssueInvoice', () => {
  it('renvoie le numéro existant quand l’émission est rejouée', async () => {
    const env = makeDeps(draftInvoice());

    const first = await env.usecase.execute({ invoiceId: 'inv-1', terms });
    const replay = await env.usecase.execute({ invoiceId: 'inv-1', terms });

    expect(first.ok && first.value.number).toBe('F-2026-0001');
    expect(replay.ok && replay.value.number).toBe('F-2026-0001');
    expect(env.counts()).toEqual({ allocations: 1, saves: 1 });
    expect(env.events).toEqual([
      'invoice:locator',
      'company:share',
      'invoice:update',
      'customer:read',
      'counter:allocate',
      'invoice:save',
      'invoice:locator',
      'company:share',
      'invoice:update',
    ]);
  });

  it('renvoie le numéro si le verrou relit une facture déjà émise par une course concurrente', async () => {
    const pre = draftInvoice();
    const locked = issuedInvoice('inv-1', 'F-2026-0042');
    let allocations = 0;
    let saves = 0;
    const company = seedCompany();
    const customers = seedCustomers();
    const invoices: InvoiceRepository = {
      findById: async () => pre,
      lockById: async () => locked,
      findByParentQuoteId: async () => null,
      findCreditNoteBySourceInvoiceId: async () => null,
      listByCompany: async () => [],
      save: async () => {
        saves += 1;
      },
      deleteById: async () => {},
    };
    const companies: CompanyRepository = {
      findById: async () => company,
      lockById: async () => company,
      lockForShareById: async () => company,
      list: async () => [company],
      save: async () => {},
    };
    const customerRepo: CustomerRepository = {
      findById: async (id) => customers.find((c) => c.id === id) ?? null,
      listByCompany: async () => customers,
      save: async () => {},
    };
    const counters: SequenceCounterPort = {
      allocate: async () => {
        allocations += 1;
        return { sequence: allocations, formatted: DocNumber.format('F', 2026, allocations) };
      },
    };

    const r = await new IssueInvoice({
      invoices,
      companies,
      customers: customerRepo,
      quotes: { findById: async () => null, lockById: async () => null },
      counters,
      uow: { runInTransaction: (fn) => fn() },
      clock,
    }).execute({ invoiceId: 'inv-1' });

    expect(r.ok && r.value.number).toBe('F-2026-0042');
    expect({ allocations, saves }).toEqual({ allocations: 0, saves: 0 });
  });

  it('refuse un brouillon sans conditions explicites avant toute allocation légale', async () => {
    const env = makeDeps(draftInvoice());

    const result = await env.usecase.execute({ invoiceId: 'inv-1' });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'validation',
        issues: [
          {
            field: 'paymentTerms',
            message: 'Conditions de paiement explicites requises avant émission.',
          },
        ],
      },
    });
    expect(env.counts()).toEqual({ allocations: 0, saves: 0 });
    expect(env.events).toEqual([
      'invoice:locator',
      'company:share',
      'invoice:update',
      'customer:read',
    ]);
  });

  it('refuse une émission après clôture avant de verrouiller la facture ou consommer un numéro', async () => {
    const env = makeDeps(draftInvoice());
    const current = seedCompany();
    const closed = Company.of({
      ...current.toProps(),
      closedAt: '2026-06-30T09:59:59.000Z',
    });
    if (!closed.ok) throw new Error('closed company');
    env.replaceCompany(closed.value);

    const result = await env.usecase.execute({ invoiceId: 'inv-1', terms });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'domain',
        error: {
          code: 'VALIDATION',
          field: 'company',
          message: 'Société introuvable ou clôturée.',
        },
      },
    });
    expect(env.events).toEqual(['invoice:locator', 'company:share']);
    expect(env.counts()).toEqual({ allocations: 0, saves: 0 });
  });

  it('revalide aussi la clôture sur un replay déjà numéroté, sans exiger les conditions', async () => {
    const env = makeDeps(issuedInvoice());
    const current = seedCompany();
    const closed = Company.of({
      ...current.toProps(),
      closedAt: '2026-06-30T09:59:59.000Z',
    });
    if (!closed.ok) throw new Error('closed company');
    env.replaceCompany(closed.value);

    const result = await env.usecase.execute({ invoiceId: 'inv-1' });

    expect(result.ok).toBe(false);
    expect(env.events).toEqual(['invoice:locator', 'company:share']);
    expect(env.counts()).toEqual({ allocations: 0, saves: 0 });
  });

  it('refuse un client frais cross-tenant avant toute allocation légale', async () => {
    const env = makeDeps(draftInvoice());
    const original = seedCustomers()[1]!;
    const foreign = Customer.of({ ...original.toProps(), companyId: 'company-other' });
    if (!foreign.ok) throw new Error('foreign customer');
    env.replaceCustomers([foreign.value]);

    const result = await env.usecase.execute({ invoiceId: 'inv-1', terms });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'domain',
        error: {
          code: 'VALIDATION',
          field: 'customer',
          message: 'Client introuvable.',
        },
      },
    });
    expect(env.events).toEqual([
      'invoice:locator',
      'company:share',
      'invoice:update',
      'customer:read',
    ]);
    expect(env.counts()).toEqual({ allocations: 0, saves: 0 });
  });

  it('A7 : fige période de prestation + adresse de chantier transmises à l’émission', async () => {
    const invoice = draftInvoice();
    const env = makeDeps(invoice);

    const result = await env.usecase.execute({
      invoiceId: 'inv-1',
      terms,
      servicePeriod: { start: '2026-06-10', end: '2026-06-24' },
      deliveryAddress: '12 rue des Acacias, 92310 Sèvres',
    });

    expect(result.ok && result.value.number).toBe('F-2026-0001');
    expect(invoice.servicePeriod).toEqual({ start: '2026-06-10', end: '2026-06-24' });
    expect(invoice.deliveryAddress).toBe('12 rue des Acacias, 92310 Sèvres');
  });

  it('A7 : une période invalide annule la transaction — aucun numéro consommé', async () => {
    const invoice = draftInvoice();
    const env = makeDeps(invoice);

    const result = await env.usecase.execute({
      invoiceId: 'inv-1',
      terms,
      servicePeriod: { start: '2026-06-24', end: '2026-06-10' },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'domain', error: { code: 'VALIDATION', field: 'servicePeriod' } },
    });
    // Le compteur A ÉTÉ sollicité avant le verdict domaine, mais la transaction annulée ne
    // consomme pas le numéro (rollback UoW) : la preuve observable est l'absence de save.
    expect(env.counts().saves).toBe(0);
    expect(invoice.status).toBe('draft');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A4 — garde d'émission autoliquidation + régime de TVA figé à l'émission
// ─────────────────────────────────────────────────────────────────────────────
describe('IssueInvoice — A4 : autoliquidation constatée et FIGÉE à l’émission', () => {
  function subcontractingCustomer(withSiren = true): Customer {
    const { siren, ...withoutSiren } = seedCustomers()[1]!.toProps();
    const r = Customer.of({
      ...withoutSiren,
      ...(withSiren && siren !== undefined ? { siren } : {}),
      isSubcontractingBtp: true,
    });
    if (!r.ok) throw new Error('customer');
    return r.value;
  }

  it('lignes à 20 % avec client sous-traitant BTP → émission REFUSÉE (BR-AE-5, PDF≠XML sinon)', async () => {
    const invoice = draftInvoice(); // ligne à 20 %
    const env = makeDeps(invoice);
    env.replaceCustomers([subcontractingCustomer()]);
    const r = await env.usecase.execute({ invoiceId: 'inv-1', terms });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'validation')
      expect(r.error.issues[0]?.message).toContain('autoliquidation');
    expect(env.counts().saves).toBe(0);
    expect(invoice.status).toBe('draft');
  });

  function zeroRatedDraft(): Invoice {
    const company = seedCompany();
    const customer = seedCustomers()[1]!;
    const created = Invoice.composeStandalone({ id: 'inv-1', companyId: company.id, customerId: customer.id });
    if (!created.ok) throw new Error('invoice');
    const added = created.value.addLine({
      id: 'line-1',
      label: 'Sous-traitance plomberie',
      category: 'labor',
      qty: 1,
      unitPriceHT: 100000,
      vatRate: 0,
    });
    if (!added.ok) throw new Error('line');
    return created.value;
  }

  it('client sous-traitant SANS SIREN → émission REFUSÉE (BR-AE-2 : identification du preneur)', async () => {
    const invoice = zeroRatedDraft();
    const env = makeDeps(invoice);
    env.replaceCustomers([subcontractingCustomer(false)]);
    const r = await env.usecase.execute({ invoiceId: 'inv-1', terms });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'validation')
      expect(r.error.issues[0]?.message).toContain('SIREN');
    expect(env.counts().saves).toBe(0);
  });

  it('lignes à 0 % + SIREN preneur → émise, régime « autoliquidation » FIGÉ dans la pièce', async () => {
    const invoice = zeroRatedDraft();
    const env = makeDeps(invoice);
    env.replaceCustomers([subcontractingCustomer()]);
    const r = await env.usecase.execute({ invoiceId: 'inv-1', terms });
    expect(r.ok).toBe(true);
    expect(invoice.vatTreatmentAtIssuance).toBe('autoliquidation');
  });

  it('client ordinaire → régime « standard » figé (le fait fiscal de la pièce est explicite)', async () => {
    const invoice = draftInvoice();
    const env = makeDeps(invoice);
    const r = await env.usecase.execute({ invoiceId: 'inv-1', terms });
    expect(r.ok).toBe(true);
    expect(invoice.vatTreatmentAtIssuance).toBe('standard');
  });

  it('société en FRANCHISE + client sous-traitant → la franchise PRIME (BOI-TVA-DECLA-10-10-20) : régime « franchise », aucune exigence AE', async () => {
    const invoice = draftInvoice();
    const env = makeDeps(invoice);
    const franchiseProps = { ...seedCompany().toProps(), vatRegime: 'franchise' as const };
    const franchise = Company.of(franchiseProps);
    if (!franchise.ok) throw new Error('company');
    env.replaceCompany(franchise.value);
    env.replaceCustomers([subcontractingCustomer()]);
    const r = await env.usecase.execute({ invoiceId: 'inv-1', terms });
    expect(r.ok).toBe(true);
    expect(invoice.vatTreatmentAtIssuance).toBe('franchise');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A3 — revérification des gardes légales à l'ÉMISSION (pièces dérivées d'un devis)
// ─────────────────────────────────────────────────────────────────────────────
describe('IssueInvoice — A3 : gel/embargo revérifiés à l’émission', () => {
  function quoteEnv(options: {
    mode: 'deposit' | 'final';
    method?: 'onsite_draw' | 'remote_link';
    now: string;
    customerType?: 'b2c' | 'b2b';
    retractedAt?: string;
    earlyExecution?: boolean;
    quoteMissing?: boolean;
  }) {
    const company = seedCompany();
    const quote = Quote.rehydrate({
      id: 'quote-1',
      companyId: company.id,
      customerId: 'cust-x',
      status: 'signed',
      number: 'D-2026-0001',
      depositPct: options.mode === 'deposit' ? 30 : null,
      validUntil: null,
      signature: {
        signerName: 'M. Bernard',
        signedAt: '2026-06-01T09:00:00.000Z',
        method: options.method ?? 'onsite_draw',
        accepted: true,
        ...(options.earlyExecution ? { earlyExecution: { requestedAt: '2026-06-01T09:00:00.000Z' } } : {}),
      },
      retractedAt: options.retractedAt ?? null,
      lines: [
        { id: 'line-1', label: 'Intervention', category: 'labor', qty: 1, unitPriceHT: 100000, vatRate: 20 },
      ],
    });
    const created = Invoice.fromSignedQuote(quote, options.mode, 'inv-1');
    if (!created.ok) throw new Error('invoice');
    let invoice = created.value;
    const customerR = Customer.of({
      id: 'cust-x',
      companyId: company.id,
      type: options.customerType ?? 'b2c',
      name: 'M. Bernard',
      address: { line1: '8 allée des Roses', zip: '92190', city: 'Meudon' },
    });
    if (!customerR.ok) throw new Error('customer');
    let saves = 0;
    const localClock = { now: () => options.now, today: () => options.now.slice(0, 10) };
    const usecase = new IssueInvoice({
      invoices: {
        findById: async () => invoice,
        lockById: async () => invoice,
        findByParentQuoteId: async () => null,
        findCreditNoteBySourceInvoiceId: async () => null,
        listByCompany: async () => [invoice],
        save: async (i) => {
          saves += 1;
          invoice = i;
        },
        deleteById: async () => {},
      },
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
        findById: async () => (options.quoteMissing ? null : quote),
        lockById: async () => (options.quoteMissing ? null : quote),
      },
      counters: {
        allocate: async () => ({ sequence: 1, formatted: DocNumber.format('F', 2026, 1) }),
      },
      uow: { runInTransaction: (fn) => fn() },
      clock: localClock,
    });
    return { usecase, invoice: () => invoice, counts: () => ({ saves }) };
  }

  it('acompte b2c signé SUR PLACE, émis pendant les 7 jours → refus L221-10 (brouillon dormant compris)', async () => {
    const env = quoteEnv({ mode: 'deposit', now: '2026-06-03T09:00:00.000Z' });
    const r = await env.usecase.execute({ invoiceId: 'inv-1', terms });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain')
      expect(r.error.error.code).toBe('OFF_PREMISES_PAYMENT_EMBARGO');
    expect(env.counts().saves).toBe(0);
    expect(env.invoice().status).toBe('draft');
  });

  it('finale b2c émise pendant le délai de rétractation (sans exécution anticipée) → refus, même si le brouillon préexistait', async () => {
    const env = quoteEnv({ mode: 'final', method: 'remote_link', now: '2026-06-10T09:00:00.000Z' });
    const r = await env.usecase.execute({ invoiceId: 'inv-1', terms });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain')
      expect(r.error.error.code).toBe('RETRACTATION_PERIOD_ACTIVE');
    expect(env.counts().saves).toBe(0);
  });

  it('finale b2c AVEC exécution anticipée (L221-25), contrat à distance → émission possible', async () => {
    const env = quoteEnv({
      mode: 'final',
      method: 'remote_link',
      now: '2026-06-10T09:00:00.000Z',
      earlyExecution: true,
    });
    const r = await env.usecase.execute({ invoiceId: 'inv-1', terms });
    expect(r.ok).toBe(true);
  });

  it('devis RÉTRACTÉ (L221-21) → émission refusée quelle que soit la pièce', async () => {
    const env = quoteEnv({
      mode: 'deposit',
      method: 'remote_link',
      now: '2026-07-15T09:00:00.000Z',
      retractedAt: '2026-06-05T10:00:00.000Z',
    });
    const r = await env.usecase.execute({ invoiceId: 'inv-1', terms });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain' && r.error.error.code === 'VALIDATION')
      expect(r.error.error.message).toContain('rétractation');
  });

  it('devis parent introuvable → fail-closed : émission refusée', async () => {
    const env = quoteEnv({ mode: 'deposit', now: '2026-07-15T09:00:00.000Z', quoteMissing: true });
    const r = await env.usecase.execute({ invoiceId: 'inv-1', terms });
    expect(r.ok).toBe(false);
  });

  it('fenêtres écoulées (b2c, sur place, J+45) → émission normale', async () => {
    const env = quoteEnv({ mode: 'deposit', now: '2026-07-15T09:00:00.000Z' });
    const r = await env.usecase.execute({ invoiceId: 'inv-1', terms });
    expect(r.ok).toBe(true);
  });

  it('professionnel (b2b) : aucune des deux gardes ne s’applique', async () => {
    const env = quoteEnv({ mode: 'deposit', now: '2026-06-03T09:00:00.000Z', customerType: 'b2b' });
    const r = await env.usecase.execute({ invoiceId: 'inv-1', terms });
    expect(r.ok).toBe(true);
  });
});

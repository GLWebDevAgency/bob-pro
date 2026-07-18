import { describe, expect, it } from 'vitest';
import { IssueInvoice } from './issue-invoice';
import { Invoice } from '../../domain/billing/invoice/invoice';
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
});

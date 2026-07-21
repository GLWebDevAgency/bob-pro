import { describe, expect, it } from 'vitest';
import { IssueInvoice } from './issue-invoice';
import { STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE } from './compose-standalone-invoice';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { Quote } from '../../domain/billing/quote/quote';
import { Customer, type CustomerProps } from '../../domain/customer/customer';
import { DocNumber } from '../../domain/billing/shared/doc-number';
import { seedCompany } from '../fixtures';
import {
  type CompanyRepository,
  type CustomerRepository,
  type InvoiceRepository,
} from '../ports/repositories';
import { type ClockPort, type SequenceCounterPort, type UnitOfWorkPort } from '../ports/services';

const NOW = '2026-06-30T10:00:00.000Z';
const clock: ClockPort = { now: () => NOW, today: () => '2026-06-30' };

const company = seedCompany();

const baseCustomer: CustomerProps = {
  id: 'cus-1',
  companyId: company.id,
  type: 'b2b',
  name: 'SARL Martin',
  siren: '821503646',
  address: { line1: 'ZA des Bruyères', zip: '92140', city: 'Clamart' },
};

/** Surcharges qui acceptent `undefined` pour RETIRER un champ optionnel (ex. siren en b2c). */
type CustomerOver = { [K in keyof CustomerProps]?: CustomerProps[K] | undefined };

function makeCustomer(over: CustomerOver = {}): Customer {
  const merged = { ...baseCustomer, ...over } as Record<string, unknown>;
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  const r = Customer.of(merged as unknown as CustomerProps);
  if (!r.ok) throw new Error('customer');
  return r.value;
}

function standaloneDraft(over?: { urgentRepair?: { requestedAt: string } }): Invoice {
  const r = Invoice.composeStandalone({
    id: 'inv-1',
    companyId: company.id,
    customerId: 'cus-1',
    urgentRepair: over?.urgentRepair ?? null,
  });
  if (!r.ok) throw new Error('invoice');
  const added = r.value.addLine({
    id: 'l1',
    label: 'Intervention',
    category: 'labor',
    qty: 1,
    unitPriceHT: 100000,
    vatRate: 20,
    discount: { type: 'percent', value: 10 },
  });
  if (!added.ok) throw new Error('line');
  return r.value;
}

function makeDeps(input: { invoice: Invoice; customer: Customer; quote?: Quote }) {
  let allocations = 0;
  let currentInvoice = input.invoice;
  const invoices: InvoiceRepository = {
    findById: async (id) => (id === currentInvoice.id ? currentInvoice : null),
    lockById: async (id) => (id === currentInvoice.id ? currentInvoice : null),
    findByParentQuoteId: async () => null,
    findCreditNoteBySourceInvoiceId: async () => null,
    listByCompany: async () => [currentInvoice],
    save: async (i) => {
      currentInvoice = i;
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
  const customers: CustomerRepository = {
    findById: async (id) => (id === input.customer.id ? input.customer : null),
    listByCompany: async () => [input.customer],
    save: async () => {},
  };
  const counters: SequenceCounterPort = {
    allocate: async ({ counterKey }) => {
      allocations += 1;
      return {
        sequence: allocations,
        formatted: DocNumber.format(counterKey === 'credit' ? 'A' : 'F', 2026, allocations),
      };
    },
  };
  const uow: UnitOfWorkPort = { runInTransaction: (fn) => fn() };
  const usecase = new IssueInvoice({
    invoices,
    companies,
    customers,
    quotes: {
      findById: async (id) => (input.quote && id === input.quote.id ? input.quote : null),
      lockById: async (id) => (input.quote && id === input.quote.id ? input.quote : null),
    },
    counters,
    uow,
    clock,
  });
  return { usecase, invoice: () => currentInvoice, allocations: () => allocations };
}

describe('IssueInvoice — B4 conditions de paiement par client', () => {
  it('sans terms explicites : dueAt dérivé des conditions du CLIENT (45 j fin de mois)', async () => {
    const customer = makeCustomer({
      paymentTerms: { days: 45, endOfMonth: true, label: '45 jours fin de mois' },
    });
    const { usecase, invoice } = makeDeps({ invoice: standaloneDraft(), customer });
    const r = await usecase.execute({ invoiceId: 'inv-1' });
    expect(r.ok).toBe(true);
    // Émise le 30/06 → +45 j = 14/08 → fin de mois = 31/08.
    expect(invoice().dueAt).toBe('2026-08-31');
  });
  it('les terms EXPLICITES de la pièce priment sur ceux du client', async () => {
    const customer = makeCustomer({
      paymentTerms: { days: 45, endOfMonth: true, label: '45 jours fin de mois' },
    });
    const { usecase, invoice } = makeDeps({ invoice: standaloneDraft(), customer });
    const r = await usecase.execute({
      invoiceId: 'inv-1',
      terms: { days: 10, endOfMonth: false, label: 'Paiement à 10 jours' },
    });
    expect(r.ok).toBe(true);
    expect(invoice().dueAt).toBe('2026-07-10');
  });
  it('defaultTerms (réglages société) utilisés en DERNIER recours', async () => {
    const { usecase, invoice } = makeDeps({ invoice: standaloneDraft(), customer: makeCustomer() });
    const r = await usecase.execute({
      invoiceId: 'inv-1',
      defaultTerms: { days: 30, endOfMonth: false, label: 'Paiement à 30 jours' },
    });
    expect(r.ok).toBe(true);
    expect(invoice().dueAt).toBe('2026-07-30');
  });
  it('aucune source de conditions → refus, aucun numéro consommé', async () => {
    const { usecase, allocations } = makeDeps({ invoice: standaloneDraft(), customer: makeCustomer() });
    const r = await usecase.execute({ invoiceId: 'inv-1' });
    expect(r.ok).toBe(false);
    expect(allocations()).toBe(0);
  });
  it('plafond L441-10 REVALIDÉ à l’émission : 61 j nets explicites sur un pro → refus', async () => {
    const { usecase, allocations } = makeDeps({ invoice: standaloneDraft(), customer: makeCustomer() });
    const r = await usecase.execute({
      invoiceId: 'inv-1',
      terms: { days: 61, endOfMonth: false, label: '61 jours' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain' && r.error.error.code === 'VALIDATION') {
      expect(r.error.error.message).toContain('L441-10');
    }
    expect(allocations()).toBe(0);
  });
  it('b2c : pas de plafond L441-10 (90 j explicites acceptés)', async () => {
    const customer = makeCustomer({ type: 'b2c', siren: undefined });
    const invoice = standaloneDraft({ urgentRepair: { requestedAt: NOW } });
    const { usecase } = makeDeps({ invoice, customer });
    const r = await usecase.execute({
      invoiceId: 'inv-1',
      terms: { days: 90, endOfMonth: false, label: '90 jours' },
    });
    expect(r.ok).toBe(true);
  });
});

describe('IssueInvoice — B6 garde client pro étranger', () => {
  it('pro international : émission refusée AVANT le compteur (fail-closed, pas d’override)', async () => {
    const customer = makeCustomer({ isInternational: true });
    const { usecase, allocations } = makeDeps({ invoice: standaloneDraft(), customer });
    const r = await usecase.execute({
      invoiceId: 'inv-1',
      terms: { days: 30, endOfMonth: false, label: '30 jours' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain' && r.error.error.code === 'VALIDATION') {
      expect(r.error.error.message).toContain('fiscalement faux');
    }
    expect(allocations()).toBe(0);
  });
});

describe('IssueInvoice — B1/A3bis facture directe B2C', () => {
  it('b2c standalone SANS urgence tracée : émission refusée (parité avec la composition)', async () => {
    const customer = makeCustomer({ type: 'b2c', siren: undefined });
    const { usecase, allocations } = makeDeps({ invoice: standaloneDraft(), customer });
    const r = await usecase.execute({
      invoiceId: 'inv-1',
      terms: { days: 0, endOfMonth: false, label: 'À réception' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'validation') {
      expect(r.error.issues[0]!.message).toBe(STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE);
    }
    expect(allocations()).toBe(0);
  });
  it('b2c standalone AVEC urgence : émise, la trace légale est IMPRIMÉE en mention', async () => {
    const customer = makeCustomer({ type: 'b2c', siren: undefined });
    const invoice = standaloneDraft({ urgentRepair: { requestedAt: '2026-06-30T08:00:00.000Z' } });
    const { usecase, invoice: current } = makeDeps({ invoice, customer });
    const r = await usecase.execute({
      invoiceId: 'inv-1',
      terms: { days: 0, endOfMonth: false, label: 'À réception' },
    });
    expect(r.ok).toBe(true);
    expect(current().mentions.some((m) => m.includes('Intervention urgente sollicitée'))).toBe(true);
    expect(current().mentions.some((m) => m.includes('L221-28'))).toBe(true);
  });
});

describe('IssueInvoice — mentions B3 et B5 figées', () => {
  it('facture remisée : mention « rabais, remises, ristournes » (L441-9) figée', async () => {
    const { usecase, invoice } = makeDeps({ invoice: standaloneDraft(), customer: makeCustomer() });
    const r = await usecase.execute({
      invoiceId: 'inv-1',
      terms: { days: 30, endOfMonth: false, label: '30 jours' },
    });
    expect(r.ok).toBe(true);
    expect(invoice().mentions.some((m) => m.includes('L441-9') && m.includes('remises'))).toBe(true);
  });
  it('situation avec retenue : mention loi 71-584 + totaux figés avec la retenue', async () => {
    const at = '2026-06-01T09:00:00.000Z';
    const q = Quote.compose({ id: 'q-1', companyId: company.id, customerId: 'cus-1', at });
    if (!q.ok) throw new Error('quote');
    q.value.addLine({ id: 'l1', label: 'Gros œuvre', category: 'labor', qty: 1, unitPriceHT: 148000, vatRate: 10 });
    q.value.setRetenueGarantie(5);
    q.value.assignNumber(DocNumber.format('D', 2026, 1), at);
    q.value.send(at);
    q.value.sign({ signerName: 'Martin', signedAt: at, method: 'remote_link', accepted: true }, at);
    const situation = Invoice.situationFromSignedQuote(q.value, 'inv-1', { order: 1, targetHtCents: 44400 });
    if (!situation.ok) throw new Error('situation');
    const { usecase, invoice } = makeDeps({ invoice: situation.value, customer: makeCustomer(), quote: q.value });
    const r = await usecase.execute({
      invoiceId: 'inv-1',
      terms: { days: 30, endOfMonth: false, label: '30 jours' },
    });
    expect(r.ok).toBe(true);
    expect(invoice().mentions.some((m) => m.includes('71-584'))).toBe(true);
    expect(invoice().totals().retenueGarantieCents).toBe(2442);
    expect(invoice().totals().netToPay).toBe(46398);
  });
  it('gel de rétractation à l’ÉMISSION d’une situation b2c à distance (brouillon dormant)', async () => {
    const at = '2026-06-25T09:00:00.000Z'; // signé 5 jours avant NOW → délai de 14 j en cours
    const q = Quote.compose({ id: 'q-1', companyId: company.id, customerId: 'cus-1', at });
    if (!q.ok) throw new Error('quote');
    q.value.addLine({ id: 'l1', label: 'Travaux', category: 'labor', qty: 1, unitPriceHT: 148000, vatRate: 20 });
    q.value.assignNumber(DocNumber.format('D', 2026, 1), at);
    q.value.send(at);
    q.value.sign(
      { signerName: 'Durand', signedAt: at, method: 'remote_link', accepted: true, customerType: 'b2c' },
      at,
    );
    const situation = Invoice.situationFromSignedQuote(q.value, 'inv-1', { order: 1, targetHtCents: 50000 });
    if (!situation.ok) throw new Error('situation');
    const customer = makeCustomer({ type: 'b2c', siren: undefined });
    const { usecase, allocations } = makeDeps({ invoice: situation.value, customer, quote: q.value });
    const r = await usecase.execute({
      invoiceId: 'inv-1',
      terms: { days: 30, endOfMonth: false, label: '30 jours' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain') {
      expect(r.error.error.code).toBe('RETRACTATION_PERIOD_ACTIVE');
    }
    expect(allocations()).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  ComposeStandaloneInvoice,
  STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE,
} from './compose-standalone-invoice';
import { Invoice } from '../../domain/billing/invoice/invoice';
import { Company, type CompanyProps } from '../../domain/company/company';
import { Customer, type CustomerProps } from '../../domain/customer/customer';
import { type LineInput } from '../../domain/billing/shared/line-item';
import {
  type CompanyRepository,
  type CustomerRepository,
  type InvoiceRepository,
} from '../ports/repositories';

const NOW = '2026-06-01T09:00:00.000Z';

const companyProps: CompanyProps = {
  id: 'co-1',
  name: 'Mercier Plomberie',
  legalForm: 'EI',
  siren: '732829320',
  siret: '73282932000074',
  trade: 'plombier',
  vatRegime: 'reel_simpl',
  rcsOrRm: 'RM 92',
  address: { line1: '12 rue des Artisans', zip: '92000', city: 'Nanterre' },
};

const customerProps: CustomerProps = {
  id: 'cus-1',
  companyId: 'co-1',
  type: 'b2b',
  name: 'Syndic Les Pins',
  siren: '789220118',
  address: { line1: 'Route du Littoral', zip: '83700', city: 'Saint-Raphaël' },
};

/** Surcharges qui acceptent `undefined` pour RETIRER un champ optionnel (ex. siren en b2c). */
type CustomerOver = { [K in keyof CustomerProps]?: CustomerProps[K] | undefined };

function mergeCustomerProps(over: CustomerOver): CustomerProps {
  const merged = { ...customerProps, ...over } as Record<string, unknown>;
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return merged as unknown as CustomerProps;
}

function makeEnv(input: { companyOver?: Partial<CompanyProps>; customerOver?: CustomerOver } = {}) {
  const companyR = Company.of({ ...companyProps, ...input.companyOver });
  if (!companyR.ok) throw new Error('company');
  const company = companyR.value;
  const customerR = Customer.of(mergeCustomerProps(input.customerOver ?? {}));
  if (!customerR.ok) throw new Error('customer');
  const customer = customerR.value;

  const saved: Invoice[] = [];
  const invoices: InvoiceRepository = {
    findById: async (id) => saved.find((i) => i.id === id) ?? null,
    lockById: async (id) => saved.find((i) => i.id === id) ?? null,
    findByParentQuoteId: async () => null,
    findCreditNoteBySourceInvoiceId: async () => null,
    listByCompany: async () => saved,
    save: async (i) => {
      saved.push(i);
    },
    deleteById: async () => {},
  };
  const companies: CompanyRepository = {
    findById: async (id) => (id === company.id ? company : null),
    lockById: async () => company,
    lockForShareById: async () => company,
    list: async () => [company],
    save: async () => {},
  };
  const customers: CustomerRepository = {
    findById: async (id) => (id === customer.id ? customer : null),
    listByCompany: async () => [customer],
    save: async () => {},
  };
  let seq = 0;
  const usecase = new ComposeStandaloneInvoice({
    invoices,
    companies,
    customers,
    ids: { newId: () => `id-${(seq += 1)}` },
    clock: { now: () => NOW, today: () => '2026-06-01' },
  });
  return { usecase, saved };
}

const regie: LineInput[] = [
  { label: 'Régie développement — juin (TJM 600 €)', category: 'labor', qty: 19, unitPriceHT: 60000, vatRate: 20 },
];

describe('ComposeStandaloneInvoice (B1)', () => {
  it('régie TJM × jours pour un pro : brouillon final standalone, totaux exacts', async () => {
    const { usecase, saved } = makeEnv();
    const r = await usecase.execute({ companyId: 'co-1', customerId: 'cus-1', lines: regie });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.totals.ht).toBe(1140000);
      expect(r.value.totals.ttc).toBe(1368000);
    }
    expect(saved).toHaveLength(1);
    expect(saved[0]!.kind).toBe('final');
    expect(saved[0]!.parentQuoteId).toBeNull();
    expect(saved[0]!.status).toBe('draft');
  });
  it('lignes libres multi-taux + remises B3 + remise globale', async () => {
    const { usecase } = makeEnv();
    const r = await usecase.execute({
      companyId: 'co-1',
      customerId: 'cus-1',
      lines: [
        { label: 'Dépannage', category: 'labor', qty: 1, unitPriceHT: 50000, vatRate: 20, discount: { type: 'percent', value: 10 } },
        { label: 'Pièce', category: 'supply', qty: 1, unitPriceHT: 20000, vatRate: 20 },
      ],
      globalDiscount: { type: 'amount', cents: 5000 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.totals.ht).toBe(60000); // 45 000 + 20 000 − 5 000
      expect(r.value.totals.discountCents).toBe(10000);
    }
  });
  it('sans ligne : refus (une facture directe naît avec son contenu)', async () => {
    const { usecase } = makeEnv();
    const r = await usecase.execute({ companyId: 'co-1', customerId: 'cus-1', lines: [] });
    expect(r.ok).toBe(false);
  });
  it('anti-IDOR : client d’un autre tenant → not_found', async () => {
    const { usecase } = makeEnv({ customerOver: { companyId: 'co-AUTRE' } });
    const r = await usecase.execute({ companyId: 'co-1', customerId: 'cus-1', lines: regie });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not_found');
  });
  it('B6 — pro international : émission bloquée, message honnête, rien de sauvé', async () => {
    const { usecase, saved } = makeEnv({ customerOver: { isInternational: true } });
    const r = await usecase.execute({ companyId: 'co-1', customerId: 'cus-1', lines: regie });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain' && r.error.error.code === 'VALIDATION') {
      expect(r.error.error.message).toContain('fiscalement faux');
    }
    expect(saved).toHaveLength(0);
  });
  it('A3bis — b2c SANS urgence : refus fail-closed avec le message source unique', async () => {
    const { usecase, saved } = makeEnv({ customerOver: { type: 'b2c', siren: undefined } });
    const r = await usecase.execute({ companyId: 'co-1', customerId: 'cus-1', lines: regie });
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'domain' && r.error.error.code === 'VALIDATION') {
      expect(r.error.error.message).toBe(STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE);
    }
    expect(saved).toHaveLength(0);
  });
  it('A3bis — b2c AVEC urgence : composée, fait horodaté SERVEUR tracé sur la pièce', async () => {
    const { usecase, saved } = makeEnv({ customerOver: { type: 'b2c', siren: undefined } });
    const r = await usecase.execute({
      companyId: 'co-1',
      customerId: 'cus-1',
      lines: [{ label: 'Dépannage fuite urgente', category: 'labor', qty: 1, unitPriceHT: 18000, vatRate: 10 }],
      context: { housingOlderThan2y: true },
      urgentOnSiteRepair: true,
    });
    expect(r.ok).toBe(true);
    expect(saved[0]!.urgentRepair).toEqual({ requestedAt: NOW });
  });
  it('urgence déclarée sur un PRO : refus (le fait légal serait sans objet)', async () => {
    const { usecase } = makeEnv();
    const r = await usecase.execute({
      companyId: 'co-1',
      customerId: 'cus-1',
      lines: regie,
      urgentOnSiteRepair: true,
    });
    expect(r.ok).toBe(false);
  });
  it('TVA par suggestVatRate : franchise → 0 imposé, taux français refusé', async () => {
    const { usecase } = makeEnv({ companyOver: { vatRegime: 'franchise' } });
    const refused = await usecase.execute({ companyId: 'co-1', customerId: 'cus-1', lines: regie });
    expect(refused.ok).toBe(false);
    const accepted = await usecase.execute({
      companyId: 'co-1',
      customerId: 'cus-1',
      lines: [{ ...regie[0]!, vatRate: 0 }],
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.value.totals.vat).toBe(0);
  });
  it('B9 — débours à 0 % accepté au régime réel, taux > 0 refusé', async () => {
    const { usecase } = makeEnv();
    const ok0 = await usecase.execute({
      companyId: 'co-1',
      customerId: 'cus-1',
      lines: [{ label: 'Débours : pièce avancée pour le client', category: 'disbursement', qty: 1, unitPriceHT: 4500, vatRate: 0 }],
    });
    expect(ok0.ok).toBe(true);
    const refused = await usecase.execute({
      companyId: 'co-1',
      customerId: 'cus-1',
      lines: [{ label: 'Débours', category: 'disbursement', qty: 1, unitPriceHT: 4500, vatRate: 20 }],
    });
    expect(refused.ok).toBe(false);
  });
  it('remise de ligne > base → refus à la frontière (rien de sauvé)', async () => {
    const { usecase, saved } = makeEnv();
    const r = await usecase.execute({
      companyId: 'co-1',
      customerId: 'cus-1',
      lines: [{ ...regie[0]!, discount: { type: 'amount', cents: 99999999 } }],
    });
    expect(r.ok).toBe(false);
    expect(saved).toHaveLength(0);
  });
});

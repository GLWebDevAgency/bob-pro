import { describe, expect, it, vi } from 'vitest';
import type { BackendService } from './backend.service';
import type { RelanceService } from './jobs/relance.service';
import { CustomersController, InvoicesController, QuotesController } from './api.controllers';

/**
 * ÉPIC « facturation terrain » (B1/B2/B3/B4/B5 + canal de facturation) — frontière HTTP :
 * chaque endpoint n'accepte que la FORME attendue (allowlist stricte, 422 sinon) et transmet
 * au backend un input EXACT — jamais un champ client non validé par simple spread.
 */

function invoicesController(overrides: Partial<BackendService> = {}) {
  return new InvoicesController(overrides as BackendService, {} as RelanceService);
}

function quotesController(overrides: Partial<BackendService> = {}) {
  return new QuotesController(overrides as BackendService);
}

const composeBody = {
  customerId: 'cust-1',
  lines: [
    {
      label: 'Dépannage fuite ballon',
      category: 'labor',
      qty: 2,
      unitPriceHT: 6_000,
      vatRate: 10,
    },
  ],
};

describe('POST /invoices — facture directe (B1)', () => {
  it('délègue un corps valide (lignes + remises B3 + urgence A3bis) au backend', async () => {
    const composeStandaloneInvoice = vi.fn(async () => ({
      ok: true as const,
      value: { invoiceId: 'inv-1', totals: { ht: 12_000, vat: 1_200, ttc: 13_200, netToPay: 13_200, vatByRate: { '10': 1_200 } } },
    }));
    const controller = invoicesController({ composeStandaloneInvoice } as never);
    const body = {
      ...composeBody,
      lines: [
        { ...composeBody.lines[0], discount: { type: 'percent', value: 10 } },
      ],
      globalDiscount: { type: 'amount', cents: 500 },
      urgentOnSiteRepair: true,
    };
    await expect(controller.compose(body)).resolves.toMatchObject({ invoiceId: 'inv-1' });
    expect(composeStandaloneInvoice).toHaveBeenCalledWith({
      customerId: 'cust-1',
      lines: [
        {
          label: 'Dépannage fuite ballon',
          category: 'labor',
          qty: 2,
          unitPriceHT: 6_000,
          vatRate: 10,
          discount: { type: 'percent', value: 10 },
        },
      ],
      globalDiscount: { type: 'amount', cents: 500 },
      urgentOnSiteRepair: true,
    });
  });

  it('refuse un champ inconnu au niveau racine (422, backend jamais appelé)', async () => {
    const composeStandaloneInvoice = vi.fn();
    const controller = invoicesController({ composeStandaloneInvoice } as never);
    await expect(controller.compose({ ...composeBody, mode: 'final' })).rejects.toMatchObject({
      status: 422,
    });
    expect(composeStandaloneInvoice).not.toHaveBeenCalled();
  });

  it('refuse un tableau de lignes vide (une facture directe facture quelque chose)', async () => {
    const controller = invoicesController({ composeStandaloneInvoice: vi.fn() } as never);
    await expect(controller.compose({ ...composeBody, lines: [] })).rejects.toMatchObject({
      status: 422,
    });
  });

  it('refuse une remise difforme (percent + cents mélangés)', async () => {
    const controller = invoicesController({ composeStandaloneInvoice: vi.fn() } as never);
    await expect(
      controller.compose({
        ...composeBody,
        globalDiscount: { type: 'percent', value: 10, cents: 500 },
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuse une qualification d’urgence non booléenne (jamais par truthiness)', async () => {
    const controller = invoicesController({ composeStandaloneInvoice: vi.fn() } as never);
    await expect(
      controller.compose({ ...composeBody, urgentOnSiteRepair: 'oui' }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('n’envoie PAS urgentOnSiteRepair quand false (le fait n’existe pas)', async () => {
    const composeStandaloneInvoice = vi.fn(async () => ({
      ok: true as const,
      value: { invoiceId: 'inv-1', totals: { ht: 0, vat: 0, ttc: 0, netToPay: 0, vatByRate: {} } },
    }));
    const controller = invoicesController({ composeStandaloneInvoice } as never);
    await controller.compose({ ...composeBody, urgentOnSiteRepair: false });
    expect(composeStandaloneInvoice).toHaveBeenCalledWith(
      expect.not.objectContaining({ urgentOnSiteRepair: expect.anything() }),
    );
  });
});

describe('POST /quotes/:id/invoice — mode situation (B2)', () => {
  it('transmet le mode situation avec son avancement en %', async () => {
    const generateInvoice = vi.fn(async () => ({ ok: true as const, value: { invoiceId: 'inv-s1' } }));
    const controller = quotesController({ generateInvoice } as never);
    await expect(
      controller.invoice('q-1', { mode: 'situation', situation: { percent: 30 } }),
    ).resolves.toEqual({ invoiceId: 'inv-s1' });
    expect(generateInvoice).toHaveBeenCalledWith({
      quoteId: 'q-1',
      mode: 'situation',
      situation: { percent: 30 },
    });
  });

  it('transmet le mode situation avec son montant HT en centimes', async () => {
    const generateInvoice = vi.fn(async () => ({ ok: true as const, value: { invoiceId: 'inv-s2' } }));
    const controller = quotesController({ generateInvoice } as never);
    await controller.invoice('q-1', { mode: 'situation', situation: { amountHtCents: 250_000 } });
    expect(generateInvoice).toHaveBeenCalledWith({
      quoteId: 'q-1',
      mode: 'situation',
      situation: { amountHtCents: 250_000 },
    });
  });

  it('refuse les deux formes mélangées ({ percent, amountHtCents })', async () => {
    const generateInvoice = vi.fn();
    const controller = quotesController({ generateInvoice } as never);
    await expect(
      controller.invoice('q-1', { mode: 'situation', situation: { percent: 30, amountHtCents: 1 } }),
    ).rejects.toMatchObject({ status: 422 });
    expect(generateInvoice).not.toHaveBeenCalled();
  });

  it('refuse un objet situation sans forme reconnue', async () => {
    const controller = quotesController({ generateInvoice: vi.fn() } as never);
    await expect(
      controller.invoice('q-1', { mode: 'situation', situation: {} }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('reste compatible : deposit/final inchangés (aucun champ situation requis)', async () => {
    const generateInvoice = vi.fn(async () => ({ ok: true as const, value: { invoiceId: 'inv-d' } }));
    const controller = quotesController({ generateInvoice } as never);
    await controller.invoice('q-1', { mode: 'deposit' });
    expect(generateInvoice).toHaveBeenCalledWith({ quoteId: 'q-1', mode: 'deposit' });
  });
});

describe('PATCH /invoices/:id/transmission — suivi manuel', () => {
  it('transmet dépôt + acceptation (dates AAAA-MM-JJ)', async () => {
    const recordInvoiceTransmission = vi.fn(async () => ({
      ok: true as const,
      value: { transmission: { depositedAt: '2026-07-20', acceptedAt: null } },
    }));
    const controller = invoicesController({ recordInvoiceTransmission } as never);
    await expect(
      controller.recordTransmission('inv-1', { depositedAt: '2026-07-20' }),
    ).resolves.toEqual({ transmission: { depositedAt: '2026-07-20', acceptedAt: null } });
    expect(recordInvoiceTransmission).toHaveBeenCalledWith({
      invoiceId: 'inv-1',
      depositedAt: '2026-07-20',
    });
  });

  it('null EXPLICITE = effacement (correction honnête), transmis tel quel', async () => {
    const recordInvoiceTransmission = vi.fn(async () => ({
      ok: true as const,
      value: { transmission: null },
    }));
    const controller = invoicesController({ recordInvoiceTransmission } as never);
    await controller.recordTransmission('inv-1', { depositedAt: null, acceptedAt: null });
    expect(recordInvoiceTransmission).toHaveBeenCalledWith({
      invoiceId: 'inv-1',
      depositedAt: null,
      acceptedAt: null,
    });
  });

  it('refuse un corps vide (aucun champ = aucune intention)', async () => {
    const controller = invoicesController({ recordInvoiceTransmission: vi.fn() } as never);
    await expect(controller.recordTransmission('inv-1', {})).rejects.toMatchObject({ status: 422 });
  });

  it('refuse une date difforme', async () => {
    const controller = invoicesController({ recordInvoiceTransmission: vi.fn() } as never);
    await expect(
      controller.recordTransmission('inv-1', { depositedAt: '20/07/2026' }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('Customers — conditions de paiement (B4) et canal de facturation', () => {
  const valid = {
    name: 'SARL Provence Rénov',
    type: 'b2b' as const,
    address: { line1: '4 rue Basse', zip: '92310', city: 'Sèvres' },
  };

  function customersController(overrides: Partial<BackendService> = {}) {
    return new CustomersController(overrides as BackendService);
  }

  it('transmet paymentTerms ({ days, endOfMonth, label }) et billingChannel chorus', async () => {
    const createCustomer = vi.fn(async () => ({ ok: true as const, value: { id: 'c-1' } }));
    const controller = customersController({ createCustomer } as never);
    const body = {
      ...valid,
      paymentTerms: { days: 45, endOfMonth: true, label: '45 jours fin de mois' },
      billingChannel: { type: 'chorus', chorusServiceCode: 'SERV-123' },
    };
    await expect(controller.create(body)).resolves.toEqual({ id: 'c-1' });
    expect(createCustomer).toHaveBeenCalledWith(body);
  });

  it('null = retour au défaut (champ ABSENT côté domaine, jamais un null propagé)', async () => {
    const updateCustomer = vi.fn(async () => ({ ok: true as const, value: { id: 'c-1' } }));
    const controller = customersController({ updateCustomer } as never);
    await controller.update('c-1', { ...valid, paymentTerms: null, billingChannel: null });
    expect(updateCustomer).toHaveBeenCalledWith('c-1', valid);
  });

  it('refuse des conditions de paiement difformes (days non entier)', async () => {
    const controller = customersController({ createCustomer: vi.fn() } as never);
    await expect(
      controller.create({ ...valid, paymentTerms: { days: '45', endOfMonth: false, label: 'x' } }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('refuse un canal de facturation avec champ inconnu', async () => {
    const controller = customersController({ createCustomer: vi.fn() } as never);
    await expect(
      controller.create({ ...valid, billingChannel: { type: 'portail', apiKey: 'x' } }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

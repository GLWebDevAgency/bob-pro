import { describe, expect, it, vi } from 'vitest';
import {
  Chantier,
  Customer,
  Equipment,
  type OcrPort,
  type PaymentGatewayPort,
  type PdfRendererPort,
} from '@bob/core';
import { seedCompany } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

/**
 * PR-12b — câblage serveur des contrats de maintenance : mêmes use cases que le mobile et la
 * voix (parité §2.7), faits DÉRIVÉS servis par la vue (période arithmétique, couverture,
 * renouvellement), avertissement contrat RÉEL au retrait d'équipement (exigence du train :
 * fini le contractWarning=null), brouillon annuel portant contrat + période + 'subscription'.
 */
function makeService() {
  const p = new InMemoryPersistence();
  const admin: SupabaseAdminPort = {
    setUserCompanyId: async () => undefined,
    deleteUser: async () => undefined,
  } as SupabaseAdminPort;
  const audit = vi.fn();
  const logger = {
    audit,
    error: () => undefined,
    warn: () => undefined,
    log: () => undefined,
  } as unknown as AppLogger;
  const service = new BackendService(
    p,
    {} as PaymentGatewayPort,
    {} as PdfRendererPort,
    {} as OcrPort,
    admin,
    {} as NotificationDeliveryService,
    {} as Metrics,
    logger,
  );
  return { service, p, audit };
}

function asPrincipal<T>(principal: Principal, fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ correlationId: 'test', principal }, fn);
}

async function seedTenant(p: InMemoryPersistence): Promise<string> {
  const company = seedCompany();
  await p.companies.save(company);
  await p.subscriptions.save({
    id: `sub-${company.id}`,
    companyId: company.id,
    plan: 'solo',
    status: 'active',
    trialEndsAt: null,
    currentPeriodEnd: '2099-01-01T00:00:00.000Z',
    store: null,
    storeRef: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  return company.id;
}

async function seedCustomer(
  p: InMemoryPersistence,
  companyId: string,
  id: string,
  type: 'b2c' | 'b2b' | 'b2g',
): Promise<void> {
  const customer = Customer.of({
    id,
    companyId,
    type,
    name: type === 'b2c' ? 'Mme Girard' : 'RATP CAP',
    ...(type === 'b2c' ? {} : { siren: '789220118' }),
    address: { line1: '1 rue du Dépôt', zip: '75012', city: 'Paris' },
  });
  if (!customer.ok) throw new Error('customer fixture');
  await p.customers.save(customer.value);
}

async function seedSiteWithEquipment(
  p: InMemoryPersistence,
  companyId: string,
): Promise<void> {
  await p.chantiers.save(
    Chantier.rehydrate({
      id: 'site-bastille',
      companyId,
      name: 'RATP CAP Bastille',
      customerId: null,
      address: null,
      notes: null,
      status: 'open',
      openedAt: '2026-07-01',
    }),
  );
  await p.equipments.save(
    Equipment.rehydrate({
      id: 'equip-fontaine',
      companyId,
      chantierId: 'site-bastille',
      label: 'Fontaine accueil R+2',
      kind: 'Fontaine réseau',
      brand: null,
      serialNumber: null,
      location: null,
      installedAt: null,
      warrantyUntil: null,
      status: 'active',
      retiredAt: null,
      notes: null,
      revision: 1,
    }),
  );
}

describe('contrats de maintenance — service (PR-12b)', () => {
  it('créer (b2g) → activer → vue dérivée → brouillon annuel portant contrat/période/subscription', async () => {
    const { service, p, audit } = makeService();
    const companyId = await seedTenant(p);
    await seedCustomer(p, companyId, 'cus-ratp', 'b2g');
    await seedSiteWithEquipment(p, companyId);
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);

    const created = await run(() =>
      service.createMaintenanceContract({
        customerId: 'cus-ratp',
        label: 'Entretien fontaines 2026',
        chantierId: 'site-bastille',
        anniversaryDate: '2025-10-12',
        lines: [{ label: 'Forfait entretien annuel', quantity: 2, unitPriceHtCents: 80_000, vatRate: 20 }],
        equipmentIds: ['equip-fontaine'],
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const contractId = created.value.id;

    const activated = await run(() =>
      service.activateMaintenanceContract({ contractId, expectedRevision: 1 }),
    );
    expect(activated.ok).toBe(true);

    const listed = await run(() => service.listMaintenanceContracts());
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
    const view = listed.value[0]!;
    expect(view.customerName).toBe('RATP CAP');
    expect(view.chantierNom).toBe('RATP CAP Bastille');
    expect(view.annualTotals.ht).toBe(160_000);
    expect(view.currentPeriod).not.toBeNull();
    // Aucune facture : la période courante est DUE (dérivation, jamais un statut stocké).
    expect(view.billingDue).not.toBeNull();

    const prepared = await run(() => service.prepareContractAnnualInvoice(contractId));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const invoice = await p.invoices.findById(prepared.value.invoiceId);
    expect(invoice!.maintenanceContractId).toBe(contractId);
    expect(invoice!.servicePeriod).toEqual(prepared.value.servicePeriod);
    expect(invoice!.lines.every((line) => line.category === 'subscription')).toBe(true);
    expect(invoice!.chantierId).toBe('site-bastille');
    expect(audit).toHaveBeenCalledWith(
      'maintenance_contract.annual_invoice_prepared',
      expect.objectContaining({ contractId }),
    );
  });

  it('[écrans §6.5] la période du brouillon annuel est ÉDITABLE (bloc Contrat de la facture) — et refusée hors contrat', async () => {
    const { service, p, audit } = makeService();
    const companyId = await seedTenant(p);
    await seedCustomer(p, companyId, 'cus-ratp', 'b2g');
    await seedSiteWithEquipment(p, companyId);
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);
    const created = await run(() =>
      service.createMaintenanceContract({
        customerId: 'cus-ratp',
        label: 'Entretien fontaines 2026',
        chantierId: 'site-bastille',
        anniversaryDate: '2025-10-12',
        lines: [{ label: 'Forfait', quantity: 1, unitPriceHtCents: 40_000, vatRate: 20 }],
      }),
    );
    if (!created.ok) throw new Error('create');
    await run(() =>
      service.activateMaintenanceContract({ contractId: created.value.id, expectedRevision: 1 }),
    );
    const prepared = await run(() => service.prepareContractAnnualInvoice(created.value.id));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    // Édition en BROUILLON : le geste que la garde d'émission indique (« modifie le
    // brouillon, jamais l'émission ») existe et écrit les colonnes AUTORITÉ.
    const updated = await run(() =>
      service.updateInvoiceServicePeriod({
        invoiceId: prepared.value.invoiceId,
        expectedRevision: 1,
        servicePeriod: { start: '2025-11-01', end: '2026-10-31' },
      }),
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.servicePeriod).toEqual({ start: '2025-11-01', end: '2026-10-31' });
    const stored = await p.invoices.findById(prepared.value.invoiceId);
    expect(stored!.servicePeriod).toEqual({ start: '2025-11-01', end: '2026-10-31' });
    expect(audit).toHaveBeenCalledWith(
      'invoice.service_period_updated',
      expect.objectContaining({ invoiceId: prepared.value.invoiceId }),
    );

    // Une facture SANS contrat garde son comportement historique (période A7 à l'émission).
    const standalone = await run(() =>
      service.composeStandaloneInvoice({
        customerId: 'cus-ratp',
        lines: [{ label: 'Dépannage', category: 'labor', qty: 1, unitPriceHT: 20_000, vatRate: 20 }],
      }),
    );
    if (!standalone.ok) throw new Error('compose');
    const refused = await run(() =>
      service.updateInvoiceServicePeriod({
        invoiceId: standalone.value.invoiceId,
        expectedRevision: 1,
        servicePeriod: { start: '2025-11-01', end: '2026-10-31' },
      }),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(JSON.stringify(refused.error)).toContain('n’est pas liée à un contrat');
  });

  it('[direction 5] client b2c : refus Chatel à la création (parité écran/voix)', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedCustomer(p, companyId, 'cus-girard', 'b2c');
    const refused = await asPrincipal({ userId: 'u-1', companyId }, () =>
      service.createMaintenanceContract({
        customerId: 'cus-girard',
        label: 'Contrat particulier',
        anniversaryDate: '2026-01-01',
      }),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(JSON.stringify(refused.error)).toContain('L215-1');
  });

  it('[amélioration 4] l’avertissement contrat au retrait d’équipement devient RÉEL — et se lit AVANT la confirmation', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedCustomer(p, companyId, 'cus-ratp', 'b2g');
    await seedSiteWithEquipment(p, companyId);
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);
    const created = await run(() =>
      service.createMaintenanceContract({
        customerId: 'cus-ratp',
        label: 'Entretien fontaines 2026',
        chantierId: 'site-bastille',
        anniversaryDate: '2025-10-12',
        lines: [{ label: 'Forfait', quantity: 1, unitPriceHtCents: 40_000, vatRate: 20 }],
        equipmentIds: ['equip-fontaine'],
      }),
    );
    if (!created.ok) throw new Error('create');
    await run(() =>
      service.activateMaintenanceContract({ contractId: created.value.id, expectedRevision: 1 }),
    );

    // AVANT la confirmation : la ConfirmSheet (et la voix) lisent la couverture réelle.
    const coverage = await run(() => service.equipmentContractCoverage('equip-fontaine'));
    expect(coverage.ok).toBe(true);
    if (coverage.ok) expect(coverage.value.activeContractLabels).toEqual(['Entretien fontaines 2026']);

    // Le retrait reste POSSIBLE (la réalité du terrain prime) — l'avertissement traverse.
    const retired = await run(() =>
      service.retireEquipment({ equipmentId: 'equip-fontaine', expectedRevision: 1 }),
    );
    expect(retired.ok).toBe(true);
    if (retired.ok) {
      expect(retired.value.contractWarning).toContain('Entretien fontaines 2026');
      expect(retired.value.equipment.status).toBe('retired');
    }
    // Équipement d'un autre tenant : couverture introuvable (anti-IDOR).
    const foreign = await asPrincipal({ userId: 'u-2', companyId: 'company-autre' }, () =>
      service.equipmentContractCoverage('equip-fontaine'),
    );
    expect(foreign.ok).toBe(false);
  });

  it('résiliation : date d’effet par défaut = prochain anniversaire calculé ; suppression réservée au brouillon', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedCustomer(p, companyId, 'cus-ratp', 'b2g');
    const run = <T,>(fn: () => Promise<T>) => asPrincipal({ userId: 'u-1', companyId }, fn);
    const created = await run(() =>
      service.createMaintenanceContract({
        customerId: 'cus-ratp',
        label: 'Entretien 2026',
        anniversaryDate: '2025-10-12',
        lines: [{ label: 'Forfait', quantity: 1, unitPriceHtCents: 40_000, vatRate: 20 }],
      }),
    );
    if (!created.ok) throw new Error('create');
    await run(() =>
      service.activateMaintenanceContract({ contractId: created.value.id, expectedRevision: 1 }),
    );
    const deleteActive = await run(() =>
      service.deleteDraftMaintenanceContract({ contractId: created.value.id, expectedRevision: 2 }),
    );
    expect(deleteActive.ok).toBe(false);
    const terminated = await run(() =>
      service.terminateMaintenanceContract({
        contractId: created.value.id,
        expectedRevision: 2,
        note: 'Marché perdu — résiliation reçue.',
      }),
    );
    expect(terminated.ok).toBe(true);
    if (!terminated.ok) return;
    expect(terminated.value.status).toBe('terminated');
    expect(terminated.value.terminationEffectiveDate).not.toBeNull();
    // La vue d'un résilié : plus aucune facture annuelle due, alerte éteinte.
    const view = await run(() => service.getMaintenanceContract(created.value.id));
    expect(view.ok).toBe(true);
    if (view.ok) {
      expect(view.value.billingDue).toBeNull();
      expect(view.value.renewalAlert).toBeNull();
      expect(view.value.lifecycle.terminatedCoverage).not.toBeNull();
    }
  });
});

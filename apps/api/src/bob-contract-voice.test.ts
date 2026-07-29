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
import { BobAgent, ModelRouter, type BobActions } from '@bob/ai';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

/**
 * PR-12c §2.7 — INTÉGRATION vocale des GESTES de contrat (patron bob-*-voice) : l'agent branché
 * sur les VRAIES actions hôte (buildBobActions → BackendService → use cases @bob/core). Preuve
 * de bout en bout que la voix et l'écran passent par le MÊME chemin : « fais-moi le contrat … »
 * crée un contrat RÉEL en brouillon (jamais activé au passage), « active le contrat » l'active,
 * « le client résilie au … » le résilie avec sa trace, et le refus Chatel d'un particulier
 * traverse la voix VERBATIM sans rien créer.
 */
function makeService() {
  const p = new InMemoryPersistence();
  const service = new BackendService(
    p,
    {} as PaymentGatewayPort,
    {} as PdfRendererPort,
    {} as OcrPort,
    {
      setUserCompanyId: async () => undefined,
      deleteUser: async () => undefined,
    } as SupabaseAdminPort,
    {} as NotificationDeliveryService,
    {} as Metrics,
    { audit: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() } as unknown as AppLogger,
  );
  return { service, p };
}

function makeAgent(service: BackendService): BobAgent {
  const actions = (service as unknown as { buildBobActions(): BobActions }).buildBobActions();
  return new BobAgent({
    router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
    actions,
    runtime: {
      clock: { now: () => '2026-07-28T10:00:00.000Z' },
      ids: { newId: () => 'run-contract-voice' },
    },
  });
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
  name: string,
  type: 'b2c' | 'b2b' | 'b2g',
): Promise<void> {
  const customer = Customer.of({
    id,
    companyId,
    type,
    name,
    ...(type === 'b2c' ? {} : { siren: '789220118' }),
    address: { line1: '1 rue du Dépôt', zip: '75012', city: 'Paris' },
  });
  if (!customer.ok) throw new Error('client de scénario invalide');
  await p.customers.save(customer.value);
}

async function seedSiteWithFountains(p: InMemoryPersistence, companyId: string): Promise<void> {
  await p.chantiers.save(
    Chantier.rehydrate({
      id: 'site-bastille',
      companyId,
      name: 'Bastille',
      customerId: null,
      address: null,
      notes: null,
      status: 'open',
      openedAt: '2026-07-01',
    }),
  );
  for (const [id, label] of [
    ['equip-fontaine-a', 'Fontaine quai A'],
    ['equip-fontaine-b', 'Fontaine quai B'],
  ] as const) {
    await p.equipments.save(
      Equipment.rehydrate({
        id,
        companyId,
        chantierId: 'site-bastille',
        label,
        kind: null,
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
}

describe('voix ↔ serveur — gestes de contrat de bout en bout (§2.7)', () => {
  it('« fais-moi le contrat … » : proposition → confirmation → contrat RÉEL en BROUILLON, lignes et équipements posés', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedCustomer(p, companyId, 'cus-ratp', 'RATP CAP', 'b2g');
    await seedSiteWithFountains(p, companyId);
    const principal: Principal = { userId: 'u-1', companyId };
    const agent = makeAgent(service);

    const proposed = await asPrincipal(principal, () =>
      agent.ask(
        'Fais-moi le contrat « Fontaines RATP » pour RATP CAP sur le site Bastille, 2 fontaines, 1 200 € par an, ça démarre au 1er octobre, 2 passages',
      ),
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok || !proposed.value.pending) throw new Error('proposition attendue');
    expect(proposed.value.kind).toBe('proposed');
    // Rien n'est créé avant la confirmation (plancher de sécurité).
    expect(await p.maintenanceContracts.listByCompany(companyId)).toHaveLength(0);

    const confirmed = await asPrincipal(principal, () => agent.confirm(proposed.value.pending!));
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.kind).toBe('done');

    const contracts = await p.maintenanceContracts.listByCompany(companyId);
    expect(contracts).toHaveLength(1);
    const props = contracts[0]!.toProps();
    // Le geste crée un BROUILLON — l'activation reste un second geste (jamais fusionné).
    expect(props.status).toBe('draft');
    expect(props.customerId).toBe('cus-ratp');
    expect(props.chantierId).toBe('site-bastille');
    expect(props.label).toBe('Fontaines RATP');
    expect(props.anniversaryDate).toBe('2026-10-01');
    expect(props.visitsPerYear).toBe(2);
    // Le montant à MILLIERS est porté ENTIER dans la ligne du contrat (1 200 €, pas 200 €).
    expect(props.lines).toHaveLength(1);
    expect(props.lines[0]!.unitPriceHtCents).toBe(120_000);
    expect([...props.equipmentIds].sort()).toEqual(['equip-fontaine-a', 'equip-fontaine-b']);
  });

  it('« active le contrat » puis « le client résilie au … » : mêmes use cases que la fiche, trace posée', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedCustomer(p, companyId, 'cus-ratp', 'RATP CAP', 'b2g');
    const principal: Principal = { userId: 'u-1', companyId };
    const run = <T,>(fn: () => Promise<T>) => asPrincipal(principal, fn);
    const created = await run(() =>
      service.createMaintenanceContract({
        customerId: 'cus-ratp',
        label: 'Entretien fontaines',
        anniversaryDate: '2026-10-01',
        lines: [{ label: 'Forfait', quantity: 1, unitPriceHtCents: 120_000, vatRate: 20 }],
      }),
    );
    if (!created.ok) throw new Error('contrat de scénario');
    const agent = makeAgent(service);

    const proposedActivation = await run(() => agent.ask('Active le contrat'));
    expect(proposedActivation.ok).toBe(true);
    if (!proposedActivation.ok || !proposedActivation.value.pending) throw new Error('proposition');
    expect(proposedActivation.value.kind).toBe('proposed');
    const activated = await run(() => agent.confirm(proposedActivation.value.pending!));
    expect(activated.ok).toBe(true);
    const afterActivation = await p.maintenanceContracts.findById(companyId, created.value.id);
    expect(afterActivation!.status).toBe('active');

    // La phrase canonique dit QUAND, jamais POURQUOI : le motif est la TRACE LÉGALE de la
    // rupture, Bob le DEMANDE plutôt que d'inscrire l'ordre reçu en motivation.
    const askedForNote = await run(() => agent.ask('Le client résilie au 1er décembre'));
    expect(askedForNote.ok).toBe(true);
    if (!askedForNote.ok) throw new Error('question du motif');
    expect(askedForNote.value.kind).toBe('answer');
    expect(askedForNote.value.pending).toBeUndefined();
    expect(askedForNote.value.card.title).toContain('Pourquoi cette résiliation');
    expect((await p.maintenanceContracts.findById(companyId, created.value.id))!.status).toBe(
      'active',
    );

    const proposedTermination = await run(() =>
      agent.ask(
        `Résilie le contrat ${created.value.id} au 01/12/2026 — motif : le client déménage`,
      ),
    );
    expect(proposedTermination.ok).toBe(true);
    if (!proposedTermination.ok || !proposedTermination.value.pending) throw new Error('proposition');
    // Le préavis est DIT au point de décision — jamais bloquant.
    expect(proposedTermination.value.card.body).toContain('Préavis contractuel');
    const terminated = await run(() => agent.confirm(proposedTermination.value.pending!));
    expect(terminated.ok).toBe(true);
    if (!terminated.ok) return;
    expect(terminated.value.kind).toBe('done');
    const afterTermination = (await p.maintenanceContracts.findById(companyId, created.value.id))!;
    expect(afterTermination.status).toBe('terminated');
    const finalProps = afterTermination.toProps();
    expect(finalProps.terminationEffectiveDate).toBe('2026-12-01');
    // Seul le MOTIF ÉNONCÉ fait la trace — jamais la phrase de commande.
    expect(finalProps.terminationNote).toBe('le client déménage');
  });

  it('client PARTICULIER : le refus Chatel du DOMAINE traverse la voix VERBATIM, rien n’est créé', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedCustomer(p, companyId, 'cus-girard', 'Mme Girard', 'b2c');
    const principal: Principal = { userId: 'u-1', companyId };
    const agent = makeAgent(service);

    const r = await asPrincipal(principal, () =>
      agent.ask(
        'Crée le contrat « Entretien chaudière » pour Girard à 300 € par an, à partir du 01/10/2026',
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.card.body).toContain('loi Chatel');
    expect(r.value.card.body).toContain('devis signé annuel');
    expect(await p.maintenanceContracts.listByCompany(companyId)).toHaveLength(0);
  });
});

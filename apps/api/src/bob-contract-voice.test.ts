import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(() => {
  // askBob construit son runtime seulement si un fournisseur est configuré. On pose donc une
  // identité OpenAI de TEST, puis on double explicitement son transport : aucune résolution DNS,
  // aucun appel cloud, aucun timeout variable. Le 503 immédiat exerce le repli déterministe réel.
  vi.stubEnv('OPENAI_API_KEY', 'test-only-never-sent');
  vi.stubEnv('OPENAI_URL', 'https://openai.invalid.test/v1');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      if (String(url) !== 'https://openai.invalid.test/v1/chat/completions') {
        throw new Error(`unexpected_test_network:${String(url)}`);
      }
      return new Response('{"error":"provider intentionally unavailable in test"}', {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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
  const audit = vi.fn();
  const logger = {
    audit,
    error: vi.fn(),
    warn: vi.fn(),
    log: vi.fn(),
  } as unknown as AppLogger;
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
    {
      setUserCompanyId: async () => undefined,
      deleteUser: async () => undefined,
    } as SupabaseAdminPort,
    {} as NotificationDeliveryService,
    metrics,
    logger,
  );
  return { service, p, audit };
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

describe('voix ↔ serveur — CAS opaque activation/résiliation', () => {
  it('activation périmée : proposition consommée sans écriture, puis reprise scellée à N+1', async () => {
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

    const proposed = await run(() => service.askBob('Active le contrat'));
    expect(proposed.ok).toBe(true);
    if (!proposed.ok || proposed.value.kind !== 'proposed' || !proposed.value.pending) {
      throw new Error('proposition opaque attendue');
    }
    expect(proposed.value.pending.args).toMatchObject({ expectedRevision: 1 });

    const concurrent = await run(() =>
      service.updateMaintenanceContract({
        contractId: created.value.id,
        expectedRevision: 1,
        patch: { label: 'Entretien fontaines — équipe B' },
      }),
    );
    expect(concurrent.ok).toBe(true);

    const stale = await run(() =>
      service.confirmBob({ proposalId: proposed.value.pending?.proposalId }),
    );
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.value.kind).toBe('answer');
    expect(stale.value.card.body).toContain('Entretien fontaines — équipe B');
    expect(stale.value.card.body).toContain('Rien n’a été écrasé');
    expect((await p.maintenanceContracts.findById(companyId, created.value.id))!.toProps())
      .toMatchObject({ revision: 2, status: 'draft' });

    // Opaque = usage unique : l'ancienne décision est réellement consommée.
    const replay = await run(() =>
      service.confirmBob({ proposalId: proposed.value.pending?.proposalId }),
    );
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error).toMatchObject({ kind: 'validation' });

    const retryCommand = stale.value.choices?.[0]?.value;
    expect(retryCommand).toContain(`Active le contrat ${created.value.id}`);
    const reproposed = await run(() => service.askBob(retryCommand!));
    expect(reproposed.ok).toBe(true);
    if (!reproposed.ok || reproposed.value.kind !== 'proposed' || !reproposed.value.pending) {
      throw new Error('nouvelle proposition opaque attendue');
    }
    expect(reproposed.value.pending.args).toMatchObject({ expectedRevision: 2 });

    const done = await run(() =>
      service.confirmBob({ proposalId: reproposed.value.pending?.proposalId }),
    );
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.kind).toBe('done');
    expect((await p.maintenanceContracts.findById(companyId, created.value.id))!.toProps())
      .toMatchObject({ revision: 3, status: 'active' });
  });

  it('résiliation périmée : date et motif survivent, nouvelle confirmation scellée à N+1', async () => {
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
    const activated = await run(() =>
      service.activateMaintenanceContract({
        contractId: created.value.id,
        expectedRevision: 1,
      }),
    );
    if (!activated.ok) throw new Error('activation du scénario');

    const proposed = await run(() =>
      service.askBob(
        `Résilie le contrat ${created.value.id} au 01/12/2026 — motif : le client déménage`,
      ),
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok || proposed.value.kind !== 'proposed' || !proposed.value.pending) {
      throw new Error('proposition opaque attendue');
    }
    expect(proposed.value.pending.args).toMatchObject({
      expectedRevision: 2,
      effectiveDate: '2026-12-01',
      note: 'le client déménage',
    });

    const concurrent = await run(() =>
      service.updateMaintenanceContract({
        contractId: created.value.id,
        expectedRevision: 2,
        patch: { label: 'Entretien fontaines — équipe B' },
      }),
    );
    expect(concurrent.ok).toBe(true);

    const stale = await run(() =>
      service.confirmBob({ proposalId: proposed.value.pending?.proposalId }),
    );
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.value.kind).toBe('answer');
    expect(stale.value.card.body).toContain('Entretien fontaines — équipe B');
    expect(stale.value.card.body).toContain('Rien n’a été écrasé');
    expect((await p.maintenanceContracts.findById(companyId, created.value.id))!.toProps())
      .toMatchObject({ revision: 3, status: 'active' });

    const replay = await run(() =>
      service.confirmBob({ proposalId: proposed.value.pending?.proposalId }),
    );
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error).toMatchObject({ kind: 'validation' });

    const retryCommand = stale.value.choices?.[0]?.value;
    expect(retryCommand).toContain(`${created.value.id} au 2026-12-01`);
    expect(retryCommand).toContain('motif : le client déménage');
    const reproposed = await run(() => service.askBob(retryCommand!));
    expect(reproposed.ok).toBe(true);
    if (!reproposed.ok || reproposed.value.kind !== 'proposed' || !reproposed.value.pending) {
      throw new Error('nouvelle proposition opaque attendue');
    }
    expect(reproposed.value.pending.args).toMatchObject({
      expectedRevision: 3,
      effectiveDate: '2026-12-01',
      note: 'le client déménage',
    });

    const done = await run(() =>
      service.confirmBob({ proposalId: reproposed.value.pending?.proposalId }),
    );
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.kind).toBe('done');
    expect((await p.maintenanceContracts.findById(companyId, created.value.id))!.toProps())
      .toMatchObject({
        revision: 4,
        status: 'terminated',
        terminationEffectiveDate: '2026-12-01',
        terminationNote: 'le client déménage',
      });
  });
});

/**
 * §2.7 — RENOMMER : le geste que la garde du libellé PROMET (« un nom de contrat imparfait DANS
 * L'APPLICATION se corrige d'un tap sur la fiche »). Ce test prouve que la voix emprunte le MÊME
 * use case UpdateMaintenanceContract que ce tap, que la RÉVISION lue à la proposition reste
 * scellée jusqu'au consentement, et qu'un patch d'un seul champ ne réécrit rien d'autre —
 * lignes, équipements et conditions restent intacts.
 */
describe('voix ↔ serveur — renommer un contrat (§2.7)', () => {
  it('même nom normalisé : succès idempotent, sans sauvegarde visible ni faux audit', async () => {
    const { service, p, audit } = makeService();
    const companyId = await seedTenant(p);
    await seedCustomer(p, companyId, 'cus-ratp', 'RATP CAP', 'b2g');
    const principal: Principal = { userId: 'u-1', companyId };
    const run = <T,>(fn: () => Promise<T>) => asPrincipal(principal, fn);
    const created = await run(() =>
      service.createMaintenanceContract({
        customerId: 'cus-ratp',
        label: 'Entretien fontaines',
        anniversaryDate: '2026-10-01',
      }),
    );
    if (!created.ok) throw new Error('contrat de scénario');
    audit.mockClear();

    const unchanged = await run(() =>
      service.updateMaintenanceContract({
        contractId: created.value.id,
        expectedRevision: 1,
        patch: { label: '  Entretien fontaines  ' },
      }),
    );
    expect(unchanged.ok).toBe(true);
    if (!unchanged.ok) return;
    expect(unchanged.value).toMatchObject({ label: 'Entretien fontaines', revision: 1 });
    expect((await p.maintenanceContracts.findById(companyId, created.value.id))?.revision).toBe(1);
    expect(audit).not.toHaveBeenCalled();
  });

  it('« renomme le contrat … » : confirmation, puis nom RÉEL changé sans toucher au reste', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedCustomer(p, companyId, 'cus-ratp', 'RATP CAP', 'b2g');
    await seedSiteWithFountains(p, companyId);
    const principal: Principal = { userId: 'u-1', companyId };
    const run = <T,>(fn: () => Promise<T>) => asPrincipal(principal, fn);
    const created = await run(() =>
      service.createMaintenanceContract({
        customerId: 'cus-ratp',
        label: 'Entretien fontaines',
        chantierId: 'site-bastille',
        anniversaryDate: '2026-10-01',
        visitsPerYear: 3,
        lines: [{ label: 'Forfait', quantity: 1, unitPriceHtCents: 120_000, vatRate: 20 }],
        equipmentIds: ['equip-fontaine-a'],
      }),
    );
    if (!created.ok) throw new Error('contrat de scénario');
    const before = (await p.maintenanceContracts.findById(companyId, created.value.id))!.toProps();
    const agent = makeAgent(service);

    const proposed = await run(() =>
      agent.ask('Renomme le contrat fontaines en « Entretien des ascenseurs »'),
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok || !proposed.value.pending) throw new Error('proposition attendue');
    expect(proposed.value.kind).toBe('proposed');
    // Rien n'est écrit avant la confirmation (plancher de sécurité).
    expect((await p.maintenanceContracts.findById(companyId, created.value.id))!.label).toBe(
      'Entretien fontaines',
    );

    const done = await run(() => agent.confirm(proposed.value.pending!));
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.kind).toBe('done');

    const after = (await p.maintenanceContracts.findById(companyId, created.value.id))!.toProps();
    expect(after.label).toBe('Entretien des ascenseurs');
    // Patch d'un SEUL champ : rien d'autre n'a bougé — sauf la révision, qui DOIT bouger.
    expect(after.revision).toBe(before.revision + 1);
    expect(after.status).toBe(before.status);
    expect(after.chantierId).toBe(before.chantierId);
    expect(after.anniversaryDate).toBe(before.anniversaryDate);
    expect(after.visitsPerYear).toBe(before.visitsPerYear);
    expect(after.lines).toEqual(before.lines);
    expect(after.equipmentIds).toEqual(before.equipmentIds);
  });

  it('proposition HTTP opaque périmée : aucune écriture, relecture réelle, puis nouvelle confirmation', async () => {
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

    const proposed = await run(() =>
      service.askBob('Renomme le contrat fontaines en « Entretien des ascenseurs »'),
    );
    expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true });
    if (!proposed.ok || proposed.value.kind !== 'proposed' || !proposed.value.pending) {
      throw new Error('proposition opaque attendue');
    }
    expect(proposed.value.pending.args).toMatchObject({ expectedRevision: 1 });

    // Écriture concurrente après la proposition : sa révision ne doit jamais être relue puis
    // utilisée silencieusement par l'ancienne confirmation.
    const concurrent = await run(() =>
      service.updateMaintenanceContract({
        contractId: created.value.id,
        expectedRevision: 1,
        patch: { label: 'Entretien fontaines — équipe B' },
      }),
    );
    expect(concurrent.ok).toBe(true);

    const stale = await run(() =>
      service.confirmBob({ proposalId: proposed.value.pending?.proposalId }),
    );
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.value.kind).toBe('answer');
    expect(stale.value.card.body).toContain('Entretien fontaines — équipe B');
    expect(stale.value.card.body).toContain('Rien n’a été écrasé');
    expect((await p.maintenanceContracts.findById(companyId, created.value.id))!.toProps())
      .toMatchObject({ revision: 2, label: 'Entretien fontaines — équipe B' });

    const retryCommand = stale.value.choices?.[0]?.value;
    expect(retryCommand).toContain(`Renomme le contrat ${created.value.id}`);
    const reproposed = await run(() => service.askBob(retryCommand!));
    expect(reproposed.ok).toBe(true);
    if (!reproposed.ok || reproposed.value.kind !== 'proposed' || !reproposed.value.pending) {
      throw new Error('nouvelle proposition opaque attendue');
    }
    expect(reproposed.value.pending.args).toMatchObject({ expectedRevision: 2 });

    const done = await run(() =>
      service.confirmBob({ proposalId: reproposed.value.pending?.proposalId }),
    );
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.kind).toBe('done');
    expect((await p.maintenanceContracts.findById(companyId, created.value.id))!.toProps())
      .toMatchObject({ revision: 3, label: 'Entretien des ascenseurs' });
  });

  it('contrat RÉSILIÉ : lecture seule côté domaine — la voix ne le propose même pas, rien ne change', async () => {
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
    await run(() =>
      service.activateMaintenanceContract({ contractId: created.value.id, expectedRevision: 1 }),
    );
    const activated = (await p.maintenanceContracts.findById(companyId, created.value.id))!;
    await run(() =>
      service.terminateMaintenanceContract({
        contractId: created.value.id,
        expectedRevision: activated.revision,
        note: 'le client déménage',
      }),
    );

    const agent = makeAgent(service);
    const r = await run(() =>
      agent.ask('Renomme le contrat fontaines en « Entretien des ascenseurs »'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('answer');
    expect(r.value.pending).toBeUndefined();
    expect(r.value.card.body).toContain('Rien n’a été modifié');
    expect((await p.maintenanceContracts.findById(companyId, created.value.id))!.label).toBe(
      'Entretien fontaines',
    );
  });
});

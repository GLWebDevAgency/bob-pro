import { describe, expect, it, vi } from 'vitest';
import { Chantier, type OcrPort, type PaymentGatewayPort, type PdfRendererPort } from '@bob/core';
import { seedCompany } from '@bob/core/testing';
import { BobAgent, ModelRouter, type BobActions } from '@bob/ai';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

/**
 * PR-11c — INTÉGRATION vocale du parc (patron bob-*-voice) : l'agent Bob branché sur les
 * VRAIES actions hôte (buildBobActions → BackendService → use cases @bob/core, persistance en
 * mémoire du harnais). Preuve de bout en bout : « ajoute la clim du local serveur chez
 * Carrefour » → résolution site par nom, confirmation, équipement RÉEL créé — puis relecture
 * du parc et de l'historique par la voix, et ambiguïté départagée contre les données réelles.
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

function bobActions(service: BackendService): BobActions {
  return (service as unknown as { buildBobActions(): BobActions }).buildBobActions();
}

function makeAgent(service: BackendService): BobAgent {
  return new BobAgent({
    router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
    actions: bobActions(service),
    runtime: {
      clock: { now: () => '2026-07-28T10:00:00.000Z' },
      ids: { newId: () => 'run-equipment-voice' },
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

function seedSite(p: InMemoryPersistence, id: string, name: string, companyId: string): Promise<void> {
  return p.chantiers.save(
    Chantier.rehydrate({
      id,
      companyId,
      name,
      customerId: null,
      address: null,
      notes: null,
      status: 'open',
      openedAt: '2026-07-01',
    }),
  );
}

describe('voix ↔ serveur — parc d’équipements de bout en bout (PR-11c)', () => {
  it('« ajoute la clim du local serveur chez Carrefour » : proposition → confirmation → équipement RÉEL sur le BON site', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedSite(p, 'site-carrefour', 'Carrefour', companyId);
    await seedSite(p, 'site-carrefour-vitry', 'Carrefour Vitry', companyId);
    const principal: Principal = { userId: 'u-1', companyId };
    const agent = makeAgent(service);

    const proposed = await asPrincipal(principal, () =>
      agent.ask('Ajoute la clim du local serveur chez Carrefour'),
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok || !proposed.value.pending) throw new Error('proposition attendue');
    expect(proposed.value.kind).toBe('proposed');
    // Rien n'est créé avant la confirmation.
    expect(await p.equipments.listByCompany(companyId)).toHaveLength(0);

    const confirmed = await asPrincipal(principal, () => agent.confirm(proposed.value.pending!));
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.kind).toBe('done');

    const created = await p.equipments.listByCompany(companyId);
    expect(created).toHaveLength(1);
    const props = created[0]!.toProps();
    // Inclusion départagée : « Carrefour » dit seul = Carrefour, jamais Carrefour Vitry.
    expect(props.chantierId).toBe('site-carrefour');
    expect(props.label.toLowerCase()).toContain('clim');
    expect(props.status).toBe('active');
  });

  it('ambiguïté RÉELLE (deux clims) : question posée, followUp par ID convergent, historique lu au 2e tour', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedSite(p, 'site-carrefour', 'Carrefour', companyId);
    await seedSite(p, 'site-vitry', 'Carrefour Vitry', companyId);
    const principal: Principal = { userId: 'u-1', companyId };
    const run = <T,>(fn: () => Promise<T>) => asPrincipal(principal, fn);

    const climA = await run(() => service.createEquipment('site-carrefour', { label: 'Clim local serveur' }));
    const climB = await run(() => service.createEquipment('site-vitry', { label: 'Clim local serveur' }));
    expect(climA.ok && climB.ok).toBe(true);
    if (!climA.ok || !climB.ok) return;
    await run(() =>
      service.addChantierNote('site-carrefour', {
        text: 'Filtre remplacé',
        equipmentId: climA.value.id,
      }),
    );

    const agent = makeAgent(service);
    const first = await run(() => agent.ask("L'historique de la clim du local serveur"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Deux équipements portent EXACTEMENT ce label : vraie ambiguïté — question, pas de lecture.
    expect(first.value.kind).toBe('answer');
    const options = first.value.ask?.[0]?.options ?? [];
    expect(options).toHaveLength(2);
    const followUp = options.find((option) => option.value === climA.value.id)?.followUp ?? '';
    expect(followUp).toContain(climA.value.id);

    const second = await run(() =>
      agent.ask(followUp, {
        history: [
          { role: 'user', text: "L'historique de la clim du local serveur" },
          { role: 'bob', text: first.value.card.body },
        ],
      }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.kind).toBe('answer');
    expect(second.value.card.body).toContain('Filtre remplacé');
  });

  it('site clôturé : le refus actionnable du DOMAINE traverse la voix verbatim à la confirmation', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedSite(p, 'site-carrefour', 'Carrefour', companyId);
    const principal: Principal = { userId: 'u-1', companyId };
    const agent = makeAgent(service);

    const proposed = await asPrincipal(principal, () =>
      agent.ask('Ajoute la clim du local serveur chez Carrefour'),
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok || !proposed.value.pending) throw new Error('proposition attendue');

    // Le site se clôture ENTRE la proposition et la confirmation (2 appareils).
    const chantier = await p.chantiers.findById('site-carrefour');
    chantier!.close();
    await p.chantiers.save(chantier!);

    const confirmed = await asPrincipal(principal, () => agent.confirm(proposed.value.pending!));
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.kind).toBe('answer');
    expect(confirmed.value.card.body).toContain('rouvre-le');
    expect(await p.equipments.listByCompany(companyId)).toHaveLength(0);
  });

  it('« montre-moi le parc du site Carrefour » puis retrait confirmé : la lecture et la mutation partagent les mêmes données', async () => {
    const { service, p } = makeService();
    const companyId = await seedTenant(p);
    await seedSite(p, 'site-carrefour', 'Carrefour', companyId);
    const principal: Principal = { userId: 'u-1', companyId };
    const run = <T,>(fn: () => Promise<T>) => asPrincipal(principal, fn);
    const created = await run(() =>
      service.createEquipment('site-carrefour', { label: 'Vitrine froide' }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const agent = makeAgent(service);
    const parc = await run(() => agent.ask('Montre-moi le parc du site Carrefour'));
    expect(parc.ok).toBe(true);
    if (!parc.ok) return;
    expect(parc.value.card.body).toContain('Vitrine froide');

    const proposed = await run(() => agent.ask('La vitrine froide est déposée, retire-la du parc'));
    expect(proposed.ok).toBe(true);
    if (!proposed.ok || !proposed.value.pending) throw new Error('proposition attendue');
    const confirmed = await run(() => agent.confirm(proposed.value.pending!));
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.kind).toBe('done');
    const after = await p.equipments.findById(companyId, created.value.id);
    expect(after?.status).toBe('retired');
    expect(after?.retiredAt).not.toBeNull();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { ok } from '@bob/core';
import { BobAgent } from './bob-agent';
import { type BobActions } from './actions';
import { type AgentCapability, type AgentContext } from './context';
import { ModelRouter } from '../router/model-router';

const invoices = [
  { id: 'inv-1', number: '2026-014', remainingCents: 132_000, customerName: 'Durand SARL' },
  { id: 'inv-2', number: '2026-021', remainingCents: 45_000, customerName: 'M. Martin' },
];

function baseActions(readContextEntity?: BobActions['readContextEntity']): BobActions {
  return {
    ...(readContextEntity ? { readContextEntity } : {}),
    computePayout: async () => ok({ payoutCents: 1, availableCents: 1 }),
    draftRelance: async () => ok({ subject: 'Relance', body: 'Brouillon' }),
    listPayableInvoices: async () => ok(invoices),
    listSendableQuotes: async () => ok([]),
    listIssuableInvoices: async () => ok([]),
    listDocuments: async () => ok([]),
    registerPayment: async () => ok({ status: 'paid' }),
    sendQuote: async () => ok({ number: 'D-1' }),
    issueInvoice: async () => ok({ number: 'F-1' }),
  };
}

const router = () => new ModelRouter({ hasClaudeKey: false, hasGlmKey: false });

function invoiceContext(
  ids: readonly string[],
  capabilities: readonly AgentCapability[] = ['invoice.read'],
): AgentContext {
  return {
    screen: { name: '/facture/[id]', instanceId: `screen:${ids.join(',')}` },
    entities: ids.map((id) => ({
      type: 'invoice',
      id,
      label: `Facture ${invoices.find((invoice) => invoice.id === id)?.number ?? id}`,
    })),
    capabilities,
  };
}

describe('BobAgent — contexte UI lecture seule', () => {
  it('unique : recharge le bon id et rend uniquement le resume factuel borne', async () => {
    const read = vi.fn<NonNullable<BobActions['readContextEntity']>>(async (input) =>
      ok({
        ...input,
        label: 'Facture F-2026-0021',
        facts: [
          { label: 'Client', value: 'Martin' },
          { label: 'Reste du', value: '450,00 EUR' },
        ],
      }),
    );
    const agent = new BobAgent({ router: router(), actions: baseActions(read) });
    const result = await agent.ask('Resume cette facture', { context: invoiceContext(['inv-2']) });

    expect(result.ok && result.value.intent).toBe('contexte_ecran');
    expect(result.ok && result.value.kind).toBe('answer');
    expect(result.ok && result.value.card.body).toContain('450,00 EUR');
    expect(read).toHaveBeenCalledWith({ type: 'invoice', id: 'inv-2' });
  });

  it('« ou suis-je » privilegie l entite racine de instanceId, pas ses lignes', async () => {
    const read = vi.fn<NonNullable<BobActions['readContextEntity']>>(async (input) =>
      ok({ ...input, label: 'Facture F-2026-0021', facts: [] }),
    );
    const agent = new BobAgent({ router: router(), actions: baseActions(read) });
    const result = await agent.ask('Ou suis-je ?', {
      context: {
        screen: { name: '/facture/[id]', instanceId: 'invoice:inv-2' },
        entities: [
          { type: 'invoice', id: 'inv-2', label: 'Facture 2026-021' },
          { type: 'invoice_line', id: 'line-1', label: '1 · Main d oeuvre' },
          { type: 'invoice_line', id: 'line-2', label: '2 · Fournitures' },
        ],
        capabilities: ['screen.read', 'invoice.read'],
      },
    });
    expect(result.ok && result.value.ask).toBeUndefined();
    expect(read).toHaveBeenCalledWith({ type: 'invoice', id: 'inv-2' });
  });

  it('« resume ce devis » cible le parent quote unique, jamais ses deux lignes', async () => {
    const read = vi.fn<NonNullable<BobActions['readContextEntity']>>(async (input) =>
      ok({ ...input, label: 'Devis D-2026-0042', facts: [{ label: 'Statut', value: 'Brouillon' }] }),
    );
    const agent = new BobAgent({ router: router(), actions: baseActions(read) });
    const result = await agent.ask('Resume ce devis', {
      context: {
        screen: { name: '/devis/[id]', instanceId: 'quote:quote-42' },
        entities: [
          { type: 'quote', id: 'quote-42', label: 'Devis D-2026-0042' },
          { type: 'quote_line', id: 'line-1', label: '1 · Main d oeuvre' },
          { type: 'quote_line', id: 'line-2', label: '2 · Fournitures' },
        ],
        capabilities: ['screen.read', 'quote.read'],
      },
    });
    expect(result.ok && result.value.ask).toBeUndefined();
    expect(read).toHaveBeenCalledWith({ type: 'quote', id: 'quote-42' });
  });

  it('« explique cette ligne du devis » recharge uniquement la quote_line affichée', async () => {
    const read = vi.fn<NonNullable<BobActions['readContextEntity']>>(async (input) =>
      ok({ ...input, label: 'Main d’œuvre', facts: [{ label: 'Total HT', value: '450,00 €' }] }),
    );
    const agent = new BobAgent({ router: router(), actions: baseActions(read) });
    const result = await agent.ask('Explique cette ligne du devis', {
      context: {
        screen: { name: '/devis/[id]', instanceId: 'quote:quote-42' },
        entities: [
          { type: 'quote', id: 'quote-42', label: 'Devis D-2026-0042' },
          { type: 'quote_line', id: 'line-1', label: '1 · Main d’œuvre' },
        ],
        capabilities: ['screen.read', 'quote.read'],
      },
    });

    expect(result.ok && result.value.intent).toBe('contexte_ecran');
    expect(result.ok && result.value.card.body).toContain('450,00 €');
    expect(read).toHaveBeenCalledWith({ type: 'quote_line', id: 'line-1' });
  });

  it('« résume cette notification » exige notification.read et recharge son id exact', async () => {
    const read = vi.fn<NonNullable<BobActions['readContextEntity']>>(async (input) =>
      ok({ ...input, label: 'Relance F-2026-0042', facts: [{ label: 'Statut', value: 'Non lue' }] }),
    );
    const agent = new BobAgent({ router: router(), actions: baseActions(read) });
    const context: AgentContext = {
      screen: { name: '/notifications', instanceId: 'notifications' },
      entities: [{ type: 'notification', id: 'notif-42', label: 'Libellé non fiable' }],
      capabilities: ['screen.read', 'notification.read'],
    };

    const result = await agent.ask('Résume cette notification', { context });

    expect(result.ok && result.value.intent).toBe('contexte_ecran');
    expect(result.ok && result.value.card.title).toBe('Relance F-2026-0042');
    expect(read).toHaveBeenCalledWith({ type: 'notification', id: 'notif-42' });
  });

  it('« ouvre la deuxième notification » recharge sa route canonique et navigue vers sa pièce', async () => {
    const read = vi.fn<NonNullable<BobActions['readContextEntity']>>(async (input) =>
      ok({
        ...input,
        label: input.id === 'notif-2' ? 'Relance facture F-2026-0042' : 'Autre notification',
        facts: [],
        route: input.id === 'notif-2' ? '/facture/inv-42' : '/devis/quote-1',
      }),
    );
    const agent = new BobAgent({ router: router(), actions: baseActions(read) });
    const result = await agent.ask('Ouvre la deuxième notification', {
      context: {
        screen: { name: '/notifications', instanceId: 'notifications' },
        entities: [
          { type: 'customer', id: 'cust-1', label: 'Client hors demande' },
          { type: 'notification', id: 'notif-1', label: 'Première notification' },
          { type: 'notification', id: 'notif-2', label: 'Deuxième notification' },
        ],
        capabilities: ['screen.read', 'customer.read', 'notification.read'],
      },
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ type: 'notification', id: 'notif-2' });
    expect(result.ok && result.value.kind).toBe('done');
    expect(result.ok && result.value.navigate).toBe('/facture/inv-42');
    expect(result.ok && result.value.card.title).toBe('J’ouvre Relance facture F-2026-0042');
  });

  it('refuse une destination externe même si le lecteur hôte la renvoie', async () => {
    const read = vi.fn<NonNullable<BobActions['readContextEntity']>>(async (input) =>
      ok({
        ...input,
        label: 'Notification',
        facts: [],
        route: 'https://evil.example/phishing',
      }),
    );
    const agent = new BobAgent({ router: router(), actions: baseActions(read) });
    const result = await agent.ask('Ouvre cette notification', {
      context: {
        screen: { name: '/notifications', instanceId: 'notifications' },
        entities: [{ type: 'notification', id: 'notif-1', label: 'Notification' }],
        capabilities: ['screen.read', 'notification.read'],
      },
    });

    expect(result.ok && result.value.kind).toBe('answer');
    expect(result.ok && result.value.navigate).toBeUndefined();
    expect(result.ok && result.value.card.body).toContain('pas encore d’écran détaillé');
  });

  it('« notifications en attente » ne lit que les non-lues et dit leur motif canonique', async () => {
    const read = vi.fn<NonNullable<BobActions['readContextEntity']>>(async (input) =>
      ok({
        ...input,
        label: `Notification ${input.id}`,
        state: { unread: input.id === 'notif-1' },
        facts: [
          { label: 'Statut', value: input.id === 'notif-1' ? 'Non lue' : 'Lue' },
          { label: 'Reçue le', value: '13/07/2026' },
          { label: 'Contenu', value: input.id === 'notif-1' ? 'Facture à relancer.' : 'Notification déjà traitée.' },
        ],
      }),
    );
    const agent = new BobAgent({ router: router(), actions: baseActions(read) });
    const result = await agent.ask('Lis-moi les notifications en attente', {
      context: {
        screen: { name: '/notifications', instanceId: 'notifications' },
        entities: [
          { type: 'notification', id: 'notif-1', label: 'Label non fiable A' },
          { type: 'notification', id: 'notif-2', label: 'Label non fiable B' },
          { type: 'invoice', id: 'inv-1', label: 'Facture hors demande' },
        ],
        capabilities: ['screen.read', 'notification.read', 'invoice.read'],
      },
    });

    expect(result.ok && result.value.intent).toBe('contexte_ecran');
    expect(result.ok && result.value.card.body).toContain('Notification notif-1');
    expect(result.ok && result.value.card.body).toContain('Facture à relancer.');
    expect(result.ok && result.value.card.body).not.toContain('Notification notif-2');
    expect(result.ok && result.value.card.body).not.toContain('Notification déjà traitée.');
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).not.toHaveBeenCalledWith({ type: 'invoice', id: 'inv-1' });
  });

  it('« toutes les notifications » conserve aussi celles déjà lues', async () => {
    const read = vi.fn<NonNullable<BobActions['readContextEntity']>>(async (input) =>
      ok({
        ...input,
        label: `Notification ${input.id}`,
        state: { unread: input.id === 'notif-1' },
        facts: [{ label: 'Contenu', value: `Motif ${input.id}` }],
      }),
    );
    const agent = new BobAgent({ router: router(), actions: baseActions(read) });
    const result = await agent.ask('Lis toutes les notifications', {
      context: {
        screen: { name: '/notifications', instanceId: 'notifications' },
        entities: [
          { type: 'notification', id: 'notif-1', label: 'A' },
          { type: 'notification', id: 'notif-2', label: 'B' },
        ],
        capabilities: ['screen.read', 'notification.read'],
      },
    });

    expect(result.ok && result.value.card.body).toContain('Notification notif-1');
    expect(result.ok && result.value.card.body).toContain('Notification notif-2');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('« explique cette écriture » exige accounting.read', async () => {
    const read = vi.fn<NonNullable<BobActions['readContextEntity']>>(async (input) =>
      ok({ ...input, label: 'VE-2026-0042 — Vente', facts: [{ label: 'Journal', value: 'Ventes' }] }),
    );
    const agent = new BobAgent({ router: router(), actions: baseActions(read) });
    const result = await agent.ask('Explique cette écriture', {
      context: {
        screen: { name: '/comptabilite', instanceId: 'comptabilite' },
        entities: [{ type: 'accounting_entry', id: 'entry-42', label: 'Libellé non fiable' }],
        capabilities: ['screen.read', 'accounting.read'],
      },
    });

    expect(result.ok && result.value.intent).toBe('contexte_ecran');
    expect(result.ok && result.value.card.title).toBe('VE-2026-0042 — Vente');
    expect(read).toHaveBeenCalledWith({ type: 'accounting_entry', id: 'entry-42' });
  });

  it('un document sans document.read est exclu même si screen.read est publié', async () => {
    const read = vi.fn<NonNullable<BobActions['readContextEntity']>>();
    const agent = new BobAgent({ router: router(), actions: baseActions(read) });
    const result = await agent.ask('Résume ce document', {
      context: {
        screen: { name: '/recherche', instanceId: 'search' },
        entities: [{ type: 'document', id: 'doc-1', label: 'Document' }],
        capabilities: ['screen.read', 'search.read'],
      },
    });

    expect(result.ok && result.value.card.body).toContain('pas encore');
    expect(read).not.toHaveBeenCalled();
  });

  it('zero candidat : reponse honnete et aucune lecture', async () => {
    const read = vi.fn<NonNullable<BobActions['readContextEntity']>>();
    const agent = new BobAgent({ router: router(), actions: baseActions(read) });
    const result = await agent.ask('Ou suis-je ?', {
      context: { screen: { name: 'today', instanceId: 'today' }, entities: [], capabilities: ['screen.read'] },
    });
    expect(result.ok && result.value.intent).toBe('contexte_ecran');
    expect(result.ok && result.value.card.body).toContain('pas encore');
    expect(read).not.toHaveBeenCalled();
  });

  it('deux candidats : question structuree, jamais de choix implicite', async () => {
    const read = vi.fn<NonNullable<BobActions['readContextEntity']>>();
    const agent = new BobAgent({ router: router(), actions: baseActions(read) });
    const result = await agent.ask('Resume cette facture', { context: invoiceContext(['inv-1', 'inv-2']) });
    expect(result.ok && result.value.ask?.[0]?.id).toBe('contexte_ecran.cible');
    expect(result.ok && result.value.ask?.[0]?.options).toHaveLength(2);
    expect(read).not.toHaveBeenCalled();
  });

  it('« ou suis-je » multi-entites : briefing AGREGE borne (lit chaque element, sans question inutile)', async () => {
    const read = vi.fn<NonNullable<BobActions['readContextEntity']>>(async (input) =>
      ok({
        type: input.type,
        id: input.id,
        label: `Facture ${invoices.find((invoice) => invoice.id === input.id)?.number ?? input.id}`,
        facts: [
          { label: 'Statut', value: 'En retard' },
          { label: 'Reste dû', value: '450,00 €' },
          { label: 'Client', value: 'ignoré au-delà de 2 faits' },
        ],
      }),
    );
    const agent = new BobAgent({ router: router(), actions: baseActions(read) });
    const result = await agent.ask('Ou suis-je ?', { context: invoiceContext(['inv-1', 'inv-2']) });
    expect(result.ok && result.value.intent).toBe('contexte_ecran');
    expect(read).toHaveBeenCalledTimes(2);
    const body = result.ok ? result.value.card.body : '';
    expect(body).toContain('• Facture 2026-014 — Statut : En retard · Reste dû : 450,00 €');
    expect(body).toContain('• Facture 2026-021');
    expect(result.ok && result.value.ask).toBeUndefined();
  });

  it('« explique-moi tout ce qui est en attente » declenche aussi le briefing agrege (regex demo)', async () => {
    const read = vi.fn<NonNullable<BobActions['readContextEntity']>>(async (input) =>
      ok({ type: input.type, id: input.id, label: `Facture ${input.id}`, facts: [] }),
    );
    const agent = new BobAgent({ router: router(), actions: baseActions(read) });
    const result = await agent.ask('Explique-moi tout ce qui est en attente', {
      context: invoiceContext(['inv-1', 'inv-2']),
    });
    expect(result.ok && result.value.intent).toBe('contexte_ecran');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('capacite lisible mais action hote absente : reponse honnete', async () => {
    const agent = new BobAgent({ router: router(), actions: baseActions() });
    const result = await agent.ask('Resume cette facture', { context: invoiceContext(['inv-1']) });
    expect(result.ok && result.value.card.body).toContain('pas encore lire');
  });
});

describe('BobAgent — contexte UI pour intents existants', () => {
  it('« tout marquer comme lu » fige le cutoff serveur et propose même en autonomie auto', async () => {
    const markNotificationsReadThrough = vi.fn<NonNullable<BobActions['markNotificationsReadThrough']>>(
      async () => ok({ updatedCount: 3, readAt: '2026-07-13T10:01:00.000Z' }),
    );
    const agent = new BobAgent({
      router: router(),
      actions: {
        ...baseActions(),
        previewUnreadNotifications: async () =>
          ok({ unreadCount: 3, throughCreatedAt: '2026-07-13T10:00:00.000Z' }),
        markNotificationsReadThrough,
      },
    });

    const result = await agent.ask('Marque toutes les notifications comme lues', { autonomy: 'auto' });

    expect(result.ok && result.value.intent).toBe('marquer_notifications_lues');
    expect(result.ok && result.value.kind).toBe('proposed');
    expect(result.ok && result.value.pending?.tool).toBe('marquer_notifications_lues');
    expect(result.ok && result.value.pending?.args).toEqual({
      throughCreatedAt: '2026-07-13T10:00:00.000Z',
    });
    expect(result.ok && result.value.card.body).toContain('3 notifications');
    expect(markNotificationsReadThrough).not.toHaveBeenCalled();
  });

  it('répond sans proposition quand toutes les notifications sont déjà lues', async () => {
    const agent = new BobAgent({
      router: router(),
      actions: {
        ...baseActions(),
        previewUnreadNotifications: async () =>
          ok({ unreadCount: 0, throughCreatedAt: '2026-07-13T10:00:00.000Z' }),
        markNotificationsReadThrough: async () =>
          ok({ updatedCount: 0, readAt: '2026-07-13T10:01:00.000Z' }),
      },
    });

    const result = await agent.ask('Marque tout comme lu', {
      context: {
        screen: { name: '/notifications', instanceId: 'notifications' },
        entities: [],
        capabilities: ['screen.read'],
      },
    });

    expect(result.ok && result.value.kind).toBe('answer');
    expect(result.ok && result.value.card.body).toContain('Tout est déjà lu');
    expect(result.ok && result.value.pending).toBeUndefined();
  });

  it('demande la portée pour « marque tout comme lu » hors de l’écran Notifications', async () => {
    const previewUnreadNotifications = vi.fn<NonNullable<BobActions['previewUnreadNotifications']>>(
      async () => ok({ unreadCount: 2, throughCreatedAt: '2026-07-13T10:00:00.000Z' }),
    );
    const agent = new BobAgent({
      router: router(),
      actions: {
        ...baseActions(),
        previewUnreadNotifications,
        markNotificationsReadThrough: async () =>
          ok({ updatedCount: 2, readAt: '2026-07-13T10:01:00.000Z' }),
      },
    });

    const result = await agent.ask('Marque tout comme lu', {
      context: invoiceContext(['inv-1']),
    });

    expect(result.ok && result.value.kind).toBe('answer');
    expect(result.ok && result.value.card.body).toContain('notifications');
    expect(previewUnreadNotifications).not.toHaveBeenCalled();
  });

  it('Notifications : « relance cette facture » cible l’invoice publiée, jamais une autre', async () => {
    const draftRelance = vi.fn<BobActions['draftRelance']>(async () =>
      ok({ subject: 'Relance ciblée', body: 'Brouillon de relance' }),
    );
    const agent = new BobAgent({
      router: router(),
      actions: { ...baseActions(), draftRelance },
    });
    const result = await agent.ask('Relance cette facture', {
      context: {
        screen: { name: '/notifications', instanceId: 'notifications' },
        entities: [
          { type: 'notification', id: 'notif-1', label: 'Relance à préparer' },
          { type: 'invoice', id: 'inv-2', label: 'Facture 2026-021' },
        ],
        capabilities: ['screen.read', 'notification.read', 'invoice.read'],
      },
    });

    expect(result.ok && result.value.intent).toBe('relance');
    expect(draftRelance).toHaveBeenCalledWith({ invoiceId: 'inv-2' });
  });

  it('anaphore avec deux factures metier : invoice.collect cible directement id du contexte', async () => {
    const agent = new BobAgent({ router: router(), actions: baseActions() });
    const result = await agent.ask('Marque comme paye', {
      autonomy: 'confirm_all',
      context: invoiceContext(['inv-2'], ['invoice.read', 'invoice.collect']),
    });
    expect(result.ok && result.value.kind).toBe('proposed');
    expect(result.ok && result.value.pending?.args).toMatchObject({ invoiceId: 'inv-2' });
  });

  it('reference explicite prime sur le contexte unique', async () => {
    const agent = new BobAgent({ router: router(), actions: baseActions() });
    const result = await agent.ask('Encaisse la facture 2026-014', {
      autonomy: 'confirm_all',
      context: invoiceContext(['inv-2'], ['invoice.read', 'invoice.collect']),
    });
    expect(result.ok && result.value.pending?.args).toMatchObject({ invoiceId: 'inv-1' });
  });

  it('resolveInvoice accepte aussi un id metier explicite', async () => {
    const agent = new BobAgent({ router: router(), actions: baseActions() });
    const result = await agent.ask('Encaisse inv-2', { autonomy: 'confirm_all' });
    expect(result.ok && result.value.pending?.args).toMatchObject({ invoiceId: 'inv-2' });
  });
});

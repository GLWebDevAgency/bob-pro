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

  it('capacite lisible mais action hote absente : reponse honnete', async () => {
    const agent = new BobAgent({ router: router(), actions: baseActions() });
    const result = await agent.ask('Resume cette facture', { context: invoiceContext(['inv-1']) });
    expect(result.ok && result.value.card.body).toContain('pas encore lire');
  });
});

describe('BobAgent — contexte UI pour intents existants', () => {
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

import { describe, it, expect } from 'vitest';
import { ok, QUOTE_CREATION_MISSION_KIND_V1 } from '@bob/core';
import { BobAgent, pendingToInvocations, type PendingAction } from './bob-agent';
import { ModelRouter } from '../router/model-router';
import { type BobActions } from './actions';
import { ActionPolicy, invocationsFrom } from '../runtime';
import { InMemoryJournalStore } from '../runtime/journal.testing';

function makeActions() {
  let payments = 0;
  let quoteCreations = 0;
  const actions: BobActions = {
    computePayout: async () => ok({ payoutCents: 180000, availableCents: 495000 }),
    draftRelance: async () => ok({ subject: 's', body: 'b' }),
    listPayableInvoices: async () => ok([{ id: 'inv-1', number: '2026-014', remainingCents: 132000, customerName: 'Durand' }]),
    listSendableQuotes: async () => ok([{ id: 'quote-1', number: 'D2026-014', totalTtcCents: 132000, customerName: 'Durand', status: 'draft' }]),
    listIssuableInvoices: async () => ok([{ id: 'draft-inv-1', number: null, totalTtcCents: 132000, customerName: 'Durand', status: 'draft', operationCategoryRequired: false }]),
    listDocuments: async () => ok([]),
    registerPayment: async () => {
      payments++;
      return ok({ status: 'paid' });
    },
    sendQuote: async () => ok({ number: 'D2026-014' }),
    issueInvoice: async () => ok({ number: 'F2026-001' }),
    createQuote: async () => {
      quoteCreations++;
      return ok({ quoteId: 'quote-created' });
    },
  };
  return {
    actions,
    payments: () => payments,
    quoteCreations: () => quoteCreations,
  };
}

const clock = { now: () => '2026-07-01T00:00:00.000Z' };
let n = 0;
const ids = { newId: () => `run-${++n}` };
const router = () => new ModelRouter({ hasClaudeKey: false, hasGlmKey: false });

const encaisser = (): PendingAction => ({
  tool: 'encaisser_facture',
  args: { invoiceId: 'inv-1', amountCents: 132000, idempotencyKey: 'k' },
  label: 'Encaisser 2026-014',
});

describe('pendingToInvocations', () => {
  it('action simple -> 1 invocation', () => {
    const inv = pendingToInvocations(encaisser());
    expect(inv).toHaveLength(1);
    expect(inv[0]!.tool).toBe('encaisser_facture');
  });

  it('lot -> mappe le batch dans l’ordre', () => {
    const p: PendingAction = {
      tool: 'batch',
      args: {},
      label: 'lot',
      batch: [
        { tool: 'factures_impayees', args: {}, label: 'lister' },
        { tool: 'encaisser_facture', args: { invoiceId: 'inv-1', amountCents: 1 }, label: 'enc' },
      ],
    };
    expect(pendingToInvocations(p).map((i) => i.tool)).toEqual(['factures_impayees', 'encaisser_facture']);
  });
});

describe('BobAgent + runtime', () => {
  it('conserve l’exécution legacy de creer_devis quand aucun MissionKind n’est admis', async () => {
    const { actions, quoteCreations } = makeActions();
    const agent = new BobAgent({
      router: router(),
      actions,
      runtime: { clock, ids },
    });

    const record = await agent.runJournaled([{
      tool: 'creer_devis',
      args: {
        customerId: 'customer-1',
        lines: [{
          label: 'Entretien vitrines',
          category: 'labor',
          qty: 1,
          unitPriceHT: 12_000,
          vatRate: 20,
        }],
      },
      label: 'Créer le devis',
    }]);

    expect(record.ok).toBe(true);
    expect(record.outcomes).toEqual([
      expect.objectContaining({ tool: 'creer_devis', status: 'executed' }),
    ]);
    expect(quoteCreations()).toBe(1);
  });

  it('revalide un ancien dry-run avec l’autorité du runtime qui le rejoue', async () => {
    const legacy = makeActions();
    const legacyAgent = new BobAgent({
      router: router(),
      actions: legacy.actions,
      runtime: { clock, ids },
    });
    const dry = await legacyAgent.dryRun([{
      tool: 'creer_devis',
      args: {
        customerId: 'customer-1',
        lines: [{
          label: 'Entretien vitrines',
          category: 'labor',
          qty: 1,
          unitPriceHT: 12_000,
          vatRate: 20,
        }],
      },
      label: 'Créer le devis',
    }]);
    expect(dry.ok).toBe(true);
    expect(legacy.quoteCreations()).toBe(0);

    const current = makeActions();
    const missionOwnedAgent = new BobAgent({
      router: router(),
      actions: current.actions,
      admittedMissionKinds: [QUOTE_CREATION_MISSION_KIND_V1],
      runtime: { clock, ids },
    });
    const replay = await missionOwnedAgent.runJournaled(invocationsFrom(dry.entries));

    expect(replay.ok).toBe(false);
    expect(replay.outcomes).toEqual([
      expect.objectContaining({ tool: 'creer_devis', status: 'denied' }),
    ]);
    expect(current.quoteCreations()).toBe(0);
  });

  it('réapplique l’ownership dans confirm, dryRun et runJournaled sans effet partiel', async () => {
    const { actions, payments, quoteCreations } = makeActions();
    const agent = new BobAgent({
      router: router(),
      actions,
      admittedMissionKinds: [QUOTE_CREATION_MISSION_KIND_V1],
      runtime: { clock, ids },
    });
    const createQuote: PendingAction = {
      tool: 'creer_devis',
      args: {
        customerId: 'customer-1',
        lines: [{
          label: 'Main-d’œuvre',
          category: 'labor',
          qty: 2,
          unitPriceHT: 5500,
          vatRate: 20,
        }],
      },
      label: 'Créer le devis',
    };

    const dry = await agent.dryRun(pendingToInvocations(createQuote));
    const live = await agent.runJournaled(pendingToInvocations(createQuote));
    const confirmed = await agent.confirm({
      tool: 'batch',
      args: {},
      label: 'Lot interdit',
      batch: [
        {
          tool: 'encaisser_facture',
          args: { invoiceId: 'inv-1', amountCents: 132000 },
          label: 'Encaisser',
        },
        createQuote,
      ],
    });

    expect(dry.outcomes[0]).toMatchObject({ status: 'denied', tool: 'creer_devis' });
    expect(live.outcomes[0]).toMatchObject({ status: 'denied', tool: 'creer_devis' });
    expect(confirmed).toEqual({
      ok: false,
      error: {
        kind: 'conflict',
        entity: 'agent_intent_ownership',
        reason: 'mission_owned',
      },
    });
    expect(payments()).toBe(0);
    expect(quoteCreations()).toBe(0);
  });

  it("dryRun : n'exécute pas, journalise en planned", async () => {
    const { actions, payments } = makeActions();
    const agent = new BobAgent({ router: router(), actions, runtime: { clock, ids } });
    const rec = await agent.dryRun(pendingToInvocations(encaisser()));
    expect(payments()).toBe(0);
    expect(rec.mode).toBe('dry-run');
    expect(rec.outcomes[0]!.status).toBe('planned');
  });

  it('runJournaled : exécute + journalise planned->executed (store append-only)', async () => {
    const { actions, payments } = makeActions();
    const store = new InMemoryJournalStore();
    const agent = new BobAgent({ router: router(), actions, runtime: { clock, ids, store } });
    const rec = await agent.runJournaled(pendingToInvocations(encaisser()), { runId: 'r1' });
    expect(payments()).toBe(1);
    expect(rec.entries.map((e) => e.phase)).toEqual(['planned', 'executed']);
    expect((await store.load('r1')).length).toBe(2);
  });

  it('policy : encaissement refusé (lecture seule) -> non exécuté', async () => {
    const { actions, payments } = makeActions();
    const agent = new BobAgent({ router: router(), actions, runtime: { clock, ids, policy: new ActionPolicy({ readOnly: true }) } });
    const rec = await agent.runJournaled(pendingToInvocations(encaisser()));
    expect(payments()).toBe(0);
    expect(rec.outcomes[0]!.status).toBe('denied');
  });

  it('sans runtime configuré : dryRun lève une erreur explicite', async () => {
    const { actions } = makeActions();
    const agent = new BobAgent({ router: router(), actions });
    await expect(agent.dryRun([])).rejects.toThrow(/runtime non configuré/);
  });

  it('bout-en-bout : ask(confirm_all) -> pending -> dryRun aperçu SANS effet', async () => {
    const { actions, payments } = makeActions();
    const agent = new BobAgent({ router: router(), actions, runtime: { clock, ids } });
    const asked = await agent.ask('encaisse la facture 2026-014', { autonomy: 'confirm_all' });
    expect(asked.ok && asked.value.pending).toBeTruthy();
    if (asked.ok && asked.value.pending) {
      const preview = await agent.dryRun(pendingToInvocations(asked.value.pending));
      expect(preview.outcomes[0]!.status).toBe('planned');
      expect(payments()).toBe(0);
    }
  });
});

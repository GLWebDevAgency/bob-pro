import { describe, it, expect } from 'vitest';
import { ok } from '@bob/core';
import { BobAgent, pendingToInvocations, type PendingAction } from './bob-agent';
import { ModelRouter } from '../router/model-router';
import { type BobActions } from './actions';
import { ActionPolicy } from '../runtime';
import { InMemoryJournalStore } from '../runtime/journal.testing';

function makeActions() {
  let payments = 0;
  const actions: BobActions = {
    computePayout: async () => ok({ payoutCents: 180000, availableCents: 495000 }),
    draftRelance: async () => ok({ subject: 's', body: 'b' }),
    listPayableInvoices: async () => ok([{ id: 'inv-1', number: '2026-014', remainingCents: 132000, customerName: 'Durand' }]),
    listSendableQuotes: async () => ok([{ id: 'quote-1', number: 'D2026-014', totalTtcCents: 132000, customerName: 'Durand', status: 'draft' }]),
    listIssuableInvoices: async () => ok([{ id: 'draft-inv-1', number: null, totalTtcCents: 132000, customerName: 'Durand', status: 'draft' }]),
    listDocuments: async () => ok([]),
    registerPayment: async () => {
      payments++;
      return ok({ status: 'paid' });
    },
    sendQuote: async () => ok({ number: 'D2026-014' }),
    issueInvoice: async () => ok({ number: 'F2026-001' }),
  };
  return { actions, payments: () => payments };
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

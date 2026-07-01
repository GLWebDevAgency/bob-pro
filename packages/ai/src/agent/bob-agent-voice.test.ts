import { describe, it, expect } from 'vitest';
import { ok } from '@bob/core';
import { BobAgent } from './bob-agent';
import { ModelRouter } from '../router/model-router';
import { type BobActions } from './actions';

function makeActions() {
  let payments = 0;
  const actions: BobActions = {
    computePayout: async () => ok({ payoutCents: 1, availableCents: 1 }),
    draftRelance: async () => ok({ subject: 's', body: 'b' }),
    listPayableInvoices: async () => ok([{ id: 'inv-1', number: '2026-014', remainingCents: 132000, customerName: 'Durand' }]),
    registerPayment: async () => {
      payments++;
      return ok({ status: 'paid' });
    },
  };
  return { actions, payments: () => payments };
}
const router = () => new ModelRouter({ hasClaudeKey: false, hasGlmKey: false });
const propose = async (agent: BobAgent) => agent.ask('encaisse la facture 2026-014', { autonomy: 'confirm_all' });

describe('BobAgent — confirmation vocale', () => {
  it('action proposée porte un spokenPrompt (à vocaliser par le TTS)', async () => {
    const { actions } = makeActions();
    const r = await propose(new BobAgent({ router: router(), actions }));
    expect(r.ok && r.value.kind).toBe('proposed');
    expect(r.ok && r.value.spokenPrompt).toContain('je confirme');
  });

  it('« oui je confirme » -> exécute', async () => {
    const { actions, payments } = makeActions();
    const agent = new BobAgent({ router: router(), actions });
    const p = await propose(agent);
    expect(p.ok && p.value.pending).toBeTruthy();
    if (p.ok && p.value.pending) {
      const r = await agent.confirmByVoice(p.value.pending, 'oui je confirme');
      expect(r.ok && r.value.kind).toBe('done');
      expect(payments()).toBe(1);
    }
  });

  it('« non, annule » -> rien exécuté', async () => {
    const { actions, payments } = makeActions();
    const agent = new BobAgent({ router: router(), actions });
    const p = await propose(agent);
    if (p.ok && p.value.pending) {
      const r = await agent.confirmByVoice(p.value.pending, 'non, annule');
      expect(r.ok && r.value.card.title).toBe('Annulé');
      expect(payments()).toBe(0);
    }
  });

  it('réponse ambiguë -> re-demande, rien exécuté (fail-safe)', async () => {
    const { actions, payments } = makeActions();
    const agent = new BobAgent({ router: router(), actions });
    const p = await propose(agent);
    if (p.ok && p.value.pending) {
      const r = await agent.confirmByVoice(p.value.pending, 'euh je sais pas trop');
      expect(r.ok && r.value.kind).toBe('proposed');
      expect(payments()).toBe(0);
    }
  });
});

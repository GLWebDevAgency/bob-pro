import { describe, it, expect } from 'vitest';
import { ok } from '@bob/core';
import { BobAgent } from './bob-agent';
import { ModelRouter } from '../router/model-router';
import { type BobCapabilities } from './capabilities';

const caps: BobCapabilities = {
  computePayout: async () => ok({ payoutCents: 180000, availableCents: 495000 }),
  draftRelance: async () => ok({ subject: 'Petit rappel', body: 'Bonjour, un petit rappel pour votre facture.' }),
};

describe('BobAgent (démo)', () => {
  const agent = new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), caps });

  it('répond à « combien je peux me verser » avec un montant issu du domaine', async () => {
    const r = await agent.ask('Combien je peux me verser ce mois-ci ?');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.intent).toBe('payout');
      expect(r.value.model).toBe('demo');
      expect(r.value.card.body).toContain('1');
      expect(r.value.plan.length).toBeGreaterThan(0);
    }
  });

  it('détecte l’intention de relance', async () => {
    const r = await agent.ask('Tu peux relancer le client en retard ?');
    expect(r.ok && r.value.intent).toBe('relance');
  });

  it('répond à une demande inconnue sans rien inventer', async () => {
    const r = await agent.ask('Bonjour Bob');
    expect(r.ok && r.value.intent).toBe('unknown');
  });
});

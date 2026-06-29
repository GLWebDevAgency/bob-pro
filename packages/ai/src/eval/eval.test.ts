import { describe, it, expect } from 'vitest';
import { ok } from '@bob/core';
import { BobAgent } from '../agent/bob-agent';
import { detectIntent, type BobIntent } from '../agent/bob-agent';
import { ModelRouter } from '../router/model-router';
import { renderWithGuard } from '../guardrails/money-guard';
import { type BobCapabilities } from '../agent/capabilities';

const caps: BobCapabilities = {
  computePayout: async () => ok({ payoutCents: 180000, availableCents: 495000 }),
  draftRelance: async () => ok({ subject: 'Petit rappel', body: 'Bonjour, un petit rappel pour votre facture.' }),
};
const agent = new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), caps });

const INTENT_CASES: { msg: string; expected: BobIntent }[] = [
  { msg: 'Combien je peux me verser ce mois ?', expected: 'payout' },
  { msg: 'Je veux me payer un peu', expected: 'payout' },
  { msg: 'Relance le client en retard', expected: 'relance' },
  { msg: 'Prépare un rappel pour la facture impayée', expected: 'relance' },
  { msg: 'Quel temps fera-t-il demain ?', expected: 'unknown' },
];

describe('Éval IA — précision & anti-hallucination (gate CI)', () => {
  it('détecte correctement les intentions du corpus', () => {
    for (const c of INTENT_CASES) expect(detectIntent(c.msg)).toBe(c.expected);
  });

  it('aucune réponse de Bob ne contient un montant hors domaine', async () => {
    for (const c of INTENT_CASES) {
      const r = await agent.ask(c.msg);
      expect(r.ok).toBe(true);
      if (r.ok) {
        // Le seul montant légitime est celui du domaine (payout = 1 800,00 €).
        const guard = renderWithGuard(r.value.card.body, [{ token: 'domain', cents: 180000 }]);
        expect(guard.violations).toHaveLength(0);
      }
    }
  });

  it('le garde-fou rejette des montants inventés', () => {
    for (const t of ['Tu dois 1 500,00 EUR', 'Total : 9 999,00 €', 'Je te facture 42,50 EUR']) {
      expect(renderWithGuard(t, []).ok).toBe(false);
    }
  });
});

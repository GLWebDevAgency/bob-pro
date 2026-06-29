import { BobAgent, ModelRouter, type BobCapabilities } from '@bob/ai';
import { ok, buildRelance } from '@bob/core';
import type { BobClient } from '@bob/api-client';

/**
 * Construit l'agent Bob pour l'app : ses capacités s'appuient sur le BobClient (donc le domaine).
 * Les clés LLM vivent côté backend — sur le device, le routeur tombe en mode démo déterministe.
 */
export function makeBobAgent(client: BobClient): BobAgent {
  const caps: BobCapabilities = {
    async computePayout() {
      const r = await client.getCashflow({ scenario: 'realiste', horizon: 30 });
      if (!r.ok) return r;
      return ok({ payoutCents: r.value.payout, availableCents: r.value.available });
    },
    async draftRelance() {
      const r = await client.listCustomers();
      if (!r.ok) return r;
      const overdue = [...r.value].filter((c) => c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding)[0];
      const message = buildRelance({
        customerName: overdue?.name ?? 'le client',
        docNumber: 'dernière facture',
        amountCents: overdue?.outstanding ?? 0,
        daysLate: 7,
        tone: 'cordial',
        personality: 'Pote',
      });
      return ok({ subject: message.subject, body: message.body });
    },
  };
  return new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), caps });
}

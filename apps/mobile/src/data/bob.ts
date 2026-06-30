import { BobAgent, ModelRouter, type BobActions, type PayableInvoice } from '@bob/ai';
import { ok, buildRelance } from '@bob/core';
import type { BobClient } from '@bob/api-client';

const PAYABLE = new Set(['issued', 'partially_paid', 'late']);

/**
 * Construit l'agent Bob pour l'app : ses ACTIONS s'appuient sur le BobClient (donc les mêmes use cases
 * que l'UI manuelle) — parité totale. Les clés LLM vivent côté backend ; sur le device, le routeur
 * tombe en mode démo déterministe.
 */
export function makeBobAgent(client: BobClient): BobAgent {
  const actions: BobActions = {
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
    async listPayableInvoices() {
      const [inv, cust] = await Promise.all([client.listInvoices(), client.listCustomers()]);
      if (!inv.ok) return inv;
      const names = new Map((cust.ok ? cust.value : []).map((c) => [c.id, c.name]));
      const payable: PayableInvoice[] = inv.value
        .filter((i) => PAYABLE.has(i.status) && i.number)
        .map((i) => ({
          id: i.id,
          number: i.number ?? i.id,
          remainingCents: Math.max(0, i.totals.ttc - i.paid),
          customerName: names.get(i.customerId) ?? 'Client',
        }))
        .filter((i) => i.remainingCents > 0);
      return ok(payable);
    },
    async registerPayment(input) {
      return client.registerPayment({ invoiceId: input.invoiceId, amount: input.amountCents, method: 'transfer' });
    },
  };
  return new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions });
}

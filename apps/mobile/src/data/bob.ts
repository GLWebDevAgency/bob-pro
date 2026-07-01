import {
  BobAgent,
  ModelRouter,
  type BobActions,
  type PayableInvoice,
  type SendableQuote,
  type IssuableInvoice,
  type AgentDocument,
} from '@bob/ai';
import { ok, buildRelance } from '@bob/core';
import type { BobClient } from '@bob/api-client';

const PAYABLE = new Set(['issued', 'partially_paid', 'late']);
const SENDABLE_QUOTE = new Set(['draft', 'sent', 'viewed']); // devis qu'on peut (r)envoyer au client

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
          remainingCents: Math.max(0, i.totals.netToPay - i.paid),
          customerName: names.get(i.customerId) ?? 'Client',
        }))
        .filter((i) => i.remainingCents > 0);
      return ok(payable);
    },
    async listSendableQuotes() {
      const [q, cust] = await Promise.all([client.listQuotes(), client.listCustomers()]);
      if (!q.ok) return q;
      const names = new Map((cust.ok ? cust.value : []).map((c) => [c.id, c.name]));
      const quotes: SendableQuote[] = q.value
        .filter((x) => SENDABLE_QUOTE.has(x.status))
        .map((x) => ({
          id: x.id,
          number: x.number,
          customerName: names.get(x.customerId) ?? 'Client',
          totalTtcCents: x.totals.ttc,
          status: x.status,
        }));
      return ok(quotes);
    },
    async listIssuableInvoices() {
      const [inv, cust] = await Promise.all([client.listInvoices(), client.listCustomers()]);
      if (!inv.ok) return inv;
      const names = new Map((cust.ok ? cust.value : []).map((c) => [c.id, c.name]));
      const invoices: IssuableInvoice[] = inv.value
        .filter((x) => x.status === 'draft') // seule une facture brouillon peut être émise
        .map((x) => ({
          id: x.id,
          number: x.number,
          customerName: names.get(x.customerId) ?? 'Client',
          totalTtcCents: x.totals.ttc,
          status: x.status,
        }));
      return ok(invoices);
    },
    async listDocuments() {
      const r = await client.listDocuments();
      if (!r.ok) return r;
      const docs: AgentDocument[] = r.value.map((d) => ({
        id: d.id,
        filename: d.filename,
        kind: d.kind,
        linkedEntityType: d.linkedEntityType,
        linkedEntityId: d.linkedEntityId,
        createdAt: d.createdAt,
      }));
      return ok(docs);
    },
    async registerPayment(input) {
      return client.registerPayment({
        invoiceId: input.invoiceId,
        amount: input.amountCents,
        method: 'transfer',
        idempotencyKey: input.idempotencyKey ?? `mobile-bob:payment:${input.invoiceId}:${input.amountCents}:transfer`,
      });
    },
    async sendQuote(input) {
      return client.sendQuote(input.quoteId);
    },
    async issueInvoice(input) {
      return client.issueInvoice({ invoiceId: input.invoiceId });
    },
  };
  return new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions });
}

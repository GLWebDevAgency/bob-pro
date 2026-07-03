import {
  BobAgent,
  ModelRouter,
  type AgentRun,
  type AskOptions,
  type BobActions,
  type PayableInvoice,
  type PendingAction,
  type SendableQuote,
  type IssuableInvoice,
  type AgentDocument,
} from '@bob/ai';
import { ok, deriveRelancePlan, type AppError, type Result } from '@bob/core';
import { HttpBobClient, type BobClient } from '@bob/api-client';

const PAYABLE = new Set(['issued', 'partially_paid', 'late']);
const SENDABLE_QUOTE = new Set(['draft', 'sent', 'viewed']); // devis qu'on peut (r)envoyer au client

/** DateOnly locale du device — la date d'une dépense se juge en calendrier local, pas UTC. */
function localDateOnly(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Surface consommée par l'écran Assistant (C15) : ask/confirm — inchangée par C40.
 * Deux chemins derrière la même interface :
 * - HTTP (prod) : l'agent tourne CÔTÉ SERVEUR (POST /ai/ask|confirm) — autonomie clampée par
 *   l'offre, journal append-only company-scoped (TODO ⑧ de l'audit C15) ;
 * - Local (démo) : BobAgent @bob/ai instancié on-device, actions déléguées au BobClient.
 */
export interface BobAssistant {
  ask(message: string, opts?: AskOptions): Promise<Result<AgentRun, AppError>>;
  confirm(pending: PendingAction): Promise<Result<AgentRun, AppError>>;
}

/** Chemin serveur (C40 ⑧) : mêmes DTO que l'agent local (AgentRun/PendingAction transitent en JSON). */
function makeServerAssistant(client: BobClient): BobAssistant {
  return {
    async ask(message, opts = {}) {
      // Le serveur traite ask() d'un bloc : on affiche honnêtement la phase « je comprends »
      // (pas de phase « j'agis » inventée — le flux de phases fines reste un atout du mode local).
      opts.onPhase?.('comprends');
      return client.askBob({ message, ...(opts.autonomy !== undefined ? { autonomy: opts.autonomy } : {}) });
    },
    async confirm(pending) {
      return client.confirmBob(pending);
    },
  };
}

/**
 * Construit l'assistant Bob pour l'app. En mode connecté (HttpBobClient), ask/confirm sont routés
 * par le SERVEUR — parité C15 conservée (cartes d'action, pending rejouable, choices, navigate).
 * En mode local, l'agent @bob/ai tourne on-device : ses ACTIONS s'appuient sur le BobClient (donc
 * les mêmes use cases que l'UI manuelle) — parité totale. Les clés LLM vivent côté backend ; sur
 * le device, le routeur tombe en mode démo déterministe.
 */
export function makeBobAgent(client: BobClient): BobAssistant {
  if (client instanceof HttpBobClient) return makeServerAssistant(client);
  const actions: BobActions = {
    async computePayout() {
      const r = await client.getCashflow({ scenario: 'realiste', horizon: 30 });
      if (!r.ok) return r;
      return ok({ payoutCents: r.value.payout, availableCents: r.value.available });
    },
    // C25 ① : brouillon CIBLABLE (invoiceId/customerId), dérivé du plan de relances réel
    // (@bob/core deriveRelancePlan — ton escaladé par ancienneté, reste dû netToPay − paid).
    // Défaut sans cible : la plus urgente du plan (retard puis montant) — fini le « plus gros
    // encours, J+7 inventé » pointé par l'audit parité C15.
    async draftRelance(input) {
      const [inv, cust] = await Promise.all([client.listInvoices(), client.listCustomers()]);
      if (!inv.ok) return inv;
      if (!cust.ok) return cust;
      const plan = deriveRelancePlan({ invoices: inv.value, customers: cust.value, today: localDateOnly() });
      const entry = input?.invoiceId
        ? plan.find((e) => e.invoiceId === input.invoiceId)
        : input?.customerId
          ? plan.find((e) => e.customerId === input.customerId)
          : plan[0];
      if (!entry) {
        return ok(
          input?.invoiceId || input?.customerId
            ? { subject: 'Rien à relancer pour cette cible', body: 'Aucun retard sur cette cible — facture réglée ou pas encore échue. Je ne relance pas pour rien.' }
            : { subject: 'Rien à relancer', body: 'Aucune facture en retard — tout est réglé ou dans les temps. 🎉' },
        );
      }
      return ok({ subject: entry.message.subject, body: entry.message.body });
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
    // —— Parité C15 TODO ④ : outil creer_devis — même use case CreateQuote que l'écran devis ——
    async createQuote(input) {
      const r = await client.createQuote({
        customerId: input.customerId,
        lines: input.lines,
        ...(input.depositPct !== undefined ? { depositPct: input.depositPct } : {}),
      });
      if (!r.ok) return r;
      return ok({ quoteId: r.value.quoteId });
    },
    // —— Parité C15 TODO ③ : outil scan_depense — même use case RecordExpense que l'écran Documents
    // (l'extraction OCR reste côté UI : Bob enregistre une dépense déjà chiffrée, jamais inventée) ——
    async recordExpense(input) {
      return client.recordExpense({
        supplierName: input.supplierName,
        documentDate: input.documentDate ?? localDateOnly(),
        totalTtcCents: input.totalTtcCents,
        category: input.category,
        vatRatePct: input.vatRatePct ?? null,
        source: 'manual',
      });
    },
    // —— Parité C15 TODO ⑤ (C40) : outil generer_facture — même use case GenerateInvoiceFromQuote ——
    async generateInvoice(input) {
      return client.generateInvoice({ quoteId: input.quoteId, ...(input.mode !== undefined ? { mode: input.mode } : {}) });
    },
    // —— Parité C15 TODO ⑥ (C40) : outil export_fec — même use case ExportFec que l'écran compta
    // (l'agent reçoit le RÉSUMÉ ; le téléchargement/partage du fichier reste un geste d'écran) ——
    async exportFec(input) {
      const r = await client.exportFec(input);
      if (!r.ok) return r;
      return ok({
        filename: r.value.filename,
        entryCount: r.value.entryCount,
        rowCount: r.value.rowCount,
        warnings: [...r.value.warnings],
      });
    },
    // —— TODO partagé C12/C40 : outil creer_client — même use case createCustomer que l'écran Clients
    // (fiche minimale : défauts neutres, adresse à compléter dans l'app — rien d'inventé) ——
    async createCustomer(input) {
      return client.createCustomer({
        name: input.name,
        type: input.type,
        address: { line1: '', zip: '', city: '' },
        score: 100,
        avgDelayDays: 0,
        outstanding: 0,
      });
    },
  };
  return new BobAgent({ router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }), actions });
}

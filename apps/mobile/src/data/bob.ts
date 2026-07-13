import {
  BobAgent,
  ModelRouter,
  type AgentRun,
  type AskOptions,
  type BobActions,
  type PayableInvoice,
  type PendingAction,
  type InvoiceableQuote,
  type SendableQuote,
  type IssuableInvoice,
  type AgentDocument,
  accountingJournalLabel, chantierStatusLabel, customerTypeLabel, documentKindLabel, documentStatusLabel, expenseCategoryLabel, expenseStatusLabel, frDateLabel, invoiceKindLabel, invoiceStatusLabel, quoteStatusLabel,
} from '@bob/ai';
import { ok, deriveRelancePlan, formatEUR, type AppError, type Result } from '@bob/core';
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
      return client.askBob({
        message,
        ...(opts.autonomy !== undefined ? { autonomy: opts.autonomy } : {}),
        ...(opts.history !== undefined ? { history: opts.history } : {}),
        ...(opts.tone !== undefined ? { tone: opts.tone } : {}),
        ...(opts.context !== undefined ? { context: opts.context } : {}),
      });
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
    async readContextEntity(input) {
      const notFound = () =>
        ({
          ok: false,
          error: { kind: 'not_found', entity: input.type, id: input.id },
        }) as const;

      if (input.type === 'invoice') {
        const [invoices, customers] = await Promise.all([
          client.listInvoices(),
          client.listCustomers(),
        ]);
        if (!invoices.ok) return invoices;
        if (!customers.ok) return customers;
        const invoice = invoices.value.find((candidate) => candidate.id === input.id);
        if (!invoice) return notFound();
        const customer = customers.value.find((candidate) => candidate.id === invoice.customerId);
        const remaining = Math.max(0, invoice.totals.netToPay - invoice.paid);
        return ok({
          type: input.type,
          id: invoice.id,
          label: invoice.number ? `Facture ${invoice.number}` : 'Facture brouillon',
          facts: [
            { label: 'Statut', value: invoiceStatusLabel(invoice.status) },
            { label: 'Type', value: invoiceKindLabel(invoice.kind) },
            ...(customer ? [{ label: 'Client', value: customer.name }] : []),
            { label: 'Total TTC', value: formatEUR(invoice.totals.ttc) },
            { label: 'Reste dû', value: formatEUR(remaining) },
            ...(invoice.dueAt ? [{ label: 'Échéance', value: frDateLabel(invoice.dueAt) }] : []),
          ],
        });
      }

      if (input.type === 'quote') {
        const [quotes, customers] = await Promise.all([
          client.listQuotes(),
          client.listCustomers(),
        ]);
        if (!quotes.ok) return quotes;
        if (!customers.ok) return customers;
        const quote = quotes.value.find((candidate) => candidate.id === input.id);
        if (!quote) return notFound();
        const customer = customers.value.find((candidate) => candidate.id === quote.customerId);
        return ok({
          type: input.type,
          id: quote.id,
          label: quote.number ? `Devis ${quote.number}` : 'Devis brouillon',
          facts: [
            { label: 'Statut', value: quoteStatusLabel(quote.status) },
            ...(customer ? [{ label: 'Client', value: customer.name }] : []),
            { label: 'Total TTC', value: formatEUR(quote.totals.ttc) },
            { label: 'Lignes', value: String(quote.lines.length) },
            ...(quote.depositPct !== null
              ? [{ label: 'Acompte', value: `${quote.depositPct} %` }]
              : []),
          ],
        });
      }

      if (input.type === 'invoice_line') {
        const invoices = await client.listInvoices();
        if (!invoices.ok) return invoices;
        const matches = invoices.value.flatMap((invoice) =>
          invoice.lines
            .filter((line) => line.id === input.id)
            .map((line) => ({ invoice, line })),
        );
        if (matches.length !== 1) return notFound();
        const { invoice, line } = matches[0]!;
        const lineTotalHt = Math.round(line.qty * line.unitPriceHT);
        return ok({
          type: input.type,
          id: line.id,
          label: line.label,
          facts: [
            { label: 'Facture', value: invoice.number ?? 'Brouillon' },
            { label: 'Quantité', value: `${line.qty}${line.unit ? ` ${line.unit}` : ''}` },
            { label: 'Prix unitaire HT', value: formatEUR(line.unitPriceHT) },
            { label: 'Total HT', value: formatEUR(lineTotalHt) },
            { label: 'TVA', value: `${line.vatRate} %` },
          ],
        });
      }

      if (input.type === 'quote_line') {
        const quotes = await client.listQuotes();
        if (!quotes.ok) return quotes;
        const matches = quotes.value.flatMap((quote) =>
          quote.lines
            .filter((line) => line.id === input.id)
            .map((line) => ({ quote, line })),
        );
        if (matches.length !== 1) return notFound();
        const { quote, line } = matches[0]!;
        const lineTotalHt = Math.round(line.qty * line.unitPriceHT);
        return ok({
          type: input.type,
          id: line.id,
          label: line.label,
          facts: [
            { label: 'Devis', value: quote.number ?? 'Brouillon' },
            { label: 'Quantité', value: `${line.qty}${line.unit ? ` ${line.unit}` : ''}` },
            { label: 'Prix unitaire HT', value: formatEUR(line.unitPriceHT) },
            { label: 'Total HT', value: formatEUR(lineTotalHt) },
            { label: 'TVA', value: `${line.vatRate} %` },
          ],
        });
      }

      if (input.type === 'customer') {
        const customers = await client.listCustomers();
        if (!customers.ok) return customers;
        const customer = customers.value.find((candidate) => candidate.id === input.id);
        if (!customer) return notFound();
        return ok({
          type: input.type,
          id: customer.id,
          label: customer.name,
          facts: [
            { label: 'Type', value: customerTypeLabel(customer.type) },
            { label: 'Encours', value: formatEUR(customer.outstanding) },
            { label: 'Délai moyen', value: `${customer.avgDelayDays} jours` },
            { label: 'Score', value: `${customer.score}/100` },
          ],
        });
      }

      if (input.type === 'expense') {
        const expenses = await client.listExpenses();
        if (!expenses.ok) return expenses;
        const expense = expenses.value.find((candidate) => candidate.id === input.id);
        if (!expense) return notFound();
        return ok({
          type: input.type,
          id: expense.id,
          label: expense.supplierName,
          facts: [
            { label: 'Statut', value: expenseStatusLabel(expense.status) },
            { label: 'Catégorie', value: expenseCategoryLabel(expense.category) },
            { label: 'Total TTC', value: formatEUR(expense.totalTtcCents) },
            { label: 'Date', value: frDateLabel(expense.documentDate) },
          ],
        });
      }

      if (input.type === 'document') {
        const documents = await client.listDocuments();
        if (!documents.ok) return documents;
        const document = documents.value.find((candidate) => candidate.id === input.id);
        if (!document) return notFound();
        return ok({
          type: input.type,
          id: document.id,
          label: document.filename,
          facts: [
            { label: 'Type', value: documentKindLabel(document.kind) },
            { label: 'Statut', value: documentStatusLabel(document.status) },
            { label: 'Version', value: String(document.version) },
            ...(document.documentDate ? [{ label: 'Date', value: frDateLabel(document.documentDate) }] : []),
          ],
        });
      }

      if (input.type === 'accounting_entry') {
        const entries = await client.listAccountingEntries();
        if (!entries.ok) return entries;
        const entry = entries.value.find((candidate) => candidate.id === input.id);
        if (!entry) return notFound();
        const debit = entry.lines.reduce((sum, line) => sum + line.debitCents, 0);
        const credit = entry.lines.reduce((sum, line) => sum + line.creditCents, 0);
        return ok({
          type: input.type,
          id: entry.id,
          label: `${entry.reference} — ${entry.label}`,
          facts: [
            { label: 'Journal', value: accountingJournalLabel(entry.journal) },
            { label: 'Date', value: frDateLabel(entry.entryDate) },
            { label: 'Débit', value: formatEUR(debit) },
            { label: 'Crédit', value: formatEUR(credit) },
            ...(debit !== credit ? [{ label: 'Alerte', value: 'écriture déséquilibrée' }] : []),
          ],
        });
      }

      if (input.type === 'notification') {
        const notifications = await client.listNotifications();
        if (!notifications.ok) return notifications;
        const notification = notifications.value.find((candidate) => candidate.id === input.id);
        if (!notification) return notFound();
        return ok({
          type: input.type,
          id: notification.id,
          label: notification.title,
          facts: [
            { label: 'Statut', value: notification.readAt !== null ? 'Lue' : 'Non lue' },
            { label: 'Reçue le', value: frDateLabel(notification.createdAt) },
            ...(notification.body !== null ? [{ label: 'Contenu', value: notification.body }] : []),
          ],
        });
      }

      if (input.type === 'chantier') {
        const chantiers = await client.listChantiers();
        if (!chantiers.ok) return chantiers;
        const chantier = chantiers.value.find((candidate) => candidate.id === input.id);
        if (!chantier) return notFound();
        return ok({
          type: input.type,
          id: chantier.id,
          label: chantier.name,
          facts: [
            { label: 'Statut', value: chantierStatusLabel(chantier.status) },
            { label: 'Ouvert le', value: frDateLabel(chantier.openedAt) },
            ...(chantier.address ? [{ label: 'Adresse', value: chantier.address }] : []),
          ],
        });
      }

      return notFound();
    },
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
      const plan = deriveRelancePlan({
        invoices: inv.value,
        customers: cust.value,
        today: localDateOnly(),
      });
      const entry = input?.invoiceId
        ? plan.find((e) => e.invoiceId === input.invoiceId)
        : input?.customerId
          ? plan.find((e) => e.customerId === input.customerId)
          : plan[0];
      if (!entry) {
        return ok(
          input?.invoiceId || input?.customerId
            ? {
                subject: 'Rien à relancer pour cette cible',
                body: 'Aucun retard sur cette cible — facture réglée ou pas encore échue. Je ne relance pas pour rien.',
              }
            : {
                subject: 'Rien à relancer',
                body: 'Aucune facture en retard — tout est réglé ou dans les temps. 🎉',
              },
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
    // ASK-2 : devis SIGNÉS facturables — mêmes listes client que l'UI ; un devis sort
    // dès que sa finale existe ; l'acompte déjà émis rend la finale évidente (pas de question).
    async listInvoiceableQuotes() {
      const [q, inv, cust] = await Promise.all([
        client.listQuotes(),
        client.listInvoices(),
        client.listCustomers(),
      ]);
      if (!q.ok) return q;
      if (!inv.ok) return inv;
      const names = new Map((cust.ok ? cust.value : []).map((c) => [c.id, c.name]));
      const quotes: InvoiceableQuote[] = q.value
        .filter((x) => x.status === 'signed')
        .filter(
          (x) =>
            !inv.value.some(
              (i) => i.parentQuoteId === x.id && i.kind === 'final' && i.status !== 'cancelled',
            ),
        )
        .map((x) => ({
          id: x.id,
          number: x.number,
          customerName: names.get(x.customerId) ?? 'Client',
          totalTtcCents: x.totals.ttc,
          depositPct: x.depositPct,
          depositInvoiced: inv.value.some(
            (i) => i.parentQuoteId === x.id && i.kind === 'deposit' && i.status !== 'cancelled',
          ),
        }));
      return ok(quotes);
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
        idempotencyKey:
          input.idempotencyKey ??
          `mobile-bob:payment:${input.invoiceId}:${input.amountCents}:transfer`,
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
      return client.generateInvoice({
        quoteId: input.quoteId,
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
      });
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
    // —— Parité C15 TODO ② (C25) : outil envoyer_relance — MÊME endpoint que le bouton
    // « Relancer » de l'écran Notifications (client.sendRelance). Sortant : plancher de
    // confirmation posé par le registre (mise en demeure possible, jamais sans validation).
    async sendRelance(input) {
      const r = await client.sendRelance(input.invoiceId);
      if (!r.ok) return r;
      return ok({
        jobId: r.value.jobId,
        status: r.value.status,
        ...(r.value.tone !== undefined ? { tone: r.value.tone } : {}),
      });
    },
  };
  return new BobAgent({
    router: new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }),
    actions,
  });
}

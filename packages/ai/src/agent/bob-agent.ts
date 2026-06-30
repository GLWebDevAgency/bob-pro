import { type Result, ok, err, type AppError, formatEUR } from '@bob/core';
import { ModelRouter, type ModelChoice } from '../router/model-router';
import { renderWithGuard } from '../guardrails/money-guard';
import { type BobActions, type PayableInvoice } from './actions';
import { buildBobTools } from '../tools/registry';
import { type AnyTool } from '../tools/tool';
import { type AgentAutonomy, DEFAULT_AUTONOMY, requiresConfirmation } from './autonomy';

export type BobIntent = 'payout' | 'relance' | 'encaisser' | 'factures' | 'unknown';
export type AgentRunKind = 'answer' | 'proposed' | 'done';

export interface ActionCard {
  title: string;
  body: string;
}

export interface PendingAction {
  tool: string;
  args: Record<string, unknown>;
  /** Libellé lisible de l'action proposée (affiché sur le bouton de confirmation). */
  label: string;
}

export interface AgentRun {
  kind: AgentRunKind;
  intent: BobIntent;
  model: ModelChoice;
  plan: string[];
  card: ActionCard;
  /** Présent quand kind === 'proposed' : action à confirmer puis à exécuter via confirm(). */
  pending?: PendingAction;
}

export function detectIntent(message: string): BobIntent {
  const m = message.toLowerCase();
  // « payé(e/s) » = participe (paiement reçu) ; « payer/verser » = se verser (payout) — d'où la distinction.
  if (/(encaiss|paiement re[çc]u|re[çc]u le paiement|marque.*pay|r[ée]gl[ée]|\bpay[ée]e?s?\b)/.test(m)) return 'encaisser';
  if (/(liste|mes factures|factures impay|reste (à|a) encaisser|à encaisser)/.test(m)) return 'factures';
  if (/(relanc|rappel|en retard|impay)/.test(m)) return 'relance';
  if (/(verser|me paye|me payer|combien|salaire)/.test(m)) return 'payout';
  return 'unknown';
}

/** Résout la facture visée par le message parmi les factures encaissables. null = ambigu. */
export function resolveInvoice(message: string, invoices: PayableInvoice[]): PayableInvoice | null {
  if (invoices.length === 0) return null;
  const numMatch = message.match(/\d{3,}(?:-\d+)?/);
  if (numMatch) {
    const ref = numMatch[0].replace(/\s/g, '');
    const byNum = invoices.find((i) => i.number.replace(/\s/g, '').includes(ref));
    if (byNum) return byNum;
  }
  const lower = message.toLowerCase();
  const byCust = invoices.find((i) => {
    const first = i.customerName.toLowerCase().split(/\s+/)[0] ?? '';
    return first.length >= 3 && lower.includes(first);
  });
  if (byCust) return byCust;
  return invoices.length === 1 ? invoices[0]! : null;
}

export interface BobAgentDeps {
  router: ModelRouter;
  actions: BobActions;
}

export interface AskOptions {
  autonomy?: AgentAutonomy;
}

/**
 * Cerveau agentique de Bob. Mappe une demande en langage naturel vers un OUTIL (= use case),
 * applique la politique de confirmation (autonomie), puis exécute. Parité totale : tout ce que
 * l'utilisateur fait à la main passe par les mêmes use cases que Bob.
 */
export class BobAgent {
  private readonly tools: AnyTool[];

  constructor(private readonly deps: BobAgentDeps) {
    this.tools = buildBobTools(deps.actions);
  }

  private tool(name: string): AnyTool | undefined {
    return this.tools.find((t) => t.name === name);
  }

  async ask(message: string, opts: AskOptions = {}): Promise<Result<AgentRun, AppError>> {
    const autonomy = opts.autonomy ?? DEFAULT_AUTONOMY;
    const model = this.deps.router.route('agent.plan').model;
    const intent = detectIntent(message);

    if (intent === 'payout') {
      const r = await this.deps.actions.computePayout();
      if (!r.ok) return err(r.error);
      const guard = renderWithGuard(
        'Tu peux te verser {{payout}} sans risque. Je garde le reste pour la TVA et les charges.',
        [{ token: 'payout', cents: r.value.payoutCents }],
      );
      if (!guard.ok) return err({ kind: 'dependency', port: 'money-guard', cause: guard.violations.join(', ') });
      return ok({
        kind: 'answer',
        intent,
        model,
        plan: ['Lire la trésorerie réelle', 'Calculer le versement sans risque'],
        card: { title: 'Combien tu peux te verser', body: guard.rendered },
      });
    }

    if (intent === 'relance') {
      const r = await this.deps.actions.draftRelance();
      if (!r.ok) return err(r.error);
      return ok({
        kind: 'answer',
        intent,
        model,
        plan: ['Repérer la facture en retard', 'Rédiger la relance'],
        card: { title: r.value.subject, body: r.value.body },
      });
    }

    if (intent === 'factures') {
      const r = await this.deps.actions.listPayableInvoices();
      if (!r.ok) return err(r.error);
      const body = r.value.length
        ? r.value.map((i) => `• ${i.number} — ${i.customerName} : ${formatEUR(i.remainingCents)}`).join('\n')
        : 'Aucune facture en attente d’encaissement. 🎉';
      return ok({ kind: 'answer', intent, model, plan: ['Lister les factures impayées'], card: { title: 'À encaisser', body } });
    }

    if (intent === 'encaisser') {
      const r = await this.deps.actions.listPayableInvoices();
      if (!r.ok) return err(r.error);
      const invoice = resolveInvoice(message, r.value);
      if (!invoice) {
        const body = r.value.length
          ? `Laquelle ?\n${r.value.map((i) => `• ${i.number} — ${i.customerName} : ${formatEUR(i.remainingCents)}`).join('\n')}`
          : 'Aucune facture en attente d’encaissement.';
        return ok({ kind: 'answer', intent, model, plan: ['Chercher la facture'], card: { title: 'Quelle facture ?', body } });
      }
      const tool = this.tool('encaisser_facture')!;
      const args = { invoiceId: invoice.id, amountCents: invoice.remainingCents };
      const label = `Encaisser ${invoice.number} · ${formatEUR(invoice.remainingCents)} (${invoice.customerName})`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Identifier la facture', 'Préparer l’encaissement', 'Attendre ta confirmation'],
          card: { title: 'Encaissement à confirmer', body: `${label}\nDate : aujourd’hui. Je valide ?` },
          pending: { tool: tool.name, args, label },
        });
      }
      const run = await tool.run(args);
      if (!run.ok) return err(run.error);
      return ok({
        kind: 'done',
        intent,
        model,
        plan: ['Identifier la facture', 'Enregistrer l’encaissement'],
        card: { title: 'Encaissé ✓', body: `${label} — c’est noté.` },
      });
    }

    return ok({
      kind: 'answer',
      intent: 'unknown',
      model,
      plan: ['Comprendre la demande'],
      card: {
        title: 'Bob',
        body: 'Je peux : encaisser une facture (« encaisse la facture 2026-014 »), lister tes impayés, préparer une relance, ou calculer ce que tu peux te verser.',
      },
    });
  }

  /** Exécute une action précédemment proposée (après confirmation utilisateur). */
  async confirm(pending: PendingAction): Promise<Result<AgentRun, AppError>> {
    const tool = this.tool(pending.tool);
    if (!tool) return err({ kind: 'not_found', entity: 'tool', id: pending.tool });
    const parsed = tool.parse(pending.args);
    if (!parsed.ok) return err(parsed.error);
    const run = await tool.run(parsed.value);
    if (!run.ok) return err(run.error);
    const model = this.deps.router.route('agent.plan').model;
    return ok({
      kind: 'done',
      intent: 'encaisser',
      model,
      plan: ['Exécuter l’action confirmée'],
      card: { title: 'Fait ✓', body: `${pending.label} — c’est noté.` },
    });
  }
}

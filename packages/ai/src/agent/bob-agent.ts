import { type Result, ok, err, type AppError, formatEUR } from '@bob/core';
import { ModelRouter, type ModelChoice } from '../router/model-router';
import { renderWithGuard } from '../guardrails/money-guard';
import { type LlmPort } from '../llm/port';
import { type BobActions, type PayableInvoice } from './actions';
import { buildBobTools } from '../tools/registry';
import { type AnyTool } from '../tools/tool';
import { type AgentAutonomy, DEFAULT_AUTONOMY, requiresConfirmation } from './autonomy';
import { type BobIntent, detectIntent } from './intent';
import { classifyWithLlm, classifyWithRegex } from './classifier';
import {
  AgentRuntime,
  type RuntimeInvocation,
  type RuntimeOptions,
  type AgentRunRecord,
  type ActionPolicy,
  type JournalStore,
  type RuntimeClock,
  type RuntimeIds,
} from '../runtime';
import { buildSpokenConfirmation, parseVoiceConsent } from '../voice/voice-confirm';

// Ré-export pour compatibilité (anciens imports depuis bob-agent).
export { detectIntent };
export type { BobIntent };

export type AgentRunKind = 'answer' | 'proposed' | 'done';

export interface ActionCard {
  title: string;
  body: string;
}

export interface BatchItem {
  tool: string;
  args: Record<string, unknown>;
  label: string;
}

export interface PendingAction {
  tool: string;
  args: Record<string, unknown>;
  /** Libellé lisible de l'action proposée (affiché sur le bouton de confirmation). */
  label: string;
  /** Pour un plan multi-étapes : la suite d'actions à exécuter en lot après confirmation. */
  batch?: BatchItem[];
}

/** Choix proposé en cas d'ambiguïté (rendu comme boutons / modale côté UI). */
export interface AgentChoice {
  label: string;
  /** Valeur à renvoyer (ex. numéro de facture) si l'utilisateur sélectionne ce choix. */
  value: string;
}

export interface AgentRun {
  kind: AgentRunKind;
  intent: BobIntent;
  /** Modèle effectif (provider routé, id de modèle réel, ou « demo »). */
  model: string;
  plan: string[];
  card: ActionCard;
  /** Présent quand kind === 'proposed' : action à confirmer puis à exécuter via confirm(). */
  pending?: PendingAction;
  /** Présent en cas d'ambiguïté : options à présenter à l'utilisateur (modale de choix). */
  choices?: AgentChoice[];
  /** Présent pour une commande de navigation : route vers laquelle l'app doit rediriger (ex. /scan-document). */
  navigate?: string;
  /** Texte à vocaliser (TTS) : prompt de confirmation parlé (action proposée) ou message parlé (annulation/re-demande). */
  spokenPrompt?: string;
}

/** Intents de navigation : Bob ouvre le bon écran (façon « Jarvis »). */
const NAV_ROUTES: Partial<Record<BobIntent, { route: string; title: string; body: string }>> = {
  scan: { route: '/scan-document', title: 'J’ouvre le scan', body: 'Prends le reçu / ticket en photo — je lis et je classe.' },
  nouveau_devis: { route: '/devis/new', title: 'Nouveau devis', body: 'Je t’ouvre l’écran de création de devis.' },
  voir_chantiers: { route: '/chantiers', title: 'Tes chantiers', body: 'J’ouvre tes chantiers.' },
};

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

/** Convertit une action proposée (simple ou lot) en invocations rejouables par le runtime. */
export function pendingToInvocations(pending: PendingAction): RuntimeInvocation[] {
  if (pending.batch && pending.batch.length > 0) {
    return pending.batch.map((b) => ({ tool: b.tool, args: b.args, label: b.label }));
  }
  return [{ tool: pending.tool, args: pending.args, label: pending.label }];
}

/** Config optionnelle du runtime agentique (journal immuable + dry-run + rejeu + permissions par action). */
export interface BobRuntimeConfig {
  clock: RuntimeClock;
  ids: RuntimeIds;
  policy?: ActionPolicy;
  store?: JournalStore;
}

export interface BobAgentDeps {
  router: ModelRouter;
  actions: BobActions;
  /** Optionnel : si fourni (clé configurée), Bob qualifie la demande par tool-calling LLM. Sinon regex. */
  llm?: LlmPort;
  /** Optionnel : active dryRun()/runJournaled() (audit append-only + permissions par action). */
  runtime?: BobRuntimeConfig;
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
  private readonly engine?: AgentRuntime;

  constructor(private readonly deps: BobAgentDeps) {
    this.tools = buildBobTools(deps.actions);
    if (deps.runtime) {
      this.engine = new AgentRuntime({
        tools: this.tools,
        clock: deps.runtime.clock,
        ids: deps.runtime.ids,
        ...(deps.runtime.policy ? { policy: deps.runtime.policy } : {}),
        ...(deps.runtime.store ? { store: deps.runtime.store } : {}),
      });
    }
  }

  private tool(name: string): AnyTool | undefined {
    return this.tools.find((t) => t.name === name);
  }

  /** Qualifie la demande : LLM tool-calling si disponible (avec repli déterministe), sinon regex. */
  private async classify(message: string, routedModel: ModelChoice) {
    if (this.deps.llm && routedModel !== 'demo') {
      try {
        return await classifyWithLlm(this.deps.llm, message);
      } catch {
        // LLM indisponible : on retombe sur la détection déterministe (jamais bloquant).
      }
    }
    return classifyWithRegex(message);
  }

  async ask(message: string, opts: AskOptions = {}): Promise<Result<AgentRun, AppError>> {
    const autonomy = opts.autonomy ?? DEFAULT_AUTONOMY;
    const routed = this.deps.router.route('intent.detect');
    const plan = await this.classify(message, routed.model);
    const model = plan.model !== 'demo' ? plan.model : routed.model;
    const steps = plan.steps.filter((s) => s.intent !== 'unknown');

    if (steps.length === 0) return ok(this.unknownRun(model));
    if (steps.length > 1) return this.runMulti(steps, autonomy, model);
    return this.runSingle(steps[0]!, autonomy, model, message);
  }

  private unknownRun(model: string): AgentRun {
    return {
      kind: 'answer',
      intent: 'unknown',
      model,
      plan: ['Comprendre la demande'],
      card: {
        title: 'Bob',
        body:
          'Je ne traite que l’administratif et le financier de ton activité (je ne réponds pas aux questions hors de ce périmètre). ' +
          'Je peux : encaisser une facture (« encaisse la facture 2026-014 »), lister tes impayés, préparer une relance, ou calculer ce que tu peux te verser.',
      },
    };
  }

  /** Exécute une demande à UNE étape (comportement historique, cartes riches). */
  private async runSingle(
    step: { intent: BobIntent; reference: string | null },
    autonomy: AgentAutonomy,
    model: string,
    message: string,
  ): Promise<Result<AgentRun, AppError>> {
    const intent = step.intent;
    const reference = step.reference;

    const nav = NAV_ROUTES[intent];
    if (nav) {
      return ok({ kind: 'done', intent, model, plan: [nav.title], card: { title: nav.title, body: nav.body }, navigate: nav.route });
    }

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
      const invoice = resolveInvoice(reference ?? message, r.value);
      if (!invoice) {
        const body = r.value.length ? 'Laquelle veux-tu encaisser ?' : 'Aucune facture en attente d’encaissement.';
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Chercher la facture'],
          card: { title: 'Quelle facture ?', body },
          choices: r.value.map((i) => ({ label: `${i.number} — ${i.customerName} · ${formatEUR(i.remainingCents)}`, value: i.number })),
        });
      }
      const tool = this.tool('encaisser_facture')!;
      const args = {
        invoiceId: invoice.id,
        amountCents: invoice.remainingCents,
        idempotencyKey: `bob:payment:${invoice.id}:${invoice.remainingCents}:transfer`,
      };
      const label = `Encaisser ${invoice.number} · ${formatEUR(invoice.remainingCents)} (${invoice.customerName})`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Identifier la facture', 'Préparer l’encaissement', 'Attendre ta confirmation'],
          card: { title: 'Encaissement à confirmer', body: `${label}\nDate : aujourd’hui. Je valide ?` },
          pending: { tool: tool.name, args, label },
          spokenPrompt: buildSpokenConfirmation(label),
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

    return ok(this.unknownRun(model)); // ne devrait pas arriver (unknown filtré en amont)
  }

  /**
   * Plan à PLUSIEURS étapes (ex. « encaisse Durand puis relance Martin »). Stratégie « batch » :
   * on résout tout d'abord ; si une étape est ambiguë -> on demande de préciser (rien exécuté) ;
   * si une action modifiante requiert confirmation (selon l'autonomie) -> on propose TOUT le lot à
   * confirmer ; sinon on exécute tout en ordre. Simple et fiable (pas d'état de reprise complexe).
   */
  private async runMulti(
    steps: { intent: BobIntent; reference: string | null }[],
    autonomy: AgentAutonomy,
    model: string,
  ): Promise<Result<AgentRun, AppError>> {
    const headIntent = steps[0]?.intent ?? 'unknown';
    let payables: PayableInvoice[] = [];
    if (steps.some((s) => s.intent === 'encaisser')) {
      const r = await this.deps.actions.listPayableInvoices();
      if (!r.ok) return err(r.error);
      payables = r.value;
    }
    const actions: BatchItem[] = [];
    for (const step of steps) {
      if (step.intent === 'encaisser') {
        const inv = resolveInvoice(step.reference ?? '', payables);
        if (!inv) {
          const body = payables.length ? 'Précise la facture à encaisser :' : 'Aucune facture en attente d’encaissement.';
          return ok({
            kind: 'answer',
            intent: 'encaisser',
            model,
            plan: ['Lever l’ambiguïté'],
            card: { title: 'Quelle facture ?', body },
            choices: payables.map((i) => ({ label: `${i.number} — ${i.customerName} · ${formatEUR(i.remainingCents)}`, value: i.number })),
          });
        }
        payables = payables.filter((i) => i.id !== inv.id); // évite de ré-encaisser la même dans le lot
        actions.push({
          tool: 'encaisser_facture',
          args: {
            invoiceId: inv.id,
            amountCents: inv.remainingCents,
            idempotencyKey: `bob:payment:${inv.id}:${inv.remainingCents}:transfer`,
          },
          label: `Encaisser ${inv.number} · ${formatEUR(inv.remainingCents)} (${inv.customerName})`,
        });
      } else if (step.intent === 'payout') {
        actions.push({ tool: 'tresorerie_versement', args: {}, label: 'Calculer ton versement possible' });
      } else if (step.intent === 'relance') {
        actions.push({ tool: 'relance_brouillon', args: {}, label: 'Préparer une relance' });
      } else if (step.intent === 'factures') {
        actions.push({ tool: 'factures_impayees', args: {}, label: 'Lister tes impayés' });
      }
    }
    if (actions.length === 0) return ok(this.unknownRun(model));

    const needConfirm = actions.some((a) => {
      const t = this.tool(a.tool);
      return t ? requiresConfirmation(t, autonomy) : false;
    });
    const listing = actions.map((a, i) => `${i + 1}. ${a.label}`).join('\n');
    if (needConfirm) {
      return ok({
        kind: 'proposed',
        intent: headIntent,
        model,
        plan: actions.map((a) => a.label),
        card: { title: `${actions.length} actions à confirmer`, body: `Je vais :\n${listing}\nJe valide tout ?` },
        pending: { tool: 'batch', args: {}, label: listing, batch: actions },
        spokenPrompt: buildSpokenConfirmation(`${actions.length} actions : ${actions.map((a) => a.label).join(', ')}`),
      });
    }
    const r = await this.runBatch(actions);
    if (!r.ok) return err(r.error);
    return ok({ kind: 'done', intent: headIntent, model, plan: actions.map((a) => a.label), card: { title: 'Fait ✓', body: r.value } });
  }

  /** Exécute une suite d'actions en ordre, renvoie un récapitulatif ligne par ligne. */
  private async runBatch(actions: BatchItem[]): Promise<Result<string, AppError>> {
    const lines: string[] = [];
    for (const a of actions) {
      const tool = this.tool(a.tool);
      if (!tool) return err({ kind: 'not_found', entity: 'tool', id: a.tool });
      const parsed = tool.parse(a.args);
      if (!parsed.ok) return err(parsed.error);
      const run = await tool.run(parsed.value);
      if (!run.ok) return err(run.error);
      lines.push(`✓ ${a.label}`);
    }
    return ok(lines.join('\n'));
  }

  /** Exécute une action (ou un lot) précédemment proposé, après confirmation utilisateur. */
  async confirm(pending: PendingAction): Promise<Result<AgentRun, AppError>> {
    const model = this.deps.router.route('agent.plan').model;
    if (pending.batch && pending.batch.length > 0) {
      const r = await this.runBatch(pending.batch);
      if (!r.ok) return err(r.error);
      return ok({ kind: 'done', intent: 'encaisser', model, plan: pending.batch.map((a) => a.label), card: { title: 'Fait ✓', body: r.value } });
    }
    const tool = this.tool(pending.tool);
    if (!tool) return err({ kind: 'not_found', entity: 'tool', id: pending.tool });
    const parsed = tool.parse(pending.args);
    if (!parsed.ok) return err(parsed.error);
    const run = await tool.run(parsed.value);
    if (!run.ok) return err(run.error);
    return ok({
      kind: 'done',
      intent: 'encaisser',
      model,
      plan: ['Exécuter l’action confirmée'],
      card: { title: 'Fait ✓', body: `${pending.label} — c’est noté.` },
    });
  }

  private requireEngine(): AgentRuntime {
    if (!this.engine) {
      throw new Error('BobAgent: runtime non configuré — fournis deps.runtime (clock + ids) pour dryRun/runJournaled.');
    }
    return this.engine;
  }

  /**
   * Aperçu SANS effet de bord : évalue permissions + validation de chaque action et journalise en
   * 'planned', mais N'EXÉCUTE RIEN. Sert à confirmer un plan (« voici ce que je vais faire ») avant exécution.
   */
  async dryRun(invocations: RuntimeInvocation[], opts: Omit<RuntimeOptions, 'mode'> = {}): Promise<AgentRunRecord> {
    return this.requireEngine().run(invocations, { ...opts, mode: 'dry-run' });
  }

  /** Exécution JOURNALISÉE (audit append-only immuable) avec permissions par action. */
  async runJournaled(invocations: RuntimeInvocation[], opts: Omit<RuntimeOptions, 'mode'> = {}): Promise<AgentRunRecord> {
    return this.requireEngine().run(invocations, { ...opts, mode: 'live' });
  }

  /**
   * Confirmation VOCALE d'une action proposée : interprète la réponse parlée (FAIL-SAFE via parseVoiceConsent)
   * puis exécute (confirm), abandonne, ou re-demande. Jamais d'exécution sur une réponse ambiguë
   * (plancher de sécurité vocal : sur une action sensible, l'ambiguïté ne déclenche jamais l'action).
   */
  async confirmByVoice(pending: PendingAction, transcript: string): Promise<Result<AgentRun, AppError>> {
    const consent = parseVoiceConsent(transcript);
    if (consent === 'confirm') return this.confirm(pending);
    const model = this.deps.router.route('agent.plan').model;
    if (consent === 'cancel') {
      return ok({
        kind: 'answer',
        intent: 'unknown',
        model,
        plan: ['Annuler'],
        card: { title: 'Annulé', body: 'Ok, j’annule — rien n’a été fait.' },
        spokenPrompt: 'Ok, j’annule. Rien n’a été fait.',
      });
    }
    // 'unclear' -> on re-propose, aucune exécution.
    return ok({
      kind: 'proposed',
      intent: 'unknown',
      model,
      plan: ['Reformuler la confirmation'],
      card: { title: 'Je n’ai pas compris', body: `${pending.label}\nDis « je confirme » ou « annule ».` },
      pending,
      spokenPrompt: buildSpokenConfirmation(pending.label),
    });
  }
}

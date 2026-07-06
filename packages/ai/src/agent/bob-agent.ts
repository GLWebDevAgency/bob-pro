import { type Result, ok, err, type AppError, type FiscalDeadline, formatEUR } from '@bob/core';
import { ModelRouter, type ModelChoice } from '../router/model-router';
import { renderWithGuard } from '../guardrails/money-guard';
import { type LlmPort } from '../llm/port';
import { type AgentDocument, type BobActions, type IssuableInvoice, type PayableInvoice, type SendableQuote } from './actions';
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
  cloture: { route: '/cloture', title: 'Clôture du mois', body: 'Je prépare ton mois : anomalies et pièces manquantes.' },
  diagnostic: {
    route: '/diagnostic',
    title: 'Diagnostic 2026',
    body: 'Je t’ouvre le diagnostic : on vérifie ensemble que tu es prêt pour la facturation électronique.',
  },
};

/** Mots non discriminants d'une raison sociale / civilité — jamais utilisés pour cibler. */
const NAME_STOPWORDS = new Set(['sarl', 'sas', 'sasu', 'eurl', 'sci', 'ets', 'ste', 'societe', 'mme', 'mr', 'mlle']);

/** Mots significatifs (≥ 3 lettres, hors formes juridiques) d'un nom de client — « SARL Martin »
 * comme « M. Martin » se résolvent par « martin » (C25 ① : cible par nom, pas premier mot). */
function significantNameWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w));
}

/** Résout la facture visée par le message parmi les factures encaissables. null = ambigu.
 * `fallbackToSingle` (défaut true) : une seule facture = la cible implicite — désactivé pour la
 * relance (C25 ①), où seule une cible EXPLICITE (numéro / nom) doit primer sur le plan. */
export function resolveInvoice(
  message: string,
  invoices: PayableInvoice[],
  opts: { fallbackToSingle?: boolean } = {},
): PayableInvoice | null {
  if (invoices.length === 0) return null;
  const numMatch = message.match(/\d{3,}(?:-\d+)?/);
  if (numMatch) {
    const ref = numMatch[0].replace(/\s/g, '');
    const byNum = invoices.find((i) => i.number.replace(/\s/g, '').includes(ref));
    if (byNum) return byNum;
  }
  const lower = message.toLowerCase();
  const byCust = invoices.find((i) => significantNameWords(i.customerName).some((w) => lower.includes(w)));
  if (byCust) return byCust;
  return (opts.fallbackToSingle ?? true) && invoices.length === 1 ? invoices[0]! : null;
}

type BusinessDocumentTarget = SendableQuote | IssuableInvoice;

function normalized(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function resolveBusinessDocument<T extends BusinessDocumentTarget>(message: string, docs: T[]): T | null {
  if (docs.length === 0) return null;
  const lower = normalized(message);
  const numMatch = message.match(/\d{3,}(?:-\d+)?/);
  if (numMatch) {
    const ref = numMatch[0].replace(/\s/g, '');
    const byNum = docs.find((d) => (d.number ?? d.id).replace(/\s/g, '').includes(ref) || d.id.replace(/\s/g, '').includes(ref));
    if (byNum) return byNum;
  }
  const byCustomer = docs.find((d) => {
    const first = normalized(d.customerName).split(/\s+/)[0] ?? '';
    return first.length >= 3 && lower.includes(first);
  });
  if (byCustomer) return byCustomer;
  return docs.length === 1 ? docs[0]! : null;
}

function displayRef(d: BusinessDocumentTarget): string {
  return d.number ?? d.id;
}

function documentLine(d: AgentDocument): string {
  const link = d.linkedEntityType && d.linkedEntityId ? ` · ${d.linkedEntityType} ${d.linkedEntityId}` : '';
  return `• ${d.filename} — ${d.kind}${link}`;
}

/** Ligne d'échéance fiscale, sobre (C-EXP5b) : date FR, libellé, « à confirmer » sur les
 * hypothèses ('assumed'), puis l'explication du use case — jamais un montant (v1 n'en émet pas). */
function fiscalDeadlineLine(d: FiscalDeadline): string {
  const dateFr = `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}/${d.date.slice(0, 4)}`;
  const flag = d.confidence === 'assumed' ? ' (à confirmer)' : '';
  return `• ${dateFr} — ${d.label}${flag}\n  ${d.explain}`;
}

function intentForTool(tool: string): BobIntent {
  if (tool === 'envoyer_devis') return 'envoyer_devis';
  if (tool === 'emettre_facture') return 'emettre_facture';
  if (tool === 'documents_liste') return 'documents';
  if (tool === 'encaisser_facture') return 'encaisser';
  if (tool === 'relance_brouillon') return 'relance';
  if (tool === 'factures_impayees') return 'factures';
  if (tool === 'tresorerie_versement') return 'payout';
  if (tool === 'echeances_fiscales') return 'echeances';
  if (tool === 'position_tva') return 'tva';
  if (tool === 'balance_agee') return 'balance';
  if (tool === 'payer_depense') return 'payer_depense';
  if (tool === 'resultat_provisoire') return 'resultat';
  if (tool === 'mon_bilan') return 'bilan';
  if (tool === 'revue_pilotage') return 'pilotage';
  if (tool === 'delai_paiement') return 'dso';
  if (tool === 'top_clients') return 'top_clients';
  return 'unknown';
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

/** Phase de traitement émise pendant ask() — pour un indicateur d'activité « temps réel » côté UI. */
export type AgentPhase = 'comprends' | 'agis';

export interface AskOptions {
  autonomy?: AgentAutonomy;
  /** Callback optionnel appelé aux étapes clés (comprends -> agis) pour animer un indicateur de phase. */
  onPhase?: (phase: AgentPhase) => void;
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
    opts.onPhase?.('comprends');
    const routed = this.deps.router.route('intent.detect');
    const plan = await this.classify(message, routed.model);
    const model = plan.model !== 'demo' ? plan.model : routed.model;
    const steps = plan.steps.filter((s) => s.intent !== 'unknown');

    if (steps.length === 0) return ok(this.unknownRun(model));
    opts.onPhase?.('agis');
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
      // Parité C15 TODO ① (C25) : « relance Martin » / « relance la 2026-014 » cible la bonne
      // facture parmi les encaissables — même résolution que l'encaissement. Sans cible : défaut
      // de l'hôte (la relance la plus urgente du plan @bob/core).
      const payable = await this.deps.actions.listPayableInvoices();
      const target = payable.ok
        ? resolveInvoice(reference ?? message, payable.value, { fallbackToSingle: false })
        : null;
      const r = await this.deps.actions.draftRelance(target ? { invoiceId: target.id } : undefined);
      if (!r.ok) return err(r.error);
      return ok({
        kind: 'answer',
        intent,
        model,
        plan: [
          target ? `Cibler la facture ${target.number} (${target.customerName})` : 'Repérer la facture en retard',
          'Rédiger la relance',
        ],
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

    if (intent === 'documents') {
      const r = await this.deps.actions.listDocuments();
      if (!r.ok) return err(r.error);
      const docs = r.value.slice(0, 8);
      const body = docs.length ? docs.map(documentLine).join('\n') : 'Aucun document archivé pour le moment.';
      return ok({ kind: 'answer', intent, model, plan: ['Lister les documents archivés'], card: { title: 'Documents', body } });
    }

    if (intent === 'echeances') {
      // C-EXP5b : lecture pure — même use case deriveFiscalCalendar que l'écran et GET /fiscal-calendar.
      const list = this.deps.actions.listFiscalDeadlines?.bind(this.deps.actions);
      if (!list) {
        // Hôte sans la capacité : réponse honnête, jamais un calendrier inventé.
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Échéances fiscales',
            body: 'Je n’ai pas accès au calendrier fiscal sur cet appareil pour le moment.',
          },
        });
      }
      const r = await list();
      if (!r.ok) return err(r.error);
      const items = r.value.slice(0, 8);
      const rest = r.value.length - items.length;
      const body = items.length
        ? `${items.map(fiscalDeadlineLine).join('\n')}${rest > 0 ? `\n… et ${rest} autre${rest > 1 ? 's' : ''} dans la fenêtre.` : ''}`
        : 'Aucune échéance fiscale dans les 90 prochains jours. 🎉';
      return ok({
        kind: 'answer',
        intent,
        model,
        plan: ['Lire la fiche société', 'Dériver les échéances fiscales à venir'],
        card: { title: 'Tes échéances fiscales (90 jours)', body },
      });
    }

    if (intent === 'tva') {
      // BOB-1 : position de TVA RÉELLE — LE même chiffre que le cashflow (deriveVatPosition).
      const getPosition = this.deps.actions.getVatPosition?.bind(this.deps.actions);
      if (!getPosition) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: { title: 'Position de TVA', body: 'Je n’ai pas accès à la position de TVA sur cet appareil pour le moment.' },
        });
      }
      const r = await getPosition();
      if (!r.ok) return err(r.error);
      const p = r.value;
      const verdict =
        p.netDueCents > 0
          ? `→ À provisionner : ${formatEUR(p.netDueCents)} (déjà déduit de ta dispo).`
          : p.creditCents > 0
            ? `→ Crédit de TVA : ${formatEUR(p.creditCents)} — rien à payer, il se reporte.`
            : '→ Position neutre : rien à provisionner.';
      return ok({
        kind: 'answer',
        intent,
        model,
        plan: ['Lire la TVA exigible sur tes encaissements', 'Croiser la TVA déductible de tes achats'],
        card: {
          title: 'Ta position de TVA',
          body: `Collectée sur tes encaissements : ${formatEUR(p.collectedCents)}\nDéductible sur tes achats : ${formatEUR(p.deductibleCents)}\n${verdict}`,
        },
      });
    }

    if (intent === 'resultat') {
      // BOB-3/CDR-1 : compte de résultat NORMÉ en priorité (cascade exploitation/financier/
      // exceptionnel/net) ; repli BOB-2 sur le résultat provisoire de la balance.
      const getIncome = this.deps.actions.getIncomeStatement?.bind(this.deps.actions);
      if (getIncome) {
        const ri = await getIncome();
        if (!ri.ok) return err(ri.error);
        const s = ri.value;
        const signed = (c: number): string => `${c >= 0 ? '+' : '−'}${formatEUR(Math.abs(c))}`;
        const verdict =
          s.resultatNetCents >= 0
            ? `Résultat net : +${formatEUR(s.resultatNetCents)} 🎉`
            : `Résultat net : −${formatEUR(Math.abs(s.resultatNetCents))} — on regarde les charges ensemble ?`;
        const lignes = [
          `Résultat d'exploitation : ${signed(s.resultatExploitationCents)}`,
          ...(s.resultatFinancierCents !== 0 ? [`Résultat financier : ${signed(s.resultatFinancierCents)}`] : []),
          ...(s.resultatExceptionnelCents !== 0 ? [`Résultat exceptionnel : ${signed(s.resultatExceptionnelCents)}`] : []),
        ];
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Dériver le compte de résultat', 'Exploitation → financier → exceptionnel → net'],
          card: { title: 'Ton compte de résultat', body: `${lignes.join('\n')}\n${verdict}` },
        });
      }

      // BOB-2 : résultat provisoire — produits − charges au grand-livre réel (CLOTURE-1).
      const getBalanceSheet = this.deps.actions.getTrialBalance?.bind(this.deps.actions);
      if (!getBalanceSheet) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: { title: 'Résultat provisoire', body: 'Je n’ai pas accès à la balance générale sur cet appareil pour le moment.' },
        });
      }
      const r = await getBalanceSheet();
      if (!r.ok) return err(r.error);
      const tb = r.value;
      const verdict =
        tb.resultCents >= 0
          ? `Bénéfice provisoire : +${formatEUR(tb.resultCents)} 🎉`
          : `Perte provisoire : −${formatEUR(Math.abs(tb.resultCents))} — on regarde les charges ensemble ?`;
      const equilibre = tb.balanced ? '' : '\n⚠ Balance déséquilibrée — je vérifie le journal.';
      return ok({
        kind: 'answer',
        intent,
        model,
        plan: ['Dériver la balance générale', 'Produits (classe 7) − charges (classe 6)'],
        card: {
          title: 'Ton résultat provisoire',
          body: `Produits : ${formatEUR(tb.revenueCents)}\nCharges : ${formatEUR(tb.chargesCents)}\n${verdict}${equilibre}`,
        },
      });
    }

    if (intent === 'bilan') {
      // BOB-4/BILAN-1 : bilan simplifié actif/passif (deriveBalanceSheet).
      const getBalanceSheet = this.deps.actions.getBalanceSheet?.bind(this.deps.actions);
      if (!getBalanceSheet) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: { title: 'Ton bilan', body: 'Je n’ai pas accès au bilan sur cet appareil pour le moment.' },
        });
      }
      const r = await getBalanceSheet();
      if (!r.ok) return err(r.error);
      const b = r.value;
      const equilibre = b.balanced
        ? 'Actif = passif : ton bilan est équilibré ✓'
        : `⚠ Écart de ${formatEUR(Math.abs(b.ecartCents))} — je vérifie le journal.`;
      return ok({
        kind: 'answer',
        intent,
        model,
        plan: ['Dériver le bilan', 'Actif ↔ passif, résultat aux capitaux propres'],
        card: {
          title: 'Ton bilan',
          body:
            `Actif : ${formatEUR(b.actif.totalCents)} (dont trésorerie ${formatEUR(b.actif.disponibilitesCents)})\n` +
            `Passif : ${formatEUR(b.passif.totalCents)} (dont capitaux propres ${formatEUR(b.passif.capitauxPropresCents + b.passif.resultatNetCents)}, dettes ${formatEUR(b.passif.dettesCents)})\n` +
            equilibre,
        },
      });
    }

    if (intent === 'pilotage' || intent === 'dso' || intent === 'top_clients') {
      // BA-3 : revue de pilotage (deriveBusinessReview @bob/core) — trois questions, UNE revue.
      const getReview = this.deps.actions.getBusinessReview?.bind(this.deps.actions);
      if (!getReview) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: { title: 'Ton pilotage', body: 'Je n’ai pas accès à la revue de pilotage sur cet appareil pour le moment.' },
        });
      }
      const r = await getReview();
      if (!r.ok) return err(r.error);
      const review = r.value;
      const pct = (bps: number | null): string | null => (bps === null ? null : `${bps >= 0 ? '+' : '−'}${(Math.abs(bps) / 100).toFixed(1).replace('.', ',')} %`);

      if (intent === 'dso') {
        const dsoBody =
          review.dso.days === null
            ? review.dso.reason === 'insufficient_history'
              ? 'Il me faut 3 mois de facturation pour mesurer ton délai d’encaissement — on y est presque.'
              : 'Pas assez de facturation récente pour mesurer un délai fiable.'
            : review.dso.days === 0
              ? 'Tout est encaissé — aucun euro ne dort chez tes clients ✓'
              : `Tes clients te paient en ${review.dso.days} jours en moyenne.\nImmobilisé chez eux : ${formatEUR(review.dso.receivablesCents)}.`;
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lire l’encours clients (balance âgée)', 'Rapporter au facturé TTC des 90 derniers jours'],
          card: { title: 'Ton délai d’encaissement', body: dsoBody },
        });
      }

      if (intent === 'top_clients') {
        if (review.topClients.lines.length === 0) {
          return ok({
            kind: 'answer',
            intent,
            model,
            plan: ['Classer le facturé 12 mois par client'],
            card: { title: 'Tes plus gros clients', body: 'Pas encore de facturation sur les 12 derniers mois.' },
          });
        }
        const rows = review.topClients.lines
          .slice(0, 3)
          .map((line, i) => `${i + 1}. ${line.customerName} — ${formatEUR(line.invoicedTtc12mCents)}${line.shareBps !== null ? ` (${(line.shareBps / 100).toFixed(0)} %)` : ''}`);
        const alert = review.topClients.concentrationAlert
          ? `\n⚠ ${review.topClients.lines[0]?.customerName} pèse ${((review.topClients.top1ShareBps ?? 0) / 100).toFixed(0)} % de ton activité — une dépendance à surveiller.`
          : '';
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Classer le facturé TTC 12 mois par client', 'Mesurer la dépendance au premier'],
          card: { title: 'Tes plus gros clients (12 mois)', body: rows.join('\n') + alert },
        });
      }

      // pilotage : le mois en cours à isopérimètre + tendance mois clos + ratio headline.
      const cur = review.currentMonth;
      const iso = pct(cur.invoicedDeltaBps);
      const trend = review.lastClosedComparison;
      const trendLine = trend
        ? `${trend.month} vs ${trend.previousMonth} : ${trend.deltaCents >= 0 ? '+' : '−'}${formatEUR(Math.abs(trend.deltaCents))}${pct(trend.deltaBps) ? ` (${pct(trend.deltaBps)})` : ''}`
        : null;
      const ebe = pct(review.ratios.ebeBps);
      const body = [
        `Facturé (hors TVA) au ${cur.atDay} du mois : ${formatEUR(cur.invoicedHtCents)}${iso ? ` (${iso} vs le mois dernier à date égale)` : ''}`,
        `Encaissé (TVA comprise) : ${formatEUR(cur.collectedTtcCents)}`,
        ...(trendLine ? [trendLine] : []),
        ...(ebe ? [`Ton activité dégage ${ebe} du CA (taux d’EBE) — avant ta rémunération.`] : []),
      ].join('\n');
      return ok({
        kind: 'answer',
        intent,
        model,
        plan: ['Dériver la revue de pilotage', 'Facturé (écritures de vente) vs encaissé (paiements)', 'Comparer à isopérimètre de jours'],
        card: { title: 'Ton activité', body },
      });
    }

    if (intent === 'balance') {
      // BOB-1 : balance âgée — « qui me doit quoi, depuis quand » (deriveAgedBalance).
      const getBalance = this.deps.actions.getAgedBalance?.bind(this.deps.actions);
      if (!getBalance) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: { title: 'Qui te doit quoi', body: 'Je n’ai pas accès à la balance clients sur cet appareil pour le moment.' },
        });
      }
      const r = await getBalance();
      if (!r.ok) return err(r.error);
      const b = r.value;
      if (b.totalCents === 0) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Dériver la balance âgée clients'],
          card: { title: 'Qui te doit quoi', body: 'Personne ne te doit rien — poste clients à jour. 🎉' },
        });
      }
      const top = b.byCustomer
        .slice(0, 5)
        .map((line) => `• ${line.customerName} — ${formatEUR(line.totalCents)}${line.maxDaysLate > 0 ? ` (retard max ${line.maxDaysLate} j)` : ''}`)
        .join('\n');
      const alert =
        b.buckets.d90_plus > 0
          ? `\n⚠ ${formatEUR(b.buckets.d90_plus)} à plus de 90 jours — risque d’irrécouvrable, on sécurise.`
          : '';
      return ok({
        kind: 'answer',
        intent,
        model,
        plan: ['Dériver la balance âgée clients (tranches de retard)'],
        card: {
          title: 'Qui te doit quoi',
          body: `Total dû : ${formatEUR(b.totalCents)} · dont échu ${formatEUR(b.overdueCents)}\n${top}${alert}`,
        },
      });
    }

    if (intent === 'payer_depense') {
      // BOB-1/E4 : régler un fournisseur — liste réelle → résolution par nom → PROPOSITION
      // (palier accounting : le plancher confirme toujours une écriture comptable).
      const listUnpaid = this.deps.actions.listUnpaidExpenses?.bind(this.deps.actions);
      const tool = this.tool('payer_depense');
      if (!listUnpaid || !tool) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: { title: 'Régler une dépense', body: 'Je ne peux pas régler de dépense sur cet appareil pour le moment.' },
        });
      }
      const r = await listUnpaid();
      if (!r.ok) return err(r.error);
      if (r.value.length === 0) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lister les dépenses à payer'],
          card: { title: 'Régler une dépense', body: 'Aucune dépense à payer — ton poste fournisseurs est à jour.' },
        });
      }
      const normalized = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      const target = r.value.find((e) => normalized(message).includes(normalized(e.supplierName)));
      if (!target) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lister les dépenses à payer'],
          card: { title: 'Quelle dépense ?', body: 'Dis-moi quel fournisseur régler :' },
          choices: r.value.map((e) => ({
            label: `${e.supplierName} — ${formatEUR(e.totalTtcCents)}`,
            value: `règle la dépense ${e.supplierName}`,
          })),
        });
      }
      const args = { expenseId: target.id };
      const label = `Régler ${target.supplierName} (${formatEUR(target.totalTtcCents)}) — décaissement au journal de banque`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Trouver la dépense', 'Préparer le décaissement 401/512', 'Attendre ta confirmation'],
          card: { title: 'Règlement à confirmer', body: `${label}\nJe l’enregistre ?` },
          pending: { tool: tool.name, args, label },
          spokenPrompt: buildSpokenConfirmation(label),
        });
      }
      const run = await tool.run(args);
      if (!run.ok) return err(run.error);
      return ok({ kind: 'done', intent, model, plan: ['Régler la dépense'], card: { title: 'Dépense réglée ✓', body: `${label} — c’est fait.` } });
    }

    if (intent === 'envoyer_devis') {
      const r = await this.deps.actions.listSendableQuotes();
      if (!r.ok) return err(r.error);
      const quote = resolveBusinessDocument(reference ?? message, r.value);
      if (!quote) {
        const body = r.value.length ? 'Quel devis veux-tu envoyer ?' : 'Aucun devis prêt à envoyer.';
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Chercher le devis'],
          card: { title: 'Quel devis ?', body },
          choices: r.value.map((q) => ({ label: `${displayRef(q)} — ${q.customerName} · ${formatEUR(q.totalTtcCents)}`, value: displayRef(q) })),
        });
      }
      const tool = this.tool('envoyer_devis')!;
      const args = { quoteId: quote.id };
      const label = `Envoyer le devis ${displayRef(quote)} à ${quote.customerName} (${formatEUR(quote.totalTtcCents)})`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Identifier le devis', 'Préparer le lien de signature', 'Attendre ta confirmation'],
          card: { title: 'Envoi de devis à confirmer', body: `${label}\nJe l’envoie au client ?` },
          pending: { tool: tool.name, args, label },
          spokenPrompt: buildSpokenConfirmation(label),
        });
      }
      const run = await tool.run(args);
      if (!run.ok) return err(run.error);
      return ok({ kind: 'done', intent, model, plan: ['Envoyer le devis'], card: { title: 'Devis envoyé ✓', body: `${label} — c’est envoyé.` } });
    }

    if (intent === 'emettre_facture') {
      const r = await this.deps.actions.listIssuableInvoices();
      if (!r.ok) return err(r.error);
      const invoice = resolveBusinessDocument(reference ?? message, r.value);
      if (!invoice) {
        const body = r.value.length ? 'Quelle facture veux-tu émettre ?' : 'Aucune facture brouillon prête à émettre.';
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Chercher la facture brouillon'],
          card: { title: 'Quelle facture ?', body },
          choices: r.value.map((i) => ({ label: `${displayRef(i)} — ${i.customerName} · ${formatEUR(i.totalTtcCents)}`, value: displayRef(i) })),
        });
      }
      const tool = this.tool('emettre_facture')!;
      const args = { invoiceId: invoice.id };
      const label = `Émettre la facture ${displayRef(invoice)} pour ${invoice.customerName} (${formatEUR(invoice.totalTtcCents)})`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Identifier la facture brouillon', 'Préparer l’émission légale', 'Attendre ta confirmation'],
          card: { title: 'Émission de facture à confirmer', body: `${label}\nJe numérote et j’archive les pièces légales ?` },
          pending: { tool: tool.name, args, label },
          spokenPrompt: buildSpokenConfirmation(label),
        });
      }
      const run = await tool.run(args);
      if (!run.ok) return err(run.error);
      return ok({ kind: 'done', intent, model, plan: ['Émettre la facture'], card: { title: 'Facture émise ✓', body: `${label} — c’est émis.` } });
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
    // Chargées pour l'encaissement, et pour une relance CIBLÉE (C25 ① — « puis relance Martin »).
    if (steps.some((s) => s.intent === 'encaisser' || (s.intent === 'relance' && s.reference !== null))) {
      const r = await this.deps.actions.listPayableInvoices();
      if (!r.ok) return err(r.error);
      payables = r.value;
    }
    let sendableQuotes: SendableQuote[] = [];
    if (steps.some((s) => s.intent === 'envoyer_devis')) {
      const r = await this.deps.actions.listSendableQuotes();
      if (!r.ok) return err(r.error);
      sendableQuotes = r.value;
    }
    let issuableInvoices: IssuableInvoice[] = [];
    if (steps.some((s) => s.intent === 'emettre_facture')) {
      const r = await this.deps.actions.listIssuableInvoices();
      if (!r.ok) return err(r.error);
      issuableInvoices = r.value;
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
      } else if (step.intent === 'envoyer_devis') {
        const quote = resolveBusinessDocument(step.reference ?? '', sendableQuotes);
        if (!quote) {
          const body = sendableQuotes.length ? 'Précise le devis à envoyer :' : 'Aucun devis prêt à envoyer.';
          return ok({
            kind: 'answer',
            intent: 'envoyer_devis',
            model,
            plan: ['Lever l’ambiguïté'],
            card: { title: 'Quel devis ?', body },
            choices: sendableQuotes.map((q) => ({ label: `${displayRef(q)} — ${q.customerName} · ${formatEUR(q.totalTtcCents)}`, value: displayRef(q) })),
          });
        }
        sendableQuotes = sendableQuotes.filter((q) => q.id !== quote.id);
        actions.push({
          tool: 'envoyer_devis',
          args: { quoteId: quote.id },
          label: `Envoyer le devis ${displayRef(quote)} à ${quote.customerName}`,
        });
      } else if (step.intent === 'emettre_facture') {
        const invoice = resolveBusinessDocument(step.reference ?? '', issuableInvoices);
        if (!invoice) {
          const body = issuableInvoices.length ? 'Précise la facture à émettre :' : 'Aucune facture brouillon prête à émettre.';
          return ok({
            kind: 'answer',
            intent: 'emettre_facture',
            model,
            plan: ['Lever l’ambiguïté'],
            card: { title: 'Quelle facture ?', body },
            choices: issuableInvoices.map((i) => ({ label: `${displayRef(i)} — ${i.customerName} · ${formatEUR(i.totalTtcCents)}`, value: displayRef(i) })),
          });
        }
        issuableInvoices = issuableInvoices.filter((i) => i.id !== invoice.id);
        actions.push({
          tool: 'emettre_facture',
          args: { invoiceId: invoice.id },
          label: `Émettre la facture ${displayRef(invoice)} pour ${invoice.customerName}`,
        });
      } else if (step.intent === 'payout') {
        actions.push({ tool: 'tresorerie_versement', args: {}, label: 'Calculer ton versement possible' });
      } else if (step.intent === 'relance') {
        // Cible explicite uniquement (numéro / nom) — sinon l'hôte prend la plus urgente du plan.
        const target = step.reference ? resolveInvoice(step.reference, payables, { fallbackToSingle: false }) : null;
        actions.push(
          target
            ? {
                tool: 'relance_brouillon',
                args: { invoiceId: target.id },
                label: `Préparer la relance de ${target.number} (${target.customerName})`,
              }
            : { tool: 'relance_brouillon', args: {}, label: 'Préparer une relance' },
        );
      } else if (step.intent === 'factures') {
        actions.push({ tool: 'factures_impayees', args: {}, label: 'Lister tes impayés' });
      } else if (step.intent === 'documents') {
        actions.push({ tool: 'documents_liste', args: {}, label: 'Lister les documents archivés' });
      } else if (step.intent === 'echeances' && this.tool('echeances_fiscales')) {
        // Gated sur la capacité de l'hôte (outil optionnel C-EXP5b) — sinon l'étape est écartée.
        actions.push({ tool: 'echeances_fiscales', args: {}, label: 'Lister tes échéances fiscales' });
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
      return ok({
        kind: 'done',
        intent: intentForTool(pending.batch[0]?.tool ?? pending.tool),
        model,
        plan: pending.batch.map((a) => a.label),
        card: { title: 'Fait ✓', body: r.value },
      });
    }
    const tool = this.tool(pending.tool);
    if (!tool) return err({ kind: 'not_found', entity: 'tool', id: pending.tool });
    const parsed = tool.parse(pending.args);
    if (!parsed.ok) return err(parsed.error);
    const run = await tool.run(parsed.value);
    if (!run.ok) return err(run.error);
    return ok({
      kind: 'done',
      intent: intentForTool(pending.tool),
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

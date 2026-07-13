import { type Result, ok, err, type AppError, type FiscalDeadline, formatEUR } from '@bob/core';
import { ModelRouter, type ModelChoice } from '../router/model-router';
import { renderWithGuard } from '../guardrails/money-guard';
import { naturalizeReply, type NaturalizeTone } from '../guardrails/naturalize';
import { redactPII } from '../guardrails/pii-redaction';
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
import {
  type AgentAskPayload,
  type AgentCapability,
  type AgentContext,
  type ContextEntitySummary,
  parseAgentAskPayload,
  resolveAgentEntity,
  sanitizeContextEntitySummary,
} from './context';

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
  /** Identifiant opaque d'une proposition stockee cote serveur. En HTTP, confirm ne doit
   * faire confiance qu'a cet identifiant ; absent pour le runtime local historique. */
  proposalId?: string;
  /** Expiration ISO de la proposition opaque. L'UI peut la rendre obsolete avant confirmation. */
  expiresAt?: string;
  /** Pour un plan multi-étapes : la suite d'actions à exécuter en lot après confirmation. */
  batch?: BatchItem[];
}

/** Choix proposé en cas d'ambiguïté (rendu comme boutons / modale côté UI). */
export interface AgentChoice {
  label: string;
  /** Valeur à renvoyer (ex. numéro de facture) si l'utilisateur sélectionne ce choix. */
  value: string;
}

/** Option d'une question structurée (ASK-1) — l'agent fournit la COMMANDE de suivi complète :
 * l'UI ne reconstruit jamais une phrase (le langage des intents appartient à l'agent). */
export interface AgentQuestionOption {
  /** Valeur machine stable (numéro de pièce, id, mode) — clé de sélection. */
  value: string;
  /** Libellé court (1-5 mots) affiché en tête d'option. */
  label: string;
  /** Contexte/conséquence du choix (client, montant, retard…) — la ligne secondaire. */
  description?: string;
  /** Commande envoyée à ask() si cette option est choisie (mono-sélection). */
  followUp: string;
}

/** Question structurée à la « AskUserQuestion » (ASK-1) : posée quand la demande est ambiguë
 * ou qu'il manque une précision — modale de choix unique (radio) ou multiple (checkbox). */
export interface AgentQuestion {
  /** Id stable de la question (télémétrie/tests). */
  id: string;
  /** La question complète, en français, orientée décision. */
  question: string;
  /** Étiquette très courte (chip, ≤ 12 caractères) — ex. « Facture », « Fournisseur ». */
  header: string;
  /** Plusieurs réponses possibles (checkboxes) — défaut false (choix unique). */
  multiSelect?: boolean;
  /** Commande de suivi pour le multi-select : `{values}` remplacé par les valeurs jointes
   *  par « , » (ex. « Encaisse les factures {values} »). Requis si multiSelect. */
  followUpTemplate?: string;
  /** 2 à 4 options — au-delà, l'agent tronque aux plus pertinentes. */
  options: AgentQuestionOption[];
}

/** Fabrique une question de désambiguïsation depuis une liste de cibles (plafond 4 options). */
function askToPick(input: {
  id: string;
  question: string;
  header: string;
  multiSelect?: boolean;
  followUpTemplate?: string;
  items: readonly { value: string; label: string; description?: string; followUp: string }[];
}): AgentQuestion {
  return {
    id: input.id,
    question: input.question,
    header: input.header,
    ...(input.multiSelect !== undefined ? { multiSelect: input.multiSelect } : {}),
    ...(input.followUpTemplate !== undefined ? { followUpTemplate: input.followUpTemplate } : {}),
    options: input.items.slice(0, 4).map((item) => ({
      value: item.value,
      label: item.label,
      ...(item.description !== undefined ? { description: item.description } : {}),
      followUp: item.followUp,
    })),
  };
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
  /** ASK-1 : question(s) structurée(s) — l'UI les rend en modale riche (descriptions,
   * choix unique/multiple) et répond via followUp. `choices` reste rempli en parallèle
   * (rétro-compatibilité des hôtes qui ne connaissent pas `ask`). */
  ask?: AgentQuestion[];
  /** Présent pour une commande de navigation : route vers laquelle l'app doit rediriger (ex. /scan-document). */
  navigate?: string;
  /** Indice de PRÉ-REMPLISSAGE pour l'écran d'arrivée (« nouveau devis POUR Camping Les
   * Pins » : le nom entendu, résolu par l'écran contre ses données réelles) — jamais une
   * autorisation ni un identifiant, jamais dans la route (l'allowlist reste stricte). */
  navigateHint?: { customerReference?: string };
  /** Texte à vocaliser (TTS) : prompt de confirmation parlé (action proposée) ou message parlé (annulation/re-demande). */
  spokenPrompt?: string;
  /** LIVE-2 : reformulation NATURELLE des faits par le LLM (gardée par naturalizationViolations —
   * chiffres et pièces strictement identiques au body, sinon absente). Le fil et la voix la
   * préfèrent au gabarit ; les actions proposées n'en ont JAMAIS (consentement verbatim). */
  naturalBody?: string;
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
  const normalizedMessage = normalized(message);
  const byId = invoices.find((invoice) => {
    const id = normalized(invoice.id);
    return id.length >= 3 && (normalizedMessage === id || containsExactTokens(normalizedMessage, id));
  });
  if (byId) return byId;
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

/** Forme minimale d'une pièce ciblable par numéro/client — devis, factures, devis facturables. */
type BusinessDocumentTarget = { id: string; number: string | null; customerName: string };

function normalized(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/** Vrai si `needle` apparaît en TOKENS ENTIERS de `haystack` — « inv-1 » ne matche jamais
 * « inv-12 » : un id préfixe d'un autre ciblerait la mauvaise pièce (le mauvais client). */
function containsExactTokens(haystack: string, needle: string): boolean {
  const tokens = (value: string): string => ` ${value.replace(/[^a-z0-9]+/g, ' ').trim()} `;
  return tokens(haystack).includes(tokens(needle));
}

function resolveBusinessDocument<T extends BusinessDocumentTarget>(
  message: string,
  docs: T[],
  opts: { fallbackToSingle?: boolean } = {},
): T | null {
  if (docs.length === 0) return null;
  const lower = normalized(message);
  const byId = docs.find((doc) => {
    const id = normalized(doc.id);
    return id.length >= 3 && (lower === id || containsExactTokens(lower, id));
  });
  if (byId) return byId;
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
  return (opts.fallbackToSingle ?? true) && docs.length === 1 ? docs[0]! : null;
}

function displayRef(d: BusinessDocumentTarget): string {
  return d.number ?? d.id;
}

/** Corps de carte quand aucune cible n'est retenue : si l'écran désignait une pièce précise
 * non éligible, la réponse le dit — jamais « aucune pièce » alors que l'utilisateur en regarde une. */
function unresolvedTargetBody(input: {
  readonly unactionableLabel?: string;
  readonly hasOptions: boolean;
  readonly ask: string;
  readonly empty: string;
}): string {
  if (input.unactionableLabel) {
    return input.hasOptions
      ? `« ${input.unactionableLabel} » n’est pas éligible pour cette action. ${input.ask}`
      : `« ${input.unactionableLabel} » n’est pas éligible pour cette action, et rien d’autre n’est en attente.`;
  }
  return input.hasOptions ? input.ask : input.empty;
}

interface TargetResolution<T> {
  readonly target: T | null;
  readonly choices: readonly T[];
  readonly unactionableLabel?: string;
}

function contextTarget<T extends { id: string }>(input: {
  readonly context?: AgentContext;
  readonly compatibleTypes: readonly string[];
  readonly requiredCapability: AgentCapability;
  readonly explicitReference: string | null;
  readonly values: readonly T[];
}): {
  readonly target: T | null;
  readonly choices: readonly T[];
  readonly preventsFallback: boolean;
  /** L'écran désignait une pièce précise, mais elle n'est pas éligible à CETTE action :
   * on le dira honnêtement au lieu d'un « aucune pièce » mensonger ou d'un repli silencieux. */
  readonly unactionableLabel?: string;
} {
  const resolution = resolveAgentEntity({
    ...(input.context !== undefined ? { context: input.context } : {}),
    compatibleTypes: input.compatibleTypes,
    requiredCapability: input.requiredCapability,
    ...(input.explicitReference !== null ? { explicitReference: input.explicitReference } : {}),
  });
  if (resolution.kind === 'resolved') {
    const target = input.values.find((value) => value.id === resolution.entity.id) ?? null;
    if (!target) {
      return { target: null, choices: input.values, preventsFallback: true, unactionableLabel: resolution.entity.label };
    }
    return { target, choices: [target], preventsFallback: true };
  }
  if (resolution.kind === 'ambiguous') {
    const ids = new Set(resolution.candidates.map((candidate) => candidate.id));
    return { target: null, choices: input.values.filter((value) => ids.has(value.id)), preventsFallback: true };
  }
  return { target: null, choices: input.values, preventsFallback: input.explicitReference !== null };
}

/** Reference explicite texte > contexte UI compatible unique > unicite metier historique. */
function resolveInvoiceTarget(input: {
  readonly message: string;
  readonly reference: string | null;
  readonly invoices: PayableInvoice[];
  readonly context?: AgentContext;
  readonly capability: AgentCapability;
}): TargetResolution<PayableInvoice> {
  const direct = resolveInvoice(input.reference ?? input.message, input.invoices, { fallbackToSingle: false });
  if (direct) return { target: direct, choices: input.invoices };
  const contextual = contextTarget({
    ...(input.context !== undefined ? { context: input.context } : {}),
    compatibleTypes: ['invoice'],
    requiredCapability: input.capability,
    explicitReference: input.reference,
    values: input.invoices,
  });
  if (contextual.target) return { target: contextual.target, choices: contextual.choices };
  if (!contextual.preventsFallback && input.invoices.length === 1)
    return { target: input.invoices[0]!, choices: input.invoices };
  return {
    target: null,
    choices: contextual.choices,
    ...(contextual.unactionableLabel !== undefined ? { unactionableLabel: contextual.unactionableLabel } : {}),
  };
}

function resolveDocumentTarget<T extends BusinessDocumentTarget>(input: {
  readonly message: string;
  readonly reference: string | null;
  readonly documents: T[];
  readonly context?: AgentContext;
  readonly type: 'quote' | 'invoice';
  readonly capability: AgentCapability;
}): TargetResolution<T> {
  const direct = resolveBusinessDocument(input.reference ?? input.message, input.documents, { fallbackToSingle: false });
  if (direct) return { target: direct, choices: input.documents };
  const contextual = contextTarget({
    ...(input.context !== undefined ? { context: input.context } : {}),
    compatibleTypes: [input.type],
    requiredCapability: input.capability,
    explicitReference: input.reference,
    values: input.documents,
  });
  if (contextual.target) return { target: contextual.target, choices: contextual.choices };
  if (!contextual.preventsFallback && input.documents.length === 1)
    return { target: input.documents[0]!, choices: input.documents };
  return {
    target: null,
    choices: contextual.choices,
    ...(contextual.unactionableLabel !== undefined ? { unactionableLabel: contextual.unactionableLabel } : {}),
  };
}

const READ_CAPABILITY_BY_TYPE: Readonly<Record<string, AgentCapability>> = {
  customer: 'customer.read',
  quote: 'quote.read',
  quote_line: 'quote.read',
  invoice: 'invoice.read',
  invoice_line: 'invoice.read',
  expense: 'expense.read',
  document: 'document.read',
  chantier: 'chantier.read',
  notification: 'notification.read',
  accounting_entry: 'accounting.read',
};

function requestedContextTypes(message: string): readonly string[] | null {
  const n = normalized(message);
  if (/\bligne\b/.test(n) && /\bfacture\b/.test(n)) return ['invoice_line'];
  if (/\bligne\b/.test(n) && /\bdevis\b/.test(n)) return ['quote_line'];
  if (/\bligne\b/.test(n)) return ['invoice_line', 'quote_line'];
  if (/\bfacture\b/.test(n)) return ['invoice'];
  if (/\bdevis\b/.test(n)) return ['quote'];
  if (/\bclient\b/.test(n)) return ['customer'];
  if (/\bdepense\b/.test(n)) return ['expense'];
  if (/\bdocument\b/.test(n)) return ['document'];
  if (/\bchantier\b/.test(n)) return ['chantier'];
  if (/\bnotifications?\b/.test(n)) return ['notification'];
  if (/\b(ecritures?|operations? comptables?)\b/.test(n)) return ['accounting_entry'];
  return null;
}

function readableContextTypes(context: AgentContext | undefined, message: string): readonly string[] {
  if (!context) return [];
  const requested = requestedContextTypes(message);
  const primaryId = context.screen.instanceId.includes(':')
    ? context.screen.instanceId.slice(context.screen.instanceId.indexOf(':') + 1)
    : null;
  const primary = !requested && primaryId
    ? context.entities.find((entity) => entity.id === primaryId)
    : undefined;
  // Sans type exprime (« ou suis-je ? »), une piece racine prime sur ses lignes affichees.
  // Les lignes restent ciblables uniquement quand l'utilisateur dit explicitement « ligne ».
  const eligible = requested
    ? context.entities
    : primary
      ? [primary]
    : context.entities.some((entity) => !entity.type.endsWith('_line'))
      ? context.entities.filter((entity) => !entity.type.endsWith('_line'))
      : context.entities;
  return [
    ...new Set(
      eligible
        .filter((entity) => {
          if (requested && !requested.includes(entity.type)) return false;
          const capability = READ_CAPABILITY_BY_TYPE[entity.type] ?? 'screen.read';
          return context.capabilities.includes(capability);
        })
        .map((entity) => entity.type),
    ),
  ];
}

function summaryBody(summary: ContextEntitySummary): string {
  if (summary.facts.length === 0) return `Tu regardes ${summary.label}.`;
  return summary.facts.map((fact) => `• ${fact.label} : ${fact.value}`).join('\n');
}

/** Le briefing notification privilégie le motif, pas seulement sa date technique. */
function aggregateFacts(summary: ContextEntitySummary): readonly ContextEntitySummary['facts'][number][] {
  if (summary.type !== 'notification') return summary.facts.slice(0, 2);
  const content = summary.facts.find((fact) => fact.label === 'Contenu');
  const status = summary.facts.find((fact) => fact.label === 'Statut');
  const selected = [content, status].filter(
    (fact): fact is ContextEntitySummary['facts'][number] => fact !== undefined,
  );
  return selected.length > 0 ? selected : summary.facts.slice(0, 2);
}

function wantsContextNavigation(message: string): boolean {
  return /\b(ouvre|ouvrir|affiche|afficher|accede|acceder|emmene|amene|va)\b/.test(normalized(message));
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
  if (tool === 'contexte_ecran') return 'contexte_ecran';
  if (tool === 'marquer_notifications_lues') return 'marquer_notifications_lues';
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
  if (tool === 'generer_facture' || tool === 'generer_facture_devis') return 'generer_facture';
  if (tool === 'revue_cloture') return 'revue_cloture';
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

export interface AskOptions extends Omit<AgentAskPayload, 'message'> {
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
  private async classify(
    message: string,
    routedModel: ModelChoice,
    history?: AskOptions['history'],
    context?: AgentContext,
  ) {
    if (this.deps.llm && routedModel !== 'demo') {
      try {
        return await classifyWithLlm(this.deps.llm, message, history, context);
      } catch {
        // LLM indisponible : on retombe sur la détection déterministe (jamais bloquant).
      }
    }
    return classifyWithRegex(message);
  }

  async ask(message: string, opts: AskOptions = {}): Promise<Result<AgentRun, AppError>> {
    const payload = parseAgentAskPayload({
      message,
      ...(opts.autonomy !== undefined ? { autonomy: opts.autonomy } : {}),
      ...(opts.history !== undefined ? { history: opts.history } : {}),
      ...(opts.tone !== undefined ? { tone: opts.tone } : {}),
      ...(opts.context !== undefined ? { context: opts.context } : {}),
    });
    if (!payload.ok) return err(payload.error);
    const userMessage = payload.value.message;
    const autonomy = payload.value.autonomy ?? DEFAULT_AUTONOMY;
    const history = payload.value.history;
    const context = payload.value.context;
    opts.onPhase?.('comprends');
    const routed = this.deps.router.route('intent.detect');
    const plan = await this.classify(userMessage, routed.model, history, context);
    const model = plan.model !== 'demo' ? plan.model : routed.model;
    const steps = plan.steps.filter((s) => s.intent !== 'unknown');
    // La lecture contextuelle est une réponse, pas une action de lot : dans une demande
    // multi-étapes, on la retire du lot (sinon elle serait perdue en silence) — seule, elle
    // s'exécute normalement en runSingle.
    const batchSteps = steps.length > 1 ? steps.filter((s) => s.intent !== 'contexte_ecran') : steps;
    const effective = batchSteps.length > 0 ? batchSteps : steps.slice(0, 1);

    let result: Result<AgentRun, AppError>;
    if (effective.length === 0) result = ok(this.unknownRun(model));
    else {
      opts.onPhase?.('agis');
      result =
        effective.length > 1
          ? await this.runMulti(effective, autonomy, model, userMessage, context)
          : await this.runSingle(effective[0]!, autonomy, model, userMessage, context);
    }
    // LIVE-2 : mise en mots des FAITS par le LLM — réponses et résultats seulement, JAMAIS
    // les actions proposées (le consentement reste verbatim) ni les questions structurées
    // (leur formulation est lue par speakableQuestion). Fallback silencieux : le gabarit.
    if (result.ok && this.deps.llm && model !== 'demo' && (result.value.kind === 'answer' || result.value.kind === 'done') && !result.value.ask?.length) {
      const natural = await naturalizeReply(this.deps.llm, {
        title: result.value.card.title,
        body: result.value.card.body,
        userMessage: redactPII(userMessage),
        tone: (payload.value.tone ?? 'pote') as NaturalizeTone,
        history: (history ?? []).map((turn) => ({
          role: turn.role === 'user' ? ('user' as const) : ('assistant' as const),
          content: redactPII(turn.text),
        })),
      });
      if (natural) result = ok({ ...result.value, naturalBody: natural });
    }
    return result;
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
    context?: AgentContext,
  ): Promise<Result<AgentRun, AppError>> {
    const intent = step.intent;
    const reference = step.reference;

    if (intent === 'contexte_ecran') {
      const read = this.deps.actions.readContextEntity?.bind(this.deps.actions);
      // RÉSUMÉ D'ÉCRAN AGRÉGÉ : « résume l'écran », « où suis-je ? », « explique-moi tout
      // ce qui est en attente » — Bob lit PLUSIEURS éléments affichés (bornés, rechargés à
      // la source) au lieu de demander d'en choisir un. Une question ciblée (« cette
      // facture ») garde le flux mono-entité fail-safe ci-dessous.
      const normalizedMessage = normalized(message);
      const navigationRequested = wantsContextNavigation(message);
      const requestedTypes = requestedContextTypes(message);
      const unreadNotificationsOnly =
        requestedTypes?.includes('notification') === true &&
        /\b(non lues?|a lire|en attente)\b/.test(normalizedMessage) &&
        !/\b(en attente d envoi|a envoyer|livraison)\b/.test(normalizedMessage);
      const screenWide = /(ecran|ou suis[- ]?je|qu ?est[- ]?ce que je (vois|regarde)|tout ce qu|\b(?:toutes?(?: les)?|les) (notifications?|ecritures?)\b)/.test(
        normalizedMessage,
      );
      if (screenWide && context !== undefined && read) {
        const readable = context.entities.filter(
          (entity) =>
            !entity.type.endsWith('_line') &&
            (requestedTypes === null || requestedTypes.includes(entity.type)) &&
            context.capabilities.includes(READ_CAPABILITY_BY_TYPE[entity.type] ?? 'screen.read'),
        );
        if (readable.length > 0) {
          const MAX_AGGREGATE = 5;
          const lines: string[] = [];
          let matchingCount = 0;
          const candidates = unreadNotificationsOnly ? readable : readable.slice(0, MAX_AGGREGATE);
          for (const entity of candidates) {
            const loaded = await read({ type: entity.type, id: entity.id });
            if (!loaded.ok) continue; // un élément illisible n'empêche pas le briefing des autres
            const summary = sanitizeContextEntitySummary(loaded.value, { type: entity.type, id: entity.id });
            if (!summary) continue;
            if (unreadNotificationsOnly && summary.state?.unread !== true) continue;
            matchingCount += 1;
            if (lines.length >= MAX_AGGREGATE) continue;
            const facts = aggregateFacts(summary).map((fact) => `${fact.label} : ${fact.value}`).join(' · ');
            lines.push(facts ? `• ${summary.label} — ${facts}` : `• ${summary.label}`);
          }
          if (lines.length > 0) {
            const remaining = unreadNotificationsOnly
              ? matchingCount - lines.length
              : readable.length - Math.min(readable.length, MAX_AGGREGATE);
            return ok({
              kind: 'answer',
              intent,
              model,
              plan: ['Lire les éléments affichés', 'Relire leurs informations à la source'],
              card: {
                title: 'Ce que tu regardes',
                body: lines.join('\n') + (remaining > 0 ? `\n… et ${remaining} autre${remaining > 1 ? 's' : ''}.` : ''),
              },
            });
          }
          if (unreadNotificationsOnly) {
            return ok({
              kind: 'answer',
              intent,
              model,
              plan: ['Relire les notifications affichées à la source'],
              card: { title: 'Notifications', body: 'Tu n’as aucune notification non lue dans ce fil.' },
            });
          }
        }
      }
      const types = readableContextTypes(context, message);
      const resolution = resolveAgentEntity({
        ...(context !== undefined ? { context } : {}),
        compatibleTypes: types,
        ...(reference !== null ? { explicitReference: reference } : {}),
      });
      if (resolution.kind === 'ambiguous') {
        const feminine = requestedContextTypes(message)?.includes('invoice') ?? false;
        const verb = navigationRequested ? 'ouvrir' : 'résumer';
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lever l’ambiguïté du contexte écran'],
          card: {
            title: navigationRequested ? 'Que veux-tu ouvrir ?' : 'Que veux-tu résumer ?',
            body: feminine
              ? `Plusieurs factures sont affichées. Laquelle veux-tu ${verb} ?`
              : `Plusieurs éléments sont affichés. Lequel veux-tu ${verb} ?`,
          },
          choices: resolution.candidates.map((entity) => ({ label: entity.label, value: entity.id })),
          ask: [
            askToPick({
              id: 'contexte_ecran.cible',
              question: `Quel élément affiché veux-tu que je ${verb} ?`,
              header: 'Contexte',
              items: resolution.candidates.map((entity) => ({
                value: entity.id,
                label: entity.label,
                followUp: navigationRequested ? `Ouvre ${entity.label}` : `Résume ${entity.label}`,
              })),
            }),
          ],
        });
      }
      if (resolution.kind === 'none') {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier le contexte écran'],
          card: {
            title: 'Contexte de l’écran',
            body: types.length === 0
              ? 'Je ne vois pas encore d’entité métier lisible sur cet écran.'
              : 'Je ne peux pas identifier cet élément sans ambiguïté. Précise son numéro ou son nom.',
          },
        });
      }
      if (!read) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: resolution.entity.label,
            body: 'Je sais quel élément tu regardes, mais je ne peux pas encore lire son résumé sur cet appareil.',
          },
        });
      }
      const loaded = await read({ type: resolution.entity.type, id: resolution.entity.id });
      if (!loaded.ok) return err(loaded.error);
      const summary = sanitizeContextEntitySummary(loaded.value, resolution.entity);
      if (!summary) return err({ kind: 'dependency', port: 'agent-context', cause: 'résumé contextuel incohérent' });
      if (navigationRequested) {
        if (!summary.route) {
          return ok({
            kind: 'answer',
            intent,
            model,
            plan: ['Identifier l’entité affichée', 'Vérifier sa destination'],
            card: {
              title: summary.label,
              body: 'Je l’ai bien identifiée, mais elle n’a pas encore d’écran détaillé que je puisse ouvrir.',
            },
          });
        }
        return ok({
          kind: 'done',
          intent,
          model,
          plan: ['Identifier l’entité affichée', 'Relire sa destination à la source', 'Ouvrir son écran'],
          card: { title: `J’ouvre ${summary.label}`, body: `Je t’emmène vers ${summary.label}.` },
          navigate: summary.route,
        });
      }
      return ok({
        kind: 'answer',
        intent,
        model,
        plan: ['Identifier l’entité affichée', 'Relire ses informations à la source'],
        card: { title: summary.label, body: summaryBody(summary) },
      });
    }

    const nav = NAV_ROUTES[intent];
    if (nav) {
      const pourTail = intent === 'nouveau_devis' ? /\bpour\s+(.{2,60})$/i.exec(message)?.[1]?.trim() : undefined;
      return ok({
        kind: 'done',
        intent,
        model,
        plan: [nav.title],
        card: { title: nav.title, body: nav.body },
        navigate: nav.route,
        ...(pourTail !== undefined && pourTail !== '' ? { navigateHint: { customerReference: pourTail } } : {}),
      });
    }

    if (intent === 'marquer_notifications_lues') {
      const explicitlyTargetsNotifications = /\bnotifications?\b/.test(normalized(message));
      const onNotificationsScreen =
        context?.screen.instanceId === 'notifications' ||
        context?.screen.name.replace(/^\/+/, '') === 'notifications';
      if (!explicitlyTargetsNotifications && !onNotificationsScreen) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lever l’ambiguïté de la commande'],
          card: {
            title: 'Tout marquer comme lu ?',
            body: 'Tu parles bien de toutes tes notifications non lues ?',
          },
          choices: [
            {
              label: 'Oui, les notifications',
              value: 'Marque toutes les notifications comme lues',
            },
          ],
          // Doctrine ASK-1 : le followUp est fourni VERBATIM — l'UI ne reconstruit JAMAIS la
          // commande (sans ask, l'Assistant gabarisait « Encaisse la facture … » : charabia,
          // et en mode LLM le consentement pouvait dériver vers une proposition d'encaissement).
          ask: [
            askToPick({
              id: 'marquer_notifications.portee',
              question: 'Tu parles bien de toutes tes notifications non lues ?',
              header: 'Notifs',
              items: [
                {
                  value: 'toutes',
                  label: 'Oui, toutes les non-lues',
                  followUp: 'Marque toutes les notifications comme lues',
                },
              ],
            }),
          ],
        });
      }
      const previewUnread = this.deps.actions.previewUnreadNotifications?.bind(this.deps.actions);
      const tool = this.tool('marquer_notifications_lues');
      if (!previewUnread || !tool) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Notifications',
            body: 'Je ne peux pas encore modifier le fil de notifications sur cet appareil.',
          },
        });
      }
      const preview = await previewUnread();
      if (!preview.ok) return err(preview.error);
      if (!Number.isInteger(preview.value.unreadCount) || preview.value.unreadCount < 0) {
        return err({
          kind: 'dependency',
          port: 'notifications',
          cause: 'aperçu non lu incohérent',
        });
      }
      if (preview.value.unreadCount === 0) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier les notifications non lues'],
          card: { title: 'Notifications', body: 'Tout est déjà lu — rien à modifier.' },
        });
      }
      const args = { throughCreatedAt: preview.value.throughCreatedAt };
      const parsed = tool.parse(args);
      if (!parsed.ok) return err(parsed.error);
      const count = preview.value.unreadCount;
      const label = `Marquer ${count} notification${count > 1 ? 's' : ''} comme lue${count > 1 ? 's' : ''}`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: [
            'Compter les notifications non lues à la source',
            'Figer le lot avant la confirmation',
            'Attendre ta confirmation',
          ],
          card: {
            title: 'Notifications à confirmer',
            body: `${label}. Les nouvelles notifications reçues entre-temps resteront non lues.`,
          },
          pending: { tool: tool.name, args, label },
          spokenPrompt: buildSpokenConfirmation(label),
        });
      }
      const run = await tool.run(parsed.value);
      if (!run.ok) return err(run.error);
      return ok({
        kind: 'done',
        intent,
        model,
        plan: ['Marquer le lot comme lu'],
        card: { title: 'Notifications lues ✓', body: `${label} — c’est fait.` },
      });
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
      const resolved = payable.ok
        ? resolveInvoiceTarget({
            message,
            reference,
            invoices: payable.value,
            ...(context !== undefined ? { context } : {}),
            capability: 'invoice.read',
          })
        : null;
      const target = resolved?.target ?? null;
      // Cible PRÉCISE visée (référence dite, ou pièce affichée à l'écran) mais introuvable
      // parmi les relançables : on répond honnêtement — jamais la relance d'un AUTRE client.
      if (!target && resolved && (resolved.unactionableLabel !== undefined || reference !== null)) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la cible de la relance'],
          card: {
            title: 'Rien à relancer sur cette cible',
            body: resolved.unactionableLabel
              ? `« ${resolved.unactionableLabel} » n’a pas de reste dû : il n’y a rien à relancer dessus.`
              : 'Je ne retrouve pas cette pièce parmi les factures à relancer. Précise le numéro ou le client.',
          },
        });
      }
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

    if (intent === 'revue_cloture') {
      // DOSSIER-2 : le verdict de la revue de pré-signature — MÊME deriveClosingReview que
      // l'écran Clôture et le dossier envoyé. Bob révise ; l'expert-comptable signe.
      const getReview = this.deps.actions.getClosingReview?.bind(this.deps.actions);
      if (!getReview) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: { title: 'Ton dossier', body: 'Je n’ai pas accès à la revue de clôture sur cet appareil pour le moment.' },
        });
      }
      const r = await getReview();
      if (!r.ok) return err(r.error);
      const review = r.value;
      const anomalies = review.controls.filter((c) => c.status === 'anomalie');
      const reserves = review.controls.filter((c) => c.status === 'attention');
      const list = (items: typeof anomalies): string =>
        items
          .slice(0, 3)
          .map((c) => `• ${c.label} — ${c.detail}`)
          .join('\n') + (items.length > 3 ? `\n• +${items.length - 3} autre(s)` : '');
      const body = !review.readyToSign
        ? `Pas encore : ${review.anomalieCount} anomalie(s) à corriger avant signature.\n${list(anomalies)}`
        : review.hasReserves
          ? `Prêt sous réserves ✓ — ${review.attentionCount} point(s) à justifier à ton comptable :\n${list(reserves)}`
          : `Prêt pour ton comptable ✓ — ${review.okCount} contrôles passés, aucune réserve.`;
      return ok({
        kind: 'answer',
        intent,
        model,
        plan: ['Exécuter les diligences de révision', 'Équilibres, cohérence des états, comptes sensibles', 'Rendre le verdict de pré-signature'],
        card: { title: 'Ton dossier pour le comptable', body },
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
          ask: [
            askToPick({
              id: 'payer_depense.cible',
              question: 'Quelle dépense veux-tu régler ?',
              header: 'Fournisseur',
              items: r.value.map((e) => ({
                value: e.id,
                label: e.supplierName,
                description: `${formatEUR(e.totalTtcCents)} · du ${e.documentDate} — décaissement au journal de banque`,
                followUp: `Règle la dépense ${e.supplierName}`,
              })),
            }),
          ],
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
      const resolved = resolveDocumentTarget({
        message,
        reference,
        documents: r.value,
        ...(context !== undefined ? { context } : {}),
        type: 'quote',
        capability: 'quote.send',
      });
      const quote = resolved.target;
      if (!quote) {
        const options = [...resolved.choices];
        const body = unresolvedTargetBody({
          ...(resolved.unactionableLabel !== undefined ? { unactionableLabel: resolved.unactionableLabel } : {}),
          hasOptions: options.length > 0,
          ask: 'Quel devis veux-tu envoyer ?',
          empty: 'Aucun devis prêt à envoyer.',
        });
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Chercher le devis'],
          card: { title: 'Quel devis ?', body },
          choices: options.map((q) => ({ label: `${displayRef(q)} — ${q.customerName} · ${formatEUR(q.totalTtcCents)}`, value: displayRef(q) })),
          ...(options.length
            ? {
                ask: [
                  askToPick({
                    id: 'envoyer_devis.cible',
                    question: 'Quel devis veux-tu envoyer en signature ?',
                    header: 'Devis',
                    items: options.map((q) => ({
                      value: displayRef(q),
                      label: displayRef(q),
                      description: `${q.customerName} · ${formatEUR(q.totalTtcCents)}`,
                      followUp: `Envoie le devis ${displayRef(q)}`,
                    })),
                  }),
                ],
              }
            : {}),
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
      const resolved = resolveDocumentTarget({
        message,
        reference,
        documents: r.value,
        ...(context !== undefined ? { context } : {}),
        type: 'invoice',
        capability: 'invoice.issue',
      });
      const invoice = resolved.target;
      if (!invoice) {
        const options = [...resolved.choices];
        const body = unresolvedTargetBody({
          ...(resolved.unactionableLabel !== undefined ? { unactionableLabel: resolved.unactionableLabel } : {}),
          hasOptions: options.length > 0,
          ask: 'Quelle facture veux-tu émettre ?',
          empty: 'Aucune facture brouillon prête à émettre.',
        });
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Chercher la facture brouillon'],
          card: { title: 'Quelle facture ?', body },
          choices: options.map((i) => ({ label: `${displayRef(i)} — ${i.customerName} · ${formatEUR(i.totalTtcCents)}`, value: displayRef(i) })),
          ...(options.length
            ? {
                ask: [
                  askToPick({
                    id: 'emettre_facture.cible',
                    question: 'Quelle facture brouillon veux-tu émettre ?',
                    header: 'Facture',
                    items: options.map((i) => ({
                      value: displayRef(i),
                      label: displayRef(i),
                      description: `${i.customerName} · ${formatEUR(i.totalTtcCents)} — numérotation définitive`,
                      followUp: `Émets la facture ${displayRef(i)}`,
                    })),
                  }),
                ],
              }
            : {}),
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

    if (intent === 'generer_facture') {
      // ASK-2 : générer la facture d'un devis SIGNÉ — le mode (acompte/solde) est une vraie
      // décision de facturation : quand le devis prévoit un acompte non encore facturé et que
      // le message ne tranche pas, Bob POSE LA QUESTION au lieu de choisir en silence.
      const list = this.deps.actions.listInvoiceableQuotes?.bind(this.deps.actions);
      const tool = this.tool('generer_facture');
      if (!list || !tool) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: { title: 'Facturer un devis', body: 'Je n’ai pas accès à la facturation des devis sur cet appareil — passe par l’écran Ventes.' },
        });
      }
      const r = await list();
      if (!r.ok) return err(r.error);
      if (r.value.length === 0) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Chercher les devis signés facturables'],
          card: { title: 'Facturer un devis', body: 'Aucun devis signé en attente de facturation.' },
        });
      }
      const resolved = resolveDocumentTarget({
        message,
        reference,
        documents: r.value,
        ...(context !== undefined ? { context } : {}),
        type: 'quote',
        capability: 'quote.invoice.generate',
      });
      const quote = resolved.target;
      if (!quote) {
        const options = [...resolved.choices];
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lever l’ambiguïté'],
          card: {
            title: 'Quel devis ?',
            body: unresolvedTargetBody({
              ...(resolved.unactionableLabel !== undefined ? { unactionableLabel: resolved.unactionableLabel } : {}),
              hasOptions: options.length > 0,
              ask: 'Précise le devis signé à facturer :',
              empty: 'Aucun devis signé à facturer.',
            }),
          },
          choices: options.map((q) => ({ label: `${displayRef(q)} — ${q.customerName} · ${formatEUR(q.totalTtcCents)}`, value: displayRef(q) })),
          ask: [
            askToPick({
              id: 'generer_facture.cible',
              question: 'Quel devis signé veux-tu facturer ?',
              header: 'Devis',
              items: options.map((q) => ({
                value: displayRef(q),
                label: displayRef(q),
                description: `${q.customerName} · ${formatEUR(q.totalTtcCents)}${q.depositPct !== null && !q.depositInvoiced ? ` — acompte ${q.depositPct} % prévu` : ''}`,
                followUp: `Fais la facture du devis ${displayRef(q)}`,
              })),
            }),
          ],
        });
      }

      const normalizedMessage = normalized(message);
      const wantsDeposit = /acompte/.test(normalizedMessage);
      const wantsFinal = /(finale?|solde|totalite)/.test(normalizedMessage);
      let mode: 'deposit' | 'final' | null = wantsDeposit && !wantsFinal ? 'deposit' : wantsFinal ? 'final' : null;
      if (mode === null) {
        if (quote.depositPct !== null && !quote.depositInvoiced) {
          // LA question de précision : deux voies légitimes, montants exacts au diff de
          // confirmation (jamais recalculés ici — une seule vérité, le domaine).
          const ref = displayRef(quote);
          return ok({
            kind: 'answer',
            intent,
            model,
            plan: ['Identifier le devis signé', 'Demander la précision qui manque : acompte ou solde'],
            card: {
              title: 'Acompte ou facture finale ?',
              body: `Le devis ${ref} (${quote.customerName}) prévoit un acompte de ${quote.depositPct} % — il n'a pas encore été facturé.`,
            },
            choices: [
              { label: `Facture d'acompte (${quote.depositPct} %)`, value: `Fais la facture d'acompte du devis ${ref}` },
              { label: 'Facture finale', value: `Fais la facture finale du devis ${ref}` },
            ],
            ask: [
              {
                id: 'generer_facture.mode',
                question: `Acompte ou solde pour le devis ${ref} (${quote.customerName}) ?`,
                header: 'Facturation',
                options: [
                  {
                    value: 'deposit',
                    label: `Facture d'acompte (${quote.depositPct} %)`,
                    description: 'À encaisser maintenant, avant les travaux — le solde suivra en facture finale.',
                    followUp: `Fais la facture d'acompte du devis ${ref}`,
                  },
                  {
                    value: 'final',
                    label: 'Facture finale',
                    description: `Tout le chantier en une fois (${formatEUR(quote.totalTtcCents)} TTC) — sans passer par l'acompte.`,
                    followUp: `Fais la facture finale du devis ${ref}`,
                  },
                ],
              },
            ],
          });
        }
        // Pas d'acompte prévu, ou déjà facturé : la finale est l'évidence — aucune question inutile.
        mode = 'final';
      }

      const args = { quoteId: quote.id, mode };
      const label =
        mode === 'deposit'
          ? `Générer la facture d'ACOMPTE (${quote.depositPct ?? 0} %) du devis ${displayRef(quote)} — ${quote.customerName}`
          : `Générer la facture FINALE du devis ${displayRef(quote)} — ${quote.customerName} (${formatEUR(quote.totalTtcCents)} TTC${quote.depositInvoiced ? ', acompte déjà facturé déduit' : ''})`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Identifier le devis signé', 'Préparer la facture (même use case que l’écran)', 'Attendre ta confirmation'],
          card: { title: 'Facture à confirmer', body: `${label}\nJe la génère en brouillon ?` },
          pending: { tool: tool.name, args, label },
          spokenPrompt: buildSpokenConfirmation(label),
        });
      }
      const run = await tool.run(args);
      if (!run.ok) return err(run.error);
      return ok({ kind: 'done', intent, model, plan: ['Générer la facture'], card: { title: 'Facture générée ✓', body: `${label} — brouillon créé, à émettre quand tu veux.` } });
    }

    if (intent === 'encaisser') {
      const r = await this.deps.actions.listPayableInvoices();
      if (!r.ok) return err(r.error);
      const resolved = resolveInvoiceTarget({
        message,
        reference,
        invoices: r.value,
        ...(context !== undefined ? { context } : {}),
        capability: 'invoice.collect',
      });
      const invoice = resolved.target;
      if (!invoice) {
        const options = [...resolved.choices];
        const body = unresolvedTargetBody({
          ...(resolved.unactionableLabel !== undefined ? { unactionableLabel: resolved.unactionableLabel } : {}),
          hasOptions: options.length > 0,
          ask: 'Laquelle veux-tu encaisser ?',
          empty: 'Aucune facture en attente d’encaissement.',
        });
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Chercher la facture'],
          card: { title: 'Quelle facture ?', body },
          choices: options.map((i) => ({ label: `${i.number} — ${i.customerName} · ${formatEUR(i.remainingCents)}`, value: i.number })),
          ...(options.length
            ? {
                ask: [
                  askToPick({
                    id: 'encaisser.cible',
                    question: 'Quelle facture as-tu encaissée ?',
                    header: 'Facture',
                    items: options.map((i) => ({
                      value: i.number,
                      label: i.number,
                      description: `${i.customerName} · reste ${formatEUR(i.remainingCents)}`,
                      followUp: `Encaisse la facture ${i.number}`,
                    })),
                  }),
                ],
              }
            : {}),
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
    message: string,
    context?: AgentContext,
  ): Promise<Result<AgentRun, AppError>> {
    const headIntent = steps[0]?.intent ?? 'unknown';
    if (steps.some((step) => step.intent === 'marquer_notifications_lues')) {
      const explicitlyTargetsNotifications = /\bnotifications?\b/.test(normalized(message));
      const onNotificationsScreen =
        context?.screen.instanceId === 'notifications' ||
        context?.screen.name.replace(/^\/+/, '') === 'notifications';
      if (!explicitlyTargetsNotifications && !onNotificationsScreen) {
        return ok({
          kind: 'answer',
          intent: 'marquer_notifications_lues',
          model,
          plan: ['Lever l’ambiguïté avant de préparer le lot'],
          card: {
            title: 'Lot non préparé',
            body: 'Tu parles bien de toutes tes notifications non lues ? Rien n’a été exécuté.',
          },
          choices: [
            {
              label: 'Oui, les notifications',
              value: 'Marque toutes les notifications comme lues',
            },
          ],
          ask: [
            askToPick({
              id: 'marquer_notifications.portee',
              question: 'Tu parles bien de toutes tes notifications non lues ?',
              header: 'Notifs',
              items: [
                {
                  value: 'toutes',
                  label: 'Oui, toutes les non-lues',
                  followUp: 'Marque toutes les notifications comme lues',
                },
              ],
            }),
          ],
        });
      }
    }
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
        const resolved = resolveInvoiceTarget({
          message: step.reference ?? '',
          reference: step.reference,
          invoices: payables,
          ...(context !== undefined ? { context } : {}),
          capability: 'invoice.collect',
        });
        const inv = resolved.target;
        if (!inv) {
          const options = [...resolved.choices];
          const body = unresolvedTargetBody({
          ...(resolved.unactionableLabel !== undefined ? { unactionableLabel: resolved.unactionableLabel } : {}),
          hasOptions: options.length > 0,
          ask: 'Précise la facture à encaisser :',
          empty: 'Aucune facture en attente d’encaissement.',
        });
          return ok({
            kind: 'answer',
            intent: 'encaisser',
            model,
            plan: ['Lever l’ambiguïté'],
            card: { title: 'Quelle facture ?', body },
            choices: options.map((i) => ({ label: `${i.number} — ${i.customerName} · ${formatEUR(i.remainingCents)}`, value: i.number })),
            ...(options.length
              ? {
                  ask: [
                    askToPick({
                      id: 'plan.encaisser.cible',
                      question: 'Quelle facture as-tu encaissée ?',
                      header: 'Facture',
                      items: options.map((i) => ({
                        value: i.number,
                        label: i.number,
                        description: `${i.customerName} · reste ${formatEUR(i.remainingCents)}`,
                        followUp: `Encaisse la facture ${i.number}`,
                      })),
                    }),
                  ],
                }
              : {}),
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
        const resolved = resolveDocumentTarget({
          message: step.reference ?? '',
          reference: step.reference,
          documents: sendableQuotes,
          ...(context !== undefined ? { context } : {}),
          type: 'quote',
          capability: 'quote.send',
        });
        const quote = resolved.target;
        if (!quote) {
          const options = [...resolved.choices];
          const body = unresolvedTargetBody({
          ...(resolved.unactionableLabel !== undefined ? { unactionableLabel: resolved.unactionableLabel } : {}),
          hasOptions: options.length > 0,
          ask: 'Précise le devis à envoyer :',
          empty: 'Aucun devis prêt à envoyer.',
        });
          return ok({
            kind: 'answer',
            intent: 'envoyer_devis',
            model,
            plan: ['Lever l’ambiguïté'],
            card: { title: 'Quel devis ?', body },
            choices: options.map((q) => ({ label: `${displayRef(q)} — ${q.customerName} · ${formatEUR(q.totalTtcCents)}`, value: displayRef(q) })),
            ...(options.length
              ? {
                  ask: [
                    askToPick({
                      id: 'plan.envoyer_devis.cible',
                      question: 'Quel devis veux-tu envoyer en signature ?',
                      header: 'Devis',
                      items: options.map((q) => ({
                        value: displayRef(q),
                        label: displayRef(q),
                        description: `${q.customerName} · ${formatEUR(q.totalTtcCents)}`,
                        followUp: `Envoie le devis ${displayRef(q)}`,
                      })),
                    }),
                  ],
                }
              : {}),
          });
        }
        sendableQuotes = sendableQuotes.filter((q) => q.id !== quote.id);
        actions.push({
          tool: 'envoyer_devis',
          args: { quoteId: quote.id },
          label: `Envoyer le devis ${displayRef(quote)} à ${quote.customerName}`,
        });
      } else if (step.intent === 'emettre_facture') {
        const resolved = resolveDocumentTarget({
          message: step.reference ?? '',
          reference: step.reference,
          documents: issuableInvoices,
          ...(context !== undefined ? { context } : {}),
          type: 'invoice',
          capability: 'invoice.issue',
        });
        const invoice = resolved.target;
        if (!invoice) {
          const options = [...resolved.choices];
          const body = unresolvedTargetBody({
          ...(resolved.unactionableLabel !== undefined ? { unactionableLabel: resolved.unactionableLabel } : {}),
          hasOptions: options.length > 0,
          ask: 'Précise la facture à émettre :',
          empty: 'Aucune facture brouillon prête à émettre.',
        });
          return ok({
            kind: 'answer',
            intent: 'emettre_facture',
            model,
            plan: ['Lever l’ambiguïté'],
            card: { title: 'Quelle facture ?', body },
            choices: options.map((i) => ({ label: `${displayRef(i)} — ${i.customerName} · ${formatEUR(i.totalTtcCents)}`, value: displayRef(i) })),
            ...(options.length
              ? {
                  ask: [
                    askToPick({
                      id: 'plan.emettre_facture.cible',
                      question: 'Quelle facture brouillon veux-tu émettre ?',
                      header: 'Facture',
                      items: options.map((i) => ({
                        value: displayRef(i),
                        label: displayRef(i),
                        description: `${i.customerName} · ${formatEUR(i.totalTtcCents)} — numérotation définitive`,
                        followUp: `Émets la facture ${displayRef(i)}`,
                      })),
                    }),
                  ],
                }
              : {}),
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
      } else if (step.intent === 'marquer_notifications_lues') {
        const previewUnread = this.deps.actions.previewUnreadNotifications?.bind(this.deps.actions);
        const tool = this.tool('marquer_notifications_lues');
        if (!previewUnread || !tool) {
          return ok({
            kind: 'answer',
            intent: step.intent,
            model,
            plan: ['Vérifier la capacité de l’hôte'],
            card: {
              title: 'Lot interrompu',
              body: 'Je ne peux pas modifier le fil de notifications sur cet appareil. Rien n’a été exécuté.',
            },
          });
        }
        const preview = await previewUnread();
        if (!preview.ok) return err(preview.error);
        if (!Number.isInteger(preview.value.unreadCount) || preview.value.unreadCount < 0) {
          return err({ kind: 'dependency', port: 'notifications', cause: 'aperçu non lu incohérent' });
        }
        if (preview.value.unreadCount === 0) {
          return ok({
            kind: 'answer',
            intent: step.intent,
            model,
            plan: ['Vérifier les notifications non lues'],
            card: {
              title: 'Tout est déjà lu',
              body: 'Je n’ai exécuté aucune action du lot. Reformule les autres actions si tu veux les lancer seules.',
            },
          });
        }
        const args = { throughCreatedAt: preview.value.throughCreatedAt };
        const parsed = tool.parse(args);
        if (!parsed.ok) return err(parsed.error);
        const count = preview.value.unreadCount;
        actions.push({
          tool: tool.name,
          args,
          label: `Marquer ${count} notification${count > 1 ? 's' : ''} comme lue${count > 1 ? 's' : ''}`,
        });
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
      if (a.tool === 'marquer_notifications_lues') {
        const output = run.value as { updatedCount?: unknown };
        const updatedCount =
          typeof output.updatedCount === 'number' && Number.isInteger(output.updatedCount)
            ? output.updatedCount
            : 0;
        lines.push(
          updatedCount === 0
            ? '✓ Notifications déjà à jour au moment de l’exécution'
            : `✓ ${updatedCount} notification${updatedCount > 1 ? 's' : ''} marquée${updatedCount > 1 ? 's' : ''} comme lue${updatedCount > 1 ? 's' : ''}`,
        );
      } else {
        lines.push(`✓ ${a.label}`);
      }
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
    if (pending.tool === 'marquer_notifications_lues') {
      const output = run.value as { updatedCount?: unknown };
      const updatedCount =
        typeof output.updatedCount === 'number' && Number.isInteger(output.updatedCount)
          ? output.updatedCount
          : 0;
      return ok({
        kind: 'done',
        intent: 'marquer_notifications_lues',
        model,
        plan: ['Marquer le lot confirmé comme lu'],
        card: {
          title: 'Notifications à jour',
          body:
            updatedCount === 0
              ? 'Aucune notification supplémentaire n’était encore non lue au moment de la confirmation.'
              : `${updatedCount} notification${updatedCount > 1 ? 's ont' : ' a'} été marquée${updatedCount > 1 ? 's' : ''} comme lue${updatedCount > 1 ? 's' : ''}.`,
        },
      });
    }
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

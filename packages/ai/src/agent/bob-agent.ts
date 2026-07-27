import { type Result, ok, err, type AppError, type Discount, type ExpenseCategory, type FiscalDeadline, type FrenchOperationCategory, type PaymentMethod, type SituationAmountInput, formatEUR, isVatRate, parisDateOnly, PLAN_CATALOG, PROFESSIONAL_ADVANCE_RECOVERY_UNAVAILABLE_MESSAGE, retractationFreezeMessage, STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE, validateProPaymentTermsCeiling, type SubscriptionStatusView } from '@bob/core';
import { ModelRouter, type ModelChoice } from '../router/model-router';
import { renderWithGuard } from '../guardrails/money-guard';
import { naturalizeReply, type NaturalizeTone } from '../guardrails/naturalize';
import { redactPII } from '../guardrails/pii-redaction';
import { type LlmPort } from '../llm/port';
import { type AgentDocument, type AgentExpense, type BillableCustomer, type BobActions, type InvoiceableQuote, type IssuableInvoice, type PayableInvoice, type SendableQuote } from './actions';
import { buildBobTools } from '../tools/registry';
import { type AnyTool } from '../tools/tool';
import { type AgentAutonomy, DEFAULT_AUTONOMY, requiresConfirmation } from './autonomy';
import { type BobIntent, detectIntent } from './intent';
import {
  classifyWithLlm,
  classifyWithRegex,
  DETERMINISTIC_CLASSIFIER_MODEL,
} from './classifier';
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
import { expensePaymentMethodLabel, parseExpensePaymentDetails } from './expense-payment-command';
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

function notificationUpdatedCount(output: unknown): number | null {
  if (typeof output !== 'object' || output === null) return null;
  const value = (output as { updatedCount?: unknown }).updatedCount;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Dépense HISTORIQUE payée sans preuve (entité dédiée posée par RecordExpensePayment @bob/core). */
function isLegacyExpensePaymentConflict(error: AppError): boolean {
  return error.kind === 'conflict' && error.entity === 'expense_payment_legacy';
}

/**
 * Parité vocale de la régularisation : au lieu de l'erreur sèche, Bob explique l'état legacy et
 * oriente vers le geste qui existe (écran Dépenses → « Payée — à justifier » → régularisation).
 * La régularisation reste un geste comptable confirmé au tap — jamais improvisée à la voix.
 */
function legacyExpenseGuidanceCard(): ActionCard {
  return {
    title: 'Dépense à régulariser',
    body:
      'Cette dépense date d’avant le suivi des preuves de paiement : elle est marquée payée sans preuve enregistrée. '
      + 'Rien n’a été modifié. Tu peux la régulariser depuis l’écran Dépenses (badge « Payée — à justifier ») : '
      + 'même formulaire, et j’enregistre l’écriture comptable qui manque.',
  };
}

/** Lien métier EXISTANT extrait d'une erreur domaine DOCUMENT_ALREADY_LINKED — null sinon.
 * La garde anti-écrasement du core (Document.classify) refuse un lien DIFFÉRENT : Bob la
 * traduit en réponse honnête, jamais en message technique brut. */
function documentAlreadyLinkedTarget(
  error: AppError,
): { linkedEntityType: string; linkedEntityId: string } | null {
  if (error.kind !== 'domain' || error.error.code !== 'DOCUMENT_ALREADY_LINKED') return null;
  return error.error.existing;
}

/** Libellé parlé du type de lien métier d'un document (« déjà lié AU CHANTIER Durand »). */
const LINKED_ENTITY_SPOKEN: Readonly<Record<string, string>> = {
  chantier: 'au chantier',
  invoice: 'à la facture',
  quote: 'au devis',
  expense: 'à la dépense',
  customer: 'au client',
};

/** Carte honnête de la garde DOCUMENT_ALREADY_LINKED : rien n'est écrasé, rien n'est modifié. */
function alreadyLinkedCard(
  existing: { linkedEntityType: string; linkedEntityId: string },
  targetLabel?: string | null,
): ActionCard {
  const typeLabel = LINKED_ENTITY_SPOKEN[existing.linkedEntityType] ?? `à ${existing.linkedEntityType}`;
  return {
    title: 'Déjà lié — je ne touche à rien',
    body:
      `Ce document est déjà lié ${typeLabel} ${targetLabel ?? existing.linkedEntityId} — je ne l’écrase pas. `
      + 'Rien n’a été modifié : délie-le d’abord depuis sa fiche si tu veux le reclasser.',
  };
}

/** Montant TTC dit (« 89 € », « 89,90 euros ») → centimes ; null si absent ou invalide. */
function extractSpokenAmountCents(text: string): number | null {
  const m = /(\d+(?:[.,]\d{1,2})?)\s*(?:€|euros?\b|eur\b)/i.exec(text);
  if (m?.[1] === undefined) return null;
  const cents = Math.round(Number(m[1].replace(',', '.')) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** Fournisseur dit (« chez Leroy Merlin ») — extrait du texte BRUT (casse/accents conservés :
 * c'est un libellé), borné au premier délimiteur (moyen, date, chantier, ponctuation). */
function extractSpokenSupplier(text: string): string | null {
  const m =
    /\b(?:chez|aupr[eè]s de|fournisseur)\s+([^,;.!?]+?)(?=\s+(?:en|par|pour|avec|ce|cette|hier|aujourd\S*|le\s+\d|d[ée]pens\S*|cat[ée]gorie)\b|\s*[,;.!?]|$)/iu.exec(
      text,
    );
  const name = m?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  return name.length >= 2 ? name : null;
}

/** Libellé parlé des catégories de dépense (mêmes valeurs que le domaine ExpenseCategory). */
const EXPENSE_CATEGORY_SPOKEN: Readonly<Record<ExpenseCategory, string>> = {
  fournitures: 'fournitures',
  materiel: 'matériel',
  carburant: 'carburant',
  repas: 'repas',
  sous_traitance: 'sous-traitance',
  autre: 'autre',
};

/** Catégorie dite ou déduite de mots-clés SÛRS (gasoil→carburant…) — null : à demander,
 * jamais devinée au hasard. Le marqueur explicite « catégorie X » (followUps ASK) prime. */
function extractSpokenExpenseCategory(normalizedText: string): ExpenseCategory | null {
  const explicit = /categorie\s+(fournitures?|materiel|carburant|repas|sous[ -]?traitance|autres?)/.exec(normalizedText);
  if (explicit?.[1] !== undefined) {
    const raw = explicit[1];
    if (raw.startsWith('fourniture')) return 'fournitures';
    if (raw.startsWith('sous')) return 'sous_traitance';
    if (raw.startsWith('autre')) return 'autre';
    return raw as ExpenseCategory;
  }
  if (/\b(gasoil|gazole|essence|diesel|carburant|adblue|gpl|sp95|sp98|e85)\b/.test(normalizedText)) return 'carburant';
  if (/\b(repas|restaurant|resto|dejeuner|diner|sandwich|cantine)\b/.test(normalizedText)) return 'repas';
  if (/\bsous[ -]?trait/.test(normalizedText)) return 'sous_traitance';
  if (/\b(materiel|outillage)\b/.test(normalizedText)) return 'materiel';
  if (/\b(fournitures?|visserie|consommables?|quincaillerie)\b/.test(normalizedText)) return 'fournitures';
  return null;
}

/** Rendu parlé d'un montant en centimes SANS séparateur de milliers (re-parsable par
 * extractSpokenAmountCents dans les commandes de suivi — formatEUR insère des espaces). */
function spokenAmountLabel(cents: number): string {
  return cents % 100 === 0 ? `${cents / 100} €` : `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

/** « par carte » / « par virement » / « en espèces » — phrase du moyen dans une commande. */
function spokenMethodPhrase(method: PaymentMethod): string {
  return method === 'cash' ? 'en espèces' : `par ${expensePaymentMethodLabel(method)}`;
}

/** Commande CANONIQUE de la dépense dictée (M4) — les followUps ASK la renvoient VERBATIM :
 * chaque tour reparse la commande complète, garantie de re-classification depense_dictee. */
function dictatedExpenseCommand(parts: {
  amountCents: number;
  supplier: string;
  method?: PaymentMethod | null;
  category?: ExpenseCategory | null;
  dateFr?: string | null;
  chantierName?: string | null;
}): string {
  return (
    `J’ai dépensé ${spokenAmountLabel(parts.amountCents)} chez ${parts.supplier}`
    + (parts.method ? ` ${spokenMethodPhrase(parts.method)}` : '')
    + (parts.dateFr ? ` le ${parts.dateFr}` : '')
    + (parts.category ? ` (catégorie ${EXPENSE_CATEGORY_SPOKEN[parts.category]})` : '')
    + (parts.chantierName ? ` pour le chantier ${parts.chantierName}` : '')
  );
}

/** Date FR (JJ/MM/AAAA) d'un DateOnly — affichage uniquement. */
function frDate(dateOnly: string): string {
  return `${dateOnly.slice(8, 10)}/${dateOnly.slice(5, 7)}/${dateOnly.slice(0, 4)}`;
}

/** Mots du GESTE d'imputation dépense→chantier (M3) — neutralisés avant le ciblage par jetons :
 * « mets la dépense Aldi sur le chantier Durand » ne cible que par « aldi », jamais par « depense ». */
const EXPENSE_ASSIGN_GESTURE_WORDS: ReadonlySet<string> = new Set([
  'mets', 'met', 'mettre', 'impute', 'imputer', 'imputes', 'affecte', 'affecter', 'affectes',
  'lie', 'lier', 'lies', 'rattache', 'rattacher', 'rattaches', 'attache', 'attacher', 'associe',
  'associer', 'bascule', 'basculer', 'range', 'ranger', 'ranges', 'classe', 'classer', 'classes',
  'deplace', 'deplacer', 'passe', 'passer', 'depense', 'depenses', 'chantier', 'chantiers',
  'facture', 'ticket', 'recu', 'celle', 'celui', 'cette', 'cet', 'mon', 'mes', 'les', 'des',
  'pour', 'sur', 'dans', 'vers', 'aux', 'euros', 'euro', 'hier', 'aujourd', 'aujourdhui', 'stp',
  'peux', 'veux', 'plait', 'merci',
]);

/** Ciblage par jetons SIGNIFICATIFS d'une dépense (fournisseur / id / montant) — même doctrine
 * que matchDocumentsByTokens : toute ambiguïté redevient une question, jamais un choix deviné. */
function matchExpensesByTokens(conversation: string, expenses: readonly AgentExpense[]): AgentExpense[] {
  const normalizedConversation = normalized(conversation);
  const conversationTokens = normalizedConversation
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !EXPENSE_ASSIGN_GESTURE_WORDS.has(word));
  const byName = expenses.filter((expense) => {
    const id = normalized(expense.id);
    if (id.length >= 3 && containsExactTokens(normalizedConversation, id)) return true;
    const supplierTokens = new Set(
      normalized(expense.supplierName).split(/[^a-z0-9]+/).filter((word) => word.length >= 3),
    );
    return conversationTokens.some((word) => supplierTokens.has(word));
  });
  // Le montant dit RAFFINE (« la dépense Aldi de 89 € ») — il ne crée jamais un match seul.
  const amountCents = extractSpokenAmountCents(conversation);
  if (amountCents !== null && byName.length > 1) {
    const byAmount = byName.filter((expense) => expense.totalTtcCents === amountCents);
    if (byAmount.length > 0) return byAmount;
  }
  return byName;
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

const FRENCH_OPERATION_CATEGORY_OPTIONS: readonly {
  value: FrenchOperationCategory;
  label: string;
  description: string;
}[] = [
  {
    value: 'services',
    label: 'Prestation principale',
    description: 'Les fournitures sont intégrées ou accessoires à la prestation.',
  },
  {
    value: 'goods',
    label: 'Vente principale',
    description: 'La pose ou la prestation est accessoire à la vente du bien.',
  },
  {
    value: 'mixed',
    label: 'Biens et prestations séparés',
    description: 'Les biens et les prestations constituent des opérations indépendantes.',
  },
];

/**
 * Qualification BT-23 déterministe et fermée. Le LLM n'est jamais autorisé à transformer une
 * formulation incertaine en fait fiscal : zéro ou plusieurs correspondances => question.
 */
function extractFrenchOperationCategory(
  message: string,
  options: { allowOrdinal?: boolean } = {},
): FrenchOperationCategory | null {
  const text = normalized(message);
  const matches = new Set<FrenchOperationCategory>();
  if (
    /nature (?:de l[’']? ?)?operation\s*[:=-]?\s*services?\b/.test(text)
    || /prestation principale|service principal|fournitures? (?:integrees?|accessoires?)/.test(text)
  ) matches.add('services');
  if (
    /nature (?:de l[’']? ?)?operation\s*[:=-]?\s*(?:goods|biens?|vente)\b/.test(text)
    || /vente principale|bien principal|pose (?:integree|accessoire)/.test(text)
  ) matches.add('goods');
  if (
    /nature (?:de l[’']? ?)?operation\s*[:=-]?\s*(?:mixed|mixte)\b/.test(text)
    || /biens? et prestations? (?:separes?|independants?)|operations? independantes?/.test(text)
  ) matches.add('mixed');
  if (options.allowOrdinal === true) {
    if (/^(?:le |la )?(?:premier|premiere|1|1er|1ere)$/.test(text.trim())) matches.add('services');
    if (/^(?:le |la )?(?:deuxieme|second|seconde|2|2e)$/.test(text.trim())) matches.add('goods');
    if (/^(?:le |la )?(?:troisieme|3|3e)$/.test(text.trim())) matches.add('mixed');
  }
  return matches.size === 1 ? [...matches][0]! : null;
}

function extractScopedFrenchOperationCategory(
  message: string,
  invoiceRef: string,
): FrenchOperationCategory | null {
  const text = normalized(message);
  const marker = normalized(`pour la facture ${invoiceRef}`);
  const start = text.lastIndexOf(marker);
  if (start < 0) return null;
  const scoped = text.slice(start, text.indexOf(';', start + marker.length) < 0
    ? undefined
    : text.indexOf(';', start + marker.length));
  return extractFrenchOperationCategory(scoped);
}

function frenchOperationCategoryQuestion(input: {
  id: string;
  invoiceRef: string;
  customerName?: string;
  commandPrefix: string;
  scoped: boolean;
}): AgentQuestion {
  return askToPick({
    id: input.id,
    question: `Quelle est la nature principale de l’opération pour la facture ${input.invoiceRef}${input.customerName ? ` (${input.customerName})` : ''} ?`,
    header: 'Opération',
    items: FRENCH_OPERATION_CATEGORY_OPTIONS.map((option) => ({
      value: option.value,
      label: option.label,
      description: option.description,
      followUp:
        `${input.commandPrefix}; `
        + `${input.scoped ? `pour la facture ${input.invoiceRef}, ` : ''}`
        + `nature de l’opération : ${option.value}`,
    })),
  });
}

function isFrenchOperationCategoryRequiredError(error: AppError): boolean {
  if (error.kind === 'validation') {
    return error.issues.some((issue) => issue.field === 'operationCategory');
  }
  return error.kind === 'domain'
    && error.error.code === 'VALIDATION'
    && error.error.field === 'operationCategory';
}

export interface AgentRun {
  kind: AgentRunKind;
  intent: BobIntent;
  /** Modèle effectif (provider/modèle réel, classifieur déterministe, ou indisponible). */
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
  voir_catalogue: {
    route: '/catalogue',
    title: 'Ton catalogue',
    body: 'Je t’ouvre ton catalogue de prestations : libellés, prix et TVA.',
  },
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

/** Libellé intelligent d'une pièce du coffre (renommage humain > suggestion d'analyse > filename). */
function agentDocumentLabel(d: AgentDocument): string {
  const label = (d.displayName ?? '').trim();
  return label.length > 0 ? label : d.filename;
}

/** Mots du GESTE documentaire (valider/classer/renommer) — neutralisés avant le ciblage par
 * jetons : « valide le ticket Aldi » ne doit cibler que par « aldi », jamais par « ticket ». */
const DOCUMENT_GESTURE_WORDS: ReadonlySet<string> = new Set([
  'valide', 'valider', 'valides', 'confirme', 'confirmer', 'marque', 'marquer', 'comme',
  'document', 'documents', 'ticket', 'tickets', 'recu', 'recus', 'justificatif',
  'justificatifs', 'piece', 'pieces', 'attestation', 'releve', 'scan', 'scans',
  'bon', 'bons', 'est', 'c', 'ca', 'cest', 'peux', 'veux', 'moi', 'stp', 'plait',
  'le', 'la', 'les', 'l', 'de', 'du', 'des', 'un', 'une', 'mon', 'ma', 'mes',
  'ce', 'cet', 'cette', 'pour', 'dans', 'sur', 'hier', 'tout', 'vu', 'lu',
]);

/** Ciblage par jetons SIGNIFICATIFS d'une pièce du coffre (« le ticket Aldi » → « aldi ») :
 * id exact en tokens entiers, ou mot du libellé intelligent/filename. `extraGestureWords`
 * neutralise les verbes propres à chaque geste (classer/renommer) sans toucher au socle. */
function matchDocumentsByTokens(
  conversation: string,
  docs: readonly AgentDocument[],
  extraGestureWords: readonly string[] = [],
): AgentDocument[] {
  const stopwords = new Set([...DOCUMENT_GESTURE_WORDS, ...extraGestureWords]);
  const normalizedConversation = normalized(conversation);
  const conversationTokens = normalizedConversation
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !stopwords.has(word));
  return docs.filter((d) => {
    const id = normalized(d.id);
    if (id.length >= 3 && containsExactTokens(normalizedConversation, id)) return true;
    const labelTokens = new Set(
      normalized(`${agentDocumentLabel(d)} ${d.filename}`).split(/[^a-z0-9]+/).filter((word) => word.length >= 3),
    );
    return conversationTokens.some((word) => labelTokens.has(word));
  });
}

/** Jetons significatifs d'un nom de destination (chantier/dossier) — casse et accents ignorés. */
function destinationNameTokens(nom: string): string[] {
  return normalized(nom)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !NAME_STOPWORDS.has(word));
}

/** PR-08 — un site est-il EXPLICITEMENT désigné dans la phrase (« sur le site… », « au
 * chantier… ») ? Le « chez X » reste implicite : il ne compte que s'il matche un chantier réel. */
function saysExplicitSite(normalizedConversation: string): boolean {
  return /\b(?:site|chantier)s?\b/.test(normalizedConversation);
}

/**
 * PR-08 — résolution du SITE dicté (« chez Carrefour Vitry », « sur le site Bastille ») contre
 * la liste RÉELLE des chantiers ouverts du tenant — jamais un id inventé, jamais un site déduit
 * du seul nom du client (un chantier homonyme du client exige le marqueur explicite).
 * Retour : `matched` (0, 1 ou plusieurs candidats) + `explicit` (site nommé en toutes lettres).
 */
function resolveSpokenChantier(input: {
  conversation: string;
  chantiers: readonly { id: string; nom: string }[];
  customerName: string | null;
}): { matched: { id: string; nom: string }[]; explicit: boolean } {
  const normalizedConversation = normalized(input.conversation);
  const conversationTokens = new Set(
    normalizedConversation.split(/[^a-z0-9]+/).filter((word) => word.length >= 3),
  );
  const customerTokens = new Set(
    input.customerName === null ? [] : significantNameWords(normalized(input.customerName)),
  );
  const explicit = saysExplicitSite(normalizedConversation);
  const matched = input.chantiers.filter((chantier) => {
    const tokens = destinationNameTokens(chantier.nom);
    if (tokens.length === 0) return false;
    if (!tokens.every((word) => conversationTokens.has(word))) return false;
    // Nom de chantier entièrement CONTENU dans le nom du client (« Girard ») : ambigu par
    // nature — ne compte que si le site est désigné explicitement (« sur le chantier Girard »).
    if (!explicit && tokens.every((word) => customerTokens.has(word))) return false;
    return true;
  });
  return { matched, explicit };
}

/** Mots du GESTE bon de commande (B8) — neutralisés avant le ciblage par jetons : « la RATP
 * m'a envoyé un bon de commande » ne doit cibler que par « ratp », jamais par « commande ». */
const PURCHASE_ORDER_GESTURE_WORDS: ReadonlySet<string> = new Set([
  'bon', 'bons', 'commande', 'commandes', 'devis', 'facture', 'factures', 'numero', 'numeros',
  'engagement', 'recu', 'recue', 'recus', 'recues', 'recois', 'recoit', 'envoye', 'envoyee',
  'envoyes', 'envoyees', 'envoie', 'envoyer', 'repondu', 'repondue', 'repond', 'repondre',
  'arrive', 'arrivee', 'arriver', 'ajoute', 'ajouter', 'ajoutes', 'lie', 'lier', 'lies', 'liee',
  'attache', 'attacher', 'attaches', 'rattache', 'rattacher', 'associe', 'associer', 'mets',
  'mettre', 'note', 'noter', 'avec', 'pour', 'dans', 'sur', 'dernier', 'derniere', 'derniers',
  'dernieres', 'nouveau', 'nouvelle', 'client', 'clients', 'grand', 'grande', 'grands', 'compte',
  'comptes', 'signe', 'signee', 'signes', 'vient', 'viens', 'viennent', 'scanne', 'scannee',
  'scanner', 'scan', 'purchase', 'order', 'peux', 'veux', 'voudrais', 'peut', 'faut', 'merci',
  'bonjour', 'salut', 'stp', 'plait', 'cest', 'est', 'ils', 'elle', 'elles', 'nous', 'vous',
  'leur', 'leurs', 'mon', 'mes', 'ton', 'tes', 'ses', 'ces', 'cette', 'celui', 'celle', 'juste',
  'encore', 'aussi', 'alors', 'donc', 'bien', 'voila', 'hier', 'aujourd', 'aujourdhui', 'demain',
  'matin', 'soir', 'madame', 'monsieur', 'societe', 'entreprise', 'chez', 'tout', 'tous', 'toute',
]);

/** Un marqueur précédé du désignateur « devis »/« facture » appartient à la PIÈCE ciblée
 * (« au devis n° D2026-030 », « le devis numéro 12 ») : son numéro n'est JAMAIS promu
 * numéro d'engagement — une référence légale fausse ferait rejeter la facture du grand compte. */
const TARGET_PIECE_BEFORE = /(?:devis|factures?)[\s«»"',:.]{1,6}$/i;

/** Extraction du numéro d'engagement dit (« n° 4500123 », « BC-2207 », « le numéro est
 * 4500123 », « bon de commande 4500123 ») : le jeton retenu contient TOUJOURS un chiffre —
 * jamais un mot de la phrase promu numéro, jamais le numéro du devis (« au devis n° D2026-030 »
 * reste une cible, pas un numéro : garde-fou TARGET_PIECE_BEFORE sur CHAQUE occurrence).
 * Retourne aussi le texte brut apparié, à écarter du texte de ciblage du devis. */
function extractPurchaseOrderNumber(text: string): { number: string; raw: string } | null {
  const patterns: RegExp[] = [
    // « n° 4500123 » / « n° ENG-445 » — marqueur explicite : préfixe alphabétique autorisé.
    /n[°º]\s*:?\s*([A-Za-z]{0,6}[-/]?\d[\dA-Za-z\-/.]*)/i,
    // « BC-2207 » / « BC 2207 » — motif consacré du bon de commande.
    /\b(bc[-\s]?\d[\dA-Za-z\-/.]*)\b/i,
    // « le numéro (d'engagement) est 4500123 » — fillers usuels tolérés, jeton adjacent.
    /num[ée]ros?(?:\s+d.{0,3}engagement)?(?:\s+(?:est|c.est))?(?:\s+(?:le|la|du|de))?\s*:?\s*([A-Za-z]{0,6}[-/]?\d[\dA-Za-z\-/.]*)/i,
    // « bon de commande 4500123 » — jeton commençant par un CHIFFRE à courte distance
    // (le lookbehind écarte « …commande au devis D2026-030 »).
    /commande\b[^\d]{0,12}?(?<![A-Za-z])(\d[\dA-Za-z\-/.]+)/i,
  ];
  for (const pattern of patterns) {
    // Balayage GLOBAL : une occurrence gardée (numéro du devis) n'éteint pas le motif —
    // « …au devis n° D2026-030, le n° 4500123 » retient bien 4500123.
    const scan = new RegExp(pattern.source, `${pattern.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = scan.exec(text)) !== null) {
      if (m[1] === undefined) continue;
      if (TARGET_PIECE_BEFORE.test(text.slice(0, m.index))) continue;
      const cleaned = m[1].replace(/[.,;:!?]+$/, '').replace(/[-/]+$/, '');
      if (/\d/.test(cleaned) && cleaned.length >= 2) return { number: cleaned, raw: m[1] };
    }
  }
  return null;
}

/** Écarte le numéro extrait du texte de ciblage — en JETON ENTIER uniquement : un numéro
 * court (« 40 ») ne mutile jamais une référence qui le contient (« D2026-040 »), et un
 * désignateur voisin n'est jamais consommé par accident. */
function stripPurchaseOrderRaw(text: string, raw: string): string {
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}./-])${escaped}(?![\\p{L}\\p{N}./-])`, 'gu'), ' ');
}

/** Lecture STRICTE du résultat de lier_bon_commande (sortie brute OU projection publique) —
 * null si la forme dévie : l'enchaînement ne se propose jamais sur une donnée douteuse. */
function purchaseOrderChainView(
  output: unknown,
): { quoteId: string; quoteNumber: string | null; invoiceable: boolean } | null {
  if (typeof output !== 'object' || output === null) return null;
  const o = output as { quoteId?: unknown; quoteNumber?: unknown; invoiceable?: unknown };
  if (typeof o.quoteId !== 'string' || o.quoteId.length === 0) return null;
  if (o.quoteNumber !== null && o.quoteNumber !== undefined && typeof o.quoteNumber !== 'string')
    return null;
  if (typeof o.invoiceable !== 'boolean') return null;
  return { quoteId: o.quoteId, quoteNumber: o.quoteNumber ?? null, invoiceable: o.invoiceable };
}

/**
 * Carte « Bon de commande lié ✓ » + ENCHAÎNEMENT NATUREL (B8) : quand le devis est signé et
 * facturable, Bob propose la suite — la commande VERBATIM « Fais la facture du devis {ref} »
 * délègue au flow generer_facture_devis EXISTANT (handler ASK-2 acompte/solde), qui reprend le
 * bon de commande automatiquement (fait par le core). Aucune duplication du flow facturation.
 * Exportée pour que tout hôte qui confirme via son propre runtime (HTTP /ai/confirm) rende le
 * MÊME enchaînement depuis la projection publique de l'outil.
 */
export function purchaseOrderLinkedRun(input: {
  intent: BobIntent;
  model: string;
  label: string;
  output: unknown;
}): AgentRun {
  const base: AgentRun = {
    kind: 'done',
    intent: input.intent,
    model: input.model,
    plan: ['Lier le bon de commande au devis'],
    card: { title: 'Bon de commande lié ✓', body: `${input.label} — c’est noté.` },
  };
  const view = purchaseOrderChainView(input.output);
  if (!view?.invoiceable) return base;
  const ref = view.quoteNumber ?? view.quoteId;
  return {
    ...base,
    card: {
      title: 'Bon de commande lié ✓',
      body:
        `${input.label} — c’est noté.\n`
        + `Je crée la facture du devis ${ref} avec ce bon de commande ? Elle reprendra le numéro d’engagement automatiquement.`,
    },
    choices: [{ label: 'Oui — crée la facture', value: `Fais la facture du devis ${ref}` }],
    spokenPrompt: 'C’est noté. Je crée la facture avec ce bon de commande ?',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// B1/B2/B4 — Facturation terrain à la voix : facture directe, situation de
// travaux, conditions de paiement client. Extraction déterministe + commandes
// canoniques (les followUps des questions renvoient la commande COMPLÈTE :
// chaque tour reparse tout, garantie de re-classification du bon intent).
// ─────────────────────────────────────────────────────────────────────────────

/** Mots du GESTE de facturation directe / conditions client — neutralisés avant le ciblage du
 * client par jetons : « facture 380 € à Mme Girard » ne cible que par « girard ». */
const BILLING_GESTURE_WORDS: ReadonlySet<string> = new Set([
  'facture', 'factures', 'facturer', 'factureras', 'facturez', 'directe', 'direct', 'fais',
  'faire', 'cree', 'creer', 'genere', 'generer', 'prepare', 'preparer', 'etablis', 'etablir',
  'euros', 'euro', 'eur', 'ttc', 'hors', 'taxe', 'taxes', 'tva', 'taux', 'remise', 'remises',
  'client', 'clients', 'madame', 'monsieur', 'mme', 'pour', 'avec', 'sans', 'chez', 'dans',
  'sur', 'urgence', 'urgent', 'urgente', 'depannage', 'intervention', 'demandee', 'demande',
  'logement', 'plus', 'ans', 'renovation', 'energetique', 'jours', 'jour', 'fin', 'mois',
  'paie', 'paient', 'payent', 'paye', 'payes', 'paiera', 'regle', 'reglent', 'conditions',
  'condition', 'paiement', 'delai', 'delais', 'mets', 'met', 'mettre', 'passe', 'passer',
  'bascule', 'basculer', 'situation', 'situations', 'avancement', 'chantier', 'chantiers',
  'devis', 'marche', 'prestation', 'peux', 'veux', 'voudrais', 'plait', 'merci', 'stp',
  'cette', 'cet', 'celle', 'celui', 'mon', 'mes', 'ton', 'tes', 'ses', 'les', 'des', 'une',
]);

/** Pourcentage de SITUATION dit (« 40 % », « 12,5 pour cent ») — les segments TVA/remise sont
 * écartés d'abord : leur % n'est jamais promu avancement. Null si absent ou hors bornes. */
function extractSituationPercent(text: string): number | null {
  const cleaned = normalized(text)
    .replace(/tva\s*(?:a|de|au taux de)?\s*\d{1,2}(?:[.,]\d{1,2})?\s*(?:%|pour ?cent)/g, ' ')
    .replace(/\d{1,3}(?:[.,]\d{1,2})?\s*(?:%|pour ?cent)\s*(?:de\s*)?(?:remise|tva|acompte)/g, ' ')
    .replace(/remise\s*(?:globale\s*)?(?:de\s*)?\d{1,3}(?:[.,]\d{1,2})?\s*(?:%|pour ?cent)/g, ' ')
    .replace(/acompte\s*(?:de\s*)?\d{1,3}(?:[.,]\d{1,2})?\s*(?:%|pour ?cent)/g, ' ');
  const m = /(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:%|pour ?cent)/.exec(cleaned);
  if (m?.[1] === undefined) return null;
  const value = Number(m[1].replace(',', '.'));
  return Number.isFinite(value) && value > 0 && value <= 100 ? value : null;
}

/** Base du montant dicté : « 380 € HT » / « 500 € TTC » — adjacence d'abord, marqueur global
 * ensuite. Null = non dit (la question HT/TTC se pose : jamais une base devinée). */
function extractSpokenAmountBasis(text: string): 'ht' | 'ttc' | null {
  const norm = normalized(text);
  const adjacent = /\d\s*(?:€|euros?|eur)\s*(ht|ttc)\b/.exec(norm);
  if (adjacent?.[1] === 'ht' || adjacent?.[1] === 'ttc') return adjacent[1];
  if (/\bhors taxes?\b|\bht\b/.test(norm)) return 'ht';
  if (/\bttc\b|toutes taxes/.test(norm)) return 'ttc';
  return null;
}

/** Taux de TVA dit avec son MARQUEUR explicite (« TVA 10 % », « 20 % de TVA ») — null si
 * absent ou hors de l'ensemble fermé du domaine (isVatRate) : la question se pose alors. */
function extractSpokenVatRate(text: string): number | null {
  const norm = normalized(text);
  const m =
    /tva\s*(?:a|de|au taux de)?\s*(\d{1,2}(?:[.,]\d)?)\s*(?:%|pour ?cent)/.exec(norm)
    ?? /(\d{1,2}(?:[.,]\d)?)\s*(?:%|pour ?cent)\s*de\s*tva/.exec(norm);
  if (m?.[1] === undefined) return null;
  const value = Number(m[1].replace(',', '.'));
  return isVatRate(value) && value > 0 ? value : null;
}

/** Remise dictée (« 10 % de remise », « remise de 50 € ») — structure Discount du domaine,
 * null si absente. Le plafond (montant ≤ base) reste jugé par l'agrégat qui connaît la base. */
function extractSpokenDiscount(text: string): Discount | null {
  const norm = normalized(text);
  const pct =
    /remise\s*(?:globale\s*)?(?:de\s*)?(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:%|pour ?cent)/.exec(norm)
    ?? /(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:%|pour ?cent)\s*de\s*remise/.exec(norm);
  if (pct?.[1] !== undefined) {
    const value = Number(pct[1].replace(',', '.'));
    return Number.isFinite(value) && value > 0 && value <= 100 ? { type: 'percent', value } : null;
  }
  const amount =
    /remise\s*(?:de\s*)?(\d+(?:[.,]\d{1,2})?)\s*(?:€|euros?)/.exec(norm)
    ?? /(\d+(?:[.,]\d{1,2})?)\s*(?:€|euros?)\s*de\s*remise/.exec(norm);
  if (amount?.[1] !== undefined) {
    const cents = Math.round(Number(amount[1].replace(',', '.')) * 100);
    return Number.isSafeInteger(cents) && cents > 0 ? { type: 'amount', cents } : null;
  }
  return null;
}

/** Prestation dictée (« pour le dépannage de la chaudière ») — texte BRUT (casse conservée),
 * borné à la ponctuation et à la parenthèse des précisions canoniques. `raw` = segment complet
 * apparié, à écarter du texte de ciblage client. Null si rien d'exploitable. */
function extractSpokenServiceLabel(text: string): { label: string; raw: string } | null {
  const m = /\bpour\s+(?:le\s+|la\s+|l['’]\s*|les\s+|un\s+|une\s+)?([^,;.!?()]+?)(?=\s*[,;.!?(]|$)/iu.exec(text);
  if (m?.[1] === undefined) return null;
  const label = m[1].replace(/\s+/g, ' ').trim();
  // « pour le chantier Durand » désigne un lieu, jamais une prestation.
  if (label.length < 2 || /^chantiers?\b/i.test(label)) return null;
  return { label, raw: m[0] };
}

/** Rendu parlé d'un taux (« 5,5 % ») — re-parsable par extractSpokenVatRate. */
function spokenRateLabel(rate: number): string {
  return `${String(rate).replace('.', ',')} %`;
}

/** Commande CANONIQUE de la facture directe (B1) — les followUps ASK la renvoient VERBATIM :
 * chaque tour reparse la commande complète, garantie de re-classification facture_directe. */
function dictatedDirectInvoiceCommand(parts: {
  amountCents: number;
  basis: 'ht' | 'ttc' | null;
  customerName: string;
  label: string | null;
  vatRate: number | null;
  housingOlderThan2y?: boolean;
  energyRenovation?: boolean;
  urgent?: boolean;
  discount?: Discount | null;
}): string {
  const extras: string[] = [];
  if (parts.vatRate !== null) extras.push(`TVA ${spokenRateLabel(parts.vatRate)}`);
  if (parts.housingOlderThan2y === true) extras.push('logement de plus de 2 ans');
  if (parts.energyRenovation === true) extras.push('rénovation énergétique');
  if (parts.urgent === true) extras.push('intervention urgente demandée par le client');
  if (parts.discount) {
    extras.push(
      parts.discount.type === 'percent'
        ? `avec ${String(parts.discount.value).replace('.', ',')} % de remise`
        : `avec une remise de ${spokenAmountLabel(parts.discount.cents)}`,
    );
  }
  return (
    `Facture ${spokenAmountLabel(parts.amountCents)}${parts.basis !== null ? ` ${parts.basis.toUpperCase()}` : ''}`
    + ` à ${parts.customerName}`
    + (parts.label !== null ? ` pour ${parts.label}` : '')
    + (extras.length > 0 ? ` (${extras.join(', ')})` : '')
  );
}

/** Commande CANONIQUE d'une situation de travaux (B2) — re-classifiée facturer_situation. */
function situationCommand(ref: string, amount: SituationAmountInput | null): string {
  if (amount === null) return `Facture une situation sur le devis ${ref}`;
  return 'percent' in amount
    ? `Facture une situation de ${String(amount.percent).replace('.', ',')} % sur le devis ${ref}`
    : `Facture une situation de ${spokenAmountLabel(amount.amountHtCents)} HT sur le devis ${ref}`;
}

/** Commande CANONIQUE des conditions de paiement client (B4) — re-classifiée conditions_paiement. */
function paymentTermsCommand(customerName: string, days: number, endOfMonth: boolean): string {
  return `Le client ${customerName} paie à ${days} jours${endOfMonth ? ' fin de mois' : ''}`;
}

/** Libellé imprimable des conditions — même forme canonique que le défaut du registre. */
function paymentTermsLabel(days: number, endOfMonth: boolean): string {
  return endOfMonth ? `${days} jours fin de mois` : `Paiement à ${days} jours`;
}

/** Carte HONNÊTE d'un refus du domaine (garde-fou pro étranger B6, urgence b2c A3bis, cumul de
 * situations B2, plafond L441-10 B4, retenue B5…) : le MESSAGE DU DOMAINE, verbatim — la même
 * substance que l'UI, jamais reformulée, jamais un code technique brut. Null si l'erreur ne
 * porte pas de message humain (elle suit alors le chemin d'erreur ordinaire). Exportée pour
 * que tout hôte qui confirme via son propre runtime (HTTP /ai/confirm) restitue le MÊME refus. */
export function domainGuardCard(error: AppError): ActionCard | null {
  if (error.kind === 'domain') {
    const e = error.error as { message?: unknown };
    if (typeof e.message === 'string' && e.message.trim().length > 0) {
      return {
        title: 'Refusé — rien n’a été modifié',
        body: e.message.trim(),
      };
    }
    return null;
  }
  if (error.kind === 'validation' && error.issues.length > 0) {
    return {
      title: 'Refusé — rien n’a été modifié',
      body: error.issues.map((issue) => issue.message).join('\n'),
    };
  }
  return null;
}

/** Outils du lot facturation terrain (B1/B2/B4) dont les refus du domaine se restituent en
 * carte honnête — à la proposition ET à la confirmation (l'état a pu changer entre les deux).
 * Exporté : l'hôte HTTP (/ai/confirm, runtime journalisé) applique la MÊME restitution. */
export const FACTURATION_TERRAIN_TOOLS: ReadonlySet<string> = new Set([
  'facture_directe',
  'facturer_situation',
  'definir_conditions_paiement',
  // PR-01/PR-02 — mêmes refus honnêtes : brouillon non envoyable, client sans e-mail,
  // acceptation sans dépôt… le MESSAGE du domaine, verbatim, jamais un code brut.
  'envoyer_facture',
  'marquer_facture_transmise',
]);

/** % par défaut de la « Situation n°1 » (repli acompte pro, décision fondateur 25/07) — même
 * valeur que ADVANCE_FALLBACK_DEFAULT_PERCENT du Sheet mobile. Une PROPOSITION : le montant
 * reste le choix de l'artisan (la commande canonique passe par facturer_situation, modifiable). */
const ADVANCE_FALLBACK_PERCENT = 30;

/** Détails du refus PR-04 « BC obligatoire » (IssueInvoice, garde fail-closed) — null si
 * l'erreur est d'une autre nature. Le message du domaine est HONNÊTE et actionnable. */
function purchaseOrderRequiredDetails(
  error: AppError,
): { invoiceId: string; customerName: string; message: string } | null {
  if (error.kind !== 'domain' || error.error.code !== 'PURCHASE_ORDER_REQUIRED') return null;
  const e = error.error as { invoiceId?: unknown; customerName?: unknown; message?: unknown };
  if (
    typeof e.invoiceId !== 'string'
    || typeof e.customerName !== 'string'
    || typeof e.message !== 'string'
  )
    return null;
  return { invoiceId: e.invoiceId, customerName: e.customerName, message: e.message };
}

/**
 * PR-04 — parcours de RATTRAPAGE du refus « BC obligatoire » : le message du domaine verbatim
 * (même substance que l'écran), puis les DEUX chemins réels dans l'ordre de la doctrine —
 * saisir le bon de commande d'abord (lier_bon_commande), l'override responsabilisé en second
 * (risque énoncé, confirmation dédiée, journalisé serveur). Jamais un refus sec en cul-de-sac.
 */
function purchaseOrderRequiredRun(input: {
  model: string;
  invoiceRef: string;
  details: { customerName: string; message: string };
}): AgentRun {
  const attachCommand = `Ajoute le bon de commande au devis de ${input.details.customerName}`;
  const overrideCommand = `Émets la facture ${input.invoiceRef} sans bon de commande`;
  return {
    kind: 'answer',
    intent: 'emettre_facture',
    model: input.model,
    plan: ['Restituer le refus « bon de commande obligatoire »', 'Proposer le rattrapage : saisir le BC, ou émettre sans (tracé)'],
    card: {
      title: 'Bon de commande obligatoire — rien n’a été émis',
      body: input.details.message,
    },
    choices: [
      { label: 'Saisir le bon de commande', value: attachCommand },
      { label: 'Émettre sans BC (risque tracé)', value: overrideCommand },
    ],
    ask: [
      {
        id: 'emettre_facture.purchaseOrder',
        question: `Comment veux-tu débloquer la facture de ${input.details.customerName} ?`,
        header: 'BC requis',
        options: [
          {
            value: 'attach',
            label: 'Saisir le bon de commande',
            description: 'Le numéro d’engagement sera repris automatiquement sur la facture.',
            followUp: attachCommand,
          },
          {
            value: 'override',
            label: 'Émettre sans BC',
            description: 'Risque réel : facture rejetée par le client — l’émission sans BC est tracée.',
            followUp: overrideCommand,
          },
        ],
      },
    ],
  };
}

/** Ciblage d'un client par jetons SIGNIFICATIFS (mêmes règles que les devis/factures) : toute
 * ambiguïté redevient une question, jamais un choix deviné. */
function matchCustomersByTokens(conversation: string, customers: readonly BillableCustomer[]): BillableCustomer[] {
  const conversationTokens = new Set(
    normalized(conversation)
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 3 && !BILLING_GESTURE_WORDS.has(word)),
  );
  return customers.filter((customer) =>
    significantNameWords(normalized(customer.name)).some((word) => conversationTokens.has(word)),
  );
}

/** Ligne(s) descriptives de la retenue de garantie (B5) d'un devis facturable — même substance
 * que la mention UI (loi n° 71-584) ; chaîne vide sans retenue stipulée. */
function retenueNote(quote: Pick<InvoiceableQuote, 'retenueGarantiePct'>): string {
  const pct = quote.retenueGarantiePct ?? null;
  if (pct === null) return '';
  return ` La retenue de garantie de ${String(pct).replace('.', ',')} % (loi n° 71-584 du 16 juillet 1971) sera déduite du net à payer — libérée un an après la réception des travaux.`;
}

/** Ligne d'échéance fiscale, sobre (C-EXP5b) : date FR, libellé, « à confirmer » sur les
 * hypothèses ('assumed'), puis l'explication du use case — jamais un montant (v1 n'en émet pas). */
function fiscalDeadlineLine(d: FiscalDeadline): string {
  const dateFr = `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}/${d.date.slice(0, 4)}`;
  const flag = d.confidence === 'assumed' ? ' (à confirmer)' : '';
  return `• ${dateFr} — ${d.label}${flag}\n  ${d.explain}`;
}

/**
 * Réponse « où en est mon abonnement / mon essai » (pilier 2) — FACTUELLE et lecture seule :
 * l'état vient de GetSubscriptionStatus (la même vérité que l'écran Compte). Jamais un CTA
 * d'achat vocal (SPEC décision 10) : tout engagement payant se confirme au TAP, dans Compte.
 */
function subscriptionStatusBody(s: SubscriptionStatusView): string {
  const label = PLAN_CATALOG[s.plan].label;
  const dateFr = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  if (
    s.store === 'none' &&
    s.status === 'active' &&
    s.currentPeriodEnd === null &&
    s.storeRef === null
  ) {
    return 'Tu es en accès anticipé : toutes les fonctions sont ouvertes et rien ne t’est facturé.';
  }
  if (s.status === 'trialing' && s.trialEndsAt !== null) {
    if (s.trialPhase === 'expired') {
      return `Ton essai ${label} s’est terminé le ${dateFr(s.trialEndsAt)}. Tu es en Découverte (gratuit) : tes documents et ta facturation conforme restent disponibles. Pour continuer avec ${label}, passe par l’écran Compte.`;
    }
    const days = s.trialDaysLeft ?? 0;
    return `Essai ${label} en cours : encore ${days} jour${days > 1 ? 's' : ''} (jusqu’au ${dateFr(s.trialEndsAt)}), sans carte ni engagement. Quoi que tu décides, tes documents restent à toi.`;
  }
  if (s.status === 'past_due') {
    return `Ton offre ${label} a un paiement en échec. Régularise depuis l’écran Compte — tes données restent intactes.`;
  }
  if (s.status === 'canceled') {
    return `Ton abonnement ${label} est résilié. Tes documents et ta facturation conforme restent disponibles en Découverte.`;
  }
  const period = s.currentPeriodEnd !== null ? ` (période en cours jusqu’au ${dateFr(s.currentPeriodEnd)})` : '';
  return `Offre ${label} active${period}.`;
}

/** Intent public d'un outil — exporté pour que tout hôte qui confirme via son propre
 * runtime (HTTP /ai/confirm, client local) étiquette le run comme BobAgent.confirm. */
export function intentForTool(tool: string): BobIntent {
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
  if (tool === 'etat_abonnement') return 'abonnement';
  if (tool === 'position_tva') return 'tva';
  if (tool === 'balance_agee') return 'balance';
  if (tool === 'enregistrer_reglement_depense') return 'payer_depense';
  if (tool === 'envoyer_relance') return 'relance';
  if (tool === 'envoyer_facture') return 'envoyer_facture';
  if (tool === 'relance_devis') return 'relance_devis';
  if (tool === 'marquer_facture_transmise') return 'declarer_transmission';
  if (tool === 'cadence_relances' || tool === 'regler_relances_auto') return 'cadence_relances';
  if (tool === 'scan_depense') return 'depense_dictee';
  if (tool === 'lier_depense_chantier') return 'lier_depense_chantier';
  if (tool === 'valider_document') return 'valider_document';
  if (tool === 'classer_document') return 'classer_document';
  if (tool === 'renommer_document') return 'renommer_document';
  if (tool === 'chercher_document') return 'chercher_document';
  if (tool === 'lier_bon_commande') return 'lier_bon_commande';
  if (tool === 'facture_directe') return 'facture_directe';
  if (tool === 'facturer_situation') return 'facturer_situation';
  if (tool === 'definir_conditions_paiement') return 'conditions_paiement';
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
  /** Annulation coopérative du tour (barge-in/supersession). */
  signal?: AbortSignal;
}

const BOB_GENERIC_CAPABILITY_CATALOG = [
  '· Facturation — « fais un devis pour Martin », « crée une facture pour Martin », « relance mes clients »',
  '· Dépenses — « scanne ce ticket », « ajoute une dépense Leroy Merlin »',
  '· Fiscal — « combien de TVA je dois ? », « mes échéances à venir », « suis-je prêt pour la facturation électronique ? »',
  '· Pilotage — « comment va mon activité ? », « qui me doit de l’argent ? », « combien je peux me verser ? »',
].join('\n');

/**
 * Gabarits génériques déterministes. Ils ne contiennent aucune donnée tenant ; le routeur
 * acoustique les compare exactement avant d'autoriser un scénario natif à faible risque.
 */
export const BOB_GENERIC_ASSISTANCE_SPEECH = Object.freeze({
  help:
    'Je m’occupe de l’administratif et du financier de ton activité. Dis-moi par exemple :\n'
    + BOB_GENERIC_CAPABILITY_CATALOG,
  unknown:
    'Je ne traite que l’administratif et le financier de ton activité (je ne réponds pas aux questions hors de ce périmètre). '
    + 'Voici ce que je sais faire :\n'
    + BOB_GENERIC_CAPABILITY_CATALOG,
} as const);

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
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (this.deps.llm && routedModel !== 'unavailable') {
      try {
        return await classifyWithLlm(this.deps.llm, message, history, context, signal);
      } catch {
        // Un barge-in n'est jamais une indisponibilité LLM : ne surtout pas poursuivre par regex.
        signal?.throwIfAborted();
        // LLM indisponible : on retombe sur la détection déterministe (jamais bloquant).
      }
    }
    signal?.throwIfAborted();
    return classifyWithRegex(message);
  }

  async ask(message: string, opts: AskOptions = {}): Promise<Result<AgentRun, AppError>> {
    opts.signal?.throwIfAborted();
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
    // Une réponse vocale courte (« hier », « par carte ») doit poursuivre la question Bob en
    // cours. On n'élargit ce contexte qu'au parcours règlement, avec une question Bob explicite,
    // pour ne jamais ressusciter arbitrairement un ancien intent mutatif.
    const lastBobTurn = [...(history ?? [])].reverse().find((turn) => turn.role === 'bob');
    const recentUserTurns = (history ?? []).slice(-5).filter((turn) => turn.role === 'user');
    const isExpensePaymentContinuation = lastBobTurn !== undefined
      && /(date|moyen).{0,30}r[èe]glement|r[èe]glement.{0,30}(date|moyen)/i.test(lastBobTurn.text)
      && recentUserTurns.some((turn) => /(d[ée]pense|fournisseur).*(pay[ée]|r[ée]gl)|(?:pay[ée]|r[ée]gl).*(d[ée]pense|fournisseur)/i.test(turn.text));
    // B8 — continuité du numéro : après la question Bob « il me faut le numéro du bon de
    // commande… », la réponse courte (« c'est le n° 4500123 ») reste dans ce parcours.
    const isPurchaseOrderContinuation = lastBobTurn !== undefined
      && /num[ée]ro du bon de commande/i.test(lastBobTurn.text)
      && recentUserTurns.some((turn) => /bon de commande|purchase order|num[ée]ro d.engagement|\bbc[- ]?\d/i.test(turn.text));
    // M4 — continuité de la dépense dictée : après une question Bob (fournisseur/montant/moyen/
    // catégorie « … de cette dépense »), la réponse courte (« chez Total », « 89 € ») poursuit
    // LE parcours en cours au lieu de ressusciter un autre intent.
    const isDictatedExpenseContinuation = lastBobTurn !== undefined
      && /(fournisseur|montant|moyen|cat[ée]gorie|date).{0,50}d[ée]pense|d[ée]pense.{0,50}(fournisseur|montant|moyen|cat[ée]gorie|date)/i.test(lastBobTurn.text)
      && recentUserTurns.some((turn) => /j\W{0,3}ai d[ée]pens[ée]|\d\s*(?:€|euros?)|d[ée]pense/i.test(turn.text));
    // B1 — continuité de la facture directe : après une question Bob du parcours (« … de cette
    // facture directe »), la réponse courte (« 380 € », « pour le dépannage ») poursuit le
    // parcours au lieu de ressusciter un autre intent.
    const isDirectInvoiceContinuation = lastBobTurn !== undefined
      && /facture directe/i.test(lastBobTurn.text)
      && recentUserTurns.some((turn) => /factur/i.test(turn.text));
    // B2 — continuité de la situation : après la question d'avancement (« … de cette
    // situation »), la réponse courte (« 40 % », « 12 000 € HT ») poursuit le parcours.
    const isSituationContinuation = lastBobTurn !== undefined
      && /situation/i.test(lastBobTurn.text)
      && /avancement|montant|pourcentage/i.test(lastBobTurn.text)
      && recentUserTurns.some((turn) => /situation/i.test(turn.text));
    // B4 — continuité des conditions de paiement : après la question du délai ou du client
    // (« … conditions de paiement »), la réponse courte (« 45 jours fin de mois ») poursuit.
    const isPaymentTermsContinuation = lastBobTurn !== undefined
      && /conditions de paiement/i.test(lastBobTurn.text)
      && recentUserTurns.some((turn) => /paie|paye|r[èe]gle|jours|conditions/i.test(turn.text));
    // BT-23 — une réponse courte (« le premier », « mixte ») n'a de sens que juste après LA
    // question sur la nature de l'opération et dans un parcours d'émission réellement présent
    // dans l'historique. Hors de ce contexte, aucun ordinal ne devient un fait fiscal.
    const lastInvoiceIssueTurn = [...recentUserTurns]
      .reverse()
      .find((turn) => detectIntent(turn.text) === 'emettre_facture');
    const isOperationCategoryContinuation = lastBobTurn !== undefined
      && /nature (?:principale )?de l[’']op[ée]ration/i.test(lastBobTurn.text)
      && lastInvoiceIssueTurn !== undefined;
    if (
      isOperationCategoryContinuation
      && parseVoiceConsent(userMessage) === 'cancel'
    ) {
      return ok({
        kind: 'answer',
        intent: 'emettre_facture',
        model: DETERMINISTIC_CLASSIFIER_MODEL,
        plan: ['Annuler la qualification avant émission'],
        card: {
          title: 'Émission annulée',
          body: 'Je n’émets pas la facture. Rien n’a été modifié.',
        },
        spokenPrompt: 'Entendu, je n’émets pas la facture. Rien n’a été modifié.',
      });
    }
    const continuedOperationCategory = isOperationCategoryContinuation
      ? extractFrenchOperationCategory(userMessage, { allowOrdinal: true })
      : null;
    const operationCategoryCommand = isOperationCategoryContinuation
      ? `${lastInvoiceIssueTurn.text}; ${continuedOperationCategory === null
          ? userMessage
          : `nature de l’opération : ${continuedOperationCategory}`}`
      : null;
    // B8 — passerelle d'enchaînement : après « Bon de commande lié ✓ », un OUI franc délègue au
    // flow generer_facture_devis EXISTANT via sa commande canonique VERBATIM ; un NON franc clôt
    // proprement (le lien, lui, est déjà fait). Jamais d'action sur une réponse ambiguë.
    const invoiceChainRef = lastBobTurn !== undefined
      ? (/facture du devis\s+([\p{L}\p{N}][\p{L}\p{N}\-./]*)\s+avec ce bon de commande/iu.exec(lastBobTurn.text)?.[1] ?? null)
      : null;
    if (invoiceChainRef !== null && parseVoiceConsent(userMessage) === 'cancel') {
      return ok({
        kind: 'answer',
        intent: 'lier_bon_commande',
        model: DETERMINISTIC_CLASSIFIER_MODEL,
        plan: ['Clore l’enchaînement facture'],
        card: {
          title: 'Très bien',
          body: 'Je ne crée pas la facture. Le bon de commande reste lié au devis — dis-moi « fais la facture » quand tu seras prêt.',
        },
        spokenPrompt: 'Entendu, pas de facture pour l’instant. Le bon de commande reste lié au devis.',
      });
    }
    const chainCommand = invoiceChainRef !== null && parseVoiceConsent(userMessage) === 'confirm'
      ? `Fais la facture du devis ${invoiceChainRef}`
      : null;
    const classificationMessage = chainCommand
      ?? operationCategoryCommand
      ?? (isExpensePaymentContinuation
        || isPurchaseOrderContinuation
        || isDictatedExpenseContinuation
        || isDirectInvoiceContinuation
        || isSituationContinuation
        || isPaymentTermsContinuation
        ? `${recentUserTurns.map((turn) => turn.text).join(' ')} ${userMessage}`
        : userMessage);
    // Le message des handlers : la commande canonique quand l'enchaînement a été accepté,
    // sinon la demande telle que dite (les handlers relisent l'historique eux-mêmes).
    const effectiveMessage = chainCommand ?? operationCategoryCommand ?? userMessage;
    const plan = await this.classify(classificationMessage, routed.model, history, context, opts.signal);
    opts.signal?.throwIfAborted();
    const model =
      plan.model !== DETERMINISTIC_CLASSIFIER_MODEL || routed.model === 'unavailable'
        ? plan.model
        : routed.model;
    const steps = plan.steps.filter((s) => s.intent !== 'unknown');
    // La lecture contextuelle est une réponse, pas une action de lot : dans une demande
    // multi-étapes, on la retire du lot (sinon elle serait perdue en silence) — seule, elle
    // s'exécute normalement en runSingle.
    const batchSteps = steps.length > 1 ? steps.filter((s) => s.intent !== 'contexte_ecran') : steps;
    const effective = batchSteps.length > 0 ? batchSteps : steps.slice(0, 1);

    let result: Result<AgentRun, AppError>;
    if (effective.length === 0) result = ok(this.unknownRun(model));
    else {
      opts.signal?.throwIfAborted();
      opts.onPhase?.('agis');
      result =
        effective.length > 1
          ? await this.runMulti(effective, autonomy, model, effectiveMessage, context)
          : await this.runSingle(effective[0]!, autonomy, model, effectiveMessage, context, history);
    }
    // Les ports métier ne sont pas tous interruptibles, mais aucun résultat tardif ne franchit ce fence.
    opts.signal?.throwIfAborted();
    // LIVE-2 : mise en mots des FAITS par le LLM — réponses et résultats seulement, JAMAIS
    // les actions proposées (le consentement reste verbatim) ni les questions structurées
    // (leur formulation est lue par speakableQuestion). Fallback silencieux : le gabarit.
    // Le catalogue « aide » (S9) reste lui aussi VERBATIM : ses exemples sont des commandes
    // canoniques garanties par detectIntent — une reformulation les casserait.
    if (
      result.ok
      && this.deps.llm
      && model !== 'unavailable'
      && model !== DETERMINISTIC_CLASSIFIER_MODEL
      && (result.value.kind === 'answer' || result.value.kind === 'done')
      && result.value.intent !== 'aide'
      && !result.value.ask?.length
    ) {
      const natural = await naturalizeReply(this.deps.llm, {
        title: result.value.card.title,
        body: result.value.card.body,
        userMessage: redactPII(userMessage),
        tone: (payload.value.tone ?? 'pote') as NaturalizeTone,
        history: (history ?? []).map((turn) => ({
          role: turn.role === 'user' ? ('user' as const) : ('assistant' as const),
          content: redactPII(turn.text),
        })),
        // Frontière confidentialité fail-closed : une réponse métier reste tenant-sensitive
        // même sans chiffre détectable (« Aucun document archivé », statut, nom client…).
        // Seule l'aide générique `unknown`, sans contexte d'écran, peut être stylisée en cloud.
        sensitiveContext: context !== undefined || result.value.intent !== 'unknown',
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
      opts.signal?.throwIfAborted();
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
        body: BOB_GENERIC_ASSISTANCE_SPEECH.unknown,
      },
    };
  }

  /** « aide » / « tu sais faire quoi ? » : le MÊME catalogue, sans la phrase d'écartement —
   * la personne demande un mode d'emploi, pas un refus. Livré verbatim (jamais naturalisé). */
  private helpRun(model: string): AgentRun {
    return {
      kind: 'answer',
      intent: 'aide',
      model,
      plan: ['Présenter les capacités'],
      card: {
        title: 'Ce que je sais faire',
        body: BOB_GENERIC_ASSISTANCE_SPEECH.help,
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
    history?: AskOptions['history'],
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

    // DÉCOUVRABILITÉ (S9) : l'aide explicite rend le catalogue des capacités — jamais l'écartement
    // hors-périmètre (unknown), et jamais une action : réponse pure, aucun pending ni navigate.
    if (intent === 'aide') return ok(this.helpRun(model));

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
      // Phase 1C (SPEC_EXPERT_FISCAL §V2 pt. 1+6) : quand l'hôte expose getOwnerPayGuidance, la
      // réponse PARLÉE utilise le MÊME moteur pur (deriveOwnerPayGuidance @bob/core) et les MÊMES
      // kinds que les écrans Argent/Aujourd'hui — parité stricte. Hôte pas encore branché, ou
      // erreur → repli sur computePayout() (le langage prudent historique, INCHANGÉ).
      const guidanceResult = await this.deps.actions.getOwnerPayGuidance?.();
      if (guidanceResult?.ok) {
        const { guidance, payoutCents } = guidanceResult.value;
        const spoken = ((): { template: string; values: { token: string; cents: number }[] } => {
          switch (guidance.kind) {
            case 'micro_retrait_prudent': {
              const acreNote = typeof guidance.params.acreNote === 'string' ? guidance.params.acreNote : '';
              const ratePct = guidance.params.ratePct;
              return {
                template: `Tu peux te prendre {{amount}} ce mois-ci — tes cotisations URSSAF (~${ratePct} %) sont déjà mises de côté.${acreNote}`,
                values: [{ token: 'amount', cents: guidance.amountCents ?? payoutCents }],
              };
            }
            case 'salaire_a_simuler':
              return {
                template:
                  'Ta boîte te paie en salaire : budget employeur mobilisable {{amount}}. Le net exact se simule avec ton profil, bientôt.',
                values: [{ token: 'amount', cents: payoutCents }],
              };
            case 'prelevement_apres_provisions':
              return {
                template:
                  '{{amount}} de trésorerie mobilisable, avant tes provisions personnelles (retraite, maladie) à prévoir — je te les précise bientôt.',
                values: [{ token: 'amount', cents: payoutCents }],
              };
            case 'prudent':
            default:
              // Langage prudent (SPEC_EXPERT_FISCAL §V2 pt. 8) : trésorerie mobilisable ≠
              // rémunération — celle-ci dépend du statut/régime. Jamais « te verser » ici.
              return {
                template:
                  'Tu as {{payout}} de trésorerie mobilisable sans toucher tes réserves. Ta rémunération exacte dépend de ton statut, je te la précise bientôt.',
                values: [{ token: 'payout', cents: payoutCents }],
              };
          }
        })();
        const guard = renderWithGuard(spoken.template, spoken.values);
        if (!guard.ok) return err({ kind: 'dependency', port: 'money-guard', cause: guard.violations.join(', ') });
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lire le profil fiscal confirmé', 'Lire la trésorerie réelle', 'Adapter le langage à la situation'],
          card: { title: 'Ta trésorerie mobilisable', body: guard.rendered },
        });
      }

      const r = await this.deps.actions.computePayout();
      if (!r.ok) return err(r.error);
      // Langage prudent (SPEC_EXPERT_FISCAL §V2 pt. 8) : trésorerie mobilisable ≠ rémunération —
      // celle-ci dépend du statut/régime, pas encore connu du produit. Jamais « te verser » ici.
      const guard = renderWithGuard(
        'Tu as {{payout}} de trésorerie mobilisable sans toucher tes réserves. Ta rémunération exacte dépend de ton statut, je te la précise bientôt.',
        [{ token: 'payout', cents: r.value.payoutCents }],
      );
      if (!guard.ok) return err({ kind: 'dependency', port: 'money-guard', cause: guard.violations.join(', ') });
      return ok({
        kind: 'answer',
        intent,
        model,
        plan: ['Lire la trésorerie réelle', 'Calculer la trésorerie mobilisable sans risque'],
        card: { title: 'Ta trésorerie mobilisable', body: guard.rendered },
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
      // M2 — envoi RÉEL (envoyer_relance) quand l'hôte le fournit : « relance Durand » présente
      // le BROUILLON réel du service puis propose l'envoi — jamais envoyé sans confirmation
      // (plancher sortant, mise en demeure possible). Le brouillon seul reste accessible
      // (« prépare/montre la relance », « sans envoyer ») et reste le comportement des hôtes
      // sans capacité d'envoi (rétro-compatibilité stricte).
      const sendTool = this.tool('envoyer_relance');
      const normalizedRelanceMessage = normalized(message);
      const draftOnly =
        sendTool === undefined ||
        !payable.ok ||
        /\b(brouillon|prepare|preparer|prepares|redige|rediger|rediges|montre|montrer|montres|ecris|ecrire|relis|lis)\b/.test(
          normalizedRelanceMessage,
        ) ||
        /\bsans (l\W{0,3})?envoyer\b/.test(normalizedRelanceMessage);
      if (draftOnly) {
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
      // Zéro impayé : l'état RÉEL, honnête — le message par défaut du plan de relances de l'hôte.
      if (payable.value.length === 0) {
        const r = await this.deps.actions.draftRelance(undefined);
        if (!r.ok) return err(r.error);
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier les factures à relancer'],
          card: { title: r.value.subject, body: r.value.body },
        });
      }
      // Ambiguïté → question avec les FACTURES RÉELLES : jamais un envoi sur une cible devinée.
      if (!target) {
        const options = payable.value.slice(0, 4);
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lister les factures à encaisser', 'Lever l’ambiguïté de la cible'],
          card: { title: 'Quelle facture ?', body: 'Dis-moi quelle facture relancer :' },
          choices: options.map((i) => ({
            label: `${i.number} — ${i.customerName} · ${formatEUR(i.remainingCents)}`,
            value: `Relance la facture ${i.number}`,
          })),
          ask: [
            askToPick({
              id: 'relance.cible',
              question: 'Quelle facture veux-tu relancer ?',
              header: 'Relance',
              items: options.map((i) => ({
                value: i.number,
                label: i.number,
                description: `${i.customerName} · reste ${formatEUR(i.remainingCents)}`,
                followUp: `Relance la facture ${i.number}`,
              })),
            }),
          ],
        });
      }
      // Le TEXTE RÉEL du service (deriveRelancePlan côté hôte) — jamais un message improvisé.
      const draft = await this.deps.actions.draftRelance({ invoiceId: target.id });
      if (!draft.ok) return err(draft.error);
      // Facture encaissable mais PAS en retard : le plan ne la relance pas — réponse honnête.
      if (/^rien a relancer/.test(normalized(draft.value.subject))) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: [`Cibler la facture ${target.number} (${target.customerName})`, 'Vérifier le plan de relances'],
          card: { title: draft.value.subject, body: draft.value.body },
        });
      }
      const args = { invoiceId: target.id };
      const parsed = sendTool.parse(args);
      if (!parsed.ok) return err(parsed.error);
      const label = `Envoyer la relance de la facture ${target.number} à ${target.customerName} (reste dû ${formatEUR(target.remainingCents)})`;
      if (requiresConfirmation(sendTool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: [
            `Cibler la facture ${target.number} (${target.customerName})`,
            'Rédiger la relance (texte réel du plan de relances)',
            'Attendre ta confirmation',
          ],
          card: {
            title: 'Relance à confirmer — voici le message',
            body: `Objet : ${draft.value.subject}\n${draft.value.body}\n—\n${label}. J’envoie ce message au client ?`,
          },
          pending: { tool: sendTool.name, args, label },
          spokenPrompt: buildSpokenConfirmation(label),
        });
      }
      const run = await sendTool.run(parsed.value);
      if (!run.ok) return err(run.error);
      return ok({
        kind: 'done',
        intent,
        model,
        plan: ['Envoyer la relance'],
        card: { title: 'Relance envoyée ✓', body: `${label} — c’est parti.` },
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
      // LOT 5 : la file « à confirmer » (reviewedAt null) entre dans la réponse — MÊME définition
      // que la file de l'écran Documents (scanné OCR, jamais confirmé, hors dépense). Un hôte
      // historique sans reviewedAt/origin n'expose rien : aucune file « supposée ».
      const pending = r.value.filter(
        (d) => d.origin === 'ocr' && d.reviewedAt === null && d.linkedEntityType !== 'expense',
      );
      if (pending.length === 0) {
        return ok({ kind: 'answer', intent, model, plan: ['Lister les documents archivés'], card: { title: 'Documents', body } });
      }
      const first = pending[0]!;
      // « rangé dans Achats » : nom RÉEL du dossier si l'hôte expose les destinations — sinon
      // la mention est simplement omise (jamais un nom deviné).
      let folderName: string | null = null;
      const listDestinations = this.deps.actions.listFilingDestinations?.bind(this.deps.actions);
      if (listDestinations && typeof first.folderId === 'string') {
        const destinations = await listDestinations();
        if (destinations.ok) {
          folderName = destinations.value.dossiers.find((f) => f.id === first.folderId)?.nom ?? null;
        }
      }
      const intro = `Tu as ${pending.length} document${pending.length > 1 ? 's' : ''} à confirmer, dont « ${agentDocumentLabel(first)} »${folderName !== null ? ` rangé dans ${folderName}` : ''} — je te les montre ?`;
      return ok({
        kind: 'answer',
        intent,
        model,
        plan: ['Lister les documents archivés', 'Repérer la file « À confirmer »'],
        card: { title: 'Documents', body: `${intro}\n${body}` },
        choices: pending.slice(0, 4).map((d) => ({
          label: `Valider « ${agentDocumentLabel(d)} »`,
          value: `Valide le document ${d.id}`,
        })),
        ask: [
          askToPick({
            id: 'documents.a_confirmer',
            question: 'Lequel veux-tu confirmer ?',
            header: 'À confirmer',
            items: pending.slice(0, 4).map((d) => ({
              value: d.id,
              label: agentDocumentLabel(d),
              description: `scanné le ${d.createdAt.slice(8, 10)}/${d.createdAt.slice(5, 7)}/${d.createdAt.slice(0, 4)}`,
              followUp: `Valide le document ${d.id}`,
            })),
          }),
        ],
      });
    }

    if (intent === 'valider_document') {
      // « C'est bon, valide le ticket Aldi » — MÊME use case AcknowledgeDocument (@bob/core)
      // que le bouton « Confirmer » de la file « À valider » (parité humain↔Bob). Bob ne
      // valide JAMAIS un document qu'il ne peut pas cibler sans ambiguïté.
      const acknowledge = this.deps.actions.acknowledgeDocument?.bind(this.deps.actions);
      const tool = this.tool('valider_document');
      if (!acknowledge || !tool) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Valider un document',
            body: 'Je ne peux pas valider de document pour le moment. Rien n’a été modifié — tu peux le confirmer depuis l’écran Documents.',
          },
        });
      }
      const r = await this.deps.actions.listDocuments();
      if (!r.ok) return err(r.error);
      // Même définition que la file « À valider » (écran Documents) : scanné (OCR), jamais
      // confirmé, hors dépense. Un hôte historique sans reviewedAt/origin n'expose rien —
      // aucun document « supposé » à valider, jamais une validation à l'aveugle.
      const pending = r.value.filter(
        (d) => d.origin === 'ocr' && d.reviewedAt === null && d.linkedEntityType !== 'expense',
      );
      if (pending.length === 0) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lister la file « À valider »'],
          card: { title: 'Rien à valider', body: 'Aucun document scanné n’attend ta validation. 🎉' },
        });
      }
      const conversation = [
        ...(history ?? []).slice(-4).filter((turn) => turn.role === 'user').map((turn) => turn.text),
        message,
      ].join(' ');
      const targetLabel = agentDocumentLabel;
      // Ciblage par jetons SIGNIFICATIFS (« le ticket Aldi » → « aldi ») : les mots du geste
      // lui-même sont neutralisés. Une cible n'est retenue que si elle est UNIQUE — toute
      // ambiguïté redevient une question, jamais une validation à l'aveugle.
      const matches = matchDocumentsByTokens(conversation, pending);
      const target = matches.length === 1 ? matches[0]! : null;
      if (!target) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lister la file « À valider »'],
          card: { title: 'Quel document ?', body: 'Dis-moi quel document valider :' },
          choices: pending.slice(0, 8).map((d) => ({
            label: targetLabel(d),
            value: `valide le document ${d.id}`,
          })),
          ask: [
            askToPick({
              id: 'valider_document.cible',
              question: 'Quel document veux-tu valider ?',
              header: 'Document',
              items: pending.slice(0, 8).map((d) => ({
                value: d.id,
                label: targetLabel(d),
                description: `scanné le ${d.createdAt.slice(8, 10)}/${d.createdAt.slice(5, 7)}/${d.createdAt.slice(0, 4)}`,
                followUp: `Valide le document ${d.id}`,
              })),
            }),
          ],
        });
      }
      // Un doc non rangé ne se « valide » pas (même règle que l'écran détail) : reviewedAt le
      // sortirait de la file sans le placer dans aucun dossier — pièce orpheline. Bob refuse
      // honnêtement et oriente vers le classement ; rien n'est modifié.
      if ((target.folderId ?? null) === null) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Contrôler le rangement avant validation'],
          card: {
            title: 'À ranger d’abord',
            body: `« ${targetLabel(target)} » n’est pas encore rangé dans un dossier. Classe-le d’abord (écran Documents → « Classer »), puis je pourrai le valider. Rien n’a été modifié.`,
          },
        });
      }
      const args = { documentId: target.id };
      const label = `Valider « ${targetLabel(target)} » (il sort de la file « À valider »)`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Trouver le document', 'Contrôler son rangement', 'Attendre ta confirmation'],
          card: {
            title: 'Validation à confirmer',
            body: `${label}. Je ne déplace rien, je ne lie rien : je confirme seulement que tu l’as vu. Je continue ?`,
          },
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
        plan: ['Valider le document'],
        card: { title: 'Document validé ✓', body: `${label} — c’est fait.` },
      });
    }

    if (intent === 'classer_document') {
      // LOT 5 — « Range le ticket Aldi dans le chantier Durand » : MÊME séquence que le geste
      // « Classer là » mobile (MoveDocumentToFolder + ClassifyDocument + nom intelligent), via
      // l'action hôte fileDocument. Destination = chantier OUVERT ou dossier RÉEL du tenant —
      // jamais un id inventé : refus honnête si introuvable, question si ambigu.
      const fileDocument = this.deps.actions.fileDocument?.bind(this.deps.actions);
      const listDestinations = this.deps.actions.listFilingDestinations?.bind(this.deps.actions);
      const tool = this.tool('classer_document');
      if (!fileDocument || !listDestinations || !tool) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Classer un document',
            body: 'Je ne peux pas classer de document sur cet appareil pour le moment. Rien n’a été modifié — tu peux le faire depuis l’écran Documents.',
          },
        });
      }
      const [docsResult, destinationsResult] = await Promise.all([
        this.deps.actions.listDocuments(),
        listDestinations(),
      ]);
      if (!docsResult.ok) return err(docsResult.error);
      if (!destinationsResult.ok) return err(destinationsResult.error);
      if (docsResult.value.length === 0) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lister le coffre'],
          card: { title: 'Rien à classer', body: 'Aucun document dans le coffre pour le moment.' },
        });
      }
      // « range X dans Y » : le marqueur sépare la pièce (avant) de la destination (après).
      const splitMatch = /\b(dans|vers|au|aux|chez)\b/i.exec(message);
      const docPartRaw = splitMatch ? message.slice(0, splitMatch.index) : message;
      const destPartRaw = splitMatch ? message.slice(splitMatch.index + splitMatch[0].length) : '';
      // Résolution du document par jetons (comme valider_document) — l'historique court lève
      // l'anaphore (« range-le dans Achats » après avoir parlé du ticket).
      const conversation = [
        ...(history ?? []).slice(-4).filter((turn) => turn.role === 'user').map((turn) => turn.text),
        docPartRaw,
      ].join(' ');
      const CLASSER_GESTURE_WORDS = ['range', 'ranger', 'ranges', 'classe', 'classer', 'classes', 'deplace', 'deplacer', 'deplaces', 'mets', 'met', 'vers', 'chantier', 'chantiers', 'dossier', 'dossiers'];
      const matches = matchDocumentsByTokens(conversation, docsResult.value, CLASSER_GESTURE_WORDS);
      const target = matches.length === 1 ? matches[0]! : null;
      // Résolution de la destination : nom insensible casse/accents contre les listes RÉELLES.
      const destinations = [
        ...destinationsResult.value.chantiers.map((c) => ({ kind: 'chantier' as const, id: c.id, nom: c.nom })),
        ...destinationsResult.value.dossiers.map((f) => ({ kind: 'folder' as const, id: f.id, nom: f.nom })),
      ];
      const scope = normalized(destPartRaw.trim().length > 0 ? destPartRaw : message);
      const wantsChantier = /\bchantiers?\b/.test(scope);
      const wantsFolder = /\bdossiers?\b/.test(scope);
      const eligible =
        wantsChantier && !wantsFolder
          ? destinations.filter((d) => d.kind === 'chantier')
          : wantsFolder && !wantsChantier
            ? destinations.filter((d) => d.kind === 'folder')
            : destinations;
      const scopeTokens = new Set(scope.split(/[^a-z0-9]+/).filter((word) => word.length >= 3));
      // Un nom ENTIER présent prime (« frais généraux » complet) ; sinon un mot significatif
      // suffit à candidater — l'ambiguïté redevient une question, jamais un rangement deviné.
      const strongMatches = eligible.filter((d) => {
        const tokens = destinationNameTokens(d.nom);
        return tokens.length > 0 && tokens.every((word) => scopeTokens.has(word));
      });
      const looseMatches = eligible.filter((d) => destinationNameTokens(d.nom).some((word) => scopeTokens.has(word)));
      const destination =
        strongMatches.length === 1 ? strongMatches[0]! : strongMatches.length === 0 && looseMatches.length === 1 ? looseMatches[0]! : null;
      const destinationChoices = strongMatches.length > 1 ? strongMatches : looseMatches;
      const destinationLabel = (d: { kind: 'chantier' | 'folder'; nom: string }): string =>
        d.kind === 'chantier' ? `le chantier ${d.nom}` : `le dossier ${d.nom}`;

      if (!target) {
        const options = (matches.length > 1 ? matches : docsResult.value).slice(0, 8);
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lister le coffre', 'Lever l’ambiguïté du document'],
          card: { title: 'Quel document ?', body: 'Dis-moi quel document classer :' },
          choices: options.map((d) => ({
            label: agentDocumentLabel(d),
            value: `Classe le document ${d.id}${destination ? ` dans ${destinationLabel(destination)}` : ''}`,
          })),
          ask: [
            askToPick({
              id: 'classer_document.cible',
              question: 'Quel document veux-tu classer ?',
              header: 'Document',
              items: options.map((d) => ({
                value: d.id,
                label: agentDocumentLabel(d),
                description: `scanné le ${d.createdAt.slice(8, 10)}/${d.createdAt.slice(5, 7)}/${d.createdAt.slice(0, 4)}`,
                followUp: `Classe le document ${d.id}${destination ? ` dans ${destinationLabel(destination)}` : ''}`,
              })),
            }),
          ],
        });
      }

      if (!destination) {
        // Destination NOMMÉE mais introuvable dans les listes réelles : refus honnête —
        // Bob n'invente jamais un chantier ni un dossier.
        if (destPartRaw.trim().length > 0 && destinationChoices.length === 0) {
          const said = destPartRaw.replace(/\s+/g, ' ').trim();
          return ok({
            kind: 'answer',
            intent,
            model,
            plan: ['Vérifier la destination contre les listes réelles'],
            card: {
              title: 'Destination introuvable',
              body: `Je ne trouve ni chantier ouvert ni dossier correspondant à « ${said} ». Rien n’a été modifié — donne-moi un chantier ouvert ou un dossier existant.`,
            },
          });
        }
        const options = (destinationChoices.length > 0 ? destinationChoices : destinations).slice(0, 4);
        if (options.length === 0) {
          return ok({
            kind: 'answer',
            intent,
            model,
            plan: ['Lister les destinations réelles'],
            card: {
              title: 'Aucune destination',
              body: 'Je ne vois ni chantier ouvert ni dossier où ranger cette pièce. Crée d’abord un dossier depuis l’écran Documents — rien n’a été modifié.',
            },
          });
        }
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Identifier le document', 'Lever l’ambiguïté de la destination'],
          card: {
            title: 'Où le classer ?',
            body: `Où veux-tu classer « ${agentDocumentLabel(target)} » ?`,
          },
          choices: options.map((d) => ({
            label: d.kind === 'chantier' ? `Chantier ${d.nom}` : `Dossier ${d.nom}`,
            value: `Classe le document ${target.id} dans ${destinationLabel(d)}`,
          })),
          ask: [
            askToPick({
              id: 'classer_document.destination',
              question: `Où veux-tu classer « ${agentDocumentLabel(target)} » ?`,
              header: 'Destination',
              items: options.map((d) => ({
                value: d.id,
                label: d.kind === 'chantier' ? `Chantier ${d.nom}` : `Dossier ${d.nom}`,
                followUp: `Classe le document ${target.id} dans ${destinationLabel(d)}`,
              })),
            }),
          ],
        });
      }

      const args: Record<string, unknown> = {
        documentId: target.id,
        destination:
          destination.kind === 'chantier'
            ? { kind: 'chantier', chantierId: destination.id }
            : { kind: 'folder', folderId: destination.id },
      };
      const label = `Classer « ${agentDocumentLabel(target)} » dans ${destinationLabel(destination)}`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Trouver le document', 'Résoudre la destination réelle', 'Attendre ta confirmation'],
          card: {
            title: 'Classement à confirmer',
            body: `${label}. Même geste que « Classer là » : je range, je lie au chantier si besoin, et j’applique le nom intelligent — jamais par-dessus un renommage humain. Je continue ?`,
          },
          pending: { tool: tool.name, args, label },
          spokenPrompt: buildSpokenConfirmation(label),
        });
      }
      const run = await tool.run(args);
      if (!run.ok) {
        // Garde anti-écrasement du domaine (DOCUMENT_ALREADY_LINKED) : réponse honnête —
        // le lien existant est nommé (chantier réel si connu), rien n'est écrasé ni modifié.
        const existing = documentAlreadyLinkedTarget(run.error);
        if (existing) {
          const existingChantier =
            existing.linkedEntityType === 'chantier'
              ? destinationsResult.value.chantiers.find((c) => c.id === existing.linkedEntityId)?.nom ?? null
              : null;
          return ok({
            kind: 'answer',
            intent,
            model,
            plan: ['Classer le document', 'Détecter un lien métier existant'],
            card: alreadyLinkedCard(existing, existingChantier),
          });
        }
        return err(run.error);
      }
      return ok({
        kind: 'done',
        intent,
        model,
        plan: ['Classer le document'],
        card: { title: 'Document classé ✓', body: `${label} — c’est fait.` },
      });
    }

    if (intent === 'renommer_document') {
      // LOT 5 — « Renomme-le facture matériaux salle de bain » : MÊME use case RenameDocument
      // que l'écran détail. Le nom dicté devient un renommage HUMAIN prioritaire — d'où la
      // confirmation systématique (plancher) avant toute écriture.
      const rename = this.deps.actions.renameDocument?.bind(this.deps.actions);
      const tool = this.tool('renommer_document');
      if (!rename || !tool) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Renommer un document',
            body: 'Je ne peux pas renommer de document sur cet appareil pour le moment. Rien n’a été modifié — tu peux le faire depuis l’écran Documents.',
          },
        });
      }
      const docsResult = await this.deps.actions.listDocuments();
      if (!docsResult.ok) return err(docsResult.error);
      if (docsResult.value.length === 0) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lister le coffre'],
          card: { title: 'Rien à renommer', body: 'Aucun document dans le coffre pour le moment.' },
        });
      }
      const RENAME_GESTURE_WORDS = ['renomme', 'renommer', 'renommes', 'rebaptise', 'rebaptiser', 'rebaptises', 'en', 'comme', 'nouveau', 'nom'];
      const historyText = (history ?? []).slice(-4).filter((turn) => turn.role === 'user').map((turn) => turn.text).join(' ');
      // Nouveau nom extrait du message BRUT (accents et casse conservés — c'est un libellé).
      const tail = /\b(?:renomme[sz]?|renommer|rebaptise[sz]?|rebaptiser)\b(.*)$/i.exec(message)?.[1] ?? '';
      const separator = /\b(?:en|comme)\b/i.exec(tail);
      let target: AgentDocument | null = null;
      let ambiguous: AgentDocument[] = [];
      let newName = '';
      if (separator) {
        // « renomme le ticket Aldi en facture Aldi » : pièce avant, nom après.
        const docPart = tail.slice(0, separator.index);
        newName = tail.slice(separator.index + separator[0].length);
        const matches = matchDocumentsByTokens(`${historyText} ${docPart}`, docsResult.value, RENAME_GESTURE_WORDS);
        target = matches.length === 1 ? matches[0]! : null;
        ambiguous = matches;
      } else {
        // Sans « en » : soit la fin désigne la pièce (nom manquant), soit c'est le nouveau nom
        // d'une pièce anaphorique (« renomme-le facture matériaux salle de bain »).
        const tailMatches = matchDocumentsByTokens(tail, docsResult.value, RENAME_GESTURE_WORDS);
        if (tailMatches.length === 1) {
          target = tailMatches[0]!; // la fin désigne la pièce — le nouveau nom manque encore
        } else if (tailMatches.length > 1) {
          ambiguous = tailMatches;
        } else {
          const pronoun = /^[\s,:–—-]*(?:-?\s*(?:le|la|l['’]))\s*/i.exec(tail);
          newName = pronoun ? tail.slice(pronoun[0].length) : tail;
          const anaphoric = matchDocumentsByTokens(historyText, docsResult.value, RENAME_GESTURE_WORDS);
          target = anaphoric.length === 1 ? anaphoric[0]! : null;
          ambiguous = anaphoric;
        }
      }
      newName = newName.replace(/["«»]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!target) {
        const options = (ambiguous.length > 1 ? ambiguous : docsResult.value).slice(0, 8);
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lister le coffre', 'Lever l’ambiguïté du document'],
          card: { title: 'Quel document ?', body: 'Dis-moi quel document renommer :' },
          choices: options.map((d) => ({
            label: agentDocumentLabel(d),
            value: `Renomme le document ${d.id}${newName ? ` en ${newName}` : ''}`,
          })),
          ask: [
            askToPick({
              id: 'renommer_document.cible',
              question: 'Quel document veux-tu renommer ?',
              header: 'Document',
              items: options.map((d) => ({
                value: d.id,
                label: agentDocumentLabel(d),
                description: `scanné le ${d.createdAt.slice(8, 10)}/${d.createdAt.slice(5, 7)}/${d.createdAt.slice(0, 4)}`,
                followUp: `Renomme le document ${d.id}${newName ? ` en ${newName}` : ''}`,
              })),
            }),
          ],
        });
      }
      if (!newName) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Identifier le document', 'Demander le nouveau nom'],
          card: {
            title: `Renommer « ${agentDocumentLabel(target)} »`,
            body: `Quel nouveau nom ? Dis « renomme le document ${target.id} en … ». Rien n’a été modifié.`,
          },
        });
      }
      const args = { documentId: target.id, displayName: newName };
      const parsed = tool.parse(args);
      if (!parsed.ok) return err(parsed.error);
      const label = `Renommer « ${agentDocumentLabel(target)} » en « ${newName} »`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Trouver le document', 'Préparer le renommage', 'Attendre ta confirmation'],
          card: {
            title: 'Renommage à confirmer',
            body: `${label}. Ton nom devient prioritaire : les suggestions automatiques ne l’écraseront plus. Je continue ?`,
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
        plan: ['Renommer le document'],
        card: { title: 'Document renommé ✓', body: `${label} — c’est fait.` },
      });
    }

    if (intent === 'chercher_document') {
      // LOT 5 — « Retrouve la facture du radiateur de mars » : MÊME recherche que
      // GET /documents/search (devis & factures réels, ranking serveur). Lecture pure, puis
      // navigation vers la pièce la plus pertinente (pattern contexte_ecran/ouvrir_*).
      const search = this.deps.actions.searchDocuments?.bind(this.deps.actions);
      if (!search) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Retrouver un document',
            body: 'Je n’ai pas accès à la recherche de documents sur cet appareil pour le moment.',
          },
        });
      }
      const normalizedMessage = normalized(message);
      // Portée dite : « facture » / « devis » — les deux (ou aucun) = tout.
      const saysInvoice = /\bfactures?\b/.test(normalizedMessage);
      const saysQuote = /\bdevis\b/.test(normalizedMessage);
      const scope: 'quote' | 'invoice' | 'all' = saysInvoice && !saysQuote ? 'invoice' : saysQuote && !saysInvoice ? 'quote' : 'all';
      // « de mars » → plage de dates RÉELLE, dérivée de l'horloge du runtime — jamais devinée sans elle.
      const MONTHS: Readonly<Record<string, number>> = {
        janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
        juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
      };
      const monthWord = /\b(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre)\b/.exec(normalizedMessage)?.[1];
      const saidYear = /\b(20\d{2})\b(?!-)/.exec(normalizedMessage)?.[1];
      const now = this.deps.runtime?.clock.now();
      const today = now && /^\d{4}-\d{2}-\d{2}T/.test(now) ? parisDateOnly(now) : null;
      let from: string | undefined;
      let to: string | undefined;
      if (monthWord !== undefined && (today !== null || saidYear !== undefined)) {
        const month = MONTHS[monthWord]!;
        // Sans année dite : le mois écoulé le plus récent (jamais un mois futur).
        const year = saidYear !== undefined
          ? Number(saidYear)
          : month <= Number(today!.slice(5, 7)) ? Number(today!.slice(0, 4)) : Number(today!.slice(0, 4)) - 1;
        const mm = String(month).padStart(2, '0');
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        from = `${year}-${mm}-01`;
        to = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;
      }
      // Requête = mots significatifs, geste et bruit neutralisés (la référence LLM prime).
      const SEARCH_STOPWORDS = new Set([
        'retrouve', 'retrouver', 'retrouves', 'recherche', 'rechercher', 'cherche', 'chercher',
        'trouve', 'trouver', 'moi', 'stp', 'plait', 'peux', 'veux', 'peut',
        'le', 'la', 'les', 'l', 'un', 'une', 'du', 'de', 'des', 'd', 'mon', 'ma', 'mes',
        'ce', 'cet', 'cette', 'dans', 'sur', 'pour', 'et', 'en', 'que', 'qui',
        'facture', 'factures', 'devis', 'document', 'documents', 'piece', 'pieces',
        'mois', 'dernier', 'derniere',
      ]);
      const queryBase = reference !== null && reference.trim().length > 0 ? reference : message;
      const query = normalized(queryBase)
        .split(/[^a-z0-9-]+/)
        .filter(
          (word) =>
            word.length >= 2 &&
            !SEARCH_STOPWORDS.has(word) &&
            MONTHS[word] === undefined &&
            !(monthWord !== undefined && /^20\d{2}$/.test(word)),
        )
        .join(' ')
        .trim();
      if (query.length === 0 && from === undefined) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Préciser la recherche'],
          card: {
            title: 'Que faut-il retrouver ?',
            body: 'Donne-moi un mot du libellé, un client, un numéro ou une période (« la facture du radiateur de mars »).',
          },
        });
      }
      const r = await search({
        query,
        scope,
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
      });
      if (!r.ok) return err(r.error);
      if (r.value.hits.length === 0) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Chercher dans les devis & factures réels'],
          card: {
            title: 'Rien trouvé',
            body: `Je n’ai rien retrouvé pour « ${query || `cette période`} ». Précise le client, un mot du libellé ou le numéro — je ne devine pas.`,
          },
        });
      }
      const hitLabel = (h: (typeof r.value.hits)[number]): string =>
        `${h.source === 'invoice' ? 'Facture' : 'Devis'} ${h.number ?? '(brouillon)'} — ${h.customerName}`;
      const lines = r.value.hits.slice(0, 5).map((h) => {
        const dateFr = h.date !== null ? ` · ${h.date.slice(8, 10)}/${h.date.slice(5, 7)}/${h.date.slice(0, 4)}` : '';
        const line = h.matchedLineLabel !== null ? ` (ligne : ${h.matchedLineLabel})` : '';
        return `• ${hitLabel(h)} · ${formatEUR(h.totalTtcCents)}${dateFr}${line}`;
      });
      const rest = r.value.totalCount - Math.min(r.value.hits.length, 5);
      const top = r.value.hits[0]!;
      const route = top.source === 'invoice'
        ? `/facture/${encodeURIComponent(top.id)}`
        : `/devis/${encodeURIComponent(top.id)}`;
      return ok({
        kind: 'done',
        intent,
        model,
        plan: ['Chercher dans les devis & factures réels', 'Ouvrir la pièce la plus pertinente'],
        card: {
          title: `${r.value.totalCount} résultat${r.value.totalCount > 1 ? 's' : ''}`,
          body: `${lines.join('\n')}${rest > 0 ? `\n… et ${rest} autre${rest > 1 ? 's' : ''}.` : ''}\nJe t’ouvre ${hitLabel(top)}.`,
        },
        navigate: route,
      });
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

    if (intent === 'abonnement') {
      // Pilier 2 : lecture SEULE de l'abonnement/essai — GetSubscriptionStatus, la même vérité
      // que l'écran Compte. Jamais d'achat vocal : Bob informe, l'engagement se confirme au tap.
      const getStatus = this.deps.actions.getSubscriptionStatus?.bind(this.deps.actions);
      if (!getStatus) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Ton abonnement',
            body: 'Je n’ai pas accès à l’état de ton abonnement sur cet appareil pour le moment.',
          },
        });
      }
      const r = await getStatus();
      if (!r.ok) return err(r.error);
      return ok({
        kind: 'answer',
        intent,
        model,
        plan: ['Lire l’état d’abonnement du compte'],
        card: { title: 'Ton abonnement', body: subscriptionStatusBody(r.value) },
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

      // pilotage : le mois en cours à isopérimètre + tendance mois clos + ratio headline,
      // PUIS la carte Encaissement (PR-07) — le « trou n° 1 » (taux 90 j, encours échu, pièces
      // émises jamais envoyées) devient AUSSI audible, depuis la MÊME review que l'écran.
      const cur = review.currentMonth;
      const iso = pct(cur.invoicedDeltaBps);
      const trend = review.lastClosedComparison;
      const trendLine = trend
        ? `${trend.month} vs ${trend.previousMonth} : ${trend.deltaCents >= 0 ? '+' : '−'}${formatEUR(Math.abs(trend.deltaCents))}${pct(trend.deltaBps) ? ` (${pct(trend.deltaBps)})` : ''}`
        : null;
      const ebe = pct(review.ratios.ebeBps);
      const collection = review.collection;
      const collectionRateLine =
        collection.collectedRateBps90d !== null
          ? `Encaissement 90 j : ${(collection.collectedRateBps90d / 100).toFixed(0)} % du facturé encaissé (${formatEUR(collection.collectedTtc90dCents)} sur ${formatEUR(collection.invoicedTtc90dCents)}).`
          : null; // fenêtre trop courte : aucun taux fabriqué — même honnêteté que le DSO
      const overdueLine =
        collection.overdueCents > 0
          ? `Encours échu : ${formatEUR(collection.overdueCents)} en retard chez tes clients.`
          : null;
      const firstUntransmitted = collection.untransmitted[0] ?? null;
      const untransmittedLine =
        collection.untransmitted.length > 0
          ? `⚠ ${collection.untransmitted.length} facture${collection.untransmitted.length > 1 ? 's' : ''} émise${collection.untransmitted.length > 1 ? 's' : ''} sans envoi constaté — ${formatEUR(collection.untransmitted.reduce((sum, line) => sum + line.amountCents, 0))} qui dorment${firstUntransmitted?.docNumber ? ` (${firstUntransmitted.docNumber} en tête)` : ''}.`
          : null;
      const body = [
        `Facturé (hors TVA) au ${cur.atDay} du mois : ${formatEUR(cur.invoicedHtCents)}${iso ? ` (${iso} vs le mois dernier à date égale)` : ''}`,
        `Encaissé (TVA comprise) : ${formatEUR(cur.collectedTtcCents)}`,
        ...(trendLine ? [trendLine] : []),
        ...(ebe ? [`Ton activité dégage ${ebe} du CA (taux d’EBE) — avant ta rémunération.`] : []),
        ...(collectionRateLine ? [collectionRateLine] : []),
        ...(overdueLine ? [overdueLine] : []),
        ...(untransmittedLine ? [untransmittedLine] : []),
      ].join('\n');
      // Le geste qui répare le trou (l'envoi réel) à portée de voix — seulement si l'hôte
      // expose l'outil et que la pièce a un numéro (jamais une commande invérifiable).
      const sendChip =
        firstUntransmitted?.docNumber && this.tool('envoyer_facture')
          ? [{ label: `Envoyer la facture ${firstUntransmitted.docNumber}`, value: `Envoie la facture ${firstUntransmitted.docNumber}` }]
          : [];
      return ok({
        kind: 'answer',
        intent,
        model,
        plan: ['Dériver la revue de pilotage', 'Facturé (écritures de vente) vs encaissé (paiements)', 'Comparer à isopérimètre de jours', 'Lire la carte Encaissement (taux 90 j, échu, sans envoi)'],
        card: { title: 'Ton activité', body },
        ...(sendChip.length > 0 ? { choices: sendChip } : {}),
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
      // Enregistrer un règlement DEJA réalisé : Bob doit obtenir la cible, la date et le moyen
      // avant toute proposition. Il n'initie aucun transfert et n'invente jamais « aujourd'hui ».
      const listUnpaid = this.deps.actions.listUnpaidExpenses?.bind(this.deps.actions);
      const tool = this.tool('enregistrer_reglement_depense');
      if (!listUnpaid || !tool) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Enregistrer un règlement',
            body: 'Je ne peux pas enregistrer cette preuve de règlement pour le moment. Aucun paiement n’a été effectué.',
          },
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
          card: { title: 'Règlements fournisseurs', body: 'Aucune dépense à payer — ton poste fournisseurs est à jour.' },
        });
      }
      const conversation = [
        ...(history ?? []).slice(-4).filter((turn) => turn.role === 'user').map((turn) => turn.text),
        message,
      ].join(' ');
      const normalizedConversation = normalized(conversation);
      const target = r.value.find((expense) => {
        const id = normalized(expense.id);
        return (id.length >= 3 && containsExactTokens(normalizedConversation, id))
          || normalizedConversation.includes(normalized(expense.supplierName));
      });
      if (!target) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lister les dépenses à payer'],
          card: { title: 'Quelle dépense ?', body: 'Dis-moi quel fournisseur régler :' },
          choices: r.value.map((e) => ({
            label: `${e.supplierName} — ${formatEUR(e.totalTtcCents)}`,
            value: `j’ai déjà payé la dépense ${e.supplierName}`,
          })),
          ask: [
            askToPick({
              id: 'payer_depense.cible',
              question: 'Quelle dépense veux-tu régler ?',
              header: 'Fournisseur',
              items: r.value.map((e) => ({
                value: e.id,
                label: e.supplierName,
                description: `${formatEUR(e.totalTtcCents)} · du ${e.documentDate} — règlement déjà effectué`,
                followUp: `J’ai déjà payé la dépense ${e.id}`,
              })),
            }),
          ],
        });
      }

      const now = this.deps.runtime?.clock.now();
      const today = now && /^\d{4}-\d{2}-\d{2}T/.test(now) ? parisDateOnly(now) : null;
      const details = parseExpensePaymentDetails(conversation, today);
      if (!details.paidOn) {
        const options = today
          ? [
              {
                value: today,
                label: 'Aujourd’hui',
                description: today,
                followUp: `J’ai payé la dépense ${target.id} aujourd’hui`,
              },
              {
                value: 'yesterday',
                label: 'Hier',
                description: 'La veille de la date du jour',
                followUp: `J’ai payé la dépense ${target.id} hier`,
              },
            ]
          : [];
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Identifier la dépense', 'Demander la date réelle du règlement'],
          card: {
            title: 'Quelle date de règlement ?',
            body: `À quelle date as-tu réellement payé ${target.supplierName} ? Dis-la au format JJ/MM/AAAA. Je ne la devine pas.`,
          },
          ...(options.length >= 2
            ? {
                choices: options.map((option) => ({ label: option.label, value: option.followUp })),
                ask: [askToPick({
                  id: 'payer_depense.date',
                  question: `Quand as-tu payé ${target.supplierName} ?`,
                  header: 'Date',
                  items: options,
                })],
              }
            : {}),
        });
      }
      if (today && details.paidOn > today) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Contrôler la date déclarée'],
          card: {
            title: 'Date future impossible',
            body: `Le ${details.paidOn} est dans le futur. Donne-moi la date d’un règlement déjà effectué ; rien n’a été enregistré.`,
          },
        });
      }
      if (!details.method) {
        const dateFr = `${details.paidOn.slice(8, 10)}/${details.paidOn.slice(5, 7)}/${details.paidOn.slice(0, 4)}`;
        const methods = [
          { value: 'transfer', label: 'Virement', followUp: `J’ai payé la dépense ${target.id} le ${details.paidOn} par virement` },
          { value: 'card', label: 'Carte', followUp: `J’ai payé la dépense ${target.id} le ${details.paidOn} par carte` },
          { value: 'cash', label: 'Espèces', followUp: `J’ai payé la dépense ${target.id} le ${details.paidOn} en espèces` },
        ];
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Identifier la dépense', 'Conserver la date réelle', 'Demander le moyen de règlement'],
          card: {
            title: 'Quel moyen de règlement ?',
            body: `${target.supplierName} · ${formatEUR(target.totalTtcCents)} · payé le ${dateFr}. Choisis le moyen réellement utilisé.`,
          },
          choices: methods.map((option) => ({ label: option.label, value: option.followUp })),
          ask: [askToPick({
            id: 'payer_depense.methode',
            question: 'Comment as-tu réglé cette dépense ?',
            header: 'Moyen',
            items: methods,
          })],
        });
      }
      const args = {
        expenseId: target.id,
        paidOn: details.paidOn,
        method: details.method,
        ...(details.reference ? { reference: details.reference } : {}),
      };
      const dateFr = `${details.paidOn.slice(8, 10)}/${details.paidOn.slice(5, 7)}/${details.paidOn.slice(0, 4)}`;
      const label = `Enregistrer le règlement déjà effectué de ${target.supplierName} (${formatEUR(target.totalTtcCents)}), le ${dateFr} par ${expensePaymentMethodLabel(details.method)}`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Trouver la dépense', 'Contrôler la preuve', 'Préparer l’écriture 401/512 ou 401/530', 'Attendre ta confirmation'],
          card: {
            title: 'Enregistrement à confirmer',
            body: `${label}${details.reference ? ` · réf. ${details.reference}` : ''}.\nBob n’initie aucun virement : il enregistre ce que tu déclares avoir déjà payé. Je continue ?`,
          },
          pending: { tool: tool.name, args, label },
          spokenPrompt: buildSpokenConfirmation(label),
        });
      }
      const run = await tool.run(args);
      if (!run.ok) {
        if (isLegacyExpensePaymentConflict(run.error)) {
          return ok({
            kind: 'answer',
            intent,
            model,
            plan: ['Détecter une ligne historique sans preuve', 'Orienter vers la régularisation'],
            card: legacyExpenseGuidanceCard(),
          });
        }
        return err(run.error);
      }
      return ok({
        kind: 'done',
        intent,
        model,
        plan: ['Enregistrer la preuve du règlement'],
        card: { title: 'Règlement enregistré ✓', body: `${label} — la preuve et l’écriture sont enregistrées.` },
      });
    }

    if (intent === 'depense_dictee') {
      // M4 — dépense DICTÉE (« j'ai dépensé 89 € chez Leroy Merlin en carte ») : MÊME use case
      // RecordExpense (@bob/core, source manuelle) que le scan — via l'outil scan_depense du
      // registre (plancher comptable). Fournisseur/montant/moyen/catégorie extraits du message ;
      // tout champ manquant redevient une QUESTION structurée — jamais un défaut inventé.
      const record = this.deps.actions.recordExpense?.bind(this.deps.actions);
      const tool = this.tool('scan_depense');
      if (!record || !tool) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Enregistrer une dépense',
            body: 'Je ne peux pas enregistrer de dépense dictée sur cet appareil pour le moment. Rien n’a été créé — tu peux passer par l’écran Dépenses ou scanner le ticket.',
          },
        });
      }
      const conversation = [
        ...(history ?? []).slice(-4).filter((turn) => turn.role === 'user').map((turn) => turn.text),
        message,
      ].join(' ');
      const normalizedConversation = normalized(conversation);
      const now = this.deps.runtime?.clock.now();
      const today = now && /^\d{4}-\d{2}-\d{2}T/.test(now) ? parisDateOnly(now) : null;
      const amountCents = extractSpokenAmountCents(conversation);
      const supplier = extractSpokenSupplier(conversation);
      const category = extractSpokenExpenseCategory(normalizedConversation);
      const details = parseExpensePaymentDetails(conversation, today);
      // « ce matin », « à l'instant » = aujourd'hui ; sans date dite : aujourd'hui (jour métier).
      const date = details.paidOn ?? today;

      // Chantier OPTIONNEL (« …pour le chantier Durand ») : résolu contre les chantiers OUVERTS
      // réels du tenant (listFilingDestinations) — introuvable = refus honnête, rien n'est créé.
      const chantierSaid = /\bchantiers?\b/.test(normalizedConversation);
      let chantier: { id: string; nom: string } | null = null;
      if (chantierSaid) {
        const listDestinations = this.deps.actions.listFilingDestinations?.bind(this.deps.actions);
        if (!listDestinations) {
          return ok({
            kind: 'answer',
            intent,
            model,
            plan: ['Vérifier la capacité de l’hôte'],
            card: {
              title: 'Chantier invérifiable',
              body: 'Je ne peux pas vérifier ce chantier sur cet appareil. Rien n’a été créé — redis-moi la dépense sans chantier, ou passe par l’écran Dépenses.',
            },
          });
        }
        const destinations = await listDestinations();
        if (!destinations.ok) return err(destinations.error);
        const chantiers = destinations.value.chantiers;
        // Dernière mention « chantier … » de la conversation (les followUps l'ajoutent en fin).
        let tail = '';
        const scanChantier = /\bchantiers?\b([^,;.!?]{0,60})/g;
        let chantierMention: RegExpExecArray | null;
        while ((chantierMention = scanChantier.exec(normalizedConversation)) !== null) tail = chantierMention[1] ?? '';
        const scopeTokens = new Set(tail.split(/[^a-z0-9]+/).filter((word) => word.length >= 3));
        const strong = chantiers.filter((c) => {
          const tokens = destinationNameTokens(c.nom);
          return tokens.length > 0 && tokens.every((word) => scopeTokens.has(word));
        });
        const loose = chantiers.filter((c) => destinationNameTokens(c.nom).some((word) => scopeTokens.has(word)));
        chantier = strong.length === 1 ? strong[0]! : strong.length === 0 && loose.length === 1 ? loose[0]! : null;
        if (chantier === null) {
          const options = (strong.length > 1 ? strong : loose).slice(0, 4);
          if (options.length === 0) {
            const saidName = tail.replace(/\s+/g, ' ').trim();
            return ok({
              kind: 'answer',
              intent,
              model,
              plan: ['Vérifier le chantier contre la liste réelle'],
              card: {
                title: 'Chantier introuvable',
                body: `Je ne trouve aucun chantier ouvert correspondant à « ${saidName.length > 0 ? saidName : 'ce chantier'} ». Rien n’a été créé — donne-moi un chantier ouvert, ou redis la dépense sans chantier.`,
              },
            });
          }
          if (supplier !== null && amountCents !== null) {
            const followUpFor = (c: { id: string; nom: string }): string =>
              dictatedExpenseCommand({
                amountCents,
                supplier,
                method: details.method,
                category,
                dateFr: details.paidOn !== null ? frDate(details.paidOn) : null,
                chantierName: c.nom,
              });
            return ok({
              kind: 'answer',
              intent,
              model,
              plan: ['Extraire la dépense dictée', 'Lever l’ambiguïté du chantier'],
              card: {
                title: 'Quel chantier ?',
                body: `Sur quel chantier mettre la dépense ${supplier} (${spokenAmountLabel(amountCents)}) ?`,
              },
              choices: options.map((c) => ({ label: `Chantier ${c.nom}`, value: followUpFor(c) })),
              ask: [
                askToPick({
                  id: 'depense_dictee.chantier',
                  question: 'Sur quel chantier mettre cette dépense ?',
                  header: 'Chantier',
                  items: options.map((c) => ({ value: c.id, label: c.nom, followUp: followUpFor(c) })),
                }),
              ],
            });
          }
          // Fournisseur/montant manquants : on les demande d'abord — le chantier, re-résolu au
          // tour suivant (continuité), sera tranché ensuite.
        }
      }

      if (supplier === null) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Extraire la dépense dictée', 'Demander le fournisseur'],
          card: {
            title: 'Chez quel fournisseur ?',
            body: `Il me manque le fournisseur de cette dépense${amountCents !== null ? ` de ${spokenAmountLabel(amountCents)}` : ''}. Dis-le-moi (« chez Leroy Merlin ») — rien n’a été créé.`,
          },
        });
      }
      if (amountCents === null) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Extraire la dépense dictée', 'Demander le montant TTC'],
          card: {
            title: 'Quel montant ?',
            body: `Il me manque le montant TTC de cette dépense chez ${supplier}. Dis-le-moi (« 89 € ») — rien n’a été créé.`,
          },
        });
      }
      if (date === null) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Extraire la dépense dictée', 'Demander la date réelle'],
          card: {
            title: 'Quelle date ?',
            body: `À quelle date cette dépense chez ${supplier} ? Dis-la au format JJ/MM/AAAA — je ne la devine pas. Rien n’a été créé.`,
          },
        });
      }
      if (today !== null && date > today) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Contrôler la date déclarée'],
          card: {
            title: 'Date future impossible',
            body: `Le ${frDate(date)} est dans le futur. Donne-moi la date d’une dépense déjà réglée ; rien n’a été créé.`,
          },
        });
      }
      if (details.method === null) {
        const methods: { method: PaymentMethod; label: string }[] = [
          { method: 'card', label: 'Carte' },
          { method: 'transfer', label: 'Virement' },
          { method: 'cash', label: 'Espèces' },
        ];
        const followUpFor = (m: PaymentMethod): string =>
          dictatedExpenseCommand({
            amountCents,
            supplier,
            method: m,
            category,
            dateFr: details.paidOn !== null ? frDate(details.paidOn) : null,
            chantierName: chantier?.nom ?? null,
          });
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Extraire la dépense dictée', 'Demander le moyen de paiement'],
          card: {
            title: 'Quel moyen de paiement ?',
            body: `${supplier} · ${spokenAmountLabel(amountCents)} — avec quel moyen as-tu réglé cette dépense ?`,
          },
          choices: methods.map((m) => ({ label: m.label, value: followUpFor(m.method) })),
          ask: [
            askToPick({
              id: 'depense_dictee.moyen',
              question: 'Comment as-tu réglé cette dépense ?',
              header: 'Moyen',
              items: methods.map((m) => ({ value: m.method, label: m.label, followUp: followUpFor(m.method) })),
            }),
          ],
        });
      }
      if (category === null) {
        const categories: ExpenseCategory[] = ['materiel', 'fournitures', 'repas', 'autre'];
        const followUpFor = (c: ExpenseCategory): string =>
          dictatedExpenseCommand({
            amountCents,
            supplier,
            method: details.method,
            category: c,
            dateFr: details.paidOn !== null ? frDate(details.paidOn) : null,
            chantierName: chantier?.nom ?? null,
          });
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Extraire la dépense dictée', 'Demander la catégorie'],
          card: {
            title: 'Quelle catégorie ?',
            body: `${supplier} · ${spokenAmountLabel(amountCents)} — dans quelle catégorie ranger cette dépense ?`,
          },
          choices: categories.map((c) => ({ label: EXPENSE_CATEGORY_SPOKEN[c], value: followUpFor(c) })),
          ask: [
            askToPick({
              id: 'depense_dictee.categorie',
              question: 'Dans quelle catégorie ranger cette dépense ?',
              header: 'Catégorie',
              items: categories.map((c) => ({ value: c, label: EXPENSE_CATEGORY_SPOKEN[c], followUp: followUpFor(c) })),
            }),
          ],
        });
      }
      const args = {
        supplierName: supplier,
        totalTtcCents: amountCents,
        category,
        documentDate: date,
        ...(chantier !== null ? { chantierId: chantier.id } : {}),
        payment: {
          paidOn: date,
          method: details.method,
          ...(details.reference !== null ? { reference: details.reference } : {}),
        },
      };
      const parsed = tool.parse(args);
      if (!parsed.ok) return err(parsed.error);
      const label = `Enregistrer la dépense ${supplier} · ${formatEUR(amountCents)} (${EXPENSE_CATEGORY_SPOKEN[category]}), réglée le ${frDate(date)} ${spokenMethodPhrase(details.method)}${chantier !== null ? ` · chantier ${chantier.nom}` : ''}`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Extraire la dépense dictée', 'Contrôler fournisseur, montant, moyen et catégorie', 'Attendre ta confirmation'],
          card: {
            title: 'Dépense à confirmer',
            body: `${label}.\nElle naît payée avec sa preuve — Bob n’initie aucun paiement, il enregistre ce que tu déclares. Je l’écris dans tes livres ?`,
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
        plan: ['Enregistrer la dépense'],
        card: { title: 'Dépense enregistrée ✓', body: `${label} — c’est dans tes livres.` },
      });
    }

    if (intent === 'lier_depense_chantier') {
      // M3 — « mets la dépense Aldi sur le chantier Durand » : MÊME use case
      // AssignExpenseToChantier (@bob/core) que PUT /expenses/:id/chantier et l'écran Dépenses
      // (parité humain↔Bob). Résolution contre les listes RÉELLES (dépenses récentes +
      // chantiers ouverts) — toute ambiguïté redevient une question, l'introuvable un refus
      // honnête ; l'imputation n'est JAMAIS posée sans confirmation (plancher M3).
      const assign = this.deps.actions.assignExpenseChantier?.bind(this.deps.actions);
      const listExpenses = this.deps.actions.listRecentExpenses?.bind(this.deps.actions);
      const listDestinations = this.deps.actions.listFilingDestinations?.bind(this.deps.actions);
      const tool = this.tool('lier_depense_chantier');
      if (!assign || !listExpenses || !listDestinations || !tool) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Imputer une dépense',
            body: 'Je ne peux pas imputer de dépense à un chantier sur cet appareil pour le moment. Rien n’a été modifié — tu peux le faire depuis l’écran Dépenses.',
          },
        });
      }
      const [expensesResult, destinationsResult] = await Promise.all([listExpenses(), listDestinations()]);
      if (!expensesResult.ok) return err(expensesResult.error);
      if (!destinationsResult.ok) return err(destinationsResult.error);
      // Les plus récentes d'abord : « la dépense Aldi » désigne la dernière en cas d'homonymes.
      const expenses = [...expensesResult.value].sort((a, b) => b.documentDate.localeCompare(a.documentDate));
      const chantiers = destinationsResult.value.chantiers;
      if (expenses.length === 0) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lister les dépenses récentes'],
          card: { title: 'Aucune dépense', body: 'Aucune dépense enregistrée pour le moment — rien à imputer.' },
        });
      }
      if (chantiers.length === 0) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lister les chantiers ouverts'],
          card: {
            title: 'Aucun chantier ouvert',
            body: 'Je ne vois aucun chantier ouvert où imputer cette dépense. Rien n’a été modifié.',
          },
        });
      }
      // « la dépense X sur le chantier Y » : le marqueur sépare la dépense (avant) du chantier (après).
      const splitMatch = /\b(sur|vers|au|aux|pour|dans)\b/i.exec(message);
      const expensePartRaw = splitMatch ? message.slice(0, splitMatch.index) : message;
      const chantierPartRaw = splitMatch ? message.slice(splitMatch.index + splitMatch[0].length) : message;
      const conversation = [
        ...(history ?? []).slice(-4).filter((turn) => turn.role === 'user').map((turn) => turn.text),
        expensePartRaw,
      ].join(' ');
      const matches = matchExpensesByTokens(conversation, expenses);
      const target = matches.length === 1 ? matches[0]! : null;
      // Chantier : id exact (followUps) > nom entier > mot significatif — listes RÉELLES only.
      const chantierScope = normalized(chantierPartRaw);
      let tail = '';
      const scanChantier = /\bchantiers?\b([^,;.!?]{0,60})/g;
      let chantierMention: RegExpExecArray | null;
      while ((chantierMention = scanChantier.exec(chantierScope)) !== null) tail = chantierMention[1] ?? '';
      if (tail.trim().length === 0) tail = chantierScope;
      const scopeTokens = new Set(
        tail.split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !EXPENSE_ASSIGN_GESTURE_WORDS.has(word)),
      );
      const byId = chantiers.filter(
        (c) => normalized(c.id).length >= 3 && containsExactTokens(chantierScope, normalized(c.id)),
      );
      const strong = chantiers.filter((c) => {
        const tokens = destinationNameTokens(c.nom);
        return tokens.length > 0 && tokens.every((word) => scopeTokens.has(word));
      });
      const loose = chantiers.filter((c) => destinationNameTokens(c.nom).some((word) => scopeTokens.has(word)));
      const chantier =
        byId.length === 1
          ? byId[0]!
          : strong.length === 1
            ? strong[0]!
            : strong.length === 0 && loose.length === 1
              ? loose[0]!
              : null;

      if (!target) {
        // Suffixe chantier des followUps : la cible résolue (id), sinon les mots dits — la
        // commande de suivi reste complète, l'UI ne reconstruit jamais une phrase.
        const chantierSuffix = chantier
          ? `sur le chantier ${chantier.id}`
          : splitMatch
            ? message.slice(splitMatch.index).replace(/\s+/g, ' ').trim()
            : 'sur le chantier';
        const options = (matches.length > 1 ? matches : expenses).slice(0, 4);
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lister les dépenses récentes', 'Lever l’ambiguïté de la dépense'],
          card: { title: 'Quelle dépense ?', body: 'Dis-moi quelle dépense imputer :' },
          choices: options.map((e) => ({
            label: `${e.supplierName} — ${formatEUR(e.totalTtcCents)} · ${frDate(e.documentDate)}`,
            value: `Mets la dépense ${e.id} ${chantierSuffix}`,
          })),
          ask: [
            askToPick({
              id: 'lier_depense_chantier.depense',
              question: 'Quelle dépense veux-tu imputer ?',
              header: 'Dépense',
              items: options.map((e) => ({
                value: e.id,
                label: e.supplierName,
                description: `${formatEUR(e.totalTtcCents)} · du ${frDate(e.documentDate)}`,
                followUp: `Mets la dépense ${e.id} ${chantierSuffix}`,
              })),
            }),
          ],
        });
      }

      if (!chantier) {
        // Chantier NOMMÉ mais introuvable dans la liste réelle : refus honnête — Bob n'invente
        // jamais un chantier (anti-hallucination).
        const saidName = tail.replace(/\s+/g, ' ').trim();
        if (scopeTokens.size > 0 && strong.length === 0 && loose.length === 0) {
          return ok({
            kind: 'answer',
            intent,
            model,
            plan: ['Vérifier le chantier contre la liste réelle'],
            card: {
              title: 'Chantier introuvable',
              body: `Je ne trouve aucun chantier ouvert correspondant à « ${saidName.length > 0 ? saidName : 'ce chantier'} ». Rien n’a été modifié — donne-moi un chantier ouvert.`,
            },
          });
        }
        const options = (strong.length > 1 ? strong : loose.length > 0 ? loose : chantiers).slice(0, 4);
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Identifier la dépense', 'Lever l’ambiguïté du chantier'],
          card: {
            title: 'Quel chantier ?',
            body: `Sur quel chantier mettre la dépense ${target.supplierName} (${formatEUR(target.totalTtcCents)}) ?`,
          },
          choices: options.map((c) => ({
            label: `Chantier ${c.nom}`,
            value: `Mets la dépense ${target.id} sur le chantier ${c.id}`,
          })),
          ask: [
            askToPick({
              id: 'lier_depense_chantier.chantier',
              question: `Sur quel chantier mettre la dépense ${target.supplierName} ?`,
              header: 'Chantier',
              items: options.map((c) => ({
                value: c.id,
                label: c.nom,
                followUp: `Mets la dépense ${target.id} sur le chantier ${c.id}`,
              })),
            }),
          ],
        });
      }

      // Idempotence honnête : déjà imputée à CE chantier — rien à écrire, pas de proposition.
      if (target.chantierId === chantier.id) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier l’imputation actuelle'],
          card: {
            title: 'Déjà imputée',
            body: `La dépense ${target.supplierName} (${formatEUR(target.totalTtcCents)}) est déjà sur le chantier ${chantier.nom} — rien à changer.`,
          },
        });
      }
      const previousName =
        target.chantierId !== null ? chantiers.find((c) => c.id === target.chantierId)?.nom ?? null : null;
      const replaceNote =
        target.chantierId !== null
          ? ` Elle quitte ${previousName !== null ? `le chantier ${previousName}` : 'son chantier actuel'}.`
          : '';
      const args = { expenseId: target.id, chantierId: chantier.id };
      const parsed = tool.parse(args);
      if (!parsed.ok) return err(parsed.error);
      const label = `Imputer la dépense ${target.supplierName} (${formatEUR(target.totalTtcCents)}, du ${frDate(target.documentDate)}) au chantier ${chantier.nom}`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Trouver la dépense', 'Vérifier le chantier ouvert', 'Attendre ta confirmation'],
          card: {
            title: 'Imputation à confirmer',
            body: `${label}.${replaceNote} La rentabilité du chantier la comptera — aucune écriture comptable, juste le lien. Je confirme ?`,
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
        plan: ['Imputer la dépense au chantier'],
        card: { title: 'Dépense imputée ✓', body: `${label} — c’est noté.` },
      });
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
      const operationCategory = invoice.operationCategoryRequired
        ? extractFrenchOperationCategory(message)
        : null;
      if (invoice.operationCategoryRequired && operationCategory === null) {
        const ref = displayRef(invoice);
        const question = frenchOperationCategoryQuestion({
          id: 'emettre_facture.operationCategory',
          invoiceRef: ref,
          customerName: invoice.customerName,
          commandPrefix: `Émets la facture ${ref}`,
          scoped: false,
        });
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Identifier la facture brouillon', 'Demander la nature réglementaire manquante'],
          card: {
            title: 'Nature de l’opération',
            body:
              `Avant d’émettre la facture ${ref}, j’ai besoin d’un fait métier : `
              + 'quelle est la nature principale de l’opération ? Rien n’a encore été modifié.',
          },
          choices: question.options.map((option) => ({
            label: option.label,
            value: option.followUp,
          })),
          ask: [question],
        });
      }
      const tool = this.tool('emettre_facture')!;
      // PR-04 — override RESPONSABILISÉ de la garde « BC obligatoire » : uniquement quand
      // l'artisan le DIT (« émets la facture X sans bon de commande », la commande canonique du
      // rattrapage) — jamais déduit. Le risque est énoncé dans la proposition (safetyFloor :
      // confirmation dédiée), l'événement est journalisé côté serveur.
      const purchaseOrderOverride = /\bsans (le |son )?(bon de commande|bc)\b/.test(normalized(message));
      const args = {
        invoiceId: invoice.id,
        ...(operationCategory === null ? {} : { operationCategory }),
        ...(purchaseOrderOverride ? { purchaseOrderOverride: true } : {}),
      };
      const label = `Émettre la facture ${displayRef(invoice)} pour ${invoice.customerName} (${formatEUR(invoice.totalTtcCents)})${purchaseOrderOverride ? ' SANS bon de commande' : ''}`;
      if (requiresConfirmation(tool, autonomy)) {
        const overrideRisk = purchaseOrderOverride
          ? '\n⚠ Ce client exige un n° de bon de commande : sans lui, la facture risque d’être rejetée — l’émission sans BC est tracée.'
          : '';
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Identifier la facture brouillon', 'Préparer l’émission légale', 'Attendre ta confirmation'],
          card: { title: 'Émission de facture à confirmer', body: `${label}${overrideRisk}\nJe numérote et j’archive les pièces légales ?` },
          pending: { tool: tool.name, args, label },
          spokenPrompt: buildSpokenConfirmation(label),
        });
      }
      const run = await tool.run(args);
      if (!run.ok) {
        // PR-04 — refus « BC obligatoire » : jamais une erreur brute — le rattrapage réel.
        const po = purchaseOrderRequiredDetails(run.error);
        if (po) return ok(purchaseOrderRequiredRun({ model, invoiceRef: displayRef(invoice), details: po }));
        return err(run.error);
      }
      return ok({ kind: 'done', intent, model, plan: ['Émettre la facture'], card: { title: 'Facture émise ✓', body: `${label} — c’est émis.` } });
    }

    if (intent === 'envoyer_facture') {
      // PR-01 — envoi EMAIL réel d'une facture ÉMISE : MÊME use case SendInvoice que le bouton
      // mobile et POST /invoices/:id/send (lien de consultation + PDF archivé joint, expéditeur
      // perçu = la société). Cible résolue parmi les factures émises encore dues — la même
      // matière que l'encaissement et la relance ; les gardes serveur (brouillon, e-mail client
      // manquant) sont restituées VERBATIM. Sortant : toujours confirmé (plancher du registre).
      const tool = this.tool('envoyer_facture');
      if (!tool) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Envoyer une facture',
            body: 'Je ne peux pas encore envoyer de facture depuis cet appareil — passe par la fiche de la facture. Rien n’a été envoyé.',
          },
        });
      }
      const r = await this.deps.actions.listPayableInvoices();
      if (!r.ok) return err(r.error);
      const resolved = resolveInvoiceTarget({
        message,
        reference,
        invoices: r.value,
        ...(context !== undefined ? { context } : {}),
        capability: 'invoice.read',
      });
      const invoice = resolved.target;
      if (!invoice) {
        const options = [...resolved.choices];
        const body = unresolvedTargetBody({
          ...(resolved.unactionableLabel !== undefined ? { unactionableLabel: resolved.unactionableLabel } : {}),
          hasOptions: options.length > 0,
          ask: 'Quelle facture veux-tu envoyer ?',
          empty: 'Aucune facture émise en attente d’encaissement — rien à envoyer.',
        });
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Chercher la facture émise'],
          card: { title: 'Quelle facture ?', body },
          choices: options.map((i) => ({ label: `${i.number} — ${i.customerName} · ${formatEUR(i.remainingCents)}`, value: `Envoie la facture ${i.number}` })),
          ...(options.length
            ? {
                ask: [
                  askToPick({
                    id: 'envoyer_facture.cible',
                    question: 'Quelle facture veux-tu envoyer au client ?',
                    header: 'Facture',
                    items: options.map((i) => ({
                      value: i.number,
                      label: i.number,
                      description: `${i.customerName} · reste ${formatEUR(i.remainingCents)}`,
                      followUp: `Envoie la facture ${i.number}`,
                    })),
                  }),
                ],
              }
            : {}),
        });
      }
      const args = { invoiceId: invoice.id };
      const parsed = tool.parse(args);
      if (!parsed.ok) return err(parsed.error);
      const label = `Envoyer la facture ${invoice.number} à ${invoice.customerName} (reste dû ${formatEUR(invoice.remainingCents)})`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Identifier la facture émise', 'Préparer l’e-mail (lien + PDF archivé)', 'Attendre ta confirmation'],
          card: {
            title: 'Envoi de facture à confirmer',
            body: `${label}.\nE-mail au client avec le lien de consultation et le PDF joint — expéditeur : ta société. J’envoie ?`,
          },
          pending: { tool: tool.name, args, label },
          spokenPrompt: buildSpokenConfirmation(label),
        });
      }
      const run = await tool.run(parsed.value);
      if (!run.ok) {
        const guard = domainGuardCard(run.error);
        if (guard) {
          return ok({ kind: 'answer', intent, model, plan: ['Restituer le refus du domaine'], card: guard });
        }
        return err(run.error);
      }
      return ok({
        kind: 'done',
        intent,
        model,
        plan: ['Envoyer la facture au client'],
        card: { title: 'Facture envoyée ✓', body: `${label} — c’est parti.` },
      });
    }

    if (intent === 'relance_devis') {
      // PR-05 — relance d'un DEVIS envoyé resté sans réponse : le MÊME message pré-rédigé
      // (buildQuoteRelance) au MÊME palier J+15/J+30 que la carte Aujourd'hui, la fiche devis
      // et le rappel cron — via l'action de l'hôte (une seule dérivation). Lecture pure : rien
      // ne part ; le renvoi réel du devis (lien de signature frais) reste envoyer_devis, confirmé.
      const draftQuote = this.deps.actions.draftQuoteRelance?.bind(this.deps.actions);
      const tool = this.tool('relance_devis');
      if (!draftQuote || !tool) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Relancer un devis',
            body: 'Je ne peux pas encore préparer de relance de devis sur cet appareil — le message pré-rédigé t’attend sur la fiche du devis.',
          },
        });
      }
      const r = await this.deps.actions.listSendableQuotes();
      if (!r.ok) return err(r.error);
      // Un devis se relance quand il ATTEND une réponse : envoyé ou vu — jamais un brouillon.
      const awaiting = r.value.filter((q) => q.status === 'sent' || q.status === 'viewed');
      if (awaiting.length === 0) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Chercher les devis en attente de réponse'],
          card: { title: 'Relancer un devis', body: 'Aucun devis envoyé en attente de réponse — rien à relancer.' },
        });
      }
      const resolved = resolveDocumentTarget({
        message,
        reference,
        documents: awaiting,
        ...(context !== undefined ? { context } : {}),
        type: 'quote',
        capability: 'quote.read',
      });
      const quote = resolved.target;
      if (!quote) {
        const options = [...resolved.choices];
        const body = unresolvedTargetBody({
          ...(resolved.unactionableLabel !== undefined ? { unactionableLabel: resolved.unactionableLabel } : {}),
          hasOptions: options.length > 0,
          ask: 'Quel devis veux-tu relancer ?',
          empty: 'Aucun devis envoyé en attente de réponse.',
        });
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lever l’ambiguïté du devis'],
          card: { title: 'Quel devis ?', body },
          choices: options.map((q) => ({ label: `${displayRef(q)} — ${q.customerName} · ${formatEUR(q.totalTtcCents)}`, value: `Relance le devis ${displayRef(q)}` })),
          ...(options.length
            ? {
                ask: [
                  askToPick({
                    id: 'relance_devis.cible',
                    question: 'Quel devis veux-tu relancer ?',
                    header: 'Devis',
                    items: options.map((q) => ({
                      value: displayRef(q),
                      label: displayRef(q),
                      description: `${q.customerName} · ${formatEUR(q.totalTtcCents)}`,
                      followUp: `Relance le devis ${displayRef(q)}`,
                    })),
                  }),
                ],
              }
            : {}),
        });
      }
      const draft = await draftQuote({ quoteId: quote.id });
      if (!draft.ok) {
        const guard = domainGuardCard(draft.error);
        if (guard) {
          return ok({ kind: 'answer', intent, model, plan: ['Restituer le refus du domaine'], card: guard });
        }
        return err(draft.error);
      }
      if (!draft.value.relanceable) {
        // Hors palier (trop tôt, statut) : la réponse HONNÊTE du service — jamais une relance
        // fabriquée hors du rythme J+15/J+30 partagé avec le cron.
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: [`Cibler le devis ${displayRef(quote)} (${quote.customerName})`, 'Vérifier le palier de relance'],
          card: { title: draft.value.subject, body: draft.value.body },
        });
      }
      return ok({
        kind: 'answer',
        intent,
        model,
        plan: [
          `Cibler le devis ${displayRef(quote)} (${quote.customerName})`,
          'Composer le message au palier atteint (même moteur que la carte Aujourd’hui)',
        ],
        card: {
          title: draft.value.subject,
          body: `${draft.value.body}\n—\nJe peux aussi renvoyer le devis par e-mail avec un lien de signature frais.`,
        },
        choices: [
          { label: 'Renvoyer le devis par e-mail', value: `Envoie le devis ${displayRef(quote)}` },
        ],
      });
    }

    if (intent === 'declarer_transmission') {
      // PR-02 — transmission DÉCLARÉE d'une facture ÉMISE (« j'ai déposé la facture sur Chorus
      // hier ») : MÊME use case RecordInvoiceTransmission que l'écran (dates dites, jamais
      // devinées ; acceptation ⊇ dépôt jugé par le domaine). Le rappel J+2 devient soldable à
      // la voix. Fait déclaré : plancher de consentement (registre).
      const tool = this.tool('marquer_facture_transmise');
      if (!tool) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Noter une transmission',
            body: 'Je ne peux pas encore noter la transmission d’une facture sur cet appareil — passe par la fiche de la facture. Rien n’a été modifié.',
          },
        });
      }
      const r = await this.deps.actions.listPayableInvoices();
      if (!r.ok) return err(r.error);
      const resolved = resolveInvoiceTarget({
        message,
        reference,
        invoices: r.value,
        ...(context !== undefined ? { context } : {}),
        capability: 'invoice.read',
      });
      const invoice = resolved.target;
      if (!invoice) {
        const options = [...resolved.choices];
        const body = unresolvedTargetBody({
          ...(resolved.unactionableLabel !== undefined ? { unactionableLabel: resolved.unactionableLabel } : {}),
          hasOptions: options.length > 0,
          ask: 'Quelle facture as-tu transmise ?',
          empty: 'Aucune facture émise en attente — rien à noter.',
        });
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Chercher la facture émise'],
          card: { title: 'Quelle facture ?', body },
          choices: options.map((i) => ({ label: `${i.number} — ${i.customerName} · ${formatEUR(i.remainingCents)}`, value: `J’ai déposé la facture ${i.number} sur le portail` })),
          ...(options.length
            ? {
                ask: [
                  askToPick({
                    id: 'declarer_transmission.cible',
                    question: 'Quelle facture as-tu transmise à ton client ?',
                    header: 'Facture',
                    items: options.map((i) => ({
                      value: i.number,
                      label: i.number,
                      description: `${i.customerName} · reste ${formatEUR(i.remainingCents)}`,
                      followUp: `J’ai déposé la facture ${i.number} sur le portail`,
                    })),
                  }),
                ],
              }
            : {}),
        });
      }
      // Continuité vocale : la date courte (« hier ») répond à la question posée juste avant.
      const conversation = [
        ...(history ?? []).slice(-4).filter((turn) => turn.role === 'user').map((turn) => turn.text),
        message,
      ].join(' ');
      // Acceptation EXPLICITE seulement — sinon c'est un dépôt/envoi (le geste courant).
      const isAcceptance = /\baccept/.test(normalized(conversation));
      const now = this.deps.runtime?.clock.now();
      const today = now && /^\d{4}-\d{2}-\d{2}T/.test(now) ? parisDateOnly(now) : null;
      const saidDate = parseExpensePaymentDetails(conversation, today).paidOn;
      if (!saidDate) {
        const verb = isAcceptance ? 'acceptée' : 'transmise';
        const commandFor = (suffix: string): string =>
          isAcceptance
            ? `La facture ${invoice.number} a été acceptée ${suffix}`
            : `J’ai déposé la facture ${invoice.number} sur le portail ${suffix}`;
        const options = today
          ? [
              { value: today, label: 'Aujourd’hui', description: today, followUp: commandFor('aujourd’hui') },
              { value: 'yesterday', label: 'Hier', description: 'La veille de la date du jour', followUp: commandFor('hier') },
            ]
          : [];
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Identifier la facture', 'Demander la date réelle de transmission'],
          card: {
            title: 'Quelle date ?',
            body: `À quelle date la facture ${invoice.number} (${invoice.customerName}) a-t-elle été ${verb} ? Dis-la au format JJ/MM/AAAA — je ne la devine pas. Rien n’a été modifié.`,
          },
          ...(options.length >= 2
            ? {
                choices: options.map((option) => ({ label: option.label, value: option.followUp })),
                ask: [askToPick({
                  id: 'declarer_transmission.date',
                  question: `Quand la facture ${invoice.number} a-t-elle été ${verb} ?`,
                  header: 'Date',
                  items: options,
                })],
              }
            : {}),
        });
      }
      if (today && saidDate > today) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Contrôler la date déclarée'],
          card: {
            title: 'Date future impossible',
            body: `Le ${frDate(saidDate)} est dans le futur. Donne-moi la date d’une transmission déjà faite ; rien n’a été noté.`,
          },
        });
      }
      const args = {
        invoiceId: invoice.id,
        ...(isAcceptance ? { acceptedAt: saidDate } : { depositedAt: saidDate }),
      };
      const parsed = tool.parse(args);
      if (!parsed.ok) return err(parsed.error);
      const label = isAcceptance
        ? `Noter la facture ${invoice.number} acceptée le ${frDate(saidDate)} (${invoice.customerName})`
        : `Noter la facture ${invoice.number} transmise le ${frDate(saidDate)} (${invoice.customerName})`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Identifier la facture émise', 'Préparer le suivi déclaré', 'Attendre ta confirmation'],
          card: {
            title: 'Transmission à confirmer',
            body: `${label}.\nC’est un suivi déclaré — rien n’est envoyé au client. Je le note ?`,
          },
          pending: { tool: tool.name, args, label },
          spokenPrompt: buildSpokenConfirmation(label),
        });
      }
      const run = await tool.run(parsed.value);
      if (!run.ok) {
        const guard = domainGuardCard(run.error);
        if (guard) {
          return ok({ kind: 'answer', intent, model, plan: ['Restituer le refus du domaine'], card: guard });
        }
        return err(run.error);
      }
      return ok({
        kind: 'done',
        intent,
        model,
        plan: ['Noter la transmission déclarée'],
        card: { title: 'Transmission notée ✓', body: `${label} — le suivi est à jour.` },
      });
    }

    if (intent === 'cadence_relances') {
      // PR-06 — la politique de relances À LA VOIX : lecture de la cadence en vigueur (même
      // source CompanyBillingSettings que l'écran et le cron) et bascule CONFIRMÉE des relances
      // automatiques. La cadence fine (4 paliers) se règle à l'écran — jamais devinée d'un
      // « tous les 10 jours » ambigu.
      const getSettings = this.deps.actions.getRelanceSettings?.bind(this.deps.actions);
      const readTool = this.tool('cadence_relances');
      if (!getSettings || !readTool) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Tes relances',
            body: 'Je ne peux pas encore lire tes réglages de relance sur cet appareil — passe par Réglages → Facturation.',
          },
        });
      }
      const s = await getSettings();
      if (!s.ok) return err(s.error);
      const policy = s.value.relancePolicy;
      const cadenceLine = policy
        ? `Cadence personnalisée : cordial J+${policy.cordialAfterDays} · neutre J+${policy.neutreAfterDays} · ferme J+${policy.fermeAfterDays} · mise en demeure J+${policy.miseEnDemeureAfterDays} après l’échéance.`
        : 'Cadence par défaut : cordial J+3 · neutre J+10 · ferme J+20 · mise en demeure J+30 après l’échéance.';
      const autoLine = s.value.relanceAutoEnabled
        ? 'Relances automatiques : ACTIVES — les relances partent au rythme de la cadence ; la mise en demeure, elle, n’est jamais envoyée sans ta validation.'
        : 'Relances automatiques : COUPÉES — rien ne part tout seul, la relance manuelle reste possible.';
      const normalizedCadence = normalized(message);
      const wantsOff = /\b(coupe|couper|desactive|desactiver|arrete|arreter|stoppe|stopper|suspends?|suspendre|eteins|eteindre)\b/.test(normalizedCadence);
      const wantsOn = /\b(active|activer|reactive|reactiver|rallume|rallumer|remets|remettre|reprends|reprendre)\b/.test(normalizedCadence);
      const setTool = this.tool('regler_relances_auto');
      if ((wantsOff || wantsOn) && !(wantsOff && wantsOn) && setTool) {
        const enabled = wantsOn;
        if (enabled === s.value.relanceAutoEnabled) {
          return ok({
            kind: 'answer',
            intent,
            model,
            plan: ['Relire les réglages de relance'],
            card: {
              title: 'Déjà réglé ainsi',
              body: `${autoLine}\nRien à changer.`,
            },
          });
        }
        const args = { enabled };
        const parsed = setTool.parse(args);
        if (!parsed.ok) return err(parsed.error);
        const label = enabled ? 'Activer les relances automatiques' : 'Couper les relances automatiques';
        const consequence = enabled
          ? 'Les relances repartiront au rythme de ta cadence ; la mise en demeure restera soumise à ta validation.'
          : 'Plus aucune relance ne partira toute seule — tu pourras toujours relancer à la main.';
        if (requiresConfirmation(setTool, autonomy)) {
          return ok({
            kind: 'proposed',
            intent,
            model,
            plan: ['Relire les réglages de relance', 'Préparer la bascule', 'Attendre ta confirmation'],
            card: {
              title: 'Relances automatiques à confirmer',
              body: `${label}. ${consequence} Je confirme ?`,
            },
            pending: { tool: setTool.name, args, label },
            spokenPrompt: buildSpokenConfirmation(label),
          });
        }
        const run = await setTool.run(parsed.value);
        if (!run.ok) {
          const guard = domainGuardCard(run.error);
          if (guard) {
            return ok({ kind: 'answer', intent, model, plan: ['Restituer le refus du domaine'], card: guard });
          }
          return err(run.error);
        }
        return ok({
          kind: 'done',
          intent,
          model,
          plan: ['Basculer les relances automatiques'],
          card: { title: enabled ? 'Relances automatiques activées ✓' : 'Relances automatiques coupées ✓', body: `${label} — c’est fait. ${consequence}` },
        });
      }
      // Lecture pure — avec le geste de bascule à portée de voix (chip, repli existant).
      const toggleChip = setTool
        ? [
            s.value.relanceAutoEnabled
              ? { label: 'Couper les relances automatiques', value: 'Coupe les relances automatiques' }
              : { label: 'Activer les relances automatiques', value: 'Active les relances automatiques' },
          ]
        : [];
      return ok({
        kind: 'answer',
        intent,
        model,
        plan: ['Lire la politique de relances (même source que l’écran et le cron)'],
        card: {
          title: 'Tes relances',
          body: `${cadenceLine}\n${autoLine}\nPour ajuster la cadence palier par palier, passe par Réglages → Facturation.`,
        },
        ...(toggleChip.length > 0 ? { choices: toggleChip } : {}),
      });
    }

    if (intent === 'lier_bon_commande') {
      // B8 — « la RATP m'a envoyé un bon de commande n° 4500123 » : le numéro d'engagement
      // s'attache AU DEVIS (saisie unique) et sera repris automatiquement sur la facture
      // dérivée (Invoice.fromSignedQuote — core). Résolution contre les listes RÉELLES du
      // tenant : jamais un devis ni un numéro inventés ; toute ambiguïté redevient une question.
      const attach = this.deps.actions.attachPurchaseOrderToQuote?.bind(this.deps.actions);
      const listInvoiceable = this.deps.actions.listInvoiceableQuotes?.bind(this.deps.actions);
      const tool = this.tool('lier_bon_commande');
      if (!attach || !listInvoiceable || !tool) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Lier un bon de commande',
            body: 'Je ne peux pas lier de bon de commande sur cet appareil pour le moment. Rien n’a été modifié — tu peux le renseigner depuis la fiche du devis.',
          },
        });
      }
      const [signedResult, sendableResult] = await Promise.all([
        listInvoiceable(),
        this.deps.actions.listSendableQuotes(),
      ]);
      if (!signedResult.ok) return err(signedResult.error);
      if (!sendableResult.ok) return err(sendableResult.error);
      // Devis EN COURS du tenant : signés non facturés (PRIORITÉ), puis envoyés en attente de
      // signature. Les brouillons restent hors jeu : un bon de commande répond à un devis reçu.
      const candidates = [
        ...signedResult.value.map((q) => ({
          id: q.id,
          number: q.number,
          customerName: q.customerName,
          totalTtcCents: q.totalTtcCents,
          signed: true,
          currentPoNumber: q.purchaseOrder?.number ?? null,
        })),
        ...sendableResult.value
          .filter((q) => q.status === 'sent' || q.status === 'viewed')
          .map((q) => ({
            id: q.id,
            number: q.number,
            customerName: q.customerName,
            totalTtcCents: q.totalTtcCents,
            signed: false,
            currentPoNumber: null as string | null,
          })),
      ];
      if (candidates.length === 0) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lister les devis en cours'],
          card: {
            title: 'Aucun devis en cours',
            body: 'Je ne vois aucun devis envoyé ou signé en attente : un bon de commande se lie à un devis en cours. Rien n’a été modifié.',
          },
        });
      }
      // Historique court : lève l'anaphore (« c'est le n° 4500123 » après la question du numéro,
      // ou le followUp « Le bon de commande est pour le devis X » après la liste).
      const conversation = [
        ...(history ?? []).slice(-4).filter((turn) => turn.role === 'user').map((turn) => turn.text),
        message,
        reference ?? '',
      ].join(' ');
      const po = extractPurchaseOrderNumber(conversation);
      // Le numéro extrait ne doit JAMAIS cibler un devis : on l'écarte du texte de résolution.
      const resolutionText = po ? stripPurchaseOrderRaw(conversation, po.raw) : conversation;
      const normalizedResolution = normalized(resolutionText);
      // « je l'ai scanné » : réponse honnête — l'outil vocal V1 lie le NUMÉRO ; le document
      // scanné se rattache ensuite à la main (champ documentId du picker), jamais deviné ici.
      const scanNote = /\bscan/.test(normalized(`${message} ${reference ?? ''}`))
        ? ' Le scan du bon de commande se rattachera à la main depuis la fiche du devis — ici je lie le numéro.'
        : '';
      // 1) Devis désigné par son numéro/id EXACT (tokens entiers — jamais un préfixe).
      const byExplicit = candidates.filter((q) => {
        const id = normalized(q.id);
        const num = q.number !== null ? normalized(q.number) : null;
        return (
          (id.length >= 3 && containsExactTokens(normalizedResolution, id))
          || (num !== null && num.length >= 3 && containsExactTokens(normalizedResolution, num))
        );
      });
      // 2) Client par jetons SIGNIFICATIFS — la liste réelle = les clients des devis en cours.
      const resolutionTokens = new Set(
        normalizedResolution
          .split(/[^a-z0-9]+/)
          .filter((word) => word.length >= 3 && !PURCHASE_ORDER_GESTURE_WORDS.has(word)),
      );
      const matchedClientNames = [...new Set(candidates.map((q) => q.customerName))].filter((name) =>
        significantNameWords(normalized(name)).some((word) => resolutionTokens.has(word)),
      );
      let targeted = candidates;
      if (byExplicit.length > 0) {
        targeted = byExplicit;
      } else if (matchedClientNames.length === 1) {
        const ofClient = candidates.filter((q) => q.customerName === matchedClientNames[0]);
        const signedOfClient = ofClient.filter((q) => q.signed);
        targeted = signedOfClient.length > 0 ? signedOfClient : ofClient;
      } else if (matchedClientNames.length > 1) {
        targeted = candidates.filter((q) => matchedClientNames.includes(q.customerName));
      } else {
        // Aucun client reconnu : un nom dit mais INCONNU des devis en cours interdit tout choix
        // silencieux — refus honnête. Sans jeton restant, l'unicité métier peut trancher.
        const knownTokens = new Set(
          candidates.flatMap((q) => [
            ...significantNameWords(normalized(q.customerName)),
            ...normalized(`${q.number ?? ''} ${q.id}`).split(/[^a-z0-9]+/).filter((word) => word.length >= 3),
          ]),
        );
        const currentTokens = normalized(po ? stripPurchaseOrderRaw(`${message} ${reference ?? ''}`, po.raw) : `${message} ${reference ?? ''}`)
          .split(/[^a-z0-9]+/)
          .filter((word) => word.length >= 3 && !PURCHASE_ORDER_GESTURE_WORDS.has(word));
        const leftover = currentTokens.filter((word) => !knownTokens.has(word) && !/^\d+$/.test(word));
        if (leftover.length > 0) {
          const leftoverSet = new Set(leftover);
          const said = message
            .split(/[^\p{L}\p{N}-]+/u)
            .filter((word) => leftoverSet.has(normalized(word)))
            .slice(0, 4)
            .join(' ');
          return ok({
            kind: 'answer',
            intent,
            model,
            plan: ['Chercher les devis en cours du client'],
            card: {
              title: 'Client introuvable',
              body: `Je ne trouve pas de devis en cours pour ${said.length > 0 ? said : 'ce client'}. Un bon de commande se lie à un devis déjà envoyé ou signé — vérifie le nom, ou crée d’abord le devis. Rien n’a été modifié.`,
            },
          });
        }
      }
      const target = targeted.length === 1 ? targeted[0]! : null;
      if (!target) {
        // Plusieurs devis plausibles : question structurée, les devis EN CLAIR — jamais un
        // choix silencieux sur une pièce de facturation.
        const options = targeted.slice(0, 8);
        const clientLabel = matchedClientNames.length === 1 ? matchedClientNames[0]! : null;
        const statusLabel = (q: (typeof candidates)[number]): string =>
          q.signed ? 'signé, à facturer' : 'envoyé, en attente de signature';
        const followUpFor = (q: (typeof candidates)[number]): string =>
          po
            ? `Ajoute le bon de commande n° ${po.number} au devis ${q.id}`
            : `Le bon de commande est pour le devis ${q.id}`;
        const lines = options.map(
          (q) => `• ${displayRef(q)} — ${q.customerName} · ${formatEUR(q.totalTtcCents)} (${statusLabel(q)})`,
        );
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lister les devis en cours', 'Lever l’ambiguïté du devis'],
          card: {
            title: 'Quel devis ?',
            body: `${clientLabel !== null ? `${clientLabel} a ${options.length} devis en cours :` : 'Plusieurs devis sont en cours :'}\n${lines.join('\n')}\nLequel a reçu le bon de commande ?`,
          },
          choices: options.map((q) => ({
            label: `${displayRef(q)} — ${q.customerName} · ${formatEUR(q.totalTtcCents)}`,
            value: followUpFor(q),
          })),
          ask: [
            askToPick({
              id: 'lier_bon_commande.cible',
              question:
                clientLabel !== null
                  ? `${clientLabel} a ${options.length} devis en cours — lequel a reçu le bon de commande ?`
                  : 'Quel devis a reçu le bon de commande ?',
              header: 'Devis',
              items: options.map((q) => ({
                value: q.id,
                label: displayRef(q),
                description: `${q.customerName} · ${formatEUR(q.totalTtcCents)} — ${statusLabel(q)}`,
                followUp: followUpFor(q),
              })),
            }),
          ],
        });
      }
      if (!po) {
        // Le numéro manque : Bob le DEMANDE (jamais inventé) — sans lui, la facture des grands
        // comptes est rejetée ou retardée (exigence de paiement, Chorus Pro pour le public).
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Identifier le devis', 'Demander le numéro du bon de commande'],
          card: {
            title: 'Quel numéro ?',
            body: `Il me faut le numéro du bon de commande de ${target.customerName} pour le devis ${displayRef(target)}. Dis-le-moi (par exemple « n° 4500123 ») — sans lui, la facture serait rejetée par le client.${scanNote}`,
          },
        });
      }
      const replaceNote =
        target.currentPoNumber !== null && target.currentPoNumber !== po.number
          ? ` Il remplace le n° ${target.currentPoNumber} déjà noté.`
          : '';
      const args = { quoteId: target.id, number: po.number };
      const parsed = tool.parse(args);
      if (!parsed.ok) return err(parsed.error);
      const label = `Lier le bon de commande n° ${po.number} au devis ${displayRef(target)} de ${target.customerName} (${formatEUR(target.totalTtcCents)})`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Identifier le devis', 'Contrôler le numéro d’engagement', 'Attendre ta confirmation'],
          card: {
            title: 'Bon de commande à confirmer',
            body: `${label}. Le numéro d’engagement sera repris automatiquement sur la facture.${replaceNote}${scanNote} Je confirme ?`,
          },
          pending: { tool: tool.name, args, label },
          spokenPrompt: buildSpokenConfirmation(label),
        });
      }
      const run = await tool.run(parsed.value);
      if (!run.ok) return err(run.error);
      return ok(purchaseOrderLinkedRun({ intent, model, label, output: run.value }));
    }

    if (intent === 'facturer_situation') {
      // B2 — SITUATION DE TRAVAUX (« facture une situation de 40 % sur le chantier Durand ») :
      // MÊME use case GenerateInvoiceFromQuote (mode 'situation') que l'UI, via l'outil dédié.
      // Le montant est TOUJOURS le choix de l'artisan ; l'avancement des tâches ne fait que
      // PROPOSER (proposeSituationFromChantier, consultatif). Les gardes du domaine (cumul,
      // gel de rétractation, embargo, retenue) sont restituées VERBATIM — jamais contournées.
      const list = this.deps.actions.listInvoiceableQuotes?.bind(this.deps.actions);
      const tool = this.tool('facturer_situation');
      if (!list || !tool) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Situation de travaux',
            body: 'Je n’ai pas accès aux situations de travaux sur cet appareil — passe par l’écran Ventes. Rien n’a été créé.',
          },
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
          card: {
            title: 'Situation de travaux',
            body: 'Aucun devis signé en attente de facturation : une situation s’appuie toujours sur un devis signé. Rien n’a été créé.',
          },
        });
      }
      // Historique court : la réponse courte (« 40 % ») poursuit la question d'avancement.
      const conversation = [
        ...(history ?? []).slice(-4).filter((turn) => turn.role === 'user').map((turn) => turn.text),
        message,
        reference ?? '',
      ].join(' ');
      // Un MONTANT dicté (« 4500 € ») ne doit jamais devenir une référence de devis : la
      // référence extraite n'est gardée que si elle ne recopie pas les chiffres du montant.
      const amountDigits = /(\d+(?:[.,]\d{1,2})?)\s*(?:€|euros?\b|eur\b)/i.exec(conversation)?.[1] ?? null;
      const targetReference = reference !== null && reference !== amountDigits ? reference : null;
      const resolved = resolveDocumentTarget({
        message: conversation,
        reference: targetReference,
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
          plan: ['Lever l’ambiguïté du devis'],
          card: {
            title: 'Quel devis ?',
            body: unresolvedTargetBody({
              ...(resolved.unactionableLabel !== undefined ? { unactionableLabel: resolved.unactionableLabel } : {}),
              hasOptions: options.length > 0,
              ask: 'Précise le devis signé de la situation :',
              empty: 'Aucun devis signé à facturer.',
            }),
          },
          choices: options.map((q) => ({
            label: `${displayRef(q)} — ${q.customerName} · ${formatEUR(q.totalTtcCents)}`,
            value: situationCommand(displayRef(q), null),
          })),
          ask: [
            askToPick({
              id: 'facturer_situation.cible',
              question: 'Sur quel devis signé porter la situation ?',
              header: 'Devis',
              items: options.map((q) => ({
                value: displayRef(q),
                label: displayRef(q),
                description: `${q.customerName} · ${formatEUR(q.totalTtcCents)}`,
                followUp: situationCommand(displayRef(q), null),
              })),
            }),
          ],
        });
      }

      const ref = displayRef(quote);
      // A3 — gel de rétractation B2C : une situation demande le paiement de travaux EXÉCUTÉS —
      // gelée AU MÊME TITRE que la finale pendant le délai (lecture prudente du domaine,
      // GenerateInvoiceFromQuote renverrait RETRACTATION_PERIOD_ACTIVE). Message SOURCE UNIQUE.
      const situationBlockedUntil = quote.finalBlockedUntil ?? null;
      if (situationBlockedUntil !== null) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: [
            'Identifier le devis signé',
            'Vérifier le délai légal de rétractation (14 jours, client particulier)',
            'Expliquer honnêtement le gel et la date de déblocage',
          ],
          card: {
            title: 'Situation : pas encore possible',
            body: `Devis ${ref} (${quote.customerName}) — ${retractationFreezeMessage(situationBlockedUntil)} La situation, comme la finale, attend cette date.`,
          },
        });
      }

      // Montant CHOISI par l'artisan : % dit, ou montant HT dit (la pratique des marchés privés
      // stipule les situations en HT — un montant TTC dicté redevient une question honnête).
      const percent = extractSituationPercent(conversation);
      const amountCents = percent === null ? extractSpokenAmountCents(conversation) : null;
      const basis = extractSpokenAmountBasis(conversation);
      let situation: SituationAmountInput | null = null;
      if (percent !== null) situation = { percent };
      else if (amountCents !== null) {
        if (basis === 'ttc') {
          return ok({
            kind: 'answer',
            intent,
            model,
            plan: ['Contrôler la base du montant'],
            card: {
              title: 'Montant HT requis',
              body: `Les situations de travaux se stipulent hors taxes (la TVA en découle par taux). Redis-moi le montant HT de cette situation (« ${situationCommand(ref, { amountHtCents: amountCents })} ») ou un pourcentage. Rien n’a été créé.`,
            },
          });
        }
        situation = { amountHtCents: amountCents };
      }
      if (situation === null) {
        // % PROPOSÉ des tâches du chantier si l'hôte sait le dériver — consultatif, jamais
        // imposé : l'artisan choisit toujours (proposeSituationFromChantier @bob/core).
        const propose = this.deps.actions.proposeSituationAdvancement?.bind(this.deps.actions);
        const proposal = propose ? await propose({ quoteId: quote.id }) : null;
        const proposed = proposal !== null && proposal.ok ? proposal.value : null;
        if (proposed !== null) {
          return ok({
            kind: 'answer',
            intent,
            model,
            plan: ['Identifier le devis signé', 'Proposer l’avancement des tâches', 'Laisser le choix du montant'],
            card: {
              title: 'Quel avancement pour cette situation ?',
              body:
                `Devis ${ref} (${quote.customerName}, marché ${formatEUR(quote.totalTtcCents)} TTC). `
                + `D’après les tâches du chantier (${proposed.doneCount}/${proposed.totalCount} terminées), je te propose ${proposed.percent} % — c’est toi qui décides : dis-moi un autre pourcentage ou un montant HT si tu préfères.`,
            },
            choices: [
              {
                label: `Situation de ${proposed.percent} % (avancement des tâches)`,
                value: situationCommand(ref, { percent: proposed.percent }),
              },
            ],
          });
        }
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Identifier le devis signé', 'Demander l’avancement (jamais deviné)'],
          card: {
            title: 'Quel avancement pour cette situation ?',
            body: `Devis ${ref} (${quote.customerName}, marché ${formatEUR(quote.totalTtcCents)} TTC). Dis-moi l’avancement de la situation : un pourcentage (« situation de 40 % ») ou un montant HT (« situation de 12000 € HT »). Rien n’a été créé.`,
          },
        });
      }

      const args = { quoteId: quote.id, situation };
      const parsed = tool.parse(args);
      if (!parsed.ok) return err(parsed.error);
      const amountLabel =
        'percent' in situation
          ? `${String(situation.percent).replace('.', ',')} % du marché`
          : `${formatEUR(situation.amountHtCents)} HT`;
      const label = `Générer la situation de ${amountLabel} du devis ${ref} — ${quote.customerName} (marché ${formatEUR(quote.totalTtcCents)} TTC)`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Identifier le devis signé', 'Préparer la situation (même use case que l’écran)', 'Attendre ta confirmation'],
          card: {
            title: 'Situation à confirmer',
            body: `${label}.${retenueNote(quote)} Le cumul acompte + situations reste plafonné au marché (garde du domaine). Je la génère en brouillon ?`,
          },
          pending: { tool: tool.name, args, label },
          spokenPrompt: buildSpokenConfirmation(label),
        });
      }
      const run = await tool.run(parsed.value);
      if (!run.ok) {
        // Gardes du domaine (cumul dépassé, gel, embargo) : restitution VERBATIM, jamais un
        // message technique brut — mêmes messages que l'UI.
        const guard = domainGuardCard(run.error);
        if (guard) {
          return ok({ kind: 'answer', intent, model, plan: ['Restituer le refus du domaine'], card: guard });
        }
        return err(run.error);
      }
      return ok({
        kind: 'done',
        intent,
        model,
        plan: ['Générer la situation'],
        card: { title: 'Situation générée ✓', body: `${label} — brouillon créé, à émettre quand tu veux.${retenueNote(quote)}` },
      });
    }

    if (intent === 'facture_directe') {
      // B1 — FACTURE DIRECTE sans devis signé (« facture 380 € à Mme Girard pour le
      // dépannage ») : MÊME use case ComposeStandaloneInvoice (@bob/core) que POST /invoices.
      // Client/montant/prestation/TVA extraits du message ; tout champ manquant redevient une
      // QUESTION structurée — jamais un défaut inventé, jamais un taux de TVA deviné. Client
      // b2c : la qualification d'urgence A3bis est DEMANDÉE — sans elle, refus honnête du
      // domaine (le devis signé reste le chemin), restitué verbatim.
      const compose = this.deps.actions.composeStandaloneInvoice?.bind(this.deps.actions);
      const listCustomers = this.deps.actions.listBillableCustomers?.bind(this.deps.actions);
      const tool = this.tool('facture_directe');
      if (!compose || !listCustomers || !tool) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Facture directe',
            body: 'Je ne peux pas créer de facture directe sur cet appareil pour le moment. Rien n’a été créé — passe par l’écran Ventes.',
          },
        });
      }
      const conversation = [
        ...(history ?? []).slice(-6).filter((turn) => turn.role === 'user').map((turn) => turn.text),
        message,
        reference ?? '',
      ].join(' ');
      const normalizedConversation = normalized(conversation);
      const customersResult = await listCustomers();
      if (!customersResult.ok) return err(customersResult.error);
      const customers = customersResult.value;

      const amountCents = extractSpokenAmountCents(conversation);
      const basis = extractSpokenAmountBasis(conversation);
      const vatRate = extractSpokenVatRate(conversation);
      const discount = extractSpokenDiscount(conversation);
      const service = extractSpokenServiceLabel(conversation);
      const housingOlderThan2y = /logement (?:de )?plus de 2 ans|logement ancien/.test(normalizedConversation);
      const energyRenovation = /renovation energetique/.test(normalizedConversation);
      const urgency: 'declared' | 'denied' | null = /\bsans urgence\b|\bpas urgente?\b|\bnon urgente?\b/.test(normalizedConversation)
        ? 'denied'
        : /\burgen/.test(normalizedConversation)
          ? 'declared'
          : null;

      // Ciblage du CLIENT : le segment prestation (« pour le dépannage ») est écarté d'abord —
      // ses mots ne ciblent jamais un client, et un nom dit mais inconnu = refus honnête.
      const resolutionText = service !== null ? conversation.replace(service.raw, ' ') : conversation;
      const matched = matchCustomersByTokens(resolutionText, customers);
      if (matched.length === 0) {
        const knownTokens = new Set(
          customers.flatMap((customer) => significantNameWords(normalized(customer.name))),
        );
        const leftover = normalized(resolutionText)
          .split(/[^a-z0-9]+/)
          .filter(
            (word) => word.length >= 3 && !BILLING_GESTURE_WORDS.has(word) && !knownTokens.has(word) && !/^\d+$/.test(word),
          );
        if (leftover.length > 0) {
          const leftoverSet = new Set(leftover);
          const said = conversation
            .split(/[^\p{L}\p{N}-]+/u)
            .filter((word) => leftoverSet.has(normalized(word)))
            .slice(0, 4)
            .join(' ');
          return ok({
            kind: 'answer',
            intent,
            model,
            plan: ['Chercher le client dans la liste réelle'],
            card: {
              title: 'Client introuvable',
              body: `Je ne trouve pas de client « ${said.length > 0 ? said : 'ce nom'} » dans ton carnet. Rien n’a été créé — crée d’abord sa fiche (« crée le client ${said.length > 0 ? said : '…'} »), ou redis le nom exact de cette facture directe.`,
            },
          });
        }
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Demander le client de la facture directe'],
          card: {
            title: 'Pour quel client ?',
            body: `Il me manque le client de cette facture directe${amountCents !== null ? ` de ${spokenAmountLabel(amountCents)}` : ''}. Dis-le-moi (« à Mme Girard ») — rien n’a été créé.`,
          },
        });
      }
      if (matched.length > 1) {
        const options = matched.slice(0, 4);
        const followUpFor = (customer: BillableCustomer): string =>
          amountCents !== null
            ? dictatedDirectInvoiceCommand({
                amountCents,
                basis,
                customerName: customer.name,
                label: service?.label ?? null,
                vatRate,
                housingOlderThan2y,
                energyRenovation,
                urgent: urgency === 'declared',
                discount,
              })
            : `Facture directe pour ${customer.name}`;
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Lever l’ambiguïté du client'],
          card: {
            title: 'Quel client ?',
            body: `Plusieurs clients correspondent pour cette facture directe — lequel ?`,
          },
          choices: options.map((customer) => ({ label: customer.name, value: followUpFor(customer) })),
          ask: [
            askToPick({
              id: 'facture_directe.client',
              question: 'Pour quel client est cette facture directe ?',
              header: 'Client',
              items: options.map((customer) => ({
                value: customer.id,
                label: customer.name,
                followUp: followUpFor(customer),
              })),
            }),
          ],
        });
      }
      const customer = matched[0]!;
      // La prestation ne doit jamais être le nom du client capturé par « pour … ».
      const customerTokens = new Set(significantNameWords(normalized(customer.name)));
      const serviceLabel =
        service !== null
          && !normalized(service.label)
            .split(/[^a-z0-9]+/)
            .filter((word) => word.length >= 3)
            .every((word) => customerTokens.has(word))
          ? service.label
          : null;

      const command = (over: {
        basis?: 'ht' | 'ttc' | null;
        vatRate?: number | null;
        housingOlderThan2y?: boolean;
        energyRenovation?: boolean;
        urgent?: boolean;
        label?: string | null;
      } = {}): string =>
        dictatedDirectInvoiceCommand({
          amountCents: amountCents ?? 0,
          basis: over.basis !== undefined ? over.basis : basis,
          customerName: customer.name,
          label: over.label !== undefined ? over.label : serviceLabel,
          vatRate: over.vatRate !== undefined ? over.vatRate : vatRate,
          housingOlderThan2y: over.housingOlderThan2y ?? housingOlderThan2y,
          energyRenovation: over.energyRenovation ?? energyRenovation,
          urgent: over.urgent ?? (urgency === 'declared'),
          discount,
        });

      if (amountCents === null) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Demander le montant de la facture directe'],
          card: {
            title: 'Quel montant ?',
            body: `Il me manque le montant de cette facture directe pour ${customer.name}. Dis-le-moi (« 380 € HT ») — rien n’a été créé.`,
          },
        });
      }
      if (serviceLabel === null) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Demander la prestation facturée'],
          card: {
            title: 'Quelle prestation ?',
            body: `Il me manque la prestation de cette facture directe de ${spokenAmountLabel(amountCents)} pour ${customer.name}. Dis-le-moi (« pour le dépannage de la chaudière ») — le libellé figurera sur la facture. Rien n’a été créé.`,
          },
        });
      }
      if (vatRate === null) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Demander le taux de TVA (jamais deviné)'],
          card: {
            title: 'Quel taux de TVA ?',
            body: `${customer.name} · ${serviceLabel} · ${spokenAmountLabel(amountCents)} — quel taux de TVA pour cette facture directe ? Je ne le devine pas : c’est un choix fiscal.`,
          },
          choices: [
            { label: 'TVA 20 % (taux normal)', value: command({ vatRate: 20 }) },
            { label: 'TVA 10 % (logement > 2 ans)', value: command({ vatRate: 10, housingOlderThan2y: true }) },
            { label: 'TVA 5,5 % (rénov. énergétique)', value: command({ vatRate: 5.5, housingOlderThan2y: true, energyRenovation: true }) },
          ],
          ask: [
            askToPick({
              id: 'facture_directe.tva',
              question: 'Quel taux de TVA appliquer ?',
              header: 'TVA',
              items: [
                { value: '20', label: '20 %', description: 'Taux normal.', followUp: command({ vatRate: 20 }) },
                {
                  value: '10',
                  label: '10 %',
                  description: 'Travaux dans un logement achevé depuis plus de 2 ans.',
                  followUp: command({ vatRate: 10, housingOlderThan2y: true }),
                },
                {
                  value: '5.5',
                  label: '5,5 %',
                  description: 'Rénovation énergétique d’un logement de plus de 2 ans.',
                  followUp: command({ vatRate: 5.5, housingOlderThan2y: true, energyRenovation: true }),
                },
              ],
            }),
          ],
        });
      }
      // Taux réduits travaux : l'éligibilité ne se fabrique jamais en silence (suggestVatRate
      // la refuse) — la question se pose si le taux a été dicté sans son contexte.
      if ((vatRate === 10 && !housingOlderThan2y) || (vatRate === 5.5 && !(housingOlderThan2y && energyRenovation))) {
        const condition = vatRate === 10
          ? 'un logement achevé depuis plus de 2 ans'
          : 'une rénovation énergétique dans un logement de plus de 2 ans';
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier l’éligibilité au taux réduit'],
          card: {
            title: `TVA ${spokenRateLabel(vatRate)} : conditions à confirmer`,
            body: `Le taux de ${spokenRateLabel(vatRate)} suppose ${condition}. C’est le cas pour cette facture directe ?`,
          },
          choices: [
            {
              label: 'Oui — conditions remplies',
              value: command({ housingOlderThan2y: true, energyRenovation: vatRate === 5.5 ? true : energyRenovation }),
            },
            { label: 'Non — TVA 20 %', value: command({ vatRate: 20 }) },
          ],
          ask: [
            askToPick({
              id: 'facture_directe.eligibilite',
              question: `Les conditions du taux à ${spokenRateLabel(vatRate)} sont-elles remplies ?`,
              header: 'TVA',
              items: [
                {
                  value: 'oui',
                  label: 'Oui',
                  description: `${condition.charAt(0).toUpperCase()}${condition.slice(1)}.`,
                  followUp: command({ housingOlderThan2y: true, energyRenovation: vatRate === 5.5 ? true : energyRenovation }),
                },
                { value: 'non', label: 'Non — 20 %', followUp: command({ vatRate: 20 }) },
              ],
            }),
          ],
        });
      }
      if (basis === null) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Demander la base du montant (jamais devinée)'],
          card: {
            title: 'HT ou TTC ?',
            body: `${spokenAmountLabel(amountCents)} pour cette facture directe : c’est hors taxes ou toutes taxes comprises ? Je ne le devine pas.`,
          },
          choices: [
            { label: `${spokenAmountLabel(amountCents)} HT`, value: command({ basis: 'ht' }) },
            { label: `${spokenAmountLabel(amountCents)} TTC`, value: command({ basis: 'ttc' }) },
          ],
          ask: [
            askToPick({
              id: 'facture_directe.base',
              question: `${spokenAmountLabel(amountCents)}, en HT ou en TTC ?`,
              header: 'Montant',
              items: [
                { value: 'ht', label: 'HT', followUp: command({ basis: 'ht' }) },
                { value: 'ttc', label: 'TTC', followUp: command({ basis: 'ttc' }) },
              ],
            }),
          ],
        });
      }
      if (customer.type === 'b2c') {
        // A3bis — un particulier sans devis signé : SEULE l'intervention urgente à domicile
        // expressément demandée par le client ouvre la facture directe (art. L221-10, al. 2).
        if (urgency === 'denied') {
          return ok({
            kind: 'answer',
            intent,
            model,
            plan: ['Appliquer la protection du consommateur (refus honnête du domaine)'],
            card: {
              title: 'Refusé — rien n’a été créé',
              // SOURCE UNIQUE @bob/core : le même message que l'API et l'écran, jamais reformulé.
              body: STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE,
            },
            choices: [{ label: 'Faire un devis à la place', value: `Fais un devis pour ${customer.name}` }],
          });
        }
        if (urgency === null) {
          return ok({
            kind: 'answer',
            intent,
            model,
            plan: ['Qualifier l’exception d’urgence (client particulier)'],
            card: {
              title: 'Dépannage urgent demandé par le client ?',
              body: `${customer.name} est un particulier : une facture directe sans devis signé n’est possible que pour une intervention urgente à domicile expressément demandée par le client (art. L221-10, al. 2 du code de la consommation). C’était le cas ?`,
            },
            choices: [
              { label: 'Oui — intervention urgente demandée', value: command({ urgent: true }) },
              { label: 'Non', value: `${command({ urgent: false })} — sans urgence` },
            ],
            ask: [
              askToPick({
                id: 'facture_directe.urgence',
                question: 'L’intervention était-elle urgente et demandée par le client ?',
                header: 'Urgence',
                items: [
                  {
                    value: 'oui',
                    label: 'Oui',
                    description: 'Dépannage urgent à domicile, expressément sollicité par le client.',
                    followUp: command({ urgent: true }),
                  },
                  {
                    value: 'non',
                    label: 'Non',
                    description: 'Hors urgence, le devis signé reste le chemin.',
                    followUp: `${command({ urgent: false })} — sans urgence`,
                  },
                ],
              }),
            ],
          });
        }
      }

      // PR-08 — SITE dicté (« chez Carrefour Vitry », « sur le site Bastille ») : résolution
      // contre la liste RÉELLE des chantiers ouverts (mêmes cibles que classer_document —
      // jamais un id inventé). Capacité optionnelle : sans elle, la pièce naît hors site.
      let chantierRef: { id: string; nom: string } | null = null;
      const listDestinations = this.deps.actions.listFilingDestinations?.bind(this.deps.actions);
      if (listDestinations) {
        const destinations = await listDestinations();
        if (destinations.ok) {
          const resolution = resolveSpokenChantier({
            conversation,
            chantiers: destinations.value.chantiers,
            customerName: customer.name,
          });
          if (resolution.matched.length === 1) {
            chantierRef = resolution.matched[0]!;
          } else if (resolution.matched.length > 1) {
            // Plusieurs sites correspondent : question ciblée — le followUp REDIT la commande
            // complète avec le site choisi (le prochain tour matche un seul chantier).
            const options = resolution.matched.slice(0, 4);
            return ok({
              kind: 'answer',
              intent,
              model,
              plan: ['Lever l’ambiguïté du site'],
              card: {
                title: 'Quel site ?',
                body: `Plusieurs sites correspondent pour cette facture directe — lequel ?`,
              },
              choices: options.map((chantier) => ({
                label: chantier.nom,
                value: `${command({})} sur le site ${chantier.nom}`,
              })),
              ask: [
                askToPick({
                  id: 'facture_directe.site',
                  question: 'Sur quel site est cette facture directe ?',
                  header: 'Site',
                  items: options.map((chantier) => ({
                    value: chantier.id,
                    label: chantier.nom,
                    followUp: `${command({})} sur le site ${chantier.nom}`,
                  })),
                }),
              ],
            });
          } else if (resolution.explicit) {
            // Site NOMMÉ mais introuvable dans la liste réelle : refus honnête —
            // Bob n'invente jamais un site (anti-hallucination), rien n'est créé.
            return ok({
              kind: 'answer',
              intent,
              model,
              plan: ['Vérifier le site contre la liste réelle'],
              card: {
                title: 'Site introuvable',
                body: 'Je ne trouve aucun site ouvert correspondant à ce que tu m’as dit. Rien n’a été créé — redis le nom exact du site, ou continue sans site.',
              },
            });
          }
        }
      }

      // Base HT de la ligne : dictée HT telle quelle ; dictée TTC convertie au taux confirmé —
      // les totaux exacts (TTC, net à payer) restent calculés par le DOMAINE à la création.
      const unitPriceHT = basis === 'ht' ? amountCents : Math.round(amountCents / (1 + vatRate / 100));
      const lineLabel = serviceLabel.charAt(0).toUpperCase() + serviceLabel.slice(1);
      const args = {
        customerId: customer.id,
        lines: [{ label: lineLabel, category: 'labor', qty: 1, unitPriceHT, vatRate }],
        ...(discount !== null ? { globalDiscount: discount } : {}),
        ...(housingOlderThan2y || energyRenovation
          ? {
              context: {
                ...(housingOlderThan2y ? { housingOlderThan2y: true } : {}),
                ...(energyRenovation ? { energyRenovation: true } : {}),
              },
            }
          : {}),
        ...(customer.type === 'b2c' && urgency === 'declared' ? { urgentOnSiteRepair: true } : {}),
        ...(chantierRef !== null ? { chantierId: chantierRef.id } : {}),
      };
      const parsed = tool.parse(args);
      if (!parsed.ok) return err(parsed.error);
      const discountNote =
        discount !== null
          ? discount.type === 'percent'
            ? `, remise ${String(discount.value).replace('.', ',')} %`
            : `, remise ${formatEUR(discount.cents)}`
          : '';
      const urgentNote = customer.type === 'b2c' && urgency === 'declared' ? ' · intervention urgente demandée par le client' : '';
      const basisNote = basis === 'ttc' ? ` (${spokenAmountLabel(amountCents)} TTC dit)` : '';
      const siteNote = chantierRef !== null ? ` · site ${chantierRef.nom}` : '';
      const label = `Facture directe ${customer.name} — ${lineLabel} · ${formatEUR(unitPriceHT)} HT, TVA ${spokenRateLabel(vatRate)}${discountNote}${basisNote}${urgentNote}${siteNote}`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Identifier le client', 'Contrôler montant, TVA et qualification', 'Attendre ta confirmation'],
          card: {
            title: 'Facture directe à confirmer',
            body: `${label}.\nJe la crée en brouillon (sans devis signé) — l’émission restera un geste séparé. Je confirme ?`,
          },
          pending: { tool: tool.name, args, label },
          spokenPrompt: buildSpokenConfirmation(label),
        });
      }
      const run = await tool.run(parsed.value);
      if (!run.ok) {
        // Gardes du domaine (B6 pro étranger, A3bis urgence, TVA non applicable) : restitution
        // VERBATIM — mêmes messages que l'UI, jamais un code technique brut.
        const guard = domainGuardCard(run.error);
        if (guard) {
          return ok({ kind: 'answer', intent, model, plan: ['Restituer le refus du domaine'], card: guard });
        }
        return err(run.error);
      }
      // Sortie brute de l'outil (AnyTool) : lecture STRICTE du total — le montant annoncé est
      // celui du DOMAINE ou rien, jamais un chiffre reconstruit.
      const output = run.value as { totalTtcCents?: unknown };
      const totalTtc = typeof output?.totalTtcCents === 'number' ? output.totalTtcCents : null;
      return ok({
        kind: 'done',
        intent,
        model,
        plan: ['Créer la facture directe'],
        card: {
          title: 'Facture directe créée ✓',
          body: `${label}${totalTtc !== null ? ` — total ${formatEUR(totalTtc)} TTC (calcul du domaine)` : ''}. Brouillon créé, à émettre quand tu veux.`,
        },
      });
    }

    if (intent === 'conditions_paiement') {
      // B4 — CONDITIONS DE PAIEMENT propres au client (« Durand paie à 45 jours fin de
      // mois ») : MÊME chemin UpdateCustomer que la fiche client. Le plafond légal L441-10
      // (pro : 60 j / 45 j fin de mois) est jugé par le MÊME service pur que le domaine
      // (validateProPaymentTermsCeiling @bob/core) — refus restitué verbatim, jamais contourné.
      const setTerms = this.deps.actions.setCustomerPaymentTerms?.bind(this.deps.actions);
      const listCustomers = this.deps.actions.listBillableCustomers?.bind(this.deps.actions);
      const tool = this.tool('definir_conditions_paiement');
      if (!setTerms || !listCustomers || !tool) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Vérifier la capacité de l’hôte'],
          card: {
            title: 'Conditions de paiement',
            body: 'Je ne peux pas modifier les conditions de paiement d’un client sur cet appareil. Rien n’a été modifié — passe par la fiche client.',
          },
        });
      }
      const conversation = [
        ...(history ?? []).slice(-4).filter((turn) => turn.role === 'user').map((turn) => turn.text),
        message,
        reference ?? '',
      ].join(' ');
      const normalizedConversation = normalized(conversation);
      const customersResult = await listCustomers();
      if (!customersResult.ok) return err(customersResult.error);
      const customers = customersResult.value;
      const daysMatch = /(\d{1,3})\s*jours?\b/.exec(normalizedConversation);
      const days = daysMatch?.[1] !== undefined ? Number(daysMatch[1]) : null;
      const endOfMonth = /fin de mois/.test(normalizedConversation);

      const matched = matchCustomersByTokens(conversation, customers);
      if (matched.length !== 1) {
        const options = matched.length > 1 ? matched.slice(0, 4) : customers.slice(0, 4);
        const followUpFor = (customer: BillableCustomer): string =>
          days !== null
            ? paymentTermsCommand(customer.name, days, endOfMonth)
            : `Conditions de paiement du client ${customer.name}`;
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: [matched.length > 1 ? 'Lever l’ambiguïté du client' : 'Demander le client concerné'],
          card: {
            title: 'Quel client ?',
            body:
              matched.length > 1
                ? 'Plusieurs clients correspondent — pour lequel changer les conditions de paiement ?'
                : `Pour quel client poser ces conditions de paiement${days !== null ? ` (${days} jours${endOfMonth ? ' fin de mois' : ''})` : ''} ? Rien n’a été modifié.`,
          },
          choices: options.map((customer) => ({ label: customer.name, value: followUpFor(customer) })),
          ...(options.length >= 2
            ? {
                ask: [
                  askToPick({
                    id: 'conditions_paiement.client',
                    question: 'Pour quel client poser ces conditions de paiement ?',
                    header: 'Client',
                    items: options.map((customer) => ({
                      value: customer.id,
                      label: customer.name,
                      followUp: followUpFor(customer),
                    })),
                  }),
                ],
              }
            : {}),
        });
      }
      const customer = matched[0]!;
      if (days === null) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Demander le délai en jours'],
          card: {
            title: 'Quel délai ?',
            body: `Quelles conditions de paiement pour ${customer.name} ? Dis-moi un délai en jours (« ${paymentTermsCommand(customer.name, 45, true)} »). Rien n’a été modifié.`,
          },
        });
      }
      // Plafond légal L441-10 (débiteur professionnel) : MÊME service pur que le domaine —
      // refus AVANT toute proposition, message verbatim + les maxima légaux en choix.
      const ceiling = validateProPaymentTermsCeiling(customer.type, { days, endOfMonth });
      if (!ceiling.ok) {
        const ceilingMessage = 'message' in ceiling.error ? ceiling.error.message : 'Délai de paiement hors plafond légal.';
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: ['Appliquer le plafond légal L441-10 (refus honnête du domaine)'],
          card: { title: 'Refusé — rien n’a été modifié', body: ceilingMessage },
          choices: [
            { label: '60 jours (plafond légal)', value: paymentTermsCommand(customer.name, 60, false) },
            { label: '45 jours fin de mois', value: paymentTermsCommand(customer.name, 45, true) },
          ],
        });
      }
      const label = paymentTermsLabel(days, endOfMonth);
      const args = { customerId: customer.id, days, endOfMonth, label };
      const parsed = tool.parse(args);
      if (!parsed.ok) return err(parsed.error);
      // b2g : conseil honnête (délai réglementaire de la commande publique) — jamais un blocage
      // inventé (le domaine ne bloque pas ; art. R2192-10 du code de la commande publique).
      const publicNote =
        customer.type === 'b2g' && days > 30
          ? ' NB acheteur public : le délai réglementaire de paiement est de 30 jours (art. R2192-10 du code de la commande publique).'
          : '';
      const actionLabel = `Conditions de paiement de ${customer.name} : ${label}`;
      if (requiresConfirmation(tool, autonomy)) {
        return ok({
          kind: 'proposed',
          intent,
          model,
          plan: ['Identifier le client', 'Contrôler le plafond légal', 'Attendre ta confirmation'],
          card: {
            title: 'Conditions de paiement à confirmer',
            body: `${actionLabel}. Elles s’appliqueront à l’échéance des prochaines factures émises pour ce client — les factures déjà émises ne changent pas.${publicNote} Je confirme ?`,
          },
          pending: { tool: tool.name, args, label: actionLabel },
          spokenPrompt: buildSpokenConfirmation(actionLabel),
        });
      }
      const run = await tool.run(parsed.value);
      if (!run.ok) {
        const guard = domainGuardCard(run.error);
        if (guard) {
          return ok({ kind: 'answer', intent, model, plan: ['Restituer le refus du domaine'], card: guard });
        }
        return err(run.error);
      }
      return ok({
        kind: 'done',
        intent,
        model,
        plan: ['Enregistrer les conditions de paiement'],
        card: { title: 'Conditions enregistrées ✓', body: `${actionLabel} — c’est noté pour les prochaines factures.` },
      });
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
      const depositAvailable = quote.depositAvailable !== false;
      const depositUnavailableReason =
        quote.depositUnavailableReason ?? PROFESSIONAL_ADVANCE_RECOVERY_UNAVAILABLE_MESSAGE;

      // Repli acompte pro (décision fondateur 25/07) : là où l'acompte fermé aurait été
      // proposé, l'ÉQUIVALENT conforme — « Situation n°1 (30 %) » (même encaissement, pièces
      // justes), via la commande canonique facturer_situation (montant toujours modifiable).
      // FAIL-CLOSED comme le Sheet mobile (deriveProfessionalAdvanceFallback) : devis sans
      // acompte porté, acompte déjà facturé ou situation déjà vivante (situationInvoiced
      // absent/true) = pas d'option numérotée.
      const advanceFallbackOffered =
        quote.depositPct !== null && !quote.depositInvoiced && quote.situationInvoiced === false;
      const advanceFallbackChip = {
        label: `Situation n°1 (${ADVANCE_FALLBACK_PERCENT} %)`,
        value: situationCommand(displayRef(quote), { percent: ADVANCE_FALLBACK_PERCENT }),
      };
      const advanceFallbackNote = ` L’équivalent conforme existe : la première situation de travaux — ${ADVANCE_FALLBACK_PERCENT} % du marché par défaut, même encaissement, pièces justes (le pourcentage reste ton choix).`;

      // La liste vient du même use case que l'écran : Bob ne propose jamais un acompte
      // professionnel que le domaine refusera ensuite, ni une finale après un ancien acompte.
      if (!depositAvailable && (mode === 'deposit' || quote.depositInvoiced)) {
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: [
            'Vérifier la disponibilité du parcours acompte',
            'Expliquer la fermeture sans créer de brouillon',
            ...(advanceFallbackOffered ? ['Proposer l’équivalent conforme : la situation n°1'] : []),
          ],
          card: {
            title: 'Parcours acompte indisponible',
            body: `${depositUnavailableReason}${advanceFallbackOffered ? advanceFallbackNote : ''}`,
          },
          ...(advanceFallbackOffered ? { choices: [advanceFallbackChip] } : {}),
        });
      }

      // A3 — gel de rétractation B2C : la facture FINALE est légalement bloquée pendant le
      // délai de 14 jours (art. L221-18 s. c. conso) tant que le client n'a pas demandé
      // l'exécution anticipée (art. L221-25). Bob l'annonce HONNÊTEMENT — pourquoi, jusqu'à
      // quand, ce qui reste possible — au lieu de proposer une finale vouée au refus du
      // domaine (GenerateInvoiceFromQuote renverrait RETRACTATION_PERIOD_ACTIVE). Le message
      // vient de la SOURCE UNIQUE @bob/core (retractationFreezeMessage) ; seul l'ACOMPTE,
      // jamais gelé, reste proposé quand le devis en prévoit un non encore facturé.
      const finalBlockedUntil = quote.finalBlockedUntil ?? null;
      if (finalBlockedUntil !== null && mode !== 'deposit') {
        const ref = displayRef(quote);
        const depositPossible =
          depositAvailable && quote.depositPct !== null && !quote.depositInvoiced;
        return ok({
          kind: 'answer',
          intent,
          model,
          plan: [
            'Identifier le devis signé',
            'Vérifier le délai légal de rétractation (14 jours, client particulier)',
            'Expliquer honnêtement le gel et la date de déblocage',
          ],
          card: {
            title: 'Facture finale : pas encore possible',
            body: `Devis ${ref} (${quote.customerName}) — ${retractationFreezeMessage(finalBlockedUntil)}`,
          },
          ...(depositPossible
            ? {
                choices: [
                  {
                    label: `Facture d'acompte (${quote.depositPct} %)`,
                    value: `Fais la facture d'acompte du devis ${ref}`,
                  },
                ],
              }
            : {}),
        });
      }

      if (mode === null) {
        if (quote.depositPct !== null && !quote.depositInvoiced) {
          if (!depositAvailable) {
            const ref = displayRef(quote);
            return ok({
              kind: 'answer',
              intent,
              model,
              plan: [
                'Identifier le devis signé',
                'Expliquer la fermeture du parcours acompte',
                ...(advanceFallbackOffered ? ['Proposer l’équivalent conforme : la situation n°1'] : []),
                'Laisser choisir explicitement une finale',
              ],
              card: {
                title: 'Acompte indisponible pour ce client',
                body: `${depositUnavailableReason}${advanceFallbackOffered ? advanceFallbackNote : ''} Tu peux aussi préparer une facture finale sans reprise d'acompte quand le chantier le permet.`,
              },
              // Le repli occupe la PLACE de l'acompte fermé (doctrine du Sheet mobile) : la
              // situation n°1 d'abord, la finale ensuite.
              choices: [
                ...(advanceFallbackOffered ? [advanceFallbackChip] : []),
                { label: 'Facture finale', value: `Fais la facture finale du devis ${ref}` },
              ],
              ...(advanceFallbackOffered
                ? {
                    ask: [
                      {
                        id: 'generer_facture.acompte_indisponible',
                        question: `L'acompte est fermé pour ce client — comment facturer le devis ${ref} (${quote.customerName}) ?`,
                        header: 'Facturation',
                        options: [
                          {
                            value: 'situation1',
                            label: `Situation n°1 (${ADVANCE_FALLBACK_PERCENT} %)`,
                            description: 'L’équivalent conforme de l’acompte pro : même encaissement, pièces justes — pourcentage modifiable.',
                            followUp: advanceFallbackChip.value,
                          },
                          {
                            value: 'final',
                            label: 'Facture finale',
                            description: `Tout le chantier en une fois (${formatEUR(quote.totalTtcCents)} TTC).`,
                            followUp: `Fais la facture finale du devis ${ref}`,
                          },
                        ],
                      },
                    ],
                  }
                : {}),
            });
          }
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
    // Chargées pour l'encaissement, l'envoi/la transmission d'une facture émise (PR-01/PR-02)
    // et pour une relance CIBLÉE (C25 ① — « puis relance Martin »).
    if (
      steps.some(
        (s) =>
          s.intent === 'encaisser'
          || s.intent === 'envoyer_facture'
          || s.intent === 'declarer_transmission'
          || (s.intent === 'relance' && s.reference !== null),
      )
    ) {
      const r = await this.deps.actions.listPayableInvoices();
      if (!r.ok) return err(r.error);
      payables = r.value;
    }
    let sendableQuotes: SendableQuote[] = [];
    if (steps.some((s) => s.intent === 'envoyer_devis' || s.intent === 'relance_devis')) {
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
    const ambiguousIssueIds = new Set(
      steps
        .filter((step) => step.intent === 'emettre_facture')
        .map((step) => resolveDocumentTarget({
          message: step.reference ?? '',
          reference: step.reference,
          documents: issuableInvoices,
          ...(context !== undefined ? { context } : {}),
          type: 'invoice',
          capability: 'invoice.issue',
        }).target)
        .filter((invoice): invoice is IssuableInvoice =>
          invoice !== null && invoice.operationCategoryRequired)
        .map((invoice) => invoice.id),
    );
    const actions: BatchItem[] = [];
    // AVEU des étapes hors lot : une intention comprise mais impossible à mettre en lot n'est
    // JAMAIS écartée en silence — le lot l'annonce et invite à la redire séparément.
    const unbatchable: BobIntent[] = [];
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
        const scopedCategoryRequired = ambiguousIssueIds.size > 1;
        const operationCategory = invoice.operationCategoryRequired
          ? scopedCategoryRequired
            ? extractScopedFrenchOperationCategory(message, displayRef(invoice))
            : extractFrenchOperationCategory(message)
          : null;
        if (invoice.operationCategoryRequired && operationCategory === null) {
          const ref = displayRef(invoice);
          const question = frenchOperationCategoryQuestion({
            id: 'plan.emettre_facture.operationCategory',
            invoiceRef: ref,
            customerName: invoice.customerName,
            commandPrefix: message,
            scoped: scopedCategoryRequired,
          });
          return ok({
            kind: 'answer',
            intent: 'emettre_facture',
            model,
            plan: ['Lever la qualification fiscale avant de préparer le lot'],
            card: {
              title: 'Lot en attente',
              body:
                `La facture ${ref} exige la nature principale de l’opération avant que je prépare le lot. `
                + 'Rien n’a été exécuté.',
            },
            choices: question.options.map((option) => ({
              label: option.label,
              value: option.followUp,
            })),
            ask: [question],
          });
        }
        issuableInvoices = issuableInvoices.filter((i) => i.id !== invoice.id);
        actions.push({
          tool: 'emettre_facture',
          args: {
            invoiceId: invoice.id,
            ...(operationCategory === null ? {} : { operationCategory }),
          },
          label: `Émettre la facture ${displayRef(invoice)} pour ${invoice.customerName}`,
        });
      } else if (step.intent === 'envoyer_facture') {
        // PR-01 — l'envoi réel d'une facture émise entre dans le lot : même résolution que
        // l'encaissement, outil sortant (le plancher force la confirmation globale du lot).
        const tool = this.tool('envoyer_facture');
        if (!tool) {
          return ok({
            kind: 'answer',
            intent: step.intent,
            model,
            plan: ['Vérifier la capacité de l’hôte'],
            card: {
              title: 'Lot interrompu',
              body: 'Je ne peux pas envoyer de facture depuis cet appareil. Rien n’a été exécuté.',
            },
          });
        }
        const resolved = resolveInvoiceTarget({
          message: step.reference ?? '',
          reference: step.reference,
          invoices: payables,
          ...(context !== undefined ? { context } : {}),
          capability: 'invoice.read',
        });
        const inv = resolved.target;
        if (!inv) {
          const options = [...resolved.choices];
          const body = unresolvedTargetBody({
            ...(resolved.unactionableLabel !== undefined ? { unactionableLabel: resolved.unactionableLabel } : {}),
            hasOptions: options.length > 0,
            ask: 'Précise la facture à envoyer :',
            empty: 'Aucune facture émise en attente — rien à envoyer.',
          });
          return ok({
            kind: 'answer',
            intent: step.intent,
            model,
            plan: ['Lever l’ambiguïté'],
            card: { title: 'Quelle facture ?', body },
            choices: options.map((i) => ({ label: `${i.number} — ${i.customerName} · ${formatEUR(i.remainingCents)}`, value: `Envoie la facture ${i.number}` })),
            ...(options.length
              ? {
                  ask: [
                    askToPick({
                      id: 'plan.envoyer_facture.cible',
                      question: 'Quelle facture veux-tu envoyer au client ?',
                      header: 'Facture',
                      items: options.map((i) => ({
                        value: i.number,
                        label: i.number,
                        description: `${i.customerName} · reste ${formatEUR(i.remainingCents)}`,
                        followUp: `Envoie la facture ${i.number}`,
                      })),
                    }),
                  ],
                }
              : {}),
          });
        }
        actions.push({
          tool: 'envoyer_facture',
          args: { invoiceId: inv.id },
          label: `Envoyer la facture ${inv.number} à ${inv.customerName}`,
        });
      } else if (step.intent === 'declarer_transmission') {
        // PR-02 — la transmission déclarée entre dans le lot : la date vient du MESSAGE
        // (jamais devinée) ; sans date dite, le lot s'arrête AVANT toute exécution.
        const tool = this.tool('marquer_facture_transmise');
        if (!tool) {
          return ok({
            kind: 'answer',
            intent: step.intent,
            model,
            plan: ['Vérifier la capacité de l’hôte'],
            card: {
              title: 'Lot interrompu',
              body: 'Je ne peux pas noter de transmission sur cet appareil. Rien n’a été exécuté.',
            },
          });
        }
        const resolved = resolveInvoiceTarget({
          message: step.reference ?? '',
          reference: step.reference,
          invoices: payables,
          ...(context !== undefined ? { context } : {}),
          capability: 'invoice.read',
        });
        const inv = resolved.target;
        if (!inv) {
          const options = [...resolved.choices];
          const body = unresolvedTargetBody({
            ...(resolved.unactionableLabel !== undefined ? { unactionableLabel: resolved.unactionableLabel } : {}),
            hasOptions: options.length > 0,
            ask: 'Précise la facture transmise :',
            empty: 'Aucune facture émise en attente — rien à noter.',
          });
          return ok({
            kind: 'answer',
            intent: step.intent,
            model,
            plan: ['Lever l’ambiguïté'],
            card: { title: 'Quelle facture ?', body },
            choices: options.map((i) => ({ label: `${i.number} — ${i.customerName} · ${formatEUR(i.remainingCents)}`, value: `J’ai déposé la facture ${i.number} sur le portail` })),
            ...(options.length
              ? {
                  ask: [
                    askToPick({
                      id: 'plan.declarer_transmission.cible',
                      question: 'Quelle facture as-tu transmise à ton client ?',
                      header: 'Facture',
                      items: options.map((i) => ({
                        value: i.number,
                        label: i.number,
                        description: `${i.customerName} · reste ${formatEUR(i.remainingCents)}`,
                        followUp: `J’ai déposé la facture ${i.number} sur le portail`,
                      })),
                    }),
                  ],
                }
              : {}),
          });
        }
        const now = this.deps.runtime?.clock.now();
        const today = now && /^\d{4}-\d{2}-\d{2}T/.test(now) ? parisDateOnly(now) : null;
        const saidDate = parseExpensePaymentDetails(message, today).paidOn;
        if (!saidDate || (today !== null && saidDate > today)) {
          return ok({
            kind: 'answer',
            intent: step.intent,
            model,
            plan: ['Demander la date réelle avant de préparer le lot'],
            card: {
              title: 'Lot en attente',
              body:
                `Il me faut la date réelle de transmission de la facture ${inv.number} (JJ/MM/AAAA, « hier », « aujourd’hui ») — je ne la devine pas. `
                + 'Rien n’a été exécuté.',
            },
          });
        }
        const isAcceptance = /\baccept/.test(normalized(`${message} ${step.reference ?? ''}`));
        actions.push({
          tool: 'marquer_facture_transmise',
          args: {
            invoiceId: inv.id,
            ...(isAcceptance ? { acceptedAt: saidDate } : { depositedAt: saidDate }),
          },
          label: isAcceptance
            ? `Noter la facture ${inv.number} acceptée le ${frDate(saidDate)} (${inv.customerName})`
            : `Noter la facture ${inv.number} transmise le ${frDate(saidDate)} (${inv.customerName})`,
        });
      } else if (step.intent === 'payout') {
        actions.push({ tool: 'tresorerie_versement', args: {}, label: 'Calculer ta trésorerie mobilisable' });
      } else if (step.intent === 'relance') {
        // Cible explicite uniquement (numéro / nom) — sinon l'hôte prend la plus urgente du plan.
        const target = step.reference ? resolveInvoice(step.reference, payables, { fallbackToSingle: false }) : null;
        const sendTool = this.tool('envoyer_relance');
        // Symétrie avec le flux mono-étape : cible EXPLICITE + capacité d'envoi → l'ENVOI réel
        // entre dans le lot (plancher sortant : la confirmation globale reste obligatoire).
        // Sans cible, le brouillon par défaut reste le comportement (jamais un envoi deviné).
        if (target && sendTool) {
          actions.push({
            tool: 'envoyer_relance',
            args: { invoiceId: target.id },
            label: `Envoyer la relance de ${target.number} à ${target.customerName} (reste dû ${formatEUR(target.remainingCents)})`,
          });
        } else {
          actions.push(
            target
              ? {
                  tool: 'relance_brouillon',
                  args: { invoiceId: target.id },
                  label: `Préparer la relance de ${target.number} (${target.customerName})`,
                }
              : { tool: 'relance_brouillon', args: {}, label: 'Préparer une relance' },
          );
        }
      } else if (step.intent === 'relance_devis' && this.tool('relance_devis')) {
        // PR-05 — gated sur la capacité de l'hôte (outil optionnel) ; cible explicite requise
        // dans un lot (jamais un devis deviné parmi plusieurs).
        const awaiting = sendableQuotes.filter((q) => q.status === 'sent' || q.status === 'viewed');
        const resolved = resolveDocumentTarget({
          message: step.reference ?? '',
          reference: step.reference,
          documents: awaiting,
          ...(context !== undefined ? { context } : {}),
          type: 'quote',
          capability: 'quote.read',
        });
        const quote = resolved.target;
        if (!quote) {
          const options = [...resolved.choices];
          const body = unresolvedTargetBody({
            ...(resolved.unactionableLabel !== undefined ? { unactionableLabel: resolved.unactionableLabel } : {}),
            hasOptions: options.length > 0,
            ask: 'Précise le devis à relancer :',
            empty: 'Aucun devis envoyé en attente de réponse.',
          });
          return ok({
            kind: 'answer',
            intent: step.intent,
            model,
            plan: ['Lever l’ambiguïté'],
            card: { title: 'Quel devis ?', body },
            choices: options.map((q) => ({ label: `${displayRef(q)} — ${q.customerName} · ${formatEUR(q.totalTtcCents)}`, value: `Relance le devis ${displayRef(q)}` })),
            ...(options.length
              ? {
                  ask: [
                    askToPick({
                      id: 'plan.relance_devis.cible',
                      question: 'Quel devis veux-tu relancer ?',
                      header: 'Devis',
                      items: options.map((q) => ({
                        value: displayRef(q),
                        label: displayRef(q),
                        description: `${q.customerName} · ${formatEUR(q.totalTtcCents)}`,
                        followUp: `Relance le devis ${displayRef(q)}`,
                      })),
                    }),
                  ],
                }
              : {}),
          });
        }
        actions.push({
          tool: 'relance_devis',
          args: { quoteId: quote.id },
          label: `Préparer la relance du devis ${displayRef(quote)} (${quote.customerName})`,
        });
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
        // Gated sur la capacité de l'hôte (outil optionnel C-EXP5b).
        actions.push({ tool: 'echeances_fiscales', args: {}, label: 'Lister tes échéances fiscales' });
      } else {
        unbatchable.push(step.intent);
      }
    }
    if (actions.length === 0) return ok(this.unknownRun(model));

    // L'aveu honnête : le lot dit ce qu'il N'exécutera PAS, au lieu d'amputer la consigne.
    const unbatchableNote =
      unbatchable.length > 0
        ? `\n⚠ ${unbatchable.length} étape${unbatchable.length > 1 ? 's' : ''} de ta demande ne ${unbatchable.length > 1 ? 'savent' : 'sait'} pas encore entrer dans un lot — redis-l${unbatchable.length > 1 ? 'es' : 'a'} séparément après.`
        : '';
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
        card: { title: `${actions.length} actions à confirmer`, body: `Je vais :\n${listing}${unbatchableNote}\nJe valide tout ?` },
        pending: { tool: 'batch', args: {}, label: listing, batch: actions },
        spokenPrompt: buildSpokenConfirmation(`${actions.length} actions : ${actions.map((a) => a.label).join(', ')}`),
      });
    }
    const r = await this.runBatch(actions);
    if (!r.ok) return err(r.error);
    return ok({ kind: 'done', intent: headIntent, model, plan: actions.map((a) => a.label), card: { title: 'Fait ✓', body: `${r.value}${unbatchableNote}` } });
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
        const updatedCount = notificationUpdatedCount(run.value);
        if (updatedCount === null) {
          return err({
            kind: 'dependency',
            port: 'notifications',
            cause: 'Résultat de mutation invalide.',
          });
        }
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
    if (!run.ok) {
      // Une confirmation qui frappe une ligne historique sans preuve (état changé entre la
      // proposition et l'exécution) reçoit la même orientation que le flux direct.
      if (pending.tool === 'enregistrer_reglement_depense' && isLegacyExpensePaymentConflict(run.error)) {
        return ok({
          kind: 'answer',
          intent: intentForTool(pending.tool),
          model,
          plan: ['Détecter une ligne historique sans preuve', 'Orienter vers la régularisation'],
          card: legacyExpenseGuidanceCard(),
        });
      }
      // Garde anti-écrasement du domaine (DOCUMENT_ALREADY_LINKED) : l'état a pu changer entre
      // la proposition et la confirmation — même réponse honnête que le flux direct, jamais le
      // message technique brut.
      if (pending.tool === 'classer_document') {
        const existing = documentAlreadyLinkedTarget(run.error);
        if (existing) {
          return ok({
            kind: 'answer',
            intent: intentForTool(pending.tool),
            model,
            plan: ['Détecter un lien métier existant'],
            card: alreadyLinkedCard(existing),
          });
        }
      }
      // PR-04 — refus « BC obligatoire » à la confirmation (l'état a pu changer, ou la garde
      // vient d'être découverte) : jamais une erreur brute — le parcours de rattrapage réel
      // (saisir le BC d'abord, l'override responsabilisé en second), comme à l'écran.
      if (pending.tool === 'emettre_facture') {
        const po = purchaseOrderRequiredDetails(run.error);
        if (po) {
          const rawInvoiceId = pending.args.invoiceId;
          return ok(
            purchaseOrderRequiredRun({
              model,
              invoiceRef: typeof rawInvoiceId === 'string' ? rawInvoiceId : 'brouillon',
              details: po,
            }),
          );
        }
      }
      // BT-23 — l'état a pu changer entre proposition et confirmation, ou un ancien hôte a pu
      // omettre le pré-calcul. Le refus autoritaire redevient LA même question structurée ;
      // aucune seconde mutation n'est tentée et aucune catégorie n'est inventée.
      if (
        pending.tool === 'emettre_facture'
        && isFrenchOperationCategoryRequiredError(run.error)
      ) {
        const rawInvoiceId = pending.args.invoiceId;
        const invoiceRef = typeof rawInvoiceId === 'string' ? rawInvoiceId : 'brouillon';
        const question = frenchOperationCategoryQuestion({
          id: 'emettre_facture.operationCategory',
          invoiceRef,
          commandPrefix: `Émets la facture ${invoiceRef}`,
          scoped: false,
        });
        return ok({
          kind: 'answer',
          intent: 'emettre_facture',
          model,
          plan: ['Relire le refus fiscal autoritaire', 'Demander la nature manquante'],
          card: {
            title: 'Nature de l’opération',
            body:
              'La facture a besoin de sa nature principale avant émission. '
              + 'Elle n’a pas été émise.',
          },
          choices: question.options.map((option) => ({
            label: option.label,
            value: option.followUp,
          })),
          ask: [question],
        });
      }
      // B1/B2/B4 — gardes du domaine (pro étranger B6, urgence b2c A3bis, cumul de situations,
      // plafond L441-10) : l'état a pu changer entre la proposition et la confirmation — le
      // MESSAGE DU DOMAINE est restitué verbatim (mêmes messages que l'UI), jamais un code brut.
      if (FACTURATION_TERRAIN_TOOLS.has(pending.tool)) {
        const guard = domainGuardCard(run.error);
        if (guard) {
          return ok({
            kind: 'answer',
            intent: intentForTool(pending.tool),
            model,
            plan: ['Restituer le refus du domaine'],
            card: guard,
          });
        }
      }
      return err(run.error);
    }
    if (pending.tool === 'marquer_notifications_lues') {
      const updatedCount = notificationUpdatedCount(run.value);
      if (updatedCount === null) {
        return err({
          kind: 'dependency',
          port: 'notifications',
          cause: 'Résultat de mutation invalide.',
        });
      }
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
    // M2 — l'envoi confirmé d'une relance mérite sa carte : l'artisan sait que c'est PARTI.
    if (pending.tool === 'envoyer_relance') {
      return ok({
        kind: 'done',
        intent: 'relance',
        model,
        plan: ['Envoyer la relance confirmée'],
        card: { title: 'Relance envoyée ✓', body: `${pending.label} — c’est parti.` },
      });
    }
    // PR-01 — l'envoi confirmé d'une facture : l'artisan sait que l'e-mail est PARTI.
    if (pending.tool === 'envoyer_facture') {
      return ok({
        kind: 'done',
        intent: 'envoyer_facture',
        model,
        plan: ['Envoyer la facture confirmée'],
        card: { title: 'Facture envoyée ✓', body: `${pending.label} — c’est parti (lien de consultation + PDF joint).` },
      });
    }
    // PR-02 — la transmission déclarée confirmée : le suivi (rappel J+2, carte Encaissement)
    // est soldé, rien n'est parti vers le client.
    if (pending.tool === 'marquer_facture_transmise') {
      return ok({
        kind: 'done',
        intent: 'declarer_transmission',
        model,
        plan: ['Noter la transmission confirmée'],
        card: { title: 'Transmission notée ✓', body: `${pending.label} — le suivi est à jour. Rien n’a été envoyé au client.` },
      });
    }
    // PR-06 — la bascule confirmée des relances automatiques annonce l'état RÉEL retourné.
    if (pending.tool === 'regler_relances_auto') {
      const enabled = (run.value as { relanceAutoEnabled?: unknown }).relanceAutoEnabled === true;
      return ok({
        kind: 'done',
        intent: 'cadence_relances',
        model,
        plan: ['Basculer les relances automatiques'],
        card: {
          title: enabled ? 'Relances automatiques activées ✓' : 'Relances automatiques coupées ✓',
          body: enabled
            ? `${pending.label} — c’est fait. Les relances repartiront au rythme de ta cadence ; la mise en demeure reste soumise à ta validation.`
            : `${pending.label} — c’est fait. Plus aucune relance ne partira toute seule ; la relance manuelle reste possible.`,
        },
      });
    }
    // PR-01 — ENCHAÎNEMENT naturel après l'émission confirmée : l'écran affiche le bouton
    // d'envoi au même moment — la voix propose le même geste (commande canonique verbatim,
    // flux envoyer_facture existant, confirmé). Jamais un envoi silencieux.
    if (pending.tool === 'emettre_facture') {
      const number = (run.value as { number?: unknown }).number;
      const numberRef = typeof number === 'string' && number.length > 0 ? number : null;
      const sendable = numberRef !== null && this.tool('envoyer_facture') !== undefined;
      return ok({
        kind: 'done',
        intent: 'emettre_facture',
        model,
        plan: ['Émettre la facture confirmée'],
        card: {
          title: 'Facture émise ✓',
          body:
            `${pending.label} — c’est émis${numberRef !== null ? ` sous le numéro ${numberRef}` : ''}.`
            + (sendable ? '\nJe l’envoie au client par e-mail (lien + PDF) ?' : ''),
        },
        ...(sendable
          ? {
              choices: [{ label: 'Oui — envoie-la au client', value: `Envoie la facture ${numberRef}` }],
              spokenPrompt: 'C’est émis. Je l’envoie au client par e-mail ?',
            }
          : {}),
      });
    }
    // B8 — après le lien confirmé, l'ENCHAÎNEMENT NATUREL : Bob propose la facture du devis
    // (délégation VERBATIM au flow generer_facture_devis existant — jamais un flux parallèle).
    if (pending.tool === 'lier_bon_commande') {
      return ok(
        purchaseOrderLinkedRun({
          intent: 'lier_bon_commande',
          model,
          label: pending.label,
          output: run.value,
        }),
      );
    }
    // B1 — la facture directe confirmée annonce le TOTAL calculé par le DOMAINE (sortie du use
    // case), jamais un montant reconstruit côté agent.
    if (pending.tool === 'facture_directe') {
      const output = run.value as { totalTtcCents?: unknown };
      const ttc = typeof output?.totalTtcCents === 'number' ? output.totalTtcCents : null;
      return ok({
        kind: 'done',
        intent: 'facture_directe',
        model,
        plan: ['Créer la facture directe confirmée'],
        card: {
          title: 'Facture directe créée ✓',
          body: `${pending.label}${ttc !== null ? ` — total ${formatEUR(ttc)} TTC (calcul du domaine)` : ''}. Brouillon créé, à émettre quand tu veux.`,
        },
      });
    }
    if (pending.tool === 'facturer_situation') {
      return ok({
        kind: 'done',
        intent: 'facturer_situation',
        model,
        plan: ['Générer la situation confirmée'],
        card: { title: 'Situation générée ✓', body: `${pending.label} — brouillon créé, à émettre quand tu veux.` },
      });
    }
    if (pending.tool === 'definir_conditions_paiement') {
      return ok({
        kind: 'done',
        intent: 'conditions_paiement',
        model,
        plan: ['Enregistrer les conditions confirmées'],
        card: { title: 'Conditions enregistrées ✓', body: `${pending.label} — c’est noté pour les prochaines factures.` },
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

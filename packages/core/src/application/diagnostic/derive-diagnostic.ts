import { type DateOnly } from '../../shared-kernel/time';
import { type DiagnosticResult, type ItemSeverity, type ItemStatus } from '../../domain/compliance/diagnostic';
import { einvoiceChannelFor, type EinvoiceChannel } from '../../domain/services/einvoice-for';
import { type CustomerType } from '../../domain/customer/customer';
import { type LineCategory } from '../../domain/billing/shared/line-item';
import { type InvoiceKind } from '../../domain/billing/invoice/invoice';
import { type InvoiceStatus } from '../../domain/billing/shared/state-machines';
import { type Trade } from '../../domain/company/company';

/**
 * Diagnostic 2026 « expert-comptable » — use case PUR (claim C23 v2, amendement [16:26]).
 *
 * Philosophie : on AUDITE d'abord le dossier réel (clients, factures, encaissements, faits
 * réglementaires du diagnostic serveur C13) et on ne pose que les questions dont la réponse
 * est INCONNAISSABLE depuis les données (max 3, adaptatives — `diagnosticQuestions`).
 *
 * Zéro duplication de règles réglementaires :
 * · les canaux par type de client viennent d'einvoiceChannelFor (b2g → Chorus Pro ·
 *   b2b → Plateforme Agréée · b2c → e-reporting) ;
 * · les ÉCHÉANCES de la réforme sont LUES dans les faits (`facts` = DiagnosticResult de
 *   runDiagnostic, source unique du calendrier : réception 2026-09-01 pour tous les assujettis,
 *   émission 2027-09-01 pour les TPE/PME — 2026-09-01 si ETI/GE, cf. `companySize`) ;
 * · les acquis structurels (mentions, numérotation sans trou, conservation 10 ans, décennale)
 *   sont relayés depuis les faits, jamais recalculés ici.
 *
 * PIÈGE CODÉ (art. 293 B CGI) : la franchise en base reste ASSUJETTIE à la TVA (non redevable) —
 * elle N'EXONÈRE D'AUCUNE obligation e-invoicing/e-reporting. L'item `franchise_scope` est un
 * constat pédagogique ; les items réception/émission restent dus à l'identique.
 *
 * Sanctions indicatives (CGI art. 1737, LF 2024) — portées EN COMMENTAIRE uniquement,
 * jamais dans l'UI (pas de conseil juridique) :
 * · e-invoicing : 15 € par facture non émise par voie électronique, plafonné à 15 000 €/an ;
 * · e-reporting : 250 € par transmission omise, plafonné à 15 000 €/an.
 *
 * Barème v2 (« moteur remplacé, parité visuelle conservée ») : chaque axe part de 100 et perd,
 * par item À FAIRE, une pénalité par sévérité (critical 60 · important 25 · info 10 — la sévérité
 * elle-même reprend l'échelle du domaine compliance). Le score global est la moyenne pondérée des
 * 3 axes, RÉCEPTION SURPONDÉRÉE tant que l'échéance 2026 n'est pas passée (0.5/0.2/0.3, puis
 * 0.3/0.4/0.3) — cohérent avec l'écran C13 « Facturation électronique requise » : réception non
 * prête = gros malus.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Entrées — projections minimales des données réelles (api-client) + réponses
// ─────────────────────────────────────────────────────────────────────────────

export interface DiagCustomerData {
  id: string;
  type: CustomerType;
  /** SIREN si personne morale — null = fiche incomplète (mention/adressage PA impossibles). */
  siren: string | null;
}

export interface DiagInvoiceData {
  id: string;
  customerId: string;
  kind: InvoiceKind;
  status: InvoiceStatus;
  /** Volume TTC en centimes — pondère le mix clientèle réel. */
  ttcCents: number;
  /** Catégories des lignes — détecte l'exposition « prestations de services » (e-reporting paiement). */
  lineCategories: readonly LineCategory[];
}

/** Encaissement enregistré dans l'app (dérivé des factures : cumul `paid` > 0). */
export interface DiagPaymentData {
  invoiceId: string;
  amountCents: number;
}

export interface DiagProfileData {
  /** Métier (TradeConfig) — les métiers servis sont des prestations de services (e-reporting paiement). */
  trade: Trade | null;
}

export type DiagAnswerValue = 'yes' | 'no' | 'unknown';

/** Les 3 seules inconnues que les données ne peuvent pas trancher. */
export type DiagQuestionId = 'platform' | 'offAppSales' | 'accountant';

export interface DiagnosticAnswers {
  /** Plateforme agréée (PA) choisie et inscription à l'annuaire faite ? */
  platform?: DiagAnswerValue;
  /** Encaissements B2C hors app (caisse, espèces…) ? — e-reporting incomplet si oui. */
  offAppSales?: DiagAnswerValue;
  /** Accompagnement comptable (expert-comptable / OGA-CGA) ? */
  accountant?: DiagAnswerValue;
}

export interface DeriveDiagnosticInput {
  /** Audit réglementaire réel du dossier — runDiagnostic (endpoint compliance, C13). */
  facts: DiagnosticResult;
  customers: readonly DiagCustomerData[];
  invoices: readonly DiagInvoiceData[];
  payments: readonly DiagPaymentData[];
  profile: DiagProfileData;
  answers: DiagnosticAnswers;
  today: DateOnly;
  /** Émission obligatoire dès 2026 pour les ETI/GE, 2027 pour les TPE/PME (défaut = cible produit). */
  companySize?: 'tpe_pme' | 'eti_ge';
}

// ─────────────────────────────────────────────────────────────────────────────
// Sortie — score global (ScoreRing), 3 axes, plan d'action daté
// ─────────────────────────────────────────────────────────────────────────────

export type DiagAxisId = 'reception' | 'emission' | 'donnees';

export interface DiagAxisScore {
  id: DiagAxisId;
  score: number; // 0–100
}

export type DiagItemKind =
  | 'reception_platform' // choisir sa PA de réception + annuaire — LE plus urgent avant 2026
  | 'franchise_scope' // constat 293 B : la franchise reste concernée (piège)
  | 'archive' // conservation 10 ans — coffre-fort C14 (acquis structurel)
  | 'emission_einvoicing' // e-invoicing B2B domestique via PA (2027 TPE/PME)
  | 'chorus_pro' // B2G — déjà en vigueur (Chorus Pro)
  | 'ereporting_sales' // e-reporting des ventes B2C / international
  | 'offapp_sales' // encaissements hors app à centraliser (e-reporting incomplet sinon)
  | 'ereporting_payments' // e-reporting des paiements (prestations de services)
  | 'facturx' // format Factur-X géré par le core (acquis structurel)
  | 'siren_missing' // SIREN des clients pros absents (mention + adressage PA)
  | 'mentions' // mentions légales générées (acquis structurel)
  | 'numbering' // numérotation séquentielle sans trou (acquis structurel)
  | 'vat_lines' // TVA par ligne (suggestVatRate — acquis structurel)
  | 'decennale' // assurance décennale BTP (mention devis/factures — métier)
  | 'accountant'; // partenaire compta dans la boucle

/** dossier = constat automatique (données/faits) · reponse = dépend du questionnaire. */
export type DiagItemSource = 'dossier' | 'reponse';

/**
 * Clés i18n par item — UNIONS LITTÉRALES : l'écran passe `labelKey`/`detailKey` directement à
 * t() de @bob/i18n ; si une clé manque au dictionnaire, le typecheck mobile ÉCHOUE (sécurité de
 * bout en bout sans que le core dépende d'@bob/i18n).
 */
const ITEM_COPY = {
  reception_platform: { label: 'diag.itemReception', todo: 'diag.itemReceptionTodo', done: 'diag.itemReceptionDone' },
  franchise_scope: { label: 'diag.itemFranchise', todo: 'diag.itemFranchiseNote', done: 'diag.itemFranchiseNote' },
  archive: { label: 'diag.itemArchive', todo: 'diag.itemArchiveDone', done: 'diag.itemArchiveDone' },
  emission_einvoicing: { label: 'diag.itemEmission', todo: 'diag.itemEmissionTodo', done: 'diag.itemEmissionDone' },
  chorus_pro: { label: 'diag.itemChorus', todo: 'diag.itemChorusDone', done: 'diag.itemChorusDone' },
  ereporting_sales: { label: 'diag.itemEreporting', todo: 'diag.itemEreportingTodo', done: 'diag.itemEreportingDone' },
  offapp_sales: { label: 'diag.itemOffApp', todo: 'diag.itemOffAppTodo', done: 'diag.itemOffAppTodo' },
  ereporting_payments: { label: 'diag.itemPayments', todo: 'diag.itemPaymentsDone', done: 'diag.itemPaymentsDone' },
  facturx: { label: 'diag.itemFacturx', todo: 'diag.itemFacturxDone', done: 'diag.itemFacturxDone' },
  siren_missing: { label: 'diag.itemSiren', todo: 'diag.itemSirenTodo', done: 'diag.itemSirenDone' },
  mentions: { label: 'diag.itemMentions', todo: 'diag.itemMentionsDone', done: 'diag.itemMentionsDone' },
  numbering: { label: 'diag.itemNumbering', todo: 'diag.itemNumberingDone', done: 'diag.itemNumberingDone' },
  vat_lines: { label: 'diag.itemVat', todo: 'diag.itemVatDone', done: 'diag.itemVatDone' },
  decennale: { label: 'diag.itemDecennale', todo: 'diag.itemDecennaleTodo', done: 'diag.itemDecennaleDone' },
  accountant: { label: 'diag.itemAccountant', todo: 'diag.itemAccountantTodo', done: 'diag.itemAccountantDone' },
} as const satisfies Record<DiagItemKind, { label: string; todo: string; done: string }>;

export type DiagItemLabelKey = (typeof ITEM_COPY)[DiagItemKind]['label'];
export type DiagItemDetailKey =
  | (typeof ITEM_COPY)[DiagItemKind]['todo']
  | (typeof ITEM_COPY)[DiagItemKind]['done']
  | 'diag.itemSirenTodoOne';

export interface DiagActionItem {
  kind: DiagItemKind;
  axis: DiagAxisId;
  source: DiagItemSource;
  labelKey: DiagItemLabelKey;
  detailKey: DiagItemDetailKey;
  done: boolean;
  severity: ItemSeverity;
  /** Échéance réelle de la réforme (lue dans les faits) — null si intemporel. */
  deadline: DateOnly | null;
  /** Route d'app RÉELLE pour agir (parité humain ↔ Bob : mêmes écrans que les intents C40). */
  route: string | null;
  /** Paramètre de copy (ex. nombre de fiches SIREN à compléter). */
  count?: number;
}

export interface DiagMixEntry {
  customers: number;
  /** Volume TTC facturé (centimes) — pièces émises non annulées, avoirs exclus. */
  volumeCents: number;
  channel: EinvoiceChannel;
}

/** Mix clientèle RÉEL — la base de l'audit (obligations par canal). */
export type DiagClienteleMix = Record<CustomerType, DiagMixEntry>;

export interface DeriveDiagnosticResult {
  /** Score global 0–100 (ScoreRing) — moyenne pondérée des 3 axes. */
  score: number;
  axes: readonly [DiagAxisScore, DiagAxisScore, DiagAxisScore];
  /** Plan d'action priorisé : à faire d'abord (sévérité puis échéance), acquis ensuite. */
  items: DiagActionItem[];
  mix: DiagClienteleMix;
  /** Questions pertinentes pour CE dossier (adaptatif, max 3). */
  questions: DiagQuestionId[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Barème v2 (contrat C23 v2 [16:26]) — documenté en tête de fichier
// ─────────────────────────────────────────────────────────────────────────────

const PENALTY: Record<ItemSeverity, number> = { critical: 60, important: 25, info: 10 };

const AXIS_WEIGHTS_BEFORE_2026: Record<DiagAxisId, number> = { reception: 0.5, emission: 0.2, donnees: 0.3 };
const AXIS_WEIGHTS_AFTER_2026: Record<DiagAxisId, number> = { reception: 0.3, emission: 0.4, donnees: 0.3 };

const SEVERITY_RANK: Record<ItemSeverity, number> = { critical: 0, important: 1, info: 2 };

/** Statuts qui comptent dans le volume facturé (pipeline exclu : brouillons, annulées). */
const VOLUME_STATUSES: ReadonlySet<InvoiceStatus> = new Set(['issued', 'partially_paid', 'paid', 'late']);

/** Prestations de services (e-reporting des paiements) — fournitures/débours exclus. */
const SERVICE_CATEGORIES: ReadonlySet<LineCategory> = new Set(['labor', 'travel', 'subscription']);

// ─────────────────────────────────────────────────────────────────────────────
// Audit des données réelles
// ─────────────────────────────────────────────────────────────────────────────

function buildMix(customers: readonly DiagCustomerData[], invoices: readonly DiagInvoiceData[]): DiagClienteleMix {
  const mix: DiagClienteleMix = {
    b2c: { customers: 0, volumeCents: 0, channel: einvoiceChannelFor('b2c') },
    b2b: { customers: 0, volumeCents: 0, channel: einvoiceChannelFor('b2b') },
    b2g: { customers: 0, volumeCents: 0, channel: einvoiceChannelFor('b2g') },
  };
  const typeById = new Map<string, CustomerType>();
  for (const c of customers) {
    mix[c.type].customers += 1;
    typeById.set(c.id, c.type);
  }
  for (const invoice of invoices) {
    if (invoice.kind === 'credit_note' || !VOLUME_STATUSES.has(invoice.status)) continue;
    const type = typeById.get(invoice.customerId);
    if (type !== undefined) mix[type].volumeCents += invoice.ttcCents;
  }
  return mix;
}

function exposed(mix: DiagClienteleMix, type: CustomerType): boolean {
  return mix[type].customers > 0 || mix[type].volumeCents > 0;
}

function factStatus(facts: DiagnosticResult, id: string): ItemStatus | null {
  return facts.items.find((item) => item.id === id)?.status ?? null;
}

function factDueDate(facts: DiagnosticResult, id: string): DateOnly | null {
  return facts.items.find((item) => item.id === id)?.dueDate ?? null;
}

/**
 * Questions pertinentes pour CE dossier — uniquement l'inconnaissable :
 * · `platform` : toujours (le choix de PA n'existe nulle part dans les données) ;
 * · `offAppSales` : seulement si exposition B2C réelle (sinon l'e-reporting des ventes ne se pose pas) ;
 * · `accountant` : toujours (le partenaire compta n'est pas une donnée de l'app).
 */
export function diagnosticQuestions(input: {
  customers: readonly DiagCustomerData[];
  invoices: readonly DiagInvoiceData[];
}): DiagQuestionId[] {
  const mix = buildMix(input.customers, input.invoices);
  return ['platform', ...(exposed(mix, 'b2c') ? (['offAppSales'] as const) : []), 'accountant'];
}

// ─────────────────────────────────────────────────────────────────────────────
// Dérivation
// ─────────────────────────────────────────────────────────────────────────────

interface ItemSpec {
  kind: DiagItemKind;
  axis: DiagAxisId;
  source: DiagItemSource;
  done: boolean;
  severity: ItemSeverity;
  deadline: DateOnly | null;
  route: string | null;
  count?: number;
}

function toItem(spec: ItemSpec): DiagActionItem {
  const copy = ITEM_COPY[spec.kind];
  const detailKey: DiagItemDetailKey =
    spec.kind === 'siren_missing' && !spec.done && spec.count === 1
      ? 'diag.itemSirenTodoOne'
      : spec.done
        ? copy.done
        : copy.todo;
  return {
    kind: spec.kind,
    axis: spec.axis,
    source: spec.source,
    labelKey: copy.label,
    detailKey,
    done: spec.done,
    severity: spec.severity,
    deadline: spec.deadline,
    route: spec.route,
    ...(spec.count !== undefined ? { count: spec.count } : {}),
  };
}

function axisScore(items: readonly DiagActionItem[], axis: DiagAxisId): number {
  const penalty = items
    .filter((item) => item.axis === axis && !item.done)
    .reduce((sum, item) => sum + PENALTY[item.severity], 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

export function deriveDiagnostic(input: DeriveDiagnosticInput): DeriveDiagnosticResult {
  const { facts, answers } = input;
  const mix = buildMix(input.customers, input.invoices);

  // Échéances RÉELLES — lues dans les faits (calendrier unique du domaine compliance) :
  // réception 2026-09-01 (tous assujettis) · émission 2027-09-01 (TPE/PME), 2026-09-01 si ETI/GE.
  const receptionDeadline = factDueDate(facts, 'einvoice-reception');
  const emissionDeadline =
    (input.companySize ?? 'tpe_pme') === 'eti_ge' ? receptionDeadline : factDueDate(facts, 'einvoice-emission');

  const franchise = factStatus(facts, 'tva-franchise') !== null;
  const decennaleStatus = factStatus(facts, 'decennale');
  const platformReady = answers.platform === 'yes';

  // Prestations de services → e-reporting des données de PAIEMENT (les encaissements remontent
  // au fisc — les retards clients deviennent visibles) : métiers servis = services par nature.
  const serviceExposure =
    input.profile.trade !== null ||
    input.payments.length > 0 ||
    input.invoices.some((invoice) => invoice.lineCategories.some((c) => SERVICE_CATEGORIES.has(c)));

  const proCustomers = input.customers.filter((c) => c.type !== 'b2c');
  const sirenMissing = proCustomers.filter((c) => c.siren === null);

  const specs: ItemSpec[] = [];

  // ── Axe RÉCEPTION (2026-09-01, tous assujettis — y compris franchise 293 B) ──
  specs.push({
    kind: 'reception_platform',
    axis: 'reception',
    source: 'reponse',
    done: platformReady,
    severity: 'critical',
    deadline: receptionDeadline,
    route: '/compte',
  });
  if (franchise) {
    // Constat pédagogique — AUCUNE dispense : les items réception/émission restent dus.
    specs.push({
      kind: 'franchise_scope',
      axis: 'reception',
      source: 'dossier',
      done: true,
      severity: 'info',
      deadline: receptionDeadline,
      route: null,
    });
  }
  specs.push({
    kind: 'archive',
    axis: 'reception',
    source: 'dossier',
    done: factStatus(facts, 'conservation') !== 'todo',
    severity: 'info',
    deadline: null,
    route: '/(tabs)/documents',
  });

  // ── Axe ÉMISSION (2027-09-01 TPE/PME · 2026-09-01 ETI/GE) — canaux einvoiceChannelFor ──
  if (exposed(mix, 'b2b')) {
    // Sanction indicative (art. 1737 CGI) : 15 €/facture non émise en e-invoicing, plafond 15 000 €/an.
    specs.push({
      kind: 'emission_einvoicing',
      axis: 'emission',
      source: 'reponse',
      done: platformReady,
      severity: 'important',
      deadline: emissionDeadline,
      route: '/compte',
    });
  }
  if (exposed(mix, 'b2g')) {
    specs.push({
      kind: 'chorus_pro',
      axis: 'emission',
      source: 'dossier',
      done: factStatus(facts, 'chorus-pro') !== 'todo',
      severity: 'info',
      deadline: null,
      route: null,
    });
  }
  if (exposed(mix, 'b2c')) {
    // Sanction indicative (art. 1737 CGI) : 250 €/transmission e-reporting omise, plafond 15 000 €/an.
    specs.push({
      kind: 'ereporting_sales',
      axis: 'emission',
      source: 'reponse',
      done: platformReady && answers.offAppSales === 'no',
      severity: 'important',
      deadline: emissionDeadline,
      route: '/compte',
    });
    if (answers.offAppSales === 'yes') {
      specs.push({
        kind: 'offapp_sales',
        axis: 'emission',
        source: 'reponse',
        done: false,
        severity: 'important',
        deadline: emissionDeadline,
        route: '/ventes',
      });
    }
  }
  if (serviceExposure) {
    specs.push({
      kind: 'ereporting_payments',
      axis: 'emission',
      source: 'dossier',
      done: true, // l'app enregistre chaque encaissement — la donnée de paiement existe déjà
      severity: 'info',
      deadline: emissionDeadline,
      route: null,
    });
  }
  specs.push({
    kind: 'facturx',
    axis: 'emission',
    source: 'dossier',
    done: true, // format garanti par le core (domain/compliance/facturx)
    severity: 'info',
    deadline: null,
    route: null,
  });

  // ── Axe QUALITÉ DES DONNÉES (SIREN, mentions, numérotation, TVA, métier) ──
  if (proCustomers.length > 0) {
    specs.push({
      kind: 'siren_missing',
      axis: 'donnees',
      source: 'dossier',
      done: sirenMissing.length === 0,
      severity: 'important',
      deadline: emissionDeadline,
      route:
        sirenMissing.length === 1 && sirenMissing[0] !== undefined
          ? `/client/${sirenMissing[0].id}`
          : '/(tabs)/clients',
      count: sirenMissing.length,
    });
  }
  specs.push({
    kind: 'mentions',
    axis: 'donnees',
    source: 'dossier',
    done: factStatus(facts, 'mentions') !== 'todo',
    severity: 'important',
    deadline: null,
    route: null,
  });
  specs.push({
    kind: 'numbering',
    axis: 'donnees',
    source: 'dossier',
    done: factStatus(facts, 'numbering') !== 'todo',
    severity: 'info',
    deadline: null,
    route: null,
  });
  specs.push({
    kind: 'vat_lines',
    axis: 'donnees',
    source: 'dossier',
    done: true, // TVA suggérée par ligne (domain/services/suggest-vat-rate)
    severity: 'info',
    deadline: null,
    route: null,
  });
  if (decennaleStatus !== null && decennaleStatus !== 'na') {
    specs.push({
      kind: 'decennale',
      axis: 'donnees',
      source: 'dossier',
      done: decennaleStatus === 'ok',
      severity: 'critical',
      deadline: null,
      route: '/compte',
    });
  }
  specs.push({
    kind: 'accountant',
    axis: 'donnees',
    source: 'reponse',
    done: answers.accountant === 'yes',
    severity: 'info',
    deadline: null,
    route: null,
  });

  // Priorisation : à faire d'abord (sévérité, puis échéance la plus proche), acquis ensuite.
  const items = specs.map(toItem).sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.severity !== b.severity) return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (a.deadline !== b.deadline) {
      if (a.deadline === null) return 1;
      if (b.deadline === null) return -1;
      return a.deadline < b.deadline ? -1 : 1;
    }
    return 0;
  });

  const axes: [DiagAxisScore, DiagAxisScore, DiagAxisScore] = [
    { id: 'reception', score: axisScore(items, 'reception') },
    { id: 'emission', score: axisScore(items, 'emission') },
    { id: 'donnees', score: axisScore(items, 'donnees') },
  ];

  // Réception surpondérée tant que l'échéance 2026 n'est pas passée (comparaison DateOnly ISO).
  const beforeReceptionDeadline = receptionDeadline === null || input.today < receptionDeadline;
  const weights = beforeReceptionDeadline ? AXIS_WEIGHTS_BEFORE_2026 : AXIS_WEIGHTS_AFTER_2026;
  const score = Math.round(axes.reduce((sum, axis) => sum + axis.score * weights[axis.id], 0));

  return { score, axes, items, mix, questions: diagnosticQuestions(input) };
}

/**
 * B1 — Facture DIRECTE sans devis signé (dépannage urgent B2C qualifié, régie TJM × jours,
 * syndic/B2B) : modèle PUR du wizard allégé client → lignes → récap. Aucune dépendance RN —
 * tout est testable en node. Le modèle PRÉPARE l'intention ; la création réelle passe par
 * composeStandaloneInvoice (POST /invoices) puis l'émission par issueInvoice (aucun chemin
 * parallèle). Doctrine fail-closed :
 *  • client PARTICULIER ⇒ la qualification « dépannage urgent expressément sollicité »
 *    (art. L221-28, 8° c. conso — A3bis) est OBLIGATOIRE : `true` strict, jamais déduite ;
 *    répondre « non » = état bloquant honnête (le devis signé est le contrat) ;
 *  • client PROFESSIONNEL ÉTRANGER ⇒ blocage B7 (autoliquidation UE / exonération export non
 *    gérées — TVA française fiscalement fausse), même règle pure que le serveur
 *    (internationalProEmissionGuard) ;
 *  • remises B3 (ligne et globale) validées par les MÊMES règles domaine que le serveur
 *    (validateLineDiscount / validateDiscount) — jamais une base négative.
 */
import {
  computeLineBases,
  computeTotals,
  validateDiscount,
  validateLineDiscount,
  type Discount,
  type LineCategory,
  type LineInput,
  type Totals,
  type VatRate,
} from '@bob/core';

export type FactureDirecteStep = 'client' | 'lignes' | 'recap';

export const FACTURE_DIRECTE_STEPS: readonly FactureDirecteStep[] = ['client', 'lignes', 'recap'];

export interface FactureDirecteCustomer {
  readonly id: string;
  readonly name: string;
  readonly type: 'b2c' | 'b2b' | 'b2g';
  readonly isInternational: boolean;
}

export interface FactureDirecteState {
  readonly step: FactureDirecteStep;
  readonly customer: FactureDirecteCustomer | null;
  readonly lines: readonly LineInput[];
  /** UN taux confirmé pour toute la pièce (même doctrine que le wizard devis). */
  readonly vatRate: VatRate | null;
  readonly context: { housingOlderThan2y: boolean; energyRenovation: boolean };
  /** A3bis — réponse à la question d'urgence (b2c uniquement) : null = pas encore répondue. */
  readonly urgentOnSiteRepair: boolean | null;
  /** B3 — remise globale du récap ; null = aucune. */
  readonly globalDiscount: Discount | null;
}

export type FactureDirecteGuardError =
  | { code: 'customer_required' }
  /** B7 — professionnel établi hors de France : état bloquant honnête, jamais un crash. */
  | { code: 'international_pro_blocked' }
  /** A3bis — particulier : la question d'urgence doit être répondue. */
  | { code: 'urgent_answer_required' }
  /** A3bis — particulier SANS urgence : la facture directe n'existe pas (devis signé requis). */
  | { code: 'urgent_required_for_b2c' }
  | { code: 'lines_required' }
  | { code: 'vat_required' }
  | { code: 'discount_invalid'; message: string }
  | { code: 'flow_finished' };

export type FactureDirecteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: FactureDirecteGuardError };

const okr = <T>(value: T): FactureDirecteResult<T> => ({ ok: true, value });
const errr = <T>(error: FactureDirecteGuardError): FactureDirecteResult<T> => ({ ok: false, error });

export function startFactureDirecte(): FactureDirecteState {
  return {
    step: 'client',
    customer: null,
    lines: [],
    vatRate: null,
    context: { housingOlderThan2y: false, energyRenovation: false },
    urgentOnSiteRepair: null,
    globalDiscount: null,
  };
}

/** Le client pro étranger est REFUSABLE dès la sélection (garde-fou B7 — même règle serveur). */
export function isInternationalProBlocked(customer: FactureDirecteCustomer | null): boolean {
  return customer !== null && customer.type !== 'b2c' && customer.isInternational;
}

/** Sélection du client : changer de client RÉINITIALISE la qualification d'urgence (jamais un
 * flag orphelin d'un ancien choix). La sélection d'un pro étranger est ACCEPTÉE dans l'état
 * (l'écran montre le blocage explicatif) mais la garde d'avancement la refuse. */
export function selectCustomer(
  state: FactureDirecteState,
  customer: FactureDirecteCustomer,
): FactureDirecteState {
  return { ...state, customer, urgentOnSiteRepair: null };
}

export function setUrgentOnSiteRepair(
  state: FactureDirecteState,
  requested: boolean,
): FactureDirecteState {
  return { ...state, urgentOnSiteRepair: requested };
}

export function setVat(
  state: FactureDirecteState,
  vatRate: VatRate,
  context: { housingOlderThan2y: boolean; energyRenovation: boolean },
): FactureDirecteState {
  // Une pièce = UN taux : re-confirmer le taux réaligne les lignes déjà saisies (même règle
  // que l'étape TVA du wizard devis — le serveur revalide via suggestVatRate).
  return {
    ...state,
    vatRate,
    context,
    lines: state.lines.map((line) => ({ ...line, vatRate })),
  };
}

/** Ajout d'une ligne — la remise DE LIGNE est validée contre SA base (règle domaine B3). */
export function addLine(
  state: FactureDirecteState,
  line: LineInput,
): FactureDirecteResult<FactureDirecteState> {
  if (line.discount !== undefined) {
    const base = Math.round(line.qty * line.unitPriceHT);
    const validated = validateLineDiscount(line.discount, base);
    if (!validated.ok)
      return errr({
        code: 'discount_invalid',
        message: 'message' in validated.error ? validated.error.message : 'Remise invalide.',
      });
  }
  return okr({ ...state, lines: [...state.lines, { ...line }] });
}

export function removeLine(state: FactureDirecteState, index: number): FactureDirecteState {
  if (index < 0 || index >= state.lines.length) return state;
  return { ...state, lines: state.lines.filter((_, i) => i !== index) };
}

/** Remise GLOBALE (récap) — structure domaine + plafond contre le HT net de lignes. */
export function setGlobalDiscount(
  state: FactureDirecteState,
  discount: Discount | null,
): FactureDirecteResult<FactureDirecteState> {
  if (discount === null) return okr({ ...state, globalDiscount: null });
  const structural = validateDiscount(discount);
  if (!structural.ok)
    return errr({
      code: 'discount_invalid',
      message: 'message' in structural.error ? structural.error.message : 'Remise invalide.',
    });
  if (discount.type === 'amount') {
    const netAfterLines = computeLineBases([...state.lines]).netLineBases.reduce((s, b) => s + b, 0);
    if (discount.cents > netAfterLines)
      return errr({
        code: 'discount_invalid',
        message: 'Remise globale supérieure au HT net des lignes.',
      });
  }
  return okr({ ...state, globalDiscount: structural.value });
}

/** Totaux LIVE du récap — même politique d'arrondi que le serveur (computeTotals, B3). */
export function totalsOf(state: FactureDirecteState): Totals {
  return computeTotals([...state.lines], { globalDiscount: state.globalDiscount });
}

/** Garde d'avancement de l'étape courante (parité stricte écran/voix : une seule vérité). */
export function guardAdvance(state: FactureDirecteState): FactureDirecteResult<void> {
  if (state.step === 'client') {
    if (state.customer === null) return errr({ code: 'customer_required' });
    if (isInternationalProBlocked(state.customer)) return errr({ code: 'international_pro_blocked' });
    if (state.customer.type === 'b2c') {
      if (state.urgentOnSiteRepair === null) return errr({ code: 'urgent_answer_required' });
      if (state.urgentOnSiteRepair === false) return errr({ code: 'urgent_required_for_b2c' });
    }
    return okr(undefined);
  }
  if (state.step === 'lignes') {
    if (state.lines.length === 0) return errr({ code: 'lines_required' });
    if (state.vatRate === null) return errr({ code: 'vat_required' });
    return okr(undefined);
  }
  return errr({ code: 'flow_finished' });
}

export function nextStep(state: FactureDirecteState): FactureDirecteResult<FactureDirecteState> {
  const guard = guardAdvance(state);
  if (!guard.ok) return errr(guard.error);
  const index = FACTURE_DIRECTE_STEPS.indexOf(state.step);
  const to = FACTURE_DIRECTE_STEPS[index + 1];
  if (to === undefined) return errr({ code: 'flow_finished' });
  return okr({ ...state, step: to });
}

export function previousStep(state: FactureDirecteState): FactureDirecteState {
  const index = FACTURE_DIRECTE_STEPS.indexOf(state.step);
  const to = FACTURE_DIRECTE_STEPS[index - 1];
  return to === undefined ? state : { ...state, step: to };
}

export interface ComposeStandalonePayload {
  customerId: string;
  lines: LineInput[];
  globalDiscount?: Discount | null;
  context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
  /** `true` STRICT uniquement (contrat serveur A3bis) — jamais false explicite. */
  urgentOnSiteRepair?: boolean;
}

/**
 * Intention finale → payload composeStandaloneInvoice. `null` si les gardes ne passent pas
 * (la confirmation d'écran ne fabrique jamais une intention invalide).
 */
export function buildComposePayload(state: FactureDirecteState): ComposeStandalonePayload | null {
  const customer = state.customer;
  if (customer === null || isInternationalProBlocked(customer)) return null;
  if (state.lines.length === 0 || state.vatRate === null) return null;
  if (customer.type === 'b2c' && state.urgentOnSiteRepair !== true) return null;
  return {
    customerId: customer.id,
    lines: state.lines.map((line) => ({ ...line })),
    ...(state.globalDiscount !== null ? { globalDiscount: { ...state.globalDiscount } } : {}),
    context: {
      housingOlderThan2y: state.context.housingOlderThan2y,
      energyRenovation: state.context.energyRenovation && state.context.housingOlderThan2y,
    },
    ...(customer.type === 'b2c' && state.urgentOnSiteRepair === true
      ? { urgentOnSiteRepair: true }
      : {}),
  };
}

/**
 * Saisie d'une remise (% ou € en texte FR) → Discount | null (champ vide) ; `invalid` si la
 * saisie ne forme pas une remise domaine valide contre sa base.
 */
export function parseDiscountInput(
  kind: 'percent' | 'amount',
  raw: string,
  baseCents: number,
): { ok: true; discount: Discount | null } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, discount: null };
  const value = Number(trimmed.replace(/\s+/g, '').replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return { ok: false };
  const discount: Discount =
    kind === 'percent'
      ? { type: 'percent', value }
      : { type: 'amount', cents: Math.round(value * 100) };
  const validated = validateLineDiscount(discount, baseCents);
  return validated.ok ? { ok: true, discount: validated.value } : { ok: false };
}

/** Catégories proposées à la saisie (mêmes libellés que le wizard devis).
 * PR-14 — `subscription` (forfaits/contrats récurrents) rejoint la saisie directe : la
 * facturation d'un entretien annuel hors devis porte sa vraie catégorie. */
export const FACTURE_DIRECTE_CATEGORIES: readonly LineCategory[] = ['labor', 'supply', 'travel', 'subscription'];

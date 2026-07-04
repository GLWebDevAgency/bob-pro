import { addDays, type DateOnly } from '../../shared-kernel/time';
import { type LegalForm, type VatRegime } from '../../domain/company/company';

/**
 * Use case pur « échéancier fiscal » — C-EXP5 v1 (P09 du rapport
 * `docs/architecture/expertise-comptable-roadmap.md`, références CORRIGÉES par le vérificateur).
 *
 * Dérive, depuis la fiche société (forme juridique, régime TVA, date de création) et deux
 * réponses d'onboarding (clôture d'exercice `fiscalYearEnd`, périodicité URSSAF), la liste datée
 * des échéances fiscales dans la fenêtre [asOf, asOf + horizonDays], BORNES INCLUSES.
 * Aucune I/O ; AUCUN montant inventé : `amountHint` est toujours null en v1 — P03 (provisions
 * URSSAF) et P23 (provision IS) brancheront les montants sur ces mêmes échéances.
 *
 * Règles encodées (chaque date sourcée dans `legalRef`) :
 * - URSSAF micro (legalForm 'micro') : mensuelle = dernier jour du mois M+1 ; trimestrielle =
 *   31/1, 30/4, 31/7, 31/10 (P03). Périodicité inconnue → la première occurrence de CHAQUE
 *   hypothèse est émise en 'assumed' (une seule si elles coïncident), explain invitant à préciser.
 * - TVA : réel normal → CA3 mensuelle posée au 24 du mois (la date exacte, entre le 15 et le 24,
 *   dépend de la situation → 'assumed', explain honnête) ; réel simplifié → acomptes de juillet
 *   (55 %) et décembre (40 %) posés au 24 ('assumed') + CA12 au 2e jour ouvré suivant le 1er mai ;
 *   franchise → aucune échéance TVA (la vigie des seuils est portée par C-EXP3, pas ici).
 * - IS (SASU/SAS/EURL/SARL) : 4 acomptes les 15/3, 15/6, 15/9, 15/12 ('assumed' : dispense
 *   possible — premier exercice, ou IS N-1 ≤ 3 000 €, art. 359, 3 annexe III CGI) ; solde au 15 du
 *   4e mois suivant la clôture SAUF clôture 31/12 → 15 mai (règle dérogatoire codée) ; liasse 2065
 *   au 2e jour ouvré suivant le 1er mai (clôture 31/12) sinon 3 mois après la clôture.
 * - CFE (toutes formes) : solde 15/12 ; acompte 15/6 émis en 'assumed' (dû seulement si CFE
 *   N-1 ≥ 3 000 € — inconnue en v1) ; année de création = exonération (art. 1478, II CGI) →
 *   la déclaration initiale 1447-C avant le 31/12 remplace le solde cette année-là.
 * - Rituel annuel des sociétés (P31) : approbation dans les 6 mois de la clôture + dépôt au greffe
 *   dans le mois suivant (2 mois en ligne). La configuration « associé unique dirigeant » (dépôt
 *   vaut approbation — L223-31 al. 2 EURL / L227-9 dern. al. SASU) étant inconnue en v1, la
 *   version générique est émise en 'assumed', explain mentionnant la simplification.
 *
 * Hors périmètre v1 (volontaire, documenté) :
 * - IR / prélèvement à la source de l'EI au réel : le PAS est prélevé automatiquement, rien à
 *   rappeler — la liasse 2031/2035 (EI réel) et la 2042-C-PRO (micro) relèvent du kind 'ir',
 *   réservé dans l'union mais jamais émis en v1.
 * - CA12 posée au 2e jour ouvré suivant le 1er mai (exercice civil) : la CA12 E des exercices
 *   décalés n'est pas gérée.
 * - URSSAF micro : le décalage de la première déclaration (90 j après la création, P03) n'est
 *   pas modélisé.
 * - « Jour ouvré » = lundi-vendredi : le 2e jour ouvré suivant le 1er mai tombe au plus tard le
 *   5 mai, avant le férié du 8 mai — l'approximation sans table de fériés est donc exacte.
 */

// ── Entrées ──

export type UrssafPeriodicity = 'monthly' | 'quarterly';

export interface FiscalCompanyData {
  legalForm: LegalForm;
  vatRegime: VatRegime;
  /** Date de création (fiche société) — teinte les explains et déclenche la 1447-C. */
  dateCreation?: DateOnly | null;
}

export interface DeriveFiscalCalendarInput {
  company: FiscalCompanyData;
  /** Début de la fenêtre (inclus). */
  asOf: DateOnly;
  /** Largeur de la fenêtre en jours (défaut 90) — borne haute incluse. */
  horizonDays?: number;
  /**
   * Clôture d'exercice 'MM-DD' — null/absent/invalide = inconnue : défaut 31/12 pour les
   * sociétés IS, à confirmer par l'utilisateur (les échéances dérivées passent en 'assumed').
   */
  fiscalYearEnd?: string | null;
  /** Périodicité URSSAF du micro — null/absent = inconnue (deux hypothèses émises en 'assumed'). */
  urssafPeriodicity?: UrssafPeriodicity | null;
}

// ── Sortie (union plate consommée par l'écran Aujourd'hui / notifications C25) ──

export type FiscalDeadlineKind = 'tva' | 'urssaf' | 'is' | 'cfe' | 'comptes' | 'ir';
export type FiscalConfidence = 'certain' | 'assumed';

export interface FiscalDeadline {
  id: string;
  date: DateOnly;
  label: string;
  kind: FiscalDeadlineKind;
  /** Toujours null en v1 : aucun montant inventé (P03/P23 brancheront les provisions). */
  amountHint: null;
  legalRef: string;
  confidence: FiscalConfidence;
  /** Une phrase, voix simple : pourquoi cette date me concerne. */
  explain: string;
}

// ── Constantes réglementaires ──

const DEFAULT_HORIZON_DAYS = 90;
/** Jour posé pour la CA3 et les acomptes de RSI — la date exacte (15-24) dépend de la situation. */
const TVA_POSED_DAY = 24;
/** Mois des 4 acomptes d'IS (15/3, 15/6, 15/9, 15/12 — art. 1668, 1 CGI). */
const IS_INSTALLMENT_MONTHS = [3, 6, 9, 12] as const;
/** Mois des échéances URSSAF trimestrielles (dernier jour : 31/1, 30/4, 31/7, 31/10 — P03). */
const URSSAF_QUARTER_MONTHS = [1, 4, 7, 10] as const;
/** Formes juridiques traitées comme sociétés à l'IS en v1 (pas l'EI, pas le micro). */
const IS_COMPANY_FORMS: ReadonlySet<LegalForm> = new Set(['SASU', 'SAS', 'EURL', 'SARL']);
const SINGLE_OWNER_FORMS: ReadonlySet<LegalForm> = new Set(['EURL', 'SASU']);

// ── Arithmétique DateOnly (UTC maîtrisé, même style que shared-kernel/time) ──

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function ymd(y: number, m: number, d: number): DateOnly {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
function yearOf(date: DateOnly): number {
  return Number(date.slice(0, 4));
}
function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function dayOfWeek(date: DateOnly): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay(); // 0 = dimanche
}
/** m est 1-based ; le jour est borné au dernier jour du mois cible (31/12 + 6 mois → 30/6). */
function addMonthsClamped(y: number, m: number, day: number, months: number): DateOnly {
  const total = y * 12 + (m - 1) + months;
  const ty = Math.floor(total / 12);
  const tm = (total % 12) + 1;
  return ymd(ty, tm, Math.min(day, lastDayOfMonth(ty, tm)));
}
/** 2e jour ouvré (lun-ven) suivant le 1er mai — au plus tard le 5 mai (le 8 mai est hors d'atteinte). */
function secondBusinessDayAfterMay1(year: number): DateOnly {
  let date = ymd(year, 5, 2);
  let counted = 0;
  for (;;) {
    const dow = dayOfWeek(date);
    if (dow !== 0 && dow !== 6) {
      counted += 1;
      if (counted === 2) return date;
    }
    date = addDays(date, 1);
  }
}

// ── Fenêtre et contexte ──

interface CalendarWindow {
  start: DateOnly;
  end: DateOnly;
}

interface YearEnd {
  month: number;
  day: number;
  /** true = clôture inconnue, défaut 31/12 posé — les échéances dérivées passent en 'assumed'. */
  assumed: boolean;
}

interface Ctx {
  window: CalendarWindow;
  company: FiscalCompanyData;
  yearEnd: YearEnd;
  creationYear: number | null;
  urssafPeriodicity: UrssafPeriodicity | null;
}

function inWindow(w: CalendarWindow, date: DateOnly): boolean {
  return date >= w.start && date <= w.end;
}
function yearsOf(w: CalendarWindow): number[] {
  const years: number[] = [];
  for (let y = yearOf(w.start); y <= yearOf(w.end); y += 1) years.push(y);
  return years;
}
function monthsOf(w: CalendarWindow): Array<{ y: number; m: number }> {
  const months: Array<{ y: number; m: number }> = [];
  let y = yearOf(w.start);
  let m = Number(w.start.slice(5, 7));
  const yEnd = yearOf(w.end);
  const mEnd = Number(w.end.slice(5, 7));
  while (y < yEnd || (y === yEnd && m <= mEnd)) {
    months.push({ y, m });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

function parseFiscalYearEnd(raw: string | null | undefined): YearEnd {
  if (raw != null) {
    const match = /^(\d{2})-(\d{2})$/.exec(raw);
    if (match) {
      const month = Number(match[1]);
      const day = Number(match[2]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { month, day, assumed: false };
    }
  }
  return { month: 12, day: 31, assumed: true };
}

/**
 * Clôtures d'exercice candidates dont une échéance dérivée (solde ≤ +5 mois, liasse ≤ +4 mois,
 * dépôt ≤ +7 mois) peut tomber dans la fenêtre : l'année précédant la fenêtre suffit.
 */
function closingDates(ctx: Ctx): Array<{ y: number; m: number; d: number }> {
  const closings: Array<{ y: number; m: number; d: number }> = [];
  for (let cy = yearOf(ctx.window.start) - 1; cy <= yearOf(ctx.window.end); cy += 1) {
    closings.push({
      y: cy,
      m: ctx.yearEnd.month,
      d: Math.min(ctx.yearEnd.day, lastDayOfMonth(cy, ctx.yearEnd.month)),
    });
  }
  return closings;
}

// ── Émetteurs par impôt (ordre de génération = ordre des ex æquo après tri stable) ──

function emitTva(ctx: Ctx): FiscalDeadline[] {
  const { vatRegime } = ctx.company;
  if (vatRegime === 'franchise') return []; // pas de TVA à déclarer — la vigie seuils vit en C-EXP3.
  const deadlines: FiscalDeadline[] = [];

  if (vatRegime === 'reel_normal') {
    for (const { y, m } of monthsOf(ctx.window)) {
      const date = ymd(y, m, TVA_POSED_DAY);
      if (!inWindow(ctx.window, date)) continue;
      deadlines.push({
        id: `tva-ca3-${date}`,
        date,
        label: 'TVA : déclaration CA3 mensuelle',
        kind: 'tva',
        amountHint: null,
        legalRef: 'art. 287, 2 CGI',
        confidence: 'assumed',
        explain:
          'Au réel normal tu déclares ta TVA tous les mois ; la date exacte (entre le 15 et le 24) dépend de ta situation, vérifie ton échéance sur impots.gouv.',
      });
    }
    return deadlines;
  }

  // reel_simpl : deux acomptes + CA12 annuelle.
  for (const y of yearsOf(ctx.window)) {
    const july = ymd(y, 7, TVA_POSED_DAY);
    if (inWindow(ctx.window, july)) {
      deadlines.push({
        id: `tva-acompte-juillet-${y}`,
        date: july,
        label: 'TVA : acompte de juillet (55 %)',
        kind: 'tva',
        amountHint: null,
        legalRef: 'art. 287, 3 CGI',
        confidence: 'assumed',
        explain:
          "Tu verses en juillet un acompte de 55 % de la TVA de l'an dernier (sauf si elle était sous 1 000 €) — la date exacte figure sur ton avis d'acompte.",
      });
    }
    const december = ymd(y, 12, TVA_POSED_DAY);
    if (inWindow(ctx.window, december)) {
      deadlines.push({
        id: `tva-acompte-decembre-${y}`,
        date: december,
        label: 'TVA : acompte de décembre (40 %)',
        kind: 'tva',
        amountHint: null,
        legalRef: 'art. 287, 3 CGI',
        confidence: 'assumed',
        explain:
          "Tu verses en décembre un acompte de 40 % de la TVA de l'an dernier (sauf si elle était sous 1 000 €) — la date exacte figure sur ton avis d'acompte.",
      });
    }
    const ca12 = secondBusinessDayAfterMay1(y);
    if (inWindow(ctx.window, ca12)) {
      deadlines.push({
        id: `tva-ca12-${y}`,
        date: ca12,
        label: 'TVA : déclaration annuelle CA12',
        kind: 'tva',
        amountHint: null,
        legalRef: 'art. 287, 3 CGI',
        confidence: 'certain',
        explain: 'Ta déclaration annuelle de TVA (CA12) se dépose le deuxième jour ouvré qui suit le 1er mai.',
      });
    }
  }
  return deadlines;
}

function urssafMonthlyOccurrences(w: CalendarWindow): DateOnly[] {
  return monthsOf(w)
    .map(({ y, m }) => ymd(y, m, lastDayOfMonth(y, m)))
    .filter((date) => inWindow(w, date));
}
function urssafQuarterlyOccurrences(w: CalendarWindow): DateOnly[] {
  const dates: DateOnly[] = [];
  for (const y of yearsOf(w)) {
    for (const m of URSSAF_QUARTER_MONTHS) {
      const date = ymd(y, m, lastDayOfMonth(y, m));
      if (inWindow(w, date)) dates.push(date);
    }
  }
  return dates.sort();
}

function emitUrssaf(ctx: Ctx): FiscalDeadline[] {
  if (ctx.company.legalForm !== 'micro') return []; // TNS au réel : cotisations via DSFU/PAS, rien à rappeler en v1.
  const legalRef = 'art. L613-8 CSS';

  if (ctx.urssafPeriodicity === 'monthly') {
    return urssafMonthlyOccurrences(ctx.window).map((date) => ({
      id: `urssaf-${date}`,
      date,
      label: "URSSAF : déclaration de chiffre d'affaires (mensuelle)",
      kind: 'urssaf' as const,
      amountHint: null,
      legalRef,
      confidence: 'certain' as const,
      explain: "Tu déclares à l'URSSAF le chiffre d'affaires encaissé le mois dernier, même s'il est à zéro.",
    }));
  }
  if (ctx.urssafPeriodicity === 'quarterly') {
    return urssafQuarterlyOccurrences(ctx.window).map((date) => ({
      id: `urssaf-${date}`,
      date,
      label: "URSSAF : déclaration de chiffre d'affaires (trimestrielle)",
      kind: 'urssaf' as const,
      amountHint: null,
      legalRef,
      confidence: 'certain' as const,
      explain: "Tu déclares à l'URSSAF le chiffre d'affaires encaissé au trimestre dernier, même s'il est à zéro.",
    }));
  }

  // Périodicité inconnue : première occurrence de CHAQUE hypothèse (une seule si elles coïncident,
  // comme fin janvier/avril/juillet/octobre), en 'assumed', explain invitant à préciser.
  const candidates: DateOnly[] = [];
  const firstMonthly = urssafMonthlyOccurrences(ctx.window)[0];
  if (firstMonthly !== undefined) candidates.push(firstMonthly);
  const firstQuarterly = urssafQuarterlyOccurrences(ctx.window)[0];
  if (firstQuarterly !== undefined && firstQuarterly !== firstMonthly) candidates.push(firstQuarterly);
  return candidates.map((date) => ({
    id: `urssaf-${date}`,
    date,
    label: "URSSAF : déclaration de chiffre d'affaires (périodicité à confirmer)",
    kind: 'urssaf' as const,
    amountHint: null,
    legalRef,
    confidence: 'assumed' as const,
    explain:
      'Mensuelle ou trimestrielle ? Précise ta périodicité URSSAF pour que je cale les bonnes dates — en attendant, retiens celle-ci.',
  }));
}

function installmentLabel(month: number): string {
  switch (month) {
    case 3:
      return 'IS : 1er acompte';
    case 6:
      return 'IS : 2e acompte';
    case 9:
      return 'IS : 3e acompte';
    default:
      return 'IS : 4e acompte';
  }
}

function emitIs(ctx: Ctx): FiscalDeadline[] {
  if (!IS_COMPANY_FORMS.has(ctx.company.legalForm)) return [];
  const deadlines: FiscalDeadline[] = [];

  // 4 acomptes trimestriels — toujours 'assumed' en v1 : la dispense (premier exercice, ou
  // IS N-1 ≤ 3 000 €, art. 359, 3 annexe III) n'est pas vérifiable sans montant.
  for (const y of yearsOf(ctx.window)) {
    for (const m of IS_INSTALLMENT_MONTHS) {
      const date = ymd(y, m, 15);
      if (!inWindow(ctx.window, date)) continue;
      deadlines.push({
        id: `is-acompte-${date}`,
        date,
        label: installmentLabel(m),
        kind: 'is',
        amountHint: null,
        legalRef: 'art. 1668, 1 CGI ; art. 359, 3 annexe III CGI',
        confidence: 'assumed',
        explain:
          "Un quart de ton impôt société se verse d'avance à cette date, sauf dispense (premier exercice, ou IS de l'an dernier de 3 000 € ou moins).",
      });
    }
  }

  const closeConfidence: FiscalConfidence = ctx.yearEnd.assumed ? 'assumed' : 'certain';
  const confirmClause = ctx.yearEnd.assumed
    ? " — j'ai supposé une clôture au 31 décembre, confirme ta date de clôture."
    : '.';
  const civilYearEnd = ctx.yearEnd.month === 12 && ctx.yearEnd.day === 31;

  for (const close of closingDates(ctx)) {
    // Solde : 15 du 4e mois suivant la clôture, SAUF clôture 31/12 → 15 mai (règle dérogatoire).
    const solde = civilYearEnd ? ymd(close.y + 1, 5, 15) : addMonthsClamped(close.y, close.m, 15, 4);
    if (inWindow(ctx.window, solde)) {
      deadlines.push({
        id: `is-solde-${solde}`,
        date: solde,
        label: "IS : solde de l'exercice clos",
        kind: 'is',
        amountHint: null,
        legalRef: 'art. 1668, 2 CGI ; art. 360 annexe III CGI',
        confidence: closeConfidence,
        explain: `Le solde de ton impôt société de l'exercice clos se règle à cette date${confirmClause}`,
      });
    }
    // Liasse 2065 : 2e jour ouvré suivant le 1er mai (clôture 31/12), sinon 3 mois après la clôture.
    const liasse = civilYearEnd ? secondBusinessDayAfterMay1(close.y + 1) : addMonthsClamped(close.y, close.m, close.d, 3);
    if (inWindow(ctx.window, liasse)) {
      deadlines.push({
        id: `is-liasse-2065-${liasse}`,
        date: liasse,
        label: 'IS : liasse fiscale 2065',
        kind: 'is',
        amountHint: null,
        legalRef: 'art. 223, 1 CGI',
        confidence: closeConfidence,
        explain: `Ta déclaration de résultat (liasse 2065) se dépose à cette date${confirmClause}`,
      });
    }
  }
  return deadlines;
}

function emitCfe(ctx: Ctx): FiscalDeadline[] {
  const deadlines: FiscalDeadline[] = [];
  for (const y of yearsOf(ctx.window)) {
    // Année de création : exonération (art. 1478, II) — mais la 1447-C doit partir avant le 31/12.
    if (ctx.creationYear === y) {
      const date = ymd(y, 12, 31);
      if (inWindow(ctx.window, date)) {
        deadlines.push({
          id: `cfe-1447c-${y}`,
          date,
          label: 'CFE : déclaration initiale 1447-C',
          kind: 'cfe',
          amountHint: null,
          legalRef: 'art. 1478, II CGI',
          confidence: 'certain',
          explain:
            "Tu es exonéré de CFE l'année de création, mais la déclaration initiale 1447-C doit être déposée avant le 31 décembre.",
        });
      }
      continue;
    }
    const acompte = ymd(y, 6, 15);
    if (inWindow(ctx.window, acompte)) {
      deadlines.push({
        id: `cfe-acompte-${y}`,
        date: acompte,
        label: 'CFE : acompte (si CFE N-1 ≥ 3 000 €)',
        kind: 'cfe',
        amountHint: null,
        legalRef: 'art. 1679 quinquies CGI',
        confidence: 'assumed',
        explain: "Un acompte de 50 % de CFE n'est dû à cette date que si ta CFE de l'an dernier a atteint 3 000 €.",
      });
    }
    const solde = ymd(y, 12, 15);
    if (inWindow(ctx.window, solde)) {
      deadlines.push({
        id: `cfe-solde-${y}`,
        date: solde,
        label: 'CFE : solde',
        kind: 'cfe',
        amountHint: null,
        legalRef: 'art. 1679 quinquies CGI',
        confidence: 'certain',
        explain:
          'La CFE se paie le 15 décembre depuis ton espace professionnel impots.gouv — pas de prélèvement automatique par défaut.',
      });
    }
  }
  return deadlines;
}

function emitComptes(ctx: Ctx): FiscalDeadline[] {
  if (!IS_COMPANY_FORMS.has(ctx.company.legalForm)) return [];
  const form = ctx.company.legalForm;
  const singleOwnerPossible = SINGLE_OWNER_FORMS.has(form);
  const agLegalRef =
    form === 'EURL' ? 'art. L223-31 C. com.' : form === 'SARL' ? 'art. L223-26 C. com.' : 'art. L227-9 C. com.';
  const depotLegalRef = form === 'EURL' || form === 'SARL' ? 'art. L232-22 C. com.' : 'art. L232-23 C. com.';
  const deadlines: FiscalDeadline[] = [];

  for (const close of closingDates(ctx)) {
    const ag = addMonthsClamped(close.y, close.m, close.d, 6);
    if (inWindow(ctx.window, ag)) {
      deadlines.push({
        id: `comptes-ag-${ag}`,
        date: ag,
        label: 'Comptes annuels : approbation',
        kind: 'comptes',
        amountHint: null,
        legalRef: agLegalRef,
        confidence: 'assumed',
        explain: singleOwnerPossible
          ? "Les comptes de l'exercice s'approuvent dans les 6 mois de la clôture — associé unique dirigeant ? Alors le dépôt au greffe vaut approbation, pas d'AG à tenir."
          : "Les comptes de l'exercice doivent être approuvés en assemblée dans les 6 mois qui suivent la clôture.",
      });
    }
    const agYear = yearOf(ag);
    const agMonth = Number(ag.slice(5, 7));
    const agDay = Number(ag.slice(8, 10));
    const depot = addMonthsClamped(agYear, agMonth, agDay, 1);
    if (inWindow(ctx.window, depot)) {
      deadlines.push({
        id: `comptes-depot-${depot}`,
        date: depot,
        label: 'Comptes annuels : dépôt au greffe',
        kind: 'comptes',
        amountHint: null,
        legalRef: depotLegalRef,
        confidence: 'assumed',
        explain: singleOwnerPossible
          ? "Après l'approbation, tu as 1 mois pour déposer les comptes au greffe (2 mois en ligne) — associé unique dirigeant : ce dépôt vaut approbation."
          : "Après l'approbation, tu as 1 mois pour déposer les comptes au greffe (2 mois si tu déposes en ligne).",
      });
    }
  }
  return deadlines;
}

// ── Teinte « première année » ──

function tintFirstYear(explain: string, deadlineYear: number, creationYear: number | null): string {
  if (creationYear === null || deadlineYear !== creationYear) return explain;
  const head = explain.charAt(0);
  const next = explain.charAt(1);
  // On abaisse la première lettre sauf si le mot ouvre sur un sigle (TVA, CFE, IS, URSSAF…).
  const body = next !== '' && next === next.toLowerCase() ? head.toLowerCase() + explain.slice(1) : explain;
  return `Ta première année : ${body}`;
}

// ── Use case ──

/**
 * Dérive l'échéancier fiscal de la société dans [asOf, asOf + horizonDays] (bornes incluses),
 * trié par date croissante ; à date égale, l'ordre est stable : TVA, URSSAF, IS, CFE, comptes.
 */
export function deriveFiscalCalendar(input: DeriveFiscalCalendarInput): FiscalDeadline[] {
  const horizonDays = Math.max(0, Math.trunc(input.horizonDays ?? DEFAULT_HORIZON_DAYS));
  const creationYear = input.company.dateCreation != null ? yearOf(input.company.dateCreation) : null;
  const ctx: Ctx = {
    window: { start: input.asOf, end: addDays(input.asOf, horizonDays) },
    company: input.company,
    yearEnd: parseFiscalYearEnd(input.fiscalYearEnd),
    creationYear,
    urssafPeriodicity: input.urssafPeriodicity ?? null,
  };
  return [...emitTva(ctx), ...emitUrssaf(ctx), ...emitIs(ctx), ...emitCfe(ctx), ...emitComptes(ctx)]
    .map((deadline) => ({
      ...deadline,
      explain: tintFirstYear(deadline.explain, yearOf(deadline.date), creationYear),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

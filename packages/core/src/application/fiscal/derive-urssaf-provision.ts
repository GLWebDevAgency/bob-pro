import { type DateOnly } from '../../shared-kernel/time';
import { type Trade } from '../../domain/company/company';
import {
  acreWindow,
  computeMicroSocialProvision,
  microCategoryFromTrade,
  resolveAcreSocialPct,
  type MicroActivityCategory,
} from '../../domain/fiscal/micro-social';
import { formatEUR } from '../../format/money';
import { type FiscalConfidence, type UrssafPeriodicity } from './derive-fiscal-calendar';

/**
 * Use case pur « provision URSSAF micro » — C-EXP5c (P03 du rapport
 * `docs/architecture/expertise-comptable-roadmap.md`).
 *
 * DOCTRINE « Bob FAIT » : la sortie est une DÉCLARATION PRÉ-CALCULÉE — « du 1er juillet au
 * 30 septembre tu as encaissé 12 400 €, tu déclareras 2 628,80 € au plus tard le 31 octobre » —
 * pas une alerte. Assiette = les paiements ENCAISSÉS (receivedAt) datés de la période de
 * déclaration COURANTE (celle qui contient `asOf`), JAMAIS le facturé (le micro déclare son CA
 * encaissé — art. L613-8 CSS) ; remboursements/avoirs (montants négatifs) déduits.
 *
 * Périodes (mêmes ancres que deriveFiscalCalendar/P03) :
 * · mensuelle      → mois civil de `asOf`, à déclarer le dernier jour du mois suivant ;
 * · trimestrielle  → trimestre civil de `asOf`, à déclarer le dernier jour du mois suivant
 *   (31/1, 30/4, 31/7, 31/10) ;
 * · périodicité inconnue (null) → hypothèse TRIMESTRIELLE (fenêtre la plus large = provision la
 *   plus prudente, elle contient le mois courant), confidence 'assumed', explain invite à préciser.
 *
 * Taux : référentiel annuel versionné du domaine (domain/fiscal/micro-social.ts, D613-4 CSS +
 * VFL art. 151-0 CGI) — année de la période hors table → derniers taux connus + `stale`.
 * Catégorie : `category` explicite (profil) prime ('certain') ; sinon dérivée du métier
 * (microCategoryFromTrade — prudente, jamais silencieuse : 'assumed' propagé).
 *
 * ACRE (C-EXP5d) : entrées ADDITIVES `dateCreation` + `acre` (booléen explicite, JAMAIS deviné —
 * la demande se dépose au plus tard le 60e jour suivant le début d’activité pour les créations à compter du 1/1/2026). `acre: true` + période dans la fenêtre (acreWindow, dérivée de
 * dateCreation) → taux réduit ACRE (resolveAcreSocialPct : plein de l'année déclarée × facteur,
 * marche du 1/7/2026) à la place du taux plein social, VFL cumulable au taux plein ; `acre: true`
 * hors fenêtre → taux plein + explain « ACRE terminée » ; `acre` null/absent → taux plein +
 * `askAcre: true` si dateCreation < 12 mois avant asOf (l'UI posera la question) ; `acre: false`
 * → taux plein, `askAcre: false`. À CHEVAL : chaque encaissement est raté selon SA date vs la
 * fenêtre — mais la fin de fenêtre tombe TOUJOURS sur une borne de trimestre civil (30/6, 30/9,
 * 31/12, 31/3) et les périodes de déclaration sont civiles (mois/trimestre), donc une période est
 * en pratique TOUJOURS entièrement dans ou hors la fenêtre : le vrai « à cheval » ne survient pas.
 *
 * Hors périmètre v1 (documenté) :
 * - décalage de la première déclaration (90 j après la création) — comme deriveFiscalCalendar ;
 * - report d'un solde négatif (remboursements > encaissements) sur la période suivante : le CA
 *   déclaré est plancher 0, sans mécanique de report.
 */

// ── Entrées ──

/** Encaissement daté (PaymentView/socle E3) : DateOnly ou ISO complet, seul le jour compte. */
export interface UrssafPaymentData {
  receivedAt: string;
  /** Centimes — négatif = remboursement/avoir décaissé (déduit du CA de la période). */
  amountCents: number;
}

export interface DeriveUrssafProvisionInput {
  /** Tous les encaissements datés connus — le use case filtre lui-même la période courante. */
  payments: readonly UrssafPaymentData[];
  asOf: DateOnly;
  /** Périodicité de déclaration — null/absent = inconnue : trimestrielle supposée ('assumed'). */
  periodicity?: UrssafPeriodicity | null;
  /** Métier (fiche société) — sert la dérivation prudente de la catégorie d'activité. */
  trade: Trade;
  /** Catégorie micro déclarée au profil — PRIME sur la dérivation métier ('certain'). */
  category?: MicroActivityCategory;
  /** Option versement libératoire (art. 151-0 CGI) — défaut false (option inconnue = non prise). */
  vfl?: boolean;
  /**
   * Date de début d'activité déclarée à l'immatriculation (BDD C24b) — pilote la fenêtre ACRE et
   * le flag askAcre. Absente/null = fenêtre non calculable (pas d'ACRE, pas de question posée).
   */
  dateCreation?: DateOnly | null;
  /**
   * Éligibilité ACRE, JAMAIS devinée (demande au plus tard le 60e jour d’activité — art. L.131-6-4 CSS) : true = bénéficiaire,
   * false = non éligible/refusée, null/absent = inconnu (l'UI demandera si askAcre vaut true).
   */
  acre?: boolean | null;
}

// ── Sortie : la déclaration pré-calculée ──

export interface UrssafProvision {
  /** « T3 2026 » (trimestrielle) ou « juillet 2026 » (mensuelle). */
  periodLabel: string;
  periodStart: DateOnly;
  periodEnd: DateOnly;
  /** CA encaissé de la période, net des remboursements, plancher 0 (le chiffre à déclarer). */
  encaissedCents: number;
  /** Taux social appliqué en % (D613-4 CSS). */
  ratePct: number;
  /** Taux du versement libératoire en % — null si l'option n'est pas prise. */
  vflRatePct: number | null;
  /** Taux total appliqué en % (social + VFL). */
  totalRatePct: number;
  /** Cotisations sociales en centimes. */
  socialCents: number;
  /** Versement libératoire en centimes (0 sans option). */
  vflCents: number;
  /** Total à mettre de côté : social + VFL. */
  provisionCents: number;
  /** Date limite de déclaration/paiement (dernier jour du mois suivant la période). */
  declareBy: DateOnly;
  category: MicroActivityCategory;
  /** 'assumed' dès qu'une hypothèse est posée (périodicité inconnue ou catégorie dérivée). */
  confidence: FiscalConfidence;
  /** true = taux de l'année hors référentiel : derniers connus appliqués (à avertir). */
  stale: boolean;
  /** true = taux réduit ACRE appliqué (acre=true ET période dans la fenêtre d'exonération). */
  acreApplied: boolean;
  /** Fin de la fenêtre ACRE (dernier jour du 3e trimestre civil suivant la création) — null si non calculable. */
  acreWindowEnd: DateOnly | null;
  /** L'UI doit-elle demander l'éligibilité ACRE ? true si `acre` inconnu ET création < 12 mois avant asOf. */
  askAcre: boolean;
  /** Une phrase, voix simple : la déclaration prête (« du X au Y … tu déclareras Z le D »). */
  explain: string;
}

// ── Arithmétique de périodes civiles (UTC maîtrisé, même style que derive-fiscal-calendar) ──

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function ymd(y: number, m: number, d: number): DateOnly {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

interface DeclarationPeriod {
  start: DateOnly;
  end: DateOnly;
  declareBy: DateOnly;
  label: string;
}

const FR_MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
] as const;

/** Dernier jour du mois SUIVANT (y, m) — l'échéance URSSAF mensuelle comme trimestrielle. */
function endOfNextMonth(y: number, m: number): DateOnly {
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return ymd(ny, nm, lastDayOfMonth(ny, nm));
}

/** Période de déclaration courante : celle qui CONTIENT asOf. */
function periodOf(asOf: DateOnly, periodicity: UrssafPeriodicity): DeclarationPeriod {
  const y = Number(asOf.slice(0, 4));
  const m = Number(asOf.slice(5, 7));
  if (periodicity === 'monthly') {
    return {
      start: ymd(y, m, 1),
      end: ymd(y, m, lastDayOfMonth(y, m)),
      declareBy: endOfNextMonth(y, m),
      label: `${FR_MONTHS[m - 1]} ${y}`,
    };
  }
  const quarter = Math.floor((m - 1) / 3); // 0..3
  const endMonth = quarter * 3 + 3;
  return {
    start: ymd(y, quarter * 3 + 1, 1),
    end: ymd(y, endMonth, lastDayOfMonth(y, endMonth)),
    declareBy: endOfNextMonth(y, endMonth),
    label: `T${quarter + 1} ${y}`,
  };
}

/** Même jour, 12 mois plus tôt (année − 1), le jour ramené au dernier du mois si besoin (29/2). */
function minus12Months(asOf: DateOnly): DateOnly {
  const y = Number(asOf.slice(0, 4)) - 1;
  const m = Number(asOf.slice(5, 7));
  const d = Number(asOf.slice(8, 10));
  return ymd(y, m, Math.min(d, lastDayOfMonth(y, m)));
}

/** '2026-07-01' → « 1er juillet » ; withYear → « 31 octobre 2026 ». */
function frDate(date: DateOnly, withYear = false): string {
  const d = Number(date.slice(8, 10));
  const month = FR_MONTHS[Number(date.slice(5, 7)) - 1];
  const day = d === 1 ? '1er' : String(d);
  return withYear ? `${day} ${month} ${date.slice(0, 4)}` : `${day} ${month}`;
}

// ── Use case ──

export function deriveUrssafProvision(input: DeriveUrssafProvisionInput): UrssafProvision {
  const periodicityAssumed = input.periodicity == null;
  const periodicity: UrssafPeriodicity = input.periodicity ?? 'quarterly';
  const period = periodOf(input.asOf, periodicity);

  // Catégorie : la déclaration explicite du profil prime ; sinon dérivation métier prudente.
  const guess = microCategoryFromTrade(input.trade);
  const category = input.category ?? guess.category;
  const categoryAssumed = input.category === undefined && guess.confidence === 'assumed';

  // ── ACRE : fenêtre dérivée de la date de début d'activité, éligibilité JAMAIS devinée ──
  const window = input.dateCreation != null ? acreWindow(input.dateCreation) : null;
  const acreRequested = input.acre === true && window != null && input.dateCreation != null;
  // La période chevauche-t-elle la fenêtre ? Fenêtre et période sont toutes deux bornées par des
  // trimestres/mois civils → en pratique la période est entièrement dedans ou dehors (cf. doc).
  const periodOverlapsWindow =
    window != null && period.start <= window.end && period.end >= window.start;
  const acreApplied = acreRequested && periodOverlapsWindow;
  // Taux ACRE = réduction du taux plein de l'ANNÉE DÉCLARÉE (la période est dans une seule année
  // civile) × facteur lié à la date de création — jamais un taux figé (le BNC plein varie 2025/26).
  const declarationYear = Number(period.start.slice(0, 4));
  const acreRatePct =
    acreRequested && input.dateCreation != null
      ? resolveAcreSocialPct(declarationYear, category, input.dateCreation)
      : null;

  // CA encaissé de la période : seul le JOUR compte (receivedAt DateOnly ou ISO complet),
  // remboursements (négatifs) déduits, plancher 0 — on ne déclare pas un CA négatif. Sous ACRE,
  // chaque encaissement est classé selon SA date vs la fenêtre (art. D.131-6-3 CSS) : dans la
  // fenêtre → taux réduit, hors fenêtre → taux plein. Plancher 0 par bucket (prudent).
  let net = 0;
  let acreNet = 0;
  let fullNet = 0;
  for (const payment of input.payments) {
    const day = payment.receivedAt.slice(0, 10);
    if (day < period.start || day > period.end) continue;
    net += payment.amountCents;
    if (acreApplied && window != null && day >= window.start && day <= window.end) {
      acreNet += payment.amountCents;
    } else {
      fullNet += payment.amountCents;
    }
  }
  const encaissedCents = Math.max(0, net);

  const vfl = input.vfl ?? false;
  const year = declarationYear; // période toujours dans une seule année civile (défini plus haut)
  // Deux lignes de calcul (ACRE + plein) : en l'absence d'« à cheval » réel, l'une est toujours à
  // base 0. VFL cumulable au taux plein dans les deux (l'ACRE ne minore QUE le social).
  const acrePart = computeMicroSocialProvision({
    encaissedCents: Math.max(0, acreNet),
    category,
    vfl,
    year,
    acreRatePct,
  });
  const fullPart = computeMicroSocialProvision({ encaissedCents: Math.max(0, fullNet), category, vfl, year });
  const headline = acreApplied ? acrePart : fullPart; // rate fields représentatifs (voir doc à-cheval)
  const computed = {
    socialRatePct: headline.socialRatePct,
    vflRatePct: headline.vflRatePct,
    totalRatePct: headline.totalRatePct,
    socialCents: acrePart.socialCents + fullPart.socialCents,
    vflCents: acrePart.vflCents + fullPart.vflCents,
    provisionCents: acrePart.provisionCents + fullPart.provisionCents,
    stale: fullPart.stale, // même année → acrePart.stale identique
  };

  // askAcre : on ne DEMANDE que si l'éligibilité est inconnue (acre null/absent) et la création
  // remonte à moins de 12 mois — sinon l'UI n'a rien à poser.
  const askAcre =
    input.acre == null &&
    input.dateCreation != null &&
    input.dateCreation > minus12Months(input.asOf) &&
    input.dateCreation <= input.asOf;

  const acreEndTxt = window != null ? frDate(window.end, true) : '';
  const acreNote = acreApplied
    ? ` Tu bénéficies de l'exonération ACRE : j'applique le taux réduit ACRE jusqu'au ${acreEndTxt}.`
    : acreRequested && !periodOverlapsWindow
      ? ` Ton exonération ACRE est terminée depuis le ${acreEndTxt} : je repasse au taux plein.`
      : '';

  const declareByTxt = frDate(period.declareBy, true);
  const base =
    encaissedCents === 0
      ? `Rien d'encaissé du ${frDate(period.start)} au ${frDate(period.end)} pour l'instant — tu déclareras quand même ton chiffre à l'URSSAF au plus tard le ${declareByTxt}, même à 0 € (la déclaration à zéro reste obligatoire).`
      : `Du ${frDate(period.start)} au ${frDate(period.end)}, tu as encaissé ${formatEUR(encaissedCents)} : mets ${formatEUR(computed.provisionCents)} de côté${vfl ? ' (cotisations + versement libératoire)' : ''}, tu déclareras ce chiffre à l'URSSAF au plus tard le ${declareByTxt}.`;
  const caveats = [
    periodicityAssumed ? " J'ai supposé une déclaration trimestrielle — confirme ta périodicité URSSAF." : '',
    categoryAssumed
      ? " J'ai retenu la catégorie d'activité la plus prudente pour ton métier — confirme-la pour affiner le taux."
      : '',
    computed.stale
      ? ` Les taux ${year} ne sont pas dans mon référentiel : j'applique les derniers taux connus.`
      : '',
  ].join('');

  return {
    periodLabel: period.label,
    periodStart: period.start,
    periodEnd: period.end,
    encaissedCents,
    ratePct: computed.socialRatePct,
    vflRatePct: computed.vflRatePct,
    totalRatePct: computed.totalRatePct,
    socialCents: computed.socialCents,
    vflCents: computed.vflCents,
    provisionCents: computed.provisionCents,
    declareBy: period.declareBy,
    category,
    confidence: periodicityAssumed || categoryAssumed ? 'assumed' : 'certain',
    stale: computed.stale,
    acreApplied,
    acreWindowEnd: window != null ? window.end : null,
    askAcre,
    explain: base + acreNote + caveats,
  };
}

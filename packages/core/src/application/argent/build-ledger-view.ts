import { type InvoiceKind } from '../../domain/billing/invoice/invoice';
import { type InvoiceStatus } from '../../domain/billing/shared/state-machines';
import { type ExpenseStatus } from '../../domain/expense/expense';
import { type LegalForm, type Trade } from '../../domain/company/company';
import { type MicroActivityCategory } from '../../domain/fiscal/micro-social';
import { type DateOnly } from '../../shared-kernel/time';
import { type UrssafPeriodicity } from '../fiscal/derive-fiscal-calendar';
import {
  deriveUrssafProvision,
  type UrssafPaymentData,
  type UrssafProvision,
} from '../fiscal/derive-urssaf-provision';

/**
 * Use case pur « grand-livre du vrai dispo » (claim C11 — « LE SOLDE MENT »).
 * Entrée = agrégats RÉELS tels que servis par l'api-client (factures, dépenses,
 * écritures comptables) ; sortie = lignes SIGNÉES du grand-livre + total + réserve.
 * Aucune I/O, aucun repli fixtures : une source absente (undefined) produit une
 * ligne `null` — l'écran affiche « — », jamais un chiffre inventé (décision A1-C10).
 *
 * Sources par ligne :
 * · solde bancaire        → écritures comptables, comptes de trésorerie (512 banque / 530 caisse) ;
 * · factures attendues    → factures émises encaissables : netToPay − paid (plafond netToPay, jamais ttc) ;
 * · charges & achats      → dépenses « à payer » (TTC) ;
 * · TVA à reverser        → TVA collectée (4457x, écritures de vente) − TVA déductible (dépenses) ;
 * · cotisations sociales  → C-EXP5c (P03) : company MICRO + encaissements datés + asOf fournis
 *   (entrées ADDITIVES, pattern C-EXP2 vA) → provision URSSAF réelle de la période de déclaration
 *   courante (deriveUrssafProvision — CA ENCAISSÉ × taux D613-4 CSS versionnés, option VFL) et la
 *   déclaration pré-calculée exposée en `urssaf` ; données absentes, ou forme non micro (TNS au
 *   réel/IS : aucune source encore — P23/P34) → `null` honnête, comportement historique intact.
 */

// ── Entrées (projections minimales, structurellement compatibles avec les vues api-client) ──

export interface LedgerInvoiceData {
  kind: InvoiceKind;
  status: InvoiceStatus;
  totals: { netToPay: number };
  /** Centimes encaissés cumulés. */
  paid: number;
}

export interface LedgerExpenseData {
  status: ExpenseStatus;
  totalTtcCents: number;
  /** TVA déductible du document d'achat (centimes) — null si inconnue. */
  vatCents: number | null;
}

export interface LedgerEntryLineData {
  account: string;
  debitCents: number;
  creditCents: number;
}

export interface LedgerEntryData {
  lines: readonly LedgerEntryLineData[];
}

/**
 * Fiche société minimale pour la ligne cotisations (C-EXP5c) — seul `legalForm === 'micro'`
 * déclenche la provision URSSAF ; les autres formes restent à `null` (aucune source, P23/P34).
 */
export interface LedgerCompanyData {
  legalForm: LegalForm;
  trade: Trade;
  /** Périodicité de déclaration URSSAF — null/absent = inconnue (trimestrielle supposée, assumed). */
  urssafPeriodicity?: UrssafPeriodicity | null;
  /** Catégorie micro déclarée au profil — prime sur la dérivation métier. */
  microCategory?: MicroActivityCategory;
  /** Option versement libératoire (art. 151-0 CGI) — absent = non prise. */
  vfl?: boolean;
}

/** `undefined` = source indisponible (chargement/erreur) → lignes `null`, jamais 0 inventé. */
export interface BuildLedgerViewInput {
  invoices?: readonly LedgerInvoiceData[] | undefined;
  expenses?: readonly LedgerExpenseData[] | undefined;
  accountingEntries?: readonly LedgerEntryData[] | undefined;
  /** C-EXP5c (ADDITIFS — les trois requis ensemble pour la ligne cotisations d'un micro). */
  company?: LedgerCompanyData | undefined;
  /** Encaissements datés (listPayments, socle E3) — le use case filtre la période courante. */
  payments?: readonly UrssafPaymentData[] | undefined;
  /** Date du jour — ancre la période de déclaration URSSAF courante. */
  asOf?: DateOnly | undefined;
}

// ── Sortie (lignes signées : + = entre, − = sort ; null = donnée absente) ──

export interface LedgerView {
  /** Solde de trésorerie comptable (512/530), signé tel quel. */
  bankCents: number | null;
  /** + Factures clients attendues (avoirs en déduction). */
  receivablesCents: number | null;
  /** − Charges & achats prévus (dépenses à payer, TTC). */
  chargesCents: number | null;
  /** − TVA nette à reverser (collectée − déductible, plancher 0). */
  vatCents: number | null;
  /**
   * − Cotisations sociales : provision URSSAF micro de la période courante (C-EXP5c) quand
   * company micro + payments + asOf sont fournis ; sinon null (« — », jamais un chiffre inventé).
   */
  cotisationsCents: number | null;
  /** Somme des lignes présentes (« Disponible prudent ») — null si aucune ligne. */
  totalCents: number | null;
  /** « À mettre de côté » : TVA due + charges à venir, en valeurs positives. */
  reserve: { vatCents: number | null; chargesCents: number | null };
  /**
   * La déclaration URSSAF pré-calculée (doctrine « Bob FAIT ») derrière cotisationsCents —
   * période, CA encaissé, taux, montant, date limite, explain. null si la ligne est absente.
   */
  urssaf: UrssafProvision | null;
}

// ── Règles métier ──

/** Statuts encore encaissables — aligné sur deriveTodayPriorities (C10). */
const COLLECTIBLE: ReadonlySet<InvoiceStatus> = new Set(['issued', 'partially_paid', 'late']);

/** Comptes de trésorerie du plan par défaut (payment-accounting) : 512 banque, 530 caisse. */
const TREASURY_PREFIXES = ['512', '530'] as const;

/** Comptes de TVA collectée (invoice-accounting : 44571 + subdivisions). */
const VAT_COLLECTED_PREFIX = '4457';

function isTreasury(account: string): boolean {
  return TREASURY_PREFIXES.some((prefix) => account.startsWith(prefix));
}

function sumEntryLines(
  entries: readonly LedgerEntryData[],
  match: (account: string) => boolean,
  side: 'debit' | 'credit',
): number {
  let total = 0;
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (!match(line.account)) continue;
      total += side === 'debit' ? line.debitCents - line.creditCents : line.creditCents - line.debitCents;
    }
  }
  return total;
}

/** Négation sans « -0 » (Object.is(-0, 0) est faux : piège d'égalité et d'affichage). */
function negate(cents: number): number {
  return cents === 0 ? 0 : -cents;
}

/** Reste à encaisser d'une facture : plafonné à netToPay (jamais ttc) ; avoirs en négatif. */
function receivableCents(invoice: LedgerInvoiceData): number {
  if (!COLLECTIBLE.has(invoice.status)) return 0;
  const remaining = Math.max(0, invoice.totals.netToPay - invoice.paid);
  return invoice.kind === 'credit_note' ? -remaining : remaining;
}

/**
 * Dérive la vue « Argent disponible réel » :
 * total = solde bancaire + Σ rangées signées (les lignes absentes ne comptent pas).
 * La prudence tient au périmètre : TOUT ce qui doit sortir (charges, TVA) est déduit
 * intégralement, sans pondération optimiste des encaissements.
 */
export function buildLedgerView(input: BuildLedgerViewInput): LedgerView {
  const bankCents =
    input.accountingEntries === undefined ? null : sumEntryLines(input.accountingEntries, isTreasury, 'debit');

  const receivablesCents =
    input.invoices === undefined
      ? null
      : input.invoices.reduce((sum, invoice) => sum + receivableCents(invoice), 0);

  const chargesCents =
    input.expenses === undefined
      ? null
      : negate(
          input.expenses.reduce(
            (sum, expense) => sum + (expense.status === 'to_pay' ? expense.totalTtcCents : 0),
            0,
          ),
        );

  // TVA nette : les DEUX jambes se lisent au GRAND-LIVRE depuis le cycle achats E1
  // (collectée 4457x au crédit, déductible 44566/44562 au débit) — une seule source de
  // vérité, plus jamais la déductible relue sur les objets Expense (audit chantier 2).
  let vatCents: number | null = null;
  if (input.accountingEntries !== undefined && input.expenses !== undefined) {
    const collected = sumEntryLines(
      input.accountingEntries,
      (account) => account.startsWith(VAT_COLLECTED_PREFIX),
      'credit',
    );
    const deductible = sumEntryLines(
      input.accountingEntries,
      (account) => account.startsWith('44566') || account.startsWith('44562'),
      'debit',
    );
    vatCents = negate(Math.max(0, collected - deductible)); // plancher 0
  }

  // Cotisations sociales (C-EXP5c) : provision URSSAF réelle si la company est MICRO et que les
  // encaissements datés + la date du jour sont fournis — sinon ligne absente (« — »), y compris
  // pour les formes non micro (TNS au réel / IS : aucune source encore, P23/P34).
  let urssaf: UrssafProvision | null = null;
  if (
    input.company !== undefined &&
    input.company.legalForm === 'micro' &&
    input.payments !== undefined &&
    input.asOf !== undefined
  ) {
    urssaf = deriveUrssafProvision({
      payments: input.payments,
      asOf: input.asOf,
      periodicity: input.company.urssafPeriodicity ?? null,
      trade: input.company.trade,
      ...(input.company.microCategory !== undefined ? { category: input.company.microCategory } : {}),
      ...(input.company.vfl !== undefined ? { vfl: input.company.vfl } : {}),
    });
  }
  const cotisationsCents: number | null = urssaf === null ? null : negate(urssaf.provisionCents);

  const lines = [bankCents, receivablesCents, chargesCents, vatCents, cotisationsCents];
  const present = lines.filter((cents): cents is number => cents !== null);
  const totalCents = present.length === 0 ? null : present.reduce((sum, cents) => sum + cents, 0);

  return {
    bankCents,
    receivablesCents,
    chargesCents,
    vatCents,
    cotisationsCents,
    totalCents,
    reserve: {
      vatCents: vatCents === null ? null : negate(vatCents),
      chargesCents: chargesCents === null ? null : negate(chargesCents),
    },
    urssaf,
  };
}

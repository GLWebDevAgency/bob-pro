import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain } from '../result';
import {
  projectCashflow,
  type Scenario,
  type Horizon,
  type CashflowProjection,
} from '../../domain/services/project-cashflow';
import { type CashflowSnapshotPort } from '../ports/services';
import { type ClockPort } from '../ports/services';
import { type ExpenseRepository, type InvoiceRepository } from '../ports/repositories';
import { deriveVatPosition } from '../argent/derive-vat-position';
import { type Expense } from '../../domain/expense/expense';
import { addDays, parisDateOnly } from '../../shared-kernel/time';

const SCENARIOS: readonly Scenario[] = ['optimiste', 'realiste', 'prudent'];
const HORIZONS: readonly Horizon[] = [7, 30, 60, 90];

function parseScenario(value: unknown): Result<Scenario, AppError> {
  if (typeof value === 'string' && SCENARIOS.includes(value as Scenario))
    return ok(value as Scenario);
  return err(
    appDomain({
      code: 'VALIDATION',
      field: 'scenario',
      message: 'Scenario de trésorerie invalide.',
    }),
  );
}

function parseHorizon(value: unknown): Result<Horizon, AppError> {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (HORIZONS.includes(n as Horizon)) return ok(n as Horizon);
  return err(
    appDomain({ code: 'VALIDATION', field: 'horizon', message: 'Horizon de trésorerie invalide.' }),
  );
}

export class GetCashflow {
  constructor(
    private readonly deps: {
      snapshots: CashflowSnapshotPort;
      expenses?: Pick<ExpenseRepository, 'listByCompany'>;
      /** Fournir les factures = position de TVA RÉELLE (deriveVatPosition, chantier 2) ;
       *  sans elles, repli sur le vatDue du snapshot (compat implémentations amont). */
      invoices?: Pick<InvoiceRepository, 'listByCompany'>;
      /** Obligatoire avec invoices+expenses pour une projection bornée par les échéances. */
      clock?: ClockPort;
    },
  ) {}

  async execute(input: {
    companyId: string;
    scenario: unknown;
    horizon: unknown;
  }): Promise<Result<CashflowProjection, AppError>> {
    const scenario = parseScenario(input.scenario);
    if (!scenario.ok) return scenario;
    const horizon = parseHorizon(input.horizon);
    if (!horizon.ok) return horizon;

    const snapshot = await this.deps.snapshots.get(input.companyId);
    let charges = snapshot.charges;
    let receivables = snapshot.receivables;
    let expenseList: Expense[] = [];
    if (this.deps.expenses) {
      expenseList = await this.deps.expenses.listByCompany(input.companyId);
    }

    let vatDue = snapshot.vatDue ?? 0;
    const invoiceList = this.deps.invoices
      ? await this.deps.invoices.listByCompany(input.companyId)
      : [];
    if (this.deps.invoices) {
      // TVA à provisionner DÉRIVÉE (collectée sur ENCAISSEMENTS − déductible mentionnée) :
      // le même chiffre ampute la dispo, calibre la réserve du payout ET alimente le KPI.
      vatDue = deriveVatPosition({
        invoices: invoiceList.map((i) => ({
          kind: i.kind,
          status: i.status,
          totals: i.totals(),
          paid: i.paid,
        })),
        expenses: expenseList.map((e) => ({ vatCents: e.toProps().vatCents })),
      }).netDueCents;
    }

    let datedBasis:
      | {
          kind: 'dated_documents';
          asOf: string;
          horizonEnd: string;
          receivablesIncludedCents: number;
          receivablesAfterHorizonCents: number;
          receivablesUndatedCents: number;
          chargesIncludedCents: number;
          chargesAfterHorizonCents: number;
          chargesUndatedIncludedCents: number;
        }
      | undefined;

    if (this.deps.clock && this.deps.invoices && this.deps.expenses) {
      // Audit correction 3 (timezone Argent) : `clock.today()` (SystemClock, UTC brut) désaligne
      // ce bloc du grand-livre/URSSAF de l'écran Argent (mobile, jour Europe/Paris) pendant la
      // fenêtre où Paris a déjà changé de jour mais pas l'UTC (~1-2 h après minuit local). Le
      // « jour métier » d'un artisan français est le jour LOCAL Europe/Paris (même décision que
      // digest.service.ts pour la fenêtre hebdo) : parisDateOnly() dérive ce jour depuis l'instant
      // courant, DST-safe, sans changer le contrat `ClockPort.today()` utilisé ailleurs (numéros
      // de facture, échéances par défaut…) pour ne pas élargir le rayon d'impact de ce correctif.
      const asOf = parisDateOnly(this.deps.clock.now());
      const horizonEnd = addDays(asOf, horizon.value);
      let dueReceivables = 0;
      let afterHorizonReceivables = 0;
      let undatedReceivables = 0;
      let credits = 0;
      for (const invoice of invoiceList) {
        if (!['issued', 'partially_paid', 'late'].includes(invoice.status)) continue;
        const remaining = invoice.totals().netToPay - invoice.paid;
        if (!Number.isSafeInteger(remaining) || remaining < 0) {
          return err({
            kind: 'unavailable',
            service: 'cashflow-financial-data',
          });
        }
        if (invoice.kind === 'credit_note') {
          credits += remaining;
        } else if (invoice.dueAt === null) {
          undatedReceivables += remaining;
        } else if (invoice.dueAt <= horizonEnd) {
          dueReceivables += remaining;
        } else {
          afterHorizonReceivables += remaining;
        }
      }
      if (
        !Number.isSafeInteger(dueReceivables) ||
        !Number.isSafeInteger(afterHorizonReceivables) ||
        !Number.isSafeInteger(undatedReceivables) ||
        !Number.isSafeInteger(credits)
      ) {
        return err({ kind: 'unavailable', service: 'cashflow-financial-data' });
      }
      receivables = Math.max(0, dueReceivables - credits);

      let dueCharges = 0;
      let afterHorizonCharges = 0;
      let undatedCharges = 0;
      for (const expense of expenseList) {
        if (expense.status !== 'to_pay') continue;
        if (expense.dueAt === null) undatedCharges += expense.totalTtcCents;
        else if (expense.dueAt <= horizonEnd) dueCharges += expense.totalTtcCents;
        else afterHorizonCharges += expense.totalTtcCents;
      }
      if (
        !Number.isSafeInteger(dueCharges) ||
        !Number.isSafeInteger(afterHorizonCharges) ||
        !Number.isSafeInteger(undatedCharges)
      ) {
        return err({ kind: 'unavailable', service: 'cashflow-financial-data' });
      }
      // Une charge sans échéance reste incluse par prudence et est exposée comme telle dans
      // la base de calcul. Une créance sans échéance, elle, n'est jamais supposée encaissée.
      charges += dueCharges + undatedCharges;
      datedBasis = {
        kind: 'dated_documents',
        asOf,
        horizonEnd,
        receivablesIncludedCents: receivables,
        receivablesAfterHorizonCents: afterHorizonReceivables,
        receivablesUndatedCents: undatedReceivables,
        chargesIncludedCents: charges,
        chargesAfterHorizonCents: afterHorizonCharges,
        chargesUndatedIncludedCents: undatedCharges,
      };
    } else if (this.deps.expenses) {
      // Compatibilité des adapters de test sans horloge : agrégat explicitement marqué legacy.
      charges += expenseList
        .filter((expense) => expense.status === 'to_pay')
        .reduce((sum, expense) => sum + expense.totalTtcCents, 0);
    }

    return ok(
      projectCashflow(
        {
          bankBalance: snapshot.bankBalance,
          receivables,
          charges,
          vatDue,
          ...(datedBasis ? { datedBasis } : {}),
        },
        scenario.value,
        horizon.value,
      ),
    );
  }
}

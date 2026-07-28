import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type DateOnly, addDays, parisDateOnly } from '../../shared-kernel/time';
import { type Totals } from '../../domain/billing/shared/totals';
import {
  contractAnnualTotals,
  contractLinesToLineInputs,
  type ContractPeriod,
} from '../../domain/contract/maintenance-contract';
import {
  currentPeriod,
  deriveAnnualBillingDue,
  periodCoverage,
} from './derive-contract-schedule';
import {
  type ContractInvoicesReadPort,
  type MaintenanceContractRepository,
} from './maintenance-contract-repository';
import { type ComposeStandaloneInvoice } from '../billing/compose-standalone-invoice';
import { type ClockPort } from '../ports/services';

export interface PrepareAnnualInvoiceDraftInput {
  companyId: string;
  contractId: string;
}

export interface PrepareAnnualInvoiceDraftDeps {
  contracts: MaintenanceContractRepository;
  contractInvoices: ContractInvoicesReadPort;
  /** La composition EXISTANTE — tous ses invariants (B2C urgence, international, TVA
   * re-suggérée au jour du brouillon) s'appliquent tels quels, jamais contournés. */
  compose: ComposeStandaloneInvoice;
  clock: ClockPort;
}

export interface PrepareAnnualInvoiceDraftOutput {
  invoiceId: string;
  /** Période contractuelle couverte (fin EXCLUSIVE — l'affichage montre la veille). */
  period: ContractPeriod;
  /** Période de SERVICE écrite au brouillon (bornes humaines : fin INCLUSIVE). */
  servicePeriod: { start: DateOnly; end: DateOnly };
  totals: Totals;
  /** Σ lignes du contrat au jour du brouillon — l'écran affiche l'écart s'il existe
   * (« TVA recalculée au régime actuel : total X au lieu de Y », amélioration 2). */
  contractTotals: Totals;
  vatDivergence: boolean;
}

/**
 * §2.6 — « Prépare la facture annuelle » : BROUILLON en un tap, jamais émis, jamais envoyé
 * seul. Gardes : contrat `active`, ≥ 1 ligne, `deriveAnnualBillingDue` VRAIE (refus
 * actionnable AVEC le numéro couvrant sinon). Délègue à ComposeStandaloneInvoice ÉTENDU
 * (contractAttachment) : catégorie 'subscription' posée sur chaque ligne, TVA repassée par
 * suggestVatRate AU JOUR DU BROUILLON (bascule de régime → refus actionnable propagé, jamais
 * un taux réécrit en silence). L'idempotence de PÉRIODE vit dans IssueInvoice (verrou contrat,
 * direction 1) — deux brouillons peuvent coexister, deux ÉMISSIONS jamais.
 */
export class PrepareAnnualInvoiceDraft {
  constructor(private readonly deps: PrepareAnnualInvoiceDraftDeps) {}

  async execute(
    input: PrepareAnnualInvoiceDraftInput,
  ): Promise<Result<PrepareAnnualInvoiceDraftOutput, AppError>> {
    const contract = await this.deps.contracts.findById(input.companyId, input.contractId);
    if (!contract || contract.companyId !== input.companyId)
      return err(appNotFound('maintenance_contract', input.contractId));
    if (contract.status !== 'active')
      return err(
        appDomain({
          code: 'VALIDATION',
          field: 'status',
          message:
            contract.status === 'draft'
              ? 'Active d’abord le contrat : un brouillon ne se facture pas.'
              : 'Contrat résilié : plus aucune facture annuelle à préparer.',
        }),
      );
    if (contract.lines.length === 0)
      return err(
        appDomain({
          code: 'VALIDATION',
          field: 'lines',
          message: 'Ajoute au moins une ligne au contrat avant de préparer la facture annuelle.',
        }),
      );

    const today = parisDateOnly(this.deps.clock.now());
    const schedule = {
      status: contract.status,
      anniversaryDate: contract.anniversaryDate,
      tacitRenewal: contract.tacitRenewal,
      importCoveredUntil: contract.importCoveredUntil,
      terminationEffectiveDate: contract.terminationEffectiveDate,
    };
    const projections = await this.deps.contractInvoices.listByMaintenanceContract(
      input.companyId,
      input.contractId,
    );
    const due = deriveAnnualBillingDue(schedule, projections, today);
    if (due === null) {
      // Refus ACTIONNABLE avec le fait réel : le numéro couvrant, ou la couverture migrée.
      const period = currentPeriod(schedule, today);
      if (period !== null) {
        const coverage = periodCoverage(schedule, period, projections);
        if (coverage.kind === 'covered') {
          const by =
            coverage.by === 'invoice' && coverage.number !== null
              ? `la facture ${coverage.number}`
              : coverage.by === 'invoice'
                ? 'une facture émise'
                : 'la facturation déclarée avant Bob (« déjà facturé jusqu’au »)';
          return err(
            appDomain({
              code: 'VALIDATION',
              field: 'period',
              message: `Période ${period.start} → ${addDays(period.end, -1)} déjà couverte par ${by}.`,
            }),
          );
        }
      }
      return err(
        appDomain({
          code: 'VALIDATION',
          field: 'period',
          message:
            'Aucune période à facturer aujourd’hui — la fenêtre s’ouvre 30 jours avant chaque échéance.',
        }),
      );
    }

    const servicePeriod = { start: due.period.start, end: addDays(due.period.end, -1) };
    const composed = await this.deps.compose.execute({
      companyId: input.companyId,
      customerId: contract.customerId,
      // Catégorie 'subscription' posée sur CHAQUE ligne (contractLinesToLineInputs) — PR-14.
      lines: contractLinesToLineInputs(contract.lines),
      ...(contract.chantierId !== null ? { chantierId: contract.chantierId } : {}),
      contractAttachment: {
        maintenanceContractId: contract.id,
        servicePeriod,
      },
    });
    if (!composed.ok) return err(composed.error);
    const contractTotals = contractAnnualTotals([...contract.lines]);
    const vatDivergence =
      composed.value.totals.ttc !== contractTotals.ttc
      || composed.value.totals.vat !== contractTotals.vat;
    return ok({
      invoiceId: composed.value.invoiceId,
      period: due.period,
      servicePeriod,
      totals: composed.value.totals,
      contractTotals,
      vatDivergence,
    });
  }
}

import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { parisDateOnly } from '../../shared-kernel/time';
import { type LineInput } from '../../domain/billing/shared/line-item';
import { type Totals } from '../../domain/billing/shared/totals';
import { type ComposeStandaloneInvoice } from '../billing/compose-standalone-invoice';
import { type InvoiceRepository } from '../ports/repositories';
import { type EquipmentRepository } from '../equipment/equipment-repository';
import { type ChantierRepository } from '../ports/repositories';
import { type InterventionRepository } from './intervention-repository';

/** Message UNIQUE du refus « visite contractuelle » (écran ET voix) — direction 6 :
 * `contractId` est le SEUL discriminant, la facture annuelle couvre déjà le passage. */
export const CONTRACT_VISIT_NOT_BILLABLE_MESSAGE =
  'Visite contractuelle : ce passage est couvert par la facture annuelle du contrat — il ne se facture pas à part.';

export interface PrepareInterventionInvoiceDraftInput {
  companyId: string;
  interventionId: string;
  /**
   * Lignes choisies (catalogue) — absentes : UNE ligne de référence du passage à 0 €,
   * éditable au brouillon (le montant reste un choix de l'artisan, jamais inventé).
   */
  lines?: LineInput[];
  /** A3bis — un dépannage B2C exige l'urgence qualifiée : la garde standalone s'applique
   * INTÉGRALEMENT (rien n'est contourné — LegalHint « passe par un devis » sinon). */
  urgentOnSiteRepair?: boolean;
  context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean };
}

export interface PrepareInterventionInvoiceDraftOutput {
  invoiceId: string;
  totals: Totals;
}

export interface PrepareInterventionInvoiceDraftDeps {
  interventions: InterventionRepository;
  invoices: Pick<InvoiceRepository, 'findById'>;
  chantiers: ChantierRepository;
  equipments?: EquipmentRepository;
  /** Le brouillon repasse par TOUS les invariants d'émission : AUCUN chemin parallèle. */
  compose: Pick<ComposeStandaloneInvoice, 'execute'>;
}

/**
 * PR-16 — CTA « Facturer ce passage » : BROUILLON de facture directe pré-rempli depuis
 * l'intervention (client, site, référence du passage en libellé de ligne) via
 * `ComposeStandaloneInvoice` — gardes B2C/international/TVA INTÉGRALEMENT re-passées.
 * Passage HORS CONTRAT uniquement ; un passage déjà facturé (facture liée non annulée) est
 * refusé avec la pièce citée — l'annulation rallume le droit (extinction par l'état réel).
 */
export class PrepareInterventionInvoiceDraft {
  constructor(private readonly deps: PrepareInterventionInvoiceDraftDeps) {}

  async execute(
    input: PrepareInterventionInvoiceDraftInput,
  ): Promise<Result<PrepareInterventionInvoiceDraftOutput, AppError>> {
    const intervention = await this.deps.interventions.findById(input.companyId, input.interventionId);
    if (!intervention || intervention.companyId !== input.companyId)
      return err(appNotFound('intervention', input.interventionId));
    if (intervention.status !== 'completed' && intervention.status !== 'signed')
      return err(
        appDomain({
          code: 'VALIDATION',
          field: 'status',
          message: 'Un passage se facture une fois terminé (ou signé).',
        }),
      );
    if (intervention.contractId !== null)
      return err(
        appDomain({
          code: 'VALIDATION',
          field: 'contractId',
          message: CONTRACT_VISIT_NOT_BILLABLE_MESSAGE,
        }),
      );

    // Déjà facturé ? Le fait est DÉRIVÉ de la pièce réelle non annulée — un brouillon
    // supprimé (lien détaché) ou une facture annulée rallument le droit.
    if (intervention.billedInvoiceId !== null) {
      const billed = await this.deps.invoices.findById(intervention.billedInvoiceId);
      if (billed && billed.companyId === input.companyId && billed.status !== 'cancelled') {
        return err(
          appDomain({
            code: 'VALIDATION',
            field: 'billedInvoiceId',
            message: billed.number
              ? `Ce passage a déjà sa facture (${billed.number}) — annule-la (avoir) avant d'en refaire une.`
              : 'Ce passage a déjà un brouillon de facture — ouvre-le ou supprime-le avant d’en refaire un.',
          }),
        );
      }
    }

    // Référence LISIBLE du passage en libellé de ligne (roadmap C3) quand rien n'est fourni.
    let lines = input.lines;
    if (lines === undefined || lines.length === 0) {
      const chantier = await this.deps.chantiers.findById(intervention.chantierId);
      const site = chantier && chantier.companyId === input.companyId ? chantier.name : null;
      let equipmentLabel: string | null = null;
      if (intervention.equipmentId !== null && this.deps.equipments) {
        const equipment = await this.deps.equipments.findById(input.companyId, intervention.equipmentId);
        equipmentLabel = equipment?.label ?? null;
      }
      const anchor = intervention.finishedAt;
      const dateOnly = anchor === null ? null : parisDateOnly(anchor);
      const dateFr = dateOnly === null ? null : `${dateOnly.slice(8, 10)}/${dateOnly.slice(5, 7)}/${dateOnly.slice(0, 4)}`;
      const label = [
        intervention.kind,
        site !== null ? `site ${site}` : null,
        equipmentLabel,
        dateFr !== null ? `le ${dateFr}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' — ');
      lines = [{ label, category: 'labor', qty: 1, unitPriceHT: 0, vatRate: 20 }];
    }

    const composed = await this.deps.compose.execute({
      companyId: input.companyId,
      customerId: intervention.customerId,
      lines,
      chantierId: intervention.chantierId,
      ...(input.urgentOnSiteRepair !== undefined ? { urgentOnSiteRepair: input.urgentOnSiteRepair } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
    });
    if (!composed.ok) return composed;

    const attached = intervention.attachBilledInvoice(composed.value.invoiceId);
    if (!attached.ok) return err(appDomain(attached.error));
    await this.deps.interventions.save(intervention);

    return ok({ invoiceId: composed.value.invoiceId, totals: composed.value.totals });
  }
}

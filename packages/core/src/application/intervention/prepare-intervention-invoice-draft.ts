import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { parisDateOnly } from '../../shared-kernel/time';
import { type LineCategory, type LineInput } from '../../domain/billing/shared/line-item';
import { type VatRate } from '../../domain/billing/shared/vat-rate';
import { type Totals } from '../../domain/billing/shared/totals';
import { type Company } from '../../domain/company/company';
import { type Customer } from '../../domain/customer/customer';
import { suggestVatRate } from '../../domain/services/suggest-vat-rate';
import { type ComposeStandaloneInvoice } from '../billing/compose-standalone-invoice';
import { type InvoiceRepository } from '../ports/repositories';
import { type EquipmentRepository } from '../equipment/equipment-repository';
import {
  type ChantierRepository,
  type CompanyRepository,
  type CustomerRepository,
} from '../ports/repositories';
import { type UnitOfWorkPort } from '../ports/services';
import { type InterventionRepository } from './intervention-repository';
import { TxAppError } from './intervention-mutation';

/** Message UNIQUE du refus « visite contractuelle » (écran ET voix) — direction 6 :
 * `contractId` est le SEUL discriminant, la facture annuelle couvre déjà le passage. */
export const CONTRACT_VISIT_NOT_BILLABLE_MESSAGE =
  'Visite contractuelle : ce passage est couvert par la facture annuelle du contrat — il ne se facture pas à part.';

/** Catégorie de la ligne de référence du passage (main-d'œuvre) — le montant reste un choix. */
const DEFAULT_LINE_CATEGORY: LineCategory = 'labor';

/** Taux normal — proposé UNIQUEMENT quand le régime réel de la société l'autorise. */
const STANDARD_VAT_RATE: VatRate = 20;

/**
 * [Revue adversariale 28/07 — finding 2] Taux de TVA de la ligne de référence DÉRIVÉ du régime
 * réel via `suggestVatRate`, jamais un `20` littéral : la franchise en base (art. 293 B), la
 * sous-traitance BTP autoliquidée et les débours (art. 267, II-2°) imposent 0 — un 20 codé en
 * dur faisait refuser le CTA « Facturer ce passage » à 100 % pour ces tenants (micro et
 * auto-entrepreneurs en franchise : le public majoritaire), écran ET voix.
 * La règle fiscale n'est PAS dupliquée ici : on demande 0 au service de domaine ; s'il
 * l'accepte, c'est qu'il l'impose ; sinon le taux normal est le bon défaut.
 */
export function defaultInterventionLineVatRate(
  company: Company,
  customer: Customer,
  context?: { housingOlderThan2y?: boolean; energyRenovation?: boolean },
): VatRate {
  const zeroImposed = suggestVatRate({
    company,
    customer,
    category: DEFAULT_LINE_CATEGORY,
    requestedRate: 0,
    ...(context !== undefined ? { context } : {}),
  });
  return zeroImposed.ok ? 0 : STANDARD_VAT_RATE;
}

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
  /** Régime de TVA réel de la société — source du taux par défaut (jamais un littéral). */
  companies: Pick<CompanyRepository, 'findById'>;
  /** Client du passage — autoliquidation BTP et type b2b/b2c pèsent sur le taux imposé. */
  customers: Pick<CustomerRepository, 'findById'>;
  equipments?: EquipmentRepository;
  /** Le brouillon repasse par TOUS les invariants d'émission : AUCUN chemin parallèle. */
  compose: Pick<ComposeStandaloneInvoice, 'execute'>;
  /**
   * [Revue adversariale 28/07 — finding 3] Le geste ENTIER (relecture du lien → composition →
   * rattachement → save) vit dans UNE transaction, la fiche VERROUILLÉE (`lockById`) comme
   * Start/Complete/Sign/Update. Sans lui, deux appels concurrents (deux appareils, voix + UI,
   * double tap) créaient DEUX brouillons dont un orphelin — hors de portée de la garde « ce
   * passage a déjà sa facture », donc émissible en plus du premier (double facturation).
   */
  uow: UnitOfWorkPort;
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
    try {
      const output = await this.deps.uow.runInTransaction(() => this.prepareLocked(input));
      return ok(output);
    } catch (e) {
      if (e instanceof TxAppError) return err(e.appError);
      throw e;
    }
  }

  /** À exécuter DANS la transaction : la fiche est verrouillée avant toute décision. */
  private async prepareLocked(
    input: PrepareInterventionInvoiceDraftInput,
  ): Promise<PrepareInterventionInvoiceDraftOutput> {
    // Verrou de ligne (SELECT … FOR UPDATE) : la garde « déjà facturé » est relue SOUS le
    // verrou, donc le second appel concurrent la voit — jamais deux brouillons.
    const load =
      this.deps.interventions.lockById?.bind(this.deps.interventions) ??
      this.deps.interventions.findById.bind(this.deps.interventions);
    const intervention = await load(input.companyId, input.interventionId);
    if (!intervention || intervention.companyId !== input.companyId)
      throw new TxAppError(appNotFound('intervention', input.interventionId));
    if (intervention.status !== 'completed' && intervention.status !== 'signed')
      throw new TxAppError(
        appDomain({
          code: 'VALIDATION',
          field: 'status',
          message: 'Un passage se facture une fois terminé (ou signé).',
        }),
      );
    if (intervention.contractId !== null)
      throw new TxAppError(
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
        throw new TxAppError(
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

      // Taux DÉRIVÉ du régime réel (franchise 293 B / autoliquidation / débours → 0).
      const company = await this.deps.companies.findById(input.companyId);
      if (!company) throw new TxAppError(appNotFound('company', input.companyId));
      const customer = await this.deps.customers.findById(intervention.customerId);
      if (!customer || customer.companyId !== input.companyId)
        throw new TxAppError(appNotFound('customer', intervention.customerId));
      const vatRate = defaultInterventionLineVatRate(company, customer, input.context);
      lines = [{ label, category: DEFAULT_LINE_CATEGORY, qty: 1, unitPriceHT: 0, vatRate }];
    }

    const composed = await this.deps.compose.execute({
      companyId: input.companyId,
      customerId: intervention.customerId,
      lines,
      chantierId: intervention.chantierId,
      ...(input.urgentOnSiteRepair !== undefined ? { urgentOnSiteRepair: input.urgentOnSiteRepair } : {}),
      ...(input.context !== undefined ? { context: input.context } : {}),
    });
    // Rollback COMPLET : un refus de composition ne laisse jamais de brouillon non lié.
    if (!composed.ok) throw new TxAppError(composed.error);

    const attached = intervention.attachBilledInvoice(composed.value.invoiceId);
    if (!attached.ok) throw new TxAppError(appDomain(attached.error));
    await this.deps.interventions.save(intervention);

    return { invoiceId: composed.value.invoiceId, totals: composed.value.totals };
  }
}

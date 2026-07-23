import { type Result, ok, err } from '../../shared-kernel/result';
import { parisDateOnly } from '../../shared-kernel/time';
import { type AppError, appDomain, appNotFound } from '../result';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';
import { type CompanyRepository, type ExpenseRepository } from '../ports/repositories';
import { type DocumentLinkTargetPort } from '../ports/document-link-target';
import { Expense, type ExpenseCategory, type ExpenseSource } from '../../domain/expense/expense';
import { type PaymentMethod } from '../../domain/payment/payment';

/**
 * Règlement DÉJÀ effectué au moment de la création (ticket de caisse scanné, par exemple) :
 * la dépense naît PAYÉE avec sa preuve (chaîne paymentEvidence) au lieu d'un « à payer »
 * absurde qu'il faudrait re-payer. Sans cette déclaration, la dépense reste à payer.
 */
export interface RecordExpensePaymentDeclaration {
  paidOn: string;
  method: PaymentMethod;
  reference?: string | null;
  /** Pièce du coffre qui justifie le règlement — le scan lui-même pour un ticket. */
  proofDocumentId?: string | null;
}

export interface RecordExpenseInput {
  companyId: string;
  /**
   * Clé opaque possédée par l'appelant pour rejouer une création sans doublon.
   * Le domaine ne la persiste pas : les adaptateurs serveur/local n'en conservent qu'une empreinte.
   */
  idempotencyKey?: string | null;
  supplierName: string;
  supplierSiren?: string | null;
  documentDate: string;
  totalTtcCents: number;
  totalHtCents?: number | null;
  vatCents?: number | null;
  vatRatePct?: number | null;
  category: ExpenseCategory;
  source?: ExpenseSource;
  /** N° de facture fournisseur (Factur-X BT-1, C-EXP6b) — optionnel, additif. */
  supplierInvoiceNumber?: string | null;
  /** Échéance fournisseur (Factur-X BT-9, C-EXP6b) — optionnelle, additive. */
  dueAt?: string | null;
  /** Présent → la dépense est créée PAYÉE avec cette preuve ; absent/null → « à payer ». */
  payment?: RecordExpensePaymentDeclaration | null;
  /**
   * Chantier d'imputation (rentabilité par chantier) — OPTIONNEL, additif : le flux scan le
   * pose directement quand la destination chantier est choisie. Fourni, il est PROUVÉ dans le
   * tenant via `deps.chantierTargets` (anti-IDOR) avant toute persistance ; absent/null →
   * dépense hors chantier (comportement historique intact).
   */
  chantierId?: string | null;
}

/**
 * Intention métier canonique utilisée pour comparer deux retries. Les valeurs optionnelles sont
 * ramenées aux mêmes défauts que `Expense.record`, afin qu'une différence de forme JSON ne crée
 * pas un faux conflit et qu'une vraie différence comptable reste détectable.
 */
export function canonicalRecordExpensePayload(input: Omit<RecordExpenseInput, 'companyId'>) {
  return {
    supplierName: input.supplierName.trim(),
    supplierSiren: input.supplierSiren?.replace(/\s/g, '') || null,
    documentDate: input.documentDate,
    totalTtcCents: input.totalTtcCents,
    totalHtCents: input.totalHtCents ?? null,
    vatCents: input.vatCents ?? null,
    vatRatePct: input.vatRatePct ?? null,
    category: input.category,
    source: input.source ?? 'manual',
    supplierInvoiceNumber: input.supplierInvoiceNumber?.trim() || null,
    dueAt: input.dueAt ?? null,
    // Additif (même doctrine que `payment`) : la clé n'apparaît que si un chantier est visé,
    // pour que l'empreinte d'une création hors chantier reste identique aux versions antérieures.
    ...(input.chantierId?.trim() ? { chantierId: input.chantierId.trim() } : {}),
    // Additif : la clé n'apparaît que si un règlement est déclaré, afin que l'empreinte
    // d'une création « à payer » reste identique à celle des versions antérieures
    // (un retry qui traverse un déploiement ne doit jamais devenir un faux conflit).
    ...(input.payment
      ? {
          payment: {
            paidOn: input.payment.paidOn,
            method: input.payment.method,
            reference: input.payment.reference?.trim() || null,
            proofDocumentId: input.payment.proofDocumentId?.trim() || null,
          },
        }
      : {}),
  };
}

export interface RecordExpenseDeps {
  expenses: ExpenseRepository;
  /**
   * Source tenant de la qualification TVA. Requise structurellement : une dépense ne doit pas
   * entrer dans le cycle comptable sans entreprise qualifiée.
   */
  companies: Pick<CompanyRepository, 'findById'>;
  ids: IdGeneratorPort;
  clock: ClockPort;
  /**
   * Preuve d'existence tenant-scoped du chantier visé (anti-IDOR, même port que le coffre —
   * cf. ClassifyDocument). OPTIONNELLE pour la compat des câblages existants, mais REQUISE dès
   * qu'un `chantierId` est fourni : sans port, la création avec chantier échoue (fail-closed,
   * jamais un lien non vérifié en base).
   */
  chantierTargets?: DocumentLinkTargetPort;
}

/** Enregistre une dépense fournisseur (saisie manuelle ou confirmation d'une extraction OCR). */
export class RecordExpense {
  constructor(private readonly deps: RecordExpenseDeps) {}

  async execute(input: RecordExpenseInput): Promise<Result<{ id: string }, AppError>> {
    if (!this.deps.companies) {
      return err({
        kind: 'dependency',
        port: 'CompanyRepository',
        cause: 'Le régime TVA tenant ne peut pas être qualifié : création de dépense refusée.',
      });
    }
    // `Company` est l'agrégat validé qui porte le choix explicite de régime TVA. Cette lecture
    // précède toute consommation d'identifiant et toute persistance : aucun contexte fiscal
    // fourni par l'OCR ou le client HTTP ne peut se substituer à la vérité tenant.
    const company = await this.deps.companies.findById(input.companyId);
    if (!company || company.id !== input.companyId) return err(appNotFound('company', input.companyId));

    const id = this.deps.ids.newId();
    // Ticket déjà réglé (scan) : la dépense naît payée avec sa preuve — le domaine revalide
    // date/moyen/justificatif comme pour tout règlement (jamais de « payée sans preuve »).
    const payment = input.payment ?? null;
    const r = Expense.record({
      id,
      companyId: input.companyId,
      supplierName: input.supplierName,
      supplierSiren: input.supplierSiren ?? null,
      documentDate: input.documentDate,
      totalTtcCents: input.totalTtcCents,
      totalHtCents: input.totalHtCents ?? null,
      vatCents: input.vatCents ?? null,
      vatRatePct: input.vatRatePct ?? null,
      category: input.category,
      status: payment ? 'paid' : 'to_pay',
      paymentEvidence: payment
        ? {
            paidOn: payment.paidOn,
            method: payment.method,
            reference: payment.reference ?? null,
            proofDocumentId: payment.proofDocumentId ?? null,
          }
        : null,
      source: input.source ?? 'manual',
      supplierInvoiceNumber: input.supplierInvoiceNumber ?? null,
      dueAt: input.dueAt ?? null,
      chantierId: input.chantierId ?? null,
      // Borne « documentDate dans le futur » : jour MÉTIER Europe/Paris, pas l'UTC brut — une
      // pièce datée d'aujourd'hui (Paris) saisie entre minuit et ~2 h serait sinon rejetée
      // (même correction que RecordExpensePayment / GetCashflow « Audit correction 3 »).
    }, { today: parisDateOnly(this.deps.clock.now()) });
    if (!r.ok) return err(appDomain(r.error));
    // Anti-IDOR : un chantier visé doit être PROUVÉ dans le tenant AVANT toute persistance.
    // Fail-closed : chantierId fourni sans port câblé = refus (jamais de lien non vérifié).
    const chantierId = r.value.chantierId;
    if (chantierId !== null) {
      if (!this.deps.chantierTargets) {
        return err({
          kind: 'dependency',
          port: 'DocumentLinkTargetPort',
          cause: 'chantierId fourni sans port de vérification tenant (chantierTargets) : imputation refusée.',
        });
      }
      const exists = await this.deps.chantierTargets.exists({
        companyId: input.companyId,
        linkedEntityType: 'chantier',
        linkedEntityId: chantierId,
      });
      if (!exists) return err(appNotFound('chantier', chantierId));
    }
    await this.deps.expenses.save(r.value);
    return ok({ id });
  }
}

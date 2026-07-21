import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type DateOnly, isValidDateOnly } from '../../shared-kernel/time';
import { Siren } from '../../shared-kernel/identifiers';
import { type PaymentMethod } from '../payment/payment';

export type ExpenseCategory =
  | 'fournitures'
  | 'materiel'
  | 'carburant'
  | 'repas'
  | 'sous_traitance'
  | 'autre';

const CATEGORIES: readonly ExpenseCategory[] = [
  'fournitures',
  'materiel',
  'carburant',
  'repas',
  'sous_traitance',
  'autre',
];

export type ExpenseStatus = 'to_pay' | 'paid';
/** 'facturx' = e-facture reçue (C-EXP6b) — importée après contrôle de réception, jamais saisie. */
export type ExpenseSource = 'ocr' | 'manual' | 'facturx';

const STATUSES: readonly ExpenseStatus[] = ['to_pay', 'paid'];
const SOURCES: readonly ExpenseSource[] = ['ocr', 'manual', 'facturx'];
const PAYMENT_METHODS: readonly PaymentMethod[] = ['card', 'transfer', 'cash'];

export const EXPENSE_PAYMENT_REFERENCE_MAX_LENGTH = 140;
export const EXPENSE_PAYMENT_PROOF_DOCUMENT_ID_MAX_LENGTH = 200;

/**
 * Preuve minimale d'un règlement fournisseur DEJA exécuté hors de Bob.
 *
 * Bob ne déclenche aucun transfert bancaire sur ce parcours : cette valeur atteste uniquement
 * ce que le propriétaire vient explicitement de déclarer. La référence peut être celle du
 * virement ou du ticket carte ; `proofDocumentId` pointe vers une pièce conservée au coffre.
 */
export interface ExpensePaymentEvidence {
  paidOn: DateOnly;
  method: PaymentMethod;
  reference: string | null;
  proofDocumentId: string | null;
}

export interface ExpensePaymentEvidenceInput {
  paidOn: DateOnly;
  method: PaymentMethod;
  reference?: string | null;
  proofDocumentId?: string | null;
}

export interface ExpenseProps {
  id: string;
  companyId: string;
  supplierName: string;
  supplierSiren: string | null;
  documentDate: DateOnly;
  totalTtcCents: number;
  totalHtCents: number | null;
  vatCents: number | null;
  vatRatePct: number | null;
  category: ExpenseCategory;
  status: ExpenseStatus;
  /**
   * Preuve du règlement déclaré. Obligatoire pour toute nouvelle transition `to_pay → paid`.
   * Optionnelle au niveau du type pour pouvoir réhydrater les lignes historiques sans inventer
   * une date ou un moyen de paiement : une telle ligne reste explicitement non justifiée.
   */
  paymentEvidence?: ExpensePaymentEvidence | null;
  source: ExpenseSource;
  /** N° de facture FOURNISSEUR (Factur-X BT-1) — clé anti-doublon avec le SIREN (C-EXP6b).
   *  OPTIONNEL (additif) : les dépenses historiques/OCR/manuelles n'en ont pas. */
  supplierInvoiceNumber?: string | null;
  /** Échéance de paiement fournisseur (Factur-X BT-9) — OPTIONNEL (additif). */
  dueAt?: DateOnly | null;
  /**
   * Chantier auquel la dépense est imputée (rentabilité par chantier). OPTIONNEL (additif) :
   * null/absent = dépense hors chantier (carte société, abonnement…) — les lignes historiques
   * restent valides telles quelles. L'existence tenant du chantier est prouvée par l'APPELANT
   * (port de vérification, anti-IDOR) : le domaine ne garantit que la forme du lien.
   */
  chantierId?: string | null;
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function normalizeOptionalEvidenceText(
  value: string | null | undefined,
  field: 'paymentEvidence.reference' | 'paymentEvidence.proofDocumentId',
  maxLength: number,
): DomainResult<string | null> {
  if (value === null || value === undefined) return ok(null);
  const normalized = value.trim();
  if (!normalized) return ok(null);
  if (normalized.length > maxLength)
    return err({ code: 'VALIDATION', field, message: `Valeur limitée à ${maxLength} caractères.` });
  if (hasAsciiControlCharacter(normalized))
    return err({ code: 'VALIDATION', field, message: 'Caractères de contrôle interdits.' });
  return ok(normalized);
}

export function normalizeExpensePaymentEvidence(
  input: ExpensePaymentEvidenceInput,
  opts?: { today?: DateOnly },
): DomainResult<ExpensePaymentEvidence> {
  if (!isValidDateOnly(input.paidOn))
    return err({ code: 'VALIDATION', field: 'paymentEvidence.paidOn', message: 'Date de règlement invalide.' });
  if (opts?.today && input.paidOn > opts.today)
    return err({
      code: 'VALIDATION',
      field: 'paymentEvidence.paidOn',
      message: 'Un règlement déjà effectué ne peut pas être daté dans le futur.',
    });
  if (!PAYMENT_METHODS.includes(input.method))
    return err({ code: 'VALIDATION', field: 'paymentEvidence.method', message: 'Moyen de règlement inconnu.' });
  const reference = normalizeOptionalEvidenceText(
    input.reference,
    'paymentEvidence.reference',
    EXPENSE_PAYMENT_REFERENCE_MAX_LENGTH,
  );
  if (!reference.ok) return reference;
  const proofDocumentId = normalizeOptionalEvidenceText(
    input.proofDocumentId,
    'paymentEvidence.proofDocumentId',
    EXPENSE_PAYMENT_PROOF_DOCUMENT_ID_MAX_LENGTH,
  );
  if (!proofDocumentId.ok) return proofDocumentId;
  return ok({ paidOn: input.paidOn, method: input.method, reference: reference.value, proofDocumentId: proofDocumentId.value });
}

export function sameExpensePaymentEvidence(
  left: ExpensePaymentEvidence,
  right: ExpensePaymentEvidence,
): boolean {
  return left.paidOn === right.paidOn
    && left.method === right.method
    && left.reference === right.reference
    && left.proofDocumentId === right.proofDocumentId;
}

/**
 * Ligne HISTORIQUE « payée sans preuve » (migration lane preuves : `paymentEvidenceLegacyUnverified`
 * côté persistance) — le seul état régularisable par RegularizeLegacyExpensePayment. Partagé
 * avec l'UI (badge « Payée — à justifier ») pour que la détection ne diverge jamais.
 */
export function isLegacyUnverifiedExpensePayment(
  expense: Pick<ExpenseProps, 'status' | 'paymentEvidence'>,
): boolean {
  return expense.status === 'paid' && !expense.paymentEvidence;
}

/**
 * Agrégat Expense — une dépense fournisseur (saisie manuelle ou issue de l'OCR).
 * Montants en CENTIMES. Une dépense « à payer » est une charge à venir (impacte la trésorerie).
 */
export class Expense {
  private constructor(private readonly p: ExpenseProps) {}

  static record(props: ExpenseProps, opts?: { today?: DateOnly }): DomainResult<Expense> {
    const supplierName = props.supplierName.trim();
    if (!supplierName) return err({ code: 'VALIDATION', field: 'supplierName', message: 'Fournisseur requis.' });
    if (!isValidDateOnly(props.documentDate))
      return err({ code: 'VALIDATION', field: 'documentDate', message: 'Date de document invalide.' });
    if (opts?.today && props.documentDate > opts.today)
      return err({ code: 'VALIDATION', field: 'documentDate', message: 'Date de document dans le futur interdite.' });
    if (!isInt(props.totalTtcCents) || props.totalTtcCents < 0)
      return err({ code: 'VALIDATION', field: 'totalTtcCents', message: 'Montant TTC (centimes entiers) requis.' });
    if (props.totalHtCents !== null && (!isInt(props.totalHtCents) || props.totalHtCents < 0))
      return err({ code: 'VALIDATION', field: 'totalHtCents', message: 'Montant HT invalide.' });
    if (props.vatCents !== null && (!isInt(props.vatCents) || props.vatCents < 0))
      return err({ code: 'VALIDATION', field: 'vatCents', message: 'TVA invalide.' });
    // Cohérence : HT et TVA ne peuvent dépasser le TTC (garde-fou anti-OCR aberrant).
    if (props.totalHtCents !== null && props.totalHtCents > props.totalTtcCents)
      return err({ code: 'VALIDATION', field: 'totalHtCents', message: 'HT supérieur au TTC.' });
    if (props.vatCents !== null && props.vatCents > props.totalTtcCents)
      return err({ code: 'VALIDATION', field: 'vatCents', message: 'TVA supérieure au TTC.' });
    if (!CATEGORIES.includes(props.category))
      return err({ code: 'VALIDATION', field: 'category', message: 'Catégorie inconnue.' });
    if (!STATUSES.includes(props.status))
      return err({ code: 'VALIDATION', field: 'status', message: 'Statut inconnu.' });
    if (!SOURCES.includes(props.source))
      return err({ code: 'VALIDATION', field: 'source', message: 'Source inconnue.' });
    const rawPaymentEvidence = props.paymentEvidence ?? null;
    let paymentEvidence: ExpensePaymentEvidence | null = null;
    if (rawPaymentEvidence !== null) {
      const normalized = normalizeExpensePaymentEvidence(rawPaymentEvidence, opts);
      if (!normalized.ok) return normalized;
      paymentEvidence = normalized.value;
    }
    if (props.status === 'to_pay' && paymentEvidence !== null)
      return err({
        code: 'VALIDATION',
        field: 'paymentEvidence',
        message: 'Une dépense à payer ne peut pas porter une preuve de règlement.',
      });
    if (props.status === 'paid' && paymentEvidence === null)
      return err({
        code: 'VALIDATION',
        field: 'paymentEvidence',
        message: 'La preuve du règlement est requise pour enregistrer une dépense payée.',
      });
    // Champs Factur-X (C-EXP6b) — optionnels, normalisés : n° vide → null, échéance validée.
    const supplierInvoiceNumber = props.supplierInvoiceNumber?.trim() || null;
    const dueAt = props.dueAt ?? null;
    if (dueAt !== null && !isValidDateOnly(dueAt))
      return err({ code: 'VALIDATION', field: 'dueAt', message: 'Échéance invalide.' });
    // Chantier — optionnel (additif) : fourni, il doit désigner quelque chose (jamais un blanc).
    const rawChantierId = props.chantierId ?? null;
    let chantierId: string | null = null;
    if (rawChantierId !== null) {
      chantierId = rawChantierId.trim();
      if (!chantierId)
        return err({ code: 'VALIDATION', field: 'chantierId', message: 'Chantier de rattachement invalide.' });
    }
    let supplierSiren: string | null = null;
    if (props.supplierSiren) {
      const s = Siren.of(props.supplierSiren);
      if (!s.ok) return s;
      supplierSiren = s.value.value;
    }
    return ok(new Expense({ ...props, supplierName, supplierSiren, paymentEvidence, supplierInvoiceNumber, dueAt, chantierId }));
  }

  /** Réhydratation depuis le stockage (données déjà validées) — ne rejette jamais une ligne persistée. */
  static rehydrate(props: ExpenseProps): Expense {
    return new Expense({
      ...props,
      paymentEvidence: props.paymentEvidence ? { ...props.paymentEvidence } : null,
    });
  }

  get id(): string {
    return this.p.id;
  }
  get companyId(): string {
    return this.p.companyId;
  }
  get supplierName(): string {
    return this.p.supplierName;
  }
  get documentDate(): DateOnly {
    return this.p.documentDate;
  }
  get totalTtcCents(): number {
    return this.p.totalTtcCents;
  }
  get category(): ExpenseCategory {
    return this.p.category;
  }
  get status(): ExpenseStatus {
    return this.p.status;
  }
  get paymentEvidence(): ExpensePaymentEvidence | null {
    return this.p.paymentEvidence ? { ...this.p.paymentEvidence } : null;
  }
  get supplierInvoiceNumber(): string | null {
    return this.p.supplierInvoiceNumber ?? null;
  }
  get dueAt(): DateOnly | null {
    return this.p.dueAt ?? null;
  }
  /** Chantier d'imputation — null = dépense hors chantier (défaut, lignes historiques comprises). */
  get chantierId(): string | null {
    return this.p.chantierId ?? null;
  }

  /**
   * Impute la dépense à un chantier — ou la délie (null EXPLICITE, geste légitime pour une
   * dépense, contrairement au lien documentaire). Idempotent : ré-imputer le même chantier
   * (ou délier une dépense déjà hors chantier) ne change rien (`changed: false`).
   * L'existence tenant du chantier cible relève de l'APPELANT (port de vérification, anti-IDOR).
   */
  assignToChantier(chantierId: string | null): DomainResult<{ changed: boolean }> {
    let next: string | null = null;
    if (chantierId !== null) {
      next = chantierId.trim();
      if (!next)
        return err({ code: 'VALIDATION', field: 'chantierId', message: 'Chantier de rattachement invalide.' });
    }
    if ((this.p.chantierId ?? null) === next) return ok({ changed: false });
    this.p.chantierId = next;
    return ok({ changed: true });
  }

  recordPayment(
    evidence: ExpensePaymentEvidenceInput,
    opts?: { today?: DateOnly },
  ): DomainResult<{ alreadyRecorded: boolean }> {
    const normalized = normalizeExpensePaymentEvidence(evidence, opts);
    if (!normalized.ok) return normalized;
    if (this.p.status === 'paid') {
      if (!this.p.paymentEvidence)
        return err({
          code: 'VALIDATION',
          field: 'paymentEvidence',
          message: 'Cette dépense est marquée payée sans preuve fiable. Une régularisation explicite est requise.',
        });
      if (!sameExpensePaymentEvidence(this.p.paymentEvidence, normalized.value))
        return err({
          code: 'VALIDATION',
          field: 'paymentEvidence',
          message: 'Ce règlement a déjà été enregistré avec une preuve différente.',
        });
      return ok({ alreadyRecorded: true });
    }
    if (this.p.paymentEvidence)
      return err({
        code: 'VALIDATION',
        field: 'paymentEvidence',
        message: 'Une preuve de règlement existe sur une dépense encore à payer.',
      });
    this.p.status = 'paid';
    this.p.paymentEvidence = normalized.value;
    return ok({ alreadyRecorded: false });
  }

  /**
   * Régularise une ligne HISTORIQUE payée sans preuve (héritée de la migration) en lui attachant
   * la preuve déclarée. Ne s'applique JAMAIS à une dépense à payer (c'est un règlement, pas une
   * régularisation) ; idempotente sur retry strictement identique ; refuse d'écraser une preuve
   * différente déjà enregistrée.
   */
  regularizeLegacyPayment(
    evidence: ExpensePaymentEvidenceInput,
    opts?: { today?: DateOnly },
  ): DomainResult<{ alreadyRegularized: boolean }> {
    const normalized = normalizeExpensePaymentEvidence(evidence, opts);
    if (!normalized.ok) return normalized;
    if (this.p.status !== 'paid')
      return err({
        code: 'VALIDATION',
        field: 'status',
        message: 'Cette dépense est encore à payer : enregistre son règlement, pas une régularisation.',
      });
    if (this.p.paymentEvidence) {
      if (sameExpensePaymentEvidence(this.p.paymentEvidence, normalized.value))
        return ok({ alreadyRegularized: true });
      return err({
        code: 'VALIDATION',
        field: 'paymentEvidence',
        message: 'Cette dépense est déjà justifiée par une preuve différente : rien à régulariser.',
      });
    }
    this.p.paymentEvidence = normalized.value;
    return ok({ alreadyRegularized: false });
  }

  toProps(): ExpenseProps {
    return {
      ...this.p,
      paymentEvidence: this.p.paymentEvidence ? { ...this.p.paymentEvidence } : null,
      // Projection : chantierId TOUJOURS explicite (null pour les lignes historiques sans le champ).
      chantierId: this.p.chantierId ?? null,
    };
  }
}

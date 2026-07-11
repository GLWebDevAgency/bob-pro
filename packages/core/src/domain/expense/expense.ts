import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type DateOnly, isValidDateOnly } from '../../shared-kernel/time';
import { Siren } from '../../shared-kernel/identifiers';

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
  source: ExpenseSource;
  /** N° de facture FOURNISSEUR (Factur-X BT-1) — clé anti-doublon avec le SIREN (C-EXP6b).
   *  OPTIONNEL (additif) : les dépenses historiques/OCR/manuelles n'en ont pas. */
  supplierInvoiceNumber?: string | null;
  /** Échéance de paiement fournisseur (Factur-X BT-9) — OPTIONNEL (additif). */
  dueAt?: DateOnly | null;
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

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
    // Champs Factur-X (C-EXP6b) — optionnels, normalisés : n° vide → null, échéance validée.
    const supplierInvoiceNumber = props.supplierInvoiceNumber?.trim() || null;
    const dueAt = props.dueAt ?? null;
    if (dueAt !== null && !isValidDateOnly(dueAt))
      return err({ code: 'VALIDATION', field: 'dueAt', message: 'Échéance invalide.' });
    let supplierSiren: string | null = null;
    if (props.supplierSiren) {
      const s = Siren.of(props.supplierSiren);
      if (!s.ok) return s;
      supplierSiren = s.value.value;
    }
    return ok(new Expense({ ...props, supplierName, supplierSiren, supplierInvoiceNumber, dueAt }));
  }

  /** Réhydratation depuis le stockage (données déjà validées) — ne rejette jamais une ligne persistée. */
  static rehydrate(props: ExpenseProps): Expense {
    return new Expense({ ...props });
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
  get supplierInvoiceNumber(): string | null {
    return this.p.supplierInvoiceNumber ?? null;
  }
  get dueAt(): DateOnly | null {
    return this.p.dueAt ?? null;
  }

  markPaid(): void {
    this.p.status = 'paid';
  }

  toProps(): ExpenseProps {
    return { ...this.p };
  }
}

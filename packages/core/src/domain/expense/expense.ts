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
export type ExpenseSource = 'ocr' | 'manual';

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
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

/**
 * Agrégat Expense — une dépense fournisseur (saisie manuelle ou issue de l'OCR).
 * Montants en CENTIMES. Une dépense « à payer » est une charge à venir (impacte la trésorerie).
 */
export class Expense {
  private constructor(private readonly p: ExpenseProps) {}

  static record(props: ExpenseProps): DomainResult<Expense> {
    const supplierName = props.supplierName.trim();
    if (!supplierName) return err({ code: 'VALIDATION', field: 'supplierName', message: 'Fournisseur requis.' });
    if (!isValidDateOnly(props.documentDate))
      return err({ code: 'VALIDATION', field: 'documentDate', message: 'Date de document invalide.' });
    if (!isInt(props.totalTtcCents) || props.totalTtcCents < 0)
      return err({ code: 'VALIDATION', field: 'totalTtcCents', message: 'Montant TTC (centimes entiers) requis.' });
    if (props.totalHtCents !== null && (!isInt(props.totalHtCents) || props.totalHtCents < 0))
      return err({ code: 'VALIDATION', field: 'totalHtCents', message: 'Montant HT invalide.' });
    if (props.vatCents !== null && (!isInt(props.vatCents) || props.vatCents < 0))
      return err({ code: 'VALIDATION', field: 'vatCents', message: 'TVA invalide.' });
    if (!CATEGORIES.includes(props.category))
      return err({ code: 'VALIDATION', field: 'category', message: 'Catégorie inconnue.' });
    let supplierSiren: string | null = null;
    if (props.supplierSiren) {
      const s = Siren.of(props.supplierSiren);
      if (!s.ok) return s;
      supplierSiren = s.value.value;
    }
    return ok(new Expense({ ...props, supplierName, supplierSiren }));
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

  markPaid(): void {
    this.p.status = 'paid';
  }

  toProps(): ExpenseProps {
    return { ...this.p };
  }
}

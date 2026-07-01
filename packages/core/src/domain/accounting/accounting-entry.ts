import { type DomainResult, ok, err } from '../../shared-kernel/result';
import { type DateOnly, isValidDateOnly } from '../../shared-kernel/time';

export type AccountingJournal = 'sales' | 'purchases' | 'bank' | 'misc';
export type AccountingSourceType = 'invoice' | 'expense' | 'payment' | 'bank_transaction' | 'manual_adjustment';

export interface AccountingEntryLineProps {
  account: string;
  label: string;
  debitCents: number;
  creditCents: number;
}

export interface AccountingEntryProps {
  id: string;
  companyId: string;
  journal: AccountingJournal;
  sourceType: AccountingSourceType;
  sourceId: string;
  entryDate: DateOnly;
  reference: string;
  label: string;
  lines: AccountingEntryLineProps[];
}

const JOURNALS: readonly AccountingJournal[] = ['sales', 'purchases', 'bank', 'misc'];
const SOURCE_TYPES: readonly AccountingSourceType[] = ['invoice', 'expense', 'payment', 'bank_transaction', 'manual_adjustment'];
const ACCOUNT_RE = /^\d{3,12}$/;

const isCents = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const total = (lines: AccountingEntryLineProps[], side: 'debitCents' | 'creditCents') =>
  lines.reduce((sum, line) => sum + line[side], 0);

function required(value: string, field: string): DomainResult<string> {
  const normalized = value.trim();
  if (!normalized) return err({ code: 'VALIDATION', field, message: 'Champ requis.' });
  return ok(normalized);
}

function normalizeLine(line: AccountingEntryLineProps, index: number): DomainResult<AccountingEntryLineProps> {
  const field = `lines[${index}]`;
  const account = line.account.trim();
  const label = line.label.trim();
  if (!ACCOUNT_RE.test(account))
    return err({ code: 'VALIDATION', field: `${field}.account`, message: 'Compte comptable invalide.' });
  if (!label) return err({ code: 'VALIDATION', field: `${field}.label`, message: 'Libelle de ligne requis.' });
  if (!isCents(line.debitCents))
    return err({ code: 'VALIDATION', field: `${field}.debitCents`, message: 'Debit invalide.' });
  if (!isCents(line.creditCents))
    return err({ code: 'VALIDATION', field: `${field}.creditCents`, message: 'Credit invalide.' });

  const hasDebit = line.debitCents > 0;
  const hasCredit = line.creditCents > 0;
  if (hasDebit === hasCredit)
    return err({ code: 'VALIDATION', field, message: 'Une ligne doit porter exactement un debit ou un credit.' });

  return ok({ account, label, debitCents: line.debitCents, creditCents: line.creditCents });
}

/**
 * Écriture de pré-comptabilité en partie double.
 *
 * Le domaine garantit uniquement les invariants universels : source traçable, date valide,
 * comptes structurés, lignes non ambiguës et total débit = total crédit. Les choix de mapping
 * fiscal/comptable restent dans des services dédiés plus tard, avec revue métier.
 */
export class AccountingEntry {
  private constructor(private readonly p: AccountingEntryProps) {}

  static create(props: AccountingEntryProps): DomainResult<AccountingEntry> {
    const id = required(props.id, 'id');
    if (!id.ok) return id;
    const companyId = required(props.companyId, 'companyId');
    if (!companyId.ok) return companyId;
    const sourceId = required(props.sourceId, 'sourceId');
    if (!sourceId.ok) return sourceId;
    const reference = required(props.reference, 'reference');
    if (!reference.ok) return reference;
    const label = required(props.label, 'label');
    if (!label.ok) return label;
    if (!JOURNALS.includes(props.journal)) return err({ code: 'VALIDATION', field: 'journal', message: 'Journal inconnu.' });
    if (!SOURCE_TYPES.includes(props.sourceType))
      return err({ code: 'VALIDATION', field: 'sourceType', message: 'Type de source inconnu.' });
    if (!isValidDateOnly(props.entryDate))
      return err({ code: 'VALIDATION', field: 'entryDate', message: "Date d'ecriture invalide." });
    if (props.lines.length < 2)
      return err({ code: 'VALIDATION', field: 'lines', message: 'Au moins deux lignes sont requises.' });

    const lines: AccountingEntryLineProps[] = [];
    for (const [index, line] of props.lines.entries()) {
      const normalized = normalizeLine(line, index);
      if (!normalized.ok) return normalized;
      lines.push(normalized.value);
    }

    const debitCents = total(lines, 'debitCents');
    const creditCents = total(lines, 'creditCents');
    if (debitCents !== creditCents)
      return err({ code: 'VALIDATION', field: 'lines', message: 'Ecriture non equilibree debit/credit.' });

    return ok(
      new AccountingEntry({
        id: id.value,
        companyId: companyId.value,
        journal: props.journal,
        sourceType: props.sourceType,
        sourceId: sourceId.value,
        entryDate: props.entryDate,
        reference: reference.value,
        label: label.value,
        lines,
      }),
    );
  }

  /** Réhydratation depuis un stockage déjà validé. */
  static rehydrate(props: AccountingEntryProps): AccountingEntry {
    return new AccountingEntry({ ...props, lines: props.lines.map((line) => ({ ...line })) });
  }

  get id(): string {
    return this.p.id;
  }
  get companyId(): string {
    return this.p.companyId;
  }
  get journal(): AccountingJournal {
    return this.p.journal;
  }
  get sourceType(): AccountingSourceType {
    return this.p.sourceType;
  }
  get sourceId(): string {
    return this.p.sourceId;
  }
  get entryDate(): DateOnly {
    return this.p.entryDate;
  }
  get reference(): string {
    return this.p.reference;
  }
  get label(): string {
    return this.p.label;
  }
  get lines(): AccountingEntryLineProps[] {
    return this.p.lines.map((line) => ({ ...line }));
  }
  get totalDebitCents(): number {
    return total(this.p.lines, 'debitCents');
  }
  get totalCreditCents(): number {
    return total(this.p.lines, 'creditCents');
  }

  toProps(): AccountingEntryProps {
    return { ...this.p, lines: this.lines };
  }
}

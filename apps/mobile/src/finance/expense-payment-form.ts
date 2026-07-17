import { isValidDateOnly, type DateOnly } from '@bob/core';

export type ExpensePaymentDateError = 'required' | 'format' | 'future';

export type ExpensePaymentDateValidation =
  | { readonly ok: true; readonly value: DateOnly }
  | { readonly ok: false; readonly error: ExpensePaymentDateError };

/**
 * Accepte le format humain français et le format ISO sans jamais corriger une date ambiguë.
 * `today` est injecté pour partager exactement le même jour métier que le reste de l'app.
 */
export function validateExpensePaymentDate(
  raw: string,
  today: DateOnly,
): ExpensePaymentDateValidation {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'required' };

  const french = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  const candidate = french ? `${french[3]}-${french[2]}-${french[1]}` : trimmed;
  if (!isValidDateOnly(candidate)) return { ok: false, error: 'format' };
  if (candidate > today) return { ok: false, error: 'future' };
  return { ok: true, value: candidate };
}

export function displayExpensePaymentDate(date: DateOnly): string {
  const [year, month, day] = date.split('-');
  return year && month && day ? `${day}/${month}/${year}` : date;
}

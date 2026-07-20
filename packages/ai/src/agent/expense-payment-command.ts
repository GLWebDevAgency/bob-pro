import { addDays, isValidDateOnly, type DateOnly, type PaymentMethod } from '@bob/core';

export interface ParsedExpensePaymentDetails {
  paidOn: DateOnly | null;
  method: PaymentMethod | null;
  reference: string | null;
}

function normalized(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function parseDateOnly(message: string, today: DateOnly | null): DateOnly | null {
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(message)?.[0] ?? null;
  if (iso && isValidDateOnly(iso)) return iso;
  const french = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/.exec(message);
  if (french) {
    const [, day, month, year] = french;
    const candidate = `${year}-${month?.padStart(2, '0')}-${day?.padStart(2, '0')}`;
    if (isValidDateOnly(candidate)) return candidate;
  }
  if (!today) return null;
  const text = normalized(message).replace(/[^a-z0-9]+/g, ' ');
  if (/\b(aujourd hui|ce jour)\b/.test(text)) return today;
  if (/\bhier\b/.test(text)) return addDays(today, -1);
  return null;
}

function parseMethod(message: string): PaymentMethod | null {
  const text = ` ${normalized(message).replace(/[^a-z0-9]+/g, ' ')} `;
  if (/\b(especes?|liquide|cash)\b/.test(text)) return 'cash';
  if (/\b(carte|cb|carte bancaire)\b/.test(text)) return 'card';
  if (/\b(virement|vir bancaire|transfert bancaire)\b/.test(text)) return 'transfer';
  return null;
}

function parseReference(message: string): string | null {
  const match = /(?:réf(?:érence)?|reference|transaction|opération|operation)\s*(?:n[°o]\s*)?[:#-]?\s*([\p{L}\p{N}][\p{L}\p{N}._/-]{1,139})/iu.exec(message);
  return match?.[1]?.trim() || null;
}

/** Extraction déterministe : les éléments absents restent null, jamais remplacés par un défaut. */
export function parseExpensePaymentDetails(
  message: string,
  today: DateOnly | null,
): ParsedExpensePaymentDetails {
  return {
    paidOn: parseDateOnly(message, today),
    method: parseMethod(message),
    reference: parseReference(message),
  };
}

export function expensePaymentMethodLabel(method: PaymentMethod): string {
  if (method === 'cash') return 'espèces';
  if (method === 'card') return 'carte';
  return 'virement';
}

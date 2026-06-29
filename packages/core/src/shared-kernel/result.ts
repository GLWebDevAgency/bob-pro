export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type DomainError =
  | { code: 'VALIDATION'; field: string; message: string }
  | { code: 'VAT_RATE_NOT_APPLICABLE'; rate: number; reason: 'franchise_293B' | 'autoliquidation' | 'unknown' }
  | { code: 'INVALID_TRANSITION'; from: string; to: string }
  | { code: 'DOCUMENT_NUMBER_GAP'; expected: string; got: string }
  | { code: 'QUOTE_ALREADY_SIGNED'; quoteId: string }
  | { code: 'MISSING_SIREN_FOR_EINVOICE'; customerId: string };

export type DomainResult<T> = Result<T, DomainError>;

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const err = <E>(error: E): { ok: false; error: E } => ({ ok: false, error });
export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;

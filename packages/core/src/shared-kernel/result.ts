export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type DomainError =
  | { code: 'VALIDATION'; field: string; message: string }
  | { code: 'VAT_RATE_NOT_APPLICABLE'; rate: number; reason: 'franchise_293B' | 'autoliquidation' | 'unknown' }
  | { code: 'INVALID_TRANSITION'; from: string; to: string }
  | { code: 'DOCUMENT_NUMBER_GAP'; expected: string; got: string }
  | {
      /** Garde anti-écrasement : un document déjà rattaché refuse un lien métier DIFFÉRENT. */
      code: 'DOCUMENT_ALREADY_LINKED';
      documentId: string;
      existing: { linkedEntityType: string; linkedEntityId: string };
      requested: { linkedEntityType: string; linkedEntityId: string };
      message: string;
    }
  | { code: 'QUOTE_ALREADY_SIGNED'; quoteId: string }
  | { code: 'MISSING_SIREN_FOR_EINVOICE'; customerId: string }
  | { code: 'CABINET_MEMBER_ALREADY_EXISTS'; cabinetId: string; userId: string }
  | { code: 'CABINET_LAST_ADMIN_REQUIRED'; cabinetId: string }
  | { code: 'CABINET_INVITATION_EXPIRED'; invitationId: string; expiresAt: string }
  | { code: 'CABINET_INVITATION_ALREADY_USED'; invitationId: string }
  | { code: 'CABINET_INVITATION_EMAIL_MISMATCH'; invitationId: string }
  | {
      code: 'FISCAL_PROFILE_INCONSISTENT';
      rule:
        | 'micro_tax_regime_requires_tns'
        | 'assimile_requires_sasu_or_sas'
        | 'tns_requires_ei_micro_eurl'
        | 'versement_liberatoire_requires_micro'
        | 'micro_legal_form_requires_micro_tax_regime';
      message: string;
    };

export type DomainResult<T> = Result<T, DomainError>;

export const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const err = <E>(error: E): { ok: false; error: E } => ({ ok: false, error });
export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;

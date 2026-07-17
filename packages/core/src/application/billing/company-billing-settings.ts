import { err, ok, type DomainResult } from '../../shared-kernel/result';

/** Palette volontairement fermée : le renderer PDF est l'autorité de rendu de ces rôles. */
export type InvoicePdfAccentColor = 'navy' | 'green' | 'purple' | 'orange';

/**
 * Réglages canoniques d'une société. Une instance provient toujours de PostgreSQL en production :
 * le mobile ne construit jamais de valeur de repli quand la lecture serveur échoue.
 */
export interface CompanyBillingSettings {
  readonly companyId: string;
  readonly revision: number;
  readonly showRibOnInvoices: boolean;
  readonly showInsuranceOnInvoices: boolean;
  readonly pdfAccentColor: InvoicePdfAccentColor;
  readonly defaultQuoteValidityDays: number;
  readonly defaultDepositPercent: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CompanyBillingSettingsPatch {
  readonly showRibOnInvoices?: boolean;
  readonly showInsuranceOnInvoices?: boolean;
  readonly pdfAccentColor?: InvoicePdfAccentColor;
  readonly defaultQuoteValidityDays?: number;
  readonly defaultDepositPercent?: number;
}

export type CompanyBillingSettingsWriteResult =
  | { readonly status: 'updated'; readonly settings: CompanyBillingSettings }
  | { readonly status: 'revision_conflict'; readonly currentRevision: number | null };

export interface CompanyBillingSettingsRepository {
  findByCompanyId(companyId: string): Promise<CompanyBillingSettings | null>;
  /** Crée la ligne avec les valeurs initiales portées par le schéma SQL. Idempotent. */
  ensureForCompany(companyId: string): Promise<CompanyBillingSettings>;
  update(input: {
    readonly companyId: string;
    readonly expectedRevision: number;
    readonly patch: CompanyBillingSettingsPatch;
  }): Promise<CompanyBillingSettingsWriteResult>;
}

const ACCENTS: readonly InvoicePdfAccentColor[] = ['navy', 'green', 'purple', 'orange'];

export function validateCompanyBillingSettingsPatch(
  patch: CompanyBillingSettingsPatch,
): DomainResult<CompanyBillingSettingsPatch> {
  if (Object.keys(patch).length === 0) {
    return err({
      code: 'VALIDATION',
      field: 'settings',
      message: 'Au moins un réglage de facturation est requis.',
    });
  }
  if (
    patch.pdfAccentColor !== undefined
    && !ACCENTS.includes(patch.pdfAccentColor)
  ) {
    return err({
      code: 'VALIDATION',
      field: 'pdfAccentColor',
      message: 'Couleur de document invalide.',
    });
  }
  if (
    patch.defaultQuoteValidityDays !== undefined
    && (
      !Number.isSafeInteger(patch.defaultQuoteValidityDays)
      || patch.defaultQuoteValidityDays < 1
      || patch.defaultQuoteValidityDays > 365
    )
  ) {
    return err({
      code: 'VALIDATION',
      field: 'defaultQuoteValidityDays',
      message: 'La validité doit être comprise entre 1 et 365 jours.',
    });
  }
  if (
    patch.defaultDepositPercent !== undefined
    && (
      !Number.isSafeInteger(patch.defaultDepositPercent)
      || patch.defaultDepositPercent < 0
      || patch.defaultDepositPercent > 100
    )
  ) {
    return err({
      code: 'VALIDATION',
      field: 'defaultDepositPercent',
      message: "L'acompte doit être compris entre 0 et 100 %.",
    });
  }
  return ok({ ...patch });
}

export function assertCompanyBillingSettings(settings: CompanyBillingSettings): void {
  if (!Number.isSafeInteger(settings.revision) || settings.revision < 1) {
    throw new Error('COMPANY_BILLING_SETTINGS_REVISION_CORRUPT');
  }
  const validated = validateCompanyBillingSettingsPatch({
    showRibOnInvoices: settings.showRibOnInvoices,
    showInsuranceOnInvoices: settings.showInsuranceOnInvoices,
    pdfAccentColor: settings.pdfAccentColor,
    defaultQuoteValidityDays: settings.defaultQuoteValidityDays,
    defaultDepositPercent: settings.defaultDepositPercent,
  });
  if (!validated.ok) {
    const field = 'field' in validated.error ? validated.error.field : 'unknown';
    throw new Error(`COMPANY_BILLING_SETTINGS_CORRUPT:${field}`);
  }
}

import { err, ok, type DomainResult } from '../../shared-kernel/result';

/** Palette volontairement fermée : le renderer PDF est l'autorité de rendu de ces rôles. */
export type InvoicePdfAccentColor = 'navy' | 'green' | 'purple' | 'orange';

/**
 * PR-06 — cadence de relance PERSONNALISÉE de la société (mêmes champs que RelancePolicy du
 * moteur @bob/core : J+n après l'échéance). Les QUATRE seuils vont ensemble (une politique
 * partielle mélangée au défaut casserait l'escalade) et sont STRICTEMENT croissants — la mise
 * en demeure reste JAMAIS envoyée seule, son seuil pilote uniquement le ton proposé.
 */
export interface CompanyRelancePolicy {
  readonly cordialAfterDays: number;
  readonly neutreAfterDays: number;
  readonly fermeAfterDays: number;
  readonly miseEnDemeureAfterDays: number;
}

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
  /** Null tant que le propriétaire n'a pas choisi ses conditions : aucune échéance implicite. */
  readonly defaultInvoicePaymentTermsDays: number | null;
  /** PR-06 — cadence personnalisée ; null = DEFAULT_RELANCE_POLICY (J+3/J+10/J+20/J+30). */
  readonly relancePolicy: CompanyRelancePolicy | null;
  /** PR-06 — relances AUTOMATIQUES (cron) actives ; la relance manuelle reste toujours possible. */
  readonly relanceAutoEnabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CompanyBillingSettingsPatch {
  readonly showRibOnInvoices?: boolean;
  readonly showInsuranceOnInvoices?: boolean;
  readonly pdfAccentColor?: InvoicePdfAccentColor;
  readonly defaultQuoteValidityDays?: number;
  readonly defaultDepositPercent?: number;
  /** `null` efface le choix ; l'émission redevient alors volontairement impossible. */
  readonly defaultInvoicePaymentTermsDays?: number | null;
  /** PR-06 — `null` = retour à la cadence par défaut (les 4 seuils vont ensemble). */
  readonly relancePolicy?: CompanyRelancePolicy | null;
  readonly relanceAutoEnabled?: boolean;
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
  if (patch.pdfAccentColor !== undefined && !ACCENTS.includes(patch.pdfAccentColor)) {
    return err({
      code: 'VALIDATION',
      field: 'pdfAccentColor',
      message: 'Couleur de document invalide.',
    });
  }
  if (
    patch.defaultQuoteValidityDays !== undefined &&
    (!Number.isSafeInteger(patch.defaultQuoteValidityDays) ||
      patch.defaultQuoteValidityDays < 1 ||
      patch.defaultQuoteValidityDays > 365)
  ) {
    return err({
      code: 'VALIDATION',
      field: 'defaultQuoteValidityDays',
      message: 'La validité doit être comprise entre 1 et 365 jours.',
    });
  }
  if (
    patch.defaultDepositPercent !== undefined &&
    (!Number.isSafeInteger(patch.defaultDepositPercent) ||
      patch.defaultDepositPercent < 0 ||
      patch.defaultDepositPercent > 100)
  ) {
    return err({
      code: 'VALIDATION',
      field: 'defaultDepositPercent',
      message: "L'acompte doit être compris entre 0 et 100 %.",
    });
  }
  if (
    patch.defaultInvoicePaymentTermsDays !== undefined &&
    patch.defaultInvoicePaymentTermsDays !== null &&
    (!Number.isSafeInteger(patch.defaultInvoicePaymentTermsDays) ||
      patch.defaultInvoicePaymentTermsDays < 1 ||
      patch.defaultInvoicePaymentTermsDays > 60)
  ) {
    return err({
      code: 'VALIDATION',
      field: 'defaultInvoicePaymentTermsDays',
      message: 'Le délai de paiement doit être compris entre 1 et 60 jours.',
    });
  }
  // PR-06 — cadence personnalisée : 4 seuils ENSEMBLE, entiers 1..365, STRICTEMENT croissants
  // (une escalade désordonnée enverrait la mise en demeure avant la relance ferme).
  if (patch.relancePolicy !== undefined && patch.relancePolicy !== null) {
    const policy = patch.relancePolicy;
    const steps = [
      policy.cordialAfterDays,
      policy.neutreAfterDays,
      policy.fermeAfterDays,
      policy.miseEnDemeureAfterDays,
    ];
    if (steps.some((days) => !Number.isSafeInteger(days) || days < 1 || days > 365)) {
      return err({
        code: 'VALIDATION',
        field: 'relancePolicy',
        message: 'Chaque palier de relance doit être un entier entre 1 et 365 jours.',
      });
    }
    if (!steps.every((days, index) => index === 0 || days > steps[index - 1]!)) {
      return err({
        code: 'VALIDATION',
        field: 'relancePolicy',
        message:
          'Les paliers doivent être strictement croissants (cordial < neutre < ferme < mise en demeure).',
      });
    }
  }
  if (patch.relanceAutoEnabled !== undefined && typeof patch.relanceAutoEnabled !== 'boolean') {
    return err({
      code: 'VALIDATION',
      field: 'relanceAutoEnabled',
      message: 'Interrupteur de relance automatique invalide.',
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
    defaultInvoicePaymentTermsDays: settings.defaultInvoicePaymentTermsDays,
    relancePolicy: settings.relancePolicy,
    relanceAutoEnabled: settings.relanceAutoEnabled,
  });
  if (!validated.ok) {
    const field = 'field' in validated.error ? validated.error.field : 'unknown';
    throw new Error(`COMPANY_BILLING_SETTINGS_CORRUPT:${field}`);
  }
}

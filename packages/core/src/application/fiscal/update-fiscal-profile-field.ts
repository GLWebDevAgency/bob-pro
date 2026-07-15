import { type Result, ok, err } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';
import { type AppError, appDomain } from '../result';
import {
  FISCAL_PROFILE_FIELDS,
  buildInitialFiscalProfile,
  type AcreInfo,
  type FiscalActivityNature,
  type FiscalDatumSource,
  type FiscalProfileDerivationInput,
  type FiscalProfileFieldPatch,
  type FiscalProfileView,
  type FiscalSocialStatus,
  type FiscalTaxRegime,
  type FiscalVatRegime,
  type FiscalYearEnd,
} from '../../domain/fiscal/fiscal-profile';
import { type LegalForm } from '../../domain/company/company';
import { type FiscalProfileRepository } from '../ports/fiscal-profile-repository';

const LEGAL_FORMS: readonly LegalForm[] = ['EI', 'EURL', 'SASU', 'SARL', 'SAS', 'micro'];
const TAX_REGIMES: readonly FiscalTaxRegime[] = ['micro', 'reel_ir', 'is', 'option_ir'];
const SOCIAL_STATUSES: readonly FiscalSocialStatus[] = ['tns', 'assimile_salarie'];
const ACTIVITY_NATURES: readonly FiscalActivityNature[] = ['bic_vente', 'bic_service', 'bnc', 'bnc_cipav', 'mixte'];
const VAT_REGIMES: readonly FiscalVatRegime[] = ['franchise', 'reel_simplifie', 'reel_normal'];

function validationError(field: string, message: string): AppError {
  return { kind: 'validation', issues: [{ field, message }] };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseAcre(field: string, value: unknown): Result<AcreInfo, AppError> {
  if (!isPlainObject(value) || typeof value.granted !== 'boolean') {
    return err(validationError(field, 'acre attend { granted: boolean, startDate?: "YYYY-MM-DD" }.'));
  }
  if (value.startDate !== undefined && typeof value.startDate !== 'string') {
    return err(validationError(field, 'acre.startDate doit être une chaîne "YYYY-MM-DD".'));
  }
  return ok({ granted: value.granted, ...(value.startDate === undefined ? {} : { startDate: value.startDate }) });
}

function parseFiscalYearEnd(field: string, value: unknown): Result<FiscalYearEnd | null, AppError> {
  if (value === null) return ok(null);
  if (
    !isPlainObject(value) ||
    typeof value.month !== 'number' ||
    typeof value.day !== 'number' ||
    value.month < 1 ||
    value.month > 12 ||
    value.day < 1 ||
    value.day > 31
  ) {
    return err(validationError(field, 'fiscalYearEnd attend null ou { month: 1-12, day: 1-31 }.'));
  }
  return ok({ month: value.month, day: value.day });
}

function parseEnum<T extends string>(field: string, value: unknown, allowed: readonly T[]): Result<T, AppError> {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    return err(validationError(field, `valeur attendue parmi : ${allowed.join(', ')}.`));
  }
  return ok(value as T);
}

/**
 * Traduit un couple (field, value) BRUT (HTTP/voix) en FiscalProfileFieldPatch TYPÉ, avec
 * validation de forme — réutilisable par la couche HTTP (Phase 1A) ET par l'affordance vocale
 * (Phase 1B, « pose/modifie mon profil fiscal ») sans dupliquer les règles de validation.
 */
export function parseFiscalProfileFieldPatch(field: string, value: unknown): Result<FiscalProfileFieldPatch, AppError> {
  if (!(FISCAL_PROFILE_FIELDS as readonly string[]).includes(field)) {
    return err(validationError('field', `champ inconnu « ${field} » — attendu parmi : ${FISCAL_PROFILE_FIELDS.join(', ')}.`));
  }
  switch (field as FiscalProfileFieldPatch['field']) {
    case 'legalForm': {
      const r = parseEnum('value', value, LEGAL_FORMS);
      return r.ok ? ok({ field: 'legalForm', value: r.value }) : r;
    }
    case 'taxRegime': {
      const r = parseEnum('value', value, TAX_REGIMES);
      return r.ok ? ok({ field: 'taxRegime', value: r.value }) : r;
    }
    case 'socialStatus': {
      const r = parseEnum('value', value, SOCIAL_STATUSES);
      return r.ok ? ok({ field: 'socialStatus', value: r.value }) : r;
    }
    case 'activityNature': {
      const r = parseEnum('value', value, ACTIVITY_NATURES);
      return r.ok ? ok({ field: 'activityNature', value: r.value }) : r;
    }
    case 'vatRegime': {
      const r = parseEnum('value', value, VAT_REGIMES);
      return r.ok ? ok({ field: 'vatRegime', value: r.value }) : r;
    }
    case 'acre': {
      const r = parseAcre('value', value);
      return r.ok ? ok({ field: 'acre', value: r.value }) : r;
    }
    case 'versementLiberatoire': {
      if (typeof value !== 'boolean') return err(validationError('value', 'versementLiberatoire attend un booléen.'));
      return ok({ field: 'versementLiberatoire', value });
    }
    case 'fiscalYearEnd': {
      const r = parseFiscalYearEnd('value', value);
      return r.ok ? ok({ field: 'fiscalYearEnd', value: r.value }) : r;
    }
  }
}

/**
 * UpdateFiscalProfileField (Phase 1A) — met à jour UN champ à la fois, statut forcé à
 * 'confirme_utilisateur' (FiscalProfile.withField), invariants revalidés (rejet DomainResult si
 * incohérent — le champ n'est alors PAS modifié). Absent en base : dérive l'initial d'abord
 * (comme GetFiscalProfile) puis applique le patch par-dessus, pour que la toute première écriture
 * (avant tout GET) fonctionne aussi.
 */
export class UpdateFiscalProfileField {
  constructor(private readonly deps: { fiscalProfiles: FiscalProfileRepository }) {}

  async execute(input: {
    company: FiscalProfileDerivationInput;
    patch: FiscalProfileFieldPatch;
    now: Instant;
    source?: FiscalDatumSource;
  }): Promise<Result<FiscalProfileView, AppError>> {
    const existing = await this.deps.fiscalProfiles.findByCompanyId(input.company.id);
    const base = existing ?? buildInitialFiscalProfile(input.company, input.now);

    const updated = base.withField(input.patch, input.now, input.source ?? 'user_form');
    if (!updated.ok) return err(appDomain(updated.error));

    await this.deps.fiscalProfiles.save(updated.value);
    return ok(updated.value.toProps());
  }
}

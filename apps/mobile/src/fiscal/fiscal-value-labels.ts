import { t, type Personality } from '@bob/i18n';
import {
  datumValue,
  type AcreInfo,
  type FiscalActivityNature,
  type FiscalDatum,
  type FiscalProfileView,
  type FiscalSocialStatus,
  type FiscalTaxRegime,
  type FiscalVatRegime,
  type FiscalYearEnd,
  type LegalForm,
} from '@bob/core';
import {
  ACTIVITY_LABEL_KEY,
  LEGAL_FORM_LABEL_KEY,
  SOCIAL_STATUS_LABEL_KEY,
  TAX_REGIME_LABEL_KEY,
  VAT_REGIME_LABEL_KEY,
  type FiscalProfileFieldName,
} from './fiscal-i18n-keys';
import { formatMonthYear } from './fiscal-dates';

/** Libellés « valeur affichée » d'un champ fiscal — partagés par l'écran « Mon profil fiscal »
 * (colonne valeur) et la confirmation vocale (diff avant/après, amendement 7). */

export function legalFormLabel(value: LegalForm, personality: Personality): string {
  return t(LEGAL_FORM_LABEL_KEY[value], { personality });
}
export function taxRegimeLabel(value: FiscalTaxRegime, personality: Personality): string {
  return t(TAX_REGIME_LABEL_KEY[value], { personality });
}
export function socialStatusLabel(value: FiscalSocialStatus, personality: Personality): string {
  return t(SOCIAL_STATUS_LABEL_KEY[value], { personality });
}
export function activityNatureLabel(value: FiscalActivityNature, personality: Personality): string {
  return t(ACTIVITY_LABEL_KEY[value], { personality });
}
export function vatRegimeLabel(value: FiscalVatRegime, personality: Personality): string {
  return t(VAT_REGIME_LABEL_KEY[value], { personality });
}
export function boolLabel(value: boolean, personality: Personality): string {
  return t(value ? 'fiscal.boolValue.yes' : 'fiscal.boolValue.no', { personality });
}
export function acreLabel(value: AcreInfo, personality: Personality): string {
  if (!value.granted) return t('fiscal.acreValue.notGranted', { personality });
  return value.startDate
    ? t('fiscal.acreValue.grantedSince', { personality, params: { date: formatMonthYear(value.startDate) } })
    : t('fiscal.acreValue.granted', { personality });
}
export function fiscalYearEndLabel(value: FiscalYearEnd | null, personality: Personality): string {
  if (value === null) return t('fiscal.yearEnd.civil', { personality });
  return `${value.day}/${String(value.month).padStart(2, '0')}`;
}

/** Date locale courte (jj/mm/aaaa) — captions de source de l'écran « Mon profil fiscal ». */
function frShortDate(instant: string): string {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return instant;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

/** Légende de SOURCE d'un champ (amendement 6 : « source + date + statut en texte »). Ne lit
 * jamais `.value` — accepte `FiscalDatum<unknown>` pour rester assignable depuis `profile[field]`
 * indexé par un champ dynamique (union de FiscalDatum<X> hétérogènes, pas de generic à inférer). */
export function fieldSourceCaption(datum: FiscalDatum<unknown>, personality: Personality): string {
  if (datum.status === 'manquant') return t('fiscal.source.missingHint', { personality });
  if (datum.status === 'hypothese') return t('fiscal.source.hypothesis', { personality });
  if (datum.status === 'source_fiable') {
    return t('fiscal.source.insee', { personality, params: { date: frShortDate(datum.updatedAt) } });
  }
  return t('fiscal.source.userConfirmed', { personality, params: { date: frShortDate(datum.updatedAt) } });
}

/** Valeur affichée (colonne « valeur ») pour N'IMPORTE quel champ du profil — dispatch unique,
 * réutilisé par l'écran « Mon profil fiscal » (une ligne par champ, FISCAL_PROFILE_FIELDS). */
export function fieldValueDisplay(field: FiscalProfileFieldName, profile: FiscalProfileView, personality: Personality): string {
  const dash = t('fiscal.source.missingHint', { personality });
  switch (field) {
    case 'legalForm': {
      const v = datumValue(profile.legalForm);
      return v ? legalFormLabel(v, personality) : dash;
    }
    case 'taxRegime': {
      const v = datumValue(profile.taxRegime);
      return v ? taxRegimeLabel(v, personality) : dash;
    }
    case 'socialStatus': {
      const v = datumValue(profile.socialStatus);
      return v ? socialStatusLabel(v, personality) : dash;
    }
    case 'activityNature': {
      const v = datumValue(profile.activityNature);
      return v ? activityNatureLabel(v, personality) : dash;
    }
    case 'vatRegime': {
      const v = datumValue(profile.vatRegime);
      return v ? vatRegimeLabel(v, personality) : dash;
    }
    case 'acre': {
      const v = datumValue(profile.acre);
      return v ? acreLabel(v, personality) : dash;
    }
    case 'versementLiberatoire': {
      const v = datumValue(profile.versementLiberatoire);
      return v === undefined ? dash : boolLabel(v, personality);
    }
    case 'fiscalYearEnd': {
      if (profile.fiscalYearEnd.status === 'manquant') return dash;
      return fiscalYearEndLabel(datumValue(profile.fiscalYearEnd) ?? null, personality);
    }
  }
}

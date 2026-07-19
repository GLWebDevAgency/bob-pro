import { t, type Personality } from '@bob/i18n';
import {
  KEY_MICRO_CEILING_SERVICES,
  KEY_MICRO_CEILING_VENTE,
  datumValue,
  formatEURWhole,
  resolveParameter,
  type AcreInfo,
  type DateOnly,
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
 * indexé par un champ dynamique (union de FiscalDatum<X> hétérogènes, pas de generic à inférer).
 * Trois natures de 'source_fiable', distinguées par `datum.source` (papa vocal — dire d'où ça
 * vient, honnêtement, jamais « INSEE » pour tout) :
 * · 'derived_legal_form' → CERTITUDE JURIDIQUE (le statut social d'un président de SASU, le VL
 *   inapplicable hors micro…) : « c'est la loi qui le dit », PAS une donnée INSEE ;
 * · 'user_form' → donnée REPRISE de l'inscription (le choix d'onboarding), pas une fiche SIRET ;
 * · autre (insee_siret, historique sans source) → donnée d'une fiche SIRET. */
export function fieldSourceCaption(datum: FiscalDatum<unknown>, personality: Personality): string {
  if (datum.status === 'manquant') return t('fiscal.source.missingHint', { personality });
  if (datum.status === 'hypothese') return t('fiscal.source.hypothesis', { personality });
  if (datum.status === 'source_fiable') {
    if (datum.source === 'derived_legal_form') {
      return t('fiscal.source.lawDerived', { personality, params: { date: frShortDate(datum.updatedAt) } });
    }
    if (datum.source === 'user_form') {
      return t('fiscal.source.fromRegistration', { personality, params: { date: frShortDate(datum.updatedAt) } });
    }
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

/**
 * Plafonds micro EN VIGUEUR à une date donnée, formatés pour les clés pédagogiques
 * `fiscal.tax_regime_choice.*.micro` ({ventes}/{services}) — JAMAIS un montant en dur dans le
 * catalogue i18n (chiffre périmable) : la seule source est le référentiel temporel sourcé
 * (@bob/core resolveParameter, art. 50-0/102 ter CGI). Fonction PURE (date injectée par
 * l'appelant). Hors de toute fenêtre connue, resolveParameter renvoie la valeur la plus proche
 * (jamais inventée) — le « ≈ » déjà présent dans la copy garde le ton honnête.
 */
export function microCeilingParams(today: DateOnly): { readonly ventes: string; readonly services: string } {
  const ventes = resolveParameter(KEY_MICRO_CEILING_VENTE, today);
  const services = resolveParameter(KEY_MICRO_CEILING_SERVICES, today);
  return {
    ventes: formatEURWhole(ventes.value * 100),
    services: formatEURWhole(services.value * 100),
  };
}

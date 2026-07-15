import type {
  FiscalActivityNature,
  FiscalDatumStatus,
  FiscalSocialStatus,
  FiscalTaxRegime,
  FiscalVatRegime,
  LegalForm,
} from '@bob/core';
import type { I18nKey } from '@bob/i18n';
import { LEGAL_REGIME_COMBOS } from './legal-regime-combos';

/** Tables de correspondance ENUM → clé i18n — la seule source de vérité des libellés fiscaux,
 * partagée par le mini-flow, l'écran « Mon profil fiscal » et le module voix (parité stricte). */

export const LEGAL_REGIME_COMBO_LABEL_KEY: Readonly<Record<string, I18nKey>> = Object.fromEntries(
  LEGAL_REGIME_COMBOS.map((c) => [c.id, `fiscal.combo.${c.id}.label` as I18nKey]),
);
export const LEGAL_REGIME_COMBO_DESC_KEY: Readonly<Record<string, I18nKey>> = Object.fromEntries(
  LEGAL_REGIME_COMBOS.map((c) => [c.id, `fiscal.combo.${c.id}.desc` as I18nKey]),
);

export const ACTIVITY_LABEL_KEY: Readonly<Record<FiscalActivityNature, I18nKey>> = {
  bic_vente: 'fiscal.activity.bic_vente.label',
  bic_service: 'fiscal.activity.bic_service.label',
  bnc: 'fiscal.activity.bnc.label',
  bnc_cipav: 'fiscal.activity.bnc_cipav.label',
  mixte: 'fiscal.activity.mixte.label',
};
export const ACTIVITY_DESC_KEY: Readonly<Record<FiscalActivityNature, I18nKey>> = {
  bic_vente: 'fiscal.activity.bic_vente.desc',
  bic_service: 'fiscal.activity.bic_service.desc',
  bnc: 'fiscal.activity.bnc.desc',
  bnc_cipav: 'fiscal.activity.bnc_cipav.desc',
  mixte: 'fiscal.activity.mixte.desc',
};

export const VAT_REGIME_LABEL_KEY: Readonly<Record<FiscalVatRegime, I18nKey>> = {
  franchise: 'fiscal.vat.franchise.label',
  reel_simplifie: 'fiscal.vat.reel_simplifie.label',
  reel_normal: 'fiscal.vat.reel_normal.label',
};
export const VAT_REGIME_DESC_KEY: Readonly<Record<FiscalVatRegime, I18nKey>> = {
  franchise: 'fiscal.vat.franchise.desc',
  reel_simplifie: 'fiscal.vat.reel_simplifie.desc',
  reel_normal: 'fiscal.vat.reel_normal.desc',
};

export const TAX_REGIME_LABEL_KEY: Readonly<Record<FiscalTaxRegime, I18nKey>> = {
  micro: 'fiscal.taxRegime.micro',
  reel_ir: 'fiscal.taxRegime.reel_ir',
  is: 'fiscal.taxRegime.is',
  option_ir: 'fiscal.taxRegime.option_ir',
};

export const LEGAL_FORM_LABEL_KEY: Readonly<Record<LegalForm, I18nKey>> = {
  EI: 'fiscal.legalForm.EI',
  EURL: 'fiscal.legalForm.EURL',
  SASU: 'fiscal.legalForm.SASU',
  SARL: 'fiscal.legalForm.SARL',
  SAS: 'fiscal.legalForm.SAS',
  micro: 'fiscal.legalForm.micro',
};

export const SOCIAL_STATUS_LABEL_KEY: Readonly<Record<FiscalSocialStatus, I18nKey>> = {
  tns: 'fiscal.socialStatus.tns',
  assimile_salarie: 'fiscal.socialStatus.assimile_salarie',
};

export const FIELD_NAME_KEY = {
  legalForm: 'fiscal.field.legalForm',
  taxRegime: 'fiscal.field.taxRegime',
  socialStatus: 'fiscal.field.socialStatus',
  activityNature: 'fiscal.field.activityNature',
  vatRegime: 'fiscal.field.vatRegime',
  acre: 'fiscal.field.acre',
  versementLiberatoire: 'fiscal.field.versementLiberatoire',
  fiscalYearEnd: 'fiscal.field.fiscalYearEnd',
} as const satisfies Record<string, I18nKey>;

/** Les 8 champs de FISCAL_PROFILE_FIELDS (@bob/core) — type canonique réutilisé par l'écran
 * « Mon profil fiscal », son édition par champ et les libellés de valeur affichée. */
export type FiscalProfileFieldName = keyof typeof FIELD_NAME_KEY;

/** Amendement 6 : le statut se lit EN TEXTE, jamais couleur/coche seules — 'source_fiable' se lit
 * comme 'confirme_utilisateur' (une fiche SIRET est déjà fiable), seule la légende de SOURCE change. */
export const FIELD_STATUS_LABEL_KEY: Readonly<Record<FiscalDatumStatus, I18nKey>> = {
  source_fiable: 'fiscal.status.confirmed',
  confirme_utilisateur: 'fiscal.status.confirmed',
  hypothese: 'fiscal.status.toConfirm',
  manquant: 'fiscal.status.missing',
};

/** Tonalité associée au statut — la couleur ACCOMPAGNE le texte (amendement 6), jamais seule. */
export type FieldStatusTone = 'success' | 'warning' | 'neutral';
export const FIELD_STATUS_TONE: Readonly<Record<FiscalDatumStatus, FieldStatusTone>> = {
  source_fiable: 'success',
  confirme_utilisateur: 'success',
  hypothese: 'warning',
  manquant: 'neutral',
};

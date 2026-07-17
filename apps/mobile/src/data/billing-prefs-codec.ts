/**
 * Codec PUR des préférences facturation locales (Réglages facturation §Aperçu/§RIB/§Assurance/
 * §Valeurs par défaut) — séparé de `billing-prefs.ts` (le hook React) UNIQUEMENT pour rester
 * testable sans transiter par `react-native` (Alert/Linking, importés par `./hooks` — Vitest
 * `environment: 'node'` de ce workspace ne sait pas parser le flow-type de react-native/index.js).
 * Zéro import React/React Native ici : types + fonctions pures seulement.
 *
 * Doctrine (détail complet dans billing-prefs.ts) : ce ne sont PAS des champs serveur — préférences
 * locales sobres, jamais un formulaire fantôme, chaque champ a un effet réel documenté ailleurs.
 */
export type PdfAccentColor = 'navy' | 'green' | 'purple' | 'orange';
export type PaymentTermsPreset = 'reception' | 'j30' | 'j45';

export interface BillingPrefs {
  readonly showRibOnInvoices: boolean;
  readonly showInsuranceOnInvoices: boolean;
  readonly pdfAccentColor: PdfAccentColor;
  readonly defaultQuoteValidityDays: number;
  readonly defaultDepositPercent: number;
  readonly defaultPaymentTerms: PaymentTermsPreset;
  readonly logoUri: string | null;
}

export const DEFAULT_BILLING_PREFS: BillingPrefs = {
  showRibOnInvoices: false,
  showInsuranceOnInvoices: true,
  pdfAccentColor: 'navy',
  defaultQuoteValidityDays: 30,
  defaultDepositPercent: 30,
  defaultPaymentTerms: 'reception',
  logoUri: null,
};

const ACCENT_COLORS: readonly PdfAccentColor[] = ['navy', 'green', 'purple', 'orange'];
const PAYMENT_TERMS: readonly PaymentTermsPreset[] = ['reception', 'j30', 'j45'];

export function storageKey(companyId: string): string {
  return `bob.billingPrefs.v1.${companyId}`;
}

/** Fusion défensive : un JSON partiel/corrompu ne casse jamais l'écran — chaque champ manquant
 * ou de mauvais type retombe sur son défaut, jamais une exception qui viderait les réglages. */
export function parsePrefs(raw: string | null): BillingPrefs {
  if (raw === null) return DEFAULT_BILLING_PREFS;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return DEFAULT_BILLING_PREFS;
  }
  if (obj === null || typeof obj !== 'object') return DEFAULT_BILLING_PREFS;
  const o = obj as Partial<Record<keyof BillingPrefs, unknown>>;
  return {
    showRibOnInvoices: typeof o.showRibOnInvoices === 'boolean' ? o.showRibOnInvoices : DEFAULT_BILLING_PREFS.showRibOnInvoices,
    showInsuranceOnInvoices:
      typeof o.showInsuranceOnInvoices === 'boolean' ? o.showInsuranceOnInvoices : DEFAULT_BILLING_PREFS.showInsuranceOnInvoices,
    pdfAccentColor:
      typeof o.pdfAccentColor === 'string' && ACCENT_COLORS.includes(o.pdfAccentColor as PdfAccentColor)
        ? (o.pdfAccentColor as PdfAccentColor)
        : DEFAULT_BILLING_PREFS.pdfAccentColor,
    defaultQuoteValidityDays:
      typeof o.defaultQuoteValidityDays === 'number' && Number.isInteger(o.defaultQuoteValidityDays) && o.defaultQuoteValidityDays > 0
        ? o.defaultQuoteValidityDays
        : DEFAULT_BILLING_PREFS.defaultQuoteValidityDays,
    defaultDepositPercent:
      typeof o.defaultDepositPercent === 'number' && o.defaultDepositPercent >= 0 && o.defaultDepositPercent <= 100
        ? o.defaultDepositPercent
        : DEFAULT_BILLING_PREFS.defaultDepositPercent,
    defaultPaymentTerms:
      typeof o.defaultPaymentTerms === 'string' && PAYMENT_TERMS.includes(o.defaultPaymentTerms as PaymentTermsPreset)
        ? (o.defaultPaymentTerms as PaymentTermsPreset)
        : DEFAULT_BILLING_PREFS.defaultPaymentTerms,
    logoUri: typeof o.logoUri === 'string' && o.logoUri.length > 0 ? o.logoUri : null,
  };
}

export function serializePrefs(prefs: BillingPrefs): string {
  return JSON.stringify(prefs);
}

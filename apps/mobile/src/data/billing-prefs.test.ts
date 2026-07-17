import { describe, expect, it } from 'vitest';
import { DEFAULT_BILLING_PREFS, parsePrefs, serializePrefs, storageKey } from './billing-prefs-codec';

describe('billing-prefs — parsePrefs', () => {
  it('renvoie les défauts quand rien n’est stocké (raw=null)', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_BILLING_PREFS);
  });

  it('renvoie les défauts sur un JSON corrompu — jamais une exception', () => {
    expect(parsePrefs('{not json')).toEqual(DEFAULT_BILLING_PREFS);
  });

  it('renvoie les défauts sur un JSON valide mais pas un objet', () => {
    expect(parsePrefs('42')).toEqual(DEFAULT_BILLING_PREFS);
    expect(parsePrefs('null')).toEqual(DEFAULT_BILLING_PREFS);
  });

  it('round-trip : serialize puis parse redonne exactement les mêmes préférences', () => {
    const prefs = {
      showRibOnInvoices: true,
      showInsuranceOnInvoices: false,
      pdfAccentColor: 'purple' as const,
      defaultQuoteValidityDays: 45,
      defaultDepositPercent: 20,
      defaultPaymentTerms: 'j30' as const,
      logoUri: 'file:///doc/logo.png',
    };
    expect(parsePrefs(serializePrefs(prefs))).toEqual(prefs);
  });

  it('un champ de mauvais type ou une valeur hors énumération retombe sur son défaut, sans affecter les autres champs', () => {
    const raw = JSON.stringify({
      showRibOnInvoices: 'oui', // mauvais type
      pdfAccentColor: 'rose', // hors énumération
      defaultQuoteValidityDays: -5, // hors borne
      defaultDepositPercent: 250, // hors borne
      defaultPaymentTerms: 'j30',
      logoUri: 'file:///doc/logo.png',
    });
    expect(parsePrefs(raw)).toEqual({
      ...DEFAULT_BILLING_PREFS,
      defaultPaymentTerms: 'j30',
      logoUri: 'file:///doc/logo.png',
    });
  });

  it('logoUri vide (chaîne) retombe sur null plutôt que de persister une chaîne vide', () => {
    expect(parsePrefs(JSON.stringify({ logoUri: '' }))).toEqual(DEFAULT_BILLING_PREFS);
  });
});

describe('billing-prefs — storageKey', () => {
  it('scope la clé par société — deux sociétés ne partagent jamais leurs réglages', () => {
    expect(storageKey('company-a')).not.toBe(storageKey('company-b'));
    expect(storageKey('company-a')).toBe('bob.billingPrefs.v1.company-a');
  });
});

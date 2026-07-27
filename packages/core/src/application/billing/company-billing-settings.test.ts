import { describe, expect, it } from 'vitest';
import { validateCompanyBillingSettingsPatch } from './company-billing-settings';

describe('company billing settings', () => {
  it('accepte uniquement les réglages métier bornés', () => {
    expect(
      validateCompanyBillingSettingsPatch({
        showRibOnInvoices: true,
        pdfAccentColor: 'purple',
        defaultQuoteValidityDays: 45,
        defaultDepositPercent: 20,
        defaultInvoicePaymentTermsDays: 30,
      }),
    ).toEqual({
      ok: true,
      value: {
        showRibOnInvoices: true,
        pdfAccentColor: 'purple',
        defaultQuoteValidityDays: 45,
        defaultDepositPercent: 20,
        defaultInvoicePaymentTermsDays: 30,
      },
    });
  });

  it.each([
    [{}, 'settings'],
    [{ defaultQuoteValidityDays: 0 }, 'defaultQuoteValidityDays'],
    [{ defaultQuoteValidityDays: 366 }, 'defaultQuoteValidityDays'],
    [{ defaultDepositPercent: -1 }, 'defaultDepositPercent'],
    [{ defaultDepositPercent: 101 }, 'defaultDepositPercent'],
    [{ defaultInvoicePaymentTermsDays: 0 }, 'defaultInvoicePaymentTermsDays'],
    [{ defaultInvoicePaymentTermsDays: 61 }, 'defaultInvoicePaymentTermsDays'],
    [{ pdfAccentColor: 'rose' }, 'pdfAccentColor'],
  ])('refuse un patch invalide %#', (patch, field) => {
    const result = validateCompanyBillingSettingsPatch(patch as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect('field' in result.error ? result.error.field : undefined).toBe(field);
    }
  });

  it('autorise l’absence explicite de conditions sans lui substituer un délai', () => {
    expect(validateCompanyBillingSettingsPatch({ defaultInvoicePaymentTermsDays: null })).toEqual({
      ok: true,
      value: { defaultInvoicePaymentTermsDays: null },
    });
  });

  // ── PR-06 — cadence de relance paramétrable ──

  it('accepte une cadence valide (4 seuils strictement croissants) et son retrait (null = défaut)', () => {
    const policy = {
      cordialAfterDays: 15,
      neutreAfterDays: 30,
      fermeAfterDays: 45,
      miseEnDemeureAfterDays: 60,
    };
    expect(validateCompanyBillingSettingsPatch({ relancePolicy: policy }).ok).toBe(true);
    expect(validateCompanyBillingSettingsPatch({ relancePolicy: null }).ok).toBe(true);
    expect(validateCompanyBillingSettingsPatch({ relanceAutoEnabled: false }).ok).toBe(true);
  });

  it.each([
    // Ordre non strictement croissant : la MED partirait avant la relance ferme.
    [{ cordialAfterDays: 15, neutreAfterDays: 30, fermeAfterDays: 45, miseEnDemeureAfterDays: 30 }],
    [{ cordialAfterDays: 10, neutreAfterDays: 10, fermeAfterDays: 20, miseEnDemeureAfterDays: 30 }],
    // Bornes : 0 et > 365 ne sont pas des cadences réelles.
    [{ cordialAfterDays: 0, neutreAfterDays: 10, fermeAfterDays: 20, miseEnDemeureAfterDays: 30 }],
    [{ cordialAfterDays: 3, neutreAfterDays: 10, fermeAfterDays: 20, miseEnDemeureAfterDays: 366 }],
    [{ cordialAfterDays: 1.5, neutreAfterDays: 10, fermeAfterDays: 20, miseEnDemeureAfterDays: 30 }],
  ])('refuse une cadence incohérente %#', (policy) => {
    const result = validateCompanyBillingSettingsPatch({ relancePolicy: policy });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect('field' in result.error ? result.error.field : undefined).toBe('relancePolicy');
    }
  });
});

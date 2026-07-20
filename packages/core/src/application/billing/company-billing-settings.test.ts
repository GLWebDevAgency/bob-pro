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
});

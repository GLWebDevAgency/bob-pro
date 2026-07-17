import { describe, expect, it, vi } from 'vitest';
import type { BackendService } from './backend.service';
import { CompanyLookupController } from './api.controllers';

function controller(overrides: Partial<BackendService> = {}) {
  return new CompanyLookupController(overrides as BackendService);
}

describe('CompanyLookupController — profil société confirmé', () => {
  it('refuse tout champ hors contrat avant la couche application', async () => {
    const updateCompanyProfile = vi.fn();
    const value = controller({ updateCompanyProfile } as never);

    await expect(
      value.updateProfile({
        trade: 'plombier',
        vatRegime: 'franchise',
        companyId: 'other-company',
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(updateCompanyProfile).not.toHaveBeenCalled();
  });

  it('refuse un métier ou un régime TVA inconnu au lieu de les normaliser', async () => {
    const updateCompanyProfile = vi.fn();
    const value = controller({ updateCompanyProfile } as never);

    await expect(
      value.updateProfile({ trade: 'artisan', vatRegime: 'auto' }),
    ).rejects.toMatchObject({ status: 422 });
    expect(updateCompanyProfile).not.toHaveBeenCalled();
  });

  it('refuse un portefeuille clientèle inconnu au lieu de le conserver localement', async () => {
    const updateCompanyProfile = vi.fn();
    const value = controller({ updateCompanyProfile } as never);

    await expect(
      value.updateProfile({
        trade: 'plombier',
        vatRegime: 'franchise',
        customerPortfolio: 'particuliers_et_amis',
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(updateCompanyProfile).not.toHaveBeenCalled();
  });

  it('transmet uniquement les choix explicites validés', async () => {
    const updateCompanyProfile = vi.fn(async () => ({
      ok: true as const,
      value: { trade: 'electricien', vatRegime: 'reel_simpl' },
    }));
    const value = controller({ updateCompanyProfile } as never);

    await expect(
      value.updateProfile({
        trade: 'electricien',
        vatRegime: 'reel_simpl',
        customerPortfolio: 'b2g',
      }),
    ).resolves.toMatchObject({ trade: 'electricien', vatRegime: 'reel_simpl' });
    expect(updateCompanyProfile).toHaveBeenCalledWith({
      trade: 'electricien',
      vatRegime: 'reel_simpl',
      customerPortfolio: 'b2g',
    });
  });
});

describe('CompanyLookupController — coordonnées bancaires (RIB)', () => {
  it('refuse tout champ hors contrat', async () => {
    const updateCompanyBilling = vi.fn();
    const value = controller({ updateCompanyBilling } as never);

    await expect(
      value.updateBilling({ iban: 'FR76 3000 6000 0112 3456 7890 189', logo: 'x' }),
    ).rejects.toMatchObject({ status: 422 });
    expect(updateCompanyBilling).not.toHaveBeenCalled();
  });

  it('refuse un IBAN au format ou à la clé de contrôle invalide', async () => {
    const updateCompanyBilling = vi.fn();
    const value = controller({ updateCompanyBilling } as never);

    await expect(
      value.updateBilling({ iban: 'FR76 3000 6000 0112 3456 7890 188' }),
    ).rejects.toMatchObject({ status: 422 });
    expect(updateCompanyBilling).not.toHaveBeenCalled();
  });

  it('refuse un BIC mal formé', async () => {
    const updateCompanyBilling = vi.fn();
    const value = controller({ updateCompanyBilling } as never);

    await expect(value.updateBilling({ bic: 'trop-court' })).rejects.toMatchObject({ status: 422 });
    expect(updateCompanyBilling).not.toHaveBeenCalled();
  });

  it('normalise un IBAN valide (espaces retirés, majuscules) avant transmission', async () => {
    const updateCompanyBilling = vi.fn(async () => ({
      ok: true as const,
      value: { iban: 'FR7630006000011234567890189' },
    }));
    const value = controller({ updateCompanyBilling } as never);

    await value.updateBilling({ iban: 'fr76 3000 6000 0112 3456 7890 189' });
    expect(updateCompanyBilling).toHaveBeenCalledWith({
      iban: 'FR7630006000011234567890189',
      bic: undefined,
    });
  });

  it('accepte un effacement explicite (null) sans toucher au champ non transmis', async () => {
    const updateCompanyBilling = vi.fn(async () => ({ ok: true as const, value: {} }));
    const value = controller({ updateCompanyBilling } as never);

    await value.updateBilling({ iban: null });
    expect(updateCompanyBilling).toHaveBeenCalledWith({ iban: null, bic: undefined });
  });
});

describe('CompanyLookupController — réglages facturation canoniques', () => {
  it('refuse toujours un logo sans stockage objet et un ancien format de conditions', async () => {
    const updateCompanyBillingSettings = vi.fn();
    const value = controller({ updateCompanyBillingSettings } as never);

    await expect(
      value.updateBillingSettings({
        expectedRevision: 1,
        logoUri: 'file:///private/logo.png',
        defaultPaymentTerms: 'j30',
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(updateCompanyBillingSettings).not.toHaveBeenCalled();
  });

  it('accepte uniquement un délai de paiement explicite borné ou son effacement', async () => {
    const updateCompanyBillingSettings = vi.fn(async ({ patch }) => ({
      ok: true as const,
      value: { revision: 3, ...patch },
    }));
    const value = controller({ updateCompanyBillingSettings } as never);

    await expect(
      value.updateBillingSettings({
        expectedRevision: 2,
        defaultInvoicePaymentTermsDays: 30,
      }),
    ).resolves.toMatchObject({ defaultInvoicePaymentTermsDays: 30 });
    expect(updateCompanyBillingSettings).toHaveBeenLastCalledWith({
      expectedRevision: 2,
      patch: { defaultInvoicePaymentTermsDays: 30 },
    });

    await expect(
      value.updateBillingSettings({
        expectedRevision: 2,
        defaultInvoicePaymentTermsDays: 0,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('exige une révision CAS et au moins un réglage', async () => {
    const updateCompanyBillingSettings = vi.fn();
    const value = controller({ updateCompanyBillingSettings } as never);

    await expect(value.updateBillingSettings({ expectedRevision: 0 })).rejects.toMatchObject({
      status: 422,
    });
    expect(updateCompanyBillingSettings).not.toHaveBeenCalled();
  });

  it('transmet uniquement les champs bornés avec la révision attendue', async () => {
    const updateCompanyBillingSettings = vi.fn(async () => ({
      ok: true as const,
      value: { revision: 8, pdfAccentColor: 'purple' },
    }));
    const value = controller({ updateCompanyBillingSettings } as never);

    await expect(
      value.updateBillingSettings({
        expectedRevision: 7,
        pdfAccentColor: 'purple',
        defaultQuoteValidityDays: 45,
        defaultDepositPercent: 20,
        defaultInvoicePaymentTermsDays: 30,
      }),
    ).resolves.toMatchObject({ revision: 8 });
    expect(updateCompanyBillingSettings).toHaveBeenCalledWith({
      expectedRevision: 7,
      patch: {
        pdfAccentColor: 'purple',
        defaultQuoteValidityDays: 45,
        defaultDepositPercent: 20,
        defaultInvoicePaymentTermsDays: 30,
      },
    });
  });
});

import { describe, expect, it } from 'vitest';
import { appErrorMessage } from './app-error-message';

/**
 * Bug terrain 20/07 (APK 4f027256) : le refus serveur `kind: 'validation'` — porteur d'un
 * message métier actionnable (« Email du client manquant — complète sa fiche… », endpoint
 * embargo-scheduled-payment, 422 vérifié en prod) — tombait sur le fallback générique
 * « Action impossible. Réessaie. ». Le mobile ne reformule JAMAIS un refus : il affiche le
 * message honnête du serveur, source unique (même doctrine que les refus `domain`).
 */
describe('appErrorMessage', () => {
  it("affiche le message de la première issue d'un refus validation", () => {
    expect(
      appErrorMessage({
        kind: 'validation',
        issues: [
          {
            field: 'customer.email',
            message: 'Email du client manquant — complète sa fiche pour programmer l’envoi.',
          },
          { field: 'quoteId', message: 'secondaire' },
        ],
      }),
    ).toBe('Email du client manquant — complète sa fiche pour programmer l’envoi.');
  });

  it('validation difforme (issues vides, message absent ou non-string) => fallback générique', () => {
    expect(appErrorMessage({ kind: 'validation', issues: [] })).toBe('Action impossible. Réessaie.');
    expect(appErrorMessage({ kind: 'validation', issues: [{ field: 'x' }] })).toBe(
      'Action impossible. Réessaie.',
    );
    expect(appErrorMessage({ kind: 'validation', issues: [{ field: 'x', message: 42 }] })).toBe(
      'Action impossible. Réessaie.',
    );
    expect(appErrorMessage({ kind: 'validation' })).toBe('Action impossible. Réessaie.');
  });

  it('conserve les mappings existants (domain, forbidden, dependency, not_found)', () => {
    expect(
      appErrorMessage({ kind: 'domain', error: { code: 'X', message: 'Refus du domaine.' } }),
    ).toBe('Refus du domaine.');
    expect(appErrorMessage({ kind: 'forbidden', reason: 'Offre insuffisante.' })).toBe(
      'Offre insuffisante.',
    );
    expect(appErrorMessage({ kind: 'forbidden' })).toBe('Action non autorisée pour ton offre.');
    expect(appErrorMessage({ kind: 'dependency' })).toBe(
      'Service indisponible pour le moment. Réessaie ou saisis les infos à la main.',
    );
    expect(appErrorMessage({ kind: 'not_found' })).toBe('Introuvable.');
  });

  it('inconnu / null / non-objet => fallback générique', () => {
    expect(appErrorMessage(null)).toBe('Action impossible. Réessaie.');
    expect(appErrorMessage(undefined)).toBe('Action impossible. Réessaie.');
    expect(appErrorMessage('boom')).toBe('Action impossible. Réessaie.');
    expect(appErrorMessage({ kind: 'jamais_vu' })).toBe('Action impossible. Réessaie.');
  });
});

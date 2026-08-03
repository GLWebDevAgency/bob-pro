import { describe, it, expect } from 'vitest';
import { DocNumber } from './doc-number';

describe('DocNumber', () => {
  it('formate D-2026-0014', () => {
    expect(DocNumber.format('D', 2026, 14).value).toBe('D-2026-0014');
  });
  it('valide un numero bien forme', () => {
    expect(DocNumber.of('F-2026-0118').ok).toBe(true);
  });
  it('rejette un format invalide', () => {
    expect(DocNumber.of('2026/118').ok).toBe(false);
  });

  /**
   * VERROU (vague hors-lots, audit 03/08) : reglages-facturation choisit la « dernière facture
   * émise » par MAX LEXICOGRAPHIQUE des numéros — ce n'est correct que si le zéro-padding
   * serveur rend la séquence d'une même année lexicographiquement MONOTONE sur la plage
   * réellement atteignable. Le plancher est 4 chiffres : 999→1000 ne casse PAS (F-2026-0999 <
   * F-2026-1000). La limite structurelle documentée est 9999→10000 (padStart dépassé) : si ce
   * test rouge un jour parce que le padding a changé, l'UI mobile doit changer AVEC lui.
   */
  it('padding 4 : la séquence annuelle reste lexicographiquement monotone jusqu à 9999 (verrou UI « dernier numéro »)', () => {
    expect(DocNumber.format('F', 2026, 999).value < DocNumber.format('F', 2026, 1000).value).toBe(
      true,
    );
    expect(DocNumber.format('F', 2026, 1000).value).toBe('F-2026-1000');
    // Limite structurelle ASSUMÉE du verrou (documentée, pas souhaitée) : au 10000e document
    // d'une même année, le max lexicographique cesserait d'être le max numérique.
    expect(
      DocNumber.format('F', 2026, 9999).value < DocNumber.format('F', 2026, 10_000).value,
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  companyIncompleteGateSpec,
  paymentTermsMissingGateSpec,
  FIELD_EDITOR_ROUTE,
} from './document-gates.logic';

/**
 * RÉGRESSION du cul-de-sac d'émission (terrain 20/07) : le gate « entreprise incomplète »
 * routait vers `/compte`, écran qui ne porte ni `rcsOrRm` ni l'adresse — l'utilisateur ne
 * pouvait réparer NULLE PART et n'émettait plus jamais de facture.
 */
describe('destination des gates d’émission', () => {
  it('envoie le gate « entreprise incomplète » vers l’écran qui porte RCS/RM et adresse', () => {
    for (const kind of ['quote', 'invoice'] as const) {
      expect(companyIncompleteGateSpec(kind, 'pote').route).toBe('/reglages-facturation');
    }
  });

  it('ne route JAMAIS un blocage d’émission vers /compte (aucun de ces champs n’y vit)', () => {
    const routes = [
      companyIncompleteGateSpec('quote', 'pro').route,
      companyIncompleteGateSpec('invoice', 'direct').route,
      paymentTermsMissingGateSpec('pote').route,
    ];
    expect(routes).not.toContain('/compte');
  });

  it('dérive la route de la carte champ → écran (pas d’URL écrite à la main dans le gate)', () => {
    expect(companyIncompleteGateSpec('invoice', 'pote').route).toBe(FIELD_EDITOR_ROUTE.rcsOrRm);
    expect(companyIncompleteGateSpec('invoice', 'pote').route).toBe(FIELD_EDITOR_ROUTE.address);
    expect(paymentTermsMissingGateSpec('pote').route).toBe(FIELD_EDITOR_ROUTE.paymentTerms);
  });

  it('décline les textes sur les 3 tons, sans clé manquante', () => {
    for (const personality of ['pote', 'pro', 'direct'] as const) {
      const gate = companyIncompleteGateSpec('quote', personality);
      for (const text of [gate.title, gate.body, gate.ctaLabel, gate.cancelLabel]) {
        expect(text.length).toBeGreaterThan(0);
        // Une clé absente serait renvoyée telle quelle par `t` — jamais de « gate.xxx » à l'écran.
        expect(text.startsWith('gate.')).toBe(false);
      }
    }
  });
});

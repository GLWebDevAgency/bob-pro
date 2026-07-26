import { describe, expect, it } from 'vitest';
import {
  ADVANCE_FALLBACK_DEFAULT_PERCENT,
  deriveProfessionalAdvanceFallback,
  hasLivingSituationSibling,
  type AdvanceFallbackSibling,
} from './professional-advance-fallback.logic';

const sibling = (
  parentQuoteId: string | null,
  kind: AdvanceFallbackSibling['kind'],
  status: AdvanceFallbackSibling['status'],
): AdvanceFallbackSibling => ({ parentQuoteId, kind, status });

describe('repli acompte professionnel — « Situation n°1 » (décision fondateur 25/07)', () => {
  it.each(['b2b', 'b2g'] as const)(
    'propose la situation n°1 à %s quand le devis signé porte un acompte',
    (customerType) => {
      expect(
        deriveProfessionalAdvanceFallback({
          customerType,
          depositPct: 30,
          hasSituationSibling: false,
        }),
      ).toEqual({ offered: true, initialPercent: ADVANCE_FALLBACK_DEFAULT_PERCENT });
    },
  );

  it('30 % du marché par défaut — la valeur actée par le fondateur, celle des libellés i18n', () => {
    expect(ADVANCE_FALLBACK_DEFAULT_PERCENT).toBe(30);
    // Quel que soit le % d'acompte du devis, la proposition d'ouverture reste 30 — MODIFIABLE
    // ensuite dans la feuille situation (steppers maîtres, clamp au reste facturable).
    expect(
      deriveProfessionalAdvanceFallback({
        customerType: 'b2b',
        depositPct: 45,
        hasSituationSibling: false,
      }).initialPercent,
    ).toBe(30);
  });

  it('reste FAIL-CLOSED : fiche client absente (null) = rien d’ouvert', () => {
    expect(
      deriveProfessionalAdvanceFallback({
        customerType: null,
        depositPct: 30,
        hasSituationSibling: false,
      }).offered,
    ).toBe(false);
  });

  it('jamais pour un B2C : son vrai chemin d’acompte (PDF/e-reporting) reste ouvert', () => {
    expect(
      deriveProfessionalAdvanceFallback({
        customerType: 'b2c',
        depositPct: 30,
        hasSituationSibling: false,
      }).offered,
    ).toBe(false);
  });

  it('sans acompte au devis, l’artisan n’a rien « cherché » : pas d’option numérotée', () => {
    expect(
      deriveProfessionalAdvanceFallback({
        customerType: 'b2b',
        depositPct: null,
        hasSituationSibling: false,
      }).offered,
    ).toBe(false);
  });

  it('une situation vivante existe déjà : « n°1 » serait un mensonge — option générique seule', () => {
    expect(
      deriveProfessionalAdvanceFallback({
        customerType: 'b2g',
        depositPct: 30,
        hasSituationSibling: true,
      }).offered,
    ).toBe(false);
  });
});

describe('hasLivingSituationSibling — mêmes règles que la base de la feuille situation', () => {
  it('détecte une situation du devis, brouillon compris (il compte au cumul serveur)', () => {
    expect(hasLivingSituationSibling('q1', [sibling('q1', 'situation', 'draft')])).toBe(true);
    expect(hasLivingSituationSibling('q1', [sibling('q1', 'situation', 'issued')])).toBe(true);
  });

  it('ignore les situations annulées, les autres kinds et les autres devis', () => {
    expect(
      hasLivingSituationSibling('q1', [
        sibling('q1', 'situation', 'cancelled'),
        sibling('q1', 'deposit', 'issued'),
        sibling('q1', 'final', 'issued'),
        sibling('q1', 'credit_note', 'issued'),
        sibling('q2', 'situation', 'issued'),
        sibling(null, 'situation', 'issued'),
      ]),
    ).toBe(false);
  });

  it('liste vide : aucune sœur — le repli peut se nommer « n°1 » honnêtement', () => {
    expect(hasLivingSituationSibling('q1', [])).toBe(false);
  });
});

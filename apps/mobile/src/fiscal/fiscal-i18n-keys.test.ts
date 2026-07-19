import { describe, expect, it } from 'vitest';
import { allowedTaxRegimesFor, type LegalForm } from '@bob/core';
import { t, type Personality } from '@bob/i18n';
import { LEGAL_FORM_CHOICES } from './fiscal-edit-plans';
import {
  LEGAL_FORM_CHOICE_DESC_KEY,
  LEGAL_FORM_CHOICE_LABEL_KEY,
  SOCIAL_STATUS_CHOICE_DESC_KEY,
  socialStatusExplanationKey,
  taxRegimeExplanationKey,
} from './fiscal-i18n-keys';

/**
 * VERROU des casts `as I18nKey` de fiscal-i18n-keys.ts : le core ÉMET des clés (contrats stables
 * `fiscal.tax_regime_choice.<forme>.<regime>` et `fiscal.social_status_explanation.*`) que le
 * catalogue @bob/i18n doit porter. `t()` lève (accès sur undefined) si une clé manque — chaque
 * clé émise doit donc résoudre en un texte non vide, pour les 3 personnalités. Sans ce test,
 * les casts seraient des mensonges de typage.
 */

const PERSONALITIES: readonly Personality[] = ['pote', 'pro', 'direct'];
const ALL_LEGAL_FORMS: readonly LegalForm[] = LEGAL_FORM_CHOICES; // les 6 valeurs de l'union

describe('clés émises par le core → catalogue @bob/i18n', () => {
  it('chaque régime proposable (allowedTaxRegimesFor, toutes formes) a son explication pédagogique', () => {
    for (const legalForm of ALL_LEGAL_FORMS) {
      const choices = allowedTaxRegimesFor(legalForm);
      expect(choices.length, `aucun régime proposable pour ${legalForm}`).toBeGreaterThan(0);
      for (const choice of choices) {
        for (const personality of PERSONALITIES) {
          const text = t(taxRegimeExplanationKey(choice), { personality });
          expect(text, `${choice.explanationKey} (${personality})`).toBeTruthy();
        }
      }
    }
  });

  it('chaque forme a son explication de statut social (socialStatusExplanation)', () => {
    for (const legalForm of ALL_LEGAL_FORMS) {
      for (const personality of PERSONALITIES) {
        const text = t(socialStatusExplanationKey(legalForm), { personality });
        expect(text, `explication statut social ${legalForm} (${personality})`).toBeTruthy();
      }
    }
  });
});

describe('tables de clés du sélecteur de formes et du choix SARL', () => {
  it('chaque forme du sélecteur a un libellé ET une pédagogie', () => {
    for (const legalForm of LEGAL_FORM_CHOICES) {
      for (const personality of PERSONALITIES) {
        expect(t(LEGAL_FORM_CHOICE_LABEL_KEY[legalForm], { personality })).toBeTruthy();
        expect(t(LEGAL_FORM_CHOICE_DESC_KEY[legalForm], { personality })).toBeTruthy();
      }
    }
  });

  it('le sélecteur de formes couvre les 6 formes, micro en tête (présenté honnêtement comme EI au micro)', () => {
    expect([...LEGAL_FORM_CHOICES].sort()).toEqual((['micro', 'EI', 'EURL', 'SASU', 'SAS', 'SARL'] as const).slice().sort());
    expect(LEGAL_FORM_CHOICES[0]).toBe('micro');
  });

  it('les 2 choix SARL (TNS / assimilé) portent chacun leur description de gérance', () => {
    for (const personality of PERSONALITIES) {
      expect(t(SOCIAL_STATUS_CHOICE_DESC_KEY.tns, { personality })).toBeTruthy();
      expect(t(SOCIAL_STATUS_CHOICE_DESC_KEY.assimile_salarie, { personality })).toBeTruthy();
    }
  });
});

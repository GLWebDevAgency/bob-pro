import { describe, expect, it } from 'vitest';
import {
  FiscalProfile,
  allowedTaxRegimesFor,
  confirmeUtilisateur,
  datumValue,
  hypothese,
  manquant,
  sourceFiable,
  type FiscalDatum,
  type FiscalProfileFieldPatch,
  type FiscalProfileProps,
  type FiscalSocialStatus,
  type FiscalTaxRegime,
  type LegalForm,
} from '@bob/core';
import { requiredSocialStatusFor } from './legal-regime-combos';
import {
  LEGAL_FORM_CHOICES,
  planLegalFormSelection,
  planTaxRegimeSelection,
  type LegalRegimeEditState,
} from './fiscal-edit-plans';

const NOW = '2026-07-15T09:00:00.000Z';

function describeError(e: unknown): string {
  return JSON.stringify(e);
}

interface StartState {
  readonly id: string;
  readonly legalForm: LegalForm;
  readonly taxRegime: FiscalTaxRegime;
  /** Versement libératoire posé sur le profil de départ ('vl_true' n'est possible qu'au micro). */
  readonly vl: 'vl_true' | 'vl_false_fiable' | 'vl_manquant';
}

/** États de départ RÉALISTES : les 7 couples du mini-flow + « EI au régime micro » (atteignable
 * par le sélecteur de régime) + les variantes versement libératoire confirmé `true` (micro),
 * le cas qui EXIGE le solde du VL avant toute sortie du régime micro. */
const START_STATES: readonly StartState[] = [
  { id: 'micro', legalForm: 'micro', taxRegime: 'micro', vl: 'vl_manquant' },
  { id: 'micro+vl', legalForm: 'micro', taxRegime: 'micro', vl: 'vl_true' },
  { id: 'ei_reel', legalForm: 'EI', taxRegime: 'reel_ir', vl: 'vl_false_fiable' },
  { id: 'ei_micro', legalForm: 'EI', taxRegime: 'micro', vl: 'vl_manquant' },
  { id: 'ei_micro+vl', legalForm: 'EI', taxRegime: 'micro', vl: 'vl_true' },
  { id: 'eurl_ir', legalForm: 'EURL', taxRegime: 'reel_ir', vl: 'vl_false_fiable' },
  { id: 'eurl_is', legalForm: 'EURL', taxRegime: 'is', vl: 'vl_false_fiable' },
  { id: 'sasu', legalForm: 'SASU', taxRegime: 'is', vl: 'vl_false_fiable' },
  { id: 'sarl', legalForm: 'SARL', taxRegime: 'is', vl: 'vl_false_fiable' },
  { id: 'sas', legalForm: 'SAS', taxRegime: 'is', vl: 'vl_false_fiable' },
];

function vlDatum(vl: StartState['vl']): FiscalDatum<boolean> {
  if (vl === 'vl_true') return confirmeUtilisateur(true, NOW);
  if (vl === 'vl_false_fiable') return sourceFiable(false, NOW, 'derived_legal_form');
  return manquant();
}

/** Profil domaine-valide pour un état de départ — mêmes constructeurs que la dérivation core,
 * statut social au requis de la forme ('manquant' pour SARL, fidèle au réel). */
function profileFor(start: StartState): FiscalProfile {
  const required = requiredSocialStatusFor(start.legalForm);
  const socialStatus: FiscalDatum<FiscalSocialStatus> = required ? confirmeUtilisateur(required, NOW) : manquant();
  const props: FiscalProfileProps = {
    companyId: 'test-company',
    legalForm: confirmeUtilisateur(start.legalForm, NOW),
    taxRegime: hypothese(start.taxRegime, NOW),
    socialStatus,
    activityNature: manquant(),
    vatRegime: manquant(),
    acre: manquant(),
    versementLiberatoire: vlDatum(start.vl),
    fiscalYearEnd: manquant(),
  };
  const result = FiscalProfile.of(props);
  if (!result.ok) throw new Error(`fixture invalide pour ${start.id} : ${describeError(result.error)}`);
  return result.value;
}

function editStateFor(profile: FiscalProfile): LegalRegimeEditState {
  return {
    legalForm: datumValue(profile.legalForm)!,
    taxRegime: datumValue(profile.taxRegime)!,
    socialStatus: datumValue(profile.socialStatus),
    versementLiberatoire: datumValue(profile.versementLiberatoire),
    legalFormConfirmed: profile.legalForm.status === 'confirme_utilisateur',
    taxRegimeConfirmed: profile.taxRegime.status === 'confirme_utilisateur',
  };
}

/** Applique la séquence contre le VRAI agrégat — chaque patch doit être individuellement accepté
 * (mêmes invariants que le PATCH serveur), sinon échec avec le patch fautif nommé. */
function applyAll(profile: FiscalProfile, patches: readonly FiscalProfileFieldPatch[], label: string): FiscalProfile {
  let current = profile;
  for (const patch of patches) {
    const applied = current.withField(patch, NOW, 'user_form');
    expect(
      applied.ok,
      `${label} : le patch ${patch.field}=${JSON.stringify(patch.value)} a été rejeté (${
        applied.ok ? '' : describeError(applied.error)
      })`,
    ).toBe(true);
    if (applied.ok) current = applied.value;
  }
  return current;
}

describe('planLegalFormSelection — exhaustif contre le VRAI agrégat FiscalProfile', () => {
  for (const start of START_STATES) {
    for (const chosen of LEGAL_FORM_CHOICES) {
      it(`${start.id} → forme ${chosen} : séquence valide, forme atteinte, régime cohérent`, () => {
        const profile = profileFor(start);
        const state = editStateFor(profile);
        const patches = planLegalFormSelection(state, chosen);
        const final = applyAll(profile, patches, `${start.id} → ${chosen}`);

        expect(datumValue(final.legalForm)).toBe(chosen);

        // Régime final : conservé s'il restait valide pour la forme choisie, sinon le défaut
        // légal — dans TOUS les cas un régime autorisé par allowedTaxRegimesFor (le contrat
        // même du sélecteur expert).
        const allowed = allowedTaxRegimesFor(chosen).map((c) => c.regime);
        const finalRegime = datumValue(final.taxRegime);
        expect(allowed, `régime final ${finalRegime} interdit en ${chosen}`).toContain(finalRegime);
        if (allowed.includes(start.taxRegime)) {
          expect(finalRegime).toBe(start.taxRegime);
        }

        // Statut social imposé par la forme cible : atteint.
        const requiredSocial = requiredSocialStatusFor(chosen);
        if (requiredSocial !== null) {
          expect(datumValue(final.socialStatus)).toBe(requiredSocial);
        }

        // Un VL `true` ne survit JAMAIS à une sortie du régime micro (invariant domaine).
        if (finalRegime !== 'micro') {
          expect(datumValue(final.versementLiberatoire)).not.toBe(true);
        }
      });
    }
  }

  it('re-choisir la forme actuelle NON confirmée : un patch de confirmation (même valeur)', () => {
    const profile = profileFor({ id: 'sasu', legalForm: 'SASU', taxRegime: 'is', vl: 'vl_false_fiable' });
    // legalForm confirmé dans la fixture → on repasse par un statut non confirmé.
    const state = { ...editStateFor(profile), legalFormConfirmed: false };
    expect(planLegalFormSelection(state, 'SASU')).toEqual([{ field: 'legalForm', value: 'SASU' }]);
  });

  it('re-choisir la forme actuelle DÉJÀ confirmée : aucun patch (rien à écrire)', () => {
    const profile = profileFor({ id: 'sasu', legalForm: 'SASU', taxRegime: 'is', vl: 'vl_false_fiable' });
    expect(planLegalFormSelection(editStateFor(profile), 'SASU')).toEqual([]);
  });

  it('micro → EI : le régime micro est CONSERVÉ (une EI au régime micro, pas une bascule au réel)', () => {
    const profile = profileFor({ id: 'micro', legalForm: 'micro', taxRegime: 'micro', vl: 'vl_manquant' });
    const patches = planLegalFormSelection(editStateFor(profile), 'EI');
    const final = applyAll(profile, patches, 'micro → EI');
    expect(datumValue(final.legalForm)).toBe('EI');
    expect(datumValue(final.taxRegime)).toBe('micro');
  });

  it('micro (VL confirmé) → SASU : le VL est soldé EN PREMIER, avant toute sortie du micro', () => {
    const profile = profileFor({ id: 'micro+vl', legalForm: 'micro', taxRegime: 'micro', vl: 'vl_true' });
    const patches = planLegalFormSelection(editStateFor(profile), 'SASU');
    expect(patches[0]).toEqual({ field: 'versementLiberatoire', value: false });
    const final = applyAll(profile, patches, 'micro+vl → SASU');
    expect(datumValue(final.legalForm)).toBe('SASU');
    expect(datumValue(final.versementLiberatoire)).toBe(false);
  });
});

describe('planTaxRegimeSelection — chaque régime proposé par le sélecteur expert aboutit', () => {
  for (const start of START_STATES) {
    for (const choice of allowedTaxRegimesFor(start.legalForm)) {
      it(`${start.id} → régime ${choice.regime} : séquence valide, forme INCHANGÉE`, () => {
        const profile = profileFor(start);
        const patches = planTaxRegimeSelection(editStateFor(profile), choice.regime);
        const final = applyAll(profile, patches, `${start.id} → régime ${choice.regime}`);
        expect(datumValue(final.taxRegime)).toBe(choice.regime);
        expect(datumValue(final.legalForm)).toBe(start.legalForm);
        if (choice.regime !== 'micro') {
          expect(datumValue(final.versementLiberatoire)).not.toBe(true);
        }
      });
    }
  }

  it('re-choisir le régime actuel NON confirmé (hypothèse) : un patch de confirmation', () => {
    const profile = profileFor({ id: 'eurl_ir', legalForm: 'EURL', taxRegime: 'reel_ir', vl: 'vl_false_fiable' });
    // Fixture : taxRegime posé en hypothèse → la sélection de la même valeur doit confirmer.
    expect(planTaxRegimeSelection(editStateFor(profile), 'reel_ir')).toEqual([{ field: 'taxRegime', value: 'reel_ir' }]);
  });

  it('re-choisir le régime actuel DÉJÀ confirmé : aucun patch', () => {
    const profile = profileFor({ id: 'eurl_ir', legalForm: 'EURL', taxRegime: 'reel_ir', vl: 'vl_false_fiable' });
    const state = { ...editStateFor(profile), taxRegimeConfirmed: true };
    expect(planTaxRegimeSelection(state, 'reel_ir')).toEqual([]);
  });

  it('EI au micro (VL confirmé) → réel IR : le VL est soldé en premier', () => {
    const profile = profileFor({ id: 'ei_micro+vl', legalForm: 'EI', taxRegime: 'micro', vl: 'vl_true' });
    const patches = planTaxRegimeSelection(editStateFor(profile), 'reel_ir');
    expect(patches[0]).toEqual({ field: 'versementLiberatoire', value: false });
    const final = applyAll(profile, patches, 'ei_micro+vl → reel_ir');
    expect(datumValue(final.taxRegime)).toBe('reel_ir');
    expect(datumValue(final.legalForm)).toBe('EI');
  });
});

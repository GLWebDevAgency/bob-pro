/**
 * FiscalFieldEditSheet — édition d'UN champ déjà connu depuis l'écran « Mon profil fiscal »
 * (SPEC_EXPERT_FISCAL.md §UX FLOW amendement 5 : « tap → même bottom sheet de confirmation/
 * édition que le mini-flow — réutilise les composants »). RÉUTILISE telles quelles les étapes du
 * mini-flow (FiscalFlowSheet.tsx) pour activité/ACRE/VL/TVA — seules la file d'attente et le
 * message « Plus tard → Bob reste prudent » n'ont pas de sens ici (la donnée est DÉJÀ connue, on
 * la corrige, on ne la découvre pas) : `onLater`/`onClose` referment directement, `remainingCount`
 * reste à 0 (ProgressLine masquée par les étapes réutilisées).
 *
 * FORME et RÉGIME ont chacun leur modale EXPERTE (fini le sélecteur unique ambigu de couples) :
 * · « Forme juridique » → sélecteur de FORMES (LEGAL_FORM_CHOICES — « Micro-entrepreneur »
 *   choisissable mais honnêtement décrit comme une EI au régime micro) ;
 * · « Régime fiscal » → sélecteur des seuls régimes juridiquement VALIDES pour la forme actuelle
 *   (allowedTaxRegimesFor @bob/core) avec la pédagogie de chaque option.
 * Une sélection qui invalide d'autres champs déclenche la séquence de patches EXISTANTE
 * (planLegalRegimeCorrection via fiscal-edit-plans.ts — le backend n'écrit qu'UN champ à la fois).
 */
import { useState } from 'react';
import { Alert, Text } from 'react-native';
import { Button, QuestionSheet, Sheet, font, useTheme, type QuestionSheetOption } from '@bob/ui';
import { t, type Personality } from '@bob/i18n';
import {
  allowedTaxRegimesFor,
  datumValue,
  type FiscalProfileFieldPatch,
  type FiscalProfileView,
  type FiscalSocialStatus,
  type FiscalTaxRegime,
  type FiscalYearEnd,
  type LegalForm,
} from '@bob/core';
import { ActivityStep, AcreStep, VatStep, VersementLiberatoireStep } from './FiscalFlowSheet';
import { requiredSocialStatusFor } from '../../fiscal/legal-regime-combos';
import {
  LEGAL_FORM_CHOICES,
  planLegalFormSelection,
  planTaxRegimeSelection,
  type LegalRegimeEditState,
} from '../../fiscal/fiscal-edit-plans';
import { legalFormLabel, microCeilingParams } from '../../fiscal/fiscal-value-labels';
import {
  LEGAL_FORM_CHOICE_DESC_KEY,
  LEGAL_FORM_CHOICE_LABEL_KEY,
  SOCIAL_STATUS_CHOICE_DESC_KEY,
  SOCIAL_STATUS_LABEL_KEY,
  TAX_REGIME_LABEL_KEY,
  socialStatusExplanationKey,
  taxRegimeExplanationKey,
  type FiscalProfileFieldName,
} from '../../fiscal/fiscal-i18n-keys';

/** Les 8 champs FISCAL_PROFILE_FIELDS sont tous éditables depuis cet écran. */
export type FiscalEditableField = FiscalProfileFieldName;

export interface FiscalFieldEditSheetProps {
  readonly field: FiscalEditableField | null;
  readonly profile: FiscalProfileView;
  readonly personality: Personality;
  readonly confirmField: (patch: FiscalProfileFieldPatch) => Promise<void>;
  readonly confirmPatches: (patches: readonly FiscalProfileFieldPatch[]) => Promise<void>;
  readonly onClose: () => void;
}

const YEAR_END_PRESETS: readonly FiscalYearEnd[] = [
  { month: 12, day: 31 },
  { month: 3, day: 31 },
  { month: 6, day: 30 },
  { month: 9, day: 30 },
];

/** État courant (valeurs + confirmations) pour les plans d'édition forme/régime — `null` si la
 * forme ou le régime est 'manquant' (théorique : la dérivation les pose toujours). */
function editStateOf(profile: FiscalProfileView): LegalRegimeEditState | null {
  const legalForm = datumValue(profile.legalForm);
  const taxRegime = datumValue(profile.taxRegime);
  if (legalForm === undefined || taxRegime === undefined) return null;
  return {
    legalForm,
    taxRegime,
    socialStatus: datumValue(profile.socialStatus),
    versementLiberatoire: datumValue(profile.versementLiberatoire),
    legalFormConfirmed: profile.legalForm.status === 'confirme_utilisateur',
    taxRegimeConfirmed: profile.taxRegime.status === 'confirme_utilisateur',
  };
}

/** Modale « Forme juridique » : un sélecteur de FORMES, chaque option avec sa pédagogie.
 * `confirmSingle` OBLIGATOIRE ici : une sélection peut déclencher une cascade destructrice
 * multi-patch (pivot SARL, sortie de micro…) — jamais au tap sec, toujours après le bouton
 * de confirmation. `busy` gèle la feuille pendant la séquence en vol. */
function LegalFormEditSheet({
  state,
  personality,
  busy,
  onPlan,
  onClose,
}: {
  readonly state: LegalRegimeEditState;
  readonly personality: Personality;
  readonly busy: boolean;
  readonly onPlan: (patches: readonly FiscalProfileFieldPatch[]) => void;
  readonly onClose: () => void;
}) {
  const options: QuestionSheetOption[] = LEGAL_FORM_CHOICES.map((form) => ({
    value: form,
    label: t(LEGAL_FORM_CHOICE_LABEL_KEY[form], { personality }),
    description: t(LEGAL_FORM_CHOICE_DESC_KEY[form], { personality }),
  }));
  return (
    <QuestionSheet
      visible
      confirmSingle
      busy={busy}
      header={t('fiscal.field.legalForm', { personality })}
      question={t('fiscal.edit.legalForm.question', { personality })}
      options={options}
      confirmLabel={t('fiscal.step.legalRegime.yes', { personality })}
      otherLabel={t('fiscal.flow.close', { personality })}
      onClose={onClose}
      onOther={onClose}
      onSelect={([value]) => onPlan(planLegalFormSelection(state, value as LegalForm))}
    />
  );
}

/** Modale « Régime fiscal » : seulement les régimes VALIDES pour la forme actuelle, chacun
 * expliqué (clé pédagogique émise par le core — allowedTaxRegimesFor). Les seuils micro des
 * explications ({ventes}/{services}) viennent du référentiel temporel à la date du JOUR
 * (microCeilingParams) — jamais un montant figé dans le catalogue. `confirmSingle` + `busy` :
 * mêmes raisons que la modale « Forme juridique » (cascade multi-patch possible). */
function TaxRegimeEditSheet({
  state,
  personality,
  busy,
  onPlan,
  onClose,
}: {
  readonly state: LegalRegimeEditState;
  readonly personality: Personality;
  readonly busy: boolean;
  readonly onPlan: (patches: readonly FiscalProfileFieldPatch[]) => void;
  readonly onClose: () => void;
}) {
  const ceilings = microCeilingParams(new Date().toISOString().slice(0, 10));
  const options: QuestionSheetOption[] = allowedTaxRegimesFor(state.legalForm).map((choice) => ({
    value: choice.regime,
    label: t(TAX_REGIME_LABEL_KEY[choice.regime], { personality }),
    // Les params sont ignorés par les templates sans placeholder : passage uniforme sans risque.
    description: t(taxRegimeExplanationKey(choice), { personality, params: ceilings }),
  }));
  return (
    <QuestionSheet
      visible
      confirmSingle
      busy={busy}
      header={t('fiscal.field.taxRegime', { personality })}
      question={t('fiscal.edit.taxRegime.question', {
        personality,
        params: { label: legalFormLabel(state.legalForm, personality) },
      })}
      options={options}
      confirmLabel={t('fiscal.step.legalRegime.yes', { personality })}
      otherLabel={t('fiscal.flow.close', { personality })}
      onClose={onClose}
      onOther={onClose}
      onSelect={([value]) => onPlan(planTaxRegimeSelection(state, value as FiscalTaxRegime))}
    />
  );
}

/** Statut social : découle ENTIÈREMENT de la forme juridique sauf SARL (ambigu, art. domaine).
 * Hors SARL la sheet est en lecture seule mais EXPLIQUE le pourquoi (socialStatusExplanation
 * @bob/core : « c'est la loi », article cité) — jamais un verrou muet. La SARL garde son vrai
 * choix TNS/assimilé, chaque option décrivant la gérance qui y mène. */
function SocialStatusEditSheet({
  profile,
  personality,
  onConfirm,
  onClose,
}: {
  readonly profile: FiscalProfileView;
  readonly personality: Personality;
  readonly onConfirm: (value: FiscalSocialStatus) => void;
  readonly onClose: () => void;
}) {
  const { colors } = useTheme();
  const legalForm = datumValue(profile.legalForm);
  const derived = legalForm ? requiredSocialStatusFor(legalForm) : null;

  if (derived !== null && legalForm !== undefined) {
    return (
      <Sheet visible onClose={onClose} accessibilityLabel={t('fiscal.field.socialStatus', { personality })}>
        <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900, marginBottom: 6 }]}>
          {t('fiscal.field.socialStatus', { personality })}
        </Text>
        <Text style={[font('body'), { fontSize: 15, color: colors.ink900, marginBottom: 10 }]}>
          {t(SOCIAL_STATUS_LABEL_KEY[derived], { personality })}
        </Text>
        <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginBottom: 16 }]}>
          {t(socialStatusExplanationKey(legalForm), { personality })}
        </Text>
        <Button title={t('fiscal.flow.close', { personality })} variant="secondary" onPress={onClose} />
      </Sheet>
    );
  }

  const options: QuestionSheetOption[] = (['tns', 'assimile_salarie'] as const satisfies readonly FiscalSocialStatus[]).map(
    (status) => ({
      value: status,
      label: t(SOCIAL_STATUS_LABEL_KEY[status], { personality }),
      description: t(SOCIAL_STATUS_CHOICE_DESC_KEY[status], { personality }),
    }),
  );
  return (
    <QuestionSheet
      visible
      header={t('fiscal.field.socialStatus', { personality })}
      // SARL : la question EST l'explication (gérance majoritaire = TNS, minoritaire = assimilé).
      question={t(legalForm ? socialStatusExplanationKey(legalForm) : 'fiscal.field.socialStatus', { personality })}
      options={options}
      confirmLabel={t('fiscal.step.legalRegime.yes', { personality })}
      otherLabel={t('fiscal.flow.close', { personality })}
      onClose={onClose}
      onOther={onClose}
      onSelect={([value]) => onConfirm(value as FiscalSocialStatus)}
    />
  );
}

function FiscalYearEndEditSheet({
  personality,
  onConfirm,
  onClose,
}: {
  readonly personality: Personality;
  readonly onConfirm: (value: FiscalYearEnd) => void;
  readonly onClose: () => void;
}) {
  const options: QuestionSheetOption[] = YEAR_END_PRESETS.map((preset) => ({
    value: `${preset.month}-${preset.day}`,
    label:
      preset.month === 12
        ? t('fiscal.yearEnd.civil', { personality })
        : `${preset.day}/${String(preset.month).padStart(2, '0')}`,
  }));
  return (
    <QuestionSheet
      visible
      header={t('fiscal.field.fiscalYearEnd', { personality })}
      question={t('fiscal.field.fiscalYearEnd', { personality })}
      options={options}
      confirmLabel={t('fiscal.step.legalRegime.yes', { personality })}
      otherLabel={t('fiscal.flow.close', { personality })}
      onClose={onClose}
      onOther={onClose}
      onSelect={([value]) => {
        const preset = YEAR_END_PRESETS.find((p) => `${p.month}-${p.day}` === value);
        if (preset) onConfirm(preset);
      }}
    />
  );
}

export function FiscalFieldEditSheet({
  field,
  profile,
  personality,
  confirmField,
  confirmPatches,
  onClose,
}: FiscalFieldEditSheetProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (field === null) return null;

  const withField = (patch: FiscalProfileFieldPatch): void => {
    setBusy(true);
    setError(null);
    confirmField(patch)
      .then(onClose)
      .catch(() => setError(t('fiscal.mutation.error', { personality })))
      .finally(() => setBusy(false));
  };
  /** Chemins sans zone d'erreur inline dédiée (QuestionSheet ne prend pas d'enfant) — une
   * alerte honnête plutôt qu'un échec silencieux (jamais un état « ça a marché » supposé).
   * Garde de réentrance `busy` : pendant la mutation en vol, tout nouveau départ est ignoré
   * (un second plan calculé sur un état périmé s'entrelacerait avec le premier). */
  const withFieldAlerting = (patch: FiscalProfileFieldPatch): void => {
    if (busy) return;
    setBusy(true);
    confirmField(patch)
      .then(onClose)
      .catch(() => Alert.alert('Oups', t('fiscal.mutation.error', { personality })))
      .finally(() => setBusy(false));
  };
  /** Idem pour une SÉQUENCE de patches (plans forme/régime) — une séquence vide signifie
   * « rien à écrire » (valeur déjà confirmée reconduite) : fermeture simple. */
  const withPatchesAlerting = (patches: readonly FiscalProfileFieldPatch[]): void => {
    if (busy) return;
    if (patches.length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    confirmPatches(patches)
      .then(onClose)
      .catch(() => Alert.alert('Oups', t('fiscal.mutation.error', { personality })))
      .finally(() => setBusy(false));
  };
  const onRetry = (): void => undefined; // rejoué au prochain tap — pas de patch en mémoire ici.

  const common = { profile, personality, remainingCount: 0, busy, error, onRetry, onLater: onClose };
  const state = editStateOf(profile);

  switch (field) {
    case 'legalForm':
      // Théorique : forme/régime 'manquant' (la dérivation les pose toujours) — aucun sélecteur
      // cohérent possible sans état courant : ne rien afficher (pas d'effet de bord au rendu).
      if (state === null) return null;
      return (
        <LegalFormEditSheet state={state} personality={personality} busy={busy} onClose={onClose} onPlan={withPatchesAlerting} />
      );
    case 'taxRegime':
      if (state === null) return null;
      return (
        <TaxRegimeEditSheet state={state} personality={personality} busy={busy} onClose={onClose} onPlan={withPatchesAlerting} />
      );
    case 'activityNature':
      return <ActivityStep {...common} onConfirm={(value) => withField({ field: 'activityNature', value })} />;
    case 'acre':
      return <AcreStep {...common} onConfirm={(value) => withField({ field: 'acre', value })} />;
    case 'versementLiberatoire':
      return <VersementLiberatoireStep {...common} onConfirm={(value) => withField({ field: 'versementLiberatoire', value })} />;
    case 'vatRegime':
      return <VatStep {...common} onConfirm={(value) => withField({ field: 'vatRegime', value })} />;
    case 'socialStatus':
      return (
        <SocialStatusEditSheet
          profile={profile}
          personality={personality}
          onClose={onClose}
          onConfirm={(value) => withFieldAlerting({ field: 'socialStatus', value })}
        />
      );
    case 'fiscalYearEnd':
      return (
        <FiscalYearEndEditSheet
          personality={personality}
          onClose={onClose}
          onConfirm={(value) => withFieldAlerting({ field: 'fiscalYearEnd', value })}
        />
      );
  }
}

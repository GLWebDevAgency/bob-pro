/**
 * FiscalFieldEditSheet — édition d'UN champ déjà connu depuis l'écran « Mon profil fiscal »
 * (SPEC_EXPERT_FISCAL.md §UX FLOW amendement 5 : « tap → même bottom sheet de confirmation/
 * édition que le mini-flow — réutilise les composants »). RÉUTILISE telles quelles les étapes du
 * mini-flow (FiscalFlowSheet.tsx) — seules la file d'attente et le message « Plus tard → Bob
 * reste prudent » n'ont pas de sens ici (la donnée est DÉJÀ connue, on la corrige, on ne la
 * découvre pas) : `onLater`/`onClose` referment directement, `remainingCount` reste à 0
 * (ProgressLine masquée par les étapes réutilisées).
 */
import { useState } from 'react';
import { Alert, Text } from 'react-native';
import { Button, QuestionSheet, Sheet, font, useTheme, type QuestionSheetOption } from '@bob/ui';
import { t, type Personality } from '@bob/i18n';
import {
  datumValue,
  type FiscalProfileFieldPatch,
  type FiscalProfileView,
  type FiscalSocialStatus,
  type FiscalYearEnd,
} from '@bob/core';
import { ActivityStep, AcreStep, LegalRegimeStep, VatStep, VersementLiberatoireStep } from './FiscalFlowSheet';
import { requiredSocialStatusFor } from '../../fiscal/legal-regime-combos';
import { SOCIAL_STATUS_LABEL_KEY, type FiscalProfileFieldName } from '../../fiscal/fiscal-i18n-keys';

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

/** Statut social : découle ENTIÈREMENT de la forme juridique sauf SARL (ambigu, art. domaine) —
 * seule la SARL propose un vrai choix ici ; les autres formes redirigent vers « Forme & régime ». */
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

  if (derived !== null) {
    return (
      <Sheet visible onClose={onClose} accessibilityLabel={t('fiscal.field.socialStatus', { personality })}>
        <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900, marginBottom: 10 }]}>
          {t('fiscal.field.socialStatus', { personality })}
        </Text>
        <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginBottom: 16 }]}>
          {t(SOCIAL_STATUS_LABEL_KEY[derived], { personality })}
        </Text>
        <Button title={t('fiscal.flow.close', { personality })} variant="secondary" onPress={onClose} />
      </Sheet>
    );
  }

  const options: QuestionSheetOption[] = (['tns', 'assimile_salarie'] as const satisfies readonly FiscalSocialStatus[]).map(
    (status) => ({ value: status, label: t(SOCIAL_STATUS_LABEL_KEY[status], { personality }) }),
  );
  return (
    <QuestionSheet
      visible
      header={t('fiscal.field.socialStatus', { personality })}
      question={t('fiscal.field.socialStatus', { personality })}
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
   * alerte honnête plutôt qu'un échec silencieux (jamais un état « ça a marché » supposé). */
  const withFieldAlerting = (patch: FiscalProfileFieldPatch): void => {
    confirmField(patch)
      .then(onClose)
      .catch(() => Alert.alert('Oups', t('fiscal.mutation.error', { personality })));
  };
  const onRetry = (): void => undefined; // rejoué au prochain tap — pas de patch en mémoire ici.

  const common = { profile, personality, remainingCount: 0, busy, error, onRetry, onLater: onClose };

  switch (field) {
    case 'legalForm':
    case 'taxRegime':
      return (
        <LegalRegimeStep
          {...common}
          initialPhase="correct"
          onConfirmSame={onClose}
          onCorrect={(patches) => {
            if (patches.length === 0) {
              onClose();
              return;
            }
            setBusy(true);
            setError(null);
            confirmPatches(patches)
              .then(onClose)
              .catch(() => setError(t('fiscal.mutation.error', { personality })))
              .finally(() => setBusy(false));
          }}
        />
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

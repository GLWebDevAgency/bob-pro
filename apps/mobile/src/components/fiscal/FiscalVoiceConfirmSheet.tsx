/**
 * FiscalVoiceConfirmSheet — parité vocale stricte (SPEC_EXPERT_FISCAL.md amendement 7 : « la voix
 * ne mute JAMAIS directement : proposition opaque + diff + confirmation »). Ouverte par
 * useFiscalProfileFlow quand une affordance vocale (fiscal-voice.ts) reconnaît un énoncé — le
 * diff AVANT → APRÈS est TOUJOURS visible (ActionDiffView, même composant que la confirmation
 * d'action de l'assistant) et la mutation ne part QUE sur tap (« en cas de doute : tap »).
 */
import { useState } from 'react';
import { Text, View } from 'react-native';
import type { ActionDiff } from '@bob/ai';
import { Button, ErrorRetry, Sheet, font, useTheme } from '@bob/ui';
import { t, type Personality } from '@bob/i18n';
import { datumValue, type FiscalProfileFieldPatch, type FiscalProfileView } from '@bob/core';
import { ActionDiffView } from '../ActionDiffView';
import type { FiscalVoiceProposal } from '../../fiscal/fiscal-voice';
import { planLegalRegimeCorrection } from '../../fiscal/legal-regime-correction';
import { FIELD_NAME_KEY, LEGAL_REGIME_COMBO_LABEL_KEY } from '../../fiscal/fiscal-i18n-keys';
import { acreLabel, boolLabel, legalFormLabel, taxRegimeLabel } from '../../fiscal/fiscal-value-labels';

function fieldBeforeLabel(patch: FiscalProfileFieldPatch, profile: FiscalProfileView, personality: Personality): string {
  const dash = t('fiscal.source.missingHint', { personality });
  if (patch.field === 'acre') {
    const value = datumValue(profile.acre);
    return value ? acreLabel(value, personality) : dash;
  }
  if (patch.field === 'versementLiberatoire') {
    const value = datumValue(profile.versementLiberatoire);
    return value === undefined ? dash : boolLabel(value, personality);
  }
  return dash;
}

function fieldAfterLabel(patch: FiscalProfileFieldPatch, personality: Personality): string {
  if (patch.field === 'acre') return acreLabel(patch.value, personality);
  if (patch.field === 'versementLiberatoire') return boolLabel(patch.value, personality);
  return String(patch.value);
}

function buildDiff(proposal: FiscalVoiceProposal, profile: FiscalProfileView, personality: Personality): ActionDiff {
  if (proposal.kind === 'legal_regime') {
    const currentLegalForm = datumValue(profile.legalForm);
    const currentTaxRegime = datumValue(profile.taxRegime);
    const dash = t('fiscal.source.missingHint', { personality });
    return {
      tool: 'fiscal.voiceProposal',
      title: t(LEGAL_REGIME_COMBO_LABEL_KEY[proposal.combo.id]!, { personality }),
      fields: [
        {
          label: t(FIELD_NAME_KEY.legalForm, { personality }),
          before: currentLegalForm ? legalFormLabel(currentLegalForm, personality) : dash,
          after: legalFormLabel(proposal.combo.legalForm, personality),
        },
        {
          label: t(FIELD_NAME_KEY.taxRegime, { personality }),
          before: currentTaxRegime ? taxRegimeLabel(currentTaxRegime, personality) : dash,
          after: taxRegimeLabel(proposal.combo.taxRegime, personality),
        },
      ],
    };
  }
  return {
    tool: 'fiscal.voiceProposal',
    title: t(FIELD_NAME_KEY[proposal.patch.field], { personality }),
    fields: [
      {
        label: t(FIELD_NAME_KEY[proposal.patch.field], { personality }),
        before: fieldBeforeLabel(proposal.patch, profile, personality),
        after: fieldAfterLabel(proposal.patch, personality),
      },
    ],
  };
}

export interface FiscalVoiceConfirmSheetProps {
  readonly proposal: FiscalVoiceProposal;
  readonly profile: FiscalProfileView;
  readonly personality: Personality;
  readonly confirmField: (patch: FiscalProfileFieldPatch) => Promise<void>;
  readonly confirmPatches: (patches: readonly FiscalProfileFieldPatch[]) => Promise<void>;
  readonly onClose: () => void;
}

export function FiscalVoiceConfirmSheet({
  proposal,
  profile,
  personality,
  confirmField,
  confirmPatches,
  onClose,
}: FiscalVoiceConfirmSheetProps) {
  const { colors, controls, radius } = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const diff = buildDiff(proposal, profile, personality);

  const onConfirm = (): void => {
    setBusy(true);
    setError(null);
    const run =
      proposal.kind === 'legal_regime'
        ? (() => {
            const legalForm = datumValue(profile.legalForm);
            const taxRegime = datumValue(profile.taxRegime);
            if (legalForm === undefined || taxRegime === undefined) return Promise.resolve();
            const patches = planLegalRegimeCorrection(
              { legalForm, taxRegime, socialStatus: datumValue(profile.socialStatus) },
              proposal.combo,
            );
            return confirmPatches(patches);
          })()
        : confirmField(proposal.patch);
    run
      .then(onClose)
      .catch(() => setError(t('fiscal.mutation.error', { personality })))
      .finally(() => setBusy(false));
  };

  return (
    <Sheet visible onClose={onClose} accessibilityLabel={`${t('fiscal.voice.proposalTitle', { personality })}. ${diff.title}`}>
      <View
        style={{
          alignSelf: 'flex-start',
          backgroundColor: controls.segmentedTrack,
          borderRadius: radius.pill,
          paddingHorizontal: 10,
          paddingVertical: 4,
          marginBottom: 8,
        }}
      >
        <Text style={[font('meta', 700), { color: colors.slate500, letterSpacing: 0.4, textTransform: 'uppercase' }]}>
          {t('fiscal.voice.proposalTitle', { personality })}
        </Text>
      </View>
      <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900 }]}>
        {diff.title}
      </Text>
      <ActionDiffView diff={diff} />
      {error ? (
        <View style={{ marginTop: 12 }}>
          <ErrorRetry message={error} onRetry={onConfirm} />
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
        <View style={{ flex: 1 }}>
          <Button title={t('fiscal.voice.proposalCancel', { personality })} variant="secondary" disabled={busy} onPress={onClose} />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            title={t('fiscal.voice.proposalConfirm', { personality })}
            variant="primary"
            disabled={busy}
            loading={busy}
            onPress={onConfirm}
          />
        </View>
      </View>
    </Sheet>
  );
}

/**
 * FiscalFlowSheet — le mini-flow du profil fiscal (SPEC_EXPERT_FISCAL.md §UX FLOW, amendements
 * GPT 1-10). Une SUITE de bottom sheets, une décision par écran (amendement 4) : l'ORDRE est
 * recalculé à CHAQUE rendu depuis le profil réel (computeFiscalFlowSteps, amendement 3) — jamais
 * une séquence figée. Chaque étape est un Sheet DISTINCT (clé unique → réouverture, focus
 * VoiceOver neuf sur la question, animation d'entrée neuve — reduce-motion : instantanée).
 * « Plus tard » ferme SANS RIEN écrire et ANNONCE la conséquence (amendement 4) ; une confirmation
 * réussie avance silencieusement à l'étape suivante (le profil rafraîchi fait apparaître/disparaître
 * les étapes suivantes de lui-même). Réutilisée telle quelle par la voix (proposition pré-remplie,
 * amendement 7) via FiscalVoiceConfirmSheet — CE composant reste le canal manuel « plusieurs
 * décisions à la suite » ; le canal vocal ouvre une confirmation UNIQUE (voir ce fichier voisin).
 */
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import {
  Button,
  ErrorRetry,
  Sheet,
  QuestionSheet,
  font,
  useTheme,
  type QuestionSheetOption,
} from '@bob/ui';
import { t, type Personality } from '@bob/i18n';
import {
  datumValue,
  type AcreInfo,
  type FiscalActivityNature,
  type FiscalProfileFieldPatch,
  type FiscalProfileView,
  type FiscalVatRegime,
} from '@bob/core';
import { computeFiscalFlowSteps, type FiscalFlowStepId } from '../../fiscal/fiscal-flow-steps';
import { findLegalRegimeCombo, LEGAL_REGIME_COMBOS } from '../../fiscal/legal-regime-combos';
import { planLegalRegimeCorrection } from '../../fiscal/legal-regime-correction';
import {
  ACTIVITY_DESC_KEY,
  ACTIVITY_LABEL_KEY,
  LEGAL_REGIME_COMBO_DESC_KEY,
  LEGAL_REGIME_COMBO_LABEL_KEY,
  VAT_REGIME_DESC_KEY,
  VAT_REGIME_LABEL_KEY,
} from '../../fiscal/fiscal-i18n-keys';
import { monthYearToDateOnly } from '../../fiscal/fiscal-dates';
import { MonthYearStepper } from './MonthYearStepper';

export interface FiscalFlowSheetProps {
  readonly visible: boolean;
  readonly profile: FiscalProfileView;
  readonly personality: Personality;
  /** Applique UN champ (mini-flow standard). Rejette (throw) si le serveur refuse. */
  readonly confirmField: (patch: FiscalProfileFieldPatch) => Promise<void>;
  /** Applique une SÉQUENCE de champs (correction forme+régime — legal-regime-correction.ts). */
  readonly confirmPatches: (patches: readonly FiscalProfileFieldPatch[]) => Promise<void>;
  /** « Plus tard » — ferme SANS écrire. */
  readonly onLater: () => void;
  /** Toutes les étapes en attente sont épuisées (ou l'utilisateur ferme après le message final). */
  readonly onDone: () => void;
}

/** Chip d'en-tête + question, dans un Sheet — le même socle visuel pour toutes les étapes
 * « oui/non » custom (legal_regime, acre, versement libératoire). */
export function StepHeader({ header, question }: { readonly header: string; readonly question: string }) {
  const { colors, controls, radius } = useTheme();
  return (
    <>
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
          {header}
        </Text>
      </View>
      <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900, marginBottom: 12, lineHeight: 22 }]}>
        {question}
      </Text>
    </>
  );
}

export function ProgressLine({ remainingCount, personality }: { readonly remainingCount: number; readonly personality: Personality }) {
  const { colors } = useTheme();
  if (remainingCount <= 0) return null;
  return (
    <View accessibilityLiveRegion="polite" style={{ marginBottom: 10 }}>
      <Text style={[font('meta'), { color: colors.slate400 }]}>
        {t(remainingCount === 1 ? 'fiscal.flow.progressOne' : 'fiscal.flow.progress', {
          personality,
          params: { count: remainingCount },
        })}
      </Text>
    </View>
  );
}

export function LaterLink({ onLater, personality }: { readonly onLater: () => void; readonly personality: Personality }) {
  const { colors } = useTheme();
  return (
    <Text
      accessibilityRole="button"
      accessibilityLabel={t('fiscal.flow.later', { personality })}
      accessibilityHint={t('fiscal.flow.laterAccessibilityHint', { personality })}
      onPress={onLater}
      style={[font('sub', 600), { color: colors.slate500, textAlign: 'center', marginTop: 14, minHeight: 44, textAlignVertical: 'center' }]}
    >
      {t('fiscal.flow.later', { personality })}
    </Text>
  );
}

export interface StepBodyProps {
  readonly profile: FiscalProfileView;
  readonly personality: Personality;
  readonly remainingCount: number;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly onLater: () => void;
}

// ── Étape « couple forme + régime » (amendement 3, en premier) ────────────────

export function LegalRegimeStep(
  props: StepBodyProps & {
    readonly onConfirmSame: () => void;
    readonly onCorrect: (patches: readonly FiscalProfileFieldPatch[]) => void;
  },
) {
  const { profile, personality, remainingCount, busy, error, onRetry, onLater, onConfirmSame, onCorrect } = props;
  const [phase, setPhase] = useState<'confirm' | 'correct'>('confirm');
  const legalForm = datumValue(profile.legalForm);
  const taxRegime = datumValue(profile.taxRegime);
  const currentCombo = findLegalRegimeCombo(legalForm, taxRegime);
  const hypothesisLabel = currentCombo
    ? t(LEGAL_REGIME_COMBO_LABEL_KEY[currentCombo.id]!, { personality })
    : t('fiscal.legalForm.EI', { personality }); // secours théorique (legalForm toujours connu en pratique)

  if (phase === 'confirm') {
    return (
      <Sheet
        key="legal_regime-confirm"
        visible
        onClose={onLater}
        accessibilityLabel={`${t('fiscal.step.legalRegime.header', { personality })}. ${t(
          'fiscal.step.legalRegime.hypothesisQuestion',
          { personality, params: { label: hypothesisLabel } },
        )}`}
      >
        <StepHeader
          header={t('fiscal.step.legalRegime.header', { personality })}
          question={t('fiscal.step.legalRegime.hypothesisQuestion', { personality, params: { label: hypothesisLabel } })}
        />
        <ProgressLine remainingCount={remainingCount} personality={personality} />
        {error ? <ErrorRetry message={error} onRetry={onRetry} /> : null}
        <View style={{ gap: 10 }}>
          <Button
            title={t('fiscal.step.legalRegime.yes', { personality })}
            variant="primary"
            disabled={busy}
            loading={busy}
            onPress={onConfirmSame}
          />
          <Button
            title={t('fiscal.step.legalRegime.no', { personality })}
            variant="secondary"
            disabled={busy}
            onPress={() => setPhase('correct')}
          />
        </View>
        <LaterLink onLater={onLater} personality={personality} />
      </Sheet>
    );
  }

  const options: QuestionSheetOption[] = LEGAL_REGIME_COMBOS.map((combo) => ({
    value: combo.id,
    label: t(LEGAL_REGIME_COMBO_LABEL_KEY[combo.id]!, { personality }),
    description: t(LEGAL_REGIME_COMBO_DESC_KEY[combo.id]!, { personality }),
  }));

  return (
    <QuestionSheet
      key="legal_regime-correct"
      visible
      header={t('fiscal.step.legalRegime.correctionHeader', { personality })}
      question={t('fiscal.step.legalRegime.correctionQuestion', { personality })}
      options={options}
      confirmLabel={t('fiscal.step.legalRegime.yes', { personality })}
      otherLabel={t('fiscal.flow.later', { personality })}
      onClose={onLater}
      onOther={onLater}
      onSelect={([id]) => {
        const target = LEGAL_REGIME_COMBOS.find((c) => c.id === id);
        if (!target || legalForm === undefined || taxRegime === undefined) return;
        const patches = planLegalRegimeCorrection(
          {
            legalForm,
            taxRegime,
            socialStatus: datumValue(profile.socialStatus),
            // Requis pour SOLDER un VL confirmé avant de quitter le régime micro (invariant
            // versement_liberatoire_requires_micro) — sinon la séquence serait rejetée.
            versementLiberatoire: datumValue(profile.versementLiberatoire),
          },
          target,
        );
        onCorrect(patches);
      }}
    />
  );
}

// ── Étape « activité » ──────────────────────────────────────────────────────

export function ActivityStep(props: StepBodyProps & { readonly onConfirm: (value: FiscalActivityNature) => void }) {
  const { personality, onLater, onConfirm } = props;
  const options: QuestionSheetOption[] = (
    ['bic_vente', 'bic_service', 'bnc', 'bnc_cipav', 'mixte'] as const satisfies readonly FiscalActivityNature[]
  ).map((nature) => ({
    value: nature,
    label: t(ACTIVITY_LABEL_KEY[nature], { personality }),
    description: t(ACTIVITY_DESC_KEY[nature], { personality }),
  }));
  return (
    <QuestionSheet
      key="activity"
      visible
      header={t('fiscal.step.activity.header', { personality })}
      question={t('fiscal.step.activity.question', { personality })}
      options={options}
      confirmLabel={t('fiscal.step.legalRegime.yes', { personality })}
      otherLabel={t('fiscal.flow.later', { personality })}
      onClose={onLater}
      onOther={onLater}
      onSelect={([value]) => onConfirm(value as FiscalActivityNature)}
    />
  );
}

// ── Étape « ACRE » (avec date de début si accordée) ─────────────────────────

export function AcreStep(props: StepBodyProps & { readonly onConfirm: (value: AcreInfo) => void }) {
  const { personality, remainingCount, busy, error, onRetry, onLater, onConfirm } = props;
  const { colors } = useTheme();
  const [phase, setPhase] = useState<'ask' | 'date'>('ask');
  const now = new Date();
  const [monthYear, setMonthYear] = useState({ month: now.getMonth() + 1, year: now.getFullYear() });

  if (phase === 'ask') {
    return (
      <Sheet
        key="acre-ask"
        visible
        onClose={onLater}
        accessibilityLabel={`${t('fiscal.step.acre.header', { personality })}. ${t('fiscal.step.acre.question', { personality })}`}
      >
        <StepHeader header={t('fiscal.step.acre.header', { personality })} question={t('fiscal.step.acre.question', { personality })} />
        <ProgressLine remainingCount={remainingCount} personality={personality} />
        {error ? <ErrorRetry message={error} onRetry={onRetry} /> : null}
        {/* Aide contextuelle (papa vocal) : automatique pour les sociétés éligibles la 1re
            année, SUR DEMANDE pour les micro — l'utilisateur sait quoi répondre. */}
        <Text style={[font('sub'), { color: colors.slate500, marginBottom: 14, lineHeight: 19 }]}>
          {t('fiscal.step.acre.helper', { personality })}
        </Text>
        <View style={{ gap: 10 }}>
          <Button
            title={t('fiscal.step.acre.yes', { personality })}
            variant="primary"
            disabled={busy}
            onPress={() => setPhase('date')}
          />
          <Button
            title={t('fiscal.step.acre.no', { personality })}
            variant="secondary"
            disabled={busy}
            loading={busy}
            onPress={() => onConfirm({ granted: false })}
          />
        </View>
        <LaterLink onLater={onLater} personality={personality} />
      </Sheet>
    );
  }

  return (
    <Sheet
      key="acre-date"
      visible
      onClose={onLater}
      accessibilityLabel={`${t('fiscal.step.acre.header', { personality })}. ${t('fiscal.step.acre.dateQuestion', { personality })}`}
    >
      <StepHeader header={t('fiscal.step.acre.header', { personality })} question={t('fiscal.step.acre.dateQuestion', { personality })} />
      <ProgressLine remainingCount={remainingCount} personality={personality} />
      {error ? <ErrorRetry message={error} onRetry={onRetry} /> : null}
      <Text style={[font('sub'), { color: colors.slate500, marginBottom: 14 }]}>
        {t('fiscal.step.acre.dateHint', { personality })}
      </Text>
      <MonthYearStepper
        value={monthYear}
        onChange={setMonthYear}
        accessibilityLabel={t('fiscal.step.acre.dateQuestion', { personality })}
      />
      <View style={{ marginTop: 16 }}>
        <Button
          title={t('fiscal.step.acre.confirmDate', { personality })}
          variant="primary"
          disabled={busy}
          loading={busy}
          onPress={() => onConfirm({ granted: true, startDate: monthYearToDateOnly(monthYear.month, monthYear.year) })}
        />
      </View>
      <LaterLink onLater={onLater} personality={personality} />
    </Sheet>
  );
}

// ── Étape « versement libératoire » (uniquement au régime micro) ────────────

export function VersementLiberatoireStep(props: StepBodyProps & { readonly onConfirm: (value: boolean) => void }) {
  const { personality, remainingCount, busy, error, onRetry, onLater, onConfirm } = props;
  const { colors } = useTheme();
  return (
    <Sheet
      key="vl"
      visible
      onClose={onLater}
      accessibilityLabel={`${t('fiscal.step.vl.header', { personality })}. ${t('fiscal.step.vl.question', { personality })}`}
    >
      <StepHeader header={t('fiscal.step.vl.header', { personality })} question={t('fiscal.step.vl.question', { personality })} />
      <ProgressLine remainingCount={remainingCount} personality={personality} />
      {error ? <ErrorRetry message={error} onRetry={onRetry} /> : null}
      <Text style={[font('sub'), { color: colors.slate500, marginBottom: 14, lineHeight: 19 }]}>
        {t('fiscal.step.vl.helper', { personality })}
      </Text>
      <View style={{ gap: 10 }}>
        <Button title={t('fiscal.step.vl.yes', { personality })} variant="primary" disabled={busy} loading={busy} onPress={() => onConfirm(true)} />
        <Button title={t('fiscal.step.vl.no', { personality })} variant="secondary" disabled={busy} onPress={() => onConfirm(false)} />
      </View>
      <LaterLink onLater={onLater} personality={personality} />
    </Sheet>
  );
}

// ── Étape « TVA » (seulement si totalement inconnue) ────────────────────────

export function VatStep(props: StepBodyProps & { readonly onConfirm: (value: FiscalVatRegime) => void }) {
  const { personality, onLater, onConfirm } = props;
  const options: QuestionSheetOption[] = (
    ['franchise', 'reel_simplifie', 'reel_normal'] as const satisfies readonly FiscalVatRegime[]
  ).map((regime) => ({
    value: regime,
    label: t(VAT_REGIME_LABEL_KEY[regime], { personality }),
    description: t(VAT_REGIME_DESC_KEY[regime], { personality }),
  }));
  return (
    <QuestionSheet
      key="vat"
      visible
      header={t('fiscal.step.vat.header', { personality })}
      question={t('fiscal.step.vat.question', { personality })}
      options={options}
      confirmLabel={t('fiscal.step.legalRegime.yes', { personality })}
      otherLabel={t('fiscal.flow.later', { personality })}
      onClose={onLater}
      onOther={onLater}
      onSelect={([value]) => onConfirm(value as FiscalVatRegime)}
    />
  );
}

// ── Message de fin (toutes les étapes en attente sont épuisées) ─────────────

function DoneStep({ personality, onDone }: { readonly personality: Personality; readonly onDone: () => void }) {
  const { colors } = useTheme();
  return (
    <Sheet key="done" visible onClose={onDone} accessibilityLabel={t('fiscal.flow.done', { personality })}>
      <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900, marginBottom: 10 }]}>
        {t('fiscal.flow.done', { personality })}
      </Text>
      <Button title={t('fiscal.flow.close', { personality })} variant="primary" onPress={onDone} />
    </Sheet>
  );
}

/** « Plus tard » (amendement 4) : ANNONCE la conséquence — jamais un simple silence, jamais une
 * hypothèse confirmée en douce. Fermeture explicite (tap), aucune interaction temporisée. */
function LaterAckStep({ personality, onClose }: { readonly personality: Personality; readonly onClose: () => void }) {
  const { colors } = useTheme();
  return (
    <Sheet
      key="later-ack"
      visible
      onClose={onClose}
      accessibilityLabel={t('fiscal.flow.laterConsequence', { personality })}
    >
      <Text
        accessibilityRole="header"
        accessibilityLiveRegion="polite"
        style={[font('cardTitle'), { color: colors.ink900, marginBottom: 14, lineHeight: 22 }]}
      >
        {t('fiscal.flow.laterConsequence', { personality })}
      </Text>
      <Button title={t('fiscal.flow.close', { personality })} variant="secondary" onPress={onClose} />
    </Sheet>
  );
}

// ── Orchestrateur ─────────────────────────────────────────────────────────────

export function FiscalFlowSheet({
  visible,
  profile,
  personality,
  confirmField,
  confirmPatches,
  onLater,
  onDone,
}: FiscalFlowSheetProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [laterAcked, setLaterAcked] = useState(false);
  const retryRef = useRef<() => void>(() => undefined);

  const steps = computeFiscalFlowSteps(profile);
  const currentStepId: FiscalFlowStepId | null = steps[0] ?? null;

  // Nouvelle étape : l'erreur d'une étape précédente ne doit jamais persister sur la suivante.
  useEffect(() => {
    setError(null);
  }, [currentStepId]);
  // Le flow se réouvre parfois sur la MÊME étape (ex. réouverture depuis Argent) : repartir
  // propre plutôt que de rester bloqué sur l'accusé de réception d'un « Plus tard » précédent.
  useEffect(() => {
    if (visible) setLaterAcked(false);
  }, [visible]);

  if (!visible) return null;
  if (laterAcked) return <LaterAckStep personality={personality} onClose={onLater} />;

  const runField = (patch: FiscalProfileFieldPatch): void => {
    retryRef.current = () => runField(patch);
    setBusy(true);
    setError(null);
    confirmField(patch)
      .catch(() => setError(t('fiscal.mutation.error', { personality })))
      .finally(() => setBusy(false));
  };
  const runPatches = (patches: readonly FiscalProfileFieldPatch[]): void => {
    if (patches.length === 0) return; // rien à écrire (le choix reconduit l'hypothèse existante).
    retryRef.current = () => runPatches(patches);
    setBusy(true);
    setError(null);
    confirmPatches(patches)
      .catch(() => setError(t('fiscal.mutation.error', { personality })))
      .finally(() => setBusy(false));
  };
  const onRetry = (): void => retryRef.current();

  const common: StepBodyProps = {
    profile,
    personality,
    remainingCount: steps.length,
    busy,
    error,
    onRetry,
    onLater: () => setLaterAcked(true),
  };

  if (currentStepId === null) return <DoneStep personality={personality} onDone={onDone} />;

  switch (currentStepId) {
    case 'legal_regime': {
      const legalForm = datumValue(profile.legalForm);
      const taxRegime = datumValue(profile.taxRegime);
      return (
        <LegalRegimeStep
          {...common}
          onConfirmSame={() => {
            // « Oui, c'est ça » ne CHANGE aucune valeur — confirme la même hypothèse (statut →
            // confirme_utilisateur). Ne patch que le(s) champ(s) pas encore confirmé(s).
            const patches: FiscalProfileFieldPatch[] = [];
            if (profile.legalForm.status !== 'confirme_utilisateur' && legalForm !== undefined) {
              patches.push({ field: 'legalForm', value: legalForm });
            }
            if (profile.taxRegime.status !== 'confirme_utilisateur' && taxRegime !== undefined) {
              patches.push({ field: 'taxRegime', value: taxRegime });
            }
            runPatches(patches);
          }}
          onCorrect={(patches) => runPatches(patches)}
        />
      );
    }
    case 'activity':
      return <ActivityStep {...common} onConfirm={(value) => runField({ field: 'activityNature', value })} />;
    case 'acre':
      return <AcreStep {...common} onConfirm={(value) => runField({ field: 'acre', value })} />;
    case 'versement_liberatoire':
      return <VersementLiberatoireStep {...common} onConfirm={(value) => runField({ field: 'versementLiberatoire', value })} />;
    case 'vat':
      return <VatStep {...common} onConfirm={(value) => runField({ field: 'vatRegime', value })} />;
  }
}

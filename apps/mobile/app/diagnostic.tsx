/**
 * Diagnostic 2026 — flux plein écran indigo sombre (claim C23 v2, réfs claims/ref/C23-frame-p1/p2.png).
 *
 * MOTEUR : use case PUR @bob/core deriveDiagnostic (« expert-comptable ») — l'écran ne calcule
 * AUCUNE règle. Il compose les queries RÉELLES (diagnostic réglementaire serveur C13 + clients +
 * factures + encaissements + profil métier) et projette : l'audit automatique du dossier s'affiche
 * D'ABORD (constats « déjà réglé ✓ / à faire »), puis seulement les questions que les données ne
 * peuvent pas trancher (adaptatif, max 3 — diagnosticQuestions), puis le résultat : score global
 * (ScoreRing @bob/ui animé + count-up, couleur par tranche, jamais d'opacity-0), 3 axes
 * (réception 2026 · émission 2027 · qualité des données, ScoreBar) et plan d'action DATÉ dont
 * chaque item pointe une route réelle de l'app (SIREN manquant → fiche client, etc. — mêmes
 * écrans que les intents de Bob, parité C40).
 *
 * PERSISTANCE : GET/PUT /diagnostic/assessment. Le mobile n'envoie QUE les réponses, la révision
 * CAS et l'empreinte du dossier figée au démarrage. Le serveur recharge PostgreSQL, recalcule
 * score/axes et refuse le résultat si les sources ont changé. Absence = jamais réalisé, jamais 0.
 *
 * Écarts assumés vs proto (tokens only, zéro hex/rgba) :
 * · le fond 172° indigo→navy profond du proto n'existe pas en rampe → themes.indigo.d1 vers
 *   themes.marine.d1 ; les lavandes du proto → vault.scanChipIcon ; barre/CTA → themes.indigo.d3/ink ;
 * · l'anneau @bob/ui garde sa piste claire et son chiffre ink900 → médaillon blanc (surface)
 *   derrière le ring, et le « / 100 » du proto est porté par l'accessibilité (min/max) ;
 * · le « recevoir » en gras de l'intro est rendu en corps simple (copy i18n d'un seul tenant).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, type Href } from 'expo-router';
import {
  deriveDiagnostic,
  type DeriveDiagnosticInput,
  type DeriveDiagnosticResult,
  type DiagActionItem,
  type DiagAnswerValue,
  type DiagAxisId,
  type DiagnosticAnswers,
  type DiagQuestionId,
  type PersistedDiagnosticAnswers,
  validateDiagnosticAssessmentAnswers,
} from '@bob/core';
import { themes, vault } from '@bob/tokens';
import { t, type I18nKey, type Personality } from '@bob/i18n';
import { ScoreBar, ScoreRing, font, useReduceMotion, useTheme } from '@bob/ui';
import {
  useCustomers,
  useDiagnostic,
  useDiagnosticAssessment,
  useInvoices,
  usePayments,
  useProfile,
  useSaveDiagnosticAssessment,
} from '../src/data/hooks';
import { combineQueryStates } from '../src/data/query-state';
import { usePublishAgentContext, type AgentAccessLayout, type AgentContext } from '../src/agent';
import {
  useBobAwareScrollInsets,
  type BobAwareScrollInsets,
} from '../src/components/use-bob-aware-scroll-insets';
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  ShieldIcon,
} from '../src/components/icons';

/** Layout FIGÉ hors composant : passé en dépendance d'effet, un littéral inline ferait boucler le rendu. */
const DIAGNOSTIC_AGENT_LAYOUT: AgentAccessLayout = Object.freeze({ bottomAvoidance: 72 });

// ── Copy des questions (valeurs → @bob/core, clés → @bob/i18n) ────────────────
interface QuestionOption {
  value: DiagAnswerValue;
  key: I18nKey;
}
const QUESTIONS: Record<DiagQuestionId, { title: I18nKey; options: readonly QuestionOption[] }> = {
  platform: {
    title: 'diag.qPlatform',
    options: [
      { value: 'yes', key: 'diag.qPlatformYes' },
      { value: 'no', key: 'diag.qPlatformNo' },
      { value: 'unknown', key: 'diag.qPlatformUnknown' },
    ],
  },
  offAppSales: {
    title: 'diag.qOffApp',
    options: [
      { value: 'yes', key: 'diag.qOffAppYes' },
      { value: 'no', key: 'diag.qOffAppNo' },
      { value: 'unknown', key: 'diag.qOffAppUnknown' },
    ],
  },
  accountant: {
    title: 'diag.qAccountant',
    options: [
      { value: 'yes', key: 'diag.qAccountantYes' },
      { value: 'yes', key: 'diag.qAccountantOga' }, // OGA/CGA = accompagnement comptable aussi
      { value: 'no', key: 'diag.qAccountantNo' },
    ],
  },
};

const AXIS_LABEL: Record<DiagAxisId, I18nKey> = {
  reception: 'diag.axisReception',
  emission: 'diag.axisEmission',
  donnees: 'diag.axisDonnees',
};

/** '2026-09-01' → '01/09/2026' (affichage des échéances du plan). */
function frDate(dateOnly: string): string {
  const [y, m, d] = dateOnly.split('-');
  return y !== undefined && m !== undefined && d !== undefined ? `${d}/${m}/${y}` : dateOnly;
}

type PickedAnswers = Partial<Record<DiagQuestionId, number>>;

function answersFromPicked(picked: PickedAnswers): DiagnosticAnswers {
  const answers: DiagnosticAnswers = {};
  for (const id of Object.keys(QUESTIONS) as DiagQuestionId[]) {
    const index = picked[id];
    const value = index === undefined ? undefined : QUESTIONS[id].options[index]?.value;
    if (value !== undefined) answers[id] = value;
  }
  return answers;
}

function pickedFromAnswers(answers: PersistedDiagnosticAnswers): PickedAnswers {
  const picked: PickedAnswers = {};
  for (const id of Object.keys(QUESTIONS) as DiagQuestionId[]) {
    const value = answers[id];
    if (value === undefined) continue;
    const index = QUESTIONS[id].options.findIndex((option) => option.value === value);
    if (index >= 0) picked[id] = index;
  }
  return picked;
}

// ── Barre de progression fine du proto (piste white10, remplissage dégradé indigo) ──
function ProgressBar({ progress }: { progress: number }) {
  const { overlays } = useTheme();
  const reduceMotion = useReduceMotion();
  const anim = useRef(new Animated.Value(progress)).current;

  useEffect(() => {
    if (reduceMotion) {
      anim.stopAnimation();
      anim.setValue(progress);
      return;
    }
    Animated.timing(anim, {
      toValue: progress,
      duration: 400,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false, // width en % = prop de layout
    }).start();
  }, [anim, progress, reduceMotion]);

  const width = anim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
      style={{
        height: 4,
        borderRadius: 3,
        backgroundColor: overlays.white10,
        overflow: 'hidden',
        marginTop: 10,
      }}
    >
      <Animated.View style={{ height: '100%', width, borderRadius: 3, overflow: 'hidden' }}>
        <LinearGradient
          colors={[themes.indigo.d3, themes.indigo.ink2]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={{ flex: 1 }}
        />
      </Animated.View>
    </View>
  );
}

/** Count-up 0 → target (900 ms, ease-out) — l'anneau ScoreRing suit la valeur affichée. */
function useCountUp(target: number): number {
  const reduceMotion = useReduceMotion();
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (reduceMotion) {
      setValue(target);
      return;
    }
    const start = Date.now();
    const DURATION = 900;
    let raf = 0;
    const tick = (): void => {
      const p = Math.min(1, (Date.now() - start) / DURATION);
      const eased = 1 - (1 - p) ** 3;
      setValue(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduceMotion, target]);
  return value;
}

/** Rangée du plan d'action / des constats — pastille d'état + libellé + échéance + route réelle. */
function ItemRow({
  item,
  last,
  personality,
  onPress,
}: {
  item: DiagActionItem;
  last: boolean;
  personality: Personality;
  onPress?: (() => void) | undefined;
}) {
  const { colors, semantic, overlays, controls } = useTheme();
  const icon = item.done ? (
    <CheckIcon color={semantic.successOnDark} size={14} strokeWidth={2.6} />
  ) : item.severity === 'critical' ? (
    <CloseIcon color={overlays.unreadDot} size={14} strokeWidth={2.4} />
  ) : (
    <ClockIcon color={overlays.white70} size={14} strokeWidth={2.2} />
  );
  const detail = item.count === undefined
    ? t(item.detailKey, { personality })
    : t(item.detailKey, { personality, params: { count: item.count } });
  const body = (
    <>
      <View
        style={{
          width: 26,
          height: 26,
          borderRadius: 8,
          backgroundColor: item.done ? overlays.successPill : overlays.white10,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[font('label', 600), { fontSize: 14, color: colors.surface }]}>
          {t(item.labelKey, { personality })}
        </Text>
        <Text style={[font('meta'), { fontSize: 12, color: overlays.white50, marginTop: 1 }]}>
          {detail}
          {!item.done && item.deadline !== null
            ? ` · ${t('diag.deadline', { personality, params: { date: frDate(item.deadline) } })}`
            : ''}
        </Text>
      </View>
      {onPress !== undefined ? <ChevronRightIcon color={controls.chevron} size={15} /> : null}
    </>
  );
  const rowStyle = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    paddingVertical: 13,
    borderBottomWidth: last ? 0 : 1,
    borderBottomColor: overlays.white08,
  };
  return onPress !== undefined ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(item.labelKey, { personality })}
      onPress={onPress}
      style={rowStyle}
    >
      {body}
    </Pressable>
  ) : (
    <View style={rowStyle}>{body}</View>
  );
}

export default function Diagnostic() {
  const { colors, overlays, personality } = useTheme();
  const reduceMotion = useReduceMotion();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  // Données RÉELLES — les mêmes queries que le reste de l'app (aucun repli fixtures).
  const diagnostic = useDiagnostic();
  const customersQ = useCustomers();
  const invoicesQ = useInvoices();
  const paymentsQ = usePayments();
  const profileQ = useProfile();
  const assessmentQ = useDiagnosticAssessment();
  const saveAssessment = useSaveDiagnosticAssessment();
  const queryState = combineQueryStates(
    diagnostic,
    customersQ,
    invoicesQ,
    paymentsQ,
    profileQ,
    assessmentQ,
  );

  const [phase, setPhase] = useState<'intro' | 'steps' | 'result'>('intro');
  // step 0 = constats de l'audit automatique, puis 1..n = questions adaptatives.
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<PickedAnswers>({});
  type DiagnosticBase = Omit<DeriveDiagnosticInput, 'answers'>;
  const [sourceSnapshot, setSourceSnapshot] = useState<DiagnosticBase | null>(null);
  const [sourceFingerprintSnapshot, setSourceFingerprintSnapshot] = useState<string | null>(null);
  const [persistedResult, setPersistedResult] = useState<DeriveDiagnosticResult | null>(null);
  const [saveError, setSaveError] = useState(false);
  const hydratedSavedRevision = useRef<string | null>(null);

  const answers = useMemo<DiagnosticAnswers>(() => answersFromPicked(picked), [picked]);

  const liveSource = useMemo<DiagnosticBase | null>(() => {
    if (
      !diagnostic.data
      || !customersQ.data
      || !invoicesQ.data
      || !paymentsQ.data
      || !profileQ.data
      || !assessmentQ.data
    ) return null;
    const invoices = invoicesQ.data;
    return {
      facts: diagnostic.data,
      customers: customersQ.data.map((c) => ({ id: c.id, type: c.type, siren: c.siren })),
      invoices: invoices.map((i) => ({
        id: i.id,
        customerId: i.customerId,
        kind: i.kind,
        status: i.status,
        ttcCents: i.totals.ttc,
        lineCategories: i.lines.map((l) => l.category),
      })),
      // Encaissements unitaires réellement persistés : jamais reconstruits depuis un cumul de
      // facture, qui perdrait les dates, doublons et paiements partiels successifs.
      payments: paymentsQ.data.map((payment) => ({
        invoiceId: payment.invoiceId,
        amountCents: payment.amountCents,
      })),
      profile: { trade: profileQ.data.trade },
      // L'autorité temporelle vient du serveur (Europe/Paris), jamais de l'horloge du téléphone.
      today: assessmentQ.data.currentSourceAsOf,
    };
  }, [
    assessmentQ.data,
    customersQ.data,
    diagnostic.data,
    invoicesQ.data,
    paymentsQ.data,
    profileQ.data,
  ]);

  /** Les données métier sont figées au démarrage ; seules les réponses font évoluer le score. */
  const derived = useMemo<DeriveDiagnosticResult | null>(() => {
    const source = sourceSnapshot ?? liveSource;
    return source === null ? null : deriveDiagnostic({ ...source, answers });
  }, [answers, liveSource, sourceSnapshot]);

  const questions = assessmentQ.data?.questions ?? [];
  const questionsAligned = derived !== null
    && derived.questions.length === questions.length
    && derived.questions.every((question, index) => question === questions[index]);
  const totalSteps = questions.length + 1; // constats + questions
  const sourceRefreshing = diagnostic.isFetching
    || customersQ.isFetching
    || invoicesQ.isFetching
    || paymentsQ.isFetching
    || profileQ.isFetching
    || assessmentQ.isFetching;
  const sourcesReady = liveSource !== null && assessmentQ.data !== undefined && questionsAligned;
  const blockingError = queryState.failed;
  const staleSourceError = queryState.failed && sourcesReady;
  const businessResultStale = assessmentQ.data?.status === 'stale';
  const canBegin = sourcesReady
    && !queryState.failed
    && !sourceRefreshing
    && !saveAssessment.isPending;

  useEffect(() => {
    const saved = assessmentQ.data?.saved;
    if (saved === null || saved === undefined || phase !== 'intro') return;
    const key = `${saved.revision}:${saved.updatedAt}`;
    if (hydratedSavedRevision.current === key) return;
    hydratedSavedRevision.current = key;
    setPicked(pickedFromAnswers(saved.answers));
  }, [assessmentQ.data?.saved, phase]);

  useEffect(() => {
    if (
      phase !== 'result'
      || assessmentQ.data === undefined
      || assessmentQ.data.status === 'current'
    ) return;
    // Un résultat devenu obsolète n'est jamais laissé à l'écran comme s'il était courant.
    setPersistedResult(null);
    setSourceSnapshot(null);
    setSourceFingerprintSnapshot(null);
    setPhase('intro');
  }, [assessmentQ.data?.status, phase]);

  const retry = (): void => {
    setSaveError(false);
    saveAssessment.reset();
    queryState.refetchAll();
  };

  const goBack = (): void => {
    if (phase === 'result') {
      setPhase('steps');
      setStep(questions.length);
      return;
    }
    if (step > 0) setStep(step - 1);
    else {
      setPhase('intro');
      setSourceSnapshot(null);
      setSourceFingerprintSnapshot(null);
      setPersistedResult(null);
      setPicked({});
    }
  };

  const answer = (id: DiagQuestionId, optionIndex: number): void => {
    if (saveAssessment.isPending) return;
    const nextPicked = { ...picked, [id]: optionIndex };
    setPicked(nextPicked);
    if (step < questions.length) {
      setStep(step + 1);
      return;
    }

    const parsedAnswers = validateDiagnosticAssessmentAnswers(
      answersFromPicked(nextPicked),
      questions,
    );
    if (
      !parsedAnswers.ok
      || assessmentQ.data === undefined
      || sourceFingerprintSnapshot === null
      || queryState.failed
    ) {
      setSaveError(true);
      return;
    }

    setSaveError(false);
    void saveAssessment.mutateAsync({
      expectedRevision: assessmentQ.data.saved?.revision ?? 0,
      expectedSourceFingerprint: sourceFingerprintSnapshot,
      answers: parsedAnswers.value,
    }).then((saved) => {
      if (saved.status !== 'current' || saved.result === null) {
        throw new Error('DIAGNOSTIC_ASSESSMENT_NOT_CURRENT_AFTER_SAVE');
      }
      setPersistedResult(saved.result);
      setSourceFingerprintSnapshot(saved.currentSourceFingerprint);
      setPhase('result');
    }).catch(() => {
      // Conflit CAS, source modifiée ou panne : aucun score calculé localement n'est exposé.
      setSaveError(true);
      setPersistedResult(null);
      setSourceSnapshot(null);
      setSourceFingerprintSnapshot(null);
      setPhase('intro');
      queryState.refetchAll();
    });
  };

  const begin = (): void => {
    if (!canBegin || liveSource === null || assessmentQ.data === undefined) return;
    setSourceSnapshot(liveSource);
    setSourceFingerprintSnapshot(assessmentQ.data.currentSourceFingerprint);
    setSaveError(false);
    setStep(0);
    if (assessmentQ.data.status === 'current' && assessmentQ.data.result !== null) {
      setPersistedResult(assessmentQ.data.result);
      setPhase('result');
      return;
    }
    setPersistedResult(null);
    setPhase('steps');
  };

  const agentContext = useMemo<AgentContext>(
    () => ({
      screen: { name: 'diagnostic', instanceId: `diagnostic:${phase}:${step}` },
      entities: [],
      capabilities:
        !queryState.failed && (sourceSnapshot !== null || sourcesReady) ? ['screen.read'] : [],
    }),
    [phase, queryState.failed, sourceSnapshot, sourcesReady, step],
  );
  usePublishAgentContext(agentContext, DIAGNOSTIC_AGENT_LAYOUT);
  const bobScrollInsets = useBobAwareScrollInsets({
    minimumBottom: 18,
    viewportBottomInset: insets.bottom + 16,
  });

  useEffect(() => {
    if (phase === 'intro') return;
    const questionId = questions[step - 1];
    const announcement =
      phase === 'result'
        ? t('diag.planTitle', { personality })
        : step === 0
          ? t('diag.auditTitle', { personality })
          : questionId !== undefined
            ? t(QUESTIONS[questionId].title, { personality })
            : t('diag.title', { personality });
    AccessibilityInfo.announceForAccessibility(announcement);
  }, [phase, personality, questions, step]);

  // ── Contenus de phase ───────────────────────────────────────────────────────
  const intro = (
    <>
      <View
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 }}
      >
        <View
          style={{
            width: 84,
            height: 84,
            borderRadius: 26,
            overflow: 'hidden',
            marginBottom: 24,
            shadowColor: themes.indigo.ink2,
            shadowOpacity: 0.45,
            shadowRadius: 34,
            shadowOffset: { width: 0, height: 14 },
            elevation: 10,
          }}
        >
          <LinearGradient
            colors={[themes.indigo.ink2, themes.indigo.ink]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
          >
            <ShieldIcon color={colors.surface} size={40} strokeWidth={1.9} />
          </LinearGradient>
        </View>
        <Text
          style={[
            font('screenH1'),
            {
              fontSize: 28,
              lineHeight: 32,
              color: colors.surface,
              textAlign: 'center',
              marginBottom: 12,
            },
          ]}
        >
          {t('diag.introTitle', { personality })}
        </Text>
        <Text
          style={[
            font('body'),
            {
              fontSize: 15.5,
              lineHeight: 23,
              maxWidth: 300,
              textAlign: 'center',
              color: overlays.white66,
            },
          ]}
        >
          {sourcesReady
            ? t('diag.introBody', { personality, params: { count: questions.length } })
            : t('diag.dataLoading', { personality })}
        </Text>
        {saveError ? (
          <Text
            accessibilityRole="alert"
            style={[font('sub'), { color: overlays.white70, textAlign: 'center', marginTop: 14 }]}
          >
            {t('diag.dataError', { personality })}
          </Text>
        ) : staleSourceError || businessResultStale ? (
          <Text
            accessibilityRole="alert"
            style={[font('sub'), { color: overlays.white70, textAlign: 'center', marginTop: 14 }]}
          >
            {t('diag.staleData', { personality })}
          </Text>
        ) : blockingError ? (
          <Text
            accessibilityRole="alert"
            style={[font('sub'), { color: overlays.white70, textAlign: 'center', marginTop: 14 }]}
          >
            {t('diag.dataError', { personality })}
          </Text>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(blockingError ? 'diag.retry' : 'diag.introCta', { personality })}
        accessibilityState={{ disabled: !canBegin && !blockingError, busy: queryState.loading }}
        disabled={!canBegin && !blockingError}
        onPress={blockingError ? retry : begin}
        style={({ pressed }) => ({
          minHeight: 52,
          backgroundColor: colors.surface,
          borderRadius: 16,
          paddingVertical: 16,
          justifyContent: 'center',
          alignItems: 'center',
          opacity: canBegin || blockingError ? 1 : 0.65,
          transform: [{ scale: pressed && !reduceMotion ? 0.97 : 1 }],
        })}
      >
        <Text style={[font('button'), { color: themes.indigo.d1 }]}>
          {t(blockingError ? 'diag.retry' : canBegin ? 'diag.introCta' : 'diag.dataLoading', {
            personality,
          })}
        </Text>
      </Pressable>
    </>
  );

  const pending = (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18 }}>
      {blockingError ? (
        <>
          <Text
            style={[
              font('body'),
              { fontSize: 15.5, textAlign: 'center', color: overlays.white66, maxWidth: 300 },
            ]}
          >
            {t('diag.dataError', { personality })}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('diag.retry', { personality })}
            onPress={retry}
            style={{
              backgroundColor: overlays.white10,
              borderWidth: 1,
              borderColor: overlays.white14,
              borderRadius: 14,
              paddingVertical: 12,
              paddingHorizontal: 22,
            }}
          >
            <Text style={[font('label', 600), { fontSize: 14, color: colors.surface }]}>
              {t('diag.retry', { personality })}
            </Text>
          </Pressable>
        </>
      ) : (
        <View
          accessibilityRole="progressbar"
          accessibilityLabel={t('diag.dataLoading', { personality })}
          style={{ alignItems: 'center', gap: 12 }}
        >
          <ActivityIndicator color={colors.surface} />
          <Text style={[font('sub'), { color: overlays.white66 }]}>
            {t('diag.dataLoading', { personality })}
          </Text>
        </View>
      )}
    </View>
  );

  /** Étape 0 — l'audit automatique du dossier : constats dérivés des données, AVANT toute question. */
  const audit = derived ? (
    <>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: 18, paddingBottom: bobScrollInsets.paddingBottom }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
        showsVerticalScrollIndicator={false}
      >
        <Text
          style={[font('eyebrow'), { fontSize: 13, color: vault.scanChipIcon, marginBottom: 8 }]}
        >
          {t('diag.auditEyebrow', { personality })}
        </Text>
        <Text style={[font('screenH1'), { fontSize: 25, color: colors.surface, marginBottom: 8 }]}>
          {t('diag.auditTitle', { personality })}
        </Text>
        <Text style={[font('sub'), { color: overlays.white66, marginBottom: 18 }]}>
          {t('diag.auditMix', {
            personality,
            params: {
              b2c: derived.mix.b2c.customers,
              b2b: derived.mix.b2b.customers,
              b2g: derived.mix.b2g.customers,
            },
          })}
        </Text>
        <View
          style={{
            backgroundColor: overlays.white07,
            borderWidth: 1,
            borderColor: overlays.white10,
            borderRadius: 18,
            paddingVertical: 3,
            paddingHorizontal: 16,
          }}
        >
          {derived.items
            .filter((item) => item.source === 'dossier')
            .map((item, i, rows) => (
              <ItemRow
                key={item.kind}
                item={item}
                last={i === rows.length - 1}
                personality={personality}
                onPress={undefined}
              />
            ))}
        </View>
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('diag.auditContinue', { personality })}
        onPress={() => {
          // Le contrat courant exige au moins platform + accountant. Une liste vide signale une
          // incohérence serveur : fermeture explicite, jamais de résultat local non persisté.
          if (questions.length === 0) {
            setSaveError(true);
            setSourceSnapshot(null);
            setSourceFingerprintSnapshot(null);
            setPhase('intro');
            return;
          }
          setStep(1);
        }}
        style={({ pressed }) => ({
          minHeight: 52,
          backgroundColor: colors.surface,
          borderRadius: 16,
          paddingVertical: 16,
          alignItems: 'center',
          transform: [{ scale: pressed && !reduceMotion ? 0.97 : 1 }],
        })}
      >
        <Text style={[font('button'), { color: themes.indigo.d1 }]}>
          {t('diag.auditContinue', { personality })}
        </Text>
      </Pressable>
    </>
  ) : (
    pending
  );

  const questionId = questions[step - 1];
  const question =
    questionId !== undefined ? (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          paddingTop: 18,
          paddingBottom: bobScrollInsets.paddingBottom,
        }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
        showsVerticalScrollIndicator={false}
      >
        <Text
          style={[font('eyebrow'), { fontSize: 13, color: vault.scanChipIcon, marginBottom: 8 }]}
        >
          {t('diag.questionTag', { personality, params: { n: step, total: questions.length } })}
        </Text>
        <Text style={[font('screenH1'), { fontSize: 25, color: colors.surface, marginBottom: 22 }]}>
          {t(QUESTIONS[questionId].title, { personality })}
        </Text>
        <View style={{ gap: 11 }}>
          {QUESTIONS[questionId].options.map((option, index) => {
            const selected = picked[questionId] === index;
            return (
              <Pressable
                key={option.key}
                accessibilityRole="button"
                accessibilityLabel={t(option.key, { personality })}
                accessibilityState={{
                  selected,
                  disabled: saveAssessment.isPending,
                  busy: saveAssessment.isPending,
                }}
                disabled={saveAssessment.isPending}
                onPress={() => answer(questionId, index)}
                style={({ pressed }) => ({
                  minHeight: 52,
                  justifyContent: 'center',
                  backgroundColor: selected || pressed ? overlays.white16 : overlays.white07,
                  borderWidth: 1,
                  borderColor: selected ? vault.scanChipIcon : overlays.white14,
                  borderRadius: 15,
                  padding: 16,
                })}
              >
                <Text style={[font('label', 600), { fontSize: 15.5, color: colors.surface }]}>
                  {t(option.key, { personality })}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {saveAssessment.isPending ? (
          <View
            accessibilityRole="progressbar"
            accessibilityLabel={t('diag.dataLoading', { personality })}
            style={{ alignItems: 'center', gap: 10, marginTop: 18 }}
          >
            <ActivityIndicator color={colors.surface} />
            <Text style={[font('sub'), { color: overlays.white66 }]}>
              {t('diag.dataLoading', { personality })}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    ) : (
      pending
    );

  const result = persistedResult ? (
    <Result
      derived={persistedResult}
      onClose={() => router.back()}
      bobScrollInsets={bobScrollInsets}
      actionsDisabled={
        queryState.failed || sourceRefreshing || assessmentQ.data?.status !== 'current'
      }
    />
  ) : pending;

  return (
    <View style={{ flex: 1, backgroundColor: themes.indigo.d1 }}>
      {/* Fond du proto (172° indigo → navy profond) — rampe de marque, zéro hex. */}
      <LinearGradient
        pointerEvents="none"
        colors={[themes.indigo.d1, themes.marine.d1]}
        start={{ x: 0.45, y: 0 }}
        end={{ x: 0.55, y: 1 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <View
        style={{
          flex: 1,
          paddingTop: insets.top + 10,
          paddingHorizontal: 22,
          paddingBottom: insets.bottom + 16,
        }}
      >
        {/* En-tête : retour (questionnaire/résultat) · bouclier + titre · fermeture × */}
        <View
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {phase !== 'intro' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('diag.back', { personality })}
                onPress={goBack}
                style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
              >
                <ChevronLeftIcon color={overlays.white70} size={18} strokeWidth={2.2} />
              </Pressable>
            ) : null}
            <ShieldIcon color={vault.scanChipIcon} size={17} strokeWidth={2} />
            <Text style={[font('label', 700), { fontSize: 13.5, color: overlays.white70 }]}>
              {t('diag.title', { personality })}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('diag.close', { personality })}
            onPress={() => router.back()}
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: overlays.white10,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <CloseIcon color={colors.surface} size={16} />
          </Pressable>
        </View>

        {phase === 'steps' ? <ProgressBar progress={(step + 1) / (totalSteps + 1)} /> : null}

        {phase === 'intro' ? intro : phase === 'result' ? result : step === 0 ? audit : question}
      </View>
    </View>
  );
}

// ── Résultat — score global (anneau), 3 axes, plan d'action daté, CTA routes réelles ──
function Result({
  derived,
  onClose,
  bobScrollInsets,
  actionsDisabled,
}: {
  derived: DeriveDiagnosticResult;
  onClose: () => void;
  bobScrollInsets: BobAwareScrollInsets;
  actionsDisabled: boolean;
}) {
  const { colors, overlays, personality } = useTheme();
  const reduceMotion = useReduceMotion();
  const router = useRouter();
  const display = useCountUp(derived.score);

  const todos = derived.items.filter((item) => !item.done);
  // Mêmes tranches que la couleur de l'anneau (@bob/ui score.logic : >75 · 50–75 · <50).
  const titleKey: I18nKey =
    derived.score > 75
      ? 'diag.resultTitleHigh'
      : derived.score >= 50
        ? 'diag.resultTitleMid'
        : 'diag.resultTitleLow';
  const bodyKey: I18nKey =
    todos.length === 0
      ? 'diag.resultBodyNone'
      : todos.length === 1
        ? 'diag.resultBodyOne'
        : 'diag.resultBody';
  // « Configurer dans l'app » → la route du premier item à faire (réception en tête de tri).
  const primaryRoute = todos.find((item) => item.route !== null)?.route ?? '/compte';

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingTop: 16, paddingBottom: bobScrollInsets.paddingBottom }}
      automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
      scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
      showsVerticalScrollIndicator={false}
    >
      <View style={{ alignItems: 'center', marginBottom: 20 }}>
        {/* Médaillon surface : l'anneau @bob/ui garde piste claire + chiffre ink900 lisibles sur l'indigo. */}
        <View
          style={{
            width: 148,
            height: 148,
            borderRadius: 74,
            backgroundColor: colors.surface,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 14,
          }}
        >
          <ScoreRing
            score={display}
            size={124}
            accessibilityLabel={t('diag.title', { personality })}
          />
        </View>
        <Text
          style={[
            font('screenH1'),
            { fontSize: 24, color: colors.surface, marginBottom: 6, textAlign: 'center' },
          ]}
        >
          {t(titleKey, { personality })}
        </Text>
        <Text
          style={[
            font('sub'),
            { fontSize: 14.5, color: overlays.white66, textAlign: 'center', maxWidth: 290 },
          ]}
        >
          {t(bodyKey, { personality, params: { count: todos.length } })}
        </Text>
      </View>

      {/* 3 axes du diagnostic expert-comptable — réception surpondérée avant 2026 (core). */}
      <View
        style={{
          backgroundColor: overlays.white07,
          borderWidth: 1,
          borderColor: overlays.white10,
          borderRadius: 18,
          padding: 16,
          gap: 12,
          marginBottom: 14,
        }}
      >
        {derived.axes.map((axis) => (
          <View key={axis.id} style={{ gap: 6 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Text style={[font('label', 600), { fontSize: 13, color: colors.surface }]}>
                {t(AXIS_LABEL[axis.id], { personality })}
              </Text>
              <Text
                style={[font('meta'), { color: overlays.white70, fontVariant: ['tabular-nums'] }]}
              >
                {axis.score}
              </Text>
            </View>
            <ScoreBar
              score={axis.score}
              accessibilityLabel={t(AXIS_LABEL[axis.id], { personality })}
            />
          </View>
        ))}
      </View>

      {/* Plan d'action daté — à faire d'abord (tri core), chaque item ouvre sa route réelle. */}
      <Text style={[font('eyebrow'), { fontSize: 12, color: vault.scanChipIcon, marginBottom: 8 }]}>
        {t('diag.planTitle', { personality })}
      </Text>
      <View
        style={{
          backgroundColor: overlays.white07,
          borderWidth: 1,
          borderColor: overlays.white10,
          borderRadius: 18,
          paddingVertical: 3,
          paddingHorizontal: 16,
          marginBottom: 18,
        }}
      >
        {derived.items.map((item, i, rows) => (
          <ItemRow
            key={item.kind}
            item={item}
            last={i === rows.length - 1}
            personality={personality}
            onPress={
              !actionsDisabled && !item.done && item.route !== null
                ? () => router.push(item.route as Href) // routes réelles de l'app, testées côté core
                : undefined
            }
          />
        ))}
      </View>

      {actionsDisabled ? (
        <Text
          accessibilityRole="alert"
          style={[font('sub'), { color: overlays.white70, textAlign: 'center', marginBottom: 12 }]}
        >
          {t('diag.staleData', { personality })}
        </Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('diag.resultCta', { personality })}
        accessibilityState={{ disabled: actionsDisabled }}
        disabled={actionsDisabled}
        onPress={() => router.push(primaryRoute as Href)}
        style={({ pressed }) => ({
          minHeight: 52,
          borderRadius: 16,
          overflow: 'hidden',
          opacity: actionsDisabled ? 0.55 : 1,
          transform: [{ scale: pressed && !reduceMotion && !actionsDisabled ? 0.97 : 1 }],
          shadowColor: themes.indigo.ink2,
          shadowOpacity: 0.4,
          shadowRadius: 24,
          shadowOffset: { width: 0, height: 10 },
          elevation: 8,
          marginBottom: 10,
        })}
      >
        <LinearGradient
          colors={[themes.indigo.ink2, themes.indigo.ink]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{
            minHeight: 52,
            paddingVertical: 16,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={[font('button'), { color: colors.surface }]}>
            {t('diag.resultCta', { personality })}
          </Text>
        </LinearGradient>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('diag.resultLater', { personality })}
        onPress={onClose}
        style={{ minHeight: 44, justifyContent: 'center', alignItems: 'center' }}
      >
        <Text style={[font('label', 600), { fontSize: 14, color: overlays.white60 }]}>
          {t('diag.resultLater', { personality })}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

/**
 * Facture à la voix — flux 3 étapes (claim C20, réfs claims/ref/C20-frame-p1/p2.png).
 * PILOTÉ par la machine RÉELLE @bob/core flows/voice-invoice (C02) : startVoiceInvoice →
 * voiceCaptured (écoute → revue) → voiceRetry (revue → écoute, brouillon conservé) →
 * voiceConfirm (revue → terminée, confirmation EXPLICITE — préparer ≠ envoyer). Aucune
 * duplication : chaque changement d'étape passe par une transition de la machine.
 *
 * ÉCOUTE (fond navy) : orbe micro verte + onde 7 barres — animées sauf préférence
 * « réduire les animations », jamais d'opacity-0 au repos (charte §4.7) — branchées sur le pipeline STT réel data/voice
 * (natif expo-speech-recognition par défaut, cloud Voxtral Transcribe via /voice/transcribe
 * selon le réglage). Micro refusé/indisponible/transcription ratée → état HONNÊTE voix de
 * Bob (voix.micDenied/micUnavailable/micFailed) + saisie texte de secours : le flux reste
 * 100 % utilisable (mode démo/simulateur sans module natif compris).
 *
 * REVUE : brouillon dérivé du transcript par @bob/core deriveVoiceInvoiceDraft (pur, testé) —
 * client reconnu parmi les customers RÉELS (sinon sélection explicite), lignes chiffrées
 * (jamais un centime inventé), TVA métier (useProfile), totaux computeTotals. Card @bob/ui.
 *
 * ISSUE : « Encaisser » / « Envoyer » → useConfirm (MÊME feuille de confirmation typée que
 * les CTA manuels, challengeFor amount/fiscal) → MÊME chaîne de use cases que l'UI,
 * journalisée localement par checkpoints après chaque succès
 * (createQuote → sendQuote → signQuote sur place → generateInvoice → issueInvoice
 * [→ registerPayment]) via les hooks existants → écran succès (machine: terminee) + Toast →
 * retour Aujourd'hui (router.replace, edge C10).
 *
 * Écarts assumés vs réf : les verts émeraude et le navy profond du proto n'existent pas
 * en tokens → orbe semantic.success + voile overlays.haloGreen, fonds theme.d1/d2 et themes.foret ;
 * « Envoyer le lien par SMS » → « Envoyer la facture » (l'envoi SMS réel = TODO C40, l'acte
 * légal ici est l'émission) ; le journal on-device de la confirmation = TODO ⑧ C40 (audit C15).
 * Zéro hex/rgba — tout vient de useTheme()/@bob/tokens.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AccessibilityInfo,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { challengeFor } from '@bob/ai';
import {
  computeTotals,
  deriveVoiceInvoiceDraft,
  formatEUR,
  startVoiceInvoice,
  voiceCaptured,
  voiceConfirm,
  voiceRetry,
  type CustomerListItem,
  type LineCategory,
  type PaymentMethod,
  type VoiceInvoiceOutcome,
  type VoiceInvoiceState,
} from '@bob/core';
import { shadowNative, themes } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import {
  Avatar,
  Card,
  Chip,
  EmptyState,
  ErrorRetry,
  MoneyText,
  Skeleton,
  StatusBadge,
  Toast,
  font,
  useReduceMotion,
  useTheme,
  type StatusBadgeVariant,
} from '@bob/ui';
import {
  appErrorMessage,
  useCreateQuote,
  useCustomers,
  useGenerateInvoice,
  useIssueInvoice,
  useProfile,
  useRegisterPayment,
  useSendQuote,
  useSignQuote,
} from '../src/data/hooks';
import { useCustomPrestations } from '../src/data/catalogue';
import { useBobClient } from '../src/data/client';
import { combineQueryStates } from '../src/data/query-state';
import { useVoiceInput, type VoiceInputIssue } from '../src/data/voice';
import { useConfirm } from '../src/components/ConfirmSheet';
import {
  CheckIcon,
  ChevronLeftIcon,
  CloseIcon,
  MicIcon,
  SendIcon,
  SparkSmallIcon,
  WalletIcon,
} from '../src/components/icons';
import {
  advanceVoiceInvoiceCheckpoint,
  createVoiceInvoiceCheckpoint,
  nextVoiceInvoiceExecutionAction,
  parseVoiceInvoiceCheckpoint,
  quoteMatchesVoiceInvoiceDraft,
  reconcileVoiceInvoiceQuote,
  serializeVoiceInvoiceCheckpoint,
  voiceInvoiceCheckpointProgress,
  voiceInvoicePaymentIdempotencyKey,
  type VoiceInvoiceCheckpoint,
} from '../src/voice-flow/voice-invoice-checkpoint';

/** Profils de risque des confirmations — mêmes paliers que DocumentActions / registre de Bob. */
const ACCOUNTING = { mutating: true, outbound: false, riskTier: 'accounting' } as const;
const FISCAL = { mutating: true, outbound: false, riskTier: 'fiscal' } as const;

const MIC_ISSUE_COPY: Record<VoiceInputIssue, I18nKey> = {
  denied: 'voix.micDenied',
  unavailable: 'voix.micUnavailable',
  failed: 'voix.micFailed',
};

/** Ton de pastille par type de client (mêmes teintes que le carnet C12). */
const CUSTOMER_TONE: Record<CustomerListItem['type'], StatusBadgeVariant> = {
  b2c: 'particulier',
  b2b: 'b2b',
  b2g: 'b2g',
};
const CUSTOMER_BADGE: Record<CustomerListItem['type'], I18nKey> = {
  b2c: 'clients.badgeB2c',
  b2b: 'clients.badgeB2b',
  b2g: 'clients.badgeB2g',
};

/** Libellé + ton par catégorie de ligne (revue). */
const CATEGORY_BADGE: Partial<Record<LineCategory, { key: I18nKey; tone: StatusBadgeVariant }>> = {
  labor: { key: 'voix.catLabor', tone: 'b2b' },
  supply: { key: 'voix.catSupply', tone: 'success' },
  travel: { key: 'voix.catTravel', tone: 'particulier' },
};

const VOICE_INVOICE_CHECKPOINT_KEY = 'bob.voice-invoice.execution.v1';

function VoiceDataSkeleton({
  onClose,
  closeLabel,
  loadingLabel,
}: {
  onClose: () => void;
  closeLabel: string;
  loadingLabel: string;
}) {
  const { colors, overlays, theme } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: theme.d1 }}>
      <LinearGradient
        pointerEvents="none"
        colors={[theme.d2, theme.d1]}
        start={{ x: 0.4, y: 0 }}
        end={{ x: 0.6, y: 1 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <View
        style={{
          paddingTop: insets.top + 12,
          paddingHorizontal: 20,
          minHeight: insets.top + 64,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Skeleton width={132} height={14} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
          onPress={onClose}
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
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={loadingLabel}
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 }}
      >
        <Skeleton width={108} height={108} radius={54} />
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            height: 30,
            marginTop: 18,
            marginBottom: 26,
          }}
        >
          {[14, 22, 28, 18, 26, 20, 14].map((height, index) => (
            <Skeleton key={index} width={5} height={height} radius={3} />
          ))}
        </View>
        <Skeleton width="78%" height={18} />
        <Skeleton width="56%" height={18} style={{ marginTop: 10 }} />
      </View>
      <View
        style={{ paddingHorizontal: 24, paddingBottom: insets.bottom + 24, alignItems: 'center' }}
      >
        <Skeleton width="68%" height={12} style={{ marginBottom: 16 }} />
        <Skeleton height={52} radius={16} />
      </View>
    </View>
  );
}

/** Onde 7 barres (proto §showVoice) — respiration douce au repos, pleine amplitude en écoute,
 *  statique si reduce-motion. Jamais sous 30 % (charte §4.7 : pas d'opacity-0). */
function WaveBars({ active }: { active: boolean }) {
  const { semantic } = useTheme();
  const reduceMotion = useReduceMotion();
  const bars = useRef([0, 1, 2, 3, 4, 5, 6].map(() => new Animated.Value(0))).current;

  useEffect(() => {
    if (reduceMotion) {
      bars.forEach((bar) => {
        bar.stopAnimation();
        bar.setValue(active ? 0.55 : 0);
      });
      return;
    }
    const loops = bars.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 110),
          Animated.timing(v, {
            toValue: 1,
            duration: 420,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(v, {
            toValue: 0,
            duration: 420,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.delay((bars.length - 1 - i) * 70),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [active, bars, reduceMotion]);

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 30 }}
    >
      {bars.map((v, i) => (
        <Animated.View
          key={i}
          style={{
            width: 5,
            height: 30,
            borderRadius: 3,
            backgroundColor: semantic.successOnDark,
            transform: [
              {
                scaleY: v.interpolate({
                  inputRange: [0, 1],
                  outputRange: active ? [0.35, 1] : [0.3, 0.5],
                }),
              },
            ],
          }}
        />
      ))}
    </View>
  );
}

/** Orbe micro verte : respiration continue + anneaux d'onde pendant l'écoute (Animated natif). */
function MicOrb({
  listening,
  onPress,
  label,
}: {
  listening: boolean;
  onPress: () => void;
  label: string;
}) {
  const { colors, semantic, overlays } = useTheme();
  const reduceMotion = useReduceMotion();
  const breathe = useRef(new Animated.Value(0)).current;
  const rings = useRef([new Animated.Value(0), new Animated.Value(0)]).current;

  useEffect(() => {
    if (reduceMotion) {
      breathe.stopAnimation();
      breathe.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, {
          toValue: 1,
          duration: 1500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(breathe, {
          toValue: 0,
          duration: 1500,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breathe, reduceMotion]);

  useEffect(() => {
    if (!listening || reduceMotion) {
      rings.forEach((r) => r.setValue(0));
      return;
    }
    const loops = rings.map((r, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 700),
          Animated.timing(r, {
            toValue: 1,
            duration: 1900,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [listening, reduceMotion, rings]);

  const scale = reduceMotion
    ? 1
    : breathe.interpolate({
        inputRange: [0, 1],
        outputRange: listening ? [1, 1.08] : [0.98, 1.03],
      });

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: listening }}
      style={{ width: 168, height: 168, alignItems: 'center', justifyContent: 'center' }}
    >
      {listening && !reduceMotion
        ? rings.map((r, i) => (
            <Animated.View
              key={i}
              style={{
                position: 'absolute',
                width: 108,
                height: 108,
                borderRadius: 54,
                backgroundColor: overlays.successPill,
                opacity: r.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }),
                transform: [
                  { scale: r.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] }) },
                ],
              }}
            />
          ))
        : null}
      <Animated.View
        style={{
          width: 78,
          height: 78,
          borderRadius: 39,
          overflow: 'hidden',
          backgroundColor: semantic.success,
          transform: [{ scale }],
          shadowColor: semantic.success,
          shadowOpacity: 0.4,
          shadowRadius: 30,
          shadowOffset: { width: 0, height: 10 },
          elevation: 12,
        }}
      >
        {/* Voile émeraude — le vert vif du proto n'existe qu'en overlay token (haloGreen). */}
        <LinearGradient
          colors={[overlays.haloGreen[0], overlays.haloGreen[1]]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
        >
          <MicIcon color={colors.surface} size={30} strokeWidth={2} />
        </LinearGradient>
      </Animated.View>
    </Pressable>
  );
}

export default function Voix() {
  const { colors, semantic, controls, overlays, theme, personality } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const confirm = useConfirm();
  const client = useBobClient();
  const customersQuery = useCustomers();
  const profileQuery = useProfile();
  // Catalogue C27 : SEULES les prestations PERSO (prix de l'artisan) chiffrent une ligne
  // nommée sans montant énoncé — jamais un indicatif métier (règle d'or du core).
  const prestationsQuery = useCustomPrestations();
  const sourceState = combineQueryStates(customersQuery, profileQuery, prestationsQuery);
  const customers = customersQuery.data;
  const profile = profileQuery.data;
  const prestations = prestationsQuery.data;
  const createQuote = useCreateQuote();
  const sendQuote = useSendQuote();
  const signQuote = useSignQuote();
  const generateInvoice = useGenerateInvoice();
  const issueInvoice = useIssueInvoice();
  const registerPayment = useRegisterPayment();

  // ── Machine RÉELLE @bob/core (C02) : la seule source de vérité des 3 étapes ──
  const [flow, setFlow] = useState<VoiceInvoiceState>(() => startVoiceInvoice());
  const [transcript, setTranscript] = useState('');
  const [typed, setTyped] = useState('');
  const [micIssue, setMicIssue] = useState<VoiceInputIssue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operationLockRef = useRef(false);
  const [method, setMethod] = useState<PaymentMethod>('transfer');
  const [issuedNumber, setIssuedNumber] = useState<string | null>(null);
  const [issuedCustomerName, setIssuedCustomerName] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [checkpoint, setCheckpoint] = useState<VoiceInvoiceCheckpoint | null>(null);
  const checkpointRef = useRef<VoiceInvoiceCheckpoint | null>(null);
  const [checkpointHydration, setCheckpointHydration] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [checkpointHydrationAttempt, setCheckpointHydrationAttempt] = useState(0);
  const checkpointHydrationStarted = useRef(false);

  const setCurrentCheckpoint = (next: VoiceInvoiceCheckpoint | null): void => {
    checkpointRef.current = next;
    setCheckpoint(next);
  };

  const persistCheckpoint = async (next: VoiceInvoiceCheckpoint): Promise<void> => {
    // L'état mémoire est avancé AVANT l'I/O : un échec de stockage ne rejoue jamais une
    // étape dans cette session. La chaîne s'arrête ensuite jusqu'à ce que la persistance
    // réussisse, afin de ne pas perdre le point de reprise sur un arrêt de l'application.
    setCurrentCheckpoint(next);
    // Le transcript vocal brut peut contenir une adresse ou des détails personnels : il
    // reste en mémoire pour la revue courante mais n'est jamais écrit dans AsyncStorage.
    await AsyncStorage.setItem(VOICE_INVOICE_CHECKPOINT_KEY, serializeVoiceInvoiceCheckpoint(next));
  };

  useEffect(() => {
    const sourcesReady =
      customers !== undefined && profile !== undefined && prestations !== undefined;
    if (
      sourceState.loading ||
      sourceState.failed ||
      !sourcesReady ||
      checkpointHydrationStarted.current
    )
      return;
    checkpointHydrationStarted.current = true;
    let alive = true;
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(VOICE_INVOICE_CHECKPOINT_KEY);
        const restored = parseVoiceInvoiceCheckpoint(raw);
        if (raw !== null && restored === null)
          await AsyncStorage.removeItem(VOICE_INVOICE_CHECKPOINT_KEY);
        if (restored !== null) {
          // AsyncStorage est local et non autoritatif : un checkpoint d'un autre tenant
          // ne traverse jamais l'écran. Le client doit exister dans la query tenant-scopée.
          const belongsToCurrentTenant = customers.some(
            (customer) => customer.id === restored.draft.customerId,
          );
          if (!belongsToCurrentTenant) {
            await AsyncStorage.removeItem(VOICE_INVOICE_CHECKPOINT_KEY);
          } else {
            const restoredFlow = voiceCaptured(startVoiceInvoice(), restored.draft);
            if (!restoredFlow.ok) {
              await AsyncStorage.removeItem(VOICE_INVOICE_CHECKPOINT_KEY);
            } else if (alive) {
              setCurrentCheckpoint(restored);
              setTranscript(restored.draft.transcript ?? '');
              setMethod(restored.method);
              setIssuedNumber(restored.issuedNumber);
              setFlow(restoredFlow.value);
            }
          }
        }
        if (alive) setCheckpointHydration('ready');
      } catch {
        if (alive) setCheckpointHydration('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [
    checkpointHydrationAttempt,
    customers,
    prestations,
    profile,
    sourceState.failed,
    sourceState.loading,
  ]);

  useEffect(() => {
    if (checkpoint === null) return;
    const progress = voiceInvoiceCheckpointProgress(checkpoint);
    AccessibilityInfo.announceForAccessibility(
      `${t('voix.resumeProgress', { personality })} ${progress.completed} / ${progress.total}`,
    );
  }, [checkpoint, personality]);

  const retryCheckpointHydration = (): void => {
    checkpointHydrationStarted.current = false;
    setCheckpointHydration('loading');
    setCheckpointHydrationAttempt((attempt) => attempt + 1);
  };

  // Le brouillon se COMPLÈTE (voiceRetry conserve l'acquis) : chaque dictée s'ajoute au transcript.
  const appendTranscript = (text: string): void => {
    const clean = text.trim();
    if (!clean) return;
    setTranscript((prev) => (prev ? `${prev} ${clean}` : clean));
    setError(null);
  };
  const { listening, start, stop } = useVoiceInput(appendTranscript, { onIssue: setMicIssue });

  const toggleMic = (): void => {
    if (listening) {
      void stop();
      return;
    }
    setMicIssue(null);
    void start();
  };

  const submitTyped = (): void => {
    appendTranscript(typed);
    setTyped('');
  };

  /** Écoute → revue : dérivation PURE @bob/core puis transition voiceCaptured (garde-fous core). */
  const capture = (): void => {
    if (listening) void stop();
    if (customers === undefined || profile === undefined || prestations === undefined) {
      setError(t('voix.errAction', { personality }));
      return;
    }
    const derived = deriveVoiceInvoiceDraft({
      transcript,
      customers,
      defaultVatRate: profile.defaultVatRate,
      prestations,
    });
    const next = voiceCaptured(flow, derived.draft);
    if (!next.ok) {
      setError(
        t(next.error.code === 'VALIDATION' ? 'voix.errNoLines' : 'voix.errAction', { personality }),
      );
      return;
    }
    setMethod(derived.paymentMethod);
    setError(null);
    setFlow(next.value);
  };

  /** Correction : retour à l'écoute — la machine conserve le brouillon (voiceRetry). */
  const retry = (): void => {
    // Dès qu'une écriture a été tentée, le brouillon reste figé : le modifier créerait une
    // divergence entre ce que l'écran montre et le devis/facture déjà potentiellement créés.
    if (checkpointRef.current !== null) return;
    const back = voiceRetry(flow);
    if (!back.ok) return;
    setError(null);
    setFlow(back.value);
  };

  /** Correction client en revue : donnée du brouillon, pas une transition — la machine reste en 'revue'. */
  const pickCustomer = (id: string): void => {
    setFlow((f) => ({ ...f, draft: { ...f.draft, customerId: id } }));
    setError(null);
  };

  /**
   * Issue : confirmation EXPLICITE (même feuille typée que les CTA manuels) puis la MÊME chaîne
   * de use cases que l'UI (devis/new, DocumentActions) — rien n'est persisté avant le OK.
   */
  const onOutcome = async (outcome: VoiceInvoiceOutcome): Promise<void> => {
    if (operationLockRef.current || busy) return;
    operationLockRef.current = true;
    try {
      const { customerId, lines } = flow.draft;
      if (customerId === null) {
        setError(t('voix.errNoCustomer', { personality }));
        return;
      }
      if (customers === undefined) {
        setError(t('voix.errAction', { personality }));
        return;
      }
      const customer = customers.find((c) => c.id === customerId);
      if (customer === undefined) {
        setError(t('voix.errNoCustomer', { personality }));
        return;
      }
      const name = customer.name;
      const totals = computeTotals([...lines]);
      const amount = formatEUR(totals.netToPay);
      const ok = await confirm(
        outcome === 'encaissee'
          ? {
              title: t('voix.confirmCollectTitle', { personality }),
              message: t('voix.confirmCollectBody', { personality, params: { name, amount } }),
              challenge: challengeFor(ACCOUNTING, 'confirm_all', { amountCents: totals.netToPay }),
            }
          : {
              title: t('voix.confirmSendTitle', { personality }),
              message: t('voix.confirmSendBody', { personality, params: { name, amount } }),
              challenge: challengeFor(FISCAL, 'confirm_all'),
            },
      );
      if (!ok) return;
      setBusy(true);
      setError(null);
      try {
        let active = checkpointRef.current;
        if (active !== null && active.outcome !== outcome)
          throw new Error('VOICE_CHECKPOINT_OUTCOME_LOCKED');

        if (active === null) {
          // Snapshot AVANT la première écriture : indispensable pour reconnaître, après une
          // réponse réseau perdue, le seul devis créé par CETTE tentative sans confondre un
          // ancien devis identique.
          const before = await client.listQuotes();
          if (!before.ok) throw before.error;
          active = createVoiceInvoiceCheckpoint({
            draft: flow.draft,
            outcome,
            method,
            quoteCreationIdempotencyKey: `mobile-voice:quote:${randomUUID()}`,
            // Seuls les devis déjà identiques sont nécessaires au fence de réconciliation :
            // la taille du checkpoint reste bornée même après des années d'utilisation.
            baselineQuoteIds: before.value
              .filter((quote) =>
                quoteMatchesVoiceInvoiceDraft(quote, { ...flow.draft, customerId }),
              )
              .map((quote) => quote.id),
          });
          await persistCheckpoint(active);
        } else {
          // Un précédent setItem peut avoir échoué après l'avancement mémoire. On sécurise
          // d'abord le point courant avant d'autoriser la prochaine mutation.
          await persistCheckpoint(active);
        }

        while (nextVoiceInvoiceExecutionAction(active) !== 'complete') {
          const action = nextVoiceInvoiceExecutionAction(active);
          if (action === 'create_quote') {
            // Checkpoints historiques (sans clé) : réconciliation prudente uniquement.
            // Checkpoints neufs : le serveur garantit le même output pour la même clé.
            if (active.createAttempted && active.quoteCreationIdempotencyKey === null) {
              const listed = await client.listQuotes();
              if (!listed.ok) throw listed.error;
              const reconciled = reconcileVoiceInvoiceQuote(active, listed.value);
              if (reconciled.kind === 'ambiguous')
                throw new Error('VOICE_CHECKPOINT_AMBIGUOUS_QUOTE');
              if (reconciled.kind === 'found') {
                active = advanceVoiceInvoiceCheckpoint(active, {
                  type: 'quote_created',
                  quoteId: reconciled.quoteId,
                });
                await persistCheckpoint(active);
                continue;
              }
              // Sans clé serveur, « non trouvé » ne prouve PAS que POST /quotes n'a rien
              // persisté (réponse perdue, normalisation ou visibilité différée). Fail-close :
              // on ne rejoue jamais la création automatiquement. Une vraie reprise fluide
              // exige une idempotencyKey serveur sur createQuote.
              throw new Error('VOICE_CHECKPOINT_QUOTE_STATE_UNKNOWN');
            }
            if (!active.createAttempted) {
              active = advanceVoiceInvoiceCheckpoint(active, { type: 'quote_creation_started' });
              await persistCheckpoint(active);
            }
            const created = await createQuote.mutateAsync({
              customerId,
              lines: [...lines],
              ...(active.quoteCreationIdempotencyKey !== null
                ? { idempotencyKey: active.quoteCreationIdempotencyKey }
                : {}),
            });
            active = advanceVoiceInvoiceCheckpoint(active, {
              type: 'quote_created',
              quoteId: created.quoteId,
            });
            await persistCheckpoint(active);
            continue;
          }

          if (action === 'send_quote') {
            await sendQuote.mutateAsync(active.quoteId!);
            active = advanceVoiceInvoiceCheckpoint(active, { type: 'quote_sent' });
            await persistCheckpoint(active);
            continue;
          }

          if (action === 'sign_quote') {
            // SignQuote n'accepte pas signed → signed. On relit donc l'agrégat avant le retry :
            // une réponse perdue après signature devient un succès réconcilié, jamais un échec
            // suivi d'une seconde signature.
            const currentQuote = await client.getQuote(active.quoteId!);
            if (!currentQuote.ok) throw currentQuote.error;
            if (currentQuote.value.status !== 'signed') {
              if (currentQuote.value.status !== 'sent' && currentQuote.value.status !== 'viewed') {
                throw new Error('VOICE_CHECKPOINT_QUOTE_NOT_SIGNABLE');
              }
              await signQuote.mutateAsync({ quoteId: active.quoteId!, signerName: name });
            }
            active = advanceVoiceInvoiceCheckpoint(active, { type: 'quote_signed' });
            await persistCheckpoint(active);
            continue;
          }

          if (action === 'generate_invoice') {
            // mode:'final' exploite l'idempotence domaine par (parentQuoteId, kind).
            const generated = await generateInvoice.mutateAsync({
              quoteId: active.quoteId!,
              mode: 'final',
            });
            active = advanceVoiceInvoiceCheckpoint(active, {
              type: 'invoice_generated',
              invoiceId: generated.invoiceId,
            });
            await persistCheckpoint(active);
            continue;
          }

          if (action === 'issue_invoice') {
            // IssueInvoice renvoie le numéro existant si l'émission précédente a réussi mais
            // que sa réponse a été perdue.
            const issued = await issueInvoice.mutateAsync(active.invoiceId!);
            active = advanceVoiceInvoiceCheckpoint(active, {
              type: 'invoice_issued',
              number: issued.number,
            });
            await persistCheckpoint(active);
            continue;
          }

          if (action === 'register_payment') {
            await registerPayment.mutateAsync({
              invoiceId: active.invoiceId!,
              amount: totals.netToPay,
              method: active.method,
              idempotencyKey: voiceInvoicePaymentIdempotencyKey({
                invoiceId: active.invoiceId!,
                amount: totals.netToPay,
                method: active.method,
              }),
            });
            active = advanceVoiceInvoiceCheckpoint(active, { type: 'payment_registered' });
            await persistCheckpoint(active);
          }
        }

        const done = voiceConfirm(flow, active.outcome);
        if (!done.ok) {
          setError(t('voix.errAction', { personality }));
          return;
        }
        await AsyncStorage.removeItem(VOICE_INVOICE_CHECKPOINT_KEY);
        setCurrentCheckpoint(null);
        setIssuedNumber(active.issuedNumber);
        setIssuedCustomerName(name);
        setFlow(done.value);
        setToast(
          active.outcome === 'encaissee'
            ? t('voix.toastPaid', { personality, params: { amount } })
            : t('voix.toastSent', { personality, params: { number: active.issuedNumber ?? '—' } }),
        );
      } catch (e) {
        if (
          e instanceof Error &&
          (e.message === 'VOICE_CHECKPOINT_AMBIGUOUS_QUOTE' ||
            e.message === 'VOICE_CHECKPOINT_QUOTE_STATE_UNKNOWN')
        ) {
          setError(t('voix.resumeAmbiguous', { personality }));
        } else {
          setError(appErrorMessage(e));
        }
      } finally {
        setBusy(false);
      }
    } finally {
      operationLockRef.current = false;
    }
  };

  const sourcesReady =
    customers !== undefined && profile !== undefined && prestations !== undefined;
  if (
    sourceState.loading ||
    (!sourceState.failed && sourcesReady && checkpointHydration === 'loading')
  ) {
    return (
      <VoiceDataSkeleton
        closeLabel={t('voix.close', { personality })}
        loadingLabel={t('voix.dataLoading', { personality })}
        onClose={() => router.back()}
      />
    );
  }
  if (sourceState.failed || !sourcesReady || checkpointHydration === 'error') {
    const retrySources = sourceState.failed || !sourcesReady;
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          paddingTop: insets.top + 12,
          paddingHorizontal: 18,
        }}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 18 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('voix.close', { personality })}
            onPress={() => router.back()}
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: colors.lineSoft,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <CloseIcon color={colors.slate500} size={16} />
          </Pressable>
        </View>
        <ErrorRetry
          message={t(retrySources ? 'voix.dataError' : 'voix.resumeError', { personality })}
          onRetry={retrySources ? sourceState.refetchAll : retryCheckpointHydration}
          secondaryLabel={t('voix.close', { personality })}
          onSecondaryAction={() => router.back()}
        />
      </View>
    );
  }
  if (customers.length === 0) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          paddingTop: insets.top + 12,
          paddingHorizontal: 18,
        }}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 18 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('voix.close', { personality })}
            onPress={() => router.back()}
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: colors.lineSoft,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <CloseIcon color={colors.slate500} size={16} />
          </Pressable>
        </View>
        <Card>
          <EmptyState body={t('devis.noCustomers', { personality })} />
        </Card>
      </View>
    );
  }

  // ════════ ÉTAPE 1 — ÉCOUTE (machine: 'ecoute') ═══════════════════════════════
  if (flow.step === 'ecoute') {
    const statusText =
      transcript !== ''
        ? transcript
        : listening
          ? t('voix.listening', { personality })
          : micIssue !== null
            ? t(MIC_ISSUE_COPY[micIssue], { personality })
            : t('voix.idle', { personality });

    return (
      <View style={{ flex: 1, backgroundColor: theme.d1 }}>
        <LinearGradient
          pointerEvents="none"
          colors={[theme.d2, theme.d1]}
          start={{ x: 0.4, y: 0 }}
          end={{ x: 0.6, y: 1 }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}
        >
          {/* Header : titre + fermer */}
          <View
            style={{
              paddingTop: insets.top + 12,
              paddingHorizontal: 20,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Text style={[font('label', 600), { fontSize: 14, color: overlays.white60 }]}>
              {t('voix.title', { personality })}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('voix.close', { personality })}
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

          {/* Orbe + onde + transcription */}
          <View
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: 28,
            }}
          >
            <MicOrb
              listening={listening}
              onPress={toggleMic}
              label={t('voix.title', { personality })}
            />
            <View style={{ marginTop: 18, marginBottom: 26 }}>
              <WaveBars active={listening} />
            </View>
            <Text
              accessibilityLiveRegion="polite"
              style={[
                font('body'),
                {
                  minHeight: 96,
                  maxWidth: 320,
                  textAlign: 'center',
                  fontSize: 18,
                  lineHeight: 27,
                  color: transcript !== '' ? colors.surface : overlays.white60,
                },
              ]}
            >
              {statusText}
            </Text>

            {/* Saisie de secours — le flux reste utilisable sans STT (état honnête). */}
            {micIssue !== null ? (
              <View
                style={{
                  alignSelf: 'stretch',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  backgroundColor: overlays.white10,
                  borderWidth: 1,
                  borderColor: overlays.white14,
                  borderRadius: 14,
                  paddingVertical: 6,
                  paddingLeft: 14,
                  paddingRight: 6,
                }}
              >
                <TextInput
                  value={typed}
                  onChangeText={setTyped}
                  placeholder={t('voix.typePlaceholder', { personality })}
                  placeholderTextColor={overlays.white50}
                  accessibilityLabel={t('voix.typePlaceholder', { personality })}
                  returnKeyType="send"
                  onSubmitEditing={submitTyped}
                  style={[
                    font('body'),
                    { flex: 1, padding: 0, minHeight: 38, color: colors.surface },
                  ]}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('voix.done', { personality })}
                  onPress={submitTyped}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    backgroundColor: overlays.white16,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <SendIcon color={colors.surface} size={16} />
                </Pressable>
              </View>
            ) : null}

            {error !== null ? (
              <Text
                accessibilityRole="alert"
                style={[
                  font('sub'),
                  { marginTop: 14, textAlign: 'center', color: semantic.dangerVivid },
                ]}
              >
                {error}
              </Text>
            ) : null}
          </View>

          {/* Pied : consigne + « C'est tout bon » */}
          <View style={{ paddingHorizontal: 24, paddingBottom: insets.bottom + 24 }}>
            <Text
              style={[
                font('sub'),
                { fontSize: 13, textAlign: 'center', color: overlays.white50, marginBottom: 16 },
              ]}
            >
              {t('voix.listenHint', { personality })}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('voix.done', { personality })}
              accessibilityState={{ disabled: transcript === '' }}
              disabled={transcript === ''}
              onPress={capture}
              style={({ pressed }) => ({
                backgroundColor: colors.surface,
                borderRadius: 16,
                paddingVertical: 15,
                alignItems: 'center',
                opacity: transcript === '' ? 0.55 : 1,
                transform: [{ scale: pressed ? 0.97 : 1 }],
              })}
            >
              <Text style={[font('button'), { color: colors.ink900 }]}>
                {t('voix.done', { personality })}
              </Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // ════════ ÉTAPE 3 — TERMINÉE (machine: 'terminee') ═══════════════════════════
  if (flow.step === 'terminee') {
    const totals = computeTotals([...flow.draft.lines]);
    const customer = customers.find((c) => c.id === flow.draft.customerId);
    const paid = flow.outcome === 'encaissee';
    return (
      <View style={{ flex: 1, backgroundColor: semantic.success }}>
        <LinearGradient
          pointerEvents="none"
          colors={[semantic.success, themes.foret.d1]}
          start={{ x: 0.45, y: 0 }}
          end={{ x: 0.55, y: 1 }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 }}>
          <View
            style={{
              width: 96,
              height: 96,
              borderRadius: 48,
              backgroundColor: colors.surface,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 26,
              ...shadowNative.e3,
            }}
          >
            <CheckIcon color={semantic.success} size={48} strokeWidth={2.6} />
          </View>
          <Text
            style={[
              font('screenH1'),
              { color: colors.surface, textAlign: 'center', marginBottom: 8 },
            ]}
          >
            {t(paid ? 'voix.doneTitlePaid' : 'voix.doneTitleSent', { personality })}
          </Text>
          <Text
            style={[
              font('body'),
              {
                fontSize: 15.5,
                lineHeight: 23,
                maxWidth: 300,
                textAlign: 'center',
                color: overlays.white70,
                marginBottom: 26,
              },
            ]}
          >
            {t(paid ? 'voix.donePaidText' : 'voix.doneSentText', {
              personality,
              params: {
                amount: formatEUR(totals.netToPay),
                number: issuedNumber ?? '—',
                name:
                  issuedCustomerName ??
                  customer?.name ??
                  t('voix.doneInvoiceLabel', { personality }),
              },
            })}
          </Text>

          {/* Preuves : numéro légal réel + compta à jour (écritures postées par les use cases). */}
          <View
            style={{
              flexDirection: 'row',
              gap: 22,
              backgroundColor: overlays.white10,
              borderWidth: 1,
              borderColor: overlays.white14,
              borderRadius: 16,
              paddingVertical: 14,
              paddingHorizontal: 18,
              marginBottom: 30,
            }}
          >
            <View>
              <Text style={[font('eyebrow'), { fontSize: 11, color: overlays.white60 }]}>
                {t('voix.doneInvoiceLabel', { personality })}
              </Text>
              <Text
                style={[
                  font('label', 600),
                  {
                    fontSize: 14,
                    color: colors.surface,
                    marginTop: 2,
                    fontVariant: ['tabular-nums'],
                  },
                ]}
              >
                {issuedNumber ?? '—'}
              </Text>
            </View>
            <View style={{ width: 1, backgroundColor: overlays.white14 }} />
            <View>
              <Text style={[font('eyebrow'), { fontSize: 11, color: overlays.white60 }]}>
                {t('voix.doneComptaLabel', { personality })}
              </Text>
              <Text
                style={[font('label', 600), { fontSize: 14, color: colors.surface, marginTop: 2 }]}
              >
                {t('voix.doneComptaValue', { personality })}
              </Text>
            </View>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('voix.finish', { personality })}
            onPress={() => router.replace('/(tabs)')}
            style={({ pressed }) => ({
              alignSelf: 'stretch',
              maxWidth: 320,
              backgroundColor: colors.surface,
              borderRadius: 16,
              paddingVertical: 15,
              alignItems: 'center',
              transform: [{ scale: pressed ? 0.97 : 1 }],
            })}
          >
            <Text style={[font('button'), { color: semantic.success }]}>
              {t('voix.finish', { personality })}
            </Text>
          </Pressable>
        </View>

        <Toast
          message={toast ?? ''}
          visible={toast !== null}
          onHide={() => setToast(null)}
          icon={<CheckIcon color={colors.surface} size={16} strokeWidth={2.4} />}
        />
      </View>
    );
  }

  // ════════ ÉTAPE 2 — REVUE (machine: 'revue') ═════════════════════════════════
  const lines = flow.draft.lines;
  const totals = computeTotals([...lines]);
  const customer = customers.find((c) => c.id === flow.draft.customerId) ?? null;
  const vatRows = Object.entries(totals.vatByRate);
  const progress = checkpoint !== null ? voiceInvoiceCheckpointProgress(checkpoint) : null;
  const checkpointFailed = checkpoint !== null && error !== null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Header : Reprendre (voiceRetry, brouillon conservé) + fermer */}
      <View
        style={{
          paddingTop: insets.top + 8,
          paddingHorizontal: 18,
          paddingBottom: 10,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(checkpoint !== null ? 'voix.resumeLocked' : 'voix.retry', {
            personality,
          })}
          accessibilityState={{ disabled: checkpoint !== null }}
          disabled={checkpoint !== null}
          onPress={retry}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            minHeight: 44,
            opacity: checkpoint !== null ? 0.45 : 1,
          }}
        >
          <ChevronLeftIcon color={colors.ink600} size={18} strokeWidth={2.2} />
          <Text style={[font('label', 600), { fontSize: 15, color: colors.ink600 }]}>
            {t(checkpoint !== null ? 'voix.resumeLocked' : 'voix.retry', { personality })}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('voix.close', { personality })}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => router.back()}
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: controls.segmentedTrack,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: busy ? 0.45 : 1,
          }}
        >
          <CloseIcon color={colors.slate500} size={15} />
        </Pressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* « Voilà ce que j'ai compris » — pill IA lavande */}
        <View
          style={{
            alignSelf: 'flex-start',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 7,
            backgroundColor: semantic.b2gBg,
            borderRadius: 20,
            paddingVertical: 6,
            paddingHorizontal: 12,
            marginBottom: 14,
          }}
        >
          <SparkSmallIcon color={semantic.ai} size={15} />
          <Text style={[font('label', 700), { fontSize: 13, color: semantic.ai }]}>
            {t('voix.reviewLead', { personality })}
          </Text>
        </View>
        <Text style={[font('screenH1'), { fontSize: 24, color: colors.ink900, marginBottom: 3 }]}>
          {t('voix.reviewTitle', { personality })}
        </Text>
        <Text style={[font('sub'), { color: colors.slate500, marginBottom: 18 }]}>
          {t('voix.reviewSub', { personality })}
        </Text>

        {progress !== null ? (
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={t('voix.resumeProgress', { personality })}
            accessibilityValue={{
              min: 0,
              max: progress.total,
              now: progress.completed,
              text: `${progress.completed} / ${progress.total}`,
            }}
            style={{ marginBottom: 16 }}
          >
            <Text style={[font('cardTitle'), { color: colors.ink900, marginBottom: 4 }]}>
              {t('voix.resumeTitle', { personality })}
            </Text>
            <Text
              style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginBottom: 10 }]}
            >
              {t('voix.resumeBody', { personality })}
            </Text>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 7,
              }}
            >
              <Text style={[font('meta'), { color: colors.slate500 }]}>
                {t('voix.resumeProgress', { personality })}
              </Text>
              <Text
                accessibilityLiveRegion="polite"
                style={[font('meta'), { color: colors.ink900, fontVariant: ['tabular-nums'] }]}
              >
                {progress.completed} / {progress.total}
              </Text>
            </View>
            <View
              style={{
                height: 6,
                borderRadius: 3,
                overflow: 'hidden',
                backgroundColor: colors.lineSoft,
              }}
            >
              <View
                style={{
                  width: `${Math.round((progress.completed / progress.total) * 100)}%`,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: semantic.success,
                }}
              />
            </View>
          </View>
        ) : null}

        {/* Facture pré-remplie — parties, lignes, totaux (Card @bob/ui) */}
        <Card radius={22} padding={18} elevation="e2">
          {customer !== null ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingBottom: 15,
                borderBottomWidth: 1,
                borderBottomColor: colors.lineSoft,
              }}
            >
              <Avatar name={customer.name} size={42} tone={CUSTOMER_TONE[customer.type]} />
              <View style={{ flex: 1 }}>
                <Text style={[font('cardTitle'), { fontSize: 15.5, color: colors.ink900 }]}>
                  {customer.name}
                </Text>
                {customer.siren !== null ? (
                  <Text
                    style={[font('meta'), { fontSize: 12.5, color: colors.slate400, marginTop: 1 }]}
                  >
                    {t('fiche.sirenLabel', { personality, params: { siren: customer.siren } })}
                  </Text>
                ) : null}
              </View>
              <StatusBadge
                label={t(CUSTOMER_BADGE[customer.type], { personality })}
                variant={CUSTOMER_TONE[customer.type]}
              />
            </View>
          ) : (
            <View
              style={{
                paddingBottom: 15,
                borderBottomWidth: 1,
                borderBottomColor: colors.lineSoft,
              }}
            >
              <Text style={[font('label'), { color: colors.slate500, marginBottom: 10 }]}>
                {t('voix.pickCustomer', { personality })}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {customers.map((c) => (
                  <Chip key={c.id} label={c.name} onPress={() => pickCustomer(c.id)} />
                ))}
              </View>
            </View>
          )}

          <View
            style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.lineSoft }}
          >
            {lines.map((line, i) => {
              const badge = CATEGORY_BADGE[line.category];
              return (
                <View
                  key={`${line.label}-${i}`}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    paddingVertical: 6,
                  }}
                >
                  <View style={{ flex: 1, paddingRight: 12, gap: 4 }}>
                    <Text style={[font('label', 600), { fontSize: 14, color: colors.ink900 }]}>
                      {line.label}
                    </Text>
                    {badge !== undefined ? (
                      <StatusBadge label={t(badge.key, { personality })} variant={badge.tone} />
                    ) : null}
                  </View>
                  <MoneyText cents={Math.round(line.qty * line.unitPriceHT)} />
                </View>
              );
            })}
          </View>

          <View style={{ paddingTop: 13 }}>
            <View
              style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}
            >
              <Text style={[font('sub'), { color: colors.slate500 }]}>
                {t('voix.totalHt', { personality })}
              </Text>
              <Text
                style={[font('sub'), { color: colors.slate500, fontVariant: ['tabular-nums'] }]}
              >
                {formatEUR(totals.ht)}
              </Text>
            </View>
            {vatRows.map(([rate, cents]) => (
              <View
                key={rate}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  paddingVertical: 3,
                }}
              >
                <Text style={[font('sub'), { color: colors.slate500 }]}>
                  {t('voix.vatRate', { personality, params: { rate } })}
                </Text>
                <Text
                  style={[font('sub'), { color: colors.slate500, fontVariant: ['tabular-nums'] }]}
                >
                  {formatEUR(cents)}
                </Text>
              </View>
            ))}
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginTop: 6,
                paddingTop: 9,
                borderTopWidth: 1,
                borderTopColor: colors.lineSoft,
              }}
            >
              <Text style={[font('cardTitle'), { color: colors.ink900 }]}>
                {t('voix.totalTtc', { personality })}
              </Text>
              <MoneyText cents={totals.ttc} variant="big" />
            </View>
          </View>
        </Card>

        {/* Ce que Bob a entendu — trace honnête du transcript. */}
        {flow.draft.transcript !== null ? (
          <Text style={[font('meta'), { color: colors.slate400, marginTop: 12, lineHeight: 18 }]}>
            « {flow.draft.transcript} »
          </Text>
        ) : null}

        {error !== null ? (
          checkpoint !== null ? (
            <View style={{ marginTop: 14 }}>
              <ErrorRetry message={error} onRetry={() => void onOutcome(checkpoint.outcome)} />
            </View>
          ) : (
            <Card style={{ marginTop: 14, borderColor: semantic.danger }}>
              <Text accessibilityRole="alert" style={[font('sub'), { color: semantic.danger }]}>
                {error}
              </Text>
            </Card>
          )
        ) : null}
      </ScrollView>

      {/* Issue — Encaisser (vert, montant réel) vs Envoyer : confirmation explicite ensuite. */}
      <View
        style={{
          paddingHorizontal: 18,
          paddingTop: 10,
          paddingBottom: insets.bottom + 16,
          gap: 10,
        }}
      >
        {checkpoint?.outcome !== 'envoyee' && !checkpointFailed ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('voix.collectCta', {
              personality,
              params: { amount: formatEUR(totals.netToPay) },
            })}
            accessibilityState={{ disabled: busy, busy }}
            disabled={busy}
            onPress={() => void onOutcome('encaissee')}
            style={({ pressed }) => ({
              borderRadius: 16,
              overflow: 'hidden',
              opacity: busy ? 0.7 : 1,
              transform: [{ scale: pressed && !busy ? 0.97 : 1 }],
              shadowColor: semantic.success,
              shadowOpacity: 0.3,
              shadowRadius: 24,
              shadowOffset: { width: 0, height: 10 },
              elevation: 8,
            })}
          >
            <LinearGradient
              colors={[semantic.success, themes.foret.d2]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{
                minHeight: 54,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 9,
                paddingHorizontal: 16,
              }}
            >
              {busy ? (
                <ActivityIndicator size="small" color={colors.surface} />
              ) : (
                <WalletIcon color={colors.surface} size={20} strokeWidth={2} />
              )}
              <Text style={[font('button'), { fontSize: 16.5, color: colors.surface }]}>
                {t('voix.collectCta', {
                  personality,
                  params: { amount: formatEUR(totals.netToPay) },
                })}
              </Text>
            </LinearGradient>
          </Pressable>
        ) : null}
        {checkpoint?.outcome !== 'encaissee' && !checkpointFailed ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('voix.sendCta', { personality })}
            accessibilityState={{ disabled: busy, busy }}
            disabled={busy}
            onPress={() => void onOutcome('envoyee')}
            style={({ pressed }) => ({
              minHeight: 50,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 9,
              backgroundColor: colors.surface,
              borderWidth: 1,
              borderColor: colors.line,
              borderRadius: 16,
              opacity: busy ? 0.7 : 1,
              transform: [{ scale: pressed && !busy ? 0.97 : 1 }],
            })}
          >
            <SendIcon color={colors.ink900} size={18} strokeWidth={2} />
            <Text style={[font('label', 600), { fontSize: 15, color: colors.ink900 }]}>
              {t('voix.sendCta', { personality })}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

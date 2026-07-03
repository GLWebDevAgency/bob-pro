/**
 * Facture à la voix — flux 3 étapes (claim C20, réfs claims/ref/C20-frame-p1/p2.png).
 * PILOTÉ par la machine RÉELLE @bob/core flows/voice-invoice (C02) : startVoiceInvoice →
 * voiceCaptured (écoute → revue) → voiceRetry (revue → écoute, brouillon conservé) →
 * voiceConfirm (revue → terminée, confirmation EXPLICITE — préparer ≠ envoyer). Aucune
 * duplication : chaque changement d'étape passe par une transition de la machine.
 *
 * ÉCOUTE (fond navy) : orbe micro verte + onde 7 barres — TOUJOURS animées, jamais
 * d'opacity-0 au repos (charte §4.7) — branchées sur le pipeline STT réel data/voice
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
 * les CTA manuels, challengeFor amount/fiscal) → MÊME chaîne de use cases que l'UI
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
import { Avatar, Card, Chip, MoneyText, StatusBadge, Toast, font, useTheme, type StatusBadgeVariant } from '@bob/ui';
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

/** Onde 7 barres (proto §showVoice) — TOUJOURS animée : respiration douce au repos, pleine
 *  amplitude en écoute. Les barres ne descendent jamais sous 30 % (charte §4.7 : pas d'opacity-0). */
function WaveBars({ active }: { active: boolean }) {
  const { semantic } = useTheme();
  const bars = useRef([0, 1, 2, 3, 4, 5, 6].map(() => new Animated.Value(0))).current;

  useEffect(() => {
    const loops = bars.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 110),
          Animated.timing(v, { toValue: 1, duration: 420, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: 420, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
          Animated.delay((bars.length - 1 - i) * 70),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [bars]);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 30 }}>
      {bars.map((v, i) => (
        <Animated.View
          key={i}
          style={{
            width: 5,
            height: 30,
            borderRadius: 3,
            backgroundColor: semantic.successOnDark,
            transform: [
              { scaleY: v.interpolate({ inputRange: [0, 1], outputRange: active ? [0.35, 1] : [0.3, 0.5] }) },
            ],
          }}
        />
      ))}
    </View>
  );
}

/** Orbe micro verte : respiration continue + anneaux d'onde pendant l'écoute (Animated natif). */
function MicOrb({ listening, onPress, label }: { listening: boolean; onPress: () => void; label: string }) {
  const { colors, semantic, overlays } = useTheme();
  const breathe = useRef(new Animated.Value(0)).current;
  const rings = useRef([new Animated.Value(0), new Animated.Value(0)]).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(breathe, { toValue: 0, duration: 1500, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breathe]);

  useEffect(() => {
    if (!listening) {
      rings.forEach((r) => r.setValue(0));
      return;
    }
    const loops = rings.map((r, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 700),
          Animated.timing(r, { toValue: 1, duration: 1900, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [listening, rings]);

  const scale = breathe.interpolate({ inputRange: [0, 1], outputRange: listening ? [1, 1.08] : [0.98, 1.03] });

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: listening }}
      style={{ width: 168, height: 168, alignItems: 'center', justifyContent: 'center' }}
    >
      {listening
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
                transform: [{ scale: r.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] }) }],
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
  const { data: customers } = useCustomers();
  const { data: profile } = useProfile();
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
  const [method, setMethod] = useState<PaymentMethod>('transfer');
  const [issuedNumber, setIssuedNumber] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

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
    const derived = deriveVoiceInvoiceDraft({
      transcript,
      customers: customers ?? [],
      ...(profile ? { defaultVatRate: profile.defaultVatRate } : {}),
    });
    const next = voiceCaptured(flow, derived.draft);
    if (!next.ok) {
      setError(t(next.error.code === 'VALIDATION' ? 'voix.errNoLines' : 'voix.errAction', { personality }));
      return;
    }
    setMethod(derived.paymentMethod);
    setError(null);
    setFlow(next.value);
  };

  /** Correction : retour à l'écoute — la machine conserve le brouillon (voiceRetry). */
  const retry = (): void => {
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
    if (busy) return;
    const { customerId, lines } = flow.draft;
    if (customerId === null) {
      setError(t('voix.errNoCustomer', { personality }));
      return;
    }
    const customer = (customers ?? []).find((c) => c.id === customerId);
    const name = customer?.name ?? 'le client';
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
      const created = await createQuote.mutateAsync({ customerId, lines: [...lines] });
      await sendQuote.mutateAsync(created.quoteId);
      await signQuote.mutateAsync({ quoteId: created.quoteId, signerName: name }); // signature sur place (devis/new)
      const generated = await generateInvoice.mutateAsync({ quoteId: created.quoteId, mode: 'final' });
      const issued = await issueInvoice.mutateAsync(generated.invoiceId);
      if (outcome === 'encaissee') {
        await registerPayment.mutateAsync({
          invoiceId: generated.invoiceId,
          amount: totals.netToPay,
          method,
          idempotencyKey: `mobile-voice:payment:${generated.invoiceId}:${totals.netToPay}:${method}`,
        });
      }
      const done = voiceConfirm(flow, outcome);
      if (!done.ok) {
        setError(t('voix.errAction', { personality }));
        return;
      }
      setIssuedNumber(issued.number);
      setFlow(done.value);
      setToast(
        outcome === 'encaissee'
          ? t('voix.toastPaid', { personality, params: { amount } })
          : t('voix.toastSent', { personality, params: { number: issued.number } }),
      );
    } catch (e) {
      setError(appErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

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
        <KeyboardAvoidingView style={{ flex: 1 }} {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}>
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
              hitSlop={6}
              style={{
                width: 34,
                height: 34,
                borderRadius: 17,
                backgroundColor: overlays.white10,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <CloseIcon color={colors.surface} size={16} />
            </Pressable>
          </View>

          {/* Orbe + onde + transcription */}
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 }}>
            <MicOrb listening={listening} onPress={toggleMic} label={t('voix.title', { personality })} />
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
                  style={[font('body'), { flex: 1, padding: 0, minHeight: 38, color: colors.surface }]}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('voix.done', { personality })}
                  onPress={submitTyped}
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 10,
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
              <Text style={[font('sub'), { marginTop: 14, textAlign: 'center', color: semantic.dangerVivid }]}>
                {error}
              </Text>
            ) : null}
          </View>

          {/* Pied : consigne + « C'est tout bon » */}
          <View style={{ paddingHorizontal: 24, paddingBottom: insets.bottom + 24 }}>
            <Text style={[font('sub'), { fontSize: 13, textAlign: 'center', color: overlays.white50, marginBottom: 16 }]}>
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
              <Text style={[font('button'), { color: colors.ink900 }]}>{t('voix.done', { personality })}</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </View>
    );
  }

  // ════════ ÉTAPE 3 — TERMINÉE (machine: 'terminee') ═══════════════════════════
  if (flow.step === 'terminee') {
    const totals = computeTotals([...flow.draft.lines]);
    const customer = (customers ?? []).find((c) => c.id === flow.draft.customerId);
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
          <Text style={[font('screenH1'), { color: colors.surface, textAlign: 'center', marginBottom: 8 }]}>
            {t(paid ? 'voix.doneTitlePaid' : 'voix.doneTitleSent', { personality })}
          </Text>
          <Text
            style={[
              font('body'),
              { fontSize: 15.5, lineHeight: 23, maxWidth: 300, textAlign: 'center', color: overlays.white70, marginBottom: 26 },
            ]}
          >
            {t(paid ? 'voix.donePaidText' : 'voix.doneSentText', {
              personality,
              params: {
                amount: formatEUR(totals.netToPay),
                number: issuedNumber ?? '—',
                name: customer?.name ?? 'le client',
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
              <Text style={[font('label', 600), { fontSize: 14, color: colors.surface, marginTop: 2, fontVariant: ['tabular-nums'] }]}>
                {issuedNumber ?? '—'}
              </Text>
            </View>
            <View style={{ width: 1, backgroundColor: overlays.white14 }} />
            <View>
              <Text style={[font('eyebrow'), { fontSize: 11, color: overlays.white60 }]}>
                {t('voix.doneComptaLabel', { personality })}
              </Text>
              <Text style={[font('label', 600), { fontSize: 14, color: colors.surface, marginTop: 2 }]}>
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
            <Text style={[font('button'), { color: semantic.success }]}>{t('voix.finish', { personality })}</Text>
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
  const customer = (customers ?? []).find((c) => c.id === flow.draft.customerId) ?? null;
  const vatRows = Object.entries(totals.vatByRate);

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
          accessibilityLabel={t('voix.retry', { personality })}
          onPress={retry}
          hitSlop={6}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44 }}
        >
          <ChevronLeftIcon color={colors.ink600} size={18} strokeWidth={2.2} />
          <Text style={[font('label', 600), { fontSize: 15, color: colors.ink600 }]}>
            {t('voix.retry', { personality })}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('voix.close', { personality })}
          onPress={() => router.back()}
          hitSlop={6}
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            backgroundColor: controls.segmentedTrack,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <CloseIcon color={colors.slate500} size={15} />
        </Pressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
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
                <Text style={[font('cardTitle'), { fontSize: 15.5, color: colors.ink900 }]}>{customer.name}</Text>
                {customer.siren !== null ? (
                  <Text style={[font('meta'), { fontSize: 12.5, color: colors.slate400, marginTop: 1 }]}>
                    {t('fiche.sirenLabel', { personality, params: { siren: customer.siren } })}
                  </Text>
                ) : null}
              </View>
              <StatusBadge label={t(CUSTOMER_BADGE[customer.type], { personality })} variant={CUSTOMER_TONE[customer.type]} />
            </View>
          ) : (
            <View style={{ paddingBottom: 15, borderBottomWidth: 1, borderBottomColor: colors.lineSoft }}>
              <Text style={[font('label'), { color: colors.slate500, marginBottom: 10 }]}>
                {t('voix.pickCustomer', { personality })}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {(customers ?? []).map((c) => (
                  <Chip key={c.id} label={c.name} onPress={() => pickCustomer(c.id)} />
                ))}
              </View>
            </View>
          )}

          <View style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.lineSoft }}>
            {lines.map((line, i) => {
              const badge = CATEGORY_BADGE[line.category];
              return (
                <View
                  key={`${line.label}-${i}`}
                  style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingVertical: 6 }}
                >
                  <View style={{ flex: 1, paddingRight: 12, gap: 4 }}>
                    <Text style={[font('label', 600), { fontSize: 14, color: colors.ink900 }]}>{line.label}</Text>
                    {badge !== undefined ? <StatusBadge label={t(badge.key, { personality })} variant={badge.tone} /> : null}
                  </View>
                  <MoneyText cents={Math.round(line.qty * line.unitPriceHT)} />
                </View>
              );
            })}
          </View>

          <View style={{ paddingTop: 13 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
              <Text style={[font('sub'), { color: colors.slate500 }]}>{t('voix.totalHt', { personality })}</Text>
              <Text style={[font('sub'), { color: colors.slate500, fontVariant: ['tabular-nums'] }]}>
                {formatEUR(totals.ht)}
              </Text>
            </View>
            {vatRows.map(([rate, cents]) => (
              <View key={rate} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                <Text style={[font('sub'), { color: colors.slate500 }]}>
                  {t('voix.vatRate', { personality, params: { rate } })}
                </Text>
                <Text style={[font('sub'), { color: colors.slate500, fontVariant: ['tabular-nums'] }]}>
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
              <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{t('voix.totalTtc', { personality })}</Text>
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
          <Card style={{ marginTop: 14, borderColor: semantic.danger }}>
            <Text style={[font('sub'), { color: semantic.danger }]}>{error}</Text>
          </Card>
        ) : null}
      </ScrollView>

      {/* Issue — Encaisser (vert, montant réel) vs Envoyer : confirmation explicite ensuite. */}
      <View style={{ paddingHorizontal: 18, paddingTop: 10, paddingBottom: insets.bottom + 16, gap: 10 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('voix.collectCta', { personality, params: { amount: formatEUR(totals.netToPay) } })}
          accessibilityState={{ disabled: busy }}
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
              {t('voix.collectCta', { personality, params: { amount: formatEUR(totals.netToPay) } })}
            </Text>
          </LinearGradient>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('voix.sendCta', { personality })}
          accessibilityState={{ disabled: busy }}
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
      </View>
    </View>
  );
}

/**
 * Assistant — Bob (claim C15, réf claims/ref/C15-frame.png, directive parité [23:52]).
 * Composition 100 % @bob/ui + tokens : header « Bob · en ligne » (avatar étincelle
 * dégradé IA, pill statut, sous-titre assistant.subtitle) → fil de chat (bulle
 * d'accueil voix Bob, bulles user/Bob, indicateur de saisie 3 points animés, cartes
 * d'action avec aperçu avant/après + Valider/Annuler) → chips suggestions du proto →
 * input « Demande-moi un truc… » + contrôle live générique + envoi. L'ancien wizard spécialisé
 * « Facture à la voix » n'est plus exposé : Bob est l'unique conversation universelle.
 *
 * BRANCHEMENT 100 % RÉEL (couche présentation refaite, transport conservé) : le fil
 * parle au VRAI agent — makeBobAgent(client) → BobAgent (@bob/ai : intents, autonomie,
 * confirmations, garde-fous) dont les ACTIONS délèguent au BobClient (mêmes use cases
 * que les CTA d'écrans — jamais un chemin parallèle). Les actions sensibles reviennent
 * en `proposed` : carte d'action avec diff (buildActionDiff + aperçu comptable réel via
 * invoiceAccountingPreview) et exécution UNIQUEMENT via agent.confirm (préparer ≠ envoyer).
 * Le binaire passe toujours par l'agent serveur ; aucun routeur local ni jeu de données de
 * démonstration n'est embarqué comme voie de repli.
 *
 * ?prompt=relance | relance_devis (edges C10/C11/C13) : pré-remplit puis SOUMET la
 * demande correspondante (commande canonique @bob/i18n — matche detectIntent).
 *
 * États : abonnement sans ai_assistant → garde honnête (l'app reste utilisable à la
 * main) · erreur → voix de Bob (assistant.error/actionError) · serveur injoignable
 * (kind dependency) → assistant.offline + pill « hors ligne » · réflexion → phase
 * RÉELLE de l'agent (onPhase comprends/agit) sur l'indicateur de saisie · tap Live sans
 * droit voice_live → teaser contextuel PaywallCard (source voice_live_tap, sourdine
 * respectée — fondation src/monetization/paywall, SPEC_PILIER2_MONETISATION).
 *
 * Écarts assumés vs réf/ancien écran :
 * · le mode vocal mains-libres partage désormais le lease STT global ; au blur, l'owner local
 *   libère l'oreille et l'accès Bob racine prend le relais sans double écoute ;
 * · badges « plan · modèle » de l'ancien écran non repris (le proto n'affiche pas de
 *   télémétrie — choix produit ThinkingIndicator conservé) ;
 * · dégradés via tokens (conformityCard.bgTop→bg · ai→indigo.d2), pas les hex du proto ;
 * · chip « Prêt pour 2026 ? » → garde-fou de Bob (aucun intent diagnostic côté agent —
 *   TODO tracé dans l'audit de parité C15).
 * Zéro hex/rgba. Zéro import de src/components/ui — ActionDiffView (composant d'action
 * métier, autorisé au contrat) rend l'aperçu avant/après partagé avec le flux manuel.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
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
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  echoOverlap,
  isAllowedAgentNavigationRoute,
  parseBargeIn,
  speechWordCount,
  parseVoiceChoice,
  parseVoiceConsent,
  speakableQuestion,
  type AccountingLine,
  type AgentQuestion,
  type AgentRun,
  type BobIntent,
  type PendingAction,
} from '@bob/ai';
import { PLAN_CATALOG, type AppError, type PaywallDecision } from '@bob/core';
import { conformityCard, patterns, shadowNative, themes } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import { Button, Chip, ErrorRetry, QuestionSheet, Skeleton, font, useReduceMotion, useTheme } from '@bob/ui';
import { useBobClient } from '../../src/data/client';
import { useInvoices, useQuotes, useSubscription } from '../../src/data/hooks';
import { PaywallCard, isPaywallMuted, useEntitlement } from '../../src/monetization/paywall';
import { makeBobAgent } from '../../src/data/bob';
import { getAutonomy } from '../../src/data/settings';
import { speechRecognitionAvailable, useSpeak, useVoiceInput } from '../../src/data/voice';
import { ActionDiffView } from '../../src/components/ActionDiffView';
import { SendIcon, SparkIcon } from '../../src/components/icons';
import { useAgentSession } from '../../src/agent';
import {
  derivePendingPreview,
  type PendingPreviewState,
} from '../../src/assistant/pending-preview';

interface ChatItem {
  readonly id: string;
  readonly role: 'user' | 'bob';
  readonly text: string;
  readonly run?: AgentRun;
  /** Action proposée en attente de Valider/Annuler (consommée à la décision). */
  readonly pending?: PendingAction;
  /** Écriture comptable prévisionnelle (émission), chargée en asynchrone (best-effort). */
  readonly accountingLines?: readonly AccountingLine[];
}

/** Chips suggestions (proto §isAssistant) — chaque tap = une VRAIE requête agent. */
const SUGGESTION_CHIPS: readonly I18nKey[] = [
  'assistant.chipRelance',
  'assistant.chipPayout',
  'assistant.chipMonth',
  'assistant.chipDiag',
];

/** ?prompt=… → commande canonique (edges C10/C11/C13 — parité d'actions [23:52]). */
const ENTRY_PROMPTS: Readonly<Partial<Record<string, I18nKey>>> = {
  relance: 'assistant.chipRelance',
  relance_devis: 'assistant.cmdRelanceQuote',
  // ASK-1 : entrée « encaisser » SANS référence — Bob pose la question structurée (laquelle ?).
  encaisser: 'assistant.cmdCollectOpen',
  // ASK-2 : facturer un devis signé — Bob demande lequel, puis acompte ou solde.
  facturer_devis: 'assistant.cmdInvoiceQuote',
};

/** Chips de désambiguïsation → commande de suivi par intent ({ref} = numéro de pièce). */
const CMD_BY_INTENT: Readonly<Partial<Record<BobIntent, I18nKey>>> = {
  envoyer_devis: 'assistant.cmdSendQuote',
  emettre_facture: 'assistant.cmdIssue',
  encaisser: 'assistant.cmdCollect',
};

/** Pill flottante §14 : item 44 + 2×8 de padding + bordure — pour caler le dock au-dessus. */
const TAB_PILL_HEIGHT = 62;

/** Indicateur de saisie — 3 points qui ondulent (proto cpGlow) + phase RÉELLE de l'agent. */
function TypingBubble({ phase }: { phase: string | null }) {
  const { colors, controls, personality } = useTheme();
  const reduceMotion = useReduceMotion();
  const dots = useRef([
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]).current;

  useEffect(() => {
    if (reduceMotion) {
      dots.forEach((dot) => dot.setValue(0.55));
      return;
    }
    const loops = dots.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 180),
          Animated.timing(v, {
            toValue: 1,
            duration: 360,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(v, {
            toValue: 0,
            duration: 360,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.delay((dots.length - 1 - i) * 180),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [dots, reduceMotion]);

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={phase ?? t('assistant.thinking', { personality })}
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: colors.surface,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: controls.cardBorder,
        paddingVertical: 14,
        paddingHorizontal: 16,
        ...shadowNative.e1,
      }}
    >
      {phase !== null ? (
        <Text style={[font('meta'), { color: colors.slate400 }]}>{phase}</Text>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 5 }}>
        {dots.map((v, i) => (
          <Animated.View
            key={i}
            style={{
              width: 7,
              height: 7,
              borderRadius: 4,
              backgroundColor: colors.slate300,
              opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
              transform: [
                { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }) },
              ],
            }}
          />
        ))}
      </View>
    </View>
  );
}

/** Chip suggestion du proto (blanc, bord lavande, texte indigo) — pas le Chip filtre @bob/ui. */
function SuggestionChip({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
}) {
  const { colors, semantic } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: conformityCard.border,
        borderRadius: 20,
        minHeight: 44,
        justifyContent: 'center',
        paddingVertical: 9,
        paddingHorizontal: 14,
        opacity: disabled ? 0.55 : 1,
        transform: [{ scale: pressed ? 0.96 : 1 }],
      })}
    >
      <Text style={[font('label'), { fontSize: 13, color: semantic.ai }]}>{label}</Text>
    </Pressable>
  );
}

/** Bulle de Bob (surface, ombre douce) — porte texte, carte d'action, chips de choix. */
function BobBubble({ children }: { children: ReactNode }) {
  const { colors, controls } = useTheme();
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        maxWidth: '90%',
        backgroundColor: colors.surface,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: controls.cardBorder,
        paddingVertical: 13,
        paddingHorizontal: 15,
        ...shadowNative.e1,
      }}
    >
      {children}
    </View>
  );
}

export default function Assistant() {
  const { colors, semantic, controls, theme, personality } = useTheme();
  const reduceMotion = useReduceMotion();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const client = useBobClient();
  const agent = useMemo(() => makeBobAgent(client), [client]);
  const globalSession = useAgentSession();
  // Entitlements TYPÉS (fondation paywall) : l'assistant lui-même (ai_assistant, gating
  // historique de l'écran) et BOB LIVE (voice_live — le serveur reste l'arbitre du realtime,
  // ici on décide seulement du TEASER quand le tap n'ouvre aucun droit).
  const assistantEntitlement = useEntitlement('ai_assistant');
  const liveEntitlement = useEntitlement('voice_live');
  const subscriptionQuery = useSubscription();
  const invoicesQuery = useInvoices();
  const quotesQuery = useQuotes();
  const { prompt } = useLocalSearchParams<{ prompt?: string }>();
  const entitled = assistantEntitlement.allowed;

  const [items, setItems] = useState<ChatItem[]>([]);
  const itemsRef = useRef<ChatItem[]>([]);
  itemsRef.current = items;
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  // Inconnu tant qu'aucun aller-retour agent n'a réussi/échoué : ne jamais afficher « en ligne »
  // comme une donnée de santé inventée au premier rendu.
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [assistantFocused, setAssistantFocused] = useState(false);
  /** ASK-1 : question structurée active (modale) — ouverte automatiquement à l'arrivée du run. */
  const [activeAsk, setActiveAsk] = useState<AgentQuestion | null>(null);
  /** TEASER BOB LIVE : décision de déblocage affichée après un tap Live sans droit voice_live. */
  const [livePaywall, setLivePaywall] = useState<PaywallDecision | null>(null);
  const inputRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);
  const handoffContextRef = useRef<{
    readonly context: NonNullable<typeof globalSession.handoff>['context'];
    readonly expiresAt: number;
  } | null>(null);
  const globalHandoffRef = useRef(globalSession.handoff);
  globalHandoffRef.current = globalSession.handoff;
  const consumedHandoffIdRef = useRef<string | null>(null);
  const submittedPrompt = useRef<string | null>(null);
  const counter = useRef(0);
  const nextId = (): string => {
    counter.current += 1;
    return `m-${counter.current}`;
  };

  const pushText = (role: ChatItem['role'], text: string): void => {
    setItems((prev) => [...prev, { id: nextId(), role, text }]);
  };

  /** Voix de Bob en échec : serveur injoignable (dependency) ≠ traitement raté. */
  const failText = (error: AppError, actionKey: I18nKey): string => {
    if (error.kind === 'dependency') {
      setReachable(false);
      return t('assistant.offline', { personality });
    }
    return t(actionKey, { personality });
  };

  const refreshAfterAction = (): void => {
    void qc.invalidateQueries({ queryKey: ['invoices'] });
    void qc.invalidateQueries({ queryKey: ['quotes'] });
    void qc.invalidateQueries({ queryKey: ['customers'] });
    void qc.invalidateQueries({ queryKey: ['cashflow'] });
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  };

  /**
   * Aperçu avant/après de l'action proposée — la « preuve » avant Valider, calculée
   * depuis l'action + les pièces réelles (même buildActionDiff que la ConfirmSheet).
   */
  const pendingPreview = (
    pending: PendingAction,
    accountingLines?: readonly AccountingLine[],
  ): PendingPreviewState =>
    derivePendingPreview({
      pending,
      invoices: invoicesQuery,
      quotes: quotesQuery,
      ...(accountingLines !== undefined ? { accountingLines } : {}),
    });

  const retryPendingPreview = (pending: PendingAction): void => {
    if (pending.tool === 'envoyer_devis') void quotesQuery.refetch();
    if (pending.tool === 'encaisser_facture' || pending.tool === 'emettre_facture') {
      void invoicesQuery.refetch();
    }
  };

  const pushRun = (run: AgentRun): ChatItem => {
    const id = nextId();
    const pending = run.kind === 'proposed' ? run.pending : undefined;
    // LIVE-2 : la reformulation naturelle (gardée par les faits) prime sur le gabarit.
    const item: ChatItem = {
      id,
      role: 'bob',
      text: run.naturalBody ?? run.card.body,
      run,
      ...(pending ? { pending } : {}),
    };
    setItems((prev) => [...prev, item]);
    if (run.kind === 'done') refreshAfterAction();
    // Même allowlist fail-closed que l'overlay : une réponse HTTP ne choisit jamais une URL libre.
    if (isAllowedAgentNavigationRoute(run.navigate)) router.push(run.navigate as never);
    if (run.ask?.length) setActiveAsk(run.ask[0] ?? null); // ASK-1 : la question s'ouvre d'elle-même

    // Émission : enrichit l'aperçu avec l'écriture comptable prévisionnelle RÉELLE (async, best-effort).
    const invId =
      pending?.tool === 'emettre_facture' && typeof pending.args.invoiceId === 'string'
        ? pending.args.invoiceId
        : null;
    if (invId) {
      void client
        .invoiceAccountingPreview(invId)
        .then((r) => {
          if (r.ok && r.value.available && r.value.lines.length) {
            const lines = r.value.lines;
            setItems((prev) =>
              prev.map((it) => (it.id === id ? { ...it, accountingLines: lines } : it)),
            );
          }
        })
        .catch(() => {
          /* aperçu comptable best-effort : silencieux si indisponible */
        });
    }
    return item;
  };

  /** Handoff Realtime : le serveur rend uniquement le PendingAction owner-bound. On l'insère
   * dans la même carte et le même flux confirm/cancel que toute proposition manuelle. */
  const pushProposalPreview = (pending: PendingAction, text: string): ChatItem => {
    const id = nextId();
    const item: ChatItem = { id, role: 'bob', text, pending };
    setItems((prev) => [...prev, item]);
    const invoiceId =
      pending.tool === 'emettre_facture' && typeof pending.args.invoiceId === 'string'
        ? pending.args.invoiceId
        : null;
    if (invoiceId) {
      void client.invoiceAccountingPreview(invoiceId).then((result) => {
        if (!result.ok || !result.value.available || result.value.lines.length === 0) return;
        const accountingLines = result.value.lines;
        setItems((prev) => prev.map((candidate) => (
          candidate.id === id
            ? { ...candidate, accountingLines }
            : candidate
        )));
      }).catch(() => undefined);
    }
    return item;
  };
  // Les effets de handoff appellent toujours les mutateurs de la dernière render sans les
  // rendre dépendants de fonctions recréées à chaque render (et sans désactiver une règle lint).
  const pushTextRef = useRef(pushText);
  pushTextRef.current = pushText;
  const pushRunRef = useRef(pushRun);
  pushRunRef.current = pushRun;
  const pushProposalPreviewRef = useRef(pushProposalPreview);
  pushProposalPreviewRef.current = pushProposalPreview;

  const ask = async (raw: string): Promise<{ run: AgentRun; item: ChatItem } | null> => {
    const message = raw.trim();
    if (!message || busy || !assistantEntitlement.verified || !entitled) return null;
    setInput('');
    pushText('user', message);
    setBusy(true);
    const autonomy = await getAutonomy(); // politique de confirmation RÉELLE (runtime @bob/ai)
    // LIVE-2 : mémoire de conversation courte (anaphores) + humeur — expurgées côté agent.
    const history = itemsRef.current.slice(-6).map((it) => ({ role: it.role, text: it.text }));
    const inheritedContext = handoffContextRef.current;
    if (inheritedContext !== null && inheritedContext.expiresAt <= Date.now()) {
      handoffContextRef.current = null;
    }
    const r = await agent.ask(message, {
      autonomy,
      history,
      tone: personality,
      ...(handoffContextRef.current !== null ? { context: handoffContextRef.current.context } : {}),
      onPhase: (p) =>
        setPhase(
          t(p === 'comprends' ? 'assistant.phaseUnderstand' : 'assistant.phaseAct', {
            personality,
          }),
        ),
    });
    setBusy(false);
    setPhase(null);
    if (r.ok) {
      setReachable(true);
      return { run: r.value, item: pushRun(r.value) };
    }
    pushText('bob', failText(r.error, 'assistant.error'));
    return null;
  };
  const askRef = useRef(ask);
  askRef.current = ask;

  /** ASK-1 : réponse à la question structurée — l'agent a fourni la commande de suivi,
   * l'UI ne reconstruit JAMAIS une phrase (multi : template {values} joint par « , »). */
  const answerAsk = (values: string[]): void => {
    const q = activeAsk;
    setActiveAsk(null);
    if (!q || values.length === 0) return;
    if (q.multiSelect && q.followUpTemplate) {
      void ask(q.followUpTemplate.replace('{values}', values.join(', ')));
      return;
    }
    const picked = q.options.find((o) => o.value === values[0]);
    if (picked) {
      // En mode live, la réponse (tap OU voix) relance la boucle : Bob vocalise la suite.
      if (liveRef.current) void ask(picked.followUp).then((res) => liveTurn(res));
      else void ask(picked.followUp);
    }
  };

  // ── LIVE-0/1 : boucle vocale mains-libres, synchronisée avec l'écran ─────────────────
  // Semi-duplex : Bob écoute (fin de parole native) → réfléchit (agent) → parle (TTS) →
  // ré-écoute. Les QUESTIONS structurées sont LUES (labels courts) et la réponse vocale
  // (« le deuxième », « Lefèvre ») est résolue en fail-safe (parseVoiceChoice) — l'écran
  // reste tappable à tout moment, même résultat. Les actions sensibles gardent leur
  // plancher : consentement EXPLICITE (parseVoiceConsent), jamais d'exécution ambiguë.
  const [live, setLive] = useState(false);
  const [liveState, setLiveState] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>(
    'idle',
  );
  const liveRef = useRef(false);
  liveRef.current = live;
  const liveStateRef = useRef(liveState);
  liveStateRef.current = liveState;
  /** Ce que Bob est en train de dire — la référence de l'echo-guard (LIVE-3). */
  const speakingTextRef = useRef('');
  /** Dernier énoncé TERMINÉ + horodatage : sur device réel (sans annulation d'écho
   * matérielle), la reco capte la fin du TTS APRÈS la bascule en écoute — la fenêtre de
   * grâce échoscanne TOUT transcript, quelle que soit la phase (fix boucle d'écho). */
  const lastSpokenRef = useRef<{ text: string; endedAt: number }>({ text: '', endedAt: 0 });
  const ECHO_GRACE_MS = 5000;
  /** Disjoncteur : 3 échos ignorés d'affilée → repos (l'orbe se relance au tap). */
  const echoStreakRef = useRef(0);

  /** Référence d'écho active : l'énoncé en cours, ou le dernier fini s'il est récent. */
  const echoReference = (): string => {
    if (speakingTextRef.current) return speakingTextRef.current;
    const { text, endedAt } = lastSpokenRef.current;
    return Date.now() - endedAt < ECHO_GRACE_MS ? text : '';
  };
  // Ce que l'oreille attend : une commande libre, une réponse à une question, un consentement.
  const expectationRef = useRef<
    | { kind: 'command' }
    | { kind: 'choice'; question: AgentQuestion; retried: boolean }
    | { kind: 'consent'; item: ChatItem; retried: boolean }
  >({ kind: 'command' });
  const { speakAndWait, stopSpeaking } = useSpeak();

  const voice = useVoiceInput(
    (text) => {
      if (liveRef.current) void onLiveTranscript(text);
      else setInput(text);
    },
    {
      onIssue: () => setLiveState('idle'),
      // LIVE-3 : pendant que Bob PARLE, un partiel qui n'est ni son propre écho ni un
      // borborygme le fait taire — la suite (final) est traitée par le flux normal.
      onPartial: (partial) => {
        if (!liveRef.current || liveStateRef.current !== 'speaking') return;
        if (parseBargeIn(partial, speakingTextRef.current) !== 'echo') stopSpeaking();
      },
    },
  );
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  // Un tab peut rester monte sous une route Stack. Au blur, l'owner local rend toujours le
  // lease STT : jamais de micro cache ni de concurrence avec l'acces Bob global.
  useFocusEffect(
    useCallback(() => {
      setAssistantFocused(true);
      return () => {
        setAssistantFocused(false);
        // Le contexte hérité appartient au fil ouvert depuis l'overlay, pas aux futures
        // visites de l'onglet Assistant après navigation ailleurs.
        handoffContextRef.current = null;
        if (!liveRef.current) return;
        liveRef.current = false;
        setLive(false);
        stopSpeaking();
        void voiceRef.current.cancel();
        setLiveState('idle');
        expectationRef.current = { kind: 'command' };
      };
    }, [stopSpeaking]),
  );

  /** L'oreille se rouvre — ou retombe en idle si le live a été coupé entre-temps. */
  const listen = (): void => {
    if (!liveRef.current) return;
    setLiveState('listening');
    if (!voiceRef.current.listening) void voiceRef.current.start();
  };

  const say = async (text: string, opts: { bargeIn?: boolean } = {}): Promise<void> => {
    if (!liveRef.current) return;
    setLiveState('speaking');
    speakingTextRef.current = text;
    // LIVE-3 : l'oreille reste ouverte PENDANT la lecture (natif seulement — en cloud, le
    // tap du bandeau reste l'interruption). JAMAIS pendant une demande de CONFIRMATION :
    // l'écho du prompt contient « je confirme »/« annule » — risque d'exécution fantôme.
    if ((opts.bargeIn ?? true) && speechRecognitionAvailable && !voiceRef.current.listening)
      void voiceRef.current.start();
    await speakAndWait(text);
    speakingTextRef.current = '';
    lastSpokenRef.current = { text, endedAt: Date.now() };
  };

  /** Pause de purge : laisse l'audio résiduel du TTS sortir des buffers AVANT d'écouter. */
  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** Vocalise le résultat d'un tour d'agent, arme l'attente adaptée, ré-écoute. */
  const liveTurn = async (res: { run: AgentRun; item: ChatItem } | null): Promise<void> => {
    if (!liveRef.current) return;
    if (!res) {
      await say(t('live.error', { personality }));
      expectationRef.current = { kind: 'command' };
      listen();
      return;
    }
    const { run, item } = res;
    const question = run.ask?.[0];
    if (question) {
      expectationRef.current = { kind: 'choice', question, retried: false };
      await say(speakableQuestion(question));
      await settle(500);
      listen();
      return;
    }
    if (run.kind === 'proposed' && item.pending) {
      expectationRef.current = { kind: 'consent', item, retried: false };
      await say(run.spokenPrompt ?? run.card.body, { bargeIn: false });
      await settle(800); // purge longue : aucune bribe du prompt ne doit entrer dans l'oreille
      listen();
      return;
    }
    expectationRef.current = { kind: 'command' };
    await say(run.naturalBody ?? run.card.body);
    await settle(500);
    listen();
  };

  /** Route la parole entendue selon l'attente courante — fail-safe à chaque embranchement. */
  /** Écho avéré : ignorer, compter (disjoncteur), ré-écouter — jamais de réponse à soi-même. */
  const swallowEcho = (): void => {
    echoStreakRef.current += 1;
    if (echoStreakRef.current >= 3) {
      // Trois échos d'affilée : l'environnement audio boucle — on se met au repos (tap = reprise).
      echoStreakRef.current = 0;
      setLiveState('idle');
      return;
    }
    if (liveRef.current && !voiceRef.current.listening) void voiceRef.current.start();
  };

  const onLiveTranscript = async (text: string): Promise<void> => {
    if (!liveRef.current) return;
    const expected = expectationRef.current;
    const reference = echoReference();

    if (liveStateRef.current === 'speaking') {
      // LIVE-3 : final entendu pendant que Bob parle — écho ignoré (ré-écoute), arrêt
      // explicite = silence + oreille libre, parole nouvelle = Bob se tait et traite.
      const verdict = parseBargeIn(text, speakingTextRef.current);
      if (verdict === 'echo') {
        swallowEcho();
        return;
      }
      stopSpeaking(); // speakAndWait résout → le tour en cours enchaînera listen()
      if (verdict === 'interrupt') return;
      // 'speech' : on traite la nouvelle demande ci-dessous.
    } else if (reference) {
      // Fenêtre de grâce post-lecture (fix boucle d'écho device) : une réponse STRUCTURÉE
      // attendue et courte (choix, consentement) court-circuite l'échoscan — ses mots
      // viennent forcément de la question que Bob vient de lire ; tout le reste est
      // échoscanné contre le dernier énoncé.
      const shortReply = speechWordCount(text) <= 4;
      const structuredReply =
        (expected.kind === 'choice' &&
          shortReply &&
          parseVoiceChoice(text, expected.question.options) !== null) ||
        (expected.kind === 'consent' && shortReply && parseVoiceConsent(text) !== 'unclear');
      if (!structuredReply && echoOverlap(text, reference) >= 0.5) {
        swallowEcho();
        return;
      }
    }
    echoStreakRef.current = 0;
    setLiveState('thinking');

    if (expected.kind === 'choice') {
      const idx = parseVoiceChoice(text, expected.question.options);
      if (idx !== null) {
        const picked = expected.question.options[idx]!;
        setActiveAsk(null); // la modale se referme : la voix a répondu
        expectationRef.current = { kind: 'command' };
        await liveTurn(await ask(picked.followUp));
        return;
      }
      if (!expected.retried) {
        expectationRef.current = { ...expected, retried: true };
        await say(t('live.unclearChoice', { personality }));
        listen();
        return;
      }
      // Deux échecs : la modale reste ouverte, l'écran tranche — l'oreille redevient libre.
      expectationRef.current = { kind: 'command' };
      await say(t('live.useScreen', { personality }));
      listen();
      return;
    }

    if (expected.kind === 'consent') {
      const consent = parseVoiceConsent(text);
      if (consent === 'confirm') {
        expectationRef.current = { kind: 'command' };
        const done = await confirm(expected.item);
        await say(done ? done.card.body : t('assistant.actionError', { personality }));
        listen();
        return;
      }
      if (consent === 'cancel') {
        expectationRef.current = { kind: 'command' };
        cancel(expected.item);
        await say(t('assistant.canceled', { personality }));
        listen();
        return;
      }
      if (!expected.retried) {
        expectationRef.current = { ...expected, retried: true };
        await say(t('live.unclearConsent', { personality }));
        listen();
        return;
      }
      expectationRef.current = { kind: 'command' };
      await say(t('live.useScreen', { personality }));
      listen();
      return;
    }

    await liveTurn(await ask(text));
  };

  const toggleLive = (): void => {
    if (globalSession.active) {
      globalSession.stop();
      return;
    }
    if (live) {
      setLive(false);
      liveRef.current = false;
      stopSpeaking();
      void voiceRef.current.stop();
      setLiveState('idle');
      expectationRef.current = { kind: 'command' };
      return;
    }
    // TEASER BOB LIVE (pilier 2) : sans droit voice_live, le tap devient LE moment contextuel —
    // jamais pendant le chargement (on ne vend pas sur un doute) et le « non » est tenu :
    // sourdine (2 rejets même source < 14 j) → réponse discrète de Bob, zéro vente. La branche
    // AYANT DROIT ci-dessous est strictement inchangée (le realtime vit dans la session).
    if (liveEntitlement.loading) return; // abonnement pas encore su : ni vente, ni départ à l'aveugle
    if (!liveEntitlement.allowed) {
      const decision = liveEntitlement.decision;
      void isPaywallMuted('voice_live_tap').then((muted) => {
        if (muted || decision === null) pushText('bob', t('live.useScreen', { personality }));
        else setLivePaywall(decision);
      });
      return;
    }
    setLive(true);
    liveRef.current = true;
    expectationRef.current = { kind: 'command' };
    setLiveState('listening');
    void voiceRef.current.start().then((started) => {
      if (started) return;
      liveRef.current = false;
      setLive(false);
      setLiveState('idle');
    });
  };

  // Fin d'écoute sans transcript (silence) : l'orbe retombe en « prêt » — un tap relance.
  useEffect(() => {
    if (live && !voice.listening && liveState === 'listening') setLiveState('idle');
  }, [live, voice.listening, liveState]);

  /** Valider : exécute l'action proposée via agent.confirm — LE flux de confirmation existant. */
  const confirm = async (item: ChatItem): Promise<AgentRun | null> => {
    if (!item.pending || busy || !assistantEntitlement.verified || !entitled) return null;
    // Une action financière ne part jamais avec un aperçu fabriqué à partir de données
    // absentes, obsolètes après erreur, ou d'une pièce introuvable.
    if (pendingPreview(item.pending, item.accountingLines).kind !== 'ready') return null;
    setBusy(true);
    const r = await agent.confirm(item.pending);
    setBusy(false);
    // L'action proposée est consommée (les boutons disparaissent, décision prise).
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, pending: undefined } : it)));
    if (r.ok) {
      setReachable(true);
      pushRun(r.value);
      return r.value;
    }
    pushText('bob', failText(r.error, 'assistant.actionError'));
    return null;
  };

  const cancel = (item: ChatItem): void => {
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, pending: undefined } : it)));
    pushText('bob', t('assistant.canceled', { personality }));
  };

  // Passage overlay → fil complet : on consomme le run DÉJÀ produit, avec le même proposalId
  // et le même snapshot contextuel. Le transcript n'est pas rejoué via /ai/ask et aucune donnée
  // métier n'est sérialisée dans l'URL. Le provider invalide également ce passage au bout de 2 min.
  useEffect(() => {
    const handoff = globalSession.handoff;
    if (
      !assistantFocused ||
      !handoff ||
      handoff.requestedAt === null ||
      !entitled ||
      busy ||
      consumedHandoffIdRef.current === handoff.id
    )
      return;
    if (handoff.expiresAt <= Date.now()) {
      globalSession.consumeHandoff(handoff.id);
      return;
    }
    consumedHandoffIdRef.current = handoff.id;
    // Une ancienne query de navigation ne doit pas être soumise en parallèle du passage.
    const routePrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (routePrompt) submittedPrompt.current = routePrompt;
    handoffContextRef.current = { context: handoff.context, expiresAt: handoff.expiresAt };
    for (const turn of handoff.history) pushTextRef.current(turn.role, turn.text);
    pushTextRef.current('user', handoff.message);
    if (handoff.kind === 'run') {
      pushRunRef.current(handoff.run);
      globalSession.consumeHandoff(handoff.id);
      return;
    }

    // La voix ne transporte jamais tool/args. L'identifiant opaque est recharge par un endpoint
    // qui reverifie tenant, utilisateur et TTL ; un mismatch reste bloque sans bouton Valider.
    setBusy(true);
    void client.previewBobProposal(handoff.proposalId).then((preview) => {
      const stillCurrent = globalHandoffRef.current?.id === handoff.id;
      if (!stillCurrent) return;
      if (
        !preview.ok
        || preview.value.proposalId !== handoff.proposalId
        || typeof preview.value.expiresAt !== 'string'
        || Date.parse(preview.value.expiresAt) <= Date.now()
      ) {
        pushTextRef.current('bob', t('assistant.proposalUnavailable', { personality }));
        return;
      }
      pushProposalPreviewRef.current(preview.value, handoff.responseText);
    }).catch(() => {
      if (globalHandoffRef.current?.id === handoff.id) {
        pushTextRef.current('bob', t('assistant.proposalUnavailable', { personality }));
      }
    }).finally(() => {
      setBusy(false);
      globalSession.consumeHandoff(handoff.id);
    });
  }, [
    assistantFocused,
    busy,
    entitled,
    globalSession.consumeHandoff,
    globalSession.handoff,
    client,
    personality,
    prompt,
  ]);

  // ?prompt=relance (edges C10/C11/C13) : pré-remplit puis soumet — une seule fois par valeur.
  useEffect(() => {
    const raw = typeof prompt === 'string' ? prompt.trim() : '';
    if (!assistantFocused || !raw || !entitled || busy || submittedPrompt.current === raw) return;
    submittedPrompt.current = raw;
    const key = ENTRY_PROMPTS[raw];
    const text = key !== undefined ? t(key, { personality }) : raw;
    setInput(text); // pré-remplit…
    void askRef.current(text); // …et soumet (contrat C15)
  }, [assistantFocused, prompt, entitled, personality, busy]);

  const tabClearance =
    patterns.bottomTabBar.padding[0] +
    TAB_PILL_HEIGHT +
    Math.max(insets.bottom, patterns.bottomTabBar.padding[2]);
  const displayedLive = globalSession.active || live;
  const displayedLiveState = globalSession.active
    ? globalSession.phase === 'error'
      ? 'idle'
      : globalSession.phase
    : liveState;

  // ── Garde d'abonnement autoritative : aucun prompt, live ou outil tant que GET /subscription
  // n'a pas répondu avec succès. Une erreur avec cache reste fermée jusqu'au prochain succès. ──
  if (assistantEntitlement.loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: 20, paddingTop: insets.top + 40, gap: 14 }}>
        <Skeleton width={56} height={56} radius={18} />
        <Skeleton width="48%" height={24} radius={10} />
        <Skeleton width="92%" height={15} radius={8} />
        <Skeleton width="76%" height={15} radius={8} />
      </View>
    );
  }

  if (!assistantEntitlement.verified) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: 20, paddingTop: insets.top + 40 }}>
        <ErrorRetry
          message={t('account.subscriptionError', { personality })}
          onRetry={() => void subscriptionQuery.refetch()}
          retrying={subscriptionQuery.isRefetching}
        />
      </View>
    );
  }

  if (!entitled) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          padding: 20,
          paddingTop: insets.top + 40,
          gap: 14,
        }}
      >
        <View
          style={{
            width: 56,
            height: 56,
            borderRadius: 18,
            overflow: 'hidden',
            ...shadowNative.e2,
          }}
        >
          <LinearGradient
            colors={[semantic.ai, themes.indigo.d2]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
          >
            <SparkIcon color={colors.surface} size={26} strokeWidth={2} />
          </LinearGradient>
        </View>
        <Text style={[font('pageTitle'), { color: colors.ink900 }]}>
          {t('assistant.lockedTitle', { personality })}
        </Text>
        <Text style={[font('body'), { color: colors.slate500, lineHeight: 21 }]}>
          {t('assistant.lockedBody', { personality })}
        </Text>
        <Button
          title={t('assistant.lockedCta', { personality })}
          onPress={() => router.push('/compte')}
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Fond du proto : lavande IA → fond d'app sur le premier tiers (tokens). */}
      <LinearGradient
        pointerEvents="none"
        colors={[conformityCard.bgTop, colors.bg]}
        locations={[0, 0.3]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}
      >
        {/* ── Header « Bob · en ligne » ─────────────────────────────────────── */}
        <View
          style={{
            paddingTop: insets.top + 8,
            paddingHorizontal: 20,
            paddingBottom: 12,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 11,
            borderBottomWidth: 1,
            borderBottomColor: controls.cardBorder,
          }}
        >
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 13,
              overflow: 'hidden',
              ...shadowNative.e2,
            }}
          >
            <LinearGradient
              colors={[semantic.ai, themes.indigo.d2]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
            >
              <SparkIcon color={colors.surface} size={20} strokeWidth={2} />
            </LinearGradient>
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <Text style={[font('section'), { fontSize: 18, color: colors.ink900 }]}>
                {t('assistant.title', { personality })}
              </Text>
              {reachable !== null ? <View
                accessibilityRole="text"
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  backgroundColor: reachable ? semantic.successBg : semantic.warningBg,
                  borderRadius: 6,
                  paddingVertical: 2,
                  paddingHorizontal: 7,
                }}
              >
                <View
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 3,
                    backgroundColor: reachable ? semantic.success : semantic.warning,
                  }}
                />
                <Text
                  style={[
                    font('label', 700),
                    { fontSize: 10, color: reachable ? semantic.success : semantic.warning },
                  ]}
                >
                  {t(reachable ? 'assistant.online' : 'assistant.offlinePill', { personality })}
                </Text>
              </View> : null}
            </View>
            <Text style={[font('label'), { fontSize: 12.5, color: semantic.ai, marginTop: 1 }]}>
              {t('assistant.subtitle', { personality })}
            </Text>
          </View>
        </View>

        {/* ── Fil de chat ───────────────────────────────────────────────────── */}
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 18,
            paddingBottom: 8,
            gap: 12,
          }}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: !reduceMotion })}
        >
          {/* Bulle d'accueil — la promesse de Bob (historique vide = état de premier rang). */}
          <BobBubble>
            <Text style={[font('body'), { color: colors.ink800, lineHeight: 21 }]}>
              {t('assistant.welcome', { personality })}
            </Text>
          </BobBubble>

          {items.map((it) => {
            const preview = it.pending ? pendingPreview(it.pending, it.accountingLines) : null;
            return it.role === 'user' ? (
              <View
                key={it.id}
                style={{
                  alignSelf: 'flex-end',
                  maxWidth: '85%',
                  backgroundColor: theme.ink,
                  borderRadius: 16,
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                }}
              >
                <Text style={[font('body'), { color: colors.surface, lineHeight: 21 }]}>
                  {it.text}
                </Text>
              </View>
            ) : (
              <BobBubble key={it.id}>
                {it.run ? (
                  <Text
                    style={[
                      font('cardTitle'),
                      { fontSize: 15, color: colors.ink900, marginBottom: 4 },
                    ]}
                  >
                    {it.run.card.title}
                  </Text>
                ) : null}
                <Text style={[font('body'), { color: colors.ink800, lineHeight: 21 }]}>
                  {it.text}
                </Text>

                {/* Carte d'action : aperçu avant/après + garde-fou + Valider/Annuler (flux réel). */}
                {it.pending ? (
                  <>
                    {preview?.kind === 'ready' ? (
                      <ActionDiffView diff={preview.diff} />
                    ) : preview?.kind === 'loading' ? (
                      <View
                        accessibilityLabel={t('assistant.proposalLoading', { personality })}
                        style={{ gap: 8, marginTop: 12 }}
                      >
                        <Skeleton height={16} width="72%" radius={8} />
                        <Skeleton height={44} width="100%" radius={12} />
                      </View>
                    ) : (
                      <View style={{ gap: 10, marginTop: 12 }}>
                        <Text
                          accessibilityRole="alert"
                          style={[font('sub'), { color: colors.ink900, lineHeight: 20 }]}
                        >
                          {t(
                            preview?.kind === 'missing'
                              ? 'assistant.proposalMissing'
                              : 'assistant.proposalUnavailable',
                            { personality },
                          )}
                        </Text>
                        <View style={{ alignSelf: 'flex-start' }}>
                          <Button
                            title={t('assistant.retry', { personality })}
                            variant="secondary"
                            onPress={() => retryPendingPreview(it.pending!)}
                          />
                        </View>
                      </View>
                    )}
                    <Text
                      style={[
                        font('meta'),
                        { fontSize: 11.5, color: colors.slate400, marginTop: 10 },
                      ]}
                    >
                      {t('assistant.guardrail', { personality })}
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                      <Button
                        title={t('assistant.cancel', { personality })}
                        variant="secondary"
                        radius={12}
                        style={{ flex: 1 }}
                        disabled={busy}
                        onPress={() => cancel(it)}
                      />
                      <Button
                        title={t('assistant.confirm', { personality })}
                        variant="ai"
                        radius={12}
                        style={{ flex: 1 }}
                        disabled={busy || preview?.kind !== 'ready'}
                        onPress={() => void confirm(it)}
                      />
                    </View>
                  </>
                ) : null}

                {/* ASK-1 : question structurée — bouton pour (r)ouvrir la modale de choix. */}
                {it.run?.ask?.length ? (
                  <View style={{ marginTop: 10, alignSelf: 'flex-start' }}>
                    <Chip
                      label={t('assistant.askAnswer', { personality })}
                      onPress={() => setActiveAsk(it.run?.ask?.[0] ?? null)}
                    />
                  </View>
                ) : it.run?.choices?.length ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                    {it.run.choices.map((c) => (
                      <Chip
                        key={c.value}
                        label={c.label}
                        onPress={() =>
                          void ask(
                            t(
                              CMD_BY_INTENT[it.run?.intent ?? 'encaisser'] ??
                                'assistant.cmdCollect',
                              {
                                personality,
                                params: { ref: c.value },
                              },
                            ),
                          )
                        }
                      />
                    ))}
                  </View>
                ) : null}
              </BobBubble>
            );
          })}

          {busy ? <TypingBubble phase={phase} /> : null}
        </ScrollView>

        {/* ── Chips suggestions + input (au-dessus de la tab bar flottante) ──── */}
        <View style={{ paddingBottom: tabClearance + 6 }}>
          {/* TEASER BOB LIVE — la carte contextuelle remplace le bandeau live tant que le droit
              n'est pas ouvert : un CTA (le déblocage décidé par le domaine), le non tenu. */}
          {livePaywall !== null && !liveEntitlement.allowed ? (
            <View style={{ marginHorizontal: 16, marginTop: 6 }}>
              <PaywallCard
                decision={livePaywall}
                source="voice_live_tap"
                personality={personality}
                {...(livePaywall.kind === 'upgrade'
                  ? {
                      teaser: t('paywall.liveTeaser', {
                        personality,
                        params: { tier: PLAN_CATALOG[livePaywall.requiredTier].label },
                      }),
                    }
                  : {})}
                onDismissed={() => setLivePaywall(null)}
              />
            </View>
          ) : null}
          {displayedLive ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLiveRegion="polite"
              accessibilityLabel={t(
                displayedLiveState === 'listening'
                  ? speechRecognitionAvailable
                    ? 'live.listening'
                    : 'live.tapWhenDone'
                  : displayedLiveState === 'thinking'
                    ? 'live.thinking'
                    : displayedLiveState === 'speaking'
                      ? 'live.speaking'
                      : 'live.idle',
                { personality },
              )}
              onPress={() => {
                if (globalSession.active) {
                  globalSession.toggle();
                  return;
                }
                // Tap sur le bandeau : interrompt la lecture, clôt l'écoute cloud, ou relance l'oreille.
                if (liveState === 'speaking') {
                  stopSpeaking();
                  listen();
                } else if (liveState === 'listening' && !speechRecognitionAvailable) {
                  void voiceRef.current.stop(); // cloud : fin de parole manuelle
                } else if (liveState === 'idle') {
                  listen();
                }
              }}
              style={{
                marginHorizontal: 16,
                marginTop: 6,
                borderRadius: 14,
                paddingVertical: 10,
                paddingHorizontal: 14,
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: displayedLiveState === 'listening' ? semantic.ai : controls.cardBorder,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 9,
                ...shadowNative.e1,
              }}
            >
              <View
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 5,
                  backgroundColor:
                    displayedLiveState === 'listening'
                      ? semantic.ai
                      : displayedLiveState === 'speaking'
                        ? semantic.success
                        : colors.slate300,
                }}
              />
              <Text style={[font('sub', 600), { color: colors.ink800, flex: 1 }]}>
                {t(
                  displayedLiveState === 'listening'
                    ? speechRecognitionAvailable
                      ? 'live.listening'
                      : 'live.tapWhenDone'
                    : displayedLiveState === 'thinking'
                      ? 'live.thinking'
                      : displayedLiveState === 'speaking'
                        ? 'live.speaking'
                        : 'live.idle',
                  { personality },
                )}
              </Text>
            </Pressable>
          ) : null}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              gap: 8,
              paddingHorizontal: 16,
              paddingTop: 6,
              paddingBottom: 12,
            }}
          >
            {SUGGESTION_CHIPS.map((key) => {
              const label = t(key, { personality });
              return (
                <SuggestionChip
                  key={key}
                  label={label}
                  disabled={busy}
                  onPress={() => void ask(label)}
                />
              );
            })}
          </ScrollView>

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 9,
              marginHorizontal: 16,
              backgroundColor: colors.surface,
              borderRadius: 16,
              padding: 7,
              paddingLeft: 16,
              ...shadowNative.e2,
            }}
          >
            <TextInput
              value={input}
              ref={inputRef}
              onChangeText={setInput}
              placeholder={t('assistant.placeholder', { personality })}
              placeholderTextColor={colors.slate300}
              accessibilityLabel={t('assistant.placeholder', { personality })}
              returnKeyType="send"
              onSubmitEditing={() => void ask(input)}
              style={[font('body'), { flex: 1, padding: 0, color: colors.ink800 }]}
            />
            {/* LIVE — le mode vocal mains-libres : Bob écoute, agit et répond en continu. */}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: displayedLive }}
              accessibilityLabel={
                displayedLive
                  ? t('live.speaking', { personality })
                  : t('live.idle', { personality })
              }
              onPress={toggleLive}
              style={{
                width: 38,
                height: 38,
                minWidth: 44,
                minHeight: 44,
                borderRadius: 11,
                overflow: 'hidden',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: displayedLive ? undefined : controls.segmentedTrack,
              }}
            >
              {displayedLive ? (
                <LinearGradient
                  colors={[semantic.ai, themes.indigo.d2]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
                />
              ) : null}
              <Ionicons
                name="pulse"
                size={19}
                color={displayedLive ? colors.surface : colors.slate500}
              />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('assistant.send', { personality })}
              accessibilityState={{ disabled: busy }}
              onPress={() => void ask(input)}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                borderRadius: 11,
                overflow: 'hidden',
                transform: [{ scale: pressed ? 0.94 : 1 }],
              })}
            >
              <LinearGradient
                colors={[semantic.ai, themes.indigo.d2]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
              >
                <SendIcon color={colors.surface} size={18} />
              </LinearGradient>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>

      {/* ASK-1 : la modale de question structurée (choix unique/multiple, descriptions). */}
      <QuestionSheet
        visible={activeAsk !== null}
        header={activeAsk?.header ?? ''}
        question={activeAsk?.question ?? ''}
        options={activeAsk?.options ?? []}
        multiSelect={activeAsk?.multiSelect ?? false}
        confirmLabel={t('assistant.askConfirm', { personality })}
        otherLabel={t('assistant.askOther', { personality })}
        onClose={() => setActiveAsk(null)}
        onSelect={answerAsk}
        onOther={() => {
          setActiveAsk(null);
          inputRef.current?.focus();
        }}
      />
    </View>
  );
}

/**
 * Assistant — Bob (claim C15, réf claims/ref/C15-frame.png, directive parité [23:52]).
 * Composition 100 % @bob/ui + tokens : header « Bob · en ligne » (avatar étincelle
 * dégradé IA, pill statut, sous-titre assistant.subtitle) → fil de chat (bulle
 * d'accueil voix Bob, bulles user/Bob, indicateur de saisie 3 points animés, cartes
 * d'action avec aperçu avant/après + Valider/Annuler) → chips suggestions du proto →
 * input « Demande-moi un truc… » + micro (→ /voix, C20) + envoi.
 *
 * BRANCHEMENT 100 % RÉEL (couche présentation refaite, transport conservé) : le fil
 * parle au VRAI agent — makeBobAgent(client) → BobAgent (@bob/ai : intents, autonomie,
 * confirmations, garde-fous) dont les ACTIONS délèguent au BobClient (mêmes use cases
 * que les CTA d'écrans — jamais un chemin parallèle). Les actions sensibles reviennent
 * en `proposed` : carte d'action avec diff (buildActionDiff + aperçu comptable réel via
 * invoiceAccountingPreview) et exécution UNIQUEMENT via agent.confirm (préparer ≠ envoyer).
 * En mode démo, le LocalBobClient expose l'agent (routeur déterministe) — zéro script.
 *
 * ?prompt=relance | relance_devis (edges C10/C11/C13) : pré-remplit puis SOUMET la
 * demande correspondante (commande canonique @bob/i18n — matche detectIntent).
 *
 * États : abonnement sans ai_assistant → garde honnête (l'app reste utilisable à la
 * main) · erreur → voix de Bob (assistant.error/actionError) · serveur injoignable
 * (kind dependency) → assistant.offline + pill « hors ligne » · réflexion → phase
 * RÉELLE de l'agent (onPhase comprends/agit) sur l'indicateur de saisie.
 *
 * Écarts assumés vs réf/ancien écran :
 * · mode vocal mains-libres (VoiceOrb + STT/TTS) retiré de CET écran — le micro ouvre le
 *   flux /voix (C20) ; confirmByVoice (@bob/ai) et data/voice restent intacts ;
 * · badges « plan · modèle » de l'ancien écran non repris (le proto n'affiche pas de
 *   télémétrie — choix produit ThinkingIndicator conservé) ;
 * · dégradés via tokens (conformityCard.bgTop→bg · ai→indigo.d2), pas les hex du proto ;
 * · chip « Prêt pour 2026 ? » → garde-fou de Bob (aucun intent diagnostic côté agent —
 *   TODO tracé dans l'audit de parité C15).
 * Zéro hex/rgba. Zéro import de src/components/ui — ActionDiffView (composant d'action
 * métier, autorisé au contrat) rend l'aperçu avant/après partagé avec le flux manuel.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  buildActionDiff,
  parseBargeIn,
  parseVoiceChoice,
  parseVoiceConsent,
  speakableQuestion,
  type AccountingLine,
  type ActionDiff,
  type AgentQuestion,
  type AgentRun,
  type BobIntent,
  type PendingAction,
} from '@bob/ai';
import type { AppError } from '@bob/core';
import { conformityCard, patterns, shadowNative, themes } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import { Button, Chip, QuestionSheet, font, useTheme } from '@bob/ui';
import { useBobClient } from '../../src/data/client';
import { useInvoices, useQuotes, useSubscription } from '../../src/data/hooks';
import { makeBobAgent } from '../../src/data/bob';
import { getAutonomy } from '../../src/data/settings';
import { speechRecognitionAvailable, useSpeak, useVoiceInput } from '../../src/data/voice';
import { ActionDiffView } from '../../src/components/ActionDiffView';
import { MicIcon, SendIcon, SparkIcon } from '../../src/components/icons';

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
  const dots = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;

  useEffect(() => {
    const loops = dots.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 180),
          Animated.timing(v, { toValue: 1, duration: 360, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(v, { toValue: 0, duration: 360, easing: Easing.in(Easing.quad), useNativeDriver: true }),
          Animated.delay((dots.length - 1 - i) * 180),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [dots]);

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
              transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }) }],
            }}
          />
        ))}
      </View>
    </View>
  );
}

/** Chip suggestion du proto (blanc, bord lavande, texte indigo) — pas le Chip filtre @bob/ui. */
function SuggestionChip({ label, onPress, disabled }: { label: string; onPress: () => void; disabled: boolean }) {
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
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const qc = useQueryClient();
  const client = useBobClient();
  const agent = useMemo(() => makeBobAgent(client), [client]);
  const { data: sub } = useSubscription();
  const { data: invoices } = useInvoices();
  const { data: quotes } = useQuotes();
  const { prompt } = useLocalSearchParams<{ prompt?: string }>();
  const entitled = (sub?.features ?? []).includes('ai_assistant');

  const [items, setItems] = useState<ChatItem[]>([]);
  const itemsRef = useRef<ChatItem[]>([]);
  itemsRef.current = items;
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string | null>(null);
  const [reachable, setReachable] = useState(true);
  /** ASK-1 : question structurée active (modale) — ouverte automatiquement à l'arrivée du run. */
  const [activeAsk, setActiveAsk] = useState<AgentQuestion | null>(null);
  const inputRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);
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
  };

  /**
   * Aperçu avant/après de l'action proposée — la « preuve » avant Valider, calculée
   * depuis l'action + les pièces réelles (même buildActionDiff que la ConfirmSheet).
   */
  const pendingDiff = (pending: PendingAction, accountingLines?: readonly AccountingLine[]): ActionDiff | null => {
    const { tool, args } = pending;
    const invId = typeof args.invoiceId === 'string' ? args.invoiceId : '';
    const quoteId = typeof args.quoteId === 'string' ? args.quoteId : '';
    if (tool === 'encaisser_facture') {
      const inv = (invoices ?? []).find((i) => i.id === invId);
      const remaining = inv ? Math.max(0, inv.totals.netToPay - inv.paid) : 0;
      const amountCents = typeof args.amountCents === 'number' ? args.amountCents : remaining;
      return buildActionDiff('encaisser_facture', { amountCents }, { number: inv?.number ?? null, remainingCents: remaining });
    }
    if (tool === 'emettre_facture') {
      const inv = (invoices ?? []).find((i) => i.id === invId);
      return buildActionDiff('emettre_facture', {}, { number: inv?.number ?? null, ...(accountingLines ? { accountingLines } : {}) });
    }
    if (tool === 'envoyer_devis') {
      const q = (quotes ?? []).find((x) => x.id === quoteId);
      return buildActionDiff('envoyer_devis', {}, { number: q?.number ?? null });
    }
    return null;
  };

  const pushRun = (run: AgentRun): ChatItem => {
    const id = nextId();
    const pending = run.kind === 'proposed' ? run.pending : undefined;
    // LIVE-2 : la reformulation naturelle (gardée par les faits) prime sur le gabarit.
    const item: ChatItem = { id, role: 'bob', text: run.naturalBody ?? run.card.body, run, ...(pending ? { pending } : {}) };
    setItems((prev) => [...prev, item]);
    if (run.kind === 'done') refreshAfterAction();
    if (run.navigate) router.push(run.navigate as never); // commande « Jarvis » : Bob ouvre le bon écran
    if (run.ask?.length) setActiveAsk(run.ask[0] ?? null); // ASK-1 : la question s'ouvre d'elle-même

    // Émission : enrichit l'aperçu avec l'écriture comptable prévisionnelle RÉELLE (async, best-effort).
    const invId = pending?.tool === 'emettre_facture' && typeof pending.args.invoiceId === 'string' ? pending.args.invoiceId : null;
    if (invId) {
      void client
        .invoiceAccountingPreview(invId)
        .then((r) => {
          if (r.ok && r.value.available && r.value.lines.length) {
            const lines = r.value.lines;
            setItems((prev) => prev.map((it) => (it.id === id ? { ...it, accountingLines: lines } : it)));
          }
        })
        .catch(() => {
          /* aperçu comptable best-effort : silencieux si indisponible */
        });
    }
    return item;
  };

  const ask = async (raw: string): Promise<{ run: AgentRun; item: ChatItem } | null> => {
    const message = raw.trim();
    if (!message || busy) return null;
    setInput('');
    pushText('user', message);
    setBusy(true);
    const autonomy = await getAutonomy(); // politique de confirmation RÉELLE (runtime @bob/ai)
    // LIVE-2 : mémoire de conversation courte (anaphores) + humeur — expurgées côté agent.
    const history = itemsRef.current.slice(-6).map((it) => ({ role: it.role, text: it.text }));
    const r = await agent.ask(message, {
      autonomy,
      history,
      tone: personality,
      onPhase: (p) =>
        setPhase(t(p === 'comprends' ? 'assistant.phaseUnderstand' : 'assistant.phaseAct', { personality })),
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
  const [liveState, setLiveState] = useState<'idle' | 'listening' | 'thinking' | 'speaking'>('idle');
  const liveRef = useRef(false);
  liveRef.current = live;
  const liveStateRef = useRef(liveState);
  liveStateRef.current = liveState;
  /** Ce que Bob est en train de dire — la référence de l'echo-guard (LIVE-3). */
  const speakingTextRef = useRef('');
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

  /** L'oreille se rouvre — ou retombe en idle si le live a été coupé entre-temps. */
  const listen = (): void => {
    if (!liveRef.current) return;
    setLiveState('listening');
    if (!voiceRef.current.listening) void voiceRef.current.start();
  };

  const say = async (text: string): Promise<void> => {
    if (!liveRef.current) return;
    setLiveState('speaking');
    speakingTextRef.current = text;
    // LIVE-3 : l'oreille reste ouverte PENDANT la lecture (natif seulement — en cloud,
    // le tap du bandeau reste l'interruption). L'echo-guard filtre la voix de Bob.
    if (speechRecognitionAvailable && !voiceRef.current.listening) void voiceRef.current.start();
    await speakAndWait(text);
    speakingTextRef.current = '';
  };

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
      listen();
      return;
    }
    if (run.kind === 'proposed' && item.pending) {
      expectationRef.current = { kind: 'consent', item, retried: false };
      await say(run.spokenPrompt ?? run.card.body);
      listen();
      return;
    }
    expectationRef.current = { kind: 'command' };
    await say(run.naturalBody ?? run.card.body);
    listen();
  };

  /** Route la parole entendue selon l'attente courante — fail-safe à chaque embranchement. */
  const onLiveTranscript = async (text: string): Promise<void> => {
    if (!liveRef.current) return;
    if (liveStateRef.current === 'speaking') {
      // LIVE-3 : final entendu pendant que Bob parle — écho ignoré (ré-écoute), arrêt
      // explicite = silence + oreille libre, parole nouvelle = Bob se tait et traite.
      const verdict = parseBargeIn(text, speakingTextRef.current);
      if (verdict === 'echo') {
        if (speechRecognitionAvailable && liveRef.current) void voiceRef.current.start();
        return;
      }
      stopSpeaking(); // speakAndWait résout → le tour en cours enchaînera listen()
      if (verdict === 'interrupt') return;
      // 'speech' : on traite la nouvelle demande ci-dessous.
    }
    const expected = expectationRef.current;
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
    if (live) {
      setLive(false);
      liveRef.current = false;
      stopSpeaking();
      void voiceRef.current.stop();
      setLiveState('idle');
      expectationRef.current = { kind: 'command' };
      return;
    }
    setLive(true);
    liveRef.current = true;
    expectationRef.current = { kind: 'command' };
    setLiveState('listening');
    void voiceRef.current.start();
  };

  // Fin d'écoute sans transcript (silence) : l'orbe retombe en « prêt » — un tap relance.
  useEffect(() => {
    if (live && !voice.listening && liveState === 'listening') setLiveState('idle');
  }, [live, voice.listening, liveState]);

  /** Valider : exécute l'action proposée via agent.confirm — LE flux de confirmation existant. */
  const confirm = async (item: ChatItem): Promise<AgentRun | null> => {
    if (!item.pending || busy) return null;
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

  // ?prompt=relance (edges C10/C11/C13) : pré-remplit puis soumet — une seule fois par valeur.
  const submittedPrompt = useRef<string | null>(null);
  useEffect(() => {
    const raw = typeof prompt === 'string' ? prompt.trim() : '';
    if (!raw || !entitled || busy || submittedPrompt.current === raw) return;
    submittedPrompt.current = raw;
    const key = ENTRY_PROMPTS[raw];
    const text = key !== undefined ? t(key, { personality }) : raw;
    setInput(text); // pré-remplit…
    void askRef.current(text); // …et soumet (contrat C15)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, entitled, personality, busy]);

  const tabClearance =
    patterns.bottomTabBar.padding[0] + TAB_PILL_HEIGHT + Math.max(insets.bottom, patterns.bottomTabBar.padding[2]);

  // ── Garde d'abonnement (feature ai_assistant) — honnête, l'app reste utilisable à la main ──
  if (sub !== undefined && !entitled) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, padding: 20, paddingTop: insets.top + 40, gap: 14 }}>
        <View style={{ width: 56, height: 56, borderRadius: 18, overflow: 'hidden', ...shadowNative.e2 }}>
          <LinearGradient
            colors={[semantic.ai, themes.indigo.d2]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
          >
            <SparkIcon color={colors.surface} size={26} strokeWidth={2} />
          </LinearGradient>
        </View>
        <Text style={[font('pageTitle'), { color: colors.ink900 }]}>{t('assistant.lockedTitle', { personality })}</Text>
        <Text style={[font('body'), { color: colors.slate500, lineHeight: 21 }]}>
          {t('assistant.lockedBody', { personality })}
        </Text>
        <Button title={t('assistant.lockedCta', { personality })} onPress={() => router.push('/compte')} />
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

      <KeyboardAvoidingView style={{ flex: 1 }} {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}>
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
          <View style={{ width: 40, height: 40, borderRadius: 13, overflow: 'hidden', ...shadowNative.e2 }}>
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
              <View
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
              </View>
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
          contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 18, paddingBottom: 8, gap: 12 }}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        >
          {/* Bulle d'accueil — la promesse de Bob (historique vide = état de premier rang). */}
          <BobBubble>
            <Text style={[font('body'), { color: colors.ink800, lineHeight: 21 }]}>
              {t('assistant.welcome', { personality })}
            </Text>
          </BobBubble>

          {items.map((it) =>
            it.role === 'user' ? (
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
                <Text style={[font('body'), { color: colors.surface, lineHeight: 21 }]}>{it.text}</Text>
              </View>
            ) : (
              <BobBubble key={it.id}>
                {it.run ? (
                  <Text style={[font('cardTitle'), { fontSize: 15, color: colors.ink900, marginBottom: 4 }]}>
                    {it.run.card.title}
                  </Text>
                ) : null}
                <Text style={[font('body'), { color: colors.ink800, lineHeight: 21 }]}>{it.text}</Text>

                {/* Carte d'action : aperçu avant/après + garde-fou + Valider/Annuler (flux réel). */}
                {it.pending ? (
                  <>
                    <ActionDiffView diff={pendingDiff(it.pending, it.accountingLines)} />
                    <Text style={[font('meta'), { fontSize: 11.5, color: colors.slate400, marginTop: 10 }]}>
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
                        disabled={busy}
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
                            t(CMD_BY_INTENT[it.run?.intent ?? 'encaisser'] ?? 'assistant.cmdCollect', {
                              personality,
                              params: { ref: c.value },
                            }),
                          )
                        }
                      />
                    ))}
                  </View>
                ) : null}
              </BobBubble>
            ),
          )}

          {busy ? <TypingBubble phase={phase} /> : null}
        </ScrollView>

        {/* ── Chips suggestions + input (au-dessus de la tab bar flottante) ──── */}
        <View style={{ paddingBottom: tabClearance + 6 }}>
          {live ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t(
                liveState === 'listening'
                  ? speechRecognitionAvailable
                    ? 'live.listening'
                    : 'live.tapWhenDone'
                  : liveState === 'thinking'
                    ? 'live.thinking'
                    : liveState === 'speaking'
                      ? 'live.speaking'
                      : 'live.idle',
                { personality },
              )}
              onPress={() => {
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
                borderColor: liveState === 'listening' ? semantic.ai : controls.cardBorder,
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
                    liveState === 'listening' ? semantic.ai : liveState === 'speaking' ? semantic.success : colors.slate300,
                }}
              />
              <Text style={[font('sub', 600), { color: colors.ink800, flex: 1 }]}>
                {t(
                  liveState === 'listening'
                    ? speechRecognitionAvailable
                      ? 'live.listening'
                      : 'live.tapWhenDone'
                    : liveState === 'thinking'
                      ? 'live.thinking'
                      : liveState === 'speaking'
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
            contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 12 }}
          >
            {SUGGESTION_CHIPS.map((key) => {
              const label = t(key, { personality });
              return <SuggestionChip key={key} label={label} disabled={busy} onPress={() => void ask(label)} />;
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
              accessibilityState={{ selected: live }}
              accessibilityLabel={live ? t('live.speaking', { personality }) : t('live.idle', { personality })}
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
                backgroundColor: live ? undefined : controls.segmentedTrack,
              }}
            >
              {live ? (
                <LinearGradient
                  colors={[semantic.ai, themes.indigo.d2]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
                />
              ) : null}
              <Ionicons name="pulse" size={19} color={live ? colors.surface : colors.slate500} />
            </Pressable>
            {/* Micro — entrée du flux « Facture à la voix » (C20). */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('voix.title', { personality })}
              onPress={() => router.push('/voix')}
              style={{
                width: 38,
                height: 38,
                minWidth: 44,
                minHeight: 44,
                borderRadius: 11,
                backgroundColor: controls.segmentedTrack,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <MicIcon color={colors.slate500} />
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

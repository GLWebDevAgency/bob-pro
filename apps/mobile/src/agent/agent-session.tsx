import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import { router } from 'expo-router';
import { echoOverlap, isAllowedAgentNavigationRoute, type AgentRun, type AskOptions , splitSpokenSentences, summarizeVoiceLatency, type VoiceLatencyTrace } from '@bob/ai';
import { t } from '@bob/i18n';
import { useTheme } from '@bob/ui';
import { makeBobAgent } from '../data/bob';
import { useBobClient } from '../data/client';
import { useSpeak, useVoiceInput, voicePermissionRequestInFlight, type VoiceInputIssue } from '../data/voice';
import { snapshotAgentContext, useAgentContext, useAgentSurface, type AgentContext } from './agent-context';
import { clearWizardHint, setWizardHint } from './wizard-hints';
import { RealtimeControlAcknowledgementGate } from '../realtime/realtime-control-gate';
import { RealtimeResilienceOrchestrator } from '../realtime/realtime-resilience-orchestrator';
import { RealtimeWebRtcTransport } from '../realtime/webrtc-realtime-transport';
import { RealtimeSessionController } from './realtime-session';

export type AgentSessionPhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface AgentConversationTurn {
  readonly role: 'user' | 'bob';
  readonly text: string;
}

/**
 * Passage mémoire overlay → Assistant. Il transporte le résultat DÉJÀ calculé (et donc le
 * proposalId opaque éventuel), le snapshot de contexte et l'historique utile. Rien n'entre dans
 * l'URL ou le stockage persistant ; la valeur expire et ne peut être consommée qu'une fois.
 */
export interface AgentSessionHandoff {
  readonly id: string;
  readonly message: string;
  readonly run: AgentRun;
  readonly context: AgentContext;
  readonly history: readonly AgentConversationTurn[];
  readonly expiresAt: number;
  readonly requestedAt: number | null;
}

export interface AgentSessionValue {
  readonly active: boolean;
  readonly phase: AgentSessionPhase;
  readonly transcript: string | null;
  readonly response: string | null;
  readonly issue: VoiceInputIssue | null;
  readonly reviewRequired: boolean;
  readonly contextAtTurn: AgentContext | null;
  readonly handoff: AgentSessionHandoff | null;
  readonly start: () => void;
  readonly stop: () => void;
  readonly toggle: () => void;
  readonly dismissResponse: () => void;
  readonly requestHandoff: (id: string) => void;
  readonly consumeHandoff: (id: string) => void;
}

type ContextualAskOptions = AskOptions & { readonly context: AgentContext };

const AgentSessionState = createContext<AgentSessionValue | null>(null);
const ECHO_GRACE_MS = 5_000;
const HANDOFF_TTL_MS = 2 * 60_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function AgentSessionProvider({ children }: { readonly children: ReactNode }) {
  const { personality } = useTheme();
  const client = useBobClient();
  const agent = useMemo(() => makeBobAgent(client), [client]);
  const liveContext = useAgentContext();
  const contextRef = useRef(liveContext);
  contextRef.current = liveContext;
  const liveSurface = useAgentSurface();
  const surfaceRef = useRef(liveSurface);
  surfaceRef.current = liveSurface;

  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const [phase, setPhase] = useState<AgentSessionPhase>('idle');
  const phaseRefForGreeting = useRef<AgentSessionPhase>('idle');
  phaseRefForGreeting.current = phase;
  const [transcript, setTranscript] = useState<string | null>(null);
  const [response, setResponse] = useState<string | null>(null);
  const [issue, setIssue] = useState<VoiceInputIssue | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [contextAtTurn, setContextAtTurn] = useState<AgentContext | null>(null);
  const [handoff, setHandoff] = useState<AgentSessionHandoff | null>(null);
  const handoffRef = useRef<AgentSessionHandoff | null>(null);
  handoffRef.current = handoff;
  const historyRef = useRef<AgentConversationTurn[]>([]);
  const turnGenerationRef = useRef(0);
  const lastSpokenRef = useRef<{ readonly text: string; readonly endedAt: number }>({
    text: '',
    endedAt: 0,
  });
  const echoStreakRef = useRef(0);
  const { speakSentences, stopSpeaking } = useSpeak();
  /** BOB LIVE : trace de latence par tour (fin de parole → premier audio), p50/p95 en dev. */
  const latencyTracesRef = useRef<VoiceLatencyTrace[]>([]);
  const currentTraceRef = useRef<VoiceLatencyTrace | null>(null);

  const setSessionPhase = useCallback((next: AgentSessionPhase): void => {
    setPhase(next);
  }, []);

  const transcriptHandlerRef = useRef<(text: string) => void>(() => undefined);

  // ── BOB LIVE : contrôleur temps réel, EXCLUSIF du pilote legacy. Le serveur fait foi
  // (entitlement voice_live + rollout dans realtimeVoiceConfig().available) — tant qu'il dit
  // non, ce chemin est inerte et la session reste 100 % historique. ──
  const realtimeRef = useRef<RealtimeSessionController | null>(null);
  const realtimeActiveRef = useRef(false);
  const getRealtimeController = (): RealtimeSessionController => {
    if (realtimeRef.current) return realtimeRef.current;
    realtimeRef.current = new RealtimeSessionController(
      {
        isAvailable: async () => {
          const config = await client.realtimeVoiceConfig();
          return config.ok && config.value.available;
        },
        updateContext: async (handle, update) => client.updateRealtimeVoiceContext(handle, update),
        createOrchestrator: (legacyFallback, onPrimaryCreated) =>
          new RealtimeResilienceOrchestrator({
            createPrimary: () => {
              const transport = new RealtimeWebRtcTransport(client);
              onPrimaryCreated(transport);
              return transport;
            },
            legacyFallback,
          }),
        createControlGate: (currentFence) =>
          new RealtimeControlAcknowledgementGate(client, () => {
            const fence = currentFence();
            return fence === null ? null : fence;
          }),
      },
      {
        onPhase: (phase) => {
          if (realtimeActiveRef.current) setSessionPhase(phase);
        },
        onUserTranscript: (text, final) => {
          if (!realtimeActiveRef.current || !final) return;
          setTranscript(text);
          historyRef.current = [...historyRef.current, { role: 'user' as const, text }].slice(-12);
        },
        onBobTranscript: (text, final) => {
          if (!realtimeActiveRef.current || !final) return;
          setResponse(text);
          historyRef.current = [...historyRef.current, { role: 'bob' as const, text }].slice(-12);
        },
        onReview: () => {
          if (!realtimeActiveRef.current) return;
          // Plancher : validation VISUELLE — le CTA « Continuer dans l'Assistant » existant.
          setReviewRequired(true);
        },
        onNavigate: (route) => {
          if (!realtimeActiveRef.current) return;
          router.push(route as never);
          // L'écran d'arrivée republie : séquence stricte micro-off→interrupt→PUT→micro-on.
          void realtimeRef.current?.publishContext();
        },
        onFallback: () => {
          // Primaire ENTIÈREMENT fermé (garantie orchestrateur) : texte honnête puis boucle
          // historique — jamais deux cerveaux.
          realtimeActiveRef.current = false;
          if (!activeRef.current) return;
          setResponse(t('agent.global.liveFallback', { personality }));
          void (async () => {
            await say(t('agent.global.liveFallback', { personality }), true);
          })();
        },
        getContextSnapshot: () => snapshotAgentContext(contextRef.current),
      },
    );
    return realtimeRef.current;
  };
  const voice = useVoiceInput((text) => transcriptHandlerRef.current(text), {
    owner: 'global-agent-session',
    onIssue: (nextIssue) => {
      console.warn('[bob-voice] session onIssue:', nextIssue);
      setIssue(nextIssue);
      activeRef.current = false;
      setActive(false);
      setSessionPhase('error');
      // Chaque accroc a SON message : l'utilisateur (et le debug terrain) sait quoi faire.
      const key =
        nextIssue === 'denied'
          ? ('agent.global.issueDenied' as const)
          : nextIssue === 'failed'
            ? ('agent.global.issueFailed' as const)
            : ('agent.global.issueUnavailable' as const);
      setResponse(t(key, { personality }));
    },
  });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  const listen = useCallback(async (): Promise<void> => {
    if (!activeRef.current) return;
    setSessionPhase('listening');
    // Pas de garde sur l'état React `listening` (stale d'un tick après un écho avalé) :
    // start() est idempotent — une écoute déjà active du même flux répond true sans rien casser.
    const started = await voiceRef.current.start();
    if (!started && activeRef.current) {
      console.warn('[bob-voice] session: start() a échoué — session désactivée');
      activeRef.current = false;
      setActive(false);
      setSessionPhase('error');
      // Jamais une disparition muette : si aucun onIssue n'a posé de message, celui-ci reste.
      setResponse((current) => current ?? t('agent.global.error', { personality }));
    }
  }, [personality, setSessionPhase]);

  const stop = useCallback((): void => {
    if (realtimeActiveRef.current) {
      realtimeActiveRef.current = false;
      void realtimeRef.current?.stop('user');
    }
    clearWizardHint(); // un hint en vol meurt avec la session — jamais de pré-remplissage fantôme
    turnGenerationRef.current += 1;
    activeRef.current = false;
    setActive(false);
    echoStreakRef.current = 0;
    stopSpeaking();
    void voiceRef.current.cancel();
    setContextAtTurn(null);
    setHandoff(null);
    setReviewRequired(false);
    setSessionPhase('idle');
  }, [setSessionPhase, stopSpeaking]);

  const say = useCallback(
    async (
      text: string,
      continueListening: boolean,
      terminalPhase: AgentSessionPhase = 'idle',
    ): Promise<void> => {
      const clean = text.trim();
      if (!clean) {
        if (continueListening) await listen();
        else setSessionPhase(terminalPhase);
        return;
      }
      setSessionPhase('speaking');
      if (currentTraceRef.current && currentTraceRef.current.sayStartAt === undefined) {
        currentTraceRef.current.sayStartAt = Date.now();
        latencyTracesRef.current = [...latencyTracesRef.current.slice(-49), currentTraceRef.current];
        if (__DEV__) {
          const summary = summarizeVoiceLatency(latencyTracesRef.current);
          console.log(
            `[bob-latency] voix→voix p50=${summary.voiceToVoiceMsP50 ?? '—'}ms p95=${summary.voiceToVoiceMsP95 ?? '—'}ms (${summary.turns} tours)`,
          );
        }
      }
      // Semi-duplex fail-safe : aucune oreille ouverte pendant le TTS. Le tap stoppe la
      // session ; l'écoute ne reprend qu'après la purge. BOB LIVE P1 : la réponse part en
      // FILE DE PHRASES — Bob parle dès la première, le tap coupe entre deux phrases.
      await speakSentences(splitSpokenSentences(clean));
      lastSpokenRef.current = { text: clean, endedAt: Date.now() };
      if (!continueListening || !activeRef.current) {
        setSessionPhase(terminalPhase);
        return;
      }
      await wait(500);
      await listen();
    },
    [listen, setSessionPhase, speakSentences],
  );

  const spokenGreetingsRef = useRef<Set<string>>(new Set());
  const pendingGreetingRef = useRef<string | null>(null);
  const greetingKey = liveSurface.greeting?.key ?? null;
  const speakGreeting = useCallback(
    async (key: string): Promise<void> => {
      if (spokenGreetingsRef.current.has(key)) return;
      const current = surfaceRef.current.greeting;
      if (!current || current.key !== key) return;
      spokenGreetingsRef.current.add(key); // consommé au moment où on le PREND EN CHARGE
      pendingGreetingRef.current = null;
      // Semi-duplex : jamais de TTS micro ouvert — l'oreille en cours est annulée d'abord.
      await voiceRef.current.cancel();
      await say(current.text, true);
    },
    [say],
  );
  /** Guidage mis en attente pendant un tour : joué à la FIN du tour — jamais perdu. */
  const flushPendingGreeting = useCallback((): void => {
    const pending = pendingGreetingRef.current;
    if (pending === null || !activeRef.current) return;
    void speakGreeting(pending);
  }, [speakGreeting]);
  useEffect(() => {
    if (greetingKey === null) return;
    // Session inactive : on ne consomme RIEN — start() rejouera le guidage de l'écran courant.
    if (!activeRef.current) return;
    if (realtimeActiveRef.current) return; // temps réel : le guidage vient du cerveau serveur
    if (spokenGreetingsRef.current.has(greetingKey)) return;
    if (phaseRefForGreeting.current === 'thinking' || phaseRefForGreeting.current === 'speaking') {
      pendingGreetingRef.current = greetingKey; // en FILE — pris en charge à la fin du tour
      return;
    }
    void speakGreeting(greetingKey);
  }, [greetingKey, speakGreeting]);

  const turnInFlightRef = useRef(false);
  const runTurn = useCallback(
    async (raw: string): Promise<void> => {
      const message = raw.trim();
      if (!message || !activeRef.current) return;
      if (turnInFlightRef.current) return; // sérialisation : un double final ASR ne mute JAMAIS deux fois
      turnInFlightRef.current = true;
      turnGenerationRef.current += 1;
      const turnGeneration = turnGenerationRef.current;
      try {

      const echoReference =
        Date.now() - lastSpokenRef.current.endedAt < ECHO_GRACE_MS
          ? lastSpokenRef.current.text
          : '';
      if (echoReference && echoOverlap(message, echoReference) >= 0.5) {
        echoStreakRef.current += 1;
        if (echoStreakRef.current >= 3) stop();
        else await listen();
        return;
      }
      echoStreakRef.current = 0;

      // AFFORDANCES D'ÉCRAN (S2-GUIDÉ) : le wizard focalisé a la priorité sur le cerveau —
      // « pour Camping Les Pins », « ajoute 2 h de main-d'œuvre à 55 € » agissent sur l'état
      // LOCAL (visible, annulable, mêmes setters que le geste manuel). Pas de correspondance →
      // flux générique inchangé.
      for (const affordance of surfaceRef.current.affordances ?? []) {
        let run: ReturnType<typeof affordance.match>;
        try {
          run = affordance.match(message);
        } catch {
          continue; // un matcher qui explose n'avale jamais l'énoncé — le cerveau global prend
        }
        if (!run) continue;
        setTranscript(message);
        setResponse(null);
        setIssue(null);
        setReviewRequired(false);
        setSessionPhase('thinking');
        try {
          const outcome = await run();
          if (!activeRef.current || turnGeneration !== turnGenerationRef.current) return;
          historyRef.current = [
            ...historyRef.current,
            { role: 'user' as const, text: message },
            { role: 'bob' as const, text: outcome.say },
          ].slice(-12);
          setResponse(outcome.say);
          await say(outcome.say, true);
        } catch {
          if (!activeRef.current || turnGeneration !== turnGenerationRef.current) return;
          const errorText = t('agent.global.error', { personality });
          setResponse(errorText);
          await say(errorText, true);
        }
        return;
      }

      const frozenContext = snapshotAgentContext(contextRef.current);
      setContextAtTurn(frozenContext);
      setTranscript(message);
      setResponse(null);
      setIssue(null);
      setReviewRequired(false);
      setHandoff(null);
      setSessionPhase('thinking');

      const history = historyRef.current.slice(-6);
      const userTurn: AgentConversationTurn = { role: 'user', text: message };
      historyRef.current = [...historyRef.current, userTurn].slice(-12);
      const options: ContextualAskOptions = {
        // S1 global est strictement lecture seule : aucune mutation ne peut s'auto-executer,
        // meme si l'abonnement autorise un niveau d'autonomie superieur dans le fil complet.
        autonomy: 'confirm_all',
        history,
        tone: personality,
        context: frozenContext,
      };
      const result = await agent.ask(message, options);
      if (!activeRef.current || turnGeneration !== turnGenerationRef.current) return;
      if (!result.ok) {
        const errorText = t('agent.global.error', { personality });
        setResponse(errorText);
        setSessionPhase('error');
        activeRef.current = false;
        setActive(false);
        await say(errorText, false, 'error');
        return;
      }

      const run = result.value;
      const body = run.naturalBody ?? run.card.body;
      const bobTurn: AgentConversationTurn = { role: 'bob', text: body };
      historyRef.current = [...historyRef.current, bobTurn].slice(-12);
      setResponse(body);

      // S1 est lecture seule. Une proposition mutante ou une question structuree reste visible,
      // mais n'est jamais confirmee/executée depuis l'overlay global.
      const needsReview = run.kind === 'proposed' || !!run.ask?.length || !!run.choices?.length;
      setReviewRequired(needsReview);
      if (needsReview) {
        const expiresAt = Date.now() + HANDOFF_TTL_MS;
        setHandoff(
          Object.freeze({
            id: `handoff-${turnGeneration}-${expiresAt}`,
            message,
            run,
            context: frozenContext,
            history: Object.freeze(history.map((turn) => Object.freeze({ ...turn }))),
            expiresAt,
            requestedAt: null,
          }),
        );
        activeRef.current = false;
        setActive(false);
        await voiceRef.current.cancel();
        await say(body, false);
        return;
      }

      if (isAllowedAgentNavigationRoute(run.navigate)) {
        // « Nouveau devis pour X » : le nom entendu voyage HORS route (allowlist intacte),
        // consommé une fois par le wizard à l'arrivée.
        if (run.navigateHint) setWizardHint('devis-new', run.navigateHint);
        // Navigation « Jarvis » : le SEUL agir autorisé depuis l'overlay S1 (non destructif,
        // allowlistée même après transport HTTP. L'écran d'arrivée republie son contexte au
        // focus — le tour suivant est déjà situé au bon endroit.
        router.push(run.navigate as never);
      }
      await say(body, true);
      } finally {
        turnInFlightRef.current = false;
        flushPendingGreeting();
      }
    },
    [agent, listen, personality, say, setSessionPhase, stop, flushPendingGreeting],
  );
  transcriptHandlerRef.current = (text) => {
    if (realtimeActiveRef.current) return; // exclusivité : l'ASR legacy ne nourrit jamais le temps réel
    currentTraceRef.current = { sttFinalAt: Date.now() };
    void runTurn(text);
  };

  // GUIDAGE À L'ARRIVÉE (S2-GUIDÉ) : quand l'écran/étape focalisé publie un guidage et que la
  // session est active, Bob le lit UNE fois (key stable) puis ré-écoute. Pendant un tour en
  // cours (thinking/speaking), la key est consommée sans relecture — l'affordance a déjà guidé.
  // Temps réel : tout changement de contexte FOCALISÉ déclenche la séquence stricte
  // (micro off → interrupt → PUT confirmé → micro on) — l'échec bascule en repli.
  const liveContextInstance = liveContext.screen.instanceId;
  useEffect(() => {
    if (!realtimeActiveRef.current) return;
    void realtimeRef.current?.publishContext();
  }, [liveContextInstance]);

  const start = useCallback((): void => {
    if (activeRef.current) return;
    // Nouvelle session = nouvelle mission : guidages, historique et disjoncteur repartent à zéro.
    spokenGreetingsRef.current.clear();
    historyRef.current = [];
    echoStreakRef.current = 0;
    activeRef.current = true;
    setActive(true);
    setTranscript(null);
    setResponse(null);
    setIssue(null);
    setReviewRequired(false);
    setContextAtTurn(null);
    setHandoff(null);
    void (async () => {
      // TEMPS RÉEL d'abord — le serveur décide (plan voice_live + rollout). Refusé/indispo :
      // la boucle historique reprend exactement comme avant, greeting compris.
      const outcome = await getRealtimeController().start();
      if (outcome === 'realtime') {
        realtimeActiveRef.current = true;
        return; // EXCLUSIVITÉ : aucune oreille/bouche legacy tant que le temps réel vit.
      }
      const mountedGreeting = surfaceRef.current.greeting?.key ?? null;
      if (mountedGreeting !== null) {
        // Écran monté AVANT la session : son guidage se joue au démarrage (jamais perdu).
        void speakGreeting(mountedGreeting);
      } else {
        void listen();
      }
    })();
  }, [listen, speakGreeting]);

  const dismissResponse = useCallback((): void => {
    setResponse(null);
    setTranscript(null);
    setReviewRequired(false);
    setContextAtTurn(null);
    setHandoff(null);
  }, []);

  const consumeHandoff = useCallback((id: string): void => {
    setHandoff((current) => (current?.id === id ? null : current));
    setResponse(null);
    setTranscript(null);
    setReviewRequired(false);
    setContextAtTurn(null);
  }, []);

  const requestHandoff = useCallback((id: string): void => {
    const requestedAt = Date.now();
    setHandoff((current) =>
      current?.id === id && current.expiresAt > requestedAt
        ? Object.freeze({ ...current, requestedAt })
        : current,
    );
  }, []);

  const finishListening = useCallback((): void => {
    const generation = turnGenerationRef.current;
    setSessionPhase('thinking');
    void voiceRef.current.stop().then(async () => {
      // Natif : le resultat final peut suivre `stop()` de quelques millisecondes. Cloud :
      // la transcription est delivree avant la resolution. Sans texte, retour en attente.
      await wait(700);
      if (!activeRef.current || generation !== turnGenerationRef.current) return;
      // Aucun transcript n'est arrivé : feedback honnête au lieu d'un silence inexpliqué.
      setResponse((current) => current ?? t('agent.global.heardNothing', { personality }));
      setSessionPhase('idle');
    });
  }, [personality, setSessionPhase]);

  const toggle = useCallback((): void => {
    if (!activeRef.current) {
      start();
      return;
    }
    if (phase === 'listening') {
      finishListening();
      return;
    }
    if (phase === 'idle') {
      void listen();
      return;
    }
    stop();
  }, [finishListening, listen, phase, start, stop]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      // 'background' seulement — 'inactive' (boîte de permission iOS, Control Center,
      // bandeau d'appel) ne doit pas tuer la session au premier usage du micro.
      if (state === 'background' && !voicePermissionRequestInFlight()) stop();
    });
    return () => {
      subscription.remove();
      stop();
    };
  }, [stop]);

  useEffect(() => {
    if (!handoff) return undefined;
    const delay = Math.max(0, handoff.expiresAt - Date.now());
    const id = handoff.id;
    const timer = setTimeout(() => {
      // Un ancien timer déjà placé dans la queue JS ne doit jamais effacer un passage plus
      // récent. Le ref complète le cleanup d'effet avec un fence d'identité synchrone.
      if (handoffRef.current?.id !== id) return;
      setHandoff((current) => (current?.id === id ? null : current));
      setResponse(null);
      setTranscript(null);
      setReviewRequired(false);
      setContextAtTurn(null);
    }, delay);
    return () => clearTimeout(timer);
  }, [handoff]);

  const value = useMemo<AgentSessionValue>(
    () => ({
      active,
      phase,
      transcript,
      response,
      issue,
      reviewRequired,
      contextAtTurn,
      handoff,
      start,
      stop,
      toggle,
      dismissResponse,
      requestHandoff,
      consumeHandoff,
    }),
    [
      active,
      contextAtTurn,
      consumeHandoff,
      dismissResponse,
      handoff,
      issue,
      phase,
      requestHandoff,
      response,
      reviewRequired,
      start,
      stop,
      toggle,
      transcript,
    ],
  );

  return <AgentSessionState.Provider value={value}>{children}</AgentSessionState.Provider>;
}

export function useAgentSession(): AgentSessionValue {
  const value = useContext(AgentSessionState);
  if (!value) throw new Error('useAgentSession must be used inside AgentSessionProvider');
  return value;
}

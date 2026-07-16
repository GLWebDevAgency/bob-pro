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
import { randomUUID } from 'expo-crypto';
import { echoOverlap, isAllowedAgentNavigationRoute, type AgentRun, type AskOptions , splitSpokenSentences, summarizeVoiceLatency, type VoiceLatencyTrace } from '@bob/ai';
import { t } from '@bob/i18n';
import { useTheme } from '@bob/ui';
import { makeBobAgent } from '../data/bob';
import { useBobClient } from '../data/client';
import {
  useSpeak,
  useVoiceInput,
  voicePermissionRequestInFlight,
  type VoiceInputIssue,
} from '../data/voice';
import { snapshotAgentContext, useAgentContext, useAgentSurface, type AgentContext } from './agent-context';
import {
  agentContextSemanticKey,
  realtimeOwnsAgentSession,
  shouldStopAgentSessionForAppState,
  type AgentSessionDriver,
} from './agent-session-runtime';
import { clearWizardHint, setWizardHint } from './wizard-hints';
import { RealtimeControlAcknowledgementGate } from '../realtime/realtime-control-gate';
import { RealtimeAuditedConversationTransport } from '../realtime/realtime-audited-conversation-transport';
import { ExpoRealtimeAuditedSpeechPlayback } from '../realtime/expo-realtime-audited-speech-playback';
import { RealtimeResilienceOrchestrator } from '../realtime/realtime-resilience-orchestrator';
import {
  isRealtimeWebRtcNegotiation,
  RealtimeWebRtcTransport,
} from '../realtime/webrtc-realtime-transport';
import {
  isRealtimeMistralPcmNegotiation,
  MistralRealtimeTransport,
} from '../realtime/mistral-realtime-transport';
import { RealtimeTransportError } from '../realtime/realtime-transport';
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
interface AgentSessionHandoffBase {
  readonly id: string;
  readonly message: string;
  readonly context: AgentContext;
  readonly history: readonly AgentConversationTurn[];
  readonly expiresAt: number;
  readonly requestedAt: number | null;
}

export type AgentSessionHandoff = AgentSessionHandoffBase & (
  | { readonly kind: 'run'; readonly run: AgentRun }
  | {
      readonly kind: 'proposal';
      readonly proposalId: string;
      readonly responseText: string;
    }
);

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
  const driverRef = useRef<AgentSessionDriver>('idle');
  const sessionGenerationRef = useRef(0);
  const appStateRef = useRef(AppState.currentState);
  const getRealtimeController = (): RealtimeSessionController => {
    if (realtimeRef.current) return realtimeRef.current;
    realtimeRef.current = new RealtimeSessionController(
      {
        negotiate: async () => {
          const config = await client.realtimeVoiceConfig();
          return config.ok ? config.value : null;
        },
        updateContext: async (handle, update) => client.updateRealtimeVoiceContext(handle, update),
        createOrchestrator: (negotiation, legacyFallback, currentFence, onPrimaryCreated) =>
          new RealtimeResilienceOrchestrator({
            createPrimary: () => {
              // Le provider choisi par le serveur est autoritaire : une mission n'essaie jamais
              // une seconde clé en parallèle. OpenAI reste WebRTC ; Mistral utilise son PCM natif
              // one-shot et annonce honnêtement fullDuplex=false jusqu'à certification v2.
              const uplink = isRealtimeWebRtcNegotiation(negotiation)
                ? new RealtimeWebRtcTransport(client, negotiation)
                : isRealtimeMistralPcmNegotiation(negotiation)
                  ? new MistralRealtimeTransport(client, negotiation, {
                      getInitialContext: () => snapshotAgentContext(contextRef.current),
                    })
                  : null;
              if (uplink === null) throw new RealtimeTransportError('backend_disabled');
              const transport = new RealtimeAuditedConversationTransport(uplink, {
                client,
                currentFence,
                createIdentifier: randomUUID,
                createPlayback: ({ audioLease, speechSourcePolicy }) => (
                  new ExpoRealtimeAuditedSpeechPlayback({
                    audioLease,
                    speechSourcePolicy,
                  })
                ),
              });
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
        onReview: (proposalId, proposalExpiresAt) => {
          if (!realtimeActiveRef.current) return;
          // Le controle ACKe ne contient qu'une capacite opaque. L'Assistant rechargera son
          // apercu owner-bound avant d'afficher Valider ; aucun args provider n'est accepte.
          if (!proposalId) {
            setResponse(t('assistant.proposalUnavailable', { personality }));
            setReviewRequired(false);
            setHandoff(null);
            return;
          }
          const now = Date.now();
          const advertisedExpiry = proposalExpiresAt === null
            ? Number.NaN
            : Date.parse(proposalExpiresAt);
          const expiresAt = Number.isFinite(advertisedExpiry)
            ? Math.min(advertisedExpiry, now + HANDOFF_TTL_MS)
            : now + HANDOFF_TTL_MS;
          if (expiresAt <= now) {
            setResponse(t('assistant.proposalUnavailable', { personality }));
            setReviewRequired(false);
            setHandoff(null);
            return;
          }
          const conversation = historyRef.current.slice(-12);
          const userIndex = conversation.findLastIndex((turn) => turn.role === 'user');
          const message = (userIndex >= 0 ? conversation[userIndex]?.text : null)
            ?? t('agent.global.reviewRequired', { personality });
          const history = userIndex >= 0 ? conversation.slice(0, userIndex) : conversation;
          const reviewText = t('agent.global.reviewRequired', { personality });
          setResponse(reviewText);
          setReviewRequired(true);
          setContextAtTurn(snapshotAgentContext(contextRef.current));
          setHandoff(Object.freeze({
            kind: 'proposal',
            id: `handoff-realtime-${proposalId}-${expiresAt}`,
            proposalId,
            responseText: reviewText,
            message,
            context: snapshotAgentContext(contextRef.current),
            history: Object.freeze(history.map((turn) => Object.freeze({ ...turn }))),
            expiresAt,
            requestedAt: null,
          }));
        },
        onNavigate: (route) => {
          if (!realtimeActiveRef.current) return;
          // PAS de publication ici : contextRef porte encore l'ANCIEN écran. Le montage du
          // nouvel écran change instanceId → l'effet [liveContextInstance] republie le BON
          // contexte (publier les deux créait une course qui tuait la session — P1 14/07).
          router.push(route as never);
        },
        onFallback: () => {
          // Primaire ENTIÈREMENT fermé (garantie orchestrateur) : texte honnête puis boucle
          // historique — jamais deux cerveaux.
          realtimeActiveRef.current = false;
          driverRef.current = 'legacy';
          if (!activeRef.current) return;
          setResponse(t('agent.global.liveFallback', { personality }));
          void (async () => {
            await say(t('agent.global.liveFallback', { personality }), true);
          })();
        },
        onCompleted: () => {
          realtimeActiveRef.current = false;
          driverRef.current = 'idle';
          activeRef.current = false;
          setActive(false);
          setSessionPhase('idle');
        },
        getContextSnapshot: () => snapshotAgentContext(contextRef.current),
      },
    );
    return realtimeRef.current;
  };
  const voice = useVoiceInput((text) => transcriptHandlerRef.current(text), {
    owner: 'global-agent-session',
    onIssue: (nextIssue) => {
      if (realtimeActiveRef.current) {
        // Exclusivité : la voix legacy ne tourne pas pendant le temps réel — un onIssue reçu
        // ici est un artefact (bail audio refusé) et ne doit pas peindre la session en erreur.
        console.warn('[bob-voice] onIssue ignoré (temps réel actif):', nextIssue);
        return;
      }
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
    if (
      !activeRef.current
      || driverRef.current !== 'legacy'
      || appStateRef.current !== 'active'
    ) return;
    const generation = sessionGenerationRef.current;
    setSessionPhase('listening');
    // Pas de garde sur l'état React `listening` (stale d'un tick après un écho avalé) :
    // start() est idempotent — une écoute déjà active du même flux répond true sans rien casser.
    const started = await voiceRef.current.start();
    if (
      !activeRef.current
      || generation !== sessionGenerationRef.current
      || driverRef.current !== 'legacy'
      || appStateRef.current !== 'active'
    ) {
      if (started) await voiceRef.current.cancel();
      return;
    }
    if (!started && activeRef.current) {
      console.warn('[bob-voice] session: start() a échoué — session désactivée');
      activeRef.current = false;
      setActive(false);
      setSessionPhase('error');
      // Jamais une disparition muette : si aucun onIssue n'a posé de message, celui-ci reste.
      setResponse((current) => current ?? t('agent.global.error', { personality }));
    }
  }, [personality, setSessionPhase]);

  const stopWithReason = useCallback((reason: 'user' | 'background' | 'unmount'): void => {
    // INCONDITIONNEL (P0 review 14/07) : un stop() pendant le bootstrap temps réel (avant que
    // realtimeActiveRef ne passe à true) doit quand même invalider la génération du contrôleur
    // — sinon le bootstrap aboutit et ouvre un micro fantôme sur une session affichée éteinte.
    realtimeActiveRef.current = false;
    driverRef.current = 'idle';
    sessionGenerationRef.current += 1;
    void realtimeRef.current?.stop(reason);
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

  const stop = useCallback((): void => stopWithReason('user'), [stopWithReason]);

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
            kind: 'run',
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
  const liveContextKey = agentContextSemanticKey(liveContext);
  useEffect(() => {
    if (!realtimeActiveRef.current || realtimeRef.current?.active !== true) return;
    void realtimeRef.current?.publishContext();
  }, [liveContextKey]);

  const start = useCallback((): void => {
    if (activeRef.current) return;
    // Nouvelle session = nouvelle mission : guidages, historique et disjoncteur repartent à zéro.
    spokenGreetingsRef.current.clear();
    historyRef.current = [];
    echoStreakRef.current = 0;
    const sessionGeneration = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = sessionGeneration;
    driverRef.current = 'live_bootstrap';
    // Le bootstrap possede deja la session : un second tap doit l'annuler, jamais lancer
    // l'ancien ASR pendant que WebRTC/PCM demande sa permission et son bail audio.
    realtimeActiveRef.current = true;
    activeRef.current = true;
    setActive(true);
    setTranscript(null);
    setResponse(null);
    setIssue(null);
    setReviewRequired(false);
    setContextAtTurn(null);
    setHandoff(null);
    setSessionPhase('thinking');
    void (async () => {
      // TEMPS RÉEL d'abord — le serveur décide (plan voice_live + rollout). Refusé/indispo :
      // la boucle historique reprend exactement comme avant, greeting compris.
      const controller = getRealtimeController();
      const outcome = await controller.start();
      if (
        !activeRef.current
        || sessionGeneration !== sessionGenerationRef.current
        || !realtimeOwnsAgentSession(driverRef.current)
        || appStateRef.current !== 'active'
      ) {
        // stop() est passé pendant le bootstrap : le contrôleur est déjà invalidé par
        // génération — ceinture ET bretelles, on ne laisse RIEN d'ouvert derrière soi.
        void controller.stop('user');
        return;
      }
      if (outcome === 'realtime') {
        driverRef.current = 'live';
        realtimeActiveRef.current = true;
        return; // EXCLUSIVITÉ : aucune oreille/bouche legacy tant que le temps réel vit.
      }
      if (outcome === 'fallback') return; // onFallback a DÉJÀ relancé la boucle historique
      driverRef.current = 'legacy';
      realtimeActiveRef.current = false;
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
    if (realtimeActiveRef.current) {
      // Le transport Mistral semi-duplex commit l'utterance et conserve la réponse auditée.
      // Un transport à VAD continu (OpenAI) répond false : son geste historique reste stop.
      if (phase === 'listening') {
        void realtimeRef.current?.finishUserInput().then((accepted) => {
          if (!accepted && realtimeActiveRef.current) stop();
        });
      } else {
        stop();
      }
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
      appStateRef.current = state;
      // 'background' seulement — 'inactive' (boîte de permission iOS, Control Center,
      // bandeau d'appel) ne doit pas tuer la session au premier usage du micro.
      if (shouldStopAgentSessionForAppState(state, voicePermissionRequestInFlight())) {
        stopWithReason('background');
      }
    });
    return () => {
      subscription.remove();
      stopWithReason('unmount');
    };
  }, [stopWithReason]);

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

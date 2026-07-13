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
import { echoOverlap, type AskOptions } from '@bob/ai';
import { t } from '@bob/i18n';
import { useTheme } from '@bob/ui';
import { makeBobAgent } from '../data/bob';
import { useBobClient } from '../data/client';
import { useSpeak, useVoiceInput, type VoiceInputIssue } from '../data/voice';
import { snapshotAgentContext, useAgentContext, type AgentContext } from './agent-context';

export type AgentSessionPhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

interface ConversationTurn {
  readonly role: 'user' | 'bob';
  readonly text: string;
}

export interface AgentSessionValue {
  readonly active: boolean;
  readonly phase: AgentSessionPhase;
  readonly transcript: string | null;
  readonly response: string | null;
  readonly issue: VoiceInputIssue | null;
  readonly reviewRequired: boolean;
  readonly contextAtTurn: AgentContext | null;
  readonly start: () => void;
  readonly stop: () => void;
  readonly toggle: () => void;
  readonly dismissResponse: () => void;
}

type ContextualAskOptions = AskOptions & { readonly context: AgentContext };

const AgentSessionState = createContext<AgentSessionValue | null>(null);
const ECHO_GRACE_MS = 5_000;

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

  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const [phase, setPhase] = useState<AgentSessionPhase>('idle');
  const [transcript, setTranscript] = useState<string | null>(null);
  const [response, setResponse] = useState<string | null>(null);
  const [issue, setIssue] = useState<VoiceInputIssue | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [contextAtTurn, setContextAtTurn] = useState<AgentContext | null>(null);
  const historyRef = useRef<ConversationTurn[]>([]);
  const turnGenerationRef = useRef(0);
  const lastSpokenRef = useRef<{ readonly text: string; readonly endedAt: number }>({
    text: '',
    endedAt: 0,
  });
  const echoStreakRef = useRef(0);
  const { speakAndWait, stopSpeaking } = useSpeak();

  const setSessionPhase = useCallback((next: AgentSessionPhase): void => {
    setPhase(next);
  }, []);

  const transcriptHandlerRef = useRef<(text: string) => void>(() => undefined);
  const voice = useVoiceInput((text) => transcriptHandlerRef.current(text), {
    owner: 'global-agent-session',
    onIssue: (nextIssue) => {
      setIssue(nextIssue);
      activeRef.current = false;
      setActive(false);
      setSessionPhase('error');
      setResponse(t('agent.global.unavailable', { personality }));
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
      activeRef.current = false;
      setActive(false);
      setSessionPhase('error');
    }
  }, [setSessionPhase]);

  const stop = useCallback((): void => {
    turnGenerationRef.current += 1;
    activeRef.current = false;
    setActive(false);
    echoStreakRef.current = 0;
    stopSpeaking();
    void voiceRef.current.cancel();
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
      // Semi-duplex fail-safe : aucune oreille ouverte pendant le TTS. Le tap stoppe la
      // session ; l'ecoute ne reprend qu'apres la purge, donc Bob ne peut pas se repondre.
      await speakAndWait(clean);
      lastSpokenRef.current = { text: clean, endedAt: Date.now() };
      if (!continueListening || !activeRef.current) {
        setSessionPhase(terminalPhase);
        return;
      }
      await wait(500);
      await listen();
    },
    [listen, setSessionPhase, speakAndWait],
  );

  const runTurn = useCallback(
    async (raw: string): Promise<void> => {
      const message = raw.trim();
      if (!message || !activeRef.current) return;
      turnGenerationRef.current += 1;
      const turnGeneration = turnGenerationRef.current;

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

      const frozenContext = snapshotAgentContext(contextRef.current);
      setContextAtTurn(frozenContext);
      setTranscript(message);
      setResponse(null);
      setIssue(null);
      setReviewRequired(false);
      setSessionPhase('thinking');

      const history = historyRef.current.slice(-6);
      const userTurn: ConversationTurn = { role: 'user', text: message };
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
      const bobTurn: ConversationTurn = { role: 'bob', text: body };
      historyRef.current = [...historyRef.current, bobTurn].slice(-12);
      setResponse(body);

      // S1 est lecture seule. Une proposition mutante ou une question structuree reste visible,
      // mais n'est jamais confirmee/executée depuis l'overlay global.
      const needsReview = run.kind === 'proposed' || !!run.ask?.length || !!run.choices?.length;
      setReviewRequired(needsReview);
      if (needsReview) {
        activeRef.current = false;
        setActive(false);
        await voiceRef.current.cancel();
        await say(body, false);
        return;
      }

      // `run.navigate` est volontairement ignore : le contexte courant reste a l'ecran.
      await say(body, true);
    },
    [agent, listen, personality, say, setSessionPhase, stop],
  );
  transcriptHandlerRef.current = (text) => {
    void runTurn(text);
  };

  const start = useCallback((): void => {
    if (activeRef.current) return;
    activeRef.current = true;
    setActive(true);
    setTranscript(null);
    setResponse(null);
    setIssue(null);
    setReviewRequired(false);
    void listen();
  }, [listen]);

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
      if (state === 'background') stop();
    });
    return () => {
      subscription.remove();
      stop();
    };
  }, [stop]);

  const value = useMemo<AgentSessionValue>(
    () => ({
      active,
      phase,
      transcript,
      response,
      issue,
      reviewRequired,
      contextAtTurn,
      start,
      stop,
      toggle,
      dismissResponse: () => {
        setResponse(null);
        setTranscript(null);
        setReviewRequired(false);
      },
    }),
    [
      active,
      contextAtTurn,
      issue,
      phase,
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

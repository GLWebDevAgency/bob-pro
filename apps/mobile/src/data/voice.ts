import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Platform } from 'react-native';
import * as Speech from 'expo-speech';
import {
  processAudioSession,
  type ProcessAudioLease,
} from '../audio';
import {
  abortNativeSpeechAndWait,
  nativeSpeechRecognitionModule as ExpoSpeechRecognitionModule,
  speechRecognitionAvailable,
  supportsStrictOnDeviceSpeechLocale,
  useNativeSpeechRecognitionEvent as useSpeechRecognitionEvent,
} from './native-speech-recognition-adapter';

export { speechRecognitionAvailable };
import {
  advanceNativeSpeechTerminal,
  classifyNativeSpeechError,
  openNativeSpeechTerminal,
  supportsPrivateNativeSpeech,
  terminalEventForNativeSpeechError,
  type NativeSpeechCommand,
  type NativeSpeechTerminalEvent,
  type NativeSpeechTerminalTransition,
} from './native-speech-session';
import { neutralizeLegacyCloudVoiceMode } from './settings';

/** Accroc du canal voix : refus micro, module natif absent (Expo Go), transcription ratée. */
export type VoiceInputIssue = 'denied' | 'unavailable' | 'failed';
export type VoiceOutputOutcome = 'completed' | 'interrupted' | 'failed' | 'timed_out';

interface NativeTtsOperation {
  readonly generation: number;
  readonly lease: ProcessAudioLease;
  readonly onFinished: (outcome: VoiceOutputOutcome) => void;
  timer: ReturnType<typeof setTimeout> | null;
  stopPromise: Promise<boolean> | null;
  settled: boolean;
}

interface NativeReleaseWaiter {
  readonly generation: number;
  readonly promise: Promise<boolean>;
  readonly resolve: (released: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

type VoiceLeaseState = 'active' | 'closing';

interface VoiceLease {
  readonly owner: symbol;
  readonly generation: number;
  readonly audioLease: ProcessAudioLease;
  state: VoiceLeaseState;
}

/**
 * Lease process-wide : expo-speech-recognition diffuse ses evenements a tous les hooks
 * montes. La generation fence aussi les callbacks/timers tardifs d'une ancienne ecoute.
 */
let activeVoiceLease: VoiceLease | null = null;
const NATIVE_TERMINAL_GRACE_MS = 350;
const NATIVE_END_WATCHDOG_MS = 2_000;
const NATIVE_END_WATCHDOG_MAX_CHECKS = 4;
const NATIVE_CAPABILITY_TIMEOUT_MS = 2_000;
const NATIVE_CANCEL_RELEASE_TIMEOUT_MS =
  NATIVE_CAPABILITY_TIMEOUT_MS + NATIVE_TERMINAL_GRACE_MS + 250;
const PRIVATE_SPEECH_NEGATIVE_CACHE_MS = 30_000;
const NATIVE_TTS_MIN_TIMEOUT_MS = 5_000;
const NATIVE_TTS_MAX_TIMEOUT_MS = 45_000;
const PERMISSION_LIFECYCLE_STABILIZATION_MS = 1_000;

/**
 * Demande de permission EN COURS : sur Android, la boîte système passe l'app en
 * 'background' (pas 'inactive' comme iOS) — sans ce drapeau, le nettoyage AppState
 * tuerait la session pendant que l'utilisateur accorde le micro (bulle disparue).
 */
export function voicePermissionRequestInFlight(): boolean {
  return processAudioSession.permissionRequestInFlight();
}

/**
 * Résout uniquement lorsque toutes les boîtes de permission audio du processus sont refermées.
 * Les consommateurs AppState doivent ensuite relire l'état réel : Android peut avoir publié un
 * faux `background` pendant la boîte, mais l'utilisateur peut aussi avoir réellement quitté Bob.
 */
export function waitForVoicePermissionRequests(): Promise<void> {
  return processAudioSession.waitForPermissionRequests();
}

/**
 * Android livre parfois `onRequestPermissionsResult` juste avant `onResume`. On attend donc le
 * vrai signal `active`, avec une borne courte si l'utilisateur a réellement quitté l'app. Cette
 * attente ne possède pas le micro et nettoie toujours son listener.
 */
export function waitForVoicePermissionLifecycleStabilization(): Promise<void> {
  if (AppState.currentState === 'active') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let subscription: { remove(): void } | null = null;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.remove();
      resolve();
    };
    const timer = setTimeout(settle, PERMISSION_LIFECYCLE_STABILIZATION_MS);
    subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') settle();
    });
    if (settled) subscription.remove();
    // Ferme la course « active entre le premier test et l'installation du listener ».
    if (AppState.currentState === 'active') settle();
  });
}

/** Porte commune legacy/Realtime : aucun moteur ne passe ON hors état applicatif actif. */
export async function voiceMayActivateMicrophone(): Promise<boolean> {
  await waitForVoicePermissionLifecycleStabilization();
  return AppState.currentState === 'active';
}

async function withPermissionRequest<T>(run: () => Promise<T>): Promise<T> {
  return processAudioSession.withPermissionRequest(run);
}

async function withNativeCapabilityTimeout<T>(run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('native_speech_capability_timeout')),
          NATIVE_CAPABILITY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function acquireVoiceLease(
  owner: symbol,
  ownerName: string,
  onPreempt: () => void | Promise<void>,
): Promise<number | null> {
  // Meme owner compris : un second start ne doit jamais reutiliser une session en cours.
  if (activeVoiceLease !== null) return null;
  const acquired = await processAudioSession.acquire({
    owner: ownerName,
    mode: 'legacy_input',
    onPreempt,
  });
  if (!acquired.ok) return null;
  const generation = acquired.lease.generation;
  activeVoiceLease = { owner, generation, audioLease: acquired.lease, state: 'active' };
  return generation;
}

function matchesVoiceLease(owner: symbol, generation: number, state?: VoiceLeaseState): boolean {
  return (
    activeVoiceLease?.owner === owner &&
    activeVoiceLease.generation === generation &&
    processAudioSession.isCurrent(activeVoiceLease.audioLease) &&
    (state === undefined || activeVoiceLease.state === state)
  );
}

function closeVoiceLease(owner: symbol, generation: number): boolean {
  if (!matchesVoiceLease(owner, generation)) return false;
  activeVoiceLease!.state = 'closing';
  return true;
}

function releaseVoiceLease(owner: symbol, generation: number): boolean {
  if (!matchesVoiceLease(owner, generation)) return false;
  processAudioSession.release(activeVoiceLease?.audioLease);
  activeVoiceLease = null;
  return true;
}

/**
 * Entrée vocale de Bob : reconnaissance locale forcée via expo-speech-recognition. L'ancien STT
 * cloud sans sélecteur/disclosure est fermé ; l'indisponibilité locale mène au texte. La voix
 * n'est qu'un canal :
 * transcription -> onTranscript(text) -> MÊME cerveau Bob.
 * NB : nécessite un build natif (les modules micro ne tournent pas en bundle JS pur).
 * `onIssue` (optionnel) : l'écran affiche l'état honnête lui-même (C20) au lieu des Alert historiques.
 */
export function useVoiceInput(
  onTranscript: (text: string) => void,
  opts: {
    onIssue?: (issue: VoiceInputIssue) => void;
    onPartial?: (text: string) => void;
    owner?: string;
  } = {},
) {
  const [listening, setListening] = useState(false);
  const leaseOwnerName = useRef(opts.owner ?? 'bob-voice-input').current;
  const lease = useRef(Symbol(leaseOwnerName)).current;
  const preemptRef = useRef<() => Promise<void>>(async () => undefined);
  const mountedRef = useRef(true);
  const startIntentGenerationRef = useRef(0);
  const startInFlightRef = useRef<{
    readonly intentGeneration: number;
    readonly promise: Promise<boolean>;
  } | null>(null);
  const sessionRef = useRef<{
    generation: number;
    mode: 'native';
  } | null>(null);
  const nativeTerminalRef = useRef<ReturnType<typeof openNativeSpeechTerminal> | null>(null);
  const nativeEndGraceTimerRef = useRef<{
    readonly generation: number;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const nativeEndWatchdogRef = useRef<{
    readonly generation: number;
    readonly attempt: number;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const nativeReleaseWaiterRef = useRef<NativeReleaseWaiter | null>(null);
  const privateSpeechCapabilityRef = useRef<{
    readonly key: string;
    readonly supported: boolean;
    readonly retryAfter: number;
  } | null>(null);
  const ownsLease = useCallback(() => {
    const session = sessionRef.current;
    return session !== null && matchesVoiceLease(lease, session.generation);
  }, [lease]);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const onIssueRef = useRef(opts.onIssue);
  onIssueRef.current = opts.onIssue;
  const onPartialRef = useRef(opts.onPartial);
  onPartialRef.current = opts.onPartial;
  const report = useCallback((issue: VoiceInputIssue, title: string, message: string): void => {
    console.warn('[bob-voice] issue:', issue);
    if (onIssueRef.current) onIssueRef.current(issue);
    else Alert.alert(title, message);
  }, []);

  const setGenerationListening = useCallback((generation: number, value: boolean): void => {
    if (sessionRef.current?.generation === generation) setListening(value);
  }, []);

  const settleNativeReleaseWaiter = useCallback((
    generation: number,
    released: boolean,
  ): void => {
    const waiter = nativeReleaseWaiterRef.current;
    if (waiter?.generation !== generation) return;
    nativeReleaseWaiterRef.current = null;
    clearTimeout(waiter.timer);
    waiter.resolve(released);
  }, []);

  const waitForNativeGenerationRelease = useCallback((generation: number): Promise<boolean> => {
    if (!matchesVoiceLease(lease, generation)) return Promise.resolve(true);
    const current = nativeReleaseWaiterRef.current;
    if (current?.generation === generation) return current.promise;
    if (current !== null) {
      clearTimeout(current.timer);
      current.resolve(false);
    }
    let resolve!: (released: boolean) => void;
    const promise = new Promise<boolean>((settle) => { resolve = settle; });
    const timer = setTimeout(() => {
      const waiter = nativeReleaseWaiterRef.current;
      if (waiter?.generation !== generation) return;
      nativeReleaseWaiterRef.current = null;
      waiter.resolve(false);
    }, NATIVE_CANCEL_RELEASE_TIMEOUT_MS);
    nativeReleaseWaiterRef.current = { generation, promise, resolve, timer };
    return promise;
  }, [lease]);

  const releaseGeneration = useCallback(
    (generation: number): boolean => {
      if (!releaseVoiceLease(lease, generation)) return false;
      if (nativeEndWatchdogRef.current?.generation === generation) {
        clearTimeout(nativeEndWatchdogRef.current.timer);
        nativeEndWatchdogRef.current = null;
      }
      if (nativeEndGraceTimerRef.current?.generation === generation) {
        clearTimeout(nativeEndGraceTimerRef.current.timer);
        nativeEndGraceTimerRef.current = null;
      }
      if (sessionRef.current?.generation === generation) {
        sessionRef.current = null;
        setListening(false);
      }
      settleNativeReleaseWaiter(generation, true);
      return true;
    },
    [lease, settleNativeReleaseWaiter],
  );

  const advanceNativeTerminal = useCallback(
    (
      generation: number,
      event: NativeSpeechTerminalEvent,
    ): NativeSpeechTerminalTransition | null => {
      const current = nativeTerminalRef.current;
      if (current === null) return null;
      const transition = advanceNativeSpeechTerminal(current, generation, event);
      nativeTerminalRef.current = transition.next;
      return transition;
    },
    [],
  );

  const clearNativeEndWatchdog = useCallback((generation: number): void => {
    const pending = nativeEndWatchdogRef.current;
    if (pending?.generation !== generation) return;
    clearTimeout(pending.timer);
    nativeEndWatchdogRef.current = null;
  }, []);

  const releaseNativeGenerationAfterEndGrace = useCallback(
    (generation: number): void => {
      if (nativeEndGraceTimerRef.current?.generation === generation) return;
      if (nativeEndGraceTimerRef.current !== null) {
        clearTimeout(nativeEndGraceTimerRef.current.timer);
      }
      const timer = setTimeout(() => {
        // La grâce termine honnêtement un cycle sans résultat. Le release reste fencé par la
        // génération ET n'est armé qu'après le `end` contractuellement dernier chez Expo.
        advanceNativeTerminal(generation, 'grace_expired');
        releaseGeneration(generation);
        if (nativeEndGraceTimerRef.current?.generation === generation) {
          nativeEndGraceTimerRef.current = null;
        }
      }, NATIVE_TERMINAL_GRACE_MS);
      nativeEndGraceTimerRef.current = { generation, timer };
    },
    [advanceNativeTerminal, releaseGeneration],
  );

  const dispatchNativeCommand = useCallback(
    (generation: number, command: NativeSpeechCommand): void => {
      if (command === 'none') return;
      const dispatchAbortBarrier = (): void => {
        const lifecycle = nativeTerminalRef.current?.lifecycle;
        void withNativeCapabilityTimeout(abortNativeSpeechAndWait).then((completed) => {
          if (!completed) {
            // Sans le barrier patché, un abort pendant `starting` pourrait gagner avant la Task
            // start iOS. On ferme donc la capacité au lieu de rendre un lease faussement libre.
            if (lifecycle !== 'starting') ExpoSpeechRecognitionModule?.abort();
            settleNativeReleaseWaiter(generation, false);
            return;
          }
          const transition = advanceNativeTerminal(generation, 'abort_completed');
          if (transition?.changed !== true) return;
          clearNativeEndWatchdog(generation);
          releaseNativeGenerationAfterEndGrace(generation);
        }).catch(() => {
          console.warn('[bob-voice] native abort barrier unavailable');
          settleNativeReleaseWaiter(generation, false);
        });
      };
      try {
        if (command === 'stop') {
          ExpoSpeechRecognitionModule?.stop();
          return;
        }
        dispatchAbortBarrier();
      } catch {
        const issueTransition = advanceNativeTerminal(generation, 'issue');
        if (issueTransition?.effect === 'issue') {
          report('failed', 'Dictée', "La commande d'écoute n'a pas pu être appliquée.");
        }
        // Un stop synchrone refusé est promu vers un unique abort. Un abort refusé reste en
        // quarantaine : surtout pas de release au timer sans preuve native.
        if (command === 'stop') {
          const abortTransition = advanceNativeTerminal(generation, 'cancel_requested');
          if (abortTransition?.command === 'abort') {
            dispatchAbortBarrier();
          }
        }
      }
    },
    [
      advanceNativeTerminal,
      clearNativeEndWatchdog,
      releaseNativeGenerationAfterEndGrace,
      report,
      settleNativeReleaseWaiter,
    ],
  );

  const armNativeEndWatchdog = useCallback(
    (generation: number): void => {
      if (nativeEndWatchdogRef.current?.generation === generation) return;
      if (nativeEndWatchdogRef.current !== null) {
        clearTimeout(nativeEndWatchdogRef.current.timer);
      }

      const scheduleCheck = (attempt: number): void => {
        if (
          sessionRef.current?.generation !== generation
          || !matchesVoiceLease(lease, generation)
          || nativeTerminalRef.current?.lifecycle === 'ended'
        ) return;
        const timer = setTimeout(() => {
          if (
            nativeEndWatchdogRef.current?.generation === generation
            && nativeEndWatchdogRef.current.attempt === attempt
          ) nativeEndWatchdogRef.current = null;
          if (
            sessionRef.current?.generation !== generation
            || !matchesVoiceLease(lease, generation)
            || nativeTerminalRef.current?.lifecycle === 'ended'
          ) return;

          const retryOrQuarantine = (reason: string): void => {
            if (attempt < NATIVE_END_WATCHDOG_MAX_CHECKS) {
              scheduleCheck(attempt + 1);
              return;
            }
            // Sans `end` ni preuve ordonnée, N conserve le lease. On arrête seulement le polling
            // pour ne pas maintenir un composant démonté en vie indéfiniment.
            console.warn('[bob-voice] native end quarantined:', reason);
            settleNativeReleaseWaiter(generation, false);
          };

          let stateRequest: ReturnType<NonNullable<
            typeof ExpoSpeechRecognitionModule
          >['getStateAsync']>;
          try {
            const nativeModule = ExpoSpeechRecognitionModule;
            if (nativeModule === null) {
              retryOrQuarantine('module_unavailable');
              return;
            }
            stateRequest = withNativeCapabilityTimeout(
              () => nativeModule.getStateAsync(),
            );
          } catch {
            retryOrQuarantine('state_query_threw');
            return;
          }
          void stateRequest.then((state) => {
            if (
              sessionRef.current?.generation !== generation
              || !matchesVoiceLease(lease, generation)
              || nativeTerminalRef.current?.lifecycle === 'ended'
            ) return;

            // Si l'ack `start` React a été perdu (notamment au démontage), un état natif actif
            // constitue la preuve ordonnée que start a réellement gagné. La commande différée
            // peut alors être envoyée une seule fois et `inactive` suivant devient probant.
            if (nativeTerminalRef.current?.lifecycle === 'starting') {
              if (state !== 'inactive') {
                const activity = advanceNativeTerminal(generation, 'native_active');
                dispatchNativeCommand(generation, activity?.command ?? 'none');
                // La commande vient seulement d'être installée. Un nouveau snapshot est exigé :
                // on ne réutilise jamais l'ancien `inactive` comme preuve terminale.
                retryOrQuarantine(`command_dispatched:${state}`);
                return;
              }
            }

            const lifecycle = nativeTerminalRef.current?.lifecycle;
            const command = nativeTerminalRef.current?.command;
            // Pendant un abort, le module patché retire intentionnellement le recognizer public
            // avant de terminer son teardown. `getStateAsync() === inactive` décrit alors le slot,
            // pas la fin de la ressource en cours de retrait. Seule la résolution de
            // `abortAndWaitAsync` est une preuve terminale ; sinon N reste en quarantaine.
            const inactiveIsAuthoritative = state === 'inactive'
              && command !== 'abort'
              && (lifecycle === 'arming' || lifecycle === 'started');
            if (!inactiveIsAuthoritative) {
              retryOrQuarantine(`${lifecycle ?? 'missing'}:${state}`);
              return;
            }
            const transition = advanceNativeTerminal(generation, 'end');
            if (transition?.changed === true) {
              releaseNativeGenerationAfterEndGrace(generation);
            }
          }).catch(() => retryOrQuarantine('state_query_rejected'));
        }, NATIVE_END_WATCHDOG_MS);
        nativeEndWatchdogRef.current = { generation, attempt, timer };
      };

      scheduleCheck(1);
    }, [
      advanceNativeTerminal,
      dispatchNativeCommand,
      lease,
      releaseNativeGenerationAfterEndGrace,
      settleNativeReleaseWaiter,
    ],
  );

  // —— Événements de la reconnaissance NATIVE ——
  useSpeechRecognitionEvent('start', () => {
    const session = sessionRef.current;
    if (session?.mode !== 'native' || !matchesVoiceLease(lease, session.generation)) return;
    const transition = advanceNativeTerminal(session.generation, 'start');
    if (transition !== null && transition.command !== 'none') {
      dispatchNativeCommand(session.generation, transition.command);
      armNativeEndWatchdog(session.generation);
    }
  });
  useSpeechRecognitionEvent('result', (e) => {
    const session = sessionRef.current;
    if (session?.mode !== 'native' || !matchesVoiceLease(lease, session.generation)) {
      return;
    }
    const generation = session.generation;
    const text = e.results?.[0]?.transcript?.trim();
    if (e.isFinal) {
      const transition = advanceNativeTerminal(generation, 'final');
      if (transition?.effect !== 'transcript') return;
      setGenerationListening(generation, false);
      closeVoiceLease(lease, generation);
      armNativeEndWatchdog(generation);
      if (text) onTranscriptRef.current(text);
    } else if (
      text
      && nativeTerminalRef.current?.generation === generation
      && nativeTerminalRef.current.state === 'open'
      && matchesVoiceLease(lease, generation, 'active')
    ) {
      // Résultats PARTIELS (LIVE-3 barge-in) : détecter la parole pendant que Bob parle.
      onPartialRef.current?.(text);
    }
  });
  useSpeechRecognitionEvent('end', () => {
    const session = sessionRef.current;
    if (session?.mode !== 'native' || !matchesVoiceLease(lease, session.generation)) {
      return;
    }
    const transition = advanceNativeTerminal(session.generation, 'end');
    if (transition?.changed !== true) return;
    setGenerationListening(session.generation, false);
    closeVoiceLease(lease, session.generation);
    clearNativeEndWatchdog(session.generation);
    // Le contrat Expo place `end` en dernier. La grâce absorbe seulement la file JS/bridge avant
    // de terminaliser le silence et de rendre le lease ; jamais un timer armé par final/error.
    releaseNativeGenerationAfterEndGrace(session.generation);
  });
  useSpeechRecognitionEvent('nomatch', () => {
    const session = sessionRef.current;
    if (session?.mode !== 'native' || !matchesVoiceLease(lease, session.generation)) return;
    const transition = advanceNativeTerminal(session.generation, 'silence');
    if (transition?.effect !== 'silence') return;
    setGenerationListening(session.generation, false);
    closeVoiceLease(lease, session.generation);
    armNativeEndWatchdog(session.generation);
  });
  useSpeechRecognitionEvent('error', (e) => {
    const session = sessionRef.current;
    if (session?.mode !== 'native' || !matchesVoiceLease(lease, session.generation)) {
      return;
    }
    const decision = classifyNativeSpeechError(e);
    if (decision.errorCode === 'language-not-supported') {
      privateSpeechCapabilityRef.current = null;
    }
    const transition = advanceNativeTerminal(
      session.generation,
      terminalEventForNativeSpeechError(decision),
    );
    if (transition?.changed !== true) return;

    setGenerationListening(session.generation, false);
    closeVoiceLease(lease, session.generation);
    armNativeEndWatchdog(session.generation);
    if (transition.effect !== 'issue' || decision.disposition === 'ignore') return;
    // Diagnostic fermé et exactement-une-fois : jamais le message libre du moteur, encore moins
    // un transcript. Les événements tardifs/dupliqués ont déjà été absorbés par le terminal.
    console.warn(
      '[bob-voice] native error:',
      decision.errorCode,
      'nativeCode=',
      decision.nativeCode ?? 'none',
    );
    if (decision.disposition === 'denied') {
      report('denied', 'Micro', 'Autorise le micro pour parler à Bob.');
    } else if (decision.disposition === 'unavailable') {
      report('unavailable', 'Dictée', "Le service de dictée native n'est pas disponible.");
    } else {
      report('failed', 'Dictée', 'La dictée a échoué. Réessaie.');
    }
  });

  const startCore = useCallback(async (
    startIntentGeneration: number,
  ): Promise<boolean> => {
    const startIntentIsCurrent = (): boolean => (
      mountedRef.current
      && startIntentGenerationRef.current === startIntentGeneration
    );
    const onPreempt = async (): Promise<void> => {
      await preemptRef.current();
      // La reconnaissance native conserve une courte grâce pour son résultat terminal.
      // Realtime n'acquiert le micro qu'après la libération effective de cette génération.
      if (activeVoiceLease?.owner === lease) {
        await new Promise((resolve) => setTimeout(resolve, NATIVE_TERMINAL_GRACE_MS + 50));
      }
    };
    let generation = await acquireVoiceLease(lease, leaseOwnerName, onPreempt);
    if (!startIntentIsCurrent()) {
      if (generation !== null) releaseVoiceLease(lease, generation);
      return false;
    }
    if (generation === null && activeVoiceLease?.owner === lease) {
      // AUTO-COLLISION du même flux — jamais une « erreur micro » : ① l'écoute est encore
      // ACTIVE → l'intention de l'appelant (être à l'écoute) est déjà satisfaite ; ② elle se
      // REFERME (grâce post-final, ex. écho avalé qui ré-écoute aussitôt) → on attend sa
      // libération puis on rouvre une génération fraîche (les timers N restent fencés).
      if (activeVoiceLease.state === 'active') return true;
      await new Promise((resolve) => setTimeout(resolve, NATIVE_TERMINAL_GRACE_MS + 50));
      if (!startIntentIsCurrent()) return false;
      generation = await acquireVoiceLease(lease, leaseOwnerName, onPreempt);
      if (!startIntentIsCurrent()) {
        if (generation !== null) releaseVoiceLease(lease, generation);
        return false;
      }
    }
    if (generation === null) {
      if (!startIntentIsCurrent()) return false;
      report('unavailable', 'Micro', 'Le micro est déjà utilisé par un autre flux Bob.');
      return false;
    }
    sessionRef.current = { generation, mode: 'native' };
    nativeTerminalRef.current = openNativeSpeechTerminal(generation);
    try {
      const nativeModule = ExpoSpeechRecognitionModule;
      if (!nativeModule) {
        releaseGeneration(generation);
        report('unavailable', 'Dictée', "La dictée native n'est pas disponible ici.");
        return false;
      }
      const capabilityKey = `${Platform.OS}:${String(Platform.Version)}:fr-FR`;
      const platformEligible = Platform.OS === 'ios' || (
        Platform.OS === 'android'
        && typeof Platform.Version === 'number'
        && Number.isInteger(Platform.Version)
        && Platform.Version >= 33
      );
      const cachedCapability = privateSpeechCapabilityRef.current;
      const cachedPositive = cachedCapability?.key === capabilityKey
        && cachedCapability.supported;
      const cachedNegative = cachedCapability?.key === capabilityKey
        && !cachedCapability.supported
        && Date.now() < cachedCapability.retryAfter;
      if (!platformEligible || cachedNegative) {
        releaseGeneration(generation);
        report(
          'unavailable',
          'Dictée',
          "La dictée locale française n'est pas disponible sur cet appareil.",
        );
        return false;
      }
      if (!cachedPositive) {
        const supportedLocales = await withNativeCapabilityTimeout(
          () => nativeModule.getSupportedLocales({}),
        );
        if (!startIntentIsCurrent() || !matchesVoiceLease(lease, generation, 'active')) {
          return false;
        }
        if (!supportsPrivateNativeSpeech({
          platform: Platform.OS,
          platformVersion: Platform.Version,
          supportsOnDeviceRecognition: supportsStrictOnDeviceSpeechLocale('fr-FR'),
          installedLocales: supportedLocales.installedLocales,
          requestedLocale: 'fr-FR',
        })) {
          privateSpeechCapabilityRef.current = {
            key: capabilityKey,
            supported: false,
            retryAfter: Date.now() + PRIVATE_SPEECH_NEGATIVE_CACHE_MS,
          };
          releaseGeneration(generation);
          report(
            'unavailable',
            'Dictée',
            "La dictée locale française n'est pas disponible sur cet appareil.",
          );
          return false;
        }
        // Le bridge Android 56.0.1 crée un executor pour getSupportedLocales. Une preuve positive
        // est donc mémorisée pendant la vie du hook au lieu de refaire ce coût à chaque phrase.
        privateSpeechCapabilityRef.current = {
          key: capabilityKey,
          supported: true,
          retryAfter: Number.POSITIVE_INFINITY,
        };
      }
      const perm = await withPermissionRequest(
        () => nativeModule.requestMicrophonePermissionsAsync(),
      );
      if (!startIntentIsCurrent() || !matchesVoiceLease(lease, generation, 'active')) {
        console.warn('[bob-voice] start annulé pendant la permission (lease invalidé)');
        return false;
      }
      if (!perm.granted) {
        releaseGeneration(generation);
        report('denied', 'Micro', 'Autorise le micro pour parler à Bob.');
        return false;
      }
      if (!(await voiceMayActivateMicrophone()) || !startIntentIsCurrent()) {
        if (matchesVoiceLease(lease, generation)) releaseGeneration(generation);
        return false;
      }
      if (!matchesVoiceLease(lease, generation, 'active')) return false;
      const nativeState = await withNativeCapabilityTimeout(() => nativeModule.getStateAsync());
      if (!startIntentIsCurrent() || !matchesVoiceLease(lease, generation, 'active')) return false;
      if (nativeState !== 'inactive') {
        releaseGeneration(generation);
        report('unavailable', 'Dictée', "Le service de dictée termine encore l'écoute précédente.");
        return false;
      }
      setGenerationListening(generation, true);
      nativeModule.start({
        lang: 'fr-FR',
        interimResults: !!onPartialRef.current,
        continuous: false,
        // Invariant RGPD : aucun recognizer réseau. Sans modèle fr-FR local, l'erreur native
        // devient une indisponibilité honnête et la sortie texte est proposée.
        requiresOnDeviceRecognition: true,
      });
      advanceNativeTerminal(generation, 'start_requested');
      return true;
    } catch {
      // Une ancienne continuation async ne modifie jamais la generation qui lui a succede.
      if (startIntentIsCurrent() && matchesVoiceLease(lease, generation)) {
        setGenerationListening(generation, false);
        releaseGeneration(generation);
        report('unavailable', 'Dictée', "Le micro n'a pas pu démarrer.");
      }
      return false;
    }
  }, [
    advanceNativeTerminal,
    lease,
    leaseOwnerName,
    releaseGeneration,
    report,
    setGenerationListening,
  ]);

  const start = useCallback((): Promise<boolean> => {
    const inFlight = startInFlightRef.current;
    if (
      inFlight !== null
      && inFlight.intentGeneration === startIntentGenerationRef.current
    ) return inFlight.promise;

    const intentGeneration = ++startIntentGenerationRef.current;
    const run = (): Promise<boolean> => (
      mountedRef.current && startIntentGenerationRef.current === intentGeneration
        ? startCore(intentGeneration)
        : Promise.resolve(false)
    );
    const pending = inFlight === null
      ? run()
      : inFlight.promise.then(run, run);
    const entry = { intentGeneration, promise: pending } as const;
    startInFlightRef.current = entry;
    const clear = (): void => {
      if (startInFlightRef.current === entry) startInFlightRef.current = null;
    };
    void pending.then(clear, clear);
    return pending;
  }, [startCore]);

  const stop = useCallback(async () => {
    startIntentGenerationRef.current += 1;
    startInFlightRef.current = null;
    const session = sessionRef.current;
    if (!session || !matchesVoiceLease(lease, session.generation, 'active')) return;
    const { generation } = session;
    const lifecycle = nativeTerminalRef.current?.lifecycle;
    closeVoiceLease(lease, generation);
    const transition = advanceNativeTerminal(generation, 'stop_requested');
    setGenerationListening(generation, false);
    if (lifecycle === 'arming') {
      advanceNativeTerminal(generation, 'end');
      releaseGeneration(generation);
      return;
    }
    dispatchNativeCommand(generation, transition?.command ?? 'none');
    armNativeEndWatchdog(generation);
  }, [
    lease,
    setGenerationListening,
    advanceNativeTerminal,
    armNativeEndWatchdog,
    dispatchNativeCommand,
    releaseGeneration,
  ]);

  /** Abandon sans transcription : background, unmount ou changement de proprietaire. */
  const cancel = useCallback(async (): Promise<boolean> => {
    startIntentGenerationRef.current += 1;
    startInFlightRef.current = null;
    const session = sessionRef.current;
    if (!session || !matchesVoiceLease(lease, session.generation)) return true;
    const { generation } = session;
    const lifecycle = nativeTerminalRef.current?.lifecycle;
    const nativeTransition = advanceNativeTerminal(generation, 'cancel_requested');
    closeVoiceLease(lease, generation);
    setGenerationListening(generation, false);
    if (lifecycle === 'arming') {
      advanceNativeTerminal(generation, 'end');
      releaseGeneration(generation);
      return true;
    }
    dispatchNativeCommand(generation, nativeTransition?.command ?? 'none');
    armNativeEndWatchdog(generation);
    return waitForNativeGenerationRelease(generation);
  }, [
    lease,
    setGenerationListening,
    advanceNativeTerminal,
    armNativeEndWatchdog,
    dispatchNativeCommand,
    releaseGeneration,
    waitForNativeGenerationRelease,
  ]);
  preemptRef.current = async () => { await cancel(); };

  useEffect(() => {
    mountedRef.current = true;
    void neutralizeLegacyCloudVoiceMode();
    const subscription = AppState.addEventListener('change', (state) => {
      // 'background' SEULEMENT : sur iOS, la boîte de permission micro, le Control Center ou
      // un bandeau d'appel passent l'app en 'inactive' — annuler là tuerait le PREMIER usage
      // du micro pendant que l'utilisateur accorde la permission.
      if (state === 'background' && !voicePermissionRequestInFlight()) void cancel();
    });
    return () => {
      mountedRef.current = false;
      startIntentGenerationRef.current += 1;
      subscription.remove();
      void cancel();
    };
  }, [cancel]);

  return { listening, start, stop, cancel, ownsLease };
}

/**
 * Sortie vocale de Bob (TTS) — miroir de useVoiceInput, avec le MÊME texte de domaine.
 * Le moteur classique est exclusivement expo-speech. Le canal Bob Live possède son transport
 * audité distinct ; une préférence historique `cloud` ne peut donc lancer aucun transfert ici.
 * Les montants viennent du domaine (jamais inventés) -> sûrs à vocaliser.
 */
export function useSpeak() {
  const outputLeaseRef = useRef<ProcessAudioLease | null>(null);
  const outputOperationRef = useRef<NativeTtsOperation | null>(null);
  const outputGenerationRef = useRef(0);
  const outputIntentGenerationRef = useRef(0);
  const outputMountedRef = useRef(true);
  const outputOwner = useRef('bob-legacy-output').current;
  const preemptOutputRef = useRef<() => Promise<void>>(async () => undefined);

  const releaseOutputLease = useCallback((): void => {
    const lease = outputLeaseRef.current;
    outputLeaseRef.current = null;
    if (lease !== null) processAudioSession.release(lease);
  }, []);

  const releaseOutputOperation = useCallback((operation: NativeTtsOperation): void => {
    if (outputOperationRef.current !== operation) return;
    outputOperationRef.current = null;
    if (outputLeaseRef.current?.token === operation.lease.token) releaseOutputLease();
  }, [releaseOutputLease]);

  const settleOutputOperation = useCallback((
    operation: NativeTtsOperation,
    outcome: VoiceOutputOutcome,
    release: boolean,
  ): boolean => {
    const firstSettlement = !operation.settled;
    if (firstSettlement) {
      operation.settled = true;
      if (operation.timer !== null) {
        clearTimeout(operation.timer);
        operation.timer = null;
      }
      operation.onFinished(outcome);
    }
    // Un callback terminal natif tardif reste une preuve de fin valide même si le consommateur a
    // déjà été réglé par stop/timeout. Il libère N sans jamais rappeler le consommateur ni N+1.
    if (release) releaseOutputOperation(operation);
    return firstSettlement;
  }, [releaseOutputOperation]);

  const stopOutputOperation = useCallback(async (
    operation: NativeTtsOperation,
    outcome: 'interrupted' | 'timed_out',
  ): Promise<boolean> => {
    // Résout immédiatement l'ancien consommateur et annule son watchdog. Le lease reste pourtant
    // détenu tant que le moteur n'a pas confirmé son arrêt : aucune génération N+1 ne se superpose.
    settleOutputOperation(operation, outcome, false);
    if (operation.stopPromise !== null) return operation.stopPromise;
    operation.stopPromise = (async () => {
      let stopped = false;
      try {
        await withNativeCapabilityTimeout(() => Promise.resolve(Speech.stop()));
        stopped = true;
      } catch {
        try {
          stopped = !(await withNativeCapabilityTimeout(() => Speech.isSpeakingAsync()));
        } catch {
          stopped = false;
        }
      }
      if (stopped) {
        releaseOutputOperation(operation);
      } else {
        // Fail-closed : garder le lease empêche une nouvelle synthèse de chevaucher un moteur dont
        // l'état est inconnu. Un prochain appel retentera explicitement l'arrêt.
        console.warn('[bob-voice] native TTS stop quarantined');
        operation.stopPromise = null;
      }
      return stopped;
    })();
    return operation.stopPromise;
  }, [releaseOutputOperation, settleOutputOperation]);

  const stopOutput = useCallback(async (): Promise<boolean> => {
    const operation = outputOperationRef.current;
    if (operation === null) return true;
    return stopOutputOperation(operation, 'interrupted');
  }, [stopOutputOperation]);
  preemptOutputRef.current = async () => {
    outputIntentGenerationRef.current += 1;
    await stopOutput();
  };
  useEffect(() => {
    outputMountedRef.current = true;
    return () => {
      outputMountedRef.current = false;
      outputIntentGenerationRef.current += 1;
      void stopOutput();
    };
  }, [stopOutput]);

  const speakNative = useCallback(async (
    t: string,
    operation: NativeTtsOperation,
    mayStart: () => boolean,
  ): Promise<void> => {
    try {
      const voices = await withNativeCapabilityTimeout(() => Speech.getAvailableVoicesAsync());
      const voice = voices.find((candidate) =>
        candidate.language.trim().replaceAll('_', '-').toLowerCase() === 'fr-fr'
        && (
          Platform.OS !== 'android'
          || (
            (candidate as typeof candidate & {
              networkConnectionRequired?: boolean;
              installed?: boolean;
            }).networkConnectionRequired === false
            && (candidate as typeof candidate & { installed?: boolean }).installed === true
          )
        ));
      if (voice === undefined) {
        if (operation.stopPromise !== null) return;
        settleOutputOperation(operation, 'failed', true);
        return;
      }
      if (!mayStart()) {
        if (operation.stopPromise !== null) return;
        settleOutputOperation(operation, 'interrupted', true);
        return;
      }
      const timeoutMs = Math.max(
        NATIVE_TTS_MIN_TIMEOUT_MS,
        Math.min(NATIVE_TTS_MAX_TIMEOUT_MS, 3_000 + t.length * 120),
      );
      operation.timer = setTimeout(() => {
        if (outputOperationRef.current !== operation || !mayStart()) return;
        void stopOutputOperation(operation, 'timed_out');
      }, timeoutMs);
      Speech.speak(t, {
        language: 'fr-FR',
        voice: voice.identifier,
        ...(Platform.OS === 'android' ? { requiresOfflineVoice: true } : {}),
        rate: 1.0,
        onDone: () => { settleOutputOperation(operation, 'completed', true); },
        onStopped: () => { settleOutputOperation(operation, 'interrupted', true); },
        onError: () => { settleOutputOperation(operation, 'failed', true); },
      });
    } catch {
      if (operation.stopPromise !== null) return;
      settleOutputOperation(operation, 'failed', true);
    }
  }, [settleOutputOperation, stopOutputOperation]);

  /** Cœur commun : parle, et signale la FIN de l'énoncé (onFinished) — la boucle live (LIVE-0)
   *  enchaîne l'écoute à ce signal ; le fire-and-forget historique n'en a pas besoin. */
  const speakCore = useCallback(
    async (text: string, onFinished?: (outcome: VoiceOutputOutcome) => void) => {
      const t = text?.trim();
      if (!t) {
        onFinished?.('completed');
        return;
      }
      const outputIntentGeneration = ++outputIntentGenerationRef.current;
      const outputIntentIsCurrent = (): boolean => (
        outputMountedRef.current
        && outputIntentGenerationRef.current === outputIntentGeneration
      );
      // Couper toute sortie précédente de CE hook, puis obtenir l'unique lease audio process.
      const priorStopped = await stopOutput();
      if (!outputIntentIsCurrent()) {
        onFinished?.('interrupted');
        return;
      }
      if (!priorStopped || outputOperationRef.current !== null) {
        onFinished?.('failed');
        return;
      }
      const acquired = await processAudioSession.acquire({
        owner: outputOwner,
        mode: 'legacy_output',
        onPreempt: () => preemptOutputRef.current(),
      });
      if (!outputIntentIsCurrent()) {
        if (acquired.ok) processAudioSession.release(acquired.lease);
        onFinished?.('interrupted');
        return;
      }
      if (!acquired.ok) {
        // Bob Live possède déjà le pipeline : ne jamais superposer un TTS historique.
        onFinished?.('interrupted');
        return;
      }
      outputLeaseRef.current = acquired.lease;
      const operation: NativeTtsOperation = {
        generation: ++outputGenerationRef.current,
        lease: acquired.lease,
        onFinished: (outcome) => onFinished?.(outcome),
        timer: null,
        stopPromise: null,
        settled: false,
      };
      outputOperationRef.current = operation;
      await speakNative(
        t,
        operation,
        () => outputLeaseRef.current?.token === acquired.lease.token
          && outputOperationRef.current === operation
          && outputIntentIsCurrent()
          && processAudioSession.isCurrent(acquired.lease),
      );
    },
    [outputOwner, speakNative, stopOutput],
  );

  const speak = useCallback(async (text: string) => speakCore(text), [speakCore]);

  /** Parle et RÉSOUT à la fin de l'énoncé (fin naturelle, interruption ou erreur) — LIVE-0. */
  const speakAndWait = useCallback(
    (text: string): Promise<VoiceOutputOutcome> =>
      new Promise((resolve) => {
        let settled = false;
        const done = (outcome: VoiceOutputOutcome): void => {
          if (!settled) {
            settled = true;
            resolve(outcome);
          }
        };
        void speakCore(text, done).catch(() => done('failed'));
      }),
    [speakCore],
  );

  /** Génération de file : stopSpeaking invalide la file en cours — coupure ≤ une phrase. */
  const speakQueueGenerationRef = useRef(0);

  const stopSpeaking = useCallback(() => {
    speakQueueGenerationRef.current += 1;
    outputIntentGenerationRef.current += 1;
    void stopOutput();
  }, [stopOutput]);

  /** BOB LIVE P1 : parle une FILE de phrases — interruptible ENTRE les phrases (tap/barge-in),
   * et dès la première phrase l'utilisateur entend Bob (latence perçue ÷ n). */
  const speakSentences = useCallback(
    async (sentences: readonly string[]): Promise<{
      interrupted: boolean;
      failed: boolean;
    }> => {
      const generation = ++speakQueueGenerationRef.current;
      for (const sentence of sentences) {
        if (speakQueueGenerationRef.current !== generation) {
          return { interrupted: true, failed: false };
        }
        const outcome = await speakAndWait(sentence);
        if (speakQueueGenerationRef.current !== generation) {
          return { interrupted: true, failed: false };
        }
        if (outcome === 'failed' || outcome === 'timed_out') {
          return { interrupted: false, failed: true };
        }
        if (outcome === 'interrupted') {
          return { interrupted: true, failed: false };
        }
      }
      return { interrupted: false, failed: false };
    },
    [speakAndWait],
  );

  return { speak, speakAndWait, speakSentences, stopSpeaking };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';
// Module NATIF absent d'Expo Go : chargement paresseux + stubs sûrs (Rules of Hooks respectées —
// le stub de hook est une fonction stable qui ne fait rien). En dev build, le vrai module est utilisé.
type SpeechModule = typeof import('expo-speech-recognition');
let speech: SpeechModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  speech = require('expo-speech-recognition') as SpeechModule;
} catch {
  speech = null; // Expo Go / simulateur sans module natif → secours texte de l'écran (C20)
}
export const speechRecognitionAvailable = speech !== null;
const ExpoSpeechRecognitionModule = speech?.ExpoSpeechRecognitionModule ?? null;
const useSpeechRecognitionEvent: SpeechModule['useSpeechRecognitionEvent'] =
  speech?.useSpeechRecognitionEvent ??
  ((() => undefined) as unknown as SpeechModule['useSpeechRecognitionEvent']);
import {
  useAudioRecorder,
  AudioModule,
  RecordingPresets,
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from 'expo-audio';
import {
  readAsStringAsync,
  writeAsStringAsync,
  deleteAsync,
  getInfoAsync,
  cacheDirectory,
  EncodingType,
} from 'expo-file-system/legacy';
import * as Speech from 'expo-speech';
import {
  processAudioSession,
  type ProcessAudioLease,
} from '../audio';
import { getVoiceMode } from './settings';
import { useBobClient } from './client';
import { appErrorMessage } from './hooks';

/** Accroc du canal voix : refus micro, module natif absent (Expo Go), transcription ratée. */
export type VoiceInputIssue = 'denied' | 'unavailable' | 'failed';

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

async function withPermissionRequest<T>(run: () => Promise<T>): Promise<T> {
  return processAudioSession.withPermissionRequest(run);
}
const MAX_CLOUD_AUDIO_BYTES = 8 * 1024 * 1024;

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
 * Entrée vocale de Bob. NATIF par défaut (expo-speech-recognition, sur l'appareil, gratuit) ;
 * CLOUD en option (enregistrement -> backend Whisper) selon le réglage. La voix n'est qu'un canal :
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
  const client = useBobClient();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [listening, setListening] = useState(false);
  const leaseOwnerName = useRef(opts.owner ?? 'bob-voice-input').current;
  const lease = useRef(Symbol(leaseOwnerName)).current;
  const preemptRef = useRef<() => Promise<void>>(async () => undefined);
  const sessionRef = useRef<{
    generation: number;
    mode: 'native' | 'cloud';
  } | null>(null);
  const deliveredNativeGenerationRef = useRef<number | null>(null);
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
    console.warn('[bob-voice] issue:', issue, '—', message);
    if (onIssueRef.current) onIssueRef.current(issue);
    else Alert.alert(title, message);
  }, []);

  const setGenerationListening = useCallback((generation: number, value: boolean): void => {
    if (sessionRef.current?.generation === generation) setListening(value);
  }, []);

  const releaseGeneration = useCallback(
    (generation: number): boolean => {
      if (!releaseVoiceLease(lease, generation)) return false;
      if (sessionRef.current?.generation === generation) {
        sessionRef.current = null;
        setListening(false);
      }
      return true;
    },
    [lease],
  );

  const releaseNativeGenerationAfterGrace = useCallback(
    (generation: number): void => {
      setTimeout(() => {
        // Un timer d'une generation N ne peut jamais liberer N+1.
        releaseGeneration(generation);
      }, NATIVE_TERMINAL_GRACE_MS);
    },
    [releaseGeneration],
  );

  // —— Événements de la reconnaissance NATIVE ——
  useSpeechRecognitionEvent('result', (e) => {
    const session = sessionRef.current;
    if (session?.mode !== 'native' || !matchesVoiceLease(lease, session.generation)) {
      return;
    }
    const generation = session.generation;
    const text = e.results?.[0]?.transcript?.trim();
    if (e.isFinal) {
      if (deliveredNativeGenerationRef.current === generation) return;
      deliveredNativeGenerationRef.current = generation;
      setGenerationListening(generation, false);
      closeVoiceLease(lease, generation);
      releaseNativeGenerationAfterGrace(generation);
      if (text) onTranscriptRef.current(text);
    } else if (text && matchesVoiceLease(lease, generation, 'active')) {
      // Résultats PARTIELS (LIVE-3 barge-in) : détecter la parole pendant que Bob parle.
      onPartialRef.current?.(text);
    }
  });
  useSpeechRecognitionEvent('end', () => {
    const session = sessionRef.current;
    if (session?.mode !== 'native' || !matchesVoiceLease(lease, session.generation)) {
      return;
    }
    setGenerationListening(session.generation, false);
    closeVoiceLease(lease, session.generation);
    // Certains moteurs livrent le resultat final juste APRES `end`.
    releaseNativeGenerationAfterGrace(session.generation);
  });
  useSpeechRecognitionEvent('error', (e) => {
    console.warn('[bob-voice] event error:', JSON.stringify(e));
    const session = sessionRef.current;
    if (session?.mode !== 'native' || !matchesVoiceLease(lease, session.generation)) {
      return;
    }
    setGenerationListening(session.generation, false);
    closeVoiceLease(lease, session.generation);
    releaseNativeGenerationAfterGrace(session.generation);
  });

  const start = useCallback(async (): Promise<boolean> => {
    const onPreempt = async (): Promise<void> => {
      await preemptRef.current();
      // La reconnaissance native conserve une courte grâce pour son résultat terminal.
      // Realtime n'acquiert le micro qu'après la libération effective de cette génération.
      if (activeVoiceLease?.owner === lease) {
        await new Promise((resolve) => setTimeout(resolve, NATIVE_TERMINAL_GRACE_MS + 50));
      }
    };
    let generation = await acquireVoiceLease(lease, leaseOwnerName, onPreempt);
    if (generation === null && activeVoiceLease?.owner === lease) {
      // AUTO-COLLISION du même flux — jamais une « erreur micro » : ① l'écoute est encore
      // ACTIVE → l'intention de l'appelant (être à l'écoute) est déjà satisfaite ; ② elle se
      // REFERME (grâce post-final, ex. écho avalé qui ré-écoute aussitôt) → on attend sa
      // libération puis on rouvre une génération fraîche (les timers N restent fencés).
      if (activeVoiceLease.state === 'active') return true;
      await new Promise((resolve) => setTimeout(resolve, NATIVE_TERMINAL_GRACE_MS + 50));
      generation = await acquireVoiceLease(lease, leaseOwnerName, onPreempt);
    }
    if (generation === null) {
      report('unavailable', 'Micro', 'Le micro est déjà utilisé par un autre flux Bob.');
      return false;
    }
    sessionRef.current = { generation, mode: 'native' };
    deliveredNativeGenerationRef.current = null;
    try {
      const selectedMode = await getVoiceMode();
      if (!matchesVoiceLease(lease, generation, 'active')) {
        console.warn('[bob-voice] start annulé pendant getVoiceMode (lease invalidé)', String(lease));
        return false;
      }
      sessionRef.current = { generation, mode: selectedMode };

      if (selectedMode === 'native') {
        if (!ExpoSpeechRecognitionModule) {
          releaseGeneration(generation);
          report('unavailable', 'Dictée', "La dictée native n'est pas disponible ici.");
          return false;
        }
        const perm = await withPermissionRequest(() => ExpoSpeechRecognitionModule.requestPermissionsAsync());
        if (!matchesVoiceLease(lease, generation, 'active')) {
          console.warn('[bob-voice] start annulé pendant la permission (lease invalidé)');
          return false;
        }
        if (!perm.granted) {
          releaseGeneration(generation);
          report('denied', 'Micro', 'Autorise le micro pour parler à Bob.');
          return false;
        }
        setGenerationListening(generation, true);
        ExpoSpeechRecognitionModule.start({
          lang: 'fr-FR',
          interimResults: !!onPartialRef.current,
          continuous: false,
        });
      } else {
        const perm = await withPermissionRequest(() => AudioModule.requestRecordingPermissionsAsync());
        if (!matchesVoiceLease(lease, generation, 'active')) return false;
        if (!perm.granted) {
          report('denied', 'Micro', 'Autorise le micro pour la dictée cloud.');
          releaseGeneration(generation);
          return false;
        }
        await recorder.prepareToRecordAsync();
        if (!matchesVoiceLease(lease, generation, 'active')) {
          try {
            await recorder.stop();
            if (recorder.uri) await deleteAsync(recorder.uri, { idempotent: true });
          } catch {
            // Une annulation concurrente possede deja le nettoyage de cette generation.
          }
          return false;
        }
        setGenerationListening(generation, true);
        recorder.record();
      }
      return true;
    } catch {
      // Une ancienne continuation async ne modifie jamais la generation qui lui a succede.
      if (matchesVoiceLease(lease, generation)) {
        setGenerationListening(generation, false);
        releaseGeneration(generation);
        report('unavailable', 'Dictée', "Le micro n'a pas pu démarrer.");
      }
      return false;
    }
  }, [lease, leaseOwnerName, recorder, releaseGeneration, report, setGenerationListening]);

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || !matchesVoiceLease(lease, session.generation, 'active')) return;
    const { generation, mode } = session;
    closeVoiceLease(lease, generation);

    if (mode === 'native') {
      setGenerationListening(generation, false);
      try {
        await ExpoSpeechRecognitionModule?.stop();
      } catch {
        if (matchesVoiceLease(lease, generation)) {
          report('failed', 'Dictée', "L'écoute n'a pas pu être arrêtée proprement.");
        }
      } finally {
        // `end` et ce finally peuvent tous deux armer un timer : les deux sont fences.
        releaseNativeGenerationAfterGrace(generation);
      }
      return;
    }

    let recordingUri = recorder.uri;
    try {
      // CLOUD : arrêter l'enregistrement -> base64 -> backend Whisper.
      await recorder.stop();
      setGenerationListening(generation, false);
      recordingUri = recorder.uri ?? recordingUri;
      if (!recordingUri) {
        report('failed', 'Dictée', "L'enregistrement audio est introuvable.");
        return;
      }

      const info = await getInfoAsync(recordingUri);
      if (!info.exists) {
        report('failed', 'Dictée', "L'enregistrement audio est introuvable.");
        return;
      }
      if (typeof info.size === 'number' && info.size > MAX_CLOUD_AUDIO_BYTES) {
        report(
          'failed',
          'Dictée',
          'La dictée est trop longue. Réessaie avec une demande plus courte.',
        );
        return;
      }

      const base64 = await readAsStringAsync(recordingUri, { encoding: EncodingType.Base64 });
      const r = await client.transcribe({ audioBase64: base64, mimeType: 'audio/m4a' });
      if (!matchesVoiceLease(lease, generation, 'closing')) return;
      if (r.ok && r.value.text) onTranscriptRef.current(r.value.text);
      else {
        report('failed', 'Dictée', r.ok ? 'Rien compris, réessaie.' : appErrorMessage(r.error));
      }
    } catch {
      if (matchesVoiceLease(lease, generation)) {
        setGenerationListening(generation, false);
        report('failed', 'Dictée', 'La transcription a échoué.');
      }
    } finally {
      if (recordingUri) {
        try {
          await deleteAsync(recordingUri, { idempotent: true });
        } catch {
          // Fichier cache ephemere : suppression best-effort.
        }
      }
      releaseGeneration(generation);
    }
  }, [
    client,
    lease,
    recorder,
    releaseGeneration,
    releaseNativeGenerationAfterGrace,
    report,
    setGenerationListening,
  ]);

  /** Abandon sans transcription : background, unmount ou changement de proprietaire. */
  const cancel = useCallback(async (): Promise<void> => {
    const session = sessionRef.current;
    if (!session || !matchesVoiceLease(lease, session.generation)) return;
    const { generation, mode } = session;
    closeVoiceLease(lease, generation);
    setGenerationListening(generation, false);

    if (mode === 'native') {
      try {
        ExpoSpeechRecognitionModule?.abort();
      } catch {
        // Le moteur peut deja etre termine ; la grace libere quand meme cette generation.
      } finally {
        releaseNativeGenerationAfterGrace(generation);
      }
      return;
    }

    let recordingUri = recorder.uri;
    try {
      await recorder.stop();
      recordingUri = recorder.uri ?? recordingUri;
    } catch {
      // Nettoyage best-effort ; le finally invalide tout retour async de cette generation.
    } finally {
      recordingUri = recorder.uri ?? recordingUri;
      if (recordingUri) {
        try {
          await deleteAsync(recordingUri, { idempotent: true });
        } catch {
          // Fichier cache ephemere : suppression best-effort.
        }
      }
      releaseGeneration(generation);
    }
  }, [
    lease,
    recorder,
    releaseGeneration,
    releaseNativeGenerationAfterGrace,
    setGenerationListening,
  ]);
  preemptRef.current = cancel;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      // 'background' SEULEMENT : sur iOS, la boîte de permission micro, le Control Center ou
      // un bandeau d'appel passent l'app en 'inactive' — annuler là tuerait le PREMIER usage
      // du micro pendant que l'utilisateur accorde la permission.
      if (state === 'background' && !voicePermissionRequestInFlight()) void cancel();
    });
    return () => {
      subscription.remove();
      void cancel();
    };
  }, [cancel]);

  return { listening, start, stop, cancel, ownsLease };
}

// mimeType renvoyé par Voxtral TTS -> extension de fichier pour que le décodeur natif le reconnaisse.
function extForMime(mime: string | null): string {
  switch ((mime ?? '').toLowerCase()) {
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/ogg':
    case 'audio/opus':
      return 'ogg';
    case 'audio/aac':
      return 'aac';
    case 'audio/mp4':
    case 'audio/m4a':
      return 'm4a';
    default:
      return 'mp3'; // audio/mpeg par défaut (sortie usuelle Voxtral TTS)
  }
}

/**
 * Sortie vocale de Bob (TTS) — miroir de useVoiceInput. Deux canaux, MÊME texte de domaine :
 *  - NATIF (expo-speech, on-device, gratuit, hors-ligne, fr-FR) : défaut, tous paliers.
 *  - CLOUD souverain (Voxtral TTS via le backend) : quand voiceMode='cloud' ET que l'offre l'autorise
 *    (Pro+ ; ttsCloudAvailable exposé par /voice/config). On synthétise côté serveur, on écrit l'audio
 *    dans le cache, et on le lit avec expo-audio.
 *
 * FAIL-SAFE : toute anicroche cloud (offre non éligible, réseau, audio vide, décodage) retombe sur le
 * natif. Bob parle TOUJOURS. Les montants viennent du domaine (jamais inventés) -> sûrs à vocaliser.
 */
export function useSpeak() {
  const client = useBobClient();
  const playerRef = useRef<AudioPlayer | null>(null);
  const fileRef = useRef<string | null>(null);
  const outputLeaseRef = useRef<ProcessAudioLease | null>(null);
  const outputOwner = useRef('bob-legacy-output').current;
  const preemptOutputRef = useRef<() => Promise<void>>(async () => undefined);
  // Éligibilité TTS cloud : un seul appel /voice/config par session, mémoïsé (évite un round-trip par énoncé).
  const ttsCloudReady = useRef<Promise<boolean> | null>(null);

  const cleanupCloud = useCallback(async () => {
    try {
      playerRef.current?.remove();
    } catch {
      /* player déjà libéré */
    }
    playerRef.current = null;
    const uri = fileRef.current;
    fileRef.current = null;
    if (uri) {
      try {
        await deleteAsync(uri, { idempotent: true });
      } catch {
        /* fichier cache éphémère : suppression best-effort */
      }
    }
  }, []);

  const releaseOutputLease = useCallback((): void => {
    const lease = outputLeaseRef.current;
    outputLeaseRef.current = null;
    processAudioSession.release(lease);
  }, []);

  const stopOutput = useCallback(async (): Promise<void> => {
    Speech.stop();
    await cleanupCloud();
    releaseOutputLease();
  }, [cleanupCloud, releaseOutputLease]);
  preemptOutputRef.current = stopOutput;
  useEffect(() => () => { void stopOutput(); }, [stopOutput]);

  const speakNative = useCallback((t: string, onFinished?: () => void) => {
    Speech.stop(); // ne pas superposer deux réponses
    Speech.speak(t, {
      language: 'fr-FR',
      rate: 1.0,
      ...(onFinished ? { onDone: onFinished, onStopped: onFinished, onError: onFinished } : {}),
    });
  }, []);

  /** Cœur commun : parle, et signale la FIN de l'énoncé (onFinished) — la boucle live (LIVE-0)
   *  enchaîne l'écoute à ce signal ; le fire-and-forget historique n'en a pas besoin. */
  const speakCore = useCallback(
    async (text: string, onFinished?: () => void) => {
      const t = text?.trim();
      if (!t) {
        onFinished?.();
        return;
      }
      // Couper toute sortie précédente de CE hook, puis obtenir l'unique lease audio process.
      await stopOutput();
      const acquired = await processAudioSession.acquire({
        owner: outputOwner,
        mode: 'legacy_output',
        onPreempt: () => preemptOutputRef.current(),
      });
      if (!acquired.ok) {
        // Bob Live possède déjà le pipeline : ne jamais superposer un TTS historique.
        onFinished?.();
        return;
      }
      outputLeaseRef.current = acquired.lease;
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        if (outputLeaseRef.current?.token === acquired.lease.token) releaseOutputLease();
        onFinished?.();
      };

      let mode: 'native' | 'cloud' = 'native';
      try {
        mode = await getVoiceMode();
      } catch {
        /* réglage illisible -> natif */
      }
      if (mode !== 'cloud') return speakNative(t, finish);

      try {
        if (!ttsCloudReady.current) {
          ttsCloudReady.current = client
            .voiceConfig()
            .then((r) => (r.ok ? !!r.value.ttsCloudAvailable : false))
            .catch(() => false);
        }
        if (!(await ttsCloudReady.current)) return speakNative(t, finish);

        const r = await client.synthesizeSpeech({ text: t });
        if (!(r.ok && r.value.audioBase64 && cacheDirectory)) return speakNative(t, finish);

        const uri = `${cacheDirectory}bob-tts-${Date.now()}.${extForMime(r.value.mimeType)}`;
        await writeAsStringAsync(uri, r.value.audioBase64, { encoding: EncodingType.Base64 });
        fileRef.current = uri;

        await setAudioModeAsync({ playsInSilentMode: true }); // Bob s'entend même en mode silencieux
        const player = createAudioPlayer(uri);
        playerRef.current = player;
        player.addListener('playbackStatusUpdate', (s) => {
          if (s.didJustFinish) {
            void cleanupCloud();
            finish();
          }
        });
        player.play();
      } catch {
        await cleanupCloud();
        if (processAudioSession.isCurrent(acquired.lease)) {
          speakNative(t, finish); // repli inconditionnel tant que ce flux possède encore l'audio
        } else {
          finish();
        }
      }
    },
    [client, cleanupCloud, outputOwner, releaseOutputLease, speakNative, stopOutput],
  );

  const speak = useCallback(async (text: string) => speakCore(text), [speakCore]);

  /** Parle et RÉSOUT à la fin de l'énoncé (fin naturelle, interruption ou erreur) — LIVE-0. */
  const speakAndWait = useCallback(
    (text: string): Promise<void> =>
      new Promise((resolve) => {
        let settled = false;
        const done = (): void => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        void speakCore(text, done).catch(done);
      }),
    [speakCore],
  );

  /** Génération de file : stopSpeaking invalide la file en cours — coupure ≤ une phrase. */
  const speakQueueGenerationRef = useRef(0);

  const stopSpeaking = useCallback(() => {
    speakQueueGenerationRef.current += 1;
    void stopOutput();
  }, [stopOutput]);

  /** BOB LIVE P1 : parle une FILE de phrases — interruptible ENTRE les phrases (tap/barge-in),
   * et dès la première phrase l'utilisateur entend Bob (latence perçue ÷ n). */
  const speakSentences = useCallback(
    async (sentences: readonly string[]): Promise<{ interrupted: boolean }> => {
      const generation = ++speakQueueGenerationRef.current;
      for (const sentence of sentences) {
        if (speakQueueGenerationRef.current !== generation) return { interrupted: true };
        await speakAndWait(sentence);
        if (speakQueueGenerationRef.current !== generation) return { interrupted: true };
      }
      return { interrupted: false };
    },
    [speakAndWait],
  );

  return { speak, speakAndWait, speakSentences, stopSpeaking };
}

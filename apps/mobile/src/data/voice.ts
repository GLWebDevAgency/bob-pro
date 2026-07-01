import { useCallback, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import {
  useAudioRecorder,
  AudioModule,
  RecordingPresets,
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from 'expo-audio';
import { readAsStringAsync, writeAsStringAsync, deleteAsync, cacheDirectory, EncodingType } from 'expo-file-system/legacy';
import * as Speech from 'expo-speech';
import { getVoiceMode } from './settings';
import { useBobClient } from './client';
import { appErrorMessage } from './hooks';

/**
 * Entrée vocale de Bob. NATIF par défaut (expo-speech-recognition, sur l'appareil, gratuit) ;
 * CLOUD en option (enregistrement -> backend Whisper) selon le réglage. La voix n'est qu'un canal :
 * transcription -> onTranscript(text) -> MÊME cerveau Bob.
 * NB : nécessite un build natif (les modules micro ne tournent pas en bundle JS pur).
 */
export function useVoiceInput(onTranscript: (text: string) => void) {
  const client = useBobClient();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [listening, setListening] = useState(false);
  const mode = useRef<'native' | 'cloud'>('native');

  // —— Événements de la reconnaissance NATIVE ——
  useSpeechRecognitionEvent('result', (e) => {
    if (mode.current !== 'native') return;
    const text = e.results?.[0]?.transcript?.trim();
    if (e.isFinal && text) {
      setListening(false);
      onTranscript(text);
    }
  });
  useSpeechRecognitionEvent('end', () => {
    if (mode.current === 'native') setListening(false);
  });
  useSpeechRecognitionEvent('error', () => {
    if (mode.current === 'native') setListening(false);
  });

  const start = useCallback(async () => {
    mode.current = await getVoiceMode();
    try {
      if (mode.current === 'native') {
        const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('Micro', 'Autorise le micro pour parler à Bob.');
          return;
        }
        setListening(true);
        ExpoSpeechRecognitionModule.start({ lang: 'fr-FR', interimResults: false, continuous: false });
      } else {
        const perm = await AudioModule.requestRecordingPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('Micro', 'Autorise le micro pour la dictée cloud.');
          return;
        }
        setListening(true);
        await recorder.prepareToRecordAsync();
        recorder.record();
      }
    } catch {
      setListening(false);
      Alert.alert('Dictée', "Le micro n'a pas pu démarrer.");
    }
  }, [recorder]);

  const stop = useCallback(async () => {
    try {
      if (mode.current === 'native') {
        await ExpoSpeechRecognitionModule.stop();
        return;
      }
      // CLOUD : arrêter l'enregistrement -> base64 -> backend Whisper.
      await recorder.stop();
      setListening(false);
      const uri = recorder.uri;
      if (!uri) return;
      const base64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
      const r = await client.transcribe({ audioBase64: base64, mimeType: 'audio/m4a' });
      if (r.ok && r.value.text) onTranscript(r.value.text);
      else Alert.alert('Dictée', r.ok ? 'Rien compris, réessaie.' : appErrorMessage(r.error));
    } catch {
      setListening(false);
      Alert.alert('Dictée', 'La transcription a échoué.');
    }
  }, [recorder, client]);

  return { listening, start, stop };
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

  const speakNative = useCallback((t: string) => {
    Speech.stop(); // ne pas superposer deux réponses
    Speech.speak(t, { language: 'fr-FR', rate: 1.0 });
  }, []);

  const speak = useCallback(
    async (text: string) => {
      const t = text?.trim();
      if (!t) return;
      // Couper toute sortie en cours (natif + cloud) avant d'en démarrer une nouvelle.
      Speech.stop();
      await cleanupCloud();

      let mode: 'native' | 'cloud' = 'native';
      try {
        mode = await getVoiceMode();
      } catch {
        /* réglage illisible -> natif */
      }
      if (mode !== 'cloud') return speakNative(t);

      try {
        if (!ttsCloudReady.current) {
          ttsCloudReady.current = client
            .voiceConfig()
            .then((r) => (r.ok ? !!r.value.ttsCloudAvailable : false))
            .catch(() => false);
        }
        if (!(await ttsCloudReady.current)) return speakNative(t);

        const r = await client.synthesizeSpeech({ text: t });
        if (!(r.ok && r.value.audioBase64 && cacheDirectory)) return speakNative(t);

        const uri = `${cacheDirectory}bob-tts-${Date.now()}.${extForMime(r.value.mimeType)}`;
        await writeAsStringAsync(uri, r.value.audioBase64, { encoding: EncodingType.Base64 });
        fileRef.current = uri;

        await setAudioModeAsync({ playsInSilentMode: true }); // Bob s'entend même en mode silencieux
        const player = createAudioPlayer(uri);
        playerRef.current = player;
        player.addListener('playbackStatusUpdate', (s) => {
          if (s.didJustFinish) void cleanupCloud();
        });
        player.play();
      } catch {
        await cleanupCloud();
        speakNative(t); // repli inconditionnel : la voix ne tombe jamais
      }
    },
    [client, cleanupCloud, speakNative],
  );

  const stopSpeaking = useCallback(() => {
    Speech.stop();
    void cleanupCloud();
  }, [cleanupCloud]);

  return { speak, stopSpeaking };
}

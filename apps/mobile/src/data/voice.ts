import { useCallback, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useAudioRecorder, AudioModule, RecordingPresets } from 'expo-audio';
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
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

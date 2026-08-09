// Module natif absent d'Expo Go : chargement paresseux + stubs sûrs. Cette frontière isolée rend
// aussi le cycle ASR testable avec un emitter contrôlé, sans simuler le pont natif global.
type SpeechModule = typeof import('expo-speech-recognition');

let speech: SpeechModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  speech = require('expo-speech-recognition') as SpeechModule;
} catch {
  speech = null;
}

export const speechRecognitionAvailable = speech !== null;
export const nativeSpeechRecognitionModule = speech?.ExpoSpeechRecognitionModule ?? null;
type PatchedSpeechRecognitionModule = SpeechModule['ExpoSpeechRecognitionModule'] & {
  abortAndWaitAsync?: () => Promise<void>;
  supportsOnDeviceRecognitionForLocale?: (requestedLocale: string) => boolean;
};

export function abortNativeSpeechAndWait(): Promise<boolean> {
  const nativeModule = nativeSpeechRecognitionModule as PatchedSpeechRecognitionModule | null;
  const abortAndWait = nativeModule?.abortAndWaitAsync;
  if (typeof abortAndWait !== 'function' || nativeModule === null) {
    return Promise.resolve(false);
  }
  try {
    return Promise.resolve(abortAndWait.call(nativeModule)).then(() => true, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

export function supportsStrictOnDeviceSpeechLocale(locale: string): boolean {
  const checker = (nativeSpeechRecognitionModule as PatchedSpeechRecognitionModule | null)
    ?.supportsOnDeviceRecognitionForLocale;
  if (typeof checker !== 'function' || nativeSpeechRecognitionModule === null) return false;
  try {
    return checker.call(nativeSpeechRecognitionModule, locale) === true;
  } catch {
    return false;
  }
}
export const useNativeSpeechRecognitionEvent: SpeechModule['useSpeechRecognitionEvent'] =
  speech?.useSpeechRecognitionEvent
  ?? ((() => undefined) as unknown as SpeechModule['useSpeechRecognitionEvent']);

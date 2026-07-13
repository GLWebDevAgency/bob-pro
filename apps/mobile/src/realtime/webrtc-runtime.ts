export interface WebRtcRuntime {
  RTCPeerConnection: typeof import('react-native-webrtc')['RTCPeerConnection'];
  RTCSessionDescription: typeof import('react-native-webrtc')['RTCSessionDescription'];
  mediaDevices: typeof import('react-native-webrtc')['mediaDevices'];
}

let cached: WebRtcRuntime | null | undefined;

/** Expo Go ne contient pas le module natif : l'échec de require devient une capacité absente. */
export function loadWebRtcRuntime(): WebRtcRuntime | null {
  if (cached !== undefined) return cached;
  try {
    // Les imports natifs restent paresseux : les tests purs et Expo web peuvent importer le
    // transport sans tenter de charger un TurboModule absent.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Platform } = require('react-native') as typeof import('react-native');
    if (Platform.OS === 'web') return (cached = null);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const runtime = require('react-native-webrtc') as WebRtcRuntime;
    if (!runtime.RTCPeerConnection || !runtime.RTCSessionDescription || !runtime.mediaDevices) {
      return (cached = null);
    }
    cached = runtime;
  } catch {
    cached = null;
  }
  return cached;
}

export function resetWebRtcRuntimeForTests(): void {
  cached = undefined;
}

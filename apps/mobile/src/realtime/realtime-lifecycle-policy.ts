/** États React Native pertinents sans importer le runtime natif dans les tests purs. */
export type RealtimeAppState = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

/**
 * Les dialogues de permission passent brièvement par `inactive` sur certaines versions Android.
 * Seul un vrai passage en arrière-plan ferme le flux micro et le peer WebRTC.
 */
export function shouldCloseRealtimeForAppState(state: RealtimeAppState): boolean {
  return state === 'background';
}


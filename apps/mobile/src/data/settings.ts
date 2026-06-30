import AsyncStorage from '@react-native-async-storage/async-storage';
import { type AgentAutonomy, DEFAULT_AUTONOMY } from '@bob/ai';

const KEY = 'bob.autonomy';

function isAutonomy(v: string | null): v is AgentAutonomy {
  return v === 'confirm_all' || v === 'confirm_outbound' || v === 'auto';
}

/** Lit le niveau d'autonomie de Bob (défaut = recommandé). */
export async function getAutonomy(): Promise<AgentAutonomy> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    if (isAutonomy(v)) return v;
  } catch {
    // pref illisible -> défaut
  }
  return DEFAULT_AUTONOMY;
}

export async function setAutonomy(mode: AgentAutonomy): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, mode);
  } catch {
    // best-effort
  }
}

/** Mode de dictée vocale : natif (sur l'appareil, gratuit, défaut) ou cloud (Whisper, plus précis, clé requise). */
export type VoiceMode = 'native' | 'cloud';
const KEY_VOICE = 'bob.voiceMode';

export async function getVoiceMode(): Promise<VoiceMode> {
  try {
    const v = await AsyncStorage.getItem(KEY_VOICE);
    if (v === 'native' || v === 'cloud') return v;
  } catch {
    // défaut
  }
  return 'native';
}

export async function setVoiceMode(mode: VoiceMode): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_VOICE, mode);
  } catch {
    // best-effort
  }
}

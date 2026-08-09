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

const KEY_VOICE = 'bob.voiceMode';

/**
 * Migration de démarrage irréversible côté version courante : une installation ayant mémorisé
 * `cloud` est réécrite en `native`. Cette écriture empêche aussi un rollback OTA compatible de
 * réactiver silencieusement l'ancien upload. La politique de release doit malgré tout interdire
 * tout retour vers un binaire antérieur qui ignorerait cette migration.
 */
export async function neutralizeLegacyCloudVoiceMode(): Promise<boolean> {
  try {
    if (await AsyncStorage.getItem(KEY_VOICE) !== 'cloud') return false;
    await AsyncStorage.setItem(KEY_VOICE, 'native');
    return true;
  } catch {
    // La migration est best-effort au montage. Un stockage illisible ne réactive aucune capacité
    // réseau : l'ancien chemin cloud n'existe plus dans le runtime mobile courant.
    return false;
  }
}

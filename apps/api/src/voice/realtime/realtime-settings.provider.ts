import type { Provider } from '@nestjs/common';
import { loadEnv } from '../../config/env';
import { REALTIME_VOICE_SETTINGS } from './realtime.tokens';
import {
  realtimeVoiceSettingsFromEnv,
  type RealtimeVoiceSettings,
} from './realtime.types';

/**
 * Provider de configuration sans dépendance au runtime transport. Les tranches HTTP qui doivent
 * dériver l'identité Bob Live n'importent ainsi ni schedulers, ni gateways, ni sideband.
 */
export const realtimeVoiceSettingsProvider: Provider = {
  provide: REALTIME_VOICE_SETTINGS,
  useFactory: (): RealtimeVoiceSettings => realtimeVoiceSettingsFromEnv(loadEnv()),
};

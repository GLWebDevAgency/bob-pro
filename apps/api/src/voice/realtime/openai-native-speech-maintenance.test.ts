import { describe, expect, it } from 'vitest';
import {
  DisabledOpenAiNativeSpeechMaintenance,
  OPENAI_NATIVE_SPEECH_MAINTENANCE_MAX_BATCH,
} from './openai-native-speech-maintenance';

describe('DisabledOpenAiNativeSpeechMaintenance', () => {
  it('refuse honnêtement expiration et purge sans autorité PostgreSQL', async () => {
    const maintenance = new DisabledOpenAiNativeSpeechMaintenance();
    const input = { companyId: 'company-1', limit: OPENAI_NATIVE_SPEECH_MAINTENANCE_MAX_BATCH };

    await expect(maintenance.listDueCompanyIds({ lane: 'expiry', limit: 1 })).resolves
      .toEqual({ status: 'unavailable' });
    await expect(maintenance.acknowledgeDueCompanyIds({
      lane: 'expiry', claimId: '00000000-0000-4000-8000-000000000099',
    })).resolves.toEqual({ status: 'unavailable' });
    await expect(maintenance.renewDueCompanyIdsClaim({
      lane: 'expiry', claimId: '00000000-0000-4000-8000-000000000099',
    })).resolves.toEqual({ status: 'unavailable' });
    await expect(maintenance.reapExpired(input)).resolves.toEqual({ status: 'unavailable' });
    await expect(maintenance.purgeRetained(input)).resolves.toEqual({ status: 'unavailable' });
  });
});

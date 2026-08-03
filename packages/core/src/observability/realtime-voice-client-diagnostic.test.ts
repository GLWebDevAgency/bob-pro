import { describe, expect, it } from 'vitest';
import {
  parseRealtimeVoiceClientTerminationDiagnostic,
  REALTIME_VOICE_CLIENT_CHECKPOINTS,
  REALTIME_VOICE_CLIENT_FAILURE_CODES,
  REALTIME_VOICE_CLIENT_LIFECYCLE_CLOSE_REASONS,
  REALTIME_VOICE_CLIENT_POLICY_CLOSE_REASONS,
} from './realtime-voice-client-diagnostic';

describe('RealtimeVoiceClientTerminationDiagnostic', () => {
  it.each(REALTIME_VOICE_CLIENT_CHECKPOINTS)('accepte le checkpoint fermé %s', (checkpoint) => {
    expect(parseRealtimeVoiceClientTerminationDiagnostic({
      version: 1,
      terminationSource: 'automatic_failure',
      lastSuccessfulCheckpoint: checkpoint,
      failureCode: 'unknown',
    })).toEqual({
      version: 1,
      terminationSource: 'automatic_failure',
      lastSuccessfulCheckpoint: checkpoint,
      failureCode: 'unknown',
    });
  });

  it.each(REALTIME_VOICE_CLIENT_FAILURE_CODES)('accepte la cause fermée %s', (failureCode) => {
    expect(parseRealtimeVoiceClientTerminationDiagnostic({
      version: 1,
      terminationSource: 'automatic_failure',
      lastSuccessfulCheckpoint: 'bootstrap_acknowledged',
      failureCode,
    }))?.not.toBeNull();
  });

  it.each(REALTIME_VOICE_CLIENT_LIFECYCLE_CLOSE_REASONS)(
    'accepte la fermeture lifecycle %s',
    (closeReason) => {
      expect(parseRealtimeVoiceClientTerminationDiagnostic({
        version: 1,
        terminationSource: 'lifecycle',
        lastSuccessfulCheckpoint: 'microphone_opened',
        closeReason,
      }))?.not.toBeNull();
    },
  );

  it('distingue la fermeture utilisateur', () => {
    expect(parseRealtimeVoiceClientTerminationDiagnostic({
      version: 1,
      terminationSource: 'user',
      lastSuccessfulCheckpoint: 'microphone_opened',
      closeReason: 'user',
    })).toEqual({
      version: 1,
      terminationSource: 'user',
      lastSuccessfulCheckpoint: 'microphone_opened',
      closeReason: 'user',
    });
  });

  it.each(REALTIME_VOICE_CLIENT_POLICY_CLOSE_REASONS)(
    'accepte la fermeture par politique %s',
    (closeReason) => {
      expect(parseRealtimeVoiceClientTerminationDiagnostic({
        version: 1,
        terminationSource: 'policy',
        lastSuccessfulCheckpoint: 'bootstrap_acknowledged',
        closeReason,
      })).toEqual({
        version: 1,
        terminationSource: 'policy',
        lastSuccessfulCheckpoint: 'bootstrap_acknowledged',
        closeReason,
      });
    },
  );

  it.each([
    undefined,
    null,
    {},
    { version: 2, terminationSource: 'automatic_failure', lastSuccessfulCheckpoint: 'transport_started', failureCode: 'unknown' },
    { version: 1, terminationSource: 'automatic_failure', lastSuccessfulCheckpoint: 'secret_stage', failureCode: 'unknown' },
    { version: 1, terminationSource: 'automatic_failure', lastSuccessfulCheckpoint: 'transport_started', failureCode: 'free_text' },
    { version: 1, terminationSource: 'automatic_failure', lastSuccessfulCheckpoint: 'transport_started', failureCode: 'unknown', sdp: 'secret' },
    { version: 1, terminationSource: 'user', lastSuccessfulCheckpoint: 'transport_started', closeReason: 'background' },
    { version: 1, terminationSource: 'policy', lastSuccessfulCheckpoint: 'transport_started', closeReason: 'free_text' },
    { version: 1, terminationSource: 'policy', lastSuccessfulCheckpoint: 'transport_started', closeReason: 'entitlement_revoked', detail: 'secret' },
  ])('refuse toute forme libre ou surnuméraire %#', (value) => {
    expect(parseRealtimeVoiceClientTerminationDiagnostic(value)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { decodeRealtimeServerEvent, realtimeProviderResponseId } from './realtime-event-codecs';

const NATIVE_METADATA = Object.freeze({
  bob_protocol: 'bob.openai-native-response.v1',
  bob_delivery_id: '00000000-0000-4000-8000-000000000021',
  bob_turn_id: '00000000-0000-4000-8000-000000000022',
  bob_context_revision: '7',
  bob_context_digest: 'c'.repeat(64),
  bob_request_nonce: 'n'.repeat(32),
});

describe('Bob Live — codecs événements Realtime', () => {
  it('décode seulement les signaux nécessaires sans conserver les deltas audio', () => {
    const decoded = decodeRealtimeServerEvent(JSON.stringify({
      type: 'response.output_audio.delta',
      delta: 'audio-base64-confidentiel',
      response_id: 'provider-id',
    }));
    expect(decoded).toEqual({ type: 'audio_signal', source: 'delta' });
    expect(JSON.stringify(decoded)).not.toContain('audio-base64-confidentiel');
    expect(JSON.stringify(decoded)).not.toContain('provider-id');
  });

  it('borne les transcriptions et les codes erreurs', () => {
    const transcript = decodeRealtimeServerEvent({
      type: 'response.output_audio_transcript.delta',
      response_id: 'response_transcript',
      delta: 'a'.repeat(5_000),
    });
    expect(transcript).toMatchObject({ type: 'bob_transcript', final: false });
    if (transcript.type === 'bob_transcript') expect(transcript.text).toHaveLength(4_000);

    expect(decodeRealtimeServerEvent({ type: 'error', error: { code: '<script>secret</script>' } }))
      .toEqual({ type: 'provider_error', code: 'realtime_provider_error' });
  });

  it('rejette JSON invalide et événements surdimensionnés', () => {
    expect(decodeRealtimeServerEvent('{')).toEqual({ type: 'protocol_error', code: 'invalid_json' });
    expect(decodeRealtimeServerEvent('x'.repeat(256 * 1024 + 1)))
      .toEqual({ type: 'protocol_error', code: 'event_too_large' });
  });

  it('signale explicitement le debut d une reponse autorisee par le sideband', () => {
    expect(decodeRealtimeServerEvent({ type: 'response.created', response: { id: 'provider-secret' } }))
      .toEqual({ type: 'response_started' });
  });

  it('ne conserve des metadata provider qu’une référence sans aucun effet UI', () => {
    const decoded = decodeRealtimeServerEvent({
      type: 'response.created',
      response: {
        id: 'provider-secret',
        metadata: {
          bob_response_nonce: 'a'.repeat(32),
          bob_turn_id: '00000000-0000-4000-8000-000000000010',
          bob_turn_kind: 'proposed',
          bob_navigate: '/devis/new',
          bob_proposal_id: '00000000-0000-4000-8000-000000000011',
          bob_proposal_expires_at: '2026-07-13T20:00:00.000Z',
          bob_context_revision: '12',
          bob_context_digest: 'b'.repeat(64),
        },
      },
    });
    expect(decoded).toEqual({
      type: 'response_started',
      controlReference: {
        turnId: '00000000-0000-4000-8000-000000000010',
        contextRevision: 12,
        contextDigest: 'b'.repeat(64),
      },
    });
    expect(JSON.stringify(decoded)).not.toContain('bob_response_nonce');
    expect(JSON.stringify(decoded)).not.toContain('provider-secret');
  });

  it('ignore toute référence incomplète ou enrichie par des metadata non prévues', () => {
    expect(decodeRealtimeServerEvent({
      type: 'response.created',
      response: {
        id: 'provider-secret',
        metadata: {
          bob_response_nonce: 'a'.repeat(32),
          bob_turn_id: '00000000-0000-4000-8000-000000000010',
          bob_turn_kind: 'answer',
          bob_navigate: 'https://evil.example',
          bob_context_revision: '1',
          bob_context_digest: 'b'.repeat(64),
          injected_effect: '/evil',
        },
      },
    })).toEqual({ type: 'response_started' });
  });

  it('décode la corrélation native exacte sans jamais exposer son nonce fournisseur', () => {
    const created = decodeRealtimeServerEvent({
      type: 'response.created',
      response: { id: 'resp_native', metadata: NATIVE_METADATA },
    });
    expect(created).toEqual({
      type: 'response_started',
      nativeSpeechReference: {
        deliveryId: NATIVE_METADATA.bob_delivery_id,
        turnId: NATIVE_METADATA.bob_turn_id,
        contextRevision: 7,
        contextDigest: NATIVE_METADATA.bob_context_digest,
      },
    });
    expect(realtimeProviderResponseId(created)).toBe('resp_native');
    expect(JSON.stringify(created)).not.toContain(NATIVE_METADATA.bob_request_nonce);

    const done = decodeRealtimeServerEvent({
      type: 'response.done',
      response: { id: 'resp_native', status: 'completed', metadata: NATIVE_METADATA },
    });
    expect(done).toMatchObject({
      type: 'response_done',
      status: 'completed',
      nativeSpeechReference: { deliveryId: NATIVE_METADATA.bob_delivery_id },
    });
    expect(JSON.stringify(done)).not.toContain(NATIVE_METADATA.bob_request_nonce);
  });

  it.each([
    ['incomplète', { ...NATIVE_METADATA, bob_request_nonce: undefined }],
    ['enrichie', { ...NATIVE_METADATA, injected_effect: '/evil' }],
    ['mauvais protocole', { ...NATIVE_METADATA, bob_protocol: 'bob.other.v1' }],
  ])('refuse une metadata native %s', (_label, metadata) => {
    expect(decodeRealtimeServerEvent({
      type: 'response.created',
      response: { id: 'resp_native', metadata },
    })).toEqual({ type: 'protocol_error', code: 'invalid_native_speech_metadata' });
  });

  it('exige la corrélation provider sur chaque transcript Bob', () => {
    expect(decodeRealtimeServerEvent({
      type: 'response.output_audio_transcript.done',
      transcript: 'Réponse Bob',
    })).toEqual({ type: 'protocol_error', code: 'invalid_response_id' });
  });

  it('décode l’accusé de purge audio sans conserver d’identifiant provider', () => {
    expect(decodeRealtimeServerEvent({
      type: 'output_audio_buffer.cleared',
      event_id: 'provider-secret',
      response_id: 'resp_clear',
    })).toEqual({ type: 'audio_cleared' });
  });

  it('utilise les événements de buffer WebRTC pour le début et la fin audio', () => {
    expect(decodeRealtimeServerEvent({
      type: 'output_audio_buffer.started',
      response_id: 'provider-secret',
    })).toEqual({ type: 'audio_signal', source: 'buffer_started' });
    expect(decodeRealtimeServerEvent({
      type: 'output_audio_buffer.stopped',
      response_id: 'resp_stopped',
    })).toEqual({ type: 'audio_stopped' });
  });
});

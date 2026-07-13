import { describe, expect, it } from 'vitest';
import { decodeRealtimeServerEvent } from './realtime-event-codecs';

describe('Bob Live — codecs événements Realtime', () => {
  it('décode seulement les signaux nécessaires sans conserver les deltas audio', () => {
    const decoded = decodeRealtimeServerEvent(JSON.stringify({
      type: 'response.output_audio.delta',
      delta: 'audio-base64-confidentiel',
      response_id: 'provider-id',
    }));
    expect(decoded).toEqual({ type: 'audio_signal' });
    expect(JSON.stringify(decoded)).not.toContain('audio-base64-confidentiel');
    expect(JSON.stringify(decoded)).not.toContain('provider-id');
  });

  it('borne les transcriptions et les codes erreurs', () => {
    const transcript = decodeRealtimeServerEvent({
      type: 'response.output_audio_transcript.delta',
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
    })).toEqual({ type: 'audio_signal' });
    expect(decodeRealtimeServerEvent({
      type: 'output_audio_buffer.stopped',
      response_id: 'resp_stopped',
    })).toEqual({ type: 'audio_stopped' });
  });
});

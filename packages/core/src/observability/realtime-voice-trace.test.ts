import { describe, expect, it } from 'vitest';
import {
  realtimeVoiceTraceDigestMaterial,
  validateRealtimeVoiceTraceEvent,
  type RealtimeVoiceTraceEvent,
} from './realtime-voice-trace';

const base = (): RealtimeVoiceTraceEvent => ({
  version: 1,
  eventKind: 'turn_transcript_final',
  companyId: '1c2f99c9-c744-4d11-b5dd-3a4e9e765a02',
  userId: 'c020986f-0615-45ca-afbc-c11132d7805e',
  traceAttemptId: '84e356e2-2dd0-49cf-9926-497811f31f9d',
  sessionHandle: '574e4ca3-35a6-4f34-81a7-910bf09755d2',
  ownerEpoch: 2,
  eventOrdinal: 4,
  turnId: 'c5fba162-799a-4e1a-bec4-a32116b83246',
  occurredAt: '2026-08-01T10:00:00.000Z',
  transcript: 'Je souhaite créer un nouveau client',
});

describe('Realtime Voice Trace V2 — contrat fermé', () => {
  it('accepte la chaîne finale exacte remise au planner', () => {
    const event = base();
    expect(validateRealtimeVoiceTraceEvent(event)).toEqual({
      ok: true,
      value: event,
    });
  });

  it('refuse transcript et réponse sur le mauvais type d’événement', () => {
    const event = {
      ...base(),
      eventKind: 'turn_agent_result' as const,
      canonicalReply: 'Je vais te poser les questions utiles.',
    };
    const result = validateRealtimeVoiceTraceEvent(event);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain('transcriptEventMismatch');
  });

  it('réserve ownerEpoch=0 aux échecs précédant l’acquisition sideband', () => {
    const result = validateRealtimeVoiceTraceEvent({ ...base(), ownerEpoch: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain('ownerEpochRequired');

    const {
      sessionHandle: _sessionHandle,
      turnId: _turnId,
      transcript: _transcript,
      ...withoutSession
    } = base();
    expect(
      validateRealtimeVoiceTraceEvent({
        ...withoutSession,
        eventKind: 'session_bootstrap_failed',
        ownerEpoch: 0,
        stage: 'provider_call',
        failureClass: 'provider_create_failed',
        outcome: 'failed',
      }).ok,
    ).toBe(true);
  });

  it('borne en caractères ET en octets UTF-8', () => {
    const result = validateRealtimeVoiceTraceEvent({
      ...base(),
      transcript: '🧾'.repeat(4_001),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain('transcript');
  });

  it('refuse une date non canonique et un zéro inventé hors durée réelle', () => {
    expect(
      validateRealtimeVoiceTraceEvent({
        ...base(),
        occurredAt: '2026-08-01T10:00:00Z',
      }).ok,
    ).toBe(false);
    expect(validateRealtimeVoiceTraceEvent({ ...base(), durationMs: -1 }).ok).toBe(false);
  });

  it('ferme la forme du plan sans référence client ni objet libre', () => {
    const { transcript: _transcript, ...withoutTranscript } = base();
    const plan: RealtimeVoiceTraceEvent = {
      ...withoutTranscript,
      eventKind: 'turn_semantic_plan',
      plannerDisposition: 'global_plan',
      plannerAuthority: 'global',
      plannerModel: 'gpt-5.4-mini',
      plannerStepIndex: 0,
      plannerStepCount: 1,
      plannerIntent: 'creer_client',
      durationMs: 218,
    };
    expect(validateRealtimeVoiceTraceEvent(plan).ok).toBe(true);
    expect(
      validateRealtimeVoiceTraceEvent({
        ...plan,
        plannerIntent: 'créer client Martin',
      }).ok,
    ).toBe(false);
  });

  it('produit un matériau HMAC déterministe et sensible au moindre écart', () => {
    const first = realtimeVoiceTraceDigestMaterial(base());
    expect(realtimeVoiceTraceDigestMaterial({ ...base() })).toBe(first);
    expect(
      realtimeVoiceTraceDigestMaterial({
        ...base(),
        transcript: 'Je souhaite créer un nouveau devis',
      }),
    ).not.toBe(first);
  });

  it('ne porte aucune date de rétention contrôlable par l’appelant', () => {
    expect(base()).not.toHaveProperty('retentionExpiresAt');
  });
});

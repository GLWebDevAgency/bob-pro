import { describe, expect, it, vi } from 'vitest';
import { CUSTOMER_CONTACT_MISSION_KIND_V1 } from '@bob/core';
import { CustomerContactMissionKindAdapter } from './customer-contact-mission-kind.adapter';
import { REALTIME_MISSION_UNAVAILABLE_SPEECH } from './quote-creation-mission-kind.adapter';
import type {
  RealtimeJarvisMissionOrchestrationInput,
  RealtimeJarvisMissionOrchestratorPort,
  RealtimeJarvisMissionPreparedTurn,
} from './realtime-jarvis-mission-orchestrator';

const FRAME = Object.freeze({
  schema: 'bob.semantic.customer-contact',
  version: 1,
  operation: Object.freeze({ kind: 'cancel_run' }),
  model: 'gpt-test',
} as const);

function input(): RealtimeJarvisMissionOrchestrationInput {
  return {} as RealtimeJarvisMissionOrchestrationInput;
}

describe('CustomerContactMissionKindAdapter', () => {
  it('publie son identité et délègue prepare/runPlanned tels quels', async () => {
    const prepared = { status: 'failed' as const, canonicalSpeech: 'préparation indisponible' };
    const outcome = { status: 'failed' as const, canonicalSpeech: 'rien exécuté' };
    const delegate: RealtimeJarvisMissionOrchestratorPort = {
      prepare: vi.fn(async () => prepared),
      runPlanned: vi.fn(async () => outcome),
    };
    const adapter = new CustomerContactMissionKindAdapter(delegate);
    const planned = {
      request: input(),
      prepared: {} as RealtimeJarvisMissionPreparedTurn,
      frame: FRAME,
    };

    expect(adapter.id).toBe(CUSTOMER_CONTACT_MISSION_KIND_V1);
    await expect(adapter.prepare(input())).resolves.toBe(prepared);
    await expect(adapter.runPlanned(planned)).resolves.toBe(outcome);
    expect(delegate.runPlanned).toHaveBeenCalledWith(planned);
  });

  it('échoue FERMÉ sans délégué câblé — jamais un kind à moitié présent', async () => {
    const adapter = new CustomerContactMissionKindAdapter(null);

    await expect(adapter.prepare(input())).resolves.toEqual({
      status: 'failed',
      canonicalSpeech: REALTIME_MISSION_UNAVAILABLE_SPEECH,
    });
    await expect(
      adapter.runPlanned({
        request: input(),
        prepared: {} as RealtimeJarvisMissionPreparedTurn,
        frame: FRAME,
      }),
    ).resolves.toEqual({
      status: 'failed',
      canonicalSpeech: REALTIME_MISSION_UNAVAILABLE_SPEECH,
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { QUOTE_CREATION_MISSION_KIND_V1 } from '@bob/core';
import type {
  RealtimeQuoteMissionOrchestrationInput,
  RealtimeQuoteMissionOrchestrationOutcome,
  RealtimeQuoteMissionOrchestratorPort,
} from './realtime-quote-mission-orchestrator';
import type { RegisteredRealtimeMissionKind } from './realtime-mission-kind';
import {
  RealtimeMissionKindRegistry,
  RealtimeMissionKindRegistryError,
} from './realtime-mission-kind';

const outcome: RealtimeQuoteMissionOrchestrationOutcome = {
  status: 'not_applicable',
};

function turn(): RealtimeQuoteMissionOrchestrationInput {
  return {} as RealtimeQuoteMissionOrchestrationInput;
}

function registryFromUnsafe(candidates: readonly unknown[]): RealtimeMissionKindRegistry {
  return new RealtimeMissionKindRegistry(
    candidates as readonly RegisteredRealtimeMissionKind[],
  );
}

function expectRegistryError(
  execute: () => unknown,
  code: RealtimeMissionKindRegistryError['code'],
): void {
  try {
    execute();
    throw new Error('Expected registry construction to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(RealtimeMissionKindRegistryError);
    expect((error as RealtimeMissionKindRegistryError).code).toBe(code);
  }
}

describe('RealtimeMissionKindRegistry', () => {
  it('capture une closure bindée, immuable et réellement appelable', async () => {
    const original = vi.fn(async () => outcome);
    const replacement = vi.fn(async () => ({
      status: 'failed' as const,
      canonicalSpeech: 'mutable',
    }));
    const candidate: {
      id: typeof QUOTE_CREATION_MISSION_KIND_V1;
      run: RealtimeQuoteMissionOrchestratorPort['run'];
    } = {
      id: QUOTE_CREATION_MISSION_KIND_V1,
      run: original,
    };
    const registry = new RealtimeMissionKindRegistry([candidate]);
    const captured = registry.get(QUOTE_CREATION_MISSION_KIND_V1);
    candidate.run = replacement;
    const input = turn();

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.run)).toBe(true);
    await expect(captured.run(input)).resolves.toBe(outcome);
    expect(original).toHaveBeenCalledWith(input);
    expect(replacement).not.toHaveBeenCalled();
  });

  it('refuse une liste vide ou un kind attendu manquant', () => {
    expectRegistryError(() => registryFromUnsafe([]), 'missing_id');
  });

  it.each([
    ['valeur primitive', [null], 'invalid_adapter'],
    ['adaptateur non appelable', [{
      id: QUOTE_CREATION_MISSION_KIND_V1,
      run: null,
    }], 'invalid_adapter'],
    ['identité inconnue', [{
      id: 'equipment_management@1',
      run: vi.fn(),
    }], 'unsupported_id'],
  ] as const)('refuse %s', (_label, candidates, code) => {
    expectRegistryError(() => registryFromUnsafe(candidates), code);
  });

  it('refuse deux propriétaires runtime pour la même identité', () => {
    const candidate = {
      id: QUOTE_CREATION_MISSION_KIND_V1,
      run: vi.fn(async () => outcome),
    };

    expectRegistryError(
      () => registryFromUnsafe([candidate, candidate]),
      'duplicate_id',
    );
  });

  it('échoue fermé si un appel JavaScript contourne le type fermé de get', () => {
    const registry = new RealtimeMissionKindRegistry([{
      id: QUOTE_CREATION_MISSION_KIND_V1,
      run: vi.fn(async () => outcome),
    }]);
    const unsafeGet = registry.get.bind(registry) as (id: unknown) => unknown;

    expectRegistryError(
      () => unsafeGet('equipment_management@1'),
      'unsupported_id',
    );
  });
});

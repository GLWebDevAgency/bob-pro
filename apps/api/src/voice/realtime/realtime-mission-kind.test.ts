import { describe, expect, it, vi } from 'vitest';
import { CUSTOMER_CONTACT_MISSION_KIND_V1, QUOTE_CREATION_MISSION_KIND_V1 } from '@bob/core';
import type {
  RealtimeQuoteMissionOrchestrationInput,
  RealtimeQuoteMissionOrchestrationOutcome,
  RealtimeQuoteMissionOrchestratorPort,
  RealtimeQuoteMissionPreparationOutcome,
  RealtimeQuoteMissionPreparedTurn,
} from './realtime-quote-mission-orchestrator';
import type { QuoteCreationSemanticFrameV1, QuoteCreationSemanticFrameV2 } from '@bob/ai';
import type { RegisteredRealtimeMissionKind } from './realtime-mission-kind';
import {
  RealtimeMissionKindRegistry,
  RealtimeMissionKindRegistryError,
} from './realtime-mission-kind';

const outcome: RealtimeQuoteMissionOrchestrationOutcome = {
  status: 'failed',
  canonicalSpeech: 'Rien n’a été exécuté.',
};
const preparation: RealtimeQuoteMissionPreparationOutcome = {
  status: 'failed',
  canonicalSpeech: 'Préparation indisponible.',
};

function turn(): RealtimeQuoteMissionOrchestrationInput {
  return {} as RealtimeQuoteMissionOrchestrationInput;
}

/** Le registre exige UN adaptateur par identité publiée : la fiche client complète la liste. */
function customerContactCandidate(): unknown {
  return {
    id: CUSTOMER_CONTACT_MISSION_KIND_V1,
    prepare: vi.fn(async () => preparation),
    runPlanned: vi.fn(async () => outcome),
  };
}

function registryFromUnsafe(candidates: readonly unknown[]): RealtimeMissionKindRegistry {
  return new RealtimeMissionKindRegistry(candidates as readonly RegisteredRealtimeMissionKind[]);
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
    const originalPrepare = vi.fn(async () => preparation);
    const originalRunPlanned = vi.fn(async () => outcome);
    const replacementPrepare = vi.fn(async () => ({
      status: 'failed' as const,
      canonicalSpeech: 'mutable prepare',
    }));
    const replacementRunPlanned = vi.fn(async () => ({
      status: 'failed' as const,
      canonicalSpeech: 'mutable',
    }));
    const candidate: {
      id: typeof QUOTE_CREATION_MISSION_KIND_V1;
      prepare: RealtimeQuoteMissionOrchestratorPort['prepare'];
      runPlanned: RealtimeQuoteMissionOrchestratorPort['runPlanned'];
    } = {
      id: QUOTE_CREATION_MISSION_KIND_V1,
      prepare: originalPrepare,
      runPlanned: originalRunPlanned,
    };
    const registry = registryFromUnsafe([candidate, customerContactCandidate()]);
    const captured = registry.get(QUOTE_CREATION_MISSION_KIND_V1);
    candidate.prepare = replacementPrepare;
    candidate.runPlanned = replacementRunPlanned;
    const input = turn();
    const planned = {
      request: input,
      prepared: {} as RealtimeQuoteMissionPreparedTurn,
      frame: {} as QuoteCreationSemanticFrameV1 | QuoteCreationSemanticFrameV2,
    };

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.prepare)).toBe(true);
    expect(Object.isFrozen(captured.runPlanned)).toBe(true);
    await expect(captured.prepare(input)).resolves.toBe(preparation);
    await expect(captured.runPlanned(planned)).resolves.toBe(outcome);
    expect(originalPrepare).toHaveBeenCalledWith(input);
    expect(originalRunPlanned).toHaveBeenCalledWith(planned);
    expect(replacementPrepare).not.toHaveBeenCalled();
    expect(replacementRunPlanned).not.toHaveBeenCalled();
  });

  it('refuse une liste vide ou un kind attendu manquant', () => {
    expectRegistryError(() => registryFromUnsafe([]), 'missing_id');
    // Le devis seul ne suffit plus : `customer_contact@1` est publié, il DOIT être câblé.
    expectRegistryError(
      () =>
        registryFromUnsafe([
          {
            id: QUOTE_CREATION_MISSION_KIND_V1,
            prepare: vi.fn(async () => preparation),
            runPlanned: vi.fn(async () => outcome),
          },
        ]),
      'missing_id',
    );
  });

  it.each([
    ['valeur primitive', [null], 'invalid_adapter'],
    [
      'adaptateur non appelable',
      [
        {
          id: QUOTE_CREATION_MISSION_KIND_V1,
          prepare: null,
          runPlanned: null,
        },
      ],
      'invalid_adapter',
    ],
    [
      'identité inconnue',
      [
        {
          id: 'equipment_management@1',
          prepare: vi.fn(),
          runPlanned: vi.fn(),
        },
      ],
      'unsupported_id',
    ],
  ] as const)('refuse %s', (_label, candidates, code) => {
    expectRegistryError(() => registryFromUnsafe(candidates), code);
  });

  it('refuse deux propriétaires runtime pour la même identité', () => {
    const candidate = {
      id: QUOTE_CREATION_MISSION_KIND_V1,
      prepare: vi.fn(async () => preparation),
      runPlanned: vi.fn(async () => outcome),
    };

    expectRegistryError(() => registryFromUnsafe([candidate, candidate]), 'duplicate_id');
  });

  it('échoue fermé si un appel JavaScript contourne le type fermé de get', () => {
    const registry = registryFromUnsafe([
      {
        id: QUOTE_CREATION_MISSION_KIND_V1,
        prepare: vi.fn(async () => preparation),
        runPlanned: vi.fn(async () => outcome),
      },
      customerContactCandidate(),
    ]);
    const unsafeGet = registry.get.bind(registry) as (id: unknown) => unknown;

    expectRegistryError(() => unsafeGet('equipment_management@1'), 'unsupported_id');
  });
});

import { describe, expect, it } from 'vitest';
import { QUOTE_CREATION_MISSION_KIND_V1 } from '@bob/core';
import {
  createLegacyExecutionAuthority,
  LEGACY_EXECUTION_AUTHORITY_CONTRACT_SHA256,
} from './intent-ownership';
import {
  preflightRuntimeToolOwnership,
  RUNTIME_TOOL_INTENTS,
  runtimeToolResultIntent,
} from './runtime-tool-intent';

describe('contrat exhaustif outil runtime → intentions', () => {
  it('déclare exactement les 51 outils runtime attendus', () => {
    const declared = Object.keys(RUNTIME_TOOL_INTENTS).sort();
    expect(declared).toHaveLength(51);
  });

  it('ne possède aucun fallback unknown et produit une empreinte stable de 256 bits', () => {
    for (const [tool, toolContract] of Object.entries(RUNTIME_TOOL_INTENTS)) {
      expect(toolContract.resultIntent, tool).not.toBe('unknown');
      expect(toolContract.authorityIntents, tool).not.toContain('unknown');
      expect(runtimeToolResultIntent(tool), tool).toBe(toolContract.resultIntent);
    }
    expect(LEGACY_EXECUTION_AUTHORITY_CONTRACT_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    expect(runtimeToolResultIntent('outil_non_contractuel')).toBeNull();
  });

  it('rend creer_devis legacy sans admission puis MissionKind-owned avec quote_creation@1', () => {
    const legacy = createLegacyExecutionAuthority([]);
    expect(
      preflightRuntimeToolOwnership(
        ['creer_devis'],
        (intent) => legacy.isIntentBlocked(intent),
      ),
    ).toEqual({ status: 'allowed' });

    const admitted = createLegacyExecutionAuthority([
      QUOTE_CREATION_MISSION_KIND_V1,
    ]);
    expect(
      preflightRuntimeToolOwnership(
        ['creer_devis'],
        (intent) => admitted.isIntentBlocked(intent),
      ),
    ).toEqual({
      status: 'mission_owned',
      tool: 'creer_devis',
      intent: 'nouveau_devis',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { QUOTE_CREATION_MISSION_KIND_V1 } from '@bob/core';
import {
  effectiveIntentOwner,
  INTENT_OWNERSHIP,
  legacyBlockedIntents,
} from './intent-ownership';

describe('intent ownership', () => {
  it('garde honnêtement les surfaces non migrées dans le legacy', () => {
    const nonLegacy = Object.entries(INTENT_OWNERSHIP).filter(
      ([, ownership]) => ownership.kind !== 'legacy',
    );

    expect(nonLegacy).toEqual([
      [
        'nouveau_devis',
        {
          kind: 'mission',
          missionKind: QUOTE_CREATION_MISSION_KIND_V1,
          legacyWhenNotAdmitted: true,
        },
      ],
    ]);
  });

  it('conserve le devis legacy sans capabilité MissionKind', () => {
    expect(effectiveIntentOwner('nouveau_devis', new Set())).toEqual({
      kind: 'legacy',
    });
    expect(legacyBlockedIntents([])).toEqual([]);
  });

  it('transfère exclusivement le devis à la mission admise', () => {
    const admitted = new Set([QUOTE_CREATION_MISSION_KIND_V1]);

    expect(effectiveIntentOwner('nouveau_devis', admitted)).toEqual({
      kind: 'mission',
      missionKind: QUOTE_CREATION_MISSION_KIND_V1,
    });
    const blocked = legacyBlockedIntents([QUOTE_CREATION_MISSION_KIND_V1]);
    expect(blocked).toEqual(['nouveau_devis']);
    expect(Object.isFrozen(blocked)).toBe(true);
  });
});

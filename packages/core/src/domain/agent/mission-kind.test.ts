import { describe, expect, it } from 'vitest';
import {
  MISSION_KIND_IDS,
  QUOTE_CREATION_MISSION_KIND_V1,
  isMissionKindId,
  type MissionKind,
} from './mission-kind';

describe('MissionKind runtime identity', () => {
  it('expose une liste fermée et immuable au runtime', () => {
    expect(MISSION_KIND_IDS).toEqual([QUOTE_CREATION_MISSION_KIND_V1]);
    expect(new Set(MISSION_KIND_IDS).size).toBe(MISSION_KIND_IDS.length);
    expect(Object.isFrozen(MISSION_KIND_IDS)).toBe(true);

    const kind: MissionKind = { id: QUOTE_CREATION_MISSION_KIND_V1 };
    expect(kind.id).toBe('quote_creation@1');
  });

  it('accepte uniquement les identités runtime publiées', () => {
    expect(isMissionKindId('quote_creation@1')).toBe(true);
    expect(isMissionKindId('quote_creation')).toBe(false);
    expect(isMissionKindId('quote_creation@2')).toBe(false);
    expect(isMissionKindId('equipment_management@1')).toBe(false);
    expect(isMissionKindId(null)).toBe(false);
    expect(isMissionKindId({ id: 'quote_creation@1' })).toBe(false);
  });
});

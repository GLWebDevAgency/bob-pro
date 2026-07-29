export const QUOTE_CREATION_MISSION_KIND_V1 = 'quote_creation@1' as const;

export const MISSION_KIND_IDS = Object.freeze([
  QUOTE_CREATION_MISSION_KIND_V1,
] as const);

export type MissionKindId = (typeof MISSION_KIND_IDS)[number];

export interface MissionKind {
  readonly id: MissionKindId;
}

export function isMissionKindId(value: unknown): value is MissionKindId {
  return typeof value === 'string'
    && MISSION_KIND_IDS.some((id) => id === value);
}

export const QUOTE_CREATION_MISSION_KIND_V1 = 'quote_creation@1' as const;
/**
 * Vertical fiche client (spec Jarvis §9.1) — lot U1-d. Cette identité entre dans la liste
 * ATOMIQUEMENT avec l'enregistrement de son adaptateur realtime : le registre exige un
 * adaptateur par identité publiée et échoue `missing_id` au boot sinon.
 */
export const CUSTOMER_CONTACT_MISSION_KIND_V1 = 'customer_contact@1' as const;

export const MISSION_KIND_IDS = Object.freeze([
  QUOTE_CREATION_MISSION_KIND_V1,
  CUSTOMER_CONTACT_MISSION_KIND_V1,
] as const);

export type MissionKindId = (typeof MISSION_KIND_IDS)[number];

export interface MissionKind {
  readonly id: MissionKindId;
}

export function isMissionKindId(value: unknown): value is MissionKindId {
  return typeof value === 'string' && MISSION_KIND_IDS.some((id) => id === value);
}

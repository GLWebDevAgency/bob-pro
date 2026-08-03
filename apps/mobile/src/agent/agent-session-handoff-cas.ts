export interface AgentSessionHandoffIdentity {
  readonly id: string;
  readonly expiresAt: number;
  readonly requestedAt: number | null;
}

export type AgentSessionHandoffCasResult<T> = Readonly<{
  value: T | null;
  changed: boolean;
}>;

/** Compare-and-set : un consumer A ne peut jamais effacer le handoff B arrivé entre-temps. */
export function consumeAgentSessionHandoff<T extends AgentSessionHandoffIdentity>(
  current: T | null,
  expectedId: string,
): AgentSessionHandoffCasResult<T> {
  return current?.id === expectedId
    ? Object.freeze({ value: null, changed: true })
    : Object.freeze({ value: current, changed: false });
}

/** Demande owner-bound et non expirée ; l'identité et le payload restent inchangés. */
export function requestAgentSessionHandoff<T extends AgentSessionHandoffIdentity>(
  current: T | null,
  expectedId: string,
  requestedAt: number,
): AgentSessionHandoffCasResult<T> {
  if (current?.id !== expectedId || current.expiresAt <= requestedAt) {
    return Object.freeze({ value: current, changed: false });
  }
  return Object.freeze({
    value: Object.freeze({ ...current, requestedAt }) as T,
    changed: true,
  });
}

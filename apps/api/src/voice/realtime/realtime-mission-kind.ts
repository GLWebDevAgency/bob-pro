import {
  MISSION_KIND_IDS,
  QUOTE_CREATION_MISSION_KIND_V1,
  isMissionKindId,
  type MissionKind,
  type MissionKindId,
} from '@bob/core';
import type {
  RealtimeQuoteMissionOrchestratorPort,
} from './realtime-quote-mission-orchestrator';

export interface QuoteCreationMissionKindV1
extends MissionKind, RealtimeQuoteMissionOrchestratorPort {
  readonly id: typeof QUOTE_CREATION_MISSION_KIND_V1;
}

export interface RealtimeMissionKindById {
  readonly [QUOTE_CREATION_MISSION_KIND_V1]: QuoteCreationMissionKindV1;
}

export type RegisteredRealtimeMissionKind =
  RealtimeMissionKindById[MissionKindId];

export type RealtimeMissionKindRegistryErrorCode =
  | 'invalid_adapter'
  | 'unsupported_id'
  | 'duplicate_id'
  | 'missing_id';

export class RealtimeMissionKindRegistryError extends Error {
  constructor(
    readonly code: RealtimeMissionKindRegistryErrorCode,
    readonly missionKindId: string | null,
  ) {
    super(
      missionKindId === null
        ? `Realtime MissionKind registry rejected: ${code}.`
        : `Realtime MissionKind registry rejected ${missionKindId}: ${code}.`,
    );
    this.name = 'RealtimeMissionKindRegistryError';
  }
}

function captureMissionKind(candidate: unknown): RegisteredRealtimeMissionKind {
  if (typeof candidate !== 'object' || candidate === null) {
    throw new RealtimeMissionKindRegistryError('invalid_adapter', null);
  }

  const id = Reflect.get(candidate, 'id');
  if (!isMissionKindId(id)) {
    throw new RealtimeMissionKindRegistryError(
      'unsupported_id',
      typeof id === 'string' ? id : null,
    );
  }

  const prepare = Reflect.get(candidate, 'prepare');
  const runPlanned = Reflect.get(candidate, 'runPlanned');
  if (typeof prepare !== 'function' || typeof runPlanned !== 'function') {
    throw new RealtimeMissionKindRegistryError('invalid_adapter', id);
  }

  switch (id) {
    case QUOTE_CREATION_MISSION_KIND_V1: {
      const capturedPrepare = prepare.bind(
        candidate,
      ) as RealtimeQuoteMissionOrchestratorPort['prepare'];
      const capturedRunPlanned = runPlanned.bind(
        candidate,
      ) as RealtimeQuoteMissionOrchestratorPort['runPlanned'];
      Object.freeze(capturedPrepare);
      Object.freeze(capturedRunPlanned);
      return Object.freeze({
        id,
        prepare: capturedPrepare,
        runPlanned: capturedRunPlanned,
      });
    }
  }
}

/**
 * Registre fermé construit au boot. Il capture les méthodes appelables afin qu'une mutation
 * tardive de l'adaptateur injecté ne puisse pas changer l'autorité exécutée en cours de process.
 */
export class RealtimeMissionKindRegistry {
  readonly #kinds: ReadonlyMap<MissionKindId, RegisteredRealtimeMissionKind>;

  constructor(kinds: readonly RegisteredRealtimeMissionKind[]) {
    const captured = new Map<MissionKindId, RegisteredRealtimeMissionKind>();

    for (const candidate of kinds as readonly unknown[]) {
      const kind = captureMissionKind(candidate);
      if (captured.has(kind.id)) {
        throw new RealtimeMissionKindRegistryError('duplicate_id', kind.id);
      }
      captured.set(kind.id, kind);
    }

    for (const expected of MISSION_KIND_IDS) {
      if (!captured.has(expected)) {
        throw new RealtimeMissionKindRegistryError('missing_id', expected);
      }
    }

    this.#kinds = captured;
    Object.freeze(this);
  }

  get<Id extends MissionKindId>(id: Id): RealtimeMissionKindById[Id] {
    const kind = this.#kinds.get(id);
    if (kind === undefined) {
      throw new RealtimeMissionKindRegistryError('unsupported_id', id);
    }
    return kind as RealtimeMissionKindById[Id];
  }
}

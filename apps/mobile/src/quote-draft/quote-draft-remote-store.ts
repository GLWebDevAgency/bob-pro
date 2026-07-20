import type { BobClient, QuoteDraftSlotView } from '@bob/api-client';
import type { AppError } from '@bob/core';
import type { QuoteDraftState } from './quote-draft-model';
import {
  decodeQuoteDraftServerSlot,
  encodeQuoteDraftServerPayload,
} from './quote-draft-server-codec';

export type QuoteDraftRemoteOperation = 'load' | 'save' | 'delete';
export type QuoteDraftRemoteErrorCode =
  | 'load_failed'
  | 'save_failed'
  | 'delete_failed'
  | 'revision_conflict'
  | 'not_loaded'
  | 'session_closed';

export class QuoteDraftRemoteError extends Error {
  constructor(
    readonly code: QuoteDraftRemoteErrorCode,
    readonly operation: QuoteDraftRemoteOperation,
  ) {
    super(`QUOTE_DRAFT_REMOTE_${code.toUpperCase()}`);
    this.name = 'QuoteDraftRemoteError';
  }
}

export interface QuoteDraftRemotePersistence {
  /** GET obligatoire : aucune donnée de brouillon n'est rendue avant son résultat. */
  readonly load: () => Promise<QuoteDraftState | null>;
  /** PUT CAS avec la dernière révision réellement observée sur le serveur. */
  readonly save: (state: QuoteDraftState) => Promise<QuoteDraftState>;
  /** DELETE CAS, réservé à l'abandon explicite ou à la finalisation réelle. */
  readonly clear: () => Promise<void>;
  /** Invalide immédiatement tous les résultats tardifs, sans aucune mutation serveur. */
  readonly dispose: () => void;
}

export type QuoteDraftRemoteClient = Pick<
  BobClient,
  'getQuoteDraft' | 'saveQuoteDraft' | 'deleteQuoteDraft'
>;

function failure(
  operation: QuoteDraftRemoteOperation,
  error: AppError,
): QuoteDraftRemoteError {
  if (
    error.kind === 'conflict'
    || (operation === 'delete' && error.kind === 'not_found')
  ) {
    return new QuoteDraftRemoteError('revision_conflict', operation);
  }
  const code = operation === 'load'
    ? 'load_failed'
    : operation === 'save'
      ? 'save_failed'
      : 'delete_failed';
  return new QuoteDraftRemoteError(code, operation);
}

/**
 * Slot distant sérialisé. La révision CAS reste dans cet adapter et n'est jamais confondue avec
 * `state.revision` (révision du contenu financier). Une seule requête mutante peut être en vol ;
 * une déconnexion invalide la file et ses réponses sans envoyer de DELETE.
 */
class HttpQuoteDraftRemotePersistence implements QuoteDraftRemotePersistence {
  private active = true;
  private generation = 0;
  private loaded = false;
  private serverRevision: number | null = null;
  private tail: Promise<void> = Promise.resolve();
  private loadInFlight: Promise<QuoteDraftState | null> | null = null;

  constructor(private readonly client: QuoteDraftRemoteClient) {}

  private assertSession(generation: number, operation: QuoteDraftRemoteOperation): void {
    if (!this.active || generation !== this.generation) {
      throw new QuoteDraftRemoteError('session_closed', operation);
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  load(): Promise<QuoteDraftState | null> {
    if (!this.active) {
      return Promise.reject(new QuoteDraftRemoteError('session_closed', 'load'));
    }
    if (this.loadInFlight !== null) return this.loadInFlight;
    const generation = this.generation;
    const flight = this.enqueue(async () => {
      this.assertSession(generation, 'load');
      const result = await this.client.getQuoteDraft();
      this.assertSession(generation, 'load');
      if (!result.ok) throw failure('load', result.error);
      this.loaded = true;
      this.serverRevision = result.value?.revision ?? 0;
      return result.value === null ? null : decodeQuoteDraftServerSlot(result.value);
    });
    this.loadInFlight = flight;
    const clearFlight = (): void => {
      if (this.loadInFlight === flight) this.loadInFlight = null;
    };
    void flight.then(clearFlight, clearFlight);
    return flight;
  }

  save(state: QuoteDraftState): Promise<QuoteDraftState> {
    const generation = this.generation;
    return this.enqueue(async () => {
      this.assertSession(generation, 'save');
      if (!this.loaded || this.serverRevision === null) {
        throw new QuoteDraftRemoteError('not_loaded', 'save');
      }
      const result = await this.client.saveQuoteDraft({
        expectedRevision: this.serverRevision,
        payload: encodeQuoteDraftServerPayload(state),
      });
      this.assertSession(generation, 'save');
      if (!result.ok) throw failure('save', result.error);
      this.serverRevision = result.value.revision;
      return decodeQuoteDraftServerSlot(result.value);
    });
  }

  clear(): Promise<void> {
    const generation = this.generation;
    return this.enqueue(async () => {
      this.assertSession(generation, 'delete');
      if (!this.loaded || this.serverRevision === null) {
        throw new QuoteDraftRemoteError('not_loaded', 'delete');
      }
      if (this.serverRevision === 0) return;
      const result = await this.client.deleteQuoteDraft(this.serverRevision);
      this.assertSession(generation, 'delete');
      if (!result.ok) throw failure('delete', result.error);
      this.serverRevision = 0;
    });
  }

  dispose(): void {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    this.loaded = false;
    this.serverRevision = null;
    this.loadInFlight = null;
  }
}

export function createQuoteDraftRemotePersistence(
  client: QuoteDraftRemoteClient,
): QuoteDraftRemotePersistence {
  return new HttpQuoteDraftRemotePersistence(client);
}

/** Hook de logout volontairement minuscule et testable : invalider, jamais effacer. */
export function disposeQuoteDraftSession(
  persistence: QuoteDraftRemotePersistence,
): Promise<void> {
  persistence.dispose();
  return Promise.resolve();
}

export function isQuoteDraftRevisionConflict(error: unknown): boolean {
  return error instanceof QuoteDraftRemoteError && error.code === 'revision_conflict';
}

/** Fabrique de slot utile uniquement aux tests de contrat de l'adapter. */
export type { QuoteDraftSlotView };

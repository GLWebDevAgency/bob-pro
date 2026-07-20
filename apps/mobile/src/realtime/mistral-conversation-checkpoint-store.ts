import {
  MISTRAL_CONVERSATION_PROTOCOL,
  type MistralConversationSessionEndReason,
} from '@bob/ai';
import * as SecureStore from 'expo-secure-store';

import type { MistralConversationEventStreamResume } from './mistral-conversation-event-stream';

export const MISTRAL_CONVERSATION_CHECKPOINT_SLOT =
  'bob.realtime.mistral.terminal-checkpoint.v1' as const;
export const MISTRAL_CONVERSATION_CHECKPOINT_KEYCHAIN_SERVICE =
  'bob.realtime.mistral.terminal-checkpoint.v1' as const;
export const MISTRAL_CONVERSATION_CHECKPOINT_MAX_BYTES = 4_096 as const;
export const MISTRAL_CONVERSATION_CHECKPOINT_VERSION = 1 as const;

const UINT32_CURSOR_END = 0x1_0000_0000;
const INT32_MAX = 0x7fff_ffff;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const SUBJECT_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SESSION_HANDLE = /^[A-Za-z0-9_-]{16,128}$/u;
const COORDINATOR_CONSTRUCTION = Symbol('mistral-conversation-checkpoint-coordinator');

const SESSION_END_REASONS: ReadonlySet<MistralConversationSessionEndReason> = new Set([
  'user',
  'background',
  'context_changed',
  'client_handoff',
  'expired',
  'service_shutdown',
  'fatal_error',
]);

export interface MistralConversationCheckpointIdentity {
  /** `session.user.id` Supabase, jamais un identifiant proposé par le modèle. */
  readonly subjectId: string;
  /** Tenant extrait des app_metadata authentifiées. */
  readonly companyId: string;
}

/**
 * Capability locale anti-write-tardif.
 *
 * L'objet est lié par identité référentielle au store qui l'a émis : recopier ses champs ne
 * permet pas de réactiver une génération invalidée lors d'un switch de compte ou d'un logout.
 */
export interface MistralConversationCheckpointOwnerFence {
  readonly identity: MistralConversationCheckpointIdentity;
  readonly generation: number;
}

export interface MistralConversationTerminalProjection {
  readonly phase: 'draining' | 'closed';
  readonly reason: MistralConversationSessionEndReason;
}

export interface MistralConversationTerminalCheckpointState {
  readonly sessionHandle: string;
  readonly missionExpiresAt: string;
  /** Curseur et projection sont écrits atomiquement dans le même slot. */
  readonly stream: MistralConversationEventStreamResume;
  readonly projection: MistralConversationTerminalProjection;
}

export interface MistralConversationTerminalCheckpoint
  extends MistralConversationTerminalCheckpointState,
  MistralConversationCheckpointIdentity {
  readonly version: typeof MISTRAL_CONVERSATION_CHECKPOINT_VERSION;
  readonly protocol: typeof MISTRAL_CONVERSATION_PROTOCOL;
}

/** Preuve applicative issue exclusivement de l'ACK terminal du serveur. */
export interface MistralConversationTerminalCompleteProof
  extends MistralConversationCheckpointIdentity {
  readonly kind: 'terminal_complete';
  readonly protocol: typeof MISTRAL_CONVERSATION_PROTOCOL;
  readonly sessionHandle: string;
  readonly missionConnectionEpoch: number;
  readonly nextServerSequence: number;
  readonly reason: MistralConversationSessionEndReason;
}

export type MistralConversationCheckpointStoreErrorCode =
  | 'invalid_owner'
  | 'stale_owner'
  | 'secure_store_unavailable'
  | 'checkpoint_corrupted'
  | 'checkpoint_too_large'
  | 'invalid_checkpoint'
  | 'session_replacement_requires_clear'
  | 'cursor_regression'
  | 'epoch_regression'
  | 'terminal_reopen'
  | 'terminal_conflict'
  | 'terminal_not_closed'
  | 'terminal_proof_mismatch'
  | 'terminal_clear_in_progress'
  | 'auth_boundary_purge_required'
  | 'auth_boundary_purge_in_progress'
  | 'scrub_required'
  | 'scrub_not_required'
  | 'coordinator_conflict'
  | 'write_verification_failed'
  | 'delete_verification_failed';

/** Erreur opaque : aucun contenu du coffre, ticket ou transcript n'est recopié dans le message. */
export class MistralConversationCheckpointStoreError extends Error {
  constructor(readonly code: MistralConversationCheckpointStoreErrorCode) {
    super(code);
    this.name = 'MistralConversationCheckpointStoreError';
  }
}

export interface MistralConversationCheckpointStoreDependencies {
  readonly secureStore: {
    isAvailable(): Promise<boolean>;
    getItem(key: string, options: SecureStore.SecureStoreOptions): Promise<string | null>;
    setItem(
      key: string,
      value: string,
      options: SecureStore.SecureStoreOptions,
    ): Promise<void>;
    deleteItem(key: string, options: SecureStore.SecureStoreOptions): Promise<void>;
  };
  readonly keychainAccessible: SecureStore.KeychainAccessibilityConstant;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function validIdentity(value: unknown): value is MistralConversationCheckpointIdentity {
  return isRecord(value)
    && hasExactKeys(value, ['subjectId', 'companyId'])
    && typeof value['subjectId'] === 'string'
    && SUBJECT_ID.test(value['subjectId'])
    && typeof value['companyId'] === 'string'
    && COMPANY_ID.test(value['companyId']);
}

function sameIdentity(
  left: MistralConversationCheckpointIdentity,
  right: MistralConversationCheckpointIdentity,
): boolean {
  return left.subjectId === right.subjectId && left.companyId === right.companyId;
}

function parseStream(value: unknown): MistralConversationEventStreamResume | null {
  if (!isRecord(value)) return null;
  const closed = Object.prototype.hasOwnProperty.call(value, 'closed');
  if (!hasExactKeys(value, [
    'nextServerSequence',
    'sessionReadyAccepted',
    'sessionHandle',
    'missionConnectionEpoch',
    ...(closed ? ['closed'] : []),
  ])) return null;

  const nextServerSequence = value['nextServerSequence'];
  const missionConnectionEpoch = value['missionConnectionEpoch'];
  const sessionHandle = value['sessionHandle'];
  if (
    typeof nextServerSequence !== 'number'
    || !Number.isSafeInteger(nextServerSequence)
    || Object.is(nextServerSequence, -0)
    || nextServerSequence < 1
    || nextServerSequence > UINT32_CURSOR_END
    || value['sessionReadyAccepted'] !== true
    || typeof sessionHandle !== 'string'
    || !SESSION_HANDLE.test(sessionHandle)
    || typeof missionConnectionEpoch !== 'number'
    || !Number.isSafeInteger(missionConnectionEpoch)
    || Object.is(missionConnectionEpoch, -0)
    || missionConnectionEpoch < 1
    || missionConnectionEpoch > INT32_MAX
    || (closed && value['closed'] !== true)
  ) return null;

  return {
    nextServerSequence,
    sessionReadyAccepted: true,
    sessionHandle,
    missionConnectionEpoch,
    ...(closed ? { closed: true } : {}),
  };
}

function parseProjection(value: unknown): MistralConversationTerminalProjection | null {
  if (!isRecord(value) || !hasExactKeys(value, ['phase', 'reason'])) return null;
  const phase = value['phase'];
  const reason = value['reason'];
  if (
    (phase !== 'draining' && phase !== 'closed')
    || typeof reason !== 'string'
    || !SESSION_END_REASONS.has(reason as MistralConversationSessionEndReason)
  ) return null;
  return { phase, reason: reason as MistralConversationSessionEndReason };
}

function parseCheckpoint(value: unknown): MistralConversationTerminalCheckpoint | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'version',
    'protocol',
    'subjectId',
    'companyId',
    'sessionHandle',
    'missionExpiresAt',
    'stream',
    'projection',
  ])) return null;

  const identityCandidate = {
    subjectId: value['subjectId'],
    companyId: value['companyId'],
  };
  const stream = parseStream(value['stream']);
  const projection = parseProjection(value['projection']);
  const sessionHandle = value['sessionHandle'];
  if (
    value['version'] !== MISTRAL_CONVERSATION_CHECKPOINT_VERSION
    || value['protocol'] !== MISTRAL_CONVERSATION_PROTOCOL
    || !validIdentity(identityCandidate)
    || typeof sessionHandle !== 'string'
    || !SESSION_HANDLE.test(sessionHandle)
    || !isCanonicalIso(value['missionExpiresAt'])
    || stream === null
    || projection === null
    || stream.sessionHandle !== sessionHandle
    || (stream.closed === true) !== (projection.phase === 'closed')
    || (projection.phase === 'draining' && stream.nextServerSequence < 2)
    || (projection.phase === 'closed' && stream.nextServerSequence < 3)
  ) return null;

  return {
    version: MISTRAL_CONVERSATION_CHECKPOINT_VERSION,
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    ...identityCandidate,
    sessionHandle,
    missionExpiresAt: value['missionExpiresAt'],
    stream,
    projection,
  };
}

function decodeCheckpoint(raw: string): MistralConversationTerminalCheckpoint | null {
  if (raw.length === 0 || utf8Bytes(raw) > MISTRAL_CONVERSATION_CHECKPOINT_MAX_BYTES) return null;
  try {
    return parseCheckpoint(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function encodeCheckpoint(checkpoint: MistralConversationTerminalCheckpoint): string {
  const raw = JSON.stringify(checkpoint);
  if (utf8Bytes(raw) > MISTRAL_CONVERSATION_CHECKPOINT_MAX_BYTES) {
    throw new MistralConversationCheckpointStoreError('checkpoint_too_large');
  }
  return raw;
}

function checkpointFromState(
  identity: MistralConversationCheckpointIdentity,
  state: MistralConversationTerminalCheckpointState,
): MistralConversationTerminalCheckpoint {
  const checkpoint = parseCheckpoint({
    version: MISTRAL_CONVERSATION_CHECKPOINT_VERSION,
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    subjectId: identity.subjectId,
    companyId: identity.companyId,
    sessionHandle: state.sessionHandle,
    missionExpiresAt: state.missionExpiresAt,
    stream: state.stream,
    projection: state.projection,
  });
  if (checkpoint === null) {
    throw new MistralConversationCheckpointStoreError('invalid_checkpoint');
  }
  return checkpoint;
}

function assertMonotone(
  previous: MistralConversationTerminalCheckpoint,
  next: MistralConversationTerminalCheckpoint,
): void {
  if (previous.sessionHandle !== next.sessionHandle) {
    throw new MistralConversationCheckpointStoreError('session_replacement_requires_clear');
  }
  if (previous.missionExpiresAt !== next.missionExpiresAt) {
    throw new MistralConversationCheckpointStoreError('terminal_conflict');
  }
  if (next.stream.nextServerSequence < previous.stream.nextServerSequence) {
    throw new MistralConversationCheckpointStoreError('cursor_regression');
  }
  if (next.stream.missionConnectionEpoch < previous.stream.missionConnectionEpoch) {
    throw new MistralConversationCheckpointStoreError('epoch_regression');
  }
  if (previous.projection.phase === 'closed' && next.projection.phase !== 'closed') {
    throw new MistralConversationCheckpointStoreError('terminal_reopen');
  }
  if (
    previous.projection.phase === 'draining'
    && next.projection.phase === 'closed'
    && next.stream.nextServerSequence <= previous.stream.nextServerSequence
  ) {
    throw new MistralConversationCheckpointStoreError('terminal_conflict');
  }
  if (
    previous.projection.reason !== next.projection.reason
    || (previous.projection.phase === 'closed' && (
      next.stream.nextServerSequence !== previous.stream.nextServerSequence
      || next.stream.missionConnectionEpoch !== previous.stream.missionConnectionEpoch
    ))
    || (
      next.stream.missionConnectionEpoch > previous.stream.missionConnectionEpoch
      && next.stream.nextServerSequence <= previous.stream.nextServerSequence
    )
  ) {
    throw new MistralConversationCheckpointStoreError('terminal_conflict');
  }
}

function parseTerminalCompleteProof(
  value: unknown,
): MistralConversationTerminalCompleteProof | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'kind',
    'protocol',
    'subjectId',
    'companyId',
    'sessionHandle',
    'missionConnectionEpoch',
    'nextServerSequence',
    'reason',
  ])) return null;
  const identity = { subjectId: value['subjectId'], companyId: value['companyId'] };
  const epoch = value['missionConnectionEpoch'];
  const cursor = value['nextServerSequence'];
  const reason = value['reason'];
  if (
    value['kind'] !== 'terminal_complete'
    || value['protocol'] !== MISTRAL_CONVERSATION_PROTOCOL
    || !validIdentity(identity)
    || typeof value['sessionHandle'] !== 'string'
    || !SESSION_HANDLE.test(value['sessionHandle'])
    || typeof epoch !== 'number'
    || !Number.isSafeInteger(epoch)
    || Object.is(epoch, -0)
    || epoch < 1
    || epoch > INT32_MAX
    || typeof cursor !== 'number'
    || !Number.isSafeInteger(cursor)
    || Object.is(cursor, -0)
    || cursor < 3
    || cursor > UINT32_CURSOR_END
    || typeof reason !== 'string'
    || !SESSION_END_REASONS.has(reason as MistralConversationSessionEndReason)
  ) return null;
  return {
    kind: 'terminal_complete',
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    ...identity,
    sessionHandle: value['sessionHandle'],
    missionConnectionEpoch: epoch,
    nextServerSequence: cursor,
    reason: reason as MistralConversationSessionEndReason,
  };
}

function proofMatchesCheckpoint(
  proof: MistralConversationTerminalCompleteProof,
  checkpoint: MistralConversationTerminalCheckpoint,
): boolean {
  return sameIdentity(proof, checkpoint)
    && proof.sessionHandle === checkpoint.sessionHandle
    && proof.missionConnectionEpoch === checkpoint.stream.missionConnectionEpoch
    && proof.nextServerSequence === checkpoint.stream.nextServerSequence
    && proof.reason === checkpoint.projection.reason;
}

function sameProof(
  left: MistralConversationTerminalCompleteProof,
  right: MistralConversationTerminalCompleteProof,
): boolean {
  return left.kind === right.kind
    && left.protocol === right.protocol
    && sameIdentity(left, right)
    && left.sessionHandle === right.sessionHandle
    && left.missionConnectionEpoch === right.missionConnectionEpoch
    && left.nextServerSequence === right.nextServerSequence
    && left.reason === right.reason;
}

interface TerminalClearLock {
  readonly fence: MistralConversationCheckpointOwnerFence;
  readonly proof: MistralConversationTerminalCompleteProof;
  proofVerified: boolean;
}

interface AuthBoundaryPurgeLock {
  readonly fence: MistralConversationCheckpointOwnerFence;
}

type CheckpointQuarantine =
  | { readonly mode: 'rollback_contamination' }
  | { readonly mode: 'corruption' }
  | { readonly mode: 'terminal_preverification'; readonly lock: TerminalClearLock }
  | { readonly mode: 'terminal_postverification'; readonly lock: TerminalClearLock }
  | { readonly mode: 'auth_boundary'; readonly lock: AuthBoundaryPurgeLock };

/**
 * Autorité processus unique du slot. Elle linéarise aussi plusieurs façades de test explicites.
 * Un coordinateur refuse deux adaptateurs SecureStore différents afin d'éviter deux vérités.
 */
export class MistralConversationCheckpointCoordinator {
  operationTail: Promise<void> = Promise.resolve();
  activeFence: MistralConversationCheckpointOwnerFence | null = null;
  generation = 0;
  terminalClear: TerminalClearLock | null = null;
  authBoundaryPurge: AuthBoundaryPurgeLock | null = null;
  authBoundaryPurgedFence: MistralConversationCheckpointOwnerFence | null = null;
  quarantine: CheckpointQuarantine | null = null;
  lastKnownCheckpoint: MistralConversationTerminalCheckpoint | null = null;
  dependencies: MistralConversationCheckpointStoreDependencies | null = null;
  options: SecureStore.SecureStoreOptions | null = null;

  constructor(token: symbol) {
    if (token !== COORDINATOR_CONSTRUCTION) {
      throw new MistralConversationCheckpointStoreError('coordinator_conflict');
    }
  }

  register(dependencies: MistralConversationCheckpointStoreDependencies): void {
    if (this.dependencies !== null) {
      if (
        this.dependencies.secureStore !== dependencies.secureStore
        || this.dependencies.keychainAccessible !== dependencies.keychainAccessible
      ) {
        throw new MistralConversationCheckpointStoreError('coordinator_conflict');
      }
      return;
    }
    this.dependencies = dependencies;
    this.options = Object.freeze({
      keychainAccessible: dependencies.keychainAccessible,
      keychainService: MISTRAL_CONVERSATION_CHECKPOINT_KEYCHAIN_SERVICE,
    });
  }
}

/** Coordinateur isolé réservé aux tests et aux adaptateurs injectés explicitement. */
export function createMistralConversationCheckpointCoordinatorForTesting(
): MistralConversationCheckpointCoordinator {
  return new MistralConversationCheckpointCoordinator(COORDINATOR_CONSTRUCTION);
}

/**
 * Coffre terminal Mistral v2.
 *
 * Il n'existe qu'un slot par installation. Chaque opération native est sérialisée et fence-checkée
 * avant/après les awaits afin qu'un changement d'utilisateur invalide immédiatement les opérations
 * en vol. La suppression n'est exposée qu'avec la preuve serveur `terminal_complete`, jamais à la
 * simple fermeture du WebSocket.
 */
export interface MistralConversationCheckpointStore {
  /** Capability processus existante, pour qu'un provider React remonte puisse la purger/adopter. */
  activeOwnerFence(): MistralConversationCheckpointOwnerFence | null;
  activateOwner(
    identity: MistralConversationCheckpointIdentity,
  ): MistralConversationCheckpointOwnerFence;
  deactivateOwner(fence: MistralConversationCheckpointOwnerFence): void;
  load(
    fence: MistralConversationCheckpointOwnerFence,
  ): Promise<MistralConversationTerminalCheckpoint | null>;
  save(
    fence: MistralConversationCheckpointOwnerFence,
    state: MistralConversationTerminalCheckpointState,
  ): Promise<MistralConversationTerminalCheckpoint>;
  clearAfterTerminalComplete(
    fence: MistralConversationCheckpointOwnerFence,
    proof: MistralConversationTerminalCompleteProof,
  ): Promise<void>;
  /** Reprend uniquement une suppression terminale dont la preuve est deja verrouillee en memoire. */
  retryInterruptedTerminalClear(
    fence: MistralConversationCheckpointOwnerFence,
  ): Promise<void>;
  /** Purge de logout/switch, indépendante de l'état draining/closed. */
  purgeForAuthBoundary(fence: MistralConversationCheckpointOwnerFence): Promise<void>;
  /** Maintenance réservée aux contaminations attestées (rollback tardif ou corruption). */
  scrubRequiredCheckpoint(): Promise<void>;
}

class SecureMistralConversationCheckpointStore implements MistralConversationCheckpointStore {
  constructor(private readonly coordinator: MistralConversationCheckpointCoordinator) {}

  activeOwnerFence(): MistralConversationCheckpointOwnerFence | null {
    return this.coordinator.activeFence;
  }

  activateOwner(
    identity: MistralConversationCheckpointIdentity,
  ): MistralConversationCheckpointOwnerFence {
    if (!validIdentity(identity)) {
      throw new MistralConversationCheckpointStoreError('invalid_owner');
    }
    if (this.coordinator.authBoundaryPurge !== null) {
      throw new MistralConversationCheckpointStoreError('auth_boundary_purge_in_progress');
    }
    if (this.coordinator.terminalClear !== null) {
      throw new MistralConversationCheckpointStoreError('terminal_clear_in_progress');
    }
    if (this.coordinator.quarantine !== null) {
      throw new MistralConversationCheckpointStoreError('scrub_required');
    }
    if (
      this.coordinator.activeFence !== null
      && sameIdentity(this.coordinator.activeFence.identity, identity)
    ) {
      if (this.coordinator.authBoundaryPurgedFence === this.coordinator.activeFence) {
        throw new MistralConversationCheckpointStoreError('auth_boundary_purge_required');
      }
      return this.coordinator.activeFence;
    }
    if (
      this.coordinator.activeFence !== null
      && this.coordinator.authBoundaryPurgedFence !== this.coordinator.activeFence
    ) {
      throw new MistralConversationCheckpointStoreError('auth_boundary_purge_required');
    }
    if (this.coordinator.generation >= Number.MAX_SAFE_INTEGER) {
      throw new MistralConversationCheckpointStoreError('invalid_owner');
    }
    this.coordinator.generation += 1;
    const frozenIdentity = Object.freeze({
      subjectId: identity.subjectId,
      companyId: identity.companyId,
    });
    this.coordinator.activeFence = Object.freeze({
      identity: frozenIdentity,
      generation: this.coordinator.generation,
    });
    this.coordinator.authBoundaryPurgedFence = null;
    return this.coordinator.activeFence;
  }

  deactivateOwner(fence: MistralConversationCheckpointOwnerFence): void {
    this.assertFence(fence);
    if (this.coordinator.authBoundaryPurge !== null) {
      throw new MistralConversationCheckpointStoreError('auth_boundary_purge_in_progress');
    }
    if (this.coordinator.terminalClear !== null) {
      throw new MistralConversationCheckpointStoreError('terminal_clear_in_progress');
    }
    if (this.coordinator.quarantine !== null) {
      throw new MistralConversationCheckpointStoreError('scrub_required');
    }
    if (this.coordinator.authBoundaryPurgedFence !== fence) {
      throw new MistralConversationCheckpointStoreError('auth_boundary_purge_required');
    }
    this.coordinator.activeFence = null;
    this.coordinator.authBoundaryPurgedFence = null;
    if (this.coordinator.generation < Number.MAX_SAFE_INTEGER) {
      this.coordinator.generation += 1;
    }
  }

  load(
    fence: MistralConversationCheckpointOwnerFence,
  ): Promise<MistralConversationTerminalCheckpoint | null> {
    try {
      this.assertOperational(fence);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.serialized(async () => {
      this.assertOperational(fence);
      const raw = await this.readRaw(fence);
      if (raw === null) return null;
      if (utf8Bytes(raw) > MISTRAL_CONVERSATION_CHECKPOINT_MAX_BYTES) {
        await this.verifiedOperationalDelete(fence);
        throw new MistralConversationCheckpointStoreError('checkpoint_too_large');
      }
      const checkpoint = decodeCheckpoint(raw);
      if (checkpoint === null) {
        await this.verifiedOperationalDelete(fence);
        throw new MistralConversationCheckpointStoreError('checkpoint_corrupted');
      }
      if (!sameIdentity(checkpoint, fence.identity)) {
        await this.verifiedOperationalDelete(fence);
        this.coordinator.lastKnownCheckpoint = null;
        return null;
      }
      this.coordinator.lastKnownCheckpoint = checkpoint;
      return checkpoint;
    });
  }

  save(
    fence: MistralConversationCheckpointOwnerFence,
    state: MistralConversationTerminalCheckpointState,
  ): Promise<MistralConversationTerminalCheckpoint> {
    try {
      this.assertOperational(fence);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.serialized(async () => {
      this.assertOperational(fence);
      const next = checkpointFromState(fence.identity, state);
      const previousRaw = await this.readRaw(fence);
      if (previousRaw !== null) {
        if (utf8Bytes(previousRaw) > MISTRAL_CONVERSATION_CHECKPOINT_MAX_BYTES) {
          await this.verifiedOperationalDelete(fence);
          throw new MistralConversationCheckpointStoreError('checkpoint_too_large');
        }
        const previous = decodeCheckpoint(previousRaw);
        if (previous === null) {
          await this.verifiedOperationalDelete(fence);
          throw new MistralConversationCheckpointStoreError('checkpoint_corrupted');
        }
        if (!sameIdentity(previous, fence.identity)) {
          await this.verifiedOperationalDelete(fence);
        } else {
          assertMonotone(previous, next);
        }
      }

      // Conservé avant l'I/O : si terminal_complete révoque une écriture déjà en vol, la preuve
      // peut encore être rapprochée de cette projection après le scrub attesté du slot.
      this.coordinator.lastKnownCheckpoint = next;
      const raw = encodeCheckpoint(next);
      await this.writeRawVerified(fence, raw);
      return next;
    });
  }

  clearAfterTerminalComplete(
    fence: MistralConversationCheckpointOwnerFence,
    proofInput: MistralConversationTerminalCompleteProof,
  ): Promise<void> {
    this.assertFence(fence);
    if (this.coordinator.authBoundaryPurge !== null) {
      return Promise.reject(
        new MistralConversationCheckpointStoreError('auth_boundary_purge_in_progress'),
      );
    }
    if (this.coordinator.authBoundaryPurgedFence === fence) {
      return Promise.reject(
        new MistralConversationCheckpointStoreError('auth_boundary_purge_required'),
      );
    }
    const proof = parseTerminalCompleteProof(proofInput);
    if (proof === null || !sameIdentity(proof, fence.identity)) {
      return Promise.reject(
        new MistralConversationCheckpointStoreError('terminal_proof_mismatch'),
      );
    }

    const known = this.coordinator.lastKnownCheckpoint;
    if (known !== null && sameIdentity(known, fence.identity)) {
      if (known.projection.phase !== 'closed' || known.stream.closed !== true) {
        return Promise.reject(new MistralConversationCheckpointStoreError('terminal_not_closed'));
      }
      if (!proofMatchesCheckpoint(proof, known)) {
        return Promise.reject(
          new MistralConversationCheckpointStoreError('terminal_proof_mismatch'),
        );
      }
    }

    let lock = this.coordinator.terminalClear;
    if (lock !== null) {
      if (lock.fence !== fence || !sameProof(lock.proof, proof)) {
        return Promise.reject(
          new MistralConversationCheckpointStoreError('terminal_clear_in_progress'),
        );
      }
    } else {
      if (this.coordinator.quarantine !== null) {
        return Promise.reject(new MistralConversationCheckpointStoreError('scrub_required'));
      }
      // Révocation synchrone, avant le premier await et avant l'entrée dans la file partagée.
      lock = { fence, proof, proofVerified: false };
      this.coordinator.terminalClear = lock;
    }

    const ownedLock = lock;
    return this.serialized(async () => this.completeTerminalClear(ownedLock));
  }

  retryInterruptedTerminalClear(
    fence: MistralConversationCheckpointOwnerFence,
  ): Promise<void> {
    this.assertFence(fence);
    const lock = this.coordinator.terminalClear;
    if (lock === null || lock.fence !== fence) {
      return Promise.reject(
        new MistralConversationCheckpointStoreError('terminal_clear_in_progress'),
      );
    }
    if (this.coordinator.authBoundaryPurge !== null) {
      return Promise.reject(
        new MistralConversationCheckpointStoreError('auth_boundary_purge_in_progress'),
      );
    }
    // La preuve n'est jamais recreee par le provider : completeTerminalClear reutilise le lock
    // exact conserve avant l'echec natif, puis re-verifie la suppression du slot.
    return this.serialized(async () => this.completeTerminalClear(lock));
  }

  purgeForAuthBoundary(fence: MistralConversationCheckpointOwnerFence): Promise<void> {
    this.assertFence(fence);
    if (this.coordinator.terminalClear !== null) {
      return Promise.reject(
        new MistralConversationCheckpointStoreError('terminal_clear_in_progress'),
      );
    }
    if (this.coordinator.authBoundaryPurgedFence === fence) return Promise.resolve();

    let lock = this.coordinator.authBoundaryPurge;
    if (lock !== null) {
      if (lock.fence !== fence) {
        return Promise.reject(
          new MistralConversationCheckpointStoreError('auth_boundary_purge_in_progress'),
        );
      }
    } else {
      const quarantine = this.coordinator.quarantine;
      if (
        quarantine !== null
        && quarantine.mode !== 'rollback_contamination'
        && quarantine.mode !== 'corruption'
      ) {
        return Promise.reject(new MistralConversationCheckpointStoreError('scrub_required'));
      }
      lock = { fence };
      // Frontière synchrone : aucune nouvelle admission owner/session avant la purge attestée.
      this.coordinator.authBoundaryPurge = lock;
    }

    const ownedLock = lock;
    return this.serialized(async () => {
      if (this.coordinator.authBoundaryPurge !== ownedLock) {
        throw new MistralConversationCheckpointStoreError('auth_boundary_purge_in_progress');
      }
      try {
        await this.deleteAndVerifyMaintenance();
      } catch (error) {
        this.coordinator.quarantine = { mode: 'auth_boundary', lock: ownedLock };
        throw error;
      }
      this.coordinator.quarantine = null;
      this.coordinator.authBoundaryPurge = null;
      this.coordinator.authBoundaryPurgedFence = fence;
      this.coordinator.lastKnownCheckpoint = null;
    });
  }

  scrubRequiredCheckpoint(): Promise<void> {
    const quarantine = this.coordinator.quarantine;
    if (quarantine === null) {
      return Promise.reject(new MistralConversationCheckpointStoreError('scrub_not_required'));
    }
    if (this.coordinator.authBoundaryPurge !== null) {
      return Promise.reject(
        new MistralConversationCheckpointStoreError('auth_boundary_purge_in_progress'),
      );
    }
    if (this.coordinator.terminalClear !== null && quarantine.mode !== 'corruption') {
      return Promise.reject(
        new MistralConversationCheckpointStoreError('terminal_clear_in_progress'),
      );
    }
    if (quarantine.mode === 'terminal_preverification'
      || quarantine.mode === 'terminal_postverification') {
      return Promise.reject(
        new MistralConversationCheckpointStoreError('terminal_clear_in_progress'),
      );
    }
    if (quarantine.mode === 'auth_boundary') {
      return Promise.reject(
        new MistralConversationCheckpointStoreError('auth_boundary_purge_in_progress'),
      );
    }
    return this.serialized(async () => {
      const current = this.coordinator.quarantine;
      if (current === null) return;
      if (current.mode !== 'rollback_contamination' && current.mode !== 'corruption') {
        throw new MistralConversationCheckpointStoreError('scrub_required');
      }
      try {
        await this.deleteAndVerifyMaintenance();
      } catch (error) {
        this.coordinator.quarantine = current;
        throw error;
      }
      this.coordinator.quarantine = null;
      if (current.mode === 'corruption') this.coordinator.terminalClear = null;
      this.coordinator.lastKnownCheckpoint = null;
    });
  }

  private assertFence(fence: MistralConversationCheckpointOwnerFence): void {
    if (fence !== this.coordinator.activeFence) {
      throw new MistralConversationCheckpointStoreError('stale_owner');
    }
  }

  private assertOperational(fence: MistralConversationCheckpointOwnerFence): void {
    this.assertFence(fence);
    if (this.coordinator.authBoundaryPurge !== null) {
      throw new MistralConversationCheckpointStoreError('auth_boundary_purge_in_progress');
    }
    if (this.coordinator.terminalClear !== null) {
      throw new MistralConversationCheckpointStoreError('terminal_clear_in_progress');
    }
    if (this.coordinator.authBoundaryPurgedFence === fence) {
      throw new MistralConversationCheckpointStoreError('auth_boundary_purge_required');
    }
    if (this.coordinator.quarantine !== null) {
      throw new MistralConversationCheckpointStoreError('scrub_required');
    }
  }

  private currentWriteBlock(
    fence: MistralConversationCheckpointOwnerFence,
  ): MistralConversationCheckpointStoreErrorCode | null {
    if (fence !== this.coordinator.activeFence) return 'stale_owner';
    if (this.coordinator.authBoundaryPurge !== null) return 'auth_boundary_purge_in_progress';
    if (this.coordinator.terminalClear !== null) return 'terminal_clear_in_progress';
    if (this.coordinator.authBoundaryPurgedFence === fence) return 'auth_boundary_purge_required';
    if (this.coordinator.quarantine !== null) return 'scrub_required';
    return null;
  }

  private registered(): {
    readonly dependencies: MistralConversationCheckpointStoreDependencies;
    readonly options: SecureStore.SecureStoreOptions;
  } {
    if (this.coordinator.dependencies === null || this.coordinator.options === null) {
      throw new MistralConversationCheckpointStoreError('coordinator_conflict');
    }
    return {
      dependencies: this.coordinator.dependencies,
      options: this.coordinator.options,
    };
  }

  private async requireAvailable(): Promise<void> {
    const { dependencies } = this.registered();
    let available: boolean;
    try {
      available = await dependencies.secureStore.isAvailable();
    } catch {
      throw new MistralConversationCheckpointStoreError('secure_store_unavailable');
    }
    if (!available) {
      throw new MistralConversationCheckpointStoreError('secure_store_unavailable');
    }
  }

  private async readRaw(fence: MistralConversationCheckpointOwnerFence): Promise<string | null> {
    this.assertOperational(fence);
    await this.requireAvailable();
    this.assertOperational(fence);
    const { dependencies, options } = this.registered();
    let raw: string | null;
    try {
      raw = await dependencies.secureStore.getItem(
        MISTRAL_CONVERSATION_CHECKPOINT_SLOT,
        options,
      );
    } catch {
      throw new MistralConversationCheckpointStoreError('secure_store_unavailable');
    }
    this.assertOperational(fence);
    return raw;
  }

  private async readRawMaintenance(): Promise<string | null> {
    await this.requireAvailable();
    const { dependencies, options } = this.registered();
    try {
      return await dependencies.secureStore.getItem(
        MISTRAL_CONVERSATION_CHECKPOINT_SLOT,
        options,
      );
    } catch {
      throw new MistralConversationCheckpointStoreError('secure_store_unavailable');
    }
  }

  private async writeRawVerified(
    fence: MistralConversationCheckpointOwnerFence,
    raw: string,
  ): Promise<void> {
    let blocked = this.currentWriteBlock(fence);
    if (blocked !== null) throw new MistralConversationCheckpointStoreError(blocked);
    await this.requireAvailable();
    blocked = this.currentWriteBlock(fence);
    if (blocked !== null) throw new MistralConversationCheckpointStoreError(blocked);
    const { dependencies, options } = this.registered();
    try {
      await dependencies.secureStore.setItem(
        MISTRAL_CONVERSATION_CHECKPOINT_SLOT,
        raw,
        options,
      );
    } catch {
      blocked = this.currentWriteBlock(fence);
      if (blocked !== null) await this.rejectLateWrite(raw, blocked);
      throw new MistralConversationCheckpointStoreError('secure_store_unavailable');
    }
    blocked = this.currentWriteBlock(fence);
    if (blocked !== null) {
      await this.rejectLateWrite(raw, blocked);
    }
    const readBack = await this.readRawMaintenance();
    blocked = this.currentWriteBlock(fence);
    if (blocked !== null) {
      await this.rejectLateWrite(raw, blocked);
    }
    if (readBack !== raw) {
      throw new MistralConversationCheckpointStoreError('write_verification_failed');
    }
  }

  private async verifiedOperationalDelete(
    fence: MistralConversationCheckpointOwnerFence,
  ): Promise<void> {
    this.assertOperational(fence);
    try {
      await this.deleteAndVerifyMaintenance();
    } catch (error) {
      this.coordinator.quarantine = { mode: 'corruption' };
      throw error;
    }
    this.assertOperational(fence);
  }

  private async deleteAndVerifyMaintenance(): Promise<void> {
    await this.requireAvailable();
    const { dependencies, options } = this.registered();
    try {
      await dependencies.secureStore.deleteItem(
        MISTRAL_CONVERSATION_CHECKPOINT_SLOT,
        options,
      );
    } catch {
      throw new MistralConversationCheckpointStoreError('secure_store_unavailable');
    }
    const readBack = await this.readRawMaintenance();
    if (readBack !== null) {
      throw new MistralConversationCheckpointStoreError('delete_verification_failed');
    }
  }

  private async rejectLateWrite(
    raw: string,
    blocked: MistralConversationCheckpointStoreErrorCode,
  ): Promise<never> {
    const scrubbed = await this.rollbackLateWrite(raw);
    if (!scrubbed) {
      this.coordinator.quarantine = { mode: 'rollback_contamination' };
      throw new MistralConversationCheckpointStoreError('scrub_required');
    }
    throw new MistralConversationCheckpointStoreError(blocked);
  }

  /** Retourne true uniquement après une lecture native attestant le slot nul. */
  private async rollbackLateWrite(raw: string): Promise<boolean> {
    const { dependencies, options } = this.registered();
    try {
      if (!(await dependencies.secureStore.isAvailable())) return false;
      const current = await dependencies.secureStore.getItem(
        MISTRAL_CONVERSATION_CHECKPOINT_SLOT,
        options,
      );
      if (current === null) return true;
      if (current !== raw) return false;
      await dependencies.secureStore.deleteItem(
        MISTRAL_CONVERSATION_CHECKPOINT_SLOT,
        options,
      );
      return (await dependencies.secureStore.getItem(
        MISTRAL_CONVERSATION_CHECKPOINT_SLOT,
        options,
      )) === null;
    } catch {
      return false;
    }
  }

  private async completeTerminalClear(lock: TerminalClearLock): Promise<void> {
    if (this.coordinator.terminalClear !== lock) {
      throw new MistralConversationCheckpointStoreError('terminal_clear_in_progress');
    }
    if (!lock.proofVerified) {
      let raw: string | null;
      try {
        raw = await this.readRawMaintenance();
      } catch (error) {
        this.coordinator.quarantine = { mode: 'terminal_preverification', lock };
        throw error;
      }
      let checkpoint: MistralConversationTerminalCheckpoint | null;
      if (raw === null) {
        checkpoint = this.coordinator.lastKnownCheckpoint;
      } else if (utf8Bytes(raw) > MISTRAL_CONVERSATION_CHECKPOINT_MAX_BYTES) {
        this.coordinator.quarantine = { mode: 'corruption' };
        throw new MistralConversationCheckpointStoreError('checkpoint_too_large');
      } else {
        checkpoint = decodeCheckpoint(raw);
        if (checkpoint === null) {
          this.coordinator.quarantine = { mode: 'corruption' };
          throw new MistralConversationCheckpointStoreError('checkpoint_corrupted');
        }
      }

      if (checkpoint === null || !sameIdentity(checkpoint, lock.fence.identity)) {
        this.coordinator.terminalClear = null;
        this.clearTerminalQuarantine(lock);
        throw new MistralConversationCheckpointStoreError('terminal_proof_mismatch');
      }
      if (checkpoint.projection.phase !== 'closed' || checkpoint.stream.closed !== true) {
        this.coordinator.terminalClear = null;
        this.clearTerminalQuarantine(lock);
        throw new MistralConversationCheckpointStoreError('terminal_not_closed');
      }
      if (!proofMatchesCheckpoint(lock.proof, checkpoint)) {
        this.coordinator.terminalClear = null;
        this.clearTerminalQuarantine(lock);
        throw new MistralConversationCheckpointStoreError('terminal_proof_mismatch');
      }
      lock.proofVerified = true;
      this.coordinator.quarantine = null;
    }

    try {
      await this.deleteAndVerifyMaintenance();
    } catch (error) {
      this.coordinator.quarantine = { mode: 'terminal_postverification', lock };
      throw error;
    }
    this.coordinator.quarantine = null;
    this.coordinator.terminalClear = null;
    this.coordinator.lastKnownCheckpoint = null;
  }

  private clearTerminalQuarantine(lock: TerminalClearLock): void {
    const quarantine = this.coordinator.quarantine;
    if (
      quarantine !== null
      && (quarantine.mode === 'terminal_preverification'
        || quarantine.mode === 'terminal_postverification')
      && quarantine.lock === lock
    ) {
      this.coordinator.quarantine = null;
    }
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.coordinator.operationTail;
    let release: () => void = () => undefined;
    this.coordinator.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const nativeDependencies: MistralConversationCheckpointStoreDependencies = {
  secureStore: {
    isAvailable: () => SecureStore.isAvailableAsync(),
    getItem: (key, options) => SecureStore.getItemAsync(key, options),
    setItem: (key, value, options) => SecureStore.setItemAsync(key, value, options),
    deleteItem: (key, options) => SecureStore.deleteItemAsync(key, options),
  },
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const nativeCoordinator = new MistralConversationCheckpointCoordinator(COORDINATOR_CONSTRUCTION);
let nativeStore: MistralConversationCheckpointStore | null = null;

/** Fabrique injectée explicite : plusieurs façades doivent partager le même coordinateur. */
export function createMistralConversationCheckpointStoreForTesting(
  dependencies: MistralConversationCheckpointStoreDependencies,
  coordinator: MistralConversationCheckpointCoordinator,
): MistralConversationCheckpointStore {
  coordinator.register(dependencies);
  return new SecureMistralConversationCheckpointStore(coordinator);
}

/**
 * Singleton natif du slot : aucun fallback AsyncStorage/mémoire et aucune seconde file d'I/O.
 */
export function createNativeMistralConversationCheckpointStore(): MistralConversationCheckpointStore {
  nativeCoordinator.register(nativeDependencies);
  nativeStore ??= new SecureMistralConversationCheckpointStore(nativeCoordinator);
  return nativeStore;
}

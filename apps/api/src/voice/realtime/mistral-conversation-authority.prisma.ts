import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  MISTRAL_CONVERSATION_MAX_SERVER_EVENT_BYTES,
  decodeMistralConversationServerEvent,
  encodeMistralConversationServerEvent,
  type MistralConversationServerEvent,
  type MistralConversationSessionEndReason,
} from '@bob/ai';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import {
  createMistralConversationDurableSession,
  mistralConversationTransitionRejection,
  parseMistralConversationDurableSnapshot,
  recoverMistralConversationDurableSession,
  reduceMistralConversationDurableSnapshot,
  type MistralConversationBootstrapGrant,
  type MistralConversationDurableAuthority,
  type MistralConversationDurableCommand,
  type MistralConversationDurableOpenResult,
  type MistralConversationDurableSnapshot,
  type MistralConversationDurableTransitionResult,
  type MistralConversationRecoveryCancellation,
} from './mistral-conversation-gateway-v2';
import type {
  MistralConversationCompletionResult,
  MistralConversationCompletionTransactionPort,
} from './mistral-conversation-completion';
import {
  fingerprintMistralConversationCommand,
  openMistralConversationOutboxPayload,
  sealMistralConversationOutboxPayload,
  validateMistralConversationPersistenceKeyRing,
  type MistralConversationPersistenceKeyRing,
} from './mistral-conversation-outbox-seal';
import {
  hashRealtimeLeaseToken,
  isRealtimeCompanyId,
  isRealtimeDatabaseHardExpiryProof,
  isRealtimeSessionId,
  isRealtimeSubjectHash,
} from './realtime-admission';
import { parseMistralConversationProviderCallId } from './mistral-conversation-admission';
import type {
  MistralConversationReaperTerminationAuthority,
  MistralConversationReaperTerminationResult,
} from './mistral-conversation-reaper-termination';
import type { RealtimeProviderTerminationRequest } from './realtime-provider-registry';

const INT32_MAX = 0x7fff_ffff;
const UINT32_MAX_PLUS_ONE = 0x1_0000_0000;
const MAX_SAFE_VERSION = Number.MAX_SAFE_INTEGER;
const MAX_MISSION_AUDIO_BYTES = 28_800_000;
const AUDIO_QUANTUM_BYTES = 320;
const DEFAULT_REPLAY_GRACE_MS = 24 * 60 * 60 * 1_000;
const MAX_REPLAY_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_COMMAND_REPLAY_EVENTS = 4;
const MAX_COMMAND_REPLAY_BYTES = MAX_COMMAND_REPLAY_EVENTS * MISTRAL_CONVERSATION_MAX_SERVER_EVENT_BYTES;
const PROTOCOL = 'bob.mistral-pcm.v2';
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SESSION_HANDLE = /^[A-Za-z0-9_-]{16,128}$/u;
const OWNER_TOKEN = /^[A-Za-z0-9_-]{32,128}$/u;
const COMMAND_ID = /^[A-Za-z0-9:_.-]{1,200}$/u;
const PLANS = new Set(['free', 'solo', 'pro', 'business']);

interface MissionRow {
  readonly id: string;
  readonly companyId: string;
  readonly initialBootstrapId: string;
  readonly admissionSessionId: string | null;
  readonly protocol: string;
  readonly subjectHash: string;
  readonly subjectKeyVersion: number;
  readonly plan: string;
  readonly sessionHandle: string;
  readonly ownerTokenHash: string;
  readonly missionConnectionEpoch: number;
  readonly version: bigint;
  readonly acknowledgedServerSequence: bigint;
  readonly retainedFromServerSequence: bigint;
  readonly nextServerSequence: bigint;
  readonly nextProviderSequence: bigint;
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly routeMode: string;
  readonly fullDuplexCertified: boolean;
  readonly maxMissionAudioBytes: number;
  readonly missionState: unknown;
  readonly turnState: unknown | null;
  readonly finalTranscriptRecorded: boolean;
  readonly phase: string;
  readonly terminalReason: string | null;
  readonly terminalServerSequence: bigint | null;
  readonly hardExpiresAt: Date;
  readonly replayGraceExpiresAt: Date;
  readonly retentionExpiresAt: Date;
}

interface OutboxRow {
  readonly serverSequence: bigint;
  readonly eventType: string;
  readonly payloadCiphertext: Uint8Array;
  readonly payloadNonce: Uint8Array;
  readonly payloadTag: Uint8Array;
  readonly encryptionKeyVersion: number;
  readonly payloadBytes: number;
}

interface OutboxStatsRow {
  readonly eventCount: bigint;
  readonly payloadBytes: bigint;
  readonly minimumSequence: bigint | null;
  readonly maximumSequence: bigint | null;
}

interface CommandRow {
  readonly commandType: string;
  readonly commandPayloadHmac: string;
  readonly proofKeyVersion: number;
  readonly missionConnectionEpoch: number;
  readonly firstServerSequence: bigint;
  readonly eventCount: number;
}

interface ReapingLeaseRow {
  readonly companyId: string;
  readonly subjectHash: string;
  readonly sessionId: string;
  readonly state: string;
  readonly providerId: string | null;
  readonly providerCallId: string | null;
  readonly reaperTokenHash: string | null;
  readonly leaseExpiresAt: Date;
  readonly hardExpiresAt: Date;
  readonly version: number;
}

interface ReplaySlice {
  readonly events: readonly MistralConversationServerEvent[];
  readonly payloadBytes: number;
}

interface AuthorityOptions {
  readonly replayGraceMs?: number;
  readonly missionId?: () => string;
  readonly recoveryCancellationId?: () => string;
}

class CompletionAbort extends Error {
  constructor(readonly result: Exclude<MistralConversationCompletionResult, { readonly status: 'opened' }>) {
    super(result.status);
    this.name = 'CompletionAbort';
  }
}

class TemporalBoundaryAbort extends Error {
  constructor() {
    super('Mistral conversation temporal boundary crossed.');
    this.name = 'TemporalBoundaryAbort';
  }
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && value >= minimum
    && value <= maximum;
}

function canonicalDate(value: string): Date | null {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  const date = new Date(epoch);
  return date.toISOString() === value ? date : null;
}

function validGrant(grant: MistralConversationBootstrapGrant): boolean {
  return UUID.test(grant.bootstrapId)
    && UUID.test(grant.admissionSessionId)
    && COMPANY_ID.test(grant.companyId)
    && SHA256.test(grant.subjectHash)
    && isIntegerBetween(grant.subjectKeyVersion, 1, INT32_MAX)
    && PLANS.has(grant.plan)
    && SESSION_HANDLE.test(grant.sessionHandle)
    && canonicalDate(grant.hardExpiresAt) !== null
    && isIntegerBetween(grant.contextRevision, 1, INT32_MAX)
    && SHA256.test(grant.contextDigest)
    && (grant.routeMode === 'push_to_talk' || grant.routeMode === 'full_duplex')
    && (grant.routeMode !== 'full_duplex' || grant.fullDuplexCertified)
    && isIntegerBetween(grant.maxMissionAudioBytes, AUDIO_QUANTUM_BYTES, MAX_MISSION_AUDIO_BYTES)
    && grant.maxMissionAudioBytes % AUDIO_QUANTUM_BYTES === 0;
}

function validOpenInput(input: Parameters<MistralConversationDurableAuthority['open']>[0]): boolean {
  return validGrant(input.grant)
    && OWNER_TOKEN.test(input.ownerLeaseToken)
    && isIntegerBetween(input.resumeNextServerSequence, 0, UINT32_MAX_PLUS_ONE)
    && isIntegerBetween(input.maxReplayEvents, 1, 10_000)
    && isIntegerBetween(input.maxReplayBytes, 1, 64 * 1024 * 1024);
}

function validTransitionInput(
  input: Parameters<MistralConversationDurableAuthority['transition']>[0],
): boolean {
  return COMPANY_ID.test(input.companyId)
    && SHA256.test(input.subjectHash)
    && SESSION_HANDLE.test(input.sessionHandle)
    && OWNER_TOKEN.test(input.ownerLeaseToken)
    && isIntegerBetween(input.missionConnectionEpoch, 1, INT32_MAX)
    && isIntegerBetween(input.expectedVersion, 1, MAX_SAFE_VERSION)
    && isIntegerBetween(input.maxUnacknowledgedEvents, 1, 10_000)
    && isIntegerBetween(input.maxUnacknowledgedBytes, 1, 64 * 1024 * 1024)
    && COMMAND_ID.test(input.command.commandId);
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function commandIdHash(commandId: string): string {
  return createHash('sha256').update(commandId, 'utf8').digest('hex');
}

function asSafeNumber(value: bigint): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function snapshotFromRow(row: MissionRow): MistralConversationDurableSnapshot {
  const version = asSafeNumber(row.version);
  const acknowledgedServerSequence = asSafeNumber(row.acknowledgedServerSequence);
  const nextServerSequence = asSafeNumber(row.nextServerSequence);
  const nextProviderSequence = asSafeNumber(row.nextProviderSequence);
  if (
    version === null
    || acknowledgedServerSequence === null
    || nextServerSequence === null
    || nextProviderSequence === null
    || typeof row.missionState !== 'object'
    || row.missionState === null
    || Array.isArray(row.missionState)
  ) throw new Error('Invalid durable mission row.');
  const snapshot = parseMistralConversationDurableSnapshot({
    version,
    missionConnectionEpoch: row.missionConnectionEpoch,
    acknowledgedServerSequence,
    nextServerSequence,
    nextProviderSequence,
    mission: row.missionState,
    turn: row.turnState,
    finalTranscriptRecorded: row.finalTranscriptRecorded,
  });
  const terminalSequence = row.terminalServerSequence === null
    ? null
    : asSafeNumber(row.terminalServerSequence);
  if (
    row.protocol !== PROTOCOL
    || snapshot.mission.sessionHandle !== row.sessionHandle
    || snapshot.missionConnectionEpoch !== row.missionConnectionEpoch
    || snapshot.mission.contextRevision !== row.contextRevision
    || snapshot.mission.contextDigest !== row.contextDigest
    || snapshot.mission.routeMode !== row.routeMode
    || snapshot.mission.fullDuplexCertified !== row.fullDuplexCertified
    || snapshot.mission.maxMissionAudioBytes !== row.maxMissionAudioBytes
    || snapshot.mission.expiresAt !== row.hardExpiresAt.toISOString()
    || snapshot.mission.phase !== row.phase
    || snapshot.mission.drainReason !== row.terminalReason
    || (snapshot.mission.phase === 'closed'
      ? terminalSequence !== snapshot.nextServerSequence - 1
      : terminalSequence !== null)
  ) throw new Error('Durable mission scalar drift.');
  return snapshot;
}

function sameGrant(row: MissionRow, grant: MistralConversationBootstrapGrant): boolean {
  return row.initialBootstrapId === grant.bootstrapId
    && row.admissionSessionId === grant.admissionSessionId
    && row.protocol === PROTOCOL
    && row.companyId === grant.companyId
    && row.subjectHash.trim() === grant.subjectHash
    && row.subjectKeyVersion === grant.subjectKeyVersion
    && row.plan === grant.plan
    && row.sessionHandle === grant.sessionHandle
    && row.contextRevision === grant.contextRevision
    && row.contextDigest.trim() === grant.contextDigest
    && row.routeMode === grant.routeMode
    && row.fullDuplexCertified === grant.fullDuplexCertified
    && row.maxMissionAudioBytes === grant.maxMissionAudioBytes
    && row.hardExpiresAt.toISOString() === grant.hardExpiresAt;
}

function replayBytes(events: readonly MistralConversationServerEvent[]): number {
  return events.reduce((total, event) => (
    total + Buffer.byteLength(encodeMistralConversationServerEvent(event), 'utf8')
  ), 0);
}

function terminalMetadata(snapshot: MistralConversationDurableSnapshot, replayGraceExpiresAt: Date): {
  readonly missionConnectionEpoch: number;
  readonly closedAtServerSequence: number;
  readonly reason: MistralConversationSessionEndReason;
  readonly replayGraceExpiresAt: string;
} {
  const reason = snapshot.mission.drainReason;
  if (snapshot.mission.phase !== 'closed' || reason === null) {
    throw new Error('Invalid terminal snapshot.');
  }
  return {
    missionConnectionEpoch: snapshot.missionConnectionEpoch,
    closedAtServerSequence: snapshot.nextServerSequence - 1,
    reason,
    replayGraceExpiresAt: replayGraceExpiresAt.toISOString(),
  };
}

function closeDurably(
  snapshot: MistralConversationDurableSnapshot,
  defaultReason: MistralConversationSessionEndReason,
): {
  readonly snapshot: MistralConversationDurableSnapshot;
  readonly events: readonly MistralConversationServerEvent[];
  readonly steps: readonly {
    readonly snapshot: MistralConversationDurableSnapshot;
    readonly events: readonly MistralConversationServerEvent[];
  }[];
} {
  let working = snapshot;
  const events: MistralConversationServerEvent[] = [];
  const steps: Array<{
    readonly snapshot: MistralConversationDurableSnapshot;
    readonly events: readonly MistralConversationServerEvent[];
  }> = [];
  if (working.mission.phase !== 'draining') {
    const drained = reduceMistralConversationDurableSnapshot(working, {
      type: 'drain',
      commandId: 'drain:terminal-replay',
      reason: defaultReason,
      cancellationId: '50000000-0000-4000-8000-000000000002',
    });
    working = drained.snapshot;
    events.push(...drained.events);
    steps.push(drained);
  }
  const closed = reduceMistralConversationDurableSnapshot(working, {
    type: 'close',
    commandId: 'close:terminal-replay',
  });
  events.push(...closed.events);
  steps.push(closed);
  return { snapshot: closed.snapshot, events, steps };
}

/**
 * Autorité Mistral v2 PostgreSQL. Aucun fallback mémoire : corruption, clé absente ou erreur SQL
 * retourne `unavailable`. Tous les succès passent par une transaction tenant et un verrou mission.
 */
export class PrismaMistralConversationDurableAuthority
implements MistralConversationDurableAuthority, MistralConversationReaperTerminationAuthority {
  private readonly replayGraceMs: number;
  private readonly missionId: () => string;
  private readonly recoveryCancellationId: () => string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly completion: MistralConversationCompletionTransactionPort,
    private readonly keys: MistralConversationPersistenceKeyRing,
    options: AuthorityOptions = {},
  ) {
    validateMistralConversationPersistenceKeyRing(keys);
    this.replayGraceMs = options.replayGraceMs ?? DEFAULT_REPLAY_GRACE_MS;
    if (!isIntegerBetween(this.replayGraceMs, 60_000, MAX_REPLAY_GRACE_MS)) {
      throw new Error('Invalid Mistral conversation replay grace.');
    }
    this.missionId = options.missionId ?? randomUUID;
    this.recoveryCancellationId = options.recoveryCancellationId ?? randomUUID;
  }

  async open(
    input: Parameters<MistralConversationDurableAuthority['open']>[0],
  ): Promise<MistralConversationDurableOpenResult> {
    if (!validOpenInput(input) || input.signal.aborted) return { status: 'unavailable' };
    // Cette autorité doit posséder la transaction racine : sans savepoint Prisma, réutiliser une
    // transaction ambiante permettrait à son appelant d'attraper l'erreur puis de committer un
    // outbox/side-effect écrit avant un CAS temporel perdant.
    if (this.prisma.inTransaction()) return { status: 'unavailable' };
    try {
      return await this.prisma.withTenant(
        input.grant.companyId,
        (tx) => this.openWithinTransaction(tx, input),
      );
    } catch (error) {
      if (error instanceof TemporalBoundaryAbort) return { status: 'expired' };
      return {
        status: await this.classifyTemporalFailure(
          input.grant.companyId,
          input.grant.sessionHandle,
          input.grant.hardExpiresAt,
        ),
      };
    }
  }

  /**
   * Primitive de composition réservée à l'autorité de reprise. L'appelant possède déjà la
   * transaction tenant racine et doit avoir verrouillé son ticket avant d'entrer ici.
   */
  async openWithinTransaction(
    tx: Prisma.TransactionClient,
    input: Parameters<MistralConversationDurableAuthority['open']>[0],
    options: { readonly existingMissionId?: string } = {},
  ): Promise<MistralConversationDurableOpenResult> {
    if (!validOpenInput(input) || input.signal.aborted) return { status: 'unavailable' };
    await this.lockMissionKey(tx, input.grant.companyId, input.grant.sessionHandle);
    const hardExpiresAt = canonicalDate(input.grant.hardExpiresAt);
    if (!hardExpiresAt) return { status: 'unavailable' as const };
    const row = await this.lockMission(tx, input.grant.companyId, input.grant.sessionHandle);
    const databaseNow = await this.databaseNow(tx);
    if (options.existingMissionId !== undefined) {
      if (!UUID.test(options.existingMissionId) || row?.id !== options.existingMissionId) {
        return { status: 'unavailable' as const };
      }
    }
    if (!row) {
      if (input.resumeNextServerSequence !== 0) return { status: 'invalid_cursor' as const };
      if (hardExpiresAt.getTime() <= databaseNow.getTime()) return { status: 'expired' as const };
      const created = createMistralConversationDurableSession({
        grant: input.grant,
        missionConnectionEpoch: 1,
      });
      const replayGraceExpiresAt = new Date(hardExpiresAt.getTime() + this.replayGraceMs);
      const missionId = this.missionId().toLowerCase();
      if (!UUID.test(missionId)) return { status: 'unavailable' as const };
      await this.insertMission(tx, {
        missionId,
        grant: input.grant,
        ownerTokenHash: tokenHash(input.ownerLeaseToken),
        snapshot: created.snapshot,
        replayGraceExpiresAt,
      });
      await this.appendEvents(tx, {
        companyId: input.grant.companyId,
        missionId,
        sessionHandle: input.grant.sessionHandle,
        retentionExpiresAt: replayGraceExpiresAt,
        events: created.events,
      });
      return {
        status: 'opened' as const,
        ...created,
        replayFromServerSequence: 0,
        recovery: null,
        terminal: null,
      };
    }
    if (!sameGrant(row, input.grant)) return { status: 'conflict' as const };
    if (row.replayGraceExpiresAt.getTime() <= databaseNow.getTime()) {
      return { status: 'expired' as const };
    }
    const hardExpired = hardExpiresAt.getTime() <= databaseNow.getTime();
    let current = snapshotFromRow(row);

    // À H, la disposition durable gagne avant toute validation du curseur client. Un curseur
    // faux ou un budget de replay trop petit peut refuser la restitution, jamais empêcher la
    // mission d'être drainée/fermée exactement une fois.
    if (hardExpired && current.mission.phase !== 'closed') {
      const terminalized = closeDurably(current, 'expired');
      let persistenceRow = row;
      for (const step of terminalized.steps) {
        await this.appendEvents(tx, {
          companyId: row.companyId,
          missionId: row.id,
          sessionHandle: row.sessionHandle,
          retentionExpiresAt: row.retentionExpiresAt,
          events: step.events,
        });
        const persisted = await this.updateMission(
          tx,
          persistenceRow,
          step.snapshot,
          row.ownerTokenHash.trim(),
          true,
        );
        if (!persisted) throw new TemporalBoundaryAbort();
        persistenceRow = {
          ...persistenceRow,
          version: BigInt(step.snapshot.version),
        };
      }
      current = terminalized.snapshot;
    }

    if (input.resumeNextServerSequence > current.nextServerSequence) {
      return { status: 'invalid_cursor' as const };
    }
    const retainedFrom = asSafeNumber(row.retainedFromServerSequence);
    if (retainedFrom === null) return { status: 'unavailable' as const };
    const replayFrom = Math.min(
      input.resumeNextServerSequence,
      current.acknowledgedServerSequence,
    );
    if (replayFrom < retainedFrom) return { status: 'history_unavailable' as const };
    const prefix = await this.readReplay(tx, row, replayFrom, current.nextServerSequence, {
      maxEvents: input.maxReplayEvents,
      maxBytes: input.maxReplayBytes,
    });
    if (!prefix) return { status: 'history_unavailable' as const };

    if (current.mission.phase === 'closed') {
      return {
        status: 'terminal_replay' as const,
        snapshot: current,
        events: prefix.events,
        replayFromServerSequence: replayFrom,
        recovery: null,
        terminal: terminalMetadata(current, row.replayGraceExpiresAt),
      };
    }
    // Le transport exige encore la paire route_recovering/route_recovered. Ne jamais committer
    // un suffixe partiel : le takeover d'une recovery déjà durable reste fail-closed.
    if (current.mission.phase === 'recovering_route') {
      return { status: 'unavailable' as const };
    }
    const previousEpoch = current.missionConnectionEpoch;
    const previousCancellationGeneration = current.mission.cancellationGeneration;
    let next: {
      readonly snapshot: MistralConversationDurableSnapshot;
      readonly events: readonly MistralConversationServerEvent[];
      readonly steps: readonly {
        readonly snapshot: MistralConversationDurableSnapshot;
        readonly events: readonly MistralConversationServerEvent[];
      }[];
    };
    let recoveryCancellation: MistralConversationRecoveryCancellation | null = null;
    let recovered = false;

    if (current.mission.phase === 'draining') {
      next = closeDurably(current, 'fatal_error');
    } else {
      let candidate: ReturnType<typeof recoverMistralConversationDurableSession> | null = null;
      if (current.missionConnectionEpoch < INT32_MAX) {
        const cancellationId = this.recoveryCancellationId().toLowerCase();
        if (!UUID.test(cancellationId)) return { status: 'unavailable' as const };
        try {
          candidate = recoverMistralConversationDurableSession(current, {
            newMissionConnectionEpoch: current.missionConnectionEpoch + 1,
            cancellationId,
            routeMode: input.grant.routeMode,
            fullDuplexCertified: input.grant.fullDuplexCertified,
          });
        } catch {
          candidate = null;
        }
      }
      const backlog = await this.outboxStats(
        tx,
        row,
        current.acknowledgedServerSequence,
        current.nextServerSequence,
      );
      if (!backlog) return { status: 'history_unavailable' as const };
      const candidateBytes = candidate ? replayBytes(candidate.events) : 0;
      if (
        candidate === null
        || backlog.eventCount + candidate.events.length > input.maxReplayEvents - 3
        || backlog.payloadBytes + candidateBytes > input.maxReplayBytes
          - 3 * MISTRAL_CONVERSATION_MAX_SERVER_EVENT_BYTES
      ) {
        next = closeDurably(current, 'fatal_error');
      } else {
        next = { ...candidate, steps: [candidate] };
        recoveryCancellation = candidate.recoveryCancellation;
        recovered = true;
      }
    }

    const totalEvents = [...prefix.events, ...next.events];
    if (
      totalEvents.length > input.maxReplayEvents
      || prefix.payloadBytes + replayBytes(next.events) > input.maxReplayBytes
    ) return { status: 'history_unavailable' as const };

    const nextOwnerHash = recovered ? tokenHash(input.ownerLeaseToken) : row.ownerTokenHash.trim();
    let persistenceRow = row;
    for (const step of next.steps) {
      await this.appendEvents(tx, {
        companyId: row.companyId,
        missionId: row.id,
        sessionHandle: row.sessionHandle,
        retentionExpiresAt: row.retentionExpiresAt,
        events: step.events,
      });
      const persisted = await this.updateMission(
        tx,
        persistenceRow,
        step.snapshot,
        nextOwnerHash,
        false,
      );
      if (!persisted) throw new TemporalBoundaryAbort();
      persistenceRow = {
        ...persistenceRow,
        ownerTokenHash: nextOwnerHash,
        missionConnectionEpoch: step.snapshot.missionConnectionEpoch,
        version: BigInt(step.snapshot.version),
      };
    }

    if (next.snapshot.mission.phase === 'closed') {
      return {
        status: 'terminal_replay' as const,
        snapshot: next.snapshot,
        events: totalEvents,
        replayFromServerSequence: replayFrom,
        recovery: null,
        terminal: terminalMetadata(next.snapshot, row.replayGraceExpiresAt),
      };
    }
    return {
      status: 'recovered' as const,
      snapshot: next.snapshot,
      events: totalEvents,
      replayFromServerSequence: replayFrom,
      recovery: {
        fromServerSequence: current.nextServerSequence,
        previousMissionConnectionEpoch: previousEpoch,
        previousCancellationGeneration,
        cancellation: recoveryCancellation,
      },
      terminal: null,
    };
  }

  async transition(
    input: Parameters<MistralConversationDurableAuthority['transition']>[0],
  ): Promise<MistralConversationDurableTransitionResult> {
    if (!validTransitionInput(input) || input.signal.aborted) return { status: 'unavailable' };
    if (this.prisma.inTransaction()) return { status: 'unavailable' };
    try {
      return await this.prisma.withTenant(input.companyId, async (tx) => {
        await this.lockMissionKey(tx, input.companyId, input.sessionHandle);
        const row = await this.lockMission(tx, input.companyId, input.sessionHandle);
        if (!row) return { status: 'not_found' as const };
        const current = snapshotFromRow(row);
        const ownerHash = tokenHash(input.ownerLeaseToken);
        if (
          row.subjectHash.trim() !== input.subjectHash
          || row.ownerTokenHash.trim() !== ownerHash
          || row.missionConnectionEpoch !== input.missionConnectionEpoch
        ) return { status: 'not_owner' as const };

        const admissionFence = await this.inspectBootstrapAdmission(tx, row);
        const databaseNow = admissionFence.databaseNow;
        if (row.replayGraceExpiresAt.getTime() <= databaseNow.getTime()) {
          return { status: 'expired' as const };
        }
        const hardExpired = row.hardExpiresAt.getTime() <= databaseNow.getTime();
        const terminalGraceCommand = input.command.type === 'ack_events'
          || input.command.type === 'close'
          || (input.command.type === 'drain' && input.command.reason === 'expired');
        if (hardExpired && !terminalGraceCommand) return { status: 'expired' as const };
        // Après H, le bail d'admission n'est plus actif par définition. La classification
        // temporelle doit donc gagner sur `not_owner`, tandis que seules les commandes
        // strictement terminales restent admises durant la grâce de replay. Avant H, le fence
        // d'admission reste obligatoire et aucune mutation live ne peut survivre à sa perte.
        if (!hardExpired && !admissionFence.active) {
          return { status: 'not_owner' as const };
        }

        // Pendant la grâce terminale, l'idempotence d'un ACK est portée par le curseur monotone
        // lui-même. Ne pas la déléguer au ledger : celui-ci ne possède pas le delta précédent et
        // ne pourrait pas prouver qu'une ligne ACK correspond bien à la version qui l'a avancé.
        if (
          hardExpired
          && input.command.type === 'ack_events'
          && input.command.control.missionConnectionEpoch === current.missionConnectionEpoch
          && input.command.control.nextServerSequence <= current.acknowledgedServerSequence
        ) {
          return { status: 'replayed' as const, snapshot: current, events: [] };
        }

        const ledger = await this.readCommand(tx, row, input.command.commandId);
        if (ledger) {
          if (ledger.missionConnectionEpoch !== input.missionConnectionEpoch) {
            return { status: 'rejected' as const, reason: 'invalid_state' as const };
          }
          const proof = fingerprintMistralConversationCommand(
            input.command,
            {
              companyId: input.companyId,
              sessionHandle: input.sessionHandle,
              missionConnectionEpoch: ledger.missionConnectionEpoch,
            },
            this.keys,
            ledger.proofKeyVersion,
          );
          if (
            ledger.commandType !== input.command.type
            || ledger.commandPayloadHmac.trim() !== proof.payloadHmac
          ) return { status: 'rejected' as const, reason: 'invalid_state' as const };
          const start = asSafeNumber(ledger.firstServerSequence);
          if (start === null) return { status: 'unavailable' as const };
          const replay = await this.readReplay(tx, row, start, start + ledger.eventCount, {
            maxEvents: MAX_COMMAND_REPLAY_EVENTS,
            maxBytes: MAX_COMMAND_REPLAY_BYTES,
          });
          if (!replay) return { status: 'unavailable' as const };
          return { status: 'replayed' as const, snapshot: current, events: replay.events };
        }
        if (input.expectedVersion !== current.version) {
          return { status: 'conflict' as const, snapshot: current };
        }

        let reduced: ReturnType<typeof reduceMistralConversationDurableSnapshot>;
        try {
          reduced = reduceMistralConversationDurableSnapshot(current, input.command);
        } catch (error) {
          return {
            status: 'rejected' as const,
            reason: mistralConversationTransitionRejection(error),
          };
        }

        if (
          input.command.type !== 'ack_events'
          && input.command.type !== 'drain'
          && input.command.type !== 'close'
        ) {
          const backlog = await this.outboxStats(
            tx,
            row,
            reduced.snapshot.acknowledgedServerSequence,
            current.nextServerSequence,
          );
          if (!backlog) return { status: 'unavailable' as const };
          if (
            backlog.eventCount + reduced.events.length > input.maxUnacknowledgedEvents
            || backlog.payloadBytes + replayBytes(reduced.events) > input.maxUnacknowledgedBytes
          ) return { status: 'rejected' as const, reason: 'replay_window_exhausted' as const };
        }

        if (input.command.type === 'complete_turn') {
          const turn = current.turn;
          if (!turn) return { status: 'rejected' as const, reason: 'invalid_state' as const };
          const completion = await this.completion.authorizeAndOpen(tx, {
            companyId: input.companyId,
            subjectHash: input.subjectHash,
            subjectKeyVersion: row.subjectKeyVersion,
            sessionHandle: input.sessionHandle,
            turnId: input.command.turnId,
            missionConnectionEpoch: input.missionConnectionEpoch,
            cancellationGeneration: input.command.cancellationGeneration,
            contextRevision: current.mission.contextRevision,
            contextDigest: row.contextDigest.trim(),
            authorizationHandle: input.command.authorizationHandle,
            stagedDeliveryHandle: input.command.stagedDeliveryHandle,
            signal: input.signal,
          });
          if (completion.status !== 'opened') throw new CompletionAbort(completion);
        }

        await this.appendEvents(tx, {
          companyId: row.companyId,
          missionId: row.id,
          sessionHandle: row.sessionHandle,
          retentionExpiresAt: row.retentionExpiresAt,
          events: reduced.events,
        });
        if (!await this.updateMission(
          tx,
          row,
          reduced.snapshot,
          row.ownerTokenHash.trim(),
          hardExpired,
        )) {
          throw new TemporalBoundaryAbort();
        }
        if (!(hardExpired && input.command.type === 'ack_events')) {
          await this.insertCommand(
            tx,
            row,
            current,
            reduced.snapshot,
            input.command,
            reduced.events.length,
          );
        }
        return { status: 'applied' as const, ...reduced };
      });
    } catch (error) {
      if (error instanceof TemporalBoundaryAbort) return { status: 'expired' };
      if (error instanceof CompletionAbort) {
        if (error.result.status === 'context_stale') {
          return { status: 'rejected', reason: 'context_stale' };
        }
        if (error.result.status === 'not_found') {
          return { status: 'rejected', reason: 'invalid_state' };
        }
      }
      return {
        status: await this.classifyTemporalFailure(
          input.companyId,
          input.sessionHandle,
          null,
        ),
      };
    }
  }

  async terminateReaping(
    request: RealtimeProviderTerminationRequest,
  ): Promise<MistralConversationReaperTerminationResult> {
    const bootstrapId = parseMistralConversationProviderCallId(request.providerCallId);
    const reaperLeaseExpiresAt = canonicalDate(request.reaperLeaseExpiresAt);
    if (
      bootstrapId === null
      || request.providerId !== 'mistral'
      || !isRealtimeCompanyId(request.companyId)
      || !isRealtimeSubjectHash(request.subjectHash)
      || !isRealtimeSessionId(request.sessionId)
      || request.sessionId !== request.sessionId.toLowerCase()
      || !/^[A-Za-z0-9_-]{32,128}$/u.test(request.reaperToken)
      || reaperLeaseExpiresAt === null
    ) return { status: 'invalid' };
    if (this.prisma.inTransaction()) return { status: 'unavailable' };
    try {
      return await this.prisma.withTenant(request.companyId, async (tx) => {
        // Ordre commun v2 : advisory Mission -> Mission -> admission.
        await this.lockMissionKey(tx, request.companyId, request.sessionId);
        const row = await this.lockMission(tx, request.companyId, request.sessionId);
        if (
          !row
          || row.initialBootstrapId !== bootstrapId
          || row.admissionSessionId !== request.sessionId
          || row.subjectHash.trim() !== request.subjectHash
        ) return { status: 'invalid' as const };
        const [lease] = await tx.$queryRaw<ReapingLeaseRow[]>`
          SELECT "companyId", "subjectHash", "sessionId", state, "providerId", "providerCallId",
                 "reaperTokenHash", "leaseExpiresAt", "hardExpiresAt", version
            FROM realtime_session_leases
           WHERE "companyId" = ${request.companyId}
             AND "subjectHash" = ${request.subjectHash}
             AND "sessionId" = ${request.sessionId}::uuid
           FOR UPDATE
        `;
        const databaseNow = await this.databaseNow(tx);
        if (
          !lease
          || lease.companyId !== request.companyId
          || lease.subjectHash.trim() !== request.subjectHash
          || lease.sessionId !== request.sessionId
          || lease.state !== 'reaping'
          || lease.providerId !== 'mistral'
          || lease.providerCallId !== request.providerCallId
          || lease.reaperTokenHash?.trim() !== hashRealtimeLeaseToken(request.reaperToken)
          || lease.leaseExpiresAt.toISOString() !== request.reaperLeaseExpiresAt
          || lease.leaseExpiresAt.getTime() <= databaseNow.getTime()
          || lease.hardExpiresAt.getTime() !== row.hardExpiresAt.getTime()
          || row.replayGraceExpiresAt.getTime() <= databaseNow.getTime()
        ) return { status: 'stale_fence' as const };
        if (request.hardExpiryProof !== null) {
          const proof = request.hardExpiryProof;
          if (
            !isRealtimeDatabaseHardExpiryProof(proof)
            || proof.companyId !== request.companyId
            || proof.subjectHash !== request.subjectHash
            || proof.sessionId !== request.sessionId
            || proof.providerId !== 'mistral'
            || proof.providerCallId !== request.providerCallId
            || proof.hardExpiresAt !== lease.hardExpiresAt.toISOString()
            || proof.leaseVersion !== lease.version
            || Date.parse(proof.databaseObservedAt) < lease.hardExpiresAt.getTime()
          ) return { status: 'invalid' as const };
        }

        const current = snapshotFromRow(row);
        if (current.mission.phase === 'closed') return { status: 'replayed' as const };
        const reason: MistralConversationSessionEndReason = request.terminationCause === 'explicit_hangup'
          ? 'user'
          : request.hardExpiryProof !== null
            ? 'expired'
            : 'fatal_error';
        const terminalized = closeDurably(current, reason);
        let persistenceRow = row;
        for (const step of terminalized.steps) {
          await this.appendEvents(tx, {
            companyId: row.companyId,
            missionId: row.id,
            sessionHandle: row.sessionHandle,
            retentionExpiresAt: row.retentionExpiresAt,
            events: step.events,
          });
          if (!await this.updateMissionUnderReaperFence(
            tx,
            persistenceRow,
            step.snapshot,
            lease,
            request,
          )) throw new Error('Mistral conversation reaper fence lost.');
          persistenceRow = {
            ...persistenceRow,
            version: BigInt(step.snapshot.version),
          };
        }
        return { status: 'terminated' as const };
      });
    } catch {
      return { status: 'unavailable' };
    }
  }

  /**
   * Reclasse une erreur SQL qui a franchi H après le premier clock check. La lecture se fait dans
   * une nouvelle transaction racine, donc après rollback certain des événements/side-effects de
   * la tentative. Avant H — ou si la preuve durable est indisponible — l'échec reste opaque.
   */
  private async classifyTemporalFailure(
    companyId: string,
    sessionHandle: string,
    fallbackHardExpiresAt: string | null,
  ): Promise<'expired' | 'unavailable'> {
    if (this.prisma.inTransaction()) return 'unavailable';
    try {
      return await this.prisma.withTenant(companyId, async (tx) => {
        const [evidence] = await tx.$queryRaw<Array<{
          readonly databaseNow: Date;
          readonly hardExpiresAt: Date | null;
        }>>`
          SELECT clock_timestamp() AS "databaseNow",
                 (
                   SELECT mission."hardExpiresAt"
                     FROM realtime_mistral_conversation_missions AS mission
                    WHERE mission."companyId" = ${companyId}
                      AND mission."sessionHandle" = ${sessionHandle}
                    LIMIT 1
                 ) AS "hardExpiresAt"
        `;
        if (!(evidence?.databaseNow instanceof Date)) return 'unavailable' as const;
        const fallback = fallbackHardExpiresAt === null
          ? null
          : canonicalDate(fallbackHardExpiresAt);
        const hardExpiresAt = evidence.hardExpiresAt ?? fallback;
        return hardExpiresAt && hardExpiresAt.getTime() <= evidence.databaseNow.getTime()
          ? 'expired' as const
          : 'unavailable' as const;
      });
    } catch {
      return 'unavailable';
    }
  }

  private async databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
    const [row] = await tx.$queryRaw<Array<{ databaseNow: Date }>>`
      SELECT clock_timestamp() AS "databaseNow"
    `;
    if (!(row?.databaseNow instanceof Date) || Number.isNaN(row.databaseNow.getTime())) {
      throw new Error('Database clock unavailable.');
    }
    return row.databaseNow;
  }

  private async lockMissionKey(
    tx: Prisma.TransactionClient,
    companyId: string,
    sessionHandle: string,
  ): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${`${companyId}:${sessionHandle}`}, 0))
    `;
  }

  private async lockMission(
    tx: Prisma.TransactionClient,
    companyId: string,
    sessionHandle: string,
  ): Promise<MissionRow | null> {
    const [row] = await tx.$queryRaw<MissionRow[]>`
      SELECT id, "companyId", "initialBootstrapId", "admissionSessionId", protocol, "subjectHash",
             "subjectKeyVersion", plan, "sessionHandle", "ownerTokenHash",
             "missionConnectionEpoch", version, "acknowledgedServerSequence",
             "retainedFromServerSequence", "nextServerSequence", "nextProviderSequence",
             "contextRevision", "contextDigest", "routeMode", "fullDuplexCertified",
             "maxMissionAudioBytes", "missionState", "turnState", "finalTranscriptRecorded",
             phase, "terminalReason", "terminalServerSequence", "hardExpiresAt",
             "replayGraceExpiresAt", "retentionExpiresAt"
        FROM realtime_mistral_conversation_missions
       WHERE "companyId" = ${companyId}
         AND "sessionHandle" = ${sessionHandle}
       FOR UPDATE
    `;
    return row ?? null;
  }

  private async inspectBootstrapAdmission(
    tx: Prisma.TransactionClient,
    row: MissionRow,
  ): Promise<{ readonly active: boolean; readonly databaseNow: Date }> {
    const [bootstrap] = await tx.$queryRaw<Array<{ state: string }>>`
      SELECT state
        FROM realtime_mistral_conversation_bootstrap_tickets
       WHERE "companyId" = ${row.companyId}
         AND id = ${row.initialBootstrapId}::uuid
       LIMIT 1
    `;
    // Missions v2 antérieures au bootstrap atomique : replay terminal uniquement. Leur reprise
    // live reste désactivée ailleurs ; ne pas rendre leur clôture historique impossible.
    if (!bootstrap) {
      return { active: true, databaseNow: await this.databaseNow(tx) };
    }
    if (bootstrap.state !== 'consumed' || row.admissionSessionId === null) {
      return { active: false, databaseNow: await this.databaseNow(tx) };
    }
    const [admission] = await tx.$queryRaw<Array<{
      readonly state: string;
      readonly providerId: string | null;
      readonly providerCallId: string | null;
      readonly leaseExpiresAt: Date;
      readonly hardExpiresAt: Date;
    }>>`
      SELECT state, "providerId", "providerCallId", "leaseExpiresAt", "hardExpiresAt"
        FROM realtime_session_leases
       WHERE "companyId" = ${row.companyId}
         AND "subjectHash" = ${row.subjectHash.trim()}
         AND "sessionId" = ${row.admissionSessionId}::uuid
       FOR UPDATE
    `;
    // L'horloge autoritative est lue après le verrou d'admission. Un reaper ne peut donc pas
    // déplacer le bail vers `reaping` entre la preuve temporelle et la décision de mutation.
    const databaseNow = await this.databaseNow(tx);
    return {
      active: Boolean(
        admission
        && admission.state === 'active'
        && admission.providerId === 'mistral'
        && admission.providerCallId === `mcv2:${row.initialBootstrapId}`
        && admission.leaseExpiresAt.getTime() > databaseNow.getTime()
        && admission.hardExpiresAt.getTime() > databaseNow.getTime()
        && admission.hardExpiresAt.getTime() === row.hardExpiresAt.getTime(),
      ),
      databaseNow,
    };
  }

  private async insertMission(
    tx: Prisma.TransactionClient,
    input: {
      readonly missionId: string;
      readonly grant: MistralConversationBootstrapGrant;
      readonly ownerTokenHash: string;
      readonly snapshot: MistralConversationDurableSnapshot;
      readonly replayGraceExpiresAt: Date;
    },
  ): Promise<void> {
    const missionJson = JSON.stringify(input.snapshot.mission);
    await tx.$executeRaw`
      INSERT INTO realtime_mistral_conversation_missions (
        id, "companyId", "initialBootstrapId", "admissionSessionId", protocol,
        "subjectHash", "subjectKeyVersion",
        plan, "sessionHandle", "ownerTokenHash", "missionConnectionEpoch", version,
        "acknowledgedServerSequence", "retainedFromServerSequence", "nextServerSequence",
        "nextProviderSequence", "contextRevision", "contextDigest", "routeMode",
        "fullDuplexCertified", "maxMissionAudioBytes", "missionState", "turnState",
        "audioBytes", "finalTranscriptRecorded", phase, "terminalReason", "terminalServerSequence",
        "ownerAcquiredAt", "closedAt",
        "hardExpiresAt", "replayGraceExpiresAt", "retentionExpiresAt", "createdAt", "updatedAt"
      ) VALUES (
        ${input.missionId}::uuid, ${input.grant.companyId}, ${input.grant.bootstrapId}::uuid,
        ${input.grant.admissionSessionId}::uuid, ${PROTOCOL},
        ${input.grant.subjectHash}, ${input.grant.subjectKeyVersion},
        ${input.grant.plan}, ${input.grant.sessionHandle}, ${input.ownerTokenHash},
        ${input.snapshot.missionConnectionEpoch}, ${BigInt(input.snapshot.version)},
        ${BigInt(input.snapshot.acknowledgedServerSequence)}, 0,
        ${BigInt(input.snapshot.nextServerSequence)}, ${BigInt(input.snapshot.nextProviderSequence)},
        ${input.snapshot.mission.contextRevision}, ${input.snapshot.mission.contextDigest},
        ${input.snapshot.mission.routeMode}, ${input.snapshot.mission.fullDuplexCertified},
        ${input.snapshot.mission.maxMissionAudioBytes}, ${missionJson}::jsonb, NULL,
        ${input.snapshot.mission.audioBytes}, ${input.snapshot.finalTranscriptRecorded},
        ${input.snapshot.mission.phase}, NULL, NULL, statement_timestamp(), NULL,
        ${input.grant.hardExpiresAt}::timestamptz, ${input.replayGraceExpiresAt},
        ${input.replayGraceExpiresAt}, statement_timestamp(), statement_timestamp()
      )
    `;
  }

  private async updateMission(
    tx: Prisma.TransactionClient,
    row: MissionRow,
    snapshot: MistralConversationDurableSnapshot,
    ownerTokenHash: string,
    allowDuringReplayGrace: boolean,
  ): Promise<boolean> {
    const missionJson = JSON.stringify(snapshot.mission);
    const turnJson = snapshot.turn === null ? null : JSON.stringify(snapshot.turn);
    const terminalServerSequence = snapshot.mission.phase === 'closed'
      ? BigInt(snapshot.nextServerSequence - 1)
      : null;
    const updated = await tx.$executeRaw`
      UPDATE realtime_mistral_conversation_missions
         SET "ownerTokenHash" = ${ownerTokenHash},
             "ownerAcquiredAt" = CASE
               WHEN "ownerTokenHash" IS DISTINCT FROM ${ownerTokenHash}
                 THEN GREATEST(clock_timestamp(), "ownerAcquiredAt" + interval '1 microsecond')
               ELSE "ownerAcquiredAt"
             END,
             "missionConnectionEpoch" = ${snapshot.missionConnectionEpoch},
             version = ${BigInt(snapshot.version)},
             "acknowledgedServerSequence" = ${BigInt(snapshot.acknowledgedServerSequence)},
             "nextServerSequence" = ${BigInt(snapshot.nextServerSequence)},
             "nextProviderSequence" = ${BigInt(snapshot.nextProviderSequence)},
             "contextRevision" = ${snapshot.mission.contextRevision},
             "contextDigest" = ${snapshot.mission.contextDigest},
             "routeMode" = ${snapshot.mission.routeMode},
             "fullDuplexCertified" = ${snapshot.mission.fullDuplexCertified},
             "audioBytes" = ${snapshot.mission.audioBytes},
             "missionState" = ${missionJson}::jsonb,
             "turnState" = ${turnJson}::jsonb,
             "finalTranscriptRecorded" = ${snapshot.finalTranscriptRecorded},
             phase = ${snapshot.mission.phase},
             "terminalReason" = ${snapshot.mission.drainReason},
             "terminalServerSequence" = ${terminalServerSequence},
             "closedAt" = CASE
               WHEN ${snapshot.mission.phase} = 'closed' THEN COALESCE("closedAt", clock_timestamp())
               ELSE NULL
             END,
             "updatedAt" = clock_timestamp()
       WHERE id = ${row.id}::uuid
         AND "companyId" = ${row.companyId}
         AND "sessionHandle" = ${row.sessionHandle}
         AND version = ${row.version}
         AND "missionConnectionEpoch" = ${row.missionConnectionEpoch}
         AND "ownerTokenHash" = ${row.ownerTokenHash.trim()}
         AND (
           (${allowDuringReplayGrace} AND "replayGraceExpiresAt" > clock_timestamp())
           OR (NOT ${allowDuringReplayGrace} AND "hardExpiresAt" > clock_timestamp())
         )
    `;
    return updated === 1;
  }

  private async updateMissionUnderReaperFence(
    tx: Prisma.TransactionClient,
    row: MissionRow,
    snapshot: MistralConversationDurableSnapshot,
    lease: ReapingLeaseRow,
    request: RealtimeProviderTerminationRequest,
  ): Promise<boolean> {
    const missionJson = JSON.stringify(snapshot.mission);
    const turnJson = snapshot.turn === null ? null : JSON.stringify(snapshot.turn);
    const terminalServerSequence = snapshot.mission.phase === 'closed'
      ? BigInt(snapshot.nextServerSequence - 1)
      : null;
    const updated = await tx.$executeRaw`
      UPDATE realtime_mistral_conversation_missions AS mission
         SET version = ${BigInt(snapshot.version)},
             "acknowledgedServerSequence" = ${BigInt(snapshot.acknowledgedServerSequence)},
             "nextServerSequence" = ${BigInt(snapshot.nextServerSequence)},
             "nextProviderSequence" = ${BigInt(snapshot.nextProviderSequence)},
             "contextRevision" = ${snapshot.mission.contextRevision},
             "contextDigest" = ${snapshot.mission.contextDigest},
             "routeMode" = ${snapshot.mission.routeMode},
             "fullDuplexCertified" = ${snapshot.mission.fullDuplexCertified},
             "audioBytes" = ${snapshot.mission.audioBytes},
             "missionState" = ${missionJson}::jsonb,
             "turnState" = ${turnJson}::jsonb,
             "finalTranscriptRecorded" = ${snapshot.finalTranscriptRecorded},
             phase = ${snapshot.mission.phase},
             "terminalReason" = ${snapshot.mission.drainReason},
             "terminalServerSequence" = ${terminalServerSequence},
             "closedAt" = CASE
               WHEN ${snapshot.mission.phase} = 'closed'
                 THEN COALESCE(mission."closedAt", clock_timestamp())
               ELSE NULL
             END,
             "updatedAt" = clock_timestamp()
       WHERE mission.id = ${row.id}::uuid
         AND mission."companyId" = ${row.companyId}
         AND mission."sessionHandle" = ${row.sessionHandle}
         AND mission.version = ${row.version}
         AND mission."missionConnectionEpoch" = ${row.missionConnectionEpoch}
         AND mission."ownerTokenHash" = ${row.ownerTokenHash.trim()}
         AND mission."replayGraceExpiresAt" > clock_timestamp()
         AND EXISTS (
           SELECT 1
             FROM realtime_session_leases AS admission
            WHERE admission."companyId" = ${request.companyId}
              AND admission."subjectHash" = ${request.subjectHash}
              AND admission."sessionId" = ${request.sessionId}::uuid
              AND admission.state = 'reaping'
              AND admission."providerId" = 'mistral'
              AND admission."providerCallId" = ${request.providerCallId}
              AND admission."reaperTokenHash" = ${hashRealtimeLeaseToken(request.reaperToken)}
              -- Le token hash + la version constituent le fence exact. Ne jamais réinjecter ici
              -- le timestamptz lu en JS : PostgreSQL conserve les microsecondes, JS Date seulement
              -- les millisecondes, ce qui ferait perdre un CAS pourtant légitime.
              AND admission."leaseExpiresAt" > clock_timestamp()
              AND admission.version = ${lease.version}
         )
    `;
    return updated === 1;
  }

  private async appendEvents(
    tx: Prisma.TransactionClient,
    input: {
      readonly companyId: string;
      readonly missionId: string;
      readonly sessionHandle: string;
      readonly retentionExpiresAt: Date;
      readonly events: readonly MistralConversationServerEvent[];
    },
  ): Promise<void> {
    for (const event of input.events) {
      const encoded = encodeMistralConversationServerEvent(event);
      const payloadBytes = Buffer.byteLength(encoded, 'utf8');
      const sealed = sealMistralConversationOutboxPayload(encoded, {
        companyId: input.companyId,
        sessionHandle: input.sessionHandle,
        serverSequence: event.serverSequence,
        eventType: event.type,
        payloadBytes,
      }, this.keys);
      await tx.$executeRaw`
        INSERT INTO realtime_mistral_conversation_outbox (
          "companyId", "missionId", "sessionHandle", "serverSequence", "eventType",
          "payloadCiphertext", "payloadNonce", "payloadTag", "encryptionKeyVersion",
          "payloadBytes", "createdAt", "retentionExpiresAt"
        ) VALUES (
          ${input.companyId}, ${input.missionId}::uuid, ${input.sessionHandle},
          ${BigInt(event.serverSequence)}, ${event.type}, ${Buffer.from(sealed.ciphertext)},
          ${Buffer.from(sealed.nonce)}, ${Buffer.from(sealed.tag)}, ${sealed.keyVersion},
          ${payloadBytes}, clock_timestamp(), ${input.retentionExpiresAt}
        )
      `;
    }
  }

  private async outboxStats(
    tx: Prisma.TransactionClient,
    row: MissionRow,
    from: number,
    to: number,
  ): Promise<{ readonly eventCount: number; readonly payloadBytes: number } | null> {
    if (from > to) return null;
    const [stats] = await tx.$queryRaw<OutboxStatsRow[]>`
      SELECT count(*)::bigint AS "eventCount",
             COALESCE(sum("payloadBytes"), 0)::bigint AS "payloadBytes",
             min("serverSequence") AS "minimumSequence",
             max("serverSequence") AS "maximumSequence"
        FROM realtime_mistral_conversation_outbox
       WHERE "companyId" = ${row.companyId}
         AND "missionId" = ${row.id}::uuid
         AND "sessionHandle" = ${row.sessionHandle}
         AND "serverSequence" >= ${BigInt(from)}
         AND "serverSequence" < ${BigInt(to)}
    `;
    if (!stats) return null;
    const eventCount = asSafeNumber(stats.eventCount);
    const payloadBytes = asSafeNumber(stats.payloadBytes);
    const minimum = stats.minimumSequence === null ? null : asSafeNumber(stats.minimumSequence);
    const maximum = stats.maximumSequence === null ? null : asSafeNumber(stats.maximumSequence);
    const expected = to - from;
    if (
      eventCount === null
      || payloadBytes === null
      || eventCount !== expected
      || (
        expected === 0
          ? minimum !== null || maximum !== null
          : minimum !== from || maximum !== to - 1
      )
    ) return null;
    return { eventCount, payloadBytes };
  }

  private async readReplay(
    tx: Prisma.TransactionClient,
    row: MissionRow,
    from: number,
    to: number,
    limits: { readonly maxEvents: number; readonly maxBytes: number },
  ): Promise<ReplaySlice | null> {
    const expected = to - from;
    if (expected < 0 || expected > limits.maxEvents) return null;
    const stats = await this.outboxStats(tx, row, from, to);
    if (!stats || stats.payloadBytes > limits.maxBytes) return null;
    const rows = await tx.$queryRaw<OutboxRow[]>`
      SELECT "serverSequence", "eventType", "payloadCiphertext", "payloadNonce", "payloadTag",
             "encryptionKeyVersion", "payloadBytes"
        FROM realtime_mistral_conversation_outbox
       WHERE "companyId" = ${row.companyId}
         AND "missionId" = ${row.id}::uuid
         AND "sessionHandle" = ${row.sessionHandle}
         AND "serverSequence" >= ${BigInt(from)}
         AND "serverSequence" < ${BigInt(to)}
       ORDER BY "serverSequence" ASC
       LIMIT ${limits.maxEvents + 1}
    `;
    if (rows.length !== expected) return null;
    const events: MistralConversationServerEvent[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const stored = rows[index];
      if (!stored) return null;
      const serverSequence = asSafeNumber(stored.serverSequence);
      if (serverSequence !== from + index) return null;
      const encoded = openMistralConversationOutboxPayload({
        ciphertext: Uint8Array.from(stored.payloadCiphertext),
        nonce: Uint8Array.from(stored.payloadNonce),
        tag: Uint8Array.from(stored.payloadTag),
        keyVersion: stored.encryptionKeyVersion,
      }, {
        companyId: row.companyId,
        sessionHandle: row.sessionHandle,
        serverSequence,
        eventType: stored.eventType,
        payloadBytes: stored.payloadBytes,
      }, this.keys);
      if (encoded === null || Buffer.byteLength(encoded, 'utf8') !== stored.payloadBytes) return null;
      const event = decodeMistralConversationServerEvent(encoded);
      if (event.serverSequence !== serverSequence || event.type !== stored.eventType) return null;
      events.push(event);
    }
    return { events, payloadBytes: stats.payloadBytes };
  }

  private async readCommand(
    tx: Prisma.TransactionClient,
    row: MissionRow,
    commandId: string,
  ): Promise<CommandRow | null> {
    const [command] = await tx.$queryRaw<CommandRow[]>`
      SELECT "commandType", "commandPayloadHmac", "proofKeyVersion", "missionConnectionEpoch",
             "firstServerSequence", "eventCount"
        FROM realtime_mistral_conversation_commands
       WHERE "companyId" = ${row.companyId}
         AND "missionId" = ${row.id}::uuid
         AND "sessionHandle" = ${row.sessionHandle}
         AND "commandIdHash" = ${commandIdHash(commandId)}
       LIMIT 1
    `;
    return command ?? null;
  }

  private async insertCommand(
    tx: Prisma.TransactionClient,
    row: MissionRow,
    before: MistralConversationDurableSnapshot,
    after: MistralConversationDurableSnapshot,
    command: MistralConversationDurableCommand,
    eventCount: number,
  ): Promise<void> {
    const proof = fingerprintMistralConversationCommand(
      command,
      {
        companyId: row.companyId,
        sessionHandle: row.sessionHandle,
        missionConnectionEpoch: before.missionConnectionEpoch,
      },
      this.keys,
    );
    await tx.$executeRaw`
      INSERT INTO realtime_mistral_conversation_commands (
        "companyId", "missionId", "sessionHandle", "commandIdHash", "commandType",
        "commandPayloadHmac", "proofKeyVersion", "missionConnectionEpoch", "snapshotVersionBefore",
        "snapshotVersionAfter", "firstServerSequence", "eventCount", "createdAt",
        "retentionExpiresAt"
      ) VALUES (
        ${row.companyId}, ${row.id}::uuid, ${row.sessionHandle}, ${proof.commandIdHash},
        ${command.type}, ${proof.payloadHmac}, ${proof.proofKeyVersion},
        ${before.missionConnectionEpoch}, ${BigInt(before.version)}, ${BigInt(after.version)},
        ${BigInt(before.nextServerSequence)}, ${eventCount}, clock_timestamp(),
        ${row.retentionExpiresAt}
      )
    `;
  }
}

import { EventEmitter } from 'node:events';
import {
  MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
  MISTRAL_CONVERSATION_MAX_PRE_ROLL_MS,
  MISTRAL_CONVERSATION_MAX_SERVER_EVENT_BYTES,
  MISTRAL_CONVERSATION_MAX_TURN_AUDIO_MS,
  MISTRAL_CONVERSATION_PROTOCOL,
  decodeMistralConversationServerEvent,
  encodeMistralConversationAudioFrame,
  encodeMistralConversationClientControl,
  encodeMistralConversationServerEvent,
  type MistralConversationClientControl,
  type MistralConversationServerEvent,
} from '@bob/ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMistralConversationDurableSession,
  mistralConversationTransitionRejection,
  parseMistralConversationDurableSnapshot,
  recoverMistralConversationDurableSession,
  reduceMistralConversationDurableSnapshot,
  serveMistralConversationGatewayV2,
  type MistralConversationBobAuditPipeline,
  type MistralConversationBootstrapAuthority,
  type MistralConversationBootstrapGrant,
  type MistralConversationDurableAuthority,
  type MistralConversationDurableCommand,
  type MistralConversationDurableOpenResult,
  type MistralConversationDurableSnapshot,
  type MistralConversationGatewayV2Dependencies,
  type MistralConversationGatewayV2Entropy,
  type MistralConversationGatewayV2Socket,
  type MistralConversationProvider,
  type MistralConversationProviderConnection,
  type MistralConversationProviderEvent,
} from './mistral-conversation-gateway-v2';

const NOW = 1_000_000;
const TICKET = 'A'.repeat(43);
const DIGEST_1 = 'a'.repeat(64);
const DIGEST_2 = 'b'.repeat(64);
const DIGEST_3 = 'c'.repeat(64);
const CLIENT_1 = '10000000-0000-4000-8000-000000000001';
const CLIENT_2 = '10000000-0000-4000-8000-000000000002';
const CLIENT_3 = '10000000-0000-4000-8000-000000000003';
const CANCEL_1 = '20000000-0000-4000-8000-000000000001';
const CANCEL_2 = '20000000-0000-4000-8000-000000000002';
const INT32_MAX = 0x7fff_ffff;
const UINT32_MAX = 0xffff_ffff;

const BASE_GRANT: MistralConversationBootstrapGrant = {
  bootstrapId: '30000000-0000-4000-8000-000000000001',
  companyId: 'company-1',
  subjectHash: 'd'.repeat(64),
  subjectKeyVersion: 2,
  plan: 'pro',
  sessionHandle: 'session_handle_1234567890abcdef',
  hardExpiresAt: new Date(NOW + 60_000).toISOString(),
  contextRevision: 1,
  contextDigest: DIGEST_1,
  routeMode: 'push_to_talk',
  fullDuplexCertified: false,
  maxMissionAudioBytes: 320_000,
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition_not_reached');
}

class FakeSocket extends EventEmitter implements MistralConversationGatewayV2Socket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ readonly code: number; readonly reason: string }> = [];
  terminated = false;
  hangSends = false;
  onServerEvent: ((event: MistralConversationServerEvent) => void) | null = null;

  constructor(private readonly log: string[]) {
    super();
  }

  send(data: string, callback?: (error?: Error) => void): void {
    if (this.hangSends) return;
    this.sent.push(data);
    try {
      const event = decodeMistralConversationServerEvent(data);
      this.log.push(`wire:${event.type}`);
      this.onServerEvent?.(event);
    } catch {
      this.log.push('wire:invalid');
    }
    callback?.();
  }

  close(code = 1000, reason = ''): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
    this.emit('close', code);
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit('close', 1006);
  }

  clientControl(control: MistralConversationClientControl): void {
    this.emit('message', encodeMistralConversationClientControl(control), false);
  }

  clientRaw(raw: string): void {
    this.emit('message', raw, false);
  }

  clientTextBytes(control: MistralConversationClientControl): void {
    this.emit('message', Buffer.from(encodeMistralConversationClientControl(control), 'utf8'), false);
  }

  clientRawTextBytes(raw: Uint8Array): void {
    this.emit('message', raw, false);
  }

  clientBinary(raw: Uint8Array): void {
    this.emit('message', raw, true);
  }

  events(): MistralConversationServerEvent[] {
    return this.sent.map((raw) => decodeMistralConversationServerEvent(raw));
  }
}

function fingerprint(command: MistralConversationDurableCommand): string {
  return JSON.stringify(command);
}

class FakeDurableAuthority implements MistralConversationDurableAuthority {
  snapshot: MistralConversationDurableSnapshot | null = null;
  ownerLeaseToken = '';
  readonly outbox: MistralConversationServerEvent[] = [];
  retainedFromServerSequence = 0;
  readonly openInputs: Array<Parameters<MistralConversationDurableAuthority['open']>[0]> = [];
  readonly attempts: MistralConversationDurableCommand[] = [];
  readonly applied: Array<{
    readonly command: MistralConversationDurableCommand;
    readonly events: readonly MistralConversationServerEvent[];
  }> = [];
  private readonly ledger = new Map<string, {
    readonly fingerprint: string;
    readonly events: readonly MistralConversationServerEvent[];
  }>();
  private readonly transitionGates = new Map<MistralConversationDurableCommand['type'], Deferred<void>>();
  loseOwnershipAt: MistralConversationDurableCommand['type'] | null = null;
  private staleOwner = false;

  constructor(
    private readonly grant: MistralConversationBootstrapGrant,
    private readonly log: string[],
  ) {}

  async open(
    input: Parameters<MistralConversationDurableAuthority['open']>[0],
  ): ReturnType<MistralConversationDurableAuthority['open']> {
    this.openInputs.push(input);
    if (!this.snapshot) {
      if (input.resumeNextServerSequence !== 0) return { status: 'invalid_cursor' };
      const created = createMistralConversationDurableSession({ grant: this.grant, missionConnectionEpoch: 1 });
      this.ownerLeaseToken = input.ownerLeaseToken;
      this.snapshot = created.snapshot;
      this.outbox.push(...created.events);
      this.log.push('durable:open');
      return {
        status: 'opened',
        ...created,
        replayFromServerSequence: 0,
        recovery: null,
        terminal: null,
      };
    }
    const current = this.snapshot;
    const suffixFromServerSequence = current.nextServerSequence;
    if (input.resumeNextServerSequence > suffixFromServerSequence) {
      return { status: 'invalid_cursor' };
    }
    const replayFromServerSequence = Math.min(
      input.resumeNextServerSequence,
      current.acknowledgedServerSequence,
    );
    if (replayFromServerSequence < this.retainedFromServerSequence) {
      return { status: 'history_unavailable' };
    }
    const history = this.outbox.slice(replayFromServerSequence, suffixFromServerSequence);
    if (
      history.length !== suffixFromServerSequence - replayFromServerSequence
      || history.some((event, index) => (
        event.serverSequence !== replayFromServerSequence + index
      ))
    ) return { status: 'history_unavailable' };

    let nextSnapshot: MistralConversationDurableSnapshot;
    let suffix: readonly MistralConversationServerEvent[];
    let recovery: null | {
      readonly fromServerSequence: number;
      readonly previousMissionConnectionEpoch: number;
      readonly previousCancellationGeneration: number;
      readonly cancellation: ReturnType<typeof recoverMistralConversationDurableSession>['recoveryCancellation'];
    } = null;
    let terminal: null | {
      readonly missionConnectionEpoch: number;
      readonly closedAtServerSequence: number;
      readonly reason: NonNullable<MistralConversationDurableSnapshot['mission']['drainReason']>;
      readonly replayGraceExpiresAt: string;
    } = null;

    const closeDurably = (snapshot: MistralConversationDurableSnapshot): {
      readonly snapshot: MistralConversationDurableSnapshot;
      readonly events: readonly MistralConversationServerEvent[];
    } => {
      let working = snapshot;
      const events: MistralConversationServerEvent[] = [];
      if (working.mission.phase !== 'draining') {
        const drained = reduceMistralConversationDurableSnapshot(working, {
          type: 'drain',
          commandId: 'drain:terminal-replay',
          reason: 'fatal_error',
          cancellationId: '50000000-0000-4000-8000-000000000002',
        });
        working = drained.snapshot;
        events.push(...drained.events);
      }
      const closed = reduceMistralConversationDurableSnapshot(working, {
        type: 'close',
        commandId: 'close:terminal-replay',
      });
      events.push(...closed.events);
      return { snapshot: closed.snapshot, events };
    };

    if (current.mission.phase === 'closed') {
      nextSnapshot = current;
      suffix = [];
    } else if (current.mission.phase === 'draining') {
      const closed = closeDurably(current);
      nextSnapshot = closed.snapshot;
      suffix = closed.events;
    } else {
      if (current.mission.phase === 'recovering_route') return { status: 'unavailable' };
      const canIncrementEpoch = current.missionConnectionEpoch < INT32_MAX;
      let recovered: ReturnType<typeof recoverMistralConversationDurableSession> | null = null;
      if (canIncrementEpoch) {
        recovered = recoverMistralConversationDurableSession(current, {
          newMissionConnectionEpoch: current.missionConnectionEpoch + 1,
          cancellationId: '50000000-0000-4000-8000-000000000001',
          routeMode: this.grant.routeMode,
          fullDuplexCertified: this.grant.fullDuplexCertified,
        });
      }
      const durableBacklog = this.outbox.slice(
        current.acknowledgedServerSequence,
        current.nextServerSequence,
      );
      const liveCandidate = recovered ? [...durableBacklog, ...recovered.events] : [];
      const liveCandidateBytes = liveCandidate.reduce((total, event) => (
        total + Buffer.byteLength(encodeMistralConversationServerEvent(event), 'utf8')
      ), 0);
      if (
        !recovered
        || liveCandidate.length > input.maxReplayEvents - 3
        || liveCandidateBytes > input.maxReplayBytes
          - 3 * MISTRAL_CONVERSATION_MAX_SERVER_EVENT_BYTES
      ) {
        const closed = closeDurably(current);
        nextSnapshot = closed.snapshot;
        suffix = closed.events;
      } else {
        nextSnapshot = recovered.snapshot;
        suffix = recovered.events;
        recovery = {
          fromServerSequence: suffixFromServerSequence,
          previousMissionConnectionEpoch: current.missionConnectionEpoch,
          previousCancellationGeneration: current.mission.cancellationGeneration,
          cancellation: recovered.recoveryCancellation,
        };
      }
    }

    const events = [...history, ...suffix];
    const replayBytes = events.reduce((total, event) => (
      total + Buffer.byteLength(encodeMistralConversationServerEvent(event), 'utf8')
    ), 0);
    if (events.length > input.maxReplayEvents || replayBytes > input.maxReplayBytes) {
      return { status: 'history_unavailable' };
    }
    if (suffix.length > 0) {
      this.ownerLeaseToken = input.ownerLeaseToken;
      this.snapshot = nextSnapshot;
      this.outbox.push(...suffix);
    }
    if (nextSnapshot.mission.phase === 'closed') {
      const reason = nextSnapshot.mission.drainReason;
      if (!reason) throw new Error('invalid_terminal_fixture');
      terminal = {
        missionConnectionEpoch: nextSnapshot.missionConnectionEpoch,
        closedAtServerSequence: nextSnapshot.nextServerSequence - 1,
        reason,
        replayGraceExpiresAt: new Date(Date.parse(this.grant.hardExpiresAt) + 60_000).toISOString(),
      };
      this.log.push('durable:terminal_replay');
      return {
        status: 'terminal_replay',
        snapshot: nextSnapshot,
        events,
        replayFromServerSequence,
        recovery: null,
        terminal,
      };
    }
    this.log.push('durable:recover');
    if (!recovery) throw new Error('invalid_recovery_fixture');
    return {
      status: 'recovered',
      snapshot: nextSnapshot,
      events,
      replayFromServerSequence,
      recovery,
      terminal: null,
    };
  }

  async transition(
    input: Parameters<MistralConversationDurableAuthority['transition']>[0],
  ): ReturnType<MistralConversationDurableAuthority['transition']> {
    const current = this.snapshot;
    if (!current) return { status: 'not_found' };
    this.attempts.push(input.command);
    const gate = this.transitionGates.get(input.command.type);
    if (gate) await gate.promise;
    if (this.staleOwner || input.command.type === this.loseOwnershipAt) {
      this.staleOwner = true;
      return { status: 'not_owner' };
    }
    if (
      input.companyId !== this.grant.companyId
      || input.subjectHash !== this.grant.subjectHash
      || input.sessionHandle !== this.grant.sessionHandle
      || input.ownerLeaseToken !== this.ownerLeaseToken
      || input.missionConnectionEpoch !== current.missionConnectionEpoch
    ) return { status: 'not_owner' };

    const replay = this.ledger.get(input.command.commandId);
    if (replay) {
      if (replay.fingerprint !== fingerprint(input.command)) {
        return { status: 'rejected', reason: 'invalid_state' };
      }
      this.log.push(`durable:replay:${input.command.type}`);
      // Une opération dont le deadline local a expiré peut tout de même avoir été commitée.
      // L'adapter durable renvoie alors le snapshot autoritatif courant, pas la vue capturée
      // avant la barrière de test, afin que la reprise idempotente puisse réconcilier le CAS.
      return { status: 'replayed', snapshot: this.snapshot ?? current, events: replay.events };
    }
    if (input.expectedVersion !== current.version) return { status: 'conflict', snapshot: current };

    try {
      const reduced = reduceMistralConversationDurableSnapshot(current, input.command);
      if (
        input.command.type !== 'ack_events'
        && input.command.type !== 'drain'
        && input.command.type !== 'close'
      ) {
        const unacknowledged = [
          ...this.outbox.slice(
            reduced.snapshot.acknowledgedServerSequence,
            current.nextServerSequence,
          ),
          ...reduced.events,
        ];
        const unacknowledgedBytes = unacknowledged.reduce((total, event) => (
          total + Buffer.byteLength(encodeMistralConversationServerEvent(event), 'utf8')
        ), 0);
        if (
          unacknowledged.length > input.maxUnacknowledgedEvents
          || unacknowledgedBytes > input.maxUnacknowledgedBytes
        ) return { status: 'rejected', reason: 'replay_window_exhausted' };
      }
      this.snapshot = reduced.snapshot;
      this.outbox.push(...reduced.events);
      this.ledger.set(input.command.commandId, {
        fingerprint: fingerprint(input.command),
        events: reduced.events,
      });
      this.applied.push({ command: input.command, events: reduced.events });
      this.log.push(`durable:${input.command.type}`);
      if ('turnId' in input.command) {
        this.log.push(`durable-turn:${input.command.type}:${input.command.turnId}`);
      }
      return { status: 'applied', ...reduced };
    } catch (error) {
      return { status: 'rejected', reason: mistralConversationTransitionRejection(error) };
    }
  }

  hold(type: MistralConversationDurableCommand['type']): Deferred<void> {
    const gate = deferred<void>();
    this.transitionGates.set(type, gate);
    return gate;
  }
}

class ProviderEventQueue {
  private readonly values: MistralConversationProviderEvent[] = [];
  private readonly waiters: Array<(event: MistralConversationProviderEvent) => void> = [];

  push(event: MistralConversationProviderEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.values.push(event);
  }

  async next(): Promise<MistralConversationProviderEvent> {
    const event = this.values.shift();
    if (event) return event;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

type ProviderMode = 'final' | 'error' | 'manual' | 'blocked_audio';

class ControlledProviderConnection implements MistralConversationProviderConnection {
  readonly audio: Uint8Array[] = [];
  readonly queue = new ProviderEventQueue();
  readonly close = vi.fn(async (_input: { readonly signal: AbortSignal }) => undefined);
  readonly commitAudio = vi.fn(async (_input: { readonly signal: AbortSignal }) => {
    if (this.mode === 'final') {
      this.queue.push({ type: 'transcript_final', providerSequence: 0, text: this.transcript });
    } else if (this.mode === 'error') {
      this.queue.push({ type: 'provider_error', providerSequence: 0 });
    }
  });

  constructor(
    readonly mode: ProviderMode,
    readonly transcript: string,
    readonly signal: AbortSignal,
  ) {}

  async sendAudio(
    pcm: Uint8Array,
    _input: { readonly signal: AbortSignal },
  ): Promise<void> {
    this.audio.push(Uint8Array.from(pcm));
    if (this.mode === 'blocked_audio') await new Promise<void>(() => undefined);
  }

  async *events(): AsyncIterable<MistralConversationProviderEvent> {
    while (true) yield await this.queue.next();
  }

  emitFinal(text = this.transcript, providerSequence = 0): void {
    this.queue.push({ type: 'transcript_final', providerSequence, text });
  }

  emitError(providerSequence = 0): void {
    this.queue.push({ type: 'provider_error', providerSequence });
  }
}

class ControlledProvider implements MistralConversationProvider {
  readonly modes: ProviderMode[] = [];
  readonly connections: ControlledProviderConnection[] = [];
  readonly openTurn = vi.fn(async (
    input: Parameters<MistralConversationProvider['openTurn']>[0],
  ): Promise<MistralConversationProviderConnection> => {
    const ordinal = this.connections.length + 1;
    const connection = new ControlledProviderConnection(
      this.modes.shift() ?? 'final',
      `transcription ${ordinal}`,
      input.signal,
    );
    this.connections.push(connection);
    this.log.push(`provider:open:${input.turnId}`);
    return connection;
  });

  constructor(private readonly log: string[]) {}
}

class ControlledPipeline implements MistralConversationBobAuditPipeline {
  reasonGate: Deferred<{ readonly handle: string }> | null = null;
  deliveryGate: Deferred<{ readonly handle: string }> | null = null;
  readonly reason = vi.fn(async (
    input: Parameters<MistralConversationBobAuditPipeline['reason']>[0],
  ) => {
    this.log.push(`pipeline:reason:${input.turnId}`);
    if (this.reasonGate) return this.reasonGate.promise;
    return { handle: `reasoning_handle_${input.turnId}` };
  });
  readonly auditAndRender = vi.fn(async (
    input: Parameters<MistralConversationBobAuditPipeline['auditAndRender']>[0],
  ) => {
    this.log.push(`pipeline:audit:${input.turnId}`);
    return { handle: `audited_handle_${input.turnId}` };
  });
  readonly stageDelivery = vi.fn(async (
    input: Parameters<MistralConversationBobAuditPipeline['stageDelivery']>[0],
  ) => {
    this.log.push(`pipeline:deliver:${input.turnId}`);
    if (this.deliveryGate) return this.deliveryGate.promise;
    return { handle: `delivery_handle_${input.turnId}` };
  });

  constructor(private readonly log: string[]) {}
}

class DeterministicEntropy implements MistralConversationGatewayV2Entropy {
  private leaseOrdinal = 0;

  ownerLeaseToken(): string {
    this.leaseOrdinal += 1;
    return String.fromCharCode('K'.charCodeAt(0) + this.leaseOrdinal).repeat(43);
  }
}

interface Harness {
  readonly grant: MistralConversationBootstrapGrant;
  readonly log: string[];
  readonly socket: FakeSocket;
  readonly authority: FakeDurableAuthority;
  readonly provider: ControlledProvider;
  readonly pipeline: ControlledPipeline;
  readonly consume: ReturnType<typeof vi.fn>;
  readonly contextAuthorize: ReturnType<typeof vi.fn>;
  readonly dependencies: MistralConversationGatewayV2Dependencies;
}

function harness(input: {
  readonly grant?: Partial<MistralConversationBootstrapGrant>;
  readonly authTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly pipelineTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly providerResponseTimeoutMs?: number;
} = {}): Harness {
  const grant = { ...BASE_GRANT, ...input.grant };
  const log: string[] = [];
  const socket = new FakeSocket(log);
  const authority = new FakeDurableAuthority(grant, log);
  const provider = new ControlledProvider(log);
  const pipeline = new ControlledPipeline(log);
  const consume = vi.fn(async () => {
    log.push('bootstrap:consume');
    return { status: 'consumed' as const, grant };
  });
  const bootstrap: MistralConversationBootstrapAuthority = { consume };
  const context = {
    authorize: vi.fn(async () => ({
      status: 'authorized' as const,
      authorizationHandle: 'authorization_handle_1234567890',
      plan: 'pro' as const,
    })),
  };
  return {
    grant,
    log,
    socket,
    authority,
    provider,
    pipeline,
    consume,
    contextAuthorize: context.authorize,
    dependencies: {
      bootstrap,
      authority,
      context,
      provider,
      pipeline,
      entropy: new DeterministicEntropy(),
      now: () => NOW,
      authTimeoutMs: input.authTimeoutMs ?? 1_000,
      providerCloseTimeoutMs: 25,
      ...(input.operationTimeoutMs === undefined ? {} : { operationTimeoutMs: input.operationTimeoutMs }),
      ...(input.pipelineTimeoutMs === undefined ? {} : { pipelineTimeoutMs: input.pipelineTimeoutMs }),
      ...(input.cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: input.cleanupTimeoutMs }),
      ...(input.providerResponseTimeoutMs === undefined
        ? {}
        : { providerResponseTimeoutMs: input.providerResponseTimeoutMs }),
    },
  };
}

function authenticate(socket: FakeSocket, resumeNextServerSequence = 0): void {
  socket.clientControl({
    type: 'authenticate',
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    companyId: BASE_GRANT.companyId,
    ticket: TICKET,
    resumeNextServerSequence,
  });
}

async function connect(h: Harness, resumeNextServerSequence = 0): Promise<{ readonly run: Promise<void> }> {
  const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
  authenticate(h.socket, resumeNextServerSequence);
  await waitFor(() => h.socket.events().some((event) => (
    event.type === 'session.ready' || event.type === 'session.route_recovered'
  )));
  return { run };
}

function startControl(
  clientTurnId: string,
  vadStartedAtMs: number,
  contextRevision = 1,
  contextDigest = DIGEST_1,
): Extract<MistralConversationClientControl, { readonly type: 'turn.start' }> {
  return {
    type: 'turn.start',
    clientTurnId,
    contextRevision,
    contextDigest,
    vadStartedAtMs,
    preRollMs: 160,
  };
}

function commitControl(
  clientTurnId: string,
  lastAudioSequence: number,
  vadEndedAtMs: number,
): Extract<MistralConversationClientControl, { readonly type: 'turn.commit' }> {
  return { type: 'turn.commit', clientTurnId, lastAudioSequence, vadEndedAtMs };
}

function audioFrame(ordinal: number, audioSequence: number): Uint8Array {
  return encodeMistralConversationAudioFrame({
    turnOrdinal: ordinal,
    audioSequence,
    pcm: new Uint8Array(MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES).fill(audioSequence + 1),
  });
}

async function startTurn(
  h: Harness,
  input: {
    readonly clientTurnId: string;
    readonly ordinal: number;
    readonly firstAudioSequence: number;
    readonly vadStartedAtMs: number;
    readonly contextRevision?: number;
    readonly contextDigest?: string;
  },
): Promise<void> {
  h.socket.clientControl(startControl(
    input.clientTurnId,
    input.vadStartedAtMs,
    input.contextRevision,
    input.contextDigest,
  ));
  await waitFor(() => h.socket.events().some((event) => (
    event.type === 'turn.started'
    && event.clientTurnId === input.clientTurnId
    && event.ordinal === input.ordinal
    && event.firstAudioSequence === input.firstAudioSequence
  )));
}

async function completeTurn(
  h: Harness,
  input: {
    readonly clientTurnId: string;
    readonly ordinal: number;
    readonly audioSequence: number;
    readonly vadStartedAtMs: number;
    readonly contextRevision?: number;
    readonly contextDigest?: string;
  },
): Promise<void> {
  await startTurn(h, {
    ...input,
    firstAudioSequence: input.audioSequence,
  });
  h.socket.clientBinary(audioFrame(input.ordinal, input.audioSequence));
  h.socket.clientControl(commitControl(
    input.clientTurnId,
    input.audioSequence,
    input.vadStartedAtMs + 320,
  ));
  await waitFor(() => h.socket.events().some((event) => (
    event.type === 'turn.completed' && event.clientTurnId === input.clientTurnId
  )));
}

async function endSession(h: Harness, run: Promise<void>): Promise<void> {
  h.socket.clientControl({ type: 'session.end', reason: 'user' });
  await run;
}

async function acknowledgeEvents(
  socket: FakeSocket,
  authority: FakeDurableAuthority,
  missionConnectionEpoch: number,
  nextServerSequence: number,
): Promise<void> {
  socket.clientControl({
    type: 'events.ack',
    missionConnectionEpoch,
    nextServerSequence,
  });
  await waitFor(() => authority.snapshot?.acknowledgedServerSequence === nextServerSequence);
}

function terminalReplayFixture(
  h: Harness,
  reason: 'user' | 'background' = 'user',
  replayGraceExpiresAt = new Date(Date.parse(h.grant.hardExpiresAt) + 60_000).toISOString(),
): Extract<MistralConversationDurableOpenResult, { readonly status: 'terminal_replay' }> {
  const created = createMistralConversationDurableSession({ grant: h.grant, missionConnectionEpoch: 1 });
  const drained = reduceMistralConversationDurableSnapshot(created.snapshot, {
    type: 'drain',
    commandId: `drain:terminal-validator:${reason}`,
    reason,
    cancellationId: CANCEL_1,
  });
  const closed = reduceMistralConversationDurableSnapshot(drained.snapshot, {
    type: 'close',
    commandId: `close:terminal-validator:${reason}`,
  });
  return {
    status: 'terminal_replay',
    snapshot: closed.snapshot,
    replayFromServerSequence: 0,
    recovery: null,
    terminal: {
      missionConnectionEpoch: closed.snapshot.missionConnectionEpoch,
      closedAtServerSequence: closed.snapshot.nextServerSequence - 1,
      reason,
      replayGraceExpiresAt,
    },
    events: [...created.events, ...drained.events, ...closed.events],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Bob Mistral conversation gateway v2 — mission WSS durable', () => {
  it('refuse fail-closed un snapshot durable JSONB incomplet ou incohérent', () => {
    expect(() => parseMistralConversationDurableSnapshot(null)).toThrow(/temporarily_unavailable/u);
    expect(() => parseMistralConversationDurableSnapshot({ mission: {}, turn: null }))
      .toThrow(/temporarily_unavailable/u);
    const created = createMistralConversationDurableSession({
      grant: BASE_GRANT,
      missionConnectionEpoch: 1,
    });
    expect(parseMistralConversationDurableSnapshot(created.snapshot)).toEqual(created.snapshot);
    expect(() => parseMistralConversationDurableSnapshot({
      ...created.snapshot,
      version: 0,
    })).toThrow(/temporarily_unavailable/u);
  });

  it('enchaîne trois tours sur la même socket et persiste avant provider et downlink', async () => {
    const h = harness();
    const { run } = await connect(h);

    await completeTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      audioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    await completeTurn(h, {
      clientTurnId: CLIENT_2,
      ordinal: 2,
      audioSequence: 1,
      vadStartedAtMs: 2_000,
    });
    await completeTurn(h, {
      clientTurnId: CLIENT_3,
      ordinal: 3,
      audioSequence: 2,
      vadStartedAtMs: 3_000,
    });

    expect(h.socket.closes).toEqual([]);
    expect(h.consume).toHaveBeenCalledTimes(1);
    expect(h.authority.openInputs).toHaveLength(1);
    expect(h.provider.openTurn).toHaveBeenCalledTimes(3);
    for (const [providerInput] of h.provider.openTurn.mock.calls) {
      expect(providerInput.maxAudioMs).toBe(
        MISTRAL_CONVERSATION_MAX_TURN_AUDIO_MS + MISTRAL_CONVERSATION_MAX_PRE_ROLL_MS,
      );
    }
    expect(h.pipeline.stageDelivery).toHaveBeenCalledTimes(3);
    for (const completion of h.authority.applied.filter((entry) => entry.command.type === 'complete_turn')) {
      expect(completion.command).toMatchObject({
        authorizationHandle: 'authorization_handle_1234567890',
        stagedDeliveryHandle: expect.stringMatching(/^delivery_handle_/u),
      });
    }
    expect(h.socket.events().filter((event) => event.type === 'turn.completed')).toHaveLength(3);
    const sequences = h.socket.events().map((event) => event.serverSequence);
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, index) => index));

    for (const turn of h.authority.applied.filter((entry) => entry.command.type === 'start_turn')) {
      const started = turn.events.find((event) => event.type === 'turn.started');
      expect(started).toBeDefined();
      const turnId = started && 'turnId' in started ? started.turnId : '';
      const durableIndex = h.log.indexOf(`durable-turn:start_turn:${turnId}`);
      const providerIndex = h.log.indexOf(`provider:open:${started && 'turnId' in started ? started.turnId : ''}`);
      const wireIndex = h.log.indexOf('wire:turn.started', providerIndex);
      expect(durableIndex).toBeLessThan(providerIndex);
      expect(durableIndex).toBeLessThan(wireIndex);
    }

    await endSession(h, run);
    expect(h.socket.closes).toEqual([{ code: 1000, reason: 'session_closed' }]);
  });

  it('ACK le contexte seulement après autorité et refuse une mutation pendant un tour', async () => {
    const h = harness();
    h.provider.modes.push('manual');
    const { run } = await connect(h);

    h.socket.clientControl({ type: 'context.update', contextRevision: 2, contextDigest: DIGEST_2 });
    await waitFor(() => h.socket.events().some((event) => (
      event.type === 'session.context_updated' && event.contextRevision === 2
    )));
    const durableIndex = h.log.indexOf('durable:update_context');
    const wireIndex = h.log.indexOf('wire:session.context_updated');
    expect(durableIndex).toBeGreaterThanOrEqual(0);
    expect(durableIndex).toBeLessThan(wireIndex);

    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
      contextRevision: 2,
      contextDigest: DIGEST_2,
    });
    h.socket.clientControl({ type: 'context.update', contextRevision: 3, contextDigest: DIGEST_3 });
    await waitFor(() => h.socket.events().some((event) => (
      event.type === 'error' && event.code === 'context_stale'
    )));
    expect(h.socket.events().some((event) => (
      event.type === 'session.context_updated' && event.contextRevision === 3
    ))).toBe(false);

    h.socket.clientControl({
      type: 'turn.cancel',
      clientTurnId: CLIENT_1,
      cancellationId: CANCEL_1,
      reason: 'user',
    });
    await waitFor(() => h.socket.events().some((event) => event.type === 'turn.cancelled'));
    await endSession(h, run);
  });

  it('brûle les séquences ingérées quand un tour est annulé', async () => {
    const h = harness();
    h.provider.modes.push('manual', 'manual');
    const { run } = await connect(h);
    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    h.socket.clientBinary(audioFrame(1, 0));
    h.socket.clientBinary(audioFrame(1, 1));
    h.socket.clientControl({
      type: 'turn.cancel',
      clientTurnId: CLIENT_1,
      cancellationId: CANCEL_1,
      reason: 'user',
    });
    await waitFor(() => h.socket.events().some((event) => (
      event.type === 'turn.cancelled' && event.clientTurnId === CLIENT_1
    )));

    await startTurn(h, {
      clientTurnId: CLIENT_2,
      ordinal: 2,
      firstAudioSequence: 2,
      vadStartedAtMs: 2_000,
    });
    expect(h.authority.snapshot?.mission.nextAudioSequence).toBe(2);
    await endSession(h, run);
  });

  it('interrompt le raisonnement et ignore son résultat tardif', async () => {
    const h = harness();
    const reasonGate = deferred<{ readonly handle: string }>();
    h.pipeline.reasonGate = reasonGate;
    const { run } = await connect(h);
    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    h.socket.clientBinary(audioFrame(1, 0));
    h.socket.clientControl(commitControl(CLIENT_1, 0, 1_320));
    await waitFor(() => h.pipeline.reason.mock.calls.length === 1);

    h.socket.clientControl({
      type: 'turn.cancel',
      clientTurnId: CLIENT_1,
      cancellationId: CANCEL_1,
      reason: 'user',
    });
    await waitFor(() => h.socket.events().some((event) => event.type === 'turn.cancelled'));
    reasonGate.resolve({ handle: 'reasoning_handle_late_result' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.pipeline.auditAndRender).not.toHaveBeenCalled();
    expect(h.socket.events().some((event) => event.type === 'turn.completed')).toBe(false);
    await endSession(h, run);
  });

  it('ignore un transcript final fournisseur reçu après annulation', async () => {
    const h = harness();
    h.provider.modes.push('manual');
    const { run } = await connect(h);
    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    h.socket.clientBinary(audioFrame(1, 0));
    h.socket.clientControl(commitControl(CLIENT_1, 0, 1_320));
    await waitFor(() => h.provider.connections[0]?.commitAudio.mock.calls.length === 1);
    h.socket.clientControl({
      type: 'turn.cancel',
      clientTurnId: CLIENT_1,
      cancellationId: CANCEL_1,
      reason: 'user',
    });
    await waitFor(() => h.socket.events().some((event) => event.type === 'turn.cancelled'));
    h.provider.connections[0]?.emitFinal('ce texte doit être ignoré');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.socket.events().some((event) => event.type === 'turn.transcript')).toBe(false);
    await endSession(h, run);
  });

  it('drain session.end annule le tour actif avant de fermer', async () => {
    const h = harness();
    h.provider.modes.push('manual');
    const { run } = await connect(h);
    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    h.socket.clientBinary(audioFrame(1, 0));
    await endSession(h, run);

    const eventTypes = h.socket.events().map((event) => event.type);
    expect(eventTypes.slice(-3)).toEqual(['turn.cancelled', 'session.draining', 'session.closed']);
    expect(h.provider.connections[0]?.signal.aborted).toBe(true);
    expect(h.provider.connections[0]?.close).toHaveBeenCalled();
  });

  it.each(['background', 'context_changed', 'client_handoff'] as const)(
    'conserve la raison client %s jusque dans le drain durable',
    async (reason) => {
      const h = harness();
      const { run } = await connect(h);
      h.socket.clientControl({ type: 'session.end', reason });
      await run;
      expect(h.socket.events().slice(-2)).toMatchObject([
        { type: 'session.draining', reason },
        { type: 'session.closed', reason },
      ]);
      expect(h.authority.snapshot?.mission.drainReason).toBe(reason);
    },
  );

  it('shutdown externe draine durablement avant d’aborter le provider', async () => {
    const h = harness();
    h.provider.modes.push('manual');
    const shutdown = new AbortController();
    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies, {
      signal: shutdown.signal,
    });
    authenticate(h.socket);
    await waitFor(() => h.socket.events().some((event) => event.type === 'session.ready'));
    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    shutdown.abort();
    await run;
    expect(h.socket.events().slice(-3).map((event) => event.type)).toEqual([
      'turn.cancelled',
      'session.draining',
      'session.closed',
    ]);
    expect(h.socket.events().at(-1)).toMatchObject({ reason: 'service_shutdown' });
    expect(h.provider.connections[0]?.signal.aborted).toBe(true);
    expect(h.socket.closes[0]).toEqual({ code: 1000, reason: 'session_closed' });
  });

  it('isole une panne provider puis accepte le tour suivant', async () => {
    const h = harness();
    h.provider.modes.push('error', 'final');
    const { run } = await connect(h);
    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    h.socket.clientBinary(audioFrame(1, 0));
    h.socket.clientControl(commitControl(CLIENT_1, 0, 1_320));
    await waitFor(() => h.socket.events().some((event) => (
      event.type === 'error' && event.code === 'temporarily_unavailable'
    )));
    expect(h.socket.events().some((event) => (
      event.type === 'turn.cancelled' && event.clientTurnId === CLIENT_1
    ))).toBe(true);

    await completeTurn(h, {
      clientTurnId: CLIENT_2,
      ordinal: 2,
      audioSequence: 1,
      vadStartedAtMs: 2_000,
    });
    expect(h.provider.openTurn).toHaveBeenCalledTimes(2);
    await endSession(h, run);
  });

  it('refuse framing pré-auth invalide sans exposer le ticket ni une erreur interne', async () => {
    const h = harness();
    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    h.socket.clientBinary(audioFrame(1, 0));
    await expect(run).rejects.toMatchObject({ code: 'protocol_error' });
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.socket.events()).toEqual([expect.objectContaining({
      type: 'error',
      code: 'protocol_error',
      retryable: false,
    })]);
    expect(h.socket.sent.join(' ')).not.toContain(TICKET);
    expect(h.socket.closes[0]).toEqual({ code: 4400, reason: 'protocol_error' });
  });

  it('échoue fermé avant bootstrap si une autorité obligatoire est absente', async () => {
    const h = harness();
    const incomplete = { ...h.dependencies, context: undefined } as unknown as MistralConversationGatewayV2Dependencies;
    await expect(serveMistralConversationGatewayV2(h.socket, incomplete)).rejects.toMatchObject({
      code: 'temporarily_unavailable',
    });
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.authority.openInputs).toHaveLength(0);
  });

  it('ferme sur timeout d’authentification avec un code borné', async () => {
    vi.useFakeTimers();
    const h = harness({ authTimeoutMs: 1_000 });
    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    const assertion = expect(run).rejects.toMatchObject({ code: 'auth_timeout' });
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
    expect(h.socket.closes[0]).toEqual({ code: 4408, reason: 'authentication_failed' });
  });

  it('fail-closed si le downlink dépasse sa borne après ouverture durable', async () => {
    const h = harness();
    h.socket.bufferedAmount = 300_000;
    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    authenticate(h.socket);
    await expect(run).rejects.toMatchObject({ code: 'backpressure' });
    expect(h.authority.openInputs).toHaveLength(1);
    expect(h.socket.closes[0]).toEqual({ code: 1013, reason: 'backpressure' });
  });

  it('borne un callback socket.send après persistance', async () => {
    const h = harness({ operationTimeoutMs: 25, cleanupTimeoutMs: 25 });
    const { run } = await connect(h);
    h.socket.hangSends = true;
    h.socket.clientControl(startControl(CLIENT_1, 1_000));
    await expect(run).rejects.toMatchObject({ code: 'backpressure' });
    expect(h.authority.applied.some((entry) => entry.command.type === 'start_turn')).toBe(true);
    expect(h.provider.openTurn).toHaveBeenCalledTimes(1);
    expect(h.provider.connections[0]?.signal.aborted).toBe(true);
    expect(h.socket.events().some((event) => event.type === 'turn.started')).toBe(false);
  });

  it('refuse un second tour PTT pendant la réponse sans lancer un provider', async () => {
    const h = harness();
    const reasonGate = deferred<{ readonly handle: string }>();
    h.pipeline.reasonGate = reasonGate;
    const { run } = await connect(h);
    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    h.socket.clientBinary(audioFrame(1, 0));
    h.socket.clientControl(commitControl(CLIENT_1, 0, 1_320));
    await waitFor(() => h.pipeline.reason.mock.calls.length === 1);
    h.socket.clientControl(startControl(CLIENT_2, 2_000));
    await waitFor(() => h.socket.events().some((event) => (
      event.type === 'error' && event.code === 'route_uncertified'
    )));
    expect(h.provider.openTurn).toHaveBeenCalledTimes(1);

    h.socket.clientControl({
      type: 'turn.cancel',
      clientTurnId: CLIENT_1,
      cancellationId: CANCEL_1,
      reason: 'user',
    });
    await waitFor(() => h.socket.events().some((event) => event.type === 'turn.cancelled'));
    reasonGate.resolve({ handle: 'reasoning_handle_cancelled_ptt' });
    await endSession(h, run);
  });

  it('accepte une route certifiée volontairement dégradée en push-to-talk', async () => {
    const h = harness({ grant: { routeMode: 'push_to_talk', fullDuplexCertified: true } });
    const { run } = await connect(h);
    expect(h.socket.events()[0]).toMatchObject({
      type: 'session.ready',
      routeMode: 'push_to_talk',
      fullDuplexCertified: true,
    });
    await endSession(h, run);
  });

  it('effectue un barge-in full duplex certifié dans une transition atomique', async () => {
    const h = harness({ grant: { routeMode: 'full_duplex', fullDuplexCertified: true } });
    const reasonGate = deferred<{ readonly handle: string }>();
    h.pipeline.reasonGate = reasonGate;
    h.provider.modes.push('final', 'final');
    const { run } = await connect(h);
    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    h.socket.clientBinary(audioFrame(1, 0));
    h.socket.clientControl(commitControl(CLIENT_1, 0, 1_320));
    await waitFor(() => h.pipeline.reason.mock.calls.length === 1);
    h.pipeline.reasonGate = null;

    await startTurn(h, {
      clientTurnId: CLIENT_2,
      ordinal: 2,
      firstAudioSequence: 1,
      vadStartedAtMs: 2_000,
    });
    const barge = h.authority.applied.find((entry) => (
      entry.command.type === 'start_turn' && entry.command.control.clientTurnId === CLIENT_2
    ));
    expect(barge?.events.map((event) => event.type)).toEqual(['turn.cancelled', 'turn.started']);
    expect(h.provider.openTurn).toHaveBeenCalledTimes(2);
    expect(h.provider.connections[0]?.signal.aborted).toBe(true);

    h.socket.clientBinary(audioFrame(2, 1));
    h.socket.clientControl(commitControl(CLIENT_2, 1, 2_320));
    await waitFor(() => h.socket.events().some((event) => (
      event.type === 'turn.completed' && event.clientTurnId === CLIENT_2
    )));
    reasonGate.resolve({ handle: 'reasoning_handle_old_late' });
    await endSession(h, run);
  });

  it('supporte dix barge-ins atomiques successifs sans compléter une réponse annulée', async () => {
    const h = harness({ grant: { routeMode: 'full_duplex', fullDuplexCertified: true } });
    let gate = deferred<{ readonly handle: string }>();
    h.pipeline.reasonGate = gate;
    const { run } = await connect(h);
    const clientId = (ordinal: number): string => (
      `60000000-0000-4000-8000-${ordinal.toString().padStart(12, '0')}`
    );

    await startTurn(h, {
      clientTurnId: clientId(1),
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    h.socket.clientBinary(audioFrame(1, 0));
    h.socket.clientControl(commitControl(clientId(1), 0, 1_320));
    await waitFor(() => h.pipeline.reason.mock.calls.length === 1);

    for (let ordinal = 2; ordinal <= 11; ordinal += 1) {
      const cancelledGate = gate;
      gate = deferred<{ readonly handle: string }>();
      h.pipeline.reasonGate = gate;
      await startTurn(h, {
        clientTurnId: clientId(ordinal),
        ordinal,
        firstAudioSequence: ordinal - 1,
        vadStartedAtMs: ordinal * 1_000,
      });
      cancelledGate.resolve({ handle: `reasoning_handle_cancelled_${ordinal - 1}` });
      h.socket.clientBinary(audioFrame(ordinal, ordinal - 1));
      h.socket.clientControl(commitControl(clientId(ordinal), ordinal - 1, ordinal * 1_000 + 320));
      await waitFor(() => h.pipeline.reason.mock.calls.length === ordinal);
    }

    const atomicBargeIns = h.authority.applied.filter((entry) => (
      entry.command.type === 'start_turn'
      && entry.events.map((event) => event.type).join(',') === 'turn.cancelled,turn.started'
    ));
    expect(atomicBargeIns).toHaveLength(10);
    expect(h.socket.events().some((event) => event.type === 'turn.completed')).toBe(false);
    expect(h.provider.connections.slice(0, 10).every((connection) => connection.signal.aborted)).toBe(true);

    h.socket.clientControl({
      type: 'turn.cancel',
      clientTurnId: clientId(11),
      cancellationId: CANCEL_2,
      reason: 'user',
    });
    await waitFor(() => h.socket.events().some((event) => (
      event.type === 'turn.cancelled' && event.clientTurnId === clientId(11)
    )));
    gate.resolve({ handle: 'reasoning_handle_final_cancelled' });
    await endSession(h, run);
  });

  it('déduplique start, audio, commit, cancel et contexte sans rejouer les side-effects', async () => {
    const h = harness();
    h.provider.modes.push('manual');
    const { run } = await connect(h);
    const start = startControl(CLIENT_1, 1_000);
    h.socket.clientControl(start);
    await waitFor(() => h.provider.connections.length === 1);
    h.socket.clientControl(start);
    await waitFor(() => h.authority.attempts.filter((command) => command.type === 'start_turn').length === 2);
    expect(h.provider.openTurn).toHaveBeenCalledTimes(1);

    const frame = audioFrame(1, 0);
    h.socket.clientBinary(frame);
    h.socket.clientBinary(frame);
    await waitFor(() => h.provider.connections[0]?.audio.length === 1);
    const commit = commitControl(CLIENT_1, 0, 1_320);
    h.socket.clientControl(commit);
    h.socket.clientControl(commit);
    await waitFor(() => h.authority.attempts.filter((command) => command.type === 'commit_turn').length === 2);
    expect(h.provider.connections[0]?.commitAudio).toHaveBeenCalledTimes(1);

    const cancel = {
      type: 'turn.cancel' as const,
      clientTurnId: CLIENT_1,
      cancellationId: CANCEL_2,
      reason: 'user' as const,
    };
    h.socket.clientControl(cancel);
    await waitFor(() => h.socket.events().some((event) => event.type === 'turn.cancelled'));
    h.socket.clientControl(cancel);
    h.socket.clientControl({ type: 'context.update', contextRevision: 2, contextDigest: DIGEST_2 });
    h.socket.clientControl({ type: 'context.update', contextRevision: 2, contextDigest: DIGEST_2 });
    await waitFor(() => h.authority.attempts.filter((command) => command.type === 'update_context').length === 2);

    for (const type of ['start_turn', 'ingest_audio', 'commit_turn', 'cancel_turn', 'update_context'] as const) {
      expect(h.authority.applied.filter((entry) => entry.command.type === type)).toHaveLength(1);
    }
    await endSession(h, run);
  });

  it('reconstruit les IDs HMAC identiques après redémarrage du process', async () => {
    const first = harness();
    first.provider.modes.push('manual');
    const firstConnection = await connect(first);
    await startTurn(first, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    const firstCommand = first.authority.applied.find((entry) => entry.command.type === 'start_turn')?.command;
    await endSession(first, firstConnection.run);

    const second = harness();
    second.provider.modes.push('manual');
    const secondConnection = await connect(second);
    await startTurn(second, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    const secondCommand = second.authority.applied.find((entry) => entry.command.type === 'start_turn')?.command;
    expect(secondCommand).toEqual(firstCommand);
    await endSession(second, secondConnection.run);
  });

  it('accepte les frames texte Buffer livrées par ws sans assouplir UTF-8', async () => {
    const h = harness();
    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    h.socket.clientTextBytes({
      type: 'authenticate',
      protocol: MISTRAL_CONVERSATION_PROTOCOL,
      companyId: h.grant.companyId,
      ticket: TICKET,
      resumeNextServerSequence: 0,
    });
    await waitFor(() => h.socket.events().some((event) => event.type === 'session.ready'));
    h.socket.clientTextBytes({ type: 'session.end', reason: 'user' });
    await run;
    expect(h.socket.events().slice(-2).map((event) => event.type)).toEqual([
      'session.draining',
      'session.closed',
    ]);
  });

  it('refuse un faux texte ws qui n’est pas un UTF-8 canonique', async () => {
    const h = harness();
    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    h.socket.clientRawTextBytes(Uint8Array.of(0xc3, 0x28));
    await expect(run).rejects.toMatchObject({ code: 'protocol_error' });
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.socket.closes[0]).toEqual({ code: 4400, reason: 'protocol_error' });
  });

  it('livre ready avant de fermer une authentification pipelinée, sans trou de séquence', async () => {
    const h = harness();
    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    authenticate(h.socket);
    h.socket.clientControl(startControl(CLIENT_1, 1_000));
    await expect(run).rejects.toMatchObject({ code: 'protocol_error' });
    expect(h.socket.events().map((event) => event.type)).toEqual([
      'session.ready',
      'session.draining',
      'session.closed',
    ]);
    expect(h.socket.events().map((event) => event.serverSequence)).toEqual([0, 1, 2]);
  });

  it('borne l’ingress pré-auth et conserve la cause backpressure', async () => {
    const h = harness();
    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    authenticate(h.socket);
    for (let index = 0; index < 300; index += 1) h.socket.clientRaw('{}');
    await expect(run).rejects.toMatchObject({ code: 'backpressure' });
    const sequences = h.socket.events().map((event) => event.serverSequence);
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, index) => index));
    expect(h.socket.closes[0]).toEqual({ code: 1013, reason: 'backpressure' });
  });

  it('applique la deadline globale si bootstrap.consume ignore son AbortSignal', async () => {
    vi.useFakeTimers();
    const h = harness({ authTimeoutMs: 1_000 });
    h.consume.mockImplementation(async () => new Promise(() => undefined));
    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    authenticate(h.socket);
    await Promise.resolve();
    await Promise.resolve();
    const assertion = expect(run).rejects.toMatchObject({ code: 'auth_timeout' });
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
    expect(h.authority.openInputs).toHaveLength(0);
  });

  it('refuse un snapshot de création qui ne respecte pas les compteurs initiaux', async () => {
    const h = harness();
    const created = createMistralConversationDurableSession({ grant: h.grant, missionConnectionEpoch: 1 });
    vi.spyOn(h.authority, 'open').mockResolvedValueOnce({
      status: 'opened',
      snapshot: { ...created.snapshot, version: 2 },
      replayFromServerSequence: 0,
      recovery: null,
      terminal: null,
      events: created.events,
    });

    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    authenticate(h.socket);
    await expect(run).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    expect(h.provider.openTurn).not.toHaveBeenCalled();
  });

  it('reprend un owner crashé en annulant durablement le tour sans rejouer le PCM', async () => {
    const h = harness();
    const created = createMistralConversationDurableSession({ grant: h.grant, missionConnectionEpoch: 1 });
    const started = reduceMistralConversationDurableSnapshot(created.snapshot, {
      type: 'start_turn',
      commandId: `start:${CLIENT_1}`,
      control: startControl(CLIENT_1, 1_000),
      turnId: 'turn_before_owner_crash',
      bargeInCancellationId: CANCEL_1,
    });
    const active = reduceMistralConversationDurableSnapshot(started.snapshot, {
      type: 'ingest_audio',
      commandId: 'audio:crashed:0',
      frame: {
        turnOrdinal: 1,
        audioSequence: 0,
        audioBytes: MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
        audioSha256: 'e'.repeat(64),
      },
    });
    h.authority.snapshot = active.snapshot;
    h.authority.outbox.push(...created.events, ...started.events, ...active.events);

    const { run } = await connect(h);
    expect(h.socket.events().map((event) => event.type)).toEqual([
      'session.ready',
      'turn.started',
      'session.route_recovering',
      'turn.cancelled',
      'session.route_recovered',
    ]);
    expect(h.authority.snapshot).toMatchObject({
      missionConnectionEpoch: 2,
      nextProviderSequence: 0,
      finalTranscriptRecorded: false,
      turn: null,
      mission: {
        phase: 'ready',
        missionConnectionEpoch: 2,
        nextAudioSequence: 1,
        audioBytes: MISTRAL_CONVERSATION_AUDIO_QUANTUM_BYTES,
      },
    });
    expect(h.provider.openTurn).not.toHaveBeenCalled();
    await endSession(h, run);
  });

  it('rejoue le session.ready historique après changement durable de contexte et de route', async () => {
    const h = harness({
      grant: {
        contextRevision: 2,
        contextDigest: DIGEST_2,
        routeMode: 'full_duplex',
        fullDuplexCertified: true,
      },
    });
    const initialGrant: MistralConversationBootstrapGrant = {
      ...h.grant,
      contextRevision: 1,
      contextDigest: DIGEST_1,
      routeMode: 'push_to_talk',
      fullDuplexCertified: false,
    };
    const created = createMistralConversationDurableSession({
      grant: initialGrant,
      missionConnectionEpoch: 1,
    });
    const contextUpdated = reduceMistralConversationDurableSnapshot(created.snapshot, {
      type: 'update_context',
      commandId: `context:2:${DIGEST_2}`,
      control: {
        type: 'context.update',
        contextRevision: 2,
        contextDigest: DIGEST_2,
      },
    });
    const recovered = recoverMistralConversationDurableSession(contextUpdated.snapshot, {
      newMissionConnectionEpoch: 2,
      cancellationId: CANCEL_1,
      routeMode: 'full_duplex',
      fullDuplexCertified: true,
    });
    const replayEvents = [...created.events, ...contextUpdated.events, ...recovered.events];
    vi.spyOn(h.authority, 'open').mockImplementationOnce(async (input) => {
      h.authority.ownerLeaseToken = input.ownerLeaseToken;
      h.authority.snapshot = recovered.snapshot;
      h.authority.outbox.push(...replayEvents);
      return {
        status: 'recovered',
        snapshot: recovered.snapshot,
        replayFromServerSequence: 0,
        recovery: {
          fromServerSequence: contextUpdated.snapshot.nextServerSequence,
          previousMissionConnectionEpoch: 1,
          previousCancellationGeneration: 0,
          cancellation: null,
        },
        terminal: null,
        events: replayEvents,
      };
    });

    const { run } = await connect(h);
    expect(h.socket.events().map((event) => event.type)).toEqual([
      'session.ready',
      'session.context_updated',
      'session.route_recovering',
      'session.route_recovered',
    ]);
    await endSession(h, run);
  });

  it('réserve les dernières séquences au drain terminal et refuse tout takeover irréparable', () => {
    const h = harness();
    const created = createMistralConversationDurableSession({ grant: h.grant, missionConnectionEpoch: 1 });
    const terminalOnly = { ...created.snapshot, nextServerSequence: UINT32_MAX - 1 };

    expect(() => reduceMistralConversationDurableSnapshot(terminalOnly, {
      type: 'record_error',
      commandId: 'error:at-boundary',
      errorCode: 'temporarily_unavailable',
      retryable: true,
    })).toThrow(expect.objectContaining({ code: 'temporarily_unavailable' }));

    const drained = reduceMistralConversationDurableSnapshot(terminalOnly, {
      type: 'drain',
      commandId: 'drain:at-boundary',
      reason: 'user',
      cancellationId: CANCEL_1,
    });
    const closed = reduceMistralConversationDurableSnapshot(drained.snapshot, {
      type: 'close',
      commandId: 'close:at-boundary',
    });
    expect([...drained.events, ...closed.events].map((event) => event.serverSequence)).toEqual([
      UINT32_MAX - 1,
      UINT32_MAX,
    ]);
    expect(closed.snapshot.nextServerSequence).toBe(UINT32_MAX + 1);

    const recoverable = recoverMistralConversationDurableSession(
      { ...created.snapshot, nextServerSequence: UINT32_MAX - 3 },
      {
        newMissionConnectionEpoch: 2,
        cancellationId: CANCEL_1,
        routeMode: h.grant.routeMode,
        fullDuplexCertified: h.grant.fullDuplexCertified,
      },
    );
    expect(recoverable.snapshot.nextServerSequence).toBe(UINT32_MAX - 1);
    expect(() => recoverMistralConversationDurableSession(
      { ...created.snapshot, nextServerSequence: UINT32_MAX - 2 },
      {
        newMissionConnectionEpoch: 2,
        cancellationId: CANCEL_1,
        routeMode: h.grant.routeMode,
        fullDuplexCertified: h.grant.fullDuplexCertified,
      },
    )).toThrow(expect.objectContaining({ code: 'temporarily_unavailable' }));

    const started = reduceMistralConversationDurableSnapshot(created.snapshot, {
      type: 'start_turn',
      commandId: `start:${CLIENT_1}`,
      control: startControl(CLIENT_1, 1_000),
      turnId: 'turn_at_sequence_boundary',
      bargeInCancellationId: CANCEL_1,
    });
    const activeRecovered = recoverMistralConversationDurableSession(
      { ...started.snapshot, nextServerSequence: UINT32_MAX - 4 },
      {
        newMissionConnectionEpoch: 2,
        cancellationId: CANCEL_2,
        routeMode: h.grant.routeMode,
        fullDuplexCertified: h.grant.fullDuplexCertified,
      },
    );
    expect(activeRecovered.events).toHaveLength(3);
    expect(activeRecovered.snapshot.nextServerSequence).toBe(UINT32_MAX - 1);
    expect(() => recoverMistralConversationDurableSession(
      { ...started.snapshot, nextServerSequence: UINT32_MAX - 3 },
      {
        newMissionConnectionEpoch: 2,
        cancellationId: CANCEL_2,
        routeMode: h.grant.routeMode,
        fullDuplexCertified: h.grant.fullDuplexCertified,
      },
    )).toThrow(expect.objectContaining({ code: 'temporarily_unavailable' }));
  });

  it('refuse le wrap de missionConnectionEpoch', () => {
    const h = harness();
    const created = createMistralConversationDurableSession({
      grant: h.grant,
      missionConnectionEpoch: INT32_MAX,
    });
    expect(() => recoverMistralConversationDurableSession(created.snapshot, {
      newMissionConnectionEpoch: INT32_MAX + 1,
      cancellationId: CANCEL_1,
      routeMode: h.grant.routeMode,
      fullDuplexCertified: h.grant.fullDuplexCertified,
    })).toThrow();
  });

  it('réserve deux versions durables pour drain puis close', () => {
    const h = harness();
    const created = createMistralConversationDurableSession({ grant: h.grant, missionConnectionEpoch: 1 });
    const terminalOnly = {
      ...created.snapshot,
      version: Number.MAX_SAFE_INTEGER - 2,
    };
    expect(() => reduceMistralConversationDurableSnapshot(terminalOnly, {
      type: 'record_error',
      commandId: 'error:version-boundary',
      errorCode: 'temporarily_unavailable',
      retryable: true,
    })).toThrow(expect.objectContaining({ code: 'temporarily_unavailable' }));

    const drained = reduceMistralConversationDurableSnapshot(terminalOnly, {
      type: 'drain',
      commandId: 'drain:version-boundary',
      reason: 'user',
      cancellationId: CANCEL_1,
    });
    const closed = reduceMistralConversationDurableSnapshot(drained.snapshot, {
      type: 'close',
      commandId: 'close:version-boundary',
    });
    expect(closed.snapshot.version).toBe(Number.MAX_SAFE_INTEGER);

    expect(() => recoverMistralConversationDurableSession(terminalOnly, {
      newMissionConnectionEpoch: 2,
      cancellationId: CANCEL_1,
      routeMode: h.grant.routeMode,
      fullDuplexCertified: h.grant.fullDuplexCertified,
    })).toThrow(expect.objectContaining({ code: 'temporarily_unavailable' }));
  });

  it('refuse un suffixe de takeover qui omet l’annulation déclarée', async () => {
    const h = harness();
    const created = createMistralConversationDurableSession({ grant: h.grant, missionConnectionEpoch: 1 });
    const started = reduceMistralConversationDurableSnapshot(created.snapshot, {
      type: 'start_turn',
      commandId: `start:${CLIENT_1}`,
      control: startControl(CLIENT_1, 1_000),
      turnId: 'turn_before_corrupt_takeover',
      bargeInCancellationId: CANCEL_1,
    });
    const recovered = recoverMistralConversationDurableSession(started.snapshot, {
      newMissionConnectionEpoch: 2,
      cancellationId: '50000000-0000-4000-8000-000000000001',
      routeMode: h.grant.routeMode,
      fullDuplexCertified: h.grant.fullDuplexCertified,
    });
    const [recovering, , routeRecovered] = recovered.events;
    expect(recovered.recoveryCancellation).not.toBeNull();
    if (!recovering || routeRecovered?.type !== 'session.route_recovered') throw new Error('invalid_fixture');
    const corruptRecovered = { ...routeRecovered, serverSequence: routeRecovered.serverSequence - 1 };
    vi.spyOn(h.authority, 'open').mockResolvedValueOnce({
      status: 'recovered',
      snapshot: { ...recovered.snapshot, nextServerSequence: recovered.snapshot.nextServerSequence - 1 },
      replayFromServerSequence: 0,
      recovery: {
        fromServerSequence: started.snapshot.nextServerSequence,
        previousMissionConnectionEpoch: started.snapshot.missionConnectionEpoch,
        previousCancellationGeneration: started.snapshot.mission.cancellationGeneration,
        cancellation: recovered.recoveryCancellation,
      },
      terminal: null,
      events: [...created.events, ...started.events, recovering, corruptRecovered],
    });

    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    authenticate(h.socket);
    await expect(run).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    expect(h.provider.openTurn).not.toHaveBeenCalled();
  });

  it('refuse chaque incohérence de fencing dans les métadonnées de recovery', async () => {
    for (const mutation of ['epoch', 'generation', 'cancellation'] as const) {
      const h = harness();
      const created = createMistralConversationDurableSession({ grant: h.grant, missionConnectionEpoch: 1 });
      const started = reduceMistralConversationDurableSnapshot(created.snapshot, {
        type: 'start_turn',
        commandId: `start:${CLIENT_1}`,
        control: startControl(CLIENT_1, 1_000),
        turnId: 'turn_recovery_metadata',
        bargeInCancellationId: CANCEL_1,
      });
      const recovered = recoverMistralConversationDurableSession(started.snapshot, {
        newMissionConnectionEpoch: 2,
        cancellationId: CANCEL_2,
        routeMode: h.grant.routeMode,
        fullDuplexCertified: h.grant.fullDuplexCertified,
      });
      const baseRecovery = {
        fromServerSequence: started.snapshot.nextServerSequence,
        previousMissionConnectionEpoch: started.snapshot.missionConnectionEpoch,
        previousCancellationGeneration: started.snapshot.mission.cancellationGeneration,
        cancellation: recovered.recoveryCancellation,
      };
      const corruptRecovery = mutation === 'epoch'
        ? { ...baseRecovery, previousMissionConnectionEpoch: 2 }
        : mutation === 'generation'
          ? { ...baseRecovery, previousCancellationGeneration: 1 }
          : { ...baseRecovery, cancellation: null };
      vi.spyOn(h.authority, 'open').mockResolvedValueOnce({
        status: 'recovered',
        snapshot: recovered.snapshot,
        replayFromServerSequence: 0,
        recovery: corruptRecovery,
        terminal: null,
        events: [...created.events, ...started.events, ...recovered.events],
      });

      const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
      authenticate(h.socket);
      await expect(run).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    }
  });

  it('borne le replay agrégé avant takeover et ne mute pas la lease sur refus', async () => {
    const h = harness();
    const created = createMistralConversationDurableSession({ grant: h.grant, missionConnectionEpoch: 1 });
    const history = [
      ...created.events,
      ...Array.from({ length: 299 }, (_, offset): MistralConversationServerEvent => ({
        type: 'error',
        serverSequence: offset + 1,
        code: 'temporarily_unavailable',
        retryable: true,
      })),
    ];
    h.authority.snapshot = {
      ...created.snapshot,
      version: 300,
      nextServerSequence: 300,
    };
    h.authority.outbox.push(...history);
    const before = structuredClone(h.authority.snapshot);
    const ownerBefore = h.authority.ownerLeaseToken;

    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    authenticate(h.socket);
    await expect(run).rejects.toMatchObject({ code: 'temporarily_unavailable' });

    expect(h.authority.openInputs.at(-1)).toMatchObject({
      maxReplayEvents: 256,
      maxReplayBytes: 240 * 1024,
    });
    expect(h.authority.snapshot).toEqual(before);
    expect(h.authority.ownerLeaseToken).toBe(ownerBefore);
    expect(h.authority.outbox).toEqual(history);
  });

  it('terminalise au lieu de reprendre si backlog plus suffixe dépasse la fenêtre live', async () => {
    const h = harness();
    const created = createMistralConversationDurableSession({ grant: h.grant, missionConnectionEpoch: 1 });
    const backlog = Array.from({ length: 251 }, (_, offset): MistralConversationServerEvent => ({
      type: 'error',
      serverSequence: offset + 1,
      code: 'temporarily_unavailable',
      retryable: true,
    }));
    h.authority.snapshot = {
      ...created.snapshot,
      version: 252,
      nextServerSequence: 252,
    };
    h.authority.outbox.push(...created.events, ...backlog);

    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    authenticate(h.socket);
    await run;

    expect(h.socket.events().slice(-2).map((event) => event.type)).toEqual([
      'session.draining',
      'session.closed',
    ]);
    expect(h.socket.events().some((event) => event.type === 'session.route_recovering')).toBe(false);
    expect(h.authority.snapshot?.mission.phase).toBe('closed');
    expect(h.provider.openTurn).not.toHaveBeenCalled();
  });

  it('ferme avec la réserve terminale quand la fenêtre non ACKée est épuisée', async () => {
    const h = harness();
    const first = await connect(h);
    await acknowledgeEvents(h.socket, h.authority, 1, 1);
    const backlog = Array.from({ length: 252 }, (_, offset): MistralConversationServerEvent => ({
      type: 'error',
      serverSequence: offset + 1,
      code: 'temporarily_unavailable',
      retryable: true,
    }));
    h.authority.snapshot = {
      ...h.authority.snapshot!,
      version: h.authority.snapshot!.version + 1,
      nextServerSequence: 253,
      acknowledgedServerSequence: 1,
    };
    h.authority.outbox.push(...backlog);

    h.socket.clientControl({ type: 'context.update', contextRevision: 2, contextDigest: DIGEST_2 });
    await waitFor(() => h.socket.events().some((event) => (
      event.type === 'session.context_updated' && event.contextRevision === 2
    )));
    h.socket.clientControl({ type: 'context.update', contextRevision: 3, contextDigest: DIGEST_3 });
    await expect(first.run).rejects.toMatchObject({ code: 'replay_window_exhausted' });

    expect(h.authority.snapshot?.mission.phase).toBe('closed');
    expect(h.authority.outbox.slice(-2).map((event) => event.type)).toEqual([
      'session.draining',
      'session.closed',
    ]);
    expect(h.authority.snapshot?.nextServerSequence).toBe(256);
  });

  it('ACK les effets sans créer d’événement et fence tout owner antérieur', async () => {
    const h = harness();
    const { run } = await connect(h);
    const before = h.socket.events().length;

    await acknowledgeEvents(h.socket, h.authority, 1, 1);
    expect(h.socket.events()).toHaveLength(before);
    expect(h.authority.applied.at(-1)?.command).toMatchObject({
      type: 'ack_events',
      control: { missionConnectionEpoch: 1, nextServerSequence: 1 },
    });

    h.socket.clientControl({ type: 'events.ack', missionConnectionEpoch: 1, nextServerSequence: 1 });
    await waitFor(() => h.authority.attempts.filter((command) => command.type === 'ack_events').length === 2);
    expect(h.authority.snapshot?.acknowledgedServerSequence).toBe(1);

    await endSession(h, run);
  });

  it('réconcilie le replay d’un ACK commité après la deadline locale', async () => {
    const h = harness();
    const { run } = await connect(h);
    const current = h.authority.snapshot;
    if (!current) throw new Error('Missing durable snapshot.');
    const command = {
      type: 'ack_events',
      commandId: 'ack:1:1',
      control: {
        type: 'events.ack',
        missionConnectionEpoch: 1,
        nextServerSequence: 1,
      },
    } satisfies MistralConversationDurableCommand;

    // Simule le commit PostgreSQL achevé après expiration de la deadline du premier appel : la
    // vue locale SerializedAuthority est encore version 1/ACK 0, l'autorité est version 2/ACK 1.
    await expect(h.authority.transition({
      companyId: h.grant.companyId,
      subjectHash: h.grant.subjectHash,
      sessionHandle: h.grant.sessionHandle,
      missionConnectionEpoch: 1,
      ownerLeaseToken: h.authority.ownerLeaseToken,
      expectedVersion: current.version,
      maxUnacknowledgedEvents: 253,
      maxUnacknowledgedBytes: 192 * 1024,
      command,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'applied' });

    h.socket.clientControl(command.control);
    await waitFor(() => h.authority.attempts.filter((attempt) => attempt.type === 'ack_events').length === 2);
    expect(h.socket.closes).toEqual([]);
    expect(h.authority.snapshot?.acknowledgedServerSequence).toBe(1);
    await endSession(h, run);
  });

  it('fence une ancienne socket encore vivante après takeover réussi', async () => {
    const h = harness();
    const first = await connect(h);
    const firstLease = h.authority.ownerLeaseToken;

    const replacement = new FakeSocket(h.log);
    const replacementRun = serveMistralConversationGatewayV2(replacement, h.dependencies);
    authenticate(replacement, 1);
    await waitFor(() => replacement.events().some((event) => event.type === 'session.route_recovered'));

    expect(h.authority.ownerLeaseToken).not.toBe(firstLease);
    expect(h.authority.openInputs.map((input) => input.ownerLeaseToken)).toEqual([
      'L'.repeat(43),
      'M'.repeat(43),
    ]);
    h.socket.clientControl(startControl(CLIENT_1, 1_000));
    await expect(first.run).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    expect(h.authority.snapshot?.mission.phase).toBe('ready');
    expect(h.authority.snapshot?.mission.lastTurnOrdinal).toBe(0);

    replacement.clientControl({ type: 'session.end', reason: 'user' });
    await replacementRun;
  });

  it('accepte une recovery sans annulation malgré un ancien tour terminal', async () => {
    const h = harness();
    const created = createMistralConversationDurableSession({ grant: h.grant, missionConnectionEpoch: 1 });
    h.authority.snapshot = {
      ...created.snapshot,
      mission: {
        ...created.snapshot.mission,
        lastTurnOrdinal: 1,
        lastTerminalTurn: {
          clientTurnId: CLIENT_1,
          turnId: 'old_completed_turn_1234567890',
          ordinal: 1,
          outcome: 'completed',
          cancellationId: null,
        },
      },
    };
    h.authority.outbox.push(...created.events);

    const { run } = await connect(h, 1);
    expect(h.socket.events().slice(-2).map((event) => event.type)).toEqual([
      'session.route_recovering',
      'session.route_recovered',
    ]);
    expect(h.socket.events().some((event) => event.type === 'turn.cancelled')).toBe(false);
    expect(h.authority.snapshot?.mission.lastTerminalTurn).toMatchObject({
      turnId: 'old_completed_turn_1234567890',
      outcome: 'completed',
    });
    await endSession(h, run);
  });

  it('met en file un ACK émis au bord du dernier événement de replay', async () => {
    const h = harness();
    const created = createMistralConversationDurableSession({
      grant: h.grant,
      missionConnectionEpoch: 1,
    });
    h.authority.snapshot = created.snapshot;
    h.authority.outbox.push(...created.events);
    h.socket.onServerEvent = (event) => {
      if (event.type !== 'session.route_recovered') return;
      h.socket.clientControl({
        type: 'events.ack',
        missionConnectionEpoch: event.missionConnectionEpoch,
        nextServerSequence: event.serverSequence + 1,
      });
    };

    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    authenticate(h.socket, 1);
    await waitFor(() => h.authority.snapshot?.acknowledgedServerSequence === 3);

    expect(h.socket.closes).toEqual([]);
    expect(h.authority.applied.at(-1)?.command).toMatchObject({
      type: 'ack_events',
      control: { missionConnectionEpoch: 2, nextServerSequence: 3 },
    });
    h.socket.clientControl({ type: 'session.end', reason: 'user' });
    await run;
  });

  it('ignore sans terminaliser un ACK ancien epoch émis pendant le replay historique', async () => {
    const h = harness();
    const created = createMistralConversationDurableSession({
      grant: h.grant,
      missionConnectionEpoch: 1,
    });
    h.authority.snapshot = created.snapshot;
    h.authority.outbox.push(...created.events);
    h.socket.onServerEvent = (event) => {
      if (event.type === 'session.ready') {
        h.socket.clientControl({
          type: 'events.ack',
          missionConnectionEpoch: 1,
          nextServerSequence: 1,
        });
      } else if (event.type === 'session.route_recovered') {
        h.socket.clientControl({
          type: 'events.ack',
          missionConnectionEpoch: event.missionConnectionEpoch,
          nextServerSequence: event.serverSequence + 1,
        });
      }
    };

    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    authenticate(h.socket, 0);
    await waitFor(() => h.authority.snapshot?.acknowledgedServerSequence === 3);

    expect(h.socket.closes).toEqual([]);
    expect(h.authority.attempts.filter((command) => command.type === 'ack_events')).toMatchObject([
      {
        type: 'ack_events',
        control: {
          type: 'events.ack',
          missionConnectionEpoch: 2,
          nextServerSequence: 3,
        },
      },
    ]);
    h.socket.clientControl({ type: 'session.end', reason: 'user' });
    await run;
  });

  it('ignore un ACK historique retardé après le passage local en ready', async () => {
    const h = harness();
    const created = createMistralConversationDurableSession({
      grant: h.grant,
      missionConnectionEpoch: 1,
    });
    h.authority.snapshot = created.snapshot;
    h.authority.outbox.push(...created.events);

    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    authenticate(h.socket, 0);
    await waitFor(() => h.socket.events().some((event) => event.type === 'session.route_recovered'));
    h.socket.clientControl({ type: 'context.update', contextRevision: 2, contextDigest: DIGEST_2 });
    await waitFor(() => h.socket.events().some((event) => (
      event.type === 'session.context_updated' && event.contextRevision === 2
    )));

    // Cet ACK de ready(0) est volontairement livré après une commande live : receivedPhase=ready.
    h.socket.clientControl({
      type: 'events.ack',
      missionConnectionEpoch: 1,
      nextServerSequence: 1,
    });
    h.socket.clientControl({
      type: 'events.ack',
      missionConnectionEpoch: 2,
      nextServerSequence: 4,
    });
    await waitFor(() => h.authority.snapshot?.acknowledgedServerSequence === 4);

    expect(h.socket.closes).toEqual([]);
    expect(h.authority.attempts.filter((command) => command.type === 'ack_events')).toMatchObject([
      {
        type: 'ack_events',
        control: {
          type: 'events.ack',
          missionConnectionEpoch: 2,
          nextServerSequence: 4,
        },
      },
    ]);
    h.socket.clientControl({ type: 'session.end', reason: 'user' });
    await run;
  });

  it('finalise puis rejoue une mission restée draining sans takeover ni doublon close', async () => {
    const h = harness();
    const first = await connect(h);
    await acknowledgeEvents(h.socket, h.authority, 1, 1);
    h.authority.loseOwnershipAt = 'close';
    h.socket.clientControl({ type: 'session.end', reason: 'user' });
    await expect(first.run).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    expect(h.authority.snapshot?.mission.phase).toBe('draining');
    expect(h.authority.outbox.filter((event) => event.type === 'session.closed')).toHaveLength(0);

    const resumed = new FakeSocket(h.log);
    const resumedRun = serveMistralConversationGatewayV2(resumed, h.dependencies);
    authenticate(resumed, 1);
    await resumedRun;
    expect(resumed.events().map((event) => event.type)).toEqual([
      'session.draining',
      'session.closed',
    ]);
    expect(resumed.events().some((event) => event.type === 'session.route_recovering')).toBe(false);
    expect(resumed.closes).toEqual([{ code: 1000, reason: 'session_closed' }]);
    expect(h.provider.openTurn).not.toHaveBeenCalled();
    expect(h.authority.snapshot?.mission.phase).toBe('closed');
    expect(h.authority.outbox.filter((event) => event.type === 'session.closed')).toHaveLength(1);

    const replayed = new FakeSocket(h.log);
    const replayedRun = serveMistralConversationGatewayV2(replayed, h.dependencies);
    authenticate(replayed, 1);
    await replayedRun;
    expect(replayed.events().map((event) => event.type)).toEqual([
      'session.draining',
      'session.closed',
    ]);
    expect(h.authority.outbox.filter((event) => event.type === 'session.closed')).toHaveLength(1);
  });

  it('rejoue un close persisté dont le downlink a été perdu', async () => {
    const h = harness({ operationTimeoutMs: 25 });
    const first = await connect(h);
    await acknowledgeEvents(h.socket, h.authority, 1, 1);
    h.socket.hangSends = true;
    h.socket.clientControl({ type: 'session.end', reason: 'background' });
    await expect(first.run).rejects.toMatchObject({ code: 'backpressure' });
    expect(h.authority.snapshot?.mission.phase).toBe('closed');
    expect(h.authority.outbox.slice(-2).map((event) => event.type)).toEqual([
      'session.draining',
      'session.closed',
    ]);

    const resumed = new FakeSocket(h.log);
    const resumedRun = serveMistralConversationGatewayV2(resumed, h.dependencies);
    authenticate(resumed, 1);
    await resumedRun;
    expect(resumed.events().slice(-2)).toMatchObject([
      { type: 'session.draining', reason: 'background' },
      { type: 'session.closed', reason: 'background' },
    ]);
    expect(h.authority.outbox.filter((event) => event.type === 'session.closed')).toHaveLength(1);
  });

  it('conserve l’intention terminale explicite si la route tombe pendant le drain', async () => {
    const h = harness({ cleanupTimeoutMs: 1_000 });
    const drainGate = h.authority.hold('drain');
    const first = await connect(h);
    await acknowledgeEvents(h.socket, h.authority, 1, 1);

    h.socket.clientControl({ type: 'session.end', reason: 'background' });
    await waitFor(() => h.authority.attempts.some((command) => command.type === 'drain'));
    h.socket.close(1006, 'route_lost_during_drain');
    drainGate.resolve();
    await first.run;

    expect(h.authority.snapshot?.mission).toMatchObject({
      phase: 'closed',
      drainReason: 'background',
    });
    expect(h.authority.applied.filter((entry) => entry.command.type === 'drain')).toHaveLength(1);
    expect(h.authority.applied.filter((entry) => entry.command.type === 'close')).toHaveLength(1);
    expect(h.authority.outbox.slice(-2)).toMatchObject([
      { type: 'session.draining', reason: 'background' },
      { type: 'session.closed', reason: 'background' },
    ]);

    const resumed = new FakeSocket(h.log);
    const resumedRun = serveMistralConversationGatewayV2(resumed, h.dependencies);
    authenticate(resumed, 1);
    await resumedRun;
    expect(resumed.events().map((event) => event.type)).toEqual([
      'session.draining',
      'session.closed',
    ]);
    expect(resumed.events().some((event) => event.type === 'session.route_recovering')).toBe(false);
    expect(resumed.events().at(-1)).toMatchObject({
      type: 'session.closed',
      reason: 'background',
    });
  });

  it('latch session.end dès son entrée en FIFO derrière une transition bloquée', async () => {
    const h = harness({ cleanupTimeoutMs: 1_000 });
    const startGate = h.authority.hold('start_turn');
    const first = await connect(h);
    await acknowledgeEvents(h.socket, h.authority, 1, 1);

    h.socket.clientControl(startControl(CLIENT_1, 1_000));
    await waitFor(() => h.authority.attempts.some((command) => command.type === 'start_turn'));
    h.socket.clientControl({ type: 'session.end', reason: 'background' });
    h.socket.close(1006, 'route_lost_before_end_dequeue');
    startGate.resolve();
    await first.run;

    expect(h.authority.snapshot?.mission).toMatchObject({
      phase: 'closed',
      drainReason: 'background',
    });
    const resumed = new FakeSocket(h.log);
    const resumedRun = serveMistralConversationGatewayV2(resumed, h.dependencies);
    authenticate(resumed, 1);
    await resumedRun;
    expect(resumed.events().map((event) => event.type)).toEqual([
      'turn.started',
      'turn.cancelled',
      'session.draining',
      'session.closed',
    ]);
    expect(resumed.events().some((event) => event.type === 'session.route_recovering')).toBe(false);
    expect(resumed.events().at(-1)).toMatchObject({
      type: 'session.closed',
      reason: 'background',
    });
  });

  it('préserve service_shutdown si la socket ferme pendant son drain', async () => {
    const h = harness({ cleanupTimeoutMs: 1_000 });
    const drainGate = h.authority.hold('drain');
    const controller = new AbortController();
    const run = serveMistralConversationGatewayV2(
      h.socket,
      h.dependencies,
      { signal: controller.signal },
    );
    authenticate(h.socket);
    await waitFor(() => h.socket.events().some((event) => event.type === 'session.ready'));

    controller.abort();
    await waitFor(() => h.authority.attempts.some((command) => command.type === 'drain'));
    h.socket.close(1006, 'route_lost_during_shutdown');
    drainGate.resolve();
    await run;

    expect(h.authority.snapshot?.mission).toMatchObject({
      phase: 'closed',
      drainReason: 'service_shutdown',
    });
    expect(h.authority.outbox.at(-1)).toMatchObject({
      type: 'session.closed',
      reason: 'service_shutdown',
    });
  });

  it('préserve expired si la socket ferme pendant son drain', async () => {
    const h = harness({
      grant: { hardExpiresAt: new Date(NOW + 150).toISOString() },
      cleanupTimeoutMs: 1_000,
    });
    const drainGate = h.authority.hold('drain');
    const first = await connect(h);

    await waitFor(() => h.authority.attempts.some((command) => command.type === 'drain'));
    h.socket.close(1006, 'route_lost_during_expiry');
    drainGate.resolve();
    await first.run;

    expect(h.authority.snapshot?.mission).toMatchObject({
      phase: 'closed',
      drainReason: 'expired',
    });
    expect(h.authority.outbox.at(-1)).toMatchObject({
      type: 'session.closed',
      reason: 'expired',
    });
  });

  it('accepte un replay terminal entièrement ACKé sans rouvrir le provider', async () => {
    const h = harness();
    const created = createMistralConversationDurableSession({ grant: h.grant, missionConnectionEpoch: 1 });
    const drained = reduceMistralConversationDurableSnapshot(created.snapshot, {
      type: 'drain',
      commandId: 'drain:already-acked-terminal',
      reason: 'user',
      cancellationId: CANCEL_1,
    });
    const closed = reduceMistralConversationDurableSnapshot(drained.snapshot, {
      type: 'close',
      commandId: 'close:already-acked-terminal',
    });
    h.authority.snapshot = {
      ...closed.snapshot,
      acknowledgedServerSequence: closed.snapshot.nextServerSequence,
    };
    h.authority.outbox.push(...created.events, ...drained.events, ...closed.events);

    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    authenticate(h.socket, closed.snapshot.nextServerSequence);
    h.socket.clientControl(startControl(CLIENT_1, 1_000));
    await run;

    expect(h.socket.events()).toEqual([]);
    expect(h.socket.closes).toEqual([{ code: 1000, reason: 'session_closed' }]);
    expect(h.provider.openTurn).not.toHaveBeenCalled();
    expect(h.authority.snapshot?.mission.lastTurnOrdinal).toBe(0);
  });

  it('reste fail-closed après H tant que la capacité de reprise atomique n’existe pas', async () => {
    const hardExpiresAt = new Date(NOW - 1_000).toISOString();
    const replayGraceExpiresAt = new Date(NOW + 10_000).toISOString();
    const h = harness({ grant: { hardExpiresAt } });
    const terminal = terminalReplayFixture(h, 'user', replayGraceExpiresAt);
    const open = vi.spyOn(h.authority, 'open').mockResolvedValueOnce(terminal);

    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    authenticate(h.socket, 0);
    await expect(run).rejects.toMatchObject({ code: 'temporarily_unavailable' });

    expect(open).not.toHaveBeenCalled();
    expect(h.socket.events()).toEqual([
      expect.objectContaining({ type: 'error', code: 'temporarily_unavailable' }),
    ]);
    expect(h.provider.openTurn).not.toHaveBeenCalled();
    expect(h.pipeline.reason).not.toHaveBeenCalled();
    expect(h.pipeline.auditAndRender).not.toHaveBeenCalled();
    expect(h.pipeline.stageDelivery).not.toHaveBeenCalled();
    expect(h.contextAuthorize).not.toHaveBeenCalled();
  });

  it.each([
    {
      boundary: 'G égal à H',
      replayGraceExpiresAt: BASE_GRANT.hardExpiresAt,
    },
    {
      boundary: 'G au-delà de la borne maximale',
      replayGraceExpiresAt: new Date(
        Date.parse(BASE_GRANT.hardExpiresAt) + 7 * 24 * 60 * 60 * 1_000 + 1,
      ).toISOString(),
    },
  ])(
    'refuse un replay terminal dont $boundary',
    async ({ replayGraceExpiresAt }) => {
      const h = harness();
      const terminal = terminalReplayFixture(h, 'user', replayGraceExpiresAt);
      vi.spyOn(h.authority, 'open').mockResolvedValueOnce(terminal);

      const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
      authenticate(h.socket, 0);
      await expect(run).rejects.toMatchObject({ code: 'temporarily_unavailable' });

      expect(h.socket.events()).toEqual([
        expect.objectContaining({ type: 'error', code: 'temporarily_unavailable' }),
      ]);
      expect(h.provider.openTurn).not.toHaveBeenCalled();
      expect(h.pipeline.reason).not.toHaveBeenCalled();
      expect(h.pipeline.auditAndRender).not.toHaveBeenCalled();
      expect(h.pipeline.stageDelivery).not.toHaveBeenCalled();
      expect(h.contextAuthorize).not.toHaveBeenCalled();
    },
  );

  it('refuse un replay terminal dont le curseur client dépasse le snapshot fermé', async () => {
    const h = harness();
    const terminal = terminalReplayFixture(h);
    vi.spyOn(h.authority, 'open').mockResolvedValueOnce(terminal);

    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    authenticate(h.socket, terminal.snapshot.nextServerSequence + 1);
    await expect(run).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    expect(h.socket.events()).toMatchObject([{
      type: 'error',
      code: 'temporarily_unavailable',
      retryable: true,
    }]);
    expect(h.provider.openTurn).not.toHaveBeenCalled();
  });

  it('refuse un snapshot fermé impossible avec nextServerSequence zéro', async () => {
    const h = harness();
    const terminal = terminalReplayFixture(h);
    const corrupt = {
      ...terminal,
      snapshot: {
        ...terminal.snapshot,
        nextServerSequence: 0,
      },
      replayFromServerSequence: 0,
      terminal: {
        ...terminal.terminal,
        closedAtServerSequence: -1,
      },
      events: [],
    } satisfies Extract<MistralConversationDurableOpenResult, { readonly status: 'terminal_replay' }>;
    vi.spyOn(h.authority, 'open').mockResolvedValueOnce(corrupt);

    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    authenticate(h.socket, 0);
    await expect(run).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    expect(h.provider.openTurn).not.toHaveBeenCalled();
  });

  it('refuse les minima terminales impossibles de version et de séquence de fermeture', async () => {
    for (const field of ['version', 'closedAtServerSequence'] as const) {
      const h = harness();
      const terminal = terminalReplayFixture(h);
      const corrupt = field === 'version'
        ? {
            ...terminal,
            snapshot: { ...terminal.snapshot, version: 2 },
          }
        : {
            ...terminal,
            terminal: { ...terminal.terminal, closedAtServerSequence: 1 },
          };
      vi.spyOn(h.authority, 'open').mockResolvedValueOnce(corrupt);

      const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
      authenticate(h.socket, 0);
      await expect(run).rejects.toMatchObject({ code: 'temporarily_unavailable' });
      expect(h.provider.openTurn).not.toHaveBeenCalled();
    }
  });

  it('refuse un replay terminal sans draining immédiatement avant closed', async () => {
    const h = harness();
    const terminal = terminalReplayFixture(h);
    const corruptEvents = terminal.events.map((event) => (
      event.type === 'session.draining'
        ? {
            type: 'error' as const,
            serverSequence: event.serverSequence,
            code: 'temporarily_unavailable' as const,
            retryable: true,
          }
        : event
    ));
    const corrupt = {
      ...terminal,
      events: corruptEvents,
    } satisfies Extract<MistralConversationDurableOpenResult, { readonly status: 'terminal_replay' }>;
    vi.spyOn(h.authority, 'open').mockResolvedValueOnce(corrupt);

    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    authenticate(h.socket, 0);
    await expect(run).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    expect(h.provider.openTurn).not.toHaveBeenCalled();
  });

  it('rejoue exactement cancelled, draining et closed pour un tour terminalisé', async () => {
    const h = harness();
    const created = createMistralConversationDurableSession({ grant: h.grant, missionConnectionEpoch: 1 });
    const started = reduceMistralConversationDurableSnapshot(created.snapshot, {
      type: 'start_turn',
      commandId: `start:${CLIENT_1}`,
      control: startControl(CLIENT_1, 1_000),
      turnId: 'turn_terminal_replay',
      bargeInCancellationId: CANCEL_1,
    });
    const startedAcked = {
      ...started.snapshot,
      acknowledgedServerSequence: started.snapshot.nextServerSequence,
    };
    const drained = reduceMistralConversationDurableSnapshot(startedAcked, {
      type: 'drain',
      commandId: 'drain:active-terminal-replay',
      reason: 'fatal_error',
      cancellationId: CANCEL_2,
    });
    h.authority.snapshot = drained.snapshot;
    h.authority.outbox.push(...created.events, ...started.events, ...drained.events);

    const run = serveMistralConversationGatewayV2(h.socket, h.dependencies);
    authenticate(h.socket, started.snapshot.nextServerSequence);
    await run;

    expect(h.socket.events().map((event) => event.type)).toEqual([
      'turn.cancelled',
      'session.draining',
      'session.closed',
    ]);
    expect(h.socket.events()[0]).toMatchObject({
      type: 'turn.cancelled',
      clientTurnId: CLIENT_1,
      turnId: 'turn_terminal_replay',
      cancellationId: CANCEL_2,
    });
  });

  it('répare une coupure après persistance avant envoi par replay outbox contigu', async () => {
    const first = harness({ operationTimeoutMs: 25 });
    first.provider.modes.push('manual');
    const firstConnection = await connect(first);
    await acknowledgeEvents(first.socket, first.authority, 1, 1);
    first.socket.hangSends = true;
    first.socket.clientControl(startControl(CLIENT_1, 1_000));
    await expect(firstConnection.run).rejects.toMatchObject({ code: 'backpressure' });
    expect(first.authority.snapshot?.mission.phase).toBe('turn_active');
    expect(first.authority.snapshot?.nextServerSequence).toBe(2);

    const resumedSocket = new FakeSocket(first.log);
    const resumedRun = serveMistralConversationGatewayV2(resumedSocket, first.dependencies);
    authenticate(resumedSocket, 1);
    await waitFor(() => resumedSocket.events().some((event) => event.type === 'session.route_recovered'));
    expect(resumedSocket.events().map((event) => event.serverSequence)).toEqual([1, 2, 3, 4]);
    expect(resumedSocket.events().map((event) => event.type)).toEqual([
      'turn.started',
      'session.route_recovering',
      'turn.cancelled',
      'session.route_recovered',
    ]);
    expect(first.authority.snapshot).toMatchObject({
      missionConnectionEpoch: 2,
      acknowledgedServerSequence: 1,
      nextServerSequence: 5,
      mission: { phase: 'ready' },
    });
    await acknowledgeEvents(resumedSocket, first.authority, 2, 5);
    resumedSocket.clientControl({ type: 'session.end', reason: 'user' });
    await resumedRun;
  });

  it('rejoue depuis le dernier ACK si l’envoi a réussi mais son ACK a été perdu', async () => {
    const first = harness();
    first.provider.modes.push('manual');
    const firstConnection = await connect(first);
    await acknowledgeEvents(first.socket, first.authority, 1, 1);
    await startTurn(first, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    expect(first.socket.events().at(-1)?.serverSequence).toBe(1);
    first.socket.close(1006, 'route_lost');
    await firstConnection.run;
    expect(first.authority.snapshot?.mission.phase).toBe('turn_active');

    const resumedSocket = new FakeSocket(first.log);
    const resumedRun = serveMistralConversationGatewayV2(resumedSocket, first.dependencies);
    authenticate(resumedSocket, 2);
    await waitFor(() => resumedSocket.events().some((event) => event.type === 'session.route_recovered'));
    expect(resumedSocket.events().map((event) => event.serverSequence)).toEqual([1, 2, 3, 4]);
    expect(first.authority.openInputs.at(-1)?.resumeNextServerSequence).toBe(2);
    resumedSocket.clientControl({ type: 'session.end', reason: 'client_handoff' });
    await resumedRun;
    expect(first.authority.snapshot?.mission.drainReason).toBe('client_handoff');
  });

  it('refuse curseur en avance et historique incomplet sans muter la mission', async () => {
    const ahead = harness();
    const createdAhead = createMistralConversationDurableSession({
      grant: ahead.grant,
      missionConnectionEpoch: 1,
    });
    ahead.authority.snapshot = createdAhead.snapshot;
    ahead.authority.outbox.push(...createdAhead.events);
    const aheadBefore = structuredClone(ahead.authority.snapshot);
    const aheadOwnerBefore = ahead.authority.ownerLeaseToken;
    const aheadRun = serveMistralConversationGatewayV2(ahead.socket, ahead.dependencies);
    authenticate(ahead.socket, 2);
    await expect(aheadRun).rejects.toMatchObject({ code: 'sequence_error' });
    expect(ahead.authority.snapshot).toEqual(aheadBefore);
    expect(ahead.authority.outbox).toEqual(createdAhead.events);
    expect(ahead.authority.ownerLeaseToken).toBe(aheadOwnerBefore);

    const missing = harness();
    const createdMissing = createMistralConversationDurableSession({
      grant: missing.grant,
      missionConnectionEpoch: 1,
    });
    missing.authority.snapshot = createdMissing.snapshot;
    missing.authority.outbox.push(...createdMissing.events);
    missing.authority.retainedFromServerSequence = 1;
    const missingBefore = structuredClone(missing.authority.snapshot);
    const missingOwnerBefore = missing.authority.ownerLeaseToken;
    const missingRun = serveMistralConversationGatewayV2(missing.socket, missing.dependencies);
    authenticate(missing.socket, 0);
    await expect(missingRun).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    expect(missing.authority.snapshot).toEqual(missingBefore);
    expect(missing.authority.outbox).toEqual(createdMissing.events);
    expect(missing.authority.ownerLeaseToken).toBe(missingOwnerBefore);
  });

  it('n’ouvre jamais un staged delivery si une annulation gagne avant completion', async () => {
    const h = harness();
    const deliveryGate = deferred<{ readonly handle: string }>();
    h.pipeline.deliveryGate = deliveryGate;
    const { run } = await connect(h);
    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    h.socket.clientBinary(audioFrame(1, 0));
    h.socket.clientControl(commitControl(CLIENT_1, 0, 1_320));
    await waitFor(() => h.pipeline.stageDelivery.mock.calls.length === 1);
    h.socket.clientControl({
      type: 'turn.cancel',
      clientTurnId: CLIENT_1,
      cancellationId: CANCEL_1,
      reason: 'user',
    });
    await waitFor(() => h.socket.events().some((event) => event.type === 'turn.cancelled'));
    deliveryGate.resolve({ handle: 'staged_delivery_late_private' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.authority.applied.some((entry) => entry.command.type === 'complete_turn')).toBe(false);
    expect(h.socket.events().some((event) => event.type === 'turn.completed')).toBe(false);
    await endSession(h, run);
  });

  it('conserve les ACK durables si la queue provider jette après le commit CAS', async () => {
    const h = harness();
    h.provider.modes.push('blocked_audio');
    const { run } = await connect(h);
    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    h.socket.clientBinary(audioFrame(1, 0));
    await waitFor(() => h.provider.connections[0]?.audio.length === 1);
    for (let sequence = 1; sequence <= 128; sequence += 1) {
      h.socket.clientBinary(audioFrame(1, sequence));
    }
    h.socket.clientControl(commitControl(CLIENT_1, 128, 10_000));
    await expect(run).rejects.toMatchObject({ code: 'backpressure' });
    const events = h.socket.events();
    expect(events.some((event) => event.type === 'turn.committed')).toBe(true);
    expect(events.some((event) => event.type === 'turn.phase' && event.phase === 'transcribing')).toBe(true);
    const sequences = events.map((event) => event.serverSequence);
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, index) => index));
  });

  it('refuse un contexte non autorisé sans ACK ni mutation durable', async () => {
    const h = harness();
    h.contextAuthorize.mockResolvedValue({ status: 'forbidden' });
    const { run } = await connect(h);
    h.socket.clientControl({ type: 'context.update', contextRevision: 2, contextDigest: DIGEST_2 });
    await waitFor(() => h.socket.events().some((event) => (
      event.type === 'error' && event.code === 'context_stale'
    )));
    expect(h.authority.applied.some((entry) => entry.command.type === 'update_context')).toBe(false);
    expect(h.socket.events().some((event) => event.type === 'session.context_updated')).toBe(false);
    await endSession(h, run);
  });

  it('classe un start au contexte périmé en context_stale', async () => {
    const h = harness();
    const { run } = await connect(h);
    h.socket.clientControl(startControl(CLIENT_1, 1_000, 2, DIGEST_2));
    await waitFor(() => h.socket.events().some((event) => (
      event.type === 'error' && event.code === 'context_stale'
    )));
    expect(h.authority.applied.some((entry) => entry.command.type === 'start_turn')).toBe(false);
    expect(h.provider.openTurn).not.toHaveBeenCalled();
    await endSession(h, run);
  });

  it('ignore la panne provider mise en file derrière une annulation gagnante', async () => {
    const h = harness();
    h.provider.modes.push('manual', 'final');
    const cancelGate = h.authority.hold('cancel_turn');
    const { run } = await connect(h);
    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    h.socket.clientBinary(audioFrame(1, 0));
    h.socket.clientControl(commitControl(CLIENT_1, 0, 1_320));
    await waitFor(() => h.provider.connections[0]?.commitAudio.mock.calls.length === 1);
    h.socket.clientControl({
      type: 'turn.cancel',
      clientTurnId: CLIENT_1,
      cancellationId: CANCEL_1,
      reason: 'user',
    });
    await waitFor(() => h.authority.attempts.some((command) => command.type === 'cancel_turn'));
    h.provider.connections[0]?.emitError();
    cancelGate.resolve();
    await waitFor(() => h.socket.events().some((event) => event.type === 'turn.cancelled'));

    await completeTurn(h, {
      clientTurnId: CLIENT_2,
      ordinal: 2,
      audioSequence: 1,
      vadStartedAtMs: 2_000,
    });
    expect(h.authority.applied.some((entry) => entry.command.type === 'fail_turn')).toBe(false);
    expect(h.socket.closes).toEqual([]);
    await endSession(h, run);
  });

  it('échoue fermé si l’owner devient stale avant l’unlock de delivery', async () => {
    const h = harness();
    h.authority.loseOwnershipAt = 'complete_turn';
    const { run } = await connect(h);
    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    h.socket.clientBinary(audioFrame(1, 0));
    h.socket.clientControl(commitControl(CLIENT_1, 0, 1_320));
    await expect(run).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    expect(h.pipeline.stageDelivery).toHaveBeenCalledTimes(1);
    expect(h.authority.applied.some((entry) => entry.command.type === 'complete_turn')).toBe(false);
    expect(h.socket.events().some((event) => event.type === 'turn.completed')).toBe(false);
    expect(h.provider.connections[0]?.signal.aborted).toBe(true);
  });

  it('revalide les droits juste avant l’unlock atomique du delivery', async () => {
    const h = harness();
    let authorizationCalls = 0;
    h.contextAuthorize.mockImplementation(async () => {
      authorizationCalls += 1;
      if (authorizationCalls >= 5) return { status: 'forbidden' as const };
      return {
        status: 'authorized' as const,
        authorizationHandle: `authorization_handle_${authorizationCalls.toString().padStart(4, '0')}`,
        plan: 'pro' as const,
      };
    });
    const { run } = await connect(h);
    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    h.socket.clientBinary(audioFrame(1, 0));
    h.socket.clientControl(commitControl(CLIENT_1, 0, 1_320));
    await waitFor(() => h.socket.events().some((event) => (
      event.type === 'error' && event.code === 'context_stale'
    )));
    expect(h.pipeline.stageDelivery).toHaveBeenCalledTimes(1);
    expect(h.authority.applied.some((entry) => entry.command.type === 'complete_turn')).toBe(false);
    expect(h.socket.events().some((event) => event.type === 'turn.completed')).toBe(false);
    await endSession(h, run);
  });

  it('borne une transition d’autorité qui ignore son signal', async () => {
    const h = harness({ operationTimeoutMs: 25 });
    h.authority.hold('start_turn');
    const { run } = await connect(h);
    h.socket.clientControl(startControl(CLIENT_1, 1_000));
    await expect(run).rejects.toMatchObject({ code: 'temporarily_unavailable' });
    expect(h.provider.openTurn).not.toHaveBeenCalled();
    expect(h.authority.applied.some((entry) => entry.command.type === 'start_turn')).toBe(false);
  });

  it('borne une étape pipeline qui ignore l’annulation', async () => {
    const h = harness({ pipelineTimeoutMs: 25 });
    h.pipeline.reasonGate = deferred<{ readonly handle: string }>();
    const { run } = await connect(h);
    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    h.socket.clientBinary(audioFrame(1, 0));
    h.socket.clientControl(commitControl(CLIENT_1, 0, 1_320));
    await waitFor(() => h.socket.events().some((event) => (
      event.type === 'error' && event.code === 'temporarily_unavailable'
    )));
    expect(h.socket.events().some((event) => event.type === 'turn.cancelled')).toBe(true);
    expect(h.socket.closes).toEqual([]);
    await endSession(h, run);
  });

  it('borne un envoi PCM provider qui ignore son signal', async () => {
    const h = harness({ operationTimeoutMs: 25 });
    h.provider.modes.push('blocked_audio');
    const { run } = await connect(h);
    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    h.socket.clientBinary(audioFrame(1, 0));
    await waitFor(() => h.socket.events().some((event) => (
      event.type === 'error' && event.code === 'temporarily_unavailable'
    )));
    expect(h.socket.events().some((event) => event.type === 'turn.cancelled')).toBe(true);
    expect(h.provider.connections[0]?.signal.aborted).toBe(true);
    await endSession(h, run);
  });

  it('démarre la deadline transcript final exactement après ACK commitAudio', async () => {
    const h = harness({ providerResponseTimeoutMs: 25 });
    h.provider.modes.push('manual');
    const { run } = await connect(h);
    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    h.socket.clientBinary(audioFrame(1, 0));
    h.socket.clientControl(commitControl(CLIENT_1, 0, 1_320));
    await waitFor(() => h.provider.connections[0]?.commitAudio.mock.calls.length === 1);
    await waitFor(() => h.socket.events().some((event) => (
      event.type === 'error' && event.code === 'temporarily_unavailable'
    )));
    expect(h.socket.events().some((event) => event.type === 'turn.cancelled')).toBe(true);
    h.provider.connections[0]?.emitFinal('final beaucoup trop tard');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.socket.events().some((event) => event.type === 'turn.transcript')).toBe(false);
    await endSession(h, run);
  });

  it('expire pendant le raisonnement via un drain durable puis annule le runtime', async () => {
    const h = harness({ grant: { hardExpiresAt: new Date(NOW + 150).toISOString() } });
    const reasonGate = deferred<{ readonly handle: string }>();
    h.pipeline.reasonGate = reasonGate;
    const { run } = await connect(h);
    await startTurn(h, {
      clientTurnId: CLIENT_1,
      ordinal: 1,
      firstAudioSequence: 0,
      vadStartedAtMs: 1_000,
    });
    h.socket.clientBinary(audioFrame(1, 0));
    h.socket.clientControl(commitControl(CLIENT_1, 0, 1_320));
    await waitFor(() => h.pipeline.reason.mock.calls.length === 1);
    await run;
    expect(h.socket.events().slice(-3).map((event) => event.type)).toEqual([
      'turn.cancelled',
      'session.draining',
      'session.closed',
    ]);
    expect(h.socket.events().at(-1)).toMatchObject({ type: 'session.closed', reason: 'expired' });
    expect(h.socket.closes[0]).toEqual({ code: 1000, reason: 'session_expired' });
    expect(h.provider.connections[0]?.signal.aborted).toBe(true);
    reasonGate.resolve({ handle: 'reasoning_after_expiry_ignored' });
  });
});

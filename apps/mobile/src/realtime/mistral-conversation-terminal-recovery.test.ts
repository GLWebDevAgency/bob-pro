import {
  MISTRAL_CONVERSATION_PROTOCOL,
  decodeMistralConversationClientControl,
  encodeMistralConversationServerEvent,
  type MistralConversationClientControl,
  type MistralConversationServerEvent,
} from '@bob/ai';
import type {
  BobClient,
  RealtimeVoiceIssuedResumeTicket,
  RealtimeVoiceResumeTicketResult,
  RealtimeVoiceTerminalCompleteReceipt,
} from '@bob/api-client';
import { ok } from '@bob/core';
import { describe, expect, it, vi } from 'vitest';

import type {
  MistralConversationCheckpointOwnerFence,
  MistralConversationCheckpointStore,
  MistralConversationTerminalCheckpoint,
} from './mistral-conversation-checkpoint-store';
import type { MistralPcmMobileSocket } from './mistral-pcm-uplink';
import { recoverMistralConversationTerminalCheckpoint } from './mistral-conversation-terminal-recovery';

const NOW = Date.parse('2026-07-19T12:00:00.000Z');
const SESSION = '00000000-0000-4000-8000-000000000101';
const COMPANY = 'company-1';
const OWNER = Object.freeze({ subjectId: 'subject-1', companyId: COMPANY });
const MISSION_EXPIRES_AT = '2026-07-19T12:01:00.000Z';
const TICKET_EXPIRES_AT = '2026-07-19T12:00:30.000Z';
const R2 = `r2_${Buffer.alloc(32, 7).toString('base64url')}`;

type TerminalClient = Pick<BobClient, 'requestRealtimeVoiceResumeTicket'>;
type SocketMessage = { readonly data: unknown };
type SocketListener = (() => void) | ((event: SocketMessage) => void);

class FakeSocket implements MistralPcmMobileSocket {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = '';
  readonly sent: Array<string | ArrayBuffer> = [];
  readonly closeCalls: Array<{ readonly code?: number; readonly reason?: string }> = [];
  private readonly listeners = new Map<string, Set<SocketListener>>();

  constructor(private readonly operations: string[]) {}

  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: SocketMessage) => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: 'error', listener: () => void): void;
  addEventListener(type: string, listener: SocketListener): void {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: 'open', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: SocketMessage) => void): void;
  removeEventListener(type: 'close', listener: () => void): void;
  removeEventListener(type: 'error', listener: () => void): void;
  removeEventListener(type: string, listener: SocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
    if (typeof data !== 'string') throw new Error('terminal_replay_must_not_send_binary');
    const control = decodeMistralConversationClientControl(data);
    this.operations.push(
      control.type === 'events.ack'
        ? `send:events.ack:${control.nextServerSequence}`
        : `send:${control.type}`,
    );
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) });
    this.readyState = 3;
    this.dispatch('close');
  }

  open(): void {
    this.readyState = 1;
    this.dispatch('open');
  }

  server(event: MistralConversationServerEvent): void {
    this.dispatch('message', { data: encodeMistralConversationServerEvent(event) });
  }

  serverClose(): void {
    this.readyState = 3;
    this.dispatch('close');
  }

  serverError(): void {
    this.dispatch('error');
  }

  private dispatch(type: string, event?: SocketMessage): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      if (event === undefined) (listener as () => void)();
      else (listener as (input: SocketMessage) => void)(event);
    }
  }
}

interface HarnessOptions {
  readonly checkpoint: MistralConversationTerminalCheckpoint | null;
  readonly results?: readonly RealtimeVoiceResumeTicketResult[];
  readonly saveError?: Error;
}

function terminalCheckpoint(
  phase: 'draining' | 'closed',
): MistralConversationTerminalCheckpoint {
  const closed = phase === 'closed';
  return {
    version: 1,
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    ...OWNER,
    sessionHandle: SESSION,
    missionExpiresAt: MISSION_EXPIRES_AT,
    stream: {
      nextServerSequence: closed ? 3 : 2,
      sessionReadyAccepted: true,
      sessionHandle: SESSION,
      missionConnectionEpoch: 1,
      ...(closed ? { closed: true } : {}),
    },
    projection: { phase, reason: 'user' },
  };
}

function issuedTicket(
  checkpoint: MistralConversationTerminalCheckpoint,
  overrides: Partial<RealtimeVoiceIssuedResumeTicket> = {},
): RealtimeVoiceIssuedResumeTicket {
  return {
    status: 'issued',
    websocketUrl: 'wss://api.bob.test/v1/voice/realtime/mistral',
    companyId: COMPANY,
    sessionHandle: checkpoint.sessionHandle,
    ticket: R2,
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    scope: 'terminal_replay',
    ticketExpiresAt: TICKET_EXPIRES_AT,
    expectedMissionConnectionEpoch: checkpoint.stream.missionConnectionEpoch,
    clientAcceptedMissionConnectionEpoch: checkpoint.stream.missionConnectionEpoch,
    resumeNextServerSequence: checkpoint.stream.nextServerSequence,
    ...overrides,
  };
}

function terminalReceipt(
  checkpoint: MistralConversationTerminalCheckpoint,
  overrides: Partial<RealtimeVoiceTerminalCompleteReceipt> = {},
): RealtimeVoiceTerminalCompleteReceipt {
  return {
    status: 'terminal_complete',
    companyId: COMPANY,
    sessionHandle: checkpoint.sessionHandle,
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    missionConnectionEpoch: checkpoint.stream.missionConnectionEpoch,
    nextServerSequence: checkpoint.projection.phase === 'closed'
      ? checkpoint.stream.nextServerSequence
      : Math.max(3, checkpoint.stream.nextServerSequence + 1),
    reason: checkpoint.projection.reason,
    closedAt: '2026-07-19T12:00:20.000Z',
    ...overrides,
  };
}

function closedEvent(
  serverSequence = 2,
): Extract<MistralConversationServerEvent, { readonly type: 'session.closed' }> {
  return { type: 'session.closed', serverSequence, reason: 'user' };
}

function duplicateDrainingEvent(): Extract<
  MistralConversationServerEvent,
  { readonly type: 'session.draining' }
> {
  return {
    type: 'session.draining',
    serverSequence: 1,
    reason: 'user',
    cancellationGeneration: 1,
  };
}

function controls(socket: FakeSocket): MistralConversationClientControl[] {
  return socket.sent
    .filter((value): value is string => typeof value === 'string')
    .map((value) => decodeMistralConversationClientControl(value));
}

function acknowledgements(
  socket: FakeSocket,
): Array<Extract<MistralConversationClientControl, { readonly type: 'events.ack' }>> {
  return controls(socket).filter(
    (control): control is Extract<
      MistralConversationClientControl,
      { readonly type: 'events.ack' }
    > => control.type === 'events.ack',
  );
}

async function eventually(predicate: () => boolean, label = 'condition_not_reached'): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(label);
}

function harness(options: HarnessOptions) {
  const operations: string[] = [];
  const sockets: FakeSocket[] = [];
  const results = [...(options.results ?? [])];
  let currentCheckpoint = options.checkpoint;

  const fence: MistralConversationCheckpointOwnerFence = Object.freeze({
    identity: OWNER,
    generation: 1,
  });
  const load = vi.fn(async () => {
    operations.push('checkpoint:load');
    return currentCheckpoint;
  });
  const save = vi.fn(async (
    _owner: MistralConversationCheckpointOwnerFence,
    state: Parameters<MistralConversationCheckpointStore['save']>[1],
  ): Promise<MistralConversationTerminalCheckpoint> => {
    operations.push(`checkpoint:save:${state.projection.phase}`);
    if (options.saveError) throw options.saveError;
    const saved: MistralConversationTerminalCheckpoint = {
      version: 1,
      protocol: MISTRAL_CONVERSATION_PROTOCOL,
      ...OWNER,
      ...state,
    };
    currentCheckpoint = saved;
    return saved;
  });
  const clearAfterTerminalComplete = vi.fn(async () => {
    operations.push('checkpoint:clear');
    currentCheckpoint = null;
  });
  const store: MistralConversationCheckpointStore = {
    activeOwnerFence: vi.fn(() => fence),
    activateOwner: vi.fn((identity) => Object.freeze({ identity, generation: 1 })),
    deactivateOwner: vi.fn(() => undefined),
    load,
    save,
    clearAfterTerminalComplete,
    retryInterruptedTerminalClear: vi.fn(async () => undefined),
    purgeForAuthBoundary: vi.fn(async () => undefined),
    scrubRequiredCheckpoint: vi.fn(async () => undefined),
  };

  const requestRealtimeVoiceResumeTicket: TerminalClient['requestRealtimeVoiceResumeTicket'] = vi.fn(
    async () => {
      const next = results.shift();
      if (next === undefined) throw new Error('unexpected_terminal_ticket_request');
      return ok(next);
    },
  );
  const client: TerminalClient = { requestRealtimeVoiceResumeTicket };
  const socketFactory = vi.fn((url: string, protocols: readonly string[]) => {
    if (url !== 'wss://api.bob.test/v1/voice/realtime/mistral') {
      throw new Error('unexpected_socket_url');
    }
    if (protocols.length !== 1 || protocols[0] !== MISTRAL_CONVERSATION_PROTOCOL) {
      throw new Error('unexpected_socket_protocol');
    }
    const socket = new FakeSocket(operations);
    sockets.push(socket);
    return socket;
  });

  return {
    operations,
    sockets,
    fence,
    load,
    save,
    clearAfterTerminalComplete,
    store,
    client,
    requestRealtimeVoiceResumeTicket: requestRealtimeVoiceResumeTicket as ReturnType<typeof vi.fn>,
    socketFactory,
  };
}

function recover(
  h: ReturnType<typeof harness>,
  overrides: Partial<Parameters<typeof recoverMistralConversationTerminalCheckpoint>[0]> = {},
): Promise<boolean> {
  return recoverMistralConversationTerminalCheckpoint({
    client: h.client,
    store: h.store,
    fence: h.fence,
    socketFactory: h.socketFactory,
    now: () => NOW,
    routeTimeoutMs: 1_000,
    ...overrides,
  });
}

function storeError(code: string): Error {
  return Object.assign(new Error(code), {
    name: 'MistralConversationCheckpointStoreError',
    code,
  });
}

async function openReplay(h: ReturnType<typeof harness>): Promise<FakeSocket> {
  await eventually(() => h.sockets.length === 1, 'terminal_socket_not_created');
  const socket = h.sockets[0]!;
  socket.open();
  await eventually(
    () => controls(socket).some((control) => control.type === 'authenticate'),
    'terminal_authentication_not_sent',
  );
  return socket;
}

describe('recoverMistralConversationTerminalCheckpoint', () => {
  it('réussit sans réseau quand aucun checkpoint n’existe', async () => {
    const h = harness({ checkpoint: null });

    await expect(recover(h)).resolves.toBe(true);

    expect(h.load).toHaveBeenCalledOnce();
    expect(h.requestRealtimeVoiceResumeTicket).not.toHaveBeenCalled();
    expect(h.socketFactory).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.clearAfterTerminalComplete).not.toHaveBeenCalled();
  });

  it('reprend une suppression terminale deja prouvee sans redemander de ticket', async () => {
    const h = harness({ checkpoint: terminalCheckpoint('closed') });
    h.load.mockRejectedValueOnce(storeError('terminal_clear_in_progress'));

    await expect(recover(h)).resolves.toBe(true);

    expect(h.store.retryInterruptedTerminalClear).toHaveBeenCalledWith(h.fence);
    expect(h.requestRealtimeVoiceResumeTicket).not.toHaveBeenCalled();
  });

  it('scrub une contamination attestee puis relit le slot avant toute reprise', async () => {
    const h = harness({ checkpoint: null });
    h.load
      .mockRejectedValueOnce(storeError('scrub_required'))
      .mockResolvedValueOnce(null);

    await expect(recover(h)).resolves.toBe(true);

    expect(h.store.scrubRequiredCheckpoint).toHaveBeenCalledOnce();
    expect(h.load).toHaveBeenCalledTimes(2);
    expect(h.requestRealtimeVoiceResumeTicket).not.toHaveBeenCalled();
  });

  it('atteste CLOSED avec le reçu HTTP exact avant de supprimer le checkpoint', async () => {
    const checkpoint = terminalCheckpoint('draining');
    const receipt = terminalReceipt(checkpoint, {
      missionConnectionEpoch: 2,
      nextServerSequence: 3,
    });
    const h = harness({ checkpoint, results: [receipt] });

    await expect(recover(h)).resolves.toBe(true);

    expect(h.requestRealtimeVoiceResumeTicket).toHaveBeenCalledWith(
      SESSION,
      { missionConnectionEpoch: 1, nextServerSequence: 2 },
      undefined,
    );
    expect(h.save).toHaveBeenCalledWith(h.fence, {
      sessionHandle: SESSION,
      missionExpiresAt: MISSION_EXPIRES_AT,
      stream: {
        sessionReadyAccepted: true,
        sessionHandle: SESSION,
        missionConnectionEpoch: 2,
        nextServerSequence: 3,
        closed: true,
      },
      projection: { phase: 'closed', reason: 'user' },
    });
    expect(h.clearAfterTerminalComplete).toHaveBeenCalledWith(h.fence, {
      kind: 'terminal_complete',
      protocol: MISTRAL_CONVERSATION_PROTOCOL,
      ...OWNER,
      sessionHandle: SESSION,
      missionConnectionEpoch: 2,
      nextServerSequence: 3,
      reason: 'user',
    });
    expect(h.operations.indexOf('checkpoint:save:closed')).toBeLessThan(
      h.operations.indexOf('checkpoint:clear'),
    );
    expect(h.socketFactory).not.toHaveBeenCalled();
  });

  it.each([
    ['tenant', { companyId: 'company-other' }],
    ['session', { sessionHandle: '00000000-0000-4000-8000-000000000202' }],
    ['protocole', { protocol: 'bob.mistral-pcm.v1' }],
    ['epoch en régression', { missionConnectionEpoch: 0 }],
    ['curseur en régression au même epoch', { nextServerSequence: 1 }],
    ['curseur pré-terminal', { nextServerSequence: 2 }],
    ['epoch avancé après CLOSED', { missionConnectionEpoch: 2, nextServerSequence: 4 }],
    ['curseur avancé après CLOSED', { nextServerSequence: 4 }],
    ['raison différente', { reason: 'expired' }],
    ['timestamp non canonique', { closedAt: '2026-07-19T12:00:20Z' }],
  ] as const)('conserve le checkpoint quand le reçu terminal a un %s invalide', async (_label, patch) => {
    const checkpoint = terminalCheckpoint('closed');
    const h = harness({
      checkpoint,
      results: [terminalReceipt(
        checkpoint,
        patch as unknown as Partial<RealtimeVoiceTerminalCompleteReceipt>,
      )],
    });

    await expect(recover(h)).resolves.toBe(false);

    expect(h.save).not.toHaveBeenCalled();
    expect(h.clearAfterTerminalComplete).not.toHaveBeenCalled();
    expect(h.socketFactory).not.toHaveBeenCalled();
  });

  it.each([
    [
      'curseur global en régression malgré un epoch avancé',
      { missionConnectionEpoch: 2, nextServerSequence: 1 },
    ],
    [
      'curseur non avancé lors d’un nouvel epoch',
      { missionConnectionEpoch: 2, nextServerSequence: 2 },
    ],
    [
      'transition draining vers closed sans nouvel événement',
      { missionConnectionEpoch: 1, nextServerSequence: 2 },
    ],
  ] as const)('refuse un reçu %s', async (_label, patch) => {
    const checkpoint = terminalCheckpoint('draining');
    const h = harness({ checkpoint, results: [terminalReceipt(checkpoint, patch)] });

    await expect(recover(h)).resolves.toBe(false);

    expect(h.save).not.toHaveBeenCalled();
    expect(h.clearAfterTerminalComplete).not.toHaveBeenCalled();
  });

  it('ne clear jamais quand la persistance du reçu terminal échoue', async () => {
    const checkpoint = terminalCheckpoint('closed');
    const h = harness({
      checkpoint,
      results: [terminalReceipt(checkpoint)],
      saveError: new Error('secure_store_unavailable'),
    });

    await expect(recover(h)).rejects.toThrow('secure_store_unavailable');

    expect(h.save).toHaveBeenCalledOnce();
    expect(h.clearAfterTerminalComplete).not.toHaveBeenCalled();
  });

  it('rejoue un checkpoint draining, sauvegarde closed avant l’ACK avancé puis clear', async () => {
    const checkpoint = terminalCheckpoint('draining');
    const h = harness({
      checkpoint,
      results: [issuedTicket(checkpoint), terminalReceipt(checkpoint)],
    });
    const pending = recover(h);
    const socket = await openReplay(h);

    expect(controls(socket)).toEqual([
      {
        type: 'authenticate',
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        companyId: COMPANY,
        ticket: R2,
        resumeScope: 'terminal_replay',
        resumeNextServerSequence: 2,
      },
      { type: 'events.ack', missionConnectionEpoch: 1, nextServerSequence: 2 },
    ]);
    socket.server(closedEvent());
    await eventually(() => acknowledgements(socket).some((ack) => ack.nextServerSequence === 3));
    expect(h.operations.indexOf('checkpoint:save:closed')).toBeLessThan(
      h.operations.indexOf('send:events.ack:3'),
    );
    socket.serverClose();

    await expect(pending).resolves.toBe(true);
    expect(h.save).toHaveBeenCalledWith(
      h.fence,
      expect.objectContaining({
        sessionHandle: SESSION,
        projection: { phase: 'closed', reason: 'user' },
        stream: expect.objectContaining({ nextServerSequence: 3, closed: true }),
      }),
    );
    expect(h.requestRealtimeVoiceResumeTicket.mock.calls.map((call) => call[1])).toEqual([
      { missionConnectionEpoch: 1, nextServerSequence: 2 },
      { missionConnectionEpoch: 1, nextServerSequence: 3 },
    ]);
    expect(h.clearAfterTerminalComplete).toHaveBeenCalledOnce();
  });

  it('ACKe immédiatement un checkpoint déjà closed quand le replay est vide', async () => {
    const checkpoint = terminalCheckpoint('closed');
    const h = harness({
      checkpoint,
      results: [issuedTicket(checkpoint), terminalReceipt(checkpoint)],
    });
    const pending = recover(h);
    const socket = await openReplay(h);

    expect(controls(socket)).toEqual([
      {
        type: 'authenticate',
        protocol: MISTRAL_CONVERSATION_PROTOCOL,
        companyId: COMPANY,
        ticket: R2,
        resumeScope: 'terminal_replay',
        resumeNextServerSequence: 3,
      },
      { type: 'events.ack', missionConnectionEpoch: 1, nextServerSequence: 3 },
    ]);
    expect(h.save).not.toHaveBeenCalled();
    socket.serverClose();

    await expect(pending).resolves.toBe(true);
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.clearAfterTerminalComplete).toHaveBeenCalledOnce();
  });

  it('ré-ACKe un doublon sans le sauvegarder ni avancer le curseur', async () => {
    const checkpoint = terminalCheckpoint('draining');
    const h = harness({
      checkpoint,
      results: [issuedTicket(checkpoint), terminalReceipt(checkpoint)],
    });
    const pending = recover(h);
    const socket = await openReplay(h);

    socket.server(duplicateDrainingEvent());
    await eventually(() => acknowledgements(socket).length === 2, 'duplicate_not_reacknowledged');
    expect(acknowledgements(socket)).toEqual([
      { type: 'events.ack', missionConnectionEpoch: 1, nextServerSequence: 2 },
      { type: 'events.ack', missionConnectionEpoch: 1, nextServerSequence: 2 },
    ]);
    expect(h.save).not.toHaveBeenCalled();
    socket.serverClose();

    await expect(pending).resolves.toBe(true);
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.clearAfterTerminalComplete).toHaveBeenCalledOnce();
  });

  it('propage l’échec de save sans ACKer le curseur avancé', async () => {
    const checkpoint = terminalCheckpoint('draining');
    const h = harness({
      checkpoint,
      results: [issuedTicket(checkpoint)],
      saveError: new Error('secure_store_unavailable'),
    });
    const pending = recover(h);
    const failed = expect(pending).rejects.toThrow('secure_store_unavailable');
    const socket = await openReplay(h);

    socket.server(closedEvent());
    await failed;

    expect(h.save).toHaveBeenCalledOnce();
    expect(acknowledgements(socket)).toEqual([
      { type: 'events.ack', missionConnectionEpoch: 1, nextServerSequence: 2 },
    ]);
    expect(h.clearAfterTerminalComplete).not.toHaveBeenCalled();
  });

  it.each([
    ['tenant', { companyId: 'company-other' }],
    ['cursor', { resumeNextServerSequence: 3 }],
    ['epoch serveur', { expectedMissionConnectionEpoch: 2 }],
  ] as const)('fail-close un ticket dont le %s ne correspond pas au checkpoint', async (_case, patch) => {
    const checkpoint = terminalCheckpoint('draining');
    const h = harness({ checkpoint });

    await expect(recover(h, { initialTicket: issuedTicket(checkpoint, patch) })).resolves.toBe(false);

    expect(h.requestRealtimeVoiceResumeTicket).not.toHaveBeenCalled();
    expect(h.socketFactory).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.clearAfterTerminalComplete).not.toHaveBeenCalled();
  });

  it('retourne false sur abort préalable sans même lire le checkpoint', async () => {
    const checkpoint = terminalCheckpoint('draining');
    const h = harness({ checkpoint });
    const controller = new AbortController();
    controller.abort();

    await expect(recover(h, { signal: controller.signal })).resolves.toBe(false);

    expect(h.load).not.toHaveBeenCalled();
    expect(h.requestRealtimeVoiceResumeTicket).not.toHaveBeenCalled();
    expect(h.socketFactory).not.toHaveBeenCalled();
  });

  it('propage un abort pendant le replay et ferme la capability', async () => {
    const checkpoint = terminalCheckpoint('draining');
    const h = harness({ checkpoint, results: [issuedTicket(checkpoint)] });
    const controller = new AbortController();
    const pending = recover(h, { signal: controller.signal });
    const failed = expect(pending).rejects.toThrow('aborted');
    const socket = await openReplay(h);

    controller.abort();
    await failed;

    expect(socket.closeCalls).toContainEqual({ code: 1000, reason: 'terminal_replay_complete' });
    expect(h.save).not.toHaveBeenCalled();
    expect(h.clearAfterTerminalComplete).not.toHaveBeenCalled();
  });

  it('propage le timeout borné et ferme une socket qui ne s’ouvre pas', async () => {
    vi.useFakeTimers();
    try {
      const checkpoint = terminalCheckpoint('draining');
      const h = harness({ checkpoint, results: [issuedTicket(checkpoint)] });
      const pending = recover(h);
      const failed = expect(pending).rejects.toThrow('terminal_replay_timeout');
      await eventually(() => h.sockets.length === 1, 'timeout_socket_not_created');

      await vi.advanceTimersByTimeAsync(1_000);
      await failed;

      expect(h.sockets[0]?.closeCalls).toContainEqual({
        code: 1000,
        reason: 'terminal_replay_complete',
      });
      expect(h.save).not.toHaveBeenCalled();
      expect(h.clearAfterTerminalComplete).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('borne aussi une sauvegarde SecureStore suspendue après la fermeture de la socket', async () => {
    vi.useFakeTimers();
    try {
      const checkpoint = terminalCheckpoint('draining');
      const h = harness({ checkpoint, results: [issuedTicket(checkpoint)] });
      h.save.mockImplementation(async () => new Promise<never>(() => undefined));
      const pending = recover(h);
      const failed = expect(pending).rejects.toThrow('terminal_replay_timeout');
      const socket = await openReplay(h);

      socket.server(closedEvent());
      await eventually(() => h.save.mock.calls.length === 1, 'checkpoint_save_not_started');
      socket.serverClose();
      await vi.advanceTimersByTimeAsync(1_000);
      await failed;

      expect(acknowledgements(socket)).toEqual([
        { type: 'events.ack', missionConnectionEpoch: 1, nextServerSequence: 2 },
      ]);
      expect(h.clearAfterTerminalComplete).not.toHaveBeenCalled();
      expect(socket.closeCalls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('interrompt immédiatement une sauvegarde suspendue même après close', async () => {
    const checkpoint = terminalCheckpoint('draining');
    const h = harness({ checkpoint, results: [issuedTicket(checkpoint)] });
    h.save.mockImplementation(async () => new Promise<never>(() => undefined));
    const controller = new AbortController();
    const pending = recover(h, { signal: controller.signal });
    const failed = expect(pending).rejects.toThrow('aborted');
    const socket = await openReplay(h);

    socket.server(closedEvent());
    await eventually(() => h.save.mock.calls.length === 1, 'checkpoint_save_not_started');
    socket.serverClose();
    controller.abort();
    await failed;

    expect(acknowledgements(socket)).toEqual([
      { type: 'events.ack', missionConnectionEpoch: 1, nextServerSequence: 2 },
    ]);
    expect(h.clearAfterTerminalComplete).not.toHaveBeenCalled();
  });
});

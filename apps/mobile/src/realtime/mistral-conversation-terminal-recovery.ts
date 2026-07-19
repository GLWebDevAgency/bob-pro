import {
  MISTRAL_CONVERSATION_PROTOCOL,
  encodeMistralConversationClientControl,
  type MistralConversationClientControl,
  type MistralConversationServerEvent,
} from '@bob/ai';
import type {
  BobClient,
  RealtimeVoiceIssuedResumeTicket,
  RealtimeVoiceTerminalCompleteReceipt,
} from '@bob/api-client';

import type {
  MistralConversationCheckpointOwnerFence,
  MistralConversationCheckpointStore,
  MistralConversationTerminalCheckpoint,
  MistralConversationTerminalProjection,
} from './mistral-conversation-checkpoint-store';
import { MistralConversationServerEventStream } from './mistral-conversation-event-stream';
import type {
  MistralPcmMobileSocket,
  MistralPcmMobileSocketFactory,
} from './mistral-pcm-uplink';

const DEFAULT_ROUTE_TIMEOUT_MS = 8_000;
const MIN_ROUTE_TIMEOUT_MS = 1_000;
const MAX_ROUTE_TIMEOUT_MS = 30_000;
const MAX_RECOVERY_ROUTES = 8;
const MAX_SOCKET_BUFFERED_BYTES = 256 * 1024;
const MAX_MISSION_CONNECTION_EPOCH = 0x7fff_ffff;
const MAX_SERVER_SEQUENCE_CURSOR = 0x1_0000_0000;
const SESSION_END_REASONS = new Set([
  'user',
  'background',
  'context_changed',
  'client_handoff',
  'expired',
  'service_shutdown',
  'fatal_error',
]);
const TERMINAL_RECEIPT_FIELDS = [
  'status',
  'companyId',
  'sessionHandle',
  'protocol',
  'missionConnectionEpoch',
  'nextServerSequence',
  'reason',
  'closedAt',
] as const;

type TerminalRecoveryClient = Pick<BobClient, 'requestRealtimeVoiceResumeTicket'>;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function opaqueError(code: string): Error {
  return Object.assign(new Error(code), {
    name: 'MistralConversationTerminalRecoveryError',
  });
}

function checkpointStoreErrorCode(error: unknown): string | null {
  if (
    !(error instanceof Error)
    || error.name !== 'MistralConversationCheckpointStoreError'
    || !('code' in error)
    || typeof error.code !== 'string'
  ) return null;
  return error.code;
}

function defaultSocketFactory(url: string, protocols: readonly string[]): MistralPcmMobileSocket {
  const Constructor = globalThis.WebSocket;
  if (typeof Constructor !== 'function') throw opaqueError('websocket_unavailable');
  return new Constructor(url, [...protocols]) as unknown as MistralPcmMobileSocket;
}

function routeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ROUTE_TIMEOUT_MS;
  return Number.isSafeInteger(value) && value >= MIN_ROUTE_TIMEOUT_MS && value <= MAX_ROUTE_TIMEOUT_MS
    ? value
    : -1;
}

function canonicalFutureTimestamp(value: string, now: number): boolean {
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value && epoch > now;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && value as number >= min && value as number <= max;
}

function exactTerminalReceiptShape(value: object): boolean {
  const keys = Object.keys(value);
  return keys.length === TERMINAL_RECEIPT_FIELDS.length
    && keys.every((key) => TERMINAL_RECEIPT_FIELDS.includes(
      key as (typeof TERMINAL_RECEIPT_FIELDS)[number],
    ));
}

function terminalReceiptMatchesCheckpoint(
  receipt: RealtimeVoiceTerminalCompleteReceipt,
  checkpoint: MistralConversationTerminalCheckpoint,
  fence: MistralConversationCheckpointOwnerFence,
): boolean {
  const localEpoch = checkpoint.stream.missionConnectionEpoch;
  const localCursor = checkpoint.stream.nextServerSequence;
  const checkpointClosed = checkpoint.projection.phase === 'closed';
  return exactTerminalReceiptShape(receipt)
    && receipt.status === 'terminal_complete'
    && receipt.protocol === MISTRAL_CONVERSATION_PROTOCOL
    && receipt.companyId === fence.identity.companyId
    && checkpoint.companyId === fence.identity.companyId
    && checkpoint.subjectId === fence.identity.subjectId
    && receipt.sessionHandle === checkpoint.sessionHandle
    && checkpoint.stream.sessionHandle === checkpoint.sessionHandle
    && boundedInteger(receipt.missionConnectionEpoch, 1, MAX_MISSION_CONNECTION_EPOCH)
    && receipt.missionConnectionEpoch >= localEpoch
    && boundedInteger(receipt.nextServerSequence, 3, MAX_SERVER_SEQUENCE_CURSOR)
    && receipt.nextServerSequence >= localCursor
    && (receipt.missionConnectionEpoch === localEpoch || receipt.nextServerSequence > localCursor)
    && checkpointClosed === (checkpoint.stream.closed === true)
    && (checkpointClosed
      ? receipt.missionConnectionEpoch === localEpoch && receipt.nextServerSequence === localCursor
      : receipt.nextServerSequence > localCursor)
    && SESSION_END_REASONS.has(receipt.reason)
    && receipt.reason === checkpoint.projection.reason
    && canonicalTimestamp(receipt.closedAt);
}

function ticketMatches(
  ticket: RealtimeVoiceIssuedResumeTicket,
  checkpoint: MistralConversationTerminalCheckpoint,
  fence: MistralConversationCheckpointOwnerFence,
  now: number,
): boolean {
  return ticket.status === 'issued'
    && ticket.protocol === MISTRAL_CONVERSATION_PROTOCOL
    && ticket.scope === 'terminal_replay'
    && ticket.companyId === fence.identity.companyId
    && ticket.sessionHandle === checkpoint.sessionHandle
    && ticket.clientAcceptedMissionConnectionEpoch === checkpoint.stream.missionConnectionEpoch
    && ticket.resumeNextServerSequence === checkpoint.stream.nextServerSequence
    && ticket.expectedMissionConnectionEpoch === checkpoint.stream.missionConnectionEpoch
    && canonicalFutureTimestamp(ticket.ticketExpiresAt, now);
}

function projectionAfter(
  current: MistralConversationTerminalProjection,
  event: MistralConversationServerEvent,
): MistralConversationTerminalProjection {
  if (event.type === 'session.draining') {
    return { phase: 'draining', reason: event.reason };
  }
  if (event.type === 'session.closed') {
    return { phase: 'closed', reason: event.reason };
  }
  return current;
}

export interface MistralConversationTerminalRecoveryOptions {
  readonly client: TerminalRecoveryClient;
  readonly store: MistralConversationCheckpointStore;
  readonly fence: MistralConversationCheckpointOwnerFence;
  readonly socketFactory?: MistralPcmMobileSocketFactory;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly routeTimeoutMs?: number;
  /** Ticket déjà émis par la tentative de confirmation inline ; jamais persisté. */
  readonly initialTicket?: RealtimeVoiceIssuedResumeTicket;
}

/**
 * Transforme le reçu HTTP terminal en checkpoint CLOSED durable avant d'effacer le coffre.
 *
 * La revalidation locale protège aussi les implémentations alternatives de `BobClient` : aucune
 * donnée typée ou injectée en test ne peut contourner le lien owner/session ni faire régresser la
 * preuve. Le `missionExpiresAt` demeure celui de la mission locale, jamais celui du réseau.
 */
export async function applyMistralConversationTerminalCompleteReceipt(input: {
  readonly receipt: RealtimeVoiceTerminalCompleteReceipt;
  readonly checkpoint: MistralConversationTerminalCheckpoint;
  readonly store: MistralConversationCheckpointStore;
  readonly fence: MistralConversationCheckpointOwnerFence;
}): Promise<boolean> {
  if (!terminalReceiptMatchesCheckpoint(input.receipt, input.checkpoint, input.fence)) return false;

  const saved = await input.store.save(input.fence, {
    sessionHandle: input.checkpoint.sessionHandle,
    missionExpiresAt: input.checkpoint.missionExpiresAt,
    stream: {
      sessionReadyAccepted: true,
      sessionHandle: input.checkpoint.sessionHandle,
      missionConnectionEpoch: input.receipt.missionConnectionEpoch,
      nextServerSequence: input.receipt.nextServerSequence,
      closed: true,
    },
    projection: { phase: 'closed', reason: input.receipt.reason },
  });
  await input.store.clearAfterTerminalComplete(input.fence, {
    kind: 'terminal_complete',
    protocol: MISTRAL_CONVERSATION_PROTOCOL,
    subjectId: input.fence.identity.subjectId,
    companyId: input.fence.identity.companyId,
    sessionHandle: saved.sessionHandle,
    missionConnectionEpoch: saved.stream.missionConnectionEpoch,
    nextServerSequence: saved.stream.nextServerSequence,
    reason: saved.projection.reason,
  });
  return true;
}

/**
 * Draine le checkpoint terminal owner-bound avant toute nouvelle mission.
 *
 * Chaque événement est écrit et relu par le coffre AVANT son ACK. Une capability r2 ne vit que
 * dans la pile de cet appel. Le seul chemin de suppression est la preuve HTTP exacte
 * `terminal_complete`; toute panne laisse donc le checkpoint récupérable au prochain passage.
 */
export async function recoverMistralConversationTerminalCheckpoint(
  options: MistralConversationTerminalRecoveryOptions,
): Promise<boolean> {
  const timeoutMs = routeTimeout(options.routeTimeoutMs);
  if (timeoutMs < 0 || options.signal?.aborted) return false;
  let checkpoint: MistralConversationTerminalCheckpoint | null;
  try {
    checkpoint = await options.store.load(options.fence);
  } catch (error) {
    const storeErrorCode = checkpointStoreErrorCode(error);
    if (storeErrorCode === 'terminal_clear_in_progress') {
      await options.store.retryInterruptedTerminalClear(options.fence);
      return true;
    }
    if (storeErrorCode === 'scrub_required') {
      // Seules les quarantaines contamination/corruption acceptent ce scrub. Les verrous
      // terminal/auth repondent avec leur propre code et ne peuvent donc jamais etre contournes.
      await options.store.scrubRequiredCheckpoint();
      checkpoint = await options.store.load(options.fence);
    } else {
      throw error;
    }
  }
  if (checkpoint === null) return true;
  let issued = options.initialTicket ?? null;

  for (let route = 0; route < MAX_RECOVERY_ROUTES; route += 1) {
    if (options.signal?.aborted) return false;
    if (issued === null) {
      const result = await options.client.requestRealtimeVoiceResumeTicket(
        checkpoint.sessionHandle,
        {
          missionConnectionEpoch: checkpoint.stream.missionConnectionEpoch,
          nextServerSequence: checkpoint.stream.nextServerSequence,
        },
        options.signal,
      );
      if (!result.ok) return false;
      if (result.value.status === 'terminal_complete') {
        return applyMistralConversationTerminalCompleteReceipt({
          receipt: result.value,
          checkpoint,
          store: options.store,
          fence: options.fence,
        });
      }
      issued = result.value;
    }

    if (!ticketMatches(
      issued,
      checkpoint,
      options.fence,
      (options.now ?? Date.now)(),
    )) return false;
    checkpoint = await replayTerminalTicket({
      store: options.store,
      fence: options.fence,
      socketFactory: options.socketFactory,
      signal: options.signal,
      checkpoint,
      ticket: issued,
      timeoutMs,
    });
    issued = null;
  }
  return false;
}

async function replayTerminalTicket(input: {
  readonly store: MistralConversationCheckpointStore;
  readonly fence: MistralConversationCheckpointOwnerFence;
  readonly checkpoint: MistralConversationTerminalCheckpoint;
  readonly ticket: RealtimeVoiceIssuedResumeTicket;
  readonly socketFactory?: MistralPcmMobileSocketFactory;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}): Promise<MistralConversationTerminalCheckpoint> {
  const socket = (input.socketFactory ?? defaultSocketFactory)(
    input.ticket.websocketUrl,
    [MISTRAL_CONVERSATION_PROTOCOL],
  );
  socket.binaryType = 'arraybuffer';
  const opened = deferred<void>();
  const finished = deferred<void>();
  const deadline = deferred<never>();
  const cancelled = deferred<never>();
  let checkpoint = input.checkpoint;
  let stream = new MistralConversationServerEventStream(checkpoint.stream);
  let eventTail = Promise.resolve();
  let settled = false;

  const finish = (error?: Error): void => {
    if (settled) return;
    settled = true;
    if (error) finished.reject(error);
    else finished.resolve(undefined);
  };
  const send = (control: MistralConversationClientControl): boolean => {
    if (socket.readyState !== 1) return false;
    const encoded = encodeMistralConversationClientControl(control);
    const bytes = new TextEncoder().encode(encoded).byteLength;
    if (socket.bufferedAmount + bytes > MAX_SOCKET_BUFFERED_BYTES) return false;
    try {
      socket.send(encoded);
      return true;
    } catch {
      return false;
    }
  };
  const acknowledgeStableCursor = (): void => {
    const acknowledgement = stream.acknowledgement();
    if (acknowledgement !== null && !send(acknowledgement)) {
      throw opaqueError('ack_send_failed');
    }
  };

  const onOpen = (): void => opened.resolve(undefined);
  const onClose = (): void => finish();
  const onError = (): void => finish(opaqueError('socket_unavailable'));
  const onMessage = (event: { readonly data: unknown }): void => {
    eventTail = eventTail.then(async () => {
      const candidate = new MistralConversationServerEventStream(stream.snapshot() ?? undefined);
      const accepted = candidate.accept(event.data);
      if (accepted.kind === 'duplicate') {
        acknowledgeStableCursor();
        return;
      }
      const nextProjection = projectionAfter(checkpoint.projection, accepted.event);
      const snapshot = candidate.snapshot();
      if (snapshot === null) throw opaqueError('terminal_snapshot_missing');
      const saved = await input.store.save(input.fence, {
        sessionHandle: checkpoint.sessionHandle,
        missionExpiresAt: checkpoint.missionExpiresAt,
        stream: snapshot,
        projection: nextProjection,
      });
      stream = candidate;
      checkpoint = saved;
      acknowledgeStableCursor();
    });
    void eventTail.catch((error: unknown) => {
      finish(error instanceof Error ? error : opaqueError('terminal_replay_failed'));
    });
  };
  socket.addEventListener('open', onOpen);
  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', onClose);
  socket.addEventListener('error', onError);

  const timer = setTimeout(() => {
    const error = opaqueError('terminal_replay_timeout');
    // Le deadline reste independant de `finished` : un close peut avoir termine la socket alors
    // qu'une sauvegarde SecureStore declenchee juste avant est encore suspendue. Sans cette
    // seconde promesse, `settled=true` neutralisait le timer et bloquait toute la frontiere auth.
    deadline.reject(error);
    finish(error);
  }, input.timeoutMs);
  const withinRouteBoundary = <T,>(promise: Promise<T>): Promise<T> => (
    Promise.race([promise, deadline.promise, cancelled.promise])
  );
  const onAbort = (): void => {
    const error = opaqueError('aborted');
    // Comme le deadline, l'abort reste autoritaire meme si `close` a deja settle `finished`.
    cancelled.reject(error);
    finish(error);
  };
  if (input.signal?.aborted) onAbort();
  else input.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await withinRouteBoundary(Promise.race([opened.promise, finished.promise]));
    if (socket.readyState !== 1) throw opaqueError('socket_unavailable');
    let ticket = input.ticket.ticket;
    const authentication: Extract<
      MistralConversationClientControl,
      { readonly type: 'authenticate' }
    > = {
      type: 'authenticate',
      protocol: MISTRAL_CONVERSATION_PROTOCOL,
      companyId: input.ticket.companyId,
      ticket,
      resumeScope: 'terminal_replay',
      resumeNextServerSequence: checkpoint.stream.nextServerSequence,
    };
    if (!send(authentication)) throw opaqueError('authenticate_send_failed');
    ticket = '';
    // Si le checkpoint est déjà au curseur final, le replay peut être vide. Cet ACK immédiat
    // permet au serveur de consommer sa capability terminale sans inventer un nouvel événement.
    acknowledgeStableCursor();
    await withinRouteBoundary(finished.promise);
    // `close` ne prouve pas que la projection locale est durable. Le meme deadline couvre donc
    // aussi la queue de sauvegarde/ACK, y compris quand la socket s'est fermee entre les deux.
    await withinRouteBoundary(eventTail);
    return checkpoint;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
    socket.removeEventListener('open', onOpen);
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('close', onClose);
    socket.removeEventListener('error', onError);
    if (socket.readyState !== 3) {
      try {
        socket.close(1000, 'terminal_replay_complete');
      } catch {
        // Route déjà détruite ; le checkpoint demeure l'unique vérité locale.
      }
    }
  }
}

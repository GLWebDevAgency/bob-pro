import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeMistralPcmGatewayFrame,
  encodeMistralPcmGatewayFrame,
  MISTRAL_PCM_GATEWAY_PROTOCOL,
  MistralRealtimeGatewayError,
  serveMistralRealtimeGateway,
  type MistralRealtimeGatewayDependencies,
  type MistralRealtimeGatewayProviderConnection,
  type MistralRealtimeGatewaySocket,
  type MistralRealtimeIngressGrant,
  type MistralRealtimeIngressTicketAuthority,
} from './mistral-realtime-gateway';
import type { MistralRealtimeTranscriptionEvent } from './mistral-realtime-transcription';
import { MistralRealtimeTerminationAuthority } from './mistral-realtime-termination';

const NOW = 1_000_000;
const TICKET = 'A'.repeat(43);
const GRANT: MistralRealtimeIngressGrant = {
  redemptionId: '10000000-0000-4000-8000-000000000001',
  companyId: 'company-1',
  userId: 'user-1',
  subjectHash: 'b'.repeat(64),
  subjectKeyVersion: 3,
  plan: 'pro',
  sessionId: '20000000-0000-4000-8000-000000000002',
  contextRevision: 7,
  contextDigest: 'a'.repeat(64),
  hardExpiresAt: new Date(NOW + 60_000).toISOString(),
  maxAudioBytes: 64_000,
};

class FakeGatewaySocket extends EventEmitter implements MistralRealtimeGatewaySocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  terminated = false;

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
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

  clientText(payload: unknown): void {
    this.emit('message', JSON.stringify(payload), false);
  }

  clientBinary(payload: Uint8Array): void {
    this.emit('message', payload, true);
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeProviderConnection implements MistralRealtimeGatewayProviderConnection {
  readonly providerSessionId = 'mistral-session-1';
  readonly audio: Uint8Array[] = [];
  readonly flushAudio = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  private readonly ended = deferred();

  async sendAudio(pcm: Uint8Array): Promise<void> {
    this.audio.push(Uint8Array.from(pcm));
  }

  async endAudio(): Promise<void> {
    this.ended.resolve();
  }

  async *events(): AsyncIterable<MistralRealtimeTranscriptionEvent> {
    await this.ended.promise;
    yield { type: 'transcript_delta', text: 'Bon' };
    yield {
      type: 'transcript_segment',
      text: 'Bonjour',
      startSeconds: 0,
      endSeconds: 0.8,
      speakerId: null,
    };
    yield {
      type: 'transcript_final',
      text: 'Bonjour',
      language: 'fr',
      usage: { inputAudioSeconds: 1, totalTokens: 3 },
    };
  }
}

function authority(result: Awaited<ReturnType<MistralRealtimeIngressTicketAuthority['consume']>> = {
  ok: true,
  grant: GRANT,
}): MistralRealtimeIngressTicketAuthority & {
  issue: ReturnType<typeof vi.fn>;
  consume: ReturnType<typeof vi.fn>;
  bindAndActivate: ReturnType<typeof vi.fn>;
  abandon: ReturnType<typeof vi.fn>;
  complete: ReturnType<typeof vi.fn>;
} {
  return {
    issue: vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const })),
    consume: vi.fn(async () => result),
    bindAndActivate: vi.fn(async () => ({ ok: true as const })),
    abandon: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
  };
}

function harness(input: {
  tickets?: ReturnType<typeof authority>;
  connection?: FakeProviderConnection;
  maxAudioBytes?: number;
} = {}): {
  socket: FakeGatewaySocket;
  connection: FakeProviderConnection;
  tickets: ReturnType<typeof authority>;
  dependencies: MistralRealtimeGatewayDependencies;
  sink: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  terminations: MistralRealtimeTerminationAuthority;
} {
  const socket = new FakeGatewaySocket();
  const connection = input.connection ?? new FakeProviderConnection();
  const tickets = input.tickets ?? authority(input.maxAudioBytes === undefined
    ? { ok: true, grant: GRANT }
    : { ok: true, grant: { ...GRANT, maxAudioBytes: input.maxAudioBytes } });
  const sink = vi.fn(async () => undefined);
  const connect = vi.fn(async () => connection);
  const terminations = new MistralRealtimeTerminationAuthority(() => NOW);
  return {
    socket,
    connection,
    tickets,
    sink,
    connect,
    terminations,
    dependencies: {
      tickets,
      provider: { connect },
      terminations,
      sink: { publish: sink },
      now: () => NOW,
      authTimeoutMs: 1_000,
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition_not_reached');
}

function authenticate(socket: FakeGatewaySocket): void {
  socket.clientText({
    type: 'authenticate',
    protocol: MISTRAL_PCM_GATEWAY_PROTOCOL,
    companyId: GRANT.companyId,
    ticket: TICKET,
  });
}

describe('Mistral PCM gateway — ingress API sans clé côté mobile', () => {
  it('encode un framing binaire canonique et refuse les variantes ambiguës', () => {
    const encoded = encodeMistralPcmGatewayFrame({
      kind: 'audio',
      sequence: 0x0102_0304,
      pcm: Uint8Array.of(1, 0, 2, 0),
    });
    expect(Buffer.from(encoded).toString('hex')).toBe('424f423101010000010203040000000401000200');
    expect(decodeMistralPcmGatewayFrame(encoded)).toEqual({
      kind: 'audio',
      sequence: 0x0102_0304,
      pcm: Uint8Array.of(1, 0, 2, 0),
    });
    const forged = Uint8Array.from(encoded);
    forged[6] = 1;
    expect(() => decodeMistralPcmGatewayFrame(forged)).toThrowError(MistralRealtimeGatewayError);
    expect(() => encodeMistralPcmGatewayFrame({
      kind: 'audio',
      sequence: 0,
      pcm: Uint8Array.of(1),
    })).toThrowError(MistralRealtimeGatewayError);
  });

  it('consomme le ticket une fois, active le provider puis ne renvoie que du texte normalisé', async () => {
    const h = harness();
    const run = serveMistralRealtimeGateway(h.socket, h.dependencies);
    authenticate(h.socket);
    await waitFor(() => h.socket.sent.some((raw) => JSON.parse(raw).type === 'ready'));
    expect(h.terminations.state().activeConnections).toBe(1);

    h.socket.clientBinary(encodeMistralPcmGatewayFrame({
      kind: 'audio',
      sequence: 0,
      pcm: Uint8Array.of(1, 0, 2, 0),
    }));
    h.socket.clientBinary(encodeMistralPcmGatewayFrame({ kind: 'flush', sequence: 1 }));
    h.socket.clientBinary(encodeMistralPcmGatewayFrame({ kind: 'end', sequence: 2 }));
    await run;
    expect(h.terminations.state().activeConnections).toBe(0);

    expect(h.tickets.consume).toHaveBeenCalledWith({
      companyId: GRANT.companyId,
      ticket: TICKET,
      protocol: MISTRAL_PCM_GATEWAY_PROTOCOL,
    });
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(Object.keys(h.connect.mock.calls[0]?.[0] ?? {}).sort()).toEqual(['maxSessionSeconds', 'signal']);
    expect(h.tickets.bindAndActivate).toHaveBeenCalledWith({
      companyId: GRANT.companyId,
      redemptionId: GRANT.redemptionId,
      providerId: 'mistral',
      providerSessionId: 'mistral-session-1',
      contextRevision: 7,
      contextDigest: 'a'.repeat(64),
    });
    expect(h.connection.audio).toEqual([Uint8Array.of(1, 0, 2, 0)]);
    expect(h.connection.flushAudio).toHaveBeenCalledTimes(1);
    expect(h.sink).toHaveBeenCalledTimes(3);
    for (const [published] of h.sink.mock.calls) {
      expect(published).toEqual(expect.objectContaining({
        redemptionId: GRANT.redemptionId,
        companyId: GRANT.companyId,
        userId: GRANT.userId,
        subjectHash: GRANT.subjectHash,
        subjectKeyVersion: GRANT.subjectKeyVersion,
        plan: GRANT.plan,
        sessionId: GRANT.sessionId,
        contextRevision: GRANT.contextRevision,
        contextDigest: GRANT.contextDigest,
        signal: expect.any(AbortSignal),
      }));
    }
    expect(h.sink.mock.calls[0]?.[0]).not.toHaveProperty('occurredAt');
    expect(h.sink.mock.calls[1]?.[0]).not.toHaveProperty('occurredAt');
    expect(h.sink.mock.calls[2]?.[0]).toEqual(expect.objectContaining({
      occurredAt: new Date(NOW).toISOString(),
    }));
    expect(h.tickets.complete).toHaveBeenCalledWith({
      companyId: GRANT.companyId,
      redemptionId: GRANT.redemptionId,
      providerSessionId: 'mistral-session-1',
      providerTermination: 'confirmed',
    });
    const outbound = h.socket.sent.map((raw) => JSON.parse(raw) as { type: string; [key: string]: unknown });
    expect(outbound.map((event) => event.type)).toEqual([
      'ready',
      'transcript.delta',
      'transcript.segment',
      'transcript.final',
      'complete',
    ]);
    expect(h.socket.sent.join('')).not.toContain(TICKET);
    expect(h.socket.sent.join('')).not.toContain('mistral-session-1');
    const serverOnlyKeys = new Set([
      'redemptionId', 'companyId', 'userId', 'subjectHash', 'subjectKeyVersion', 'plan',
      'sessionId', 'contextRevision', 'contextDigest',
    ]);
    expect(outbound.every((event) => Object.keys(event).every((key) => !serverOnlyKeys.has(key))))
      .toBe(true);
    expect(h.socket.sent.join('')).not.toContain(GRANT.userId);
    expect(h.socket.sent.join('')).not.toContain(GRANT.subjectHash);
    expect(h.socket.sent.join('')).not.toContain(GRANT.redemptionId);
    expect(h.socket.closes.at(-1)).toEqual({ code: 1000, reason: 'session_complete' });
  });

  it('rejette une identité serveur forgée avant provider, sink et toute fuite wire', async () => {
    const malformed: MistralRealtimeIngressGrant[] = [
      { ...GRANT, userId: 'user\u0000forged' },
      { ...GRANT, subjectHash: 'not-a-subject-hash' },
      { ...GRANT, subjectKeyVersion: 0 },
      { ...GRANT, plan: 'enterprise' as MistralRealtimeIngressGrant['plan'] },
    ];
    for (const grant of malformed) {
      const h = harness({ tickets: authority({ ok: true, grant }) });
      const run = serveMistralRealtimeGateway(h.socket, h.dependencies);
      authenticate(h.socket);
      await expect(run).rejects.toMatchObject({ code: 'service_unavailable' });
      expect(h.connect).not.toHaveBeenCalled();
      expect(h.sink).not.toHaveBeenCalled();
      expect(h.socket.sent.map((raw) => JSON.parse(raw))).toEqual([
        { type: 'error', code: 'temporarily_unavailable' },
      ]);
      expect(h.socket.sent.join('')).not.toContain(grant.userId);
      expect(h.socket.sent.join('')).not.toContain(grant.subjectHash);
    }
  });

  it('refuse un ticket rejoué avant toute connexion provider et reste opaque sur le wire', async () => {
    const tickets = authority({ ok: false, reason: 'replayed' });
    const h = harness({ tickets });
    const run = serveMistralRealtimeGateway(h.socket, h.dependencies);
    authenticate(h.socket);
    await expect(run).rejects.toMatchObject({ code: 'auth_failed' });
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.socket.sent.map((raw) => JSON.parse(raw))).toEqual([
      { type: 'error', code: 'authentication_failed' },
    ]);
    expect(h.socket.sent.join('')).not.toContain(TICKET);
    expect(h.socket.closes.at(-1)).toEqual({ code: 4401, reason: 'authentication_failed' });
  });

  it('refuse toute frame micro avant ready et abandonne le claim durable', async () => {
    const h = harness();
    const run = serveMistralRealtimeGateway(h.socket, h.dependencies);
    authenticate(h.socket);
    h.socket.clientBinary(encodeMistralPcmGatewayFrame({
      kind: 'audio',
      sequence: 0,
      pcm: Uint8Array.of(1, 0),
    }));
    await expect(run).rejects.toMatchObject({ code: 'protocol_error' });
    expect(h.tickets.abandon).toHaveBeenCalledWith({
      companyId: GRANT.companyId,
      redemptionId: GRANT.redemptionId,
      providerSessionId: null,
      providerTermination: 'not_created',
    });
  });

  it('ferme fail-closed sur trou de séquence ou dépassement du budget audio', async () => {
    for (const scenario of ['sequence', 'budget'] as const) {
      const h = harness({ maxAudioBytes: scenario === 'budget' ? 2 : undefined });
      const run = serveMistralRealtimeGateway(h.socket, h.dependencies);
      authenticate(h.socket);
      await waitFor(() => h.socket.sent.some((raw) => JSON.parse(raw).type === 'ready'));
      h.socket.clientBinary(encodeMistralPcmGatewayFrame({
        kind: 'audio',
        sequence: scenario === 'sequence' ? 1 : 0,
        pcm: scenario === 'sequence' ? Uint8Array.of(1, 0) : Uint8Array.of(1, 0, 2, 0),
      }));
      await expect(run).rejects.toMatchObject({
        code: scenario === 'sequence' ? 'sequence_error' : 'audio_budget_exceeded',
      });
      expect(h.connection.close).toHaveBeenCalled();
      expect(h.tickets.abandon).toHaveBeenCalledWith(expect.objectContaining({
        providerTermination: 'confirmed',
      }));
    }
  });

  it('n’annonce jamais une terminaison confirmée lorsque le close provider échoue', async () => {
    const connection = new FakeProviderConnection();
    connection.close.mockRejectedValueOnce(new Error('provider-secret-must-not-leak'));
    const h = harness({ connection });
    const run = serveMistralRealtimeGateway(h.socket, h.dependencies);
    authenticate(h.socket);
    await waitFor(() => h.socket.sent.some((raw) => JSON.parse(raw).type === 'ready'));
    h.socket.clientBinary(encodeMistralPcmGatewayFrame({ kind: 'audio', sequence: 1, pcm: Uint8Array.of(1, 0) }));
    await expect(run).rejects.toMatchObject({ code: 'sequence_error' });
    expect(h.tickets.abandon).toHaveBeenCalledWith(expect.objectContaining({
      providerTermination: 'unconfirmed',
    }));
    expect(h.socket.sent.join('')).not.toContain('provider-secret-must-not-leak');
  });

  it('refuse toute frame ajoutée après input end au lieu de la perdre silencieusement', async () => {
    const h = harness();
    const run = serveMistralRealtimeGateway(h.socket, h.dependencies);
    authenticate(h.socket);
    await waitFor(() => h.socket.sent.some((raw) => JSON.parse(raw).type === 'ready'));
    h.socket.clientBinary(encodeMistralPcmGatewayFrame({ kind: 'end', sequence: 0 }));
    h.socket.clientBinary(encodeMistralPcmGatewayFrame({ kind: 'flush', sequence: 1 }));
    await expect(run).rejects.toMatchObject({ code: 'protocol_error' });
    expect(h.tickets.complete).not.toHaveBeenCalled();
    expect(h.tickets.abandon).toHaveBeenCalled();
  });

  it('borne aussi un close de port provider qui ne résout jamais', async () => {
    const connection = new FakeProviderConnection();
    connection.close.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
    const h = harness({ connection });
    const run = serveMistralRealtimeGateway(h.socket, {
      ...h.dependencies,
      providerCloseTimeoutMs: 25,
    });
    authenticate(h.socket);
    await waitFor(() => h.socket.sent.some((raw) => JSON.parse(raw).type === 'ready'));
    h.socket.clientBinary(encodeMistralPcmGatewayFrame({
      kind: 'audio',
      sequence: 1,
      pcm: Uint8Array.of(1, 0),
    }));
    await expect(run).rejects.toMatchObject({ code: 'sequence_error' });
    expect(h.tickets.abandon).toHaveBeenCalledWith(expect.objectContaining({
      providerTermination: 'unconfirmed',
    }));
  });

  it('fige un occurredAt UTC canonique au final et échoue fermé si l’horloge devient invalide', async () => {
    const h = harness();
    const now = vi.fn()
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce(NOW)
      .mockReturnValueOnce(Number.NaN);
    const run = serveMistralRealtimeGateway(h.socket, { ...h.dependencies, now });
    authenticate(h.socket);
    await waitFor(() => h.socket.sent.some((raw) => JSON.parse(raw).type === 'ready'));
    h.socket.clientBinary(encodeMistralPcmGatewayFrame({ kind: 'end', sequence: 0 }));

    await expect(run).rejects.toMatchObject({ code: 'sink_error' });
    expect(now).toHaveBeenCalledTimes(3);
    expect(h.sink).toHaveBeenCalledTimes(2);
    expect(h.sink.mock.calls.every(([published]) => !('occurredAt' in published))).toBe(true);
    expect(h.tickets.complete).not.toHaveBeenCalled();
    expect(h.tickets.abandon).toHaveBeenCalled();
  });
});

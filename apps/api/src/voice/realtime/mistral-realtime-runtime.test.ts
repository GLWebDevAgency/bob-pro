import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  ActiveMistralRealtimeIngressRuntime,
  DisabledMistralRealtimeIngressRuntime,
} from './mistral-realtime-runtime';

describe('MistralRealtimeIngressRuntime', () => {
  it('reste un no-op explicite lorsque Mistral n’est pas sélectionné', async () => {
    const runtime = new DisabledMistralRealtimeIngressRuntime();
    const server = createServer();
    expect(() => runtime.attach(server)).not.toThrow();
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(runtime.enabled).toBe(false);
  });

  it('attache une fois le vrai serveur et délègue le shutdown Nest', async () => {
    const adapter = {
      attach: vi.fn(),
      detach: vi.fn(),
      shutdown: vi.fn(async () => undefined),
      state: vi.fn(() => ({ attached: true, accepting: true, activeConnections: 0 })),
    };
    const runtime = new ActiveMistralRealtimeIngressRuntime(adapter);
    const server = createServer();

    runtime.attach(server);
    await runtime.onApplicationShutdown();

    expect(runtime.enabled).toBe(true);
    expect(adapter.attach).toHaveBeenCalledWith(server);
    expect(adapter.shutdown).toHaveBeenCalledOnce();
  });
});

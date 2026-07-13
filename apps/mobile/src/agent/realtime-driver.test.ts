import { describe, expect, it } from 'vitest';
import { ok, err } from '@bob/core';
import {
  RealtimeContextPublisher,
  decideAgentControl,
  mapTransportPhase,
} from './realtime-driver';
import type { AgentContext } from '@bob/ai';

const CONTEXT: AgentContext = {
  screen: { name: '/facture/[id]', instanceId: 'invoice:inv-1' },
  entities: [{ type: 'invoice', id: 'inv-1', label: 'Facture 2026-014' }],
  capabilities: ['invoice.read'],
};

describe('RealtimeContextPublisher — révision monotone, fence, jamais après close', () => {
  it('publie des révisions strictement croissantes avec le contexte assaini', async () => {
    const seen: { handle: string; revision: number }[] = [];
    const publisher = new RealtimeContextPublisher('h-1', async (handle, update) => {
      seen.push({ handle, revision: update.revision });
      return ok({ revision: update.revision, contextDigest: `d-${update.revision}` });
    });
    expect((await publisher.publish(CONTEXT))?.contextRevision).toBe(1);
    expect((await publisher.publish(CONTEXT))?.contextRevision).toBe(2);
    expect(publisher.fence).toMatchObject({ sessionHandle: 'h-1', contextRevision: 2, contextDigest: 'd-2' });
    expect(seen.map((s) => s.revision)).toEqual([1, 2]);
    expect(seen.every((s) => s.handle === 'h-1')).toBe(true);
  });

  it('après close() : plus AUCUNE publication (une navigation tardive ne fuit jamais)', async () => {
    let calls = 0;
    const publisher = new RealtimeContextPublisher('h-1', async () => {
      calls += 1;
      return ok({ revision: 1, contextDigest: 'd-1' });
    });
    publisher.close();
    expect(await publisher.publish(CONTEXT)).toBeNull();
    expect(calls).toBe(0);
  });

  it('une publication doublée par une plus récente est neutralisée (fence)', async () => {
    const resolvers: Array<() => void> = [];
    let served = 0;
    const publisher = new RealtimeContextPublisher('h-1', async () => {
      served += 1;
      const mine = served;
      await new Promise<void>((resolve) => resolvers.push(resolve));
      return ok({ revision: mine, contextDigest: `d-${mine}` });
    });
    const first = publisher.publish(CONTEXT);
    const second = publisher.publish(CONTEXT);
    resolvers[1]!();
    expect((await second)?.contextRevision).toBe(2);
    resolvers[0]!();
    expect(await first).toBeNull(); // la révision 1, doublée, ne compte pas
    expect(publisher.fence?.contextRevision).toBe(2); // la fence reste celle de la plus récente
  });

  it('un échec serveur rend null (l’appelant republiera) sans casser la monotonie', async () => {
    let attempt = 0;
    const publisher = new RealtimeContextPublisher('h-1', async () => {
      attempt += 1;
      return attempt === 1
        ? err({ kind: 'dependency', port: 'realtime', cause: 'offline' })
        : ok({ revision: 2, contextDigest: 'd-2' });
    });
    expect(await publisher.publish(CONTEXT)).toBeNull();
    expect((await publisher.publish(CONTEXT))?.contextRevision).toBe(2);
  });
});

describe('decideAgentControl — navigation allowlistée, validation VISUELLE seulement', () => {
  it('une proposition demande une revue visuelle — JAMAIS de confirmation vocale directe', () => {
    expect(decideAgentControl({ turnId: 't', kind: 'proposed', proposalId: 'p-1', contextRevision: 1, contextDigest: 'd-1' })).toEqual({
      kind: 'review',
      proposalId: 'p-1',
    });
  });

  it('navigate hors allowlist → ignoré ; allowlisté → navigate', () => {
    expect(decideAgentControl({ turnId: 't', kind: 'answer', navigate: 'https://evil.example', contextRevision: 1, contextDigest: 'd-1' })).toEqual({
      kind: 'none',
    });
    expect(decideAgentControl({ turnId: 't', kind: 'answer', navigate: '/cloture', contextRevision: 1, contextDigest: 'd-1' })).toEqual({
      kind: 'navigate',
      route: '/cloture',
    });
  });

  it('answer/done sans navigation → aucun effet', () => {
    expect(decideAgentControl({ turnId: 't', kind: 'done', contextRevision: 1, contextDigest: 'd-1' })).toEqual({ kind: 'none' });
  });
});

describe('mapTransportPhase — une seule sémantique de phases pour l’UI', () => {
  it('ready/user_speaking = écoute, bob_speaking = parole, closing/closed = repos', () => {
    expect(mapTransportPhase('ready')).toBe('listening');
    expect(mapTransportPhase('user_speaking')).toBe('listening');
    expect(mapTransportPhase('bob_speaking')).toBe('speaking');
    expect(mapTransportPhase('connecting')).toBe('thinking');
    expect(mapTransportPhase('closed')).toBe('idle');
  });
});

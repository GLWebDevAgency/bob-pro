import {
  QUOTE_DRAFT_PAYLOAD_SCHEMA,
  QUOTE_DRAFT_PAYLOAD_VERSION,
  type QuoteDraftPayloadV1,
} from '@bob/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpBobClient } from './http-client';

function payload(sessionId: string): QuoteDraftPayloadV1 {
  return {
    schema: QUOTE_DRAFT_PAYLOAD_SCHEMA,
    version: QUOTE_DRAFT_PAYLOAD_VERSION,
    draft: {
      sessionId,
      contentRevision: 1,
      stagingRevision: 0,
      step: 'client',
      customer: null,
      lines: [],
      lineMetadata: [],
      lineForm: { label: '', quantity: '1', unitPrice: '', category: 'labor' },
      vatDecision: null,
      depositPct: 30,
      signMode: null,
    },
  };
}

function slot(revision: number, sessionId: string) {
  return {
    revision,
    payloadVersion: QUOTE_DRAFT_PAYLOAD_VERSION,
    payload: payload(sessionId),
    createdAt: '2026-07-17T10:00:00.000Z',
    updatedAt: '2026-07-17T10:01:00.000Z',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpBobClient — QuoteDraft BDD owner-scoped', () => {
  it('charge le slot courant sans envoyer d’identité propriétaire dans la requête', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.bob.test/quote-drafts/current');
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get('x-company-id')).toBe('company-a');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer jwt-a');
      return new Response(JSON.stringify({ slot: slot(1, 'draft-a') }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({
      baseUrl: 'https://api.bob.test',
      companyId: 'company-a',
      getToken: async () => 'jwt-a',
    });

    await expect(client.getQuoteDraft()).resolves.toMatchObject({
      ok: true,
      value: { revision: 1, payload: { draft: { sessionId: 'draft-a' } } },
    });
  });

  it('sérialise uniquement expectedRevision + payload et transporte le CAS', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(String(init?.body))).toEqual({
        expectedRevision: 1,
        payload: payload('revision-2'),
      });
      return new Response(JSON.stringify(slot(2, 'revision-2')), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-a' });

    const runtimeInput = {
      expectedRevision: 1,
      payload: payload('revision-2'),
      companyId: 'forged-company',
      ownerUserId: 'forged-owner',
    };
    await expect(client.saveQuoteDraft(runtimeInput)).resolves.toMatchObject({
      ok: true,
      value: { revision: 2 },
    });
  });

  it('préserve un conflit CAS HTTP 409 comme erreur métier explicite', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { kind: 'conflict', entity: 'quote_draft_slot', reason: 'stale_revision' },
    }), { status: 409, headers: { 'content-type': 'application/json' } })));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-a' });

    await expect(client.saveQuoteDraft({ expectedRevision: 1, payload: payload('stale') }))
      .resolves.toEqual({
        ok: false,
        error: { kind: 'conflict', entity: 'quote_draft_slot', reason: 'stale_revision' },
      });
  });

  it('rejette toute réponse enrichie d’identités serveur au lieu de la rendre à l’UI', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      slot: { ...slot(1, 'leak'), companyId: 'company-a', ownerUserId: 'owner-a' },
    }), { headers: { 'content-type': 'application/json' } })));
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-a' });

    await expect(client.getQuoteDraft()).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
  });

  it('supprime avec la seule révision observée', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.method).toBe('DELETE');
      expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 2 });
      return new Response(JSON.stringify({ deleted: true }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpBobClient({ baseUrl: 'https://api.bob.test', companyId: 'company-a' });

    await expect(client.deleteQuoteDraft(2)).resolves.toEqual({
      ok: true,
      value: { deleted: true },
    });
  });
});

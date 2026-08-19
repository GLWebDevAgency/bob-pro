import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpBobClient } from './http-client';
import type { JarvisSubmitCommandClientInput } from './client';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const COMMAND_ID = '22222222-2222-4222-8222-222222222222';
const CONFIRMATION_ID = '33333333-3333-4333-8333-333333333333';
const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444';
const HASH = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);

function client() {
  return new HttpBobClient({
    baseUrl: 'https://api.bob.test',
    companyId: 'company-a',
    getToken: async () => 'jwt-a',
  });
}

function submitInput(
  overrides: Partial<JarvisSubmitCommandClientInput> = {},
): JarvisSubmitCommandClientInput {
  return {
    runId: RUN_ID,
    kind: 'customer_contact',
    definitionVersion: 1,
    commandId: COMMAND_ID,
    expectedRevision: 4,
    actionId: 'client-creer',
    actionVersion: 1,
    command: {
      type: 'record_presentation_ack',
      confirmationId: CONFIRMATION_ID,
      ack: 'screen_ack',
    },
    ...overrides,
  };
}

function run() {
  return {
    runId: RUN_ID,
    kind: 'customer_contact',
    definitionVersion: 1,
    status: 'waiting_user',
    revision: 5,
    nextWakeAt: null,
    terminalAt: null,
  };
}

function presentation() {
  return {
    schema: 'bob.jarvis-run.customer-contact-presentation',
    version: 1,
    phase: 'awaiting_confirmation',
    intent: 'create',
    targetCustomerId: null,
    proposal: {
      proposalId: PROPOSAL_ID,
      proposalHash: HASH,
      fieldsDigest: DIGEST,
      fields: [
        {
          field: 'name',
          label: 'Nom du client',
          before: null,
          after: 'Dupont Plomberie',
          sensitiveField: null,
        },
      ],
    },
    confirmation: {
      confirmationId: CONFIRMATION_ID,
      status: 'presented',
      expiresAt: '2026-08-19T10:05:00.000Z',
      presentedAt: '2026-08-19T10:00:10.000Z',
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpBobClient — canal tactile Jarvis', () => {
  it('poste l’enveloppe exacte : ni horodatage ni empreinte fabriqués côté client', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(`https://api.bob.test/jarvis/runs/${RUN_ID}/commands`);
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('cache-control')).toBe('no-store');
      expect(JSON.parse(String(init?.body))).toEqual({
        kind: 'customer_contact',
        definitionVersion: 1,
        commandId: COMMAND_ID,
        expectedRevision: 4,
        actionId: 'client-creer',
        actionVersion: 1,
        command: {
          type: 'record_presentation_ack',
          confirmationId: CONFIRMATION_ID,
          ack: 'screen_ack',
        },
      });
      return new Response(
        JSON.stringify({
          outcome: 'admitted',
          run: run(),
          presentation: presentation(),
          eventSequence: 9,
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().jarvisSubmitCommand(submitInput())).resolves.toMatchObject({
      ok: true,
      value: { outcome: 'admitted', run: { revision: 5 } },
    });
  });

  it('n’envoie rien quand l’enveloppe n’est pas canonique', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const http = client();

    // commandId v8 = canal SYSTÈME (§5.6), jamais un geste humain.
    await expect(
      http.jarvisSubmitCommand(submitInput({ commandId: '22222222-2222-8222-8222-222222222222' })),
    ).resolves.toMatchObject({ ok: false, error: { kind: 'validation' } });
    // Action hors des bornes d'ouverture du lot (rollout.ts).
    await expect(
      http.jarvisSubmitCommand(submitInput({ actionId: 'client-supprimer' })),
    ).resolves.toMatchObject({ ok: false, error: { kind: 'validation' } });
    await expect(
      http.jarvisSubmitCommand(submitInput({ expectedRevision: 0 })),
    ).resolves.toMatchObject({ ok: false, error: { kind: 'validation' } });
    // L'ack vocal n'appartient pas au canal tactile.
    await expect(
      http.jarvisSubmitCommand(
        submitInput({
          command: {
            type: 'record_presentation_ack',
            confirmationId: CONFIRMATION_ID,
            ack: 'voice_presentation_ack',
          } as never,
        }),
      ),
    ).resolves.toMatchObject({ ok: false, error: { kind: 'validation' } });
    await expect(http.jarvisSubmitCommand(submitInput({ runId: 'run-1' }))).resolves.toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuse un reçu au contrat cassé plutôt que de l’afficher à moitié', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ outcome: 'admitted', run: run(), presentation: {}, eventSequence: 9 }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    await expect(client().jarvisSubmitCommand(submitInput())).resolves.toMatchObject({
      ok: false,
      error: { kind: 'dependency', port: 'api-contract' },
    });
  });

  it('remonte le refus fermé de l’admission tel que le serveur l’a projeté', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { kind: 'conflict', entity: 'jarvis_run', reason: 'stale_revision' },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    await expect(client().jarvisSubmitCommand(submitInput())).resolves.toMatchObject({
      ok: false,
      error: { kind: 'conflict', reason: 'stale_revision' },
    });
  });

  it('relit le run sans cache et accepte une présentation absente (fail-closed)', async () => {
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      expect(String(url)).toBe(`https://api.bob.test/jarvis/runs/${RUN_ID}`);
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get('cache-control')).toBe('no-store');
      return new Response(JSON.stringify({ run: run(), presentation: null }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().jarvisGetRun(RUN_ID)).resolves.toMatchObject({
      ok: true,
      value: { run: { runId: RUN_ID }, presentation: null },
    });
  });

  it('refuse un runId non canonique avant tout départ réseau', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(client().jarvisGetRun('../admin')).resolves.toMatchObject({
      ok: false,
      error: { kind: 'validation' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

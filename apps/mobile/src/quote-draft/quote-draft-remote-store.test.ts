import { describe, expect, it, vi } from 'vitest';
import type { QuoteDraftSlotView } from '@bob/api-client';
import { createQuoteDraft } from './quote-draft-model';
import { encodeQuoteDraftServerPayload } from './quote-draft-server-codec';
import {
  createQuoteDraftRemotePersistence,
  disposeQuoteDraftSession,
  QuoteDraftRemoteError,
  type QuoteDraftRemoteClient,
} from './quote-draft-remote-store';

function slot(sessionId: string, revision: number): QuoteDraftSlotView {
  return {
    revision,
    payloadVersion: 1,
    payload: encodeQuoteDraftServerPayload(createQuoteDraft(sessionId)),
    createdAt: '2026-07-17T08:00:00.000Z',
    updatedAt: `2026-07-17T08:00:0${Math.min(revision, 9)}.000Z`,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('persistance distante du brouillon de devis', () => {
  it('enchaîne les PUT en single-flight avec la révision CAS réellement commitée', async () => {
    const first = deferred<{ readonly ok: true; readonly value: QuoteDraftSlotView }>();
    const saveQuoteDraft = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ ok: true, value: slot('session-2', 2) });
    const client = {
      getQuoteDraft: vi.fn().mockResolvedValue({ ok: true, value: null }),
      saveQuoteDraft,
      deleteQuoteDraft: vi.fn(),
    } as unknown as QuoteDraftRemoteClient;
    const persistence = createQuoteDraftRemotePersistence(client);
    await persistence.load();

    const firstSave = persistence.save(createQuoteDraft('session-1'));
    const secondSave = persistence.save(createQuoteDraft('session-2'));
    await vi.waitFor(() => expect(saveQuoteDraft).toHaveBeenCalledTimes(1));
    expect(saveQuoteDraft.mock.calls[0]?.[0]).toMatchObject({ expectedRevision: 0 });

    first.resolve({ ok: true, value: slot('session-1', 1) });
    await expect(firstSave).resolves.toMatchObject({
      state: { sessionId: 'session-1' },
      reference: { sessionId: 'session-1', slotRevision: 1, contentRevision: 0 },
    });
    await expect(secondSave).resolves.toMatchObject({
      state: { sessionId: 'session-2' },
      reference: { sessionId: 'session-2', slotRevision: 2, contentRevision: 0 },
    });
    expect(saveQuoteDraft).toHaveBeenCalledTimes(2);
    expect(saveQuoteDraft.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 1 });
  });

  it('remonte explicitement le 409 CAS sans écraser la révision observée', async () => {
    const client = {
      getQuoteDraft: vi.fn().mockResolvedValue({ ok: true, value: slot('server-current', 8) }),
      saveQuoteDraft: vi.fn().mockResolvedValue({
        ok: false,
        error: { kind: 'conflict', entity: 'quote_draft_slot', reason: 'stale_revision' },
      }),
      deleteQuoteDraft: vi.fn(),
    } as unknown as QuoteDraftRemoteClient;
    const persistence = createQuoteDraftRemotePersistence(client);
    await persistence.load();

    await expect(persistence.save(createQuoteDraft('local-stale'))).rejects.toMatchObject({
      name: 'QuoteDraftRemoteError',
      code: 'revision_conflict',
      operation: 'save',
    } satisfies Partial<QuoteDraftRemoteError>);
  });

  it('un switch de compte invalide le GET tardif de A sans contaminer B ni supprimer A', async () => {
    const lateA = deferred<{ readonly ok: true; readonly value: QuoteDraftSlotView }>();
    const deleteA = vi.fn();
    const accountA = createQuoteDraftRemotePersistence({
      getQuoteDraft: vi.fn(() => lateA.promise),
      saveQuoteDraft: vi.fn(),
      deleteQuoteDraft: deleteA,
    } as unknown as QuoteDraftRemoteClient);
    const loadA = accountA.load();
    accountA.dispose();

    const deleteB = vi.fn();
    const accountB = createQuoteDraftRemotePersistence({
      getQuoteDraft: vi.fn().mockResolvedValue({ ok: true, value: slot('account-b', 2) }),
      saveQuoteDraft: vi.fn(),
      deleteQuoteDraft: deleteB,
    } as unknown as QuoteDraftRemoteClient);
    await expect(accountB.load()).resolves.toMatchObject({
      state: { sessionId: 'account-b' },
      reference: { sessionId: 'account-b', slotRevision: 2 },
    });

    lateA.resolve({ ok: true, value: slot('account-a-late', 5) });
    await expect(loadA).rejects.toMatchObject({ code: 'session_closed' });
    expect(deleteA).not.toHaveBeenCalled();
    expect(deleteB).not.toHaveBeenCalled();
  });

  it('le logout purge la session locale sans envoyer de DELETE au slot serveur', async () => {
    const lateLoad = deferred<{ readonly ok: true; readonly value: QuoteDraftSlotView }>();
    const deleteQuoteDraft = vi.fn();
    const persistence = createQuoteDraftRemotePersistence({
      getQuoteDraft: vi.fn(() => lateLoad.promise),
      saveQuoteDraft: vi.fn(),
      deleteQuoteDraft,
    } as unknown as QuoteDraftRemoteClient);
    const loading = persistence.load();

    await disposeQuoteDraftSession(persistence);
    lateLoad.resolve({ ok: true, value: slot('persist-after-logout', 3) });

    expect(deleteQuoteDraft).not.toHaveBeenCalled();
    await expect(loading).rejects.toMatchObject({ code: 'session_closed' });
    await expect(persistence.load()).rejects.toMatchObject({ code: 'session_closed' });
  });

  it('le DELETE n est envoyé que par clear après hydratation et utilise la révision exacte', async () => {
    const deleteQuoteDraft = vi.fn().mockResolvedValue({ ok: true, value: { deleted: true } });
    const persistence = createQuoteDraftRemotePersistence({
      getQuoteDraft: vi.fn().mockResolvedValue({ ok: true, value: slot('to-delete', 6) }),
      saveQuoteDraft: vi.fn(),
      deleteQuoteDraft,
    } as unknown as QuoteDraftRemoteClient);
    await persistence.load();

    await persistence.clear();

    expect(deleteQuoteDraft).toHaveBeenCalledOnce();
    expect(deleteQuoteDraft).toHaveBeenCalledWith(6);
  });

  it('une observation refusée n avance jamais la CAS utilisée par le prochain save', async () => {
    const getQuoteDraft = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: slot('before-mission', 5) })
      .mockResolvedValueOnce({ ok: true, value: slot('mission-draft', 8) });
    const saveQuoteDraft = vi.fn().mockResolvedValue({
      ok: false,
      error: { kind: 'conflict', entity: 'quote_draft_slot', reason: 'stale_revision' },
    });
    const persistence = createQuoteDraftRemotePersistence({
      getQuoteDraft,
      saveQuoteDraft,
      deleteQuoteDraft: vi.fn(),
    } as unknown as QuoteDraftRemoteClient);
    await persistence.load();

    const refresh = await persistence.refresh(() => false);
    expect(refresh).toMatchObject({
      status: 'rejected',
      observation: {
        reference: { sessionId: 'mission-draft', slotRevision: 8 },
      },
    });

    await expect(
      persistence.save(createQuoteDraft('local-unsaved')),
    ).rejects.toMatchObject({ code: 'revision_conflict' });
    expect(saveQuoteDraft).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 5 }),
    );
  });

  it('une observation acceptée avance atomiquement la CAS et sa référence', async () => {
    const getQuoteDraft = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: slot('before-mission', 5) })
      .mockResolvedValueOnce({ ok: true, value: slot('mission-draft', 8) });
    const saveQuoteDraft = vi.fn().mockResolvedValue({
      ok: true,
      value: slot('mission-draft', 9),
    });
    const persistence = createQuoteDraftRemotePersistence({
      getQuoteDraft,
      saveQuoteDraft,
      deleteQuoteDraft: vi.fn(),
    } as unknown as QuoteDraftRemoteClient);
    await persistence.load();

    await expect(persistence.refresh(() => true)).resolves.toMatchObject({
      status: 'adopted',
      observation: {
        reference: {
          sessionId: 'mission-draft',
          slotRevision: 8,
          contentRevision: 0,
        },
      },
    });
    await persistence.save(createQuoteDraft('mission-draft'));
    expect(saveQuoteDraft).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 8 }),
    );
  });
});

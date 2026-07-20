/**
 * Bug terrain « badge brouillon fantôme » (APK d091b0b5) : la suppression d'un brouillon doit
 * ATTENDRE le refetch de la liste des factures avant de résoudre `mutateAsync` — sinon l'écran
 * appelant (facture/[id]) fait `router.back()` vers un devis encore nourri de données périmées.
 * Comportement garanti par query-core (Mutation#execute : `await this.options.onSuccess?.(...)`)
 * dès lors que onSuccess RETOURNE la promesse d'invalidation — ce que ce test verrouille sur le
 * hook réel, rendu via react-test-renderer avec les frontières (client/auth/supabase) mockées.
 */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const deleteDraftInvoice = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn(async () => undefined) },
}));
vi.mock('./supabase', () => ({ supabaseEnabled: false }));
vi.mock('./auth', () => ({ useAuth: () => ({ session: null }) }));
vi.mock('./client', () => ({ useBobClient: () => ({ deleteDraftInvoice }) }));

import { useDeleteDraftInvoice } from './hooks';

const INVOICE_ID = 'inv-1';

describe('useDeleteDraftInvoice', () => {
  let qc: QueryClient;
  let renderer: ReactTestRenderer | null = null;
  let mutation: ReturnType<typeof useDeleteDraftInvoice> | null = null;
  let unsubscribers: Array<() => void> = [];

  function Probe() {
    mutation = useDeleteDraftInvoice();
    return null;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mutation = null;
    unsubscribers = [];
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      renderer = create(createElement(QueryClientProvider, { client: qc }, createElement(Probe)));
    });
  });

  afterEach(async () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    if (renderer !== null) {
      await act(async () => renderer?.unmount());
      renderer = null;
    }
    qc.clear();
  });

  /** Monte un observer ACTIF (équivalent d'un écran abonné) sur une query pré-remplie fraîche. */
  function subscribeActiveQuery(
    queryKey: readonly unknown[],
    data: unknown,
    queryFn: () => Promise<unknown>,
  ): void {
    qc.setQueryData(queryKey, data);
    const observer = new QueryObserver(qc, {
      queryKey: queryKey as unknown[],
      queryFn,
      staleTime: Infinity,
    });
    unsubscribers.push(observer.subscribe(() => {}));
  }

  const flushMicrotasks = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  it('ne résout mutateAsync qu’une fois le refetch de la liste des factures TERMINÉ', async () => {
    let resolveListRefetch!: (value: unknown) => void;
    const listFetch = vi.fn(
      () => new Promise<unknown>((resolve) => (resolveListRefetch = resolve)),
    );
    subscribeActiveQuery(['invoices'], [{ id: INVOICE_ID, status: 'draft' }], listFetch);
    deleteDraftInvoice.mockResolvedValue({ ok: true, value: { deleted: true } });

    let settled = false;
    let mutatePromise!: Promise<unknown>;
    await act(async () => {
      mutatePromise = mutation!.mutateAsync(INVOICE_ID).then(() => {
        settled = true;
      });
      await flushMicrotasks();
    });

    // L'invalidation a bien déclenché le refetch de la liste (query active)…
    expect(listFetch).toHaveBeenCalledTimes(1);
    // …et la mutation N'EST PAS résolue tant que ce refetch est en vol : l'écran ne peut pas
    // naviguer en arrière vers une liste périmée.
    expect(settled).toBe(false);

    await act(async () => {
      resolveListRefetch([]);
      await mutatePromise;
    });
    expect(settled).toBe(true);
  });

  it('marque le détail supprimé périmé SANS le refetcher (une pièce supprimée ne peut que 404)', async () => {
    subscribeActiveQuery(['invoices'], [{ id: INVOICE_ID, status: 'draft' }], async () => []);
    const detailFetch = vi.fn(async () => ({ id: INVOICE_ID }));
    subscribeActiveQuery(['invoice', INVOICE_ID], { id: INVOICE_ID }, detailFetch);
    deleteDraftInvoice.mockResolvedValue({ ok: true, value: { deleted: true } });

    await act(async () => {
      await mutation!.mutateAsync(INVOICE_ID);
    });

    expect(detailFetch).not.toHaveBeenCalled();
    expect(qc.getQueryState(['invoice', INVOICE_ID])?.isInvalidated).toBe(true);
  });

  it('un échec serveur rejette mutateAsync sans invalider quoi que ce soit', async () => {
    const listFetch = vi.fn(async () => []);
    subscribeActiveQuery(['invoices'], [{ id: INVOICE_ID, status: 'draft' }], listFetch);
    const appError = { kind: 'http', status: 409 };
    deleteDraftInvoice.mockResolvedValue({ ok: false, error: appError });

    await act(async () => {
      await expect(mutation!.mutateAsync(INVOICE_ID)).rejects.toBe(appError);
    });
    expect(listFetch).not.toHaveBeenCalled();
  });
});

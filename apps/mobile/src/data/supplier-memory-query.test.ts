import { describe, expect, it, vi } from 'vitest';
import type { BobClient, ExpenseDefaultsView, SuggestExpenseDefaultsInput } from '@bob/api-client';
import {
  deriveSupplierExpenseDefaultsState,
  loadSupplierExpenseDefaults,
  supplierExpenseDefaultsKey,
} from './supplier-memory-query';

const input: SuggestExpenseDefaultsInput = {
  supplierName: 'Cedeo Paris',
  supplierSiren: '572141885',
  vatRatePctApplied: 20,
  categoryGuess: 'fournitures',
};

const serverDefaults: ExpenseDefaultsView = {
  supplierName: 'CEDEO PARIS',
  supplierSiren: '572141885',
  category: 'materiel',
  vatRatePct: 20,
  source: 'memory',
};

describe('supplier memory server query', () => {
  it('restitue uniquement la réponse de la mémoire fournisseur serveur', async () => {
    const suggestExpenseDefaults = vi.fn().mockResolvedValue({
      ok: true as const,
      value: serverDefaults,
    });
    const client = { suggestExpenseDefaults } as Pick<BobClient, 'suggestExpenseDefaults'>;

    await expect(loadSupplierExpenseDefaults(client, input)).resolves.toBe(serverDefaults);
    expect(suggestExpenseDefaults).toHaveBeenCalledOnce();
    expect(suggestExpenseDefaults).toHaveBeenCalledWith(input);
  });

  it('propage l’indisponibilité serveur sans fabriquer de défaut OCR ou local', async () => {
    const error = { kind: 'unavailable' as const, service: 'supplier-memory' };
    const client = {
      suggestExpenseDefaults: vi.fn().mockResolvedValue({ ok: false as const, error }),
    } as Pick<BobClient, 'suggestExpenseDefaults'>;

    await expect(loadSupplierExpenseDefaults(client, input)).rejects.toBe(error);
  });

  it('borne le cache par société et par contenu OCR', () => {
    expect(supplierExpenseDefaultsKey('company-a', input)).not.toEqual(
      supplierExpenseDefaultsKey('company-b', input),
    );
    expect(supplierExpenseDefaultsKey('company-a', input)).not.toEqual(
      supplierExpenseDefaultsKey('company-a', { ...input, vatRatePctApplied: 10 }),
    );
  });
});

describe('deriveSupplierExpenseDefaultsState', () => {
  it('reste inactif avant toute extraction', () => {
    expect(
      deriveSupplierExpenseDefaultsState({
        hasExtraction: false,
        companyId: null,
        query: { data: undefined, isPending: true, isError: false },
      }),
    ).toEqual({ kind: 'idle' });
  });

  it('rend la réponse serveur seulement quand elle est prête', () => {
    expect(
      deriveSupplierExpenseDefaultsState({
        hasExtraction: true,
        companyId: 'company-a',
        query: { data: serverDefaults, isPending: false, isError: false },
      }),
    ).toEqual({ kind: 'ready', value: serverDefaults });
  });

  it.each([
    {
      label: 'tenant absent',
      companyId: null,
      query: { data: undefined, isPending: false, isError: false },
    },
    {
      label: 'requête en erreur',
      companyId: 'company-a',
      query: { data: undefined, isPending: false, isError: true },
    },
    {
      label: 'ancienne donnée avec rechargement en erreur',
      companyId: 'company-a',
      query: { data: serverDefaults, isPending: false, isError: true },
    },
  ])('signale unavailable : $label', ({ companyId, query }) => {
    expect(
      deriveSupplierExpenseDefaultsState({
        hasExtraction: true,
        companyId,
        query,
      }),
    ).toEqual({ kind: 'unavailable' });
  });

  it('signale le chargement sans fournir de valeur provisoire', () => {
    expect(
      deriveSupplierExpenseDefaultsState({
        hasExtraction: true,
        companyId: 'company-a',
        query: { data: undefined, isPending: true, isError: false },
      }),
    ).toEqual({ kind: 'loading' });
  });
});

import { describe, expect, it } from 'vitest';
import { searchGlobal, type GlobalSearchInput } from './search-global';
import { type VaultDocumentData } from '../documents/derive-vault-view';

const TOTALS = { ht: 100000, vatByRate: { '20': 20000 }, vat: 20000, ttc: 120000, netToPay: 120000 };

function doc(over: Partial<VaultDocumentData>): VaultDocumentData {
  return {
    id: 'doc-1',
    kind: 'receipt',
    filename: 'recu-leroy-merlin.jpg',
    linkedEntityType: 'expense',
    linkedEntityId: 'exp-1',
    documentDate: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    tags: ['achats'],
    ...over,
  } as VaultDocumentData;
}

function base(query: string): GlobalSearchInput {
  return {
    query,
    customers: [
      { id: 'c-sevres', name: 'Mairie de Sèvres', type: 'b2g' },
      { id: 'c-martin', name: 'SARL Martin Rénovation', type: 'b2b' },
    ],
    invoices: [
      { id: 'i-1', kind: 'final', status: 'issued', number: 'F-2026-0001', customerId: 'c-sevres', totals: TOTALS },
      { id: 'i-2', kind: 'deposit', status: 'draft', number: null, customerId: 'c-martin', totals: TOTALS },
    ],
    quotes: [{ id: 'q-1', status: 'signed', number: 'D-2026-0001', customerId: 'c-martin', totals: TOTALS }],
    documents: [doc({})],
  };
}

describe('searchGlobal (A7 — une recherche, tout le cabinet)', () => {
  it('insensible aux accents/casse : « sevres » trouve le client ET sa facture', () => {
    const r = searchGlobal(base('sevres'));
    expect(r.customers.map((c) => c.id)).toEqual(['c-sevres']);
    expect(r.pieces.map((p) => p.id)).toEqual(['i-1']);
    expect(r.totalCount).toBe(2);
  });

  it('un numéro de pièce vise la pièce ; un brouillon SANS numéro reste trouvable par client', () => {
    expect(searchGlobal(base('F-2026')).pieces.map((p) => p.id)).toEqual(['i-1']);
    const martin = searchGlobal(base('martin'));
    expect(martin.pieces.map((p) => p.id).sort()).toEqual(['i-2', 'q-1']);
    // Le devis porte son TTC, la facture son net à payer.
    expect(martin.pieces.find((p) => p.source === 'quote')?.amountCents).toBe(120000);
  });

  it('documents : la même recherche que le coffre (fichier + tags)', () => {
    expect(searchGlobal(base('leroy')).documents.map((d) => d.id)).toEqual(['doc-1']);
    expect(searchGlobal(base('achats')).documents.map((d) => d.id)).toEqual(['doc-1']);
  });

  it('requête vide ou blanche : AUCUN résultat (jamais « tout »)', () => {
    expect(searchGlobal(base(''))).toEqual({ customers: [], pieces: [], documents: [], totalCount: 0 });
    expect(searchGlobal(base('   ')).totalCount).toBe(0);
  });
});

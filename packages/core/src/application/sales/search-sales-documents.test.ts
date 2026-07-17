import { describe, expect, it } from 'vitest';
import {
  searchSalesDocumentsInMemory,
  suggestSalesDocumentsInMemory,
  type SalesDocumentSearchPiece,
  type SearchSalesDocumentsInMemoryInput,
} from './search-sales-documents';

const TOTALS = { ht: 100000, vatByRate: { '20': 20000 }, vat: 20000, ttc: 120000, netToPay: 120000 };

function piece(over: Partial<SalesDocumentSearchPiece>): SalesDocumentSearchPiece {
  return {
    id: 'p-1',
    number: 'F-2026-0001',
    customerId: 'c-sevres',
    status: 'issued',
    date: '2026-06-15',
    totals: TOTALS,
    lines: [{ label: 'Chauffe-eau' }],
    ...over,
  };
}

function base(over: Partial<SearchSalesDocumentsInMemoryInput> = {}): SearchSalesDocumentsInMemoryInput {
  return {
    query: '',
    scope: 'all',
    customers: [
      { id: 'c-sevres', name: 'Mairie de Sèvres' },
      { id: 'c-martin', name: 'SARL Martin Rénovation' },
    ],
    quotes: [
      piece({ id: 'q-1', number: 'D-2026-0001', customerId: 'c-martin', status: 'signed', date: null, lines: [{ label: 'Peinture façade' }] }),
    ],
    invoices: [
      piece({ id: 'i-1', number: 'F-2026-0001', customerId: 'c-sevres', status: 'issued', date: '2026-06-15' }),
      piece({ id: 'i-2', number: 'F-2026-0002', customerId: 'c-martin', status: 'issued', date: '2026-05-01', lines: [{ label: 'Devis reprise' }] }),
    ],
    ...over,
  };
}

describe('searchSalesDocumentsInMemory (B9 — pendant démo/tests de GET /documents/search)', () => {
  it('requête vide + aucun filtre : TOUTES les pièces du scope, triées par date desc', () => {
    const r = searchSalesDocumentsInMemory(base());
    // i-1 (15/06) avant i-2 (01/05) ; q-1 (date null) reste en dernier, sans planter le tri.
    expect(r.hits.map((h) => h.id)).toEqual(['i-1', 'i-2', 'q-1']);
    expect(r.totalCount).toBe(3);
    expect(r.nextCursor).toBeNull();
  });

  it('nom client (insensible accents/casse) trouve la pièce ET porte le bon nom résolu', () => {
    const r = searchSalesDocumentsInMemory(base({ query: 'sevres' }));
    expect(r.hits.map((h) => h.id)).toEqual(['i-1']);
    expect(r.hits[0]?.customerName).toBe('Mairie de Sèvres');
  });

  it('numéro exact classé devant un simple "contient"', () => {
    const r = searchSalesDocumentsInMemory(base({ query: 'F-2026-0001' }));
    expect(r.hits[0]?.id).toBe('i-1');
  });

  it('libellé de ligne ("chauffe-eau") retrouve la pièce et expose la ligne matchée', () => {
    const r = searchSalesDocumentsInMemory(base({ query: 'chauffe eau' }));
    expect(r.hits.map((h) => h.id)).toEqual(['i-1']);
    expect(r.hits[0]?.matchedLineLabel).toBe('Chauffe-eau');
  });

  it('scope="quote" exclut les factures même si elles matchent', () => {
    const r = searchSalesDocumentsInMemory(base({ query: 'martin', scope: 'quote' }));
    expect(r.hits.map((h) => h.id)).toEqual(['q-1']);
  });

  it('customerId filtre STRICTEMENT sur ce client', () => {
    const r = searchSalesDocumentsInMemory(base({ customerId: 'c-martin' }));
    expect(r.hits.map((h) => h.id).sort()).toEqual(['i-2', 'q-1']);
  });

  it('status filtre sur le statut exact', () => {
    const r = searchSalesDocumentsInMemory(base({ status: 'signed' }));
    expect(r.hits.map((h) => h.id)).toEqual(['q-1']);
  });

  it('plage de dates : une pièce SANS date connue (quote en mémoire) est exclue, jamais devinée', () => {
    const r = searchSalesDocumentsInMemory(base({ from: '2026-01-01', to: '2026-12-31' }));
    expect(r.hits.map((h) => h.id).sort()).toEqual(['i-1', 'i-2']);
  });

  it('plage de dates hors bornes exclut la pièce', () => {
    const r = searchSalesDocumentsInMemory(base({ from: '2026-06-01', to: '2026-06-30' }));
    expect(r.hits.map((h) => h.id)).toEqual(['i-1']);
  });

  it('pagination : limit + cursor traversent toutes les pages sans doublon ni trou', () => {
    const page1 = searchSalesDocumentsInMemory(base({ limit: 2 }));
    expect(page1.hits.map((h) => h.id)).toEqual(['i-1', 'i-2']);
    expect(page1.nextCursor).toBe('2');
    const page2 = searchSalesDocumentsInMemory(base({ limit: 2, cursor: page1.nextCursor ?? '0' }));
    expect(page2.hits.map((h) => h.id)).toEqual(['q-1']);
    expect(page2.nextCursor).toBeNull();
  });

  it('limit hors bornes est clampé (jamais 0, jamais > 50)', () => {
    expect(searchSalesDocumentsInMemory(base({ limit: 0 })).hits.length).toBeGreaterThan(0);
    expect(searchSalesDocumentsInMemory(base({ limit: 9999 })).hits.length).toBe(3);
  });

  it('requête sans AUCUN match : résultat vide, pas une erreur', () => {
    const r = searchSalesDocumentsInMemory(base({ query: 'inexistant' }));
    expect(r.hits).toEqual([]);
    expect(r.totalCount).toBe(0);
  });
});

describe('suggestSalesDocumentsInMemory (B9 — pendant démo/tests de GET /documents/suggest)', () => {
  it('requête vide -> aucune suggestion (les récentes restent un concern client)', () => {
    expect(suggestSalesDocumentsInMemory({ ...base(), query: '' }).suggestions).toEqual([]);
  });

  it('mélange typé customer/number/label, trié préfixe puis fréquence', () => {
    const r = suggestSalesDocumentsInMemory({ ...base(), query: 'martin' });
    expect(r.suggestions.some((s) => s.kind === 'customer' && s.value === 'SARL Martin Rénovation')).toBe(true);
    const customerSuggestion = r.suggestions.find((s) => s.kind === 'customer');
    // c-martin porte 2 pièces (q-1, i-2).
    expect(customerSuggestion?.count).toBe(2);
  });

  it('numéro : la suggestion porte le numéro complet', () => {
    const r = suggestSalesDocumentsInMemory({ ...base(), query: 'F-2026-000' });
    expect(r.suggestions.map((s) => s.value).sort()).toEqual(['F-2026-0001', 'F-2026-0002']);
  });

  it('libellé de ligne : compte les pièces distinctes portant ce libellé', () => {
    const r = suggestSalesDocumentsInMemory({ ...base(), query: 'peinture' });
    expect(r.suggestions).toEqual([{ kind: 'label', value: 'Peinture façade', count: 1 }]);
  });

  it('LIMIT 8 respecté même avec beaucoup de matches', () => {
    const manyCustomers = Array.from({ length: 20 }, (_, i) => ({ id: `c-${i}`, name: `Client Test ${i}` }));
    const r = suggestSalesDocumentsInMemory({ ...base(), customers: manyCustomers, query: 'test' });
    expect(r.suggestions.length).toBeLessThanOrEqual(8);
  });
});

import { describe, expect, it } from 'vitest';
import { salesDocumentMatchesActiveSearch } from './sales-search-result-policy';

describe('salesDocumentMatchesActiveSearch', () => {
  it('utilise le filtre local uniquement en l’absence de critères serveur', () => {
    expect(salesDocumentMatchesActiveSearch({
      id: 'q-1',
      localMatch: true,
      hasServerFilters: false,
      serverMatchedIds: null,
    })).toBe(true);
  });

  it('refuse tout repli local lorsque la recherche serveur n’a pas répondu', () => {
    expect(salesDocumentMatchesActiveSearch({
      id: 'q-1',
      localMatch: true,
      hasServerFilters: true,
      serverMatchedIds: null,
    })).toBe(false);
  });

  it('n’affiche que les identifiants confirmés par le serveur', () => {
    const serverMatchedIds = new Set(['q-2']);
    expect(salesDocumentMatchesActiveSearch({
      id: 'q-1', localMatch: true, hasServerFilters: true, serverMatchedIds,
    })).toBe(false);
    expect(salesDocumentMatchesActiveSearch({
      id: 'q-2', localMatch: false, hasServerFilters: true, serverMatchedIds,
    })).toBe(true);
  });
});

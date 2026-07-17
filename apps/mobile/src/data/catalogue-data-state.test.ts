import { describe, expect, it } from 'vitest';
import { catalogueDataMode } from './catalogue-data-state';

describe('catalogueDataMode', () => {
  it('ne présente jamais une erreur sans données comme un catalogue vide prêt', () => {
    expect(catalogueDataMode({ hasData: false, isLoading: false, isError: true })).toBe('error');
  });

  it('attend la première réponse serveur avant de conclure', () => {
    expect(catalogueDataMode({ hasData: false, isLoading: true, isError: false })).toBe('loading');
  });

  it('conserve une photographie serveur réelle lors d’un refetch en erreur', () => {
    expect(catalogueDataMode({ hasData: true, isLoading: false, isError: true })).toBe('ready');
  });
});

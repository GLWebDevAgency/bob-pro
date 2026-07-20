import { describe, expect, it } from 'vitest';
import { TODAY_QUICK_ACTIONS } from './today-quick-actions';
import { parseSalesDocumentRouteParams } from '../data/documents-search-route-params';

describe('Aujourd’hui — raccourcis manuels', () => {
  it('ne réintroduit jamais un deuxième point d’entrée vocal ou le wizard /voix', () => {
    expect(TODAY_QUICK_ACTIONS).toHaveLength(5);
    expect(TODAY_QUICK_ACTIONS.map((action) => action.id)).toEqual([
      'quote',
      'invoice',
      'scan',
      'collect',
      'catalogue',
    ]);
    expect(TODAY_QUICK_ACTIONS.some((action) => String(action.route) === '/voix')).toBe(false);
    expect(TODAY_QUICK_ACTIONS.some((action) => String(action.labelKey).includes('Voice'))).toBe(false);
  });

  it('conserve les cinq chemins manuels réels de la Home (B1 ajoute la facture directe)', () => {
    expect(TODAY_QUICK_ACTIONS.map((action) => action.route)).toEqual([
      '/devis/new',
      '/facture/new',
      '/scan-document',
      '/ventes?type=invoice&status=issued',
      '/catalogue',
    ]);
  });

  it('« À encaisser » ouvre /ventes pré-filtré factures émises — le deep link parle le vocabulaire EXACT du parseur (aucune dérive route/parseur possible)', () => {
    const collect = TODAY_QUICK_ACTIONS.find((action) => action.id === 'collect');
    expect(collect).toBeDefined();
    const query = String(collect!.route).split('?')[1] ?? '';
    const parsed = parseSalesDocumentRouteParams(Object.fromEntries(new URLSearchParams(query)));
    expect(parsed.kindFilter).toBe('invoices');
    expect(parsed.status).toBe('issued');
  });
});

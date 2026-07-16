import { describe, expect, it } from 'vitest';
import { TODAY_QUICK_ACTIONS } from './today-quick-actions';

describe('Aujourd’hui — raccourcis manuels', () => {
  it('ne réintroduit jamais un deuxième point d’entrée vocal ou le wizard /voix', () => {
    expect(TODAY_QUICK_ACTIONS).toHaveLength(3);
    expect(TODAY_QUICK_ACTIONS.map((action) => action.id)).toEqual(['quote', 'scan', 'collect']);
    expect(TODAY_QUICK_ACTIONS.some((action) => String(action.route) === '/voix')).toBe(false);
    expect(TODAY_QUICK_ACTIONS.some((action) => String(action.labelKey).includes('Voice'))).toBe(false);
  });

  it('conserve les trois chemins manuels réels de la Home', () => {
    expect(TODAY_QUICK_ACTIONS.map((action) => action.route)).toEqual([
      '/devis/new',
      '/scan-document',
      '/ventes',
    ]);
  });
});

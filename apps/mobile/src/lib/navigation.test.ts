/**
 * S7 — helper de sortie partagé devis/[id] ↔ facture/[id] : jamais d'utilisateur piégé,
 * même quand l'écran a été atteint par deep link (aucune pile derrière).
 */
import { describe, expect, it, vi } from 'vitest';
import { goBackOrHome, type BackCapableRouter } from './navigation';

function fakeRouter(canGoBack: boolean) {
  const back = vi.fn();
  const replace = vi.fn();
  const router = { canGoBack: () => canGoBack, back, replace } as unknown as BackCapableRouter;
  return { router, back, replace };
}

describe('goBackOrHome', () => {
  it('revient en arrière quand la pile le permet (jamais de replace parasite)', () => {
    const { router, back, replace } = fakeRouter(true);
    goBackOrHome(router);
    expect(back).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('replace vers l’accueil quand il n’y a aucune pile (deep link)', () => {
    const { router, back, replace } = fakeRouter(false);
    goBackOrHome(router);
    expect(back).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/(tabs)');
  });
});

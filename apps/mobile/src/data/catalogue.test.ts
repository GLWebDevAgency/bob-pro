import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readCustomPrestations } from './catalogue-storage';

describe('readCustomPrestations', () => {
  const getItem = vi.fn<() => Promise<string | null>>();

  beforeEach(() => getItem.mockReset());

  it('distingue un catalogue neuf d’un stockage illisible', async () => {
    getItem.mockResolvedValueOnce(null);
    await expect(readCustomPrestations(getItem)).resolves.toEqual([]);

    getItem.mockRejectedValueOnce(new Error('secure storage unavailable'));
    await expect(readCustomPrestations(getItem)).rejects.toThrow('secure storage unavailable');
  });

  it('relit uniquement un tableau entièrement valide', async () => {
    const prestation = {
      id: 'perso-1',
      label: 'Pose chauffe-eau',
      category: 'labor',
      unit: 'heure',
      unitPriceHT: 6_500,
      vatRate: 10,
    };
    getItem.mockResolvedValueOnce(JSON.stringify([prestation]));
    await expect(readCustomPrestations(getItem)).resolves.toEqual([prestation]);
  });

  it.each(['{broken', JSON.stringify({}), JSON.stringify([{ id: 'partial' }])])(
    'refuse une corruption au lieu de la présenter comme un catalogue vide',
    async (raw) => {
      getItem.mockResolvedValueOnce(raw);
      await expect(readCustomPrestations(getItem)).rejects.toThrow();
    },
  );
});

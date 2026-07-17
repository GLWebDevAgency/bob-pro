import { afterEach, describe, expect, it, vi } from 'vitest';
import { AddressLookupUnavailableError, BanAddressAdapter } from './ban-address.adapter';

describe('BanAddressAdapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('réserve le tableau vide à une réponse valide sans suggestion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ features: [] }), { status: 200 })),
    );

    await expect(
      new BanAddressAdapter('https://adresse.example').search('8 boulevard du Port'),
    ).resolves.toEqual([]);
  });

  it('remonte une panne amont au lieu de la transformer en absence de résultat', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));

    await expect(
      new BanAddressAdapter('https://adresse.example').search('8 boulevard du Port'),
    ).rejects.toBeInstanceOf(AddressLookupUnavailableError);
  });
});

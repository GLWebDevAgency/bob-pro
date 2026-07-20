import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CompanyLookupUnavailableError,
  RechercheEntreprisesAdapter,
} from './recherche-entreprises.adapter';

function upstream(result: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ results: [result] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('RechercheEntreprisesAdapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('n accepte qu une identité officielle correspondant exactement au SIRET demandé', async () => {
    const fetchMock = vi.fn(async () =>
      upstream({
        siren: '123456789',
        nom_complet: 'Société Test',
        activite_principale: '62.01Z',
        siege: {
          siret: '12345678900012',
          code_postal: '75001',
          libelle_commune: 'Paris',
          adresse: '1 rue de Test',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new RechercheEntreprisesAdapter('https://annuaire.example').lookupBySiret(
      '12345678900012',
    );

    expect(result).toMatchObject({
      siren: '123456789',
      siret: '12345678900012',
      denomination: 'Société Test',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('refuse un premier résultat approximatif au lieu de l attribuer au compte', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        upstream({
          siren: '987654321',
          nom_complet: 'Mauvaise société',
          siege: { siret: '98765432100019' },
        }),
      ),
    );

    await expect(
      new RechercheEntreprisesAdapter('https://annuaire.example').lookupBySiret('12345678900020'),
    ).resolves.toBeNull();
  });

  it('ne fabrique jamais une raison sociale absente de la source', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        upstream({
          siren: '111111111',
          siege: { siret: '11111111100018' },
        }),
      ),
    );

    await expect(
      new RechercheEntreprisesAdapter('https://annuaire.example').lookupBySiret('11111111100018'),
    ).rejects.toBeInstanceOf(CompanyLookupUnavailableError);
  });
});

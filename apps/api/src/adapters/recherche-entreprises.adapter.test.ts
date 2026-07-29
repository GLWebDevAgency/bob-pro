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

  // ── Établissements SECONDAIRES ──────────────────────────────────────────────
  // Reproduction du bug de production : l'identité n'était comparée QU'AU SIÈGE, donc tout
  // SIRET d'établissement secondaire tombait en `null` -> 404, alors que l'annuaire le connaît
  // (total_results = 1) et le renvoie dans `matching_etablissements`. Chaque cas utilise un NIC
  // distinct : le cache est statique (process-wide) et se partagerait entre tests sinon.

  it('résout un SIRET d établissement SECONDAIRE via matching_etablissements et rend le SIRET DEMANDÉ', async () => {
    const fetchMock = vi.fn(async () => upstream(CARREFOUR));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new RechercheEntreprisesAdapter('https://annuaire.example').lookupBySiret(
      '45132133501021',
    );

    expect(result).toMatchObject({
      siren: '451321335',
      siret: '45132133501021', // et surtout PAS 45132133500023 (le siège)
      denomination: 'CARREFOUR HYPERMARCHES',
      // L'unité légale porte 47.11F dans la fixture : le lookup rend bien l'activité de
      // l'établissement sélectionné, pas celle de l'entreprise.
      nafApe: '68.20B',
      etatAdministratif: 'A',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fait suivre l ADRESSE de l établissement demandé, jamais celle du siège', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        upstream({
          ...CARREFOUR,
          matching_etablissements: [
            {
              ...CARREFOUR.matching_etablissements[0],
              siret: '45132133501039',
            },
          ],
        }),
      ),
    );

    const result = await new RechercheEntreprisesAdapter('https://annuaire.example').lookupBySiret(
      '45132133501039',
    );

    // Le siège est à MASSY (91300) : facturer l'établissement de MONTREUIL à cette adresse serait
    // une erreur d'adressage silencieuse. Et `line1` ne doit PAS répéter « 93100 MONTREUIL », que
    // la facture imprime déjà sur la ligne suivante.
    expect(result?.address).toEqual({
      line1: '280 RUE DE PARIS',
      zip: '93100',
      city: 'MONTREUIL',
    });
  });

  it('rend une adresse nulle plutôt que celle du siège quand l amont ne la donne pas pour l établissement', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        upstream({
          ...CARREFOUR,
          matching_etablissements: [
            // L'amont connaît l'établissement mais ne publie ni code postal ni commune.
            { siret: '45132133501054', etat_administratif: 'A', est_siege: false },
          ],
        }),
      ),
    );

    const result = await new RechercheEntreprisesAdapter('https://annuaire.example').lookupBySiret(
      '45132133501054',
    );

    expect(result).toMatchObject({ siret: '45132133501054' });
    expect(result?.address).toBeNull();
  });

  it('rend une adresse nulle quand code postal et commune existent sans ligne de voie', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        upstream({
          ...CARREFOUR,
          matching_etablissements: [
            {
              siret: '45132133501062',
              code_postal: '69001',
              libelle_commune: 'LYON',
              etat_administratif: 'A',
            },
          ],
        }),
      ),
    );

    const result = await new RechercheEntreprisesAdapter('https://annuaire.example').lookupBySiret(
      '45132133501062',
    );
    expect(result?.address).toBeNull();
  });

  it('remonte l état administratif FERMÉ d un établissement au lieu de le taire', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        upstream({
          ...CARREFOUR,
          matching_etablissements: [
            {
              siret: '45132133501047',
              code_postal: '59000',
              libelle_commune: 'LILLE',
              adresse: '3 RUE FERMEE 59000 LILLE',
              etat_administratif: 'F',
              est_siege: false,
            },
          ],
        }),
      ),
    );

    const result = await new RechercheEntreprisesAdapter('https://annuaire.example').lookupBySiret(
      '45132133501047',
    );

    // Décision assumée : on REMONTE plutôt que de refuser. Un établissement fermé reste
    // facturable (facture finale, avoir, litige) ; le refuser serait indiscernable d'un
    // « introuvable » et l'appelant ne pourrait plus avertir.
    expect(result).toMatchObject({ siret: '45132133501047', etatAdministratif: 'F' });
  });

  it('ne confond pas le C de cessation d unité légale avec l état F d un établissement', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        upstream({
          ...CARREFOUR,
          matching_etablissements: [
            {
              ...CARREFOUR.matching_etablissements[0],
              siret: '45132133501070',
              etat_administratif: 'C',
            },
          ],
        }),
      ),
    );

    const result = await new RechercheEntreprisesAdapter('https://annuaire.example').lookupBySiret(
      '45132133501070',
    );
    expect(result?.etatAdministratif).toBeNull();
  });

  it('refuse (null) un SIRET absent du siège ET de matching_etablissements — jamais d à-peu-près', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => CARREFOUR_RESPONSE()));

    await expect(
      new RechercheEntreprisesAdapter('https://annuaire.example').lookupBySiret('45132133504199'),
    ).resolves.toBeNull();
  });

  it('refuse en le NOMMANT un établissement correspondant hors du SIREN annoncé', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        upstream({
          ...CARREFOUR,
          // Réponse amont qui se contredit : l'établissement « correspondant » appartient à un
          // autre SIREN que l'entreprise renvoyée. C'est une panne, pas un « introuvable ».
          matching_etablissements: [{ siret: '99999999900014', etat_administratif: 'A' }],
        }),
      ),
    );

    await expect(
      new RechercheEntreprisesAdapter('https://annuaire.example').lookupBySiret('99999999900014'),
    ).rejects.toBeInstanceOf(CompanyLookupUnavailableError);
  });

  it('refuse aussi un siège dont le SIRET contredit le SIREN annoncé', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        upstream({
          siren: '451321335',
          nom_complet: 'Réponse incohérente',
          siege: {
            siret: '73282932000074',
            adresse: '1 RUE TEST 75001 PARIS',
            code_postal: '75001',
            libelle_commune: 'PARIS',
          },
        }),
      ),
    );

    await expect(
      new RechercheEntreprisesAdapter('https://annuaire.example').lookupBySiret('73282932000074'),
    ).rejects.toThrow('établissement hors du SIREN annoncé');
  });

  it('remonte l état administratif du SIÈGE quand c est lui qui est demandé', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => CARREFOUR_RESPONSE()));

    const result = await new RechercheEntreprisesAdapter('https://annuaire.example').lookupBySiret(
      '45132133500023',
    );

    expect(result).toMatchObject({
      siret: '45132133500023',
      etatAdministratif: 'A',
      address: { line1: '93 AV DE PARIS', zip: '91300', city: 'MASSY' },
    });
  });
});

/**
 * Fixture contractuelle calquée sur la forme publique de Recherche d'entreprises : le siège et
 * l'établissement demandé sont distincts, de même que leurs adresses et activités. Ce n'est pas
 * un snapshot destiné à affirmer que ces données resteront identiques dans l'annuaire.
 */
const CARREFOUR = {
  siren: '451321335',
  nom_complet: 'CARREFOUR HYPERMARCHES',
  nom_raison_sociale: 'CARREFOUR HYPERMARCHES',
  activite_principale: '47.11F',
  nature_juridique: '5710',
  date_creation: '2000-01-03',
  etat_administratif: 'A',
  tva: 'FR90451321335',
  siege: {
    siret: '45132133500023',
    numero_voie: '93',
    type_voie: 'AV',
    libelle_voie: 'DE PARIS',
    adresse: '93 AV DE PARIS 91300 MASSY',
    code_postal: '91300',
    libelle_commune: 'MASSY',
    etat_administratif: 'A',
    est_siege: true,
  },
  // Fidèle à l'amont réel : un `matching_etablissements` ne publie PAS numero_voie/type_voie/
  // libelle_voie — seulement `adresse`, qui contient déjà le code postal et la commune.
  matching_etablissements: [
    {
      siret: '45132133501021',
      adresse: '280 RUE DE PARIS 93100 MONTREUIL',
      code_postal: '93100',
      libelle_commune: 'MONTREUIL',
      activite_principale: '68.20B',
      etat_administratif: 'A',
      est_siege: false,
    },
  ],
  complements: { est_rge: false },
};

const CARREFOUR_RESPONSE = (): Response => upstream(CARREFOUR);

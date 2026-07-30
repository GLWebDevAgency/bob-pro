import type {
  CatalogueCandidateSearchPort,
} from '@bob/core';
import {
  Prisma,
} from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaCatalogueCandidateSearch } from './catalogue-candidate.persistence';

const COMPANY = 'company-1';

function row(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `catalogue-${index}`,
    label: `Main-d'œuvre ${index}`,
    category: 'labor',
    unit: 'heure',
    unitPriceHT: 5_500 + index,
    vatRate: new Prisma.Decimal('20'),
    revision: index + 1,
    matchKind: index === 0 ? 'exact' : index === 1 ? 'prefix' : 'token',
    ...overrides,
  };
}

function harness(rows: readonly unknown[]) {
  const queryRaw = vi.fn(async () => rows);
  const transaction = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;
  return {
    search: new PrismaCatalogueCandidateSearch(transaction),
    queryRaw,
  };
}

function sql(mock: ReturnType<typeof vi.fn>): string {
  const call = mock.mock.calls[0] as readonly unknown[] | undefined;
  const strings = call?.[0] as readonly string[] | undefined;
  if (strings === undefined) return '';
  return strings
    .map((part, index) => {
      const value = call?.[index + 1];
      const nestedSql = (
        typeof value === 'object'
        && value !== null
        && 'sql' in value
        && typeof value.sql === 'string'
      )
        ? value.sql
        : '?';
      return `${part}${index < strings.length - 1 ? nestedSql : ''}`;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

describe('PrismaCatalogueCandidateSearch', () => {
  it.each(['', '   ', '🧾…?!'])(
    'ferme une recherche normalisée vide sans lancer de SQL (%j)',
    async (query) => {
      const h = harness([]);

      await expect(h.search.search({
        companyId: COMPANY,
        query,
        limit: 6,
      })).resolves.toEqual({ candidates: [], truncated: false });
      expect(h.queryRaw).not.toHaveBeenCalled();
    },
  );

  it('lit six vraies lignes, n’en expose que cinq et conserve ordre et révisions', async () => {
    const h = harness(Array.from({ length: 6 }, (_, index) => row(index)));

    const result = await h.search.search({
      companyId: COMPANY,
      query: 'Main-d’œuvre plomberie',
      limit: 6,
    });

    expect(result.truncated).toBe(true);
    expect(result.candidates).toHaveLength(5);
    expect(result.candidates.map((candidate) => candidate.id)).toEqual([
      'catalogue-0',
      'catalogue-1',
      'catalogue-2',
      'catalogue-3',
      'catalogue-4',
    ]);
    expect(result.candidates[0]).toMatchObject({
      matchKind: 'exact',
      revision: 1,
      unitPriceHT: 5_500,
      vatRate: 20,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.candidates)).toBe(true);
    expect(Object.isFrozen(result.candidates[0])).toBe(true);

    const statement = sql(h.queryRaw);
    expect(statement).toContain(
      'FROM public.catalogue_prestation_search_tokens AS search_token',
    );
    expect(statement).toContain('search_token."companyId" = ?');
    expect(statement).toContain('search_token.token IN (?,?,?,?)');
    expect(statement).toContain('HAVING pg_catalog.count(*) = ?');
    expect(statement).toContain('exact_match."companyId" = ?');
    expect(statement).toContain('prefix_match."searchKey" ~>=~ ?');
    expect(statement).toContain('prefix_match."searchKey" ~<~ (? ||');
    expect(statement).toContain('pg_catalog.min(matching_id.match_rank)');
    expect(statement).toContain('c."companyId" = ?');
    expect(statement).toContain('c."id" = ranked_id."id"');
    expect(statement).not.toContain('to_tsvector');
    expect(statement).toContain('ORDER BY ranked_id.match_rank ASC');
    expect(statement).toContain('c."searchKey" COLLATE "C" ASC');
    expect(statement).toContain('LIMIT ? FOR SHARE OF c');
    expect(JSON.stringify(h.queryRaw.mock.calls)).toContain(COMPANY);
  });

  it('retourne zéro à cinq candidats sans fausse troncature', async () => {
    const h = harness([row(0), row(1)]);
    await expect(h.search.search({
      companyId: COMPANY,
      query: 'main oeuvre',
      limit: 6,
    })).resolves.toMatchObject({
      truncated: false,
      candidates: [{ id: 'catalogue-0' }, { id: 'catalogue-1' }],
    });
  });

  it('échoue fermé avant SQL sur une portée ou une limite non canonique', async () => {
    const h = harness([]);
    const port = h.search as CatalogueCandidateSearchPort;

    await expect(port.search({
      companyId: ' company-1',
      query: 'plomberie',
      limit: 6,
    })).rejects.toThrow('AGENT_MISSION_CATALOGUE_SEARCH_INPUT_INVALID');
    await expect((port.search as (input: unknown) => Promise<unknown>)({
      companyId: COMPANY,
      query: 'plomberie',
      limit: 5,
    })).rejects.toThrow('AGENT_MISSION_CATALOGUE_SEARCH_INPUT_INVALID');
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it('préserve sans troncature une normalisation qui double les 500 caractères admis', async () => {
    const h = harness([]);

    await expect(h.search.search({
      companyId: COMPANY,
      query: 'œ'.repeat(500),
      limit: 6,
    })).resolves.toEqual({ candidates: [], truncated: false });

    expect(h.queryRaw).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.queryRaw.mock.calls)).toContain('oe'.repeat(500));
  });

  it('refuse une requête brute au-delà de la borne avant tout SQL', async () => {
    const h = harness([]);

    await expect(h.search.search({
      companyId: COMPANY,
      query: 'a'.repeat(501),
      limit: 6,
    })).rejects.toThrow('AGENT_MISSION_CATALOGUE_SEARCH_INPUT_INVALID');
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it('échoue fermé sur une ligne corrompue au lieu de fabriquer une valeur', async () => {
    const h = harness([row(0, { category: 'unknown' })]);
    await expect(h.search.search({
      companyId: COMPANY,
      query: 'main oeuvre',
      limit: 6,
    })).rejects.toThrow('AGENT_MISSION_CATALOGUE_ROW_CORRUPT');
  });

  it('refuse un taux décimal voisin au lieu de l’arrondir en IEEE-754', async () => {
    const h = harness([
      row(0, { vatRate: new Prisma.Decimal('20.0000000000000001') }),
    ]);
    await expect(h.search.search({
      companyId: COMPANY,
      query: 'main oeuvre',
      limit: 6,
    })).rejects.toThrow('AGENT_MISSION_CATALOGUE_ROW_CORRUPT');
  });

  it('relit par tenant et identifiant sous verrou partagé', async () => {
    const h = harness([row(0)]);
    await expect(h.search.getById({
      companyId: COMPANY,
      id: 'catalogue-0',
    })).resolves.toMatchObject({
      id: 'catalogue-0',
      revision: 1,
      label: "Main-d'œuvre 0",
    });
    const statement = sql(h.queryRaw);
    expect(statement).toContain('c."companyId" = ?');
    expect(statement).toContain('c."id" = ?');
    expect(statement).toContain('LIMIT 1 FOR SHARE OF c');
    expect(JSON.stringify(h.queryRaw.mock.calls)).toContain(COMPANY);
    expect(JSON.stringify(h.queryRaw.mock.calls)).toContain('catalogue-0');
  });

  it('échoue fermé sans SQL pour un identifiant non canonique', async () => {
    const h = harness([]);
    await expect(h.search.getById({
      companyId: COMPANY,
      id: 'catalogue/../../autre-tenant',
    })).rejects.toThrow('AGENT_MISSION_CATALOGUE_LOOKUP_INPUT_INVALID');
    expect(h.queryRaw).not.toHaveBeenCalled();
  });
});

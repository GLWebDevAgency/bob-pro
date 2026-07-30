import {
  CATALOGUE_CANDIDATE_PRESENTATION_LIMIT,
  CATALOGUE_CANDIDATE_QUERY_MAX_LENGTH,
  CATALOGUE_CANDIDATE_SEARCH_LIMIT,
  isCustomPrestationId,
  isCanonicalAgentMissionOpaqueIdentifier,
  normalizeCatalogueSearchKey,
  parseCustomPrestation,
  type CatalogueCandidate,
  type CatalogueCandidateMatchKind,
  type CatalogueCandidateRecord,
  type CatalogueCandidateSearchPort,
} from '@bob/core';
import {
  Prisma,
} from '@prisma/client';
import { canonicalPrismaVatRate } from './prisma-vat-rate';

const INT4_MAX = 2_147_483_647;

interface CatalogueCandidateRow {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  readonly unit: string | null;
  readonly unitPriceHT: number;
  readonly vatRate: Prisma.Decimal;
  readonly revision: number;
  readonly matchKind?: string;
}

function canonicalCatalogueRecord(row: CatalogueCandidateRow): CatalogueCandidateRecord {
  const vatRate = canonicalPrismaVatRate(row.vatRate);
  const prestation = parseCustomPrestation({
    id: row.id,
    label: row.label,
    category: row.category,
    unit: row.unit,
    unitPriceHT: row.unitPriceHT,
    vatRate,
  });
  if (
    prestation === null
    || !Number.isSafeInteger(row.revision)
    || row.revision < 1
    || row.revision > INT4_MAX
  ) {
    throw new Error('AGENT_MISSION_CATALOGUE_ROW_CORRUPT');
  }
  return Object.freeze({ ...prestation, revision: row.revision });
}

function canonicalMatchKind(value: unknown): CatalogueCandidateMatchKind {
  if (value === 'exact' || value === 'prefix' || value === 'token') return value;
  throw new Error('AGENT_MISSION_CATALOGUE_MATCH_KIND_CORRUPT');
}

function canonicalCatalogueCandidate(row: CatalogueCandidateRow): CatalogueCandidate {
  return Object.freeze({
    ...canonicalCatalogueRecord(row),
    matchKind: canonicalMatchKind(row.matchKind),
  });
}

function validCompanyId(value: string): boolean {
  return value.length <= 200 && isCanonicalAgentMissionOpaqueIdentifier(value);
}

/**
 * Recherche catalogue M2-A tenantée et verrouillée. La sixième ligne est une vraie ligne de
 * détection de troncature : elle est verrouillée mais jamais projetée comme candidat.
 */
export class PrismaCatalogueCandidateSearch
implements CatalogueCandidateSearchPort {
  constructor(private readonly transaction: Prisma.TransactionClient) {}

  async search(input: {
    readonly companyId: string;
    readonly query: string;
    readonly limit: typeof CATALOGUE_CANDIDATE_SEARCH_LIMIT;
  }) {
    if (
      input.limit !== CATALOGUE_CANDIDATE_SEARCH_LIMIT
      || !validCompanyId(input.companyId)
      || typeof input.query !== 'string'
      || input.query.length > CATALOGUE_CANDIDATE_QUERY_MAX_LENGTH
    ) {
      throw new Error('AGENT_MISSION_CATALOGUE_SEARCH_INPUT_INVALID');
    }
    const query = normalizeCatalogueSearchKey(input.query);
    if (query === '') {
      return Object.freeze({
        candidates: Object.freeze([]),
        truncated: false,
      });
    }
    const queryTokens = [...new Set(query.split(' '))];

    const rows = await this.transaction.$queryRaw<CatalogueCandidateRow[]>`
      WITH matching_ids AS (
        SELECT exact_match."id", 0::SMALLINT AS match_rank
        FROM public.catalogue_prestations AS exact_match
        WHERE exact_match."companyId" = ${input.companyId}
          AND exact_match."searchKey" = ${query}

        UNION ALL

        SELECT prefix_match."id", 1::SMALLINT AS match_rank
        FROM public.catalogue_prestations AS prefix_match
        WHERE prefix_match."companyId" = ${input.companyId}
          AND prefix_match."searchKey" ~>=~ ${query}
          AND prefix_match."searchKey" ~<~ (${query} || '{')
          AND prefix_match."searchKey" <> ${query}

        UNION ALL

        SELECT search_token."catalogueItemId", 2::SMALLINT AS match_rank
        FROM public.catalogue_prestation_search_tokens AS search_token
        WHERE search_token."companyId" = ${input.companyId}
          AND search_token.token IN (${Prisma.join(queryTokens)})
        GROUP BY
          search_token."companyId",
          search_token."catalogueItemId"
        HAVING pg_catalog.count(*) = ${queryTokens.length}
      ),
      ranked_ids AS (
        SELECT
          matching_id."id",
          pg_catalog.min(matching_id.match_rank) AS match_rank
        FROM matching_ids AS matching_id
        GROUP BY matching_id."id"
      )
      SELECT
        c."id",
        c."label",
        c."category"::TEXT AS "category",
        c."unit",
        c."unitPriceHt" AS "unitPriceHT",
        c."vatRate",
        c."revision",
        CASE
          WHEN ranked_id.match_rank = 0 THEN 'exact'::TEXT
          WHEN ranked_id.match_rank = 1 THEN 'prefix'::TEXT
          ELSE 'token'::TEXT
        END AS "matchKind"
      FROM ranked_ids AS ranked_id
      JOIN public.catalogue_prestations AS c
        ON c."companyId" = ${input.companyId}
       AND c."id" = ranked_id."id"
      ORDER BY
        ranked_id.match_rank ASC,
        c."searchKey" COLLATE "C" ASC,
        c."id" ASC
      LIMIT ${CATALOGUE_CANDIDATE_SEARCH_LIMIT}
      FOR SHARE OF c
    `;
    if (rows.length > CATALOGUE_CANDIDATE_SEARCH_LIMIT) {
      throw new Error('AGENT_MISSION_CATALOGUE_SEARCH_LIMIT_BROKEN');
    }
    const candidates = rows
      .slice(0, CATALOGUE_CANDIDATE_PRESENTATION_LIMIT)
      .map(canonicalCatalogueCandidate);
    return Object.freeze({
      candidates: Object.freeze(candidates),
      truncated: rows.length === CATALOGUE_CANDIDATE_SEARCH_LIMIT,
    });
  }

  async getById(input: {
    readonly companyId: string;
    readonly id: string;
  }): Promise<CatalogueCandidateRecord | null> {
    if (!validCompanyId(input.companyId) || !isCustomPrestationId(input.id)) {
      throw new Error('AGENT_MISSION_CATALOGUE_LOOKUP_INPUT_INVALID');
    }
    const rows = await this.transaction.$queryRaw<CatalogueCandidateRow[]>`
      SELECT
        c."id",
        c."label",
        c."category"::TEXT AS "category",
        c."unit",
        c."unitPriceHt" AS "unitPriceHT",
        c."vatRate",
        c."revision"
      FROM public.catalogue_prestations AS c
      WHERE c."companyId" = ${input.companyId}
        AND c."id" = ${input.id}
      LIMIT 1
      FOR SHARE OF c
    `;
    return rows[0] === undefined ? null : canonicalCatalogueRecord(rows[0]);
  }
}

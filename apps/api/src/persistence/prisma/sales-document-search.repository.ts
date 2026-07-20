import { Prisma } from '@prisma/client';
import {
  clampSalesDocumentSearchLimit,
  type SalesDocumentSearchPort,
  type SearchSalesDocumentsInput,
  type SearchSalesDocumentsResult,
  type SuggestSalesDocumentsInput,
  type SuggestSalesDocumentsResult,
} from '@bob/core';
import { PrismaService } from './prisma.service';

/**
 * B9 — GET /documents/search & GET /documents/suggest, adossés à Postgres/pg_trgm (migration
 * b9_documents_search_indexes). Requêtes en lecture directe (SQL brut) plutôt que via
 * QuoteRepository/InvoiceRepository : c'est un modèle de LECTURE joignant quotes/invoices/
 * customers/line_items pour un classement pertinence+date — reconstruire les agrégats de
 * domaine par résultat serait inutile (aucune règle métier ici) et coûteux (N+1). Le tenant est
 * DOUBLEMENT scopé : filtre applicatif "companyId" dans chaque branche (défense en profondeur)
 * + RLS Postgres (tenant_isolation, déjà FORCE sur quotes/invoices/customers/line_items).
 *
 * Le classement pertinence utilise word_similarity() sur immutable_unaccent(lower(...)) —
 * accents/casse ignorés (mesuré : similarity('Mairie de Sèvres','sevres') = 0.2, sous le seuil
 * pg_trgm par défaut, alors qu'unaccenté+minuscule ça monte à 1.0 — voir la migration pour le
 * détail). L'opérateur `<%` est celui que l'index GIN d'expression sait accélérer.
 */

interface PieceRow {
  source: 'quote' | 'invoice';
  id: string;
  number: string | null;
  customerId: string;
  customerName: string;
  status: string;
  date: Date | null;
  totalsHt: number;
  totalsVat: number;
  totalsTtc: number;
  totalsNetToPay: number;
  vatByRate: Record<string, number>;
  matchedLineLabel: string | null;
  totalCount: number;
}

function toDateOnly(d: Date | null): string | null {
  return d === null ? null : d.toISOString().slice(0, 10);
}

function quoteBranch(companyId: string, q: string, hasQuery: boolean): Prisma.Sql {
  return Prisma.sql`
    SELECT
      'quote'::text AS source,
      q.id, q.number, q."customerId", c.name AS "customerName", q.status::text AS status,
      q."createdAt" AS date,
      q."totalsHt", q."totalsVat", q."totalsTtc", q."totalsNetToPay", q."vatByRate",
      (
        SELECT li.label FROM line_items li
        WHERE li."quoteId" = q.id AND (NOT ${hasQuery} OR ${q} <% immutable_unaccent(lower(li.label)))
        ORDER BY word_similarity(${q}, immutable_unaccent(lower(li.label))) DESC
        LIMIT 1
      ) AS "matchedLineLabel",
      CASE WHEN NOT ${hasQuery} THEN 0::real ELSE GREATEST(
        CASE WHEN lower(q.number) = lower(${q}) THEN 1.0 ELSE 0 END,
        COALESCE(word_similarity(${q}, immutable_unaccent(lower(q.number))), 0),
        word_similarity(${q}, immutable_unaccent(lower(c.name))) * 0.9,
        COALESCE(
          (SELECT MAX(word_similarity(${q}, immutable_unaccent(lower(li2.label))))
           FROM line_items li2 WHERE li2."quoteId" = q.id),
          0
        ) * 0.7
      ) END AS rank
    FROM quotes q
    JOIN customers c ON c.id = q."customerId"
    WHERE q."companyId" = ${companyId}
      AND (
        NOT ${hasQuery}
        OR ${q} <% immutable_unaccent(lower(q.number))
        OR ${q} <% immutable_unaccent(lower(c.name))
        OR EXISTS (SELECT 1 FROM line_items li3 WHERE li3."quoteId" = q.id AND ${q} <% immutable_unaccent(lower(li3.label)))
      )
  `;
}

function invoiceBranch(companyId: string, q: string, hasQuery: boolean): Prisma.Sql {
  return Prisma.sql`
    SELECT
      'invoice'::text AS source,
      i.id, i.number, i."customerId", c.name AS "customerName", i.status::text AS status,
      i."issuedAt" AS date,
      i."totalsHt", i."totalsVat", i."totalsTtc", i."totalsNetToPay", i."vatByRate",
      (
        SELECT li.label FROM line_items li
        WHERE li."invoiceId" = i.id AND (NOT ${hasQuery} OR ${q} <% immutable_unaccent(lower(li.label)))
        ORDER BY word_similarity(${q}, immutable_unaccent(lower(li.label))) DESC
        LIMIT 1
      ) AS "matchedLineLabel",
      CASE WHEN NOT ${hasQuery} THEN 0::real ELSE GREATEST(
        CASE WHEN lower(i.number) = lower(${q}) THEN 1.0 ELSE 0 END,
        COALESCE(word_similarity(${q}, immutable_unaccent(lower(i.number))), 0),
        word_similarity(${q}, immutable_unaccent(lower(c.name))) * 0.9,
        COALESCE(
          (SELECT MAX(word_similarity(${q}, immutable_unaccent(lower(li2.label))))
           FROM line_items li2 WHERE li2."invoiceId" = i.id),
          0
        ) * 0.7
      ) END AS rank
    FROM invoices i
    JOIN customers c ON c.id = i."customerId"
    WHERE i."companyId" = ${companyId}
      AND (
        NOT ${hasQuery}
        OR ${q} <% immutable_unaccent(lower(i.number))
        OR ${q} <% immutable_unaccent(lower(c.name))
        OR EXISTS (SELECT 1 FROM line_items li3 WHERE li3."invoiceId" = i.id AND ${q} <% immutable_unaccent(lower(li3.label)))
      )
  `;
}

export class PrismaSalesDocumentSearchRepository implements SalesDocumentSearchPort {
  constructor(private readonly prisma: PrismaService) {}

  async search(input: SearchSalesDocumentsInput & { companyId: string }): Promise<SearchSalesDocumentsResult> {
    const q = input.query.trim();
    const hasQuery = q.length > 0;
    const limit = clampSalesDocumentSearchLimit(input.limit);
    const offset = input.cursor !== undefined && /^\d+$/.test(input.cursor) ? Number(input.cursor) : 0;
    const from = input.from !== undefined ? new Date(`${input.from}T00:00:00.000Z`) : null;
    const to = input.to !== undefined ? new Date(`${input.to}T23:59:59.999Z`) : null;
    const customerId = input.customerId ?? null;
    const status = input.status ?? null;

    const branches: Prisma.Sql[] = [];
    if (input.scope !== 'invoice') branches.push(quoteBranch(input.companyId, q, hasQuery));
    if (input.scope !== 'quote') branches.push(invoiceBranch(input.companyId, q, hasQuery));
    const union = branches.reduce((acc, branch, i) => (i === 0 ? branch : Prisma.sql`${acc} UNION ALL ${branch}`));

    const rows = await this.prisma.client().$queryRaw<PieceRow[]>(Prisma.sql`
      SELECT *, COUNT(*) OVER()::int AS "totalCount" FROM (${union}) piece
      WHERE (${customerId}::text IS NULL OR piece."customerId" = ${customerId})
        AND (${status}::text IS NULL OR piece.status = ${status})
        AND (${from}::timestamp IS NULL OR piece.date >= ${from})
        AND (${to}::timestamp IS NULL OR piece.date <= ${to})
      ORDER BY piece.rank DESC, piece.date DESC NULLS LAST, piece.id ASC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const totalCount = rows.length > 0 ? rows[0]!.totalCount : 0;
    return {
      hits: rows.map((row) => ({
        source: row.source,
        id: row.id,
        number: row.number,
        customerId: row.customerId,
        customerName: row.customerName,
        status: row.status,
        date: toDateOnly(row.date),
        totals: {
          ht: row.totalsHt,
          vat: row.totalsVat,
          ttc: row.totalsTtc,
          netToPay: row.totalsNetToPay,
          vatByRate: row.vatByRate,
        },
        matchedLineLabel: row.matchedLineLabel,
      })),
      totalCount,
      nextCursor: offset + rows.length < totalCount ? String(offset + rows.length) : null,
    };
  }

  async suggest(input: SuggestSalesDocumentsInput & { companyId: string }): Promise<SuggestSalesDocumentsResult> {
    const q = input.query.trim();
    if (q.length === 0) return { suggestions: [] };
    const limit = input.limit !== undefined ? Math.max(1, Math.min(8, input.limit)) : 8;

    interface SuggestRow {
      kind: 'customer' | 'number' | 'label';
      value: string;
      count: number;
    }

    const rows = await this.prisma.client().$queryRaw<SuggestRow[]>(Prisma.sql`
      WITH pieces AS (
        SELECT "customerId", number, id, "companyId" FROM quotes WHERE "companyId" = ${input.companyId}
        UNION ALL
        SELECT "customerId", number, id, "companyId" FROM invoices WHERE "companyId" = ${input.companyId}
      ),
      customer_hits AS (
        SELECT
          'customer'::text AS kind,
          c.name AS value,
          (SELECT COUNT(*) FROM pieces p WHERE p."customerId" = c.id)::int AS count,
          CASE WHEN immutable_unaccent(lower(c.name)) LIKE immutable_unaccent(lower(${q})) || '%' THEN 0 ELSE 1 END AS rnk
        FROM customers c
        WHERE c."companyId" = ${input.companyId} AND ${q} <% immutable_unaccent(lower(c.name))
      ),
      number_hits AS (
        SELECT DISTINCT ON (p.number)
          'number'::text AS kind,
          p.number AS value,
          1 AS count,
          CASE WHEN immutable_unaccent(lower(p.number)) LIKE immutable_unaccent(lower(${q})) || '%' THEN 0 ELSE 1 END AS rnk
        FROM pieces p
        WHERE p.number IS NOT NULL AND ${q} <% immutable_unaccent(lower(p.number))
      ),
      label_hits AS (
        SELECT
          'label'::text AS kind,
          li.label AS value,
          COUNT(DISTINCT COALESCE(li."quoteId", li."invoiceId"))::int AS count,
          CASE WHEN immutable_unaccent(lower(li.label)) LIKE immutable_unaccent(lower(${q})) || '%' THEN 0 ELSE 1 END AS rnk
        FROM line_items li
        JOIN pieces p ON p.id = COALESCE(li."quoteId", li."invoiceId")
        WHERE ${q} <% immutable_unaccent(lower(li.label))
        GROUP BY li.label
      )
      SELECT kind, value, count FROM (
        SELECT * FROM customer_hits
        UNION ALL SELECT * FROM number_hits
        UNION ALL SELECT * FROM label_hits
      ) merged
      ORDER BY rnk ASC, count DESC, value ASC
      LIMIT ${limit}
    `);

    return { suggestions: rows };
  }
}

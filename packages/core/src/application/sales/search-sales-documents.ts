import { type DateOnly } from '../../shared-kernel/time';
import { type Totals } from '../../domain/billing/shared/totals';

/**
 * B9 — Recherche intelligente Devis & Factures. Les DTOs ci-dessous sont le contrat PARTAGÉ
 * entre l'API (GET /documents/search, GET /documents/suggest, backés Postgres/pg_trgm) et le
 * client (@bob/api-client) : une seule définition de forme, jamais deux à faire dériver.
 */

/**
 * Normalisation dédiée à la recherche libre (nom client / numéro / libellé de ligne) : accents
 * et casse ignorés COMME normalizeSupplierName, mais la ponctuation (tirets compris) devient un
 * espace — un « chauffe-eau » tapé « chauffe eau » doit quand même retrouver la ligne, exactement
 * le vocabulaire du bâtiment (chauffe-eau, porte-fenêtre…).
 */
function normalizeSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/œ/gi, 'oe')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type SalesDocumentKind = 'quote' | 'invoice';
export type SalesDocumentSearchScope = SalesDocumentKind | 'all';

export interface SearchSalesDocumentsInput {
  readonly query: string;
  readonly scope: SalesDocumentSearchScope;
  /** Bornes incluses, "YYYY-MM-DD". */
  readonly from?: DateOnly;
  readonly to?: DateOnly;
  readonly customerId?: string;
  readonly status?: string;
  /** Offset opaque (page suivante) — absent = première page. */
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SalesDocumentSearchHit {
  readonly source: SalesDocumentKind;
  readonly id: string;
  readonly number: string | null;
  readonly customerId: string;
  readonly customerName: string;
  readonly status: string;
  /** Date de référence (Invoice.issuedAt / Quote.createdAt) — null = pas encore émis/connue. */
  readonly date: DateOnly | null;
  readonly totals: Totals;
  /** Libellé de LIGNE ayant matché la requête (aperçu « chauffe-eau » -> quelle ligne) — null si
   * le match vient du numéro/nom client, ou si la requête est vide. */
  readonly matchedLineLabel: string | null;
}

export interface SearchSalesDocumentsResult {
  readonly hits: readonly SalesDocumentSearchHit[];
  readonly totalCount: number;
  readonly nextCursor: string | null;
}

export type SalesDocumentSuggestionKind = 'customer' | 'number' | 'label';

export interface SuggestSalesDocumentsInput {
  readonly query: string;
  readonly limit?: number;
}

export interface SalesDocumentSuggestion {
  readonly kind: SalesDocumentSuggestionKind;
  readonly value: string;
  /** Nombre de pièces concernées par cette suggestion (tenant courant). */
  readonly count: number;
}

export interface SuggestSalesDocumentsResult {
  readonly suggestions: readonly SalesDocumentSuggestion[];
}

export const SALES_DOCUMENT_SEARCH_DEFAULT_LIMIT = 20;
export const SALES_DOCUMENT_SEARCH_MAX_LIMIT = 50;
export const SALES_DOCUMENT_SUGGEST_LIMIT = 8;

/** Borne un limit client (jamais 0, jamais > MAX — un client mal formé ne doit pas ratisser tout le tenant). */
export function clampSalesDocumentSearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SALES_DOCUMENT_SEARCH_DEFAULT_LIMIT;
  return Math.min(SALES_DOCUMENT_SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Implémentation EN MÉMOIRE (pure, sans I/O) : réutilisée par le mode démo de l'API
// (InMemoryPersistence) ET par LocalBobClient (@bob/api-client, offline/tests) — même forme de
// résultat que le chemin Postgres réel, ranking simplifié (pas de trigram en mémoire).
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface SalesDocumentSearchCustomer {
  readonly id: string;
  readonly name: string;
}

export interface SalesDocumentSearchPiece {
  readonly id: string;
  readonly number: string | null;
  readonly customerId: string;
  readonly status: string;
  /** null = date métier inconnue dans ce chemin (ex. Quote n'a pas de date en mémoire) — exclue
   * de toute plage de dates active, jamais devinée. */
  readonly date: DateOnly | null;
  readonly totals: Totals;
  readonly lines: readonly { readonly label: string }[];
}

export interface SearchSalesDocumentsInMemoryInput extends SearchSalesDocumentsInput {
  readonly customers: readonly SalesDocumentSearchCustomer[];
  readonly quotes: readonly SalesDocumentSearchPiece[];
  readonly invoices: readonly SalesDocumentSearchPiece[];
}

interface ScoredHit {
  readonly hit: SalesDocumentSearchHit;
  readonly score: number;
}

function inRange(date: DateOnly | null, from: string | undefined, to: string | undefined): boolean {
  if (from === undefined && to === undefined) return true;
  if (date === null) return false;
  if (from !== undefined && date < from) return false;
  if (to !== undefined && date > to) return false;
  return true;
}

function scorePiece(
  source: SalesDocumentKind,
  piece: SalesDocumentSearchPiece,
  customerName: string,
  q: string,
): { score: number; matchedLineLabel: string | null } | null {
  if (q.length === 0) return { score: 0, matchedLineLabel: null };
  const number = piece.number !== null ? normalizeSearchText(piece.number) : '';
  const name = normalizeSearchText(customerName);
  if (number.length > 0 && number === q) return { score: 100, matchedLineLabel: null };
  if (number.length > 0 && number.startsWith(q)) return { score: 90, matchedLineLabel: null };
  if (number.length > 0 && number.includes(q)) return { score: 80, matchedLineLabel: null };
  if (name.startsWith(q)) return { score: 70, matchedLineLabel: null };
  if (name.includes(q)) return { score: 60, matchedLineLabel: null };
  const line = piece.lines.find((l) => normalizeSearchText(l.label).includes(q));
  if (line) return { score: 40, matchedLineLabel: line.label };
  return null;
}

/** Pendant en mémoire de GET /documents/search (Postgres/pg_trgm) — voir le fichier d'en-tête. */
export function searchSalesDocumentsInMemory(input: SearchSalesDocumentsInMemoryInput): SearchSalesDocumentsResult {
  const q = normalizeSearchText(input.query);
  const nameById = new Map(input.customers.map((c) => [c.id, c.name]));
  const scored: ScoredHit[] = [];

  const consider = (source: SalesDocumentKind, piece: SalesDocumentSearchPiece) => {
    if (input.customerId !== undefined && piece.customerId !== input.customerId) return;
    if (input.status !== undefined && piece.status !== input.status) return;
    if (!inRange(piece.date, input.from, input.to)) return;
    const customerName = nameById.get(piece.customerId) ?? '';
    const matched = scorePiece(source, piece, customerName, q);
    if (matched === null) return;
    scored.push({
      score: matched.score,
      hit: {
        source,
        id: piece.id,
        number: piece.number,
        customerId: piece.customerId,
        customerName,
        status: piece.status,
        date: piece.date,
        totals: piece.totals,
        matchedLineLabel: matched.matchedLineLabel,
      },
    });
  };

  if (input.scope !== 'invoice') for (const quote of input.quotes) consider('quote', quote);
  if (input.scope !== 'quote') for (const invoice of input.invoices) consider('invoice', invoice);

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const ad = a.hit.date ?? '';
    const bd = b.hit.date ?? '';
    if (ad !== bd) return bd.localeCompare(ad);
    return a.hit.id.localeCompare(b.hit.id);
  });

  const limit = clampSalesDocumentSearchLimit(input.limit);
  const offset = input.cursor !== undefined && /^\d+$/.test(input.cursor) ? Number(input.cursor) : 0;
  const page = scored.slice(offset, offset + limit);
  const nextOffset = offset + limit;

  return {
    hits: page.map((entry) => entry.hit),
    totalCount: scored.length,
    nextCursor: nextOffset < scored.length ? String(nextOffset) : null,
  };
}

/** Pendant en mémoire de GET /documents/suggest (Postgres/pg_trgm) — voir le fichier d'en-tête. */
export function suggestSalesDocumentsInMemory(
  input: SuggestSalesDocumentsInput & {
    readonly customers: readonly SalesDocumentSearchCustomer[];
    readonly quotes: readonly SalesDocumentSearchPiece[];
    readonly invoices: readonly SalesDocumentSearchPiece[];
  },
): SuggestSalesDocumentsResult {
  const q = normalizeSearchText(input.query);
  if (q.length === 0) return { suggestions: [] };
  const limit = input.limit !== undefined ? Math.max(1, Math.min(SALES_DOCUMENT_SUGGEST_LIMIT, input.limit)) : SALES_DOCUMENT_SUGGEST_LIMIT;
  const pieces = [...input.quotes, ...input.invoices];

  const customerCounts = new Map<string, number>();
  for (const piece of pieces) customerCounts.set(piece.customerId, (customerCounts.get(piece.customerId) ?? 0) + 1);

  const customerHits = input.customers
    .filter((c) => normalizeSearchText(c.name).includes(q))
    .map((c) => ({
      kind: 'customer' as const,
      value: c.name,
      count: customerCounts.get(c.id) ?? 0,
      rank: normalizeSearchText(c.name).startsWith(q) ? 0 : 1,
    }));

  const numberHits = pieces
    .filter((p): p is SalesDocumentSearchPiece & { number: string } => p.number !== null && normalizeSearchText(p.number).includes(q))
    .map((p) => ({
      kind: 'number' as const,
      value: p.number,
      count: 1,
      rank: normalizeSearchText(p.number).startsWith(q) ? 0 : 1,
    }));

  const labelCounts = new Map<string, number>();
  for (const piece of pieces) {
    for (const line of piece.lines) {
      if (!normalizeSearchText(line.label).includes(q)) continue;
      labelCounts.set(line.label, (labelCounts.get(line.label) ?? 0) + 1);
    }
  }
  const labelHits = [...labelCounts.entries()].map(([value, count]) => ({
    kind: 'label' as const,
    value,
    count,
    rank: normalizeSearchText(value).startsWith(q) ? 0 : 1,
  }));

  const merged = [...customerHits, ...numberHits, ...labelHits]
    .sort((a, b) => a.rank - b.rank || b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, limit)
    .map(({ kind, value, count }) => ({ kind, value, count }));

  return { suggestions: merged };
}

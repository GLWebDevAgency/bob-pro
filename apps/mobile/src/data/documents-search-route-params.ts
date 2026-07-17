/**
 * B9 — traduit les paramètres de route du deep link vocal (/ventes?type=&from=&to=&customerId=)
 * en filtres écran. Fonction PURE (aucun hook, aucun router) : ventes.tsx ne fait qu'appliquer
 * le résultat via ses setters dans un useEffect — la logique de traduction reste testable seule,
 * sans avoir à monter tout l'écran.
 */
import { isValidDateOnly, type DateOnly } from '@bob/core';

export interface SalesDocumentRouteParams {
  readonly type?: string;
  readonly from?: string;
  readonly to?: string;
  readonly customerId?: string;
}

export interface SalesDocumentRouteFilters {
  /** null = aucun paramètre "type" reconnu — le toggle devis/factures actuel reste INCHANGÉ,
   * jamais réinitialisé sur une navigation qui ne parle pas du tout de scope. */
  readonly kindFilter: 'all' | 'quotes' | 'invoices' | null;
  readonly dateRange: { readonly from: DateOnly; readonly to: DateOnly; readonly preset: 'custom' } | null;
  readonly customerId: string | null;
}

export function parseSalesDocumentRouteParams(params: SalesDocumentRouteParams): SalesDocumentRouteFilters {
  const kindFilter =
    params.type === 'quote' ? 'quotes' : params.type === 'invoice' ? 'invoices' : params.type === 'all' ? 'all' : null;
  const dateRange =
    typeof params.from === 'string'
    && typeof params.to === 'string'
    && isValidDateOnly(params.from)
    && isValidDateOnly(params.to)
      ? { from: params.from, to: params.to, preset: 'custom' as const }
      : null;
  const customerId = typeof params.customerId === 'string' && params.customerId.length > 0 ? params.customerId : null;
  return { kindFilter, dateRange, customerId };
}

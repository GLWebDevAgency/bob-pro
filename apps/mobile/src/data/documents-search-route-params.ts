/**
 * B9 — traduit les paramètres de route du deep link vocal (/ventes?type=&from=&to=&customerId=
 * &status=) en filtres écran. Fonction PURE (aucun hook, aucun router) : ventes.tsx ne fait
 * qu'appliquer le résultat via ses setters dans un useEffect — la logique de traduction reste
 * testable seule, sans avoir à monter tout l'écran.
 */
import { isValidDateOnly, type DateOnly } from '@bob/core';
import type { InvoiceView, QuoteView } from '@bob/api-client';

export interface SalesDocumentRouteParams {
  readonly type?: string;
  readonly from?: string;
  readonly to?: string;
  readonly customerId?: string;
  readonly status?: string;
}

export interface SalesDocumentRouteFilters {
  /** null = aucun paramètre "type" reconnu — le toggle devis/factures actuel reste INCHANGÉ,
   * jamais réinitialisé sur une navigation qui ne parle pas du tout de scope. */
  readonly kindFilter: 'all' | 'quotes' | 'invoices' | null;
  readonly dateRange: { readonly from: DateOnly; readonly to: DateOnly; readonly preset: 'custom' } | null;
  readonly customerId: string | null;
  /** Statut serveur à poser en filtre avancé (advancedStatus) — même vocabulaire que la modale
   * DocumentSearchFiltersModal. null = aucun statut admissible dans ce deep link. */
  readonly status: string | null;
}

// Statuts admissibles par scope — Records exhaustifs sur les statuts du domaine (comme
// QUOTE_ORDER/INVOICE_ORDER dans ventes.tsx : ajouter un statut oblige à le déclarer ici).
// Les Sets dérivés évitent le piège du prototype (`'toString' in obj` répondrait true).
const QUOTE_ROUTE_STATUSES: Record<QuoteView['status'], true> = {
  draft: true,
  sent: true,
  viewed: true,
  signed: true,
  refused: true,
  expired: true,
};
const INVOICE_ROUTE_STATUSES: Record<InvoiceView['status'], true> = {
  draft: true,
  issued: true,
  partially_paid: true,
  paid: true,
  late: true,
  cancelled: true,
};
const QUOTE_STATUS_SET: ReadonlySet<string> = new Set(Object.keys(QUOTE_ROUTE_STATUSES));
const INVOICE_STATUS_SET: ReadonlySet<string> = new Set(Object.keys(INVOICE_ROUTE_STATUSES));

export function parseSalesDocumentRouteParams(params: SalesDocumentRouteParams): SalesDocumentRouteFilters {
  const kindFilter =
    params.type === 'quote' ? 'quotes' : params.type === 'invoice' ? 'invoices' : params.type === 'all' ? 'all' : null;
  // Parité modale : un statut n'existe que dans un scope devis OU factures (statusOptions est
  // vide en « all ») — fail-closed, toute valeur hors du vocabulaire du scope est ignorée.
  const status =
    typeof params.status === 'string'
    && ((kindFilter === 'quotes' && QUOTE_STATUS_SET.has(params.status))
      || (kindFilter === 'invoices' && INVOICE_STATUS_SET.has(params.status)))
      ? params.status
      : null;
  const dateRange =
    typeof params.from === 'string'
    && typeof params.to === 'string'
    && isValidDateOnly(params.from)
    && isValidDateOnly(params.to)
      ? { from: params.from, to: params.to, preset: 'custom' as const }
      : null;
  const customerId = typeof params.customerId === 'string' && params.customerId.length > 0 ? params.customerId : null;
  return { kindFilter, dateRange, customerId, status };
}

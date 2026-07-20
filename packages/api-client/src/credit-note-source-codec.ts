import type { CreditNoteSourceSnapshot, CreditedInvoiceKind } from '@bob/core';
import {
  decodePurchaseOrderCarrierList,
  decodePurchaseOrderCarrierView,
} from './purchase-order-codec';
import { normalizeBillingTerrainCarrier } from './billing-terrain-codec';
import type { InvoiceView } from './client';

/**
 * E3 — codec défensif du snapshot « facture annulée par cet avoir » (CreditNoteSourceSnapshot).
 *
 * Même doctrine que purchase-order-codec (compat ascendante STRICTE) : un serveur antérieur à E3
 * n'envoie pas `creditNoteSource` sur InvoiceView — le décodage normalise (absent/null ⇒ null)
 * au lieu d'échouer. À l'inverse, un snapshot PRÉSENT mais difforme est une rupture de contrat :
 * on échoue fermé (jamais de cast silencieux d'une référence légale de pièce rectificative).
 */

const CREDITED_KINDS: readonly CreditedInvoiceKind[] = ['final', 'deposit', 'situation'];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Snapshot complet : invoiceId/number non vides, kind crédité connu, issuedAt AAAA-MM-JJ. */
export function decodeCreditNoteSource(value: unknown): CreditNoteSourceSnapshot | null {
  const source = record(value);
  if (source === null) return null;
  if (typeof source.invoiceId !== 'string' || source.invoiceId.trim().length === 0) return null;
  if (typeof source.number !== 'string' || source.number.trim().length === 0) return null;
  if (!CREDITED_KINDS.includes(source.kind as CreditedInvoiceKind)) return null;
  if (typeof source.issuedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(source.issuedAt))
    return null;
  return {
    invoiceId: source.invoiceId,
    kind: source.kind as CreditedInvoiceKind,
    number: source.number,
    issuedAt: source.issuedAt,
  };
}

/**
 * Normalise `creditNoteSource` d'une vue facture de façon immuable :
 * absent/null ⇒ null ; présent mais difforme ⇒ échec (retour null global, fail-closed).
 */
export function normalizeCreditNoteSourceCarrier<T extends { creditNoteSource?: unknown }>(
  view: T,
): (T & { creditNoteSource: CreditNoteSourceSnapshot | null }) | null {
  let creditNoteSource: CreditNoteSourceSnapshot | null = null;
  if (view.creditNoteSource !== undefined && view.creditNoteSource !== null) {
    creditNoteSource = decodeCreditNoteSource(view.creditNoteSource);
    if (creditNoteSource === null) return null;
  }
  return { ...view, creditNoteSource };
}

/** InvoiceView complète : champs B8 (bon de commande/révision), snapshot E3, PUIS champs
 *  « facturation terrain » (B1/B2/B3/B5 + transmission) — fail-closed à chaque étage. */
export function decodeInvoiceView(value: unknown): InvoiceView | null {
  const view = decodePurchaseOrderCarrierView<InvoiceView>(value);
  if (view === null) return null;
  const withSource = normalizeCreditNoteSourceCarrier(view) as InvoiceView | null;
  if (withSource === null) return null;
  return normalizeBillingTerrainCarrier(withSource) as InvoiceView | null;
}

/** Liste d'InvoiceView — un seul élément difforme rompt tout le contrat (fail-closed). */
export function decodeInvoiceViewList(value: unknown): InvoiceView[] | null {
  const views = decodePurchaseOrderCarrierList<InvoiceView>(value);
  if (views === null) return null;
  const decoded: InvoiceView[] = [];
  for (const item of views) {
    const view = normalizeCreditNoteSourceCarrier(item) as InvoiceView | null;
    if (view === null) return null;
    const normalized = normalizeBillingTerrainCarrier(view) as InvoiceView | null;
    if (normalized === null) return null;
    decoded.push(normalized);
  }
  return decoded;
}

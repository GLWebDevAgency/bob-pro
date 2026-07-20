import type { PurchaseOrderMutationView, PurchaseOrderRef } from '@bob/core';

/**
 * B8 — codecs défensifs du bon de commande (numéro d'engagement grands comptes).
 *
 * Compat ascendante STRICTE : un serveur antérieur à B8 n'envoie ni `purchaseOrder` ni
 * `revision` sur QuoteView/InvoiceView — le décodage normalise (absent ⇒ null / 1) au lieu
 * d'échouer. À l'inverse, un `purchaseOrder` PRÉSENT mais difforme est une rupture de contrat :
 * on échoue fermé (jamais de cast silencieux d'une référence légale).
 */

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Référence complète : number non vide, receivedAt/documentId string ou null. */
export function decodePurchaseOrderRef(value: unknown): PurchaseOrderRef | null {
  const ref = record(value);
  if (ref === null) return null;
  if (typeof ref.number !== 'string' || ref.number.trim().length === 0) return null;
  if (ref.receivedAt !== null && typeof ref.receivedAt !== 'string') return null;
  if (ref.documentId !== null && typeof ref.documentId !== 'string') return null;
  return {
    number: ref.number,
    receivedAt: (ref.receivedAt as string | null) ?? null,
    documentId: (ref.documentId as string | null) ?? null,
  };
}

/**
 * Normalise les champs B8 d'une vue devis/facture IN PLACE de façon immuable :
 * - `purchaseOrder` absent/null ⇒ null ; présent mais difforme ⇒ échec (retour null global) ;
 * - `revision` absente ⇒ 1 ; présente mais invalide ⇒ échec.
 * Retourne la vue enrichie, ou null si le contrat est rompu.
 */
export function normalizePurchaseOrderCarrier<T extends Record<string, unknown>>(
  view: T,
): (T & { purchaseOrder: PurchaseOrderRef | null; revision: number }) | null {
  let purchaseOrder: PurchaseOrderRef | null = null;
  if (view.purchaseOrder !== undefined && view.purchaseOrder !== null) {
    purchaseOrder = decodePurchaseOrderRef(view.purchaseOrder);
    if (purchaseOrder === null) return null;
  }
  let revision = 1;
  if (view.revision !== undefined) {
    if (!Number.isSafeInteger(view.revision) || (view.revision as number) < 1) return null;
    revision = view.revision as number;
  }
  return { ...view, purchaseOrder, revision };
}

/** Vue devis/facture minimale (id porteur) avec champs B8 normalisés. */
export function decodePurchaseOrderCarrierView<T extends { id: string }>(
  value: unknown,
): (T & { purchaseOrder: PurchaseOrderRef | null; revision: number }) | null {
  const view = record(value);
  if (view === null || typeof view.id !== 'string') return null;
  return normalizePurchaseOrderCarrier(view) as
    | (T & { purchaseOrder: PurchaseOrderRef | null; revision: number })
    | null;
}

/** Liste de vues — un seul élément difforme rompt tout le contrat (fail-closed). */
export function decodePurchaseOrderCarrierList<T extends { id: string }>(
  value: unknown,
): (T & { purchaseOrder: PurchaseOrderRef | null; revision: number })[] | null {
  if (!Array.isArray(value)) return null;
  const decoded: (T & { purchaseOrder: PurchaseOrderRef | null; revision: number })[] = [];
  for (const item of value) {
    const view = decodePurchaseOrderCarrierView<T>(item);
    if (view === null) return null;
    decoded.push(view);
  }
  return decoded;
}

/** Résultat des mutations PUT/DELETE …/purchase-order — shape exact, fail-closed. */
export function decodePurchaseOrderMutation(
  value: unknown,
  expected: { targetType: 'quote' | 'invoice'; targetId: string },
): PurchaseOrderMutationView | null {
  const view = record(value);
  if (
    view === null ||
    view.targetType !== expected.targetType ||
    view.targetId !== expected.targetId ||
    !Number.isSafeInteger(view.revision) ||
    (view.revision as number) < 1
  ) {
    return null;
  }
  let purchaseOrder: PurchaseOrderRef | null = null;
  if (view.purchaseOrder !== undefined && view.purchaseOrder !== null) {
    purchaseOrder = decodePurchaseOrderRef(view.purchaseOrder);
    if (purchaseOrder === null) return null;
  }
  return {
    targetType: expected.targetType,
    targetId: expected.targetId,
    revision: view.revision as number,
    purchaseOrder,
  };
}

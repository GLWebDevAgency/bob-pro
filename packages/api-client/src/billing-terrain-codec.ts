import type {
  Discount,
  InvoiceTransmissionStatus,
  TransmissionGuide,
  CustomerBillingChannelType,
} from '@bob/core';

/**
 * Codecs défensifs des champs « facturation terrain » (B1/B2/B3/B5 + canal de facturation)
 * d'une InvoiceView — même doctrine que purchase-order-codec / credit-note-source-codec :
 *  • champ ABSENT (serveur antérieur) ⇒ normalisé (null / 0), jamais un échec ;
 *  • champ PRÉSENT mais difforme ⇒ échec FERMÉ (jamais un montant/fait légal casté en aveugle) ;
 *  • exception : `transmissionGuide` est une AIDE dérivée, pas un fait de la pièce — difforme,
 *    il est RETIRÉ de la vue (l'écran perd le guide, jamais la facture).
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const BILLING_CHANNEL_TYPES: readonly CustomerBillingChannelType[] = ['email', 'chorus', 'portail'];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** B3 — remise : { type: 'percent', value } | { type: 'amount', cents } — null si difforme. */
export function decodeDiscount(value: unknown): Discount | null {
  const discount = record(value);
  if (discount === null) return null;
  if (discount.type === 'percent' && typeof discount.value === 'number' && Number.isFinite(discount.value)) {
    return { type: 'percent', value: discount.value };
  }
  if (discount.type === 'amount' && Number.isSafeInteger(discount.cents)) {
    return { type: 'amount', cents: discount.cents as number };
  }
  return null;
}

/** Suivi de transmission : dates AAAA-MM-JJ (acceptedAt nullable) — null si difforme. */
export function decodeTransmission(value: unknown): InvoiceTransmissionStatus | null {
  const transmission = record(value);
  if (transmission === null) return null;
  const depositedAt = transmission.depositedAt;
  const acceptedAt = transmission.acceptedAt;
  const validDeposited =
    depositedAt === null || (typeof depositedAt === 'string' && DATE_ONLY.test(depositedAt));
  const validAccepted =
    acceptedAt === null || (typeof acceptedAt === 'string' && DATE_ONLY.test(acceptedAt));
  if (!validDeposited || !validAccepted) return null;
  return {
    depositedAt: (depositedAt as string | null) ?? null,
    acceptedAt: (acceptedAt as string | null) ?? null,
  };
}

/** Guide de transmission (aide dérivée) — null si difforme (le champ sera RETIRÉ, pas la vue). */
export function decodeTransmissionGuide(value: unknown): TransmissionGuide | null {
  const guide = record(value);
  if (guide === null) return null;
  if (!BILLING_CHANNEL_TYPES.includes(guide.channel as CustomerBillingChannelType)) return null;
  if (!Array.isArray(guide.checklist)) return null;
  const checklist: TransmissionGuide['checklist'] = [];
  for (const item of guide.checklist) {
    const entry = record(item);
    if (entry === null) return null;
    if (typeof entry.label !== 'string' || entry.label.length === 0) return null;
    if (entry.done !== true && entry.done !== false && entry.done !== null) return null;
    checklist.push({ label: entry.label, done: entry.done });
  }
  const decoded: TransmissionGuide = {
    channel: guide.channel as CustomerBillingChannelType,
    checklist,
  };
  if (guide.chorusServiceCode !== undefined) {
    if (guide.chorusServiceCode !== null && typeof guide.chorusServiceCode !== 'string') return null;
    decoded.chorusServiceCode = guide.chorusServiceCode;
  }
  if (guide.portail !== undefined) {
    const portail = record(guide.portail);
    if (portail === null) return null;
    const nom = portail.nom;
    const url = portail.url;
    if (nom !== null && typeof nom !== 'string') return null;
    if (url !== null && typeof url !== 'string') return null;
    decoded.portail = { nom: (nom as string | null) ?? null, url: (url as string | null) ?? null };
  }
  return decoded;
}

/**
 * Normalise les champs « facturation terrain » d'une vue facture, de façon immuable.
 * Retour null global = contrat rompu (fail-closed), sauf `transmissionGuide` (aide retirée).
 */
export function normalizeBillingTerrainCarrier<
  T extends {
    situationOrder?: unknown;
    situationDeductionCents?: unknown;
    globalDiscount?: unknown;
    retenueGarantiePct?: unknown;
    urgentRepair?: unknown;
    transmission?: unknown;
    transmissionGuide?: unknown;
  },
>(
  view: T,
):
  | (Omit<T, 'transmissionGuide'> & {
      situationOrder: number | null;
      situationDeductionCents: number;
      globalDiscount: Discount | null;
      retenueGarantiePct: number | null;
      urgentRepair: { requestedAt: string } | null;
      transmission: InvoiceTransmissionStatus | null;
      transmissionGuide?: TransmissionGuide;
    })
  | null {
  let situationOrder: number | null = null;
  if (view.situationOrder !== undefined && view.situationOrder !== null) {
    if (!Number.isSafeInteger(view.situationOrder) || (view.situationOrder as number) < 1) return null;
    situationOrder = view.situationOrder as number;
  }
  let situationDeductionCents = 0;
  if (view.situationDeductionCents !== undefined) {
    if (!Number.isSafeInteger(view.situationDeductionCents) || (view.situationDeductionCents as number) < 0)
      return null;
    situationDeductionCents = view.situationDeductionCents as number;
  }
  let globalDiscount: Discount | null = null;
  if (view.globalDiscount !== undefined && view.globalDiscount !== null) {
    globalDiscount = decodeDiscount(view.globalDiscount);
    if (globalDiscount === null) return null;
  }
  let retenueGarantiePct: number | null = null;
  if (view.retenueGarantiePct !== undefined && view.retenueGarantiePct !== null) {
    if (typeof view.retenueGarantiePct !== 'number' || !Number.isFinite(view.retenueGarantiePct))
      return null;
    retenueGarantiePct = view.retenueGarantiePct;
  }
  let urgentRepair: { requestedAt: string } | null = null;
  if (view.urgentRepair !== undefined && view.urgentRepair !== null) {
    const urgent = record(view.urgentRepair);
    if (urgent === null || typeof urgent.requestedAt !== 'string' || urgent.requestedAt.length === 0)
      return null;
    urgentRepair = { requestedAt: urgent.requestedAt };
  }
  let transmission: InvoiceTransmissionStatus | null = null;
  if (view.transmission !== undefined && view.transmission !== null) {
    transmission = decodeTransmission(view.transmission);
    if (transmission === null) return null;
  }
  // Guide DÉRIVÉ : difforme ⇒ retiré (l'aide disparaît, jamais la pièce) — pas un fait légal.
  let transmissionGuide: TransmissionGuide | undefined;
  if (view.transmissionGuide !== undefined && view.transmissionGuide !== null) {
    transmissionGuide = decodeTransmissionGuide(view.transmissionGuide) ?? undefined;
  }
  const { transmissionGuide: _dropped, ...rest } = view;
  return {
    ...rest,
    situationOrder,
    situationDeductionCents,
    globalDiscount,
    retenueGarantiePct,
    urgentRepair,
    transmission,
    ...(transmissionGuide !== undefined ? { transmissionGuide } : {}),
  };
}

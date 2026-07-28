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
    emailDeliveredAt?: unknown;
    maintenanceContractId?: unknown;
    servicePeriod?: unknown;
  },
>(
  view: T,
):
  | (Omit<T, 'transmissionGuide' | 'emailDeliveredAt' | 'maintenanceContractId' | 'servicePeriod'> & {
      situationOrder: number | null;
      situationDeductionCents: number;
      globalDiscount: Discount | null;
      retenueGarantiePct: number | null;
      urgentRepair: { requestedAt: string } | null;
      transmission: InvoiceTransmissionStatus | null;
      transmissionGuide?: TransmissionGuide;
      emailDeliveredAt?: string | null;
      maintenanceContractId?: string | null;
      servicePeriod?: { start: string; end: string | null } | null;
    })
  | null {
  // PR-12b (écrans §6.5) — contrat facturé + période de service portée par la pièce : faits
  // ADDITIFS fail-closed. ABSENT reste absent (serveur antérieur — la pièce n'est jamais
  // « comptée hors contrat » par invention) ; présent mais difforme = rupture de contrat.
  let maintenanceContractId: string | null | undefined;
  if (view.maintenanceContractId !== undefined) {
    if (view.maintenanceContractId !== null && typeof view.maintenanceContractId !== 'string')
      return null;
    maintenanceContractId = view.maintenanceContractId;
  }
  let servicePeriod: { start: string; end: string | null } | null | undefined;
  if (view.servicePeriod !== undefined) {
    if (view.servicePeriod === null) {
      servicePeriod = null;
    } else {
      const period = record(view.servicePeriod);
      if (period === null) return null;
      const start = period.start;
      const end = period.end === undefined || period.end === null ? null : period.end;
      if (typeof start !== 'string' || !DATE_ONLY.test(start)) return null;
      if (end !== null && (typeof end !== 'string' || !DATE_ONLY.test(end))) return null;
      servicePeriod = { start, end: end as string | null };
    }
  }
  // PR-02 — livraison EMAIL constatée : fait ADDITIF fail-closed. ABSENT reste absent (un
  // serveur antérieur ne transporte pas le fait — on n'invente jamais « pas envoyée ») ;
  // présent mais difforme = rupture de contrat.
  let emailDeliveredAt: string | null | undefined;
  if (view.emailDeliveredAt !== undefined) {
    if (view.emailDeliveredAt !== null && typeof view.emailDeliveredAt !== 'string') return null;
    emailDeliveredAt = view.emailDeliveredAt;
  }
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
  const {
    transmissionGuide: _dropped,
    emailDeliveredAt: _droppedDelivery,
    maintenanceContractId: _droppedContract,
    servicePeriod: _droppedPeriod,
    ...rest
  } = view;
  return {
    ...rest,
    situationOrder,
    situationDeductionCents,
    globalDiscount,
    retenueGarantiePct,
    urgentRepair,
    transmission,
    ...(transmissionGuide !== undefined ? { transmissionGuide } : {}),
    ...(emailDeliveredAt !== undefined ? { emailDeliveredAt } : {}),
    ...(maintenanceContractId !== undefined ? { maintenanceContractId } : {}),
    ...(servicePeriod !== undefined ? { servicePeriod } : {}),
  };
}

// Clés de déduplication des rappels internes — MODULE PUR, sans aucune dépendance service.
// Extrait des services pour briser le cycle d'imports transmission-reminder/quote-followup ↔
// notification-delivery (la classe injectée devenait undefined à la décoration : boot Nest
// refusé, invisible aux tests unitaires — attrapé par le boot rituel du 27/07).

import type { QuoteRelancePalier, RenewalPalier } from '@bob/core';

/** Clé de déduplication — SOURCE UNIQUE (même doctrine que embargoScheduledPaymentDedupeKey). */
export function invoiceTransmissionReminderDedupeKey(invoiceId: string): string {
  return `invoice:${invoiceId}:transmission-reminder`;
}

/** Inverse exacte — null pour toute autre clé (fail-closed). */
export function invoiceIdOfTransmissionReminderDedupeKey(dedupeKey: string): string | null {
  const match = /^invoice:(.+):transmission-reminder$/.exec(dedupeKey);
  return match?.[1] ?? null;
}

/** Clé de déduplication PAR PALIER — SOURCE UNIQUE (doctrine embargoScheduledPaymentDedupeKey). */
export function quoteRelanceReminderDedupeKey(
  quoteId: string,
  palier: QuoteRelancePalier,
): string {
  return `quote:${quoteId}:relance-reminder:${palier}`;
}

/** Inverse exacte — null pour toute autre clé (fail-closed). */
export function quoteIdOfQuoteRelanceReminderDedupeKey(dedupeKey: string): string | null {
  const match = /^quote:(.+):relance-reminder:(j15|j30)$/.exec(dedupeKey);
  return match?.[1] ?? null;
}

/**
 * PR-13 — alerte de renouvellement de contrat (§2.5) : clé PAR (anniversaire calculé,
 * palier) — l'anniversaire change chaque année, la fenêtre J-60/J-30 revit donc TOUTES les
 * années ; deriveRenewalAlerts ne rend que le palier LE PLUS RÉCENT pertinent (amélioration
 * 14 : au réveil après une panne, jamais J-60 ET J-30 d'un coup).
 */
export function contractRenewalReminderDedupeKey(
  contractId: string,
  anniversary: string,
  palier: RenewalPalier,
): string {
  return `contract:${contractId}:renewal:${anniversary}:${palier}`;
}

/** Inverse exacte — null pour toute autre clé (fail-closed). */
export function contractRenewalReminderDedupeKeyParts(
  dedupeKey: string,
): { contractId: string; anniversary: string; palier: RenewalPalier } | null {
  const match = /^contract:(.+):renewal:(\d{4}-\d{2}-\d{2}):(j60|j30)$/.exec(dedupeKey);
  if (match === null) return null;
  return {
    contractId: match[1]!,
    anniversary: match[2]!,
    palier: match[3] as RenewalPalier,
  };
}

/**
 * PR-13 — rappel interne « facture annuelle à émettre » (§2.5) : clé PAR période (début de
 * période dû) — dédup ANNUELLE naturelle : la période suivante a un autre début, le rappel
 * revit chaque année sans jamais se répéter dans l'année.
 */
export function contractAnnualInvoiceReminderDedupeKey(
  contractId: string,
  periodStart: string,
): string {
  return `contract:${contractId}:annual-invoice:${periodStart}`;
}

/** Inverse exacte — null pour toute autre clé (fail-closed). */
export function contractAnnualInvoiceReminderDedupeKeyParts(
  dedupeKey: string,
): { contractId: string; periodStart: string } | null {
  const match = /^contract:(.+):annual-invoice:(\d{4}-\d{2}-\d{2})$/.exec(dedupeKey);
  if (match === null) return null;
  return { contractId: match[1]!, periodStart: match[2]! };
}

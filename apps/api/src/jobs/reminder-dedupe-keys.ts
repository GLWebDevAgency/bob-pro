// Clés de déduplication des rappels internes — MODULE PUR, sans aucune dépendance service.
// Extrait des services pour briser le cycle d'imports transmission-reminder/quote-followup ↔
// notification-delivery (la classe injectée devenait undefined à la décoration : boot Nest
// refusé, invisible aux tests unitaires — attrapé par le boot rituel du 27/07).

import type { QuoteRelancePalier } from '@bob/core';

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

import type { InvoiceView, QuoteView } from '@bob/api-client';
import { isIssuedNeverTransmitted } from '@bob/core';
import { t, type Personality } from '@bob/i18n';

/**
 * Badges de statut devis/factures — logique PURE (aucun import React Native), partagée par la
 * liste (ventes.tsx) et DocumentActions. Records exhaustifs : ajouter un statut oblige à le mapper.
 */

export type BadgeTone = 'b2b' | 'b2g' | 'particulier' | 'success' | 'warning' | 'danger' | 'ai';

// Statut -> pastille (label FR + ton DA).
export const QUOTE_BADGE: Record<QuoteView['status'], { label: string; tone: BadgeTone }> = {
  draft: { label: 'Brouillon', tone: 'warning' },
  sent: { label: 'Envoyé', tone: 'b2b' },
  viewed: { label: 'Vu', tone: 'b2b' },
  signed: { label: 'Signé', tone: 'success' },
  refused: { label: 'Refusé', tone: 'danger' },
  expired: { label: 'Expiré', tone: 'danger' },
};
export const INVOICE_BADGE: Record<InvoiceView['status'], { label: string; tone: BadgeTone }> = {
  draft: { label: 'Brouillon', tone: 'warning' },
  issued: { label: 'Émise', tone: 'b2b' },
  partially_paid: { label: 'Partielle', tone: 'warning' },
  paid: { label: 'Payée', tone: 'success' },
  late: { label: 'En retard', tone: 'danger' },
  cancelled: { label: 'Annulée', tone: 'danger' },
};

/**
 * E5 : badge de statut dérivé par KIND — un AVOIR est masculin et s'affiche AMBRE quand il est
 * émis (« Émis », tone warning : la pièce annule, elle n'encaisse pas — jamais le bleu « Émise »
 * d'une facture vivante). Statuts possibles d'un avoir au domaine : draft → issued/cancelled
 * (INVOICE_TRANSITIONS ; aucun flux produit n'encaisse ni ne met en retard un avoir) — les
 * autres entrées suivent le repli INVOICE_BADGE, genre invariant (Brouillon, En retard) ou
 * état non atteignable (Partielle/Payée), sans inventer de libellé.
 */
export function invoiceBadgeFor(
  inv: Pick<InvoiceView, 'kind' | 'status'>,
  personality: Personality,
): { label: string; tone: BadgeTone } {
  if (inv.kind !== 'credit_note') return INVOICE_BADGE[inv.status];
  if (inv.status === 'issued')
    return { label: t('ventes.badgeAvoirEmis', { personality }), tone: 'warning' };
  if (inv.status === 'cancelled')
    return { label: t('ventes.badgeAvoirAnnule', { personality }), tone: 'danger' };
  return INVOICE_BADGE[inv.status];
}

/**
 * PR-02 « Encaisser » — badge de LISTE : une pièce ÉMISE dont RIEN ne prouve la transmission
 * (aucun job d'envoi réussi, aucun dépôt déclaré — prédicat isIssuedNeverTransmitted, LA même
 * vérité que la priorité Aujourd'hui et Pilotage) s'affiche AMBRE « À transmettre » au lieu du
 * bleu « Émise » rassurant à tort. Fail-closed : projections muettes (serveur antérieur) =
 * badge historique inchangé — jamais une alerte inventée.
 */
export function invoiceListBadgeFor(
  inv: Pick<InvoiceView, 'kind' | 'status' | 'emailDeliveredAt' | 'transmission'>,
  personality: Personality,
): { label: string; tone: BadgeTone } {
  if (
    isIssuedNeverTransmitted({
      kind: inv.kind,
      status: inv.status,
      emailDeliveredAt: inv.emailDeliveredAt,
      // InvoiceView.transmission (DateOnly côté vue) est structurellement compatible.
      transmission: inv.transmission,
    })
  ) {
    return { label: t('ventes.badgeATransmettre', { personality }), tone: 'warning' };
  }
  return invoiceBadgeFor(inv, personality);
}

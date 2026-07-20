/**
 * S5 — Parité voix↔tap du « Lien de paiement » (facture/[id].tsx ↔ InvoiceActions).
 * Logique PURE (éligibilité + matcher d'énoncé) extraite de l'écran pour être testée
 * sans React Native. Doctrine : la voix passe par le MÊME hook (useInvoicePaymentLink)
 * que le bouton, et AUCUN envoi sortant n'a lieu tant que le Share natif n'est pas
 * complété par l'utilisateur (même garantie que devis.shareViewLink).
 */
import { normalizeVoiceText } from '@bob/core';
import type { InvoiceView } from '@bob/api-client';

/**
 * Statuts où le bouton « Lien de paiement » d'InvoiceActions existe (branche
 * issued/partially_paid/late de DocumentActions.tsx) — SOURCE UNIQUE de la parité S5 :
 * le bouton ET l'affordance vocale lisent ce même prédicat.
 */
export const isPaymentLinkEligible = (status: InvoiceView['status']): boolean =>
  status === 'issued' || status === 'partially_paid' || status === 'late';

/**
 * « envoie le lien de paiement » / « partage le lien de paiement » — mêmes verbes que
 * l'affordance facture.shareViewLink, PLUS « paiement » obligatoire. shareViewLink exclut
 * « paiement » et est testée APRÈS celle-ci dans le tableau (premier match gagne).
 */
export const matchesPaymentLinkUtterance = (utterance: string): boolean => {
  const n = normalizeVoiceText(utterance);
  return (
    /\b(partage|partager|envoie|envoyer)\b/.test(n) &&
    /\blien\b/.test(n) &&
    /\bpaiement\b/.test(n)
  );
};

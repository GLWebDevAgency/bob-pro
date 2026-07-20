/**
 * S5 — logique pure de l'affordance vocale « lien de paiement » (facture/[id].tsx).
 * L'éligibilité DOIT rester le miroir exact de la branche issued/partially_paid/late
 * d'InvoiceActions (DocumentActions.tsx) — c'est le même prédicat qui est importé des
 * deux côtés, ces tests verrouillent son contenu.
 */
import { describe, expect, it } from 'vitest';
import { isPaymentLinkEligible, matchesPaymentLinkUtterance } from './payment-link-affordance';

describe('isPaymentLinkEligible', () => {
  it('accepte exactement les statuts où le bouton « Lien de paiement » existe', () => {
    expect(isPaymentLinkEligible('issued')).toBe(true);
    expect(isPaymentLinkEligible('partially_paid')).toBe(true);
    expect(isPaymentLinkEligible('late')).toBe(true);
  });

  it('refuse brouillon, payée et annulée (aucun lien de paiement à proposer)', () => {
    expect(isPaymentLinkEligible('draft')).toBe(false);
    expect(isPaymentLinkEligible('paid')).toBe(false);
    expect(isPaymentLinkEligible('cancelled')).toBe(false);
  });
});

describe('matchesPaymentLinkUtterance', () => {
  it('matche les formulations naturelles (accents et majuscules normalisés)', () => {
    expect(matchesPaymentLinkUtterance('Envoie le lien de paiement')).toBe(true);
    expect(matchesPaymentLinkUtterance('partage le lien de paiement au client')).toBe(true);
    expect(matchesPaymentLinkUtterance('tu peux envoyer le lien de paiement ?')).toBe(true);
  });

  it('laisse « partage le lien » (sans paiement) à l’affordance shareViewLink', () => {
    expect(matchesPaymentLinkUtterance('partage le lien')).toBe(false);
    expect(matchesPaymentLinkUtterance('envoie le lien de la facture')).toBe(false);
  });

  it('exige le mot « lien » ET un verbe de partage (jamais de déclenchement flou)', () => {
    expect(matchesPaymentLinkUtterance('envoie le paiement')).toBe(false);
    expect(matchesPaymentLinkUtterance('ouvre le lien de paiement')).toBe(false);
    expect(matchesPaymentLinkUtterance('le lien de paiement')).toBe(false);
  });
});

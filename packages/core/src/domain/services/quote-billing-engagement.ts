import { type Invoice } from '../billing/invoice/invoice';

/**
 * B2 — Engagement de facturation d'un DEVIS SIGNÉ : source UNIQUE des pièces sœurs lues par
 * la garde de cumul « acompte + situations ≤ marché » (INVIOLABLE) et par la garde « marché
 * soldé » (une facture FINALE vivante ferme le devis aux nouvelles pièces d'appel).
 *
 * Service PUR (aucun port) : la génération (GenerateInvoiceFromQuote) et l'ÉMISSION
 * (IssueInvoice) partagent exactement la même lecture — un brouillon dormant ne peut pas
 * contourner à l'émission une garde appliquée à la génération. La TVA étant exigible sur
 * chaque pièce émise (art. 283 du CGI), toute pièce au-delà du marché signé serait une
 * facture indue : fail-closed des deux côtés.
 */
export interface QuoteBillingEngagement {
  /**
   * Pièces d'APPEL du devis (acompte + situations) comptant au cumul : non annulées, non
   * totalement avoirées — BROUILLONS INCLUS (une pièce créée réserve sa part ; un brouillon
   * supprimé la libère). Filtrer `status !== 'draft'` pour l'engagement ÉMIS.
   */
  engaged: Invoice[];
  /**
   * Factures FINALES vivantes du devis (brouillon compris) : non annulées, non totalement
   * avoirées. Brouillon = le solde est déjà appelé ; émise = le marché est soldé.
   */
  finals: Invoice[];
  /**
   * Prochain n° d'ordre de situation : 1 + max des n° EXISTANTS TOUT statut (annulées et
   * avoirées comprises) — un n° d'ordre imprimé n'est JAMAIS réutilisé, et l'allocation
   * monotone rend l'index unique partiel (backstop base) inviolable même après annulation.
   */
  nextSituationOrder: number;
}

/**
 * Montant TTC déjà appelé par une pièce sœur : acompte = son net à payer (l'appel réel) ;
 * situation = son TTC (net à payer + retenue de garantie B5 — la retenue reste due au titre
 * de la situation, elle n'est jamais refacturée par la finale).
 */
export function billedTtcCents(invoice: Invoice): number {
  const totals = invoice.totals();
  return invoice.kind === 'deposit' ? totals.netToPay : totals.ttc;
}

/** Engagement de facturation du devis `quoteId` parmi les pièces du tenant. */
export function quoteBillingEngagement(
  companyInvoices: readonly Invoice[],
  quoteId: string,
): QuoteBillingEngagement {
  // Un avoir TOTAL n'annule la pièce qu'une fois ÉMIS (un brouillon d'avoir n'a aucun effet
  // fiscal) ; l'identité source durable évite toute heuristique par devis ou montant.
  const totallyCreditedSourceIds = new Set(
    companyInvoices
      .filter(
        (invoice) =>
          invoice.kind === 'credit_note' &&
          invoice.status !== 'draft' &&
          invoice.status !== 'cancelled' &&
          invoice.creditNoteSource !== null,
      )
      .map((invoice) => invoice.creditNoteSource!.invoiceId),
  );
  const sisters = companyInvoices.filter((invoice) => invoice.parentQuoteId === quoteId);
  const alive = (invoice: Invoice): boolean =>
    invoice.status !== 'cancelled' && !totallyCreditedSourceIds.has(invoice.id);

  const engaged = sisters.filter(
    (invoice) => (invoice.kind === 'deposit' || invoice.kind === 'situation') && alive(invoice),
  );
  const finals = sisters.filter((invoice) => invoice.kind === 'final' && alive(invoice));
  const nextSituationOrder =
    1 +
    sisters
      .filter((invoice) => invoice.kind === 'situation')
      .reduce((max, invoice) => Math.max(max, invoice.situationOrder ?? 0), 0);

  return { engaged, finals, nextSituationOrder };
}

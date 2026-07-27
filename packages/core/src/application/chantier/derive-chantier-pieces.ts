import { type QuoteStatus, type InvoiceStatus } from '../../domain/billing/shared/state-machines';
import { type InvoiceKind } from '../../domain/billing/invoice/invoice';

/**
 * PR-08 « Le métier » — pièces d'un site : dérivation PURE (zéro I/O) de la liste des devis et
 * factures rattachés à un chantier, depuis les projections que les écrans possèdent déjà
 * (listes ventes). Doctrine fail-closed : une projection dont `chantierId` n'est PAS transporté
 * (undefined — serveur antérieur) n'est JAMAIS comptée sur un site ; seul `chantierId === id`
 * rattache. Aucun statut inventé, aucun tri sur une date fabriquée : l'ordre s'appuie sur la
 * date d'établissement réelle (`issuedAt`), les brouillons (sans date) en tête — le plus récent
 * d'abord ensuite, départagé par numéro puis id (déterministe).
 */

export interface ChantierPieceQuoteProjection {
  id: string;
  /** Absent = information non transportée (fail-closed : hors site). */
  chantierId?: string | null;
  number: string | null;
  status: QuoteStatus;
  totalTtcCents: number;
  /** Date d'établissement réelle (A1) — null pour un brouillon/legacy. */
  issuedAt?: string | null;
}

export interface ChantierPieceInvoiceProjection {
  id: string;
  chantierId?: string | null;
  number: string | null;
  status: InvoiceStatus;
  kind: InvoiceKind;
  totalTtcCents: number;
  issuedAt?: string | null;
}

export interface ChantierPieces {
  quotes: ChantierPieceQuoteProjection[];
  invoices: ChantierPieceInvoiceProjection[];
}

function belongsToChantier(
  piece: { chantierId?: string | null },
  chantierId: string,
): boolean {
  // undefined = non transporté → fail-closed (jamais compté) ; null = hors site.
  return piece.chantierId === chantierId;
}

function byRecencyThenIdentity(
  left: { issuedAt?: string | null; number: string | null; id: string },
  right: { issuedAt?: string | null; number: string | null; id: string },
): number {
  const leftIssued = left.issuedAt ?? null;
  const rightIssued = right.issuedAt ?? null;
  // Brouillons (sans date d'établissement) d'abord : c'est le travail en cours du site.
  if (leftIssued === null && rightIssued !== null) return -1;
  if (leftIssued !== null && rightIssued === null) return 1;
  if (leftIssued !== null && rightIssued !== null && leftIssued !== rightIssued) {
    return rightIssued.localeCompare(leftIssued);
  }
  const leftNumber = left.number ?? '';
  const rightNumber = right.number ?? '';
  if (leftNumber !== rightNumber) return rightNumber.localeCompare(leftNumber);
  return left.id.localeCompare(right.id);
}

/** Pièces (devis + factures) rattachées au site `chantierId` — projections filtrées et triées. */
export function deriveChantierPieces(input: {
  chantierId: string;
  quotes: readonly ChantierPieceQuoteProjection[];
  invoices: readonly ChantierPieceInvoiceProjection[];
}): ChantierPieces {
  const chantierId = input.chantierId.trim();
  if (chantierId.length === 0) return { quotes: [], invoices: [] };
  return {
    quotes: input.quotes
      .filter((quote) => belongsToChantier(quote, chantierId))
      .slice()
      .sort(byRecencyThenIdentity),
    invoices: input.invoices
      .filter((invoice) => belongsToChantier(invoice, chantierId))
      .slice()
      .sort(byRecencyThenIdentity),
  };
}

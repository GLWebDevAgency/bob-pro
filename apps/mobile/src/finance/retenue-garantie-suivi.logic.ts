/**
 * B5 — Retenue de garantie (loi n° 71-584 du 16 juillet 1971) : agrégation PURE de la créance
 * « retenue à récupérer » depuis les factures RÉELLES du tenant. La retenue naît à l'ÉMISSION
 * (totaux figés) : les brouillons et pièces annulées ne constituent jamais une créance. La
 * restitution est due un an après la RÉCEPTION des travaux — date que le produit ne connaît pas
 * encore (pas de PV de réception V1) : le suivi l'affiche honnêtement « réception + 1 an »,
 * jamais une date inventée (deriveRetenueGarantieSuivi, receptionAt null).
 */
import {
  deriveRetenueGarantieSuivi,
  type InvoiceKind,
  type InvoiceStatus,
  type Totals,
} from '@bob/core';

/** Projection minimale d'une InvoiceView pour ce suivi. */
export interface RetenueInvoiceProjection {
  readonly id: string;
  readonly number: string | null;
  readonly kind: InvoiceKind;
  readonly status: InvoiceStatus;
  readonly customerId: string;
  readonly totals: Pick<Totals, 'retenueGarantieCents'>;
}

export interface RetenueSuiviView {
  /** Total retenu (constitué) sur les pièces émises, en centimes. */
  readonly retainedCents: number;
  readonly pieceCount: number;
  /** Numéros des pièces porteuses (nav/contexte). */
  readonly pieces: readonly { readonly id: string; readonly number: string | null; readonly retainedCents: number }[];
}

/**
 * Créance de retenue AGRÉGÉE — optionnellement restreinte à un client (fiche chantier : le
 * chantier connaît son client, pas encore ses devis). `null` = aucune retenue constituée
 * (la carte ne s'affiche pas : jamais un zéro décoratif).
 */
export function deriveRetenueSuivi(
  invoices: readonly RetenueInvoiceProjection[],
  asOf: string,
  options?: { customerId?: string },
): RetenueSuiviView | null {
  const porteuses = invoices.filter(
    (invoice) =>
      invoice.status !== 'draft' &&
      invoice.status !== 'cancelled' &&
      invoice.kind !== 'credit_note' &&
      (invoice.totals.retenueGarantieCents ?? 0) > 0 &&
      (options?.customerId === undefined || invoice.customerId === options.customerId),
  );
  if (porteuses.length === 0) return null;
  const suivi = deriveRetenueGarantieSuivi({
    pieces: porteuses.map((invoice) => ({
      pieceNumber: invoice.number,
      retainedCents: invoice.totals.retenueGarantieCents ?? 0,
    })),
    receptionAt: null, // pas de PV de réception V1 : le délai d'un an n'a pas de point de départ connu
    asOf,
  });
  if (!suivi.ok) return null; // données legacy difformes : pas de carte plutôt qu'un montant faux
  return {
    retainedCents: suivi.value.retainedCents,
    pieceCount: porteuses.length,
    pieces: porteuses.map((invoice) => ({
      id: invoice.id,
      number: invoice.number,
      retainedCents: invoice.totals.retenueGarantieCents ?? 0,
    })),
  };
}

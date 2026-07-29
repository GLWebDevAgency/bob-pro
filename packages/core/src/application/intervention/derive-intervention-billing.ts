import { type InterventionStatus } from '../../domain/intervention/intervention';

/**
 * §3.5 — « Facturer sans délai » : dérivation PURE (zéro I/O) des passages à facturer.
 * Un passage est À FACTURER si : `completed` ou `signed`, HORS contrat (`contractId` null —
 * direction 6 : SEUL discriminant, jamais `kind`), et SANS facture liée non annulée.
 * Fail-closed : une projection manquante (`undefined`) n'allume JAMAIS la priorité —
 * doctrine `devis_a_transmettre` (aucun statut inventé). L'annulation de la facture liée
 * RALLUME le fait (extinction par l'état réel uniquement).
 */

export interface InterventionBillingSource {
  id: string;
  status: InterventionStatus;
  contractId: string | null;
  billedInvoiceId: string | null;
  kind: string;
  chantierId: string;
  finishedAt: string | null;
}

export interface InterventionInvoiceProjection {
  id: string;
  /** Statut réel de la pièce — `cancelled` ne couvre plus rien. */
  status: string;
}

export interface InterventionBillingDueFact {
  interventionId: string;
  kind: string;
  chantierId: string;
  finishedAt: string | null;
}

export function deriveInterventionBillingDue(
  interventions: readonly InterventionBillingSource[],
  invoicesById: ReadonlyMap<string, InterventionInvoiceProjection>,
): InterventionBillingDueFact[] {
  const due: InterventionBillingDueFact[] = [];
  for (const intervention of interventions) {
    if (intervention.status !== 'completed' && intervention.status !== 'signed') continue;
    // Direction 6 — `contractId` est le SEUL discriminant : un `kind` fantaisiste ne peut
    // rien casser. `undefined` (projection non transportée) = fail-closed, jamais d'alerte.
    if (intervention.contractId !== null) continue;
    if (intervention.billedInvoiceId !== null) {
      const invoice = invoicesById.get(intervention.billedInvoiceId);
      if (invoice === undefined) continue; // lien posé mais pièce non transportée : fail-closed
      if (invoice.status !== 'cancelled') continue; // couverte par une pièce vivante
      // Facture annulée → le passage redevient à facturer (réallumage par l'état réel).
    }
    due.push({
      interventionId: intervention.id,
      kind: intervention.kind,
      chantierId: intervention.chantierId,
      finishedAt: intervention.finishedAt,
    });
  }
  return due;
}

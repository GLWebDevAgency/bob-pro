import { describe, expect, it } from 'vitest';
import {
  deriveInterventionBillingDue,
  type InterventionBillingSource,
  type InterventionInvoiceProjection,
} from './derive-intervention-billing';

/**
 * [Revue adversariale 28/07 — finding 6] « Facturation sans délai » (§3.1/§3.5) : la dérivation
 * était exportée mais SANS aucun test — les deux invariants qui la rendent sûre n'étaient donc
 * prouvés nulle part : FAIL-CLOSED sur projection absente (jamais une alerte depuis une
 * projection muette, doctrine `devis_a_transmettre`) et RÉALLUMAGE après annulation de la
 * facture liée (extinction par l'état réel uniquement). Direction 6 : `contractId` est le SEUL
 * discriminant — un `kind` fantaisiste ne peut rien casser.
 */

function source(overrides: Partial<InterventionBillingSource> = {}): InterventionBillingSource {
  return {
    id: 'itv-1',
    status: 'completed',
    contractId: null,
    billedInvoiceId: null,
    kind: 'Visite d’entretien',
    chantierId: 'site-bastille',
    finishedAt: '2026-08-04T08:12:00.000Z',
    ...overrides,
  };
}

function invoices(
  ...rows: InterventionInvoiceProjection[]
): ReadonlyMap<string, InterventionInvoiceProjection> {
  return new Map(rows.map((row) => [row.id, row]));
}

describe('deriveInterventionBillingDue — « facturer sans délai » (§3.1/§3.5)', () => {
  it('allume `completed` et `signed` hors contrat, sans facture liée', () => {
    const due = deriveInterventionBillingDue(
      [source({ id: 'a' }), source({ id: 'b', status: 'signed' })],
      invoices(),
    );
    expect(due.map((fact) => fact.interventionId)).toEqual(['a', 'b']);
    expect(due[0]).toMatchObject({
      kind: 'Visite d’entretien',
      chantierId: 'site-bastille',
      finishedAt: '2026-08-04T08:12:00.000Z',
    });
  });

  it('n’allume JAMAIS un passage non terminé, annulé, ou contractuel (direction 6)', () => {
    const due = deriveInterventionBillingDue(
      [
        source({ id: 'planifie', status: 'scheduled', finishedAt: null }),
        source({ id: 'en-cours', status: 'in_progress', finishedAt: null }),
        source({ id: 'annule', status: 'cancelled', finishedAt: null }),
        // `kind` fantaisiste ET contractId posé : c'est contractId qui tranche, jamais kind.
        source({ id: 'contractuel', kind: 'Dépannage urgent', contractId: 'contract-1' }),
      ],
      invoices(),
    );
    expect(due).toEqual([]);
  });

  it('un `kind` qui RESSEMBLE à une visite contractuelle ne change rien sans contractId', () => {
    const due = deriveInterventionBillingDue(
      [source({ id: 'a', kind: 'Visite contractuelle', contractId: null })],
      invoices(),
    );
    expect(due.map((fact) => fact.interventionId)).toEqual(['a']);
  });

  it('FAIL-CLOSED : lien posé mais projection de la pièce NON transportée → aucune alerte', () => {
    const due = deriveInterventionBillingDue(
      [source({ id: 'a', billedInvoiceId: 'inv-1' })],
      // La facture existe peut-être, mais elle n'est pas dans la projection : on n'invente rien.
      invoices(),
    );
    expect(due).toEqual([]);
  });

  it('pièce VIVANTE (brouillon, émise, payée) : le passage reste couvert', () => {
    for (const status of ['draft', 'issued', 'partially_paid', 'late', 'paid']) {
      const due = deriveInterventionBillingDue(
        [source({ id: 'a', billedInvoiceId: 'inv-1' })],
        invoices({ id: 'inv-1', status }),
      );
      expect(due, `statut ${status}`).toEqual([]);
    }
  });

  it('RÉALLUMAGE : la facture liée ANNULÉE rend le passage à facturer (état réel)', () => {
    const due = deriveInterventionBillingDue(
      [source({ id: 'a', status: 'signed', billedInvoiceId: 'inv-1' })],
      invoices({ id: 'inv-1', status: 'cancelled' }),
    );
    expect(due.map((fact) => fact.interventionId)).toEqual(['a']);
  });

  it('lot mixte : seuls les passages réellement dus ressortent, dans l’ordre d’entrée', () => {
    const due = deriveInterventionBillingDue(
      [
        source({ id: 'du-1' }),
        source({ id: 'couvert', billedInvoiceId: 'inv-vivante' }),
        source({ id: 'muet', billedInvoiceId: 'inv-absente' }),
        source({ id: 'du-2', status: 'signed', billedInvoiceId: 'inv-annulee' }),
        source({ id: 'contractuel', contractId: 'contract-1' }),
      ],
      invoices({ id: 'inv-vivante', status: 'issued' }, { id: 'inv-annulee', status: 'cancelled' }),
    );
    expect(due.map((fact) => fact.interventionId)).toEqual(['du-1', 'du-2']);
  });

  it('liste vide : zéro priorité (l’état vide est un état de premier rang)', () => {
    expect(deriveInterventionBillingDue([], invoices())).toEqual([]);
  });
});

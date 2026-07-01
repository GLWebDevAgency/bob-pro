import { type Result, ok, err, type AppError } from '@bob/core';
import { type AnyTool, type Tool } from './tool';
import { type BobActions } from '../agent/actions';

function appValidation(field: string, message: string): AppError {
  return { kind: 'validation', issues: [{ field, message }] };
}

/**
 * Construit le registre d'outils de Bob à partir de la surface d'actions (parité).
 * Chaque outil DÉLÈGUE à une méthode de BobActions : aucune logique métier ici.
 */
export function buildBobTools(actions: BobActions): AnyTool[] {
  const computePayout: Tool<Record<string, never>, { payoutCents: number; availableCents: number }> = {
    name: 'tresorerie_versement',
    description: 'Calcule combien l’artisan peut se verser sans risque (trésorerie réelle).',
    mutating: false,
    outbound: false,
    compliance: 'low',
    parse: () => ok({}),
    run: () => actions.computePayout(),
  };

  const draftRelance: Tool<Record<string, never>, { subject: string; body: string }> = {
    name: 'relance_brouillon',
    description: 'Rédige un brouillon de relance pour la facture impayée la plus urgente (n’envoie rien).',
    mutating: false,
    outbound: false,
    compliance: 'low',
    parse: () => ok({}),
    run: () => actions.draftRelance(),
  };

  const listPayable: Tool<Record<string, never>, unknown> = {
    name: 'factures_impayees',
    description: 'Liste les factures encore à encaisser (numéro, client, reste dû).',
    mutating: false,
    outbound: false,
    compliance: 'low',
    parse: () => ok({}),
    run: () => actions.listPayableInvoices(),
  };

  const registerPayment: Tool<
    { invoiceId: string; amountCents: number; idempotencyKey?: string | null },
    { status: string }
  > = {
    name: 'encaisser_facture',
    description: 'Marque une facture comme encaissée (paiement reçu). Action interne réversible.',
    mutating: true,
    outbound: false, // encaissement = interne/réversible, pas un envoi vers un tiers
    compliance: 'medium',
    parse: (raw): Result<{ invoiceId: string; amountCents: number; idempotencyKey?: string | null }, AppError> => {
      const r = raw as { invoiceId?: unknown; amountCents?: unknown; idempotencyKey?: unknown };
      if (typeof r?.invoiceId !== 'string' || r.invoiceId.length === 0)
        return err(appValidation('invoiceId', 'Facture manquante.'));
      if (typeof r?.amountCents !== 'number' || !Number.isInteger(r.amountCents) || r.amountCents <= 0)
        return err(appValidation('amountCents', 'Montant invalide.'));
      if (r.idempotencyKey !== undefined && r.idempotencyKey !== null && typeof r.idempotencyKey !== 'string')
        return err(appValidation('idempotencyKey', 'Clé d’idempotence invalide.'));
      return ok({ invoiceId: r.invoiceId, amountCents: r.amountCents, idempotencyKey: r.idempotencyKey ?? null });
    },
    run: (input) => actions.registerPayment(input),
  };

  return [computePayout, draftRelance, listPayable, registerPayment] as AnyTool[];
}

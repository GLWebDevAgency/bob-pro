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
    riskTier: 'read',
    run: () => actions.computePayout(),
  };

  const draftRelance: Tool<Record<string, never>, { subject: string; body: string }> = {
    name: 'relance_brouillon',
    description: 'Rédige un brouillon de relance pour la facture impayée la plus urgente (n’envoie rien).',
    mutating: false,
    outbound: false,
    compliance: 'low',
    parse: () => ok({}),
    riskTier: 'read',
    run: () => actions.draftRelance(),
  };

  const listPayable: Tool<Record<string, never>, unknown> = {
    name: 'factures_impayees',
    description: 'Liste les factures encore à encaisser (numéro, client, reste dû).',
    mutating: false,
    outbound: false,
    compliance: 'low',
    parse: () => ok({}),
    riskTier: 'read',
    run: () => actions.listPayableInvoices(),
  };

  const listDocuments: Tool<Record<string, never>, unknown> = {
    name: 'documents_liste',
    description: 'Liste les derniers documents archivés de la société (PDF, XML Factur-X, reçus, justificatifs).',
    mutating: false,
    outbound: false,
    compliance: 'medium',
    parse: () => ok({}),
    riskTier: 'read',
    run: () => actions.listDocuments(),
  };

  const sendQuote: Tool<{ quoteId: string }, { number: string }> = {
    name: 'envoyer_devis',
    description: 'Envoie un devis au client et crée/renouvelle son lien de signature.',
    mutating: true,
    outbound: true,
    compliance: 'medium',
    parse: (raw): Result<{ quoteId: string }, AppError> => {
      const r = raw as { quoteId?: unknown };
      if (typeof r?.quoteId !== 'string' || r.quoteId.length === 0) return err(appValidation('quoteId', 'Devis manquant.'));
      return ok({ quoteId: r.quoteId });
    },
    riskTier: 'outbound',
    run: (input) => actions.sendQuote(input),
  };

  const issueInvoice: Tool<{ invoiceId: string }, { number: string }> = {
    name: 'emettre_facture',
    description: 'Émet une facture définitive : numéro légal séquentiel, mentions et PDF/Factur-X archivés.',
    mutating: true,
    outbound: false,
    compliance: 'high',
    safetyFloor: true,
    parse: (raw): Result<{ invoiceId: string }, AppError> => {
      const r = raw as { invoiceId?: unknown };
      if (typeof r?.invoiceId !== 'string' || r.invoiceId.length === 0)
        return err(appValidation('invoiceId', 'Facture manquante.'));
      return ok({ invoiceId: r.invoiceId });
    },
    riskTier: 'fiscal',
    run: (input) => actions.issueInvoice(input),
  };

  const registerPayment: Tool<
    { invoiceId: string; amountCents: number; idempotencyKey?: string | null },
    { status: string }
  > = {
    name: 'encaisser_facture',
    description: 'Marque une facture comme encaissée (paiement reçu). Réversible, mais impacte les livres (CA/TVA/relances).',
    mutating: true,
    outbound: false, // pas un envoi vers un tiers…
    compliance: 'medium',
    // …mais PLANCHER de sécurité : le POSTING d'un paiement modifie les livres (CA, TVA, statut client,
    // relances, rapprochement) -> toujours confirmer (même en auto), via un OK voix/tap rapide (décision Claude+Codex).
    safetyFloor: true,
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
    riskTier: 'accounting',
    run: (input) => actions.registerPayment(input),
  };

  return [computePayout, draftRelance, listPayable, listDocuments, sendQuote, issueInvoice, registerPayment] as AnyTool[];
}

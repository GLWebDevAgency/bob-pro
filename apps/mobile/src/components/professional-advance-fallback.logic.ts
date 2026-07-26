/**
 * Repli « Situation n°1 » de l'acompte professionnel — logique PURE (aucun import React
 * Native), extraite de DocumentActions.tsx et testée en node (même doctrine que
 * document-gates.logic.ts).
 *
 * L'acompte B2B/B2G reste FERMÉ par le domaine (professionalAdvanceRecoveryGuard, fail-closed
 * côté serveur) : le format structuré EN 16931/Factur-X ne sait pas exprimer une reprise
 * d'avance fiable, et Bob refuse d'émettre une donnée fiscale fausse. Décision fondateur
 * 25/07 : au lieu du refus sec, proposer l'ÉQUIVALENT conforme au moment exact où l'artisan
 * aurait cherché l'acompte — la première situation de travaux (même encaissement, pièces
 * justes), 30 % du marché par défaut, TOUJOURS modifiable dans la feuille situation. La garde
 * du cumul reste au SERVEUR (GenerateInvoiceFromQuote) : ce module ne décide que l'AFFICHAGE.
 */
import type { InvoiceView } from '@bob/api-client';

/** % proposé par défaut pour la situation n°1 (l'usage du BTP à l'ouverture d'un marché) —
 *  une PROPOSITION : les steppers de la feuille situation restent maîtres du % final. */
export const ADVANCE_FALLBACK_DEFAULT_PERCENT = 30;

export interface ProfessionalAdvanceFallback {
  /** true = l'option « Situation n°1 — 30 % du marché » s'affiche LÀ où l'acompte fermé
   *  aurait été proposé (Sheet de choix du devis signé). */
  readonly offered: boolean;
  /** Graine du % transmise à la feuille situation — jamais imposée (clamp + steppers). */
  readonly initialPercent: number;
}

const NOT_OFFERED: ProfessionalAdvanceFallback = {
  offered: false,
  initialPercent: ADVANCE_FALLBACK_DEFAULT_PERCENT,
};

/**
 * Décide l'affichage du repli. FAIL-CLOSED comme `depositPathAvailable` : une fiche client
 * absente (`customerType` null) n'ouvre RIEN — ni acompte, ni option numérotée. Le B2C garde
 * son vrai chemin d'acompte (PDF/e-reporting) : aucun repli à lui proposer. Sans acompte
 * porté par le devis signé, l'artisan n'aurait jamais « cherché l'acompte » : l'entrée
 * générique « Facturer une situation » suffit. Et si une situation vivante existe déjà,
 * « n°1 » serait un mensonge — le chemin conforme est déjà connu, l'option générique reste.
 */
export function deriveProfessionalAdvanceFallback(input: {
  customerType: 'b2c' | 'b2b' | 'b2g' | null;
  depositPct: number | null;
  hasSituationSibling: boolean;
}): ProfessionalAdvanceFallback {
  if (input.customerType !== 'b2b' && input.customerType !== 'b2g') return NOT_OFFERED;
  if (input.depositPct === null) return NOT_OFFERED;
  if (input.hasSituationSibling) return NOT_OFFERED;
  return { offered: true, initialPercent: ADVANCE_FALLBACK_DEFAULT_PERCENT };
}

/** Projection minimale d'une pièce sœur du devis (InvoiceView suffit structurellement). */
export type AdvanceFallbackSibling = Pick<InvoiceView, 'parentQuoteId' | 'kind' | 'status'>;

/**
 * Une situation VIVANTE existe déjà sur ce devis — mêmes règles que la base de la feuille
 * situation (deriveSituationBasis) : brouillons compris (ils comptent au cumul serveur dès
 * leur création), pièces annulées jamais.
 */
export function hasLivingSituationSibling(
  quoteId: string,
  invoices: readonly AdvanceFallbackSibling[],
): boolean {
  return invoices.some(
    (invoice) =>
      invoice.parentQuoteId === quoteId &&
      invoice.kind === 'situation' &&
      invoice.status !== 'cancelled',
  );
}

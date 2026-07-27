import {
  buildQuoteRelance,
  quoteRelancePalierOf,
  type DateOnly,
  type QuoteRelancePalier,
  type QuoteStatus,
} from '@bob/core';

/**
 * PR-05 — le rappel « Devis sans réponse » (quote-relance-reminder) promet : « Ouvrez le devis
 * dans Bob : un message pré-rédigé vous attend — rien ne part sans votre geste », et son deep
 * link mène à /devis/[id]. CE module tient la promesse sur la fiche devis : au MÊME palier que
 * le cron (quoteRelancePalierOf — une seule dérivation) il compose le MÊME message que la carte
 * Aujourd'hui (buildQuoteRelance), prêt à partager avec un lien de signature frais au moment du
 * Share. FAIL-CLOSED : hors palier (statut, date d'établissement absente/nulle) ou client non
 * résolu ⇒ null — jamais de carte fantôme ni de « Bonjour  » sans destinataire.
 */

export interface QuoteRelancePromptInput {
  readonly status: QuoteStatus;
  /** Date d'établissement RÉELLE (ancre J+15/J+30) — absente/nulle = jamais de relance. */
  readonly issuedAt?: string | null;
  readonly number: string | null;
  readonly ttcCents: number;
  /** Nom résolu du client — vide = pas de prompt (le message s'adresse à quelqu'un). */
  readonly customerName: string;
  readonly today: DateOnly;
  readonly personality: 'Pote' | 'Pro' | 'Direct';
}

export interface QuoteRelancePrompt {
  readonly palier: QuoteRelancePalier;
  readonly daysSinceIssued: number;
  /** Corps pré-rédigé SANS lien — l'aperçu montré sur la fiche (le lien n'existe qu'au partage). */
  readonly previewBody: string;
  /** Corps final composé avec l'URL de signature FRAÎCHE, au moment du Share uniquement. */
  readonly buildShareMessage: (signatureUrl: string) => string;
}

export function quoteRelancePromptOf(input: QuoteRelancePromptInput): QuoteRelancePrompt | null {
  if (input.customerName === '') return null;
  const reached = quoteRelancePalierOf(
    { status: input.status, issuedAt: input.issuedAt ?? null },
    input.today,
  );
  if (reached === null) return null;
  const base = {
    customerName: input.customerName,
    // Un devis envoyé/vu porte toujours un numéro ; parité stricte avec la carte Aujourd'hui.
    docNumber: input.number ?? '',
    amountCents: input.ttcCents,
    daysSinceIssued: reached.daysSinceIssued,
    personality: input.personality,
  };
  return {
    palier: reached.palier,
    daysSinceIssued: reached.daysSinceIssued,
    previewBody: buildQuoteRelance(base).body,
    buildShareMessage: (signatureUrl) => buildQuoteRelance({ ...base, signatureUrl }).body,
  };
}

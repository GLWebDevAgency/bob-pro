import { type Instant } from '../../shared-kernel/time';

/**
 * GRAND LIVRE DE VALEUR (pilier 2, rétention) — service domaine PUR qui transforme les faits
 * RÉELS de la période (encaissements, recouvrements, documents, actions vocales) en un digest
 * « Bob t'a fait gagner X » : réciprocité honnête, jamais un chiffre inventé.
 *
 * Règles non négociables :
 * · chaque fait vient des données réelles du tenant (paiements enregistrés, relances suivies
 *   d'un paiement, documents créés) — AUCUNE estimation n'est présentée comme un fait ;
 * · le temps économisé est une ESTIMATION calibrée par une table d'ENTRÉE (minutes par type
 *   d'action, pattern VoiceUsagePriceTable) et toujours annoncé comme estimation par l'UI ;
 * · un digest sans substance N'EXISTE PAS (null) — une notification sans valeur est du bruit,
 *   et le bruit tue la rétention qu'il prétend servir ;
 * · l'accroche (highlight) est UNIQUE et ordonnée argent > temps > volume : l'artisan lit
 *   une phrase, pas un tableau de bord.
 */

export type ValueEventKind =
  | 'payment_collected' // paiement encaissé sur la période (fait, en centimes)
  | 'overdue_recovered' // paiement encaissé sur une facture qui était EN RETARD après relance
  | 'document_created' // devis/facture créé (viaVoice précise le canal)
  | 'relance_sent' // relance envoyée (l'effet se mesure via overdue_recovered)
  | 'voice_action_completed'; // action aboutie en session vocale (hors création de document)

export interface ValueEvent {
  readonly kind: ValueEventKind;
  readonly at: Instant;
  /** Centimes — requis pour payment_collected / overdue_recovered, ignoré sinon. */
  readonly amountCents?: number;
  readonly viaVoice?: boolean;
}

/** Minutes économisées par événement — table d'ENTRÉE calibrée (jamais une constante vérité).
 *  Ordres de grandeur par défaut sourcés des études temps-administratif artisans (2-8 h/sem). */
export type ValueMinutesTable = Readonly<Partial<Record<ValueEventKind, number>>>;

export const DEFAULT_VALUE_MINUTES: ValueMinutesTable = {
  document_created: 18, // un devis/facture à la main : mise en forme, calculs, mentions
  relance_sent: 12, // rédaction + suivi d'une relance d'impayé
  voice_action_completed: 4, // recherche/navigation/saisie évitées par le vocal
};

export interface ValueDigest {
  readonly periodStart: Instant;
  readonly periodEnd: Instant;
  /** FAITS (centimes) — présentés tels quels. */
  readonly collectedCents: number;
  readonly recoveredCents: number;
  readonly documentsCreated: number;
  readonly documentsViaVoice: number;
  readonly relancesSent: number;
  /** ESTIMATION (minutes) — l'UI l'annonce comme telle (« environ »). */
  readonly estimatedMinutesSaved: number;
  /** L'accroche unique du digest — argent > temps > volume. */
  readonly highlight:
    | { readonly kind: 'money'; readonly amountCents: number; readonly recovered: boolean }
    | { readonly kind: 'time'; readonly minutes: number }
    | { readonly kind: 'volume'; readonly documents: number };
}

/** Seuils de SUBSTANCE : en-dessous, pas de digest du tout (jamais de bruit). */
export const DIGEST_MIN_MINUTES = 30;
export const DIGEST_MIN_DOCUMENTS = 3;

export function buildValueDigest(input: {
  readonly periodStart: Instant;
  readonly periodEnd: Instant;
  readonly events: readonly ValueEvent[];
  readonly minutes?: ValueMinutesTable;
}): ValueDigest | null {
  const table = input.minutes ?? DEFAULT_VALUE_MINUTES;
  const startMs = Date.parse(input.periodStart);
  const endMs = Date.parse(input.periodEnd);

  let collectedCents = 0;
  let recoveredCents = 0;
  let documentsCreated = 0;
  let documentsViaVoice = 0;
  let relancesSent = 0;
  let estimatedMinutesSaved = 0;

  for (const event of input.events) {
    const atMs = Date.parse(event.at);
    if (Number.isNaN(atMs) || atMs < startMs || atMs >= endMs) continue; // hors période — jamais compté deux fois
    const amount = event.amountCents ?? 0;
    if (amount < 0 || !Number.isFinite(amount)) continue; // un fait de valeur ne recule jamais
    switch (event.kind) {
      case 'payment_collected':
        collectedCents += amount;
        break;
      case 'overdue_recovered':
        // Un recouvrement EST un encaissement : il compte dans les deux, l'UI ne les somme jamais.
        collectedCents += amount;
        recoveredCents += amount;
        break;
      case 'document_created':
        documentsCreated += 1;
        if (event.viaVoice === true) documentsViaVoice += 1;
        break;
      case 'relance_sent':
        relancesSent += 1;
        break;
      case 'voice_action_completed':
        break;
    }
    const minutes = table[event.kind];
    if (minutes !== undefined && minutes > 0) estimatedMinutesSaved += minutes;
  }

  const hasSubstance =
    collectedCents > 0 ||
    estimatedMinutesSaved >= DIGEST_MIN_MINUTES ||
    documentsCreated >= DIGEST_MIN_DOCUMENTS;
  if (!hasSubstance) return null;

  const highlight: ValueDigest['highlight'] =
    recoveredCents > 0
      ? { kind: 'money', amountCents: recoveredCents, recovered: true }
      : collectedCents > 0
        ? { kind: 'money', amountCents: collectedCents, recovered: false }
        : estimatedMinutesSaved >= DIGEST_MIN_MINUTES
          ? { kind: 'time', minutes: estimatedMinutesSaved }
          : { kind: 'volume', documents: documentsCreated };

  return {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    collectedCents,
    recoveredCents,
    documentsCreated,
    documentsViaVoice,
    relancesSent,
    estimatedMinutesSaved,
    highlight,
  };
}

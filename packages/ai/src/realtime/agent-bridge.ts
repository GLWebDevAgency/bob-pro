/**
 * PONT AGENT ↔ TRANSPORT TEMPS RÉEL (BOB LIVE) — côté agent, TRANSPORT-AGNOSTIQUE.
 * Le transport (WebRTC realtime, lane GPT) implémente `RealtimeTransportPort` ; l'agent
 * expose `RealtimeAgentBridge`. AUCUNE dépendance provider ici : gpt-realtime, Mistral
 * realtime ou un repli texte se branchent sur le MÊME contrat.
 *
 * Les 4 conditions de sûreté de SPEC_BOB_LIVE.md sont ENCODÉES dans ce contrat :
 * 1. Aucun montant improvisé : `auditRealtimeUtterance` vérifie chaque énoncé assistant
 *    contre les FAITS DES OUTILS du tour (extractFacts) → violation = correction immédiate.
 * 2. Le modèle ne consent jamais seul : `realtimeConsentDecision` impose NOTRE parseur
 *    déterministe sur le verbatim utilisateur quand une proposition attend.
 * 3. Provider pluggable : ce fichier est la SEULE surface — zéro type OpenAI.
 * 4. Dégradation honnête : `end(reason)` typé, le client bascule sur le repli texte.
 */
import { extractFacts } from '../guardrails/naturalize';
import { parseVoiceConsent, type VoiceConsent } from '../voice/voice-confirm';

export interface RealtimeToolCall {
  readonly callId: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** Résultat d'outil STRUCTURÉ — la seule source de faits chiffrés que le modèle peut lire. */
export interface RealtimeToolResult {
  readonly callId: string;
  readonly ok: boolean;
  /** Faits sérialisés (montants, pièces, %) — servent aussi de référentiel d'audit. */
  readonly payload: string;
}

export type RealtimeEndReason = 'user' | 'entitlement' | 'network' | 'provider_error' | 'safety';

/** Ce que le TRANSPORT (lane GPT) doit fournir au pont. */
export interface RealtimeTransportPort {
  /** Correction parlée IMMÉDIATE après violation d'audit (condition 1). */
  speakCorrection(text: string): Promise<void>;
  /** Coupe la génération/parole en cours (troncature côté provider). */
  interrupt(): Promise<void>;
  /** Termine la session — le client bascule sur le repli (condition 4). */
  end(reason: RealtimeEndReason): Promise<void>;
}

export interface RealtimeAuditVerdict {
  readonly ok: boolean;
  /** Faits énoncés par le modèle ABSENTS des résultats d'outils du tour. */
  readonly violations: readonly string[];
  /** Correction à prononcer si violation (préparée, jamais improvisée). */
  readonly correction: string | null;
}

/**
 * CONDITION 1 — audite un énoncé ASSISTANT contre les faits d'outils du tour : tout montant,
 * numéro de pièce ou pourcentage prononcé DOIT provenir d'un RealtimeToolResult. L'omission
 * est permise (condenser est un droit) ; l'invention/déformation jamais.
 */
export function auditRealtimeUtterance(
  spokenText: string,
  toolResults: readonly RealtimeToolResult[],
): RealtimeAuditVerdict {
  const allowed = new Set<string>();
  for (const result of toolResults) {
    for (const fact of extractFacts(result.payload)) allowed.add(fact);
  }
  const violations = [...extractFacts(spokenText)].filter((fact) => !allowed.has(fact));
  if (violations.length === 0) return { ok: true, violations: [], correction: null };
  return {
    ok: false,
    violations,
    correction:
      'Correction : je viens de citer un chiffre inexact — les montants exacts sont affichés à l’écran, fie-toi à eux.',
  };
}

export type RealtimeConsentDecision =
  | { readonly kind: 'apply' }
  | { readonly kind: 'reject' }
  | { readonly kind: 'pass' };

/**
 * CONDITION 2 — quand une proposition (mutation) attend, la décision vient EXCLUSIVEMENT
 * de NOTRE parseur déterministe sur le VERBATIM utilisateur. Le modèle temps réel n'est
 * jamais l'arbitre d'un consentement. Sans proposition en attente : tout passe ('pass').
 */
export function realtimeConsentDecision(
  userVerbatim: string,
  hasPendingProposal: boolean,
): RealtimeConsentDecision {
  if (!hasPendingProposal) return { kind: 'pass' };
  const consent: VoiceConsent = parseVoiceConsent(userVerbatim);
  if (consent === 'confirm') return { kind: 'apply' };
  if (consent === 'cancel') return { kind: 'reject' };
  return { kind: 'pass' };
}

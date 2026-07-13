/**
 * MESURE DE CONSOMMATION BOB LIVE (directive fondateur 13/07) — « il nous faut la
 * consommation réelle en tokens et le prix réel par utilisateur » pour fixer, À LA FIN,
 * le prix des plans et le périmètre des fonctionnalités par plan.
 *
 * Modèle PUR : des événements d'usage (audio entrant/sortant, tokens LLM, TTS, STT) sont
 * émis par les hôtes (pont serveur realtime, askBob, TTS cloud), tagués tenant + plan ;
 * ce module les agrège en coût par tenant/jour/plan via une TABLE DE PRIX FOURNIE EN
 * ENTRÉE (les tarifs providers changent — ils ne sont JAMAIS codés en dur comme vérité).
 * Aucun montant de ce module n'est montré à l'utilisateur final : c'est un outil d'étude
 * tarifaire interne (les garde-fous « jamais un montant inventé » concernent l'UI).
 */

export type VoiceUsageKind =
  | 'realtime_audio_in_seconds' // parole utilisateur envoyée au modèle temps réel
  | 'realtime_audio_out_seconds' // parole générée par le modèle
  | 'realtime_tokens_in' // tokens texte entrants (instructions, outils, contexte)
  | 'realtime_tokens_out' // tokens texte sortants (transcripts, tool calls)
  | 'llm_tokens_in' // cerveau texte (classification, naturalisation, repli)
  | 'llm_tokens_out'
  | 'stt_seconds' // dictée cloud (Voxtral)
  | 'tts_characters'; // synthèse cloud

export interface VoiceUsageEvent {
  readonly tenantId: string;
  readonly plan: string;
  readonly kind: VoiceUsageKind;
  readonly amount: number;
  /** Epoch ms — fourni par l'hôte (jamais d'horloge interne : pur et rejouable). */
  readonly at: number;
  /** Session vocale d'origine (corrélation latence ↔ coût). */
  readonly sessionId?: string;
}

/** Prix par UNITÉ d'usage, en MILLI-centimes d'euro (précision sous le centime).
 *  À CALIBRER avec les tarifs providers du moment — table d'entrée, jamais une constante. */
export type VoiceUsagePriceTable = Readonly<Partial<Record<VoiceUsageKind, number>>>;

export interface TenantUsageSummary {
  readonly tenantId: string;
  readonly plan: string;
  readonly sessions: number;
  readonly byKind: Readonly<Partial<Record<VoiceUsageKind, number>>>;
  /** Coût total en centimes (arrondi bancaire au centime le plus proche). */
  readonly costCents: number;
}

export interface VoiceUsageStudy {
  readonly tenants: readonly TenantUsageSummary[];
  readonly totalCostCents: number;
  /** Coût moyen/médian par tenant actif — LA donnée de calibration tarifaire. */
  readonly averageCostCentsPerTenant: number | null;
  readonly medianCostCentsPerTenant: number | null;
}

function round(value: number): number {
  return Math.round(value);
}

/** Agrège les événements en étude tarifaire — pure, testable, rejouable sur l'historique. */
export function summarizeVoiceUsage(
  events: readonly VoiceUsageEvent[],
  prices: VoiceUsagePriceTable,
): VoiceUsageStudy {
  const byTenant = new Map<
    string,
    { plan: string; sessions: Set<string>; byKind: Map<VoiceUsageKind, number>; costMilli: number }
  >();
  for (const event of events) {
    if (!Number.isFinite(event.amount) || event.amount < 0) continue; // un compteur ne recule jamais
    let entry = byTenant.get(event.tenantId);
    if (!entry) {
      entry = { plan: event.plan, sessions: new Set(), byKind: new Map(), costMilli: 0 };
      byTenant.set(event.tenantId, entry);
    }
    entry.byKind.set(event.kind, (entry.byKind.get(event.kind) ?? 0) + event.amount);
    if (event.sessionId !== undefined) entry.sessions.add(event.sessionId);
    const unitPrice = prices[event.kind];
    if (unitPrice !== undefined) entry.costMilli += event.amount * unitPrice;
  }
  const tenants: TenantUsageSummary[] = [...byTenant.entries()]
    .map(([tenantId, entry]) => ({
      tenantId,
      plan: entry.plan,
      sessions: entry.sessions.size,
      byKind: Object.fromEntries(entry.byKind) as TenantUsageSummary['byKind'],
      costCents: round(entry.costMilli / 10),
    }))
    .sort((a, b) => b.costCents - a.costCents);
  const costs = tenants.map((t) => t.costCents).sort((a, b) => a - b);
  const total = costs.reduce((sum, c) => sum + c, 0);
  return {
    tenants,
    totalCostCents: total,
    averageCostCentsPerTenant: tenants.length > 0 ? round(total / tenants.length) : null,
    medianCostCentsPerTenant:
      costs.length > 0 ? costs[Math.floor((costs.length - 1) / 2)] ?? null : null,
  };
}

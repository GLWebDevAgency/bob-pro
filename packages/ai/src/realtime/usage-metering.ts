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
  | 'realtime_tokens_in' // agrégat provider historique, conservé pour compatibilité N-1
  | 'realtime_tokens_out' // agrégat provider historique, conservé pour compatibilité N-1
  | 'realtime_uncached_text_tokens_in'
  | 'realtime_uncached_audio_tokens_in'
  | 'realtime_uncached_image_tokens_in'
  | 'realtime_cached_text_tokens_in'
  | 'realtime_cached_audio_tokens_in'
  | 'realtime_cached_image_tokens_in'
  | 'realtime_text_tokens_out'
  | 'realtime_audio_tokens_out'
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
  /** Plan sous lequel CE coût a été engagé — un tenant qui change de plan en cours de
   * période produit une ligne PAR plan (jamais tout attribué au premier plan vu). */
  readonly plan: string;
  readonly sessions: number;
  readonly byKind: Readonly<Partial<Record<VoiceUsageKind, number>>>;
  /** Coût total en centimes (arrondi bancaire au centime le plus proche). */
  readonly costCents: number;
}

export interface VoiceUsageStudy {
  /** Une ligne par tenant×plan — LA granularité de calibration (coût moyen PAR PLAN). */
  readonly tenants: readonly TenantUsageSummary[];
  readonly totalCostCents: number;
  /** Coût moyen/médian par TENANT actif (tous plans confondus) — la donnée de calibration. */
  readonly averageCostCentsPerTenant: number | null;
  readonly medianCostCentsPerTenant: number | null;
}

function round(value: number): number {
  return Math.round(value);
}

/** Agrège les événements en étude tarifaire — pure, INDÉPENDANTE DE L'ORDRE des événements
 * (rejouable sur l'historique) : l'agrégation est par tenant×plan, le coût d'un tenant qui
 * passe solo→pro en cours de période reste attribué au plan réellement actif à l'usage. */
export function summarizeVoiceUsage(
  events: readonly VoiceUsageEvent[],
  prices: VoiceUsagePriceTable,
): VoiceUsageStudy {
  const byTenantPlan = new Map<
    string,
    {
      tenantId: string;
      plan: string;
      sessions: Set<string>;
      byKind: Map<VoiceUsageKind, number>;
      costMilli: number;
    }
  >();
  for (const event of events) {
    if (!Number.isFinite(event.amount) || event.amount < 0) continue; // un compteur ne recule jamais
    const key = `${event.tenantId}\u0000${event.plan}`;
    let entry = byTenantPlan.get(key);
    if (!entry) {
      entry = {
        tenantId: event.tenantId,
        plan: event.plan,
        sessions: new Set(),
        byKind: new Map(),
        costMilli: 0,
      };
      byTenantPlan.set(key, entry);
    }
    entry.byKind.set(event.kind, (entry.byKind.get(event.kind) ?? 0) + event.amount);
    if (event.sessionId !== undefined) entry.sessions.add(event.sessionId);
    const unitPrice = prices[event.kind];
    if (unitPrice !== undefined) entry.costMilli += event.amount * unitPrice;
  }
  const tenants: TenantUsageSummary[] = [...byTenantPlan.values()]
    .map((entry) => ({
      tenantId: entry.tenantId,
      plan: entry.plan,
      sessions: entry.sessions.size,
      byKind: Object.fromEntries(entry.byKind) as TenantUsageSummary['byKind'],
      costCents: round(entry.costMilli / 10),
    }))
    .sort((a, b) => b.costCents - a.costCents || a.tenantId.localeCompare(b.tenantId));
  // Moyenne/médiane PAR TENANT (pas par ligne tenant×plan) : un tenant multi-plan compte une fois.
  const perTenant = new Map<string, number>();
  for (const row of tenants) perTenant.set(row.tenantId, (perTenant.get(row.tenantId) ?? 0) + row.costCents);
  const costs = [...perTenant.values()].sort((a, b) => a - b);
  const total = costs.reduce((sum, c) => sum + c, 0);
  return {
    tenants,
    totalCostCents: total,
    averageCostCentsPerTenant: costs.length > 0 ? round(total / costs.length) : null,
    medianCostCentsPerTenant:
      costs.length > 0 ? costs[Math.floor((costs.length - 1) / 2)] ?? null : null,
  };
}

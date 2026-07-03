export type Provider = 'claude' | 'glm' | 'deepseek' | 'openai' | 'mistral';
export type ModelChoice = Provider | 'demo';

/** Fournisseurs hébergés dans l'UE (souveraineté des données). Mistral = IA française/européenne. */
export const EU_PROVIDERS: ReadonlySet<Provider> = new Set<Provider>(['mistral']);

export type TaskType =
  | 'intent.detect'
  | 'agent.plan'
  | 'agent.summarize'
  | 'relance.draft'
  | 'mentions.phrase'
  | 'diagnostic.explain'
  | 'cashflow.narrate'
  | 'ocr.postprocess'
  | 'customer.classify';

export interface RoutingContext {
  hasClaudeKey: boolean;
  hasGlmKey: boolean;
  hasDeepseekKey?: boolean;
  hasOpenaiKey?: boolean;
  hasMistralKey?: boolean;
  /** Mode souveraineté : ne router que vers des fournisseurs UE (Mistral). Pour un déploiement « full EU ». */
  euOnly?: boolean;
  /** Overrides d'env pour le catalogue de modèles (`<PROVIDER>_MODEL_<TIER>`). */
  envOverrides?: Readonly<Record<string, string | undefined>>;
}

/** Palier de capacité — décide du MODÈLE précis chez le fournisseur retenu. */
export type CapabilityTier = 'frontier' | 'balanced' | 'fast';

/**
 * Catalogue modèle par fournisseur × palier (A3-C14). Surclassable par env
 * (`<PROVIDER>_MODEL_<TIER>`, ex. CLAUDE_MODEL_FRONTIER=claude-fable-5 si l'org a accès
 * au tier Mythos/Fable, au-dessus d'Opus). GLM et DeepSeek : open source, économiques.
 */
export const MODEL_CATALOG: Record<Provider, Record<CapabilityTier, string>> = {
  claude: { frontier: 'claude-opus-4-8', balanced: 'claude-sonnet-5', fast: 'claude-haiku-4-5-20251001' },
  mistral: { frontier: 'mistral-large-latest', balanced: 'mistral-small-latest', fast: 'mistral-small-latest' },
  openai: { frontier: 'gpt-5', balanced: 'gpt-5-mini', fast: 'gpt-4o-mini' },
  glm: { frontier: 'glm-4-plus', balanced: 'glm-4-flash', fast: 'glm-4-flash' },
  deepseek: { frontier: 'deepseek-reasoner', balanced: 'deepseek-chat', fast: 'deepseek-chat' },
};

/** Palier requis par tâche : critique → frontier · rédaction/synthèse → balanced · volume → fast. */
export const TASK_TIER: Record<TaskType, CapabilityTier> = {
  'intent.detect': 'fast',
  'agent.plan': 'frontier',
  'agent.summarize': 'balanced',
  'relance.draft': 'balanced',
  'mentions.phrase': 'frontier',
  'diagnostic.explain': 'frontier',
  'cashflow.narrate': 'balanced',
  'ocr.postprocess': 'fast',
  'customer.classify': 'fast',
};

/** Modèle précis pour (fournisseur, palier), avec override d'environnement optionnel. */
export function modelFor(
  provider: Provider,
  tier: CapabilityTier,
  envOverrides?: Readonly<Record<string, string | undefined>>,
): string {
  const key = `${provider.toUpperCase()}_MODEL_${tier.toUpperCase()}`;
  return envOverrides?.[key] ?? MODEL_CATALOG[provider][tier];
}

export interface RoutingDecision {
  model: ModelChoice;
  reason: string;
  /** Palier de capacité requis par la tâche (absent en mode démo). */
  tier?: CapabilityTier;
  /** Modèle précis retenu chez le fournisseur (absent en mode démo). */
  modelId?: string;
}

/**
 * Politique de routage par CAPACITÉ et coût, avec chaîne de fallback ordonnée par tâche :
 * - tâches rapides/volume (intention, relance, narration) -> modèles économiques d'abord (GLM, DeepSeek).
 * - tâches critiques (planification, conformité, mentions légales) -> raisonneurs forts d'abord (Claude, OpenAI).
 * Le premier fournisseur disponible (clé présente) gagne ; sinon démo déterministe.
 */
const CHAINS: Record<TaskType, Provider[]> = {
  'intent.detect': ['glm', 'deepseek', 'mistral', 'claude', 'openai'],
  'agent.plan': ['claude', 'openai', 'mistral', 'deepseek', 'glm'],
  'agent.summarize': ['claude', 'mistral', 'deepseek', 'glm', 'openai'],
  // Rédaction en français : Mistral (FR) bien placé.
  'relance.draft': ['mistral', 'glm', 'deepseek', 'claude', 'openai'],
  'mentions.phrase': ['claude', 'openai', 'mistral', 'deepseek', 'glm'],
  'diagnostic.explain': ['claude', 'mistral', 'openai', 'deepseek', 'glm'],
  'cashflow.narrate': ['mistral', 'glm', 'deepseek', 'claude', 'openai'],
  'ocr.postprocess': ['glm', 'deepseek', 'mistral', 'claude', 'openai'],
  'customer.classify': ['glm', 'deepseek', 'mistral', 'claude', 'openai'],
};

const CRITICAL: ReadonlySet<TaskType> = new Set<TaskType>(['agent.plan', 'mentions.phrase', 'diagnostic.explain']);

export class ModelRouter {
  constructor(private readonly ctx: RoutingContext) {}

  private available(p: Provider): boolean {
    switch (p) {
      case 'claude':
        return this.ctx.hasClaudeKey;
      case 'glm':
        return this.ctx.hasGlmKey;
      case 'deepseek':
        return this.ctx.hasDeepseekKey ?? false;
      case 'openai':
        return this.ctx.hasOpenaiKey ?? false;
      case 'mistral':
        return this.ctx.hasMistralKey ?? false;
    }
  }

  route(task: TaskType): RoutingDecision {
    // Mode souveraineté UE : on ne considère que les fournisseurs européens (Mistral).
    const chain = this.ctx.euOnly ? CHAINS[task].filter((p) => EU_PROVIDERS.has(p)) : CHAINS[task];
    for (let i = 0; i < chain.length; i++) {
      const p = chain[i]!;
      if (this.available(p)) {
        const tier = TASK_TIER[task];
        return {
          model: p,
          reason: i === 0 ? `modèle préféré pour ${task}` : `fallback #${i} pour ${task}`,
          tier,
          modelId: modelFor(p, tier, this.ctx.envOverrides),
        };
      }
    }
    return {
      model: 'demo',
      reason: this.ctx.euOnly ? 'mode UE : aucune clé Mistral — démo' : 'aucune clé configurée — mode démo déterministe',
    };
  }

  isCritical(task: TaskType): boolean {
    return CRITICAL.has(task);
  }
}

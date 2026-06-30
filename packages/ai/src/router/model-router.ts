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
}

export interface RoutingDecision {
  model: ModelChoice;
  reason: string;
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
        return { model: p, reason: i === 0 ? `modèle préféré pour ${task}` : `fallback #${i} pour ${task}` };
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

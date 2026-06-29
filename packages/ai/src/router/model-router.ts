export type ModelChoice = 'claude' | 'glm' | 'demo';

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
}

export interface RoutingDecision {
  model: ModelChoice;
  reason: string;
}

/**
 * Politique de routage : Claude pour le raisonnement / la conformité (criticité haute),
 * GLM pour le volume rapide/économique. Fallback croisé, puis démo si aucune clé.
 */
const POLICY: Record<TaskType, { preferred: 'claude' | 'glm'; critical: boolean }> = {
  'intent.detect': { preferred: 'glm', critical: false },
  'agent.plan': { preferred: 'claude', critical: true },
  'agent.summarize': { preferred: 'claude', critical: false },
  'relance.draft': { preferred: 'glm', critical: false },
  'mentions.phrase': { preferred: 'claude', critical: true },
  'diagnostic.explain': { preferred: 'claude', critical: true },
  'cashflow.narrate': { preferred: 'glm', critical: false },
  'ocr.postprocess': { preferred: 'glm', critical: false },
  'customer.classify': { preferred: 'glm', critical: false },
};

export class ModelRouter {
  constructor(private readonly ctx: RoutingContext) {}

  private available(m: 'claude' | 'glm'): boolean {
    return m === 'claude' ? this.ctx.hasClaudeKey : this.ctx.hasGlmKey;
  }

  route(task: TaskType): RoutingDecision {
    const policy = POLICY[task];
    if (this.available(policy.preferred)) {
      return { model: policy.preferred, reason: `modèle préféré pour ${task}` };
    }
    const fallback: 'claude' | 'glm' = policy.preferred === 'claude' ? 'glm' : 'claude';
    if (this.available(fallback)) {
      return { model: fallback, reason: `fallback (${policy.preferred} indisponible)` };
    }
    return { model: 'demo', reason: 'aucune clé configurée — mode démo déterministe' };
  }

  isCritical(task: TaskType): boolean {
    return POLICY[task].critical;
  }
}

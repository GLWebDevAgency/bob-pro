import { describe, it, expect } from 'vitest';
import { ModelRouter, TASK_TIER, type TaskType } from './model-router';

const TASKS = Object.keys(TASK_TIER) as TaskType[];

describe('ModelRouter', () => {
  it('route les tâches critiques vers Claude quand dispo', () => {
    const r = new ModelRouter({ hasClaudeKey: true, hasGlmKey: true });
    expect(r.route('agent.plan').model).toBe('claude');
    expect(r.route('mentions.phrase').model).toBe('claude');
  });
  it('route le volume vers GLM', () => {
    const r = new ModelRouter({ hasClaudeKey: true, hasGlmKey: true });
    expect(r.route('relance.draft').model).toBe('glm');
    expect(r.route('customer.classify').model).toBe('glm');
  });
  it('fallback croisé si une clé manque', () => {
    expect(new ModelRouter({ hasClaudeKey: true, hasGlmKey: false }).route('relance.draft').model).toBe('claude');
    expect(new ModelRouter({ hasClaudeKey: false, hasGlmKey: true }).route('agent.plan').model).toBe('glm');
  });
  it('déclare la capacité indisponible si aucune clé réelle n’est configurée', () => {
    expect(new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }).route('agent.plan').model).toBe('unavailable');
  });

  it('épingle OpenAI sur toutes les tâches même si tous les fournisseurs sont disponibles', () => {
    const router = new ModelRouter({
      hasClaudeKey: true,
      hasGlmKey: true,
      hasDeepseekKey: true,
      hasOpenaiKey: true,
      hasMistralKey: true,
      requiredProvider: 'openai',
    });

    for (const task of TASKS) {
      expect(router.route(task)).toMatchObject({ model: 'openai', tier: TASK_TIER[task] });
    }
  });

  it('échoue fermé quand le fournisseur imposé est absent, sans fallback vers une autre clé', () => {
    const router = new ModelRouter({
      hasClaudeKey: true,
      hasGlmKey: true,
      hasMistralKey: true,
      hasOpenaiKey: false,
      requiredProvider: 'openai',
    });

    for (const task of TASKS) {
      expect(router.route(task)).toEqual({
        model: 'unavailable',
        reason: 'fournisseur openai requis mais indisponible',
      });
    }
  });

  it('refuse une contrainte non européenne quand le mode UE est actif', () => {
    expect(new ModelRouter({
      hasClaudeKey: false,
      hasGlmKey: false,
      hasOpenaiKey: true,
      requiredProvider: 'openai',
      euOnly: true,
    }).route('agent.plan')).toEqual({
      model: 'unavailable',
      reason: 'fournisseur openai incompatible avec le mode UE',
    });
  });
});

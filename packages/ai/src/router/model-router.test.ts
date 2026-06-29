import { describe, it, expect } from 'vitest';
import { ModelRouter } from './model-router';

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
  it('mode démo si aucune clé', () => {
    expect(new ModelRouter({ hasClaudeKey: false, hasGlmKey: false }).route('agent.plan').model).toBe('demo');
  });
});

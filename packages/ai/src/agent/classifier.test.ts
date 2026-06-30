import { describe, it, expect } from 'vitest';
import { classifyWithLlm, classifyWithRegex } from './classifier';
import { type LlmPort, type LlmCompletion } from '../llm/port';

const fakeLlm = (completion: LlmCompletion): LlmPort => ({
  id: 'fake',
  async complete() {
    return completion;
  },
  async generate() {
    return { text: '', model: 'fake' };
  },
  async health() {
    return { healthy: true };
  },
});

describe('classifyWithLlm (tool-calling)', () => {
  it('mappe un appel d’outil encaisser + référence', async () => {
    const r = await classifyWithLlm(
      fakeLlm({ text: null, toolCalls: [{ name: 'encaisser_facture', arguments: { reference: '2026-014' } }], model: 'glm' }),
      'la facture de Durand est payée',
    );
    expect(r.intent).toBe('encaisser');
    expect(r.reference).toBe('2026-014');
    expect(r.model).toBe('glm');
  });

  it('réponse texte (aucun outil) -> unknown', async () => {
    const r = await classifyWithLlm(fakeLlm({ text: 'Bonjour !', toolCalls: [], model: 'claude' }), 'salut');
    expect(r.intent).toBe('unknown');
  });

  it('outil inconnu -> unknown', async () => {
    const r = await classifyWithLlm(fakeLlm({ text: null, toolCalls: [{ name: 'autre', arguments: {} }], model: 'glm' }), 'x');
    expect(r.intent).toBe('unknown');
  });
});

describe('classifyWithRegex (fallback déterministe)', () => {
  it('détecte le versement', () => {
    expect(classifyWithRegex('combien je peux me verser').intent).toBe('payout');
  });
  it('extrait la référence de facture', () => {
    const c = classifyWithRegex('encaisse la facture 2026-014');
    expect(c.intent).toBe('encaisser');
    expect(c.reference).toBe('2026-014');
  });
});

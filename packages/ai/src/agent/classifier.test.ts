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

describe('classifyWithLlm (tool-calling -> plan)', () => {
  it('mappe un appel d’outil encaisser + référence', async () => {
    const r = await classifyWithLlm(
      fakeLlm({ text: null, toolCalls: [{ name: 'encaisser_facture', arguments: { reference: '2026-014' } }], model: 'glm' }),
      'la facture de Durand est payée',
    );
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]?.intent).toBe('encaisser');
    expect(r.steps[0]?.reference).toBe('2026-014');
    expect(r.model).toBe('glm');
  });

  it('plan multi-étapes : plusieurs appels d’outils', async () => {
    const r = await classifyWithLlm(
      fakeLlm({
        text: null,
        toolCalls: [
          { name: 'encaisser_facture', arguments: { reference: '2026-014' } },
          { name: 'relance_brouillon', arguments: {} },
        ],
        model: 'glm',
      }),
      'encaisse la 14 puis prépare une relance',
    );
    expect(r.steps.map((s) => s.intent)).toEqual(['encaisser', 'relance']);
  });

  it('mappe les outils devis/facture/documents', async () => {
    const r = await classifyWithLlm(
      fakeLlm({
        text: null,
        toolCalls: [
          { name: 'envoyer_devis', arguments: { reference: 'D2026-014' } },
          { name: 'emettre_facture', arguments: { reference: 'Durand' } },
          { name: 'documents_liste', arguments: {} },
        ],
        model: 'glm',
      }),
      'envoie le devis puis emets la facture et montre les documents',
    );
    expect(r.steps.map((s) => s.intent)).toEqual(['envoyer_devis', 'emettre_facture', 'documents']);
    expect(r.steps[0]?.reference).toBe('D2026-014');
    expect(r.steps[1]?.reference).toBe('Durand');
  });

  it('réponse texte (aucun outil) -> plan vide (hors périmètre)', async () => {
    const r = await classifyWithLlm(fakeLlm({ text: 'Bonjour !', toolCalls: [], model: 'claude' }), 'salut');
    expect(r.steps).toHaveLength(0);
  });

  it('outil inconnu -> ignoré', async () => {
    const r = await classifyWithLlm(fakeLlm({ text: null, toolCalls: [{ name: 'autre', arguments: {} }], model: 'glm' }), 'x');
    expect(r.steps).toHaveLength(0);
  });
});

describe('classifyWithRegex (fallback déterministe)', () => {
  it('détecte le versement (une seule étape)', () => {
    const r = classifyWithRegex('combien je peux me verser');
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]?.intent).toBe('payout');
  });
  it('extrait la référence de facture', () => {
    const r = classifyWithRegex('encaisse la facture 2026-014');
    expect(r.steps[0]?.intent).toBe('encaisser');
    expect(r.steps[0]?.reference).toBe('2026-014');
  });
  it('détecte les nouvelles actions opérationnelles', () => {
    expect(classifyWithRegex('envoie le devis 2026-014').steps[0]?.intent).toBe('envoyer_devis');
    expect(classifyWithRegex('émets la facture Durand').steps[0]?.intent).toBe('emettre_facture');
    expect(classifyWithRegex('montre mes documents archivés').steps[0]?.intent).toBe('documents');
  });
});

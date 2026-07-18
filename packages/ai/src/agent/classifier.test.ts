import { describe, it, expect } from 'vitest';
import { classifyWithLlm, classifyWithRegex } from './classifier';
import { type LlmPort, type LlmCompletion } from '../llm/port';
import { type AgentContext } from './context';

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

  it('mappe un appel d’outil ouvrir_catalogue (C27)', async () => {
    const r = await classifyWithLlm(
      fakeLlm({ text: null, toolCalls: [{ name: 'ouvrir_catalogue', arguments: {} }], model: 'glm' }),
      'ouvre mon catalogue',
    );
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]?.intent).toBe('voir_catalogue');
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

  it('mappe les outils documents du LOT 5 (classer/renommer/chercher) avec leur référence', async () => {
    const r = await classifyWithLlm(
      fakeLlm({
        text: null,
        toolCalls: [
          { name: 'classer_document', arguments: { reference: 'ticket Aldi' } },
          { name: 'renommer_document', arguments: { reference: 'ticket Aldi' } },
          { name: 'chercher_document', arguments: { reference: 'radiateur' } },
        ],
        model: 'glm',
      }),
      'range le ticket aldi puis renomme-le et retrouve la facture du radiateur',
    );
    expect(r.steps.map((s) => s.intent)).toEqual(['classer_document', 'renommer_document', 'chercher_document']);
    expect(r.steps[2]?.reference).toBe('radiateur');
  });

  it('mappe séparément le batch « notifications lues »', async () => {
    const r = await classifyWithLlm(
      fakeLlm({
        text: null,
        toolCalls: [{ name: 'marquer_notifications_lues', arguments: {} }],
        model: 'glm',
      }),
      'marque toutes mes notifications comme lues',
    );
    expect(r.steps).toEqual([{ intent: 'marquer_notifications_lues', reference: null }]);
  });

  it('mappe l’outil aide_capacites (découvrabilité S9) sur l’intent aide', async () => {
    const r = await classifyWithLlm(
      fakeLlm({ text: null, toolCalls: [{ name: 'aide_capacites', arguments: {} }], model: 'glm' }),
      'tu sais faire quoi ?',
    );
    expect(r.steps).toEqual([{ intent: 'aide', reference: null }]);
  });

  it('réponse texte (aucun outil) -> plan vide (hors périmètre)', async () => {
    const r = await classifyWithLlm(fakeLlm({ text: 'Bonjour !', toolCalls: [], model: 'claude' }), 'salut');
    expect(r.steps).toHaveLength(0);
  });

  it('outil inconnu -> ignoré', async () => {
    const r = await classifyWithLlm(fakeLlm({ text: null, toolCalls: [{ name: 'autre', arguments: {} }], model: 'glm' }), 'x');
    expect(r.steps).toHaveLength(0);
  });

  it('injecte le contexte en position USER (données) avec aliases — jamais les ids internes, jamais dans le system', async () => {
    let system = '';
    let lastUser = '';
    const llm: LlmPort = {
      ...fakeLlm({ text: null, toolCalls: [{ name: 'contexte_ecran', arguments: { reference: 'E1' } }], model: 'mistral' }),
      async complete(messages, opts) {
        system = opts?.system ?? '';
        lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
        return { text: null, toolCalls: [{ name: 'contexte_ecran', arguments: { reference: 'E1' } }], model: 'mistral' };
      },
    };
    const context: AgentContext = {
      screen: { name: '/facture/[id]', instanceId: 'invoice:inv-secret' },
      entities: [{ type: 'invoice', id: 'inv-secret', label: 'Facture F-2026-0014' }],
      capabilities: ['invoice.read'],
    };
    const result = await classifyWithLlm(llm, 'Resume cette facture', [], context);
    expect(result.steps).toEqual([{ intent: 'contexte_ecran', reference: 'E1' }]);
    // Le bloc contexte est une DONNÉE : position user, jamais concaténé au system
    // (anti prompt-injection par label — le system reste le tour de plus haute autorité).
    expect(lastUser).toContain('E1: invoice');
    expect(lastUser).not.toContain('inv-secret');
    expect(system).not.toContain('E1: invoice');
    expect(system).not.toContain('Facture F-2026-0014');
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
    expect(classifyWithRegex('marque toutes les notifications comme lues').steps[0]?.intent).toBe(
      'marquer_notifications_lues',
    );
  });
  it('détecte la lecture de l’entité affichée', () => {
    expect(classifyWithRegex('Résume cette facture').steps[0]?.intent).toBe('contexte_ecran');
    expect(classifyWithRegex('Où suis-je ?').steps[0]?.intent).toBe('contexte_ecran');
    expect(classifyWithRegex('Ouvre la deuxième notification').steps[0]).toEqual({
      intent: 'contexte_ecran',
      reference: 'ordinal:2',
    });
  });
});

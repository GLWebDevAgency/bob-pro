import { describe, it, expect } from 'vitest';
import {
  classifyWithLlm,
  classifyWithRegex,
  INTENTS_HORS_OUTILLAGE_LLM,
  LLM_TOOL_SPECS,
} from './classifier';
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

  it('mappe l’outil lier_bon_commande (B8) avec sa référence', async () => {
    const r = await classifyWithLlm(
      fakeLlm({ text: null, toolCalls: [{ name: 'lier_bon_commande', arguments: { reference: 'RATP' } }], model: 'glm' }),
      'la RATP m’a envoyé un bon de commande n° 4500123',
    );
    expect(r.steps).toEqual([{ intent: 'lier_bon_commande', reference: 'RATP' }]);
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

// ── LE PARTAGE DES RÔLES, PROUVÉ ─────────────────────────────────────────────────────────────

/**
 * Le chemin LLM est CELUI QUI DÉCOMPOSE : une consigne à deux gestes doit rendre DEUX étapes,
 * dans l'ordre dicté, sans fusion. Le chemin déterministe, lui, n'en rend JAMAIS qu'une : c'est
 * son contrat, et c'est ce qui le rend fiable.
 *
 * Ce que ces tests mesurent AUSSI, et qui borne le train : les gestes de fiche de passage
 * (PR-15/16) et de parc d'équipements (PR-11) n'ont AUCUN outil exposé au LLM — il ne peut donc
 * pas les nommer, et encore moins décomposer une consigne composite qui les porte. Le repli
 * déterministe (`INTENTS_HORS_OUTILLAGE_LLM`) est leur seule voie tant que ces outils n'existent
 * pas. Exposer les outils manquants est un chantier à part entière.
 */
describe('partage des rôles LLM / déterministe', () => {
  it('LLM : une consigne à DEUX gestes rend DEUX étapes, dans l’ordre, sans fusion', async () => {
    const r = await classifyWithLlm(
      fakeLlm({
        text: null,
        toolCalls: [
          { name: 'encaisser_facture', arguments: { reference: '2026-014' } },
          { name: 'envoyer_facture', arguments: { reference: '2026-021' } },
        ],
        model: 'glm',
      }),
      'encaisse la 2026-014 puis envoie la 2026-021 au client',
    );
    expect(r.steps).toEqual([
      { intent: 'encaisser', reference: '2026-014' },
      { intent: 'envoyer_facture', reference: '2026-021' },
    ]);
  });

  it('déterministe : la MÊME consigne ne rend qu’UNE étape (contrat du chemin)', () => {
    const r = classifyWithRegex('encaisse la 2026-014 puis envoie la 2026-021 au client');
    expect(r.steps).toHaveLength(1);
  });

  it('les gestes de passage et de parc n’ont AUCUN outil LLM — le déterministe les porte seul', () => {
    const outils = new Set(LLM_TOOL_SPECS.map((spec) => spec.name));
    for (const nom of [
      'commencer_intervention',
      'terminer_intervention',
      'faire_signer_intervention',
      'envoyer_fiche_passage',
      'facturer_intervention',
      'ajouter_equipement',
      'parc_equipements',
      'historique_equipement',
      'retirer_equipement',
    ]) {
      expect(outils.has(nom), nom).toBe(false);
      expect(INTENTS_HORS_OUTILLAGE_LLM.has(nom as never), nom).toBe(true);
    }
  });

  it('… et une intention OUTILLÉE n’entre jamais dans ce repli', () => {
    for (const intent of ['encaisser', 'relance', 'facture_directe', 'documents'] as const)
      expect(INTENTS_HORS_OUTILLAGE_LLM.has(intent), intent).toBe(false);
  });
});

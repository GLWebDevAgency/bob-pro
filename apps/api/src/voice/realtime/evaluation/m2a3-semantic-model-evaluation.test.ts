import type { LlmPort } from '@bob/ai';
import { describe, expect, it, vi } from 'vitest';
import {
  M2A3_SEMANTIC_MODEL_CORPUS,
  evaluateM2A3SemanticModelCase,
  instrumentM2A3Llm,
  isM2A3ReturnedModelCompatible,
  publicM2A3SemanticEvidence,
  runM2A3SemanticModelCase,
} from './m2a3-semantic-model-evaluation';

function operationFor(caseId: string): Record<string, unknown> {
  if (
    caseId === 'catalogue-anaphora-price'
    || caseId === 'catalogue-stored-injection'
  ) {
    return {
      kind: 'select_presented_choice',
      ordinal: 1,
      lines: [],
    };
  }
  if (caseId === 'required-fact-elliptical') {
    return {
      kind: 'patch_pending_line',
      scope: 'answer_required_fact',
      patch: {
        field: 'unit_price',
        decimal: '55',
        currency: 'EUR',
        basis: 'per_unit',
      },
    };
  }
  if (caseId === 'confirmation-multiturn-correction') {
    return {
      kind: 'patch_pending_line',
      scope: 'explicit_correction',
      patch: {
        field: 'unit_price',
        decimal: '450',
        currency: 'EUR',
        basis: 'per_unit',
      },
    };
  }
  return {
    kind: 'append_line_candidates',
    lines: [{
      service_reference: 'Main-d’œuvre plomberie',
      category_hint: 'labor',
      quantity_decimal: '2',
      unit_reference: 'heure',
      unit_price_decimal: '55',
      currency: 'EUR',
      price_basis: 'per_unit',
      vat_rate_hint: null,
    }],
  };
}

function fakeLlm(caseId: string): LlmPort {
  return {
    id: 'openai-eval-fake',
    complete: vi.fn(async () => ({
      text: null,
      toolCalls: [{
        name: 'mettre_a_jour_mission_devis_v2',
        arguments: { operations: [operationFor(caseId)] },
      }],
      model: 'gpt-eval-fake',
    })),
    generate: vi.fn(async () => ({ text: '', model: 'gpt-eval-fake' })),
    health: vi.fn(async () => ({ healthy: true })),
  };
}

function appendedLineResult(serviceReference: string) {
  return {
    status: 'mission_frame' as const,
    plannerDurationMs: 1,
    frame: {
      schema: 'bob.semantic.quote-creation' as const,
      version: 2 as const,
      operations: [{
        kind: 'append_line_candidates' as const,
        lines: [{
          serviceReference,
          categoryHint: 'labor' as const,
          quantityDecimal: '2',
          unitReference: 'heure',
          unitPriceDecimal: '55',
          currency: 'EUR' as const,
          priceBasis: 'per_unit' as const,
          vatRateHint: null,
        }],
      }],
      model: 'gpt-eval-fake',
    },
  };
}

describe('M2-A-3 — corpus modèle sémantique déterministe', () => {
  it('versionne six cas distincts, dont une injection stockée, sans donnée personnelle', () => {
    expect(M2A3_SEMANTIC_MODEL_CORPUS.map((entry) => entry.id)).toEqual([
      'line-paraphrase-direct',
      'line-paraphrase-familiar',
      'catalogue-anaphora-price',
      'catalogue-stored-injection',
      'required-fact-elliptical',
      'confirmation-multiturn-correction',
    ]);
    expect(new Set(M2A3_SEMANTIC_MODEL_CORPUS.map((entry) => entry.id)).size).toBe(6);
    expect(JSON.stringify(M2A3_SEMANTIC_MODEL_CORPUS)).not.toMatch(
      /customerId|missionId|choiceId|proposalId|diffHash|@/u,
    );
  });

  it.each(M2A3_SEMANTIC_MODEL_CORPUS)(
    '$id passe par le planner réel avec une seule complétion et aucun generate',
    async (evaluationCase) => {
      const instrumented = instrumentM2A3Llm(fakeLlm(evaluationCase.id));
      const result = await runM2A3SemanticModelCase(
        instrumented.llm,
        evaluationCase,
      );

      expect(result).toMatchObject({
        id: evaluationCase.id,
        passed: true,
        status: 'mission_frame',
        returnedModel: 'gpt-eval-fake',
      });
      expect(instrumented.completeCount()).toBe(1);
      expect(instrumented.generateCount()).toBe(0);
    },
  );

  it('détecte une TVA inventée même si la frame reste structurellement valide', () => {
    const evaluationCase = M2A3_SEMANTIC_MODEL_CORPUS[0];
    const result = evaluateM2A3SemanticModelCase(evaluationCase, {
      status: 'mission_frame',
      plannerDurationMs: 1,
      frame: {
        schema: 'bob.semantic.quote-creation',
        version: 2,
        operations: [{
          kind: 'append_line_candidates',
          lines: [{
            serviceReference: 'Main-d’œuvre plomberie',
            categoryHint: 'labor',
            quantityDecimal: '2',
            unitReference: 'heure',
            unitPriceDecimal: '55',
            currency: 'EUR',
            priceBasis: 'per_unit',
            vatRateHint: '20',
          }],
        }],
        model: 'gpt-eval-fake',
      },
    });

    expect(result.passed).toBe(false);
    expect(result.issues).toContain('invented_vat');
  });

  it('accepte accents/apostrophes canoniques mais refuse tout contenu métier ajouté', () => {
    const evaluationCase = M2A3_SEMANTIC_MODEL_CORPUS[1];

    for (const canonical of [
      "Main-d'oeuvre plomberie",
      'Main-d’œuvre plomberie',
      'Main-dʼœuvre plomberie',
      'Main-d’oeuvré plomberie',
    ]) {
      expect(evaluateM2A3SemanticModelCase(
        evaluationCase,
        appendedLineResult(canonical),
      )).toMatchObject({ passed: true, issues: [] });
    }

    for (const invented of [
      'Installation chaudière plomberie',
      'Plomberie cuisine',
      'Prestation plomberie',
    ]) {
      const result = evaluateM2A3SemanticModelCase(
        evaluationCase,
        appendedLineResult(invented),
      );
      expect(result.passed).toBe(false);
      expect(result.issues).toContain('service_label_unverified_content');
    }
  });

  it('refuse un décorateur canonique seul sans ancre provenant de la phrase source', () => {
    const result = evaluateM2A3SemanticModelCase(
      M2A3_SEMANTIC_MODEL_CORPUS[1],
      appendedLineResult('Main-d’œuvre'),
    );

    expect(result.passed).toBe(false);
    expect(result.issues).toEqual(['service_label_unverified_content']);
  });

  it('n’accepte que le modèle demandé ou son snapshot daté', () => {
    expect(isM2A3ReturnedModelCompatible('gpt-test', 'gpt-test')).toBe(true);
    expect(
      isM2A3ReturnedModelCompatible('gpt-test', 'gpt-test-2026-07-31'),
    ).toBe(true);
    expect(
      isM2A3ReturnedModelCompatible('gpt-4.1', 'gpt-4.1-mini'),
    ).toBe(false);
    expect(isM2A3ReturnedModelCompatible('gpt-test', 'gpt-other')).toBe(false);
    expect(isM2A3ReturnedModelCompatible('', 'gpt-test')).toBe(false);
  });

  it('produit une preuve publique sans transcript, prompt ni arguments d’outil', () => {
    const evidence = publicM2A3SemanticEvidence({
      releaseSha: 'a'.repeat(40),
      requestedModel: 'gpt-test',
      completionCount: 6,
      generateCount: 0,
      providerRequestCount: 6,
      failureStage: null,
      results: M2A3_SEMANTIC_MODEL_CORPUS.map((entry) => ({
        id: entry.id,
        passed: true,
        status: 'mission_frame',
        durationMs: 42,
        issues: [],
        returnedModel: 'gpt-test-2026-07-31',
      })),
    });
    const serialized = JSON.stringify(evidence);

    expect(evidence).toMatchObject({
      schema: 'bob.m2a3.semantic-model-eval',
      version: 1,
      scope: 'quote_line_m2a3',
      corpusVersion: 2,
      completionCount: 6,
      generateCount: 0,
      providerRequestCount: 6,
      outcome: 'passed',
    });
    expect(serialized).not.toContain('utterance');
    expect(serialized).not.toContain('transcript');
    expect(serialized).not.toContain('arguments');
    expect(serialized).not.toContain('plomberie');
  });

  it('rend le reçu rouge si l’adapter effectue une requête fournisseur supplémentaire', () => {
    const evidence = publicM2A3SemanticEvidence({
      releaseSha: 'b'.repeat(40),
      requestedModel: 'gpt-test',
      completionCount: 6,
      generateCount: 0,
      providerRequestCount: 7,
      failureStage: null,
      results: M2A3_SEMANTIC_MODEL_CORPUS.map((entry) => ({
        id: entry.id,
        passed: true,
        status: 'mission_frame',
        durationMs: 42,
        issues: [],
        returnedModel: 'gpt-test',
      })),
    });

    expect(evidence).toMatchObject({
      outcome: 'failed',
      providerRequestCount: 7,
    });
  });
});

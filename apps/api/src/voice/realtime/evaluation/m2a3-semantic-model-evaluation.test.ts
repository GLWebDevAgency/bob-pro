import type { LlmPort } from '@bob/ai';
import { describe, expect, it, vi } from 'vitest';
// Le validateur reste volontairement un module ESM JavaScript indépendant du producteur TS.
// @ts-expect-error — cette frontière de release n'expose pas de déclarations TypeScript.
import { validateAgentMissionM2A3SemanticEvidence } from '../../../../scripts/validate-agent-mission-m2a3-semantic-evidence.mjs';
import {
  M2A3_SEMANTIC_MODEL_CORPUS,
  evaluateM2A3SemanticModelCase,
  instrumentM2A3Llm,
  isM2A3ReturnedModelCompatible,
  publicM2A3SemanticEvidence,
  runM2A3SemanticModelCase,
  type M2A3SemanticModelEvaluationCase,
  type M2A3SemanticModelEvaluationCaseResult,
} from './m2a3-semantic-model-evaluation';
import {
  LlmProviderHttpError,
  LlmStrictSchemaError,
} from '../../../ai/provider-failure';

function operationFor(caseId: string): Record<string, unknown> {
  if (
    caseId === 'customer-choice-plain' ||
    caseId === 'customer-choice-compound-remainder' ||
    caseId === 'catalogue-anaphora-price' ||
    caseId === 'catalogue-stored-injection' ||
    caseId === 'catalogue-compound-remainder'
  ) {
    return {
      kind: 'select_presented_choice',
      ordinal: caseId.startsWith('customer-choice') ? 2 : 1,
      unprocessed_current_utterance_remainder:
        caseId === 'customer-choice-compound-remainder' ||
        caseId === 'catalogue-compound-remainder'
          ? 'puis ajoute deux heures de déplacement.'
          : null,
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

function appendedLineResult(
  serviceReference: string,
  unitReference: string | null = 'heure',
) {
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
          unitReference,
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

function passingPublicResults(
  returnedModel = 'gpt-test',
): readonly M2A3SemanticModelEvaluationCaseResult[] {
  return M2A3_SEMANTIC_MODEL_CORPUS.map((entry) => ({
    id: entry.id,
    passed: true,
    status: 'mission_frame',
    durationMs: 42,
    issues: [],
    rejectionReason: null,
    returnedModel,
    completeAttempts: 1,
    completeResolved: 1,
    generateAttempts: 0,
  }));
}

describe('M2-A-3 — corpus modèle sémantique déterministe', () => {
  it('versionne neuf cas distincts, dont injection stockée et suites composites, sans donnée personnelle', () => {
    expect(M2A3_SEMANTIC_MODEL_CORPUS.map((entry) => entry.id)).toEqual([
      'line-paraphrase-direct',
      'line-paraphrase-familiar',
      'customer-choice-plain',
      'customer-choice-compound-remainder',
      'catalogue-anaphora-price',
      'catalogue-stored-injection',
      'catalogue-compound-remainder',
      'required-fact-elliptical',
      'confirmation-multiturn-correction',
    ]);
    expect(new Set(M2A3_SEMANTIC_MODEL_CORPUS.map((entry) => entry.id)).size).toBe(9);
    expect(JSON.stringify(M2A3_SEMANTIC_MODEL_CORPUS)).not.toMatch(
      /customerId|missionId|choiceId|proposalId|diffHash|@/u,
    );
    const storedInjection = M2A3_SEMANTIC_MODEL_CORPUS.find(
      (entry) => entry.id === 'catalogue-stored-injection',
    );
    expect(storedInjection?.input.history).toEqual([expect.objectContaining({ role: 'bob' })]);
  });

  it.each(M2A3_SEMANTIC_MODEL_CORPUS)(
    '$id passe par le planner réel avec une seule complétion et aucun generate',
    async (evaluationCase) => {
      const instrumented = instrumentM2A3Llm(fakeLlm(evaluationCase.id));
      const result = await runM2A3SemanticModelCase(instrumented, evaluationCase);

      expect(result).toMatchObject({
        id: evaluationCase.id,
        passed: true,
        status: 'mission_frame',
        returnedModel: 'gpt-eval-fake',
      });
      expect(instrumented.snapshot()).toMatchObject({
        completeAttempts: 1,
        completeResolved: 1,
        generateAttempts: 0,
      });
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
    expect(result.issues).toContain('vat_rate_invented');
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

  it('compare l’unité selon le canonique métier partagé sans confondre absence ou C62', () => {
    const evaluationCase = M2A3_SEMANTIC_MODEL_CORPUS[0];

    for (const equivalent of ['heure', 'heures', 'h', '1 h']) {
      expect(evaluateM2A3SemanticModelCase(
        evaluationCase,
        appendedLineResult('Main-d’œuvre plomberie', equivalent),
      )).toMatchObject({ passed: true, issues: [] });
    }

    for (const different of [null, 'jour', 'forfait', 'unité']) {
      const result = evaluateM2A3SemanticModelCase(
        evaluationCase,
        appendedLineResult('Main-d’œuvre plomberie', different),
      );
      expect(result.passed).toBe(false);
      expect(result.issues).toContain('unit_mismatch');
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
    expect(isM2A3ReturnedModelCompatible('gpt-test', 'gpt-test-2026-07-31')).toBe(true);
    expect(isM2A3ReturnedModelCompatible('gpt-4.1', 'gpt-4.1-mini')).toBe(false);
    expect(isM2A3ReturnedModelCompatible('gpt-test', 'gpt-other')).toBe(false);
    expect(isM2A3ReturnedModelCompatible('', 'gpt-test')).toBe(false);
    expect(isM2A3ReturnedModelCompatible('gpt-test', ' gpt-test')).toBe(false);
    expect(isM2A3ReturnedModelCompatible('gpt-test', 'gpt-test ')).toBe(false);
  });

  it('produit une preuve publique sans transcript, prompt ni arguments d’outil', () => {
    const evidence = publicM2A3SemanticEvidence({
      releaseSha: 'a'.repeat(40),
      requestedModel: 'gpt-test',
      requestedModelSource: 'versioned_default',
      completionCount: 9,
      generateCount: 0,
      providerRequestCount: 9,
      failureStage: null,
      results: passingPublicResults('gpt-test-2026-07-31'),
    });
    const serialized = JSON.stringify(evidence);

    expect(evidence).toMatchObject({
      schema: 'bob.m2a3.semantic-model-eval',
      version: 2,
      scope: 'quote_line_m2a3',
      corpusVersion: 4,
      completionCount: 9,
      generateCount: 0,
      providerRequestCount: 9,
      outcome: 'passed',
    });
    expect(serialized).not.toContain('utterance');
    expect(serialized).not.toContain('transcript');
    expect(serialized).not.toContain('arguments');
    expect(serialized).not.toContain('plomberie');
  });

  it('fait accepter la preuve publique du producteur par le validateur de release indépendant', () => {
    const releaseSha = 'f'.repeat(40);
    const evidence = publicM2A3SemanticEvidence({
      releaseSha,
      requestedModel: 'gpt-test',
      requestedModelSource: 'versioned_default',
      completionCount: M2A3_SEMANTIC_MODEL_CORPUS.length,
      generateCount: 0,
      providerRequestCount: M2A3_SEMANTIC_MODEL_CORPUS.length,
      failureStage: null,
      results: passingPublicResults('gpt-test-2026-07-31'),
    });

    expect(validateAgentMissionM2A3SemanticEvidence(evidence, releaseSha)).toEqual({
      outcome: 'passed',
    });
  });

  it('rend le reçu rouge si l’adapter effectue une requête fournisseur supplémentaire', () => {
    const evidence = publicM2A3SemanticEvidence({
      releaseSha: 'b'.repeat(40),
      requestedModel: 'gpt-test',
      requestedModelSource: 'versioned_default',
      completionCount: 9,
      generateCount: 0,
      providerRequestCount: 10,
      failureStage: null,
      results: passingPublicResults(),
    });

    expect(evidence).toMatchObject({
      outcome: 'failed',
      failureStage: 'semantic_result',
      providerRequestCount: 10,
    });
  });

  it('refuse qu’un override Railway de modèle certifie la V1', () => {
    const evidence = publicM2A3SemanticEvidence({
      releaseSha: 'e'.repeat(40),
      requestedModel: 'gpt-test',
      requestedModelSource: 'environment_override',
      completionCount: 9,
      generateCount: 0,
      providerRequestCount: 9,
      failureStage: null,
      results: passingPublicResults(),
    });

    expect(evidence).toMatchObject({
      outcome: 'failed',
      failureStage: 'semantic_result',
      requestedModelSource: 'environment_override',
    });
  });

  it('conserve le modèle fournisseur observé même quand le planner rejette la frame', async () => {
    const base: LlmPort = {
      id: 'openai-eval-rejected',
      complete: vi.fn(async () => ({
        text: null,
        toolCalls: [
          {
            name: 'mettre_a_jour_mission_devis_v2',
            arguments: {
              operations: [
                {
                  kind: 'append_line_candidates',
                  lines: [operationFor('line-paraphrase-direct').lines].flat(),
                },
              ],
            },
          },
        ],
        model: 'gpt-test',
      })),
      generate: vi.fn(async () => ({ text: '', model: 'gpt-test' })),
      health: vi.fn(async () => ({ healthy: true })),
    };
    const result = await runM2A3SemanticModelCase(
      instrumentM2A3Llm(base),
      M2A3_SEMANTIC_MODEL_CORPUS[2],
      'gpt-test',
    );

    expect(result).toMatchObject({
      passed: false,
      status: 'rejected',
      rejectionReason: 'invalid_mission_frame',
      returnedModel: 'gpt-test',
      completeAttempts: 1,
      completeResolved: 1,
      generateAttempts: 0,
    });
    expect(result.issues).toContain('mission_frame_required');
    expect(result.issues).not.toContain('returned_model_missing');
  });

  it('échoue fermé quand l’adapter ne reçoit aucun modèle attesté du fournisseur', async () => {
    const base: LlmPort = {
      id: 'openai-eval-unattested-model',
      complete: vi.fn(async () => ({
        text: null,
        toolCalls: [
          {
            name: 'mettre_a_jour_mission_devis_v2',
            arguments: { operations: [operationFor('line-paraphrase-direct')] },
          },
        ],
        model: 'gpt-test',
        providerReportedModel: null,
      })),
      generate: vi.fn(async () => ({ text: '', model: 'gpt-test' })),
      health: vi.fn(async () => ({ healthy: true })),
    };
    const result = await runM2A3SemanticModelCase(
      instrumentM2A3Llm(base),
      M2A3_SEMANTIC_MODEL_CORPUS[0],
      'gpt-test',
    );

    expect(result).toMatchObject({
      passed: false,
      returnedModel: null,
      completeAttempts: 1,
      completeResolved: 1,
    });
    expect(result.issues).toContain('returned_model_missing');
  });

  it('rend une panne fournisseur diagnosticable sans exposer son erreur', async () => {
    const base: LlmPort = {
      id: 'openai-eval-failing',
      complete: vi.fn(async () => {
        throw new Error('secret fournisseur non publiable');
      }),
      generate: vi.fn(async () => ({ text: '', model: 'gpt-test' })),
      health: vi.fn(async () => ({ healthy: true })),
    };
    const result = await runM2A3SemanticModelCase(
      instrumentM2A3Llm(base),
      M2A3_SEMANTIC_MODEL_CORPUS[0],
      'gpt-test',
    );

    expect(result).toMatchObject({
      passed: false,
      status: 'provider_error',
      rejectionReason: 'provider_error',
      returnedModel: null,
      completeAttempts: 1,
      completeResolved: 0,
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        'provider_request_failed',
        'completion_resolution_count_mismatch',
        'returned_model_missing',
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('secret fournisseur');
  });

  it('publie seulement la catégorie fermée d’une erreur HTTP fournisseur', async () => {
    const base: LlmPort = {
      id: 'openai-eval-invalid-schema',
      complete: vi.fn(async () => {
        throw new LlmProviderHttpError(400, 'invalid_function_parameters');
      }),
      generate: vi.fn(async () => ({ text: '', model: 'gpt-test' })),
      health: vi.fn(async () => ({ healthy: true })),
    };
    const result = await runM2A3SemanticModelCase(
      instrumentM2A3Llm(base),
      M2A3_SEMANTIC_MODEL_CORPUS[0],
      'gpt-test',
    );

    expect(result.status).toBe('provider_error');
    expect(result.issues).toContain('provider_invalid_function_parameters');
    expect(JSON.stringify(result)).not.toContain('HTTP 400');
    expect(JSON.stringify(result)).not.toContain('tools[');
  });

  it('conserve et fait valider un reçu rouge borné si le contrat strict échoue avant le réseau', async () => {
    const fetchMock = vi.fn();
    const base: LlmPort = {
      id: 'openai-eval-local-schema',
      complete: vi.fn(async () => {
        throw new LlmStrictSchemaError();
      }),
      generate: vi.fn(async () => ({ text: '', model: 'gpt-test' })),
      health: vi.fn(async () => ({ healthy: true })),
    };
    const result = await runM2A3SemanticModelCase(
      instrumentM2A3Llm(base),
      M2A3_SEMANTIC_MODEL_CORPUS[0],
      'gpt-test',
    );
    const releaseSha = '1'.repeat(40);
    const evidence = publicM2A3SemanticEvidence({
      releaseSha,
      requestedModel: 'gpt-test',
      requestedModelSource: 'versioned_default',
      completionCount: 1,
      generateCount: 0,
      providerRequestCount: fetchMock.mock.calls.length,
      failureStage: 'local_contract',
      results: [result],
    });

    expect(result).toMatchObject({
      passed: false,
      status: 'schema_error',
      rejectionReason: 'strict_schema_invalid',
      completeAttempts: 1,
      completeResolved: 0,
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      'strict_schema_invalid',
      'completion_resolution_count_mismatch',
      'returned_model_missing',
    ]));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(validateAgentMissionM2A3SemanticEvidence(evidence, releaseSha)).toEqual({
      outcome: 'failed',
    });
    expect(JSON.stringify(evidence)).not.toContain('transcript');
    expect(JSON.stringify(evidence)).not.toContain('arguments');
  });

  it('distingue une panne locale après réponse d’une panne réseau fournisseur', async () => {
    const providerCompletion = {
      text: null,
      model: 'gpt-test',
      providerReportedModel: 'gpt-test',
      get toolCalls(): never {
        throw new Error('erreur locale du planner non publiable');
      },
    };
    const base: LlmPort = {
      id: 'openai-eval-planner-error',
      complete: vi.fn(async () => providerCompletion),
      generate: vi.fn(async () => ({ text: '', model: 'gpt-test' })),
      health: vi.fn(async () => ({ healthy: true })),
    };
    const result = await runM2A3SemanticModelCase(
      instrumentM2A3Llm(base),
      M2A3_SEMANTIC_MODEL_CORPUS[0],
      'gpt-test',
    );

    expect(result).toMatchObject({
      passed: false,
      status: 'planner_error',
      rejectionReason: 'planner_error',
      returnedModel: 'gpt-test',
      completeAttempts: 1,
      completeResolved: 1,
    });
    expect(result.issues).toContain('planner_processing_failed');
    expect(result.issues).not.toContain('provider_request_failed');
    expect(JSON.stringify(result)).not.toContain('erreur locale');
  });

  it('classe une panne du scorekeeper comme locale après un planner réussi', async () => {
    const baseCase = M2A3_SEMANTIC_MODEL_CORPUS[0];
    const evaluationCase: M2A3SemanticModelEvaluationCase = {
      id: baseCase.id,
      input: baseCase.input,
      get oracle(): M2A3SemanticModelEvaluationCase['oracle'] {
        throw new Error('erreur locale du scorekeeper non publiable');
      },
    };
    const result = await runM2A3SemanticModelCase(
      instrumentM2A3Llm(fakeLlm(baseCase.id)),
      evaluationCase,
      'gpt-eval-fake',
    );

    expect(result).toMatchObject({
      passed: false,
      status: 'local_error',
      rejectionReason: 'local_error',
      returnedModel: 'gpt-eval-fake',
      completeAttempts: 1,
      completeResolved: 1,
      generateAttempts: 0,
    });
    expect(result.issues).toEqual(['local_evaluation_failed']);
    expect(JSON.stringify(result)).not.toContain('scorekeeper');
  });

  it('ne sérialise jamais un modèle invalide ou incompatible dans un reçu rouge', () => {
    for (const unsafeModel of ['gpt-test\nprivate', 'gpt-other']) {
      const results = [...passingPublicResults()];
      results[0] = Object.freeze({
        ...results[0]!,
        returnedModel: unsafeModel,
      });
      const evidence = publicM2A3SemanticEvidence({
        releaseSha: 'c'.repeat(40),
        requestedModel: 'gpt-test',
        requestedModelSource: 'versioned_default',
        completionCount: 9,
        generateCount: 0,
        providerRequestCount: 9,
        failureStage: 'semantic_result',
        results,
      });
      const serialized = JSON.stringify(evidence);

      expect(evidence).toMatchObject({ outcome: 'failed', modelCompatible: false });
      expect(serialized).not.toContain(unsafeModel);
      expect((evidence.cases as Array<Record<string, unknown>>)[0]).toMatchObject({
        returnedModel: null,
        returnedModelStatus: unsafeModel === 'gpt-other' ? 'incompatible' : 'invalid_identifier',
      });
    }
  });

  it('refuse qu’un total global masque deux complétions dans un seul cas', () => {
    const results = [...passingPublicResults()];
    results[0] = Object.freeze({
      ...results[0]!,
      completeAttempts: 2,
    });
    const evidence = publicM2A3SemanticEvidence({
      releaseSha: 'd'.repeat(40),
      requestedModel: 'gpt-test',
      requestedModelSource: 'versioned_default',
      completionCount: 9,
      generateCount: 0,
      providerRequestCount: 9,
      failureStage: null,
      results,
    });

    expect(evidence).toMatchObject({ outcome: 'failed' });
  });

  it('détecte un modèle de frame différent du modèle réellement observé', () => {
    const result = evaluateM2A3SemanticModelCase(
      M2A3_SEMANTIC_MODEL_CORPUS[0],
      appendedLineResult('Main-d’œuvre plomberie'),
      1,
      {
        completeAttempts: 1,
        completeResolved: 1,
        generateAttempts: 0,
        observedModel: 'gpt-other',
      },
    );

    expect(result.passed).toBe(false);
    expect(result.issues).toContain('planner_model_mismatch');
  });
});

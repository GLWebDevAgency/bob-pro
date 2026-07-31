import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildLlmForProvider,
  resolveOpenAiChatModel,
} from '../../../ai/providers';
import {
  M2A3_SEMANTIC_MODEL_CORPUS,
  instrumentM2A3Llm,
  publicM2A3SemanticEvidence,
  runM2A3SemanticModelCase,
  type InstrumentedM2A3Llm,
  type M2A3SemanticModelEvaluationCaseResult,
} from './m2a3-semantic-model-evaluation';

const RUN_LIVE = process.env.RUN_BOB_LIVE_M2A3_MODEL_EVAL === 'true';
const describeLive = RUN_LIVE ? describe : describe.skip;
let evidencePath: string | null = null;
let evidence: Readonly<Record<string, unknown>> | null = null;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} requis quand RUN_BOB_LIVE_M2A3_MODEL_EVAL=true`);
  }
  return value;
}

function resolveEvidencePath(rawPath: string): string {
  const repositoryRoot = resolve(process.cwd(), '../..');
  const evidenceRoot = resolve(repositoryRoot, '.release-evidence');
  const candidate = resolve(rawPath);
  if (candidate === evidenceRoot || !candidate.startsWith(`${evidenceRoot}/`)) {
    throw new Error('BOB_LIVE_M2A3_EVAL_EVIDENCE_PATH doit rester sous .release-evidence/.');
  }
  return candidate;
}

describeLive('M2-A-3 — évaluation opt-in du vrai modèle runtime', () => {
  it('exécute le corpus sans retry avec exactement le planner et l’adapter OpenAI runtime', async () => {
    evidencePath = resolveEvidencePath(requiredEnvironment('BOB_LIVE_M2A3_EVAL_EVIDENCE_PATH'));
    let failureStage:
      | 'configuration'
      | 'local_contract'
      | 'provider_request'
      | 'multiple_failures'
      | 'semantic_result'
      | null = 'configuration';
    let requestedModel: string | null = null;
    let requestedModelSource: 'versioned_default' | 'environment_override' | null = null;
    let releaseSha: string | null = null;
    let completionCount = 0;
    let generateCount = 0;
    let providerRequestCount = 0;
    let instrumented: InstrumentedM2A3Llm | null = null;
    const results: M2A3SemanticModelEvaluationCaseResult[] = [];
    try {
      expect(requiredEnvironment('BOB_LIVE_PROVIDER')).toBe('openai');
      requiredEnvironment('OPENAI_API_KEY');
      const configuredUrl = process.env.OPENAI_URL;
      if (configuredUrl !== undefined && configuredUrl !== 'https://api.openai.com/v1') {
        throw new Error('OPENAI_URL doit être absente ou pointer vers l’API officielle.');
      }
      if (process.env.OPENAI_MODEL !== undefined) {
        requestedModelSource = 'environment_override';
        requestedModel = resolveOpenAiChatModel();
        throw new Error(
          'OPENAI_MODEL doit être absente : la V1 certifie exclusivement le défaut versionné.',
        );
      }
      requestedModelSource = 'versioned_default';
      requestedModel = resolveOpenAiChatModel();
      releaseSha = requiredEnvironment('BOB_LIVE_M2A3_EVAL_RELEASE_SHA');
      if (!/^[0-9a-f]{40}$/u.test(releaseSha)) {
        throw new Error('BOB_LIVE_M2A3_EVAL_RELEASE_SHA doit être un SHA Git exact.');
      }

      const runtimeLlm = buildLlmForProvider('openai');
      if (runtimeLlm === undefined || runtimeLlm.id !== 'openai') {
        throw new Error('Adapter OpenAI runtime indisponible.');
      }
      instrumented = instrumentM2A3Llm(runtimeLlm);
      const originalFetch = globalThis.fetch;
      const countedFetch: typeof fetch = async (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (
          url === 'https://api.openai.com/v1/chat/completions' &&
          (init?.method ?? 'GET').toUpperCase() === 'POST'
        ) {
          providerRequestCount += 1;
        }
        return originalFetch(input, init);
      };

      failureStage = 'provider_request';
      globalThis.fetch = countedFetch;
      try {
        for (const evaluationCase of M2A3_SEMANTIC_MODEL_CORPUS) {
          results.push(
            await runM2A3SemanticModelCase(instrumented, evaluationCase, requestedModel),
          );
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
      const hasSchemaFailure = results.some((result) => result.status === 'schema_error');
      const hasProviderFailure = results.some((result) => result.status === 'provider_error');
      failureStage = hasSchemaFailure && hasProviderFailure
        ? 'multiple_failures'
        : hasSchemaFailure
          ? 'local_contract'
          : hasProviderFailure
            ? 'provider_request'
            : 'semantic_result';
      const allCasesPassed = results.every((result) => result.passed);
      if (
        instrumented.snapshot().completeAttempts !== M2A3_SEMANTIC_MODEL_CORPUS.length ||
        instrumented.snapshot().completeResolved !== M2A3_SEMANTIC_MODEL_CORPUS.length ||
        instrumented.snapshot().generateAttempts !== 0 ||
        providerRequestCount !== M2A3_SEMANTIC_MODEL_CORPUS.length ||
        !allCasesPassed
      ) {
        throw new Error('Le certificat sémantique M2-A-3 a échoué.');
      }
      failureStage = null;
    } finally {
      const snapshot = instrumented?.snapshot();
      completionCount = snapshot?.completeAttempts ?? 0;
      generateCount = snapshot?.generateAttempts ?? 0;
      evidence = publicM2A3SemanticEvidence({
        releaseSha,
        requestedModel,
        requestedModelSource,
        results,
        completionCount,
        generateCount,
        providerRequestCount,
        failureStage,
      });
    }
    expect(evidence).toMatchObject({ outcome: 'passed' });
  }, 90_000);
});

afterAll(() => {
  if (!RUN_LIVE || evidencePath === null || evidence === null) return;
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
});

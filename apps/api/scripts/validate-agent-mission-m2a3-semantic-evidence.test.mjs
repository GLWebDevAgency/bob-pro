import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAgentMissionM2A3SemanticEvidence } from './validate-agent-mission-m2a3-semantic-evidence.mjs';

const SHA = 'a'.repeat(40);
const IDS = [
  'line-paraphrase-direct',
  'line-paraphrase-familiar',
  'customer-choice-plain',
  'customer-choice-compound-remainder',
  'catalogue-anaphora-price',
  'catalogue-stored-injection',
  'catalogue-compound-remainder',
  'required-fact-elliptical',
  'confirmation-multiturn-correction',
];

function passingReceipt() {
  return {
    schema: 'bob.m2a3.semantic-model-eval',
    version: 2,
    scope: 'quote_line_m2a3',
    corpusVersion: 4,
    releaseSha: SHA,
    provider: 'openai',
    requestedModel: 'gpt-test',
    requestedModelStatus: 'valid',
    requestedModelSource: 'versioned_default',
    returnedModels: ['gpt-test-2026-07-31'],
    modelCompatible: true,
    completionCount: 9,
    generateCount: 0,
    providerRequestCount: 9,
    outcome: 'passed',
    failureStage: null,
    cases: IDS.map((id) => ({
      id,
      passed: true,
      status: 'mission_frame',
      durationMs: 42,
      issueCodes: [],
      rejectionReason: null,
      completeAttempts: 1,
      completeResolved: 1,
      generateAttempts: 0,
      returnedModelStatus: 'snapshot',
      returnedModel: 'gpt-test-2026-07-31',
    })),
  };
}

test('accepte le reçu passant complet du SHA exact', () => {
  assert.deepEqual(validateAgentMissionM2A3SemanticEvidence(passingReceipt(), SHA), {
    outcome: 'passed',
  });
});

test('accepte un reçu rouge borné afin de préserver le diagnostic non-PII', () => {
  const receipt = passingReceipt();
  receipt.outcome = 'failed';
  receipt.failureStage = 'semantic_result';
  receipt.cases[0].passed = false;
  receipt.cases[0].status = 'rejected';
  receipt.cases[0].issueCodes = ['mission_frame_required'];
  receipt.cases[0].rejectionReason = 'invalid_mission_frame';
  receipt.cases[0].returnedModelStatus = 'exact';
  receipt.cases[0].returnedModel = 'gpt-test';
  receipt.returnedModels = ['gpt-test', 'gpt-test-2026-07-31'];

  assert.deepEqual(validateAgentMissionM2A3SemanticEvidence(receipt, SHA), { outcome: 'failed' });
});

test('distingue une panne fournisseur d’une panne sémantique locale', () => {
  const providerFailure = passingReceipt();
  providerFailure.outcome = 'failed';
  providerFailure.failureStage = 'provider_request';
  providerFailure.modelCompatible = false;
  providerFailure.returnedModels = ['gpt-test-2026-07-31'];
  providerFailure.cases[0].passed = false;
  providerFailure.cases[0].status = 'provider_error';
  providerFailure.cases[0].issueCodes = [
    'provider_request_failed',
    'completion_resolution_count_mismatch',
    'returned_model_missing',
  ];
  providerFailure.cases[0].rejectionReason = 'provider_error';
  providerFailure.cases[0].completeResolved = 0;
  providerFailure.cases[0].returnedModelStatus = 'missing';
  providerFailure.cases[0].returnedModel = null;
  assert.deepEqual(validateAgentMissionM2A3SemanticEvidence(providerFailure, SHA), {
    outcome: 'failed',
  });

  const contradictory = structuredClone(providerFailure);
  contradictory.failureStage = 'semantic_result';
  assert.throws(
    () => validateAgentMissionM2A3SemanticEvidence(contradictory, SHA),
    /failure stage contradicts/u,
  );
});

test('accepte un préflight strict local tenté sans requête fournisseur', () => {
  const receipt = passingReceipt();
  receipt.outcome = 'failed';
  receipt.failureStage = 'local_contract';
  receipt.modelCompatible = false;
  receipt.providerRequestCount = 8;
  receipt.returnedModels = ['gpt-test-2026-07-31'];
  receipt.cases[0].passed = false;
  receipt.cases[0].status = 'schema_error';
  receipt.cases[0].issueCodes = [
    'strict_schema_invalid',
    'completion_resolution_count_mismatch',
    'returned_model_missing',
  ];
  receipt.cases[0].rejectionReason = 'strict_schema_invalid';
  receipt.cases[0].completeResolved = 0;
  receipt.cases[0].returnedModelStatus = 'missing';
  receipt.cases[0].returnedModel = null;

  assert.deepEqual(validateAgentMissionM2A3SemanticEvidence(receipt, SHA), {
    outcome: 'failed',
  });
});

test('exige un étage explicite quand contrat local et fournisseur échouent ensemble', () => {
  const receipt = passingReceipt();
  receipt.outcome = 'failed';
  receipt.failureStage = 'multiple_failures';
  receipt.modelCompatible = false;
  receipt.providerRequestCount = 8;
  for (const [index, status] of ['schema_error', 'provider_error'].entries()) {
    const entry = receipt.cases[index];
    entry.passed = false;
    entry.status = status;
    entry.issueCodes = status === 'schema_error'
      ? [
        'strict_schema_invalid',
        'completion_resolution_count_mismatch',
        'returned_model_missing',
      ]
      : [
        'provider_request_failed',
        'provider_unavailable',
        'completion_resolution_count_mismatch',
        'returned_model_missing',
      ];
    entry.rejectionReason =
      status === 'schema_error' ? 'strict_schema_invalid' : 'provider_error';
    entry.completeResolved = 0;
    entry.returnedModelStatus = 'missing';
    entry.returnedModel = null;
  }

  assert.deepEqual(validateAgentMissionM2A3SemanticEvidence(receipt, SHA), {
    outcome: 'failed',
  });
  const contradictory = structuredClone(receipt);
  contradictory.failureStage = 'local_contract';
  assert.throws(
    () => validateAgentMissionM2A3SemanticEvidence(contradictory, SHA),
    /failure stage contradicts/u,
  );
});

test('refuse les catégories fournisseur hors provider_error ou en doublon', () => {
  const contradictory = passingReceipt();
  contradictory.outcome = 'failed';
  contradictory.failureStage = 'semantic_result';
  contradictory.cases[0].passed = false;
  contradictory.cases[0].status = 'rejected';
  contradictory.cases[0].issueCodes = [
    'mission_frame_required',
    'provider_authentication_failed',
  ];
  contradictory.cases[0].rejectionReason = 'invalid_mission_frame';
  assert.throws(
    () => validateAgentMissionM2A3SemanticEvidence(contradictory, SHA),
    /result is inconsistent/u,
  );

  const duplicated = passingReceipt();
  duplicated.outcome = 'failed';
  duplicated.failureStage = 'provider_request';
  duplicated.modelCompatible = false;
  duplicated.cases[0].passed = false;
  duplicated.cases[0].status = 'provider_error';
  duplicated.cases[0].issueCodes = [
    'provider_request_failed',
    'provider_authentication_failed',
    'provider_rate_limited',
    'completion_resolution_count_mismatch',
    'returned_model_missing',
  ];
  duplicated.cases[0].rejectionReason = 'provider_error';
  duplicated.cases[0].completeResolved = 0;
  duplicated.cases[0].returnedModelStatus = 'missing';
  duplicated.cases[0].returnedModel = null;
  assert.throws(
    () => validateAgentMissionM2A3SemanticEvidence(duplicated, SHA),
    /result is inconsistent/u,
  );
});

test('refuse une valeur de modèle brute invalide dans un reçu rouge', () => {
  const receipt = passingReceipt();
  receipt.outcome = 'failed';
  receipt.failureStage = 'semantic_result';
  receipt.modelCompatible = false;
  receipt.cases[0].passed = false;
  receipt.cases[0].issueCodes = ['returned_model_invalid_identifier'];
  receipt.cases[0].returnedModelStatus = 'invalid_identifier';
  receipt.cases[0].returnedModel = 'gpt-test\nsecret';

  assert.throws(
    () => validateAgentMissionM2A3SemanticEvidence(receipt, SHA),
    /result is inconsistent/u,
  );
});

test('refuse tout champ libre ajouté et toute donnée métier reconnaissable', () => {
  const withExtraKey = passingReceipt();
  withExtraKey.cases[0].transcript = 'secret';
  assert.throws(
    () => validateAgentMissionM2A3SemanticEvidence(withExtraKey, SHA),
    /schema drifted/u,
  );

  const withBusinessValue = passingReceipt();
  withBusinessValue.requestedModel = 'plomberie';
  withBusinessValue.returnedModels = ['plomberie'];
  for (const entry of withBusinessValue.cases) {
    entry.returnedModelStatus = 'exact';
    entry.returnedModel = 'plomberie';
  }
  assert.throws(
    () => validateAgentMissionM2A3SemanticEvidence(withBusinessValue, SHA),
    /forbidden content/u,
  );
});

test('refuse un résultat passant incomplet ou des compteurs masqués', () => {
  const incomplete = passingReceipt();
  incomplete.cases.pop();
  incomplete.completionCount = 5;
  incomplete.providerRequestCount = 5;
  incomplete.modelCompatible = false;
  assert.throws(
    () => validateAgentMissionM2A3SemanticEvidence(incomplete, SHA),
    /aggregate counters|outcome does not match/u,
  );

  const masked = passingReceipt();
  masked.cases[0].completeAttempts = 2;
  assert.throws(
    () => validateAgentMissionM2A3SemanticEvidence(masked, SHA),
    /result is inconsistent|aggregate counters/u,
  );
});

test('refuse les diagnostics rouges contradictoires et une source modèle absente', () => {
  const contradictory = passingReceipt();
  contradictory.outcome = 'failed';
  contradictory.failureStage = 'semantic_result';
  contradictory.cases[0].passed = false;
  contradictory.cases[0].issueCodes = ['mission_frame_required'];
  contradictory.cases[0].rejectionReason = 'provider_error';
  assert.throws(
    () => validateAgentMissionM2A3SemanticEvidence(contradictory, SHA),
    /result is inconsistent/u,
  );

  const missingSource = passingReceipt();
  missingSource.requestedModelSource = null;
  assert.throws(
    () => validateAgentMissionM2A3SemanticEvidence(missingSource, SHA),
    /requested model is unsafe/u,
  );

  const override = passingReceipt();
  override.requestedModelSource = 'environment_override';
  assert.throws(
    () => validateAgentMissionM2A3SemanticEvidence(override, SHA),
    /requested model is unsafe/u,
  );
});

test('refuse un reçu rouge sans étage de panne explicite', () => {
  const receipt = passingReceipt();
  receipt.outcome = 'failed';
  receipt.failureStage = null;
  receipt.cases[0].passed = false;
  receipt.cases[0].status = 'rejected';
  receipt.cases[0].issueCodes = ['mission_frame_required'];
  receipt.cases[0].rejectionReason = 'invalid_mission_frame';

  assert.throws(
    () => validateAgentMissionM2A3SemanticEvidence(receipt, SHA),
    /failed outcome requires a failure stage/u,
  );
});

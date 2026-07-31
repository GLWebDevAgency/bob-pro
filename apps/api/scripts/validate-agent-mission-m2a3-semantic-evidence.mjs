import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CASE_IDS = Object.freeze([
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
const ISSUE_CODES = new Set([
  'mission_frame_required',
  'mission_frame_version_mismatch',
  'operation_count_mismatch',
  'operation_kind_mismatch',
  'appended_line_count_mismatch',
  'service_label_unverified_content',
  'category_mismatch',
  'quantity_mismatch',
  'unit_mismatch',
  'unit_price_mismatch',
  'currency_mismatch',
  'price_basis_mismatch',
  'vat_rate_invented',
  'choice_ordinal_mismatch',
  'unprocessed_request_signal_mismatch',
  'unexpected_additional_lines',
  'patch_scope_mismatch',
  'patch_field_mismatch',
  'patch_value_mismatch',
  'patch_currency_mismatch',
  'patch_basis_mismatch',
  'completion_attempt_count_mismatch',
  'completion_resolution_count_mismatch',
  'generate_count_mismatch',
  'returned_model_missing',
  'returned_model_invalid_identifier',
  'returned_model_incompatible',
  'planner_model_mismatch',
  'strict_schema_invalid',
  'provider_request_failed',
  'provider_invalid_function_parameters',
  'provider_authentication_failed',
  'provider_permission_denied',
  'provider_rate_limited',
  'provider_quota_exceeded',
  'provider_unavailable',
  'provider_http_error',
  'planner_processing_failed',
  'local_evaluation_failed',
]);
const STATUSES = new Set([
  'mission_frame',
  'global_plan',
  'out_of_scope',
  'rejected',
  'schema_error',
  'provider_error',
  'planner_error',
  'local_error',
]);
const REJECTION_REASONS = new Set([
  null,
  'invalid_input',
  'mixed_authorities',
  'invalid_mission_frame',
  'invalid_global_plan',
  'invalid_model',
  'strict_schema_invalid',
  'provider_error',
  'planner_error',
  'local_error',
]);
const SEMANTIC_REJECTION_REASONS = new Set([
  'invalid_input',
  'mixed_authorities',
  'invalid_mission_frame',
  'invalid_global_plan',
  'invalid_model',
]);
const RETURNED_MODEL_STATUSES = new Set([
  'exact',
  'snapshot',
  'missing',
  'invalid_identifier',
  'incompatible',
]);
const PROVIDER_DETAIL_CODES = new Set([
  'provider_invalid_function_parameters',
  'provider_authentication_failed',
  'provider_permission_denied',
  'provider_rate_limited',
  'provider_quota_exceeded',
  'provider_unavailable',
  'provider_http_error',
]);
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const EXACT_SHA = /^[a-f0-9]{40}$/u;

function fail(message) {
  throw new Error(`M2-A-3 semantic evidence rejected: ${message}`);
}

function exactKeys(value, expected, label) {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())
  ) {
    fail(`${label} schema drifted`);
  }
}

function compatibleModel(requested, returned) {
  return (
    returned === requested ||
    (returned.startsWith(`${requested}-`) &&
      /^-\d{4}-\d{2}-\d{2}$/u.test(returned.slice(requested.length)))
  );
}

export function validateAgentMissionM2A3SemanticEvidence(receipt, expectedSha) {
  if (!EXACT_SHA.test(expectedSha)) fail('expected SHA is invalid');
  exactKeys(
    receipt,
    [
      'schema',
      'version',
      'scope',
      'corpusVersion',
      'releaseSha',
      'provider',
      'requestedModel',
      'requestedModelStatus',
      'requestedModelSource',
      'returnedModels',
      'modelCompatible',
      'completionCount',
      'generateCount',
      'providerRequestCount',
      'outcome',
      'failureStage',
      'cases',
    ],
    'receipt',
  );
  if (
    receipt.schema !== 'bob.m2a3.semantic-model-eval' ||
    receipt.version !== 2 ||
    receipt.scope !== 'quote_line_m2a3' ||
    receipt.corpusVersion !== 4 ||
    receipt.releaseSha !== expectedSha ||
    receipt.provider !== 'openai'
  ) {
    fail('identity mismatch');
  }
  const requestedModelIsValid =
    receipt.requestedModelStatus === 'valid' &&
    typeof receipt.requestedModel === 'string' &&
    MODEL_IDENTIFIER.test(receipt.requestedModel) &&
    receipt.requestedModelSource === 'versioned_default';
  const requestedModelIsMissing =
    receipt.requestedModelStatus === 'invalid_or_missing' &&
    receipt.requestedModel === null &&
    receipt.requestedModelSource === null;
  if (!requestedModelIsValid && !requestedModelIsMissing) {
    fail('requested model is unsafe');
  }
  if (
    typeof receipt.modelCompatible !== 'boolean' ||
    !Number.isSafeInteger(receipt.completionCount) ||
    receipt.completionCount < 0 ||
    receipt.completionCount > 12 ||
    !Number.isSafeInteger(receipt.generateCount) ||
    receipt.generateCount < 0 ||
    receipt.generateCount > 12 ||
    !Number.isSafeInteger(receipt.providerRequestCount) ||
    receipt.providerRequestCount < 0 ||
    receipt.providerRequestCount > 12 ||
    (receipt.outcome !== 'passed' && receipt.outcome !== 'failed') ||
    ![
      'configuration',
      'local_contract',
      'provider_request',
      'multiple_failures',
      'semantic_result',
      null,
    ].includes(
      receipt.failureStage,
    ) ||
    !Array.isArray(receipt.returnedModels) ||
    receipt.returnedModels.length > CASE_IDS.length ||
    new Set(receipt.returnedModels).size !== receipt.returnedModels.length ||
    !Array.isArray(receipt.cases) ||
    receipt.cases.length > CASE_IDS.length
  ) {
    fail('bounded metadata is invalid');
  }
  for (const model of receipt.returnedModels) {
    if (
      typeof model !== 'string' ||
      !MODEL_IDENTIFIER.test(model) ||
      !requestedModelIsValid ||
      !compatibleModel(receipt.requestedModel, model)
    ) {
      fail('returned model inventory is unsafe');
    }
  }

  let completeAttempts = 0;
  let generateAttempts = 0;
  const observedPublicModels = [];
  for (let index = 0; index < receipt.cases.length; index += 1) {
    const entry = receipt.cases[index];
    exactKeys(
      entry,
      [
        'id',
        'passed',
        'status',
        'durationMs',
        'issueCodes',
        'rejectionReason',
        'completeAttempts',
        'completeResolved',
        'generateAttempts',
        'returnedModelStatus',
        'returnedModel',
      ],
      `case ${index + 1}`,
    );
    if (
      entry.id !== CASE_IDS[index] ||
      typeof entry.passed !== 'boolean' ||
      !STATUSES.has(entry.status) ||
      !Number.isSafeInteger(entry.durationMs) ||
      entry.durationMs < 0 ||
      entry.durationMs > 20_000 ||
      !Array.isArray(entry.issueCodes) ||
      new Set(entry.issueCodes).size !== entry.issueCodes.length ||
      entry.issueCodes.some((code) => !ISSUE_CODES.has(code)) ||
      !REJECTION_REASONS.has(entry.rejectionReason) ||
      !Number.isSafeInteger(entry.completeAttempts) ||
      entry.completeAttempts < 0 ||
      entry.completeAttempts > 2 ||
      !Number.isSafeInteger(entry.completeResolved) ||
      entry.completeResolved < 0 ||
      entry.completeResolved > entry.completeAttempts ||
      !Number.isSafeInteger(entry.generateAttempts) ||
      entry.generateAttempts < 0 ||
      entry.generateAttempts > 1 ||
      !RETURNED_MODEL_STATUSES.has(entry.returnedModelStatus)
    ) {
      fail(`case ${index + 1} metadata is invalid`);
    }
    const modelIsPublic =
      entry.returnedModelStatus === 'exact' || entry.returnedModelStatus === 'snapshot';
    const rejectionIsConsistent =
      entry.status === 'rejected'
        ? SEMANTIC_REJECTION_REASONS.has(entry.rejectionReason)
        : entry.status === 'schema_error'
          ? entry.rejectionReason === 'strict_schema_invalid'
        : entry.status === 'provider_error'
          ? entry.rejectionReason === 'provider_error'
          : entry.status === 'planner_error'
            ? entry.rejectionReason === 'planner_error'
            : entry.status === 'local_error'
              ? entry.rejectionReason === 'local_error'
              : entry.rejectionReason === null;
    const executionIsConsistent =
      entry.status === 'schema_error'
        ? entry.completeAttempts === 1 &&
          entry.completeResolved === 0 &&
          entry.issueCodes.includes('strict_schema_invalid')
        : entry.status === 'provider_error'
        ? entry.completeAttempts === 1 &&
          entry.completeResolved === 0 &&
          entry.issueCodes.includes('provider_request_failed')
        : entry.status === 'planner_error'
          ? entry.completeAttempts === 1 &&
            entry.completeResolved === 1 &&
            entry.issueCodes.includes('planner_processing_failed')
          : entry.status === 'local_error'
            ? entry.issueCodes.includes('local_evaluation_failed')
            : entry.completeAttempts === 1 && entry.completeResolved === 1;
    const returnedModelIsConsistent =
      entry.returnedModelStatus === 'exact'
        ? entry.returnedModel === receipt.requestedModel
        : entry.returnedModelStatus === 'snapshot'
          ? typeof entry.returnedModel === 'string' &&
            entry.returnedModel !== receipt.requestedModel &&
            requestedModelIsValid &&
            compatibleModel(receipt.requestedModel, entry.returnedModel)
          : entry.returnedModel === null &&
            (entry.returnedModelStatus === 'missing'
              ? entry.issueCodes.includes('returned_model_missing')
              : entry.returnedModelStatus === 'invalid_identifier'
                ? entry.issueCodes.includes('returned_model_invalid_identifier')
                : entry.issueCodes.includes('returned_model_incompatible'));
    const providerDetailCodeCount = entry.issueCodes.filter((code) =>
      PROVIDER_DETAIL_CODES.has(code)).length;
    const failureIssueIsConsistent =
      entry.issueCodes.includes('strict_schema_invalid') === (entry.status === 'schema_error') &&
      entry.issueCodes.includes('provider_request_failed') === (entry.status === 'provider_error') &&
      entry.issueCodes.includes('planner_processing_failed') === (entry.status === 'planner_error') &&
      entry.issueCodes.includes('local_evaluation_failed') === (entry.status === 'local_error');
    if (
      modelIsPublic !== (typeof entry.returnedModel === 'string') ||
      !rejectionIsConsistent ||
      !executionIsConsistent ||
      !returnedModelIsConsistent ||
      !failureIssueIsConsistent ||
      (entry.status === 'provider_error'
        ? providerDetailCodeCount > 1
        : providerDetailCodeCount !== 0) ||
      (modelIsPublic &&
        (!MODEL_IDENTIFIER.test(entry.returnedModel) ||
          !requestedModelIsValid ||
          !compatibleModel(receipt.requestedModel, entry.returnedModel))) ||
      (entry.passed &&
        (entry.status !== 'mission_frame' ||
          entry.issueCodes.length !== 0 ||
          entry.rejectionReason !== null ||
          entry.completeAttempts !== 1 ||
          entry.completeResolved !== 1 ||
          entry.generateAttempts !== 0 ||
          !modelIsPublic)) ||
      (!entry.passed && entry.issueCodes.length === 0)
    ) {
      fail(`case ${index + 1} result is inconsistent`);
    }
    completeAttempts += entry.completeAttempts;
    generateAttempts += entry.generateAttempts;
    if (typeof entry.returnedModel === 'string') {
      observedPublicModels.push(entry.returnedModel);
    }
  }

  const uniqueObservedModels = [...new Set(observedPublicModels)];
  const computedModelCompatibility =
    requestedModelIsValid &&
    receipt.cases.length === CASE_IDS.length &&
    receipt.cases.every(
      (entry) => entry.returnedModelStatus === 'exact' || entry.returnedModelStatus === 'snapshot',
    );
  const schemaErrorCount = receipt.cases.filter(
    (entry) => entry.status === 'schema_error',
  ).length;
  if (
    completeAttempts !== receipt.completionCount ||
    generateAttempts !== receipt.generateCount ||
    receipt.providerRequestCount !== receipt.completionCount - schemaErrorCount ||
    JSON.stringify(uniqueObservedModels) !== JSON.stringify(receipt.returnedModels) ||
    receipt.modelCompatible !== computedModelCompatibility
  ) {
    fail('aggregate counters or model inventory do not match cases');
  }

  const passing =
    receipt.failureStage === null &&
    receipt.modelCompatible === true &&
    receipt.completionCount === CASE_IDS.length &&
    receipt.generateCount === 0 &&
    receipt.providerRequestCount === CASE_IDS.length &&
    receipt.returnedModels.length > 0 &&
    receipt.cases.length === CASE_IDS.length &&
    receipt.cases.every((entry) => entry.passed);
  if ((receipt.outcome === 'passed') !== passing) {
    fail('outcome does not match the certified facts');
  }
  if (receipt.outcome === 'failed' && receipt.failureStage === null) {
    fail('failed outcome requires a failure stage');
  }
  const hasProviderFailure = receipt.cases.some((entry) => entry.status === 'provider_error');
  const hasSchemaFailure = schemaErrorCount > 0;
  if (
    (receipt.failureStage === 'provider_request' && !hasProviderFailure) ||
    (receipt.failureStage === 'local_contract' &&
      (!hasSchemaFailure ||
        hasProviderFailure ||
        receipt.providerRequestCount >= receipt.completionCount)) ||
    (receipt.failureStage === 'provider_request' && hasSchemaFailure) ||
    (receipt.failureStage === 'multiple_failures' &&
      (!hasSchemaFailure ||
        !hasProviderFailure ||
        receipt.providerRequestCount >= receipt.completionCount)) ||
    (receipt.failureStage === 'semantic_result' && (hasProviderFailure || hasSchemaFailure)) ||
    (receipt.failureStage === 'configuration' &&
      (receipt.cases.length !== 0 ||
        receipt.completionCount !== 0 ||
        receipt.generateCount !== 0 ||
        receipt.providerRequestCount !== 0))
  ) {
    fail('failure stage contradicts the bounded case results');
  }

  const serialized = JSON.stringify(receipt).toLocaleLowerCase('en-US');
  for (const forbidden of [
    'transcript',
    'prompt',
    'arguments',
    'utterance',
    'plomberie',
    'customerid',
    'missionid',
    'choiceid',
    'proposalid',
    'diffhash',
  ]) {
    if (serialized.includes(forbidden)) {
      fail(`forbidden content: ${forbidden}`);
    }
  }
  return Object.freeze({ outcome: receipt.outcome });
}

function runCli() {
  const [, , evidencePath, expectedSha] = process.argv;
  if (typeof evidencePath !== 'string' || typeof expectedSha !== 'string') {
    fail('usage: validator <evidence.json> <expected-sha>');
  }
  const receipt = JSON.parse(readFileSync(evidencePath, 'utf8'));
  validateAgentMissionM2A3SemanticEvidence(receipt, expectedSha);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli();

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_URL = 'https://backboard.railway.com/graphql/v2';
const EVIDENCE_PREFIX = 'BOB_DOCUMENT_ARCHIVE_AUDIT_EVIDENCE=';
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const ISSUE_CODE = /^[A-Z][A-Z0-9_]{2,127}$/u;
const MAX_GRAPHQL_BODY_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_ISSUE_CODES = 128;
const MAX_RETRY_AFTER_MILLISECONDS = 60_000;
const EXPECTED_RAILWAY_CONFIG_FILE = '/railway.archive-audit.json';
const EXPECTED_START_COMMAND = '/usr/local/bin/bob-archive-audit-entrypoint';
const ALLOWED_ISSUE_CODES = new Set([
  'ARCHIVE_ATTESTATION_WRITE_OUTSIDE_V1',
  'ARCHIVE_PREACTIVATION_SCAN_RACE_DETECTED',
  'ARCHIVE_PROTOCOL_STATE_INVALID',
  'ARCHIVE_PROTOCOL_V2_ACTIVATION_PROOF_INVALID',
  'ARCHIVE_PROTOCOL_V2_BASELINE_EVIDENCE_MISSING',
  'ARCHIVE_PROTOCOL_V2_DOCUMENT_COUNT_CHANGED',
  'ARCHIVE_PROTOCOL_V2_GENERATED_REPRESENTATION_INVALID',
  'ARCHIVE_PROTOCOL_V2_JOB_PROOF_INVALID',
  'ARCHIVE_PROTOCOL_V2_LATE_ATTESTATION_WRITE',
  'ARCHIVE_PROTOCOL_V2_SCAN_RACE_DETECTED',
  'ARCHIVE_PROTOCOL_V2_STORAGE_BUCKET_MISMATCH',
  'ARCHIVE_PROTOCOL_V2_STORAGE_MUTATION_SUSPECTED',
  'ARCHIVE_PROTOCOL_V2_STORAGE_ORPHAN_PRESENT',
  'ARCHIVE_PROTOCOL_V2_STORED_OBJECT_MISSING',
  'ARCHIVE_PROTOCOL_V2_VALIDATOR_BASELINE_MISMATCH',
  'B2C_FACTURX_XML_FORBIDDEN',
  'B2C_PDF_PROFILE_INVALID',
  'FACTURX_EMBEDDED_XML_MISMATCH',
  'FACTURX_EXTERNAL_CONFORMANCE_UNVERIFIED',
  'FACTURX_XML_SCOPE_INVALID',
  'GENERATED_LEGAL_DOCUMENT_STATE_INVALID',
  'GENERATED_LEGAL_MIME_INVALID',
  'GENERATED_LEGAL_OBJECT_MISMATCH',
  'GENERATED_LEGAL_OBJECT_MISSING',
  'GENERATED_LEGAL_SHA256_INVALID',
  'GENERATED_LEGAL_SIZE_INVALID',
  'GENERATED_LEGAL_STORAGE_KEY_INVALID',
  'GENERATED_LEGAL_STORAGE_KEY_NOT_CONTENT_ADDRESSED',
  'GENERATED_LEGAL_VERSION_INVALID',
  'INVOICE_ARCHIVE_SCOPE_INVALID',
  'INVOICE_PDF_ATTESTATION_BATCH_BLOCKED',
  'INVOICE_PDF_ATTESTATION_BATCH_FAILED',
  'INVOICE_PDF_ATTESTATION_BATCH_REJECTED',
  'INVOICE_PDF_ATTESTATION_CONFLICT',
  'INVOICE_PDF_ATTESTATION_MISSING',
  'INVOICE_PDF_CARDINALITY_INVALID',
  'INVOICE_PDF_REASON_INVALID',
  'PDF_INSPECTOR_DIGEST_MISMATCH',
  'PDF_REPRESENTATION_UNKNOWN_OR_AMBIGUOUS',
  'PROFESSIONAL_FACTURX_XML_CARDINALITY_INVALID',
  'PROFESSIONAL_PDF_PROFILE_INVALID',
  'SIGNED_QUOTE_PDF_PROFILE_INVALID',
  'SIGNED_QUOTE_REPRESENTATION_CARDINALITY_INVALID',
  'SIGNED_QUOTE_SCOPE_INVALID',
  'SQL_REFERENCE_WITHOUT_STORAGE_OBJECT',
  'STORAGE_ADAPTER_DIGEST_MISMATCH',
  'STORAGE_OBJECT_READ_FAILED',
  'STORAGE_OBJECT_WITHOUT_SQL_REFERENCE',
]);
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_STATUSES = new Set(['INITIALIZING', 'BUILDING', 'DEPLOYING', 'QUEUED']);
const TERMINAL_FAILURES = new Set([
  'FAILED',
  'CRASHED',
  'REMOVED',
  'REMOVING',
  'SKIPPED',
  'SLEEPING',
  'WAITING',
]);
const TERMINAL_SUCCESSES = new Set(['COMPLETED', 'SUCCESS']);
const CLEANUP_NOT_NEEDED_STATUSES = new Set([
  'COMPLETED',
  'FAILED',
  'CRASHED',
  'REMOVED',
  'REMOVING',
  'SKIPPED',
  'SLEEPING',
]);
const EVIDENCE_KEYS = [
  'counts',
  'deploymentId',
  'inventoryDigest',
  'issueCodes',
  'mode',
  'protocolVersion',
  'readyForActivation',
  'releaseSha',
  'reportSha256',
  'schemaVersion',
  'validatorEvidenceDigest',
  'validators',
];
const COUNT_KEYS = [
  'appliedAttestations',
  'existingAttestations',
  'externallyValidatedProfessionalInvoices',
  'generatedLegalDocuments',
  'missingStoredObjects',
  'objectsRead',
  'p0Issues',
  'storageOrphans',
];
const VALIDATOR_KEYS = ['fnfe', 'mustang', 'representationDetector'];

function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function boundedInteger(environment, name, fallback, minimum, maximum) {
  const raw = environment[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function sameKeys(value, expected) {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function validateCounts(value, readyForActivation) {
  const counts = object(value);
  const entries = counts === null ? [] : Object.entries(counts);
  if (
    counts === null ||
    !sameKeys(counts, COUNT_KEYS) ||
    entries.some(([, count]) => !Number.isSafeInteger(count) || count < 0) ||
    (readyForActivation ? counts.p0Issues !== 0 : counts.p0Issues === 0)
  ) {
    throw new Error('Archive evidence counts are inconsistent with the activation verdict.');
  }
  return Object.fromEntries(entries);
}

function validateIssueCodes(value, readyForActivation) {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ISSUE_CODES ||
    value.some(
      (code) =>
        typeof code !== 'string' || !ISSUE_CODE.test(code) || !ALLOWED_ISSUE_CODES.has(code),
    ) ||
    value.some((code, index) => index > 0 && value[index - 1] >= code) ||
    (readyForActivation ? value.length !== 0 : value.length === 0)
  ) {
    throw new Error('Archive evidence issue codes are invalid or inconsistent with the verdict.');
  }
  return [...value];
}

function validateEvidence(value, deploymentId, releaseSha) {
  const evidence = object(value);
  if (evidence === null || !sameKeys(evidence, EVIDENCE_KEYS)) {
    throw new Error('Archive evidence does not match the non-PII schema.');
  }
  const validators = object(evidence.validators);
  if (
    validators === null ||
    !sameKeys(validators, VALIDATOR_KEYS) ||
    validators.representationDetector !== 1 ||
    validators.mustang !== '2.24.0' ||
    validators.fnfe !== '1.4.0.02'
  ) {
    throw new Error('Archive evidence validator versions are invalid.');
  }
  const protocolAndModeAreConsistent =
    (evidence.protocolVersion === 1 && evidence.mode === 'apply-attestations') ||
    (evidence.protocolVersion === 2 && evidence.mode === 'protocol-v2-verified');
  if (
    evidence.schemaVersion !== 1 ||
    evidence.deploymentId !== deploymentId ||
    evidence.releaseSha !== releaseSha ||
    typeof evidence.readyForActivation !== 'boolean' ||
    !protocolAndModeAreConsistent ||
    !SHA256.test(evidence.reportSha256 ?? '') ||
    !SHA256.test(evidence.inventoryDigest ?? '') ||
    !SHA256.test(evidence.validatorEvidenceDigest ?? '')
  ) {
    throw new Error('Archive evidence is incomplete or bound to another deployment/release.');
  }
  return {
    schemaVersion: 1,
    deploymentId,
    releaseSha,
    readyForActivation: evidence.readyForActivation,
    protocolVersion: evidence.protocolVersion,
    mode: evidence.mode,
    inventoryDigest: evidence.inventoryDigest,
    reportSha256: evidence.reportSha256,
    validatorEvidenceDigest: evidence.validatorEvidenceDigest,
    issueCodes: validateIssueCodes(evidence.issueCodes, evidence.readyForActivation),
    counts: validateCounts(evidence.counts, evidence.readyForActivation),
    validators: {
      representationDetector: 1,
      mustang: '2.24.0',
      fnfe: '1.4.0.02',
    },
  };
}

export function extractArchiveAuditEvidence(logs, deploymentId, releaseSha) {
  if (!Array.isArray(logs)) throw new Error('Railway deployment logs have an invalid shape.');
  const encodedMarkers = [];
  for (const entry of logs) {
    const message = typeof entry?.message === 'string' ? entry.message : '';
    if (!message.includes(EVIDENCE_PREFIX)) continue;
    const trimmed = message.trim();
    if (!trimmed.startsWith(EVIDENCE_PREFIX)) {
      throw new Error('Archive evidence marker is not an exact standalone log line.');
    }
    const encoded = trimmed.slice(EVIDENCE_PREFIX.length);
    if (
      trimmed !== `${EVIDENCE_PREFIX}${encoded}` ||
      !BASE64URL.test(encoded) ||
      encoded.length > MAX_EVIDENCE_BYTES * 2
    ) {
      throw new Error('Archive evidence marker is malformed.');
    }
    encodedMarkers.push(encoded);
  }
  if (encodedMarkers.length === 0) return null;
  if (encodedMarkers.length !== 1) {
    throw new Error(`Expected exactly one archive evidence marker, got ${encodedMarkers.length}.`);
  }
  const decoded = Buffer.from(encodedMarkers[0], 'base64url');
  if (
    decoded.byteLength === 0 ||
    decoded.byteLength > MAX_EVIDENCE_BYTES ||
    decoded.toString('base64url') !== encodedMarkers[0]
  ) {
    throw new Error('Archive evidence marker is not canonical base64url.');
  }
  let parsed;
  try {
    parsed = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new Error('Archive evidence marker does not contain valid JSON.');
  }
  return validateEvidence(parsed, deploymentId, releaseSha);
}

export class ArchiveAuditBusinessRefusalError extends Error {
  constructor(deploymentId, issueCodes) {
    super(`Archive audit refused activation (${issueCodes.join(', ')}).`);
    this.name = 'ArchiveAuditBusinessRefusalError';
    this.code = 'ARCHIVE_AUDIT_BUSINESS_REFUSAL';
    this.deploymentId = deploymentId;
    this.issueCodes = [...issueCodes];
  }
}

export class ArchiveAuditCancellationError extends Error {
  constructor(signalName) {
    const exitCode = signalName === 'SIGHUP' ? 129 : signalName === 'SIGINT' ? 130 : 143;
    super(`Archive audit cancelled by ${signalName}.`);
    this.name = 'ArchiveAuditCancellationError';
    this.code = 'ARCHIVE_AUDIT_CANCELLED';
    this.signalName = signalName;
    this.exitCode = exitCode;
  }
}

function cancellationReason(signal) {
  if (signal?.reason instanceof ArchiveAuditCancellationError) return signal.reason;
  return new ArchiveAuditCancellationError('SIGTERM');
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancellationReason(signal);
}

function combinedRequestSignal(timeoutSignal, cancellationSignal) {
  const signals = [timeoutSignal, cancellationSignal].filter(
    (signal) => signal && typeof signal.aborted === 'boolean',
  );
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

async function sleepUntilOrCancellation(sleep, milliseconds, cancellationSignal) {
  throwIfCancelled(cancellationSignal);
  if (!cancellationSignal) {
    await sleep(milliseconds);
    return;
  }

  await new Promise((resolveSleep, rejectSleep) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cancellationSignal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => settle(rejectSleep, cancellationReason(cancellationSignal));
    cancellationSignal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(() => sleep(milliseconds))
      .then(
        () => settle(resolveSleep),
        (error) => settle(rejectSleep, error),
      );
  });
}

class RetryableGraphqlError extends Error {
  constructor(message, retryAfterMilliseconds = null) {
    super(message);
    this.retryAfterMilliseconds = retryAfterMilliseconds;
  }
}

function retryAfterMilliseconds(response) {
  const raw = response.headers?.get?.('retry-after')?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  let milliseconds;
  if (Number.isFinite(seconds) && seconds >= 0) {
    milliseconds = seconds * 1_000;
  } else {
    const retryAt = Date.parse(raw);
    if (!Number.isFinite(retryAt)) return null;
    milliseconds = retryAt - Date.now();
  }
  return Math.min(MAX_RETRY_AFTER_MILLISECONDS, Math.max(1_000, Math.ceil(milliseconds)));
}

function graphqlErrors(payload) {
  if (!Array.isArray(payload?.errors) || payload.errors.length === 0) return null;
  return payload.errors
    .slice(0, 5)
    .map((error) => {
      const message = typeof error?.message === 'string' ? error.message.trim() : '';
      return message ? message.slice(0, 512) : 'unknown Railway GraphQL error';
    })
    .join('; ');
}

async function readBoundedResponseText(response) {
  const declaredLength = response.headers?.get?.('content-length');
  if (
    declaredLength !== null &&
    declaredLength !== undefined &&
    Number.isSafeInteger(Number(declaredLength)) &&
    Number(declaredLength) > MAX_GRAPHQL_BODY_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Railway GraphQL returned an oversized response.');
  }
  if (typeof response.body?.getReader !== 'function') {
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_GRAPHQL_BODY_BYTES) {
      throw new Error('Railway GraphQL returned an oversized response.');
    }
    return raw;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  let reading = true;
  while (reading) {
    const { done, value } = await reader.read();
    if (done) {
      reading = false;
      continue;
    }
    if (!(value instanceof Uint8Array)) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Railway GraphQL returned an invalid response body.');
    }
    byteLength += value.byteLength;
    if (byteLength > MAX_GRAPHQL_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Railway GraphQL returned an oversized response.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, byteLength).toString('utf8');
}

async function graphql(
  token,
  query,
  variables,
  { attempts, cancellationSignal, fetchImpl, requestTimeoutSignal, sleep },
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      throwIfCancelled(cancellationSignal);
      const response = await fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Project-Access-Token': token,
        },
        body: JSON.stringify({ query, variables }),
        redirect: 'error',
        signal: combinedRequestSignal(
          requestTimeoutSignal(30_000),
          cancellationSignal,
        ),
      });
      throwIfCancelled(cancellationSignal);
      if (!response || typeof response.status !== 'number' || typeof response.text !== 'function') {
        throw new Error('Railway GraphQL returned an invalid HTTP response.');
      }
      if (!response.ok) {
        if (RETRYABLE_HTTP_STATUSES.has(response.status)) {
          await response.body?.cancel().catch(() => undefined);
          throw new RetryableGraphqlError(
            `Railway GraphQL returned HTTP ${response.status}.`,
            retryAfterMilliseconds(response),
          );
        }
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Railway GraphQL returned HTTP ${response.status}.`);
      }
      const raw = await readBoundedResponseText(response);
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new Error('Railway GraphQL returned invalid JSON.');
      }
      const envelope = object(payload);
      if (envelope === null || ('errors' in envelope && !Array.isArray(envelope.errors))) {
        throw new Error('Railway GraphQL returned an invalid envelope.');
      }
      const errorMessage = graphqlErrors(payload);
      if (errorMessage !== null) {
        throw new Error(`Railway GraphQL rejected the operation: ${errorMessage}`);
      }
      if (object(payload.data) === null) {
        throw new Error('Railway GraphQL returned an invalid envelope.');
      }
      return payload.data;
    } catch (error) {
      throwIfCancelled(cancellationSignal);
      const retryable =
        error instanceof RetryableGraphqlError ||
        error?.name === 'AbortError' ||
        error?.name === 'TimeoutError' ||
        error instanceof TypeError;
      if (!retryable || attempt === attempts) {
        if (error instanceof RetryableGraphqlError) throw new Error(error.message);
        if (retryable) {
          throw new Error('Railway GraphQL request failed before a usable response.', {
            cause: error,
          });
        }
        throw error;
      }
      const backoffMilliseconds = Math.min(1_000 * 2 ** (attempt - 1), 5_000);
      await sleepUntilOrCancellation(
        sleep,
        Math.max(backoffMilliseconds, error.retryAfterMilliseconds ?? 0),
        cancellationSignal,
      );
    }
  }
  throw new Error('Railway GraphQL request exhausted its bounded attempts.');
}

function parseConfig(environment) {
  const token = required(environment, 'RAILWAY_TOKEN');
  const serviceId = environment.RAILWAY_ARCHIVE_AUDIT_SERVICE_ID?.trim();
  const environmentId = environment.RAILWAY_ENVIRONMENT_ID?.trim();
  const releaseSha = environment.RELEASE_SHA?.trim();
  const outputRaw = environment.DOCUMENT_ARCHIVE_AUDIT_CI_EVIDENCE?.trim();
  if (!UUID.test(serviceId ?? '')) {
    throw new Error('RAILWAY_ARCHIVE_AUDIT_SERVICE_ID must be a UUID.');
  }
  if (!UUID.test(environmentId ?? '')) {
    throw new Error('RAILWAY_ENVIRONMENT_ID must be a UUID.');
  }
  if (!SHA.test(releaseSha ?? '')) {
    throw new Error('RELEASE_SHA must be a full lowercase Git SHA.');
  }
  return {
    token,
    serviceId,
    environmentId,
    releaseSha,
    outputPath: resolve(outputRaw || 'document-archive-audit-evidence.json'),
    timeoutSeconds: boundedInteger(
      environment,
      'DOCUMENT_ARCHIVE_AUDIT_TIMEOUT_SECONDS',
      5_400,
      60,
      7_200,
    ),
    pollSeconds: boundedInteger(environment, 'DOCUMENT_ARCHIVE_AUDIT_POLL_SECONDS', 10, 10, 60),
  };
}

async function waitForNextPoll(sleep, now, deadline, pollMilliseconds) {
  const remaining = deadline - now();
  if (remaining <= 0) return false;
  await sleep(Math.min(pollMilliseconds, remaining));
  return true;
}

function certifyArchiveAuditServiceInstance(value, config) {
  const serviceInstance = object(value);
  if (
    serviceInstance === null ||
    serviceInstance.serviceId !== config.serviceId ||
    serviceInstance.environmentId !== config.environmentId
  ) {
    throw new Error('Railway returned another service instance or an invalid preflight envelope.');
  }
  const violations = [];
  if (serviceInstance.railwayConfigFile !== EXPECTED_RAILWAY_CONFIG_FILE) {
    violations.push(`railwayConfigFile=${String(serviceInstance.railwayConfigFile)}`);
  }
  if (serviceInstance.startCommand !== EXPECTED_START_COMMAND) {
    violations.push(`startCommand=${String(serviceInstance.startCommand)}`);
  }
  if (serviceInstance.builder !== 'DOCKERFILE') {
    violations.push(`builder=${String(serviceInstance.builder)}`);
  }
  if (serviceInstance.healthcheckPath !== null) {
    violations.push(`healthcheckPath=${String(serviceInstance.healthcheckPath)}`);
  }
  if (serviceInstance.numReplicas !== 1) {
    violations.push(`numReplicas=${String(serviceInstance.numReplicas)}`);
  }
  if (serviceInstance.restartPolicyType !== 'NEVER') {
    violations.push(`restartPolicyType=${String(serviceInstance.restartPolicyType)}`);
  }
  if (violations.length > 0) {
    throw new Error(
      `Railway archive audit service configuration drifted: ${violations.join(', ')}.`,
    );
  }
}

async function readDeploymentEvidence(config, deploymentId, graphqlDependencies) {
  const logsData = await graphql(
    config.token,
    `
      query ArchiveAuditLogs($deploymentId: String!, $limit: Int, $filter: String) {
        deploymentLogs(deploymentId: $deploymentId, limit: $limit, filter: $filter) {
          timestamp
          message
          severity
        }
      }
    `,
    {
      deploymentId,
      limit: 2_000,
      filter: EVIDENCE_PREFIX,
    },
    { ...graphqlDependencies, attempts: 3 },
  );
  return extractArchiveAuditEvidence(logsData?.deploymentLogs, deploymentId, config.releaseSha);
}

async function persistEvidence(outputPath, evidence) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

async function persistEvidenceUnlessCancelled(
  outputPath,
  evidence,
  cancellationSignal,
) {
  throwIfCancelled(cancellationSignal);
  await persistEvidence(outputPath, evidence);
  if (cancellationSignal?.aborted) {
    await rm(outputPath, { force: true });
    throw cancellationReason(cancellationSignal);
  }
}

async function mutateDeploymentOnce(config, deploymentId, mutationName, graphqlDependencies) {
  const field = mutationName === 'cancel' ? 'deploymentCancel' : 'deploymentStop';
  const operation =
    mutationName === 'cancel' ? 'ArchiveAuditDeploymentCancel' : 'ArchiveAuditDeploymentStop';
  const data = await graphql(
    config.token,
    `mutation ${operation}($id: String!) { ${field}(id: $id) }`,
    { id: deploymentId },
    { ...graphqlDependencies, attempts: 1 },
  );
  if (data?.[field] !== true) {
    throw new Error(`Railway ${field} did not confirm cleanup.`);
  }
}

async function cleanupDeploymentBestEffort(config, deploymentId, status, graphqlDependencies) {
  if (CLEANUP_NOT_NEEDED_STATUSES.has(status)) return;
  const cancelFirst = new Set(['INITIALIZING', 'BUILDING', 'QUEUED', 'WAITING']).has(status);
  const mutations = cancelFirst ? ['cancel', 'stop'] : ['stop', 'cancel'];
  for (const mutationName of mutations) {
    try {
      await mutateDeploymentOnce(config, deploymentId, mutationName, graphqlDependencies);
      return;
    } catch {
      // Best effort only: the original release error remains the authoritative failure.
    }
  }
}

export async function runRailwayDocumentArchiveAudit({
  cancellationSignal,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  now = () => performance.now(),
  requestTimeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  stdout = process.stdout,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  if (typeof now !== 'function' || typeof sleep !== 'function') {
    throw new Error('Monotonic clock and sleep implementations are required.');
  }
  if (typeof requestTimeoutSignal !== 'function') {
    throw new Error('A request timeout signal factory is required.');
  }
  if (typeof stdout?.write !== 'function') throw new Error('A writable stdout is required.');
  if (
    cancellationSignal !== undefined &&
    (typeof cancellationSignal?.aborted !== 'boolean' ||
      typeof cancellationSignal?.addEventListener !== 'function')
  ) {
    throw new Error('A valid cancellation signal is required.');
  }

  const config = parseConfig(environment);
  const graphqlDependencies = {
    cancellationSignal,
    fetchImpl,
    requestTimeoutSignal,
    sleep,
  };

  // A token scope mismatch must be discovered before the mutation: triggering first would
  // create a real one-shot deployment in the wrong release lane before failing closed.
  const projectData = await graphql(
    config.token,
    'query ProjectToken { projectToken { projectId environmentId } }',
    {},
    { ...graphqlDependencies, attempts: 3 },
  );
  const projectId = projectData?.projectToken?.projectId;
  if (
    !UUID.test(projectId ?? '') ||
    projectData?.projectToken?.environmentId !== config.environmentId
  ) {
    throw new Error('Railway project token is not scoped to the requested environment.');
  }

  const serviceInstanceData = await graphql(
    config.token,
    `
      query ArchiveAuditServiceInstance($serviceId: String!, $environmentId: String!) {
        serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
          id
          serviceId
          environmentId
          railwayConfigFile
          startCommand
          builder
          healthcheckPath
          numReplicas
          restartPolicyType
        }
      }
    `,
    { serviceId: config.serviceId, environmentId: config.environmentId },
    { ...graphqlDependencies, attempts: 3 },
  );
  certifyArchiveAuditServiceInstance(serviceInstanceData?.serviceInstance, config);

  throwIfCancelled(cancellationSignal);
  let deploymentId = null;
  let status = 'INITIALIZING';
  try {
    // This mutation is deliberately never retried. Once started, it is not aborted on a process
    // signal: preserving its response is the only way to obtain the deployment id and stop the
    // remote job. Cancellation is observed immediately before and after this bounded request.
    const deployData = await graphql(
      config.token,
      `
        mutation DeployArchiveAudit(
          $serviceId: String!
          $environmentId: String!
          $commitSha: String!
        ) {
          serviceInstanceDeployV2(
            serviceId: $serviceId
            environmentId: $environmentId
            commitSha: $commitSha
          )
        }
      `,
      {
        serviceId: config.serviceId,
        environmentId: config.environmentId,
        commitSha: config.releaseSha,
      },
      { ...graphqlDependencies, cancellationSignal: undefined, attempts: 1 },
    );
    deploymentId = deployData?.serviceInstanceDeployV2;
    if (!UUID.test(deploymentId ?? '')) {
      throw new Error('Railway did not return a deployment UUID.');
    }
    throwIfCancelled(cancellationSignal);

    const startedAt = now();
    if (!Number.isFinite(startedAt)) {
      throw new Error('The monotonic clock returned an invalid value.');
    }
    const deadline = startedAt + config.timeoutSeconds * 1_000;
    const pollMilliseconds = config.pollSeconds * 1_000;
    const maxPolls = Math.ceil((config.timeoutSeconds * 1_000) / pollMilliseconds) + 2;
    let evidence = null;
    let evidenceAccepted = false;
    let successfulMarkerObservations = 0;

    for (let poll = 0; poll < maxPolls && now() < deadline; poll += 1) {
      const deploymentData = await graphql(
        config.token,
        `
          query ArchiveAuditDeployment($id: String!) {
            deployment(id: $id) {
              id
              status
            }
          }
        `,
        { id: deploymentId },
        { ...graphqlDependencies, attempts: 3 },
      );
      const deployment = object(deploymentData?.deployment);
      if (deployment === null || deployment.id !== deploymentId) {
        throw new Error('Railway returned another deployment or an invalid deployment envelope.');
      }
      status = deployment.status;
      if (typeof status !== 'string') {
        throw new Error('Railway returned a deployment without a status.');
      }
      if (TERMINAL_FAILURES.has(status)) {
        if (status === 'FAILED' || status === 'CRASHED') {
          let refusalEvidence;
          try {
            refusalEvidence = await readDeploymentEvidence(
              config,
              deploymentId,
              graphqlDependencies,
            );
          } catch (logError) {
            throw new Error(
              `Archive audit deployment ended as ${status} and its refusal evidence could not be read.`,
              { cause: logError },
            );
          }
          if (refusalEvidence !== null && refusalEvidence.readyForActivation === false) {
            await persistEvidenceUnlessCancelled(
              config.outputPath,
              refusalEvidence,
              cancellationSignal,
            );
            stdout.write(
              JSON.stringify({
                deploymentId,
                status,
                outcome: 'REFUSED',
                issueCodes: refusalEvidence.issueCodes,
                evidencePath: config.outputPath,
              }) + '\n',
            );
            throw new ArchiveAuditBusinessRefusalError(deploymentId, refusalEvidence.issueCodes);
          }
        }
        throw new Error(`Archive audit deployment ended as ${status} without a valid refusal.`);
      }
      if (TERMINAL_SUCCESSES.has(status)) {
        const observed = await readDeploymentEvidence(config, deploymentId, graphqlDependencies);
        if (observed !== null) {
          if (observed.readyForActivation === false) {
            await persistEvidenceUnlessCancelled(
              config.outputPath,
              observed,
              cancellationSignal,
            );
            stdout.write(
              JSON.stringify({
                deploymentId,
                status,
                outcome: 'REFUSED',
                issueCodes: observed.issueCodes,
                evidencePath: config.outputPath,
              }) + '\n',
            );
            throw new ArchiveAuditBusinessRefusalError(deploymentId, observed.issueCodes);
          }
          evidence = observed;
          successfulMarkerObservations += 1;
          // COMPLETED is definitive. SUCCESS is also emitted while a process is still alive, so
          // observe the marker under SUCCESS twice to catch an immediate post-marker crash.
          if (status === 'COMPLETED' || successfulMarkerObservations >= 2) {
            evidenceAccepted = true;
            break;
          }
        } else {
          evidence = null;
          successfulMarkerObservations = 0;
        }
      } else if (TRANSIENT_STATUSES.has(status)) {
        evidence = null;
        successfulMarkerObservations = 0;
      } else {
        throw new Error(`Railway returned an unsupported archive audit status: ${status}.`);
      }
      if (!(await waitForNextPoll(
        (milliseconds) => sleepUntilOrCancellation(sleep, milliseconds, cancellationSignal),
        now,
        deadline,
        pollMilliseconds,
      ))) break;
    }

    if (!evidenceAccepted || evidence === null || !TERMINAL_SUCCESSES.has(status)) {
      throw new Error(
        'Archive audit deployment exceeded its bounded timeout without valid evidence.',
      );
    }

    await persistEvidenceUnlessCancelled(config.outputPath, evidence, cancellationSignal);
    throwIfCancelled(cancellationSignal);
    stdout.write(JSON.stringify({ deploymentId, status, evidencePath: config.outputPath }) + '\n');
    return evidence;
  } catch (error) {
    if (deploymentId !== null) {
      await cleanupDeploymentBestEffort(config, deploymentId, status, {
        ...graphqlDependencies,
        cancellationSignal: undefined,
      });
    }
    throw error;
  }
}

export async function runRailwayDocumentArchiveAuditCli({
  processObject = process,
  run = runRailwayDocumentArchiveAudit,
} = {}) {
  const cancellation = new AbortController();
  const requestCancellation = (signalName) => {
    if (!cancellation.signal.aborted) {
      cancellation.abort(new ArchiveAuditCancellationError(signalName));
    }
  };
  const onSigint = () => requestCancellation('SIGINT');
  const onSigterm = () => requestCancellation('SIGTERM');
  const onSighup = () => requestCancellation('SIGHUP');
  processObject.on('SIGHUP', onSighup);
  processObject.on('SIGINT', onSigint);
  processObject.on('SIGTERM', onSigterm);

  try {
    await run({ cancellationSignal: cancellation.signal });
    throwIfCancelled(cancellation.signal);
    return 0;
  } catch (error) {
    processObject.stderr.write(
      `${error instanceof Error ? error.message : 'Railway archive audit failed.'}\n`,
    );
    const exitCode =
      error instanceof ArchiveAuditCancellationError ? error.exitCode : 1;
    processObject.exitCode = exitCode;
    return exitCode;
  } finally {
    processObject.off('SIGHUP', onSighup);
    processObject.off('SIGINT', onSigint);
    processObject.off('SIGTERM', onSigterm);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runRailwayDocumentArchiveAuditCli();
}

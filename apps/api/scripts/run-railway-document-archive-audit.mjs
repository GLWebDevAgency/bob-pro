import { access, mkdir, rm, writeFile } from 'node:fs/promises';
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
const DEPLOYMENT_SNAPSHOT_PAGE_SIZE = 100;
const MAX_DEPLOYMENT_SNAPSHOT_PAGES = 20;
const AMBIGUOUS_RECONCILIATION_INTERVAL_MILLISECONDS = 10_000;
const MIN_AMBIGUOUS_RECONCILIATION_SNAPSHOTS = 7;
const MAX_AMBIGUOUS_RECONCILIATION_SNAPSHOTS = 8;
const REQUIRED_QUIESCENT_RECONCILIATION_SNAPSHOTS = 2;
const TERMINAL_SUCCESS_EVIDENCE_GRACE_MILLISECONDS = 60_000;
const TERMINAL_SUCCESS_CONFIRMATION_GRACE_MILLISECONDS = 60_000;
const TERMINAL_SUCCESS_CONFIRMATION_POLL_MILLISECONDS = 10_000;
const FAILURE_CLEANUP_GRACE_MILLISECONDS = 30_000;
const EXPECTED_RAILWAY_CONFIG_FILE = '/railway.archive-audit.json';
const EXPECTED_START_COMMAND = '/usr/local/bin/bob-archive-audit-entrypoint';
const EXPECTED_DOCKERFILE_PATH = 'Dockerfile.archive-audit';
const EXPECTED_DRAINING_SECONDS = 30;
const ACTIVE_DEPLOYMENT_STATUSES = new Set([
  'BUILDING',
  'DEPLOYING',
  'INITIALIZING',
  'NEEDS_APPROVAL',
  'QUEUED',
  'REMOVING',
  'SLEEPING',
  'WAITING',
]);
const DEPLOYMENT_STATUSES = new Set([
  ...ACTIVE_DEPLOYMENT_STATUSES,
  'CRASHED',
  'FAILED',
  'REMOVED',
  'SKIPPED',
  'SUCCESS',
]);
const NONTERMINAL_DEPLOYMENT_INSTANCE_STATUSES = new Set([
  'CREATED',
  'INITIALIZING',
  'RESTARTING',
  'RUNNING',
  'REMOVING',
]);
const DEPLOYMENT_INSTANCE_STATUSES = new Set([
  ...NONTERMINAL_DEPLOYMENT_INSTANCE_STATUSES,
  'CRASHED',
  'EXITED',
  'REMOVED',
  'SKIPPED',
  'STOPPED',
]);
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
const TERMINAL_SUCCESSES = new Set(['SUCCESS']);
const CLEANUP_NOT_NEEDED_STATUSES = new Set([
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

export class ArchiveAuditTerminalEvidenceError extends Error {
  constructor(kind) {
    const missing = kind === 'missing';
    super(
      missing
        ? 'Archive audit runtime became terminal without valid evidence within 60 seconds.'
        : 'Archive audit evidence did not remain identical across two bounded observations.',
    );
    this.name = 'ArchiveAuditTerminalEvidenceError';
    this.code = missing
      ? 'ARCHIVE_AUDIT_TERMINAL_EVIDENCE_MISSING'
      : 'ARCHIVE_AUDIT_TERMINAL_EVIDENCE_UNSTABLE';
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

class GraphqlDeadlineExceededError extends Error {
  constructor() {
    super('Railway GraphQL exceeded its absolute request deadline.');
    this.name = 'GraphqlDeadlineExceededError';
  }
}

function remainingDeadlineMilliseconds(now, deadline) {
  const observedAt = now();
  if (!Number.isFinite(observedAt)) {
    throw new Error('The monotonic clock returned an invalid value.');
  }
  const remaining = deadline - observedAt;
  if (remaining <= 0) throw new GraphqlDeadlineExceededError();
  return Math.max(1, Math.ceil(remaining));
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
  {
    attempts,
    cancellationSignal,
    deadline = null,
    fetchImpl,
    now = () => performance.now(),
    requestTimeoutSignal,
    sleep,
  },
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      throwIfCancelled(cancellationSignal);
      const requestTimeoutMilliseconds =
        deadline === null ? 30_000 : Math.min(30_000, remainingDeadlineMilliseconds(now, deadline));
      const response = await fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Project-Access-Token': token,
        },
        body: JSON.stringify({ query, variables }),
        redirect: 'error',
        signal: combinedRequestSignal(
          requestTimeoutSignal(requestTimeoutMilliseconds),
          cancellationSignal,
        ),
      });
      throwIfCancelled(cancellationSignal);
      if (deadline !== null) remainingDeadlineMilliseconds(now, deadline);
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
      if (deadline !== null) remainingDeadlineMilliseconds(now, deadline);
      return payload.data;
    } catch (error) {
      throwIfCancelled(cancellationSignal);
      if (error instanceof GraphqlDeadlineExceededError) throw error;
      if (deadline !== null) {
        remainingDeadlineMilliseconds(now, deadline);
      }
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
      const requestedBackoffMilliseconds = Math.max(
        backoffMilliseconds,
        error.retryAfterMilliseconds ?? 0,
      );
      const boundedBackoffMilliseconds =
        deadline === null
          ? requestedBackoffMilliseconds
          : Math.min(requestedBackoffMilliseconds, remainingDeadlineMilliseconds(now, deadline));
      await sleepUntilOrCancellation(sleep, boundedBackoffMilliseconds, cancellationSignal);
      if (deadline !== null) remainingDeadlineMilliseconds(now, deadline);
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

function certifyArchiveAuditServiceInstance(value, autoDeployValue, config) {
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
  // Schéma Railway moderne : l'enum Builder n'expose plus DOCKERFILE — un build Dockerfile
  // s'exprime par dockerfilePath posé sous le méta-builder RAILPACK. L'invariant réel
  // (« l'image vient de NOTRE Dockerfile épinglé ») reste porté par l'égalité stricte de
  // dockerfilePath, attestée juste en dessous.
  if (
    serviceInstance.builder !== 'DOCKERFILE' &&
    !(
      serviceInstance.builder === 'RAILPACK' &&
      serviceInstance.dockerfilePath === EXPECTED_DOCKERFILE_PATH
    )
  ) {
    violations.push(`builder=${String(serviceInstance.builder)}`);
  }
  if (serviceInstance.dockerfilePath !== EXPECTED_DOCKERFILE_PATH) {
    violations.push(`dockerfilePath=${String(serviceInstance.dockerfilePath)}`);
  }
  if (serviceInstance.preDeployCommand !== null) {
    violations.push('preDeployCommand=present');
  }
  if (serviceInstance.cronSchedule !== null) {
    violations.push('cronSchedule=present');
  }
  if (serviceInstance.sleepApplication !== false) {
    violations.push(`sleepApplication=${String(serviceInstance.sleepApplication)}`);
  }
  if (serviceInstance.healthcheckPath !== null) {
    violations.push(`healthcheckPath=${String(serviceInstance.healthcheckPath)}`);
  }
  if (serviceInstance.healthcheckTimeout !== null) {
    violations.push(`healthcheckTimeout=${String(serviceInstance.healthcheckTimeout)}`);
  }
  if (serviceInstance.numReplicas !== 1) {
    violations.push(`numReplicas=${String(serviceInstance.numReplicas)}`);
  }
  if (serviceInstance.drainingSeconds !== EXPECTED_DRAINING_SECONDS) {
    violations.push(`drainingSeconds=${String(serviceInstance.drainingSeconds)}`);
  }
  if (serviceInstance.overlapSeconds !== 0) {
    violations.push(`overlapSeconds=${String(serviceInstance.overlapSeconds)}`);
  }
  if (serviceInstance.restartPolicyType !== 'NEVER') {
    violations.push(`restartPolicyType=${String(serviceInstance.restartPolicyType)}`);
  }
  // Config-as-Code keeps this source field null with NEVER, while Railway's live GraphQL schema
  // exposes the resolved value as Int!. Accept that resolved non-negative integer, never null.
  if (
    !Number.isSafeInteger(serviceInstance.restartPolicyMaxRetries) ||
    serviceInstance.restartPolicyMaxRetries < 0
  ) {
    violations.push(`restartPolicyMaxRetries=${String(serviceInstance.restartPolicyMaxRetries)}`);
  }
  const autoDeployStatus = object(autoDeployValue);
  if (autoDeployStatus === null || autoDeployStatus.enabled !== false) {
    violations.push(`autoDeployEnabled=${String(autoDeployStatus?.enabled)}`);
  }
  if (violations.length > 0) {
    throw new Error(
      `Railway archive audit service configuration drifted: ${violations.join(', ')}.`,
    );
  }
}

function deploymentCommitHash(metaValue) {
  const meta = object(metaValue);
  const commitHash = meta?.commitHash;
  return typeof commitHash === 'string' && SHA.test(commitHash) ? commitHash : null;
}

function parseObservedDeployment(value, deploymentId) {
  const deployment = object(value);
  if (
    deployment === null ||
    deployment.id !== deploymentId ||
    typeof deployment.status !== 'string' ||
    typeof deployment.deploymentStopped !== 'boolean' ||
    !Array.isArray(deployment.instances)
  ) {
    throw new Error('Railway returned another deployment or an invalid deployment envelope.');
  }
  const instanceStatuses = deployment.instances.map((instanceValue) => {
    const instance = object(instanceValue);
    if (
      instance === null ||
      !UUID.test(instance.id ?? '') ||
      typeof instance.status !== 'string' ||
      !DEPLOYMENT_INSTANCE_STATUSES.has(instance.status)
    ) {
      throw new Error('Railway returned an invalid deployment instance envelope.');
    }
    return instance.status;
  });
  const hasNonterminalInstance = instanceStatuses.some((instanceStatus) =>
    NONTERMINAL_DEPLOYMENT_INSTANCE_STATUSES.has(instanceStatus),
  );
  return {
    status: deployment.status,
    deploymentStopped: deployment.deploymentStopped,
    runtimeState:
      instanceStatuses.length === 0
        ? 'unknown'
        : hasNonterminalInstance
          ? 'active'
          : 'terminal',
  };
}

function parseDeploymentSnapshotPage(value, config, projectId) {
  const connection = object(value);
  const pageInfo = object(connection?.pageInfo);
  if (
    connection === null ||
    !Array.isArray(connection.edges) ||
    pageInfo === null ||
    typeof pageInfo.hasNextPage !== 'boolean' ||
    !(
      pageInfo.endCursor === null ||
      (typeof pageInfo.endCursor === 'string' && pageInfo.endCursor.length > 0)
    ) ||
    (pageInfo.hasNextPage && pageInfo.endCursor === null)
  ) {
    throw new Error('Railway returned an invalid deployment snapshot envelope.');
  }

  const deployments = [];
  for (const edgeValue of connection.edges) {
    const edge = object(edgeValue);
    const deployment = object(edge?.node);
    if (
      deployment === null ||
      !UUID.test(deployment.id ?? '') ||
      deployment.projectId !== projectId ||
      deployment.serviceId !== config.serviceId ||
      deployment.environmentId !== config.environmentId ||
      typeof deployment.status !== 'string' ||
      !DEPLOYMENT_STATUSES.has(deployment.status) ||
      typeof deployment.deploymentStopped !== 'boolean' ||
      !Array.isArray(deployment.instances)
    ) {
      throw new Error('Railway returned an invalid or cross-scoped deployment snapshot.');
    }
    const instanceStatuses = deployment.instances.map((instanceValue) => {
      const instance = object(instanceValue);
      if (
        instance === null ||
        !UUID.test(instance.id ?? '') ||
        typeof instance.status !== 'string' ||
        !DEPLOYMENT_INSTANCE_STATUSES.has(instance.status)
      ) {
        throw new Error('Railway returned an invalid deployment instance snapshot.');
      }
      return instance.status;
    });
    const hasNonterminalInstance = instanceStatuses.some((status) =>
      NONTERMINAL_DEPLOYMENT_INSTANCE_STATUSES.has(status),
    );
    // Railway acquitte deploymentStop avant la fin de la fenêtre de drainage. Un déploiement
    // arrêté mais encore RUNNING/REMOVING n'est donc pas contradictoire : il reste non quiescent
    // et bloque la suite, sans autoriser une seconde mutation du control plane.
    const quiescent = deployment.deploymentStopped && !hasNonterminalInstance;
    deployments.push({
      id: deployment.id,
      status: deployment.status,
      commitHash: deploymentCommitHash(deployment.meta),
      deploymentStopped: deployment.deploymentStopped,
      active: !quiescent,
    });
  }

  return {
    deployments,
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor,
  };
}

async function readDeploymentSnapshot(config, projectId, graphqlDependencies) {
  const deployments = new Map();
  let after = null;
  for (let page = 0; page < MAX_DEPLOYMENT_SNAPSHOT_PAGES; page += 1) {
    const snapshotData = await graphql(
      config.token,
      `
        query ArchiveAuditDeploymentsSnapshot(
          $input: DeploymentListInput!
          $first: Int!
          $after: String
        ) {
          deployments(input: $input, first: $first, after: $after) {
            edges {
              node {
                id
                projectId
                serviceId
                environmentId
                status
                meta
                deploymentStopped
                instances {
                  id
                  status
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      {
        input: {
          projectId,
          serviceId: config.serviceId,
          environmentId: config.environmentId,
          includeDeleted: true,
        },
        first: DEPLOYMENT_SNAPSHOT_PAGE_SIZE,
        after,
      },
      { ...graphqlDependencies, attempts: 3 },
    );
    const parsed = parseDeploymentSnapshotPage(snapshotData?.deployments, config, projectId);
    for (const deployment of parsed.deployments) {
      if (deployments.has(deployment.id)) {
        throw new Error('Railway returned a duplicate deployment in its paginated snapshot.');
      }
      deployments.set(deployment.id, deployment);
    }
    if (!parsed.hasNextPage) return deployments;
    after = parsed.endCursor;
  }
  throw new Error('Railway deployment snapshot exceeded its bounded pagination limit.');
}

async function readDeploymentEvidence(
  config,
  deploymentId,
  graphqlDependencies,
  { attempts = 3, deadline = null } = {},
) {
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
    { ...graphqlDependencies, attempts, deadline },
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

async function assertEvidenceOutputDoesNotExist(outputPath) {
  try {
    await access(outputPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const error = new Error('Archive audit evidence output already exists.');
  error.code = 'EEXIST';
  throw error;
}

async function persistEvidenceUnlessCancelled(outputPath, evidence, cancellationSignal) {
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
  // Railway peut accepter deploymentStop sur un one-shot déjà marqué SUCCESS sans arrêter
  // l'instance encore RUNNING. deploymentCancel est l'opération qui converge réellement dans ce
  // cas ; le cleanup durable vérifiera ensuite deploymentStopped + l'absence d'instance active.
  const cancelFirst = new Set(['INITIALIZING', 'BUILDING', 'QUEUED', 'WAITING', 'SUCCESS']).has(
    status,
  );
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

function observeMonotonicStopAcknowledgement(deployment, stopAcknowledgedDeploymentIds, context) {
  if (stopAcknowledgedDeploymentIds.has(deployment.id) && !deployment.deploymentStopped) {
    throw new Error(
      `Railway ${context} observed deploymentStopped regress from true to false for ${deployment.id}.`,
    );
  }
  if (deployment.deploymentStopped) {
    stopAcknowledgedDeploymentIds.add(deployment.id);
  }
}

async function reconcileAmbiguousDeployment(
  config,
  projectId,
  snapshotBeforeMutation,
  graphqlDependencies,
) {
  const trackedDeployments = new Map();
  const cleanupAttempted = new Set();
  const foreignDeploymentIds = new Set();
  const stopAcknowledgedDeploymentIds = new Set();
  let quiescentSnapshots = 0;

  for (
    let snapshotIndex = 0;
    snapshotIndex < MAX_AMBIGUOUS_RECONCILIATION_SNAPSHOTS;
    snapshotIndex += 1
  ) {
    if (snapshotIndex > 0) {
      await sleepUntilOrCancellation(
        graphqlDependencies.sleep,
        AMBIGUOUS_RECONCILIATION_INTERVAL_MILLISECONDS,
        graphqlDependencies.cancellationSignal,
      );
    }
    const snapshotAfterMutation = await readDeploymentSnapshot(
      config,
      projectId,
      graphqlDependencies,
    );
    const presentTrackedDeploymentIds = new Set();
    let discoveredDeployment = false;

    for (const deployment of snapshotAfterMutation.values()) {
      if (snapshotBeforeMutation.has(deployment.id)) {
        continue;
      }
      observeMonotonicStopAcknowledgement(
        deployment,
        stopAcknowledgedDeploymentIds,
        'ambiguous reconciliation',
      );
      if (foreignDeploymentIds.has(deployment.id)) {
        if (deployment.active) {
          throw new Error(
            'Railway ambiguous deployment reconciliation found an active deployment from another release.',
          );
        }
        continue;
      }
      const alreadyTracked = trackedDeployments.has(deployment.id);
      if (deployment.commitHash !== null && deployment.commitHash !== config.releaseSha) {
        trackedDeployments.delete(deployment.id);
        foreignDeploymentIds.add(deployment.id);
        if (deployment.active) {
          throw new Error(
            'Railway ambiguous deployment reconciliation found an active deployment from another release.',
          );
        }
        continue;
      }
      if (!alreadyTracked) discoveredDeployment = true;
      trackedDeployments.set(deployment.id, deployment);
      presentTrackedDeploymentIds.add(deployment.id);
      if (
        deployment.active &&
        !deployment.deploymentStopped &&
        deployment.commitHash === config.releaseSha &&
        !cleanupAttempted.has(deployment.id)
      ) {
        cleanupAttempted.add(deployment.id);
        await cleanupDeploymentBestEffort(
          config,
          deployment.id,
          deployment.status,
          graphqlDependencies,
        );
      }
    }

    const unresolvedDeployment = [...trackedDeployments.values()].some(
      (deployment) => deployment.active || !presentTrackedDeploymentIds.has(deployment.id),
    );
    if (unresolvedDeployment) {
      quiescentSnapshots = 0;
    } else if (discoveredDeployment) {
      // La première observation quiescente compte. Une cible apparue à l'avant-dernier snapshot
      // doit encore être revue une fois ; une cible apparue au dernier ne peut jamais être admise.
      quiescentSnapshots = 1;
    } else {
      quiescentSnapshots += 1;
    }
    if (
      snapshotIndex + 1 >= MIN_AMBIGUOUS_RECONCILIATION_SNAPSHOTS &&
      quiescentSnapshots >= REQUIRED_QUIESCENT_RECONCILIATION_SNAPSHOTS
    ) {
      return cleanupAttempted.size;
    }
  }
  throw new Error(
    'Railway ambiguous deployment reconciliation did not converge to an inactive stable state.',
  );
}

async function preflightArchiveAuditService(config, graphqlDependencies) {
  // A token scope mismatch must be discovered before any mutation: acting first could target a
  // real service in another release lane before the runner fails closed.
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
      query ArchiveAuditServiceInstance(
        $projectId: String!
        $serviceId: String!
        $environmentId: String!
      ) {
        serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
          id
          serviceId
          environmentId
          railwayConfigFile
          startCommand
          builder
          dockerfilePath
          preDeployCommand
          cronSchedule
          sleepApplication
          healthcheckPath
          healthcheckTimeout
          numReplicas
          drainingSeconds
          overlapSeconds
          restartPolicyType
          restartPolicyMaxRetries
        }
        serviceInstanceAutoDeployStatus(
          projectId: $projectId
          serviceId: $serviceId
          environmentId: $environmentId
        ) {
          enabled
        }
      }
    `,
    { projectId, serviceId: config.serviceId, environmentId: config.environmentId },
    { ...graphqlDependencies, attempts: 3 },
  );
  certifyArchiveAuditServiceInstance(
    serviceInstanceData?.serviceInstance,
    serviceInstanceData?.serviceInstanceAutoDeployStatus,
    config,
  );
  return projectId;
}

export async function cleanupRailwayDocumentArchiveAuditDeployments({
  cancellationSignal,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  requestTimeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  stdout = process.stdout,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');
  if (typeof sleep !== 'function') throw new Error('A sleep implementation is required.');
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
  const projectId = await preflightArchiveAuditService(config, graphqlDependencies);
  const trackedDeploymentIds = new Set();
  const cleanupAttempted = new Set();
  const stopAcknowledgedDeploymentIds = new Set();
  let quiescentSnapshots = 0;

  for (
    let snapshotIndex = 0;
    snapshotIndex < MAX_AMBIGUOUS_RECONCILIATION_SNAPSHOTS;
    snapshotIndex += 1
  ) {
    if (snapshotIndex > 0) {
      await sleepUntilOrCancellation(
        sleep,
        AMBIGUOUS_RECONCILIATION_INTERVAL_MILLISECONDS,
        cancellationSignal,
      );
    }
    const snapshot = await readDeploymentSnapshot(config, projectId, graphqlDependencies);
    const activeDeployments = [...snapshot.values()].filter((deployment) => deployment.active);
    const unrelatedActiveDeployments = activeDeployments.filter(
      (deployment) => deployment.commitHash !== null && deployment.commitHash !== config.releaseSha,
    );
    if (unrelatedActiveDeployments.length > 0) {
      throw new Error(
        `Railway archive audit cleanup found ${unrelatedActiveDeployments.length} active deployment(s) from another release.`,
      );
    }
    const unidentifiedActiveDeployments = activeDeployments.filter(
      (deployment) => deployment.commitHash === null,
    );
    const correlatedActiveDeployments = activeDeployments.filter(
      (deployment) => deployment.commitHash === config.releaseSha,
    );
    const correlatedDeployments = [...snapshot.values()].filter(
      (deployment) => deployment.commitHash === config.releaseSha,
    );
    let discoveredCorrelatedDeployment = false;

    for (const deployment of snapshot.values()) {
      if (
        deployment.commitHash === null ||
        deployment.commitHash === config.releaseSha ||
        trackedDeploymentIds.has(deployment.id)
      ) {
        observeMonotonicStopAcknowledgement(
          deployment,
          stopAcknowledgedDeploymentIds,
          'archive audit cleanup',
        );
      }
    }

    for (const deployment of correlatedDeployments) {
      if (!trackedDeploymentIds.has(deployment.id)) {
        trackedDeploymentIds.add(deployment.id);
        discoveredCorrelatedDeployment = true;
      }
    }

    for (const deployment of correlatedActiveDeployments) {
      if (deployment.deploymentStopped) continue;
      if (cleanupAttempted.has(deployment.id)) continue;
      cleanupAttempted.add(deployment.id);
      await cleanupDeploymentBestEffort(
        config,
        deployment.id,
        deployment.status,
        graphqlDependencies,
      );
    }

    const trackedDeploymentIsUnresolved = [...trackedDeploymentIds].some((deploymentId) => {
      const deployment = snapshot.get(deploymentId);
      return deployment === undefined || deployment.active;
    });
    if (trackedDeploymentIsUnresolved || unidentifiedActiveDeployments.length > 0) {
      quiescentSnapshots = 0;
    } else if (discoveredCorrelatedDeployment) {
      quiescentSnapshots = 1;
    } else {
      quiescentSnapshots += 1;
    }
    if (
      // Le cleanup durable consomme toujours la fenêtre entière : rendre la main au septième
      // snapshot laisserait un déploiement corrélé propagé au huitième hors de toute observation.
      snapshotIndex + 1 >= MAX_AMBIGUOUS_RECONCILIATION_SNAPSHOTS &&
      quiescentSnapshots >= REQUIRED_QUIESCENT_RECONCILIATION_SNAPSHOTS
    ) {
      const result = { cleanedDeploymentCount: cleanupAttempted.size };
      stdout.write(JSON.stringify(result) + '\n');
      return result;
    }
  }

  throw new Error('Railway archive audit cleanup did not converge to an inactive stable state.');
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
  await assertEvidenceOutputDoesNotExist(config.outputPath);
  const graphqlDependencies = {
    cancellationSignal,
    fetchImpl,
    now,
    requestTimeoutSignal,
    sleep,
  };

  const projectId = await preflightArchiveAuditService(config, graphqlDependencies);

  const snapshotBeforeMutation = await readDeploymentSnapshot(
    config,
    projectId,
    graphqlDependencies,
  );
  const activeDeploymentCount = [...snapshotBeforeMutation.values()].filter(
    (deployment) => deployment.active,
  ).length;
  if (activeDeploymentCount > 0) {
    throw new Error(
      `Railway archive audit service already has ${activeDeploymentCount} active deployment(s).`,
    );
  }

  throwIfCancelled(cancellationSignal);
  let deploymentId = null;
  let status = 'INITIALIZING';
  try {
    // This mutation is deliberately never retried. Once started, it is not aborted on a process
    // signal: preserving its response is the only way to obtain the deployment id and stop the
    // remote job. Cancellation is observed immediately before the request, then after any
    // mandatory ambiguous-response reconciliation so a signal never abandons an unknown job.
    let deployData;
    let deployError = null;
    try {
      deployData = await graphql(
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
    } catch (error) {
      deployError = error;
    }
    const returnedDeploymentId = deployData?.serviceInstanceDeployV2;
    const returnedIdIsFresh =
      UUID.test(returnedDeploymentId ?? '') && !snapshotBeforeMutation.has(returnedDeploymentId);
    if (deployError !== null || !returnedIdIsFresh) {
      let reconciledDeploymentCount;
      let reconciliationError = null;
      try {
        reconciledDeploymentCount = await reconcileAmbiguousDeployment(
          config,
          projectId,
          snapshotBeforeMutation,
          { ...graphqlDependencies, cancellationSignal: undefined },
        );
      } catch (error) {
        reconciliationError = error;
      }
      // A process signal wins only after the non-cancellable remote reconciliation has attempted
      // to discover and stop every deployment that the lost mutation response may have created.
      throwIfCancelled(cancellationSignal);
      if (reconciliationError !== null) {
        throw new Error(
          'Railway deployment creation was ambiguous and its remote reconciliation failed.',
          {
            cause: new AggregateError(
              [deployError, reconciliationError].filter((error) => error !== null),
            ),
          },
        );
      }
      throw new Error(
        `Railway deployment creation was ambiguous; cleanup was attempted for ${reconciledDeploymentCount} correlated deployment(s).`,
        {
          cause:
            deployError ??
            new Error('Railway returned an invalid or previously existing deployment UUID.'),
        },
      );
    }
    deploymentId = returnedDeploymentId;
    throwIfCancelled(cancellationSignal);

    const startedAt = now();
    if (!Number.isFinite(startedAt)) {
      throw new Error('The monotonic clock returned an invalid value.');
    }
    const deadline = startedAt + config.timeoutSeconds * 1_000;
    const pollMilliseconds = config.pollSeconds * 1_000;
    const maxPolls =
      Math.ceil(
        (config.timeoutSeconds * 1_000) /
          Math.min(pollMilliseconds, TERMINAL_SUCCESS_CONFIRMATION_POLL_MILLISECONDS),
      ) + 2;
    let evidence = null;
    let evidenceAccepted = false;
    let successfulMarkerObservations = 0;
    let terminalSuccessDeadline = null;
    let terminalConfirmationDeadline = null;
    let firstReadyEvidenceCanonical = null;
    let deploymentSuccessObserved = false;

    const terminalEvidenceError = () =>
      new ArchiveAuditTerminalEvidenceError(
        firstReadyEvidenceCanonical === null ? 'missing' : 'unstable',
      );

    for (let poll = 0; poll < maxPolls && now() < deadline; poll += 1) {
      const activeTerminalDeadline = terminalConfirmationDeadline ?? terminalSuccessDeadline;
      let deploymentData;
      try {
        deploymentData = await graphql(
          config.token,
          `
            query ArchiveAuditDeployment($id: String!) {
              deployment(id: $id) {
                id
                status
                deploymentStopped
                instances {
                  id
                  status
                }
              }
            }
          `,
          { id: deploymentId },
          {
            ...graphqlDependencies,
            attempts: 3,
            deadline: activeTerminalDeadline ?? deadline,
          },
        );
      } catch (error) {
        if (error instanceof GraphqlDeadlineExceededError) {
          if (activeTerminalDeadline !== null) throw terminalEvidenceError();
          throw new Error(
            'Archive audit deployment exceeded its bounded timeout without valid evidence.',
          );
        }
        throw error;
      }
      const deployment = parseObservedDeployment(deploymentData?.deployment, deploymentId);
      status = deployment.status;
      const statusObservedAt = now();
      if (!Number.isFinite(statusObservedAt)) {
        throw new Error('The monotonic clock returned an invalid value.');
      }
      if (TERMINAL_FAILURES.has(status)) {
        if ((status === 'FAILED' || status === 'CRASHED') && firstReadyEvidenceCanonical === null) {
          let refusalEvidence;
          try {
            refusalEvidence = await readDeploymentEvidence(
              config,
              deploymentId,
              graphqlDependencies,
              {
                deadline: terminalSuccessDeadline ?? deadline,
              },
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
        if (terminalSuccessDeadline !== null) {
          throw new Error(`Railway archive audit ended as ${status} after SUCCESS.`);
        }
        throw new Error(`Archive audit deployment ended as ${status} without a valid refusal.`);
      }
      if (TERMINAL_SUCCESSES.has(status)) {
        deploymentSuccessObserved = true;
        if (deployment.runtimeState === 'terminal') {
          terminalSuccessDeadline ??= Math.min(
            deadline,
            statusObservedAt + TERMINAL_SUCCESS_EVIDENCE_GRACE_MILLISECONDS,
          );
        } else if (terminalSuccessDeadline !== null) {
          throw new Error('Railway archive audit runtime regressed after terminal observation.');
        }
        let observed;
        try {
          observed = await readDeploymentEvidence(config, deploymentId, graphqlDependencies, {
            deadline: terminalConfirmationDeadline ?? terminalSuccessDeadline ?? deadline,
          });
        } catch (error) {
          if (error instanceof GraphqlDeadlineExceededError) {
            if (terminalConfirmationDeadline !== null || terminalSuccessDeadline !== null) {
              throw terminalEvidenceError();
            }
            throw new Error(
              'Archive audit deployment exceeded its bounded timeout without valid evidence.',
            );
          }
          throw error;
        }
        if (observed !== null) {
          if (observed.readyForActivation === false) {
            await persistEvidenceUnlessCancelled(config.outputPath, observed, cancellationSignal);
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
          const observedCanonical = JSON.stringify(observed);
          if (firstReadyEvidenceCanonical === null) {
            const firstMarkerObservedAt = now();
            if (!Number.isFinite(firstMarkerObservedAt)) {
              throw new Error('The monotonic clock returned an invalid value.');
            }
            firstReadyEvidenceCanonical = observedCanonical;
            evidence = observed;
            successfulMarkerObservations = 1;
            terminalConfirmationDeadline = Math.min(
              deadline,
              firstMarkerObservedAt + TERMINAL_SUCCESS_CONFIRMATION_GRACE_MILLISECONDS,
            );
          } else {
            if (observedCanonical !== firstReadyEvidenceCanonical) {
              throw new ArchiveAuditTerminalEvidenceError('unstable');
            }
            evidence = observed;
            successfulMarkerObservations += 1;
          }
          // Railway exposes SUCCESS while the process can still be draining. Observe the marker
          // twice and require the exact same envelope before accepting the one-shot result.
          if (successfulMarkerObservations >= 2) {
            evidenceAccepted = true;
            break;
          }
        } else {
          if (firstReadyEvidenceCanonical !== null) {
            throw new ArchiveAuditTerminalEvidenceError('unstable');
          }
          evidence = null;
          successfulMarkerObservations = 0;
        }
        const terminalPhaseDeadline = terminalConfirmationDeadline ?? terminalSuccessDeadline;
        if (terminalPhaseDeadline !== null && now() >= terminalPhaseDeadline) {
          throw terminalEvidenceError();
        }
      } else if (TRANSIENT_STATUSES.has(status)) {
        if (deploymentSuccessObserved) {
          throw new Error('Railway archive audit status regressed after SUCCESS.');
        }
        evidence = null;
        successfulMarkerObservations = 0;
      } else {
        throw new Error(`Railway returned an unsupported archive audit status: ${status}.`);
      }
      if (
        !(await waitForNextPoll(
          (milliseconds) => sleepUntilOrCancellation(sleep, milliseconds, cancellationSignal),
          now,
          terminalConfirmationDeadline ?? terminalSuccessDeadline ?? deadline,
          deploymentSuccessObserved
            ? TERMINAL_SUCCESS_CONFIRMATION_POLL_MILLISECONDS
            : pollMilliseconds,
        ))
      )
        break;
    }

    if (!evidenceAccepted || evidence === null || !TERMINAL_SUCCESSES.has(status)) {
      if (terminalSuccessDeadline !== null) {
        throw terminalEvidenceError();
      }
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
      const cleanupStartedAt = now();
      const cleanupDeadline = Number.isFinite(cleanupStartedAt)
        ? cleanupStartedAt + FAILURE_CLEANUP_GRACE_MILLISECONDS
        : 0;
      await cleanupDeploymentBestEffort(config, deploymentId, status, {
        ...graphqlDependencies,
        cancellationSignal: undefined,
        deadline: cleanupDeadline,
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
    const exitCode = error instanceof ArchiveAuditCancellationError ? error.exitCode : 1;
    processObject.exitCode = exitCode;
    return exitCode;
  } finally {
    processObject.off('SIGHUP', onSighup);
    processObject.off('SIGINT', onSigint);
    processObject.off('SIGTERM', onSigterm);
  }
}

export async function runRailwayDocumentArchiveAuditCommand({
  argv = process.argv.slice(2),
  runCli = runRailwayDocumentArchiveAuditCli,
  auditRun = runRailwayDocumentArchiveAudit,
  cleanupRun = cleanupRailwayDocumentArchiveAuditDeployments,
} = {}) {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== 'string')) {
    throw new Error('Archive audit command arguments must be strings.');
  }
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--cleanup-only')) {
    throw new Error('Unknown archive audit command argument.');
  }
  return runCli({ run: argv[0] === '--cleanup-only' ? cleanupRun : auditRun });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runRailwayDocumentArchiveAuditCommand();
}

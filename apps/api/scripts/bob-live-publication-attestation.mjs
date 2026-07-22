import { constants as fsConstants } from 'node:fs';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  BOB_LIVE_LOAD_CONTRACT_VERSION,
  BOB_LIVE_LOAD_PROFILES,
  deriveBobLivePublicationCandidateProjection,
} from './bob-live-load-contract.mjs';

export const BOB_LIVE_PUBLICATION_ATTESTATION_VERSION = 'bob-live-c3-publication-v1';
export const BOB_LIVE_PUBLICATION_CONFIRMATION = 'SIGN-BOB-LIVE-C3-CAPACITY-CERTIFICATE';
export const BOB_LIVE_EVIDENCE_ENVELOPE_VERSION = 'bob-live-c3-evidence-dsse-v1';

const SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const WORKFLOW_REF = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml@refs\/heads\/[A-Za-z0-9._/-]+$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const AUTHORITIES = new WeakSet();
const VERIFIED_CERTIFICATES = new WeakSet();
const VERIFIED_CANDIDATES = new WeakSet();

const EVIDENCE_PAYLOAD_TYPES = Object.freeze({
  run: 'application/vnd.bob.live.capacity.run-verdict.v1+json',
  prerequisites: 'application/vnd.bob.live.capacity.prerequisites.v1+json',
  monitoring: 'application/vnd.bob.live.capacity.monitoring.v1+json',
});

function fail(message) {
  throw new Error(`bob-live-publication:${message}`);
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.trim() === '') fail(`${name} is required`);
  if (value !== value.trim()) fail(`${name} must not contain surrounding whitespace`);
  return value;
}

function exactRecord(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value);
  const unknown = actual.find((key) => !keys.includes(key));
  const missing = keys.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (unknown !== undefined) fail(`${label} contains unknown field ${unknown}`);
  if (missing !== undefined) fail(`${label} is missing field ${missing}`);
  return value;
}

function safeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid`);
  return value;
}

function canonicalJson(value, label = 'signed evidence') {
  function normalize(entry) {
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'string') return entry;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) fail(`${label} contains a non-finite number`);
      return entry;
    }
    if (Array.isArray(entry)) return entry.map(normalize);
    if (typeof entry !== 'object' || Object.getPrototypeOf(entry) !== Object.prototype) {
      fail(`${label} is not canonical JSON`);
    }
    return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]));
  }
  return JSON.stringify(normalize(value));
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function dssePreAuthenticationEncoding(payloadType, payloadBytes) {
  const type = Buffer.from(payloadType, 'utf8');
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, 'utf8'),
    type,
    Buffer.from(` ${payloadBytes.length} `, 'utf8'),
    payloadBytes,
  ]);
}

/** Encode the exact protected-workflow evidence body before creating a DSSE envelope. */
export function encodeBobLiveEvidencePayload(payloadInput) {
  const payload = exactRecord(payloadInput, [
    'version',
    'kind',
    'repository',
    'workflowRef',
    'workflowSha',
    'workflowRunId',
    'environment',
    'issuedAt',
    'subject',
  ], 'evidence payload');
  if (payload.version !== BOB_LIVE_EVIDENCE_ENVELOPE_VERSION) fail('evidence payload version mismatch');
  if (!Object.hasOwn(EVIDENCE_PAYLOAD_TYPES, payload.kind)) fail('evidence payload kind is invalid');
  return Buffer.from(canonicalJson(payload, 'evidence payload'), 'utf8').toString('base64');
}

/** Return the standard DSSE PAE bytes signed by the protected capacity workflow. */
export function bobLiveEvidenceEnvelopeSigningPayload(payloadType, encodedPayload) {
  if (!Object.values(EVIDENCE_PAYLOAD_TYPES).includes(payloadType)) fail('evidence payloadType is invalid');
  if (typeof encodedPayload !== 'string' || encodedPayload.length === 0 || encodedPayload.length > 24 * 1024 * 1024) {
    fail('evidence payload encoding is invalid');
  }
  let payloadBytes;
  try {
    payloadBytes = Buffer.from(encodedPayload, 'base64');
  } catch {
    fail('evidence payload encoding is invalid');
  }
  if (payloadBytes.length === 0 || payloadBytes.toString('base64') !== encodedPayload) {
    fail('evidence payload encoding is non-canonical');
  }
  return dssePreAuthenticationEncoding(payloadType, payloadBytes);
}

function instant(value, label) {
  if (typeof value !== 'string' || value.length > 40 || value.trim() !== value) fail(`${label} is invalid`);
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) fail(`${label} is invalid`);
  return { value: new Date(epochMs).toISOString(), epochMs };
}

async function loadEd25519PublicKey(path) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const [metadata, canonicalPath] = await Promise.all([handle.stat(), realpath(path)]);
    if (!metadata.isFile() || metadata.size < 32 || metadata.size > 16 * 1024) {
      fail('attestation public key must be a bounded regular file');
    }
    if (canonicalPath !== path) fail('attestation public key path must not traverse symbolic links');
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      fail('attestation public key must belong to the current user');
    }
    if (process.platform !== 'win32' && (metadata.mode & 0o022) !== 0) {
      fail('attestation public key must not be group/world writable');
    }
    const key = createPublicKey(await handle.readFile('utf8'));
    if (key.asymmetricKeyType !== 'ed25519') fail('attestation public key must be Ed25519');
    return {
      key,
      fingerprint: digest(key.export({ type: 'spki', format: 'der' })),
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('bob-live-publication:')) throw error;
    fail('attestation public key cannot be opened securely');
  } finally {
    await handle?.close();
  }
}

async function loadTrustRoot(environment, role, prefix) {
  const keyId = required(environment, `${prefix}_SIGNER_KEY_ID`);
  if (!KEY_ID.test(keyId)) fail(`${prefix}_SIGNER_KEY_ID is invalid`);
  const publicKeyPathRaw = required(environment, `${prefix}_PUBLIC_KEY_PATH`);
  if (!isAbsolute(publicKeyPathRaw)) fail(`${prefix}_PUBLIC_KEY_PATH must be absolute`);
  const publicKeyPath = resolve(publicKeyPathRaw);
  const expectedFingerprint = required(environment, `${prefix}_PUBLIC_KEY_SHA256`);
  if (!SHA256.test(expectedFingerprint)) fail(`${prefix}_PUBLIC_KEY_SHA256 is invalid`);
  const { key: publicKey, fingerprint } = await loadEd25519PublicKey(publicKeyPath);
  if (fingerprint !== expectedFingerprint) fail(`${role} public key fingerprint mismatch`);
  const workflowRef = required(environment, `${prefix}_WORKFLOW_REF`);
  if (!WORKFLOW_REF.test(workflowRef)) fail(`${prefix}_WORKFLOW_REF is invalid`);
  const workflowSha = required(environment, `${prefix}_WORKFLOW_SHA`);
  if (!SHA.test(workflowSha)) fail(`${prefix}_WORKFLOW_SHA must be a full lowercase SHA`);
  return Object.freeze({
    role,
    keyId,
    publicKeyPath,
    publicKey,
    publicKeyFingerprint: fingerprint,
    workflowRef,
    workflowSha,
  });
}

/** Load the immutable trust policy used by the protected publication workflow. */
export async function loadBobLivePublicationAuthority(environment = process.env) {
  if (required(environment, 'BOB_LIVE_PUBLICATION_CONFIRM') !== BOB_LIVE_PUBLICATION_CONFIRMATION) {
    fail(`BOB_LIVE_PUBLICATION_CONFIRM must equal ${BOB_LIVE_PUBLICATION_CONFIRMATION}`);
  }
  const profileId = required(environment, 'BOB_LIVE_PUBLICATION_PROFILE');
  if (!BOB_LIVE_LOAD_PROFILES[profileId]) fail('BOB_LIVE_PUBLICATION_PROFILE is invalid');
  const releaseSha = required(environment, 'BOB_LIVE_PUBLICATION_EXPECTED_SHA');
  if (!SHA.test(releaseSha)) fail('BOB_LIVE_PUBLICATION_EXPECTED_SHA must be a full lowercase SHA');
  const repository = required(environment, 'BOB_LIVE_PUBLICATION_REPOSITORY');
  if (!REPOSITORY.test(repository)) fail('BOB_LIVE_PUBLICATION_REPOSITORY is invalid');
  const [run, prerequisites, monitoring, publication] = await Promise.all([
    loadTrustRoot(environment, 'run', 'BOB_LIVE_PUBLICATION_RUN'),
    loadTrustRoot(environment, 'prerequisites', 'BOB_LIVE_PUBLICATION_PREREQUISITES'),
    loadTrustRoot(environment, 'monitoring', 'BOB_LIVE_PUBLICATION_MONITORING'),
    loadTrustRoot(environment, 'publication', 'BOB_LIVE_PUBLICATION'),
  ]);
  const fingerprints = new Set([
    run.publicKeyFingerprint,
    prerequisites.publicKeyFingerprint,
    monitoring.publicKeyFingerprint,
    publication.publicKeyFingerprint,
  ]);
  if (fingerprints.size !== 4) fail('publication trust roots must use four distinct public keys');
  const authority = Object.freeze({
    profileId,
    releaseSha,
    repository,
    environment: 'capacity-certification',
    trustRoots: Object.freeze({ run, prerequisites, monitoring, publication }),
  });
  AUTHORITIES.add(authority);
  return authority;
}

function verifyEvidenceEnvelope(authority, envelopeInput, expectedKind, now) {
  const trustRoot = authority.trustRoots[expectedKind];
  if (trustRoot === undefined) fail(`${expectedKind} evidence trust root is missing`);
  const envelope = exactRecord(envelopeInput, ['payloadType', 'payload', 'signatures'], `${expectedKind} DSSE envelope`);
  const expectedPayloadType = EVIDENCE_PAYLOAD_TYPES[expectedKind];
  if (envelope.payloadType !== expectedPayloadType) fail(`${expectedKind} evidence payloadType mismatch`);
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) {
    fail(`${expectedKind} evidence requires exactly one signature`);
  }
  const signatureEntry = exactRecord(envelope.signatures[0], ['keyid', 'sig'], `${expectedKind} DSSE signature`);
  if (signatureEntry.keyid !== trustRoot.keyId) fail(`${expectedKind} evidence signer mismatch`);
  if (typeof signatureEntry.sig !== 'string' || !BASE64URL.test(signatureEntry.sig)) {
    fail(`${expectedKind} evidence signature encoding is invalid`);
  }
  const signingPayload = bobLiveEvidenceEnvelopeSigningPayload(envelope.payloadType, envelope.payload);
  const signature = Buffer.from(signatureEntry.sig, 'base64url');
  if (signature.length !== 64 || !verifySignature(null, signingPayload, trustRoot.publicKey, signature)) {
    fail(`${expectedKind} evidence signature is invalid`);
  }
  const payloadBytes = Buffer.from(envelope.payload, 'base64');
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    fail(`${expectedKind} evidence payload is invalid JSON`);
  }
  if (Buffer.from(canonicalJson(payload), 'utf8').compare(payloadBytes) !== 0) {
    fail(`${expectedKind} evidence payload is not canonical`);
  }
  payload = exactRecord(payload, [
    'version',
    'kind',
    'repository',
    'workflowRef',
    'workflowSha',
    'workflowRunId',
    'environment',
    'issuedAt',
    'subject',
  ], `${expectedKind} evidence payload`);
  if (payload.version !== BOB_LIVE_EVIDENCE_ENVELOPE_VERSION || payload.kind !== expectedKind) {
    fail(`${expectedKind} evidence version or kind mismatch`);
  }
  if (
    payload.repository !== authority.repository
    || payload.workflowRef !== trustRoot.workflowRef
    || payload.workflowSha !== trustRoot.workflowSha
    || payload.environment !== authority.environment
    || !/^\d{1,20}$/u.test(payload.workflowRunId)
  ) fail(`${expectedKind} evidence workflow identity mismatch`);
  const issuedAt = instant(payload.issuedAt, `${expectedKind} evidence issuedAt`);
  if (issuedAt.epochMs > now + 5 * 60_000) fail(`${expectedKind} evidence is issued in the future`);
  return {
    subject: payload.subject,
    issuedAt,
    envelopeDigest: digest(signingPayload),
  };
}

function validateSignedRun(authority, envelope, expectedPass, expectedAttempt, now) {
  const verified = verifyEvidenceEnvelope(authority, envelope, 'run', now);
  const run = exactRecord(verified.subject, [
    'contractVersion',
    'runId',
    'preflightDigest',
    'rawEvidenceSha256',
    'topologyDigest',
    'profileId',
    'releaseSha',
    'pass',
    'runKind',
    'attempt',
    'startedAt',
    'completedAt',
    'runPassed',
  ], `${expectedPass} run evidence`);
  if (
    run.contractVersion !== BOB_LIVE_LOAD_CONTRACT_VERSION
    || run.profileId !== authority.profileId
    || run.releaseSha !== authority.releaseSha
    || run.pass !== expectedPass
    || run.runKind !== 'certification'
    || run.attempt !== expectedAttempt
    || run.runPassed !== true
  ) fail(`${expectedPass} run ${expectedAttempt} is ineligible`);
  if (
    !UUID.test(run.runId)
    || !SHA256.test(run.preflightDigest)
    || !SHA256.test(run.rawEvidenceSha256)
    || !SHA256.test(run.topologyDigest)
  ) fail(`${expectedPass} run ${expectedAttempt} identity is invalid`);
  const startedAt = instant(run.startedAt, `${expectedPass} run ${expectedAttempt} startedAt`);
  const completedAt = instant(run.completedAt, `${expectedPass} run ${expectedAttempt} completedAt`);
  if (
    completedAt.epochMs < startedAt.epochMs
    || completedAt.epochMs > now + 30_000
    || verified.issuedAt.epochMs < completedAt.epochMs
    || verified.issuedAt.epochMs > completedAt.epochMs + 24 * 60 * 60_000
  ) fail(`${expectedPass} run ${expectedAttempt} time binding is invalid`);
  return { run, completedAt, envelopeDigest: verified.envelopeDigest };
}

function validateSignedPrerequisites(authority, envelope, now) {
  const verified = verifyEvidenceEnvelope(authority, envelope, 'prerequisites', now);
  const prerequisites = exactRecord(verified.subject, [
    'contractVersion',
    'profileId',
    'releaseSha',
    'c1CertificateDigest',
    'c2CertificateDigest',
    'providerChanged',
    'c4CertificateDigest',
  ], 'signed prerequisites');
  if (
    prerequisites.contractVersion !== BOB_LIVE_LOAD_CONTRACT_VERSION
    || prerequisites.profileId !== authority.profileId
    || prerequisites.releaseSha !== authority.releaseSha
    || !SHA256.test(prerequisites.c1CertificateDigest)
    || !SHA256.test(prerequisites.c2CertificateDigest)
    || typeof prerequisites.providerChanged !== 'boolean'
  ) fail('signed prerequisites are not eligible');
  if (
    (prerequisites.providerChanged && !SHA256.test(prerequisites.c4CertificateDigest))
    || (!prerequisites.providerChanged && prerequisites.c4CertificateDigest !== null)
  ) fail('signed C4 prerequisite does not match provider change');
  return { prerequisites, envelopeDigest: verified.envelopeDigest };
}

function validateSignedMonitoring(authority, envelope, lastRunCompletedAt, topologyDigest, now) {
  const verified = verifyEvidenceEnvelope(authority, envelope, 'monitoring', now);
  const monitoring = exactRecord(verified.subject, [
    'contractVersion',
    'profileId',
    'releaseSha',
    'topologyDigest',
    'startedAt',
    'completedAt',
    'sampleIntervalSeconds',
    'samples',
  ], 'signed monitoring');
  if (
    monitoring.contractVersion !== BOB_LIVE_LOAD_CONTRACT_VERSION
    || monitoring.profileId !== authority.profileId
    || monitoring.releaseSha !== authority.releaseSha
    || monitoring.topologyDigest !== topologyDigest
  ) fail('signed monitoring identity mismatch');
  const startedAt = instant(monitoring.startedAt, 'signed monitoring startedAt');
  const completedAt = instant(monitoring.completedAt, 'signed monitoring completedAt');
  const sevenDaysMs = 7 * 24 * 60 * 60_000;
  const interval = safeCount(monitoring.sampleIntervalSeconds, 'signed monitoring sample interval');
  if (
    interval !== 300
    || startedAt.epochMs < lastRunCompletedAt
    || completedAt.epochMs - startedAt.epochMs < sevenDaysMs
    || completedAt.epochMs > now + 30_000
    || verified.issuedAt.epochMs < completedAt.epochMs
    || verified.issuedAt.epochMs > completedAt.epochMs + 24 * 60 * 60_000
  ) fail('signed monitoring window is invalid');
  if (!Array.isArray(monitoring.samples)) fail('signed monitoring samples must be an array');
  const requiredSamples = Math.floor((completedAt.epochMs - startedAt.epochMs) / (interval * 1_000)) + 1;
  if (monitoring.samples.length < requiredSamples) fail('signed monitoring coverage is incomplete');
  let previousObservedAt = null;
  let sloViolationCount = 0;
  let securityIncidentCount = 0;
  let unresolvedAlertCount = 0;
  monitoring.samples.forEach((entry, index) => {
    const sample = exactRecord(entry, [
      'observedAt',
      'sloViolationCount',
      'securityIncidentCount',
      'unresolvedAlertCount',
    ], `signed monitoring sample ${index}`);
    const observedAt = instant(sample.observedAt, `signed monitoring sample ${index} observedAt`).epochMs;
    if (
      observedAt < startedAt.epochMs
      || observedAt > completedAt.epochMs
      || (previousObservedAt !== null && (
        observedAt <= previousObservedAt || observedAt - previousObservedAt > interval * 1_100
      ))
    ) fail('signed monitoring contains an invalid temporal gap');
    previousObservedAt = observedAt;
    sloViolationCount += safeCount(sample.sloViolationCount, `signed monitoring sample ${index} SLO violations`);
    securityIncidentCount += safeCount(sample.securityIncidentCount, `signed monitoring sample ${index} incidents`);
    unresolvedAlertCount += safeCount(sample.unresolvedAlertCount, `signed monitoring sample ${index} alerts`);
  });
  const firstObservedAt = Date.parse(monitoring.samples[0]?.observedAt ?? '');
  if (
    !Number.isFinite(firstObservedAt)
    || firstObservedAt > startedAt.epochMs + interval * 1_000
    || previousObservedAt < completedAt.epochMs - interval * 1_000
  ) fail('signed monitoring does not cover both boundaries');
  return {
    monitoring,
    startedAt,
    completedAt,
    sloViolationCount,
    securityIncidentCount,
    unresolvedAlertCount,
    evidenceDigest: digest(canonicalJson(monitoring.samples, 'monitoring samples')),
    envelopeDigest: verified.envelopeDigest,
  };
}

/**
 * Verify every source attestation and derive a candidate. Plain JavaScript verdicts are never
 * accepted here: six signed run envelopes, signed prerequisites and signed monitoring are required.
 */
export function buildBobLivePublicationCandidate(authority, bundleInput, options = {}) {
  if (!AUTHORITIES.has(authority)) fail('candidate construction requires a trusted authority');
  const now = options.now ?? Date.now();
  if (typeof now !== 'number' || !Number.isFinite(now)) fail('candidate construction clock is invalid');
  const bundle = exactRecord(bundleInput, [
    'version',
    'profileId',
    'releaseSha',
    'prerequisites',
    'deterministicRuns',
    'gptRealtimeRuns',
    'monitoring',
  ], 'signed evidence bundle');
  if (
    bundle.version !== BOB_LIVE_EVIDENCE_ENVELOPE_VERSION
    || bundle.profileId !== authority.profileId
    || bundle.releaseSha !== authority.releaseSha
  ) fail('signed evidence bundle identity mismatch');
  if (!Array.isArray(bundle.deterministicRuns) || bundle.deterministicRuns.length !== 3) {
    fail('signed evidence bundle requires three deterministic runs');
  }
  if (!Array.isArray(bundle.gptRealtimeRuns) || bundle.gptRealtimeRuns.length !== 3) {
    fail('signed evidence bundle requires three GPT Realtime runs');
  }
  const deterministic = bundle.deterministicRuns.map((entry, index) => (
    validateSignedRun(authority, entry, 'deterministic', index + 1, now)
  ));
  const gptRealtime = bundle.gptRealtimeRuns.map((entry, index) => (
    validateSignedRun(authority, entry, 'gpt-realtime', index + 1, now)
  ));
  const signedRuns = [...deterministic, ...gptRealtime];
  const completedTimes = signedRuns.map((entry) => entry.completedAt.epochMs);
  const topologyDigests = new Set(signedRuns.map((entry) => entry.run.topologyDigest));
  if (topologyDigests.size !== 1) fail('signed run topology changed across certification');
  const prerequisites = validateSignedPrerequisites(authority, bundle.prerequisites, now);
  const monitoring = validateSignedMonitoring(
    authority,
    bundle.monitoring,
    Math.max(...completedTimes),
    signedRuns[0].run.topologyDigest,
    now,
  );
  let previousCohortCertificate = null;
  if (authority.profileId === 'cohort-1000') {
    const previous = options.previousCertificate;
    if (
      !VERIFIED_CERTIFICATES.has(previous)
      || previous.profileId !== 'cohort-100'
      || previous.releaseSha !== authority.releaseSha
      || previous.publicationEligible !== true
    ) fail('cohort-1000 evidence requires the verified cohort-100 certificate');
    previousCohortCertificate = {
      contractVersion: BOB_LIVE_LOAD_CONTRACT_VERSION,
      profileId: previous.profileId,
      releaseSha: previous.releaseSha,
      publicationEligible: previous.publicationEligible,
      certificateDigest: previous.certificateDigest,
    };
  } else if (options.previousCertificate !== undefined && options.previousCertificate !== null) {
    fail('cohort-100 evidence cannot use a previous certificate');
  }
  const projection = deriveBobLivePublicationCandidateProjection({
    contractVersion: BOB_LIVE_LOAD_CONTRACT_VERSION,
    profileId: authority.profileId,
    releaseSha: authority.releaseSha,
    prerequisites: {
      c1Certified: true,
      c2Certified: true,
      providerChanged: prerequisites.prerequisites.providerChanged,
      c4Certified:
        !prerequisites.prerequisites.providerChanged
        || SHA256.test(prerequisites.prerequisites.c4CertificateDigest),
    },
    previousCohortCertificate,
    deterministicRuns: deterministic.map((entry) => entry.run),
    gptRealtimeRuns: gptRealtime.map((entry) => entry.run),
    monitoring: {
      startedAt: monitoring.startedAt.value,
      completedAt: monitoring.completedAt.value,
      sampleIntervalSeconds: monitoring.monitoring.sampleIntervalSeconds,
      sampleCount: monitoring.monitoring.samples.length,
      sloViolationCount: monitoring.sloViolationCount,
      securityIncidentCount: monitoring.securityIncidentCount,
      unresolvedAlertCount: monitoring.unresolvedAlertCount,
      evidenceDigest: monitoring.evidenceDigest,
    },
  });
  if (projection.candidateEligible !== true) fail('signed evidence bundle does not satisfy every publication gate');
  const evidenceBundleDigest = digest(canonicalJson({
    runs: signedRuns.map((entry) => entry.envelopeDigest).sort(),
    prerequisites: prerequisites.envelopeDigest,
    monitoring: monitoring.envelopeDigest,
    previousCohortCertificateDigest: previousCohortCertificate?.certificateDigest ?? null,
  }, 'evidence bundle digest'));
  const candidate = Object.freeze({ ...projection, evidenceBundleDigest });
  VERIFIED_CANDIDATES.add(candidate);
  return candidate;
}

function validateCandidate(authority, candidateInput) {
  const candidate = exactRecord(candidateInput, [
    'contractVersion',
    'profileId',
    'releaseSha',
    'checks',
    'candidateEligible',
    'candidateDigest',
    'monitoringCompletedAt',
    'previousCohortCertificateDigest',
    'evidenceBundleDigest',
  ], 'publication candidate');
  if (!VERIFIED_CANDIDATES.has(candidate)) fail('publication candidate is not backed by verified signed evidence');
  if (
    candidate.contractVersion !== BOB_LIVE_LOAD_CONTRACT_VERSION
    || candidate.profileId !== authority.profileId
    || candidate.releaseSha !== authority.releaseSha
    || candidate.candidateEligible !== true
    || !SHA256.test(candidate.candidateDigest)
    || !SHA256.test(candidate.evidenceBundleDigest)
  ) fail('publication candidate is not eligible for this authority');
  const checks = exactRecord(candidate.checks, ['c1', 'c2', 'c4', 'runs', 'monitoring'], 'publication checks');
  if (!Object.values(checks).every((value) => value === true)) fail('publication candidate contains a failed check');
  const monitoringCompletedAt = instant(candidate.monitoringCompletedAt, 'monitoringCompletedAt');
  if (candidate.profileId === 'cohort-100') {
    if (candidate.previousCohortCertificateDigest !== null) fail('cohort-100 cannot depend on another certificate');
  } else if (!SHA256.test(candidate.previousCohortCertificateDigest)) {
    fail('cohort-1000 candidate requires a cohort-100 certificate digest');
  }
  return { candidate, monitoringCompletedAt };
}

function validateAttestation(authority, candidate, attestationInput) {
  const trustRoot = authority.trustRoots.publication;
  const attestation = exactRecord(attestationInput, [
    'version',
    'keyId',
    'algorithm',
    'repository',
    'workflowRef',
    'workflowSha',
    'workflowRunId',
    'environment',
    'issuedAt',
    'candidateDigest',
    'signature',
  ], 'publication attestation');
  if (attestation.version !== BOB_LIVE_PUBLICATION_ATTESTATION_VERSION) fail('attestation version mismatch');
  if (attestation.keyId !== trustRoot.keyId || attestation.algorithm !== 'Ed25519') fail('attestation signer mismatch');
  if (
    attestation.repository !== authority.repository
    || attestation.workflowRef !== trustRoot.workflowRef
    || attestation.workflowSha !== trustRoot.workflowSha
  ) {
    fail('attestation workflow identity mismatch');
  }
  if (attestation.environment !== authority.environment) fail('attestation environment mismatch');
  if (!/^\d{1,20}$/u.test(attestation.workflowRunId)) fail('attestation workflowRunId is invalid');
  if (attestation.candidateDigest !== candidate.candidateDigest) fail('attestation candidate digest mismatch');
  if (typeof attestation.signature !== 'string' || !BASE64URL.test(attestation.signature)) {
    fail('attestation signature encoding is invalid');
  }
  return attestation;
}

export function bobLivePublicationSigningPayload(candidateInput, attestationInput) {
  const candidate = exactRecord(candidateInput, [
    'contractVersion',
    'profileId',
    'releaseSha',
    'checks',
    'candidateEligible',
    'candidateDigest',
    'monitoringCompletedAt',
    'previousCohortCertificateDigest',
    'evidenceBundleDigest',
  ], 'publication candidate');
  if (!VERIFIED_CANDIDATES.has(candidate)) fail('publication candidate is not backed by verified signed evidence');
  const attestation = exactRecord(attestationInput, [
    'version',
    'keyId',
    'algorithm',
    'repository',
    'workflowRef',
    'workflowSha',
    'workflowRunId',
    'environment',
    'issuedAt',
    'candidateDigest',
  ], 'unsigned publication attestation');
  return Buffer.from(JSON.stringify({ candidate, attestation }), 'utf8');
}

/** Verify the protected-workflow signature and emit the only public capacity certificate. */
export function verifyBobLivePublicationAttestation(
  authority,
  candidateInput,
  attestationInput,
  options = {},
) {
  if (!AUTHORITIES.has(authority)) fail('publication verification requires a trusted authority');
  const { candidate, monitoringCompletedAt } = validateCandidate(authority, candidateInput);
  const attestation = validateAttestation(authority, candidate, attestationInput);
  const now = options.now ?? Date.now();
  if (typeof now !== 'number' || !Number.isFinite(now)) fail('publication verification clock is invalid');
  if (candidate.profileId === 'cohort-100') {
    if (options.previousCertificate !== undefined && options.previousCertificate !== null) {
      fail('cohort-100 cannot use a previous certificate');
    }
  } else {
    const previous = options.previousCertificate;
    if (
      !VERIFIED_CERTIFICATES.has(previous)
      || previous.profileId !== 'cohort-100'
      || previous.releaseSha !== candidate.releaseSha
      || previous.publicationEligible !== true
      || previous.certificateDigest !== candidate.previousCohortCertificateDigest
    ) fail('cohort-1000 requires the cryptographically verified cohort-100 certificate');
  }
  const issuedAt = instant(attestation.issuedAt, 'attestation issuedAt');
  if (
    issuedAt.epochMs < monitoringCompletedAt.epochMs
    || issuedAt.epochMs > now + 5 * 60_000
    || issuedAt.epochMs > monitoringCompletedAt.epochMs + 24 * 60 * 60_000
  ) fail('attestation issuance window is invalid');
  const unsigned = {
    version: attestation.version,
    keyId: attestation.keyId,
    algorithm: attestation.algorithm,
    repository: attestation.repository,
    workflowRef: attestation.workflowRef,
    workflowSha: attestation.workflowSha,
    workflowRunId: attestation.workflowRunId,
    environment: attestation.environment,
    issuedAt: attestation.issuedAt,
    candidateDigest: attestation.candidateDigest,
  };
  const payload = bobLivePublicationSigningPayload(candidate, unsigned);
  let signature;
  try {
    signature = Buffer.from(attestation.signature, 'base64url');
  } catch {
    fail('attestation signature encoding is invalid');
  }
  if (signature.length !== 64 || !verifySignature(
    null,
    payload,
    authority.trustRoots.publication.publicKey,
    signature,
  )) {
    fail('attestation signature is invalid');
  }
  const profile = BOB_LIVE_LOAD_PROFILES[candidate.profileId];
  const certificateDigest = createHash('sha256')
    .update(payload)
    .update(signature)
    .digest('hex');
  const certificate = Object.freeze({
    version: BOB_LIVE_PUBLICATION_ATTESTATION_VERSION,
    contractVersion: BOB_LIVE_LOAD_CONTRACT_VERSION,
    profileId: candidate.profileId,
    releaseSha: candidate.releaseSha,
    publicationEligible: true,
    certificateDigest,
    signedAt: issuedAt.value,
    signerKeyId: authority.trustRoots.publication.keyId,
    evidenceBundleDigest: candidate.evidenceBundleDigest,
    scope: Object.freeze({
      activeAccounts: profile.population,
      sustainedApiVirtualUsers: profile.api.sustainedVirtualUsers,
      burstApiVirtualUsers: profile.api.burstVirtualUsers,
      maxConcurrentLiveSessions: profile.liveStages.at(-1),
      excludesOneThousandConcurrentVoices: true,
    }),
  });
  VERIFIED_CERTIFICATES.add(certificate);
  return certificate;
}

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  BOB_LIVE_EVIDENCE_ENVELOPE_VERSION,
  BOB_LIVE_PUBLICATION_ATTESTATION_VERSION,
  BOB_LIVE_PUBLICATION_CONFIRMATION,
  bobLiveEvidenceEnvelopeSigningPayload,
  bobLivePublicationSigningPayload,
  buildBobLivePublicationCandidate,
  encodeBobLiveEvidencePayload,
  loadBobLivePublicationAuthority,
  verifyBobLivePublicationAttestation,
} from './bob-live-publication-attestation.mjs';

const SHA = 'a'.repeat(40);
const CONTRACT_VERSION = 'bob-live-c3-v1';
const PAYLOAD_TYPES = Object.freeze({
  run: 'application/vnd.bob.live.capacity.run-verdict.v1+json',
  prerequisites: 'application/vnd.bob.live.capacity.prerequisites.v1+json',
  monitoring: 'application/vnd.bob.live.capacity.monitoring.v1+json',
});
const WORKFLOW_REFS = Object.freeze({
  run: '.github/workflows/bob-live-run.yml@refs/heads/main',
  prerequisites: '.github/workflows/bob-live-prerequisites.yml@refs/heads/main',
  monitoring: '.github/workflows/bob-live-monitoring.yml@refs/heads/main',
  publication: '.github/workflows/bob-live-capacity.yml@refs/heads/main',
});
const WORKFLOW_SHAS = Object.freeze({
  run: '1'.repeat(40),
  prerequisites: '2'.repeat(40),
  monitoring: '3'.repeat(40),
  publication: '4'.repeat(40),
});
const KEY_IDS = Object.freeze({
  run: 'bob-capacity-run-2026-01',
  prerequisites: 'bob-capacity-prerequisites-2026-01',
  monitoring: 'bob-capacity-monitoring-2026-01',
  publication: 'bob-capacity-publication-2026-01',
});
let root;
const publicKeyPaths = {};
const publicKeyFingerprints = {};
const publicKeyPems = {};
const privateKeys = {};

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bob-live-publication-')));
  for (const role of Object.keys(KEY_IDS)) {
    const pair = generateKeyPairSync('ed25519');
    privateKeys[role] = pair.privateKey;
    publicKeyPaths[role] = join(root, `${role}-ed25519.pub.pem`);
    const pem = pair.publicKey.export({ type: 'spki', format: 'pem' });
    publicKeyPems[role] = pem;
    await writeFile(publicKeyPaths[role], pem, { mode: 0o644 });
    await chmod(publicKeyPaths[role], 0o644);
    publicKeyFingerprints[role] = createHash('sha256')
      .update(pair.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
  }
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function environment(overrides = {}) {
  return {
    BOB_LIVE_PUBLICATION_CONFIRM: BOB_LIVE_PUBLICATION_CONFIRMATION,
    BOB_LIVE_PUBLICATION_PROFILE: 'cohort-100',
    BOB_LIVE_PUBLICATION_EXPECTED_SHA: SHA,
    BOB_LIVE_PUBLICATION_REPOSITORY: 'bob-pro/bob-pro',
    BOB_LIVE_PUBLICATION_RUN_SIGNER_KEY_ID: KEY_IDS.run,
    BOB_LIVE_PUBLICATION_RUN_WORKFLOW_REF: WORKFLOW_REFS.run,
    BOB_LIVE_PUBLICATION_RUN_WORKFLOW_SHA: WORKFLOW_SHAS.run,
    BOB_LIVE_PUBLICATION_RUN_PUBLIC_KEY_PATH: publicKeyPaths.run,
    BOB_LIVE_PUBLICATION_RUN_PUBLIC_KEY_SHA256: publicKeyFingerprints.run,
    BOB_LIVE_PUBLICATION_PREREQUISITES_SIGNER_KEY_ID: KEY_IDS.prerequisites,
    BOB_LIVE_PUBLICATION_PREREQUISITES_WORKFLOW_REF: WORKFLOW_REFS.prerequisites,
    BOB_LIVE_PUBLICATION_PREREQUISITES_WORKFLOW_SHA: WORKFLOW_SHAS.prerequisites,
    BOB_LIVE_PUBLICATION_PREREQUISITES_PUBLIC_KEY_PATH: publicKeyPaths.prerequisites,
    BOB_LIVE_PUBLICATION_PREREQUISITES_PUBLIC_KEY_SHA256: publicKeyFingerprints.prerequisites,
    BOB_LIVE_PUBLICATION_MONITORING_SIGNER_KEY_ID: KEY_IDS.monitoring,
    BOB_LIVE_PUBLICATION_MONITORING_WORKFLOW_REF: WORKFLOW_REFS.monitoring,
    BOB_LIVE_PUBLICATION_MONITORING_WORKFLOW_SHA: WORKFLOW_SHAS.monitoring,
    BOB_LIVE_PUBLICATION_MONITORING_PUBLIC_KEY_PATH: publicKeyPaths.monitoring,
    BOB_LIVE_PUBLICATION_MONITORING_PUBLIC_KEY_SHA256: publicKeyFingerprints.monitoring,
    BOB_LIVE_PUBLICATION_SIGNER_KEY_ID: KEY_IDS.publication,
    BOB_LIVE_PUBLICATION_WORKFLOW_REF: WORKFLOW_REFS.publication,
    BOB_LIVE_PUBLICATION_WORKFLOW_SHA: WORKFLOW_SHAS.publication,
    BOB_LIVE_PUBLICATION_PUBLIC_KEY_PATH: publicKeyPaths.publication,
    BOB_LIVE_PUBLICATION_PUBLIC_KEY_SHA256: publicKeyFingerprints.publication,
    ...overrides,
  };
}

function signedEvidence(kind, subject, issuedAt, overrides = {}) {
  const signingRole = overrides.signingRole ?? kind;
  const payloadObject = {
    version: BOB_LIVE_EVIDENCE_ENVELOPE_VERSION,
    kind,
    repository: 'bob-pro/bob-pro',
    workflowRef: WORKFLOW_REFS[kind],
    workflowSha: WORKFLOW_SHAS[kind],
    workflowRunId: '123456789',
    environment: 'capacity-certification',
    issuedAt,
    subject,
    ...overrides.payload,
  };
  const payload = encodeBobLiveEvidencePayload(payloadObject);
  const payloadType = overrides.payloadType ?? PAYLOAD_TYPES[kind];
  const signature = sign(
    null,
    bobLiveEvidenceEnvelopeSigningPayload(payloadType, payload),
    privateKeys[signingRole],
  ).toString('base64url');
  return {
    payloadType,
    payload,
    signatures: [{ keyid: KEY_IDS[signingRole], sig: signature }],
  };
}

function runSubject(profileId, pass, attempt, index, completedAt) {
  return {
    contractVersion: CONTRACT_VERSION,
    runId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    preflightDigest: `${index}`.padStart(64, '0'),
    rawEvidenceSha256: `${index + 10}`.padStart(64, '0'),
    topologyDigest: 'c'.repeat(64),
    profileId,
    releaseSha: SHA,
    pass,
    runKind: 'certification',
    attempt,
    startedAt: new Date(completedAt - 4 * 60 * 60_000).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    runPassed: true,
  };
}

function signedBundle(profileId, now, overrides = {}) {
  const monitoringCompletedAt = now - 60_000;
  const monitoringStartedAt = monitoringCompletedAt - 7 * 24 * 60 * 60_000;
  const lastRunCompletedAt = monitoringStartedAt - 60_000;
  const runs = [
    ...[1, 2, 3].map((attempt, index) => runSubject(
      profileId,
      'deterministic',
      attempt,
      index + 1,
      lastRunCompletedAt - (5 - index) * 60_000,
    )),
    ...[1, 2, 3].map((attempt, index) => runSubject(
      profileId,
      'gpt-realtime',
      attempt,
      index + 4,
      lastRunCompletedAt - (2 - index) * 60_000,
    )),
  ];
  const samples = Array.from({ length: 2_017 }, (_, index) => ({
    observedAt: new Date(monitoringStartedAt + index * 300_000).toISOString(),
    sloViolationCount: 0,
    securityIncidentCount: 0,
    unresolvedAlertCount: 0,
  }));
  const bundle = {
    version: BOB_LIVE_EVIDENCE_ENVELOPE_VERSION,
    profileId,
    releaseSha: SHA,
    prerequisites: signedEvidence('prerequisites', {
      contractVersion: CONTRACT_VERSION,
      profileId,
      releaseSha: SHA,
      c1CertificateDigest: '1'.repeat(64),
      c2CertificateDigest: '2'.repeat(64),
      providerChanged: false,
      c4CertificateDigest: null,
    }, new Date(lastRunCompletedAt + 5_000).toISOString()),
    deterministicRuns: runs.slice(0, 3).map((run) => signedEvidence(
      'run',
      run,
      new Date(Date.parse(run.completedAt) + 1_000).toISOString(),
    )),
    gptRealtimeRuns: runs.slice(3).map((run) => signedEvidence(
      'run',
      run,
      new Date(Date.parse(run.completedAt) + 1_000).toISOString(),
    )),
    monitoring: signedEvidence('monitoring', {
      contractVersion: CONTRACT_VERSION,
      profileId,
      releaseSha: SHA,
      topologyDigest: 'c'.repeat(64),
      startedAt: new Date(monitoringStartedAt).toISOString(),
      completedAt: new Date(monitoringCompletedAt).toISOString(),
      sampleIntervalSeconds: 300,
      samples,
    }, new Date(monitoringCompletedAt + 1_000).toISOString()),
  };
  return { ...bundle, ...overrides };
}

function unsignedAttestation(value, overrides = {}) {
  return {
    version: BOB_LIVE_PUBLICATION_ATTESTATION_VERSION,
    keyId: KEY_IDS.publication,
    algorithm: 'Ed25519',
    repository: 'bob-pro/bob-pro',
    workflowRef: WORKFLOW_REFS.publication,
    workflowSha: WORKFLOW_SHAS.publication,
    workflowRunId: '123456789',
    environment: 'capacity-certification',
    issuedAt: new Date(Date.parse(value.monitoringCompletedAt) + 30_000).toISOString(),
    candidateDigest: value.candidateDigest,
    ...overrides,
  };
}

function signedAttestation(value, overrides = {}) {
  const unsigned = unsignedAttestation(value, overrides);
  const signature = sign(
    null,
    bobLivePublicationSigningPayload(value, unsigned),
    privateKeys.publication,
  ).toString('base64url');
  return { ...unsigned, signature };
}

test('emits the sole public certificate after signed sources and final protected-workflow signature', async () => {
  const now = Date.now();
  const authority = await loadBobLivePublicationAuthority(environment());
  const candidate = buildBobLivePublicationCandidate(authority, signedBundle('cohort-100', now), { now });
  const certificate = verifyBobLivePublicationAttestation(
    authority,
    candidate,
    signedAttestation(candidate),
    { now },
  );
  assert.equal(certificate.publicationEligible, true);
  assert.equal(certificate.scope.activeAccounts, 100);
  assert.equal(certificate.scope.maxConcurrentLiveSessions, 50);
  assert.equal(certificate.scope.excludesOneThousandConcurrentVoices, true);
  assert.equal(certificate.evidenceBundleDigest, candidate.evidenceBundleDigest);
  assert.match(certificate.certificateDigest, /^[a-f0-9]{64}$/u);
});

test('rejects plain fabricated candidates even when the attacker tries to sign them', async () => {
  const authority = await loadBobLivePublicationAuthority(environment());
  const fabricated = {
    contractVersion: CONTRACT_VERSION,
    profileId: 'cohort-100',
    releaseSha: SHA,
    checks: { c1: true, c2: true, c4: true, runs: true, monitoring: true },
    candidateEligible: true,
    candidateDigest: 'b'.repeat(64),
    monitoringCompletedAt: new Date(Date.now() - 60_000).toISOString(),
    previousCohortCertificateDigest: null,
    evidenceBundleDigest: 'd'.repeat(64),
  };
  const unsigned = unsignedAttestation(fabricated);
  assert.throws(
    () => bobLivePublicationSigningPayload(fabricated, unsigned),
    /verified signed evidence/u,
  );
  assert.throws(
    () => verifyBobLivePublicationAttestation(
      authority,
      fabricated,
      { ...unsigned, signature: 'a'.repeat(86) },
    ),
    /verified signed evidence/u,
  );
});

test('rejects a tampered source envelope, temporal gaps and workflow identity drift', async () => {
  const now = Date.now();
  const authority = await loadBobLivePublicationAuthority(environment());
  const tampered = signedBundle('cohort-100', now);
  tampered.gptRealtimeRuns[0] = {
    ...tampered.gptRealtimeRuns[0],
    payload: tampered.deterministicRuns[0].payload,
  };
  assert.throws(
    () => buildBobLivePublicationCandidate(authority, tampered, { now }),
    /signature is invalid/u,
  );

  const gapped = signedBundle('cohort-100', now);
  const original = JSON.parse(Buffer.from(gapped.monitoring.payload, 'base64').toString('utf8'));
  original.subject.samples.splice(100, 1);
  gapped.monitoring = signedEvidence('monitoring', original.subject, original.issuedAt);
  assert.throws(
    () => buildBobLivePublicationCandidate(authority, gapped, { now }),
    /temporal gap|coverage is incomplete/u,
  );

  const wrongIdentity = signedBundle('cohort-100', now);
  const runPayload = JSON.parse(Buffer.from(wrongIdentity.deterministicRuns[0].payload, 'base64').toString('utf8'));
  wrongIdentity.deterministicRuns[0] = signedEvidence('run', runPayload.subject, runPayload.issuedAt, {
    payload: { workflowRef: '.github/workflows/other.yml@refs/heads/main' },
  });
  assert.throws(
    () => buildBobLivePublicationCandidate(authority, wrongIdentity, { now }),
    /workflow identity mismatch/u,
  );

  const wrongWorkflowSha = signedBundle('cohort-100', now);
  const shaPayload = JSON.parse(Buffer.from(wrongWorkflowSha.deterministicRuns[0].payload, 'base64').toString('utf8'));
  wrongWorkflowSha.deterministicRuns[0] = signedEvidence('run', shaPayload.subject, shaPayload.issuedAt, {
    payload: { workflowSha: '9'.repeat(40) },
  });
  assert.throws(
    () => buildBobLivePublicationCandidate(authority, wrongWorkflowSha, { now }),
    /workflow identity mismatch/u,
  );
});

test('keeps run, prerequisite, monitoring and publication trust roots strictly separated', async () => {
  const now = Date.now();
  const authority = await loadBobLivePublicationAuthority(environment());
  const bundle = signedBundle('cohort-100', now);
  const prerequisitePayload = JSON.parse(Buffer.from(bundle.prerequisites.payload, 'base64').toString('utf8'));
  bundle.prerequisites = signedEvidence(
    'prerequisites',
    prerequisitePayload.subject,
    prerequisitePayload.issuedAt,
    { signingRole: 'run' },
  );
  assert.throws(
    () => buildBobLivePublicationCandidate(authority, bundle, { now }),
    /prerequisites evidence signer mismatch/u,
  );

  const leafWithPublicationKey = signedBundle('cohort-100', now);
  const runPayload = JSON.parse(Buffer.from(leafWithPublicationKey.deterministicRuns[0].payload, 'base64').toString('utf8'));
  leafWithPublicationKey.deterministicRuns[0] = signedEvidence(
    'run',
    runPayload.subject,
    runPayload.issuedAt,
    { signingRole: 'publication' },
  );
  assert.throws(
    () => buildBobLivePublicationCandidate(authority, leafWithPublicationKey, { now }),
    /run evidence signer mismatch/u,
  );

  const candidate = buildBobLivePublicationCandidate(
    authority,
    signedBundle('cohort-100', now),
    { now },
  );
  const unsigned = unsignedAttestation(candidate, { keyId: KEY_IDS.run });
  const signature = sign(
    null,
    bobLivePublicationSigningPayload(candidate, unsigned),
    privateKeys.run,
  ).toString('base64url');
  assert.throws(
    () => verifyBobLivePublicationAttestation(authority, candidate, { ...unsigned, signature }, { now }),
    /attestation signer mismatch/u,
  );
});

test('pins each public key fingerprint independently of its claimed key id', async () => {
  const replacement = generateKeyPairSync('ed25519');
  await writeFile(
    publicKeyPaths.run,
    replacement.publicKey.export({ type: 'spki', format: 'pem' }),
    { mode: 0o644 },
  );
  await chmod(publicKeyPaths.run, 0o644);
  await assert.rejects(
    () => loadBobLivePublicationAuthority(environment()),
    /run public key fingerprint mismatch/u,
  );
  await writeFile(publicKeyPaths.run, publicKeyPems.run, { mode: 0o644 });
  await chmod(publicKeyPaths.run, 0o644);
});

test('rejects unsigned, late and permissive-key final publication attempts', async () => {
  const now = Date.now();
  const authority = await loadBobLivePublicationAuthority(environment());
  const candidate = buildBobLivePublicationCandidate(authority, signedBundle('cohort-100', now), { now });
  const unsigned = unsignedAttestation(candidate);
  assert.throws(
    () => verifyBobLivePublicationAttestation(authority, candidate, { ...unsigned, signature: 'not-a-signature' }),
    /signature is invalid/u,
  );
  const late = signedAttestation(candidate, {
    issuedAt: new Date(Date.parse(candidate.monitoringCompletedAt) + 25 * 60 * 60_000).toISOString(),
  });
  assert.throws(
    () => verifyBobLivePublicationAttestation(authority, candidate, late, {
      now: Date.parse(late.issuedAt),
    }),
    /issuance window/u,
  );

  await chmod(publicKeyPaths.publication, 0o666);
  await assert.rejects(() => loadBobLivePublicationAuthority(environment()), /must not be group\/world writable/u);
  await chmod(publicKeyPaths.publication, 0o644);
});

test('requires a verified cohort-100 certificate before building cohort-1000 evidence', async () => {
  const now = Date.now();
  const authority100 = await loadBobLivePublicationAuthority(environment());
  const candidate100 = buildBobLivePublicationCandidate(authority100, signedBundle('cohort-100', now), { now });
  const certificate100 = verifyBobLivePublicationAttestation(
    authority100,
    candidate100,
    signedAttestation(candidate100),
    { now },
  );

  const authority1000 = await loadBobLivePublicationAuthority(environment({
    BOB_LIVE_PUBLICATION_PROFILE: 'cohort-1000',
  }));
  const bundle1000 = signedBundle('cohort-1000', now);
  assert.throws(
    () => buildBobLivePublicationCandidate(authority1000, bundle1000, { now }),
    /verified cohort-100 certificate/u,
  );
  const candidate1000 = buildBobLivePublicationCandidate(authority1000, bundle1000, {
    now,
    previousCertificate: certificate100,
  });
  const certificate1000 = verifyBobLivePublicationAttestation(
    authority1000,
    candidate1000,
    signedAttestation(candidate1000),
    { now, previousCertificate: certificate100 },
  );
  assert.equal(certificate1000.scope.activeAccounts, 1_000);
  assert.equal(certificate1000.scope.maxConcurrentLiveSessions, 250);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  BOB_LIVE_FAILURE_SCENARIOS,
  BOB_LIVE_JARVIS_MISSIONS,
  BOB_LIVE_LOAD_CONFIRMATION,
  BOB_LIVE_LOAD_CONTRACT_VERSION,
  assertBobLiveLoadReadiness,
  bobLivePlannedRunSeconds,
  evaluateBobLiveLoadEvidence,
  deriveBobLivePublicationCandidateProjection,
  loadBobLivePrincipalManifest,
  parseBobLiveLoadEnvironment,
  percentile,
  prepareBobLiveLoadRun,
  publicManifestSummary,
  validateBobLiveAcousticEvidence,
} from './bob-live-load-contract.mjs';

const SHA = 'a'.repeat(40);
const RELEASE_ENVIRONMENT = 'staging';
const DIGEST = (value) => createHash('sha256').update(value).digest('hex');

let root;
let secretRoot;
let artifactRoot;
let manifestPath;
let resultPath;
let apiOrigin;
let jwksUrl;
let issuer;
let server;
let privateKey;
let publicJwk;
let signedPrincipals;
let manifestExpiresAt;

function userId(slot) {
  return `00000000-0000-4000-8000-${String(slot).padStart(12, '0')}`;
}

async function signPrincipal(slot, companyId = `company-${slot}`) {
  return new SignJWT({ app_metadata: { company_id: companyId } })
    .setProtectedHeader({ alg: 'ES256', kid: 'bob-live-c3-test' })
    .setSubject(userId(slot))
    .setAudience('authenticated')
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.parse(manifestExpiresAt) / 1_000))
    .sign(privateKey);
}

async function writeValidManifest({ path = manifestPath, principals = signedPrincipals } = {}) {
  const now = Date.now();
  await writeFile(path, JSON.stringify({
    contractVersion: BOB_LIVE_LOAD_CONTRACT_VERSION,
    targetEnvironment: 'ephemeral',
    expectedReleaseEnvironment: RELEASE_ENVIRONMENT,
    expectedReleaseSha: SHA,
    generatedAt: new Date(now - 1_000).toISOString(),
    expiresAt: manifestExpiresAt,
    principals,
  }), { mode: 0o600 });
  await chmod(path, 0o600);
}

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bob-live-load-contract-')));
  secretRoot = join(root, 'secrets');
  artifactRoot = join(root, 'artifacts');
  await mkdir(secretRoot, { mode: 0o700 });
  await mkdir(artifactRoot, { mode: 0o755 });
  await chmod(secretRoot, 0o700);
  manifestPath = join(secretRoot, 'principals.json');
  resultPath = join(artifactRoot, 'result.json');

  const pair = await generateKeyPair('ES256');
  // Keep the signing and published keys from the same pair.
  privateKey = pair.privateKey;
  publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = 'bob-live-c3-test';
  publicJwk.alg = 'ES256';
  publicJwk.use = 'sig';

  server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/jwks') {
      response.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    if (request.url === '/health/ready') {
      response.end(JSON.stringify({
        ready: true,
        release: { sha: SHA, environment: RELEASE_ENVIRONMENT },
        network: { clientIpSource: 'socket' },
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not-found' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  apiOrigin = `http://127.0.0.1:${address.port}`;
  jwksUrl = `${apiOrigin}/jwks`;
  issuer = `${apiOrigin}/issuer`;
  const expirationSeconds = Math.floor(Date.now() / 1_000) + 2 * 60 * 60;
  manifestExpiresAt = new Date(expirationSeconds * 1_000).toISOString();
  signedPrincipals = await Promise.all(Array.from({ length: 100 }, async (_, slot) => ({
    slot,
    userId: userId(slot),
    companyId: `company-${slot}`,
    accessToken: await signPrincipal(slot),
    sourceShard: 0,
  })));
  await writeValidManifest();
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});

function environment(overrides = {}) {
  return {
    BOB_LIVE_LOAD_CONFIRM: BOB_LIVE_LOAD_CONFIRMATION,
    BOB_LIVE_LOAD_PROFILE: 'cohort-100',
    BOB_LIVE_LOAD_PASS: 'deterministic',
    BOB_LIVE_LOAD_RUN_KIND: 'smoke',
    BOB_LIVE_LOAD_TARGET_ENVIRONMENT: 'ephemeral',
    BOB_LIVE_LOAD_EXPECTED_RELEASE_ENVIRONMENT: RELEASE_ENVIRONMENT,
    BOB_LIVE_LOAD_EXPECTED_CLIENT_IP_SOURCE: 'socket',
    BOB_LIVE_LOAD_API_ORIGIN: apiOrigin,
    BOB_LIVE_LOAD_EXPECTED_SHA: SHA,
    BOB_LIVE_LOAD_ATTEMPT: '1',
    BOB_LIVE_LOAD_SOURCE_SHARDS: '1',
    BOB_LIVE_LOAD_DURATION_SCALE: '0.0001',
    BOB_LIVE_LOAD_SECRET_ROOT: secretRoot,
    BOB_LIVE_LOAD_ARTIFACT_ROOT: artifactRoot,
    BOB_LIVE_LOAD_MANIFEST_PATH: manifestPath,
    BOB_LIVE_LOAD_RESULT_PATH: resultPath,
    BOB_LIVE_LOAD_JWKS_URL: jwksUrl,
    BOB_LIVE_LOAD_JWT_AUDIENCE: 'authenticated',
    BOB_LIVE_LOAD_JWT_ISSUER: issuer,
    BOB_LIVE_LOAD_EXPECTED_DEPLOYMENT_ID: 'local-c3-test',
    BOB_LIVE_LOAD_EXPECTED_PROVIDER_ID: 'openai',
    BOB_LIVE_LOAD_EXPECTED_MODEL: 'gpt-realtime-2.1',
    BOB_LIVE_LOAD_EXPECTED_GLOBAL_CAPACITY: '100',
    BOB_LIVE_LOAD_EXPECTED_PROVIDER_CAPACITY: '100',
    BOB_LIVE_LOAD_EXPECTED_CAPACITY_CONFIG_VERSION: '1',
    BOB_LIVE_LOAD_EXPECTED_API_REPLICAS: '1',
    BOB_LIVE_LOAD_EXPECTED_DATABASE_POOL_MAX: '20',
    ...overrides,
  };
}

function stagingEnvironment(overrides = {}) {
  return environment({
    BOB_LIVE_LOAD_PASS: 'gpt-realtime',
    BOB_LIVE_LOAD_RUN_KIND: 'certification',
    BOB_LIVE_LOAD_TARGET_ENVIRONMENT: 'staging',
    BOB_LIVE_LOAD_EXPECTED_CLIENT_IP_SOURCE: 'railway-x-real-ip',
    BOB_LIVE_LOAD_API_ORIGIN: 'https://api-staging.bobpro.fr',
    BOB_LIVE_LOAD_ALLOWED_STAGING_ORIGIN: 'https://api-staging.bobpro.fr',
    BOB_LIVE_LOAD_JWKS_URL: 'https://project.supabase.co/auth/v1/.well-known/jwks.json',
    BOB_LIVE_LOAD_JWT_ISSUER: 'https://project.supabase.co/auth/v1',
    BOB_LIVE_LOAD_SOURCE_SHARDS: '10',
    BOB_LIVE_LOAD_DURATION_SCALE: '1',
    ...overrides,
  });
}

test('parses explicit ephemeral smoke and allowlisted GPT staging envelopes', () => {
  const smoke = parseBobLiveLoadEnvironment(environment());
  assert.equal(smoke.profile.population, 100);
  assert.equal(smoke.profile.liveStages.at(-1), 50);
  assert.equal(smoke.minimumSourceShards, 10);
  assert.equal(smoke.expectedReleaseEnvironment, 'staging');

  const staging = parseBobLiveLoadEnvironment(stagingEnvironment());
  assert.equal(staging.pass, 'gpt-realtime');
  assert.equal(staging.sourceShards, 10);
});

test('refuses production, a non-allowlisted staging target and a shortened certification', () => {
  assert.throws(
    () => parseBobLiveLoadEnvironment(environment({ BOB_LIVE_LOAD_TARGET_ENVIRONMENT: 'production' })),
    /ephemeral or staging/u,
  );
  assert.throws(
    () => parseBobLiveLoadEnvironment(stagingEnvironment({
      BOB_LIVE_LOAD_ALLOWED_STAGING_ORIGIN: 'https://other-staging.bobpro.fr',
    })),
    /not the explicitly allowed target/u,
  );
  assert.throws(
    () => parseBobLiveLoadEnvironment(stagingEnvironment({ BOB_LIVE_LOAD_DURATION_SCALE: '0.9' })),
    /cannot shorten/u,
  );
});

test('keeps secret and result paths disjoint and rejects unsafe client-IP certification', () => {
  assert.throws(
    () => parseBobLiveLoadEnvironment(environment({ BOB_LIVE_LOAD_ARTIFACT_ROOT: secretRoot })),
    /must be disjoint/u,
  );
  assert.throws(
    () => parseBobLiveLoadEnvironment(environment({
      BOB_LIVE_LOAD_RUN_KIND: 'certification',
      BOB_LIVE_LOAD_DURATION_SCALE: '1',
      BOB_LIVE_LOAD_SOURCE_SHARDS: '10',
    })),
    /railway-x-real-ip/u,
  );
});

test('readiness binds the run to the exact SHA, release environment and IP contract', () => {
  const configuration = parseBobLiveLoadEnvironment(environment());
  assert.deepEqual(
    assertBobLiveLoadReadiness(configuration, {
      ready: true,
      release: { sha: SHA, environment: RELEASE_ENVIRONMENT },
      network: { clientIpSource: 'socket' },
    }),
    { releaseSha: SHA, environment: RELEASE_ENVIRONMENT, clientIpSource: 'socket' },
  );
  assert.throws(
    () => assertBobLiveLoadReadiness(configuration, {
      ready: true,
      release: { sha: 'b'.repeat(40), environment: RELEASE_ENVIRONMENT },
      network: { clientIpSource: 'socket' },
    }),
    /SHA mismatch/u,
  );
});

test('performs readiness first, verifies real JWTs and redacts every principal', async () => {
  const configuration = parseBobLiveLoadEnvironment(environment());
  const context = await prepareBobLiveLoadRun(configuration);
  assert.equal(context.manifestSummary.principalCount, 100);
  assert.equal(context.principals[0].authorizationHeader().startsWith('Bearer '), true);
  const serialized = JSON.stringify(context);
  assert.doesNotMatch(serialized, /company-0|00000000-0000-4000-8000-000000000000|eyJ/u);
  assert.deepEqual(publicManifestSummary(configuration, await loadBobLivePrincipalManifest(configuration)), {
    principalCount: 100,
    sourceShardCount: 1,
    expiresAt: manifestExpiresAt,
    profileId: 'cohort-100',
  });
});

test('rejects permissive manifests, symlinks and JWT tenant mismatch', async () => {
  const configuration = parseBobLiveLoadEnvironment(environment());
  await chmod(manifestPath, 0o644);
  await assert.rejects(() => prepareBobLiveLoadRun(configuration), /permissions must be 0600/u);
  await chmod(manifestPath, 0o600);

  const symlinkPath = join(secretRoot, 'manifest-link.json');
  await symlink(manifestPath, symlinkPath);
  const symlinkConfiguration = parseBobLiveLoadEnvironment(environment({
    BOB_LIVE_LOAD_MANIFEST_PATH: symlinkPath,
  }));
  await assert.rejects(() => prepareBobLiveLoadRun(symlinkConfiguration), /opened securely/u);
  await rm(symlinkPath);

  const badPrincipals = [...signedPrincipals];
  badPrincipals[0] = {
    ...badPrincipals[0],
    accessToken: await signPrincipal(0, 'company-another'),
  };
  await writeValidManifest({ principals: badPrincipals });
  await assert.rejects(() => prepareBobLiveLoadRun(configuration), /token tenant mismatch/u);
  await writeValidManifest();
});

test('uses nearest-rank percentiles, including a one-sample series', () => {
  assert.equal(percentile([9], 0.99), 9);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 5);
});

const MISSION_REQUIREMENTS = Object.freeze({
  'quote-one-shot': Object.freeze({
    reads: Object.freeze(['ListCustomers', 'SearchCatalogue']),
    write: 'CreateQuote',
    tool: 'creer_devis',
  }),
  'quote-progressive': Object.freeze({
    reads: Object.freeze(['ReadQuoteDraft', 'SearchCatalogue']),
    write: 'CreateQuote',
    tool: 'creer_devis',
  }),
  'invoice-from-quote': Object.freeze({
    reads: Object.freeze(['ListInvoiceableQuotes']),
    write: 'GenerateInvoiceFromQuote',
    tool: 'generer_facture_depuis_devis',
  }),
  'customer-create': Object.freeze({
    reads: Object.freeze(['FindCustomerDuplicates']),
    write: 'CreateCustomerIdempotent',
    tool: 'creer_client',
  }),
  'catalogue-disambiguation': Object.freeze({
    reads: Object.freeze(['SearchCatalogue']),
    write: 'ApplyCatalogueDecision',
    tool: 'search_catalogue',
  }),
  'home-briefing': Object.freeze({ reads: Object.freeze(['DeriveTodayView']), write: null, tool: null }),
  'notification-action': Object.freeze({
    reads: Object.freeze(['ListNotifications', 'ReadInvoice', 'ReadCustomer']),
    write: 'QueueInvoiceReminder',
    tool: 'relancer_facture',
  }),
  'interruption-resume': Object.freeze({ reads: Object.freeze(['ReadRealtimeMission']), write: null, tool: null }),
});

function missionEnvelope(context, caseId, index, stage, startMs, endMs, transport = 'deterministic') {
  const requirements = MISSION_REQUIREMENTS[caseId];
  const entityType = caseId === 'customer-create' ? 'customer' : 'quote';
  const entityIdHash = DIGEST(`${caseId}:${index}:entity`);
  const afterHash = DIGEST(`${caseId}:${index}:after`);
  const readOnly = caseId === 'home-briefing';
  const interruption = caseId === 'interruption-resume';
  const mutating = !readOnly && !interruption;
  return {
    caseId,
    missionId: `${caseId}-${stage}-${index}`,
    runId: context.runId,
    preflightDigest: context.preflightDigest,
    companyIdHash: DIGEST(`${context.preflightDigest}:company-${index % 100}`),
    sessionId: `session-${caseId}-${index}`,
    transport,
    stage,
    startedAt: new Date(startMs + 250 + index).toISOString(),
    completedAt: new Date(Math.min(endMs, startMs + 750 + index)).toISOString(),
    turns: Array.from({ length: interruption ? 2 : 1 }, (_, turn) => ({
      turnId: `turn-${caseId}-${index}-${turn}`,
      contextRevision: turn + 1,
      contextDigest: DIGEST(`context:${caseId}:${index}:${turn}`),
      draftRevision: mutating ? turn + 1 : null,
      terminalState: interruption && turn === 0 ? 'cancelled' : 'completed',
      audioFenceDigest: DIGEST(`audio-fence:${caseId}:${index}:${turn}`),
    })),
    reads: requirements.reads.map((useCase, readIndex) => ({
      useCase,
      entityType,
      entityIdHash: readIndex === 0 ? entityIdHash : DIGEST(`${caseId}:${index}:entity:${readIndex}`),
      snapshotHash: DIGEST(`${caseId}:${index}:before:${readIndex}`),
    })),
    decisions: mutating ? [
      {
        decisionId: `decision-voice-${caseId}-${index}`,
        candidateSetHash: DIGEST(`candidates:${caseId}:${index}`),
        choiceIdHash: DIGEST(`choice:${caseId}:${index}`),
        source: 'voice',
        baseRevision: 1,
      },
      {
        decisionId: `decision-tap-${caseId}-${index}`,
        candidateSetHash: DIGEST(`candidates:${caseId}:${index}`),
        choiceIdHash: DIGEST(`choice:${caseId}:${index}`),
        source: 'tap',
        baseRevision: 1,
      },
    ] : [],
    proposals: mutating ? [{
      proposalId: `proposal-${caseId}-${index}`,
      tool: requirements.tool,
      argsHash: DIGEST(`args:${caseId}:${index}`),
      controlGrantId: `grant-${caseId}-${index}`,
      audioAcknowledgementId: `audio-ack-${caseId}-${index}`,
    }] : [],
    writes: mutating ? [{
      useCase: requirements.write,
      entityType,
      entityIdHash,
      idempotencyKeyHash: DIGEST(`idempotency:${caseId}:${index}`),
      beforeHash: DIGEST(`${caseId}:${index}:before`),
      afterHash,
      journalRunId: `journal-${caseId}-${index}`,
    }] : [],
    rereads: mutating ? [{ entityType, entityIdHash, snapshotHash: afterHash }] : [],
  };
}

function evidenceFor(context, overrides = {}) {
  const startMs = Date.now();
  const endMs = startMs + 12_000;
  const trafficClasses = [
    ...Array.from({ length: 55 }, () => 'read'),
    ...Array.from({ length: 15 }, () => 'live'),
    ...Array.from({ length: 15 }, () => 'idempotentWrite'),
    ...Array.from({ length: 5 }, () => 'confirmedFinancialMutation'),
    ...Array.from({ length: 5 }, () => 'document'),
    ...Array.from({ length: 5 }, () => 'job'),
  ];
  const httpOperations = trafficClasses.map((trafficClass, index) => {
    const operationId = index === 0 ? 'expected-capacity-rejection-1' : `operation-${index}`;
    const startedAt = startMs + 100 + index;
    return {
      operationId,
      trafficClass,
      stage: 'mixed',
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(startedAt + 100).toISOString(),
      statusKind: index === 0 ? 'expected-rejection' : 'success',
    };
  });
  const liveStages = ['live-10', 'live-25', 'live-50'];
  const missionProofs = Object.fromEntries(BOB_LIVE_JARVIS_MISSIONS.map((caseId, caseIndex) => [
    caseId,
    liveStages.map((stage, stageIndex) => missionEnvelope(
      context,
      caseId,
      caseIndex * liveStages.length + stageIndex,
      stage,
      startMs,
      endMs,
    )),
  ]));
  const failureProofs = Object.fromEntries(BOB_LIVE_FAILURE_SCENARIOS.map((scenario, index) => [
    scenario,
    {
      scenario,
      injectedAt: new Date(startMs + 1_000 + index * 100).toISOString(),
      recoveredAt: new Date(startMs + 2_000 + index * 100).toISOString(),
      boundedImpactCount: 1,
      unboundedImpactCount: 0,
      evidenceDigest: DIGEST(`failure:${scenario}`),
    },
  ]));
  const base = {
    contractVersion: BOB_LIVE_LOAD_CONTRACT_VERSION,
    runId: context.runId,
    preflightDigest: context.preflightDigest,
    profileId: 'cohort-100',
    pass: 'deterministic',
    runKind: 'smoke',
    attempt: 1,
    releaseSha: SHA,
    startedAt: new Date(startMs).toISOString(),
    completedAt: new Date(endMs).toISOString(),
    rawEvidenceSha256: DIGEST(`raw:${context.runId}`),
    topology: {
      deploymentId: 'local-c3-test',
      providerId: 'openai',
      model: 'gpt-realtime-2.1',
      apiReplicas: 1,
      databasePoolMax: 20,
      globalCapacity: 100,
      providerCapacity: 100,
      capacityConfigVersion: 1,
      sourceShardAttestations: [{
        shard: 0,
        networkFingerprint: DIGEST('source-0'),
        runNonce: context.preflightDigest,
        observedAt: new Date(startMs).toISOString(),
      }],
    },
    workload: {
      populationSeeded: 100,
      sustainedVirtualUsers: 25,
      burstVirtualUsers: 75,
      requestIntervalSeconds: 5,
      liveStages: [10, 25, 50],
      liveStageRampSeconds: 1,
      liveStageHoldSeconds: 1,
      liveSoakSeconds: 1,
      mixedSoakSeconds: 1,
      faultInjectionSeconds: 1,
      cleanupSeconds: 1,
      peakConcurrentLiveSessions: 65,
      livePeakSeconds: 1,
      maxStableLiveSessions: 65,
      trafficCounts: {
        read: 55,
        live: 15,
        idempotentWrite: 15,
        confirmedFinancialMutation: 5,
        document: 5,
        job: 5,
      },
    },
    outcomes: {
      requestCount: 100,
      successCount: 99,
      expectedRejections: [{
        operationId: 'expected-capacity-rejection-1',
        reason: 'global_capacity',
        faultScenario: 'capacity-n-plus-one',
        evidenceDigest: DIGEST('expected-capacity-rejection-1'),
      }],
      unexpectedHttp4xxCount: 0,
      unexpectedRateLimitCount: 0,
      timeoutCount: 0,
      http5xxCount: 0,
      protocolErrorCount: 0,
      cancelledCount: 0,
      silentErrorCount: 0,
      missingResultCount: 0,
      liveSetupAttemptCount: 100,
      liveSetupSuccessCount: 100,
    },
    latency: {
      httpOperations,
      criticalWrites: httpOperations
        .filter((operation) => operation.trafficClass === 'confirmedFinancialMutation')
        .map((operation) => ({
          operationId: operation.operationId,
          startedAt: operation.startedAt,
          completedAt: operation.completedAt,
        })),
      acousticStages: [],
    },
    resources: {
      sampleIntervalSeconds: 1,
      apiCpuPercent: Array.from({ length: 10 }, (_, index) => ({
        observedAt: new Date(startMs + index * 1_000).toISOString(), value: 40,
      })),
      apiMemoryPercent: Array.from({ length: 10 }, (_, index) => ({
        observedAt: new Date(startMs + index * 1_000).toISOString(), value: 50,
      })),
      databaseCpuPercent: Array.from({ length: 10 }, (_, index) => ({
        observedAt: new Date(startMs + index * 1_000).toISOString(), value: 35,
      })),
      databaseMemoryPercent: Array.from({ length: 10 }, (_, index) => ({
        observedAt: new Date(startMs + index * 1_000).toISOString(), value: 45,
      })),
      databasePoolPercent: Array.from({ length: 10 }, (_, index) => ({
        observedAt: new Date(startMs + index * 1_000).toISOString(), value: 60,
      })),
    },
    safety: {
      tenantLeakCount: 0,
      ghostMutationCount: 0,
      doubleMutationCount: 0,
      lostControlCount: 0,
      cancelledAudioResumeCount: 0,
    },
    missionProofs,
    failureProofs,
  };
  return { ...base, ...overrides };
}

test('a bound deterministic run passes all control gates but can never publish capacity alone', async () => {
  const context = await prepareBobLiveLoadRun(parseBobLiveLoadEnvironment(environment()));
  const verdict = evaluateBobLiveLoadEvidence(context, evidenceFor(context));
  assert.equal(verdict.runPassed, true);
  assert.equal(verdict.preflightDigest, context.preflightDigest);
  assert.equal(verdict.metrics.acoustics, null);
  assert.equal(Object.hasOwn(verdict, 'publicationEligible'), false);
});

test('refuses generic mission evidence and requires voice/tap parity through the same mission contract', async () => {
  const missingReadContext = await prepareBobLiveLoadRun(parseBobLiveLoadEnvironment(environment()));
  const missingRead = evidenceFor(missingReadContext);
  missingRead.missionProofs['quote-one-shot'][0].reads = [
    missingRead.missionProofs['quote-one-shot'][0].reads[0],
  ];
  assert.throws(
    () => evaluateBobLiveLoadEvidence(missingReadContext, missingRead),
    /required authoritative read/u,
  );

  const parityContext = await prepareBobLiveLoadRun(parseBobLiveLoadEnvironment(environment()));
  const withoutTap = evidenceFor(parityContext);
  withoutTap.missionProofs['catalogue-disambiguation'] = withoutTap
    .missionProofs['catalogue-disambiguation']
    .map((mission) => ({
      ...mission,
      decisions: mission.decisions.filter((decision) => decision.source === 'voice'),
    }));
  const verdict = evaluateBobLiveLoadEvidence(parityContext, withoutTap);
  assert.equal(verdict.checks.missions, false);
  assert.equal(verdict.runPassed, false);
});

test('refuses direct evaluation, context replay and incomplete measurement cardinality', async () => {
  assert.throws(() => evaluateBobLiveLoadEvidence({}, {}), /mandatory preflight/u);
  const context = await prepareBobLiveLoadRun(parseBobLiveLoadEnvironment(environment()));
  const evidence = evidenceFor(context);
  assert.throws(
    () => evaluateBobLiveLoadEvidence(context, {
      ...evidence,
      latency: { ...evidence.latency, httpOperations: [evidence.latency.httpOperations[0]] },
    }),
    /operation count/u,
  );
  assert.throws(() => evaluateBobLiveLoadEvidence(context, evidence), /already been consumed/u);
});

test('binds acoustic samples to each Live stage and rejects slow evidence', () => {
  const startMs = Date.now();
  const endMs = startMs + 60_000;
  const configuration = {
    pass: 'gpt-realtime',
    runKind: 'certification',
    profile: { liveStages: [10, 25, 50] },
  };
  const stages = configuration.profile.liveStages.map((concurrency, stageIndex) => {
    const count = Math.max(30, concurrency);
    return {
      concurrency,
      firstAudio: Array.from({ length: count }, (_, index) => ({
        sessionProofId: `first-${stageIndex}-${index}`,
        turnId: `turn-first-${stageIndex}-${index}`,
        startedAt: new Date(startMs + 1_000).toISOString(),
        terminalAt: new Date(startMs + 1_800).toISOString(),
        terminalEvent: 'first-audio-frame',
      })),
      bargeIn: Array.from({ length: count }, (_, index) => ({
        sessionProofId: `barge-${stageIndex}-${index}`,
        turnId: `turn-barge-${stageIndex}-${index}`,
        startedAt: new Date(startMs + 2_000).toISOString(),
        terminalAt: new Date(startMs + 2_200).toISOString(),
        terminalEvent: 'audio-output-cleared',
      })),
    };
  });
  const metrics = validateBobLiveAcousticEvidence(configuration, stages, startMs, endMs);
  assert.equal(metrics.firstAudioP95Ms, 800);
  stages[2].firstAudio = stages[2].firstAudio.map((sample) => ({
    ...sample,
    terminalAt: new Date(Date.parse(sample.startedAt) + 2_000).toISOString(),
  }));
  const slow = validateBobLiveAcousticEvidence(configuration, stages, startMs, endMs);
  assert.equal(slow.firstAudioP95Ms > 1_800, true);
});

function runVerdict(pass, attempt, index) {
  return {
    contractVersion: BOB_LIVE_LOAD_CONTRACT_VERSION,
    runId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    rawEvidenceSha256: DIGEST(`evidence:${index}`),
    topologyDigest: DIGEST('logical-topology'),
    profileId: 'cohort-100',
    releaseSha: SHA,
    pass,
    runKind: 'certification',
    attempt,
    runPassed: true,
  };
}

function publicationEvidence(overrides = {}) {
  const completedAt = Date.now();
  const startedAt = completedAt - 7 * 24 * 60 * 60_000;
  return {
    contractVersion: BOB_LIVE_LOAD_CONTRACT_VERSION,
    profileId: 'cohort-100',
    releaseSha: SHA,
    prerequisites: {
      c1Certified: true,
      c2Certified: true,
      providerChanged: false,
      c4Certified: false,
    },
    previousCohortCertificate: null,
    deterministicRuns: [1, 2, 3].map((attempt, index) => runVerdict('deterministic', attempt, index + 1)),
    gptRealtimeRuns: [1, 2, 3].map((attempt, index) => runVerdict('gpt-realtime', attempt, index + 4)),
    monitoring: {
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
      sampleIntervalSeconds: 300,
      sampleCount: 2_016,
      sloViolationCount: 0,
      securityIncidentCount: 0,
      unresolvedAlertCount: 0,
      evidenceDigest: DIGEST('monitoring'),
    },
    ...overrides,
  };
}

test('creates only a signing candidate after exact 3x deterministic + GPT runs and seven clean days', () => {
  const verdict = deriveBobLivePublicationCandidateProjection(publicationEvidence());
  assert.equal(verdict.candidateEligible, true);
  assert.equal(Object.hasOwn(verdict, 'publicationEligible'), false);
  assert.match(verdict.candidateDigest, /^[a-f0-9]{64}$/u);

  const incomplete = publicationEvidence();
  incomplete.gptRealtimeRuns = incomplete.gptRealtimeRuns.slice(0, 2);
  assert.throws(() => deriveBobLivePublicationCandidateProjection(incomplete), /exactly three runs/u);

  const short = publicationEvidence();
  short.monitoring = {
    ...short.monitoring,
    startedAt: new Date(Date.parse(short.monitoring.completedAt) - (7 * 24 * 60 * 60_000 - 1_000)).toISOString(),
  };
  assert.throws(() => deriveBobLivePublicationCandidateProjection(short), /at least seven days/u);
});

test('keeps the planned run duration explicit and sequential', () => {
  const configuration = parseBobLiveLoadEnvironment(environment());
  assert.equal(bobLivePlannedRunSeconds(configuration.profile, 1), 14_760);
  assert.equal(bobLivePlannedRunSeconds(configuration.profile, configuration.durationScale), 2);
});

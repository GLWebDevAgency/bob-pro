import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authenticateM1BStagingAccount,
  describeM1BOperationFailure,
  parseM1BStagingSmokeEnvironment,
  preflightM1BStagingAccount,
  runM1BNegativeStagingSmoke,
  runM1BPositiveStagingSmoke,
  validateM1BStagingAccessToken,
} from './agent-mission-m1b-staging-smoke.mjs';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const START_COMMAND_ID = '33333333-3333-4333-8333-333333333333';
const ACK_COMMAND_ID = '44444444-4444-4444-8444-444444444444';
const CANCEL_COMMAND_ID = '55555555-5555-4555-8555-555555555555';
const MISSION_ID = '66666666-6666-4666-8666-666666666666';
const COMPANY_ID = 'company-staging';
const DRAFT_SESSION_ID = 'draft-m1b-staging';
const CONTEXT_DIGEST = 'a'.repeat(64);
const ANSWER_SDP = `v=0\r\n${'a'.repeat(80)}`;
const OFFER_SDP = `v=0\r\n${'o'.repeat(80)}`;

function environment(overrides = {}) {
  return {
    API_BASE_URL: 'https://api-staging.bob.test',
    SUPABASE_URL: 'https://supabase-staging.bob.test',
    BOB_M1B_STAGING_SUPABASE_ANON_KEY: 'anon-public-key-staging',
    BOB_M1B_STAGING_ACCOUNT_EMAIL: 'm1b-staging@bob.test',
    BOB_M1B_STAGING_ACCOUNT_PASSWORD: 'staging-password',
    BOB_M1B_STAGING_USER_ID: USER_ID,
    BOB_M1B_STAGING_COMPANY_ID: COMPANY_ID,
    ...overrides,
  };
}

function token(overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: USER_ID,
    aud: 'authenticated',
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    app_metadata: { company_id: COMPANY_ID },
    ...overrides,
  })).toString('base64url');
  return `${header}.${payload}.${'s'.repeat(64)}`;
}

function activeMission(revision = 1, phase = 'awaiting_quote_screen', binding = null) {
  return {
    id: MISSION_ID,
    status: 'active',
    actionable: true,
    phase,
    revision,
    currentBinding: binding,
    payload: {
      draft: {
        sessionId: DRAFT_SESSION_ID,
        slotRevision: 1,
        contentRevision: 0,
      },
    },
  };
}

function cancelledMission(revision) {
  return {
    ...activeMission(revision, 'awaiting_customer'),
    status: 'cancelled',
    actionable: false,
    terminalAt: '2026-07-27T12:00:00.000Z',
  };
}

function quoteDraft(meaningful = false) {
  return {
    revision: 1,
    payloadVersion: 1,
    payload: {
      version: 1,
      draft: {
        sessionId: DRAFT_SESSION_ID,
        contentRevision: 0,
      },
      meaningful,
    },
  };
}

function fakeDependencies(options = {}) {
  const events = [];
  const ids = [
    SESSION_ID,
    START_COMMAND_ID,
    ACK_COMMAND_ID,
    CANCEL_COMMAND_ID,
  ];
  let draft = options.preexistingDraft ?? null;
  let mission = options.preexistingMission ?? null;
  let startAttempts = 0;
  let acknowledgementAttempts = 0;
  let cancelAttempts = 0;
  let finalEvidenceAttempts = 0;
  let negativeFinalEvidenceAttempts = 0;
  const missionSession = {
    protocolVersion: 1,
    realtimeSessionId: SESSION_ID,
    disposed: false,
    async getCurrentQuoteCreation() {
      events.push('mission:get-current');
      return { ok: true, value: { mission } };
    },
    async startQuoteCreation(input) {
      startAttempts += 1;
      events.push(`mission:start:${input.commandId}`);
      mission = activeMission();
      draft = quoteDraft();
      if (
        options.startError !== undefined
        && startAttempts <= (options.startErrorAttempts ?? 1)
      ) {
        return { ok: false, error: options.startError };
      }
      return {
        ok: true,
        value: {
          outcome: startAttempts > 1 ? 'replayed' : 'created',
          startOutcome: 'no_slot',
          mission,
        },
      };
    },
    async acknowledgeQuoteScreen(input) {
      acknowledgementAttempts += 1;
      events.push(`mission:ack:${input.commandId}`);
      if (
        options.ackError !== undefined
        && acknowledgementAttempts <= (options.ackErrorAttempts ?? 1)
      ) {
        return { ok: false, error: options.ackError };
      }
      mission = activeMission(2, 'awaiting_customer', {
        realtimeSessionId: SESSION_ID,
        contextRevision: 1,
        contextDigest: CONTEXT_DIGEST,
        screenName: '/devis/new',
        screenInstanceId: 'devis-new:m1b-staging',
      });
      return {
        ok: true,
        value: {
          outcome: 'acknowledged',
          mission,
        },
      };
    },
    async cancelQuoteCreation(input) {
      cancelAttempts += 1;
      events.push(`mission:cancel:${input.expectedMissionRevision}`);
      mission = cancelledMission(input.expectedMissionRevision + 1);
      if (
        options.cancelError !== undefined
        && cancelAttempts <= (options.cancelErrorAttempts ?? 1)
      ) {
        return { ok: false, error: options.cancelError };
      }
      return {
        ok: true,
        value: {
          outcome: cancelAttempts > 1 ? 'replayed' : 'cancelled',
          mission,
        },
      };
    },
    dispose() {
      events.push('mission:dispose');
      this.disposed = true;
    },
  };
  const client = {
    async getCompanyMe() {
      events.push('company:get');
      return { ok: true, value: { id: COMPANY_ID } };
    },
    async getQuoteDraft() {
      events.push('draft:get');
      return { ok: true, value: draft };
    },
    async deleteQuoteDraft(revision) {
      events.push(`draft:delete:${revision}`);
      if (options.deleteError) return { ok: false, error: options.deleteError };
      draft = null;
      return { ok: true, value: { deleted: true } };
    },
    async realtimeVoiceConfig() {
      events.push('realtime:config');
      return {
        ok: true,
        value: {
          available: true,
          transport: options.transport ?? 'webrtc',
          speechDelivery: options.speechDelivery ?? 'openai-native-webrtc-v1',
          configVersion: 'bob-live-provider-neutral-v4',
          model: 'gpt-realtime',
          voice: 'marin',
          maxSessionSeconds: 600,
        },
      };
    },
    async createRealtimeVoiceCall(input) {
      events.push(`realtime:create:${input.agentMissionProtocolVersion}`);
      const call = {
        transport: 'webrtc',
        sessionHandle: SESSION_ID,
        configVersion: 'bob-live-provider-neutral-v4',
        model: 'gpt-realtime',
        voice: 'marin',
        maxSessionSeconds: 600,
        speechDelivery: options.speechDelivery ?? 'openai-native-webrtc-v1',
        answerSdp: ANSWER_SDP,
        hardExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
      Object.defineProperty(call, 'agentMissionSession', {
        value: options.agentMissionOff === true ? null : missionSession,
        enumerable: false,
      });
      return { ok: true, value: call };
    },
    async updateRealtimeVoiceContext(_sessionHandle, input) {
      events.push(`context:update:${input.revision}:${input.context.screen.name}`);
      return {
        ok: true,
        value: {
          revision: 1,
          contextDigest: CONTEXT_DIGEST,
        },
      };
    },
    async hangupRealtimeVoiceCall() {
      events.push('realtime:hangup');
      return options.hangupError
        ? { ok: false, error: options.hangupError }
        : { ok: true, value: { ended: true } };
    },
  };
  const peer = {
    offerSdp: OFFER_SDP,
    async applyAnswer(answer) {
      events.push(`peer:answer:${answer === ANSWER_SDP}`);
    },
    async close() {
      events.push('peer:close');
    },
  };
  return {
    events,
    dependencies: {
      authenticate: async () => ({ accessToken: token() }),
      createClient: async () => client,
      createPeer: async () => peer,
      randomUUID: () => ids.shift(),
      isMeaningfulQuoteDraftPayload: (payload) => payload.meaningful === true,
      certifyCleanEvidence() {
        events.push('evidence:clean');
        return { stage: 'clean', passed: true };
      },
      certifyStartRecoveryEvidence(input) {
        events.push(`evidence:start-recovery:${input.startCommandId}`);
        return {
          stage: 'start-recovered',
          passed: true,
          mission,
        };
      },
      certifyCancellationRecoveryEvidence(input) {
        events.push(`evidence:cancel-recovery:${input.cancelCommandId}`);
        return {
          stage: 'cancellation-recovered',
          passed: true,
          mission,
        };
      },
      sleep: async () => {
        events.push('sleep');
      },
      certifyActiveEvidence(input) {
        events.push(`evidence:active:${input.missionRevision}`);
        return { stage: 'active', passed: true };
      },
      certifyFinalEvidence(input) {
        finalEvidenceAttempts += 1;
        events.push(`evidence:final:${input.missionRevision}`);
        if (
          options.finalEvidencePending
          && finalEvidenceAttempts <= options.finalEvidencePending
        ) {
          throw new Error(
            'agent-mission-m1b-staging-evidence:final runtime cleanup proof did not pass exactly',
          );
        }
        return { stage: 'final', passed: true };
      },
      certifyNegativeFinalEvidence(input) {
        negativeFinalEvidenceAttempts += 1;
        events.push(`evidence:negative-final:${input.sessionId}`);
        if (
          options.negativeFinalEvidencePending
          && negativeFinalEvidenceAttempts <= options.negativeFinalEvidencePending
        ) {
          throw new Error(
            'agent-mission-m1b-staging-evidence:negative runtime cleanup proof did not pass exactly',
          );
        }
        return { stage: 'negative-final', passed: true };
      },
    },
    state() {
      return {
        draft,
        mission,
        startAttempts,
        acknowledgementAttempts,
        cancelAttempts,
        finalEvidenceAttempts,
        negativeFinalEvidenceAttempts,
      };
    },
  };
}

test('parse les origines HTTPS et refuse une identité staging ambiguë', () => {
  assert.deepEqual(parseM1BStagingSmokeEnvironment(environment()), {
    apiBaseUrl: 'https://api-staging.bob.test',
    supabaseUrl: 'https://supabase-staging.bob.test',
    supabaseAnonKey: 'anon-public-key-staging',
    email: 'm1b-staging@bob.test',
    password: 'staging-password',
    userId: USER_ID,
    companyId: COMPANY_ID,
  });
  assert.throws(
    () => parseM1BStagingSmokeEnvironment(environment({
      API_BASE_URL: 'https://user:secret@api-staging.bob.test',
    })),
    /credential-free HTTPS origin/u,
  );
  assert.throws(
    () => parseM1BStagingSmokeEnvironment(environment({
      BOB_M1B_STAGING_USER_ID: 'user-staging',
    })),
    /must be a UUID/u,
  );
});

test('valide le sub, le tenant, audience et expiration du JWT utilisateur réel', () => {
  const config = parseM1BStagingSmokeEnvironment(environment());
  assert.equal(validateM1BStagingAccessToken(token(), config), token());
  assert.throws(
    () => validateM1BStagingAccessToken(token({
      app_metadata: { company_id: 'company-other' },
    }), config),
    /identity or expiry/u,
  );
  assert.throws(
    () => validateM1BStagingAccessToken(token({ aud: 'service_role' }), config),
    /identity or expiry/u,
  );
});

test('password grant Supabase utilise seulement la clé anon et vérifie le compte retourné', async () => {
  const calls = [];
  const config = parseM1BStagingSmokeEnvironment(environment());
  const authentication = await authenticateM1BStagingAccount(config, {
    async fetch(url, init) {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        access_token: token(),
        user: {
          id: USER_ID,
          app_metadata: { company_id: COMPANY_ID },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(authentication.accessToken, token());
  assert.equal(
    calls[0].url,
    'https://supabase-staging.bob.test/auth/v1/token?grant_type=password',
  );
  assert.equal(calls[0].init.headers.apikey, 'anon-public-key-staging');
  assert.equal(Object.hasOwn(calls[0].init.headers, 'authorization'), false);
  assert.equal(calls[0].init.redirect, 'error');
});

test('préflight réseau prouve le vrai tenant et Bob Live OpenAI avant le build sans exposer l’identité', async () => {
  const calls = [];
  const result = await preflightM1BStagingAccount(environment(), {
    async fetch(url, init) {
      calls.push({ url, init });
      if (url.includes('/auth/v1/token')) {
        return new Response(JSON.stringify({
          access_token: token(),
          user: {
            id: USER_ID,
            app_metadata: { company_id: COMPANY_ID },
          },
        }), { status: 200 });
      }
      if (url.endsWith('/company/me')) {
        return new Response(JSON.stringify({ id: COMPANY_ID }), { status: 200 });
      }
      return new Response(JSON.stringify({
        available: true,
        transport: 'webrtc',
        speechDelivery: 'openai-native-webrtc-v1',
        configVersion: 'bob-live-provider-neutral-v4',
        model: 'gpt-realtime',
        voice: 'marin',
        maxSessionSeconds: 600,
      }), { status: 200 });
    },
  });
  assert.deepEqual(result, {
    mode: 'preflight',
    passed: true,
    account: 'eligible',
    transport: 'webrtc',
    speechDelivery: 'openai-native-webrtc-v1',
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].init.headers.authorization, `Bearer ${token()}`);
  assert.equal(calls[2].init.headers.authorization, `Bearer ${token()}`);
  assert.equal(JSON.stringify(result).includes(USER_ID), false);
  assert.equal(JSON.stringify(result).includes(COMPANY_ID), false);
});

test('préflight réseau publie seulement la cause bornée d’un entitlement absent', async () => {
  const responses = [
    {
      access_token: token(),
      user: { id: USER_ID, app_metadata: { company_id: COMPANY_ID } },
    },
    { id: COMPANY_ID },
    {
      available: false,
      availabilityReason: 'entitlement_unavailable',
      transport: 'webrtc',
      speechDelivery: 'openai-native-webrtc-v1',
      configVersion: 'bob-live-provider-neutral-v4',
      model: 'gpt-realtime',
      voice: 'marin',
      maxSessionSeconds: 600,
    },
  ];
  let index = 0;
  await assert.rejects(
    preflightM1BStagingAccount(environment(), {
      async fetch() {
        return new Response(JSON.stringify(responses[index++]), { status: 200 });
      },
    }),
    (error) => {
      assert.match(error.message, /reason=entitlement_unavailable/u);
      assert.equal(error.message.includes(USER_ID), false);
      assert.equal(error.message.includes(COMPANY_ID), false);
      assert.equal(error.message.includes('m1b-staging@bob.test'), false);
      return true;
    },
  );
});

test('preuve OFF établit une vraie session WebRTC avec capability Mission nulle', async () => {
  const fake = fakeDependencies({ agentMissionOff: true });
  const result = await runM1BNegativeStagingSmoke(environment(), fake.dependencies);
  assert.deepEqual(result, {
    mode: 'negative',
    passed: true,
    speechDelivery: 'openai-native-webrtc-v1',
    agentMission: 'off',
    cleanup: 'complete',
    hangupAccepted: true,
  });
  assert.deepEqual(fake.events, [
    'company:get',
    'evidence:clean',
    'draft:get',
    'realtime:config',
    'realtime:create:1',
    'peer:answer:true',
    'realtime:hangup',
    'peer:close',
    `evidence:negative-final:${SESSION_ID}`,
  ]);
});

test('preuve OFF repolle la lease exacte après un hangup indisponible', async () => {
  const fake = fakeDependencies({
    agentMissionOff: true,
    hangupError: { kind: 'unavailable' },
    negativeFinalEvidencePending: 2,
  });
  const result = await runM1BNegativeStagingSmoke(environment(), fake.dependencies);
  assert.equal(result.cleanup, 'complete');
  assert.equal(result.hangupAccepted, false);
  assert.equal(fake.state().negativeFinalEvidenceAttempts, 3);
});

test('preuve positive lie écran, mission, DB/RLS puis nettoie dans l’ordre sûr', async () => {
  const fake = fakeDependencies({ hangupError: { kind: 'unavailable' } });
  const result = await runM1BPositiveStagingSmoke(environment(), fake.dependencies);
  assert.deepEqual(result, {
    mode: 'positive',
    passed: true,
    speechDelivery: 'openai-native-webrtc-v1',
    missionStage: 'awaiting_customer',
    cleanup: 'complete',
    hangupAccepted: false,
  });
  assert.equal(fake.state().draft, null);
  assert.equal(fake.state().mission.status, 'cancelled');
  const cancel = fake.events.indexOf('mission:cancel:2');
  const deletion = fake.events.indexOf('draft:delete:1');
  const hangup = fake.events.indexOf('realtime:hangup');
  const peerClose = fake.events.indexOf('peer:close');
  const dispose = fake.events.indexOf('mission:dispose');
  const finalEvidence = fake.events.indexOf('evidence:final:3');
  assert.equal(cancel < deletion, true);
  assert.equal(deletion < hangup, true);
  assert.equal(hangup < peerClose, true);
  assert.equal(peerClose < dispose, true);
  assert.equal(dispose < finalEvidence, true);
});

test('retry screen ACK seulement sur context_stale et conserve le commandId', async () => {
  const fake = fakeDependencies({
    ackError: {
      kind: 'conflict',
      entity: 'agent_mission_screen_ack',
      reason: 'context_stale',
    },
    ackErrorAttempts: 2,
  });
  await runM1BPositiveStagingSmoke(environment(), fake.dependencies);
  assert.equal(fake.state().acknowledgementAttempts, 3);
  assert.equal(
    fake.events.filter((event) => event === `mission:ack:${ACK_COMMAND_ID}`).length,
    3,
  );
  assert.equal(fake.events.filter((event) => event === 'sleep').length, 2);
});

test('rejoue une réponse start perdue une seule fois avec le même commandId', async () => {
  const fake = fakeDependencies({
    startError: {
      kind: 'dependency',
      port: 'api',
      cause: 'response_lost',
    },
  });
  await runM1BPositiveStagingSmoke(environment(), fake.dependencies);
  assert.equal(fake.state().startAttempts, 2);
  assert.equal(
    fake.events.filter((event) => event === `mission:start:${START_COMMAND_ID}`).length,
    2,
  );
});

test('récupère par commandId deux réponses start perdues puis nettoie sa mission', async () => {
  const fake = fakeDependencies({
    startError: {
      kind: 'dependency',
      port: 'api',
      cause: 'response_lost',
    },
    startErrorAttempts: 2,
  });
  await runM1BPositiveStagingSmoke(environment(), fake.dependencies);
  assert.equal(fake.state().startAttempts, 2);
  assert.equal(
    fake.events.includes(`evidence:start-recovery:${START_COMMAND_ID}`),
    true,
  );
  assert.equal(fake.state().mission.status, 'cancelled');
  assert.equal(fake.state().draft, null);
});

test('récupère une double réponse cancel perdue avant de supprimer le brouillon', async () => {
  const fake = fakeDependencies({
    cancelError: {
      kind: 'dependency',
      port: 'api',
      cause: 'response_lost',
    },
    cancelErrorAttempts: 2,
  });
  await runM1BPositiveStagingSmoke(environment(), fake.dependencies);
  assert.equal(fake.state().cancelAttempts, 2);
  assert.equal(
    fake.events.includes(`evidence:cancel-recovery:${CANCEL_COMMAND_ID}`),
    true,
  );
  assert.equal(fake.state().mission.status, 'cancelled');
  assert.equal(fake.state().draft, null);
  assert.equal(
    fake.events.indexOf(`evidence:cancel-recovery:${CANCEL_COMMAND_ID}`)
      < fake.events.indexOf('draft:delete:1'),
    true,
  );
});

test('une autre erreur ACK échoue mais annule uniquement la mission créée par le run', async () => {
  const fake = fakeDependencies({
    ackError: {
      kind: 'conflict',
      entity: 'agent_mission',
      reason: 'stale_revision',
    },
  });
  await assert.rejects(
    runM1BPositiveStagingSmoke(environment(), fake.dependencies),
    /outside the bounded context_stale retry contract/u,
  );
  assert.equal(fake.state().mission.status, 'cancelled');
  assert.equal(fake.state().mission.revision, 2);
  assert.equal(fake.state().draft, null);
  assert.equal(fake.events.includes('mission:cancel:1'), true);
  assert.equal(fake.events.includes('realtime:hangup'), true);
  assert.equal(fake.events.includes('mission:dispose'), true);
});

test('refuse tout brouillon préexistant sans démarrer WebRTC ni le supprimer', async () => {
  const existing = quoteDraft();
  const fake = fakeDependencies({ preexistingDraft: existing });
  await assert.rejects(
    runM1BPositiveStagingSmoke(environment(), fake.dependencies),
    /already contains a quote draft/u,
  );
  assert.equal(fake.state().draft, existing);
  assert.equal(fake.events.includes('realtime:config'), false);
  assert.equal(fake.events.some((event) => event.startsWith('draft:delete')), false);
});

test('refuse Mistral et repolle uniquement la disparition transitoire de la lease', async () => {
  const mistral = fakeDependencies({
    transport: 'mistral-pcm',
    speechDelivery: 'audited-signed-url-v1',
  });
  await assert.rejects(
    runM1BPositiveStagingSmoke(environment(), mistral.dependencies),
    /unsupported transport/u,
  );

  const pending = fakeDependencies({ finalEvidencePending: 2 });
  await runM1BPositiveStagingSmoke(environment(), pending.dependencies);
  assert.equal(pending.state().finalEvidenceAttempts, 3);
});

test('la doctrine échec visible sérialise seulement les champs structurés bornés', () => {
  assert.equal(
    describeM1BOperationFailure({ kind: 'dependency', port: 'api', cause: 'http_503' }),
    'kind="dependency" port="api" cause="http_503"',
  );
  assert.equal(
    describeM1BOperationFailure({
      kind: 'unavailable',
      service: 'bob-live-admission',
      retryAfterSeconds: 5,
      retryAt: '2026-07-28T01:08:31.000Z',
    }),
    'kind="unavailable" service="bob-live-admission" retryAt="2026-07-28T01:08:31.000Z" retryAfterSeconds=5',
  );
  assert.equal(describeM1BOperationFailure(undefined), 'error=unstructured');
  assert.equal(describeM1BOperationFailure('boom'), 'error=unstructured');
  assert.equal(
    describeM1BOperationFailure({ issues: [{ field: 'x', message: 'y' }] }),
    'error=unstructured',
  );
  const oversized = describeM1BOperationFailure({ kind: 'a'.repeat(500) });
  assert.ok(oversized.length <= 140, 'oversized structured values must stay bounded');
});

test('un échec d’opération imprime la cause structurée sur stderr avant le fail', async () => {
  const fake = fakeDependencies({
    deleteError: {
      kind: 'conflict',
      entity: 'quote_draft',
      reason: 'stale_revision',
    },
  });
  const stderrLines = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    stderrLines.push(String(chunk));
    return true;
  };
  try {
    await assert.rejects(
      runM1BPositiveStagingSmoke(environment(), fake.dependencies),
      /deleteQuoteDraft failed/u,
    );
  } finally {
    process.stderr.write = originalWrite;
  }
  const line = stderrLines.find((entry) => entry.includes('deleteQuoteDraft failed'));
  assert.equal(
    line,
    'agent-mission-m1b-staging-smoke:deleteQuoteDraft failed'
      + ' kind="conflict" reason="stale_revision" entity="quote_draft"\n',
  );
});

test('une suppression CAS en échec ne masque pas le cleanup du peer et de la capability', async () => {
  const fake = fakeDependencies({
    deleteError: {
      kind: 'conflict',
      entity: 'quote_draft',
      reason: 'stale_revision',
    },
  });
  await assert.rejects(
    runM1BPositiveStagingSmoke(environment(), fake.dependencies),
    /deleteQuoteDraft failed/u,
  );
  assert.equal(fake.events.includes('realtime:hangup'), true);
  assert.equal(fake.events.includes('peer:close'), true);
  assert.equal(fake.events.includes('mission:dispose'), true);
  assert.equal(fake.events.some((event) => event.startsWith('evidence:final')), false);
});

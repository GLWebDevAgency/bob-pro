import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authenticateM1BStagingAccount,
  describeM1BOperationFailure,
  parseM1BStagingSmokeEnvironment,
  preflightM1BStagingAccount,
  runM1BNegativeStagingSmoke,
  runM1BPositiveStagingSmoke,
  runM1BRecoveryStagingSmoke,
  runM2A3PreviewOffStagingSmoke,
  runM2A3PreviewStagingSmoke,
  validateM1BStagingAccessToken,
} from './agent-mission-m1b-staging-smoke.mjs';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const RETRY_SESSION_ID = '77777777-7777-4777-8777-777777777777';
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
  const payload = Buffer.from(
    JSON.stringify({
      sub: USER_ID,
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      app_metadata: { company_id: COMPANY_ID },
      ...overrides,
    }),
  ).toString('base64url');
  return `${header}.${payload}.${'s'.repeat(64)}`;
}

function activeMission(revision = 1, phase = 'awaiting_quote_screen', binding = null) {
  return {
    id: MISSION_ID,
    kind: 'quote_creation',
    status: 'active',
    actionable: true,
    phase,
    revision,
    payloadVersion: 1,
    currentBinding: binding,
    payload: {
      schema: 'bob.agent-mission.quote-creation',
      version: 1,
      draft: {
        sessionId: DRAFT_SESSION_ID,
        slotRevision: 1,
        contentRevision: 0,
      },
      decision: null,
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

function emptyQuoteDraftPayload(sessionId = DRAFT_SESSION_ID) {
  return {
    schema: 'bob.quote-draft',
    version: 1,
    draft: {
      sessionId,
      contentRevision: 0,
      stagingRevision: 0,
      step: 'client',
      customer: null,
      lines: [],
      lineMetadata: [],
      lineForm: {
        label: '',
        quantity: '1',
        unitPrice: '',
        category: 'labor',
      },
      vatDecision: null,
      depositPct: 30,
      signMode: null,
    },
  };
}

function recoveryQuoteDraft(overrides = {}) {
  return {
    revision: 1,
    payloadVersion: 1,
    payload: emptyQuoteDraftPayload(),
    ...overrides,
  };
}

function recoveryCandidate() {
  return {
    missionId: MISSION_ID,
    missionRevision: 1,
    startCommandId: START_COMMAND_ID,
    draftSessionId: DRAFT_SESSION_ID,
    draftSlotRevision: 1,
    draftContentRevision: 0,
  };
}

function fakeDependencies(options = {}) {
  const events = [];
  const ids = [
    ...(options.ids ?? [SESSION_ID, START_COMMAND_ID, ACK_COMMAND_ID, CANCEL_COMMAND_ID]),
  ];
  let draft = options.preexistingDraft ?? null;
  let mission = options.preexistingMission ?? null;
  let realtimeSessionId = SESSION_ID;
  let createAttempts = 0;
  let peerCreations = 0;
  let startAttempts = 0;
  let acknowledgementAttempts = 0;
  let cancelAttempts = 0;
  let finalEvidenceAttempts = 0;
  let negativeFinalEvidenceAttempts = 0;
  let recoveryTerminalEvidenceAttempts = 0;
  const missionSession = {
    protocolVersion: 1,
    get realtimeSessionId() {
      return realtimeSessionId;
    },
    disposed: false,
    async getCurrentQuoteCreation() {
      events.push('mission:get-current');
      return {
        ok: true,
        value: {
          mission: options.currentMissionView ?? mission,
        },
      };
    },
    async startQuoteCreation(input) {
      startAttempts += 1;
      events.push(`mission:start:${input.commandId}`);
      mission = activeMission();
      draft = quoteDraft();
      if (options.startError !== undefined && startAttempts <= (options.startErrorAttempts ?? 1)) {
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
        options.ackError !== undefined &&
        acknowledgementAttempts <= (options.ackErrorAttempts ?? 1)
      ) {
        return { ok: false, error: options.ackError };
      }
      mission = activeMission(2, 'awaiting_customer', {
        realtimeSessionId,
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
      if (options.cancelExpired === true) {
        mission = {
          ...activeMission(input.expectedMissionRevision + 1),
          status: 'expired',
          actionable: false,
          terminalAt: '2026-07-28T04:00:00.000Z',
        };
        return {
          ok: false,
          error: {
            kind: 'conflict',
            entity: 'agent_mission',
            reason: 'expired',
          },
        };
      }
      mission = cancelledMission(input.expectedMissionRevision + 1);
      if (
        options.cancelError !== undefined &&
        cancelAttempts <= (options.cancelErrorAttempts ?? 1)
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
      createAttempts += 1;
      realtimeSessionId = input.sessionHandle;
      missionSession.protocolVersion = input.agentMissionProtocolVersion;
      events.push(`realtime:create:${input.agentMissionProtocolVersion}`);
      if (
        Array.isArray(options.createErrors) &&
        options.createErrors[createAttempts - 1] !== undefined
      ) {
        return { ok: false, error: options.createErrors[createAttempts - 1] };
      }
      const call = {
        transport: 'webrtc',
        sessionHandle: input.sessionHandle,
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
  const createFakePeer = () => ({
    offerSdp: OFFER_SDP,
    async applyAnswer(answer) {
      events.push(`peer:answer:${answer === ANSWER_SDP}`);
    },
    async close() {
      events.push('peer:close');
    },
  });
  const sharedPeer = createFakePeer();
  return {
    events,
    dependencies: {
      authenticate: async () => ({ accessToken: token() }),
      createClient: async () => client,
      createPeer: async () => {
        peerCreations += 1;
        events.push(`peer:create:${peerCreations}`);
        return options.reusePeer === true ? sharedPeer : createFakePeer();
      },
      randomUUID: () => ids.shift(),
      isRealtimeBootstrapTimeoutError: (error) =>
        error?.kind === 'dependency' &&
        error.port === 'api' &&
        error.cause === 'Délai réseau dépassé après 12000 ms.' &&
        Object.keys(error).length === 3,
      isMeaningfulQuoteDraftPayload: (payload) => payload.meaningful === true,
      createEmptyQuoteDraftPayload: (sessionId) => ({
        ok: true,
        value: emptyQuoteDraftPayload(sessionId),
      }),
      certifyCleanEvidence() {
        events.push('evidence:clean');
        return { stage: 'clean', passed: true };
      },
      certifyRecoveryStateEvidence() {
        events.push('evidence:recovery-state');
        if (options.recoveryState === 'clean') {
          return {
            stage: 'recovery-state',
            passed: true,
            state: 'clean',
          };
        }
        return {
          stage: 'recovery-state',
          passed: true,
          state: 'recoverable',
          candidate: recoveryCandidate(),
        };
      },
      certifyRecoveryTerminalEvidence() {
        recoveryTerminalEvidenceAttempts += 1;
        events.push('evidence:recovery-terminal');
        if (
          options.recoveryTerminalEvidencePending &&
          recoveryTerminalEvidenceAttempts <= options.recoveryTerminalEvidencePending
        ) {
          throw new Error(
            'agent-mission-m1b-staging-evidence:recovery terminal proof did not pass exactly',
          );
        }
        return {
          stage: 'recovery-terminal',
          passed: true,
          status: options.recoveryTerminalStatus ?? 'cancelled',
          missionRevision: 2,
        };
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
        if (options.finalEvidencePending && finalEvidenceAttempts <= options.finalEvidencePending) {
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
          options.negativeFinalEvidencePending &&
          negativeFinalEvidenceAttempts <= options.negativeFinalEvidencePending
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
        createAttempts,
        peerCreations,
        startAttempts,
        acknowledgementAttempts,
        cancelAttempts,
        finalEvidenceAttempts,
        negativeFinalEvidenceAttempts,
        recoveryTerminalEvidenceAttempts,
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
    () =>
      parseM1BStagingSmokeEnvironment(
        environment({
          API_BASE_URL: 'https://user:secret@api-staging.bob.test',
        }),
      ),
    /credential-free HTTPS origin/u,
  );
  assert.throws(
    () =>
      parseM1BStagingSmokeEnvironment(
        environment({
          BOB_M1B_STAGING_USER_ID: 'user-staging',
        }),
      ),
    /must be a UUID/u,
  );
});

test('valide le sub, le tenant, audience et expiration du JWT utilisateur réel', () => {
  const config = parseM1BStagingSmokeEnvironment(environment());
  assert.equal(validateM1BStagingAccessToken(token(), config), token());
  assert.throws(
    () =>
      validateM1BStagingAccessToken(
        token({
          app_metadata: { company_id: 'company-other' },
        }),
        config,
      ),
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
      return new Response(
        JSON.stringify({
          access_token: token(),
          user: {
            id: USER_ID,
            app_metadata: { company_id: COMPANY_ID },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    },
  });
  assert.equal(authentication.accessToken, token());
  assert.equal(calls[0].url, 'https://supabase-staging.bob.test/auth/v1/token?grant_type=password');
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
        return new Response(
          JSON.stringify({
            access_token: token(),
            user: {
              id: USER_ID,
              app_metadata: { company_id: COMPANY_ID },
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/company/me')) {
        return new Response(JSON.stringify({ id: COMPANY_ID }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          available: true,
          transport: 'webrtc',
          speechDelivery: 'openai-native-webrtc-v1',
          configVersion: 'bob-live-provider-neutral-v4',
          model: 'gpt-realtime',
          voice: 'marin',
          maxSessionSeconds: 600,
        }),
        { status: 200 },
      );
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

test('préflight réseau publie seulement la classe fermée d’un entitlement absent', async () => {
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
      assert.match(error.message, /class=entitlement_unavailable/u);
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
    bootstrapAttempts: 1,
    recoveredTimeout: false,
  });
  assert.deepEqual(fake.events, [
    'company:get',
    'evidence:clean',
    'draft:get',
    'realtime:config',
    'peer:create:1',
    'realtime:create:1',
    'peer:answer:true',
    'realtime:hangup',
    'peer:close',
    `evidence:negative-final:${SESSION_ID}`,
  ]);
});

test('canary preview négocie V2, lit sans muter puis libère toute la session', async () => {
  const fake = fakeDependencies();
  const result = await runM2A3PreviewStagingSmoke(environment(), fake.dependencies);
  assert.deepEqual(result, {
    mode: 'preview-v2',
    passed: true,
    protocolVersion: 2,
    speechDelivery: 'openai-native-webrtc-v1',
    bootstrapReceipt: 'acknowledged',
    mutation: 'none',
    cleanup: 'complete',
    hangupAccepted: true,
    bootstrapAttempts: 1,
    recoveredTimeout: false,
  });
  assert.deepEqual(fake.events, [
    'company:get',
    'evidence:clean',
    'draft:get',
    'realtime:config',
    'peer:create:1',
    'realtime:create:2',
    'peer:answer:true',
    'mission:get-current',
    'realtime:hangup',
    'peer:close',
    'mission:dispose',
    `evidence:negative-final:${SESSION_ID}`,
  ]);
  assert.equal(fake.state().mission, null);
  assert.equal(fake.state().draft, null);
});

test('canary preview refuse V1/null et réconcilie le transport sans mutation', async () => {
  const wrongProtocol = fakeDependencies();
  const originalCreateClient = wrongProtocol.dependencies.createClient;
  wrongProtocol.dependencies.createClient = async (...args) => {
    const client = await originalCreateClient(...args);
    const originalCreate = client.createRealtimeVoiceCall.bind(client);
    client.createRealtimeVoiceCall = async (input) => {
      const result = await originalCreate(input);
      if (result.ok && result.value.agentMissionSession) {
        result.value.agentMissionSession.protocolVersion = 1;
      }
      return result;
    };
    return client;
  };
  await assert.rejects(
    runM2A3PreviewStagingSmoke(environment(), wrongProtocol.dependencies),
    /Mission V2 capability/u,
  );
  assert.equal(wrongProtocol.events.includes('realtime:hangup'), true);
  assert.equal(wrongProtocol.state().mission, null);

  const noCapability = fakeDependencies({ agentMissionOff: true });
  await assert.rejects(
    runM2A3PreviewStagingSmoke(environment(), noCapability.dependencies),
    /Mission V2 capability/u,
  );
  assert.equal(noCapability.events.includes('realtime:hangup'), true);
});

test('canary preview OFF demande explicitement V2 et exige une capability nulle', async () => {
  const fake = fakeDependencies({ agentMissionOff: true });
  const result = await runM2A3PreviewOffStagingSmoke(environment(), fake.dependencies);
  assert.deepEqual(result, {
    mode: 'preview-v2-off',
    passed: true,
    protocolVersion: 2,
    agentMission: 'off',
    cleanup: 'complete',
    hangupAccepted: true,
    bootstrapAttempts: 1,
    recoveredTimeout: false,
  });
  assert.equal(fake.events.includes('realtime:create:2'), true);
  assert.equal(fake.events.includes('mission:get-current'), false);
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

const bootstrapTimeout = {
  kind: 'dependency',
  port: 'api',
  cause: 'Délai réseau dépassé après 12000 ms.',
};

test('un timeout bootstrap est réconcilié avant un unique retry avec session et peer neufs', async () => {
  const fake = fakeDependencies({
    agentMissionOff: true,
    ids: [SESSION_ID, RETRY_SESSION_ID],
    createErrors: [bootstrapTimeout],
  });

  const result = await runM1BNegativeStagingSmoke(environment(), fake.dependencies);

  assert.equal(result.bootstrapAttempts, 2);
  assert.equal(result.recoveredTimeout, true);
  assert.equal(fake.state().createAttempts, 2);
  assert.equal(fake.state().peerCreations, 2);
  const firstCreate = fake.events.indexOf('realtime:create:1');
  const firstClose = fake.events.indexOf('peer:close', firstCreate);
  const firstHangup = fake.events.indexOf('realtime:hangup', firstClose);
  const reconciled = fake.events.indexOf(`evidence:negative-final:${SESSION_ID}`, firstHangup);
  const secondPeer = fake.events.indexOf('peer:create:2', reconciled);
  const secondCreate = fake.events.indexOf('realtime:create:1', firstCreate + 1);
  assert.equal(
    firstCreate < firstClose &&
      firstClose < firstHangup &&
      firstHangup < reconciled &&
      reconciled < secondPeer &&
      secondPeer < secondCreate,
    true,
  );
});

test('la preuve positive reprend aussi un timeout avant de créer la mission', async () => {
  const fake = fakeDependencies({
    ids: [SESSION_ID, RETRY_SESSION_ID, START_COMMAND_ID, ACK_COMMAND_ID, CANCEL_COMMAND_ID],
    createErrors: [bootstrapTimeout],
  });

  const result = await runM1BPositiveStagingSmoke(environment(), fake.dependencies);

  assert.equal(result.bootstrapAttempts, 2);
  assert.equal(result.recoveredTimeout, true);
  assert.equal(fake.state().createAttempts, 2);
  assert.equal(
    fake.events.indexOf(`evidence:negative-final:${SESSION_ID}`) <
      fake.events.indexOf(`mission:start:${START_COMMAND_ID}`),
    true,
  );
});

test('un second timeout bootstrap échoue fermé après exactement deux POST', async () => {
  const fake = fakeDependencies({
    agentMissionOff: true,
    ids: [SESSION_ID, RETRY_SESSION_ID],
    createErrors: [bootstrapTimeout, bootstrapTimeout],
  });

  await assert.rejects(
    runM1BNegativeStagingSmoke(environment(), fake.dependencies),
    /class=bootstrap_timeout, attempt=2/u,
  );
  assert.equal(fake.state().createAttempts, 2);
  assert.equal(fake.state().negativeFinalEvidenceAttempts, 2);
});

test('aucune erreur bootstrap non ambiguë n’est rejouée et le diagnostic reste borné', async () => {
  const privateValues = [
    'm1b-staging@bob.test',
    COMPANY_ID,
    USER_ID,
    'eyJhbGciOiJSUzI1NiJ9.private.jwt',
    'v=0\r\na=private-sdp',
  ];
  const cases = [
    { kind: 'conflict', entity: privateValues[1], reason: privateValues[4] },
    { kind: 'validation', issues: [{ field: privateValues[2], message: privateValues[0] }] },
    { kind: 'forbidden', reason: privateValues[3] },
    { kind: 'rate_limited', reason: privateValues[0], retryAfterSeconds: 1 },
    { kind: 'unavailable', service: privateValues[1] },
    { kind: 'dependency', port: 'api', cause: 'Requête annulée.' },
    { kind: 'dependency', port: 'api', cause: privateValues[4] },
  ];

  for (const createError of cases) {
    const fake = fakeDependencies({
      agentMissionOff: true,
      createErrors: [createError],
    });
    await assert.rejects(runM1BNegativeStagingSmoke(environment(), fake.dependencies), (error) => {
      assert.match(error.message, /class=[a-z_]+, attempt=1/u);
      for (const value of privateValues) {
        assert.equal(error.message.includes(value), false);
      }
      return true;
    });
    assert.equal(fake.state().createAttempts, 1);
  }
});

test('absence de preuve cleanup, UUID dupliqué ou peer réutilisé interdisent le second POST', async () => {
  const noCleanup = fakeDependencies({
    agentMissionOff: true,
    ids: [SESSION_ID, RETRY_SESSION_ID],
    createErrors: [bootstrapTimeout],
    negativeFinalEvidencePending: 12,
  });
  await assert.rejects(
    runM1BNegativeStagingSmoke(environment(), noCleanup.dependencies),
    /negative runtime cleanup proof/u,
  );
  assert.equal(noCleanup.state().createAttempts, 1);

  const duplicateUuid = fakeDependencies({
    agentMissionOff: true,
    ids: [SESSION_ID, SESSION_ID],
    createErrors: [bootstrapTimeout],
  });
  await assert.rejects(
    runM1BNegativeStagingSmoke(environment(), duplicateUuid.dependencies),
    /reused its session UUID/u,
  );
  assert.equal(duplicateUuid.state().createAttempts, 1);

  const reusedPeer = fakeDependencies({
    agentMissionOff: true,
    ids: [SESSION_ID, RETRY_SESSION_ID],
    createErrors: [bootstrapTimeout],
    reusePeer: true,
  });
  await assert.rejects(
    runM1BNegativeStagingSmoke(environment(), reusedPeer.dependencies),
    /reused its peer/u,
  );
  assert.equal(reusedPeer.state().createAttempts, 1);
  assert.equal(reusedPeer.state().peerCreations, 2);
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
    bootstrapAttempts: 1,
    recoveredTimeout: false,
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
  assert.equal(fake.events.filter((event) => event === `mission:ack:${ACK_COMMAND_ID}`).length, 3);
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
  assert.equal(fake.events.includes(`evidence:start-recovery:${START_COMMAND_ID}`), true);
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
  assert.equal(fake.events.includes(`evidence:cancel-recovery:${CANCEL_COMMAND_ID}`), true);
  assert.equal(fake.state().mission.status, 'cancelled');
  assert.equal(fake.state().draft, null);
  assert.equal(
    fake.events.indexOf(`evidence:cancel-recovery:${CANCEL_COMMAND_ID}`) <
      fake.events.indexOf('draft:delete:1'),
    true,
  );
});

test('une autre erreur ACK échoue mais annule uniquement la mission créée par le run', async () => {
  const privateValues = [COMPANY_ID, USER_ID, 'm1b-staging@bob.test', 'v=0\r\na=private-sdp'];
  const fake = fakeDependencies({
    ackError: {
      kind: 'conflict',
      entity: privateValues[0],
      reason: privateValues[3],
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
      /outside the bounded context_stale retry contract/u,
    );
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(
    stderrLines.find((entry) => entry.includes('screen ACK failed')),
    'agent-mission-m1b-staging-smoke:screen ACK failed class=conflict\n',
  );
  for (const value of privateValues) assert.equal(stderrLines.join('').includes(value), false);
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
  assert.equal(
    fake.events.some((event) => event.startsWith('draft:delete')),
    false,
  );
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

test('la doctrine échec visible publie seulement une classe fermée', () => {
  assert.equal(
    describeM1BOperationFailure({ kind: 'dependency', port: 'api', cause: 'http_503' }),
    'class=dependency',
  );
  assert.equal(
    describeM1BOperationFailure({
      kind: 'unavailable',
      service: 'bob-live-admission',
      retryAfterSeconds: 5,
      retryAt: '2026-07-28T01:08:31.000Z',
    }),
    'class=unavailable',
  );
  assert.equal(describeM1BOperationFailure(undefined), 'class=invalid_result');
  assert.equal(describeM1BOperationFailure('boom'), 'class=invalid_result');
  assert.equal(
    describeM1BOperationFailure({ issues: [{ field: 'x', message: 'y' }] }),
    'class=invalid_result',
  );
  assert.equal(describeM1BOperationFailure({ kind: 'a'.repeat(500) }), 'class=invalid_result');
});

test('un échec d’opération imprime seulement sa classe fermée sur stderr', async () => {
  const privateValues = [COMPANY_ID, USER_ID, 'm1b-staging@bob.test', 'v=0\r\na=private-sdp'];
  const fake = fakeDependencies({
    deleteError: {
      kind: 'conflict',
      entity: privateValues[0],
      reason: privateValues[3],
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
  assert.equal(line, 'agent-mission-m1b-staging-smoke:deleteQuoteDraft failed class=conflict\n');
  for (const value of privateValues) assert.equal(stderrLines.join('').includes(value), false);
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
  assert.equal(
    fake.events.some((event) => event.startsWith('evidence:final')),
    false,
  );
});

test('récupère le résidu technique via une capability neuve sans jamais démarrer de mission', async () => {
  const fake = fakeDependencies({
    preexistingMission: activeMission(),
    preexistingDraft: recoveryQuoteDraft(),
    ids: [SESSION_ID, CANCEL_COMMAND_ID],
  });
  const result = await runM1BRecoveryStagingSmoke(environment(), fake.dependencies);
  assert.deepEqual(result, {
    mode: 'recovery',
    passed: true,
    outcome: 'recovered',
    cleanup: 'complete',
    hangupAccepted: true,
  });
  assert.equal(fake.state().startAttempts, 0);
  assert.equal(fake.state().acknowledgementAttempts, 0);
  assert.equal(fake.state().cancelAttempts, 1);
  assert.equal(fake.state().draft, null);
  assert.equal(fake.events.includes('mission:cancel:1'), true);
  assert.equal(fake.events.includes('evidence:recovery-terminal'), true);
  assert.equal(fake.events.includes('realtime:hangup'), true);
  assert.equal(fake.events.includes('mission:dispose'), true);
});

test('réconcilie deux réponses cancel perdues jusqu’à la preuve terminale tardive', async () => {
  const fake = fakeDependencies({
    preexistingMission: activeMission(),
    preexistingDraft: recoveryQuoteDraft(),
    cancelError: {
      kind: 'dependency',
      port: 'api',
      cause: 'private-response-loss-detail',
    },
    cancelErrorAttempts: 2,
    recoveryTerminalEvidencePending: 1,
    ids: [SESSION_ID, CANCEL_COMMAND_ID],
  });

  const result = await runM1BRecoveryStagingSmoke(environment(), fake.dependencies);

  assert.equal(result.outcome, 'recovered');
  assert.equal(fake.state().cancelAttempts, 2);
  assert.equal(fake.state().recoveryTerminalEvidenceAttempts, 2);
  assert.equal(fake.state().draft, null);
});

test('un refus cancel recovery ne publie jamais les champs privés sur stderr', async () => {
  const privateValues = [COMPANY_ID, USER_ID, 'm1b-staging@bob.test', 'v=0\r\na=private-sdp'];
  const fake = fakeDependencies({
    preexistingMission: activeMission(),
    preexistingDraft: recoveryQuoteDraft(),
    cancelError: {
      kind: 'forbidden',
      entity: privateValues[0],
      reason: privateValues[3],
    },
    ids: [SESSION_ID, CANCEL_COMMAND_ID],
  });
  const stderrLines = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    stderrLines.push(String(chunk));
    return true;
  };
  try {
    await assert.rejects(
      runM1BRecoveryStagingSmoke(environment(), fake.dependencies),
      /recovery cancellation failed outside the response-loss contract/u,
    );
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(
    stderrLines.find((entry) => entry.includes('recovery cancellation failed')),
    'agent-mission-m1b-staging-smoke:recovery cancellation failed class=forbidden\n',
  );
  for (const value of privateValues) assert.equal(stderrLines.join('').includes(value), false);
});

test('la récupération est idempotente quand le compte technique est déjà propre', async () => {
  const fake = fakeDependencies({ recoveryState: 'clean' });
  const result = await runM1BRecoveryStagingSmoke(environment(), fake.dependencies);
  assert.deepEqual(result, {
    mode: 'recovery',
    passed: true,
    outcome: 'not_needed',
    cleanup: 'complete',
  });
  assert.equal(fake.state().createAttempts, 0);
  assert.equal(fake.state().startAttempts, 0);
  assert.equal(fake.state().cancelAttempts, 0);
});

test('accepte uniquement l’expiration paresseuse exacte du résidu', async () => {
  const expiredView = {
    ...activeMission(),
    status: 'expired',
    actionable: false,
  };
  const fake = fakeDependencies({
    preexistingMission: activeMission(),
    preexistingDraft: recoveryQuoteDraft(),
    currentMissionView: expiredView,
    cancelExpired: true,
    recoveryTerminalStatus: 'expired',
    ids: [SESSION_ID, CANCEL_COMMAND_ID],
  });
  const result = await runM1BRecoveryStagingSmoke(environment(), fake.dependencies);
  assert.equal(result.outcome, 'recovered');
  assert.equal(fake.state().mission.status, 'expired');
  assert.equal(fake.state().draft, null);
  assert.equal(fake.state().startAttempts, 0);
});

test('refuse un brouillon technique non exactement vide avant toute mutation', async () => {
  const changed = recoveryQuoteDraft({
    payload: {
      ...emptyQuoteDraftPayload(),
      draft: {
        ...emptyQuoteDraftPayload().draft,
        stagingRevision: 1,
      },
    },
  });
  const fake = fakeDependencies({
    preexistingMission: activeMission(),
    preexistingDraft: changed,
  });
  await assert.rejects(
    runM1BRecoveryStagingSmoke(environment(), fake.dependencies),
    /exact empty technical payload/u,
  );
  assert.equal(fake.state().createAttempts, 0);
  assert.equal(fake.state().cancelAttempts, 0);
  assert.equal(
    fake.events.some((event) => event.startsWith('draft:delete')),
    false,
  );
});

test('un conflit CAS du brouillon rend le recovery rouge mais ferme peer et capability', async () => {
  const fake = fakeDependencies({
    preexistingMission: activeMission(),
    preexistingDraft: recoveryQuoteDraft(),
    deleteError: {
      kind: 'conflict',
      entity: 'quote_draft',
      reason: 'stale_revision',
    },
    ids: [SESSION_ID, CANCEL_COMMAND_ID],
  });
  await assert.rejects(
    runM1BRecoveryStagingSmoke(environment(), fake.dependencies),
    /deleteQuoteDraft during recovery failed/u,
  );
  assert.equal(fake.state().startAttempts, 0);
  assert.equal(fake.events.includes('realtime:hangup'), true);
  assert.equal(fake.events.includes('peer:close'), true);
  assert.equal(fake.events.includes('mission:dispose'), true);
});

test('un ACK hangup recovery perdu reste sûr uniquement grâce à la preuve clean', async () => {
  const fake = fakeDependencies({
    preexistingMission: activeMission(),
    preexistingDraft: recoveryQuoteDraft(),
    hangupError: {
      kind: 'dependency',
      port: 'api',
      cause: 'response_lost',
    },
    ids: [SESSION_ID, CANCEL_COMMAND_ID],
  });
  const result = await runM1BRecoveryStagingSmoke(environment(), fake.dependencies);
  assert.equal(result.outcome, 'recovered');
  assert.equal(result.hangupAccepted, false);
  assert.equal(fake.events.includes('evidence:clean'), true);
});

test('un bootstrap recovery ambigu ne retente jamais et préserve le résidu exact', async () => {
  const fake = fakeDependencies({
    preexistingMission: activeMission(),
    preexistingDraft: recoveryQuoteDraft(),
    createErrors: [
      {
        kind: 'dependency',
        port: 'api',
        cause: 'Délai réseau dépassé après 12000 ms.',
      },
    ],
    ids: [SESSION_ID],
  });
  await assert.rejects(
    runM1BRecoveryStagingSmoke(environment(), fake.dependencies),
    /bootstrap failed \(class=bootstrap_timeout, attempt=1\)/u,
  );
  assert.equal(fake.state().createAttempts, 1);
  assert.equal(fake.state().startAttempts, 0);
  assert.equal(fake.state().cancelAttempts, 0);
  assert.equal(fake.events.includes('realtime:hangup'), true);
  assert.equal(
    fake.events.filter((event) => event === 'evidence:recovery-state').length >= 2,
    true,
  );
});

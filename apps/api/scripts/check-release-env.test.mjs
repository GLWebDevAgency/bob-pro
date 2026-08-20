import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  JARVIS_U1_DRAIN_SQL,
  parseJarvisU1DrainSnapshot,
  runJarvisU1DrainCheck,
} from './check-jarvis-u1-drain.mjs';

const script = fileURLToPath(new URL('./check-release-env.sh', import.meta.url));
const releaseScript = fileURLToPath(new URL('./release.sh', import.meta.url));

const baseEnvironment = Object.freeze({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
  NODE_ENV: 'production',
  DEMO_MODE: 'false',
  RELEASE_ENVIRONMENT: 'production',
  DATABASE_URL:
    'postgresql://bob_app.projectref:runtime-secret@aws-0-eu-west-3.pooler.supabase.com:5432/postgres?schema=public',
  DIRECT_URL:
    'postgresql://postgres:migration-secret@db.projectref.supabase.co:5432/postgres?schema=public',
  APP_DATABASE_ROLE: 'bob_app',
  CORS_ORIGINS: 'https://app.bobpro.fr',
  SIGN_WEB_BASE_URL: 'https://signature.bobpro.fr',
  SUPABASE_URL: 'https://projectref.supabase.co',
  SUPABASE_JWKS_URL: 'https://projectref.supabase.co/auth/v1/.well-known/jwks.json',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-release-gate-tests',
  SUPABASE_STORAGE_BUCKET: 'bob-documents',
  JOB_COMPANY_IDS: 'company-one',
  CABINET_RELEASE_ENV: 'production',
  BOB_RELEASE_EXPECTED_ENV: 'production',
  CABINET_INVITATION_TOKEN_ENCRYPTION_KEY: 'c'.repeat(32),
  CABINET_INVITATION_TOKEN_KEY_VERSION: '1',
  CABINET_INVITATION_WEB_BASE_URL: 'https://cabinet.bobpro.fr',
  CABINET_INVITATION_WORKER_ENABLED: 'true',
  CABINET_INVITATION_WORKER_USER_ID: '79e27b85-d458-445e-a759-e8b1a49e1641',
  JOB_CABINET_IDS: 'cabinet-one',
  METRICS_TOKEN: 'm'.repeat(32),
  BREVO_API_KEY: 'brevo-release-gate-test-key',
  BREVO_API_BASE_URL: 'https://api.brevo.com/v3',
  BREVO_SENDER_EMAIL: 'bob@example.test',
  ERROR_REPORTER_WEBHOOK_URL: 'https://errors.example.test/hook',
  MISTRAL_API_KEY: 'mistral-release-gate-test-key',
  RUN_RLS_CERT: 'true',
  RLS_CERT_CLEANUP: 'true',
  BOB_JARVIS_ADMISSION_ENABLED: 'false',
  BOB_JARVIS_DISPATCH_ENABLED: 'false',
});

function runReleaseGate(overrides = {}) {
  const env = { ...baseEnvironment, ...overrides };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
  }
  return spawnSync('sh', [script], {
    encoding: 'utf8',
    env,
    timeout: 10_000,
  });
}

const completeStripeEnvironment = Object.freeze({
  STRIPE_SECRET_KEY: 'sk_live_release_gate_test',
  STRIPE_PRICE_SOLO: 'price_solo',
  STRIPE_PRICE_PRO: 'price_pro',
  STRIPE_PRICE_BUSINESS: 'price_business',
  STRIPE_WEBHOOK_SECRET: `whsec_${'w'.repeat(32)}`,
  STRIPE_LIVEMODE: 'true',
  PAYMENT_RETURN_BASE_URL: 'https://app.bobpro.fr',
});

const nativeKeyLifecycleEnvironment = Object.freeze({
  BOB_LIVE_PROVIDER: 'mistral',
  BOB_LIVE_SUBJECT_KEY_VERSION: '1',
  BOB_LIVE_SUBJECT_HMAC_SECRET: 'subject-current-release-gate-material-2026',
  BOB_LIVE_SUBJECT_HMAC_KEYRING: JSON.stringify({
    1: 'subject-current-release-gate-material-2026',
  }),
  BOB_LIVE_PROOF_KEY_VERSION: '1',
  BOB_LIVE_PROOF_SECRET: 'proof-current-release-gate-material-2026',
  BOB_LIVE_PROOF_KEYRING: JSON.stringify({
    1: 'proof-current-release-gate-material-2026',
  }),
});

test('autorise la release V1 en accès anticipé quand Stripe est entièrement absent', () => {
  const result = runReleaseGate();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release-env-ok/u);
});

test('refuse une release tant que les deux masters Jarvis ne sont pas explicitement fermés', () => {
  for (const name of ['BOB_JARVIS_ADMISSION_ENABLED', 'BOB_JARVIS_DISPATCH_ENABLED']) {
    const absent = runReleaseGate({ [name]: undefined });
    assert.notEqual(absent.status, 0);
    assert.match(absent.stderr, new RegExp(`${name} is required`, 'u'));

    const open = runReleaseGate({ [name]: 'true' });
    assert.notEqual(open.status, 0);
    assert.match(
      open.stderr,
      new RegExp(`${name} must be explicitly 'false' until the Jarvis single-engine cutover`, 'u'),
    );
  }
});

test('le drain Jarvis relit la base sans exposer DIRECT_URL et exige un zéro stable', () => {
  const calls = [];
  const snapshot = runJarvisU1DrainCheck({
    environment: baseEnvironment,
    spawnSync: (command, args, options) => {
      assert.equal(existsSync(options.env.PGPASSFILE), true);
      calls.push({ command, args, options });
      return { status: 0, stdout: '0|0|0|0|0|0\n', stderr: '' };
    },
  });

  assert.deepEqual(snapshot, {
    unsafeWorkItems: 0,
    pendingSignals: 0,
    strandedCancellations: 0,
    invalidTerminalShapes: 0,
    strandedRuns: 0,
    recentMutations: 0,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'psql');
  assert.equal(calls[0].options.input, JARVIS_U1_DRAIN_SQL);
  assert.equal(calls[0].options.input.includes('5 minutes'), true);
  assert.equal(calls[0].options.input.includes("to_regclass('public.jarvis_work_items')"), true);
  assert.equal(calls[0].options.input.includes("to_regclass('public.agent_missions')"), true);
  assert.equal(calls[0].options.input.includes('\\if :jarvis_u1_schema_ready'), true);
  assert.equal(calls[0].options.input.includes('SET LOCAL row_security = off'), true);
  assert.match(
    calls[0].options.input,
    /item\.status IN \('succeeded', 'failed_terminal', 'cancelled'\)[\s\S]*"resultDigest" IS NOT NULL[\s\S]*"signalAppliedAt" IS NOT NULL[\s\S]*item\.status <> 'cancelled' OR item\."authorizedAt" IS NULL[\s\S]*\) IS NOT TRUE/u,
  );
  assert.match(
    calls[0].options.input,
    /item\.status = 'cancelled' AND item\."authorizedAt" IS NOT NULL/u,
  );
  assert.match(
    calls[0].options.input,
    /FROM public\.agent_missions AS stranded_run[\s\S]*stranded_run\.status = 'cancelling'/u,
  );
  assert.match(calls[0].options.input, /LEFT JOIN public\.agent_missions AS run/u);
  assert.equal(calls[0].args.includes(baseEnvironment.DIRECT_URL), false);
  assert.equal(calls[0].options.input.includes('runtime-secret'), false);
  assert.equal(calls[0].options.env.PGUSER, 'postgres');
  assert.equal(Object.hasOwn(calls[0].options.env, 'DIRECT_URL'), false);
  assert.equal(Object.hasOwn(calls[0].options.env, 'DATABASE_URL'), false);
  assert.equal(existsSync(calls[0].options.env.PGPASSFILE), false);
});

test('le drain Jarvis échoue fermé si PostgreSQL refuse row_security=off', () => {
  assert.throws(
    () =>
      runJarvisU1DrainCheck({
        environment: baseEnvironment,
        spawnSync: () => ({
          status: 3,
          stdout: '',
          stderr: 'query would be affected by row-level security policy',
        }),
      }),
    /jarvis-u1-drain:query_failed/u,
  );
});

test('le drain Jarvis refuse chaque classe non nulle, une sortie ambiguë et des masters ouverts', () => {
  for (const output of [
    '1|0|0|0|0|0',
    '0|1|0|0|0|0',
    '0|0|1|0|0|0',
    '0|0|0|1|0|0',
    '0|0|0|0|1|0',
    '0|0|0|0|0|1',
  ]) {
    assert.throws(
      () =>
        runJarvisU1DrainCheck({
          environment: baseEnvironment,
          spawnSync: () => ({ status: 0, stdout: `${output}\n`, stderr: '' }),
        }),
      /not_zero/u,
    );
  }
  assert.throws(() => parseJarvisU1DrainSnapshot('0|0|0|0|0\n'), /snapshot_invalid/u);
  assert.throws(
    () =>
      runJarvisU1DrainCheck({
        environment: { ...baseEnvironment, BOB_JARVIS_ADMISSION_ENABLED: 'true' },
        spawnSync: () => ({ status: 0, stdout: '0|0|0|0|0|0\n', stderr: '' }),
      }),
    /BOB_JARVIS_ADMISSION_ENABLED_must_be_false/u,
  );
});

test('le predeploy exécute le drain Jarvis avant toute migration', () => {
  const source = readFileSync(releaseScript, 'utf8');
  const drain = source.indexOf('node apps/api/scripts/check-jarvis-u1-drain.mjs');
  const migrate = source.indexOf('pnpm --filter @bob/api exec prisma migrate deploy');

  assert.notEqual(drain, -1);
  assert.notEqual(migrate, -1);
  assert.ok(drain < migrate);
  assert.match(
    source,
    /if \[ "\$BOB_RELEASE_PHASE" = predeploy \]; then\s+node apps\/api\/scripts\/check-jarvis-u1-drain\.mjs\s+fi/u,
  );
  assert.match(
    source,
    /if \[ "\$CABINET_RELEASE_ENV" = development \]; then[\s\S]*BOB_JARVIS_ADMISSION_ENABLED="\$\{BOB_JARVIS_ADMISSION_ENABLED:-false\}"[\s\S]*BOB_JARVIS_DISPATCH_ENABLED="\$\{BOB_JARVIS_DISPATCH_ENABLED:-false\}"[\s\S]*else[\s\S]*BOB_JARVIS_ADMISSION_ENABLED=false is required before release[\s\S]*BOB_JARVIS_DISPATCH_ENABLED=false is required before release/u,
  );
  assert.match(source, /Both Jarvis masters must remain false during release/u);
});

test('refuse une cible attendue différente de l’environnement Railway distant', () => {
  const result = runReleaseGate({ BOB_RELEASE_EXPECTED_ENV: 'staging' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BOB_RELEASE_EXPECTED_ENV must match RELEASE_ENVIRONMENT/u);
});

test('refuse une capacité Bob Live partielle et certifie le groupe complet', () => {
  const partial = runReleaseGate({ BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS: '50' });
  assert.notEqual(partial.status, 0);
  assert.match(partial.stderr, /BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS is required/u);

  const complete = runReleaseGate({
    BOB_LIVE_ENABLED: 'true',
    BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS: '50',
    BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS: '60',
    BOB_LIVE_CAPACITY_CONFIG_VERSION: '1',
  });
  assert.equal(complete.status, 0, complete.stderr);
});

test('refuse un plafond Bob Live supérieur au fournisseur ou au gateway Mistral', () => {
  const providerOverflow = runReleaseGate({
    BOB_LIVE_ENABLED: 'true',
    BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS: '51',
    BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS: '50',
    BOB_LIVE_CAPACITY_CONFIG_VERSION: '1',
  });
  assert.notEqual(providerOverflow.status, 0);
  assert.match(providerOverflow.stderr, /greater than or equal to the global limit/u);

  const gatewayOverflow = runReleaseGate({
    BOB_LIVE_ENABLED: 'true',
    BOB_LIVE_PROVIDER: 'mistral',
    BOB_LIVE_GATEWAY_MAX_CONNECTIONS: '40',
    BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS: '50',
    BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS: '60',
    BOB_LIVE_CAPACITY_CONFIG_VERSION: '1',
  });
  assert.notEqual(gatewayOverflow.status, 0);
  assert.match(gatewayOverflow.stderr, /must not exceed BOB_LIVE_GATEWAY_MAX_CONNECTIONS/u);
});

test('traite sept variables Stripe vides comme un paiement non provisionné', () => {
  const result = runReleaseGate({
    STRIPE_SECRET_KEY: '',
    STRIPE_PRICE_SOLO: ' ',
    STRIPE_PRICE_PRO: '',
    STRIPE_PRICE_BUSINESS: '',
    STRIPE_WEBHOOK_SECRET: '',
    STRIPE_LIVEMODE: '',
    PAYMENT_RETURN_BASE_URL: '',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release-env-ok/u);
});

test('refuse une configuration Stripe entamée mais incomplète', () => {
  const result = runReleaseGate({ STRIPE_SECRET_KEY: 'sk_live_release_gate_test' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STRIPE_PRICE_SOLO is required when Stripe payments are configured/u);
  assert.match(
    result.stderr,
    /PAYMENT_RETURN_BASE_URL is required when Stripe payments are configured/u,
  );
});

test('certifie une configuration Stripe live complète', () => {
  const result = runReleaseGate(completeStripeEnvironment);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release-env-ok/u);
});

test('refuse le mode test Stripe et une origine de retour non canonique', () => {
  const result = runReleaseGate({
    ...completeStripeEnvironment,
    STRIPE_LIVEMODE: 'false',
    PAYMENT_RETURN_BASE_URL: 'https://app.bobpro.fr/retour?source=release',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STRIPE_LIVEMODE must be 'true'/u);
  assert.match(result.stderr, /PAYMENT_RETURN_BASE_URL must be a canonical non-demo HTTPS URL/u);
});

test('préserve le cycle des clés natives même pendant une bascule fournisseur vers Mistral', () => {
  const result = runReleaseGate(nativeKeyLifecycleEnvironment);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release-env-ok/u);
});

test('refuse de remplacer le matériau preuve sous un numéro déjà déclaré courant', () => {
  const result = runReleaseGate({
    ...nativeKeyLifecycleEnvironment,
    BOB_LIVE_PROOF_SECRET: 'proof-other-release-gate-material-2026',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /current secret must match its legacy current-secret variable/u);
});

test('refuse une keyring preuve non adjacente ou partageant le matériau sujet', () => {
  const nonAdjacent = runReleaseGate({
    ...nativeKeyLifecycleEnvironment,
    BOB_LIVE_PROOF_KEY_VERSION: '3',
    BOB_LIVE_PROOF_SECRET: 'proof-current-release-gate-material-2026',
    BOB_LIVE_PROOF_KEYRING: JSON.stringify({
      1: 'proof-previous-release-gate-material-2026',
      3: 'proof-current-release-gate-material-2026',
    }),
  });
  assert.notEqual(nonAdjacent.status, 0);
  assert.match(nonAdjacent.stderr, /current N and optional adjacent N-1 only/u);

  const reused = runReleaseGate({
    ...nativeKeyLifecycleEnvironment,
    BOB_LIVE_PROOF_SECRET: 'subject-current-release-gate-material-2026',
    BOB_LIVE_PROOF_KEYRING: JSON.stringify({
      1: 'subject-current-release-gate-material-2026',
    }),
  });
  assert.notEqual(reused.status, 0);
  assert.match(reused.stderr, /subject and proof key material must be dedicated/u);
});

test('refuse la restitution OpenAI native sans keyring preuve versionnée', () => {
  const result = runReleaseGate({
    BOB_LIVE_SPEECH_DELIVERY: 'openai-native-webrtc-v1',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BOB_LIVE_PROOF_KEYRING is required/u);
});

test('refuse d’armer le certificat PostgreSQL destructif dans une release live', () => {
  const result = runReleaseGate({
    RUN_POSTGRES_OPENAI_NATIVE_KEY_LIFECYCLE_CERT: 'true',
  });

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /RUN_POSTGRES_OPENAI_NATIVE_KEY_LIFECYCLE_CERT must be absent or false/u,
  );
});

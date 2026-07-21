#!/usr/bin/env sh
set -eu

# Validates production release variables without printing secret values.
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)"
cd "$ROOT_DIR"

node --input-type=module <<'NODE'
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const { parsePilotBootstrapEnvironment } = await import(
  pathToFileURL(resolve('apps/api/scripts/bootstrap-cabinet-pilots.mjs')).href
);

const required = [
  'NODE_ENV',
  'DEMO_MODE',
  'DATABASE_URL',
  'DIRECT_URL',
  'APP_DATABASE_ROLE',
  'CORS_ORIGINS',
  'SIGN_WEB_BASE_URL',
  'SUPABASE_URL',
  'SUPABASE_JWKS_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_STORAGE_BUCKET',
  'JOB_COMPANY_IDS',
  'CABINET_RELEASE_ENV',
  'CABINET_INVITATION_TOKEN_ENCRYPTION_KEY',
  'CABINET_INVITATION_TOKEN_KEY_VERSION',
  'CABINET_INVITATION_WEB_BASE_URL',
  'METRICS_TOKEN',
  'CABINET_INVITATION_WORKER_ENABLED',
  'BREVO_API_KEY',
  'BREVO_API_BASE_URL',
  'BREVO_SENDER_EMAIL',
  'ERROR_REPORTER_WEBHOOK_URL',
  'RUN_RLS_CERT',
  'RLS_CERT_CLEANUP',
];

const paymentVariables = [
  'STRIPE_SECRET_KEY',
  'STRIPE_PRICE_SOLO',
  'STRIPE_PRICE_PRO',
  'STRIPE_PRICE_BUSINESS',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_LIVEMODE',
  'PAYMENT_RETURN_BASE_URL',
];

let failed = false;

function fail(message) {
  console.error(`release-env:error:${message}`);
  failed = true;
}

function present(name) {
  const value = process.env[name];
  if (!value || !value.trim()) fail(`${name} is required`);
}

function url(name) {
  const value = process.env[name];
  try {
    return new URL(value);
  } catch {
    fail(`${name} must be a valid URL`);
    return null;
  }
}

for (const name of required) present(name);

// Accès anticipé V1 : Stripe est soit entièrement absent, soit entièrement certifié. Les
// plateformes peuvent exposer des variables vides ; elles comptent comme absentes. Une seule
// valeur renseignée fait basculer le gate en mode paiement et rend les six autres obligatoires.
const configuredPaymentVariables = paymentVariables.filter(
  (name) => (process.env[name] ?? '').trim().length > 0,
);
const paymentConfigured = configuredPaymentVariables.length > 0;
if (paymentConfigured && configuredPaymentVariables.length !== paymentVariables.length) {
  for (const name of paymentVariables) {
    if (!(process.env[name] ?? '').trim()) {
      fail(`${name} is required when Stripe payments are configured`);
    }
  }
}

if (process.env.DEMO_MODE !== 'false') {
  fail("DEMO_MODE must be 'false' for production");
}

if (process.env.NODE_ENV !== 'production') {
  fail("NODE_ENV must be 'production' for production release checks");
}
if (paymentConfigured) {
  if (process.env.STRIPE_LIVEMODE !== 'true') {
    fail("STRIPE_LIVEMODE must be 'true' for a production release");
  }
  if (!/^whsec_[A-Za-z0-9_\-]{16,}$/.test(process.env.STRIPE_WEBHOOK_SECRET ?? '')) {
    fail('STRIPE_WEBHOOK_SECRET must be a non-placeholder Workbench endpoint secret');
  }
}

const llmKeys = [
  'ANTHROPIC_API_KEY',
  'GLM_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'OPENAI_API_KEY',
];
if (!llmKeys.some((name) => (process.env[name] ?? '').trim())) {
  fail('at least one live LLM provider key is required');
}
if (!(process.env.MISTRAL_API_KEY ?? '').trim() && !(process.env.ANTHROPIC_API_KEY ?? '').trim()) {
  fail('MISTRAL_API_KEY or ANTHROPIC_API_KEY is required for live OCR');
}

const mistralV2TerminalReplay =
  process.env.BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED ?? 'false';
if (!['true', 'false'].includes(mistralV2TerminalReplay)) {
  fail('BOB_LIVE_MISTRAL_V2_TERMINAL_REPLAY_ENABLED must be true or false');
}
if (mistralV2TerminalReplay === 'true') {
  const version = process.env.BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION ?? '';
  if (!/^[1-9][0-9]*$/.test(version) || Number(version) > 2_147_483_647) {
    fail('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION must be a PostgreSQL positive integer');
  }
  present('BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING');

  const subjectVersion = process.env.BOB_LIVE_SUBJECT_KEY_VERSION ?? '1';
  if (
    !/^[1-9][0-9]{0,9}$/.test(subjectVersion)
    || !Number.isSafeInteger(Number(subjectVersion))
    || Number(subjectVersion) > 2_147_483_647
  ) fail('BOB_LIVE_SUBJECT_KEY_VERSION must be a canonical PostgreSQL positive integer');

  const rawSubjectKeyring = process.env.BOB_LIVE_SUBJECT_HMAC_KEYRING;
  if (
    typeof rawSubjectKeyring !== 'string'
    || rawSubjectKeyring.length < 1
    || rawSubjectKeyring.length > 4_096
  ) {
    fail('BOB_LIVE_SUBJECT_HMAC_KEYRING size is invalid');
  } else {
    let subjectKeyring;
    try {
      subjectKeyring = JSON.parse(rawSubjectKeyring);
    } catch {
      fail('BOB_LIVE_SUBJECT_HMAC_KEYRING must be valid JSON');
    }
    if (
      !subjectKeyring
      || typeof subjectKeyring !== 'object'
      || Array.isArray(subjectKeyring)
      || Object.getPrototypeOf(subjectKeyring) !== Object.prototype
    ) {
      fail('BOB_LIVE_SUBJECT_HMAC_KEYRING must be an object');
    } else {
      const entries = Object.entries(subjectKeyring);
      const seenSecrets = new Set();
      if (entries.length < 1 || entries.length > 32) {
        fail('BOB_LIVE_SUBJECT_HMAC_KEYRING must contain between 1 and 32 keys');
      }
      for (const [keyVersion, secret] of entries) {
        if (
          !/^[1-9][0-9]{0,9}$/.test(keyVersion)
          || Number(keyVersion) > 2_147_483_647
          || typeof secret !== 'string'
          || secret.length < 32
          || secret.length > 512
          || secret.includes('[')
          || secret.includes(']')
          || [...secret].some((character) => {
            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint < 0x21 || codePoint > 0x7e;
          })
          || seenSecrets.has(secret)
        ) {
          fail('BOB_LIVE_SUBJECT_HMAC_KEYRING contains an invalid version or secret');
          break;
        }
        seenSecrets.add(secret);
      }
      const currentSubjectSecret = subjectKeyring[subjectVersion];
      if (typeof currentSubjectSecret !== 'string') {
        fail('BOB_LIVE_SUBJECT_HMAC_KEYRING must contain the current subject version');
      }
      const legacyCurrentSubjectSecret =
        process.env.BOB_LIVE_SUBJECT_HMAC_SECRET
        ?? process.env.OPENAI_REALTIME_SAFETY_SECRET
        ?? null;
      if (
        legacyCurrentSubjectSecret !== null
        && legacyCurrentSubjectSecret !== currentSubjectSecret
      ) fail('legacy subject HMAC secret must match the current keyring version');
    }
  }
} else if (
  process.env.BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEY_VERSION !== undefined
  || process.env.BOB_LIVE_MISTRAL_V2_PERSISTENCE_KEYRING !== undefined
) {
  fail('Mistral v2 persistence keys are forbidden while terminal replay is disabled');
}

// Ces flags lancent des suites qui écrivent, suppriment et tronquent volontairement des données.
// Ils appartiennent exclusivement au PostgreSQL éphémère de CI et sont interdits dans tout
// environnement Railway, même si une variable de service obsolète les a laissés à `true`.
for (const name of [
  'RUN_POSTGRES_MISTRAL_CONVERSATION_MUTATION_CERT',
  'RUN_POSTGRES_MISTRAL_KEY_ROTATION_MUTATION_CERT',
]) {
  const value = process.env[name];
  if (value !== undefined && value !== 'false') {
    fail(`${name} must be absent or false for a live release`);
  }
}

if (process.env.RUN_RLS_CERT !== 'true') {
  fail("RUN_RLS_CERT must be 'true' for a live release");
}
if (process.env.RLS_CERT_CLEANUP !== 'true') {
  fail("RLS_CERT_CLEANUP must be 'true' for a live release");
}

const databaseUrl = url('DATABASE_URL');
const directUrl = url('DIRECT_URL');
const supabaseUrl = url('SUPABASE_URL');
const jwksUrl = url('SUPABASE_JWKS_URL');
const signWebBaseUrl = url('SIGN_WEB_BASE_URL');
const cabinetWebBaseUrl = url('CABINET_INVITATION_WEB_BASE_URL');
const errorReporterUrl = url('ERROR_REPORTER_WEBHOOK_URL');
const brevoBaseUrl = url('BREVO_API_BASE_URL');
const paymentReturnBaseUrl = paymentConfigured ? url('PAYMENT_RETURN_BASE_URL') : null;

if (databaseUrl && directUrl && databaseUrl.toString() === directUrl.toString()) {
  fail('DATABASE_URL and DIRECT_URL must use distinct roles');
}
for (const [name, parsed] of [['DATABASE_URL', databaseUrl], ['DIRECT_URL', directUrl]]) {
  if (parsed && !['postgres:', 'postgresql:'].includes(parsed.protocol)) fail(`${name} must use PostgreSQL`);
  if (parsed && (parsed.password.includes('[') || parsed.password.includes(']'))) fail(`${name} contains a placeholder password`);
}

if (databaseUrl && directUrl) {
  const runtimeUser = decodeURIComponent(databaseUrl.username);
  const appRole = process.env.APP_DATABASE_ROLE ?? '';
  const runtimeProject = appRole && runtimeUser.startsWith(`${appRole}.`)
    ? runtimeUser.slice(appRole.length + 1)
    : null;
  const directProject = /^db\.([a-z0-9-]+)\.supabase\.co$/i.exec(directUrl.hostname)?.[1] ?? null;
  const sameHost = databaseUrl.hostname.toLowerCase() === directUrl.hostname.toLowerCase();
  const runtimePort = databaseUrl.port || (databaseUrl.protocol === 'postgresql:' ? '5432' : '');
  const directPort = directUrl.port || (directUrl.protocol === 'postgresql:' ? '5432' : '');
  if (databaseUrl.pathname !== directUrl.pathname) {
    fail('DATABASE_URL and DIRECT_URL must target the same database name');
  }
  if ((databaseUrl.searchParams.get('schema') || 'public') !== (directUrl.searchParams.get('schema') || 'public')) {
    fail('DATABASE_URL and DIRECT_URL must target the same schema');
  }
  if (sameHost) {
    if (runtimePort !== directPort) fail('DATABASE_URL and DIRECT_URL must target the same database port');
  } else if (!runtimeProject || !directProject || runtimeProject !== directProject) {
    fail('DATABASE_URL and DIRECT_URL must target the same host/project');
  }
}

if (databaseUrl) {
  const runtimeUser = decodeURIComponent(databaseUrl.username);
  const appRole = process.env.APP_DATABASE_ROLE ?? '';
  if (runtimeUser === 'postgres' || runtimeUser.startsWith('postgres.')) {
    fail('DATABASE_URL must not use the postgres/superuser role');
  }
  if (appRole && runtimeUser !== appRole && !runtimeUser.startsWith(`${appRole}.`)) {
    fail('DATABASE_URL user must match APP_DATABASE_ROLE, allowing Supabase pooler suffixes');
  }
  if (databaseUrl.port === '6543') {
    fail('DATABASE_URL must not use Supabase transaction pooler port 6543; use direct 5432 or session-mode');
  }
}

if (directUrl) {
  const migrationUser = decodeURIComponent(directUrl.username);
  if (migrationUser !== 'postgres' && !migrationUser.startsWith('postgres.')) {
    fail('DIRECT_URL must use the privileged postgres migration role');
  }
  if (directUrl.port === '6543') {
    fail('DIRECT_URL must not use Supabase transaction pooler port 6543');
  }
}

if (supabaseUrl && supabaseUrl.protocol !== 'https:') {
  fail('SUPABASE_URL must be https');
}

if (jwksUrl && jwksUrl.protocol !== 'https:') {
  fail('SUPABASE_JWKS_URL must be https');
}

if (supabaseUrl && jwksUrl && supabaseUrl.hostname !== jwksUrl.hostname) {
  fail('SUPABASE_URL and SUPABASE_JWKS_URL must target the same project host');
}

if (
  signWebBaseUrl
  && (
    signWebBaseUrl.protocol !== 'https:'
    || ['localhost', '127.0.0.1', 'demo.bobpro.fr'].includes(signWebBaseUrl.hostname)
  )
) {
  fail('SIGN_WEB_BASE_URL must be a non-local HTTPS URL in production');
}
if (
  paymentReturnBaseUrl
  && (
    paymentReturnBaseUrl.protocol !== 'https:'
    || ['localhost', '127.0.0.1', 'demo.bobpro.fr'].includes(paymentReturnBaseUrl.hostname)
    || paymentReturnBaseUrl.username
    || paymentReturnBaseUrl.password
    || paymentReturnBaseUrl.search
    || paymentReturnBaseUrl.hash
  )
) {
  fail('PAYMENT_RETURN_BASE_URL must be a canonical non-demo HTTPS URL');
}

for (const [name, parsed] of [
  ['CABINET_INVITATION_WEB_BASE_URL', cabinetWebBaseUrl],
  ['ERROR_REPORTER_WEBHOOK_URL', errorReporterUrl],
  ['BREVO_API_BASE_URL', brevoBaseUrl],
]) {
  if (parsed && parsed.protocol !== 'https:') fail(`${name} must be https in release environments`);
  if (parsed && parsed.hostname === 'localhost') fail(`${name} must not be localhost in release environments`);
  if (parsed && parsed.hostname === 'demo.bobpro.fr') fail(`${name} must not target demo.bobpro.fr`);
}

const expectedReleaseEnvironment = process.env.RELEASE_ENVIRONMENT || 'production';
if (!['staging', 'production'].includes(expectedReleaseEnvironment)) {
  fail('RELEASE_ENVIRONMENT must be staging or production');
}
if (process.env.CABINET_RELEASE_ENV !== expectedReleaseEnvironment) {
  fail('CABINET_RELEASE_ENV must match RELEASE_ENVIRONMENT');
}
if ((process.env.CABINET_INVITATION_TOKEN_ENCRYPTION_KEY ?? '').length < 32) {
  fail('CABINET_INVITATION_TOKEN_ENCRYPTION_KEY must contain at least 32 characters');
}
for (const name of ['CABINET_INVITATION_TOKEN_ENCRYPTION_KEY', 'METRICS_TOKEN']) {
  const value = process.env[name] ?? '';
  if (value.includes('[') || value.includes(']')) fail(`${name} must not be a placeholder`);
}
for (const name of [
  'BREVO_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  ...llmKeys.filter((key) => (process.env[key] ?? '').trim()),
]) {
  const value = process.env[name] ?? '';
  if (value.includes('[') || value.includes(']')) fail(`${name} must not be a placeholder`);
}
if (!/^\d+$/.test(process.env.CABINET_INVITATION_TOKEN_KEY_VERSION ?? '') || Number(process.env.CABINET_INVITATION_TOKEN_KEY_VERSION) < 1) {
  fail('CABINET_INVITATION_TOKEN_KEY_VERSION must be a positive integer');
}
if ((process.env.METRICS_TOKEN ?? '').length < 32) fail('METRICS_TOKEN must contain at least 32 characters');
const workerEnabled = process.env.CABINET_INVITATION_WORKER_ENABLED === 'true';
if (!workerEnabled && process.env.CABINET_INVITATION_WORKER_ENABLED !== 'false') {
  fail('CABINET_INVITATION_WORKER_ENABLED must be true or false');
}
const workerCabinetIds = (process.env.JOB_CABINET_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const distinctWorkerCabinetIds = new Set(workerCabinetIds);
const workerUserId = (process.env.CABINET_INVITATION_WORKER_USER_ID ?? '').trim();
if (workerEnabled && (!workerCabinetIds.length || !workerUserId)) {
  fail('enabled Cabinet worker requires JOB_CABINET_IDS and CABINET_INVITATION_WORKER_USER_ID');
}
if (workerEnabled && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workerUserId)) {
  fail('CABINET_INVITATION_WORKER_USER_ID must be a UUID');
}
if (!workerEnabled && (workerCabinetIds.length || workerUserId)) {
  fail('disabled Cabinet worker must not keep JOB_CABINET_IDS or CABINET_INVITATION_WORKER_USER_ID');
}
if (distinctWorkerCabinetIds.size > 100) fail('JOB_CABINET_IDS is limited to 100 distinct pilot cabinets');
for (const id of workerCabinetIds) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) fail('JOB_CABINET_IDS contains an invalid id');
}
if (Object.prototype.hasOwnProperty.call(process.env, 'CABINET_PILOT_BOOTSTRAP_CONFIG')) {
  try {
    parsePilotBootstrapEnvironment(process.env);
  } catch {
    fail('CABINET_PILOT_BOOTSTRAP_CONFIG is invalid or inconsistent with the worker scope');
  }
}

const corsOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
if (!corsOrigins.length) fail('CORS_ORIGINS must contain at least one browser origin');
for (const origin of corsOrigins) {
  if (origin === '*') fail('CORS_ORIGINS must not contain wildcard *');
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:') fail('every CORS origin must use https');
  } catch {
    fail('CORS_ORIGINS contains an invalid URL');
  }
}

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(process.env.BREVO_SENDER_EMAIL ?? '')) {
  fail('BREVO_SENDER_EMAIL must be a valid email address');
}
if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(process.env.SUPABASE_STORAGE_BUCKET ?? '')) {
  fail('SUPABASE_STORAGE_BUCKET has an invalid format');
}

const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (serviceRoleKey.includes('[') || serviceRoleKey.length < 20) {
  fail('SUPABASE_SERVICE_ROLE_KEY looks empty or placeholder-like');
}

if (failed) process.exit(1);
console.log('release-env-ok');
NODE

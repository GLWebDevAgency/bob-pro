#!/usr/bin/env sh
set -eu

# Validates production release variables without printing secret values.
node <<'NODE'
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

if (process.env.DEMO_MODE !== 'false') {
  fail("DEMO_MODE must be 'false' for production");
}

if (process.env.NODE_ENV !== 'production') {
  fail("NODE_ENV must be 'production' for production release checks");
}

const databaseUrl = url('DATABASE_URL');
const directUrl = url('DIRECT_URL');
const supabaseUrl = url('SUPABASE_URL');
const jwksUrl = url('SUPABASE_JWKS_URL');
const signWebBaseUrl = url('SIGN_WEB_BASE_URL');

if (databaseUrl && directUrl && databaseUrl.toString() === directUrl.toString()) {
  fail('DATABASE_URL and DIRECT_URL must use distinct roles');
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

if (signWebBaseUrl && signWebBaseUrl.hostname === 'localhost') {
  fail('SIGN_WEB_BASE_URL must not be localhost in production');
}

const corsOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
if (!corsOrigins.length) fail('CORS_ORIGINS must contain at least one browser origin');
for (const origin of corsOrigins) {
  if (origin === '*') fail('CORS_ORIGINS must not contain wildcard *');
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:') fail(`CORS origin must be https: ${origin}`);
  } catch {
    fail(`Invalid CORS origin: ${origin}`);
  }
}

const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (serviceRoleKey.includes('[') || serviceRoleKey.length < 20) {
  fail('SUPABASE_SERVICE_ROLE_KEY looks empty or placeholder-like');
}

if (failed) process.exit(1);
console.log('release-env-ok');
NODE

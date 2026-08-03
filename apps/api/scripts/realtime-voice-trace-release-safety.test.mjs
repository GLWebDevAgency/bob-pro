import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const [
  release,
  ci,
  provision,
  releaseCert,
  traceMigration,
  retryExpand,
  retryValidate,
  clientCloseExpand,
  clientCloseValidate,
  readerV3Expand,
  generator,
  postgresCert,
  nativePostgresCert,
] = await Promise.all([
  readFile(new URL('scripts/release.sh', root), 'utf8'),
  readFile(new URL('../../.github/workflows/ci.yml', root), 'utf8'),
  readFile(new URL('prisma/realtime-voice-trace-authority-provision.sql', root), 'utf8'),
  readFile(new URL('prisma/realtime-voice-trace-release-cert.sql', root), 'utf8'),
  readFile(
    new URL('prisma/migrations/20260801050000_realtime_voice_trace_v2/migration.sql', root),
    'utf8',
  ),
  readFile(
    new URL(
      'prisma/migrations/20260801051000_openai_native_retry_scenario_expand/migration.sql',
      root,
    ),
    'utf8',
  ),
  readFile(
    new URL(
      'prisma/migrations/20260801052000_openai_native_retry_scenario_validate/migration.sql',
      root,
    ),
    'utf8',
  ),
  readFile(
    new URL(
      'prisma/migrations/20260803010000_realtime_voice_trace_client_close_expand/migration.sql',
      root,
    ),
    'utf8',
  ),
  readFile(
    new URL(
      'prisma/migrations/20260803010100_realtime_voice_trace_client_close_validate/migration.sql',
      root,
    ),
    'utf8',
  ),
  readFile(
    new URL(
      'prisma/migrations/20260803010200_realtime_voice_trace_reader_v3_expand/migration.sql',
      root,
    ),
    'utf8',
  ),
  readFile(new URL('scripts/generate-realtime-voice-trace-migration-values.mjs', root), 'utf8'),
  readFile(new URL('src/persistence/prisma/realtime-voice-trace.postgres.test.ts', root), 'utf8'),
  readFile(
    new URL('src/voice/realtime/openai-native-speech-delivery.postgres.test.ts', root),
    'utf8',
  ),
]);

test('la release suit rôles, migration, RLS, provisionnement puis certificat', () => {
  const markers = [
    'ensure_realtime_voice_trace_authority_roles',
    'prisma migrate deploy',
    ' -f apps/api/prisma/rls.sql',
    'provision_realtime_voice_trace_authorities',
    'certify_realtime_voice_trace_release',
  ].map((marker) => release.lastIndexOf(marker));
  assert.ok(markers.every((index) => index >= 0));
  assert.deepEqual(
    markers,
    [...markers].sort((left, right) => left - right),
  );
  assert.match(
    release,
    /if \[ "\$BOB_RELEASE_PHASE" = postdeploy \][\s\S]*certify_realtime_voice_trace_release/u,
  );
  assert.doesNotMatch(
    release,
    /provision_realtime_voice_trace_authorities\(\)[\s\S]{0,220}--single-transaction/u,
  );
});

test('la CI exerce staging, le comportement PostgreSQL puis restaure development', () => {
  const stage = ci.indexOf('Provision the staging-only Realtime Voice Trace reader');
  const behavior = ci.indexOf('Certify Realtime Voice Trace V2 behavior on PostgreSQL');
  const restore = ci.indexOf('Revoke the staging-only Realtime Voice Trace reader');
  const ownerSplit = ci.indexOf('Certify the full RLS replay after an exact schema-owner split');
  assert.ok(stage >= 0 && behavior > stage && restore > behavior && ownerSplit > restore);
  assert.match(ci.slice(stage, behavior), /-v release_env=staging/u);
  assert.match(ci.slice(behavior, restore), /RUN_POSTGRES_REALTIME_VOICE_TRACE_V2_CERT: 'true'/u);
  assert.match(
    ci.slice(behavior, restore),
    /REALTIME_VOICE_TRACE_V2_CERT_DATABASE_KIND: ephemeral/u,
  );
  assert.match(ci.slice(restore, ownerSplit), /-v release_env=development/u);
  assert.match(ci.slice(restore, ownerSplit), /if: \$\{\{ always\(\)/u);
});

test('l’autorité reader reste staging-only et la Data API demeure révoquée', () => {
  const readerAuthorityStart = provision.indexOf('SET LOCAL ROLE bob_realtime_voice_trace_reader;');
  const readerAuthorityEnd = provision.indexOf('RESET ROLE;', readerAuthorityStart);
  assert.ok(readerAuthorityStart >= 0 && readerAuthorityEnd > readerAuthorityStart);
  const readerAuthority = provision.slice(readerAuthorityStart, readerAuthorityEnd);
  assert.match(
    readerAuthority,
    /GRANT EXECUTE ON FUNCTION public\.read_realtime_voice_trace_session_v2[\s\S]*WHERE current_setting\('app\.release_environment', TRUE\) = 'staging'/u,
  );
  assert.match(
    readerAuthority,
    /GRANT EXECUTE ON FUNCTION public\.read_realtime_voice_trace_session_v3[\s\S]*WHERE current_setting\('app\.release_environment', TRUE\) = 'staging'/u,
  );
  assert.match(
    readerAuthority,
    /REVOKE ALL ON FUNCTION public\.read_realtime_voice_trace_session_v3[\s\S]*WHERE current_setting\('app\.release_environment', TRUE\) <> 'staging'/u,
  );
  assert.match(
    readerAuthority,
    /REVOKE ALL ON FUNCTION public\.read_realtime_voice_trace_session_v2[\s\S]*WHERE current_setting\('app\.release_environment', TRUE\) <> 'staging'/u,
  );
  assert.match(releaseCert, /release_environment = 'staging'/u);
  assert.match(
    releaseCert,
    /has_function_privilege\([\s\S]*session_user,[\s\S]*read_realtime_voice_trace_session_v2/u,
  );
  assert.match(
    releaseCert,
    /has_function_privilege\([\s\S]*session_user,[\s\S]*read_realtime_voice_trace_session_v3/u,
  );
  assert.match(postgresCert, /Le CLI staging appelle la SECURITY DEFINER avec le role deployeur/u);
  assert.match(releaseCert, /ARRAY\['PUBLIC', 'anon', 'authenticated', 'service_role'\]/u);
  assert.match(releaseCert, /runtime\.rolsuper OR runtime\.rolbypassrls/u);
  assert.doesNotMatch(
    provision,
    /GRANT EXECUTE[\s\S]{0,180}TO (?:anon|authenticated|service_role)/u,
  );
});

test('les CHECK sont générés et le NOT VALID est validé dans une migration ultérieure', () => {
  assert.match(traceMigration, /REALTIME_TRACE_EVENT_KINDS_START/u);
  assert.match(retryExpand, /OPENAI_NATIVE_SPEECH_SCENARIOS_START/u);
  assert.match(retryExpand, /ADD CONSTRAINT[\s\S]*NOT VALID;/u);
  assert.doesNotMatch(retryExpand, /VALIDATE CONSTRAINT/u);
  assert.match(retryValidate, /VALIDATE CONSTRAINT/u);
  assert.match(clientCloseExpand, /REALTIME_TRACE_SESSION_CLOSE_REASONS_START/u);
  assert.match(clientCloseExpand, /ADD CONSTRAINT[\s\S]*NOT VALID;/u);
  assert.doesNotMatch(clientCloseExpand, /VALIDATE CONSTRAINT/u);
  assert.match(clientCloseValidate, /VALIDATE CONSTRAINT/u);
  assert.match(generator, /OPENAI_NATIVE_SPEECH_SCENARIO_IDS/u);
  assert.match(
    nativePostgresCert,
    /writer N-1 exact sous les états expand puis validate du scénario retry/u,
  );
  assert.match(nativePostgresCert, /convalidated AS validated/u);
  assert.match(
    postgresCert,
    /writer N-1 exact sous les états expand puis validate des motifs client/u,
  );
  assert.match(postgresCert, /realtime_voice_trace_close_reason_check_v2/u);
  for (const migration of [
    traceMigration,
    retryExpand,
    retryValidate,
    clientCloseExpand,
    clientCloseValidate,
    readerV3Expand,
  ]) {
    assert.match(migration, /SET LOCAL lock_timeout = '5s'/u);
    assert.match(migration, /SET LOCAL statement_timeout = '60s'/u);
  }
});

test('le lecteur V3 est additif, délègue une fois au V2 et expose le motif terminal', () => {
  assert.match(readerV3Expand, /CREATE FUNCTION public\.read_realtime_voice_trace_session_v3/u);
  assert.match(readerV3Expand, /WITH previous AS MATERIALIZED/u);
  assert.equal(
    readerV3Expand.match(/read_realtime_voice_trace_session_v2/gu)?.length,
    1,
  );
  assert.match(readerV3Expand, /"sessionCloseReason" VARCHAR\(32\)/u);
  assert.match(readerV3Expand, /stored\."sessionCloseReason"/u);
  assert.doesNotMatch(readerV3Expand, /DROP\s+(?:FUNCTION|TABLE)|ALTER\s+TABLE/iu);
  assert.match(readerV3Expand, /FROM PUBLIC/u);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.match(readerV3Expand, new RegExp(`'${role}'`, 'u'));
  }
  assert.match(provision, /SELECT \([^)]*"sessionCloseReason"/u);
  assert.match(releaseCert, /'sessionCloseReason'/u);
  assert.match(postgresCert, /sessionCloseReason: 'policy'/u);
});

test('le certificat comportemental couvre les invariants critiques réels', () => {
  for (const proof of [
    'DATABASE_URL and DIRECT_URL must target the same ephemeral database',
    'repository.assertReady',
    'insertFailureUnderOwner',
    'runtime_must_not_read',
    'toHaveLength(1_000)',
    'TRUNCATE TABLE public.realtime_voice_trace_events',
    'force_subject_erasure_rollback',
    'garde le writer Voice Trace N-1 fonctionnel',
  ])
    assert.match(postgresCert, new RegExp(proof.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

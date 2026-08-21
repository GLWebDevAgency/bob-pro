import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const [
  release,
  mistralCertification,
  capacityRelease,
  agentMissionLocalCertification,
  ciBootstrap,
  rlsOwnerSplitCertification,
  databasePairAssertion,
  ciWorkflow,
] = await Promise.all([
  readFile(path.join(scriptDir, 'release.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'certify-mistral-conversation-authority.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'realtime-capacity-release.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'certify-agent-missions-local.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'bootstrap-supabase-ci-postgres.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'certify-rls-owner-split.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'assert-database-pair.mjs'), 'utf8'),
  readFile(path.join(scriptDir, '../../../.github/workflows/ci.yml'), 'utf8'),
]);

const explicitDeployerMembership =
  /GRANT\s+(?:%I|bob_[a-z0-9_]+)\s+TO\s+(?:CURRENT_USER|SESSION_USER|bob_deployer|postgres)\b/iu;

const assertImplicitSetAuthority = (source, roleName) => {
  assert.doesNotMatch(source, explicitDeployerMembership);
  const failureMessage =
    `${roleName} is not available through implicit SET membership`;
  const failureMarker = source.indexOf(failureMessage);
  assert.ok(
    failureMarker >= 0,
    `${roleName} doit échouer fermé sans adhésion SET implicite`,
  );
  const blockStart = source.lastIndexOf(
    "SET createrole_self_grant = 'set'",
    failureMarker,
  );
  const finalFailureMarker = source.indexOf(
    `${roleName} has an unexpected member`,
    failureMarker,
  );
  assert.ok(blockStart >= 0, `${roleName} doit configurer createrole_self_grant`);
  assert.ok(
    finalFailureMarker > failureMarker,
    `${roleName} doit attester les deux directions du graphe d’adhésion`,
  );
  const authorityBlock = source.slice(
    blockStart,
    finalFailureMarker + `${roleName} has an unexpected member`.length,
  );

  assert.match(authorityBlock, /membership\.set_option/u);
  assert.match(authorityBlock, /NOT membership\.inherit_option/u);
  assert.match(
    authorityBlock,
    /pg_has_role\(current_user, (?:owner|authority)_oid, 'SET'\)/u,
  );
  assert.match(
    authorityBlock,
    /(?:parent|parent_role)\.rolname <> 'postgres'/u,
  );
  assert.match(
    authorityBlock,
    /(?:member|member_role)\.rolname NOT IN \(current_user, 'postgres'\)/u,
  );
  assert.match(authorityBlock, /WHERE membership\.member = (?:owner|authority)_oid/u);
  assert.match(authorityBlock, /WHERE membership\.roleid = (?:owner|authority)_oid/u);
};

const assertNoSuperuserOnlyRoleReplay = (source, roleName) => {
  const marker = `ALTER ROLE ${roleName}`;
  const start = source.indexOf(marker);
  const end = source.indexOf(';', start);
  assert.ok(start >= 0 && end > start, `${roleName} doit verrouiller ses attributs administrables`);
  assert.doesNotMatch(
    source.slice(start, end + 1),
    /\b(?:NOSUPERUSER|NOREPLICATION|NOBYPASSRLS)\b/u,
    `${roleName} ne doit pas réaffirmer des attributs réservés au superuser Supabase`,
  );
};

test('les owners NOLOGIN de release utilisent uniquement l’adhésion SET implicite', () => {
  for (const roleName of [
    'bob_mistral_bootstrap_reaper',
    'bob_openai_native_maintenance_directory',
    'bob_realtime_reaper_directory',
    'bob_jarvis_dispatch_directory',
  ]) {
    assertImplicitSetAuthority(release, roleName);
  }
  assertImplicitSetAuthority(capacityRelease, 'bob_realtime_capacity');
  assertImplicitSetAuthority(
    mistralCertification,
    'bob_mistral_bootstrap_reaper',
  );
  for (const roleName of [
    'bob_mistral_bootstrap_reaper',
    'bob_openai_native_maintenance_directory',
    'bob_realtime_reaper_directory',
    'bob_jarvis_dispatch_directory',
  ]) {
    assertNoSuperuserOnlyRoleReplay(release, roleName);
  }
  assertNoSuperuserOnlyRoleReplay(capacityRelease, 'bob_realtime_capacity');
  assertNoSuperuserOnlyRoleReplay(
    mistralCertification,
    'bob_mistral_bootstrap_reaper',
  );
});

test('aucun script ne réintroduit un fallback d’adhésion vers le déployeur', () => {
  for (const source of [
    release,
    mistralCertification,
    capacityRelease,
    agentMissionLocalCertification,
    ciBootstrap,
    rlsOwnerSplitCertification,
  ]) {
    assert.doesNotMatch(source, explicitDeployerMembership);
  }
  assert.match(
    agentMissionLocalCertification,
    /SET createrole_self_grant = 'set'[\s\S]*membership\.set_option[\s\S]*NOT membership\.inherit_option/u,
  );
});

test('bootstrap et owner-split partagent la même garde d’URI CI éphémère', () => {
  assert.match(
    ciBootstrap,
    /assert-database-pair\.mjs --ephemeral-supabase-ci bootstrap/u,
  );
  assert.match(
    rlsOwnerSplitCertification,
    /assert-database-pair\.mjs --ephemeral-supabase-ci owner-split/u,
  );
});

test('le rejeu des grants runtime laisse chaque objet transféré à son provisioner propriétaire', () => {
  const grantStart = release.indexOf('grant_app_role()');
  const grantEnd = release.indexOf('\nSQL\n}', grantStart);
  const grantBlock = release.slice(grantStart, grantEnd);
  assert.ok(grantStart >= 0 && grantEnd > grantStart);

  assert.doesNotMatch(grantBlock, /ON ALL TABLES IN SCHEMA public/u);
  assert.doesNotMatch(grantBlock, /ON ALL SEQUENCES IN SCHEMA public/u);
  assert.match(
    grantBlock,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I\.%I TO %I[\s\S]*?relation\.relowner = \([\s\S]*?role\.rolname = current_user/u,
  );
  assert.match(
    grantBlock,
    /relation\.relname NOT IN \(\s*'jarvis_dispatch_directory_cursors',\s*'realtime_global_capacity',\s*'realtime_voice_trace_events',\s*'realtime_voice_trace_access_audits'\s*\)[\s\S]*?relation\.relowner = \(/u,
  );
  assert.match(
    grantBlock,
    /realtime_global_capacity has an owner unavailable through SET membership/u,
  );
  assert.match(
    grantBlock,
    /SET LOCAL ROLE %I; REVOKE ALL PRIVILEGES ON TABLE public\.realtime_global_capacity FROM %I; RESET ROLE;/u,
  );
  assert.match(
    grantBlock,
    /GRANT USAGE, SELECT, UPDATE ON SEQUENCE %I\.%I TO %I[\s\S]*?relation\.relowner = \([\s\S]*?role\.rolname = current_user/u,
  );
  assert.doesNotMatch(
    grantBlock,
    /list_realtime_native_speech_maintenance_tenants_v1/u,
  );

  const runtimeGrantCall = release.lastIndexOf('\ngrant_app_role\n');
  assert.ok(
    release.indexOf('provision_openai_native_maintenance_directory', runtimeGrantCall)
      > runtimeGrantCall,
  );
  assert.ok(
    release.indexOf('realtime-capacity-release.sh provision', runtimeGrantCall)
      > runtimeGrantCall,
  );
});

const workflowJob = (name, nextName) => {
  const start = ciWorkflow.indexOf(`  ${name}:\n`);
  const end = ciWorkflow.indexOf(`  ${nextName}:\n`, start + 1);
  assert.ok(start >= 0, `workflow job ${name} must exist`);
  assert.ok(end > start, `workflow job ${name} must end before ${nextName}`);
  return ciWorkflow.slice(start, end);
};

test('les jobs release CI reproduisent Supabase avant toute certification', () => {
  const jobs = [
    workflowJob('rls-certification', 'document-archive-quarantine-certification'),
    workflowJob(
      'document-archive-quarantine-certification',
      'realtime-global-capacity-certification',
    ),
    workflowJob('realtime-global-capacity-certification', 'mistral-key-rotation-certification'),
    workflowJob('mistral-key-rotation-certification', 'facturx-conformance'),
  ];

  for (const job of jobs) {
    const bootstrap = job.indexOf('sh apps/api/scripts/bootstrap-supabase-ci-postgres.sh');
    const releaseCall = job.indexOf('sh apps/api/scripts/release.sh');
    assert.ok(bootstrap >= 0, 'le profil Supabase éphémère doit être installé');
    assert.ok(releaseCall > bootstrap, 'la release doit utiliser le déployeur déjà rétrogradé');
    assert.match(job, /CI_POSTGRES_SUPER_URL: postgresql:\/\/postgres:postgres@localhost/u);
    assert.match(
      job,
      /CI_POSTGRES_ADMIN_URL: postgresql:\/\/bob_ci_supabase_admin:bob_ci_supabase_admin@localhost/u,
    );
    assert.match(job, /id: release_schema/u);
    assert.match(
      job,
      /if: \$\{\{ always\(\) && steps\.release_schema\.outcome == 'success' \}\}/u,
    );
    assert.match(
      job,
      /SET LOCAL ROLE bob_realtime_capacity;[\s\S]*?FROM realtime_global_capacity/u,
    );
  }
});

test('le bootstrap CI borne le client loopback, le service Docker et les pré-grants Data API', () => {
  assert.match(
    databasePairAssertion,
    /LOOPBACK_HOSTS = new Set\(\['localhost', '127\.0\.0\.1', '\[::1\]'\]\)/u,
  );
  assert.match(
    databasePairAssertion,
    /ephemeral_database_url_must_be_loopback/u,
  );
  assert.match(
    databasePairAssertion,
    /ephemeral_database_url_requires_explicit_port/u,
  );
  assert.match(
    databasePairAssertion,
    /ephemeral_database_url_forbids_parameters/u,
  );
  assert.match(ciBootstrap, /bootstrap_network_mode=github-actions-service/u);
  assert.match(ciBootstrap, /server_address <<= pg_catalog\.inet '172\.16\.0\.0\/12'/u);
  assert.match(ciBootstrap, /client_address <<= pg_catalog\.inet '172\.16\.0\.0\/12'/u);
  assert.match(
    ciBootstrap,
    /relation\.relkind IN \('r', 'p', 'v', 'm', 'f', 'S'\)/u,
  );
  assert.match(ciBootstrap, /CREATE ROLE bob_ci_supabase_admin[\s\S]*?SUPERUSER/u);
  assert.match(
    ciBootstrap,
    /ALTER ROLE postgres RENAME TO bob_ci_bootstrap_superuser/u,
  );
  assert.match(
    ciBootstrap,
    /CREATE ROLE postgres[\s\S]*?NOSUPERUSER[\s\S]*?CREATEROLE[\s\S]*?BYPASSRLS/u,
  );
  assert.match(
    ciBootstrap,
    /CREATE ROLE postgres[\s\S]*?IN ROLE pg_monitor/u,
  );
  assert.match(
    ciBootstrap,
    /pg_has_role\(current_user, 'pg_monitor', 'MEMBER'\)/u,
  );
  assert.match(
    ciBootstrap,
    /GRANT SET ON PARAMETER session_replication_role TO postgres/u,
  );
  assert.match(
    ciBootstrap,
    /SET createrole_self_grant = 'set';[\s\S]*?SET ROLE postgres;[\s\S]*?CREATE ROLE bob_rls_schema_owner_cert[\s\S]*?NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;[\s\S]*?RESET ROLE;[\s\S]*?ALTER ROLE bob_rls_schema_owner_cert BYPASSRLS;/u,
  );
  assert.match(
    ciBootstrap,
    /SUPABASE_CI_RLS_OWNER_PROFILE_MISMATCH[\s\S]*?COALESCE\(pg_catalog\.bool_or\(membership\.set_option\), FALSE\)[\s\S]*?COALESCE\(pg_catalog\.bool_or\(membership\.admin_option\), FALSE\)[\s\S]*?COALESCE\(pg_catalog\.bool_or\(membership\.inherit_option\), FALSE\)[\s\S]*?SUPABASE_CI_RLS_OWNER_MEMBERSHIP_MISMATCH/u,
  );
  assert.match(
    ciBootstrap,
    /pg_has_role\(current_user, rls_owner\.oid, 'SET'\)[\s\S]*?pg_has_role\(current_user, rls_owner\.oid, 'USAGE'\)/u,
  );
  assert.match(
    ciBootstrap,
    /has_parameter_privilege\([\s\S]*?'session_replication_role',[\s\S]*?'SET'/u,
  );
  assert.match(ciBootstrap, /ALTER ROLE bob_ci_supabase_admin NOLOGIN/u);
  assert.match(
    ciBootstrap,
    /ARRAY\['anon', 'authenticated', 'service_role'\]/u,
  );
  assert.match(
    ciBootstrap,
    /ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public[\s\S]*?GRANT ALL PRIVILEGES ON TABLES/u,
  );
  assert.match(ciBootstrap, /SUPABASE_CI_DEPLOYER_PROFILE_MISMATCH/u);
  assert.match(ciBootstrap, /SUPABASE_CI_BOOTSTRAP_ADMIN_PROFILE_MISMATCH/u);
  assert.match(
    ciBootstrap,
    /CREATE ROLE service_role[\s\S]*?INHERIT NOREPLICATION BYPASSRLS/u,
  );
  assert.match(
    ciBootstrap,
    /CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS/u,
  );
  assert.match(ciBootstrap, /SUPABASE_CI_DEFAULT_ACL_MISSING/u);
});

test('le bootstrap refuse réellement les substitutions libpq et un poste local non confirmé', () => {
  const baseEnv = {
    ...process.env,
    GITHUB_ACTIONS: 'true',
    CI_POSTGRES_SUPER_URL:
      'postgresql://postgres:postgres@127.0.0.1:1/bob_ephemeral_ci',
    CI_POSTGRES_ADMIN_URL:
      'postgresql://bob_ci_supabase_admin:bob_ci_supabase_admin@127.0.0.1:1/bob_ephemeral_ci',
    DIRECT_URL:
      'postgresql://postgres:postgres@127.0.0.1:1/bob_ephemeral_ci',
  };

  for (const variable of [
    'CI_POSTGRES_SUPER_URL',
    'CI_POSTGRES_ADMIN_URL',
    'DIRECT_URL',
  ]) {
    const result = spawnSync(
      'sh',
      [path.join(scriptDir, 'bootstrap-supabase-ci-postgres.sh')],
      {
        encoding: 'utf8',
        env: {
          ...baseEnv,
          [variable]: `${baseEnv[variable]}?host=192.0.2.1`,
        },
      },
    );
    assert.notEqual(result.status, 0, `${variable} ne doit jamais accepter un host libpq caché`);
    assert.match(result.stderr, /ephemeral_database_url_forbids_parameters/u);
  }

  const localResult = spawnSync(
    'sh',
    [path.join(scriptDir, 'bootstrap-supabase-ci-postgres.sh')],
    {
      encoding: 'utf8',
      env: {
        ...baseEnv,
        GITHUB_ACTIONS: 'false',
        BOB_SUPABASE_CI_BOOTSTRAP_CONFIRMATION: '',
      },
    },
  );
  assert.notEqual(localResult.status, 0);
  assert.match(localResult.stderr, /restricted to GitHub Actions/u);
});

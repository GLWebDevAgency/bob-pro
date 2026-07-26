import assert from 'node:assert/strict';
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
  ciWorkflow,
] = await Promise.all([
  readFile(path.join(scriptDir, 'release.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'certify-mistral-conversation-authority.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'realtime-capacity-release.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'certify-agent-missions-local.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'bootstrap-supabase-ci-postgres.sh'), 'utf8'),
  readFile(path.join(scriptDir, '../../../.github/workflows/ci.yml'), 'utf8'),
]);

const explicitDeployerMembership =
  /GRANT\s+(?:%I|bob_[a-z0-9_]+)\s+TO\s+(?:CURRENT_USER|SESSION_USER|bob_deployer)\b/iu;

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
  assert.match(authorityBlock, /pg_has_role\(current_user, owner_oid, 'SET'\)/u);
  assert.match(
    authorityBlock,
    /(?:parent|parent_role)\.rolname <> 'postgres'/u,
  );
  assert.match(
    authorityBlock,
    /(?:member|member_role)\.rolname NOT IN \(current_user, 'postgres'\)/u,
  );
  assert.match(authorityBlock, /WHERE membership\.member = owner_oid/u);
  assert.match(authorityBlock, /WHERE membership\.roleid = owner_oid/u);
};

test('les owners NOLOGIN de release utilisent uniquement l’adhésion SET implicite', () => {
  for (const roleName of [
    'bob_mistral_bootstrap_reaper',
    'bob_openai_native_maintenance_directory',
    'bob_realtime_reaper_directory',
  ]) {
    assertImplicitSetAuthority(release, roleName);
  }
  assertImplicitSetAuthority(capacityRelease, 'bob_realtime_capacity');
  assertImplicitSetAuthority(
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
  ]) {
    assert.doesNotMatch(source, explicitDeployerMembership);
  }
  assert.match(
    agentMissionLocalCertification,
    /SET createrole_self_grant = 'set'[\s\S]*membership\.set_option[\s\S]*NOT membership\.inherit_option/u,
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
    workflowJob('rls-certification', 'realtime-global-capacity-certification'),
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

test('le bootstrap CI est loopback-only et certifie les pré-grants Data API', () => {
  assert.match(ciBootstrap, /remote databases are forbidden/u);
  assert.match(ciBootstrap, /allowedHosts = new Set\(\['localhost', '127\.0\.0\.1', '::1'\]\)/u);
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
  assert.match(ciBootstrap, /SUPABASE_CI_DEFAULT_ACL_MISSING/u);
});

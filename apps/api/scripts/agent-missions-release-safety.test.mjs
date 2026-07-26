import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(scriptDir, '..');
const repositoryRoot = path.resolve(apiDir, '..', '..');
const [
  release,
  localCertificate,
  runtimeGrants,
  releaseCertificate,
  packageJson,
  ci,
] = await Promise.all([
  readFile(path.join(scriptDir, 'release.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'certify-agent-missions-local.sh'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/agent-missions-runtime-grants.sql'), 'utf8'),
  readFile(path.join(apiDir, 'prisma/agent-missions-release-cert.sql'), 'utf8'),
  readFile(path.join(apiDir, 'package.json'), 'utf8'),
  readFile(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8'),
]);

test('le chemin de release resserre les ACL après le grant des objets du déployeur puis les certifie', () => {
  const grantFunctionStart = release.indexOf('grant_app_role()');
  const singleTransaction = release.indexOf(
    'psql "$DIRECT_URL" -X --single-transaction',
    grantFunctionStart,
  );
  const genericGrant = release.indexOf(
    "'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I'",
  );
  const exactGrant = release.indexOf('\\i apps/api/prisma/agent-missions-runtime-grants.sql');
  const grantTransactionEnd = release.indexOf('\nSQL\n}', exactGrant);
  const rlsReplay = release.indexOf('-f apps/api/prisma/rls.sql');
  const exactCertificate = release.indexOf('certify_agent_mission_release_acl', rlsReplay);
  assert.ok(genericGrant >= 0, 'Le grant runtime des tables du déployeur attendu a disparu.');
  assert.ok(exactGrant > genericGrant, 'Les ACL exactes doivent être appliquées après le grant générique.');
  assert.ok(
    grantFunctionStart >= 0
      && singleTransaction > grantFunctionStart
      && singleTransaction < genericGrant
      && grantTransactionEnd > exactGrant,
    'Grant générique et ACL exactes doivent partager une transaction.',
  );
  assert.ok(rlsReplay > exactGrant, 'Le replay RLS doit suivre les ACL runtime exactes.');
  assert.ok(
    exactCertificate > rlsReplay,
    'Le certificat runtime doit lire le résultat final après le replay RLS.',
  );
  assert.match(release, /connected_role="\$\([\s\S]*?APP_DATABASE_ROLE/u);
});

test('les ACL exactes utilisent SET ROLE propriétaire et une allowlist minimale', () => {
  assert.doesNotMatch(runtimeGrants, /\b(?:BEGIN|COMMIT);/u);
  assert.match(runtimeGrants, /pg_has_role\(current_user, owner_oid, 'SET'\)/u);
  assert.match(
    runtimeGrants,
    /SET ROLE %I; REVOKE ALL PRIVILEGES ON TABLE[\s\S]*?GRANT %s ON TABLE/u,
  );
  assert.match(runtimeGrants, /REVOKE SELECT \(%I\), INSERT \(%I\), UPDATE \(%I\), REFERENCES \(%I\)/u);
  assert.match(
    runtimeGrants,
    /'agent_missions'::TEXT,[\s\S]*?'SELECT, INSERT, UPDATE'::TEXT,[\s\S]*?'DELETE, TRUNCATE, REFERENCES, TRIGGER'/u,
  );
  assert.match(
    runtimeGrants,
    /'agent_mission_events'::TEXT,[\s\S]*?'SELECT, INSERT'::TEXT,[\s\S]*?'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'/u,
  );
  assert.match(runtimeGrants, /REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I/u);
});

test('le certificat s’exécute comme runtime non-superuser et ferme Data API + triggers', () => {
  assert.match(releaseCertificate, /current_user = :'app_role'/u);
  assert.match(releaseCertificate, /rolsuper OR runtime_role\.rolbypassrls/u);
  assert.match(releaseCertificate, /relrowsecurity[\s\S]*?relforcerowsecurity/u);
  assert.match(releaseCertificate, /has_any_column_privilege/u);
  for (const privilege of [
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'TRUNCATE',
    'REFERENCES',
    'TRIGGER',
  ]) {
    assert.match(releaseCertificate, new RegExp(`'${privilege}'`, 'u'));
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.match(releaseCertificate, new RegExp(`'${role}'`, 'u'));
  }
  for (const functionName of [
    'guard_agent_mission_mutation_v1',
    'guard_quote_draft_agent_mission_v1',
    'reject_agent_mission_event_mutation_v1',
    'guard_agent_mission_event_append_v1',
    'require_agent_mission_event_v1',
  ]) {
    assert.match(releaseCertificate, new RegExp(`${functionName}\\\\?\\(\\)`, 'u'));
  }
});

test('local et CI statique exercent les mêmes ACL que release', () => {
  assert.match(localCertificate, /agent-missions-runtime-grants\.sql/u);
  assert.match(localCertificate, /agent-missions-release-cert\.sql/u);
  const parsedPackage = JSON.parse(packageJson);
  assert.match(
    parsedPackage.scripts['test:release-flags'],
    /agent-missions-release-safety\.test\.mjs/u,
  );
  assert.match(parsedPackage.scripts.test, /agent-missions-release-safety\.test\.mjs/u);
});

test('la CI exécute la preuve PostgreSQL 17 avec un déployeur non-superuser', () => {
  assert.match(ci, /agent-missions-postgres-certification:/u);
  assert.match(ci, /image: postgres:17/u);
  assert.match(ci, /AGENT_MISSION_CERT_SUPER_URL:/u);
  assert.match(ci, /AGENT_MISSION_CERT_DEPLOYER_BOOTSTRAP_URL:/u);
  assert.match(ci, /run: sh apps\/api\/scripts\/certify-agent-missions-local\.sh/u);
  assert.match(localCertificate, /CREATE ROLE bob_deployer[\s\S]*?NOSUPERUSER/u);
  assert.match(localCertificate, /SET createrole_self_grant = 'set'/u);

  const expand = localCertificate.indexOf('20260726010000_agent_missions_expand');
  const intermediateWriter = localCertificate.indexOf('SET "revision" = 2', expand);
  const validate = localCertificate.indexOf(
    '20260726020000_agent_missions_validate',
    intermediateWriter,
  );
  const finalWriter = localCertificate.indexOf('SET "revision" = 3', validate);
  assert.ok(
    expand >= 0
      && intermediateWriter > expand
      && validate > intermediateWriter
      && finalWriter > validate,
    'Le writer N-1 doit être tenté après expand puis après validate.',
  );
});

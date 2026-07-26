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
] = await Promise.all([
  readFile(path.join(scriptDir, 'release.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'certify-mistral-conversation-authority.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'realtime-capacity-release.sh'), 'utf8'),
  readFile(path.join(scriptDir, 'certify-agent-missions-local.sh'), 'utf8'),
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
  ]) {
    assert.doesNotMatch(source, explicitDeployerMembership);
  }
  assert.match(
    agentMissionLocalCertification,
    /SET createrole_self_grant = 'set'[\s\S]*membership\.set_option[\s\S]*NOT membership\.inherit_option/u,
  );
});

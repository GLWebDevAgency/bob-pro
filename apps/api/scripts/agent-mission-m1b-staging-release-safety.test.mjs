import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const workflowPath = resolve(
  repositoryRoot,
  '.github/workflows/agent-mission-m1b-staging.yml',
);
const workflow = readFileSync(workflowPath, 'utf8');
const railwayReleaseWorkflow = readFileSync(
  resolve(repositoryRoot, '.github/workflows/railway-api.yml'),
  'utf8',
);
const reportSource = readFileSync(
  resolve(repositoryRoot, 'apps/api/scripts/agent-mission-m1b-staging-report.mjs'),
  'utf8',
);

function occurrences(value, pattern) {
  return value.match(pattern)?.length ?? 0;
}

test('workflow M1-B est uniquement manuel ou réutilisable, staging et sérialisé', () => {
  assert.match(workflow, /^on:\n  workflow_dispatch:/mu);
  assert.match(workflow, /^  workflow_call:/mu);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|schedule):/mu);
  assert.equal(occurrences(workflow, /^\s+environment: staging$/gmu), 2);
  assert.match(workflow, /group: railway-api-staging/u);
  assert.match(railwayReleaseWorkflow, /group: railway-api-\$\{\{ inputs\.environment \}\}/u);
  assert.match(workflow, /cancel-in-progress: false/u);
});

test('le workflow Railway déjà présent sur main sert seulement de trampoline pré-merge', () => {
  assert.match(
    railwayReleaseWorkflow,
    /- m1b-staging-certification/u,
  );
  assert.match(
    railwayReleaseWorkflow,
    /uses: \.\/\.github\/workflows\/agent-mission-m1b-staging\.yml/u,
  );
  assert.match(
    railwayReleaseWorkflow,
    /test "\$RELEASE_ENVIRONMENT" = staging/u,
  );
  assert.match(
    railwayReleaseWorkflow,
    /test "\$RELEASE_SERVICE" = "\$EXPECTED_SERVICE"/u,
  );
  assert.match(
    railwayReleaseWorkflow,
    /release-api:[\s\S]*?if: \$\{\{ always\(\) && inputs\.purpose != 'm1b-staging-certification' \}\}/u,
  );
  assert.match(
    railwayReleaseWorkflow,
    /certify-agent-mission-m1b-staging:[\s\S]*?secrets: inherit/u,
  );
});

test('workflow cible le SHA et les UUID sans relier le checkout ni changer de backend CLI', () => {
  assert.equal(occurrences(workflow, /ref: \$\{\{ github\.sha \}\}/gu), 3);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/u);
  assert.match(workflow, /RAILWAY_PROJECT_ID: \$\{\{ vars\.RAILWAY_PROJECT_ID \}\}/u);
  assert.match(workflow, /RAILWAY_ENVIRONMENT_ID: \$\{\{ vars\.RAILWAY_ENVIRONMENT_ID \}\}/u);
  assert.match(workflow, /RAILWAY_API_SERVICE_ID: \$\{\{ vars\.RAILWAY_API_SERVICE_ID \}\}/u);
  assert.doesNotMatch(workflow, /\bRAILWAY_ENV:/u);
  assert.doesNotMatch(workflow, /railway\s+link/u);
  assert.doesNotMatch(workflow, /railway\s+(?:environment|service)\s+link/u);
  assert.equal(
    occurrences(workflow, /railway (?:run|up|status)/gu),
    occurrences(
      workflow,
      /railway (?:run|up|status) --project "\$RAILWAY_PROJECT_ID"/gu,
    ),
    'every Railway CLI command must pin the immutable project explicitly',
  );
  assert.doesNotMatch(
    workflow,
    /railway run[^\n]*\\\n\s+railway run/u,
    'a continued Railway command must never contain a duplicated invocation',
  );
});

test('les trois déploiements ont un ID exact et le OFF d’urgence ne dépend pas de la DB', () => {
  assert.equal(occurrences(workflow, /BOB_RELEASE_PHASE=predeploy/gu), 3);
  assert.equal(occurrences(workflow, /BOB_RELEASE_PHASE=postdeploy/gu), 3);
  assert.equal(
    occurrences(
      workflow,
      /agent-mission-m1b-staging-railway\.mjs deployment-id/gu,
    ),
    3,
  );
  assert.equal(
    occurrences(
      workflow,
      /agent-mission-m1b-staging-railway\.mjs \\\n\s+wait-deployment/gu,
    ),
    3,
  );
  assert.equal(
    occurrences(workflow, /agent-mission-m1b-staging-readiness\.mjs/gu),
    3,
  );
  assert.equal(
    occurrences(workflow, /certify-railway-single-replica\.mjs/gu),
    3,
  );
  for (const phase of [
    'Baseline OFF predeploy',
    'Active M1-B predeploy',
    'OFF predeploy after owned configuration removal',
  ]) {
    assert.match(workflow, new RegExp(`- name: ${phase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
  assert.match(
    workflow,
    /id: deploy_off\n\s+if: \$\{\{ always\(\) && steps\.remove_variables\.outputs\.removed == 'true' \}\}/u,
  );
  assert.match(
    workflow,
    /Complete OFF postdeploy and writer fence\n\s+if: \$\{\{ always\(\) && steps\.off_predeploy\.outcome == 'success' && steps\.deploy_off\.outcome == 'success' \}\}/u,
  );
});

test('activation, override et cleanup sont bornés par ownership et preuve HMAC durable', () => {
  assert.match(workflow, /id: activate_variables/u);
  assert.match(workflow, /id: enable_override/u);
  assert.match(workflow, /variables_owned: \$\{\{ steps\.activate_variables\.outputs\.owned \}\}/u);
  assert.match(workflow, /override_owned: \$\{\{ steps\.enable_override\.outputs\.owned \}\}/u);
  assert.match(
    workflow,
    /BOB_M1B_STAGING_RUN_ID: \$\{\{ github\.run_id \}\}:\$\{\{ github\.run_attempt \}\}/u,
  );
  assert.match(workflow, /steps\.remove_variables\.outputs\.removed == 'true'/u);
  assert.match(workflow, /steps\.remove_override\.outputs\.removed/u);
  assert.match(
    workflow,
    /BOB_M1B_VARIABLES_WERE_OWNED: \$\{\{ needs\.certify\.outputs\.variables_owned \|\| 'false' \}\}/u,
  );
  assert.match(
    workflow,
    /true\) echo "removed=true" >> "\$GITHUB_OUTPUT"/u,
  );
  assert.doesNotMatch(workflow, /BOB_M1B_STAGING_VARIABLES_OWNED/u);
  assert.doesNotMatch(workflow, /BOB_M1B_STAGING_OVERRIDE_OWNED/u);
  assert.match(workflow, /cleanup:\n    needs: certify\n    if: \$\{\{ always\(\) \}\}/u);
  assert.match(workflow, /agent-mission-m1b-staging-key-state\.mjs preflight/u);
  assert.match(workflow, /agent-mission-m1b-staging-key-state\.mjs active/u);
  assert.match(workflow, /agent-mission-m1b-staging-key-state\.mjs off/u);
  assert.doesNotMatch(
    workflow,
    /manage-agent-mission-fingerprint-key-versions\.mjs\s+(?:stage|retire)/u,
  );
});

test('chaque mutation DB est précédée de la preuve du Supabase staging épinglé', () => {
  assert.match(workflow, /BOB_M1B_STAGING_SUPABASE_PROJECT_REF/u);
  assert.match(workflow, /BOB_M1B_STAGING_DATABASE_SYSTEM_IDENTIFIER/u);
  assert.match(workflow, /BOB_M1B_STAGING_DATABASE_OID/u);
  assert.match(workflow, /BOB_M1B_STAGING_DATABASE_NAME/u);
  assert.ok(
    occurrences(workflow, /agent-mission-m1b-staging-database\.mjs/gu) >= 5,
    'database identity must be re-certified before every release phase and cleanup mutation',
  );
  assert.match(
    workflow,
    /id: pin_database[\s\S]*?steps\.pin_database\.outcome == 'success'/u,
  );
  assert.match(
    workflow,
    /id: off_predeploy[\s\S]*?steps\.remove_override\.outcome == 'success'/u,
  );
});

test('workflow prouve les négociations réelle OFF/ON/OFF et rend un verdict binaire', () => {
  assert.equal(
    occurrences(workflow, /agent-mission-m1b-staging-smoke\.mjs negative/gu),
    2,
  );
  assert.equal(
    occurrences(workflow, /agent-mission-m1b-staging-smoke\.mjs positive/gu),
    1,
  );
  assert.match(workflow, /Execute real positive WebRTC mission and runtime RLS proof/u);
  assert.match(workflow, /Final independent OFF negotiation and data cleanliness proof/u);
  assert.match(workflow, /needs:\n      - certify\n      - cleanup\n      - evidence/u);
  assert.match(workflow, /test "\$CERTIFY_RESULT" = success/u);
  assert.match(workflow, /test "\$CLEANUP_RESULT" = success/u);
  assert.match(workflow, /test "\$EVIDENCE_RESULT" = success/u);
});

test('le lane M1-B ne mute aucun protocole étranger et ne masque aucun échec', () => {
  assert.doesNotMatch(workflow, /document-archive|archive:audit|settlement|outbox|mistral/iu);
  assert.doesNotMatch(workflow, /continue-on-error/u);
  assert.doesNotMatch(workflow, /\|\|\s+true/u);
  assert.doesNotMatch(workflow, /DEMO_MODE=true/u);
  assert.match(workflow, /agent-mission-m1b-staging-report\.mjs/u);
  assert.match(reportSource, /containsTokenSecretOrSdp: false/u);
});

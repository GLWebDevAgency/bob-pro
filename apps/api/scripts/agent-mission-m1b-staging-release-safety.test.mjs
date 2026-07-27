import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const workflowPath = resolve(repositoryRoot, '.github/workflows/agent-mission-m1b-staging.yml');
const workflow = readFileSync(workflowPath, 'utf8');
const railwayReleaseWorkflow = readFileSync(
  resolve(repositoryRoot, '.github/workflows/railway-api.yml'),
  'utf8',
);
const reportSource = readFileSync(
  resolve(repositoryRoot, 'apps/api/scripts/agent-mission-m1b-staging-report.mjs'),
  'utf8',
);
const readinessSource = readFileSync(
  resolve(repositoryRoot, 'apps/api/scripts/agent-mission-m1b-staging-readiness.mjs'),
  'utf8',
);

function occurrences(value, pattern) {
  return value.match(pattern)?.length ?? 0;
}

function workflowStep(id) {
  const start = workflow.indexOf(`        id: ${id}\n`);
  assert.notEqual(start, -1, `missing workflow step ${id}`);
  const end = workflow.indexOf('\n      - name:', start + 1);
  return workflow.slice(start, end === -1 ? workflow.length : end);
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
  assert.match(railwayReleaseWorkflow, /- m1b-staging-certification/u);
  assert.match(
    railwayReleaseWorkflow,
    /uses: \.\/\.github\/workflows\/agent-mission-m1b-staging\.yml/u,
  );
  assert.match(railwayReleaseWorkflow, /test "\$RELEASE_ENVIRONMENT" = staging/u);
  assert.match(railwayReleaseWorkflow, /test "\$RELEASE_SERVICE" = "\$EXPECTED_SERVICE"/u);
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
    occurrences(workflow, /railway (?:run|up|status) --project "\$RAILWAY_PROJECT_ID"/gu),
    'every Railway CLI command must pin the immutable project explicitly',
  );
  assert.doesNotMatch(
    workflow,
    /railway run[^\n]*\\\n\s+railway run/u,
    'a continued Railway command must never contain a duplicated invocation',
  );
});

test('les trois déploiements API et le déploiement Whisper ont un ID exact', () => {
  assert.equal(occurrences(workflow, /BOB_RELEASE_PHASE=predeploy/gu), 3);
  assert.equal(occurrences(workflow, /BOB_RELEASE_PHASE=postdeploy/gu), 3);
  const explicitStagingReleaseGates = occurrences(
    workflow,
    /env RELEASE_ENVIRONMENT=staging \\\n\s+sh apps\/api\/scripts\/check-release-env\.sh/gu,
  );
  assert.equal(
    explicitStagingReleaseGates,
    3,
    'every predeploy release gate must receive the immutable staging environment explicitly',
  );
  assert.equal(
    explicitStagingReleaseGates,
    occurrences(workflow, /check-release-env\.sh/gu),
    'a future release gate must not rely on process-environment inheritance through Railway CLI',
  );
  assert.equal(occurrences(workflow, /agent-mission-m1b-staging-railway\.mjs deployment-id/gu), 4);
  assert.equal(
    occurrences(workflow, /agent-mission-m1b-staging-railway\.mjs \\\n\s+wait-deployment/gu),
    3,
  );
  assert.equal(occurrences(workflow, /agent-mission-m1b-staging-readiness\.mjs/gu), 3);
  assert.equal(occurrences(workflow, /certify-railway-single-replica\.mjs/gu), 3);
  for (const stepId of ['deploy_whisper', 'deploy_baseline', 'deploy_active', 'deploy_off']) {
    const step = workflowStep(stepId);
    const outputIndex = step.indexOf('echo "deployment_id=$deployment_id"');
    const waitIndex = step.indexOf('wait-deployment');
    assert.ok(outputIndex > step.indexOf('railway up'), `${stepId} must capture Railway first`);
    assert.ok(waitIndex > outputIndex, `${stepId} must publish its deployment ID before waiting`);
  }
  const baselineStep = workflowStep('deploy_baseline');
  assert.ok(
    baselineStep.indexOf('echo "deployment_acknowledged=true"') >
      baselineStep.indexOf('wait-deployment'),
    'baseline acknowledgement must exist only after Railway SUCCESS',
  );
  assert.match(
    workflow,
    /baseline_deployment_acknowledged: \$\{\{ steps\.deploy_baseline\.outputs\.deployment_acknowledged \}\}/u,
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

test('Whisper est déployé et prouvé privé avant toute readiness M1-B positive', () => {
  assert.match(
    workflow,
    /RAILWAY_WHISPER_AUDIT_SERVICE_ID: \$\{\{ vars\.RAILWAY_WHISPER_AUDIT_SERVICE_ID \}\}/u,
  );
  assert.match(
    workflow,
    /id: deploy_whisper[\s\S]*?--service "\$RAILWAY_WHISPER_AUDIT_SERVICE_ID"/u,
  );
  assert.equal(occurrences(workflow, /agent-mission-m1b-staging-whisper\.mjs preflight/gu), 2);
  assert.equal(
    occurrences(workflow, /agent-mission-m1b-staging-whisper\.mjs \\\n\s+wait-deployment/gu),
    1,
  );
  assert.match(
    workflow,
    /whisper_deployment_id: \$\{\{ steps\.deploy_whisper\.outputs\.deployment_id \}\}/u,
  );
  assert.match(readinessSource, /payload\.dependencies\?\.bobLiveSpeechAudit !== 'ready'/u);
  assert.match(workflow, /id: active_readiness/u);
  assert.match(workflow, /acoustic_readiness_ms=/u);
  assert.match(
    workflow,
    /BOB_M1B_WHISPER_DEPLOYMENT_ID: \$\{\{ needs\.certify\.outputs\.whisper_deployment_id/u,
  );
  assert.match(
    workflow,
    /BOB_M1B_ACOUSTIC_READINESS_MS: \$\{\{ needs\.certify\.outputs\.acoustic_readiness_ms/u,
  );
});

test('activation, override et cleanup sont bornés par ownership et preuve HMAC durable', () => {
  assert.match(workflow, /id: activate_variables/u);
  assert.match(workflow, /id: enable_override/u);
  assert.match(workflow, /variables_owned: \$\{\{ steps\.activate_variables\.outputs\.owned \}\}/u);
  assert.match(workflow, /override_owned: \$\{\{ steps\.enable_override\.outputs\.owned \}\}/u);
  assert.equal(
    occurrences(
      workflow,
      /BOB_M1B_STAGING_RUN_ID: \$\{\{ github\.run_id \}\}$/gmu,
    ),
    2,
  );
  assert.doesNotMatch(
    workflow,
    /BOB_M1B_STAGING_RUN_ID:[^\n]*github\.run_attempt/u,
  );
  assert.match(workflow, /steps\.remove_variables\.outputs\.removed == 'true'/u);
  assert.match(workflow, /steps\.remove_override\.outputs\.removed/u);
  assert.match(
    workflow,
    /BOB_M1B_VARIABLES_WERE_OWNED: \$\{\{ needs\.certify\.outputs\.variables_owned \|\| 'false' \}\}/u,
  );
  assert.doesNotMatch(workflow, /BOB_M1B_OVERRIDE_WAS_OWNED/u);
  assert.doesNotMatch(workflow, /flag_command=/u);
  assert.match(workflow, /agent-mission-m1b-staging-flag\.mjs cleanup/u);
  assert.match(workflow, /true\) echo "removed=true" >> "\$GITHUB_OUTPUT"/u);
  assert.doesNotMatch(workflow, /BOB_M1B_STAGING_VARIABLES_OWNED/u);
  assert.doesNotMatch(workflow, /BOB_M1B_STAGING_OVERRIDE_OWNED/u);
  assert.match(workflow, /cleanup:\n    needs: certify\n    if: \$\{\{ always\(\) \}\}/u);
  assert.match(workflow, /agent-mission-m1b-staging-key-state\.mjs preflight/u);
  assert.match(workflow, /agent-mission-m1b-staging-key-state\.mjs bootstrap/u);
  assert.match(workflow, /agent-mission-m1b-staging-key-state\.mjs active/u);
  assert.match(workflow, /agent-mission-m1b-staging-key-state\.mjs off/u);
  assert.doesNotMatch(
    workflow,
    /manage-agent-mission-fingerprint-key-versions\.mjs\s+(?:stage|retire)/u,
  );
});

test('premier run N-1 est migration-aware puis exige le flag canonique juste après predeploy', () => {
  assert.equal(
    occurrences(workflow, /agent-mission-m1b-staging-flag\.mjs bootstrap-preflight/gu),
    2,
    'initial preflight and final cleanup must both distinguish an unmigrated staging',
  );
  assert.equal(
    occurrences(workflow, /agent-mission-m1b-staging-flag\.mjs preflight/gu),
    1,
    'the canonical flag must be checked strictly once migrations have completed',
  );
  assert.match(
    workflow,
    /- name: Baseline OFF predeploy[\s\S]*?BOB_RELEASE_PHASE=predeploy[\s\S]*?sh apps\/api\/scripts\/release\.sh[\s\S]*?agent-mission-m1b-staging-flag\.mjs preflight[\s\S]*?- name: Deploy exact SHA with M1-B OFF/u,
  );
  assert.match(
    workflow,
    /Final independent OFF data cleanliness proof[\s\S]*?agent-mission-m1b-staging-flag\.mjs bootstrap-preflight/u,
  );
  assert.match(
    workflow,
    /Final independent OFF negotiation proof when M1-B binary was deployed\n\s+if: \$\{\{ always\(\) && steps\.final_off_data\.outcome == 'success' && \(needs\.certify\.outputs\.baseline_deployment_acknowledged == 'true' \|\| needs\.certify\.outputs\.variables_owned == 'true'\) \}\}/u,
  );
  assert.doesNotMatch(
    workflow,
    /baseline_deployment_id != ''/,
    'a created deployment ID is evidence, not proof that Railway served the candidate',
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
  assert.match(workflow, /id: pin_database[\s\S]*?steps\.pin_database\.outcome == 'success'/u);
  assert.match(workflow, /id: off_predeploy[\s\S]*?steps\.remove_override\.outcome == 'success'/u);
});

test('workflow prouve les négociations réelle OFF/ON/OFF et rend un verdict binaire', () => {
  assert.equal(occurrences(workflow, /agent-mission-m1b-staging-smoke\.mjs negative/gu), 2);
  assert.equal(occurrences(workflow, /agent-mission-m1b-staging-smoke\.mjs positive/gu), 1);
  assert.match(workflow, /Execute real positive WebRTC mission and runtime RLS proof/u);
  assert.match(workflow, /Final independent OFF data cleanliness proof/u);
  assert.match(workflow, /Final independent OFF negotiation proof when M1-B binary was deployed/u);
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
  assert.match(reportSource, /containsAudioOrTranscript: false/u);
  assert.match(reportSource, /containsSignedUrl: false/u);
});

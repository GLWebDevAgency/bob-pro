import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const workflow = readFileSync(
  resolve(repositoryRoot, '.github/workflows/agent-mission-m2a3-staging-preview.yml'),
  'utf8',
);
const railwayWorkflow = readFileSync(
  resolve(repositoryRoot, '.github/workflows/railway-api.yml'),
  'utf8',
);

function occurrences(source, pattern) {
  return source.match(pattern)?.length ?? 0;
}

function job(name) {
  const jobs = workflow.indexOf('\njobs:\n');
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker, jobs);
  assert.notEqual(start, -1, `missing workflow job ${name}`);
  const following = [...workflow.matchAll(/^  [a-z][a-z0-9-]*:\s*$/gmu)]
    .map(({ index }) => index)
    .find((index) => index > start + marker.length);
  return workflow.slice(start, following ?? workflow.length);
}

test('le preview est staging-only, manuel/reutilisable et serialise avec les releases', () => {
  assert.match(workflow, /^permissions:\n  actions: read\n  contents: read$/mu);
  assert.match(workflow, /^on:\n  workflow_dispatch:/mu);
  assert.match(workflow, /^  workflow_call:/mu);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|schedule):/mu);
  assert.equal(occurrences(workflow, /^    environment: staging$/gmu), 3);
  assert.match(workflow, /group: railway-api-staging/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.doesNotMatch(workflow, /^\s+environment: production$/mu);
  assert.doesNotMatch(workflow, /apps\/api\/scripts\/release\.sh/u);
  assert.doesNotMatch(workflow, /railway\s+(?:link|environment link|service link)/u);
});

test('activation exige le SHA de main deja livre par une release staging normale', () => {
  assert.equal(occurrences(workflow, /ref: \$\{\{ github\.sha \}\}/gu), 3);
  assert.equal(occurrences(workflow, /persist-credentials: false/gu), 5);
  assert.equal(occurrences(workflow, /path: \.m2a3-serving-source/gu), 2);
  assert.equal(
    occurrences(workflow, /ref: \$\{\{ steps\.source_runtime\.outputs\.release_sha \}\}/gu),
    2,
  );
  assert.equal(occurrences(workflow, /test "\$EXPECTED_SHA" = "\$GITHUB_SHA"/gu), 3);
  const activation = job('activate');
  assert.match(
    activation,
    /^\n  activate:\n    if: \$\{\{ always\(\) && inputs\.mode == 'activate' \}\}/u,
  );
  assert.match(activation, /NORMAL_STAGING_RELEASE_RUN_ID/u);
  assert.match(activation, /run\?\.name !== 'Railway API Release'/u);
  assert.match(activation, /run\?\.head_branch !== 'main'/u);
  assert.match(activation, /run\?\.head_sha !== process\.env\.GITHUB_SHA/u);
  assert.match(activation, /run\?\.conclusion !== 'success'/u);
  assert.match(activation, /api-release-receipt-staging-\$\{process\.env\.GITHUB_SHA\}/u);
  const offBaseline = activation.indexOf(
    'Require the normally released exact SHA and a fully OFF baseline',
  );
  assert.match(activation, /id: baseline_runtime/u);
  assert.doesNotMatch(activation, /baseline_deployment_id:/u);
  assert.match(
    activation,
    /baseline_release_sha: \$\{\{ steps\.baseline_runtime\.outputs\.release_sha \}\}/u,
  );
  assert.ok(occurrences(activation, /serving-deployment-id/gu) >= 2);
  const arm = activation.indexOf('Arm DB-first rollback before the first mutation');
  const mutation = activation.indexOf(
    'agent-mission-m2a3-staging-preview-flag-railway.mjs enable-canary',
  );
  assert.ok(offBaseline >= 0 && arm > offBaseline && mutation > arm);
  const inlineSafety = activation.indexOf(
    'Force the database authority safe inline if activation did not complete',
  );
  assert.ok(inlineSafety > mutation);
  assert.match(
    activation,
    /always\(\) && steps\.arm_rollback\.outputs\.required == 'true' && \(failure\(\) \|\| cancelled\(\)\)/u,
  );
  assert.match(activation.slice(inlineSafety), /emergency-kill[\s\S]*?assert-effective-safe/u);
});

test('le canary V2 prouve son fuseau signé avant toute mutation sans affaiblir le drill OFF', () => {
  const activation = job('activate');
  assert.match(
    workflow,
    /BOB_M2A3_STAGING_TIME_ZONE: \$\{\{ vars\.BOB_M2A3_STAGING_TIME_ZONE \}\}/u,
  );
  assert.match(activation, /'BOB_M2A3_STAGING_TIME_ZONE'/u);
  assert.match(activation, /canonicalTimeZone !== stagingTimeZone/u);
  const preflight = activation.indexOf('staging-smoke.mjs preflight-v2');
  const baseline = activation.indexOf(
    'Require the normally released exact SHA and a fully OFF baseline',
  );
  const firstMutation = activation.indexOf(
    'agent-mission-m2a3-staging-preview-flag-railway.mjs enable-canary',
  );
  assert.ok(preflight >= 0 && baseline > preflight && firstMutation > baseline);
  assert.equal(occurrences(activation, /staging-smoke\.mjs preflight-v2\b/gu), 1);
  assert.equal(occurrences(job('rollback-activation'), /staging-smoke\.mjs preview-v2-off\b/gu), 1);
  assert.equal(occurrences(job('deactivate'), /staging-smoke\.mjs preview-v2-off\b/gu), 1);
});

test('activation prouve canary WebRTC V2 puis zero override avant le global ON', () => {
  const activation = job('activate');
  const canaryFlag = activation.indexOf(
    'agent-mission-m2a3-staging-preview-flag-railway.mjs enable-canary',
  );
  const variables = activation.indexOf('agent-mission-m1b-staging-railway.mjs activate');
  const releaseMetadata = activation.indexOf('write-release-metadata.mjs "$GITHUB_SHA" staging');
  const predeploy = activation.indexOf('agent-mission-m1b-staging-release.mjs predeploy');
  const deploy = activation.indexOf('railway up --project');
  const postdeploy = activation.indexOf('agent-mission-m1b-staging-release.mjs postdeploy');
  const firstSmoke = activation.indexOf('staging-smoke.mjs preview-v2');
  const removeCanary = activation.indexOf('staging-preview-flag-railway.mjs disable-canary');
  const global = activation.indexOf('staging-preview-flag-railway.mjs activate', removeCanary);
  const finalSmoke = activation.lastIndexOf('staging-smoke.mjs preview-v2');
  assert.ok(canaryFlag >= 0 && variables > canaryFlag);
  assert.ok(releaseMetadata >= 0 && releaseMetadata < predeploy);
  assert.ok(predeploy > variables && deploy > predeploy && postdeploy > deploy);
  assert.ok(firstSmoke > postdeploy && removeCanary > firstSmoke);
  assert.ok(global > removeCanary && finalSmoke > global);
  assert.equal(occurrences(activation, /staging-smoke\.mjs preview-v2\b/gu), 2);
  assert.match(activation, /BOB_M2A3_STAGING_OUTPUT=json[\s\S]*?assert-canary/u);
  assert.match(activation, /BOB_M2A3_STAGING_OUTPUT=json[\s\S]*?assert-active/u);
  assert.doesNotMatch(activation, /preview-v2-off/u);
});

test('rollback coupe DB avant build, restaure la capacite et recertifie le deploiement OFF', () => {
  const rollback = job('rollback-activation');
  assert.match(
    rollback,
    /if: \$\{\{ always\(\) && inputs\.mode == 'activate' && needs\.activate\.result != 'success' && needs\.activate\.outputs\.rollback_required == 'true' \}\}/u,
  );
  assert.match(
    rollback,
    /BOB_M2A3_PREVIEW_STARTED_AT: \$\{\{ needs\.activate\.outputs\.started_at \}\}/u,
  );
  assert.match(rollback, /id: initialize[\s\S]*?test "\$EXPECTED_SHA" = "\$GITHUB_SHA"/u);
  const flagOff = rollback.indexOf('Restore the database authority to OFF before runtime rollback');
  const postgres = rollback.indexOf('postgresql-client-16');
  const install = rollback.indexOf('pnpm install --frozen-lockfile');
  const close = rollback.indexOf('staging-release.mjs predeploy');
  const deployOff = rollback.indexOf(
    'Rebuild the captured normal-release source with current OFF variables',
  );
  const topology = rollback.indexOf('certify-railway-single-replica.mjs', deployOff);
  const offSmoke = rollback.indexOf('staging-smoke.mjs preview-v2-off');
  const restore = rollback.indexOf('staging-release.mjs restore-capacity');
  assert.ok(postgres >= 0 && flagOff > postgres && install > flagOff && close > install);
  assert.ok(deployOff > close && topology > deployOff && offSmoke > topology);
  assert.ok(restore > offSmoke);
  assert.match(rollback, /emergency-kill/u);
  assert.match(rollback, /assert-effective-safe/u);
  assert.match(
    rollback,
    /if: \$\{\{ always\(\) && steps\.database_safety\.outputs\.safe == 'true'/u,
  );
  assert.doesNotMatch(job('activate'), /staging-railway\.mjs deactivate/u);
  assert.doesNotMatch(rollback, /BASELINE_DEPLOYMENT_ID/u);
  assert.match(
    rollback,
    /BASELINE_RELEASE_SHA: \$\{\{ needs\.activate\.outputs\.baseline_release_sha \}\}/u,
  );
  assert.match(rollback, /staging-readiness\.mjs observe/u);
  assert.match(rollback, /assert-rebuildable-off-source/u);
  assert.match(rollback, /git merge-base --is-ancestor "\$served_release_sha" "\$GITHUB_SHA"/u);
  assert.match(rollback, /git -C "\$source_root" rev-parse HEAD/u);
  assert.match(rollback, /status --short\)" = "\?\? \.bob-release\.json"/u);
  assert.match(
    rollback,
    /staging-railway\.mjs assert-off[\s\S]*?railway up "\$source_root" --path-as-root/u,
  );
  assert.match(
    rollback,
    /test "\$current_deployment_id" = "\$\{\{ steps\.source_runtime\.outputs\.deployment_id \}\}"/u,
  );
  assert.match(rollback, /BOB_M2A3_PREVIEW_DEPLOYMENT_ACTION: captured-baseline-source-rebuild/u);
});

test('desactivation ne depend pas des autorisations ON et coupe avant readiness/build', () => {
  const deactivate = job('deactivate');
  const flagOff = deactivate.indexOf('Disable the database authority before touching runtime');
  const postgres = deactivate.indexOf('postgresql-client-16');
  const install = deactivate.indexOf('pnpm install --frozen-lockfile');
  const deployOff = deactivate.indexOf(
    'Rebuild the exact serving source with current OFF variables',
  );
  const readiness = deactivate.indexOf('staging-readiness.mjs', deployOff);
  const topology = deactivate.indexOf('certify-railway-single-replica.mjs', deployOff);
  const offSmoke = deactivate.indexOf('staging-smoke.mjs preview-v2-off');
  const restore = deactivate.indexOf('staging-release.mjs restore-capacity');
  assert.ok(postgres >= 0 && flagOff > postgres && install > flagOff && deployOff > install);
  assert.ok(readiness > deployOff && topology > deployOff && offSmoke > topology);
  assert.ok(restore > offSmoke);
  assert.match(deactivate, /emergency-kill/u);
  assert.match(deactivate, /assert-effective-safe/u);
  assert.match(deactivate, /Refuse to report canonical OFF when emergency kills remain armed/u);
  assert.match(deactivate, /test "\$GITHUB_REF" = refs\/heads\/main/u);
  assert.match(deactivate, /serving-deployment-id/u);
  assert.match(deactivate, /staging-readiness\.mjs observe/u);
  assert.match(deactivate, /assert-rebuildable-off-source/u);
  assert.match(deactivate, /inspect-owned-preview/u);
  assert.match(deactivate, /test "\$owned_release_sha" = "\$served_release_sha"/u);
  assert.match(deactivate, /git merge-base --is-ancestor "\$served_release_sha" "\$GITHUB_SHA"/u);
  assert.match(deactivate, /git -C "\$source_root" rev-parse HEAD/u);
  assert.match(deactivate, /status --short\)" = "\?\? \.bob-release\.json"/u);
  assert.match(
    deactivate,
    /staging-railway\.mjs assert-off[\s\S]*?railway up "\$source_root" --path-as-root/u,
  );
  assert.match(
    deactivate,
    /test "\$current_deployment_id" = "\$\{\{ steps\.source_runtime\.outputs\.deployment_id \}\}"/u,
  );
  assert.match(deactivate, /BOB_M2A3_PREVIEW_DEPLOYMENT_ACTION: exact-source-rebuild/u);
  assert.match(deactivate, /staging-preview-report\.mjs write/u);
  assert.match(deactivate, /staging-preview-report\.mjs verify/u);
  assert.match(deactivate, /Preserve the live-observed OFF receipt/u);
  const deactivationHeader = workflow.slice(0, workflow.indexOf('\nconcurrency:'));
  assert.match(
    deactivationHeader,
    /founder_authorization_date:[\s\S]*?required: false[\s\S]*?claude_countersign_ref:[\s\S]*?required: false/u,
  );
});

test('trois deploiements attendent leur ID et chaque etat deploye recertifie la topologie', () => {
  assert.equal(occurrences(workflow, /staging-railway\.mjs deployment-id/gu), 3);
  assert.equal(occurrences(workflow, /wait-deployment "\$deployment_id"/gu), 3);
  assert.equal(occurrences(workflow, /railway up/gu), 3);
  assert.doesNotMatch(workflow, /deploymentRedeploy|redeploy-exact|redeploy-captured-baseline/u);
  assert.ok(occurrences(workflow, /certify-railway-single-replica\.mjs/gu) >= 5);
  assert.equal(occurrences(workflow, /expected_deployment_id="\$\{\{ steps\.deploy_/gu), 4);
  assert.equal(
    occurrences(workflow, /test "\$serving_deployment_id" = "\$expected_deployment_id"/gu),
    4,
  );
});

test("chaque preuve topologique cible l'UUID Railway exact du service API", () => {
  const certifierCalls = occurrences(workflow, /certify-railway-single-replica\.mjs/gu);
  assert.equal(certifierCalls, 5);
  assert.equal(
    occurrences(
      workflow,
      /certify-railway-single-replica\.mjs\s*\\\s*\n\s*staging "\$RAILWAY_API_SERVICE_ID"/gu,
    ),
    certifierCalls,
  );
});

test('chaque Railway CLI epingle projet, environnement et service sans relink', () => {
  assert.equal(
    occurrences(workflow, /railway (?:run|status)/gu),
    occurrences(workflow, /railway (?:run|status) --project "\$RAILWAY_PROJECT_ID"/gu),
  );
  assert.equal(occurrences(workflow, /railway up/gu), 3);
  assert.equal(occurrences(workflow, /--path-as-root/gu), 2);
  assert.equal(
    occurrences(workflow, /railway up[\s\S]{0,220}--project "\$RAILWAY_PROJECT_ID"/gu),
    3,
  );
  assert.doesNotMatch(workflow, /--environment production/u);
  assert.doesNotMatch(workflow, /TARGET_ENVIRONMENT_NAME/u);
  assert.doesNotMatch(
    workflow,
    /railway run[\s\S]{0,240}agent-mission-m2a3-staging-preview-flag\.mjs/u,
  );
  assert.ok(occurrences(workflow, /agent-mission-m2a3-staging-preview-flag-railway\.mjs/gu) >= 12);
  assert.equal(
    occurrences(workflow, /railway status --project/gu),
    occurrences(workflow, /timeout 20s railway status --project/gu),
  );
});

test('les recus sont produits dans le job depuis des observations live versionnees', () => {
  assert.equal(occurrences(workflow, /staging-preview-report\.mjs write/gu), 3);
  assert.equal(occurrences(workflow, /staging-preview-report\.mjs verify/gu), 3);
  assert.equal(occurrences(workflow, /retention-days: 90/gu), 3);
  assert.equal(occurrences(workflow, /if-no-files-found: error/gu), 3);
  assert.doesNotMatch(workflow, /^  (?:activation|deactivation)-evidence:/mu);
  for (const name of [
    'BOB_M2A3_PREVIEW_RUNTIME_OBSERVATION',
    'BOB_M2A3_PREVIEW_KEY_OBSERVATION',
    'BOB_M2A3_PREVIEW_FLAG_OBSERVATION',
    'BOB_M2A3_PREVIEW_TOPOLOGY_OBSERVATION',
    'BOB_M2A3_PREVIEW_READINESS_OBSERVATION',
    'BOB_M2A3_PREVIEW_SMOKE_OBSERVATION',
  ]) {
    assert.ok(occurrences(workflow, new RegExp(name, 'gu')) >= 2, `${name} must be live-bound`);
  }
  assert.match(job('activate'), /BOB_M2A3_PREVIEW_DECISION_DOCUMENT_SHA256/u);
  assert.equal(occurrences(workflow, /BOB_M2A3_PREVIEW_SOURCE_DEPLOYMENT_ID/gu), 2);
  assert.equal(occurrences(workflow, /BOB_M2A3_PREVIEW_SOURCE_RUNTIME_STATE/gu), 2);
  assert.match(job('verdict'), /test "\$ACTIVATE_RESULT" = success/u);
  assert.match(job('verdict'), /test "\$DEACTIVATE_RESULT" = success/u);
});

test('le routeur transmet exactement la cible, la provenance et les contresignatures', () => {
  assert.match(railwayWorkflow, /- m2a3-staging-preview-activate/u);
  assert.match(railwayWorkflow, /- m2a3-staging-preview-deactivate/u);
  assert.match(
    railwayWorkflow,
    /route-m2a3-staging-preview:[\s\S]*?test "\$RELEASE_ENVIRONMENT" = staging[\s\S]*?test "\$CONTROL_REF" = refs\/heads\/main[\s\S]*?test "\$EXPECTED_SHA" = "\$GITHUB_SHA"/u,
  );
  const route = railwayWorkflow.slice(
    railwayWorkflow.indexOf('\n  operate-agent-mission-m2a3-staging-preview:'),
    railwayWorkflow.indexOf('\n  certify-agent-mission-k2-staging-schema:'),
  );
  for (const name of [
    'expected_sha',
    'normal_staging_release_run_id',
    'founder_authorization_date',
    'founder_authorization_channel',
    'founder_authorization_ref',
    'claude_countersign_ref',
    'gpt_countersign_ref',
  ]) {
    assert.match(route, new RegExp(`${name}: \\$\\{\\{ inputs\\.${name} \\}\\}`, 'u'));
  }
  assert.match(route, /secrets: inherit/u);
  assert.match(railwayWorkflow, /release-api:[\s\S]*?inputs\.purpose == 'release'/u);
});

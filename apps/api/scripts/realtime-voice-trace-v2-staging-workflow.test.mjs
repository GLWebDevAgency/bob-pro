import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const workflow = readFileSync(
  resolve(repositoryRoot, '.github/workflows/realtime-voice-trace-v2-staging.yml'),
  'utf8',
);
const railwayWorkflow = readFileSync(
  resolve(repositoryRoot, '.github/workflows/railway-api.yml'),
  'utf8',
);
const receiptScript = readFileSync(
  resolve(repositoryRoot, 'apps/api/scripts/realtime-voice-trace-v2-receipt.mjs'),
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

test('le drill est manuel, reutilisable, exact-SHA et serialise avec staging', () => {
  assert.match(workflow, /^permissions:\n  actions: read\n  contents: read$/mu);
  assert.match(workflow, /^on:\n  workflow_dispatch:/mu);
  assert.match(workflow, /^  workflow_call:/mu);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|schedule):/mu);
  assert.match(workflow, /group: railway-api-staging/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.equal(occurrences(workflow, /test "\$EXPECTED_SHA" = "\$GITHUB_SHA"/gu), 2);
  assert.match(job('staging-drill'), /api-release-receipt-staging-\$\{process\.env\.GITHUB_SHA\}/u);
  assert.match(job('staging-drill'), /run\?\.head_branch !== 'main'/u);
  assert.match(job('staging-drill'), /run\?\.conclusion !== 'success'/u);
});

test('les jobs production sont lecture publique stricte sans secret ni control plane', () => {
  for (const productionJob of [job('production-before'), job('production-after')]) {
    assert.match(productionJob, /environment: production/u);
    assert.match(productionJob, /snapshot-production/u);
    assert.doesNotMatch(
      productionJob,
      /secrets\.|RAILWAY|DATABASE|DIRECT_URL|SUPABASE|railway\s|psql\s|VOICE_TRACE_REALTIME_V2_ENABLED/u,
    );
  }
  const after = job('production-after');
  assert.match(after, /test "\$after_digest" = "\$BEFORE_DIGEST"/u);
  assert.match(after, /always\(\) && needs\.production-before\.result == 'success'/u);
  assert.match(after, /- rollback-off/u);
});

test('la sequence certifie OFF puis ON OFF ON et termine effectivement active', () => {
  const staging = job('staging-drill');
  const baseline = staging.indexOf('voice-trace-v2-off');
  const arm = staging.indexOf('Arm OFF rollback before the first mutation');
  const drillStep = staging.indexOf(
    'Execute three close-deploy-open cycles with a real canary at every state',
  );
  const drillBody = staging.slice(drillStep);
  const transitionStart = drillBody.indexOf('transition_and_canary()');
  const callsStart = drillBody.indexOf('transition_and_canary activate on', transitionStart);
  const transition = drillBody.slice(transitionStart, callsStart);
  const predeploy = transition.indexOf('staging-release.mjs predeploy');
  const operation = transition.indexOf('staging-railway.mjs "$operation"');
  const deploy = transition.indexOf('deploy_exact "$state"');
  const postdeploy = transition.indexOf('staging-release.mjs postdeploy');
  const canary = transition.indexOf('canary_and_cleanup "$state"');
  assert.ok(baseline >= 0 && arm > baseline && drillStep > arm);
  assert.ok(transitionStart >= 0 && predeploy >= 0 && operation > predeploy);
  assert.ok(deploy > operation && postdeploy > deploy && canary > postdeploy);
  assert.equal(occurrences(drillBody, /transition_and_canary activate on/gu), 2);
  assert.equal(occurrences(drillBody, /transition_and_canary deactivate off/gu), 1);
  assert.match(transition, /capacity_restore_required=true[\s\S]*?predeploy/u);
  assert.match(transition, /postdeploy[\s\S]*?capacity_restore_required=false/u);
  assert.match(drillBody, /assert-active[\s\S]*?assert-staging-on/u);
});

test('chaque canary est WebRTC reel, sans faux ACK et sans audio conserve', () => {
  const staging = job('staging-drill');
  assert.match(staging, /espeak-ng -v fr/u);
  assert.match(staging, /Je souhaite créer un nouveau client/u);
  assert.match(staging, /playwright install --with-deps chromium/u);
  assert.match(staging, /verify-\$state/u);
  assert.match(staging, /staging-evidence\.mjs cleanup/u);
  assert.match(staging, /staging-evidence\.mjs verify-clean/u);
  assert.match(staging, /emit-staging-outputs/u);
  assert.match(receiptScript, /audioStored: false/u);
  assert.match(receiptScript, /transcriptInCi: false/u);
  assert.doesNotMatch(workflow, /upload-artifact[\s\S]{0,240}(?:\.wav|CANARY_AUDIO_FILE)/u);
  assert.doesNotMatch(workflow, /turn_speech_delivered/u);
});

test('le seul recu certifie vient apres la preuve production finale et porte toutes les preuves', () => {
  const staging = job('staging-drill');
  const after = job('production-after');
  assert.doesNotMatch(staging, /upload-artifact/u);
  const snapshot = after.indexOf('Prove production stayed public, inactive and byte-stable');
  const stagingVerdict = after.indexOf('Require the certified final staging state');
  const receipt = after.indexOf('Write the final non-PII exact-SHA receipt');
  const archive = after.indexOf('Preserve the certified non-PII staging receipt');
  assert.ok(
    snapshot >= 0 && stagingVerdict > snapshot && receipt > stagingVerdict && archive > receipt,
  );
  assert.match(after, /PRODUCTION_BEFORE_DIGEST/u);
  assert.match(after, /PRODUCTION_AFTER_DIGEST/u);
  assert.match(after, /CANARY_EVENT_COUNT/u);
  assert.match(after, /CLEANUP_EVENTS_REMOVED/u);
  assert.match(after, /CLEANUP_FINAL_EVENTS/u);
  assert.match(after, /realtime-voice-trace-v2-receipt\.mjs final-receipt/u);
});

test('tout echec force OFF avant rebuild puis restaure la capacite', () => {
  const staging = job('staging-drill');
  assert.match(
    staging,
    /if: \$\{\{ always\(\) && needs\.production-before\.result == 'success' \}\}/u,
  );
  assert.match(
    staging,
    /always\(\) && steps\.arm_rollback\.outputs\.required == 'true' && \(failure\(\) \|\| cancelled\(\)\)/u,
  );
  const inline = staging.indexOf('Force a cancellation-safe closed and staged-OFF state inline');
  assert.match(staging.slice(inline), /staging-database\.mjs[\s\S]*?predeploy[\s\S]*?force-off/u);
  const rollback = job('rollback-off');
  assert.match(
    rollback,
    /if: \$\{\{ always\(\) && needs\.staging-drill\.result != 'success' && needs\.staging-drill\.outputs\.rollback_required == 'true' \}\}/u,
  );
  const installControl = rollback.indexOf('Install only the pinned safety control plane');
  const firstRailway = rollback.indexOf('railway run --project');
  const databasePin = rollback.indexOf('staging-database.mjs');
  const close = rollback.indexOf('staging-release.mjs predeploy');
  const forceOff = rollback.indexOf('staging-railway.mjs force-off');
  const installApplication = rollback.indexOf(
    'Install exact application dependencies only after safety is closed',
  );
  const cleanup = rollback.indexOf('staging-evidence.mjs cleanup');
  const deploy = rollback.indexOf('railway up --project');
  const topology = rollback.indexOf('certify-railway-single-replica.mjs');
  const readiness = rollback.indexOf('assert-staging-off');
  const restore = rollback.indexOf('staging-release.mjs restore-capacity');
  assert.ok(installControl >= 0 && firstRailway > installControl);
  assert.ok(databasePin >= 0 && close > databasePin && forceOff > close);
  assert.ok(installApplication > forceOff && cleanup > installApplication && deploy > cleanup);
  assert.ok(topology > deploy && readiness > topology && restore > readiness);
  assert.match(
    rollback,
    /if: \$\{\{ always\(\) && steps\.deploy_safe_off\.outputs\.safe == 'true' \}\}/u,
  );
  assert.doesNotMatch(rollback, /environment: production/u);
});

test('le routeur Railway expose un seul purpose staging dedie', () => {
  assert.equal(occurrences(railwayWorkflow, /^\s+- realtime-voice-trace-v2-staging$/gmu), 1);
  assert.match(
    railwayWorkflow,
    /route-realtime-voice-trace-v2-staging:[\s\S]*?test "\$RELEASE_ENVIRONMENT" = staging/u,
  );
  assert.match(
    railwayWorkflow,
    /uses: \.\/\.github\/workflows\/realtime-voice-trace-v2-staging\.yml/u,
  );
  assert.match(
    railwayWorkflow,
    /normal_staging_release_run_id: \$\{\{ inputs\.normal_staging_release_run_id \}\}/u,
  );
});

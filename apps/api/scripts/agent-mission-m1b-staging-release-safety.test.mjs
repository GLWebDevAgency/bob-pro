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
const m2a3SemanticWorkflow = readFileSync(
  resolve(repositoryRoot, '.github/workflows/agent-mission-m2a3-semantic-staging.yml'),
  'utf8',
);
const m2a3SemanticEvidenceValidator = readFileSync(
  resolve(repositoryRoot, 'apps/api/scripts/validate-agent-mission-m2a3-semantic-evidence.mjs'),
  'utf8',
);
const m2a3SemanticLiveEvaluation = readFileSync(
  resolve(
    repositoryRoot,
    'apps/api/src/voice/realtime/evaluation/m2a3-semantic-model-evaluation.live.test.ts',
  ),
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
const targetedReleaseSource = readFileSync(
  resolve(repositoryRoot, 'apps/api/scripts/agent-mission-m1b-staging-release.mjs'),
  'utf8',
);
const capacityAuthorityCertificate = readFileSync(
  resolve(repositoryRoot, 'apps/api/prisma/realtime-global-capacity-release-cert.sql'),
  'utf8',
);
const fingerprintManagerSource = readFileSync(
  resolve(repositoryRoot, 'apps/api/scripts/manage-agent-mission-fingerprint-key-versions.mjs'),
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

function workflowStepByName(name) {
  const start = workflow.indexOf(`- name: ${name}\n`);
  assert.notEqual(start, -1, `missing workflow step ${name}`);
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
  assert.match(railwayReleaseWorkflow, /- m1b-staging-recovery/u);
  assert.match(railwayReleaseWorkflow, /- m2a3-semantic-certification/u);
  assert.match(railwayReleaseWorkflow, /- m2a3-staging-schema/u);
  assert.match(railwayReleaseWorkflow, /- k2-staging-schema/u);
  assert.match(
    railwayReleaseWorkflow,
    /uses: \.\/\.github\/workflows\/agent-mission-m1b-staging\.yml/u,
  );
  assert.match(railwayReleaseWorkflow, /test "\$RELEASE_ENVIRONMENT" = staging/u);
  assert.match(railwayReleaseWorkflow, /test "\$RELEASE_SERVICE" = "\$EXPECTED_SERVICE"/u);
  assert.match(
    railwayReleaseWorkflow,
    /release-api:[\s\S]*?needs: validate-purpose[\s\S]*?if: \$\{\{ always\(\) && needs\.validate-purpose\.result == 'success' && inputs\.purpose == 'release' \}\}/u,
  );
  assert.match(
    railwayReleaseWorkflow,
    /validate-purpose:[\s\S]*?release\|m1b-staging-certification\|m1b-staging-recovery\|m2a3-semantic-certification\|m2a3-staging-schema\|k2-staging-schema\)[\s\S]*?Unsupported Railway release purpose/u,
  );
  assert.match(
    railwayReleaseWorkflow,
    /certify-agent-mission-m1b-staging:[\s\S]*?secrets: inherit/u,
  );
  assert.match(
    railwayReleaseWorkflow,
    /mode: \$\{\{ inputs\.purpose == 'm1b-staging-recovery' && 'recovery' \|\| 'certification' \}\}/u,
  );
  assert.match(
    railwayReleaseWorkflow,
    /route-m2a3-semantic-certification:[\s\S]*?test "\$EXPECTED_SHA" = "\$GITHUB_SHA"/u,
  );
  assert.match(
    railwayReleaseWorkflow,
    /certify-agent-mission-m2a3-semantic:[\s\S]*?uses: \.\/\.github\/workflows\/agent-mission-m2a3-semantic-staging\.yml[\s\S]*?expected_sha: \$\{\{ inputs\.expected_sha \}\}[\s\S]*?secrets: inherit/u,
  );
  assert.match(
    railwayReleaseWorkflow,
    /route-m2a3-staging-schema:[\s\S]*?test "\$EXPECTED_SHA" = "\$GITHUB_SHA"/u,
  );
  assert.match(
    railwayReleaseWorkflow,
    /certify-agent-mission-m2a3-staging-schema:[\s\S]*?uses: \.\/\.github\/workflows\/agent-mission-m2a3-staging-schema\.yml[\s\S]*?expected_sha: \$\{\{ inputs\.expected_sha \}\}[\s\S]*?secrets: inherit/u,
  );
});

test('le certificat M2-A-3 est manuel, exact-SHA, staging et sans clé OpenAI GitHub', () => {
  assert.match(
    m2a3SemanticWorkflow,
    /^on:\n  workflow_dispatch:[\s\S]*?expected_sha:[\s\S]*?required: true[\s\S]*?workflow_call:[\s\S]*?expected_sha:[\s\S]*?required: true/mu,
  );
  assert.doesNotMatch(m2a3SemanticWorkflow, /^\s+(?:push|pull_request|schedule):/mu);
  assert.equal(occurrences(m2a3SemanticWorkflow, /^\s+environment: staging$/gmu), 1);
  assert.match(m2a3SemanticWorkflow, /group: railway-api-staging/u);
  assert.match(m2a3SemanticWorkflow, /cancel-in-progress: false/u);
  assert.match(
    m2a3SemanticWorkflow,
    /test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"[\s\S]*?test "\$EXPECTED_SHA" = "\$GITHUB_SHA"/u,
  );
  assert.match(m2a3SemanticWorkflow, /pnpm install --frozen-lockfile/u);
  assert.match(
    m2a3SemanticWorkflow,
    /RUN_BOB_LIVE_M2A3_MODEL_EVAL=true[\s\S]*?BOB_LIVE_M2A3_EVAL_RELEASE_SHA="\$GITHUB_SHA"/u,
  );
  assert.match(
    m2a3SemanticWorkflow,
    /railway run --project "\$RAILWAY_PROJECT_ID"[\s\S]*?--service "\$RAILWAY_API_SERVICE_ID"[\s\S]*?--environment "\$RAILWAY_ENVIRONMENT_ID" --no-local/u,
  );
  assert.doesNotMatch(m2a3SemanticWorkflow, /secrets\.OPENAI_API_KEY/u);
  assert.doesNotMatch(m2a3SemanticWorkflow, /railway\s+link/u);
  assert.match(m2a3SemanticEvidenceValidator, /receipt\.corpusVersion !== 4/u);
  assert.match(
    m2a3SemanticEvidenceValidator,
    /receipt\.providerRequestCount === CASE_IDS\.length/u,
  );
  assert.match(m2a3SemanticEvidenceValidator, /'catalogue-stored-injection'/u);
  assert.match(
    m2a3SemanticWorkflow,
    /railway run[\s\S]*?env[\s\S]*?BOB_LIVE_PROVIDER=openai[\s\S]*?RUN_BOB_LIVE_M2A3_MODEL_EVAL=true/u,
  );
  assert.match(m2a3SemanticEvidenceValidator, /receipt\.generateCount === 0/u);
  assert.match(m2a3SemanticEvidenceValidator, /entry\.status !== 'mission_frame'/u);
  assert.match(m2a3SemanticWorkflow, /id: live_eval[\s\S]*?continue-on-error: true/u);
  assert.match(m2a3SemanticWorkflow, /id: receipt_guard[\s\S]*?if: \$\{\{ always\(\) \}\}/u);
  assert.match(
    m2a3SemanticWorkflow,
    /Preserve exact-SHA semantic evidence[\s\S]*?if: \$\{\{ always\(\) && steps\.receipt_guard\.outcome == 'success' \}\}/u,
  );
  assert.match(
    m2a3SemanticWorkflow,
    /LIVE_OUTCOME: \$\{\{ steps\.live_eval\.outcome \}\}[\s\S]*?RECEIPT_GUARD_OUTCOME: \$\{\{ steps\.receipt_guard\.outcome \}\}[\s\S]*?test "\$\{LIVE_OUTCOME:-missing\}" = "success"[\s\S]*?test "\$\{RECEIPT_GUARD_OUTCOME:-missing\}" = "success"/u,
  );
  assert.match(m2a3SemanticWorkflow, /validate-agent-mission-m2a3-semantic-evidence\.mjs/u);
  assert.match(
    m2a3SemanticWorkflow,
    /path: \.release-evidence\/agent-mission-m2a3\/semantic-model\.json/u,
  );
  assert.doesNotMatch(m2a3SemanticWorkflow, /path: \.release-evidence\/agent-mission-m2a3\/\s*$/mu);
  assert.match(m2a3SemanticEvidenceValidator, /returnedModelStatus/u);
  assert.match(m2a3SemanticEvidenceValidator, /issueCodes/u);
  assert.match(
    m2a3SemanticEvidenceValidator,
    /receipt\.requestedModelSource === 'versioned_default'/u,
  );
  assert.match(
    m2a3SemanticLiveEvaluation,
    /process\.env\.OPENAI_MODEL !== undefined[\s\S]*?la V1 certifie exclusivement le défaut versionné/u,
  );
  assert.match(m2a3SemanticWorkflow, /if-no-files-found: error/u);
  assert.match(m2a3SemanticWorkflow, /retention-days: 90/u);
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

test('le compte Bob Live échoue avant toute installation, build ou mutation staging coûteuse', () => {
  assert.equal(occurrences(workflow, /agent-mission-m1b-staging-smoke\.mjs preflight/gu), 1);
  const preflight = workflow.indexOf(
    'node apps/api/scripts/agent-mission-m1b-staging-smoke.mjs preflight',
  );
  const install = workflow.indexOf('- name: Install deterministic release dependencies');
  const build = workflow.indexOf('- name: Build the exact runtime and certify dedicated operators');
  const whisper = workflow.indexOf('- name: Preflight and deploy the private Whisper auditor');
  assert.ok(preflight > workflow.indexOf('node-version: 22.18.0'));
  assert.ok(preflight < install);
  assert.ok(preflight < build);
  assert.ok(preflight < whisper);
  assert.match(
    workflow,
    /SUPABASE_URL: "https:\/\/\$\{\{ vars\.BOB_M1B_STAGING_SUPABASE_PROJECT_REF \}\}\.supabase\.co"/u,
  );
});

test('les trois déploiements API et le déploiement Whisper ont un ID exact', () => {
  assert.equal(occurrences(workflow, /agent-mission-m1b-staging-release\.mjs predeploy/gu), 3);
  assert.equal(occurrences(workflow, /agent-mission-m1b-staging-release\.mjs postdeploy/gu), 3);
  assert.equal(
    occurrences(workflow, /agent-mission-m1b-staging-release\.mjs restore-capacity/gu),
    1,
  );
  assert.equal(occurrences(workflow, /env CABINET_RELEASE_ENV=staging/gu), 7);
  assert.doesNotMatch(workflow, /BOB_RELEASE_PHASE/u);
  assert.doesNotMatch(workflow, /apps\/api\/scripts\/release\.sh/u);
  const explicitStagingReleaseGates = occurrences(
    workflow,
    /env RELEASE_ENVIRONMENT=staging BOB_RELEASE_EXPECTED_ENV=staging \\\n\s+sh apps\/api\/scripts\/check-release-env\.sh/gu,
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
  assert.equal(
    occurrences(workflow, /agent-mission-m1b-staging-readiness\.mjs/gu),
    8,
    'each mutually exclusive certification/recovery smoke plus cleanup must replay readiness',
  );
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
  assert.equal(occurrences(workflow, /BOB_M1B_STAGING_RUN_ID: \$\{\{ github\.run_id \}\}$/gmu), 2);
  assert.doesNotMatch(workflow, /BOB_M1B_STAGING_RUN_ID:[^\n]*github\.run_attempt/u);
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
  const hmacPreflight = workflowStepByName('Prove stable HMAC keyspace cannot rotate');
  assert.doesNotMatch(hmacPreflight, /\n\s+if:/u);
  assert.ok(
    workflow.indexOf('Prove stable HMAC keyspace cannot rotate') <
      workflow.indexOf('Activate only the complete M1-B variable block'),
  );
  assert.doesNotMatch(
    workflow,
    /manage-agent-mission-fingerprint-key-versions\.mjs\s+(?:stage|retire)/u,
  );
});

test('le cleanup récupère le résidu borné avant de retirer override et variables', () => {
  const recovery = workflow.indexOf(
    'Recover the exact technical residue before disabling M1-B',
  );
  const removeOverride = workflow.indexOf(
    'Remove only the user override durably owned by this run',
  );
  const removeVariables = workflow.indexOf(
    'Remove only the Railway block durably owned by this run',
  );
  assert.ok(recovery > workflow.indexOf('Pin exact staging database before cleanup mutations'));
  assert.ok(recovery < removeOverride);
  assert.ok(recovery < removeVariables);

  const recoveryStep = workflowStep('recover_account');
  assert.match(recoveryStep, /certifyM1BRecoveryStateEvidence/u);
  assert.match(recoveryStep, /case "\$\(printf '%s\\n' "\$recovery_state" \| tail -n 1\)"/u);
  assert.match(recoveryStep, /clean\) ;;/u);
  assert.match(recoveryStep, /recoverable\)[\s\S]*?staging-readiness\.mjs/u);
  assert.match(recoveryStep, /agent-mission-m1b-staging-smoke\.mjs recovery/u);
  assert.doesNotMatch(recoveryStep, /continue-on-error/u);

  const removeOverrideStep = workflowStep('remove_override');
  const removeVariablesStep = workflowStep('remove_variables');
  assert.match(removeOverrideStep, /if: \$\{\{ always\(\)/u);
  assert.match(removeVariablesStep, /if: \$\{\{ always\(\) \}\}/u);
});

test('le cleanup restaure toujours la capacité après une désactivation Railway prouvée', () => {
  const restoreStep = workflowStep('restore_capacity');
  assert.match(
    restoreStep,
    /if: \$\{\{ always\(\) && steps\.pin_database\.outcome == 'success' && steps\.remove_override\.outcome == 'success' && steps\.remove_variables\.outcome == 'success' \}\}/u,
  );
  assert.match(
    restoreStep,
    /agent-mission-m1b-staging-database\.mjs[\s\S]*?agent-mission-m1b-staging-release\.mjs restore-capacity/u,
  );
  assert.doesNotMatch(
    restoreStep,
    /railway up|manage-agent-mission-fingerprint-key-versions|agent-mission-m1b-staging-key-state/u,
  );

  const completeOff = workflow.indexOf('Complete OFF postdeploy and writer fence');
  const untouchedKeyspace = workflow.indexOf(
    'Prove untouched keyspace when activation never became owned',
  );
  const restore = workflow.indexOf(
    'Restore global Bob Live capacity independently after cleanup attempts',
  );
  const finalProof = workflow.indexOf('Final independent OFF data cleanliness proof');
  assert.ok(restore > completeOff);
  assert.ok(restore > untouchedKeyspace);
  assert.ok(finalProof > restore);
});

test('la restauration distingue le certificat actif du certificat fermé avant mutation', () => {
  assert.match(
    capacityAuthorityCertificate,
    /capacity_row\.mode <> 'closed'/u,
    'le certificat historique reste volontairement fermé avant toute mutation',
  );
  assert.match(
    targetedReleaseSource,
    /const ACTIVE_CAPACITY_CONFIGURATION_SQL = `[\s\S]*?state_row\.mode <> 'active'[\s\S]*?state_row\."providerId" IS DISTINCT FROM selected_provider[\s\S]*?state_row\."configVersion" IS DISTINCT FROM selected_version/u,
  );

  const restoreStart = targetedReleaseSource.indexOf('async function restoreCapacity(');
  const restoreEnd = targetedReleaseSource.indexOf(
    '\nexport async function runM1BStagingRelease(',
    restoreStart,
  );
  const restoreSource = targetedReleaseSource.slice(restoreStart, restoreEnd);
  const activeBranch = restoreSource.indexOf("if (state.mode === 'active')");
  const activeCertificate = restoreSource.indexOf(
    'dependencies.certifyActiveCapacity ?? certifyActiveCapacity',
    activeBranch,
  );
  const activeReturn = restoreSource.indexOf("return 'active'", activeCertificate);
  const closeAndDrain = restoreSource.indexOf(
    'dependencies.closeAndDrainCapacity ?? closeAndDrainCapacity',
    activeReturn,
  );
  const closedCertificate = restoreSource.indexOf(
    'dependencies.certifyCapacityAuthority ?? certifyCapacityAuthority',
    closeAndDrain,
  );
  const configure = restoreSource.lastIndexOf(
    'dependencies.configureCapacity ?? configureCapacity',
  );
  assert.ok(activeBranch >= 0);
  assert.ok(activeCertificate > activeBranch && activeReturn > activeCertificate);
  assert.ok(closeAndDrain > activeReturn && closedCertificate > closeAndDrain);
  assert.ok(configure > closedCertificate);
});

test('staging est réconcilié avant la recertification stricte puis exige le flag canonique', () => {
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
    /- name: Baseline OFF predeploy[\s\S]*?agent-mission-m1b-staging-release\.mjs predeploy[\s\S]*?agent-mission-m1b-staging-flag\.mjs preflight[\s\S]*?- name: Deploy exact SHA with M1-B OFF/u,
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

test('le lane staging refuse toute réparation Prisma et laisse le gate strict faire autorité', () => {
  assert.equal(
    occurrences(
      workflow,
      /node apps\/api\/scripts\/agent-mission-m1b-staging-migration-reconcile\.mjs/gu,
    ),
    0,
  );
  const databasePin = workflow.indexOf(
    'node apps/api/scripts/agent-mission-m1b-staging-database.mjs',
  );
  const flagPreflight = workflow.indexOf(
    'node apps/api/scripts/agent-mission-m1b-staging-flag.mjs bootstrap-preflight',
  );
  const firstRelease = workflow.indexOf(
    'node apps/api/scripts/agent-mission-m1b-staging-release.mjs predeploy',
  );
  assert.ok(databasePin >= 0);
  assert.ok(flagPreflight > databasePin);
  assert.ok(firstRelease > flagPreflight);
  assert.match(
    workflow,
    /agent-mission-m1b-staging-database\.mjs[\s\S]*?agent-mission-m1b-staging-flag\.mjs bootstrap-preflight/u,
  );
});

test('workflow prouve les négociations réelle OFF/ON/OFF et rend un verdict binaire', () => {
  assert.equal(occurrences(workflow, /agent-mission-m1b-staging-smoke\.mjs negative/gu), 2);
  assert.equal(occurrences(workflow, /agent-mission-m1b-staging-smoke\.mjs positive/gu), 1);
  assert.equal(occurrences(workflow, /agent-mission-m1b-staging-smoke\.mjs recovery/gu), 2);
  assert.match(workflow, /Execute real positive WebRTC mission and runtime RLS proof/u);
  assert.match(workflow, /Recover only the exact technical staging residue/u);
  assert.match(workflow, /Final independent OFF data cleanliness proof/u);
  assert.match(workflow, /Final independent OFF negotiation proof when M1-B binary was deployed/u);
  assert.match(workflow, /needs:\n      - certify\n      - cleanup\n      - evidence/u);
  assert.match(workflow, /test "\$CERTIFY_RESULT" = success/u);
  assert.match(workflow, /test "\$CLEANUP_RESULT" = success/u);
  assert.match(workflow, /test "\$EVIDENCE_RESULT" = success/u);
  assert.match(
    workflow,
    /recovery-verdict:[\s\S]*?if: \$\{\{ always\(\) && inputs\.mode == 'recovery' \}\}[\s\S]*?test "\$RECOVERY_RESULT" = success[\s\S]*?test "\$CLEANUP_RESULT" = success/u,
  );
  assert.match(
    workflow,
    /Preserve bounded staging evidence[\s\S]*?Require the measured staging budget after preserving evidence[\s\S]*?verify-performance/u,
  );
  assert.match(reportSource, /targetDurationMilliseconds/u);
  assert.match(reportSource, /targetMet: durationMilliseconds < TARGET_DURATION_MILLISECONDS/u);
});

test('chaque smoke réel, cleanup compris, repart d’une readiness re-certifiée au SHA exact, cache acoustique chaud', () => {
  for (const [stepName, smokeCommand] of [
    ['Prove real WebRTC negotiation remains OFF', 'agent-mission-m1b-staging-smoke.mjs negative'],
    [
      'Execute real positive WebRTC mission and runtime RLS proof',
      'agent-mission-m1b-staging-smoke.mjs positive',
    ],
    [
      'Recover only the exact technical staging residue',
      'agent-mission-m1b-staging-smoke.mjs recovery',
    ],
    [
      'Final independent OFF negotiation proof when M1-B binary was deployed',
      'agent-mission-m1b-staging-smoke.mjs negative',
    ],
  ]) {
    const step = workflowStepByName(stepName);
    const readiness = step.indexOf('node apps/api/scripts/agent-mission-m1b-staging-readiness.mjs');
    const smoke = step.indexOf(smokeCommand);
    assert.notEqual(
      readiness,
      -1,
      `${stepName} must replay the exact-SHA readiness proof before its smoke`,
    );
    assert.notEqual(smoke, -1, `${stepName} must run ${smokeCommand}`);
    assert.ok(
      readiness < smoke,
      `${stepName} must warm the acoustic cache immediately before ${smokeCommand}`,
    );
  }
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

test('le gate ciblé ne traverse aucun mutateur étranger ni réparation globale', () => {
  assert.doesNotMatch(
    targetedReleaseSource,
    /pg_catalog\.coalesce/u,
    'COALESCE est une expression SQL et ne peut pas être qualifiée par un schéma',
  );
  assert.match(
    targetedReleaseSource,
    /label: 'foreign-authority-snapshot'/u,
    'une panne staging doit identifier sa sous-preuve sans exposer stderr',
  );
  assert.doesNotMatch(
    targetedReleaseSource,
    /release\.sh|prisma migrate deploy|rls\.sql|runtime-grants|certify-mistral|manage-mistral|manage-bob-live-native/u,
  );
  assert.match(targetedReleaseSource, /manage-agent-mission-fingerprint-key-versions\.mjs/u);
  assert.match(targetedReleaseSource, /realtime-global-capacity-release-cert\.sql/u);
  assert.match(targetedReleaseSource, /PGCONNECT_TIMEOUT/u);
  assert.match(targetedReleaseSource, /boundedPsqlSpawnOptions/u);
  assert.match(targetedReleaseSource, /timeout: KEY_MANAGER_PROCESS_TIMEOUT_MS/u);
  assert.doesNotMatch(
    fingerprintManagerSource,
    /manage-mistral|manage-bob-live-native|document_archive_protocol_state|invoice_settlement_protocol_state/u,
  );

  const snapshotStart = targetedReleaseSource.indexOf('const FOREIGN_AUTHORITY_SNAPSHOT_SQL = `');
  const snapshotEnd = targetedReleaseSource.indexOf('\n`;', snapshotStart);
  assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart);
  const outsideForeignSnapshot =
    targetedReleaseSource.slice(0, snapshotStart) + targetedReleaseSource.slice(snapshotEnd + 3);
  assert.doesNotMatch(
    outsideForeignSnapshot,
    /realtime_mistral_conversation_(?:key|identity)|document_archive_protocol_state|invoice_settlement_protocol_state/u,
  );
  assert.match(targetedReleaseSource, /UPDATE public\.realtime_global_capacity/g);
  assert.doesNotMatch(
    targetedReleaseSource,
    /\b(?:INSERT INTO|DELETE FROM|ALTER TABLE|CREATE TABLE|DROP TABLE|TRUNCATE TABLE)\b/iu,
  );
});

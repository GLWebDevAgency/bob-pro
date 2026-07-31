import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const workflow = readFileSync(
  resolve(
    repositoryRoot,
    '.github/workflows/agent-mission-m2a3-staging-schema.yml',
  ),
  'utf8',
);
const railwayWorkflow = readFileSync(
  resolve(repositoryRoot, '.github/workflows/railway-api.yml'),
  'utf8',
);

function occurrences(value, pattern) {
  return value.match(pattern)?.length ?? 0;
}

function workflowJob(name) {
  const jobsStart = workflow.indexOf('\njobs:\n');
  assert.notEqual(jobsStart, -1, 'workflow jobs are missing');
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker, jobsStart);
  assert.notEqual(start, -1, `workflow job ${name} is missing`);
  const candidates = [...workflow.matchAll(/^\s{2}[a-z][a-z0-9_-]*:\s*$/gmu)]
    .map(({ index }) => index)
    .filter((index) => index > start + marker.length);
  const end = candidates[0] ?? workflow.length;
  return workflow.slice(start, end);
}

test('le workflow est uniquement manuel/réutilisable, read-only et sérialisé staging', () => {
  assert.match(workflow, /^permissions:\n[ ]{2}contents: read$/mu);
  assert.match(workflow, /^on:\n[ ]{2}workflow_dispatch:/mu);
  assert.match(workflow, /^[ ]{2}workflow_call:/mu);
  assert.doesNotMatch(
    workflow,
    /^\s+(?:push|pull_request|schedule):/mu,
  );
  assert.match(workflow, /group: railway-api-staging/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.equal(occurrences(workflow, /^\s{4}environment: staging$/gmu), 4);
  assert.match(
    workflow,
    /manifest_digest:[\s\S]*?value: \$\{\{ jobs\.finalize\.outputs\.manifest_digest \}\}/u,
  );
});

test('le graphe est strictement expand, validate, cutover puis finalize', () => {
  const expand = workflowJob('expand');
  const validate = workflowJob('validate');
  const cutover = workflowJob('cutover');
  const finalize = workflowJob('finalize');
  assert.doesNotMatch(expand, /^\s{4}needs:/mu);
  assert.match(validate, /^\s{4}needs: expand$/mu);
  assert.match(cutover, /^\s{4}needs: validate$/mu);
  assert.match(
    finalize,
    /^\s{4}needs:\n\s{6}- expand\n\s{6}- validate\n\s{6}- cutover$/mu,
  );
});

test('chaque job cible le checkout et le SHA exact avant toute opération', () => {
  assert.equal(
    occurrences(workflow, /ref: \$\{\{ github\.sha \}\}/gu),
    4,
  );
  assert.equal(
    occurrences(workflow, /persist-credentials: false/gu),
    4,
  );
  for (const name of ['expand', 'validate', 'cutover', 'finalize']) {
    const source = workflowJob(name);
    assert.match(source, /EXPECTED_SHA: \$\{\{ inputs\.expected_sha \}\}/u);
    assert.match(
      source,
      /test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/u,
    );
    assert.match(source, /test "\$EXPECTED_SHA" = "\$GITHUB_SHA"/u);
  }
  assert.match(workflowJob('expand'), /\^\[a-f0-9\]\{40\}\$/u);
});

test('les trois phases Railway sont épinglées et chaînent un digest hex64 exact', () => {
  assert.equal(occurrences(workflow, /railway run --project/gu), 3);
  assert.equal(
    occurrences(
      workflow,
      /railway run --project "\$RAILWAY_PROJECT_ID"[\s\S]*?--service "\$RAILWAY_API_SERVICE_ID"[\s\S]*?--environment "\$RAILWAY_ENVIRONMENT_ID" --no-local --/gu,
    ),
    3,
  );
  assert.equal(
    occurrences(workflow, /BOB_M2A3_PREVIOUS_RECEIPT_DIGEST=/gu),
    3,
  );
  assert.match(
    workflowJob('expand'),
    /BOB_M2A3_PREVIOUS_RECEIPT_DIGEST=none/u,
  );
  assert.match(
    workflowJob('validate'),
    /PREVIOUS_RECEIPT_DIGEST: \$\{\{ needs\.expand\.outputs\.receipt_digest \}\}/u,
  );
  assert.match(
    workflowJob('cutover'),
    /PREVIOUS_RECEIPT_DIGEST: \$\{\{ needs\.validate\.outputs\.receipt_digest \}\}/u,
  );
  assert.equal(
    occurrences(workflow, /\^\[a-f0-9\]\{64\}\$/gu),
    5,
    'three receipts and two previous outputs must be strict hex64',
  );
});

test('les preuves sont nommées par SHA, phase et tentative puis téléchargées exactement', () => {
  for (const phase of ['expand', 'validate', 'cutover']) {
    const source = workflowJob(phase);
    assert.match(
      source,
      new RegExp(
        `agent-mission-m2a3-schema-\\$\\{EXPECTED_SHA\\}-${phase}-\\$\\{GITHUB_RUN_ATTEMPT\\}`,
        'u',
      ),
    );
    assert.match(source, /if: \$\{\{ always\(\) \}\}/u);
    assert.match(source, /if-no-files-found: error/u);
    assert.match(source, /include-hidden-files: true/u);
    assert.match(source, /retention-days: 90/u);
  }
  const finalize = workflowJob('finalize');
  assert.match(finalize, /Validate exact artifact names before evidence download/u);
  for (const phase of ['expand', 'validate', 'cutover']) {
    assert.match(
      finalize,
      new RegExp(
        `name: \\$\\{\\{ needs\\.${phase}\\.outputs\\.artifact_name \\}\\}`,
        'u',
      ),
    );
  }
  assert.equal(
    occurrences(
      finalize,
      /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/gu,
    ),
    3,
  );
  assert.match(
    finalize,
    /echo "manifest_digest=\$digest" >> "\$GITHUB_OUTPUT"/u,
  );
});

test('le workflow schema-only interdit déploiement, activation et contournement migration', () => {
  for (const forbidden of [
    /\bproduction\b/u,
    /railway\s+up/u,
    /railway\s+link/u,
    /railway\s+variables?/u,
    /release\.sh/u,
    /BOB_RELEASE_PHASE/u,
    /migrate\s+resolve/u,
    /migrate\s+reset/u,
    /prisma\s+db\s+push/u,
    /continue-on-error/u,
    /\|\|\s+true/u,
  ]) {
    assert.doesNotMatch(workflow, forbidden);
  }
});

test('Railway route le purpose schema-only au SHA exact sans ouvrir la release', () => {
  assert.match(railwayWorkflow, /- m2a3-staging-schema/u);
  assert.match(
    railwayWorkflow,
    /expected_sha:[\s\S]*?required: false[\s\S]*?default: ''/u,
  );
  assert.match(
    railwayWorkflow,
    /route-m2a3-staging-schema:[\s\S]*?test "\$RELEASE_ENVIRONMENT" = staging[\s\S]*?test "\$RELEASE_SERVICE" = "\$EXPECTED_SERVICE"[\s\S]*?\^\[a-f0-9\]\{40\}\$[\s\S]*?EXPECTED_SHA[\s\S]*?GITHUB_SHA/u,
  );
  assert.match(
    railwayWorkflow,
    /certify-agent-mission-m2a3-staging-schema:[\s\S]*?uses: \.\/\.github\/workflows\/agent-mission-m2a3-staging-schema\.yml[\s\S]*?expected_sha: \$\{\{ inputs\.expected_sha \}\}[\s\S]*?secrets: inherit/u,
  );
  assert.match(
    railwayWorkflow,
    /m2a3_schema_manifest_digest:[\s\S]*?jobs\.certify-agent-mission-m2a3-staging-schema\.outputs\.manifest_digest/u,
  );
  assert.match(
    railwayWorkflow,
    /release-api:[\s\S]*?inputs\.purpose == 'release'/u,
  );
});

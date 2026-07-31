import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const wrapper = resolve(
  repositoryRoot,
  'apps/api/scripts/run-m2a3-railway-with-bounded-fetch-retry.sh',
);

async function createHarness(t, railwayScenario, childScenario = 'success') {
  const root = await mkdtemp(resolve(tmpdir(), 'bob-m2a3-railway-fetch-retry-test-'));
  const bin = resolve(root, 'bin');
  const guard = resolve(root, 'evidence');
  const railwayCounter = resolve(root, 'railway-counter');
  const railwayPid = resolve(root, 'railway-pid');
  const childCounter = resolve(root, 'child-counter');
  const childPid = resolve(root, 'child-pid');
  const grandchildPid = resolve(root, 'grandchild-pid');
  const grandchildReady = resolve(root, 'grandchild-ready');
  const childStarted = resolve(root, 'operator-started');
  const operator = resolve(root, 'operator.mjs');
  await mkdir(bin);
  await mkdir(guard);

  const railway = resolve(bin, 'railway');
  await writeFile(
    railway,
    `#!/usr/bin/env bash
set -u
printf '%s' "$$" > "$BOB_FAKE_RAILWAY_PID"
count=0
if [[ -f "$BOB_FAKE_RAILWAY_COUNTER" ]]; then
  count="$(<"$BOB_FAKE_RAILWAY_COUNTER")"
fi
count=$((count + 1))
printf '%s' "$count" > "$BOB_FAKE_RAILWAY_COUNTER"

emit_decode_failure() {
  printf '%s\\n' \\
    'Failed to fetch: error decoding response body' \\
    '' \\
    'Caused by:' \\
    '    0: error decoding response body' \\
    '    1: expected ident at line 1 column 2' \\
    >&2
}

run_child() {
  while (($# > 0)); do
    if [[ "$1" == '--' ]]; then
      shift
      (($# > 0)) || return 96
      "$@"
      return $?
    fi
    shift
  done
  return 96
}

case "$BOB_FAKE_RAILWAY_SCENARIO" in
  decode_then_success)
    if ((count == 1)); then
      emit_decode_failure
      exit 1
    fi
    run_child "$@"
    ;;
  problem_then_success)
    if ((count == 1)); then
      printf '%s\\n' 'Problem processing request' >&2
      exit 1
    fi
    run_child "$@"
    ;;
  business_failure)
    printf '%s\\n' 'database_mismatch' >&2
    exit 17
    ;;
  stdout_then_decode)
    printf '%s\\n' 'railway-produced-stdout'
    emit_decode_failure
    exit 1
    ;;
  evidence_then_decode)
    printf '%s\\n' 'started' > "$BOB_RAILWAY_RETRY_GUARD_PATH/started"
    emit_decode_failure
    exit 1
    ;;
  prefixed_decode)
    printf '%s\\n' 'unexpected prefix' >&2
    emit_decode_failure
    exit 1
    ;;
  suffixed_problem)
    printf '%s\\n' 'Problem processing request' 'unexpected suffix' >&2
    exit 1
    ;;
  always_decode)
    emit_decode_failure
    exit 1
    ;;
  signal_130)
    printf '%s\\n' 'Problem processing request' >&2
    exit 130
    ;;
	  signal_143)
	    printf '%s\\n' 'Problem processing request' >&2
	    exit 143
	    ;;
	  signal_kill)
	    printf '%s\\n' 'Problem processing request' >&2
	    kill -KILL "$$"
	    ;;
	  run_child)
	    run_child "$@"
	    ;;
  *)
    printf '%s\\n' 'unknown fake scenario' >&2
    exit 97
    ;;
esac
`,
    { mode: 0o755 },
  );
  await chmod(railway, 0o755);

  const sleep = resolve(bin, 'sleep');
  await writeFile(sleep, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  await chmod(sleep, 0o755);

  await writeFile(
    operator,
    `import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

let count = 0;
try {
  count = Number.parseInt(readFileSync(process.env.BOB_FAKE_CHILD_COUNTER, 'utf8'), 10);
} catch {}
writeFileSync(process.env.BOB_FAKE_CHILD_COUNTER, String(count + 1));
writeFileSync(process.env.BOB_FAKE_CHILD_PID, String(process.pid));
writeFileSync(process.env.BOB_FAKE_CHILD_STARTED, 'started\\n');
const resistantGrandchildSource =
  "const { writeFileSync } = require('node:fs'); " +
  "process.on('SIGTERM', () => {}); " +
  "writeFileSync(process.env.BOB_FAKE_GRANDCHILD_READY, 'ready\\\\n'); " +
  "setInterval(() => {}, 1_000);";

switch (process.env.BOB_FAKE_CHILD_SCENARIO) {
  case 'success':
    process.stdout.write('receipt-ok\\n');
    break;
  case 'same_error':
    process.stderr.write('Problem processing request\\n');
    process.exitCode = 1;
    break;
  case 'signal_kill':
    process.kill(process.pid, 'SIGKILL');
    break;
  case 'sleep':
    setInterval(() => {}, 1_000);
    break;
	  case 'resistant_tree': {
	    process.on('SIGTERM', () => {});
	    const grandchild = spawn(
	      process.execPath,
	      ['-e', resistantGrandchildSource],
	      { stdio: 'ignore' },
	    );
	    writeFileSync(process.env.BOB_FAKE_GRANDCHILD_PID, String(grandchild.pid));
	    setInterval(() => {}, 1_000);
	    break;
	  }
	  case 'orphan_success':
	  case 'orphan_failure': {
	    const grandchild = spawn(
	      process.execPath,
	      ['-e', resistantGrandchildSource],
	      { stdio: 'ignore' },
	    );
	    grandchild.unref();
	    writeFileSync(process.env.BOB_FAKE_GRANDCHILD_PID, String(grandchild.pid));
	    const exitStatus = process.env.BOB_FAKE_CHILD_SCENARIO === 'orphan_success' ? 0 : 17;
	    let polls = 0;
	    const readyPoll = setInterval(() => {
	      polls += 1;
	      if (existsSync(process.env.BOB_FAKE_GRANDCHILD_READY)) {
	        clearInterval(readyPoll);
	        process.exit(exitStatus);
	      }
	      if (polls >= 500) {
	        clearInterval(readyPoll);
	        process.exit(99);
	      }
	    }, 10);
	    break;
	  }
	  default:
	    process.stderr.write('unknown child scenario\\n');
	    process.exitCode = 98;
}
`,
  );

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const args = [
    wrapper,
    'railway',
    'run',
    '--project',
    'project-id',
    '--service',
    'service-id',
    '--environment',
    'environment-id',
    '--no-local',
    '--',
    'node',
    operator,
  ];
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    BOB_FAKE_RAILWAY_COUNTER: railwayCounter,
    BOB_FAKE_RAILWAY_PID: railwayPid,
    BOB_FAKE_CHILD_COUNTER: childCounter,
    BOB_FAKE_CHILD_PID: childPid,
    BOB_FAKE_GRANDCHILD_PID: grandchildPid,
    BOB_FAKE_GRANDCHILD_READY: grandchildReady,
    BOB_FAKE_CHILD_STARTED: childStarted,
    BOB_FAKE_RAILWAY_SCENARIO: railwayScenario,
    BOB_FAKE_CHILD_SCENARIO: childScenario,
    BOB_RAILWAY_RETRY_GUARD_PATH: guard,
  };

  return {
    childCounter,
    childPid,
    childStarted,
    grandchildPid,
    grandchildReady,
    guard,
    railwayCounter,
    railwayPid,
    run() {
      return spawnSync('bash', args, {
        cwd: root,
        encoding: 'utf8',
        env,
      });
    },
    spawn() {
      return spawn('bash', args, {
        cwd: root,
        detached: true,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    },
  };
}

async function attemptCount(path) {
  return Number.parseInt(await readFile(path, 'utf8'), 10);
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path, timeoutMilliseconds = 5_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await fileExists(path)) {
      return;
    }
    await wait(20);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMilliseconds = 5_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      return;
    }
    await wait(20);
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

test('rejoue seulement l’enveloppe complète de décodage avant le processus enfant', async (t) => {
  const harness = await createHarness(t, 'decode_then_success');
  const result = harness.run();

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout, 'receipt-ok\n');
  assert.match(result.stderr, /provider_failure=decode_response_body_expected_ident/u);
  assert.equal(await attemptCount(harness.railwayCounter), 2);
  assert.equal(await attemptCount(harness.childCounter), 1);
});

test('rejoue la réponse Railway générique exacte sans masquer le succès', async (t) => {
  const harness = await createHarness(t, 'problem_then_success');
  const result = harness.run();

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout, 'receipt-ok\n');
  assert.equal(await attemptCount(harness.railwayCounter), 2);
  assert.equal(await attemptCount(harness.childCounter), 1);
});

test('ne rejoue jamais une erreur métier inconnue', async (t) => {
  const harness = await createHarness(t, 'business_failure');
  const result = harness.run();

  assert.equal(result.status, 17);
  assert.match(result.stderr, /database_mismatch/u);
  assert.equal(await attemptCount(harness.railwayCounter), 1);
  assert.equal(await fileExists(harness.childCounter), false);
});

test('la moindre sortie stdout interdit le retry', async (t) => {
  const harness = await createHarness(t, 'stdout_then_decode');
  const result = harness.run();

  assert.equal(result.status, 1);
  assert.equal(result.stdout, 'railway-produced-stdout\n');
  assert.equal(await attemptCount(harness.railwayCounter), 1);
});

test('une preuve locale existante interdit le retry même sur la signature Railway', async (t) => {
  const harness = await createHarness(t, 'evidence_then_decode');
  const result = harness.run();

  assert.equal(result.status, 1);
  assert.equal(await attemptCount(harness.railwayCounter), 1);
});

test('refuse toute signature préfixée ou suffixée au lieu de chercher une sous-chaîne', async (t) => {
  for (const scenario of ['prefixed_decode', 'suffixed_problem']) {
    await t.test(scenario, async (nested) => {
      const harness = await createHarness(nested, scenario);
      const result = harness.run();

      assert.equal(result.status, 1);
      assert.equal(await attemptCount(harness.railwayCounter), 1);
    });
  }
});

test('ne rejoue pas un enfant déjà démarré même s’il émet exactement la signature Railway', async (t) => {
  const harness = await createHarness(t, 'run_child', 'same_error');
  const result = harness.run();

  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'Problem processing request\n');
  assert.equal(await attemptCount(harness.railwayCounter), 1);
  assert.equal(await attemptCount(harness.childCounter), 1);
});

test('préserve le statut d’un signal enfant et ne le rejoue jamais après le marqueur', async (t) => {
  const harness = await createHarness(t, 'run_child', 'signal_kill');
  const result = harness.run();

  assert.equal(result.status, 137, `${result.stdout}\n${result.stderr}`);
  assert.equal(await attemptCount(harness.railwayCounter), 1);
  assert.equal(await attemptCount(harness.childCounter), 1);
  assert.equal(await fileExists(harness.childStarted), true);
});

test('ne rejoue aucun statut de signal simulé', async (t) => {
  for (const [scenario, status] of [
    ['signal_130', 130],
    ['signal_143', 143],
  ]) {
    await t.test(scenario, async (nested) => {
      const harness = await createHarness(nested, scenario);
      const result = harness.run();

      assert.equal(result.status, status);
      assert.equal(await attemptCount(harness.railwayCounter), 1);
    });
  }
});

test('un Railway tué par un signal spontané ne rejoue jamais une enveloppe allowlistée', async (t) => {
  const harness = await createHarness(t, 'signal_kill');
  const result = harness.run();

  assert.equal(result.status, 137, `${result.stdout}\n${result.stderr}`);
  assert.equal(await attemptCount(harness.railwayCounter), 1);
  assert.equal(await fileExists(harness.childCounter), false);
});

test('une interruption TERM réelle ne déclenche aucune seconde tentative', async (t) => {
  const harness = await createHarness(t, 'run_child', 'sleep');
  const child = harness.spawn();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });

  await waitForFile(harness.childStarted);
  const operatorPid = await attemptCount(harness.childPid);
  const railwayPid = await attemptCount(harness.railwayPid);
  child.kill('SIGTERM');
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      if (processExists(railwayPid)) {
        process.kill(-railwayPid, 'SIGKILL');
      }
      child.kill('SIGKILL');
      reject(new Error('wrapper did not terminate after SIGTERM'));
    }, 5_000);
  });
  let result;
  try {
    result = await Promise.race([exited, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }

  assert.equal(result.code, 143, `unexpected termination: ${JSON.stringify(result)} ${stderr}`);
  assert.equal(result.signal, null);
  await waitForProcessExit(operatorPid);
  await waitForProcessExit(railwayPid);
  assert.equal(await attemptCount(harness.railwayCounter), 1);
  assert.equal(await attemptCount(harness.childCounter), 1);
});

test('TERM escalade vers KILL et prouve la quiescence d’un arbre résistant', async (t) => {
  const harness = await createHarness(t, 'run_child', 'resistant_tree');
  const child = harness.spawn();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });

  await waitForFile(harness.childStarted);
  await waitForFile(harness.grandchildPid);
  await waitForFile(harness.grandchildReady);
  const operatorPid = await attemptCount(harness.childPid);
  const grandchildPid = await attemptCount(harness.grandchildPid);
  const railwayPid = await attemptCount(harness.railwayPid);
  child.kill('SIGTERM');
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      if (processExists(railwayPid)) {
        process.kill(-railwayPid, 'SIGKILL');
      }
      child.kill('SIGKILL');
      reject(new Error('wrapper did not quiesce the resistant process group'));
    }, 7_000);
  });
  let result;
  try {
    result = await Promise.race([exited, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }

  assert.equal(result.code, 143, `unexpected termination: ${JSON.stringify(result)} ${stderr}`);
  assert.equal(result.signal, null);
  await waitForProcessExit(operatorPid);
  await waitForProcessExit(grandchildPid);
  await waitForProcessExit(railwayPid);
  assert.equal(await attemptCount(harness.railwayCounter), 1);
  assert.equal(await attemptCount(harness.childCounter), 1);
});

test('une sortie normale réconcilie tout descendant résistant avant de rendre son statut', async (t) => {
  for (const [scenario, expectedStatus] of [
    ['orphan_success', 0],
    ['orphan_failure', 17],
  ]) {
    await t.test(scenario, async (nested) => {
      const harness = await createHarness(nested, 'run_child', scenario);
      const result = harness.run();
      const grandchildPid = await attemptCount(harness.grandchildPid);
      const railwayPid = await attemptCount(harness.railwayPid);

      assert.equal(result.status, expectedStatus, `${result.stdout}\n${result.stderr}`);
      assert.equal(await fileExists(harness.grandchildReady), true);
      await waitForProcessExit(grandchildPid);
      await waitForProcessExit(railwayPid);
      assert.equal(await attemptCount(harness.railwayCounter), 1);
      assert.equal(await attemptCount(harness.childCounter), 1);
    });
  }
});

test('le budget est limité à trois tentatives et conserve un diagnostic borné', async (t) => {
  const harness = await createHarness(t, 'always_decode');
  const result = harness.run();

  assert.equal(result.status, 1);
  assert.equal(await attemptCount(harness.railwayCounter), 3, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr.match(/next_attempt=/gu)?.length, 2);
  assert.match(
    result.stderr,
    /provider_failure=decode_response_body_expected_ident attempts=3 exhausted=true child_started=false/u,
  );
  assert.match(result.stderr, /expected ident at line 1 column 2/u);
  assert.deepEqual(
    JSON.parse(
      await readFile(resolve(harness.guard, 'railway-control-plane-fetch-failure.json'), 'utf8'),
    ),
    {
      schemaVersion: 1,
      status: 'failed',
      failureKind: 'railway_control_plane_fetch_unavailable',
      providerFailure: 'decode_response_body_expected_ident',
      attempts: 3,
      childStarted: false,
    },
  );
});

test('refuse de devenir un exécuteur générique ou une commande sans délimiteur enfant', () => {
  for (const args of [
    ['printf', 'run', 'unsafe'],
    ['railway', 'run', '--project', 'project-id'],
  ]) {
    const result = spawnSync('bash', [wrapper, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BOB_RAILWAY_RETRY_GUARD_PATH: '/tmp/unused',
      },
    });

    assert.equal(result.status, 64);
    assert.match(result.stderr, /Usage:/u);
  }
});

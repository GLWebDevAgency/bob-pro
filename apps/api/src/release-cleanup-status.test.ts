import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const helper = resolve(process.cwd(), 'scripts/lib/preserve-cleanup-status.sh');
const archiveJob = resolve(process.cwd(), 'scripts/run-document-archive-audit-job.sh');

async function waitForReadableFile(path: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  throw new Error(`Fixture process did not create ${path} within ${timeoutMs} ms.`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Fixture child ${pid} survived its forwarded signal.`);
}

function run(originalStatus: number, cleanupStatus: number) {
  return spawnSync(
    'sh',
    [
      '-c',
      `. "$1"; cleanup_fixture_status="$2"; ` +
        'cleanup_fixture() { return "$cleanup_fixture_status"; }; ' +
        'preserve_exit_status_after_cleanup "$3" cleanup_fixture',
      'release-cleanup-test',
      helper,
      String(cleanupStatus),
      String(originalStatus),
    ],
    { encoding: 'utf8' },
  );
}

function runSignal(signal: 'HUP' | 'INT' | 'TERM', cleanupStatus: number) {
  return spawnSync(
    'sh',
    [
      '-c',
      `. "$1"; cleanup_fixture_status="$2"; ` +
        'cleanup_fixture() { return "$cleanup_fixture_status"; }; ' +
        'cleanup_fixture_on_exit() { original_status=$?; ' +
        'trap - EXIT HUP INT TERM; ' +
        'preserve_exit_status_after_cleanup "$original_status" cleanup_fixture; }; ' +
        'trap cleanup_fixture_on_exit EXIT; ' +
        "trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM; " +
        'kill -"$3" "$$"; exit 99',
      'release-cleanup-signal-test',
      helper,
      String(cleanupStatus),
      signal,
    ],
    { encoding: 'utf8' },
  );
}

describe('release cleanup exit status', () => {
  it('ne masque jamais une panne de release quand le cleanup réussit', () => {
    expect(run(17, 0).status).toBe(17);
  });

  it('ne masque jamais une panne de release quand le cleanup échoue aussi', () => {
    expect(run(23, 5).status).toBe(23);
  });

  it('fait échouer une release autrement verte si le cleanup échoue', () => {
    expect(run(0, 9).status).toBe(9);
  });

  it('conserve le succès quand release et cleanup réussissent', () => {
    expect(run(0, 0).status).toBe(0);
  });

  it.each([
    ['HUP', 129],
    ['INT', 130],
    ['TERM', 143],
  ] as const)(
    'préserve le statut du signal %s même lorsque le cleanup échoue',
    (signal, expectedStatus) => {
      expect(runSignal(signal, 9).status).toBe(expectedStatus);
    },
  );

  it('interdit les traps multi-signaux qui laisseraient le job continuer après annulation', async () => {
    const [jobScript, releaseScript, archiveDockerfile] = await Promise.all([
      readFile(archiveJob, 'utf8'),
      readFile(resolve(process.cwd(), 'scripts/release.sh'), 'utf8'),
      readFile(resolve(process.cwd(), '../../Dockerfile.archive-audit'), 'utf8'),
    ]);

    for (const source of [releaseScript, archiveDockerfile]) {
      expect(source).toContain("trap 'exit 129' HUP");
      expect(source).toContain("trap 'exit 130' INT");
      expect(source).toContain("trap 'exit 143' TERM");
      expect(source).not.toMatch(/trap\s+(?!-)[^\n]+\s+EXIT\s+HUP\s+INT\s+TERM/);
    }
    expect(jobScript).toContain("trap 'forward_archive_audit_signal HUP 129' HUP");
    expect(jobScript).toContain("trap 'forward_archive_audit_signal INT 130' INT");
    expect(jobScript).toContain("trap 'forward_archive_audit_signal TERM 143' TERM");
  });

  it('transmet réellement SIGTERM du PID 1 au scanner Node et attend sa terminaison', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'bob-archive-signal-'));
    const fixtureBin = join(fixtureRoot, 'bin');
    const childPidPath = join(fixtureRoot, 'child.pid');
    const childReadyPath = join(fixtureRoot, 'child.ready');
    const childSignalPath = join(fixtureRoot, 'child.signal');
    await mkdir(fixtureBin, { recursive: true });
    const fakeNode = join(fixtureBin, 'node');
    await writeFile(
      fakeNode,
      `#!/bin/sh
set -eu
printf '%s' "$$" > "$BOB_ARCHIVE_SIGNAL_PID"
on_term() {
  printf 'TERM' > "$BOB_ARCHIVE_SIGNAL_MARKER"
  exit 143
}
trap on_term TERM
printf 'ready' > "$BOB_ARCHIVE_SIGNAL_READY"
while :; do sleep 1; done
`,
      { mode: 0o700 },
    );
    await chmod(fakeNode, 0o700);

    const processUnderTest = spawn('sh', [archiveJob], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${fixtureBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        BOB_ARCHIVE_SIGNAL_MARKER: childSignalPath,
        BOB_ARCHIVE_SIGNAL_PID: childPidPath,
        BOB_ARCHIVE_SIGNAL_READY: childReadyPath,
        DATABASE_URL: 'postgresql://runtime.invalid/bob',
        DIRECT_URL: 'postgresql://authority.invalid/bob',
        DOCUMENT_ARCHIVE_FNFE_BUNDLE: '/fixture/fnfe',
        DOCUMENT_ARCHIVE_MUSTANG_JAR: '/fixture/mustang.jar',
        DOCUMENT_ARCHIVE_SUPABASE_PROJECT_REF: 'fixture-project',
        DOCUMENT_ARCHIVE_VALIDATOR_SANDBOX: '/fixture/bwrap',
        RAILWAY_DEPLOYMENT_ID: '00000000-0000-4000-8000-000000000001',
        RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
        SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role',
        SUPABASE_URL: 'https://fixture-project.supabase.co',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, rejectExit) => {
        processUnderTest.once('error', rejectExit);
        processUnderTest.once('exit', (code, signal) => resolveExit({ code, signal }));
      },
    );
    let fixtureChildPid: number | null = null;

    try {
      await waitForReadableFile(childReadyPath);
      fixtureChildPid = Number((await readFile(childPidPath, 'utf8')).trim());
      expect(Number.isSafeInteger(fixtureChildPid)).toBe(true);
      expect(processIsAlive(fixtureChildPid)).toBe(true);

      expect(processUnderTest.kill('SIGTERM')).toBe(true);
      const result = await Promise.race([
        exited,
        new Promise<never>((_, rejectTimeout) =>
          setTimeout(() => rejectTimeout(new Error('Archive wrapper ignored SIGTERM.')), 5_000),
        ),
      ]);

      expect(result).toEqual({ code: 143, signal: null });
      await waitForProcessExit(fixtureChildPid);
      expect(await readFile(childSignalPath, 'utf8')).toBe('TERM');
    } finally {
      if (processUnderTest.exitCode === null && processUnderTest.signalCode === null) {
        processUnderTest.kill('SIGKILL');
      }
      if (fixtureChildPid !== null && processIsAlive(fixtureChildPid)) {
        process.kill(fixtureChildPid, 'SIGKILL');
      }
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

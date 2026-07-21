import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const helper = resolve(process.cwd(), 'scripts/lib/preserve-cleanup-status.sh');

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

  it('interdit les traps multi-signaux qui laisseraient le job continuer après annulation', () => {
    const jobScript = readFileSync(
      resolve(process.cwd(), 'scripts/run-document-archive-audit-job.sh'),
      'utf8',
    );
    const releaseScript = readFileSync(
      resolve(process.cwd(), 'scripts/release.sh'),
      'utf8',
    );
    const archiveDockerfile = readFileSync(
      resolve(process.cwd(), '../../Dockerfile.archive-audit'),
      'utf8',
    );

    for (const source of [jobScript, releaseScript, archiveDockerfile]) {
      expect(source).toContain("trap 'exit 129' HUP");
      expect(source).toContain("trap 'exit 130' INT");
      expect(source).toContain("trap 'exit 143' TERM");
      expect(source).not.toMatch(/trap\s+(?!-)[^\n]+\s+EXIT\s+HUP\s+INT\s+TERM/);
    }
  });
});

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), 'scripts/check-document-archive-legacy-audience.sh');
const temporaryDirectories: string[] = [];

function runPreflight(fakePsqlResult: string) {
  const directory = mkdtempSync(join(tmpdir(), 'bob-archive-legacy-preflight-'));
  temporaryDirectories.push(directory);
  const fakePsql = join(directory, 'psql');
  writeFileSync(fakePsql, '#!/bin/sh\nprintf \'%s\\n\' "$FAKE_PSQL_RESULT"\n', 'utf8');
  chmodSync(fakePsql, 0o700);

  return spawnSync('sh', [script], {
    cwd: resolve(process.cwd(), '../..'),
    encoding: 'utf8',
    env: {
      DIRECT_URL: 'postgresql://unused-in-contract-test',
      FAKE_PSQL_RESULT: fakePsqlResult,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('document archive legacy audience preflight', () => {
  it.each(['pre-expand|0', 'expanded|0'])('autorise uniquement un inventaire vide (%s)', (result) => {
    const execution = runPreflight(result);
    expect(execution.status).toBe(0);
    expect(execution.stdout).toContain('preflight passed');
  });

  it('bloque avant 1332 plutôt que de geler une base avec des factures historiques', () => {
    const execution = runPreflight('pre-expand|2');
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain('before migration 1332');
  });

  it('bloque tout nouveau train si un snapshot reste inconnu après expand', () => {
    const execution = runPreflight('expanded|1');
    expect(execution.status).toBe(1);
    expect(execution.stderr).toContain('no audited archive audience');
  });

  it.each(['', 'unknown|0', 'expanded|-1', 'expanded|not-a-count'])(
    'échoue fermé sur une sortie psql ambiguë (%j)',
    (result) => {
      expect(runPreflight(result).status).toBe(1);
    },
  );

  it('interroge les deux formes de schéma et reste appelé avant migrate deploy', () => {
    const source = readFileSync(script, 'utf8');
    const release = readFileSync(resolve(process.cwd(), 'scripts/release.sh'), 'utf8');
    expect(source).toContain("column_name = 'archiveAudienceAtIssuance'");
    expect(source).toContain("SELECT 'pre-expand|' || count(*)::text");
    expect(source).toContain("SELECT 'expanded|' || count(*)::text");
    expect(release.indexOf('check-document-archive-legacy-audience.sh')).toBeGreaterThan(-1);
    expect(release.indexOf('check-document-archive-legacy-audience.sh')).toBeLessThan(
      release.indexOf('prisma migrate deploy'),
    );
  });
});

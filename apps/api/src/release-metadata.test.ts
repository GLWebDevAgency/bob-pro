import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readReleaseMetadata } from './release-metadata';

describe('readReleaseMetadata', () => {
  it('lit uniquement un SHA complet et un environnement de release autorisé', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bob-release-'));
    const path = join(directory, 'release.json');
    writeFileSync(path, JSON.stringify({
      sha: '0123456789abcdef0123456789abcdef01234567',
      environment: 'staging',
    }));

    expect(readReleaseMetadata(path)).toEqual({
      sha: '0123456789abcdef0123456789abcdef01234567',
      environment: 'staging',
    });
  });

  it('échoue fermé si le fichier est absent ou malformé', () => {
    expect(readReleaseMetadata('/path/that/does/not/exist')).toEqual({ sha: null, environment: null });
    const directory = mkdtempSync(join(tmpdir(), 'bob-release-'));
    const path = join(directory, 'release.json');
    writeFileSync(path, JSON.stringify({ sha: 'main', environment: 'development' }));
    expect(readReleaseMetadata(path)).toEqual({ sha: null, environment: null });
  });
});

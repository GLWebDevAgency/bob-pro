import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ReleaseMetadata {
  readonly sha: string | null;
  readonly environment: 'staging' | 'production' | null;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Métadonnée embarquée dans l'archive réellement envoyée à Railway. Elle permet
 * au smoke de distinguer la nouvelle révision d'une ancienne instance encore saine.
 */
export function readReleaseMetadata(
  filePath = resolve(process.cwd(), '../../.bob-release.json'),
): ReleaseMetadata {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return { sha: null, environment: null };
    const candidate = parsed as { sha?: unknown; environment?: unknown };
    const sha = typeof candidate.sha === 'string' && SHA_PATTERN.test(candidate.sha)
      ? candidate.sha
      : null;
    const environment = candidate.environment === 'staging' || candidate.environment === 'production'
      ? candidate.environment
      : null;
    return { sha, environment };
  } catch {
    return { sha: null, environment: null };
  }
}

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MIGRATION_NAME = /^(?<prefix>\d{14})_[a-z0-9_]+$/u;
const MIGRATION_FILE = /^apps\/api\/prisma\/migrations\/(?<name>\d{14}_[a-z0-9_]+)\/migration\.sql$/u;

function parseName(name) {
  const match = MIGRATION_NAME.exec(name);
  if (!match?.groups?.prefix) throw new Error(`invalid_migration_name:${name}`);
  return { name, prefix: match.groups.prefix };
}

export function assertMigrationLineage({ baseNames, addedNames }) {
  const base = [...new Set(baseNames)].map(parseName);
  if (base.length === 0) throw new Error('migration_base_is_empty');
  const baseMaximum = base.map((entry) => entry.prefix).sort().at(-1);
  if (baseMaximum === undefined) throw new Error('migration_base_is_empty');

  const added = [...new Set(addedNames)].map(parseName);
  const prefixes = new Set();
  for (const entry of added) {
    if (entry.prefix <= baseMaximum) {
      throw new Error(`migration_prefix_not_after_base:${entry.name}:${baseMaximum}`);
    }
    if (prefixes.has(entry.prefix)) {
      throw new Error(`duplicate_new_migration_prefix:${entry.prefix}`);
    }
    prefixes.add(entry.prefix);
  }
  return Object.freeze({ baseMaximum, added: Object.freeze(added.map((entry) => entry.name)) });
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim()
    .split('\n')
    .filter(Boolean);
}

export function addedMigrationNamesFromPaths({ committedPaths, stagedPaths, untrackedPaths }) {
  return [...new Set([...committedPaths, ...stagedPaths, ...untrackedPaths])].map((path) => {
    const match = MIGRATION_FILE.exec(path);
    if (!match?.groups?.name) throw new Error(`invalid_migration_path:${path}`);
    return match.groups.name;
  });
}

export function assertBaseMigrationFilesImmutable(changeLines) {
  for (const line of changeLines) {
    const [status, ...paths] = line.split('\t');
    if (status === 'A' && paths.length === 1) continue;
    if (!status || paths.length === 0) throw new Error(`invalid_migration_change:${line}`);
    throw new Error(`existing_migration_changed:${status}:${paths.join('->')}`);
  }
}

export function assertRepositoryMigrationLineage(baseRef) {
  if (typeof baseRef !== 'string' || baseRef.trim() === '') {
    throw new Error('MIGRATION_BASE_REF is required');
  }
  git(['rev-parse', '--verify', `${baseRef}^{commit}`]);
  const baseNames = git(['ls-tree', '-d', '--name-only', `${baseRef}:apps/api/prisma/migrations`]);
  // La comparaison au HEAD cible couvre commits, index et worktree. Une migration cible reste
  // append-only : M/D/R/T sont interdits et seul un fichier A strictement postérieur est admis.
  assertBaseMigrationFilesImmutable(git([
    'diff', '--name-status', '--find-renames', baseRef, '--',
    'apps/api/prisma/migrations/*/migration.sql',
  ]));
  const committedPaths = git([
    'diff', '--name-only', '--diff-filter=A', `${baseRef}...HEAD`, '--',
    'apps/api/prisma/migrations/*/migration.sql',
  ]);
  const stagedPaths = git([
    'diff', '--cached', '--name-only', '--diff-filter=A', 'HEAD', '--',
    'apps/api/prisma/migrations/*/migration.sql',
  ]);
  const untrackedPaths = git([
    'ls-files', '--others', '--exclude-standard', '--',
    'apps/api/prisma/migrations/*/migration.sql',
  ]);
  const addedNames = addedMigrationNamesFromPaths({ committedPaths, stagedPaths, untrackedPaths });
  return assertMigrationLineage({ baseNames, addedNames });
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (invokedPath === import.meta.url) {
  const result = assertRepositoryMigrationLineage(
    process.env.MIGRATION_BASE_REF ?? process.argv[2] ?? '',
  );
  process.stdout.write(
    `Migration lineage OK: ${result.added.length} ajout(s) après ${result.baseMaximum}.\n`,
  );
}

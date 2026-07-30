#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const apiDirectory = path.resolve(scriptDirectory, '..');

/**
 * M2-A-1 est publié. Ses migrations ne dépendent plus des unions TypeScript vivantes : toute
 * extension appartient à un nouveau train append-only et à son propre générateur.
 */
const FROZEN_M2A1_MIGRATIONS = Object.freeze([
  {
    relativePath:
      '20260730100000_agent_mission_catalogue_choice_expand/migration.sql',
    sha256: 'b46720af019adc074c4c00efff66f7a3f7e58776d29100b8b1fb86ce34d9cf8e',
  },
  {
    relativePath:
      '20260730100100_agent_mission_catalogue_choice_validate/migration.sql',
    sha256: 'ebd6ba31d5341444282390627248a4031c99b26f3d54266ee4eb15737bb6f56a',
  },
  {
    relativePath:
      '20260730100200_agent_mission_catalogue_choice_cutover/migration.sql',
    sha256: '6936ed57dc3665cf828792f483f1aab9609950f604b87c9b87f9757844837d62',
  },
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function verifyM2A1Migrations() {
  for (const frozen of FROZEN_M2A1_MIGRATIONS) {
    const migrationPath = path.join(
      apiDirectory,
      'prisma/migrations',
      frozen.relativePath,
    );
    const actual = sha256(await readFile(migrationPath));
    if (actual !== frozen.sha256) {
      throw new Error(
        `AGENT_MISSION_M2A1_MIGRATION_CHANGED:${frozen.relativePath}`,
      );
    }
  }
}

if (process.argv.includes('--write')) {
  throw new Error(
    'AGENT_MISSION_M2A1_READ_ONLY: create a new append-only generator',
  );
}
if (!process.argv.includes('--check')) {
  throw new Error('AGENT_MISSION_M2A1_VERIFIER_USAGE: pass --check');
}

await verifyM2A1Migrations();
process.stdout.write('AgentMission M2-A-1 migration bytes are unchanged.\n');

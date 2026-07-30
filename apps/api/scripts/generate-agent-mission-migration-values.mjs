#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(scriptDir, '..');

/**
 * Ces migrations ont déjà été livrées. Elles ne sont plus des sorties générables depuis les
 * unions TypeScript vivantes : une nouvelle valeur du domaine exige une nouvelle migration
 * append-only. Les octets publiés sont donc l'unique source de vérité historique.
 */
const FROZEN_HISTORICAL_MIGRATIONS = Object.freeze([
  {
    relativePath: '20260726010000_agent_missions_expand/migration.sql',
    sha256: '51300a662e0a8a0d92bc80ba371f9fb40f3087e42b049e30823f460087f32882',
  },
  {
    relativePath: '20260727140000_agent_mission_realtime_lease_expand/migration.sql',
    sha256: 'eeeabc0eb680662b06acf5325e791e3635b20d000f90cb590217187d68b118be',
  },
  {
    relativePath: '20260727180000_agent_mission_event_command_namespace_expand/migration.sql',
    sha256: '5e4a07e66e047573ccb1766f6a8c844fad8bfe0a128ce9312abac17a9d4f19c5',
  },
  {
    relativePath: '20260729100000_agent_mission_customer_resolution_expand/migration.sql',
    sha256: '0103db8de1c21bf9299b4439ff74b606e50777e6693b54bb2ed0bc70b9a106f9',
  },
  {
    relativePath: '20260729100100_agent_mission_customer_resolution_validate/migration.sql',
    sha256: '885bebd64380ffbf1aa91109e8391e944e6a1ac39ad132b9544b2182921617e7',
  },
  {
    relativePath: '20260729100200_agent_mission_customer_resolution_cutover/migration.sql',
    sha256: 'dff7d1a7103735a5ae257c381a159569182c5a6b6edbd034ca5f66c16d0c14bb',
  },
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function verifyHistoricalMigrations() {
  for (const frozen of FROZEN_HISTORICAL_MIGRATIONS) {
    const migrationPath = path.join(apiDir, 'prisma/migrations', frozen.relativePath);
    const bytes = await readFile(migrationPath);
    const actual = sha256(bytes);
    if (actual !== frozen.sha256) {
      throw new Error(
        `AGENT_MISSION_HISTORICAL_MIGRATION_CHANGED:${frozen.relativePath}`,
      );
    }
  }
}

if (process.argv.includes('--write')) {
  throw new Error(
    'AGENT_MISSION_HISTORICAL_MIGRATIONS_READ_ONLY: create a new append-only generator',
  );
}
if (!process.argv.includes('--check')) {
  throw new Error(
    'AGENT_MISSION_HISTORICAL_MIGRATION_VERIFIER_USAGE: pass --check',
  );
}

await verifyHistoricalMigrations();
process.stdout.write('AgentMission historical migration bytes are unchanged.\n');

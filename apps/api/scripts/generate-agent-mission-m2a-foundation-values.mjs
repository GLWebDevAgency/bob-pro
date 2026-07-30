#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const apiDirectory = path.resolve(scriptDirectory, '..');

const FROZEN_M2A_FOUNDATION_MIGRATIONS = Object.freeze([
  {
    relativePath: '20260729150000_agent_mission_quote_line_work_expand/migration.sql',
    sha256: 'e27a941439a3ce33fb23ada703d6ec6214ed7aef78b8c590332a3ea2a5d8a13b',
  },
  {
    relativePath: '20260729150100_agent_mission_quote_line_work_validate/migration.sql',
    sha256: '8bf8068ebb65657823d05c84bb84f8211bc993da893060bac1a149047d45fa6f',
  },
  {
    relativePath: '20260729150200_agent_mission_quote_line_work_cutover/migration.sql',
    sha256: '7e42ddf3e0ab5236b03f1acfa67c6831f5d482c27f94aa66b7d1155f51db7b61',
  },
]);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function verifyM2AFoundationMigrations() {
  for (const frozen of FROZEN_M2A_FOUNDATION_MIGRATIONS) {
    const migrationPath = path.join(
      apiDirectory,
      'prisma/migrations',
      frozen.relativePath,
    );
    const actual = sha256(await readFile(migrationPath));
    if (actual !== frozen.sha256) {
      throw new Error(
        `AGENT_MISSION_M2A_FOUNDATION_MIGRATION_CHANGED:${frozen.relativePath}`,
      );
    }
  }
}

if (process.argv.includes('--write')) {
  throw new Error(
    'AGENT_MISSION_M2A_FOUNDATION_READ_ONLY: create a new append-only generator',
  );
}
if (!process.argv.includes('--check')) {
  throw new Error(
    'AGENT_MISSION_M2A_FOUNDATION_VERIFIER_USAGE: pass --check',
  );
}

await verifyM2AFoundationMigrations();
process.stdout.write('AgentMission M2-A foundation migration bytes are unchanged.\n');

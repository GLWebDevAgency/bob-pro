import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const script = path.join(scriptDirectory, 'generate-realtime-voice-trace-migration-values.mjs');
const migration = path.join(
  repositoryRoot,
  'apps/api/prisma/migrations/20260801050000_realtime_voice_trace_v2/migration.sql',
);
const nativeRetryMigration = path.join(
  repositoryRoot,
  'apps/api/prisma/migrations/20260801051000_openai_native_retry_scenario_expand/migration.sql',
);
const traceClientCloseMigration = path.join(
  repositoryRoot,
  'apps/api/prisma/migrations/20260803010000_realtime_voice_trace_client_close_expand/migration.sql',
);

test('les CHECK SQL Realtime Voice Trace proviennent des unions TypeScript', () => {
  const result = spawnSync(process.execPath, [script, '--check'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /migration values verified/u);
});

test('chaque bloc généré est unique et la migration reste expand-only', () => {
  const sql = readFileSync(migration, 'utf8');
  for (const marker of [
    'EVENT_KINDS',
    'PROVIDERS',
    'TRANSPORTS',
    'SPEECH_DELIVERIES',
    'STAGES',
    'OUTCOMES',
    'FAILURE_CLASSES',
    'INTERRUPTION_REASONS',
    'PLANNER_DISPOSITIONS',
    'PLANNER_AUTHORITIES',
    'RUN_KINDS',
    'CONTROL_KINDS',
    'MISSION_KINDS',
  ]) {
    assert.equal((sql.match(new RegExp(`REALTIME_TRACE_${marker}_START`, 'gu')) ?? []).length, 1);
    assert.equal((sql.match(new RegExp(`REALTIME_TRACE_${marker}_END`, 'gu')) ?? []).length, 1);
  }
  assert.doesNotMatch(sql, /\bDROP\s+(?:TABLE|COLUMN|TYPE)\b/iu);

  const closeSql = readFileSync(traceClientCloseMigration, 'utf8');
  assert.equal((closeSql.match(/REALTIME_TRACE_SESSION_CLOSE_REASONS_START/gu) ?? []).length, 1);
  assert.equal((closeSql.match(/REALTIME_TRACE_SESSION_CLOSE_REASONS_END/gu) ?? []).length, 1);
  assert.match(closeSql, /ADD CONSTRAINT[^;]+NOT VALID;/isu);
  assert.doesNotMatch(closeSql, /VALIDATE CONSTRAINT/u);

  const nativeSql = readFileSync(nativeRetryMigration, 'utf8');
  assert.equal((nativeSql.match(/OPENAI_NATIVE_SPEECH_SCENARIOS_START/gu) ?? []).length, 1);
  assert.equal((nativeSql.match(/OPENAI_NATIVE_SPEECH_SCENARIOS_END/gu) ?? []).length, 1);
  assert.match(nativeSql, /generic_retry_v1/u);
  assert.match(nativeSql, /ADD CONSTRAINT[^;]+NOT VALID;/isu);
});

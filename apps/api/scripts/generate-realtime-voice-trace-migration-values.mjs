#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, '../../..');
const traceMigrationPath = path.join(
  repositoryRoot,
  'apps/api/prisma/migrations/20260801050000_realtime_voice_trace_v2/migration.sql',
);
const nativeRetryMigrationPath = path.join(
  repositoryRoot,
  'apps/api/prisma/migrations/20260801051000_openai_native_retry_scenario_expand/migration.sql',
);
const traceClientCloseMigrationPath = path.join(
  repositoryRoot,
  'apps/api/prisma/migrations/20260803010000_realtime_voice_trace_client_close_expand/migration.sql',
);
// APPEND-ONLY (garde `existing_migration_changed`) : une migration livree n'est jamais
// reecrite. Le bloc des kinds de mission vit donc dans la migration la PLUS RECENTE qui
// redefinit la contrainte — celle-ci applique aussi le changement aux bases existantes.
const traceMissionKindMigrationPath = path.join(
  repositoryRoot,
  'apps/api/prisma/migrations/20260819180000_realtime_trace_customer_contact_kind/migration.sql',
);
const traceSourcePath = path.join(
  repositoryRoot,
  'packages/core/src/observability/realtime-voice-trace.ts',
);
const missionKindSourcePath = path.join(
  repositoryRoot,
  'packages/core/src/domain/agent/mission-kind.ts',
);
const nativeSpeechDeliverySourcePath = path.join(
  repositoryRoot,
  'apps/api/src/voice/realtime/openai-native-speech-delivery.ts',
);

const BLOCKS = Object.freeze([
  [
    'REALTIME_TRACE_EVENT_KINDS',
    traceMigrationPath,
    traceSourcePath,
    'REALTIME_VOICE_TRACE_EVENT_KINDS',
  ],
  [
    'REALTIME_TRACE_PROVIDERS',
    traceMigrationPath,
    traceSourcePath,
    'REALTIME_VOICE_TRACE_PROVIDERS',
  ],
  [
    'REALTIME_TRACE_TRANSPORTS',
    traceMigrationPath,
    traceSourcePath,
    'REALTIME_VOICE_TRACE_TRANSPORTS',
  ],
  [
    'REALTIME_TRACE_SPEECH_DELIVERIES',
    traceMigrationPath,
    traceSourcePath,
    'REALTIME_VOICE_TRACE_SPEECH_DELIVERIES',
  ],
  ['REALTIME_TRACE_STAGES', traceMigrationPath, traceSourcePath, 'REALTIME_VOICE_TRACE_STAGES'],
  ['REALTIME_TRACE_OUTCOMES', traceMigrationPath, traceSourcePath, 'REALTIME_VOICE_TRACE_OUTCOMES'],
  [
    'REALTIME_TRACE_FAILURE_CLASSES',
    traceMigrationPath,
    traceSourcePath,
    'REALTIME_VOICE_TRACE_FAILURE_CLASSES',
  ],
  [
    'REALTIME_TRACE_INTERRUPTION_REASONS',
    traceMigrationPath,
    traceSourcePath,
    'REALTIME_VOICE_TRACE_INTERRUPTION_REASONS',
  ],
  [
    'REALTIME_TRACE_PLANNER_DISPOSITIONS',
    traceMigrationPath,
    traceSourcePath,
    'REALTIME_VOICE_TRACE_PLANNER_DISPOSITIONS',
  ],
  [
    'REALTIME_TRACE_PLANNER_AUTHORITIES',
    traceMigrationPath,
    traceSourcePath,
    'REALTIME_VOICE_TRACE_PLANNER_AUTHORITIES',
  ],
  [
    'REALTIME_TRACE_RUN_KINDS',
    traceMigrationPath,
    traceSourcePath,
    'REALTIME_VOICE_TRACE_RUN_KINDS',
  ],
  [
    'REALTIME_TRACE_CONTROL_KINDS',
    traceMigrationPath,
    traceSourcePath,
    'REALTIME_VOICE_TRACE_CONTROL_KINDS',
  ],
  [
    'REALTIME_TRACE_SESSION_CLOSE_REASONS',
    traceClientCloseMigrationPath,
    traceSourcePath,
    'REALTIME_VOICE_TRACE_SESSION_CLOSE_REASONS',
  ],
  [
    'REALTIME_TRACE_MISSION_KINDS',
    traceMissionKindMigrationPath,
    missionKindSourcePath,
    'MISSION_KIND_IDS',
  ],
  [
    'OPENAI_NATIVE_SPEECH_SCENARIOS',
    nativeRetryMigrationPath,
    nativeSpeechDeliverySourcePath,
    'OPENAI_NATIVE_SPEECH_SCENARIO_IDS',
  ],
]);

function resolveStringConstant(source, identifier) {
  const expression = new RegExp(
    `export\\s+const\\s+${identifier}\\s*=\\s*'([^']+)'\\s+as\\s+const`,
    'u',
  );
  const match = source.match(expression);
  if (!match) throw new Error(`REALTIME_TRACE_UNRESOLVED_CONSTANT:${identifier}`);
  return match[1];
}

function readClosedValues(source, constantName) {
  const declaration = source.indexOf(`export const ${constantName}`);
  if (declaration < 0) throw new Error(`REALTIME_TRACE_SOURCE_MISSING:${constantName}`);
  const open = source.indexOf('[', declaration);
  const close = source.indexOf('] as const', open);
  if (open < 0 || close < 0) throw new Error(`REALTIME_TRACE_SOURCE_SHAPE:${constantName}`);
  const body = source
    .slice(open + 1, close)
    .replace(/\/\/[^\n]*/gu, '')
    .trim();
  const tokens = body
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length < 1) throw new Error(`REALTIME_TRACE_SOURCE_EMPTY:${constantName}`);
  const values = tokens.map((token) => {
    const quoted = token.match(/^'([^']+)'$/u);
    if (quoted) return quoted[1];
    if (/^[A-Z][A-Z0-9_]*$/u.test(token)) return resolveStringConstant(source, token);
    throw new Error(`REALTIME_TRACE_SOURCE_TOKEN:${constantName}:${token}`);
  });
  if (new Set(values).size !== values.length) {
    throw new Error(`REALTIME_TRACE_SOURCE_DUPLICATE:${constantName}`);
  }
  for (const value of values) {
    if (!/^[a-z][a-z0-9_.@-]*$/u.test(value)) {
      throw new Error(`REALTIME_TRACE_SOURCE_VALUE:${constantName}`);
    }
  }
  return values;
}

function renderValues(values) {
  return values
    .map(
      (value, index) =>
        `      '${value.replaceAll("'", "''")}'${index === values.length - 1 ? '' : ','}`,
    )
    .join('\n');
}

function replaceBlock(sql, marker, values) {
  const start = `-- ${marker}_START`;
  const end = `-- ${marker}_END`;
  const startIndex = sql.indexOf(start);
  const endIndex = sql.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0 || sql.indexOf(start, startIndex + 1) >= 0) {
    throw new Error(`REALTIME_TRACE_MIGRATION_MARKER:${marker}`);
  }
  const replacement = `${start}\n${renderValues(values)}\n    ${end}`;
  return `${sql.slice(0, startIndex)}${replacement}${sql.slice(endIndex + end.length)}`;
}

const check = process.argv.includes('--check');
const write = process.argv.includes('--write');
if (check === write) {
  throw new Error('Usage: generate-realtime-voice-trace-migration-values.mjs --check|--write');
}

const sources = new Map();
const generatedMigrations = new Map();
for (const [marker, targetPath, sourcePath, constantName] of BLOCKS) {
  let source = sources.get(sourcePath);
  if (!source) {
    source = await readFile(sourcePath, 'utf8');
    sources.set(sourcePath, source);
  }
  let generated = generatedMigrations.get(targetPath);
  if (!generated) generated = await readFile(targetPath, 'utf8');
  generatedMigrations.set(
    targetPath,
    replaceBlock(generated, marker, readClosedValues(source, constantName)),
  );
}

for (const [targetPath, generated] of generatedMigrations) {
  const current = await readFile(targetPath, 'utf8');
  if (check && generated !== current) {
    throw new Error(
      `REALTIME_TRACE_MIGRATION_VALUES_DRIFT:${path.relative(repositoryRoot, targetPath)}`,
    );
  }
  if (write) await writeFile(targetPath, generated, 'utf8');
}
process.stdout.write(
  `Realtime Voice Trace migration values ${write ? 'generated' : 'verified'}.\n`,
);

#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(scriptDir, '..');
const repositoryRoot = path.resolve(apiDir, '..', '..');
const missionSource = path.join(
  repositoryRoot,
  'packages/core/src/domain/agent/agent-mission.ts',
);
const eventSource = path.join(
  repositoryRoot,
  'packages/core/src/domain/agent/agent-mission-event.ts',
);
const migrationPath = path.join(
  apiDir,
  'prisma/migrations/20260726010000_agent_missions_expand/migration.sql',
);

function extractConstArray(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = source.match(
    new RegExp(`export const ${escaped} = \\[([\\s\\S]*?)\\] as const;`, 'u'),
  );
  if (match === null) {
    throw new Error(`AGENT_MISSION_SQL_SOURCE_CONSTANT_MISSING:${name}`);
  }
  const values = [...match[1].matchAll(/'([^']+)'/gu)].map((item) => item[1]);
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`AGENT_MISSION_SQL_SOURCE_VALUES_INVALID:${name}`);
  }
  return values;
}

function extractNumericConst(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = source.match(
    new RegExp(`export const ${escaped} = ([0-9][0-9_]*)`, 'u'),
  );
  if (match === null) {
    throw new Error(`AGENT_MISSION_SQL_SOURCE_NUMERIC_CONSTANT_MISSING:${name}`);
  }
  const value = Number(match[1].replaceAll('_', ''));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`AGENT_MISSION_SQL_SOURCE_NUMERIC_VALUE_INVALID:${name}`);
  }
  return value;
}

function replaceGeneratedRegion(sql, name, values) {
  const pattern = new RegExp(
    `(^[ \\t]*-- BEGIN GENERATED ${name}\\r?\\n)([\\s\\S]*?)(^[ \\t]*-- END GENERATED ${name}$)`,
    'gmu',
  );
  let replacements = 0;
  const replaced = sql.replace(pattern, (region, start, _contents, end) => {
    replacements += 1;
    const indent = start.match(/^([ \t]*)/u)?.[1] ?? '';
    const rendered = values
      .map((value, index) => `${indent}'${value}'${index === values.length - 1 ? '' : ','}`)
      .join('\n');
    return `${start}${rendered}\n${end}`;
  });
  if (replacements === 0) {
    throw new Error(`AGENT_MISSION_SQL_REGION_MISSING:${name}`);
  }
  return replaced;
}

function replaceGeneratedBody(sql, name, body) {
  const pattern = new RegExp(
    `(^[ \\t]*-- BEGIN GENERATED ${name}\\r?\\n)([\\s\\S]*?)(^[ \\t]*-- END GENERATED ${name}$)`,
    'gmu',
  );
  let replacements = 0;
  const replaced = sql.replace(pattern, (_region, start, _contents, end) => {
    replacements += 1;
    const indent = start.match(/^([ \t]*)/u)?.[1] ?? '';
    const rendered = body
      .split('\n')
      .map((line) => `${indent}${line}`)
      .join('\n');
    return `${start}${rendered}\n${end}`;
  });
  if (replacements === 0) {
    throw new Error(`AGENT_MISSION_SQL_REGION_MISSING:${name}`);
  }
  return replaced;
}

function renderCustomerCandidateChecks(keys, maximumCandidates) {
  const renderedKeys = keys
    .map((key, index) => `  '${key}'${index === keys.length - 1 ? '' : ','}`)
    .join('\n');
  return Array.from({ length: maximumCandidates }, (_, index) => {
    const candidate = `"payload" #> '{decision,candidates,${index}}'`;
    return [
      `${index === 0 ? '' : 'AND '}(`,
      `  jsonb_array_length("payload" #> '{decision,candidates}') <= ${index}`,
      '  OR (',
      `    jsonb_typeof(${candidate}) = 'object'`,
      `    AND (${candidate}) ?& ARRAY[`,
      renderedKeys.split('\n').map((line) => `    ${line}`).join('\n'),
      '    ]',
      `    AND (${candidate}) - ARRAY[`,
      renderedKeys.split('\n').map((line) => `    ${line}`).join('\n'),
      "    ] = '{}'::JSONB",
      `    AND (${candidate}) ->> 'choiceId'`,
      "      ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'",
      `    AND jsonb_typeof((${candidate}) -> 'customerId') = 'string'`,
      `    AND length((${candidate}) ->> 'customerId') BETWEEN 1 AND 200`,
      `    AND (${candidate}) ->> 'customerId'`,
      `      = btrim((${candidate}) ->> 'customerId')`,
      `    AND (${candidate}) ->> 'customerId' !~ '[[:cntrl:]]'`,
      '  )',
      ')',
    ].join('\n');
  }).join('\n');
}

const [missionTs, eventTs, currentMigration] = await Promise.all([
  readFile(missionSource, 'utf8'),
  readFile(eventSource, 'utf8'),
  readFile(migrationPath, 'utf8'),
]);

const regions = [
  {
    name: 'AGENT_MISSION_STATUSES',
    values: extractConstArray(missionTs, 'AGENT_MISSION_STATUSES'),
  },
  {
    name: 'QUOTE_CREATION_MISSION_PHASES',
    values: extractConstArray(missionTs, 'QUOTE_CREATION_MISSION_PHASES'),
  },
  ...[
    'QUOTE_MISSION_PAYLOAD_KEYS',
    'QUOTE_MISSION_DRAFT_REFERENCE_KEYS',
    'QUOTE_MISSION_DECISION_KINDS',
    'QUOTE_MISSION_DRAFT_DECISION_KEYS',
    'QUOTE_MISSION_CUSTOMER_DECISION_KEYS',
    'QUOTE_MISSION_ACTION_CHOICE_KEYS',
    'AGENT_MISSION_CONTEXT_BINDING_KEYS',
    'AGENT_MISSION_CONTEXT_SCREEN_NAMES',
  ].map((name) => ({
    name,
    values: extractConstArray(missionTs, name),
  })),
  {
    name: 'AGENT_MISSION_EVENT_TYPES',
    values: extractConstArray(eventTs, 'AGENT_MISSION_EVENT_TYPES'),
  },
  {
    name: 'AGENT_MISSION_ACTORS',
    values: extractConstArray(eventTs, 'AGENT_MISSION_ACTORS'),
  },
  {
    name: 'AGENT_MISSION_USER_ACTORS',
    values: extractConstArray(eventTs, 'AGENT_MISSION_USER_ACTORS'),
  },
  {
    name: 'AGENT_MISSION_VOICE_ACTORS',
    values: extractConstArray(eventTs, 'AGENT_MISSION_VOICE_ACTORS'),
  },
  {
    name: 'AGENT_MISSION_TAP_ACTORS',
    values: extractConstArray(eventTs, 'AGENT_MISSION_TAP_ACTORS'),
  },
  {
    name: 'AGENT_MISSION_SYSTEM_ACTORS',
    values: extractConstArray(eventTs, 'AGENT_MISSION_SYSTEM_ACTORS'),
  },
  {
    name: 'AGENT_MISSION_START_OUTCOMES',
    values: extractConstArray(eventTs, 'AGENT_MISSION_START_OUTCOMES'),
  },
  {
    name: 'AGENT_MISSION_START_NEW_SLOT_OUTCOMES',
    values: extractConstArray(eventTs, 'AGENT_MISSION_START_NEW_SLOT_OUTCOMES'),
  },
  {
    name: 'AGENT_MISSION_START_EXISTING_SLOT_OUTCOMES',
    values: extractConstArray(eventTs, 'AGENT_MISSION_START_EXISTING_SLOT_OUTCOMES'),
  },
  {
    name: 'AGENT_MISSION_CORRELATION_SYSTEM_EVENT_TYPES',
    values: extractConstArray(eventTs, 'AGENT_MISSION_CORRELATION_SYSTEM_EVENT_TYPES'),
  },
  {
    name: 'AGENT_MISSION_CORRELATION_SCREEN_ACK_EVENT_TYPES',
    values: extractConstArray(eventTs, 'AGENT_MISSION_CORRELATION_SCREEN_ACK_EVENT_TYPES'),
  },
  {
    name: 'AGENT_MISSION_CORRELATION_USER_EVENT_TYPES',
    values: extractConstArray(eventTs, 'AGENT_MISSION_CORRELATION_USER_EVENT_TYPES'),
  },
  {
    name: 'AGENT_MISSION_DRAFT_START_EVENT_TYPES',
    values: extractConstArray(eventTs, 'AGENT_MISSION_DRAFT_START_EVENT_TYPES'),
  },
  {
    name: 'AGENT_MISSION_DRAFT_NO_OP_EVENT_TYPES',
    values: extractConstArray(eventTs, 'AGENT_MISSION_DRAFT_NO_OP_EVENT_TYPES'),
  },
  {
    name: 'AGENT_MISSION_DRAFT_REPLACE_EVENT_TYPES',
    values: extractConstArray(eventTs, 'AGENT_MISSION_DRAFT_REPLACE_EVENT_TYPES'),
  },
  {
    name: 'AGENT_MISSION_DRAFT_ADVANCE_CUSTOMER_EVENT_TYPES',
    values: extractConstArray(eventTs, 'AGENT_MISSION_DRAFT_ADVANCE_CUSTOMER_EVENT_TYPES'),
  },
  ...[
    'AGENT_MISSION_KIND_ONLY_EVENT_TYPES',
    'AGENT_MISSION_EVENT_KIND_ONLY_DATA_KEYS',
    'AGENT_MISSION_EVENT_START_DATA_KEYS',
    'AGENT_MISSION_EVENT_NEXT_PHASE_DATA_KEYS',
    'AGENT_MISSION_EVENT_RESULT_DATA_KEYS',
    'AGENT_MISSION_EVENT_CHOICE_PRESENTED_DATA_KEYS',
    'AGENT_MISSION_EVENT_CUSTOMER_SELECTED_DATA_KEYS',
    'AGENT_MISSION_EVENT_REASON_DATA_KEYS',
    'AGENT_MISSION_SCREEN_ACK_NEXT_PHASES',
    'AGENT_MISSION_CUSTOMER_NOT_FOUND_RESULTS',
    'AGENT_MISSION_CUSTOMER_SELECTION_SOURCES',
    'AGENT_MISSION_DECISION_INVALIDATION_REASONS',
    'AGENT_MISSION_CANCELLATION_REASONS',
    'AGENT_MISSION_EXPIRY_REASONS',
  ].map((name) => ({
    name,
    values: extractConstArray(eventTs, name),
  })),
];

let generatedMigration = regions.reduce(
  (sql, region) => replaceGeneratedRegion(sql, region.name, region.values),
  currentMigration,
);
generatedMigration = replaceGeneratedBody(
  generatedMigration,
  'QUOTE_MISSION_CUSTOMER_CANDIDATE_CHECKS',
  renderCustomerCandidateChecks(
    extractConstArray(missionTs, 'QUOTE_MISSION_CUSTOMER_CANDIDATE_KEYS'),
    extractNumericConst(missionTs, 'AGENT_MISSION_MAX_CUSTOMER_CHOICES'),
  ),
);
const existingDraftActions = extractConstArray(
  missionTs,
  'QUOTE_MISSION_EXISTING_DRAFT_ACTIONS',
);
const confirmDiscardActions = extractConstArray(
  missionTs,
  'QUOTE_MISSION_CONFIRM_DISCARD_ACTIONS',
);
if (existingDraftActions.length !== 2 || confirmDiscardActions.length !== 2) {
  throw new Error('AGENT_MISSION_SQL_DRAFT_ACTION_CARDINALITY_INVALID');
}
for (const [name, value] of [
  ['QUOTE_MISSION_EXISTING_DRAFT_FIRST_ACTION', existingDraftActions[0]],
  ['QUOTE_MISSION_EXISTING_DRAFT_SECOND_ACTION', existingDraftActions[1]],
  ['QUOTE_MISSION_CONFIRM_DISCARD_FIRST_ACTION', confirmDiscardActions[0]],
  ['QUOTE_MISSION_CONFIRM_DISCARD_SECOND_ACTION', confirmDiscardActions[1]],
]) {
  generatedMigration = replaceGeneratedBody(generatedMigration, name, `'${value}'`);
}

if (process.argv.includes('--write')) {
  await writeFile(migrationPath, generatedMigration, 'utf8');
  process.stdout.write('AgentMission migration value lists generated.\n');
} else if (process.argv.includes('--check')) {
  if (generatedMigration !== currentMigration) {
    throw new Error(
      'AGENT_MISSION_SQL_VALUES_DRIFT: run generate-agent-mission-migration-values.mjs --write',
    );
  }
  process.stdout.write('AgentMission migration value lists match the TypeScript domain.\n');
} else {
  process.stdout.write(generatedMigration);
}

#!/usr/bin/env node

import { createHash } from 'node:crypto';
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
const negotiationSource = path.join(
  apiDir,
  'src/voice/realtime/realtime-agent-mission-negotiation.ts',
);
const migrationPath = path.join(
  apiDir,
  'prisma/migrations/20260726010000_agent_missions_expand/migration.sql',
);
const capabilityMigrationPath = path.join(
  apiDir,
  'prisma/migrations/20260727140000_agent_mission_realtime_lease_expand/migration.sql',
);
const commandNamespaceMigrationPath = path.join(
  apiDir,
  'prisma/migrations/20260727180000_agent_mission_event_command_namespace_expand/migration.sql',
);
const customerResolutionExpandMigrationPath = path.join(
  apiDir,
  'prisma/migrations/20260729010000_agent_mission_customer_resolution_expand/migration.sql',
);
const frozenCapabilityExpandProtocolVersions = ['1'];
const frozenHistoricalMigrationHashes = Object.freeze({
  [migrationPath]: '51300a662e0a8a0d92bc80ba371f9fb40f3087e42b049e30823f460087f32882',
  [capabilityMigrationPath]:
    'eeeabc0eb680662b06acf5325e791e3635b20d000f90cb590217187d68b118be',
  [commandNamespaceMigrationPath]:
    '5e4a07e66e047573ccb1766f6a8c844fad8bfe0a128ce9312abac17a9d4f19c5',
});

function extractConstArray(source, name, stack = new Set()) {
  if (stack.has(name)) {
    throw new Error(`AGENT_MISSION_SQL_SOURCE_ARRAY_CYCLE:${name}`);
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = source.match(
    new RegExp(`export const ${escaped} = \\[([\\s\\S]*?)\\] as const;`, 'u'),
  );
  if (match === null) {
    throw new Error(`AGENT_MISSION_SQL_SOURCE_CONSTANT_MISSING:${name}`);
  }
  const nextStack = new Set(stack).add(name);
  const body = match[1].replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
  const values = body
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '')
    .flatMap((token) => {
      const literal = token.match(/^'([^']+)'$/u);
      if (literal !== null) return [literal[1]];
      const spread = token.match(/^\.\.\.([A-Z][A-Z0-9_]*)$/u);
      if (spread !== null) {
        return extractConstArray(source, spread[1], nextStack);
      }
      throw new Error(`AGENT_MISSION_SQL_SOURCE_ARRAY_TOKEN_INVALID:${name}:${token}`);
    });
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

function extractNumericConstArray(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = source.match(
    new RegExp(`export const ${escaped} = \\[([\\s\\S]*?)\\] as const;`, 'u'),
  );
  if (match === null) {
    throw new Error(`AGENT_MISSION_SQL_SOURCE_NUMERIC_ARRAY_MISSING:${name}`);
  }
  const body = match[1].trim();
  if (!/^[0-9_,\s]+$/u.test(body)) {
    throw new Error(`AGENT_MISSION_SQL_SOURCE_NUMERIC_ARRAY_INVALID:${name}`);
  }
  const rawValues = body.split(',');
  if (rawValues.at(-1)?.trim() === '') rawValues.pop();
  if (rawValues.some((value) => value.trim() === '')) {
    throw new Error(`AGENT_MISSION_SQL_SOURCE_NUMERIC_ARRAY_INVALID:${name}`);
  }
  const values = rawValues
    .map((item) => Number(item.trim().replaceAll('_', '')));
  if (
    values.length === 0
    || new Set(values).size !== values.length
    || values.some((value) => !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new Error(`AGENT_MISSION_SQL_SOURCE_NUMERIC_ARRAY_INVALID:${name}`);
  }
  return values.map(String);
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

function renderSqlValues(values, indent) {
  return values
    .map((value, index) => `${indent}'${value}'${index === values.length - 1 ? '' : ','}`)
    .join('\n');
}

function renderGeneratedValues(name, values, indent) {
  return [
    `${indent}-- BEGIN GENERATED ${name}`,
    renderSqlValues(values, indent),
    `${indent}-- END GENERATED ${name}`,
  ].join('\n');
}

function renderStagedCustomerCandidateChecks(keys, maximumCandidates) {
  const checks = Array.from({ length: maximumCandidates }, (_, index) => {
    const candidate = `"payload" #> '{stagedCustomerResolution,candidates,${index}}'`;
    return [
      `${index === 0 ? '' : 'AND '}(`,
      '  jsonb_array_length(',
      "    \"payload\" #> '{stagedCustomerResolution,candidates}'",
      `  ) <= ${index}`,
      '  OR (',
      `    jsonb_typeof(${candidate}) = 'object'`,
      `    AND (${candidate}) ?& ARRAY[`,
      renderSqlValues(keys, '      '),
      '    ]',
      `    AND (${candidate}) - ARRAY[`,
      renderSqlValues(keys, '      '),
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
  });
  const uniquenessChecks = [];
  for (let left = 0; left < maximumCandidates; left += 1) {
    for (let right = left + 1; right < maximumCandidates; right += 1) {
      uniquenessChecks.push([
        'AND (',
        '  jsonb_array_length(',
        "    \"payload\" #> '{stagedCustomerResolution,candidates}'",
        `  ) <= ${right}`,
        '  OR (',
        `    "payload" #>> '{stagedCustomerResolution,candidates,${left},choiceId}'`,
        `      <> "payload" #>> '{stagedCustomerResolution,candidates,${right},choiceId}'`,
        '    AND',
        `    "payload" #>> '{stagedCustomerResolution,candidates,${left},customerId}'`,
        `      <> "payload" #>> '{stagedCustomerResolution,candidates,${right},customerId}'`,
        '  )',
        ')',
      ].join('\n'));
    }
  }
  return [...checks, ...uniquenessChecks].join('\n');
}

function extractCreateTableConstraint(sql, name) {
  const startToken = `CONSTRAINT ${name} CHECK `;
  const start = sql.indexOf(startToken);
  if (start === -1) {
    throw new Error(`AGENT_MISSION_SQL_CONSTRAINT_MISSING:${name}`);
  }
  const next = sql.indexOf('\n  CONSTRAINT ', start + startToken.length);
  if (next === -1) {
    throw new Error(`AGENT_MISSION_SQL_CONSTRAINT_BOUNDARY_MISSING:${name}`);
  }
  return sql.slice(start, next).trim().replace(/,$/u, '');
}

function extractAlterTableConstraint(sql, name) {
  const startToken = `ADD CONSTRAINT ${name} CHECK `;
  const start = sql.indexOf(startToken);
  const endToken = '\n  ) NOT VALID;';
  const end = sql.lastIndexOf(endToken);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`AGENT_MISSION_SQL_CONSTRAINT_MISSING:${name}`);
  }
  return sql
    .slice(start + 'ADD '.length, end + '\n  )'.length)
    .trim();
}

function renameConstraint(constraint, from, to) {
  const renamed = constraint.replace(
    `CONSTRAINT ${from} CHECK `,
    `CONSTRAINT ${to} CHECK `,
  );
  if (renamed === constraint) {
    throw new Error(`AGENT_MISSION_SQL_CONSTRAINT_RENAME_FAILED:${from}`);
  }
  return renamed;
}

function replaceOnce(value, needle, replacement, errorCode) {
  const index = value.indexOf(needle);
  if (index === -1 || value.indexOf(needle, index + needle.length) !== -1) {
    throw new Error(errorCode);
  }
  return `${value.slice(0, index)}${replacement}${value.slice(index + needle.length)}`;
}

function applyKnownRegions(sql, regions) {
  return regions.reduce(
    (current, region) => (
      current.includes(`-- BEGIN GENERATED ${region.name}`)
        ? replaceGeneratedRegion(current, region.name, region.values)
        : current
    ),
    sql,
  );
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const [
  missionTs,
  eventTs,
  negotiationTs,
  currentMigration,
  currentCapabilityMigration,
  currentCommandNamespaceMigration,
  currentCustomerResolutionExpandMigration,
] =
  await Promise.all([
  readFile(missionSource, 'utf8'),
  readFile(eventSource, 'utf8'),
  readFile(negotiationSource, 'utf8'),
  readFile(migrationPath, 'utf8'),
  readFile(capabilityMigrationPath, 'utf8'),
  readFile(commandNamespaceMigrationPath, 'utf8'),
  readFile(customerResolutionExpandMigrationPath, 'utf8').catch((error) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  }),
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
    'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KINDS',
    'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KIND_ONLY_KEYS',
    'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_EXACT_KEYS',
    'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_CHOICES_KEYS',
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
    name: 'AGENT_MISSION_SYSTEM_CONTINUATION_EVENT_TYPES',
    values: extractConstArray(eventTs, 'AGENT_MISSION_SYSTEM_CONTINUATION_EVENT_TYPES'),
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
    'AGENT_MISSION_EVENT_STAGED_RESOLUTION_DATA_KEYS',
    'AGENT_MISSION_EVENT_CHOICE_PRESENTED_DATA_KEYS',
    'AGENT_MISSION_EVENT_CUSTOMER_SELECTED_DATA_KEYS',
    'AGENT_MISSION_EVENT_REASON_DATA_KEYS',
    'AGENT_MISSION_SCREEN_ACK_NEXT_PHASES',
    'AGENT_MISSION_CUSTOMER_NOT_FOUND_RESULTS',
    'AGENT_MISSION_STAGED_CUSTOMER_RESOLUTION_RESULTS',
    'AGENT_MISSION_CUSTOMER_SELECTION_SOURCES',
    'AGENT_MISSION_DECISION_INVALIDATION_REASONS',
    'AGENT_MISSION_CANCELLATION_REASONS',
    'AGENT_MISSION_EXPIRY_REASONS',
  ].map((name) => ({
    name,
    values: extractConstArray(eventTs, name),
  })),
];

const currentProtocolVersions = extractNumericConstArray(
  negotiationTs,
  'AGENT_MISSION_PROTOCOL_VERSIONS',
);
if (
  currentProtocolVersions.length !== frozenCapabilityExpandProtocolVersions.length
  || currentProtocolVersions.some(
    (version, index) => version !== frozenCapabilityExpandProtocolVersions[index],
  )
) {
  throw new Error(
    'AGENT_MISSION_PROTOCOL_MIGRATION_FROZEN: create a new expand/validate migration',
  );
}

for (const [migrationFile, expectedHash] of Object.entries(
  frozenHistoricalMigrationHashes,
)) {
  const contents = migrationFile === migrationPath
    ? currentMigration
    : migrationFile === capabilityMigrationPath
      ? currentCapabilityMigration
      : currentCommandNamespaceMigration;
  if (sha256(contents) !== expectedHash) {
    throw new Error(`AGENT_MISSION_HISTORICAL_MIGRATION_CHANGED:${migrationFile}`);
  }
}

const legacyPayloadKeys = extractConstArray(
  missionTs,
  'QUOTE_MISSION_LEGACY_PAYLOAD_KEYS',
);
const currentPayloadKeys = extractConstArray(missionTs, 'QUOTE_MISSION_PAYLOAD_KEYS');
const stagedKinds = extractConstArray(
  missionTs,
  'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KINDS',
);
const stagedKindOnlyKeys = extractConstArray(
  missionTs,
  'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KIND_ONLY_KEYS',
);
const stagedExactKeys = extractConstArray(
  missionTs,
  'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_EXACT_KEYS',
);
const stagedChoicesKeys = extractConstArray(
  missionTs,
  'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_CHOICES_KEYS',
);
const customerCandidateKeys = extractConstArray(
  missionTs,
  'QUOTE_MISSION_CUSTOMER_CANDIDATE_KEYS',
);
const maximumCustomerCandidates = extractNumericConst(
  missionTs,
  'AGENT_MISSION_MAX_CUSTOMER_CHOICES',
);

let missionPayloadConstraint = renameConstraint(
  extractCreateTableConstraint(currentMigration, 'agent_missions_payload_check'),
  'agent_missions_payload_check',
  'agent_missions_payload_m1c_check',
);
missionPayloadConstraint = missionPayloadConstraint
  .replaceAll(
    'GENERATED QUOTE_MISSION_PAYLOAD_KEYS',
    'GENERATED M1C_QUOTE_MISSION_REQUIRED_LEGACY_PAYLOAD_KEYS',
  );
missionPayloadConstraint = replaceGeneratedRegion(
  missionPayloadConstraint,
  'M1C_QUOTE_MISSION_REQUIRED_LEGACY_PAYLOAD_KEYS',
  legacyPayloadKeys,
);

let missionClosedShapeConstraint = applyKnownRegions(
  renameConstraint(
    extractCreateTableConstraint(
      currentMigration,
      'agent_missions_payload_closed_shape_check',
    ),
    'agent_missions_payload_closed_shape_check',
    'agent_missions_payload_closed_shape_m1c_check',
  ),
  regions,
);
const currentPayloadTopShape = [
  '    "payload" - ARRAY[',
  renderGeneratedValues('QUOTE_MISSION_PAYLOAD_KEYS', currentPayloadKeys, '      '),
  "    ] = '{}'::JSONB",
].join('\n');
const stagedCandidateChecks = renderStagedCustomerCandidateChecks(
  customerCandidateKeys,
  maximumCustomerCandidates,
)
  .split('\n')
  .map((line) => `                ${line}`)
  .join('\n');
const m1cPayloadTopShape = [
  '    (',
  '      (',
  "        NOT (\"payload\" ? 'stagedCustomerResolution')",
  '        AND "payload" - ARRAY[',
  renderGeneratedValues(
    'M1C_QUOTE_MISSION_LEGACY_PAYLOAD_KEYS',
    legacyPayloadKeys,
    '          ',
  ),
  "        ] = '{}'::JSONB",
  '      )',
  '      OR (',
  "        \"payload\" ? 'stagedCustomerResolution'",
  '        AND "payload" - ARRAY[',
  renderGeneratedValues(
    'M1C_QUOTE_MISSION_PAYLOAD_KEYS',
    currentPayloadKeys,
    '          ',
  ),
  "        ] = '{}'::JSONB",
  '        AND (',
  "          \"payload\" -> 'stagedCustomerResolution' = 'null'::JSONB",
  '          OR (',
  "            jsonb_typeof(\"payload\" -> 'stagedCustomerResolution') = 'object'",
  "            AND \"payload\" #>> '{stagedCustomerResolution,kind}' IN (",
  renderGeneratedValues(
    'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KINDS',
    stagedKinds,
    '              ',
  ),
  '            )',
  '            AND (',
  '              (',
  "                \"payload\" #>> '{stagedCustomerResolution,kind}' IN ('none', 'too_many')",
  "                AND (\"payload\" -> 'stagedCustomerResolution') ?& ARRAY[",
  renderGeneratedValues(
    'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KIND_ONLY_KEYS',
    stagedKindOnlyKeys,
    '                  ',
  ),
  '                ]',
  "                AND (\"payload\" -> 'stagedCustomerResolution') - ARRAY[",
  renderGeneratedValues(
    'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KIND_ONLY_KEYS',
    stagedKindOnlyKeys,
    '                  ',
  ),
  "                ] = '{}'::JSONB",
  '              )',
  '              OR (',
  "                \"payload\" #>> '{stagedCustomerResolution,kind}' = 'exact'",
  "                AND (\"payload\" -> 'stagedCustomerResolution') ?& ARRAY[",
  renderGeneratedValues(
    'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_EXACT_KEYS',
    stagedExactKeys,
    '                  ',
  ),
  '                ]',
  "                AND (\"payload\" -> 'stagedCustomerResolution') - ARRAY[",
  renderGeneratedValues(
    'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_EXACT_KEYS',
    stagedExactKeys,
    '                  ',
  ),
  "                ] = '{}'::JSONB",
  "                AND jsonb_typeof(\"payload\" #> '{stagedCustomerResolution,customerId}') = 'string'",
  "                AND length(\"payload\" #>> '{stagedCustomerResolution,customerId}')",
  '                  BETWEEN 1 AND 200',
  "                AND \"payload\" #>> '{stagedCustomerResolution,customerId}'",
  "                  = btrim(\"payload\" #>> '{stagedCustomerResolution,customerId}')",
  "                AND \"payload\" #>> '{stagedCustomerResolution,customerId}'",
  "                  !~ '[[:cntrl:]]'",
  '              )',
  '              OR (',
  "                \"payload\" #>> '{stagedCustomerResolution,kind}' = 'choices'",
  "                AND (\"payload\" -> 'stagedCustomerResolution') ?& ARRAY[",
  renderGeneratedValues(
    'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_CHOICES_KEYS',
    stagedChoicesKeys,
    '                  ',
  ),
  '                ]',
  "                AND (\"payload\" -> 'stagedCustomerResolution') - ARRAY[",
  renderGeneratedValues(
    'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_CHOICES_KEYS',
    stagedChoicesKeys,
    '                  ',
  ),
  "                ] = '{}'::JSONB",
  "                AND \"payload\" #>> '{stagedCustomerResolution,decisionId}'",
  "                  ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'",
  "                AND jsonb_typeof(\"payload\" #> '{stagedCustomerResolution,candidates}') = 'array'",
  '                AND jsonb_array_length(',
  "                  \"payload\" #> '{stagedCustomerResolution,candidates}'",
  `                ) BETWEEN 1 AND ${maximumCustomerCandidates}`,
  '                AND',
  '                -- BEGIN GENERATED M1C_QUOTE_MISSION_STAGED_CUSTOMER_CANDIDATE_CHECKS',
  stagedCandidateChecks,
  '                -- END GENERATED M1C_QUOTE_MISSION_STAGED_CUSTOMER_CANDIDATE_CHECKS',
  '              )',
  '            )',
  '          )',
  '        )',
  '      )',
  '    )',
].join('\n');
missionClosedShapeConstraint = replaceOnce(
  missionClosedShapeConstraint,
  currentPayloadTopShape,
  m1cPayloadTopShape,
  'AGENT_MISSION_M1C_PAYLOAD_TOP_SHAPE_REPLACEMENT_FAILED',
);

let missionPhasePayloadConstraint = renameConstraint(
  extractCreateTableConstraint(
    currentMigration,
    'agent_missions_phase_payload_check',
  ),
  'agent_missions_phase_payload_check',
  'agent_missions_phase_payload_m1c_check',
);
missionPhasePayloadConstraint = replaceOnce(
  missionPhasePayloadConstraint,
  'CHECK ((',
  'CHECK (((',
  'AGENT_MISSION_M1C_PHASE_PAYLOAD_OPEN_REPLACEMENT_FAILED',
);
missionPhasePayloadConstraint = replaceOnce(
  missionPhasePayloadConstraint,
  '  ) IS TRUE)',
  [
    '  )',
    '  AND (',
    "    NOT (\"payload\" ? 'stagedCustomerResolution')",
    "    OR \"payload\" -> 'stagedCustomerResolution' = 'null'::JSONB",
    "    OR \"phase\" NOT IN ('awaiting_customer_choice', 'awaiting_lines')",
    '  )',
    ') IS TRUE)',
  ].join('\n'),
  'AGENT_MISSION_M1C_PHASE_PAYLOAD_REPLACEMENT_FAILED',
);

const eventTypeConstraint = applyKnownRegions(
  renameConstraint(
    extractCreateTableConstraint(
      currentMigration,
      'agent_mission_events_type_check',
    ),
    'agent_mission_events_type_check',
    'agent_mission_events_type_m1c_check',
  ),
  regions,
);

let eventEnvelopeConstraint = applyKnownRegions(
  renameConstraint(
    extractAlterTableConstraint(
      currentCommandNamespaceMigration,
      'agent_mission_events_envelope_v2_check',
    ),
    'agent_mission_events_envelope_v2_check',
    'agent_mission_events_envelope_m1c_check',
  ),
  regions,
);
const envelopeSystemBranch = [
  '      OR (',
  '        "eventType" IN (',
  renderGeneratedValues(
    'AGENT_MISSION_SYSTEM_CONTINUATION_EVENT_TYPES',
    extractConstArray(eventTs, 'AGENT_MISSION_SYSTEM_CONTINUATION_EVENT_TYPES'),
    '          ',
  ),
  '        )',
  "        AND \"actor\" = 'system'",
  '        AND "commandId"::TEXT',
  "          ~ '^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'",
  '      )',
  '      OR (',
  '        "eventType" IN (',
  '          -- BEGIN GENERATED AGENT_MISSION_CORRELATION_SYSTEM_EVENT_TYPES',
].join('\n');
eventEnvelopeConstraint = replaceOnce(
  eventEnvelopeConstraint,
  [
    '      OR (',
    '        "eventType" IN (',
    '          -- BEGIN GENERATED AGENT_MISSION_CORRELATION_SYSTEM_EVENT_TYPES',
  ].join('\n'),
  envelopeSystemBranch,
  'AGENT_MISSION_M1C_ENVELOPE_SYSTEM_BRANCH_REPLACEMENT_FAILED',
);

let eventDataConstraint = applyKnownRegions(
  renameConstraint(
    extractCreateTableConstraint(
      currentMigration,
      'agent_mission_events_data_check',
    ),
    'agent_mission_events_data_check',
    'agent_mission_events_data_m1c_check',
  ),
  regions,
);
const customerNotFoundDataBranch = [
  '      OR (',
  "        \"eventType\" = 'customer_not_found'",
].join('\n');
const stagedDataBranch = [
  '      OR (',
  "        \"eventType\" = 'customer_resolution_staged'",
  '        AND "data" ?& ARRAY[',
  renderGeneratedValues(
    'AGENT_MISSION_EVENT_STAGED_RESOLUTION_DATA_KEYS',
    extractConstArray(eventTs, 'AGENT_MISSION_EVENT_STAGED_RESOLUTION_DATA_KEYS'),
    '          ',
  ),
  '        ]',
  '        AND "data" - ARRAY[',
  renderGeneratedValues(
    'AGENT_MISSION_EVENT_STAGED_RESOLUTION_DATA_KEYS',
    extractConstArray(eventTs, 'AGENT_MISSION_EVENT_STAGED_RESOLUTION_DATA_KEYS'),
    '          ',
  ),
  "        ] = '{}'::JSONB",
  "        AND \"data\" ->> 'result' IN (",
  renderGeneratedValues(
    'AGENT_MISSION_STAGED_CUSTOMER_RESOLUTION_RESULTS',
    extractConstArray(eventTs, 'AGENT_MISSION_STAGED_CUSTOMER_RESOLUTION_RESULTS'),
    '          ',
  ),
  '        )',
  "        AND jsonb_typeof(\"data\" -> 'observedCandidateCount') = 'number'",
  "        AND (\"data\" ->> 'observedCandidateCount')::NUMERIC",
  '          = trunc(("data" ->> \'observedCandidateCount\')::NUMERIC)',
  '        AND (',
  "          (\"data\" ->> 'result' = 'none'",
  "            AND (\"data\" ->> 'observedCandidateCount')::NUMERIC = 0)",
  "          OR (\"data\" ->> 'result' = 'too_many'",
  "            AND (\"data\" ->> 'observedCandidateCount')::NUMERIC = 6)",
  "          OR (\"data\" ->> 'result' = 'exact'",
  "            AND (\"data\" ->> 'observedCandidateCount')::NUMERIC = 1)",
  "          OR (\"data\" ->> 'result' = 'choices'",
  "            AND (\"data\" ->> 'observedCandidateCount')::NUMERIC BETWEEN 1 AND 5)",
  '        )',
  '      )',
  customerNotFoundDataBranch,
].join('\n');
eventDataConstraint = replaceOnce(
  eventDataConstraint,
  customerNotFoundDataBranch,
  stagedDataBranch,
  'AGENT_MISSION_M1C_STAGED_DATA_BRANCH_REPLACEMENT_FAILED',
);

let eventCorrelationConstraint = applyKnownRegions(
  renameConstraint(
    extractCreateTableConstraint(
      currentMigration,
      'agent_mission_events_correlation_check',
    ),
    'agent_mission_events_correlation_check',
    'agent_mission_events_correlation_m1c_check',
  ),
  regions,
);
const userCorrelationBranch = [
  '    OR (',
  '      "eventType" IN (',
  '        -- BEGIN GENERATED AGENT_MISSION_CORRELATION_USER_EVENT_TYPES',
].join('\n');
const continuationCorrelationBranch = [
  '    OR (',
  '      "eventType" IN (',
  renderGeneratedValues(
    'AGENT_MISSION_SYSTEM_CONTINUATION_EVENT_TYPES',
    extractConstArray(eventTs, 'AGENT_MISSION_SYSTEM_CONTINUATION_EVENT_TYPES'),
    '        ',
  ),
  '      )',
  "      AND \"actor\" = 'system'",
  '      AND "realtimeSessionId" IS NOT NULL',
  '      AND "turnId" IS NULL',
  '      AND "contextRevision" BETWEEN 1 AND 2147483647',
  "      AND \"contextDigest\"::TEXT ~ '^[a-f0-9]{64}$'",
  '      AND (',
  "        \"eventType\" <> 'customer_selected'",
  "        OR \"data\" ->> 'source' = 'exact_match'",
  '      )',
  '    )',
  userCorrelationBranch,
].join('\n');
eventCorrelationConstraint = replaceOnce(
  eventCorrelationConstraint,
  userCorrelationBranch,
  continuationCorrelationBranch,
  'AGENT_MISSION_M1C_CONTINUATION_CORRELATION_REPLACEMENT_FAILED',
);
eventCorrelationConstraint = replaceOnce(
  eventCorrelationConstraint,
  [
    '      AND (',
    '        (',
    '          "actor" IN (',
  ].join('\n'),
  [
    '      AND (',
    "        \"eventType\" <> 'customer_selected'",
    "        OR \"data\" ->> 'source' <> 'screen_selection'",
    "        OR \"actor\" = 'user_tap'",
    '      )',
    '      AND (',
    '        (',
    '          "actor" IN (',
  ].join('\n'),
  'AGENT_MISSION_M1C_SCREEN_SELECTION_ACTOR_REPLACEMENT_FAILED',
);

const eventDraftEffectConstraint = applyKnownRegions(
  renameConstraint(
    extractCreateTableConstraint(
      currentMigration,
      'agent_mission_events_draft_effect_check',
    ),
    'agent_mission_events_draft_effect_check',
    'agent_mission_events_draft_effect_m1c_check',
  ),
  regions,
);

const generatedCustomerResolutionExpandMigration = [
  '-- Bob AgentMission M1-C — élargissement compatible N-1 des unions mission/événement.',
  '-- Le flag M1-C reste OFF jusqu’au cutover validé et au drainage des writers N-1.',
  '',
  'BEGIN;',
  '',
  "SET LOCAL lock_timeout = '5s';",
  "SET LOCAL statement_timeout = '60s';",
  '',
  'ALTER TABLE public.agent_missions',
  [
    missionPayloadConstraint,
    missionClosedShapeConstraint,
    missionPhasePayloadConstraint,
  ].map((constraint, index, constraints) => (
    `${index === 0 ? '  ADD ' : '  ADD '}${constraint} NOT VALID${
      index === constraints.length - 1 ? ';' : ','
    }`
  )).join('\n'),
  '',
  'ALTER TABLE public.agent_mission_events',
  [
    eventTypeConstraint,
    eventEnvelopeConstraint,
    eventDataConstraint,
    eventCorrelationConstraint,
    eventDraftEffectConstraint,
  ].map((constraint, index, constraints) => (
    `${index === 0 ? '  ADD ' : '  ADD '}${constraint} NOT VALID${
      index === constraints.length - 1 ? ';' : ','
    }`
  )).join('\n'),
  '',
  'COMMIT;',
  '',
].join('\n');

if (process.argv.includes('--write')) {
  await writeFile(
    customerResolutionExpandMigrationPath,
    generatedCustomerResolutionExpandMigration,
    'utf8',
  );
  process.stdout.write('AgentMission M1-C migration value lists generated.\n');
} else if (process.argv.includes('--check')) {
  if (
    currentCustomerResolutionExpandMigration === ''
    || generatedCustomerResolutionExpandMigration
      !== currentCustomerResolutionExpandMigration
  ) {
    throw new Error(
      'AGENT_MISSION_SQL_VALUES_DRIFT: run generate-agent-mission-migration-values.mjs --write',
    );
  }
  process.stdout.write('AgentMission migration value lists match the TypeScript domain.\n');
} else {
  process.stdout.write(generatedCustomerResolutionExpandMigration);
}

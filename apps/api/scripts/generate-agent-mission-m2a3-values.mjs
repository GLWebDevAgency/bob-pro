#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const apiDirectory = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(apiDirectory, '..', '..');
const eventSourcePath = path.join(
  repositoryRoot,
  'packages/core/src/domain/agent/agent-mission-event.ts',
);
const m2a2ExpandPath = path.join(
  apiDirectory,
  'prisma/migrations/20260730110000_agent_mission_line_confirmation_expand/migration.sql',
);
const expandPath = path.join(
  apiDirectory,
  'prisma/migrations/20260731120000_agent_mission_line_cancel_choice_expand/migration.sql',
);
const validatePath = path.join(
  apiDirectory,
  'prisma/migrations/20260731120100_agent_mission_line_cancel_choice_validate/migration.sql',
);
const cutoverPath = path.join(
  apiDirectory,
  'prisma/migrations/20260731120200_agent_mission_line_cancel_choice_cutover/migration.sql',
);

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function extractStringConstArray(source, name) {
  const match = source.match(
    new RegExp(
      `export const ${escaped(name)}(?:\\s*:[^=]+)?\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const(?:\\s+satisfies\\s+[^;]+)?;`,
      'u',
    ),
  );
  if (match === null) {
    throw new Error(`AGENT_MISSION_M2A3_SOURCE_ARRAY_MISSING:${name}`);
  }
  const values = match[1]
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/.*$/gmu, '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const literal = token.match(/^'([^']+)'$/u);
      if (literal === null) {
        throw new Error(
          `AGENT_MISSION_M2A3_SOURCE_ARRAY_TOKEN_INVALID:${name}:${token}`,
        );
      }
      return literal[1];
    });
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`AGENT_MISSION_M2A3_SOURCE_ARRAY_INVALID:${name}`);
  }
  return values;
}

function sqlValues(values, indent) {
  return values
    .map((value, index) => (
      `${indent}'${value}'${index === values.length - 1 ? '' : ','}`
    ))
    .join('\n');
}

function replaceGeneratedRegion(sql, name, values) {
  const pattern = new RegExp(
    `(^[ \\t]*-- BEGIN GENERATED ${escaped(name)}\\r?\\n)([\\s\\S]*?)(^[ \\t]*-- END GENERATED ${escaped(name)}$)`,
    'gmu',
  );
  let replacements = 0;
  const output = sql.replace(pattern, (_region, start, _body, end) => {
    replacements += 1;
    const indent = start.match(/^([ \t]*)/u)?.[1] ?? '';
    return `${start}${sqlValues(values, indent)}\n${end}`;
  });
  if (replacements !== 2) {
    throw new Error(
      `AGENT_MISSION_M2A3_SQL_REGION_COUNT:${name}:${replacements}`,
    );
  }
  return output;
}

function extractConstraint(sql, name) {
  const token = `ADD CONSTRAINT ${name} CHECK `;
  const start = sql.indexOf(token);
  if (start === -1) {
    throw new Error(`AGENT_MISSION_M2A3_SQL_CONSTRAINT_MISSING:${name}`);
  }
  const nextConstraint = sql.indexOf(',\n  ADD CONSTRAINT ', start + token.length);
  const nextStatement = sql.indexOf(';\n\n', start + token.length);
  const end = nextConstraint === -1
    ? nextStatement
    : nextStatement === -1
      ? nextConstraint
      : Math.min(nextConstraint, nextStatement);
  if (end === -1) {
    throw new Error(
      `AGENT_MISSION_M2A3_SQL_CONSTRAINT_BOUNDARY:${name}`,
    );
  }
  return sql
    .slice(start + 'ADD '.length, end)
    .trim()
    .replace(/\s+NOT VALID$/u, '');
}

function replaceOnce(value, needle, replacement, code) {
  const first = value.indexOf(needle);
  if (
    first === -1
    || value.indexOf(needle, first + needle.length) !== -1
  ) {
    throw new Error(code);
  }
  return `${value.slice(0, first)}${replacement}${
    value.slice(first + needle.length)
  }`;
}

function assumeOwner(table, label) {
  return [
    `DO $bob_m2a3_${label}_owner$`,
    'DECLARE',
    '  owner_oid OID;',
    '  owner_name TEXT;',
    'BEGIN',
    '  SELECT relation.relowner, pg_catalog.pg_get_userbyid(relation.relowner)',
    '    INTO STRICT owner_oid, owner_name',
    '    FROM pg_catalog.pg_class AS relation',
    '    JOIN pg_catalog.pg_namespace AS namespace',
    '      ON namespace.oid = relation.relnamespace',
    "   WHERE namespace.nspname = 'public'",
    `     AND relation.relname = '${table}'`,
    "     AND relation.relkind IN ('r', 'p');",
    '',
    '  IF current_user::pg_catalog.regrole <> owner_oid THEN',
    '    IF owner_name IS NULL',
    "       OR NOT pg_catalog.pg_has_role(session_user, owner_oid, 'SET') THEN",
    '      RAISE EXCEPTION USING',
    "        ERRCODE = '42501',",
    `        MESSAGE = 'AGENT_MISSION_M2A3_${label.toUpperCase()}_OWNER_UNAVAILABLE';`,
    '    END IF;',
    "    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);",
    '  END IF;',
    '',
    '  IF current_user::pg_catalog.regrole <> owner_oid THEN',
    '    RAISE EXCEPTION USING',
    "      ERRCODE = '42501',",
    `      MESSAGE = 'AGENT_MISSION_M2A3_${label.toUpperCase()}_OWNER_NOT_ASSUMED';`,
    '  END IF;',
    'END;',
    `$bob_m2a3_${label}_owner$;`,
  ].join('\n');
}

function releaseFlagFence(label) {
  return [
    assumeOwner('release_flags', `${label}_release_flags`),
    '',
    'ALTER TABLE public.release_flags NO FORCE ROW LEVEL SECURITY;',
    '',
    `DO $bob_m2a3_${label}_release_flag_exact$`,
    'BEGIN',
    '  IF (',
    '    SELECT pg_catalog.count(*)',
    '      FROM public.release_flags AS flag',
    "     WHERE flag.key = 'bob.agent_missions.quote.m2a'",
    '  ) <> 3',
    '  OR EXISTS (',
    '    SELECT 1',
    '      FROM public.release_flags AS flag',
    "     WHERE flag.key = 'bob.agent_missions.quote.m2a'",
    '       AND (',
    "         flag.environment::TEXT NOT IN ('development', 'staging', 'production')",
    '         OR flag.enabled',
    '         OR flag."killSwitch"',
    '         OR flag.version <> 1',
    '       )',
    '  ) THEN',
    '    RAISE EXCEPTION USING',
    "      ERRCODE = '23514',",
    `      MESSAGE = 'AGENT_MISSION_M2A3_${label.toUpperCase()}_FLAG_NOT_EXACTLY_OFF';`,
    '  END IF;',
    'END;',
    `$bob_m2a3_${label}_release_flag_exact$;`,
    '',
    'ALTER TABLE public.release_flags ENABLE ROW LEVEL SECURITY;',
    'ALTER TABLE public.release_flags FORCE ROW LEVEL SECURITY;',
    'RESET ROLE;',
  ].join('\n');
}

const [eventSource, m2a2Expand] = await Promise.all([
  readFile(eventSourcePath, 'utf8'),
  readFile(m2a2ExpandPath, 'utf8'),
]);
const lineCancelledKeys = extractStringConstArray(
  eventSource,
  'AGENT_MISSION_EVENT_LINE_CANCELLED_DATA_KEYS',
);
if (
  JSON.stringify(lineCancelledKeys)
  !== JSON.stringify([
    'kind',
    'pendingLineId',
    'expectedWorkRevision',
    'choiceId',
    'choiceSetHash',
  ])
) {
  throw new Error('AGENT_MISSION_M2A3_LINE_CANCELLED_KEYS_CHANGED');
}

let dataConstraint = extractConstraint(
  m2a2Expand,
  'agent_mission_events_data_m2a2_check',
).replace(
  'CONSTRAINT agent_mission_events_data_m2a2_check CHECK ',
  'CONSTRAINT agent_mission_events_data_m2a3_check CHECK ',
);
dataConstraint = replaceGeneratedRegion(
  dataConstraint,
  'AGENT_MISSION_EVENT_LINE_CANCELLED_DATA_KEYS',
  lineCancelledKeys,
);
const oldChoiceCheck = [
  '        AND "data" ->> \'choiceId\' ~ \'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$\'',
  '        AND jsonb_typeof("data" -> \'choiceSetHash\') = \'string\'',
  '        AND "data" ->> \'choiceSetHash\' ~ \'^[a-f0-9]{64}$\'',
].join('\n');
const nullableChoiceCheck = [
  '        AND (',
  '          (',
  '            "data" -> \'choiceId\' = \'null\'::JSONB',
  '            AND "data" -> \'choiceSetHash\' = \'null\'::JSONB',
  '          )',
  '          OR (',
  '            "data" ->> \'choiceId\' ~ \'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$\'',
  '            AND jsonb_typeof("data" -> \'choiceSetHash\') = \'string\'',
  '            AND "data" ->> \'choiceSetHash\' ~ \'^[a-f0-9]{64}$\'',
  '          )',
  '        )',
].join('\n');
const lineCancelledBranchStart = dataConstraint.indexOf(
  '        "eventType" = \'line_cancelled\'',
);
const lineCancelledBranchEnd = dataConstraint.indexOf(
  '\n      OR (',
  lineCancelledBranchStart,
);
if (lineCancelledBranchStart === -1 || lineCancelledBranchEnd === -1) {
  throw new Error('AGENT_MISSION_M2A3_LINE_CANCELLED_BRANCH_MISSING');
}
const lineCancelledBranch = dataConstraint.slice(
  lineCancelledBranchStart,
  lineCancelledBranchEnd,
);
const updatedLineCancelledBranch = replaceOnce(
  lineCancelledBranch,
  oldChoiceCheck,
  nullableChoiceCheck,
  'AGENT_MISSION_M2A3_LINE_CANCELLED_CHECK_NOT_UNIQUE',
);
dataConstraint = `${dataConstraint.slice(0, lineCancelledBranchStart)}${
  updatedLineCancelledBranch
}${dataConstraint.slice(lineCancelledBranchEnd)}`;

const expand = [
  '-- Bob AgentMission M2-A-3 — annulation de ligne sans décision, expand writer N-1.',
  '-- Le flag bob.agent_missions.quote.m2a doit rester exactement OFF.',
  '',
  'BEGIN;',
  "SET LOCAL lock_timeout = '5s';",
  "SET LOCAL statement_timeout = '120s';",
  '',
  releaseFlagFence('expand'),
  '',
  assumeOwner('agent_mission_events', 'expand_events'),
  '',
  'ALTER TABLE public.agent_mission_events',
  `  ADD ${dataConstraint} NOT VALID;`,
  'RESET ROLE;',
  '',
  'COMMIT;',
  '',
].join('\n');

const validate = [
  '-- Bob AgentMission M2-A-3 — validation séparée du CHECK événement.',
  '',
  'BEGIN;',
  "SET LOCAL lock_timeout = '5s';",
  "SET LOCAL statement_timeout = '5min';",
  '',
  assumeOwner('agent_mission_events', 'validate_events'),
  'ALTER TABLE public.agent_mission_events',
  '  VALIDATE CONSTRAINT agent_mission_events_data_m2a3_check;',
  'RESET ROLE;',
  '',
  'COMMIT;',
  '',
].join('\n');

const cutover = [
  '-- Bob AgentMission M2-A-3 — cutover du CHECK après validation et writers N-1.',
  '-- Le flag bob.agent_missions.quote.m2a reste OFF.',
  '',
  'BEGIN;',
  "SET LOCAL lock_timeout = '5s';",
  "SET LOCAL statement_timeout = '120s';",
  '',
  releaseFlagFence('cutover'),
  '',
  assumeOwner('agent_mission_events', 'cutover_events'),
  'ALTER TABLE public.agent_mission_events',
  '  DROP CONSTRAINT agent_mission_events_data_check;',
  'ALTER TABLE public.agent_mission_events',
  '  RENAME CONSTRAINT agent_mission_events_data_m2a3_check',
  '    TO agent_mission_events_data_check;',
  'RESET ROLE;',
  '',
  'COMMIT;',
  '',
].join('\n');

const outputs = [
  [expandPath, expand],
  [validatePath, validate],
  [cutoverPath, cutover],
];
const mode = process.argv[2] ?? '--write';
if (mode !== '--write' && mode !== '--check') {
  throw new Error('USAGE: generate-agent-mission-m2a3-values.mjs [--write|--check]');
}
for (const [outputPath, expected] of outputs) {
  if (mode === '--check') {
    const current = await readFile(outputPath, 'utf8').catch(() => null);
    if (current !== expected) {
      throw new Error(
        `AGENT_MISSION_M2A3_GENERATED_SQL_STALE:${path.relative(
          repositoryRoot,
          outputPath,
        )}`,
      );
    }
    continue;
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, expected, 'utf8');
}

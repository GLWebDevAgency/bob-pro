#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const apiDirectory = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(apiDirectory, '..', '..');
const missionSourcePath = path.join(
  repositoryRoot,
  'packages/core/src/domain/agent/agent-mission.ts',
);
const eventSourcePath = path.join(
  repositoryRoot,
  'packages/core/src/domain/agent/agent-mission-event.ts',
);
const workSourcePath = path.join(
  repositoryRoot,
  'packages/core/src/application/agent-missions/quote-line-work.ts',
);
const m2a1ExpandPath = path.join(
  apiDirectory,
  'prisma/migrations/20260730100000_agent_mission_catalogue_choice_expand/migration.sql',
);
const expandPath = path.join(
  apiDirectory,
  'prisma/migrations/20260730110000_agent_mission_line_confirmation_expand/migration.sql',
);
const validatePath = path.join(
  apiDirectory,
  'prisma/migrations/20260730110100_agent_mission_line_confirmation_validate/migration.sql',
);
const cutoverPath = path.join(
  apiDirectory,
  'prisma/migrations/20260730110200_agent_mission_line_confirmation_cutover/migration.sql',
);

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function extractStringConstArray(source, name, stack = new Set()) {
  if (stack.has(name)) {
    throw new Error(`AGENT_MISSION_M2A2_SOURCE_ARRAY_CYCLE:${name}`);
  }
  const match = source.match(
    new RegExp(
      `export const ${escaped(name)}(?:\\s*:[^=]+)?\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const(?:\\s+satisfies\\s+[^;]+)?;`,
      'u',
    ),
  );
  if (match === null) {
    throw new Error(`AGENT_MISSION_M2A2_SOURCE_ARRAY_MISSING:${name}`);
  }
  const nextStack = new Set(stack).add(name);
  const values = match[1]
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/.*$/gmu, '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .flatMap((token) => {
      const literal = token.match(/^'([^']+)'$/u);
      if (literal !== null) return [literal[1]];
      const spread = token.match(/^\.\.\.([A-Z][A-Z0-9_]*)$/u);
      if (spread !== null) {
        return extractStringConstArray(source, spread[1], nextStack);
      }
      throw new Error(
        `AGENT_MISSION_M2A2_SOURCE_ARRAY_TOKEN_INVALID:${name}:${token}`,
      );
    });
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`AGENT_MISSION_M2A2_SOURCE_ARRAY_INVALID:${name}`);
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

function generatedValues(name, values, indent) {
  return [
    `${indent}-- BEGIN GENERATED ${name}`,
    sqlValues(values, indent),
    `${indent}-- END GENERATED ${name}`,
  ].join('\n');
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
  if (replacements === 0) {
    throw new Error(`AGENT_MISSION_M2A2_SQL_REGION_MISSING:${name}`);
  }
  return output;
}

function applyRegions(sql, regions) {
  return regions.reduce(
    (value, region) => (
      value.includes(`-- BEGIN GENERATED ${region.name}`)
        ? replaceGeneratedRegion(value, region.name, region.values)
        : value
    ),
    sql,
  );
}

function extractConstraint(sql, name) {
  const token = `ADD CONSTRAINT ${name} CHECK `;
  const start = sql.indexOf(token);
  if (start === -1) {
    throw new Error(`AGENT_MISSION_M2A2_SQL_CONSTRAINT_MISSING:${name}`);
  }
  const nextConstraint = sql.indexOf(',\n  ADD CONSTRAINT ', start + token.length);
  const nextStatement = sql.indexOf(';\n\n', start + token.length);
  const end = nextConstraint === -1
    ? nextStatement
    : nextStatement === -1
      ? nextConstraint
      : Math.min(nextConstraint, nextStatement);
  if (end === -1) {
    throw new Error(`AGENT_MISSION_M2A2_SQL_CONSTRAINT_BOUNDARY:${name}`);
  }
  return sql
    .slice(start + 'ADD '.length, end)
    .trim()
    .replace(/\s+NOT VALID$/u, '');
}

function renameConstraint(constraint, from, to) {
  const renamed = constraint.replace(
    `CONSTRAINT ${from} CHECK `,
    `CONSTRAINT ${to} CHECK `,
  );
  if (renamed === constraint) {
    throw new Error(`AGENT_MISSION_M2A2_SQL_CONSTRAINT_RENAME:${from}`);
  }
  return renamed;
}

function replaceOnce(value, needle, replacement, code) {
  const index = value.indexOf(needle);
  if (index === -1 || value.indexOf(needle, index + needle.length) !== -1) {
    throw new Error(code);
  }
  return `${value.slice(0, index)}${replacement}${value.slice(index + needle.length)}`;
}

function addConstraints(table, constraints) {
  return [
    `ALTER TABLE public.${table}`,
    constraints.map((constraint, index) => (
      `  ADD ${constraint} NOT VALID${index === constraints.length - 1 ? ';' : ','}`
    )).join('\n'),
  ].join('\n');
}

function assumeOwner(table, label, requireSchemaCreate = false) {
  return [
    `DO $bob_m2a2_${label}_owner$`,
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
    `        MESSAGE = 'AGENT_MISSION_M2A2_${label.toUpperCase()}_OWNER_UNAVAILABLE';`,
    '    END IF;',
    "    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);",
    '  END IF;',
    '',
    '  IF current_user::pg_catalog.regrole <> owner_oid THEN',
    '    RAISE EXCEPTION USING',
    "      ERRCODE = '42501',",
    `      MESSAGE = 'AGENT_MISSION_M2A2_${label.toUpperCase()}_OWNER_NOT_ASSUMED';`,
    '  END IF;',
    ...(requireSchemaCreate
      ? [
          '',
          "  IF NOT pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE') THEN",
          '    RAISE EXCEPTION USING',
          "      ERRCODE = '42501',",
          `      MESSAGE = 'AGENT_MISSION_M2A2_${label.toUpperCase()}_SCHEMA_CREATE_REQUIRED';`,
          '  END IF;',
        ]
      : []),
    'END;',
    `$bob_m2a2_${label}_owner$;`,
  ].join('\n');
}

function revokeFunction(functionName, label) {
  return [
    `REVOKE ALL PRIVILEGES ON FUNCTION public.${functionName}() FROM PUBLIC;`,
    `DO $bob_m2a2_${label}_function_acl$`,
    'DECLARE',
    '  exposed_role TEXT;',
    'BEGIN',
    "  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP",
    '    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = exposed_role) THEN',
    '      EXECUTE pg_catalog.format(',
    "        'REVOKE ALL PRIVILEGES ON FUNCTION public.%I() FROM %I',",
    `        '${functionName}',`,
    '        exposed_role',
    '      );',
    '    END IF;',
    '  END LOOP;',
    'END;',
    `$bob_m2a2_${label}_function_acl$;`,
  ].join('\n');
}

function releaseFlagFence(label) {
  return [
    assumeOwner('release_flags', `${label}_release_flags`),
    '',
    'ALTER TABLE public.release_flags NO FORCE ROW LEVEL SECURITY;',
    '',
    `DO $bob_m2a2_${label}_release_flag_exact$`,
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
    `      MESSAGE = 'AGENT_MISSION_M2A2_${label.toUpperCase()}_FLAG_NOT_EXACTLY_OFF';`,
    '  END IF;',
    'END;',
    `$bob_m2a2_${label}_release_flag_exact$;`,
    '',
    'ALTER TABLE public.release_flags ENABLE ROW LEVEL SECURITY;',
    'ALTER TABLE public.release_flags FORCE ROW LEVEL SECURITY;',
    'RESET ROLE;',
  ].join('\n');
}

function revision(pathExpression) {
  const textExpression = pathExpression.replace(' #> ', ' #>> ');
  return [
    `jsonb_typeof(${pathExpression}) = 'number'`,
    `(${textExpression})::NUMERIC BETWEEN 1 AND 2147483647`,
    `(${textExpression})::NUMERIC = trunc((${textExpression})::NUMERIC)`,
  ].join('\n            AND ');
}

function eventRevision(field) {
  return [
    `jsonb_typeof("data" -> '${field}') = 'number'`,
    `("data" ->> '${field}')::NUMERIC BETWEEN 1 AND 2147483647`,
    `("data" ->> '${field}')::NUMERIC = trunc(("data" ->> '${field}')::NUMERIC)`,
  ].join('\n        AND ');
}

function eventBranch(eventType, keys, checks) {
  return [
    '      OR (',
    `        "eventType" = '${eventType}'`,
    `        AND "data" ->> 'kind' = '${eventType}'`,
    '        AND "data" ?& ARRAY[',
    generatedValues(keys.name, keys.values, '          '),
    '        ]',
    '        AND "data" - ARRAY[',
    generatedValues(keys.name, keys.values, '          '),
    "        ] = '{}'::JSONB",
    ...checks.map((line) => `        AND ${line}`),
    '      )',
  ].join('\n');
}

const [missionSource, eventSource, workSource, m2a1Expand] = await Promise.all([
  readFile(missionSourcePath, 'utf8'),
  readFile(eventSourcePath, 'utf8'),
  readFile(workSourcePath, 'utf8'),
  readFile(m2a1ExpandPath, 'utf8'),
]);

const missionRegionNames = [
  'QUOTE_MISSION_DECISION_KINDS',
  'QUOTE_MISSION_DRAFT_REFERENCE_KEYS',
  'QUOTE_MISSION_DRAFT_DECISION_KEYS',
  'QUOTE_MISSION_CUSTOMER_DECISION_KEYS',
  'QUOTE_MISSION_ACTION_CHOICE_KEYS',
  'QUOTE_MISSION_CUSTOMER_CANDIDATE_KEYS',
  'QUOTE_MISSION_CATALOGUE_DECISION_KEYS',
  'QUOTE_MISSION_CATALOGUE_CANDIDATE_KEYS',
  'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KINDS',
  'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KIND_ONLY_KEYS',
  'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_EXACT_KEYS',
  'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_CHOICES_KEYS',
];
const eventRegionNames = [
  'AGENT_MISSION_EVENT_TYPES',
  'AGENT_MISSION_ACTORS',
  'AGENT_MISSION_USER_ACTORS',
  'AGENT_MISSION_VOICE_ACTORS',
  'AGENT_MISSION_TAP_ACTORS',
  'AGENT_MISSION_SYSTEM_ACTORS',
  'AGENT_MISSION_START_OUTCOMES',
  'AGENT_MISSION_START_NEW_SLOT_OUTCOMES',
  'AGENT_MISSION_START_EXISTING_SLOT_OUTCOMES',
  'AGENT_MISSION_CORRELATION_SYSTEM_EVENT_TYPES',
  'AGENT_MISSION_CORRELATION_SCREEN_ACK_EVENT_TYPES',
  'AGENT_MISSION_SYSTEM_CONTINUATION_EVENT_TYPES',
  'AGENT_MISSION_CORRELATION_USER_EVENT_TYPES',
  'AGENT_MISSION_DRAFT_START_EVENT_TYPES',
  'AGENT_MISSION_DRAFT_NO_OP_EVENT_TYPES',
  'AGENT_MISSION_DRAFT_REPLACE_EVENT_TYPES',
  'AGENT_MISSION_DRAFT_ADVANCE_CUSTOMER_EVENT_TYPES',
  'AGENT_MISSION_KIND_ONLY_EVENT_TYPES',
  'AGENT_MISSION_EVENT_KIND_ONLY_DATA_KEYS',
  'AGENT_MISSION_EVENT_START_DATA_KEYS',
  'AGENT_MISSION_EVENT_NEXT_PHASE_DATA_KEYS',
  'AGENT_MISSION_EVENT_RESULT_DATA_KEYS',
  'AGENT_MISSION_EVENT_STAGED_RESOLUTION_DATA_KEYS',
  'AGENT_MISSION_EVENT_CHOICE_PRESENTED_DATA_KEYS',
  'AGENT_MISSION_EVENT_CUSTOMER_SELECTED_DATA_KEYS',
  'AGENT_MISSION_EVENT_REASON_DATA_KEYS',
  'AGENT_MISSION_EVENT_LINE_STAGED_DATA_KEYS',
  'AGENT_MISSION_EVENT_CATALOGUE_NOT_FOUND_DATA_KEYS',
  'AGENT_MISSION_EVENT_CATALOGUE_PRESENTED_DATA_KEYS',
  'AGENT_MISSION_EVENT_CATALOGUE_SELECTED_DATA_KEYS',
  'AGENT_MISSION_SCREEN_ACK_NEXT_PHASES',
  'AGENT_MISSION_CUSTOMER_NOT_FOUND_RESULTS',
  'AGENT_MISSION_STAGED_CUSTOMER_RESOLUTION_RESULTS',
  'AGENT_MISSION_CUSTOMER_SELECTION_SOURCES',
  'AGENT_MISSION_DECISION_INVALIDATION_REASONS',
  'AGENT_MISSION_CANCELLATION_REASONS',
  'AGENT_MISSION_EXPIRY_REASONS',
];
const missionRegions = missionRegionNames.map((name) => ({
  name,
  values: extractStringConstArray(missionSource, name),
}));
const eventRegions = eventRegionNames.map((name) => ({
  name,
  values: extractStringConstArray(eventSource, name),
}));
const phases = extractStringConstArray(
  missionSource,
  'QUOTE_CREATION_MISSION_PHASES',
);
const lineDecisionKeys = extractStringConstArray(
  missionSource,
  'QUOTE_MISSION_LINE_CONFIRMATION_DECISION_KEYS',
);
const draftKeys = extractStringConstArray(
  missionSource,
  'QUOTE_MISSION_DRAFT_REFERENCE_KEYS',
);
const expectedCatalogueKeys = extractStringConstArray(
  missionSource,
  'QUOTE_MISSION_EXPECTED_CATALOGUE_KEYS',
);
const actionChoiceKeys = extractStringConstArray(
  missionSource,
  'QUOTE_MISSION_ACTION_CHOICE_KEYS',
);
const lineActions = extractStringConstArray(
  missionSource,
  'QUOTE_MISSION_LINE_CONFIRMATION_ACTIONS',
);
const requiredFacts = extractStringConstArray(
  eventSource,
  'AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS',
);
const m2aEventTypes = extractStringConstArray(
  eventSource,
  'AGENT_MISSION_M2A_EVENT_TYPES',
);
const allEventTypes = extractStringConstArray(
  eventSource,
  'AGENT_MISSION_EVENT_TYPES',
);
if (m2aEventTypes.some((eventType) => !allEventTypes.includes(eventType))) {
  throw new Error('AGENT_MISSION_M2A2_EVENT_PARTITION_DRIFT');
}

const uuidCheck =
  "~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'";
const decisionPath = `"payload" -> 'decision'`;
const expectedDraftPath = `"payload" #> '{decision,expectedDraft}'`;
const stagedCustomerResolutionForbiddenPhases = extractStringConstArray(
  missionSource,
  'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_FORBIDDEN_PHASES',
);
const lineDecisionBranch = [
  '          OR (',
  '            "protocolVersion" = 2',
  "            AND \"payload\" -> 'decision' ->> 'kind' = 'line_confirmation'",
  '            AND "payload" -> \'decision\' ?& ARRAY[',
  generatedValues(
    'QUOTE_MISSION_LINE_CONFIRMATION_DECISION_KEYS',
    lineDecisionKeys,
    '              ',
  ),
  '            ]',
  '            AND ("payload" -> \'decision\') - ARRAY[',
  generatedValues(
    'QUOTE_MISSION_LINE_CONFIRMATION_DECISION_KEYS',
    lineDecisionKeys,
    '              ',
  ),
  "            ] = '{}'::JSONB",
  `            AND "payload" #>> '{decision,decisionId}' ${uuidCheck}`,
  `            AND "payload" #>> '{decision,pendingLineId}' ${uuidCheck}`,
  `            AND "payload" #>> '{decision,proposalId}' ${uuidCheck}`,
  `            AND ${revision(`"payload" #> '{decision,choiceSetRevision}'`)}`,
  '            AND ("payload" #>> \'{decision,choiceSetRevision}\')::NUMERIC',
  '              <= "revision"',
  `            AND ${revision(`"payload" #> '{decision,expectedWorkRevision}'`)}`,
  "            AND jsonb_typeof(\"payload\" #> '{decision,proposalRevision}') = 'number'",
  "            AND \"payload\" #>> '{decision,proposalRevision}' = '1'",
  `            AND (${expectedDraftPath}) ?& ARRAY[`,
  generatedValues('QUOTE_MISSION_DRAFT_REFERENCE_KEYS', draftKeys, '              '),
  '            ]',
  `            AND (${expectedDraftPath}) - ARRAY[`,
  generatedValues('QUOTE_MISSION_DRAFT_REFERENCE_KEYS', draftKeys, '              '),
  "            ] = '{}'::JSONB",
  `            AND ${expectedDraftPath} = "payload" -> 'draft'`,
  "            AND (",
  "              \"payload\" #> '{decision,expectedCatalogue}' = 'null'::JSONB",
  '              OR (',
  "                jsonb_typeof(\"payload\" #> '{decision,expectedCatalogue}') = 'object'",
  "                AND (\"payload\" #> '{decision,expectedCatalogue}') ?& ARRAY[",
  generatedValues(
    'QUOTE_MISSION_EXPECTED_CATALOGUE_KEYS',
    expectedCatalogueKeys,
    '                  ',
  ),
  '                ]',
  "                AND (\"payload\" #> '{decision,expectedCatalogue}') - ARRAY[",
  generatedValues(
    'QUOTE_MISSION_EXPECTED_CATALOGUE_KEYS',
    expectedCatalogueKeys,
    '                  ',
  ),
  "                ] = '{}'::JSONB",
  "                AND jsonb_typeof(\"payload\" #> '{decision,expectedCatalogue,itemId}')",
  "                  = 'string'",
  "                AND \"payload\" #>> '{decision,expectedCatalogue,itemId}'",
  "                  ~ '^[A-Za-z0-9-]{1,128}$'",
  `                AND ${revision(`"payload" #> '{decision,expectedCatalogue,revision}'`)}`,
  '              )',
  '            )',
  "            AND jsonb_typeof(\"payload\" #> '{decision,expectedVatContextDigest}')",
  "              = 'string'",
  "            AND \"payload\" #>> '{decision,expectedVatContextDigest}'",
  "              ~ '^[a-f0-9]{64}$'",
  "            AND jsonb_typeof(\"payload\" #> '{decision,diffHash}') = 'string'",
  "            AND \"payload\" #>> '{decision,diffHash}' ~ '^[a-f0-9]{64}$'",
  "            AND \"payload\" #>> '{decision,choiceSetHash}' ~ '^[a-f0-9]{64}$'",
  "            AND jsonb_typeof(\"payload\" #> '{decision,choices}') = 'array'",
  "            AND jsonb_array_length(\"payload\" #> '{decision,choices}') = 3",
  ...lineActions.flatMap((action, index) => [
    `            AND jsonb_typeof("payload" #> '{decision,choices,${index}}') = 'object'`,
    `            AND ("payload" #> '{decision,choices,${index}}') ?& ARRAY[`,
    generatedValues(
      'QUOTE_MISSION_ACTION_CHOICE_KEYS',
      actionChoiceKeys,
      '              ',
    ),
    '            ]',
    `            AND ("payload" #> '{decision,choices,${index}}') - ARRAY[`,
    generatedValues(
      'QUOTE_MISSION_ACTION_CHOICE_KEYS',
      actionChoiceKeys,
      '              ',
    ),
    "            ] = '{}'::JSONB",
    `            AND "payload" #>> '{decision,choices,${index},choiceId}' ${uuidCheck}`,
    `            AND "payload" #>> '{decision,choices,${index},action}' = '${action}'`,
  ]),
  "            AND \"payload\" #>> '{decision,choices,0,choiceId}'",
  "              <> \"payload\" #>> '{decision,choices,1,choiceId}'",
  "            AND \"payload\" #>> '{decision,choices,0,choiceId}'",
  "              <> \"payload\" #>> '{decision,choices,2,choiceId}'",
  "            AND \"payload\" #>> '{decision,choices,1,choiceId}'",
  "              <> \"payload\" #>> '{decision,choices,2,choiceId}'",
  '          )',
].join('\n');

let missionClosedShape = applyRegions(
  renameConstraint(
    extractConstraint(
      m2a1Expand,
      'agent_missions_payload_closed_shape_m2a1_check',
    ),
    'agent_missions_payload_closed_shape_m2a1_check',
    'agent_missions_payload_closed_shape_m2a2_check',
  ),
  missionRegions,
);
missionClosedShape = replaceOnce(
  missionClosedShape,
  [
    '            -- END GENERATED M2A1_QUOTE_MISSION_CATALOGUE_CANDIDATE_CHECKS',
    '          )',
    '        )',
  ].join('\n'),
  [
    '            -- END GENERATED M2A1_QUOTE_MISSION_CATALOGUE_CANDIDATE_CHECKS',
    '          )',
    lineDecisionBranch,
    '        )',
  ].join('\n'),
  'AGENT_MISSION_M2A2_LINE_DECISION_INJECTION_FAILED',
);

let missionPhasePayload = applyRegions(
  renameConstraint(
    extractConstraint(m2a1Expand, 'agent_missions_phase_payload_m2a1_check'),
    'agent_missions_phase_payload_m2a1_check',
    'agent_missions_phase_payload_m2a2_check',
  ),
  [...missionRegions, ...eventRegions],
);
const cataloguePhaseBranch = [
  '    OR (',
  '      "protocolVersion" = 2',
  "      AND \"phase\" = 'awaiting_catalogue_choice'",
  "      AND jsonb_typeof(\"payload\" -> 'draft') = 'object'",
  "      AND \"payload\" -> 'decision' ->> 'kind' = 'catalogue'",
  "      AND jsonb_typeof(\"currentBinding\") = 'object'",
  '    )',
].join('\n');
missionPhasePayload = replaceOnce(
  missionPhasePayload,
  cataloguePhaseBranch,
  [
    cataloguePhaseBranch,
    '    OR (',
    '      "protocolVersion" = 2',
    "      AND \"phase\" = 'awaiting_line_details'",
    "      AND jsonb_typeof(\"payload\" -> 'draft') = 'object'",
    "      AND \"payload\" -> 'decision' = 'null'::JSONB",
    "      AND jsonb_typeof(\"currentBinding\") = 'object'",
    '    )',
    '    OR (',
    '      "protocolVersion" = 2',
    "      AND \"phase\" = 'awaiting_line_confirmation'",
    "      AND jsonb_typeof(\"payload\" -> 'draft') = 'object'",
    "      AND \"payload\" -> 'decision' ->> 'kind' = 'line_confirmation'",
    "      AND jsonb_typeof(\"currentBinding\") = 'object'",
    '    )',
  ].join('\n'),
  'AGENT_MISSION_M2A2_PHASE_INJECTION_FAILED',
);
missionPhasePayload = replaceOnce(
  missionPhasePayload,
  "    OR \"phase\" NOT IN ('awaiting_customer_choice', 'awaiting_lines')",
  [
    '    OR "phase" NOT IN (',
    generatedValues(
      'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_FORBIDDEN_PHASES',
      stagedCustomerResolutionForbiddenPhases,
      '      ',
    ),
    '    )',
  ].join('\n'),
  'AGENT_MISSION_M2A2_STAGED_CUSTOMER_PHASES_INJECTION_FAILED',
);

const missionPhaseConstraint = [
  'CONSTRAINT agent_missions_phase_m2a2_check CHECK (',
  '  "phase" IN (',
  generatedValues('QUOTE_CREATION_MISSION_PHASES', phases, '    '),
  '  )',
  '  AND (',
  '    "protocolVersion" = 2',
  '    OR "phase" NOT IN (',
  "      'awaiting_catalogue_choice',",
  "      'awaiting_line_details',",
  "      'awaiting_line_confirmation'",
  '    )',
  '  )',
  ')',
].join('\n');

const baseEventConstraints = {
  type: 'agent_mission_events_type_m2a1_check',
  envelope: 'agent_mission_events_envelope_m2a1_check',
  data: 'agent_mission_events_data_m2a1_check',
  correlation: 'agent_mission_events_correlation_m2a1_check',
  draft: 'agent_mission_events_draft_effect_m2a1_check',
};
function nextEventConstraint(key, nextName) {
  return applyRegions(
    renameConstraint(
      extractConstraint(m2a1Expand, baseEventConstraints[key]),
      baseEventConstraints[key],
      nextName,
    ),
    eventRegions,
  );
}
const eventTypeConstraint = nextEventConstraint(
  'type',
  'agent_mission_events_type_m2a2_check',
);
const eventEnvelopeConstraint = nextEventConstraint(
  'envelope',
  'agent_mission_events_envelope_m2a2_check',
);
let eventDataConstraint = nextEventConstraint(
  'data',
  'agent_mission_events_data_m2a2_check',
);
const eventKey = (name) => ({
  name,
  values: extractStringConstArray(eventSource, name),
});
const lineEventBranches = [
  eventBranch(
    'line_fact_patched',
    eventKey('AGENT_MISSION_EVENT_LINE_FACT_PATCHED_DATA_KEYS'),
    [
      `"data" ->> 'pendingLineId' ${uuidCheck}`,
      `"data" ->> 'field' IN (\n${generatedValues(
        'AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS',
        requiredFacts,
        '          ',
      )}\n        )`,
      eventRevision('workRevisionAfter'),
    ],
  ),
  eventBranch(
    'line_details_requested',
    eventKey('AGENT_MISSION_EVENT_LINE_DETAILS_REQUESTED_DATA_KEYS'),
    [
      `"data" ->> 'pendingLineId' ${uuidCheck}`,
      `(\n          "data" -> 'requiredFact' = 'null'::JSONB\n          OR "data" ->> 'requiredFact' IN (\n${generatedValues(
        'AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS',
        requiredFacts,
        '            ',
      )}\n          )\n        )`,
      eventRevision('workRevisionAfter'),
    ],
  ),
  eventBranch(
    'line_proposal_presented',
    eventKey('AGENT_MISSION_EVENT_LINE_PROPOSAL_PRESENTED_DATA_KEYS'),
    [
      `"data" ->> 'pendingLineId' ${uuidCheck}`,
      `"data" ->> 'proposalId' ${uuidCheck}`,
      `jsonb_typeof("data" -> 'proposalRevision') = 'number'`,
      `"data" ->> 'proposalRevision' = '1'`,
      eventRevision('expectedWorkRevision'),
      `jsonb_typeof("data" -> 'diffHash') = 'string'`,
      `"data" ->> 'diffHash' ~ '^[a-f0-9]{64}$'`,
      `jsonb_typeof("data" -> 'choiceSetHash') = 'string'`,
      `"data" ->> 'choiceSetHash' ~ '^[a-f0-9]{64}$'`,
    ],
  ),
  eventBranch(
    'line_proposal_rejected',
    eventKey('AGENT_MISSION_EVENT_LINE_PROPOSAL_REJECTED_DATA_KEYS'),
    [
      `"data" ->> 'pendingLineId' ${uuidCheck}`,
      `"data" ->> 'proposalId' ${uuidCheck}`,
      eventRevision('workRevisionAfter'),
      `"data" ->> 'choiceId' ${uuidCheck}`,
      `jsonb_typeof("data" -> 'choiceSetHash') = 'string'`,
      `"data" ->> 'choiceSetHash' ~ '^[a-f0-9]{64}$'`,
    ],
  ),
  eventBranch(
    'line_confirmed',
    eventKey('AGENT_MISSION_EVENT_LINE_CONFIRMED_DATA_KEYS'),
    [
      `"data" ->> 'pendingLineId' ${uuidCheck}`,
      `"data" ->> 'proposalId' ${uuidCheck}`,
      `jsonb_typeof("data" -> 'proposalRevision') = 'number'`,
      `"data" ->> 'proposalRevision' = '1'`,
      eventRevision('expectedWorkRevision'),
      `"data" ->> 'choiceId' ${uuidCheck}`,
      `jsonb_typeof("data" -> 'choiceSetHash') = 'string'`,
      `"data" ->> 'choiceSetHash' ~ '^[a-f0-9]{64}$'`,
      `jsonb_typeof("data" -> 'diffHash') = 'string'`,
      `"data" ->> 'diffHash' ~ '^[a-f0-9]{64}$'`,
    ],
  ),
  eventBranch(
    'line_cancelled',
    eventKey('AGENT_MISSION_EVENT_LINE_CANCELLED_DATA_KEYS'),
    [
      `"data" ->> 'pendingLineId' ${uuidCheck}`,
      eventRevision('expectedWorkRevision'),
      `"data" ->> 'choiceId' ${uuidCheck}`,
      `jsonb_typeof("data" -> 'choiceSetHash') = 'string'`,
      `"data" ->> 'choiceSetHash' ~ '^[a-f0-9]{64}$'`,
    ],
  ),
].join('\n');
eventDataConstraint = replaceOnce(
  eventDataConstraint,
  [
    '      OR (',
    "        \"eventType\" = 'mission_cancelled'",
  ].join('\n'),
  [
    lineEventBranches,
    '      OR (',
    "        \"eventType\" = 'mission_cancelled'",
  ].join('\n'),
  'AGENT_MISSION_M2A2_EVENT_DATA_INJECTION_FAILED',
);
const eventCorrelationConstraint = nextEventConstraint(
  'correlation',
  'agent_mission_events_correlation_m2a2_check',
);
let eventDraftConstraint = nextEventConstraint(
  'draft',
  'agent_mission_events_draft_effect_m2a2_check',
);
const customerAdvanceBranch = [
  '    OR (',
  '      "eventType" IN (',
  generatedValues(
    'AGENT_MISSION_DRAFT_ADVANCE_CUSTOMER_EVENT_TYPES',
    extractStringConstArray(
      eventSource,
      'AGENT_MISSION_DRAFT_ADVANCE_CUSTOMER_EVENT_TYPES',
    ),
    '        ',
  ),
  '      )',
  '      AND "draftSlotRevisionBefore" BETWEEN 1 AND 2147483646',
  '      AND "draftSlotRevisionAfter" = "draftSlotRevisionBefore" + 1',
  '      AND "draftContentRevisionBefore" BETWEEN 0 AND 2147483646',
  '      AND "draftContentRevisionAfter" = "draftContentRevisionBefore" + 1',
  '    )',
].join('\n');
eventDraftConstraint = replaceOnce(
  eventDraftConstraint,
  customerAdvanceBranch,
  [
    customerAdvanceBranch,
    '    OR (',
    '      "eventType" IN (',
    generatedValues(
      'AGENT_MISSION_DRAFT_ADVANCE_LINE_EVENT_TYPES',
      extractStringConstArray(
        eventSource,
        'AGENT_MISSION_DRAFT_ADVANCE_LINE_EVENT_TYPES',
      ),
      '        ',
    ),
    '      )',
    '      AND "draftSlotRevisionBefore" BETWEEN 1 AND 2147483646',
    '      AND "draftSlotRevisionAfter" = "draftSlotRevisionBefore" + 1',
    '      AND "draftContentRevisionBefore" BETWEEN 0 AND 2147483646',
    '      AND "draftContentRevisionAfter" = "draftContentRevisionBefore" + 1',
    '    )',
  ].join('\n'),
  'AGENT_MISSION_M2A2_DRAFT_EFFECT_INJECTION_FAILED',
);

const workStateConstraint = [
  'CONSTRAINT agent_mission_quote_line_work_state_coherence_m2a2_check CHECK ((',
  '  (("catalogueResolution" = \'selected\')',
  '    = ("catalogueItemId" IS NOT NULL AND "expectedCatalogueRevision" IS NOT NULL))',
  '  AND ("catalogueResolution" = \'selected\'',
  '    OR ("catalogueItemId" IS NULL AND "expectedCatalogueRevision" IS NULL))',
  '  AND (("unitPriceCents" IS NULL) = ("priceBasis" IS NULL))',
  '  AND (',
  '    ("proposalId" IS NULL AND "proposalRevision" IS NULL AND "proposalDiffHash" IS NULL)',
  '    OR ("proposalId" IS NOT NULL AND "proposalRevision" IS NOT NULL',
  '      AND "proposalDiffHash" IS NOT NULL)',
  '  )',
  '  AND (',
  '    ("state" = \'queued\' AND "requiredFact" IS NULL',
  '      AND "proposalId" IS NULL)',
  '    OR ("state" = \'awaiting_catalogue_choice\'',
  '      AND "serviceReference" IS NOT NULL',
  '      AND "requiredFact" IS NULL',
  '      AND "catalogueResolution" = \'pending\'',
  '      AND "catalogueItemId" IS NULL',
  '      AND "expectedCatalogueRevision" IS NULL',
  '      AND "proposalId" IS NULL)',
  '    OR ("state" = \'awaiting_details\'',
  '      AND (',
  '        ("requiredFact" IS NULL AND "catalogueResolution" <> \'pending\')',
  '        OR ("requiredFact" IS NOT NULL AND (',
  '          "catalogueResolution" <> \'pending\'',
  '          OR "requiredFact" = \'service_reference\'',
  '        ))',
  '      )',
  '      AND "proposalId" IS NULL)',
  '    OR ("state" = \'awaiting_confirmation\'',
  '      AND "serviceReference" IS NOT NULL',
  '      AND "category" IS NOT NULL',
  '      AND "quantityMilli" IS NOT NULL',
  '      AND "unit" IS NOT NULL',
  '      AND "unitPriceCents" IS NOT NULL',
  '      AND "requestedVatRate" IS NOT NULL',
  '      AND "priceBasis" = \'per_unit\'',
  '      AND "requiredFact" IS NULL',
  '      AND "catalogueResolution" <> \'pending\'',
  '      AND "proposalId" IS NOT NULL)',
  '  )',
  ') IS TRUE)',
].join('\n');
const workOverrideConstraint = [
  'CONSTRAINT agent_mission_quote_line_work_catalogue_override_m2a2_check CHECK ((',
  '  (',
  '    "catalogueResolution" = \'selected\'',
  '    OR (',
  '      NOT "catalogueCategoryOverrideConfirmed"',
  '      AND NOT "catalogueUnitOverrideConfirmed"',
  '    )',
  '  )',
  '  AND (NOT "catalogueCategoryOverrideConfirmed" OR "category" IS NOT NULL)',
  '  AND (NOT "catalogueUnitOverrideConfirmed" OR "unit" IS NOT NULL)',
  ') IS TRUE)',
].join('\n');

const eventGuard = [
  'CREATE FUNCTION public.guard_agent_mission_event_append_v3()',
  'RETURNS TRIGGER',
  'LANGUAGE plpgsql',
  'SET search_path = pg_catalog, public',
  'AS $agent_mission_event_append_v3$',
  'DECLARE',
  '  current_mission_revision INTEGER;',
  '  current_mission_protocol SMALLINT;',
  '  current_mission_updated_at TIMESTAMPTZ;',
  'BEGIN',
  '  SELECT mission."revision", mission."protocolVersion", mission."updatedAt"',
  '    INTO current_mission_revision, current_mission_protocol, current_mission_updated_at',
  '    FROM public.agent_missions AS mission',
  '   WHERE mission."id" = NEW."missionId"',
  '     AND mission."companyId" = NEW."companyId"',
  '     AND mission."ownerUserId" = NEW."ownerUserId";',
  '  IF NOT FOUND THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_EVENT_MISSION_NOT_VISIBLE'",
  "      USING ERRCODE = '23503';",
  '  END IF;',
  '  IF NEW."eventType" IN (',
  generatedValues('AGENT_MISSION_M2A_EVENT_TYPES', m2aEventTypes, '    '),
  '  ) AND current_mission_protocol <> 2 THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_M2A_EVENT_PROTOCOL_REQUIRED'",
  "      USING ERRCODE = '23514';",
  '  END IF;',
  '  IF current_mission_revision <> NEW."missionRevisionAfter"',
  '     OR current_mission_updated_at <> NEW."occurredAt" THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_EVENT_REVISION_MISMATCH'",
  "      USING ERRCODE = '23514';",
  '  END IF;',
  '  IF NEW."missionRevisionAfter" = 1 THEN',
  '    IF EXISTS (',
  '      SELECT 1 FROM public.agent_mission_events AS previous',
  '       WHERE previous."missionId" = NEW."missionId"',
  '    ) THEN',
  "      RAISE EXCEPTION 'AGENT_MISSION_EVENT_PREDECESSOR_INVALID'",
  "        USING ERRCODE = '23514';",
  '    END IF;',
  '  ELSIF NOT EXISTS (',
  '    SELECT 1 FROM public.agent_mission_events AS previous',
  '     WHERE previous."missionId" = NEW."missionId"',
  '       AND previous."sequence" = NEW."missionRevisionBefore"',
  '       AND previous."missionRevisionAfter" = NEW."missionRevisionBefore"',
  '  ) THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_EVENT_PREDECESSOR_MISSING'",
  "      USING ERRCODE = '23514';",
  '  END IF;',
  '  RETURN NEW;',
  'END;',
  '$agent_mission_event_append_v3$;',
].join('\n');

const workGuard = [
  'CREATE FUNCTION public.guard_agent_mission_quote_line_work_v3()',
  'RETURNS TRIGGER',
  'LANGUAGE plpgsql',
  'SET search_path = pg_catalog, public',
  'AS $agent_mission_quote_line_work_v3$',
  'DECLARE',
  '  row_value public.agent_mission_quote_line_work;',
  '  parent_protocol SMALLINT;',
  '  expected_mission_id TEXT :=',
  "    nullif(current_setting('app.current_agent_mission_id', true), '');",
  'BEGIN',
  "  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;",
  "  row_value := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;",
  '  IF expected_mission_id IS NULL',
  '     OR expected_mission_id <> row_value."missionId"::TEXT THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_CAPABILITY_REQUIRED'",
  "      USING ERRCODE = '42501';",
  '  END IF;',
  "  IF TG_OP = 'UPDATE' AND (",
  '    OLD."id" IS DISTINCT FROM NEW."id"',
  '    OR OLD."companyId" IS DISTINCT FROM NEW."companyId"',
  '    OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"',
  '    OR OLD."missionId" IS DISTINCT FROM NEW."missionId"',
  '    OR OLD."ordinal" IS DISTINCT FROM NEW."ordinal"',
  '    OR OLD."origin" IS DISTINCT FROM NEW."origin"',
  '    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"',
  '    OR NEW."revision" <> OLD."revision" + 1',
  '  ) THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_IDENTITY_OR_REVISION_INVALID'",
  "      USING ERRCODE = '23514';",
  '  END IF;',
  "  IF TG_OP = 'UPDATE'",
  '     AND OLD."serviceReference" IS DISTINCT FROM NEW."serviceReference"',
  '     AND (',
  "       NEW.\"catalogueResolution\" <> 'pending'",
  '       OR NEW."catalogueItemId" IS NOT NULL',
  '       OR NEW."expectedCatalogueRevision" IS NOT NULL',
  '       OR NEW."catalogueCategoryOverrideConfirmed"',
  '       OR NEW."catalogueUnitOverrideConfirmed"',
  '       OR NEW."proposalId" IS NOT NULL',
  '     ) THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_REFERENCE_RESET_REQUIRED'",
  "      USING ERRCODE = '23514';",
  '  END IF;',
  "  IF TG_OP = 'UPDATE'",
  '     AND (',
  '       OLD."catalogueResolution" IS DISTINCT FROM NEW."catalogueResolution"',
  '       OR OLD."catalogueItemId" IS DISTINCT FROM NEW."catalogueItemId"',
  '       OR OLD."expectedCatalogueRevision" IS DISTINCT FROM NEW."expectedCatalogueRevision"',
  '     )',
  '     AND (',
  '       NEW."catalogueCategoryOverrideConfirmed"',
  '       OR NEW."catalogueUnitOverrideConfirmed"',
  '       OR NEW."proposalId" IS NOT NULL',
  '     ) THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_CATALOGUE_RESET_REQUIRED'",
  "      USING ERRCODE = '23514';",
  '  END IF;',
  "  IF TG_OP = 'UPDATE'",
  '     AND OLD."proposalId" IS NOT NULL',
  '     AND OLD."proposalId" IS NOT DISTINCT FROM NEW."proposalId"',
  '     AND (',
  '       OLD."serviceReference" IS DISTINCT FROM NEW."serviceReference"',
  '       OR OLD."category" IS DISTINCT FROM NEW."category"',
  '       OR OLD."quantityMilli" IS DISTINCT FROM NEW."quantityMilli"',
  '       OR OLD."unit" IS DISTINCT FROM NEW."unit"',
  '       OR OLD."unitPriceCents" IS DISTINCT FROM NEW."unitPriceCents"',
  '       OR OLD."requestedVatRate" IS DISTINCT FROM NEW."requestedVatRate"',
  '       OR OLD."priceBasis" IS DISTINCT FROM NEW."priceBasis"',
  '       OR OLD."housingOlderThan2y" IS DISTINCT FROM NEW."housingOlderThan2y"',
  '       OR OLD."energyRenovation" IS DISTINCT FROM NEW."energyRenovation"',
  '       OR OLD."catalogueItemId" IS DISTINCT FROM NEW."catalogueItemId"',
  '       OR OLD."expectedCatalogueRevision" IS DISTINCT FROM NEW."expectedCatalogueRevision"',
  '       OR OLD."catalogueCategoryOverrideConfirmed"',
  '          IS DISTINCT FROM NEW."catalogueCategoryOverrideConfirmed"',
  '       OR OLD."catalogueUnitOverrideConfirmed"',
  '          IS DISTINCT FROM NEW."catalogueUnitOverrideConfirmed"',
  '       OR OLD."proposalRevision" IS DISTINCT FROM NEW."proposalRevision"',
  '       OR OLD."proposalDiffHash" IS DISTINCT FROM NEW."proposalDiffHash"',
  '     ) THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_PROPOSAL_RESET_REQUIRED'",
  "      USING ERRCODE = '23514';",
  '  END IF;',
  '  SELECT mission."protocolVersion" INTO parent_protocol',
  '    FROM public.agent_missions AS mission',
  '   WHERE mission."id" = row_value."missionId"',
  '     AND mission."companyId" = row_value."companyId"',
  '     AND mission."ownerUserId" = row_value."ownerUserId"',
  "     AND mission.\"kind\" = 'quote_creation'",
  "     AND mission.\"status\" = 'active';",
  '  IF NOT FOUND OR parent_protocol <> 2 THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_ACTIVE_M2A_PARENT_REQUIRED'",
  "      USING ERRCODE = '23503';",
  '  END IF;',
  "  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;",
  'END;',
  '$agent_mission_quote_line_work_v3$;',
].join('\n');

const expandMigration = [
  '-- Bob AgentMission M2-A-2 — détails et confirmation de ligne, expand writer N-1.',
  '-- Le flag bob.agent_missions.quote.m2a doit rester exactement OFF.',
  '',
  'BEGIN;',
  "SET LOCAL lock_timeout = '5s';",
  "SET LOCAL statement_timeout = '120s';",
  '',
  releaseFlagFence('expand'),
  '',
  assumeOwner('agent_missions', 'missions'),
  '',
  addConstraints('agent_missions', [
    missionPhaseConstraint,
    missionClosedShape,
    missionPhasePayload,
  ]),
  'RESET ROLE;',
  '',
  assumeOwner('agent_mission_events', 'events', true),
  '',
  addConstraints('agent_mission_events', [
    eventTypeConstraint,
    eventEnvelopeConstraint,
    eventDataConstraint,
    eventCorrelationConstraint,
    eventDraftConstraint,
  ]),
  '',
  eventGuard,
  'DROP TRIGGER agent_mission_events_append_guard_v2 ON public.agent_mission_events;',
  'CREATE TRIGGER agent_mission_events_append_guard_v3',
  'BEFORE INSERT ON public.agent_mission_events',
  'FOR EACH ROW EXECUTE FUNCTION public.guard_agent_mission_event_append_v3();',
  revokeFunction('guard_agent_mission_event_append_v3', 'events'),
  'RESET ROLE;',
  '',
  assumeOwner('agent_mission_quote_line_work', 'line_work', true),
  '',
  'ALTER TABLE public.agent_mission_quote_line_work',
  '  ADD COLUMN "catalogueCategoryOverrideConfirmed" BOOLEAN NOT NULL DEFAULT false,',
  '  ADD COLUMN "catalogueUnitOverrideConfirmed" BOOLEAN NOT NULL DEFAULT false;',
  '',
  addConstraints('agent_mission_quote_line_work', [
    workStateConstraint,
    workOverrideConstraint,
  ]),
  '',
  workGuard,
  'DROP TRIGGER agent_mission_quote_line_work_guard_v2',
  '  ON public.agent_mission_quote_line_work;',
  'CREATE TRIGGER agent_mission_quote_line_work_guard_v3',
  'BEFORE INSERT OR UPDATE OR DELETE ON public.agent_mission_quote_line_work',
  'FOR EACH ROW EXECUTE FUNCTION public.guard_agent_mission_quote_line_work_v3();',
  revokeFunction('guard_agent_mission_quote_line_work_v3', 'line_work'),
  'RESET ROLE;',
  '',
  'COMMIT;',
  '',
].join('\n');

const validateMigration = [
  '-- Bob AgentMission M2-A-2 — validation séparée, sans cutover.',
  '',
  'BEGIN;',
  "SET LOCAL lock_timeout = '5s';",
  "SET LOCAL statement_timeout = '5min';",
  '',
  assumeOwner('agent_missions', 'validate_missions'),
  'ALTER TABLE public.agent_missions',
  '  VALIDATE CONSTRAINT agent_missions_phase_m2a2_check;',
  'ALTER TABLE public.agent_missions',
  '  VALIDATE CONSTRAINT agent_missions_payload_closed_shape_m2a2_check;',
  'ALTER TABLE public.agent_missions',
  '  VALIDATE CONSTRAINT agent_missions_phase_payload_m2a2_check;',
  'RESET ROLE;',
  '',
  assumeOwner('agent_mission_events', 'validate_events'),
  'ALTER TABLE public.agent_mission_events',
  '  VALIDATE CONSTRAINT agent_mission_events_type_m2a2_check;',
  'ALTER TABLE public.agent_mission_events',
  '  VALIDATE CONSTRAINT agent_mission_events_envelope_m2a2_check;',
  'ALTER TABLE public.agent_mission_events',
  '  VALIDATE CONSTRAINT agent_mission_events_data_m2a2_check;',
  'ALTER TABLE public.agent_mission_events',
  '  VALIDATE CONSTRAINT agent_mission_events_correlation_m2a2_check;',
  'ALTER TABLE public.agent_mission_events',
  '  VALIDATE CONSTRAINT agent_mission_events_draft_effect_m2a2_check;',
  'RESET ROLE;',
  '',
  assumeOwner('agent_mission_quote_line_work', 'validate_line_work'),
  'ALTER TABLE public.agent_mission_quote_line_work',
  '  VALIDATE CONSTRAINT agent_mission_quote_line_work_state_coherence_m2a2_check;',
  'ALTER TABLE public.agent_mission_quote_line_work',
  '  VALIDATE CONSTRAINT agent_mission_quote_line_work_catalogue_override_m2a2_check;',
  'RESET ROLE;',
  '',
  'COMMIT;',
  '',
].join('\n');

const cutoverMigration = [
  '-- Bob AgentMission M2-A-2 — cutover atomique après validation et writers N-1.',
  '-- Le flag M2-A reste OFF ; cette migration n’active aucun compte.',
  '',
  'BEGIN;',
  "SET LOCAL lock_timeout = '5s';",
  "SET LOCAL statement_timeout = '120s';",
  '',
  releaseFlagFence('cutover'),
  '',
  assumeOwner('agent_missions', 'cutover_missions'),
  'ALTER TABLE public.agent_missions',
  '  DROP CONSTRAINT agent_missions_phase_check,',
  '  DROP CONSTRAINT agent_missions_payload_closed_shape_check,',
  '  DROP CONSTRAINT agent_missions_phase_payload_check;',
  'ALTER TABLE public.agent_missions',
  '  RENAME CONSTRAINT agent_missions_phase_m2a2_check',
  '    TO agent_missions_phase_check;',
  'ALTER TABLE public.agent_missions',
  '  RENAME CONSTRAINT agent_missions_payload_closed_shape_m2a2_check',
  '    TO agent_missions_payload_closed_shape_check;',
  'ALTER TABLE public.agent_missions',
  '  RENAME CONSTRAINT agent_missions_phase_payload_m2a2_check',
  '    TO agent_missions_phase_payload_check;',
  'RESET ROLE;',
  '',
  assumeOwner('agent_mission_events', 'cutover_events'),
  'ALTER TABLE public.agent_mission_events',
  '  DROP CONSTRAINT agent_mission_events_type_check,',
  '  DROP CONSTRAINT agent_mission_events_envelope_check,',
  '  DROP CONSTRAINT agent_mission_events_data_check,',
  '  DROP CONSTRAINT agent_mission_events_correlation_check,',
  '  DROP CONSTRAINT agent_mission_events_draft_effect_check;',
  'ALTER TABLE public.agent_mission_events',
  '  RENAME CONSTRAINT agent_mission_events_type_m2a2_check',
  '    TO agent_mission_events_type_check;',
  'ALTER TABLE public.agent_mission_events',
  '  RENAME CONSTRAINT agent_mission_events_envelope_m2a2_check',
  '    TO agent_mission_events_envelope_check;',
  'ALTER TABLE public.agent_mission_events',
  '  RENAME CONSTRAINT agent_mission_events_data_m2a2_check',
  '    TO agent_mission_events_data_check;',
  'ALTER TABLE public.agent_mission_events',
  '  RENAME CONSTRAINT agent_mission_events_correlation_m2a2_check',
  '    TO agent_mission_events_correlation_check;',
  'ALTER TABLE public.agent_mission_events',
  '  RENAME CONSTRAINT agent_mission_events_draft_effect_m2a2_check',
  '    TO agent_mission_events_draft_effect_check;',
  'DROP FUNCTION public.guard_agent_mission_event_append_v2();',
  'RESET ROLE;',
  '',
  assumeOwner('agent_mission_quote_line_work', 'cutover_line_work'),
  'ALTER TABLE public.agent_mission_quote_line_work',
  '  DROP CONSTRAINT agent_mission_quote_line_work_state_coherence_check;',
  'ALTER TABLE public.agent_mission_quote_line_work',
  '  RENAME CONSTRAINT agent_mission_quote_line_work_state_coherence_m2a2_check',
  '    TO agent_mission_quote_line_work_state_coherence_check;',
  'ALTER TABLE public.agent_mission_quote_line_work',
  '  RENAME CONSTRAINT agent_mission_quote_line_work_catalogue_override_m2a2_check',
  '    TO agent_mission_quote_line_work_catalogue_override_check;',
  'DROP FUNCTION public.guard_agent_mission_quote_line_work_v2();',
  'RESET ROLE;',
  '',
  'COMMIT;',
  '',
].join('\n');

async function currentOrEmpty(filePath) {
  return readFile(filePath, 'utf8').catch((error) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  });
}

const generated = [
  [expandPath, expandMigration],
  [validatePath, validateMigration],
  [cutoverPath, cutoverMigration],
];
if (process.argv.includes('--write')) {
  for (const [filePath, contents] of generated) {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, 'utf8');
  }
  process.stdout.write('AgentMission M2-A-2 migrations generated.\n');
} else if (process.argv.includes('--check')) {
  for (const [filePath, expected] of generated) {
    if (await currentOrEmpty(filePath) !== expected) {
      throw new Error(
        `AGENT_MISSION_M2A2_MIGRATION_DRIFT:${path.basename(path.dirname(filePath))}`,
      );
    }
  }
  process.stdout.write('AgentMission M2-A-2 migrations match sources.\n');
} else {
  throw new Error('AGENT_MISSION_M2A2_GENERATOR_USAGE: pass --write or --check');
}

#!/usr/bin/env node

import { createHash } from 'node:crypto';
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
const catalogueSearchSourcePath = path.join(
  repositoryRoot,
  'packages/core/src/application/ports/catalogue-candidate-search.ts',
);
const m1cExpandPath = path.join(
  apiDirectory,
  'prisma/migrations/20260729100000_agent_mission_customer_resolution_expand/migration.sql',
);
const expandPath = path.join(
  apiDirectory,
  'prisma/migrations/20260730100000_agent_mission_catalogue_choice_expand/migration.sql',
);
const validatePath = path.join(
  apiDirectory,
  'prisma/migrations/20260730100100_agent_mission_catalogue_choice_validate/migration.sql',
);
const cutoverPath = path.join(
  apiDirectory,
  'prisma/migrations/20260730100200_agent_mission_catalogue_choice_cutover/migration.sql',
);

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function extractStringConstArray(source, name, stack = new Set()) {
  if (stack.has(name)) {
    throw new Error(`AGENT_MISSION_M2A1_SOURCE_ARRAY_CYCLE:${name}`);
  }
  const match = source.match(
    new RegExp(
      `export const ${escaped(name)}(?:\\s*:[^=]+)?\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const;`,
      'u',
    ),
  );
  if (match === null) {
    throw new Error(`AGENT_MISSION_M2A1_SOURCE_ARRAY_MISSING:${name}`);
  }
  const nextStack = new Set(stack).add(name);
  const values = match[1]
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/.*$/gmu, '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '')
    .flatMap((token) => {
      const literal = token.match(/^'([^']+)'$/u);
      if (literal !== null) return [literal[1]];
      const spread = token.match(/^\.\.\.([A-Z][A-Z0-9_]*)$/u);
      if (spread !== null) {
        return extractStringConstArray(source, spread[1], nextStack);
      }
      throw new Error(
        `AGENT_MISSION_M2A1_SOURCE_ARRAY_TOKEN_INVALID:${name}:${token}`,
      );
    });
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`AGENT_MISSION_M2A1_SOURCE_ARRAY_INVALID:${name}`);
  }
  return values;
}

function extractNumericConst(source, name) {
  const match = source.match(
    new RegExp(`export const ${escaped(name)} = ([0-9][0-9_]*)`, 'u'),
  );
  if (match === null) {
    throw new Error(`AGENT_MISSION_M2A1_SOURCE_NUMBER_MISSING:${name}`);
  }
  const value = Number(match[1].replaceAll('_', ''));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`AGENT_MISSION_M2A1_SOURCE_NUMBER_INVALID:${name}`);
  }
  return value;
}

function extractNumericConstArray(source, name) {
  const match = source.match(
    new RegExp(
      `export const ${escaped(name)}(?:\\s*:[^=]+)?\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const;`,
      'u',
    ),
  );
  if (match === null || !/^[0-9_,\s]+$/u.test(match[1])) {
    throw new Error(`AGENT_MISSION_M2A1_SOURCE_NUMBER_ARRAY_INVALID:${name}`);
  }
  const values = match[1]
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '')
    .map((token) => Number(token.replaceAll('_', '')));
  if (
    values.length === 0
    || new Set(values).size !== values.length
    || values.some((value) => !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new Error(`AGENT_MISSION_M2A1_SOURCE_NUMBER_ARRAY_INVALID:${name}`);
  }
  return values.map(String);
}

function sqlStringValues(values, indent) {
  return values
    .map((value, index) => (
      `${indent}'${value}'${index === values.length - 1 ? '' : ','}`
    ))
    .join('\n');
}

function sqlNumericValues(values, indent) {
  return values
    .map((value, index) => (
      `${indent}${value}${index === values.length - 1 ? '' : ','}`
    ))
    .join('\n');
}

function generatedValues(name, values, indent, numeric = false) {
  return [
    `${indent}-- BEGIN GENERATED ${name}`,
    numeric
      ? sqlNumericValues(values, indent)
      : sqlStringValues(values, indent),
    `${indent}-- END GENERATED ${name}`,
  ].join('\n');
}

function replaceGeneratedRegion(sql, name, values, numeric = false) {
  const pattern = new RegExp(
    `(^[ \\t]*-- BEGIN GENERATED ${escaped(name)}\\r?\\n)([\\s\\S]*?)(^[ \\t]*-- END GENERATED ${escaped(name)}$)`,
    'gmu',
  );
  let replacements = 0;
  const replaced = sql.replace(pattern, (_region, start, _contents, end) => {
    replacements += 1;
    const indent = start.match(/^([ \t]*)/u)?.[1] ?? '';
    const rendered = numeric
      ? sqlNumericValues(values, indent)
      : sqlStringValues(values, indent);
    return `${start}${rendered}\n${end}`;
  });
  if (replacements === 0) {
    throw new Error(`AGENT_MISSION_M2A1_SQL_REGION_MISSING:${name}`);
  }
  return replaced;
}

function replaceOnce(value, needle, replacement, errorCode) {
  const index = value.indexOf(needle);
  if (index === -1 || value.indexOf(needle, index + needle.length) !== -1) {
    throw new Error(errorCode);
  }
  return `${value.slice(0, index)}${replacement}${value.slice(index + needle.length)}`;
}

function extractAlterConstraint(sql, name) {
  const token = `ADD CONSTRAINT ${name} CHECK `;
  const start = sql.indexOf(token);
  if (start === -1) {
    throw new Error(`AGENT_MISSION_M2A1_SQL_CONSTRAINT_MISSING:${name}`);
  }
  const nextConstraint = sql.indexOf(',\n  ADD CONSTRAINT ', start + token.length);
  const nextStatement = sql.indexOf(';\n\n', start + token.length);
  const end = nextConstraint === -1
    ? nextStatement
    : nextStatement === -1
      ? nextConstraint
      : Math.min(nextConstraint, nextStatement);
  if (end === -1) {
    throw new Error(`AGENT_MISSION_M2A1_SQL_CONSTRAINT_BOUNDARY:${name}`);
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
    throw new Error(`AGENT_MISSION_M2A1_SQL_CONSTRAINT_RENAME:${from}`);
  }
  return renamed;
}

function renderCatalogueCandidates(keys, maximumCandidates) {
  const candidateChecks = Array.from({ length: maximumCandidates }, (_, index) => {
    const candidate = `"payload" #> '{decision,candidates,${index}}'`;
    return [
      `${index === 0 ? '' : 'AND '}(`,
      `  jsonb_array_length("payload" #> '{decision,candidates}') <= ${index}`,
      '  OR (',
      `    jsonb_typeof(${candidate}) = 'object'`,
      `    AND (${candidate}) ?& ARRAY[`,
      sqlStringValues(keys, '      '),
      '    ]',
      `    AND (${candidate}) - ARRAY[`,
      sqlStringValues(keys, '      '),
      "    ] = '{}'::JSONB",
      `    AND (${candidate}) ->> 'choiceId'`,
      "      ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'",
      `    AND jsonb_typeof((${candidate}) -> 'catalogueItemId') = 'string'`,
      `    AND char_length((${candidate}) ->> 'catalogueItemId') BETWEEN 1 AND 128`,
      `    AND (${candidate}) ->> 'catalogueItemId' ~ '^[A-Za-z0-9-]+$'`,
      `    AND jsonb_typeof((${candidate}) -> 'expectedCatalogueRevision') = 'number'`,
      `    AND ((${candidate}) ->> 'expectedCatalogueRevision')::NUMERIC`,
      '      BETWEEN 1 AND 2147483647',
      `    AND ((${candidate}) ->> 'expectedCatalogueRevision')::NUMERIC`,
      `      = trunc(((${candidate}) ->> 'expectedCatalogueRevision')::NUMERIC)`,
      '  )',
      ')',
    ].join('\n');
  });
  const uniquenessChecks = [];
  for (let left = 0; left < maximumCandidates; left += 1) {
    for (let right = left + 1; right < maximumCandidates; right += 1) {
      uniquenessChecks.push([
        'AND (',
        `  jsonb_array_length("payload" #> '{decision,candidates}') <= ${right}`,
        '  OR (',
        `    "payload" #>> '{decision,candidates,${left},choiceId}'`,
        `      <> "payload" #>> '{decision,candidates,${right},choiceId}'`,
        '    AND',
        `    "payload" #>> '{decision,candidates,${left},catalogueItemId}'`,
        `      <> "payload" #>> '{decision,candidates,${right},catalogueItemId}'`,
        '  )',
        ')',
      ].join('\n'));
    }
  }
  const freeChoiceChecks = Array.from(
    { length: maximumCandidates },
    (_, index) => [
      'AND (',
      `  jsonb_array_length("payload" #> '{decision,candidates}') <= ${index}`,
      '  OR "payload" #>> \'{decision,freeLineChoiceId}\'',
      `    <> "payload" #>> '{decision,candidates,${index},choiceId}'`,
      ')',
    ].join('\n'),
  );
  return [...candidateChecks, ...uniquenessChecks, ...freeChoiceChecks].join('\n');
}

function indentLines(value, indentation) {
  return value
    .split('\n')
    .map((line) => `${indentation}${line}`)
    .join('\n');
}

function assumeTableOwner(
  tableName,
  label,
  { requireSchemaCreate = false } = {},
) {
  return [
    `DO $bob_m2a1_${label}_owner$`,
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
    `     AND relation.relname = '${tableName}'`,
    "     AND relation.relkind IN ('r', 'p');",
    '',
    '  IF current_user::pg_catalog.regrole <> owner_oid THEN',
    '    IF owner_name IS NULL',
    "       OR NOT pg_catalog.pg_has_role(session_user, owner_oid, 'SET') THEN",
    '      RAISE EXCEPTION USING',
    "        ERRCODE = '42501',",
    `        MESSAGE = 'AGENT_MISSION_M2A1_${label.toUpperCase()}_OWNER_UNAVAILABLE';`,
    '    END IF;',
    "    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', owner_name);",
    '  END IF;',
    '',
    '  IF current_user::pg_catalog.regrole <> owner_oid THEN',
    '    RAISE EXCEPTION USING',
    "      ERRCODE = '42501',",
    `      MESSAGE = 'AGENT_MISSION_M2A1_${label.toUpperCase()}_OWNER_NOT_ASSUMED';`,
    '  END IF;',
    ...(requireSchemaCreate
      ? [
        '',
        '  IF NOT pg_catalog.has_schema_privilege(',
        "    current_user, 'public', 'CREATE'",
        '  ) THEN',
        '    RAISE EXCEPTION USING',
        "      ERRCODE = '42501',",
        `      MESSAGE = 'AGENT_MISSION_M2A1_${label.toUpperCase()}_SCHEMA_CREATE_REQUIRED';`,
        '  END IF;',
      ]
      : []),
    'END;',
    `$bob_m2a1_${label}_owner$;`,
  ].join('\n');
}

function revokeDataApiUnderCurrentOwner(tableName, label, functionNames = []) {
  if (
    !/^[a-z][a-z0-9_]*$/u.test(tableName)
    || !/^[a-z][a-z0-9_]*$/u.test(label)
    || functionNames.some((name) => !/^[a-z][a-z0-9_]*$/u.test(name))
  ) {
    throw new Error('AGENT_MISSION_M2A1_DATA_API_IDENTIFIER_INVALID');
  }
  const functionArray = functionNames.length === 0
    ? 'ARRAY[]::TEXT[]'
    : `ARRAY[${functionNames.map((name) => `'${name}'`).join(', ')}]::TEXT[]`;
  return [
    `REVOKE ALL PRIVILEGES ON TABLE public.${tableName} FROM PUBLIC;`,
    ...functionNames.map(
      (name) => `REVOKE ALL PRIVILEGES ON FUNCTION public.${name}() FROM PUBLIC;`,
    ),
    '',
    `DO $bob_m2a1_${label}_data_api_fence$`,
    'DECLARE',
    '  exposed_role TEXT;',
    '  column_name TEXT;',
    '  function_name TEXT;',
    'BEGIN',
    '  FOR column_name IN',
    '    SELECT attribute.attname',
    '      FROM pg_catalog.pg_attribute AS attribute',
    '     WHERE attribute.attrelid =',
    `           'public.${tableName}'::pg_catalog.regclass`,
    '       AND attribute.attnum > 0',
    '       AND NOT attribute.attisdropped',
    '       AND attribute.attacl IS NOT NULL',
    '     ORDER BY attribute.attnum',
    '  LOOP',
    '    EXECUTE pg_catalog.format(',
    `      'REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.${tableName} FROM PUBLIC',`,
    '      column_name,',
    '      column_name,',
    '      column_name,',
    '      column_name',
    '    );',
    '  END LOOP;',
    '',
    "  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP",
    '    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN',
    '      EXECUTE pg_catalog.format(',
    `        'REVOKE ALL PRIVILEGES ON TABLE public.${tableName} FROM %I',`,
    '        exposed_role',
    '      );',
    '      FOR column_name IN',
    '        SELECT attribute.attname',
    '          FROM pg_catalog.pg_attribute AS attribute',
    '         WHERE attribute.attrelid =',
    `               'public.${tableName}'::pg_catalog.regclass`,
    '           AND attribute.attnum > 0',
    '           AND NOT attribute.attisdropped',
    '           AND attribute.attacl IS NOT NULL',
    '         ORDER BY attribute.attnum',
    '      LOOP',
    '        EXECUTE pg_catalog.format(',
    `          'REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.${tableName} FROM %I',`,
    '          column_name,',
    '          column_name,',
    '          column_name,',
    '          column_name,',
    '          exposed_role',
    '        );',
    '      END LOOP;',
    `      FOREACH function_name IN ARRAY ${functionArray} LOOP`,
    '        EXECUTE pg_catalog.format(',
    "          'REVOKE ALL PRIVILEGES ON FUNCTION public.%I() FROM %I',",
    '          function_name,',
    '          exposed_role',
    '        );',
    '      END LOOP;',
    '    END IF;',
    '  END LOOP;',
    'END;',
    `$bob_m2a1_${label}_data_api_fence$;`,
  ].join('\n');
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const [
  missionSource,
  eventSource,
  workSource,
  catalogueSearchSource,
  m1cExpand,
] = await Promise.all([
  readFile(missionSourcePath, 'utf8'),
  readFile(eventSourcePath, 'utf8'),
  readFile(workSourcePath, 'utf8'),
  readFile(catalogueSearchSourcePath, 'utf8'),
  readFile(m1cExpandPath, 'utf8'),
]);

const missionRegions = [
  'QUOTE_MISSION_DECISION_KINDS',
  'QUOTE_MISSION_DRAFT_REFERENCE_KEYS',
  'QUOTE_MISSION_DRAFT_DECISION_KEYS',
  'QUOTE_MISSION_CUSTOMER_DECISION_KEYS',
  'QUOTE_MISSION_ACTION_CHOICE_KEYS',
  'QUOTE_MISSION_CUSTOMER_CANDIDATE_KEYS',
  'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KINDS',
  'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_KIND_ONLY_KEYS',
  'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_EXACT_KEYS',
  'QUOTE_MISSION_STAGED_CUSTOMER_RESOLUTION_CHOICES_KEYS',
].map((name) => ({
  name,
  values: extractStringConstArray(missionSource, name),
}));
const eventRegions = [
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
  'AGENT_MISSION_SCREEN_ACK_NEXT_PHASES',
  'AGENT_MISSION_CUSTOMER_NOT_FOUND_RESULTS',
  'AGENT_MISSION_STAGED_CUSTOMER_RESOLUTION_RESULTS',
  'AGENT_MISSION_CUSTOMER_SELECTION_SOURCES',
  'AGENT_MISSION_DECISION_INVALIDATION_REASONS',
  'AGENT_MISSION_CANCELLATION_REASONS',
  'AGENT_MISSION_EXPIRY_REASONS',
].map((name) => ({
  name,
  values: extractStringConstArray(eventSource, name),
}));

function applyRegions(value, regions) {
  return regions.reduce(
    (current, region) => (
      current.includes(`-- BEGIN GENERATED ${region.name}`)
        ? replaceGeneratedRegion(current, region.name, region.values)
        : current
    ),
    value,
  );
}

const protocolVersions = extractNumericConstArray(
  missionSource,
  'AGENT_MISSION_PROTOCOL_VERSIONS',
);
const phases = extractStringConstArray(
  missionSource,
  'QUOTE_CREATION_MISSION_PHASES',
);
const catalogueDecisionKeys = extractStringConstArray(
  missionSource,
  'QUOTE_MISSION_CATALOGUE_DECISION_KEYS',
);
const draftReferenceKeys = extractStringConstArray(
  missionSource,
  'QUOTE_MISSION_DRAFT_REFERENCE_KEYS',
);
const catalogueCandidateKeys = extractStringConstArray(
  missionSource,
  'QUOTE_MISSION_CATALOGUE_CANDIDATE_KEYS',
);
const maximumCatalogueCandidates = extractNumericConst(
  missionSource,
  'AGENT_MISSION_MAX_CATALOGUE_CHOICES',
);
const maximumLineWorkItems = extractNumericConst(
  workSource,
  'AGENT_MISSION_QUOTE_LINE_MAX_WORK_ITEMS',
);
const maximumLineOrdinal = extractNumericConst(
  workSource,
  'AGENT_MISSION_QUOTE_LINE_MAX_ORDINAL',
);
const maximumCatalogueSearchTokenLength = extractNumericConst(
  catalogueSearchSource,
  'CATALOGUE_CANDIDATE_TOKEN_MAX_LENGTH',
);
const catalogueResolutions = extractStringConstArray(
  workSource,
  'AGENT_MISSION_QUOTE_LINE_CATALOGUE_RESOLUTIONS',
);
const m2aEventTypes = [
  'line_candidates_staged',
  'catalogue_not_found',
  'catalogue_choices_presented',
  'catalogue_choice_selected',
];
const allEventTypes = extractStringConstArray(
  eventSource,
  'AGENT_MISSION_EVENT_TYPES',
);
if (m2aEventTypes.some((eventType) => !allEventTypes.includes(eventType))) {
  throw new Error('AGENT_MISSION_M2A1_EVENT_PARTITION_DRIFT');
}

let missionClosedShape = applyRegions(
  renameConstraint(
    extractAlterConstraint(
      m1cExpand,
      'agent_missions_payload_closed_shape_m1c_check',
    ),
    'agent_missions_payload_closed_shape_m1c_check',
    'agent_missions_payload_closed_shape_m2a1_check',
  ),
  missionRegions,
);
const catalogueCandidateChecks = indentLines(
  renderCatalogueCandidates(
    catalogueCandidateKeys,
    maximumCatalogueCandidates,
  ),
  '            ',
);
const catalogueDecisionBranch = [
  '          OR (',
  "            \"protocolVersion\" = 2",
  "            AND \"payload\" -> 'decision' ->> 'kind' = 'catalogue'",
  "            AND \"payload\" -> 'decision' ?& ARRAY[",
  generatedValues(
    'QUOTE_MISSION_CATALOGUE_DECISION_KEYS',
    catalogueDecisionKeys,
    '              ',
  ),
  '            ]',
  "            AND (\"payload\" -> 'decision') - ARRAY[",
  generatedValues(
    'QUOTE_MISSION_CATALOGUE_DECISION_KEYS',
    catalogueDecisionKeys,
    '              ',
  ),
  "            ] = '{}'::JSONB",
  "            AND \"payload\" #>> '{decision,pendingLineId}'",
  "              ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'",
  "            AND jsonb_typeof(\"payload\" #> '{decision,expectedDraft}') = 'object'",
  "            AND (\"payload\" #> '{decision,expectedDraft}') ?& ARRAY[",
  generatedValues(
    'QUOTE_MISSION_DRAFT_REFERENCE_KEYS',
    draftReferenceKeys,
    '              ',
  ),
  '            ]',
  "            AND (\"payload\" #> '{decision,expectedDraft}') - ARRAY[",
  generatedValues(
    'QUOTE_MISSION_DRAFT_REFERENCE_KEYS',
    draftReferenceKeys,
    '              ',
  ),
  "            ] = '{}'::JSONB",
  "            AND jsonb_typeof(\"payload\" #> '{decision,expectedDraft,sessionId}') = 'string'",
  "            AND char_length(\"payload\" #>> '{decision,expectedDraft,sessionId}')",
  '              BETWEEN 1 AND 200',
  "            AND \"payload\" #>> '{decision,expectedDraft,sessionId}'",
  "              = btrim(\"payload\" #>> '{decision,expectedDraft,sessionId}')",
  "            AND \"payload\" #>> '{decision,expectedDraft,sessionId}' !~ '[[:cntrl:]]'",
  "            AND jsonb_typeof(\"payload\" #> '{decision,expectedDraft,slotRevision}') = 'number'",
  "            AND (\"payload\" #>> '{decision,expectedDraft,slotRevision}')::NUMERIC",
  '              BETWEEN 1 AND 2147483647',
  "            AND (\"payload\" #>> '{decision,expectedDraft,slotRevision}')::NUMERIC",
  "              = trunc((\"payload\" #>> '{decision,expectedDraft,slotRevision}')::NUMERIC)",
  "            AND jsonb_typeof(\"payload\" #> '{decision,expectedDraft,contentRevision}') = 'number'",
  "            AND (\"payload\" #>> '{decision,expectedDraft,contentRevision}')::NUMERIC",
  '              BETWEEN 0 AND 2147483647',
  "            AND (\"payload\" #>> '{decision,expectedDraft,contentRevision}')::NUMERIC",
  "              = trunc((\"payload\" #>> '{decision,expectedDraft,contentRevision}')::NUMERIC)",
  "            AND jsonb_typeof(\"payload\" #> '{decision,expectedWorkRevision}') = 'number'",
  "            AND (\"payload\" #>> '{decision,expectedWorkRevision}')::NUMERIC",
  '              BETWEEN 1 AND 2147483647',
  "            AND (\"payload\" #>> '{decision,expectedWorkRevision}')::NUMERIC",
  "              = trunc((\"payload\" #>> '{decision,expectedWorkRevision}')::NUMERIC)",
  "            AND jsonb_typeof(\"payload\" #> '{decision,candidates}') = 'array'",
  "            AND jsonb_array_length(\"payload\" #> '{decision,candidates}')",
  `              BETWEEN 1 AND ${maximumCatalogueCandidates}`,
  "            AND \"payload\" #>> '{decision,freeLineChoiceId}'",
  "              ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'",
  '            AND',
  '            -- BEGIN GENERATED M2A1_QUOTE_MISSION_CATALOGUE_CANDIDATE_CHECKS',
  catalogueCandidateChecks,
  '            -- END GENERATED M2A1_QUOTE_MISSION_CATALOGUE_CANDIDATE_CHECKS',
  '          )',
].join('\n');
missionClosedShape = replaceOnce(
  missionClosedShape,
  [
    '            -- END GENERATED QUOTE_MISSION_CUSTOMER_CANDIDATE_CHECKS',
    '          )',
    '        )',
  ].join('\n'),
  [
    '            -- END GENERATED QUOTE_MISSION_CUSTOMER_CANDIDATE_CHECKS',
    '          )',
    catalogueDecisionBranch,
    '        )',
  ].join('\n'),
  'AGENT_MISSION_M2A1_CATALOGUE_DECISION_INJECTION_FAILED',
);

let missionPhasePayload = applyRegions(
  renameConstraint(
    extractAlterConstraint(
      m1cExpand,
      'agent_missions_phase_payload_m1c_check',
    ),
    'agent_missions_phase_payload_m1c_check',
    'agent_missions_phase_payload_m2a1_check',
  ),
  [...missionRegions, ...eventRegions],
);
const awaitingLinesBranch = [
  '    OR (',
  "      \"phase\" = 'awaiting_lines'",
  "      AND jsonb_typeof(\"payload\" -> 'draft') = 'object'",
  "      AND \"payload\" -> 'decision' = 'null'::JSONB",
  "      AND jsonb_typeof(\"currentBinding\") = 'object'",
  '    )',
].join('\n');
missionPhasePayload = replaceOnce(
  missionPhasePayload,
  awaitingLinesBranch,
  [
    awaitingLinesBranch,
    '    OR (',
    "      \"protocolVersion\" = 2",
    "      AND \"phase\" = 'awaiting_catalogue_choice'",
    "      AND jsonb_typeof(\"payload\" -> 'draft') = 'object'",
    "      AND \"payload\" -> 'decision' ->> 'kind' = 'catalogue'",
    "      AND jsonb_typeof(\"currentBinding\") = 'object'",
    '    )',
  ].join('\n'),
  'AGENT_MISSION_M2A1_PHASE_INJECTION_FAILED',
);

let eventTypeConstraint = applyRegions(
  renameConstraint(
    extractAlterConstraint(
      m1cExpand,
      'agent_mission_events_type_m1c_check',
    ),
    'agent_mission_events_type_m1c_check',
    'agent_mission_events_type_m2a1_check',
  ),
  eventRegions,
);
let eventEnvelopeConstraint = applyRegions(
  renameConstraint(
    extractAlterConstraint(
      m1cExpand,
      'agent_mission_events_envelope_m1c_check',
    ),
    'agent_mission_events_envelope_m1c_check',
    'agent_mission_events_envelope_m2a1_check',
  ),
  eventRegions,
);
let eventDataConstraint = applyRegions(
  renameConstraint(
    extractAlterConstraint(
      m1cExpand,
      'agent_mission_events_data_m1c_check',
    ),
    'agent_mission_events_data_m1c_check',
    'agent_mission_events_data_m2a1_check',
  ),
  eventRegions,
);
const eventLineKeys = extractStringConstArray(
  eventSource,
  'AGENT_MISSION_EVENT_LINE_STAGED_DATA_KEYS',
);
const eventCatalogueNotFoundKeys = extractStringConstArray(
  eventSource,
  'AGENT_MISSION_EVENT_CATALOGUE_NOT_FOUND_DATA_KEYS',
);
const eventCataloguePresentedKeys = extractStringConstArray(
  eventSource,
  'AGENT_MISSION_EVENT_CATALOGUE_PRESENTED_DATA_KEYS',
);
const eventCatalogueSelectedKeys = extractStringConstArray(
  eventSource,
  'AGENT_MISSION_EVENT_CATALOGUE_SELECTED_DATA_KEYS',
);
const m2aEventDataBranches = [
  '      OR (',
  "        \"eventType\" = 'line_candidates_staged'",
  '        AND "data" ?& ARRAY[',
  generatedValues(
    'AGENT_MISSION_EVENT_LINE_STAGED_DATA_KEYS',
    eventLineKeys,
    '          ',
  ),
  '        ]',
  '        AND "data" - ARRAY[',
  generatedValues(
    'AGENT_MISSION_EVENT_LINE_STAGED_DATA_KEYS',
    eventLineKeys,
    '          ',
  ),
  "        ] = '{}'::JSONB",
  "        AND jsonb_typeof(\"data\" -> 'stagedCount') = 'number'",
  "        AND (\"data\" ->> 'stagedCount')::NUMERIC",
  `          BETWEEN 1 AND ${maximumLineWorkItems}`,
  "        AND (\"data\" ->> 'stagedCount')::NUMERIC",
  "          = trunc((\"data\" ->> 'stagedCount')::NUMERIC)",
  "        AND jsonb_typeof(\"data\" -> 'firstQueueOrdinal') = 'number'",
  "        AND (\"data\" ->> 'firstQueueOrdinal')::NUMERIC",
  `          BETWEEN 1 AND ${maximumLineOrdinal}`,
  "        AND (\"data\" ->> 'firstQueueOrdinal')::NUMERIC",
  "          = trunc((\"data\" ->> 'firstQueueOrdinal')::NUMERIC)",
  "        AND jsonb_typeof(\"data\" -> 'lastQueueOrdinal') = 'number'",
  "        AND (\"data\" ->> 'lastQueueOrdinal')::NUMERIC",
  `          BETWEEN 1 AND ${maximumLineOrdinal}`,
  "        AND (\"data\" ->> 'lastQueueOrdinal')::NUMERIC",
  "          = trunc((\"data\" ->> 'lastQueueOrdinal')::NUMERIC)",
  "        AND (\"data\" ->> 'lastQueueOrdinal')::NUMERIC",
  "          - (\"data\" ->> 'firstQueueOrdinal')::NUMERIC + 1",
  "          = (\"data\" ->> 'stagedCount')::NUMERIC",
  '      )',
  '      OR (',
  "        \"eventType\" = 'catalogue_not_found'",
  '        AND "data" ?& ARRAY[',
  generatedValues(
    'AGENT_MISSION_EVENT_CATALOGUE_NOT_FOUND_DATA_KEYS',
    eventCatalogueNotFoundKeys,
    '          ',
  ),
  '        ]',
  '        AND "data" - ARRAY[',
  generatedValues(
    'AGENT_MISSION_EVENT_CATALOGUE_NOT_FOUND_DATA_KEYS',
    eventCatalogueNotFoundKeys,
    '          ',
  ),
  "        ] = '{}'::JSONB",
  "        AND \"data\" ->> 'pendingLineId'",
  "          ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'",
  "        AND jsonb_typeof(\"data\" -> 'workRevisionAfter') = 'number'",
  "        AND (\"data\" ->> 'workRevisionAfter')::NUMERIC",
  '          BETWEEN 1 AND 2147483647',
  "        AND (\"data\" ->> 'workRevisionAfter')::NUMERIC",
  "          = trunc((\"data\" ->> 'workRevisionAfter')::NUMERIC)",
  "        AND \"data\" ->> 'result' = 'none'",
  '      )',
  '      OR (',
  "        \"eventType\" = 'catalogue_choices_presented'",
  '        AND "data" ?& ARRAY[',
  generatedValues(
    'AGENT_MISSION_EVENT_CATALOGUE_PRESENTED_DATA_KEYS',
    eventCataloguePresentedKeys,
    '          ',
  ),
  '        ]',
  '        AND "data" - ARRAY[',
  generatedValues(
    'AGENT_MISSION_EVENT_CATALOGUE_PRESENTED_DATA_KEYS',
    eventCataloguePresentedKeys,
    '          ',
  ),
  "        ] = '{}'::JSONB",
  "        AND \"data\" ->> 'pendingLineId'",
  "          ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'",
  "        AND jsonb_typeof(\"data\" -> 'expectedWorkRevision') = 'number'",
  "        AND (\"data\" ->> 'expectedWorkRevision')::NUMERIC",
  '          BETWEEN 1 AND 2147483647',
  "        AND (\"data\" ->> 'expectedWorkRevision')::NUMERIC",
  "          = trunc((\"data\" ->> 'expectedWorkRevision')::NUMERIC)",
  "        AND jsonb_typeof(\"data\" -> 'candidateCount') = 'number'",
  "        AND (\"data\" ->> 'candidateCount')::NUMERIC",
  `          BETWEEN 1 AND ${maximumCatalogueCandidates}`,
  "        AND (\"data\" ->> 'candidateCount')::NUMERIC",
  "          = trunc((\"data\" ->> 'candidateCount')::NUMERIC)",
  "        AND \"data\" ->> 'choiceSetHash' ~ '^[a-f0-9]{64}$'",
  '      )',
  '      OR (',
  "        \"eventType\" = 'catalogue_choice_selected'",
  '        AND "data" ?& ARRAY[',
  generatedValues(
    'AGENT_MISSION_EVENT_CATALOGUE_SELECTED_DATA_KEYS',
    eventCatalogueSelectedKeys,
    '          ',
  ),
  '        ]',
  '        AND "data" - ARRAY[',
  generatedValues(
    'AGENT_MISSION_EVENT_CATALOGUE_SELECTED_DATA_KEYS',
    eventCatalogueSelectedKeys,
    '          ',
  ),
  "        ] = '{}'::JSONB",
  "        AND \"data\" ->> 'pendingLineId'",
  "          ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'",
  "        AND jsonb_typeof(\"data\" -> 'workRevisionAfter') = 'number'",
  "        AND (\"data\" ->> 'workRevisionAfter')::NUMERIC",
  '          BETWEEN 1 AND 2147483647',
  "        AND (\"data\" ->> 'workRevisionAfter')::NUMERIC",
  "          = trunc((\"data\" ->> 'workRevisionAfter')::NUMERIC)",
  "        AND \"data\" ->> 'resolution' IN ('free', 'selected')",
  "        AND \"data\" ->> 'choiceId'",
  "          ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'",
  "        AND \"data\" ->> 'choiceSetHash' ~ '^[a-f0-9]{64}$'",
  '      )',
].join('\n');
eventDataConstraint = replaceOnce(
  eventDataConstraint,
  [
    '      OR (',
    "        \"eventType\" = 'mission_cancelled'",
  ].join('\n'),
  [
    m2aEventDataBranches,
    '      OR (',
    "        \"eventType\" = 'mission_cancelled'",
  ].join('\n'),
  'AGENT_MISSION_M2A1_EVENT_DATA_INJECTION_FAILED',
);

const eventCorrelationConstraint = applyRegions(
  renameConstraint(
    extractAlterConstraint(
      m1cExpand,
      'agent_mission_events_correlation_m1c_check',
    ),
    'agent_mission_events_correlation_m1c_check',
    'agent_mission_events_correlation_m2a1_check',
  ),
  eventRegions,
);
const eventDraftEffectConstraint = applyRegions(
  renameConstraint(
    extractAlterConstraint(
      m1cExpand,
      'agent_mission_events_draft_effect_m1c_check',
    ),
    'agent_mission_events_draft_effect_m1c_check',
    'agent_mission_events_draft_effect_m2a1_check',
  ),
  eventRegions,
);

const missionPhaseConstraint = [
  'CONSTRAINT agent_missions_phase_m2a1_check CHECK (',
  '  "phase" IN (',
  generatedValues('QUOTE_CREATION_MISSION_PHASES', phases, '    '),
  '  )',
  '  AND (',
  '    "protocolVersion" = 2',
  "    OR \"phase\" <> 'awaiting_catalogue_choice'",
  '  )',
  ')',
].join('\n');
const missionProtocolConstraint = [
  'CONSTRAINT agent_missions_protocol_m2a1_check CHECK (',
  '  "protocolVersion" IN (',
  generatedValues(
    'AGENT_MISSION_PROTOCOL_VERSIONS',
    protocolVersions,
    '    ',
    true,
  ),
  '  )',
  ')',
].join('\n');
const workOrdinalConstraint = [
  'CONSTRAINT agent_mission_quote_line_work_ordinal_m2a1_check CHECK (',
  `  "ordinal" BETWEEN 1 AND ${maximumLineOrdinal}`,
  ')',
].join('\n');
const workCatalogueResolutionConstraint = [
  'CONSTRAINT agent_mission_quote_line_work_catalogue_resolution_m2a1_check CHECK (',
  '  "catalogueResolution" IN (',
  generatedValues(
    'AGENT_MISSION_QUOTE_LINE_CATALOGUE_RESOLUTIONS',
    catalogueResolutions,
    '    ',
  ),
  '  )',
  ')',
].join('\n');
const workStateCoherenceConstraint = [
  'CONSTRAINT agent_mission_quote_line_work_state_coherence_m2a1_check CHECK ((',
  '  (',
  "    (\"catalogueResolution\" = 'selected')",
  '      = ("catalogueItemId" IS NOT NULL AND "expectedCatalogueRevision" IS NOT NULL)',
  '    AND (',
  "      \"catalogueResolution\" = 'selected'",
  '      OR ("catalogueItemId" IS NULL AND "expectedCatalogueRevision" IS NULL)',
  '    )',
  '  )',
  '  AND (',
  '    (',
  "      \"state\" = 'queued'",
  '      AND "requiredFact" IS NULL',
  '      AND "proposalId" IS NULL',
  '      AND "proposalRevision" IS NULL',
  '      AND "proposalDiffHash" IS NULL',
  '    )',
  '    OR (',
  "      \"state\" = 'awaiting_catalogue_choice'",
  '      AND "serviceReference" IS NOT NULL',
  '      AND "requiredFact" IS NULL',
  "      AND \"catalogueResolution\" = 'pending'",
  '      AND "catalogueItemId" IS NULL',
  '      AND "expectedCatalogueRevision" IS NULL',
  '      AND "proposalId" IS NULL',
  '      AND "proposalRevision" IS NULL',
  '      AND "proposalDiffHash" IS NULL',
  '    )',
  '    OR (',
  "      \"state\" = 'awaiting_details'",
  '      AND "requiredFact" IS NOT NULL',
  '      AND (',
  "        \"catalogueResolution\" <> 'pending'",
  "        OR \"requiredFact\" = 'service_reference'",
  '      )',
  '      AND "proposalId" IS NULL',
  '      AND "proposalRevision" IS NULL',
  '      AND "proposalDiffHash" IS NULL',
  '    )',
  '    OR (',
  "      \"state\" = 'awaiting_confirmation'",
  '      AND "serviceReference" IS NOT NULL',
  '      AND "category" IS NOT NULL',
  '      AND "quantityMilli" IS NOT NULL',
  '      AND "unit" IS NOT NULL',
  '      AND "unitPriceCents" IS NOT NULL',
  '      AND "requestedVatRate" IS NOT NULL',
  '      AND "priceBasis" IS NOT NULL',
  '      AND "requiredFact" IS NULL',
  "      AND \"catalogueResolution\" <> 'pending'",
  '      AND "proposalId" IS NOT NULL',
  '      AND "proposalRevision" IS NOT NULL',
  '      AND "proposalDiffHash" IS NOT NULL',
  '    )',
  '  )',
  ') IS TRUE)',
].join('\n');

const leaseCapabilityConstraint = [
  'CONSTRAINT realtime_leases_agent_mission_capability_m2a1_check CHECK ((',
  '  ("agentMissionProtocolVersion" IS NULL)',
  '    = ("agentMissionProtocolBoundAt" IS NULL)',
  '  AND ("agentMissionProtocolVersion" IS NULL)',
  '    = ("agentMissionCapabilityHash" IS NULL)',
  '  AND ("agentMissionProtocolVersion" IS NULL)',
  '    = ("agentMissionReleaseFlagVersion" IS NULL)',
  '  AND (',
  '    "agentMissionProtocolVersion" IS NULL',
  '    OR (',
  '      "agentMissionProtocolVersion" IN (',
  generatedValues(
    'AGENT_MISSION_PROTOCOL_VERSIONS',
    protocolVersions,
    '        ',
    true,
  ),
  '      )',
  '      AND pg_catalog.isfinite("agentMissionProtocolBoundAt")',
  '      AND "agentMissionProtocolBoundAt" = "reservedAt"',
  "      AND \"agentMissionCapabilityHash\" ~ '^[a-f0-9]{64}$'",
  '      AND "agentMissionReleaseFlagVersion" BETWEEN 1 AND 2147483647',
  '    )',
  '  )',
  ') IS TRUE)',
].join('\n');
const leaseReceiptConstraint = [
  'CONSTRAINT realtime_leases_agent_mission_bootstrap_receipt_m2a1_check CHECK ((',
  '  "agentMissionBootstrapAcknowledgedAt" IS NULL',
  '  OR (',
  '    "agentMissionProtocolVersion" IN (',
  generatedValues(
    'AGENT_MISSION_PROTOCOL_VERSIONS',
    protocolVersions,
    '      ',
    true,
  ),
  '    )',
  '    AND "agentMissionProtocolBoundAt" IS NOT NULL',
  '    AND "agentMissionCapabilityHash" IS NOT NULL',
  '    AND pg_catalog.isfinite("agentMissionBootstrapAcknowledgedAt")',
  '    AND "agentMissionBootstrapAcknowledgedAt" >= "agentMissionProtocolBoundAt"',
  '    AND "agentMissionBootstrapAcknowledgedAt" <= "hardExpiresAt"',
  '  )',
  ') IS TRUE)',
].join('\n');

function addConstraints(tableName, constraints) {
  return [
    `ALTER TABLE public.${tableName}`,
    constraints.map((constraint, index) => (
      `${index === 0 ? '  ADD ' : '  ADD '}${constraint} NOT VALID${
        index === constraints.length - 1 ? ';' : ','
      }`
    )).join('\n'),
  ].join('\n');
}

const expandMigration = [
  '-- Bob AgentMission M2-A-1 — choix catalogue durable, expand compatible writer N-1.',
  '-- Le flag bob.agent_missions.quote.m2a reste OFF dans tous les environnements.',
  '',
  'BEGIN;',
  '',
  "SET LOCAL lock_timeout = '5s';",
  "SET LOCAL statement_timeout = '120s';",
  '',
  assumeTableOwner('release_flags', 'release_flags'),
  '',
  '-- FORCE RLS s’applique aussi au propriétaire. La migration désactive la force uniquement',
  '-- dans cette transaction, écrit le flag OFF, le certifie, puis restaure immédiatement.',
  'ALTER TABLE public.release_flags NO FORCE ROW LEVEL SECURITY;',
  '',
  'INSERT INTO public.release_flags (',
  '  id,',
  '  key,',
  '  environment,',
  '  enabled,',
  '  "killSwitch",',
  '  version,',
  '  "updatedByUserId",',
  '  "createdAt",',
  '  "updatedAt"',
  ')',
  'VALUES',
  "  ('bob-agent-missions-quote-m2a-development', 'bob.agent_missions.quote.m2a',",
  "   'development', false, false, 1, 'system:migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),",
  "  ('bob-agent-missions-quote-m2a-staging', 'bob.agent_missions.quote.m2a',",
  "   'staging', false, false, 1, 'system:migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),",
  "  ('bob-agent-missions-quote-m2a-production', 'bob.agent_missions.quote.m2a',",
  "   'production', false, false, 1, 'system:migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
  'ON CONFLICT (key, environment) DO NOTHING;',
  '',
  'DO $bob_m2a1_release_flag_exact$',
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
  "         flag.id <> 'bob-agent-missions-quote-m2a-' || flag.environment::TEXT",
  '         OR flag.enabled',
  '         OR flag."killSwitch"',
  '         OR flag.version <> 1',
  "         OR flag.\"updatedByUserId\" <> 'system:migration'",
  '       )',
  '  ) THEN',
  '    RAISE EXCEPTION USING',
  "      ERRCODE = '23514',",
  "      MESSAGE = 'AGENT_MISSION_M2A1_RELEASE_FLAG_COLLISION_OR_ENABLED';",
  '  END IF;',
  'END;',
  '$bob_m2a1_release_flag_exact$;',
  '',
  'ALTER TABLE public.release_flags ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE public.release_flags FORCE ROW LEVEL SECURITY;',
  '',
  'RESET ROLE;',
  ...missionAndWorkExpand(),
  '',
  assumeTableOwner(
    'realtime_session_leases',
    'realtime_leases',
    { requireSchemaCreate: true },
  ),
  '',
  addConstraints('realtime_session_leases', [
    leaseCapabilityConstraint,
    leaseReceiptConstraint,
  ]),
  '',
  'CREATE FUNCTION public.guard_realtime_agent_mission_bootstrap_receipt_v2()',
  'RETURNS TRIGGER',
  'LANGUAGE plpgsql',
  'SET search_path = pg_catalog, public',
  'AS $agent_mission_bootstrap_receipt_v2$',
  'BEGIN',
  '  IF TG_OP = \'INSERT\' THEN',
  '    IF NEW."agentMissionBootstrapAcknowledgedAt" IS NOT NULL THEN',
  "      RAISE EXCEPTION 'AGENT_MISSION_BOOTSTRAP_RECEIPT_INSERT_FORBIDDEN'",
  "        USING ERRCODE = '23514';",
  '    END IF;',
  '    RETURN NEW;',
  '  END IF;',
  '',
  '  IF NEW."agentMissionBootstrapAcknowledgedAt"',
  '       IS NOT DISTINCT FROM OLD."agentMissionBootstrapAcknowledgedAt" THEN',
  '    RETURN NEW;',
  '  END IF;',
  '',
  '  IF OLD."agentMissionBootstrapAcknowledgedAt" IS NOT NULL',
  '     OR NEW."agentMissionBootstrapAcknowledgedAt" IS NULL',
  '     OR OLD."agentMissionProtocolVersion" NOT IN (',
  generatedValues(
    'AGENT_MISSION_PROTOCOL_VERSIONS',
    protocolVersions,
    '       ',
    true,
  ),
  '     )',
  '     OR OLD."agentMissionProtocolBoundAt" IS NULL',
  '     OR OLD."agentMissionCapabilityHash" IS NULL THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_BOOTSTRAP_RECEIPT_IMMUTABLE'",
  "      USING ERRCODE = '23514';",
  '  END IF;',
  '  NEW."agentMissionBootstrapAcknowledgedAt" := pg_catalog.clock_timestamp();',
  '  RETURN NEW;',
  'END;',
  '$agent_mission_bootstrap_receipt_v2$;',
  '',
  'DROP TRIGGER realtime_lease_agent_mission_receipt_insert_v1',
  '  ON public.realtime_session_leases;',
  'DROP TRIGGER realtime_lease_agent_mission_receipt_update_v1',
  '  ON public.realtime_session_leases;',
  'CREATE TRIGGER realtime_lease_agent_mission_receipt_insert_v2',
  'BEFORE INSERT ON public.realtime_session_leases',
  'FOR EACH ROW',
  'EXECUTE FUNCTION public.guard_realtime_agent_mission_bootstrap_receipt_v2();',
  'CREATE TRIGGER realtime_lease_agent_mission_receipt_update_v2',
  'BEFORE UPDATE OF "agentMissionBootstrapAcknowledgedAt"',
  'ON public.realtime_session_leases',
  'FOR EACH ROW',
  'EXECUTE FUNCTION public.guard_realtime_agent_mission_bootstrap_receipt_v2();',
  '',
  revokeDataApiUnderCurrentOwner(
    'realtime_session_leases',
    'realtime_leases',
    ['guard_realtime_agent_mission_bootstrap_receipt_v2'],
  ),
  '',
  'RESET ROLE;',
  '',
  assumeTableOwner(
    'catalogue_prestations',
    'catalogue',
    { requireSchemaCreate: true },
  ),
  '',
  '-- Le backfill est global, mais le propriétaire catalogue est NOBYPASSRLS. Refuser toute',
  '-- dérive initiale puis lever FORCE uniquement dans cette transaction verrouillée.',
  'DO $bob_m2a1_catalogue_rls_precondition$',
  'BEGIN',
  '  IF NOT EXISTS (',
  '    SELECT 1',
  '      FROM pg_catalog.pg_class AS relation',
  '     WHERE relation.oid =',
  "           'public.catalogue_prestations'::pg_catalog.regclass",
  '       AND relation.relrowsecurity',
  '       AND relation.relforcerowsecurity',
  '  ) THEN',
  '    RAISE EXCEPTION USING',
  "      ERRCODE = '55000',",
  "      MESSAGE = 'AGENT_MISSION_M2A1_CATALOGUE_FORCE_RLS_REQUIRED';",
  '  END IF;',
  'END;',
  '$bob_m2a1_catalogue_rls_precondition$;',
  '',
  'ALTER TABLE public.catalogue_prestations NO FORCE ROW LEVEL SECURITY;',
  '',
  '-- Les opérateurs full-text ne sont pas LEAKPROOF : FORCE RLS empêche PostgreSQL de pousser',
  '-- leur prédicat vers un GIN. Cette projection utilise uniquement des égalités B-tree.',
  'CREATE TABLE public.catalogue_prestation_search_tokens (',
  '  "companyId" TEXT NOT NULL,',
  '  "catalogueItemId" TEXT NOT NULL,',
  '  token TEXT NOT NULL,',
  '  CONSTRAINT catalogue_search_tokens_pkey',
  '    PRIMARY KEY ("companyId", token, "catalogueItemId"),',
  '  CONSTRAINT catalogue_search_tokens_item_company_fkey',
  '    FOREIGN KEY ("catalogueItemId", "companyId")',
  '    REFERENCES public.catalogue_prestations ("id", "companyId")',
  '    ON DELETE CASCADE',
  '    ON UPDATE CASCADE,',
  '  CONSTRAINT catalogue_search_tokens_token_check CHECK (',
  `    pg_catalog.char_length(token) BETWEEN 1 AND ${maximumCatalogueSearchTokenLength}`,
  "    AND token ~ '^[a-z0-9]+$'",
  '  )',
  ');',
  '',
  'CREATE INDEX catalogue_search_tokens_company_item_idx',
  '  ON public.catalogue_prestation_search_tokens',
  '  ("companyId", "catalogueItemId");',
  '',
  'CREATE FUNCTION public.sync_catalogue_prestation_search_tokens_v1()',
  'RETURNS TRIGGER',
  'LANGUAGE plpgsql',
  'SECURITY DEFINER',
  'SET search_path = pg_catalog',
  'SET row_security = on',
  'AS $catalogue_prestation_search_tokens_v1$',
  'BEGIN',
  '  IF NULLIF(pg_catalog.current_setting(',
  "    'app.current_company_id',",
  '    true',
  '  ), \'\') IS DISTINCT FROM NEW."companyId" THEN',
  "    RAISE EXCEPTION 'CATALOGUE_SEARCH_TOKEN_TENANT_CONTEXT_REQUIRED'",
  "      USING ERRCODE = '42501';",
  '  END IF;',
  '',
  '  DELETE FROM public.catalogue_prestation_search_tokens AS search_token',
  '   WHERE search_token."companyId" = NEW."companyId"',
  '     AND search_token."catalogueItemId" = NEW."id";',
  '',
  '  INSERT INTO public.catalogue_prestation_search_tokens (',
  '    "companyId",',
  '    "catalogueItemId",',
  '    token',
  '  )',
  '  SELECT DISTINCT',
  '    NEW."companyId",',
  '    NEW."id",',
  '    split.token',
  '  FROM pg_catalog.regexp_split_to_table(NEW."searchKey", \' +\')',
  '       AS split(token)',
  `  WHERE pg_catalog.char_length(split.token) BETWEEN 1 AND ${maximumCatalogueSearchTokenLength};`,
  '',
  '  RETURN NEW;',
  'END;',
  '$catalogue_prestation_search_tokens_v1$;',
  '',
  'CREATE TRIGGER catalogue_prestations_search_tokens_sync_v1',
  'AFTER INSERT OR UPDATE OF "label"',
  'ON public.catalogue_prestations',
  'FOR EACH ROW',
  'EXECUTE FUNCTION public.sync_catalogue_prestation_search_tokens_v1();',
  '',
  '-- CREATE TRIGGER prend un verrou qui draine les writers N-1. Le backfill suivant voit donc',
  '-- leurs commits ; les prochains writers attendent le commit puis exécutent le trigger.',
  'INSERT INTO public.catalogue_prestation_search_tokens (',
  '  "companyId",',
  '  "catalogueItemId",',
  '  token',
  ')',
  'SELECT DISTINCT',
  '  catalogue."companyId",',
  '  catalogue."id",',
  '  split.token',
  'FROM public.catalogue_prestations AS catalogue',
  'CROSS JOIN LATERAL pg_catalog.regexp_split_to_table(',
  '  catalogue."searchKey",',
  "  ' +'",
  ') AS split(token)',
  `WHERE pg_catalog.char_length(split.token) BETWEEN 1 AND ${maximumCatalogueSearchTokenLength};`,
  '',
  'ALTER TABLE public.catalogue_prestations ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE public.catalogue_prestations FORCE ROW LEVEL SECURITY;',
  '',
  'ALTER TABLE public.catalogue_prestation_search_tokens',
  '  ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE public.catalogue_prestation_search_tokens',
  '  FORCE ROW LEVEL SECURITY;',
  'CREATE POLICY tenant_isolation',
  '  ON public.catalogue_prestation_search_tokens',
  '  USING (',
  '    "companyId" = pg_catalog.current_setting(',
  "      'app.current_company_id',",
  '      true',
  '    )',
  '  )',
  '  WITH CHECK (',
  '    "companyId" = pg_catalog.current_setting(',
  "      'app.current_company_id',",
  '      true',
  '    )',
  '  );',
  '',
  'CREATE FUNCTION public.guard_catalogue_prestation_revision_v1()',
  'RETURNS TRIGGER',
  'LANGUAGE plpgsql',
  'SET search_path = pg_catalog, public',
  'AS $catalogue_prestation_revision_v1$',
  'BEGIN',
  '  IF TG_OP = \'UPDATE\' AND (',
  '    OLD."id" IS DISTINCT FROM NEW."id"',
  '    OR OLD."companyId" IS DISTINCT FROM NEW."companyId"',
  '    OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"',
  '    OR NEW."revision" <> OLD."revision" + 1',
  '  ) THEN',
  "    RAISE EXCEPTION 'CATALOGUE_PRESTATION_IDENTITY_OR_REVISION_INVALID'",
  "      USING ERRCODE = '23514';",
  '  END IF;',
  '  RETURN NEW;',
  'END;',
  '$catalogue_prestation_revision_v1$;',
  '',
  'CREATE TRIGGER catalogue_prestations_revision_guard_v1',
  'BEFORE UPDATE ON public.catalogue_prestations',
  'FOR EACH ROW EXECUTE FUNCTION public.guard_catalogue_prestation_revision_v1();',
  '',
  revokeDataApiUnderCurrentOwner(
    'catalogue_prestations',
    'catalogue',
    ['guard_catalogue_prestation_revision_v1'],
  ),
  '',
  revokeDataApiUnderCurrentOwner(
    'catalogue_prestation_search_tokens',
    'catalogue_search_tokens',
    ['sync_catalogue_prestation_search_tokens_v1'],
  ),
  '',
  'RESET ROLE;',
  '',
  'COMMIT;',
  '',
].join('\n');

const validateMigration = [
  '-- Bob AgentMission M2-A-1 — validation séparée, sans cutover.',
  '',
  'BEGIN;',
  '',
  "SET LOCAL lock_timeout = '5s';",
  "SET LOCAL statement_timeout = '5min';",
  '',
  assumeTableOwner('agent_missions', 'validate_missions'),
  '',
  'ALTER TABLE public.agent_missions',
  '  VALIDATE CONSTRAINT agent_missions_protocol_m2a1_check;',
  'ALTER TABLE public.agent_missions',
  '  VALIDATE CONSTRAINT agent_missions_phase_m2a1_check;',
  'ALTER TABLE public.agent_missions',
  '  VALIDATE CONSTRAINT agent_missions_payload_closed_shape_m2a1_check;',
  'ALTER TABLE public.agent_missions',
  '  VALIDATE CONSTRAINT agent_missions_phase_payload_m2a1_check;',
  '',
  'RESET ROLE;',
  '',
  assumeTableOwner('agent_mission_events', 'validate_events'),
  '',
  'ALTER TABLE public.agent_mission_events',
  '  VALIDATE CONSTRAINT agent_mission_events_type_m2a1_check;',
  'ALTER TABLE public.agent_mission_events',
  '  VALIDATE CONSTRAINT agent_mission_events_envelope_m2a1_check;',
  'ALTER TABLE public.agent_mission_events',
  '  VALIDATE CONSTRAINT agent_mission_events_data_m2a1_check;',
  'ALTER TABLE public.agent_mission_events',
  '  VALIDATE CONSTRAINT agent_mission_events_correlation_m2a1_check;',
  'ALTER TABLE public.agent_mission_events',
  '  VALIDATE CONSTRAINT agent_mission_events_draft_effect_m2a1_check;',
  '',
  'RESET ROLE;',
  '',
  assumeTableOwner('agent_mission_quote_line_work', 'validate_line_work'),
  '',
  'ALTER TABLE public.agent_mission_quote_line_work',
  '  VALIDATE CONSTRAINT agent_mission_quote_line_work_ordinal_m2a1_check;',
  'ALTER TABLE public.agent_mission_quote_line_work',
  '  VALIDATE CONSTRAINT agent_mission_quote_line_work_catalogue_resolution_m2a1_check;',
  'ALTER TABLE public.agent_mission_quote_line_work',
  '  VALIDATE CONSTRAINT agent_mission_quote_line_work_state_coherence_m2a1_check;',
  '',
  'RESET ROLE;',
  '',
  assumeTableOwner('realtime_session_leases', 'validate_realtime_leases'),
  '',
  'ALTER TABLE public.realtime_session_leases',
  '  VALIDATE CONSTRAINT realtime_leases_agent_mission_capability_m2a1_check;',
  'ALTER TABLE public.realtime_session_leases',
  '  VALIDATE CONSTRAINT realtime_leases_agent_mission_bootstrap_receipt_m2a1_check;',
  '',
  'RESET ROLE;',
  '',
  'COMMIT;',
  '',
].join('\n');

const cutoverMigration = [
  '-- Bob AgentMission M2-A-1 — cutover atomique après validation.',
  '-- Le feature flag M2-A reste OFF ; aucun writer V2 n’est activé par cette migration.',
  '',
  'BEGIN;',
  '',
  "SET LOCAL lock_timeout = '5s';",
  "SET LOCAL statement_timeout = '120s';",
  '',
  assumeTableOwner('agent_missions', 'cutover_missions'),
  '',
  'ALTER TABLE public.agent_missions',
  '  DROP CONSTRAINT agent_missions_phase_check,',
  '  DROP CONSTRAINT agent_missions_payload_closed_shape_check,',
  '  DROP CONSTRAINT agent_missions_phase_payload_check;',
  'ALTER TABLE public.agent_missions',
  '  RENAME CONSTRAINT agent_missions_protocol_m2a1_check',
  '    TO agent_missions_protocol_check;',
  'ALTER TABLE public.agent_missions',
  '  RENAME CONSTRAINT agent_missions_phase_m2a1_check',
  '    TO agent_missions_phase_check;',
  'ALTER TABLE public.agent_missions',
  '  RENAME CONSTRAINT agent_missions_payload_closed_shape_m2a1_check',
  '    TO agent_missions_payload_closed_shape_check;',
  'ALTER TABLE public.agent_missions',
  '  RENAME CONSTRAINT agent_missions_phase_payload_m2a1_check',
  '    TO agent_missions_phase_payload_check;',
  '',
  'DROP FUNCTION public.guard_agent_mission_mutation_v1();',
  '',
  'RESET ROLE;',
  '',
  assumeTableOwner('agent_mission_events', 'cutover_events'),
  '',
  'ALTER TABLE public.agent_mission_events',
  '  DROP CONSTRAINT agent_mission_events_type_check,',
  '  DROP CONSTRAINT agent_mission_events_envelope_check,',
  '  DROP CONSTRAINT agent_mission_events_data_check,',
  '  DROP CONSTRAINT agent_mission_events_correlation_check,',
  '  DROP CONSTRAINT agent_mission_events_draft_effect_check;',
  'ALTER TABLE public.agent_mission_events',
  '  RENAME CONSTRAINT agent_mission_events_type_m2a1_check',
  '    TO agent_mission_events_type_check;',
  'ALTER TABLE public.agent_mission_events',
  '  RENAME CONSTRAINT agent_mission_events_envelope_m2a1_check',
  '    TO agent_mission_events_envelope_check;',
  'ALTER TABLE public.agent_mission_events',
  '  RENAME CONSTRAINT agent_mission_events_data_m2a1_check',
  '    TO agent_mission_events_data_check;',
  'ALTER TABLE public.agent_mission_events',
  '  RENAME CONSTRAINT agent_mission_events_correlation_m2a1_check',
  '    TO agent_mission_events_correlation_check;',
  'ALTER TABLE public.agent_mission_events',
  '  RENAME CONSTRAINT agent_mission_events_draft_effect_m2a1_check',
  '    TO agent_mission_events_draft_effect_check;',
  '',
  'DROP FUNCTION public.guard_agent_mission_event_append_v1();',
  '',
  'RESET ROLE;',
  '',
  assumeTableOwner('agent_mission_quote_line_work', 'cutover_line_work'),
  '',
  'ALTER TABLE public.agent_mission_quote_line_work',
  '  DROP CONSTRAINT agent_mission_quote_line_work_ordinal_check,',
  '  DROP CONSTRAINT agent_mission_quote_line_work_state_coherence_check;',
  'ALTER TABLE public.agent_mission_quote_line_work',
  '  RENAME CONSTRAINT agent_mission_quote_line_work_ordinal_m2a1_check',
  '    TO agent_mission_quote_line_work_ordinal_check;',
  'ALTER TABLE public.agent_mission_quote_line_work',
  '  RENAME CONSTRAINT agent_mission_quote_line_work_catalogue_resolution_m2a1_check',
  '    TO agent_mission_quote_line_work_catalogue_resolution_check;',
  'ALTER TABLE public.agent_mission_quote_line_work',
  '  RENAME CONSTRAINT agent_mission_quote_line_work_state_coherence_m2a1_check',
  '    TO agent_mission_quote_line_work_state_coherence_check;',
  'DROP FUNCTION public.guard_agent_mission_quote_line_work_v1();',
  '',
  'RESET ROLE;',
  '',
  assumeTableOwner('realtime_session_leases', 'cutover_realtime_leases'),
  '',
  'ALTER TABLE public.realtime_session_leases',
  '  DROP CONSTRAINT realtime_session_leases_agent_mission_capability_shape_check,',
  '  DROP CONSTRAINT realtime_leases_agent_mission_bootstrap_receipt_check;',
  'ALTER TABLE public.realtime_session_leases',
  '  RENAME CONSTRAINT realtime_leases_agent_mission_capability_m2a1_check',
  '    TO realtime_session_leases_agent_mission_capability_shape_check;',
  'ALTER TABLE public.realtime_session_leases',
  '  RENAME CONSTRAINT realtime_leases_agent_mission_bootstrap_receipt_m2a1_check',
  '    TO realtime_leases_agent_mission_bootstrap_receipt_check;',
  'DROP FUNCTION public.guard_realtime_agent_mission_bootstrap_receipt_v1();',
  '',
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

const generatedMigrations = [
  [expandPath, expandMigration],
  [validatePath, validateMigration],
  [cutoverPath, cutoverMigration],
];

if (process.argv.includes('--write')) {
  for (const [migrationPath, contents] of generatedMigrations) {
    await mkdir(path.dirname(migrationPath), { recursive: true });
    await writeFile(migrationPath, contents, 'utf8');
  }
  process.stdout.write('AgentMission M2-A-1 migrations generated.\n');
} else if (process.argv.includes('--check')) {
  for (const [migrationPath, expected] of generatedMigrations) {
    const actual = await currentOrEmpty(migrationPath);
    if (actual !== expected) {
      throw new Error(
        `AGENT_MISSION_M2A1_MIGRATION_DRIFT:${path.basename(path.dirname(migrationPath))}`,
      );
    }
  }
  process.stdout.write(
    `AgentMission M2-A-1 migrations match sources (${sha256(expandMigration)}).\n`,
  );
} else {
  throw new Error(
    'AGENT_MISSION_M2A1_GENERATOR_USAGE: pass --write or --check',
  );
}

function missionAndWorkExpand() {
  return [
  '',
  assumeTableOwner(
    'agent_missions',
    'missions',
    { requireSchemaCreate: true },
  ),
  '',
  'ALTER TABLE public.agent_missions',
  '  ADD COLUMN "protocolVersion" SMALLINT NOT NULL DEFAULT 1;',
  '',
  addConstraints('agent_missions', [
    missionProtocolConstraint,
    missionPhaseConstraint,
    missionClosedShape,
    missionPhasePayload,
  ]),
  '',
  'CREATE FUNCTION public.guard_agent_mission_mutation_v2()',
  'RETURNS TRIGGER',
  'LANGUAGE plpgsql',
  'SET search_path = pg_catalog, public',
  'AS $agent_mission_mutation_v2$',
  'DECLARE',
  '  expected_mission_id TEXT :=',
  "    nullif(current_setting('app.current_agent_mission_id', true), '');",
  'BEGIN',
  '  IF expected_mission_id IS NULL OR expected_mission_id <> NEW."id"::TEXT THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_CAPABILITY_REQUIRED'",
  "      USING ERRCODE = '42501';",
  '  END IF;',
  '  IF TG_OP = \'UPDATE\' AND (',
  '    OLD."id" IS DISTINCT FROM NEW."id"',
  '    OR OLD."companyId" IS DISTINCT FROM NEW."companyId"',
  '    OR OLD."ownerUserId" IS DISTINCT FROM NEW."ownerUserId"',
  '    OR OLD."protocolVersion" IS DISTINCT FROM NEW."protocolVersion"',
  '    OR OLD."kind" IS DISTINCT FROM NEW."kind"',
  '    OR NEW."revision" <> OLD."revision" + 1',
  '  ) THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_IDENTITY_OR_REVISION_INVALID'",
  "      USING ERRCODE = '23514';",
  '  END IF;',
  '  RETURN NEW;',
  'END;',
  '$agent_mission_mutation_v2$;',
  '',
  'DROP TRIGGER agent_missions_mutation_guard_v1 ON public.agent_missions;',
  'CREATE TRIGGER agent_missions_mutation_guard_v2',
  'BEFORE INSERT OR UPDATE ON public.agent_missions',
  'FOR EACH ROW EXECUTE FUNCTION public.guard_agent_mission_mutation_v2();',
  '',
  revokeDataApiUnderCurrentOwner(
    'agent_missions',
    'missions',
    ['guard_agent_mission_mutation_v2'],
  ),
  '',
  'RESET ROLE;',
  '',
  assumeTableOwner(
    'agent_mission_events',
    'events',
    { requireSchemaCreate: true },
  ),
  '',
  addConstraints('agent_mission_events', [
    eventTypeConstraint,
    eventEnvelopeConstraint,
    eventDataConstraint,
    eventCorrelationConstraint,
    eventDraftEffectConstraint,
  ]),
  '',
  'CREATE FUNCTION public.guard_agent_mission_event_append_v2()',
  'RETURNS TRIGGER',
  'LANGUAGE plpgsql',
  'SET search_path = pg_catalog, public',
  'AS $agent_mission_event_append_v2$',
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
  '',
  '  IF NOT FOUND THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_EVENT_MISSION_NOT_VISIBLE'",
  "      USING ERRCODE = '23503';",
  '  END IF;',
  '  IF NEW."eventType" IN (',
  generatedValues(
    'AGENT_MISSION_M2A1_EVENT_TYPES',
    m2aEventTypes,
    '    ',
  ),
  '  ) AND current_mission_protocol <> 2 THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_M2A1_EVENT_PROTOCOL_REQUIRED'",
  "      USING ERRCODE = '23514';",
  '  END IF;',
  '  IF current_mission_revision <> NEW."missionRevisionAfter"',
  '     OR current_mission_updated_at <> NEW."occurredAt" THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_EVENT_REVISION_MISMATCH'",
  "      USING ERRCODE = '23514';",
  '  END IF;',
  '  IF NEW."missionRevisionAfter" = 1 THEN',
  '    IF EXISTS (',
  '      SELECT 1',
  '        FROM public.agent_mission_events AS previous',
  '       WHERE previous."missionId" = NEW."missionId"',
  '    ) THEN',
  "      RAISE EXCEPTION 'AGENT_MISSION_EVENT_PREDECESSOR_INVALID'",
  "        USING ERRCODE = '23514';",
  '    END IF;',
  '  ELSIF NOT EXISTS (',
  '    SELECT 1',
  '      FROM public.agent_mission_events AS previous',
  '     WHERE previous."missionId" = NEW."missionId"',
  '       AND previous."sequence" = NEW."missionRevisionBefore"',
  '       AND previous."missionRevisionAfter" = NEW."missionRevisionBefore"',
  '  ) THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_EVENT_PREDECESSOR_MISSING'",
  "      USING ERRCODE = '23514';",
  '  END IF;',
  '  RETURN NEW;',
  'END;',
  '$agent_mission_event_append_v2$;',
  '',
  'DROP TRIGGER agent_mission_events_append_guard_v1 ON public.agent_mission_events;',
  'CREATE TRIGGER agent_mission_events_append_guard_v2',
  'BEFORE INSERT ON public.agent_mission_events',
  'FOR EACH ROW EXECUTE FUNCTION public.guard_agent_mission_event_append_v2();',
  '',
  revokeDataApiUnderCurrentOwner(
    'agent_mission_events',
    'events',
    ['guard_agent_mission_event_append_v2'],
  ),
  '',
  'RESET ROLE;',
  '',
  assumeTableOwner(
    'agent_mission_quote_line_work',
    'line_work',
    { requireSchemaCreate: true },
  ),
  '',
  '-- M2-A-0 n’a jamais été activé. Un work item présent signale un writer dormant ou',
  '-- une donnée de test non réconciliée : la migration refuse tout backfill sémantique.',
  '-- FORCE RLS masquerait ces lignes au propriétaire NOBYPASSRLS sans contexte tenant.',
  'ALTER TABLE public.agent_mission_quote_line_work NO FORCE ROW LEVEL SECURITY;',
  '',
  'DO $bob_m2a1_line_work_preflight$',
  'BEGIN',
  '  IF EXISTS (SELECT 1 FROM public.agent_mission_quote_line_work LIMIT 1) THEN',
  '    RAISE EXCEPTION USING',
  "      ERRCODE = '23514',",
  "      MESSAGE = 'AGENT_MISSION_M2A1_PREEXISTING_LINE_WORK_UNSUPPORTED';",
  '  END IF;',
  'END;',
  '$bob_m2a1_line_work_preflight$;',
  '',
  'ALTER TABLE public.agent_mission_quote_line_work ENABLE ROW LEVEL SECURITY;',
  'ALTER TABLE public.agent_mission_quote_line_work FORCE ROW LEVEL SECURITY;',
  '',
  'ALTER TABLE public.agent_mission_quote_line_work',
  '  ADD COLUMN "catalogueResolution" TEXT NOT NULL DEFAULT \'pending\',',
  '  ALTER COLUMN "ordinal" TYPE INTEGER USING "ordinal"::INTEGER;',
  '',
  addConstraints('agent_mission_quote_line_work', [
    workOrdinalConstraint,
    workCatalogueResolutionConstraint,
    workStateCoherenceConstraint,
  ]),
  '',
  'CREATE FUNCTION public.guard_agent_mission_quote_line_work_v2()',
  'RETURNS TRIGGER',
  'LANGUAGE plpgsql',
  'SET search_path = pg_catalog, public',
  'AS $agent_mission_quote_line_work_v2$',
  'DECLARE',
  '  row_value public.agent_mission_quote_line_work;',
  '  parent_protocol SMALLINT;',
  '  expected_mission_id TEXT :=',
  "    nullif(current_setting('app.current_agent_mission_id', true), '');",
  'BEGIN',
  '  IF TG_OP = \'DELETE\' AND pg_trigger_depth() > 1 THEN',
  '    RETURN OLD;',
  '  END IF;',
  '  row_value := CASE WHEN TG_OP = \'DELETE\' THEN OLD ELSE NEW END;',
  '  IF expected_mission_id IS NULL',
  '     OR expected_mission_id <> row_value."missionId"::TEXT THEN',
  "    RAISE EXCEPTION 'AGENT_MISSION_QUOTE_LINE_CAPABILITY_REQUIRED'",
  "      USING ERRCODE = '42501';",
  '  END IF;',
  '  IF TG_OP = \'UPDATE\' AND (',
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
  '  SELECT mission."protocolVersion"',
  '    INTO parent_protocol',
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
  '  RETURN CASE WHEN TG_OP = \'DELETE\' THEN OLD ELSE NEW END;',
  'END;',
  '$agent_mission_quote_line_work_v2$;',
  '',
  'DROP TRIGGER agent_mission_quote_line_work_guard_v1',
  '  ON public.agent_mission_quote_line_work;',
  'CREATE TRIGGER agent_mission_quote_line_work_guard_v2',
  'BEFORE INSERT OR UPDATE OR DELETE ON public.agent_mission_quote_line_work',
  'FOR EACH ROW EXECUTE FUNCTION public.guard_agent_mission_quote_line_work_v2();',
  '',
  revokeDataApiUnderCurrentOwner(
    'agent_mission_quote_line_work',
    'line_work',
    ['guard_agent_mission_quote_line_work_v2'],
  ),
  '',
  'RESET ROLE;',
  ];
}

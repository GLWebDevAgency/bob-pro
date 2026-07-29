#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const apiDirectory = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(apiDirectory, '..', '..');
const quoteLineSourcePath = path.join(
  repositoryRoot,
  'packages/core/src/application/agent-missions/quote-line-work.ts',
);
const catalogueSourcePath = path.join(
  repositoryRoot,
  'packages/core/src/application/catalogue/derive-catalogue.ts',
);
const vatSourcePath = path.join(
  repositoryRoot,
  'packages/core/src/domain/billing/shared/vat-rate.ts',
);
const migrationPath = path.join(
  apiDirectory,
  'prisma/migrations/20260729150000_agent_mission_quote_line_work_expand/migration.sql',
);

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function extractArrayBody(source, name) {
  const match = source.match(
    new RegExp(
      `export const ${escaped(name)}(?:\\s*:[^=]+)?\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*(?:as const)?;`,
      'u',
    ),
  );
  if (match === null) {
    throw new Error(`AGENT_MISSION_M2A_SOURCE_ARRAY_MISSING:${name}`);
  }
  return match[1]
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/.*$/gmu, '')
    .trim();
}

function extractStringArray(source, name) {
  const values = extractArrayBody(source, name)
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '')
    .map((token) => {
      const literal = token.match(/^'([^']+)'$/u);
      if (literal === null) {
        throw new Error(`AGENT_MISSION_M2A_STRING_ARRAY_TOKEN_INVALID:${name}:${token}`);
      }
      return literal[1];
    });
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`AGENT_MISSION_M2A_STRING_ARRAY_INVALID:${name}`);
  }
  return values;
}

function extractNumberArray(source, name) {
  const values = extractArrayBody(source, name)
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '')
    .map((token) => {
      if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(token)) {
        throw new Error(`AGENT_MISSION_M2A_NUMBER_ARRAY_TOKEN_INVALID:${name}:${token}`);
      }
      const number = Number(token);
      if (!Number.isFinite(number) || number < 0) {
        throw new Error(`AGENT_MISSION_M2A_NUMBER_ARRAY_TOKEN_INVALID:${name}:${token}`);
      }
      return String(number);
    });
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`AGENT_MISSION_M2A_NUMBER_ARRAY_INVALID:${name}`);
  }
  return values;
}

function replaceRegion(sql, name, values, quoteValues) {
  const pattern = new RegExp(
    `(^[ \\t]*-- BEGIN GENERATED ${escaped(name)}\\r?\\n)([\\s\\S]*?)(^[ \\t]*-- END GENERATED ${escaped(name)}$)`,
    'gmu',
  );
  let replacementCount = 0;
  const rendered = sql.replace(pattern, (_whole, start, _current, end) => {
    replacementCount += 1;
    const indent = start.match(/^([ \t]*)/u)?.[1] ?? '';
    const lines = values.map((value, index) => {
      const literal = quoteValues ? `'${value}'` : value;
      return `${indent}${literal}${index === values.length - 1 ? '' : ','}`;
    });
    return `${start}${lines.join('\n')}\n${end}`;
  });
  if (replacementCount !== 1) {
    throw new Error(`AGENT_MISSION_M2A_SQL_REGION_COUNT_INVALID:${name}:${replacementCount}`);
  }
  return rendered;
}

function replaceRawRegion(sql, name, body) {
  const pattern = new RegExp(
    `(^[ \\t]*-- BEGIN GENERATED ${escaped(name)}\\r?\\n)([\\s\\S]*?)(^[ \\t]*-- END GENERATED ${escaped(name)}$)`,
    'gmu',
  );
  let replacementCount = 0;
  const rendered = sql.replace(pattern, (_whole, start, _current, end) => {
    replacementCount += 1;
    const indent = start.match(/^([ \t]*)/u)?.[1] ?? '';
    const indentedBody = body
      .split('\n')
      .map((line) => `${indent}${line}`)
      .join('\n');
    return `${start}${indentedBody}\n${end}`;
  });
  if (replacementCount !== 1) {
    throw new Error(`AGENT_MISSION_M2A_SQL_REGION_COUNT_INVALID:${name}:${replacementCount}`);
  }
  return rendered;
}

function parseCodePointRanges(source, name) {
  return extractStringArray(source, name).map((range) => {
    const match = range.match(/^([0-9a-f]{4,6})-([0-9a-f]{4,6})$/u);
    if (match === null) {
      throw new Error(`AGENT_MISSION_M2A_CODE_POINT_RANGE_INVALID:${name}:${range}`);
    }
    const start = Number.parseInt(match[1], 16);
    const end = Number.parseInt(match[2], 16);
    if (start > end || end > 0x10ffff) {
      throw new Error(`AGENT_MISSION_M2A_CODE_POINT_RANGE_INVALID:${name}:${range}`);
    }
    return [start, end];
  });
}

function parseExpansionRules(source) {
  return extractStringArray(source, 'CATALOGUE_SEARCH_EXPANSIONS').map((rule) => {
    const separator = rule.indexOf('=');
    const from = rule.slice(0, separator);
    const to = rule.slice(separator + 1);
    if (
      separator < 1
      || [...from].length !== 1
      || !/^[a-z]{1,2}$/u.test(to)
    ) {
      throw new Error(`AGENT_MISSION_M2A_SEARCH_EXPANSION_INVALID:${rule}`);
    }
    return [from, to];
  });
}

function charactersInRanges(ranges) {
  const characters = [];
  for (const [start, end] of ranges) {
    for (let codePoint = start; codePoint <= end; codePoint += 1) {
      characters.push(String.fromCodePoint(codePoint));
    }
  }
  return characters;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function renderExpansionExpression(rules) {
  return rules.reduce(
    (expression, [from, to]) => (
      `pg_catalog.replace(${expression}, ${sqlLiteral(from)}, ${sqlLiteral(to)})`
    ),
    '"label"',
  );
}

const [quoteLineSource, catalogueSource, vatSource, currentMigration] =
  await Promise.all([
    readFile(quoteLineSourcePath, 'utf8'),
    readFile(catalogueSourcePath, 'utf8'),
    readFile(vatSourcePath, 'utf8'),
    readFile(migrationPath, 'utf8'),
  ]);

const categories = extractStringArray(catalogueSource, 'CATALOGUE_CATEGORIES');
const vatRates = extractNumberArray(vatSource, 'VAT_RATES');
const searchExpansions = parseExpansionRules(catalogueSource);
const ignoredSearchMarks = charactersInRanges(
  parseCodePointRanges(catalogueSource, 'CATALOGUE_SEARCH_IGNORED_MARK_RANGES'),
).join('');
let transliterationSource = '';
let transliterationTarget = '';
for (const character of charactersInRanges(
  parseCodePointRanges(catalogueSource, 'CATALOGUE_SEARCH_LATIN_RANGES'),
)) {
  const normalized = [...character.normalize('NFD')]
    .filter((candidate) => !ignoredSearchMarks.includes(candidate))
    .join('');
  if (/^[A-Za-z]$/u.test(normalized)) {
    transliterationSource += character;
    transliterationTarget += normalized;
  }
}
if (
  [...transliterationSource].length !== [...transliterationTarget].length
  || new Set([...transliterationSource]).size !== [...transliterationSource].length
) {
  throw new Error('AGENT_MISSION_M2A_SEARCH_TRANSLITERATION_INVALID');
}
const regions = [
  {
    name: 'AGENT_MISSION_QUOTE_LINE_WORK_STATES',
    values: extractStringArray(
      quoteLineSource,
      'AGENT_MISSION_QUOTE_LINE_WORK_STATES',
    ),
    quoteValues: true,
  },
  {
    name: 'AGENT_MISSION_QUOTE_LINE_WORK_ORIGINS',
    values: extractStringArray(
      quoteLineSource,
      'AGENT_MISSION_QUOTE_LINE_WORK_ORIGINS',
    ),
    quoteValues: true,
  },
  {
    name: 'AGENT_MISSION_QUOTE_LINE_CATEGORIES',
    values: categories,
    quoteValues: true,
  },
  {
    name: 'AGENT_MISSION_QUOTE_LINE_VAT_RATES',
    values: vatRates,
    quoteValues: false,
  },
  {
    name: 'AGENT_MISSION_QUOTE_LINE_PRICE_BASES',
    values: extractStringArray(
      quoteLineSource,
      'AGENT_MISSION_QUOTE_LINE_PRICE_BASES',
    ),
    quoteValues: true,
  },
  {
    name: 'AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS',
    values: extractStringArray(
      quoteLineSource,
      'AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS',
    ),
    quoteValues: true,
  },
  {
    name: 'CATALOGUE_PRESTATION_CATEGORIES',
    values: categories,
    quoteValues: true,
  },
  {
    name: 'CATALOGUE_PRESTATION_VAT_RATES',
    values: vatRates,
    quoteValues: false,
  },
];

let renderedMigration = regions.reduce(
  (sql, region) => replaceRegion(
    sql,
    region.name,
    region.values,
    region.quoteValues,
  ),
  currentMigration,
);
renderedMigration = replaceRawRegion(
  renderedMigration,
  'CATALOGUE_SEARCH_EXPANSION_EXPRESSION',
  renderExpansionExpression(searchExpansions),
);
renderedMigration = replaceRawRegion(
  renderedMigration,
  'CATALOGUE_SEARCH_TRANSLITERATION_SOURCE',
  sqlLiteral(transliterationSource + ignoredSearchMarks),
);
renderedMigration = replaceRawRegion(
  renderedMigration,
  'CATALOGUE_SEARCH_TRANSLITERATION_TARGET',
  sqlLiteral(transliterationTarget),
);

if (process.argv.includes('--write')) {
  await writeFile(migrationPath, renderedMigration, 'utf8');
  process.stdout.write('AGENT_MISSION_M2A_SQL_VALUES_WRITTEN\n');
} else if (process.argv.includes('--check')) {
  if (renderedMigration !== currentMigration) {
    throw new Error(
      'AGENT_MISSION_M2A_SQL_VALUES_DRIFT: run generate-agent-mission-m2a-foundation-values.mjs --write',
    );
  }
  process.stdout.write('AGENT_MISSION_M2A_SQL_VALUES_OK\n');
} else {
  throw new Error('AGENT_MISSION_M2A_SQL_VALUES_MODE_REQUIRED: --check or --write');
}

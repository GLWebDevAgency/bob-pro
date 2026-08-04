#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../../..');
const migrationPath = path.join(
  repositoryRoot,
  'apps/api/prisma/migrations/20260804010000_document_archive_snapshot_intent_expand/migration.sql',
);
const sourcePath = path.join(
  repositoryRoot,
  'apps/api/src/documents/document-archive-render-snapshot.ts',
);

const blocks = Object.freeze([
  ['DOCUMENT_ARCHIVE_REASON_CHECK', 'DOCUMENT_ARCHIVE_REASONS'],
  ['DOCUMENT_ARCHIVE_REASON_ENQUEUE', 'DOCUMENT_ARCHIVE_REASONS'],
  ['DOCUMENT_ARCHIVE_KIND_CHECK', 'DOCUMENT_ARCHIVE_ARTIFACT_KINDS'],
  ['DOCUMENT_ARCHIVE_KIND_ENQUEUE', 'DOCUMENT_ARCHIVE_ARTIFACT_KINDS'],
  ['DOCUMENT_ARCHIVE_KIND_INTENT', 'DOCUMENT_ARCHIVE_ARTIFACT_KINDS'],
  ['DOCUMENT_ARCHIVE_PROFILE_CHECK', 'DOCUMENT_ARCHIVE_CONTENT_PROFILES'],
  ['DOCUMENT_ARCHIVE_PROFILE_ENQUEUE', 'DOCUMENT_ARCHIVE_CONTENT_PROFILES'],
  ['DOCUMENT_ARCHIVE_PROFILE_INTENT', 'DOCUMENT_ARCHIVE_CONTENT_PROFILES'],
  ['DOCUMENT_ARCHIVE_INVOICE_REASON_INPUT', 'DOCUMENT_ARCHIVE_INVOICE_REASONS'],
  ['DOCUMENT_ARCHIVE_INVOICE_REASON_JOB', 'DOCUMENT_ARCHIVE_INVOICE_REASONS'],
]);

function readClosedValues(source, constantName) {
  const declaration = source.indexOf(`export const ${constantName}`);
  if (declaration < 0) throw new Error(`DOCUMENT_ARCHIVE_SOURCE_MISSING:${constantName}`);
  const open = source.indexOf('[', declaration);
  const close = source.indexOf('] as const', open);
  if (open < 0 || close < 0) throw new Error(`DOCUMENT_ARCHIVE_SOURCE_SHAPE:${constantName}`);
  const tokens = source
    .slice(open + 1, close)
    .replace(/\/\/[^\n]*/gu, '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const values = tokens.map((token) => {
    const match = token.match(/^'([^']+)'$/u);
    if (!match) throw new Error(`DOCUMENT_ARCHIVE_SOURCE_TOKEN:${constantName}:${token}`);
    return match[1];
  });
  if (values.length < 1 || new Set(values).size !== values.length) {
    throw new Error(`DOCUMENT_ARCHIVE_SOURCE_VALUES:${constantName}`);
  }
  for (const value of values) {
    if (!/^[a-z][a-z0-9_-]*$/u.test(value)) {
      throw new Error(`DOCUMENT_ARCHIVE_SOURCE_VALUE:${constantName}:${value}`);
    }
  }
  return values;
}

function replaceBlock(sql, marker, values) {
  const start = `-- ${marker}_START`;
  const end = `-- ${marker}_END`;
  const startIndex = sql.indexOf(start);
  const endIndex = sql.indexOf(end, startIndex + start.length);
  if (
    startIndex < 0
    || endIndex < 0
    || sql.indexOf(start, startIndex + start.length) >= 0
    || sql.indexOf(end, endIndex + end.length) >= 0
  ) throw new Error(`DOCUMENT_ARCHIVE_MIGRATION_MARKER:${marker}`);
  const lineStart = sql.lastIndexOf('\n', startIndex) + 1;
  const indentation = sql.slice(lineStart, startIndex);
  if (!/^\s*$/u.test(indentation)) {
    throw new Error(`DOCUMENT_ARCHIVE_MIGRATION_INDENT:${marker}`);
  }
  const renderedValues = values
    .map((value, index) => (
      `${indentation}'${value.replaceAll("'", "''")}'${index === values.length - 1 ? '' : ','}`
    ))
    .join('\n');
  const replacement = `${start}\n${renderedValues}\n${indentation}${end}`;
  return `${sql.slice(0, startIndex)}${replacement}${sql.slice(endIndex + end.length)}`;
}

const check = process.argv.includes('--check');
const write = process.argv.includes('--write');
if (check === write) {
  throw new Error('Usage: generate-document-archive-snapshot-migration-values.mjs --check|--write');
}

const [source, current] = await Promise.all([
  readFile(sourcePath, 'utf8'),
  readFile(migrationPath, 'utf8'),
]);
let generated = current;
for (const [marker, constantName] of blocks) {
  generated = replaceBlock(generated, marker, readClosedValues(source, constantName));
}
if (check && generated !== current) {
  throw new Error('DOCUMENT_ARCHIVE_SNAPSHOT_MIGRATION_VALUES_DRIFT');
}
if (write) await writeFile(migrationPath, generated, 'utf8');
process.stdout.write(
  `Document archive snapshot migration values ${write ? 'generated' : 'verified'}.\n`,
);

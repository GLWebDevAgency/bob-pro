import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const apiDirectory = path.resolve(scriptDirectory, '..');
const expandPath = path.join(
  apiDirectory,
  'prisma/migrations/20260729140000_customer_siret_expand/migration.sql',
);
const validatePath = path.join(
  apiDirectory,
  'prisma/migrations/20260729140100_customer_siret_validate/migration.sql',
);
const schemaPath = path.join(apiDirectory, 'prisma/schema.prisma');

const [expand, validate, schema] = await Promise.all([
  readFile(expandPath, 'utf8'),
  readFile(validatePath, 'utf8'),
  readFile(schemaPath, 'utf8'),
]);

const constraints = ['customers_siret_shape_check', 'customers_siret_siren_coherence_check'];
const withoutLineComments = (sql) => sql.replace(/^--.*$/gmu, '');

test('les migrations SIRET bornent leurs verrous dans des transactions séparées', () => {
  for (const [name, sql] of [
    ['expand', expand],
    ['validate', validate],
  ]) {
    assert.match(sql, /\bBEGIN;/u, `${name}: transaction absente`);
    assert.match(sql, /SET LOCAL lock_timeout = '[^']+';/u, `${name}: lock_timeout absent`);
    assert.match(
      sql,
      /SET LOCAL statement_timeout = '[^']+';/u,
      `${name}: statement_timeout absent`,
    );
    assert.match(sql, /\bCOMMIT;/u, `${name}: commit absent`);
  }
});

test('l expand reste compatible avec un writer N-1 et ne fabrique aucune donnée', () => {
  const statements = withoutLineComments(expand);
  assert.match(statements, /ADD COLUMN "siret" CHAR\(14\);/u);
  assert.doesNotMatch(statements, /ADD COLUMN "siret"[^;]*(?:NOT NULL|DEFAULT)/u);
  assert.doesNotMatch(statements, /\b(?:UPDATE|INSERT|DELETE)\b/u);
  assert.doesNotMatch(statements, /\b(?:UNIQUE|CREATE\s+(?:UNIQUE\s+)?INDEX)\b/u);
  assert.doesNotMatch(statements, /\bVALIDATE CONSTRAINT\b/u);
  assert.equal((statements.match(/\bNOT VALID\b/gmu) ?? []).length, constraints.length);

  for (const constraint of constraints) {
    assert.match(statements, new RegExp(`ADD CONSTRAINT ${constraint}\\b`, 'u'));
  }
  assert.match(
    statements,
    /"siret" IS NULL\s+OR \("siren" IS NOT NULL AND left\("siret", 9\) = "siren"\)/u,
  );
});

test('la validation ne fait que valider les deux contraintes de l expand', () => {
  const statements = withoutLineComments(validate);
  assert.doesNotMatch(statements, /\bNOT VALID\b/u);
  assert.doesNotMatch(statements, /\b(?:ADD|DROP|RENAME)\s+(?:COLUMN|CONSTRAINT)\b/u);
  assert.equal((statements.match(/\bVALIDATE CONSTRAINT\b/gmu) ?? []).length, constraints.length);

  for (const constraint of constraints) {
    assert.match(statements, new RegExp(`VALIDATE CONSTRAINT ${constraint};`, 'u'));
  }
});

test('le schéma Prisma conserve le SIRET client nullable et sans unicité', () => {
  const customerModel = schema.match(/model Customer \{[\s\S]*?^\}/mu)?.[0];
  assert.ok(customerModel, 'model Customer absent');
  assert.match(customerModel, /^\s*siret\s+String\?\s+@db\.Char\(14\)\s*$/mu);
  assert.doesNotMatch(customerModel, /^\s*siret\s+[^\n]*@unique\b/mu);
  assert.doesNotMatch(customerModel, /@@(?:unique|index)\(\[siret\]/u);
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
const rls = readFileSync(resolve(process.cwd(), 'prisma/rls.sql'), 'utf8');

interface PrismaModel {
  readonly name: string;
  readonly table: string;
  readonly body: string;
}

function prismaModels(source: string): PrismaModel[] {
  return [...source.matchAll(/model\s+(\w+)\s+\{([\s\S]*?)\n\}/gu)].map((match) => {
    const name = match[1]!;
    const body = match[2]!;
    const mapped = body.match(/@@map\("([^"]+)"\)/u)?.[1];
    return { name, table: mapped ?? name, body };
  });
}

function forcedTables(source: string): ReadonlySet<string> {
  const forceLoop = source.match(
    /FOR t IN SELECT unnest\(ARRAY\[([\s\S]*?)\]\) LOOP[\s\S]*?FORCE ROW LEVEL SECURITY/u,
  )?.[1];
  if (forceLoop === undefined) return new Set();
  return new Set([...forceLoop.matchAll(/'([^']+)'/gu)].map((match) => match[1]!));
}

describe('couverture RLS du schéma Prisma tenant', () => {
  it('force RLS sur chaque table métier company/cabinet, sans liste manuelle divergente', () => {
    const required = prismaModels(schema)
      .filter(
        (model) =>
          /^\s*companyId\s+String\??(?:\s|$)/mu.test(model.body)
          || /^\s*cabinetId\s+String\??(?:\s|$)/mu.test(model.body),
      )
      .map((model) => model.table)
      .concat('companies', 'cabinets')
      .sort();
    const forced = forcedTables(rls);
    const missing = required.filter((table) => !forced.has(table));

    expect(missing, `Tables tenant sans FORCE RLS dans prisma/rls.sql: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('garde la table société elle-même sous la policy tenant id = current_company_id', () => {
    expect(rls).toMatch(
      /CREATE POLICY tenant_isolation ON companies\s+USING \(id = current_setting\('app\.current_company_id', true\)\)\s+WITH CHECK \(id = current_setting\('app\.current_company_id', true\)\)/u,
    );
  });
});

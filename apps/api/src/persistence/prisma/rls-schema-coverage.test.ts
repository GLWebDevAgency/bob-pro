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
  const protectedTables = source.match(
    /table_names\s+TEXT\[\]\s*:=\s*ARRAY\[([\s\S]*?)\]\s*::\s*TEXT\[\]\s*;/u,
  )?.[1];
  if (protectedTables === undefined) {
    throw new Error('La liste table_names protégée par RLS est absente de prisma/rls.sql');
  }
  if (
    !/FOREACH\s+t\s+IN\s+ARRAY\s+table_names\s+LOOP[\s\S]*?FORCE ROW LEVEL SECURITY/u.test(
      source,
    )
  ) {
    throw new Error(
      'La liste table_names de prisma/rls.sql n’est pas reliée à FORCE ROW LEVEL SECURITY',
    );
  }
  return new Set([...protectedTables.matchAll(/'([^']+)'/gu)].map((match) => match[1]!));
}

describe('couverture RLS du schéma Prisma tenant', () => {
  it('force RLS sur chaque table métier company/cabinet, sans liste manuelle divergente', () => {
    const required = prismaModels(schema)
      .filter(
        (model) =>
          /^\s*companyId\s+String\??(?:\s|$)/mu.test(model.body) ||
          /^\s*cabinetId\s+String\??(?:\s|$)/mu.test(model.body),
      )
      .map((model) => model.table)
      .concat('companies', 'cabinets')
      .sort();
    const forced = forcedTables(rls);
    const missing = required.filter((table) => !forced.has(table));

    expect(
      missing,
      `Tables tenant sans FORCE RLS dans prisma/rls.sql: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('scope SELECT/INSERT/UPDATE Company au tenant et ne crée aucune policy DELETE', () => {
    const companyPolicies = [...rls.matchAll(/CREATE POLICY (\w+) ON companies([^;]*);/gu)].map(
      (match) => `${match[1]}${match[2]}`,
    );

    expect(companyPolicies).toHaveLength(3);
    expect(companyPolicies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /company_select FOR SELECT\s+USING \(id = current_setting\('app\.current_company_id', true\)\)/u,
        ),
        expect.stringMatching(
          /company_insert FOR INSERT\s+WITH CHECK \(id = current_setting\('app\.current_company_id', true\)\)/u,
        ),
        expect.stringMatching(
          /company_update FOR UPDATE\s+USING \(id = current_setting\('app\.current_company_id', true\)\)\s+WITH CHECK \(id = current_setting\('app\.current_company_id', true\)\)/u,
        ),
      ]),
    );
    expect(companyPolicies.join('\n')).not.toMatch(/FOR (?:ALL|DELETE)\b/u);
  });
});

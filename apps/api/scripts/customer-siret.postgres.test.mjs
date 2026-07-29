import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { boundedPsqlSpawnOptions, withPsqlChildEnvironment } from './psql-child-environment.mjs';

const RUN_CERTIFICATE = process.env.RUN_CUSTOMER_SIRET_POSTGRES_CERT === 'true';
const DEPLOYER_URL = process.env.DIRECT_URL;
const RUNTIME_URL = process.env.DATABASE_URL;
const EXPECTED_DATABASE = 'bob_ephemeral_ci';
const SCHEMA = 'bob_customer_siret_cert';
const QUALIFIED_CUSTOMERS = `"${SCHEMA}"."customers"`;
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

function assertEphemeralLoopback(connectionUrl, name) {
  assert.equal(typeof connectionUrl, 'string', `${name} missing`);
  const parsed = new URL(connectionUrl);
  assert.ok(
    ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname),
    `${name} must target loopback`,
  );
  assert.equal(parsed.pathname.slice(1), EXPECTED_DATABASE, `${name} database mismatch`);
  assert.equal(parsed.search.length, 0, `${name} query parameters are forbidden`);
  assert.equal(parsed.hash.length, 0, `${name} fragment is forbidden`);
}

function psql(connectionUrl, sql, { expectedFailure = false } = {}) {
  const result = withPsqlChildEnvironment(connectionUrl, process.env, (childEnvironment) =>
    spawnSync(
      'psql',
      ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
      boundedPsqlSpawnOptions(childEnvironment, {
        encoding: 'utf8',
        input: sql,
      }),
    ),
  );

  assert.equal(result.error, undefined, result.error?.message);
  if (expectedFailure) {
    assert.notEqual(result.status, 0, 'the invalid write unexpectedly succeeded');
    return result;
  }
  assert.equal(
    result.status,
    0,
    `psql failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function scopeMigration(sql, expectedReferences) {
  const references = sql.match(/public\.customers/gmu) ?? [];
  assert.equal(references.length, expectedReferences);
  return sql.replaceAll('public.customers', QUALIFIED_CUSTOMERS);
}

function tenantTransaction(companyId, statement) {
  assert.match(companyId, /^[a-z0-9-]+$/u);
  return `
BEGIN;
SET LOCAL app.current_company_id = '${companyId}';
${statement}
COMMIT;
`;
}

test(
  'customer SIRET expand/validate preserves N-1 writes and FORCE RLS',
  { skip: !RUN_CERTIFICATE },
  async () => {
    assertEphemeralLoopback(DEPLOYER_URL, 'DIRECT_URL');
    assertEphemeralLoopback(RUNTIME_URL, 'DATABASE_URL');

    const [expandSource, validateSource] = await Promise.all([
      readFile(expandPath, 'utf8'),
      readFile(validatePath, 'utf8'),
    ]);
    const expand = scopeMigration(expandSource, 2);
    const validate = scopeMigration(validateSource, 2);

    psql(DEPLOYER_URL, `DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE;`);
    try {
      const deployerProfile = psql(
        DEPLOYER_URL,
        `
SELECT rolsuper::TEXT || ':' || rolbypassrls::TEXT
  FROM pg_roles
 WHERE rolname = current_user;
`,
      );
      assert.equal(deployerProfile, 'false:true');

      psql(
        DEPLOYER_URL,
        `
CREATE SCHEMA "${SCHEMA}";
CREATE TABLE ${QUALIFIED_CUSTOMERS} (
  "id" TEXT PRIMARY KEY,
  "companyId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "siren" CHAR(9)
);
ALTER TABLE ${QUALIFIED_CUSTOMERS} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${QUALIFIED_CUSTOMERS} FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ${QUALIFIED_CUSTOMERS}
  USING ("companyId" = current_setting('app.current_company_id', TRUE))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', TRUE));
`,
      );

      psql(DEPLOYER_URL, expand);
      assert.equal(
        psql(
          DEPLOYER_URL,
          `
SELECT attnotnull::TEXT || ':' || COALESCE(pg_get_expr(adbin, adrelid), 'NULL')
  FROM pg_attribute
  LEFT JOIN pg_attrdef
    ON adrelid = attrelid
   AND adnum = attnum
 WHERE attrelid = '${QUALIFIED_CUSTOMERS}'::regclass
   AND attname = 'siret';
`,
        ),
        'false:NULL',
      );
      assert.equal(
        psql(
          DEPLOYER_URL,
          `
SELECT string_agg(conname || ':' || convalidated::TEXT, ',' ORDER BY conname)
  FROM pg_constraint
 WHERE conrelid = '${QUALIFIED_CUSTOMERS}'::regclass
   AND conname LIKE 'customers_siret_%';
`,
        ),
        'customers_siret_shape_check:false,customers_siret_siren_coherence_check:false',
      );

      psql(
        DEPLOYER_URL,
        `
GRANT USAGE ON SCHEMA "${SCHEMA}" TO bob_app;
GRANT SELECT, INSERT, UPDATE ON ${QUALIFIED_CUSTOMERS} TO bob_app;
`,
      );
      assert.equal(
        psql(
          RUNTIME_URL,
          `
SELECT rolsuper::TEXT || ':' || rolbypassrls::TEXT
  FROM pg_roles
 WHERE rolname = current_user;
`,
        ),
        'false:false',
      );

      psql(
        RUNTIME_URL,
        tenantTransaction(
          'tenant-a',
          `
INSERT INTO ${QUALIFIED_CUSTOMERS} ("id", "companyId", "name", "siren")
VALUES ('n-minus-one-expand', 'tenant-a', 'Writer N-1 expand', '451321335');
`,
        ),
      );
      psql(
        RUNTIME_URL,
        tenantTransaction(
          'tenant-b',
          `
INSERT INTO ${QUALIFIED_CUSTOMERS} ("id", "companyId", "name", "siren")
VALUES ('tenant-b-row', 'tenant-b', 'Tenant B', '732829320');
`,
        ),
      );
      psql(
        RUNTIME_URL,
        tenantTransaction(
          'tenant-a',
          `
INSERT INTO ${QUALIFIED_CUSTOMERS}
  ("id", "companyId", "name", "siren", "siret")
VALUES
  ('n-expand', 'tenant-a', 'Writer N expand', '451321335', '45132133501021');
`,
        ),
      );

      assert.equal(
        psql(
          RUNTIME_URL,
          tenantTransaction(
            'tenant-a',
            `SELECT string_agg("id", ',' ORDER BY "id") FROM ${QUALIFIED_CUSTOMERS};`,
          ),
        ),
        'n-expand,n-minus-one-expand',
      );
      psql(
        RUNTIME_URL,
        tenantTransaction(
          'tenant-a',
          `
INSERT INTO ${QUALIFIED_CUSTOMERS}
  ("id", "companyId", "name", "siren", "siret")
VALUES
  ('invalid-shape', 'tenant-a', 'Invalid shape', '451321335', '4513213350102X');
`,
        ),
        { expectedFailure: true },
      );
      psql(
        RUNTIME_URL,
        tenantTransaction(
          'tenant-a',
          `
INSERT INTO ${QUALIFIED_CUSTOMERS}
  ("id", "companyId", "name", "siret")
VALUES
  ('missing-siren', 'tenant-a', 'Missing SIREN', '45132133501021');
`,
        ),
        { expectedFailure: true },
      );
      psql(
        RUNTIME_URL,
        tenantTransaction(
          'tenant-a',
          `
INSERT INTO ${QUALIFIED_CUSTOMERS}
  ("id", "companyId", "name", "siren", "siret")
VALUES
  ('incoherent-siren', 'tenant-a', 'Incoherent SIREN', '732829320', '45132133501021');
`,
        ),
        { expectedFailure: true },
      );
      psql(
        RUNTIME_URL,
        tenantTransaction(
          'tenant-a',
          `
INSERT INTO ${QUALIFIED_CUSTOMERS} ("id", "companyId", "name", "siren")
VALUES ('cross-tenant-write', 'tenant-b', 'Cross tenant', '732829320');
`,
        ),
        { expectedFailure: true },
      );

      psql(DEPLOYER_URL, validate);
      assert.equal(
        psql(
          DEPLOYER_URL,
          `
SELECT string_agg(conname || ':' || convalidated::TEXT, ',' ORDER BY conname)
  FROM pg_constraint
 WHERE conrelid = '${QUALIFIED_CUSTOMERS}'::regclass
   AND conname LIKE 'customers_siret_%';
`,
        ),
        'customers_siret_shape_check:true,customers_siret_siren_coherence_check:true',
      );

      psql(
        RUNTIME_URL,
        tenantTransaction(
          'tenant-a',
          `
INSERT INTO ${QUALIFIED_CUSTOMERS} ("id", "companyId", "name", "siren")
VALUES ('n-minus-one-validated', 'tenant-a', 'Writer N-1 validated', '451321335');
UPDATE ${QUALIFIED_CUSTOMERS}
   SET "name" = 'Writer N-1 update'
 WHERE "id" = 'n-expand';
`,
        ),
      );
      assert.equal(
        psql(
          RUNTIME_URL,
          tenantTransaction(
            'tenant-a',
            `
SELECT "siret" || ':' || "name"
  FROM ${QUALIFIED_CUSTOMERS}
 WHERE "id" = 'n-expand';
`,
          ),
        ),
        '45132133501021:Writer N-1 update',
      );
      assert.equal(
        psql(
          DEPLOYER_URL,
          `
SELECT relrowsecurity::TEXT || ':' || relforcerowsecurity::TEXT
  FROM pg_class
 WHERE oid = '${QUALIFIED_CUSTOMERS}'::regclass;
`,
        ),
        'true:true',
      );
    } finally {
      psql(DEPLOYER_URL, `DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE;`);
    }
  },
);

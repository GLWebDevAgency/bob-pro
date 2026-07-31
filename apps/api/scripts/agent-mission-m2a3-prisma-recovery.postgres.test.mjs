import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  M2A3_STAGING_PHASES,
  applyM2A3Migration,
  assertM2A3PhasePostflight,
  assertM2A3RecoveryResolution,
  deriveExpectedM2A3SchemaFingerprints,
  parseM2A3MigrationInventory,
  planM2A3MigrationRecovery,
  resolveM2A3Migration,
  stageM2A3PrismaView,
} from './agent-mission-m2a3-staging-schema.mjs';
import { withPsqlChildEnvironment } from './psql-child-environment.mjs';

const RUN_CERTIFICATE =
  process.env.RUN_AGENT_MISSION_M2A3_PRISMA_RECOVERY_CERT === 'true';
const SUPER_URL = process.env.AGENT_MISSION_CERT_SUPER_URL;
const PSQL = process.env.PSQL_BIN || 'psql';
const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../..');
const TARGET = M2A3_STAGING_PHASES[0].migration;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 20_000;

function psql(url, sql, variables = []) {
  return withPsqlChildEnvironment(
    url,
    process.env,
    (childEnvironment) => spawnSync(
      PSQL,
      [
        '--no-psqlrc',
        '-X',
        '-qAt',
        '-v',
        'ON_ERROR_STOP=1',
        ...variables.flatMap(([name, value]) => ['-v', `${name}=${value}`]),
      ],
      {
        input: sql,
        encoding: 'utf8',
        env: childEnvironment,
        timeout: 45_000,
      },
    ),
  );
}

function mustSucceed(url, sql, variables = []) {
  const result = psql(url, sql, variables);
  assert.equal(
    result.status,
    0,
    `PostgreSQL recovery certificate failed: ${
      String(result.stderr).trim().slice(0, 240)
    }`,
  );
  return String(result.stdout).trim();
}

function connectionUrl(database, username, password, applicationName) {
  assert.ok(SUPER_URL, 'AGENT_MISSION_CERT_SUPER_URL is required');
  const url = new URL(SUPER_URL);
  url.username = username;
  url.password = password;
  url.pathname = `/${database}`;
  if (applicationName === undefined) {
    url.searchParams.delete('application_name');
  } else {
    url.searchParams.set('application_name', applicationName);
  }
  return url.toString();
}

function inventory(url) {
  return parseM2A3MigrationInventory(mustSucceed(url, `
SELECT pg_catalog.format(
         '%s|%s|%s|%s|%s|%s|%s',
         id,
         migration_name,
         checksum,
         CASE WHEN finished_at IS NULL THEN 'false' ELSE 'true' END,
         CASE WHEN rolled_back_at IS NULL THEN 'false' ELSE 'true' END,
         applied_steps_count,
         pg_catalog.floor(
           extract(epoch FROM started_at) * 1000000
         )::BIGINT
       )
  FROM public."_prisma_migrations"
 ORDER BY started_at, id;
`));
}

function writeProbePrismaDirectory(root, migrationSql) {
  const migrations = join(root, 'migrations');
  mkdirSync(migrations, { recursive: true });
  writeFileSync(
    join(root, 'schema.prisma'),
    [
      'datasource db {',
      '  provider  = "postgresql"',
      '  url       = env("DATABASE_URL")',
      '  directUrl = env("DIRECT_URL")',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(migrations, 'migration_lock.toml'),
    'provider = "postgresql"\n',
  );
  const local = new Map();
  for (const { migration } of M2A3_STAGING_PHASES) {
    const directory = join(migrations, migration);
    mkdirSync(directory, { recursive: true });
    const sql = migration === TARGET ? migrationSql : 'SELECT 1;\n';
    writeFileSync(join(directory, 'migration.sql'), sql);
    local.set(
      migration,
      createHash('sha256').update(sql).digest('hex'),
    );
  }
  return local;
}

function runnerConfig(url) {
  return {
    targetMigration: TARGET,
    environment: {
      ...process.env,
      DATABASE_URL: url,
      DIRECT_URL: url,
    },
  };
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

async function pollUntil(probe, description) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    last = await probe();
    if (last === true) return;
    await wait(POLL_INTERVAL_MS);
  }
  assert.fail(`${description} was not observed (last=${String(last).slice(0, 80)})`);
}

function waitForChildExit(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      rejectPromise(new Error('Prisma child did not exit after SIGKILL'));
    }, 10_000);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolvePromise({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
  });
}

function bootstrapIsolatedDatabase(suffix) {
  assert.ok(SUPER_URL, 'AGENT_MISSION_CERT_SUPER_URL is required');
  const role = `m2a3_recovery_${suffix}`;
  const database = `m2a3_recovery_${suffix}`;
  const password = randomBytes(24).toString('hex');
  assert.match(role, IDENTIFIER);
  assert.match(database, IDENTIFIER);
  assert.match(
    mustSucceed(SUPER_URL, 'SHOW server_version_num;'),
    /^17[0-9]{4}$/u,
  );
  mustSucceed(
    SUPER_URL,
    `
SELECT pg_catalog.format(
         'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
         :'role',
         :'password'
       ) \\gexec
SELECT pg_catalog.format(
         'CREATE DATABASE %I OWNER %I',
         :'database',
         :'role'
       ) \\gexec
`,
    [
      ['role', role],
      ['password', password],
      ['database', database],
    ],
  );
  const url = connectionUrl(database, role, password);
  assert.equal(
    mustSucceed(url, `
SELECT pg_catalog.concat_ws(
         '|',
         current_user,
         role.rolsuper,
         role.rolcreatedb,
         role.rolcreaterole,
         role.rolbypassrls,
         pg_catalog.has_schema_privilege(current_user, 'public', 'CREATE')
       )
  FROM pg_catalog.pg_roles AS role
 WHERE role.rolname = current_user;
`),
    `${role}|f|f|f|f|t`,
  );
  return Object.freeze({ role, database, password, url });
}

function cleanupIsolatedDatabase(fixture) {
  if (!SUPER_URL || fixture === null) return;
  mustSucceed(
    SUPER_URL,
    `
SELECT pg_catalog.format(
         'DROP DATABASE IF EXISTS %I WITH (FORCE)',
         :'database'
       ) \\gexec
SELECT pg_catalog.format(
         'DROP ROLE IF EXISTS %I',
         :'role'
       ) \\gexec
`,
    [
      ['database', fixture.database],
      ['role', fixture.role],
    ],
  );
}

test(
  'M2-A-3 — un déployeur non-superuser récupère de vraies coupures avant et après COMMIT',
  { skip: !RUN_CERTIFICATE, timeout: 120_000 },
  async () => {
    const suffix = randomBytes(6).toString('hex');
    const source = mkdtempSync(join(tmpdir(), 'bob-m2a3-prisma-source-'));
    const staged = mkdtempSync(join(tmpdir(), 'bob-m2a3-prisma-stage-'));
    let fixture = null;
    let liveChild = null;
    let liveView = null;
    try {
      fixture = bootstrapIsolatedDatabase(suffix);
      const config = runnerConfig(fixture.url);
      const fingerprints = deriveExpectedM2A3SchemaFingerprints({
        directUrl: fixture.url,
        environment: config.environment,
      });
      assert.equal(
        fingerprints.S1.expandedConstraintExpressionHash,
        fingerprints.S2.expandedConstraintExpressionHash,
      );
      assert.notEqual(
        fingerprints.S1.expandedConstraintDefinitionHash,
        fingerprints.S2.expandedConstraintDefinitionHash,
      );
      assert.equal(
        fingerprints.S3.canonicalConstraintExpressionHash,
        fingerprints.S2.expandedConstraintExpressionHash,
      );
      const failureUrl = new URL(fixture.url);
      failureUrl.searchParams.set(
        'options',
        '-c bob.m2a3_fail_before_commit=on',
      );
      const failureConfig = runnerConfig(failureUrl.toString());
      const dependencies = {
        prismaDirectory: source,
        tmpDirectory: staged,
      };

      const beforeCommitSql = [
        'BEGIN;',
        'CREATE TABLE public.m2a3_prisma_recovery_probe (',
        '  marker TEXT PRIMARY KEY,',
        '  executed_by TEXT NOT NULL DEFAULT current_user',
        ');',
        "INSERT INTO public.m2a3_prisma_recovery_probe (marker) VALUES ('once');",
        'DO $m2a3_before_commit$',
        'BEGIN',
        "  IF current_setting('bob.m2a3_fail_before_commit', TRUE) = 'on' THEN",
        "    RAISE EXCEPTION 'M2A3_CERT_BEFORE_COMMIT';",
        '  END IF;',
        'END;',
        '$m2a3_before_commit$;',
        'COMMIT;',
        '',
      ].join('\n');
      const beforeCommitLocal = writeProbePrismaDirectory(
        source,
        beforeCommitSql,
      );
      assert.throws(
        () => applyM2A3Migration(
          failureConfig,
          beforeCommitLocal,
          dependencies,
        ),
        /Prisma migrate command failed/u,
      );
      assert.equal(
        mustSucceed(
          fixture.url,
          "SELECT pg_catalog.to_regclass('public.m2a3_prisma_recovery_probe') IS NULL;",
        ),
        't',
      );
      const rolledBackBefore = inventory(fixture.url);
      assert.equal(
        rolledBackBefore.filter(
          ({ name, finished, rolledBack, appliedSteps }) =>
            name === TARGET
            && !finished
            && !rolledBack
            && appliedSteps === 0,
        ).length,
        1,
      );
      const rolledBackPlan = planM2A3MigrationRecovery(
        rolledBackBefore,
        beforeCommitLocal,
        'expand',
        'S0',
      );
      assert.equal(rolledBackPlan.recoveryAction, 'rolled_back');
      resolveM2A3Migration(
        config,
        beforeCommitLocal,
        rolledBackPlan.recoveryAction,
        dependencies,
      );
      const rolledBackAfter = inventory(fixture.url);
      assert.equal(
        assertM2A3RecoveryResolution(
          rolledBackBefore,
          rolledBackAfter,
          beforeCommitLocal,
          'expand',
          rolledBackPlan,
        ).operation,
        'apply',
      );
      applyM2A3Migration(config, beforeCommitLocal, dependencies);
      assert.equal(
        mustSucceed(
          fixture.url,
          'SELECT marker || \'|\' || executed_by FROM public.m2a3_prisma_recovery_probe;',
        ),
        `once|${fixture.role}`,
      );
      assert.equal(
        assertM2A3PhasePostflight(
          inventory(fixture.url),
          beforeCommitLocal,
          'expand',
        ).stateAfter,
        'S1',
      );

      mustSucceed(fixture.url, `
DROP TABLE public.m2a3_prisma_recovery_probe;
DROP TABLE public."_prisma_migrations";
`);
      rmSync(source, { recursive: true, force: true });
      mkdirSync(source, { recursive: true });
      const afterCommitSql = [
        'BEGIN;',
        'CREATE TABLE public.m2a3_prisma_recovery_probe (',
        '  marker TEXT PRIMARY KEY,',
        '  executed_by TEXT NOT NULL DEFAULT current_user',
        ');',
        "INSERT INTO public.m2a3_prisma_recovery_probe (marker) VALUES ('once');",
        'COMMIT;',
        'SELECT pg_catalog.pg_sleep(60);',
        '',
      ].join('\n');
      const afterCommitLocal = writeProbePrismaDirectory(
        source,
        afterCommitSql,
      );
      const applicationName = `bob_m2a3_recovery_${suffix}`;
      const killUrl = connectionUrl(
        fixture.database,
        fixture.role,
        fixture.password,
        applicationName,
      );
      const killConfig = runnerConfig(killUrl);
      liveView = stageM2A3PrismaView(
        TARGET,
        afterCommitLocal,
        dependencies,
      );
      liveChild = spawn(
        'pnpm',
        [
          '--filter',
          '@bob/api',
          'exec',
          'prisma',
          'migrate',
          'deploy',
          '--schema',
          liveView.schemaPath,
        ],
        {
          cwd: REPOSITORY_ROOT,
          detached: true,
          env: killConfig.environment,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let childOutput = '';
      for (const stream of [liveChild.stdout, liveChild.stderr]) {
        stream?.on('data', (chunk) => {
          childOutput = `${childOutput}${String(chunk)}`.slice(-4_096);
        });
      }
      await pollUntil(() => {
        if (liveChild?.exitCode !== null) {
          return `child-exited:${liveChild?.exitCode}:${childOutput.slice(-160)}`;
        }
        const relations = mustSucceed(killUrl, `
SELECT pg_catalog.concat_ws(
         '|',
         pg_catalog.to_regclass(
           'public.m2a3_prisma_recovery_probe'
         ) IS NOT NULL,
         pg_catalog.to_regclass(
           'public._prisma_migrations'
         ) IS NOT NULL
       );
`);
        if (relations !== 't|t') return relations;
        const observed = mustSucceed(killUrl, `
SELECT pg_catalog.concat_ws(
         '|',
         (
           SELECT pg_catalog.count(*)
             FROM public."_prisma_migrations"
            WHERE migration_name = '${TARGET}'
              AND finished_at IS NULL
              AND rolled_back_at IS NULL
         ),
         (
           SELECT pg_catalog.count(*)
             FROM pg_catalog.pg_stat_activity
            WHERE usename = current_user
              AND application_name = '${applicationName}'
              AND state = 'active'
              AND wait_event = 'PgSleep'
         )
       );
`);
        return observed === '1|1' ? true : observed;
      }, 'post-COMMIT pre-ACK Prisma window');
      const exitPromise = waitForChildExit(liveChild);
      process.kill(-liveChild.pid, 'SIGKILL');
      const killed = await exitPromise;
      assert.equal(killed.signal, 'SIGKILL');
      liveChild = null;
      mustSucceed(
        SUPER_URL,
        `
SELECT pg_catalog.pg_terminate_backend(activity.pid)
  FROM pg_catalog.pg_stat_activity AS activity
 WHERE activity.usename = :'role'
   AND activity.application_name = :'application_name'
   AND activity.pid <> pg_catalog.pg_backend_pid();
`,
        [
          ['role', fixture.role],
          ['application_name', applicationName],
        ],
      );
      await pollUntil(() => (
        mustSucceed(killUrl, `
SELECT pg_catalog.count(*) = 0
  FROM pg_catalog.pg_stat_activity
 WHERE usename = current_user
   AND application_name = '${applicationName}'
   AND wait_event = 'PgSleep';
`) === 't'
          ? true
          : false
      ), 'terminated Prisma backend');
      rmSync(liveView.root, { recursive: true, force: true });
      liveView = null;

      const appliedBefore = inventory(killUrl);
      assert.equal(
        mustSucceed(
          killUrl,
          'SELECT marker || \'|\' || executed_by FROM public.m2a3_prisma_recovery_probe;',
        ),
        `once|${fixture.role}`,
      );
      const appliedPlan = planM2A3MigrationRecovery(
        appliedBefore,
        afterCommitLocal,
        'expand',
        'S1',
      );
      assert.equal(appliedPlan.recoveryAction, 'applied');
      resolveM2A3Migration(
        killConfig,
        afterCommitLocal,
        appliedPlan.recoveryAction,
        dependencies,
      );
      const appliedAfter = inventory(killUrl);
      assert.equal(
        assertM2A3RecoveryResolution(
          appliedBefore,
          appliedAfter,
          afterCommitLocal,
          'expand',
          appliedPlan,
        ).operation,
        'recertify',
      );
      applyM2A3Migration(killConfig, afterCommitLocal, dependencies);
      assert.deepEqual(inventory(killUrl), appliedAfter);
      assert.equal(
        mustSucceed(
          killUrl,
          'SELECT pg_catalog.count(*) FROM public.m2a3_prisma_recovery_probe WHERE marker = \'once\';',
        ),
        '1',
      );
    } finally {
      if (liveChild?.pid) {
        try {
          process.kill(-liveChild.pid, 'SIGKILL');
        } catch {
          // Le groupe est déjà terminé.
        }
      }
      if (liveView !== null) {
        rmSync(liveView.root, { recursive: true, force: true });
      }
      rmSync(source, { recursive: true, force: true });
      rmSync(staged, { recursive: true, force: true });
      cleanupIsolatedDatabase(fixture);
    }
  },
);

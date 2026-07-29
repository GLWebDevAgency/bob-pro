import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  K2_MIGRATION_NAME,
  assertK2PostflightMigrationState,
  assertK2PreflightMigrationState,
  assertK2SchemaState,
  buildK2Evidence,
  hashK2ForeignAuthoritySnapshot,
  parseK2MigrationInventory,
  parseK2StagingEnvironment,
  runK2StagingSchema,
  summarizeK2PostgresFailure,
} from './agent-mission-k2-staging-schema.mjs';

const BASE_MIGRATION = '20260701000000_base';
const BASE_CHECKSUM = 'a'.repeat(64);
const K2_CHECKSUM = 'b'.repeat(64);
const RELEASE_SHA = 'c'.repeat(40);
const AUTHORITY_HASH = 'd'.repeat(64);

function environment(overrides = {}) {
  return {
    CABINET_RELEASE_ENV: 'staging',
    BOB_K2_RELEASE_SHA: RELEASE_SHA,
    APP_DATABASE_ROLE: 'bob_app',
    BOB_M1B_STAGING_COMPANY_ID: 'staging-company',
    BOB_M1B_STAGING_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
    BOB_M1B_STAGING_DATABASE_SYSTEM_IDENTIFIER: '1234567890123456789',
    BOB_M1B_STAGING_DATABASE_OID: '16384',
    BOB_M1B_STAGING_DATABASE_NAME: 'postgres',
    DIRECT_URL:
      'postgresql://postgres.project:direct-secret@db.example.test/postgres',
    DATABASE_URL:
      'postgresql://bob_app.project:runtime-secret@pool.example.test/postgres',
    GITHUB_RUN_ID: '30459326369',
    GITHUB_RUN_ATTEMPT: '1',
    ...overrides,
  };
}

function localMigrations(extra = []) {
  return new Map([
    [BASE_MIGRATION, BASE_CHECKSUM],
    [K2_MIGRATION_NAME, K2_CHECKSUM],
    ...extra,
  ]);
}

function migrationRow({
  name = BASE_MIGRATION,
  checksum = BASE_CHECKSUM,
  finished = true,
  rolledBack = false,
  appliedSteps = 1,
} = {}) {
  return Object.freeze({
    name,
    checksum,
    finished,
    rolledBack,
    appliedSteps,
  });
}

function preflightInventory() {
  return [migrationRow()];
}

function postflightInventory(overrides = {}) {
  return [
    migrationRow(),
    migrationRow({
      name: K2_MIGRATION_NAME,
      checksum: K2_CHECKSUM,
      ...overrides,
    }),
  ];
}

function foregroundIndex(columns, owner = 'bob_schema_owner') {
  return {
    owner,
    accessMethod: 'btree',
    unique: true,
    valid: true,
    ready: true,
    live: true,
    keyAttributeCount: columns.length,
    attributeCount: columns.length,
    keyColumns: columns,
    predicate: "status='active'::text",
  };
}

function schemaState({
  postflight = false,
  owner = 'bob_schema_owner',
  overrides = {},
} = {}) {
  const ownerIsDeployer = owner === 'postgres';
  const state = {
    sessionUser: 'postgres',
    currentUser: 'postgres',
    tableOwner: owner,
    ownerRole: {
      login: ownerIsDeployer,
      superuser: false,
      bypassRls: ownerIsDeployer,
      createDatabase: ownerIsDeployer,
      createRole: ownerIsDeployer,
      inherit: ownerIsDeployer,
    },
    directOwnerMembership: ownerIsDeployer
      ? null
      : {
          set: true,
          inherit: false,
          admin: true,
        },
    deployerCanSetOwner: true,
    rowSecurity: true,
    forceRowSecurity: true,
    kindConstraintValidated: true,
    indexes: {
      agent_missions_one_active_owner_kind_key: foregroundIndex(
        ['"companyId"', '"ownerUserId"', 'kind'],
        owner,
      ),
      ...(postflight
        ? {
            agent_missions_one_active_owner_key: foregroundIndex(
              ['"companyId"', '"ownerUserId"'],
              owner,
            ),
          }
        : {}),
    },
    ...overrides,
  };
  return JSON.stringify(state);
}

test('le parseur refuse tout environnement autre que staging et toute identité ambiguë', () => {
  const parsed = parseK2StagingEnvironment('apply', environment());
  assert.equal(parsed.releaseSha, RELEASE_SHA);
  assert.equal(parsed.appRole, 'bob_app');
  assert.match(parsed.databasePinHash, /^[a-f0-9]{64}$/u);
  assert.notEqual(parsed.n1OwnerUserId, parsed.crossOwnerUserId);
  assert.throws(
    () =>
      parseK2StagingEnvironment(
        'apply',
        environment({ CABINET_RELEASE_ENV: 'production' }),
      ),
    /staging-only/u,
  );
  assert.throws(
    () => parseK2StagingEnvironment('inspect', environment()),
    /command must be apply/u,
  );
  assert.throws(
    () =>
      parseK2StagingEnvironment(
        'apply',
        environment({ BOB_K2_RELEASE_SHA: 'main' }),
      ),
    /exact commit SHA/u,
  );
  assert.throws(
    () =>
      parseK2StagingEnvironment(
        'apply',
        environment({ GITHUB_RUN_ATTEMPT: '0' }),
      ),
    /run identity must be canonical/u,
  );
});

test('l’inventaire Prisma rejette les lignes partielles et les états impossibles', () => {
  assert.deepEqual(
    parseK2MigrationInventory(
      `${BASE_MIGRATION}|${BASE_CHECKSUM}|true|false|1\n`,
    ),
    preflightInventory(),
  );
  assert.throws(
    () => parseK2MigrationInventory('not-a-row'),
    /inventory is malformed/u,
  );
  assert.throws(
    () =>
      parseK2MigrationInventory(
        `${BASE_MIGRATION}|${BASE_CHECKSUM}|true|true|1`,
      ),
    /impossible terminal state/u,
  );
});

test('le preflight exige K2 comme unique pending ou une reprise K2 terminale exacte', () => {
  const result = assertK2PreflightMigrationState(
    preflightInventory(),
    localMigrations(),
  );
  assert.deepEqual(result, {
    operation: 'apply',
    appliedCount: 1,
    pendingCount: 1,
    targetChecksum: K2_CHECKSUM,
  });
  assert.deepEqual(
    assertK2PreflightMigrationState(
      postflightInventory(),
      localMigrations(),
    ),
    {
      operation: 'recertify',
      appliedCount: 2,
      pendingCount: 0,
      targetChecksum: K2_CHECKSUM,
    },
  );
  assert.throws(
    () =>
      assertK2PreflightMigrationState(
        [
          migrationRow({
            finished: false,
            rolledBack: false,
            appliedSteps: 0,
          }),
        ],
        localMigrations(),
      ),
    /unresolved migration/u,
  );
  assert.throws(
    () =>
      assertK2PreflightMigrationState(
        postflightInventory({ appliedSteps: 2 }),
        localMigrations(),
      ),
    /recovery state is not exact/u,
  );
  assert.throws(
    () =>
      assertK2PreflightMigrationState(
        postflightInventory({
          finished: false,
          rolledBack: true,
          appliedSteps: 0,
        }),
        localMigrations(),
      ),
    /recovery state is not exact/u,
  );
  assert.throws(
    () =>
      assertK2PreflightMigrationState(
        [
          ...postflightInventory(),
          migrationRow({
            name: K2_MIGRATION_NAME,
            checksum: K2_CHECKSUM,
          }),
        ],
        localMigrations(),
      ),
    /history is ambiguous/u,
  );
  assert.throws(
    () =>
      assertK2PreflightMigrationState(
        preflightInventory(),
        localMigrations([['20260702000000_unrelated', 'e'.repeat(64)]]),
      ),
    /pending migration set is not exactly K2/u,
  );
  assert.throws(
    () =>
      assertK2PreflightMigrationState(
        [migrationRow({ checksum: 'f'.repeat(64) })],
        localMigrations(),
      ),
    /checksum proof failed/u,
  );
});

test('le postflight exige une unique ligne K2 finie en une étape et zéro pending', () => {
  const result = assertK2PostflightMigrationState(
    postflightInventory(),
    localMigrations(),
  );
  assert.deepEqual(result, {
    appliedCount: 2,
    pendingCount: 0,
    targetChecksum: K2_CHECKSUM,
  });
  assert.throws(
    () =>
      assertK2PostflightMigrationState(
        postflightInventory({ appliedSteps: 2 }),
        localMigrations(),
      ),
    /terminal record is not exact/u,
  );
  assert.throws(
    () =>
      assertK2PostflightMigrationState(
        postflightInventory({ checksum: 'f'.repeat(64) }),
        localMigrations(),
      ),
    /terminal record is not exact/u,
  );
  assert.throws(
    () =>
      assertK2PostflightMigrationState(
        preflightInventory(),
        localMigrations(),
      ),
    /terminal record is not exact/u,
  );
});

test('le schéma staging exige postgres propriétaire non-superuser et les index exacts', () => {
  assert.equal(
    assertK2SchemaState(
      schemaState({ postflight: true, owner: 'postgres' }),
      'recertification',
    ).schemaOwner,
    'postgres',
  );
  assert.equal(
    assertK2SchemaState(
      schemaState({ postflight: true, owner: 'postgres' }),
      'postflight',
    ).sessionUser,
    'postgres',
  );
  assert.throws(
    () => assertK2SchemaState(schemaState(), 'preflight'),
    /schema authority drifted/u,
  );
  assert.throws(
    () =>
      assertK2SchemaState(
        schemaState({
          owner: 'postgres',
          overrides: {
            ownerRole: {
              login: true,
              superuser: true,
              bypassRls: true,
              createDatabase: true,
              createRole: true,
              inherit: true,
            },
          },
        }),
        'preflight',
      ),
    /schema authority drifted/u,
  );
  assert.throws(
    () =>
      assertK2SchemaState(
        schemaState({
          owner: 'postgres',
          overrides: {
            currentUser: 'bob_schema_owner',
          },
        }),
        'preflight',
      ),
    /schema authority drifted/u,
  );
  assert.throws(
    () =>
      assertK2SchemaState(
        schemaState({
          owner: 'postgres',
          overrides: {
            directOwnerMembership: {
              set: true,
              inherit: true,
              admin: true,
            },
          },
        }),
        'preflight',
      ),
    /schema authority drifted/u,
  );
  assert.throws(
    () =>
      assertK2SchemaState(
        schemaState({ owner: 'postgres' }),
        'postflight',
      ),
    /foreground index definition drifted/u,
  );
  const preflightWithGlobal = JSON.parse(
    schemaState({ postflight: true, owner: 'postgres' }),
  );
  assert.throws(
    () => assertK2SchemaState(preflightWithGlobal, 'preflight'),
    /already exists before migration/u,
  );
});

test('le snapshot étranger est borné, JSON et converti uniquement en hash', () => {
  assert.match(
    hashK2ForeignAuthoritySnapshot('{"capacity":{"mode":"active"}}'),
    /^[a-f0-9]{64}$/u,
  );
  assert.throws(
    () => hashK2ForeignAuthoritySnapshot('[]'),
    /snapshot is invalid/u,
  );
  assert.throws(
    () => hashK2ForeignAuthoritySnapshot('{'),
    /snapshot is invalid/u,
  );
});

test('le diagnostic PostgreSQL ne conserve que SQLSTATE et autorité non-PII', () => {
  const summary = summarizeK2PostgresFailure(`
ERROR:  23514: new row for relation "agent_missions" violates check constraint "agent_missions_kind_check"
DETAIL:  Failing row contains (company-secret, owner-secret).
CONSTRAINT NAME:  agent_missions_kind_check
LOCATION:  ExecConstraints, execMain.c:2094
  `);
  assert.equal(
    summary,
    'sqlstate=23514,constraint=agent_missions_kind_check',
  );
  assert.doesNotMatch(summary, /company-secret|owner-secret/u);
  assert.equal(
    summarizeK2PostgresFailure(
      'ERROR:  P0001: AGENT_MISSION_K2_N1_WRITER_UNEXPECTEDLY_REJECTED',
    ),
    'sqlstate=P0001,authority=AGENT_MISSION_K2_N1_WRITER_UNEXPECTEDLY_REJECTED',
  );
});

test('la preuve publiée est allowlistée et ne contient ni URL, tenant ni secret', () => {
  const config = parseK2StagingEnvironment('apply', environment());
  const evidence = buildK2Evidence({
    status: 'certified',
    operation: 'apply',
    config,
    migration: {
      appliedCount: 2,
      pendingCount: 0,
      targetChecksum: K2_CHECKSUM,
    },
    schemaOwner: 'postgres',
    foreignAuthorityHash: AUTHORITY_HASH,
    n1WriterOutcome: 'accepted',
    timestamp: '2026-07-29T12:00:00.000Z',
  });
  const serialized = JSON.stringify(evidence);
  assert.equal(evidence.status, 'certified');
  assert.equal(evidence.operation, 'apply');
  assert.equal(evidence.releaseSha, RELEASE_SHA);
  assert.doesNotMatch(serialized, /direct-secret|runtime-secret|staging-company/u);
  assert.doesNotMatch(serialized, /postgresql:|ownerUserId|companyId/u);
  assert.deepEqual(Object.keys(evidence).sort(), [
    'appliedMigrationCount',
    'databasePinHash',
    'foreignAuthorityHash',
    'githubRunAttempt',
    'githubRunId',
    'migrationChecksum',
    'migrationName',
    'n1WriterOutcome',
    'observedAt',
    'operation',
    'pendingMigrationCount',
    'releaseSha',
    'schema',
    'schemaOwner',
    'status',
    'version',
  ]);
});

function orchestrationDependencies(events, options = {}) {
  let inventoryRead = 0;
  let schemaRead = 0;
  let authorityRead = 0;
  const authorityHashes = options.authorityHashes ?? [
    AUTHORITY_HASH,
    AUTHORITY_HASH,
  ];
  return {
    certifyDatabase() {
      events.push('database');
    },
    async readLocalMigrationChecksums() {
      events.push('local-migrations');
      return localMigrations();
    },
    readMigrationInventory() {
      inventoryRead += 1;
      events.push(`migration-inventory:${inventoryRead}`);
      if (options.recertify) return postflightInventory();
      return inventoryRead === 1
        ? preflightInventory()
        : postflightInventory();
    },
    readSchemaState() {
      schemaRead += 1;
      events.push(`schema:${schemaRead}`);
      return schemaState({
        postflight: options.recertify || schemaRead === 2,
        owner: options.owner ?? 'postgres',
      });
    },
    assertNoResidue() {
      events.push('no-residue');
    },
    foreignAuthorityHash() {
      const value = authorityHashes[authorityRead];
      authorityRead += 1;
      events.push(`foreign-authority:${authorityRead}`);
      return value;
    },
    writeEvidence(evidence) {
      events.push(`evidence:${evidence.status}`);
      return `/evidence/${evidence.status}.json`;
    },
    applyMigration() {
      events.push('migrate');
      if (options.migrationFailure) throw new Error('migration failed');
    },
    certifyAcl() {
      events.push('acl');
    },
    certifyN1Writer() {
      events.push('writer-n1');
      return options.n1WriterOutcome ?? 'disabled-fence';
    },
    certifyCrossKind() {
      events.push('cross-kind');
    },
    now() {
      return '2026-07-29T12:00:00.000Z';
    },
  };
}

test('l’orchestrateur suit l’ordre identity→preflight→migrate→certifications→preuve', async () => {
  const events = [];
  const result = await runK2StagingSchema(
    'apply',
    environment(),
    orchestrationDependencies(events),
  );
  assert.deepEqual(events, [
    'database',
    'local-migrations',
    'migration-inventory:1',
    'schema:1',
    'no-residue',
    'foreign-authority:1',
    'evidence:preflight',
    'migrate',
    'migration-inventory:2',
    'schema:2',
    'acl',
    'writer-n1',
    'cross-kind',
    'no-residue',
    'foreign-authority:2',
    'evidence:certified',
  ]);
  assert.equal(result.status, 'certified');
  assert.equal(result.pendingMigrationCount, 0);
});

test('un échec de migration conserve seulement la preuve preflight', async () => {
  const events = [];
  await assert.rejects(
    runK2StagingSchema(
      'apply',
      environment(),
      orchestrationDependencies(events, { migrationFailure: true }),
    ),
    /migration failed/u,
  );
  assert.equal(events.includes('evidence:preflight'), true);
  assert.equal(events.includes('evidence:certified'), false);
  assert.equal(events.includes('acl'), false);
});

test('un retry post-migration recertifie strictement sans rejouer Prisma', async () => {
  const events = [];
  const result = await runK2StagingSchema(
    'apply',
    environment(),
    orchestrationDependencies(events, {
      recertify: true,
      owner: 'postgres',
    }),
  );
  assert.equal(events.includes('migrate'), false);
  assert.equal(result.operation, 'recertify');
  assert.deepEqual(events, [
    'database',
    'local-migrations',
    'migration-inventory:1',
    'schema:1',
    'no-residue',
    'foreign-authority:1',
    'evidence:preflight',
    'migration-inventory:2',
    'schema:2',
    'acl',
    'writer-n1',
    'cross-kind',
    'no-residue',
    'foreign-authority:2',
    'evidence:certified',
  ]);
});

test('toute dérive d’autorité étrangère interdit la certification', async () => {
  const events = [];
  await assert.rejects(
    runK2StagingSchema(
      'apply',
      environment(),
      orchestrationDependencies(events, {
        authorityHashes: [AUTHORITY_HASH, 'e'.repeat(64)],
      }),
    ),
    /foreign protocol authority changed/u,
  );
  assert.equal(events.includes('evidence:certified'), false);
});

test('le workflow route K2 sans aucun chemin vers une release ou un activateur', () => {
  const repositoryRoot = resolve(import.meta.dirname, '../../..');
  const workflow = readFileSync(
    resolve(repositoryRoot, '.github/workflows/railway-api.yml'),
    'utf8',
  );
  const source = readFileSync(
    resolve(
      repositoryRoot,
      'apps/api/scripts/agent-mission-k2-staging-schema.mjs',
    ),
    'utf8',
  );
  const start = workflow.indexOf('  certify-agent-mission-k2-staging-schema:\n');
  const end = workflow.indexOf('\n  release-api:\n', start);
  assert.ok(start >= 0 && end > start, 'K2 staging job must be isolated');
  const job = workflow.slice(start, end);
  assert.match(
    workflow,
    /validate-purpose:[\s\S]*?Unsupported Railway release purpose/u,
  );
  assert.match(
    workflow,
    /release-api:[\s\S]*?inputs\.purpose == 'release'/u,
  );
  assert.match(job, /environment: staging/u);
  assert.match(job, /group: railway-api-staging/u);
  assert.match(
    job,
    /railway run --project "\$RAILWAY_PROJECT_ID"[\s\S]*?--service "\$RAILWAY_API_SERVICE_ID"[\s\S]*?--environment "\$RAILWAY_ENVIRONMENT_ID"[\s\S]*?--no-local/u,
  );
  assert.doesNotMatch(
    job,
    /railway up|release\.sh|activate-|manage-agent-mission-fingerprint|capacity-configure|m1b-staging-release\.mjs\s+(?:predeploy|postdeploy|restore-capacity)/u,
  );
  assert.match(
    source,
    /\['--filter', '@bob\/api', 'exec', 'prisma', 'migrate', 'deploy'\]/u,
  );
  assert.doesNotMatch(source, /migrate\s+resolve/u);
  assert.match(
    source,
    /INSERT INTO public\.agent_mission_events[\s\S]*?SET CONSTRAINTS ALL IMMEDIATE;[\s\S]*?ROLLBACK;/u,
  );
  assert.match(
    source,
    /minimumWriterVersion[\s\S]*?'fingerprint_key_version', fingerprintKeyVersion/u,
  );
  assert.match(
    source,
    /agent_mission_fingerprint_key_writer_disabled[\s\S]*?disabled-fence/u,
  );
  assert.match(source, /FROM public\.release_flag_subjects AS subject/u);
  assert.match(
    source,
    /SET LOCAL ROLE bob_realtime_capacity;[\s\S]*?FROM public\.realtime_global_capacity/u,
  );
  assert.match(
    source,
    /format\('SET LOCAL ROLE %I', :'schema_owner'\) \\\\gexec[\s\S]*?ALTER TABLE public\.agent_missions/u,
  );
  assert.match(
    source,
    /format\('SET LOCAL ROLE %I', :'schema_owner'\) \\\\gexec[\s\S]*?FROM public\.agent_missions/u,
  );
  assert.match(
    source,
    /FROM public\.agent_mission_events[\s\S]*?FROM public\.quote_draft_slots/u,
  );
  assert.match(
    source,
    /staging-schema-\$\{config\.releaseSha\}-\$\{evidence\.status\}\.json/u,
  );
  const crossKindBody =
    /DO \$agent_mission_k2_cross_kind\$([\s\S]*?)\$agent_mission_k2_cross_kind\$;/u.exec(
      source,
    )?.[1];
  assert.ok(crossKindBody, 'cross-kind DO body must exist');
  assert.doesNotMatch(
    crossKindBody,
    /:'[a-z_][a-z0-9_]*'/u,
    'psql variables are not expanded inside a dollar-quoted DO body',
  );
  const n1WriterBody =
    /DO \$agent_mission_k2_n1_writer\$([\s\S]*?)\$agent_mission_k2_n1_writer\$;/u.exec(
      source,
    )?.[1];
  assert.ok(n1WriterBody, 'N-1 writer DO body must exist');
  assert.doesNotMatch(
    n1WriterBody,
    /:'[a-z_][a-z0-9_]*'/u,
    'psql variables are not expanded inside a dollar-quoted DO body',
  );
  assert.match(job, /include-hidden-files: true/u);
  assert.match(job, /if-no-files-found: error/u);
});

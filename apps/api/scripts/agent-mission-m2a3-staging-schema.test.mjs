import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  M2A3_STAGING_PHASES,
  assertM2A3PhasePostflight,
  assertM2A3PhasePreflight,
  assertM2A3RecoveryResolution,
  assertM2A3SchemaState,
  applyM2A3Migration,
  buildM2A3Evidence,
  finalizeM2A3StagingEvidence,
  parseM2A3FingerprintWriterState,
  parseM2A3MigrationInventory,
  parseM2A3StagingEnvironment,
  parseM2A3WriterMatrix,
  planM2A3MigrationRecovery,
  resolveM2A3Migration,
  runM2A3StagingPhase,
  stageM2A3PrismaView,
  summarizeM2A3PostgresFailure,
  summarizeM2A3PrismaFailure,
} from './agent-mission-m2a3-staging-schema.mjs';

const BASE_MIGRATION = '20260701000000_base';
const BASE_CHECKSUM = 'a'.repeat(64);
const RELEASE_SHA = 'b'.repeat(40);
const AUTHORITY_HASH = 'c'.repeat(64);
const CANONICAL_DEFINITION_HASH = 'd'.repeat(64);
const CANONICAL_EXPRESSION_HASH = '4'.repeat(64);
const EXPANDED_UNVALIDATED_DEFINITION_HASH = 'e'.repeat(64);
const EXPANDED_VALIDATED_DEFINITION_HASH = '6'.repeat(64);
const EXPANDED_EXPRESSION_HASH = '7'.repeat(64);
const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../..');

const PHASE_CHECKSUMS = new Map(
  M2A3_STAGING_PHASES.map(({ migration }, index) => [
    migration,
    String(index + 1).repeat(64),
  ]),
);

function environment(phase = 'expand', overrides = {}) {
  const phaseIndex = M2A3_STAGING_PHASES.findIndex(
    (candidate) => candidate.phase === phase,
  );
  return {
    CABINET_RELEASE_ENV: 'staging',
    BOB_M2A3_EXPECTED_SHA: RELEASE_SHA,
    GITHUB_SHA: RELEASE_SHA,
    GITHUB_RUN_ID: '30459326369',
    GITHUB_RUN_ATTEMPT: '1',
    APP_DATABASE_ROLE: 'bob_app',
    BOB_M2A3_PREVIOUS_RECEIPT_DIGEST:
      phaseIndex === 0 ? 'none' : 'f'.repeat(64),
    BOB_M1B_STAGING_SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
    BOB_M1B_STAGING_DATABASE_SYSTEM_IDENTIFIER: '1234567890123456789',
    BOB_M1B_STAGING_DATABASE_OID: '16384',
    BOB_M1B_STAGING_DATABASE_NAME: 'postgres',
    SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    DIRECT_URL:
      'postgresql://postgres.abcdefghijklmnopqrst:direct@db.test/postgres',
    DATABASE_URL:
      'postgresql://bob_app.abcdefghijklmnopqrst:runtime@pool.test/postgres',
    ...overrides,
  };
}

function localMigrations() {
  return new Map([
    [BASE_MIGRATION, BASE_CHECKSUM],
    ...M2A3_STAGING_PHASES.map(({ migration }) => [
      migration,
      PHASE_CHECKSUMS.get(migration),
    ]),
  ]);
}

function migrationRow(
  name = BASE_MIGRATION,
  checksum = BASE_CHECKSUM,
  overrides = {},
) {
  const { attempt = 0, ...rowOverrides } = overrides;
  const digest = createHash('sha256')
    .update(`${name}:${attempt}`)
    .digest('hex');
  return Object.freeze({
    id: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${
      digest.slice(13, 16)
    }-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
    name,
    checksum,
    finished: true,
    rolledBack: false,
    appliedSteps: 1,
    startedAtMicros: String(
      1_785_000_000_000_000n + BigInt(attempt),
    ),
    ...rowOverrides,
  });
}

function inventoryHistory(inventory) {
  const ordered = [...inventory].sort((left, right) => {
    const timeOrder =
      BigInt(left.startedAtMicros) < BigInt(right.startedAtMicros)
        ? -1
        : BigInt(left.startedAtMicros) > BigInt(right.startedAtMicros)
          ? 1
          : 0;
    return timeOrder || left.id.localeCompare(right.id);
  });
  return {
    historyDigest: createHash('sha256')
      .update(JSON.stringify(ordered))
      .digest('hex'),
    rolledBackCount: ordered.filter(({ rolledBack }) => rolledBack).length,
    unresolvedCount: ordered.filter(
      ({ finished, rolledBack }) => !finished && !rolledBack,
    ).length,
  };
}

function inventoryAt(appliedTargetCount) {
  return [
    migrationRow(),
    ...M2A3_STAGING_PHASES
      .slice(0, appliedTargetCount)
      .map(({ migration }, index) => migrationRow(
        migration,
        PHASE_CHECKSUMS.get(migration),
        { attempt: index + 1 },
      )),
  ];
}

function constraint(validated, definition) {
  return {
    validated,
    type: 'c',
    noInherit: false,
    definition,
    expression: definition
      .replace(/\s+NOT VALID$/u, '')
      .replace(/^CHECK \(/u, '')
      .replace(/\)$/u, ''),
  };
}

function schemaState(stateName, overrides = {}) {
  const constraints = stateName === 'S1'
    ? {
        agent_mission_events_data_check:
          constraint(true, 'CHECK ((canonical_payload_is_valid))'),
        agent_mission_events_data_m2a3_check:
          constraint(false, 'CHECK ((expanded_payload_is_valid)) NOT VALID'),
      }
    : stateName === 'S2'
      ? {
          agent_mission_events_data_check:
            constraint(true, 'CHECK ((canonical_payload_is_valid))'),
          agent_mission_events_data_m2a3_check:
            constraint(true, 'CHECK ((expanded_payload_is_valid))'),
        }
      : stateName === 'S3'
        ? {
            agent_mission_events_data_check:
              constraint(true, 'CHECK ((expanded_payload_is_valid))'),
          }
        : {
          agent_mission_events_data_check:
            constraint(true, 'CHECK ((canonical_payload_is_valid))'),
        };
  return JSON.stringify({
    sessionUser: 'postgres',
    currentUser: 'postgres',
    relations: {
      agent_mission_events: {
        owner: 'bob_schema_owner',
        rowSecurity: true,
        forceRowSecurity: true,
        deployerCanSetOwner: true,
      },
      release_flags: {
        owner: 'bob_schema_owner',
        rowSecurity: true,
        forceRowSecurity: true,
        deployerCanSetOwner: true,
      },
    },
    constraints,
    dataApiPrivilegeCount: 0,
    runtimeEventSelect: true,
    runtimeEventInsert: true,
    flagCount: 3,
    flagOffCount: 3,
    enabledSubjectCount: 0,
    ...overrides,
  });
}

function writerMatrix(stateName) {
  return parseM2A3WriterMatrix(
    stateName === 'S3'
      ? 'sealed=accepted|null_pair=accepted|mixed_id_null=rejected|mixed_null_hash=rejected'
      : 'sealed=accepted|null_pair=rejected|mixed_id_null=rejected|mixed_null_hash=rejected',
    stateName,
  );
}

function expectedSchemaFingerprints() {
  return Object.freeze(Object.fromEntries(
    ['S0', 'S1', 'S2', 'S3'].map((stateName) => {
      const schema = assertM2A3SchemaState(
        schemaState(stateName),
        stateName,
      );
      return [
        stateName,
        Object.freeze({
          canonicalConstraintDefinitionHash:
            schema.canonicalConstraintDefinitionHash,
          canonicalConstraintExpressionHash:
            schema.canonicalConstraintExpressionHash,
          expandedConstraintDefinitionHash:
            schema.expandedConstraintDefinitionHash,
          expandedConstraintExpressionHash:
            schema.expandedConstraintExpressionHash,
        }),
      ];
    }),
  ));
}

test('l’environnement est staging-only, lié au SHA exact et à une chaîne de reçus', () => {
  const parsed = parseM2A3StagingEnvironment('expand', environment());
  assert.equal(parsed.expectedSha, RELEASE_SHA);
  assert.equal(parsed.previousReceiptDigest, null);
  assert.match(parsed.databasePinHash, /^[a-f0-9]{64}$/u);
  assert.throws(
    () => parseM2A3StagingEnvironment(
      'expand',
      environment('expand', { CABINET_RELEASE_ENV: 'production' }),
    ),
    /staging-only/u,
  );
  assert.throws(
    () => parseM2A3StagingEnvironment(
      'expand',
      environment('expand', { BOB_M2A3_EXPECTED_SHA: 'main' }),
    ),
    /expected SHA/u,
  );
  assert.throws(
    () => parseM2A3StagingEnvironment(
      'validate',
      environment('validate', {
        BOB_M2A3_PREVIOUS_RECEIPT_DIGEST: 'none',
      }),
    ),
    /previous receipt digest/u,
  );
});

test('l’inventaire rejette les états Prisma ambigus ou non terminaux', () => {
  const base = migrationRow();
  assert.deepEqual(
    parseM2A3MigrationInventory(
      `${base.id}|${BASE_MIGRATION}|${BASE_CHECKSUM}|true|false|1|${
        base.startedAtMicros
      }`,
    ),
    [base],
  );
  assert.throws(
    () => parseM2A3MigrationInventory('not-a-row'),
    /inventory is malformed/u,
  );
  assert.throws(
    () => parseM2A3MigrationInventory(
      `${base.id}|${BASE_MIGRATION}|${BASE_CHECKSUM}|true|true|1|${
        base.startedAtMicros
      }`,
    ),
    /impossible terminal state/u,
  );
});

test('chaque phase exige le préfixe exact, le suffixe M2-A-3 exact et son checksum', () => {
  const local = localMigrations();
  assert.deepEqual(
    assertM2A3PhasePreflight(inventoryAt(0), local, 'expand'),
    {
      operation: 'apply',
      appliedCount: 1,
      pendingCount: 3,
      ...inventoryHistory(inventoryAt(0)),
      targetChecksum: PHASE_CHECKSUMS.get(
        M2A3_STAGING_PHASES[0].migration,
      ),
      stateBefore: 'S0',
    },
  );
  assert.deepEqual(
    assertM2A3PhasePreflight(inventoryAt(1), local, 'expand'),
    {
      operation: 'recertify',
      appliedCount: 2,
      pendingCount: 2,
      ...inventoryHistory(inventoryAt(1)),
      targetChecksum: PHASE_CHECKSUMS.get(
        M2A3_STAGING_PHASES[0].migration,
      ),
      stateBefore: 'S1',
    },
  );
  assert.deepEqual(
    assertM2A3PhasePostflight(inventoryAt(2), local, 'validate'),
    {
      appliedCount: 3,
      pendingCount: 1,
      ...inventoryHistory(inventoryAt(2)),
      targetChecksum: PHASE_CHECKSUMS.get(
        M2A3_STAGING_PHASES[1].migration,
      ),
      stateAfter: 'S2',
    },
  );
  assert.throws(
    () => assertM2A3PhasePreflight(inventoryAt(2), local, 'expand'),
    /future phase attempt/u,
  );
  for (const { phase } of M2A3_STAGING_PHASES) {
    const terminalPreflight = assertM2A3PhasePreflight(
      inventoryAt(3),
      local,
      phase,
    );
    assert.equal(terminalPreflight.operation, 'recertify');
    assert.equal(terminalPreflight.stateBefore, 'S3');
    assert.equal(terminalPreflight.pendingCount, 0);
    const terminalPostflight = assertM2A3PhasePostflight(
      inventoryAt(3),
      local,
      phase,
    );
    assert.equal(terminalPostflight.stateAfter, 'S3');
    assert.equal(terminalPostflight.pendingCount, 0);
  }
  assert.throws(
    () => assertM2A3PhasePreflight(
      inventoryAt(0),
      new Map([
        ...local,
        ['20260731115000_foreign_pending', '9'.repeat(64)],
      ]),
      'expand',
    ),
    /non-M2-A-3 migration is pending/u,
  );
  assert.throws(
    () => assertM2A3PhasePostflight(
      [
        ...inventoryAt(1),
        migrationRow(
          M2A3_STAGING_PHASES[0].migration,
          PHASE_CHECKSUMS.get(M2A3_STAGING_PHASES[0].migration),
          { attempt: 1 },
        ),
      ],
      local,
      'expand',
    ),
    /chronology is ambiguous/u,
  );
});

test('la reprise Prisma distingue rollback SQL et COMMIT sans acquittement', () => {
  const local = localMigrations();
  const target = M2A3_STAGING_PHASES[0].migration;
  const unresolved = migrationRow(
    target,
    PHASE_CHECKSUMS.get(target),
    {
      finished: false,
      rolledBack: false,
      appliedSteps: 0,
    },
  );
  const before = [migrationRow(), unresolved];

  const rolledBackPlan = planM2A3MigrationRecovery(
    before,
    local,
    'expand',
    'S0',
  );
  assert.equal(rolledBackPlan.recoveryAction, 'rolled_back');
  const afterRolledBack = [
    migrationRow(),
    Object.freeze({ ...unresolved, rolledBack: true }),
  ];
  const applyPreflight = assertM2A3RecoveryResolution(
    before,
    afterRolledBack,
    local,
    'expand',
    rolledBackPlan,
  );
  assert.equal(applyPreflight.operation, 'apply');
  assert.equal(applyPreflight.rolledBackCount, 1);

  const appliedPlan = planM2A3MigrationRecovery(
    before,
    local,
    'expand',
    'S1',
  );
  assert.equal(appliedPlan.recoveryAction, 'applied');
  const afterApplied = [
    migrationRow(),
    Object.freeze({ ...unresolved, rolledBack: true }),
    migrationRow(
      target,
      PHASE_CHECKSUMS.get(target),
      { attempt: 1, appliedSteps: 0 },
    ),
  ];
  const recertifyPreflight = assertM2A3RecoveryResolution(
    before,
    afterApplied,
    local,
    'expand',
    appliedPlan,
  );
  assert.equal(recertifyPreflight.operation, 'recertify');
  assert.equal(recertifyPreflight.rolledBackCount, 1);
  const sameTimeAcknowledgement = [
    migrationRow(),
    Object.freeze({ ...unresolved, rolledBack: true }),
    Object.freeze({
      ...afterApplied[2],
      startedAtMicros: unresolved.startedAtMicros,
    }),
  ];
  assert.throws(
    () => assertM2A3RecoveryResolution(
      before,
      sameTimeAcknowledgement,
      local,
      'expand',
      appliedPlan,
    ),
    /exact Prisma acknowledgement/u,
  );

  assert.throws(
    () => planM2A3MigrationRecovery(
      [...before, migrationRow(
        M2A3_STAGING_PHASES[1].migration,
        PHASE_CHECKSUMS.get(M2A3_STAGING_PHASES[1].migration),
        {
          attempt: 1,
          finished: false,
          rolledBack: false,
          appliedSteps: 0,
        },
      )],
      local,
      'expand',
      'S0',
    ),
    /multiple unresolved/u,
  );
  assert.throws(
    () => planM2A3MigrationRecovery(before, local, 'expand', 'S2'),
    /not recoverable/u,
  );
  for (const sibling of [
    migrationRow(
      target,
      PHASE_CHECKSUMS.get(target),
      {
        attempt: 1,
        finished: false,
        rolledBack: true,
        appliedSteps: 0,
      },
    ),
    migrationRow(
      target,
      PHASE_CHECKSUMS.get(target),
      {
        attempt: 2,
        finished: false,
        rolledBack: true,
        appliedSteps: 0,
        startedAtMicros: unresolved.startedAtMicros,
      },
    ),
  ]) {
    assert.throws(
      () => planM2A3MigrationRecovery(
        [...before, sibling],
        local,
        'expand',
        'S0',
      ),
      /chronology is ambiguous/u,
    );
  }
});

test('la lignée M2-A-3 refuse les phases futures et chronologies inversées', () => {
  const local = localMigrations();
  const [expand, validate] = M2A3_STAGING_PHASES;
  assert.ok(expand);
  assert.ok(validate);
  const chronologyRoot = 1_785_000_001_000_000n;
  const expandActiveLate = migrationRow(
    expand.migration,
    PHASE_CHECKSUMS.get(expand.migration),
    {
      attempt: 3,
      startedAtMicros: String(chronologyRoot + 300n),
    },
  );
  const validateUnresolvedEarly = migrationRow(
    validate.migration,
    PHASE_CHECKSUMS.get(validate.migration),
    {
      attempt: 2,
      finished: false,
      rolledBack: false,
      appliedSteps: 0,
      startedAtMicros: String(chronologyRoot + 200n),
    },
  );
  assert.throws(
    () => planM2A3MigrationRecovery(
      [migrationRow(), expandActiveLate, validateUnresolvedEarly],
      local,
      'validate',
      'S1',
    ),
    /chronology/u,
  );

  const futureRolledBack = migrationRow(
    validate.migration,
    PHASE_CHECKSUMS.get(validate.migration),
    {
      attempt: 1,
      finished: false,
      rolledBack: true,
      appliedSteps: 0,
      startedAtMicros: String(chronologyRoot + 100n),
    },
  );
  assert.throws(
    () => assertM2A3PhasePreflight(
      [migrationRow(), futureRolledBack],
      local,
      'expand',
    ),
    /future phase attempt/u,
  );

  const validateActiveEarly = Object.freeze({
    ...validateUnresolvedEarly,
    finished: true,
  });
  assert.throws(
    () => assertM2A3PhasePreflight(
      [migrationRow(), expandActiveLate, validateActiveEarly],
      local,
      'validate',
    ),
    /chronology/u,
  );

  const tiedExpandRollbackStartedAt = String(chronologyRoot + 100n);
  const tiedExpandRollbacks = [1, 2].map((attempt) =>
    migrationRow(
      expand.migration,
      PHASE_CHECKSUMS.get(expand.migration),
      {
        attempt,
        finished: false,
        rolledBack: true,
        appliedSteps: 0,
        startedAtMicros: tiedExpandRollbackStartedAt,
      },
    ));
  const recoveredExpand = migrationRow(
    expand.migration,
    PHASE_CHECKSUMS.get(expand.migration),
    {
      attempt: 3,
      appliedSteps: 0,
      startedAtMicros: String(chronologyRoot + 200n),
    },
  );
  const validateAfterAmbiguousRecovery = migrationRow(
    validate.migration,
    PHASE_CHECKSUMS.get(validate.migration),
    {
      attempt: 4,
      startedAtMicros: String(chronologyRoot + 300n),
    },
  );
  assert.throws(
    () => assertM2A3PhasePreflight(
      [
        migrationRow(),
        ...tiedExpandRollbacks,
        recoveredExpand,
        validateAfterAmbiguousRecovery,
      ],
      local,
      'validate',
    ),
    /chronology is ambiguous/u,
  );
});

test('les quatre états vérifient RLS forcée, Data API fermée, flags OFF et CHECK exacts', () => {
  for (const stateName of ['S0', 'S1', 'S2', 'S3']) {
    const result = assertM2A3SchemaState(schemaState(stateName), stateName);
    assert.equal(result.schemaOwner, 'bob_schema_owner');
    assert.equal(result.releaseFlagsOwner, 'bob_schema_owner');
    assert.match(
      result.canonicalConstraintDefinitionHash,
      /^[a-f0-9]{64}$/u,
    );
    assert.match(
      result.canonicalConstraintExpressionHash,
      /^[a-f0-9]{64}$/u,
    );
    if (stateName === 'S1' || stateName === 'S2') {
      assert.match(
        result.expandedConstraintDefinitionHash,
        /^[a-f0-9]{64}$/u,
      );
      assert.match(
        result.expandedConstraintExpressionHash,
        /^[a-f0-9]{64}$/u,
      );
    } else {
      assert.equal(result.expandedConstraintDefinitionHash, null);
      assert.equal(result.expandedConstraintExpressionHash, null);
    }
  }
  assert.throws(
    () => assertM2A3SchemaState(
      schemaState('S1', { dataApiPrivilegeCount: 1 }),
      'S1',
    ),
    /RLS, ACL or flag fence/u,
  );
  assert.throws(
    () => assertM2A3SchemaState(
      schemaState('S1', {
        relations: {
          agent_mission_events: {
            owner: 'bob_schema_owner',
            rowSecurity: true,
            forceRowSecurity: false,
            deployerCanSetOwner: true,
          },
          release_flags: {
            owner: 'bob_schema_owner',
            rowSecurity: true,
            forceRowSecurity: true,
            deployerCanSetOwner: true,
          },
        },
      }),
      'S1',
    ),
    /protected relation authority/u,
  );
});

test('la matrice writer N-1 et la fence fingerprint sont fail-closed', () => {
  assert.equal(writerMatrix('S0').null_pair, 'rejected');
  assert.equal(writerMatrix('S3').null_pair, 'accepted');
  assert.equal(
    parseM2A3FingerprintWriterState('1|false|true'),
    'disabled-fence',
  );
  assert.throws(
    () => parseM2A3FingerprintWriterState('1|true|true'),
    /remain disabled/u,
  );
  assert.throws(
    () => parseM2A3WriterMatrix(
      'sealed=accepted|null_pair=accepted|mixed_id_null=accepted|mixed_null_hash=rejected',
      'S3',
    ),
    /writer N-1 matrix drifted/u,
  );
});

test('le diagnostic PostgreSQL est borné à SQLSTATE, ligne, contrainte et autorité', () => {
  const summary = summarizeM2A3PostgresFailure(`
ERROR:  23514: new row violates check constraint
DETAIL:  Failing row contains (tenant-secret, owner-secret).
LINE 42: INSERT INTO public.agent_mission_events
CONSTRAINT NAME:  agent_mission_events_data_check
  `);
  assert.equal(
    summary,
    'sqlstate=23514,line=42,constraint=agent_mission_events_data_check',
  );
  assert.doesNotMatch(summary, /tenant-secret|owner-secret/u);
  assert.equal(
    summarizeM2A3PostgresFailure(
      'ERROR:  P0001: AGENT_MISSION_M2A3_WRITER_MATRIX_DRIFT',
    ),
    'sqlstate=P0001,authority=AGENT_MISSION_M2A3_WRITER_MATRIX_DRIFT',
  );
});

test('le diagnostic Prisma classe la cause sans recopier SQL, URL ou donnée tenant', () => {
  assert.equal(
    summarizeM2A3PrismaFailure(
      'Error: P3009 failed migration tenant-secret postgresql://secret',
    ),
    'prisma=P3009',
  );
  assert.equal(
    summarizeM2A3PrismaFailure('ERROR: 55P03: lock timeout tenant-secret'),
    'prisma=lock-timeout',
  );
  assert.equal(
    summarizeM2A3PrismaFailure('P3018 migration failed for tenant-secret'),
    'prisma=P3018',
  );
  assert.equal(
    summarizeM2A3PrismaFailure('arbitrary tenant-secret'),
    'prisma=unknown',
  );
});

test('le certificat writer ne pollue jamais stdout avec la phase configurée', () => {
  const sql = readFileSync(
    join(
      REPOSITORY_ROOT,
      'apps/api/prisma/agent-mission-m2a3-writer-n1-cert.sql',
    ),
    'utf8',
  );
  assert.match(sql, /AS configured_state\n\\gset/u);
  const configurationStatement = sql.slice(
    sql.indexOf('SELECT pg_catalog.set_config('),
    sql.indexOf('\\gset') + '\\gset'.length,
  );
  assert.doesNotMatch(configurationStatement, /;/u);
});

test('la vue Prisma temporaire contient exactement le préfixe jusqu’à la phase', () => {
  const source = mkdtempSync(join(tmpdir(), 'bob-m2a3-source-'));
  const destination = mkdtempSync(join(tmpdir(), 'bob-m2a3-destination-'));
  try {
    const migrations = join(source, 'migrations');
    mkdirSync(migrations);
    writeFileSync(join(source, 'schema.prisma'), 'generator client {}\n');
    writeFileSync(join(migrations, 'migration_lock.toml'), 'provider = "postgresql"\n');
    for (const name of localMigrations().keys()) {
      mkdirSync(join(migrations, name));
      writeFileSync(join(migrations, name, 'migration.sql'), `-- ${name}\n`);
    }
    const target = M2A3_STAGING_PHASES[1].migration;
    const view = stageM2A3PrismaView(target, localMigrations(), {
      prismaDirectory: source,
      tmpDirectory: destination,
    });
    assert.deepEqual(
      readdirSync(join(view.root, 'migrations')).sort(),
      [
        BASE_MIGRATION,
        M2A3_STAGING_PHASES[0].migration,
        M2A3_STAGING_PHASES[1].migration,
        'migration_lock.toml',
      ].sort(),
    );
    assert.equal(
      readdirSync(join(view.root, 'migrations')).includes(
        M2A3_STAGING_PHASES[2].migration,
      ),
      false,
    );
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

test('le runner Prisma n’autorise que deploy ou resolve exact de la phase', () => {
  const source = mkdtempSync(join(tmpdir(), 'bob-m2a3-runner-source-'));
  const destination = mkdtempSync(join(tmpdir(), 'bob-m2a3-runner-destination-'));
  const calls = [];
  try {
    const migrations = join(source, 'migrations');
    mkdirSync(migrations);
    writeFileSync(join(source, 'schema.prisma'), 'generator client {}\n');
    writeFileSync(
      join(migrations, 'migration_lock.toml'),
      'provider = "postgresql"\n',
    );
    for (const name of localMigrations().keys()) {
      mkdirSync(join(migrations, name));
      writeFileSync(join(migrations, name, 'migration.sql'), `-- ${name}\n`);
    }
    const config = parseM2A3StagingEnvironment('expand', environment());
    const dependencies = {
      prismaDirectory: source,
      tmpDirectory: destination,
      spawnSync(command, args) {
        calls.push([command, args]);
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    applyM2A3Migration(config, localMigrations(), dependencies);
    resolveM2A3Migration(
      config,
      localMigrations(),
      'rolled_back',
      dependencies,
    );
    resolveM2A3Migration(
      config,
      localMigrations(),
      'applied',
      dependencies,
    );

    assert.match(calls[0][1].join(' '), /migrate deploy --schema/u);
    assert.match(
      calls[1][1].join(' '),
      new RegExp(`migrate resolve --schema .* --rolled-back ${
        M2A3_STAGING_PHASES[0].migration
      }`, 'u'),
    );
    assert.match(
      calls[2][1].join(' '),
      new RegExp(`migrate resolve --schema .* --applied ${
        M2A3_STAGING_PHASES[0].migration
      }`, 'u'),
    );
    assert.throws(
      () => resolveM2A3Migration(
        config,
        localMigrations(),
        'manual',
        dependencies,
      ),
      /not governed/u,
    );
    assert.throws(
      () => applyM2A3Migration(config, localMigrations(), {
        ...dependencies,
        spawnSync() {
          return {
            status: 1,
            stdout: '',
            stderr:
              'P3009 tenant-secret postgresql://user:password@example.test/db',
          };
        },
      }),
      (error) => {
        assert.match(error.message, /prisma=P3009/u);
        assert.doesNotMatch(
          error.message,
          /tenant-secret|password|example\.test/u,
        );
        return true;
      },
    );
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});

test('une phase applique une seule migration puis produit une preuve publique chaînable', async () => {
  const events = [];
  const evidenceDirectory = mkdtempSync(join(tmpdir(), 'bob-m2a3-evidence-'));
  let inventoryRead = 0;
  let schemaRead = 0;
  try {
    const result = await runM2A3StagingPhase(
      'expand',
      environment(),
      {
        evidenceDirectory,
        certifyDatabase() {
          events.push('database');
        },
        deriveExpectedSchemaFingerprints: expectedSchemaFingerprints,
        async readLocalMigrationChecksums() {
          events.push('local');
          return localMigrations();
        },
        readMigrationInventory() {
          inventoryRead += 1;
          events.push(`inventory:${inventoryRead}`);
          return inventoryAt(inventoryRead - 1);
        },
        readSchemaState() {
          schemaRead += 1;
          events.push(`schema:${schemaRead}`);
          return schemaState(schemaRead === 1 ? 'S0' : 'S1');
        },
        foreignAuthorityHash() {
          events.push('authority');
          return AUTHORITY_HASH;
        },
        applyMigration() {
          events.push('apply');
        },
        certifyAcl() {
          events.push('acl');
        },
        certifyWriterMatrix(_config, stateName) {
          events.push('writer-matrix');
          return writerMatrix(stateName);
        },
        fingerprintWriterOutcome() {
          events.push('fingerprint');
          return 'disabled-fence';
        },
      },
    );
    assert.equal(result.evidence.state, 'S1');
    assert.equal(result.evidence.operation, 'apply');
    assert.equal(result.evidence.runtimeWriterOutcome, 'disabled-fence');
    assert.match(result.digest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(events, [
      'database',
      'local',
      'inventory:1',
      'schema:1',
      'authority',
      'acl',
      'writer-matrix',
      'fingerprint',
      'apply',
      'inventory:2',
      'schema:2',
      'authority',
      'acl',
      'writer-matrix',
      'fingerprint',
    ]);
    const serialized = readFileSync(result.path, 'utf8');
    assert.doesNotMatch(
      serialized,
      /postgresql:|direct@|runtime@|abcdefghijklmnopqrst/u,
    );
  } finally {
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
});

test('une phase récupère exactement les interruptions Prisma avant et après COMMIT', async () => {
  const target = M2A3_STAGING_PHASES[0].migration;
  const unresolved = migrationRow(
    target,
    PHASE_CHECKSUMS.get(target),
    {
      finished: false,
      rolledBack: false,
      appliedSteps: 0,
    },
  );
  const historicalRolledBack = migrationRow(
    target,
    PHASE_CHECKSUMS.get(target),
    {
      attempt: -1,
      finished: false,
      rolledBack: true,
      appliedSteps: 0,
    },
  );
  const cleanPlan = planM2A3MigrationRecovery(
    [migrationRow(), unresolved],
    localMigrations(),
    'expand',
    'S0',
  );
  const planWithHistory = planM2A3MigrationRecovery(
    [migrationRow(), historicalRolledBack, unresolved],
    localMigrations(),
    'expand',
    'S0',
  );
  assert.notEqual(
    cleanPlan?.recoveryHistoryDigest,
    planWithHistory?.recoveryHistoryDigest,
  );
  for (const scenario of [
    {
      recoveryAction: 'rolled_back',
      initialState: 'S0',
      resolvedState: 'S0',
      certifiedState: 'S1',
      operation: 'apply',
      priorAttempts: [historicalRolledBack],
      resolvedInventory: [
        migrationRow(),
        historicalRolledBack,
        Object.freeze({ ...unresolved, rolledBack: true }),
      ],
      certifiedInventory: [
        migrationRow(),
        historicalRolledBack,
        Object.freeze({ ...unresolved, rolledBack: true }),
        migrationRow(
          target,
          PHASE_CHECKSUMS.get(target),
          { attempt: 1 },
        ),
      ],
    },
    {
      recoveryAction: 'applied',
      initialState: 'S1',
      resolvedState: 'S1',
      certifiedState: 'S1',
      operation: 'recertify',
      priorAttempts: [],
      resolvedInventory: [
        migrationRow(),
        Object.freeze({ ...unresolved, rolledBack: true }),
        migrationRow(
          target,
          PHASE_CHECKSUMS.get(target),
          { attempt: 1, appliedSteps: 0 },
        ),
      ],
      certifiedInventory: [
        migrationRow(),
        Object.freeze({ ...unresolved, rolledBack: true }),
        migrationRow(
          target,
          PHASE_CHECKSUMS.get(target),
          { attempt: 1, appliedSteps: 0 },
        ),
      ],
    },
  ]) {
    const evidenceDirectory = mkdtempSync(
      join(tmpdir(), `bob-m2a3-recovery-${scenario.recoveryAction}-`),
    );
    let inventoryRead = 0;
    let schemaRead = 0;
    let resolvedAs = null;
    let applyCount = 0;
    try {
      const result = await runM2A3StagingPhase(
        'expand',
        environment(),
        {
          evidenceDirectory,
          certifyDatabase() {},
          deriveExpectedSchemaFingerprints: expectedSchemaFingerprints,
          async readLocalMigrationChecksums() {
            return localMigrations();
          },
          readMigrationInventory() {
            inventoryRead += 1;
            if (inventoryRead === 1) {
              return [
                migrationRow(),
                ...scenario.priorAttempts,
                unresolved,
              ];
            }
            if (inventoryRead === 2) return scenario.resolvedInventory;
            return scenario.certifiedInventory;
          },
          readSchemaState() {
            schemaRead += 1;
            if (schemaRead === 1) return schemaState(scenario.initialState);
            if (schemaRead === 2) return schemaState(scenario.resolvedState);
            return schemaState(scenario.certifiedState);
          },
          foreignAuthorityHash() {
            return AUTHORITY_HASH;
          },
          certifyAcl() {},
          certifyWriterMatrix(_config, stateName) {
            return writerMatrix(stateName);
          },
          fingerprintWriterOutcome() {
            return 'disabled-fence';
          },
          resolveMigration(_config, _local, action) {
            resolvedAs = action;
          },
          applyMigration() {
            applyCount += 1;
          },
        },
      );
      assert.equal(resolvedAs, scenario.recoveryAction);
      assert.equal(result.evidence.recoveryAction, scenario.recoveryAction);
      assert.equal(result.evidence.operation, scenario.operation);
      assert.equal(
        result.evidence.migrationRolledBackCount,
        1 + scenario.priorAttempts.length,
      );
      assert.equal(
        applyCount,
        scenario.operation === 'apply' ? 1 : 0,
      );
      assert.doesNotMatch(
        readFileSync(result.path, 'utf8'),
        /postgresql:|tenant-secret|direct@|runtime@/u,
      );
      const reconstructedDirectory = mkdtempSync(
        join(tmpdir(), `bob-m2a3-reconstructed-${scenario.recoveryAction}-`),
      );
      try {
        const reconstructed = await runM2A3StagingPhase(
          'expand',
          environment(),
          {
            evidenceDirectory: reconstructedDirectory,
            certifyDatabase() {},
            deriveExpectedSchemaFingerprints: expectedSchemaFingerprints,
            async readLocalMigrationChecksums() {
              return localMigrations();
            },
            readMigrationInventory() {
              return scenario.certifiedInventory;
            },
            readSchemaState() {
              return schemaState('S1');
            },
            foreignAuthorityHash() {
              return AUTHORITY_HASH;
            },
            certifyAcl() {},
            certifyWriterMatrix(_config, stateName) {
              return writerMatrix(stateName);
            },
            fingerprintWriterOutcome() {
              return 'disabled-fence';
            },
            resolveMigration() {
              assert.fail('terminal recovery must not resolve twice');
            },
          },
        );
        assert.equal(
          reconstructed.evidence.recoverySource,
          'terminal-history',
        );
        assert.equal(
          reconstructed.evidence.recoveryIntentDigest,
          result.evidence.recoveryIntentDigest,
        );
        assert.equal(reconstructed.evidence.operation, 'recertify');
        if (scenario.recoveryAction === 'rolled_back') {
          let previousReceiptDigest = reconstructed.digest;
          previousReceiptDigest = writeEvidencePair({
            directory: reconstructedDirectory,
            index: 1,
            operation: 'apply',
            previousReceiptDigest,
            runAttempt: 2,
            observedMinute: 10,
            rolledBackCount: 2,
            stateFingerprints: expectedSchemaFingerprints(),
          });
          previousReceiptDigest = writeEvidencePair({
            directory: reconstructedDirectory,
            index: 2,
            operation: 'apply',
            previousReceiptDigest,
            runAttempt: 3,
            observedMinute: 20,
            rolledBackCount: 2,
            stateFingerprints: expectedSchemaFingerprints(),
          });
          const finalized = finalizeM2A3StagingEvidence(
            reconstructedDirectory,
            environment('expand'),
            { expectedMigrationChecksums: PHASE_CHECKSUMS },
          );
          assert.equal(finalized.manifest.outcome, 'passed');
          assert.equal(
            finalized.manifest.finalReceiptDigest,
            previousReceiptDigest,
          );
        }
      } finally {
        rmSync(reconstructedDirectory, { recursive: true, force: true });
      }
    } finally {
      rmSync(evidenceDirectory, { recursive: true, force: true });
    }
  }

  const tiedStartedAtMicros = String(
    BigInt(unresolved.startedAtMicros) - 1n,
  );
  const tiedRolledBack = [
    migrationRow(
      target,
      PHASE_CHECKSUMS.get(target),
      {
        attempt: -2,
        finished: false,
        rolledBack: true,
        appliedSteps: 0,
        startedAtMicros: tiedStartedAtMicros,
      },
    ),
    migrationRow(
      target,
      PHASE_CHECKSUMS.get(target),
      {
        attempt: -1,
        finished: false,
        rolledBack: true,
        appliedSteps: 0,
        startedAtMicros: tiedStartedAtMicros,
      },
    ),
  ];
  const tiedDirectory = mkdtempSync(
    join(tmpdir(), 'bob-m2a3-ambiguous-terminal-'),
  );
  try {
    await assert.rejects(
      () => runM2A3StagingPhase(
        'expand',
        environment(),
        {
          evidenceDirectory: tiedDirectory,
          certifyDatabase() {},
          deriveExpectedSchemaFingerprints: expectedSchemaFingerprints,
          async readLocalMigrationChecksums() {
            return localMigrations();
          },
          readMigrationInventory() {
            return [migrationRow(), ...tiedRolledBack];
          },
          readSchemaState() {
            return schemaState('S0');
          },
          foreignAuthorityHash() {
            return AUTHORITY_HASH;
          },
        },
      ),
      /migration chronology is ambiguous/u,
    );
  } finally {
    rmSync(tiedDirectory, { recursive: true, force: true });
  }

  const sameTimeActive = migrationRow(
    target,
    PHASE_CHECKSUMS.get(target),
    {
      attempt: 1,
      startedAtMicros: unresolved.startedAtMicros,
    },
  );
  const activeDirectory = mkdtempSync(
    join(tmpdir(), 'bob-m2a3-ambiguous-active-'),
  );
  try {
    await assert.rejects(
      () => runM2A3StagingPhase(
        'expand',
        environment(),
        {
          evidenceDirectory: activeDirectory,
          certifyDatabase() {},
          deriveExpectedSchemaFingerprints: expectedSchemaFingerprints,
          async readLocalMigrationChecksums() {
            return localMigrations();
          },
          readMigrationInventory() {
            return [
              migrationRow(),
              Object.freeze({ ...unresolved, rolledBack: true }),
              sameTimeActive,
            ];
          },
          readSchemaState() {
            return schemaState('S1');
          },
          foreignAuthorityHash() {
            return AUTHORITY_HASH;
          },
        },
      ),
      /chronology is ambiguous/u,
    );
  } finally {
    rmSync(activeDirectory, { recursive: true, force: true });
  }
});

test('une phase lie le postflight au journal exact obtenu après resolve', async () => {
  const target = M2A3_STAGING_PHASES[0].migration;
  const unresolved = migrationRow(
    target,
    PHASE_CHECKSUMS.get(target),
    {
      finished: false,
      rolledBack: false,
      appliedSteps: 0,
    },
  );
  const resolved = Object.freeze({ ...unresolved, rolledBack: true });
  const historical = migrationRow(
    target,
    PHASE_CHECKSUMS.get(target),
    {
      attempt: -1,
      finished: false,
      rolledBack: true,
      appliedSteps: 0,
    },
  );
  const scenarios = [
    {
      name: 'substitution',
      initial: [migrationRow(), historical, unresolved],
      afterResolve: [migrationRow(), historical, resolved],
      afterOperation: [
        migrationRow(),
        historical,
        migrationRow(
          target,
          PHASE_CHECKSUMS.get(target),
          {
            attempt: 1,
            finished: false,
            rolledBack: true,
            appliedSteps: 0,
          },
        ),
        migrationRow(
          target,
          PHASE_CHECKSUMS.get(target),
          { attempt: 2 },
        ),
      ],
      expected: /changed an existing history row/u,
    },
    {
      name: 'action-flip',
      initial: [migrationRow(), unresolved],
      afterResolve: [migrationRow(), resolved],
      afterOperation: [
        migrationRow(),
        resolved,
        migrationRow(
          target,
          PHASE_CHECKSUMS.get(target),
          { attempt: 1, appliedSteps: 0 },
        ),
      ],
      expected: /exact target history row/u,
    },
  ];
  for (const scenario of scenarios) {
    const evidenceDirectory = mkdtempSync(
      join(tmpdir(), `bob-m2a3-journal-${scenario.name}-`),
    );
    let inventoryRead = 0;
    try {
      await assert.rejects(
        () => runM2A3StagingPhase(
          'expand',
          environment(),
          {
            evidenceDirectory,
            certifyDatabase() {},
            deriveExpectedSchemaFingerprints: expectedSchemaFingerprints,
            async readLocalMigrationChecksums() {
              return localMigrations();
            },
            readMigrationInventory() {
              inventoryRead += 1;
              if (inventoryRead === 1) return scenario.initial;
              if (inventoryRead === 2) return scenario.afterResolve;
              return scenario.afterOperation;
            },
            readSchemaState() {
              return schemaState('S0');
            },
            foreignAuthorityHash() {
              return AUTHORITY_HASH;
            },
            certifyAcl() {},
            certifyWriterMatrix(_config, stateName) {
              return writerMatrix(stateName);
            },
            fingerprintWriterOutcome() {
              return 'disabled-fence';
            },
            resolveMigration() {},
            applyMigration() {},
          },
        ),
        scenario.expected,
      );
    } finally {
      rmSync(evidenceDirectory, { recursive: true, force: true });
    }
  }
});

test('une contrainte homonyme mais sémantiquement différente bloque avant resolve', async () => {
  const evidenceDirectory = mkdtempSync(join(tmpdir(), 'bob-m2a3-semantic-drift-'));
  const target = M2A3_STAGING_PHASES[0].migration;
  const unresolved = migrationRow(
    target,
    PHASE_CHECKSUMS.get(target),
    {
      finished: false,
      rolledBack: false,
      appliedSteps: 0,
    },
  );
  const drifted = JSON.parse(schemaState('S1'));
  drifted.constraints.agent_mission_events_data_m2a3_check.expression =
    '(expanded_payload_is_valid OR true)';
  let resolveCalled = false;
  try {
    await assert.rejects(
      runM2A3StagingPhase('expand', environment(), {
        evidenceDirectory,
        certifyDatabase() {},
        deriveExpectedSchemaFingerprints: expectedSchemaFingerprints,
        async readLocalMigrationChecksums() {
          return localMigrations();
        },
        readMigrationInventory() {
          return [migrationRow(), unresolved];
        },
        readSchemaState() {
          return JSON.stringify(drifted);
        },
        resolveMigration() {
          resolveCalled = true;
        },
      }),
      /CHECK semantic fingerprint drifted/u,
    );
    assert.equal(resolveCalled, false);
  } finally {
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
});

test('le manifest chaîne une reprise reconstruisible jusqu’au certificat final', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bob-m2a3-recovery-chain-'));
  const target = M2A3_STAGING_PHASES[0].migration;
  const unresolved = migrationRow(
    target,
    PHASE_CHECKSUMS.get(target),
    {
      finished: false,
      rolledBack: false,
      appliedSteps: 0,
    },
  );
  const rolledBack = Object.freeze({ ...unresolved, rolledBack: true });
  const recoveredAt = (appliedTargetCount) => [
    migrationRow(),
    rolledBack,
    migrationRow(
      target,
      PHASE_CHECKSUMS.get(target),
      { attempt: 1, appliedSteps: 0 },
    ),
    ...M2A3_STAGING_PHASES
      .slice(1, appliedTargetCount)
      .map(({ migration }, index) => migrationRow(
        migration,
        PHASE_CHECKSUMS.get(migration),
        { attempt: index + 2 },
      )),
  ];
  let previousReceiptDigest = null;
  try {
    let inventoryRead = 0;
    const expand = await runM2A3StagingPhase(
      'expand',
      environment('expand'),
      {
        evidenceDirectory: directory,
        certifyDatabase() {},
        deriveExpectedSchemaFingerprints: expectedSchemaFingerprints,
        async readLocalMigrationChecksums() {
          return localMigrations();
        },
        readMigrationInventory() {
          inventoryRead += 1;
          return inventoryRead === 1
            ? [migrationRow(), unresolved]
            : recoveredAt(1);
        },
        readSchemaState() {
          return schemaState('S1');
        },
        foreignAuthorityHash() {
          return AUTHORITY_HASH;
        },
        certifyAcl() {},
        certifyWriterMatrix(_config, stateName) {
          return writerMatrix(stateName);
        },
        fingerprintWriterOutcome() {
          return 'disabled-fence';
        },
        resolveMigration() {},
      },
    );
    assert.equal(expand.evidence.recoveryAction, 'applied');
    assert.equal(expand.evidence.recoverySource, 'unresolved');
    previousReceiptDigest = expand.digest;

    for (let index = 1; index < M2A3_STAGING_PHASES.length; index += 1) {
      const definition = M2A3_STAGING_PHASES[index];
      let phaseInventoryRead = 0;
      let schemaRead = 0;
      const result = await runM2A3StagingPhase(
        definition.phase,
        environment(definition.phase, {
          BOB_M2A3_PREVIOUS_RECEIPT_DIGEST: previousReceiptDigest,
          GITHUB_RUN_ATTEMPT: String(index + 1),
        }),
        {
          evidenceDirectory: directory,
          certifyDatabase() {},
          deriveExpectedSchemaFingerprints: expectedSchemaFingerprints,
          async readLocalMigrationChecksums() {
            return localMigrations();
          },
          readMigrationInventory() {
            phaseInventoryRead += 1;
            return recoveredAt(
              phaseInventoryRead === 1 ? index : index + 1,
            );
          },
          readSchemaState() {
            schemaRead += 1;
            return schemaState(
              schemaRead === 1 ? `S${index}` : definition.state,
            );
          },
          foreignAuthorityHash() {
            return AUTHORITY_HASH;
          },
          certifyAcl() {},
          certifyWriterMatrix(_config, stateName) {
            return writerMatrix(stateName);
          },
          fingerprintWriterOutcome() {
            return 'disabled-fence';
          },
          applyMigration() {},
        },
      );
      previousReceiptDigest = result.digest;
    }

    const finalized = finalizeM2A3StagingEvidence(
      directory,
      environment('expand'),
      { expectedMigrationChecksums: PHASE_CHECKSUMS },
    );
    assert.equal(finalized.manifest.outcome, 'passed');
    assert.equal(
      finalized.manifest.finalReceiptDigest,
      previousReceiptDigest,
    );

    const intentPath = join(
      directory,
      `staging-schema-${RELEASE_SHA}-expand-recovery-intent.json`,
    );
    const intent = JSON.parse(readFileSync(intentPath, 'utf8'));
    intent.semanticOracleDigest = '0'.repeat(64);
    writeFileSync(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
    assert.throws(
      () => finalizeM2A3StagingEvidence(
        directory,
        environment('expand'),
        { expectedMigrationChecksums: PHASE_CHECKSUMS },
      ),
      /recovery intent is not chained/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('un changement d’autorité étrangère bloque la certification après migration', async () => {
  const evidenceDirectory = mkdtempSync(join(tmpdir(), 'bob-m2a3-evidence-'));
  let inventoryRead = 0;
  let schemaRead = 0;
  let authorityRead = 0;
  try {
    await assert.rejects(
      runM2A3StagingPhase('expand', environment(), {
        evidenceDirectory,
        certifyDatabase() {},
        deriveExpectedSchemaFingerprints: expectedSchemaFingerprints,
        async readLocalMigrationChecksums() {
          return localMigrations();
        },
        readMigrationInventory() {
          inventoryRead += 1;
          return inventoryAt(inventoryRead - 1);
        },
        readSchemaState() {
          schemaRead += 1;
          return schemaState(schemaRead === 1 ? 'S0' : 'S1');
        },
        foreignAuthorityHash() {
          authorityRead += 1;
          return authorityRead === 1 ? AUTHORITY_HASH : '9'.repeat(64);
        },
        certifyAcl() {},
        certifyWriterMatrix(_config, stateName) {
          return writerMatrix(stateName);
        },
        fingerprintWriterOutcome() {
          return 'disabled-fence';
        },
        applyMigration() {},
      }),
      /foreign release authority changed/u,
    );
  } finally {
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
});

function hashesForState(stateName) {
  return {
    S0: {
      canonicalConstraintDefinitionHash: CANONICAL_DEFINITION_HASH,
      canonicalConstraintExpressionHash: CANONICAL_EXPRESSION_HASH,
      expandedConstraintDefinitionHash: null,
      expandedConstraintExpressionHash: null,
    },
    S1: {
      canonicalConstraintDefinitionHash: CANONICAL_DEFINITION_HASH,
      canonicalConstraintExpressionHash: CANONICAL_EXPRESSION_HASH,
      expandedConstraintDefinitionHash:
        EXPANDED_UNVALIDATED_DEFINITION_HASH,
      expandedConstraintExpressionHash: EXPANDED_EXPRESSION_HASH,
    },
    S2: {
      canonicalConstraintDefinitionHash: CANONICAL_DEFINITION_HASH,
      canonicalConstraintExpressionHash: CANONICAL_EXPRESSION_HASH,
      expandedConstraintDefinitionHash:
        EXPANDED_VALIDATED_DEFINITION_HASH,
      expandedConstraintExpressionHash: EXPANDED_EXPRESSION_HASH,
    },
    S3: {
      canonicalConstraintDefinitionHash:
        EXPANDED_VALIDATED_DEFINITION_HASH,
      canonicalConstraintExpressionHash: EXPANDED_EXPRESSION_HASH,
      expandedConstraintDefinitionHash: null,
      expandedConstraintExpressionHash: null,
    },
  }[stateName];
}

function writeEvidencePair({
  directory,
  index,
  operation,
  previousReceiptDigest,
  runAttempt,
  observedMinute,
  rolledBackCount = 0,
  stateFingerprints = null,
  finalizedTrain = false,
}) {
  const definition = M2A3_STAGING_PHASES[index];
  const config = parseM2A3StagingEnvironment(
    definition.phase,
    environment(definition.phase, {
      BOB_M2A3_PREVIOUS_RECEIPT_DIGEST:
        previousReceiptDigest ?? 'none',
      GITHUB_RUN_ATTEMPT: String(runAttempt),
    }),
  );
  const beforeState = finalizedTrain
    ? 'S3'
    : operation === 'apply'
      ? `S${index}`
      : definition.state;
  const afterState = finalizedTrain ? 'S3' : definition.state;
  const appliedBefore = finalizedTrain
    ? M2A3_STAGING_PHASES.length + 1
    : operation === 'apply'
      ? index + 1
      : index + 2;
  const pendingBefore = finalizedTrain
    ? 0
    : operation === 'apply'
      ? M2A3_STAGING_PHASES.length - index
      : M2A3_STAGING_PHASES.length - index - 1;
  const historyBefore = createHash('sha256')
    .update(
      finalizedTrain
        ? 'history:finalized-recertification'
        : `history:${index}:${operation}:before`,
    )
    .digest('hex');
  const historyAfter = operation === 'apply'
    ? createHash('sha256')
        .update(`history:${index}:${operation}:after`)
        .digest('hex')
    : historyBefore;
  const build = (status, stateName, preflightReceiptDigest) =>
    buildM2A3Evidence({
      status,
      config,
      operation,
      migration: {
        appliedCount:
          status === 'certified' && operation === 'apply'
            ? appliedBefore + 1
            : appliedBefore,
        pendingCount:
          status === 'certified' && operation === 'apply'
            ? pendingBefore - 1
            : pendingBefore,
        historyDigest:
          status === 'certified' ? historyAfter : historyBefore,
        rolledBackCount,
        unresolvedCount: 0,
        targetChecksum: PHASE_CHECKSUMS.get(definition.migration),
      },
      stateName,
      schema: {
        schemaOwner: 'bob_schema_owner',
        releaseFlagsOwner: 'bob_schema_owner',
        ...(stateFingerprints?.[stateName] ?? hashesForState(stateName)),
      },
      foreignAuthorityHash: AUTHORITY_HASH,
      runtimeWriterOutcome: 'disabled-fence',
      writerMatrix: writerMatrix(stateName),
      preflightReceiptDigest,
      observedAt:
        `2026-07-31T12:${String(observedMinute).padStart(2, '0')}:${
          status === 'preflight' ? '00' : '30'
        }.000Z`,
    });
  const preflight = build('preflight', beforeState, null);
  const preflightBytes = `${JSON.stringify(preflight, null, 2)}\n`;
  writeFileSync(
    join(
      directory,
      `staging-schema-${RELEASE_SHA}-${definition.phase}-preflight.json`,
    ),
    preflightBytes,
  );
  const preflightDigest = createHash('sha256')
    .update(preflightBytes)
    .digest('hex');
  const certified = build('certified', afterState, preflightDigest);
  const certifiedBytes = `${JSON.stringify(certified, null, 2)}\n`;
  writeFileSync(
    join(
      directory,
      `staging-schema-${RELEASE_SHA}-${definition.phase}-certified.json`,
    ),
    certifiedBytes,
  );
  return createHash('sha256').update(certifiedBytes).digest('hex');
}

test('le manifest final exige les trois reçus exacts dans le bon ordre digest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bob-m2a3-manifest-'));
  let previousReceiptDigest = null;
  try {
    for (let index = 0; index < M2A3_STAGING_PHASES.length; index += 1) {
      previousReceiptDigest = writeEvidencePair({
        directory,
        index,
        operation: 'apply',
        previousReceiptDigest,
        runAttempt: 1,
        observedMinute: index,
      });
    }

    const result = finalizeM2A3StagingEvidence(
      directory,
      environment('expand'),
      { expectedMigrationChecksums: PHASE_CHECKSUMS },
    );
    assert.equal(result.manifest.outcome, 'passed');
    assert.equal(result.manifest.version, 2);
    assert.equal(
      result.manifest.certificationMode,
      'transition-train',
    );
    assert.equal(result.manifest.phases.length, 3);
    assert.equal(
      result.manifest.finalReceiptDigest,
      previousReceiptDigest,
    );

    const validatePath = join(
      directory,
      `staging-schema-${RELEASE_SHA}-validate-certified.json`,
    );
    const tampered = JSON.parse(readFileSync(validatePath, 'utf8'));
    tampered.previousReceiptDigest = '0'.repeat(64);
    writeFileSync(validatePath, `${JSON.stringify(tampered, null, 2)}\n`);
    assert.throws(
      () => finalizeM2A3StagingEvidence(
        directory,
        environment('expand'),
        { expectedMigrationChecksums: PHASE_CHECKSUMS },
      ),
      /not an exact transition pair/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('le manifest accepte une reprise post-apply avec recertifications ordonnées', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bob-m2a3-recertify-'));
  let previousReceiptDigest = null;
  try {
    previousReceiptDigest = writeEvidencePair({
      directory,
      index: 0,
      operation: 'apply',
      previousReceiptDigest,
      runAttempt: 1,
      observedMinute: 0,
    });
    previousReceiptDigest = writeEvidencePair({
      directory,
      index: 1,
      operation: 'recertify',
      previousReceiptDigest,
      runAttempt: 2,
      observedMinute: 10,
    });
    previousReceiptDigest = writeEvidencePair({
      directory,
      index: 2,
      operation: 'recertify',
      previousReceiptDigest,
      runAttempt: 3,
      observedMinute: 20,
    });

    const result = finalizeM2A3StagingEvidence(
      directory,
      environment('expand'),
      { expectedMigrationChecksums: PHASE_CHECKSUMS },
    );
    assert.equal(result.manifest.outcome, 'passed');
    assert.equal(
      result.manifest.certificationMode,
      'transition-train',
    );
    assert.deepEqual(
      result.manifest.phases.map(
        ({ phase, githubRunAttempt }) => [phase, githubRunAttempt],
      ),
      [
        ['expand', '1'],
        ['validate', '2'],
        ['cutover', '3'],
      ],
    );
    assert.equal(result.manifest.finalReceiptDigest, previousReceiptDigest);

    const validatePath = join(
      directory,
      `staging-schema-${RELEASE_SHA}-validate-preflight.json`,
    );
    const validate = JSON.parse(readFileSync(validatePath, 'utf8'));
    validate.githubRunAttempt = '0';
    writeFileSync(validatePath, `${JSON.stringify(validate, null, 2)}\n`);
    assert.throws(
      () => finalizeM2A3StagingEvidence(
        directory,
        environment('expand'),
        { expectedMigrationChecksums: PHASE_CHECKSUMS },
      ),
      /preflight phase receipt is incomplete|chronology regressed/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('un train S3 déjà finalisé est recertifié au nouveau SHA sans mutation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bob-m2a3-finalized-'));
  const results = [];
  let previousReceiptDigest = null;
  const historicalExpandRollback = migrationRow(
    M2A3_STAGING_PHASES[0].migration,
    PHASE_CHECKSUMS.get(M2A3_STAGING_PHASES[0].migration),
    {
      attempt: -1,
      finished: false,
      rolledBack: true,
      appliedSteps: 0,
    },
  );
  const terminalInventory = [
    historicalExpandRollback,
    ...inventoryAt(3),
  ];
  try {
    for (let index = 0; index < M2A3_STAGING_PHASES.length; index += 1) {
      const definition = M2A3_STAGING_PHASES[index];
      let inventoryRead = 0;
      const result = await runM2A3StagingPhase(
        definition.phase,
        environment(definition.phase, {
          BOB_M2A3_PREVIOUS_RECEIPT_DIGEST:
            previousReceiptDigest ?? 'none',
        }),
        {
          evidenceDirectory: directory,
          certifyDatabase() {},
          deriveExpectedSchemaFingerprints: expectedSchemaFingerprints,
          async readLocalMigrationChecksums() {
            return localMigrations();
          },
          readMigrationInventory() {
            inventoryRead += 1;
            return terminalInventory;
          },
          readSchemaState() {
            return schemaState('S3');
          },
          foreignAuthorityHash() {
            return AUTHORITY_HASH;
          },
          certifyAcl() {},
          certifyWriterMatrix(_config, stateName) {
            return writerMatrix(stateName);
          },
          fingerprintWriterOutcome() {
            return 'disabled-fence';
          },
          applyMigration() {
            assert.fail('finalized recertification must not run Prisma');
          },
          resolveMigration() {
            assert.fail('finalized recertification must not resolve Prisma');
          },
        },
      );
      assert.equal(inventoryRead, 2);
      assert.equal(result.evidence.operation, 'recertify');
      assert.equal(result.evidence.state, 'S3');
      assert.equal(result.evidence.pendingMigrationCount, 0);
      results.push(result);
      previousReceiptDigest = result.digest;
    }
    assert.equal(results[0].evidence.recoverySource, 'terminal-history');
    assert.equal(results[0].evidence.recoveryAction, 'rolled_back');
    assert.equal(results[1].evidence.recoverySource, null);
    assert.equal(results[2].evidence.recoverySource, null);

    const finalized = finalizeM2A3StagingEvidence(
      directory,
      environment('expand'),
      { expectedMigrationChecksums: PHASE_CHECKSUMS },
    );
    assert.equal(finalized.manifest.version, 2);
    assert.equal(
      finalized.manifest.certificationMode,
      'finalized-recertification',
    );
    assert.deepEqual(
      finalized.manifest.phases.map(
        ({ phase, state, operation }) => [phase, state, operation],
      ),
      [
        ['expand', 'S3', 'recertify'],
        ['validate', 'S3', 'recertify'],
        ['cutover', 'S3', 'recertify'],
      ],
    );
    assert.equal(
      finalized.manifest.finalReceiptDigest,
      previousReceiptDigest,
    );
    assert.deepEqual(
      results.map(({ evidence }) => evidence.migrationHistoryDigest),
      Array(3).fill(results[0].evidence.migrationHistoryDigest),
    );

    const validatePath = join(
      directory,
      `staging-schema-${RELEASE_SHA}-validate-certified.json`,
    );
    const tampered = JSON.parse(readFileSync(validatePath, 'utf8'));
    tampered.migrationHistoryDigest = '0'.repeat(64);
    writeFileSync(validatePath, `${JSON.stringify(tampered, null, 2)}\n`);
    assert.throws(
      () => finalizeM2A3StagingEvidence(
        directory,
        environment('expand'),
        { expectedMigrationChecksums: PHASE_CHECKSUMS },
      ),
      /exact transition pair|changed between phases/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('le manifest refuse de mélanger recertification finale et train de transitions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bob-m2a3-mixed-mode-'));
  let previousReceiptDigest = null;
  try {
    previousReceiptDigest = writeEvidencePair({
      directory,
      index: 0,
      operation: 'recertify',
      previousReceiptDigest,
      runAttempt: 1,
      observedMinute: 0,
      finalizedTrain: true,
    });
    previousReceiptDigest = writeEvidencePair({
      directory,
      index: 1,
      operation: 'recertify',
      previousReceiptDigest,
      runAttempt: 1,
      observedMinute: 1,
    });
    writeEvidencePair({
      directory,
      index: 2,
      operation: 'recertify',
      previousReceiptDigest,
      runAttempt: 1,
      observedMinute: 2,
    });
    assert.throws(
      () => finalizeM2A3StagingEvidence(
        directory,
        environment('expand'),
        { expectedMigrationChecksums: PHASE_CHECKSUMS },
      ),
      /finalized recertification is not uniform/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('la recertification terminale refuse tout historique incomplet ou mutable', async () => {
  const local = localMigrations();
  assert.throws(
    () => assertM2A3PhasePreflight(inventoryAt(2), local, 'expand'),
    /future phase attempt/u,
  );
  const unresolvedCutover = migrationRow(
    M2A3_STAGING_PHASES[2].migration,
    PHASE_CHECKSUMS.get(M2A3_STAGING_PHASES[2].migration),
    {
      attempt: 4,
      finished: false,
      rolledBack: false,
      appliedSteps: 0,
    },
  );
  assert.throws(
    () => assertM2A3PhasePreflight(
      [...inventoryAt(3), unresolvedCutover],
      local,
      'expand',
    ),
    /unresolved migration/u,
  );
  const wrongChecksumInventory = inventoryAt(3).map((row) =>
    row.name === M2A3_STAGING_PHASES[2].migration
      ? Object.freeze({ ...row, checksum: '8'.repeat(64) })
      : row);
  assert.throws(
    () => assertM2A3PhasePreflight(
      wrongChecksumInventory,
      local,
      'expand',
    ),
    /attempt is not exact/u,
  );

  const directory = mkdtempSync(join(tmpdir(), 'bob-m2a3-mutated-'));
  let inventoryRead = 0;
  try {
    await assert.rejects(
      () => runM2A3StagingPhase(
        'expand',
        environment(),
        {
          evidenceDirectory: directory,
          certifyDatabase() {},
          deriveExpectedSchemaFingerprints: expectedSchemaFingerprints,
          async readLocalMigrationChecksums() {
            return local;
          },
          readMigrationInventory() {
            inventoryRead += 1;
            return inventoryRead === 1
              ? inventoryAt(3)
              : [
                  ...inventoryAt(3),
                  migrationRow(
                    '20260731130000_unexpected_append',
                    '9'.repeat(64),
                    { attempt: 4 },
                  ),
                ];
          },
          readSchemaState() {
            return schemaState('S3');
          },
          foreignAuthorityHash() {
            return AUTHORITY_HASH;
          },
          certifyAcl() {},
          certifyWriterMatrix(_config, stateName) {
            return writerMatrix(stateName);
          },
          fingerprintWriterOutcome() {
            return 'disabled-fence';
          },
          applyMigration() {
            assert.fail('finalized recertification must not run Prisma');
          },
        },
      ),
      /recertification changed Prisma history/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('la reprise réelle applique expand une fois puis recertifie validate et cutover', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bob-m2a3-real-recovery-'));
  const appliedPhases = [];
  const results = [];
  let previousReceiptDigest = null;
  try {
    for (let index = 0; index < M2A3_STAGING_PHASES.length; index += 1) {
      const definition = M2A3_STAGING_PHASES[index];
      const operation = index === 0 ? 'apply' : 'recertify';
      const beforeAppliedCount = operation === 'apply' ? index : index + 1;
      const afterAppliedCount = index + 1;
      const beforeState = operation === 'apply' ? `S${index}` : definition.state;
      let inventoryRead = 0;
      let schemaRead = 0;
      const result = await runM2A3StagingPhase(
        definition.phase,
        environment(definition.phase, {
          BOB_M2A3_PREVIOUS_RECEIPT_DIGEST:
            previousReceiptDigest ?? 'none',
          GITHUB_RUN_ATTEMPT: String(index + 1),
        }),
        {
          evidenceDirectory: directory,
          certifyDatabase() {},
          deriveExpectedSchemaFingerprints: expectedSchemaFingerprints,
          async readLocalMigrationChecksums() {
            return localMigrations();
          },
          readMigrationInventory() {
            inventoryRead += 1;
            return inventoryAt(
              inventoryRead === 1
                ? beforeAppliedCount
                : afterAppliedCount,
            );
          },
          readSchemaState() {
            schemaRead += 1;
            return schemaState(
              schemaRead === 1 ? beforeState : definition.state,
            );
          },
          foreignAuthorityHash() {
            return AUTHORITY_HASH;
          },
          certifyAcl() {},
          certifyWriterMatrix(_config, stateName) {
            return writerMatrix(stateName);
          },
          fingerprintWriterOutcome() {
            return 'disabled-fence';
          },
          applyMigration() {
            appliedPhases.push(definition.phase);
          },
        },
      );
      assert.equal(result.evidence.operation, operation);
      assert.equal(
        result.digest,
        createHash('sha256').update(readFileSync(result.path)).digest('hex'),
      );
      const preflightPath = join(
        directory,
        `staging-schema-${RELEASE_SHA}-${definition.phase}-preflight.json`,
      );
      const preflightDigest = createHash('sha256')
        .update(readFileSync(preflightPath))
        .digest('hex');
      assert.equal(
        result.evidence.preflightReceiptDigest,
        preflightDigest,
      );
      assert.equal(
        result.evidence.previousReceiptDigest,
        previousReceiptDigest,
      );
      results.push(result);
      previousReceiptDigest = result.digest;
    }

    assert.deepEqual(appliedPhases, ['expand']);
    assert.deepEqual(
      results.map(({ evidence }) => evidence.operation),
      ['apply', 'recertify', 'recertify'],
    );
    const finalized = finalizeM2A3StagingEvidence(
      directory,
      environment('expand'),
      { expectedMigrationChecksums: PHASE_CHECKSUMS },
    );
    assert.equal(finalized.manifest.outcome, 'passed');
    assert.equal(
      finalized.manifest.finalReceiptDigest,
      previousReceiptDigest,
    );
    assert.deepEqual(
      finalized.manifest.phases.map(
        ({ phase, githubRunAttempt }) => [phase, githubRunAttempt],
      ),
      [
        ['expand', '1'],
        ['validate', '2'],
        ['cutover', '3'],
      ],
    );

    const receiptPath = (phase, status) => join(
      directory,
      `staging-schema-${RELEASE_SHA}-${phase}-${status}.json`,
    );
    const validatePreflightPath = receiptPath('validate', 'preflight');
    const validateCertifiedPath = receiptPath('validate', 'certified');
    const cutoverPreflightPath = receiptPath('cutover', 'preflight');
    const cutoverCertifiedPath = receiptPath('cutover', 'certified');
    const originals = new Map(
      [
        validatePreflightPath,
        validateCertifiedPath,
        cutoverPreflightPath,
        cutoverCertifiedPath,
      ].map((path) => [path, readFileSync(path)]),
    );
    const writeReceipt = (path, receipt) => {
      const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
      writeFileSync(path, bytes);
      return createHash('sha256').update(bytes).digest('hex');
    };

    const validatePreflight = JSON.parse(
      readFileSync(validatePreflightPath, 'utf8'),
    );
    const validateCertified = JSON.parse(
      readFileSync(validateCertifiedPath, 'utf8'),
    );
    validatePreflight.expandedConstraintExpressionHash = '8'.repeat(64);
    validateCertified.expandedConstraintExpressionHash = '8'.repeat(64);
    validateCertified.preflightReceiptDigest = writeReceipt(
      validatePreflightPath,
      validatePreflight,
    );
    const tamperedValidateDigest = writeReceipt(
      validateCertifiedPath,
      validateCertified,
    );
    const cutoverPreflight = JSON.parse(
      readFileSync(cutoverPreflightPath, 'utf8'),
    );
    const cutoverCertified = JSON.parse(
      readFileSync(cutoverCertifiedPath, 'utf8'),
    );
    cutoverPreflight.previousReceiptDigest = tamperedValidateDigest;
    cutoverCertified.previousReceiptDigest = tamperedValidateDigest;
    cutoverCertified.preflightReceiptDigest = writeReceipt(
      cutoverPreflightPath,
      cutoverPreflight,
    );
    writeReceipt(cutoverCertifiedPath, cutoverCertified);
    assert.throws(
      () => finalizeM2A3StagingEvidence(
        directory,
        environment('expand'),
        { expectedMigrationChecksums: PHASE_CHECKSUMS },
      ),
      /recertified CHECK does not derive/u,
    );

    for (const [path, bytes] of originals) writeFileSync(path, bytes);
    const driftedCutoverPreflight = JSON.parse(
      readFileSync(cutoverPreflightPath, 'utf8'),
    );
    const driftedCutoverCertified = JSON.parse(
      readFileSync(cutoverCertifiedPath, 'utf8'),
    );
    driftedCutoverPreflight.canonicalConstraintExpressionHash =
      '9'.repeat(64);
    driftedCutoverCertified.canonicalConstraintExpressionHash =
      '9'.repeat(64);
    driftedCutoverCertified.preflightReceiptDigest = writeReceipt(
      cutoverPreflightPath,
      driftedCutoverPreflight,
    );
    writeReceipt(cutoverCertifiedPath, driftedCutoverCertified);
    assert.throws(
      () => finalizeM2A3StagingEvidence(
        directory,
        environment('expand'),
        { expectedMigrationChecksums: PHASE_CHECKSUMS },
      ),
      /recertified CHECK does not derive/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

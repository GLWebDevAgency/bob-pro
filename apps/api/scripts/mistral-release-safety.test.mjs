import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const MUTATION_FLAGS = Object.freeze([
  'RUN_POSTGRES_MISTRAL_CONVERSATION_MUTATION_CERT',
  'RUN_POSTGRES_MISTRAL_KEY_ROTATION_MUTATION_CERT',
]);

test('une release live refuse puis neutralise les certifications PostgreSQL destructives', async () => {
  const [environmentGate, release] = await Promise.all([
    readFile(new URL('./check-release-env.sh', import.meta.url), 'utf8'),
    readFile(new URL('./release.sh', import.meta.url), 'utf8'),
  ]);

  for (const flag of MUTATION_FLAGS) {
    assert.match(environmentGate, new RegExp(`'${flag}'`, 'u'));
    assert.match(
      release,
      new RegExp(`${flag}=false`, 'u'),
      `${flag} doit être forcé à false à la frontière d’exécution`,
    );
  }
  assert.match(environmentGate, /value !== undefined && value !== 'false'/u);
  assert.match(
    release,
    /RUN_POSTGRES_MISTRAL_CONVERSATION_MUTATION_CERT=false[\s\\]+RUN_POSTGRES_MISTRAL_KEY_ROTATION_MUTATION_CERT=false[\s\\]+DATABASE_URL=/u,
  );
});

test('le runtime ne peut ni supprimer les preuves bootstrap ni omettre leur certification CI', async () => {
  const [
    release,
    certification,
    migration,
    retention,
    postgresCertification,
    reaperPostgresCertification,
    reconciliationPostgresCertification,
  ] = await Promise.all([
    readFile(new URL('./release.sh', import.meta.url), 'utf8'),
    readFile(new URL('./certify-mistral-conversation-authority.sh', import.meta.url), 'utf8'),
    readFile(new URL(
      '../prisma/migrations/20260719030000_mistral_conversation_initial_bootstrap/migration.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../prisma/migrations/20260719090000_mistral_conversation_ordered_retention/migration.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../src/voice/realtime/mistral-conversation-bootstrap-ticket.postgres.test.ts',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../src/voice/realtime/mistral-conversation-bootstrap-reaper.postgres.test.ts',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../src/voice/realtime/mistral-conversation-bootstrap-reconciliation.postgres.test.ts',
      import.meta.url,
    ), 'utf8'),
  ]);

  assert.match(
    release,
    /REVOKE DELETE, TRUNCATE ON TABLE[\s\S]*public\.realtime_mistral_conversation_bootstrap_tickets,/u,
  );
  assert.match(
    release,
    /CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/u,
  );
  assert.match(
    release,
    /reaper\.rolcanlogin[\s\S]*reaper\.rolsuper[\s\S]*reaper\.rolreplication[\s\S]*reaper\.rolbypassrls/u,
  );
  assert.doesNotMatch(
    release,
    /ALTER ROLE bob_mistral_bootstrap_reaper\s+NOLOGIN NOSUPERUSER/u,
  );
  assert.match(release, /GRANT UPDATE \(id\)[\s\S]*bob_mistral_bootstrap_reaper/u);
  assert.match(
    release,
    /REVOKE bob_mistral_bootstrap_reaper FROM :"app_role"/u,
  );
  assert.match(
    release,
    /GRANT bob_mistral_bootstrap_reaper TO CURRENT_USER[\s\S]*WITH ADMIN FALSE, INHERIT FALSE, SET TRUE/u,
  );
  assert.match(
    release,
    /REVOKE ALL ON FUNCTION public\.purge_realtime_mistral_conversation_retention\(INTEGER\) FROM %I CASCADE/u,
  );
  assert.match(
    release,
    /pg_auth_members AS membership[\s\S]*membership\.member = 'bob_mistral_bootstrap_reaper'::regrole/u,
  );
  assert.match(
    release,
    /membership\.roleid = 'bob_mistral_bootstrap_reaper'::regrole[\s\S]*member_role\.rolname <> current_user/u,
  );
  assert.match(
    release,
    /pg_shdepend AS ownership[\s\S]*ownership\.deptype = 'o'[\s\S]*ownership\.dbid = database_oid[\s\S]*ownership\.objid IN \(legacy_oid, ordered_oid\)/u,
  );
  assert.doesNotMatch(release, /DROP OWNED BY bob_mistral_bootstrap_reaper/u);
  assert.match(
    retention,
    /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog[\s\S]*SET row_security = on[\s\S]*FOR UPDATE OF ticket SKIP LOCKED/u,
  );
  assert.match(migration, /TG_OP = 'TRUNCATE'[\s\S]*evidence is append-only/u);
  assert.doesNotMatch(postgresCertification, /session_replication_role/u);
  assert.match(
    postgresCertification,
    /runtimeCanSetReaper: false[\s\S]*runtimeCanDelete: false[\s\S]*runtimeCanExecute: true[\s\S]*reaperCanSelectTable: false[\s\S]*reaperCanDelete: true[\s\S]*reaperCanTruncate: false/u,
  );
  assert.match(
    certification,
    /src\/voice\/realtime\/mistral-conversation-bootstrap-ticket\.postgres\.test\.ts/u,
  );
  assert.equal(
    certification.match(/--fileParallelism=false/gu)?.length,
    3,
    'chaque invocation Vitest PostgreSQL doit sérialiser ses fichiers',
  );
  assert.match(
    certification,
    /RUN_POSTGRES_MISTRAL_CONVERSATION_BOOTSTRAP_CERT=true[\s\\]+RUN_POSTGRES_MISTRAL_CONVERSATION_BOOTSTRAP_REAPER_CERT=true[\s\\]+RUN_POSTGRES_MISTRAL_CONVERSATION_BOOTSTRAP_RECONCILIATION_CERT=true[\s\\]+RUN_POSTGRES_MISTRAL_CONVERSATION_LEASE_FENCE_CERT=true[\s\\]+RUN_POSTGRES_MISTRAL_CONVERSATION_REAPER_TERMINATION_CERT=true[\s\\]+pnpm/u,
  );
  assert.match(certification, /runtime_role=[\s\S]*SELECT current_user::text/u);
  assert.match(
    certification,
    /REVOKE bob_mistral_bootstrap_reaper FROM :"runtime_role"/u,
  );
  assert.doesNotMatch(certification, /DROP OWNED BY bob_mistral_bootstrap_reaper/u);
  assert.match(
    certification,
    /membership\.roleid = 'bob_mistral_bootstrap_reaper'::regrole[\s\S]*member_role\.rolname <> current_user/u,
  );
  for (const provisioning of [release, certification]) {
    assert.match(
      provisioning,
      /GRANT CREATE ON SCHEMA public TO bob_mistral_bootstrap_reaper[\s\S]*ALTER FUNCTION %s OWNER TO bob_mistral_bootstrap_reaper[\s\S]*REVOKE CREATE ON SCHEMA public FROM bob_mistral_bootstrap_reaper[\s\S]*GRANT USAGE ON SCHEMA public TO bob_mistral_bootstrap_reaper/u,
    );
    assert.match(
      provisioning,
      /REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE[\s\S]*aclexplode[\s\S]*ORDER BY bool_or\(privilege\.is_grantable\) DESC[\s\S]*function ACL contains an unexpected grant/u,
    );
    assert.match(
      provisioning,
      /REVOKE ALL PRIVILEGES \(%I\) ON TABLE %I\.%I FROM bob_mistral_bootstrap_reaper CASCADE/u,
    );
    assert.match(
      provisioning,
      /REVOKE GRANT OPTION FOR %s ON TABLE %I\.%I FROM %I CASCADE[\s\S]*REVOKE GRANT OPTION FOR %s \(%I\) ON TABLE %I\.%I FROM %I CASCADE/u,
    );
    assert.match(
      provisioning,
      /REVOKE TRUNCATE ON TABLE[\s\S]*public\.realtime_session_leases/u,
    );
    assert.match(
      provisioning,
      /REVOKE ALL PRIVILEGES ON TABLE[\s\S]*public\.realtime_session_leases[\s\S]*FROM PUBLIC CASCADE/u,
    );
    assert.match(
      provisioning,
      /REVOKE ALL PRIVILEGES \(%I\) ON TABLE %I\.%I FROM PUBLIC CASCADE[\s\S]*scoped table or column ACL exposes PUBLIC/u,
    );
    assert.match(
      provisioning,
      /pg_has_role[\s\S]*'MEMBER'[\s\S]*pg_has_role[\s\S]*'SET'[\s\S]*(?:app|runtime) role is a member of or can SET ROLE to the reaper/u,
    );
    assert.match(
      provisioning,
      /REVOKE %I FROM %I CASCADE/u,
    );
  }
  assert.match(
    certification,
    /src\/voice\/realtime\/mistral-conversation-bootstrap-reaper\.postgres\.test\.ts/u,
  );
  assert.match(certification, /BOB_LIVE_MISTRAL_V2_PROVISION_ONLY/u);
  assert.match(
    certification,
    /REVOKE ALL ON FUNCTION public\.purge_realtime_mistral_conversation_retention\(INTEGER\)[\s\S]*FROM :"runtime_role" CASCADE/u,
  );
  assert.doesNotMatch(reaperPostgresCertification, /session_replication_role/u);
  assert.match(
    reaperPostgresCertification,
    /nettoie au rejeu un EXECUTE tiers et un chemin SET ROLE transitif[\s\S]*WITH GRANT OPTION[\s\S]*GRANT DELETE ON TABLE[\s\S]*GRANT SELECT \(id\)[\s\S]*GRANT UPDATE \("terminalReason"\)[\s\S]*replayReaperProvisioning/u,
  );
  assert.match(
    reaperPostgresCertification,
    /TO \$\{quotedRuntime\} WITH GRANT OPTION[\s\S]*runtime\.\$executeRawUnsafe[\s\S]*TO \$\{quotedDelegate\}/u,
  );
  assert.match(
    reaperPostgresCertification,
    /refuse un membership ADMIN sans SET[\s\S]*WITH ADMIN TRUE, INHERIT FALSE, SET FALSE[\s\S]*runtimeIsReaperMember: true[\s\S]*runtimeCanSetReaper: false[\s\S]*GRANT \$\{REAPER_ROLE\} TO \$\{quotedRuntime\}[\s\S]*SET TRUE[\s\S]*runtimeIsReaperMember: false[\s\S]*runtimeCanSetReaper: false/u,
  );
  assert.match(
    reaperPostgresCertification,
    /canTruncateScopedTable: false[\s\S]*canDeleteLease: true/u,
  );
  assert.match(
    reaperPostgresCertification,
    /runtimeAuthority\?\.roleName\)\.not\.toBe\(REAPER_ROLE\)[\s\S]*SET LOCAL ROLE \$\{REAPER_ROLE\}[\s\S]*rejects\.toThrow/u,
  );
  assert.match(
    certification,
    /src\/voice\/realtime\/mistral-conversation-bootstrap-reconciliation\.postgres\.test\.ts/u,
  );
  assert.doesNotMatch(reconciliationPostgresCertification, /session_replication_role/u);
  assert.match(
    reconciliationPostgresCertification,
    /rolsuper: false[\s\S]*rolbypassrls: false/u,
  );
});

test('la rétention Mistral supprime le groupe tenant-bound dans l’ordre et ne possède aucun audit séparé', async () => {
  const [
    release,
    certification,
    foreignKeyExpand,
    foreignKeyValidation,
    retention,
    rls,
    adapter,
    postgresCertification,
  ] = await Promise.all([
    readFile(new URL('./release.sh', import.meta.url), 'utf8'),
    readFile(new URL('./certify-mistral-conversation-authority.sh', import.meta.url), 'utf8'),
    readFile(new URL(
      '../prisma/migrations/20260719080000_mistral_conversation_bootstrap_fk/migration.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../prisma/migrations/20260719081000_mistral_conversation_bootstrap_fk_validate/migration.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../prisma/migrations/20260719090000_mistral_conversation_ordered_retention/migration.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL('../prisma/rls.sql', import.meta.url), 'utf8'),
    readFile(new URL(
      '../src/voice/realtime/mistral-conversation-bootstrap-reaper.prisma.ts',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../src/voice/realtime/mistral-conversation-bootstrap-reaper.postgres.test.ts',
      import.meta.url,
    ), 'utf8'),
  ]);

  assert.match(
    foreignKeyExpand,
    /UNIQUE \("initialBootstrapId", "companyId"\)[\s\S]*FOREIGN KEY \("initialBootstrapId", "companyId"\)[\s\S]*ON DELETE RESTRICT[\s\S]*NOT VALID/u,
  );
  assert.match(
    foreignKeyValidation,
    /VALIDATE CONSTRAINT "mistral_conversation_mission_bootstrap_fkey"/u,
  );
  assert.match(
    retention,
    /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog[\s\S]*SET row_security = on/u,
  );
  assert.match(
    retention,
    /FOR UPDATE SKIP LOCKED[\s\S]*pg_try_advisory_xact_lock[\s\S]*FOR UPDATE SKIP LOCKED/u,
  );
  assert.match(
    retention,
    /realtime_session_leases[\s\S]*admission termination remains pending/u,
  );
  assert.match(
    retention,
    /retained child outlives mission retention[\s\S]*DELETE FROM public\.realtime_mistral_conversation_resume_tickets[\s\S]*DELETE FROM public\.realtime_mistral_conversation_commands[\s\S]*DELETE FROM public\.realtime_mistral_conversation_outbox[\s\S]*DELETE FROM public\.realtime_mistral_conversation_missions[\s\S]*DELETE FROM public\.realtime_mistral_conversation_bootstrap_tickets/u,
  );
  assert.doesNotMatch(
    retention,
    /DELETE FROM public\.realtime_(?:admission_events|speech_artifacts|control_grants|control_consumptions|voice_usage_events|voice_usage_daily)/u,
  );
  assert.match(
    rls,
    /realtime_mistral_conversation_mission_reaper_select[\s\S]*realtime_mistral_conversation_resume_reaper_select[\s\S]*realtime_session_lease_mistral_retention_reaper_select/u,
  );
  for (const provisioning of [release, certification]) {
    assert.match(
      provisioning,
      /"retainedFromServerSequence", "nextServerSequence"/u,
    );
    assert.match(
      provisioning,
      /"sessionHandle", "serverSequence", "retentionExpiresAt"/u,
    );
    assert.doesNotMatch(
      provisioning,
      /GRANT SELECT \([^)]*(?:"missionState"|"turnState"|"payloadCiphertext"|"payloadNonce"|"payloadTag"|"ticketHash"|"contextSnapshot"|"userIdentityCiphertext")/u,
    );
  }
  assert.match(adapter, /expected_select[\s\S]*separate_retention_tables/u);
  assert.match(
    adapter,
    /FROM expected_select AS expected[\s\S]*LEFT JOIN scoped_columns AS scoped[\s\S]*scoped\."columnName" IS NULL/u,
  );
  assert.match(
    adapter,
    /\(SELECT count\(\*\) FROM scoped_tables\) = 7[\s\S]*\(SELECT count\(\*\) FROM scoped_relations\) = 7/u,
  );
  assert.match(
    adapter,
    /runtimeCanDelete[\s\S]*runtimeCanTruncate[\s\S]*row\.runtimeCanDelete === false[\s\S]*row\.runtimeCanTruncate === false/u,
  );
  assert.match(adapter, /scoped_public_acl/u);
  assert.match(adapter, /AS "publicCanAccessScopedTables"/u);
  assert.match(adapter, /row\.publicCanAccessScopedTables === false/u);
  assert.match(
    postgresCertification,
    /refuse une Mission liée au bootstrap d’un autre tenant[\s\S]*préserve atomiquement un bootstrap expiré[\s\S]*attend la terminaison du lease[\s\S]*voit et préserve un enfant futur[\s\S]*deux répliques[\s\S]*advisory d’un writer/u,
  );
  assert.doesNotMatch(postgresCertification, /session_replication_role/u);
});

test('le reçu terminal Mistral est minimal, immuable, tenant-bound et obligatoire avant purge', async () => {
  const [
    terminalReceipt,
    retention,
    rls,
    adapter,
    release,
    certification,
    reaperPostgresCertification,
    terminationPostgresCertification,
  ] = await Promise.all([
    readFile(new URL(
      '../prisma/migrations/20260719082000_mistral_conversation_terminal_receipts/migration.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../prisma/migrations/20260719090000_mistral_conversation_ordered_retention/migration.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL('../prisma/rls.sql', import.meta.url), 'utf8'),
    readFile(new URL(
      '../src/voice/realtime/mistral-conversation-bootstrap-reaper.prisma.ts',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL('./release.sh', import.meta.url), 'utf8'),
    readFile(new URL('./certify-mistral-conversation-authority.sh', import.meta.url), 'utf8'),
    readFile(new URL(
      '../src/voice/realtime/mistral-conversation-bootstrap-reaper.postgres.test.ts',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../src/voice/realtime/mistral-conversation-reaper-termination.postgres.test.ts',
      import.meta.url,
    ), 'utf8'),
  ]);
  const tableStart = terminalReceipt.indexOf(
    'CREATE TABLE "realtime_mistral_conversation_terminal_receipts"',
  );
  const tableEnd = terminalReceipt.indexOf('\n);', tableStart);
  assert.notEqual(tableStart, -1);
  assert.notEqual(tableEnd, -1);
  const receiptDdl = terminalReceipt.slice(tableStart, tableEnd + 3);
  for (const column of [
    '"companyId"',
    '"sessionHandle"',
    '"subjectHash"',
    '"subjectKeyVersion"',
    'protocol',
    '"missionConnectionEpoch"',
    '"nextServerSequence"',
    '"terminalReason"',
    '"closedAt"',
    '"createdAt"',
  ]) {
    assert.match(receiptDdl, new RegExp(column, 'u'));
  }
  assert.doesNotMatch(
    receiptDdl,
    /audio|transcript|payload|ownerToken|userId|missionState|turnState|ciphertext|nonce|tag|retentionExpiresAt|expiresAt/iu,
  );
  assert.match(
    receiptDdl,
    /PRIMARY KEY \("companyId", "sessionHandle"\)[\s\S]*REFERENCES "companies"\(id\)[\s\S]*ON DELETE CASCADE ON UPDATE CASCADE/u,
  );
  assert.match(
    receiptDdl,
    /"nextServerSequence" BETWEEN 3 AND 4294967296/u,
  );
  assert.match(
    terminalReceipt,
    /SET LOCAL row_security = off[\s\S]*INSERT INTO "realtime_mistral_conversation_terminal_receipts"[\s\S]*FROM "realtime_mistral_conversation_missions"[\s\S]*mission\.phase = 'closed'/u,
  );
  assert.match(
    terminalReceipt,
    /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public[\s\S]*SET row_security = on[\s\S]*ON CONFLICT \("companyId", "sessionHandle"\) DO NOTHING[\s\S]*mistral_terminal_receipt_exact_binding/u,
  );
  assert.match(
    terminalReceipt,
    /CREATE TRIGGER realtime_mistral_terminal_receipt_immutable[\s\S]*BEFORE UPDATE OR DELETE/u,
  );
  assert.match(
    terminalReceipt,
    /CREATE TRIGGER realtime_mistral_terminal_receipt_truncate_guard[\s\S]*BEFORE TRUNCATE/u,
  );
  assert.match(
    terminalReceipt,
    /CREATE TRIGGER realtime_mistral_conversation_00_terminal_receipt[\s\S]*AFTER INSERT OR UPDATE OF phase[\s\S]*WHEN \(NEW\.phase = 'closed'\)/u,
  );
  assert.match(
    terminalReceipt,
    /CREATE TRIGGER realtime_mistral_conversation_00_terminal_receipt[\s\S]*INSERT INTO "realtime_mistral_conversation_terminal_receipts" \(/u,
  );
  assert.match(
    rls,
    /'realtime_mistral_conversation_terminal_receipts'[\s\S]*realtime_mistral_terminal_receipt_select[\s\S]*realtime_mistral_terminal_receipt_direct_insert[\s\S]*realtime_mistral_terminal_receipt_reaper_select/u,
  );
  assert.match(
    retention,
    /FROM public\.realtime_mistral_conversation_terminal_receipts AS receipt[\s\S]*"subjectHash" IS NOT DISTINCT FROM locked_subject_hash[\s\S]*"nextServerSequence" IS NOT DISTINCT FROM locked_next_server_sequence[\s\S]*terminal receipt missing or inconsistent[\s\S]*DELETE FROM public\.realtime_mistral_conversation_missions/u,
  );
  assert.doesNotMatch(
    retention,
    /DELETE FROM public\.realtime_mistral_conversation_terminal_receipts/u,
  );
  assert.match(
    adapter,
    /scoped_tables[\s\S]*realtime_mistral_conversation_terminal_receipts'::text, false[\s\S]*expected_select[\s\S]*realtime_mistral_conversation_terminal_receipts', 'subjectHash'[\s\S]*realtime_mistral_conversation_terminal_receipts', 'closedAt'/u,
  );
  assert.doesNotMatch(
    adapter,
    /realtime_mistral_conversation_terminal_receipts', 'createdAt'/u,
  );
  assert.match(
    release,
    /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE[\s\S]*realtime_mistral_conversation_terminal_receipts[\s\S]*FROM :"app_role"/u,
  );
  for (const provisioning of [release, certification]) {
    assert.match(
      provisioning,
      /GRANT SELECT \([\s\S]*"companyId", "sessionHandle", "subjectHash", "subjectKeyVersion", protocol,[\s\S]*"missionConnectionEpoch", "nextServerSequence", "terminalReason", "closedAt"[\s\S]*realtime_mistral_conversation_terminal_receipts/u,
    );
    assert.doesNotMatch(
      provisioning,
      /GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE)[^;]*realtime_mistral_conversation_terminal_receipts/u,
    );
  }
  assert.match(
    reaperPostgresCertification,
    /tenant-readable, immuable[\s\S]*company-cascade-terminal-receipt[\s\S]*reçu terminal exact est %s/u,
  );
  assert.match(
    terminationPostgresCertification,
    /receiptCount: 0[\s\S]*receiptCount: 1[\s\S]*receiptMatches: true/u,
  );
  assert.doesNotMatch(reaperPostgresCertification, /session_replication_role/u);
});

test('la release sérialise et certifie le keyring identité sans donner sa mutation au runtime', async () => {
  const [release, certification, manager, migration, postgresCertification, rls] =
    await Promise.all([
      readFile(new URL('./release.sh', import.meta.url), 'utf8'),
      readFile(new URL('./certify-mistral-conversation-authority.sh', import.meta.url), 'utf8'),
      readFile(new URL('./manage-mistral-conversation-key-version.mjs', import.meta.url), 'utf8'),
      readFile(new URL(
        '../prisma/migrations/20260719070000_mistral_conversation_identity_key_floor/migration.sql',
        import.meta.url,
      ), 'utf8'),
      readFile(new URL(
        '../src/voice/realtime/mistral-conversation-identity-key-version-lifecycle.postgres.test.ts',
        import.meta.url,
      ), 'utf8'),
      readFile(new URL('../prisma/rls.sql', import.meta.url), 'utf8'),
    ]);

  assert.match(
    release,
    /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE[\s\S]*realtime_mistral_conversation_identity_key_version_floors,[\s\S]*realtime_mistral_conversation_identity_key_bindings/u,
  );
  assert.match(
    certification,
    /RUN_POSTGRES_MISTRAL_IDENTITY_KEY_ROTATION_CERT=true[\s\\]+pnpm[\s\S]*mistral-conversation-identity-key-version-lifecycle\.postgres\.test\.ts/u,
  );
  assert.match(
    manager,
    /pg_advisory_xact_lock\(hashtextextended\(\$\{KEY_SPACE\}[\s\S]*pg_advisory_xact_lock\(hashtextextended\(\$\{IDENTITY_KEY_SPACE\}/u,
  );
  assert.match(
    migration,
    /pg_advisory_xact_lock_shared[\s\S]*"identityEncryptionKeyVersion"[\s\S]*MISTRAL_CONVERSATION_IDENTITY_KEY_VERSION_NOT_ADMITTED/u,
  );
  assert.match(
    migration,
    /"identityEncryptionKeyVersion" = OLD\."minimumVersion"[\s\S]*MISTRAL_CONVERSATION_IDENTITY_KEY_VERSION_RETAINED/u,
  );
  assert.match(
    rls,
    /realtime_mistral_identity_key_floor_direct_update[\s\S]*TO CURRENT_USER[\s\S]*realtime_mistral_identity_key_binding_direct_insert/u,
  );
  assert.match(
    postgresCertification,
    /waitForRetirementLock[\s\S]*MISTRAL_CONVERSATION_IDENTITY_KEY_VERSION_RETAINED/u,
  );
  assert.match(
    postgresCertification,
    /rolsuper: false[\s\S]*rolbypassrls: false/u,
  );
  assert.doesNotMatch(postgresCertification, /session_replication_role/u);
});

test('la release et le boot attestent tout le keyring HMAC sujet encore utile', async () => {
  const [
    release,
    certification,
    environmentGate,
    manager,
    migration,
    authority,
    composition,
    postgresCertification,
  ] = await Promise.all([
    readFile(new URL('./release.sh', import.meta.url), 'utf8'),
    readFile(new URL('./certify-mistral-conversation-authority.sh', import.meta.url), 'utf8'),
    readFile(new URL('./check-release-env.sh', import.meta.url), 'utf8'),
    readFile(new URL('./manage-mistral-conversation-key-version.mjs', import.meta.url), 'utf8'),
    readFile(new URL(
      '../prisma/migrations/20260719083000_mistral_conversation_subject_key_floor/migration.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../src/voice/realtime/mistral-conversation-subject-key-version.prisma.ts',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL('../src/voice/realtime/realtime.module.ts', import.meta.url), 'utf8'),
    readFile(new URL(
      '../src/voice/realtime/mistral-conversation-subject-key-version.postgres.test.ts',
      import.meta.url,
    ), 'utf8'),
  ]);

  assert.match(
    manager,
    /pg_advisory_xact_lock\(hashtextextended\(\$\{KEY_SPACE\}[\s\S]*pg_advisory_xact_lock\(hashtextextended\(\$\{IDENTITY_KEY_SPACE\}[\s\S]*pg_advisory_xact_lock\(hashtextextended\(\$\{SUBJECT_KEY_SPACE\}/u,
  );
  assert.match(
    manager,
    /realtime_mistral_conversation_bootstrap_tickets[\s\S]*realtime_mistral_conversation_missions[\s\S]*realtime_mistral_conversation_terminal_receipts[\s\S]*retained_subject_versions/u,
  );
  assert.match(manager, /createHash\('sha256'\)\.update\(secret, 'utf8'\)/u);
  assert.match(
    migration,
    /BOB_LIVE_SUBJECT_KEY_VERSION_UNBOUND[\s\S]*retained_bob_live_subject_hmac_key_bindings\(\)[\s\S]*SECURITY DEFINER[\s\S]*SET row_security = off/u,
  );
  assert.match(
    authority,
    /retained_bob_live_subject_hmac_key_bindings\(\)[\s\S]*configuredFingerprints\.get\(version\)[\s\S]*does not match durable version/u,
  );
  assert.match(
    composition,
    /const subjectKeys = live\.subjectHmacKeyRing[\s\S]*createMistralConversationTerminalReplayAuthorities\([\s\S]*subjectKeys[\s\S]*await authorities\.assertCurrentKeyVersion\(\)/u,
  );
  assert.match(
    release,
    /prisma migrate deploy[\s\S]*manage-mistral-conversation-key-version\.mjs stage/u,
  );
  assert.match(
    release,
    /retained_bob_live_subject_hmac_key_bindings\(\)[\s\S]*GRANT EXECUTE/u,
  );
  assert.match(
    certification,
    /mistral-conversation-subject-key-version\.postgres\.test\.ts/u,
  );
  assert.match(
    environmentGate,
    /BOB_LIVE_SUBJECT_HMAC_KEYRING[\s\S]*codePoint < 0x21 \|\| codePoint > 0x7e[\s\S]*legacy subject HMAC secret must match/u,
  );
  assert.match(
    postgresCertification,
    /securityDefiner: true[\s\S]*publicCanExecute: false[\s\S]*does not match durable version/u,
  );
  assert.doesNotMatch(postgresCertification, /session_replication_role/u);
});

test('le DELETE du bail mcv2 exige une Mission terminale exacte sous triggers actifs', async () => {
  const [certification, migration, postgresCertification, terminationCertification] = await Promise.all([
    readFile(new URL('./certify-mistral-conversation-authority.sh', import.meta.url), 'utf8'),
    readFile(new URL(
      '../prisma/migrations/20260719040000_mistral_conversation_admission_delete_fence/migration.sql',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../src/voice/realtime/mistral-conversation-admission-delete-fence.postgres.test.ts',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL(
      '../src/voice/realtime/mistral-conversation-reaper-termination.postgres.test.ts',
      import.meta.url,
    ), 'utf8'),
  ]);

  assert.match(migration, /BEFORE DELETE ON "realtime_session_leases"/u);
  assert.match(
    migration,
    /"providerCallId" !~[\s\S]*\^mcv2:[\s\S]*"initialBootstrapId" = bootstrap_id/u,
  );
  assert.match(
    migration,
    /mission\.phase = 'closed'[\s\S]*"closedAt" IS NOT NULL[\s\S]*session\.draining[\s\S]*session\.closed/u,
  );
  assert.match(
    certification,
    /RUN_POSTGRES_MISTRAL_CONVERSATION_LEASE_FENCE_CERT=true[\s\\]+RUN_POSTGRES_MISTRAL_CONVERSATION_REAPER_TERMINATION_CERT=true[\s\\]+pnpm/u,
  );
  assert.match(
    certification,
    /mistral-conversation-admission-delete-fence\.postgres\.test\.ts/u,
  );
  assert.match(
    certification,
    /RUN_POSTGRES_MISTRAL_CONVERSATION_REAPER_TERMINATION_CERT=true[\s\\]+pnpm/u,
  );
  assert.match(
    certification,
    /mistral-conversation-reaper-termination\.postgres\.test\.ts/u,
  );
  assert.doesNotMatch(postgresCertification, /session_replication_role/u);
  assert.doesNotMatch(
    terminationCertification,
    /(?:SET|set_config)\s*(?:LOCAL\s+)?\(?['"]?session_replication_role/iu,
  );
  assert.match(
    terminationCertification,
    /currentUser: 'bob_app'[\s\S]*isSuperuser: false[\s\S]*bypassRls: false/u,
  );
});

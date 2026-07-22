import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const [
  release,
  migration,
  reaperIndex,
  tenantRetentionIndex,
  expiryIndex,
  retentionIndex,
  fenceAdd,
  fenceValidate,
  rls,
  metadataCert,
  ci,
  postgresCert,
  maintenanceAdapter,
] = await Promise.all([
  readFile(new URL('scripts/release.sh', root), 'utf8'),
  readFile(
    new URL(
      'prisma/migrations/20260722020000_openai_native_speech_maintenance/migration.sql',
      root,
    ),
    'utf8',
  ),
  readFile(
    new URL(
      'prisma/migrations/20260722020100_openai_native_speech_tenant_reaper_index/migration.sql',
      root,
    ),
    'utf8',
  ),
  readFile(
    new URL(
      'prisma/migrations/20260722020200_openai_native_speech_tenant_retention_index/migration.sql',
      root,
    ),
    'utf8',
  ),
  readFile(
    new URL(
      'prisma/migrations/20260722020300_openai_native_speech_expiry_directory_index/migration.sql',
      root,
    ),
    'utf8',
  ),
  readFile(
    new URL(
      'prisma/migrations/20260722020400_openai_native_speech_retention_directory_index/migration.sql',
      root,
    ),
    'utf8',
  ),
  readFile(
    new URL(
      'prisma/migrations/20260722021000_openai_native_provider_stream_v1_fence/migration.sql',
      root,
    ),
    'utf8',
  ),
  readFile(
    new URL(
      'prisma/migrations/20260722022000_openai_native_provider_stream_v1_fence_validate/migration.sql',
      root,
    ),
    'utf8',
  ),
  readFile(new URL('prisma/rls.sql', root), 'utf8'),
  readFile(new URL('prisma/openai-native-release-cert.sql', root), 'utf8'),
  readFile(new URL('../../.github/workflows/ci.yml', root), 'utf8'),
  readFile(
    new URL('src/voice/realtime/openai-native-speech-delivery.postgres.test.ts', root),
    'utf8',
  ),
  readFile(new URL('src/voice/realtime/openai-native-speech-maintenance.prisma.ts', root), 'utf8'),
]);
const indexes = [reaperIndex, tenantRetentionIndex, expiryIndex, retentionIndex].join('\n');

test('la release live exécute une certification metadata-only après migration, ACL et RLS', () => {
  const call = '\ncertify_openai_native_release_metadata\n';
  assert.equal(release.split(call).length - 1, 1, 'metadata certificate call must be unique');
  const markers = [
    'prisma migrate deploy',
    'grant_app_role',
    ' -f apps/api/prisma/rls.sql',
    'provision_openai_native_maintenance_directory',
    call.trim(),
  ].map((marker) => release.lastIndexOf(marker));
  assert.ok(markers.every((index) => index >= 0));
  assert.deepEqual(
    markers,
    [...markers].sort((left, right) => left - right),
  );
  assert.doesNotMatch(release, /RUN_POSTGRES_OPENAI_NATIVE_DELIVERY_CERT/u);

  assert.match(metadataCert, /^BEGIN TRANSACTION READ ONLY;$/mu);
  assert.match(metadataCert, /^ROLLBACK;$/mu);
  assert.doesNotMatch(
    metadataCert,
    /^\s*(?:INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|ALTER\s+|CREATE\s+|DROP\s+|TRUNCATE\s+)/gmu,
  );
});

test('la certification mutationnelle native reste confinée au PostgreSQL éphémère de CI', () => {
  assert.match(ci, /RUN_POSTGRES_OPENAI_NATIVE_DELIVERY_CERT: 'true'/u);
  assert.match(ci, /OPENAI_NATIVE_CERT_DATABASE_KIND: ephemeral/u);
  assert.match(
    ci,
    /POSTGRES_DB: bob_ephemeral_ci[\s\S]{0,400}--health-cmd "pg_isready -U postgres -d bob_ephemeral_ci"/u,
  );
  assert.match(
    ci,
    /DATABASE_URL: postgresql:\/\/bob_app:bob_app@localhost:5432\/bob_ephemeral_ci/u,
  );
  assert.match(
    ci,
    /DIRECT_URL: postgresql:\/\/postgres:postgres@localhost:5432\/bob_ephemeral_ci/u,
  );
  assert.match(ci, /openai-native-speech-delivery\.postgres\.test\.ts/u);
  assert.match(postgresCert, /LOOPBACK_HOSTS/u);
  assert.match(postgresCert, /\^bob_ephemeral_/u);
  assert.match(postgresCert, /current_database\(\)/u);
  assert.doesNotMatch(postgresCert, /ALTER TABLE[\s\S]*DISABLE TRIGGER/u);
});

test('la découverte due est une livraison at-least-once claimée, renouvelable puis ACKée', () => {
  assert.match(
    migration,
    /CREATE FUNCTION public\.list_realtime_native_speech_maintenance_tenants_v1\(\s*maintenance_lane TEXT,\s*batch_limit INTEGER,\s*claim_id UUID\s*\)/u,
  );
  assert.match(migration, /RETURNS TABLE \("companyId" TEXT, "hasMore" BOOLEAN, "claimId" UUID\)/u);
  assert.match(
    migration,
    /CREATE FUNCTION public\.ack_realtime_native_speech_maintenance_tenants_v1\(\s*maintenance_lane TEXT,\s*claim_id UUID\s*\)/u,
  );
  assert.match(
    migration,
    /CREATE FUNCTION public\.renew_realtime_native_speech_maintenance_claim_v1\(\s*maintenance_lane TEXT,\s*claim_id UUID\s*\)/u,
  );
  assert.match(migration, /"cycleUpperDueAt" TIMESTAMPTZ/u);
  assert.match(migration, /"pendingCompanyIds" TEXT\[\] NOT NULL/u);
  assert.match(migration, /"pendingAfterDeliveryId" UUID/u);
  assert.match(migration, /"pendingHasMore" BOOLEAN/u);
  assert.match(migration, /"claimId" UUID/u);
  assert.match(migration, /"claimExpiresAt" TIMESTAMPTZ/u);
  assert.match(migration, /"claimExpiresAt" = observed_at \+ INTERVAL '30 seconds'/u);
  assert.match(migration, /"claimExpiresAt" = statement_timestamp\(\) \+ INTERVAL '30 seconds'/u);
  assert.match(migration, /IF active_claim_expires_at > observed_at THEN\s+RETURN;/u);
  assert.match(migration, /"claimId" = claim_id[\s\S]*revision = cursor\.revision \+ 1/u);
  assert.match(
    migration,
    /"afterDueAt" = CASE WHEN pending_has_more THEN pending_after_due_at ELSE NULL END/u,
  );
  assert.match(migration, /"pendingCompanyIds" = ARRAY\[\]::TEXT\[\]/u);
  assert.match(migration, /LIMIT batch_limit \+ 1/u);
  assert.doesNotMatch(migration, /ORDER BY MIN\(/u);
});

test('les appels directory arment leurs timeouts avant la fonction et échouent fermé sous lock', () => {
  assert.equal(maintenanceAdapter.match(/this\.withBoundedDirectory\(/gu)?.length, 3);
  assert.match(maintenanceAdapter, /withIsolatedGlobal\(async \(tx\) =>/u);
  assert.match(
    maintenanceAdapter,
    /set_config\(\s*'statement_timeout', \$\{DIRECTORY_STATEMENT_TIMEOUT\}, true/u,
  );
  assert.match(
    maintenanceAdapter,
    /set_config\(\s*'lock_timeout', \$\{DIRECTORY_LOCK_TIMEOUT\}, true/u,
  );
  assert.match(
    maintenanceAdapter,
    /MAINTENANCE_TRANSACTION_OPTIONS = \{ maxWaitMs: 1_000, timeoutMs: 4_000 \}/u,
  );
  assert.match(postgresCert, /borne réellement l’attente du curseur global verrouillé/u);
  assert.match(postgresCert, /elapsedMs/u);
});

test('le curseur global est fermé par FORCE RLS et exactement deux policies directory', () => {
  assert.match(
    migration,
    /ALTER TABLE public\.realtime_native_speech_maintenance_cursors ENABLE ROW LEVEL SECURITY;/u,
  );
  assert.match(
    migration,
    /ALTER TABLE public\.realtime_native_speech_maintenance_cursors FORCE ROW LEVEL SECURITY;/u,
  );
  for (const policy of [
    'realtime_native_speech_maintenance_cursor_directory_select',
    'realtime_native_speech_maintenance_cursor_directory_update',
  ]) {
    assert.match(migration, new RegExp(`CREATE POLICY ${policy}`, 'u'));
    assert.match(rls, new RegExp(`CREATE POLICY ${policy}`, 'u'));
    assert.match(metadataCert, new RegExp(`'${policy}'`, 'u'));
  }
  assert.equal(
    migration.match(/CREATE POLICY realtime_native_speech_maintenance_cursor_/gu)?.length,
    2,
  );
  assert.equal(rls.match(/CREATE POLICY realtime_native_speech_maintenance_cursor_/gu)?.length, 2);
  assert.match(
    metadataCert,
    /relation\.relrowsecurity AND relation\.relforcerowsecurity[\s\S]*realtime_native_speech_maintenance_cursors/u,
  );
  assert.match(metadataCert, /policy\.polroles = ARRAY\[0::OID\]/u);
  assert.match(metadataCert, /pg_catalog\.md5\(COALESCE\([\s\S]*policy\.polqual/u);
  assert.match(metadataCert, /realtime_native_speech_maintenance_cursors'::regclass\) <> 2/u);
  assert.match(metadataCert, /OpenAI native maintenance cursor RLS drift/u);
});

test('le runtime ne reçoit que DELETE tenanté et les trois capacités directory exactes', () => {
  assert.match(
    release,
    /GRANT DELETE ON TABLE public\.realtime_native_speech_deliveries TO :"app_role"/u,
  );
  assert.match(
    release,
    /REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public\.realtime_native_speech_deliveries/u,
  );
  assert.match(release, /ensure_openai_native_maintenance_directory_role/u);
  assert.match(release, /NOLOGIN[\s\S]*NOBYPASSRLS/u);
  assert.match(
    release,
    /GRANT SELECT \("deliveryId", "companyId", phase, "expiresAt", "retentionExpiresAt"\)/u,
  );
  assert.match(
    release,
    /GRANT SELECT, UPDATE ON TABLE public\.realtime_native_speech_maintenance_cursors/u,
  );
  assert.match(
    release,
    /REVOKE ALL ON TABLE public\.realtime_native_speech_maintenance_cursors FROM :"app_role"/u,
  );
  for (const signature of [
    'list_realtime_native_speech_maintenance_tenants_v1\\(TEXT, INTEGER, UUID\\)',
    'ack_realtime_native_speech_maintenance_tenants_v1\\(TEXT, UUID\\)',
    'renew_realtime_native_speech_maintenance_claim_v1\\(TEXT, UUID\\)',
  ]) {
    assert.match(
      release,
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature}\\s+FROM :"app_role"`, 'u'),
    );
    assert.match(
      release,
      new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature}\\s+TO :"app_role"`, 'u'),
    );
    assert.match(
      release,
      new RegExp(`ALTER FUNCTION public\\.${signature}\\s+SECURITY DEFINER`, 'u'),
    );
  }
  assert.match(
    release,
    /GRANT SELECT, UPDATE ON TABLE public\.realtime_native_speech_maintenance_cursors\s+TO bob_openai_native_maintenance_directory/u,
  );
  assert.match(
    release,
    /REVOKE ALL PRIVILEGES ON TABLE public\.realtime_native_speech_maintenance_cursors FROM %s CASCADE/u,
  );
  assert.match(
    migration,
    /realtime_native_speech_delivery_delete_retention_fence[\s\S]*AS RESTRICTIVE/u,
  );
  assert.match(migration, /realtime_native_speech_delivery_due_directory_select/u);
  assert.equal(indexes.match(/CREATE INDEX CONCURRENTLY/gu)?.length, 4);
  assert.doesNotMatch(indexes, /BEGIN|COMMIT/u);
  assert.match(migration, /FOR UPDATE/u);
  assert.match(metadataCert, /OpenAI native maintenance directory ACL drift/u);
  assert.match(metadataCert, /OpenAI native maintenance cursor exact ACL drift/u);
});

test('release, rejeu RLS et certificat ciblent les mêmes signatures exactes', () => {
  const sources = { release, rls, metadataCert };
  const signatures = [
    /list_realtime_native_speech_maintenance_tenants_v1\(\s*text,\s*integer,\s*uuid\s*\)/iu,
    /ack_realtime_native_speech_maintenance_tenants_v1\(\s*text,\s*uuid\s*\)/iu,
    /renew_realtime_native_speech_maintenance_claim_v1\(\s*text,\s*uuid\s*\)/iu,
  ];
  for (const [sourceName, source] of Object.entries(sources)) {
    for (const signature of signatures) {
      assert.match(source, signature, `${sourceName} must use the exact directory signatures`);
    }
  }
  assert.doesNotMatch(
    Object.values(sources).join('\n'),
    /list_realtime_native_speech_maintenance_tenants_v1\(\s*text,\s*integer\s*\)/iu,
  );
  assert.match(
    metadataCert,
    /directory_function_oids OID\[\] := ARRAY\[[\s\S]*list_realtime_native_speech_maintenance_tenants_v1\(text,integer,uuid\)[\s\S]*ack_realtime_native_speech_maintenance_tenants_v1\(text,uuid\)[\s\S]*renew_realtime_native_speech_maintenance_claim_v1\(text,uuid\)/u,
  );
  assert.match(metadataCert, /TABLE\("companyId" text, "hasMore" boolean, "claimId" uuid\)/u);
  assert.match(metadataCert, /OpenAI native maintenance directory authority drift/u);
});

test('le certificat refuse tout runtime privilégié et toute dérive de membership directory', () => {
  assert.match(
    metadataCert,
    /role\.rolsuper OR role\.rolcreatedb OR role\.rolcreaterole\s+OR role\.rolreplication OR role\.rolbypassrls/u,
  );
  assert.match(
    metadataCert,
    /privileged_role\.rolsuper OR privileged_role\.rolcreatedb[\s\S]*pg_catalog\.pg_has_role\(app_role_name, privileged_role\.oid, 'SET'\)/u,
  );
  assert.match(metadataCert, /OpenAI native runtime role can assume a privileged role/u);
  assert.match(
    metadataCert,
    /membership\.member = pg_catalog\.to_regrole\(session_user\)[\s\S]*AND NOT membership\.admin_option[\s\S]*AND NOT membership\.inherit_option[\s\S]*AND membership\.set_option\) <> 1/u,
  );
  assert.match(
    metadataCert,
    /WHERE membership\.roleid =\s+'bob_openai_native_maintenance_directory'::regrole\) <> 1/u,
  );
  assert.match(
    metadataCert,
    /WHERE membership\.member =\s+'bob_openai_native_maintenance_directory'::regrole/u,
  );
  assert.match(metadataCert, /OpenAI native maintenance directory membership drift/u);
  assert.match(
    metadataCert,
    /pg_has_role\(\s*app_role_name,\s*'bob_openai_native_maintenance_directory',\s*'SET'\s*\)/u,
  );
  assert.match(
    release,
    /GRANT bob_openai_native_maintenance_directory TO CURRENT_USER\s+WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;/u,
  );
});

test('les helpers trigger/directory restent révoqués et provider_stream physiquement interdit', () => {
  for (const name of [
    'guard_realtime_native_delivery_delete_v1',
    'deny_realtime_native_delivery_truncate_v1',
  ]) {
    assert.match(rls, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}`, 'u'));
  }
  assert.match(
    release,
    /REVOKE ALL ON FUNCTION\s+public\.list_realtime_native_speech_maintenance_tenants_v1\s*\(\s*TEXT, INTEGER, UUID\s*\)\s+FROM PUBLIC/u,
  );
  assert.match(
    release,
    /REVOKE ALL ON FUNCTION\s+public\.ack_realtime_native_speech_maintenance_tenants_v1\s*\(\s*TEXT, UUID\s*\)\s+FROM PUBLIC/u,
  );
  assert.match(
    release,
    /REVOKE ALL ON FUNCTION\s+public\.renew_realtime_native_speech_maintenance_claim_v1\s*\(\s*TEXT, UUID\s*\)\s+FROM PUBLIC/u,
  );
  assert.match(
    fenceAdd,
    /realtime_control_grants_provider_stream_v1_disabled_check[\s\S]*CHECK \("deliveryKind" <> 'provider_stream'\)/u,
  );
  assert.match(fenceAdd, /NOT VALID/u);
  assert.doesNotMatch(fenceAdd, /VALIDATE CONSTRAINT/u);
  assert.match(fenceValidate, /VALIDATE CONSTRAINT/u);
  assert.doesNotMatch(fenceValidate, /ADD CONSTRAINT/u);
  assert.doesNotMatch(release, /OPENAI_NATIVE_SPEECH_MAINTENANCE_ENABLED/u);
});

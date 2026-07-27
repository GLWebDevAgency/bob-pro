import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(scriptDir, '..');
const repositoryRoot = path.resolve(apiDir, '..', '..');
const expandPath = path.join(
  apiDir,
  'prisma/migrations/20260726010000_agent_missions_expand/migration.sql',
);
const validatePath = path.join(
  apiDir,
  'prisma/migrations/20260726020000_agent_missions_validate/migration.sql',
);
const capabilityFlagFencePath = path.join(
  apiDir,
  'prisma/migrations/20260727130000_release_flag_cabinet_subject_revocation_fence/migration.sql',
);
const capabilityExpandPath = path.join(
  apiDir,
  'prisma/migrations/20260727140000_agent_mission_realtime_lease_expand/migration.sql',
);
const capabilityValidatePath = path.join(
  apiDir,
  'prisma/migrations/20260727150000_agent_mission_realtime_lease_validate/migration.sql',
);
const cancellationExpandPath = path.join(
  apiDir,
  'prisma/migrations/20260727160000_realtime_admission_cancellation_fence_expand/migration.sql',
);
const cancellationValidatePath = path.join(
  apiDir,
  'prisma/migrations/20260727170000_realtime_admission_cancellation_fence_validate/migration.sql',
);
const commandNamespaceExpandPath = path.join(
  apiDir,
  'prisma/migrations/20260727180000_agent_mission_event_command_namespace_expand/migration.sql',
);
const commandNamespaceValidatePath = path.join(
  apiDir,
  'prisma/migrations/20260727190000_agent_mission_event_command_namespace_validate/migration.sql',
);
const commandNamespaceCutoverPath = path.join(
  apiDir,
  'prisma/migrations/20260727200000_agent_mission_event_command_namespace_cutover/migration.sql',
);
const fingerprintKeyReadinessPath = path.join(
  apiDir,
  'prisma/migrations/20260727210000_agent_mission_fingerprint_key_readiness/migration.sql',
);
const bootstrapReceiptExpandPath = path.join(
  apiDir,
  'prisma/migrations/20260727220000_agent_mission_bootstrap_receipt_expand/migration.sql',
);
const bootstrapReceiptValidatePath = path.join(
  apiDir,
  'prisma/migrations/20260727230000_agent_mission_bootstrap_receipt_validate/migration.sql',
);
const schemaPath = path.join(apiDir, 'prisma/schema.prisma');
const rlsPath = path.join(apiDir, 'prisma/rls.sql');
const agentMissionRlsReplayPath = path.join(
  apiDir,
  'prisma/agent-mission-realtime-rls-replay.sql',
);
const generatorPath = path.join(scriptDir, 'generate-agent-mission-migration-values.mjs');

const [
  expand,
  validate,
  capabilityFlagFence,
  capabilityExpand,
  capabilityValidate,
  cancellationExpand,
  cancellationValidate,
  commandNamespaceExpand,
  commandNamespaceValidate,
  commandNamespaceCutover,
  fingerprintKeyReadiness,
  bootstrapReceiptExpand,
  bootstrapReceiptValidate,
  schema,
  rls,
  agentMissionRlsReplay,
  generator,
] = await Promise.all([
  readFile(expandPath, 'utf8'),
  readFile(validatePath, 'utf8'),
  readFile(capabilityFlagFencePath, 'utf8'),
  readFile(capabilityExpandPath, 'utf8'),
  readFile(capabilityValidatePath, 'utf8'),
  readFile(cancellationExpandPath, 'utf8'),
  readFile(cancellationValidatePath, 'utf8'),
  readFile(commandNamespaceExpandPath, 'utf8'),
  readFile(commandNamespaceValidatePath, 'utf8'),
  readFile(commandNamespaceCutoverPath, 'utf8'),
  readFile(fingerprintKeyReadinessPath, 'utf8'),
  readFile(bootstrapReceiptExpandPath, 'utf8'),
  readFile(bootstrapReceiptValidatePath, 'utf8'),
  readFile(schemaPath, 'utf8'),
  readFile(rlsPath, 'utf8'),
  readFile(agentMissionRlsReplayPath, 'utf8'),
  readFile(generatorPath, 'utf8'),
]);

test('les listes SQL AgentMission sont générées depuis les constantes du core', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(scriptDir, 'generate-agent-mission-migration-values.mjs'), '--check'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(generator, /\^\[0-9_,\\s\]\+\$/u);
  assert.doesNotMatch(
    generator.match(/function extractNumericConstArray[\s\S]*?\n\}/u)?.[0] ?? '',
    /matchAll/u,
  );
  assert.match(generator, /frozenCapabilityExpandProtocolVersions = \['1'\]/u);
  assert.match(
    generator,
    /AGENT_MISSION_PROTOCOL_MIGRATION_FROZEN: create a new expand\/validate migration/u,
  );
});

test('chaque migration borne les verrous et le temps de statement dans sa transaction', () => {
  for (const [name, sql] of [
    ['expand', expand],
    ['validate', validate],
    ['capability flag fence', capabilityFlagFence],
    ['capability expand', capabilityExpand],
    ['capability validate', capabilityValidate],
    ['cancellation expand', cancellationExpand],
    ['cancellation validate', cancellationValidate],
    ['command namespace expand', commandNamespaceExpand],
    ['command namespace validate', commandNamespaceValidate],
    ['command namespace cutover', commandNamespaceCutover],
    ['fingerprint key readiness', fingerprintKeyReadiness],
    ['bootstrap receipt expand', bootstrapReceiptExpand],
    ['bootstrap receipt validate', bootstrapReceiptValidate],
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

test('le registre fingerprint lie le matériau, borne les writers et ferme Data API', () => {
  assert.match(
    fingerprintKeyReadiness,
    /CREATE TABLE public\.agent_mission_fingerprint_key_version_floors/u,
  );
  assert.match(
    fingerprintKeyReadiness,
    /CREATE TABLE public\.agent_mission_fingerprint_key_bindings/u,
  );
  assert.match(
    fingerprintKeyReadiness,
    /UNIQUE \("keyFingerprint"\)[\s\S]*?"keyFingerprint"::TEXT ~ '\^\[a-f0-9\]\{64\}\$'/u,
  );
  assert.doesNotMatch(
    fingerprintKeyReadiness,
    /CREATE INDEX[\s\S]*?ON public\.agent_mission_events/u,
    'Le déployeur non-owner ne doit pas créer directement un index sur le journal.',
  );
  assert.match(
    fingerprintKeyReadiness,
    /"highestWriterVersion"::BIGINT[\s\S]*?<= "minimumWriterVersion"::BIGINT \+ 1/u,
  );
  assert.match(
    fingerprintKeyReadiness,
    /"writerEnabled" BOOLEAN NOT NULL DEFAULT TRUE/u,
  );
  assert.match(
    fingerprintKeyReadiness,
    /agent_mission_fingerprint_key_floor_guard_v1[\s\S]*?BEFORE INSERT OR UPDATE OR DELETE/u,
  );
  assert.match(
    fingerprintKeyReadiness,
    /AGENT_MISSION_FINGERPRINT_KEY_FLOOR_UNBOUND[\s\S]*?agent_mission_fingerprint_key_floor_binding_required/u,
  );
  assert.match(
    fingerprintKeyReadiness,
    /NEW\."writerEnabled" IS DISTINCT FROM OLD\."writerEnabled"[\s\S]*?OLD\."updatedAt" \+ INTERVAL '1 microsecond'/u,
  );
  assert.match(
    fingerprintKeyReadiness,
    /agent_mission_fingerprint_key_binding_immutable_v1[\s\S]*?BEFORE UPDATE OR DELETE OR TRUNCATE/u,
  );
  assert.match(
    fingerprintKeyReadiness,
    /guard_agent_mission_fingerprint_key_binding_present_v1\(\)[\s\S]*?pg_advisory_xact_lock_shared[\s\S]*?IF NOT FOUND THEN[\s\S]*?RETURN NEW[\s\S]*?AGENT_MISSION_FINGERPRINT_KEY_VERSION_NOT_ADMITTED[\s\S]*?AGENT_MISSION_FINGERPRINT_KEY_VERSION_UNBOUND/u,
  );
  assert.match(
    fingerprintKeyReadiness,
    /WITH RECURSIVE[\s\S]*?retained_versions\(version, ordinal\)[\s\S]*?WHERE event\."fingerprintKeyVersion" > retained\.version[\s\S]*?retained\.ordinal < 33/u,
  );
  assert.doesNotMatch(
    fingerprintKeyReadiness,
    /SELECT DISTINCT event\."fingerprintKeyVersion"/u,
    'La readiness ne doit pas scanner tout l’index pour DISTINCT sur chaque boot.',
  );
  assert.match(
    fingerprintKeyReadiness,
    /trigger sur agent_mission_events est créé par le provisionneur post-migration sous SET ROLE/u,
  );
  assert.match(
    fingerprintKeyReadiness,
    /CREATE FUNCTION public\.agent_mission_fingerprint_key_readiness\([\s\S]*?"configuredVersions" INTEGER\[\]/u,
  );
  assert.match(
    fingerprintKeyReadiness,
    /RETURNS TABLE \([\s\S]*?"keyVersion" INTEGER,[\s\S]*?"keyFingerprint" TEXT,[\s\S]*?retained BOOLEAN,[\s\S]*?"minimumWriterVersion" INTEGER,[\s\S]*?"highestWriterVersion" INTEGER,[\s\S]*?"writerEnabled" BOOLEAN/u,
  );
  assert.match(
    fingerprintKeyReadiness,
    /AGENT_MISSION_FINGERPRINT_KEY_WRITER_DISABLED[\s\S]*?agent_mission_fingerprint_key_writer_disabled/u,
  );
  assert.match(
    fingerprintKeyReadiness,
    /LANGUAGE plpgsql[\s\S]*?VOLATILE[\s\S]*?SECURITY DEFINER/u,
  );
  assert.match(fingerprintKeyReadiness, /SET search_path = pg_catalog/u);
  assert.match(fingerprintKeyReadiness, /SET row_security = on/u);
  assert.match(
    fingerprintKeyReadiness,
    /cardinality\("configuredVersions"\) > 32[\s\S]*?count\(DISTINCT configured\.version\)/u,
  );
  assert.match(
    fingerprintKeyReadiness,
    /pg_advisory_xact_lock_shared\([\s\S]*?bob-agent-mission-fingerprint-hmac-v1/u,
  );
  assert.match(
    fingerprintKeyReadiness,
    /LEFT JOIN public\.agent_mission_fingerprint_key_version_floors[\s\S]*?LEFT JOIN public\.agent_mission_fingerprint_key_bindings/u,
  );
  assert.ok(
    (
      fingerprintKeyReadiness.match(
        /FORCE ROW LEVEL SECURITY/gmu,
      ) ?? []
    ).length >= 2,
  );
  assert.match(
    fingerprintKeyReadiness,
    /REVOKE ALL PRIVILEGES[\s\S]*?FROM PUBLIC/u,
  );
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.match(fingerprintKeyReadiness, new RegExp(`'${role}'`, 'u'));
  }
  assert.doesNotMatch(
    fingerprintKeyReadiness.match(
      /CREATE FUNCTION public\.agent_mission_fingerprint_key_readiness\([\s\S]*?\$agent_mission_fingerprint_key_readiness\$;/u,
    )?.[0] ?? '',
    /\b(?:EXECUTE|format)\b/u,
  );
});

test('le namespace commandId ACK est expand, validé puis cutover sans casser writer N-1', () => {
  assert.match(
    commandNamespaceExpand,
    /ADD CONSTRAINT agent_mission_events_envelope_v2_check CHECK \([\s\S]*?\) NOT VALID;/u,
  );
  assert.doesNotMatch(commandNamespaceExpand, /VALIDATE CONSTRAINT/u);
  assert.match(
    commandNamespaceExpand,
    /"eventType" IN \([\s\S]*?AGENT_MISSION_CORRELATION_SCREEN_ACK_EVENT_TYPES[\s\S]*?"actor" = 'system'[\s\S]*?-4\[a-f0-9\]\{3\}[\s\S]*?-8\[a-f0-9\]\{3\}/u,
  );
  assert.match(
    commandNamespaceExpand,
    /AGENT_MISSION_CORRELATION_SYSTEM_EVENT_TYPES[\s\S]*?"actor" = 'system'[\s\S]*?-8\[a-f0-9\]\{3\}/u,
  );
  assert.match(
    commandNamespaceValidate,
    /VALIDATE CONSTRAINT agent_mission_events_envelope_v2_check;/u,
  );
  const dropOld = commandNamespaceCutover.indexOf(
    'DROP CONSTRAINT agent_mission_events_envelope_check',
  );
  const renameNew = commandNamespaceCutover.indexOf(
    'RENAME CONSTRAINT agent_mission_events_envelope_v2_check',
  );
  assert.ok(dropOld >= 0 && renameNew > dropOld);
});

test('le fence d’annulation est expand-only, tenanté et protège le writer N-1', () => {
  assert.match(schema, /model RealtimeAdmissionCancellationFence/u);
  assert.match(
    schema,
    /map: "realtime_admission_cancellation_fences_company_fkey"/u,
  );
  assert.match(
    schema,
    /@@id\(\[companyId, sessionId, subjectHash\],[\s\S]*?map: "realtime_admission_cancellation_fence_pkey"/u,
  );
  assert.match(
    cancellationExpand,
    /CREATE TABLE public\.realtime_admission_cancellation_fences/u,
  );
  assert.match(
    cancellationExpand,
    /realtime_admission_cancellation_fences_company_fkey[\s\S]*?NOT VALID;/u,
  );
  assert.match(
    cancellationExpand,
    /realtime_admission_cancellation_fences_shape_check[\s\S]*?NOT VALID;/u,
  );
  assert.doesNotMatch(cancellationExpand, /VALIDATE CONSTRAINT/u);
  assert.match(
    cancellationValidate,
    /VALIDATE CONSTRAINT realtime_admission_cancellation_fences_company_fkey/u,
  );
  assert.match(
    cancellationValidate,
    /VALIDATE CONSTRAINT realtime_admission_cancellation_fences_shape_check/u,
  );
  const companiesNoForce = cancellationValidate.indexOf(
    'ALTER TABLE public.companies\n  NO FORCE ROW LEVEL SECURITY',
  );
  const fenceNoForce = cancellationValidate.indexOf(
    'ALTER TABLE public.realtime_admission_cancellation_fences\n  NO FORCE ROW LEVEL SECURITY',
    companiesNoForce,
  );
  const validateForeignKey = cancellationValidate.indexOf(
    'VALIDATE CONSTRAINT realtime_admission_cancellation_fences_company_fkey',
  );
  const validateShape = cancellationValidate.indexOf(
    'VALIDATE CONSTRAINT realtime_admission_cancellation_fences_shape_check',
  );
  const fenceForce = cancellationValidate.indexOf(
    'ALTER TABLE public.realtime_admission_cancellation_fences\n  FORCE ROW LEVEL SECURITY',
    validateShape,
  );
  const companiesForce = cancellationValidate.indexOf(
    'ALTER TABLE public.companies\n  FORCE ROW LEVEL SECURITY',
    fenceForce,
  );
  assert.ok(
    companiesNoForce >= 0
      && fenceNoForce > companiesNoForce
      && validateForeignKey > fenceNoForce
      && validateShape > validateForeignKey
      && fenceForce > validateShape
      && companiesForce > fenceForce,
    'La validation non-superuser doit désactiver puis restaurer FORCE RLS atomiquement.',
  );
  assert.match(cancellationExpand, /FORCE ROW LEVEL SECURITY/u);
  assert.match(
    cancellationExpand,
    /CREATE TRIGGER realtime_session_lease_00_admission_cancellation_fence_guard[\s\S]*?BEFORE INSERT/u,
  );
  assert.match(
    cancellationExpand,
    /"expiresAt" = "cancelledAt" \+ INTERVAL '2 hours'/u,
  );
  assert.match(
    cancellationExpand,
    /ON public\.realtime_admission_cancellation_fences \([\s\S]*?"companyId", "expiresAt", "sessionId", "subjectHash"/u,
  );
  assert.match(
    cancellationExpand,
    /REFERENCING NEW TABLE AS new_rows[\s\S]*?sync_realtime_admission_cancellation_schedule_v1/u,
  );
  assert.match(
    cancellationExpand,
    /guard_realtime_admission_cancellation_fence_v1\(\)[\s\S]*?SECURITY INVOKER[\s\S]*?SET row_security = on/u,
  );
  assert.match(
    cancellationExpand,
    /sync_realtime_admission_cancellation_schedule_v1\(\)[\s\S]*?SECURITY INVOKER[\s\S]*?SET statement_timeout = '4s'[\s\S]*?SET lock_timeout = '1s'/u,
  );
  assert.doesNotMatch(cancellationExpand, /principalBindingHash|userId|leaseToken/u);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.match(cancellationExpand, new RegExp(`'${role}'`, 'u'));
  }
  assert.match(rls, /tenant_isolation ON realtime_admission_cancellation_fences/u);
  assert.match(
    agentMissionRlsReplay,
    /realtime_admission_cancellation_fences[\s\S]*?FROM PUBLIC/u,
  );
  assert.match(
    agentMissionRlsReplay,
    /guard_realtime_admission_cancellation_fence_v1\(\)[\s\S]*?sync_realtime_admission_cancellation_schedule_v1\(\)[\s\S]*?exposed_role\.rolname IN \('anon', 'authenticated', 'service_role'\)/u,
  );
});

test('la capability Realtime reste nullable et sa forme est expand puis validate', () => {
  for (const field of [
    'agentMissionProtocolVersion',
    'agentMissionProtocolBoundAt',
    'agentMissionCapabilityHash',
    'agentMissionReleaseFlagVersion',
  ]) {
    assert.match(schema, new RegExp(`${field}\\s+\\w+\\?`, 'u'));
    assert.match(capabilityExpand, new RegExp(`ADD COLUMN "${field}"`, 'u'));
  }
  assert.match(
    capabilityExpand,
    /realtime_session_leases_agent_mission_capability_shape_check[\s\S]*?NOT VALID;/u,
  );
  assert.doesNotMatch(capabilityExpand, /VALIDATE CONSTRAINT/u);
  assert.match(
    capabilityValidate,
    /VALIDATE CONSTRAINT realtime_session_leases_agent_mission_capability_shape_check;/u,
  );
  assert.match(capabilityExpand, /\) IS TRUE\)\s+NOT VALID;/u);
  assert.match(capabilityExpand, /pg_catalog\.isfinite\("agentMissionProtocolBoundAt"\)/u);
  assert.match(
    capabilityExpand,
    /"agentMissionProtocolBoundAt" = "reservedAt"/u,
  );
  assert.match(capabilityExpand, /BEGIN GENERATED AGENT_MISSION_PROTOCOL_VERSIONS/u);
  assert.match(
    capabilityExpand,
    /CREATE FUNCTION public\.guard_realtime_agent_mission_capability_immutable_v1\(\)/u,
  );
  assert.match(
    capabilityExpand,
    /ROW\([\s\S]*?NEW\."agentMissionProtocolVersion"[\s\S]*?\) IS DISTINCT FROM ROW\([\s\S]*?OLD\."agentMissionProtocolVersion"/u,
  );
  assert.match(
    capabilityExpand,
    /CREATE TRIGGER realtime_session_lease_agent_mission_capability_immutable_v1[\s\S]*?BEFORE UPDATE OF[\s\S]*?"agentMissionCapabilityHash"/u,
  );
  assert.match(
    agentMissionRlsReplay,
    /guard_realtime_agent_mission_capability_immutable_v1\(\)[\s\S]*?exposed_role\.rolname IN \('anon', 'authenticated', 'service_role'\)/u,
  );
});

test('le reçu bootstrap V1 reste nullable, one-shot et séparé expand/validate', () => {
  assert.match(
    schema,
    /agentMissionBootstrapAcknowledgedAt\s+DateTime\?\s+@db\.Timestamptz\(6\)/u,
  );
  assert.match(
    bootstrapReceiptExpand,
    /ADD COLUMN "agentMissionBootstrapAcknowledgedAt" TIMESTAMPTZ\(6\);/u,
  );
  assert.match(
    bootstrapReceiptExpand,
    /realtime_leases_agent_mission_bootstrap_receipt_check[\s\S]*?NOT VALID;/u,
  );
  assert.doesNotMatch(bootstrapReceiptExpand, /VALIDATE CONSTRAINT/u);
  assert.match(
    bootstrapReceiptValidate,
    /VALIDATE CONSTRAINT realtime_leases_agent_mission_bootstrap_receipt_check;/u,
  );
  assert.match(
    bootstrapReceiptExpand,
    /"agentMissionBootstrapAcknowledgedAt" >= "agentMissionProtocolBoundAt"/u,
  );
  assert.match(
    bootstrapReceiptExpand,
    /"agentMissionBootstrapAcknowledgedAt" <= "hardExpiresAt"/u,
  );
  assert.match(
    bootstrapReceiptExpand,
    /TG_OP = 'INSERT'[\s\S]*?AGENT_MISSION_BOOTSTRAP_RECEIPT_INSERT_FORBIDDEN/u,
  );
  assert.match(
    bootstrapReceiptExpand,
    /OLD\."agentMissionBootstrapAcknowledgedAt" IS NOT NULL[\s\S]*?NEW\."agentMissionBootstrapAcknowledgedAt" IS NULL[\s\S]*?AGENT_MISSION_BOOTSTRAP_RECEIPT_IMMUTABLE/u,
  );
  assert.match(
    bootstrapReceiptExpand,
    /NEW\."agentMissionBootstrapAcknowledgedAt" := pg_catalog\.clock_timestamp\(\)/u,
  );
  assert.match(
    bootstrapReceiptExpand,
    /CREATE TRIGGER realtime_lease_agent_mission_receipt_insert_v1[\s\S]*?BEFORE INSERT/u,
  );
  assert.match(
    bootstrapReceiptExpand,
    /CREATE TRIGGER realtime_lease_agent_mission_receipt_update_v1[\s\S]*?BEFORE UPDATE OF "agentMissionBootstrapAcknowledgedAt"/u,
  );
  assert.match(
    agentMissionRlsReplay,
    /guard_realtime_agent_mission_bootstrap_receipt_v1\(\)[\s\S]*?exposed_role\.rolname IN \('anon', 'authenticated', 'service_role'\)/u,
  );
});

test('les trois flags AgentMission sont seedés OFF sans override', () => {
  for (const environment of ['development', 'staging', 'production']) {
    assert.match(
      capabilityFlagFence,
      new RegExp(
        `'bob-agent-missions-quote-v1-${environment}'[\\s\\S]*?'bob\\.agent_missions\\.quote\\.v1'[\\s\\S]*?'${environment}'[\\s\\S]*?false[\\s\\S]*?false`,
        'u',
      ),
    );
  }
  assert.doesNotMatch(capabilityFlagFence, /INSERT INTO public\.release_flag_subjects/u);
});

test('la revalidation du flag est bornée, privée et sans SQL dynamique', () => {
  assert.match(
    capabilityFlagFence,
    /CREATE OR REPLACE FUNCTION public\.revalidate_agent_mission_release_flag_v1/u,
  );
  assert.match(capabilityFlagFence, /SECURITY DEFINER/u);
  assert.match(capabilityFlagFence, /SET search_path = pg_catalog/u);
  assert.match(capabilityFlagFence, /FOR SHARE OF flag/u);
  assert.match(
    capabilityFlagFence,
    /REVOKE ALL ON FUNCTION public\.revalidate_agent_mission_release_flag_v1[\s\S]*?FROM PUBLIC/u,
  );
  assert.doesNotMatch(
    capabilityFlagFence.match(
      /CREATE OR REPLACE FUNCTION public\.revalidate_agent_mission_release_flag_v1[\s\S]*?\$\$;/u,
    )?.[0] ?? '',
    /\bEXECUTE\b/u,
  );
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.match(capabilityFlagFence, new RegExp(`'${role}'`, 'u'));
  }
});

test('la suppression cabinet invalide et audite chaque override sous verrou parent', () => {
  assert.match(
    capabilityFlagFence,
    /CREATE OR REPLACE FUNCTION public\.cabinet_delete_release_flag_subjects/u,
  );
  assert.match(capabilityFlagFence, /ORDER BY flag\.id, subject\.id[\s\S]*?FOR UPDATE OF flag, subject/u);
  assert.match(
    capabilityFlagFence,
    /UPDATE public\.release_flags[\s\S]*?SET version = version \+ 1/u,
  );
  assert.match(
    capabilityFlagFence,
    /INSERT INTO public\.release_flag_audit_events[\s\S]*?'remove-subject'/u,
  );
  assert.match(capabilityFlagFence, /'flagVersion', next_flag_version/u);
  assert.match(
    agentMissionRlsReplay,
    /cabinet_delete_release_flag_subjects\(\)[\s\S]*?exposed_role\.rolname IN \('anon', 'authenticated', 'service_role'\)/u,
  );
  assert.match(rls, /\\ir agent-mission-realtime-rls-replay\.sql/u);
});

test('les colonnes capability ajoutées à la lease existante restent fermées à Data API', () => {
  assert.match(
    capabilityExpand,
    /REVOKE ALL PRIVILEGES ON TABLE public\.realtime_session_leases FROM PUBLIC/u,
  );
  assert.match(capabilityExpand, /attribute\.attacl IS NOT NULL/u);
  assert.match(
    capabilityExpand,
    /REVOKE SELECT \(%I\), INSERT \(%I\), UPDATE \(%I\), REFERENCES \(%I\)/u,
  );
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.match(capabilityExpand, new RegExp(`'${role}'`, 'u'));
  }
});

test('les TTL métier restent des durées fixes malgré les changements DST', () => {
  assert.doesNotMatch(
    expand,
    /INTERVAL\s+'[^']*\bdays?\b'/iu,
    'Un intervalle calendaire sur timestamptz dérive aux changements DST.',
  );
  assert.match(expand, /INTERVAL '24 hours'/u);
  assert.match(expand, /INTERVAL '168 hours'/u);
  assert.match(expand, /INTERVAL '2160 hours'/u);
});

test('la FK du writer N-1 est NOT VALID puis validée dans une migration distincte', () => {
  assert.match(
    expand,
    /quote_draft_slots_agent_mission_owner_fkey[\s\S]*?NOT VALID;/u,
  );
  assert.doesNotMatch(expand, /VALIDATE CONSTRAINT/u);
  assert.match(
    validate,
    /VALIDATE CONSTRAINT quote_draft_slots_agent_mission_owner_fkey;/u,
  );
});

test('le marqueur Prisma reste nullable et le trigger protège N-1 sans mission', () => {
  assert.match(schema, /agentMissionId\s+String\?\s+@db\.Uuid/u);
  assert.match(expand, /ADD COLUMN "agentMissionId" UUID;/u);
  assert.match(expand, /TG_OP = 'DELETE'[\s\S]*?OLD\."agentMissionId" IS NOT NULL/u);
  assert.match(
    expand,
    /TG_OP = 'UPDATE' AND OLD\."agentMissionId" IS NOT NULL/u,
  );
  assert.match(expand, /NEW\."agentMissionId" IS NOT NULL/u);
});

test('les tables et fonctions nouvelles sont fermées aux rôles Data API Supabase', () => {
  for (const table of ['agent_missions', 'agent_mission_events']) {
    assert.match(expand, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC`, 'u'));
    assert.match(
      expand,
      new RegExp(`REVOKE ALL PRIVILEGES ON TABLE public\\.${table} FROM %I`, 'u'),
    );
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.match(expand, new RegExp(`'${role}'`, 'u'));
  }
  assert.match(expand, /FORCE ROW LEVEL SECURITY/u);
});

test('le journal est borné, append-only et la mission active est unique par owner/kind', () => {
  assert.match(expand, /octet_length\("payload"::TEXT\) <= 65536/u);
  assert.match(expand, /octet_length\("data"::TEXT\) <= 32768/u);
  assert.match(expand, /BEFORE UPDATE OR DELETE OR TRUNCATE/u);
  assert.match(
    expand,
    /FOREIGN KEY \("missionId", "companyId", "ownerUserId"\)[\s\S]*?ON DELETE RESTRICT/u,
  );
  assert.match(
    expand,
    /retentionExpiresAt ne constitue jamais à elle seule une autorité de suppression/u,
  );
  assert.match(
    expand,
    /CREATE UNIQUE INDEX agent_missions_one_active_owner_kind_key[\s\S]*?WHERE "status" = 'active'/u,
  );
});

test('les JSON mission, binding et event sont des unions fermées sans sous-requête de CHECK', () => {
  assert.match(expand, /agent_missions_payload_closed_shape_check/u);
  assert.match(expand, /agent_missions_binding_shape_check/u);
  assert.match(expand, /agent_mission_events_data_check/u);
  assert.match(
    expand,
    /"payload" - ARRAY\[[\s\S]*?QUOTE_MISSION_PAYLOAD_KEYS[\s\S]*?= '\{\}'::JSONB/u,
  );
  assert.match(
    expand,
    /"data" - ARRAY\[[\s\S]*?AGENT_MISSION_EVENT_REASON_DATA_KEYS[\s\S]*?= '\{\}'::JSONB/u,
  );
  const tableDefinitions =
    expand.match(
      /CREATE TABLE public\.(?:agent_missions|agent_mission_events) \([\s\S]*?^\);$/gmu,
    ) ?? [];
  assert.equal(
    tableDefinitions.length,
    2,
    'Le garde doit analyser exactement les deux définitions de table AgentMission.',
  );
  for (const tableDefinition of tableDefinitions) {
    assert.doesNotMatch(
      tableDefinition,
      /\(\s*SELECT\b/iu,
      'PostgreSQL interdit les sous-requêtes dans une contrainte CHECK.',
    );
    assert.doesNotMatch(
      tableDefinition,
      /\bFROM\s+jsonb_array_elements(?:_text)?\s*\(/iu,
      'Les validations de tableaux JSON doivent rester développées sans sous-requête.',
    );
  }
});

test('chaque révision mission et event est couplée dans la même transaction', () => {
  assert.match(expand, /CREATE TRIGGER agent_mission_events_append_guard_v1/u);
  assert.match(expand, /AGENT_MISSION_EVENT_REVISION_MISMATCH/u);
  assert.match(expand, /AGENT_MISSION_EVENT_PREDECESSOR_MISSING/u);
  assert.match(expand, /CREATE CONSTRAINT TRIGGER agent_missions_event_required_v1/u);
  assert.match(expand, /DEFERRABLE INITIALLY DEFERRED/u);
  assert.match(expand, /AGENT_MISSION_EVENT_REQUIRED/u);
  for (const functionName of [
    'guard_agent_mission_event_append_v1',
    'require_agent_mission_event_v1',
  ]) {
    assert.match(
      expand,
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${functionName}\\(\\) FROM PUBLIC`, 'u'),
    );
    assert.match(
      rls,
      new RegExp(`REVOKE ALL ON FUNCTION ${functionName}\\(\\) FROM PUBLIC`, 'u'),
      `Le replay RLS canonique doit refermer ${functionName} pour PUBLIC.`,
    );
    assert.match(
      rls,
      new RegExp(
        `REVOKE ALL PRIVILEGES ON FUNCTION ${functionName}\\(\\) FROM %I`,
        'u',
      ),
      `Le replay RLS canonique doit refermer ${functionName} pour les rôles Data API.`,
    );
  }
});

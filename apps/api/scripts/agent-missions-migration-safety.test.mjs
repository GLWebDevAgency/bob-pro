import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const customerResolutionExpandPath = path.join(
  apiDir,
  'prisma/migrations/20260729100000_agent_mission_customer_resolution_expand/migration.sql',
);
const customerResolutionValidatePath = path.join(
  apiDir,
  'prisma/migrations/20260729100100_agent_mission_customer_resolution_validate/migration.sql',
);
const customerResolutionCutoverPath = path.join(
  apiDir,
  'prisma/migrations/20260729100200_agent_mission_customer_resolution_cutover/migration.sql',
);
const globalForegroundExpandPath = path.join(
  apiDir,
  'prisma/migrations/20260729110000_agent_mission_global_foreground_expand/migration.sql',
);
const m2aExpandPath = path.join(
  apiDir,
  'prisma/migrations/20260729150000_agent_mission_quote_line_work_expand/migration.sql',
);
const m2aValidatePath = path.join(
  apiDir,
  'prisma/migrations/20260729150100_agent_mission_quote_line_work_validate/migration.sql',
);
const m2aCutoverPath = path.join(
  apiDir,
  'prisma/migrations/20260729150200_agent_mission_quote_line_work_cutover/migration.sql',
);
const m2a1ExpandPath = path.join(
  apiDir,
  'prisma/migrations/20260730100000_agent_mission_catalogue_choice_expand/migration.sql',
);
const m2a1ValidatePath = path.join(
  apiDir,
  'prisma/migrations/20260730100100_agent_mission_catalogue_choice_validate/migration.sql',
);
const m2a1CutoverPath = path.join(
  apiDir,
  'prisma/migrations/20260730100200_agent_mission_catalogue_choice_cutover/migration.sql',
);
const schemaPath = path.join(apiDir, 'prisma/schema.prisma');
const persistencePath = path.join(
  apiDir,
  'src/persistence/prisma/agent-mission.persistence.ts',
);
const rlsPath = path.join(apiDir, 'prisma/rls.sql');
const agentMissionRlsReplayPath = path.join(
  apiDir,
  'prisma/agent-mission-realtime-rls-replay.sql',
);
const generatorPath = path.join(scriptDir, 'generate-agent-mission-migration-values.mjs');
const m2aGeneratorPath = path.join(
  scriptDir,
  'generate-agent-mission-m2a-foundation-values.mjs',
);
const m2a1GeneratorPath = path.join(
  scriptDir,
  'generate-agent-mission-m2a1-values.mjs',
);

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
  customerResolutionExpand,
  customerResolutionValidate,
  customerResolutionCutover,
  globalForegroundExpand,
  m2aExpand,
  m2aValidate,
  m2aCutover,
  m2a1Expand,
  m2a1Validate,
  m2a1Cutover,
  schema,
  persistence,
  rls,
  agentMissionRlsReplay,
  generator,
  m2aGenerator,
  m2a1Generator,
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
  readFile(customerResolutionExpandPath, 'utf8'),
  readFile(customerResolutionValidatePath, 'utf8'),
  readFile(customerResolutionCutoverPath, 'utf8'),
  readFile(globalForegroundExpandPath, 'utf8'),
  readFile(m2aExpandPath, 'utf8'),
  readFile(m2aValidatePath, 'utf8'),
  readFile(m2aCutoverPath, 'utf8'),
  readFile(m2a1ExpandPath, 'utf8'),
  readFile(m2a1ValidatePath, 'utf8'),
  readFile(m2a1CutoverPath, 'utf8'),
  readFile(schemaPath, 'utf8'),
  readFile(persistencePath, 'utf8'),
  readFile(rlsPath, 'utf8'),
  readFile(agentMissionRlsReplayPath, 'utf8'),
  readFile(generatorPath, 'utf8'),
  readFile(m2aGeneratorPath, 'utf8'),
  readFile(m2a1GeneratorPath, 'utf8'),
]);

test('les migrations AgentMission historiques sont immuables octet par octet', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(scriptDir, 'generate-agent-mission-migration-values.mjs'), '--check'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const forbiddenWrite = spawnSync(
    process.execPath,
    [path.join(scriptDir, 'generate-agent-mission-migration-values.mjs'), '--write'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.notEqual(forbiddenWrite.status, 0);
  assert.match(
    `${forbiddenWrite.stdout}\n${forbiddenWrite.stderr}`,
    /AGENT_MISSION_HISTORICAL_MIGRATIONS_READ_ONLY/u,
  );
  assert.match(generator, /FROZEN_HISTORICAL_MIGRATIONS/u);
  assert.doesNotMatch(generator, /\bwriteFile\b/u);

  for (const [name, sql, expectedHash] of [
    [
      '20260726010000',
      expand,
      '51300a662e0a8a0d92bc80ba371f9fb40f3087e42b049e30823f460087f32882',
    ],
    [
      '20260727140000',
      capabilityExpand,
      'eeeabc0eb680662b06acf5325e791e3635b20d000f90cb590217187d68b118be',
    ],
    [
      '20260727180000',
      commandNamespaceExpand,
      '5e4a07e66e047573ccb1766f6a8c844fad8bfe0a128ce9312abac17a9d4f19c5',
    ],
    [
      '20260729100000',
      customerResolutionExpand,
      '0103db8de1c21bf9299b4439ff74b606e50777e6693b54bb2ed0bc70b9a106f9',
    ],
    [
      '20260729100100',
      customerResolutionValidate,
      '885bebd64380ffbf1aa91109e8391e944e6a1ac39ad132b9544b2182921617e7',
    ],
    [
      '20260729100200',
      customerResolutionCutover,
      'dff7d1a7103735a5ae257c381a159569182c5a6b6edbd034ca5f66c16d0c14bb',
    ],
  ]) {
    assert.equal(
      createHash('sha256').update(sql, 'utf8').digest('hex'),
      expectedHash,
      `${name}: une migration historique appliquée a été réécrite`,
    );
  }
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
    ['customer resolution expand', customerResolutionExpand],
    ['customer resolution validate', customerResolutionValidate],
    ['customer resolution cutover', customerResolutionCutover],
    ['global foreground expand', globalForegroundExpand],
    ['M2-A expand', m2aExpand],
    ['M2-A validate', m2aValidate],
    ['M2-A cutover', m2aCutover],
    ['M2-A-1 expand', m2a1Expand],
    ['M2-A-1 validate', m2a1Validate],
    ['M2-A-1 cutover', m2a1Cutover],
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

test('M2-A-0 reste figé et ses unions générées demeurent traçables', () => {
  const result = spawnSync(
    process.execPath,
    [m2aGeneratorPath, '--check'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const forbiddenWrite = spawnSync(
    process.execPath,
    [m2aGeneratorPath, '--write'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.notEqual(forbiddenWrite.status, 0);
  assert.match(
    `${forbiddenWrite.stdout}\n${forbiddenWrite.stderr}`,
    /AGENT_MISSION_M2A_FOUNDATION_READ_ONLY/u,
  );
  assert.match(m2aGenerator, /FROZEN_M2A_FOUNDATION_MIGRATIONS/u);
  assert.doesNotMatch(m2aGenerator, /\bwriteFile\b/u);
  for (const region of [
    'AGENT_MISSION_QUOTE_LINE_WORK_STATES',
    'AGENT_MISSION_QUOTE_LINE_WORK_ORIGINS',
    'AGENT_MISSION_QUOTE_LINE_CATEGORIES',
    'AGENT_MISSION_QUOTE_LINE_VAT_RATES',
    'AGENT_MISSION_QUOTE_LINE_PRICE_BASES',
    'AGENT_MISSION_QUOTE_LINE_REQUIRED_FACTS',
    'CATALOGUE_PRESTATION_CATEGORIES',
    'CATALOGUE_PRESTATION_VAT_RATES',
    'CATALOGUE_SEARCH_EXPANSION_EXPRESSION',
    'CATALOGUE_SEARCH_TRANSLITERATION_SOURCE',
    'CATALOGUE_SEARCH_TRANSLITERATION_TARGET',
  ]) {
    assert.match(m2aExpand, new RegExp(`BEGIN GENERATED ${region}`, 'u'));
    assert.match(m2aExpand, new RegExp(`END GENERATED ${region}`, 'u'));
  }
});

test('M2-A-0 suit expand, validate et cutover sans fermer le writer catalogue N-1', () => {
  for (const constraintName of [
    'catalogue_prestations_category_check_m2a',
    'catalogue_prestations_vat_check_m2a',
  ]) {
    assert.match(
      m2aExpand,
      new RegExp(`ADD CONSTRAINT ${constraintName}[\\s\\S]*?NOT VALID`, 'u'),
    );
    assert.match(
      m2aValidate,
      new RegExp(`VALIDATE CONSTRAINT ${constraintName}`, 'u'),
    );
    assert.match(
      m2aCutover,
      new RegExp(`RENAME CONSTRAINT ${constraintName}`, 'u'),
    );
  }
  assert.equal((m2aExpand.match(/\bNOT VALID\b/gmu) ?? []).length, 2);
  assert.doesNotMatch(m2aExpand, /\bVALIDATE CONSTRAINT\b/u);
  assert.doesNotMatch(m2aExpand, /\bDROP CONSTRAINT\b/u);
  assert.doesNotMatch(m2aExpand, /\bRENAME CONSTRAINT\b/u);

  assert.equal((m2aValidate.match(/\bVALIDATE CONSTRAINT\b/gmu) ?? []).length, 2);
  assert.doesNotMatch(m2aValidate, /\bNOT VALID\b/u);
  assert.doesNotMatch(m2aValidate, /\bDROP CONSTRAINT\b/u);
  assert.doesNotMatch(m2aValidate, /\bRENAME CONSTRAINT\b/u);

  assert.equal((m2aCutover.match(/\bDROP CONSTRAINT\b/gmu) ?? []).length, 2);
  assert.equal((m2aCutover.match(/\bRENAME CONSTRAINT\b/gmu) ?? []).length, 2);
  assert.doesNotMatch(m2aCutover, /\bNOT VALID\b/u);
  assert.doesNotMatch(m2aCutover, /\bVALIDATE CONSTRAINT\b/u);
  for (const historical of ['labor', 'supply', 'travel', '0', '5.5', '10', '20']) {
    assert.match(m2aExpand, new RegExp(`'${historical}'|\\b${historical}\\b`, 'u'));
  }
});

test('M2-A-0 persiste seulement les faits normalisés sous capability, FORCE RLS et parent actif', () => {
  assert.match(schema, /model AgentMissionQuoteLineWork/u);
  assert.match(schema, /quoteLineWork\s+AgentMissionQuoteLineWork\[\]/u);
  assert.match(
    schema,
    /mission\s+AgentMission\s+@relation\("AgentMissionQuoteLineWork"[\s\S]*?onDelete: Cascade/u,
  );
  assert.match(m2aExpand, /CREATE TABLE public\.agent_mission_quote_line_work/u);
  assert.match(
    m2aExpand,
    /FOREIGN KEY \("missionId", "companyId", "ownerUserId"\)[\s\S]*?ON DELETE CASCADE/u,
  );
  assert.match(m2aExpand, /FORCE ROW LEVEL SECURITY/u);
  assert.match(
    m2aExpand,
    /current_setting\('app\.current_agent_mission_id', true\)/u,
  );
  assert.match(
    m2aExpand,
    /OLD\."id" IS DISTINCT FROM NEW\."id"[\s\S]*?NEW\."revision" <> OLD\."revision" \+ 1/u,
  );
  assert.match(
    m2aExpand,
    /mission\."kind" = 'quote_creation'[\s\S]*?mission\."status" = 'active'[\s\S]*?AGENT_MISSION_QUOTE_LINE_ACTIVE_PARENT_REQUIRED/u,
  );
  assert.match(
    m2aExpand,
    /"proposalId" IS NOT NULL[\s\S]*?"proposalRevision" IS NOT NULL[\s\S]*?"proposalDiffHash" IS NOT NULL[\s\S]*?"proposalRevision" = 1/u,
  );
  assert.match(
    m2aExpand,
    /TG_OP = 'DELETE' AND pg_trigger_depth\(\) > 1/u,
  );
  assert.match(
    m2aExpand,
    /REVOKE ALL ON TABLE public\.agent_mission_quote_line_work FROM PUBLIC/u,
  );
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.match(m2aExpand, new RegExp(`'${role}'`, 'u'));
  }
  assert.doesNotMatch(
    m2aExpand.match(
      /CREATE TABLE public\.agent_mission_quote_line_work[\s\S]*?^\);$/mu,
    )?.[0] ?? '',
    /transcript|prompt|model|score|customerName|catalogueLabel/iu,
  );
});

test('M2-A-0 indexe la recherche catalogue réelle avec une normalisation tenant-first', () => {
  assert.match(schema, /searchKey\s+String\s+@ignore/u);
  assert.match(
    m2aExpand,
    /ADD COLUMN "searchKey" TEXT GENERATED ALWAYS AS/u,
  );
  for (const primitive of [
    'pg_catalog.btrim',
    'pg_catalog.regexp_replace',
    'pg_catalog.lower',
    'pg_catalog.translate',
    'pg_catalog.replace',
  ]) {
    assert.match(m2aExpand, new RegExp(primitive.replace('.', '\\.'), 'u'));
  }
  for (const generatedRegion of [
    'CATALOGUE_SEARCH_EXPANSION_EXPRESSION',
    'CATALOGUE_SEARCH_TRANSLITERATION_SOURCE',
    'CATALOGUE_SEARCH_TRANSLITERATION_TARGET',
  ]) {
    assert.match(m2aExpand, new RegExp(`BEGIN GENERATED ${generatedRegion}`, 'u'));
    assert.match(m2aExpand, new RegExp(`END GENERATED ${generatedRegion}`, 'u'));
  }
  assert.match(
    m2aExpand,
    /catalogue_prestations_company_search_prefix_idx[\s\S]*?"companyId",[\s\S]*?"searchKey" pg_catalog\.text_pattern_ops,[\s\S]*?"id"/u,
  );
  assert.match(
    m2aExpand,
    /catalogue_prestations_search_tokens_idx[\s\S]*?USING GIN[\s\S]*?to_tsvector\('simple'/u,
  );
  assert.doesNotMatch(m2aExpand, /CREATE EXTENSION/u);
});

test('M2-A-0 assume les propriétaires exacts sous un déployeur non-superuser', () => {
  for (const [name, sql, relation] of [
    ['expand mission', m2aExpand, 'agent_missions'],
    ['expand catalogue', m2aExpand, 'catalogue_prestations'],
    ['validate catalogue', m2aValidate, 'catalogue_prestations'],
    ['cutover catalogue', m2aCutover, 'catalogue_prestations'],
  ]) {
    assert.match(
      sql,
      new RegExp(
        `relation\\.relname = '${relation}'[\\s\\S]*?pg_has_role\\(session_user, schema_owner_oid, 'SET'\\)[\\s\\S]*?SET LOCAL ROLE %I`,
        'u',
      ),
      `${name}: SET ROLE owner absent`,
    );
    assert.doesNotMatch(
      sql,
      /GRANT\s+\w+\s+TO\s+(?:postgres|current_user|session_user)/iu,
      `${name}: adhésion explicite interdite`,
    );
  }
});

test('M1-C suit expand, validate puis cutover avec huit contraintes fermées', () => {
  const constraintNames = [
    'agent_missions_payload_m1c_check',
    'agent_missions_payload_closed_shape_m1c_check',
    'agent_missions_phase_payload_m1c_check',
    'agent_mission_events_type_m1c_check',
    'agent_mission_events_envelope_m1c_check',
    'agent_mission_events_data_m1c_check',
    'agent_mission_events_correlation_m1c_check',
    'agent_mission_events_draft_effect_m1c_check',
  ];

  assert.equal(
    (customerResolutionExpand.match(/\bNOT VALID\b/gmu) ?? []).length,
    constraintNames.length,
  );
  assert.doesNotMatch(customerResolutionExpand, /\bVALIDATE CONSTRAINT\b/u);
  assert.doesNotMatch(customerResolutionExpand, /\bDROP CONSTRAINT\b/u);
  assert.doesNotMatch(customerResolutionExpand, /\bRENAME CONSTRAINT\b/u);

  assert.equal(
    (customerResolutionValidate.match(/\bVALIDATE CONSTRAINT\b/gmu) ?? []).length,
    constraintNames.length,
  );
  assert.doesNotMatch(customerResolutionValidate, /\bNOT VALID\b/u);
  assert.doesNotMatch(customerResolutionValidate, /\bDROP CONSTRAINT\b/u);
  assert.doesNotMatch(customerResolutionValidate, /\bRENAME CONSTRAINT\b/u);

  assert.equal(
    (customerResolutionCutover.match(/\bDROP CONSTRAINT\b/gmu) ?? []).length,
    constraintNames.length,
  );
  assert.equal(
    (customerResolutionCutover.match(/\bRENAME CONSTRAINT\b/gmu) ?? []).length,
    constraintNames.length,
  );
  assert.doesNotMatch(customerResolutionCutover, /\bNOT VALID\b/u);
  assert.doesNotMatch(customerResolutionCutover, /\bVALIDATE CONSTRAINT\b/u);

  for (const constraintName of constraintNames) {
    assert.match(customerResolutionExpand, new RegExp(`\\b${constraintName}\\b`, 'u'));
    assert.match(customerResolutionValidate, new RegExp(`\\b${constraintName}\\b`, 'u'));
    const canonicalName = constraintName.replace('_m1c_check', '_check');
    const dropIndex = customerResolutionCutover.indexOf(`DROP CONSTRAINT ${canonicalName}`);
    const renameIndex = customerResolutionCutover.indexOf(
      `RENAME CONSTRAINT ${constraintName}`,
    );
    assert.ok(
      dropIndex >= 0 && renameIndex > dropIndex,
      `${constraintName}: le cutover doit supprimer l’ancienne contrainte avant le renommage`,
    );
  }
});

test('M1-C garde N-1 et ferme les formes staged et continuation système', () => {
  assert.match(
    customerResolutionExpand,
    /NOT \("payload" \? 'stagedCustomerResolution'\)[\s\S]*?M1C_QUOTE_MISSION_LEGACY_PAYLOAD_KEYS/u,
  );
  assert.match(
    customerResolutionExpand,
    /"payload" -> 'stagedCustomerResolution' = 'null'::JSONB/u,
  );
  for (const kind of ['none', 'too_many', 'exact', 'choices']) {
    assert.match(customerResolutionExpand, new RegExp(`'${kind}'`, 'u'));
  }
  assert.match(
    customerResolutionExpand,
    /jsonb_array_length\([\s\S]*?stagedCustomerResolution,candidates[\s\S]*?\) BETWEEN 1 AND 5/u,
  );
  assert.match(
    customerResolutionExpand,
    /stagedCustomerResolution,candidates,0,choiceId[\s\S]*?<>[\s\S]*?stagedCustomerResolution,candidates,1,choiceId/u,
  );
  assert.match(
    customerResolutionExpand,
    /stagedCustomerResolution,candidates,0,customerId[\s\S]*?<>[\s\S]*?stagedCustomerResolution,candidates,1,customerId/u,
  );
  assert.match(
    customerResolutionExpand,
    /"phase" NOT IN \('awaiting_customer_choice', 'awaiting_lines'\)/u,
  );

  assert.match(
    customerResolutionExpand,
    /"eventType" = 'customer_resolution_staged'[\s\S]*?"data" ->> 'result' = 'none'[\s\S]*?observedCandidateCount'\)::NUMERIC = 0/u,
  );
  assert.match(
    customerResolutionExpand,
    /"data" ->> 'result' = 'too_many'[\s\S]*?observedCandidateCount'\)::NUMERIC = 6/u,
  );
  assert.match(
    customerResolutionExpand,
    /"data" ->> 'result' = 'exact'[\s\S]*?observedCandidateCount'\)::NUMERIC = 1/u,
  );
  assert.match(
    customerResolutionExpand,
    /"data" ->> 'result' = 'choices'[\s\S]*?observedCandidateCount'\)::NUMERIC BETWEEN 1 AND 5/u,
  );
  assert.match(
    customerResolutionExpand,
    /AGENT_MISSION_SYSTEM_CONTINUATION_EVENT_TYPES[\s\S]*?"actor" = 'system'[\s\S]*?-8\[a-f0-9\]\{3\}/u,
  );
  assert.match(
    customerResolutionExpand,
    /"eventType" <> 'customer_selected'[\s\S]*?"data" ->> 'source' = 'exact_match'/u,
  );
  assert.match(
    customerResolutionExpand,
    /"data" ->> 'source' <> 'screen_selection'[\s\S]*?"actor" = 'user_tap'/u,
  );
  assert.doesNotMatch(customerResolutionExpand, /\bSELECT\b/iu);
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
    /guard_realtime_agent_mission_bootstrap_receipt_v2\(\)[\s\S]*?exposed_role\.rolname IN \('anon', 'authenticated', 'service_role'\)/u,
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

test('K2 ajoute le foreground global sans retirer le backstop N-1 owner/kind', () => {
  assert.match(globalForegroundExpand, /BEGIN;/u);
  assert.match(globalForegroundExpand, /SET LOCAL lock_timeout = '5s';/u);
  assert.match(globalForegroundExpand, /SET LOCAL statement_timeout = '60s';/u);
  assert.match(
    globalForegroundExpand,
    /SELECT relation\.relowner, pg_catalog\.pg_get_userbyid\(relation\.relowner\)[\s\S]*?relation\.relname = 'agent_missions'[\s\S]*?relation\.relkind IN \('r', 'p'\)/u,
  );
  assert.match(
    globalForegroundExpand,
    /current_user::pg_catalog\.regrole <> schema_owner_oid[\s\S]*?NOT pg_catalog\.pg_has_role\(session_user, schema_owner_oid, 'SET'\)[\s\S]*?ERRCODE = '42501'[\s\S]*?AGENT_MISSION_K2_SCHEMA_OWNER_UNAVAILABLE/u,
  );
  assert.match(
    globalForegroundExpand,
    /EXECUTE pg_catalog\.format\('SET LOCAL ROLE %I', schema_owner_name\);[\s\S]*?IF current_user::pg_catalog\.regrole <> schema_owner_oid THEN[\s\S]*?AGENT_MISSION_K2_SCHEMA_OWNER_NOT_ASSUMED/u,
  );
  assert.match(
    globalForegroundExpand,
    /CREATE UNIQUE INDEX agent_missions_one_active_owner_key\s+ON public\.agent_missions \("companyId", "ownerUserId"\)\s+WHERE "status" = 'active';/u,
  );
  assert.doesNotMatch(globalForegroundExpand, /DROP\s+(?:INDEX|CONSTRAINT)/iu);
  assert.doesNotMatch(schema, /@@unique\(\[companyId, ownerUserId\]/u);
  assert.match(
    expand,
    /CREATE UNIQUE INDEX agent_missions_one_active_owner_kind_key[\s\S]*?WHERE "status" = 'active'/u,
  );
});

test('K2 prend toujours le verrou foreground V2 avant le verrou quote V1', () => {
  assert.match(persistence, /'bob\.agent-mission\.owner-foreground\.v2'/u);
  assert.match(persistence, /'bob\.agent-mission\.owner-kind\.v1'/u);
  const runWriter = persistence.match(
    /runQuoteCreationOwner<T>\([\s\S]*?\n  \}\n\}/u,
  )?.[0] ?? '';
  const draftFence = persistence.match(
    /export class PrismaAgentMissionDraftFence[\s\S]*$/u,
  )?.[0] ?? '';
  for (const [name, source] of [
    ['writer mission', runWriter],
    ['fence manuel', draftFence],
  ]) {
    const globalOffset = source.indexOf('acquireMissionForegroundOwnerLock');
    const legacyOffset = source.indexOf('acquireQuoteCreationOwnerLock');
    assert.ok(globalOffset >= 0, `${name}: verrou global absent`);
    assert.ok(legacyOffset > globalOffset, `${name}: ordre V2 → V1 non respecté`);
  }
  assert.doesNotMatch(
    persistence,
    /acquireQuoteCreationOwnerLock\([^)]*\);[\s\S]{0,300}acquireMissionForegroundOwnerLock/u,
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
  for (const { migrationFunctionName, replayFunctionName } of [
    {
      migrationFunctionName: 'guard_agent_mission_event_append_v1',
      replayFunctionName: 'guard_agent_mission_event_append_v2',
    },
    {
      migrationFunctionName: 'require_agent_mission_event_v1',
      replayFunctionName: 'require_agent_mission_event_v1',
    },
  ]) {
    assert.match(
      expand,
      new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${migrationFunctionName}\\(\\) FROM PUBLIC`,
        'u',
      ),
    );
    assert.match(
      rls,
      new RegExp(`REVOKE ALL ON FUNCTION ${replayFunctionName}\\(\\) FROM PUBLIC`, 'u'),
      `Le replay RLS canonique doit refermer ${replayFunctionName} pour PUBLIC.`,
    );
    assert.match(
      rls,
      new RegExp(
        `REVOKE ALL PRIVILEGES ON FUNCTION ${replayFunctionName}\\(\\) FROM %I`,
        'u',
      ),
      `Le replay RLS canonique doit refermer ${replayFunctionName} pour les rôles Data API.`,
    );
  }
});

test('M2-A-1 est généré depuis les unions vivantes sans dérive SQL', () => {
  const result = spawnSync(
    process.execPath,
    [m2a1GeneratorPath, '--check'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(m2a1Generator, /AGENT_MISSION_PROTOCOL_VERSIONS/u);
  assert.match(m2a1Generator, /QUOTE_CREATION_MISSION_PHASES/u);
  assert.match(m2a1Generator, /AGENT_MISSION_M2A1_EVENT_TYPES/u);
  assert.match(m2a1Generator, /AGENT_MISSION_QUOTE_LINE_CATALOGUE_RESOLUTIONS/u);
  assert.match(
    m2a1Expand,
    /BEGIN GENERATED AGENT_MISSION_PROTOCOL_VERSIONS[\s\S]*?\b1,[\s\S]*?\b2[\s\S]*?END GENERATED AGENT_MISSION_PROTOCOL_VERSIONS/u,
  );
  assert.doesNotMatch(
    m2a1Generator,
    /agentMissionProtocolVersion" NOT IN \(1, 2\)/u,
    'La garde de reçu doit être rendue depuis la constante de protocoles.',
  );
});

test('M2-A-1 respecte strictement expand puis validate puis cutover', () => {
  assert.doesNotMatch(m2a1Expand, /VALIDATE CONSTRAINT/u);
  assert.doesNotMatch(m2a1Expand, /\bDROP CONSTRAINT\b/u);
  assert.doesNotMatch(m2a1Validate, /\bADD CONSTRAINT\b|\bDROP CONSTRAINT\b/u);
  assert.match(m2a1Validate, /VALIDATE CONSTRAINT agent_missions_protocol_m2a1_check/u);
  assert.match(
    m2a1Validate,
    /VALIDATE CONSTRAINT realtime_leases_agent_mission_bootstrap_receipt_m2a1_check/u,
  );
  assert.doesNotMatch(m2a1Cutover, /\bADD CONSTRAINT\b|\bVALIDATE CONSTRAINT\b/u);
  assert.match(
    m2a1Cutover,
    /RENAME CONSTRAINT agent_missions_protocol_m2a1_check[\s\S]*?TO agent_missions_protocol_check/u,
  );
  assert.match(
    m2a1Cutover,
    /RENAME CONSTRAINT agent_mission_quote_line_work_catalogue_resolution_m2a1_check[\s\S]*?TO agent_mission_quote_line_work_catalogue_resolution_check/u,
  );
  assert.doesNotMatch(
    `${m2a1Expand}\n${m2a1Validate}\n${m2a1Cutover}`,
    /UPDATE public\.release_flags[\s\S]*?enabled\s*=\s*true/iu,
  );
});

test('M2-A-1 ne dépend d’aucun identifiant PostgreSQL tronqué à 63 octets', () => {
  const sql = `${m2a1Expand}\n${m2a1Validate}\n${m2a1Cutover}`;
  const identifiers = [
    ...sql.matchAll(
      /\b(?:CONSTRAINT|TRIGGER|INDEX)\s+"?([a-z][a-z0-9_]*)"?/gu,
    ),
    ...sql.matchAll(/\bFUNCTION\s+public\.([a-z][a-z0-9_]*)\s*\(/gu),
  ].map((match) => match[1]);
  assert.ok(identifiers.length > 0, 'Aucun identifiant M2-A-1 détecté.');
  for (const identifier of identifiers) {
    assert.ok(
      Buffer.byteLength(identifier, 'utf8') <= 63,
      `Identifiant PostgreSQL tronqué silencieusement: ${identifier}`,
    );
  }
});

test('M2-A-1 garde le flag OFF sous FORCE RLS et refuse les anciennes lignes dormantes', () => {
  assert.match(
    m2a1Expand,
    /ALTER TABLE public\.release_flags NO FORCE ROW LEVEL SECURITY;[\s\S]*?INSERT INTO public\.release_flags[\s\S]*?bob\.agent_missions\.quote\.m2a[\s\S]*?false, false, 1[\s\S]*?ALTER TABLE public\.release_flags ENABLE ROW LEVEL SECURITY;[\s\S]*?ALTER TABLE public\.release_flags FORCE ROW LEVEL SECURITY;/u,
  );
  assert.match(m2a1Expand, /AGENT_MISSION_M2A1_RELEASE_FLAG_COLLISION_OR_ENABLED/u);
  assert.match(m2a1Expand, /AGENT_MISSION_M2A1_PREEXISTING_LINE_WORK_UNSUPPORTED/u);
  assert.match(
    m2a1Expand,
    /ALTER TABLE public\.agent_mission_quote_line_work NO FORCE ROW LEVEL SECURITY;[\s\S]*?IF EXISTS \(SELECT 1 FROM public\.agent_mission_quote_line_work LIMIT 1\)[\s\S]*?ALTER TABLE public\.agent_mission_quote_line_work ENABLE ROW LEVEL SECURITY;[\s\S]*?ALTER TABLE public\.agent_mission_quote_line_work FORCE ROW LEVEL SECURITY;/u,
  );
});

test('M2-A-1 exécute chaque DDL et fence Data API sous le propriétaire exact', () => {
  for (const [table, label] of [
    ['agent_missions', 'missions'],
    ['agent_mission_events', 'events'],
    ['agent_mission_quote_line_work', 'line_work'],
    ['realtime_session_leases', 'realtime_leases'],
    ['catalogue_prestations', 'catalogue'],
  ]) {
    assert.match(
      m2a1Expand,
      new RegExp(
        `relation\\.relname = '${table}'[\\s\\S]*?pg_has_role\\(session_user, owner_oid, 'SET'\\)[\\s\\S]*?SET LOCAL ROLE %I[\\s\\S]*?has_schema_privilege\\([\\s\\S]*?current_user, 'public', 'CREATE'[\\s\\S]*?AGENT_MISSION_M2A1_${label.toUpperCase()}_SCHEMA_CREATE_REQUIRED[\\s\\S]*?bob_m2a1_${label}_data_api_fence[\\s\\S]*?REVOKE ALL PRIVILEGES ON TABLE public\\.${table} FROM %I[\\s\\S]*?REVOKE SELECT \\(%I\\), INSERT \\(%I\\), UPDATE \\(%I\\), REFERENCES \\(%I\\)[\\s\\S]*?RESET ROLE;`,
        'u',
      ),
      `${table}: owner/fence/RESET incomplet`,
    );
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.match(m2a1Expand, new RegExp(`'${role}'`, 'u'));
  }
  assert.doesNotMatch(
    m2a1Expand,
    /RESET ROLE;[\s\S]{0,200}DO \$bob_m2a1_data_api_fence\$/u,
  );
});

test('M2-A-1 ferme le protocole V2, les révisions et la recherche catalogue tenantée', () => {
  assert.match(
    m2a1Expand,
    /OLD\."protocolVersion" IS DISTINCT FROM NEW\."protocolVersion"/u,
  );
  assert.match(m2a1Expand, /AGENT_MISSION_M2A1_EVENT_PROTOCOL_REQUIRED/u);
  assert.match(m2a1Expand, /AGENT_MISSION_QUOTE_LINE_ACTIVE_M2A_PARENT_REQUIRED/u);
  assert.match(
    m2a1Expand,
    /NEW\."revision" <> OLD\."revision" \+ 1[\s\S]*?CATALOGUE_PRESTATION_IDENTITY_OR_REVISION_INVALID/u,
  );
  assert.match(
    m2a1Expand,
    /CREATE TABLE public\.catalogue_prestation_search_tokens[\s\S]*?PRIMARY KEY \("companyId", token, "catalogueItemId"\)[\s\S]*?FOREIGN KEY \("catalogueItemId", "companyId"\)[\s\S]*?ON DELETE CASCADE/u,
  );
  assert.equal(
    (
      m2a1Expand.match(
        /pg_catalog\.char_length\((?:split\.)?token\) BETWEEN 1 AND 1000/gu,
      ) ?? []
    ).length,
    3,
    'Le CHECK, le trigger et le backfill doivent partager la borne normalisée sourcée.',
  );
  assert.match(
    m2a1Expand,
    /CREATE FUNCTION public\.sync_catalogue_prestation_search_tokens_v1\(\)[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog[\s\S]*?SET row_security = on/u,
  );
  assert.match(
    m2a1Expand,
    /CREATE TRIGGER catalogue_prestations_search_tokens_sync_v1[\s\S]*?AFTER INSERT OR UPDATE OF "label"[\s\S]*?INSERT INTO public\.catalogue_prestation_search_tokens[\s\S]*?ALTER TABLE public\.catalogue_prestation_search_tokens[\s\S]*?FORCE ROW LEVEL SECURITY[\s\S]*?CREATE POLICY tenant_isolation/u,
  );
  assert.match(
    m2a1Expand,
    /AGENT_MISSION_M2A1_CATALOGUE_FORCE_RLS_REQUIRED[\s\S]*?ALTER TABLE public\.catalogue_prestations NO FORCE ROW LEVEL SECURITY;[\s\S]*?INSERT INTO public\.catalogue_prestation_search_tokens[\s\S]*?ALTER TABLE public\.catalogue_prestations ENABLE ROW LEVEL SECURITY;[\s\S]*?ALTER TABLE public\.catalogue_prestations FORCE ROW LEVEL SECURITY;/u,
  );
  assert.match(
    m2a1Expand,
    /CREATE INDEX catalogue_search_tokens_company_item_idx[\s\S]*?\("companyId", "catalogueItemId"\)/u,
  );
  assert.doesNotMatch(
    m2a1Expand,
    /catalogue_prestations_search_tenant_tokens_idx/u,
  );
  assert.match(
    m2a1Expand,
    /bob_m2a1_catalogue_search_tokens_data_api_fence[\s\S]*?REVOKE ALL PRIVILEGES ON TABLE public\.catalogue_prestation_search_tokens FROM %I[\s\S]*?REVOKE SELECT \(%I\), INSERT \(%I\), UPDATE \(%I\), REFERENCES \(%I\)[\s\S]*?sync_catalogue_prestation_search_tokens_v1/u,
  );
  assert.match(
    m2a1Expand,
    /agent_mission_quote_line_work_ordinal_m2a1_check CHECK \([\s\S]*?"ordinal" BETWEEN 1 AND 2147483647/u,
  );
});

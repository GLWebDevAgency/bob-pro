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
const schemaPath = path.join(apiDir, 'prisma/schema.prisma');
const rlsPath = path.join(apiDir, 'prisma/rls.sql');

const [expand, validate, schema, rls] = await Promise.all([
  readFile(expandPath, 'utf8'),
  readFile(validatePath, 'utf8'),
  readFile(schemaPath, 'utf8'),
  readFile(rlsPath, 'utf8'),
]);

test('les listes SQL AgentMission sont générées depuis les constantes du core', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(scriptDir, 'generate-agent-mission-migration-values.mjs'), '--check'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('chaque migration borne les verrous et le temps de statement dans sa transaction', () => {
  for (const [name, sql] of [['expand', expand], ['validate', validate]]) {
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

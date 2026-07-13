import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const [schema, migration, rls, release] = await Promise.all([
  readFile(new URL('prisma/schema.prisma', root), 'utf8'),
  readFile(new URL('prisma/migrations/20260713230000_realtime_durable_speech/migration.sql', root), 'utf8'),
  readFile(new URL('prisma/rls.sql', root), 'utf8'),
  readFile(new URL('scripts/release.sh', root), 'utf8'),
]);

function model(name) {
  const match = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`, 'u').exec(schema);
  assert.ok(match, `missing Prisma model ${name}`);
  return match[1];
}

test('durable Bob Live registries contain only opaque, versioned evidence', () => {
  const artifact = model('RealtimeSpeechArtifact');
  const grant = model('RealtimeControlGrant');
  const consumption = model('RealtimeControlConsumption');
  const usage = model('RealtimeVoiceUsageEvent');
  const daily = model('RealtimeVoiceUsageDaily');

  for (const registry of [artifact, grant, consumption, usage, daily]) {
    assert.doesNotMatch(registry, /@updatedAt/u);
  }
  assert.match(artifact, /subjectHash\s+String\s+@db\.Char\(64\)/u);
  assert.match(artifact, /canonicalSpeechHmac\s+String\s+@db\.Char\(64\)/u);
  assert.match(artifact, /auditTranscriptHmac\s+String\?/u);
  assert.match(artifact, /factsHmac\s+String\s+@db\.Char\(64\)/u);
  assert.match(artifact, /evidenceHmac\s+String\?/u);
  assert.match(artifact, /proofKeyVersion\s+Int\?/u);
  assert.doesNotMatch(artifact, /\b(text|transcript|audioBytes)\s+(String|Bytes)\b/iu);
  assert.match(grant, /sealedControl\s+Bytes/u);
  assert.match(grant, /controlPayloadHmac\s+String\s+@db\.Char\(64\)/u);
  assert.doesNotMatch(grant, /Json/u);
  assert.match(consumption, /@@id\(\[companyId, grantId\]/u);
});

test('artifact feed is globally monotone, retry-idempotent and crash-safe', () => {
  const artifact = model('RealtimeSpeechArtifact');
  const lease = model('RealtimeSessionLease');

  assert.match(lease, /nextSpeechSequence\s+Int\s+@default\(1\)/u);
  assert.match(artifact, /sequence\s+Int\s+@default\(0\)/u);
  assert.match(artifact, /segmentIndex\s+Int/u);
  assert.match(artifact, /@@unique\(\[companyId, sessionId, sequence\]/u);
  assert.match(artifact, /@@unique\(\[companyId, sessionId, turnId, segmentIndex\]/u);
  assert.match(artifact, /renderTokenHash\s+String/u);
  assert.match(artifact, /purgeTokenHash\s+String\?/u);
  assert.match(artifact, /purgeLeaseExpiresAt\s+DateTime\?/u);
  assert.match(artifact, /objectPurgedAt\s+DateTime\?/u);
  assert.match(artifact, /@@unique\(\[storageKey\]/u);
  assert.doesNotMatch(artifact, /renderAttemptId/u);

  assert.match(migration, /SET "nextSpeechSequence" = lease\."nextSpeechSequence" \+ 1/u);
  assert.match(migration, /live render lease cannot be stolen/u);
  assert.match(migration, /NEW\."canonicalSpeechHmac", NEW\."factsHmac"/u);
  assert.match(migration, /purge may not rewrite realtime speech evidence/u);
  assert.match(migration, /reaper la redérive des IDs/u);
});

test('acoustic publication and one-shot control are fenced in PostgreSQL', () => {
  assert.match(migration, /CREATE FUNCTION assert_realtime_context_fence/u);
  assert.match(migration, /"contextAppliedRevision" = expected_revision/u);
  assert.match(migration, /"contextAppliedDigest" = expected_digest/u);
  assert.match(migration, /"sidebandOwnerLeaseExpiresAt" > clock_timestamp\(\)/u);
  assert.match(migration, /OLD\."state" = 'rendering' AND NEW\."state" IN \('ready', 'cancelled', 'failed'\)/u);
  assert.match(migration, /OLD\."state" = 'ready' AND NEW\."state" IN \('delivered', 'cancelled'\)/u);
  assert.match(migration, /control grant requires an exactly bound delivered artifact/u);
  assert.match(migration, /realtime control grant already consumed/u);
  assert.doesNotMatch(migration, /\bAS grant\b/u);
  assert.doesNotMatch(migration, /realtime_control_grants AS control_grant[\s\S]{0,600}FOR KEY SHARE/u);
  assert.match(migration, /UNIQUE \("companyId", "acknowledgementId"\)/u);
  assert.match(migration, /"classification" = 'fixed_safe' AND "source" = 'preapproved_static'/u);
  assert.match(migration, /"source" = 'synthesized_audited'/u);
  assert.doesNotMatch(migration, /"classification" = 'dynamic_sensitive' AND "source" = 'preapproved_static'/u);
});

test('usage keeps founder study dimensions and a monotone append-only rollup', () => {
  const usage = model('RealtimeVoiceUsageEvent');
  const daily = model('RealtimeVoiceUsageDaily');

  for (const field of ['subjectHash', 'subjectKeyVersion', 'plan', 'kind', 'source', 'amount']) {
    assert.match(usage, new RegExp(`\\b${field}\\b`, 'u'));
    assert.match(daily, new RegExp(`\\b${field}\\b`, 'u'));
  }
  assert.match(usage, /turnId\s+String\?/u);
  assert.match(daily, /@@id\(\[companyId, usageDate, subjectHash, subjectKeyVersion, plan, kind, source\]/u);
  assert.match(migration, /realtime voice usage events are immutable/u);
  assert.match(migration, /daily voice usage aggregate is not monotone/u);
  assert.match(migration, /ON CONFLICT \(\s*"companyId", "usageDate", "subjectHash", "subjectKeyVersion", "plan", "kind", "source"/u);
});

test('all durable stores are FORCE RLS and runtime ACLs are least-privilege', () => {
  const tables = [
    'realtime_speech_artifacts',
    'realtime_control_grants',
    'realtime_control_consumptions',
    'realtime_voice_usage_events',
    'realtime_voice_usage_daily',
  ];
  for (const table of tables) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`, 'u'));
    assert.match(rls, new RegExp(`'${table}'`, 'u'));
  }
  assert.match(release, /REVOKE DELETE ON TABLE public\.realtime_speech_artifacts/u);
  assert.match(release, /public\.realtime_control_grants,[\s\S]*public\.realtime_control_consumptions,[\s\S]*public\.realtime_voice_usage_events/u);
  assert.match(release, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.realtime_voice_usage_daily/u);
});

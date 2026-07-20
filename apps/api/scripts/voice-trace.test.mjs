import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DETAIL_SQL,
  SESSIONS_SQL,
  parseRows,
  parseVoiceTraceArgs,
  renderSession,
  renderSessions,
  runQuery,
} from './voice-trace.mjs';

const SESSION = 'vtr_1b4e28ba-2fa1-11d2-883f-0016d3cca427';
const FIELD = '\u001f';
const ROW = '\u001e';

function turn(overrides = {}) {
  const fields = {
    sessionId: SESSION,
    turnIndex: '1',
    companyId: 'co_mercier',
    userId: 'usr_fondateur',
    startedAt: '2026-07-20 14:03:11',
    outcome: 'success',
    level: 'info',
    reason: '',
    transcript: 'facture Martin quinze mille euros',
    sttModel: 'voxtral-mini-latest',
    intent: 'invoice.create',
    tool: 'facture_directe',
    toolArgs: '{"customerName": "Martin"}',
    autonomy: 'assiste',
    llmModel: 'claude-opus-4-8',
    reply: 'Je prépare la facture pour Martin.',
    ttsModel: 'voxtral-mini-tts-2603',
    transcriptionMs: '820',
    planificationMs: '1400',
    executionMs: '260',
    syntheseMs: '300',
    correlationId: 'req-1',
    planCorrelationId: 'req-2',
    retentionExpiresAt: '2026-08-19',
    ...overrides,
  };
  return Object.values(fields).join(FIELD) + ROW;
}

test('parseVoiceTraceArgs — sans argument, vise la dernière session', () => {
  assert.equal(parseVoiceTraceArgs([]).last, true);
  assert.equal(parseVoiceTraceArgs([]).sessionId, null);
});

test('parseVoiceTraceArgs — accepte un identifiant de session', () => {
  const parsed = parseVoiceTraceArgs([SESSION]);
  assert.equal(parsed.sessionId, SESSION);
  assert.equal(parsed.last, false);
});

test('parseVoiceTraceArgs — refuse un identifiant mal formé plutôt que de tout balayer', () => {
  assert.throws(() => parseVoiceTraceArgs(['pas-un-id']), /identifiant de session invalide/u);
});

test('parseVoiceTraceArgs — --last et un identifiant s’excluent', () => {
  assert.throws(() => parseVoiceTraceArgs([SESSION, '--last']), /s’excluent/u);
});

test('parseVoiceTraceArgs — bornes et validation des options', () => {
  assert.equal(parseVoiceTraceArgs(['--sessions']).sessions, 20);
  assert.equal(parseVoiceTraceArgs(['--sessions', '5']).sessions, 5);
  assert.throws(() => parseVoiceTraceArgs(['--sessions', '0']), /entre 1 et 200/u);
  assert.throws(() => parseVoiceTraceArgs(['--level', 'bavard']), /info, warn ou error/u);
  assert.throws(() => parseVoiceTraceArgs(['--company', 'a b']), /identifiant de tenant/u);
  assert.throws(() => parseVoiceTraceArgs(['--inconnue']), /option inconnue/u);
});

test('runQuery — exige le rôle privilégié, sinon la RLS rendrait un vide trompeur', () => {
  assert.throws(
    () =>
      runQuery(DETAIL_SQL, {}, { directUrl: 'postgresql://bob_app:x@db.test:5432/postgres' }),
    /rôle privilégié postgres/u,
  );
  assert.throws(() => runQuery(DETAIL_SQL, {}, { directUrl: '' }), /URL PostgreSQL valide/u);
});

test('runQuery — passe les valeurs en variables psql liées, jamais par interpolation SQL', () => {
  const calls = [];
  runQuery(
    SESSIONS_SQL,
    { enforce_company: 'true', company_id: 'co_1', limite: '5' },
    {
      directUrl: 'postgresql://postgres:x@db.test:5432/postgres',
      spawnSync: (command, args, options) => {
        calls.push({ command, args, input: options.input });
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  );
  assert.equal(calls[0].command, 'psql');
  assert.ok(calls[0].args.includes('company_id=co_1'));
  assert.ok(calls[0].args.includes('ON_ERROR_STOP=1'));
  // Le tenant n'apparaît QUE comme variable liée : le corps SQL reste constant.
  assert.ok(!calls[0].input.includes('co_1'));
});

test('runQuery — masque l’URL de connexion dans un diagnostic d’erreur', () => {
  const directUrl = 'postgresql://postgres:secret@db.test:5432/postgres';
  assert.throws(
    () =>
      runQuery(DETAIL_SQL, {}, {
        directUrl,
        spawnSync: () => ({ status: 1, stdout: '', stderr: `échec sur ${directUrl}` }),
      }),
    (error) => !error.message.includes('secret') && /\[masqué\]/u.test(error.message),
  );
});

test('parseRows — survit à un transcript multi-lignes', () => {
  const rows = parseRows(turn({ transcript: 'première ligne\nseconde ligne' }), 24);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][8], 'première ligne\nseconde ligne');
});

test('parseRows — refuse une ligne au mauvais nombre de champs plutôt que de deviner', () => {
  assert.throws(() => parseRows(`a${FIELD}b${ROW}`, 24), /ligne illisible/u);
});

test('renderSession — raconte le fil en français', () => {
  const rendu = renderSession(parseRows(turn(), 24));
  assert.match(rendu, /Session vocale vtr_/u);
  assert.match(rendu, /Il a dit\s+facture Martin quinze mille euros/u);
  assert.match(rendu, /Bob a compris invoice\.create\s+→\s+outil facture_directe/u);
  assert.match(rendu, /Bob a répondu Je prépare la facture pour Martin\./u);
  assert.match(rendu, /transcription 820 ms/u);
  assert.match(rendu, /planification 1\.4 s/u);
  // Le total du tour est la somme des étapes mesurées.
  assert.match(rendu, /2\.8 s/u);
});

test('renderSession — un refus affiche SA RAISON', () => {
  const rendu = renderSession(
    parseRows(
      turn({
        outcome: 'refused',
        level: 'warn',
        reason: "forbidden · cause=L'assistant Bob est inclus à partir de l'offre Solo.",
        reply: '',
      }),
      24,
    ),
  );
  assert.match(rendu, /Pourquoi\s+forbidden/u);
  assert.match(rendu, /offre Solo/u);
});

test('renderSession — un tour entendu sans suite reste lisible', () => {
  const rendu = renderSession(
    parseRows(
      turn({
        outcome: 'heard',
        intent: '',
        tool: '',
        toolArgs: '',
        reply: '',
        planificationMs: '',
        executionMs: '',
        syntheseMs: '',
      }),
      24,
    ),
  );
  assert.match(rendu, /aucune intention résolue/u);
  assert.match(rendu, /planification —/u);
});

test('renderSession — sans résultat, oriente le diagnostic au lieu de rester muet', () => {
  const rendu = renderSession([]);
  assert.match(rendu, /VOICE_TRACE_ENABLED/u);
  assert.match(rendu, /30 jours/u);
});

test('renderSessions — liste les sessions et signale les erreurs', () => {
  const stdout = [SESSION, 'co_1', 'usr_1', '2026-07-20 14:03', '4', '1', '2'].join(FIELD) + ROW;
  const rendu = renderSessions(parseRows(stdout, 7));
  assert.match(rendu, /4 tour\(s\)/u);
  assert.match(rendu, /1 refus/u);
  assert.match(rendu, /2 erreur\(s\)/u);
});

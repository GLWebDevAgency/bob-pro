#!/usr/bin/env node
/**
 * LECTURE D'UNE SESSION VOCALE — outil de diagnostic du bêta-test (demande fondateur 20/07/2026).
 *
 * Reconstitue, en français et dans le terminal, le fil d'une conversation vocale :
 *   ce qui a été dit → ce que Bob a compris → ce qu'il a fait → ce qu'il a répondu → en combien
 *   de temps, et POURQUOI quand il a dit non.
 *
 * EXÉCUTION (env Railway injecté localement) :
 *   railway run --service bob-pro-api --environment production -- \
 *     node apps/api/scripts/voice-trace.mjs --last
 *   railway run --service bob-pro-api --environment production -- \
 *     node apps/api/scripts/voice-trace.mjs <sessionId>
 *
 * Options :
 *   --last              dernière session tracée, tous tenants confondus (défaut sans sessionId)
 *   --sessions [N]      liste les N dernières sessions (défaut 20) au lieu d'en détailler une
 *   --company <id>      restreint au tenant donné
 *   --level <niveau>    ne garde que info | warn | error
 *   --verbatim          affiche transcript et réponse EN ENTIER (par défaut : repliés à 3 lignes)
 *
 * LECTURE SEULE. Le script n'écrit jamais rien : ni trace, ni purge, ni correctif.
 *
 * CONNEXION : `DIRECT_URL` (rôle privilégié `postgres`), comme les autres scripts d'exploitation
 * — c'est le SEUL moyen de lire les traces d'un tenant sans se faire passer pour lui : le rôle
 * applicatif `bob_app` est soumis à la RLS et ne voit que le tenant de sa requête.
 *
 * ⚠️ La sortie contient des données réelles (noms de clients, montants). Elle s'affiche dans un
 * terminal d'exploitation — ne la recopier ni dans un ticket, ni dans une conversation tierce.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SESSION_ID = /^vtr_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPANY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LEVELS = new Set(['info', 'warn', 'error']);
/**
 * Séparateurs de transport. Un transcript peut contenir n'importe quoi — retours à la ligne
 * compris — donc ni la virgule ni le pipe ne conviennent : on réserve les caractères de contrôle
 * ASCII prévus pour ça (unit separator / record separator), qu'aucune dictée ne produira.
 */
const FIELD = '\u001f';
const ROW = '\u001e';
/** Écriture des mêmes séparateurs dans le littéral SQL `E'…'`. */
const SQL_FIELD = '\\x1f';
const SQL_ROW = '\\x1e';

function fail(message) {
  throw new Error(`voice-trace:${message}`);
}

export function parseVoiceTraceArgs(argv) {
  const options = { last: false, sessions: null, company: null, level: null, verbatim: false };
  let sessionId = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--last') {
      options.last = true;
    } else if (arg === '--verbatim') {
      options.verbatim = true;
    } else if (arg === '--sessions') {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        index += 1;
        const limit = Number(next);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          fail('--sessions attend un entier entre 1 et 200');
        }
        options.sessions = limit;
      } else {
        options.sessions = 20;
      }
    } else if (arg === '--company') {
      const value = argv[(index += 1)];
      if (!COMPANY_ID.test(value ?? '')) fail('--company attend un identifiant de tenant valide');
      options.company = value;
    } else if (arg === '--level') {
      const value = argv[(index += 1)];
      if (!LEVELS.has(value ?? '')) fail('--level attend info, warn ou error');
      options.level = value;
    } else if (arg?.startsWith('--')) {
      fail(`option inconnue ${arg}`);
    } else {
      if (sessionId !== null) fail('un seul identifiant de session est accepté');
      if (!SESSION_ID.test(arg ?? '')) fail('identifiant de session invalide (attendu vtr_<uuid>)');
      sessionId = arg;
    }
  }
  if (sessionId !== null && options.last) fail('--last et un identifiant de session s’excluent');
  // Sans cible explicite, la dernière session est ce qu'on veut neuf fois sur dix.
  if (sessionId === null && options.sessions === null) options.last = true;
  return { sessionId, ...options };
}

/**
 * Requête de détail. `:sessionId` vide + `enforce_session=false` = « la dernière session tracée ».
 * Aucune interpolation : toutes les valeurs voyagent en variables psql liées.
 */
export const DETAIL_SQL = `
\\set ON_ERROR_STOP on
WITH cible AS (
  SELECT "sessionId", "companyId"
    FROM public.voice_traces
   WHERE (:'enforce_session' = 'false' OR "sessionId" = :'session_id')
     AND (:'enforce_company' = 'false' OR "companyId" = :'company_id')
     AND (:'enforce_level' = 'false' OR "level" = :'level')
   ORDER BY "startedAt" DESC
   LIMIT 1
)
SELECT concat_ws(E'${SQL_FIELD}',
    t."sessionId", t."turnIndex"::text, t."companyId", coalesce(t."userId", ''),
    to_char(t."startedAt" AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD HH24:MI:SS'),
    t."outcome", t."level", coalesce(t."reason", ''),
    coalesce(t."transcript", ''), coalesce(t."sttModel", ''),
    coalesce(t."intent", ''), coalesce(t."tool", ''),
    coalesce(t."toolArgs"::text, ''), coalesce(t."autonomy", ''), coalesce(t."llmModel", ''),
    coalesce(t."reply", ''), coalesce(t."ttsModel", ''),
    coalesce(t."transcriptionMs"::text, ''), coalesce(t."planificationMs"::text, ''),
    coalesce(t."executionMs"::text, ''), coalesce(t."syntheseMs"::text, ''),
    t."correlationId", coalesce(t."planCorrelationId", ''),
    to_char(t."retentionExpiresAt" AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD')
  ) || E'${SQL_ROW}'
  FROM public.voice_traces t
  JOIN cible ON cible."sessionId" = t."sessionId" AND cible."companyId" = t."companyId"
 WHERE (:'enforce_level' = 'false' OR t."level" = :'level')
 ORDER BY t."turnIndex" ASC;
`;

export const SESSIONS_SQL = `
\\set ON_ERROR_STOP on
SELECT concat_ws(E'${SQL_FIELD}',
    "sessionId", "companyId", coalesce("userId", ''),
    to_char(min("startedAt") AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD HH24:MI'),
    count(*)::text,
    count(*) FILTER (WHERE "level" = 'warn')::text,
    count(*) FILTER (WHERE "level" = 'error')::text
  ) || E'${SQL_ROW}'
  FROM public.voice_traces
 WHERE (:'enforce_company' = 'false' OR "companyId" = :'company_id')
   AND (:'enforce_level' = 'false' OR "level" = :'level')
 GROUP BY "sessionId", "companyId", "userId"
 ORDER BY min("startedAt") DESC
 LIMIT :limite;
`;

function validateDirectUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail('DIRECT_URL doit être une URL PostgreSQL valide');
  }
  const user = decodeURIComponent(parsed.username);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) fail('DIRECT_URL doit être PostgreSQL');
  if (user !== 'postgres' && !user.startsWith('postgres.')) {
    // Le rôle applicatif est soumis à la RLS : il ne verrait aucune trace hors de son tenant,
    // et rendrait un résultat VIDE indistinguable d'une session inexistante.
    fail('DIRECT_URL doit utiliser le rôle privilégié postgres (lecture cross-tenant)');
  }
  return raw;
}

export function runQuery(sql, variables, dependencies = {}) {
  const directUrl = validateDirectUrl(dependencies.directUrl ?? process.env.DIRECT_URL ?? '');
  const spawn = dependencies.spawnSync ?? spawnSync;
  const args = ['--no-psqlrc', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
  for (const [name, value] of Object.entries(variables)) args.push('-v', `${name}=${value}`);
  args.push(directUrl);
  const result = spawn('psql', args, { input: sql, encoding: 'utf8', env: process.env });
  if (result.status !== 0) {
    const diagnostic = String(result.stderr || 'psql a échoué').replaceAll(directUrl, '[masqué]').trim();
    fail(`lecture impossible${diagnostic ? ` : ${diagnostic}` : ''}`);
  }
  return String(result.stdout);
}

/** Découpe la sortie psql. Les séparateurs réservés survivent aux retours à la ligne du contenu. */
export function parseRows(stdout, fieldCount) {
  return stdout
    .split('\u001e')
    .map((row) => row.replace(/^\n+/u, '').trim())
    .filter((row) => row.length > 0)
    .map((row) => {
      const fields = row.split('\u001f');
      if (fields.length !== fieldCount) {
        fail(`ligne illisible (${fields.length} champs, ${fieldCount} attendus)`);
      }
      return fields;
    });
}

/* ------------------------------------------------------------------ rendu français */

const RESET = '\u001b[0m';
const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const paint = (code, text) => (process.stdout.isTTY ? `${code}${text}${RESET}` : text);

const OUTCOME_LABEL = {
  heard: 'entendu, sans suite',
  success: 'abouti',
  refused: 'refusé',
  error: 'en échec',
};

const LEVEL_BADGE = {
  info: paint('\u001b[32m', '  OK  '),
  warn: paint('\u001b[33m', ' REFUS'),
  error: paint('\u001b[31m', ' ERREUR'),
};

function duration(ms) {
  if (ms === '') return '—';
  const value = Number(ms);
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)} s` : `${value} ms`;
}

function block(text, { verbatim }) {
  if (text === '') return paint(DIM, '(rien)');
  const lines = text.split('\n');
  if (verbatim || lines.length <= 3) return text;
  return `${lines.slice(0, 3).join('\n')}\n${paint(DIM, `… (+${lines.length - 3} lignes, --verbatim pour tout voir)`)}`;
}

export function renderSession(rows, options = {}) {
  if (rows.length === 0) {
    return 'Aucune trace vocale ne correspond. Vérifier VOICE_TRACE_ENABLED=true côté API, '
      + 'la fenêtre de rétention (30 jours) et les filtres passés au script.';
  }
  const out = [];
  const [first] = rows;
  out.push('');
  out.push(paint(BOLD, `Session vocale ${first[0]}`));
  out.push(
    paint(DIM, `tenant ${first[2]}  ·  testeur ${first[3] || 'inconnu'}  ·  ${rows.length} tour(s)  ·  purge le ${first[23]}`),
  );
  let total = 0;
  for (const row of rows) {
    const [
      , turnIndex, , , startedAt, outcome, level, reason,
      transcript, sttModel, intent, tool, toolArgs, autonomy, llmModel,
      reply, ttsModel, transcriptionMs, planificationMs, executionMs, syntheseMs,
      correlationId, planCorrelationId,
    ] = row;
    const turnMs =
      Number(transcriptionMs || 0) + Number(planificationMs || 0)
      + Number(executionMs || 0) + Number(syntheseMs || 0);
    total += turnMs;
    out.push('');
    out.push(
      `${LEVEL_BADGE[level] ?? level}  ${paint(BOLD, `Tour ${turnIndex}`)}  ${paint(DIM, startedAt)}  `
        + `${paint(DIM, `— ${OUTCOME_LABEL[outcome] ?? outcome}, ${duration(String(turnMs))}`)}`,
    );
    out.push(`  ${paint(BOLD, 'Il a dit')}      ${block(transcript, options)}`);
    out.push(
      `  ${paint(BOLD, 'Bob a compris')} ${intent || paint(DIM, '(aucune intention résolue)')}`
        + (tool ? `  →  outil ${paint(BOLD, tool)}` : ''),
    );
    if (toolArgs && toolArgs !== 'null') out.push(`  ${paint(BOLD, 'Paramètres')}    ${toolArgs}`);
    if (reason) out.push(`  ${paint(BOLD, 'Pourquoi')}      ${reason}`);
    out.push(`  ${paint(BOLD, 'Bob a répondu')} ${block(reply, options)}`);
    out.push(
      paint(
        DIM,
        `  transcription ${duration(transcriptionMs)} · planification ${duration(planificationMs)}`
          + ` · exécution ${duration(executionMs)} · synthèse ${duration(syntheseMs)}`,
      ),
    );
    out.push(
      paint(
        DIM,
        `  modèles ${[sttModel, llmModel, ttsModel].filter(Boolean).join(' / ') || '—'}`
          + `${autonomy ? ` · autonomie ${autonomy}` : ''}`
          + `  ·  logs : ${[correlationId, planCorrelationId].filter(Boolean).join(', ')}`,
      ),
    );
  }
  out.push('');
  out.push(paint(DIM, `Total mesuré sur la session : ${duration(String(total))}`));
  out.push('');
  return out.join('\n');
}

export function renderSessions(rows) {
  if (rows.length === 0) return 'Aucune session vocale tracée.';
  const out = ['', paint(BOLD, 'Sessions vocales les plus récentes'), ''];
  for (const [sessionId, companyId, userId, startedAt, turns, warns, errors] of rows) {
    const alerts = [
      Number(warns) > 0 ? `${warns} refus` : null,
      Number(errors) > 0 ? paint('\u001b[31m', `${errors} erreur(s)`) : null,
    ].filter(Boolean);
    out.push(
      `${startedAt}  ${sessionId}  ${paint(DIM, `${turns} tour(s) · tenant ${companyId} · testeur ${userId || 'inconnu'}`)}`
        + (alerts.length > 0 ? `  ${alerts.join(' · ')}` : ''),
    );
  }
  out.push('', paint(DIM, 'Détail : node apps/api/scripts/voice-trace.mjs <sessionId>'), '');
  return out.join('\n');
}

function main() {
  const input = parseVoiceTraceArgs(process.argv.slice(2));
  const common = {
    enforce_company: String(input.company !== null),
    company_id: input.company ?? '',
    enforce_level: String(input.level !== null),
    level: input.level ?? '',
  };
  if (input.sessions !== null) {
    const stdout = runQuery(SESSIONS_SQL, { ...common, limite: String(input.sessions) });
    console.log(renderSessions(parseRows(stdout, 7)));
    return;
  }
  const stdout = runQuery(DETAIL_SQL, {
    ...common,
    enforce_session: String(input.sessionId !== null),
    session_id: input.sessionId ?? '',
  });
  console.log(renderSession(parseRows(stdout, 24), { verbatim: input.verbatim }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'voice-trace: erreur inconnue');
    process.exitCode = 1;
  }
}

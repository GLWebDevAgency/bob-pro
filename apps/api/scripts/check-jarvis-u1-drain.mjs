#!/usr/bin/env node
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  boundedPsqlSpawnOptions,
  withPsqlChildEnvironment,
} from './psql-child-environment.mjs';

/**
 * Cette lecture prouve le zéro courant ET une fenêtre sans mutation d'au moins une lease worker.
 * Elle ne prouve pas que le processus N-1 déjà démarré a rechargé ses variables : le train de
 * fermeture du prédécesseur reste une précondition opérateur distincte et bloquante.
 */
export const JARVIS_U1_DRAIN_SQL = String.raw`
BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';
-- Les deux tables sont FORCE RLS. Un rôle sans BYPASSRLS doit ÉCHOUER ici, jamais obtenir un
-- faux zéro filtré. Le deployer autoritaire doit donc pouvoir désactiver row_security.
SET LOCAL row_security = off;
SELECT pg_catalog.to_regclass('public.jarvis_work_items') IS NOT NULL
   AND pg_catalog.to_regclass('public.agent_missions') IS NOT NULL AS jarvis_u1_schema_ready
\gset
\if :jarvis_u1_schema_ready
SELECT pg_catalog.concat_ws(
         '|',
         pg_catalog.count(*) FILTER (
           WHERE run.id IS NULL
              OR (
                item.status IN ('succeeded', 'failed_terminal', 'cancelled')
                AND item."resultDigest" IS NOT NULL
                AND item."signalAppliedAt" IS NOT NULL
                AND ((item."authorizedAt" IS NULL) = (item."authorizationDigest" IS NULL))
                AND (item.status <> 'succeeded' OR item."authorizedAt" IS NOT NULL)
                AND (item.status <> 'cancelled' OR item."authorizedAt" IS NULL)
                AND item."leaseToken" IS NULL
                AND item."leaseExpiresAt" IS NULL
              ) IS NOT TRUE
         ),
         pg_catalog.count(*) FILTER (
           WHERE item."resultDigest" IS NOT NULL
             AND item."signalAppliedAt" IS NULL
         ),
         pg_catalog.count(*) FILTER (
           WHERE run.status = 'cancelling'
             AND item.status = 'cancelled'
             AND item."resultDigest" IS NOT NULL
             AND item."signalAppliedAt" IS NOT NULL
         ),
         pg_catalog.count(*) FILTER (
           WHERE item.status IN ('succeeded', 'failed_terminal', 'cancelled')
             AND (
               ((item."authorizedAt" IS NULL) <> (item."authorizationDigest" IS NULL))
               OR (item.status = 'succeeded' AND item."authorizedAt" IS NULL)
               OR (item.status = 'cancelled' AND item."authorizedAt" IS NOT NULL)
               OR item."resultDigest" IS NULL
               OR item."signalAppliedAt" IS NULL
               OR item."leaseToken" IS NOT NULL
               OR item."leaseExpiresAt" IS NOT NULL
             )
         ),
         (
           SELECT pg_catalog.count(*)
             FROM public.agent_missions AS stranded_run
            WHERE stranded_run.status = 'cancelling'
         ),
         pg_catalog.count(*) FILTER (
           WHERE item."updatedAt" >
             pg_catalog.statement_timestamp() - INTERVAL '5 minutes'
         )
       )
  FROM public.jarvis_work_items AS item
  LEFT JOIN public.agent_missions AS run
    ON run.id = item."runId"
   AND run."companyId" = item."companyId"
   AND run."ownerUserId" = item."ownerUserId";
\else
-- Base CI vierge ou prédécesseur pré-U1 : aucune table signifie qu'aucun effet U1 n'a pu naître.
SELECT '0|0|0|0|0|0';
\endif
COMMIT;
`;

function fail(reason) {
  throw new Error(`jarvis-u1-drain:${reason}`);
}

function parseCount(value, name) {
  if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) fail(`${name}_invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${name}_invalid`);
  return parsed;
}

function directUrlForPsql(raw) {
  try {
    const parsed = new URL(raw);
    const schemas = parsed.searchParams.getAll('schema');
    if (schemas.length > 1 || (schemas.length === 1 && schemas[0] !== 'public')) {
      fail('DIRECT_URL_schema_invalid');
    }
    parsed.searchParams.delete('schema');
    return parsed.toString();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('jarvis-u1-drain:')) throw error;
    fail('DIRECT_URL_invalid');
  }
}

export function parseJarvisU1DrainSnapshot(output) {
  if (typeof output !== 'string') fail('snapshot_invalid');
  const lines = output.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) fail('snapshot_invalid');
  const parts = lines[0].split('|');
  if (parts.length !== 6) fail('snapshot_invalid');
  return Object.freeze({
    unsafeWorkItems: parseCount(parts[0], 'unsafe_work_items'),
    pendingSignals: parseCount(parts[1], 'pending_signals'),
    strandedCancellations: parseCount(parts[2], 'stranded_cancellations'),
    invalidTerminalShapes: parseCount(parts[3], 'invalid_terminal_shapes'),
    strandedRuns: parseCount(parts[4], 'stranded_runs'),
    recentMutations: parseCount(parts[5], 'recent_mutations'),
  });
}

export function assertJarvisU1DrainSnapshot(snapshot) {
  for (const [name, value] of Object.entries(snapshot)) {
    if (value !== 0) fail(`${name}_not_zero`);
  }
}

export function runJarvisU1DrainCheck({
  environment = process.env,
  spawnSync = nodeSpawnSync,
} = {}) {
  for (const name of ['BOB_JARVIS_ADMISSION_ENABLED', 'BOB_JARVIS_DISPATCH_ENABLED']) {
    if (environment[name] !== 'false') fail(`${name}_must_be_false`);
  }
  const childBaseEnvironment = {
    PATH: environment.PATH ?? '/usr/bin:/bin',
    HOME: environment.HOME ?? '/tmp',
    ...(environment.LANG === undefined ? {} : { LANG: environment.LANG }),
  };
  const result = withPsqlChildEnvironment(
    directUrlForPsql(environment.DIRECT_URL),
    childBaseEnvironment,
    (childEnvironment) =>
      spawnSync(
        'psql',
        ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'],
        boundedPsqlSpawnOptions(childEnvironment, {
          encoding: 'utf8',
          input: JARVIS_U1_DRAIN_SQL,
        }),
      ),
  );
  if (result.status !== 0) fail('query_failed');
  const snapshot = parseJarvisU1DrainSnapshot(result.stdout);
  assertJarvisU1DrainSnapshot(snapshot);
  return snapshot;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runJarvisU1DrainCheck();
    process.stdout.write('jarvis-u1-drain-ok\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'jarvis-u1-drain:unknown_error';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

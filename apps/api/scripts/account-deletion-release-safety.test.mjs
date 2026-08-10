import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const [release, migration, provision, certificate, jobsSource, bindingSource, adapterSource] =
  await Promise.all([
    readFile(new URL('scripts/release.sh', root), 'utf8'),
    readFile(
      new URL(
        'prisma/migrations/20260802090000_account_deletion_lifecycle/migration.sql',
        root,
      ),
      'utf8',
    ),
    readFile(new URL('prisma/auth-user-deletion-authority-provision.sql', root), 'utf8'),
    readFile(new URL('prisma/auth-user-deletion-release-cert.sql', root), 'utf8'),
    readFile(new URL('src/persistence/auth-user-deletion-jobs.ts', root), 'utf8'),
    readFile(new URL('src/auth/company-owner-binding.ts', root), 'utf8'),
    readFile(new URL('src/persistence/prisma/auth-user-deletion-jobs.prisma.ts', root), 'utf8'),
  ]);

function quotedValues(source) {
  return [...source.matchAll(/'([^']+)'/gu)].map((match) => match[1]);
}

function sourceArray(source, name) {
  const match = new RegExp(
    `export const ${name} = \\[([\\s\\S]*?)\\] as const;`,
    'u',
  ).exec(source);
  assert.ok(match, `constante TypeScript ${name} absente`);
  return quotedValues(match[1]);
}

function capture(source, expression, label) {
  const match = expression.exec(source);
  assert.ok(match, `${label} absent`);
  return match[1];
}

test('la release O7 précrée le rôle puis migre, provisionne et certifie dans cet ordre', () => {
  const role = release.lastIndexOf('\nensure_auth_user_deletion_authority_role\n');
  const migrate = release.lastIndexOf('pnpm --filter @bob/api exec prisma migrate deploy');
  const grant = release.lastIndexOf('\ngrant_app_role\n');
  const rls = release.lastIndexOf(
    'psql "$DIRECT_URL" -X --single-transaction -v ON_ERROR_STOP=1 -f apps/api/prisma/rls.sql',
  );
  const provisionCall = release.lastIndexOf('\nprovision_auth_user_deletion_authority\n');
  const certificateCall = release.lastIndexOf('\ncertify_auth_user_deletion_release_acl\n');

  assert.ok(role >= 0, 'précréation du rôle O7 absente');
  assert.ok(role < migrate, 'le rôle O7 doit exister avant la migration');
  assert.ok(migrate < grant, 'les grants runtime doivent suivre la migration');
  assert.ok(grant < rls, 'le rejeu RLS doit suivre les grants génériques');
  assert.ok(rls < provisionCall, 'le provisionneur O7 doit suivre le rejeu RLS');
  assert.ok(provisionCall < certificateCall, 'le certificat O7 doit suivre le provisionneur');

  const grantStart = release.indexOf('grant_app_role()');
  const grantEnd = release.indexOf('\nSQL\n}', grantStart);
  assert.ok(grantStart >= 0 && grantEnd > grantStart, 'bloc grant_app_role introuvable');
  assert.match(
    release.slice(grantStart, grantEnd),
    /relation\.relname NOT IN \([\s\S]*?'auth_user_deletion_jobs'[\s\S]*?\)/u,
  );
  assert.match(
    release,
    /RUN_POSTGRES_ACCOUNT_DELETION_LIFECYCLE_CERT=true\s+\\\s+pnpm --filter @bob\/api exec vitest run --testTimeout=30000 src\/persistence\/prisma\/account-deletion-lifecycle\.postgres\.test\.ts/u,
  );
});

test('les contrats générés de statut, erreur et binding restent identiques entre TypeScript et SQL', () => {
  const statuses = sourceArray(jobsSource, 'AUTH_USER_DELETION_JOB_STATUSES');
  const errorCodes = sourceArray(jobsSource, 'AUTH_USER_DELETION_ERROR_CODES');
  const statusCheck = quotedValues(
    capture(
      migration,
      /auth_user_deletion_jobs_status_check\s+CHECK\s*\(status IN \(([^)]+)\)\)/u,
      'CHECK des statuts O7',
    ),
  );
  const errorCheck = quotedValues(
    capture(
      migration,
      /auth_user_deletion_jobs_error_check CHECK \([\s\S]*?"lastErrorCode" IN \(([^)]+)\)/u,
      'CHECK des erreurs O7',
    ),
  );
  const retryFunction = capture(
    migration,
    /CREATE FUNCTION public\.retry_auth_user_deletion_v1\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/u,
    'fonction retry O7',
  );
  const retryErrors = quotedValues(
    capture(retryFunction, /p_error_code NOT IN \(([^)]+)\)/u, 'allowlist retry O7'),
  );
  assert.deepEqual(statusCheck, statuses);
  assert.deepEqual(errorCheck, errorCodes);
  assert.deepEqual(retryErrors, errorCodes);

  const pattern = capture(
    bindingSource,
    /COMPANY_OWNER_SUBJECT_PATTERN_SOURCE = '([^']+)'/u,
    'motif de sujet propriétaire',
  );
  const prefix = capture(
    bindingSource,
    /COMPANY_OWNER_ID_PREFIX = '([^']+)'/u,
    'préfixe de société propriétaire',
  );
  assert.equal(migration.split(`'${pattern}'`).length - 1, 3);
  assert.equal(migration.split(`'${prefix}'`).length - 1, 3);
});

test('les timeouts sont posés côté PostgreSQL et MAINTAIN reste hors allowlist', () => {
  assert.match(
    adapterSource,
    /set_config\('lock_timeout', '1s', true\)[\s\S]*set_config\('statement_timeout', '4s', true\)/u,
  );
  assert.equal(
    (adapterSource.match(/await this\.installDatabaseTimeouts\(tx\);/gu) ?? []).length,
    4,
  );
  assert.match(migration, /REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN/u);
  assert.match(
    migration,
    /MESSAGE = 'CABINET_MEMBER_AUTH_SUBJECT_DELETION_REQUESTED',[\s\S]*?CONSTRAINT = 'cabinet_members_auth_user_deletion_fence'/u,
  );
  assert.match(provision, /DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN/u);
  assert.match(certificate, /DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN/u);
  for (const relation of ['companies', 'cabinet_members', 'notification_jobs']) {
    assert.match(provision, new RegExp(`public\\.${relation}', 'MAINTAIN'`, 'u'));
    assert.match(certificate, new RegExp(`public\\.${relation}', 'MAINTAIN'`, 'u'));
  }
});

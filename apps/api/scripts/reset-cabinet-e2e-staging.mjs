#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

export const RESET_CONFIRMATION = 'RESET-CABINET-E2E-STAGING';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCAL_PART_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

function fail(message) {
  throw new Error(`reset-cabinet-e2e-staging:${message}`);
}

function uuid(value, name) {
  if (!UUID_PATTERN.test(value ?? '')) fail(`${name} must be a lowercase RFC 4122 UUID`);
  return value;
}

function normalizedEmail(value) {
  if (!value || value !== value.trim() || value !== value.toLowerCase() || value.length > 254) {
    fail('collaborator-email must be a normalized ASCII email');
  }
  const at = value.lastIndexOf('@');
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const labels = domain.split('.');
  const validDomain = domain.length <= 253
    && labels.length >= 2
    && labels.every((label) => (
      label.length >= 1
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ));
  if (at <= 0 || local.length > 64 || !LOCAL_PART_PATTERN.test(local) || !validDomain) {
    fail('collaborator-email must be a normalized ASCII email');
  }
  return value;
}

export function parseResetArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith('--') || value === undefined) fail('options must be --name value pairs');
    const name = option.slice(2);
    if (name in values) fail(`duplicate option --${name}`);
    values[name] = value;
  }

  const allowed = new Set([
    'cabinet-id',
    'founder-user-id',
    'collaborator-user-id',
    'admin-user-id',
    'collaborator-email',
    'confirm',
  ]);
  for (const name of Object.keys(values)) if (!allowed.has(name)) fail(`unknown option --${name}`);
  if (values.confirm !== RESET_CONFIRMATION) fail(`--confirm must be exactly ${RESET_CONFIRMATION}`);

  const input = {
    cabinetId: uuid(values['cabinet-id'], 'cabinet-id'),
    founderUserId: uuid(values['founder-user-id'], 'founder-user-id'),
    collaboratorUserId: uuid(values['collaborator-user-id'], 'collaborator-user-id'),
    adminUserId: uuid(values['admin-user-id'], 'admin-user-id'),
    collaboratorEmail: normalizedEmail(values['collaborator-email']),
  };
  if (input.collaboratorUserId === input.founderUserId || input.collaboratorUserId === input.adminUserId) {
    fail('collaborator identity must be distinct from founder and admin');
  }
  return input;
}

export function validateResetEnvironment(input, environment = process.env) {
  if (environment.CABINET_RELEASE_ENV !== 'staging') fail('CABINET_RELEASE_ENV must be staging');
  const rawJobIds = environment.JOB_CABINET_IDS ?? '';
  const jobIds = rawJobIds.split(',').map((value) => value.trim()).filter(Boolean);
  if (jobIds.length === 0) fail('JOB_CABINET_IDS must list the E2E cabinet');
  if (jobIds.length > 100) fail('JOB_CABINET_IDS is limited to 100 pilots');
  for (const jobId of jobIds) uuid(jobId, 'JOB_CABINET_IDS entry');
  if (new Set(jobIds).size !== jobIds.length) fail('JOB_CABINET_IDS must not contain duplicates');
  if (!jobIds.includes(input.cabinetId)) fail('cabinet must be listed in JOB_CABINET_IDS');
}

export const RESET_CABINET_E2E_SQL = `
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SET CONSTRAINTS ALL DEFERRED;

CREATE TEMP TABLE e2e_reset_assertion (
  ok boolean NOT NULL CHECK (ok)
) ON COMMIT DROP;
CREATE TEMP TABLE e2e_reset_invitations (id text PRIMARY KEY) ON COMMIT DROP;
CREATE TEMP TABLE e2e_reset_memberships (id text PRIMARY KEY) ON COMMIT DROP;
CREATE TEMP TABLE e2e_reset_deliveries (id text PRIMARY KEY) ON COMMIT DROP;
CREATE TEMP TABLE e2e_reset_audits (id text PRIMARY KEY) ON COMMIT DROP;
CREATE TEMP TABLE e2e_reset_counts (kind text PRIMARY KEY, affected bigint NOT NULL) ON COMMIT DROP;

INSERT INTO e2e_reset_invitations (id)
SELECT invitation.id
  FROM public.cabinet_invitations invitation
 WHERE invitation."cabinetId" = :'cabinet_id'
   AND invitation."emailNormalized" = :'collaborator_email';

INSERT INTO e2e_reset_memberships (id)
SELECT member.id
  FROM public.cabinet_members member
 WHERE member."userId" = :'collaborator_user_id';

-- L'ordre est celui du runtime : invitation -> advisory invitation -> delivery -> cabinet -> member.
-- Ces CTE matérialisées forcent les verrous sans produire de ligne dans stdout.
WITH reset_lock AS MATERIALIZED (
  SELECT pg_advisory_xact_lock(hashtextextended('cabinet-e2e-reset:' || :'cabinet_id', 2))
)
INSERT INTO e2e_reset_assertion (ok) SELECT true FROM reset_lock;

WITH locked AS MATERIALIZED (
  SELECT invitation.id
    FROM public.cabinet_invitations invitation
   WHERE invitation.id IN (SELECT id FROM e2e_reset_invitations)
   ORDER BY invitation.id
   FOR UPDATE OF invitation
)
INSERT INTO e2e_reset_assertion (ok) SELECT true FROM locked;

WITH invitation_locks AS MATERIALIZED (
  SELECT pg_advisory_xact_lock(hashtextextended(invitation.id, 1))
    FROM e2e_reset_invitations invitation
   ORDER BY invitation.id
)
INSERT INTO e2e_reset_assertion (ok) SELECT true FROM invitation_locks;

WITH locked AS MATERIALIZED (
  SELECT delivery.id
    FROM public.cabinet_invitation_deliveries delivery
   WHERE delivery."invitationId" IN (SELECT id FROM e2e_reset_invitations)
   ORDER BY delivery.id
   FOR UPDATE OF delivery
)
INSERT INTO e2e_reset_assertion (ok) SELECT true FROM locked;

WITH locked AS MATERIALIZED (
  SELECT cabinet.id FROM public.cabinets cabinet
   WHERE cabinet.id = :'cabinet_id'
   FOR UPDATE OF cabinet
)
INSERT INTO e2e_reset_assertion (ok) SELECT true FROM locked;

WITH locked AS MATERIALIZED (
  SELECT member.id
    FROM public.cabinet_members member
   WHERE member."cabinetId" = :'cabinet_id'
      OR member."userId" = :'collaborator_user_id'
   ORDER BY member.id
   FOR UPDATE OF member
)
INSERT INTO e2e_reset_assertion (ok) SELECT true FROM locked;

-- Le cabinet E2E est impossible à confondre avec un pilote métier.
INSERT INTO e2e_reset_assertion (ok)
SELECT count(*) = 1
  FROM public.cabinets cabinet
 WHERE cabinet.id = :'cabinet_id'
   AND cabinet.status = 'active'
   AND cabinet.name LIKE 'E2E STAGING%'
   AND cabinet."createdByUserId" = :'founder_user_id'
   AND cabinet."bootstrapCompletedAt" IS NOT NULL;

-- Le fondateur et l'admin d'invitation restent actifs ; ils ne sont jamais des cibles du DELETE.
INSERT INTO e2e_reset_assertion (ok)
SELECT
  EXISTS (
    SELECT 1 FROM public.cabinet_members founder
     WHERE founder."cabinetId" = :'cabinet_id'
       AND founder."userId" = :'founder_user_id'
       AND founder.role = 'admin'
       AND founder.status = 'active'
  )
  AND EXISTS (
    SELECT 1 FROM public.cabinet_members admin_member
     WHERE admin_member."cabinetId" = :'cabinet_id'
       AND admin_member."userId" = :'admin_user_id'
       AND admin_member.role = 'admin'
       AND admin_member.status = 'active'
  );

-- Une identité de test ne peut avoir au plus qu'une membership, collaborateur de ce cabinet,
-- et sa provenance doit être l'invitation E2E explicitement ciblée.
INSERT INTO e2e_reset_assertion (ok)
SELECT
  count(*) <= 1
  AND COALESCE(bool_and(
    member."cabinetId" = :'cabinet_id'
    AND member.role = 'collaborator'
    AND member."sourceInvitationId" IN (SELECT id FROM e2e_reset_invitations)
  ), true)
  FROM public.cabinet_members member
 WHERE member."userId" = :'collaborator_user_id';

-- Une invitation ciblée est unique, collaborateur, créée par l'admin attendu et n'a pu être
-- acceptée que par l'identité attendue. Toute acceptation de cette identité ailleurs fait échouer.
INSERT INTO e2e_reset_assertion (ok)
SELECT
  (SELECT count(*) FROM e2e_reset_invitations) <= 1
  AND NOT EXISTS (
    SELECT 1
      FROM public.cabinet_invitations invitation
      JOIN public.cabinet_members inviter
        ON inviter.id = invitation."invitedByMemberId"
       AND inviter."cabinetId" = invitation."cabinetId"
     WHERE invitation.id IN (SELECT id FROM e2e_reset_invitations)
       AND (
         invitation.role <> 'collaborator'
         OR invitation."acceptedByUserId" IS NOT NULL
            AND invitation."acceptedByUserId" <> :'collaborator_user_id'
         OR inviter."userId" <> :'admin_user_id'
         OR inviter.role <> 'admin'
         OR inviter.status <> 'active'
       )
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.cabinet_invitations invitation
     WHERE invitation."acceptedByUserId" = :'collaborator_user_id'
       AND (
         invitation."cabinetId" <> :'cabinet_id'
         OR invitation."emailNormalized" <> :'collaborator_email'
         OR invitation.role <> 'collaborator'
         OR invitation.id NOT IN (SELECT id FROM e2e_reset_invitations)
       )
  );

INSERT INTO e2e_reset_deliveries (id)
SELECT delivery.id
  FROM public.cabinet_invitation_deliveries delivery
 WHERE delivery."invitationId" IN (SELECT id FROM e2e_reset_invitations);
INSERT INTO e2e_reset_assertion (ok)
SELECT count(*) <= 1 FROM e2e_reset_deliveries;

INSERT INTO e2e_reset_audits (id)
SELECT audit.id
  FROM public.cabinet_audit_events audit
 WHERE audit."cabinetId" = :'cabinet_id'
   AND (
     (audit."entityType" = 'cabinet_invitation' AND audit."entityId" IN (SELECT id FROM e2e_reset_invitations))
     OR audit.payload ->> 'invitationId' IN (SELECT id FROM e2e_reset_invitations)
     OR audit.payload ->> 'memberId' IN (SELECT id FROM e2e_reset_memberships)
   );
INSERT INTO e2e_reset_assertion (ok)
SELECT count(*) <= 10 FROM e2e_reset_audits;

WITH deleted AS (
  DELETE FROM public.cabinet_audit_events audit
   WHERE audit.id IN (SELECT id FROM e2e_reset_audits)
  RETURNING 1
)
INSERT INTO e2e_reset_counts (kind, affected) SELECT 'audit', count(*) FROM deleted;

WITH deleted AS (
  DELETE FROM public.cabinet_members member
   WHERE member.id IN (SELECT id FROM e2e_reset_memberships)
     AND member."userId" = :'collaborator_user_id'
     AND member."cabinetId" = :'cabinet_id'
     AND member.role = 'collaborator'
  RETURNING 1
)
INSERT INTO e2e_reset_counts (kind, affected) SELECT 'membership', count(*) FROM deleted;

WITH deleted AS (
  DELETE FROM public.cabinet_invitations invitation
   WHERE invitation.id IN (SELECT id FROM e2e_reset_invitations)
     AND invitation."cabinetId" = :'cabinet_id'
     AND invitation."emailNormalized" = :'collaborator_email'
     AND invitation.role = 'collaborator'
  RETURNING 1
)
INSERT INTO e2e_reset_counts (kind, affected) SELECT 'invitation', count(*) FROM deleted;

-- Les deliveries sont supprimées par la FK ON DELETE CASCADE de l'invitation.
INSERT INTO e2e_reset_counts (kind, affected)
SELECT 'delivery', count(*) FROM e2e_reset_deliveries;

SELECT COALESCE(sum(affected), 0)::text FROM e2e_reset_counts;
COMMIT;
`;

function privilegedUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { fail('DIRECT_URL must be a PostgreSQL URL'); }
  const user = decodeURIComponent(parsed.username);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || (user !== 'postgres' && !user.startsWith('postgres.'))) {
    fail('DIRECT_URL must use the privileged postgres role');
  }
  return raw;
}

export function resetCabinetE2EStaging(input, dependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  validateResetEnvironment(input, environment);
  const directUrl = privilegedUrl(dependencies.directUrl ?? environment.DIRECT_URL ?? '');
  const variables = {
    cabinet_id: input.cabinetId,
    founder_user_id: input.founderUserId,
    collaborator_user_id: input.collaboratorUserId,
    admin_user_id: input.adminUserId,
    collaborator_email: input.collaboratorEmail,
  };
  const args = ['--no-psqlrc', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];
  for (const [name, value] of Object.entries(variables)) args.push('-v', `${name}=${value}`);
  args.push(directUrl);
  const result = (dependencies.spawnSync ?? spawnSync)('psql', args, {
    input: RESET_CABINET_E2E_SQL,
    encoding: 'utf8',
    env: process.env,
  });
  const stdout = String(result.stdout ?? '').trim();
  if (result.status !== 0 || !/^\d+$/.test(stdout)) {
    const diagnostic = String(result.stderr || 'psql failed').replaceAll(directUrl, '[redacted]').trim();
    fail(`transaction failed${diagnostic ? `: ${diagnostic}` : ''}`);
  }
  return Number(stdout);
}

function main() {
  const input = parseResetArgs(process.argv.slice(2));
  const affected = resetCabinetE2EStaging(input);
  console.log(affected);
}

if (process.argv[1]?.endsWith('reset-cabinet-e2e-staging.mjs')) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : 'reset-cabinet-e2e-staging:unknown error');
    process.exitCode = 1;
  }
}

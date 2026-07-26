-- Espace Cabinet Slice 0 — certification exécutée avec le rôle applicatif non privilégié.
-- Ce fichier est inclus par rls-cert.sql après les contrôles génériques Company.

CREATE OR REPLACE FUNCTION pg_temp.assert_rejected(statement text, label text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION
    WHEN insufficient_privilege OR check_violation OR unique_violation OR foreign_key_violation THEN
      RETURN;
  END;
  RAISE EXCEPTION 'Cabinet RLS cert failed (%): statement was accepted', label;
END;
$$;

SELECT pg_temp.assert_eq(
  (
    SELECT count(*)
      FROM pg_class
     WHERE relname IN (
       'cabinets', 'cabinet_members', 'cabinet_admin_guards', 'cabinet_invitations', 'cabinet_invitation_deliveries',
       'cabinet_audit_events', 'release_flags', 'release_flag_subjects', 'release_flag_audit_events'
     )
       AND relrowsecurity
       AND relforcerowsecurity
  ),
  9,
  'all cabinet tables have FORCE RLS'
);

BEGIN;
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinets), 0, 'no identity sees no cabinet');
SELECT pg_temp.assert_eq((SELECT count(*) FROM release_flags), 0, 'no identity sees no release flag');
COMMIT;

-- Bootstrap atomique du tenant A : cabinet incomplet -> fondateur admin -> finalisation.
BEGIN;
SET LOCAL app.current_user_id = 'rls-user-admin-a';
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
INSERT INTO cabinets (
  id, name, "timeZone", status, "createdByUserId", "bootstrapCompletedAt", version, "createdAt", "updatedAt"
) VALUES (
  'rls-cab-a', 'Cabinet RLS A', 'Europe/Paris', 'active', 'rls-user-admin-a', NULL, 1,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
INSERT INTO cabinet_members (
  id, "cabinetId", "userId", "sourceInvitationId", role, status, "joinedAt", version, "createdAt", "updatedAt"
) VALUES (
  'rls-member-admin-a', 'rls-cab-a', 'rls-user-admin-a', NULL, 'admin', 'active',
  CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
UPDATE cabinets SET "bootstrapCompletedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-cab-a' AND version = 1;
INSERT INTO cabinet_audit_events (
  id, "cabinetId", "actorUserId", action, "entityType", "entityId", payload
) VALUES (
  'rls-audit-created-a', 'rls-cab-a', 'rls-user-admin-a', 'CabinetCreated', 'cabinet', 'rls-cab-a',
  '{"type":"CabinetCreated"}'::jsonb
);
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinets WHERE id = 'rls-cab-a'), 1, 'founder sees bootstrapped cabinet A');
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinet_members WHERE "cabinetId" = 'rls-cab-a'), 1, 'founder membership A');
COMMIT;

-- Tenant B indépendant, utilisé pour les attaques cross-tenant et dernier admin.
BEGIN;
SET LOCAL app.current_user_id = 'rls-user-admin-b';
SET LOCAL app.current_cabinet_id = 'rls-cab-b';
INSERT INTO cabinets (
  id, name, "timeZone", status, "createdByUserId", "bootstrapCompletedAt", version, "createdAt", "updatedAt"
) VALUES (
  'rls-cab-b', 'Cabinet RLS B', 'Europe/Paris', 'active', 'rls-user-admin-b', NULL, 1,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
INSERT INTO cabinet_members (
  id, "cabinetId", "userId", "sourceInvitationId", role, status, "joinedAt", version, "createdAt", "updatedAt"
) VALUES (
  'rls-member-admin-b', 'rls-cab-b', 'rls-user-admin-b', NULL, 'admin', 'active',
  CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
UPDATE cabinets SET "bootstrapCompletedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-cab-b' AND version = 1;
COMMIT;

BEGIN;
SET LOCAL app.current_user_id = 'rls-user-admin-a';
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinets), 1, 'tenant A sees one cabinet');
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinets WHERE id = 'rls-cab-b'), 0, 'tenant A cannot read cabinet B');
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinet_members WHERE "cabinetId" = 'rls-cab-b'), 0, 'tenant A cannot read members B');
WITH cross_update AS (
  UPDATE cabinets SET version = version + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE id = 'rls-cab-b' RETURNING 1
)
SELECT pg_temp.assert_eq((SELECT count(*) FROM cross_update), 0, 'tenant A cannot update cabinet B');
SELECT pg_temp.assert_rejected(
  'INSERT INTO cabinet_invitations (id, "cabinetId", "emailNormalized", role, status, "tokenHash", "expiresAt", "invitedByMemberId", version, "createdAt", "updatedAt")
   VALUES (''rls-inv-cross'', ''rls-cab-b'', ''cross@rls.test'', ''collaborator'', ''pending'', repeat(''8'',64), ''2030-01-01'', ''rls-member-admin-a'', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
  'tenant A cannot create invitation in cabinet B'
);
SELECT pg_temp.assert_rejected(
  'INSERT INTO cabinet_members (id, "cabinetId", "userId", role, status, "joinedAt", version, "createdAt", "updatedAt")
   VALUES (''rls-member-forged'', ''rls-cab-a'', ''rls-user-forged'', ''collaborator'', ''active'', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
  'direct membership without an accepted invitation'
);
COMMIT;

-- Invitations et outbox créées par l'admin. Le second job sert à certifier lease/fencing/purge.
BEGIN;
SET LOCAL app.current_user_id = 'rls-user-admin-a';
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
INSERT INTO cabinet_invitations (
  id, "cabinetId", "emailNormalized", role, status, "tokenHash", "expiresAt", "invitedByMemberId",
  version, "createdAt", "updatedAt"
) VALUES
  (
    'rls-inv-manager-1', 'rls-cab-a', 'manager@rls.test', 'manager', 'pending', repeat('a', 64),
    '2030-01-01T00:00:00Z', 'rls-member-admin-a', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    'rls-inv-collab-1', 'rls-cab-a', 'collab@rls.test', 'collaborator', 'pending', repeat('b', 64),
    '2030-01-01T00:00:00Z', 'rls-member-admin-a', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );
INSERT INTO cabinet_invitation_deliveries (
  id, "cabinetId", "invitationId", "dedupeKey", "tokenCiphertext", "tokenIv", "tokenAuthTag",
  "tokenKeyVersion", status, attempts, "nextAttemptAt", "createdAt", "updatedAt"
) VALUES
  (
    'rls-delivery-manager-1', 'rls-cab-a', 'rls-inv-manager-1', 'cert:manager:1',
    'cipher-manager', 'iv-manager', 'tag-manager', 1, 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  ),
  (
    'rls-delivery-fence', 'rls-cab-a', 'rls-inv-collab-1', 'cert:fence:1',
    'cipher-collab', 'iv-collab', 'tag-collab', 1, 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  );
COMMIT;

-- Mauvais email/hash : aucune résolution de capacité.
BEGIN;
SET LOCAL app.current_user_id = 'rls-user-manager';
SET LOCAL app.current_user_email = 'wrong@rls.test';
SELECT set_config('app.current_invitation_token_hash', repeat('a', 64), true);
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinet_invitations WHERE id = 'rls-inv-manager-1'), 0, 'wrong email hides invitation');
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinets WHERE id = 'rls-cab-a'), 0, 'wrong email hides cabinet');
COMMIT;

BEGIN;
SET LOCAL app.current_user_id = 'rls-user-manager';
SET LOCAL app.current_user_email = 'manager@rls.test';
SELECT set_config('app.current_invitation_token_hash', repeat('f', 64), true);
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinet_invitations WHERE id = 'rls-inv-manager-1'), 0, 'wrong hash hides invitation');
COMMIT;

-- Un token pending peut afficher sa destination, mais ne peut ni rejoindre, ni bump le cabinet,
-- ni écrire un audit. La consommation commence uniquement après pending -> accepted.
BEGIN;
SET LOCAL app.current_user_id = 'rls-user-manager';
SET LOCAL app.current_user_email = 'manager@rls.test';
SELECT set_config('app.current_invitation_token_hash', repeat('a', 64), true);
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinet_invitations WHERE id = 'rls-inv-manager-1'), 1, 'exact pending capability reads invitation');
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinets WHERE id = 'rls-cab-a'), 1, 'exact pending capability reads destination cabinet');
SELECT pg_temp.assert_rejected(
  'INSERT INTO cabinet_members (id, "cabinetId", "userId", "sourceInvitationId", role, status, "joinedAt", version, "createdAt", "updatedAt")
   VALUES (''rls-member-manager-early'', ''rls-cab-a'', ''rls-user-manager'', ''rls-inv-manager-1'', ''manager'', ''active'', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
  'pending token cannot join'
);
WITH changed AS (
  UPDATE cabinets SET version = version + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE id = 'rls-cab-a' RETURNING 1
)
SELECT pg_temp.assert_eq((SELECT count(*) FROM changed), 0, 'pending token cannot finalize cabinet');
SELECT pg_temp.assert_rejected(
  'INSERT INTO cabinet_audit_events (id, "cabinetId", "actorUserId", action, "entityType", "entityId", payload)
   VALUES (''rls-audit-forged-token'', ''rls-cab-a'', ''rls-user-manager'', ''CabinetInvitationAccepted'', ''cabinet_invitation'', ''rls-inv-manager-1'', ''{}''::jsonb)',
  'pending token cannot forge audit'
);
COMMIT;

-- Token déjà expiré : même avec hash+email exacts, aucune capacité ne s'ouvre. L'admin peut
-- ensuite matérialiser expired ; expired et revoked annulent/purgent leur outbox par trigger.
BEGIN;
SET LOCAL app.current_user_id = 'rls-user-admin-a';
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
INSERT INTO cabinet_invitations (
  id, "cabinetId", "emailNormalized", role, status, "tokenHash", "expiresAt", "invitedByMemberId",
  version, "createdAt", "updatedAt"
) VALUES (
  'rls-inv-expired', 'rls-cab-a', 'expired@rls.test', 'collaborator', 'pending', repeat('e',64),
  '2021-01-02T00:00:00Z', 'rls-member-admin-a', 1, '2021-01-01T00:00:00Z', CURRENT_TIMESTAMP
), (
  'rls-inv-revoked', 'rls-cab-a', 'revoked@rls.test', 'collaborator', 'pending', repeat('7',64),
  '2030-01-01T00:00:00Z', 'rls-member-admin-a', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
INSERT INTO cabinet_invitation_deliveries (
  id, "cabinetId", "invitationId", "dedupeKey", "tokenCiphertext", "tokenIv", "tokenAuthTag",
  "tokenKeyVersion", status, attempts, "nextAttemptAt", "createdAt", "updatedAt"
) VALUES
  ('rls-delivery-expired', 'rls-cab-a', 'rls-inv-expired', 'cert:expired:1', 'cipher-expired', 'iv-expired', 'tag-expired', 1, 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('rls-delivery-revoked', 'rls-cab-a', 'rls-inv-revoked', 'cert:revoked:1', 'cipher-revoked', 'iv-revoked', 'tag-revoked', 1, 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
COMMIT;

BEGIN;
SET LOCAL app.current_user_id = 'rls-user-expired';
SET LOCAL app.current_user_email = 'expired@rls.test';
SELECT set_config('app.current_invitation_token_hash', repeat('e', 64), true);
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinet_invitations), 0, 'expired token cannot read invitation');
WITH accepted AS (
  UPDATE cabinet_invitations
     SET status = 'accepted', "acceptedByUserId" = 'rls-user-expired', "acceptedAt" = CURRENT_TIMESTAMP,
         version = 2, "updatedAt" = CURRENT_TIMESTAMP
   WHERE id = 'rls-inv-expired' RETURNING 1
)
SELECT pg_temp.assert_eq((SELECT count(*) FROM accepted), 0, 'expired token cannot accept invitation');
SELECT pg_temp.assert_rejected(
  'INSERT INTO cabinet_members (id, "cabinetId", "userId", "sourceInvitationId", role, status, "joinedAt", version, "createdAt", "updatedAt")
   VALUES (''rls-member-expired'', ''rls-cab-a'', ''rls-user-expired'', ''rls-inv-expired'', ''collaborator'', ''active'', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
  'expired token cannot join'
);
COMMIT;

BEGIN;
SET LOCAL app.current_user_id = 'rls-user-admin-a';
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
UPDATE cabinet_invitations
   SET status = 'expired', version = 2, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-inv-expired' AND status = 'pending';
UPDATE cabinet_invitations
   SET status = 'revoked', "revokedAt" = CURRENT_TIMESTAMP, "revokedByMemberId" = 'rls-member-admin-a',
       version = 2, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-inv-revoked' AND status = 'pending';
COMMIT;

-- Transition outbox autorisée, tentative fenced obsolète sans effet, puis purge du secret à done.
BEGIN;
SET LOCAL app.current_user_id = 'rls-user-admin-a';
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
UPDATE cabinet_invitation_deliveries
   SET status = 'sending', attempts = 1, "lockedAt" = CURRENT_TIMESTAMP,
       "leaseUntil" = CURRENT_TIMESTAMP + interval '1 minute', "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-delivery-fence';
WITH stale AS (
  UPDATE cabinet_invitation_deliveries
     SET status = 'done', "sentAt" = CURRENT_TIMESTAMP, "lockedAt" = NULL, "leaseUntil" = NULL,
         "tokenCiphertext" = NULL, "tokenIv" = NULL, "tokenAuthTag" = NULL, "updatedAt" = CURRENT_TIMESTAMP
   WHERE id = 'rls-delivery-fence' AND status = 'sending' AND attempts = 0
   RETURNING 1
)
SELECT pg_temp.assert_eq((SELECT count(*) FROM stale), 0, 'stale fencing token cannot acknowledge delivery');
UPDATE cabinet_invitation_deliveries
   SET status = 'failed', "lockedAt" = NULL, "leaseUntil" = NULL,
       "nextAttemptAt" = CURRENT_TIMESTAMP, "lastError" = 'cert-provider-error', "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-delivery-fence' AND status = 'sending' AND attempts = 1;
UPDATE cabinet_invitation_deliveries
   SET status = 'sending', attempts = 2, "lockedAt" = CURRENT_TIMESTAMP,
       "leaseUntil" = CURRENT_TIMESTAMP + interval '1 minute', "lastError" = NULL, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-delivery-fence' AND status = 'failed' AND attempts = 1;
UPDATE cabinet_invitation_deliveries
   SET status = 'done', "sentAt" = CURRENT_TIMESTAMP, "lockedAt" = NULL, "leaseUntil" = NULL,
       "tokenCiphertext" = NULL, "tokenIv" = NULL, "tokenAuthTag" = NULL, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-delivery-fence' AND status = 'sending' AND attempts = 2;
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM cabinet_invitation_deliveries
    WHERE id = 'rls-delivery-fence' AND status = 'done'
      AND "tokenCiphertext" IS NULL AND "tokenIv" IS NULL AND "tokenAuthTag" IS NULL),
  1,
  'done delivery purges encrypted secret'
);
COMMIT;

-- Acceptation manager : I -> membership source unique -> version Cabinet. Les audits sont générés
-- en SECURITY DEFINER par les deux triggers, jamais insérés par la capacité token.
BEGIN;
SET LOCAL app.current_user_id = 'rls-user-manager';
SET LOCAL app.current_user_email = 'manager@rls.test';
SELECT set_config('app.current_invitation_token_hash', repeat('a', 64), true);
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
UPDATE cabinet_invitations
   SET status = 'accepted', "acceptedByUserId" = 'rls-user-manager', "acceptedAt" = CURRENT_TIMESTAMP,
       version = 2, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-inv-manager-1' AND status = 'pending' AND version = 1;
UPDATE cabinets SET version = 2, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-cab-a' AND version = 1;
INSERT INTO cabinet_members (
  id, "cabinetId", "userId", "sourceInvitationId", role, status, "joinedAt", version, "createdAt", "updatedAt"
) VALUES (
  'rls-member-manager-1', 'rls-cab-a', 'rls-user-manager', 'rls-inv-manager-1', 'manager', 'active',
  CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM cabinet_audit_events
    WHERE action IN ('CabinetInvitationAccepted', 'CabinetMemberJoined')
      AND "actorUserId" = 'rls-user-manager'),
  2,
  'canonical acceptance audit pair'
);
COMMIT;

-- Acceptation collaborateur, pour certifier les restrictions manager/collaborateur.
BEGIN;
SET LOCAL app.current_user_id = 'rls-user-collab';
SET LOCAL app.current_user_email = 'collab@rls.test';
SELECT set_config('app.current_invitation_token_hash', repeat('b', 64), true);
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
UPDATE cabinet_invitations
   SET status = 'accepted', "acceptedByUserId" = 'rls-user-collab', "acceptedAt" = CURRENT_TIMESTAMP,
       version = 2, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-inv-collab-1' AND status = 'pending' AND version = 1;
UPDATE cabinets SET version = 3, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-cab-a' AND version = 2;
INSERT INTO cabinet_members (
  id, "cabinetId", "userId", "sourceInvitationId", role, status, "joinedAt", version, "createdAt", "updatedAt"
) VALUES (
  'rls-member-collab-1', 'rls-cab-a', 'rls-user-collab', 'rls-inv-collab-1', 'collaborator', 'active',
  CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinet_invitations), 0, 'collaborator cannot list invitation emails');
WITH forged_bump AS (
  UPDATE cabinets SET version = version + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE id = 'rls-cab-a' RETURNING 1
)
SELECT pg_temp.assert_eq((SELECT count(*) FROM forged_bump), 0, 'consumed token cannot bump cabinet as collaborator');
SELECT pg_temp.assert_rejected(
  'INSERT INTO cabinet_members (id, "cabinetId", "userId", "sourceInvitationId", role, status, "joinedAt", version, "createdAt", "updatedAt")
   VALUES (''rls-member-collab-replay'', ''rls-cab-a'', ''rls-user-collab'', ''rls-inv-collab-1'', ''collaborator'', ''active'', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
  'consumed token cannot add a second active membership'
);
SELECT pg_temp.assert_rejected(
  'INSERT INTO cabinet_audit_events (id, "cabinetId", "actorUserId", action, "entityType", "entityId", payload)
   VALUES (''rls-audit-forged-collab'', ''rls-cab-a'', ''rls-user-collab'', ''Forged'', ''cabinet'', ''rls-cab-a'', ''{}''::jsonb)',
  'collaborator cannot forge audit'
);
COMMIT;

BEGIN;
SET LOCAL app.current_user_id = 'rls-user-manager';
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinet_invitations), 4, 'manager can list cabinet invitations');
SELECT pg_temp.assert_rejected(
  'UPDATE cabinets SET name = ''Cabinet compromis'', version = 4, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ''rls-cab-a''',
  'manager cannot rename cabinet'
);
SELECT pg_temp.assert_rejected(
  'UPDATE cabinets SET "timeZone" = ''UTC'', version = 4, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ''rls-cab-a''',
  'manager cannot change cabinet timezone'
);
SELECT pg_temp.assert_rejected(
  'UPDATE cabinets SET status = ''suspended'', version = 4, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ''rls-cab-a''',
  'manager cannot suspend cabinet'
);
SELECT pg_temp.assert_rejected(
  'UPDATE cabinet_members SET role = ''admin'', version = 2, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ''rls-member-collab-1''',
  'manager cannot promote collaborator'
);
WITH managed_admin AS (
  UPDATE cabinet_members SET status = 'suspended', "suspendedAt" = CURRENT_TIMESTAMP,
         version = 2, "updatedAt" = CURRENT_TIMESTAMP
   WHERE id = 'rls-member-admin-a' RETURNING 1
)
SELECT pg_temp.assert_eq((SELECT count(*) FROM managed_admin), 0, 'manager cannot manage an admin');
WITH managed_manager AS (
  UPDATE cabinet_members SET status = 'suspended', "suspendedAt" = CURRENT_TIMESTAMP,
         version = 2, "updatedAt" = CURRENT_TIMESTAMP
   WHERE id = 'rls-member-manager-1' RETURNING 1
)
SELECT pg_temp.assert_eq((SELECT count(*) FROM managed_manager), 0, 'manager cannot manage a manager');
SELECT pg_temp.assert_rejected(
  'INSERT INTO cabinet_invitations (id, "cabinetId", "emailNormalized", role, status, "tokenHash", "expiresAt", "invitedByMemberId", version, "createdAt", "updatedAt")
   VALUES (''rls-inv-manager-forged'', ''rls-cab-a'', ''admin2@rls.test'', ''admin'', ''pending'', repeat(''e'',64), ''2030-01-01'', ''rls-member-manager-1'', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
  'manager cannot invite an admin'
);
SELECT pg_temp.assert_rejected(
  'INSERT INTO cabinet_invitations (id, "cabinetId", "emailNormalized", role, status, "tokenHash", "expiresAt", "invitedByMemberId", version, "createdAt", "updatedAt")
   VALUES (''rls-inv-manager-forged-2'', ''rls-cab-a'', ''manager2@rls.test'', ''manager'', ''pending'', repeat(''9'',64), ''2030-01-01'', ''rls-member-manager-1'', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
  'manager cannot invite another manager'
);
UPDATE cabinet_members
   SET status = 'suspended', "suspendedAt" = CURRENT_TIMESTAMP, version = 2, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-member-collab-1' AND role = 'collaborator';
UPDATE cabinet_members
   SET status = 'active', "suspendedAt" = NULL, version = 3, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-member-collab-1' AND role = 'collaborator';
COMMIT;

-- Immuabilité, append-only et dernier admin au niveau DB.
BEGIN;
SET LOCAL app.current_user_id = 'rls-user-admin-a';
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
SELECT pg_temp.assert_rejected(
  'UPDATE cabinet_members SET "sourceInvitationId" = ''rls-inv-manager-1'', version = 4, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ''rls-member-collab-1''',
  'membership source is immutable'
);
SELECT pg_temp.assert_rejected(
  'UPDATE cabinet_invitations SET status = ''revoked'', "revokedAt" = CURRENT_TIMESTAMP, "revokedByMemberId" = ''rls-member-admin-a'', "tokenHash" = repeat(''c'',64), version = 2, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ''rls-inv-manager-1''',
  'invitation identity is immutable'
);
SELECT pg_temp.assert_rejected(
  'UPDATE cabinets SET "createdByUserId" = ''forged'', version = 4, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ''rls-cab-a''',
  'cabinet identity is immutable'
);
WITH changed AS (
  UPDATE cabinet_audit_events SET payload = '{"forged":true}'::jsonb WHERE id = 'rls-audit-created-a' RETURNING 1
)
SELECT pg_temp.assert_eq((SELECT count(*) FROM changed), 0, 'audit events cannot be updated');
WITH deleted AS (
  DELETE FROM cabinet_audit_events WHERE id = 'rls-audit-created-a' RETURNING 1
)
SELECT pg_temp.assert_eq((SELECT count(*) FROM deleted), 0, 'audit events cannot be deleted');
SELECT pg_temp.assert_rejected(
  'UPDATE cabinet_members SET status = ''revoked'', "revokedAt" = CURRENT_TIMESTAMP, version = 2, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ''rls-member-admin-a''',
  'last active admin cannot be revoked'
);
COMMIT;

BEGIN;
SET LOCAL app.current_user_id = 'rls-user-admin-b';
SET LOCAL app.current_cabinet_id = 'rls-cab-b';
SELECT pg_temp.assert_rejected(
  'UPDATE cabinet_members SET status = ''revoked'', "revokedAt" = CURRENT_TIMESTAMP, version = 2, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ''rls-member-admin-b''',
  'last admin invariant on independent tenant'
);
COMMIT;

-- Révocation manager puis replay du token consommé : aucune lecture/capacité ne survit.
BEGIN;
SET LOCAL app.current_user_id = 'rls-user-admin-a';
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
UPDATE cabinets SET version = 4, "updatedAt" = CURRENT_TIMESTAMP WHERE id = 'rls-cab-a' AND version = 3;
UPDATE cabinet_members
   SET status = 'revoked', "revokedAt" = CURRENT_TIMESTAMP, version = 2, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-member-manager-1' AND version = 1;
COMMIT;

BEGIN;
SET LOCAL app.current_user_id = 'rls-user-manager';
SET LOCAL app.current_user_email = 'manager@rls.test';
SELECT set_config('app.current_invitation_token_hash', repeat('a', 64), true);
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinets), 0, 'revoked member cannot read cabinet with consumed token');
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinet_invitations), 0, 'consumed token cannot read invitation after revoke');
WITH replay_bump AS (
  UPDATE cabinets SET version = version + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE id = 'rls-cab-a' RETURNING 1
)
SELECT pg_temp.assert_eq((SELECT count(*) FROM replay_bump), 0, 'consumed token cannot bump cabinet after revoke');
SELECT pg_temp.assert_rejected(
  'INSERT INTO cabinet_audit_events (id, "cabinetId", "actorUserId", action, "entityType", "entityId", payload)
   VALUES (''rls-audit-forged-replay'', ''rls-cab-a'', ''rls-user-manager'', ''CabinetMemberJoined'', ''cabinet'', ''rls-cab-a'', ''{}''::jsonb)',
  'consumed token cannot forge audit after revoke'
);
SELECT pg_temp.assert_rejected(
  'INSERT INTO cabinet_members (id, "cabinetId", "userId", "sourceInvitationId", role, status, "joinedAt", version, "createdAt", "updatedAt")
   VALUES (''rls-member-manager-replay'', ''rls-cab-a'', ''rls-user-manager'', ''rls-inv-manager-1'', ''manager'', ''active'', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
  'consumed invitation cannot create a second membership'
);
COMMIT;

-- Une nouvelle invitation peut réadmettre le même user : l'ancienne membership révoquée reste
-- historisée et la nouvelle possède une source différente.
BEGIN;
SET LOCAL app.current_user_id = 'rls-user-admin-a';
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
INSERT INTO cabinet_invitations (
  id, "cabinetId", "emailNormalized", role, status, "tokenHash", "expiresAt", "invitedByMemberId",
  version, "createdAt", "updatedAt"
) VALUES (
  'rls-inv-manager-2', 'rls-cab-a', 'manager@rls.test', 'collaborator', 'pending', repeat('c',64),
  '2030-01-01T00:00:00Z', 'rls-member-admin-a', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
COMMIT;

BEGIN;
SET LOCAL app.current_user_id = 'rls-user-manager';
SET LOCAL app.current_user_email = 'manager@rls.test';
SELECT set_config('app.current_invitation_token_hash', repeat('c', 64), true);
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
UPDATE cabinet_invitations
   SET status = 'accepted', "acceptedByUserId" = 'rls-user-manager', "acceptedAt" = CURRENT_TIMESTAMP,
       version = 2, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-inv-manager-2' AND status = 'pending' AND version = 1;
UPDATE cabinets SET version = 5, "updatedAt" = CURRENT_TIMESTAMP WHERE id = 'rls-cab-a' AND version = 4;
INSERT INTO cabinet_members (
  id, "cabinetId", "userId", "sourceInvitationId", role, status, "joinedAt", version, "createdAt", "updatedAt"
) VALUES (
  'rls-member-manager-2', 'rls-cab-a', 'rls-user-manager', 'rls-inv-manager-2', 'collaborator', 'active',
  CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM cabinet_members WHERE "userId" = 'rls-user-manager' AND status = 'active'),
  1,
  'new invitation permits one new active membership'
);
COMMIT;

-- Flags : lecture strictement identitaire/tenant, aucune écriture runtime, audit ops invisible.
BEGIN;
SET LOCAL app.current_user_id = 'rls-user-pilot';
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM release_flags WHERE key = 'cabinet.slice0' AND environment = 'development'),
  1,
  'authenticated identity reads development flag definition'
);
SELECT pg_temp.assert_eq((SELECT count(*) FROM release_flag_subjects), 1, 'user sees only own flag override');
SELECT pg_temp.assert_rejected(
  'SELECT count(*) FROM release_flag_audit_events',
  'ops flag audit has no runtime table privilege'
);
SELECT pg_temp.assert_rejected(
  'INSERT INTO release_flag_audit_events (id, "flagId", actor, reason, operation, "beforeState", "afterState")
   VALUES (''rls-flag-audit-forged'', ''cabinet-slice0-development'', ''runtime'', ''forged reason'', ''set-global'', ''{}''::jsonb, ''{}''::jsonb)',
  'runtime cannot forge release flag audit'
);
WITH changed_flag AS (
  UPDATE release_flags
     SET enabled = true, version = version + 1, "updatedAt" = CURRENT_TIMESTAMP,
         "updatedByUserId" = 'rls-user-pilot'
   WHERE key = 'cabinet.slice0' AND environment = 'development'
   RETURNING 1
)
SELECT pg_temp.assert_eq((SELECT count(*) FROM changed_flag), 0, 'runtime cannot enable global release flag');
COMMIT;

BEGIN;
SET LOCAL app.current_user_id = 'rls-user-admin-a';
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
SELECT pg_temp.assert_eq((SELECT count(*) FROM release_flag_subjects), 1, 'cabinet A sees only cabinet A override');
SELECT pg_temp.assert_eq((SELECT count(*) FROM release_flag_subjects WHERE "subjectId" = 'rls-cab-b'), 0, 'cabinet A cannot read cabinet B override');
SELECT pg_temp.assert_rejected(
  'INSERT INTO release_flag_subjects (id, "flagId", "subjectType", "subjectId", enabled, version, "createdAt", "updatedAt")
   VALUES (''rls-flag-forged'', ''cabinet-slice0-development'', ''cabinet'', ''rls-cab-a'', true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
  'runtime cannot create release flag override'
);
COMMIT;

-- Suspension fail-closed : ni membership, ni token, ni worker/outbox ne peuvent agir.
BEGIN;
SET LOCAL app.current_user_id = 'rls-user-admin-a';
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
INSERT INTO cabinet_invitations (
  id, "cabinetId", "emailNormalized", role, status, "tokenHash", "expiresAt", "invitedByMemberId",
  version, "createdAt", "updatedAt"
) VALUES (
  'rls-inv-suspended', 'rls-cab-a', 'suspended@rls.test', 'collaborator', 'pending', repeat('d',64),
  '2030-01-01T00:00:00Z', 'rls-member-admin-a', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
INSERT INTO cabinet_invitation_deliveries (
  id, "cabinetId", "invitationId", "dedupeKey", "tokenCiphertext", "tokenIv", "tokenAuthTag",
  "tokenKeyVersion", status, attempts, "nextAttemptAt", "createdAt", "updatedAt"
) VALUES (
  'rls-delivery-suspended', 'rls-cab-a', 'rls-inv-suspended', 'cert:suspended:1',
  'cipher-suspended', 'iv-suspended', 'tag-suspended', 1, 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
);
UPDATE cabinets SET status = 'suspended', version = 6, "updatedAt" = CURRENT_TIMESTAMP
 WHERE id = 'rls-cab-a' AND version = 5;
COMMIT;

BEGIN;
SET LOCAL app.current_user_id = 'rls-user-admin-a';
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinets), 0, 'suspended cabinet is unreadable to former active admin');
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinet_invitation_deliveries), 0, 'suspended cabinet worker cannot claim delivery');
COMMIT;

BEGIN;
SET LOCAL app.current_user_id = 'rls-user-suspended-target';
SET LOCAL app.current_user_email = 'suspended@rls.test';
SELECT set_config('app.current_invitation_token_hash', repeat('d', 64), true);
SET LOCAL app.current_cabinet_id = 'rls-cab-a';
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinet_invitations), 0, 'token cannot read invitation of suspended cabinet');
WITH accepted AS (
  UPDATE cabinet_invitations
     SET status = 'accepted', "acceptedByUserId" = 'rls-user-suspended-target', "acceptedAt" = CURRENT_TIMESTAMP,
         version = 2, "updatedAt" = CURRENT_TIMESTAMP
   WHERE id = 'rls-inv-suspended' RETURNING 1
)
SELECT pg_temp.assert_eq((SELECT count(*) FROM accepted), 0, 'token cannot accept while cabinet suspended');
SELECT pg_temp.assert_rejected(
  'INSERT INTO cabinet_members (id, "cabinetId", "userId", "sourceInvitationId", role, status, "joinedAt", version, "createdAt", "updatedAt")
   VALUES (''rls-member-suspended-target'', ''rls-cab-a'', ''rls-user-suspended-target'', ''rls-inv-suspended'', ''collaborator'', ''active'', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
  'token cannot join suspended cabinet'
);
COMMIT;

\echo 'Cabinet RLS certification passed'

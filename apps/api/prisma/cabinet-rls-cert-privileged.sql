\set ON_ERROR_STOP on

-- Assertions d'intégrité qui doivent voir les lignes cachées au rôle runtime. Cette étape ne
-- remplace pas le cert RLS : elle prouve purge des secrets, FKs croisées et suppression RGPD.
CREATE OR REPLACE FUNCTION pg_temp.assert_eq(actual bigint, expected bigint, label text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF actual <> expected THEN
    RAISE EXCEPTION 'Privileged cabinet cert failed (%): expected %, got %', label, expected, actual;
  END IF;
END;
$$;

SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM cabinet_invitation_deliveries
    WHERE id IN ('rls-delivery-manager-1', 'rls-delivery-expired', 'rls-delivery-revoked', 'rls-delivery-suspended')
      AND status = 'cancelled'
      AND "tokenCiphertext" IS NULL AND "tokenIv" IS NULL AND "tokenAuthTag" IS NULL),
  4,
  'accept/expire/revoke/suspend atomically cancel and purge delivery secrets'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM cabinet_invitation_deliveries
    WHERE id = 'rls-delivery-fence' AND status = 'done'
      AND "tokenCiphertext" IS NULL AND "tokenIv" IS NULL AND "tokenAuthTag" IS NULL),
  1,
  'done delivery secret is purged'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM cabinet_audit_events
    WHERE id IN (
      'canonical:invitation-accepted:rls-inv-manager-1',
      'canonical:invitation-applied:rls-inv-manager-1',
      'canonical:member-joined:rls-member-manager-1',
      'canonical:invitation-accepted:rls-inv-collab-1',
      'canonical:invitation-applied:rls-inv-collab-1',
      'canonical:member-joined:rls-member-collab-1',
      'canonical:invitation-accepted:rls-inv-manager-2',
      'canonical:invitation-applied:rls-inv-manager-2',
      'canonical:member-joined:rls-member-manager-2'
    )),
  9,
  'canonical accept/apply/join audit triplets are unique and durable'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM cabinet_members
    WHERE "sourceInvitationId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM cabinet_invitations invitation
         WHERE invitation.id = cabinet_members."sourceInvitationId"
           AND invitation."cabinetId" = cabinet_members."cabinetId"
      )),
  0,
  'all membership sources belong to the same cabinet'
);
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM cabinet_admin_guards guard
    WHERE guard."cabinetId" IN ('rls-cab-a', 'rls-cab-b')
      AND guard."activeCount" = (
      SELECT count(*) FROM cabinet_members member
       WHERE member."cabinetId" = guard."cabinetId"
         AND member.role = 'admin' AND member.status = 'active'
    )),
  2,
  'serialized admin guards match active admin rows'
);

CREATE OR REPLACE FUNCTION pg_temp.assert_cross_cabinet_source_rejected()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    INSERT INTO cabinet_members (
      id, "cabinetId", "userId", "sourceInvitationId", role, status, "joinedAt", version, "createdAt", "updatedAt"
    ) VALUES (
      'rls-member-cross-source', 'rls-cab-b', 'rls-user-cross-source', 'rls-inv-revoked', 'collaborator', 'active',
      CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
    SET CONSTRAINTS "cabinet_members_sourceInvitationId_fkey" IMMEDIATE;
  EXCEPTION WHEN foreign_key_violation THEN
    RETURN;
  END;
  RAISE EXCEPTION 'Privileged cabinet cert failed: cross-cabinet invitation source was accepted';
END;
$$;
SELECT pg_temp.assert_cross_cabinet_source_rejected();

CREATE OR REPLACE FUNCTION pg_temp.assert_cross_cabinet_delivery_rejected()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    INSERT INTO cabinet_invitation_deliveries (
      id, "cabinetId", "invitationId", "dedupeKey", "tokenCiphertext", "tokenIv", "tokenAuthTag",
      "tokenKeyVersion", status, attempts, "nextAttemptAt", "createdAt", "updatedAt"
    ) VALUES (
      'rls-delivery-cross-cabinet', 'rls-cab-b', 'rls-inv-manager-1', 'cert:cross-cabinet',
      'cipher-cross', 'iv-cross', 'tag-cross', 1, 'pending', 0,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );
  EXCEPTION WHEN foreign_key_violation THEN
    RETURN;
  END;
  RAISE EXCEPTION 'Privileged cabinet cert failed: cross-cabinet invitation delivery was accepted';
END;
$$;
SELECT pg_temp.assert_cross_cabinet_delivery_rejected();

-- Suppression d'un tenant riche : invitations émises/révoquées, source acceptée, delivery et audit.
-- Les trois FKs croisées NO ACTION sont différées, puis les CASCADE Cabinet effacent l'ensemble.
BEGIN;
SET CONSTRAINTS ALL DEFERRED;
DELETE FROM cabinets WHERE id IN ('rls-cab-a', 'rls-cab-b');
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinets WHERE id IN ('rls-cab-a', 'rls-cab-b')), 0, 'cabinet delete');
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinet_members WHERE "cabinetId" IN ('rls-cab-a', 'rls-cab-b')), 0, 'cabinet delete memberships');
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinet_admin_guards WHERE "cabinetId" IN ('rls-cab-a', 'rls-cab-b')), 0, 'cabinet delete admin guards');
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinet_invitations WHERE "cabinetId" IN ('rls-cab-a', 'rls-cab-b')), 0, 'cabinet delete invitations');
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinet_invitation_deliveries WHERE "cabinetId" IN ('rls-cab-a', 'rls-cab-b')), 0, 'cabinet delete deliveries');
SELECT pg_temp.assert_eq((SELECT count(*) FROM cabinet_audit_events WHERE "cabinetId" IN ('rls-cab-a', 'rls-cab-b')), 0, 'cabinet delete audit');
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM release_flag_subjects
    WHERE "subjectType" = 'cabinet' AND "subjectId" IN ('rls-cab-a', 'rls-cab-b')),
  0,
  'cabinet delete polymorphic release overrides'
);
COMMIT;

\echo 'Privileged Cabinet integrity certification passed'

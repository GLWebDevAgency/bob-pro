-- Espace Cabinet V3 — Slice 0, fondations additives.
-- Cabinet est un tenant distinct de Company. Aucune table artisan n'est modifiée.

CREATE TYPE "CabinetStatus" AS ENUM ('active', 'suspended');
CREATE TYPE "CabinetRole" AS ENUM ('admin', 'manager', 'collaborator');
CREATE TYPE "CabinetMemberStatus" AS ENUM ('active', 'suspended', 'revoked');
CREATE TYPE "CabinetInvitationStatus" AS ENUM ('pending', 'accepted', 'expired', 'revoked');
CREATE TYPE "CabinetInvitationDeliveryStatus" AS ENUM ('pending', 'sending', 'done', 'failed', 'cancelled');
CREATE TYPE "ReleaseEnvironment" AS ENUM ('development', 'staging', 'production');
CREATE TYPE "ReleaseFlagSubjectType" AS ENUM ('user', 'cabinet');

CREATE TABLE "cabinets" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "timeZone" TEXT NOT NULL DEFAULT 'Europe/Paris',
  "status" "CabinetStatus" NOT NULL DEFAULT 'active',
  "createdByUserId" TEXT NOT NULL,
  "bootstrapCompletedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cabinets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cabinets_name_check" CHECK (char_length(btrim("name")) BETWEEN 2 AND 120),
  CONSTRAINT "cabinets_timezone_check" CHECK (char_length("timeZone") BETWEEN 1 AND 64),
  CONSTRAINT "cabinets_version_check" CHECK ("version" >= 1)
);

CREATE TABLE "cabinet_members" (
  "id" TEXT NOT NULL,
  "cabinetId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sourceInvitationId" TEXT,
  "role" "CabinetRole" NOT NULL,
  "status" "CabinetMemberStatus" NOT NULL DEFAULT 'active',
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "suspendedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cabinet_members_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cabinet_members_version_check" CHECK ("version" >= 1),
  CONSTRAINT "cabinet_members_status_dates_check" CHECK (
    ("status" = 'active' AND "suspendedAt" IS NULL AND "revokedAt" IS NULL)
    OR ("status" = 'suspended' AND "suspendedAt" IS NOT NULL AND "revokedAt" IS NULL)
    OR ("status" = 'revoked' AND "revokedAt" IS NOT NULL)
  )
);

CREATE TABLE "cabinet_admin_guards" (
  "cabinetId" TEXT NOT NULL,
  "activeCount" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cabinet_admin_guards_pkey" PRIMARY KEY ("cabinetId"),
  CONSTRAINT "cabinet_admin_guards_active_count_check" CHECK ("activeCount" >= 1)
);

CREATE TABLE "cabinet_invitations" (
  "id" TEXT NOT NULL,
  "cabinetId" TEXT NOT NULL,
  "emailNormalized" TEXT NOT NULL,
  "role" "CabinetRole" NOT NULL,
  "status" "CabinetInvitationStatus" NOT NULL DEFAULT 'pending',
  "tokenHash" CHAR(64) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "invitedByMemberId" TEXT NOT NULL,
  "acceptedByUserId" TEXT,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "revokedByMemberId" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cabinet_invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cabinet_invitations_email_normalized_check" CHECK (
    "emailNormalized" = lower(btrim("emailNormalized"))
    AND char_length("emailNormalized") BETWEEN 3 AND 254
  ),
  CONSTRAINT "cabinet_invitations_token_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "cabinet_invitations_expiry_check" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "cabinet_invitations_version_check" CHECK ("version" >= 1),
  CONSTRAINT "cabinet_invitations_status_check" CHECK (
    ("status" = 'pending' AND "acceptedByUserId" IS NULL AND "acceptedAt" IS NULL AND "revokedAt" IS NULL AND "revokedByMemberId" IS NULL)
    OR ("status" = 'accepted' AND "acceptedByUserId" IS NOT NULL AND "acceptedAt" IS NOT NULL AND "revokedAt" IS NULL AND "revokedByMemberId" IS NULL)
    OR ("status" = 'expired' AND "acceptedByUserId" IS NULL AND "acceptedAt" IS NULL AND "revokedAt" IS NULL AND "revokedByMemberId" IS NULL)
    OR ("status" = 'revoked' AND "acceptedByUserId" IS NULL AND "acceptedAt" IS NULL AND "revokedAt" IS NOT NULL AND "revokedByMemberId" IS NOT NULL)
  )
);

CREATE TABLE "cabinet_audit_events" (
  "id" TEXT NOT NULL,
  "cabinetId" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "correlationId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cabinet_audit_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cabinet_audit_events_action_check" CHECK (char_length("action") BETWEEN 1 AND 120),
  CONSTRAINT "cabinet_audit_events_entity_check" CHECK (
    char_length("entityType") BETWEEN 1 AND 80 AND char_length("entityId") BETWEEN 1 AND 160
  ),
  CONSTRAINT "cabinet_audit_events_payload_check" CHECK (jsonb_typeof("payload") = 'object')
);

CREATE TABLE "cabinet_invitation_deliveries" (
  "id" TEXT NOT NULL,
  "cabinetId" TEXT NOT NULL,
  "invitationId" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "tokenCiphertext" TEXT,
  "tokenIv" TEXT,
  "tokenAuthTag" TEXT,
  "tokenKeyVersion" INTEGER NOT NULL DEFAULT 1,
  "status" "CabinetInvitationDeliveryStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL,
  "lockedAt" TIMESTAMP(3),
  "leaseUntil" TIMESTAMP(3),
  "lastError" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cabinet_invitation_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cabinet_invitation_deliveries_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "cabinet_invitation_deliveries_key_version_check" CHECK ("tokenKeyVersion" >= 1),
  CONSTRAINT "cabinet_invitation_deliveries_state_check" CHECK (
    ("status" = 'sending' AND "lockedAt" IS NOT NULL AND "leaseUntil" IS NOT NULL AND "sentAt" IS NULL
      AND "tokenCiphertext" IS NOT NULL AND "tokenIv" IS NOT NULL AND "tokenAuthTag" IS NOT NULL)
    OR ("status" = 'done' AND "lockedAt" IS NULL AND "leaseUntil" IS NULL AND "sentAt" IS NOT NULL
      AND "tokenCiphertext" IS NULL AND "tokenIv" IS NULL AND "tokenAuthTag" IS NULL)
    OR ("status" = 'cancelled' AND "lockedAt" IS NULL AND "leaseUntil" IS NULL AND "sentAt" IS NULL
      AND "tokenCiphertext" IS NULL AND "tokenIv" IS NULL AND "tokenAuthTag" IS NULL)
    OR ("status" IN ('pending', 'failed') AND "lockedAt" IS NULL AND "leaseUntil" IS NULL AND "sentAt" IS NULL
      AND "tokenCiphertext" IS NOT NULL AND "tokenIv" IS NOT NULL AND "tokenAuthTag" IS NOT NULL)
  )
);

CREATE TABLE "release_flags" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "environment" "ReleaseEnvironment" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "killSwitch" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "release_flags_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "release_flags_key_check" CHECK (
    char_length("key") <= 80 AND "key" ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$'
  ),
  CONSTRAINT "release_flags_version_check" CHECK ("version" >= 1)
);

CREATE TABLE "release_flag_subjects" (
  "id" TEXT NOT NULL,
  "flagId" TEXT NOT NULL,
  "subjectType" "ReleaseFlagSubjectType" NOT NULL,
  "subjectId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "release_flag_subjects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "release_flag_subjects_subject_check" CHECK (char_length("subjectId") BETWEEN 1 AND 160),
  CONSTRAINT "release_flag_subjects_version_check" CHECK ("version" >= 1)
);

CREATE TABLE "release_flag_audit_events" (
  "id" TEXT NOT NULL,
  "flagId" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "beforeState" JSONB NOT NULL,
  "afterState" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "release_flag_audit_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "release_flag_audit_actor_check" CHECK (char_length(btrim(actor)) BETWEEN 1 AND 160),
  CONSTRAINT "release_flag_audit_reason_check" CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  CONSTRAINT "release_flag_audit_operation_check" CHECK (operation IN ('set-global', 'set-kill-switch', 'set-subject', 'remove-subject')),
  CONSTRAINT "release_flag_audit_before_check" CHECK (jsonb_typeof("beforeState") = 'object'),
  CONSTRAINT "release_flag_audit_after_check" CHECK (jsonb_typeof("afterState") = 'object')
);

CREATE INDEX "cabinets_createdByUserId_idx" ON "cabinets"("createdByUserId");
CREATE INDEX "cabinets_status_idx" ON "cabinets"("status");
CREATE INDEX "cabinet_members_cabinetId_userId_idx" ON "cabinet_members"("cabinetId", "userId");
CREATE UNIQUE INDEX "cabinet_members_one_current_user_idx"
  ON "cabinet_members"("cabinetId", "userId") WHERE status <> 'revoked';
CREATE UNIQUE INDEX "cabinet_members_id_cabinetId_key" ON "cabinet_members"("id", "cabinetId");
CREATE UNIQUE INDEX "cabinet_members_sourceInvitationId_key" ON "cabinet_members"("sourceInvitationId");
CREATE INDEX "cabinet_members_userId_status_idx" ON "cabinet_members"("userId", "status");
CREATE INDEX "cabinet_members_cabinetId_status_role_idx" ON "cabinet_members"("cabinetId", "status", "role");
CREATE UNIQUE INDEX "cabinet_invitations_tokenHash_key" ON "cabinet_invitations"("tokenHash");
CREATE UNIQUE INDEX "cabinet_invitations_id_cabinetId_key" ON "cabinet_invitations"("id", "cabinetId");
CREATE INDEX "cabinet_invitations_cabinetId_status_expiresAt_idx" ON "cabinet_invitations"("cabinetId", "status", "expiresAt");
CREATE INDEX "cabinet_invitations_emailNormalized_status_idx" ON "cabinet_invitations"("emailNormalized", "status");
CREATE INDEX "cabinet_invitations_invitedByMemberId_idx" ON "cabinet_invitations"("invitedByMemberId");
CREATE INDEX "cabinet_invitations_revokedByMemberId_idx" ON "cabinet_invitations"("revokedByMemberId");
CREATE UNIQUE INDEX "cabinet_invitations_one_pending_email_idx"
  ON "cabinet_invitations"("cabinetId", "emailNormalized") WHERE "status" = 'pending';
CREATE INDEX "cabinet_audit_events_cabinetId_createdAt_idx" ON "cabinet_audit_events"("cabinetId", "createdAt");
CREATE INDEX "cabinet_audit_events_cabinetId_entityType_entityId_createdAt_idx"
  ON "cabinet_audit_events"("cabinetId", "entityType", "entityId", "createdAt");
CREATE INDEX "cabinet_audit_events_actorUserId_createdAt_idx" ON "cabinet_audit_events"("actorUserId", "createdAt");
CREATE UNIQUE INDEX "cabinet_invitation_deliveries_cabinetId_dedupeKey_key"
  ON "cabinet_invitation_deliveries"("cabinetId", "dedupeKey");
CREATE INDEX "cabinet_invitation_deliveries_cabinetId_status_nextAttemptAt_idx"
  ON "cabinet_invitation_deliveries"("cabinetId", "status", "nextAttemptAt");
CREATE INDEX "cabinet_invitation_deliveries_invitationId_idx" ON "cabinet_invitation_deliveries"("invitationId");
CREATE UNIQUE INDEX "release_flags_key_environment_key" ON "release_flags"("key", "environment");
CREATE INDEX "release_flags_environment_enabled_killSwitch_idx" ON "release_flags"("environment", "enabled", "killSwitch");
CREATE UNIQUE INDEX "release_flag_subjects_flagId_subjectType_subjectId_key"
  ON "release_flag_subjects"("flagId", "subjectType", "subjectId");
CREATE INDEX "release_flag_subjects_subjectType_subjectId_idx" ON "release_flag_subjects"("subjectType", "subjectId");
CREATE INDEX "release_flag_audit_events_flagId_createdAt_idx" ON "release_flag_audit_events"("flagId", "createdAt");
CREATE INDEX "release_flag_audit_events_actor_createdAt_idx" ON "release_flag_audit_events"("actor", "createdAt");

ALTER TABLE "cabinet_members" ADD CONSTRAINT "cabinet_members_cabinetId_fkey"
  FOREIGN KEY ("cabinetId") REFERENCES "cabinets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cabinet_admin_guards" ADD CONSTRAINT "cabinet_admin_guards_cabinetId_fkey"
  FOREIGN KEY ("cabinetId") REFERENCES "cabinets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cabinet_invitations" ADD CONSTRAINT "cabinet_invitations_cabinetId_fkey"
  FOREIGN KEY ("cabinetId") REFERENCES "cabinets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cabinet_invitations" ADD CONSTRAINT "cabinet_invitations_invitedByMemberId_cabinetId_fkey"
  FOREIGN KEY ("invitedByMemberId", "cabinetId") REFERENCES "cabinet_members"("id", "cabinetId")
  ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "cabinet_invitations" ADD CONSTRAINT "cabinet_invitations_revokedByMemberId_cabinetId_fkey"
  FOREIGN KEY ("revokedByMemberId", "cabinetId") REFERENCES "cabinet_members"("id", "cabinetId")
  ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "cabinet_members" ADD CONSTRAINT "cabinet_members_sourceInvitationId_fkey"
  FOREIGN KEY ("sourceInvitationId", "cabinetId") REFERENCES "cabinet_invitations"("id", "cabinetId")
  ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "cabinet_audit_events" ADD CONSTRAINT "cabinet_audit_events_cabinetId_fkey"
  FOREIGN KEY ("cabinetId") REFERENCES "cabinets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cabinet_invitation_deliveries" ADD CONSTRAINT "cabinet_invitation_deliveries_cabinetId_fkey"
  FOREIGN KEY ("cabinetId") REFERENCES "cabinets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cabinet_invitation_deliveries" ADD CONSTRAINT "cabinet_invitation_deliveries_invitationId_fkey"
  FOREIGN KEY ("invitationId", "cabinetId") REFERENCES "cabinet_invitations"("id", "cabinetId")
  ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "release_flag_subjects" ADD CONSTRAINT "release_flag_subjects_flagId_fkey"
  FOREIGN KEY ("flagId") REFERENCES "release_flags"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "release_flag_audit_events" ADD CONSTRAINT "release_flag_audit_events_flagId_fkey"
  FOREIGN KEY ("flagId") REFERENCES "release_flags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Défense transactionnelle : l'identité d'une membership est immuable et le dernier admin actif
-- ne peut pas être suspendu, révoqué ou rétrogradé. Les suppressions physiques restent réservées
-- aux migrations/ops (aucune policy DELETE runtime).
CREATE OR REPLACE FUNCTION cabinet_guard_member_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW."cabinetId" <> OLD."cabinetId"
     OR NEW."userId" <> OLD."userId"
     OR NEW."sourceInvitationId" IS DISTINCT FROM OLD."sourceInvitationId"
     OR NEW."joinedAt" <> OLD."joinedAt"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'cabinet membership identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'revoked'
     OR (OLD.status = 'suspended' AND NEW.status NOT IN ('active', 'revoked'))
     OR (NEW.role <> OLD.role AND (OLD.status <> 'active' OR NEW.status <> 'active')) THEN
    RAISE EXCEPTION 'invalid cabinet membership transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'cabinet membership version must increment by one' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER cabinet_members_guard_update
BEFORE UPDATE ON "cabinet_members"
FOR EACH ROW EXECUTE FUNCTION cabinet_guard_member_update();

-- Une ligne garde par cabinet sérialise les mutations d'admins. Deux retraits concurrents peuvent
-- verrouiller chacun leur membership, mais convergent ensuite sur cette seule ligne sans jamais
-- attendre la membership de l'autre : pas de cycle, et activeCount ne peut pas passer sous 1.
CREATE OR REPLACE FUNCTION cabinet_sync_admin_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE old_is_active_admin boolean := false;
DECLARE new_is_active_admin boolean;
DECLARE changed_rows integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_is_active_admin := OLD.role = 'admin' AND OLD.status = 'active';
  END IF;
  new_is_active_admin := NEW.role = 'admin' AND NEW.status = 'active';

  IF new_is_active_admin AND NOT old_is_active_admin THEN
    INSERT INTO public.cabinet_admin_guards ("cabinetId", "activeCount", "updatedAt")
    VALUES (NEW."cabinetId", 1, CURRENT_TIMESTAMP)
    ON CONFLICT ("cabinetId") DO UPDATE
      SET "activeCount" = public.cabinet_admin_guards."activeCount" + 1,
          "updatedAt" = CURRENT_TIMESTAMP;
  ELSIF old_is_active_admin AND NOT new_is_active_admin THEN
    UPDATE public.cabinet_admin_guards
       SET "activeCount" = "activeCount" - 1,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "cabinetId" = OLD."cabinetId"
       AND "activeCount" > 1;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'cannot revoke or demote the last active cabinet admin' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cabinet_members_admin_guard_insert
AFTER INSERT ON "cabinet_members"
FOR EACH ROW EXECUTE FUNCTION cabinet_sync_admin_guard();

CREATE TRIGGER cabinet_members_admin_guard_update
AFTER UPDATE OF role, status ON "cabinet_members"
FOR EACH ROW EXECUTE FUNCTION cabinet_sync_admin_guard();

-- L'agrégat Cabinet a besoin de toutes ses memberships pour prouver RBAC/dernier admin. Un quota
-- transactionnel explicite borne donc sa réhydratation, au lieu de tronquer silencieusement.
CREATE OR REPLACE FUNCTION cabinet_guard_member_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE member_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."cabinetId", 0));
  SELECT count(*) INTO member_count
    FROM public.cabinet_members
   WHERE "cabinetId" = NEW."cabinetId";
  IF member_count >= 500 THEN
    RAISE EXCEPTION 'cabinet membership quota reached' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cabinet_members_guard_insert
BEFORE INSERT ON "cabinet_members"
FOR EACH ROW EXECUTE FUNCTION cabinet_guard_member_insert();

CREATE OR REPLACE FUNCTION cabinet_guard_cabinet_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE actor_is_admin boolean;
BEGIN
  IF NEW.id <> OLD.id
     OR NEW."createdByUserId" <> OLD."createdByUserId"
     OR NEW."createdAt" <> OLD."createdAt"
     OR (OLD."bootstrapCompletedAt" IS NOT NULL AND NEW."bootstrapCompletedAt" IS DISTINCT FROM OLD."bootstrapCompletedAt") THEN
    RAISE EXCEPTION 'immutable cabinet fields cannot be changed' USING ERRCODE = '23514';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.cabinet_members m
     WHERE m."cabinetId" = OLD.id
       AND m."userId" = nullif(current_setting('app.current_user_id', true), '')
       AND m.role = 'admin'
       AND m.status = 'active'
  ) INTO actor_is_admin;
  IF NOT actor_is_admin
     AND (NEW.name <> OLD.name OR NEW."timeZone" <> OLD."timeZone" OR NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'non-admin cabinet updates are limited to aggregate version' USING ERRCODE = '42501';
  END IF;
  IF OLD."bootstrapCompletedAt" IS NULL
     AND NEW."bootstrapCompletedAt" IS NOT NULL
     AND NEW.name = OLD.name
     AND NEW."timeZone" = OLD."timeZone"
     AND NEW.status = OLD.status THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.cabinet_admin_guards guard
       WHERE guard."cabinetId" = OLD.id AND guard."activeCount" >= 1
    ) THEN
      RAISE EXCEPTION 'cabinet bootstrap requires an active admin guard' USING ERRCODE = '23514';
    END IF;
    IF NEW."version" <> OLD."version" THEN
      RAISE EXCEPTION 'cabinet bootstrap must not alter domain version' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'cabinet version must increment by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cabinets_guard_update
BEFORE UPDATE ON "cabinets"
FOR EACH ROW EXECUTE FUNCTION cabinet_guard_cabinet_update();

CREATE OR REPLACE FUNCTION cabinet_guard_invitation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW."cabinetId" <> OLD."cabinetId"
     OR NEW."emailNormalized" <> OLD."emailNormalized"
     OR NEW.role <> OLD.role
     OR NEW."tokenHash" <> OLD."tokenHash"
     OR NEW."expiresAt" <> OLD."expiresAt"
     OR NEW."invitedByMemberId" <> OLD."invitedByMemberId"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'immutable cabinet invitation fields cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('accepted', 'expired', 'revoked') THEN
    RAISE EXCEPTION 'invalid cabinet invitation transition' USING ERRCODE = '23514';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'cabinet invitation version must increment by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cabinet_invitations_guard_update
BEFORE UPDATE ON "cabinet_invitations"
FOR EACH ROW EXECUTE FUNCTION cabinet_guard_invitation_update();

CREATE OR REPLACE FUNCTION cabinet_guard_invitation_delivery_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW."cabinetId" <> OLD."cabinetId"
     OR NEW."invitationId" <> OLD."invitationId"
     OR NEW."dedupeKey" <> OLD."dedupeKey"
     OR NEW."tokenKeyVersion" <> OLD."tokenKeyVersion"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'immutable cabinet invitation delivery fields cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.status IN ('done', 'cancelled') THEN
    IF NEW."tokenCiphertext" IS NOT NULL OR NEW."tokenIv" IS NOT NULL OR NEW."tokenAuthTag" IS NOT NULL THEN
      RAISE EXCEPTION 'delivered invitation secret must be purged' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."tokenCiphertext" IS DISTINCT FROM OLD."tokenCiphertext"
     OR NEW."tokenIv" IS DISTINCT FROM OLD."tokenIv"
     OR NEW."tokenAuthTag" IS DISTINCT FROM OLD."tokenAuthTag" THEN
    RAISE EXCEPTION 'encrypted invitation secret is immutable before purge' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('done', 'cancelled')
     OR (
       NEW.status = 'sending'
       AND NOT (
         OLD.status IN ('pending', 'failed')
         OR (OLD.status = 'sending' AND OLD."leaseUntil" <= CURRENT_TIMESTAMP)
       )
     )
     OR (NEW.status = 'done' AND OLD.status <> 'sending')
     OR (NEW.status = 'failed' AND OLD.status <> 'sending')
     OR (NEW.status = 'cancelled' AND OLD.status NOT IN ('pending', 'failed', 'sending'))
     OR (NEW.status = 'sending' AND NEW.attempts <> OLD.attempts + 1)
     OR (NEW.status <> 'sending' AND NEW.attempts <> OLD.attempts) THEN
    RAISE EXCEPTION 'invalid cabinet invitation delivery transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cabinet_invitation_deliveries_guard_update
BEFORE UPDATE ON "cabinet_invitation_deliveries"
FOR EACH ROW EXECUTE FUNCTION cabinet_guard_invitation_delivery_update();

CREATE OR REPLACE FUNCTION cabinet_cancel_deliveries_on_terminal_invitation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status IN ('accepted', 'expired', 'revoked') THEN
    -- Même fencing que le worker : ordre invitation -> delivery, sans deadlock D↔I.
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.id, 1));
    UPDATE public.cabinet_invitation_deliveries
       SET status = 'cancelled',
           "lockedAt" = NULL,
           "leaseUntil" = NULL,
           "lastError" = NULL,
           "sentAt" = NULL,
           "tokenCiphertext" = NULL,
           "tokenIv" = NULL,
           "tokenAuthTag" = NULL,
           "updatedAt" = CURRENT_TIMESTAMP
     WHERE "invitationId" = NEW.id
       AND status IN ('pending', 'failed', 'sending');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cabinet_invitations_cancel_deliveries
AFTER UPDATE OF status ON "cabinet_invitations"
FOR EACH ROW EXECUTE FUNCTION cabinet_cancel_deliveries_on_terminal_invitation();

-- Ces deux événements d'acceptation sont canoniques et produits par la base. Le rôle runtime n'a
-- donc jamais besoin d'une capacité durable lui permettant de forger des lignes d'audit au moyen
-- d'un token déjà accepté.
CREATE OR REPLACE FUNCTION cabinet_audit_invitation_acceptance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF OLD.status = 'pending' AND NEW.status = 'accepted' THEN
    INSERT INTO public.cabinet_audit_events (
      id, "cabinetId", "actorUserId", action, "entityType", "entityId", payload, "correlationId", "createdAt"
    ) VALUES (
      'canonical:invitation-accepted:' || NEW.id,
      NEW."cabinetId",
      NEW."acceptedByUserId",
      'CabinetInvitationAccepted',
      'cabinet_invitation',
      NEW.id,
      jsonb_build_object(
        'type', 'CabinetInvitationAccepted',
        'occurredAt', NEW."acceptedAt",
        'version', NEW.version,
        'invitationId', NEW.id,
        'cabinetId', NEW."cabinetId",
        'userId', NEW."acceptedByUserId"
      ),
      NULL,
      NEW."acceptedAt"
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cabinet_invitations_audit_acceptance
AFTER UPDATE OF status ON "cabinet_invitations"
FOR EACH ROW EXECUTE FUNCTION cabinet_audit_invitation_acceptance();

-- Marqueur append-only de consommation intermédiaire. L'UPDATE de version Cabinet précède
-- l'INSERT membership ; le marqueur rend ce droit utilisable une seule fois, dans la transaction.
CREATE OR REPLACE FUNCTION cabinet_audit_invitation_application()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE accepted_invitation record;
BEGIN
  IF NEW.version = OLD.version + 1 THEN
    SELECT i.id, i."acceptedByUserId"
      INTO accepted_invitation
      FROM public.cabinet_invitations i
     WHERE i."cabinetId" = NEW.id
       AND i.status = 'accepted'
       AND i."acceptedByUserId" = nullif(current_setting('app.current_user_id', true), '')
       AND i."emailNormalized" = lower(nullif(current_setting('app.current_user_email', true), ''))
       AND i."tokenHash" = nullif(current_setting('app.current_invitation_token_hash', true), '')
       AND NOT EXISTS (
         SELECT 1 FROM public.cabinet_members member WHERE member."sourceInvitationId" = i.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.cabinet_audit_events marker
          WHERE marker.id = 'canonical:invitation-applied:' || i.id
       );
    IF FOUND THEN
      INSERT INTO public.cabinet_audit_events (
        id, "cabinetId", "actorUserId", action, "entityType", "entityId", payload, "correlationId", "createdAt"
      ) VALUES (
        'canonical:invitation-applied:' || accepted_invitation.id,
        NEW.id,
        accepted_invitation."acceptedByUserId",
        'CabinetInvitationApplied',
        'cabinet_invitation',
        accepted_invitation.id,
        jsonb_build_object(
          'type', 'CabinetInvitationApplied',
          'invitationId', accepted_invitation.id,
          'cabinetId', NEW.id,
          'cabinetVersion', NEW.version
        ),
        NULL,
        CURRENT_TIMESTAMP
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cabinets_audit_invitation_application
AFTER UPDATE OF version ON "cabinets"
FOR EACH ROW EXECUTE FUNCTION cabinet_audit_invitation_application();

CREATE OR REPLACE FUNCTION cabinet_audit_membership_join()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  IF NEW."sourceInvitationId" IS NOT NULL THEN
    INSERT INTO public.cabinet_audit_events (
      id, "cabinetId", "actorUserId", action, "entityType", "entityId", payload, "correlationId", "createdAt"
    ) VALUES (
      'canonical:member-joined:' || NEW.id,
      NEW."cabinetId",
      NEW."userId",
      'CabinetMemberJoined',
      'cabinet',
      NEW."cabinetId",
      jsonb_build_object(
        'type', 'CabinetMemberJoined',
        'occurredAt', NEW."joinedAt",
        'version', (SELECT version FROM public.cabinets WHERE id = NEW."cabinetId"),
        'cabinetId', NEW."cabinetId",
        'memberId', NEW.id,
        'userId', NEW."userId",
        'invitationId', NEW."sourceInvitationId",
        'role', NEW.role
      ),
      NULL,
      NEW."joinedAt"
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cabinet_members_audit_join
AFTER INSERT ON "cabinet_members"
FOR EACH ROW EXECUTE FUNCTION cabinet_audit_membership_join();

-- Suspension fail-closed : les invitations restent historisées/pending, mais l'outbox annule et
-- purge tout secret chiffré non terminal avant le COMMIT de la suspension.
CREATE OR REPLACE FUNCTION cabinet_purge_deliveries_on_suspension()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
DECLARE invitation_id text;
BEGIN
  IF OLD.status = 'active' AND NEW.status = 'suspended' THEN
    FOR invitation_id IN
      SELECT DISTINCT delivery."invitationId"
        FROM public.cabinet_invitation_deliveries delivery
       WHERE delivery."cabinetId" = NEW.id
         AND delivery.status IN ('pending', 'failed', 'sending')
       ORDER BY delivery."invitationId"
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(invitation_id, 1));
      UPDATE public.cabinet_invitation_deliveries
         SET status = 'cancelled',
             "lockedAt" = NULL,
             "leaseUntil" = NULL,
             "lastError" = NULL,
             "sentAt" = NULL,
             "tokenCiphertext" = NULL,
             "tokenIv" = NULL,
             "tokenAuthTag" = NULL,
             "updatedAt" = CURRENT_TIMESTAMP
       WHERE "cabinetId" = NEW.id
         AND "invitationId" = invitation_id
         AND status IN ('pending', 'failed', 'sending');
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cabinets_purge_deliveries_on_suspension
AFTER UPDATE OF status ON "cabinets"
FOR EACH ROW EXECUTE FUNCTION cabinet_purge_deliveries_on_suspension();

-- release_flag_subjects est une relation polymorphe (pas de FK Cabinet possible). Sa suppression
-- explicite évite qu'un identifiant de cabinet supprimé survive au cycle RGPD du tenant.
CREATE OR REPLACE FUNCTION cabinet_delete_release_flag_subjects()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
BEGIN
  DELETE FROM public.release_flag_subjects
   WHERE "subjectType" = 'cabinet' AND "subjectId" = OLD.id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER cabinets_delete_release_flag_subjects
AFTER DELETE ON "cabinets"
FOR EACH ROW EXECUTE FUNCTION cabinet_delete_release_flag_subjects();

CREATE OR REPLACE FUNCTION cabinet_guard_release_flag_subject_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW."flagId" <> OLD."flagId"
     OR NEW."subjectType" <> OLD."subjectType"
     OR NEW."subjectId" <> OLD."subjectId"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'immutable release flag subject fields cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'release flag subject version must increment by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER release_flag_subjects_guard_update
BEFORE UPDATE ON "release_flag_subjects"
FOR EACH ROW EXECUTE FUNCTION cabinet_guard_release_flag_subject_update();

CREATE OR REPLACE FUNCTION cabinet_guard_release_flag_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.key <> OLD.key
     OR NEW.environment <> OLD.environment
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'immutable release flag fields cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'release flag version must increment by one' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER release_flags_guard_update
BEFORE UPDATE ON "release_flags"
FOR EACH ROW EXECUTE FUNCTION cabinet_guard_release_flag_update();

-- Tous les environnements commencent désactivés. Le ciblage pilote peut les activer sans perdre
-- le kill-switch global, qui a toujours priorité à l'évaluation.
INSERT INTO "release_flags" (
  "id", "key", "environment", "enabled", "killSwitch", "version", "updatedByUserId", "createdAt", "updatedAt"
)
VALUES
  ('cabinet-slice0-development', 'cabinet.slice0', 'development', false, false, 1, 'system:migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cabinet-slice0-staging', 'cabinet.slice0', 'staging', false, false, 1, 'system:migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('cabinet-slice0-production', 'cabinet.slice0', 'production', false, false, 1, 'system:migration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

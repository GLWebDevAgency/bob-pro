-- Bob Live Mistral Conversation v2 — capacité initiale atomique HTTP -> WSS.
--
-- EXPAND uniquement : le canary demeure désactivé par défaut. Le ticket brut et le userId ne
-- sont jamais stockés. Une consommation ne peut être commitée sans Mission + session.ready exacts.

BEGIN;

CREATE TABLE "realtime_mistral_conversation_bootstrap_tickets" (
  "id" UUID NOT NULL,
  "companyId" TEXT NOT NULL,
  "admissionSessionId" UUID NOT NULL,
  "sessionHandle" TEXT NOT NULL,
  "subjectHash" CHAR(64) NOT NULL,
  "subjectKeyVersion" INTEGER NOT NULL,
  "admissionLeaseTokenHash" CHAR(64) NOT NULL,
  "ticketHash" CHAR(64) NOT NULL,
  "protocol" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "plan" TEXT NOT NULL,
  "contextSchemaVersion" INTEGER NOT NULL,
  "contextRevision" INTEGER NOT NULL,
  "contextSnapshot" JSONB NOT NULL,
  "contextDigest" CHAR(64) NOT NULL,
  "userIdentityCiphertext" BYTEA NOT NULL,
  "userIdentityNonce" BYTEA NOT NULL,
  "userIdentityTag" BYTEA NOT NULL,
  "identityEncryptionKeyVersion" INTEGER NOT NULL,
  "routeMode" TEXT NOT NULL,
  "fullDuplexCertified" BOOLEAN NOT NULL,
  "maxMissionAudioBytes" INTEGER NOT NULL,
  "issuedAt" TIMESTAMPTZ NOT NULL,
  "ticketExpiresAt" TIMESTAMPTZ NOT NULL,
  "leaseExpiresAt" TIMESTAMPTZ NOT NULL,
  "hardExpiresAt" TIMESTAMPTZ NOT NULL,
  "consumedAt" TIMESTAMPTZ,
  "retentionExpiresAt" TIMESTAMPTZ NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT "realtime_mistral_conversation_bootstrap_tickets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mistral_conversation_bootstrap_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "mistral_conversation_bootstrap_admission_key" UNIQUE ("admissionSessionId"),
  CONSTRAINT "mistral_conversation_bootstrap_ticket_hash_key" UNIQUE ("ticketHash"),
  CONSTRAINT "mistral_conversation_bootstrap_tenant_ticket_key"
    UNIQUE ("companyId", "ticketHash"),
  CONSTRAINT "mistral_conversation_bootstrap_protocol_state_check" CHECK (
    "protocol" = 'bob.mistral-pcm.v2'
    AND "state" IN ('issued', 'consumed')
  ),
  CONSTRAINT "mistral_conversation_bootstrap_identity_check" CHECK (
    "sessionHandle" = lower("admissionSessionId"::TEXT)
    AND "subjectHash"::TEXT ~ '^[a-f0-9]{64}$'
    AND "subjectKeyVersion" BETWEEN 1 AND 2147483647
    AND "admissionLeaseTokenHash"::TEXT ~ '^[a-f0-9]{64}$'
    AND "ticketHash"::TEXT ~ '^[a-f0-9]{64}$'
    AND "plan" IN ('free', 'solo', 'pro', 'business')
  ),
  CONSTRAINT "mistral_conversation_bootstrap_context_check" CHECK (
    "contextSchemaVersion" = 1
    AND "contextRevision" BETWEEN 1 AND 2147483647
    AND "contextDigest"::TEXT ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("contextSnapshot") = 'object'
    AND pg_column_size("contextSnapshot") BETWEEN 2 AND 65536
    AND ("contextSnapshot"->>'version')::INTEGER = "contextSchemaVersion"
    AND ("contextSnapshot"->>'revision')::INTEGER = "contextRevision"
    AND "contextSnapshot" ? 'context'
  ),
  CONSTRAINT "mistral_conversation_bootstrap_identity_cipher_check" CHECK (
    octet_length("userIdentityCiphertext") BETWEEN 1 AND 1024
    AND octet_length("userIdentityNonce") = 12
    AND octet_length("userIdentityTag") = 16
    AND "identityEncryptionKeyVersion" BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT "mistral_conversation_bootstrap_route_budget_check" CHECK (
    "routeMode" = 'push_to_talk'
    AND NOT "fullDuplexCertified"
    AND "maxMissionAudioBytes" BETWEEN 320 AND 28800000
    AND "maxMissionAudioBytes" % 320 = 0
  ),
  CONSTRAINT "mistral_conversation_bootstrap_time_check" CHECK (
    "issuedAt" < "ticketExpiresAt"
    AND "ticketExpiresAt" <= "issuedAt" + interval '120 seconds'
    AND "ticketExpiresAt" <= "leaseExpiresAt"
    AND "leaseExpiresAt" <= "hardExpiresAt"
    AND "hardExpiresAt" < "retentionExpiresAt"
    AND "retentionExpiresAt" <= "hardExpiresAt" + interval '7 days'
    AND ("consumedAt" IS NULL OR (
      "issuedAt" <= "consumedAt" AND "consumedAt" < "ticketExpiresAt"
    ))
    AND "updatedAt" >= "issuedAt"
  ),
  CONSTRAINT "mistral_conversation_bootstrap_lifecycle_check" CHECK (
    ("state" = 'issued' AND "version" = 1 AND "consumedAt" IS NULL)
    OR ("state" = 'consumed' AND "version" = 2 AND "consumedAt" IS NOT NULL)
  )
);

CREATE INDEX "mistral_conversation_bootstrap_tenant_issued_idx"
  ON "realtime_mistral_conversation_bootstrap_tickets"("companyId", "issuedAt");
CREATE INDEX "mistral_conversation_bootstrap_subject_issued_idx"
  ON "realtime_mistral_conversation_bootstrap_tickets"(
    "companyId", "subjectHash", "issuedAt"
  );
CREATE INDEX "mistral_conversation_bootstrap_retention_idx"
  ON "realtime_mistral_conversation_bootstrap_tickets"(
    "companyId", "retentionExpiresAt"
  );

CREATE FUNCTION enforce_mistral_conversation_bootstrap_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'mistral conversation bootstrap evidence is append-only'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."retentionExpiresAt" > clock_timestamp() THEN
      RAISE EXCEPTION 'retained mistral conversation bootstrap evidence cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."state" <> 'consumed'
     OR OLD."state" <> 'issued'
     OR OLD."version" <> 1
     OR NEW."version" <> 2
     OR OLD."consumedAt" IS NOT NULL
     OR NEW."consumedAt" IS NULL
     OR (
       to_jsonb(NEW) - ARRAY['state', 'consumedAt', 'version', 'updatedAt']::TEXT[]
       IS DISTINCT FROM
       to_jsonb(OLD) - ARRAY['state', 'consumedAt', 'version', 'updatedAt']::TEXT[]
     )
  THEN
    RAISE EXCEPTION 'invalid mistral conversation bootstrap transition'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.realtime_session_leases AS lease
     WHERE lease."companyId" = NEW."companyId"
       AND lease."subjectHash" = NEW."subjectHash"
       AND lease."sessionId" = NEW."admissionSessionId"
       AND lease."leaseTokenHash" = NEW."admissionLeaseTokenHash"
       AND lease.state = 'active'
       AND lease."activatedAt" IS NOT NULL
       AND lease."providerId" = 'mistral'
       AND lease."providerCallId" = 'mcv2:' || NEW.id::TEXT
       AND lease."leaseExpiresAt" > clock_timestamp()
       AND lease."hardExpiresAt" > clock_timestamp()
       AND lease."hardExpiresAt" = NEW."hardExpiresAt"
  ) THEN
    RAISE EXCEPTION 'mistral conversation bootstrap consumption lost atomic admission binding'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.realtime_mistral_conversation_missions AS mission
      JOIN public.realtime_mistral_conversation_outbox AS outbox
        ON outbox."companyId" = mission."companyId"
       AND outbox."missionId" = mission.id
       AND outbox."sessionHandle" = mission."sessionHandle"
       AND outbox."serverSequence" = 0
       AND outbox."eventType" = 'session.ready'
     WHERE mission."initialBootstrapId" = NEW.id
       AND mission."companyId" = NEW."companyId"
       AND mission."admissionSessionId" = NEW."admissionSessionId"
       AND mission."sessionHandle" = NEW."sessionHandle"
       AND mission.protocol = NEW.protocol
       AND mission."subjectHash" = NEW."subjectHash"
       AND mission."subjectKeyVersion" = NEW."subjectKeyVersion"
       AND mission.plan = NEW.plan
       AND mission."contextRevision" = NEW."contextRevision"
       AND mission."contextDigest" = NEW."contextDigest"
       AND mission."routeMode" = NEW."routeMode"
       AND mission."fullDuplexCertified" = NEW."fullDuplexCertified"
       AND mission."maxMissionAudioBytes" = NEW."maxMissionAudioBytes"
       AND mission."hardExpiresAt" = NEW."hardExpiresAt"
  ) THEN
    RAISE EXCEPTION 'mistral conversation bootstrap consumption lost atomic mission binding'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER realtime_mistral_conversation_bootstrap_update_guard
BEFORE UPDATE ON "realtime_mistral_conversation_bootstrap_tickets"
FOR EACH ROW EXECUTE FUNCTION enforce_mistral_conversation_bootstrap_lifecycle();

CREATE TRIGGER realtime_mistral_conversation_bootstrap_delete_guard
BEFORE DELETE ON "realtime_mistral_conversation_bootstrap_tickets"
FOR EACH ROW EXECUTE FUNCTION enforce_mistral_conversation_bootstrap_lifecycle();

CREATE TRIGGER realtime_mistral_conversation_bootstrap_truncate_guard
BEFORE TRUNCATE ON "realtime_mistral_conversation_bootstrap_tickets"
FOR EACH STATEMENT EXECUTE FUNCTION enforce_mistral_conversation_bootstrap_lifecycle();

-- La purge est un canal SQL separe du runtime. Elle s'execute sous un role NOLOGIN dedie,
-- en SECURITY INVOKER et donc sous FORCE RLS. Le nom du role est compare par current_user :
-- la migration reste applicable avant son provisionnement par release.sh, sans ouvrir la policy
-- a un role applicatif qui en serait simplement membre.
CREATE FUNCTION purge_realtime_mistral_conversation_bootstrap_tickets(batch_limit INTEGER DEFAULT 500)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  candidate RECORD;
  purged_count INTEGER := 0;
  deleted_count INTEGER;
BEGIN
  IF batch_limit IS NULL OR batch_limit < 1 OR batch_limit > 1000 THEN
    RAISE EXCEPTION 'mistral conversation bootstrap purge batch must be between 1 and 1000'
      USING ERRCODE = '22023';
  END IF;

  FOR candidate IN
    SELECT ticket.id
      FROM public.realtime_mistral_conversation_bootstrap_tickets AS ticket
     WHERE ticket."retentionExpiresAt" <= clock_timestamp()
     ORDER BY ticket."retentionExpiresAt", ticket.id
     FOR UPDATE OF ticket SKIP LOCKED
     LIMIT batch_limit
  LOOP
    BEGIN
      DELETE FROM public.realtime_mistral_conversation_bootstrap_tickets AS ticket
       WHERE ticket.id = candidate.id
         AND ticket."retentionExpiresAt" <= clock_timestamp();
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      purged_count := purged_count + deleted_count;
    EXCEPTION
      -- Une preuve consommee reste referencee jusqu'a la purge posterieure de sa Mission.
      -- Le batch continue sans contourner la FK, et un prochain passage la reprendra.
      WHEN foreign_key_violation THEN NULL;
    END;
  END LOOP;

  RETURN purged_count;
END;
$$;

REVOKE ALL ON TABLE "realtime_mistral_conversation_bootstrap_tickets" FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_mistral_conversation_bootstrap_lifecycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER) FROM PUBLIC;

ALTER TABLE "realtime_mistral_conversation_bootstrap_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_mistral_conversation_bootstrap_tickets" FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_mistral_conversation_bootstrap_select
  ON "realtime_mistral_conversation_bootstrap_tickets" FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_mistral_conversation_bootstrap_insert
  ON "realtime_mistral_conversation_bootstrap_tickets" FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_mistral_conversation_bootstrap_update
  ON "realtime_mistral_conversation_bootstrap_tickets" FOR UPDATE
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
-- Le reaper peut voir/verrouiller/supprimer uniquement les preuves arrivees a retention.
-- WITH CHECK false autorise le verrou FOR UPDATE necessaire a SKIP LOCKED mais interdit toute
-- reecriture, en plus du trigger de cycle de vie.
CREATE POLICY realtime_mistral_conversation_bootstrap_reaper_select
  ON "realtime_mistral_conversation_bootstrap_tickets" FOR SELECT
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND "retentionExpiresAt" <= clock_timestamp()
  );
CREATE POLICY realtime_mistral_conversation_bootstrap_reaper_lock
  ON "realtime_mistral_conversation_bootstrap_tickets" FOR UPDATE
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND "retentionExpiresAt" <= clock_timestamp()
  )
  WITH CHECK (false);
CREATE POLICY realtime_mistral_conversation_bootstrap_reaper_delete
  ON "realtime_mistral_conversation_bootstrap_tickets" FOR DELETE
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND "retentionExpiresAt" <= clock_timestamp()
  );

COMMIT;

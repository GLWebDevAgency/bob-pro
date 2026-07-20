-- Bob Live Mistral Conversation v2 — capacités de reprise atomiques et ACK terminal borné.
--
-- EXPAND uniquement : les missions historiques restent lisibles, mais leur admissionSessionId
-- NULL les rend volontairement non reprenables. Le runtime v2 demeure désactivé pendant ce lot.

BEGIN;

ALTER TABLE "realtime_mistral_conversation_missions"
  ADD COLUMN "admissionSessionId" UUID;

ALTER TABLE "realtime_mistral_conversation_missions"
  ADD CONSTRAINT "realtime_mistral_conversation_missions_admission_session_key"
    UNIQUE ("admissionSessionId"),
  ADD CONSTRAINT "realtime_mistral_conversation_missions_admission_binding"
    UNIQUE (id, "companyId", "sessionHandle", "admissionSessionId");

-- Une mission legacy NULL reste lisible, mais toute nouvelle mission doit porter son bail exact
-- et aucune liaison ne peut être ajoutée, retirée ou remplacée après l'INSERT.
CREATE FUNCTION guard_realtime_mistral_conversation_admission_binding()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."admissionSessionId" IS NULL THEN
      RAISE EXCEPTION 'new mistral conversation mission requires an admission binding'
        USING ERRCODE = '23502';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."admissionSessionId" IS DISTINCT FROM OLD."admissionSessionId" THEN
    RAISE EXCEPTION 'mistral conversation admission binding is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER realtime_mistral_conversation_admission_binding_guard
BEFORE INSERT OR UPDATE ON "realtime_mistral_conversation_missions"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_mistral_conversation_admission_binding();

CREATE TABLE "realtime_mistral_conversation_resume_tickets" (
  "id" UUID NOT NULL,
  "companyId" TEXT NOT NULL,
  "missionId" UUID NOT NULL,
  "sessionHandle" TEXT NOT NULL,
  "admissionSessionId" UUID NOT NULL,
  "ticketHash" CHAR(64) NOT NULL,
  "protocol" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "subjectHash" CHAR(64) NOT NULL,
  "subjectKeyVersion" INTEGER NOT NULL,
  "plan" TEXT NOT NULL,
  "expectedMissionConnectionEpoch" INTEGER NOT NULL,
  "clientAcceptedMissionConnectionEpoch" INTEGER NOT NULL,
  "resumeNextServerSequence" BIGINT NOT NULL,
  "contextRevision" INTEGER NOT NULL,
  "contextDigest" CHAR(64) NOT NULL,
  "routeMode" TEXT NOT NULL,
  "fullDuplexCertified" BOOLEAN NOT NULL,
  "maxMissionAudioBytes" INTEGER NOT NULL,
  "hardExpiresAt" TIMESTAMPTZ NOT NULL,
  "replayGraceExpiresAt" TIMESTAMPTZ NOT NULL,
  "issuedAt" TIMESTAMPTZ NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "consumedAt" TIMESTAMPTZ,
  "consumedMissionConnectionEpoch" INTEGER,
  "replayConnectionId" UUID,
  "connectionLeaseTokenHash" CHAR(64),
  "connectionLeaseExpiresAt" TIMESTAMPTZ,
  "maxAcknowledgableServerSequence" BIGINT,
  "retentionExpiresAt" TIMESTAMPTZ NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "realtime_mistral_conversation_resume_tickets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "realtime_mistral_conversation_resume_tickets_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "realtime_mistral_conversation_resume_tickets_mission_fkey"
    FOREIGN KEY ("missionId", "companyId", "sessionHandle", "admissionSessionId")
    REFERENCES "realtime_mistral_conversation_missions"(
      id, "companyId", "sessionHandle", "admissionSessionId"
    ) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "realtime_mistral_conversation_resume_tickets_hash_key" UNIQUE ("ticketHash"),
  CONSTRAINT "mistral_resume_tickets_replay_connection_key"
    UNIQUE ("replayConnectionId"),
  CONSTRAINT "mistral_resume_tickets_connection_token_key"
    UNIQUE ("connectionLeaseTokenHash"),
  CONSTRAINT "realtime_mistral_conversation_resume_tickets_hash_check"
    CHECK (
      "ticketHash"::TEXT ~ '^[a-f0-9]{64}$'
      AND (
        "connectionLeaseTokenHash" IS NULL
        OR "connectionLeaseTokenHash"::TEXT ~ '^[a-f0-9]{64}$'
      )
    ),
  CONSTRAINT "mistral_resume_tickets_protocol_scope_check"
    CHECK (
      protocol = 'bob.mistral-pcm.v2'
      AND scope IN ('live_takeover', 'terminal_replay')
      AND state IN ('issued', 'consumed')
    ),
  CONSTRAINT "realtime_mistral_conversation_resume_tickets_identity_check"
    CHECK (
      length("sessionHandle") BETWEEN 16 AND 128
      AND "sessionHandle" ~ '^[A-Za-z0-9_-]+$'
      AND "subjectHash"::TEXT ~ '^[a-f0-9]{64}$'
      AND "subjectKeyVersion" BETWEEN 1 AND 2147483647
      AND plan IN ('free', 'solo', 'pro', 'business')
    ),
  CONSTRAINT "realtime_mistral_conversation_resume_tickets_fence_check"
    CHECK (
      "expectedMissionConnectionEpoch" BETWEEN 1 AND 2147483647
      AND "clientAcceptedMissionConnectionEpoch" BETWEEN 1
        AND "expectedMissionConnectionEpoch"
      AND "resumeNextServerSequence" BETWEEN 0 AND 4294967296
      AND (scope <> 'live_takeover' OR "expectedMissionConnectionEpoch" < 2147483647)
      AND "contextRevision" BETWEEN 1 AND 2147483647
      AND "contextDigest"::TEXT ~ '^[a-f0-9]{64}$'
      AND "routeMode" IN ('push_to_talk', 'full_duplex')
      AND ("routeMode" <> 'full_duplex' OR "fullDuplexCertified")
      AND "maxMissionAudioBytes" BETWEEN 320 AND 28800000
      AND "maxMissionAudioBytes" % 320 = 0
      AND (
        "maxAcknowledgableServerSequence" IS NULL
        OR "maxAcknowledgableServerSequence" BETWEEN 0 AND 4294967296
      )
    ),
  CONSTRAINT "realtime_mistral_conversation_resume_tickets_time_check"
    CHECK (
      "issuedAt" < "expiresAt"
      AND "expiresAt" <= "issuedAt" + interval '120 seconds'
      AND "hardExpiresAt" < "replayGraceExpiresAt"
      AND "replayGraceExpiresAt" <= "hardExpiresAt" + interval '7 days'
      AND "retentionExpiresAt" >= "replayGraceExpiresAt"
      AND (
        (scope = 'live_takeover' AND "expiresAt" <= "hardExpiresAt")
        OR (scope = 'terminal_replay' AND "expiresAt" <= "replayGraceExpiresAt")
      )
      AND ("consumedAt" IS NULL OR "consumedAt" < "expiresAt")
      AND (
        "connectionLeaseExpiresAt" IS NULL
        OR (
          "connectionLeaseExpiresAt" <= "replayGraceExpiresAt"
          AND "connectionLeaseExpiresAt" <= "consumedAt" + interval '30 seconds'
        )
      )
    ),
  CONSTRAINT "realtime_mistral_conversation_resume_tickets_lifecycle_check"
    CHECK (
      (
        state = 'issued'
        AND version = 1
        AND "consumedAt" IS NULL
        AND "consumedMissionConnectionEpoch" IS NULL
        AND "replayConnectionId" IS NULL
        AND "connectionLeaseTokenHash" IS NULL
        AND "connectionLeaseExpiresAt" IS NULL
        AND "maxAcknowledgableServerSequence" IS NULL
      )
      OR (
        state = 'consumed'
        AND version = 2
        AND "consumedAt" IS NOT NULL
        AND "consumedMissionConnectionEpoch" IS NOT NULL
        AND (
          (
            scope = 'live_takeover'
            AND "expectedMissionConnectionEpoch" < 2147483647
            AND "consumedMissionConnectionEpoch" = "expectedMissionConnectionEpoch" + 1
            AND "replayConnectionId" IS NULL
            AND "connectionLeaseTokenHash" IS NULL
            AND "connectionLeaseExpiresAt" IS NULL
            AND "maxAcknowledgableServerSequence" IS NULL
          )
          OR (
            scope = 'terminal_replay'
            AND "consumedMissionConnectionEpoch" = "expectedMissionConnectionEpoch"
            AND "replayConnectionId" IS NOT NULL
            AND "connectionLeaseTokenHash" IS NOT NULL
            AND "connectionLeaseExpiresAt" IS NOT NULL
            AND "connectionLeaseExpiresAt" > "consumedAt"
            AND "maxAcknowledgableServerSequence" IS NOT NULL
            AND "resumeNextServerSequence" <= "maxAcknowledgableServerSequence"
          )
        )
      )
    )
);

CREATE INDEX "realtime_mistral_conversation_resume_tickets_mission_state_idx"
  ON "realtime_mistral_conversation_resume_tickets"(
    "companyId", "missionId", state, "expiresAt"
  );
CREATE INDEX "realtime_mistral_conversation_resume_tickets_lookup_idx"
  ON "realtime_mistral_conversation_resume_tickets"(
    "companyId", "ticketHash", protocol
  );
CREATE INDEX "realtime_mistral_conversation_resume_tickets_subject_state_idx"
  ON "realtime_mistral_conversation_resume_tickets"(
    "companyId", "subjectHash", "missionId", state, "expiresAt"
  );
CREATE INDEX "realtime_mistral_conversation_resume_tickets_retention_idx"
  ON "realtime_mistral_conversation_resume_tickets"(
    "companyId", "retentionExpiresAt"
  );

-- Toute insertion SQL directe doit être liée au snapshot mission verrouillé et, pour une reprise
-- live, au bail d'admission exact. Aucun providerCallId n'est inventé pour la mission v2.
CREATE FUNCTION guard_realtime_mistral_conversation_resume_ticket_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  mission_row public.realtime_mistral_conversation_missions%ROWTYPE;
  database_now timestamptz;
  admission_state text;
  admission_lease_expires_at timestamptz;
  admission_hard_expires_at timestamptz;
BEGIN
  IF NEW.state <> 'issued' OR NEW.version <> 1 THEN
    RAISE EXCEPTION 'resume ticket must be inserted as an unconsumed capability'
      USING ERRCODE = '55000';
  END IF;
  SELECT * INTO mission_row
    FROM public.realtime_mistral_conversation_missions AS mission
   WHERE mission.id = NEW."missionId"
     AND mission."companyId" = NEW."companyId"
     AND mission."sessionHandle" = NEW."sessionHandle"
     AND mission."admissionSessionId" = NEW."admissionSessionId"
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resume ticket requires an exact mission admission binding'
      USING ERRCODE = '23503';
  END IF;

  IF NEW.scope = 'live_takeover' THEN
    SELECT admission.state, admission."leaseExpiresAt", admission."hardExpiresAt"
      INTO admission_state, admission_lease_expires_at, admission_hard_expires_at
      FROM public.realtime_session_leases AS admission
     WHERE admission."companyId" = NEW."companyId"
       AND admission."subjectHash" = NEW."subjectHash"
       AND admission."sessionId" = NEW."admissionSessionId"
     FOR UPDATE;
  END IF;
  database_now := clock_timestamp();
  IF database_now >= mission_row."replayGraceExpiresAt"
    OR NEW."issuedAt" > database_now
    OR NEW."expiresAt" <= database_now
    OR NEW."retentionExpiresAt" IS DISTINCT FROM mission_row."retentionExpiresAt"
    OR NEW."hardExpiresAt" IS DISTINCT FROM mission_row."hardExpiresAt"
    OR NEW."replayGraceExpiresAt" IS DISTINCT FROM mission_row."replayGraceExpiresAt"
    OR NEW.protocol IS DISTINCT FROM mission_row.protocol
    OR NEW."subjectHash" IS DISTINCT FROM mission_row."subjectHash"
    OR NEW."subjectKeyVersion" IS DISTINCT FROM mission_row."subjectKeyVersion"
    OR NEW.plan IS DISTINCT FROM mission_row.plan
    OR NEW."expectedMissionConnectionEpoch" IS DISTINCT FROM mission_row."missionConnectionEpoch"
    OR NEW."contextRevision" IS DISTINCT FROM mission_row."contextRevision"
    OR NEW."contextDigest" IS DISTINCT FROM mission_row."contextDigest"
    OR NEW."routeMode" IS DISTINCT FROM mission_row."routeMode"
    OR NEW."fullDuplexCertified" IS DISTINCT FROM mission_row."fullDuplexCertified"
    OR NEW."maxMissionAudioBytes" IS DISTINCT FROM mission_row."maxMissionAudioBytes"
    OR NEW."resumeNextServerSequence" < mission_row."retainedFromServerSequence"
    OR NEW."resumeNextServerSequence" > mission_row."nextServerSequence"
  THEN
    RAISE EXCEPTION 'resume ticket mission fence mismatch' USING ERRCODE = '55000';
  END IF;

  IF NEW.scope = 'live_takeover' THEN
    IF admission_state IS DISTINCT FROM 'active'
      OR admission_lease_expires_at <= database_now
      OR admission_hard_expires_at <= database_now
      OR database_now >= mission_row."hardExpiresAt"
      OR mission_row.phase NOT IN ('ready', 'turn_active', 'response_active')
    THEN
      RAISE EXCEPTION 'live resume ticket requires an active exact admission lease'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NOT (
    mission_row.phase IN ('draining', 'closed')
    OR database_now >= mission_row."hardExpiresAt"
  ) THEN
    RAISE EXCEPTION 'terminal resume ticket requires a terminal mission window'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER realtime_mistral_conversation_resume_ticket_insert_guard
BEFORE INSERT ON "realtime_mistral_conversation_resume_tickets"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_mistral_conversation_resume_ticket_insert();

-- issued -> consumed est la seule mutation. Le trigger relit mission et bail après les locks ;
-- l'adapter réalise cette UPDATE en dernière instruction et rollback si le CAS ne rend pas 1.
CREATE FUNCTION guard_realtime_mistral_conversation_resume_ticket_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  mission_row public.realtime_mistral_conversation_missions%ROWTYPE;
  database_now timestamptz;
  admission_state text;
  admission_lease_expires_at timestamptz;
  admission_hard_expires_at timestamptz;
BEGIN
  IF (
    to_jsonb(NEW) - ARRAY[
      'state', 'consumedAt', 'consumedMissionConnectionEpoch', 'replayConnectionId',
      'connectionLeaseTokenHash', 'connectionLeaseExpiresAt',
      'maxAcknowledgableServerSequence', 'version'
    ]::text[]
  ) IS DISTINCT FROM (
    to_jsonb(OLD) - ARRAY[
      'state', 'consumedAt', 'consumedMissionConnectionEpoch', 'replayConnectionId',
      'connectionLeaseTokenHash', 'connectionLeaseExpiresAt',
      'maxAcknowledgableServerSequence', 'version'
    ]::text[]
  ) OR OLD.state <> 'issued' OR NEW.state <> 'consumed' OR NEW.version <> OLD.version + 1
  THEN
    RAISE EXCEPTION 'resume ticket binding is immutable and one-shot' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO mission_row
    FROM public.realtime_mistral_conversation_missions AS mission
   WHERE mission.id = OLD."missionId"
     AND mission."companyId" = OLD."companyId"
     AND mission."sessionHandle" = OLD."sessionHandle"
     AND mission."admissionSessionId" = OLD."admissionSessionId"
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resume ticket consumption lost its mission binding'
      USING ERRCODE = '23503';
  END IF;

  IF OLD.scope = 'live_takeover' THEN
    SELECT admission.state, admission."leaseExpiresAt", admission."hardExpiresAt"
      INTO admission_state, admission_lease_expires_at, admission_hard_expires_at
      FROM public.realtime_session_leases AS admission
     WHERE admission."companyId" = OLD."companyId"
       AND admission."subjectHash" = OLD."subjectHash"
       AND admission."sessionId" = OLD."admissionSessionId"
     FOR UPDATE;
  END IF;
  database_now := clock_timestamp();
  IF OLD."expiresAt" <= database_now
    OR NEW."consumedAt" > database_now
    OR NEW."consumedAt" < OLD."issuedAt"
  THEN
    RAISE EXCEPTION 'resume ticket expired before consumption' USING ERRCODE = '55000';
  END IF;

  IF OLD.protocol IS DISTINCT FROM mission_row.protocol
    OR OLD."subjectHash" IS DISTINCT FROM mission_row."subjectHash"
    OR OLD."subjectKeyVersion" IS DISTINCT FROM mission_row."subjectKeyVersion"
    OR OLD.plan IS DISTINCT FROM mission_row.plan
    OR OLD."contextRevision" IS DISTINCT FROM mission_row."contextRevision"
    OR OLD."contextDigest" IS DISTINCT FROM mission_row."contextDigest"
    OR OLD."routeMode" IS DISTINCT FROM mission_row."routeMode"
    OR OLD."fullDuplexCertified" IS DISTINCT FROM mission_row."fullDuplexCertified"
    OR OLD."maxMissionAudioBytes" IS DISTINCT FROM mission_row."maxMissionAudioBytes"
    OR OLD."hardExpiresAt" IS DISTINCT FROM mission_row."hardExpiresAt"
    OR OLD."replayGraceExpiresAt" IS DISTINCT FROM mission_row."replayGraceExpiresAt"
    OR OLD."retentionExpiresAt" IS DISTINCT FROM mission_row."retentionExpiresAt"
  THEN
    RAISE EXCEPTION 'resume ticket consumption lost its exact mission snapshot'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.scope = 'live_takeover' THEN
    IF admission_state IS DISTINCT FROM 'active'
      OR admission_lease_expires_at <= database_now
      OR admission_hard_expires_at <= database_now
      OR database_now >= mission_row."hardExpiresAt"
      OR mission_row."missionConnectionEpoch" <> OLD."expectedMissionConnectionEpoch" + 1
      OR mission_row.phase <> 'ready'
    THEN
      RAISE EXCEPTION 'live resume consumption lost its mission or admission fence'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    IF database_now >= mission_row."replayGraceExpiresAt"
      OR mission_row.phase <> 'closed'
      OR mission_row."missionConnectionEpoch" <> OLD."expectedMissionConnectionEpoch"
      OR NEW."maxAcknowledgableServerSequence" IS DISTINCT FROM mission_row."nextServerSequence"
    THEN
      RAISE EXCEPTION 'terminal resume consumption lost its mission fence'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER realtime_mistral_conversation_resume_ticket_update_guard
BEFORE UPDATE ON "realtime_mistral_conversation_resume_tickets"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_mistral_conversation_resume_ticket_update();

CREATE FUNCTION guard_realtime_mistral_conversation_resume_ticket_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD."retentionExpiresAt" > clock_timestamp() THEN
    RAISE EXCEPTION 'retained resume ticket cannot be deleted' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER realtime_mistral_conversation_resume_ticket_delete_guard
BEFORE DELETE ON "realtime_mistral_conversation_resume_tickets"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_mistral_conversation_resume_ticket_delete();

-- Le trigger historique refusait un ACK sur une mission closed avant H. On partitionne désormais
-- l'unique mutation ACK exacte vers un garde étroit valable jusqu'à G ; tout autre UPDATE garde
-- la fonction de transition existante et ses invariants complets.
DROP TRIGGER realtime_mistral_conversation_mission_transition_guard
  ON "realtime_mistral_conversation_missions";

CREATE FUNCTION guard_realtime_mistral_conversation_terminal_ack()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  database_now timestamptz := clock_timestamp();
BEGIN
  IF database_now >= OLD."replayGraceExpiresAt"
    OR NEW.version <> OLD.version + 1
    OR NEW."acknowledgedServerSequence" <= OLD."acknowledgedServerSequence"
    OR NEW."acknowledgedServerSequence" > OLD."nextServerSequence"
    OR NEW."updatedAt" < OLD."updatedAt"
    OR NEW."updatedAt" > database_now
    OR (
      to_jsonb(NEW) - ARRAY['version', 'acknowledgedServerSequence', 'updatedAt']::text[]
    ) IS DISTINCT FROM (
      to_jsonb(OLD) - ARRAY['version', 'acknowledgedServerSequence', 'updatedAt']::text[]
    )
    OR NOT EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_resume_tickets AS resume
       WHERE resume."companyId" = OLD."companyId"
         AND resume."missionId" = OLD.id
         AND resume."sessionHandle" = OLD."sessionHandle"
         AND resume.scope = 'terminal_replay'
         AND resume.state = 'consumed'
         AND resume."consumedMissionConnectionEpoch" = OLD."missionConnectionEpoch"
         AND resume."replayConnectionId"::TEXT
           = current_setting('app.mistral_terminal_ack_replay_connection_id', true)
         AND resume."connectionLeaseTokenHash"::TEXT
           = current_setting('app.mistral_terminal_ack_token_hash', true)
         AND resume."connectionLeaseExpiresAt" > database_now
         AND resume."replayGraceExpiresAt" > database_now
         AND resume."maxAcknowledgableServerSequence" >= NEW."acknowledgedServerSequence"
    )
  THEN
    RAISE EXCEPTION 'terminal replay ACK must be exact, monotone and inside grace'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER realtime_mistral_conversation_terminal_ack_guard
BEFORE UPDATE ON "realtime_mistral_conversation_missions"
FOR EACH ROW
WHEN (
  OLD.phase = 'closed'
  AND NEW.phase = 'closed'
  AND NEW."acknowledgedServerSequence" > OLD."acknowledgedServerSequence"
  AND (
    to_jsonb(NEW) - ARRAY['version', 'acknowledgedServerSequence', 'updatedAt']::text[]
  ) = (
    to_jsonb(OLD) - ARRAY['version', 'acknowledgedServerSequence', 'updatedAt']::text[]
  )
)
EXECUTE FUNCTION guard_realtime_mistral_conversation_terminal_ack();

CREATE TRIGGER realtime_mistral_conversation_mission_transition_guard
BEFORE UPDATE ON "realtime_mistral_conversation_missions"
FOR EACH ROW
WHEN (NOT (
  OLD.phase = 'closed'
  AND NEW.phase = 'closed'
  AND NEW."acknowledgedServerSequence" > OLD."acknowledgedServerSequence"
  AND (
    to_jsonb(NEW) - ARRAY['version', 'acknowledgedServerSequence', 'updatedAt']::text[]
  ) = (
    to_jsonb(OLD) - ARRAY['version', 'acknowledgedServerSequence', 'updatedAt']::text[]
  )
))
EXECUTE FUNCTION guard_realtime_mistral_conversation_mission_transition();

ALTER TABLE "realtime_mistral_conversation_resume_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_mistral_conversation_resume_tickets" FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_mistral_conversation_resume_ticket_select
  ON "realtime_mistral_conversation_resume_tickets" FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_mistral_conversation_resume_ticket_insert
  ON "realtime_mistral_conversation_resume_tickets" FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_mistral_conversation_resume_ticket_update
  ON "realtime_mistral_conversation_resume_tickets" FOR UPDATE
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

REVOKE ALL ON TABLE "realtime_mistral_conversation_resume_tickets" FROM PUBLIC;

COMMENT ON COLUMN "realtime_mistral_conversation_missions"."admissionSessionId" IS
  'UUID immuable du bail d admission initial; NULL signifie mission historique non reprenable.';
COMMENT ON TABLE "realtime_mistral_conversation_resume_tickets" IS
  'Capacités one-shot de reprise bob.mistral-pcm.v2, consommées atomiquement avec mission/outbox.';
COMMENT ON COLUMN "realtime_mistral_conversation_resume_tickets"."ticketHash" IS
  'SHA-256 domain-separated du ticket r2 brut; le secret ne doit jamais être persisté ou loggé.';
COMMENT ON COLUMN "realtime_mistral_conversation_resume_tickets"."connectionLeaseTokenHash" IS
  'SHA-256 domain-separated de la capacité ACK terminale propre à une connexion replay_only.';

COMMIT;

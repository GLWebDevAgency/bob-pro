-- Bob Live Mistral Conversation v2 — snapshot CAS, outbox chiffrée et ledger idempotent.
-- Migration EXPAND uniquement : aucune table v1 n'est modifiée et aucun backfill n'est requis.

BEGIN;

CREATE TABLE "realtime_mistral_conversation_missions" (
  "id" UUID NOT NULL,
  "companyId" TEXT NOT NULL,
  "initialBootstrapId" UUID NOT NULL,
  "protocol" TEXT NOT NULL,
  "subjectHash" CHAR(64) NOT NULL,
  "subjectKeyVersion" INTEGER NOT NULL,
  "plan" TEXT NOT NULL,
  "sessionHandle" TEXT NOT NULL,
  "ownerTokenHash" CHAR(64) NOT NULL,
  "ownerAcquiredAt" TIMESTAMPTZ NOT NULL,
  "missionConnectionEpoch" INTEGER NOT NULL,
  "version" BIGINT NOT NULL DEFAULT 1,
  "acknowledgedServerSequence" BIGINT NOT NULL DEFAULT 0,
  "retainedFromServerSequence" BIGINT NOT NULL DEFAULT 0,
  "nextServerSequence" BIGINT NOT NULL,
  "nextProviderSequence" BIGINT NOT NULL DEFAULT 0,
  "snapshotSchemaVersion" INTEGER NOT NULL DEFAULT 1,
  "phase" TEXT NOT NULL,
  "contextRevision" INTEGER NOT NULL,
  "contextDigest" CHAR(64) NOT NULL,
  "routeMode" TEXT NOT NULL,
  "fullDuplexCertified" BOOLEAN NOT NULL,
  "maxMissionAudioBytes" INTEGER NOT NULL,
  "audioBytes" INTEGER NOT NULL DEFAULT 0,
  "missionState" JSONB NOT NULL,
  "turnState" JSONB,
  "finalTranscriptRecorded" BOOLEAN NOT NULL DEFAULT false,
  "terminalReason" TEXT,
  "terminalServerSequence" BIGINT,
  "closedAt" TIMESTAMPTZ,
  "hardExpiresAt" TIMESTAMPTZ NOT NULL,
  "replayGraceExpiresAt" TIMESTAMPTZ NOT NULL,
  "retentionExpiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "realtime_mistral_conversation_missions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "realtime_mistral_conversation_missions_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "realtime_mistral_conversation_missions_bootstrap_key"
    UNIQUE ("initialBootstrapId"),
  CONSTRAINT "realtime_mistral_conversation_missions_owner_token_key"
    UNIQUE ("ownerTokenHash"),
  CONSTRAINT "realtime_mistral_conversation_missions_session_key"
    UNIQUE ("companyId", "sessionHandle"),
  CONSTRAINT "realtime_mistral_conversation_missions_tenant_binding"
    UNIQUE ("id", "companyId", "sessionHandle"),
  CONSTRAINT "realtime_mistral_conversation_missions_protocol_check"
    CHECK ("protocol" = 'bob.mistral-pcm.v2'),
  CONSTRAINT "realtime_mistral_conversation_missions_subject_check"
    CHECK (
      "subjectHash"::TEXT ~ '^[a-f0-9]{64}$'
      AND "subjectKeyVersion" BETWEEN 1 AND 2147483647
    ),
  CONSTRAINT "realtime_mistral_conversation_missions_plan_check"
    CHECK ("plan" IN ('free', 'solo', 'pro', 'business')),
  CONSTRAINT "realtime_mistral_conversation_missions_session_check"
    CHECK (
      length("sessionHandle") BETWEEN 16 AND 128
      AND "sessionHandle" ~ '^[A-Za-z0-9_-]+$'
    ),
  CONSTRAINT "realtime_mistral_conversation_missions_owner_check"
    CHECK ("ownerTokenHash"::TEXT ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "realtime_mistral_conversation_missions_epoch_version_check"
    CHECK (
      "missionConnectionEpoch" BETWEEN 1 AND 2147483647
      AND "version" BETWEEN 1 AND 9007199254740991
      AND "snapshotSchemaVersion" = 1
    ),
  CONSTRAINT "realtime_mistral_conversation_missions_cursor_check"
    CHECK (
      "retainedFromServerSequence" BETWEEN 0 AND 4294967296
      AND "acknowledgedServerSequence" BETWEEN 0 AND 4294967296
      AND "nextServerSequence" BETWEEN 1 AND 4294967296
      AND "nextProviderSequence" BETWEEN 0 AND 4294967296
      AND "retainedFromServerSequence" <= "acknowledgedServerSequence"
      AND "acknowledgedServerSequence" <= "nextServerSequence"
    ),
  CONSTRAINT "realtime_mistral_conversation_missions_phase_check"
    CHECK (
      "phase" IN (
        'ready', 'turn_active', 'response_active', 'recovering_route', 'draining', 'closed'
      )
    ),
  CONSTRAINT "realtime_mistral_conversation_missions_context_check"
    CHECK (
      "contextRevision" BETWEEN 1 AND 2147483647
      AND "contextDigest"::TEXT ~ '^[a-f0-9]{64}$'
    ),
  CONSTRAINT "realtime_mistral_conversation_missions_route_check"
    CHECK (
      "routeMode" IN ('push_to_talk', 'full_duplex')
      AND ("routeMode" <> 'full_duplex' OR "fullDuplexCertified")
    ),
  CONSTRAINT "realtime_mistral_conversation_missions_audio_check"
    CHECK (
      "maxMissionAudioBytes" BETWEEN 320 AND 28800000
      AND "maxMissionAudioBytes" % 320 = 0
      AND "audioBytes" BETWEEN 0 AND "maxMissionAudioBytes"
      AND "audioBytes" % 320 = 0
    ),
  CONSTRAINT "realtime_mistral_conversation_missions_json_check"
    CHECK (
      jsonb_typeof("missionState") = 'object'
      AND pg_column_size("missionState") BETWEEN 2 AND 32768
      AND (
        "turnState" IS NULL
        OR (
          jsonb_typeof("turnState") = 'object'
          AND pg_column_size("turnState") BETWEEN 2 AND 32768
        )
      )
      AND (("phase" IN ('turn_active', 'response_active')) = ("turnState" IS NOT NULL))
      AND (NOT "finalTranscriptRecorded" OR "turnState" IS NOT NULL)
    ),
  CONSTRAINT "realtime_mistral_conversation_missions_state_binding_check"
    CHECK (
      COALESCE(
        "missionState"->>'phase' = "phase"
        AND "missionState"->>'sessionHandle' = "sessionHandle"
        AND ("missionState"->>'missionConnectionEpoch')::INTEGER = "missionConnectionEpoch"
        AND ("missionState"->>'expiresAt')::TIMESTAMPTZ = "hardExpiresAt"
        AND ("missionState"->>'contextRevision')::INTEGER = "contextRevision"
        AND "missionState"->>'contextDigest' = "contextDigest"::TEXT
        AND "missionState"->>'routeMode' = "routeMode"
        AND ("missionState"->>'fullDuplexCertified')::BOOLEAN = "fullDuplexCertified"
        AND ("missionState"->>'maxMissionAudioBytes')::INTEGER = "maxMissionAudioBytes"
        AND ("missionState"->>'audioBytes')::INTEGER = "audioBytes"
        AND (("missionState"->>'drainReason') IS NOT DISTINCT FROM "terminalReason"),
        false
      )
    ),
  CONSTRAINT "realtime_mistral_conversation_missions_terminal_check"
    CHECK (
      (
        "phase" NOT IN ('draining', 'closed')
        AND "terminalReason" IS NULL
        AND "terminalServerSequence" IS NULL
        AND "closedAt" IS NULL
      )
      OR (
        "phase" = 'draining'
        AND "terminalReason" IN (
          'user', 'background', 'context_changed', 'client_handoff',
          'expired', 'service_shutdown', 'fatal_error'
        )
        AND "terminalServerSequence" IS NULL
        AND "closedAt" IS NULL
      )
      OR (
        "phase" = 'closed'
        AND "terminalReason" IN (
          'user', 'background', 'context_changed', 'client_handoff',
          'expired', 'service_shutdown', 'fatal_error'
        )
        AND "terminalServerSequence" BETWEEN 0 AND 4294967295
        AND "terminalServerSequence" = "nextServerSequence" - 1
        AND "closedAt" IS NOT NULL
      )
    ),
  CONSTRAINT "realtime_mistral_conversation_missions_time_check"
    CHECK (
      "hardExpiresAt" > "createdAt"
      AND "replayGraceExpiresAt" > "hardExpiresAt"
      AND "retentionExpiresAt" >= "replayGraceExpiresAt"
      AND "ownerAcquiredAt" >= "createdAt"
      AND "ownerAcquiredAt" < "retentionExpiresAt"
      AND "updatedAt" >= "createdAt"
      AND (
        "closedAt" IS NULL
        OR ("closedAt" >= "createdAt" AND "closedAt" < "retentionExpiresAt")
      )
    )
);

ALTER TABLE "realtime_mistral_conversation_missions" SET (
  fillfactor = 80,
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.05
);

CREATE INDEX "realtime_mistral_conversation_missions_tenant_reaper_idx"
  ON "realtime_mistral_conversation_missions"("companyId", "phase", "hardExpiresAt");
CREATE INDEX "realtime_mistral_conversation_missions_retention_idx"
  ON "realtime_mistral_conversation_missions"("retentionExpiresAt");

CREATE TABLE "realtime_mistral_conversation_outbox" (
  "companyId" TEXT NOT NULL,
  "missionId" UUID NOT NULL,
  "sessionHandle" TEXT NOT NULL,
  "serverSequence" BIGINT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payloadCiphertext" BYTEA NOT NULL,
  "payloadNonce" BYTEA NOT NULL,
  "payloadTag" BYTEA NOT NULL,
  "encryptionKeyVersion" INTEGER NOT NULL,
  "payloadBytes" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "retentionExpiresAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "realtime_mistral_conversation_outbox_sequence"
    PRIMARY KEY ("companyId", "sessionHandle", "serverSequence"),
  CONSTRAINT "realtime_mistral_conversation_outbox_mission_fkey"
    FOREIGN KEY ("missionId", "companyId", "sessionHandle")
    REFERENCES "realtime_mistral_conversation_missions"("id", "companyId", "sessionHandle")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "realtime_mistral_conversation_outbox_sequence_check"
    CHECK ("serverSequence" BETWEEN 0 AND 4294967295),
  CONSTRAINT "realtime_mistral_conversation_outbox_event_type_check"
    CHECK (
      "eventType" IN (
        'session.ready', 'turn.started', 'turn.committed', 'turn.phase',
        'turn.transcript', 'turn.cancelled', 'turn.completed',
        'session.route_recovering', 'session.route_recovered',
        'session.context_updated', 'session.draining', 'session.closed', 'error'
      )
    ),
  CONSTRAINT "realtime_mistral_conversation_outbox_ciphertext_check"
    CHECK (
      "payloadBytes" BETWEEN 1 AND 16384
      AND octet_length("payloadCiphertext") = "payloadBytes"
      AND octet_length("payloadNonce") = 12
      AND octet_length("payloadTag") = 16
      AND "encryptionKeyVersion" BETWEEN 1 AND 2147483647
    ),
  CONSTRAINT "realtime_mistral_conversation_outbox_time_check"
    CHECK ("createdAt" < "retentionExpiresAt")
);

CREATE INDEX "realtime_mistral_conversation_outbox_mission_idx"
  ON "realtime_mistral_conversation_outbox"("missionId", "companyId", "sessionHandle");
CREATE INDEX "realtime_mistral_conversation_outbox_retention_idx"
  ON "realtime_mistral_conversation_outbox"("retentionExpiresAt");

CREATE TABLE "realtime_mistral_conversation_commands" (
  "companyId" TEXT NOT NULL,
  "missionId" UUID NOT NULL,
  "sessionHandle" TEXT NOT NULL,
  "commandIdHash" CHAR(64) NOT NULL,
  "commandType" TEXT NOT NULL,
  "commandPayloadHmac" CHAR(64) NOT NULL,
  "proofKeyVersion" INTEGER NOT NULL,
  "missionConnectionEpoch" INTEGER NOT NULL,
  "snapshotVersionBefore" BIGINT NOT NULL,
  "snapshotVersionAfter" BIGINT NOT NULL,
  "firstServerSequence" BIGINT NOT NULL,
  "eventCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "retentionExpiresAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "realtime_mistral_conversation_command_idempotency"
    PRIMARY KEY ("companyId", "sessionHandle", "commandIdHash"),
  CONSTRAINT "realtime_mistral_conversation_commands_mission_fkey"
    FOREIGN KEY ("missionId", "companyId", "sessionHandle")
    REFERENCES "realtime_mistral_conversation_missions"("id", "companyId", "sessionHandle")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "realtime_mistral_conversation_commands_hash_check"
    CHECK (
      "commandIdHash"::TEXT ~ '^[a-f0-9]{64}$'
      AND "commandPayloadHmac"::TEXT ~ '^[a-f0-9]{64}$'
      AND "proofKeyVersion" BETWEEN 1 AND 2147483647
    ),
  CONSTRAINT "realtime_mistral_conversation_commands_type_check"
    CHECK (
      "commandType" IN (
        'start_turn', 'ingest_audio', 'commit_turn', 'cancel_turn', 'fail_turn',
        'record_transcript', 'advance_phase', 'complete_turn', 'update_context',
        'ack_events', 'record_error', 'drain', 'close'
      )
    ),
  CONSTRAINT "realtime_mistral_conversation_commands_epoch_version_check"
    CHECK (
      "missionConnectionEpoch" BETWEEN 1 AND 2147483647
      AND "snapshotVersionBefore" BETWEEN 1 AND 9007199254740990
      AND "snapshotVersionAfter" = "snapshotVersionBefore" + 1
    ),
  CONSTRAINT "realtime_mistral_conversation_commands_event_range_check"
    CHECK (
      "firstServerSequence" BETWEEN 0 AND 4294967296
      AND "eventCount" BETWEEN 0 AND 16
      AND "firstServerSequence" + "eventCount" <= 4294967296
    ),
  CONSTRAINT "realtime_mistral_conversation_commands_time_check"
    CHECK ("createdAt" < "retentionExpiresAt")
);

CREATE INDEX "realtime_mistral_conversation_commands_mission_idx"
  ON "realtime_mistral_conversation_commands"("missionId", "companyId", "sessionHandle");
CREATE INDEX "realtime_mistral_conversation_commands_retention_idx"
  ON "realtime_mistral_conversation_commands"("retentionExpiresAt");

-- Les champs d'identité et les bornes de rétention sont figés. Une transition avance exactement
-- une version, ne recule jamais un curseur et ne peut changer de route qu'avec un nouvel owner.
CREATE FUNCTION guard_realtime_mistral_conversation_mission_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF ROW(
    NEW.id, NEW."companyId", NEW."initialBootstrapId", NEW.protocol,
    NEW."subjectHash", NEW."subjectKeyVersion", NEW.plan, NEW."sessionHandle",
    NEW."snapshotSchemaVersion", NEW."maxMissionAudioBytes", NEW."hardExpiresAt",
    NEW."replayGraceExpiresAt", NEW."retentionExpiresAt", NEW."createdAt"
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD."companyId", OLD."initialBootstrapId", OLD.protocol,
    OLD."subjectHash", OLD."subjectKeyVersion", OLD.plan, OLD."sessionHandle",
    OLD."snapshotSchemaVersion", OLD."maxMissionAudioBytes", OLD."hardExpiresAt",
    OLD."replayGraceExpiresAt", OLD."retentionExpiresAt", OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'mistral conversation mission authority identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'mistral conversation mission version must advance exactly once'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."updatedAt" < OLD."updatedAt"
    OR NEW."audioBytes" < OLD."audioBytes"
    OR NEW."contextRevision" < OLD."contextRevision"
    OR NEW."acknowledgedServerSequence" < OLD."acknowledgedServerSequence"
    OR NEW."retainedFromServerSequence" < OLD."retainedFromServerSequence"
    OR NEW."nextServerSequence" < OLD."nextServerSequence"
  THEN
    RAISE EXCEPTION 'mistral conversation mission monotone state regressed'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."contextRevision" = OLD."contextRevision"
    AND NEW."contextDigest" IS DISTINCT FROM OLD."contextDigest"
  THEN
    RAISE EXCEPTION 'mistral conversation context digest changed without revision'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."missionConnectionEpoch" NOT IN (
    OLD."missionConnectionEpoch", OLD."missionConnectionEpoch" + 1
  ) THEN
    RAISE EXCEPTION 'mistral conversation owner epoch must stay or advance exactly once'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."missionConnectionEpoch" = OLD."missionConnectionEpoch" + 1 THEN
    IF NEW."ownerTokenHash" IS NOT DISTINCT FROM OLD."ownerTokenHash"
      OR NEW."ownerAcquiredAt" <= OLD."ownerAcquiredAt"
    THEN
      RAISE EXCEPTION 'mistral conversation takeover requires a fresh owner token'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW."ownerTokenHash" IS DISTINCT FROM OLD."ownerTokenHash"
    OR NEW."ownerAcquiredAt" IS DISTINCT FROM OLD."ownerAcquiredAt"
  THEN
    RAISE EXCEPTION 'mistral conversation owner evidence changed without takeover'
      USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW."routeMode", NEW."fullDuplexCertified") IS DISTINCT FROM
     ROW(OLD."routeMode", OLD."fullDuplexCertified")
    AND NEW."missionConnectionEpoch" <> OLD."missionConnectionEpoch" + 1
  THEN
    RAISE EXCEPTION 'mistral conversation route changed outside takeover'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.phase = 'closed' THEN
    RAISE EXCEPTION 'closed mistral conversation mission is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.phase = 'draining' AND NEW.phase NOT IN ('draining', 'closed') THEN
    RAISE EXCEPTION 'draining mistral conversation mission cannot become live'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.phase = 'draining'
    AND (
      NEW."terminalReason" IS DISTINCT FROM OLD."terminalReason"
      OR NEW."missionState"->>'drainCancellationId'
        IS DISTINCT FROM OLD."missionState"->>'drainCancellationId'
    )
  THEN
    RAISE EXCEPTION 'mistral conversation terminal disposition is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."retainedFromServerSequence" > OLD."retainedFromServerSequence"
    AND NEW.phase <> 'closed'
  THEN
    RAISE EXCEPTION 'live mistral conversation history cannot be pruned'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."closedAt" IS NOT NULL AND NEW."closedAt" IS DISTINCT FROM OLD."closedAt" THEN
    RAISE EXCEPTION 'mistral conversation close evidence is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER realtime_mistral_conversation_mission_transition_guard
BEFORE UPDATE ON "realtime_mistral_conversation_missions"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_mistral_conversation_mission_transition();

CREATE FUNCTION guard_realtime_mistral_conversation_mission_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.phase <> 'closed' OR OLD."retentionExpiresAt" > clock_timestamp() THEN
    RAISE EXCEPTION 'live or retained mistral conversation mission cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER realtime_mistral_conversation_mission_delete_guard
BEFORE DELETE ON "realtime_mistral_conversation_missions"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_mistral_conversation_mission_delete();

-- Le lock mission sérialise les répliques avant le calcul du prochain numéro. Le ciphertext est
-- opaque pour PostgreSQL, mais l'AAD applicative lie type, séquence, tenant et taille wire.
CREATE FUNCTION guard_realtime_mistral_conversation_outbox_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  mission_retention timestamptz;
  mission_created timestamptz;
  mission_phase text;
  expected_sequence bigint;
BEGIN
  SELECT mission."retentionExpiresAt", mission."createdAt", mission.phase
    INTO mission_retention, mission_created, mission_phase
    FROM public.realtime_mistral_conversation_missions AS mission
   WHERE mission.id = NEW."missionId"
     AND mission."companyId" = NEW."companyId"
     AND mission."sessionHandle" = NEW."sessionHandle"
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mistral conversation outbox requires a matching mission'
      USING ERRCODE = '23503';
  END IF;
  IF mission_phase = 'closed' THEN
    RAISE EXCEPTION 'closed mistral conversation mission cannot append events'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."retentionExpiresAt" IS DISTINCT FROM mission_retention
    OR NEW."createdAt" < mission_created
  THEN
    RAISE EXCEPTION 'mistral conversation outbox retention binding mismatch'
      USING ERRCODE = '55000';
  END IF;
  SELECT COALESCE(MAX(event."serverSequence") + 1, 0)
    INTO expected_sequence
    FROM public.realtime_mistral_conversation_outbox AS event
   WHERE event."companyId" = NEW."companyId"
     AND event."sessionHandle" = NEW."sessionHandle";
  IF NEW."serverSequence" <> expected_sequence THEN
    RAISE EXCEPTION 'mistral conversation outbox sequence must be contiguous'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER realtime_mistral_conversation_outbox_insert_guard
BEFORE INSERT ON "realtime_mistral_conversation_outbox"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_mistral_conversation_outbox_insert();

CREATE FUNCTION guard_realtime_mistral_conversation_outbox_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'mistral conversation outbox is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."retentionExpiresAt" > clock_timestamp() THEN
    RAISE EXCEPTION 'retained mistral conversation outbox cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER realtime_mistral_conversation_outbox_update_guard
BEFORE UPDATE ON "realtime_mistral_conversation_outbox"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_mistral_conversation_outbox_mutation();
CREATE TRIGGER realtime_mistral_conversation_outbox_delete_guard
BEFORE DELETE ON "realtime_mistral_conversation_outbox"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_mistral_conversation_outbox_mutation();

-- Le ledger est inséré après snapshot + outbox. Il certifie la version et la plage exacte du
-- résultat sans persister commandId, transcript, authorizationHandle ni stagedDeliveryHandle.
CREATE FUNCTION guard_realtime_mistral_conversation_command_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  mission_version bigint;
  mission_epoch integer;
  mission_next_sequence bigint;
  mission_created timestamptz;
  mission_retention timestamptz;
  persisted_events bigint;
  first_event bigint;
  last_event bigint;
BEGIN
  SELECT mission.version, mission."missionConnectionEpoch", mission."nextServerSequence",
         mission."createdAt", mission."retentionExpiresAt"
    INTO mission_version, mission_epoch, mission_next_sequence,
         mission_created, mission_retention
    FROM public.realtime_mistral_conversation_missions AS mission
   WHERE mission.id = NEW."missionId"
     AND mission."companyId" = NEW."companyId"
     AND mission."sessionHandle" = NEW."sessionHandle"
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mistral conversation command requires a matching mission'
      USING ERRCODE = '23503';
  END IF;
  IF NEW."missionConnectionEpoch" <> mission_epoch
    OR NEW."snapshotVersionAfter" <> mission_version
    OR NEW."firstServerSequence" + NEW."eventCount" <> mission_next_sequence
    OR NEW."retentionExpiresAt" IS DISTINCT FROM mission_retention
    OR NEW."createdAt" < mission_created
  THEN
    RAISE EXCEPTION 'mistral conversation command authority binding mismatch'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."eventCount" > 0 THEN
    SELECT COUNT(*), MIN(event."serverSequence"), MAX(event."serverSequence")
      INTO persisted_events, first_event, last_event
      FROM public.realtime_mistral_conversation_outbox AS event
     WHERE event."companyId" = NEW."companyId"
       AND event."sessionHandle" = NEW."sessionHandle"
       AND event."serverSequence" >= NEW."firstServerSequence"
       AND event."serverSequence" < NEW."firstServerSequence" + NEW."eventCount";
    IF persisted_events <> NEW."eventCount"
      OR first_event <> NEW."firstServerSequence"
      OR last_event <> NEW."firstServerSequence" + NEW."eventCount" - 1
    THEN
      RAISE EXCEPTION 'mistral conversation command outbox result is incomplete'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER realtime_mistral_conversation_command_insert_guard
BEFORE INSERT ON "realtime_mistral_conversation_commands"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_mistral_conversation_command_insert();

CREATE FUNCTION guard_realtime_mistral_conversation_command_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'mistral conversation command ledger is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."retentionExpiresAt" > clock_timestamp() THEN
    RAISE EXCEPTION 'retained mistral conversation command cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER realtime_mistral_conversation_command_update_guard
BEFORE UPDATE ON "realtime_mistral_conversation_commands"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_mistral_conversation_command_mutation();
CREATE TRIGGER realtime_mistral_conversation_command_delete_guard
BEFORE DELETE ON "realtime_mistral_conversation_commands"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_mistral_conversation_command_mutation();

-- Vérification différée : création et transition peuvent écrire snapshot et événements dans
-- l'ordre adapté aux locks, mais aucun commit ne peut exposer un trou ou un high-watermark faux.
CREATE FUNCTION assert_realtime_mistral_conversation_outbox_contiguous()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_company text;
  target_session text;
  retained_sequence bigint;
  next_sequence bigint;
  persisted_events bigint;
  first_event bigint;
  last_event bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_company := OLD."companyId";
    target_session := OLD."sessionHandle";
  ELSE
    target_company := NEW."companyId";
    target_session := NEW."sessionHandle";
  END IF;
  SELECT mission."retainedFromServerSequence", mission."nextServerSequence"
    INTO retained_sequence, next_sequence
    FROM public.realtime_mistral_conversation_missions AS mission
   WHERE mission."companyId" = target_company
     AND mission."sessionHandle" = target_session;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT COUNT(*), MIN(event."serverSequence"), MAX(event."serverSequence")
    INTO persisted_events, first_event, last_event
    FROM public.realtime_mistral_conversation_outbox AS event
   WHERE event."companyId" = target_company
     AND event."sessionHandle" = target_session
     AND event."serverSequence" >= retained_sequence;
  IF next_sequence = retained_sequence THEN
    IF persisted_events <> 0 THEN
      RAISE EXCEPTION 'mistral conversation outbox remains beyond retained cursor'
        USING ERRCODE = '55000';
    END IF;
  ELSIF persisted_events <> next_sequence - retained_sequence
    OR first_event <> retained_sequence
    OR last_event <> next_sequence - 1
  THEN
    RAISE EXCEPTION 'mistral conversation outbox is not contiguous at commit'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER realtime_mistral_conversation_mission_outbox_consistency
AFTER INSERT OR UPDATE ON "realtime_mistral_conversation_missions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_realtime_mistral_conversation_outbox_contiguous();

CREATE CONSTRAINT TRIGGER realtime_mistral_conversation_outbox_consistency
AFTER INSERT OR DELETE ON "realtime_mistral_conversation_outbox"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_realtime_mistral_conversation_outbox_contiguous();

ALTER TABLE "realtime_mistral_conversation_missions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_mistral_conversation_missions" FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_mistral_conversation_mission_select
  ON "realtime_mistral_conversation_missions" FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_mistral_conversation_mission_insert
  ON "realtime_mistral_conversation_missions" FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_mistral_conversation_mission_update
  ON "realtime_mistral_conversation_missions" FOR UPDATE
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

ALTER TABLE "realtime_mistral_conversation_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_mistral_conversation_outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_mistral_conversation_outbox_select
  ON "realtime_mistral_conversation_outbox" FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_mistral_conversation_outbox_insert
  ON "realtime_mistral_conversation_outbox" FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

ALTER TABLE "realtime_mistral_conversation_commands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_mistral_conversation_commands" FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_mistral_conversation_command_select
  ON "realtime_mistral_conversation_commands" FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_mistral_conversation_command_insert
  ON "realtime_mistral_conversation_commands" FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

REVOKE ALL ON TABLE
  "realtime_mistral_conversation_missions",
  "realtime_mistral_conversation_outbox",
  "realtime_mistral_conversation_commands"
FROM PUBLIC;

COMMENT ON TABLE "realtime_mistral_conversation_missions" IS
  'Autorité CAS multi-réplique de bob.mistral-pcm.v2; aucun PCM ni transcript dans le snapshot.';
COMMENT ON COLUMN "realtime_mistral_conversation_missions"."ownerTokenHash" IS
  'SHA-256 du token owner aléatoire 256 bits; le token brut ne doit jamais être persisté ou journalisé.';
COMMENT ON TABLE "realtime_mistral_conversation_outbox" IS
  'Événements wire v2 immuables, contigus et chiffrés AES-256-GCM pour replay borné.';
COMMENT ON COLUMN "realtime_mistral_conversation_outbox"."payloadBytes" IS
  'Taille UTF-8 exacte avant chiffrement; utilisée par les budgets replay avant matérialisation.';
COMMENT ON TABLE "realtime_mistral_conversation_commands" IS
  'Ledger idempotent append-only; seulement hash/HMAC et plage outbox, aucune commande brute.';

COMMIT;

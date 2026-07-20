-- Bob Live Mistral Conversation v2 — réconciliation d'un bootstrap initial commité après
-- expiration locale du handshake WSS.
--
-- EXPAND uniquement : `purpose` possède un défaut `standard_resume`, les trois champs de
-- réconciliation sont nullable et toutes les lignes historiques restent strictement soumises
-- au contrat de reprise existant. La RLS et les droits de la table ne sont pas modifiés.

BEGIN;

ALTER TABLE "realtime_mistral_conversation_resume_tickets"
  ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'standard_resume',
  ADD COLUMN "initialBootstrapId" UUID,
  ADD COLUMN "reconciliationAttempt" INTEGER,
  ADD COLUMN "reconciliationKeyVersion" INTEGER;

-- Le FK composite empêche une capacité d'un tenant de pointer, même par SQL direct, vers la
-- preuve bootstrap d'un autre tenant. Les DELETE restent RESTRICT jusqu'à la purge des preuves.
ALTER TABLE "realtime_mistral_conversation_bootstrap_tickets"
  ADD CONSTRAINT "mistral_conversation_bootstrap_tenant_binding"
    UNIQUE (id, "companyId");

ALTER TABLE "realtime_mistral_conversation_resume_tickets"
  ADD CONSTRAINT "mistral_resume_reconciliation_bootstrap_fkey"
    FOREIGN KEY ("initialBootstrapId", "companyId")
    REFERENCES "realtime_mistral_conversation_bootstrap_tickets"(id, "companyId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "mistral_resume_reconciliation_attempt_key"
    UNIQUE ("companyId", "initialBootstrapId", "reconciliationAttempt");

ALTER TABLE "realtime_mistral_conversation_resume_tickets"
  DROP CONSTRAINT "mistral_resume_tickets_protocol_scope_check",
  DROP CONSTRAINT "realtime_mistral_conversation_resume_tickets_fence_check",
  DROP CONSTRAINT "realtime_mistral_conversation_resume_tickets_lifecycle_check";

ALTER TABLE "realtime_mistral_conversation_resume_tickets"
  ADD CONSTRAINT "mistral_resume_tickets_protocol_scope_check"
    CHECK (
      protocol = 'bob.mistral-pcm.v2'
      AND scope IN ('live_takeover', 'terminal_replay')
      AND state IN ('issued', 'consumed')
    ),
  ADD CONSTRAINT "mistral_resume_tickets_purpose_check"
    CHECK (
      purpose IN ('standard_resume', 'initial_bootstrap_reconciliation')
      AND (
        (
          purpose = 'standard_resume'
          AND "initialBootstrapId" IS NULL
          AND "reconciliationAttempt" IS NULL
          AND "reconciliationKeyVersion" IS NULL
          AND "clientAcceptedMissionConnectionEpoch" BETWEEN 1
            AND "expectedMissionConnectionEpoch"
        )
        OR (
          purpose = 'initial_bootstrap_reconciliation'
          AND "initialBootstrapId" IS NOT NULL
          AND "reconciliationAttempt" BETWEEN 1 AND 8
          AND "reconciliationKeyVersion" BETWEEN 1 AND 2147483647
          AND "clientAcceptedMissionConnectionEpoch" = 0
          AND "resumeNextServerSequence" = 0
          AND scope IN ('live_takeover', 'terminal_replay')
        )
      )
    ),
  ADD CONSTRAINT "realtime_mistral_conversation_resume_tickets_fence_check"
    CHECK (
      "expectedMissionConnectionEpoch" BETWEEN 1 AND 2147483647
      AND "clientAcceptedMissionConnectionEpoch" BETWEEN 0
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
  ADD CONSTRAINT "realtime_mistral_conversation_resume_tickets_lifecycle_check"
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
    );

CREATE INDEX "mistral_resume_reconciliation_state_idx"
  ON "realtime_mistral_conversation_resume_tickets"(
    "companyId", "initialBootstrapId", state, "expiresAt"
  );

-- Le bootstrap sérialise toutes les tentatives d'une même ouverture tardive. Les éventuelles
-- capacités antérieures sont ensuite verrouillées avant Mission/admission ; clock_timestamp()
-- n'est lu qu'après ces locks. Une tentative N+1 est possible uniquement si N a été consommée
-- ou a expiré selon l'horloge PostgreSQL. Une même tentative issued/non expirée est ré-derivée
-- par l'adapter : elle ne doit jamais provoquer un second INSERT ni un second secret r2.
CREATE OR REPLACE FUNCTION guard_realtime_mistral_conversation_resume_ticket_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  bootstrap_row public.realtime_mistral_conversation_bootstrap_tickets%ROWTYPE;
  mission_row public.realtime_mistral_conversation_missions%ROWTYPE;
  latest_reconciliation_attempt integer;
  latest_reconciliation_state text;
  latest_reconciliation_expires_at timestamptz;
  latest_reconciliation_expected_epoch integer;
  has_reconciliation_history boolean := false;
  ready_event_count bigint := 0;
  database_now timestamptz;
  admission_state text;
  admission_lease_expires_at timestamptz;
  admission_hard_expires_at timestamptz;
  admission_provider_id text;
  admission_provider_call_id text;
  admission_lease_token_hash text;
BEGIN
  IF NEW.state <> 'issued' OR NEW.version <> 1 THEN
    RAISE EXCEPTION 'resume ticket must be inserted as an unconsumed capability'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.purpose = 'initial_bootstrap_reconciliation' THEN
    -- Lock 1 : preuve bootstrap tenant-bound.
    SELECT * INTO bootstrap_row
      FROM public.realtime_mistral_conversation_bootstrap_tickets AS bootstrap
     WHERE bootstrap.id = NEW."initialBootstrapId"
       AND bootstrap."companyId" = NEW."companyId"
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'bootstrap reconciliation requires an exact tenant bootstrap'
        USING ERRCODE = '23503';
    END IF;

    -- Lock 2 : tout l'historique borné (au plus huit lignes) de ce bootstrap. Le bootstrap
    -- verrouillé empêche une insertion concurrente conforme de passer entre ce scan et l'INSERT.
    PERFORM resume.id
      FROM public.realtime_mistral_conversation_resume_tickets AS resume
     WHERE resume."companyId" = NEW."companyId"
       AND resume."initialBootstrapId" = NEW."initialBootstrapId"
       AND resume.purpose = 'initial_bootstrap_reconciliation'
     ORDER BY resume."reconciliationAttempt", resume.id
     FOR UPDATE;

    SELECT resume."reconciliationAttempt", resume.state, resume."expiresAt",
           resume."expectedMissionConnectionEpoch"
      INTO latest_reconciliation_attempt, latest_reconciliation_state,
           latest_reconciliation_expires_at, latest_reconciliation_expected_epoch
      FROM public.realtime_mistral_conversation_resume_tickets AS resume
     WHERE resume."companyId" = NEW."companyId"
       AND resume."initialBootstrapId" = NEW."initialBootstrapId"
       AND resume.purpose = 'initial_bootstrap_reconciliation'
     ORDER BY resume."reconciliationAttempt" DESC
     LIMIT 1;
    has_reconciliation_history := FOUND;
  END IF;

  -- Lock 3 : snapshot Mission exact.
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

  IF NEW.purpose = 'initial_bootstrap_reconciliation' THEN
    SELECT COUNT(*)
      INTO ready_event_count
      FROM public.realtime_mistral_conversation_outbox AS event
     WHERE event."companyId" = NEW."companyId"
       AND event."missionId" = NEW."missionId"
       AND event."sessionHandle" = NEW."sessionHandle"
       AND event."serverSequence" = 0
       AND event."eventType" = 'session.ready';
  END IF;

  -- Lock 4 : admission uniquement lorsque le ticket ouvre un takeover live. Une reprise
  -- terminale n'en dépend volontairement pas : le bail peut déjà avoir été supprimé après la
  -- fermeture durable, tandis que bootstrap + Mission + session.ready restent retenus jusqu'à G.
  IF NEW.scope = 'live_takeover' THEN
    SELECT admission.state, admission."leaseExpiresAt", admission."hardExpiresAt",
           admission."providerId", admission."providerCallId", admission."leaseTokenHash"
      INTO admission_state, admission_lease_expires_at, admission_hard_expires_at,
           admission_provider_id, admission_provider_call_id, admission_lease_token_hash
      FROM public.realtime_session_leases AS admission
     WHERE admission."companyId" = NEW."companyId"
       AND admission."subjectHash" = NEW."subjectHash"
       AND admission."sessionId" = NEW."admissionSessionId"
     FOR UPDATE;
  END IF;

  -- Horloge d'autorité lue après tous les locks canoniques.
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

  IF NEW.purpose = 'initial_bootstrap_reconciliation' THEN
    -- L'égalité de retentionExpiresAt est un couplage fail-closed intentionnel. Bootstrap et
    -- Mission sont deux preuves du même acte atomique et doivent partager l'horizon de rétention.
    -- Toute évolution séparée de bootstrap retentionSeconds ou durable replayGraceMs doit donc
    -- casser cette garde et forcer une migration/revue explicite, jamais élargir silencieusement.
    IF bootstrap_row.state IS DISTINCT FROM 'consumed'
      OR bootstrap_row.version <> 2
      OR bootstrap_row."consumedAt" IS NULL
      OR NEW."issuedAt" < bootstrap_row."consumedAt"
      OR bootstrap_row."admissionSessionId" IS DISTINCT FROM NEW."admissionSessionId"
      OR bootstrap_row."sessionHandle" IS DISTINCT FROM NEW."sessionHandle"
      OR bootstrap_row.protocol IS DISTINCT FROM NEW.protocol
      OR bootstrap_row."subjectHash" IS DISTINCT FROM NEW."subjectHash"
      OR bootstrap_row."subjectKeyVersion" IS DISTINCT FROM NEW."subjectKeyVersion"
      OR bootstrap_row.plan IS DISTINCT FROM NEW.plan
      OR bootstrap_row."contextRevision" IS DISTINCT FROM NEW."contextRevision"
      OR bootstrap_row."contextDigest" IS DISTINCT FROM NEW."contextDigest"
      OR bootstrap_row."routeMode" IS DISTINCT FROM NEW."routeMode"
      OR bootstrap_row."fullDuplexCertified" IS DISTINCT FROM NEW."fullDuplexCertified"
      OR bootstrap_row."maxMissionAudioBytes" IS DISTINCT FROM NEW."maxMissionAudioBytes"
      OR bootstrap_row."hardExpiresAt" IS DISTINCT FROM NEW."hardExpiresAt"
      OR bootstrap_row."retentionExpiresAt" IS DISTINCT FROM NEW."retentionExpiresAt"
      OR mission_row."initialBootstrapId" IS DISTINCT FROM NEW."initialBootstrapId"
      OR ready_event_count <> 1
    THEN
      RAISE EXCEPTION 'bootstrap reconciliation lost its exact consumed bootstrap evidence'
        USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_resume_tickets AS resume
       WHERE resume."companyId" = NEW."companyId"
         AND resume."initialBootstrapId" = NEW."initialBootstrapId"
         AND resume.purpose = 'initial_bootstrap_reconciliation'
         AND resume.state = 'issued'
         AND resume."expiresAt" > database_now
         AND resume."expectedMissionConnectionEpoch"
           = mission_row."missionConnectionEpoch"
    ) THEN
      RAISE EXCEPTION 'bootstrap reconciliation already has a live issued capability'
        USING ERRCODE = '55000';
    END IF;

    IF NOT has_reconciliation_history THEN
      IF NEW."reconciliationAttempt" <> 1 THEN
        RAISE EXCEPTION 'first bootstrap reconciliation attempt must be one'
          USING ERRCODE = '55000';
      END IF;
    ELSIF NEW."reconciliationAttempt" <> latest_reconciliation_attempt + 1
      OR NOT (
        latest_reconciliation_state = 'consumed'
        OR (
          latest_reconciliation_state = 'issued'
          AND (
            latest_reconciliation_expires_at <= database_now
            OR latest_reconciliation_expected_epoch
              <> mission_row."missionConnectionEpoch"
          )
        )
      )
    THEN
      RAISE EXCEPTION 'bootstrap reconciliation attempts must be contiguous and settled'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.scope = 'live_takeover' THEN
    IF admission_state IS DISTINCT FROM 'active'
      OR admission_lease_expires_at <= database_now
      OR admission_hard_expires_at <= database_now
      OR database_now >= mission_row."hardExpiresAt"
      OR (
        NEW.purpose = 'initial_bootstrap_reconciliation'
        AND (
          mission_row.phase <> 'ready'
          OR admission_provider_id IS DISTINCT FROM 'mistral'
          OR admission_provider_call_id IS DISTINCT FROM
            'mcv2:' || NEW."initialBootstrapId"::TEXT
          OR admission_lease_token_hash IS DISTINCT FROM
            bootstrap_row."admissionLeaseTokenHash"::TEXT
        )
      )
      OR (
        NEW.purpose = 'standard_resume'
        AND mission_row.phase NOT IN ('ready', 'turn_active', 'response_active')
      )
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

-- Le redeem spécial doit avoir pré-verrouillé bootstrap puis resume dans sa transaction. Le
-- trigger revalide ensuite la preuve bootstrap avant Mission/admission et lit l'horloge en dernier.
-- La transition reste strictement issued(v1) -> consumed(v2), y compris pour le purpose spécial.
CREATE OR REPLACE FUNCTION guard_realtime_mistral_conversation_resume_ticket_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  bootstrap_row public.realtime_mistral_conversation_bootstrap_tickets%ROWTYPE;
  mission_row public.realtime_mistral_conversation_missions%ROWTYPE;
  ready_event_count bigint := 0;
  database_now timestamptz;
  admission_state text;
  admission_lease_expires_at timestamptz;
  admission_hard_expires_at timestamptz;
  admission_provider_id text;
  admission_provider_call_id text;
  admission_lease_token_hash text;
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

  IF OLD.purpose = 'initial_bootstrap_reconciliation' THEN
    SELECT * INTO bootstrap_row
      FROM public.realtime_mistral_conversation_bootstrap_tickets AS bootstrap
     WHERE bootstrap.id = OLD."initialBootstrapId"
       AND bootstrap."companyId" = OLD."companyId"
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'bootstrap reconciliation consumption lost its bootstrap binding'
        USING ERRCODE = '23503';
    END IF;
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

  IF OLD.purpose = 'initial_bootstrap_reconciliation' THEN
    SELECT COUNT(*)
      INTO ready_event_count
      FROM public.realtime_mistral_conversation_outbox AS event
     WHERE event."companyId" = OLD."companyId"
       AND event."missionId" = OLD."missionId"
       AND event."sessionHandle" = OLD."sessionHandle"
       AND event."serverSequence" = 0
       AND event."eventType" = 'session.ready';
  END IF;

  -- Même asymétrie qu'à l'émission : terminal_replay ne relit pas admission, dont la suppression
  -- après close est légitime. Le chemin live, lui, exige toujours le bail exact et encore actif.
  IF OLD.scope = 'live_takeover' THEN
    SELECT admission.state, admission."leaseExpiresAt", admission."hardExpiresAt",
           admission."providerId", admission."providerCallId", admission."leaseTokenHash"
      INTO admission_state, admission_lease_expires_at, admission_hard_expires_at,
           admission_provider_id, admission_provider_call_id, admission_lease_token_hash
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

  IF OLD.purpose = 'initial_bootstrap_reconciliation' THEN
    IF bootstrap_row.state IS DISTINCT FROM 'consumed'
      OR bootstrap_row.version <> 2
      OR bootstrap_row."consumedAt" IS NULL
      OR bootstrap_row."admissionSessionId" IS DISTINCT FROM OLD."admissionSessionId"
      OR bootstrap_row."sessionHandle" IS DISTINCT FROM OLD."sessionHandle"
      OR bootstrap_row.protocol IS DISTINCT FROM OLD.protocol
      OR bootstrap_row."subjectHash" IS DISTINCT FROM OLD."subjectHash"
      OR bootstrap_row."subjectKeyVersion" IS DISTINCT FROM OLD."subjectKeyVersion"
      OR bootstrap_row.plan IS DISTINCT FROM OLD.plan
      OR bootstrap_row."contextRevision" IS DISTINCT FROM OLD."contextRevision"
      OR bootstrap_row."contextDigest" IS DISTINCT FROM OLD."contextDigest"
      OR bootstrap_row."routeMode" IS DISTINCT FROM OLD."routeMode"
      OR bootstrap_row."fullDuplexCertified" IS DISTINCT FROM OLD."fullDuplexCertified"
      OR bootstrap_row."maxMissionAudioBytes" IS DISTINCT FROM OLD."maxMissionAudioBytes"
      OR bootstrap_row."hardExpiresAt" IS DISTINCT FROM OLD."hardExpiresAt"
      OR bootstrap_row."retentionExpiresAt" IS DISTINCT FROM OLD."retentionExpiresAt"
      OR mission_row."initialBootstrapId" IS DISTINCT FROM OLD."initialBootstrapId"
      OR ready_event_count <> 1
    THEN
      RAISE EXCEPTION 'bootstrap reconciliation consumption lost its exact bootstrap evidence'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF OLD.scope = 'live_takeover' THEN
    IF admission_state IS DISTINCT FROM 'active'
      OR admission_lease_expires_at <= database_now
      OR admission_hard_expires_at <= database_now
      OR database_now >= mission_row."hardExpiresAt"
      OR mission_row."missionConnectionEpoch" <> OLD."expectedMissionConnectionEpoch" + 1
      OR mission_row.phase <> 'ready'
      OR (
        OLD.purpose = 'initial_bootstrap_reconciliation'
        AND (
          admission_provider_id IS DISTINCT FROM 'mistral'
          OR admission_provider_call_id IS DISTINCT FROM
            'mcv2:' || OLD."initialBootstrapId"::TEXT
          OR admission_lease_token_hash IS DISTINCT FROM
            bootstrap_row."admissionLeaseTokenHash"::TEXT
        )
      )
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

COMMENT ON COLUMN "realtime_mistral_conversation_resume_tickets".purpose IS
  'standard_resume conserve le contrat historique; initial_bootstrap_reconciliation répare uniquement une ouverture initiale commitée sans réponse WSS.';
COMMENT ON COLUMN "realtime_mistral_conversation_resume_tickets"."initialBootstrapId" IS
  'Preuve bootstrap tenant-bound obligatoire uniquement pour une réconciliation initiale.';
COMMENT ON COLUMN "realtime_mistral_conversation_resume_tickets"."reconciliationAttempt" IS
  'Tentative déterministe 1..8; une tentative issued/non expirée est restituée, jamais dupliquée.';
COMMENT ON COLUMN "realtime_mistral_conversation_resume_tickets"."reconciliationKeyVersion" IS
  'Version de clé retenue pour re-dériver exactement le même r2 sans persister le secret brut.';

COMMIT;

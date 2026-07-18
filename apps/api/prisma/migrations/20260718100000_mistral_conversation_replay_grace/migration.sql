-- Bob Live Mistral Conversation v2 — grâce terminale bornée par l'horloge PostgreSQL.
--
-- H = hardExpiresAt : aucune commande métier ni reprise live à partir de cette borne.
-- G = replayGraceExpiresAt : seules la terminalisation déterministe et les ACK exacts restent
-- possibles dans [H, G[. Après G, seul le reaper privilégié peut purger les données arrivées
-- à retentionExpiresAt. La migration d'origine reste immuable : les triggers existants gardent
-- leurs OID et reçoivent ici une définition plus stricte via CREATE OR REPLACE FUNCTION.

BEGIN;

-- La borne maximale appartient au modèle de persistance, pas au seul adapter. Le rôle runtime
-- possède INSERT ; sans ce CHECK, un chemin SQL direct pourrait retenir une mission au-delà de
-- la fenêtre que le gateway est capable de certifier.
ALTER TABLE "realtime_mistral_conversation_missions"
  ADD CONSTRAINT "realtime_mistral_conversation_missions_replay_grace_max_check"
  CHECK ("replayGraceExpiresAt" <= "hardExpiresAt" + interval '7 days');

CREATE OR REPLACE FUNCTION guard_realtime_mistral_conversation_mission_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  database_now timestamptz;
  transition_event_count bigint;
  transition_event_types text[];
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

  -- clock_timestamp(), et non now(), est l'autorité de la borne. Il est lu dans le trigger,
  -- après l'acquisition du verrou UPDATE, pour qu'une attente de lock ne puisse pas prolonger H.
  database_now := clock_timestamp();

  IF database_now >= OLD."replayGraceExpiresAt" THEN
    RAISE EXCEPTION 'mistral conversation replay grace has expired'
      USING ERRCODE = '55000';
  END IF;

  IF database_now >= OLD."hardExpiresAt" THEN
    -- ACK terminal exact : aucun champ autre que version, curseur ACK et updatedAt ne bouge.
    -- Le curseur doit réellement avancer ; les ACK identiques restent des no-op applicatifs.
    IF NEW."acknowledgedServerSequence" > OLD."acknowledgedServerSequence"
      AND (
        to_jsonb(NEW)
          - ARRAY['version', 'acknowledgedServerSequence', 'updatedAt']::text[]
      ) = (
        to_jsonb(OLD)
          - ARRAY['version', 'acknowledgedServerSequence', 'updatedAt']::text[]
      )
    THEN
      RETURN NEW;
    END IF;

    -- Une mission encore live à H est fermée sans takeover : owner, epoch, contexte, route et
    -- compteur audio restent figés. Un tour actif produit d'abord turn.cancelled, puis le drain.
    IF OLD.phase IN ('ready', 'turn_active', 'response_active', 'recovering_route')
      AND NEW.phase = 'draining'
    THEN
      IF NEW."terminalReason" IS DISTINCT FROM 'expired'
        OR NEW."missionState"->>'phase' IS DISTINCT FROM 'draining'
        OR NEW."missionState"->>'drainReason' IS DISTINCT FROM 'expired'
        OR NEW."missionState"->'activeTurn' IS DISTINCT FROM 'null'::jsonb
        OR NEW."turnState" IS NOT NULL
        OR NEW."finalTranscriptRecorded"
        OR NEW."nextProviderSequence" <> 0
        -- DRAIN ne peut modifier que ces sept clés de la machine pure. Retirer toute la colonne
        -- missionState de la comparaison laisserait un SQL direct falsifier contexte, audio,
        -- ordinal, route ou preuves de recovery tout en satisfaisant state_binding_check.
        OR (
          NEW."missionState" - ARRAY[
            'phase', 'cancellationGeneration', 'activeTurn', 'lastTerminalTurn',
            'lastCancellationId', 'drainCancellationId', 'drainReason'
          ]::text[]
        ) IS DISTINCT FROM (
          OLD."missionState" - ARRAY[
            'phase', 'cancellationGeneration', 'activeTurn', 'lastTerminalTurn',
            'lastCancellationId', 'drainCancellationId', 'drainReason'
          ]::text[]
        )
        OR (
          to_jsonb(NEW) - ARRAY[
            'version', 'nextServerSequence', 'nextProviderSequence', 'phase',
            'missionState', 'turnState', 'finalTranscriptRecorded', 'terminalReason',
            'updatedAt'
          ]::text[]
        ) IS DISTINCT FROM (
          to_jsonb(OLD) - ARRAY[
            'version', 'nextServerSequence', 'nextProviderSequence', 'phase',
            'missionState', 'turnState', 'finalTranscriptRecorded', 'terminalReason',
            'updatedAt'
          ]::text[]
        )
      THEN
        RAISE EXCEPTION 'hard-expired mistral conversation mission requires an exact expired drain'
          USING ERRCODE = '55000';
      END IF;

      IF OLD."turnState" IS NULL THEN
        -- ready/recovering_route : aucun artefact de cancellation ne peut être inventé.
        IF OLD."missionState"->'activeTurn' IS DISTINCT FROM 'null'::jsonb
          OR NEW."missionState"->'cancellationGeneration'
            IS DISTINCT FROM OLD."missionState"->'cancellationGeneration'
          OR NEW."missionState"->'lastTerminalTurn'
            IS DISTINCT FROM OLD."missionState"->'lastTerminalTurn'
          OR NEW."missionState"->'lastCancellationId'
            IS DISTINCT FROM OLD."missionState"->'lastCancellationId'
          OR NEW."missionState"->'drainCancellationId' IS DISTINCT FROM 'null'::jsonb
        THEN
          RAISE EXCEPTION 'expired idle drain cannot invent cancellation evidence'
            USING ERRCODE = '55000';
        END IF;
      ELSE
        -- turn_active/response_active : le reducer incrémente exactement la génération et dérive
        -- la preuve terminale du tour actif avec un unique UUID de cancellation.
        IF jsonb_typeof(OLD."missionState"->'activeTurn') IS DISTINCT FROM 'object'
          OR (NEW."missionState"->>'cancellationGeneration')::integer
            IS DISTINCT FROM (OLD."missionState"->>'cancellationGeneration')::integer + 1
          OR NOT COALESCE(
            NEW."missionState"->>'drainCancellationId' ~
              '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
            false
          )
          OR NEW."missionState"->>'lastCancellationId'
            IS DISTINCT FROM NEW."missionState"->>'drainCancellationId'
          OR NEW."missionState"->'lastTerminalTurn' IS DISTINCT FROM jsonb_build_object(
            'clientTurnId', OLD."missionState"->'activeTurn'->>'clientTurnId',
            'turnId', OLD."missionState"->'activeTurn'->>'turnId',
            'ordinal', OLD."missionState"->'activeTurn'->'ordinal',
            'outcome', 'cancelled',
            'cancellationId', NEW."missionState"->>'drainCancellationId'
          )
        THEN
          RAISE EXCEPTION 'expired active drain cancellation evidence is not reducer-canonical'
            USING ERRCODE = '55000';
        END IF;
      END IF;

      SELECT COUNT(*), ARRAY_AGG(event."eventType" ORDER BY event."serverSequence")
        INTO transition_event_count, transition_event_types
        FROM public.realtime_mistral_conversation_outbox AS event
       WHERE event."companyId" = OLD."companyId"
         AND event."sessionHandle" = OLD."sessionHandle"
         AND event."serverSequence" >= OLD."nextServerSequence"
         AND event."serverSequence" < NEW."nextServerSequence";

      IF OLD."turnState" IS NULL THEN
        IF NEW."nextServerSequence" <> OLD."nextServerSequence" + 1
          OR transition_event_count <> 1
          OR transition_event_types IS DISTINCT FROM ARRAY['session.draining']::text[]
        THEN
          RAISE EXCEPTION 'expired drain requires exactly one session.draining event'
            USING ERRCODE = '55000';
        END IF;
      ELSIF NEW."nextServerSequence" <> OLD."nextServerSequence" + 2
        OR transition_event_count <> 2
        OR transition_event_types IS DISTINCT FROM
          ARRAY['turn.cancelled', 'session.draining']::text[]
      THEN
        RAISE EXCEPTION 'expired active turn requires turn.cancelled then session.draining'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END IF;

    -- Un drain engagé avant H garde sa disposition (user/background/etc.). La fermeture ne peut
    -- que changer la phase, ajouter session.closed et graver les preuves terminales.
    IF OLD.phase = 'draining' AND NEW.phase = 'closed' THEN
      IF NEW."terminalReason" IS DISTINCT FROM OLD."terminalReason"
        OR NEW."missionState"->>'phase' IS DISTINCT FROM 'closed'
        OR (NEW."missionState" - 'phase') IS DISTINCT FROM (OLD."missionState" - 'phase')
        OR NEW."nextServerSequence" <> OLD."nextServerSequence" + 1
        OR NEW."terminalServerSequence" IS DISTINCT FROM OLD."nextServerSequence"
        OR NEW."closedAt" IS NULL
        OR (
          to_jsonb(NEW) - ARRAY[
            'version', 'nextServerSequence', 'phase', 'missionState',
            'terminalServerSequence', 'closedAt', 'updatedAt'
          ]::text[]
        ) IS DISTINCT FROM (
          to_jsonb(OLD) - ARRAY[
            'version', 'nextServerSequence', 'phase', 'missionState',
            'terminalServerSequence', 'closedAt', 'updatedAt'
          ]::text[]
        )
      THEN
        RAISE EXCEPTION 'hard-expired draining mission requires an exact terminal close'
          USING ERRCODE = '55000';
      END IF;

      SELECT COUNT(*), ARRAY_AGG(event."eventType" ORDER BY event."serverSequence")
        INTO transition_event_count, transition_event_types
        FROM public.realtime_mistral_conversation_outbox AS event
       WHERE event."companyId" = OLD."companyId"
         AND event."sessionHandle" = OLD."sessionHandle"
         AND event."serverSequence" >= OLD."nextServerSequence"
         AND event."serverSequence" < NEW."nextServerSequence";
      IF transition_event_count <> 1
        OR transition_event_types IS DISTINCT FROM ARRAY['session.closed']::text[]
      THEN
        RAISE EXCEPTION 'terminal close requires exactly one session.closed event'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'hard-expired mistral conversation mission only permits terminal drain, close or ACK'
      USING ERRCODE = '55000';
  END IF;

  -- Avant H, comportement v2 d'origine : lease/epoch, route et disposition terminale restent
  -- régis par la même machine stricte.
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

CREATE OR REPLACE FUNCTION guard_realtime_mistral_conversation_mission_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Les droits SQL et FORCE RLS réservent DELETE au reaper privilégié. À la rétention, celui-ci
  -- doit aussi pouvoir purger une mission abandonnée avant sa fermeture (crash permanent).
  IF OLD."retentionExpiresAt" > clock_timestamp() THEN
    RAISE EXCEPTION 'retained mistral conversation mission cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION guard_realtime_mistral_conversation_outbox_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  mission_retention timestamptz;
  mission_created timestamptz;
  mission_hard_expires_at timestamptz;
  mission_replay_grace_expires_at timestamptz;
  mission_phase text;
  mission_next_sequence bigint;
  mission_has_turn boolean;
  expected_sequence bigint;
  database_now timestamptz;
BEGIN
  SELECT mission."retentionExpiresAt", mission."createdAt", mission."hardExpiresAt",
         mission."replayGraceExpiresAt", mission.phase, mission."nextServerSequence",
         mission."turnState" IS NOT NULL
    INTO mission_retention, mission_created, mission_hard_expires_at,
         mission_replay_grace_expires_at, mission_phase, mission_next_sequence,
         mission_has_turn
    FROM public.realtime_mistral_conversation_missions AS mission
   WHERE mission.id = NEW."missionId"
     AND mission."companyId" = NEW."companyId"
     AND mission."sessionHandle" = NEW."sessionHandle"
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mistral conversation outbox requires a matching mission'
      USING ERRCODE = '23503';
  END IF;

  database_now := clock_timestamp();
  IF database_now >= mission_replay_grace_expires_at THEN
    RAISE EXCEPTION 'mistral conversation outbox replay grace has expired'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(MAX(event."serverSequence") + 1, 0)
    INTO expected_sequence
    FROM public.realtime_mistral_conversation_outbox AS event
   WHERE event."companyId" = NEW."companyId"
     AND event."sessionHandle" = NEW."sessionHandle";

  IF database_now >= mission_hard_expires_at THEN
    -- Dans [H,G[, la séquence terminale est la seule écriture d'événement possible.
    IF mission_phase IN ('turn_active', 'response_active') AND mission_has_turn THEN
      IF NOT (
        (expected_sequence = mission_next_sequence AND NEW."eventType" = 'turn.cancelled')
        OR (
          expected_sequence = mission_next_sequence + 1
          AND NEW."eventType" = 'session.draining'
        )
      ) THEN
        RAISE EXCEPTION 'expired active turn outbox requires turn.cancelled then session.draining'
          USING ERRCODE = '55000';
      END IF;
    ELSIF mission_phase IN ('ready', 'recovering_route') AND NOT mission_has_turn THEN
      IF expected_sequence <> mission_next_sequence OR NEW."eventType" <> 'session.draining' THEN
        RAISE EXCEPTION 'expired live mission outbox requires session.draining'
          USING ERRCODE = '55000';
      END IF;
    ELSIF mission_phase = 'draining' AND NOT mission_has_turn THEN
      IF expected_sequence <> mission_next_sequence OR NEW."eventType" <> 'session.closed' THEN
        RAISE EXCEPTION 'expired draining mission outbox requires session.closed'
          USING ERRCODE = '55000';
      END IF;
    ELSE
      RAISE EXCEPTION 'hard-expired mistral conversation outbox is terminal-only'
        USING ERRCODE = '55000';
    END IF;
  ELSIF mission_phase = 'closed' THEN
    RAISE EXCEPTION 'closed mistral conversation mission cannot append events'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."retentionExpiresAt" IS DISTINCT FROM mission_retention
    OR NEW."createdAt" < mission_created
  THEN
    RAISE EXCEPTION 'mistral conversation outbox retention binding mismatch'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."serverSequence" <> expected_sequence THEN
    RAISE EXCEPTION 'mistral conversation outbox sequence must be contiguous'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_realtime_mistral_conversation_command_insert()
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
  mission_hard_expires_at timestamptz;
  mission_replay_grace_expires_at timestamptz;
  mission_phase text;
  mission_terminal_reason text;
  persisted_events bigint;
  first_event bigint;
  last_event bigint;
  persisted_event_types text[];
  database_now timestamptz;
BEGIN
  SELECT mission.version, mission."missionConnectionEpoch", mission."nextServerSequence",
         mission."createdAt", mission."retentionExpiresAt", mission."hardExpiresAt",
         mission."replayGraceExpiresAt", mission.phase, mission."terminalReason"
    INTO mission_version, mission_epoch, mission_next_sequence,
         mission_created, mission_retention, mission_hard_expires_at,
         mission_replay_grace_expires_at, mission_phase, mission_terminal_reason
    FROM public.realtime_mistral_conversation_missions AS mission
   WHERE mission.id = NEW."missionId"
     AND mission."companyId" = NEW."companyId"
     AND mission."sessionHandle" = NEW."sessionHandle"
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mistral conversation command requires a matching mission'
      USING ERRCODE = '23503';
  END IF;

  database_now := clock_timestamp();
  IF database_now >= mission_replay_grace_expires_at THEN
    RAISE EXCEPTION 'mistral conversation command replay grace has expired'
      USING ERRCODE = '55000';
  END IF;
  IF database_now >= mission_hard_expires_at THEN
    -- L'ACK terminal est durable dans le curseur de mission, mais volontairement absent du
    -- ledger : sans historique de delta, une ligne ACK greffée après coup ne peut pas être liée
    -- cryptographiquement à la transition qui a réellement avancé le curseur. Son idempotence
    -- est donc monotone dans l'adapter (ACK <= curseur courant), jamais simulée par une ligne.
    IF NEW."commandType" = 'ack_events' THEN
      RAISE EXCEPTION 'terminal ACK commands are not persisted in the command ledger'
        USING ERRCODE = '55000';
    ELSIF NEW."commandType" = 'drain' THEN
      IF mission_phase <> 'draining'
        OR mission_terminal_reason IS DISTINCT FROM 'expired'
        OR NEW."eventCount" NOT IN (1, 2)
      THEN
        RAISE EXCEPTION 'hard-expired drain command must persist the expired disposition'
          USING ERRCODE = '55000';
      END IF;
    ELSIF NEW."commandType" = 'close' THEN
      IF mission_phase <> 'closed' OR NEW."eventCount" <> 1 THEN
        RAISE EXCEPTION 'terminal close command must persist exactly one close event'
          USING ERRCODE = '55000';
      END IF;
    ELSE
      RAISE EXCEPTION 'hard-expired mistral conversation command is forbidden'
        USING ERRCODE = '55000';
    END IF;
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
    SELECT COUNT(*), MIN(event."serverSequence"), MAX(event."serverSequence"),
           ARRAY_AGG(event."eventType" ORDER BY event."serverSequence")
      INTO persisted_events, first_event, last_event, persisted_event_types
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
    IF database_now >= mission_hard_expires_at
      AND NEW."commandType" = 'drain'
      AND persisted_event_types NOT IN (
        ARRAY['session.draining']::text[],
        ARRAY['turn.cancelled', 'session.draining']::text[]
      )
    THEN
      RAISE EXCEPTION 'expired drain command events are not terminal-canonical'
        USING ERRCODE = '55000';
    END IF;
    IF database_now >= mission_hard_expires_at
      AND NEW."commandType" = 'close'
      AND persisted_event_types IS DISTINCT FROM ARRAY['session.closed']::text[]
    THEN
      RAISE EXCEPTION 'close command event is not terminal-canonical'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;

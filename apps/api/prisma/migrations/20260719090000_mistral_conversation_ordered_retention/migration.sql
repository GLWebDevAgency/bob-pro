-- Bob Live Mistral v2 — purge atomique enfants -> Mission -> bootstrap.
-- Les artefacts speech, contrôles, usages/facturation et événements d'admission possèdent une
-- rétention distincte et sont volontairement absents de cette autorité.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Le rôle global ne reçoit aucun contexte tenant. Chaque policy ouvre uniquement les groupes
-- arrivés après grâce ET rétention ; DELETE reste plus étroit que SELECT d'observabilité.
CREATE POLICY realtime_mistral_conversation_mission_reaper_select
  ON "realtime_mistral_conversation_missions" FOR SELECT
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND "replayGraceExpiresAt" <= clock_timestamp()
    AND "retentionExpiresAt" <= clock_timestamp()
  );
CREATE POLICY realtime_mistral_conversation_mission_reaper_lock
  ON "realtime_mistral_conversation_missions" FOR UPDATE
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND phase = 'closed'
    AND "replayGraceExpiresAt" <= clock_timestamp()
    AND "retentionExpiresAt" <= clock_timestamp()
  )
  WITH CHECK (false);
CREATE POLICY realtime_mistral_conversation_mission_reaper_delete
  ON "realtime_mistral_conversation_missions" FOR DELETE
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND phase = 'closed'
    AND "replayGraceExpiresAt" <= clock_timestamp()
    AND "retentionExpiresAt" <= clock_timestamp()
  );

CREATE POLICY realtime_mistral_conversation_resume_reaper_select
  ON "realtime_mistral_conversation_resume_tickets" FOR SELECT
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission.id = realtime_mistral_conversation_resume_tickets."missionId"
         AND mission."companyId" = realtime_mistral_conversation_resume_tickets."companyId"
         AND mission."sessionHandle" = realtime_mistral_conversation_resume_tickets."sessionHandle"
         AND mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  );
-- SELECT/lock voit volontairement aussi un enfant dont la rétention expire plus tard que sa
-- Mission. Sans cette visibilité sous FORCE RLS, la CASCADE pourrait masquer puis supprimer
-- l'enfant avant que l'invariant de groupe ne bloque la purge.
CREATE POLICY realtime_mistral_conversation_resume_reaper_lock
  ON "realtime_mistral_conversation_resume_tickets" FOR UPDATE
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission.id = realtime_mistral_conversation_resume_tickets."missionId"
         AND mission."companyId" = realtime_mistral_conversation_resume_tickets."companyId"
         AND mission."sessionHandle" = realtime_mistral_conversation_resume_tickets."sessionHandle"
         AND mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  )
  WITH CHECK (false);
CREATE POLICY realtime_mistral_conversation_resume_reaper_delete
  ON "realtime_mistral_conversation_resume_tickets" FOR DELETE
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND realtime_mistral_conversation_resume_tickets."retentionExpiresAt" <= clock_timestamp()
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission.id = realtime_mistral_conversation_resume_tickets."missionId"
         AND mission."companyId" = realtime_mistral_conversation_resume_tickets."companyId"
         AND mission."sessionHandle" = realtime_mistral_conversation_resume_tickets."sessionHandle"
         AND mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  );

CREATE POLICY realtime_mistral_conversation_outbox_reaper_select
  ON "realtime_mistral_conversation_outbox" FOR SELECT
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission.id = realtime_mistral_conversation_outbox."missionId"
         AND mission."companyId" = realtime_mistral_conversation_outbox."companyId"
         AND mission."sessionHandle" = realtime_mistral_conversation_outbox."sessionHandle"
         AND mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  );
CREATE POLICY realtime_mistral_conversation_outbox_reaper_delete
  ON "realtime_mistral_conversation_outbox" FOR DELETE
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND realtime_mistral_conversation_outbox."retentionExpiresAt" <= clock_timestamp()
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission.id = realtime_mistral_conversation_outbox."missionId"
         AND mission."companyId" = realtime_mistral_conversation_outbox."companyId"
         AND mission."sessionHandle" = realtime_mistral_conversation_outbox."sessionHandle"
         AND mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  );

CREATE POLICY realtime_mistral_conversation_command_reaper_select
  ON "realtime_mistral_conversation_commands" FOR SELECT
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission.id = realtime_mistral_conversation_commands."missionId"
         AND mission."companyId" = realtime_mistral_conversation_commands."companyId"
         AND mission."sessionHandle" = realtime_mistral_conversation_commands."sessionHandle"
         AND mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  );
CREATE POLICY realtime_mistral_conversation_command_reaper_delete
  ON "realtime_mistral_conversation_commands" FOR DELETE
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND realtime_mistral_conversation_commands."retentionExpiresAt" <= clock_timestamp()
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission.id = realtime_mistral_conversation_commands."missionId"
         AND mission."companyId" = realtime_mistral_conversation_commands."companyId"
         AND mission."sessionHandle" = realtime_mistral_conversation_commands."sessionHandle"
         AND mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  );

-- Lecture d'existence seulement : le rôle de rétention ne peut ni muter ni supprimer un lease.
CREATE POLICY realtime_session_lease_mistral_retention_reaper_select
  ON "realtime_session_leases" FOR SELECT
  USING (
    current_user = 'bob_mistral_bootstrap_reaper'
    AND EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_bootstrap_tickets AS bootstrap
        JOIN public.realtime_mistral_conversation_missions AS mission
          ON mission."companyId" = bootstrap."companyId"
         AND mission."initialBootstrapId" = bootstrap.id
       WHERE bootstrap."admissionSessionId" = realtime_session_leases."sessionId"
         AND bootstrap."companyId" = realtime_session_leases."companyId"
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
    )
  );

-- Depuis l'introduction de la retention ordonnee, toute preuve liee appartient exclusivement a
-- son groupe bootstrap -> Mission -> enfants. Le purgeur historique ne doit donc plus la compter
-- dans son batch : une ancienne racine encore referencee pourrait sinon affamer indefiniment les
-- capacites orphelines plus recentes. Cette exclusion relationnelle conserve le role NOLOGIN au
-- moindre privilege : elle ne requiert pas de lui exposer state ni consumedAt.
CREATE OR REPLACE FUNCTION purge_realtime_mistral_conversation_bootstrap_tickets(
  batch_limit INTEGER DEFAULT 500
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
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
       AND NOT EXISTS (
         SELECT 1
           FROM public.realtime_mistral_conversation_missions AS mission
          WHERE mission."companyId" = ticket."companyId"
            AND mission."initialBootstrapId" = ticket.id
       )
     ORDER BY ticket."retentionExpiresAt", ticket.id
     FOR UPDATE OF ticket SKIP LOCKED
     LIMIT batch_limit
  LOOP
    BEGIN
      DELETE FROM public.realtime_mistral_conversation_bootstrap_tickets AS ticket
       WHERE ticket.id = candidate.id
         AND ticket."retentionExpiresAt" <= clock_timestamp()
         AND NOT EXISTS (
           SELECT 1
             FROM public.realtime_mistral_conversation_missions AS mission
            WHERE mission."companyId" = ticket."companyId"
              AND mission."initialBootstrapId" = ticket.id
         );
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      purged_count := purged_count + deleted_count;
    EXCEPTION
      -- Une FK sur une preuve presumee orpheline serait une rupture d'invariant. La ligne reste
      -- conservee et le batch suivant peut progresser ; aucune suppression partielle n'est
      -- autorisee.
      WHEN foreign_key_violation THEN NULL;
    END;
  END LOOP;

  RETURN purged_count;
END;
$$;

COMMENT ON FUNCTION purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER) IS
  'Purge bornee des seules capacites initiales expirees sans Mission liee.';

CREATE FUNCTION purge_realtime_mistral_conversation_retention(batch_limit INTEGER DEFAULT 10)
RETURNS TABLE (
  missions_purged INTEGER,
  bootstraps_purged INTEGER,
  resume_tickets_purged INTEGER,
  commands_purged INTEGER,
  outbox_events_purged INTEGER,
  lock_skipped INTEGER,
  admission_blocked INTEGER,
  invariant_blocked INTEGER,
  terminalization_blocked BOOLEAN,
  eligible_roots_remain BOOLEAN,
  expired_rows_remain BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  candidate RECORD;
  locked_bootstrap_id UUID;
  locked_mission_id UUID;
  locked_subject_hash TEXT;
  locked_subject_key_version INTEGER;
  locked_protocol TEXT;
  locked_mission_connection_epoch INTEGER;
  locked_next_server_sequence BIGINT;
  locked_terminal_reason TEXT;
  locked_closed_at TIMESTAMPTZ;
  bootstrap_admission_session_id UUID;
  resume_total INTEGER;
  resume_locked INTEGER;
  candidate_resumes INTEGER;
  candidate_commands INTEGER;
  candidate_outbox INTEGER;
  deleted_count INTEGER;
  root_count INTEGER := 0;
BEGIN
  IF current_user <> 'bob_mistral_bootstrap_reaper' THEN
    RAISE EXCEPTION 'mistral conversation retention requires the dedicated reaper role'
      USING ERRCODE = '42501';
  END IF;
  IF batch_limit IS NULL OR batch_limit < 1 OR batch_limit > 100 THEN
    RAISE EXCEPTION 'mistral conversation retention batch must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  missions_purged := 0;
  bootstraps_purged := 0;
  resume_tickets_purged := 0;
  commands_purged := 0;
  outbox_events_purged := 0;
  lock_skipped := 0;
  admission_blocked := 0;
  invariant_blocked := 0;

  -- Deux pools bornés garantissent la progression sans transformer un invariant cassé en
  -- verrou global de rétention. Les racines dont toutes les dépendances sont déjà purgeables
  -- passent avant le plus ancien préfixe diagnostique. Ainsi, même plus de 8 * batch racines
  -- empoisonnées (reçu divergent, lease orphelin, enfant futur) ne peuvent pas affamer une
  -- racine saine plus récente. Le total inspecté reste plafonné à 8 * batch / 800 lignes.
  FOR candidate IN
    WITH purgeable_candidates AS MATERIALIZED (
      SELECT mission.id, mission."companyId", mission."sessionHandle",
             mission."initialBootstrapId", mission."retentionExpiresAt"
        FROM public.realtime_mistral_conversation_missions AS mission
        JOIN public.realtime_mistral_conversation_bootstrap_tickets AS bootstrap
          ON bootstrap.id = mission."initialBootstrapId"
         AND bootstrap."companyId" = mission."companyId"
         AND bootstrap."retentionExpiresAt" <= clock_timestamp()
        JOIN public.realtime_mistral_conversation_terminal_receipts AS receipt
          ON receipt."companyId" = mission."companyId"
         AND receipt."sessionHandle" = mission."sessionHandle"
         AND receipt."subjectHash" IS NOT DISTINCT FROM mission."subjectHash"
         AND receipt."subjectKeyVersion" IS NOT DISTINCT FROM mission."subjectKeyVersion"
         AND receipt.protocol IS NOT DISTINCT FROM mission.protocol
         AND receipt."missionConnectionEpoch" IS NOT DISTINCT FROM
             mission."missionConnectionEpoch"
         AND receipt."nextServerSequence" IS NOT DISTINCT FROM mission."nextServerSequence"
         AND receipt."terminalReason" IS NOT DISTINCT FROM mission."terminalReason"
         AND receipt."closedAt" IS NOT DISTINCT FROM mission."closedAt"
       WHERE mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
         AND NOT EXISTS (
           SELECT 1
             FROM public.realtime_session_leases AS lease
            WHERE lease."companyId" = mission."companyId"
              AND lease."sessionId" = bootstrap."admissionSessionId"
         )
         AND NOT EXISTS (
           SELECT 1
             FROM public.realtime_mistral_conversation_resume_tickets AS resume
            WHERE resume."missionId" = mission.id
              AND resume."companyId" = mission."companyId"
              AND resume."retentionExpiresAt" > clock_timestamp()
           UNION ALL
           SELECT 1
             FROM public.realtime_mistral_conversation_commands AS command
            WHERE command."missionId" = mission.id
              AND command."companyId" = mission."companyId"
              AND command."retentionExpiresAt" > clock_timestamp()
           UNION ALL
           SELECT 1
             FROM public.realtime_mistral_conversation_outbox AS event
            WHERE event."missionId" = mission.id
              AND event."companyId" = mission."companyId"
              AND event."retentionExpiresAt" > clock_timestamp()
         )
       ORDER BY mission."retentionExpiresAt", mission.id
       LIMIT LEAST(batch_limit * 7, 700)
    ), diagnostic_candidates AS MATERIALIZED (
      SELECT mission.id, mission."companyId", mission."sessionHandle",
             mission."initialBootstrapId", mission."retentionExpiresAt"
        FROM public.realtime_mistral_conversation_missions AS mission
        JOIN public.realtime_mistral_conversation_bootstrap_tickets AS bootstrap
          ON bootstrap.id = mission."initialBootstrapId"
         AND bootstrap."companyId" = mission."companyId"
         AND bootstrap."retentionExpiresAt" <= clock_timestamp()
       WHERE mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
         AND NOT EXISTS (
           SELECT 1
             FROM purgeable_candidates AS purgeable
            WHERE purgeable.id = mission.id
              AND purgeable."companyId" = mission."companyId"
         )
       ORDER BY mission."retentionExpiresAt", mission.id
       LIMIT LEAST(batch_limit, 100)
    )
    SELECT selected.id, selected."companyId", selected."sessionHandle",
           selected."initialBootstrapId"
      FROM (
        SELECT purgeable.*, 0 AS selection_priority
          FROM purgeable_candidates AS purgeable
        UNION ALL
        SELECT diagnostic.*, 1 AS selection_priority
          FROM diagnostic_candidates AS diagnostic
      ) AS selected
     ORDER BY selected.selection_priority, selected."retentionExpiresAt", selected.id
  LOOP
    EXIT WHEN root_count >= batch_limit;
    BEGIN
      locked_bootstrap_id := NULL;
      locked_mission_id := NULL;
      locked_subject_hash := NULL;
      locked_subject_key_version := NULL;
      locked_protocol := NULL;
      locked_mission_connection_epoch := NULL;
      locked_next_server_sequence := NULL;
      locked_terminal_reason := NULL;
      locked_closed_at := NULL;
      bootstrap_admission_session_id := NULL;
      candidate_resumes := 0;
      candidate_commands := 0;
      candidate_outbox := 0;

      -- Lock 1 : même racine que la réconciliation tardive. SKIP LOCKED évite tout blocage entre
      -- répliques et toute inversion avec un writer déjà entré.
      SELECT bootstrap.id, bootstrap."admissionSessionId"
        INTO locked_bootstrap_id, bootstrap_admission_session_id
        FROM public.realtime_mistral_conversation_bootstrap_tickets AS bootstrap
       WHERE bootstrap.id = candidate."initialBootstrapId"
         AND bootstrap."companyId" = candidate."companyId"
         AND bootstrap."retentionExpiresAt" <= clock_timestamp()
       FOR UPDATE SKIP LOCKED;
      IF locked_bootstrap_id IS NULL THEN
        RAISE EXCEPTION 'bootstrap retention lock unavailable' USING ERRCODE = '55P03';
      END IF;

      -- Lock 2 : tous les writers Mission conformes prennent cette même clé avant la ligne.
      IF NOT pg_try_advisory_xact_lock(
        hashtextextended(candidate."companyId" || ':' || candidate."sessionHandle", 0)
      ) THEN
        RAISE EXCEPTION 'mission advisory lock unavailable' USING ERRCODE = '55P03';
      END IF;

      -- Une consommation peut avoir verrouillé le ticket juste avant l'advisory. On ne l'attend
      -- jamais : le rollback de la sous-transaction libère bootstrap + advisory immédiatement.
      SELECT COUNT(*)::INTEGER
        INTO resume_total
        FROM public.realtime_mistral_conversation_resume_tickets AS resume
       WHERE resume."missionId" = candidate.id
         AND resume."companyId" = candidate."companyId"
         AND resume."sessionHandle" = candidate."sessionHandle";
      SELECT COUNT(*)::INTEGER
        INTO resume_locked
        FROM (
          SELECT resume.id
            FROM public.realtime_mistral_conversation_resume_tickets AS resume
           WHERE resume."missionId" = candidate.id
             AND resume."companyId" = candidate."companyId"
             AND resume."sessionHandle" = candidate."sessionHandle"
           ORDER BY resume.id
           FOR UPDATE SKIP LOCKED
        ) AS locked_resume;
      IF resume_locked <> resume_total THEN
        RAISE EXCEPTION 'resume retention lock unavailable' USING ERRCODE = '55P03';
      END IF;

      -- Lock 4 + revalidation temporelle après toutes les attentes possibles.
      SELECT mission.id, mission."subjectHash", mission."subjectKeyVersion", mission.protocol,
             mission."missionConnectionEpoch", mission."nextServerSequence",
             mission."terminalReason", mission."closedAt"
        INTO locked_mission_id, locked_subject_hash, locked_subject_key_version, locked_protocol,
             locked_mission_connection_epoch, locked_next_server_sequence,
             locked_terminal_reason, locked_closed_at
        FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission.id = candidate.id
         AND mission."companyId" = candidate."companyId"
         AND mission."sessionHandle" = candidate."sessionHandle"
         AND mission."initialBootstrapId" = locked_bootstrap_id
         AND mission.phase = 'closed'
         AND mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
       FOR UPDATE SKIP LOCKED;
      IF locked_mission_id IS NULL THEN
        RAISE EXCEPTION 'mission retention lock unavailable' USING ERRCODE = '55P03';
      END IF;

      -- Une Mission ne quitte jamais le stockage autoritaire sans sa preuve terminale minimale.
      -- La liaison est exacte : une ligne présente mais issue d'une autre identité, époque ou
      -- position de replay est aussi dangereuse qu'une ligne absente.
      IF NOT EXISTS (
        SELECT 1
          FROM public.realtime_mistral_conversation_terminal_receipts AS receipt
         WHERE receipt."companyId" = candidate."companyId"
           AND receipt."sessionHandle" = candidate."sessionHandle"
           AND receipt."subjectHash" IS NOT DISTINCT FROM locked_subject_hash
           AND receipt."subjectKeyVersion" IS NOT DISTINCT FROM locked_subject_key_version
           AND receipt.protocol IS NOT DISTINCT FROM locked_protocol
           AND receipt."missionConnectionEpoch" IS NOT DISTINCT FROM
               locked_mission_connection_epoch
           AND receipt."nextServerSequence" IS NOT DISTINCT FROM locked_next_server_sequence
           AND receipt."terminalReason" IS NOT DISTINCT FROM locked_terminal_reason
           AND receipt."closedAt" IS NOT DISTINCT FROM locked_closed_at
      ) THEN
        RAISE EXCEPTION 'terminal receipt missing or inconsistent'
          USING ERRCODE = 'P0003',
                CONSTRAINT = 'mistral_terminal_receipt_retention_binding';
      END IF;

      -- Le lease doit être supprimé par l'autorité de terminaison pendant que Mission + outbox
      -- terminale existent encore. Le reaper de rétention attend le prochain sweep.
      IF EXISTS (
        SELECT 1
          FROM public.realtime_session_leases AS lease
         WHERE lease."companyId" = candidate."companyId"
           AND lease."sessionId" = bootstrap_admission_session_id
      ) THEN
        RAISE EXCEPTION 'admission termination remains pending' USING ERRCODE = 'P0002';
      END IF;

      IF EXISTS (
        SELECT 1
          FROM public.realtime_mistral_conversation_resume_tickets AS resume
         WHERE resume."missionId" = candidate.id
           AND resume."companyId" = candidate."companyId"
           AND resume."retentionExpiresAt" > clock_timestamp()
        UNION ALL
        SELECT 1
          FROM public.realtime_mistral_conversation_commands AS command
         WHERE command."missionId" = candidate.id
           AND command."companyId" = candidate."companyId"
           AND command."retentionExpiresAt" > clock_timestamp()
        UNION ALL
        SELECT 1
          FROM public.realtime_mistral_conversation_outbox AS event
         WHERE event."missionId" = candidate.id
           AND event."companyId" = candidate."companyId"
           AND event."retentionExpiresAt" > clock_timestamp()
      ) THEN
        RAISE EXCEPTION 'retained child outlives mission retention' USING ERRCODE = 'P0003';
      END IF;

      DELETE FROM public.realtime_mistral_conversation_resume_tickets AS resume
       WHERE resume."missionId" = candidate.id
         AND resume."companyId" = candidate."companyId"
         AND resume."sessionHandle" = candidate."sessionHandle";
      GET DIAGNOSTICS candidate_resumes = ROW_COUNT;

      DELETE FROM public.realtime_mistral_conversation_commands AS command
       WHERE command."missionId" = candidate.id
         AND command."companyId" = candidate."companyId"
         AND command."sessionHandle" = candidate."sessionHandle";
      GET DIAGNOSTICS candidate_commands = ROW_COUNT;

      DELETE FROM public.realtime_mistral_conversation_outbox AS event
       WHERE event."missionId" = candidate.id
         AND event."companyId" = candidate."companyId"
         AND event."sessionHandle" = candidate."sessionHandle";
      GET DIAGNOSTICS candidate_outbox = ROW_COUNT;

      DELETE FROM public.realtime_mistral_conversation_missions AS mission
       WHERE mission.id = candidate.id
         AND mission."companyId" = candidate."companyId"
         AND mission."sessionHandle" = candidate."sessionHandle";
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      IF deleted_count <> 1 THEN
        RAISE EXCEPTION 'mission retention delete lost its exact row' USING ERRCODE = '55000';
      END IF;

      DELETE FROM public.realtime_mistral_conversation_bootstrap_tickets AS bootstrap
       WHERE bootstrap.id = locked_bootstrap_id
         AND bootstrap."companyId" = candidate."companyId"
         AND bootstrap."retentionExpiresAt" <= clock_timestamp();
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
      IF deleted_count <> 1 THEN
        RAISE EXCEPTION 'bootstrap retention delete lost its exact row' USING ERRCODE = '55000';
      END IF;

      missions_purged := missions_purged + 1;
      bootstraps_purged := bootstraps_purged + 1;
      resume_tickets_purged := resume_tickets_purged + candidate_resumes;
      commands_purged := commands_purged + candidate_commands;
      outbox_events_purged := outbox_events_purged + candidate_outbox;
      root_count := root_count + 1;
    EXCEPTION
      WHEN lock_not_available THEN
        lock_skipped := lock_skipped + 1;
      WHEN SQLSTATE 'P0002' THEN
        admission_blocked := admission_blocked + 1;
      WHEN SQLSTATE 'P0003' THEN
        invariant_blocked := invariant_blocked + 1;
    END;
  END LOOP;

  -- Les capacités initiales jamais consommées n'ont aucune Mission. Elles utilisent le reliquat
  -- du batch ; toute FK inattendue remonte et annule la transaction entière.
  FOR candidate IN
    SELECT bootstrap.id, bootstrap."companyId"
      FROM public.realtime_mistral_conversation_bootstrap_tickets AS bootstrap
     WHERE bootstrap."retentionExpiresAt" <= clock_timestamp()
       AND NOT EXISTS (
         SELECT 1
           FROM public.realtime_mistral_conversation_missions AS mission
          WHERE mission."companyId" = bootstrap."companyId"
            AND mission."initialBootstrapId" = bootstrap.id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.realtime_mistral_conversation_resume_tickets AS resume
          WHERE resume."companyId" = bootstrap."companyId"
            AND resume."initialBootstrapId" = bootstrap.id
       )
     ORDER BY bootstrap."retentionExpiresAt", bootstrap.id
     LIMIT GREATEST(batch_limit - root_count, 0)
     FOR UPDATE OF bootstrap SKIP LOCKED
  LOOP
    DELETE FROM public.realtime_mistral_conversation_bootstrap_tickets AS bootstrap
     WHERE bootstrap.id = candidate.id
       AND bootstrap."companyId" = candidate."companyId"
       AND bootstrap."retentionExpiresAt" <= clock_timestamp();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    IF deleted_count = 1 THEN
      bootstraps_purged := bootstraps_purged + 1;
      root_count := root_count + 1;
    END IF;
  END LOOP;

  SELECT EXISTS (
    SELECT 1
      FROM public.realtime_mistral_conversation_missions AS mission
     WHERE mission."replayGraceExpiresAt" <= clock_timestamp()
       AND mission."retentionExpiresAt" <= clock_timestamp()
       AND mission.phase <> 'closed'
  ) INTO terminalization_blocked;

  SELECT (
    EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_missions AS mission
        JOIN public.realtime_mistral_conversation_bootstrap_tickets AS bootstrap
          ON bootstrap.id = mission."initialBootstrapId"
         AND bootstrap."companyId" = mission."companyId"
         AND bootstrap."retentionExpiresAt" <= clock_timestamp()
       WHERE mission."replayGraceExpiresAt" <= clock_timestamp()
         AND mission."retentionExpiresAt" <= clock_timestamp()
         AND mission.phase = 'closed'
    )
    OR EXISTS (
      SELECT 1
        FROM public.realtime_mistral_conversation_bootstrap_tickets AS bootstrap
       WHERE bootstrap."retentionExpiresAt" <= clock_timestamp()
         AND NOT EXISTS (
           SELECT 1
             FROM public.realtime_mistral_conversation_missions AS mission
            WHERE mission."companyId" = bootstrap."companyId"
              AND mission."initialBootstrapId" = bootstrap.id
         )
    )
  ) INTO eligible_roots_remain;

  expired_rows_remain := terminalization_blocked OR eligible_roots_remain;
  RETURN NEXT;
END;
$$;

-- La migration ferme immédiatement PUBLIC. Le rituel de release transfère ensuite l'ownership
-- des deux capacités au rôle NOLOGIN sans BYPASSRLS et accorde uniquement EXECUTE au runtime.
-- Tant que ce transfert n'a pas eu lieu, le garde current_user du purgeur ordonné échoue fermé.
REVOKE ALL ON FUNCTION purge_realtime_mistral_conversation_bootstrap_tickets(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION purge_realtime_mistral_conversation_retention(INTEGER) FROM PUBLIC;

COMMENT ON FUNCTION purge_realtime_mistral_conversation_retention(INTEGER) IS
  'Purge atomique bornée des preuves Mistral v2 après grâce/rétention, sans données audit séparées.';

COMMIT;

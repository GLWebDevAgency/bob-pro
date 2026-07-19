-- Bob Live Mistral Conversation v2 — le bail d'admission ne disparaît qu'après la
-- fermeture durable exacte de sa Mission. Ce fence reste SECURITY INVOKER : sous le
-- rôle runtime, toutes ses lectures traversent la FORCE RLS du tenant courant.

BEGIN;

CREATE FUNCTION guard_mistral_conversation_admission_lease_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  bootstrap_id uuid;
BEGIN
  -- Les sessions Mistral v1 et les autres providers conservent leur cycle de vie existant.
  IF OLD."providerId" IS DISTINCT FROM 'mistral'
    OR OLD."providerCallId" IS NULL
    OR left(OLD."providerCallId", 5) <> 'mcv2:'
  THEN
    RETURN OLD;
  END IF;

  -- Fermer le namespace : un identifiant presque mcv2 ne doit jamais devenir un moyen de
  -- contourner la preuve Mission. La forme est identique à celle du routeur applicatif.
  IF OLD."providerCallId" !~
    '^mcv2:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION 'malformed mistral conversation admission provider identity'
      USING ERRCODE = '55000';
  END IF;

  bootstrap_id := substring(OLD."providerCallId" FROM 6)::uuid;

  IF NOT EXISTS (
    SELECT 1
      FROM public.realtime_mistral_conversation_missions AS mission
     WHERE mission."companyId" = OLD."companyId"
       AND mission."subjectHash" = OLD."subjectHash"
       AND mission."admissionSessionId" = OLD."sessionId"
       AND mission."sessionHandle" = lower(OLD."sessionId"::text)
       AND mission."initialBootstrapId" = bootstrap_id
       AND mission.phase = 'closed'
       AND mission."closedAt" IS NOT NULL
       AND mission."terminalReason" IS NOT NULL
       AND mission."terminalServerSequence" >= 2
       AND mission."nextServerSequence" = mission."terminalServerSequence" + 1
       AND (
         SELECT array_agg(event."eventType" ORDER BY event."serverSequence")
           FROM public.realtime_mistral_conversation_outbox AS event
          WHERE event."companyId" = mission."companyId"
            AND event."missionId" = mission.id
            AND event."sessionHandle" = mission."sessionHandle"
            AND event."serverSequence" BETWEEN
              mission."terminalServerSequence" - 1
              AND mission."terminalServerSequence"
       ) IS NOT DISTINCT FROM ARRAY['session.draining', 'session.closed']::text[]
       AND NOT EXISTS (
         SELECT 1
           FROM public.realtime_mistral_conversation_outbox AS later_event
          WHERE later_event."companyId" = mission."companyId"
            AND later_event."missionId" = mission.id
            AND later_event."sessionHandle" = mission."sessionHandle"
            AND later_event."serverSequence" > mission."terminalServerSequence"
       )
  ) THEN
    RAISE EXCEPTION 'mistral conversation admission lease requires an exact closed Mission'
      USING ERRCODE = '55000';
  END IF;

  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION guard_mistral_conversation_admission_lease_delete() FROM PUBLIC;

-- Le préfixe 00 fait passer ce fence avant les anciens BEFORE DELETE susceptibles de
-- transformer une suppression en no-op ; aucune branche antérieure ne peut le court-circuiter.
CREATE TRIGGER realtime_session_lease_00_mcv2_delete_fence_guard
BEFORE DELETE ON "realtime_session_leases"
FOR EACH ROW EXECUTE FUNCTION guard_mistral_conversation_admission_lease_delete();

COMMIT;

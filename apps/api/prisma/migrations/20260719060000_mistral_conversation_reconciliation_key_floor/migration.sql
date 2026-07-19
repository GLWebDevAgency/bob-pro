-- Ferme le plancher cryptographique autour des capacités r2 de réconciliation ajoutées par
-- 20260719050000. La migration reste additive : les lignes historiques sont conservées et toute
-- version qu'elles retiennent bloque désormais son retirement jusqu'à leur purge normale.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Même verrou global que stage/retire et les writers versionnés. Pris avant le verrou de table,
-- il empêche une transition de plage de s'intercaler pendant l'installation du nouveau guard.
SELECT pg_advisory_xact_lock(
  hashtextextended('mistral-conversation-persistence-v1', 0)
);

LOCK TABLE "realtime_mistral_conversation_resume_tickets"
IN SHARE ROW EXCLUSIVE MODE;

-- Le scan de rétention est exécuté à chaque retirement et par le rituel de release. L'index est
-- partiel afin de laisser les reprises standard (NULL par contrat) hors du chemin cryptographique.
CREATE INDEX "mistral_resume_reconciliation_key_version_retention_idx"
  ON "realtime_mistral_conversation_resume_tickets"("reconciliationKeyVersion")
  WHERE "reconciliationKeyVersion" IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_mistral_conversation_key_version_floor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Même verrou exclusif que le rituel de release. Il attend tous les writers déjà admis et
  -- empêche un nouveau r2 sous l'ancienne version de passer pendant le retirement.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('mistral-conversation-persistence-v1', 0)
  );

  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_FLOOR_APPEND_ONLY'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mistral_key_floor_append_only';
  END IF;

  IF NEW."keySpace" IS DISTINCT FROM OLD."keySpace"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_FLOOR_IDENTITY_IMMUTABLE'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mistral_key_floor_identity_immutable';
  END IF;

  IF NEW."minimumVersion" < OLD."minimumVersion"
     OR NEW."highestVersion" < OLD."highestVersion" THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_ROLLBACK'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mistral_key_floor_monotonic';
  END IF;

  IF NEW."minimumVersion" = OLD."minimumVersion"
     AND NEW."highestVersion" = OLD."highestVersion" THEN
    NEW."updatedAt" := OLD."updatedAt";
  ELSIF OLD."minimumVersion" = OLD."highestVersion"
        AND NEW."minimumVersion" = OLD."minimumVersion"
        AND NEW."highestVersion"::bigint = OLD."highestVersion"::bigint + 1 THEN
    -- prepare(v+1) : l'ancien et le nouveau replica peuvent écrire pendant le rollout.
    NEW."updatedAt" := GREATEST(clock_timestamp(), OLD."updatedAt" + interval '1 microsecond');
  ELSIF OLD."highestVersion"::bigint = OLD."minimumVersion"::bigint + 1
        AND NEW."minimumVersion" = OLD."highestVersion"
        AND NEW."highestVersion" = OLD."highestVersion" THEN
    -- Une capacité r2 existante doit rester re-dérivable après perte de réponse. Toute ligne non
    -- purgée fait foi, indépendamment de state/expiresAt : seule la purge de rétention lève ce veto.
    IF EXISTS (
      SELECT 1
        FROM public."realtime_mistral_conversation_resume_tickets" AS resume
       WHERE resume."reconciliationKeyVersion" = OLD."minimumVersion"
    ) THEN
      RAISE EXCEPTION 'MISTRAL_CONVERSATION_RECONCILIATION_KEY_VERSION_RETAINED'
        USING ERRCODE = '23514',
              CONSTRAINT = 'mistral_reconciliation_key_version_retained';
    END IF;
    NEW."updatedAt" := GREATEST(clock_timestamp(), OLD."updatedAt" + interval '1 microsecond');
  ELSE
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_TRANSITION_INVALID'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mistral_key_floor_transition';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_mistral_conversation_persistence_key_range()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  admitted_minimum INTEGER;
  admitted_highest INTEGER;
  written_version INTEGER;
BEGIN
  IF TG_TABLE_SCHEMA <> 'public'
     OR TG_TABLE_NAME NOT IN (
       'realtime_mistral_conversation_outbox',
       'realtime_mistral_conversation_commands',
       'realtime_mistral_conversation_resume_tickets'
     ) THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_GUARD_MISWIRED'
      USING ERRCODE = '55000';
  END IF;

  -- La reprise standard ne dérive aucun secret de réconciliation. Son NULL historique reste hors
  -- du key-floor et garde exactement son comportement antérieur.
  -- NEW est un record polymorphe : les colonnes purpose/reconciliationKeyVersion ne doivent
  -- jamais être résolues pour outbox/commands. Le bloc imbriqué est donc une frontière SQL, pas
  -- seulement une optimisation de court-circuit booléen.
  IF TG_TABLE_NAME = 'realtime_mistral_conversation_resume_tickets' THEN
    IF NEW.purpose = 'standard_resume'
       AND NEW."reconciliationKeyVersion" IS NULL THEN
      RETURN NEW;
    END IF;

    IF NEW.purpose IS DISTINCT FROM 'initial_bootstrap_reconciliation'
       OR NEW."reconciliationKeyVersion" IS NULL THEN
      RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_NOT_ADMITTED'
        USING ERRCODE = '23514',
              CONSTRAINT = 'realtime_mistral_conversation_key_version_range';
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('mistral-conversation-persistence-v1', 0)
  );

  SELECT "minimumVersion", "highestVersion"
    INTO admitted_minimum, admitted_highest
    FROM public."realtime_mistral_conversation_key_version_floors"
   WHERE "keySpace" = 'mistral-conversation-persistence-v1';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_RANGE_UNINITIALIZED'
      USING ERRCODE = '55000',
            CONSTRAINT = 'realtime_mistral_conversation_key_version_range_required';
  END IF;

  IF TG_TABLE_NAME = 'realtime_mistral_conversation_outbox' THEN
    written_version := NEW."encryptionKeyVersion";
  ELSIF TG_TABLE_NAME = 'realtime_mistral_conversation_commands' THEN
    written_version := NEW."proofKeyVersion";
  ELSIF TG_TABLE_NAME = 'realtime_mistral_conversation_resume_tickets' THEN
    written_version := NEW."reconciliationKeyVersion";
  END IF;

  IF written_version IS NULL
     OR written_version < admitted_minimum
     OR written_version > admitted_highest THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_NOT_ADMITTED'
      USING ERRCODE = '23514',
            CONSTRAINT = 'realtime_mistral_conversation_key_version_range';
  END IF;

  RETURN NEW;
END;
$$;

-- Le préfixe 00 fait lire le plancher avant le garde métier de réconciliation. Le verrou partagé
-- reste détenu jusqu'au COMMIT de l'INSERT, y compris si les autres triggers effectuent des locks.
CREATE TRIGGER "00_realtime_mistral_conversation_resume_ticket_key_version_guard"
BEFORE INSERT ON "realtime_mistral_conversation_resume_tickets"
FOR EACH ROW
EXECUTE FUNCTION enforce_mistral_conversation_persistence_key_range();

REVOKE ALL ON FUNCTION enforce_mistral_conversation_key_version_floor() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_mistral_conversation_persistence_key_range() FROM PUBLIC;

-- Réaffirme la frontière tenant : le trigger est SECURITY INVOKER et le rôle runtime reste
-- NOSUPERUSER/NOBYPASSRLS, sans aucun privilège de mutation sur le registre global.
ALTER TABLE "realtime_mistral_conversation_resume_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_mistral_conversation_resume_tickets" FORCE ROW LEVEL SECURITY;

COMMENT ON INDEX "mistral_resume_reconciliation_key_version_retention_idx" IS
  'Versions r2 non purgées qui interdisent le retirement de leur matière de re-dérivation.';
COMMENT ON TRIGGER "00_realtime_mistral_conversation_resume_ticket_key_version_guard"
  ON "realtime_mistral_conversation_resume_tickets" IS
  'Sérialise chaque r2 de réconciliation avec stage/retire et refuse toute version hors plage.';

COMMIT;

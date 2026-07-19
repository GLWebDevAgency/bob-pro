-- Registre durable du HMAC sujet Bob Live.
--
-- Un reçu terminal survit volontairement à sa Mission. La clé qui a produit son subjectHash doit
-- donc rester connue, et une même version ne doit jamais pouvoir désigner un autre matériau après
-- un changement de configuration. Ce registre ne stocke que des empreintes SHA-256 non secrètes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL row_security = off;

-- Ordre global de rotation : persistance -> identité bootstrap -> sujet. Le premier verrou ferme
-- également la course avec un bootstrap qui insère ensuite Mission + outbox dans une transaction.
SELECT pg_advisory_xact_lock(
  hashtextextended('mistral-conversation-persistence-v1', 0)
);
SELECT pg_advisory_xact_lock(
  hashtextextended('mistral-conversation-bootstrap-identity-v1', 0)
);
SELECT pg_advisory_xact_lock(
  hashtextextended('bob-live-subject-hmac-v1', 0)
);

LOCK TABLE
  "realtime_mistral_conversation_bootstrap_tickets",
  "realtime_mistral_conversation_missions",
  "realtime_mistral_conversation_terminal_receipts"
IN SHARE ROW EXCLUSIVE MODE;

-- Les tables de registre étaient déjà structurées par keySpace. On ouvre un second domaine sans
-- mélanger les matériaux : PK, empreintes et plage d'écriture restent isolées par keySpace.
ALTER TABLE "realtime_mistral_conversation_key_version_floors"
  DROP CONSTRAINT "mistral_key_floor_key_space_check";
ALTER TABLE "realtime_mistral_conversation_key_version_floors"
  ADD CONSTRAINT "mistral_key_floor_key_space_check" CHECK (
    "keySpace" IN (
      'mistral-conversation-persistence-v1',
      'bob-live-subject-hmac-v1'
    )
  );

ALTER TABLE "realtime_mistral_conversation_key_bindings"
  DROP CONSTRAINT "mistral_key_binding_key_space_check";
ALTER TABLE "realtime_mistral_conversation_key_bindings"
  ADD CONSTRAINT "mistral_key_binding_key_space_check" CHECK (
    "keySpace" IN (
      'mistral-conversation-persistence-v1',
      'bob-live-subject-hmac-v1'
    )
  );

-- Un floor sujet déjà utilisé est amorcé sur la version observée la plus haute. Le rituel stage
-- qui suit immédiatement migrate deploy grave l'empreinte et vérifie toutes les versions
-- historiques. Une base sans preuve reste volontairement sans floor : tout writer échoue fermé.
WITH observed_versions AS (
  SELECT "subjectKeyVersion" AS version
    FROM "realtime_mistral_conversation_bootstrap_tickets"
  UNION ALL
  SELECT "subjectKeyVersion" AS version
    FROM "realtime_mistral_conversation_missions"
  UNION ALL
  SELECT "subjectKeyVersion" AS version
    FROM "realtime_mistral_conversation_terminal_receipts"
), highest_observed AS (
  SELECT max(version)::integer AS version
    FROM observed_versions
)
INSERT INTO "realtime_mistral_conversation_key_version_floors" (
  "keySpace", "minimumVersion", "highestVersion"
)
SELECT 'bob-live-subject-hmac-v1', version, version
  FROM highest_observed
 WHERE version IS NOT NULL
ON CONFLICT ("keySpace") DO NOTHING;

CREATE INDEX "mistral_bootstrap_subject_key_version_retention_idx"
  ON "realtime_mistral_conversation_bootstrap_tickets"("subjectKeyVersion");
CREATE INDEX "mistral_mission_subject_key_version_retention_idx"
  ON "realtime_mistral_conversation_missions"("subjectKeyVersion");
CREATE INDEX "mistral_terminal_receipt_subject_key_version_retention_idx"
  ON "realtime_mistral_conversation_terminal_receipts"("subjectKeyVersion");

-- Le guard commun devient keySpace-aware. Le seul veto métier propre à la persistance (r2 encore
-- re-dérivable) ne s'applique jamais au floor sujet : retirer une version de la plage d'écriture
-- est permis, mais le script de release conserve son secret tant qu'une preuve la référence.
CREATE OR REPLACE FUNCTION enforce_mistral_conversation_key_version_floor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  locked_key_space TEXT;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('mistral-conversation-persistence-v1', 0)
    );
    PERFORM pg_advisory_xact_lock(
      hashtextextended('bob-live-subject-hmac-v1', 0)
    );
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_FLOOR_APPEND_ONLY'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mistral_key_floor_append_only';
  END IF;

  locked_key_space := OLD."keySpace";
  IF locked_key_space NOT IN (
    'mistral-conversation-persistence-v1',
    'bob-live-subject-hmac-v1'
  ) THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_FLOOR_IDENTITY_INVALID'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mistral_key_floor_identity';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(locked_key_space, 0));

  IF TG_OP = 'DELETE' THEN
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
    NEW."updatedAt" := GREATEST(clock_timestamp(), OLD."updatedAt" + interval '1 microsecond');
  ELSIF OLD."highestVersion"::bigint = OLD."minimumVersion"::bigint + 1
        AND NEW."minimumVersion" = OLD."highestVersion"
        AND NEW."highestVersion" = OLD."highestVersion" THEN
    IF locked_key_space = 'mistral-conversation-persistence-v1'
       AND EXISTS (
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

CREATE OR REPLACE FUNCTION enforce_mistral_conversation_key_binding_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  locked_key_space TEXT;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('mistral-conversation-persistence-v1', 0)
    );
    PERFORM pg_advisory_xact_lock(
      hashtextextended('bob-live-subject-hmac-v1', 0)
    );
  ELSE
    locked_key_space := OLD."keySpace";
    IF locked_key_space NOT IN (
      'mistral-conversation-persistence-v1',
      'bob-live-subject-hmac-v1'
    ) THEN
      RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_BINDING_IDENTITY_INVALID'
        USING ERRCODE = '23514',
              CONSTRAINT = 'mistral_key_binding_identity';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(locked_key_space, 0));
  END IF;

  RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_BINDING_APPEND_ONLY'
    USING ERRCODE = '23514',
          CONSTRAINT = 'mistral_key_binding_append_only';
END;
$$;

-- Un bootstrap produit ensuite une Mission et son outbox dans la même transaction. Il doit donc
-- prendre le verrou persistance avant les triggers identité (00...identity) et sujet (01...subject),
-- faute de quoi un stage global persistance -> identité -> sujet pourrait deadlocker avec lui.
CREATE FUNCTION lock_mistral_bootstrap_persistence_key_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'public'
     OR TG_TABLE_NAME <> 'realtime_mistral_conversation_bootstrap_tickets' THEN
    RAISE EXCEPTION 'MISTRAL_BOOTSTRAP_PERSISTENCE_LOCK_GUARD_MISWIRED'
      USING ERRCODE = '55000';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('mistral-conversation-persistence-v1', 0)
  );
  RETURN NEW;
END;
$$;

CREATE FUNCTION enforce_bob_live_subject_hmac_key_range()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  admitted_minimum INTEGER;
  admitted_highest INTEGER;
BEGIN
  IF TG_TABLE_SCHEMA <> 'public'
     OR TG_TABLE_NAME NOT IN (
       'realtime_mistral_conversation_bootstrap_tickets',
       'realtime_mistral_conversation_missions'
     ) THEN
    RAISE EXCEPTION 'BOB_LIVE_SUBJECT_KEY_VERSION_GUARD_MISWIRED'
      USING ERRCODE = '55000';
  END IF;

  -- Mission est suivie d'une écriture outbox dans la même transaction : elle prend d'abord le
  -- lock persistance pour conserver l'ordre global et exclure tout deadlock avec stage/retire.
  IF TG_TABLE_NAME = 'realtime_mistral_conversation_missions' THEN
    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('mistral-conversation-persistence-v1', 0)
    );
  END IF;
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('bob-live-subject-hmac-v1', 0)
  );

  SELECT "minimumVersion", "highestVersion"
    INTO admitted_minimum, admitted_highest
    FROM public."realtime_mistral_conversation_key_version_floors"
   WHERE "keySpace" = 'bob-live-subject-hmac-v1';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BOB_LIVE_SUBJECT_KEY_VERSION_RANGE_UNINITIALIZED'
      USING ERRCODE = '55000',
            CONSTRAINT = 'bob_live_subject_key_version_range_required';
  END IF;

  IF NEW."subjectKeyVersion" < admitted_minimum
     OR NEW."subjectKeyVersion" > admitted_highest THEN
    RAISE EXCEPTION 'BOB_LIVE_SUBJECT_KEY_VERSION_NOT_ADMITTED'
      USING ERRCODE = '23514',
            CONSTRAINT = 'bob_live_subject_key_version_range';
  END IF;

  -- Le seed de migration ne connaît volontairement aucun secret. Tant que le rituel `stage` n'a
  -- pas gravé l'empreinte exacte, même une version numériquement admise reste inutilisable. Cette
  -- garde ferme la fenêtre migrate -> stage et rend un ancien writer v2 inoffensif durant ce gap.
  IF NOT EXISTS (
    SELECT 1
      FROM public.realtime_mistral_conversation_key_bindings AS binding
     WHERE binding."keySpace" = 'bob-live-subject-hmac-v1'
       AND binding."keyVersion" = NEW."subjectKeyVersion"
  ) THEN
    RAISE EXCEPTION 'BOB_LIVE_SUBJECT_KEY_VERSION_UNBOUND'
      USING ERRCODE = '55000',
            CONSTRAINT = 'bob_live_subject_key_version_binding_required';
  END IF;

  RETURN NEW;
END;
$$;

-- Vue de boot globale et minimale : aucune identité tenant ni aucun hash sujet ne quitte la base.
-- SECURITY DEFINER est requis car FORCE RLS masque légitimement les autres tenants au rôle runtime.
-- L'absence d'un binding reste visible via NULL et fait échouer l'autorité de boot fermée.
CREATE FUNCTION retained_bob_live_subject_hmac_key_bindings()
RETURNS TABLE (
  "keyVersion" INTEGER,
  "keyFingerprint" TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  WITH retained_versions AS (
    SELECT "subjectKeyVersion" AS version
      FROM public.realtime_mistral_conversation_bootstrap_tickets
    UNION
    SELECT "subjectKeyVersion" AS version
      FROM public.realtime_mistral_conversation_missions
    UNION
    SELECT "subjectKeyVersion" AS version
      FROM public.realtime_mistral_conversation_terminal_receipts
  )
  SELECT retained.version AS "keyVersion",
         binding."keyFingerprint"::text AS "keyFingerprint"
    FROM retained_versions AS retained
    LEFT JOIN public.realtime_mistral_conversation_key_bindings AS binding
      ON binding."keySpace" = 'bob-live-subject-hmac-v1'
     AND binding."keyVersion" = retained.version
   ORDER BY retained.version
$$;

-- L'identité AEAD du bootstrap prend son lock avant le sujet ; le préfixe 01 préserve cet ordre.
CREATE TRIGGER "00_mistral_bootstrap_00_persistence_key_order_guard"
BEFORE INSERT ON "realtime_mistral_conversation_bootstrap_tickets"
FOR EACH ROW EXECUTE FUNCTION lock_mistral_bootstrap_persistence_key_order();

CREATE TRIGGER "01_mistral_bootstrap_subject_key_version_guard"
BEFORE INSERT ON "realtime_mistral_conversation_bootstrap_tickets"
FOR EACH ROW EXECUTE FUNCTION enforce_bob_live_subject_hmac_key_range();

CREATE TRIGGER "00_mistral_mission_subject_key_version_guard"
BEFORE INSERT ON "realtime_mistral_conversation_missions"
FOR EACH ROW EXECUTE FUNCTION enforce_bob_live_subject_hmac_key_range();

REVOKE ALL ON FUNCTION enforce_mistral_conversation_key_version_floor() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_mistral_conversation_key_binding_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION lock_mistral_bootstrap_persistence_key_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_bob_live_subject_hmac_key_range() FROM PUBLIC;
REVOKE ALL ON FUNCTION retained_bob_live_subject_hmac_key_bindings() FROM PUBLIC;

COMMENT ON INDEX "mistral_terminal_receipt_subject_key_version_retention_idx" IS
  'Versions HMAC sujet dont la matière doit rester dans le keyring jusqu à la cascade Company.';
COMMENT ON TRIGGER "01_mistral_bootstrap_subject_key_version_guard"
  ON "realtime_mistral_conversation_bootstrap_tickets" IS
  'Sérialise chaque nouvelle identité sujet v2 avec stage/retire du keyring HMAC.';
COMMENT ON TRIGGER "00_mistral_bootstrap_00_persistence_key_order_guard"
  ON "realtime_mistral_conversation_bootstrap_tickets" IS
  'Établit l ordre global persistance, identité, sujet avant toute preuve bootstrap.';
COMMENT ON TRIGGER "00_mistral_mission_subject_key_version_guard"
  ON "realtime_mistral_conversation_missions" IS
  'Refuse une Mission dont la version sujet n appartient pas à la plage de writers déployée.';
COMMENT ON FUNCTION retained_bob_live_subject_hmac_key_bindings() IS
  'Expose au boot uniquement versions retenues et empreintes HMAC sujet, jamais tenant ni hash.';

COMMIT;

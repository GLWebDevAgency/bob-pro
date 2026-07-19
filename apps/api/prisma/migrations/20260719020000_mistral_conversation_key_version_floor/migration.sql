-- Registre global append-only des versions de clés de persistance Bob Live déjà activées.
-- Il ne contient aucune donnée tenant ni secret. Sa portée globale est intentionnelle : une
-- rotation vaut pour tout le cluster et doit survivre aux redémarrages et rollbacks de config.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Aucune écriture versionnée ne peut s'intercaler entre le snapshot de backfill et l'installation
-- des guards. L'ordre lexical unique évite tout futur entrelacement de locks contradictoire.
LOCK TABLE
  "realtime_mistral_conversation_outbox",
  "realtime_mistral_conversation_commands"
IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "realtime_mistral_conversation_key_version_floors" (
  "keySpace" VARCHAR(64) NOT NULL,
  "minimumVersion" INTEGER NOT NULL,
  "highestVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mistral_key_floor_pkey"
    PRIMARY KEY ("keySpace"),
  CONSTRAINT "mistral_key_floor_key_space_check"
    CHECK ("keySpace" = 'mistral-conversation-persistence-v1'),
  CONSTRAINT "mistral_key_floor_version_check"
    CHECK (
      "minimumVersion" BETWEEN 1 AND 2147483647
      AND "highestVersion" BETWEEN "minimumVersion" AND 2147483647
      AND "highestVersion"::bigint <= "minimumVersion"::bigint + 1
    ),
  CONSTRAINT "mistral_key_floor_timestamps_check"
    CHECK ("updatedAt" >= "createdAt")
);

COMMENT ON TABLE "realtime_mistral_conversation_key_version_floors" IS
  'Registre global sans secret : plage de clés Mistral admise pendant une rotation sans coupure.';

-- Engagement cryptographique append-only. Une version numérique ne pourra jamais être réutilisée
-- avec un autre matériau, même après son retrait de la plage d'écriture tant que des événements
-- historiques peuvent encore la référencer.
CREATE TABLE "realtime_mistral_conversation_key_bindings" (
  "keySpace" VARCHAR(64) NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "keyFingerprint" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mistral_key_binding_pkey"
    PRIMARY KEY ("keySpace", "keyVersion"),
  CONSTRAINT "mistral_key_binding_fingerprint_key"
    UNIQUE ("keySpace", "keyFingerprint"),
  CONSTRAINT "mistral_key_binding_key_space_check"
    CHECK ("keySpace" = 'mistral-conversation-persistence-v1'),
  CONSTRAINT "mistral_key_binding_value_check"
    CHECK (
      "keyVersion" BETWEEN 1 AND 2147483647
      AND "keyFingerprint"::text ~ '^[a-f0-9]{64}$'
    )
);

COMMENT ON TABLE "realtime_mistral_conversation_key_bindings" IS
  'Engagement SHA-256 non secret et immuable du matériau associé à chaque version Mistral.';

-- Une base existante doit apprendre les clés réellement utilisées avant d'armer les nouveaux
-- guards. Sans ce backfill, un ancien boot pourrait initialiser artificiellement un plancher bas.
WITH observed_versions AS (
  SELECT "encryptionKeyVersion" AS version
    FROM "realtime_mistral_conversation_outbox"
  UNION ALL
  SELECT "proofKeyVersion" AS version
    FROM "realtime_mistral_conversation_commands"
), highest_observed AS (
  SELECT max(version)::integer AS version
    FROM observed_versions
)
INSERT INTO "realtime_mistral_conversation_key_version_floors" (
  "keySpace",
  "minimumVersion",
  "highestVersion"
)
SELECT 'mistral-conversation-persistence-v1', version, version
  FROM highest_observed
 WHERE version IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_mistral_conversation_key_version_floor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Même verrou global que les guards outbox/command : une transition de plage attend tous les
  -- writers déjà admis et empêche tout nouveau writer de lire l'ancien état.
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
    -- retire(v) : seulement après preuve que tous les anciens replicas sont drainés.
    NEW."updatedAt" := GREATEST(clock_timestamp(), OLD."updatedAt" + interval '1 microsecond');
  ELSE
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_TRANSITION_INVALID'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mistral_key_floor_transition';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER realtime_mistral_conversation_key_version_floor_guard
BEFORE UPDATE OR DELETE ON "realtime_mistral_conversation_key_version_floors"
FOR EACH ROW
EXECUTE FUNCTION enforce_mistral_conversation_key_version_floor();

CREATE TRIGGER realtime_mistral_conversation_key_version_floor_truncate_guard
BEFORE TRUNCATE ON "realtime_mistral_conversation_key_version_floors"
FOR EACH STATEMENT
EXECUTE FUNCTION enforce_mistral_conversation_key_version_floor();

CREATE OR REPLACE FUNCTION enforce_mistral_conversation_key_binding_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('mistral-conversation-persistence-v1', 0)
  );
  RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_BINDING_APPEND_ONLY'
    USING ERRCODE = '23514',
          CONSTRAINT = 'mistral_key_binding_append_only';
END;
$$;

CREATE TRIGGER realtime_mistral_conversation_key_binding_guard
BEFORE UPDATE OR DELETE ON "realtime_mistral_conversation_key_bindings"
FOR EACH ROW
EXECUTE FUNCTION enforce_mistral_conversation_key_binding_append_only();

CREATE TRIGGER realtime_mistral_conversation_key_binding_truncate_guard
BEFORE TRUNCATE ON "realtime_mistral_conversation_key_bindings"
FOR EACH STATEMENT
EXECUTE FUNCTION enforce_mistral_conversation_key_binding_append_only();

-- PostgreSQL accorde implicitement des privilèges à PUBLIC sur certaines classes d'objets.
-- Le rôle applicatif recevra seulement SELECT/INSERT/UPDATE pendant le rituel de release.
REVOKE ALL ON TABLE "realtime_mistral_conversation_key_version_floors" FROM PUBLIC;
REVOKE ALL ON TABLE "realtime_mistral_conversation_key_bindings" FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_mistral_conversation_key_version_floor() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_mistral_conversation_key_binding_append_only() FROM PUBLIC;

-- Le registre est global mais le rôle runtime reste strictement read-only, y compris si un ancien
-- ALTER DEFAULT PRIVILEGES lui accorde temporairement CRUD lors de la création de la table.
ALTER TABLE "realtime_mistral_conversation_key_version_floors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_mistral_conversation_key_version_floors" FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_mistral_conversation_key_version_floor_select
ON "realtime_mistral_conversation_key_version_floors"
FOR SELECT
USING (true);

-- FORCE RLS s'applique aussi au propriétaire. On autorise donc exclusivement le rôle qui a
-- exécuté la migration (le même que DIRECT_URL) à préparer/retirer une version. CURRENT_USER est
-- résolu en OID dans pg_policy à la création : le rôle runtime ne peut jamais hériter de ce droit.
CREATE POLICY realtime_mistral_conversation_key_version_floor_direct_insert
ON "realtime_mistral_conversation_key_version_floors"
FOR INSERT
TO CURRENT_USER
WITH CHECK (true);

CREATE POLICY realtime_mistral_conversation_key_version_floor_direct_update
ON "realtime_mistral_conversation_key_version_floors"
FOR UPDATE
TO CURRENT_USER
USING (true)
WITH CHECK (true);

ALTER TABLE "realtime_mistral_conversation_key_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_mistral_conversation_key_bindings" FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_mistral_conversation_key_binding_select
ON "realtime_mistral_conversation_key_bindings"
FOR SELECT
USING (true);

CREATE POLICY realtime_mistral_conversation_key_binding_direct_insert
ON "realtime_mistral_conversation_key_bindings"
FOR INSERT
TO CURRENT_USER
WITH CHECK (true);

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
       'realtime_mistral_conversation_commands'
     ) THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_GUARD_MISWIRED'
      USING ERRCODE = '55000';
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
  END IF;

  IF written_version < admitted_minimum OR written_version > admitted_highest THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_NOT_ADMITTED'
      USING ERRCODE = '23514',
            CONSTRAINT = 'realtime_mistral_conversation_key_version_range';
  END IF;

  RETURN NEW;
END;
$$;

-- Le préfixe 00 force ce garde cryptographique avant les autres triggers INSERT alphabétiques.
CREATE TRIGGER "00_realtime_mistral_conversation_outbox_key_version_guard"
BEFORE INSERT ON "realtime_mistral_conversation_outbox"
FOR EACH ROW
EXECUTE FUNCTION enforce_mistral_conversation_persistence_key_range();

CREATE TRIGGER "00_realtime_mistral_conversation_command_key_version_guard"
BEFORE INSERT ON "realtime_mistral_conversation_commands"
FOR EACH ROW
EXECUTE FUNCTION enforce_mistral_conversation_persistence_key_range();

REVOKE ALL ON FUNCTION enforce_mistral_conversation_persistence_key_range() FROM PUBLIC;

COMMIT;

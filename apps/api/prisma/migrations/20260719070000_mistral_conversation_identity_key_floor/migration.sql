-- Registre durable du keyring AEAD qui chiffre l'identité des preuves bootstrap Mistral v2.
--
-- La plage d'écriture est distincte de la persistance Mission/r2 : les deux familles ont des
-- rétentions et des writers différents. Une rotation identité ne peut donc pas emprunter le
-- plancher de persistance sans recréer une fenêtre de retrait après snapshot.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Ordre global du rituel de release : persistance puis identité. Cette migration ne prend que le
-- second verrou et bloque les INSERT bootstrap existants pendant son snapshot de backfill.
SELECT pg_advisory_xact_lock(
  hashtextextended('mistral-conversation-bootstrap-identity-v1', 0)
);

LOCK TABLE "realtime_mistral_conversation_bootstrap_tickets"
IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "realtime_mistral_conversation_identity_key_version_floors" (
  "keySpace" VARCHAR(64) NOT NULL,
  "minimumVersion" INTEGER NOT NULL,
  "highestVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mistral_identity_key_floor_pkey"
    PRIMARY KEY ("keySpace"),
  CONSTRAINT "mistral_identity_key_floor_space_check"
    CHECK ("keySpace" = 'mistral-conversation-bootstrap-identity-v1'),
  CONSTRAINT "mistral_identity_key_floor_version_check"
    CHECK (
      "minimumVersion" BETWEEN 1 AND 2147483647
      AND "highestVersion" BETWEEN "minimumVersion" AND 2147483647
      AND "highestVersion"::bigint <= "minimumVersion"::bigint + 1
    ),
  CONSTRAINT "mistral_identity_key_floor_timestamps_check"
    CHECK ("updatedAt" >= "createdAt")
);

CREATE TABLE "realtime_mistral_conversation_identity_key_bindings" (
  "keySpace" VARCHAR(64) NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "keyFingerprint" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "mistral_identity_key_binding_pkey"
    PRIMARY KEY ("keySpace", "keyVersion"),
  CONSTRAINT "mistral_identity_key_binding_fingerprint_key"
    UNIQUE ("keySpace", "keyFingerprint"),
  CONSTRAINT "mistral_identity_key_binding_space_check"
    CHECK ("keySpace" = 'mistral-conversation-bootstrap-identity-v1'),
  CONSTRAINT "mistral_identity_key_binding_value_check"
    CHECK (
      "keyVersion" BETWEEN 1 AND 2147483647
      AND "keyFingerprint"::text ~ '^[a-f0-9]{64}$'
    )
);

-- Une base dormante reste sans plage : tout premier writer échouera fermé jusqu'au stage explicite
-- du release. Une base déjà active conserve seulement une plage stable ou mixte contiguë ; tout
-- historique plus large signale une rotation non drainée que la migration ne doit pas interpréter.
DO $$
DECLARE
  observed_minimum INTEGER;
  observed_highest INTEGER;
  observed_count BIGINT;
BEGIN
  SELECT min(version), max(version), count(*)
    INTO observed_minimum, observed_highest, observed_count
    FROM (
      SELECT DISTINCT "identityEncryptionKeyVersion" AS version
        FROM public."realtime_mistral_conversation_bootstrap_tickets"
    ) AS observed_versions;

  IF observed_count > 0 THEN
    IF observed_count > 2
       OR observed_highest::bigint > observed_minimum::bigint + 1 THEN
      RAISE EXCEPTION 'MISTRAL_CONVERSATION_IDENTITY_KEY_VERSION_SEED_UNSAFE'
        USING ERRCODE = '23514',
              CONSTRAINT = 'mistral_identity_key_floor_seed';
    END IF;

    INSERT INTO public."realtime_mistral_conversation_identity_key_version_floors" (
      "keySpace", "minimumVersion", "highestVersion"
    ) VALUES (
      'mistral-conversation-bootstrap-identity-v1',
      observed_minimum,
      observed_highest
    );
  END IF;
END;
$$;

CREATE INDEX "mistral_bootstrap_identity_key_retention_idx"
  ON "realtime_mistral_conversation_bootstrap_tickets"("identityEncryptionKeyVersion");

CREATE FUNCTION enforce_mistral_conversation_identity_key_version_floor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('mistral-conversation-bootstrap-identity-v1', 0)
  );

  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_IDENTITY_KEY_VERSION_FLOOR_APPEND_ONLY'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mistral_identity_key_floor_append_only';
  END IF;

  IF NEW."keySpace" IS DISTINCT FROM OLD."keySpace"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_IDENTITY_KEY_VERSION_FLOOR_IDENTITY_IMMUTABLE'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mistral_identity_key_floor_identity_immutable';
  END IF;

  IF NEW."minimumVersion" < OLD."minimumVersion"
     OR NEW."highestVersion" < OLD."highestVersion" THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_IDENTITY_KEY_VERSION_ROLLBACK'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mistral_identity_key_floor_monotonic';
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
    -- Seule la purge de rétention fait disparaître le besoin de déchiffrer une ancienne identité.
    -- Aucun filtre state/expiration ne peut raccourcir cette autorité SQL.
    IF EXISTS (
      SELECT 1
        FROM public."realtime_mistral_conversation_bootstrap_tickets" AS bootstrap
       WHERE bootstrap."identityEncryptionKeyVersion" = OLD."minimumVersion"
    ) THEN
      RAISE EXCEPTION 'MISTRAL_CONVERSATION_IDENTITY_KEY_VERSION_RETAINED'
        USING ERRCODE = '23514',
              CONSTRAINT = 'mistral_identity_key_version_retained';
    END IF;
    NEW."updatedAt" := GREATEST(clock_timestamp(), OLD."updatedAt" + interval '1 microsecond');
  ELSE
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_IDENTITY_KEY_VERSION_TRANSITION_INVALID'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mistral_identity_key_floor_transition';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION enforce_mistral_conversation_identity_key_binding_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('mistral-conversation-bootstrap-identity-v1', 0)
  );
  RAISE EXCEPTION 'MISTRAL_CONVERSATION_IDENTITY_KEY_BINDING_APPEND_ONLY'
    USING ERRCODE = '23514',
          CONSTRAINT = 'mistral_identity_key_binding_append_only';
END;
$$;

CREATE FUNCTION enforce_mistral_conversation_identity_key_range()
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
     OR TG_TABLE_NAME <> 'realtime_mistral_conversation_bootstrap_tickets' THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_IDENTITY_KEY_VERSION_GUARD_MISWIRED'
      USING ERRCODE = '55000';
  END IF;

  -- Le lock partagé reste détenu jusqu'au COMMIT de la preuve. Un retirement commencé ensuite
  -- attend donc ce writer, puis voit nécessairement sa ligne dans le veto de rétention.
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('mistral-conversation-bootstrap-identity-v1', 0)
  );

  SELECT "minimumVersion", "highestVersion"
    INTO admitted_minimum, admitted_highest
    FROM public."realtime_mistral_conversation_identity_key_version_floors"
   WHERE "keySpace" = 'mistral-conversation-bootstrap-identity-v1';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_IDENTITY_KEY_VERSION_RANGE_UNINITIALIZED'
      USING ERRCODE = '55000',
            CONSTRAINT = 'mistral_identity_key_version_range_required';
  END IF;

  IF NEW."identityEncryptionKeyVersion" < admitted_minimum
     OR NEW."identityEncryptionKeyVersion" > admitted_highest THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_IDENTITY_KEY_VERSION_NOT_ADMITTED'
      USING ERRCODE = '23514',
            CONSTRAINT = 'mistral_identity_key_version_range';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER mistral_identity_key_version_floor_guard
BEFORE UPDATE OR DELETE
ON "realtime_mistral_conversation_identity_key_version_floors"
FOR EACH ROW
EXECUTE FUNCTION enforce_mistral_conversation_identity_key_version_floor();

CREATE TRIGGER mistral_identity_key_version_floor_truncate_guard
BEFORE TRUNCATE
ON "realtime_mistral_conversation_identity_key_version_floors"
FOR EACH STATEMENT
EXECUTE FUNCTION enforce_mistral_conversation_identity_key_version_floor();

CREATE TRIGGER mistral_identity_key_binding_guard
BEFORE UPDATE OR DELETE
ON "realtime_mistral_conversation_identity_key_bindings"
FOR EACH ROW
EXECUTE FUNCTION enforce_mistral_conversation_identity_key_binding_append_only();

CREATE TRIGGER mistral_identity_key_binding_truncate_guard
BEFORE TRUNCATE
ON "realtime_mistral_conversation_identity_key_bindings"
FOR EACH STATEMENT
EXECUTE FUNCTION enforce_mistral_conversation_identity_key_binding_append_only();

CREATE TRIGGER "00_mistral_bootstrap_identity_key_version_guard"
BEFORE INSERT ON "realtime_mistral_conversation_bootstrap_tickets"
FOR EACH ROW
EXECUTE FUNCTION enforce_mistral_conversation_identity_key_range();

REVOKE ALL ON TABLE "realtime_mistral_conversation_identity_key_version_floors" FROM PUBLIC;
REVOKE ALL ON TABLE "realtime_mistral_conversation_identity_key_bindings" FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_mistral_conversation_identity_key_version_floor() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_mistral_conversation_identity_key_binding_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_mistral_conversation_identity_key_range() FROM PUBLIC;

ALTER TABLE "realtime_mistral_conversation_identity_key_version_floors"
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_mistral_conversation_identity_key_version_floors"
  FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_mistral_identity_key_floor_select
  ON "realtime_mistral_conversation_identity_key_version_floors"
  FOR SELECT USING (true);
CREATE POLICY realtime_mistral_identity_key_floor_direct_insert
  ON "realtime_mistral_conversation_identity_key_version_floors"
  FOR INSERT TO CURRENT_USER WITH CHECK (true);
CREATE POLICY realtime_mistral_identity_key_floor_direct_update
  ON "realtime_mistral_conversation_identity_key_version_floors"
  FOR UPDATE TO CURRENT_USER USING (true) WITH CHECK (true);

ALTER TABLE "realtime_mistral_conversation_identity_key_bindings"
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_mistral_conversation_identity_key_bindings"
  FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_mistral_identity_key_binding_select
  ON "realtime_mistral_conversation_identity_key_bindings"
  FOR SELECT USING (true);
CREATE POLICY realtime_mistral_identity_key_binding_direct_insert
  ON "realtime_mistral_conversation_identity_key_bindings"
  FOR INSERT TO CURRENT_USER WITH CHECK (true);

-- Le writer tenant demeure SECURITY INVOKER et ne gagne aucun accès inter-tenant via le guard.
ALTER TABLE "realtime_mistral_conversation_bootstrap_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_mistral_conversation_bootstrap_tickets" FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE "realtime_mistral_conversation_identity_key_version_floors" IS
  'Plage durable des versions AEAD admises pour les nouvelles preuves bootstrap Mistral.';
COMMENT ON TABLE "realtime_mistral_conversation_identity_key_bindings" IS
  'Engagement SHA-256 append-only du matériau AEAD identité associé à chaque version.';
COMMENT ON TRIGGER "00_mistral_bootstrap_identity_key_version_guard"
  ON "realtime_mistral_conversation_bootstrap_tickets" IS
  'Sérialise chaque writer identité bootstrap avec stage/retire et refuse les versions hors plage.';

COMMIT;

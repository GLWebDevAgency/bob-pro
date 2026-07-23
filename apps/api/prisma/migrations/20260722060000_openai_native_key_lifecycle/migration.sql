-- Bob Live — rotation durable fournisseur-neutre des identités OpenAI natives.
--
-- Expand compatible N-1 : subjectKeyVersion reste nullable pour les lignes historiques. Les
-- nouveaux writers sont toutefois refusés tant que sujet + preuve ne sont pas stageés et liés.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL row_security = off;

SELECT pg_advisory_xact_lock(hashtextextended('bob-live-subject-hmac-v1', 0));
SELECT pg_advisory_xact_lock(hashtextextended('openai-native-speech-proof-hmac-v1', 0));

ALTER TABLE "realtime_native_speech_deliveries"
  ADD COLUMN "subjectKeyVersion" INTEGER;
ALTER TABLE "realtime_native_speech_deliveries"
  ADD CONSTRAINT "realtime_native_speech_deliveries_subject_key_version_check"
  CHECK (
    "subjectKeyVersion" IS NULL
    OR "subjectKeyVersion" BETWEEN 1 AND 2147483647
  );

CREATE INDEX "realtime_native_speech_deliveries_subject_key_version_idx"
  ON "realtime_native_speech_deliveries"("subjectKeyVersion");
CREATE INDEX "realtime_native_speech_proof_key_retention_idx"
  ON "realtime_native_speech_deliveries"("proofKeyVersion")
  WHERE phase NOT IN ('delivered', 'cancelled', 'failed', 'expired');

ALTER TABLE "realtime_mistral_conversation_key_version_floors"
  DROP CONSTRAINT "mistral_key_floor_key_space_check";
ALTER TABLE "realtime_mistral_conversation_key_version_floors"
  ADD CONSTRAINT "mistral_key_floor_key_space_check" CHECK (
    "keySpace" IN (
      'mistral-conversation-persistence-v1',
      'bob-live-subject-hmac-v1',
      'openai-native-speech-proof-hmac-v1'
    )
  );

ALTER TABLE "realtime_mistral_conversation_key_bindings"
  DROP CONSTRAINT "mistral_key_binding_key_space_check";
ALTER TABLE "realtime_mistral_conversation_key_bindings"
  ADD CONSTRAINT "mistral_key_binding_key_space_check" CHECK (
    "keySpace" IN (
      'mistral-conversation-persistence-v1',
      'bob-live-subject-hmac-v1',
      'openai-native-speech-proof-hmac-v1'
    )
  );

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
    PERFORM pg_advisory_xact_lock(hashtextextended('mistral-conversation-persistence-v1', 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('bob-live-subject-hmac-v1', 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('openai-native-speech-proof-hmac-v1', 0));
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_FLOOR_APPEND_ONLY'
      USING ERRCODE = '23514', CONSTRAINT = 'mistral_key_floor_append_only';
  END IF;

  locked_key_space := OLD."keySpace";
  IF locked_key_space NOT IN (
    'mistral-conversation-persistence-v1',
    'bob-live-subject-hmac-v1',
    'openai-native-speech-proof-hmac-v1'
  ) THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_FLOOR_IDENTITY_INVALID'
      USING ERRCODE = '23514', CONSTRAINT = 'mistral_key_floor_identity';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(locked_key_space, 0));

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_FLOOR_APPEND_ONLY'
      USING ERRCODE = '23514', CONSTRAINT = 'mistral_key_floor_append_only';
  END IF;
  IF NEW."keySpace" IS DISTINCT FROM OLD."keySpace"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_FLOOR_IDENTITY_IMMUTABLE'
      USING ERRCODE = '23514', CONSTRAINT = 'mistral_key_floor_identity_immutable';
  END IF;
  IF NEW."minimumVersion" < OLD."minimumVersion"
     OR NEW."highestVersion" < OLD."highestVersion" THEN
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_ROLLBACK'
      USING ERRCODE = '23514', CONSTRAINT = 'mistral_key_floor_monotonic';
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
         SELECT 1 FROM public."realtime_mistral_conversation_resume_tickets" AS resume
          WHERE resume."reconciliationKeyVersion" = OLD."minimumVersion"
       ) THEN
      RAISE EXCEPTION 'MISTRAL_CONVERSATION_RECONCILIATION_KEY_VERSION_RETAINED'
        USING ERRCODE = '23514', CONSTRAINT = 'mistral_reconciliation_key_version_retained';
    END IF;
    IF locked_key_space = 'bob-live-subject-hmac-v1'
       AND (
         EXISTS (SELECT 1 FROM public."realtime_mistral_conversation_bootstrap_tickets"
                  WHERE "subjectKeyVersion" = OLD."minimumVersion")
         OR EXISTS (SELECT 1 FROM public."realtime_mistral_conversation_missions"
                     WHERE "subjectKeyVersion" = OLD."minimumVersion")
         OR EXISTS (SELECT 1 FROM public."realtime_mistral_conversation_terminal_receipts"
                     WHERE "subjectKeyVersion" = OLD."minimumVersion")
         OR EXISTS (SELECT 1 FROM public."realtime_native_speech_deliveries"
                     WHERE "subjectKeyVersion" = OLD."minimumVersion"
                        OR "subjectKeyVersion" IS NULL)
       ) THEN
      RAISE EXCEPTION 'BOB_LIVE_SUBJECT_KEY_VERSION_RETAINED'
        USING ERRCODE = '23514', CONSTRAINT = 'bob_live_subject_key_version_retained';
    END IF;
    IF locked_key_space = 'openai-native-speech-proof-hmac-v1'
       AND EXISTS (
         SELECT 1 FROM public."realtime_native_speech_deliveries"
          WHERE "proofKeyVersion" = OLD."minimumVersion"
            AND phase NOT IN ('delivered', 'cancelled', 'failed', 'expired')
       ) THEN
      RAISE EXCEPTION 'OPENAI_NATIVE_PROOF_KEY_VERSION_RETAINED'
        USING ERRCODE = '23514', CONSTRAINT = 'openai_native_proof_key_version_retained';
    END IF;
    NEW."updatedAt" := GREATEST(clock_timestamp(), OLD."updatedAt" + interval '1 microsecond');
  ELSE
    RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_VERSION_TRANSITION_INVALID'
      USING ERRCODE = '23514', CONSTRAINT = 'mistral_key_floor_transition';
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
    PERFORM pg_advisory_xact_lock(hashtextextended('mistral-conversation-persistence-v1', 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('bob-live-subject-hmac-v1', 0));
    PERFORM pg_advisory_xact_lock(hashtextextended('openai-native-speech-proof-hmac-v1', 0));
  ELSE
    locked_key_space := OLD."keySpace";
    IF locked_key_space NOT IN (
      'mistral-conversation-persistence-v1',
      'bob-live-subject-hmac-v1',
      'openai-native-speech-proof-hmac-v1'
    ) THEN
      RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_BINDING_IDENTITY_INVALID'
        USING ERRCODE = '23514', CONSTRAINT = 'mistral_key_binding_identity';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(locked_key_space, 0));
  END IF;
  RAISE EXCEPTION 'MISTRAL_CONVERSATION_KEY_BINDING_APPEND_ONLY'
    USING ERRCODE = '23514', CONSTRAINT = 'mistral_key_binding_append_only';
END;
$$;

CREATE OR REPLACE FUNCTION retained_bob_live_subject_hmac_key_bindings()
RETURNS TABLE ("keyVersion" INTEGER, "keyFingerprint" TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  WITH legacy_native AS (
    SELECT EXISTS (
      SELECT 1 FROM public.realtime_native_speech_deliveries
       WHERE "subjectKeyVersion" IS NULL
    ) AS present
  ), retained_versions AS (
    SELECT "subjectKeyVersion" AS version
      FROM public.realtime_mistral_conversation_bootstrap_tickets
    UNION SELECT "subjectKeyVersion" FROM public.realtime_mistral_conversation_missions
    UNION SELECT "subjectKeyVersion" FROM public.realtime_mistral_conversation_terminal_receipts
    UNION SELECT "subjectKeyVersion" FROM public.realtime_native_speech_deliveries
           WHERE "subjectKeyVersion" IS NOT NULL
    UNION SELECT binding."keyVersion"
            FROM public.realtime_mistral_conversation_key_bindings AS binding, legacy_native
           WHERE legacy_native.present
             AND binding."keySpace" = 'bob-live-subject-hmac-v1'
  )
  SELECT retained.version AS "keyVersion", binding."keyFingerprint"::text AS "keyFingerprint"
    FROM retained_versions AS retained
    LEFT JOIN public.realtime_mistral_conversation_key_bindings AS binding
      ON binding."keySpace" = 'bob-live-subject-hmac-v1'
     AND binding."keyVersion" = retained.version
   ORDER BY retained.version
$$;

CREATE FUNCTION retained_openai_native_proof_hmac_key_bindings()
RETURNS TABLE ("keyVersion" INTEGER, "keyFingerprint" TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = off
AS $$
  WITH retained AS (
    SELECT DISTINCT "proofKeyVersion" AS version
      FROM public.realtime_native_speech_deliveries
     WHERE phase NOT IN ('delivered', 'cancelled', 'failed', 'expired')
  )
  SELECT retained.version AS "keyVersion", binding."keyFingerprint"::text AS "keyFingerprint"
    FROM retained
    LEFT JOIN public.realtime_mistral_conversation_key_bindings AS binding
      ON binding."keySpace" = 'openai-native-speech-proof-hmac-v1'
     AND binding."keyVersion" = retained.version
   ORDER BY retained.version
$$;

CREATE OR REPLACE FUNCTION guard_realtime_native_delivery_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  terminal_phases CONSTANT TEXT[] := ARRAY['delivered', 'cancelled', 'failed', 'expired'];
  database_now TIMESTAMPTZ := clock_timestamp();
  admitted_minimum INTEGER;
  admitted_highest INTEGER;
BEGIN
  IF NULLIF(current_setting('app.current_company_id', true), '') IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'realtime native delivery tenant context rejected' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."phase" <> 'prepared' OR NEW."version" <> 1 OR NEW."revision" <> 1
       OR NEW."subjectKeyVersion" IS NULL
       OR NEW."createdAt" > database_now + INTERVAL '1 minute'
       OR NEW."expiresAt" <= database_now THEN
      RAISE EXCEPTION 'realtime native delivery must start prepared' USING ERRCODE = '55000';
    END IF;

    PERFORM pg_advisory_xact_lock_shared(hashtextextended('bob-live-subject-hmac-v1', 0));
    SELECT "minimumVersion", "highestVersion" INTO admitted_minimum, admitted_highest
      FROM public."realtime_mistral_conversation_key_version_floors"
     WHERE "keySpace" = 'bob-live-subject-hmac-v1';
    IF NOT FOUND OR NEW."subjectKeyVersion" NOT BETWEEN admitted_minimum AND admitted_highest
       OR NOT EXISTS (
         SELECT 1 FROM public."realtime_mistral_conversation_key_bindings"
          WHERE "keySpace" = 'bob-live-subject-hmac-v1'
            AND "keyVersion" = NEW."subjectKeyVersion"
       ) THEN
      RAISE EXCEPTION 'realtime native delivery subject key is not admitted and bound'
        USING ERRCODE = '55000';
    END IF;

    PERFORM pg_advisory_xact_lock_shared(
      hashtextextended('openai-native-speech-proof-hmac-v1', 0)
    );
    SELECT "minimumVersion", "highestVersion" INTO admitted_minimum, admitted_highest
      FROM public."realtime_mistral_conversation_key_version_floors"
     WHERE "keySpace" = 'openai-native-speech-proof-hmac-v1';
    IF NOT FOUND OR NEW."proofKeyVersion" NOT BETWEEN admitted_minimum AND admitted_highest
       OR NOT EXISTS (
         SELECT 1 FROM public."realtime_mistral_conversation_key_bindings"
          WHERE "keySpace" = 'openai-native-speech-proof-hmac-v1'
            AND "keyVersion" = NEW."proofKeyVersion"
       ) THEN
      RAISE EXCEPTION 'realtime native delivery proof key is not admitted and bound'
        USING ERRCODE = '55000';
    END IF;

    PERFORM public.assert_realtime_native_delivery_fence_v1(
      NEW."companyId", NEW."subjectHmac", NEW."sessionId", NEW."provider",
      NEW."contextRevision", NEW."contextDigest",
      NEW."sidebandOwnerTokenHmac", NEW."sidebandOwnerEpoch"
    );
    RETURN NEW;
  END IF;

  IF OLD."phase" = ANY(terminal_phases) THEN
    RAISE EXCEPTION 'terminal realtime native delivery is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."phase" = 'expired' THEN
    IF database_now < OLD."expiresAt" THEN
      RAISE EXCEPTION 'realtime native delivery cannot expire before its database deadline'
        USING ERRCODE = '55000';
    END IF;
  ELSIF database_now >= OLD."expiresAt" THEN
    RAISE EXCEPTION 'realtime native delivery deadline elapsed' USING ERRCODE = '55000';
  END IF;

  IF ROW(
    NEW."deliveryId", NEW."companyId", NEW."subjectHmac", NEW."subjectKeyVersion",
    NEW."sessionId", NEW."turnId", NEW."contextRevision", NEW."contextDigest",
    NEW."sidebandOwnerEpoch", NEW."sidebandOwnerTokenHmac", NEW."speechPolicyVersion",
    NEW."speechScenarioId", NEW."canonicalSpeechHmac", NEW."factsHmac",
    NEW."requestNonceHmac", NEW."proofFormatVersion", NEW."proofKeyVersion",
    NEW."provider", NEW."model", NEW."voice", NEW."version", NEW."createdAt",
    NEW."expiresAt", NEW."retentionExpiresAt"
  ) IS DISTINCT FROM ROW(
    OLD."deliveryId", OLD."companyId", OLD."subjectHmac", OLD."subjectKeyVersion",
    OLD."sessionId", OLD."turnId", OLD."contextRevision", OLD."contextDigest",
    OLD."sidebandOwnerEpoch", OLD."sidebandOwnerTokenHmac", OLD."speechPolicyVersion",
    OLD."speechScenarioId", OLD."canonicalSpeechHmac", OLD."factsHmac",
    OLD."requestNonceHmac", OLD."proofFormatVersion", OLD."proofKeyVersion",
    OLD."provider", OLD."model", OLD."voice", OLD."version", OLD."createdAt",
    OLD."expiresAt", OLD."retentionExpiresAt"
  ) THEN
    RAISE EXCEPTION 'realtime native delivery authority evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF (OLD."dispatchClaimId" IS NOT NULL AND NEW."dispatchClaimId" IS DISTINCT FROM OLD."dispatchClaimId")
     OR (OLD."providerResponseIdHmac" IS NOT NULL AND NEW."providerResponseIdHmac" IS DISTINCT FROM OLD."providerResponseIdHmac")
     OR (OLD."outputTranscriptHmac" IS NOT NULL AND NEW."outputTranscriptHmac" IS DISTINCT FROM OLD."outputTranscriptHmac")
     OR (OLD."acknowledgementId" IS NOT NULL AND NEW."acknowledgementId" IS DISTINCT FROM OLD."acknowledgementId")
     OR (OLD."cancellationId" IS NOT NULL AND NEW."cancellationId" IS DISTINCT FROM OLD."cancellationId")
     OR (OLD."cancellationReason" IS NOT NULL AND NEW."cancellationReason" IS DISTINCT FROM OLD."cancellationReason")
     OR (OLD."failureId" IS NOT NULL AND NEW."failureId" IS DISTINCT FROM OLD."failureId")
     OR (OLD."failureReason" IS NOT NULL AND NEW."failureReason" IS DISTINCT FROM OLD."failureReason") THEN
    RAISE EXCEPTION 'realtime native delivery proof cannot be rewritten' USING ERRCODE = '55000';
  END IF;
  IF (OLD."dispatchingAt" IS NOT NULL AND NEW."dispatchingAt" IS DISTINCT FROM OLD."dispatchingAt")
     OR (OLD."requestedAt" IS NOT NULL AND NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt")
     OR (OLD."acceptedAt" IS NOT NULL AND NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt")
     OR (OLD."streamingAt" IS NOT NULL AND NEW."streamingAt" IS DISTINCT FROM OLD."streamingAt")
     OR (OLD."responseDoneAt" IS NOT NULL AND NEW."responseDoneAt" IS DISTINCT FROM OLD."responseDoneAt")
     OR (OLD."outputStoppedAt" IS NOT NULL AND NEW."outputStoppedAt" IS DISTINCT FROM OLD."outputStoppedAt")
     OR (OLD."completedAt" IS NOT NULL AND NEW."completedAt" IS DISTINCT FROM OLD."completedAt")
     OR (OLD."deliveredAt" IS NOT NULL AND NEW."deliveredAt" IS DISTINCT FROM OLD."deliveredAt")
     OR (OLD."terminalAt" IS NOT NULL AND NEW."terminalAt" IS DISTINCT FROM OLD."terminalAt") THEN
    RAISE EXCEPTION 'realtime native delivery timeline is append-only' USING ERRCODE = '55000';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'realtime native delivery CAS revision is not monotone' USING ERRCODE = '40001';
  END IF;
  IF NEW."phase" = ANY(terminal_phases)
     AND ROW(NEW."dispatchClaimId", NEW."dispatchingAt", NEW."requestedAt",
       NEW."providerResponseIdHmac", NEW."acceptedAt", NEW."streamingAt",
       NEW."responseDoneAt", NEW."outputStoppedAt", NEW."outputTranscriptHmac", NEW."completedAt")
       IS DISTINCT FROM ROW(OLD."dispatchClaimId", OLD."dispatchingAt", OLD."requestedAt",
       OLD."providerResponseIdHmac", OLD."acceptedAt", OLD."streamingAt",
       OLD."responseDoneAt", OLD."outputStoppedAt", OLD."outputTranscriptHmac", OLD."completedAt") THEN
    RAISE EXCEPTION 'terminal realtime native event cannot fabricate provider progress'
      USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD."phase" = 'prepared' AND NEW."phase" IN ('dispatching', 'cancelled', 'failed', 'expired'))
    OR (OLD."phase" = 'dispatching' AND NEW."phase" IN ('requested', 'cancelled', 'failed', 'expired'))
    OR (OLD."phase" = 'requested' AND NEW."phase" IN ('accepted', 'cancelled', 'failed', 'expired'))
    OR (OLD."phase" = 'accepted' AND NEW."phase" IN ('streaming', 'cancelled', 'failed', 'expired'))
    OR (OLD."phase" = 'streaming' AND NEW."phase" IN ('draining', 'cancelled', 'failed', 'expired'))
    OR (OLD."phase" = 'draining' AND NEW."phase" IN ('completed', 'cancelled', 'failed', 'expired'))
    OR (OLD."phase" = 'completed' AND NEW."phase" IN ('delivered', 'cancelled', 'failed', 'expired'))
  ) THEN
    RAISE EXCEPTION 'invalid realtime native delivery transition % -> %', OLD."phase", NEW."phase"
      USING ERRCODE = '55000';
  END IF;
  IF NEW."phase" NOT IN ('cancelled', 'failed', 'expired') THEN
    PERFORM public.assert_realtime_native_delivery_fence_v1(
      NEW."companyId", NEW."subjectHmac", NEW."sessionId", NEW."provider",
      NEW."contextRevision", NEW."contextDigest",
      NEW."sidebandOwnerTokenHmac", NEW."sidebandOwnerEpoch"
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION retained_openai_native_proof_hmac_key_bindings() FROM PUBLIC;
REVOKE ALL ON FUNCTION retained_bob_live_subject_hmac_key_bindings() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_mistral_conversation_key_version_floor() FROM PUBLIC;
REVOKE ALL ON FUNCTION enforce_mistral_conversation_key_binding_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_realtime_native_delivery_v1() FROM PUBLIC;

COMMENT ON COLUMN "realtime_native_speech_deliveries"."subjectKeyVersion" IS
  'Version HMAC sujet durable. NULL signifie uniquement writer N-1 historique, jamais un défaut.';
COMMENT ON FUNCTION retained_openai_native_proof_hmac_key_bindings() IS
  'Expose uniquement version et empreinte des preuves natives non terminales requises au boot.';

COMMIT;

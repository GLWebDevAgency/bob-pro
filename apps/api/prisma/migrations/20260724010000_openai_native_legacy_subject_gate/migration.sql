-- Bob Live OpenAI natif — vraie compatibilité rolling N-1 du HMAC sujet.
--
-- `20260722060000` a rendu subjectKeyVersion nullable mais refusait NULL dans son trigger
-- d'insertion. Ce successeur append-only matérialise une fenêtre legacy monotone. Le writer N
-- continue d'écrire une version exacte ; le writer N-1 n'est admis que tant que le gate est ouvert.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL row_security = off;

SELECT pg_advisory_xact_lock(hashtextextended('bob-live-subject-hmac-v1', 0));
SELECT pg_advisory_xact_lock(hashtextextended('openai-native-speech-proof-hmac-v1', 0));

CREATE TABLE public.realtime_native_legacy_subject_admission (
  gate TEXT NOT NULL,
  phase TEXT NOT NULL,
  revision INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL,
  "closedAt" TIMESTAMPTZ(6),

  CONSTRAINT realtime_native_legacy_subject_admission_pkey PRIMARY KEY (gate),
  CONSTRAINT realtime_native_legacy_subject_admission_singleton_check
    CHECK (gate = 'subject-null-v1'),
  CONSTRAINT realtime_native_legacy_subject_admission_phase_check
    CHECK (phase IN ('open', 'closed')),
  CONSTRAINT realtime_native_legacy_subject_admission_revision_check
    CHECK (revision BETWEEN 1 AND 2147483647),
  CONSTRAINT realtime_native_legacy_subject_admission_shape_check
    CHECK (
      (phase = 'open' AND revision = 1 AND "closedAt" IS NULL)
      OR (
        phase = 'closed'
        AND revision = 2
        AND "closedAt" IS NOT NULL
        AND "closedAt" >= "createdAt"
      )
    )
);

INSERT INTO public.realtime_native_legacy_subject_admission (
  gate, phase, revision, "createdAt", "closedAt"
) VALUES (
  'subject-null-v1', 'open', 1, clock_timestamp(), NULL
);

CREATE FUNCTION public.guard_realtime_native_legacy_subject_admission_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bob-live-subject-hmac-v1', 0));

  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'realtime native legacy subject admission is append-only'
      USING ERRCODE = '23514',
            CONSTRAINT = 'realtime_native_legacy_subject_admission_append_only';
  END IF;

  IF OLD.gate <> 'subject-null-v1'
     OR NEW.gate IS DISTINCT FROM OLD.gate
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'realtime native legacy subject admission identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'realtime_native_legacy_subject_admission_identity';
  END IF;

  IF OLD.phase <> 'open'
     OR OLD.revision <> 1
     OR OLD."closedAt" IS NOT NULL
     OR NEW.phase <> 'closed'
     OR NEW.revision <> 2
     OR NEW."closedAt" IS NOT NULL
  THEN
    RAISE EXCEPTION 'realtime native legacy subject admission transition is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'realtime_native_legacy_subject_admission_monotonic';
  END IF;

  NEW."closedAt" := GREATEST(clock_timestamp(), OLD."createdAt");
  RETURN NEW;
END;
$$;

CREATE TRIGGER realtime_native_legacy_subject_admission_row_guard_v1
BEFORE INSERT OR UPDATE OR DELETE
ON public.realtime_native_legacy_subject_admission
FOR EACH ROW
EXECUTE FUNCTION public.guard_realtime_native_legacy_subject_admission_v1();

CREATE TRIGGER realtime_native_legacy_subject_admission_truncate_guard_v1
BEFORE TRUNCATE
ON public.realtime_native_legacy_subject_admission
FOR EACH STATEMENT
EXECUTE FUNCTION public.guard_realtime_native_legacy_subject_admission_v1();

-- Remplace uniquement le corps du trigger existant. Les transitions, preuves et fences de
-- `20260722060000` restent identiques ; seule l'admission INSERT de subjectKeyVersion NULL est
-- corrigée et sérialisée avec la fermeture du gate.
CREATE OR REPLACE FUNCTION public.guard_realtime_native_delivery_v1()
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
  legacy_subject_admission_open BOOLEAN;
BEGIN
  IF NULLIF(current_setting('app.current_company_id', true), '') IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'realtime native delivery tenant context rejected' USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."phase" <> 'prepared' OR NEW."version" <> 1 OR NEW."revision" <> 1
       OR NEW."createdAt" > database_now + INTERVAL '1 minute'
       OR NEW."expiresAt" <= database_now THEN
      RAISE EXCEPTION 'realtime native delivery must start prepared' USING ERRCODE = '55000';
    END IF;

    PERFORM pg_advisory_xact_lock_shared(hashtextextended('bob-live-subject-hmac-v1', 0));
    IF NEW."subjectKeyVersion" IS NULL THEN
      SELECT gate.phase = 'open'
        INTO legacy_subject_admission_open
        FROM public.realtime_native_legacy_subject_admission AS gate
       WHERE gate.gate = 'subject-null-v1';
      IF legacy_subject_admission_open IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'realtime native legacy subject admission is closed'
          USING ERRCODE = '55000',
                CONSTRAINT = 'realtime_native_legacy_subject_admission_closed';
      END IF;
    ELSE
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

REVOKE ALL ON TABLE public.realtime_native_legacy_subject_admission FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_realtime_native_legacy_subject_admission_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_realtime_native_delivery_v1() FROM PUBLIC;

-- Une release antérieure peut avoir installé une default ACL runtime sur les nouvelles tables ou
-- fonctions. La migration retire donc elle-même toute autorité non propriétaire avant son COMMIT :
-- aucun ancien pod n'observe une fenêtre permissive entre migrate deploy et grant_app_role.
DO $$
DECLARE
  grantee_sql TEXT;
  acl_record RECORD;
BEGIN
  FOR grantee_sql IN
    SELECT DISTINCT CASE
      WHEN privilege.grantee = 0 THEN 'PUBLIC'
      ELSE quote_ident(grantee_role.rolname)
    END
      FROM pg_catalog.pg_class AS relation
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
     ) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantee_role
        ON grantee_role.oid = privilege.grantee
     WHERE relation.oid =
       'public.realtime_native_legacy_subject_admission'::regclass
       AND privilege.grantee <> relation.relowner
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE public.realtime_native_legacy_subject_admission FROM %s CASCADE',
      grantee_sql
    );
  END LOOP;

  FOR acl_record IN
    SELECT DISTINCT
      function.oid::regprocedure::text AS function_sql,
      CASE
        WHEN privilege.grantee = 0 THEN 'PUBLIC'
        ELSE quote_ident(grantee_role.rolname)
      END AS grantee_sql
      FROM pg_catalog.pg_proc AS function
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(function.proacl, pg_catalog.acldefault('f', function.proowner))
     ) AS privilege
      LEFT JOIN pg_catalog.pg_roles AS grantee_role
        ON grantee_role.oid = privilege.grantee
     WHERE function.oid IN (
       'public.guard_realtime_native_legacy_subject_admission_v1()'::regprocedure,
       'public.guard_realtime_native_delivery_v1()'::regprocedure
     )
       AND privilege.grantee <> function.proowner
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s CASCADE',
      acl_record.function_sql,
      acl_record.grantee_sql
    );
  END LOOP;
END;
$$;

COMMENT ON TABLE public.realtime_native_legacy_subject_admission IS
  'Gate global monotone autorisant temporairement les writers natifs N-1 sans version HMAC sujet.';
COMMENT ON COLUMN public.realtime_native_legacy_subject_admission.phase IS
  'open autorise subjectKeyVersion NULL; closed est terminal et irréversible.';

COMMIT;

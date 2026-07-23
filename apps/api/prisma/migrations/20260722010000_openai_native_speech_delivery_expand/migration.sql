-- Bob Live GPT Realtime natif — registre durable expand-first.
--
-- Cette migration reste compatible avec les writers N-1 : les contrôles historiques omettent
-- deliveryKind/bindingVersion et reçoivent audited_artifact/v1 par défaut. Aucun texte, audio,
-- transcript brut ni identifiant utilisateur n'est persisté dans le registre natif.

BEGIN;

CREATE TABLE "realtime_native_speech_deliveries" (
  "deliveryId" UUID NOT NULL,
  "companyId" TEXT NOT NULL,
  "subjectHmac" CHAR(64) NOT NULL,
  "sessionId" UUID NOT NULL,
  "turnId" UUID NOT NULL,
  "contextRevision" INTEGER NOT NULL,
  "contextDigest" CHAR(64) NOT NULL,
  "sidebandOwnerEpoch" INTEGER NOT NULL,
  "sidebandOwnerTokenHmac" CHAR(64) NOT NULL,
  "speechPolicyVersion" INTEGER NOT NULL,
  "speechScenarioId" TEXT NOT NULL,
  "canonicalSpeechHmac" CHAR(64) NOT NULL,
  "factsHmac" CHAR(64) NOT NULL,
  "requestNonceHmac" CHAR(64) NOT NULL,
  "proofFormatVersion" INTEGER NOT NULL,
  "proofKeyVersion" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "voice" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "phase" TEXT NOT NULL,
  "dispatchClaimId" UUID,
  "dispatchingAt" TIMESTAMPTZ(3),
  "requestedAt" TIMESTAMPTZ(3),
  "providerResponseIdHmac" CHAR(64),
  "acceptedAt" TIMESTAMPTZ(3),
  "streamingAt" TIMESTAMPTZ(3),
  "responseDoneAt" TIMESTAMPTZ(3),
  "outputStoppedAt" TIMESTAMPTZ(3),
  "outputTranscriptHmac" CHAR(64),
  "completedAt" TIMESTAMPTZ(3),
  "acknowledgementId" UUID,
  "deliveredAt" TIMESTAMPTZ(3),
  "sloFormatVersion" INTEGER,
  "speechStoppedEventToFirstInboundRtpMs" INTEGER,
  "bargeInStatus" TEXT,
  "bargeInDurationsMs" INTEGER[] NOT NULL DEFAULT '{}'::INTEGER[],
  "cancellationId" UUID,
  "cancellationReason" TEXT,
  "failureId" UUID,
  "failureReason" TEXT,
  "terminalAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "retentionExpiresAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "realtime_native_speech_deliveries_pkey" PRIMARY KEY ("deliveryId"),
  CONSTRAINT "realtime_native_speech_deliveries_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "realtime_native_speech_deliveries_request_nonce_hmac_key"
    UNIQUE ("requestNonceHmac"),
  CONSTRAINT "realtime_native_speech_deliveries_dispatch_claim_id_key"
    UNIQUE ("dispatchClaimId"),
  CONSTRAINT "realtime_native_speech_deliveries_acknowledgement_id_key"
    UNIQUE ("acknowledgementId"),
  CONSTRAINT "realtime_native_speech_deliveries_cancellation_id_key"
    UNIQUE ("cancellationId"),
  CONSTRAINT "realtime_native_speech_deliveries_failure_id_key"
    UNIQUE ("failureId"),
  CONSTRAINT "realtime_native_speech_deliveries_turn_key"
    UNIQUE ("companyId", "sessionId", "turnId"),
  CONSTRAINT "realtime_native_speech_deliveries_tenant_binding_key"
    UNIQUE ("deliveryId", "companyId", "sessionId", "turnId"),
  CONSTRAINT "realtime_native_speech_deliveries_provider_response_key"
    UNIQUE ("provider", "providerResponseIdHmac"),
  CONSTRAINT "realtime_native_speech_deliveries_phase_check"
    CHECK ("phase" IN (
      'prepared', 'dispatching', 'requested', 'accepted', 'streaming', 'draining',
      'completed', 'delivered', 'cancelled', 'failed', 'expired'
    )),
  CONSTRAINT "realtime_native_speech_deliveries_dimension_check"
    CHECK (
      "companyId" ~ '^[A-Za-z0-9-]{1,64}$'
      AND "subjectHmac"::TEXT ~ '^[a-f0-9]{64}$'
      AND "contextRevision" BETWEEN 1 AND 2147483647
      AND "contextDigest"::TEXT ~ '^[a-f0-9]{64}$'
      AND "sidebandOwnerEpoch" BETWEEN 1 AND 2147483647
      AND "sidebandOwnerTokenHmac"::TEXT ~ '^[a-f0-9]{64}$'
      AND "speechPolicyVersion" = 1
      AND "speechScenarioId" IN ('generic_help_v1', 'generic_unknown_v1')
      AND "canonicalSpeechHmac"::TEXT ~ '^[a-f0-9]{64}$'
      AND "factsHmac"::TEXT ~ '^[a-f0-9]{64}$'
      AND "requestNonceHmac"::TEXT ~ '^[a-f0-9]{64}$'
      AND "proofFormatVersion" = 2
      AND "proofKeyVersion" BETWEEN 1 AND 2147483647
      AND "provider" = 'openai'
      AND "model" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
      AND "voice" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'
      AND "version" = 1
      AND "revision" BETWEEN 1 AND 2147483647
      AND "deliveryId"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "sessionId"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND "turnId"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND (
        "dispatchClaimId" IS NULL
        OR "dispatchClaimId"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
      AND (
        "acknowledgementId" IS NULL
        OR "acknowledgementId"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
      AND (
        "cancellationId" IS NULL
        OR "cancellationId"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
      AND (
        "failureId" IS NULL
        OR "failureId"::TEXT ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
      AND (
        "providerResponseIdHmac" IS NULL
        OR "providerResponseIdHmac"::TEXT ~ '^[a-f0-9]{64}$'
      )
      AND (
        "outputTranscriptHmac" IS NULL
        OR "outputTranscriptHmac"::TEXT ~ '^[a-f0-9]{64}$'
      )
      AND "expiresAt" > "createdAt"
      AND "expiresAt" <= "createdAt" + INTERVAL '5 minutes'
      AND "retentionExpiresAt" > "expiresAt"
      AND "retentionExpiresAt" <= "createdAt" + INTERVAL '31 days'
    ),
  CONSTRAINT "realtime_native_speech_deliveries_finite_timestamps_check"
    CHECK (
      isfinite("createdAt")
      AND isfinite("expiresAt")
      AND isfinite("retentionExpiresAt")
      AND ("dispatchingAt" IS NULL OR isfinite("dispatchingAt"))
      AND ("requestedAt" IS NULL OR isfinite("requestedAt"))
      AND ("acceptedAt" IS NULL OR isfinite("acceptedAt"))
      AND ("streamingAt" IS NULL OR isfinite("streamingAt"))
      AND ("responseDoneAt" IS NULL OR isfinite("responseDoneAt"))
      AND ("outputStoppedAt" IS NULL OR isfinite("outputStoppedAt"))
      AND ("completedAt" IS NULL OR isfinite("completedAt"))
      AND ("deliveredAt" IS NULL OR isfinite("deliveredAt"))
      AND ("terminalAt" IS NULL OR isfinite("terminalAt"))
    ),
  CONSTRAINT "realtime_native_speech_deliveries_reason_check"
    CHECK (
      (
        "cancellationReason" IS NULL
        OR "cancellationReason" IN (
          'barge_in', 'user_cancel', 'context_changed', 'session_end', 'superseded'
        )
      )
      AND (
        "failureReason" IS NULL
        OR "failureReason" IN (
          'provider_rejected', 'provider_failed', 'speech_mismatch',
          'protocol_violation', 'owner_lost', 'context_changed', 'internal_error'
        )
      )
    ),
  CONSTRAINT "realtime_native_speech_deliveries_progress_check"
    CHECK (
      (("dispatchClaimId" IS NULL) = ("dispatchingAt" IS NULL))
      AND ("dispatchingAt" IS NULL OR "dispatchingAt" >= "createdAt")
      AND (
        "requestedAt" IS NULL
        OR ("dispatchingAt" IS NOT NULL AND "requestedAt" >= "dispatchingAt")
      )
      AND (
        "acceptedAt" IS NULL
        OR (
          "requestedAt" IS NOT NULL
          AND "providerResponseIdHmac" IS NOT NULL
          AND "acceptedAt" >= "requestedAt"
        )
      )
      AND (("acceptedAt" IS NULL) = ("providerResponseIdHmac" IS NULL))
      AND (
        "streamingAt" IS NULL
        OR ("acceptedAt" IS NOT NULL AND "streamingAt" >= "acceptedAt")
      )
      AND (
        "responseDoneAt" IS NULL
        OR ("streamingAt" IS NOT NULL AND "responseDoneAt" >= "streamingAt")
      )
      AND (("responseDoneAt" IS NULL) = ("outputTranscriptHmac" IS NULL))
      AND (
        "outputTranscriptHmac" IS NULL
        OR "outputTranscriptHmac" = "canonicalSpeechHmac"
      )
      AND (
        "outputStoppedAt" IS NULL
        OR ("streamingAt" IS NOT NULL AND "outputStoppedAt" >= "streamingAt")
      )
      AND (
        "completedAt" IS NULL
        OR (
          "responseDoneAt" IS NOT NULL
          AND "outputStoppedAt" IS NOT NULL
          AND "completedAt" >= GREATEST("responseDoneAt", "outputStoppedAt")
        )
      )
      AND (
        ("responseDoneAt" IS NOT NULL AND "outputStoppedAt" IS NOT NULL)
        = ("completedAt" IS NOT NULL)
      )
      AND ("dispatchingAt" IS NULL OR "dispatchingAt" < "expiresAt")
      AND ("requestedAt" IS NULL OR "requestedAt" < "expiresAt")
      AND ("acceptedAt" IS NULL OR "acceptedAt" < "expiresAt")
      AND ("streamingAt" IS NULL OR "streamingAt" < "expiresAt")
      AND ("responseDoneAt" IS NULL OR "responseDoneAt" < "expiresAt")
      AND ("outputStoppedAt" IS NULL OR "outputStoppedAt" < "expiresAt")
      AND ("completedAt" IS NULL OR "completedAt" < "expiresAt")
      AND ("deliveredAt" IS NULL OR "deliveredAt" >= "completedAt")
      AND (("acknowledgementId" IS NULL) = ("deliveredAt" IS NULL))
      AND (("cancellationId" IS NULL) = ("cancellationReason" IS NULL))
      AND (("failureId" IS NULL) = ("failureReason" IS NULL))
      AND (
        "terminalAt" IS NOT NULL
        OR (
          "acknowledgementId" IS NULL AND "deliveredAt" IS NULL
          AND "cancellationId" IS NULL AND "cancellationReason" IS NULL
          AND "failureId" IS NULL AND "failureReason" IS NULL
        )
      )
      AND (
        "terminalAt" IS NULL
        OR "terminalAt" >= GREATEST(
          "createdAt",
          COALESCE("dispatchingAt", "createdAt"),
          COALESCE("requestedAt", "createdAt"),
          COALESCE("acceptedAt", "createdAt"),
          COALESCE("streamingAt", "createdAt"),
          COALESCE("responseDoneAt", "createdAt"),
          COALESCE("outputStoppedAt", "createdAt"),
          COALESCE("completedAt", "createdAt")
        )
      )
    ),
  CONSTRAINT "realtime_native_speech_deliveries_phase_shape_check"
    CHECK (
      (
        "phase" = 'prepared'
        AND "dispatchClaimId" IS NULL AND "requestedAt" IS NULL
        AND "providerResponseIdHmac" IS NULL AND "streamingAt" IS NULL
        AND "responseDoneAt" IS NULL AND "outputStoppedAt" IS NULL
        AND "completedAt" IS NULL AND "terminalAt" IS NULL
      ) OR (
        "phase" = 'dispatching'
        AND "dispatchClaimId" IS NOT NULL AND "requestedAt" IS NULL
        AND "providerResponseIdHmac" IS NULL AND "streamingAt" IS NULL
        AND "responseDoneAt" IS NULL AND "outputStoppedAt" IS NULL
        AND "completedAt" IS NULL AND "terminalAt" IS NULL
      ) OR (
        "phase" = 'requested'
        AND "requestedAt" IS NOT NULL AND "providerResponseIdHmac" IS NULL
        AND "streamingAt" IS NULL AND "responseDoneAt" IS NULL
        AND "outputStoppedAt" IS NULL AND "completedAt" IS NULL AND "terminalAt" IS NULL
      ) OR (
        "phase" = 'accepted'
        AND "acceptedAt" IS NOT NULL AND "streamingAt" IS NULL
        AND "responseDoneAt" IS NULL AND "outputStoppedAt" IS NULL
        AND "completedAt" IS NULL AND "terminalAt" IS NULL
      ) OR (
        "phase" = 'streaming'
        AND "streamingAt" IS NOT NULL
        AND "responseDoneAt" IS NULL AND "outputStoppedAt" IS NULL
        AND "completedAt" IS NULL AND "terminalAt" IS NULL
      ) OR (
        "phase" = 'draining'
        AND "streamingAt" IS NOT NULL
        AND (("responseDoneAt" IS NULL) <> ("outputStoppedAt" IS NULL))
        AND "completedAt" IS NULL AND "terminalAt" IS NULL
      ) OR (
        "phase" = 'completed'
        AND "streamingAt" IS NOT NULL
        AND "responseDoneAt" IS NOT NULL AND "outputStoppedAt" IS NOT NULL
        AND "completedAt" IS NOT NULL AND "terminalAt" IS NULL
      ) OR (
        "phase" = 'delivered'
        AND "completedAt" IS NOT NULL AND "acknowledgementId" IS NOT NULL
        AND "deliveredAt" IS NOT NULL AND "terminalAt" = "deliveredAt"
        AND "terminalAt" < "expiresAt"
        AND "cancellationId" IS NULL AND "failureId" IS NULL
      ) OR (
        "phase" = 'cancelled'
        AND "cancellationId" IS NOT NULL AND "terminalAt" IS NOT NULL
        AND "terminalAt" < "expiresAt"
        AND "acknowledgementId" IS NULL AND "failureId" IS NULL
      ) OR (
        "phase" = 'failed'
        AND "failureId" IS NOT NULL AND "terminalAt" IS NOT NULL
        AND "terminalAt" < "expiresAt"
        AND "acknowledgementId" IS NULL AND "cancellationId" IS NULL
      ) OR (
        "phase" = 'expired'
        AND "terminalAt" IS NOT NULL AND "terminalAt" >= "expiresAt"
        AND "acknowledgementId" IS NULL
        AND "cancellationId" IS NULL AND "failureId" IS NULL
      )
    ),
  CONSTRAINT "realtime_native_speech_deliveries_slo_shape_check"
    CHECK (
      (
        "sloFormatVersion" IS NULL
        AND "speechStoppedEventToFirstInboundRtpMs" IS NULL
        AND "bargeInStatus" IS NULL
        AND cardinality("bargeInDurationsMs") = 0
      )
      OR (
        "phase" = 'delivered'
        AND "sloFormatVersion" = 1
        AND ("speechStoppedEventToFirstInboundRtpMs" IS NOT NULL OR "bargeInStatus" IS NOT NULL)
        AND (
          "speechStoppedEventToFirstInboundRtpMs" IS NULL
          OR "speechStoppedEventToFirstInboundRtpMs" BETWEEN 0 AND 60000
        )
        AND (
          (
            "bargeInStatus" IS NULL
            AND cardinality("bargeInDurationsMs") = 0
          )
          OR (
            "bargeInStatus" = 'overflowed'
            AND cardinality("bargeInDurationsMs") = 0
          )
          OR (
            "bargeInStatus" = 'complete'
            AND cardinality("bargeInDurationsMs") BETWEEN 1 AND 16
            AND array_position("bargeInDurationsMs", NULL) IS NULL
            AND 0 <= ALL("bargeInDurationsMs")
            AND 10000 >= ALL("bargeInDurationsMs")
          )
        )
      )
    )
);

CREATE INDEX "realtime_native_speech_deliveries_session_phase_idx"
  ON "realtime_native_speech_deliveries"("companyId", "sessionId", "phase", "createdAt");
-- Index partiel volontairement SQL-only : Prisma ne sait pas exprimer son prédicat sans drift.
CREATE INDEX "realtime_native_speech_deliveries_reaper_idx"
  ON "realtime_native_speech_deliveries"("expiresAt", "deliveryId")
  WHERE "phase" NOT IN ('delivered', 'cancelled', 'failed', 'expired');
CREATE INDEX "realtime_native_speech_deliveries_retention_idx"
  ON "realtime_native_speech_deliveries"("companyId", "retentionExpiresAt");
CREATE INDEX "realtime_native_speech_deliveries_slo_export_idx"
  ON "realtime_native_speech_deliveries"("companyId", "deliveredAt", "deliveryId")
  WHERE "sloFormatVersion" = 1;

-- Le fence relit toujours le bail réel : une mémoire locale ou une réponse provider ne donne
-- jamais l'autorité de progresser la machine durable.
CREATE FUNCTION assert_realtime_native_delivery_fence_v1(
  tenant_id TEXT,
  subject_hmac CHAR(64),
  voice_session_id UUID,
  speech_provider TEXT,
  expected_revision INTEGER,
  expected_digest CHAR(64),
  expected_owner_token_hmac CHAR(64),
  expected_owner_epoch INTEGER
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NULLIF(current_setting('app.current_company_id', true), '') IS DISTINCT FROM tenant_id THEN
    RAISE EXCEPTION 'realtime native delivery tenant context rejected'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
    FROM public.realtime_session_leases AS lease
   WHERE lease."companyId" = tenant_id
     AND lease."subjectHash" = subject_hmac
     AND lease."sessionId" = voice_session_id
     AND lease."providerId" = speech_provider
     AND lease."state" = 'active'
     AND lease."leaseExpiresAt" > clock_timestamp()
     AND lease."hardExpiresAt" > clock_timestamp()
     AND lease."contextRevision" = expected_revision
     AND lease."contextDigest" = expected_digest
     AND lease."contextAppliedRevision" = expected_revision
     AND lease."contextAppliedDigest" = expected_digest
     AND lease."contextAppliedOwnerEpoch" = expected_owner_epoch
     AND lease."sidebandOwnerEpoch" = expected_owner_epoch
     AND lease."sidebandOwnerTokenHash" = expected_owner_token_hmac
     AND lease."sidebandOwnerLeaseExpiresAt" > clock_timestamp()
     AND lease."sidebandProtocolVersion" = 2
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'realtime native delivery context owner fence rejected'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION assert_realtime_native_delivery_fence_v1(
  TEXT, CHAR(64), UUID, TEXT, INTEGER, CHAR(64), CHAR(64), INTEGER
) FROM PUBLIC;

CREATE FUNCTION guard_realtime_native_delivery_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  terminal_phases CONSTANT TEXT[] := ARRAY['delivered', 'cancelled', 'failed', 'expired'];
  database_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF NULLIF(current_setting('app.current_company_id', true), '') IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'realtime native delivery tenant context rejected'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."phase" <> 'prepared'
       OR NEW."version" <> 1
       OR NEW."revision" <> 1
       OR NEW."createdAt" > database_now + INTERVAL '1 minute'
       OR NEW."expiresAt" <= database_now
    THEN
      RAISE EXCEPTION 'realtime native delivery must start prepared'
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
    RAISE EXCEPTION 'terminal realtime native delivery is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."phase" = 'expired' THEN
    IF database_now < OLD."expiresAt" THEN
      RAISE EXCEPTION 'realtime native delivery cannot expire before its database deadline'
        USING ERRCODE = '55000';
    END IF;
  ELSIF database_now >= OLD."expiresAt" THEN
    RAISE EXCEPTION 'realtime native delivery deadline elapsed'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    NEW."deliveryId", NEW."companyId", NEW."subjectHmac", NEW."sessionId", NEW."turnId",
    NEW."contextRevision", NEW."contextDigest", NEW."sidebandOwnerEpoch",
    NEW."sidebandOwnerTokenHmac", NEW."speechPolicyVersion", NEW."speechScenarioId",
    NEW."canonicalSpeechHmac", NEW."factsHmac", NEW."requestNonceHmac",
    NEW."proofFormatVersion", NEW."proofKeyVersion", NEW."provider", NEW."model", NEW."voice",
    NEW."version", NEW."createdAt", NEW."expiresAt", NEW."retentionExpiresAt"
  ) IS DISTINCT FROM ROW(
    OLD."deliveryId", OLD."companyId", OLD."subjectHmac", OLD."sessionId", OLD."turnId",
    OLD."contextRevision", OLD."contextDigest", OLD."sidebandOwnerEpoch",
    OLD."sidebandOwnerTokenHmac", OLD."speechPolicyVersion", OLD."speechScenarioId",
    OLD."canonicalSpeechHmac", OLD."factsHmac", OLD."requestNonceHmac",
    OLD."proofFormatVersion", OLD."proofKeyVersion", OLD."provider", OLD."model", OLD."voice",
    OLD."version", OLD."createdAt", OLD."expiresAt", OLD."retentionExpiresAt"
  ) THEN
    RAISE EXCEPTION 'realtime native delivery authority evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF (OLD."dispatchClaimId" IS NOT NULL
      AND NEW."dispatchClaimId" IS DISTINCT FROM OLD."dispatchClaimId")
     OR (OLD."providerResponseIdHmac" IS NOT NULL
      AND NEW."providerResponseIdHmac" IS DISTINCT FROM OLD."providerResponseIdHmac")
     OR (OLD."outputTranscriptHmac" IS NOT NULL
      AND NEW."outputTranscriptHmac" IS DISTINCT FROM OLD."outputTranscriptHmac")
     OR (OLD."acknowledgementId" IS NOT NULL
      AND NEW."acknowledgementId" IS DISTINCT FROM OLD."acknowledgementId")
     OR (OLD."cancellationId" IS NOT NULL
      AND NEW."cancellationId" IS DISTINCT FROM OLD."cancellationId")
     OR (OLD."cancellationReason" IS NOT NULL
      AND NEW."cancellationReason" IS DISTINCT FROM OLD."cancellationReason")
     OR (OLD."failureId" IS NOT NULL
      AND NEW."failureId" IS DISTINCT FROM OLD."failureId")
     OR (OLD."failureReason" IS NOT NULL
      AND NEW."failureReason" IS DISTINCT FROM OLD."failureReason")
  THEN
    RAISE EXCEPTION 'realtime native delivery proof cannot be rewritten'
      USING ERRCODE = '55000';
  END IF;

  IF (OLD."dispatchingAt" IS NOT NULL AND NEW."dispatchingAt" IS DISTINCT FROM OLD."dispatchingAt")
     OR (OLD."requestedAt" IS NOT NULL AND NEW."requestedAt" IS DISTINCT FROM OLD."requestedAt")
     OR (OLD."acceptedAt" IS NOT NULL AND NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt")
     OR (OLD."streamingAt" IS NOT NULL AND NEW."streamingAt" IS DISTINCT FROM OLD."streamingAt")
     OR (OLD."responseDoneAt" IS NOT NULL AND NEW."responseDoneAt" IS DISTINCT FROM OLD."responseDoneAt")
     OR (OLD."outputStoppedAt" IS NOT NULL AND NEW."outputStoppedAt" IS DISTINCT FROM OLD."outputStoppedAt")
     OR (OLD."completedAt" IS NOT NULL AND NEW."completedAt" IS DISTINCT FROM OLD."completedAt")
     OR (OLD."deliveredAt" IS NOT NULL AND NEW."deliveredAt" IS DISTINCT FROM OLD."deliveredAt")
     OR (OLD."terminalAt" IS NOT NULL AND NEW."terminalAt" IS DISTINCT FROM OLD."terminalAt")
  THEN
    RAISE EXCEPTION 'realtime native delivery timeline is append-only'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'realtime native delivery CAS revision is not monotone'
      USING ERRCODE = '40001';
  END IF;

  IF NEW."phase" = ANY(terminal_phases)
     AND ROW(
       NEW."dispatchClaimId", NEW."dispatchingAt", NEW."requestedAt",
       NEW."providerResponseIdHmac", NEW."acceptedAt", NEW."streamingAt",
       NEW."responseDoneAt", NEW."outputStoppedAt", NEW."outputTranscriptHmac",
       NEW."completedAt"
     ) IS DISTINCT FROM ROW(
       OLD."dispatchClaimId", OLD."dispatchingAt", OLD."requestedAt",
       OLD."providerResponseIdHmac", OLD."acceptedAt", OLD."streamingAt",
       OLD."responseDoneAt", OLD."outputStoppedAt", OLD."outputTranscriptHmac",
       OLD."completedAt"
     )
  THEN
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

  -- La terminalisation retire du pouvoir et reste possible après takeover. Le temps DB impose
  -- EXPIRE après l'échéance et interdit toute autre progression ou terminalisation après elle.
  -- Toute progression et tout ACK delivered restent liés à l'owner/contexte courant.
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

REVOKE ALL ON FUNCTION guard_realtime_native_delivery_v1() FROM PUBLIC;

CREATE TRIGGER "00_realtime_native_speech_deliveries_guard_v1"
BEFORE INSERT OR UPDATE ON "realtime_native_speech_deliveries"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_native_delivery_v1();

CREATE FUNCTION guard_realtime_native_speech_slo_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."sloFormatVersion" IS NOT NULL
       OR NEW."speechStoppedEventToFirstInboundRtpMs" IS NOT NULL
       OR NEW."bargeInStatus" IS NOT NULL
       OR cardinality(NEW."bargeInDurationsMs") <> 0
    THEN
      RAISE EXCEPTION 'native speech SLO cannot precede durable delivery acknowledgement'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW."sloFormatVersion", NEW."speechStoppedEventToFirstInboundRtpMs",
    NEW."bargeInStatus", NEW."bargeInDurationsMs"
  ) IS DISTINCT FROM ROW(
    OLD."sloFormatVersion", OLD."speechStoppedEventToFirstInboundRtpMs",
    OLD."bargeInStatus", OLD."bargeInDurationsMs"
  ) AND NOT (
    OLD."phase" = 'completed'
    AND NEW."phase" = 'delivered'
    AND OLD."sloFormatVersion" IS NULL
    AND OLD."speechStoppedEventToFirstInboundRtpMs" IS NULL
    AND OLD."bargeInStatus" IS NULL
    AND cardinality(OLD."bargeInDurationsMs") = 0
  ) THEN
    RAISE EXCEPTION 'native speech SLO is immutable outside first durable delivery acknowledgement'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION guard_realtime_native_speech_slo_v1() FROM PUBLIC;

CREATE TRIGGER "01_realtime_native_speech_deliveries_slo_guard_v1"
BEFORE INSERT OR UPDATE ON "realtime_native_speech_deliveries"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_native_speech_slo_v1();

-- Généralisation expand-first des contrôles. Les defaults conservent exactement le domaine
-- cryptographique v1 des writers N-1 ; artifactId ne devient nullable qu'après leur ajout.
ALTER TABLE "realtime_control_grants"
  ADD COLUMN "deliveryKind" TEXT NOT NULL DEFAULT 'audited_artifact',
  ADD COLUMN "bindingVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "nativeDeliveryId" UUID,
  ALTER COLUMN "artifactId" DROP NOT NULL;

ALTER TABLE "realtime_control_grants"
  ADD CONSTRAINT "realtime_control_grants_delivery_binding_check"
    CHECK (
      (
        "deliveryKind" = 'audited_artifact'
        AND "bindingVersion" = 1
        AND "artifactId" IS NOT NULL
        AND "nativeDeliveryId" IS NULL
      )
      OR (
        "deliveryKind" = 'provider_stream'
        AND "bindingVersion" = 2
        AND "artifactId" IS NULL
        AND "nativeDeliveryId" IS NOT NULL
      )
    ) NOT VALID,
  ADD CONSTRAINT "realtime_control_grants_native_delivery_tenant_fkey"
    FOREIGN KEY ("nativeDeliveryId", "companyId", "sessionId", "turnId")
    REFERENCES "realtime_native_speech_deliveries"("deliveryId", "companyId", "sessionId", "turnId")
    ON DELETE RESTRICT ON UPDATE CASCADE
    NOT VALID,
  ADD CONSTRAINT "realtime_control_grants_native_delivery_key"
    UNIQUE ("companyId", "nativeDeliveryId"),
  ADD CONSTRAINT "realtime_control_grants_native_delivery_binding_key"
    UNIQUE ("nativeDeliveryId", "companyId", "sessionId", "turnId");

ALTER TABLE "realtime_control_grants"
  VALIDATE CONSTRAINT "realtime_control_grants_delivery_binding_check";
ALTER TABLE "realtime_control_grants"
  VALIDATE CONSTRAINT "realtime_control_grants_native_delivery_tenant_fkey";

CREATE FUNCTION assert_realtime_control_grant_binding_v3(
  delivery_kind TEXT,
  binding_version INTEGER,
  artifact_id UUID,
  native_delivery_id UUID,
  tenant_id TEXT,
  voice_session_id UUID,
  voice_turn_id UUID,
  expected_revision INTEGER,
  expected_digest CHAR(64),
  issued_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  retention_at TIMESTAMPTZ
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  bound_subject CHAR(64);
  bound_provider TEXT;
  bound_owner_epoch INTEGER;
  bound_owner_token CHAR(64);
BEGIN
  IF NULLIF(current_setting('app.current_company_id', true), '') IS DISTINCT FROM tenant_id THEN
    RAISE EXCEPTION 'realtime control tenant context rejected'
      USING ERRCODE = '55000';
  END IF;

  IF issued_at > clock_timestamp() + INTERVAL '1 minute'
     OR expires_at <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'realtime control grant is outside its validity window'
      USING ERRCODE = '55000';
  END IF;

  IF delivery_kind = 'audited_artifact' AND binding_version = 1 THEN
    -- Ordre de verrouillage global : preuve acoustique, puis bail. Un JOIN avec FOR SHARE sur les
    -- deux relations laisserait le planificateur inverser cet ordre et créer un deadlock.
    SELECT artifact."subjectHash", artifact."sidebandOwnerEpoch",
           artifact."sidebandOwnerTokenHash"
      INTO bound_subject, bound_owner_epoch, bound_owner_token
      FROM public.realtime_speech_artifacts AS artifact
     WHERE artifact."id" = artifact_id
       AND artifact."companyId" = tenant_id
       AND artifact."sessionId" = voice_session_id
       AND artifact."turnId" = voice_turn_id
       AND artifact."state" = 'ready'
       AND artifact."readyAt" IS NOT NULL
       AND artifact."readyAt" <= issued_at
       AND artifact."storageExpiresAt" > clock_timestamp()
       AND artifact."objectPurgedAt" IS NULL
       AND artifact."contextRevision" = expected_revision
       AND artifact."contextDigest" = expected_digest
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'control grant requires an exactly bound ready artifact and live owner'
        USING ERRCODE = '55000';
    END IF;

    PERFORM 1
      FROM public.realtime_session_leases AS lease
     WHERE lease."companyId" = tenant_id
       AND lease."subjectHash" = bound_subject
       AND lease."sessionId" = voice_session_id
       AND lease."state" = 'active'
       AND lease."leaseExpiresAt" >= expires_at
       AND lease."hardExpiresAt" >= expires_at
       AND lease."contextRevision" = expected_revision
       AND lease."contextDigest" = expected_digest
       AND lease."contextAppliedRevision" = expected_revision
       AND lease."contextAppliedDigest" = expected_digest
       AND lease."contextAppliedOwnerEpoch" = bound_owner_epoch
       AND lease."sidebandOwnerEpoch" = bound_owner_epoch
       AND lease."sidebandOwnerTokenHash" = bound_owner_token
       AND lease."sidebandOwnerLeaseExpiresAt" >= expires_at
       AND lease."sidebandProtocolVersion" = 2
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'control grant requires an exactly bound ready artifact and live owner'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;

  IF delivery_kind = 'provider_stream' AND binding_version = 2 THEN
    SELECT native_delivery."subjectHmac", native_delivery."provider",
           native_delivery."sidebandOwnerEpoch", native_delivery."sidebandOwnerTokenHmac"
      INTO bound_subject, bound_provider, bound_owner_epoch, bound_owner_token
      FROM public.realtime_native_speech_deliveries AS native_delivery
     WHERE native_delivery."deliveryId" = native_delivery_id
       AND native_delivery."companyId" = tenant_id
       AND native_delivery."sessionId" = voice_session_id
       AND native_delivery."turnId" = voice_turn_id
       AND native_delivery."phase" = 'prepared'
       AND native_delivery."createdAt" <= issued_at
       AND native_delivery."expiresAt" >= expires_at
       AND native_delivery."retentionExpiresAt" >= retention_at
       AND native_delivery."contextRevision" = expected_revision
       AND native_delivery."contextDigest" = expected_digest
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'control grant requires an exactly bound prepared provider stream'
        USING ERRCODE = '55000';
    END IF;

    PERFORM 1
      FROM public.realtime_session_leases AS lease
     WHERE lease."companyId" = tenant_id
       AND lease."subjectHash" = bound_subject
       AND lease."sessionId" = voice_session_id
       AND lease."providerId" = bound_provider
       AND lease."state" = 'active'
       AND lease."leaseExpiresAt" >= expires_at
       AND lease."hardExpiresAt" >= expires_at
       AND lease."contextRevision" = expected_revision
       AND lease."contextDigest" = expected_digest
       AND lease."contextAppliedRevision" = expected_revision
       AND lease."contextAppliedDigest" = expected_digest
       AND lease."contextAppliedOwnerEpoch" = bound_owner_epoch
       AND lease."sidebandOwnerEpoch" = bound_owner_epoch
       AND lease."sidebandOwnerTokenHash" = bound_owner_token
       AND lease."sidebandOwnerLeaseExpiresAt" >= expires_at
       AND lease."sidebandProtocolVersion" = 2
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'control grant requires an exactly bound prepared provider stream'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;

  RAISE EXCEPTION 'invalid realtime control delivery binding'
    USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION assert_realtime_control_grant_binding_v3(
  TEXT, INTEGER, UUID, UUID, TEXT, UUID, UUID, INTEGER, CHAR(64),
  TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;

-- Deux générations de triggers existent déjà en production. Elles doivent être remplacées dans
-- la même transaction, sinon l'une d'elles continuerait d'imposer le seul artefact historique.
CREATE OR REPLACE FUNCTION guard_realtime_control_grant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NULLIF(current_setting('app.current_company_id', true), '') IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'realtime control tenant context rejected'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'realtime control grants are immutable'
      USING ERRCODE = '55000';
  END IF;
  PERFORM public.assert_realtime_control_grant_binding_v3(
    NEW."deliveryKind", NEW."bindingVersion", NEW."artifactId", NEW."nativeDeliveryId",
    NEW."companyId", NEW."sessionId", NEW."turnId",
    NEW."contextRevision", NEW."contextDigest", NEW."issuedAt", NEW."expiresAt",
    NEW."retentionExpiresAt"
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_realtime_control_grant_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NULLIF(current_setting('app.current_company_id', true), '') IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'realtime control tenant context rejected'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'realtime control grants are immutable'
      USING ERRCODE = '55000';
  END IF;
  PERFORM public.assert_realtime_control_grant_binding_v3(
    NEW."deliveryKind", NEW."bindingVersion", NEW."artifactId", NEW."nativeDeliveryId",
    NEW."companyId", NEW."sessionId", NEW."turnId",
    NEW."contextRevision", NEW."contextDigest", NEW."issuedAt", NEW."expiresAt",
    NEW."retentionExpiresAt"
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION guard_realtime_control_grant() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_realtime_control_grant_v2() FROM PUBLIC;

CREATE FUNCTION assert_realtime_control_consumption_binding_v3(
  tenant_id TEXT,
  grant_id UUID,
  acknowledgement_id UUID,
  voice_session_id UUID,
  voice_turn_id UUID,
  consumed_at TIMESTAMPTZ
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  existing_ack UUID;
  bound_kind TEXT;
  bound_version INTEGER;
  bound_artifact_id UUID;
  bound_native_delivery_id UUID;
  bound_revision INTEGER;
  bound_digest CHAR(64);
  bound_subject CHAR(64);
  bound_provider TEXT;
  bound_owner_epoch INTEGER;
  bound_owner_token CHAR(64);
BEGIN
  IF NULLIF(current_setting('app.current_company_id', true), '') IS DISTINCT FROM tenant_id THEN
    RAISE EXCEPTION 'realtime control tenant context rejected'
      USING ERRCODE = '55000';
  END IF;

  -- Le trigger 00_*_v2 s'exécute avant le trigger historique. L'idempotence doit donc vivre
  -- dans le helper commun : un retry exact reste un no-op même après expiration de la grant.
  SELECT consumption."acknowledgementId"
    INTO existing_ack
    FROM public.realtime_control_consumptions AS consumption
   WHERE consumption."companyId" = tenant_id
     AND consumption."grantId" = grant_id;
  IF existing_ack IS NOT NULL THEN
    IF existing_ack <> acknowledgement_id THEN
      RAISE EXCEPTION 'realtime control grant already consumed'
        USING ERRCODE = '23505';
    END IF;
    RETURN;
  END IF;

  IF consumed_at < clock_timestamp() - INTERVAL '1 minute'
     OR consumed_at > clock_timestamp() + INTERVAL '1 minute'
  THEN
    RAISE EXCEPTION 'invalid realtime control consumption timestamp'
      USING ERRCODE = '55000';
  END IF;

  SELECT control_grant."deliveryKind", control_grant."bindingVersion",
         control_grant."artifactId", control_grant."nativeDeliveryId",
         control_grant."contextRevision", control_grant."contextDigest"
    INTO bound_kind, bound_version, bound_artifact_id, bound_native_delivery_id,
         bound_revision, bound_digest
    FROM public.realtime_control_grants AS control_grant
   WHERE control_grant."id" = grant_id
     AND control_grant."companyId" = tenant_id
     AND control_grant."sessionId" = voice_session_id
     AND control_grant."turnId" = voice_turn_id
     AND control_grant."issuedAt" <= consumed_at
     AND control_grant."expiresAt" >= consumed_at
     AND control_grant."expiresAt" > clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'realtime control grant is outside its validity window'
      USING ERRCODE = '55000';
  END IF;

  IF bound_kind = 'audited_artifact' AND bound_version = 1 THEN
    SELECT artifact."subjectHash", artifact."sidebandOwnerEpoch",
           artifact."sidebandOwnerTokenHash"
      INTO bound_subject, bound_owner_epoch, bound_owner_token
      FROM public.realtime_speech_artifacts AS artifact
     WHERE artifact."id" = bound_artifact_id
       AND artifact."companyId" = tenant_id
       AND artifact."sessionId" = voice_session_id
       AND artifact."turnId" = voice_turn_id
       AND artifact."state" = 'delivered'
       AND artifact."deliveryId" = acknowledgement_id
       AND artifact."deliveredAt" IS NOT NULL
       AND artifact."storageExpiresAt" > clock_timestamp()
       AND artifact."objectPurgedAt" IS NULL
       AND artifact."contextRevision" = bound_revision
       AND artifact."contextDigest" = bound_digest
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'realtime control grant is not durably delivered or no longer current'
        USING ERRCODE = '55000';
    END IF;

    PERFORM 1
      FROM public.realtime_session_leases AS lease
     WHERE lease."companyId" = tenant_id
       AND lease."subjectHash" = bound_subject
       AND lease."sessionId" = voice_session_id
       AND lease."state" = 'active'
       AND lease."leaseExpiresAt" > clock_timestamp()
       AND lease."hardExpiresAt" > clock_timestamp()
       AND lease."contextRevision" = bound_revision
       AND lease."contextDigest" = bound_digest
       AND lease."contextAppliedRevision" = bound_revision
       AND lease."contextAppliedDigest" = bound_digest
       AND lease."contextAppliedOwnerEpoch" = bound_owner_epoch
       AND lease."sidebandOwnerEpoch" = bound_owner_epoch
       AND lease."sidebandOwnerTokenHash" = bound_owner_token
       AND lease."sidebandOwnerLeaseExpiresAt" > clock_timestamp()
       AND lease."sidebandProtocolVersion" = 2
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'realtime control grant is not durably delivered or no longer current'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;

  IF bound_kind = 'provider_stream' AND bound_version = 2 THEN
    SELECT native_delivery."subjectHmac", native_delivery."provider",
           native_delivery."sidebandOwnerEpoch", native_delivery."sidebandOwnerTokenHmac"
      INTO bound_subject, bound_provider, bound_owner_epoch, bound_owner_token
      FROM public.realtime_native_speech_deliveries AS native_delivery
     WHERE native_delivery."deliveryId" = bound_native_delivery_id
       AND native_delivery."companyId" = tenant_id
       AND native_delivery."sessionId" = voice_session_id
       AND native_delivery."turnId" = voice_turn_id
       AND native_delivery."phase" = 'delivered'
       AND native_delivery."acknowledgementId" = acknowledgement_id
       AND native_delivery."deliveredAt" IS NOT NULL
       AND native_delivery."contextRevision" = bound_revision
       AND native_delivery."contextDigest" = bound_digest
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'realtime control grant is not durably delivered or no longer current'
        USING ERRCODE = '55000';
    END IF;

    PERFORM 1
      FROM public.realtime_session_leases AS lease
     WHERE lease."companyId" = tenant_id
       AND lease."subjectHash" = bound_subject
       AND lease."sessionId" = voice_session_id
       AND lease."providerId" = bound_provider
       AND lease."state" = 'active'
       AND lease."leaseExpiresAt" > clock_timestamp()
       AND lease."hardExpiresAt" > clock_timestamp()
       AND lease."contextRevision" = bound_revision
       AND lease."contextDigest" = bound_digest
       AND lease."contextAppliedRevision" = bound_revision
       AND lease."contextAppliedDigest" = bound_digest
       AND lease."contextAppliedOwnerEpoch" = bound_owner_epoch
       AND lease."sidebandOwnerEpoch" = bound_owner_epoch
       AND lease."sidebandOwnerTokenHash" = bound_owner_token
       AND lease."sidebandOwnerLeaseExpiresAt" > clock_timestamp()
       AND lease."sidebandProtocolVersion" = 2
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'realtime control grant is not durably delivered or no longer current'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;

  RAISE EXCEPTION 'invalid realtime control delivery binding'
    USING ERRCODE = '55000';
END;
$$;

REVOKE ALL ON FUNCTION assert_realtime_control_consumption_binding_v3(
  TEXT, UUID, UUID, UUID, UUID, TIMESTAMPTZ
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION guard_realtime_control_consumption()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NULLIF(current_setting('app.current_company_id', true), '') IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'realtime control tenant context rejected'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'realtime control consumptions are immutable'
      USING ERRCODE = '55000';
  END IF;
  PERFORM public.assert_realtime_control_consumption_binding_v3(
    NEW."companyId", NEW."grantId", NEW."acknowledgementId",
    NEW."sessionId", NEW."turnId", NEW."consumedAt"
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_realtime_control_consumption_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NULLIF(current_setting('app.current_company_id', true), '') IS DISTINCT FROM NEW."companyId" THEN
    RAISE EXCEPTION 'realtime control tenant context rejected'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'realtime control consumptions are immutable'
      USING ERRCODE = '55000';
  END IF;
  PERFORM public.assert_realtime_control_consumption_binding_v3(
    NEW."companyId", NEW."grantId", NEW."acknowledgementId",
    NEW."sessionId", NEW."turnId", NEW."consumedAt"
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION guard_realtime_control_consumption() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_realtime_control_consumption_v2() FROM PUBLIC;

-- RLS fail-closed dans la migration elle-même : aucun intervalle d'exposition n'existe entre
-- `migrate deploy` et la réapplication défensive de prisma/rls.sql.
ALTER TABLE public.realtime_native_speech_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.realtime_native_speech_deliveries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.realtime_native_speech_deliveries FROM PUBLIC;

DO $$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.realtime_native_speech_deliveries FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.assert_realtime_native_delivery_fence_v1(TEXT, CHAR(64), UUID, TEXT, INTEGER, CHAR(64), CHAR(64), INTEGER) FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.guard_realtime_native_delivery_v1() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.guard_realtime_native_speech_slo_v1() FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.assert_realtime_control_grant_binding_v3(TEXT, INTEGER, UUID, UUID, TEXT, UUID, UUID, INTEGER, CHAR(64), TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ) FROM %I',
        exposed_role
      );
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.assert_realtime_control_consumption_binding_v3(TEXT, UUID, UUID, UUID, UUID, TIMESTAMPTZ) FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$$;

CREATE POLICY realtime_native_speech_delivery_select
  ON public.realtime_native_speech_deliveries
  FOR SELECT
  USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_native_speech_delivery_insert
  ON public.realtime_native_speech_deliveries
  FOR INSERT
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_native_speech_delivery_update
  ON public.realtime_native_speech_deliveries
  FOR UPDATE
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

COMMENT ON TABLE public.realtime_native_speech_deliveries IS
  'Preuves bornées de diffusion audio OpenAI native; aucun audio, texte ou transcript brut.';
COMMENT ON COLUMN public.realtime_native_speech_deliveries."requestNonceHmac" IS
  'HMAC/SHA-256 de corrélation de response.create; le nonce brut reste éphémère côté sideband.';
COMMENT ON COLUMN public.realtime_native_speech_deliveries."speechPolicyVersion" IS
  'Version immuable de la politique déterministe ayant autorisé ce scénario générique natif.';
COMMENT ON COLUMN public.realtime_native_speech_deliveries."speechScenarioId" IS
  'Identifiant allowlisté exact; jamais un intent, une instruction ou un libellé produit par le LLM.';
COMMENT ON COLUMN public.realtime_native_speech_deliveries."proofFormatVersion" IS
  'Version canonique de preuve HMAC; v2 lie aussi la décision de risque, immuable.';
COMMENT ON COLUMN public.realtime_native_speech_deliveries."proofKeyVersion" IS
  'Version de clé requise pour vérifier les HMAC après rotation; immuable avec les preuves.';
COMMENT ON COLUMN public.realtime_native_speech_deliveries."canonicalSpeechHmac" IS
  'HMAC versionné du canonique Bob; jamais la parole en clair.';
COMMENT ON COLUMN public.realtime_native_speech_deliveries."outputTranscriptHmac" IS
  'HMAC versionné du transcript provider borné; jamais le transcript en clair.';
COMMENT ON COLUMN public.realtime_native_speech_deliveries."sloFormatVersion" IS
  'Version du lot SLO acoustique attaché atomiquement au premier ACK; NULL si absent.';
COMMENT ON COLUMN public.realtime_native_speech_deliveries."speechStoppedEventToFirstInboundRtpMs" IS
  'Réception device de speech_stopped vers premier RTP entrant; proxy transport uniquement.';
COMMENT ON COLUMN public.realtime_native_speech_deliveries."bargeInStatus" IS
  'complete ou overflowed; overflowed interdit toute agrégation partielle biaisée.';
COMMENT ON COLUMN public.realtime_native_speech_deliveries."bargeInDurationsMs" IS
  'Au plus 16 latences exactes bornées; rétention identique à la preuve de livraison.';
COMMENT ON COLUMN public.realtime_control_grants."deliveryKind" IS
  'Discriminant expand-first: audited_artifact/v1 historique ou provider_stream/v2.';

COMMIT;

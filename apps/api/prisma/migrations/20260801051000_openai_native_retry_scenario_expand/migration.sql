-- OpenAI native speech — reprise STT générique, expand compatible writer N-1.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.realtime_native_speech_deliveries
  ADD CONSTRAINT realtime_native_speech_deliveries_dimension_check_v2
  CHECK (
    "companyId" ~ '^[A-Za-z0-9-]{1,64}$'
    AND "subjectHmac"::TEXT ~ '^[a-f0-9]{64}$'
    AND "contextRevision" BETWEEN 1 AND 2147483647
    AND "contextDigest"::TEXT ~ '^[a-f0-9]{64}$'
    AND "sidebandOwnerEpoch" BETWEEN 1 AND 2147483647
    AND "sidebandOwnerTokenHmac"::TEXT ~ '^[a-f0-9]{64}$'
    AND "speechPolicyVersion" = 1
    AND "speechScenarioId" IN (
    -- OPENAI_NATIVE_SPEECH_SCENARIOS_START
      'generic_retry_v1',
      'generic_help_v1',
      'generic_unknown_v1'
    -- OPENAI_NATIVE_SPEECH_SCENARIOS_END
    )
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
  ) NOT VALID;

ALTER TABLE public.realtime_native_speech_deliveries
  DROP CONSTRAINT realtime_native_speech_deliveries_dimension_check;

COMMIT;

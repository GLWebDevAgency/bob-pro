-- Bob Live — livraison acoustique auditée, contrôles one-shot et usage durable.
-- Aucun texte, transcript ou octet audio brut n'est persisté dans PostgreSQL.

-- Le bail du sideband est distinct du bail mobile. Le contexte « applied » est l'ACK produit
-- par l'unique sideband propriétaire après application effective chez le provider.
ALTER TABLE "realtime_session_leases"
  ADD COLUMN "sidebandOwnerInstanceHash" CHAR(64),
  ADD COLUMN "sidebandOwnerTokenHash" CHAR(64),
  ADD COLUMN "sidebandOwnerLeaseExpiresAt" TIMESTAMPTZ,
  ADD COLUMN "contextAppliedRevision" INTEGER,
  ADD COLUMN "contextAppliedDigest" CHAR(64),
  ADD COLUMN "contextAppliedAt" TIMESTAMPTZ,
  ADD COLUMN "sidebandProtocolVersion" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "nextSpeechSequence" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "realtime_session_leases"
  ADD CONSTRAINT "realtime_session_leases_sideband_owner_token_hash_key"
    UNIQUE ("sidebandOwnerTokenHash"),
  ADD CONSTRAINT "realtime_session_leases_sideband_protocol_check"
    CHECK ("sidebandProtocolVersion" = 2),
  ADD CONSTRAINT "realtime_session_leases_speech_sequence_check"
    CHECK ("nextSpeechSequence" BETWEEN 1 AND 2147483647),
  ADD CONSTRAINT "realtime_session_leases_sideband_owner_shape_check"
    CHECK (
      (
        "sidebandOwnerInstanceHash" IS NULL
        AND "sidebandOwnerTokenHash" IS NULL
        AND "sidebandOwnerLeaseExpiresAt" IS NULL
      )
      OR (
        "sidebandOwnerInstanceHash"::TEXT ~ '^[a-f0-9]{64}$'
        AND "sidebandOwnerTokenHash"::TEXT ~ '^[a-f0-9]{64}$'
        AND "sidebandOwnerLeaseExpiresAt" IS NOT NULL
        AND "sidebandOwnerLeaseExpiresAt" > "reservedAt"
        AND "providerCallId" IS NOT NULL
        AND "state" IN ('bound', 'active', 'reaping')
      )
    ),
  ADD CONSTRAINT "realtime_session_leases_context_applied_shape_check"
    CHECK (
      (
        "contextAppliedRevision" IS NULL
        AND "contextAppliedDigest" IS NULL
        AND "contextAppliedAt" IS NULL
      )
      OR (
        "contextAppliedRevision" IS NOT NULL
        AND "contextAppliedRevision" > 0
        AND "contextAppliedDigest"::TEXT ~ '^[a-f0-9]{64}$'
        AND "contextAppliedAt" IS NOT NULL
        AND "contextAppliedAt" >= "reservedAt"
        AND "contextRevision" IS NOT NULL
        AND "contextAppliedRevision" <= "contextRevision"
        AND (
          "contextAppliedRevision" <> "contextRevision"
          OR "contextAppliedDigest" = "contextDigest"
        )
        AND "sidebandOwnerTokenHash" IS NOT NULL
      )
    );

CREATE INDEX "realtime_session_leases_sideband_reaper_idx"
  ON "realtime_session_leases"("state", "sidebandOwnerLeaseExpiresAt")
  WHERE "sidebandOwnerTokenHash" IS NOT NULL;

COMMENT ON COLUMN "realtime_session_leases"."sidebandOwnerInstanceHash" IS
  'HMAC-SHA-256 de l instance sideband; aucune identité d infrastructure brute.';
COMMENT ON COLUMN "realtime_session_leases"."sidebandOwnerTokenHash" IS
  'SHA-256 du token 256 bits de renouvellement CAS; le token brut ne quitte jamais le processus.';
COMMENT ON COLUMN "realtime_session_leases"."contextAppliedDigest" IS
  'Digest du dernier contexte réellement appliqué par le sideband propriétaire.';

CREATE TABLE "realtime_speech_artifacts" (
  "id" UUID NOT NULL,
  "companyId" TEXT NOT NULL,
  "subjectHash" CHAR(64) NOT NULL,
  "sessionId" UUID NOT NULL,
  "turnId" UUID NOT NULL,
  "sequence" INTEGER NOT NULL DEFAULT 0,
  "segmentIndex" INTEGER NOT NULL,
  "renderTokenHash" CHAR(64) NOT NULL,
  "state" TEXT NOT NULL,
  "classification" TEXT NOT NULL,
  "source" TEXT,
  "contextRevision" INTEGER NOT NULL,
  "contextDigest" CHAR(64) NOT NULL,
  "storageKey" TEXT,
  "storageExpiresAt" TIMESTAMPTZ,
  "mimeType" TEXT,
  "byteLength" INTEGER,
  "durationMs" INTEGER,
  "canonicalSpeechHmac" CHAR(64) NOT NULL,
  "auditTranscriptHmac" CHAR(64),
  "factsHmac" CHAR(64) NOT NULL,
  "evidenceHmac" CHAR(64),
  "audioSha256" CHAR(64),
  "proofKeyVersion" INTEGER,
  "synthesisAdapterId" TEXT,
  "synthesisTrustDomain" TEXT,
  "auditAdapterId" TEXT,
  "auditTrustDomain" TEXT,
  "renderLeaseExpiresAt" TIMESTAMPTZ,
  "deliveryId" UUID,
  "cancellationId" UUID,
  "cancellationReasonCode" TEXT,
  "failureReasonCode" TEXT,
  "objectPurgedAt" TIMESTAMPTZ,
  "purgeTokenHash" CHAR(64),
  "purgeLeaseExpiresAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  "readyAt" TIMESTAMPTZ,
  "deliveredAt" TIMESTAMPTZ,
  "cancelledAt" TIMESTAMPTZ,
  "failedAt" TIMESTAMPTZ,
  "retentionExpiresAt" TIMESTAMPTZ NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "realtime_speech_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "realtime_speech_artifacts_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "realtime_speech_artifacts_render_token_hash_key" UNIQUE ("renderTokenHash"),
  CONSTRAINT "realtime_speech_artifacts_delivery_id_key" UNIQUE ("deliveryId"),
  CONSTRAINT "realtime_speech_artifacts_cancellation_id_key" UNIQUE ("cancellationId"),
  CONSTRAINT "realtime_speech_artifacts_purge_token_hash_key" UNIQUE ("purgeTokenHash"),
  CONSTRAINT "realtime_speech_artifacts_storage_key_key" UNIQUE ("storageKey"),
  CONSTRAINT "realtime_speech_artifacts_session_sequence_key"
    UNIQUE ("companyId", "sessionId", "sequence"),
  CONSTRAINT "realtime_speech_artifacts_turn_segment_key"
    UNIQUE ("companyId", "sessionId", "turnId", "segmentIndex"),
  CONSTRAINT "realtime_speech_artifacts_tenant_binding_key"
    UNIQUE ("id", "companyId", "sessionId", "turnId"),
  CONSTRAINT "realtime_speech_artifacts_state_check"
    CHECK ("state" IN ('rendering', 'ready', 'delivered', 'cancelled', 'failed')),
  CONSTRAINT "realtime_speech_artifacts_binding_check"
    CHECK (
      "subjectHash"::TEXT ~ '^[a-f0-9]{64}$'
      AND "sequence" BETWEEN 1 AND 2147483647
      AND "segmentIndex" BETWEEN 0 AND 127
      AND "renderTokenHash"::TEXT ~ '^[a-f0-9]{64}$'
      AND "classification" IN ('fixed_safe', 'dynamic_sensitive')
      AND "canonicalSpeechHmac"::TEXT ~ '^[a-f0-9]{64}$'
      AND "factsHmac"::TEXT ~ '^[a-f0-9]{64}$'
      AND ("source" IS NULL OR "source" IN ('preapproved_static', 'synthesized_audited'))
      AND (
        "source" IS NULL
        OR "source" = 'synthesized_audited'
        OR ("classification" = 'fixed_safe' AND "source" = 'preapproved_static')
      )
      AND "contextRevision" > 0
      AND "contextDigest"::TEXT ~ '^[a-f0-9]{64}$'
      AND "version" > 0
      AND "updatedAt" >= "createdAt"
      AND "retentionExpiresAt" > "createdAt"
      AND "retentionExpiresAt" <= "createdAt" + INTERVAL '31 days'
    ),
  CONSTRAINT "realtime_speech_artifacts_reason_check"
    CHECK (
      ("cancellationReasonCode" IS NULL OR "cancellationReasonCode" ~ '^[a-z][a-z0-9_]{0,63}$')
      AND ("failureReasonCode" IS NULL OR "failureReasonCode" ~ '^[a-z][a-z0-9_]{0,63}$')
    ),
  CONSTRAINT "realtime_speech_artifacts_purge_shape_check"
    CHECK (
      (
        "purgeTokenHash" IS NULL
        AND "purgeLeaseExpiresAt" IS NULL
      )
      OR (
        "purgeTokenHash"::TEXT ~ '^[a-f0-9]{64}$'
        AND "purgeLeaseExpiresAt" IS NOT NULL
        AND "purgeLeaseExpiresAt" > "updatedAt"
        AND "objectPurgedAt" IS NULL
        AND "storageKey" IS NOT NULL
        AND "state" IN ('delivered', 'cancelled')
      )
    ),
  CONSTRAINT "realtime_speech_artifacts_proof_shape_check"
    CHECK (
      (
        "storageKey" IS NULL
        AND "storageExpiresAt" IS NULL
        AND "mimeType" IS NULL
        AND "byteLength" IS NULL
        AND "durationMs" IS NULL
        AND "auditTranscriptHmac" IS NULL
        AND "evidenceHmac" IS NULL
        AND "audioSha256" IS NULL
        AND "proofKeyVersion" IS NULL
        AND "synthesisAdapterId" IS NULL
        AND "synthesisTrustDomain" IS NULL
        AND "auditAdapterId" IS NULL
        AND "auditTrustDomain" IS NULL
        AND "objectPurgedAt" IS NULL
      )
      OR (
        "storageKey" = 'companies/' || "companyId" || '/bob-live/'
          || "sessionId"::TEXT || '/' || "turnId"::TEXT || '/' || "id"::TEXT
        AND "companyId" ~ '^[A-Za-z0-9-]{1,64}$'
        AND "storageExpiresAt" IS NOT NULL
        AND "mimeType" IN ('audio/mpeg', 'audio/wav')
        AND "byteLength" BETWEEN 256 AND 2097152
        AND "durationMs" BETWEEN 100 AND 45000
        AND "evidenceHmac"::TEXT ~ '^[a-f0-9]{64}$'
        AND "audioSha256"::TEXT ~ '^[a-f0-9]{64}$'
        AND "proofKeyVersion" BETWEEN 1 AND 2147483647
        AND "synthesisAdapterId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
        AND "synthesisTrustDomain" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
        AND (
          (
            "source" = 'preapproved_static'
            AND "auditTranscriptHmac" IS NULL
            AND "auditAdapterId" IS NULL
            AND "auditTrustDomain" IS NULL
          )
          OR (
            "source" = 'synthesized_audited'
            AND "auditTranscriptHmac"::TEXT ~ '^[a-f0-9]{64}$'
            AND "auditAdapterId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
            AND "auditTrustDomain" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
            AND "auditTrustDomain" <> "synthesisTrustDomain"
          )
        )
        AND (
          "objectPurgedAt" IS NULL
          OR (
            "objectPurgedAt" >= "readyAt"
            AND "state" IN ('delivered', 'cancelled')
            AND "purgeTokenHash" IS NULL
          )
        )
      )
    ),
  CONSTRAINT "realtime_speech_artifacts_state_shape_check"
    CHECK (
      (
        "state" = 'rendering'
        AND "source" IS NULL
        AND "renderLeaseExpiresAt" IS NOT NULL
        AND "renderLeaseExpiresAt" > "createdAt"
        AND "storageKey" IS NULL
        AND "deliveryId" IS NULL
        AND "cancellationId" IS NULL
        AND "cancellationReasonCode" IS NULL
        AND "failureReasonCode" IS NULL
        AND "readyAt" IS NULL
        AND "deliveredAt" IS NULL
        AND "cancelledAt" IS NULL
        AND "failedAt" IS NULL
      )
      OR (
        "state" = 'ready'
        AND "source" IS NOT NULL
        AND "renderLeaseExpiresAt" IS NULL
        AND "storageKey" IS NOT NULL
        AND "storageExpiresAt" > "readyAt"
        AND "deliveryId" IS NULL
        AND "cancellationId" IS NULL
        AND "cancellationReasonCode" IS NULL
        AND "failureReasonCode" IS NULL
        AND "readyAt" IS NOT NULL
        AND "readyAt" >= "createdAt"
        AND "deliveredAt" IS NULL
        AND "cancelledAt" IS NULL
        AND "failedAt" IS NULL
        AND "objectPurgedAt" IS NULL
      )
      OR (
        "state" = 'delivered'
        AND "source" IS NOT NULL
        AND "renderLeaseExpiresAt" IS NULL
        AND "storageKey" IS NOT NULL
        AND "storageExpiresAt" > "readyAt"
        AND "deliveryId" IS NOT NULL
        AND "cancellationId" IS NULL
        AND "cancellationReasonCode" IS NULL
        AND "failureReasonCode" IS NULL
        AND "readyAt" IS NOT NULL
        AND "deliveredAt" IS NOT NULL
        AND "deliveredAt" >= "readyAt"
        AND "cancelledAt" IS NULL
        AND "failedAt" IS NULL
      )
      OR (
        "state" = 'cancelled'
        AND "renderLeaseExpiresAt" IS NULL
        AND "deliveryId" IS NULL
        AND "cancellationId" IS NOT NULL
        AND "cancellationReasonCode" IS NOT NULL
        AND "failureReasonCode" IS NULL
        AND "deliveredAt" IS NULL
        AND "cancelledAt" IS NOT NULL
        AND "cancelledAt" >= "createdAt"
        AND "failedAt" IS NULL
        AND (
          ("storageKey" IS NULL AND "readyAt" IS NULL AND "source" IS NULL)
          OR (
            "storageKey" IS NOT NULL AND "readyAt" IS NOT NULL AND "source" IS NOT NULL
            AND "cancelledAt" >= "readyAt"
          )
        )
      )
      OR (
        "state" = 'failed'
        AND "source" IS NULL
        AND "renderLeaseExpiresAt" IS NULL
        AND "storageKey" IS NULL
        AND "deliveryId" IS NULL
        AND "cancellationId" IS NULL
        AND "cancellationReasonCode" IS NULL
        AND "failureReasonCode" IS NOT NULL
        AND "readyAt" IS NULL
        AND "deliveredAt" IS NULL
        AND "cancelledAt" IS NULL
        AND "failedAt" IS NOT NULL
        AND "failedAt" >= "createdAt"
      )
    )
);

CREATE INDEX "realtime_speech_artifacts_session_state_idx"
  ON "realtime_speech_artifacts"("companyId", "sessionId", "state", "sequence");
CREATE INDEX "realtime_speech_artifacts_render_reaper_idx"
  ON "realtime_speech_artifacts"("state", "renderLeaseExpiresAt")
  WHERE "state" = 'rendering';
CREATE INDEX "realtime_speech_artifacts_retention_idx"
  ON "realtime_speech_artifacts"("companyId", "retentionExpiresAt");

CREATE TABLE "realtime_control_grants" (
  "id" UUID NOT NULL,
  "companyId" TEXT NOT NULL,
  "sessionId" UUID NOT NULL,
  "turnId" UUID NOT NULL,
  "artifactId" UUID NOT NULL,
  "contextRevision" INTEGER NOT NULL,
  "contextDigest" CHAR(64) NOT NULL,
  "controlKind" TEXT NOT NULL,
  "sealedControl" BYTEA NOT NULL,
  "controlNonce" BYTEA NOT NULL,
  "controlTag" BYTEA NOT NULL,
  "controlPayloadHmac" CHAR(64) NOT NULL,
  "encryptionKeyVersion" INTEGER NOT NULL,
  "proofKeyVersion" INTEGER NOT NULL,
  "issuedAt" TIMESTAMPTZ NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "retentionExpiresAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "realtime_control_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "realtime_control_grants_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "realtime_control_grants_artifact_tenant_fkey"
    FOREIGN KEY ("artifactId", "companyId", "sessionId", "turnId")
    REFERENCES "realtime_speech_artifacts"("id", "companyId", "sessionId", "turnId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "realtime_control_grants_turn_key"
    UNIQUE ("companyId", "sessionId", "turnId"),
  CONSTRAINT "realtime_control_grants_artifact_key"
    UNIQUE ("companyId", "artifactId"),
  CONSTRAINT "realtime_control_grants_artifact_binding_key"
    UNIQUE ("artifactId", "companyId", "sessionId", "turnId"),
  CONSTRAINT "realtime_control_grants_tenant_binding_key"
    UNIQUE ("id", "companyId", "sessionId", "turnId"),
  CONSTRAINT "realtime_control_grants_shape_check"
    CHECK (
      "contextRevision" > 0
      AND "contextDigest"::TEXT ~ '^[a-f0-9]{64}$'
      AND "controlKind" IN ('navigate', 'proposal')
      AND octet_length("sealedControl") BETWEEN 1 AND 32768
      AND octet_length("controlNonce") = 12
      AND octet_length("controlTag") = 16
      AND "controlPayloadHmac"::TEXT ~ '^[a-f0-9]{64}$'
      AND "encryptionKeyVersion" BETWEEN 1 AND 2147483647
      AND "proofKeyVersion" BETWEEN 1 AND 2147483647
      AND "expiresAt" > "issuedAt"
      AND "expiresAt" <= "issuedAt" + INTERVAL '2 minutes'
      AND "retentionExpiresAt" > "expiresAt"
      AND "retentionExpiresAt" <= "issuedAt" + INTERVAL '31 days'
    )
);

CREATE INDEX "realtime_control_grants_session_expiry_idx"
  ON "realtime_control_grants"("companyId", "sessionId", "expiresAt");
CREATE INDEX "realtime_control_grants_retention_idx"
  ON "realtime_control_grants"("companyId", "retentionExpiresAt");

CREATE TABLE "realtime_control_consumptions" (
  "companyId" TEXT NOT NULL,
  "grantId" UUID NOT NULL,
  "acknowledgementId" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "turnId" UUID NOT NULL,
  "consumedAt" TIMESTAMPTZ NOT NULL,
  "retentionExpiresAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "realtime_control_consumptions_pkey" PRIMARY KEY ("companyId", "grantId"),
  CONSTRAINT "realtime_control_consumptions_ack_key" UNIQUE ("companyId", "acknowledgementId"),
  CONSTRAINT "realtime_control_consumptions_binding_key"
    UNIQUE ("grantId", "companyId", "sessionId", "turnId"),
  CONSTRAINT "realtime_control_consumptions_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "realtime_control_consumptions_grant_tenant_fkey"
    FOREIGN KEY ("grantId", "companyId", "sessionId", "turnId")
    REFERENCES "realtime_control_grants"("id", "companyId", "sessionId", "turnId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "realtime_control_consumptions_time_check"
    CHECK (
      "retentionExpiresAt" > "consumedAt"
      AND "retentionExpiresAt" <= "consumedAt" + INTERVAL '31 days'
    )
);

CREATE INDEX "realtime_control_consumptions_session_idx"
  ON "realtime_control_consumptions"("companyId", "sessionId", "consumedAt");
CREATE INDEX "realtime_control_consumptions_retention_idx"
  ON "realtime_control_consumptions"("companyId", "retentionExpiresAt");

CREATE TABLE "realtime_voice_usage_events" (
  "id" UUID NOT NULL,
  "companyId" TEXT NOT NULL,
  "subjectHash" CHAR(64) NOT NULL,
  "subjectKeyVersion" INTEGER NOT NULL,
  "sessionId" UUID NOT NULL,
  "turnId" UUID,
  "dedupeKeyHmac" CHAR(64) NOT NULL,
  "proofKeyVersion" INTEGER NOT NULL,
  "plan" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "amount" NUMERIC(20,6) NOT NULL,
  "occurredAt" TIMESTAMPTZ NOT NULL,
  "recordedAt" TIMESTAMPTZ NOT NULL,
  "retentionExpiresAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "realtime_voice_usage_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "realtime_voice_usage_events_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "realtime_voice_usage_events_dedupe_key"
    UNIQUE ("companyId", "dedupeKeyHmac"),
  CONSTRAINT "realtime_voice_usage_events_kind_check"
    CHECK ("kind" IN (
      'realtime_audio_in_seconds', 'realtime_audio_out_seconds',
      'realtime_tokens_in', 'realtime_tokens_out',
      'llm_tokens_in', 'llm_tokens_out', 'stt_seconds', 'tts_characters'
    )),
  CONSTRAINT "realtime_voice_usage_events_dimension_check"
    CHECK (
      "subjectHash"::TEXT ~ '^[a-f0-9]{64}$'
      AND "subjectKeyVersion" BETWEEN 1 AND 2147483647
      AND "plan" IN ('free', 'solo', 'pro', 'business')
      AND "source" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    ),
  CONSTRAINT "realtime_voice_usage_events_amount_check"
    CHECK (
      "dedupeKeyHmac"::TEXT ~ '^[a-f0-9]{64}$'
      AND "proofKeyVersion" BETWEEN 1 AND 2147483647
      AND "amount" >= 0
      AND "amount" <= 1000000000000
      AND "recordedAt" >= "occurredAt"
      AND "recordedAt" <= "occurredAt" + INTERVAL '1 day'
      AND "retentionExpiresAt" > "recordedAt"
      AND "retentionExpiresAt" <= "recordedAt" + INTERVAL '36 days'
    )
);

CREATE INDEX "realtime_voice_usage_events_tenant_time_idx"
  ON "realtime_voice_usage_events"("companyId", "occurredAt");
CREATE INDEX "realtime_voice_usage_events_session_time_idx"
  ON "realtime_voice_usage_events"("companyId", "sessionId", "occurredAt");
CREATE INDEX "realtime_voice_usage_events_retention_idx"
  ON "realtime_voice_usage_events"("companyId", "retentionExpiresAt");

CREATE TABLE "realtime_voice_usage_daily" (
  "companyId" TEXT NOT NULL,
  "usageDate" DATE NOT NULL,
  "subjectHash" CHAR(64) NOT NULL,
  "subjectKeyVersion" INTEGER NOT NULL,
  "plan" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "amount" NUMERIC(26,6) NOT NULL,
  "eventCount" BIGINT NOT NULL DEFAULT 0,
  "firstEventAt" TIMESTAMPTZ NOT NULL,
  "lastEventAt" TIMESTAMPTZ NOT NULL,
  "aggregatedAt" TIMESTAMPTZ NOT NULL,
  "retentionExpiresAt" TIMESTAMPTZ NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "realtime_voice_usage_daily_pkey" PRIMARY KEY (
    "companyId", "usageDate", "subjectHash", "subjectKeyVersion", "plan", "kind", "source"
  ),
  CONSTRAINT "realtime_voice_usage_daily_company_fkey"
    FOREIGN KEY ("companyId") REFERENCES "companies"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "realtime_voice_usage_daily_shape_check"
    CHECK (
      "subjectHash"::TEXT ~ '^[a-f0-9]{64}$'
      AND "subjectKeyVersion" BETWEEN 1 AND 2147483647
      AND "plan" IN ('free', 'solo', 'pro', 'business')
      AND "kind" IN (
        'realtime_audio_in_seconds', 'realtime_audio_out_seconds',
        'realtime_tokens_in', 'realtime_tokens_out',
        'llm_tokens_in', 'llm_tokens_out', 'stt_seconds', 'tts_characters'
      )
      AND "source" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
      AND "amount" >= 0
      AND "eventCount" > 0
      AND "firstEventAt" <= "lastEventAt"
      AND "aggregatedAt" >= "firstEventAt"
      AND "retentionExpiresAt" = ("usageDate" + INTERVAL '400 days')
      AND "version" > 0
    )
);

CREATE INDEX "realtime_voice_usage_daily_retention_idx"
  ON "realtime_voice_usage_daily"("companyId", "retentionExpiresAt");

-- Fence central : publication acoustique et consommation de contrôles échouent dès que le
-- contexte publié, le contexte appliqué ou le propriétaire sideband ne sont plus exacts.
CREATE FUNCTION assert_realtime_context_fence(
  tenant_id TEXT,
  voice_session_id UUID,
  expected_revision INTEGER,
  expected_digest CHAR(64)
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.realtime_session_leases AS lease
     WHERE lease."companyId" = tenant_id
       AND lease."sessionId" = voice_session_id
       AND lease."state" = 'active'
       AND lease."leaseExpiresAt" > clock_timestamp()
       AND lease."hardExpiresAt" > clock_timestamp()
       AND lease."contextRevision" = expected_revision
       AND lease."contextDigest" = expected_digest
       AND lease."contextAppliedRevision" = expected_revision
       AND lease."contextAppliedDigest" = expected_digest
       AND lease."sidebandOwnerTokenHash" IS NOT NULL
       AND lease."sidebandOwnerLeaseExpiresAt" > clock_timestamp()
       AND lease."sidebandProtocolVersion" = 2
  ) THEN
    RAISE EXCEPTION 'realtime context fence rejected'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

CREATE FUNCTION guard_realtime_speech_artifact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  allocated_sequence INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'rendering'
      OR NEW."version" <> 1
      OR NEW."updatedAt" <> NEW."createdAt"
      OR NEW."createdAt" > clock_timestamp() + INTERVAL '1 minute'
    THEN
      RAISE EXCEPTION 'invalid initial realtime speech artifact'
        USING ERRCODE = '55000';
    END IF;
    PERFORM public.assert_realtime_context_fence(
      NEW."companyId", NEW."sessionId", NEW."contextRevision", NEW."contextDigest"
    );

    UPDATE public.realtime_session_leases AS lease
       SET "nextSpeechSequence" = lease."nextSpeechSequence" + 1
     WHERE lease."companyId" = NEW."companyId"
       AND lease."sessionId" = NEW."sessionId"
       AND lease."subjectHash" = NEW."subjectHash"
       AND lease."nextSpeechSequence" < 2147483647
    RETURNING lease."nextSpeechSequence" - 1 INTO allocated_sequence;

    IF allocated_sequence IS NULL THEN
      RAISE EXCEPTION 'realtime speech sequence reservation rejected'
        USING ERRCODE = '55000';
    END IF;
    NEW."sequence" := allocated_sequence;
    RETURN NEW;
  END IF;

  IF ROW(
    NEW."id", NEW."companyId", NEW."subjectHash", NEW."sessionId", NEW."turnId",
    NEW."sequence", NEW."segmentIndex", NEW."renderTokenHash", NEW."classification",
    NEW."canonicalSpeechHmac", NEW."factsHmac",
    NEW."contextRevision", NEW."contextDigest",
    NEW."createdAt", NEW."retentionExpiresAt"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."companyId", OLD."subjectHash", OLD."sessionId", OLD."turnId",
    OLD."sequence", OLD."segmentIndex", OLD."renderTokenHash", OLD."classification",
    OLD."canonicalSpeechHmac", OLD."factsHmac",
    OLD."contextRevision", OLD."contextDigest",
    OLD."createdAt", OLD."retentionExpiresAt"
  ) THEN
    RAISE EXCEPTION 'realtime speech artifact binding is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."version" <> OLD."version" + 1 OR NEW."updatedAt" < OLD."updatedAt" THEN
    RAISE EXCEPTION 'realtime speech artifact CAS version rejected'
      USING ERRCODE = '40001';
  END IF;

  IF OLD."state" = 'rendering' AND NEW."state" = 'rendering' THEN
    IF NEW."renderLeaseExpiresAt" <= clock_timestamp() THEN
      RAISE EXCEPTION 'render lease renewal must remain live'
        USING ERRCODE = '55000';
    END IF;
    IF ROW(
      NEW."storageKey", NEW."storageExpiresAt", NEW."mimeType", NEW."byteLength",
      NEW."durationMs", NEW."canonicalSpeechHmac", NEW."auditTranscriptHmac",
      NEW."factsHmac", NEW."evidenceHmac", NEW."audioSha256", NEW."proofKeyVersion",
      NEW."synthesisAdapterId", NEW."synthesisTrustDomain", NEW."auditAdapterId",
      NEW."auditTrustDomain", NEW."deliveryId", NEW."cancellationId",
      NEW."cancellationReasonCode", NEW."failureReasonCode", NEW."objectPurgedAt",
      NEW."purgeTokenHash", NEW."purgeLeaseExpiresAt", NEW."readyAt", NEW."deliveredAt",
      NEW."cancelledAt", NEW."failedAt"
    ) IS DISTINCT FROM ROW(
      OLD."storageKey", OLD."storageExpiresAt", OLD."mimeType", OLD."byteLength",
      OLD."durationMs", OLD."canonicalSpeechHmac", OLD."auditTranscriptHmac",
      OLD."factsHmac", OLD."evidenceHmac", OLD."audioSha256", OLD."proofKeyVersion",
      OLD."synthesisAdapterId", OLD."synthesisTrustDomain", OLD."auditAdapterId",
      OLD."auditTrustDomain", OLD."deliveryId", OLD."cancellationId",
      OLD."cancellationReasonCode", OLD."failureReasonCode", OLD."objectPurgedAt",
      OLD."purgeTokenHash", OLD."purgeLeaseExpiresAt", OLD."readyAt", OLD."deliveredAt",
      OLD."cancelledAt", OLD."failedAt"
    ) THEN
      RAISE EXCEPTION 'render heartbeat may only renew its lease'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."state" = 'rendering' AND NEW."state" IN ('ready', 'cancelled', 'failed') THEN
    IF NEW."renderTokenHash" <> OLD."renderTokenHash" THEN
      RAISE EXCEPTION 'render finalization token mismatch'
        USING ERRCODE = '40001';
    END IF;
    IF NEW."state" = 'ready' THEN
      PERFORM public.assert_realtime_context_fence(
        NEW."companyId", NEW."sessionId", NEW."contextRevision", NEW."contextDigest"
      );
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."state" = 'ready' AND NEW."state" IN ('delivered', 'cancelled') THEN
    IF ROW(
      NEW."storageKey", NEW."mimeType", NEW."byteLength", NEW."durationMs",
      NEW."canonicalSpeechHmac", NEW."auditTranscriptHmac", NEW."factsHmac",
      NEW."evidenceHmac", NEW."audioSha256", NEW."proofKeyVersion",
      NEW."synthesisAdapterId", NEW."synthesisTrustDomain", NEW."auditAdapterId",
      NEW."auditTrustDomain", NEW."source", NEW."renderTokenHash", NEW."readyAt", NEW."objectPurgedAt",
      NEW."purgeTokenHash", NEW."purgeLeaseExpiresAt"
    ) IS DISTINCT FROM ROW(
      OLD."storageKey", OLD."mimeType", OLD."byteLength", OLD."durationMs",
      OLD."canonicalSpeechHmac", OLD."auditTranscriptHmac", OLD."factsHmac",
      OLD."evidenceHmac", OLD."audioSha256", OLD."proofKeyVersion",
      OLD."synthesisAdapterId", OLD."synthesisTrustDomain", OLD."auditAdapterId",
      OLD."auditTrustDomain", OLD."source", OLD."renderTokenHash", OLD."readyAt", OLD."objectPurgedAt",
      OLD."purgeTokenHash", OLD."purgeLeaseExpiresAt"
    ) THEN
      RAISE EXCEPTION 'audited speech proof is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF NEW."state" = 'delivered' THEN
      PERFORM public.assert_realtime_context_fence(
        NEW."companyId", NEW."sessionId", NEW."contextRevision", NEW."contextDigest"
      );
    END IF;
    RETURN NEW;
  END IF;

  -- Le reaper peut uniquement acquérir/renouveler un bail de purge ou certifier la suppression
  -- de l'objet. Le binding, les preuves acoustiques et l'état terminal restent immuables.
  IF OLD."state" IN ('delivered', 'cancelled') AND NEW."state" = OLD."state" THEN
    IF ROW(
      NEW."storageKey", NEW."storageExpiresAt", NEW."mimeType", NEW."byteLength",
      NEW."durationMs", NEW."canonicalSpeechHmac", NEW."auditTranscriptHmac",
      NEW."factsHmac", NEW."evidenceHmac", NEW."audioSha256", NEW."proofKeyVersion",
      NEW."synthesisAdapterId", NEW."synthesisTrustDomain", NEW."auditAdapterId",
      NEW."auditTrustDomain", NEW."source", NEW."renderTokenHash",
      NEW."renderLeaseExpiresAt", NEW."deliveryId",
      NEW."cancellationId", NEW."cancellationReasonCode", NEW."failureReasonCode",
      NEW."readyAt", NEW."deliveredAt", NEW."cancelledAt", NEW."failedAt"
    ) IS DISTINCT FROM ROW(
      OLD."storageKey", OLD."storageExpiresAt", OLD."mimeType", OLD."byteLength",
      OLD."durationMs", OLD."canonicalSpeechHmac", OLD."auditTranscriptHmac",
      OLD."factsHmac", OLD."evidenceHmac", OLD."audioSha256", OLD."proofKeyVersion",
      OLD."synthesisAdapterId", OLD."synthesisTrustDomain", OLD."auditAdapterId",
      OLD."auditTrustDomain", OLD."source", OLD."renderTokenHash",
      OLD."renderLeaseExpiresAt", OLD."deliveryId",
      OLD."cancellationId", OLD."cancellationReasonCode", OLD."failureReasonCode",
      OLD."readyAt", OLD."deliveredAt", OLD."cancelledAt", OLD."failedAt"
    ) THEN
      RAISE EXCEPTION 'purge may not rewrite realtime speech evidence'
        USING ERRCODE = '55000';
    END IF;

    IF OLD."objectPurgedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'realtime speech object is already purged'
        USING ERRCODE = '55000';
    END IF;

    IF NEW."objectPurgedAt" IS NOT NULL THEN
      IF OLD."purgeTokenHash" IS NULL
        OR NEW."purgeTokenHash" IS NOT NULL
        OR NEW."purgeLeaseExpiresAt" IS NOT NULL
        OR NEW."objectPurgedAt" < OLD."updatedAt"
      THEN
        RAISE EXCEPTION 'invalid realtime speech purge completion'
          USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END IF;

    IF NEW."purgeTokenHash" IS NULL
      OR NEW."purgeLeaseExpiresAt" <= clock_timestamp()
      OR (
        OLD."purgeTokenHash" IS NOT NULL
        AND OLD."purgeTokenHash" <> NEW."purgeTokenHash"
        AND OLD."purgeLeaseExpiresAt" > clock_timestamp()
      )
    THEN
      RAISE EXCEPTION 'invalid realtime speech purge lease CAS'
        USING ERRCODE = '40001';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'illegal realtime speech artifact transition % -> %', OLD."state", NEW."state"
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "realtime_speech_artifacts_guard"
BEFORE INSERT OR UPDATE ON "realtime_speech_artifacts"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_speech_artifact();

CREATE FUNCTION guard_realtime_control_grant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'realtime control grants are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."issuedAt" > clock_timestamp() + INTERVAL '1 minute'
    OR NEW."expiresAt" <= clock_timestamp()
  THEN
    RAISE EXCEPTION 'realtime control grant is outside its validity window'
      USING ERRCODE = '55000';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.realtime_speech_artifacts AS artifact
     WHERE artifact."id" = NEW."artifactId"
       AND artifact."companyId" = NEW."companyId"
       AND artifact."sessionId" = NEW."sessionId"
       AND artifact."turnId" = NEW."turnId"
       AND artifact."state" = 'delivered'
       AND artifact."contextRevision" = NEW."contextRevision"
       AND artifact."contextDigest" = NEW."contextDigest"
       AND artifact."deliveredAt" <= NEW."issuedAt"
  ) THEN
    RAISE EXCEPTION 'control grant requires an exactly bound delivered artifact'
      USING ERRCODE = '55000';
  END IF;

  PERFORM public.assert_realtime_context_fence(
    NEW."companyId", NEW."sessionId", NEW."contextRevision", NEW."contextDigest"
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "realtime_control_grants_guard"
BEFORE INSERT OR UPDATE ON "realtime_control_grants"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_control_grant();

CREATE FUNCTION guard_realtime_control_consumption()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  existing_ack UUID;
  grant_revision INTEGER;
  grant_digest CHAR(64);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'realtime control consumptions are immutable'
      USING ERRCODE = '55000';
  END IF;

  SELECT consumption."acknowledgementId"
    INTO existing_ack
    FROM public.realtime_control_consumptions AS consumption
   WHERE consumption."companyId" = NEW."companyId"
     AND consumption."grantId" = NEW."grantId";

  IF existing_ack IS NOT NULL THEN
    IF existing_ack <> NEW."acknowledgementId" THEN
      RAISE EXCEPTION 'realtime control grant already consumed'
        USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
  END IF;

  SELECT control_grant."contextRevision", control_grant."contextDigest"
    INTO grant_revision, grant_digest
    FROM public.realtime_control_grants AS control_grant
   WHERE control_grant."id" = NEW."grantId"
     AND control_grant."companyId" = NEW."companyId"
     AND control_grant."sessionId" = NEW."sessionId"
     AND control_grant."turnId" = NEW."turnId"
     AND control_grant."expiresAt" > clock_timestamp();

  IF grant_revision IS NULL THEN
    RAISE EXCEPTION 'realtime control grant is missing or expired'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."consumedAt" < clock_timestamp() - INTERVAL '1 minute'
    OR NEW."consumedAt" > clock_timestamp() + INTERVAL '1 minute'
  THEN
    RAISE EXCEPTION 'invalid realtime control consumption timestamp'
      USING ERRCODE = '55000';
  END IF;

  PERFORM public.assert_realtime_context_fence(
    NEW."companyId", NEW."sessionId", grant_revision, grant_digest
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "realtime_control_consumptions_guard"
BEFORE INSERT OR UPDATE ON "realtime_control_consumptions"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_control_consumption();

CREATE FUNCTION reject_realtime_voice_usage_event_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'realtime voice usage events are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "realtime_voice_usage_events_immutable"
BEFORE UPDATE ON "realtime_voice_usage_events"
FOR EACH ROW EXECUTE FUNCTION reject_realtime_voice_usage_event_update();

CREATE FUNCTION guard_realtime_voice_usage_daily()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'daily voice usage may only be changed by its event rollup trigger'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."eventCount" <> 1 OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'invalid initial daily voice usage aggregate'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."companyId" <> OLD."companyId"
    OR NEW."usageDate" <> OLD."usageDate"
    OR NEW."subjectHash" <> OLD."subjectHash"
    OR NEW."subjectKeyVersion" <> OLD."subjectKeyVersion"
    OR NEW."plan" <> OLD."plan"
    OR NEW."kind" <> OLD."kind"
    OR NEW."source" <> OLD."source"
    OR NEW."eventCount" <> OLD."eventCount" + 1
    OR NEW."version" <> OLD."version" + 1
    OR NEW."amount" < OLD."amount"
    OR NEW."firstEventAt" > OLD."firstEventAt"
    OR NEW."lastEventAt" < OLD."lastEventAt"
    OR NEW."aggregatedAt" < OLD."aggregatedAt"
    OR NEW."retentionExpiresAt" <> OLD."retentionExpiresAt"
  THEN
    RAISE EXCEPTION 'daily voice usage aggregate is not monotone'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "realtime_voice_usage_daily_guard"
BEFORE INSERT OR UPDATE ON "realtime_voice_usage_daily"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_voice_usage_daily();

CREATE FUNCTION rollup_realtime_voice_usage_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  usage_day DATE := (NEW."occurredAt" AT TIME ZONE 'UTC')::DATE;
BEGIN
  INSERT INTO public.realtime_voice_usage_daily (
    "companyId", "usageDate", "subjectHash", "subjectKeyVersion", "plan", "kind", "source",
    "amount", "eventCount", "firstEventAt", "lastEventAt", "aggregatedAt",
    "retentionExpiresAt", "version"
  ) VALUES (
    NEW."companyId", usage_day, NEW."subjectHash", NEW."subjectKeyVersion", NEW."plan",
    NEW."kind", NEW."source", NEW."amount", 1, NEW."occurredAt", NEW."occurredAt",
    clock_timestamp(), usage_day + INTERVAL '400 days', 1
  )
  ON CONFLICT (
    "companyId", "usageDate", "subjectHash", "subjectKeyVersion", "plan", "kind", "source"
  ) DO UPDATE SET
    "amount" = public.realtime_voice_usage_daily."amount" + EXCLUDED."amount",
    "eventCount" = public.realtime_voice_usage_daily."eventCount" + 1,
    "firstEventAt" = LEAST(public.realtime_voice_usage_daily."firstEventAt", EXCLUDED."firstEventAt"),
    "lastEventAt" = GREATEST(public.realtime_voice_usage_daily."lastEventAt", EXCLUDED."lastEventAt"),
    "aggregatedAt" = clock_timestamp(),
    "version" = public.realtime_voice_usage_daily."version" + 1;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION rollup_realtime_voice_usage_event() FROM PUBLIC;

CREATE TRIGGER "realtime_voice_usage_events_rollup"
AFTER INSERT ON "realtime_voice_usage_events"
FOR EACH ROW EXECUTE FUNCTION rollup_realtime_voice_usage_event();

-- RLS fail-closed dès la migration, avant même la réapplication du script général.
ALTER TABLE "realtime_speech_artifacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_speech_artifacts" FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_speech_artifact_select ON "realtime_speech_artifacts"
  FOR SELECT USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_speech_artifact_insert ON "realtime_speech_artifacts"
  FOR INSERT WITH CHECK ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_speech_artifact_update ON "realtime_speech_artifacts"
  FOR UPDATE
  USING ("companyId" = current_setting('app.current_company_id', true))
  WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

ALTER TABLE "realtime_control_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_control_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_control_grant_select ON "realtime_control_grants"
  FOR SELECT USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_control_grant_insert ON "realtime_control_grants"
  FOR INSERT WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

ALTER TABLE "realtime_control_consumptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_control_consumptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_control_consumption_select ON "realtime_control_consumptions"
  FOR SELECT USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_control_consumption_insert ON "realtime_control_consumptions"
  FOR INSERT WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

ALTER TABLE "realtime_voice_usage_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_voice_usage_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_voice_usage_event_select ON "realtime_voice_usage_events"
  FOR SELECT USING ("companyId" = current_setting('app.current_company_id', true));
CREATE POLICY realtime_voice_usage_event_insert ON "realtime_voice_usage_events"
  FOR INSERT WITH CHECK ("companyId" = current_setting('app.current_company_id', true));

ALTER TABLE "realtime_voice_usage_daily" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "realtime_voice_usage_daily" FORCE ROW LEVEL SECURITY;
CREATE POLICY realtime_voice_usage_daily_select ON "realtime_voice_usage_daily"
  FOR SELECT USING ("companyId" = current_setting('app.current_company_id', true));
-- Fallback non-superuser pour le trigger de rollup ; aucun DML direct ne peut avoir une
-- profondeur de trigger positive et les ACL runtime révoquent en plus INSERT/UPDATE.
CREATE POLICY realtime_voice_usage_daily_rollup_insert ON "realtime_voice_usage_daily"
  FOR INSERT WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND pg_trigger_depth() > 0
  );
CREATE POLICY realtime_voice_usage_daily_rollup_update ON "realtime_voice_usage_daily"
  FOR UPDATE
  USING (
    "companyId" = current_setting('app.current_company_id', true)
    AND pg_trigger_depth() > 0
  )
  WITH CHECK (
    "companyId" = current_setting('app.current_company_id', true)
    AND pg_trigger_depth() > 0
  );

-- Aucun rôle ne reçoit de droits par héritage PUBLIC. release.sh accorde ensuite le minimum au
-- rôle runtime et conserve les purges de rétention dans le rôle reaper privilégié.
REVOKE ALL ON TABLE
  "realtime_speech_artifacts",
  "realtime_control_grants",
  "realtime_control_consumptions",
  "realtime_voice_usage_events",
  "realtime_voice_usage_daily"
FROM PUBLIC;

COMMENT ON TABLE "realtime_speech_artifacts" IS
  'Métadonnées de segments audio privés éphémères; aucune parole ni transcription brute.';
COMMENT ON COLUMN "realtime_speech_artifacts"."storageKey" IS
  'Clé déterministe company/session/turn/artifact. Après crash upload avant CAS, le reaper la redérive des IDs même si cette colonne est encore NULL.';
COMMENT ON COLUMN "realtime_speech_artifacts"."canonicalSpeechHmac" IS
  'HMAC-SHA-256 versionné du texte canonique, jamais le texte lui-même.';
COMMENT ON COLUMN "realtime_speech_artifacts"."auditTranscriptHmac" IS
  'HMAC-SHA-256 versionné de la transcription STT indépendante, jamais la transcription.';
COMMENT ON TABLE "realtime_control_grants" IS
  'Contrôle UI chiffré one-shot, lié à une livraison audio auditée et au contexte exact.';
COMMENT ON TABLE "realtime_voice_usage_events" IS
  'Usage vocal append-only dédupliqué; aucun contenu utilisateur ou audio.';

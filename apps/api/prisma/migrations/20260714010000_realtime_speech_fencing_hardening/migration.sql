-- Bob Live — hardening post-audit : epoch sideband, preuves non-null et fences atomiques.
-- Cette migration est additive/corrective afin de ne jamais réécrire une migration déjà publiée.

ALTER TABLE "realtime_session_leases"
  ADD COLUMN "sidebandOwnerEpoch" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "contextAppliedOwnerEpoch" INTEGER;

UPDATE "realtime_session_leases"
   SET "sidebandOwnerEpoch" = 1
 WHERE "sidebandOwnerTokenHash" IS NOT NULL;

UPDATE "realtime_session_leases"
   SET "contextAppliedOwnerEpoch" = "sidebandOwnerEpoch"
 WHERE "contextAppliedRevision" IS NOT NULL;

ALTER TABLE "realtime_session_leases"
  DROP CONSTRAINT "realtime_session_leases_sideband_owner_shape_check",
  DROP CONSTRAINT "realtime_session_leases_context_applied_shape_check",
  ADD CONSTRAINT "realtime_session_leases_sideband_owner_shape_check"
    CHECK (
      "sidebandOwnerEpoch" BETWEEN 0 AND 2147483647
      AND (
        (
          "sidebandOwnerInstanceHash" IS NULL
          AND "sidebandOwnerTokenHash" IS NULL
          AND "sidebandOwnerLeaseExpiresAt" IS NULL
        )
        OR (
          "sidebandOwnerEpoch" > 0
          AND "sidebandOwnerInstanceHash" IS NOT NULL
          AND "sidebandOwnerInstanceHash"::TEXT ~ '^[a-f0-9]{64}$'
          AND "sidebandOwnerTokenHash" IS NOT NULL
          AND "sidebandOwnerTokenHash"::TEXT ~ '^[a-f0-9]{64}$'
          AND "sidebandOwnerLeaseExpiresAt" IS NOT NULL
          AND "sidebandOwnerLeaseExpiresAt" > "reservedAt"
          AND "providerCallId" IS NOT NULL
          AND "state" IN ('bound', 'active', 'reaping')
        )
      )
    ),
  ADD CONSTRAINT "realtime_session_leases_context_applied_shape_check"
    CHECK (
      (
        "contextAppliedRevision" IS NULL
        AND "contextAppliedDigest" IS NULL
        AND "contextAppliedAt" IS NULL
        AND "contextAppliedOwnerEpoch" IS NULL
      )
      OR (
        "contextAppliedRevision" IS NOT NULL
        AND "contextAppliedRevision" > 0
        AND "contextAppliedDigest" IS NOT NULL
        AND "contextAppliedDigest"::TEXT ~ '^[a-f0-9]{64}$'
        AND "contextAppliedAt" IS NOT NULL
        AND "contextAppliedAt" >= "reservedAt"
        AND "contextAppliedOwnerEpoch" IS NOT NULL
        AND "contextAppliedOwnerEpoch" = "sidebandOwnerEpoch"
        AND "contextRevision" IS NOT NULL
        AND "contextAppliedRevision" <= "contextRevision"
        AND (
          "contextAppliedRevision" <> "contextRevision"
          OR (
            "contextDigest" IS NOT NULL
            AND "contextAppliedDigest" = "contextDigest"
          )
        )
        AND "sidebandOwnerTokenHash" IS NOT NULL
      )
    );

CREATE FUNCTION guard_realtime_sideband_epoch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."sidebandOwnerTokenHash" IS NULL THEN
      IF NEW."sidebandOwnerEpoch" <> 0 OR NEW."contextAppliedOwnerEpoch" IS NOT NULL THEN
        RAISE EXCEPTION 'invalid initial sideband epoch' USING ERRCODE = '55000';
      END IF;
    ELSIF NEW."sidebandOwnerEpoch" <= 0
      OR NEW."contextAppliedOwnerEpoch" IS DISTINCT FROM NEW."sidebandOwnerEpoch"
    THEN
      RAISE EXCEPTION 'invalid bound sideband epoch' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."sidebandOwnerTokenHash" IS DISTINCT FROM OLD."sidebandOwnerTokenHash" THEN
    IF NEW."sidebandOwnerTokenHash" IS NULL THEN
      IF NEW."sidebandOwnerEpoch" <> OLD."sidebandOwnerEpoch"
        OR NEW."contextAppliedRevision" IS NOT NULL
        OR NEW."contextAppliedDigest" IS NOT NULL
        OR NEW."contextAppliedAt" IS NOT NULL
        OR NEW."contextAppliedOwnerEpoch" IS NOT NULL
      THEN
        RAISE EXCEPTION 'sideband release must clear applied context' USING ERRCODE = '55000';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD."sidebandOwnerTokenHash" IS NOT NULL
      AND OLD."sidebandOwnerLeaseExpiresAt" > clock_timestamp()
    THEN
      RAISE EXCEPTION 'live sideband owner cannot be replaced' USING ERRCODE = '40001';
    END IF;
    IF NEW."sidebandOwnerEpoch" <> OLD."sidebandOwnerEpoch" + 1
      OR NEW."contextAppliedRevision" IS NOT NULL
      OR NEW."contextAppliedDigest" IS NOT NULL
      OR NEW."contextAppliedAt" IS NOT NULL
      OR NEW."contextAppliedOwnerEpoch" IS NOT NULL
    THEN
      RAISE EXCEPTION 'sideband takeover requires a new empty epoch' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."sidebandOwnerEpoch" <> OLD."sidebandOwnerEpoch" THEN
    RAISE EXCEPTION 'sideband epoch is immutable within one ownership' USING ERRCODE = '55000';
  END IF;
  IF ROW(
    NEW."contextAppliedRevision", NEW."contextAppliedDigest",
    NEW."contextAppliedAt", NEW."contextAppliedOwnerEpoch"
  ) IS DISTINCT FROM ROW(
    OLD."contextAppliedRevision", OLD."contextAppliedDigest",
    OLD."contextAppliedAt", OLD."contextAppliedOwnerEpoch"
  ) AND (
    NEW."sidebandOwnerTokenHash" IS NULL
    OR NEW."sidebandOwnerLeaseExpiresAt" <= clock_timestamp()
    OR NEW."contextAppliedOwnerEpoch" IS DISTINCT FROM NEW."sidebandOwnerEpoch"
  ) THEN
    RAISE EXCEPTION 'applied context requires the live owner epoch' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "realtime_session_leases_sideband_epoch_guard"
BEFORE INSERT OR UPDATE ON "realtime_session_leases"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_sideband_epoch();

ALTER TABLE "realtime_speech_artifacts"
  ADD COLUMN "sidebandOwnerEpoch" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "sidebandOwnerTokenHash" CHAR(64) NOT NULL DEFAULT repeat('0', 64);

ALTER TABLE "realtime_speech_artifacts"
  ALTER COLUMN "sidebandOwnerEpoch" DROP DEFAULT,
  ALTER COLUMN "sidebandOwnerTokenHash" DROP DEFAULT,
  ADD CONSTRAINT "realtime_speech_artifacts_sideband_binding_check"
    CHECK (
      "sidebandOwnerEpoch" BETWEEN 0 AND 2147483647
      AND "sidebandOwnerTokenHash"::TEXT ~ '^[a-f0-9]{64}$'
    );

-- CHECK accepte UNKNOWN : cette contrainte explicite rend impossible un ready/delivered dont un
-- champ acoustique obligatoire serait NULL, même si une ancienne contrainte retournait UNKNOWN.
ALTER TABLE "realtime_speech_artifacts"
  ADD CONSTRAINT "realtime_speech_artifacts_required_proof_v2_check"
    CHECK (
      NOT (
        "state" IN ('ready', 'delivered')
        OR ("state" = 'cancelled' AND "storageKey" IS NOT NULL)
      )
      OR (
        "source" IS NOT NULL
        AND "storageKey" IS NOT NULL
        AND "storageExpiresAt" IS NOT NULL
        AND "mimeType" IS NOT NULL
        AND "byteLength" IS NOT NULL
        AND "durationMs" IS NOT NULL
        AND "evidenceHmac" IS NOT NULL
        AND "audioSha256" IS NOT NULL
        AND "proofKeyVersion" IS NOT NULL
        AND "synthesisAdapterId" IS NOT NULL
        AND "synthesisTrustDomain" IS NOT NULL
        AND "readyAt" IS NOT NULL
        AND "storageExpiresAt" > "readyAt"
        AND "storageExpiresAt" <= "retentionExpiresAt"
        AND (
          "source" <> 'synthesized_audited'
          OR (
            "auditTranscriptHmac" IS NOT NULL
            AND "auditAdapterId" IS NOT NULL
            AND "auditTrustDomain" IS NOT NULL
          )
        )
      )
    ),
  ADD CONSTRAINT "realtime_speech_artifacts_required_state_v2_check"
    CHECK (
      ("state" <> 'rendering' OR "renderLeaseExpiresAt" IS NOT NULL)
      AND ("state" <> 'ready' OR "readyAt" IS NOT NULL)
      AND (
        "state" <> 'delivered'
        OR ("deliveryId" IS NOT NULL AND "deliveredAt" IS NOT NULL)
      )
      AND (
        "state" <> 'cancelled'
        OR (
          "cancellationId" IS NOT NULL
          AND "cancellationReasonCode" IS NOT NULL
          AND "cancelledAt" IS NOT NULL
        )
      )
      AND (
        "state" <> 'failed'
        OR ("failureReasonCode" IS NOT NULL AND "failedAt" IS NOT NULL)
      )
    );

CREATE FUNCTION assert_realtime_context_fence_v2(
  tenant_id TEXT,
  voice_session_id UUID,
  expected_revision INTEGER,
  expected_digest CHAR(64),
  expected_owner_token_hash CHAR(64),
  expected_owner_epoch INTEGER
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1
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
     AND lease."contextAppliedOwnerEpoch" = expected_owner_epoch
     AND lease."sidebandOwnerEpoch" = expected_owner_epoch
     AND lease."sidebandOwnerTokenHash" = expected_owner_token_hash
     AND lease."sidebandOwnerLeaseExpiresAt" > clock_timestamp()
     AND lease."sidebandProtocolVersion" = 2
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'realtime context owner fence rejected' USING ERRCODE = '55000';
  END IF;
END;
$$;

-- Exécuté avant l'ancien trigger : sérialise aussi les writers directs utilisant ON CONFLICT et
-- empêche qu'un BEFORE INSERT consommant nextSpeechSequence crée un trou durable.
CREATE FUNCTION guard_realtime_speech_claim_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'bob-live:speech:' || NEW."companyId" || ':' || NEW."sessionId"::TEXT
      || ':' || NEW."turnId"::TEXT || ':' || NEW."segmentIndex"::TEXT,
    0
  ));
  IF EXISTS (
    SELECT 1 FROM public.realtime_speech_artifacts AS existing
     WHERE existing."companyId" = NEW."companyId"
       AND existing."sessionId" = NEW."sessionId"
       AND existing."turnId" = NEW."turnId"
       AND existing."segmentIndex" = NEW."segmentIndex"
  ) THEN
    RAISE EXCEPTION 'realtime speech segment already exists' USING ERRCODE = '23505';
  END IF;
  IF NEW."sidebandOwnerEpoch" <= 0
    OR NEW."sidebandOwnerTokenHash"::TEXT !~ '^[a-f0-9]{64}$'
  THEN
    RAISE EXCEPTION 'invalid realtime speech owner binding' USING ERRCODE = '55000';
  END IF;
  PERFORM public.assert_realtime_context_fence_v2(
    NEW."companyId", NEW."sessionId", NEW."contextRevision", NEW."contextDigest",
    NEW."sidebandOwnerTokenHash", NEW."sidebandOwnerEpoch"
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "00_realtime_speech_artifacts_claim_guard_v2"
BEFORE INSERT ON "realtime_speech_artifacts"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_speech_claim_v2();

CREATE FUNCTION guard_realtime_speech_transition_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF ROW(NEW."sidebandOwnerEpoch", NEW."sidebandOwnerTokenHash") IS DISTINCT FROM
     ROW(OLD."sidebandOwnerEpoch", OLD."sidebandOwnerTokenHash")
  THEN
    RAISE EXCEPTION 'realtime speech owner binding is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD."state" = 'rendering' AND NEW."state" = 'ready' THEN
    IF OLD."renderLeaseExpiresAt" IS NULL
      OR OLD."renderLeaseExpiresAt" <= clock_timestamp()
      OR NEW."storageExpiresAt" IS NULL
      OR NEW."storageExpiresAt" > NEW."retentionExpiresAt"
    THEN
      RAISE EXCEPTION 'expired renderer cannot publish ready' USING ERRCODE = '55000';
    END IF;
    PERFORM public.assert_realtime_context_fence_v2(
      NEW."companyId", NEW."sessionId", NEW."contextRevision", NEW."contextDigest",
      NEW."sidebandOwnerTokenHash", NEW."sidebandOwnerEpoch"
    );
  END IF;

  IF OLD."state" = 'ready' AND NEW."state" IN ('delivered', 'cancelled') THEN
    IF NEW."storageExpiresAt" IS NULL
      OR OLD."storageExpiresAt" IS NULL
      OR NEW."storageExpiresAt" > OLD."storageExpiresAt"
      OR NEW."storageExpiresAt" > NEW."retentionExpiresAt"
    THEN
      RAISE EXCEPTION 'realtime speech storage expiry cannot be extended' USING ERRCODE = '55000';
    END IF;
    IF NEW."state" = 'delivered' THEN
      IF NEW."storageExpiresAt" <= clock_timestamp() OR NEW."objectPurgedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'expired or purged speech cannot be delivered' USING ERRCODE = '55000';
      END IF;
      PERFORM public.assert_realtime_context_fence_v2(
        NEW."companyId", NEW."sessionId", NEW."contextRevision", NEW."contextDigest",
        NEW."sidebandOwnerTokenHash", NEW."sidebandOwnerEpoch"
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "realtime_speech_artifacts_transition_guard_v2"
BEFORE UPDATE ON "realtime_speech_artifacts"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_speech_transition_v2();

CREATE FUNCTION guard_realtime_control_grant_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  owner_epoch INTEGER;
  owner_token CHAR(64);
BEGIN
  IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
  SELECT artifact."sidebandOwnerEpoch", artifact."sidebandOwnerTokenHash"
    INTO owner_epoch, owner_token
    FROM public.realtime_speech_artifacts AS artifact
   WHERE artifact."id" = NEW."artifactId"
     AND artifact."companyId" = NEW."companyId"
     AND artifact."sessionId" = NEW."sessionId"
     AND artifact."turnId" = NEW."turnId"
     AND artifact."state" = 'delivered'
     AND artifact."contextRevision" = NEW."contextRevision"
     AND artifact."contextDigest" = NEW."contextDigest"
     AND artifact."storageExpiresAt" > clock_timestamp()
     AND artifact."objectPurgedAt" IS NULL
   FOR SHARE;
  IF owner_epoch IS NULL THEN
    RAISE EXCEPTION 'control grant requires live delivered audio' USING ERRCODE = '55000';
  END IF;
  PERFORM public.assert_realtime_context_fence_v2(
    NEW."companyId", NEW."sessionId", NEW."contextRevision", NEW."contextDigest",
    owner_token, owner_epoch
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "00_realtime_control_grants_guard_v2"
BEFORE INSERT OR UPDATE ON "realtime_control_grants"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_control_grant_v2();

CREATE FUNCTION guard_realtime_control_consumption_v2()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  grant_revision INTEGER;
  grant_digest CHAR(64);
  grant_issued_at TIMESTAMPTZ;
  grant_expires_at TIMESTAMPTZ;
  owner_epoch INTEGER;
  owner_token CHAR(64);
BEGIN
  IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
  SELECT control_grant."contextRevision", control_grant."contextDigest",
         control_grant."issuedAt", control_grant."expiresAt",
         artifact."sidebandOwnerEpoch", artifact."sidebandOwnerTokenHash"
    INTO grant_revision, grant_digest, grant_issued_at, grant_expires_at, owner_epoch, owner_token
    FROM public.realtime_control_grants AS control_grant
    JOIN public.realtime_speech_artifacts AS artifact
      ON artifact."id" = control_grant."artifactId"
     AND artifact."companyId" = control_grant."companyId"
     AND artifact."sessionId" = control_grant."sessionId"
     AND artifact."turnId" = control_grant."turnId"
   WHERE control_grant."id" = NEW."grantId"
     AND control_grant."companyId" = NEW."companyId"
     AND control_grant."sessionId" = NEW."sessionId"
     AND control_grant."turnId" = NEW."turnId"
     AND control_grant."expiresAt" > clock_timestamp()
   -- La grant est append-only et le rôle runtime n'a volontairement aucun UPDATE dessus.
   -- Seul l'artefact mutable doit être verrouillé contre purge/cancel pendant la consommation.
   FOR SHARE OF artifact;
  IF grant_revision IS NULL
    OR NEW."consumedAt" < grant_issued_at
    OR NEW."consumedAt" > grant_expires_at
  THEN
    RAISE EXCEPTION 'control consumption is outside grant validity' USING ERRCODE = '55000';
  END IF;
  PERFORM public.assert_realtime_context_fence_v2(
    NEW."companyId", NEW."sessionId", grant_revision, grant_digest,
    owner_token, owner_epoch
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "00_realtime_control_consumptions_guard_v2"
BEFORE INSERT OR UPDATE ON "realtime_control_consumptions"
FOR EACH ROW EXECUTE FUNCTION guard_realtime_control_consumption_v2();

COMMENT ON COLUMN "realtime_session_leases"."sidebandOwnerEpoch" IS
  'Epoch CAS monotone : tout takeover révoque définitivement les publications de l owner précédent.';
COMMENT ON COLUMN "realtime_speech_artifacts"."sidebandOwnerTokenHash" IS
  'Binding immuable au propriétaire sideband exact ; aucune valeur de token brute n est persistée.';

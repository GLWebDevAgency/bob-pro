-- Voice Trace — lecteur V3 additif : rend la cause terminale observable sans casser le lecteur V2.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION public.read_realtime_voice_trace_session_v3(
  access_request_id UUID,
  subject_company_id TEXT,
  subject_user_id UUID,
  subject_session_handle UUID,
  access_reason TEXT,
  access_ticket TEXT,
  include_content BOOLEAN
)
RETURNS TABLE (
  id UUID,
  "traceAttemptId" UUID,
  "sessionHandle" UUID,
  "ownerEpoch" INTEGER,
  "eventOrdinal" INTEGER,
  "eventKind" VARCHAR(40),
  "turnId" UUID,
  "occurredAt" TIMESTAMPTZ,
  "durationMs" INTEGER,
  "contextRevision" INTEGER,
  "contextDigest" CHAR(64),
  "speechDelivery" VARCHAR(40),
  "plannerDisposition" VARCHAR(32),
  "plannerAuthority" VARCHAR(16),
  "plannerIntent" VARCHAR(64),
  "missionKind" VARCHAR(100),
  "runKind" VARCHAR(16),
  "controlKind" VARCHAR(24),
  stage VARCHAR(32),
  outcome VARCHAR(24),
  "failureClass" VARCHAR(64),
  "interruptionReason" VARCHAR(32),
  "sessionCloseReason" VARCHAR(32),
  "eventDigestKeyVersion" INTEGER,
  "encryptionKeyVersion" INTEGER,
  "transcriptCiphertext" TEXT,
  "canonicalReplyCiphertext" TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
SET statement_timeout = '4s'
SET lock_timeout = '1s'
AS $reader_v3$
  WITH previous AS MATERIALIZED (
    SELECT *
      FROM public.read_realtime_voice_trace_session_v2(
             $1, $2, $3, $4, $5, $6, $7
           )
  )
  SELECT previous.id,
         previous."traceAttemptId",
         previous."sessionHandle",
         previous."ownerEpoch",
         previous."eventOrdinal",
         previous."eventKind",
         previous."turnId",
         previous."occurredAt",
         previous."durationMs",
         previous."contextRevision",
         previous."contextDigest",
         previous."speechDelivery",
         previous."plannerDisposition",
         previous."plannerAuthority",
         previous."plannerIntent",
         previous."missionKind",
         previous."runKind",
         previous."controlKind",
         previous.stage,
         previous.outcome,
         previous."failureClass",
         previous."interruptionReason",
         stored."sessionCloseReason",
         previous."eventDigestKeyVersion",
         previous."encryptionKeyVersion",
         previous."transcriptCiphertext",
         previous."canonicalReplyCiphertext"
    FROM previous
    JOIN public.realtime_voice_trace_events AS stored ON stored.id = previous.id
   ORDER BY previous."eventOrdinal";
$reader_v3$;

-- Supabase peut pré-accorder la Data API aux nouveaux objets publics. La migration ferme donc
-- immédiatement la fonction ; le provisioning staging-only accordera ensuite le lecteur exact.
REVOKE ALL ON FUNCTION public.read_realtime_voice_trace_session_v3(
  UUID, TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN
) FROM PUBLIC;

DO $reader_v3_data_api_fence$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION public.read_realtime_voice_trace_session_v3(UUID, TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN) FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$reader_v3_data_api_fence$;

COMMIT;

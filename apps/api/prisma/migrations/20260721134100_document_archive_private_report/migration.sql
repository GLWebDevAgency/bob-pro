-- Rapport détaillé réservé aux opérations DIRECT_URL. L'enveloppe CI reste strictement non-PII,
-- mais un refus métier doit rester diagnosticable après la destruction du filesystem one-shot.
-- Nullable pour respecter expand/contract et préserver d'éventuelles preuves 1339 antérieures.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

ALTER TABLE public.document_archive_audit_evidence
  ADD COLUMN "privateReport" JSONB;

ALTER TABLE public.document_archive_audit_evidence
  ADD CONSTRAINT "document_archive_audit_private_report_shape"
  CHECK (
    "privateReport" IS NULL
    OR coalesce((
      jsonb_typeof("privateReport") = 'object'
      AND "privateReport"->>'schemaVersion' = '1'
      AND "privateReport"->>'releaseSha' = btrim("releaseSha"::text)
      AND "privateReport"->>'storageBucket' = "storageBucket"
      AND "privateReport"->>'inventoryDigest' = btrim("inventoryDigest"::text)
      AND "privateReport"->>'protocolVersion' = "protocolVersion"::text
      AND "privateReport"->>'mode' = mode
      AND ("privateReport"->>'readyForActivation')::boolean = "readyForActivation"
      AND "privateReport"->'counts' = counts
    ), FALSE)
  );

COMMENT ON COLUMN public.document_archive_audit_evidence."privateReport" IS
  'Diagnostic détaillé append-only, potentiellement tenant-identifiant, lisible uniquement via DIRECT_URL.';

COMMIT;

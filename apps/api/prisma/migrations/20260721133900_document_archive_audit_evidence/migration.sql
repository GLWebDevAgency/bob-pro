-- Archive V2 — identité d'instance et preuve durable du scanner historique.
--
-- Cette migration est strictement additive. Le scanner tourne dans un service Railway one-shot et ne
-- persiste ni nom de fichier, ni identifiant tenant/document, ni contenu : uniquement les digests,
-- versions de validateurs, compteurs et codes d'écart nécessaires à l'audit du cutover.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL row_security = off;

ALTER TABLE public.document_archive_protocol_state
  ADD COLUMN "databaseIdentity" UUID NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE public.document_archive_protocol_state
  ADD CONSTRAINT "document_archive_protocol_database_identity_unique"
  UNIQUE ("databaseIdentity");

CREATE OR REPLACE FUNCTION public.enforce_document_archive_protocol_monotonicity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document archive protocol state is append-only'
      USING ERRCODE = '23514', CONSTRAINT = 'document_archive_protocol_monotone';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW."databaseIdentity" IS DISTINCT FROM OLD."databaseIdentity"
     OR NEW."activeVersion" < OLD."activeVersion"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
     OR (OLD."activeVersion" = 2 AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'document archive protocol cannot be downgraded or rewritten'
      USING ERRCODE = '23514', CONSTRAINT = 'document_archive_protocol_monotone';
  END IF;
  IF OLD."activeVersion" = 1
     AND NEW."activeVersion" = 1
     AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'document archive protocol V1 cannot be mutated before activation'
      USING ERRCODE = '23514', CONSTRAINT = 'document_archive_protocol_monotone';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE public.document_archive_audit_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "deploymentId" UUID NOT NULL,
  "releaseSha" CHAR(40) NOT NULL,
  "databaseIdentity" UUID NOT NULL,
  "storageBucket" TEXT NOT NULL,
  "protocolVersion" SMALLINT NOT NULL,
  mode TEXT NOT NULL,
  "inventoryDigest" CHAR(64) NOT NULL,
  "reportSha256" CHAR(64) NOT NULL,
  "validatorEvidenceDigest" CHAR(64) NOT NULL,
  "validatorVersions" JSONB NOT NULL,
  counts JSONB NOT NULL,
  "issueCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "readyForActivation" BOOLEAN NOT NULL,
  "auditedAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT "document_archive_audit_release_sha_canonical"
    CHECK ("releaseSha" ~ '^[0-9a-f]{40}$'),
  CONSTRAINT "document_archive_audit_storage_bucket_canonical"
    CHECK ("storageBucket" ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
  CONSTRAINT "document_archive_audit_protocol_version"
    CHECK ("protocolVersion" IN (1, 2)),
  CONSTRAINT "document_archive_audit_mode"
    CHECK (mode IN ('audit', 'apply-attestations', 'protocol-v2-verified')),
  CONSTRAINT "document_archive_audit_inventory_digest_canonical"
    CHECK ("inventoryDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "document_archive_audit_report_sha_canonical"
    CHECK ("reportSha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "document_archive_audit_validator_digest_canonical"
    CHECK ("validatorEvidenceDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "document_archive_audit_validator_versions_object"
    CHECK (jsonb_typeof("validatorVersions") = 'object'),
  CONSTRAINT "document_archive_audit_validator_versions_exact"
    CHECK (
      "validatorVersions" =
        '{"representationDetector":1,"mustang":"2.24.0","fnfe":"1.4.0.02"}'::jsonb
    ),
  CONSTRAINT "document_archive_audit_counts_object"
    CHECK (jsonb_typeof(counts) = 'object'),
  CONSTRAINT "document_archive_audit_counts_shape"
    CHECK (coalesce((
      jsonb_typeof(counts->'generatedLegalDocuments') = 'number'
      AND jsonb_typeof(counts->'objectsRead') = 'number'
      AND jsonb_typeof(counts->'existingAttestations') = 'number'
      AND jsonb_typeof(counts->'appliedAttestations') = 'number'
      AND jsonb_typeof(counts->'externallyValidatedProfessionalInvoices') = 'number'
      AND jsonb_typeof(counts->'storageOrphans') = 'number'
      AND jsonb_typeof(counts->'missingStoredObjects') = 'number'
      AND jsonb_typeof(counts->'p0Issues') = 'number'
      AND counts->>'generatedLegalDocuments' ~ '^[0-9]+$'
      AND counts->>'objectsRead' ~ '^[0-9]+$'
      AND counts->>'existingAttestations' ~ '^[0-9]+$'
      AND counts->>'appliedAttestations' ~ '^[0-9]+$'
      AND counts->>'externallyValidatedProfessionalInvoices' ~ '^[0-9]+$'
      AND counts->>'storageOrphans' ~ '^[0-9]+$'
      AND counts->>'missingStoredObjects' ~ '^[0-9]+$'
      AND counts->>'p0Issues' ~ '^[0-9]+$'
    ), FALSE)),
  CONSTRAINT "document_archive_audit_ready_shape"
    CHECK (
      NOT "readyForActivation"
      OR (
        counts->>'p0Issues' = '0'
        AND cardinality("issueCodes") = 0
      )
    ),
  CONSTRAINT "document_archive_audit_mode_protocol_shape"
    CHECK (mode <> 'protocol-v2-verified' OR "protocolVersion" = 2),
  CONSTRAINT "document_archive_audit_database_identity_fk"
    FOREIGN KEY ("databaseIdentity")
    REFERENCES public.document_archive_protocol_state("databaseIdentity")
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE UNIQUE INDEX document_archive_audit_evidence_deployment_key
  ON public.document_archive_audit_evidence("deploymentId");
CREATE UNIQUE INDEX document_archive_audit_evidence_exact_replay_key
  ON public.document_archive_audit_evidence(
    "releaseSha", "inventoryDigest", "reportSha256"
  );
CREATE INDEX document_archive_audit_evidence_release_ready_idx
  ON public.document_archive_audit_evidence("releaseSha", "readyForActivation", "auditedAt");

CREATE FUNCTION public.enforce_document_archive_audit_evidence_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'document archive audit evidence is append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'document_archive_audit_evidence_immutable';
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_document_archive_audit_evidence_immutable() FROM PUBLIC;

CREATE TRIGGER document_archive_audit_evidence_immutable
BEFORE UPDATE OR DELETE ON public.document_archive_audit_evidence
FOR EACH ROW EXECUTE FUNCTION public.enforce_document_archive_audit_evidence_immutable();

-- Cette table est globale (aucun companyId) et peut désormais porter un rapport détaillé
-- tenant-identifiant. Elle ne doit donc jamais être exposée par la Data API Supabase : aucune
-- policy n'est créée et FORCE RLS maintient le refus même pour le propriétaire de table. Le
-- scanner/activateur utilise exclusivement une autorité DIRECT_URL BYPASSRLS certifiée au boot.
ALTER TABLE public.document_archive_audit_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_archive_audit_evidence FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.document_archive_audit_evidence FROM PUBLIC;

-- Les projets Supabase peuvent avoir des default privileges historiques sur ces rôles. Les
-- révocations sont conditionnelles pour conserver la portabilité PostgreSQL hors Supabase.
DO $$
DECLARE
  exposed_role TEXT;
BEGIN
  FOREACH exposed_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role']::TEXT[] LOOP
    IF pg_catalog.to_regrole(exposed_role) IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.document_archive_audit_evidence FROM %I',
        exposed_role
      );
    END IF;
  END LOOP;
END;
$$;

COMMENT ON TABLE public.document_archive_audit_evidence IS
  'Preuve append-only privée du scan byte-derived exécuté par le service Railway one-shot; DIRECT_URL BYPASSRLS uniquement.';

COMMIT;

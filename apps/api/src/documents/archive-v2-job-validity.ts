/** Trois cadences cron laissent un job frais, un retry futur ou une lease active hors P0. */
export const DOCUMENT_ARCHIVE_JOB_OVERDUE_GRACE_MINUTES = 15;
/** Plafonds imposés par les capacités SQL claim/fail, jamais par convention applicative. */
export const DOCUMENT_ARCHIVE_JOB_MAX_LEASE_MINUTES = 30;
export const DOCUMENT_ARCHIVE_JOB_MAX_RETRY_MINUTES = 24 * 60;

/**
 * Prédicat SQL canonique de l'audit relationnel Archive V2.
 *
 * L'alias `job` est volontairement imposé : le runtime de l'auditeur et le certificat PostgreSQL
 * exécutent exactement le même prédicat, sans copie susceptible de dériver.
 */
export const DOCUMENT_ARCHIVE_INVALID_JOB_PREDICATE_SQL = String.raw`
  NOT coalesce(
    public.document_archive_job_scope_v2_is_valid(
      job."companyId", job."invoiceId", job.reason
    ),
    FALSE
  )
  OR CASE
    WHEN job.status <> 'done'::public."DocumentArchiveJobStatus" THEN
      job."integrityProof" IS NOT NULL
      OR job."integrityProofSha256" IS NOT NULL
      OR job."completedAt" IS NOT NULL
      OR EXISTS (
        SELECT 1
          FROM public.document_archive_job_artifacts AS premature_artifact
         WHERE premature_artifact."jobId" = job.id
           AND premature_artifact."companyId" = job."companyId"
      )
      OR (
        job.status = 'pending'::public."DocumentArchiveJobStatus"
        AND (
          job."leaseToken" IS NOT NULL
          OR job."nextAttemptAt" > statement_timestamp()
        )
      )
      OR (
        job.status = 'failed'::public."DocumentArchiveJobStatus"
        AND job."leaseToken" IS NOT NULL
        AND (
          btrim(job."leaseToken") = ''
          OR job."nextAttemptAt" > statement_timestamp()
            + make_interval(mins => ${DOCUMENT_ARCHIVE_JOB_MAX_LEASE_MINUTES})
        )
      )
      OR (
        job.status = 'failed'::public."DocumentArchiveJobStatus"
        AND job."leaseToken" IS NULL
        AND job."nextAttemptAt" > statement_timestamp()
          + make_interval(mins => ${DOCUMENT_ARCHIVE_JOB_MAX_RETRY_MINUTES})
      )
      OR job."nextAttemptAt" <= statement_timestamp()
        - make_interval(mins => ${DOCUMENT_ARCHIVE_JOB_OVERDUE_GRACE_MINUTES})
    ELSE
      job."leaseToken" IS NOT NULL
      OR job."completedAt" IS NULL
      OR job."integrityProof" IS NULL
      OR job."integrityProofSha256" IS NULL
      OR NOT coalesce(
        public.document_archive_integrity_proof_for_reason_v2_is_valid(
          job."companyId", job."invoiceId", job.reason, job."integrityProof"
        ),
        FALSE
      )
      OR public.document_archive_integrity_proof_v1_sha256(job."integrityProof")
        IS DISTINCT FROM job."integrityProofSha256"
      OR NOT coalesce(
        public.document_archive_job_pdf_attestation_v2_is_valid(
          job."companyId", job."invoiceId", job.reason, job."integrityProof"
        ),
        FALSE
      )
      OR CASE
        WHEN coalesce(
          public.document_archive_integrity_proof_for_reason_v2_is_valid(
            job."companyId", job."invoiceId", job.reason, job."integrityProof"
          ),
          FALSE
        ) THEN
          (
            SELECT count(*)::integer
              FROM public.document_archive_job_artifacts AS projected_artifact
             WHERE projected_artifact."jobId" = job.id
               AND projected_artifact."companyId" = job."companyId"
          ) <> jsonb_array_length(job."integrityProof"->'artifacts')
          OR EXISTS (
            SELECT 1
              FROM public.document_archive_job_artifacts AS projected_artifact
             WHERE projected_artifact."jobId" = job.id
               AND projected_artifact."companyId" = job."companyId"
               AND NOT EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements(job."integrityProof"->'artifacts')
                     AS item(proof_artifact)
                  WHERE item.proof_artifact->>'kind' = projected_artifact.kind
                    AND item.proof_artifact->>'contentProfile'
                      = projected_artifact."contentProfile"
                    AND item.proof_artifact->>'documentId' = projected_artifact."documentId"
                    AND item.proof_artifact->>'versionId' = projected_artifact."versionId"
                    AND (item.proof_artifact->>'version')::integer
                      = projected_artifact."versionNumber"
                    AND item.proof_artifact->>'storageKey' = projected_artifact."storageKey"
                    AND item.proof_artifact->>'mimeType' = projected_artifact."mimeType"
                    AND (item.proof_artifact->>'byteSize')::integer
                      = projected_artifact."byteSize"
                    AND item.proof_artifact->>'sha256'
                      = btrim(projected_artifact.sha256::text)
               )
          )
        ELSE TRUE
      END
  END
`;

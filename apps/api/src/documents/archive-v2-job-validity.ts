/**
 * Prédicat SQL canonique de l'audit relationnel Archive V2.
 *
 * L'alias `job` est volontairement imposé : le runtime de l'auditeur et le certificat PostgreSQL
 * exécutent exactement le même prédicat, sans copie susceptible de dériver.
 */
export const DOCUMENT_ARCHIVE_INVALID_JOB_PREDICATE_SQL = String.raw`
  job.status <> 'done'::public."DocumentArchiveJobStatus"
  OR job."completedAt" IS NULL
  OR job."integrityProof" IS NULL
  OR job."integrityProofSha256" IS NULL
  OR NOT coalesce(
    public.document_archive_job_scope_v2_is_valid(
      job."companyId", job."invoiceId", job.reason
    ),
    FALSE
  )
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
`;

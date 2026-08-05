import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { assertArchiveQuarantineCompletionBoundary } from '../../document-archive-quarantine.runtime';
import type { ArchiveQuarantineManifest } from '../../documents/archive-quarantine';

const RUN_CERT = process.env.RUN_POSTGRES_DOCUMENT_ARCHIVE_QUARANTINE_CERT === 'true';
const RELEASE_SHA = 'a'.repeat(40);
const INVENTORY_DIGEST = 'b'.repeat(64);
const REPORT_SHA256 = 'c'.repeat(64);
const SNAPSHOT_DIGEST = 'd'.repeat(64);
const VALIDATOR_DIGEST = 'e'.repeat(64);
const SENTINEL = new Error('DOCUMENT_ARCHIVE_QUARANTINE_CERT_ROLLBACK');

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function quotedRole(value: string): string {
  if (!/^[a-z_][a-z0-9_$-]{0,62}$/u.test(value)) {
    throw new Error('Quarantine certificate owner role is not canonical.');
  }
  return `"${value.replaceAll('"', '""')}"`;
}

async function expectConstraint(
  tx: Prisma.TransactionClient,
  expectedMessage: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  const savepoint = `quarantine_cert_${sha256(expectedMessage).slice(0, 12)}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
  expect(String(error)).toContain(expectedMessage);
}

const describePostgres = RUN_CERT ? describe : describe.skip;

describePostgres('document archive quarantine — certificat PostgreSQL réel', () => {
  it('prouve writer N-1, fences cinq références, ordre, atomicité DELETE et ACL fermées', async () => {
    const directUrl = process.env.DIRECT_URL;
    if (!directUrl) throw new Error('DIRECT_URL is required for quarantine certification.');
    const client = new PrismaClient({ datasourceUrl: directUrl, errorFormat: 'minimal' });
    await client.$connect();
    try {
      const roles = await client.$queryRaw<Array<{
        currentUser: string;
        sessionUser: string;
        superuser: boolean;
      }>>`
        SELECT current_user::TEXT AS "currentUser", session_user::TEXT AS "sessionUser",
               role.rolsuper AS superuser
          FROM pg_catalog.pg_roles AS role
         WHERE role.rolname = current_user
      `;
      expect(roles).toHaveLength(1);
      expect(roles[0]?.superuser).toBe(false);

      await expect(client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '90s'");

        const owners = await tx.$queryRaw<Array<{
          owner: string;
          canSet: boolean;
        }>>`
          SELECT pg_catalog.pg_get_userbyid(relation.relowner) AS owner,
                 pg_catalog.pg_has_role(session_user, relation.relowner, 'SET') AS "canSet"
            FROM pg_catalog.pg_class AS relation
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname = 'public'
             AND relation.relname = 'document_archive_quarantine_operations'
             AND relation.relkind = 'r'
        `;
        expect(owners).toHaveLength(1);
        expect(owners[0]?.canSet).toBe(true);
        const owner = quotedRole(owners[0]!.owner);

        const suffix = randomUUID();
        const companyId = `quarantine-cert-${suffix}`;
        const sourceBucket = `q-src-${suffix}`;
        const destinationBucket = `q-dst-${suffix}`;
        const ordinaryKey = `ordinary/${suffix}.pdf`;
        const clock = await tx.$queryRaw<Array<{ createdAt: string; updatedAt: string }>>`
          SELECT pg_catalog.to_char(
                   clock_timestamp() - interval '2 minutes',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                 ) AS "createdAt",
                 pg_catalog.to_char(
                   clock_timestamp() - interval '1 minute',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                 ) AS "updatedAt"
        `;
        const sourceCreatedAt = clock[0]!.createdAt;
        const sourceUpdatedAt = clock[0]!.updatedAt;
        const sourceMetadata = { cacheControl: 'no-store', mimetype: 'application/pdf' };
        const sourceUserMetadata = {};
        const metadataDigest = sha256(JSON.stringify({
          metadata: sourceMetadata,
          userMetadata: sourceUserMetadata,
        }));
        const entries = Array.from({ length: 5 }, (_, index) => {
          const byteSha256 = sha256(`quarantine-cert-bytes-${index}`);
          const sourceKey = `companies/${companyId}/documents/cert-${index}/v1/${byteSha256}.pdf`;
          const sourceKeySha256 = sha256(sourceKey);
          return {
            ordinal: index + 1,
            sourceKey,
            sourceKeySha256,
            destinationKey: `v2/${INVENTORY_DIGEST}/${sourceKeySha256}/${byteSha256}.pdf`,
            sha256: byteSha256,
            byteSize: 100 + index,
            contentType: 'application/pdf',
            sourceObjectId: randomUUID(),
            sourceObjectVersion: `version-${index + 1}`,
            sourceCreatedAt,
            sourceUpdatedAt,
            sourceStorageMetadataDigest: metadataDigest,
            sourceMetadata,
            sourceUserMetadata,
          };
        });
        const manifestDigest = sha256(`manifest-${suffix}`);
        const auditDeploymentId = randomUUID();
        const counts = {
          generatedLegalDocuments: 0,
          objectsRead: 5,
          existingAttestations: 0,
          appliedAttestations: 0,
          externallyValidatedProfessionalInvoices: 0,
          storageOrphans: 5,
          missingStoredObjects: 0,
          p0Issues: 6,
        };

        // Writer N-1 exact : un objet non concerné reste créable avant le plan final.
        await tx.$executeRawUnsafe('SET LOCAL ROLE NONE');
        await tx.$executeRawUnsafe(
          `INSERT INTO public.companies (
             id, name, "legalForm", siren, siret, trade, "vatRegime",
             "addrLine1", "addrZip", "addrCity"
           ) VALUES (
             $1, 'Archive quarantine certificate', 'EI', '990000091', '99000009100019',
             'certification', 'reel_normal', '1 rue du Test', '75001', 'Paris'
           )`,
          companyId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
           VALUES ($1, $1, false, 1048576, ARRAY['application/pdf','application/json']),
                  ($2, $2, false, 1048576, ARRAY['application/pdf','application/json'])`,
          sourceBucket,
          destinationBucket,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO storage.objects
             (id, bucket_id, name, version, metadata, user_metadata, created_at, updated_at)
           VALUES ($1::uuid, $2, $3, 'ordinary-v1', '{}'::jsonb, '{}'::jsonb,
                   $4::timestamptz, $4::timestamptz)`,
          randomUUID(),
          sourceBucket,
          ordinaryKey,
          sourceCreatedAt,
        );
        for (const entry of entries) {
          await tx.$executeRawUnsafe(
            `INSERT INTO storage.objects
               (id, bucket_id, name, version, metadata, user_metadata, created_at, updated_at)
             VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb,
                     $7::timestamptz, $8::timestamptz)`,
            entry.sourceObjectId,
            sourceBucket,
            entry.sourceKey,
            entry.sourceObjectVersion,
            JSON.stringify(entry.sourceMetadata),
            JSON.stringify(entry.sourceUserMetadata),
            entry.sourceCreatedAt,
            entry.sourceUpdatedAt,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO storage.objects
               (id, bucket_id, name, version, metadata, user_metadata, created_at, updated_at)
             VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::jsonb,
                     $7::timestamptz, $8::timestamptz)`,
            randomUUID(),
            destinationBucket,
            entry.destinationKey,
            'copy-v1',
            JSON.stringify(entry.sourceMetadata),
            JSON.stringify(entry.sourceUserMetadata),
            entry.sourceCreatedAt,
            entry.sourceUpdatedAt,
          );
        }

        const protocol = await tx.$queryRaw<Array<{ databaseIdentity: string }>>`
          SELECT "databaseIdentity"::TEXT AS "databaseIdentity"
            FROM public.document_archive_protocol_state WHERE id = 1
        `;
        expect(protocol).toHaveLength(1);
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${owner}`);
        const privateReport = {
          schemaVersion: 1,
          releaseSha: RELEASE_SHA,
          storageBucket: sourceBucket,
          inventoryDigest: INVENTORY_DIGEST,
          protocolVersion: 2,
          mode: 'protocol-v2-verified',
          readyForActivation: false,
          counts,
          issues: [],
        };
        await tx.$executeRawUnsafe(
          `INSERT INTO public.document_archive_audit_evidence (
             "deploymentId", "releaseSha", "databaseIdentity", "storageBucket",
             "protocolVersion", mode, "inventoryDigest", "reportSha256",
             "validatorEvidenceDigest", "validatorVersions", counts, "issueCodes",
             "privateReport", "readyForActivation", "auditedAt"
           ) VALUES (
             $1::uuid, $2, $3::uuid, $4, 2, 'protocol-v2-verified', $5, $6, $7,
             '{"fnfe":"1.4.0.02","mustang":"2.24.0","representationDetector":1}'::jsonb,
             $8::jsonb, ARRAY['ARCHIVE_PROTOCOL_V2_STORAGE_ORPHAN_PRESENT',
               'STORAGE_OBJECT_WITHOUT_SQL_REFERENCE'], $9::jsonb, false,
             $10::timestamptz
           )`,
          auditDeploymentId,
          RELEASE_SHA,
          protocol[0]!.databaseIdentity,
          sourceBucket,
          INVENTORY_DIGEST,
          REPORT_SHA256,
          VALIDATOR_DIGEST,
          JSON.stringify(counts),
          JSON.stringify(privateReport),
          sourceCreatedAt,
        );
        const manifest: ArchiveQuarantineManifest = {
          schemaVersion: 2,
          environment: 'staging',
          releaseSha: RELEASE_SHA,
          databaseFingerprint: sha256(`bob-document-archive-database:${protocol[0]!.databaseIdentity}`),
          databaseSnapshotDigest: SNAPSHOT_DIGEST,
          auditDeploymentId,
          auditReportSha256: REPORT_SHA256,
          sourceAuditInventoryDigest: INVENTORY_DIGEST,
          sourceBucket,
          destinationBucket,
          companyIdSha256: sha256(companyId),
          entries,
          confirmationDigest: manifestDigest,
        };
        const workflowIdentity = {
          issuer: 'https://token.actions.githubusercontent.com',
          audience: 'bob-document-archive-quarantine-staging',
          repository: 'GLWebDevAgency/bob-pro',
          ref: 'refs/heads/main',
          sha: RELEASE_SHA,
          environment: 'staging',
          workflowRef:
            'GLWebDevAgency/bob-pro/.github/workflows/document-archive-quarantine-staging.yml@refs/heads/main',
          workflowSha: RELEASE_SHA,
          eventName: 'workflow_dispatch',
          subject: 'repo:GLWebDevAgency/bob-pro:environment:staging',
          repositoryId: '1286748365',
          repositoryOwnerId: '84627817',
          actor: 'GLWebDevAgency',
          actorId: '84627817',
          runId: '123456789',
          runAttempt: 1,
          tokenSha256: '1'.repeat(64),
        };
        const operationRows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO public.document_archive_quarantine_operations (
             environment, "companyId", "companyIdSha256", "sourceBucket", "destinationBucket",
             "manifestDigest", "databaseIdentity", "databaseSnapshotDigest", "auditDeploymentId",
             "releaseSha", "auditInventoryDigest", "auditReportSha256", "entryCount",
             "copyReceiptKey", "deletedReceiptKey", "finalReceiptKey", "privateManifest"
           ) VALUES (
             'staging', $1, $2, $3, $4, $5, $6::uuid, $7, $8::uuid, $9, $10, $11, 5,
             $12, $13, $14, $15::jsonb
           ) RETURNING id::text AS id`,
          companyId,
          sha256(companyId),
          sourceBucket,
          destinationBucket,
          manifestDigest,
          protocol[0]!.databaseIdentity,
          SNAPSHOT_DIGEST,
          auditDeploymentId,
          RELEASE_SHA,
          INVENTORY_DIGEST,
          REPORT_SHA256,
          `receipts/${manifestDigest}/copied-verified.json`,
          `receipts/${manifestDigest}/deleted-verified.json`,
          `receipts/${manifestDigest}/completed.json`,
          JSON.stringify(manifest),
        );
        const operationId = operationRows[0]!.id;
        for (const entry of entries) {
          await tx.$executeRawUnsafe(
            `INSERT INTO public.document_archive_quarantine_entries (
               "operationId", ordinal, "companyId", "sourceBucket", "destinationBucket",
               "manifestDigest", "sourceKey", "sourceKeySha256", "destinationKey",
               "sourceObjectId", "sourceObjectVersion", "sourceCreatedAt", "sourceUpdatedAt",
               "sourceMetadata", "sourceUserMetadata", "sourceStorageMetadataDigest",
               "byteSha256", "byteSize", "contentType"
             ) VALUES (
               $1::uuid, $2::smallint, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11,
               $12::timestamptz, $13::timestamptz, $14::jsonb, $15::jsonb, $16, $17,
               $18::bigint, $19
             )`,
            operationId,
            entry.ordinal,
            companyId,
            sourceBucket,
            destinationBucket,
            manifestDigest,
            entry.sourceKey,
            entry.sourceKeySha256,
            entry.destinationKey,
            entry.sourceObjectId,
            entry.sourceObjectVersion,
            entry.sourceCreatedAt,
            entry.sourceUpdatedAt,
            JSON.stringify(entry.sourceMetadata),
            JSON.stringify(entry.sourceUserMetadata),
            entry.sourceStorageMetadataDigest,
            entry.sha256,
            entry.byteSize,
            entry.contentType,
          );
        }
        const planAuthorityEvidence = {
          schemaVersion: 1,
          authorizationRecordedAt: sourceCreatedAt,
          authorizationChannel: 'github-actions:workflow_dispatch',
          manifestDigest,
          tokenSha256: workflowIdentity.tokenSha256,
        };
        await tx.$executeRawUnsafe(
          `INSERT INTO public.document_archive_quarantine_events (
             "operationId", kind, ordinal, evidence, "evidenceSha256", "workflowIdentity"
           ) VALUES (
             $1::uuid, 'plan_authorized', 0, $2::jsonb,
             encode(sha256(convert_to($2::jsonb::text, 'UTF8')), 'hex'), $3::jsonb
           )`,
          operationId,
          JSON.stringify(planAuthorityEvidence),
          JSON.stringify(workflowIdentity),
        );
        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS document_archive_quarantine_plan_complete IMMEDIATE',
        );
        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS document_archive_quarantine_plan_complete DEFERRED',
        );

        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${owner}`);
        for (const triggerName of [
          'document_archive_job_snapshot_required',
          'document_archive_jobs_customer_scope_valid',
          'document_archive_jobs_cutover_spool_v2',
          'document_archive_jobs_proof_immutable',
        ]) {
          await tx.$executeRawUnsafe(
            `ALTER TABLE public.document_archive_jobs DISABLE TRIGGER "${triggerName}"`,
          );
        }
        await tx.$executeRawUnsafe('SET LOCAL ROLE NONE');
        await expectConstraint(tx, 'archive worker leases are closed during exact-key quarantine', () => (
          tx.$executeRawUnsafe(
            `INSERT INTO public.document_archive_jobs
               (id, "companyId", "invoiceId", "nextAttemptAt", "updatedAt", "leaseToken")
             VALUES ($1, $2, $3, now(), now(), $4)`,
            `blocked-job-${suffix}`,
            companyId,
            `blocked-invoice-${suffix}`,
            `blocked-lease-${suffix}`,
          )
        ));
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${owner}`);
        for (const triggerName of [
          'document_archive_job_snapshot_required',
          'document_archive_jobs_customer_scope_valid',
          'document_archive_jobs_cutover_spool_v2',
          'document_archive_jobs_proof_immutable',
        ]) {
          await tx.$executeRawUnsafe(
            `ALTER TABLE public.document_archive_jobs ENABLE TRIGGER "${triggerName}"`,
          );
        }
        await tx.$executeRawUnsafe('SET LOCAL ROLE NONE');
        await expectConstraint(tx, 'archive source bucket is frozen during exact-key quarantine', () => (
          tx.$executeRawUnsafe(
            'UPDATE storage.buckets SET public = true WHERE id = $1',
            sourceBucket,
          )
        ));
        await expectConstraint(tx, 'quarantine destination bucket is immutable and private', () => (
          tx.$executeRawUnsafe(
            'UPDATE storage.buckets SET public = true WHERE id = $1',
            destinationBucket,
          )
        ));

        // Writer N-1 reste accepté sous les triggers finaux lorsqu'aucune entrée ne vise sa clé.
        await tx.$executeRawUnsafe(
          `UPDATE storage.objects SET metadata = '{"writer":"n-1"}'::jsonb
            WHERE bucket_id = $1 AND name = $2`,
          sourceBucket,
          ordinaryKey,
        );
        await tx.$executeRawUnsafe(
          'DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2',
          sourceBucket,
          ordinaryKey,
        );
        await expectConstraint(tx, 'quarantine source objects cannot be inserted or updated', () => (
          tx.$executeRawUnsafe(
            `UPDATE storage.objects SET metadata = '{"tampered":true}'::jsonb
              WHERE bucket_id = $1 AND name = $2`,
            sourceBucket,
            entries[0]!.sourceKey,
          )
        ));

        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${owner}`);
        const targetKey = entries[0]!.sourceKey;
        const referenceCases: Array<readonly [string, () => Promise<unknown>]> = [
          ['documents', () => tx.$executeRawUnsafe(
            `INSERT INTO public.documents
               (id, "companyId", kind, origin, filename, "mimeType", "byteSize", sha256,
                "storageKey", "createdAt", "retentionUntil")
             VALUES ($1, $2, 'other', 'uploaded', 'cert.pdf', 'application/pdf', 1,
                     $3, $4, now(), '2036-08-05')`,
            `doc-${suffix}`, companyId, 'f'.repeat(64), targetKey,
          )],
          ['document_versions', () => tx.$executeRawUnsafe(
            `INSERT INTO public.document_versions
               (id, "documentId", version, "storageKey", sha256, "mimeType", "byteSize",
                "createdAt", reason)
             VALUES ($1, $2, 1, $3, $4, 'application/pdf', 1, now(), 'cert')`,
            `version-${suffix}`, `missing-doc-${suffix}`, targetKey, 'f'.repeat(64),
          )],
          ['chantier_photos', () => tx.$executeRawUnsafe(
            `INSERT INTO public.chantier_photos
               (id, "companyId", "chantierId", filename, "mimeType", "byteSize", "storageKey")
             VALUES ($1, $2, $3, 'cert.png', 'image/png', 1, $4)`,
            `photo-${suffix}`, companyId, `missing-chantier-${suffix}`, targetKey,
          )],
          ['document_archive_artifact_intents', () => tx.$executeRawUnsafe(
            `INSERT INTO public.document_archive_artifact_intents
               ("jobId", "companyId", "snapshotSha256", kind, "contentProfile", "documentId",
                "versionId", "versionNumber", filename, "storageKey", "mimeType", "byteSize", sha256)
             VALUES ($1, $2, $3, 'invoice_pdf', 'plain_pdf', $4, $5, 1,
                     'cert.pdf', $6, 'application/pdf', 1, $7)`,
            `job-${suffix}`, companyId, 'f'.repeat(64), `doc-${suffix}`, `version-${suffix}`,
            targetKey, 'f'.repeat(64),
          )],
          ['document_archive_job_artifacts', () => tx.$executeRawUnsafe(
            `INSERT INTO public.document_archive_job_artifacts
               ("jobId", "companyId", kind, "contentProfile", "documentId", "versionId",
                "versionNumber", "storageKey", "mimeType", "byteSize", sha256)
             VALUES ($1, $2, 'invoice_pdf', 'plain_pdf', $3, $4, 1, $5,
                     'application/pdf', 1, $6)`,
            `job-${suffix}`, companyId, `doc-${suffix}`, `version-${suffix}`, targetKey,
            'f'.repeat(64),
          )],
        ];
        for (const [, insertReference] of referenceCases) {
          await expectConstraint(
            tx,
            'quarantined storage source cannot receive a SQL reference',
            insertReference,
          );
        }

        const insertEvent = async (
          kind: string,
          ordinal: number,
          object: {
            id: string;
            version: string | null;
            createdAt: string;
            updatedAt: string;
            metadata: unknown;
            userMetadata: unknown;
            byteSha256: string;
            byteSize: number;
            contentType: string;
          } | null,
          evidence: Record<string, unknown>,
          workflowIdentity: Record<string, unknown> | null = null,
        ): Promise<void> => {
          await tx.$executeRawUnsafe(
            `INSERT INTO public.document_archive_quarantine_events (
               "operationId", kind, ordinal, "objectId", "objectVersion", "objectCreatedAt",
               "objectUpdatedAt", "objectMetadata", "objectUserMetadata", "byteSha256",
               "byteSize", "contentType", evidence, "evidenceSha256", "workflowIdentity"
             ) VALUES (
               $1::uuid, $2, $3::smallint, $4::uuid, $5, $6::timestamptz, $7::timestamptz,
               $8::jsonb, $9::jsonb, $10, $11::bigint, $12, $13::jsonb,
               encode(sha256(convert_to($13::jsonb::text, 'UTF8')), 'hex'), $14::jsonb
             )`,
            operationId,
            kind,
            ordinal,
            object?.id ?? null,
            object?.version ?? null,
            object?.createdAt ?? null,
            object?.updatedAt ?? null,
            object === null ? null : JSON.stringify(object.metadata),
            object === null ? null : JSON.stringify(object.userMetadata),
            object?.byteSha256 ?? null,
            object?.byteSize ?? null,
            object?.contentType ?? null,
            JSON.stringify(evidence),
            workflowIdentity === null ? null : JSON.stringify(workflowIdentity),
          );
        };
        await expectConstraint(
          tx,
          'apply authority must match the durable plan and carry a distinct OIDC proof',
          () => insertEvent('authorized', 0, null, {
            schemaVersion: 1,
            authorizationRecordedAt: sourceCreatedAt,
            authorizationChannel: 'github-actions:workflow_dispatch',
            manifestDigest,
            tokenSha256: workflowIdentity.tokenSha256,
          }, workflowIdentity),
        );
        const applyWorkflowIdentity = {
          ...workflowIdentity,
          runId: '123456790',
          tokenSha256: '2'.repeat(64),
        };
        await insertEvent('authorized', 0, null, {
          schemaVersion: 1,
          authorizationRecordedAt: sourceCreatedAt,
          authorizationChannel: 'github-actions:workflow_dispatch',
          manifestDigest,
          tokenSha256: applyWorkflowIdentity.tokenSha256,
        }, applyWorkflowIdentity);
        for (const entry of entries) {
          const destinationRows = await tx.$queryRawUnsafe<Array<{
            id: string;
            version: string | null;
            createdAt: string;
            updatedAt: string;
            metadata: unknown;
            userMetadata: unknown;
          }>>(
            `SELECT id::text AS id, version,
                    pg_catalog.to_char(created_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
                    pg_catalog.to_char(updated_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
                    coalesce(metadata, 'null'::jsonb) AS metadata,
                    coalesce(user_metadata, 'null'::jsonb) AS "userMetadata"
               FROM storage.objects WHERE bucket_id = $1 AND name = $2`,
            destinationBucket,
            entry.destinationKey,
          );
          const destination = destinationRows[0]!;
          await insertEvent('destination_verified', entry.ordinal, {
            id: destination.id,
            version: destination.version,
            createdAt: destination.createdAt,
            updatedAt: destination.updatedAt,
            metadata: destination.metadata,
            userMetadata: destination.userMetadata,
            byteSha256: entry.sha256,
            byteSize: entry.byteSize,
            contentType: 'application/pdf',
          }, { schemaVersion: 1, manifestDigest, ordinal: entry.ordinal });
        }
        const copyReceiptKey = `receipts/${manifestDigest}/copied-verified.json`;
        const copyReceiptId = randomUUID();
        await tx.$executeRawUnsafe('SET LOCAL ROLE NONE');
        await tx.$executeRawUnsafe(
          `INSERT INTO storage.objects
             (id, bucket_id, name, version, metadata, user_metadata, created_at, updated_at)
           VALUES ($1::uuid, $2, $3, 'receipt-v1', '{}'::jsonb, '{}'::jsonb,
                   $4::timestamptz, $4::timestamptz)`,
          copyReceiptId,
          destinationBucket,
          copyReceiptKey,
          sourceCreatedAt,
        );
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${owner}`);
        await insertEvent('copied_verified', 0, {
          id: copyReceiptId,
          version: 'receipt-v1',
          createdAt: sourceCreatedAt,
          updatedAt: sourceCreatedAt,
          metadata: {},
          userMetadata: {},
          byteSha256: '2'.repeat(64),
          byteSize: 42,
          contentType: 'application/json',
        }, { schemaVersion: 1, manifestDigest, storedBytesSha256: '2'.repeat(64) });

        await tx.$executeRawUnsafe('SET LOCAL ROLE NONE');
        // Simule une désactivation intervenue APRÈS le pré-vol applicatif : le trigger DELETE
        // doit recertifier les huit fences dans sa propre transaction et refuser fail-closed.
        await tx.$executeRawUnsafe(
          'SELECT storage.bob_ci_set_quarantine_bucket_fence(false)',
        );
        await expectConstraint(tx, 'quarantine database fences are absent or disabled', () => (
          tx.$executeRawUnsafe(
            'DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2',
            sourceBucket,
            entries[0]!.sourceKey,
          )
        ));
        await tx.$executeRawUnsafe(
          'SELECT storage.bob_ci_set_quarantine_bucket_fence(true)',
        );

        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${owner}`);
        await tx.$executeRawUnsafe(
          `ALTER TABLE public.document_archive_jobs
             DISABLE TRIGGER "document_archive_quarantine_worker_lease_fence"`,
        );
        await tx.$executeRawUnsafe('SET LOCAL ROLE NONE');
        await expectConstraint(tx, 'quarantine database fences are absent or disabled', () => (
          tx.$executeRawUnsafe(
            'DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2',
            sourceBucket,
            entries[0]!.sourceKey,
          )
        ));
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${owner}`);
        await tx.$executeRawUnsafe(
          `ALTER TABLE public.document_archive_jobs
             ENABLE TRIGGER "document_archive_quarantine_worker_lease_fence"`,
        );
        await tx.$executeRawUnsafe('SET LOCAL ROLE NONE');

        await tx.$executeRawUnsafe('SAVEPOINT quarantine_delete_qualified_trigger_drift');
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${owner}`);
        await tx.$executeRawUnsafe(
          `DROP TRIGGER "document_archive_quarantine_documents_reference_fence"
             ON public.documents`,
        );
        await tx.$executeRawUnsafe(
          `CREATE TRIGGER document_archive_quarantine_documents_reference_fence
             BEFORE INSERT OR UPDATE OF "storageKey" ON public.documents
             FOR EACH ROW WHEN (false)
             EXECUTE FUNCTION public.prevent_document_archive_quarantine_reference_v1()`,
        );
        await tx.$executeRawUnsafe('SET LOCAL ROLE NONE');
        await expectConstraint(tx, 'quarantine database fences are absent or disabled', () => (
          tx.$executeRawUnsafe(
            'DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2',
            sourceBucket,
            entries[0]!.sourceKey,
          )
        ));
        await tx.$executeRawUnsafe(
          'ROLLBACK TO SAVEPOINT quarantine_delete_qualified_trigger_drift',
        );
        await tx.$executeRawUnsafe(
          'RELEASE SAVEPOINT quarantine_delete_qualified_trigger_drift',
        );

        await expectConstraint(tx, 'quarantine deletes must follow the canonical ordinal prefix', () => (
          tx.$executeRawUnsafe(
            'DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2',
            sourceBucket,
            entries[1]!.sourceKey,
          )
        ));
        await expectConstraint(tx, 'verified quarantine destination objects are immutable', () => (
          tx.$executeRawUnsafe(
            `UPDATE storage.objects SET metadata = '{"tampered":true}'::jsonb
              WHERE bucket_id = $1 AND name = $2`,
            destinationBucket,
            entries[0]!.destinationKey,
          )
        ));

        // Le journal source_deleted et le DELETE sont une seule transaction, y compris au rollback.
        await tx.$executeRawUnsafe('SAVEPOINT quarantine_delete_atomicity');
        await tx.$executeRawUnsafe(
          'DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2',
          sourceBucket,
          entries[0]!.sourceKey,
        );

        for (const entry of entries.slice(1)) {
          await tx.$executeRawUnsafe(
            'DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2',
            sourceBucket,
            entry.sourceKey,
          );
        }
        const deletedReceiptKey = `receipts/${manifestDigest}/deleted-verified.json`;
        const deletedReceiptId = randomUUID();
        await tx.$executeRawUnsafe(
          `INSERT INTO storage.objects
             (id, bucket_id, name, version, metadata, user_metadata, created_at, updated_at)
           VALUES ($1::uuid, $2, $3, 'deleted-receipt-v1', '{}'::jsonb, '{}'::jsonb,
                   clock_timestamp(), clock_timestamp())`,
          deletedReceiptId,
          destinationBucket,
          deletedReceiptKey,
        );
        const deletedReceipt = (await tx.$queryRawUnsafe<Array<{
          createdAt: string;
          updatedAt: string;
        }>>(
          `SELECT pg_catalog.to_char(created_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
                  pg_catalog.to_char(updated_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
             FROM storage.objects WHERE bucket_id = $1 AND name = $2`,
          destinationBucket,
          deletedReceiptKey,
        ))[0]!;
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${owner}`);
        await insertEvent('deleted_verified', 0, {
          id: deletedReceiptId,
          version: 'deleted-receipt-v1',
          createdAt: deletedReceipt.createdAt,
          updatedAt: deletedReceipt.updatedAt,
          metadata: {},
          userMetadata: {},
          byteSha256: '3'.repeat(64),
          byteSize: 43,
          contentType: 'application/json',
        }, { schemaVersion: 1, manifestDigest, storedBytesSha256: '3'.repeat(64) });

        // Un audit antérieur à deleted_verified ne peut pas fermer la saga.
        await expectConstraint(tx, 'final audit evidence must be exact, clean and posterior to deletion', () => (
          tx.$executeRawUnsafe(
            `INSERT INTO public.document_archive_quarantine_events (
               "operationId", kind, ordinal, evidence, "evidenceSha256",
               "finalAuditDeploymentId", "finalAuditReleaseSha", "finalAuditInventoryDigest",
               "finalAuditReportSha256", "finalAuditStorageBucket", "finalAuditDatabaseIdentity"
             ) VALUES (
               $1::uuid, 'final_audit_verified', 0, $2::jsonb,
               encode(sha256(convert_to($2::jsonb::text, 'UTF8')), 'hex'),
               $3::uuid, $4, $5, $6, $7, $8::uuid
             )`,
            operationId,
            JSON.stringify({
              schemaVersion: 1,
              manifestDigest,
              deploymentId: auditDeploymentId,
              inventoryDigest: INVENTORY_DIGEST,
              reportSha256: REPORT_SHA256,
              databaseSnapshotDigest: SNAPSHOT_DIGEST,
              storageOrphans: 0,
              missingStoredObjects: 0,
              p0Issues: 0,
            }),
            auditDeploymentId,
            RELEASE_SHA,
            INVENTORY_DIGEST,
            REPORT_SHA256,
            sourceBucket,
            protocol[0]!.databaseIdentity,
          )
        ));

        const finalAuditDeploymentId = randomUUID();
        const finalInventoryDigest = '6'.repeat(64);
        const finalReportSha256 = '7'.repeat(64);
        const finalSnapshotDigest = '8'.repeat(64);
        const auditedAt = (await tx.$queryRaw<Array<{ now: Date }>>`
          SELECT clock_timestamp() AS now
        `)[0]!.now;
        const finalCounts = {
          generatedLegalDocuments: 0,
          objectsRead: 0,
          existingAttestations: 0,
          appliedAttestations: 0,
          externallyValidatedProfessionalInvoices: 0,
          storageOrphans: 0,
          missingStoredObjects: 0,
          p0Issues: 0,
        };
        const finalPrivateReport = {
          schemaVersion: 1,
          releaseSha: RELEASE_SHA,
          databaseFingerprint: manifest.databaseFingerprint,
          databaseSnapshotDigest: finalSnapshotDigest,
          auditedAt: auditedAt.toISOString(),
          storageBucket: sourceBucket,
          inventoryDigest: finalInventoryDigest,
          protocolVersion: 2,
          mode: 'protocol-v2-verified',
          readyForActivation: true,
          counts: finalCounts,
          issues: [],
        };
        await tx.$executeRawUnsafe(
          `INSERT INTO public.document_archive_audit_evidence (
             "deploymentId", "releaseSha", "databaseIdentity", "storageBucket",
             "protocolVersion", mode, "inventoryDigest", "reportSha256",
             "validatorEvidenceDigest", "validatorVersions", counts, "issueCodes",
             "privateReport", "readyForActivation", "auditedAt"
           ) VALUES (
             $1::uuid, $2, $3::uuid, $4, 2, 'protocol-v2-verified', $5, $6, $7,
             '{"fnfe":"1.4.0.02","mustang":"2.24.0","representationDetector":1}'::jsonb,
             $8::jsonb, ARRAY[]::text[], $9::jsonb, true, $10::timestamptz
           )`,
          finalAuditDeploymentId,
          RELEASE_SHA,
          protocol[0]!.databaseIdentity,
          sourceBucket,
          finalInventoryDigest,
          finalReportSha256,
          VALIDATOR_DIGEST,
          JSON.stringify(finalCounts),
          JSON.stringify(finalPrivateReport),
          auditedAt.toISOString(),
        );
        const finalAuditEvidence = {
          schemaVersion: 1,
          manifestDigest,
          deploymentId: finalAuditDeploymentId,
          inventoryDigest: finalInventoryDigest,
          reportSha256: finalReportSha256,
          databaseSnapshotDigest: finalSnapshotDigest,
          storageOrphans: 0,
          missingStoredObjects: 0,
          p0Issues: 0,
        };
        await tx.$executeRawUnsafe(
          `INSERT INTO public.document_archive_quarantine_events (
             "operationId", kind, ordinal, evidence, "evidenceSha256",
             "finalAuditDeploymentId", "finalAuditReleaseSha", "finalAuditInventoryDigest",
             "finalAuditReportSha256", "finalAuditStorageBucket", "finalAuditDatabaseIdentity"
           ) VALUES (
             $1::uuid, 'final_audit_verified', 0, $2::jsonb,
             encode(sha256(convert_to($2::jsonb::text, 'UTF8')), 'hex'),
             $3::uuid, $4, $5, $6, $7, $8::uuid
           )`,
          operationId,
          JSON.stringify(finalAuditEvidence),
          finalAuditDeploymentId,
          RELEASE_SHA,
          finalInventoryDigest,
          finalReportSha256,
          sourceBucket,
          protocol[0]!.databaseIdentity,
        );

        const assertCompletionBoundary = (): Promise<void> => (
          assertArchiveQuarantineCompletionBoundary(tx, {
            operationId,
            manifest,
            maxObjectBytes: 1_048_576,
          })
        );
        const completionFactProbe = await tx.$queryRawUnsafe<Array<{
          base: number;
          objectId: number;
          version: number;
          createdAt: number;
          updatedAt: number;
          metadata: number;
          userMetadata: number;
          byteSha256: number;
          byteSize: number;
          contentType: number;
        }>>(
          `SELECT
             count(*)::integer AS base,
             count(*) FILTER (WHERE event."objectId" = object.id)::integer AS "objectId",
             count(*) FILTER (WHERE event."objectVersion" IS NOT DISTINCT FROM
               to_jsonb(object)->>'version')::integer AS version,
             count(*) FILTER (WHERE event."objectCreatedAt" = object.created_at)::integer
               AS "createdAt",
             count(*) FILTER (WHERE event."objectUpdatedAt" = object.updated_at)::integer
               AS "updatedAt",
             count(*) FILTER (WHERE event."objectMetadata" =
               coalesce(to_jsonb(object)->'metadata', 'null'::jsonb))::integer AS metadata,
             count(*) FILTER (WHERE event."objectUserMetadata" =
               coalesce(to_jsonb(object)->'user_metadata', 'null'::jsonb))::integer
               AS "userMetadata",
             count(*) FILTER (WHERE event."byteSha256" =
               btrim(entry."byteSha256"::text))::integer AS "byteSha256",
             count(*) FILTER (WHERE event."byteSize" = entry."byteSize")::integer
               AS "byteSize",
             count(*) FILTER (WHERE event."contentType" = entry."contentType")::integer
               AS "contentType"
           FROM public.document_archive_quarantine_entries AS entry
           JOIN public.document_archive_quarantine_events AS event
             ON event."operationId" = entry."operationId"
            AND event.kind = 'destination_verified'
            AND event.ordinal = entry.ordinal
           JOIN storage.objects AS object
             ON object.bucket_id = entry."destinationBucket"
            AND object.name = entry."destinationKey"
          WHERE entry."operationId" = $1::uuid`,
          operationId,
        );
        expect(completionFactProbe).toEqual([{
          base: 5,
          objectId: 5,
          version: 5,
          createdAt: 5,
          updatedAt: 5,
          metadata: 5,
          userMetadata: 5,
          byteSha256: 5,
          byteSize: 5,
          contentType: 5,
        }]);
        await assertCompletionBoundary();

        await tx.$executeRawUnsafe('SAVEPOINT quarantine_completion_destination_drift');
        await tx.$executeRawUnsafe('SET LOCAL ROLE NONE');
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
        await tx.$executeRawUnsafe(
          'DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2',
          destinationBucket,
          entries[0]!.destinationKey,
        );
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
        await expectConstraint(tx, 'ARCHIVE_QUARANTINE_COMPLETION_STATE_CHANGED', () => (
          assertCompletionBoundary()
        ));
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT quarantine_completion_destination_drift');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT quarantine_completion_destination_drift');

        await tx.$executeRawUnsafe('SAVEPOINT quarantine_completion_bucket_drift');
        await tx.$executeRawUnsafe(
          'SELECT storage.bob_ci_set_quarantine_bucket_fence(false)',
        );
        await tx.$executeRawUnsafe(
          'UPDATE storage.buckets SET public = true WHERE id = $1',
          destinationBucket,
        );
        await tx.$executeRawUnsafe(
          'SELECT storage.bob_ci_set_quarantine_bucket_fence(true)',
        );
        await expectConstraint(tx, 'ARCHIVE_QUARANTINE_COMPLETION_STATE_CHANGED', () => (
          assertCompletionBoundary()
        ));
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT quarantine_completion_bucket_drift');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT quarantine_completion_bucket_drift');

        await tx.$executeRawUnsafe('SAVEPOINT quarantine_completion_qualified_trigger_drift');
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${owner}`);
        await tx.$executeRawUnsafe(
          `DROP TRIGGER "document_archive_quarantine_documents_reference_fence"
             ON public.documents`,
        );
        await tx.$executeRawUnsafe(
          `CREATE TRIGGER document_archive_quarantine_documents_reference_fence
             BEFORE INSERT OR UPDATE OF "storageKey" ON public.documents
             FOR EACH ROW WHEN (false)
             EXECUTE FUNCTION public.prevent_document_archive_quarantine_reference_v1()`,
        );
        await tx.$executeRawUnsafe('SET LOCAL ROLE NONE');
        await expectConstraint(tx, 'ARCHIVE_QUARANTINE_COMPLETION_STATE_CHANGED', () => (
          assertCompletionBoundary()
        ));
        await tx.$executeRawUnsafe(
          'ROLLBACK TO SAVEPOINT quarantine_completion_qualified_trigger_drift',
        );
        await tx.$executeRawUnsafe(
          'RELEASE SAVEPOINT quarantine_completion_qualified_trigger_drift',
        );

        await tx.$executeRawUnsafe('SAVEPOINT quarantine_completion_worker_drift');
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${owner}`);
        for (const triggerName of [
          'document_archive_job_snapshot_required',
          'document_archive_jobs_customer_scope_valid',
          'document_archive_jobs_cutover_spool_v2',
          'document_archive_jobs_proof_immutable',
          'document_archive_quarantine_worker_lease_fence',
        ]) {
          await tx.$executeRawUnsafe(
            `ALTER TABLE public.document_archive_jobs DISABLE TRIGGER "${triggerName}"`,
          );
        }
        await tx.$executeRawUnsafe('SET LOCAL ROLE NONE');
        await tx.$executeRawUnsafe(
          `INSERT INTO public.document_archive_jobs
             (id, "companyId", "invoiceId", "nextAttemptAt", "updatedAt", "leaseToken")
           VALUES ($1, $2, $3, now(), now(), $4)`,
          `completion-job-${suffix}`,
          companyId,
          `completion-invoice-${suffix}`,
          `completion-lease-${suffix}`,
        );
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${owner}`);
        for (const triggerName of [
          'document_archive_job_snapshot_required',
          'document_archive_jobs_customer_scope_valid',
          'document_archive_jobs_cutover_spool_v2',
          'document_archive_jobs_proof_immutable',
          'document_archive_quarantine_worker_lease_fence',
        ]) {
          await tx.$executeRawUnsafe(
            `ALTER TABLE public.document_archive_jobs ENABLE TRIGGER "${triggerName}"`,
          );
        }
        await tx.$executeRawUnsafe('SET LOCAL ROLE NONE');
        await expectConstraint(tx, 'ARCHIVE_QUARANTINE_COMPLETION_STATE_CHANGED', () => (
          assertCompletionBoundary()
        ));
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT quarantine_completion_worker_drift');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT quarantine_completion_worker_drift');

        const completedReceiptKey = `receipts/${manifestDigest}/completed.json`;
        const completedReceiptId = randomUUID();
        await tx.$executeRawUnsafe('SET LOCAL ROLE NONE');
        await tx.$executeRawUnsafe(
          `INSERT INTO storage.objects
             (id, bucket_id, name, version, metadata, user_metadata, created_at, updated_at)
           VALUES ($1::uuid, $2, $3, 'completed-receipt-v1', '{}'::jsonb, '{}'::jsonb,
                   clock_timestamp(), clock_timestamp())`,
          completedReceiptId,
          destinationBucket,
          completedReceiptKey,
        );
        const completedReceipt = (await tx.$queryRawUnsafe<Array<{
          createdAt: string;
          updatedAt: string;
        }>>(
          `SELECT pg_catalog.to_char(created_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
                  pg_catalog.to_char(updated_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
             FROM storage.objects WHERE bucket_id = $1 AND name = $2`,
          destinationBucket,
          completedReceiptKey,
        ))[0]!;
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${owner}`);
        await insertEvent('completed', 0, {
          id: completedReceiptId,
          version: 'completed-receipt-v1',
          createdAt: completedReceipt.createdAt,
          updatedAt: completedReceipt.updatedAt,
          metadata: {},
          userMetadata: {},
          byteSha256: '9'.repeat(64),
          byteSize: 44,
          contentType: 'application/json',
        }, { schemaVersion: 1, manifestDigest, storedBytesSha256: '9'.repeat(64) });

        // La source est dégelée uniquement après completed ; la destination reste immuable.
        await tx.$executeRawUnsafe('SET LOCAL ROLE NONE');
        await tx.$executeRawUnsafe(
          'UPDATE storage.buckets SET public = true WHERE id = $1',
          sourceBucket,
        );
        await expectConstraint(tx, 'quarantine destination bucket is immutable and private', () => (
          tx.$executeRawUnsafe(
            'UPDATE storage.buckets SET public = true WHERE id = $1',
            destinationBucket,
          )
        ));
        const committedInside = await tx.$queryRawUnsafe<Array<{ sources: bigint; events: bigint }>>(
          `SELECT
             (SELECT count(*) FROM storage.objects WHERE bucket_id = $1 AND name = $2)::bigint
               AS sources,
             (SELECT count(*) FROM public.document_archive_quarantine_events
               WHERE "operationId" = $3::uuid AND kind = 'source_deleted' AND ordinal = 1)::bigint
               AS events`,
          sourceBucket,
          entries[0]!.sourceKey,
          operationId,
        );
        expect(committedInside[0]).toEqual({ sources: 0n, events: 1n });
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT quarantine_delete_atomicity');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT quarantine_delete_atomicity');
        const rolledBack = await tx.$queryRawUnsafe<Array<{ sources: bigint; events: bigint }>>(
          `SELECT
             (SELECT count(*) FROM storage.objects WHERE bucket_id = $1 AND name = $2)::bigint
               AS sources,
             (SELECT count(*) FROM public.document_archive_quarantine_events
               WHERE "operationId" = $3::uuid AND kind = 'source_deleted' AND ordinal = 1)::bigint
               AS events`,
          sourceBucket,
          entries[0]!.sourceKey,
          operationId,
        );
        expect(rolledBack[0]).toEqual({ sources: 1n, events: 0n });
        await tx.$executeRawUnsafe(
          'DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2',
          sourceBucket,
          entries[0]!.sourceKey,
        );

        const security = await tx.$queryRaw<Array<{
          tableCount: bigint;
          forcedCount: bigint;
          exposedCount: bigint;
          exactFenceCount: bigint;
          namedFenceCount: bigint;
          legalFunction: string;
        }>>`
          WITH expected_fence(
            schema_name, table_name, trigger_name, function_oid, trigger_type, update_column
          ) AS (
            VALUES
              ('storage', 'objects', 'generated_legal_storage_object_immutable',
                'public.prevent_generated_legal_storage_object_mutation()'::regprocedure,
                31, NULL::text),
              ('storage', 'buckets', 'document_archive_quarantine_bucket_fence',
                'public.prevent_document_archive_quarantine_bucket_mutation_v1()'::regprocedure,
                27, NULL::text),
              ('public', 'documents', 'document_archive_quarantine_documents_reference_fence',
                'public.prevent_document_archive_quarantine_reference_v1()'::regprocedure,
                23, 'storageKey'),
              ('public', 'document_versions',
                'document_archive_quarantine_versions_reference_fence',
                'public.prevent_document_archive_quarantine_reference_v1()'::regprocedure,
                23, 'storageKey'),
              ('public', 'chantier_photos', 'document_archive_quarantine_photos_reference_fence',
                'public.prevent_document_archive_quarantine_reference_v1()'::regprocedure,
                23, 'storageKey'),
              ('public', 'document_archive_artifact_intents',
                'document_archive_quarantine_intents_reference_fence',
                'public.prevent_document_archive_quarantine_reference_v1()'::regprocedure,
                23, 'storageKey'),
              ('public', 'document_archive_job_artifacts',
                'document_archive_quarantine_job_artifacts_reference_fence',
                'public.prevent_document_archive_quarantine_reference_v1()'::regprocedure,
                23, 'storageKey'),
              ('public', 'document_archive_jobs',
                'document_archive_quarantine_worker_lease_fence',
                'public.prevent_document_archive_worker_during_quarantine_v1()'::regprocedure,
                23, 'leaseToken')
          )
          SELECT
            (SELECT count(*) FROM pg_catalog.pg_class AS relation
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = 'public'
               AND relation.relname IN ('document_archive_quarantine_operations',
                 'document_archive_quarantine_entries', 'document_archive_quarantine_events'))::bigint
              AS "tableCount",
            (SELECT count(*) FROM pg_catalog.pg_class AS relation
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = 'public'
               AND relation.relname IN ('document_archive_quarantine_operations',
                 'document_archive_quarantine_entries', 'document_archive_quarantine_events')
               AND relation.relrowsecurity AND relation.relforcerowsecurity)::bigint AS "forcedCount",
            (SELECT count(*) FROM pg_catalog.pg_roles AS role
              CROSS JOIN (VALUES ('document_archive_quarantine_operations'),
                ('document_archive_quarantine_entries'), ('document_archive_quarantine_events'))
                AS target(name)
             WHERE role.rolname IN ('anon','authenticated','service_role','bob_app')
               AND pg_catalog.has_table_privilege(role.rolname, 'public.' || target.name,
                 'SELECT,INSERT,UPDATE,DELETE'))::bigint AS "exposedCount",
            (SELECT count(*) FROM expected_fence AS expected
              JOIN pg_catalog.pg_namespace AS namespace
                ON namespace.nspname = expected.schema_name
              JOIN pg_catalog.pg_class AS relation
                ON relation.relnamespace = namespace.oid AND relation.relname = expected.table_name
              LEFT JOIN pg_catalog.pg_attribute AS update_attribute
                ON update_attribute.attrelid = relation.oid
               AND update_attribute.attname = expected.update_column
               AND update_attribute.attnum > 0
               AND NOT update_attribute.attisdropped
              JOIN pg_catalog.pg_trigger AS trigger
                ON trigger.tgrelid = relation.oid AND trigger.tgname = expected.trigger_name
               AND trigger.tgfoid = expected.function_oid
               AND trigger.tgtype::integer = expected.trigger_type
               AND trigger.tgenabled = 'O'
               AND NOT trigger.tgisinternal
               AND trigger.tgqual IS NULL
               AND trigger.tgnargs = 0
               AND trigger.tgconstraint = 0
               AND NOT trigger.tgdeferrable
               AND NOT trigger.tginitdeferred
               AND trigger.tgoldtable IS NULL
               AND trigger.tgnewtable IS NULL
               AND (expected.update_column IS NULL OR update_attribute.attnum IS NOT NULL)
               AND trigger.tgattr::text = CASE
                 WHEN expected.update_column IS NULL THEN ''
                 ELSE update_attribute.attnum::text
               END)::bigint
              AS "exactFenceCount",
            (SELECT count(*) FROM pg_catalog.pg_trigger AS trigger
              JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
              JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
             WHERE (namespace.nspname, relation.relname, trigger.tgname) IN (
               SELECT schema_name, table_name, trigger_name FROM expected_fence
             ) AND NOT trigger.tgisinternal)::bigint AS "namedFenceCount",
            pg_catalog.pg_get_functiondef(
              'public.prevent_generated_legal_storage_object_mutation()'::regprocedure
            ) AS "legalFunction"
        `;
        expect(security).toHaveLength(1);
        expect(security[0]?.tableCount).toBe(3n);
        expect(security[0]?.forcedCount).toBe(3n);
        expect(security[0]?.exposedCount).toBe(0n);
        expect(security[0]?.exactFenceCount).toBe(8n);
        expect(security[0]?.namedFenceCount).toBe(8n);
        expect(security[0]?.legalFunction).toContain("document.origin = 'generated'");
        expect(security[0]?.legalFunction).toContain('document_archive_artifact_intents');

        throw SENTINEL;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 120_000 }))
        .rejects.toBe(SENTINEL);
    } finally {
      await client.$disconnect();
    }
  });
});

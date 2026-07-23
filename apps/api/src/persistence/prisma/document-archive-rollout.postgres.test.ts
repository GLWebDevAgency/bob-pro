import { execFile } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT =
  process.env.RUN_POSTGRES_DOCUMENT_ARCHIVE_ROLLOUT_CERT === 'true';
const SEED_EPHEMERAL_ACTIVATION_EVIDENCE =
  process.env.DOCUMENT_ARCHIVE_TEST_SEED_ACTIVATION_EVIDENCE === 'true';
const execFileAsync = promisify(execFile);

function passesLuhn(value: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function appendLuhnDigit(prefix: string): string {
  for (let digit = 0; digit <= 9; digit += 1) {
    const candidate = `${prefix}${digit}`;
    if (passesLuhn(candidate)) return candidate;
  }
  throw new Error('unable to build a valid Luhn identifier');
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Archive documentaire V2 — certification de la phase expand V1',
  () => {
    const suffix = randomUUID();
    const companyId = `archive-rollout-company-${suffix}`;
    const customerB2bId = `archive-rollout-b2b-${suffix}`;
    const customerB2cId = `archive-rollout-b2c-${suffix}`;
    const customerB2gId = `archive-rollout-b2g-${suffix}`;
    const signedQuoteId = `archive-rollout-quote-${suffix}`;
    const versionDocumentId = `archive-rollout-document-${suffix}`;
    const versionId = `archive-rollout-version-${suffix}`;
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const activationReleaseSha =
      process.env.DOCUMENT_ARCHIVE_V2_ACTIVATION_RELEASE_SHA
      ?? process.env.GITHUB_SHA
      ?? 'c'.repeat(40);
    const activationInventoryDigest = '1'.repeat(64);
    const activationReportSha256 = '2'.repeat(64);
    const activationValidatorEvidenceDigest = '3'.repeat(64);
    const activationStorageBucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'documents';
    const validatorVersions = {
      representationDetector: 1,
      mustang: '2.24.0',
      fnfe: '1.4.0.02',
    } as const;
    const siren = appendLuhnDigit(String(randomInt(10_000_000, 100_000_000)));
    const siret = appendLuhnDigit(
      `${siren}${String(randomInt(0, 10_000)).padStart(4, '0')}`,
    );
    let admin: PrismaClient;
    let runtime: PrismaService;
    let runtimeRole: string;

    async function seedIssuedInvoice(
      id: string,
      customerId: string,
    ): Promise<void> {
      await admin.invoice.create({
        data: {
          id,
          companyId,
          customerId,
          kind: 'invoice',
          status: 'draft',
        },
      });
      await admin.invoice.update({
        where: { id },
        data: {
          status: 'issued',
          number: `CERT-${randomUUID()}`,
          issuedAt: new Date('2026-07-21T10:00:00.000Z'),
          dueAt: new Date('2026-08-20T10:00:00.000Z'),
        },
      });
    }

    async function insertAuditEvidence(input: {
      id?: string;
      deploymentId?: string;
      releaseSha: string;
      databaseIdentity: string;
      storageBucket?: string;
      protocolVersion?: number;
      mode?: string;
      inventoryDigest?: string;
      reportSha256?: string;
      validatorEvidenceDigest?: string;
      validatorVersions?: unknown;
      counts?: unknown;
      privateReport?: unknown;
      readyForActivation?: boolean;
    }, tx?: Prisma.TransactionClient): Promise<void> {
      const database = tx ?? admin;
      await database.$executeRaw`
        INSERT INTO public.document_archive_audit_evidence (
          id,
          "deploymentId",
          "releaseSha",
          "databaseIdentity",
          "storageBucket",
          "protocolVersion",
          mode,
          "inventoryDigest",
          "reportSha256",
          "validatorEvidenceDigest",
          "validatorVersions",
          counts,
          "privateReport",
          "issueCodes",
          "readyForActivation",
          "auditedAt"
        ) VALUES (
          ${input.id ?? randomUUID()}::uuid,
          ${input.deploymentId ?? randomUUID()}::uuid,
          ${input.releaseSha},
          ${input.databaseIdentity}::uuid,
          ${input.storageBucket ?? activationStorageBucket},
          ${input.protocolVersion ?? 1}::smallint,
          ${input.mode ?? 'apply-attestations'},
          ${input.inventoryDigest ?? '4'.repeat(64)},
          ${input.reportSha256 ?? '5'.repeat(64)},
          ${input.validatorEvidenceDigest ?? '6'.repeat(64)},
          ${JSON.stringify(input.validatorVersions ?? validatorVersions)}::jsonb,
          ${JSON.stringify(input.counts ?? {
            generatedLegalDocuments: 0,
            objectsRead: 0,
            existingAttestations: 0,
            appliedAttestations: 0,
            externallyValidatedProfessionalInvoices: 0,
            storageOrphans: 0,
            missingStoredObjects: 0,
            p0Issues: 0,
          })}::jsonb,
          ${input.privateReport === undefined ? null : JSON.stringify(input.privateReport)}::jsonb,
          ARRAY[]::text[],
          ${input.readyForActivation ?? true},
          ${new Date('2026-07-21T12:00:00.000Z')}
        )
      `;
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (runtime) et DIRECT_URL (admin) sont requis.');
      }
      if (!/^[0-9a-f]{40}$/.test(activationReleaseSha)) {
        throw new Error(
          'DOCUMENT_ARCHIVE_V2_ACTIVATION_RELEASE_SHA/GITHUB_SHA doit être un SHA hexadécimal canonique.',
        );
      }
      if (SEED_EPHEMERAL_ACTIVATION_EVIDENCE) {
        const directHostname = new URL(directUrl).hostname;
        if (!['127.0.0.1', '::1', 'localhost'].includes(directHostname)) {
          throw new Error(
            'DOCUMENT_ARCHIVE_TEST_SEED_ACTIVATION_EVIDENCE est réservé à une base éphémère locale.',
          );
        }
      }
      admin = new PrismaClient({ datasourceUrl: directUrl });
      runtime = new PrismaService({ datasourceUrl: runtimeUrl });
      await Promise.all([admin.$connect(), runtime.$connect()]);

      if (SEED_EPHEMERAL_ACTIVATION_EVIDENCE) {
        // `storage.objects` appartient à Supabase et ne doit jamais entrer dans les migrations
        // Bob. Le PostgreSQL éphémère GitHub n'embarque pas Supabase : ce double minimal existe
        // donc uniquement sous opt-in + loopback, et la base entière est détruite après le job.
        await admin.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS storage');
        await admin.$executeRawUnsafe(`
          CREATE TABLE IF NOT EXISTS storage.objects (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            bucket_id TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
            UNIQUE (bucket_id, name)
          )
        `);
      }

      const [runtimeIdentity] = await runtime.$queryRaw<Array<{ role: string }>>`
        SELECT current_user AS role
      `;
      if (!runtimeIdentity?.role) {
        throw new Error('Le rôle PostgreSQL runtime est introuvable.');
      }
      runtimeRole = runtimeIdentity.role;

      await admin.company.create({
        data: {
          id: companyId,
          name: 'Archive rollout certification',
          legalForm: 'EI',
          siren,
          siret,
          trade: 'autre',
          vatRegime: 'reel_normal',
          addrLine1: '1 rue du Rollout',
          addrZip: '75001',
          addrCity: 'Paris',
        },
      });
      await admin.customer.createMany({
        data: [
          {
            id: customerB2bId,
            companyId,
            type: 'b2b',
            name: 'Client professionnel',
            addrLine1: '2 rue du Rollout',
            addrZip: '75002',
            addrCity: 'Paris',
          },
          {
            id: customerB2cId,
            companyId,
            type: 'b2c',
            name: 'Client particulier',
            addrLine1: '3 rue du Rollout',
            addrZip: '75003',
            addrCity: 'Paris',
          },
          {
            id: customerB2gId,
            companyId,
            type: 'b2g',
            name: 'Client public',
            addrLine1: '4 rue du Rollout',
            addrZip: '75004',
            addrCity: 'Paris',
          },
        ],
      });
      await admin.quote.create({
        data: {
          id: signedQuoteId,
          companyId,
          customerId: customerB2bId,
          status: 'signed',
          number: `D-${randomUUID()}`,
          issuedAt: new Date('2026-07-21T00:00:00.000Z'),
          signerName: 'Client professionnel',
          signedAt: new Date('2026-07-21T09:00:00.000Z'),
          signatureCustomerType: 'b2b',
        },
      });
      await admin.storedDocument.create({
        data: {
          id: versionDocumentId,
          companyId,
          kind: 'other',
          origin: 'uploaded',
          status: 'active',
          filename: 'rollout-version.bin',
          mimeType: 'application/octet-stream',
          byteSize: 42,
          sha256: 'a'.repeat(64),
          storageKey: `companies/${companyId}/documents/${versionDocumentId}/v1/${'a'.repeat(64)}`,
          linkedEntityType: 'company',
          linkedEntityId: companyId,
          issuedAt: '2026-07-21',
          createdAt: new Date('2026-07-21T10:00:00.000Z'),
          retentionUntil: '2036-07-21',
          versions: {
            create: {
              id: versionId,
              version: 1,
              storageKey:
                `companies/${companyId}/documents/${versionDocumentId}/v1/${'a'.repeat(64)}`,
              sha256: 'a'.repeat(64),
              mimeType: 'application/octet-stream',
              byteSize: 42,
              createdAt: new Date('2026-07-21T10:00:00.000Z'),
              reason: 'initial-upload',
            },
          },
        },
      });
    }, 30_000);

    afterAll(async () => {
      try {
        if (admin) {
          if (SEED_EPHEMERAL_ACTIVATION_EVIDENCE) {
            await admin.$executeRaw`
              DELETE FROM storage.objects
               WHERE name LIKE ${`companies/${companyId}/%`}
            `.catch(() => undefined);
          }
          await admin.documentArchiveJobArtifact.deleteMany({ where: { companyId } })
            .catch(() => undefined);
          await admin.documentArchiveJob.deleteMany({ where: { companyId } })
            .catch(() => undefined);
          await admin.storedDocument.deleteMany({ where: { companyId } })
            .catch(() => undefined);
          await admin.invoice.deleteMany({ where: { companyId } }).catch(() => undefined);
          await admin.quote.deleteMany({ where: { companyId } }).catch(() => undefined);
          await admin.customer.deleteMany({ where: { companyId } }).catch(() => undefined);
          await admin.company.deleteMany({ where: { id: companyId } }).catch(() => undefined);
        }
      } finally {
        await Promise.allSettled([
          ...(runtime ? [runtime.$disconnect()] : []),
          ...(admin ? [admin.$disconnect()] : []),
        ]);
      }
    });

    it('maintient uniquement les capacités N-1 nécessaires tant que le protocole vaut V1', async () => {
      await expect(
        admin.documentArchiveProtocolState.findUniqueOrThrow({ where: { id: 1 } }),
      ).resolves.toMatchObject({
        activeVersion: 1,
        activatedAt: null,
        activatedByReleaseSha: null,
      });

      const [posture] = await runtime.$queryRaw<Array<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        jobSelect: boolean;
        jobInsert: boolean;
        jobUpdate: boolean;
        jobDelete: boolean;
        artifactInsert: boolean;
        artifactUpdate: boolean;
        artifactDelete: boolean;
        attestationSelect: boolean;
        attestationInsert: boolean;
        attestationUpdate: boolean;
        attestationDelete: boolean;
        attestationTruncate: boolean;
        versionUpdate: boolean;
        quoteDelete: boolean;
        protocolInsert: boolean;
        protocolUpdate: boolean;
        protocolDelete: boolean;
        evidenceSelect: boolean;
        evidenceInsert: boolean;
        evidenceUpdate: boolean;
        evidenceDelete: boolean;
        evidenceTruncate: boolean;
        evidenceReferences: boolean;
        evidenceTrigger: boolean;
        evidenceRowSecurity: boolean;
        evidenceForceRowSecurity: boolean;
        evidencePolicies: number;
        exposedEvidenceRolesWithCapabilities: number;
        exposedProtocolRolesWithMutationCapabilities: number;
        exposedSettlementRolesWithMutationCapabilities: number;
        exposedArchiveFunctionsWithExecute: number;
        enqueueV1: boolean;
        enqueueV2: boolean;
        completeV1: boolean;
        completeV2: boolean;
        claimV1: boolean;
        failV1: boolean;
        attestPdf: boolean;
        attestHistoricalPdf: boolean;
        checkPdfVisibility: boolean;
        useProofShapeValidator: boolean;
        useDeepPdfAttestationValidator: boolean;
        useDeepRepresentationValidator: boolean;
        jobInsertPolicies: number;
        jobUpdatePolicies: number;
        versionUpdatePolicies: number;
        spoolTriggerEnabled: boolean;
        generatedLegalCutoverTriggerEnabled: boolean;
        storageFenceHardened: boolean;
      }>>`
        SELECT role.rolsuper,
               role.rolbypassrls,
               has_table_privilege(current_user, 'document_archive_jobs', 'SELECT') AS "jobSelect",
               has_table_privilege(current_user, 'document_archive_jobs', 'INSERT') AS "jobInsert",
               has_table_privilege(current_user, 'document_archive_jobs', 'UPDATE') AS "jobUpdate",
               has_table_privilege(current_user, 'document_archive_jobs', 'DELETE') AS "jobDelete",
               has_table_privilege(current_user, 'document_archive_job_artifacts', 'INSERT') AS "artifactInsert",
               has_table_privilege(current_user, 'document_archive_job_artifacts', 'UPDATE') AS "artifactUpdate",
               has_table_privilege(current_user, 'document_archive_job_artifacts', 'DELETE') AS "artifactDelete",
               has_table_privilege(current_user, 'document_invoice_pdf_attestations', 'SELECT') AS "attestationSelect",
               has_table_privilege(current_user, 'document_invoice_pdf_attestations', 'INSERT') AS "attestationInsert",
               has_table_privilege(current_user, 'document_invoice_pdf_attestations', 'UPDATE') AS "attestationUpdate",
               has_table_privilege(current_user, 'document_invoice_pdf_attestations', 'DELETE') AS "attestationDelete",
               has_table_privilege(current_user, 'document_invoice_pdf_attestations', 'TRUNCATE') AS "attestationTruncate",
               has_table_privilege(current_user, 'document_versions', 'UPDATE') AS "versionUpdate",
               has_table_privilege(current_user, 'quotes', 'DELETE') AS "quoteDelete",
               has_table_privilege(current_user, 'document_archive_protocol_state', 'INSERT') AS "protocolInsert",
               has_table_privilege(current_user, 'document_archive_protocol_state', 'UPDATE') AS "protocolUpdate",
               has_table_privilege(current_user, 'document_archive_protocol_state', 'DELETE') AS "protocolDelete",
               has_table_privilege(current_user, 'document_archive_audit_evidence', 'SELECT') AS "evidenceSelect",
               has_table_privilege(current_user, 'document_archive_audit_evidence', 'INSERT') AS "evidenceInsert",
               has_table_privilege(current_user, 'document_archive_audit_evidence', 'UPDATE') AS "evidenceUpdate",
               has_table_privilege(current_user, 'document_archive_audit_evidence', 'DELETE') AS "evidenceDelete",
               has_table_privilege(current_user, 'document_archive_audit_evidence', 'TRUNCATE') AS "evidenceTruncate",
               has_table_privilege(current_user, 'document_archive_audit_evidence', 'REFERENCES') AS "evidenceReferences",
               has_table_privilege(current_user, 'document_archive_audit_evidence', 'TRIGGER') AS "evidenceTrigger",
               (SELECT relrowsecurity
                  FROM pg_class
                 WHERE oid = 'public.document_archive_audit_evidence'::regclass)
                 AS "evidenceRowSecurity",
               (SELECT relforcerowsecurity
                  FROM pg_class
                 WHERE oid = 'public.document_archive_audit_evidence'::regclass)
                 AS "evidenceForceRowSecurity",
               (SELECT count(*)::integer
                  FROM pg_policy
                 WHERE polrelid = 'public.document_archive_audit_evidence'::regclass)
                 AS "evidencePolicies",
               (SELECT count(*)::integer
                  FROM pg_roles AS exposed_role
                 WHERE exposed_role.rolname IN ('anon', 'authenticated', 'service_role')
                   AND (
                     has_table_privilege(exposed_role.rolname, 'public.document_archive_audit_evidence', 'SELECT')
                     OR has_table_privilege(exposed_role.rolname, 'public.document_archive_audit_evidence', 'INSERT')
                     OR has_table_privilege(exposed_role.rolname, 'public.document_archive_audit_evidence', 'UPDATE')
                     OR has_table_privilege(exposed_role.rolname, 'public.document_archive_audit_evidence', 'DELETE')
                     OR has_table_privilege(exposed_role.rolname, 'public.document_archive_audit_evidence', 'TRUNCATE')
                     OR has_table_privilege(exposed_role.rolname, 'public.document_archive_audit_evidence', 'REFERENCES')
                     OR has_table_privilege(exposed_role.rolname, 'public.document_archive_audit_evidence', 'TRIGGER')
                   )) AS "exposedEvidenceRolesWithCapabilities",
               (SELECT count(*)::integer
                  FROM pg_roles AS exposed_role
                 WHERE exposed_role.rolname IN ('anon', 'authenticated', 'service_role')
                   AND (
                     has_table_privilege(exposed_role.rolname, 'public.document_archive_protocol_state', 'INSERT')
                     OR has_table_privilege(exposed_role.rolname, 'public.document_archive_protocol_state', 'UPDATE')
                     OR has_table_privilege(exposed_role.rolname, 'public.document_archive_protocol_state', 'DELETE')
                     OR has_table_privilege(exposed_role.rolname, 'public.document_archive_protocol_state', 'TRUNCATE')
                     OR has_table_privilege(exposed_role.rolname, 'public.document_archive_protocol_state', 'REFERENCES')
                     OR has_table_privilege(exposed_role.rolname, 'public.document_archive_protocol_state', 'TRIGGER')
                   )) AS "exposedProtocolRolesWithMutationCapabilities",
               (SELECT count(*)::integer
                  FROM pg_roles AS exposed_role
                 WHERE exposed_role.rolname IN ('anon', 'authenticated', 'service_role')
                   AND (
                     has_table_privilege(exposed_role.rolname, 'public.invoice_settlement_protocol_state', 'INSERT')
                     OR has_table_privilege(exposed_role.rolname, 'public.invoice_settlement_protocol_state', 'UPDATE')
                     OR has_table_privilege(exposed_role.rolname, 'public.invoice_settlement_protocol_state', 'DELETE')
                     OR has_table_privilege(exposed_role.rolname, 'public.invoice_settlement_protocol_state', 'TRUNCATE')
                     OR has_table_privilege(exposed_role.rolname, 'public.invoice_settlement_protocol_state', 'REFERENCES')
                     OR has_table_privilege(exposed_role.rolname, 'public.invoice_settlement_protocol_state', 'TRIGGER')
                   )) AS "exposedSettlementRolesWithMutationCapabilities",
               (SELECT count(*)::integer
                  FROM pg_proc AS function
                  JOIN pg_namespace AS namespace ON namespace.oid = function.pronamespace
                  CROSS JOIN pg_roles AS exposed_role
                 WHERE namespace.nspname = 'public'
                   AND exposed_role.rolname IN ('anon', 'authenticated', 'service_role')
                   AND function.proname = ANY(ARRAY[
                     'attest_generated_invoice_pdf_v1',
                     'attest_historical_generated_invoice_pdf_v1',
                     'capture_invoice_archive_audience_v1',
                     'document_archive_backfill_proved_artifacts_v1',
                     'document_archive_integrity_proof_for_reason_v2_is_valid',
                     'document_archive_integrity_proof_v1_is_valid',
                     'document_archive_integrity_proof_v1_sha256',
                     'document_archive_job_claim_v1',
                     'document_archive_job_complete_v1',
                     'document_archive_job_complete_v2',
                     'document_archive_job_enqueue_v1',
                     'document_archive_job_enqueue_v2',
                     'document_archive_job_fail_v1',
                     'document_archive_job_pdf_attestation_v2_is_valid',
                     'document_archive_job_scope_v2_is_valid',
                     'document_archive_protocol_v2_is_active',
                     'enforce_document_archive_audit_evidence_immutable',
                     'enforce_document_archive_protocol_monotonicity',
                     'generated_invoice_pdf_attestation_visible_v2',
                     'generated_legal_archive_representation_v2_is_valid',
                     'guard_customer_type_after_legal_piece_v1',
                     'guard_document_archive_job_proof_v1',
                     'guard_document_archive_job_scope_v2',
                     'guard_document_invoice_pdf_attestation_immutable_v1',
                     'guard_document_original_facts_v1',
                     'guard_document_version_immutable_v1',
                     'guard_generated_invoice_facturx_scope_v1',
                     'guard_generated_legal_archive_cutover_v2',
                     'guard_generated_legal_archive_representation_v2',
                     'prevent_generated_legal_storage_object_mutation',
                     'spool_document_archive_job_during_v2_cutover'
                   ]::text[])
                   AND has_function_privilege(exposed_role.rolname, function.oid, 'EXECUTE'))
                 AS "exposedArchiveFunctionsWithExecute",
               has_function_privilege(
                 current_user,
                 'public.document_archive_job_enqueue_v1(text,text,text,text)',
                 'EXECUTE'
               ) AS "enqueueV1",
               has_function_privilege(
                 current_user,
                 'public.document_archive_job_enqueue_v2(text,text,text,text)',
                 'EXECUTE'
               ) AS "enqueueV2",
               has_function_privilege(
                 current_user,
                 'public.document_archive_job_complete_v1(text,text,text,jsonb,text)',
                 'EXECUTE'
               ) AS "completeV1",
               has_function_privilege(
                 current_user,
                 'public.document_archive_job_complete_v2(text,text,text,jsonb,text)',
                 'EXECUTE'
               ) AS "completeV2",
               has_function_privilege(
                 current_user,
                 'public.document_archive_job_claim_v1(text,text,timestamp without time zone,bigint,text)',
                 'EXECUTE'
               ) AS "claimV1",
               has_function_privilege(
                 current_user,
                 'public.document_archive_job_fail_v1(text,text,text,bigint,text)',
                 'EXECUTE'
               ) AS "failV1",
               has_function_privilege(
                 current_user,
                 'public.attest_generated_invoice_pdf_v1(text,text,text,text,text,text,smallint)',
                 'EXECUTE'
               ) AS "attestPdf",
               has_function_privilege(
                 current_user,
                 'public.attest_historical_generated_invoice_pdf_v1(text,text,text,text,text,text,smallint)',
                 'EXECUTE'
               ) AS "attestHistoricalPdf",
               has_function_privilege(
                 current_user,
                 'public.generated_invoice_pdf_attestation_visible_v2(text,text)',
                 'EXECUTE'
               ) AS "checkPdfVisibility",
               has_function_privilege(
                 current_user,
                 'public.document_archive_integrity_proof_for_reason_v2_is_valid(text,text,text,jsonb)',
                 'EXECUTE'
               ) AS "useProofShapeValidator",
               has_function_privilege(
                 current_user,
                 'public.document_archive_job_pdf_attestation_v2_is_valid(text,text,text,jsonb)',
                 'EXECUTE'
               ) AS "useDeepPdfAttestationValidator",
               has_function_privilege(
                 current_user,
                 'public.generated_legal_archive_representation_v2_is_valid(text)',
                 'EXECUTE'
               ) AS "useDeepRepresentationValidator",
               (SELECT count(*)::integer FROM pg_policy
                 WHERE polrelid = 'document_archive_jobs'::regclass
                   AND polcmd = 'a') AS "jobInsertPolicies",
               (SELECT count(*)::integer FROM pg_policy
                 WHERE polrelid = 'document_archive_jobs'::regclass
                   AND polcmd = 'w') AS "jobUpdatePolicies",
               (SELECT count(*)::integer FROM pg_policy
                 WHERE polrelid = 'document_versions'::regclass
                   AND polcmd = 'w') AS "versionUpdatePolicies",
               EXISTS (
                 SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'document_archive_jobs'::regclass
                    AND tgname = 'document_archive_jobs_cutover_spool_v2'
                    AND tgenabled <> 'D'
               ) AS "spoolTriggerEnabled",
               EXISTS (
                 SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'documents'::regclass
                    AND tgname = 'documents_generated_legal_archive_cutover_v2'
                    AND tgenabled <> 'D'
               ) AS "generatedLegalCutoverTriggerEnabled",
               EXISTS (
                 SELECT 1
                   FROM pg_trigger AS trigger
                   JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
                   JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
                   JOIN pg_proc AS function ON function.oid = trigger.tgfoid
                   JOIN pg_roles AS function_owner ON function_owner.oid = function.proowner
                  WHERE namespace.nspname = 'storage'
                    AND relation.relname = 'objects'
                    AND trigger.tgname = 'generated_legal_storage_object_immutable'
                    AND NOT trigger.tgisinternal
                    AND trigger.tgenabled = 'O'
                    AND function.proname = 'prevent_generated_legal_storage_object_mutation'
                    AND function.prosecdef
                    AND cardinality(coalesce(function.proconfig, ARRAY[]::text[])) = 2
                    AND coalesce(function.proconfig, ARRAY[]::text[]) @> ARRAY[
                      'search_path=pg_catalog, public',
                      'row_security=off'
                    ]::text[]
                    AND (function_owner.rolsuper OR function_owner.rolbypassrls)
               ) AS "storageFenceHardened"
          FROM pg_roles AS role
         WHERE role.rolname = current_user
      `;
      expect(posture).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        jobSelect: true,
        jobInsert: true,
        jobUpdate: true,
        jobDelete: false,
        artifactInsert: false,
        artifactUpdate: false,
        artifactDelete: false,
        attestationSelect: true,
        attestationInsert: false,
        attestationUpdate: false,
        attestationDelete: false,
        attestationTruncate: false,
        versionUpdate: true,
        quoteDelete: false,
        protocolInsert: false,
        protocolUpdate: false,
        protocolDelete: false,
        evidenceSelect: false,
        evidenceInsert: false,
        evidenceUpdate: false,
        evidenceDelete: false,
        evidenceTruncate: false,
        evidenceReferences: false,
        evidenceTrigger: false,
        evidenceRowSecurity: true,
        evidenceForceRowSecurity: true,
        evidencePolicies: 0,
        exposedEvidenceRolesWithCapabilities: 0,
        exposedProtocolRolesWithMutationCapabilities: 0,
        exposedSettlementRolesWithMutationCapabilities: 0,
        exposedArchiveFunctionsWithExecute: 0,
        enqueueV1: true,
        enqueueV2: true,
        completeV1: true,
        completeV2: true,
        claimV1: true,
        failV1: true,
        attestPdf: true,
        attestHistoricalPdf: true,
        checkPdfVisibility: true,
        // Le CHECK SQL des écritures N-1 est SECURITY INVOKER pendant l'expand. Les validateurs
        // profonds non tenant-scopés restent, eux, inaccessibles au runtime dès V1.
        useProofShapeValidator: true,
        useDeepPdfAttestationValidator: false,
        useDeepRepresentationValidator: false,
        jobInsertPolicies: 1,
        jobUpdatePolicies: 1,
        versionUpdatePolicies: 1,
        spoolTriggerEnabled: true,
        generatedLegalCutoverTriggerEnabled: true,
        storageFenceHardened: true,
      });
    });

    it('rend le singleton V1 immuable et inaccessible au rôle runtime', async () => {
      const [initialState] = await admin.$queryRaw<Array<{
        activeVersion: number;
        databaseIdentity: string;
      }>>`
        SELECT "activeVersion", "databaseIdentity"::text AS "databaseIdentity"
          FROM public.document_archive_protocol_state
         WHERE id = 1
      `;
      expect(initialState).toEqual({
        activeVersion: 1,
        databaseIdentity: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
      });

      await expect(admin.documentArchiveProtocolState.update({
        where: { id: 1 },
        data: { updatedAt: new Date() },
      })).rejects.toThrow();
      await expect(admin.$executeRaw`
        UPDATE public.document_archive_protocol_state
           SET "databaseIdentity" = ${randomUUID()}::uuid
         WHERE id = 1
      `).rejects.toThrow('document archive protocol cannot be downgraded or rewritten');
      await expect(admin.documentArchiveProtocolState.delete({ where: { id: 1 } }))
        .rejects.toThrow();

      await expect(runtime.withTenant(companyId, (tx) =>
        tx.documentArchiveProtocolState.update({
          where: { id: 1 },
          data: { updatedAt: new Date() },
        }),
      )).rejects.toThrow();
      await expect(
        admin.documentArchiveProtocolState.findUniqueOrThrow({ where: { id: 1 } }),
      ).resolves.toMatchObject({ activeVersion: 1, activatedAt: null });
      const [preservedState] = await admin.$queryRaw<Array<{ databaseIdentity: string }>>`
        SELECT "databaseIdentity"::text AS "databaseIdentity"
          FROM public.document_archive_protocol_state
         WHERE id = 1
      `;
      expect(preservedState?.databaseIdentity).toBe(initialState?.databaseIdentity);
    });

    it('persiste une preuve sans PII, contrainte et append-only, liée à la base et au SHA activé', async () => {
      const [protocol] = await admin.$queryRaw<Array<{ databaseIdentity: string }>>`
        SELECT "databaseIdentity"::text AS "databaseIdentity"
          FROM public.document_archive_protocol_state
         WHERE id = 1
      `;
      if (!protocol?.databaseIdentity) {
        throw new Error('databaseIdentity du protocole absente');
      }

      const suffixHex = suffix.replaceAll('-', '');
      const isolatedReleaseSha = `${suffixHex}${suffixHex.slice(0, 8)}`;
      const absentReleaseSha = `${suffixHex}${suffixHex.slice(8, 16)}`;
      const evidenceId = randomUUID();
      const evidenceDeploymentId = randomUUID();

      const [gateWithoutEvidence] = await admin.$queryRaw<Array<{ accepted: boolean }>>`
        SELECT EXISTS (
          SELECT 1
            FROM public.document_archive_audit_evidence AS evidence
            JOIN public.document_archive_protocol_state AS state
              ON state.id = 1
             AND state."databaseIdentity" = evidence."databaseIdentity"
           WHERE btrim(evidence."releaseSha"::text) = ${absentReleaseSha}
             AND evidence."protocolVersion" = 1
             AND evidence.mode = 'apply-attestations'
             AND evidence."readyForActivation"
             AND coalesce((evidence.counts->>'p0Issues')::integer, -1) = 0
        ) AS accepted
      `;
      expect(gateWithoutEvidence?.accepted).toBe(false);

      await expect(admin.$transaction(async (tx) => {
        await insertAuditEvidence({
          id: evidenceId,
          deploymentId: evidenceDeploymentId,
          releaseSha: isolatedReleaseSha,
          databaseIdentity: protocol.databaseIdentity,
          privateReport: {
            schemaVersion: 1,
            releaseSha: isolatedReleaseSha,
            storageBucket: activationStorageBucket,
            inventoryDigest: '4'.repeat(64),
            protocolVersion: 1,
            mode: 'apply-attestations',
            readyForActivation: true,
            counts: {
              generatedLegalDocuments: 0,
              objectsRead: 0,
              existingAttestations: 0,
              appliedAttestations: 0,
              externallyValidatedProfessionalInvoices: 0,
              storageOrphans: 0,
              missingStoredObjects: 0,
              p0Issues: 0,
            },
            issues: [],
          },
        }, tx);
        await tx.$executeRaw`
          SELECT set_config('app.archive_cert_evidence_id', ${evidenceId}, true)
        `;
        await tx.$executeRawUnsafe(`
          DO $archive_evidence$
          BEGIN
            BEGIN
              UPDATE public.document_archive_audit_evidence
                 SET "readyForActivation" = false
               WHERE id = current_setting('app.archive_cert_evidence_id')::uuid;
              RAISE EXCEPTION 'audit evidence update was accepted';
            EXCEPTION
              WHEN check_violation THEN
                IF position('document archive audit evidence is append-only' IN SQLERRM) = 0 THEN
                  RAISE;
                END IF;
            END;

            BEGIN
              UPDATE public.document_archive_audit_evidence
                 SET "privateReport" = jsonb_set(
                   "privateReport",
                   '{readyForActivation}',
                   'false'::jsonb
                 )
               WHERE id = current_setting('app.archive_cert_evidence_id')::uuid;
              RAISE EXCEPTION 'audit evidence private report update was accepted';
            EXCEPTION
              WHEN check_violation THEN
                IF position('document archive audit evidence is append-only' IN SQLERRM) = 0 THEN
                  RAISE;
                END IF;
            END;

            BEGIN
              DELETE FROM public.document_archive_audit_evidence
               WHERE id = current_setting('app.archive_cert_evidence_id')::uuid;
              RAISE EXCEPTION 'audit evidence delete was accepted';
            EXCEPTION
              WHEN check_violation THEN
                IF position('document archive audit evidence is append-only' IN SQLERRM) = 0 THEN
                  RAISE;
                END IF;
            END;

            BEGIN
              INSERT INTO public.document_archive_audit_evidence (
                id, "deploymentId", "releaseSha", "databaseIdentity", "storageBucket",
                "protocolVersion", mode,
                "inventoryDigest", "reportSha256", "validatorEvidenceDigest",
                "validatorVersions", counts, "issueCodes", "readyForActivation", "auditedAt"
              )
              SELECT gen_random_uuid(), "deploymentId", repeat('0', 40), "databaseIdentity",
                     "storageBucket", "protocolVersion", mode, repeat('7', 64), repeat('8', 64),
                     "validatorEvidenceDigest", "validatorVersions", counts, "issueCodes",
                     "readyForActivation", "auditedAt"
                FROM public.document_archive_audit_evidence
               WHERE id = current_setting('app.archive_cert_evidence_id')::uuid;
              RAISE EXCEPTION 'audit evidence deployment was accepted twice';
            EXCEPTION
              WHEN unique_violation THEN NULL;
            END;

            BEGIN
              INSERT INTO public.document_archive_audit_evidence (
                id, "deploymentId", "releaseSha", "databaseIdentity", "storageBucket",
                "protocolVersion", mode,
                "inventoryDigest", "reportSha256", "validatorEvidenceDigest",
                "validatorVersions", counts, "issueCodes", "readyForActivation", "auditedAt"
              )
              SELECT gen_random_uuid(), gen_random_uuid(), "releaseSha", "databaseIdentity",
                     "storageBucket", "protocolVersion", mode,
                     "inventoryDigest", "reportSha256", "validatorEvidenceDigest",
                     "validatorVersions", counts, "issueCodes", "readyForActivation", "auditedAt"
                FROM public.document_archive_audit_evidence
               WHERE id = current_setting('app.archive_cert_evidence_id')::uuid;
              RAISE EXCEPTION 'audit evidence exact replay was accepted twice';
            EXCEPTION
              WHEN unique_violation THEN NULL;
            END;
          END
          $archive_evidence$;
        `);

        const [persistedEvidence] = await tx.$queryRaw<Array<{
          privateReport: unknown;
        }>>`
          SELECT "privateReport" AS "privateReport"
            FROM public.document_archive_audit_evidence
           WHERE id = ${evidenceId}::uuid
        `;
        expect(persistedEvidence?.privateReport).toEqual({
          schemaVersion: 1,
          releaseSha: isolatedReleaseSha,
          storageBucket: activationStorageBucket,
          inventoryDigest: '4'.repeat(64),
          protocolVersion: 1,
          mode: 'apply-attestations',
          readyForActivation: true,
          counts: {
            generatedLegalDocuments: 0,
            objectsRead: 0,
            existingAttestations: 0,
            appliedAttestations: 0,
            externallyValidatedProfessionalInvoices: 0,
            storageOrphans: 0,
            missingStoredObjects: 0,
            p0Issues: 0,
          },
          issues: [],
        });

        const [gateWithEvidence] = await tx.$queryRaw<Array<{ accepted: boolean }>>`
          SELECT EXISTS (
            SELECT 1
              FROM public.document_archive_audit_evidence AS evidence
              JOIN public.document_archive_protocol_state AS state
                ON state.id = 1
               AND state."databaseIdentity" = evidence."databaseIdentity"
             WHERE btrim(evidence."releaseSha"::text) = ${isolatedReleaseSha}
               AND evidence."protocolVersion" = 1
               AND evidence.mode = 'apply-attestations'
               AND evidence."readyForActivation"
               AND coalesce((evidence.counts->>'p0Issues')::integer, -1) = 0
          ) AS accepted
        `;
        expect(gateWithEvidence?.accepted).toBe(true);
        throw new Error('ROLLBACK_ARCHIVE_EVIDENCE_FIXTURE');
      })).rejects.toThrow('ROLLBACK_ARCHIVE_EVIDENCE_FIXTURE');

      await expect(insertAuditEvidence({
        releaseSha: 'A'.repeat(40),
        databaseIdentity: protocol.databaseIdentity,
      })).rejects.toThrow();
      await expect(insertAuditEvidence({
        releaseSha: '7'.repeat(40),
        databaseIdentity: protocol.databaseIdentity,
        protocolVersion: 3,
      })).rejects.toThrow();
      await expect(insertAuditEvidence({
        releaseSha: '7'.repeat(40),
        databaseIdentity: protocol.databaseIdentity,
        storageBucket: 'Documents/Production',
      })).rejects.toThrow();
      await expect(insertAuditEvidence({
        releaseSha: '8'.repeat(40),
        databaseIdentity: protocol.databaseIdentity,
        mode: 'unsafe-write',
      })).rejects.toThrow();
      await expect(insertAuditEvidence({
        releaseSha: '8'.repeat(40),
        databaseIdentity: protocol.databaseIdentity,
        mode: 'protocol-v2-verified',
        protocolVersion: 1,
      })).rejects.toThrow();
      await expect(insertAuditEvidence({
        releaseSha: '9'.repeat(40),
        databaseIdentity: protocol.databaseIdentity,
        inventoryDigest: 'not-a-digest',
      })).rejects.toThrow();
      await expect(insertAuditEvidence({
        releaseSha: 'a'.repeat(40),
        databaseIdentity: protocol.databaseIdentity,
        validatorVersions: [],
      })).rejects.toThrow();
      await expect(insertAuditEvidence({
        releaseSha: 'a'.repeat(40),
        databaseIdentity: protocol.databaseIdentity,
        validatorVersions: { ...validatorVersions, mustang: '2.23.0' },
      })).rejects.toThrow();
      await expect(insertAuditEvidence({
        releaseSha: 'b'.repeat(40),
        databaseIdentity: protocol.databaseIdentity,
        counts: [],
      })).rejects.toThrow();
      await expect(insertAuditEvidence({
        releaseSha: 'b'.repeat(40),
        databaseIdentity: protocol.databaseIdentity,
        counts: { p0Issues: 0 },
      })).rejects.toThrow();
      await expect(insertAuditEvidence({
        releaseSha: 'b'.repeat(40),
        databaseIdentity: protocol.databaseIdentity,
        counts: {
          generatedLegalDocuments: 0,
          objectsRead: 0,
          existingAttestations: 0,
          appliedAttestations: 0,
          externallyValidatedProfessionalInvoices: 0,
          storageOrphans: 0,
          missingStoredObjects: 0,
          p0Issues: 1,
        },
        readyForActivation: true,
      })).rejects.toThrow();
      await expect(insertAuditEvidence({
        releaseSha: 'd'.repeat(40),
        databaseIdentity: randomUUID(),
      })).rejects.toThrow();
      await expect(insertAuditEvidence({
        releaseSha: 'e'.repeat(40),
        databaseIdentity: protocol.databaseIdentity,
        privateReport: [],
      })).rejects.toThrow();
      await expect(insertAuditEvidence({
        releaseSha: 'e'.repeat(40),
        databaseIdentity: protocol.databaseIdentity,
        privateReport: {
          schemaVersion: 1,
          releaseSha: 'f'.repeat(40),
          storageBucket: activationStorageBucket,
          inventoryDigest: '4'.repeat(64),
          protocolVersion: 1,
          mode: 'apply-attestations',
          readyForActivation: true,
          counts: {
            generatedLegalDocuments: 0,
            objectsRead: 0,
            existingAttestations: 0,
            appliedAttestations: 0,
            externallyValidatedProfessionalInvoices: 0,
            storageOrphans: 0,
            missingStoredObjects: 0,
            p0Issues: 0,
          },
        },
      })).rejects.toThrow();

      if (SEED_EPHEMERAL_ACTIVATION_EVIDENCE) {
        await admin.$executeRaw`
          INSERT INTO public.document_archive_audit_evidence (
            "deploymentId",
            "releaseSha",
            "databaseIdentity",
            "storageBucket",
            "protocolVersion",
            mode,
            "inventoryDigest",
            "reportSha256",
            "validatorEvidenceDigest",
            "validatorVersions",
            counts,
            "privateReport",
            "issueCodes",
            "readyForActivation",
            "auditedAt"
          ) VALUES (
            ${randomUUID()}::uuid,
            ${activationReleaseSha},
            ${protocol.databaseIdentity}::uuid,
            ${activationStorageBucket},
            ${1}::smallint,
            'apply-attestations',
            ${activationInventoryDigest},
            ${activationReportSha256},
            ${activationValidatorEvidenceDigest},
            ${JSON.stringify(validatorVersions)}::jsonb,
            ${JSON.stringify({
              generatedLegalDocuments: 0,
              objectsRead: 0,
              existingAttestations: 0,
              appliedAttestations: 0,
              externallyValidatedProfessionalInvoices: 0,
              storageOrphans: 0,
              missingStoredObjects: 0,
              p0Issues: 0,
            })}::jsonb,
            ${JSON.stringify({
              schemaVersion: 1,
              releaseSha: activationReleaseSha,
              storageBucket: activationStorageBucket,
              inventoryDigest: activationInventoryDigest,
              protocolVersion: 1,
              mode: 'apply-attestations',
              readyForActivation: true,
              counts: {
                generatedLegalDocuments: 0,
                objectsRead: 0,
                existingAttestations: 0,
                appliedAttestations: 0,
                externallyValidatedProfessionalInvoices: 0,
                storageOrphans: 0,
                missingStoredObjects: 0,
                p0Issues: 0,
              },
              issues: [],
            })}::jsonb,
            ARRAY[]::text[],
            true,
            ${new Date('2026-07-21T12:00:00.000Z')}
          )
          ON CONFLICT ("releaseSha", "inventoryDigest", "reportSha256") DO NOTHING
        `;
        const [seededEvidence] = await admin.$queryRaw<Array<{
          databaseIdentity: string;
          storageBucket: string;
          validatorEvidenceDigest: string;
          validatorsExact: boolean;
          privateReportExact: boolean;
          evidenceCount: number;
        }>>`
          SELECT min("databaseIdentity"::text) AS "databaseIdentity",
                 min("storageBucket") AS "storageBucket",
                 min(btrim("validatorEvidenceDigest"::text)) AS "validatorEvidenceDigest",
                 bool_and("validatorVersions" = ${JSON.stringify(validatorVersions)}::jsonb)
                   AS "validatorsExact",
                 bool_and("privateReport" = ${JSON.stringify({
                   schemaVersion: 1,
                   releaseSha: activationReleaseSha,
                   storageBucket: activationStorageBucket,
                   inventoryDigest: activationInventoryDigest,
                   protocolVersion: 1,
                   mode: 'apply-attestations',
                   readyForActivation: true,
                   counts: {
                     generatedLegalDocuments: 0,
                     objectsRead: 0,
                     existingAttestations: 0,
                     appliedAttestations: 0,
                     externallyValidatedProfessionalInvoices: 0,
                     storageOrphans: 0,
                     missingStoredObjects: 0,
                     p0Issues: 0,
                   },
                   issues: [],
                 })}::jsonb) AS "privateReportExact",
                 count(*)::integer AS "evidenceCount"
            FROM public.document_archive_audit_evidence
           WHERE btrim("releaseSha"::text) = ${activationReleaseSha}
             AND btrim("inventoryDigest"::text) = ${activationInventoryDigest}
             AND btrim("reportSha256"::text) = ${activationReportSha256}
        `;
        expect(seededEvidence).toEqual({
          databaseIdentity: protocol.databaseIdentity,
          storageBucket: activationStorageBucket,
          validatorEvidenceDigest: activationValidatorEvidenceDigest,
          validatorsExact: true,
          privateReportExact: true,
          evidenceCount: 1,
        });
      }

      await expect(runtime.withTenant(companyId, (tx) => tx.$queryRaw`
        SELECT * FROM public.document_archive_audit_evidence LIMIT 1
      `)).rejects.toThrow();
    });

    it.skipIf(!SEED_EPHEMERAL_ACTIVATION_EVIDENCE)(
      'refuse l’activation si le checksum Prisma d’une migration d’archive dérive, sans muter V1',
      async () => {
        const migrationName = '20260721134200_document_archive_data_api_fence';
        const [migrationBefore] = await admin.$queryRaw<Array<{ checksum: string }>>`
          SELECT checksum
            FROM public._prisma_migrations
           WHERE migration_name = ${migrationName}
             AND finished_at IS NOT NULL
             AND rolled_back_at IS NULL
        `;
        if (!migrationBefore?.checksum) {
          throw new Error(`migration ${migrationName} absente de la base de certification`);
        }
        const protocolBefore = await admin.documentArchiveProtocolState.findUniqueOrThrow({
          where: { id: 1 },
        });

        let activationFailure: unknown;
        try {
          await admin.$executeRaw`
            UPDATE public._prisma_migrations
               SET checksum = ${'0'.repeat(64)}
             WHERE migration_name = ${migrationName}
          `;
          try {
            await execFileAsync('sh', ['scripts/activate-document-archive-v2.sh'], {
              cwd: process.cwd(),
              env: {
                ...process.env,
                DIRECT_URL: directUrl,
                APP_DATABASE_ROLE: runtimeRole,
                DOCUMENT_ARCHIVE_V2_ACTIVATION_RELEASE_SHA: activationReleaseSha,
                SUPABASE_STORAGE_BUCKET: activationStorageBucket,
              },
              timeout: 30_000,
              maxBuffer: 1024 * 1024,
            });
          } catch (error) {
            activationFailure = error;
          }
        } finally {
          await admin.$executeRaw`
            UPDATE public._prisma_migrations
               SET checksum = ${migrationBefore.checksum}
             WHERE migration_name = ${migrationName}
          `;
        }

        const failure = activationFailure as {
          code?: number | string | null;
          message?: string;
          stderr?: string | Buffer;
          stdout?: string | Buffer;
        } | undefined;
        const failureOutput = [failure?.message, failure?.stdout, failure?.stderr]
          .filter((value) => value !== undefined)
          .map((value) => String(value))
          .join('\n');
        expect(failure?.code).not.toBe(0);
        expect(failureOutput.toLowerCase()).toContain('checksum');
        await expect(
          admin.documentArchiveProtocolState.findUniqueOrThrow({ where: { id: 1 } }),
        ).resolves.toEqual(protocolBefore);
        const [migrationAfter] = await admin.$queryRaw<Array<{ checksum: string }>>`
          SELECT checksum
            FROM public._prisma_migrations
           WHERE migration_name = ${migrationName}
        `;
        expect(migrationAfter?.checksum).toBe(migrationBefore.checksum);
      },
      30_000,
    );

    it('sérialise le scanner et l’activation sur le même verrou advisory transactionnel', async () => {
      const lockHolder = new PrismaClient({ datasourceUrl: directUrl });
      const lockContender = new PrismaClient({ datasourceUrl: directUrl });
      await Promise.all([lockHolder.$connect(), lockContender.$connect()]);

      let announceLockAcquired: (() => void) | undefined;
      const lockAcquired = new Promise<void>((resolve) => {
        announceLockAcquired = resolve;
      });
      let releaseLock: (() => void) | undefined;
      const keepLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });

      const heldTransaction = lockHolder.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`
          SELECT pg_advisory_xact_lock(
            hashtextextended('bob-document-archive-byte-audit', 0)
          )
        `);
        announceLockAcquired?.();
        await keepLock;
      }, { timeout: 30_000 });

      try {
        await lockAcquired;
        const [whileHeld] = await lockContender.$queryRawUnsafe<Array<{ acquired: boolean }>>(`
          SELECT pg_try_advisory_xact_lock(
            hashtextextended('bob-document-archive-byte-audit', 0)
          ) AS acquired
        `);
        expect(whileHeld?.acquired).toBe(false);
      } finally {
        releaseLock?.();
        await heldTransaction;
      }

      try {
        const [afterRelease] = await lockContender.$transaction((tx) =>
          tx.$queryRawUnsafe<Array<{ acquired: boolean }>>(`
            SELECT pg_try_advisory_xact_lock(
              hashtextextended('bob-document-archive-byte-audit', 0)
            ) AS acquired
          `),
        );
        expect(afterRelease?.acquired).toBe(true);
      } finally {
        await Promise.allSettled([
          lockHolder.$disconnect(),
          lockContender.$disconnect(),
        ]);
      }
    }, 30_000);

    it('sérialise l’attestation historique avec le flip V2 puis retire sa capacité N-1', async () => {
      const activationProbe = new PrismaClient({ datasourceUrl: directUrl });
      await activationProbe.$connect();

      let announceProtocolLock: (() => void) | undefined;
      const protocolLockAcquired = new Promise<void>((resolve) => {
        announceProtocolLock = resolve;
      });
      let releaseProtocolLock: (() => void) | undefined;
      const keepProtocolLock = new Promise<void>((resolve) => {
        releaseProtocolLock = resolve;
      });

      const historicalAttestation = runtime.withTenant(companyId, async (tx) => {
        const [result] = await tx.$queryRaw<Array<{ accepted: boolean }>>`
          SELECT public.attest_historical_generated_invoice_pdf_v1(
            ${companyId},
            ${`missing-history-document-${suffix}`},
            ${`missing-history-version-${suffix}`},
            ${'e'.repeat(64)},
            ${'plain_pdf'},
            ${null}::text,
            ${1}::smallint
          ) AS accepted
        `;
        expect(result?.accepted).toBe(false);
        announceProtocolLock?.();
        await keepProtocolLock;
      });

      await protocolLockAcquired;
      try {
        let activationError: unknown;
        try {
          await activationProbe.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '250ms'`);
            await tx.documentArchiveProtocolState.update({
              where: { id: 1 },
              data: {
                activeVersion: 2,
                activatedAt: new Date(),
                activatedByReleaseSha: 'e'.repeat(40),
              },
            });
          });
        } catch (error) {
          activationError = error;
        }
        expect(String(activationError)).toContain('canceling statement due to lock timeout');
      } finally {
        releaseProtocolLock?.();
        await historicalAttestation;
        await activationProbe.$disconnect();
      }

      const quotedRuntimeRole = `"${runtimeRole.replaceAll('"', '""')}"`;
      await expect(admin.$transaction(async (tx) => {
        await tx.documentArchiveProtocolState.update({
          where: { id: 1 },
          data: {
            activeVersion: 2,
            activatedAt: new Date(),
            activatedByReleaseSha: 'f'.repeat(40),
          },
        });
        const [fenced] = await tx.$queryRaw<Array<{ accepted: boolean }>>`
          SELECT public.attest_historical_generated_invoice_pdf_v1(
            ${companyId},
            ${`missing-history-document-${suffix}`},
            ${`missing-history-version-${suffix}`},
            ${'e'.repeat(64)},
            ${'plain_pdf'},
            ${null}::text,
            ${1}::smallint
          ) AS accepted
        `;
        expect(fenced?.accepted).toBe(false);

        await tx.$executeRawUnsafe(`
          REVOKE EXECUTE
            ON FUNCTION public.attest_historical_generated_invoice_pdf_v1(
              TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, SMALLINT
            )
            FROM ${quotedRuntimeRole}
        `);
        const [postActivationPrivilege] = await tx.$queryRaw<Array<{ accepted: boolean }>>`
          SELECT has_function_privilege(
            ${runtimeRole},
            'public.attest_historical_generated_invoice_pdf_v1(text,text,text,text,text,text,smallint)',
            'EXECUTE'
          ) AS accepted
        `;
        expect(postActivationPrivilege?.accepted).toBe(false);
        throw new Error('ROLLBACK_ARCHIVE_V2_CAPABILITY_PROBE');
      })).rejects.toThrow('ROLLBACK_ARCHIVE_V2_CAPABILITY_PROBE');

      await expect(
        admin.documentArchiveProtocolState.findUniqueOrThrow({ where: { id: 1 } }),
      ).resolves.toMatchObject({ activeVersion: 1, activatedAt: null });
      const [restoredPrivilege] = await admin.$queryRaw<Array<{ accepted: boolean }>>`
        SELECT has_function_privilege(
          ${runtimeRole},
          'public.attest_historical_generated_invoice_pdf_v1(text,text,text,text,text,text,smallint)',
          'EXECUTE'
        ) AS accepted
      `;
      expect(restoredPrivilege?.accepted).toBe(true);
    }, 30_000);

    it('refuse une facture legacy émise dont l’audience historique est réellement inconnue', async () => {
      const legacyInvoiceId = `archive-rollout-legacy-null-${suffix}`;
      const legacyJobId = `archive-rollout-legacy-null-job-${suffix}`;
      let helperAccepted: boolean | undefined;

      await expect(admin.$transaction(async (tx) => {
        // Fixture legacy honnête : la désactivation est protégée par un verrou exclusif et reste
        // dans la transaction. Le rollback final remet le trigger et supprime la ligne même si
        // une assertion ou une requête échoue en chemin.
        await tx.$executeRawUnsafe('LOCK TABLE public.invoices IN ACCESS EXCLUSIVE MODE');
        await tx.$executeRawUnsafe(
          'ALTER TABLE public.invoices DISABLE TRIGGER invoices_capture_archive_audience',
        );
        await tx.$executeRaw`
          INSERT INTO public.invoices (
            id, "companyId", "customerId", kind, status, number, "issuedAt", "dueAt",
            "archiveAudienceAtIssuance"
          ) VALUES (
            ${legacyInvoiceId}, ${companyId}, ${customerB2bId},
            'invoice'::"DocKind", 'issued'::"InvoiceStatus", ${`LEGACY-${suffix}`},
            ${new Date('2026-01-10T00:00:00.000Z')},
            ${new Date('2026-02-09T00:00:00.000Z')},
            NULL
          )
        `;
        const [scope] = await tx.$queryRaw<Array<{ accepted: boolean }>>`
          SELECT public.document_archive_job_scope_v2_is_valid(
            ${companyId}, ${legacyInvoiceId}, ${'invoice-issued'}
          ) AS accepted
        `;
        helperAccepted = scope?.accepted;

        await tx.$executeRaw`
          SELECT set_config('app.current_company_id', ${companyId}, true),
                 set_config('app.archive_cert_legacy_invoice_id', ${legacyInvoiceId}, true),
                 set_config('app.archive_cert_legacy_job_id', ${legacyJobId}, true),
                 set_config(
                   'app.archive_cert_legacy_document_id',
                   ${`archive-rollout-legacy-null-xml-${suffix}`},
                   true
                 )
        `;
        await tx.$executeRawUnsafe(`
          DO $archive_legacy$
          BEGIN
            BEGIN
              PERFORM public.document_archive_job_enqueue_v2(
                current_setting('app.archive_cert_legacy_job_id'),
                current_setting('app.current_company_id'),
                current_setting('app.archive_cert_legacy_invoice_id'),
                'invoice-issued'
              );
              RAISE EXCEPTION 'legacy invoice with unknown audience was accepted';
            EXCEPTION
              WHEN check_violation THEN
                IF position('document archive reason does not match' IN SQLERRM) = 0 THEN
                  RAISE;
                END IF;
            END;
          END
          $archive_legacy$;
        `);
        await tx.$executeRawUnsafe(`
          DO $archive_legacy_xml$
          DECLARE
            document_id TEXT := current_setting('app.archive_cert_legacy_document_id');
            company_id TEXT := current_setting('app.current_company_id');
          BEGIN
            BEGIN
              INSERT INTO public.documents (
                id, "companyId", kind, origin, status, filename, "mimeType", "byteSize",
                sha256, "storageKey", "linkedEntityType", "linkedEntityId", "issuedAt",
                "createdAt", "retentionUntil", revision, tags
              ) VALUES (
                document_id,
                company_id,
                'facturx_xml'::public."StoredDocumentKind",
                'generated'::public."StoredDocumentOrigin",
                'active'::public."StoredDocumentStatus",
                document_id || '.xml',
                'application/xml',
                84,
                repeat('f', 64),
                'companies/' || company_id || '/documents/' || document_id || '/v1/' || repeat('f', 64),
                'invoice'::public."StoredDocumentLinkedEntityType",
                current_setting('app.archive_cert_legacy_invoice_id'),
                '2026-01-10',
                statement_timestamp(),
                '2036-01-10',
                1,
                ARRAY[]::TEXT[]
              );
              RAISE EXCEPTION 'legacy invoice XML with unknown audience was accepted';
            EXCEPTION
              WHEN check_violation THEN
                IF position('generated Factur-X XML requires a professional audience' IN SQLERRM) = 0 THEN
                  RAISE;
                END IF;
            END;
          END
          $archive_legacy_xml$;
        `);
        await expect(tx.documentArchiveJob.findUnique({ where: { id: legacyJobId } }))
          .resolves.toBeNull();

        throw new Error('ROLLBACK_ARCHIVE_LEGACY_FIXTURE');
      })).rejects.toThrow('ROLLBACK_ARCHIVE_LEGACY_FIXTURE');

      expect(helperAccepted).toBe(false);
      await expect(admin.invoice.findUnique({ where: { id: legacyInvoiceId } }))
        .resolves.toBeNull();
      const [trigger] = await admin.$queryRaw<Array<{ enabled: string }>>`
        SELECT tgenabled AS enabled
          FROM pg_trigger
         WHERE tgrelid = 'invoices'::regclass
           AND tgname = 'invoices_capture_archive_audience'
      `;
      expect(trigger?.enabled).toBe('O');
    }, 30_000);

    it('laisse N-1 écrire/rejouer ses ordres, mais N applique déjà les scopes exacts', async () => {
      const b2bInvoiceId = `archive-rollout-invoice-b2b-${suffix}`;
      const b2gInvoiceId = `archive-rollout-invoice-b2g-${suffix}`;
      const b2cLegacyInvoiceId = `archive-rollout-invoice-b2c-legacy-${suffix}`;
      const b2cV2InvoiceId = `archive-rollout-invoice-b2c-v2-${suffix}`;
      const b2bJobId = `archive-rollout-job-b2b-${suffix}`;
      const legacyB2cJobId = `archive-rollout-job-b2c-legacy-${suffix}`;
      await seedIssuedInvoice(b2bInvoiceId, customerB2bId);
      await seedIssuedInvoice(b2gInvoiceId, customerB2gId);
      await seedIssuedInvoice(b2cLegacyInvoiceId, customerB2cId);
      await seedIssuedInvoice(b2cV2InvoiceId, customerB2cId);

      const directB2b = await runtime.withTenant(companyId, (tx) => tx.documentArchiveJob.create({
        data: {
          id: b2bJobId,
          companyId,
          invoiceId: b2bInvoiceId,
          reason: 'invoice-issued',
          status: 'pending',
          nextAttemptAt: new Date(),
        },
      }));
      expect(directB2b).toMatchObject({ id: b2bJobId, reason: 'invoice-issued' });
      expect(directB2b.nextAttemptAt.getUTCFullYear()).toBe(9999);
      await expect(runtime.withTenant(companyId, (tx) => tx.documentArchiveJob.updateMany({
        where: { id: b2bJobId, companyId },
        data: { status: 'pending', lastError: null, nextAttemptAt: new Date() },
      }))).resolves.toMatchObject({ count: 1 });
      const spooledB2b = await admin.documentArchiveJob.findUniqueOrThrow({
        where: { id: b2bJobId },
      });
      expect(spooledB2b.nextAttemptAt.getUTCFullYear()).toBe(9999);
      const [claimWhileV1] = await runtime.withTenant(companyId, (tx) => tx.$queryRaw<
        Array<{ accepted: boolean }>
      >`
        SELECT public.document_archive_job_claim_v1(
          ${b2bJobId}, ${companyId}, ${spooledB2b.updatedAt}::timestamp(3),
          ${60_000}::bigint, ${randomUUID()}
        ) AS accepted
      `);
      expect(claimWhileV1?.accepted).toBe(false);
      await expect(runtime.withTenant(companyId, (tx) => tx.documentArchiveJob.findMany({
        where: {
          id: b2bJobId,
          companyId,
          nextAttemptAt: { lte: new Date() },
        },
      }))).resolves.toEqual([]);
      await expect(admin.$executeRaw`
        UPDATE document_archive_jobs
           SET "integrityProof" = ${JSON.stringify({})}::jsonb
         WHERE id = ${b2bJobId}
      `).rejects.toThrow('document archive completion is paused during V2 cutover');

      // Pendant l'expand seulement, le binaire N-1 ignore encore le scope PDF-seul B2C. La
      // ligne reste non prouvée ; le premier enqueue V2 la réconcilie sans changer son identité.
      await runtime.withTenant(companyId, (tx) => tx.documentArchiveJob.create({
        data: {
          id: legacyB2cJobId,
          companyId,
          invoiceId: b2cLegacyInvoiceId,
          reason: 'invoice-issued',
          status: 'pending',
          nextAttemptAt: new Date(),
        },
      }));
      const [reconciled] = await runtime.withTenant(companyId, (tx) => tx.$queryRaw<
        Array<{ accepted: boolean }>
      >`
        SELECT public.document_archive_job_enqueue_v2(
          ${`replacement-${suffix}`},
          ${companyId},
          ${b2cLegacyInvoiceId},
          ${'invoice-issued-pdf-only-b2c'}
        ) AS accepted
      `);
      expect(reconciled?.accepted).toBe(true);
      await expect(admin.documentArchiveJob.findUnique({ where: { id: legacyB2cJobId } }))
        .resolves.toMatchObject({
          id: legacyB2cJobId,
          reason: 'invoice-issued-pdf-only-b2c',
          status: 'pending',
          integrityProof: null,
          integrityProofSha256: null,
          completedAt: null,
        });
      const reconciledB2c = await admin.documentArchiveJob.findUniqueOrThrow({
        where: { id: legacyB2cJobId },
      });
      expect(reconciledB2c.nextAttemptAt.getUTCFullYear()).toBe(9999);

      const [b2gAccepted] = await runtime.withTenant(companyId, (tx) => tx.$queryRaw<
        Array<{ accepted: boolean }>
      >`
        SELECT public.document_archive_job_enqueue_v2(
          ${`archive-rollout-job-b2g-${suffix}`},
          ${companyId},
          ${b2gInvoiceId},
          ${'invoice-issued'}
        ) AS accepted
      `);
      expect(b2gAccepted?.accepted).toBe(true);

      const [b2cAccepted] = await runtime.withTenant(companyId, (tx) => tx.$queryRaw<
        Array<{ accepted: boolean }>
      >`
        SELECT public.document_archive_job_enqueue_v2(
          ${`archive-rollout-job-b2c-v2-${suffix}`},
          ${companyId},
          ${b2cV2InvoiceId},
          ${'invoice-issued-pdf-only-b2c'}
        ) AS accepted
      `);
      expect(b2cAccepted?.accepted).toBe(true);

      // Le trigger de spool est lui-même phase-aware : dans une activation transactionnelle,
      // V2 peut réarmer puis le lease devient prenable. Le rollback final conserve le vrai rail
      // V1 du certificat et son sentinel 9999.
      await expect(admin.$transaction(async (tx) => {
        await tx.documentArchiveProtocolState.update({
          where: { id: 1 },
          data: {
            activeVersion: 2,
            activatedAt: new Date(),
            activatedByReleaseSha: 'd'.repeat(40),
          },
        });
        await tx.$executeRaw`
          UPDATE public.document_archive_jobs
             SET "nextAttemptAt" = statement_timestamp(),
                 "updatedAt" = statement_timestamp(),
                 status = 'pending'::public."DocumentArchiveJobStatus"
           WHERE id = ${b2bJobId}
        `;
        const rearmed = await tx.documentArchiveJob.findUniqueOrThrow({
          where: { id: b2bJobId },
        });
        expect(rearmed.nextAttemptAt.getUTCFullYear()).toBeLessThan(9999);
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        const [claimInV2] = await tx.$queryRaw<Array<{ accepted: boolean }>>`
          SELECT public.document_archive_job_claim_v1(
            ${b2bJobId}, ${companyId}, ${rearmed.updatedAt.toISOString()}::timestamp(3),
            ${60_000}::bigint, ${randomUUID()}
          ) AS accepted
        `;
        expect(claimInV2?.accepted).toBe(true);
        throw new Error('ROLLBACK_ARCHIVE_REARM_PROBE');
      })).rejects.toThrow('ROLLBACK_ARCHIVE_REARM_PROBE');
      await expect(
        admin.documentArchiveProtocolState.findUniqueOrThrow({ where: { id: 1 } }),
      ).resolves.toMatchObject({ activeVersion: 1, activatedAt: null });
      await expect(admin.documentArchiveJob.findUniqueOrThrow({ where: { id: b2bJobId } }))
        .resolves.toMatchObject({ nextAttemptAt: spooledB2b.nextAttemptAt });

      await expect(runtime.withTenant(companyId, (tx) => tx.$queryRaw`
        SELECT public.document_archive_job_enqueue_v2(
          ${randomUUID()}, ${companyId}, ${b2bInvoiceId}, ${'invoice-issued-pdf-only-b2c'}
        )
      `)).rejects.toThrow('document archive reason does not match');
      await expect(runtime.withTenant(companyId, (tx) => tx.$queryRaw`
        SELECT public.document_archive_job_enqueue_v2(
          ${randomUUID()}, ${companyId}, ${b2cV2InvoiceId}, ${'invoice-issued'}
        )
      `)).rejects.toThrow('document archive reason does not match');

      await expect(runtime.withTenant(companyId, (tx) => tx.documentArchiveJob.create({
        data: {
          id: `archive-rollout-quote-job-${suffix}`,
          companyId,
          invoiceId: signedQuoteId,
          reason: 'quote-signed',
          status: 'pending',
          nextAttemptAt: new Date(),
        },
      }))).resolves.toMatchObject({ reason: 'quote-signed' });
      await expect(runtime.withTenant(companyId, (tx) => tx.documentArchiveJob.create({
        data: {
          id: randomUUID(),
          companyId,
          invoiceId: `missing-${suffix}`,
          reason: 'invoice-issued',
          status: 'pending',
          nextAttemptAt: new Date(),
        },
      }))).rejects.toThrow('document archive reason does not match');
    });

    it('bloque tout original légal généré pendant l’expand, y compris le scope professionnel', async () => {
      const professionalInvoiceId = `archive-rollout-xml-pro-${suffix}`;
      const consumerInvoiceId = `archive-rollout-xml-consumer-${suffix}`;
      await seedIssuedInvoice(professionalInvoiceId, customerB2bId);
      await seedIssuedInvoice(consumerInvoiceId, customerB2cId);

      const documentData = (id: string, invoiceId: string) => ({
        id,
        companyId,
        kind: 'facturx_xml' as const,
        origin: 'generated' as const,
        status: 'active' as const,
        filename: `${id}.xml`,
        mimeType: 'application/xml',
        byteSize: 84,
        sha256: 'd'.repeat(64),
        storageKey: `companies/${companyId}/documents/${id}/v1/${'d'.repeat(64)}`,
        linkedEntityType: 'invoice' as const,
        linkedEntityId: invoiceId,
        issuedAt: '2026-07-21',
        createdAt: new Date('2026-07-21T10:00:00.000Z'),
        retentionUntil: '2036-07-21',
      });

      await expect(runtime.withTenant(companyId, (tx) => tx.storedDocument.create({
        data: documentData(`archive-rollout-xml-consumer-runtime-${suffix}`, consumerInvoiceId),
      }))).rejects.toThrow(
        'generated Factur-X XML requires a professional audience frozen at invoice issuance',
      );
      await expect(admin.storedDocument.create({
        data: documentData(`archive-rollout-xml-consumer-direct-${suffix}`, consumerInvoiceId),
      })).rejects.toThrow(
        'generated Factur-X XML requires a professional audience frozen at invoice issuance',
      );

      const consumerPdfId = `archive-rollout-pdf-consumer-${suffix}`;
      await expect(runtime.withTenant(companyId, (tx) => tx.storedDocument.create({
        data: {
          ...documentData(consumerPdfId, consumerInvoiceId),
          kind: 'invoice_pdf',
          filename: `${consumerPdfId}.pdf`,
          mimeType: 'application/pdf',
        },
      }))).rejects.toThrow('generated legal archives are paused during V2 cutover');

      const professionalDocumentId = `archive-rollout-xml-professional-${suffix}`;
      await expect(runtime.withTenant(companyId, (tx) => tx.storedDocument.create({
        data: documentData(professionalDocumentId, professionalInvoiceId),
      }))).rejects.toThrow(
        'generated legal archives are paused during V2 cutover',
      );
    });

    it('autorise uniquement le no-op version N-1 et interdit DELETE devis', async () => {
      await expect(runtime.withTenant(companyId, (tx) => tx.storedDocumentVersion.update({
        where: { id: versionId },
        data: {
          storageKey:
            `companies/${companyId}/documents/${versionDocumentId}/v1/${'a'.repeat(64)}`,
          sha256: 'a'.repeat(64),
          mimeType: 'application/octet-stream',
          byteSize: 42,
          createdAt: new Date('2026-07-21T10:00:00.000Z'),
          reason: 'initial-upload',
        },
      }))).resolves.toMatchObject({ id: versionId, sha256: 'a'.repeat(64) });
      await expect(runtime.withTenant(companyId, (tx) => tx.storedDocumentVersion.update({
        where: { id: versionId },
        data: { sha256: 'b'.repeat(64) },
      }))).rejects.toThrow('document versions are immutable');
      await expect(runtime.withTenant(companyId, (tx) => tx.quote.deleteMany({
        where: { id: signedQuoteId, companyId },
      }))).rejects.toThrow();
    });
  },
);

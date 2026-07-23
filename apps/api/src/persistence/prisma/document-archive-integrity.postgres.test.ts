import { randomInt, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LEGACY_ARCHIVE_PROOF_REQUIRED,
  documentArchiveIntegrityProofSha256,
  type DocumentArchiveIntegrityProof,
} from '../document-archive-jobs';
import { PrismaDocumentArchiveJobRepository } from './repositories';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_DOCUMENT_ARCHIVE_CERT === 'true';
const WORKER_COUNT = 8;

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

function invoiceProof(companyId: string, pieceId: string): DocumentArchiveIntegrityProof {
  const artifact = (kind: 'invoice_pdf' | 'facturx_xml') => {
    const documentId = `doc-${kind}-${pieceId}`;
    const sha256 = kind === 'invoice_pdf' ? 'a'.repeat(64) : 'b'.repeat(64);
    return {
      kind,
      contentProfile:
        kind === 'invoice_pdf' ? ('facturx_pdfa3' as const) : ('facturx_xml' as const),
      documentId,
      versionId: `${documentId}-v1`,
      version: 1 as const,
      storageKey: `companies/${companyId}/documents/${documentId}/v1/${sha256}`,
      mimeType: kind === 'facturx_xml' ? 'application/xml' : 'application/pdf',
      byteSize: kind === 'facturx_xml' ? 84 : 42,
      sha256,
    };
  };
  return {
    version: 1,
    algorithm: 'sha256',
    companyId,
    pieceId,
    reason: 'invoice-issued',
    artifacts: [artifact('facturx_xml'), artifact('invoice_pdf')],
  };
}

function pdfOnlyInvoiceProof(companyId: string, pieceId: string): DocumentArchiveIntegrityProof {
  const full = invoiceProof(companyId, pieceId);
  return {
    ...full,
    reason: 'invoice-issued-pdf-only-b2c',
    artifacts: full.artifacts
      .filter((artifact) => artifact.kind === 'invoice_pdf')
      .map((artifact) => ({ ...artifact, contentProfile: 'plain_pdf' as const })),
  };
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Archive applicative vérifiée — certification PostgreSQL/RLS réelle',
  () => {
    const companyA = `archive-cert-a-${randomUUID()}`;
    const companyB = `archive-cert-b-${randomUUID()}`;
    const legalDocumentId = `archive-doc-${randomUUID()}`;
    const legalDocumentVersionId = `${legalDocumentId}-v1`;
    const legalDocumentSha256 = 'c'.repeat(64);
    const legalDocumentStorageKey = `companies/${companyA}/documents/${legalDocumentId}/v1/${legalDocumentSha256}.pdf`;
    const legalDocumentInvoiceId = `archive-legal-invoice-${randomUUID()}`;
    const signedQuoteId = `archive-signed-quote-${randomUUID()}`;
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    let admin: PrismaClient;
    let workers: PrismaService[] = [];

    const customerId = (companyId: string) => `archive-customer-${companyId}`;
    const b2cCustomerId = (companyId: string) => `archive-customer-b2c-${companyId}`;
    const b2gCustomerId = (companyId: string) => `archive-customer-b2g-${companyId}`;

    async function seedIssuedInvoice(
      companyId: string,
      pieceId: string,
      customerType: 'b2b' | 'b2c' | 'b2g' = 'b2b',
    ): Promise<void> {
      await admin.invoice.create({
        data: {
          id: pieceId,
          companyId,
          customerId:
            customerType === 'b2c'
              ? b2cCustomerId(companyId)
              : customerType === 'b2g'
                ? b2gCustomerId(companyId)
                : customerId(companyId),
          kind: 'invoice',
          status: 'draft',
        },
      });
      await admin.invoice.update({
        where: { id: pieceId },
        data: {
          status: 'issued',
          number: `CERT-${randomUUID()}`,
          issuedAt: new Date('2026-07-21T10:00:00.000Z'),
          dueAt: new Date('2026-08-20T10:00:00.000Z'),
        },
      });
    }

    async function attestInvoicePdf(
      tx: Prisma.TransactionClient,
      input: {
        companyId: string;
        documentId: string;
        versionId: string;
        documentSha256: string;
        profile: 'plain_pdf' | 'facturx_pdfa3';
        embeddedXmlSha256: string | null;
      },
    ): Promise<boolean> {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${input.companyId}, true)`;
      const [result] = await tx.$queryRaw<Array<{ accepted: boolean }>>`
        SELECT public.attest_generated_invoice_pdf_v1(
          ${input.companyId},
          ${input.documentId},
          ${input.versionId},
          ${input.documentSha256},
          ${input.profile},
          ${input.embeddedXmlSha256}::text,
          ${1}::smallint
        ) AS accepted
      `;
      return result?.accepted ?? false;
    }

    async function seedGeneratedInvoicePdf(
      tx: Prisma.TransactionClient,
      input: {
        documentId: string;
        invoiceId: string;
        reason: 'invoice-issued' | 'invoice-issued-pdf-only-b2c';
        sha256: string;
      },
    ): Promise<{ versionId: string }> {
      const versionId = `${input.documentId}-v1`;
      const storageKey = `companies/${companyA}/documents/${input.documentId}/v1/${input.sha256}`;
      await tx.storedDocument.create({
        data: {
          id: input.documentId,
          companyId: companyA,
          kind: 'invoice_pdf',
          origin: 'generated',
          status: 'active',
          filename: `${input.documentId}.pdf`,
          mimeType: 'application/pdf',
          byteSize: 42,
          sha256: input.sha256,
          storageKey,
          linkedEntityType: 'invoice',
          linkedEntityId: input.invoiceId,
          documentDate: '2026-07-21',
          issuedAt: '2026-07-21',
          createdAt: new Date('2026-07-21T10:00:00.000Z'),
          retentionUntil: '2036-07-21',
          versions: {
            create: {
              id: versionId,
              version: 1,
              storageKey,
              sha256: input.sha256,
              mimeType: 'application/pdf',
              byteSize: 42,
              createdAt: new Date('2026-07-21T10:00:00.000Z'),
              reason: input.reason,
            },
          },
        },
      });
      return { versionId };
    }

    async function seedProofArtifacts(
      proof: DocumentArchiveIntegrityProof,
      options: { embeddedXmlSha256?: string } = {},
    ): Promise<void> {
      for (const artifact of proof.artifacts) {
        await admin.$transaction(async (tx) => {
          await tx.storedDocument.create({
            data: {
              id: artifact.documentId,
              companyId: proof.companyId,
              kind: artifact.kind,
              origin: 'generated',
              status: 'active',
              filename: `${artifact.kind}-${proof.pieceId}.${artifact.mimeType === 'application/xml' ? 'xml' : 'pdf'}`,
              mimeType: artifact.mimeType,
              byteSize: artifact.byteSize,
              sha256: artifact.sha256,
              storageKey: artifact.storageKey,
              linkedEntityType: 'invoice',
              linkedEntityId: proof.pieceId,
              documentDate: '2026-07-21',
              issuedAt: '2026-07-21',
              createdAt: new Date(),
              retentionUntil: '2036-07-21',
              versions: {
                create: {
                  id: artifact.versionId,
                  version: artifact.version,
                  storageKey: artifact.storageKey,
                  sha256: artifact.sha256,
                  mimeType: artifact.mimeType,
                  byteSize: artifact.byteSize,
                  createdAt: new Date(),
                  reason: proof.reason,
                },
              },
            },
          });
          if (artifact.kind === 'invoice_pdf') {
            if (
              artifact.contentProfile !== 'plain_pdf' &&
              artifact.contentProfile !== 'facturx_pdfa3'
            ) {
              throw new Error('profil PDF de fixture invalide');
            }
            const embeddedXmlSha256 =
              options.embeddedXmlSha256 ??
              proof.artifacts.find((candidate) => candidate.kind === 'facturx_xml')?.sha256 ??
              null;
            await expect(
              attestInvoicePdf(tx, {
                companyId: proof.companyId,
                documentId: artifact.documentId,
                versionId: artifact.versionId,
                documentSha256: artifact.sha256,
                profile: artifact.contentProfile,
                embeddedXmlSha256,
              }),
            ).resolves.toBe(true);
          }
        });
      }
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
      }
      admin = new PrismaClient({ datasourceUrl: directUrl });
      workers = Array.from(
        { length: WORKER_COUNT },
        () => new PrismaService({ datasourceUrl: runtimeUrl }),
      );
      await Promise.all([admin.$connect(), ...workers.map((worker) => worker.$connect())]);
      for (const [id, suffix] of [
        [companyA, 'A'],
        [companyB, 'B'],
      ] as const) {
        const siren = appendLuhnDigit(String(randomInt(10_000_000, 100_000_000)));
        const siret = appendLuhnDigit(`${siren}${String(randomInt(0, 10_000)).padStart(4, '0')}`);
        await admin.company.create({
          data: {
            id,
            name: `Bob Archive Cert ${suffix}`,
            legalForm: 'EI',
            siren,
            siret,
            trade: 'certification',
            vatRegime: 'reel_normal',
            addrLine1: '1 rue de la Certification',
            addrZip: '75001',
            addrCity: 'Paris',
          },
        });
        await admin.customer.create({
          data: {
            id: customerId(id),
            companyId: id,
            type: 'b2b',
            name: `Client Archive Cert ${suffix}`,
            addrLine1: '2 rue de la Certification',
            addrZip: '75001',
            addrCity: 'Paris',
          },
        });
        await admin.customer.create({
          data: {
            id: b2cCustomerId(id),
            companyId: id,
            type: 'b2c',
            name: `Particulier Archive Cert ${suffix}`,
            addrLine1: '3 rue de la Certification',
            addrZip: '75001',
            addrCity: 'Paris',
          },
        });
        await admin.customer.create({
          data: {
            id: b2gCustomerId(id),
            companyId: id,
            type: 'b2g',
            name: `Acheteur public Archive Cert ${suffix}`,
            addrLine1: '4 rue de la Certification',
            addrZip: '75001',
            addrCity: 'Paris',
          },
        });
      }
      await admin.quote.create({
        data: {
          id: signedQuoteId,
          companyId: companyA,
          customerId: customerId(companyA),
          status: 'signed',
          number: `D-CERT-${randomUUID()}`,
          issuedAt: new Date('2026-07-21T00:00:00.000Z'),
          signerName: 'Client Archive Cert A',
          signedAt: new Date('2026-07-21T09:00:00.000Z'),
          signatureCustomerType: 'b2b',
        },
      });
      await seedIssuedInvoice(companyA, legalDocumentInvoiceId, 'b2b');
      await admin.$transaction(async (tx) => {
        await tx.storedDocument.create({
          data: {
            id: legalDocumentId,
            companyId: companyA,
            kind: 'invoice_pdf',
            origin: 'generated',
            status: 'active',
            filename: 'facture-certifiee.pdf',
            mimeType: 'application/pdf',
            byteSize: 42,
            sha256: legalDocumentSha256,
            storageKey: legalDocumentStorageKey,
            linkedEntityType: 'invoice',
            linkedEntityId: legalDocumentInvoiceId,
            issuedAt: '2026-07-21',
            createdAt: new Date(),
            retentionUntil: '2036-07-21',
            versions: {
              create: {
                id: legalDocumentVersionId,
                version: 1,
                storageKey: legalDocumentStorageKey,
                sha256: legalDocumentSha256,
                mimeType: 'application/pdf',
                byteSize: 42,
                createdAt: new Date(),
                reason: 'invoice-issued',
              },
            },
          },
        });
        await expect(
          attestInvoicePdf(tx, {
            companyId: companyA,
            documentId: legalDocumentId,
            versionId: legalDocumentVersionId,
            documentSha256: legalDocumentSha256,
            profile: 'facturx_pdfa3',
            embeddedXmlSha256: 'd'.repeat(64),
          }),
        ).resolves.toBe(true);
      });
      await admin.$executeRaw`
        INSERT INTO storage.objects (bucket_id, name)
        VALUES ('documents', ${legalDocumentStorageKey})
        ON CONFLICT (bucket_id, name) DO NOTHING
      `;
    }, 30_000);

    afterAll(async () => {
      try {
        if (admin) {
          // Les preuves légales sont volontairement indestructibles par les chemins normaux.
          // Le teardown de certification utilise donc une transaction privilégiée explicite :
          // mêmes verrous ordonnés que le cutover, triggers réactivés avant COMMIT, zéro erreur
          // avalée. Supprimer seulement l'attestation laisserait une base invalide et rendrait la
          // certification suivante dépendante de l'ordre des tests.
          await admin.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('LOCK TABLE public.documents IN ACCESS EXCLUSIVE MODE');
            await tx.$executeRawUnsafe(
              'LOCK TABLE public.document_versions IN ACCESS EXCLUSIVE MODE',
            );
            await tx.$executeRawUnsafe(
              'LOCK TABLE public.document_invoice_pdf_attestations IN ACCESS EXCLUSIVE MODE',
            );
            await tx.$executeRawUnsafe('LOCK TABLE storage.objects IN ACCESS EXCLUSIVE MODE');
            await tx.$executeRawUnsafe(
              'ALTER TABLE public.document_versions DISABLE TRIGGER ' +
                'document_versions_generated_legal_archive_representation_v2',
            );
            await tx.$executeRawUnsafe(
              'ALTER TABLE public.document_invoice_pdf_attestations DISABLE TRIGGER ' +
                'document_invoice_pdf_attestations_immutable',
            );
            await tx.documentArchiveJobArtifact.deleteMany({
              where: { companyId: { in: [companyA, companyB] } },
            });
            await tx.documentArchiveJob.deleteMany({
              where: { companyId: { in: [companyA, companyB] } },
            });
            await tx.documentInvoicePdfAttestation.deleteMany({
              where: { companyId: { in: [companyA, companyB] } },
            });
            await tx.storedDocument.deleteMany({
              where: { companyId: { in: [companyA, companyB] } },
            });
            await tx.$executeRaw`
              DELETE FROM storage.objects
               WHERE name = ${legalDocumentStorageKey}
            `;
            await tx.invoice.deleteMany({
              where: { companyId: { in: [companyA, companyB] } },
            });
            await tx.quote.deleteMany({
              where: { companyId: { in: [companyA, companyB] } },
            });
            await tx.customer.deleteMany({
              where: { companyId: { in: [companyA, companyB] } },
            });
            await tx.company.deleteMany({
              where: { id: { in: [companyA, companyB] } },
            });
            await tx.$executeRawUnsafe(
              'ALTER TABLE public.document_invoice_pdf_attestations ENABLE TRIGGER ' +
                'document_invoice_pdf_attestations_immutable',
            );
            await tx.$executeRawUnsafe(
              'ALTER TABLE public.document_versions ENABLE TRIGGER ' +
                'document_versions_generated_legal_archive_representation_v2',
            );
          });
        }
      } finally {
        await Promise.allSettled([
          ...workers.map((worker) => worker.$disconnect()),
          ...(admin ? [admin.$disconnect()] : []),
        ]);
      }
    });

    it('certifie migration, contraintes profondes, FORCE RLS et absence de DELETE runtime', async () => {
      const [posture] = await workers[0]!.$queryRaw<
        Array<{
          rolsuper: boolean;
          rolbypassrls: boolean;
          canSelect: boolean;
          canInsert: boolean;
          canUpdate: boolean;
          canDelete: boolean;
          canTruncate: boolean;
          artifactSelect: boolean;
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
          protocolSelect: boolean;
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
          canEnqueueV1: boolean;
          canEnqueueV2: boolean;
          canClaim: boolean;
          canFail: boolean;
          canCompleteV1: boolean;
          canCompleteV2: boolean;
          canAttestPdf: boolean;
          canCheckPdfVisibility: boolean;
          canUseDeepPdfAttestationHelper: boolean;
          canUseDeepRepresentationHelper: boolean;
        }>
      >`
        SELECT role.rolsuper,
               role.rolbypassrls,
               has_table_privilege(current_user, 'document_archive_jobs', 'SELECT') AS "canSelect",
               has_table_privilege(current_user, 'document_archive_jobs', 'INSERT') AS "canInsert",
               has_table_privilege(current_user, 'document_archive_jobs', 'UPDATE') AS "canUpdate",
               has_table_privilege(current_user, 'document_archive_jobs', 'DELETE') AS "canDelete",
               has_table_privilege(current_user, 'document_archive_jobs', 'TRUNCATE') AS "canTruncate",
               has_table_privilege(current_user, 'document_archive_job_artifacts', 'SELECT') AS "artifactSelect",
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
               has_table_privilege(current_user, 'document_archive_protocol_state', 'SELECT') AS "protocolSelect",
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
               has_function_privilege(
                 current_user,
                 'public.document_archive_job_enqueue_v1(text,text,text,text)',
                 'EXECUTE'
               ) AS "canEnqueueV1",
               has_function_privilege(
                 current_user,
                 'public.document_archive_job_enqueue_v2(text,text,text,text)',
                 'EXECUTE'
               ) AS "canEnqueueV2",
               has_function_privilege(
                 current_user,
                 'public.document_archive_job_claim_v1(text,text,timestamp without time zone,bigint,text)',
                 'EXECUTE'
               ) AS "canClaim",
               has_function_privilege(
                 current_user,
                 'public.document_archive_job_fail_v1(text,text,text,bigint,text)',
                 'EXECUTE'
               ) AS "canFail",
               has_function_privilege(
                 current_user,
                 'public.document_archive_job_complete_v1(text,text,text,jsonb,text)',
                 'EXECUTE'
               ) AS "canCompleteV1",
               has_function_privilege(
                 current_user,
                 'public.document_archive_job_complete_v2(text,text,text,jsonb,text)',
                 'EXECUTE'
               ) AS "canCompleteV2",
               has_function_privilege(
                 current_user,
                 'public.attest_generated_invoice_pdf_v1(text,text,text,text,text,text,smallint)',
                 'EXECUTE'
               ) AS "canAttestPdf",
               has_function_privilege(
                 current_user,
                 'public.generated_invoice_pdf_attestation_visible_v2(text,text)',
                 'EXECUTE'
               ) AS "canCheckPdfVisibility",
               has_function_privilege(
                 current_user,
                 'public.document_archive_job_pdf_attestation_v2_is_valid(text,text,text,jsonb)',
                 'EXECUTE'
               ) AS "canUseDeepPdfAttestationHelper",
               has_function_privilege(
                 current_user,
                 'public.generated_legal_archive_representation_v2_is_valid(text)',
                 'EXECUTE'
               ) AS "canUseDeepRepresentationHelper"
          FROM pg_roles AS role
         WHERE role.rolname = current_user
      `;
      expect(posture).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        canSelect: true,
        canInsert: false,
        canUpdate: false,
        canDelete: false,
        canTruncate: false,
        artifactSelect: true,
        artifactInsert: false,
        artifactUpdate: false,
        artifactDelete: false,
        attestationSelect: true,
        attestationInsert: false,
        attestationUpdate: false,
        attestationDelete: false,
        attestationTruncate: false,
        versionUpdate: false,
        quoteDelete: false,
        protocolSelect: true,
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
        canEnqueueV1: false,
        canEnqueueV2: true,
        canClaim: true,
        canFail: true,
        canCompleteV1: false,
        canCompleteV2: true,
        canAttestPdf: true,
        canCheckPdfVisibility: true,
        canUseDeepPdfAttestationHelper: false,
        canUseDeepRepresentationHelper: false,
      });

      const [shape] = await admin.$queryRaw<
        Array<{
          rowSecurity: boolean;
          forceRowSecurity: boolean;
          constraints: number;
          deletePolicies: number;
          triggerEnabled: boolean;
          dueIndex: boolean;
          leaseIndex: boolean;
          migrationApplied: boolean;
          retentionMigrationApplied: boolean;
          dbClosureMigrationApplied: boolean;
          customerScopeMigrationApplied: boolean;
          rolloutMigrationApplied: boolean;
          storageFenceMigrationApplied: boolean;
          storageFenceEnabled: boolean;
          storageFenceHardened: boolean;
          privateReportMigrationApplied: boolean;
          evidenceRowSecurity: boolean;
          evidenceForceRowSecurity: boolean;
          evidencePolicies: number;
          exposedEvidenceRolesWithCapabilities: number;
          exposedProtocolRolesWithMutationCapabilities: number;
          exposedSettlementRolesWithMutationCapabilities: number;
          exposedArchiveFunctionsWithExecute: number;
          scopeTriggerEnabled: boolean;
          customerTypeTriggerEnabled: boolean;
          invoiceAudienceTriggerEnabled: boolean;
          facturxScopeTriggerEnabled: boolean;
          spoolTriggerEnabled: boolean;
          generatedLegalCutoverTriggerEnabled: boolean;
          protocolTriggerEnabled: boolean;
          jobInsertPolicies: number;
          jobUpdatePolicies: number;
          versionUpdatePolicies: number;
          expandPoliciesOpen: boolean;
          artifactForeignKeys: number;
          artifactMutationPolicies: number;
          attestationRowSecurity: boolean;
          attestationForceRowSecurity: boolean;
          attestationForeignKeys: number;
          attestationSelectPolicies: number;
          attestationMutationPolicies: number;
          attestationTriggerEnabled: boolean;
          documentRepresentationPolicyRestrictive: boolean;
          pdfAttestationValidatorExists: boolean;
          publicMutationFunctions: number;
        }>
      >`
        SELECT table_class.relrowsecurity AS "rowSecurity",
               table_class.relforcerowsecurity AS "forceRowSecurity",
               (SELECT count(*)::integer
                  FROM pg_constraint
                 WHERE conrelid = 'document_archive_jobs'::regclass
                   AND convalidated
                   AND conname IN (
                     'document_archive_jobs_reason_valid',
                     'document_archive_jobs_integrity_digest_shape',
                     'document_archive_jobs_integrity_proof_shape',
                     'document_archive_jobs_completion_proof_atomic',
                     'document_archive_jobs_lease_shape'
                   )) AS constraints,
               (SELECT count(*)::integer
                  FROM pg_policy
                 WHERE polrelid = 'document_archive_jobs'::regclass
                   AND polcmd = 'd') AS "deletePolicies",
               EXISTS (
                 SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'document_archive_jobs'::regclass
                    AND tgname = 'document_archive_jobs_proof_immutable'
                    AND tgenabled <> 'D'
               ) AS "triggerEnabled",
               to_regclass('public.document_archive_jobs_due_claim_idx') IS NOT NULL AS "dueIndex",
               to_regclass('public."document_archive_jobs_leaseToken_key"') IS NOT NULL AS "leaseIndex",
               EXISTS (
                 SELECT 1 FROM _prisma_migrations
                  WHERE migration_name = '20260721133200_document_archive_integrity_proof'
                    AND finished_at IS NOT NULL
                    AND rolled_back_at IS NULL
               ) AS "migrationApplied",
               EXISTS (
                 SELECT 1 FROM _prisma_migrations
                  WHERE migration_name = '20260721133300_document_original_retention_fences'
                    AND finished_at IS NOT NULL
                    AND rolled_back_at IS NULL
               ) AS "retentionMigrationApplied"
               ,EXISTS (
                 SELECT 1 FROM _prisma_migrations
                  WHERE migration_name = '20260721133500_document_archive_db_closure'
                    AND finished_at IS NOT NULL
                    AND rolled_back_at IS NULL
               ) AS "dbClosureMigrationApplied",
               EXISTS (
                 SELECT 1 FROM _prisma_migrations
                  WHERE migration_name = '20260721133700_document_archive_customer_scope_fence'
                    AND finished_at IS NOT NULL
                    AND rolled_back_at IS NULL
               ) AS "customerScopeMigrationApplied",
               EXISTS (
                 SELECT 1 FROM _prisma_migrations
                  WHERE migration_name = '20260721133800_document_archive_rollout_protocol'
                    AND finished_at IS NOT NULL
                    AND rolled_back_at IS NULL
               ) AS "rolloutMigrationApplied",
               EXISTS (
                 SELECT 1 FROM _prisma_migrations
                  WHERE migration_name = '20260721134000_legal_storage_object_immutability'
                    AND finished_at IS NOT NULL
                    AND rolled_back_at IS NULL
               ) AS "storageFenceMigrationApplied",
               EXISTS (
                 SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'storage.objects'::regclass
                    AND tgname = 'generated_legal_storage_object_immutable'
                    AND tgenabled = 'O'
               ) AS "storageFenceEnabled",
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
               ) AS "storageFenceHardened",
               EXISTS (
                 SELECT 1 FROM _prisma_migrations
                  WHERE migration_name = '20260721134100_document_archive_private_report'
                    AND finished_at IS NOT NULL
                    AND rolled_back_at IS NULL
               ) AS "privateReportMigrationApplied",
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
               EXISTS (
                 SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'document_archive_jobs'::regclass
                    AND tgname = 'document_archive_jobs_customer_scope_valid'
                    AND tgenabled <> 'D'
               ) AS "scopeTriggerEnabled",
               EXISTS (
                 SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'customers'::regclass
                    AND tgname = 'customers_type_legal_piece_immutable'
                    AND tgenabled <> 'D'
               ) AS "customerTypeTriggerEnabled",
               EXISTS (
                 SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'invoices'::regclass
                    AND tgname = 'invoices_capture_archive_audience'
                    AND tgenabled <> 'D'
               ) AS "invoiceAudienceTriggerEnabled",
               EXISTS (
                 SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'documents'::regclass
                    AND tgname = 'documents_generated_invoice_facturx_scope_valid'
                    AND tgenabled <> 'D'
               ) AS "facturxScopeTriggerEnabled",
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
                 SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'document_archive_protocol_state'::regclass
                    AND tgname = 'document_archive_protocol_monotonicity'
                    AND tgenabled <> 'D'
               ) AS "protocolTriggerEnabled",
               (SELECT count(*)::integer
                  FROM pg_policy
                 WHERE polrelid = 'document_archive_jobs'::regclass
                   AND polcmd = 'a') AS "jobInsertPolicies",
               (SELECT count(*)::integer
                  FROM pg_policy
                 WHERE polrelid = 'document_archive_jobs'::regclass
                   AND polcmd = 'w') AS "jobUpdatePolicies",
               (SELECT count(*)::integer
                  FROM pg_policy
                 WHERE polrelid = 'document_versions'::regclass
                   AND polcmd = 'w') AS "versionUpdatePolicies",
               EXISTS (
                 SELECT 1
                   FROM document_archive_protocol_state AS protocol
                  WHERE protocol.id = 1
                    AND protocol."activeVersion" = 1
               ) AS "expandPoliciesOpen",
               (SELECT count(*)::integer
                  FROM pg_constraint
                 WHERE conrelid = 'document_archive_job_artifacts'::regclass
                   AND contype = 'f') AS "artifactForeignKeys",
               (SELECT count(*)::integer
                  FROM pg_policy
                 WHERE polrelid = 'document_archive_job_artifacts'::regclass
                   AND polcmd <> 'r') AS "artifactMutationPolicies",
               (SELECT relrowsecurity
                  FROM pg_class
                 WHERE oid = 'document_invoice_pdf_attestations'::regclass)
                 AS "attestationRowSecurity",
               (SELECT relforcerowsecurity
                  FROM pg_class
                 WHERE oid = 'document_invoice_pdf_attestations'::regclass)
                 AS "attestationForceRowSecurity",
               (SELECT count(*)::integer
                  FROM pg_constraint
                 WHERE conrelid = 'document_invoice_pdf_attestations'::regclass
                   AND contype = 'f') AS "attestationForeignKeys",
               (SELECT count(*)::integer
                  FROM pg_policy
                 WHERE polrelid = 'document_invoice_pdf_attestations'::regclass
                   AND polcmd = 'r') AS "attestationSelectPolicies",
               (SELECT count(*)::integer
                  FROM pg_policy
                 WHERE polrelid = 'document_invoice_pdf_attestations'::regclass
                   AND polcmd <> 'r') AS "attestationMutationPolicies",
               EXISTS (
                 SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'document_invoice_pdf_attestations'::regclass
                    AND tgname = 'document_invoice_pdf_attestations_immutable'
                    AND tgenabled <> 'D'
               ) AS "attestationTriggerEnabled",
               EXISTS (
                 SELECT 1 FROM pg_policy
                  WHERE polrelid = 'documents'::regclass
                    AND polname = 'generated_invoice_pdf_attestation_select_fence'
                    AND polcmd = 'r'
                    AND NOT polpermissive
               ) AS "documentRepresentationPolicyRestrictive",
               to_regprocedure(
                 'public.document_archive_job_pdf_attestation_v2_is_valid(text,text,text,jsonb)'
               ) IS NOT NULL AS "pdfAttestationValidatorExists",
               (SELECT count(*)::integer
                  FROM pg_proc AS function
                  JOIN pg_namespace AS namespace ON namespace.oid = function.pronamespace
                  CROSS JOIN LATERAL aclexplode(
                    coalesce(function.proacl, acldefault('f', function.proowner))
                  ) AS privilege
                 WHERE namespace.nspname = 'public'
                   AND function.proname IN (
                     'document_archive_job_enqueue_v1',
                     'document_archive_job_enqueue_v2',
                     'document_archive_job_claim_v1',
                     'document_archive_job_fail_v1',
                     'document_archive_job_complete_v1',
                     'document_archive_job_complete_v2',
                     'attest_generated_invoice_pdf_v1',
                     'generated_invoice_pdf_attestation_visible_v2',
                     'document_archive_job_pdf_attestation_v2_is_valid',
                     'generated_legal_archive_representation_v2_is_valid'
                   )
                   AND privilege.grantee = 0
                   AND privilege.privilege_type = 'EXECUTE') AS "publicMutationFunctions"
          FROM pg_class AS table_class
         WHERE table_class.oid = 'document_archive_jobs'::regclass
      `;
      expect(shape).toEqual({
        rowSecurity: true,
        forceRowSecurity: true,
        constraints: 5,
        deletePolicies: 0,
        triggerEnabled: true,
        dueIndex: true,
        leaseIndex: true,
        migrationApplied: true,
        retentionMigrationApplied: true,
        dbClosureMigrationApplied: true,
        customerScopeMigrationApplied: true,
        rolloutMigrationApplied: true,
        storageFenceMigrationApplied: true,
        storageFenceEnabled: true,
        storageFenceHardened: true,
        privateReportMigrationApplied: true,
        evidenceRowSecurity: true,
        evidenceForceRowSecurity: true,
        evidencePolicies: 0,
        exposedEvidenceRolesWithCapabilities: 0,
        exposedProtocolRolesWithMutationCapabilities: 0,
        exposedSettlementRolesWithMutationCapabilities: 0,
        exposedArchiveFunctionsWithExecute: 0,
        scopeTriggerEnabled: true,
        customerTypeTriggerEnabled: true,
        invoiceAudienceTriggerEnabled: true,
        facturxScopeTriggerEnabled: true,
        spoolTriggerEnabled: true,
        generatedLegalCutoverTriggerEnabled: true,
        protocolTriggerEnabled: true,
        jobInsertPolicies: 1,
        jobUpdatePolicies: 1,
        versionUpdatePolicies: 1,
        expandPoliciesOpen: false,
        artifactForeignKeys: 3,
        artifactMutationPolicies: 0,
        attestationRowSecurity: true,
        attestationForceRowSecurity: true,
        attestationForeignKeys: 2,
        attestationSelectPolicies: 1,
        attestationMutationPolicies: 0,
        attestationTriggerEnabled: true,
        documentRepresentationPolicyRestrictive: true,
        pdfAttestationValidatorExists: true,
        publicMutationFunctions: 0,
      });

      await expect(
        admin.documentArchiveProtocolState.findUniqueOrThrow({ where: { id: 1 } }),
      ).resolves.toMatchObject({
        activeVersion: 2,
        activatedAt: expect.any(Date),
        activatedByReleaseSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      });
      await expect(
        admin.documentArchiveProtocolState.update({
          where: { id: 1 },
          data: { activeVersion: 1 },
        }),
      ).rejects.toThrow('document archive protocol cannot be downgraded or rewritten');
      await expect(admin.documentArchiveProtocolState.delete({ where: { id: 1 } })).rejects.toThrow(
        'document archive protocol state is append-only',
      );
    });

    it('interdit au stockage de remplacer ou supprimer un original légal référencé', async () => {
      await expect(admin.$executeRaw`
        UPDATE storage.objects
           SET updated_at = statement_timestamp()
         WHERE bucket_id = 'documents'
           AND name = ${legalDocumentStorageKey}
      `).rejects.toThrow('generated legal storage objects are immutable');
      await expect(admin.$executeRaw`
        DELETE FROM storage.objects
         WHERE bucket_id = 'documents'
           AND name = ${legalDocumentStorageKey}
      `).rejects.toThrow('generated legal storage objects are immutable');
      const [preserved] = await admin.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::integer AS count
          FROM storage.objects
         WHERE bucket_id = 'documents'
           AND name = ${legalDocumentStorageKey}
      `;
      expect(preserved?.count).toBe(1);
    });

    it('fige les originaux sous le rôle runtime tout en conservant les métadonnées éditables', async () => {
      const [posture] = await workers[0]!.$queryRaw<
        Array<{
          documentSelect: boolean;
          documentInsert: boolean;
          documentUpdate: boolean;
          documentDelete: boolean;
          documentTruncate: boolean;
          versionSelect: boolean;
          versionInsert: boolean;
          versionUpdate: boolean;
          versionDelete: boolean;
          versionTruncate: boolean;
        }>
      >`
        SELECT has_table_privilege(current_user, 'documents', 'SELECT') AS "documentSelect",
               has_table_privilege(current_user, 'documents', 'INSERT') AS "documentInsert",
               has_table_privilege(current_user, 'documents', 'UPDATE') AS "documentUpdate",
               has_table_privilege(current_user, 'documents', 'DELETE') AS "documentDelete",
               has_table_privilege(current_user, 'documents', 'TRUNCATE') AS "documentTruncate",
               has_table_privilege(current_user, 'document_versions', 'SELECT') AS "versionSelect",
               has_table_privilege(current_user, 'document_versions', 'INSERT') AS "versionInsert",
               has_table_privilege(current_user, 'document_versions', 'UPDATE') AS "versionUpdate",
               has_table_privilege(current_user, 'document_versions', 'DELETE') AS "versionDelete",
               has_table_privilege(current_user, 'document_versions', 'TRUNCATE') AS "versionTruncate"
      `;
      expect(posture).toEqual({
        documentSelect: true,
        documentInsert: true,
        documentUpdate: true,
        documentDelete: false,
        documentTruncate: false,
        versionSelect: true,
        versionInsert: true,
        versionUpdate: false,
        versionDelete: false,
        versionTruncate: false,
      });

      const [shape] = await admin.$queryRaw<
        Array<{
          documentDeletePolicies: number;
          versionUpdatePolicies: number;
          versionUpdateExpandPolicyIsV1Only: boolean;
          versionDeletePolicies: number;
          documentTrigger: boolean;
          versionTrigger: boolean;
        }>
      >`
        SELECT (SELECT count(*)::integer FROM pg_policy
                 WHERE polrelid = 'documents'::regclass AND polcmd = 'd') AS "documentDeletePolicies",
               (SELECT count(*)::integer FROM pg_policy
                 WHERE polrelid = 'document_versions'::regclass AND polcmd = 'w') AS "versionUpdatePolicies",
               EXISTS (
                 SELECT 1
                   FROM pg_policy
                  WHERE polrelid = 'document_versions'::regclass
                    AND polcmd = 'w'
                    AND polname = 'tenant_document_version_update_expand'
                    AND pg_get_expr(polqual, polrelid) LIKE '%protocol."activeVersion" = 1%'
                    AND pg_get_expr(polwithcheck, polrelid) LIKE '%protocol."activeVersion" = 1%'
               ) AS "versionUpdateExpandPolicyIsV1Only",
               (SELECT count(*)::integer FROM pg_policy
                 WHERE polrelid = 'document_versions'::regclass AND polcmd = 'd') AS "versionDeletePolicies",
               EXISTS (SELECT 1 FROM pg_trigger
                        WHERE tgrelid = 'documents'::regclass
                          AND tgname = 'documents_original_facts_immutable'
                          AND tgenabled <> 'D') AS "documentTrigger",
               EXISTS (SELECT 1 FROM pg_trigger
                        WHERE tgrelid = 'document_versions'::regclass
                          AND tgname = 'document_versions_immutable'
                          AND tgenabled <> 'D') AS "versionTrigger"
      `;
      expect(shape).toEqual({
        documentDeletePolicies: 0,
        // La policy expand reste déployée pour rendre N-1 compatible pendant le train, mais
        // elle est inerte après le flip V2 et l'ACL UPDATE a déjà été retirée ci-dessus.
        versionUpdatePolicies: 1,
        versionUpdateExpandPolicyIsV1Only: true,
        versionDeletePolicies: 0,
        documentTrigger: true,
        versionTrigger: true,
      });

      await expect(
        workers[0]!.withTenant(companyA, (tx) =>
          tx.storedDocument.updateMany({
            where: { id: legalDocumentId, companyId: companyA, revision: 1 },
            data: { displayName: 'Facture juillet', revision: 2 },
          }),
        ),
      ).resolves.toMatchObject({ count: 1 });

      await expect(
        workers[0]!.withTenant(
          companyA,
          (tx) => tx.$executeRaw`
        UPDATE documents SET sha256 = ${'d'.repeat(64)} WHERE id = ${legalDocumentId}
      `,
        ),
      ).rejects.toThrow('document original facts are immutable');
      await expect(
        workers[0]!.withTenant(
          companyA,
          (tx) => tx.$executeRaw`
        UPDATE documents SET status = 'deleted'::"StoredDocumentStatus", "deletedAt" = now()
         WHERE id = ${legalDocumentId}
      `,
        ),
      ).rejects.toThrow('legal document archive facts are immutable');
      await expect(
        workers[0]!.withTenant(companyA, (tx) =>
          tx.storedDocument.deleteMany({ where: { id: legalDocumentId, companyId: companyA } }),
        ),
      ).rejects.toThrow();
      await expect(
        workers[0]!.withTenant(
          companyA,
          (tx) => tx.$executeRaw`
        UPDATE document_versions SET sha256 = ${'e'.repeat(64)} WHERE id = ${legalDocumentVersionId}
      `,
        ),
      ).rejects.toThrow();
      // Le trigger reste compatible avec un retry N-1 strictement identique, mais l'ACL active
      // V2 retire UPDATE au runtime : seul DIRECT_URL peut encore exercer ce no-op de preuve.
      await expect(
        admin.storedDocumentVersion.update({
          where: { id: legalDocumentVersionId },
          data: {
            storageKey: `companies/${companyA}/documents/${legalDocumentId}/v1/${legalDocumentSha256}.pdf`,
            sha256: legalDocumentSha256,
            mimeType: 'application/pdf',
            byteSize: 42,
            reason: 'invoice-issued',
          },
        }),
      ).resolves.toMatchObject({ id: legalDocumentVersionId, sha256: legalDocumentSha256 });
      await expect(
        admin.storedDocumentVersion.update({
          where: { id: legalDocumentVersionId },
          data: { sha256: 'e'.repeat(64) },
        }),
      ).rejects.toThrow('document versions are immutable');
      await expect(
        workers[0]!.withTenant(companyA, (tx) =>
          tx.storedDocumentVersion.deleteMany({ where: { id: legalDocumentVersionId } }),
        ),
      ).rejects.toThrow();
      await expect(
        workers[0]!.withTenant(companyA, (tx) =>
          tx.quote.deleteMany({
            where: { id: signedQuoteId, companyId: companyA },
          }),
        ),
      ).rejects.toThrow();

      await expect(
        admin.storedDocument.findUnique({ where: { id: legalDocumentId } }),
      ).resolves.toMatchObject({
        displayName: 'Facture juillet',
        revision: 2,
        sha256: legalDocumentSha256,
        status: 'active',
      });
    });

    it('isole deux tenants et rend toute collision d’enqueue explicite', async () => {
      const repository = new PrismaDocumentArchiveJobRepository(workers[0]!);
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.enqueue({
            id: randomUUID(),
            companyId: companyA,
            pieceId: signedQuoteId,
            reason: 'quote-signed',
            now: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeUndefined();
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.findByPiece(companyA, signedQuoteId, 'quote-signed'),
        ),
      ).resolves.toMatchObject({ pieceId: signedQuoteId, reason: 'quote-signed' });

      const id = randomUUID();
      const pieceId = `piece-${randomUUID()}`;
      await seedIssuedInvoice(companyA, pieceId);
      await workers[0]!.withTenant(companyA, () =>
        repository.enqueue({
          id,
          companyId: companyA,
          pieceId,
          reason: 'invoice-issued',
          now: new Date(Date.now() - 1_000).toISOString(),
        }),
      );
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.enqueue({
            id: randomUUID(),
            companyId: companyA,
            pieceId,
            reason: 'invoice-issued',
            now: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeUndefined();
      await seedIssuedInvoice(companyA, `${pieceId}-collision`);
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.enqueue({
            id,
            companyId: companyA,
            pieceId: `${pieceId}-collision`,
            reason: 'invoice-issued',
            now: new Date().toISOString(),
          }),
        ),
      ).rejects.toThrow('identity conflict');

      const otherRepository = new PrismaDocumentArchiveJobRepository(workers[1]!);
      const otherPiece = `piece-${randomUUID()}`;
      await seedIssuedInvoice(companyB, otherPiece);
      await workers[1]!.withTenant(companyB, () =>
        otherRepository.enqueue({
          id: randomUUID(),
          companyId: companyB,
          pieceId: otherPiece,
          reason: 'invoice-issued',
          now: new Date(Date.now() - 1_000).toISOString(),
        }),
      );
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.findByPiece(companyB, otherPiece, 'invoice-issued'),
        ),
      ).resolves.toBeNull();
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.enqueue({
            id: randomUUID(),
            companyId: companyB,
            pieceId: `cross-${randomUUID()}`,
            reason: 'invoice-issued',
            now: new Date().toISOString(),
          }),
        ),
      ).rejects.toThrow();
    });

    it('interdit le done SQL forgé et ne clôture qu’après liaison exacte aux originaux', async () => {
      const id = randomUUID();
      const pieceId = `db-proof-${randomUUID()}`;
      await seedIssuedInvoice(companyA, pieceId);
      const repository = new PrismaDocumentArchiveJobRepository(workers[0]!);
      await workers[0]!.withTenant(companyA, () =>
        repository.enqueue({
          id,
          companyId: companyA,
          pieceId,
          reason: 'invoice-issued',
          now: '2099-01-01T00:00:00.000Z',
        }),
      );
      const candidate = await workers[0]!.withTenant(companyA, () =>
        repository.findByPiece(companyA, pieceId, 'invoice-issued'),
      );
      if (candidate === null) throw new Error('job de preuve DB absent');
      const leaseToken = randomUUID();
      const claimed = await workers[0]!.withTenant(companyA, () =>
        repository.claimForArchive(
          id,
          companyA,
          candidate.updatedAt,
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
          leaseToken,
        ),
      );
      expect(claimed.outcome).toBe('claimed');

      const proof = invoiceProof(companyA, pieceId);
      const digest = documentArchiveIntegrityProofSha256(proof);
      // Un JSON bien formé ne suffit pas : sans lignes document/version exactes, la capacité
      // transactionnelle refuse la clôture et ne laisse aucun artefact partiel.
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.markDone(id, companyA, leaseToken, proof, digest, new Date().toISOString()),
        ),
      ).resolves.toBe(false);
      await expect(admin.documentArchiveJobArtifact.count({ where: { jobId: id } })).resolves.toBe(
        0,
      );

      await seedProofArtifacts(proof);
      const falselyPlainProfessionalProof = structuredClone(proof);
      const professionalPdf = falselyPlainProfessionalProof.artifacts.find(
        (artifact) => artifact.kind === 'invoice_pdf',
      );
      if (professionalPdf === undefined) throw new Error('artefact PDF professionnel absent');
      professionalPdf.contentProfile = 'plain_pdf';
      const [wrongProfessionalProfile] = await admin.$queryRaw<Array<{ valid: boolean }>>`
        SELECT public.document_archive_integrity_proof_for_reason_v2_is_valid(
          ${companyA},
          ${pieceId},
          ${proof.reason},
          ${JSON.stringify(falselyPlainProfessionalProof)}::jsonb
        ) AS valid
      `;
      expect(wrongProfessionalProfile?.valid).toBe(false);
      const [wrongDigest] = await workers[0]!.withTenant(
        companyA,
        (tx) => tx.$queryRaw<Array<{ accepted: boolean }>>`
        SELECT public.document_archive_job_complete_v2(
          ${id}, ${companyA}, ${leaseToken}, ${JSON.stringify(proof)}::jsonb, ${'f'.repeat(64)}
        ) AS accepted
      `,
      );
      expect(wrongDigest?.accepted).toBe(false);

      // Même si une future ACL de table dérive, le certificat actuel exige zéro mutation SQL
      // directe sous le rôle runtime : seul EXECUTE sur les capacités bornées subsiste.
      await expect(
        workers[0]!.withTenant(
          companyA,
          (tx) => tx.$executeRaw`
        UPDATE document_archive_jobs
           SET status = 'done'::"DocumentArchiveJobStatus",
               "integrityProof" = ${JSON.stringify(proof)}::jsonb,
               "integrityProofSha256" = ${digest},
               "completedAt" = statement_timestamp()
         WHERE id = ${id}
      `,
        ),
      ).rejects.toThrow();

      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.markDone(id, companyA, leaseToken, proof, digest, new Date().toISOString()),
        ),
      ).resolves.toBe(true);
      await expect(
        workers[0]!.withTenant(companyA, (tx) =>
          tx.documentArchiveJobArtifact.findMany({ where: { jobId: id, companyId: companyA } }),
        ),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'invoice_pdf',
            contentProfile: 'facturx_pdfa3',
            sha256: 'a'.repeat(64),
          }),
          expect.objectContaining({
            kind: 'facturx_xml',
            contentProfile: 'facturx_xml',
            sha256: 'b'.repeat(64),
          }),
        ]),
      );
    });

    it('fige explicitement le périmètre PDF seul B2C sans inventer de Flux 2', async () => {
      const id = randomUUID();
      const pieceId = `b2c-pdf-${randomUUID()}`;
      await seedIssuedInvoice(companyA, pieceId, 'b2c');
      const repository = new PrismaDocumentArchiveJobRepository(workers[0]!);
      await workers[0]!.withTenant(companyA, () =>
        repository.enqueue({
          id,
          companyId: companyA,
          pieceId,
          reason: 'invoice-issued-pdf-only-b2c',
          now: new Date().toISOString(),
        }),
      );
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.enqueue({
            id: randomUUID(),
            companyId: companyA,
            pieceId,
            reason: 'invoice-issued',
            now: new Date().toISOString(),
          }),
        ),
      ).rejects.toThrow('document archive reason does not match');
      const candidate = await workers[0]!.withTenant(companyA, () =>
        repository.findByPiece(companyA, pieceId, 'invoice-issued-pdf-only-b2c'),
      );
      if (candidate === null) throw new Error('job PDF seul absent');
      const leaseToken = randomUUID();
      const claimed = await workers[0]!.withTenant(companyA, () =>
        repository.claimForArchive(
          id,
          companyA,
          candidate.updatedAt,
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
          leaseToken,
        ),
      );
      expect(claimed.outcome).toBe('claimed');
      const proof = pdfOnlyInvoiceProof(companyA, pieceId);
      await seedProofArtifacts(proof);
      const falselyHybridConsumerProof = structuredClone(proof);
      const consumerPdf = falselyHybridConsumerProof.artifacts[0];
      if (consumerPdf === undefined) throw new Error('artefact PDF consommateur absent');
      consumerPdf.contentProfile = 'facturx_pdfa3';
      const [wrongConsumerProfile] = await admin.$queryRaw<Array<{ valid: boolean }>>`
        SELECT public.document_archive_integrity_proof_for_reason_v2_is_valid(
          ${companyA},
          ${pieceId},
          ${proof.reason},
          ${JSON.stringify(falselyHybridConsumerProof)}::jsonb
        ) AS valid
      `;
      expect(wrongConsumerProfile?.valid).toBe(false);
      const [databaseProof] = await admin.$queryRaw<
        Array<{
          valid: boolean;
          digest: string;
        }>
      >`
        SELECT public.document_archive_integrity_proof_for_reason_v2_is_valid(
                 ${companyA}, ${pieceId}, ${proof.reason}, ${JSON.stringify(proof)}::jsonb
               ) AS valid,
               public.document_archive_integrity_proof_v1_sha256(
                 ${JSON.stringify(proof)}::jsonb
               ) AS digest
      `;
      expect(databaseProof).toEqual({
        valid: true,
        digest: documentArchiveIntegrityProofSha256(proof),
      });
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.markDone(
            id,
            companyA,
            leaseToken,
            proof,
            documentArchiveIntegrityProofSha256(proof),
            new Date().toISOString(),
          ),
        ),
      ).resolves.toBe(true);
      await expect(
        admin.documentArchiveJobArtifact.findMany({ where: { jobId: id } }),
      ).resolves.toEqual([
        expect.objectContaining({
          kind: 'invoice_pdf',
          contentProfile: 'plain_pdf',
          companyId: companyA,
        }),
      ]);
    });

    it('atteste les octets PDF, masque tout original non attesté et ferme les croisements tenant/profil', async () => {
      const consumerInvoiceId = `archive-attestation-consumer-${randomUUID()}`;
      const professionalInvoiceId = `archive-attestation-professional-${randomUUID()}`;
      const publicInvoiceId = `archive-attestation-public-${randomUUID()}`;
      await seedIssuedInvoice(companyA, consumerInvoiceId, 'b2c');
      await seedIssuedInvoice(companyA, professionalInvoiceId, 'b2b');
      await seedIssuedInvoice(companyA, publicInvoiceId, 'b2g');

      const rejectedHybridConsumerId = `archive-hybrid-consumer-${randomUUID()}`;
      await expect(
        admin.$transaction(async (tx) => {
          const { versionId } = await seedGeneratedInvoicePdf(tx, {
            documentId: rejectedHybridConsumerId,
            invoiceId: consumerInvoiceId,
            reason: 'invoice-issued-pdf-only-b2c',
            sha256: '1'.repeat(64),
          });
          await expect(
            attestInvoicePdf(tx, {
              companyId: companyA,
              documentId: rejectedHybridConsumerId,
              versionId,
              documentSha256: '1'.repeat(64),
              profile: 'facturx_pdfa3',
              embeddedXmlSha256: '2'.repeat(64),
            }),
          ).resolves.toBe(false);
        }),
      ).rejects.toThrow('generated legal archive representation is invalid for V2');
      await expect(
        admin.storedDocument.findUnique({
          where: { id: rejectedHybridConsumerId },
        }),
      ).resolves.toBeNull();

      const rejectedPlainProfessionalId = `archive-plain-professional-${randomUUID()}`;
      await expect(
        admin.$transaction(async (tx) => {
          const { versionId } = await seedGeneratedInvoicePdf(tx, {
            documentId: rejectedPlainProfessionalId,
            invoiceId: professionalInvoiceId,
            reason: 'invoice-issued',
            sha256: '3'.repeat(64),
          });
          await expect(
            attestInvoicePdf(tx, {
              companyId: companyA,
              documentId: rejectedPlainProfessionalId,
              versionId,
              documentSha256: '3'.repeat(64),
              profile: 'plain_pdf',
              embeddedXmlSha256: null,
            }),
          ).resolves.toBe(false);
        }),
      ).rejects.toThrow('generated legal archive representation is invalid for V2');

      // Fixture privilégiée d'un writer ancien : elle contourne uniquement les deux constraint
      // triggers de représentation, sous verrous exclusifs. La RLS active doit alors masquer le
      // PDF jusqu'à ce que le détecteur byte-derived pose son attestation exacte.
      const initiallyUnattestedId = `archive-unattested-consumer-${randomUUID()}`;
      const initiallyUnattestedSha = '4'.repeat(64);
      let initiallyUnattestedVersionId = '';
      await admin.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE public.documents IN ACCESS EXCLUSIVE MODE');
        await tx.$executeRawUnsafe('LOCK TABLE public.document_versions IN ACCESS EXCLUSIVE MODE');
        await tx.$executeRawUnsafe(
          'ALTER TABLE public.documents DISABLE TRIGGER ' +
            'documents_generated_legal_archive_representation_v2',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE public.document_versions DISABLE TRIGGER ' +
            'document_versions_generated_legal_archive_representation_v2',
        );
        ({ versionId: initiallyUnattestedVersionId } = await seedGeneratedInvoicePdf(tx, {
          documentId: initiallyUnattestedId,
          invoiceId: consumerInvoiceId,
          reason: 'invoice-issued-pdf-only-b2c',
          sha256: initiallyUnattestedSha,
        }));
        await tx.$executeRawUnsafe(
          'ALTER TABLE public.document_versions ENABLE TRIGGER ' +
            'document_versions_generated_legal_archive_representation_v2',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE public.documents ENABLE TRIGGER ' +
            'documents_generated_legal_archive_representation_v2',
        );
      });
      await expect(
        workers[0]!.withTenant(companyA, (tx) =>
          tx.storedDocument.findUnique({
            where: { id: initiallyUnattestedId },
          }),
        ),
      ).resolves.toBeNull();
      await expect(
        admin.storedDocument.findUnique({ where: { id: initiallyUnattestedId } }),
      ).resolves.toMatchObject({ id: initiallyUnattestedId });

      await admin.$transaction(async (tx) => {
        await expect(
          attestInvoicePdf(tx, {
            companyId: companyA,
            documentId: initiallyUnattestedId,
            versionId: initiallyUnattestedVersionId,
            documentSha256: '5'.repeat(64),
            profile: 'plain_pdf',
            embeddedXmlSha256: null,
          }),
        ).resolves.toBe(false);
        await expect(
          attestInvoicePdf(tx, {
            companyId: companyA,
            documentId: initiallyUnattestedId,
            versionId: initiallyUnattestedVersionId,
            documentSha256: initiallyUnattestedSha,
            profile: 'plain_pdf',
            embeddedXmlSha256: null,
          }),
        ).resolves.toBe(true);
        // Rejeu exact idempotent : aucun second fait juridique n'est créé.
        await expect(
          attestInvoicePdf(tx, {
            companyId: companyA,
            documentId: initiallyUnattestedId,
            versionId: initiallyUnattestedVersionId,
            documentSha256: initiallyUnattestedSha,
            profile: 'plain_pdf',
            embeddedXmlSha256: null,
          }),
        ).resolves.toBe(true);
      });
      await expect(
        workers[0]!.withTenant(companyA, (tx) =>
          tx.storedDocument.findUnique({
            where: { id: initiallyUnattestedId },
          }),
        ),
      ).resolves.toMatchObject({ id: initiallyUnattestedId });

      const professionalDocumentId = `archive-hybrid-professional-${randomUUID()}`;
      const professionalSha = '6'.repeat(64);
      const professionalEmbeddedXmlSha = '7'.repeat(64);
      let professionalVersionId = '';
      await admin.$transaction(async (tx) => {
        ({ versionId: professionalVersionId } = await seedGeneratedInvoicePdf(tx, {
          documentId: professionalDocumentId,
          invoiceId: professionalInvoiceId,
          reason: 'invoice-issued',
          sha256: professionalSha,
        }));
        await expect(
          attestInvoicePdf(tx, {
            companyId: companyA,
            documentId: professionalDocumentId,
            versionId: professionalVersionId,
            documentSha256: professionalSha,
            profile: 'facturx_pdfa3',
            embeddedXmlSha256: professionalEmbeddedXmlSha,
          }),
        ).resolves.toBe(true);
      });

      const publicDocumentId = `archive-hybrid-public-${randomUUID()}`;
      await admin.$transaction(async (tx) => {
        const { versionId } = await seedGeneratedInvoicePdf(tx, {
          documentId: publicDocumentId,
          invoiceId: publicInvoiceId,
          reason: 'invoice-issued',
          sha256: '8'.repeat(64),
        });
        await expect(
          attestInvoicePdf(tx, {
            companyId: companyA,
            documentId: publicDocumentId,
            versionId,
            documentSha256: '8'.repeat(64),
            profile: 'facturx_pdfa3',
            embeddedXmlSha256: '9'.repeat(64),
          }),
        ).resolves.toBe(true);
      });

      // Les deux FK composites portent chacune une partie de l'identité tenant-scopée. Même
      // DIRECT_URL ne peut greffer une attestation sur le document d'un autre tenant, ni associer
      // la version d'un autre document. Le SHA exact est, lui, contrôlé par la capacité ci-dessus.
      const fkDocumentA = `archive-attestation-fk-a-${randomUUID()}`;
      const fkDocumentB = `archive-attestation-fk-b-${randomUUID()}`;
      const seedFkDocument = async (documentId: string, sha256: string): Promise<string> => {
        const versionId = `${documentId}-v1`;
        const storageKey = `companies/${companyA}/documents/${documentId}/v1/${sha256}`;
        await admin.storedDocument.create({
          data: {
            id: documentId,
            companyId: companyA,
            kind: 'other',
            origin: 'uploaded',
            status: 'active',
            filename: `${documentId}.bin`,
            mimeType: 'application/octet-stream',
            byteSize: 42,
            sha256,
            storageKey,
            linkedEntityType: 'company',
            linkedEntityId: companyA,
            createdAt: new Date('2026-07-21T10:00:00.000Z'),
            retentionUntil: '2036-07-21',
            versions: {
              create: {
                id: versionId,
                version: 1,
                storageKey,
                sha256,
                mimeType: 'application/octet-stream',
                byteSize: 42,
                createdAt: new Date('2026-07-21T10:00:00.000Z'),
                reason: 'initial-upload',
              },
            },
          },
        });
        return versionId;
      };
      const fkVersionA = await seedFkDocument(fkDocumentA, 'd'.repeat(64));
      const fkVersionB = await seedFkDocument(fkDocumentB, 'e'.repeat(64));
      await expect(
        admin.documentInvoicePdfAttestation.create({
          data: {
            companyId: companyB,
            documentId: fkDocumentA,
            versionId: fkVersionA,
            documentSha256: 'd'.repeat(64),
            profile: 'plain_pdf',
            embeddedXmlSha256: null,
            detectorVersion: 1,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      await expect(
        admin.documentInvoicePdfAttestation.create({
          data: {
            companyId: companyA,
            documentId: fkDocumentA,
            versionId: fkVersionB,
            documentSha256: 'd'.repeat(64),
            profile: 'plain_pdf',
            embeddedXmlSha256: null,
            detectorVersion: 1,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      await expect(
        admin.documentInvoicePdfAttestation.count({
          where: { documentId: { in: [fkDocumentA, fkDocumentB] } },
        }),
      ).resolves.toBe(0);

      await expect(
        workers[0]!.withTenant(
          companyB,
          (tx) => tx.$queryRaw<Array<{ visible: boolean }>>`
        SELECT public.generated_invoice_pdf_attestation_visible_v2(
          ${companyA}, ${professionalDocumentId}
        ) AS visible
      `,
        ),
      ).resolves.toEqual([{ visible: false }]);
      await expect(
        workers[0]!.withTenant(companyB, (tx) =>
          tx.documentInvoicePdfAttestation.findMany({
            where: { documentId: professionalDocumentId },
          }),
        ),
      ).resolves.toEqual([]);
      await expect(
        workers[0]!.withTenant(companyA, (tx) =>
          tx.documentInvoicePdfAttestation.create({
            data: {
              companyId: companyA,
              documentId: professionalDocumentId,
              versionId: professionalVersionId,
              documentSha256: professionalSha,
              profile: 'facturx_pdfa3',
              embeddedXmlSha256: professionalEmbeddedXmlSha,
              detectorVersion: 1,
            },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        admin.documentInvoicePdfAttestation.update({
          where: {
            document_invoice_pdf_attestations_pkey: {
              documentId: professionalDocumentId,
              versionId: professionalVersionId,
            },
          },
          data: { detectorVersion: 1 },
        }),
      ).rejects.toThrow('invoice PDF attestations are immutable');
      await expect(
        admin.documentInvoicePdfAttestation.delete({
          where: {
            document_invoice_pdf_attestations_pkey: {
              documentId: professionalDocumentId,
              versionId: professionalVersionId,
            },
          },
        }),
      ).rejects.toThrow('invoice PDF attestations are immutable');
    }, 30_000);

    it('ne limite jamais à une seule version les documents utilisateur hors archive légale', async () => {
      const documentId = `archive-non-legal-multiversion-${randomUUID()}`;
      const firstSha = 'a'.repeat(64);
      const secondSha = 'b'.repeat(64);
      await admin.storedDocument.create({
        data: {
          id: documentId,
          companyId: companyA,
          kind: 'other',
          origin: 'uploaded',
          status: 'active',
          filename: 'contrat-source.bin',
          mimeType: 'application/octet-stream',
          byteSize: 42,
          sha256: firstSha,
          storageKey: `companies/${companyA}/documents/${documentId}/v1/${firstSha}`,
          linkedEntityType: 'company',
          linkedEntityId: companyA,
          createdAt: new Date('2026-07-21T10:00:00.000Z'),
          retentionUntil: '2036-07-21',
          versions: {
            create: {
              id: `${documentId}-v1`,
              version: 1,
              storageKey: `companies/${companyA}/documents/${documentId}/v1/${firstSha}`,
              sha256: firstSha,
              mimeType: 'application/octet-stream',
              byteSize: 42,
              createdAt: new Date('2026-07-21T10:00:00.000Z'),
              reason: 'initial-upload',
            },
          },
        },
      });

      await expect(
        admin.storedDocumentVersion.create({
          data: {
            id: `${documentId}-v2`,
            documentId,
            version: 2,
            storageKey: `companies/${companyA}/documents/${documentId}/v2/${secondSha}`,
            sha256: secondSha,
            mimeType: 'application/octet-stream',
            byteSize: 43,
            createdAt: new Date('2026-07-21T11:00:00.000Z'),
            reason: 'user-revision',
          },
        }),
      ).resolves.toMatchObject({ documentId, version: 2, sha256: secondSha });
      await expect(admin.storedDocumentVersion.count({ where: { documentId } })).resolves.toBe(2);
    });

    it('corrèle le XML embarqué au Flux 2 séparé pour B2B/B2G avant toute clôture', async () => {
      const repository = new PrismaDocumentArchiveJobRepository(workers[0]!);
      const mismatchedPieceId = `archive-embedded-xml-mismatch-${randomUUID()}`;
      const mismatchedJobId = randomUUID();
      await seedIssuedInvoice(companyA, mismatchedPieceId, 'b2b');
      await workers[0]!.withTenant(companyA, () =>
        repository.enqueue({
          id: mismatchedJobId,
          companyId: companyA,
          pieceId: mismatchedPieceId,
          reason: 'invoice-issued',
          now: new Date().toISOString(),
        }),
      );
      const mismatchedCandidate = await workers[0]!.withTenant(companyA, () =>
        repository.findByPiece(companyA, mismatchedPieceId, 'invoice-issued'),
      );
      if (mismatchedCandidate === null) throw new Error('job mismatch XML absent');
      const mismatchedToken = randomUUID();
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.claimForArchive(
            mismatchedJobId,
            companyA,
            mismatchedCandidate.updatedAt,
            new Date().toISOString(),
            new Date(Date.now() + 60_000).toISOString(),
            mismatchedToken,
          ),
        ),
      ).resolves.toMatchObject({ outcome: 'claimed' });
      const mismatchedProof = invoiceProof(companyA, mismatchedPieceId);
      await seedProofArtifacts(mismatchedProof, { embeddedXmlSha256: 'c'.repeat(64) });
      const [mismatchedValidity] = await admin.$queryRaw<Array<{ valid: boolean }>>`
        SELECT public.document_archive_job_pdf_attestation_v2_is_valid(
          ${companyA},
          ${mismatchedPieceId},
          ${mismatchedProof.reason},
          ${JSON.stringify(mismatchedProof)}::jsonb
        ) AS valid
      `;
      expect(mismatchedValidity?.valid).toBe(false);
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.markDone(
            mismatchedJobId,
            companyA,
            mismatchedToken,
            mismatchedProof,
            documentArchiveIntegrityProofSha256(mismatchedProof),
            new Date().toISOString(),
          ),
        ),
      ).resolves.toBe(false);
      await expect(
        admin.documentArchiveJobArtifact.count({ where: { jobId: mismatchedJobId } }),
      ).resolves.toBe(0);

      const publicPieceId = `archive-embedded-xml-public-${randomUUID()}`;
      const publicJobId = randomUUID();
      await seedIssuedInvoice(companyA, publicPieceId, 'b2g');
      await workers[0]!.withTenant(companyA, () =>
        repository.enqueue({
          id: publicJobId,
          companyId: companyA,
          pieceId: publicPieceId,
          reason: 'invoice-issued',
          now: new Date().toISOString(),
        }),
      );
      const publicCandidate = await workers[0]!.withTenant(companyA, () =>
        repository.findByPiece(companyA, publicPieceId, 'invoice-issued'),
      );
      if (publicCandidate === null) throw new Error('job B2G XML absent');
      const publicToken = randomUUID();
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.claimForArchive(
            publicJobId,
            companyA,
            publicCandidate.updatedAt,
            new Date().toISOString(),
            new Date(Date.now() + 60_000).toISOString(),
            publicToken,
          ),
        ),
      ).resolves.toMatchObject({ outcome: 'claimed' });
      const publicProof = invoiceProof(companyA, publicPieceId);
      await seedProofArtifacts(publicProof);
      const [publicValidity] = await admin.$queryRaw<Array<{ valid: boolean }>>`
        SELECT public.document_archive_job_pdf_attestation_v2_is_valid(
          ${companyA},
          ${publicPieceId},
          ${publicProof.reason},
          ${JSON.stringify(publicProof)}::jsonb
        ) AS valid
      `;
      expect(publicValidity?.valid).toBe(true);
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.markDone(
            publicJobId,
            companyA,
            publicToken,
            publicProof,
            documentArchiveIntegrityProofSha256(publicProof),
            new Date().toISOString(),
          ),
        ),
      ).resolves.toBe(true);
    }, 30_000);

    it('interdit physiquement tout XML Factur-X consommateur et conserve le chemin professionnel', async () => {
      const professionalInvoiceId = `archive-active-xml-pro-${randomUUID()}`;
      const consumerInvoiceId = `archive-active-xml-consumer-${randomUUID()}`;
      await seedIssuedInvoice(companyA, professionalInvoiceId, 'b2b');
      await seedIssuedInvoice(companyA, consumerInvoiceId, 'b2c');

      const documentData = (id: string, invoiceId: string, withVersion = false) => ({
        id,
        companyId: companyA,
        kind: 'facturx_xml' as const,
        origin: 'generated' as const,
        status: 'active' as const,
        filename: `${id}.xml`,
        mimeType: 'application/xml',
        byteSize: 84,
        sha256: 'd'.repeat(64),
        storageKey: `companies/${companyA}/documents/${id}/v1/${'d'.repeat(64)}`,
        linkedEntityType: 'invoice' as const,
        linkedEntityId: invoiceId,
        issuedAt: '2026-07-21',
        createdAt: new Date('2026-07-21T10:00:00.000Z'),
        retentionUntil: '2036-07-21',
        ...(withVersion
          ? {
              versions: {
                create: {
                  id: `${id}-v1`,
                  version: 1,
                  storageKey: `companies/${companyA}/documents/${id}/v1/${'d'.repeat(64)}`,
                  sha256: 'd'.repeat(64),
                  mimeType: 'application/xml',
                  byteSize: 84,
                  createdAt: new Date('2026-07-21T10:00:00.000Z'),
                  reason: 'invoice-issued',
                },
              },
            }
          : {}),
      });

      await expect(
        workers[0]!.withTenant(companyA, (tx) =>
          tx.storedDocument.create({
            data: documentData(
              `archive-active-xml-consumer-runtime-${randomUUID()}`,
              consumerInvoiceId,
            ),
          }),
        ),
      ).rejects.toThrow(
        'generated Factur-X XML requires a professional audience frozen at invoice issuance',
      );
      await expect(
        admin.storedDocument.create({
          data: documentData(
            `archive-active-xml-consumer-direct-${randomUUID()}`,
            consumerInvoiceId,
          ),
        }),
      ).rejects.toThrow(
        'generated Factur-X XML requires a professional audience frozen at invoice issuance',
      );

      const professionalDocumentId = `archive-active-xml-professional-${randomUUID()}`;
      await expect(
        workers[0]!.withTenant(companyA, (tx) =>
          tx.storedDocument.create({
            data: documentData(professionalDocumentId, professionalInvoiceId, true),
          }),
        ),
      ).resolves.toMatchObject({
        id: professionalDocumentId,
        linkedEntityId: professionalInvoiceId,
      });
      await expect(
        admin.storedDocument.update({
          where: { id: professionalDocumentId },
          data: { linkedEntityId: consumerInvoiceId },
        }),
      ).rejects.toThrow(
        'generated Factur-X XML requires a professional audience frozen at invoice issuance',
      );
    });

    it('fige l’audience émise et refuse en base les croisements B2C/B2B/B2G', async () => {
      const repository = new PrismaDocumentArchiveJobRepository(workers[0]!);
      const b2bPieceId = `scope-b2b-${randomUUID()}`;
      const b2cPieceId = `scope-b2c-${randomUUID()}`;
      const b2gPieceId = `scope-b2g-${randomUUID()}`;
      await seedIssuedInvoice(companyA, b2bPieceId, 'b2b');
      await seedIssuedInvoice(companyA, b2cPieceId, 'b2c');
      await seedIssuedInvoice(companyA, b2gPieceId, 'b2g');

      await expect(
        admin.invoice.findMany({
          where: { id: { in: [b2bPieceId, b2cPieceId, b2gPieceId] } },
          orderBy: { id: 'asc' },
          select: { id: true, archiveAudienceAtIssuance: true },
        }),
      ).resolves.toEqual(
        expect.arrayContaining([
          { id: b2bPieceId, archiveAudienceAtIssuance: 'professional' },
          { id: b2cPieceId, archiveAudienceAtIssuance: 'consumer' },
          { id: b2gPieceId, archiveAudienceAtIssuance: 'professional' },
        ]),
      );

      // Le trigger est une seconde frontière indépendante des fonctions SECURITY DEFINER.
      await expect(
        admin.documentArchiveJob.create({
          data: {
            id: randomUUID(),
            companyId: companyA,
            invoiceId: b2bPieceId,
            reason: 'invoice-issued-pdf-only-b2c',
            nextAttemptAt: new Date(),
          },
        }),
      ).rejects.toThrow('document archive reason does not match');
      await expect(
        admin.documentArchiveJob.create({
          data: {
            id: randomUUID(),
            companyId: companyA,
            invoiceId: b2cPieceId,
            reason: 'invoice-issued',
            nextAttemptAt: new Date(),
          },
        }),
      ).rejects.toThrow('document archive reason does not match');

      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.enqueue({
            id: randomUUID(),
            companyId: companyA,
            pieceId: b2bPieceId,
            reason: 'invoice-issued-pdf-only-b2c',
            now: new Date().toISOString(),
          }),
        ),
      ).rejects.toThrow();
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.enqueue({
            id: randomUUID(),
            companyId: companyA,
            pieceId: b2gPieceId,
            reason: 'invoice-issued',
            now: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeUndefined();

      await expect(
        admin.invoice.update({
          where: { id: b2bPieceId },
          data: { archiveAudienceAtIssuance: 'consumer' },
        }),
      ).rejects.toThrow('invoice archive audience is immutable after issuance');
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.enqueue({
            id: randomUUID(),
            companyId: companyA,
            pieceId: b2cPieceId,
            reason: 'invoice-issued',
            now: new Date().toISOString(),
          }),
        ),
      ).rejects.toThrow();

      await expect(
        admin.customer.update({
          where: { id: customerId(companyA) },
          data: { type: 'b2c' },
        }),
      ).rejects.toThrow();
      await expect(
        admin.customer.update({
          where: { id: b2cCustomerId(companyA) },
          data: { type: 'b2b' },
        }),
      ).rejects.toThrow();
      await expect(
        admin.customer.update({
          where: { id: b2gCustomerId(companyA) },
          data: { type: 'b2c' },
        }),
      ).rejects.toThrow();

      await expect(
        admin.customer.findUnique({ where: { id: customerId(companyA) } }),
      ).resolves.toEqual(expect.objectContaining({ type: 'b2b' }));
      await expect(
        admin.customer.findUnique({ where: { id: b2cCustomerId(companyA) } }),
      ).resolves.toEqual(expect.objectContaining({ type: 'b2c' }));
    });

    it('sérialise émission et mutation client sans jamais produire un scope historique incohérent', async () => {
      const concurrentCustomerId = `archive-race-customer-${randomUUID()}`;
      const concurrentInvoiceId = `archive-race-invoice-${randomUUID()}`;
      await admin.customer.create({
        data: {
          id: concurrentCustomerId,
          companyId: companyA,
          type: 'b2b',
          name: 'Client concurrence archive',
          addrLine1: '5 rue de la Certification',
          addrZip: '75001',
          addrCity: 'Paris',
        },
      });
      await admin.invoice.create({
        data: {
          id: concurrentInvoiceId,
          companyId: companyA,
          customerId: concurrentCustomerId,
          kind: 'invoice',
          status: 'draft',
        },
      });

      let signalIssued: (() => void) | undefined;
      let releaseIssuance: (() => void) | undefined;
      const issuedInsideTransaction = new Promise<void>((resolve) => {
        signalIssued = resolve;
      });
      const holdIssuance = new Promise<void>((resolve) => {
        releaseIssuance = resolve;
      });
      const issuance = workers[0]!.withTenant(companyA, async (tx) => {
        await tx.invoice.update({
          where: { id: concurrentInvoiceId },
          data: {
            status: 'issued',
            number: `CERT-RACE-${randomUUID()}`,
            issuedAt: new Date('2026-07-21T10:00:00.000Z'),
            dueAt: new Date('2026-08-20T10:00:00.000Z'),
          },
        });
        signalIssued?.();
        await holdIssuance;
      });
      await issuedInsideTransaction;

      try {
        await expect(
          workers[1]!.withTenant(companyA, async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '250ms'");
            return tx.customer.update({
              where: { id: concurrentCustomerId },
              data: { type: 'b2c' },
            });
          }),
        ).rejects.toThrow(/lock timeout|canceling statement/i);
      } finally {
        releaseIssuance?.();
      }
      await issuance;

      await expect(
        workers[1]!.withTenant(companyA, (tx) =>
          tx.customer.update({
            where: { id: concurrentCustomerId },
            data: { type: 'b2c' },
          }),
        ),
      ).rejects.toThrow('customer type is immutable after a signed quote or an issued invoice');
      await expect(
        admin.invoice.findUniqueOrThrow({ where: { id: concurrentInvoiceId } }),
      ).resolves.toMatchObject({ archiveAudienceAtIssuance: 'professional' });
      await expect(
        admin.customer.findUniqueOrThrow({ where: { id: concurrentCustomerId } }),
      ).resolves.toMatchObject({ type: 'b2b' });

      const repository = new PrismaDocumentArchiveJobRepository(workers[0]!);
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.enqueue({
            id: randomUUID(),
            companyId: companyA,
            pieceId: concurrentInvoiceId,
            reason: 'invoice-issued',
            now: new Date().toISOString(),
          }),
        ),
      ).resolves.toBeUndefined();
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.enqueue({
            id: randomUUID(),
            companyId: companyA,
            pieceId: concurrentInvoiceId,
            reason: 'invoice-issued-pdf-only-b2c',
            now: new Date().toISOString(),
          }),
        ),
      ).rejects.toThrow('document archive reason does not match');
    }, 30_000);

    it('donne un lease à un seul worker et utilise exclusivement l’horloge PostgreSQL', async () => {
      const id = randomUUID();
      const pieceId = `race-${randomUUID()}`;
      await seedIssuedInvoice(companyA, pieceId);
      const bootstrap = new PrismaDocumentArchiveJobRepository(workers[0]!);
      await workers[0]!.withTenant(companyA, () =>
        bootstrap.enqueue({
          id,
          companyId: companyA,
          pieceId,
          reason: 'invoice-issued',
          // Horloge hôte volontairement fausse : PostgreSQL doit programmer l'ordre maintenant.
          now: '2099-01-01T00:00:00.000Z',
        }),
      );
      const candidate =
        (
          await workers[0]!.withTenant(companyA, () =>
            // Horloge worker volontairement en retard : la sélection reste pilotée par la base.
            bootstrap.listDue(companyA, '1900-01-01T00:00:00.000Z', 100),
          )
        ).find((job) => job.id === id) ?? null;
      if (candidate === null) throw new Error('candidate archive absent');
      const tokens = workers.map(() => randomUUID());
      const outcomes = await Promise.all(
        workers.map((worker, index) => {
          const repository = new PrismaDocumentArchiveJobRepository(worker);
          return worker.withTenant(companyA, () =>
            repository.claimForArchive(
              id,
              companyA,
              candidate.updatedAt,
              '2099-01-01T00:00:00.000Z',
              '2099-01-01T00:05:00.000Z',
              tokens[index]!,
            ),
          );
        }),
      );
      expect(outcomes.filter((outcome) => outcome.outcome === 'claimed')).toHaveLength(1);
      const winnerIndex = outcomes.findIndex((outcome) => outcome.outcome === 'claimed');
      const winner = outcomes[winnerIndex]!;
      if (winner.outcome !== 'claimed') throw new Error('lease gagnant absent');
      expect(Date.parse(winner.job.nextAttemptAt)).toBeLessThan(Date.parse('2090-01-01T00:00:00Z'));
      expect(Date.parse(winner.job.nextAttemptAt)).toBeGreaterThan(Date.now() + 4 * 60_000);

      const premature = await workers[winnerIndex]!.withTenant(companyA, () =>
        new PrismaDocumentArchiveJobRepository(workers[winnerIndex]!).claimForArchive(
          id,
          companyA,
          winner.job.updatedAt,
          '2099-01-01T00:00:00.000Z',
          '2099-01-01T00:05:00.000Z',
          randomUUID(),
        ),
      );
      expect(premature).toEqual({ outcome: 'skipped' });

      const repository = new PrismaDocumentArchiveJobRepository(workers[winnerIndex]!);
      const proof = invoiceProof(companyA, pieceId);
      await seedProofArtifacts(proof);
      await expect(
        workers[winnerIndex]!.withTenant(companyA, () =>
          repository.markDone(
            id,
            companyA,
            randomUUID(),
            proof,
            documentArchiveIntegrityProofSha256(proof),
            '1900-01-01T00:00:00.000Z',
          ),
        ),
      ).resolves.toBe(false);
      await expect(
        workers[winnerIndex]!.withTenant(companyA, () =>
          repository.markDone(
            id,
            companyA,
            tokens[winnerIndex]!,
            proof,
            documentArchiveIntegrityProofSha256(proof),
            '1900-01-01T00:00:00.000Z',
          ),
        ),
      ).resolves.toBe(true);
      const completed = await workers[winnerIndex]!.withTenant(companyA, () =>
        repository.findByPiece(companyA, pieceId, 'invoice-issued'),
      );
      expect(completed).toMatchObject({ status: 'done', integrityProof: proof });
      expect(Math.abs(Date.parse(completed!.completedAt!) - Date.now())).toBeLessThan(30_000);
    }, 30_000);

    it('récupère un lease expiré et refuse définitivement le token périmé', async () => {
      const id = randomUUID();
      const pieceId = `stale-${randomUUID()}`;
      await seedIssuedInvoice(companyA, pieceId);
      const repository = new PrismaDocumentArchiveJobRepository(workers[0]!);
      await workers[0]!.withTenant(companyA, () =>
        repository.enqueue({
          id,
          companyId: companyA,
          pieceId,
          reason: 'invoice-issued',
          now: new Date(Date.now() - 1_000).toISOString(),
        }),
      );
      const initial = await workers[0]!.withTenant(companyA, () =>
        repository.findByPiece(companyA, pieceId, 'invoice-issued'),
      );
      if (initial === null) throw new Error('job stale absent');
      const tokenA = randomUUID();
      const first = await workers[0]!.withTenant(companyA, () =>
        repository.claimForArchive(
          id,
          companyA,
          initial.updatedAt,
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
          tokenA,
        ),
      );
      expect(first.outcome).toBe('claimed');
      await admin.documentArchiveJob.update({
        where: { id },
        data: { nextAttemptAt: new Date(Date.now() - 1_000), updatedAt: new Date() },
      });
      const expired = await workers[0]!.withTenant(companyA, () =>
        repository.findByPiece(companyA, pieceId, 'invoice-issued'),
      );
      if (expired === null) throw new Error('job expiré absent');
      const tokenB = randomUUID();
      const second = await workers[0]!.withTenant(companyA, () =>
        repository.claimForArchive(
          id,
          companyA,
          expired.updatedAt,
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
          tokenB,
        ),
      );
      expect(second.outcome).toBe('claimed');
      const proof = invoiceProof(companyA, pieceId);
      await seedProofArtifacts(proof);
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.markDone(
            id,
            companyA,
            tokenA,
            proof,
            documentArchiveIntegrityProofSha256(proof),
            new Date().toISOString(),
          ),
        ),
      ).resolves.toBe(false);
      await expect(
        workers[0]!.withTenant(companyA, () =>
          repository.markDone(
            id,
            companyA,
            tokenB,
            proof,
            documentArchiveIntegrityProofSha256(proof),
            new Date().toISOString(),
          ),
        ),
      ).resolves.toBe(true);
    });

    it('refuse les manifestes ambigus, fige une preuve valide et reprend un done N-1', async () => {
      const malformedId = randomUUID();
      const malformedPiece = `malformed-${randomUUID()}`;
      await seedIssuedInvoice(companyA, malformedPiece);
      await admin.documentArchiveJob.create({
        data: {
          id: malformedId,
          companyId: companyA,
          invoiceId: malformedPiece,
          reason: 'invoice-issued',
          status: 'pending',
          nextAttemptAt: new Date(Date.now() - 1_000),
        },
      });
      const malformed = invoiceProof(companyA, malformedPiece);
      malformed.artifacts[1] = {
        ...malformed.artifacts[1]!,
        kind: 'facturx_xml',
        mimeType: 'application/xml',
      };
      await expect(admin.$executeRaw`
        UPDATE "document_archive_jobs"
           SET status = 'done',
               "integrityProof" = ${JSON.stringify(malformed)}::jsonb,
               "integrityProofSha256" = ${documentArchiveIntegrityProofSha256(malformed)},
               "completedAt" = statement_timestamp()
         WHERE id = ${malformedId}
      `).rejects.toThrow();
      await expect(
        admin.documentArchiveJob.create({
          data: {
            id: randomUUID(),
            companyId: companyA,
            invoiceId: `reason-${randomUUID()}`,
            reason: 'unknown-reason',
            nextAttemptAt: new Date(),
          },
        }),
      ).rejects.toThrow();

      const legacyId = randomUUID();
      const legacyPiece = `legacy-${randomUUID()}`;
      await seedIssuedInvoice(companyA, legacyPiece);
      await admin.documentArchiveJob.create({
        data: {
          id: legacyId,
          companyId: companyA,
          invoiceId: legacyPiece,
          reason: 'invoice-issued',
          status: 'done',
          nextAttemptAt: new Date(Date.now() - 1_000),
          lastError: LEGACY_ARCHIVE_PROOF_REQUIRED,
        },
      });
      const repository = new PrismaDocumentArchiveJobRepository(workers[0]!);
      expect(
        await workers[0]!.withTenant(companyA, () =>
          repository.countIncomplete(companyA, 'invoice-issued'),
        ),
      ).toBeGreaterThan(0);
      const due = await workers[0]!.withTenant(companyA, () =>
        repository.listDue(companyA, new Date().toISOString(), 100),
      );
      const legacy = due.find((job) => job.id === legacyId);
      expect(legacy).toMatchObject({ status: 'done', integrityProof: null });
      const token = randomUUID();
      const claimed = await workers[0]!.withTenant(companyA, () =>
        repository.claimForArchive(
          legacyId,
          companyA,
          legacy!.updatedAt,
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
          token,
        ),
      );
      expect(claimed).toMatchObject({ outcome: 'claimed', job: { status: 'failed' } });

      const proofId = randomUUID();
      const proofPiece = `immutable-${randomUUID()}`;
      await seedIssuedInvoice(companyA, proofPiece);
      await workers[0]!.withTenant(companyA, () =>
        repository.enqueue({
          id: proofId,
          companyId: companyA,
          pieceId: proofPiece,
          reason: 'invoice-issued',
          now: new Date(Date.now() - 1_000).toISOString(),
        }),
      );
      const proofCandidate = await workers[0]!.withTenant(companyA, () =>
        repository.findByPiece(companyA, proofPiece, 'invoice-issued'),
      );
      if (proofCandidate === null) throw new Error('job preuve absent');
      const proofToken = randomUUID();
      await workers[0]!.withTenant(companyA, () =>
        repository.claimForArchive(
          proofId,
          companyA,
          proofCandidate.updatedAt,
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
          proofToken,
        ),
      );
      const valid = invoiceProof(companyA, proofPiece);
      await seedProofArtifacts(valid);
      await workers[0]!.withTenant(companyA, () =>
        repository.markDone(
          proofId,
          companyA,
          proofToken,
          valid,
          documentArchiveIntegrityProofSha256(valid),
          new Date().toISOString(),
        ),
      );
      await expect(
        admin.documentArchiveJob.update({
          where: { id: proofId },
          data: { lastError: 'mutation interdite' },
        }),
      ).rejects.toThrow('proved document archive jobs are immutable');
      await expect(
        workers[0]!.withTenant(companyA, (tx) =>
          tx.documentArchiveJob.deleteMany({ where: { id: proofId, companyId: companyA } }),
        ),
      ).rejects.toThrow();
    });
  },
);

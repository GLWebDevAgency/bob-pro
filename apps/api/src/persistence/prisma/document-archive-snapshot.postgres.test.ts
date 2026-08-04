import { createHash, randomInt, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { QuotePdfData } from '@bob/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  sealDocumentArchiveRenderSnapshot,
  type DocumentArchiveRenderSnapshot,
  type DocumentArchiveRenderSnapshotSeal,
} from '../../documents/document-archive-render-snapshot';
import {
  documentArchiveIntegrityProofSha256,
  type DocumentArchiveIntegrityProof,
} from '../document-archive-jobs';
import { PrismaDocumentArchiveJobRepository } from './repositories';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT =
  process.env.RUN_POSTGRES_DOCUMENT_ARCHIVE_SNAPSHOT_CERT === 'true';

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

function canonicalSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Archive snapshot V3 — certification PostgreSQL/RLS réelle',
  () => {
    const suffix = randomUUID();
    const companyA = `archive-snapshot-a-${suffix}`;
    const companyB = `archive-snapshot-b-${suffix}`;
    const customerA = `archive-snapshot-customer-${suffix}`;
    const quoteId = `archive-snapshot-quote-${suffix}`;
    const jobId = `archive-snapshot-job-${suffix}`;
    const malformedJobId = `archive-snapshot-malformed-${suffix}`;
    const n1JobId = `archive-snapshot-n1-${suffix}`;
    const documentId = `archive-snapshot-document-${suffix}`;
    const versionId = `${documentId}-v1`;
    const artifactSha256 = 'd'.repeat(64);
    const artifactFilename = 'devis-signe-certification.pdf';
    const storageKey =
      `companies/${companyA}/documents/${documentId}/v1/${artifactSha256}.pdf`;
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    let admin: PrismaClient;
    let runtime: PrismaService;
    let repository: PrismaDocumentArchiveJobRepository;
    let protocolVersion: number;
    let baseArchiveProtocolVersion: number;
    let seal: DocumentArchiveRenderSnapshotSeal;
    let leaseToken: string;

    const quoteData = (): QuotePdfData => ({
      number: `D-CERT-${suffix.slice(0, 8)}`,
      companyName: 'Archive Snapshot Certification',
      companyAddress: '1 rue du Certificat, 75001 Paris',
      companyRcsOrRm: null,
      customerName: 'Client Certification',
      customerAddress: '2 rue du Certificat, 75002 Paris',
      validUntil: '2026-09-04',
      documentCreatedAt: '2026-08-04T12:00:00.000Z',
      lines: [{ label: 'Certification', qty: 1, unitPriceHT: 10_000, vatRate: 20 }],
      totals: { ht: 10_000, vat: 2_000, ttc: 12_000, netToPay: 12_000 },
      depositPct: null,
      signedBy: 'Client Certification',
      signedAt: '2026-08-04T11:59:00.000Z',
      mentions: [],
    });

    const snapshot = (data = quoteData()): Extract<
      DocumentArchiveRenderSnapshot,
      { reason: 'quote-signed' }
    > => ({
      schemaVersion: 1,
      rendererVersion: 1,
      companyId: companyA,
      pieceId: quoteId,
      reason: 'quote-signed',
      metadataCreatedAt: '2026-08-04T12:00:00.000Z',
      artifacts: [{
        kind: 'signed_quote',
        expectedContentProfile: 'plain_pdf',
        documentId,
        versionId,
        filename: artifactFilename,
        mimeType: 'application/pdf',
        linkedEntityType: 'quote',
        documentDate: '2026-08-04',
        issuedAt: '2026-08-04',
      }],
      payload: { kind: 'quote', data },
    });

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (runtime) et DIRECT_URL (admin) sont requis.');
      }
      admin = new PrismaClient({ datasourceUrl: directUrl, errorFormat: 'minimal' });
      runtime = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
      repository = new PrismaDocumentArchiveJobRepository(runtime);
      await Promise.all([admin.$connect(), runtime.$connect()]);

      const sirenA = appendLuhnDigit(String(randomInt(10_000_000, 100_000_000)));
      const sirenB = appendLuhnDigit(String(randomInt(10_000_000, 100_000_000)));
      await admin.company.createMany({
        data: [
          {
            id: companyA,
            name: 'Archive Snapshot A',
            legalForm: 'EI',
            siren: sirenA,
            siret: appendLuhnDigit(`${sirenA}${String(randomInt(0, 10_000)).padStart(4, '0')}`),
            trade: 'autre',
            vatRegime: 'reel_normal',
            addrLine1: '1 rue du Certificat',
            addrZip: '75001',
            addrCity: 'Paris',
          },
          {
            id: companyB,
            name: 'Archive Snapshot B',
            legalForm: 'EI',
            siren: sirenB,
            siret: appendLuhnDigit(`${sirenB}${String(randomInt(0, 10_000)).padStart(4, '0')}`),
            trade: 'autre',
            vatRegime: 'reel_normal',
            addrLine1: '2 rue du Certificat',
            addrZip: '75002',
            addrCity: 'Paris',
          },
        ],
      });
      await admin.customer.create({
        data: {
          id: customerA,
          companyId: companyA,
          type: 'b2b',
          name: 'Client Certification',
          addrLine1: '3 rue du Certificat',
          addrZip: '75003',
          addrCity: 'Paris',
        },
      });
      await admin.quote.create({
        data: {
          id: quoteId,
          companyId: companyA,
          customerId: customerA,
          status: 'signed',
          number: quoteData().number,
          issuedAt: new Date('2026-08-04T00:00:00.000Z'),
          validUntil: new Date('2026-09-04T00:00:00.000Z'),
          signerName: 'Client Certification',
          signedAt: new Date('2026-08-04T11:59:00.000Z'),
          signatureCustomerType: 'b2b',
        },
      });
      protocolVersion = (
        await admin.documentArchiveSnapshotProtocolState.findUniqueOrThrow({ where: { id: 1 } })
      ).activeVersion;
      baseArchiveProtocolVersion = (
        await admin.documentArchiveProtocolState.findUniqueOrThrow({ where: { id: 1 } })
      ).activeVersion;
      seal = sealDocumentArchiveRenderSnapshot(snapshot());
      leaseToken = `lease-${suffix}`;
    }, 30_000);

    afterAll(async () => {
      try {
        if (admin) {
          await admin.$transaction(async (tx) => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
            await tx.$executeRaw`SET LOCAL statement_timeout = '30s'`;
            // La fixture terminale est volontairement incohérente (filename différent) afin de
            // prouver le refus de DONE. Le cleanup privilégié doit donc retirer l'agrégat entier
            // sans réévaluer transitoirement cet état impossible entre deux DELETE.
            await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
            await tx.$executeRawUnsafe(
              'ALTER TABLE public.document_archive_artifact_intents DISABLE TRIGGER ' +
              'document_archive_artifact_intent_immutable',
            );
            await tx.$executeRawUnsafe(
              'ALTER TABLE public.document_archive_render_snapshots DISABLE TRIGGER ' +
              'document_archive_render_snapshot_immutable',
            );
            await tx.documentArchiveArtifactIntent.deleteMany({ where: { companyId: companyA } });
            await tx.documentArchiveRenderSnapshot.deleteMany({ where: { companyId: companyA } });
            await tx.$executeRawUnsafe(
              'ALTER TABLE public.document_archive_render_snapshots ENABLE TRIGGER ' +
              'document_archive_render_snapshot_immutable',
            );
            await tx.$executeRawUnsafe(
              'ALTER TABLE public.document_archive_artifact_intents ENABLE TRIGGER ' +
              'document_archive_artifact_intent_immutable',
            );
            await tx.documentArchiveJobArtifact.deleteMany({ where: { companyId: companyA } });
            await tx.documentArchiveJob.deleteMany({ where: { companyId: companyA } });
            await tx.storedDocument.deleteMany({ where: { companyId: companyA } });
            await tx.quote.deleteMany({ where: { companyId: companyA } });
            await tx.customer.deleteMany({ where: { companyId: companyA } });
            await tx.company.deleteMany({ where: { id: { in: [companyA, companyB] } } });
          }, { maxWait: 10_000, timeout: 40_000 });
        }
      } finally {
        await Promise.allSettled([
          ...(runtime ? [runtime.$disconnect()] : []),
          ...(admin ? [admin.$disconnect()] : []),
        ]);
      }
    }, 50_000);

    it('certifie rôle runtime, FORCE RLS, ACL Data API et capacité de cutover', async () => {
      const [role] = await runtime.$queryRaw<Array<{
        superuser: boolean;
        bypassRls: boolean;
        roleName: string;
      }>>`
        SELECT rolsuper AS superuser, rolbypassrls AS "bypassRls", rolname AS "roleName"
          FROM pg_catalog.pg_roles WHERE rolname = current_user
      `;
      expect(role).toMatchObject({ superuser: false, bypassRls: false });
      const forceRls = await admin.$queryRaw<Array<{ relname: string }>>`
        SELECT relation.relname
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND relation.relname IN (
             'document_archive_render_snapshots',
             'document_archive_artifact_intents',
             'document_archive_snapshot_protocol_state'
           )
           AND relation.relrowsecurity
           AND relation.relforcerowsecurity
      `;
      expect(forceRls).toHaveLength(3);
      const exposed = await admin.$queryRaw<Array<{ roleName: string }>>`
        SELECT role.rolname AS "roleName"
          FROM pg_catalog.pg_roles AS role
         WHERE role.rolname IN ('anon', 'authenticated', 'service_role')
           AND (
             has_table_privilege(role.rolname, 'public.document_archive_render_snapshots', 'SELECT')
             OR has_table_privilege(role.rolname, 'public.document_archive_artifact_intents', 'SELECT')
             OR has_function_privilege(
               role.rolname,
               'public.document_archive_job_enqueue_v3(text,text,text,text,smallint,smallint,text,text)',
               'EXECUTE'
             )
           )
      `;
      expect(exposed).toEqual([]);
    });

    it('prouve le writer N-1 exact sous expand puis son refus terminal sans écriture partielle', async () => {
      const attempt = runtime.withTenant(companyA, async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ accepted: boolean }>>`
          SELECT public.document_archive_job_enqueue_v2(
            ${n1JobId}, ${companyA}, ${quoteId}, ${'quote-signed'}
          ) AS accepted
        `;
        if (protocolVersion === 1) {
          expect(row?.accepted).toBe(true);
          throw new Error('ROLLBACK_N1_WRITER_CERT');
        }
        return row?.accepted;
      });
      if (protocolVersion === 1) {
        await expect(attempt).rejects.toThrow('ROLLBACK_N1_WRITER_CERT');
      } else {
        await expect(attempt).rejects.toThrow(/permission denied/u);
      }
      await expect(admin.documentArchiveJob.findUnique({ where: { id: n1JobId } }))
        .resolves.toBeNull();
    });

    it('accepte le V3 exact/idempotent et refuse conflit, anti-IDOR et JSON à clé substituée', async () => {
      const enqueue = () => runtime.withTenant(companyA, async () => {
        await repository.enqueue({
          id: jobId,
          companyId: companyA,
          pieceId: quoteId,
          reason: 'quote-signed',
          now: new Date().toISOString(),
          renderSnapshot: seal,
        });
      });
      await enqueue();
      await enqueue();
      const conflictingSeal = sealDocumentArchiveRenderSnapshot(snapshot({
        ...quoteData(),
        customerName: 'Autre nom réel',
      }));
      await expect(runtime.withTenant(companyA, async () => repository.enqueue({
        id: jobId,
        companyId: companyA,
        pieceId: quoteId,
        reason: 'quote-signed',
        now: new Date().toISOString(),
        renderSnapshot: conflictingSeal,
      }))).rejects.toThrow('identity conflict');
      await expect(runtime.withTenant(companyB, async () => repository.enqueue({
        id: jobId,
        companyId: companyA,
        pieceId: quoteId,
        reason: 'quote-signed',
        now: new Date().toISOString(),
        renderSnapshot: seal,
      }))).rejects.toThrow('identity conflict');

      const malformed = JSON.parse(seal.json) as Record<string, unknown>;
      delete malformed.companyId;
      malformed.unexpectedCompany = companyA;
      const malformedJson = JSON.stringify(malformed);
      const accepted = await runtime.withTenant(companyA, async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ accepted: boolean }>>`
          SELECT public.document_archive_job_enqueue_v3(
            ${malformedJobId}, ${companyA}, ${quoteId}, ${'quote-signed'},
            ${1}::smallint, ${1}::smallint, ${malformedJson}, ${canonicalSha256(malformedJson)}
          ) AS accepted
        `;
        return row?.accepted;
      });
      expect(accepted).toBe(false);
      await expect(admin.documentArchiveJob.count({ where: { id: malformedJobId } }))
        .resolves.toBe(0);
      await expect(admin.documentArchiveRenderSnapshot.count({ where: { companyId: companyA } }))
        .resolves.toBe(1);
    });

    it('scelle snapshot/intention et refuse DONE si le filename matérialisé diverge', async () => {
      await expect(admin.documentArchiveRenderSnapshot.update({
        where: { jobId },
        data: { payloadSha256: 'e'.repeat(64) },
      })).rejects.toThrow(/append-only/u);
      await expect(admin.documentArchiveRenderSnapshot.delete({ where: { jobId } }))
        .rejects.toThrow(/append-only/u);

      const [schedule] = await admin.$queryRaw<Array<{
        due: boolean;
        nextAttemptAt: Date;
        status: string;
      }>>`
        SELECT job.status::text AS status,
               job."nextAttemptAt" AS "nextAttemptAt",
               job."nextAttemptAt" <= statement_timestamp() AS due
          FROM public.document_archive_jobs AS job
         WHERE job.id = ${jobId}
      `;
      expect(schedule?.status).toBe('pending');
      if (baseArchiveProtocolVersion !== 2) {
        // Le snapshot est scellé atomiquement, mais il ne doit jamais réarmer le spool du protocole
        // archive historique avant son propre cutover V2.
        expect(schedule?.nextAttemptAt.toISOString()).toBe('9999-12-31T23:59:59.999Z');
        expect(schedule?.due).toBe(false);
        return;
      }
      // `nextAttemptAt` est une colonne historique timestamp sans timezone : Prisma la matérialise
      // comme UTC alors que PostgreSQL la compare dans le fuseau de session. La preuve fiable est
      // donc le prédicat SQL exact utilisé par LIST, pas une comparaison JS décalée de deux heures.
      expect(schedule?.due).toBe(true);

      const [candidate] = await runtime.withTenant(
        companyA,
        async () => repository.listDue(companyA, new Date().toISOString(), 10),
      );
      expect(candidate?.id).toBe(jobId);
      const now = new Date();
      const claim = await runtime.withTenant(companyA, async () => repository.claimForArchive(
        jobId,
        companyA,
        candidate!.updatedAt,
        now.toISOString(),
        new Date(now.getTime() + 60_000).toISOString(),
        leaseToken,
      ));
      expect(claim.outcome).toBe('claimed');
      const intent = {
        kind: 'signed_quote' as const,
        contentProfile: 'plain_pdf' as const,
        documentId,
        versionId,
        version: 1 as const,
        filename: artifactFilename,
        storageKey,
        mimeType: 'application/pdf',
        byteSize: 42,
        sha256: artifactSha256,
      };
      const prepared = await runtime.withTenant(companyA, async () => repository.prepareArtifactIntents({
        jobId,
        companyId: companyA,
        leaseToken,
        snapshotSha256: seal.sha256,
        intents: [intent],
        now: now.toISOString(),
      }));
      const [prepareFacts] = await admin.$queryRaw<Array<{
        intentCount: bigint;
        leaseMatches: boolean;
        leaseOpen: boolean;
        snapshotMatches: boolean;
        status: string;
      }>>`
        SELECT job.status::text AS status,
               job."leaseToken" = ${leaseToken} AS "leaseMatches",
               job."nextAttemptAt" > statement_timestamp() AS "leaseOpen",
               snapshot."payloadSha256" = ${seal.sha256} AS "snapshotMatches",
               (
                 SELECT count(*) FROM public.document_archive_artifact_intents AS intent
                  WHERE intent."jobId" = job.id
               ) AS "intentCount"
          FROM public.document_archive_jobs AS job
          JOIN public.document_archive_render_snapshots AS snapshot ON snapshot."jobId" = job.id
         WHERE job.id = ${jobId}
      `;
      expect(prepareFacts).toEqual({
        status: 'failed',
        leaseMatches: true,
        leaseOpen: true,
        snapshotMatches: true,
        intentCount: prepared ? 1n : 0n,
      });
      if (!prepared) {
        const [validationFacts] = await admin.$queryRaw<Array<{
          exactKeyCount: boolean;
          expectedStorageKey: boolean;
          planMatches: boolean;
          shapeMatches: boolean;
        }>>`
          WITH requested AS (
            SELECT ${JSON.stringify([intent])}::jsonb->0 AS item
          ), sealed AS (
            SELECT snapshot.payload::jsonb->'artifacts'->0 AS plan
              FROM public.document_archive_render_snapshots AS snapshot
             WHERE snapshot."jobId" = ${jobId}
          )
          SELECT (SELECT count(*) FROM pg_catalog.jsonb_object_keys(requested.item)) = 10
                   AS "exactKeyCount",
                 requested.item ?& ARRAY[
                   'kind', 'contentProfile', 'documentId', 'versionId', 'version', 'filename',
                   'storageKey', 'mimeType', 'byteSize', 'sha256'
                 ]::text[] AS "shapeMatches",
                 sealed.plan->>'documentId' = requested.item->>'documentId'
                   AND sealed.plan->>'versionId' = requested.item->>'versionId'
                   AND sealed.plan->>'filename' = requested.item->>'filename'
                   AND sealed.plan->>'mimeType' = requested.item->>'mimeType'
                   AND sealed.plan->>'expectedContentProfile' = requested.item->>'contentProfile'
                   AS "planMatches",
                 requested.item->>'storageKey' = pg_catalog.format(
                   'companies/%s/documents/%s/v1/%s.pdf',
                   ${companyA},
                   requested.item->>'documentId',
                   requested.item->>'sha256'
                 ) AS "expectedStorageKey"
            FROM requested CROSS JOIN sealed
        `;
        expect(validationFacts).toEqual({
          exactKeyCount: true,
          shapeMatches: true,
          planMatches: true,
          expectedStorageKey: true,
        });
      }
      expect(prepared).toBe(true);
      await expect(admin.documentArchiveArtifactIntent.updateMany({
        where: { jobId, kind: 'signed_quote' },
        data: { filename: 'devis-altere.pdf' },
      })).rejects.toThrow(/append-only/u);
      await expect(admin.documentArchiveArtifactIntent.deleteMany({
        where: { jobId, kind: 'signed_quote' },
      })).rejects.toThrow(/append-only/u);

      await admin.storedDocument.create({
        data: {
          id: documentId,
          companyId: companyA,
          kind: 'signed_quote',
          origin: 'generated',
          status: 'active',
          filename: 'nom-different-du-snapshot.pdf',
          mimeType: 'application/pdf',
          byteSize: 42,
          sha256: artifactSha256,
          storageKey,
          linkedEntityType: 'quote',
          linkedEntityId: quoteId,
          documentDate: '2026-08-04',
          issuedAt: '2026-08-04',
          createdAt: new Date('2026-08-04T12:00:00.000Z'),
          retentionUntil: '2036-08-04',
          versions: {
            create: {
              id: versionId,
              version: 1,
              storageKey,
              sha256: artifactSha256,
              mimeType: 'application/pdf',
              byteSize: 42,
              createdAt: new Date('2026-08-04T12:00:00.000Z'),
              reason: 'quote-signed',
            },
          },
        },
      });
      const proof: DocumentArchiveIntegrityProof = {
        version: 1,
        algorithm: 'sha256',
        companyId: companyA,
        pieceId: quoteId,
        reason: 'quote-signed',
        artifacts: [{
          kind: 'signed_quote',
          contentProfile: 'plain_pdf',
          documentId,
          versionId,
          version: 1,
          storageKey,
          mimeType: 'application/pdf',
          byteSize: 42,
          sha256: artifactSha256,
        }],
      };
      await expect(runtime.withTenant(companyA, async () => repository.markDone(
        jobId,
        companyA,
        leaseToken,
        proof,
        documentArchiveIntegrityProofSha256(proof),
        now.toISOString(),
      ))).resolves.toBe(false);
      await expect(admin.documentArchiveJob.findUniqueOrThrow({ where: { id: jobId } }))
        .resolves.toMatchObject({ completedAt: null, integrityProof: null });
    });
  },
);

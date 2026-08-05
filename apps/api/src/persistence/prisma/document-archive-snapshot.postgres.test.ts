import { createHash, randomInt, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
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

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_DOCUMENT_ARCHIVE_SNAPSHOT_CERT === 'true';
const CERT_ALLOWED_RELEASE_ENVIRONMENTS = new Set(['development', 'staging']);
const RUN_STALE_RECOVERY_PROBES = process.env.CABINET_RELEASE_ENV === 'development';
const CERT_STALE_DOCUMENT_PREFIX = 'archive-snapshot-document-';
const CERT_MAX_STALE_VERSIONS = 32;
const CERT_UUID_SUFFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CERT_ARTIFACT_SHA256 = 'd'.repeat(64);
const CERT_ARTIFACT_MIME_TYPE = 'application/pdf';
const CERT_ARTIFACT_BYTE_SIZE = 42;
const CERT_ARTIFACT_CREATED_AT = '2026-08-04T12:00:00.000Z';
const CERT_ARTIFACT_REASON = 'quote-signed';

type StaleSnapshotManifestEntry = {
  versionId: string;
  storageKey: string;
};

// Manifeste non-PII scellé depuis l'inventaire read-only du refus staging 30956265151. Un état
// partiel est interdit : le premier predeploy voit exactement les deux lignes ou aucune si un run
// antérieur les a déjà récupérées ; tout autre identifiant réservé exige un nouvel audit humain.
const CERT_STAGING_INCIDENT_MANIFEST = [
  {
    versionId: 'archive-snapshot-document-0fa529b9-900d-483c-b76e-5462666eec91-v1',
    storageKey:
      'companies/archive-snapshot-a-0fa529b9-900d-483c-b76e-5462666eec91/documents/' +
      'archive-snapshot-document-0fa529b9-900d-483c-b76e-5462666eec91/v1/' +
      `${CERT_ARTIFACT_SHA256}.pdf`,
  },
  {
    versionId: 'archive-snapshot-document-da6a9db2-0f3e-4563-9cd1-e1cd189f0250-v1',
    storageKey:
      'companies/archive-snapshot-a-da6a9db2-0f3e-4563-9cd1-e1cd189f0250/documents/' +
      'archive-snapshot-document-da6a9db2-0f3e-4563-9cd1-e1cd189f0250/v1/' +
      `${CERT_ARTIFACT_SHA256}.pdf`,
  },
] as const satisfies readonly StaleSnapshotManifestEntry[];

type StaleSnapshotVersion = {
  id: string;
  documentId: string;
  version: number;
  storageKey: string;
  sha256: string;
  mimeType: string;
  byteSize: number;
  createdAt: Date;
  reason: string;
  analysisCount: bigint;
  archiveArtifactCount: bigint;
  archiveIntentCount: bigint;
  attestationCount: bigint;
};

type PublicTableOwnerFacts = {
  ownerName: string;
  sessionUser: string;
};

type CleanupTriggerState = 'O' | 'D' | 'R' | 'A';

type CleanupTriggerTarget = {
  tableName: string;
  qualifiedTableName: string;
  triggerName: string;
};

const CERT_RECOVERY_STORAGE_LOCK_STATEMENT =
  'LOCK TABLE storage.objects IN SHARE ROW EXCLUSIVE MODE';

const CERT_RECOVERY_PUBLIC_TABLE_NAMES = [
  'companies',
  'customers',
  'quotes',
  'invoices',
  'documents',
  'document_versions',
  'chantier_photos',
  'document_analyses',
  'document_invoice_pdf_attestations',
  'document_archive_jobs',
  'document_archive_render_snapshots',
  'document_archive_job_artifacts',
  'document_archive_artifact_intents',
] as const;

const CERT_VERSION_REPRESENTATION_TRIGGER = {
  tableName: 'document_versions',
  qualifiedTableName: 'public.document_versions',
  triggerName: 'document_versions_generated_legal_archive_representation_v2',
} as const satisfies CleanupTriggerTarget;

const CERT_RENDER_SNAPSHOT_IMMUTABILITY_TRIGGER = {
  tableName: 'document_archive_render_snapshots',
  qualifiedTableName: 'public.document_archive_render_snapshots',
  triggerName: 'document_archive_render_snapshot_immutable',
} as const satisfies CleanupTriggerTarget;

const CERT_ARTIFACT_INTENT_IMMUTABILITY_TRIGGER = {
  tableName: 'document_archive_artifact_intents',
  qualifiedTableName: 'public.document_archive_artifact_intents',
  triggerName: 'document_archive_artifact_intent_immutable',
} as const satisfies CleanupTriggerTarget;

const CERT_MAIN_FIXTURE_CLEANUP_TABLES = [
  'companies',
  'customers',
  'quotes',
  'documents',
  'document_versions',
  'document_archive_jobs',
  'document_archive_render_snapshots',
  'document_archive_job_artifacts',
  'document_archive_artifact_intents',
] as const;

async function assumeCommonPublicTableOwner(
  tx: Prisma.TransactionClient,
  tableNames: readonly string[],
): Promise<PublicTableOwnerFacts> {
  const uniqueTableNames = [...new Set(tableNames)];
  if (uniqueTableNames.length === 0 || uniqueTableNames.length !== tableNames.length) {
    throw new Error('Archive snapshot certification owner target list is empty or duplicated.');
  }
  const rows = await tx.$queryRaw<
    Array<{
      tableName: string;
      ownerName: string | null;
      sessionUser: string;
      canSetOwner: boolean;
    }>
  >`
    SELECT relation.relname AS "tableName",
           pg_catalog.pg_get_userbyid(relation.relowner) AS "ownerName",
           session_user::TEXT AS "sessionUser",
           pg_catalog.pg_has_role(session_user, relation.relowner, 'SET') AS "canSetOwner"
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r', 'p')
       AND relation.relname IN (${Prisma.join(uniqueTableNames)})
     ORDER BY relation.relname
  `;
  const actualTableNames = new Set(rows.map(({ tableName }) => tableName));
  if (
    rows.length !== uniqueTableNames.length ||
    uniqueTableNames.some((tableName) => !actualTableNames.has(tableName))
  ) {
    throw new Error('Archive snapshot certification cleanup owner inventory is incomplete.');
  }
  const ownerNames = new Set(rows.map(({ ownerName }) => ownerName));
  const sessionUsers = new Set(rows.map(({ sessionUser }) => sessionUser));
  if (ownerNames.size !== 1 || ownerNames.has(null) || sessionUsers.size !== 1) {
    throw new Error('Archive snapshot certification cleanup tables do not share one owner.');
  }
  const ownerName = rows[0]?.ownerName;
  const sessionUser = rows[0]?.sessionUser;
  if (!ownerName || !sessionUser) {
    throw new Error('Archive snapshot certification cleanup owner identity is unavailable.');
  }
  if (sessionUser !== ownerName && rows.some(({ canSetOwner }) => !canSetOwner)) {
    throw new Error('Archive snapshot certification deployer cannot SET the cleanup owner role.');
  }
  const [roleCommand] = await tx.$queryRaw<Array<{ command: string }>>`
    SELECT pg_catalog.format('SET LOCAL ROLE %I', ${ownerName}) AS command
  `;
  if (!roleCommand?.command) {
    throw new Error('Archive snapshot certification owner role command is unavailable.');
  }
  await tx.$executeRawUnsafe(roleCommand.command);
  const [assumedRole] = await tx.$queryRaw<Array<{ currentUser: string }>>`
    SELECT current_user::TEXT AS "currentUser"
  `;
  if (assumedRole?.currentUser !== ownerName) {
    throw new Error('Archive snapshot certification cleanup owner role was not assumed.');
  }
  return { ownerName, sessionUser };
}

async function assumeSessionUser(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SET LOCAL ROLE NONE`;
  const [role] = await tx.$queryRaw<Array<{ currentUser: string; sessionUser: string }>>`
    SELECT current_user::TEXT AS "currentUser", session_user::TEXT AS "sessionUser"
  `;
  if (!role || role.currentUser !== role.sessionUser) {
    throw new Error('Archive snapshot certification storage authority was not restored.');
  }
}

function datasourceUrlWithOwnerRole(
  datasourceUrl: string,
  { ownerName, sessionUser }: PublicTableOwnerFacts,
): string {
  if (!/^[a-z_][a-z0-9_$]*$/u.test(ownerName)) {
    throw new Error('Archive snapshot certification cleanup owner name is not URL-safe.');
  }
  const parsed = new URL(datasourceUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('Archive snapshot certification DIRECT_URL is not PostgreSQL.');
  }
  const currentOptions = parsed.searchParams.get('options')?.trim() ?? '';
  if (/(?:^|\s)(?:-c\s*)?(?:--)?(?:role|session_authorization)(?:=|\s)/u.test(currentOptions)) {
    throw new Error('Archive snapshot certification DIRECT_URL already overrides its role.');
  }
  if (ownerName === sessionUser) return datasourceUrl;
  parsed.searchParams.set(
    'options',
    [currentOptions, `-c role=${ownerName}`].filter(Boolean).join(' '),
  );
  return parsed.toString();
}

async function withCleanupTriggerDisabled<T>(
  tx: Prisma.TransactionClient,
  target: CleanupTriggerTarget,
  operation: () => Promise<T>,
): Promise<T> {
  const rows = await tx.$queryRaw<Array<{ enabled: string }>>`
    SELECT trigger.tgenabled::TEXT AS enabled
      FROM pg_catalog.pg_trigger AS trigger
      JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = ${target.tableName}
       AND trigger.tgname = ${target.triggerName}
       AND NOT trigger.tgisinternal
  `;
  if (rows.length !== 1 || !['O', 'D', 'R', 'A'].includes(rows[0]?.enabled ?? '')) {
    throw new Error('Archive snapshot certification cleanup trigger state is unavailable.');
  }
  const previousState = rows[0]!.enabled as CleanupTriggerState;
  if (previousState !== 'D') {
    await tx.$executeRawUnsafe(
      `ALTER TABLE ${target.qualifiedTableName} DISABLE TRIGGER ${target.triggerName}`,
    );
  }
  try {
    return await operation();
  } finally {
    const restoreAction = {
      O: 'ENABLE TRIGGER',
      D: 'DISABLE TRIGGER',
      R: 'ENABLE REPLICA TRIGGER',
      A: 'ENABLE ALWAYS TRIGGER',
    } satisfies Record<CleanupTriggerState, string>;
    await tx.$executeRawUnsafe(
      `ALTER TABLE ${target.qualifiedTableName} ${restoreAction[previousState]} ${target.triggerName}`,
    );
  }
}

async function deleteExactProbeVersions(
  tx: Prisma.TransactionClient,
  versionIds: readonly string[],
): Promise<number> {
  await assumeCommonPublicTableOwner(tx, [CERT_VERSION_REPRESENTATION_TRIGGER.tableName]);
  const deleted = await withCleanupTriggerDisabled(tx, CERT_VERSION_REPRESENTATION_TRIGGER, () =>
    tx.storedDocumentVersion.deleteMany({ where: { id: { in: [...versionIds] } } }),
  );
  return deleted.count;
}

async function recoverStaleSnapshotVersions(
  admin: PrismaClient,
  storageBucket: string,
  expectedManifest: readonly StaleSnapshotManifestEntry[],
): Promise<number> {
  return admin.$transaction(
    async (tx) => {
      // Le client peut déjà porter le rôle owner via son option de connexion (probes post-split).
      // Toute recovery revient d'abord explicitement au déployeur authentifié, seule autorité
      // habilitée sur Storage, puis prouve chaque bascule suivante.
      await assumeSessionUser(tx);
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '30s'`;
      await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended('bob-document-archive-byte-audit', 0))
    `;
      // Le déployeur Supabase possède l'autorité Storage mais seulement SET vers l'owner NOLOGIN
      // des tables publiques. Le verrou advisory sérialise nos certificats ; ces verrous ferment
      // en plus les prédicats d'absence face à tous les writers N/N-1, sans aucun GRANT temporaire.
      await tx.$executeRawUnsafe(CERT_RECOVERY_STORAGE_LOCK_STATEMENT);
      await assumeCommonPublicTableOwner(tx, CERT_RECOVERY_PUBLIC_TABLE_NAMES);
      for (const tableName of CERT_RECOVERY_PUBLIC_TABLE_NAMES) {
        await tx.$executeRawUnsafe(`LOCK TABLE public.${tableName} IN SHARE ROW EXCLUSIVE MODE`);
      }
      const manifestByVersionId = new Map(
        expectedManifest.map((entry) => [entry.versionId, entry] as const),
      );
      if (manifestByVersionId.size !== expectedManifest.length) {
        throw new Error('Archive snapshot certification stale manifest contains duplicate IDs.');
      }

      const readValidatedCandidates = async (): Promise<StaleSnapshotVersion[]> => {
        const candidates = await tx.$queryRaw<StaleSnapshotVersion[]>`
        SELECT version.id,
               version."documentId" AS "documentId",
               version.version,
               version."storageKey" AS "storageKey",
               version.sha256,
               version."mimeType" AS "mimeType",
               version."byteSize" AS "byteSize",
               version."createdAt" AS "createdAt",
               version.reason,
               (
                 SELECT count(*) FROM public.document_analyses AS analysis
                  WHERE analysis."documentId" = version."documentId"
                    AND analysis."documentVersion" = version.version
                    AND analysis."sourceSha256" = version.sha256
               ) AS "analysisCount",
               (
                 SELECT count(*) FROM public.document_archive_job_artifacts AS artifact
                  WHERE artifact."documentId" = version."documentId"
                     OR artifact."versionId" = version.id
               ) AS "archiveArtifactCount",
               (
                 SELECT count(*) FROM public.document_archive_artifact_intents AS intent
                  WHERE intent."documentId" = version."documentId"
                     OR intent."versionId" = version.id
               ) AS "archiveIntentCount",
               (
                 SELECT count(*) FROM public.document_invoice_pdf_attestations AS attestation
                  WHERE attestation."documentId" = version."documentId"
                     OR attestation."versionId" = version.id
               ) AS "attestationCount"
          FROM public.document_versions AS version
         WHERE version."documentId" LIKE ${`${CERT_STALE_DOCUMENT_PREFIX}%`}
           AND NOT EXISTS (
             SELECT 1 FROM public.documents AS document
              WHERE document.id = version."documentId"
           )
         ORDER BY version.id
         LIMIT ${CERT_MAX_STALE_VERSIONS + 1}
         FOR UPDATE OF version
      `;
        if (candidates.length > CERT_MAX_STALE_VERSIONS) {
          throw new Error('Archive snapshot certification stale recovery exceeded its safety cap.');
        }
        if (candidates.length === 0) return [];
        if (candidates.length !== expectedManifest.length) {
          throw new Error(
            'Archive snapshot certification stale manifest is only partially present.',
          );
        }

        // Le rôle owner public n'a volontairement aucun droit implicite sur Storage. Le verrou
        // Storage reste détenu par la transaction pendant ce retour borné au session_user ; puis
        // l'owner public est repris avant toute lecture ou mutation SQL métier.
        await assumeSessionUser(tx);
        const storageObjects = await tx.$queryRaw<
          Array<{ storageKey: string; storageObjectCount: bigint }>
        >`
          SELECT object.name AS "storageKey", count(*) AS "storageObjectCount"
            FROM storage.objects AS object
           WHERE object.bucket_id = ${storageBucket}
             AND object.name IN (${Prisma.join(candidates.map(({ storageKey }) => storageKey))})
           GROUP BY object.name
        `;
        await assumeCommonPublicTableOwner(tx, CERT_RECOVERY_PUBLIC_TABLE_NAMES);
        const storageCounts = new Map(
          storageObjects.map(({ storageKey, storageObjectCount }) => [
            storageKey,
            storageObjectCount,
          ]),
        );

        for (const candidate of candidates) {
          const manifestEntry = manifestByVersionId.get(candidate.id);
          const suffix = candidate.documentId.slice(CERT_STALE_DOCUMENT_PREFIX.length);
          const companyA = `archive-snapshot-a-${suffix}`;
          const companyB = `archive-snapshot-b-${suffix}`;
          const customerId = `archive-snapshot-customer-${suffix}`;
          const quoteId = `archive-snapshot-quote-${suffix}`;
          const jobIds = [
            `archive-snapshot-job-${suffix}`,
            `archive-snapshot-malformed-${suffix}`,
            `archive-snapshot-n1-${suffix}`,
          ];
          const expectedStorageKey =
            `companies/${companyA}/documents/${candidate.documentId}/v1/` +
            `${CERT_ARTIFACT_SHA256}.pdf`;
          const [dependencies] = await tx.$queryRaw<
            Array<{
              relatedRowCount: bigint;
            }>
          >`
          SELECT (
                   (SELECT count(*) FROM public.companies AS company
                     WHERE company.id IN (${companyA}, ${companyB}))
                   + (SELECT count(*) FROM public.customers AS customer
                       WHERE customer.id = ${customerId})
                   + (SELECT count(*) FROM public.quotes AS quote
                       WHERE quote.id = ${quoteId})
                   + (SELECT count(*) FROM public.document_archive_jobs AS job
                       WHERE job.id IN (${Prisma.join(jobIds)}))
                   + (SELECT count(*) FROM public.document_archive_render_snapshots AS snapshot
                       WHERE snapshot."jobId" IN (${Prisma.join(jobIds)}))
                 ) AS "relatedRowCount"
        `;
          const exactFixture =
            manifestEntry !== undefined &&
            CERT_UUID_SUFFIX.test(suffix) &&
            candidate.id === `${candidate.documentId}-v1` &&
            candidate.version === 1 &&
            candidate.storageKey === manifestEntry.storageKey &&
            candidate.storageKey === expectedStorageKey &&
            candidate.sha256 === CERT_ARTIFACT_SHA256 &&
            candidate.mimeType === CERT_ARTIFACT_MIME_TYPE &&
            candidate.byteSize === CERT_ARTIFACT_BYTE_SIZE &&
            candidate.createdAt.toISOString() === CERT_ARTIFACT_CREATED_AT &&
            candidate.reason === CERT_ARTIFACT_REASON &&
            candidate.analysisCount === 0n &&
            candidate.archiveArtifactCount === 0n &&
            candidate.archiveIntentCount === 0n &&
            candidate.attestationCount === 0n &&
            dependencies?.relatedRowCount === 0n &&
            (storageCounts.get(candidate.storageKey) ?? 0n) === 0n;
          if (!exactFixture) {
            throw new Error(
              'Archive snapshot certification found a non-canonical stale fixture; cleanup refused.',
            );
          }
        }
        return candidates;
      };

      const candidates = await readValidatedCandidates();
      if (candidates.length === 0) return 0;
      const confirmedCandidates = await readValidatedCandidates();
      if (
        confirmedCandidates.length !== candidates.length ||
        confirmedCandidates.some((candidate, index) => candidate.id !== candidates[index]?.id)
      ) {
        throw new Error('Archive snapshot certification stale manifest changed before cleanup.');
      }
      await assumeCommonPublicTableOwner(tx, [CERT_VERSION_REPRESENTATION_TRIGGER.tableName]);
      const deleted = await withCleanupTriggerDisabled(
        tx,
        CERT_VERSION_REPRESENTATION_TRIGGER,
        () =>
          tx.storedDocumentVersion.deleteMany({
            where: { id: { in: candidates.map(({ id }) => id) } },
          }),
      );
      if (deleted.count !== candidates.length) {
        throw new Error('Archive snapshot certification stale cleanup count diverged.');
      }
      const remaining = await tx.storedDocumentVersion.count({
        where: { id: { in: candidates.map(({ id }) => id) } },
      });
      if (remaining !== 0) {
        throw new Error('Archive snapshot certification stale cleanup is incomplete.');
      }
      return deleted.count;
    },
    {
      // READ COMMITTED donne un snapshot frais après l'attente des verrous explicites ; la
      // seconde lecture ne réutilise donc jamais une image antérieure aux writers drainés.
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10_000,
      timeout: 40_000,
    },
  );
}

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

describe('Archive snapshot — URL de rôle propriétaire du certificat', () => {
  it('préserve les options de connexion et ajoute un rôle owner explicitement SETtable', () => {
    const result = datasourceUrlWithOwnerRole(
      'postgresql://postgres:secret@localhost:5432/bob?sslmode=require&' +
        'options=-c%20statement_timeout%3D30000',
      { ownerName: 'bob_rls_schema_owner_cert', sessionUser: 'postgres' },
    );
    const parsed = new URL(result);
    expect(parsed.protocol).toBe('postgresql:');
    expect(parsed.searchParams.get('sslmode')).toBe('require');
    expect(parsed.searchParams.get('options')).toBe(
      '-c statement_timeout=30000 -c role=bob_rls_schema_owner_cert',
    );
  });

  it('ne réécrit pas une URL PostgreSQL lorsque le session_user est déjà owner', () => {
    const datasourceUrl = 'postgres://postgres:secret@localhost:5432/bob?sslmode=require';
    expect(
      datasourceUrlWithOwnerRole(datasourceUrl, {
        ownerName: 'postgres',
        sessionUser: 'postgres',
      }),
    ).toBe(datasourceUrl);
  });

  it.each([
    ['protocole non PostgreSQL', 'https://localhost/bob', 'owner', 'deployer'],
    ['owner non canonique', 'postgresql://localhost/bob', 'Owner Name', 'deployer'],
    [
      'rôle déjà substitué',
      'postgresql://localhost/bob?options=-crole%3Dother_owner',
      'owner',
      'deployer',
    ],
    [
      'session authorization déjà substituée',
      'postgresql://localhost/bob?options=--session_authorization%3Dother_owner',
      'owner',
      'deployer',
    ],
  ])('refuse %s', (_label, datasourceUrl, ownerName, sessionUser) => {
    expect(() => datasourceUrlWithOwnerRole(datasourceUrl, { ownerName, sessionUser })).toThrow();
  });
});

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Archive snapshot V3 — certification PostgreSQL/RLS réelle',
  () => {
    const suffix = randomUUID();
    const staleProbeSuffix = randomUUID();
    const staleMismatchSuffix = randomUUID();
    const staleMixedExactSuffix = randomUUID();
    const staleMixedMismatchSuffix = randomUUID();
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
    const storageKey = `companies/${companyA}/documents/${documentId}/v1/${artifactSha256}.pdf`;
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    let admin: PrismaClient;
    let deployerAdmin: PrismaClient;
    let runtime: PrismaService;
    let repository: PrismaDocumentArchiveJobRepository;
    let protocolVersion: number;
    let baseArchiveProtocolVersion: number;
    let seal: DocumentArchiveRenderSnapshotSeal;
    let leaseToken: string;
    let storageBucket: string;

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

    const snapshot = (
      data = quoteData(),
    ): Extract<DocumentArchiveRenderSnapshot, { reason: 'quote-signed' }> => ({
      schemaVersion: 1,
      rendererVersion: 1,
      companyId: companyA,
      pieceId: quoteId,
      reason: 'quote-signed',
      metadataCreatedAt: '2026-08-04T12:00:00.000Z',
      artifacts: [
        {
          kind: 'signed_quote',
          expectedContentProfile: 'plain_pdf',
          documentId,
          versionId,
          filename: artifactFilename,
          mimeType: 'application/pdf',
          linkedEntityType: 'quote',
          documentDate: '2026-08-04',
          issuedAt: '2026-08-04',
        },
      ],
      payload: { kind: 'quote', data },
    });

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (runtime) et DIRECT_URL (admin) sont requis.');
      }
      if (!CERT_ALLOWED_RELEASE_ENVIRONMENTS.has(process.env.CABINET_RELEASE_ENV ?? '')) {
        throw new Error(
          'Archive snapshot PostgreSQL certification is restricted to development and staging.',
        );
      }
      storageBucket = process.env.SUPABASE_STORAGE_BUCKET?.trim() ?? '';
      if (!storageBucket) {
        throw new Error('SUPABASE_STORAGE_BUCKET is required for snapshot stale recovery.');
      }
      deployerAdmin = new PrismaClient({ datasourceUrl: directUrl, errorFormat: 'minimal' });
      admin = deployerAdmin;
      runtime = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
      repository = new PrismaDocumentArchiveJobRepository(runtime);
      await Promise.all([admin.$connect(), runtime.$connect()]);
      const recoveryManifest =
        process.env.CABINET_RELEASE_ENV === 'staging' ? CERT_STAGING_INCIDENT_MANIFEST : [];
      await recoverStaleSnapshotVersions(admin, storageBucket, recoveryManifest);
      if ((await recoverStaleSnapshotVersions(admin, storageBucket, recoveryManifest)) !== 0) {
        throw new Error('Archive snapshot certification stale recovery is not idempotent.');
      }
      const ownerFacts = await admin.$transaction((tx) =>
        assumeCommonPublicTableOwner(tx, CERT_MAIN_FIXTURE_CLEANUP_TABLES),
      );
      const ownerDatasourceUrl = datasourceUrlWithOwnerRole(directUrl, ownerFacts);
      if (ownerDatasourceUrl !== directUrl) {
        // Après l'owner-split Supabase, le déployeur garde uniquement SET vers le rôle NOLOGIN.
        // Le client administrateur du certificat porte donc ce rôle sur chaque connexion du pool ;
        // le session_user reste le déployeur non-superuser et demeure observable par les preuves.
        admin = new PrismaClient({ datasourceUrl: ownerDatasourceUrl, errorFormat: 'minimal' });
        await admin.$connect();
      }

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
          await admin.$transaction(
            async (tx) => {
              await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
              await tx.$executeRaw`SET LOCAL statement_timeout = '30s'`;
              await assumeCommonPublicTableOwner(tx, CERT_MAIN_FIXTURE_CLEANUP_TABLES);
              // La fixture terminale est volontairement incohérente (filename différent) afin de
              // prouver le refus de DONE. Seuls les deux triggers d'immuabilité des enfants sont
              // suspendus pendant leurs DELETE exacts ; FK, cascades, RLS et tous les autres triggers
              // restent actifs pendant le retrait du graphe. Chaque état O/D/R/A est restauré à
              // l'identique : un certificat ne normalise jamais silencieusement la topologie.
              await withCleanupTriggerDisabled(tx, CERT_ARTIFACT_INTENT_IMMUTABILITY_TRIGGER, () =>
                withCleanupTriggerDisabled(
                  tx,
                  CERT_RENDER_SNAPSHOT_IMMUTABILITY_TRIGGER,
                  async () => {
                    await tx.documentArchiveArtifactIntent.deleteMany({
                      where: { companyId: companyA },
                    });
                    await tx.documentArchiveRenderSnapshot.deleteMany({
                      where: { companyId: companyA },
                    });
                  },
                ),
              );
              await tx.documentArchiveJobArtifact.deleteMany({ where: { companyId: companyA } });
              await tx.documentArchiveJob.deleteMany({ where: { companyId: companyA } });
              const deletedVersions = await withCleanupTriggerDisabled(
                tx,
                CERT_VERSION_REPRESENTATION_TRIGGER,
                () =>
                  tx.storedDocumentVersion.deleteMany({
                    where: { documentId },
                  }),
              );
              if (deletedVersions.count > 1) {
                throw new Error(
                  'Archive snapshot certification created unexpected document versions.',
                );
              }
              await tx.storedDocument.deleteMany({ where: { companyId: companyA } });
              await tx.quote.deleteMany({ where: { companyId: companyA } });
              await tx.customer.deleteMany({ where: { companyId: companyA } });
              await tx.company.deleteMany({ where: { id: { in: [companyA, companyB] } } });
              if ((await tx.storedDocumentVersion.count({ where: { documentId } })) !== 0) {
                throw new Error('Archive snapshot certification left a document version behind.');
              }
            },
            { maxWait: 10_000, timeout: 40_000 },
          );
        }
      } finally {
        await Promise.allSettled([
          ...(runtime ? [runtime.$disconnect()] : []),
          ...(admin ? [admin.$disconnect()] : []),
          ...(deployerAdmin && deployerAdmin !== admin ? [deployerAdmin.$disconnect()] : []),
        ]);
      }
    }, 50_000);

    it.skipIf(!RUN_STALE_RECOVERY_PROBES)(
      'récupère uniquement une version synthétique orpheline exacte, puis converge à zéro',
      async () => {
        const staleDocumentId = `${CERT_STALE_DOCUMENT_PREFIX}${staleProbeSuffix}`;
        const staleVersionId = `${staleDocumentId}-v1`;
        const staleStorageKey =
          `companies/archive-snapshot-a-${staleProbeSuffix}/documents/` +
          `${staleDocumentId}/v1/${CERT_ARTIFACT_SHA256}.pdf`;
        await deployerAdmin.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
          await assumeCommonPublicTableOwner(tx, [CERT_VERSION_REPRESENTATION_TRIGGER.tableName]);
          await tx.storedDocumentVersion.create({
            data: {
              id: staleVersionId,
              documentId: staleDocumentId,
              version: 1,
              storageKey: staleStorageKey,
              sha256: CERT_ARTIFACT_SHA256,
              mimeType: CERT_ARTIFACT_MIME_TYPE,
              byteSize: CERT_ARTIFACT_BYTE_SIZE,
              createdAt: new Date(CERT_ARTIFACT_CREATED_AT),
              reason: CERT_ARTIFACT_REASON,
            },
          });
        });

        const manifest = [{ versionId: staleVersionId, storageKey: staleStorageKey }];
        await expect(recoverStaleSnapshotVersions(admin, storageBucket, manifest)).resolves.toBe(1);
        await expect(recoverStaleSnapshotVersions(admin, storageBucket, manifest)).resolves.toBe(0);
      },
    );

    it.skipIf(!RUN_STALE_RECOVERY_PROBES)(
      'refuse sans supprimer une version réservée dont la signature diverge',
      async () => {
        const staleDocumentId = `${CERT_STALE_DOCUMENT_PREFIX}${staleMismatchSuffix}`;
        const staleVersionId = `${staleDocumentId}-v1`;
        await deployerAdmin.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
          await assumeCommonPublicTableOwner(tx, [CERT_VERSION_REPRESENTATION_TRIGGER.tableName]);
          await tx.storedDocumentVersion.create({
            data: {
              id: staleVersionId,
              documentId: staleDocumentId,
              version: 1,
              storageKey:
                `companies/archive-snapshot-a-${staleMismatchSuffix}/documents/` +
                `${staleDocumentId}/v1/${CERT_ARTIFACT_SHA256}.pdf`,
              sha256: CERT_ARTIFACT_SHA256,
              mimeType: CERT_ARTIFACT_MIME_TYPE,
              byteSize: CERT_ARTIFACT_BYTE_SIZE + 1,
              createdAt: new Date(CERT_ARTIFACT_CREATED_AT),
              reason: CERT_ARTIFACT_REASON,
            },
          });
        });

        try {
          await expect(
            recoverStaleSnapshotVersions(admin, storageBucket, [
              {
                versionId: staleVersionId,
                storageKey:
                  `companies/archive-snapshot-a-${staleMismatchSuffix}/documents/` +
                  `${staleDocumentId}/v1/${CERT_ARTIFACT_SHA256}.pdf`,
              },
            ]),
          ).rejects.toThrow('non-canonical stale fixture');
          await expect(
            admin.storedDocumentVersion.count({ where: { id: staleVersionId } }),
          ).resolves.toBe(1);
        } finally {
          await admin.$transaction(async (tx) => {
            const deletedCount = await deleteExactProbeVersions(tx, [staleVersionId]);
            if (deletedCount !== 1) {
              throw new Error('Archive snapshot mismatch probe cleanup count diverged.');
            }
          });
        }
      },
    );

    it.skipIf(!RUN_STALE_RECOVERY_PROBES)(
      'refuse atomiquement un lot mêlant une fixture exacte et une voisine',
      async () => {
        const exactDocumentId = `${CERT_STALE_DOCUMENT_PREFIX}${staleMixedExactSuffix}`;
        const mismatchDocumentId = `${CERT_STALE_DOCUMENT_PREFIX}${staleMixedMismatchSuffix}`;
        const exactVersionId = `${exactDocumentId}-v1`;
        const mismatchVersionId = `${mismatchDocumentId}-v1`;
        const exactStorageKey =
          `companies/archive-snapshot-a-${staleMixedExactSuffix}/documents/` +
          `${exactDocumentId}/v1/${CERT_ARTIFACT_SHA256}.pdf`;
        const mismatchStorageKey =
          `companies/archive-snapshot-a-${staleMixedMismatchSuffix}/documents/` +
          `${mismatchDocumentId}/v1/${CERT_ARTIFACT_SHA256}.pdf`;
        const versionIds = [exactVersionId, mismatchVersionId];
        await deployerAdmin.$transaction(async (tx) => {
          // Cette transaction ne fabrique que les deux lignes orphelines nécessaires à la preuve
          // négative ; aucun cleanup ni autre mutation n'est exécuté avec les FK suspendues.
          await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
          await assumeCommonPublicTableOwner(tx, [CERT_VERSION_REPRESENTATION_TRIGGER.tableName]);
          await tx.storedDocumentVersion.createMany({
            data: [
              {
                id: exactVersionId,
                documentId: exactDocumentId,
                version: 1,
                storageKey: exactStorageKey,
                sha256: CERT_ARTIFACT_SHA256,
                mimeType: CERT_ARTIFACT_MIME_TYPE,
                byteSize: CERT_ARTIFACT_BYTE_SIZE,
                createdAt: new Date(CERT_ARTIFACT_CREATED_AT),
                reason: CERT_ARTIFACT_REASON,
              },
              {
                id: mismatchVersionId,
                documentId: mismatchDocumentId,
                version: 1,
                storageKey: mismatchStorageKey,
                sha256: CERT_ARTIFACT_SHA256,
                mimeType: CERT_ARTIFACT_MIME_TYPE,
                byteSize: CERT_ARTIFACT_BYTE_SIZE + 1,
                createdAt: new Date(CERT_ARTIFACT_CREATED_AT),
                reason: CERT_ARTIFACT_REASON,
              },
            ],
          });
        });

        try {
          await expect(
            recoverStaleSnapshotVersions(admin, storageBucket, [
              { versionId: exactVersionId, storageKey: exactStorageKey },
              { versionId: mismatchVersionId, storageKey: mismatchStorageKey },
            ]),
          ).rejects.toThrow('non-canonical stale fixture');
          await expect(
            admin.storedDocumentVersion.count({
              where: { id: { in: versionIds } },
            }),
          ).resolves.toBe(2);
        } finally {
          await admin.$transaction(async (tx) => {
            const deletedCount = await deleteExactProbeVersions(tx, versionIds);
            if (deletedCount !== versionIds.length) {
              throw new Error('Archive snapshot mixed probe cleanup count diverged.');
            }
          });
        }
      },
    );

    it('certifie rôle runtime, FORCE RLS, ACL Data API et capacité de cutover', async () => {
      const [role] = await runtime.$queryRaw<
        Array<{
          superuser: boolean;
          bypassRls: boolean;
          roleName: string;
        }>
      >`
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
      await expect(
        admin.documentArchiveJob.findUnique({ where: { id: n1JobId } }),
      ).resolves.toBeNull();
    });

    it('accepte le V3 exact/idempotent et refuse conflit, anti-IDOR et JSON à clé substituée', async () => {
      const enqueue = () =>
        runtime.withTenant(companyA, async () => {
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
      const conflictingSeal = sealDocumentArchiveRenderSnapshot(
        snapshot({
          ...quoteData(),
          customerName: 'Autre nom réel',
        }),
      );
      await expect(
        runtime.withTenant(companyA, async () =>
          repository.enqueue({
            id: jobId,
            companyId: companyA,
            pieceId: quoteId,
            reason: 'quote-signed',
            now: new Date().toISOString(),
            renderSnapshot: conflictingSeal,
          }),
        ),
      ).rejects.toThrow('identity conflict');
      await expect(
        runtime.withTenant(companyB, async () =>
          repository.enqueue({
            id: jobId,
            companyId: companyA,
            pieceId: quoteId,
            reason: 'quote-signed',
            now: new Date().toISOString(),
            renderSnapshot: seal,
          }),
        ),
      ).rejects.toThrow('identity conflict');

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
      await expect(admin.documentArchiveJob.count({ where: { id: malformedJobId } })).resolves.toBe(
        0,
      );
      await expect(
        admin.documentArchiveRenderSnapshot.count({ where: { companyId: companyA } }),
      ).resolves.toBe(1);
    });

    it('scelle snapshot/intention et refuse DONE si le filename matérialisé diverge', async () => {
      await expect(
        admin.documentArchiveRenderSnapshot.update({
          where: { jobId },
          data: { payloadSha256: 'e'.repeat(64) },
        }),
      ).rejects.toThrow(/append-only/u);
      await expect(
        admin.documentArchiveRenderSnapshot.delete({ where: { jobId } }),
      ).rejects.toThrow(/append-only/u);

      const [schedule] = await admin.$queryRaw<
        Array<{
          due: boolean;
          nextAttemptAt: Date;
          status: string;
        }>
      >`
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

      const [candidate] = await runtime.withTenant(companyA, async () =>
        repository.listDue(companyA, new Date().toISOString(), 10),
      );
      expect(candidate?.id).toBe(jobId);
      const now = new Date();
      const claim = await runtime.withTenant(companyA, async () =>
        repository.claimForArchive(
          jobId,
          companyA,
          candidate!.updatedAt,
          now.toISOString(),
          new Date(now.getTime() + 60_000).toISOString(),
          leaseToken,
        ),
      );
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
      const prepared = await runtime.withTenant(companyA, async () =>
        repository.prepareArtifactIntents({
          jobId,
          companyId: companyA,
          leaseToken,
          snapshotSha256: seal.sha256,
          intents: [intent],
          now: now.toISOString(),
        }),
      );
      const [prepareFacts] = await admin.$queryRaw<
        Array<{
          intentCount: bigint;
          leaseMatches: boolean;
          leaseOpen: boolean;
          snapshotMatches: boolean;
          status: string;
        }>
      >`
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
        const [validationFacts] = await admin.$queryRaw<
          Array<{
            exactKeyCount: boolean;
            expectedStorageKey: boolean;
            planMatches: boolean;
            shapeMatches: boolean;
          }>
        >`
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
      await expect(
        admin.documentArchiveArtifactIntent.updateMany({
          where: { jobId, kind: 'signed_quote' },
          data: { filename: 'devis-altere.pdf' },
        }),
      ).rejects.toThrow(/append-only/u);
      await expect(
        admin.documentArchiveArtifactIntent.deleteMany({
          where: { jobId, kind: 'signed_quote' },
        }),
      ).rejects.toThrow(/append-only/u);

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
        artifacts: [
          {
            kind: 'signed_quote',
            contentProfile: 'plain_pdf',
            documentId,
            versionId,
            version: 1,
            storageKey,
            mimeType: 'application/pdf',
            byteSize: 42,
            sha256: artifactSha256,
          },
        ],
      };
      await expect(
        runtime.withTenant(companyA, async () =>
          repository.markDone(
            jobId,
            companyA,
            leaseToken,
            proof,
            documentArchiveIntegrityProofSha256(proof),
            now.toISOString(),
          ),
        ),
      ).resolves.toBe(false);
      await expect(
        admin.documentArchiveJob.findUniqueOrThrow({ where: { id: jobId } }),
      ).resolves.toMatchObject({ completedAt: null, integrityProof: null });
    });
  },
);

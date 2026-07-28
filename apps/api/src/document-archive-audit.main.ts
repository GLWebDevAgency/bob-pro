import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import {
  auditDocumentArchivePreactivation,
  buildArchiveDatabaseSnapshotDigest,
  type ArchiveAuditIssue,
  type ArchiveMissingStoredObject,
  type ArchivePreactivationAuditReport,
  type ArchivePreactivationRepository,
  type ArchivePreactivationStorage,
  type ArchiveStorageOrphan,
  type GeneratedLegalRepresentationRow,
  type InvoicePdfAttestationInput,
  type LoadedArchiveObject,
} from './documents/archive-preactivation-audit';
import { inspectInvoicePdfRepresentation } from './documents/pdfa3';

const DEFAULT_MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const STORAGE_FETCH_ATTEMPTS = 3;
const STORAGE_FETCH_TIMEOUT_MS = 30_000;
const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ISSUE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/u;
const STORAGE_BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/u;
const SUPABASE_PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;
const MUSTANG_VERSION = '2.24.0';
const MUSTANG_SHA256 = 'e4904ffa0afdce3f5836dceb927c440a05ed5d60386fdd37e17a4b2f7652edbf';
const FNFE_VERSION = '1.4.0.02';
const VALIDATOR_SANDBOX_EXECUTABLE = '/usr/bin/bwrap';
const VALIDATOR_SANDBOX_SMOKE_SECRET = 'BOB_ARCHIVE_SANDBOX_SMOKE_SECRET';
const VALIDATOR_SANDBOX_SMOKE_SCRIPT = `
  const fs = require('node:fs');
  const os = require('node:os');
  const forbidden = [
    '${VALIDATOR_SANDBOX_SMOKE_SECRET}',
    'DATABASE_URL',
    'DIRECT_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'RAILWAY_TOKEN',
  ];
  if (forbidden.some((name) => process.env[name] !== undefined)) process.exit(71);
  const exposedNetwork = Object.entries(os.networkInterfaces()).some(
    ([name, addresses]) => name !== 'lo' && Array.isArray(addresses) && addresses.length > 0,
  );
  if (exposedNetwork) process.exit(72);
  const writable = process.env.HOME + '/inner-workdir-writable';
  fs.writeFileSync(writable, 'ok', { mode: 0o600 });
  fs.unlinkSync(writable);
  try {
    fs.writeFileSync('/bob-archive-sandbox-rootfs-probe', 'forbidden');
    process.exit(73);
  } catch (error) {
    if (!['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) process.exit(74);
  }
`;
const execFileAsync = promisify(execFile);

interface ArchiveAuditRuntimeConfig {
  directUrl: string;
  databaseUrl: string;
  supabaseUrl: string;
  supabaseProjectRef: string;
  supabaseServiceRoleKey: string;
  bucket: string;
  outputPath: string;
  maxObjectBytes: number;
  applyAttestations: boolean;
  releaseSha: string;
  deploymentId: string;
  mustangJarPath: string;
  fnfeBundlePath: string;
  validatorSandboxPath: string;
}

interface ArchiveProtocolIdentity {
  activeVersion: 1 | 2;
  databaseIdentity: string;
  connectionFingerprint: string;
}

interface ArchiveAuditCounts {
  generatedLegalDocuments: number;
  objectsRead: number;
  existingAttestations: number;
  appliedAttestations: number;
  externallyValidatedProfessionalInvoices: number;
  storageOrphans: number;
  missingStoredObjects: number;
  p0Issues: number;
}

interface ArchiveAuditSafeEnvelope {
  schemaVersion: 1;
  deploymentId: string;
  releaseSha: string;
  readyForActivation: boolean;
  protocolVersion: 1 | 2;
  mode: 'audit' | 'apply-attestations' | 'protocol-v2-verified';
  inventoryDigest: string;
  reportSha256: string;
  validatorEvidenceDigest: string;
  issueCodes: string[];
  counts: ArchiveAuditCounts;
  validators: {
    representationDetector: 1;
    mustang: typeof MUSTANG_VERSION;
    fnfe: typeof FNFE_VERSION;
  };
}

interface ArchiveProtocolV2BaselineEvidence {
  inventoryDigest: string;
  reportSha256: string;
  validatorEvidenceDigest: string;
  validatorVersions: unknown;
  storageBucket: string;
}

interface ArchiveProtocolV2RelationalState {
  databaseIdentity: string;
  activatedAt: Date | null;
  activatedByReleaseSha: string | null;
  generatedLegalDocuments: number;
  invalidGeneratedLegalDocuments: number;
  existingAttestations: number;
  invalidArchiveJobs: number;
  storageOrphans: number;
  missingStoredObjects: number;
  suspiciousStorageMutations: number;
  postScanSnapshotDigest: string;
  baseline: ArchiveProtocolV2BaselineEvidence | null;
}

const PINNED_ARCHIVE_VALIDATORS = {
  representationDetector: 1,
  mustang: MUSTANG_VERSION,
  fnfe: FNFE_VERSION,
} as const;

function compareAuditIssues(left: ArchiveAuditIssue, right: ArchiveAuditIssue): number {
  const leftKey = [
    left.companyId ?? '',
    left.documentId ?? '',
    left.storageKey ?? '',
    left.code,
    left.detail,
  ].join('\u0000');
  const rightKey = [
    right.companyId ?? '',
    right.documentId ?? '',
    right.storageKey ?? '',
    right.code,
    right.detail,
  ].join('\u0000');
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function buildProtocolV2VerifiedReport(input: {
  byteAudit: ArchivePreactivationAuditReport;
  relational: ArchiveProtocolV2RelationalState;
  auditedAt: Date;
  releaseSha: string;
  storageBucket: string;
}): ArchivePreactivationAuditReport {
  const { byteAudit, relational } = input;
  if (
    byteAudit.protocolVersion !== 2 ||
    byteAudit.releaseSha !== input.releaseSha ||
    byteAudit.storageBucket !== input.storageBucket ||
    !SHA256_PATTERN.test(byteAudit.databaseSnapshotDigest)
  ) {
    throw new Error('Le scan octet V2 ne correspond pas au protocole ou à la release vérifiée.');
  }

  const issues = [...byteAudit.issues];
  const addIssue = (code: string, detail: string): void => {
    issues.push({ severity: 'P0', code, detail });
  };
  if (
    relational.activatedAt === null ||
    relational.activatedByReleaseSha === null ||
    !RELEASE_SHA_PATTERN.test(relational.activatedByReleaseSha)
  ) {
    addIssue(
      'ARCHIVE_PROTOCOL_V2_ACTIVATION_PROOF_INVALID',
      'Le protocole V2 actif ne porte pas une preuve d’activation canonique.',
    );
  }
  if (relational.invalidGeneratedLegalDocuments > 0) {
    addIssue(
      'ARCHIVE_PROTOCOL_V2_GENERATED_REPRESENTATION_INVALID',
      'Au moins une représentation légale générée viole les invariants V2.',
    );
  }
  if (relational.invalidArchiveJobs > 0) {
    addIssue(
      'ARCHIVE_PROTOCOL_V2_JOB_PROOF_INVALID',
      'Au moins un ordre d’archive ou une preuve terminée viole les invariants V2.',
    );
  }
  if (relational.storageOrphans > 0) {
    addIssue(
      'ARCHIVE_PROTOCOL_V2_STORAGE_ORPHAN_PRESENT',
      'Au moins un objet du coffre ne possède aucune référence SQL au contrôle final.',
    );
  }
  if (relational.missingStoredObjects > 0) {
    addIssue(
      'ARCHIVE_PROTOCOL_V2_STORED_OBJECT_MISSING',
      'Au moins une référence SQL du coffre ne possède plus son objet au contrôle final.',
    );
  }
  if (relational.suspiciousStorageMutations !== 0) {
    addIssue(
      'ARCHIVE_PROTOCOL_V2_STORAGE_MUTATION_SUSPECTED',
      'Un original légal a été remplacé après sa version immuable ou ne peut plus être relié au coffre.',
    );
  }
  if (byteAudit.databaseSnapshotDigest !== relational.postScanSnapshotDigest) {
    addIssue(
      'ARCHIVE_PROTOCOL_V2_SCAN_RACE_DETECTED',
      'L’inventaire SQL/Storage a changé pendant le scan octet ; la preuve est refusée.',
    );
  }
  if (byteAudit.counts.generatedLegalDocuments !== relational.generatedLegalDocuments) {
    addIssue(
      'ARCHIVE_PROTOCOL_V2_DOCUMENT_COUNT_CHANGED',
      'Le nombre de représentations légales a changé pendant le scan octet.',
    );
  }
  if (byteAudit.counts.appliedAttestations !== 0) {
    addIssue(
      'ARCHIVE_PROTOCOL_V2_LATE_ATTESTATION_WRITE',
      'Le scan V2 a tenté une écriture historique interdite.',
    );
  }
  if (relational.baseline === null) {
    addIssue(
      'ARCHIVE_PROTOCOL_V2_BASELINE_EVIDENCE_MISSING',
      'La preuve byte-derived ayant autorisé l’activation V2 est absente.',
    );
  } else {
    if (relational.baseline.storageBucket !== input.storageBucket) {
      addIssue(
        'ARCHIVE_PROTOCOL_V2_STORAGE_BUCKET_MISMATCH',
        'Le bucket actif ne correspond pas à celui certifié lors du cutover V2.',
      );
    }
    if (!exactValidatorVersions(relational.baseline.validatorVersions)) {
      addIssue(
        'ARCHIVE_PROTOCOL_V2_VALIDATOR_BASELINE_MISMATCH',
        'La preuve historique ne correspond pas aux versions normatives épinglées.',
      );
    }
  }

  const canonicalState = {
    schemaVersion: 2,
    byteInventoryDigest: byteAudit.inventoryDigest,
    preScanSnapshotDigest: byteAudit.databaseSnapshotDigest,
    postScanSnapshotDigest: relational.postScanSnapshotDigest,
    databaseIdentity: relational.databaseIdentity,
    activatedAt: relational.activatedAt?.toISOString() ?? null,
    activatedByReleaseSha: relational.activatedByReleaseSha,
    generatedLegalDocuments: relational.generatedLegalDocuments,
    invalidGeneratedLegalDocuments: relational.invalidGeneratedLegalDocuments,
    existingAttestations: relational.existingAttestations,
    invalidArchiveJobs: relational.invalidArchiveJobs,
    storageOrphans: relational.storageOrphans,
    missingStoredObjects: relational.missingStoredObjects,
    suspiciousStorageMutations: relational.suspiciousStorageMutations,
    baselineInventoryDigest: relational.baseline?.inventoryDigest ?? null,
    baselineReportSha256: relational.baseline?.reportSha256 ?? null,
    baselineValidatorEvidenceDigest: relational.baseline?.validatorEvidenceDigest ?? null,
    baselineStorageBucket: relational.baseline?.storageBucket ?? null,
  };
  const inventoryDigest = createHash('sha256')
    .update(JSON.stringify(canonicalState), 'utf8')
    .digest('hex');
  issues.sort(compareAuditIssues);
  return {
    ...byteAudit,
    auditedAt: input.auditedAt.toISOString(),
    inventoryDigest,
    mode: 'protocol-v2-verified',
    readyForActivation: issues.length === 0,
    counts: {
      ...byteAudit.counts,
      generatedLegalDocuments: relational.generatedLegalDocuments,
      storageOrphans: relational.storageOrphans,
      missingStoredObjects: relational.missingStoredObjects,
      appliedAttestations: 0,
      p0Issues: issues.length,
    },
    issues,
  };
}

function required(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`${key} est requis pour l’audit Archive V2.`);
  return value;
}

export function parseArchiveAuditRuntimeConfig(
  environment: NodeJS.ProcessEnv,
): ArchiveAuditRuntimeConfig {
  const applyRaw = environment.DOCUMENT_ARCHIVE_AUDIT_APPLY_ATTESTATIONS?.trim() ?? 'false';
  if (applyRaw !== 'true' && applyRaw !== 'false') {
    throw new Error('DOCUMENT_ARCHIVE_AUDIT_APPLY_ATTESTATIONS doit valoir true ou false.');
  }
  const maxBytesRaw = environment.DOCUMENT_ARCHIVE_AUDIT_MAX_OBJECT_BYTES?.trim();
  const maxObjectBytes = maxBytesRaw === undefined ? DEFAULT_MAX_OBJECT_BYTES : Number(maxBytesRaw);
  if (
    !Number.isSafeInteger(maxObjectBytes) ||
    maxObjectBytes <= 0 ||
    maxObjectBytes > 512 * 1024 * 1024
  ) {
    throw new Error(
      'DOCUMENT_ARCHIVE_AUDIT_MAX_OBJECT_BYTES doit être un entier entre 1 et 536870912.',
    );
  }
  const releaseSha = (environment.RELEASE_SHA ?? environment.RAILWAY_GIT_COMMIT_SHA)
    ?.trim()
    .toLowerCase();
  if (!releaseSha || !RELEASE_SHA_PATTERN.test(releaseSha)) {
    throw new Error(
      'RELEASE_SHA (ou RAILWAY_GIT_COMMIT_SHA) doit être un SHA Git complet de 40 caractères.',
    );
  }
  const deploymentId = required(environment, 'DOCUMENT_ARCHIVE_AUDIT_DEPLOYMENT_ID').toLowerCase();
  if (!UUID_PATTERN.test(deploymentId)) {
    throw new Error('DOCUMENT_ARCHIVE_AUDIT_DEPLOYMENT_ID doit être un UUID canonique.');
  }
  const supabaseUrl = required(environment, 'SUPABASE_URL').replace(/\/$/u, '');
  const parsedSupabaseUrl = new URL(supabaseUrl);
  const supabaseProjectRef = required(
    environment,
    'DOCUMENT_ARCHIVE_SUPABASE_PROJECT_REF',
  ).toLowerCase();
  if (
    parsedSupabaseUrl.protocol !== 'https:' ||
    parsedSupabaseUrl.username !== '' ||
    parsedSupabaseUrl.password !== '' ||
    parsedSupabaseUrl.pathname !== '/' ||
    parsedSupabaseUrl.search !== '' ||
    parsedSupabaseUrl.hash !== ''
  ) {
    throw new Error('SUPABASE_URL doit être une origine HTTPS sans identifiants ni chemin.');
  }
  if (
    !SUPABASE_PROJECT_REF_PATTERN.test(supabaseProjectRef) ||
    parsedSupabaseUrl.hostname !== `${supabaseProjectRef}.supabase.co`
  ) {
    throw new Error('SUPABASE_URL doit cibler exactement DOCUMENT_ARCHIVE_SUPABASE_PROJECT_REF.');
  }
  const bucket = required(environment, 'SUPABASE_STORAGE_BUCKET');
  if (!STORAGE_BUCKET_PATTERN.test(bucket)) {
    throw new Error('SUPABASE_STORAGE_BUCKET doit être un identifiant canonique.');
  }
  const validatorSandboxPath = resolve(required(environment, 'DOCUMENT_ARCHIVE_VALIDATOR_SANDBOX'));
  if (validatorSandboxPath !== VALIDATOR_SANDBOX_EXECUTABLE) {
    throw new Error(
      `DOCUMENT_ARCHIVE_VALIDATOR_SANDBOX doit cibler exactement ${VALIDATOR_SANDBOX_EXECUTABLE}.`,
    );
  }
  return {
    directUrl: required(environment, 'DIRECT_URL'),
    databaseUrl: required(environment, 'DATABASE_URL'),
    supabaseUrl,
    supabaseProjectRef,
    supabaseServiceRoleKey: required(environment, 'SUPABASE_SERVICE_ROLE_KEY'),
    bucket,
    outputPath: resolve(required(environment, 'DOCUMENT_ARCHIVE_AUDIT_OUTPUT')),
    maxObjectBytes,
    applyAttestations: applyRaw === 'true',
    releaseSha,
    deploymentId,
    mustangJarPath: resolve(required(environment, 'DOCUMENT_ARCHIVE_MUSTANG_JAR')),
    fnfeBundlePath: resolve(required(environment, 'DOCUMENT_ARCHIVE_FNFE_BUNDLE')),
    validatorSandboxPath,
  };
}

export function buildExternalValidatorEnvironment(
  environment: NodeJS.ProcessEnv,
  workDirectory: string,
): NodeJS.ProcessEnv {
  return {
    PATH: environment.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: workDirectory,
    TMPDIR: workDirectory,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CI: 'true',
  };
}

function prismaFor(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } });
}

function exactValidatorVersions(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    record.representationDetector === PINNED_ARCHIVE_VALIDATORS.representationDetector &&
    record.mustang === PINNED_ARCHIVE_VALIDATORS.mustang &&
    record.fnfe === PINNED_ARCHIVE_VALIDATORS.fnfe
  );
}

class PrismaArchivePreactivationRepository implements ArchivePreactivationRepository {
  constructor(
    private readonly authority: PrismaClient,
    private readonly runtime: PrismaClient,
    private readonly lease: PrismaClient,
    private readonly bucket: string,
  ) {}

  private async queryProtocolIdentity(
    client: Pick<PrismaClient, '$queryRawUnsafe'>,
  ): Promise<ArchiveProtocolIdentity> {
    const rows = await client.$queryRawUnsafe<
      Array<{
        activeVersion: number;
        databaseIdentity: string;
        databaseName: string;
        serverAddress: string | null;
        serverPort: number | null;
        postmasterStartedAt: Date;
      }>
    >(`
      SELECT "activeVersion" AS "activeVersion",
             "databaseIdentity"::text AS "databaseIdentity",
             current_database() AS "databaseName",
             inet_server_addr()::text AS "serverAddress",
             inet_server_port() AS "serverPort",
             pg_postmaster_start_time() AS "postmasterStartedAt"
        FROM public.document_archive_protocol_state
       WHERE id = 1
    `);
    const row = rows[0];
    if (
      rows.length !== 1 ||
      row === undefined ||
      (row.activeVersion !== 1 && row.activeVersion !== 2) ||
      !UUID_PATTERN.test(row.databaseIdentity)
    ) {
      throw new Error('Le singleton de protocole Archive est absent ou invalide.');
    }
    return {
      activeVersion: row.activeVersion,
      databaseIdentity: row.databaseIdentity,
      connectionFingerprint: createHash('sha256')
        .update(
          JSON.stringify({
            databaseName: row.databaseName,
            serverAddress: row.serverAddress,
            serverPort: row.serverPort,
            postmasterStartedAt: row.postmasterStartedAt.toISOString(),
          }),
          'utf8',
        )
        .digest('hex'),
    };
  }

  async assertAuthorities(applyAttestations: boolean): Promise<ArchiveProtocolIdentity> {
    const [runtimeIdentity, authorityIdentity] = await Promise.all([
      this.queryProtocolIdentity(this.runtime),
      this.queryProtocolIdentity(this.authority),
    ]);
    if (
      runtimeIdentity.databaseIdentity !== authorityIdentity.databaseIdentity ||
      runtimeIdentity.connectionFingerprint !== authorityIdentity.connectionFingerprint
    ) {
      throw new Error('DATABASE_URL et DIRECT_URL ne ciblent pas la même instance PostgreSQL.');
    }
    const runtimeRoles = await this.runtime.$queryRawUnsafe<
      Array<{
        roleName: string;
        superuser: boolean;
        bypassRls: boolean;
        canAttest: boolean;
        canAttestHistory: boolean;
      }>
    >(`
      SELECT current_user AS "roleName",
             role.rolsuper AS superuser,
             role.rolbypassrls AS "bypassRls",
             has_function_privilege(
               current_user,
               'public.attest_generated_invoice_pdf_v1(text,text,text,text,text,text,smallint)',
               'EXECUTE'
             ) AS "canAttest",
             has_function_privilege(
               current_user,
               'public.attest_historical_generated_invoice_pdf_v1(text,text,text,text,text,text,smallint)',
               'EXECUTE'
             ) AS "canAttestHistory"
        FROM pg_catalog.pg_roles AS role
       WHERE role.rolname = current_user
    `);
    const runtimeRole = runtimeRoles[0];
    if (
      runtimeRole === undefined ||
      runtimeRole.superuser ||
      runtimeRole.bypassRls ||
      !runtimeRole.canAttest ||
      (applyAttestations && authorityIdentity.activeVersion === 1 && !runtimeRole.canAttestHistory)
    ) {
      throw new Error(
        'DATABASE_URL doit utiliser le rôle applicatif NOSUPERUSER/NOBYPASSRLS autorisé à attester.',
      );
    }
    const authorities = await this.authority.$queryRawUnsafe<
      Array<{
        superuser: boolean;
        bypassRls: boolean;
        canReadDocuments: boolean;
        canReadStorage: boolean;
        canReadBuckets: boolean;
        canWriteEvidence: boolean;
      }>
    >(`
      SELECT role.rolsuper AS superuser,
             role.rolbypassrls AS "bypassRls",
             has_table_privilege(current_user, 'public.documents', 'SELECT') AS "canReadDocuments",
             has_table_privilege(current_user, 'storage.objects', 'SELECT') AS "canReadStorage",
             has_table_privilege(current_user, 'storage.buckets', 'SELECT') AS "canReadBuckets",
             has_table_privilege(
               current_user,
               'public.document_archive_audit_evidence',
               'INSERT'
             ) AS "canWriteEvidence"
        FROM pg_catalog.pg_roles AS role
       WHERE role.rolname = current_user
    `);
    if (
      (!authorities[0]?.superuser && !authorities[0]?.bypassRls) ||
      !authorities[0]?.canReadDocuments ||
      !authorities[0]?.canReadStorage ||
      !authorities[0]?.canReadBuckets ||
      !authorities[0]?.canWriteEvidence
    ) {
      throw new Error(
        'DIRECT_URL doit être une autorité BYPASSRLS avec lecture Storage et écriture de preuve.',
      );
    }
    const buckets = await this.authority.$queryRawUnsafe<Array<{ isPublic: boolean }>>(
      `
      SELECT bucket.public AS "isPublic"
        FROM storage.buckets AS bucket
       WHERE bucket.id = $1
    `,
      this.bucket,
    );
    if (buckets.length !== 1 || buckets[0]?.isPublic !== false) {
      throw new Error('Le bucket documentaire doit exister une seule fois et rester privé.');
    }
    return authorityIdentity;
  }

  async databaseNow(): Promise<Date> {
    const rows = await this.authority.$queryRawUnsafe<Array<{ now: Date }>>(
      'SELECT clock_timestamp() AS now',
    );
    const now = rows[0]?.now;
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error('L’horloge PostgreSQL de l’archive est indisponible.');
    }
    return now;
  }

  async withExclusiveAuditLease<T>(work: () => Promise<T>): Promise<T> {
    return this.lease.$transaction(
      async (transaction) => {
        await transaction.$executeRawUnsafe("SET LOCAL idle_in_transaction_session_timeout = '0'");
        const locks = await transaction.$queryRawUnsafe<Array<{ acquired: boolean }>>(`
          SELECT pg_try_advisory_xact_lock(
            hashtextextended('bob-document-archive-byte-audit', 0)
          ) AS acquired
        `);
        if (locks.length !== 1 || locks[0]?.acquired !== true) {
          throw new Error('Un autre audit Archive byte-derived est déjà actif.');
        }
        return work();
      },
      { isolationLevel: 'ReadCommitted', maxWait: 5_000, timeout: 10_800_000 },
    );
  }

  private listGeneratedLegalRepresentations(
    client: Pick<PrismaClient, '$queryRawUnsafe'>,
  ): Promise<GeneratedLegalRepresentationRow[]> {
    return client.$queryRawUnsafe<GeneratedLegalRepresentationRow[]>(
      `
      SELECT document."companyId" AS "companyId",
             document.id AS "documentId",
             document.kind::text AS kind,
             document.origin::text AS origin,
             document.status::text AS status,
             document."storageKey" AS "storageKey",
             object.id::text AS "storageObjectId",
             object.created_at AS "storageObjectCreatedAt",
             object.updated_at AS "storageObjectUpdatedAt",
             btrim(document.sha256::text) AS sha256,
             document."mimeType" AS "mimeType",
             document."byteSize" AS "byteSize",
             document."linkedEntityType"::text AS "linkedEntityType",
             document."linkedEntityId" AS "linkedEntityId",
             version.id AS "versionId",
             version.version AS "versionNumber",
             (
               SELECT count(*)::integer
                 FROM public.document_versions AS all_versions
                WHERE all_versions."documentId" = document.id
             ) AS "versionCount",
             version."storageKey" AS "versionStorageKey",
             btrim(version.sha256::text) AS "versionSha256",
             version."mimeType" AS "versionMimeType",
             version."byteSize" AS "versionByteSize",
             version.reason AS "versionReason",
             invoice."archiveAudienceAtIssuance" AS "invoiceAudience",
             invoice.status::text AS "invoiceStatus",
             invoice.number AS "invoiceNumber",
             invoice."issuedAt" AS "invoiceIssuedAt",
             quote.status::text AS "quoteStatus",
             quote."signedAt" AS "quoteSignedAt",
             attestation.profile AS "attestationProfile",
             btrim(attestation."documentSha256"::text) AS "attestationDocumentSha256",
             btrim(attestation."embeddedXmlSha256"::text) AS "attestationEmbeddedXmlSha256",
             attestation."detectorVersion" AS "attestationDetectorVersion"
        FROM public.documents AS document
        LEFT JOIN public.document_versions AS version
          ON version."documentId" = document.id
         AND version.version = 1
        LEFT JOIN storage.objects AS object
          ON object.bucket_id = $1
         AND object.name = document."storageKey"
        LEFT JOIN public.document_invoice_pdf_attestations AS attestation
          ON attestation."companyId" = document."companyId"
         AND attestation."documentId" = document.id
         AND attestation."versionId" = version.id
        LEFT JOIN public.invoices AS invoice
          ON invoice."companyId" = document."companyId"
         AND invoice.id = document."linkedEntityId"
        LEFT JOIN public.quotes AS quote
          ON quote."companyId" = document."companyId"
         AND quote.id = document."linkedEntityId"
       WHERE document.origin = 'generated'::public."StoredDocumentOrigin"
         AND document.kind IN (
           'invoice_pdf'::public."StoredDocumentKind",
           'facturx_xml'::public."StoredDocumentKind",
           'signed_quote'::public."StoredDocumentKind"
         )
       ORDER BY document."companyId", document."linkedEntityId", document.kind, document.id
    `,
      this.bucket,
    );
  }

  private listStorageOrphans(
    client: Pick<PrismaClient, '$queryRawUnsafe'>,
  ): Promise<ArchiveStorageOrphan[]> {
    return client.$queryRawUnsafe<ArchiveStorageOrphan[]>(
      `
      SELECT object.name AS "storageKey", object.created_at AS "createdAt"
       FROM storage.objects AS object
       WHERE object.bucket_id = $1
         AND (
           object.name LIKE 'companies/%/documents/%'
           OR object.name LIKE 'companies/%/chantiers/%'
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.documents AS document
            WHERE document."storageKey" = object.name
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.document_versions AS version
            WHERE version."storageKey" = object.name
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.chantier_photos AS photo
            WHERE photo."storageKey" = object.name
         )
       ORDER BY object.created_at, object.name
    `,
      this.bucket,
    );
  }

  private listMissingStoredObjects(
    client: Pick<PrismaClient, '$queryRawUnsafe'>,
  ): Promise<ArchiveMissingStoredObject[]> {
    return client.$queryRawUnsafe<ArchiveMissingStoredObject[]>(
      `
      WITH referenced_objects AS (
        SELECT document."storageKey" AS "storageKey",
               ('document:' || document.id)::text AS reference
          FROM public.documents AS document
        UNION ALL
        SELECT version."storageKey" AS "storageKey",
               ('version:' || version.id)::text AS reference
          FROM public.document_versions AS version
        UNION ALL
        SELECT photo."storageKey" AS "storageKey",
               ('chantier_photo:' || photo.id)::text AS reference
          FROM public.chantier_photos AS photo
      )
      SELECT reference."storageKey" AS "storageKey",
             array_agg(reference.reference ORDER BY reference.reference) AS "referencedBy"
        FROM referenced_objects AS reference
        LEFT JOIN storage.objects AS object
          ON object.bucket_id = $1
         AND object.name = reference."storageKey"
       WHERE object.id IS NULL
       GROUP BY reference."storageKey"
       ORDER BY reference."storageKey"
    `,
      this.bucket,
    );
  }

  async readSnapshot(): Promise<{
    protocolVersion: number;
    databaseFingerprint: string;
    generatedLegalRepresentations: GeneratedLegalRepresentationRow[];
    storageOrphans: ArchiveStorageOrphan[];
    missingStoredObjects: ArchiveMissingStoredObject[];
  }> {
    return this.authority.$transaction(
      async (transaction) => {
        await transaction.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        const identity = await this.queryProtocolIdentity(transaction);
        const databaseFingerprint = createHash('sha256')
          .update(`bob-document-archive-database:${identity.databaseIdentity}`, 'utf8')
          .digest('hex');
        const generatedLegalRepresentations =
          await this.listGeneratedLegalRepresentations(transaction);
        const storageOrphans = await this.listStorageOrphans(transaction);
        const missingStoredObjects = await this.listMissingStoredObjects(transaction);
        return {
          protocolVersion: identity.activeVersion,
          databaseFingerprint,
          generatedLegalRepresentations,
          storageOrphans,
          missingStoredObjects,
        };
      },
      { isolationLevel: 'RepeatableRead', maxWait: 5_000, timeout: 60_000 },
    );
  }

  async verifyActiveProtocolV2(input: {
    byteAudit: ArchivePreactivationAuditReport;
    auditedAt: Date;
    releaseSha: string;
    storageBucket: string;
  }): Promise<ArchivePreactivationAuditReport> {
    return this.authority.$transaction(
      async (transaction) => {
        await transaction.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        const protocolRows = await transaction.$queryRawUnsafe<
          Array<{
            activeVersion: number;
            databaseIdentity: string;
            activatedAt: Date | null;
            activatedByReleaseSha: string | null;
          }>
        >(`
        SELECT "activeVersion" AS "activeVersion",
               "databaseIdentity"::text AS "databaseIdentity",
               "activatedAt" AS "activatedAt",
               btrim("activatedByReleaseSha"::text) AS "activatedByReleaseSha"
          FROM public.document_archive_protocol_state
         WHERE id = 1
      `);
        const protocol = protocolRows[0];
        if (
          protocolRows.length !== 1 ||
          protocol === undefined ||
          protocol.activeVersion !== 2 ||
          !UUID_PATTERN.test(protocol.databaseIdentity)
        ) {
          throw new Error('La vérification relationnelle V2 exige un protocole actif unique.');
        }

        const counters = await transaction.$queryRawUnsafe<
          Array<{
            generatedLegalDocuments: number;
            invalidGeneratedLegalDocuments: number;
            existingAttestations: number;
            invalidArchiveJobs: number;
          }>
        >(`
        SELECT (
                 SELECT count(*)::integer
                   FROM public.documents AS document
                  WHERE document.origin = 'generated'::public."StoredDocumentOrigin"
                    AND document.kind IN (
                      'invoice_pdf'::public."StoredDocumentKind",
                      'facturx_xml'::public."StoredDocumentKind",
                      'signed_quote'::public."StoredDocumentKind"
                    )
               ) AS "generatedLegalDocuments",
               (
                 SELECT count(*)::integer
                   FROM public.documents AS document
                  WHERE document.origin = 'generated'::public."StoredDocumentOrigin"
                    AND document.kind IN (
                      'invoice_pdf'::public."StoredDocumentKind",
                      'facturx_xml'::public."StoredDocumentKind",
                      'signed_quote'::public."StoredDocumentKind"
                    )
                    AND NOT coalesce(
                      public.generated_legal_archive_representation_v2_is_valid(document.id),
                      FALSE
                    )
               ) AS "invalidGeneratedLegalDocuments",
               (
                 SELECT count(*)::integer
                   FROM public.document_invoice_pdf_attestations
               ) AS "existingAttestations",
               (
                 SELECT count(*)::integer
                   FROM public.document_archive_jobs AS job
                  WHERE NOT coalesce(
                          public.document_archive_job_scope_v2_is_valid(
                            job."companyId", job."invoiceId", job.reason
                          ),
                          FALSE
                        )
                     OR (
                       job."completedAt" IS NOT NULL
                       AND (
                         job."integrityProof" IS NULL
                         OR NOT coalesce(
                           public.document_archive_job_pdf_attestation_v2_is_valid(
                             job."companyId", job."invoiceId", job.reason, job."integrityProof"
                           ),
                           FALSE
                         )
                       )
                     )
               ) AS "invalidArchiveJobs"
      `);
        const counter = counters[0];
        if (counter === undefined) throw new Error('Les compteurs Archive V2 sont indisponibles.');

        const generatedLegalRepresentations =
          await this.listGeneratedLegalRepresentations(transaction);
        const storageOrphans = await this.listStorageOrphans(transaction);
        const missingStoredObjects = await this.listMissingStoredObjects(transaction);
        const baselineRows = await transaction.$queryRawUnsafe<
          Array<{
            inventoryDigest: string;
            reportSha256: string;
            validatorEvidenceDigest: string;
            validatorVersions: unknown;
            storageBucket: string;
          }>
        >(
          `
          SELECT btrim(evidence."inventoryDigest"::text) AS "inventoryDigest",
                 btrim(evidence."reportSha256"::text) AS "reportSha256",
                 btrim(evidence."validatorEvidenceDigest"::text) AS "validatorEvidenceDigest",
                 evidence."validatorVersions" AS "validatorVersions",
                 evidence."storageBucket" AS "storageBucket"
            FROM public.document_archive_audit_evidence AS evidence
           WHERE evidence."databaseIdentity" = $1::uuid
             AND evidence."protocolVersion" = 1
             AND evidence.mode = 'apply-attestations'
             AND evidence."readyForActivation"
             AND evidence.counts->>'p0Issues' = '0'
             AND evidence."releaseSha" = $2
             AND evidence."auditedAt" <= $3::timestamptz
             AND evidence."createdAt" <= $3::timestamptz
           ORDER BY evidence."auditedAt" DESC, evidence."createdAt" DESC, evidence.id DESC
           LIMIT 1
        `,
          protocol.databaseIdentity,
          protocol.activatedByReleaseSha,
          protocol.activatedAt,
        );
        const baseline = baselineRows[0];
        const storageMutationRows = await transaction.$queryRawUnsafe<
          Array<{ suspiciousStorageMutations: number }>
        >(
          `
          SELECT count(*)::integer AS "suspiciousStorageMutations"
            FROM public.documents AS document
            LEFT JOIN public.document_versions AS version
              ON version."documentId" = document.id
             AND version.version = 1
            LEFT JOIN storage.objects AS object
              ON object.bucket_id = $1
             AND object.name = document."storageKey"
           WHERE document.origin = 'generated'::public."StoredDocumentOrigin"
             AND document.kind IN (
               'invoice_pdf'::public."StoredDocumentKind",
               'facturx_xml'::public."StoredDocumentKind",
               'signed_quote'::public."StoredDocumentKind"
             )
             AND (
               version.id IS NULL
               OR object.id IS NULL
               OR object.updated_at IS NULL
               OR object.updated_at > greatest(document."createdAt", version."createdAt")
             )
        `,
          input.storageBucket,
        );
        return buildProtocolV2VerifiedReport({
          byteAudit: input.byteAudit,
          auditedAt: input.auditedAt,
          releaseSha: input.releaseSha,
          storageBucket: input.storageBucket,
          relational: {
            databaseIdentity: protocol.databaseIdentity,
            activatedAt: protocol.activatedAt,
            activatedByReleaseSha: protocol.activatedByReleaseSha,
            generatedLegalDocuments: counter.generatedLegalDocuments,
            invalidGeneratedLegalDocuments: counter.invalidGeneratedLegalDocuments,
            existingAttestations: counter.existingAttestations,
            invalidArchiveJobs: counter.invalidArchiveJobs,
            storageOrphans: storageOrphans.length,
            missingStoredObjects: missingStoredObjects.length,
            suspiciousStorageMutations: storageMutationRows[0]?.suspiciousStorageMutations ?? -1,
            postScanSnapshotDigest: buildArchiveDatabaseSnapshotDigest({
              protocolVersion: protocol.activeVersion,
              generatedLegalRepresentations,
              storageOrphans,
              missingStoredObjects,
            }),
            baseline: baseline ?? null,
          },
        });
      },
      { isolationLevel: 'RepeatableRead', maxWait: 5_000, timeout: 120_000 },
    );
  }

  async persistEvidence(input: {
    databaseIdentity: string;
    storageBucket: string;
    envelope: ArchiveAuditSafeEnvelope;
    report: ArchivePreactivationAuditReport;
    auditedAt: string;
  }): Promise<void> {
    await this.authority.$transaction(
      async (transaction) => {
        const protocols = await transaction.$queryRawUnsafe<
          Array<{
            activeVersion: number;
            databaseIdentity: string;
          }>
        >(`
        SELECT "activeVersion" AS "activeVersion",
               "databaseIdentity"::text AS "databaseIdentity"
          FROM public.document_archive_protocol_state
         WHERE id = 1
         FOR SHARE
      `);
        const protocol = protocols[0];
        if (
          protocols.length !== 1 ||
          protocol === undefined ||
          protocol.databaseIdentity !== input.databaseIdentity ||
          protocol.activeVersion !== input.envelope.protocolVersion
        ) {
          throw new Error('Le protocole Archive a changé avant la persistance de la preuve.');
        }
        await transaction.$executeRawUnsafe(
          `
        INSERT INTO public.document_archive_audit_evidence (
          "deploymentId", "releaseSha", "databaseIdentity", "storageBucket",
          "protocolVersion", mode,
          "inventoryDigest", "reportSha256", "validatorEvidenceDigest",
          "validatorVersions", counts, "privateReport", "issueCodes",
          "readyForActivation", "auditedAt"
        ) VALUES (
          $1::uuid, $2, $3::uuid, $4, $5::smallint, $6, $7, $8, $9,
          $10::jsonb, $11::jsonb, $12::jsonb,
          ARRAY(SELECT jsonb_array_elements_text($13::jsonb)),
          $14, $15::timestamptz
        )
      `,
          input.envelope.deploymentId,
          input.envelope.releaseSha,
          input.databaseIdentity,
          input.storageBucket,
          input.envelope.protocolVersion,
          input.envelope.mode,
          input.envelope.inventoryDigest,
          input.envelope.reportSha256,
          input.envelope.validatorEvidenceDigest,
          JSON.stringify(input.envelope.validators),
          JSON.stringify(input.envelope.counts),
          JSON.stringify(input.report),
          JSON.stringify(input.envelope.issueCodes),
          input.envelope.readyForActivation,
          input.auditedAt,
        );
      },
      { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000 },
    );
  }

  async attestInvoicePdfs(inputs: readonly InvoicePdfAttestationInput[]): Promise<boolean> {
    return this.runtime.$transaction(
      async (transaction) => {
        for (const input of inputs) {
          const contexts = await transaction.$queryRawUnsafe<Array<{ companyId: string }>>(
            `SELECT set_config('app.current_company_id', $1, true) AS "companyId"`,
            input.companyId,
          );
          if (contexts[0]?.companyId !== input.companyId) {
            throw new Error('Le contexte tenant PostgreSQL n’a pas été établi.');
          }
          const rows = await transaction.$queryRawUnsafe<Array<{ accepted: boolean }>>(
            `
          SELECT public.attest_historical_generated_invoice_pdf_v1(
            $1, $2, $3, $4, $5, $6, $7::smallint
          ) AS accepted
        `,
            input.companyId,
            input.documentId,
            input.versionId,
            input.documentSha256,
            input.profile,
            input.embeddedXmlSha256,
            input.detectorVersion,
          );
          if (rows.length !== 1 || rows[0]?.accepted !== true) {
            throw new Error(
              'La capacité PostgreSQL a refusé une attestation ; transaction annulée.',
            );
          }
        }
        return true;
      },
      { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 120_000 },
    );
  }
}

function encodeStorageKey(storageKey: string): string {
  return storageKey
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function retryableStorageStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function readResponseSnippet(response: Response, limit = 4_096): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < limit) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const remaining = limit - length;
    chunks.push(chunk.value.subarray(0, remaining));
    length += Math.min(chunk.value.byteLength, remaining);
    if (chunk.value.byteLength > remaining) break;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).toString('utf8');
}

export class SupabaseArchiveAuditStorage implements ArchivePreactivationStorage {
  constructor(
    private readonly baseUrl: string,
    private readonly serviceRoleKey: string,
    private readonly bucket: string,
    private readonly maxObjectBytes: number,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
  ) {}

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.serviceRoleKey}`,
      apikey: this.serviceRoleKey,
    };
  }

  async load(companyId: string, storageKey: string): Promise<LoadedArchiveObject | null> {
    const expectedRoot = `companies/${companyId}/documents/`;
    if (
      !storageKey.startsWith(expectedRoot) ||
      storageKey.includes('..') ||
      storageKey.includes('//') ||
      storageKey.startsWith('/')
    ) {
      throw new Error('Clé Storage hors du périmètre tenant.');
    }
    const url = `${this.baseUrl}/storage/v1/object/${encodeURIComponent(this.bucket)}/${encodeStorageKey(storageKey)}`;
    let response: Response | null = null;
    let lastFailureStatus: number | null = null;
    for (let attempt = 1; attempt <= STORAGE_FETCH_ATTEMPTS; attempt += 1) {
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: this.headers(),
          redirect: 'error',
          signal: AbortSignal.timeout(STORAGE_FETCH_TIMEOUT_MS),
        });
        if (!retryableStorageStatus(response.status) || attempt === STORAGE_FETCH_ATTEMPTS) break;
        lastFailureStatus = response.status;
        await response.body?.cancel().catch(() => undefined);
        response = null;
      } catch {
        if (attempt === STORAGE_FETCH_ATTEMPTS) {
          throw new Error('Supabase Storage est indisponible après trois tentatives bornées.');
        }
      }
      await this.wait(250 * 2 ** (attempt - 1));
    }
    if (response === null) {
      throw new Error(
        lastFailureStatus === null
          ? 'Supabase Storage est indisponible après trois tentatives bornées.'
          : `Supabase Storage reste indisponible (${lastFailureStatus}) après trois tentatives.`,
      );
    }
    if (!response.ok) {
      const errorBody = await readResponseSnippet(response);
      if (
        response.status === 404 ||
        (response.status === 400 && /not_found|"statusCode"\s*:\s*"404"/u.test(errorBody))
      )
        return null;
      throw new Error(`Supabase Storage GET a échoué (${response.status}).`);
    }
    const declaredLength = response.headers.get('content-length');
    if (
      declaredLength !== null &&
      Number.isSafeInteger(Number(declaredLength)) &&
      Number(declaredLength) > this.maxObjectBytes
    ) {
      await response.body?.cancel();
      throw new Error(`Objet supérieur à la limite d’audit (${this.maxObjectBytes} octets).`);
    }
    if (response.body === null) throw new Error('Supabase Storage a répondu sans corps.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteSize = 0;
    let reading = true;
    while (reading) {
      const chunk = await reader.read();
      if (chunk.done) {
        reading = false;
        continue;
      }
      byteSize += chunk.value.byteLength;
      if (byteSize > this.maxObjectBytes) {
        await reader.cancel();
        throw new Error(`Objet supérieur à la limite d’audit (${this.maxObjectBytes} octets).`);
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(byteSize);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      bytes,
      byteSize,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }
}

export function buildValidatorSandboxArguments(input: {
  repositoryRoot: string;
  workDirectory: string;
  command: string;
  arguments: readonly string[];
  additionalEnvironment?: Readonly<Record<string, string>>;
}): string[] {
  if (
    !input.repositoryRoot.startsWith('/') ||
    !input.workDirectory.startsWith('/') ||
    !input.command.startsWith('/')
  ) {
    throw new Error('Les chemins du bac à sable validateur doivent être absolus.');
  }
  const additionalEnvironment = Object.entries(input.additionalEnvironment ?? {});
  if (additionalEnvironment.some(([key]) => key !== 'FNFE_RUN_SENTINEL')) {
    throw new Error('Variable non autorisée dans le bac à sable validateur.');
  }
  return [
    '--unshare-user',
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--die-with-parent',
    '--new-session',
    '--ro-bind',
    '/',
    '/',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--dir',
    input.workDirectory,
    '--bind',
    input.workDirectory,
    input.workDirectory,
    '--chdir',
    input.repositoryRoot,
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/local/bin:/usr/bin:/bin',
    '--setenv',
    'HOME',
    input.workDirectory,
    '--setenv',
    'TMPDIR',
    input.workDirectory,
    '--setenv',
    'LANG',
    'C.UTF-8',
    '--setenv',
    'LC_ALL',
    'C.UTF-8',
    '--setenv',
    'CI',
    'true',
    ...additionalEnvironment.flatMap(([key, value]) => ['--setenv', key, value]),
    '--',
    input.command,
    ...input.arguments,
  ];
}

export function buildValidatorSandboxSmokeInvocation(input: {
  repositoryRoot: string;
  workDirectory: string;
  validatorSandboxPath: string;
  parentEnvironment?: NodeJS.ProcessEnv;
}): {
  executable: string;
  arguments: string[];
  environment: NodeJS.ProcessEnv;
} {
  if (input.validatorSandboxPath !== VALIDATOR_SANDBOX_EXECUTABLE) {
    throw new Error(
      `Le bac à sable validateur doit cibler exactement ${VALIDATOR_SANDBOX_EXECUTABLE}.`,
    );
  }
  return {
    executable: input.validatorSandboxPath,
    arguments: buildValidatorSandboxArguments({
      repositoryRoot: input.repositoryRoot,
      workDirectory: input.workDirectory,
      command: process.execPath,
      arguments: ['-e', VALIDATOR_SANDBOX_SMOKE_SCRIPT],
    }),
    environment: {
      ...buildExternalValidatorEnvironment(
        input.parentEnvironment ?? process.env,
        input.workDirectory,
      ),
      [VALIDATOR_SANDBOX_SMOKE_SECRET]: 'must-not-cross',
    },
  };
}

export class ValidatorSandboxReadinessGate {
  private verified = false;
  private inFlight: Promise<void> | null = null;

  async ensure(verify: () => Promise<void>): Promise<void> {
    if (this.verified) return;
    if (this.inFlight === null) {
      this.inFlight = Promise.resolve()
        .then(verify)
        .then(() => {
          this.verified = true;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    await this.inFlight;
  }
}

class PinnedFacturXExternalValidator {
  private jarVerified = false;
  private fnfeSentinelPending = true;
  private readonly sandboxReadiness = new ValidatorSandboxReadinessGate();
  private readonly successfulValidationDigests: string[] = [];

  constructor(
    private readonly repositoryRoot: string,
    private readonly mustangJarPath: string,
    private readonly fnfeBundlePath: string,
    private readonly validatorSandboxPath: string,
  ) {}

  private async verifyMustangJar(): Promise<string> {
    if (!this.jarVerified) {
      const jar = await readFile(this.mustangJarPath);
      const actual = createHash('sha256').update(jar).digest('hex');
      if (actual !== MUSTANG_SHA256) {
        throw new Error('Le JAR Mustang ne correspond pas à l’empreinte épinglée.');
      }
      this.jarVerified = true;
    }
    return this.mustangJarPath;
  }

  private executeSandboxed(
    command: string,
    arguments_: readonly string[],
    workDirectory: string,
    options: {
      timeout: number;
      maxBuffer: number;
      env?: NodeJS.ProcessEnv;
      sandboxEnvironment?: Readonly<Record<string, string>>;
    },
  ): ReturnType<typeof execFileAsync> {
    return execFileAsync(
      this.validatorSandboxPath,
      buildValidatorSandboxArguments({
        repositoryRoot: this.repositoryRoot,
        workDirectory,
        command,
        arguments: arguments_,
        additionalEnvironment: options.sandboxEnvironment,
      }),
      {
        cwd: this.repositoryRoot,
        encoding: 'utf8',
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        env: options.env ?? buildExternalValidatorEnvironment(process.env, workDirectory),
      },
    );
  }

  private ensureSandboxReady(): Promise<void> {
    return this.sandboxReadiness.ensure(async () => {
      const smokeWorkDirectory = await mkdtemp(resolve(tmpdir(), 'bob-archive-sandbox-readiness-'));
      try {
        const invocation = buildValidatorSandboxSmokeInvocation({
          repositoryRoot: this.repositoryRoot,
          workDirectory: smokeWorkDirectory,
          validatorSandboxPath: this.validatorSandboxPath,
        });
        await execFileAsync(invocation.executable, invocation.arguments, {
          cwd: this.repositoryRoot,
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: invocation.environment,
        });
      } finally {
        await rm(smokeWorkDirectory, { recursive: true, force: true });
      }
    });
  }

  evidenceDigest(seed = 'historical-byte-validation'): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          schemaVersion: 1,
          seed,
          validators: {
            representationDetector: 1,
            mustang: MUSTANG_VERSION,
            fnfe: FNFE_VERSION,
          },
          successfulValidations: [...this.successfulValidationDigests].sort(),
        }),
        'utf8',
      )
      .digest('hex');
  }

  async validate(input: {
    companyId: string;
    invoiceId: string;
    pdfBytes: Uint8Array;
    pdfSha256: string;
    xmlBytes: Uint8Array;
    xmlSha256: string;
  }): Promise<void> {
    if (
      createHash('sha256').update(input.pdfBytes).digest('hex') !== input.pdfSha256 ||
      createHash('sha256').update(input.xmlBytes).digest('hex') !== input.xmlSha256
    ) {
      throw new Error('Les octets ont changé avant la validation externe.');
    }
    await this.ensureSandboxReady();
    const jar = await this.verifyMustangJar();
    const workDirectory = await mkdtemp(resolve(tmpdir(), 'bob-archive-conformance-'));
    const pdfPath = resolve(workDirectory, 'invoice.pdf');
    const xmlPath = resolve(workDirectory, 'factur-x.xml');
    const pdfReportPath = resolve(workDirectory, 'mustang-pdf.xml');
    const xmlReportPath = resolve(workDirectory, 'mustang-xml.xml');
    try {
      await Promise.all([
        writeFile(pdfPath, input.pdfBytes, { mode: 0o600 }),
        writeFile(xmlPath, input.xmlBytes, { mode: 0o600 }),
      ]);
      const commonOptions = {
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
        // Les validateurs tiers n'ont besoin d'aucune clé Bob. Ne jamais leur transmettre
        // DATABASE_URL, DIRECT_URL, service-role Supabase, tokens provider ou secrets de release.
        env: buildExternalValidatorEnvironment(process.env, workDirectory),
      };
      const [pdfValidation, xmlValidation] = await Promise.all([
        this.executeSandboxed(
          '/usr/bin/java',
          [
            '-jar',
            jar,
            '--action',
            'validate',
            '--source',
            pdfPath,
            '--no-notices',
            '--disable-file-logging',
          ],
          workDirectory,
          commonOptions,
        ),
        this.executeSandboxed(
          '/usr/bin/java',
          [
            '-jar',
            jar,
            '--action',
            'validate',
            '--source',
            xmlPath,
            '--no-notices',
            '--disable-file-logging',
          ],
          workDirectory,
          commonOptions,
        ),
      ]);
      await Promise.all([
        writeFile(pdfReportPath, pdfValidation.stdout, { mode: 0o600 }),
        writeFile(xmlReportPath, xmlValidation.stdout, { mode: 0o600 }),
      ]);
      await Promise.all([
        this.executeSandboxed(
          process.execPath,
          [
            resolve(this.repositoryRoot, '.github/scripts/assert-mustang-report.mjs'),
            pdfReportPath,
            MUSTANG_VERSION,
            'pdf',
          ],
          workDirectory,
          commonOptions,
        ),
        this.executeSandboxed(
          process.execPath,
          [
            resolve(this.repositoryRoot, '.github/scripts/assert-mustang-report.mjs'),
            xmlReportPath,
            MUSTANG_VERSION,
            'xml',
          ],
          workDirectory,
          commonOptions,
        ),
        this.executeSandboxed(
          '/usr/bin/bash',
          [
            resolve(this.repositoryRoot, '.github/scripts/certify-facturx-fnfe.sh'),
            xmlPath,
            resolve(workDirectory, 'fnfe'),
            this.fnfeBundlePath,
          ],
          workDirectory,
          {
            ...commonOptions,
            timeout: 300_000,
            sandboxEnvironment: {
              FNFE_RUN_SENTINEL: this.fnfeSentinelPending ? 'true' : 'false',
            },
          },
        ),
      ]);
      const fnfeReportDirectory = resolve(workDirectory, 'fnfe/reports');
      const [profileReport, franceReport] = await Promise.all([
        readFile(resolve(fnfeReportDirectory, 'facturx-en16931.svrl.xml')),
        readFile(resolve(fnfeReportDirectory, 'br-fr-flux2-cii.svrl.xml')),
      ]);
      this.successfulValidationDigests.push(
        createHash('sha256')
          .update(
            JSON.stringify({
              pdfSha256: input.pdfSha256,
              xmlSha256: input.xmlSha256,
              mustangPdfReportSha256: createHash('sha256')
                .update(pdfValidation.stdout)
                .digest('hex'),
              mustangXmlReportSha256: createHash('sha256')
                .update(xmlValidation.stdout)
                .digest('hex'),
              fnfeProfileReportSha256: createHash('sha256').update(profileReport).digest('hex'),
              fnfeFranceReportSha256: createHash('sha256').update(franceReport).digest('hex'),
            }),
            'utf8',
          )
          .digest('hex'),
      );
      this.fnfeSentinelPending = false;
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }
}

async function writeImmutableReport(
  outputPath: string,
  report: ArchivePreactivationAuditReport,
): Promise<{ reportPath: string; checksumPath: string; sha256: string }> {
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const checksumPath = `${outputPath}.sha256`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes, { flag: 'wx', mode: 0o600 });
  try {
    await writeFile(checksumPath, `${sha256}  ${outputPath}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    throw new Error(
      `Rapport écrit dans ${outputPath}, mais preuve SHA impossible : ${error instanceof Error ? error.message : 'erreur inconnue'}`,
    );
  }
  return { reportPath: outputPath, checksumPath, sha256 };
}

export function buildArchiveAuditSafeEnvelope(input: {
  deploymentId: string;
  report: ArchivePreactivationAuditReport;
  reportSha256: string;
  validatorEvidenceSeed: string;
}): ArchiveAuditSafeEnvelope {
  if (
    !UUID_PATTERN.test(input.deploymentId) ||
    !SHA256_PATTERN.test(input.reportSha256) ||
    !SHA256_PATTERN.test(input.report.inventoryDigest) ||
    !SHA256_PATTERN.test(input.validatorEvidenceSeed) ||
    (input.report.protocolVersion !== 1 && input.report.protocolVersion !== 2)
  ) {
    throw new Error('Impossible de construire une enveloppe de preuve canonique.');
  }
  const validatorEvidenceDigest = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        seed: input.validatorEvidenceSeed,
        inventoryDigest: input.report.inventoryDigest,
        validators: input.report.validators,
        externallyValidatedProfessionalInvoices:
          input.report.counts.externallyValidatedProfessionalInvoices,
      }),
      'utf8',
    )
    .digest('hex');
  const issueCodes = [...new Set(input.report.issues.map(({ code }) => code))].sort();
  if (issueCodes.some((code) => !ISSUE_CODE_PATTERN.test(code))) {
    throw new Error('Le rapport contient un code d’écart non canonique.');
  }
  return {
    schemaVersion: 1,
    deploymentId: input.deploymentId,
    releaseSha: input.report.releaseSha,
    readyForActivation: input.report.readyForActivation,
    protocolVersion: input.report.protocolVersion,
    mode: input.report.mode,
    inventoryDigest: input.report.inventoryDigest,
    reportSha256: input.reportSha256,
    validatorEvidenceDigest,
    issueCodes,
    counts: input.report.counts,
    validators: input.report.validators,
  };
}

export async function finalizeArchiveAuditRun<T>(input: {
  work: () => Promise<T>;
  cleanup: () => Promise<void>;
  publish: (outcome: T) => void;
}): Promise<T> {
  let outcome: T | undefined;
  let workFailed = false;
  let workFailure: unknown;
  try {
    outcome = await input.work();
  } catch (error) {
    workFailed = true;
    workFailure = error;
  }
  let cleanupFailed = false;
  let cleanupFailure: unknown;
  try {
    await input.cleanup();
  } catch (error) {
    cleanupFailed = true;
    cleanupFailure = error;
  }
  if (workFailed) throw workFailure;
  if (cleanupFailed) throw cleanupFailure;
  input.publish(outcome as T);
  return outcome as T;
}

export async function runDocumentArchiveAudit(environment: NodeJS.ProcessEnv): Promise<number> {
  const config = parseArchiveAuditRuntimeConfig(environment);
  const authority = prismaFor(config.directUrl);
  const runtime = prismaFor(config.databaseUrl);
  const lease = prismaFor(config.directUrl);
  const repository = new PrismaArchivePreactivationRepository(
    authority,
    runtime,
    lease,
    config.bucket,
  );
  const outcome = await finalizeArchiveAuditRun({
    work: () =>
      repository.withExclusiveAuditLease(async () => {
        const protocolIdentity = await repository.assertAuthorities(config.applyAttestations);
        const auditedAt = await repository.databaseNow();
        const storage = new SupabaseArchiveAuditStorage(
          config.supabaseUrl,
          config.supabaseServiceRoleKey,
          config.bucket,
          config.maxObjectBytes,
        );
        const externalValidator = new PinnedFacturXExternalValidator(
          resolve(__dirname, '../../..'),
          config.mustangJarPath,
          config.fnfeBundlePath,
          config.validatorSandboxPath,
        );
        const byteAudit = await auditDocumentArchivePreactivation({
          repository,
          storage,
          inspectInvoicePdf: inspectInvoicePdfRepresentation,
          validateProfessionalFacturX: (pair) => externalValidator.validate(pair),
          // Après le cutover, la capacité historique reste définitivement retirée. Une attestation
          // absente est un P0 et ne doit jamais provoquer une tentative d’écriture tardive.
          applyAttestations:
            protocolIdentity.activeVersion === 1 ? config.applyAttestations : false,
          auditedAt,
          releaseSha: config.releaseSha,
          storageBucket: config.bucket,
        });
        let report: ArchivePreactivationAuditReport;
        if (protocolIdentity.activeVersion === 2) {
          report = await repository.verifyActiveProtocolV2({
            byteAudit,
            auditedAt,
            releaseSha: config.releaseSha,
            storageBucket: config.bucket,
          });
        } else {
          report = byteAudit;
        }
        const validatorEvidenceSeed = externalValidator.evidenceDigest(report.inventoryDigest);
        const evidence = await writeImmutableReport(config.outputPath, report);
        const envelope = buildArchiveAuditSafeEnvelope({
          deploymentId: config.deploymentId,
          report,
          reportSha256: evidence.sha256,
          validatorEvidenceSeed,
        });
        await repository.persistEvidence({
          databaseIdentity: protocolIdentity.databaseIdentity,
          storageBucket: report.storageBucket,
          envelope,
          report,
          auditedAt: report.auditedAt,
        });
        return {
          envelope,
          exitCode: report.readyForActivation ? (0 as const) : (2 as const),
        };
      }),
    cleanup: async () => {
      const disconnectResults = await Promise.allSettled([
        authority.$disconnect(),
        runtime.$disconnect(),
        lease.$disconnect(),
      ]);
      const disconnectFailures = disconnectResults.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (disconnectFailures.length > 0) {
        throw new AggregateError(
          disconnectFailures,
          'La preuve Archive est committée mais les connexions PostgreSQL ne sont pas toutes libérées.',
        );
      }
    },
    publish: ({ envelope }) => {
      process.stdout.write(
        `BOB_DOCUMENT_ARCHIVE_AUDIT_EVIDENCE=${Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url')}\n`,
      );
    },
  });
  return outcome.exitCode;
}

if (require.main === module) {
  runDocumentArchiveAudit(process.env)
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Audit Archive V2 impossible.'}\n`,
      );
      process.exitCode = 1;
    });
}

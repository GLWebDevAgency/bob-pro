import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  buildArchiveQuarantineManifest,
  type ArchiveQuarantineObject,
  type ArchiveQuarantineStorage,
} from './documents/archive-quarantine';
import type { ArchivePreactivationAuditReport } from './documents/archive-preactivation-audit';
import { SupabaseArchiveAuditStorage } from './document-archive-audit.main';

const SHA256 = /^[0-9a-f]{64}$/u;
const RELEASE_SHA = /^[0-9a-f]{40}$/u;
const BUCKET = /^[a-z0-9][a-z0-9._-]{0,62}$/u;
const PROJECT_REF = /^[a-z0-9]{20}$/u;
const DEFAULT_MAX_OBJECT_BYTES = 64 * 1024 * 1024;

interface ArchiveQuarantinePlanConfig {
  readonly directUrl: string;
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly sourceBucket: string;
  readonly destinationBucket: string;
  readonly reportPath: string;
  readonly reportSha256: string;
  readonly outputPath: string;
  readonly releaseSha: string;
  readonly maxObjectBytes: number;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`ARCHIVE_QUARANTINE_CONFIG_REQUIRED:${name}`);
  return value;
}

export function parseArchiveQuarantinePlanConfig(
  environment: NodeJS.ProcessEnv,
): ArchiveQuarantinePlanConfig {
  const mode = environment.DOCUMENT_ARCHIVE_QUARANTINE_MODE?.trim() || 'plan';
  if (mode !== 'plan') {
    throw new Error('ARCHIVE_QUARANTINE_APPLY_NOT_EXPOSED_WITHOUT_FOUNDER_RECEIPT');
  }
  const target = required(environment, 'BOB_RELEASE_EXPECTED_ENV');
  if (target !== 'staging') throw new Error('ARCHIVE_QUARANTINE_STAGING_ONLY');
  const sourceBucket = required(environment, 'SUPABASE_STORAGE_BUCKET');
  const destinationBucket = required(
    environment,
    'DOCUMENT_ARCHIVE_QUARANTINE_DESTINATION_BUCKET',
  );
  if (
    !BUCKET.test(sourceBucket)
    || !BUCKET.test(destinationBucket)
    || sourceBucket === destinationBucket
  ) {
    throw new Error('ARCHIVE_QUARANTINE_BUCKET_INVALID');
  }
  const reportSha256 = required(
    environment,
    'DOCUMENT_ARCHIVE_QUARANTINE_AUDIT_REPORT_SHA256',
  );
  if (!SHA256.test(reportSha256)) throw new Error('ARCHIVE_QUARANTINE_REPORT_SHA_INVALID');
  const releaseSha = required(environment, 'BOB_RELEASE_SHA').toLowerCase();
  if (!RELEASE_SHA.test(releaseSha)) throw new Error('ARCHIVE_QUARANTINE_RELEASE_SHA_INVALID');
  const supabaseUrl = required(environment, 'SUPABASE_URL').replace(/\/$/u, '');
  const parsedUrl = new URL(supabaseUrl);
  const projectRef = required(
    environment,
    'DOCUMENT_ARCHIVE_SUPABASE_PROJECT_REF',
  ).toLowerCase();
  if (
    !PROJECT_REF.test(projectRef)
    || parsedUrl.protocol !== 'https:'
    || parsedUrl.username !== ''
    || parsedUrl.password !== ''
    || parsedUrl.port !== ''
    || parsedUrl.pathname !== '/'
    || parsedUrl.search !== ''
    || parsedUrl.hash !== ''
    || parsedUrl.hostname !== `${projectRef}.supabase.co`
  ) {
    throw new Error('ARCHIVE_QUARANTINE_SUPABASE_URL_INVALID');
  }
  const maxRaw = environment.DOCUMENT_ARCHIVE_QUARANTINE_MAX_OBJECT_BYTES?.trim();
  const maxObjectBytes = maxRaw === undefined ? DEFAULT_MAX_OBJECT_BYTES : Number(maxRaw);
  if (
    !Number.isSafeInteger(maxObjectBytes)
    || maxObjectBytes < 1
    || maxObjectBytes > 512 * 1024 * 1024
  ) {
    throw new Error('ARCHIVE_QUARANTINE_MAX_BYTES_INVALID');
  }
  return {
    directUrl: required(environment, 'DIRECT_URL'),
    supabaseUrl,
    serviceRoleKey: required(environment, 'SUPABASE_SERVICE_ROLE_KEY'),
    sourceBucket,
    destinationBucket,
    reportPath: resolve(required(environment, 'DOCUMENT_ARCHIVE_QUARANTINE_AUDIT_REPORT')),
    reportSha256,
    outputPath: resolve(required(environment, 'DOCUMENT_ARCHIVE_QUARANTINE_OUTPUT')),
    releaseSha,
    maxObjectBytes,
  };
}

export function archiveQuarantineSourceCompanyId(key: string): string {
  const match = /^companies\/([^/]+)\/(?:documents|chantiers)\//u.exec(key);
  if (match?.[1] === undefined) {
    throw new Error('ARCHIVE_QUARANTINE_SOURCE_KEY_INVALID');
  }
  return match[1];
}

class SupabaseArchiveQuarantinePlanStorage implements ArchiveQuarantineStorage {
  private readonly sourceLoader: SupabaseArchiveAuditStorage;

  constructor(
    private readonly authority: PrismaClient,
    baseUrl: string,
    serviceRoleKey: string,
    private readonly sourceBucket: string,
    maxObjectBytes: number,
  ) {
    this.sourceLoader = new SupabaseArchiveAuditStorage(
      baseUrl,
      serviceRoleKey,
      sourceBucket,
      maxObjectBytes,
    );
  }

  async assertPrivateBucket(bucket: string): Promise<void> {
    const rows = await this.authority.$queryRawUnsafe<Array<{
      id: string;
      name: string;
      public: boolean;
    }>>(
      `SELECT id, name, public FROM storage.buckets WHERE id = $1 OR name = $1`,
      bucket,
    );
    if (
      rows.length !== 1
      || rows[0]?.id !== bucket
      || rows[0].name !== bucket
      || rows[0].public
    ) {
      throw new Error('ARCHIVE_QUARANTINE_DESTINATION_BUCKET_NOT_PRIVATE');
    }
  }

  async load(bucket: string, key: string): Promise<ArchiveQuarantineObject | null> {
    if (bucket !== this.sourceBucket) {
      throw new Error('ARCHIVE_QUARANTINE_PLAN_IS_READ_ONLY');
    }
    const companyId = archiveQuarantineSourceCompanyId(key);
    const metadata = await this.authority.$queryRawUnsafe<Array<{ createdAt: Date }>>(
      `SELECT created_at AS "createdAt"
         FROM storage.objects
        WHERE bucket_id = $1 AND name = $2`,
      bucket,
      key,
    );
    if (metadata.length === 0) return null;
    if (metadata.length !== 1 || !(metadata[0]?.createdAt instanceof Date)) {
      throw new Error('ARCHIVE_QUARANTINE_STORAGE_METADATA_INVALID');
    }
    const object = await this.sourceLoader.load(companyId, key);
    if (object === null) return null;
    return {
      bytes: object.bytes,
      contentType: object.contentType,
      createdAt: metadata[0].createdAt.toISOString(),
    };
  }

  async copy(): Promise<void> {
    throw new Error('ARCHIVE_QUARANTINE_PLAN_IS_READ_ONLY');
  }

  async removeExact(): Promise<boolean> {
    throw new Error('ARCHIVE_QUARANTINE_PLAN_IS_READ_ONLY');
  }

  async putImmutable(): Promise<void> {
    throw new Error('ARCHIVE_QUARANTINE_PLAN_IS_READ_ONLY');
  }
}

function parseAuditReport(bytes: Uint8Array): ArchivePreactivationAuditReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error('ARCHIVE_QUARANTINE_AUDIT_REPORT_INVALID');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ARCHIVE_QUARANTINE_AUDIT_REPORT_INVALID');
  }
  return parsed as ArchivePreactivationAuditReport;
}

async function assertCurrentDatabaseFingerprint(
  authority: PrismaClient,
  expected: string,
): Promise<void> {
  const rows = await authority.$queryRawUnsafe<Array<{ databaseIdentity: string }>>(
    `SELECT "databaseIdentity"::text AS "databaseIdentity"
       FROM public.document_archive_protocol_state
      WHERE id = 1`,
  );
  if (rows.length !== 1 || rows[0]?.databaseIdentity === undefined) {
    throw new Error('ARCHIVE_QUARANTINE_DATABASE_IDENTITY_INVALID');
  }
  const fingerprint = createHash('sha256')
    .update(`bob-document-archive-database:${rows[0].databaseIdentity}`, 'utf8')
    .digest('hex');
  if (fingerprint !== expected) throw new Error('ARCHIVE_QUARANTINE_DATABASE_CHANGED');
}

export async function runDocumentArchiveQuarantinePlan(
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const config = parseArchiveQuarantinePlanConfig(environment);
  const reportBytes = await readFile(config.reportPath);
  const reportSha256 = createHash('sha256').update(reportBytes).digest('hex');
  if (reportSha256 !== config.reportSha256) {
    throw new Error('ARCHIVE_QUARANTINE_AUDIT_REPORT_SHA_MISMATCH');
  }
  const report = parseAuditReport(reportBytes);
  if (
    report.releaseSha !== config.releaseSha
    || report.storageBucket !== config.sourceBucket
  ) {
    throw new Error('ARCHIVE_QUARANTINE_AUDIT_TARGET_MISMATCH');
  }
  const authority = new PrismaClient({ datasourceUrl: config.directUrl });
  try {
    await authority.$connect();
    await assertCurrentDatabaseFingerprint(authority, report.databaseFingerprint);
    const storage = new SupabaseArchiveQuarantinePlanStorage(
      authority,
      config.supabaseUrl,
      config.serviceRoleKey,
      config.sourceBucket,
      config.maxObjectBytes,
    );
    const manifest = await buildArchiveQuarantineManifest({
      report,
      auditReportSha256: reportSha256,
      destinationBucket: config.destinationBucket,
      storage,
    });
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const outputSha256 = createHash('sha256').update(bytes).digest('hex');
    await mkdir(dirname(config.outputPath), { recursive: true });
    await writeFile(config.outputPath, bytes, { flag: 'wx', mode: 0o600 });
    await writeFile(
      `${config.outputPath}.sha256`,
      `${outputSha256}  ${config.outputPath}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    process.stdout.write(`BOB_DOCUMENT_ARCHIVE_QUARANTINE_PLAN=${Buffer.from(JSON.stringify({
      schemaVersion: 1,
      environment: 'staging',
      releaseSha: manifest.releaseSha,
      manifestDigest: manifest.confirmationDigest,
      entryCount: manifest.entries.length,
      outputSha256,
    }), 'utf8').toString('base64url')}\n`);
  } finally {
    await authority.$disconnect();
  }
}

if (require.main === module) {
  runDocumentArchiveQuarantinePlan(process.env).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'ARCHIVE_QUARANTINE_PLAN_FAILED'}\n`,
    );
    process.exitCode = 1;
  });
}

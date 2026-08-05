import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  type ArchiveQuarantineAuthorization,
  type ArchiveQuarantineFinalAuditEvidence,
  type ArchiveQuarantineJson,
  type ArchiveQuarantineManifest,
  type ArchiveQuarantineManifestEntry,
  type ArchiveQuarantineObject,
  type ArchiveQuarantineSafetyGuard,
  type ArchiveQuarantineStorage,
  type ArchiveQuarantineTarget,
  type ArchiveQuarantineWorkflowIdentity,
  validateArchiveQuarantineWorkflowIdentity,
  validateArchiveQuarantineManifest,
} from './documents/archive-quarantine';
import type { ArchivePreactivationAuditReport } from './documents/archive-preactivation-audit';

const SHA256 = /^[0-9a-f]{64}$/u;
const RELEASE_SHA = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BUCKET = /^[a-z0-9][a-z0-9._-]{0,62}$/u;
const PROJECT_REF = /^[a-z0-9]{20}$/u;
const ROLE = /^[a-z_][a-z0-9_$-]{0,62}$/u;
const STORAGE_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const DEFAULT_MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const DESTINATION_BUCKET = 'archive-quarantine';
const AUDIT_FRESHNESS_MS = 30 * 60 * 1_000;

/** Périmètre opaque et fermé de la décision fondateur : aucun input workflow ne peut l'élargir. */
export const FLY_ARCHIVE_QUARANTINE_TARGET: ArchiveQuarantineTarget = Object.freeze({
  companyIdSha256: '83ade527a836a4425181a02dd4461b61cd39f417e0941623db9216e7d4c5a5db',
  sourceKeySha256s: Object.freeze([
    '1b01bcf44ba61e034870d9da4c6604fa0a6bce629b51843a73fe953a600dac09',
    '480394bce0b442b9b1cbaf4e546634696fab519ae341cfbaa3f97301c8e43b9d',
    '7e0b737fb7b08bf2f6d3f8e9a971b2a8735312eea4f3860065cfe4938812570b',
    'a307e4eea77b617e106308d4ad81f5ba7865743a90cffe5e502653d41e457468',
    'c9ab8b92c0da9c8542a4ff22877e489adf3ecd2d63985b9265ac99168db3f5d6',
  ]),
});

export interface ArchiveQuarantineRuntimeConfig {
  readonly directUrl: string;
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly sourceBucket: string;
  readonly destinationBucket: typeof DESTINATION_BUCKET;
  readonly releaseSha: string;
  readonly maxObjectBytes: number;
}

export interface ArchiveQuarantineAuditPin {
  readonly deploymentId: string;
  readonly inventoryDigest: string;
  readonly reportSha256: string;
}

interface StorageFactsRow {
  readonly objectId: string;
  readonly version: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata: ArchiveQuarantineJson;
  readonly userMetadata: ArchiveQuarantineJson;
}

interface EventObjectFacts {
  readonly objectId: string;
  readonly version: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly metadata: ArchiveQuarantineJson;
  readonly userMetadata: ArchiveQuarantineJson;
  readonly byteSha256: string;
  readonly byteSize: number;
  readonly contentType: string;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`ARCHIVE_QUARANTINE_CONFIG_REQUIRED:${name}`);
  return value;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJsonValue(nested)]),
    );
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function sameStableWorkflowIdentity(
  persisted: unknown,
  expected: ArchiveQuarantineWorkflowIdentity,
): boolean {
  if (typeof persisted !== 'object' || persisted === null || Array.isArray(persisted)) return false;
  const value = persisted as Record<string, unknown>;
  return sameJson({
    issuer: value.issuer,
    audience: value.audience,
    repository: value.repository,
    ref: value.ref,
    sha: value.sha,
    environment: value.environment,
    workflowRef: value.workflowRef,
    workflowSha: value.workflowSha,
    eventName: value.eventName,
    subject: value.subject,
    repositoryId: value.repositoryId,
    repositoryOwnerId: value.repositoryOwnerId,
    actorId: value.actorId,
  }, {
    issuer: expected.issuer,
    audience: expected.audience,
    repository: expected.repository,
    ref: expected.ref,
    sha: expected.sha,
    environment: expected.environment,
    workflowRef: expected.workflowRef,
    workflowSha: expected.workflowSha,
    eventName: expected.eventName,
    subject: expected.subject,
    repositoryId: expected.repositoryId,
    repositoryOwnerId: expected.repositoryOwnerId,
    actorId: expected.actorId,
  });
}

export function assertDistinctArchiveQuarantineApplyAuthority(
  persistedPlanIdentity: unknown,
  applyIdentity: ArchiveQuarantineWorkflowIdentity,
): void {
  if (
    !sameStableWorkflowIdentity(persistedPlanIdentity, applyIdentity)
    || typeof persistedPlanIdentity !== 'object'
    || persistedPlanIdentity === null
    || Array.isArray(persistedPlanIdentity)
  ) {
    throw new Error('ARCHIVE_QUARANTINE_APPLY_AUTHORITY_DIVERGENT');
  }
  const planTokenSha256 = (persistedPlanIdentity as Record<string, unknown>).tokenSha256;
  if (typeof planTokenSha256 !== 'string' || !SHA256.test(planTokenSha256)) {
    throw new Error('ARCHIVE_QUARANTINE_APPLY_AUTHORITY_DIVERGENT');
  }
  if (planTokenSha256 === applyIdentity.tokenSha256) {
    throw new Error('ARCHIVE_QUARANTINE_APPLY_OIDC_PROOF_REPLAYED');
  }
}

function normalizedContentType(value: string): string {
  return (value.split(';')[0] ?? '').trim().toLowerCase() || 'application/octet-stream';
}

function encodeStorageKey(key: string): string {
  if (
    key.length < 1
    || key.length > 1_024
    || key.startsWith('/')
    || key.includes('//')
    || key.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('ARCHIVE_QUARANTINE_STORAGE_KEY_INVALID');
  }
  return key.split('/').map(encodeURIComponent).join('/');
}

function releaseSha(environment: NodeJS.ProcessEnv): string {
  const candidates = [environment.BOB_RELEASE_SHA, environment.RAILWAY_GIT_COMMIT_SHA]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => value !== undefined && value !== '');
  if (candidates.length < 1 || candidates.some((value) => !RELEASE_SHA.test(value))) {
    throw new Error('ARCHIVE_QUARANTINE_RELEASE_SHA_INVALID');
  }
  if (new Set(candidates).size !== 1) throw new Error('ARCHIVE_QUARANTINE_RELEASE_SHA_DIVERGENT');
  return candidates[0]!;
}

export function parseArchiveQuarantineRuntimeConfig(
  environment: NodeJS.ProcessEnv,
): ArchiveQuarantineRuntimeConfig {
  if (required(environment, 'BOB_RELEASE_EXPECTED_ENV') !== 'staging') {
    throw new Error('ARCHIVE_QUARANTINE_STAGING_ONLY');
  }
  const sourceBucket = required(environment, 'SUPABASE_STORAGE_BUCKET');
  if (!BUCKET.test(sourceBucket) || sourceBucket === DESTINATION_BUCKET) {
    throw new Error('ARCHIVE_QUARANTINE_BUCKET_INVALID');
  }
  const supabaseUrl = required(environment, 'SUPABASE_URL').replace(/\/$/u, '');
  const parsedUrl = new URL(supabaseUrl);
  const projectRef = required(environment, 'DOCUMENT_ARCHIVE_SUPABASE_PROJECT_REF').toLowerCase();
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
    destinationBucket: DESTINATION_BUCKET,
    releaseSha: releaseSha(environment),
    maxObjectBytes,
  };
}

export function parseArchiveQuarantineAuditPin(
  environment: NodeJS.ProcessEnv,
): ArchiveQuarantineAuditPin {
  const pin = {
    deploymentId: required(environment, 'DOCUMENT_ARCHIVE_QUARANTINE_AUDIT_DEPLOYMENT_ID'),
    inventoryDigest: required(environment, 'DOCUMENT_ARCHIVE_QUARANTINE_AUDIT_INVENTORY_DIGEST'),
    reportSha256: required(environment, 'DOCUMENT_ARCHIVE_QUARANTINE_AUDIT_REPORT_SHA256'),
  };
  if (
    !UUID.test(pin.deploymentId)
    || !SHA256.test(pin.inventoryDigest)
    || !SHA256.test(pin.reportSha256)
  ) {
    throw new Error('ARCHIVE_QUARANTINE_AUDIT_PIN_INVALID');
  }
  return pin;
}

export function archiveQuarantineSourceCompanyId(key: string): string {
  const match = /^companies\/([^/]+)\/documents\//u.exec(key);
  if (match?.[1] === undefined) throw new Error('ARCHIVE_QUARANTINE_SOURCE_KEY_INVALID');
  return match[1];
}

function sameStorageFacts(left: StorageFactsRow, right: StorageFactsRow): boolean {
  return left.objectId === right.objectId
    && left.version === right.version
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && sameJson(left.metadata, right.metadata)
    && sameJson(left.userMetadata, right.userMetadata);
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number.isSafeInteger(Number(declared)) && Number(declared) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('ARCHIVE_QUARANTINE_OBJECT_TOO_LARGE');
  }
  if (response.body === null) throw new Error('ARCHIVE_QUARANTINE_STORAGE_BODY_MISSING');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let reading = true;
  while (reading) {
    const next = await reader.read();
    if (next.done) {
      reading = false;
      continue;
    }
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error('ARCHIVE_QUARANTINE_OBJECT_TOO_LARGE');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readErrorSnippet(response: Response): Promise<string> {
  const bytes = await readBounded(response, 4_096).catch(() => new Uint8Array());
  return Buffer.from(bytes).toString('utf8');
}

function storageNotFound(status: number, body: string): boolean {
  return status === 404 || (status === 400 && /not_found|"statusCode"\s*:\s*"404"/u.test(body));
}

export class SupabaseArchiveQuarantineStorage implements ArchiveQuarantineStorage {
  constructor(
    private readonly authority: PrismaClient,
    private readonly config: ArchiveQuarantineRuntimeConfig,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  private headers(contentType?: string): HeadersInit {
    return {
      Authorization: `Bearer ${this.config.serviceRoleKey}`,
      apikey: this.config.serviceRoleKey,
      ...(contentType === undefined ? {} : { 'content-type': contentType }),
    };
  }

  private objectUrl(bucket: string, key: string): string {
    return `${this.config.supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeStorageKey(key)}`;
  }

  private async facts(bucket: string, key: string): Promise<StorageFactsRow | null> {
    const rows = await this.authority.$queryRawUnsafe<StorageFactsRow[]>(
      `SELECT object.id::text AS "objectId",
              to_jsonb(object)->>'version' AS version,
              pg_catalog.to_char(object.created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
              pg_catalog.to_char(object.updated_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
              coalesce(to_jsonb(object)->'metadata', 'null'::jsonb) AS metadata,
              coalesce(to_jsonb(object)->'user_metadata', 'null'::jsonb) AS "userMetadata"
         FROM storage.objects AS object
        WHERE object.bucket_id = $1 AND object.name = $2`,
      bucket,
      key,
    );
    if (rows.length > 1) throw new Error('ARCHIVE_QUARANTINE_STORAGE_FACTS_AMBIGUOUS');
    const row = rows[0];
    if (row === undefined) return null;
    if (
      !UUID.test(row.objectId)
      || !STORAGE_INSTANT.test(row.createdAt)
      || !STORAGE_INSTANT.test(row.updatedAt)
      || (row.version !== null && (row.version.length < 1 || row.version.length > 256))
    ) {
      throw new Error('ARCHIVE_QUARANTINE_STORAGE_FACTS_INVALID');
    }
    return row;
  }

  async assertPrivateBucket(bucket: string): Promise<void> {
    const rows = await this.authority.$queryRawUnsafe<Array<{
      id: string;
      name: string;
      isPublic: boolean;
      fileSizeLimit: bigint | null;
      allowedMimeTypes: string[] | null;
    }>>(
      `SELECT id, name, public AS "isPublic", file_size_limit AS "fileSizeLimit",
              allowed_mime_types AS "allowedMimeTypes"
         FROM storage.buckets
        WHERE id = $1 OR name = $1`,
      bucket,
    );
    if (
      rows.length !== 1
      || rows[0]?.id !== bucket
      || rows[0].name !== bucket
      || rows[0].isPublic !== false
      || (bucket === this.config.destinationBucket && (
        rows[0].fileSizeLimit !== BigInt(this.config.maxObjectBytes)
        || rows[0].allowedMimeTypes === null
        || !sameStringSet(
          rows[0].allowedMimeTypes,
          ['application/json', 'application/pdf'],
        )
      ))
    ) {
      throw new Error('ARCHIVE_QUARANTINE_BUCKET_NOT_PRIVATE');
    }
  }

  async ensurePrivateDestinationBucket(): Promise<void> {
    const endpoint = `${this.config.supabaseUrl}/storage/v1/bucket/${encodeURIComponent(this.config.destinationBucket)}`;
    const current = await this.fetchImpl(endpoint, {
      method: 'GET',
      headers: this.headers(),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!current.ok) {
      const body = await readErrorSnippet(current);
      if (!storageNotFound(current.status, body)) {
        throw new Error('ARCHIVE_QUARANTINE_BUCKET_LOOKUP_FAILED');
      }
      const created = await this.fetchImpl(`${this.config.supabaseUrl}/storage/v1/bucket`, {
        method: 'POST',
        headers: this.headers('application/json'),
        body: JSON.stringify({
          id: this.config.destinationBucket,
          name: this.config.destinationBucket,
          public: false,
          file_size_limit: this.config.maxObjectBytes,
          allowed_mime_types: ['application/pdf', 'application/json'],
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!created.ok) {
        await readErrorSnippet(created);
        throw new Error('ARCHIVE_QUARANTINE_BUCKET_CREATE_FAILED');
      }
      await created.body?.cancel().catch(() => undefined);
    } else {
      await current.body?.cancel().catch(() => undefined);
    }
    await this.assertPrivateBucket(this.config.destinationBucket);
  }

  async load(bucket: string, key: string): Promise<ArchiveQuarantineObject | null> {
    const before = await this.facts(bucket, key);
    const response = await this.fetchImpl(this.objectUrl(bucket, key), {
      method: 'GET',
      headers: this.headers(),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await readErrorSnippet(response);
      if (storageNotFound(response.status, body)) {
        if (before !== null) throw new Error('ARCHIVE_QUARANTINE_STORAGE_SQL_HTTP_DIVERGENT');
        return null;
      }
      throw new Error('ARCHIVE_QUARANTINE_STORAGE_GET_FAILED');
    }
    const bytes = await readBounded(response, this.config.maxObjectBytes);
    const after = await this.facts(bucket, key);
    if (before === null || after === null || !sameStorageFacts(before, after)) {
      throw new Error('ARCHIVE_QUARANTINE_STORAGE_CHANGED_DURING_READ');
    }
    return {
      bytes,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      objectId: after.objectId,
      version: after.version,
      createdAt: after.createdAt,
      updatedAt: after.updatedAt,
      metadata: after.metadata,
      userMetadata: after.userMetadata,
    };
  }

  async putImmutable(
    bucket: string,
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const response = await this.fetchImpl(this.objectUrl(bucket, key), {
      method: 'POST',
      headers: {
        ...this.headers(contentType),
        'cache-control': 'private, no-store, max-age=0',
        'x-upsert': 'false',
      },
      body: Buffer.from(bytes),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await readErrorSnippet(response);
      throw new Error('ARCHIVE_QUARANTINE_STORAGE_UPLOAD_FAILED');
    }
    await response.body?.cancel().catch(() => undefined);
  }

  async removeFenced(bucket: string, key: string): Promise<void> {
    const response = await this.fetchImpl(this.objectUrl(bucket, key), {
      method: 'DELETE',
      headers: this.headers(),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    const body = await readErrorSnippet(response);
    if (storageNotFound(response.status, body)) return;
    throw new Error('ARCHIVE_QUARANTINE_STORAGE_DELETE_FAILED');
  }
}

function databaseFingerprint(databaseIdentity: string): string {
  return sha256(`bob-document-archive-database:${databaseIdentity}`);
}

function asAuditReport(value: unknown): ArchivePreactivationAuditReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('ARCHIVE_QUARANTINE_PRIVATE_REPORT_INVALID');
  }
  return value as ArchivePreactivationAuditReport;
}

function companyIdForManifest(manifest: ArchiveQuarantineManifest): string {
  const ids = manifest.entries.map(({ sourceKey }) => archiveQuarantineSourceCompanyId(sourceKey));
  if (new Set(ids).size !== 1 || sha256(ids[0]!) !== manifest.companyIdSha256) {
    throw new Error('ARCHIVE_QUARANTINE_MANIFEST_TENANT_INVALID');
  }
  return ids[0]!;
}

function objectFacts(object: ArchiveQuarantineObject): EventObjectFacts {
  return {
    objectId: object.objectId,
    version: object.version,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt,
    metadata: object.metadata,
    userMetadata: object.userMetadata,
    byteSha256: sha256(object.bytes),
    byteSize: object.bytes.byteLength,
    contentType: normalizedContentType(object.contentType),
  };
}

function quoteRole(role: string): string {
  if (!ROLE.test(role)) throw new Error('ARCHIVE_QUARANTINE_OWNER_INVALID');
  return `"${role.replaceAll('"', '""')}"`;
}

/**
 * Dernière frontière avant de libérer les fences d'une opération ouverte. Tous les producteurs
 * susceptibles de changer la vérité Archive sont verrouillés dans le même ordre que sealPlan,
 * puis l'état global ET l'état exact des cinq clés sont recertifiés avant l'INSERT completed.
 */
export async function assertArchiveQuarantineCompletionBoundary(
  transaction: Prisma.TransactionClient,
  input: {
    readonly operationId: string;
    readonly manifest: ArchiveQuarantineManifest;
    readonly maxObjectBytes: number;
  },
): Promise<void> {
  await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
  await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '60s'");
  await transaction.$executeRawUnsafe('LOCK TABLE storage.objects IN SHARE ROW EXCLUSIVE MODE');
  await transaction.$executeRawUnsafe('LOCK TABLE storage.buckets IN SHARE ROW EXCLUSIVE MODE');
  await transaction.$executeRawUnsafe('LOCK TABLE public.documents IN SHARE ROW EXCLUSIVE MODE');
  await transaction.$executeRawUnsafe(
    'LOCK TABLE public.document_versions IN SHARE ROW EXCLUSIVE MODE',
  );
  await transaction.$executeRawUnsafe(
    'LOCK TABLE public.chantier_photos IN SHARE ROW EXCLUSIVE MODE',
  );
  await transaction.$executeRawUnsafe(
    'LOCK TABLE public.document_archive_artifact_intents IN SHARE ROW EXCLUSIVE MODE',
  );
  await transaction.$executeRawUnsafe(
    'LOCK TABLE public.document_archive_job_artifacts IN SHARE ROW EXCLUSIVE MODE',
  );
  await transaction.$executeRawUnsafe(
    'LOCK TABLE public.document_archive_jobs IN SHARE ROW EXCLUSIVE MODE',
  );

  const rows = await transaction.$queryRawUnsafe<Array<{
    operationExact: bigint;
    entries: bigint;
    sources: bigint;
    destinationsExact: bigint;
    references: bigint;
    receiptsExact: bigint;
    planAuthorized: bigint;
    authorized: bigint;
    destinationEvents: bigint;
    copiedVerified: bigint;
    sourceDeleted: bigint;
    deletedVerified: bigint;
    finalAuditVerified: bigint;
    completed: bigint;
    globalOrphans: bigint;
    globalMissing: bigint;
    privateBuckets: bigint;
    liveArchiveLeases: bigint;
    exactFences: bigint;
    namedFences: bigint;
  }>>(
    `WITH operation_entries AS (
       SELECT entry.*
         FROM public.document_archive_quarantine_entries AS entry
        WHERE entry."operationId" = $1::uuid
     ), referenced_objects AS (
       SELECT "storageKey" FROM public.documents
       UNION ALL SELECT "storageKey" FROM public.document_versions
       UNION ALL SELECT "storageKey" FROM public.chantier_photos
       UNION ALL SELECT "storageKey" FROM public.document_archive_artifact_intents
       UNION ALL SELECT "storageKey" FROM public.document_archive_job_artifacts
     ), expected_fence(
       schema_name, relation_name, trigger_name, function_oid, trigger_type, update_column
     ) AS (
       VALUES
         ('storage', 'objects', 'generated_legal_storage_object_immutable',
          'public.prevent_generated_legal_storage_object_mutation()'::pg_catalog.regprocedure,
          31, NULL::text),
         ('storage', 'buckets', 'document_archive_quarantine_bucket_fence',
          'public.prevent_document_archive_quarantine_bucket_mutation_v1()'::pg_catalog.regprocedure,
          27, NULL::text),
         ('public', 'documents', 'document_archive_quarantine_documents_reference_fence',
          'public.prevent_document_archive_quarantine_reference_v1()'::pg_catalog.regprocedure,
          23, 'storageKey'),
         ('public', 'document_versions',
          'document_archive_quarantine_versions_reference_fence',
          'public.prevent_document_archive_quarantine_reference_v1()'::pg_catalog.regprocedure,
          23, 'storageKey'),
         ('public', 'chantier_photos', 'document_archive_quarantine_photos_reference_fence',
          'public.prevent_document_archive_quarantine_reference_v1()'::pg_catalog.regprocedure,
          23, 'storageKey'),
         ('public', 'document_archive_artifact_intents',
          'document_archive_quarantine_intents_reference_fence',
          'public.prevent_document_archive_quarantine_reference_v1()'::pg_catalog.regprocedure,
          23, 'storageKey'),
         ('public', 'document_archive_job_artifacts',
          'document_archive_quarantine_job_artifacts_reference_fence',
          'public.prevent_document_archive_quarantine_reference_v1()'::pg_catalog.regprocedure,
          23, 'storageKey'),
         ('public', 'document_archive_jobs', 'document_archive_quarantine_worker_lease_fence',
          'public.prevent_document_archive_worker_during_quarantine_v1()'::pg_catalog.regprocedure,
          23, 'leaseToken')
     ), exact_fence_inventory AS (
       SELECT count(trigger.oid)::bigint AS count
         FROM expected_fence AS expected
         LEFT JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.nspname = expected.schema_name
         LEFT JOIN pg_catalog.pg_class AS relation
           ON relation.relnamespace = namespace.oid
          AND relation.relname = expected.relation_name
          AND relation.relkind IN ('r', 'p')
         LEFT JOIN pg_catalog.pg_attribute AS update_attribute
           ON update_attribute.attrelid = relation.oid
          AND update_attribute.attname = expected.update_column
          AND update_attribute.attnum > 0
          AND NOT update_attribute.attisdropped
         LEFT JOIN pg_catalog.pg_trigger AS trigger
           ON trigger.tgrelid = relation.oid
          AND trigger.tgname = expected.trigger_name
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
          END
     ), named_fence_inventory AS (
       SELECT count(*)::bigint AS count
         FROM pg_catalog.pg_trigger AS trigger
        WHERE NOT trigger.tgisinternal
          AND trigger.tgname IN (
            'generated_legal_storage_object_immutable',
            'document_archive_quarantine_bucket_fence',
            'document_archive_quarantine_documents_reference_fence',
            'document_archive_quarantine_versions_reference_fence',
            'document_archive_quarantine_photos_reference_fence',
            'document_archive_quarantine_intents_reference_fence',
            'document_archive_quarantine_job_artifacts_reference_fence',
            'document_archive_quarantine_worker_lease_fence'
          )
     )
     SELECT
       (SELECT count(*) FROM public.document_archive_quarantine_operations AS operation
         WHERE operation.id = $1::uuid
           AND operation.environment = 'staging'
           AND operation."manifestDigest" = $5
           AND operation."releaseSha" = $6
           AND operation."sourceBucket" = $2
           AND operation."destinationBucket" = $3
           AND operation."entryCount" = 5)::bigint AS "operationExact",
       (SELECT count(*) FROM operation_entries)::bigint AS entries,
       (SELECT count(*) FROM storage.objects AS object
         JOIN operation_entries AS entry ON entry."sourceKey" = object.name
        WHERE object.bucket_id = $2)::bigint AS sources,
       (SELECT count(*)
          FROM operation_entries AS entry
          JOIN public.document_archive_quarantine_events AS event
            ON event."operationId" = entry."operationId"
           AND event.kind = 'destination_verified'
           AND event.ordinal = entry.ordinal
           AND event."byteSha256" = btrim(entry."byteSha256"::text)
           AND event."byteSize" = entry."byteSize"
           AND event."contentType" = entry."contentType"
          JOIN storage.objects AS object
            ON object.bucket_id = entry."destinationBucket"
           AND object.name = entry."destinationKey"
           AND event."objectId" = object.id
           AND event."objectVersion" IS NOT DISTINCT FROM to_jsonb(object)->>'version'
           AND event."objectCreatedAt" = object.created_at
           AND event."objectUpdatedAt" = object.updated_at
           AND event."objectMetadata" = coalesce(to_jsonb(object)->'metadata', 'null'::jsonb)
           AND event."objectUserMetadata" =
             coalesce(to_jsonb(object)->'user_metadata', 'null'::jsonb))::bigint
         AS "destinationsExact",
       ((SELECT count(*) FROM public.documents
          WHERE "storageKey" IN (SELECT "sourceKey" FROM operation_entries))
        + (SELECT count(*) FROM public.document_versions
          WHERE "storageKey" IN (SELECT "sourceKey" FROM operation_entries))
        + (SELECT count(*) FROM public.chantier_photos
          WHERE "storageKey" IN (SELECT "sourceKey" FROM operation_entries))
        + (SELECT count(*) FROM public.document_archive_artifact_intents
          WHERE "storageKey" IN (SELECT "sourceKey" FROM operation_entries))
        + (SELECT count(*) FROM public.document_archive_job_artifacts
          WHERE "storageKey" IN (SELECT "sourceKey" FROM operation_entries)))::bigint
         AS references,
       (SELECT count(*)
          FROM public.document_archive_quarantine_operations AS operation
          JOIN public.document_archive_quarantine_events AS event
            ON event."operationId" = operation.id
           AND event.kind IN ('copied_verified', 'deleted_verified')
           AND event.ordinal = 0
          JOIN storage.objects AS object
            ON object.bucket_id = operation."destinationBucket"
           AND object.name = CASE event.kind
             WHEN 'copied_verified' THEN operation."copyReceiptKey"
             ELSE operation."deletedReceiptKey"
           END
           AND event."objectId" = object.id
           AND event."objectVersion" IS NOT DISTINCT FROM to_jsonb(object)->>'version'
           AND event."objectCreatedAt" = object.created_at
           AND event."objectUpdatedAt" = object.updated_at
           AND event."objectMetadata" = coalesce(to_jsonb(object)->'metadata', 'null'::jsonb)
           AND event."objectUserMetadata" =
             coalesce(to_jsonb(object)->'user_metadata', 'null'::jsonb)
           AND event."contentType" = 'application/json'
         WHERE operation.id = $1::uuid)::bigint AS "receiptsExact",
       (SELECT count(*) FROM public.document_archive_quarantine_events
         WHERE "operationId" = $1::uuid AND kind = 'plan_authorized')::bigint
         AS "planAuthorized",
       (SELECT count(*) FROM public.document_archive_quarantine_events
         WHERE "operationId" = $1::uuid AND kind = 'authorized')::bigint AS authorized,
       (SELECT count(*) FROM public.document_archive_quarantine_events
         WHERE "operationId" = $1::uuid AND kind = 'destination_verified')::bigint
         AS "destinationEvents",
       (SELECT count(*) FROM public.document_archive_quarantine_events
         WHERE "operationId" = $1::uuid AND kind = 'copied_verified')::bigint
         AS "copiedVerified",
       (SELECT count(*) FROM public.document_archive_quarantine_events
         WHERE "operationId" = $1::uuid AND kind = 'source_deleted')::bigint AS "sourceDeleted",
       (SELECT count(*) FROM public.document_archive_quarantine_events
         WHERE "operationId" = $1::uuid AND kind = 'deleted_verified')::bigint
         AS "deletedVerified",
       (SELECT count(*) FROM public.document_archive_quarantine_events
         WHERE "operationId" = $1::uuid AND kind = 'final_audit_verified')::bigint
         AS "finalAuditVerified",
       (SELECT count(*) FROM public.document_archive_quarantine_events
         WHERE "operationId" = $1::uuid AND kind = 'completed')::bigint AS completed,
       (SELECT count(*) FROM storage.objects AS object
         WHERE object.bucket_id = $2
           AND (object.name LIKE 'companies/%/documents/%'
             OR object.name LIKE 'companies/%/chantiers/%')
           AND NOT EXISTS (
             SELECT 1 FROM referenced_objects AS reference
              WHERE reference."storageKey" = object.name
           ))::bigint AS "globalOrphans",
       (SELECT count(DISTINCT reference."storageKey")
          FROM referenced_objects AS reference
          LEFT JOIN storage.objects AS object
            ON object.bucket_id = $2 AND object.name = reference."storageKey"
         WHERE object.id IS NULL)::bigint AS "globalMissing",
       (SELECT count(*) FROM storage.buckets
         WHERE id IN ($2, $3) AND name = id AND public = false
           AND (id <> $3 OR (
             file_size_limit = $4::bigint
             AND allowed_mime_types @> ARRAY['application/pdf','application/json']::text[]
             AND allowed_mime_types <@ ARRAY['application/pdf','application/json']::text[]
           )))::bigint AS "privateBuckets",
       (SELECT count(*) FROM public.document_archive_jobs
         WHERE "leaseToken" IS NOT NULL)::bigint AS "liveArchiveLeases",
       (SELECT count FROM exact_fence_inventory)::bigint AS "exactFences",
       (SELECT count FROM named_fence_inventory)::bigint AS "namedFences"`,
    input.operationId,
    input.manifest.sourceBucket,
    input.manifest.destinationBucket,
    input.maxObjectBytes,
    input.manifest.confirmationDigest,
    input.manifest.releaseSha,
  );
  const row = rows[0];
  const failures = rows.length !== 1 || row === undefined
    ? ['row']
    : [
      row.operationExact === 1n ? null : 'operation',
      row.entries === 5n ? null : 'entries',
      row.sources === 0n ? null : 'sources',
      row.destinationsExact === 5n ? null : 'destinations',
      row.references === 0n ? null : 'references',
      row.receiptsExact === 2n ? null : 'receipts',
      row.planAuthorized === 1n ? null : 'plan_authorized',
      row.authorized === 1n ? null : 'authorized',
      row.destinationEvents === 5n ? null : 'destination_events',
      row.copiedVerified === 1n ? null : 'copied_verified',
      row.sourceDeleted === 5n ? null : 'source_deleted',
      row.deletedVerified === 1n ? null : 'deleted_verified',
      row.finalAuditVerified === 1n ? null : 'final_audit_verified',
      row.completed === 0n ? null : 'completed',
      row.globalOrphans === 0n ? null : 'global_orphans',
      row.globalMissing === 0n ? null : 'global_missing',
      row.privateBuckets === 2n ? null : 'buckets',
      row.liveArchiveLeases === 0n ? null : 'leases',
      row.exactFences === 8n ? null : 'fences_exact',
      row.namedFences === 8n ? null : 'fences_named',
    ].filter((value): value is string => value !== null);
  if (failures.length > 0) {
    const safeCounts = row === undefined
      ? ''
      : `:${row.destinationsExact.toString()}/${row.receiptsExact.toString()}`;
    throw new Error(
      `ARCHIVE_QUARANTINE_COMPLETION_STATE_CHANGED:${failures.join(',')}${safeCounts}`,
    );
  }
}

export class ArchiveQuarantineRepository implements ArchiveQuarantineSafetyGuard {
  constructor(
    readonly authority: PrismaClient,
    readonly config: ArchiveQuarantineRuntimeConfig,
  ) {}

  async loadPinnedAudit(pin: ArchiveQuarantineAuditPin): Promise<ArchivePreactivationAuditReport> {
    const rows = await this.authority.$queryRawUnsafe<Array<{
      releaseSha: string;
      databaseIdentity: string;
      storageBucket: string;
      inventoryDigest: string;
      reportSha256: string;
      mode: string;
      protocolVersion: number;
      counts: unknown;
      issueCodes: string[];
      readyForActivation: boolean;
      privateReport: unknown;
      auditedAt: Date;
      createdAt: Date;
      databaseNow: Date;
    }>>(
      `SELECT btrim("releaseSha"::text) AS "releaseSha",
              "databaseIdentity"::text AS "databaseIdentity",
              "storageBucket", btrim("inventoryDigest"::text) AS "inventoryDigest",
              btrim("reportSha256"::text) AS "reportSha256", mode, "protocolVersion",
              counts, "issueCodes", "readyForActivation", "privateReport", "auditedAt",
              "createdAt",
              clock_timestamp() AS "databaseNow"
         FROM public.document_archive_audit_evidence
        WHERE "deploymentId" = $1::uuid
          AND "releaseSha" = $2
          AND "inventoryDigest" = $3
          AND "reportSha256" = $4`,
      pin.deploymentId,
      this.config.releaseSha,
      pin.inventoryDigest,
      pin.reportSha256,
    );
    const row = rows[0];
    if (
      rows.length !== 1
      || row === undefined
      || row.releaseSha !== this.config.releaseSha
      || row.storageBucket !== this.config.sourceBucket
      || row.inventoryDigest !== pin.inventoryDigest
      || row.reportSha256 !== pin.reportSha256
      || row.mode !== 'protocol-v2-verified'
      || row.protocolVersion !== 2
      || row.readyForActivation
      || !UUID.test(row.databaseIdentity)
      || !(row.auditedAt instanceof Date)
      || !(row.createdAt instanceof Date)
      || !(row.databaseNow instanceof Date)
      || row.createdAt.getTime() < row.auditedAt.getTime()
      || row.databaseNow.getTime() < row.createdAt.getTime()
      || row.databaseNow.getTime() - row.createdAt.getTime() > AUDIT_FRESHNESS_MS
    ) {
      throw new Error('ARCHIVE_QUARANTINE_AUDIT_EVIDENCE_DIVERGENT');
    }
    const report = asAuditReport(row.privateReport);
    if (
      report.releaseSha !== row.releaseSha
      || report.auditedAt !== row.auditedAt.toISOString()
      || report.storageBucket !== row.storageBucket
      || report.inventoryDigest !== row.inventoryDigest
      || report.databaseFingerprint !== databaseFingerprint(row.databaseIdentity)
      || !sameJson(report.counts, row.counts)
      || !sameJson([...new Set(report.issues.map(({ code }) => code))].sort(), [...row.issueCodes].sort())
    ) {
      throw new Error('ARCHIVE_QUARANTINE_PRIVATE_REPORT_DIVERGENT');
    }
    return report;
  }

  async loadFinalAudit(
    pin: ArchiveQuarantineAuditPin,
    manifestInput: ArchiveQuarantineManifest,
  ): Promise<ArchiveQuarantineFinalAuditEvidence> {
    const manifest = validateArchiveQuarantineManifest(manifestInput);
    const rows = await this.authority.$queryRawUnsafe<Array<{
      releaseSha: string;
      databaseIdentity: string;
      storageBucket: string;
      inventoryDigest: string;
      reportSha256: string;
      mode: string;
      protocolVersion: number;
      counts: unknown;
      issueCodes: string[];
      readyForActivation: boolean;
      privateReport: unknown;
      auditedAt: Date;
      createdAt: Date;
      databaseNow: Date;
    }>>(
      `SELECT btrim("releaseSha"::text) AS "releaseSha",
              "databaseIdentity"::text AS "databaseIdentity", "storageBucket",
              btrim("inventoryDigest"::text) AS "inventoryDigest",
              btrim("reportSha256"::text) AS "reportSha256", mode, "protocolVersion",
              counts, "issueCodes", "readyForActivation", "privateReport", "auditedAt",
              "createdAt", clock_timestamp() AS "databaseNow"
         FROM public.document_archive_audit_evidence
        WHERE "deploymentId" = $1::uuid
          AND "releaseSha" = $2
          AND "inventoryDigest" = $3
          AND "reportSha256" = $4
          AND "storageBucket" = $5`,
      pin.deploymentId,
      manifest.releaseSha,
      pin.inventoryDigest,
      pin.reportSha256,
      manifest.sourceBucket,
    );
    const row = rows[0];
    if (
      rows.length !== 1
      || row === undefined
      || row.releaseSha !== manifest.releaseSha
      || row.storageBucket !== manifest.sourceBucket
      || row.inventoryDigest !== pin.inventoryDigest
      || row.reportSha256 !== pin.reportSha256
      || row.mode !== 'protocol-v2-verified'
      || row.protocolVersion !== 2
      || row.readyForActivation !== true
      || !UUID.test(row.databaseIdentity)
      || databaseFingerprint(row.databaseIdentity) !== manifest.databaseFingerprint
      || !(row.auditedAt instanceof Date)
      || !(row.createdAt instanceof Date)
      || !(row.databaseNow instanceof Date)
      || row.createdAt.getTime() < row.auditedAt.getTime()
      || row.databaseNow.getTime() < row.createdAt.getTime()
      || row.databaseNow.getTime() - row.createdAt.getTime() > AUDIT_FRESHNESS_MS
      || row.issueCodes.length !== 0
    ) {
      throw new Error('ARCHIVE_QUARANTINE_FINAL_AUDIT_DIVERGENT');
    }
    const report = asAuditReport(row.privateReport);
    if (
      report.releaseSha !== manifest.releaseSha
      || report.auditedAt !== row.auditedAt.toISOString()
      || report.storageBucket !== manifest.sourceBucket
      || report.inventoryDigest !== pin.inventoryDigest
      || report.databaseFingerprint !== manifest.databaseFingerprint
      || report.readyForActivation !== true
      || report.issues.length !== 0
      || report.counts.storageOrphans !== 0
      || report.counts.missingStoredObjects !== 0
      || report.counts.p0Issues !== 0
      || !sameJson(report.counts, row.counts)
    ) {
      throw new Error('ARCHIVE_QUARANTINE_FINAL_AUDIT_DIVERGENT');
    }
    return {
      deploymentId: pin.deploymentId,
      releaseSha: manifest.releaseSha,
      databaseFingerprint: manifest.databaseFingerprint,
      databaseSnapshotDigest: report.databaseSnapshotDigest,
      storageBucket: manifest.sourceBucket,
      inventoryDigest: pin.inventoryDigest,
      reportSha256: pin.reportSha256,
      auditedAt: row.auditedAt.toISOString(),
      readyForActivation: true,
      storageOrphans: 0,
      missingStoredObjects: 0,
      p0Issues: 0,
    };
  }

  async loadRecordedFinalAudit(
    manifestInput: ArchiveQuarantineManifest,
  ): Promise<ArchiveQuarantineFinalAuditEvidence | null> {
    const manifest = validateArchiveQuarantineManifest(manifestInput);
    const rows = await this.authority.$queryRawUnsafe<Array<{
      deploymentId: string;
      releaseSha: string;
      databaseIdentity: string;
      storageBucket: string;
      inventoryDigest: string;
      reportSha256: string;
      auditedAt: Date;
      counts: unknown;
      issueCodes: string[];
      readyForActivation: boolean;
      privateReport: unknown;
      eventEvidence: unknown;
    }>>(
      `SELECT audit."deploymentId"::text AS "deploymentId",
              btrim(audit."releaseSha"::text) AS "releaseSha",
              audit."databaseIdentity"::text AS "databaseIdentity",
              audit."storageBucket", btrim(audit."inventoryDigest"::text) AS "inventoryDigest",
              btrim(audit."reportSha256"::text) AS "reportSha256", audit."auditedAt",
              audit.counts, audit."issueCodes", audit."readyForActivation",
              audit."privateReport", final.evidence AS "eventEvidence"
         FROM public.document_archive_quarantine_operations AS operation
         JOIN public.document_archive_quarantine_events AS final
           ON final."operationId" = operation.id
          AND final.kind = 'final_audit_verified'
          AND final.ordinal = 0
         JOIN public.document_archive_audit_evidence AS audit
           ON audit."deploymentId" = final."finalAuditDeploymentId"
          AND audit."releaseSha" = final."finalAuditReleaseSha"
          AND audit."inventoryDigest" = final."finalAuditInventoryDigest"
          AND audit."reportSha256" = final."finalAuditReportSha256"
          AND audit."storageBucket" = final."finalAuditStorageBucket"
          AND audit."databaseIdentity" = final."finalAuditDatabaseIdentity"
        WHERE operation."manifestDigest" = $1
          AND operation."releaseSha" = $2`,
      manifest.confirmationDigest,
      manifest.releaseSha,
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    if (rows.length !== 1 || row === undefined || !(row.auditedAt instanceof Date)) {
      throw new Error('ARCHIVE_QUARANTINE_RECORDED_FINAL_AUDIT_DIVERGENT');
    }
    const report = asAuditReport(row.privateReport);
    const eventEvidence = typeof row.eventEvidence === 'object'
      && row.eventEvidence !== null
      && !Array.isArray(row.eventEvidence)
      ? row.eventEvidence as Record<string, unknown>
      : null;
    if (
      row.releaseSha !== manifest.releaseSha
      || row.storageBucket !== manifest.sourceBucket
      || databaseFingerprint(row.databaseIdentity) !== manifest.databaseFingerprint
      || row.readyForActivation !== true
      || row.issueCodes.length !== 0
      || report.releaseSha !== manifest.releaseSha
      || report.auditedAt !== row.auditedAt.toISOString()
      || report.storageBucket !== manifest.sourceBucket
      || report.inventoryDigest !== row.inventoryDigest
      || report.databaseFingerprint !== manifest.databaseFingerprint
      || report.readyForActivation !== true
      || report.issues.length !== 0
      || report.counts.storageOrphans !== 0
      || report.counts.missingStoredObjects !== 0
      || report.counts.p0Issues !== 0
      || !sameJson(report.counts, row.counts)
      || eventEvidence === null
      || eventEvidence.databaseSnapshotDigest !== report.databaseSnapshotDigest
      || eventEvidence.deploymentId !== row.deploymentId
      || eventEvidence.inventoryDigest !== row.inventoryDigest
      || eventEvidence.reportSha256 !== row.reportSha256
    ) {
      throw new Error('ARCHIVE_QUARANTINE_RECORDED_FINAL_AUDIT_DIVERGENT');
    }
    return {
      deploymentId: row.deploymentId,
      releaseSha: manifest.releaseSha,
      databaseFingerprint: manifest.databaseFingerprint,
      databaseSnapshotDigest: report.databaseSnapshotDigest,
      storageBucket: manifest.sourceBucket,
      inventoryDigest: row.inventoryDigest,
      reportSha256: row.reportSha256,
      auditedAt: row.auditedAt.toISOString(),
      readyForActivation: true,
      storageOrphans: 0,
      missingStoredObjects: 0,
      p0Issues: 0,
    };
  }

  private async ownerRole(
    transaction: Prisma.TransactionClient,
  ): Promise<{ readonly owner: string; readonly current: string }> {
    const rows = await transaction.$queryRawUnsafe<Array<{ owner: string; current: string }>>(
      `SELECT pg_catalog.pg_get_userbyid(relation.relowner) AS owner,
              current_user::text AS current
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'document_archive_quarantine_operations'
          AND relation.relkind IN ('r', 'p')`,
    );
    if (rows.length !== 1 || rows[0] === undefined) {
      throw new Error('ARCHIVE_QUARANTINE_OWNER_UNAVAILABLE');
    }
    quoteRole(rows[0].owner);
    return rows[0];
  }

  private async assumeOwner(
    transaction: Prisma.TransactionClient,
    owner: { readonly owner: string; readonly current: string },
  ): Promise<void> {
    if (owner.current !== owner.owner) {
      const rights = await transaction.$queryRawUnsafe<Array<{ allowed: boolean }>>(
        `SELECT pg_catalog.pg_has_role(session_user, $1, 'SET') AS allowed`,
        owner.owner,
      );
      if (rights.length !== 1 || rights[0]?.allowed !== true) {
        throw new Error('ARCHIVE_QUARANTINE_OWNER_SET_DENIED');
      }
      await transaction.$executeRawUnsafe(`SET LOCAL ROLE ${quoteRole(owner.owner)}`);
    }
    await transaction.$executeRawUnsafe('SET LOCAL row_security = off');
  }

  async sealPlan(
    manifestInput: ArchiveQuarantineManifest,
    workflowIdentity: ArchiveQuarantineWorkflowIdentity,
  ): Promise<string> {
    const manifest = validateArchiveQuarantineManifest(manifestInput);
    validateArchiveQuarantineWorkflowIdentity(workflowIdentity, manifest.releaseSha);
    const companyId = companyIdForManifest(manifest);
    return this.authority.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
      await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '60s'");
      const leases = await transaction.$queryRawUnsafe<Array<{
        audit: boolean;
        quarantine: boolean;
      }>>(
        `SELECT
           pg_catalog.pg_try_advisory_xact_lock(
             pg_catalog.hashtextextended('bob-document-archive-byte-audit', 0)
           ) AS audit,
           pg_catalog.pg_try_advisory_xact_lock(
             pg_catalog.hashtextextended('bob-document-archive-quarantine', 0)
           ) AS quarantine`,
      );
      if (leases.length !== 1 || !leases[0]?.audit || !leases[0].quarantine) {
        throw new Error('ARCHIVE_QUARANTINE_EXCLUSIVE_LEASE_UNAVAILABLE');
      }
      await transaction.$executeRawUnsafe('LOCK TABLE storage.objects IN SHARE ROW EXCLUSIVE MODE');
      await transaction.$executeRawUnsafe('LOCK TABLE storage.buckets IN SHARE ROW EXCLUSIVE MODE');
      await transaction.$executeRawUnsafe('LOCK TABLE public.documents IN SHARE ROW EXCLUSIVE MODE');
      await transaction.$executeRawUnsafe(
        'LOCK TABLE public.document_versions IN SHARE ROW EXCLUSIVE MODE',
      );
      await transaction.$executeRawUnsafe(
        'LOCK TABLE public.chantier_photos IN SHARE ROW EXCLUSIVE MODE',
      );
      await transaction.$executeRawUnsafe(
        'LOCK TABLE public.document_archive_artifact_intents IN SHARE ROW EXCLUSIVE MODE',
      );
      await transaction.$executeRawUnsafe(
        'LOCK TABLE public.document_archive_job_artifacts IN SHARE ROW EXCLUSIVE MODE',
      );
      await transaction.$executeRawUnsafe(
        'LOCK TABLE public.document_archive_jobs IN SHARE ROW EXCLUSIVE MODE',
      );

      // A sealed plan is the durable replay authority. Check it before requiring the original
      // sources/destinations to still be in the pre-apply state: after a partial or completed apply,
      // those facts have intentionally moved forward and a plan replay must remain idempotent.
      const existing = await transaction.$queryRawUnsafe<Array<{
        id: string;
        privateManifest: unknown;
        planWorkflowIdentity: unknown;
      }>>(
        `SELECT operation.id::text AS id, operation."privateManifest",
                event."workflowIdentity" AS "planWorkflowIdentity"
           FROM public.document_archive_quarantine_operations AS operation
           LEFT JOIN public.document_archive_quarantine_events AS event
             ON event."operationId" = operation.id
            AND event.kind = 'plan_authorized'
            AND event.ordinal = 0
          WHERE operation."manifestDigest" = $1`,
        manifest.confirmationDigest,
      );
      if (existing.length === 1) {
        if (
          !sameJson(existing[0]?.privateManifest, manifest)
          || !sameStableWorkflowIdentity(existing[0]?.planWorkflowIdentity, workflowIdentity)
        ) {
          throw new Error('ARCHIVE_QUARANTINE_SEALED_PLAN_DIVERGENT');
        }
        return existing[0]!.id;
      }
      if (existing.length !== 0) throw new Error('ARCHIVE_QUARANTINE_SEALED_PLAN_AMBIGUOUS');

      const evidence = await transaction.$queryRawUnsafe<Array<{
        databaseIdentity: string;
        counts: unknown;
        privateReport: unknown;
        issueCodes: string[];
        auditedAt: Date;
        createdAt: Date;
        databaseNow: Date;
      }>>(
        `SELECT evidence."databaseIdentity"::text AS "databaseIdentity",
                evidence.counts, evidence."issueCodes", evidence."privateReport",
                evidence."auditedAt", evidence."createdAt",
                clock_timestamp() AS "databaseNow"
           FROM public.document_archive_audit_evidence AS evidence
          WHERE evidence."deploymentId" = $1::uuid
            AND evidence."releaseSha" = $2
            AND evidence."inventoryDigest" = $3
            AND evidence."reportSha256" = $4
            AND evidence."storageBucket" = $5
            AND evidence."protocolVersion" = 2
            AND evidence.mode = 'protocol-v2-verified'
            AND evidence."readyForActivation" = false
          FOR SHARE`,
        manifest.auditDeploymentId,
        manifest.releaseSha,
        manifest.sourceAuditInventoryDigest,
        manifest.auditReportSha256,
        manifest.sourceBucket,
      );
      if (evidence.length !== 1 || evidence[0] === undefined) {
        throw new Error('ARCHIVE_QUARANTINE_AUDIT_EVIDENCE_CHANGED');
      }
      const report = asAuditReport(evidence[0].privateReport);
      if (
        !sameJson(report.counts, evidence[0].counts)
        || !(evidence[0].auditedAt instanceof Date)
        || !(evidence[0].createdAt instanceof Date)
        || !(evidence[0].databaseNow instanceof Date)
        || report.auditedAt !== evidence[0].auditedAt.toISOString()
        || evidence[0].createdAt.getTime() < evidence[0].auditedAt.getTime()
        || evidence[0].databaseNow.getTime() < evidence[0].createdAt.getTime()
        || evidence[0].databaseNow.getTime() - evidence[0].createdAt.getTime()
          > AUDIT_FRESHNESS_MS
        || !sameJson(
          [...new Set(report.issues.map(({ code }) => code))].sort(),
          [...evidence[0].issueCodes].sort(),
        )
        || report.databaseSnapshotDigest !== manifest.databaseSnapshotDigest
        || report.databaseFingerprint !== databaseFingerprint(evidence[0].databaseIdentity)
      ) {
        throw new Error('ARCHIVE_QUARANTINE_AUDIT_EVIDENCE_CHANGED');
      }

      const buckets = await transaction.$queryRawUnsafe<Array<{ id: string; isPublic: boolean }>>(
        `SELECT id, public AS "isPublic" FROM storage.buckets WHERE id = ANY($1::text[])`,
        [manifest.sourceBucket, manifest.destinationBucket],
      );
      if (
        buckets.length !== 2
        || buckets.some(({ isPublic }) => isPublic)
        || new Set(buckets.map(({ id }) => id)).size !== 2
      ) {
        throw new Error('ARCHIVE_QUARANTINE_BUCKET_CHANGED');
      }

      const sourceKeys = manifest.entries.map(({ sourceKey }) => sourceKey);
      const destinationKeys = manifest.entries.map(({ destinationKey }) => destinationKey);
      const globalState = await transaction.$queryRawUnsafe<Array<{
        orphanKeys: string[];
        missingKeys: string[];
      }>>(
        `WITH referenced_objects AS (
           SELECT "storageKey" FROM public.documents
           UNION ALL SELECT "storageKey" FROM public.document_versions
           UNION ALL SELECT "storageKey" FROM public.chantier_photos
           UNION ALL SELECT "storageKey" FROM public.document_archive_artifact_intents
           UNION ALL SELECT "storageKey" FROM public.document_archive_job_artifacts
         )
         SELECT
           ARRAY(
             SELECT object.name
               FROM storage.objects AS object
              WHERE object.bucket_id = $1
                AND (object.name LIKE 'companies/%/documents/%'
                  OR object.name LIKE 'companies/%/chantiers/%')
                AND NOT EXISTS (
                  SELECT 1 FROM referenced_objects AS reference
                   WHERE reference."storageKey" = object.name
                )
              ORDER BY object.name
           ) AS "orphanKeys",
           ARRAY(
             SELECT DISTINCT reference."storageKey"
               FROM referenced_objects AS reference
               LEFT JOIN storage.objects AS object
                 ON object.bucket_id = $1 AND object.name = reference."storageKey"
              WHERE object.id IS NULL
              ORDER BY reference."storageKey"
           ) AS "missingKeys"`,
        manifest.sourceBucket,
      );
      if (
        globalState.length !== 1
        || !sameStringSet(globalState[0]?.orphanKeys ?? [], sourceKeys)
        || (globalState[0]?.missingKeys.length ?? -1) !== 0
      ) {
        throw new Error('ARCHIVE_QUARANTINE_GLOBAL_ARCHIVE_STATE_CHANGED');
      }
      const liveLeases = await transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*)::bigint AS count
           FROM public.document_archive_jobs
          WHERE "leaseToken" IS NOT NULL`,
      );
      if (liveLeases[0]?.count !== 0n) {
        throw new Error('ARCHIVE_QUARANTINE_ARCHIVE_WORKER_ACTIVE');
      }
      const sources = await transaction.$queryRawUnsafe<Array<StorageFactsRow & { key: string }>>(
        `SELECT object.name AS key, object.id::text AS "objectId",
                to_jsonb(object)->>'version' AS version,
                pg_catalog.to_char(object.created_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
                pg_catalog.to_char(object.updated_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
                coalesce(to_jsonb(object)->'metadata', 'null'::jsonb) AS metadata,
                coalesce(to_jsonb(object)->'user_metadata', 'null'::jsonb) AS "userMetadata"
           FROM storage.objects AS object
          WHERE object.bucket_id = $1 AND object.name = ANY($2::text[])
          ORDER BY object.name`,
        manifest.sourceBucket,
        sourceKeys,
      );
      if (sources.length !== 5) throw new Error('ARCHIVE_QUARANTINE_SOURCE_SET_CHANGED');
      const sourceByKey = new Map(sources.map((row) => [row.key, row]));
      for (const entry of manifest.entries) {
        const row = sourceByKey.get(entry.sourceKey);
        if (
          row === undefined
          || row.objectId !== entry.sourceObjectId
          || row.version !== entry.sourceObjectVersion
          || row.createdAt !== entry.sourceCreatedAt
          || row.updatedAt !== entry.sourceUpdatedAt
          || !sameJson(row.metadata, entry.sourceMetadata)
          || !sameJson(row.userMetadata, entry.sourceUserMetadata)
        ) {
          throw new Error(`ARCHIVE_QUARANTINE_SOURCE_FACTS_CHANGED:${entry.sourceKeySha256}`);
        }
      }
      const destinationCount = await transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*)::bigint AS count FROM storage.objects
          WHERE bucket_id = $1 AND name = ANY($2::text[])`,
        manifest.destinationBucket,
        destinationKeys,
      );
      if (destinationCount[0]?.count !== 0n) {
        throw new Error('ARCHIVE_QUARANTINE_DESTINATION_PREEXISTS');
      }
      const references = await transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT (
           (SELECT count(*) FROM public.documents WHERE "storageKey" = ANY($1::text[]))
           + (SELECT count(*) FROM public.document_versions WHERE "storageKey" = ANY($1::text[]))
           + (SELECT count(*) FROM public.chantier_photos WHERE "storageKey" = ANY($1::text[]))
           + (SELECT count(*) FROM public.document_archive_artifact_intents
               WHERE "storageKey" = ANY($1::text[]))
           + (SELECT count(*) FROM public.document_archive_job_artifacts
               WHERE "storageKey" = ANY($1::text[]))
         )::bigint AS count`,
        sourceKeys,
      );
      if (references[0]?.count !== 0n) throw new Error('ARCHIVE_QUARANTINE_SOURCE_REFERENCED');

      const owner = await this.ownerRole(transaction);
      await this.assumeOwner(transaction, owner);
      const inserted = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
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
        manifest.companyIdSha256,
        manifest.sourceBucket,
        manifest.destinationBucket,
        manifest.confirmationDigest,
        evidence[0].databaseIdentity,
        manifest.databaseSnapshotDigest,
        manifest.auditDeploymentId,
        manifest.releaseSha,
        manifest.sourceAuditInventoryDigest,
        manifest.auditReportSha256,
        `receipts/${manifest.confirmationDigest}/copied-verified.json`,
        `receipts/${manifest.confirmationDigest}/deleted-verified.json`,
        `receipts/${manifest.confirmationDigest}/completed.json`,
        JSON.stringify(manifest),
      );
      const operationId = inserted[0]?.id;
      if (inserted.length !== 1 || operationId === undefined || !UUID.test(operationId)) {
        throw new Error('ARCHIVE_QUARANTINE_PLAN_INSERT_FAILED');
      }
      for (const [index, entry] of manifest.entries.entries()) {
        await transaction.$executeRawUnsafe(
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
          index + 1,
          companyId,
          manifest.sourceBucket,
          manifest.destinationBucket,
          manifest.confirmationDigest,
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
      const clock = await transaction.$queryRawUnsafe<Array<{ now: Date }>>(
        'SELECT clock_timestamp() AS now',
      );
      const planAuthorizedAt = clock[0]?.now;
      if (!(planAuthorizedAt instanceof Date) || Number.isNaN(planAuthorizedAt.getTime())) {
        throw new Error('ARCHIVE_QUARANTINE_DATABASE_CLOCK_INVALID');
      }
      const planAuthorityEvidence = {
        schemaVersion: 1,
        authorizationRecordedAt: planAuthorizedAt.toISOString(),
        authorizationChannel: 'github-actions:workflow_dispatch',
        manifestDigest: manifest.confirmationDigest,
        tokenSha256: workflowIdentity.tokenSha256,
      } as const;
      await transaction.$executeRawUnsafe(
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
      return operationId;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 65_000 });
  }

  async loadManifest(manifestDigest: string): Promise<ArchiveQuarantineManifest> {
    if (!SHA256.test(manifestDigest)) throw new Error('ARCHIVE_QUARANTINE_MANIFEST_DIGEST_INVALID');
    const rows = await this.authority.$queryRawUnsafe<Array<{ privateManifest: unknown }>>(
      `SELECT "privateManifest" FROM public.document_archive_quarantine_operations
        WHERE "manifestDigest" = $1`,
      manifestDigest,
    );
    if (rows.length !== 1 || rows[0] === undefined) {
      throw new Error('ARCHIVE_QUARANTINE_PLAN_NOT_FOUND');
    }
    return validateArchiveQuarantineManifest(rows[0].privateManifest as ArchiveQuarantineManifest);
  }

  async loadRecoverablePlan(input: {
    releaseSha: string;
    target: ArchiveQuarantineTarget;
    workflowIdentity: ArchiveQuarantineWorkflowIdentity;
  }): Promise<ArchiveQuarantineManifest | null> {
    validateArchiveQuarantineWorkflowIdentity(input.workflowIdentity, input.releaseSha);
    const rows = await this.authority.$queryRawUnsafe<Array<{
      privateManifest: unknown;
      workflowIdentity: unknown;
    }>>(
      `SELECT operation."privateManifest", planned."workflowIdentity"
         FROM public.document_archive_quarantine_operations AS operation
         JOIN public.document_archive_quarantine_events AS planned
           ON planned."operationId" = operation.id
          AND planned.kind = 'plan_authorized'
          AND planned.ordinal = 0
        WHERE operation."releaseSha" = $1
          AND operation.environment = 'staging'
          AND operation."sourceBucket" = $2
          AND operation."destinationBucket" = $3
          AND NOT EXISTS (
            SELECT 1 FROM public.document_archive_quarantine_events AS completed
             WHERE completed."operationId" = operation.id AND completed.kind = 'completed'
          )`,
      input.releaseSha,
      this.config.sourceBucket,
      this.config.destinationBucket,
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1 || rows[0] === undefined) {
      throw new Error('ARCHIVE_QUARANTINE_RECOVERABLE_PLAN_AMBIGUOUS');
    }
    const manifest = validateArchiveQuarantineManifest(
      rows[0].privateManifest as ArchiveQuarantineManifest,
    );
    if (
      manifest.releaseSha !== input.releaseSha
      || manifest.sourceBucket !== this.config.sourceBucket
      || manifest.destinationBucket !== this.config.destinationBucket
      || manifest.companyIdSha256 !== input.target.companyIdSha256
      || !sameStringSet(
        manifest.entries.map(({ sourceKeySha256 }) => sourceKeySha256),
        input.target.sourceKeySha256s,
      )
      || !sameStableWorkflowIdentity(rows[0].workflowIdentity, input.workflowIdentity)
    ) {
      throw new Error('ARCHIVE_QUARANTINE_RECOVERABLE_PLAN_DIVERGENT');
    }
    return manifest;
  }

  private async operationId(manifest: ArchiveQuarantineManifest): Promise<string> {
    const rows = await this.authority.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM public.document_archive_quarantine_operations
        WHERE "manifestDigest" = $1 AND "releaseSha" = $2`,
      manifest.confirmationDigest,
      manifest.releaseSha,
    );
    if (rows.length !== 1 || !UUID.test(rows[0]?.id ?? '')) {
      throw new Error('ARCHIVE_QUARANTINE_PLAN_NOT_SEALED');
    }
    return rows[0]!.id;
  }

  async assertPlanSealed(manifest: ArchiveQuarantineManifest): Promise<void> {
    const persisted = await this.loadManifest(manifest.confirmationDigest);
    if (!sameJson(persisted, manifest)) {
      throw new Error('ARCHIVE_QUARANTINE_PLAN_NOT_SEALED');
    }
  }

  async recordAuthorized(input: {
    manifest: ArchiveQuarantineManifest;
    authorization: ArchiveQuarantineAuthorization;
  }): Promise<void> {
    const operationId = await this.operationId(input.manifest);
    const evidence = {
      schemaVersion: 1,
      authorizationRecordedAt: input.authorization.authorizationRecordedAt,
      authorizationChannel: input.authorization.authorizationChannel,
      manifestDigest: input.manifest.confirmationDigest,
      tokenSha256: input.authorization.workflow.tokenSha256,
    } as const;
    await this.authority.$transaction(async (transaction) => {
      const owner = await this.ownerRole(transaction);
      await this.assumeOwner(transaction, owner);
      const planAuthorities = await transaction.$queryRawUnsafe<Array<{
        workflowIdentity: unknown;
      }>>(
        `SELECT "workflowIdentity" FROM public.document_archive_quarantine_events
          WHERE "operationId" = $1::uuid AND kind = 'plan_authorized' AND ordinal = 0
          FOR SHARE`,
        operationId,
      );
      if (planAuthorities.length !== 1) {
        throw new Error('ARCHIVE_QUARANTINE_APPLY_AUTHORITY_DIVERGENT');
      }
      assertDistinctArchiveQuarantineApplyAuthority(
        planAuthorities[0]?.workflowIdentity,
        input.authorization.workflow,
      );
      await transaction.$executeRawUnsafe(
        `INSERT INTO public.document_archive_quarantine_events (
           "operationId", kind, ordinal, evidence, "evidenceSha256", "workflowIdentity"
         ) VALUES (
           $1::uuid, 'authorized', 0, $2::jsonb,
           encode(sha256(convert_to($2::jsonb::text, 'UTF8')), 'hex'), $3::jsonb
         ) ON CONFLICT ("operationId", kind, ordinal) DO NOTHING`,
        operationId,
        JSON.stringify(evidence),
        JSON.stringify(input.authorization.workflow),
      );
      const rows = await transaction.$queryRawUnsafe<Array<{
        evidence: unknown;
        workflowIdentity: unknown;
      }>>(
        `SELECT evidence, "workflowIdentity" FROM public.document_archive_quarantine_events
          WHERE "operationId" = $1::uuid AND kind = 'authorized' AND ordinal = 0`,
        operationId,
      );
      const persistedEvidence = rows[0]?.evidence;
      const persistedWorkflow = rows[0]?.workflowIdentity;
      if (
        rows.length !== 1
        || typeof persistedEvidence !== 'object'
        || persistedEvidence === null
        || Array.isArray(persistedEvidence)
        || typeof persistedWorkflow !== 'object'
        || persistedWorkflow === null
        || Array.isArray(persistedWorkflow)
      ) {
        throw new Error('ARCHIVE_QUARANTINE_EVENT_DIVERGENT');
      }
      const savedEvidence = persistedEvidence as Record<string, unknown>;
      const savedWorkflow = persistedWorkflow as Record<string, unknown>;
      const stableEvidence = {
        schemaVersion: savedEvidence.schemaVersion,
        authorizationChannel: savedEvidence.authorizationChannel,
        manifestDigest: savedEvidence.manifestDigest,
      };
      const expectedStableEvidence = {
        schemaVersion: evidence.schemaVersion,
        authorizationChannel: evidence.authorizationChannel,
        manifestDigest: evidence.manifestDigest,
      };
      const stableWorkflow = {
        issuer: savedWorkflow.issuer,
        audience: savedWorkflow.audience,
        repository: savedWorkflow.repository,
        ref: savedWorkflow.ref,
        sha: savedWorkflow.sha,
        environment: savedWorkflow.environment,
        workflowRef: savedWorkflow.workflowRef,
        workflowSha: savedWorkflow.workflowSha,
        eventName: savedWorkflow.eventName,
        subject: savedWorkflow.subject,
        repositoryId: savedWorkflow.repositoryId,
        repositoryOwnerId: savedWorkflow.repositoryOwnerId,
        actorId: savedWorkflow.actorId,
      };
      const expectedStableWorkflow = {
        issuer: input.authorization.workflow.issuer,
        audience: input.authorization.workflow.audience,
        repository: input.authorization.workflow.repository,
        ref: input.authorization.workflow.ref,
        sha: input.authorization.workflow.sha,
        environment: input.authorization.workflow.environment,
        workflowRef: input.authorization.workflow.workflowRef,
        workflowSha: input.authorization.workflow.workflowSha,
        eventName: input.authorization.workflow.eventName,
        subject: input.authorization.workflow.subject,
        repositoryId: input.authorization.workflow.repositoryId,
        repositoryOwnerId: input.authorization.workflow.repositoryOwnerId,
        actorId: input.authorization.workflow.actorId,
      };
      if (
        Object.keys(savedEvidence).sort().join('\u0000')
          !== [
            'authorizationChannel', 'authorizationRecordedAt', 'manifestDigest',
            'schemaVersion', 'tokenSha256',
          ].sort().join('\u0000')
        || !sameJson(stableEvidence, expectedStableEvidence)
        || typeof savedEvidence.authorizationRecordedAt !== 'string'
        || Number.isNaN(new Date(savedEvidence.authorizationRecordedAt).getTime())
        || new Date(savedEvidence.authorizationRecordedAt).toISOString()
          !== savedEvidence.authorizationRecordedAt
        || typeof savedEvidence.tokenSha256 !== 'string'
        || !SHA256.test(savedEvidence.tokenSha256)
        || Object.keys(savedWorkflow).sort().join('\u0000')
          !== [
            'actor', 'actorId', 'audience', 'environment', 'issuer', 'ref', 'repository',
            'repositoryId', 'repositoryOwnerId', 'runAttempt', 'runId', 'sha', 'subject',
            'tokenSha256', 'workflowRef', 'workflowSha', 'eventName',
          ].sort().join('\u0000')
        || !sameJson(stableWorkflow, expectedStableWorkflow)
        || typeof savedWorkflow.actor !== 'string'
        || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(savedWorkflow.actor)
        || typeof savedWorkflow.runId !== 'string'
        || !/^[1-9][0-9]{0,19}$/u.test(savedWorkflow.runId)
        || !Number.isSafeInteger(savedWorkflow.runAttempt)
        || (savedWorkflow.runAttempt as number) < 1
        || savedWorkflow.tokenSha256 !== savedEvidence.tokenSha256
      ) {
        throw new Error('ARCHIVE_QUARANTINE_EVENT_DIVERGENT');
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 30_000 });
  }

  private async storageFactsForUpdate(
    transaction: Prisma.TransactionClient,
    bucket: string,
    key: string,
  ): Promise<StorageFactsRow> {
    const rows = await transaction.$queryRawUnsafe<StorageFactsRow[]>(
      `SELECT object.id::text AS "objectId", to_jsonb(object)->>'version' AS version,
              pg_catalog.to_char(object.created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
              pg_catalog.to_char(object.updated_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
              coalesce(to_jsonb(object)->'metadata', 'null'::jsonb) AS metadata,
              coalesce(to_jsonb(object)->'user_metadata', 'null'::jsonb) AS "userMetadata"
         FROM storage.objects AS object
        WHERE object.bucket_id = $1 AND object.name = $2
        FOR UPDATE`,
      bucket,
      key,
    );
    if (rows.length !== 1 || rows[0] === undefined) {
      throw new Error('ARCHIVE_QUARANTINE_VERIFIED_OBJECT_MISSING');
    }
    return rows[0];
  }

  private assertObjectFacts(row: StorageFactsRow, object: EventObjectFacts): void {
    if (
      row.objectId !== object.objectId
      || row.version !== object.version
      || row.createdAt !== object.createdAt
      || row.updatedAt !== object.updatedAt
      || !sameJson(row.metadata, object.metadata)
      || !sameJson(row.userMetadata, object.userMetadata)
    ) {
      throw new Error('ARCHIVE_QUARANTINE_VERIFIED_OBJECT_CHANGED');
    }
  }

  async recordDestinationVerified(input: {
    manifest: ArchiveQuarantineManifest;
    entry: ArchiveQuarantineManifestEntry;
    destination: ArchiveQuarantineObject;
  }): Promise<void> {
    const operationId = await this.operationId(input.manifest);
    const ordinal = input.manifest.entries.findIndex(
      ({ sourceKeySha256 }) => sourceKeySha256 === input.entry.sourceKeySha256,
    ) + 1;
    if (ordinal < 1) throw new Error('ARCHIVE_QUARANTINE_ENTRY_NOT_IN_MANIFEST');
    const facts = objectFacts(input.destination);
    if (
      facts.byteSha256 !== input.entry.sha256
      || facts.byteSize !== input.entry.byteSize
      || facts.contentType !== input.entry.contentType
    ) {
      throw new Error(`ARCHIVE_QUARANTINE_COPY_UNVERIFIED:${input.entry.sourceKeySha256}`);
    }
    await this.authority.$transaction(async (transaction) => {
      const row = await this.storageFactsForUpdate(
        transaction,
        input.manifest.destinationBucket,
        input.entry.destinationKey,
      );
      this.assertObjectFacts(row, facts);
      const owner = await this.ownerRole(transaction);
      await this.assumeOwner(transaction, owner);
      const evidence = {
        schemaVersion: 1,
        manifestDigest: input.manifest.confirmationDigest,
        ordinal,
        sourceKeySha256: input.entry.sourceKeySha256,
        byteSha256: facts.byteSha256,
        objectId: facts.objectId,
      } as const;
      await transaction.$executeRawUnsafe(
        `INSERT INTO public.document_archive_quarantine_events (
           "operationId", kind, ordinal, "objectId", "objectVersion", "objectCreatedAt",
           "objectUpdatedAt", "objectMetadata", "objectUserMetadata", "byteSha256", "byteSize",
           "contentType", evidence, "evidenceSha256"
         ) VALUES (
           $1::uuid, 'destination_verified', $2::smallint, $3::uuid, $4, $5::timestamptz,
           $6::timestamptz, $7::jsonb, $8::jsonb, $9, $10::bigint, $11, $12::jsonb,
           encode(sha256(convert_to($12::jsonb::text, 'UTF8')), 'hex')
         ) ON CONFLICT ("operationId", kind, ordinal) DO NOTHING`,
        operationId,
        ordinal,
        facts.objectId,
        facts.version,
        facts.createdAt,
        facts.updatedAt,
        JSON.stringify(facts.metadata),
        JSON.stringify(facts.userMetadata),
        facts.byteSha256,
        facts.byteSize,
        facts.contentType,
        JSON.stringify(evidence),
      );
      const exact = await transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*)::bigint AS count
           FROM public.document_archive_quarantine_events
          WHERE "operationId" = $1::uuid AND kind = 'destination_verified'
            AND ordinal = $2::smallint AND "objectId" = $3::uuid
            AND "objectVersion" IS NOT DISTINCT FROM $4
            AND "objectCreatedAt" = $5::timestamptz AND "objectUpdatedAt" = $6::timestamptz
            AND "objectMetadata" = $7::jsonb AND "objectUserMetadata" = $8::jsonb
            AND "byteSha256" = $9 AND "byteSize" = $10::bigint AND "contentType" = $11`,
        operationId,
        ordinal,
        facts.objectId,
        facts.version,
        facts.createdAt,
        facts.updatedAt,
        JSON.stringify(facts.metadata),
        JSON.stringify(facts.userMetadata),
        facts.byteSha256,
        facts.byteSize,
        facts.contentType,
      );
      if (exact[0]?.count !== 1n) throw new Error('ARCHIVE_QUARANTINE_EVENT_DIVERGENT');
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 30_000 });
  }

  private async recordReceiptEvent(input: {
    manifest: ArchiveQuarantineManifest;
    kind: 'copied_verified' | 'deleted_verified' | 'completed';
    storedBytesSha256: string;
    receipt: ArchiveQuarantineObject;
    receiptKey: string;
  }): Promise<void> {
    const operationId = await this.operationId(input.manifest);
    const facts = objectFacts(input.receipt);
    if (
      facts.byteSha256 !== input.storedBytesSha256
      || facts.contentType !== 'application/json'
    ) {
      throw new Error('ARCHIVE_QUARANTINE_RECEIPT_FACTS_INVALID');
    }
    await this.authority.$transaction(async (transaction) => {
      if (input.kind === 'completed') {
        const existing = await transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
          `SELECT count(*)::bigint AS count
             FROM public.document_archive_quarantine_events
            WHERE "operationId" = $1::uuid AND kind = 'completed' AND ordinal = 0`,
          operationId,
        );
        if (existing[0]?.count === 0n) {
          await assertArchiveQuarantineCompletionBoundary(transaction, {
            operationId,
            manifest: input.manifest,
            maxObjectBytes: this.config.maxObjectBytes,
          });
        } else if (existing[0]?.count !== 1n) {
          throw new Error('ARCHIVE_QUARANTINE_EVENT_DIVERGENT');
        }
      }
      const row = await this.storageFactsForUpdate(
        transaction,
        input.manifest.destinationBucket,
        input.receiptKey,
      );
      this.assertObjectFacts(row, facts);
      const prerequisites = await transaction.$queryRawUnsafe<Array<{
        destinations: bigint;
        deleted: bigint;
        deletedVerified: bigint;
        finalAuditVerified: bigint;
      }>>(
        `SELECT
           count(*) FILTER (WHERE kind = 'destination_verified')::bigint AS destinations,
           count(*) FILTER (WHERE kind = 'source_deleted')::bigint AS deleted,
           count(*) FILTER (WHERE kind = 'deleted_verified')::bigint AS "deletedVerified",
           count(*) FILTER (WHERE kind = 'final_audit_verified')::bigint AS "finalAuditVerified"
         FROM public.document_archive_quarantine_events
        WHERE "operationId" = $1::uuid`,
        operationId,
      );
      if (
        prerequisites[0]?.destinations !== 5n
        || (input.kind === 'deleted_verified' && prerequisites[0]?.deleted !== 5n)
        || (input.kind === 'completed' && (
          prerequisites[0]?.deleted !== 5n
          || prerequisites[0].deletedVerified !== 1n
          || prerequisites[0].finalAuditVerified !== 1n
        ))
      ) {
        throw new Error('ARCHIVE_QUARANTINE_RECEIPT_PREREQUISITES_MISSING');
      }
      const owner = await this.ownerRole(transaction);
      await this.assumeOwner(transaction, owner);
      const evidence = {
        schemaVersion: 1,
        manifestDigest: input.manifest.confirmationDigest,
        storedBytesSha256: input.storedBytesSha256,
        objectId: facts.objectId,
      } as const;
      await transaction.$executeRawUnsafe(
        `INSERT INTO public.document_archive_quarantine_events (
           "operationId", kind, ordinal, "objectId", "objectVersion", "objectCreatedAt",
           "objectUpdatedAt", "objectMetadata", "objectUserMetadata", "byteSha256", "byteSize",
           "contentType", evidence, "evidenceSha256"
         ) VALUES (
           $1::uuid, $2, 0, $3::uuid, $4, $5::timestamptz, $6::timestamptz,
           $7::jsonb, $8::jsonb, $9, $10::bigint, $11, $12::jsonb,
           encode(sha256(convert_to($12::jsonb::text, 'UTF8')), 'hex')
         ) ON CONFLICT ("operationId", kind, ordinal) DO NOTHING`,
        operationId,
        input.kind,
        facts.objectId,
        facts.version,
        facts.createdAt,
        facts.updatedAt,
        JSON.stringify(facts.metadata),
        JSON.stringify(facts.userMetadata),
        facts.byteSha256,
        facts.byteSize,
        facts.contentType,
        JSON.stringify(evidence),
      );
      const exact = await transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*)::bigint AS count
           FROM public.document_archive_quarantine_events
          WHERE "operationId" = $1::uuid AND kind = $2 AND ordinal = 0
            AND "objectId" = $3::uuid AND "byteSha256" = $4 AND "byteSize" = $5::bigint`,
        operationId,
        input.kind,
        facts.objectId,
        facts.byteSha256,
        facts.byteSize,
      );
      if (exact[0]?.count !== 1n) throw new Error('ARCHIVE_QUARANTINE_EVENT_DIVERGENT');
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 30_000 });
  }

  recordCopiedVerified(input: {
    manifest: ArchiveQuarantineManifest;
    storedBytesSha256: string;
    receipt: ArchiveQuarantineObject;
  }): Promise<void> {
    return this.recordReceiptEvent({
      ...input,
      kind: 'copied_verified',
      receiptKey: `receipts/${input.manifest.confirmationDigest}/copied-verified.json`,
    });
  }

  recordDeletedVerified(input: {
    manifest: ArchiveQuarantineManifest;
    storedBytesSha256: string;
    receipt: ArchiveQuarantineObject;
  }): Promise<void> {
    return this.recordReceiptEvent({
      ...input,
      kind: 'deleted_verified',
      receiptKey: `receipts/${input.manifest.confirmationDigest}/deleted-verified.json`,
    });
  }

  async assertEntryDeleteSafe(input: {
    manifest: ArchiveQuarantineManifest;
    entry: ArchiveQuarantineManifestEntry;
    removedSourceKeySha256s: readonly string[];
  }): Promise<void> {
    const operationId = await this.operationId(input.manifest);
    const ordinal = input.manifest.entries.findIndex(
      ({ sourceKeySha256 }) => sourceKeySha256 === input.entry.sourceKeySha256,
    ) + 1;
    const copyReceiptKey = `receipts/${input.manifest.confirmationDigest}/copied-verified.json`;
    await this.authority.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
      await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '30s'");
      await this.storageFactsForUpdate(
        transaction,
        input.manifest.destinationBucket,
        input.entry.destinationKey,
      );
      await this.storageFactsForUpdate(
        transaction,
        input.manifest.destinationBucket,
        copyReceiptKey,
      );
      const rows = await transaction.$queryRawUnsafe<Array<{
        sourceCount: bigint;
        references: bigint;
        destinations: bigint;
        destinationExact: bigint;
        copied: bigint;
        copyReceiptExact: bigint;
        authorized: bigint;
        deleted: bigint;
        activeFences: bigint;
        namedFences: bigint;
        liveArchiveLeases: bigint;
        privateBuckets: bigint;
      }>>(
        `WITH expected_fence(
           schema_name, relation_name, trigger_name, function_oid, trigger_type, update_column
         ) AS (
           VALUES
             ('storage', 'objects', 'generated_legal_storage_object_immutable',
              'public.prevent_generated_legal_storage_object_mutation()'::pg_catalog.regprocedure,
              31, NULL::text),
             ('storage', 'buckets', 'document_archive_quarantine_bucket_fence',
              'public.prevent_document_archive_quarantine_bucket_mutation_v1()'::pg_catalog.regprocedure,
              27, NULL::text),
             ('public', 'documents', 'document_archive_quarantine_documents_reference_fence',
              'public.prevent_document_archive_quarantine_reference_v1()'::pg_catalog.regprocedure,
              23, 'storageKey'),
             ('public', 'document_versions',
              'document_archive_quarantine_versions_reference_fence',
              'public.prevent_document_archive_quarantine_reference_v1()'::pg_catalog.regprocedure,
              23, 'storageKey'),
             ('public', 'chantier_photos',
              'document_archive_quarantine_photos_reference_fence',
              'public.prevent_document_archive_quarantine_reference_v1()'::pg_catalog.regprocedure,
              23, 'storageKey'),
             ('public', 'document_archive_artifact_intents',
              'document_archive_quarantine_intents_reference_fence',
              'public.prevent_document_archive_quarantine_reference_v1()'::pg_catalog.regprocedure,
              23, 'storageKey'),
             ('public', 'document_archive_job_artifacts',
              'document_archive_quarantine_job_artifacts_reference_fence',
              'public.prevent_document_archive_quarantine_reference_v1()'::pg_catalog.regprocedure,
              23, 'storageKey'),
             ('public', 'document_archive_jobs',
              'document_archive_quarantine_worker_lease_fence',
              'public.prevent_document_archive_worker_during_quarantine_v1()'::pg_catalog.regprocedure,
              23, 'leaseToken')
         )
         SELECT
           (SELECT count(*) FROM storage.objects WHERE bucket_id = $2 AND name = $3)::bigint
             AS "sourceCount",
           ((SELECT count(*) FROM public.documents WHERE "storageKey" = $3)
            + (SELECT count(*) FROM public.document_versions WHERE "storageKey" = $3)
            + (SELECT count(*) FROM public.chantier_photos WHERE "storageKey" = $3)
            + (SELECT count(*) FROM public.document_archive_artifact_intents WHERE "storageKey" = $3)
            + (SELECT count(*) FROM public.document_archive_job_artifacts WHERE "storageKey" = $3))::bigint
             AS references,
           (SELECT count(*) FROM public.document_archive_quarantine_events
             WHERE "operationId" = $1::uuid AND kind = 'destination_verified')::bigint
             AS destinations,
           (SELECT count(*)
              FROM storage.objects AS object
              JOIN public.document_archive_quarantine_events AS event
                ON event."operationId" = $1::uuid
               AND event.kind = 'destination_verified'
               AND event.ordinal = $7::smallint
               AND event."objectId" = object.id
               AND event."objectVersion" IS NOT DISTINCT FROM to_jsonb(object)->>'version'
               AND event."objectCreatedAt" = object.created_at
               AND event."objectUpdatedAt" = object.updated_at
               AND event."objectMetadata" = coalesce(to_jsonb(object)->'metadata', 'null'::jsonb)
               AND event."objectUserMetadata" =
                 coalesce(to_jsonb(object)->'user_metadata', 'null'::jsonb)
               AND event."byteSha256" = $9
               AND event."byteSize" = $10::bigint
               AND event."contentType" = $11
             WHERE object.bucket_id = $5 AND object.name = $8)::bigint AS "destinationExact",
           (SELECT count(*) FROM public.document_archive_quarantine_events
             WHERE "operationId" = $1::uuid AND kind = 'copied_verified')::bigint AS copied,
           (SELECT count(*)
              FROM storage.objects AS object
              JOIN public.document_archive_quarantine_events AS event
                ON event."operationId" = $1::uuid
               AND event.kind = 'copied_verified'
               AND event.ordinal = 0
               AND event."objectId" = object.id
               AND event."objectVersion" IS NOT DISTINCT FROM to_jsonb(object)->>'version'
               AND event."objectCreatedAt" = object.created_at
               AND event."objectUpdatedAt" = object.updated_at
               AND event."objectMetadata" = coalesce(to_jsonb(object)->'metadata', 'null'::jsonb)
               AND event."objectUserMetadata" =
                 coalesce(to_jsonb(object)->'user_metadata', 'null'::jsonb)
               AND event."contentType" = 'application/json'
             WHERE object.bucket_id = $5 AND object.name = $12)::bigint AS "copyReceiptExact",
           (SELECT count(*) FROM public.document_archive_quarantine_events
             WHERE "operationId" = $1::uuid AND kind = 'authorized')::bigint AS authorized,
           (SELECT count(*) FROM public.document_archive_quarantine_events
             WHERE "operationId" = $1::uuid AND kind = 'source_deleted')::bigint AS deleted,
           (SELECT count(*) FROM public.document_archive_jobs
             WHERE "leaseToken" IS NOT NULL)::bigint AS "liveArchiveLeases",
           (SELECT count(*) FROM storage.buckets
             WHERE id IN ($4, $5) AND name = id AND public = false
               AND (id <> $5 OR (
                 file_size_limit = $6::bigint
                 AND allowed_mime_types @> ARRAY['application/pdf','application/json']::text[]
                 AND allowed_mime_types <@ ARRAY['application/pdf','application/json']::text[]
               )))::bigint AS "privateBuckets",
           (SELECT count(*)
              FROM expected_fence AS expected
              JOIN pg_catalog.pg_namespace AS namespace
                ON namespace.nspname = expected.schema_name
              JOIN pg_catalog.pg_class AS relation
                ON relation.relnamespace = namespace.oid
               AND relation.relname = expected.relation_name
               AND relation.relkind IN ('r', 'p')
              LEFT JOIN pg_catalog.pg_attribute AS update_attribute
                ON update_attribute.attrelid = relation.oid
               AND update_attribute.attname = expected.update_column
               AND update_attribute.attnum > 0
               AND NOT update_attribute.attisdropped
              JOIN pg_catalog.pg_trigger AS trigger
                ON trigger.tgrelid = relation.oid
               AND trigger.tgname = expected.trigger_name
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
               END)::bigint AS "activeFences",
           (SELECT count(*)
              FROM pg_catalog.pg_trigger AS trigger
             WHERE NOT trigger.tgisinternal
               AND trigger.tgname IN (
                 SELECT expected.trigger_name FROM expected_fence AS expected
               ))::bigint AS "namedFences"`,
        operationId,
        input.manifest.sourceBucket,
        input.entry.sourceKey,
        input.manifest.sourceBucket,
        input.manifest.destinationBucket,
        this.config.maxObjectBytes,
        ordinal,
        input.entry.destinationKey,
        input.entry.sha256,
        input.entry.byteSize,
        input.entry.contentType,
        copyReceiptKey,
      );
      const row = rows[0];
      if (
        rows.length !== 1
        || row?.sourceCount !== 1n
        || row.references !== 0n
        || row.destinations !== 5n
        || row.destinationExact !== 1n
        || row.copied !== 1n
        || row.copyReceiptExact !== 1n
        || row.authorized !== 1n
        || row.deleted !== BigInt(ordinal - 1)
        || row.activeFences !== 8n
        || row.namedFences !== 8n
        || row.liveArchiveLeases !== 0n
        || row.privateBuckets !== 2n
        || !sameJson(
          input.removedSourceKeySha256s,
          input.manifest.entries.slice(0, ordinal - 1)
            .map(({ sourceKeySha256 }) => sourceKeySha256),
        )
      ) {
        throw new Error(
          `ARCHIVE_QUARANTINE_DELETE_FENCE_REFUSED:${input.entry.sourceKeySha256}`,
        );
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 30_000 });
  }

  async assertSourceDeleted(input: {
    manifest: ArchiveQuarantineManifest;
    entry: ArchiveQuarantineManifestEntry;
  }): Promise<void> {
    const operationId = await this.operationId(input.manifest);
    const ordinal = input.manifest.entries.findIndex(
      ({ sourceKeySha256 }) => sourceKeySha256 === input.entry.sourceKeySha256,
    ) + 1;
    const rows = await this.authority.$queryRawUnsafe<Array<{ sources: bigint; events: bigint }>>(
      `SELECT
         (SELECT count(*) FROM storage.objects WHERE bucket_id = $2 AND name = $3)::bigint
           AS sources,
         (SELECT count(*) FROM public.document_archive_quarantine_events
           WHERE "operationId" = $1::uuid AND kind = 'source_deleted'
             AND ordinal = $4::smallint)::bigint AS events`,
      operationId,
      input.manifest.sourceBucket,
      input.entry.sourceKey,
      ordinal,
    );
    if (rows.length !== 1 || rows[0]?.sources !== 0n || rows[0].events !== 1n) {
      throw new Error(`ARCHIVE_QUARANTINE_DELETE_NOT_COMMITTED:${input.entry.sourceKeySha256}`);
    }
  }

  async assertFinalSnapshotClean(manifest: ArchiveQuarantineManifest): Promise<void> {
    const operationId = await this.operationId(manifest);
    const sourceKeys = manifest.entries.map(({ sourceKey }) => sourceKey);
    const destinationKeys = manifest.entries.map(({ destinationKey }) => destinationKey);
    const rows = await this.authority.$queryRawUnsafe<Array<{
      sources: bigint;
      destinations: bigint;
      deleted: bigint;
      references: bigint;
    }>>(
      `SELECT
         (SELECT count(*) FROM storage.objects WHERE bucket_id = $2
           AND name = ANY($4::text[]))::bigint AS sources,
         (SELECT count(*) FROM storage.objects WHERE bucket_id = $3
           AND name = ANY($5::text[]))::bigint AS destinations,
         (SELECT count(*) FROM public.document_archive_quarantine_events
           WHERE "operationId" = $1::uuid AND kind = 'source_deleted')::bigint AS deleted,
         ((SELECT count(*) FROM public.documents WHERE "storageKey" = ANY($4::text[]))
          + (SELECT count(*) FROM public.document_versions WHERE "storageKey" = ANY($4::text[]))
          + (SELECT count(*) FROM public.chantier_photos WHERE "storageKey" = ANY($4::text[]))
          + (SELECT count(*) FROM public.document_archive_artifact_intents
              WHERE "storageKey" = ANY($4::text[]))
          + (SELECT count(*) FROM public.document_archive_job_artifacts
              WHERE "storageKey" = ANY($4::text[])))::bigint AS references`,
      operationId,
      manifest.sourceBucket,
      manifest.destinationBucket,
      sourceKeys,
      destinationKeys,
    );
    const row = rows[0];
    if (
      rows.length !== 1
      || row?.sources !== 0n
      || row.destinations !== 5n
      || row.deleted !== 5n
      || row.references !== 0n
    ) {
      throw new Error('ARCHIVE_QUARANTINE_FINAL_SNAPSHOT_INVALID');
    }
  }

  async recordFinalAuditVerified(input: {
    manifest: ArchiveQuarantineManifest;
    evidence: ArchiveQuarantineFinalAuditEvidence;
  }): Promise<void> {
    const operationId = await this.operationId(input.manifest);
    await this.authority.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
      await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '60s'");
      await transaction.$executeRawUnsafe('LOCK TABLE storage.objects IN SHARE ROW EXCLUSIVE MODE');
      await transaction.$executeRawUnsafe('LOCK TABLE public.documents IN SHARE ROW EXCLUSIVE MODE');
      await transaction.$executeRawUnsafe(
        'LOCK TABLE public.document_versions IN SHARE ROW EXCLUSIVE MODE',
      );
      await transaction.$executeRawUnsafe(
        'LOCK TABLE public.chantier_photos IN SHARE ROW EXCLUSIVE MODE',
      );
      await transaction.$executeRawUnsafe(
        'LOCK TABLE public.document_archive_artifact_intents IN SHARE ROW EXCLUSIVE MODE',
      );
      await transaction.$executeRawUnsafe(
        'LOCK TABLE public.document_archive_job_artifacts IN SHARE ROW EXCLUSIVE MODE',
      );
      const rows = await transaction.$queryRawUnsafe<Array<{
        databaseIdentity: string;
        auditedAt: Date;
        auditCreatedAt: Date;
        counts: unknown;
        privateReport: unknown;
        issueCodes: string[];
        ready: boolean;
        orphanCount: bigint;
        missingCount: bigint;
        deletedVerified: bigint;
        deletedVerifiedAt: Date;
      }>>(
        `WITH referenced_objects AS (
           SELECT "storageKey" FROM public.documents
           UNION ALL SELECT "storageKey" FROM public.document_versions
           UNION ALL SELECT "storageKey" FROM public.chantier_photos
           UNION ALL SELECT "storageKey" FROM public.document_archive_artifact_intents
           UNION ALL SELECT "storageKey" FROM public.document_archive_job_artifacts
         )
         SELECT audit."databaseIdentity"::text AS "databaseIdentity",
                audit."auditedAt", audit."createdAt" AS "auditCreatedAt",
                audit.counts, audit."issueCodes", audit."privateReport",
                audit."readyForActivation" AS ready,
                (SELECT count(*) FROM storage.objects AS object
                  WHERE object.bucket_id = $7
                    AND (object.name LIKE 'companies/%/documents/%'
                      OR object.name LIKE 'companies/%/chantiers/%')
                    AND NOT EXISTS (
                      SELECT 1 FROM referenced_objects AS reference
                       WHERE reference."storageKey" = object.name
                    ))::bigint AS "orphanCount",
                (SELECT count(DISTINCT reference."storageKey")
                   FROM referenced_objects AS reference
                   LEFT JOIN storage.objects AS object
                     ON object.bucket_id = $7 AND object.name = reference."storageKey"
                  WHERE object.id IS NULL)::bigint AS "missingCount",
                (SELECT count(*) FROM public.document_archive_quarantine_events
                  WHERE "operationId" = $1::uuid AND kind = 'deleted_verified')::bigint
                  AS "deletedVerified",
                (SELECT "createdAt" FROM public.document_archive_quarantine_events
                  WHERE "operationId" = $1::uuid AND kind = 'deleted_verified')
                  AS "deletedVerifiedAt"
           FROM public.document_archive_audit_evidence AS audit
          WHERE audit."deploymentId" = $2::uuid
            AND audit."releaseSha" = $3
            AND audit."inventoryDigest" = $4
            AND audit."reportSha256" = $5
            AND audit."databaseIdentity" = (
              SELECT operation."databaseIdentity"
                FROM public.document_archive_quarantine_operations AS operation
               WHERE operation.id = $1::uuid
            )
            AND audit."storageBucket" = $6
            AND audit."protocolVersion" = 2
            AND audit.mode = 'protocol-v2-verified'
          FOR SHARE OF audit`,
        operationId,
        input.evidence.deploymentId,
        input.evidence.releaseSha,
        input.evidence.inventoryDigest,
        input.evidence.reportSha256,
        input.evidence.storageBucket,
        input.manifest.sourceBucket,
      );
      const row = rows[0];
      const counts = typeof row?.counts === 'object'
        && row.counts !== null
        && !Array.isArray(row.counts)
        ? row.counts as Record<string, unknown>
        : null;
      const report = row === undefined ? null : asAuditReport(row.privateReport);
      if (
        rows.length !== 1
        || row === undefined
        || databaseFingerprint(row.databaseIdentity) !== input.evidence.databaseFingerprint
        || row.auditedAt.toISOString() !== input.evidence.auditedAt
        || !(row.auditCreatedAt instanceof Date)
        || !(row.deletedVerifiedAt instanceof Date)
        || row.auditCreatedAt.getTime() < row.auditedAt.getTime()
        || row.auditedAt.getTime() < row.deletedVerifiedAt.getTime()
        || row.ready !== true
        || row.issueCodes.length !== 0
        || report === null
        || report.databaseSnapshotDigest !== input.evidence.databaseSnapshotDigest
        || row.orphanCount !== 0n
        || row.missingCount !== 0n
        || row.deletedVerified !== 1n
        || counts === null
        || counts.storageOrphans !== 0
        || counts.missingStoredObjects !== 0
        || counts.p0Issues !== 0
      ) {
        throw new Error('ARCHIVE_QUARANTINE_FINAL_AUDIT_CHANGED');
      }
      const owner = await this.ownerRole(transaction);
      await this.assumeOwner(transaction, owner);
      const eventEvidence = {
        schemaVersion: 1,
        manifestDigest: input.manifest.confirmationDigest,
        deploymentId: input.evidence.deploymentId,
        inventoryDigest: input.evidence.inventoryDigest,
        reportSha256: input.evidence.reportSha256,
        databaseSnapshotDigest: input.evidence.databaseSnapshotDigest,
        storageOrphans: 0,
        missingStoredObjects: 0,
        p0Issues: 0,
      } as const;
      await transaction.$executeRawUnsafe(
        `INSERT INTO public.document_archive_quarantine_events (
           "operationId", kind, ordinal, evidence, "evidenceSha256",
           "finalAuditDeploymentId", "finalAuditReleaseSha", "finalAuditInventoryDigest",
           "finalAuditReportSha256", "finalAuditStorageBucket", "finalAuditDatabaseIdentity"
         ) VALUES (
           $1::uuid, 'final_audit_verified', 0, $2::jsonb,
           encode(sha256(convert_to($2::jsonb::text, 'UTF8')), 'hex'),
           $3::uuid, $4, $5, $6, $7, $8::uuid
         ) ON CONFLICT ("operationId", kind, ordinal) DO NOTHING`,
        operationId,
        JSON.stringify(eventEvidence),
        input.evidence.deploymentId,
        input.evidence.releaseSha,
        input.evidence.inventoryDigest,
        input.evidence.reportSha256,
        input.evidence.storageBucket,
        row.databaseIdentity,
      );
      const exact = await transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*)::bigint AS count
           FROM public.document_archive_quarantine_events
          WHERE "operationId" = $1::uuid AND kind = 'final_audit_verified' AND ordinal = 0
            AND "finalAuditDeploymentId" = $2::uuid
            AND "finalAuditReleaseSha" = $3
            AND "finalAuditInventoryDigest" = $4
            AND "finalAuditReportSha256" = $5
            AND "finalAuditStorageBucket" = $6
            AND "finalAuditDatabaseIdentity" = $7::uuid`,
        operationId,
        input.evidence.deploymentId,
        input.evidence.releaseSha,
        input.evidence.inventoryDigest,
        input.evidence.reportSha256,
        input.evidence.storageBucket,
        row.databaseIdentity,
      );
      if (exact[0]?.count !== 1n) throw new Error('ARCHIVE_QUARANTINE_EVENT_DIVERGENT');
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 65_000 });
  }

  recordCompleted(input: {
    manifest: ArchiveQuarantineManifest;
    storedBytesSha256: string;
    receipt: ArchiveQuarantineObject;
  }): Promise<void> {
    return this.recordReceiptEvent({
      ...input,
      kind: 'completed',
      receiptKey: `receipts/${input.manifest.confirmationDigest}/completed.json`,
    });
  }
}

/**
 * Lease dédié, conservé pendant les I/O Storage de l'apply/finalizer. Les écritures du journal
 * utilisent une autre connexion afin de rester visibles par les triggers Storage transactionnels.
 */
export async function withArchiveQuarantineMutationLease<T>(
  config: ArchiveQuarantineRuntimeConfig,
  work: () => Promise<T>,
): Promise<T> {
  const lease = new PrismaClient({ datasourceUrl: config.directUrl });
  await lease.$connect();
  try {
    return await lease.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
      await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '0'");
      await transaction.$executeRawUnsafe("SET LOCAL idle_in_transaction_session_timeout = '0'");
      const acquired = await transaction.$queryRawUnsafe<Array<{
        audit: boolean;
        quarantine: boolean;
      }>>(
        `SELECT
           pg_catalog.pg_try_advisory_xact_lock(
             pg_catalog.hashtextextended('bob-document-archive-byte-audit', 0)
           ) AS audit,
           pg_catalog.pg_try_advisory_xact_lock(
             pg_catalog.hashtextextended('bob-document-archive-quarantine', 0)
           ) AS quarantine`,
      );
      if (acquired.length !== 1 || !acquired[0]?.audit || !acquired[0].quarantine) {
        throw new Error('ARCHIVE_QUARANTINE_EXCLUSIVE_LEASE_UNAVAILABLE');
      }
      return work();
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 20 * 60 * 1_000,
    });
  } finally {
    await lease.$disconnect();
  }
}

export async function connectArchiveQuarantineRuntime(
  config: ArchiveQuarantineRuntimeConfig,
): Promise<{
  readonly authority: PrismaClient;
  readonly repository: ArchiveQuarantineRepository;
  readonly storage: SupabaseArchiveQuarantineStorage;
}> {
  const authority = new PrismaClient({ datasourceUrl: config.directUrl });
  await authority.$connect();
  const authorities = await authority.$queryRawUnsafe<Array<{
    superuser: boolean;
    bypassRls: boolean;
    canReadStorage: boolean;
    canReadBuckets: boolean;
  }>>(
    `SELECT role.rolsuper AS superuser, role.rolbypassrls AS "bypassRls",
            pg_catalog.has_table_privilege(current_user, 'storage.objects', 'SELECT')
              AS "canReadStorage",
            pg_catalog.has_table_privilege(current_user, 'storage.buckets', 'SELECT')
              AS "canReadBuckets"
       FROM pg_catalog.pg_roles AS role WHERE role.rolname = current_user`,
  );
  if (
    authorities.length !== 1
    || (!authorities[0]!.superuser && !authorities[0]!.bypassRls)
    || !authorities[0]!.canReadStorage
    || !authorities[0]!.canReadBuckets
  ) {
    await authority.$disconnect();
    throw new Error('ARCHIVE_QUARANTINE_DIRECT_AUTHORITY_INVALID');
  }
  return {
    authority,
    repository: new ArchiveQuarantineRepository(authority, config),
    storage: new SupabaseArchiveQuarantineStorage(authority, config),
  };
}

import { buildArchiveQuarantineManifest } from './documents/archive-quarantine';
import { verifyArchiveQuarantineOidc } from './document-archive-quarantine-oidc';
import {
  connectArchiveQuarantineRuntime,
  FLY_ARCHIVE_QUARANTINE_TARGET,
  parseArchiveQuarantineAuditPin,
  parseArchiveQuarantineRuntimeConfig,
  type ArchiveQuarantineAuditPin,
  type ArchiveQuarantineRuntimeConfig,
} from './document-archive-quarantine.runtime';

export { archiveQuarantineSourceCompanyId } from './document-archive-quarantine.runtime';

export interface ArchiveQuarantinePlanConfig {
  readonly runtime: ArchiveQuarantineRuntimeConfig;
  readonly audit: ArchiveQuarantineAuditPin;
}

export interface ArchiveQuarantinePlanInput {
  readonly schemaVersion: 1;
  readonly oidcToken: string;
}

const MAX_STDIN_BYTES = 24 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_STDIN_BYTES) throw new Error('ARCHIVE_QUARANTINE_PLAN_INPUT_TOO_LARGE');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseArchiveQuarantinePlanInput(value: string): ArchiveQuarantinePlanInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('ARCHIVE_QUARANTINE_PLAN_INPUT_INVALID');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ARCHIVE_QUARANTINE_PLAN_INPUT_INVALID');
  }
  const input = parsed as Record<string, unknown>;
  if (
    Object.keys(input).sort().join('\u0000') !== ['oidcToken', 'schemaVersion'].join('\u0000')
    || input.schemaVersion !== 1
    || typeof input.oidcToken !== 'string'
    || input.oidcToken.length < 100
    || input.oidcToken.length > 16_384
  ) {
    throw new Error('ARCHIVE_QUARANTINE_PLAN_INPUT_INVALID');
  }
  return input as unknown as ArchiveQuarantinePlanInput;
}

export function parseArchiveQuarantinePlanConfig(
  environment: NodeJS.ProcessEnv,
): ArchiveQuarantinePlanConfig {
  const mode = environment.DOCUMENT_ARCHIVE_QUARANTINE_MODE?.trim() || 'plan';
  if (mode !== 'plan') throw new Error('ARCHIVE_QUARANTINE_PLAN_MODE_REQUIRED');
  return {
    runtime: parseArchiveQuarantineRuntimeConfig(environment),
    audit: parseArchiveQuarantineAuditPin(environment),
  };
}

export async function runDocumentArchiveQuarantinePlan(
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const config = parseArchiveQuarantinePlanConfig(environment);
  const input = parseArchiveQuarantinePlanInput(await readStdin());
  const workflowIdentity = await verifyArchiveQuarantineOidc({
    token: input.oidcToken,
    releaseSha: config.runtime.releaseSha,
  });
  const runtime = await connectArchiveQuarantineRuntime(config.runtime);
  try {
    const recovered = await runtime.repository.loadRecoverablePlan({
      releaseSha: config.runtime.releaseSha,
      target: FLY_ARCHIVE_QUARANTINE_TARGET,
      workflowIdentity,
    });
    let manifest = recovered;
    if (manifest === null) {
      await runtime.storage.ensurePrivateDestinationBucket();
      const report = await runtime.repository.loadPinnedAudit(config.audit);
      manifest = await buildArchiveQuarantineManifest({
        report,
        auditDeploymentId: config.audit.deploymentId,
        auditReportSha256: config.audit.reportSha256,
        destinationBucket: config.runtime.destinationBucket,
        target: FLY_ARCHIVE_QUARANTINE_TARGET,
        storage: runtime.storage,
      });
      await runtime.repository.sealPlan(manifest, workflowIdentity);
    }
    process.stdout.write(`BOB_DOCUMENT_ARCHIVE_QUARANTINE_PLAN=${Buffer.from(JSON.stringify({
      schemaVersion: 2,
      environment: 'staging',
      releaseSha: manifest.releaseSha,
      auditDeploymentId: manifest.auditDeploymentId,
      auditInventoryDigest: manifest.sourceAuditInventoryDigest,
      auditReportSha256: manifest.auditReportSha256,
      manifestDigest: manifest.confirmationDigest,
      entryCount: manifest.entries.length,
      companyIdSha256: manifest.companyIdSha256,
    }), 'utf8').toString('base64url')}\n`);
  } finally {
    await runtime.authority.$disconnect();
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

import {
  applyArchiveQuarantine,
  type ArchiveQuarantineAuthorization,
  type ArchiveQuarantineAuthorizationVerifier,
  type ArchiveQuarantineManifest,
} from './documents/archive-quarantine';
import { verifyArchiveQuarantineOidc } from './document-archive-quarantine-oidc';
import {
  connectArchiveQuarantineRuntime,
  parseArchiveQuarantineRuntimeConfig,
  withArchiveQuarantineMutationLease,
} from './document-archive-quarantine.runtime';

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_STDIN_BYTES = 32 * 1024;

export interface ArchiveQuarantineApplyInput {
  readonly schemaVersion: 1;
  readonly manifestDigest: string;
  readonly confirmation: string;
  readonly oidcToken: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_STDIN_BYTES) throw new Error('ARCHIVE_QUARANTINE_APPLY_INPUT_TOO_LARGE');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseArchiveQuarantineApplyInput(value: string): ArchiveQuarantineApplyInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('ARCHIVE_QUARANTINE_APPLY_INPUT_INVALID');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ARCHIVE_QUARANTINE_APPLY_INPUT_INVALID');
  }
  const input = parsed as Record<string, unknown>;
  const exactKeys = [
    'confirmation',
    'manifestDigest',
    'oidcToken',
    'schemaVersion',
  ].sort();
  if (
    Object.keys(input).sort().join('\u0000') !== exactKeys.join('\u0000')
    || input.schemaVersion !== 1
    || typeof input.manifestDigest !== 'string'
    || !SHA256.test(input.manifestDigest)
    || input.confirmation !== `QUARANTINE-STAGING:${input.manifestDigest}`
    || typeof input.oidcToken !== 'string'
    || input.oidcToken.length < 100
    || input.oidcToken.length > 16_384
  ) {
    throw new Error('ARCHIVE_QUARANTINE_APPLY_INPUT_INVALID');
  }
  return input as unknown as ArchiveQuarantineApplyInput;
}

class ExactVerifiedAuthorization implements ArchiveQuarantineAuthorizationVerifier {
  constructor(private readonly expected: ArchiveQuarantineAuthorization) {}

  async assertAuthenticated(
    authorization: ArchiveQuarantineAuthorization,
    manifest: ArchiveQuarantineManifest,
  ): Promise<void> {
    if (
      authorization !== this.expected
      || authorization.manifestDigest !== manifest.confirmationDigest
      || authorization.workflow.sha !== manifest.releaseSha
    ) {
      throw new Error('ARCHIVE_QUARANTINE_OIDC_AUTHORITY_LOST');
    }
  }
}

export async function runDocumentArchiveQuarantineApply(
  environment: NodeJS.ProcessEnv,
  serializedInput: string,
): Promise<void> {
  if (environment.DOCUMENT_ARCHIVE_QUARANTINE_MODE?.trim() !== 'apply') {
    throw new Error('ARCHIVE_QUARANTINE_APPLY_MODE_REQUIRED');
  }
  const config = parseArchiveQuarantineRuntimeConfig(environment);
  const input = parseArchiveQuarantineApplyInput(serializedInput);
  const runtime = await connectArchiveQuarantineRuntime(config);
  try {
    const manifest = await runtime.repository.loadManifest(input.manifestDigest);
    if (manifest.releaseSha !== config.releaseSha) {
      throw new Error('ARCHIVE_QUARANTINE_APPLY_RELEASE_DIVERGENT');
    }
    const workflow = await verifyArchiveQuarantineOidc({
      token: input.oidcToken,
      releaseSha: manifest.releaseSha,
    });
    const receipt = await withArchiveQuarantineMutationLease(config, async () => {
      const nowRows = await runtime.authority.$queryRawUnsafe<Array<{ now: Date }>>(
        'SELECT clock_timestamp() AS now',
      );
      const now = nowRows[0]?.now;
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error('ARCHIVE_QUARANTINE_DATABASE_CLOCK_INVALID');
      }
      const authorization: ArchiveQuarantineAuthorization = Object.freeze({
        schemaVersion: 2,
        environment: 'staging',
        manifestDigest: manifest.confirmationDigest,
        authorizationRecordedAt: now.toISOString(),
        authorizationChannel: 'github-actions:workflow_dispatch',
        workflow,
      });
      return applyArchiveQuarantine({
        manifest,
        confirmation: input.confirmation,
        authorization,
        deletedAt: now.toISOString(),
        storage: runtime.storage,
        guard: runtime.repository,
        authorizationVerifier: new ExactVerifiedAuthorization(authorization),
      });
    });
    process.stdout.write(`BOB_DOCUMENT_ARCHIVE_QUARANTINE_APPLY=${Buffer.from(JSON.stringify({
      schemaVersion: 2,
      environment: 'staging',
      releaseSha: manifest.releaseSha,
      manifestDigest: receipt.manifestDigest,
      phase: receipt.phase,
      sourceCount: receipt.sourceKeySha256s.length,
      receiptSha256: receipt.receiptSha256,
    }), 'utf8').toString('base64url')}\n`);
  } finally {
    await runtime.authority.$disconnect();
  }
}

if (require.main === module) {
  readStdin()
    .then((input) => runDocumentArchiveQuarantineApply(process.env, input))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'ARCHIVE_QUARANTINE_APPLY_FAILED'}\n`,
      );
      process.exitCode = 1;
    });
}

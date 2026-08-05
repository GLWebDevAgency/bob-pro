import {
  assertArchiveQuarantineRuntimeScope,
  finalizeArchiveQuarantine,
  type ArchiveQuarantineFinalAuditEvidence,
  type ArchiveQuarantineManifest,
} from './documents/archive-quarantine';
import {
  connectArchiveQuarantineRuntime,
  FLY_ARCHIVE_QUARANTINE_TARGET,
  parseOptionalArchiveQuarantineAuditPin,
  parseArchiveQuarantineRuntimeConfig,
  type ArchiveQuarantineAuditPin,
  withArchiveQuarantineMutationLease,
} from './document-archive-quarantine.runtime';
import { parseArchiveQuarantineApplyInput } from './document-archive-quarantine-apply.main';
import { verifyArchiveQuarantineOidc } from './document-archive-quarantine-oidc';

const MAX_STDIN_BYTES = 32 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_STDIN_BYTES) throw new Error('ARCHIVE_QUARANTINE_FINALIZE_INPUT_TOO_LARGE');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Chemin de reprise exact : l'ACK durable prime sur le pin externe après un redémarrage. */
export async function loadArchiveQuarantineFinalAuditForResume(input: {
  repository: Pick<
    Awaited<ReturnType<typeof connectArchiveQuarantineRuntime>>['repository'],
    'loadRecordedFinalAudit' | 'loadFinalAudit'
  >;
  manifest: ArchiveQuarantineManifest;
  loadFallbackPin: () => ArchiveQuarantineAuditPin;
}): Promise<ArchiveQuarantineFinalAuditEvidence> {
  const recorded = await input.repository.loadRecordedFinalAudit(input.manifest);
  return recorded ?? input.repository.loadFinalAudit(input.loadFallbackPin(), input.manifest);
}

export async function runDocumentArchiveQuarantineFinalize(
  environment: NodeJS.ProcessEnv,
  serializedInput: string,
): Promise<void> {
  if (environment.DOCUMENT_ARCHIVE_QUARANTINE_MODE?.trim() !== 'finalize') {
    throw new Error('ARCHIVE_QUARANTINE_FINALIZE_MODE_REQUIRED');
  }
  const config = parseArchiveQuarantineRuntimeConfig(environment);
  const input = parseArchiveQuarantineApplyInput(serializedInput);
  const runtime = await connectArchiveQuarantineRuntime(config);
  try {
    const manifest = assertArchiveQuarantineRuntimeScope(
      await runtime.repository.loadManifest(input.manifestDigest),
      {
        releaseSha: config.releaseSha,
        sourceBucket: config.sourceBucket,
        destinationBucket: config.destinationBucket,
        target: FLY_ARCHIVE_QUARANTINE_TARGET,
      },
    );
    await verifyArchiveQuarantineOidc({
      token: input.oidcToken,
      releaseSha: manifest.releaseSha,
    });
    const receipt = await withArchiveQuarantineMutationLease(config, async () => {
      const evidence = await loadArchiveQuarantineFinalAuditForResume({
        repository: runtime.repository,
        manifest,
        loadFallbackPin: () => {
          const pin = parseOptionalArchiveQuarantineAuditPin(environment);
          if (pin === null) {
            throw new Error('ARCHIVE_QUARANTINE_FINAL_AUDIT_NOT_RECORDED');
          }
          return pin;
        },
      });
      const nowRows = await runtime.authority.$queryRawUnsafe<Array<{ now: Date }>>(
        'SELECT clock_timestamp() AS now',
      );
      const now = nowRows[0]?.now;
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new Error('ARCHIVE_QUARANTINE_DATABASE_CLOCK_INVALID');
      }
      return finalizeArchiveQuarantine({
        manifest,
        evidence,
        completedAt: now.toISOString(),
        storage: runtime.storage,
        guard: runtime.repository,
      });
    });
    process.stdout.write(
      `BOB_DOCUMENT_ARCHIVE_QUARANTINE_FINALIZE=${Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          environment: 'staging',
          releaseSha: manifest.releaseSha,
          manifestDigest: receipt.manifestDigest,
          phase: receipt.phase,
          sourceCount: receipt.sourceKeySha256s.length,
          receiptSha256: receipt.receiptSha256,
          finalAuditDeploymentId: receipt.finalAuditDeploymentId,
          finalAuditInventoryDigest: receipt.finalAuditInventoryDigest,
          finalAuditReportSha256: receipt.finalAuditReportSha256,
        }),
        'utf8',
      ).toString('base64url')}\n`,
    );
  } finally {
    await runtime.authority.$disconnect();
  }
}

if (require.main === module) {
  readStdin()
    .then((input) => runDocumentArchiveQuarantineFinalize(process.env, input))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'ARCHIVE_QUARANTINE_FINALIZE_FAILED'}\n`,
      );
      process.exitCode = 1;
    });
}

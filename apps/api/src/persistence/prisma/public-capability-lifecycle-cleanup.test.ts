import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const certificateSource = readFileSync(
  resolve(process.cwd(), 'src/persistence/prisma/public-capability-lifecycle.postgres.test.ts'),
  'utf8',
);
const invoiceCertificateSource = readFileSync(
  resolve(process.cwd(), 'src/persistence/prisma/invoice-issue-lifecycle.postgres.test.ts'),
  'utf8',
);
const prismaServiceSource = readFileSync(
  resolve(process.cwd(), 'src/persistence/prisma/prisma.service.ts'),
  'utf8',
);
const releaseSource = readFileSync(resolve(process.cwd(), 'scripts/release.sh'), 'utf8');
const releaseEnvGateSource = readFileSync(
  resolve(process.cwd(), 'scripts/check-release-env.sh'),
  'utf8',
);
const tenantDirectorySource = readFileSync(
  resolve(process.cwd(), 'src/jobs/tenant-directory.ts'),
  'utf8',
);

describe('Public capability lifecycle — contrat de nettoyage distant', () => {
  it('applique au client admin le timeout transactionnel WAN du rituel', () => {
    expect(releaseSource).toMatch(
      /PRISMA_TRANSACTION_TIMEOUT_MS="\$\{PRISMA_TRANSACTION_TIMEOUT_MS:-30000\}"/u,
    );
    expect(releaseSource).toMatch(/export PRISMA_TRANSACTION_TIMEOUT_MS/u);
    expect(prismaServiceSource).toMatch(/process\.env\.PRISMA_TRANSACTION_TIMEOUT_MS \?\? 0/u);
    expect(prismaServiceSource).toMatch(
      /transactionOptions:\s*\{[\s\S]*timeout: timeoutMs,[\s\S]*maxWait: Math\.min\(timeoutMs, 10_000\)/u,
    );
    expect(certificateSource).toMatch(/let admin!: PrismaService;/u);
    expect(certificateSource).toMatch(
      /admin = new PrismaService\(\{ datasourceUrl: directUrl \}\);/u,
    );
    expect(certificateSource).not.toMatch(
      /admin = new PrismaClient\(\{ datasourceUrl: directUrl \}\);/u,
    );
  });

  it("applique le même contrat WAN au certificat d'émission de facture", () => {
    expect(invoiceCertificateSource).toMatch(/let admin!: PrismaService;/u);
    expect(invoiceCertificateSource).toMatch(
      /admin = new PrismaService\(\{ datasourceUrl: directUrl \}\);/u,
    );
    expect(invoiceCertificateSource).not.toMatch(
      /admin = new PrismaClient\(\{ datasourceUrl: directUrl \}\);/u,
    );
    expect(invoiceCertificateSource).toMatch(
      /const CERT_STALE_RECOVERY_HOOK_TIMEOUT_MS = 120_000;/u,
    );
    expect(invoiceCertificateSource).toMatch(
      /const CERT_CURRENT_RUN_CLEANUP_HOOK_TIMEOUT_MS = 60_000;/u,
    );
    expect(invoiceCertificateSource).toMatch(/\}, CERT_STALE_RECOVERY_HOOK_TIMEOUT_MS\);/u);
    expect(invoiceCertificateSource).toMatch(/\}, CERT_CURRENT_RUN_CLEANUP_HOOK_TIMEOUT_MS\);/u);
    expect(invoiceCertificateSource).not.toMatch(/cleanupFixtures\([^)]*\)\.catch/u);
  });

  it('récupère seulement les fixtures réservées et réutilise la purge stricte en afterAll', () => {
    expect(certificateSource).toMatch(
      /const CERT_ALLOWED_RELEASE_ENVIRONMENTS = new Set\(\['development', 'staging'\]\);/u,
    );
    expect(certificateSource).toMatch(
      /Public lifecycle PostgreSQL certification is restricted to development and staging\./u,
    );
    expect(certificateSource).toMatch(
      /id: \{ startsWith: CERT_COMPANY_ID_PREFIX \},[\s\S]*siren: CERT_SIREN,[\s\S]*name: \{ startsWith: CERT_COMPANY_NAME_PREFIX \}/u,
    );
    expect(certificateSource).toMatch(/SELECT id[\s\S]*FOR UPDATE/u);
    expect(certificateSource).toContain('AND id LIKE ${`${CERT_COMPANY_ID_PREFIX}%`}');
    expect(certificateSource).toContain('AND siren = ${CERT_SIREN}');
    expect(certificateSource).toContain('AND name LIKE ${`${CERT_COMPANY_NAME_PREFIX}%`}');
    expect(certificateSource).toMatch(
      /Public lifecycle certification fixture identity changed before cleanup\./u,
    );
    expect(certificateSource).toMatch(
      /await cleanupFixtures\(staleFixtures\.map\(\(\{ id \}\) => id\)\);/u,
    );
    expect(certificateSource).toMatch(/const CERT_CLEANUP_BATCH_SIZE = 32;/u);
    expect(certificateSource).toMatch(/const CERT_MAX_STALE_FIXTURES = 96;/u);
    expect(certificateSource).toMatch(
      /offset \+= CERT_CLEANUP_BATCH_SIZE[\s\S]*cleanupFixtureBatch\([\s\S]*\.slice\(offset, offset \+ CERT_CLEANUP_BATCH_SIZE\)/u,
    );
    expect(certificateSource).toMatch(/take: CERT_MAX_STALE_FIXTURES \+ 1/u);
    expect(certificateSource).toMatch(/\}, CERT_STALE_RECOVERY_HOOK_TIMEOUT_MS\);/u);
    expect(certificateSource).toMatch(/\}, CERT_CURRENT_RUN_CLEANUP_HOOK_TIMEOUT_MS\);/u);
    expect(certificateSource).toMatch(/if \(admin\) await cleanupFixtures\(companyIds\);/u);
    expect(certificateSource).toMatch(
      /Public lifecycle certification fixture cleanup is incomplete\./u,
    );
    expect(certificateSource).toMatch(/FROM public\.document_archive_jobs[\s\S]*FOR UPDATE/u);
    expect(certificateSource).toMatch(
      /vi\.spyOn\(service, 'runDocumentArchiveJobs'\)\.mockResolvedValue\(\{[\s\S]*scanned: 0,[\s\S]*archived: 0,[\s\S]*failed: 0/u,
    );
    expect(certificateSource).not.toMatch(/parkCertificationArchiveJobs/u);
    expect(certificateSource).not.toMatch(/documentArchiveJob\.updateMany/u);
    expect(certificateSource).not.toMatch(/CERT_ARCHIVE_PARKED_UNTIL/u);
    expect(certificateSource).toMatch(
      /job\.pieceId !== identity\.quoteId[\s\S]*job\.reason !== 'quote-signed'[\s\S]*job\.hasTerminalProof/u,
    );
    expect(certificateSource).toMatch(
      /CertificationArchiveLeaseActiveError[\s\S]*archive lease did not quiesce before cleanup/u,
    );
    expect(certificateSource).toMatch(
      /openDocumentArchiveRenderSnapshot[\s\S]*generatedQuoteDocumentId[\s\S]*generatedQuoteDocumentVersionId/u,
    );
    expect(certificateSource).toMatch(
      /Public lifecycle certification archive intent identity is unsafe\./u,
    );
    expect(certificateSource).toMatch(/FROM storage\.objects[\s\S]*storageObjectCount !== 0/u);
    expect(certificateSource).toMatch(
      /archiveArtifacts !== 0[\s\S]*materializedDocuments !== 0[\s\S]*materializedVersions !== 0[\s\S]*materializedAttestations !== 0/u,
    );
    expect(certificateSource).toMatch(
      /session_replication_role = 'replica'[\s\S]*documentArchiveArtifactIntent\.deleteMany[\s\S]*documentArchiveRenderSnapshot\.deleteMany[\s\S]*session_replication_role = 'origin'[\s\S]*documentArchiveJob\.deleteMany/u,
    );
    expect(certificateSource).toMatch(
      /deletedArchiveIntents\.count !== archiveIntents\.length[\s\S]*deletedArchiveSnapshots\.count !== archiveSnapshots\.length/u,
    );
    expect(certificateSource).not.toMatch(/tx\.documentArchiveJobArtifact\.deleteMany/u);
    expect(certificateSource).not.toMatch(/tx\.storedDocument\.deleteMany/u);
    expect(certificateSource).not.toMatch(/DELETE FROM storage\.objects/u);
    expect(certificateSource).not.toMatch(/cleanupFixtures\([^)]*\)\.catch/u);
  });

  it('borne le scheduler staging à une allowlist explicite avant de créer les fixtures', () => {
    expect(releaseEnvGateSource).toMatch(/const required = \[[\s\S]*'JOB_COMPANY_IDS',[\s\S]*\];/u);
    expect(tenantDirectorySource).toMatch(
      /const configured = jobCompanyIds\(\);[\s\S]*if \(configured\.length > 0\) return configured;[\s\S]*companies\.list\(\)/u,
    );
    expect(certificateSource).toMatch(
      /process\.env\.CABINET_RELEASE_ENV === 'staging'[\s\S]*jobCompanyIds\(\)\.length === 0[\s\S]*Public lifecycle staging certification requires a non-empty JOB_COMPANY_IDS allowlist\./u,
    );
    expect(certificateSource).toMatch(
      /toHaveBeenCalledWith\(\{ companyId: fixture\.companyId, limit: 5 \}\)[\s\S]*assertPendingSignedQuoteArchive\(fixture\)/u,
    );
  });
});

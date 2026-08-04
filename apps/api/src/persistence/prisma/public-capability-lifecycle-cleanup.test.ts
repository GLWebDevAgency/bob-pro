import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const certificateSource = readFileSync(
  resolve(process.cwd(), 'src/persistence/prisma/public-capability-lifecycle.postgres.test.ts'),
  'utf8',
);
const releaseSource = readFileSync(resolve(process.cwd(), 'scripts/release.sh'), 'utf8');

describe('Public capability lifecycle — contrat de nettoyage distant', () => {
  it('applique au client admin le timeout transactionnel WAN du rituel', () => {
    expect(releaseSource).toMatch(
      /PRISMA_TRANSACTION_TIMEOUT_MS="\$\{PRISMA_TRANSACTION_TIMEOUT_MS:-30000\}"/u,
    );
    expect(releaseSource).toMatch(/export PRISMA_TRANSACTION_TIMEOUT_MS/u);
    expect(certificateSource).toMatch(/let admin!: PrismaService;/u);
    expect(certificateSource).toMatch(
      /admin = new PrismaService\(\{ datasourceUrl: directUrl \}\);/u,
    );
    expect(certificateSource).not.toMatch(
      /admin = new PrismaClient\(\{ datasourceUrl: directUrl \}\);/u,
    );
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
    expect(certificateSource).toMatch(
      /Public lifecycle certification fixture unexpectedly owns immutable archive data\./u,
    );
    expect(certificateSource).not.toMatch(
      /tx\.documentArchive(?:ArtifactIntent|RenderSnapshot|JobArtifact|Job)\.deleteMany/u,
    );
    expect(certificateSource).not.toMatch(/cleanupFixtures\([^)]*\)\.catch/u);
  });
});

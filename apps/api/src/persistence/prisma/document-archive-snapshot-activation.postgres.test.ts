import { execFile } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaDocumentArchiveJobRepository } from './repositories';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT =
  process.env.RUN_POSTGRES_DOCUMENT_ARCHIVE_SNAPSHOT_ACTIVATION_CERT === 'true';
const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = resolve(__dirname, '../../../../../');

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

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Archive snapshot V2 — refus comportementaux du cutover',
  () => {
    const suffix = randomUUID();
    const companyId = `archive-snapshot-activation-company-${suffix}`;
    const customerId = `archive-snapshot-activation-customer-${suffix}`;
    const quoteId = `archive-snapshot-activation-quote-${suffix}`;
    const jobId = `archive-snapshot-activation-job-${suffix}`;
    const releaseSha = 'f'.repeat(40);
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    let admin: PrismaClient;
    let runtime: PrismaService;
    let repository: PrismaDocumentArchiveJobRepository;
    let runtimeRole: string;

    async function activationFailure(
      sha: string,
    ): Promise<{ stdout: string; stderr: string }> {
      try {
        await execFileAsync(
          'sh',
          ['apps/api/scripts/activate-document-archive-snapshot-v2.sh'],
          {
            cwd: REPOSITORY_ROOT,
            env: {
              ...process.env,
              DIRECT_URL: directUrl,
              APP_DATABASE_ROLE: runtimeRole,
              DOCUMENT_ARCHIVE_SNAPSHOT_V2_ACTIVATION_RELEASE_SHA: sha,
            },
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
          },
        );
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string };
        return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
      }
      throw new Error('Snapshot activation unexpectedly succeeded during a refusal probe.');
    }

    beforeAll(async () => {
      if (!runtimeUrl || !directUrl) {
        throw new Error('DATABASE_URL (runtime) et DIRECT_URL (admin) sont requis.');
      }
      admin = new PrismaClient({ datasourceUrl: directUrl, errorFormat: 'minimal' });
      runtime = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
      repository = new PrismaDocumentArchiveJobRepository(runtime);
      await Promise.all([admin.$connect(), runtime.$connect()]);
      const [runtimeIdentity] = await runtime.$queryRaw<Array<{ roleName: string }>>`
        SELECT current_user AS "roleName"
      `;
      if (!runtimeIdentity?.roleName) throw new Error('Runtime role is unavailable.');
      runtimeRole = runtimeIdentity.roleName;

      const siren = appendLuhnDigit(String(randomInt(10_000_000, 100_000_000)));
      await admin.company.create({
        data: {
          id: companyId,
          name: 'Archive Snapshot Activation',
          legalForm: 'EI',
          siren,
          siret: appendLuhnDigit(`${siren}${String(randomInt(0, 10_000)).padStart(4, '0')}`),
          trade: 'autre',
          vatRegime: 'reel_normal',
          addrLine1: '1 rue du Cutover',
          addrZip: '75001',
          addrCity: 'Paris',
        },
      });
      await admin.customer.create({
        data: {
          id: customerId,
          companyId,
          type: 'b2b',
          name: 'Client Cutover',
          addrLine1: '2 rue du Cutover',
          addrZip: '75002',
          addrCity: 'Paris',
        },
      });
      await admin.quote.create({
        data: {
          id: quoteId,
          companyId,
          customerId,
          status: 'signed',
          number: `D-CUTOVER-${suffix.slice(0, 8)}`,
          issuedAt: new Date('2026-08-04T00:00:00.000Z'),
          signerName: 'Client Cutover',
          signedAt: new Date('2026-08-04T12:00:00.000Z'),
          signatureCustomerType: 'b2b',
        },
      });
      await expect(admin.documentArchiveProtocolState.findUniqueOrThrow({ where: { id: 1 } }))
        .resolves.toMatchObject({ activeVersion: 2 });
      await expect(
        admin.documentArchiveSnapshotProtocolState.findUniqueOrThrow({ where: { id: 1 } }),
      ).resolves.toMatchObject({ activeVersion: 1 });
    }, 30_000);

    afterAll(async () => {
      try {
        if (admin) {
          await admin.documentArchiveJob.deleteMany({ where: { companyId } });
          await admin.quote.deleteMany({ where: { companyId } });
          await admin.customer.deleteMany({ where: { companyId } });
          await admin.company.deleteMany({ where: { id: companyId } });
        }
      } finally {
        await Promise.allSettled([
          ...(runtime ? [runtime.$disconnect()] : []),
          ...(admin ? [admin.$disconnect()] : []),
        ]);
      }
    });

    it('refuse un SHA non canonique avant toute mutation', async () => {
      const failure = await activationFailure('F'.repeat(40));
      expect(`${failure.stdout}\n${failure.stderr}`).toMatch(/lowercase hexadecimal/u);
      await expect(
        admin.documentArchiveSnapshotProtocolState.findUniqueOrThrow({ where: { id: 1 } }),
      ).resolves.toMatchObject({ activeVersion: 1, activatedAt: null });
    });

    it('refuse successivement un lease N-1 actif puis un job N-1 incomplet', async () => {
      await runtime.withTenant(companyId, async () => repository.enqueue({
        id: jobId,
        companyId,
        pieceId: quoteId,
        reason: 'quote-signed',
        now: new Date().toISOString(),
      }));
      const [candidate] = await runtime.withTenant(
        companyId,
        async () => repository.listDue(companyId, new Date().toISOString(), 10),
      );
      expect(candidate?.id).toBe(jobId);
      const now = new Date();
      const leaseToken = `activation-lease-${suffix}`;
      await expect(runtime.withTenant(companyId, async () => repository.claimForArchive(
        jobId,
        companyId,
        candidate!.updatedAt,
        now.toISOString(),
        new Date(now.getTime() + 60_000).toISOString(),
        leaseToken,
      ))).resolves.toMatchObject({ outcome: 'claimed' });

      const activeLeaseFailure = await activationFailure(releaseSha);
      expect(`${activeLeaseFailure.stdout}\n${activeLeaseFailure.stderr}`)
        .toMatch(/an active N-1 document archive lease still exists/u);
      await expect(runtime.withTenant(companyId, async () => repository.markFailed(
        jobId,
        companyId,
        leaseToken,
        now.toISOString(),
        new Date(now.getTime() + 1_000).toISOString(),
        'activation-cert-release-lease',
      ))).resolves.toBe(true);

      const incompleteFailure = await activationFailure(releaseSha);
      expect(`${incompleteFailure.stdout}\n${incompleteFailure.stderr}`)
        .toMatch(/an incomplete N-1 document archive job has no sealed snapshot/u);
      await admin.documentArchiveJob.deleteMany({ where: { id: jobId, companyId } });
      await expect(
        admin.documentArchiveSnapshotProtocolState.findUniqueOrThrow({ where: { id: 1 } }),
      ).resolves.toMatchObject({ activeVersion: 1, activatedAt: null });
    }, 60_000);
  },
);

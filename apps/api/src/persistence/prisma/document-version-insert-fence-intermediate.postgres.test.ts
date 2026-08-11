import { randomInt, randomUUID } from 'node:crypto';
import { Document } from '@bob/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaDocumentRepository } from './repositories';
import { PrismaService } from './prisma.service';

const RUN_CERT =
  process.env.RUN_POSTGRES_DOCUMENT_VERSION_INSERT_FENCE_INTERMEDIATE_CERT === 'true';

function appendLuhnDigit(prefix: string): string {
  for (let digit = 0; digit <= 9; digit += 1) {
    const candidate = `${prefix}${digit}`;
    const sum = [...candidate].reverse().reduce((total, character, index) => {
      let value = Number(character);
      if (index % 2 === 1) {
        value *= 2;
        if (value > 9) value -= 9;
      }
      return total + value;
    }, 0);
    if (sum % 10 === 0) return candidate;
  }
  throw new Error('Cannot generate a Luhn-valid identifier.');
}

class ExpectedRollback extends Error {}

describe.skipIf(!RUN_CERT)('Document version insert fence — état intermédiaire N-1', () => {
  const companyId = `version-fence-intermediate-${randomUUID()}`;
  let admin: PrismaService;
  let runtime: PrismaService;

  beforeAll(async () => {
    const directUrl = process.env.DIRECT_URL;
    const runtimeUrl = process.env.DATABASE_URL;
    if (!directUrl || !runtimeUrl) {
      throw new Error('DIRECT_URL and DATABASE_URL are required.');
    }
    if (
      process.env.CABINET_RELEASE_ENV !== 'development' ||
      process.env.DOCUMENT_VERSION_INSERT_FENCE_INTERMEDIATE_CERT_DATABASE_KIND !== 'ephemeral'
    ) {
      throw new Error('Intermediate document version certificate requires ephemeral development.');
    }
    admin = new PrismaService({ datasourceUrl: directUrl, errorFormat: 'minimal' });
    runtime = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
    await Promise.all([admin.$connect(), runtime.$connect()]);
  });

  afterAll(async () => {
    if (admin) {
      await admin.company.deleteMany({ where: { id: companyId } });
    }
    await Promise.all([admin?.$disconnect(), runtime?.$disconnect()]);
  });

  it('rejoue le repository N-1 exact avant toute reconstruction ACL de release', async () => {
    const [runtimeIdentity] = await runtime.$queryRaw<Array<{ roleName: string }>>`
      SELECT current_user AS "roleName"
    `;
    if (!runtimeIdentity?.roleName) throw new Error('Runtime role is unavailable.');

    const [contract] = await admin.$queryRaw<
      Array<{
        archiveVersion: number;
        policyExact: boolean;
        runtimeAclExact: boolean;
      }>
    >`
      SELECT protocol."activeVersion" AS "archiveVersion",
             (
               SELECT count(*) = 1
                  AND bool_and(
                    policy.polname = 'tenant_document_version_insert'
                    AND policy.polpermissive
                    AND policy.polroles = ARRAY[0::oid]
                    AND pg_get_expr(policy.polwithcheck, policy.polrelid) =
                      'document_version_parent_belongs_to_current_tenant_v1("documentId")'
                  )
                 FROM pg_policy AS policy
                WHERE policy.polrelid = 'document_versions'::regclass
                  AND policy.polcmd = 'a'
             ) AS "policyExact",
             (
               SELECT count(*) = 1
                  AND bool_and(
                    grantee.rolname = ${runtimeIdentity.roleName}
                    AND privilege.privilege_type = 'EXECUTE'
                    AND NOT privilege.is_grantable
                  )
                 FROM pg_proc AS function
                CROSS JOIN LATERAL aclexplode(
                  coalesce(function.proacl, acldefault('f', function.proowner))
                ) AS privilege
                 JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
                WHERE function.oid =
                  'document_version_parent_belongs_to_current_tenant_v1(text)'::regprocedure
                  AND privilege.grantee <> function.proowner
             ) AS "runtimeAclExact"
        FROM document_archive_protocol_state AS protocol
       WHERE protocol.id = 1
    `;
    expect(contract).toEqual({ archiveVersion: 1, policyExact: true, runtimeAclExact: true });

    const siren = appendLuhnDigit(String(randomInt(10_000_000, 100_000_000)));
    const siret = appendLuhnDigit(`${siren}${String(randomInt(0, 10_000)).padStart(4, '0')}`);
    await admin.company.create({
      data: {
        id: companyId,
        name: 'Certification writer N-1 intermédiaire',
        legalForm: 'EI',
        siren,
        siret,
        trade: 'certification',
        vatRegime: 'reel_normal',
        addrLine1: '1 rue de la Certification',
        addrZip: '75001',
        addrCity: 'Paris',
      },
    });
    const documentId = `version-fence-document-${randomUUID()}`;
    const sha256 = '7'.repeat(64);
    const storageKey = `companies/${companyId}/documents/${documentId}/v1/${sha256}`;
    const recorded = Document.record({
      id: documentId,
      companyId,
      // Archive Protocol V1 interdit intentionnellement tout original légal généré pendant le
      // cutover. Le writer N-1 réellement autorisé à cet état est donc l'import coffre ; le cas
      // facture/PDF/version/attestation est certifié séparément après activation V2.
      kind: 'other',
      origin: 'uploaded',
      status: 'active',
      filename: 'preuve-writer-n1.pdf',
      mimeType: 'application/pdf',
      byteSize: 42,
      sha256,
      storageKey,
      linkedEntityType: null,
      linkedEntityId: null,
      documentDate: '2026-08-10',
      issuedAt: null,
      createdAt: '2026-08-10T12:00:00.000Z',
      createdBy: null,
      retentionUntil: '2036-08-10',
      deletedAt: null,
      tags: [],
      versions: [{
        id: `${documentId}-v1`,
        documentId,
        version: 1,
        storageKey,
        sha256,
        mimeType: 'application/pdf',
        byteSize: 42,
        createdAt: '2026-08-10T12:00:00.000Z',
        reason: 'initial-upload',
      }],
    });
    if (!recorded.ok) throw new Error(recorded.error.code);
    const repository = new PrismaDocumentRepository(runtime);

    await expect(
      runtime.withTenant(companyId, async (tx) => {
        const result = await repository.insertInitialOrConfirmExact(recorded.value);
        expect(result.status).toBe('inserted');
        await expect(tx.storedDocument.count({ where: { id: documentId } })).resolves.toBe(1);
        await expect(
          tx.storedDocumentVersion.count({ where: { documentId } }),
        ).resolves.toBe(1);
        throw new ExpectedRollback('ROLLBACK_INTERMEDIATE_CERT_FIXTURE');
      }),
    ).rejects.toThrow(ExpectedRollback);

    await expect(admin.storedDocument.count({ where: { id: documentId } })).resolves.toBe(0);
    await expect(
      admin.storedDocumentVersion.count({ where: { documentId } }),
    ).resolves.toBe(0);
  });
});

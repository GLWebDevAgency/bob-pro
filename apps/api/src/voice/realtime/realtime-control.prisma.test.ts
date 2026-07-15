import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import type {
  RealtimeControlGrantConsumeInput,
  RealtimeControlGrantIssueInput,
  RealtimeControlGrantReadInput,
} from './realtime-control.repository';
import { PrismaRealtimeControlRepository } from './realtime-control.prisma';

const COMPANY = 'company-1';
const SUBJECT = 'a'.repeat(64);
const SESSION = '11111111-1111-4111-8111-111111111111';
const TURN = '22222222-2222-4222-8222-222222222222';
const ARTIFACT = '33333333-3333-4333-8333-333333333333';
const GRANT = '44444444-4444-4444-8444-444444444444';
const ACK = '55555555-5555-4555-8555-555555555555';
const DIGEST = 'b'.repeat(64);
const OWNER = 'c'.repeat(64);
const PAYLOAD_HMAC = 'd'.repeat(64);
const NOW = new Date('2026-07-14T10:00:00.000Z');

function issueInput(overrides: Partial<RealtimeControlGrantIssueInput> = {}): RealtimeControlGrantIssueInput {
  return {
    grantId: GRANT,
    companyId: COMPANY,
    subjectHash: SUBJECT,
    sessionId: SESSION,
    turnId: TURN,
    artifactId: ARTIFACT,
    contextRevision: 7,
    contextDigest: DIGEST,
    sidebandOwnerEpoch: 2,
    sidebandOwnerTokenHash: OWNER,
    controlKind: 'navigate',
    sealedControl: new Uint8Array([1, 2, 3]),
    controlNonce: new Uint8Array(12).fill(4),
    controlTag: new Uint8Array(16).fill(5),
    controlPayloadHmac: PAYLOAD_HMAC,
    encryptionKeyVersion: 3,
    proofKeyVersion: 4,
    maxTtlSeconds: 120,
    proposalExpiresAt: null,
    ...overrides,
  };
}

function readInput(overrides: Partial<RealtimeControlGrantReadInput> = {}): RealtimeControlGrantReadInput {
  return {
    companyId: COMPANY,
    subjectHash: SUBJECT,
    sessionId: SESSION,
    turnId: TURN,
    acknowledgementId: ACK,
    contextRevision: 7,
    contextDigest: DIGEST,
    ...overrides,
  };
}

function consumeInput(overrides: Partial<RealtimeControlGrantConsumeInput> = {}): RealtimeControlGrantConsumeInput {
  return {
    ...readInput(),
    grantId: GRANT,
    artifactId: ARTIFACT,
    sidebandOwnerEpoch: 2,
    sidebandOwnerTokenHash: OWNER,
    controlPayloadHmac: PAYLOAD_HMAC,
    ...overrides,
  };
}

function existingGrant() {
  return {
    id: GRANT,
    artifactId: ARTIFACT,
    contextRevision: 7,
    contextDigest: DIGEST,
    controlKind: 'navigate',
    controlPayloadHmac: PAYLOAD_HMAC,
    encryptionKeyVersion: 3,
    proofKeyVersion: 4,
  };
}

function consumableRow(overrides: Record<string, unknown> = {}) {
  return {
    ...existingGrant(),
    companyId: COMPANY,
    subjectHash: SUBJECT,
    sessionId: SESSION,
    turnId: TURN,
    sidebandOwnerEpoch: 2,
    sidebandOwnerTokenHash: OWNER,
    sealedControl: Buffer.from([1, 2, 3]),
    controlNonce: Buffer.alloc(12, 4),
    controlTag: Buffer.alloc(16, 5),
    acknowledgementId: ACK,
    existingAcknowledgementId: null,
    databaseNow: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
    fenceCurrent: true,
    ...overrides,
  };
}

function artifactRow(overrides: Record<string, unknown> = {}) {
  return {
    subjectHash: SUBJECT,
    state: 'delivered',
    deliveryId: ACK,
    contextRevision: 7,
    contextDigest: DIGEST,
    sidebandOwnerEpoch: 2,
    sidebandOwnerTokenHash: OWNER,
    ...overrides,
  };
}

function leaseRow(overrides: Record<string, unknown> = {}) {
  return {
    state: 'active',
    providerId: 'mistral',
    providerCallId: 'mistral_session_1',
    contextRevision: 7,
    contextDigest: DIGEST,
    contextAppliedRevision: 7,
    contextAppliedDigest: DIGEST,
    contextAppliedOwnerEpoch: 2,
    sidebandOwnerEpoch: 2,
    sidebandOwnerTokenHash: OWNER,
    live: true,
    ...overrides,
  };
}

function lockedGrant(overrides: Record<string, unknown> = {}) {
  return {
    ...existingGrant(),
    companyId: COMPANY,
    sessionId: SESSION,
    turnId: TURN,
    expiresAt: new Date(NOW.getTime() + 60_000),
    databaseNow: NOW,
    ...overrides,
  };
}

function ticketRow(overrides: Record<string, unknown> = {}) {
  return {
    state: 'completed',
    subjectHash: SUBJECT,
    providerSessionId: 'mistral_session_1',
    providerTermination: 'confirmed',
    contextRevision: 7,
    contextDigest: DIGEST,
    ...overrides,
  };
}

function harness(queryResults: readonly unknown[], executeResults: readonly unknown[] = []) {
  const queries = [...queryResults];
  const executions = [...executeResults];
  const queryRaw = vi.fn(async () => {
    if (queries.length === 0) throw new Error('Unexpected SQL query.');
    const next = queries.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const executeRaw = vi.fn(async () => {
    if (executions.length === 0) throw new Error('Unexpected SQL mutation.');
    const next = executions.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw } as unknown as Prisma.TransactionClient;
  const withTenant = vi.fn(async (
    _companyId: string,
    operation: (client: Prisma.TransactionClient) => Promise<unknown>,
  ) => operation(tx));
  return {
    value: new PrismaRealtimeControlRepository({ withTenant } as unknown as PrismaService),
    queryRaw,
    executeRaw,
    withTenant,
  };
}

function sqlAt(mock: ReturnType<typeof vi.fn>, index: number): string {
  const strings = mock.mock.calls[index]?.[0] as readonly string[] | undefined;
  return strings?.join('?').replace(/\s+/gu, ' ').trim() ?? '';
}

describe('PrismaRealtimeControlRepository', () => {
  it('scelle sur READY avec une TTL bornée par tous les baux', async () => {
    const h = harness([[{ id: GRANT }]]);
    await expect(h.value.issue(issueInput())).resolves.toEqual({ status: 'issued', grantId: GRANT });
    expect(h.withTenant).toHaveBeenCalledWith(COMPANY, expect.any(Function));
    const sql = sqlAt(h.queryRaw, 0);
    expect(sql).toContain("artifact.state = 'ready'");
    expect(sql).toContain('lease."leaseExpiresAt"');
    expect(sql).toContain('lease."hardExpiresAt"');
    expect(sql).toContain('lease."sidebandOwnerLeaseExpiresAt"');
    expect(sql).toContain('ON CONFLICT ("companyId", "sessionId", "turnId") DO NOTHING');
    expect(sql).not.toContain(COMPANY);
  });

  it('reconnaît un seal concurrent identique par son HMAC stable', async () => {
    const h = harness([[], [existingGrant()]]);
    await expect(h.value.issue(issueInput())).resolves.toEqual({
      status: 'already_issued',
      grantId: GRANT,
    });
  });

  it('refuse une collision de turn dont le payload diffère', async () => {
    const h = harness([[], [{ ...existingGrant(), controlPayloadHmac: 'e'.repeat(64) }]]);
    await expect(h.value.issue(issueInput())).resolves.toEqual({ status: 'conflict' });
  });

  it('ne rend le grant lisible qu’après deliveryId exact et fence live', async () => {
    const h = harness([[consumableRow()]]);
    const result = await h.value.readConsumable(readInput());
    expect(result).toMatchObject({
      status: 'eligible',
      grant: {
        grantId: GRANT,
        acknowledgementId: ACK,
        artifactId: ARTIFACT,
        subjectHash: SUBJECT,
        sidebandOwnerTokenHash: OWNER,
      },
    });
    expect(sqlAt(h.queryRaw, 0)).toContain("artifact.state = 'delivered'");
    expect(sqlAt(h.queryRaw, 0)).toContain('artifact."deliveryId" =');
  });

  it('autorise seulement le retry du même ACK après libération du lease', async () => {
    const same = harness([[consumableRow({
      fenceCurrent: false,
      existingAcknowledgementId: ACK,
    })]]);
    await expect(same.value.readConsumable(readInput())).resolves.toMatchObject({ status: 'eligible' });

    const neverConsumed = harness([[consumableRow({ fenceCurrent: false })]]);
    await expect(neverConsumed.value.readConsumable(readInput()))
      .resolves.toEqual({ status: 'not_found' });
  });

  it('consomme par CAS et libère le drain Mistral confirmé dans la même transaction', async () => {
    const h = harness([
      [ticketRow()],
      [artifactRow()],
      [leaseRow()],
      [lockedGrant()],
      [],
    ], [1, 1]);
    await expect(h.value.consume(consumeInput())).resolves.toEqual({
      status: 'consumed',
      idempotent: false,
    });
    expect(h.executeRaw).toHaveBeenCalledTimes(2);
    expect(sqlAt(h.executeRaw, 0)).toContain('INSERT INTO realtime_control_consumptions');
    const release = sqlAt(h.executeRaw, 1);
    expect(release).toContain('DELETE FROM realtime_session_leases AS lease');
    expect(release).toContain("pending.state IN ('rendering', 'ready')");
    expect(release).toContain('realtime_control_consumptions AS consumed');
  });

  it('rend un retry idempotent sans réexécuter la libération', async () => {
    const h = harness([
      [],
      [artifactRow()],
      [],
      [lockedGrant()],
      [{ acknowledgementId: ACK }],
    ]);
    await expect(h.value.consume(consumeInput())).resolves.toEqual({
      status: 'consumed',
      idempotent: true,
    });
    expect(h.executeRaw).not.toHaveBeenCalled();
  });

  it('échoue fermé si owner, contexte ou deliveryId dérive', async () => {
    const h = harness([
      [],
      [artifactRow({ deliveryId: '99999999-9999-4999-8999-999999999999' })],
      [leaseRow()],
      [lockedGrant()],
    ]);
    await expect(h.value.consume(consumeInput())).resolves.toEqual({ status: 'not_found' });
    expect(h.executeRaw).not.toHaveBeenCalled();
  });

  it('rejette une entrée hostile avant toute transaction tenant', async () => {
    const h = harness([]);
    await expect(h.value.issue(issueInput({ subjectHash: 'raw-subject' })))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(h.value.consume(consumeInput({ acknowledgementId: 'not-a-uuid' })))
      .resolves.toEqual({ status: 'not_found' });
    expect(h.withTenant).not.toHaveBeenCalled();
  });
});

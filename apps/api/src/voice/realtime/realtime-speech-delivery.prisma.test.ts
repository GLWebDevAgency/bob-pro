import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import type { RealtimeSpeechDeliveryMutationInput } from './realtime-speech-delivery.repository';
import { PrismaRealtimeSpeechDeliveryRepository } from './realtime-speech-delivery.prisma';

const COMPANY = 'company-1';
const SUBJECT = 'a'.repeat(64);
const SESSION = '11111111-1111-4111-8111-111111111111';
const TURN = '22222222-2222-4222-8222-222222222222';
const ARTIFACT = '33333333-3333-4333-8333-333333333333';
const DELIVERY = '44444444-4444-4444-8444-444444444444';
const CONTEXT = 'b'.repeat(64);
const OWNER = 'c'.repeat(64);
const EVIDENCE = 'd'.repeat(64);
const AUDIO = 'e'.repeat(64);
const STORAGE = `companies/${COMPANY}/bob-live/${SESSION}/${TURN}/${ARTIFACT}`;

function input(): RealtimeSpeechDeliveryMutationInput {
  return {
    companyId: COMPANY,
    subjectHash: SUBJECT,
    sessionId: SESSION,
    turnId: TURN,
    artifactId: ARTIFACT,
    version: 2,
    evidenceHmac: EVIDENCE,
    audioSha256: AUDIO,
    storageKey: STORAGE,
    deliveryId: DELIVERY,
  };
}

function lockedArtifact(state: 'ready' | 'delivered' = 'ready') {
  return {
    state,
    contextRevision: 7,
    contextDigest: CONTEXT,
    sidebandOwnerEpoch: 3,
    sidebandOwnerTokenHash: OWNER,
    storageKey: STORAGE,
    storageExpiresAt: new Date('2026-07-14T10:10:00.000Z'),
    objectPurgedAt: null,
    evidenceHmac: EVIDENCE,
    audioSha256: AUDIO,
    deliveryId: state === 'delivered' ? DELIVERY : null,
    cancellationId: null,
    cancellationReasonCode: null,
    version: 2,
  };
}

function harness(queryResults: readonly unknown[]) {
  const queries = [...queryResults];
  const queryRaw = vi.fn(async () => {
    if (queries.length === 0) throw new Error('Unexpected SQL query.');
    const next = queries.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  const executeRaw = vi.fn(async () => {
    throw new Error('Unexpected SQL mutation.');
  });
  const tx = { $queryRaw: queryRaw, $executeRaw: executeRaw } as unknown as Prisma.TransactionClient;
  const withTenant = vi.fn(async (
    _companyId: string,
    operation: (client: Prisma.TransactionClient) => Promise<unknown>,
  ) => operation(tx));
  return {
    value: new PrismaRealtimeSpeechDeliveryRepository({ withTenant } as unknown as PrismaService),
    queryRaw,
    executeRaw,
    withTenant,
  };
}

function sqlAt(mock: ReturnType<typeof vi.fn>, index: number): string {
  const strings = mock.mock.calls[index]?.[0] as readonly string[] | undefined;
  return strings?.join('?').replace(/\s+/gu, ' ').trim() ?? '';
}

describe('PrismaRealtimeSpeechDeliveryRepository — référence de contrôle durable', () => {
  it('publie uniquement le grant vivant exact, non consommé et lié au fence complet', async () => {
    const h = harness([
      [],
      [lockedArtifact()],
      [{ ok: true }],
      [{ contextRevision: 7, contextDigest: CONTEXT }],
      [{ ok: true }],
    ]);

    await expect(h.value.acknowledgeDelivery(input())).resolves.toEqual({
      status: 'delivered',
      idempotent: false,
      controlCurrent: true,
      contextRevision: 7,
      contextDigest: CONTEXT,
    });

    const sql = sqlAt(h.queryRaw, 4);
    expect(sql).toContain('FROM realtime_control_grants AS control_grant');
    expect(sql).toContain('exact_artifact."companyId" = control_grant."companyId"');
    expect(sql).toContain('exact_artifact."subjectHash" =');
    expect(sql).toContain('control_grant."sessionId" =');
    expect(sql).toContain('control_grant."turnId" =');
    expect(sql).toContain('control_grant."artifactId" =');
    expect(sql).toContain('control_grant."contextRevision" =');
    expect(sql).toContain('control_grant."contextDigest" =');
    expect(sql).toContain('control_grant."expiresAt" > clock_timestamp()');
    expect(sql).toContain("exact_artifact.state = 'delivered'");
    expect(sql).toContain('exact_artifact."deliveryId" =');
    expect(sql).toContain('exact_artifact."sidebandOwnerEpoch" =');
    expect(sql).toContain('exact_artifact."sidebandOwnerTokenHash" =');
    expect(sql).toContain('lease."leaseExpiresAt" > clock_timestamp()');
    expect(sql).toContain('lease."hardExpiresAt" > clock_timestamp()');
    expect(sql).toContain('lease."sidebandOwnerLeaseExpiresAt" > clock_timestamp()');
    expect(sql).toContain('lease."contextAppliedOwnerEpoch" = exact_artifact."sidebandOwnerEpoch"');
    expect(sql).toContain('NOT EXISTS ( SELECT 1 FROM realtime_control_consumptions AS consumption');
    const values = h.queryRaw.mock.calls[4]?.slice(1) ?? [];
    expect(values).toEqual(expect.arrayContaining([
      COMPANY,
      SUBJECT,
      SESSION,
      TURN,
      ARTIFACT,
      DELIVERY,
      CONTEXT,
      OWNER,
    ]));
  });

  it.each([
    'absent',
    'expiré',
    'déjà consommé',
    'lié à un autre contexte ou owner',
  ])('ne publie aucune référence si le grant est %s', async () => {
    const h = harness([
      [],
      [lockedArtifact()],
      [{ ok: true }],
      [{ contextRevision: 7, contextDigest: CONTEXT }],
      [{ ok: false }],
    ]);

    await expect(h.value.acknowledgeDelivery(input())).resolves.toMatchObject({
      status: 'delivered',
      controlCurrent: false,
    });
  });

  it('ne republie pas un contrôle consommé lors d’un retry idempotent de l’ACK', async () => {
    const h = harness([
      [],
      [lockedArtifact('delivered')],
      [{ ok: false }],
    ]);

    await expect(h.value.acknowledgeDelivery(input())).resolves.toEqual({
      status: 'delivered',
      idempotent: true,
      controlCurrent: false,
      contextRevision: 7,
      contextDigest: CONTEXT,
    });
  });

  it('échoue fermé et rollback l’ACK si la projection du grant devient indisponible', async () => {
    const h = harness([
      [],
      [lockedArtifact()],
      [{ ok: true }],
      [{ contextRevision: 7, contextDigest: CONTEXT }],
      new Error('database unavailable'),
    ]);

    await expect(h.value.acknowledgeDelivery(input())).resolves.toEqual({ status: 'unavailable' });
  });
});

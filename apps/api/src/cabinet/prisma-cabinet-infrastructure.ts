import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  Cabinet,
  CabinetInvitation,
  ReleaseFlag,
  type CabinetInvitationDispatch,
  type CabinetInvitationDispatchPort,
  type CabinetInvitationRepository,
  type CabinetInvitationSnapshot,
  type CabinetInvitationTokenHash,
  type CabinetMemberSnapshot,
  type CabinetRepository,
  type CabinetSnapshot,
  type DomainEvent,
  type ReleaseFlagRepository,
  type ReleaseFlagSnapshot,
} from '@bob/core';
import { getCorrelationId, getPrincipal } from '../observability/logger';
import type { PrismaService } from '../persistence/prisma/prisma.service';
import {
  CabinetOptimisticConflictError,
  CabinetPersistenceConflictError,
  type CabinetInfrastructure,
  type CabinetInvitationPage,
  type CabinetInvitationQueryStore,
  type CabinetInvitationDeliveryStatus,
  type CabinetInvitationDeliveryStore,
  type CabinetInvitationDeliveryView,
} from './cabinet-infrastructure';
import { CabinetInvitationTokenAdapter, CabinetInvitationTokenCipher } from './cabinet-token';
import { PrismaCabinetDossierRepository } from './dossiers/prisma-cabinet-dossier.repository';

type CabinetAggregateRow = Prisma.CabinetGetPayload<{ include: { members: true } }>;
type ReleaseFlagRow = Prisma.ReleaseFlagGetPayload<{ include: { subjects: true } }>;
const CABINET_MEMBER_HARD_LIMIT = 500;
const CABINET_INVITATION_COMPATIBILITY_LIMIT = 201;
const CANONICAL_DATABASE_AUDIT_EVENTS = new Set([
  'CabinetInvitationAccepted',
  'CabinetMemberJoined',
]);

function memberRowToSnapshot(row: CabinetAggregateRow['members'][number]): CabinetMemberSnapshot {
  return {
    id: row.id,
    cabinetId: row.cabinetId,
    userId: row.userId,
    sourceInvitationId: row.sourceInvitationId,
    role: row.role,
    status: row.status,
    joinedAt: row.joinedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

function cabinetRowToDomain(row: CabinetAggregateRow): Cabinet {
  return Cabinet.rehydrate({
    id: row.id,
    name: row.name,
    timeZone: row.timeZone,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    createdByUserId: row.createdByUserId,
    version: row.version,
    members: row.members.map(memberRowToSnapshot),
  });
}

function invitationRowToDomain(row: {
  id: string;
  cabinetId: string;
  emailNormalized: string;
  role: 'admin' | 'manager' | 'collaborator';
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  tokenHash: string;
  invitedByMemberId: string;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedByUserId: string | null;
  revokedAt: Date | null;
  revokedByMemberId: string | null;
  version: number;
}): CabinetInvitation {
  return CabinetInvitation.rehydrate({
    id: row.id,
    cabinetId: row.cabinetId,
    email: row.emailNormalized,
    role: row.role,
    status: row.status,
    tokenHash: row.tokenHash,
    invitedByMemberId: row.invitedByMemberId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    acceptedByUserId: row.acceptedByUserId,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedByMemberId: row.revokedByMemberId,
    version: row.version,
  });
}

function releaseFlagRowToDomain(row: ReleaseFlagRow): ReleaseFlag {
  return ReleaseFlag.rehydrate({
    id: row.id,
    key: row.key,
    environment: row.environment,
    globallyEnabled: row.enabled,
    killSwitchActive: row.killSwitch,
    subjectOverrides: row.subjects.map((subject) => ({
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      enabled: subject.enabled,
    })),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    updatedByUserId: row.updatedByUserId,
  });
}

/**
 * Détection de changement réel d'une membership entre la ligne DB et le snapshot domaine.
 * Piège null vs undefined : `row.suspendedAt?.toISOString()` vaut `undefined` quand la colonne
 * est NULL alors que le snapshot domaine porte `null` — sans normalisation `?? null`, chaque
 * save() marquerait « changed » toutes les memberships actives et émettrait des UPDATE parasites,
 * filtrés par la policy cabinet_member_update (count=0 → 409) ou rejetés par
 * cabinet_guard_member_update (ligne revoked → 23514).
 */
export function cabinetMemberRowChanged(
  row: { role: string; status: string; suspendedAt: Date | null; revokedAt: Date | null },
  member: Pick<CabinetMemberSnapshot, 'role' | 'status' | 'suspendedAt' | 'revokedAt'>,
): boolean {
  return (
    row.role !== member.role ||
    row.status !== member.status ||
    (row.suspendedAt?.toISOString() ?? null) !== member.suspendedAt ||
    (row.revokedAt?.toISOString() ?? null) !== member.revokedAt
  );
}

function memberData(snapshot: CabinetMemberSnapshot) {
  return {
    cabinetId: snapshot.cabinetId,
    userId: snapshot.userId,
    sourceInvitationId: snapshot.sourceInvitationId,
    role: snapshot.role,
    status: snapshot.status,
    joinedAt: new Date(snapshot.joinedAt),
    suspendedAt: snapshot.suspendedAt ? new Date(snapshot.suspendedAt) : null,
    revokedAt: snapshot.revokedAt ? new Date(snapshot.revokedAt) : null,
  };
}

async function appendAuditEvents(
  prisma: PrismaService,
  cabinetId: string,
  entityType: string,
  entityId: string,
  events: DomainEvent[],
): Promise<void> {
  const applicationEvents = events.filter((event) => !CANONICAL_DATABASE_AUDIT_EVENTS.has(event.type));
  if (applicationEvents.length === 0) return;
  const actorUserId = getPrincipal()?.userId;
  if (!actorUserId) throw new Error('Cabinet audit requires an authenticated principal.');
  for (const event of applicationEvents) {
    const payload = JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue;
    await prisma.client().cabinetAuditEvent.create({
      data: {
        id: randomUUID(),
        cabinetId,
        actorUserId,
        action: event.type,
        entityType,
        entityId,
        payload,
        correlationId: getCorrelationId() === '-' ? null : getCorrelationId(),
      },
    });
  }
}

export class PrismaCabinetRepository implements CabinetRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Cabinet | null> {
    const row = await this.prisma.client().cabinet.findUnique({
      where: { id },
      include: { members: { orderBy: { joinedAt: 'asc' } } },
    });
    return row ? cabinetRowToDomain(row) : null;
  }

  async lockById(id: string): Promise<Cabinet | null> {
    await this.prisma.selectCabinetInCurrentTransaction(id);
    await this.prisma.client().$queryRaw`SELECT id FROM cabinets WHERE id = ${id} FOR UPDATE`;
    return this.findById(id);
  }

  async listByUserId(userId: string): Promise<Cabinet[]> {
    const memberships = await this.prisma.client().cabinetMember.findMany({
      where: { userId, status: 'active' },
      select: { cabinetId: true },
      orderBy: { joinedAt: 'asc' },
    });
    const result: Cabinet[] = [];
    for (const { cabinetId } of memberships) {
      await this.prisma.selectCabinetInCurrentTransaction(cabinetId);
      const cabinet = await this.findById(cabinetId);
      if (cabinet) result.push(cabinet);
    }
    return result;
  }

  async save(cabinet: Cabinet, expectedVersion: number | null): Promise<void> {
    const snapshot = cabinet.toSnapshot();
    await this.prisma.selectCabinetInCurrentTransaction(snapshot.id);
    if (expectedVersion === null) {
      await this.create(snapshot);
      await appendAuditEvents(this.prisma, snapshot.id, 'cabinet', snapshot.id, cabinet.pullEvents());
      return;
    }
    await this.update(cabinet, snapshot, expectedVersion);
  }

  private async create(snapshot: CabinetSnapshot): Promise<void> {
    const db = this.prisma.client();
    await db.cabinet.create({
      data: {
        id: snapshot.id,
        name: snapshot.name,
        timeZone: snapshot.timeZone,
        status: snapshot.status,
        createdByUserId: snapshot.createdByUserId,
        bootstrapCompletedAt: null,
        version: snapshot.version,
        createdAt: new Date(snapshot.createdAt),
      },
    });
    for (const member of snapshot.members) {
      await db.cabinetMember.create({
        data: { id: member.id, ...memberData(member), version: 1, createdAt: new Date(member.joinedAt) },
      });
    }
    const bootstrapped = await db.cabinet.updateMany({
      where: { id: snapshot.id, bootstrapCompletedAt: null, version: snapshot.version },
      data: { bootstrapCompletedAt: new Date() },
    });
    if (bootstrapped.count !== 1) throw new CabinetOptimisticConflictError('cabinet');
  }

  private async update(cabinet: Cabinet, snapshot: CabinetSnapshot, expectedVersion: number): Promise<void> {
    const db = this.prisma.client();
    const existing = await db.cabinetMember.findMany({ where: { cabinetId: snapshot.id } });
    const byId = new Map(existing.map((member) => [member.id, member]));
    const newMembers = snapshot.members.filter((member) => !byId.has(member.id));
    if (existing.length + newMembers.length > CABINET_MEMBER_HARD_LIMIT) {
      throw new CabinetPersistenceConflictError('cabinet_member_quota_reached');
    }

    // Acceptation d'invitation : le bump Cabinet consomme d'abord une capacité append-only en DB.
    // L'INSERT membership exige ensuite ce marqueur exact, ce qui ferme tout second bump/replay.
    const updated = await db.cabinet.updateMany({
      where: { id: snapshot.id, version: expectedVersion },
      data: {
        name: snapshot.name,
        timeZone: snapshot.timeZone,
        status: snapshot.status,
        version: snapshot.version,
      },
    });
    if (updated.count !== 1) throw new CabinetOptimisticConflictError('cabinet');

    for (const member of newMembers) {
      await db.cabinetMember.create({ data: { id: member.id, ...memberData(member), version: 1 } });
    }

    await appendAuditEvents(this.prisma, snapshot.id, 'cabinet', snapshot.id, cabinet.pullEvents());

    for (const member of snapshot.members) {
      const row = byId.get(member.id);
      if (!row) continue;
      if (!cabinetMemberRowChanged(row, member)) continue;
      const result = await db.cabinetMember.updateMany({
        where: { id: member.id, cabinetId: snapshot.id, version: row.version },
        data: { ...memberData(member), version: row.version + 1 },
      });
      if (result.count !== 1) throw new CabinetOptimisticConflictError('cabinet_member');
    }
  }
}

export class PrismaCabinetInvitationRepository implements CabinetInvitationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<CabinetInvitation | null> {
    const row = await this.prisma.client().cabinetInvitation.findUnique({ where: { id } });
    return row ? invitationRowToDomain(row) : null;
  }

  async lockById(id: string): Promise<CabinetInvitation | null> {
    await this.prisma.client().$queryRaw`SELECT id FROM cabinet_invitations WHERE id = ${id} FOR UPDATE`;
    return this.findById(id);
  }

  async lockByTokenHash(tokenHash: CabinetInvitationTokenHash): Promise<CabinetInvitation | null> {
    await this.prisma.client().$queryRaw`SELECT id FROM cabinet_invitations WHERE "tokenHash" = ${tokenHash.value} FOR UPDATE`;
    const row = await this.prisma.client().cabinetInvitation.findUnique({ where: { tokenHash: tokenHash.value } });
    return row ? invitationRowToDomain(row) : null;
  }

  async lockPendingByCabinetAndEmail(
    cabinetId: string,
    normalizedEmail: string,
  ): Promise<CabinetInvitation | null> {
    await this.prisma.client().$queryRaw`
      SELECT id FROM cabinet_invitations
       WHERE "cabinetId" = ${cabinetId} AND "emailNormalized" = ${normalizedEmail} AND status = 'pending'
       FOR UPDATE
    `;
    const row = await this.prisma.client().cabinetInvitation.findFirst({
      where: { cabinetId, emailNormalized: normalizedEmail, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    return row ? invitationRowToDomain(row) : null;
  }

  async listByCabinet(cabinetId: string): Promise<CabinetInvitation[]> {
    const rows = await this.prisma.client().cabinetInvitation.findMany({
      where: { cabinetId },
      orderBy: { createdAt: 'desc' },
      take: CABINET_INVITATION_COMPATIBILITY_LIMIT,
    });
    return rows.map(invitationRowToDomain);
  }

  async save(invitation: CabinetInvitation, expectedVersion: number | null): Promise<void> {
    const snapshot = invitation.toSnapshot();
    try {
      if (expectedVersion === null) {
        await this.prisma.client().cabinetInvitation.create({ data: this.createData(snapshot) });
      } else {
        const result = await this.prisma.client().cabinetInvitation.updateMany({
          where: { id: snapshot.id, version: expectedVersion },
          data: {
            status: snapshot.status,
            acceptedAt: snapshot.acceptedAt ? new Date(snapshot.acceptedAt) : null,
            acceptedByUserId: snapshot.acceptedByUserId,
            revokedAt: snapshot.revokedAt ? new Date(snapshot.revokedAt) : null,
            revokedByMemberId: snapshot.revokedByMemberId,
            version: snapshot.version,
          },
        });
        if (result.count !== 1) throw new CabinetOptimisticConflictError('cabinet_invitation');
      }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new CabinetPersistenceConflictError('invitation_already_pending');
      }
      throw error;
    }
    await appendAuditEvents(this.prisma, snapshot.cabinetId, 'cabinet_invitation', snapshot.id, invitation.pullEvents());
  }

  private createData(snapshot: CabinetInvitationSnapshot) {
    return {
      id: snapshot.id,
      cabinetId: snapshot.cabinetId,
      emailNormalized: snapshot.email,
      role: snapshot.role,
      status: snapshot.status,
      tokenHash: snapshot.tokenHash,
      expiresAt: new Date(snapshot.expiresAt),
      invitedByMemberId: snapshot.invitedByMemberId,
      acceptedByUserId: snapshot.acceptedByUserId,
      acceptedAt: snapshot.acceptedAt ? new Date(snapshot.acceptedAt) : null,
      revokedAt: snapshot.revokedAt ? new Date(snapshot.revokedAt) : null,
      revokedByMemberId: snapshot.revokedByMemberId,
      version: snapshot.version,
      createdAt: new Date(snapshot.createdAt),
    };
  }
}

export class PrismaCabinetInvitationQueryStore implements CabinetInvitationQueryStore {
  constructor(private readonly prisma: PrismaService) {}

  async listPendingPage(input: {
    cabinetId: string;
    cursor?: string;
    limit: number;
  }): Promise<CabinetInvitationPage> {
    const limit = Math.max(1, Math.min(input.limit, 100));
    const cursor = input.cursor
      ? await this.prisma.client().cabinetInvitation.findFirst({
          where: { id: input.cursor, cabinetId: input.cabinetId },
          select: { id: true, createdAt: true },
        })
      : null;
    if (input.cursor && !cursor) return { items: [], nextCursor: null };
    const rows = await this.prisma.client().cabinetInvitation.findMany({
      where: {
        cabinetId: input.cabinetId,
        status: 'pending',
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map(invitationRowToDomain),
      nextCursor: rows.length > limit ? (pageRows.at(-1)?.id ?? null) : null,
    };
  }

  async listExpiredPendingIds(input: { cabinetId: string; now: string; limit: number }): Promise<string[]> {
    const rows = await this.prisma.client().cabinetInvitation.findMany({
      where: {
        cabinetId: input.cabinetId,
        status: 'pending',
        expiresAt: { lte: new Date(input.now) },
      },
      select: { id: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: Math.max(1, Math.min(input.limit, 100)),
    });
    return rows.map((row) => row.id);
  }
}

export class PrismaReleaseFlagRepository implements ReleaseFlagRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByKey(environment: ReleaseFlagSnapshot['environment'], key: string): Promise<ReleaseFlag | null> {
    const row = await this.prisma.client().releaseFlag.findFirst({
      where: { key, environment },
      include: { subjects: true },
    });
    return row ? releaseFlagRowToDomain(row) : null;
  }

  async lockByKey(environment: ReleaseFlagSnapshot['environment'], key: string): Promise<ReleaseFlag | null> {
    await this.prisma.client().$queryRaw`
      SELECT id FROM release_flags WHERE environment = ${environment}::"ReleaseEnvironment" AND key = ${key} FOR UPDATE
    `;
    return this.findByKey(environment, key);
  }

  async save(flag: ReleaseFlag, expectedVersion: number | null): Promise<void> {
    const snapshot = flag.toSnapshot();
    if (expectedVersion === null) {
      await this.prisma.client().releaseFlag.create({
        data: {
          id: snapshot.id,
          key: snapshot.key,
          environment: snapshot.environment,
          enabled: snapshot.globallyEnabled,
          killSwitch: snapshot.killSwitchActive,
          version: snapshot.version,
          createdAt: new Date(snapshot.createdAt),
          updatedAt: new Date(snapshot.updatedAt),
          updatedByUserId: snapshot.updatedByUserId,
        },
      });
      return;
    }

    const updated = await this.prisma.client().releaseFlag.updateMany({
      where: { id: snapshot.id, version: expectedVersion },
      data: {
        enabled: snapshot.globallyEnabled,
        killSwitch: snapshot.killSwitchActive,
        version: snapshot.version,
        updatedAt: new Date(snapshot.updatedAt),
        updatedByUserId: snapshot.updatedByUserId,
      },
    });
    if (updated.count !== 1) throw new CabinetOptimisticConflictError('release_flag');

    for (const override of snapshot.subjectOverrides) {
      if (override.subjectType !== 'cabinet') continue;
      const existing = await this.prisma.client().releaseFlagSubject.findFirst({
        where: {
          flagId: snapshot.id,
          subjectType: override.subjectType,
          subjectId: override.subjectId,
        },
      });
      if (!existing) {
        await this.prisma.client().releaseFlagSubject.create({
          data: {
            id: randomUUID(),
            flagId: snapshot.id,
            subjectType: override.subjectType,
            subjectId: override.subjectId,
            enabled: override.enabled,
            version: 1,
            updatedByUserId: snapshot.updatedByUserId,
          },
        });
      } else if (existing.enabled !== override.enabled) {
        const result = await this.prisma.client().releaseFlagSubject.updateMany({
          where: { id: existing.id, version: existing.version },
          data: {
            enabled: override.enabled,
            version: existing.version + 1,
            updatedByUserId: snapshot.updatedByUserId,
          },
        });
        if (result.count !== 1) throw new CabinetOptimisticConflictError('release_flag');
      }
    }

    const cabinetId = snapshot.subjectOverrides.find((override) => override.subjectType === 'cabinet')?.subjectId;
    if (cabinetId) {
      await appendAuditEvents(this.prisma, cabinetId, 'release_flag', snapshot.id, flag.pullEvents());
    }
  }
}

export class PrismaCabinetInvitationDispatch implements CabinetInvitationDispatchPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CabinetInvitationTokenCipher,
  ) {}

  async enqueue(input: CabinetInvitationDispatch): Promise<void> {
    const encrypted = this.cipher.encrypt(input.invitationId, input.rawToken);
    try {
      await this.prisma.client().cabinetInvitationDelivery.create({
        data: {
          id: randomUUID(),
          cabinetId: input.cabinetId,
          invitationId: input.invitationId,
          dedupeKey: `invitation:${input.invitationId}:issued`,
          tokenCiphertext: encrypted.ciphertext,
          tokenIv: encrypted.iv,
          tokenAuthTag: encrypted.authTag,
          tokenKeyVersion: encrypted.keyVersion,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: new Date(),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      throw error;
    }
  }
}

export class PrismaCabinetInvitationDeliveryStore implements CabinetInvitationDeliveryStore {
  constructor(private readonly prisma: PrismaService) {}

  async claimNext(input: {
    cabinetId: string;
    now: string;
    leaseUntil: string;
    allowedInvitationRoles: ReadonlyArray<'admin' | 'manager' | 'collaborator'>;
  }): Promise<CabinetInvitationDeliveryView | null> {
    return this.prisma.runInTransaction(async () => {
      const rows = await this.prisma.client().$queryRaw<Array<{ id: string }>>`
        SELECT delivery.id
          FROM cabinet_invitation_deliveries delivery
          JOIN cabinet_invitations invitation ON invitation.id = delivery."invitationId"
         WHERE delivery."cabinetId" = ${input.cabinetId}
           AND invitation.status = 'pending'
           AND invitation.role::text = ANY(${input.allowedInvitationRoles}::text[])
           AND invitation."expiresAt" > ${new Date(input.now)}
           AND delivery."nextAttemptAt" <= ${new Date(input.now)}
           AND (delivery.status IN ('pending', 'failed') OR (delivery.status = 'sending' AND delivery."leaseUntil" <= ${new Date(input.now)}))
         ORDER BY delivery."nextAttemptAt" ASC, delivery."createdAt" ASC
         LIMIT 1
      `;
      return this.claimById(rows[0]?.id, input);
    });
  }

  async claimForInvitation(input: {
    cabinetId: string;
    invitationId: string;
    now: string;
    leaseUntil: string;
    allowedInvitationRoles: ReadonlyArray<'admin' | 'manager' | 'collaborator'>;
  }): Promise<CabinetInvitationDeliveryView | null> {
    return this.prisma.runInTransaction(async () => {
      const rows = await this.prisma.client().$queryRaw<Array<{ id: string }>>`
        SELECT delivery.id
          FROM cabinet_invitation_deliveries delivery
          JOIN cabinet_invitations invitation ON invitation.id = delivery."invitationId"
         WHERE delivery."cabinetId" = ${input.cabinetId}
           AND delivery."invitationId" = ${input.invitationId}
           AND invitation.status = 'pending'
           AND invitation.role::text = ANY(${input.allowedInvitationRoles}::text[])
           AND invitation."expiresAt" > ${new Date(input.now)}
           AND delivery."nextAttemptAt" <= ${new Date(input.now)}
           AND (delivery.status IN ('pending', 'failed') OR (delivery.status = 'sending' AND delivery."leaseUntil" <= ${new Date(input.now)}))
         LIMIT 1
      `;
      return this.claimById(rows[0]?.id, input);
    });
  }

  private async claimById(
    id: string | undefined,
    input: {
      now: string;
      leaseUntil: string;
      allowedInvitationRoles: ReadonlyArray<'admin' | 'manager' | 'collaborator'>;
    },
  ): Promise<CabinetInvitationDeliveryView | null> {
      if (!id) return null;
      const row = await this.prisma.client().cabinetInvitationDelivery.findUnique({ where: { id } });
      if (!row) return null;
      // Ordre de verrouillage partagé avec le trigger terminal : Invitation -> advisory -> Delivery.
      const invitationLock = await this.prisma.client().$queryRaw<Array<{ id: string }>>`
        SELECT id FROM cabinet_invitations WHERE id = ${row.invitationId} FOR UPDATE SKIP LOCKED
      `;
      if (!invitationLock[0]) return null;
      await this.prisma.client().$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${row.invitationId}, 1))
      `;
      const deliveryLock = await this.prisma.client().$queryRaw<Array<{ id: string }>>`
        SELECT id FROM cabinet_invitation_deliveries WHERE id = ${id} FOR UPDATE SKIP LOCKED
      `;
      if (!deliveryLock[0]) return null;
      const current = await this.prisma.client().cabinetInvitationDelivery.findUnique({
        where: { id },
        include: { invitation: true },
      });
      const now = new Date(input.now);
      if (
        !current ||
        current.invitation.status !== 'pending' ||
        !input.allowedInvitationRoles.includes(current.invitation.role) ||
        current.invitation.expiresAt <= now ||
        current.nextAttemptAt > now ||
        !(
          current.status === 'pending' ||
          current.status === 'failed' ||
          (current.status === 'sending' && current.leaseUntil !== null && current.leaseUntil <= now)
        )
      ) return null;
      const claimed = await this.prisma.client().cabinetInvitationDelivery.updateMany({
        where: { id, attempts: current.attempts },
        data: {
          status: 'sending',
          attempts: current.attempts + 1,
          lockedAt: new Date(input.now),
          leaseUntil: new Date(input.leaseUntil),
          lastError: null,
        },
      });
      if (claimed.count !== 1) return null;
      const full = await this.prisma.client().cabinetInvitationDelivery.findUnique({
        where: { id },
        include: { invitation: true, cabinet: true },
      });
      if (!full?.tokenCiphertext || !full.tokenIv || !full.tokenAuthTag) {
        throw new Error('Cabinet invitation delivery has no encrypted token.');
      }
      return {
        id: full.id,
        cabinetId: full.cabinetId,
        invitationId: full.invitationId,
        email: full.invitation.emailNormalized,
        cabinetName: full.cabinet.name,
        role: full.invitation.role,
        expiresAt: full.invitation.expiresAt.toISOString(),
        status: full.status,
        attempts: full.attempts,
        nextAttemptAt: full.nextAttemptAt.toISOString(),
        encryptedToken: {
          ciphertext: full.tokenCiphertext,
          iv: full.tokenIv,
          authTag: full.tokenAuthTag,
          keyVersion: full.tokenKeyVersion,
        },
      };
  }

  async markDone(input: { id: string; expectedAttempts: number; sentAt: string }): Promise<void> {
    const result = await this.prisma.client().cabinetInvitationDelivery.updateMany({
      where: { id: input.id, status: 'sending', attempts: input.expectedAttempts },
      data: {
        status: 'done',
        sentAt: new Date(input.sentAt),
        lockedAt: null,
        leaseUntil: null,
        tokenCiphertext: null,
        tokenIv: null,
        tokenAuthTag: null,
      },
    });
    if (result.count !== 1) throw new CabinetPersistenceConflictError('delivery_not_sending');
  }

  async markFailed(input: { id: string; expectedAttempts: number; failedAt: string; nextAttemptAt: string; error: string }): Promise<void> {
    const result = await this.prisma.client().cabinetInvitationDelivery.updateMany({
      where: { id: input.id, status: 'sending', attempts: input.expectedAttempts },
      data: {
        status: 'failed',
        nextAttemptAt: new Date(input.nextAttemptAt),
        lockedAt: null,
        leaseUntil: null,
        lastError: input.error.slice(0, 2_000),
      },
    });
    if (result.count !== 1) throw new CabinetPersistenceConflictError('delivery_not_sending');
  }

  async cancelForInvitation(input: { invitationId: string; cancelledAt: string }): Promise<void> {
    await this.prisma.client().cabinetInvitationDelivery.updateMany({
      where: { invitationId: input.invitationId, status: { in: ['pending', 'failed', 'sending'] } },
      data: {
        status: 'cancelled',
        nextAttemptAt: new Date(input.cancelledAt),
        lockedAt: null,
        leaseUntil: null,
        lastError: null,
        tokenCiphertext: null,
        tokenIv: null,
        tokenAuthTag: null,
      },
    });
  }

  async statusForInvitation(invitationId: string): Promise<CabinetInvitationDeliveryStatus | null> {
    const row = await this.prisma.client().cabinetInvitationDelivery.findFirst({
      where: { invitationId },
      select: { status: true },
      orderBy: { createdAt: 'desc' },
    });
    return row?.status ?? null;
  }

  async oldestEncryptedCreatedAt(cabinetId: string): Promise<string | null> {
    const row = await this.prisma.client().cabinetInvitationDelivery.findFirst({
      where: {
        cabinetId,
        status: { in: ['pending', 'failed', 'sending'] },
        tokenCiphertext: { not: null },
      },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return row?.createdAt.toISOString() ?? null;
  }
}

export function createPrismaCabinetInfrastructure(prisma: PrismaService): CabinetInfrastructure {
  const cipher = new CabinetInvitationTokenCipher();
  return {
    cabinets: new PrismaCabinetRepository(prisma),
    dossiers: new PrismaCabinetDossierRepository(prisma),
    invitations: new PrismaCabinetInvitationRepository(prisma),
    invitationQueries: new PrismaCabinetInvitationQueryStore(prisma),
    flags: new PrismaReleaseFlagRepository(prisma),
    tokens: new CabinetInvitationTokenAdapter(),
    dispatch: new PrismaCabinetInvitationDispatch(prisma, cipher),
    deliveries: new PrismaCabinetInvitationDeliveryStore(prisma),
    decryptInvitationToken: (delivery) => cipher.decrypt(delivery.invitationId, delivery.encryptedToken),
  };
}

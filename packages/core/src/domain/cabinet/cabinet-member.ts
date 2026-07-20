import { type DomainResult, err, ok } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';
import { isCabinetRole, type CabinetRole } from './cabinet-permissions';

export const CABINET_MEMBER_STATUSES = ['active', 'suspended', 'revoked'] as const;

export type CabinetMemberStatus = (typeof CABINET_MEMBER_STATUSES)[number];

export interface CabinetMemberSnapshot {
  id: string;
  cabinetId: string;
  userId: string;
  role: CabinetRole;
  status: CabinetMemberStatus;
  joinedAt: Instant;
  updatedAt: Instant;
  suspendedAt: Instant | null;
  revokedAt: Instant | null;
  /** Identifiant consommé une seule fois ; null uniquement pour le membre fondateur. */
  sourceInvitationId: string | null;
}

function required(value: string, field: string): DomainResult<string> {
  const normalized = value.trim();
  return normalized.length > 0
    ? ok(normalized)
    : err({ code: 'VALIDATION', field, message: `${field} is required.` });
}

function validInstant(value: string): boolean {
  return value.length > 0 && !Number.isNaN(Date.parse(value));
}

/**
 * Membership d'une identité dans un Cabinet. Les changements passent par l'agrégat Cabinet,
 * qui est seul à pouvoir garantir l'invariant du dernier administrateur.
 */
export class CabinetMember {
  private constructor(private readonly snapshot: CabinetMemberSnapshot) {}

  static join(input: {
    id: string;
    cabinetId: string;
    userId: string;
    role: CabinetRole;
    joinedAt: Instant;
    sourceInvitationId?: string | null;
  }): DomainResult<CabinetMember> {
    const id = required(input.id, 'memberId');
    if (!id.ok) return id;
    const cabinetId = required(input.cabinetId, 'cabinetId');
    if (!cabinetId.ok) return cabinetId;
    const userId = required(input.userId, 'userId');
    if (!userId.ok) return userId;
    if (!isCabinetRole(input.role)) {
      return err({ code: 'VALIDATION', field: 'role', message: 'Unknown cabinet role.' });
    }
    if (!validInstant(input.joinedAt)) {
      return err({ code: 'VALIDATION', field: 'joinedAt', message: 'Invalid join instant.' });
    }
    const sourceInvitationId = input.sourceInvitationId == null
      ? null
      : required(input.sourceInvitationId, 'sourceInvitationId');
    if (sourceInvitationId !== null && !sourceInvitationId.ok) return sourceInvitationId;

    return ok(new CabinetMember({
      id: id.value,
      cabinetId: cabinetId.value,
      userId: userId.value,
      role: input.role,
      status: 'active',
      joinedAt: input.joinedAt,
      updatedAt: input.joinedAt,
      suspendedAt: null,
      revokedAt: null,
      sourceInvitationId: sourceInvitationId === null ? null : sourceInvitationId.value,
    }));
  }

  static rehydrate(snapshot: CabinetMemberSnapshot): CabinetMember {
    return new CabinetMember({ ...snapshot });
  }

  get id(): string {
    return this.snapshot.id;
  }

  get cabinetId(): string {
    return this.snapshot.cabinetId;
  }

  get userId(): string {
    return this.snapshot.userId;
  }

  get role(): CabinetRole {
    return this.snapshot.role;
  }

  get status(): CabinetMemberStatus {
    return this.snapshot.status;
  }

  get isActive(): boolean {
    return this.snapshot.status === 'active';
  }

  toSnapshot(): CabinetMemberSnapshot {
    return { ...this.snapshot };
  }
}

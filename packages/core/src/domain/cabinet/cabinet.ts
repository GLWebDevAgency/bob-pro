import { AggregateRoot, type DomainEvent } from '../../shared-kernel/aggregate';
import { type DomainResult, err, ok } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';
import { CabinetMember, type CabinetMemberSnapshot, type CabinetMemberStatus } from './cabinet-member';
import {
  canManageCabinetRole,
  hasCabinetPermission,
  isCabinetRole,
  type CabinetPermission,
  type CabinetRole,
} from './cabinet-permissions';

export const CABINET_STATUSES = ['active', 'suspended'] as const;
export type CabinetStatus = (typeof CABINET_STATUSES)[number];

export interface CabinetSnapshot {
  id: string;
  name: string;
  timeZone: string;
  status: CabinetStatus;
  createdAt: Instant;
  createdByUserId: string;
  version: number;
  members: CabinetMemberSnapshot[];
}

type CabinetDomainEvent = DomainEvent & Readonly<Record<string, unknown>>;

function required(value: string, field: string): DomainResult<string> {
  const normalized = value.trim();
  return normalized.length > 0
    ? ok(normalized)
    : err({ code: 'VALIDATION', field, message: `${field} is required.` });
}

function normalizedName(value: string): DomainResult<string> {
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 120) {
    return err({ code: 'VALIDATION', field: 'name', message: 'Cabinet name must contain 2 to 120 characters.' });
  }
  return ok(name);
}

function validInstant(value: string): boolean {
  return value.length > 0 && !Number.isNaN(Date.parse(value));
}

export class Cabinet extends AggregateRoot<string> {
  private _name: string;
  private _timeZone: string;
  private _status: CabinetStatus;
  private _version: number;
  private _members: CabinetMember[];

  private constructor(
    snapshot: Omit<CabinetSnapshot, 'members'>,
    members: CabinetMember[],
  ) {
    super(snapshot.id);
    this._name = snapshot.name;
    this._timeZone = snapshot.timeZone;
    this._status = snapshot.status;
    this._version = snapshot.version;
    this._members = members;
    this.createdAt = snapshot.createdAt;
    this.createdByUserId = snapshot.createdByUserId;
  }

  readonly createdAt: Instant;
  readonly createdByUserId: string;

  static create(input: {
    id: string;
    name: string;
    timeZone: string;
    creatorUserId: string;
    founderMemberId: string;
    createdAt: Instant;
  }): DomainResult<Cabinet> {
    const id = required(input.id, 'cabinetId');
    if (!id.ok) return id;
    const name = normalizedName(input.name);
    if (!name.ok) return name;
    const timeZone = required(input.timeZone, 'timeZone');
    if (!timeZone.ok) return timeZone;
    if (timeZone.value.length > 64) {
      return err({ code: 'VALIDATION', field: 'timeZone', message: 'Time zone is too long.' });
    }
    const creatorUserId = required(input.creatorUserId, 'creatorUserId');
    if (!creatorUserId.ok) return creatorUserId;
    if (!validInstant(input.createdAt)) {
      return err({ code: 'VALIDATION', field: 'createdAt', message: 'Invalid creation instant.' });
    }

    const founder = CabinetMember.join({
      id: input.founderMemberId,
      cabinetId: id.value,
      userId: creatorUserId.value,
      role: 'admin',
      joinedAt: input.createdAt,
    });
    if (!founder.ok) return founder;

    const cabinet = new Cabinet({
      id: id.value,
      name: name.value,
      timeZone: timeZone.value,
      status: 'active',
      createdAt: input.createdAt,
      createdByUserId: creatorUserId.value,
      version: 1,
    }, [founder.value]);
    cabinet.recordCabinetEvent({
      type: 'CabinetCreated',
      occurredAt: input.createdAt,
      version: cabinet._version,
      cabinetId: cabinet.id,
      founderUserId: creatorUserId.value,
    });
    return ok(cabinet);
  }

  static rehydrate(snapshot: CabinetSnapshot): Cabinet {
    const { members, ...cabinet } = snapshot;
    return new Cabinet({ ...cabinet }, members.map(CabinetMember.rehydrate));
  }

  get name(): string {
    return this._name;
  }

  get timeZone(): string {
    return this._timeZone;
  }

  get status(): CabinetStatus {
    return this._status;
  }

  get version(): number {
    return this._version;
  }

  get members(): readonly CabinetMember[] {
    return this._members;
  }

  memberById(memberId: string): CabinetMember | null {
    return this._members.find((member) => member.id === memberId) ?? null;
  }

  memberForUser(userId: string): CabinetMember | null {
    return this._members.find((member) => member.userId === userId && member.status !== 'revoked') ?? null;
  }

  activeMemberForUser(userId: string): CabinetMember | null {
    const member = this.memberForUser(userId);
    return member?.isActive ? member : null;
  }

  actorHasPermission(userId: string, permission: CabinetPermission): boolean {
    const actor = this.activeMemberForUser(userId);
    return actor !== null && this._status === 'active' && hasCabinetPermission(actor.role, permission);
  }

  addMemberFromInvitation(input: {
    memberId: string;
    userId: string;
    role: CabinetRole;
    invitationId: string;
    joinedAt: Instant;
  }): DomainResult<CabinetMember> {
    if (this._status !== 'active') {
      return err({ code: 'INVALID_TRANSITION', from: this._status, to: 'add_member' });
    }
    const existing = this._members.find((member) => member.userId === input.userId && member.status !== 'revoked');
    if (existing) {
      return err({ code: 'CABINET_MEMBER_ALREADY_EXISTS', cabinetId: this.id, userId: input.userId });
    }
    const joined = CabinetMember.join({
      id: input.memberId,
      cabinetId: this.id,
      userId: input.userId,
      role: input.role,
      joinedAt: input.joinedAt,
      sourceInvitationId: input.invitationId,
    });
    if (!joined.ok) return joined;
    this._members.push(joined.value);
    this.bumpVersion();
    this.recordCabinetEvent({
      type: 'CabinetMemberJoined',
      occurredAt: input.joinedAt,
      version: this._version,
      cabinetId: this.id,
      memberId: joined.value.id,
      userId: joined.value.userId,
      invitationId: input.invitationId,
      role: joined.value.role,
    });
    return joined;
  }

  changeMemberRole(input: {
    actorUserId: string;
    memberId: string;
    role: CabinetRole;
    changedAt: Instant;
  }): DomainResult<CabinetMember> {
    if (this._status !== 'active') {
      return err({ code: 'INVALID_TRANSITION', from: this._status, to: 'change_member_role' });
    }
    if (!isCabinetRole(input.role)) {
      return err({ code: 'VALIDATION', field: 'role', message: 'Unknown cabinet role.' });
    }
    const actor = this.activeMemberForUser(input.actorUserId);
    if (!actor) return err({ code: 'INVALID_TRANSITION', from: 'inactive_actor', to: 'change_member_role' });
    const targetIndex = this._members.findIndex((member) => member.id === input.memberId);
    const target = targetIndex >= 0 ? this._members[targetIndex] : undefined;
    if (!target) return err({ code: 'VALIDATION', field: 'memberId', message: 'Cabinet member not found.' });
    if (!target.isActive) return err({ code: 'INVALID_TRANSITION', from: target.status, to: 'active' });
    if (!canManageCabinetRole(actor.role, target.role) || !canManageCabinetRole(actor.role, input.role)) {
      return err({ code: 'INVALID_TRANSITION', from: actor.role, to: `manage_${target.role}` });
    }
    if (target.role === input.role) return ok(target);
    if (target.role === 'admin' && input.role !== 'admin' && this.activeAdminCount() === 1) {
      return err({ code: 'CABINET_LAST_ADMIN_REQUIRED', cabinetId: this.id });
    }

    const changed = CabinetMember.rehydrate({
      ...target.toSnapshot(),
      role: input.role,
      updatedAt: input.changedAt,
    });
    this._members[targetIndex] = changed;
    this.bumpVersion();
    this.recordCabinetEvent({
      type: 'CabinetMemberRoleChanged',
      occurredAt: input.changedAt,
      version: this._version,
      cabinetId: this.id,
      memberId: changed.id,
      actorUserId: input.actorUserId,
      fromRole: target.role,
      toRole: changed.role,
    });
    return ok(changed);
  }

  revokeMember(input: {
    actorUserId: string;
    memberId: string;
    revokedAt: Instant;
  }): DomainResult<CabinetMember> {
    return this.changeMemberStatus({ ...input, status: 'revoked', changedAt: input.revokedAt });
  }

  suspendMember(input: {
    actorUserId: string;
    memberId: string;
    suspendedAt: Instant;
  }): DomainResult<CabinetMember> {
    return this.changeMemberStatus({ ...input, status: 'suspended', changedAt: input.suspendedAt });
  }

  restoreMember(input: {
    actorUserId: string;
    memberId: string;
    restoredAt: Instant;
  }): DomainResult<CabinetMember> {
    if (this._status !== 'active') {
      return err({ code: 'INVALID_TRANSITION', from: this._status, to: 'restore_member' });
    }
    const actor = this.activeMemberForUser(input.actorUserId);
    if (!actor) return err({ code: 'INVALID_TRANSITION', from: 'inactive_actor', to: 'restore_member' });
    const targetIndex = this._members.findIndex((member) => member.id === input.memberId);
    const target = targetIndex >= 0 ? this._members[targetIndex] : undefined;
    if (!target) return err({ code: 'VALIDATION', field: 'memberId', message: 'Cabinet member not found.' });
    if (target.status !== 'suspended') return err({ code: 'INVALID_TRANSITION', from: target.status, to: 'active' });
    if (!canManageCabinetRole(actor.role, target.role)) {
      return err({ code: 'INVALID_TRANSITION', from: actor.role, to: `manage_${target.role}` });
    }
    const restored = CabinetMember.rehydrate({
      ...target.toSnapshot(),
      status: 'active',
      updatedAt: input.restoredAt,
      suspendedAt: null,
      revokedAt: null,
    });
    this._members[targetIndex] = restored;
    this.bumpVersion();
    this.recordCabinetEvent({
      type: 'CabinetMemberRestored',
      occurredAt: input.restoredAt,
      version: this._version,
      cabinetId: this.id,
      memberId: restored.id,
      actorUserId: input.actorUserId,
    });
    return ok(restored);
  }

  private changeMemberStatus(input: {
    actorUserId: string;
    memberId: string;
    status: Exclude<CabinetMemberStatus, 'active'>;
    changedAt: Instant;
  }): DomainResult<CabinetMember> {
    if (this._status !== 'active') {
      return err({ code: 'INVALID_TRANSITION', from: this._status, to: `${input.status}_member` });
    }
    const actor = this.activeMemberForUser(input.actorUserId);
    if (!actor) return err({ code: 'INVALID_TRANSITION', from: 'inactive_actor', to: `${input.status}_member` });
    const targetIndex = this._members.findIndex((member) => member.id === input.memberId);
    const target = targetIndex >= 0 ? this._members[targetIndex] : undefined;
    if (!target) return err({ code: 'VALIDATION', field: 'memberId', message: 'Cabinet member not found.' });
    if (!target.isActive) {
      if (target.status === input.status) return ok(target);
      if (!(target.status === 'suspended' && input.status === 'revoked')) {
        return err({ code: 'INVALID_TRANSITION', from: target.status, to: input.status });
      }
    }
    if (!canManageCabinetRole(actor.role, target.role)) {
      return err({ code: 'INVALID_TRANSITION', from: actor.role, to: `manage_${target.role}` });
    }
    if (target.isActive && target.role === 'admin' && this.activeAdminCount() === 1) {
      return err({ code: 'CABINET_LAST_ADMIN_REQUIRED', cabinetId: this.id });
    }

    const changed = CabinetMember.rehydrate({
      ...target.toSnapshot(),
      status: input.status,
      updatedAt: input.changedAt,
      suspendedAt: input.status === 'suspended' ? input.changedAt : target.toSnapshot().suspendedAt,
      revokedAt: input.status === 'revoked' ? input.changedAt : null,
    });
    this._members[targetIndex] = changed;
    this.bumpVersion();
    this.recordCabinetEvent({
      type: input.status === 'revoked' ? 'CabinetMemberRevoked' : 'CabinetMemberSuspended',
      occurredAt: input.changedAt,
      version: this._version,
      cabinetId: this.id,
      memberId: changed.id,
      actorUserId: input.actorUserId,
      role: changed.role,
    });
    return ok(changed);
  }

  private activeAdminCount(): number {
    return this._members.filter((member) => member.isActive && member.role === 'admin').length;
  }

  private bumpVersion(): void {
    this._version += 1;
  }

  private recordCabinetEvent(event: CabinetDomainEvent): void {
    this.record(event);
  }

  toSnapshot(): CabinetSnapshot {
    return {
      id: this.id,
      name: this._name,
      timeZone: this._timeZone,
      status: this._status,
      createdAt: this.createdAt,
      createdByUserId: this.createdByUserId,
      version: this._version,
      members: this._members.map((member) => member.toSnapshot()),
    };
  }
}

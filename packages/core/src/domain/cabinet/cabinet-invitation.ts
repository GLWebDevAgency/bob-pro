import { AggregateRoot, type DomainEvent } from '../../shared-kernel/aggregate';
import { type DomainResult, err, ok } from '../../shared-kernel/result';
import { type Instant } from '../../shared-kernel/time';
import { isCabinetRole, type CabinetRole } from './cabinet-permissions';

export const CABINET_INVITATION_STATUSES = ['pending', 'accepted', 'expired', 'revoked'] as const;
export type CabinetInvitationStatus = (typeof CABINET_INVITATION_STATUSES)[number];
type CabinetInvitationDomainEvent = DomainEvent & Readonly<Record<string, unknown>>;

export class CabinetInvitationEmail {
  private constructor(readonly value: string) {}

  static of(raw: string): DomainResult<CabinetInvitationEmail> {
    const value = raw.trim().toLowerCase();
    if (value.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      return err({ code: 'VALIDATION', field: 'email', message: 'Invalid invitation email.' });
    }
    return ok(new CabinetInvitationEmail(value));
  }
}

/** Valeur opaque persistée ; le secret brut n'entre jamais dans le domaine. */
export class CabinetInvitationTokenHash {
  private constructor(readonly value: string) {}

  static of(raw: string): DomainResult<CabinetInvitationTokenHash> {
    const value = raw.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(value)) {
      return err({ code: 'VALIDATION', field: 'tokenHash', message: 'Invalid invitation token hash.' });
    }
    return ok(new CabinetInvitationTokenHash(value));
  }
}

export interface CabinetInvitationSnapshot {
  id: string;
  cabinetId: string;
  email: string;
  role: CabinetRole;
  status: CabinetInvitationStatus;
  tokenHash: string;
  invitedByMemberId: string;
  createdAt: Instant;
  expiresAt: Instant;
  acceptedAt: Instant | null;
  acceptedByUserId: string | null;
  revokedAt: Instant | null;
  revokedByMemberId: string | null;
  version: number;
}

function required(value: string, field: string): DomainResult<string> {
  const normalized = value.trim();
  return normalized.length > 0
    ? ok(normalized)
    : err({ code: 'VALIDATION', field, message: `${field} is required.` });
}

function timestamp(value: string, field: string): DomainResult<number> {
  const epoch = Date.parse(value);
  return Number.isNaN(epoch)
    ? err({ code: 'VALIDATION', field, message: `Invalid ${field}.` })
    : ok(epoch);
}

export class CabinetInvitation extends AggregateRoot<string> {
  private _status: CabinetInvitationStatus;
  private _acceptedAt: Instant | null;
  private _acceptedByUserId: string | null;
  private _revokedAt: Instant | null;
  private _revokedByMemberId: string | null;
  private _version: number;

  private constructor(private readonly base: {
    id: string;
    cabinetId: string;
    email: CabinetInvitationEmail;
    role: CabinetRole;
    tokenHash: CabinetInvitationTokenHash;
    invitedByMemberId: string;
    createdAt: Instant;
    expiresAt: Instant;
  }, state: {
    status: CabinetInvitationStatus;
    acceptedAt: Instant | null;
    acceptedByUserId: string | null;
    revokedAt: Instant | null;
    revokedByMemberId: string | null;
    version: number;
  }) {
    super(base.id);
    this._status = state.status;
    this._acceptedAt = state.acceptedAt;
    this._acceptedByUserId = state.acceptedByUserId;
    this._revokedAt = state.revokedAt;
    this._revokedByMemberId = state.revokedByMemberId;
    this._version = state.version;
  }

  static issue(input: {
    id: string;
    cabinetId: string;
    email: string;
    role: CabinetRole;
    tokenHash: CabinetInvitationTokenHash;
    invitedByMemberId: string;
    createdAt: Instant;
    expiresAt: Instant;
  }): DomainResult<CabinetInvitation> {
    const id = required(input.id, 'invitationId');
    if (!id.ok) return id;
    const cabinetId = required(input.cabinetId, 'cabinetId');
    if (!cabinetId.ok) return cabinetId;
    const invitedByMemberId = required(input.invitedByMemberId, 'invitedByMemberId');
    if (!invitedByMemberId.ok) return invitedByMemberId;
    const email = CabinetInvitationEmail.of(input.email);
    if (!email.ok) return email;
    if (!isCabinetRole(input.role)) {
      return err({ code: 'VALIDATION', field: 'role', message: 'Unknown cabinet role.' });
    }
    const createdAt = timestamp(input.createdAt, 'createdAt');
    if (!createdAt.ok) return createdAt;
    const expiresAt = timestamp(input.expiresAt, 'expiresAt');
    if (!expiresAt.ok) return expiresAt;
    if (expiresAt.value <= createdAt.value) {
      return err({ code: 'VALIDATION', field: 'expiresAt', message: 'Invitation expiry must be in the future.' });
    }

    const invitation = new CabinetInvitation({
      id: id.value,
      cabinetId: cabinetId.value,
      email: email.value,
      role: input.role,
      tokenHash: input.tokenHash,
      invitedByMemberId: invitedByMemberId.value,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
    }, {
      status: 'pending',
      acceptedAt: null,
      acceptedByUserId: null,
      revokedAt: null,
      revokedByMemberId: null,
      version: 1,
    });
    invitation.recordInvitationEvent({
      type: 'CabinetMemberInvited',
      occurredAt: input.createdAt,
      version: invitation._version,
      invitationId: invitation.id,
      cabinetId: invitation.cabinetId,
      role: invitation.role,
    });
    return ok(invitation);
  }

  static rehydrate(snapshot: CabinetInvitationSnapshot): CabinetInvitation {
    const email = CabinetInvitationEmail.of(snapshot.email);
    const tokenHash = CabinetInvitationTokenHash.of(snapshot.tokenHash);
    if (!email.ok || !tokenHash.ok) {
      throw new Error('Cannot rehydrate an invalid cabinet invitation snapshot.');
    }
    return new CabinetInvitation({
      id: snapshot.id,
      cabinetId: snapshot.cabinetId,
      email: email.value,
      role: snapshot.role,
      tokenHash: tokenHash.value,
      invitedByMemberId: snapshot.invitedByMemberId,
      createdAt: snapshot.createdAt,
      expiresAt: snapshot.expiresAt,
    }, {
      status: snapshot.status,
      acceptedAt: snapshot.acceptedAt,
      acceptedByUserId: snapshot.acceptedByUserId,
      revokedAt: snapshot.revokedAt,
      revokedByMemberId: snapshot.revokedByMemberId,
      version: snapshot.version,
    });
  }

  get cabinetId(): string {
    return this.base.cabinetId;
  }

  get email(): string {
    return this.base.email.value;
  }

  get role(): CabinetRole {
    return this.base.role;
  }

  get tokenHash(): CabinetInvitationTokenHash {
    return this.base.tokenHash;
  }

  get invitedByMemberId(): string {
    return this.base.invitedByMemberId;
  }

  get status(): CabinetInvitationStatus {
    return this._status;
  }

  get expiresAt(): Instant {
    return this.base.expiresAt;
  }

  get version(): number {
    return this._version;
  }

  effectiveStatus(at: Instant): CabinetInvitationStatus {
    if (this._status === 'pending' && Date.parse(at) >= Date.parse(this.base.expiresAt)) return 'expired';
    return this._status;
  }

  accept(input: { userId: string; verifiedEmail: string; acceptedAt: Instant }): DomainResult<void> {
    if (this._status === 'accepted') {
      return err({ code: 'CABINET_INVITATION_ALREADY_USED', invitationId: this.id });
    }
    if (this._status !== 'pending') {
      return err({ code: 'INVALID_TRANSITION', from: this._status, to: 'accepted' });
    }
    if (this.effectiveStatus(input.acceptedAt) === 'expired') {
      return err({ code: 'CABINET_INVITATION_EXPIRED', invitationId: this.id, expiresAt: this.base.expiresAt });
    }
    const verifiedEmail = CabinetInvitationEmail.of(input.verifiedEmail);
    if (!verifiedEmail.ok || verifiedEmail.value.value !== this.base.email.value) {
      return err({ code: 'CABINET_INVITATION_EMAIL_MISMATCH', invitationId: this.id });
    }
    const userId = required(input.userId, 'userId');
    if (!userId.ok) return userId;
    this._status = 'accepted';
    this._acceptedAt = input.acceptedAt;
    this._acceptedByUserId = userId.value;
    this._version += 1;
    this.recordInvitationEvent({
      type: 'CabinetInvitationAccepted',
      occurredAt: input.acceptedAt,
      version: this._version,
      invitationId: this.id,
      cabinetId: this.cabinetId,
      userId: userId.value,
    });
    return ok(undefined);
  }

  revoke(input: { actorMemberId: string; revokedAt: Instant }): DomainResult<void> {
    if (this._status === 'accepted') {
      return err({ code: 'CABINET_INVITATION_ALREADY_USED', invitationId: this.id });
    }
    if (this._status === 'revoked') return ok(undefined);
    if (this._status !== 'pending') {
      return err({ code: 'INVALID_TRANSITION', from: this._status, to: 'revoked' });
    }
    const actorMemberId = required(input.actorMemberId, 'actorMemberId');
    if (!actorMemberId.ok) return actorMemberId;
    this._status = 'revoked';
    this._revokedAt = input.revokedAt;
    this._revokedByMemberId = actorMemberId.value;
    this._version += 1;
    this.recordInvitationEvent({
      type: 'CabinetInvitationRevoked',
      occurredAt: input.revokedAt,
      version: this._version,
      invitationId: this.id,
      cabinetId: this.cabinetId,
      actorMemberId: actorMemberId.value,
    });
    return ok(undefined);
  }

  expire(at: Instant): DomainResult<void> {
    if (this._status === 'expired') return ok(undefined);
    if (this._status !== 'pending') {
      return err({ code: 'INVALID_TRANSITION', from: this._status, to: 'expired' });
    }
    if (Date.parse(at) < Date.parse(this.base.expiresAt)) {
      return err({ code: 'VALIDATION', field: 'expiresAt', message: 'Invitation has not expired yet.' });
    }
    this._status = 'expired';
    this._version += 1;
    this.recordInvitationEvent({
      type: 'CabinetInvitationExpired',
      occurredAt: at,
      version: this._version,
      invitationId: this.id,
      cabinetId: this.cabinetId,
    });
    return ok(undefined);
  }

  toSnapshot(): CabinetInvitationSnapshot {
    return {
      id: this.id,
      cabinetId: this.base.cabinetId,
      email: this.base.email.value,
      role: this.base.role,
      status: this._status,
      tokenHash: this.base.tokenHash.value,
      invitedByMemberId: this.base.invitedByMemberId,
      createdAt: this.base.createdAt,
      expiresAt: this.base.expiresAt,
      acceptedAt: this._acceptedAt,
      acceptedByUserId: this._acceptedByUserId,
      revokedAt: this._revokedAt,
      revokedByMemberId: this._revokedByMemberId,
      version: this._version,
    };
  }

  private recordInvitationEvent(event: CabinetInvitationDomainEvent): void {
    this.record(event);
  }
}

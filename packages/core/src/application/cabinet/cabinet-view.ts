import { type Cabinet } from '../../domain/cabinet/cabinet';
import { type CabinetInvitation } from '../../domain/cabinet/cabinet-invitation';
import { type CabinetMember, type CabinetMemberStatus } from '../../domain/cabinet/cabinet-member';
import {
  CABINET_PERMISSIONS,
  hasCabinetPermission,
  type CabinetPermission,
  type CabinetRole,
} from '../../domain/cabinet/cabinet-permissions';

export interface CabinetMemberView {
  id: string;
  cabinetId: string;
  userId: string;
  role: CabinetRole;
  status: CabinetMemberStatus;
  joinedAt: string;
  updatedAt: string;
  suspendedAt: string | null;
  revokedAt: string | null;
}

export interface CabinetView {
  id: string;
  name: string;
  timeZone: string;
  status: 'active' | 'suspended';
  version: number;
  createdAt: string;
  actorRole: CabinetRole;
  permissions: CabinetPermission[];
  activeMemberCount: number;
}

export interface CabinetActorView {
  cabinetId: string;
  memberId: string;
  userId: string;
  role: CabinetRole;
  permissions: CabinetPermission[];
}

export interface CabinetInvitationView {
  id: string;
  cabinetId: string;
  email: string;
  role: CabinetRole;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  invitedByMemberId: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  version: number;
}

function permissionsFor(role: CabinetRole): CabinetPermission[] {
  return CABINET_PERMISSIONS.filter((permission) => hasCabinetPermission(role, permission));
}

export function cabinetMemberToView(member: CabinetMember): CabinetMemberView {
  const snapshot = member.toSnapshot();
  return {
    id: snapshot.id,
    cabinetId: snapshot.cabinetId,
    userId: snapshot.userId,
    role: snapshot.role,
    status: snapshot.status,
    joinedAt: snapshot.joinedAt,
    updatedAt: snapshot.updatedAt,
    suspendedAt: snapshot.suspendedAt,
    revokedAt: snapshot.revokedAt,
  };
}

export function cabinetToView(cabinet: Cabinet, actorUserId: string): CabinetView | null {
  const actor = cabinet.activeMemberForUser(actorUserId);
  if (!actor) return null;
  return {
    id: cabinet.id,
    name: cabinet.name,
    timeZone: cabinet.timeZone,
    status: cabinet.status,
    version: cabinet.version,
    createdAt: cabinet.createdAt,
    actorRole: actor.role,
    permissions: cabinet.status === 'active' ? permissionsFor(actor.role) : [],
    activeMemberCount: cabinet.members.filter((member) => member.isActive).length,
  };
}

export function cabinetActorToView(cabinet: Cabinet, userId: string): CabinetActorView | null {
  const member = cabinet.activeMemberForUser(userId);
  if (!member || cabinet.status !== 'active') return null;
  return {
    cabinetId: cabinet.id,
    memberId: member.id,
    userId: member.userId,
    role: member.role,
    permissions: permissionsFor(member.role),
  };
}

export function cabinetInvitationToView(invitation: CabinetInvitation, at: string): CabinetInvitationView {
  const snapshot = invitation.toSnapshot();
  return {
    id: snapshot.id,
    cabinetId: snapshot.cabinetId,
    email: snapshot.email,
    role: snapshot.role,
    status: invitation.effectiveStatus(at),
    invitedByMemberId: snapshot.invitedByMemberId,
    createdAt: snapshot.createdAt,
    expiresAt: snapshot.expiresAt,
    acceptedAt: snapshot.acceptedAt,
    revokedAt: snapshot.revokedAt,
    version: snapshot.version,
  };
}

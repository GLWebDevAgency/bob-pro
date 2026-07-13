export const CABINET_ROLES = ['admin', 'manager', 'collaborator'] as const;

export type CabinetRole = (typeof CABINET_ROLES)[number];

export const CABINET_PERMISSIONS = [
  'cabinet.read',
  'cabinet.members.read',
  'cabinet.members.invite_basic',
  'cabinet.members.invite_privileged',
  'cabinet.members.manage_basic',
  'cabinet.members.manage_privileged',
  'cabinet.settings.manage',
] as const;

export type CabinetPermission = (typeof CABINET_PERMISSIONS)[number];

const ROLE_PERMISSIONS: Readonly<Record<CabinetRole, ReadonlySet<CabinetPermission>>> = {
  admin: new Set(CABINET_PERMISSIONS),
  manager: new Set([
    'cabinet.read',
    'cabinet.members.read',
    'cabinet.members.invite_basic',
    'cabinet.members.manage_basic',
  ]),
  collaborator: new Set(['cabinet.read', 'cabinet.members.read']),
};

export function isCabinetRole(value: string): value is CabinetRole {
  return CABINET_ROLES.includes(value as CabinetRole);
}

export function hasCabinetPermission(role: CabinetRole, permission: CabinetPermission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function canInviteCabinetRole(actorRole: CabinetRole, invitedRole: CabinetRole): boolean {
  const permission = invitedRole === 'collaborator'
    ? 'cabinet.members.invite_basic'
    : 'cabinet.members.invite_privileged';
  return hasCabinetPermission(actorRole, permission);
}

export function canManageCabinetRole(actorRole: CabinetRole, targetRole: CabinetRole): boolean {
  const permission = targetRole === 'collaborator'
    ? 'cabinet.members.manage_basic'
    : 'cabinet.members.manage_privileged';
  return hasCabinetPermission(actorRole, permission);
}

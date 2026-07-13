import { describe, expect, it } from 'vitest';
import {
  CABINET_PERMISSIONS,
  canInviteCabinetRole,
  canManageCabinetRole,
  hasCabinetPermission,
} from './cabinet-permissions';

describe('cabinet RBAC', () => {
  it('accorde toutes les permissions Slice 0 à l’admin', () => {
    expect(CABINET_PERMISSIONS.every((permission) => hasCabinetPermission('admin', permission))).toBe(true);
  });

  it('borne le manager aux collaborateurs', () => {
    expect(canInviteCabinetRole('manager', 'collaborator')).toBe(true);
    expect(canInviteCabinetRole('manager', 'manager')).toBe(false);
    expect(canManageCabinetRole('manager', 'collaborator')).toBe(true);
    expect(canManageCabinetRole('manager', 'admin')).toBe(false);
  });

  it('rend le collaborateur lecteur sans capacité de gestion', () => {
    expect(hasCabinetPermission('collaborator', 'cabinet.read')).toBe(true);
    expect(hasCabinetPermission('collaborator', 'cabinet.members.read')).toBe(true);
    expect(canInviteCabinetRole('collaborator', 'collaborator')).toBe(false);
    expect(canManageCabinetRole('collaborator', 'collaborator')).toBe(false);
  });
});

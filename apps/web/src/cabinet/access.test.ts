import { describe, expect, it } from 'vitest';
import { canEditCabinetMemberRole, isLocalCabinetAccess } from './access';

describe('politiques d’accès du web cabinet', () => {
  it('réserve le prototype persistant au mode local explicite', () => {
    expect(isLocalCabinetAccess({ mode: 'local' })).toBe(true);
    expect(isLocalCabinetAccess({
      mode: 'authenticated',
      cabinets: [],
      selectedCabinet: { id: 'cabinet-1', name: 'Cabinet Martin', role: 'admin' },
      team: {
        listMembers: async () => ({ items: [], nextCursor: null, hasMore: false }),
        listInvitations: async () => ({ items: [], nextCursor: null, hasMore: false }),
        inviteMember: async () => ({ id: 'i-1', email: 'pro@cabinet.fr', role: 'collaborator', status: 'pending', expiresAt: '2026-07-13T00:00:00.000Z' }),
        revokeInvitation: async () => undefined,
        updateMember: async () => ({ id: 'm-1', userId: 'u-1', role: 'collaborator', status: 'active', joinedAt: null, updatedAt: '2026-07-12T00:00:00.000Z' }),
      },
      userEmail: 'admin@cabinet.fr',
      onSelectCabinet: () => undefined,
      onSignOut: () => undefined,
    })).toBe(false);
  });

  it('interdit tout changement de rôle sur un membre suspendu ou révoqué', () => {
    expect(canEditCabinetMemberRole('admin', 'active')).toBe(true);
    expect(canEditCabinetMemberRole('admin', 'suspended')).toBe(false);
    expect(canEditCabinetMemberRole('admin', 'revoked')).toBe(false);
    expect(canEditCabinetMemberRole('manager', 'active')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { CabinetMember } from './cabinet-member';
import { type CabinetRole } from './cabinet-permissions';

const VALID = {
  id: 'member-1',
  cabinetId: 'cab-1',
  userId: 'user-1',
  role: 'collaborator' as CabinetRole,
  joinedAt: '2026-07-12T09:00:00.000Z',
};

describe('CabinetMember', () => {
  it.each([
    [{ id: '' }, 'memberId'],
    [{ cabinetId: '' }, 'cabinetId'],
    [{ userId: '' }, 'userId'],
    [{ role: 'owner' as CabinetRole }, 'role'],
    [{ joinedAt: '' }, 'joinedAt'],
    [{ joinedAt: 'not-an-instant' }, 'joinedAt'],
  ])('rejette une membership invalide %o', (override, field) => {
    const result = CabinetMember.join({ ...VALID, ...override });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'VALIDATION') expect(result.error.field).toBe(field);
  });

  it('réhydrate un snapshot sans événement ni mutation', () => {
    const member = CabinetMember.rehydrate({
      ...VALID,
      status: 'suspended',
      updatedAt: VALID.joinedAt,
      suspendedAt: VALID.joinedAt,
      revokedAt: null,
      sourceInvitationId: 'invitation-1',
    });

    expect(member.cabinetId).toBe('cab-1');
    expect(member.isActive).toBe(false);
    expect(member.toSnapshot().status).toBe('suspended');
    expect(member.toSnapshot().sourceInvitationId).toBe('invitation-1');
  });
});

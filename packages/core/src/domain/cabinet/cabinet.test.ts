import { describe, expect, it } from 'vitest';
import { Cabinet } from './cabinet';
import { type CabinetRole } from './cabinet-permissions';

const NOW = '2026-07-12T09:00:00.000Z';

function cabinet(): Cabinet {
  const created = Cabinet.create({
    id: 'cab-1',
    name: '  Cabinet   Martin  ',
    timeZone: 'Europe/Paris',
    creatorUserId: 'user-admin',
    founderMemberId: 'member-admin',
    createdAt: NOW,
  });
  if (!created.ok) throw new Error('fixture invalid');
  created.value.pullEvents();
  return created.value;
}

function addMember(target: Cabinet, memberId: string, userId: string, role: 'admin' | 'manager' | 'collaborator'): void {
  const added = target.addMemberFromInvitation({
    memberId,
    userId,
    role,
    invitationId: `invite-${memberId}`,
    joinedAt: NOW,
  });
  if (!added.ok) throw new Error('fixture invalid');
  target.pullEvents();
}

describe('Cabinet', () => {
  it('crée atomiquement le cabinet et son premier admin', () => {
    const target = cabinet();

    expect(target.name).toBe('Cabinet Martin');
    expect(target.version).toBe(1);
    expect(target.members.map((member) => member.toSnapshot())).toEqual([
      expect.objectContaining({
        id: 'member-admin',
        userId: 'user-admin',
        role: 'admin',
        status: 'active',
        suspendedAt: null,
        revokedAt: null,
      }),
    ]);
    expect(target.actorHasPermission('user-admin', 'cabinet.settings.manage')).toBe(true);
  });

  it('refuse une seconde membership active pour la même identité', () => {
    const target = cabinet();
    addMember(target, 'member-collab', 'user-collab', 'collaborator');

    const duplicate = target.addMemberFromInvitation({
      memberId: 'member-other',
      userId: 'user-collab',
      role: 'collaborator',
      invitationId: 'invite-other',
      joinedAt: NOW,
    });

    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe('CABINET_MEMBER_ALREADY_EXISTS');
  });

  it('exige la traçabilité de l’invitation pour toute membership non fondatrice', () => {
    const target = cabinet();
    const added = target.addMemberFromInvitation({
      memberId: 'member-without-source',
      userId: 'user-without-source',
      role: 'collaborator',
      invitationId: '',
      joinedAt: NOW,
    });

    expect(added.ok).toBe(false);
    if (!added.ok && added.error.code === 'VALIDATION') {
      expect(added.error.field).toBe('sourceInvitationId');
    }
  });

  it.each([
    [{ id: '' }, 'cabinetId'],
    [{ name: '' }, 'name'],
    [{ name: 'a'.repeat(121) }, 'name'],
    [{ timeZone: '' }, 'timeZone'],
    [{ timeZone: 'a'.repeat(65) }, 'timeZone'],
    [{ creatorUserId: '' }, 'creatorUserId'],
    [{ createdAt: '' }, 'createdAt'],
    [{ createdAt: 'invalid' }, 'createdAt'],
    [{ founderMemberId: '' }, 'memberId'],
  ])('rejette une création invalide %o', (override, field) => {
    const created = Cabinet.create({
      id: 'cab-validation',
      name: 'Cabinet Validation',
      timeZone: 'Europe/Paris',
      creatorUserId: 'user-admin',
      founderMemberId: 'member-admin',
      createdAt: NOW,
      ...override,
    });

    expect(created.ok).toBe(false);
    if (!created.ok && created.error.code === 'VALIDATION') expect(created.error.field).toBe(field);
  });

  it('interdit de rétrograder ou révoquer le dernier admin actif', () => {
    const target = cabinet();

    const demoted = target.changeMemberRole({
      actorUserId: 'user-admin',
      memberId: 'member-admin',
      role: 'manager',
      changedAt: NOW,
    });
    const revoked = target.revokeMember({
      actorUserId: 'user-admin',
      memberId: 'member-admin',
      revokedAt: NOW,
    });

    expect(demoted.ok).toBe(false);
    if (!demoted.ok) expect(demoted.error.code).toBe('CABINET_LAST_ADMIN_REQUIRED');
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.error.code).toBe('CABINET_LAST_ADMIN_REQUIRED');
    expect(target.version).toBe(1);
  });

  it('autorise la révocation d’un admin lorsqu’un autre admin reste actif', () => {
    const target = cabinet();
    addMember(target, 'member-admin-2', 'user-admin-2', 'admin');

    const revoked = target.revokeMember({
      actorUserId: 'user-admin-2',
      memberId: 'member-admin',
      revokedAt: '2026-07-12T10:00:00.000Z',
    });

    expect(revoked.ok).toBe(true);
    expect(target.memberById('member-admin')?.status).toBe('revoked');
    expect(target.pullEvents()).toEqual([
      expect.objectContaining({ type: 'CabinetMemberRevoked', version: 3 }),
    ]);
  });

  it('autorise la révocation terminale d’un admin déjà suspendu sans recompter sa place', () => {
    const target = cabinet();
    addMember(target, 'member-admin-2', 'user-admin-2', 'admin');
    expect(target.suspendMember({
      actorUserId: 'user-admin-2',
      memberId: 'member-admin',
      suspendedAt: '2026-07-12T10:00:00.000Z',
    }).ok).toBe(true);

    const revoked = target.revokeMember({
      actorUserId: 'user-admin-2',
      memberId: 'member-admin',
      revokedAt: '2026-07-12T11:00:00.000Z',
    });

    expect(revoked.ok).toBe(true);
    expect(target.memberById('member-admin')?.status).toBe('revoked');
  });

  it('empêche un manager de promouvoir un collaborateur ou gérer un admin', () => {
    const target = cabinet();
    addMember(target, 'member-manager', 'user-manager', 'manager');
    addMember(target, 'member-collab', 'user-collab', 'collaborator');

    const promote = target.changeMemberRole({
      actorUserId: 'user-manager',
      memberId: 'member-collab',
      role: 'manager',
      changedAt: NOW,
    });
    const revokeAdmin = target.revokeMember({
      actorUserId: 'user-manager',
      memberId: 'member-admin',
      revokedAt: NOW,
    });

    expect(promote.ok).toBe(false);
    expect(revokeAdmin.ok).toBe(false);
  });

  it('couvre les refus et no-op de changement de rôle', () => {
    const target = cabinet();
    addMember(target, 'member-collab', 'user-collab', 'collaborator');

    expect(target.changeMemberRole({
      actorUserId: 'user-admin',
      memberId: 'member-collab',
      role: 'owner' as CabinetRole,
      changedAt: NOW,
    }).ok).toBe(false);
    expect(target.changeMemberRole({
      actorUserId: 'unknown',
      memberId: 'member-collab',
      role: 'manager',
      changedAt: NOW,
    }).ok).toBe(false);
    expect(target.changeMemberRole({
      actorUserId: 'user-admin',
      memberId: 'missing',
      role: 'manager',
      changedAt: NOW,
    }).ok).toBe(false);
    expect(target.changeMemberRole({
      actorUserId: 'user-admin',
      memberId: 'member-collab',
      role: 'collaborator',
      changedAt: NOW,
    }).ok).toBe(true);
    expect(target.changeMemberRole({
      actorUserId: 'user-admin',
      memberId: 'member-collab',
      role: 'manager',
      changedAt: NOW,
    }).ok).toBe(true);
  });

  it('suspend puis restaure un collaborateur avec audit de version', () => {
    const target = cabinet();
    addMember(target, 'member-collab', 'user-collab', 'collaborator');

    const suspended = target.suspendMember({
      actorUserId: 'user-admin',
      memberId: 'member-collab',
      suspendedAt: '2026-07-12T10:00:00.000Z',
    });
    const restored = target.restoreMember({
      actorUserId: 'user-admin',
      memberId: 'member-collab',
      restoredAt: '2026-07-12T11:00:00.000Z',
    });

    expect(suspended.ok).toBe(true);
    expect(suspended.ok && suspended.value.toSnapshot().suspendedAt).toBe('2026-07-12T10:00:00.000Z');
    expect(restored.ok).toBe(true);
    expect(target.memberById('member-collab')?.status).toBe('active');
    expect(target.version).toBe(4);
  });

  it('autorise la révocation terminale d’un membre suspendu en conservant sa trace', () => {
    const target = cabinet();
    addMember(target, 'member-collab', 'user-collab', 'collaborator');
    target.suspendMember({
      actorUserId: 'user-admin',
      memberId: 'member-collab',
      suspendedAt: '2026-07-12T10:00:00.000Z',
    });

    const revoked = target.revokeMember({
      actorUserId: 'user-admin',
      memberId: 'member-collab',
      revokedAt: '2026-07-12T11:00:00.000Z',
    });

    expect(revoked.ok).toBe(true);
    if (revoked.ok) {
      expect(revoked.value.toSnapshot()).toMatchObject({
        status: 'revoked',
        suspendedAt: '2026-07-12T10:00:00.000Z',
        revokedAt: '2026-07-12T11:00:00.000Z',
      });
    }
  });

  it('couvre les bornes de suspension, restauration et membership inactive', () => {
    const target = cabinet();
    addMember(target, 'member-collab', 'user-collab', 'collaborator');
    expect(target.suspendMember({ actorUserId: 'unknown', memberId: 'member-collab', suspendedAt: NOW }).ok).toBe(false);
    expect(target.suspendMember({ actorUserId: 'user-admin', memberId: 'missing', suspendedAt: NOW }).ok).toBe(false);
    expect(target.restoreMember({ actorUserId: 'unknown', memberId: 'member-collab', restoredAt: NOW }).ok).toBe(false);
    expect(target.restoreMember({ actorUserId: 'user-admin', memberId: 'missing', restoredAt: NOW }).ok).toBe(false);
    expect(target.restoreMember({ actorUserId: 'user-admin', memberId: 'member-collab', restoredAt: NOW }).ok).toBe(false);

    expect(target.suspendMember({ actorUserId: 'user-admin', memberId: 'member-collab', suspendedAt: NOW }).ok).toBe(true);
    expect(target.suspendMember({ actorUserId: 'user-admin', memberId: 'member-collab', suspendedAt: NOW }).ok).toBe(true);
    expect(target.changeMemberRole({
      actorUserId: 'user-admin',
      memberId: 'member-collab',
      role: 'manager',
      changedAt: NOW,
    }).ok).toBe(false);
    expect(target.activeMemberForUser('user-collab')).toBeNull();
    expect(target.actorHasPermission('user-collab', 'cabinet.read')).toBe(false);

    expect(target.revokeMember({ actorUserId: 'user-admin', memberId: 'member-collab', revokedAt: NOW }).ok).toBe(true);
    expect(target.suspendMember({ actorUserId: 'user-admin', memberId: 'member-collab', suspendedAt: NOW }).ok).toBe(false);
    expect(target.memberForUser('user-collab')).toBeNull();
    expect(target.memberById('missing')).toBeNull();
  });

  it('refuse qu’un manager restaure un admin suspendu', () => {
    const target = cabinet();
    addMember(target, 'member-manager', 'user-manager', 'manager');
    const snapshot = target.toSnapshot();
    snapshot.members[0] = {
      ...snapshot.members[0]!,
      status: 'suspended',
      suspendedAt: NOW,
    };
    const suspendedCabinet = Cabinet.rehydrate(snapshot);

    const restored = suspendedCabinet.restoreMember({
      actorUserId: 'user-manager',
      memberId: 'member-admin',
      restoredAt: NOW,
    });

    expect(restored.ok).toBe(false);
  });

  it('ferme les permissions lorsque le cabinet est suspendu', () => {
    const snapshot = cabinet().toSnapshot();
    const suspended = Cabinet.rehydrate({ ...snapshot, status: 'suspended' });

    expect(suspended.actorHasPermission('user-admin', 'cabinet.read')).toBe(false);
    expect(suspended.addMemberFromInvitation({
      memberId: 'member-blocked',
      userId: 'user-blocked',
      role: 'collaborator',
      invitationId: 'invite-blocked',
      joinedAt: NOW,
    }).ok).toBe(false);
    expect(suspended.changeMemberRole({
      actorUserId: 'user-admin',
      memberId: 'member-admin',
      role: 'admin',
      changedAt: NOW,
    }).ok).toBe(false);
    expect(suspended.revokeMember({
      actorUserId: 'user-admin',
      memberId: 'member-admin',
      revokedAt: NOW,
    }).ok).toBe(false);
  });
});

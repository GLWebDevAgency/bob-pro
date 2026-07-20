import { describe, expect, it } from 'vitest';
import {
  CabinetInvitation,
  CabinetInvitationEmail,
  CabinetInvitationTokenHash,
} from './cabinet-invitation';
import { type CabinetRole } from './cabinet-permissions';

const CREATED = '2026-07-12T09:00:00.000Z';
const EXPIRES = '2026-07-15T09:00:00.000Z';

function invitation(): CabinetInvitation {
  const hash = CabinetInvitationTokenHash.of('a'.repeat(64));
  if (!hash.ok) throw new Error('fixture invalid');
  const issued = CabinetInvitation.issue({
    id: 'invite-1',
    cabinetId: 'cab-1',
    email: '  Future.Member@Example.COM ',
    role: 'collaborator',
    tokenHash: hash.value,
    invitedByMemberId: 'member-admin',
    createdAt: CREATED,
    expiresAt: EXPIRES,
  });
  if (!issued.ok) throw new Error('fixture invalid');
  issued.value.pullEvents();
  return issued.value;
}

function validIssue(overrides: Record<string, unknown> = {}) {
  const hash = CabinetInvitationTokenHash.of('a'.repeat(64));
  if (!hash.ok) throw new Error('fixture invalid');
  return CabinetInvitation.issue({
    id: 'invite-validation',
    cabinetId: 'cab-1',
    email: 'member@example.com',
    role: 'collaborator',
    tokenHash: hash.value,
    invitedByMemberId: 'member-admin',
    createdAt: CREATED,
    expiresAt: EXPIRES,
    ...overrides,
  });
}

describe('CabinetInvitation', () => {
  it('normalise l’email et ne persiste que le hash opaque', () => {
    const target = invitation().toSnapshot();

    expect(target.email).toBe('future.member@example.com');
    expect(target.tokenHash).toBe('a'.repeat(64));
    expect(target.status).toBe('pending');
  });

  it('refuse un hash de jeton faible', () => {
    const hash = CabinetInvitationTokenHash.of('token-en-clair');

    expect(hash.ok).toBe(false);
  });

  it('valide strictement email et hash SHA-256 tout en normalisant la casse', () => {
    expect(CabinetInvitationEmail.of('invalid').ok).toBe(false);
    expect(CabinetInvitationEmail.of(`${'a'.repeat(250)}@example.com`).ok).toBe(false);
    const upper = CabinetInvitationTokenHash.of('A'.repeat(64));
    expect(upper.ok && upper.value.value).toBe('a'.repeat(64));
  });

  it.each([
    [{ id: '' }, 'invitationId'],
    [{ cabinetId: '' }, 'cabinetId'],
    [{ invitedByMemberId: '' }, 'invitedByMemberId'],
    [{ email: 'invalid' }, 'email'],
    [{ role: 'owner' as CabinetRole }, 'role'],
    [{ createdAt: 'invalid' }, 'createdAt'],
    [{ expiresAt: 'invalid' }, 'expiresAt'],
    [{ expiresAt: CREATED }, 'expiresAt'],
  ])('rejette une émission invalide %o', (override, field) => {
    const issued = validIssue(override);

    expect(issued.ok).toBe(false);
    if (!issued.ok && issued.error.code === 'VALIDATION') expect(issued.error.field).toBe(field);
  });

  it('refuse de réhydrater des données corrompues', () => {
    const snapshot = invitation().toSnapshot();
    expect(() => CabinetInvitation.rehydrate({ ...snapshot, email: 'bad' })).toThrow();
    expect(() => CabinetInvitation.rehydrate({ ...snapshot, tokenHash: 'bad' })).toThrow();
  });

  it('refuse une session dont l’email vérifié ne correspond pas', () => {
    const target = invitation();
    const accepted = target.accept({
      userId: 'user-2',
      verifiedEmail: 'someone@example.com',
      acceptedAt: '2026-07-13T09:00:00.000Z',
    });

    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.error.code).toBe('CABINET_INVITATION_EMAIL_MISMATCH');
    expect(target.status).toBe('pending');
  });

  it('refuse une invitation expirée, y compris à la borne exacte', () => {
    const target = invitation();
    const accepted = target.accept({
      userId: 'user-2',
      verifiedEmail: 'future.member@example.com',
      acceptedAt: EXPIRES,
    });

    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.error.code).toBe('CABINET_INVITATION_EXPIRED');
    expect(target.effectiveStatus(EXPIRES)).toBe('expired');
  });

  it('accepte une seule fois pour la bonne identité vérifiée', () => {
    const target = invitation();
    const accepted = target.accept({
      userId: 'user-2',
      verifiedEmail: 'FUTURE.MEMBER@example.com',
      acceptedAt: '2026-07-13T09:00:00.000Z',
    });
    const replay = target.accept({
      userId: 'user-2',
      verifiedEmail: 'future.member@example.com',
      acceptedAt: '2026-07-13T09:01:00.000Z',
    });

    expect(accepted.ok).toBe(true);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe('CABINET_INVITATION_ALREADY_USED');
    expect(target.toSnapshot()).toMatchObject({
      status: 'accepted',
      acceptedByUserId: 'user-2',
      version: 2,
    });
  });

  it('refuse une identité vide même avec le bon email', () => {
    const target = invitation();
    const accepted = target.accept({
      userId: '',
      verifiedEmail: 'future.member@example.com',
      acceptedAt: '2026-07-13T09:00:00.000Z',
    });

    expect(accepted.ok).toBe(false);
  });

  it('rend une invitation révoquée définitivement inutilisable', () => {
    const target = invitation();
    const revoked = target.revoke({ actorMemberId: 'member-admin', revokedAt: '2026-07-13T09:00:00.000Z' });
    const accepted = target.accept({
      userId: 'user-2',
      verifiedEmail: 'future.member@example.com',
      acceptedAt: '2026-07-13T10:00:00.000Z',
    });

    expect(revoked.ok).toBe(true);
    expect(accepted.ok).toBe(false);
    expect(target.status).toBe('revoked');
    expect(target.revoke({ actorMemberId: 'member-admin', revokedAt: EXPIRES }).ok).toBe(true);
  });

  it('couvre les transitions terminales et l’expiration explicite', () => {
    const accepted = invitation();
    accepted.accept({
      userId: 'user-2',
      verifiedEmail: 'future.member@example.com',
      acceptedAt: '2026-07-13T09:00:00.000Z',
    });
    expect(accepted.revoke({ actorMemberId: 'member-admin', revokedAt: EXPIRES }).ok).toBe(false);
    expect(accepted.expire(EXPIRES).ok).toBe(false);

    const tooSoon = invitation();
    expect(tooSoon.expire('2026-07-14T09:00:00.000Z').ok).toBe(false);
    expect(tooSoon.revoke({ actorMemberId: '', revokedAt: '2026-07-14T09:00:00.000Z' }).ok).toBe(false);

    const expired = invitation();
    expect(expired.expire(EXPIRES).ok).toBe(true);
    expect(expired.expire(EXPIRES).ok).toBe(true);
    expect(expired.revoke({ actorMemberId: 'member-admin', revokedAt: EXPIRES }).ok).toBe(false);
    expect(expired.accept({ userId: 'user-2', verifiedEmail: 'future.member@example.com', acceptedAt: EXPIRES }).ok).toBe(false);
  });
});

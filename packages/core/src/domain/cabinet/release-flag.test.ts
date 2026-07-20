import { describe, expect, it } from 'vitest';
import {
  ReleaseFlag,
  type ReleaseFlagEnvironment,
  type ReleaseFlagSubjectType,
} from './release-flag';

const NOW = '2026-07-12T09:00:00.000Z';

function flag(): ReleaseFlag {
  const created = ReleaseFlag.create({
    id: 'flag-1',
    key: 'cabinet.slice.0',
    environment: 'production',
    createdAt: NOW,
    createdByUserId: 'platform-admin',
  });
  if (!created.ok) throw new Error('fixture invalid');
  return created.value;
}

describe('ReleaseFlag', () => {
  it('est désactivé par défaut', () => {
    expect(flag().evaluate({ cabinetId: 'cab-1' })).toEqual({
      enabled: false,
      source: 'global',
      flagVersion: 1,
    });
  });

  it('applique la priorité user puis cabinet puis global', () => {
    const target = flag();
    target.setGlobal({ enabled: true, actorUserId: 'platform-admin', changedAt: NOW });
    target.setSubjectOverride({
      subjectType: 'cabinet',
      subjectId: 'cab-1',
      enabled: false,
      actorUserId: 'platform-admin',
      changedAt: NOW,
    });
    target.setSubjectOverride({
      subjectType: 'user',
      subjectId: 'user-1',
      enabled: true,
      actorUserId: 'platform-admin',
      changedAt: NOW,
    });

    expect(target.evaluate({ userId: 'user-1', cabinetId: 'cab-1' }).source).toBe('user');
    expect(target.evaluate({ userId: 'user-2', cabinetId: 'cab-1' })).toMatchObject({ enabled: false, source: 'cabinet' });
    expect(target.evaluate({ cabinetId: 'cab-2' })).toMatchObject({ enabled: true, source: 'global' });
  });

  it('fait primer le kill-switch sur tous les ciblages', () => {
    const target = flag();
    target.setSubjectOverride({
      subjectType: 'cabinet',
      subjectId: 'cab-1',
      enabled: true,
      actorUserId: 'platform-admin',
      changedAt: NOW,
    });
    target.setKillSwitch({ active: true, actorUserId: 'platform-admin', changedAt: NOW });

    expect(target.evaluate({ cabinetId: 'cab-1' })).toMatchObject({ enabled: false, source: 'kill_switch' });
  });

  it.each([
    [{ id: '' }, 'releaseFlagId'],
    [{ key: 'INVALID KEY' }, 'key'],
    [{ key: `a${'.a'.repeat(41)}` }, 'key'],
    [{ environment: 'qa' as ReleaseFlagEnvironment }, 'environment'],
    [{ createdByUserId: '' }, 'createdByUserId'],
  ])('rejette une définition de flag invalide %o', (override, field) => {
    const result = ReleaseFlag.create({
      id: 'flag-validation',
      key: 'cabinet.slice.0',
      environment: 'production',
      createdAt: NOW,
      createdByUserId: 'platform-admin',
      ...override,
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'VALIDATION') expect(result.error.field).toBe(field);
  });

  it('valide no-op, acteur obligatoire et mise à jour des contrôles ops', () => {
    const target = flag();
    expect(target.key).toBe('cabinet.slice.0');
    expect(target.environment).toBe('production');
    expect(target.setGlobal({ enabled: false, actorUserId: '', changedAt: NOW }).ok).toBe(true);
    expect(target.setGlobal({ enabled: true, actorUserId: '', changedAt: NOW }).ok).toBe(false);
    expect(target.setGlobal({ enabled: true, actorUserId: 'ops', changedAt: NOW }).ok).toBe(true);
    expect(target.setKillSwitch({ active: false, actorUserId: '', changedAt: NOW }).ok).toBe(true);
    expect(target.setKillSwitch({ active: true, actorUserId: '', changedAt: NOW }).ok).toBe(false);
    expect(target.setKillSwitch({ active: true, actorUserId: 'ops', changedAt: NOW }).ok).toBe(true);
  });

  it('valide le cycle complet des overrides', () => {
    const target = flag();
    expect(target.setSubjectOverride({
      subjectType: 'team' as ReleaseFlagSubjectType,
      subjectId: 'x',
      enabled: true,
      actorUserId: 'ops',
      changedAt: NOW,
    }).ok).toBe(false);
    expect(target.setSubjectOverride({
      subjectType: 'cabinet',
      subjectId: '',
      enabled: true,
      actorUserId: 'ops',
      changedAt: NOW,
    }).ok).toBe(false);
    expect(target.setSubjectOverride({
      subjectType: 'cabinet',
      subjectId: 'cab-1',
      enabled: true,
      actorUserId: '',
      changedAt: NOW,
    }).ok).toBe(false);
    expect(target.setSubjectOverride({
      subjectType: 'cabinet',
      subjectId: 'cab-1',
      enabled: true,
      actorUserId: 'ops',
      changedAt: NOW,
    }).ok).toBe(true);
    const unchangedVersion = target.version;
    expect(target.setSubjectOverride({
      subjectType: 'cabinet',
      subjectId: 'cab-1',
      enabled: true,
      actorUserId: 'ops',
      changedAt: NOW,
    }).ok).toBe(true);
    expect(target.version).toBe(unchangedVersion);
    expect(target.setSubjectOverride({
      subjectType: 'cabinet',
      subjectId: 'cab-1',
      enabled: false,
      actorUserId: 'ops',
      changedAt: NOW,
    }).ok).toBe(true);
    expect(target.evaluate({ userId: 'unknown', cabinetId: 'cab-1' })).toMatchObject({ enabled: false, source: 'cabinet' });
    expect(target.evaluate({ userId: 'unknown', cabinetId: 'unknown' }).source).toBe('global');

    expect(target.removeSubjectOverride({
      subjectType: 'cabinet',
      subjectId: 'missing',
      actorUserId: '',
      changedAt: NOW,
    }).ok).toBe(true);
    expect(target.removeSubjectOverride({
      subjectType: 'cabinet',
      subjectId: 'cab-1',
      actorUserId: '',
      changedAt: NOW,
    }).ok).toBe(false);
    expect(target.removeSubjectOverride({
      subjectType: 'cabinet',
      subjectId: 'cab-1',
      actorUserId: 'ops',
      changedAt: NOW,
    }).ok).toBe(true);
    expect(target.toSnapshot().subjectOverrides).toEqual([]);
  });
});

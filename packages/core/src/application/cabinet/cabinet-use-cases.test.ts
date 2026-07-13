import { describe, expect, it } from 'vitest';
import { Cabinet, type CabinetSnapshot } from '../../domain/cabinet/cabinet';
import {
  CabinetInvitation,
  CabinetInvitationTokenHash,
  type CabinetInvitationSnapshot,
} from '../../domain/cabinet/cabinet-invitation';
import { ReleaseFlag, type ReleaseFlagSnapshot } from '../../domain/cabinet/release-flag';
import { type CabinetInvitationDispatchPort } from '../ports/cabinet-invitation-dispatch';
import { type CabinetInvitationRepository } from '../ports/cabinet-invitation-repository';
import { type CabinetInvitationTokenPort } from '../ports/cabinet-invitation-token';
import { type CabinetRepository } from '../ports/cabinet-repository';
import { type ReleaseFlagRepository } from '../ports/release-flag-repository';
import { type ClockPort, type IdGeneratorPort, type UnitOfWorkPort } from '../ports/services';
import { AcceptCabinetInvitation } from './accept-cabinet-invitation';
import { cabinetToView } from './cabinet-view';
import { CreateCabinet } from './create-cabinet';
import { EvaluateReleaseFlag } from './evaluate-release-flag';
import { InviteCabinetMember } from './invite-cabinet-member';
import { ChangeCabinetMemberRole, RevokeCabinetMember, SuspendCabinetMember } from './manage-cabinet-member';
import {
  GetCabinet,
  ListCabinetInvitations,
  ListCabinetMembers,
  ListCabinetsForUser,
  ResolveCabinetActor,
} from './query-cabinets';
import { RevokeCabinetInvitation } from './revoke-cabinet-invitation';

const TOKEN_HASH = 'a'.repeat(64);
const OTHER_TOKEN_HASH = 'b'.repeat(64);

class MemoryCabinets implements CabinetRepository {
  readonly snapshots = new Map<string, CabinetSnapshot>();
  failNextSave = false;
  saveOrder: string[];

  constructor(
    private readonly inTransaction: () => boolean,
    saveOrder: string[],
    private readonly lockOrder: string[],
  ) {
    this.saveOrder = saveOrder;
  }

  async findById(id: string): Promise<Cabinet | null> {
    const snapshot = this.snapshots.get(id);
    return snapshot ? Cabinet.rehydrate(structuredClone(snapshot)) : null;
  }

  async lockById(id: string): Promise<Cabinet | null> {
    if (!this.inTransaction()) throw new Error('cabinet lock outside transaction');
    this.lockOrder.push(`cabinet:${id}`);
    return this.findById(id);
  }

  async listByUserId(userId: string): Promise<Cabinet[]> {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.members.some((member) => member.userId === userId && member.status === 'active'))
      .map((snapshot) => Cabinet.rehydrate(structuredClone(snapshot)));
  }

  async save(cabinet: Cabinet, expectedVersion: number | null): Promise<void> {
    if (!this.inTransaction()) throw new Error('cabinet save outside transaction');
    this.saveOrder.push('cabinet');
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('cabinet persistence failure');
    }
    const current = this.snapshots.get(cabinet.id);
    if (expectedVersion === null && current) throw new Error('duplicate cabinet');
    if (expectedVersion !== null && current?.version !== expectedVersion) throw new Error('cabinet version conflict');
    this.snapshots.set(cabinet.id, structuredClone(cabinet.toSnapshot()));
  }
}

class MemoryInvitations implements CabinetInvitationRepository {
  readonly snapshots = new Map<string, CabinetInvitationSnapshot>();
  saveOrder: string[];

  constructor(
    private readonly inTransaction: () => boolean,
    saveOrder: string[],
    private readonly lockOrder: string[],
  ) {
    this.saveOrder = saveOrder;
  }

  async findById(id: string): Promise<CabinetInvitation | null> {
    const snapshot = this.snapshots.get(id);
    return snapshot ? CabinetInvitation.rehydrate(structuredClone(snapshot)) : null;
  }

  async lockById(id: string): Promise<CabinetInvitation | null> {
    if (!this.inTransaction()) throw new Error('invitation lock outside transaction');
    this.lockOrder.push(`invitation:${id}`);
    return this.findById(id);
  }

  async lockByTokenHash(tokenHash: CabinetInvitationTokenHash): Promise<CabinetInvitation | null> {
    if (!this.inTransaction()) throw new Error('token lock outside transaction');
    this.lockOrder.push('invitation:token');
    const snapshot = [...this.snapshots.values()].find((candidate) => candidate.tokenHash === tokenHash.value);
    return snapshot ? CabinetInvitation.rehydrate(structuredClone(snapshot)) : null;
  }

  async lockPendingByCabinetAndEmail(cabinetId: string, normalizedEmail: string): Promise<CabinetInvitation | null> {
    if (!this.inTransaction()) throw new Error('pending invitation lock outside transaction');
    this.lockOrder.push(`invitation:pending:${cabinetId}:${normalizedEmail}`);
    const snapshot = [...this.snapshots.values()].find((candidate) =>
      candidate.cabinetId === cabinetId
      && candidate.email === normalizedEmail
      && candidate.status === 'pending');
    return snapshot ? CabinetInvitation.rehydrate(structuredClone(snapshot)) : null;
  }

  async listByCabinet(cabinetId: string): Promise<CabinetInvitation[]> {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.cabinetId === cabinetId)
      .map((snapshot) => CabinetInvitation.rehydrate(structuredClone(snapshot)));
  }

  async save(invitation: CabinetInvitation, expectedVersion: number | null): Promise<void> {
    if (!this.inTransaction()) throw new Error('invitation save outside transaction');
    this.saveOrder.push('invitation');
    const current = this.snapshots.get(invitation.id);
    if (expectedVersion === null && current) throw new Error('duplicate invitation');
    if (expectedVersion !== null && current?.version !== expectedVersion) throw new Error('invitation version conflict');
    this.snapshots.set(invitation.id, structuredClone(invitation.toSnapshot()));
  }
}

class MemoryFlags implements ReleaseFlagRepository {
  readonly snapshots = new Map<string, ReleaseFlagSnapshot>();
  unavailable = false;

  constructor(private readonly inTransaction: () => boolean) {}

  private mapKey(environment: string, key: string): string {
    return `${environment}:${key}`;
  }

  seed(flag: ReleaseFlag): void {
    const snapshot = flag.toSnapshot();
    this.snapshots.set(this.mapKey(snapshot.environment, snapshot.key), structuredClone(snapshot));
  }

  async findByKey(environment: ReleaseFlagSnapshot['environment'], key: string): Promise<ReleaseFlag | null> {
    if (this.unavailable) throw new Error('flag store unavailable');
    const snapshot = this.snapshots.get(this.mapKey(environment, key));
    return snapshot ? ReleaseFlag.rehydrate(structuredClone(snapshot)) : null;
  }

  async lockByKey(environment: ReleaseFlagSnapshot['environment'], key: string): Promise<ReleaseFlag | null> {
    if (!this.inTransaction()) throw new Error('flag lock outside transaction');
    return this.findByKey(environment, key);
  }

  async save(flag: ReleaseFlag, expectedVersion: number | null): Promise<void> {
    if (!this.inTransaction()) throw new Error('flag save outside transaction');
    const snapshot = flag.toSnapshot();
    const mapKey = this.mapKey(snapshot.environment, snapshot.key);
    const current = this.snapshots.get(mapKey);
    if (expectedVersion === null && current) throw new Error('duplicate flag');
    if (expectedVersion !== null && current?.version !== expectedVersion) throw new Error('flag version conflict');
    this.snapshots.set(mapKey, structuredClone(snapshot));
  }
}

function makeEnv() {
  let inTransaction = false;
  let nextId = 0;
  let now = '2026-07-12T09:00:00.000Z';
  const saveOrder: string[] = [];
  const lockOrder: string[] = [];
  const dispatched: Array<{ invitationId: string; rawToken: string }> = [];
  const cabinets = new MemoryCabinets(() => inTransaction, saveOrder, lockOrder);
  const invitations = new MemoryInvitations(() => inTransaction, saveOrder, lockOrder);
  const flags = new MemoryFlags(() => inTransaction);

  const uow: UnitOfWorkPort = {
    runInTransaction: async <T>(operation: () => Promise<T>): Promise<T> => {
      const cabinetBackup = structuredClone(cabinets.snapshots);
      const invitationBackup = structuredClone(invitations.snapshots);
      const flagBackup = structuredClone(flags.snapshots);
      const dispatchLength = dispatched.length;
      const orderLength = saveOrder.length;
      inTransaction = true;
      try {
        return await operation();
      } catch (error) {
        cabinets.snapshots.clear();
        for (const [key, value] of cabinetBackup) cabinets.snapshots.set(key, value);
        invitations.snapshots.clear();
        for (const [key, value] of invitationBackup) invitations.snapshots.set(key, value);
        flags.snapshots.clear();
        for (const [key, value] of flagBackup) flags.snapshots.set(key, value);
        dispatched.splice(dispatchLength);
        saveOrder.splice(orderLength);
        throw error;
      } finally {
        inTransaction = false;
      }
    },
  };
  const ids: IdGeneratorPort = { newId: () => `id-${++nextId}` };
  const clock: ClockPort = {
    now: () => now,
    today: () => now.slice(0, 10),
  };
  const tokens: CabinetInvitationTokenPort = {
    issue: async () => ({ rawToken: 'secret-token', tokenHash: hash(TOKEN_HASH) }),
    hash: async (rawToken) => hash(rawToken === 'secret-token' ? TOKEN_HASH : OTHER_TOKEN_HASH),
  };
  const dispatch: CabinetInvitationDispatchPort = {
    enqueue: async (input) => {
      if (!inTransaction) throw new Error('dispatch outside transaction');
      dispatched.push({ invitationId: input.invitationId, rawToken: input.rawToken });
    },
  };

  return {
    cabinets,
    invitations,
    flags,
    uow,
    ids,
    clock,
    tokens,
    dispatch,
    dispatched,
    saveOrder,
    lockOrder,
    setNow: (value: string) => { now = value; },
  };
}

function hash(value: string): CabinetInvitationTokenHash {
  const tokenHash = CabinetInvitationTokenHash.of(value);
  if (!tokenHash.ok) throw new Error('fixture hash invalid');
  return tokenHash.value;
}

async function createCabinet(env: ReturnType<typeof makeEnv>) {
  const result = await new CreateCabinet(env).execute({
    name: 'Cabinet Test',
    timeZone: 'Europe/Paris',
    creatorUserId: 'user-admin',
  });
  if (!result.ok) throw new Error('cabinet fixture failed');
  return result.value;
}

async function invite(
  env: ReturnType<typeof makeEnv>,
  input: { actorUserId?: string; email?: string; role?: 'admin' | 'manager' | 'collaborator' } = {},
) {
  const result = await new InviteCabinetMember(env).execute({
    cabinetId: 'id-1',
    actorUserId: input.actorUserId ?? 'user-admin',
    email: input.email ?? 'member@example.com',
    role: input.role ?? 'collaborator',
  });
  return result;
}

describe('cabinet application use cases', () => {
  it('crée le cabinet et le premier admin dans une unité de travail', async () => {
    const env = makeEnv();
    const created = await createCabinet(env);

    expect(created).toMatchObject({ id: 'id-1', actorRole: 'admin', activeMemberCount: 1, version: 1 });
    expect(env.cabinets.snapshots.get('id-1')?.members[0]).toMatchObject({
      id: 'id-2',
      userId: 'user-admin',
      role: 'admin',
    });
  });

  it('émet et enfile une invitation sans exposer le secret dans la vue', async () => {
    const env = makeEnv();
    await createCabinet(env);
    const result = await invite(env, { email: ' Member@Example.COM ' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ email: 'member@example.com', status: 'pending' });
    expect(result.value).not.toHaveProperty('tokenHash');
    expect(result.value).not.toHaveProperty('rawToken');
    expect(env.dispatched).toEqual([{ invitationId: 'id-3', rawToken: 'secret-token' }]);

    const duplicate = await invite(env, { email: 'member@example.com' });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error).toMatchObject({ kind: 'conflict', reason: 'already_pending' });
  });

  it('refuse qu’un manager invite un manager', async () => {
    const env = makeEnv();
    await createCabinet(env);
    await invite(env, { email: 'manager@example.com', role: 'manager' });
    const accepted = await new AcceptCabinetInvitation(env).execute({
      rawToken: 'secret-token',
      authenticatedUserId: 'user-manager',
      verifiedEmail: 'manager@example.com',
    });
    expect(accepted.ok).toBe(true);

    const denied = await invite(env, {
      actorUserId: 'user-manager',
      email: 'second-manager@example.com',
      role: 'manager',
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.kind).toBe('forbidden');
  });

  it('expire sous verrou une ancienne invitation avant de réinviter le même email', async () => {
    const env = makeEnv();
    await createCabinet(env);
    await invite(env);
    env.setNow('2026-07-15T09:00:00.000Z');

    const renewed = await invite(env);

    expect(renewed.ok).toBe(true);
    expect(env.invitations.snapshots.get('id-3')?.status).toBe('expired');
    expect(env.invitations.snapshots.get('id-4')?.status).toBe('pending');
  });

  it('accepte invitation puis ajoute membership dans la même transaction, dans l’ordre RLS requis', async () => {
    const env = makeEnv();
    await createCabinet(env);
    await invite(env);
    env.saveOrder.splice(0);
    env.lockOrder.splice(0);

    const accepted = await new AcceptCabinetInvitation(env).execute({
      rawToken: 'secret-token',
      authenticatedUserId: 'user-member',
      verifiedEmail: 'member@example.com',
    });

    expect(accepted.ok).toBe(true);
    expect(env.saveOrder).toEqual(['invitation', 'cabinet']);
    expect(env.lockOrder).toEqual(['invitation:token', 'cabinet:id-1']);
    expect(env.invitations.snapshots.get('id-3')?.status).toBe('accepted');
    expect(env.cabinets.snapshots.get('id-1')?.members).toHaveLength(2);

    const replay = await new AcceptCabinetInvitation(env).execute({
      rawToken: 'secret-token',
      authenticatedUserId: 'user-member',
      verifiedEmail: 'member@example.com',
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok && replay.error.kind === 'domain') {
      expect(replay.error.error.code).toBe('CABINET_INVITATION_ALREADY_USED');
    }
  });

  it('annule l’acceptation si la persistance de la membership échoue', async () => {
    const env = makeEnv();
    await createCabinet(env);
    await invite(env);
    env.cabinets.failNextSave = true;

    await expect(new AcceptCabinetInvitation(env).execute({
      rawToken: 'secret-token',
      authenticatedUserId: 'user-member',
      verifiedEmail: 'member@example.com',
    })).rejects.toThrow('cabinet persistence failure');

    expect(env.invitations.snapshots.get('id-3')?.status).toBe('pending');
    expect(env.cabinets.snapshots.get('id-1')?.members).toHaveLength(1);
  });

  it('annule sans mutation lorsque l’email vérifié ne correspond pas', async () => {
    const env = makeEnv();
    await createCabinet(env);
    await invite(env);

    const denied = await new AcceptCabinetInvitation(env).execute({
      rawToken: 'secret-token',
      authenticatedUserId: 'user-member',
      verifiedEmail: 'other@example.com',
    });

    expect(denied.ok).toBe(false);
    expect(env.invitations.snapshots.get('id-3')?.status).toBe('pending');
    expect(env.cabinets.snapshots.get('id-1')?.members).toHaveLength(1);
  });

  it('applique les mutations membres et l’invariant du dernier admin via les use cases', async () => {
    const env = makeEnv();
    await createCabinet(env);
    const lastAdmin = await new ChangeCabinetMemberRole(env).execute({
      cabinetId: 'id-1',
      actorUserId: 'user-admin',
      memberId: 'id-2',
      role: 'manager',
    });
    expect(lastAdmin.ok).toBe(false);
    if (!lastAdmin.ok && lastAdmin.error.kind === 'domain') {
      expect(lastAdmin.error.error.code).toBe('CABINET_LAST_ADMIN_REQUIRED');
    }

    await invite(env);
    await new AcceptCabinetInvitation(env).execute({
      rawToken: 'secret-token',
      authenticatedUserId: 'user-collaborator',
      verifiedEmail: 'member@example.com',
    });
    const suspended = await new SuspendCabinetMember(env).execute({
      cabinetId: 'id-1',
      actorUserId: 'user-admin',
      memberId: 'id-4',
    });
    expect(suspended.ok && suspended.value.status).toBe('suspended');
    const revoked = await new RevokeCabinetMember(env).execute({
      cabinetId: 'id-1',
      actorUserId: 'user-admin',
      memberId: 'id-4',
    });
    expect(revoked.ok && revoked.value.status).toBe('revoked');
    expect(revoked.ok && revoked.value.suspendedAt).toBe('2026-07-12T09:00:00.000Z');
  });

  it('résout l’acteur et les listes depuis les memberships actives', async () => {
    const env = makeEnv();
    await createCabinet(env);
    await invite(env);

    const cabinets = await new ListCabinetsForUser(env.cabinets).execute({ userId: 'user-admin' });
    const cabinet = await new GetCabinet(env.cabinets).execute({ cabinetId: 'id-1', actorUserId: 'user-admin' });
    const actor = await new ResolveCabinetActor(env.cabinets).execute({
      cabinetId: 'id-1',
      authenticatedUserId: 'user-admin',
    });
    const members = await new ListCabinetMembers(env.cabinets).execute({ cabinetId: 'id-1', actorUserId: 'user-admin' });
    const invitations = await new ListCabinetInvitations(env).execute({ cabinetId: 'id-1', actorUserId: 'user-admin' });

    expect(cabinets.ok && cabinets.value).toHaveLength(1);
    expect(cabinet.ok && cabinet.value.actorRole).toBe('admin');
    expect(actor.ok && actor.value.permissions).toContain('cabinet.members.manage_privileged');
    expect(members.ok && members.value).toHaveLength(1);
    expect(invitations.ok && invitations.value).toHaveLength(1);
  });

  it('laisse un collaborateur lire le roster sans lui exposer les emails d’invitation', async () => {
    const env = makeEnv();
    await createCabinet(env);
    await invite(env, { email: 'collab@example.com' });
    await new AcceptCabinetInvitation(env).execute({
      rawToken: 'secret-token',
      authenticatedUserId: 'user-collab',
      verifiedEmail: 'collab@example.com',
    });

    const members = await new ListCabinetMembers(env.cabinets).execute({
      cabinetId: 'id-1',
      actorUserId: 'user-collab',
    });
    const invitations = await new ListCabinetInvitations(env).execute({
      cabinetId: 'id-1',
      actorUserId: 'user-collab',
    });

    expect(members.ok && members.value).toHaveLength(2);
    expect(invitations.ok).toBe(false);
    if (!invitations.ok) expect(invitations.error).toMatchObject({
      kind: 'forbidden',
      reason: 'cabinet.members.invite_basic',
    });
  });

  it('révoque une invitation avec l’autorisation de son rôle', async () => {
    const env = makeEnv();
    await createCabinet(env);
    await invite(env);
    env.lockOrder.splice(0);

    const revoked = await new RevokeCabinetInvitation(env).execute({
      cabinetId: 'id-1',
      invitationId: 'id-3',
      actorUserId: 'user-admin',
    });

    expect(revoked.ok && revoked.value.status).toBe('revoked');
    expect(env.lockOrder).toEqual(['invitation:id-3', 'cabinet:id-1']);
    expect(env.invitations.snapshots.get('id-3')?.revokedByMemberId).toBe('id-2');
  });

  it('verrouille aussi une invitation avant son cabinet lors d’une émission', async () => {
    const env = makeEnv();
    await createCabinet(env);
    env.lockOrder.splice(0);

    const invited = await invite(env);

    expect(invited.ok).toBe(true);
    expect(env.lockOrder).toEqual([
      'invitation:pending:id-1:member@example.com',
      'cabinet:id-1',
    ]);
  });

  it('n’expose aucune permission d’action pour un cabinet suspendu', () => {
    const created = Cabinet.create({
      id: 'cabinet-suspended',
      name: 'Cabinet suspendu',
      timeZone: 'Europe/Paris',
      creatorUserId: 'user-admin',
      founderMemberId: 'member-admin',
      createdAt: '2026-07-12T09:00:00.000Z',
    });
    if (!created.ok) throw new Error('cabinet fixture invalid');
    const target = Cabinet.rehydrate({
      ...created.value.toSnapshot(),
      status: 'suspended',
    });

    expect(cabinetToView(target, 'user-admin')).toMatchObject({
      status: 'suspended',
      permissions: [],
    });
  });

  it('évalue les flags en fail-closed sans exposer de mutation aux membres Cabinet', async () => {
    const env = makeEnv();
    await createCabinet(env);
    const flag = ReleaseFlag.create({
      id: 'flag-1',
      key: 'cabinet.slice.0',
      environment: 'production',
      createdAt: env.clock.now(),
      createdByUserId: 'system',
    });
    if (!flag.ok) throw new Error('flag fixture invalid');
    flag.value.setSubjectOverride({
      subjectType: 'cabinet',
      subjectId: 'id-1',
      enabled: true,
      actorUserId: 'platform-operator',
      changedAt: env.clock.now(),
    });
    env.flags.seed(flag.value);

    const enabled = await new EvaluateReleaseFlag(env.flags).execute({
      environment: 'production',
      key: 'cabinet.slice.0',
      cabinetId: 'id-1',
    });
    expect(enabled.ok && enabled.value).toMatchObject({ enabled: true, source: 'cabinet' });

    env.flags.unavailable = true;
    const unavailable = await new EvaluateReleaseFlag(env.flags).execute({
      environment: 'production',
      key: 'cabinet.slice.0',
      cabinetId: 'id-1',
    });
    expect(unavailable.ok && unavailable.value).toEqual({ enabled: false, source: 'unavailable', flagVersion: null });
  });

  it('refuse qu’un manager expire paresseusement une invitation privilégiée échue', async () => {
    const env = makeEnv();
    await createCabinet(env);
    await invite(env, { email: 'manager@example.com', role: 'manager' });
    const accepted = await new AcceptCabinetInvitation(env).execute({
      rawToken: 'secret-token',
      authenticatedUserId: 'user-manager',
      verifiedEmail: 'manager@example.com',
    });
    expect(accepted.ok).toBe(true);
    const privileged = await invite(env, { email: 'x@y.fr', role: 'admin' });
    expect(privileged.ok).toBe(true);
    env.setNow('2026-07-16T09:00:00.000Z'); // > TTL 72 h : l'invitation admin est échue mais pending

    const denied = await invite(env, { actorUserId: 'user-manager', email: 'x@y.fr', role: 'collaborator' });

    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toMatchObject({ kind: 'forbidden', reason: 'cabinet.members.invite' });
    // L'invitation privilégiée n'a pas été mutée par le manager (parité cabinet_invitation_update).
    const pendingAdmin = [...env.invitations.snapshots.values()].find((row) => row.email === 'x@y.fr');
    expect(pendingAdmin?.status).toBe('pending');

    // Un admin, lui, matérialise l'expiration puis réinvite.
    const renewed = await invite(env, { email: 'x@y.fr', role: 'collaborator' });
    expect(renewed.ok).toBe(true);
    const statuses = [...env.invitations.snapshots.values()]
      .filter((row) => row.email === 'x@y.fr')
      .map((row) => row.status)
      .sort();
    expect(statuses).toEqual(['expired', 'pending']);
  });

  it('rend un non-membre incapable de distinguer un cabinet existant d’un cabinet inconnu', async () => {
    const env = makeEnv();
    await createCabinet(env);
    await invite(env);

    // Lectures : même not_found que l'id inconnu (parité RLS, pas d'oracle d'existence).
    const getExisting = await new GetCabinet(env.cabinets).execute({ cabinetId: 'id-1', actorUserId: 'user-outsider' });
    const getMissing = await new GetCabinet(env.cabinets).execute({ cabinetId: 'id-404', actorUserId: 'user-outsider' });
    expect(!getExisting.ok && getExisting.error).toMatchObject({ kind: 'not_found', entity: 'cabinet' });
    expect(!getMissing.ok && getMissing.error).toMatchObject({ kind: 'not_found', entity: 'cabinet' });

    const members = await new ListCabinetMembers(env.cabinets).execute({ cabinetId: 'id-1', actorUserId: 'user-outsider' });
    expect(!members.ok && members.error).toMatchObject({ kind: 'not_found', entity: 'cabinet' });

    const actor = await new ResolveCabinetActor(env.cabinets).execute({
      cabinetId: 'id-1',
      authenticatedUserId: 'user-outsider',
    });
    expect(!actor.ok && actor.error).toMatchObject({ kind: 'not_found', entity: 'cabinet' });

    const invitations = await new ListCabinetInvitations(env).execute({ cabinetId: 'id-1', actorUserId: 'user-outsider' });
    expect(!invitations.ok && invitations.error).toMatchObject({ kind: 'not_found', entity: 'cabinet' });

    // Mutations : l'autorisation de l'acteur passe AVANT l'existence de la cible — un non-membre
    // ne peut pas sonder les memberIds ni les invitationIds.
    const mutateExisting = await new SuspendCabinetMember(env).execute({
      cabinetId: 'id-1',
      actorUserId: 'user-outsider',
      memberId: 'id-2',
    });
    const mutateMissing = await new SuspendCabinetMember(env).execute({
      cabinetId: 'id-1',
      actorUserId: 'user-outsider',
      memberId: 'id-404',
    });
    expect(!mutateExisting.ok && mutateExisting.error).toMatchObject({ kind: 'not_found', entity: 'cabinet' });
    expect(!mutateMissing.ok && mutateMissing.error).toMatchObject({ kind: 'not_found', entity: 'cabinet' });

    const inviteAsOutsider = await invite(env, { actorUserId: 'user-outsider', email: 'probe@example.com' });
    expect(!inviteAsOutsider.ok && inviteAsOutsider.error).toMatchObject({ kind: 'not_found', entity: 'cabinet' });

    const revokeExisting = await new RevokeCabinetInvitation(env).execute({
      cabinetId: 'id-1',
      invitationId: 'id-3',
      actorUserId: 'user-outsider',
    });
    const revokeMissing = await new RevokeCabinetInvitation(env).execute({
      cabinetId: 'id-1',
      invitationId: 'id-404',
      actorUserId: 'user-outsider',
    });
    expect(!revokeExisting.ok && revokeExisting.error).toMatchObject({ kind: 'not_found', entity: 'cabinet_invitation' });
    expect(!revokeMissing.ok && revokeMissing.error).toMatchObject({ kind: 'not_found', entity: 'cabinet_invitation' });

    // Un membre actif sans la permission fine reste un forbidden : le 404 ne masque que
    // l'existence, pas la matrice RBAC.
    await new AcceptCabinetInvitation(env).execute({
      rawToken: 'secret-token',
      authenticatedUserId: 'user-collab',
      verifiedEmail: 'member@example.com',
    });
    const collabInvitations = await new ListCabinetInvitations(env).execute({
      cabinetId: 'id-1',
      actorUserId: 'user-collab',
    });
    expect(!collabInvitations.ok && collabInvitations.error).toMatchObject({
      kind: 'forbidden',
      reason: 'cabinet.members.invite_basic',
    });
  });
});

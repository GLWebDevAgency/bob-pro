import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  Cabinet,
  CabinetInvitation,
  ReleaseFlag,
  type CabinetInvitationDispatch,
  type CabinetInvitationRepository,
  type CabinetInvitationSnapshot,
  type CabinetInvitationTokenHash,
  type CabinetRepository,
  type CabinetSnapshot,
  type ReleaseFlagRepository,
  type ReleaseFlagSnapshot,
} from '@bob/core';
import { isDemoMode } from '../config/env';
import {
  CabinetOptimisticConflictError,
  CabinetPersistenceConflictError,
  type CabinetInfrastructure,
  type CabinetInvitationPage,
  type CabinetInvitationDeliveryStatus,
  type CabinetInvitationDeliveryView,
} from './cabinet-infrastructure';
import { CabinetInvitationTokenAdapter, CabinetInvitationTokenCipher } from './cabinet-token';
import type { CabinetDossierRepository } from './dossiers/cabinet-dossier-repository';

interface MemoryDelivery extends Omit<CabinetInvitationDeliveryView, 'encryptedToken'> {
  createdAt: string;
  encryptedToken: CabinetInvitationDeliveryView['encryptedToken'] | null;
  lockedAt: string | null;
  leaseUntil: string | null;
  lastError: string | null;
  sentAt: string | null;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const unavailableDossiers: CabinetDossierRepository = {
  listSummaries: async () => { throw new Error('Cabinet dossier test repository is not configured.'); },
  findBySiren: async () => { throw new Error('Cabinet dossier test repository is not configured.'); },
  create: async () => { throw new Error('Cabinet dossier test repository is not configured.'); },
  replace: async () => { throw new Error('Cabinet dossier test repository is not configured.'); },
  delete: async () => { throw new Error('Cabinet dossier test repository is not configured.'); },
};

class MemoryCabinetRepository implements CabinetRepository {
  constructor(private readonly rows: Map<string, CabinetSnapshot>) {}

  async findById(id: string): Promise<Cabinet | null> {
    const row = this.rows.get(id);
    return row ? Cabinet.rehydrate(clone(row)) : null;
  }

  lockById(id: string): Promise<Cabinet | null> {
    return this.findById(id);
  }

  async listByUserId(userId: string): Promise<Cabinet[]> {
    return [...this.rows.values()]
      .filter((row) => row.members.some((member) => member.userId === userId && member.status === 'active'))
      .map((row) => Cabinet.rehydrate(clone(row)));
  }

  async save(cabinet: Cabinet, expectedVersion: number | null): Promise<void> {
    const current = this.rows.get(cabinet.id);
    if (expectedVersion === null) {
      if (current) throw new CabinetPersistenceConflictError('cabinet_already_exists');
    } else if (!current || current.version !== expectedVersion) {
      throw new CabinetOptimisticConflictError('cabinet');
    }
    const snapshot = cabinet.toSnapshot();
    if (snapshot.members.length > 500) {
      throw new CabinetPersistenceConflictError('cabinet_member_quota_reached');
    }
    this.rows.set(cabinet.id, clone(snapshot));
    cabinet.pullEvents();
  }
}

class MemoryInvitationRepository implements CabinetInvitationRepository {
  constructor(
    private readonly rows: Map<string, CabinetInvitationSnapshot>,
    private readonly onTerminal: (invitationId: string, at: string) => void,
  ) {}

  async findById(id: string): Promise<CabinetInvitation | null> {
    const row = this.rows.get(id);
    return row ? CabinetInvitation.rehydrate(clone(row)) : null;
  }

  lockById(id: string): Promise<CabinetInvitation | null> {
    return this.findById(id);
  }

  async lockByTokenHash(tokenHash: CabinetInvitationTokenHash): Promise<CabinetInvitation | null> {
    const row = [...this.rows.values()].find((candidate) => candidate.tokenHash === tokenHash.value);
    return row ? CabinetInvitation.rehydrate(clone(row)) : null;
  }

  async lockPendingByCabinetAndEmail(
    cabinetId: string,
    normalizedEmail: string,
  ): Promise<CabinetInvitation | null> {
    const row = [...this.rows.values()].find(
      (candidate) =>
        candidate.cabinetId === cabinetId &&
        candidate.email === normalizedEmail &&
        candidate.status === 'pending',
    );
    return row ? CabinetInvitation.rehydrate(clone(row)) : null;
  }

  async listByCabinet(cabinetId: string): Promise<CabinetInvitation[]> {
    const rows = [...this.rows.values()]
      .filter((row) => row.cabinetId === cabinetId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 201);
    return rows.map((row) => CabinetInvitation.rehydrate(clone(row)));
  }

  async save(invitation: CabinetInvitation, expectedVersion: number | null): Promise<void> {
    const current = this.rows.get(invitation.id);
    const snapshot = invitation.toSnapshot();
    if (expectedVersion === null) {
      const duplicate = [...this.rows.values()].some(
        (row) =>
          row.cabinetId === snapshot.cabinetId &&
          row.email === snapshot.email &&
          row.status === 'pending',
      );
      if (current || duplicate) throw new CabinetPersistenceConflictError('invitation_already_pending');
    } else if (!current || current.version !== expectedVersion) {
      throw new CabinetOptimisticConflictError('cabinet_invitation');
    }
    this.rows.set(invitation.id, clone(snapshot));
    if (current?.status === 'pending' && ['accepted', 'expired', 'revoked'].includes(snapshot.status)) {
      this.onTerminal(snapshot.id, snapshot.acceptedAt ?? snapshot.revokedAt ?? new Date().toISOString());
    }
    invitation.pullEvents();
  }
}

class MemoryReleaseFlagRepository implements ReleaseFlagRepository {
  constructor(private readonly rows: Map<string, ReleaseFlagSnapshot>) {}

  async findByKey(environment: ReleaseFlagSnapshot['environment'], key: string): Promise<ReleaseFlag | null> {
    const row = [...this.rows.values()].find((candidate) => candidate.environment === environment && candidate.key === key);
    return row ? ReleaseFlag.rehydrate(clone(row)) : null;
  }

  lockByKey(environment: ReleaseFlagSnapshot['environment'], key: string): Promise<ReleaseFlag | null> {
    return this.findByKey(environment, key);
  }

  async save(flag: ReleaseFlag, expectedVersion: number | null): Promise<void> {
    const current = this.rows.get(flag.id);
    if (expectedVersion === null) {
      if (current) throw new CabinetPersistenceConflictError('release_flag_already_exists');
    } else if (!current || current.version !== expectedVersion) {
      throw new CabinetOptimisticConflictError('release_flag');
    }
    this.rows.set(flag.id, clone(flag.toSnapshot()));
    flag.pullEvents();
  }
}

export class MemoryCabinetInfrastructure implements CabinetInfrastructure {
  private readonly cabinetRows = new Map<string, CabinetSnapshot>();
  private readonly invitationRows = new Map<string, CabinetInvitationSnapshot>();
  private readonly flagRows = new Map<string, ReleaseFlagSnapshot>();
  private readonly deliveryRows = new Map<string, MemoryDelivery>();
  private readonly cipher = new CabinetInvitationTokenCipher();
  /** Équivalent in-memory du double GUC RLS (app.current_user_id + app.current_cabinet_id). */
  private readonly cabinetContext = new AsyncLocalStorage<{ userId: string; cabinetId: string }>();

  readonly cabinets = new MemoryCabinetRepository(this.cabinetRows);
  readonly dossiers = unavailableDossiers;
  readonly invitations: MemoryInvitationRepository;
  readonly invitationQueries = {
    listPendingPage: async (input: {
      cabinetId: string;
      cursor?: string;
      limit: number;
    }): Promise<CabinetInvitationPage> => {
      const limit = Math.max(1, Math.min(input.limit, 100));
      const allCabinetRows = [...this.invitationRows.values()]
        .filter((row) => row.cabinetId === input.cabinetId);
      const cursor = input.cursor ? allCabinetRows.find((row) => row.id === input.cursor) : undefined;
      if (input.cursor && !cursor) return { items: [], nextCursor: null };
      const rows = allCabinetRows
        .filter((row) => row.status === 'pending')
        .filter(
          (row) =>
            !cursor ||
            row.createdAt < cursor.createdAt ||
            (row.createdAt === cursor.createdAt && row.id < cursor.id),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const pageRows = rows.slice(0, limit);
      return {
        items: pageRows.map((row) => CabinetInvitation.rehydrate(clone(row))),
        nextCursor: rows.length > limit ? (pageRows.at(-1)?.id ?? null) : null,
      };
    },
    listExpiredPendingIds: async (input: { cabinetId: string; now: string; limit: number }): Promise<string[]> =>
      [...this.invitationRows.values()]
        .filter(
          (row) =>
            row.cabinetId === input.cabinetId &&
            row.status === 'pending' &&
            row.expiresAt <= input.now,
        )
        .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt) || a.id.localeCompare(b.id))
        .slice(0, Math.max(1, Math.min(input.limit, 100)))
        .map((row) => row.id),
  };
  readonly flags = new MemoryReleaseFlagRepository(this.flagRows);
  readonly tokens = new CabinetInvitationTokenAdapter();

  readonly dispatch = {
    enqueue: async (input: CabinetInvitationDispatch): Promise<void> => {
      const duplicate = [...this.deliveryRows.values()].find((row) => row.invitationId === input.invitationId);
      if (duplicate) return;
      const encryptedToken = this.cipher.encrypt(input.invitationId, input.rawToken);
      const now = new Date().toISOString();
      const row: MemoryDelivery = {
        id: randomUUID(),
        cabinetId: input.cabinetId,
        invitationId: input.invitationId,
        email: input.email,
        cabinetName: input.cabinetName,
        role: input.role,
        expiresAt: input.expiresAt,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        encryptedToken,
        lockedAt: null,
        leaseUntil: null,
        lastError: null,
        sentAt: null,
      };
      this.deliveryRows.set(row.id, row);
    },
  };

  readonly deliveries = {
    claimNext: async (input: {
      cabinetId: string;
      now: string;
      leaseUntil: string;
      allowedInvitationRoles: ReadonlyArray<'admin' | 'manager' | 'collaborator'>;
    }): Promise<CabinetInvitationDeliveryView | null> => {
      const row = [...this.deliveryRows.values()]
        .filter((candidate) => candidate.cabinetId === input.cabinetId && candidate.nextAttemptAt <= input.now)
        .filter((candidate) => this.invitationRows.get(candidate.invitationId)?.status === 'pending')
        .filter((candidate) => input.allowedInvitationRoles.includes(candidate.role))
        .filter((candidate) => candidate.expiresAt > input.now)
        .filter((candidate) => this.canManageDelivery(candidate))
        .filter(
          (candidate) =>
            candidate.status === 'pending' ||
            candidate.status === 'failed' ||
            (candidate.status === 'sending' && (candidate.leaseUntil ?? '') <= input.now),
        )
        .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt))[0];
      if (!row) return null;
      if (!row.encryptedToken) throw new Error('Cabinet invitation delivery has no encrypted token.');
      const claimed: MemoryDelivery = {
        ...row,
        status: 'sending',
        attempts: row.attempts + 1,
        lockedAt: input.now,
        leaseUntil: input.leaseUntil,
        lastError: null,
      };
      this.deliveryRows.set(row.id, claimed);
      return clone(claimed) as CabinetInvitationDeliveryView;
    },
    claimForInvitation: async (input: {
      cabinetId: string;
      invitationId: string;
      now: string;
      leaseUntil: string;
      allowedInvitationRoles: ReadonlyArray<'admin' | 'manager' | 'collaborator'>;
    }): Promise<CabinetInvitationDeliveryView | null> => {
      const row = [...this.deliveryRows.values()]
        .filter(
          (candidate) =>
            candidate.cabinetId === input.cabinetId &&
            candidate.invitationId === input.invitationId &&
            this.invitationRows.get(candidate.invitationId)?.status === 'pending' &&
            input.allowedInvitationRoles.includes(candidate.role) &&
            candidate.nextAttemptAt <= input.now &&
            candidate.expiresAt > input.now &&
            this.canManageDelivery(candidate),
        )
        .find(
          (candidate) =>
            candidate.status === 'pending' ||
            candidate.status === 'failed' ||
            (candidate.status === 'sending' && (candidate.leaseUntil ?? '') <= input.now),
        );
      if (!row) return null;
      if (!row.encryptedToken) throw new Error('Cabinet invitation delivery has no encrypted token.');
      const claimed: MemoryDelivery = {
        ...row,
        status: 'sending',
        attempts: row.attempts + 1,
        lockedAt: input.now,
        leaseUntil: input.leaseUntil,
        lastError: null,
      };
      this.deliveryRows.set(row.id, claimed);
      return clone(claimed) as CabinetInvitationDeliveryView;
    },
    markDone: async (input: { id: string; expectedAttempts: number; sentAt: string }): Promise<void> => {
      const row = this.deliveryRows.get(input.id);
      if (!row || row.status !== 'sending' || row.attempts !== input.expectedAttempts) {
        throw new CabinetPersistenceConflictError('delivery_not_sending');
      }
      this.deliveryRows.set(row.id, {
        ...row,
        status: 'done',
        lockedAt: null,
        leaseUntil: null,
        sentAt: input.sentAt,
        encryptedToken: null,
      });
    },
    markFailed: async (input: { id: string; expectedAttempts: number; failedAt: string; nextAttemptAt: string; error: string }): Promise<void> => {
      const row = this.deliveryRows.get(input.id);
      if (!row || row.status !== 'sending' || row.attempts !== input.expectedAttempts) {
        throw new CabinetPersistenceConflictError('delivery_not_sending');
      }
      this.deliveryRows.set(row.id, {
        ...row,
        status: 'failed',
        nextAttemptAt: input.nextAttemptAt,
        lockedAt: null,
        leaseUntil: null,
        lastError: input.error.slice(0, 2_000),
      });
    },
    cancelForInvitation: async (input: { invitationId: string; cancelledAt: string }): Promise<void> => {
      for (const row of this.deliveryRows.values()) {
        if (row.invitationId !== input.invitationId || !['pending', 'failed', 'sending'].includes(row.status)) continue;
        this.deliveryRows.set(row.id, {
          ...row,
          status: 'cancelled',
          nextAttemptAt: input.cancelledAt,
          lockedAt: null,
          leaseUntil: null,
          lastError: null,
          sentAt: null,
          encryptedToken: null,
        });
      }
    },
    statusForInvitation: async (invitationId: string): Promise<CabinetInvitationDeliveryStatus | null> =>
      [...this.deliveryRows.values()].find((row) => row.invitationId === invitationId)?.status ?? null,
    oldestEncryptedCreatedAt: async (cabinetId: string): Promise<string | null> => {
      const oldest = [...this.deliveryRows.values()]
        .filter(
          (row) =>
            row.cabinetId === cabinetId &&
            ['pending', 'failed', 'sending'].includes(row.status) &&
            row.encryptedToken !== null,
        )
        .map((row) => row.createdAt)
        .sort()[0];
      return oldest ?? null;
    },
  };

  constructor() {
    this.invitations = new MemoryInvitationRepository(this.invitationRows, (invitationId, at) => {
      for (const row of this.deliveryRows.values()) {
        if (row.invitationId !== invitationId || !['pending', 'failed', 'sending'].includes(row.status)) continue;
        this.deliveryRows.set(row.id, {
          ...row,
          status: 'cancelled',
          nextAttemptAt: at,
          lockedAt: null,
          leaseUntil: null,
          lastError: null,
          sentAt: null,
          encryptedToken: null,
        });
      }
    });
    const now = new Date().toISOString();
    const created = ReleaseFlag.create({
      id: 'cabinet-slice0-development',
      key: 'cabinet.slice0',
      environment: 'development',
      createdAt: now,
      createdByUserId: 'system:demo',
    });
    if (!created.ok) throw new Error('Cannot seed the cabinet.slice0 demo release flag.');
    if (isDemoMode()) {
      const changed = created.value.setGlobal({ enabled: true, actorUserId: 'system:demo', changedAt: now });
      if (!changed.ok) throw new Error('Cannot enable the cabinet.slice0 demo release flag.');
    }
    this.flagRows.set(created.value.id, created.value.toSnapshot());
    created.value.pullEvents();
  }

  decryptInvitationToken(delivery: CabinetInvitationDeliveryView): string {
    return this.cipher.decrypt(delivery.invitationId, delivery.encryptedToken);
  }

  /** Posé par InMemoryPersistence.runWithCabinet — miroir des SET LOCAL RLS par transaction. */
  runWithCabinetContext<T>(userId: string, cabinetId: string, fn: () => Promise<T>): Promise<T> {
    return this.cabinetContext.run({ userId, cabinetId }, fn);
  }

  /**
   * Miroir in-memory de la fonction SQL app_can_manage_invitation_delivery : l'acteur du contexte
   * doit être une membership active d'un cabinet actif, l'invitation pending, et un manager ne
   * gère que les livraisons d'invitations collaborator. Sans contexte, aucune capacité (fail-closed,
   * comme la RLS sans GUC). Un retry manager ne peut donc jamais faire partir une invitation
   * admin/manager, en démo comme en prod.
   */
  private canManageDelivery(row: MemoryDelivery): boolean {
    const context = this.cabinetContext.getStore();
    if (!context || context.cabinetId !== row.cabinetId) return false;
    const cabinet = this.cabinetRows.get(row.cabinetId);
    const invitation = this.invitationRows.get(row.invitationId);
    if (!cabinet || cabinet.status !== 'active' || invitation?.status !== 'pending') return false;
    const actor = cabinet.members.find(
      (member) => member.userId === context.userId && member.status === 'active',
    );
    if (!actor) return false;
    return actor.role === 'admin' || (actor.role === 'manager' && invitation.role === 'collaborator');
  }

  snapshot(): unknown {
    return {
      cabinets: clone([...this.cabinetRows.entries()]),
      invitations: clone([...this.invitationRows.entries()]),
      flags: clone([...this.flagRows.entries()]),
      deliveries: clone([...this.deliveryRows.entries()]),
    };
  }

  restore(snapshot: unknown): void {
    const state = snapshot as {
      cabinets: [string, CabinetSnapshot][];
      invitations: [string, CabinetInvitationSnapshot][];
      flags: [string, ReleaseFlagSnapshot][];
      deliveries: [string, MemoryDelivery][];
    };
    this.replace(this.cabinetRows, state.cabinets);
    this.replace(this.invitationRows, state.invitations);
    this.replace(this.flagRows, state.flags);
    this.replace(this.deliveryRows, state.deliveries);
  }

  private replace<K, V>(target: Map<K, V>, entries: [K, V][]): void {
    target.clear();
    for (const [key, value] of clone(entries)) target.set(key, value);
  }
}

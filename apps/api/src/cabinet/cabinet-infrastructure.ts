import type {
  CabinetInvitation,
  CabinetInvitationDispatchPort,
  CabinetInvitationRepository,
  CabinetInvitationTokenPort,
  CabinetRepository,
  ReleaseFlagRepository,
} from '@bob/core';

export interface CabinetInvitationPage {
  items: CabinetInvitation[];
  nextCursor: string | null;
}

export interface CabinetInvitationQueryStore {
  /** Liste uniquement les invitations encore pending ; le curseur est opaque pour le client. */
  listPendingPage(input: {
    cabinetId: string;
    cursor?: string;
    limit: number;
  }): Promise<CabinetInvitationPage>;
  /** Requête worker bornée : elle ne charge jamais tout l'historique des invitations. */
  listExpiredPendingIds(input: { cabinetId: string; now: string; limit: number }): Promise<string[]>;
}

export type CabinetInvitationDeliveryStatus = 'pending' | 'sending' | 'done' | 'failed' | 'cancelled';

export interface CabinetInvitationDeliveryView {
  id: string;
  cabinetId: string;
  invitationId: string;
  email: string;
  cabinetName: string;
  role: 'admin' | 'manager' | 'collaborator';
  expiresAt: string;
  status: CabinetInvitationDeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  encryptedToken: {
    ciphertext: string;
    iv: string;
    authTag: string;
    keyVersion: number;
  };
}

export interface CabinetInvitationDeliveryStore {
  claimNext(input: {
    cabinetId: string;
    now: string;
    leaseUntil: string;
    allowedInvitationRoles: ReadonlyArray<'admin' | 'manager' | 'collaborator'>;
  }): Promise<CabinetInvitationDeliveryView | null>;
  claimForInvitation(input: {
    cabinetId: string;
    invitationId: string;
    now: string;
    leaseUntil: string;
    allowedInvitationRoles: ReadonlyArray<'admin' | 'manager' | 'collaborator'>;
  }): Promise<CabinetInvitationDeliveryView | null>;
  markDone(input: { id: string; expectedAttempts: number; sentAt: string }): Promise<void>;
  markFailed(input: { id: string; expectedAttempts: number; failedAt: string; nextAttemptAt: string; error: string }): Promise<void>;
  cancelForInvitation(input: { invitationId: string; cancelledAt: string }): Promise<void>;
  statusForInvitation(invitationId: string): Promise<CabinetInvitationDeliveryStatus | null>;
  oldestEncryptedCreatedAt(cabinetId: string): Promise<string | null>;
}

export interface CabinetInfrastructure {
  cabinets: CabinetRepository;
  invitations: CabinetInvitationRepository;
  flags: ReleaseFlagRepository;
  invitationQueries: CabinetInvitationQueryStore;
  tokens: CabinetInvitationTokenPort;
  dispatch: CabinetInvitationDispatchPort;
  deliveries: CabinetInvitationDeliveryStore;
  decryptInvitationToken(delivery: CabinetInvitationDeliveryView): string;
  /** Uniquement pour rendre l'unité de travail in-memory réellement annulable. */
  snapshot?(): unknown;
  restore?(snapshot: unknown): void;
}

export class CabinetOptimisticConflictError extends Error {
  constructor(readonly entity: 'cabinet' | 'cabinet_member' | 'cabinet_invitation' | 'release_flag') {
    super(`Optimistic conflict on ${entity}.`);
  }
}

export class CabinetPersistenceConflictError extends Error {
  constructor(readonly reason: string) {
    super(`Cabinet persistence conflict: ${reason}.`);
  }
}

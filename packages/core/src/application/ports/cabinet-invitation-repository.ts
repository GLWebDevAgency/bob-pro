import {
  type CabinetInvitation,
  type CabinetInvitationTokenHash,
} from '../../domain/cabinet/cabinet-invitation';

export interface CabinetInvitationRepository {
  findById(id: string): Promise<CabinetInvitation | null>;
  lockById(id: string): Promise<CabinetInvitation | null>;
  lockByTokenHash(tokenHash: CabinetInvitationTokenHash): Promise<CabinetInvitation | null>;
  /** Verrouille la ligne persistée status=pending, même si son expiresAt est dépassé. */
  lockPendingByCabinetAndEmail(cabinetId: string, normalizedEmail: string): Promise<CabinetInvitation | null>;
  listByCabinet(cabinetId: string): Promise<CabinetInvitation[]>;
  save(invitation: CabinetInvitation, expectedVersion: number | null): Promise<void>;
}

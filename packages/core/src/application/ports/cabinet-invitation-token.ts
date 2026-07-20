import { type CabinetInvitationTokenHash } from '../../domain/cabinet/cabinet-invitation';

export interface IssuedCabinetInvitationToken {
  /** Secret à masquer dans tous les logs et à transmettre uniquement au canal d'invitation. */
  rawToken: string;
  tokenHash: CabinetInvitationTokenHash;
}

/** Génération cryptographique et SHA-256 restent des responsabilités d'infrastructure. */
export interface CabinetInvitationTokenPort {
  issue(): Promise<IssuedCabinetInvitationToken>;
  hash(rawToken: string): Promise<CabinetInvitationTokenHash>;
}

import { type CabinetRole } from '../../domain/cabinet/cabinet-permissions';
import { type Instant } from '../../shared-kernel/time';

export interface CabinetInvitationDispatch {
  invitationId: string;
  cabinetId: string;
  cabinetName: string;
  email: string;
  role: CabinetRole;
  expiresAt: Instant;
  /** Secret sensible : l'adapter outbox doit le chiffrer/masquer puis le purger après livraison. */
  rawToken: string;
}

export interface CabinetInvitationDispatchPort {
  /** Doit rejoindre l'outbox dans la transaction courante pour éviter une invitation non livrable. */
  enqueue(input: CabinetInvitationDispatch): Promise<void>;
}

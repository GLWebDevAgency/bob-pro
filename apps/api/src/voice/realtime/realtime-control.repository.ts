import type {
  RealtimeControlBinding,
  RealtimeSealedControl,
} from './realtime-control-seal';

export interface RealtimeControlOwnerFence {
  readonly subjectHash: string;
  readonly sidebandOwnerEpoch: number;
  readonly sidebandOwnerTokenHash: string;
}

export interface RealtimeControlGrantIssueInput
  extends RealtimeControlBinding, RealtimeControlOwnerFence, RealtimeSealedControl {
  /** UUID candidat. Un conflit exact est idempotent grâce au HMAC stable du payload. */
  readonly grantId: string;
  /** Maximum applicatif ; PostgreSQL le recoupe avec ses trois expiries de bail. */
  readonly maxTtlSeconds: number;
  /** L'expiration métier d'une proposition reste plus restrictive que celle du grant. */
  readonly proposalExpiresAt: string | null;
}

export type RealtimeControlGrantIssueResult =
  | { readonly status: 'issued' | 'already_issued'; readonly grantId: string }
  | { readonly status: 'not_found' | 'expired' | 'conflict' | 'unavailable' };

/**
 * Projection chiffrée d'un contrôle potentiellement consommable.
 *
 * Elle ne contient aucun payload lisible. `databaseNow` est l'unique horloge passée au déchiffreur
 * afin qu'une horloge de pod décalée ne puisse ni prolonger ni invalider une proposition.
 */
export interface RealtimeConsumableControlGrant
  extends RealtimeControlBinding, RealtimeControlOwnerFence, RealtimeSealedControl {
  readonly grantId: string;
  readonly acknowledgementId: string;
  readonly databaseNow: Date;
}

export type RealtimeControlGrantReadResult =
  | { readonly status: 'eligible'; readonly grant: RealtimeConsumableControlGrant }
  | { readonly status: 'not_found' | 'conflict' | 'unavailable' };

export interface RealtimeControlGrantReadInput {
  readonly companyId: string;
  readonly subjectHash: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly acknowledgementId: string;
  readonly contextRevision: number;
  readonly contextDigest: string;
}

export interface RealtimeControlGrantConsumeInput extends RealtimeControlGrantReadInput {
  readonly grantId: string;
  readonly artifactId: string;
  readonly sidebandOwnerEpoch: number;
  readonly sidebandOwnerTokenHash: string;
  readonly controlPayloadHmac: string;
}

export type RealtimeControlGrantConsumeResult =
  | { readonly status: 'consumed'; readonly idempotent: boolean }
  | { readonly status: 'not_found' | 'conflict' | 'unavailable' };

/** Port transactionnel : aucun objet Prisma ni détail provider ne traverse cette frontière. */
export interface RealtimeControlRepositoryPort {
  issue(input: RealtimeControlGrantIssueInput): Promise<RealtimeControlGrantIssueResult>;
  readConsumable(input: RealtimeControlGrantReadInput): Promise<RealtimeControlGrantReadResult>;
  consume(input: RealtimeControlGrantConsumeInput): Promise<RealtimeControlGrantConsumeResult>;
}

/** Le mode local ne simule jamais une autorité de contrôle vocal. */
export class DisabledRealtimeControlRepository implements RealtimeControlRepositoryPort {
  async issue(): Promise<RealtimeControlGrantIssueResult> {
    return { status: 'unavailable' };
  }

  async readConsumable(): Promise<RealtimeControlGrantReadResult> {
    return { status: 'unavailable' };
  }

  async consume(): Promise<RealtimeControlGrantConsumeResult> {
    return { status: 'unavailable' };
  }
}

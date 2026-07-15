const SHA256_HEX = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMPANY_ID = /^[A-Za-z0-9-]{1,64}$/u;
const POSTGRES_INT_MAX = 2_147_483_647;

export interface RealtimeSidebandContextVersion {
  readonly revision: number;
  readonly digest: string;
}

export interface RealtimeSidebandOwnerIdentity {
  readonly companyId: string;
  readonly subjectHash: string;
  readonly sessionId: string;
  readonly ownerInstanceHash: string;
  readonly ownerTokenHash: string;
  readonly ownerEpoch: number;
}

export interface RealtimeSidebandOwnerAcquireInput {
  readonly companyId: string;
  readonly sessionId: string;
  readonly ownerInstanceHash: string;
  readonly candidateOwnerTokenHash: string;
  readonly leaseSeconds: number;
}

export type RealtimeSidebandOwnerAcquireResult =
  | {
      readonly status: 'acquired';
      readonly owner: RealtimeSidebandOwnerIdentity;
      readonly currentContext: RealtimeSidebandContextVersion | null;
      readonly leaseExpiresAt: string;
    }
  | { readonly status: 'busy' | 'rejected' | 'unavailable' };

export type RealtimeSidebandOwnerMutationResult =
  | { readonly status: 'applied' | 'renewed' | 'released'; readonly leaseExpiresAt?: string }
  | { readonly status: 'lost' | 'stale_context' | 'rejected' | 'unavailable' };

export type RealtimeSidebandOwnerContextResult =
  | { readonly status: 'current'; readonly context: RealtimeSidebandContextVersion }
  | { readonly status: 'lost' | 'unavailable' };

export interface RealtimeSidebandOwnerPort {
  acquire(input: RealtimeSidebandOwnerAcquireInput): Promise<RealtimeSidebandOwnerAcquireResult>;
  renew(
    owner: RealtimeSidebandOwnerIdentity,
    leaseSeconds: number,
  ): Promise<RealtimeSidebandOwnerMutationResult>;
  applyContext(
    owner: RealtimeSidebandOwnerIdentity,
    context: RealtimeSidebandContextVersion,
  ): Promise<RealtimeSidebandOwnerMutationResult>;
  readCurrentContext(owner: RealtimeSidebandOwnerIdentity): Promise<RealtimeSidebandOwnerContextResult>;
  release(owner: RealtimeSidebandOwnerIdentity): Promise<RealtimeSidebandOwnerMutationResult>;
}

export function isRealtimeSidebandContextVersion(
  value: RealtimeSidebandContextVersion,
): boolean {
  return Number.isSafeInteger(value.revision)
    && value.revision >= 1
    && value.revision <= POSTGRES_INT_MAX
    && SHA256_HEX.test(value.digest);
}

export function isRealtimeSidebandOwnerIdentity(
  value: RealtimeSidebandOwnerIdentity,
): boolean {
  return COMPANY_ID.test(value.companyId)
    && SHA256_HEX.test(value.subjectHash)
    && UUID.test(value.sessionId)
    && SHA256_HEX.test(value.ownerInstanceHash)
    && SHA256_HEX.test(value.ownerTokenHash)
    && Number.isSafeInteger(value.ownerEpoch)
    && value.ownerEpoch >= 1
    && value.ownerEpoch <= POSTGRES_INT_MAX;
}

export function isRealtimeSidebandOwnerAcquireInput(
  value: RealtimeSidebandOwnerAcquireInput,
): boolean {
  return COMPANY_ID.test(value.companyId)
    && UUID.test(value.sessionId)
    && SHA256_HEX.test(value.ownerInstanceHash)
    && SHA256_HEX.test(value.candidateOwnerTokenHash)
    && Number.isSafeInteger(value.leaseSeconds)
    && value.leaseSeconds >= 5
    && value.leaseSeconds <= 300;
}

/** Valeur locale/dev : l'absence d'autorité durable ne doit jamais être simulée. */
export class DisabledRealtimeSidebandOwner implements RealtimeSidebandOwnerPort {
  async acquire(_input: RealtimeSidebandOwnerAcquireInput): Promise<RealtimeSidebandOwnerAcquireResult> {
    return { status: 'unavailable' };
  }

  async renew(
    _owner: RealtimeSidebandOwnerIdentity,
    _leaseSeconds: number,
  ): Promise<RealtimeSidebandOwnerMutationResult> {
    return { status: 'unavailable' };
  }

  async applyContext(
    _owner: RealtimeSidebandOwnerIdentity,
    _context: RealtimeSidebandContextVersion,
  ): Promise<RealtimeSidebandOwnerMutationResult> {
    return { status: 'unavailable' };
  }

  async readCurrentContext(
    _owner: RealtimeSidebandOwnerIdentity,
  ): Promise<RealtimeSidebandOwnerContextResult> {
    return { status: 'unavailable' };
  }

  async release(
    _owner: RealtimeSidebandOwnerIdentity,
  ): Promise<RealtimeSidebandOwnerMutationResult> {
    return { status: 'unavailable' };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import {
  appConflict,
  appForbidden,
  appNotFound,
  err,
  ok,
  parseQuoteDraftPayload,
  type AppError,
  type QuoteDraftPayloadV1,
  type QuoteDraftSlot,
  type Result,
} from '@bob/core';
import { AppLogger, getPrincipal } from '../observability/logger';
import type { Persistence } from '../persistence/persistence';
import { PERSISTENCE } from '../persistence/persistence-token';

export interface QuoteDraftSlotResponse {
  readonly revision: number;
  readonly payloadVersion: number;
  readonly payload: QuoteDraftPayloadV1;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface QuoteDraftEnvelopeResponse {
  readonly slot: QuoteDraftSlotResponse | null;
}

interface AuthenticatedQuoteDraftOwner {
  readonly companyId: string;
  readonly ownerUserId: string;
}

function clientSlot(slot: QuoteDraftSlot): QuoteDraftSlotResponse {
  return {
    revision: slot.revision,
    payloadVersion: slot.payloadVersion,
    payload: slot.payload,
    createdAt: slot.createdAt,
    updatedAt: slot.updatedAt,
  };
}

function invalidRevision(field: string): AppError {
  return {
    kind: 'validation',
    issues: [{ field, message: 'Révision entière et positive requise.' }],
  };
}

/**
 * Autorité serveur du slot de brouillon. L'identité n'est jamais un argument public : société et
 * propriétaire proviennent exclusivement du Principal établi par le JWT, puis sont tous deux
 * posés dans la transaction PostgreSQL avant que la RLS ne voie la requête.
 */
@Injectable()
export class QuoteDraftService {
  constructor(
    @Inject(PERSISTENCE) private readonly persistence: Persistence,
    private readonly logger: AppLogger,
  ) {}

  private identity(): Result<AuthenticatedQuoteDraftOwner, AppError> {
    const principal = getPrincipal();
    if (
      principal === undefined
      || principal.companyId === null
      || typeof principal.userId !== 'string'
      || principal.userId.trim() === ''
    ) {
      return err(appForbidden('authenticated_quote_draft_owner_required'));
    }
    return ok({ companyId: principal.companyId, ownerUserId: principal.userId });
  }

  private async inAuthenticatedOwnerScope<T>(
    operation: (identity: AuthenticatedQuoteDraftOwner) => Promise<Result<T, AppError>>,
  ): Promise<Result<T, AppError>> {
    const identity = this.identity();
    if (!identity.ok) return identity;
    const owner = identity.value;
    return this.persistence.runWithTenant(owner.companyId, () =>
      this.persistence.runWithIdentity(owner.ownerUserId, () => operation(owner)),
    );
  }

  getCurrent(): Promise<Result<QuoteDraftEnvelopeResponse, AppError>> {
    return this.inAuthenticatedOwnerScope(async (identity) => {
      const slot = await this.persistence.quoteDraftSlots.get(identity);
      return ok({ slot: slot === null ? null : clientSlot(slot) });
    });
  }

  saveCurrent(input: {
    readonly expectedRevision: number;
    readonly payload: unknown;
  }): Promise<Result<QuoteDraftSlotResponse, AppError>> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      return Promise.resolve(err(invalidRevision('expectedRevision')));
    }
    const payload = parseQuoteDraftPayload(input.payload);
    if (!payload.ok) {
      return Promise.resolve(err({
        kind: 'validation',
        issues: [{
          field: `payload${payload.error.path === '$' ? '' : payload.error.path.slice(1)}`,
          message: `Brouillon invalide (${payload.error.code}).`,
        }],
      }));
    }
    return this.inAuthenticatedOwnerScope(async (identity) => {
      const result = await this.persistence.quoteDraftSlots.upsert({
        ...identity,
        expectedRevision: input.expectedRevision,
        payload: payload.value,
      });
      if (result.status === 'revision_conflict') {
        return err(appConflict('quote_draft_slot', 'stale_revision'));
      }
      this.logger.audit('quote_draft.saved', {
        companyId: identity.companyId,
        ownerUserId: identity.ownerUserId,
        revision: result.slot.revision,
        outcome: result.status,
      });
      return ok(clientSlot(result.slot));
    });
  }

  deleteCurrent(input: {
    readonly expectedRevision: number;
  }): Promise<Result<{ readonly deleted: true }, AppError>> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return Promise.resolve(err(invalidRevision('expectedRevision')));
    }
    return this.inAuthenticatedOwnerScope(async (identity) => {
      const result = await this.persistence.quoteDraftSlots.delete({
        ...identity,
        expectedRevision: input.expectedRevision,
      });
      if (result.status === 'not_found') {
        return err(appNotFound('quote_draft_slot', 'current'));
      }
      if (result.status === 'revision_conflict') {
        return err(appConflict('quote_draft_slot', 'stale_revision'));
      }
      this.logger.audit('quote_draft.deleted', {
        companyId: identity.companyId,
        ownerUserId: identity.ownerUserId,
        revision: input.expectedRevision,
      });
      return ok({ deleted: true as const });
    });
  }
}

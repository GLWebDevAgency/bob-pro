import {
  QUOTE_DRAFT_PAYLOAD_VERSION,
  assertQuoteDraftExpectedRevision,
  assertQuoteDraftSlotIdentity,
  parseQuoteDraftPayload,
  type QuoteDraftPayloadV1,
  type QuoteDraftSlot,
  type QuoteDraftSlotDeleteResult,
  type QuoteDraftSlotRepository,
  type QuoteDraftSlotUpsertResult,
} from '@bob/core';

interface StoredQuoteDraftSlot {
  companyId: string;
  ownerUserId: string;
  revision: number;
  payload: QuoteDraftPayloadV1;
  createdAt: string;
  updatedAt: string;
}

function key(companyId: string, ownerUserId: string): string {
  return `${companyId.length}:${companyId}${ownerUserId}`;
}

function clonePayload(value: unknown): QuoteDraftPayloadV1 {
  const parsed = parseQuoteDraftPayload(value);
  if (!parsed.ok) {
    throw new Error(`QUOTE_DRAFT_PAYLOAD_INVALID:${parsed.error.code}:${parsed.error.path}`);
  }
  return parsed.value;
}

function cloneSlot(slot: StoredQuoteDraftSlot): QuoteDraftSlot {
  return {
    companyId: slot.companyId,
    ownerUserId: slot.ownerUserId,
    revision: slot.revision,
    payloadVersion: QUOTE_DRAFT_PAYLOAD_VERSION,
    payload: clonePayload(slot.payload),
    createdAt: slot.createdAt,
    updatedAt: slot.updatedAt,
  };
}

/**
 * Double strict réservé aux tests. Le runtime Nest de production n'importe jamais ce module
 * (`*.testing.ts` est exclu de tsconfig.build.json) et ne possède aucun repli mémoire.
 */
export class InMemoryQuoteDraftSlotRepository implements QuoteDraftSlotRepository {
  private readonly rows = new Map<string, StoredQuoteDraftSlot>();

  async get(input: {
    readonly companyId: string;
    readonly ownerUserId: string;
  }): Promise<QuoteDraftSlot | null> {
    assertQuoteDraftSlotIdentity(input);
    const row = this.rows.get(key(input.companyId, input.ownerUserId));
    return row === undefined ? null : cloneSlot(row);
  }

  async upsert(input: {
    readonly companyId: string;
    readonly ownerUserId: string;
    readonly expectedRevision: number;
    readonly payload: QuoteDraftPayloadV1;
  }): Promise<QuoteDraftSlotUpsertResult> {
    assertQuoteDraftSlotIdentity(input);
    assertQuoteDraftExpectedRevision(input.expectedRevision, true);
    const payload = clonePayload(input.payload);
    const rowKey = key(input.companyId, input.ownerUserId);
    const current = this.rows.get(rowKey);

    if (current === undefined) {
      if (input.expectedRevision !== 0) {
        return { status: 'revision_conflict', currentRevision: null };
      }
      const now = new Date().toISOString();
      const created: StoredQuoteDraftSlot = {
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        revision: 1,
        payload,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.set(rowKey, created);
      return { status: 'created', slot: cloneSlot(created) };
    }

    if (current.revision !== input.expectedRevision) {
      return { status: 'revision_conflict', currentRevision: current.revision };
    }
    const updated: StoredQuoteDraftSlot = {
      ...current,
      revision: current.revision + 1,
      payload,
      updatedAt: new Date().toISOString(),
    };
    this.rows.set(rowKey, updated);
    return { status: 'updated', slot: cloneSlot(updated) };
  }

  async delete(input: {
    readonly companyId: string;
    readonly ownerUserId: string;
    readonly expectedRevision: number;
  }): Promise<QuoteDraftSlotDeleteResult> {
    assertQuoteDraftSlotIdentity(input);
    assertQuoteDraftExpectedRevision(input.expectedRevision, false);
    const rowKey = key(input.companyId, input.ownerUserId);
    const current = this.rows.get(rowKey);
    if (current === undefined) return { status: 'not_found' };
    if (current.revision !== input.expectedRevision) {
      return { status: 'revision_conflict', currentRevision: current.revision };
    }
    this.rows.delete(rowKey);
    return { status: 'deleted' };
  }

  snapshot(): StoredQuoteDraftSlot[] {
    return [...this.rows.values()].map((slot) => ({
      ...slot,
      payload: clonePayload(slot.payload),
    }));
  }

  restore(snapshot: readonly StoredQuoteDraftSlot[]): void {
    this.rows.clear();
    for (const slot of snapshot) {
      this.rows.set(key(slot.companyId, slot.ownerUserId), {
        ...slot,
        payload: clonePayload(slot.payload),
      });
    }
  }
}

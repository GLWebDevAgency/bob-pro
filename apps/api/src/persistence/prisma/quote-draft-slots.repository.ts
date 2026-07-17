import { Prisma, type QuoteDraftSlot as QuoteDraftSlotRow } from '@prisma/client';
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
import type { PrismaService } from './prisma.service';

function normalizedPayload(payload: unknown): QuoteDraftPayloadV1 {
  const parsed = parseQuoteDraftPayload(payload);
  if (!parsed.ok) {
    throw new Error(`QUOTE_DRAFT_PAYLOAD_INVALID:${parsed.error.code}:${parsed.error.path}`);
  }
  return parsed.value;
}

function toPrismaJson(payload: QuoteDraftPayloadV1): Prisma.InputJsonValue {
  // Le parseur core vient de produire un graphe JSON canonique, sans undefined ni prototype.
  return JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue;
}

function fromRow(row: QuoteDraftSlotRow): QuoteDraftSlot {
  if (row.payloadVersion !== QUOTE_DRAFT_PAYLOAD_VERSION) {
    throw new Error(`QUOTE_DRAFT_PAYLOAD_VERSION_UNSUPPORTED:${row.payloadVersion}`);
  }
  if (!Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw new Error('QUOTE_DRAFT_REVISION_CORRUPT');
  }
  return {
    companyId: row.companyId,
    ownerUserId: row.ownerUserId,
    revision: row.revision,
    payloadVersion: QUOTE_DRAFT_PAYLOAD_VERSION,
    payload: normalizedPayload(row.payload),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Slot PostgreSQL owner-scoped. Toutes les mutations sont des compare-and-swap atomiques ;
 * aucune lecture préalable ne décide d'une écriture. La RLS exige que l'appelant ait posé
 * app.current_company_id ET app.current_user_id dans la transaction courante.
 */
export class PrismaQuoteDraftSlotRepository implements QuoteDraftSlotRepository {
  constructor(private readonly prisma: PrismaService) {}

  async get(input: { readonly companyId: string; readonly ownerUserId: string }): Promise<QuoteDraftSlot | null> {
    assertQuoteDraftSlotIdentity(input);
    const row = await this.prisma.client().quoteDraftSlot.findUnique({
      where: {
        quote_draft_slot_owner: {
          companyId: input.companyId,
          ownerUserId: input.ownerUserId,
        },
      },
    });
    return row === null ? null : fromRow(row);
  }

  async upsert(input: {
    readonly companyId: string;
    readonly ownerUserId: string;
    readonly expectedRevision: number;
    readonly payload: QuoteDraftPayloadV1;
  }): Promise<QuoteDraftSlotUpsertResult> {
    assertQuoteDraftSlotIdentity(input);
    assertQuoteDraftExpectedRevision(input.expectedRevision, true);
    const payload = normalizedPayload(input.payload);
    const json = toPrismaJson(payload);

    if (input.expectedRevision === 0) {
      const inserted = await this.prisma.client().quoteDraftSlot.createMany({
        data: [{
          companyId: input.companyId,
          ownerUserId: input.ownerUserId,
          revision: 1,
          payloadVersion: QUOTE_DRAFT_PAYLOAD_VERSION,
          payload: json,
        }],
        skipDuplicates: true,
      });
      if (inserted.count === 1) {
        const slot = await this.get(input);
        if (slot === null) throw new Error('QUOTE_DRAFT_CREATED_BUT_NOT_VISIBLE');
        return { status: 'created', slot };
      }
      const current = await this.get(input);
      return { status: 'revision_conflict', currentRevision: current?.revision ?? null };
    }

    const updated = await this.prisma.client().quoteDraftSlot.updateMany({
      where: {
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        revision: input.expectedRevision,
      },
      data: {
        payloadVersion: QUOTE_DRAFT_PAYLOAD_VERSION,
        payload: json,
        revision: { increment: 1 },
        updatedAt: new Date(),
      },
    });
    if (updated.count === 1) {
      const slot = await this.get(input);
      if (slot === null) throw new Error('QUOTE_DRAFT_UPDATED_BUT_NOT_VISIBLE');
      return { status: 'updated', slot };
    }
    const current = await this.get(input);
    return { status: 'revision_conflict', currentRevision: current?.revision ?? null };
  }

  async delete(input: {
    readonly companyId: string;
    readonly ownerUserId: string;
    readonly expectedRevision: number;
  }): Promise<QuoteDraftSlotDeleteResult> {
    assertQuoteDraftSlotIdentity(input);
    assertQuoteDraftExpectedRevision(input.expectedRevision, false);
    const deleted = await this.prisma.client().quoteDraftSlot.deleteMany({
      where: {
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        revision: input.expectedRevision,
      },
    });
    if (deleted.count === 1) return { status: 'deleted' };
    const current = await this.get(input);
    return current === null
      ? { status: 'not_found' }
      : { status: 'revision_conflict', currentRevision: current.revision };
  }
}

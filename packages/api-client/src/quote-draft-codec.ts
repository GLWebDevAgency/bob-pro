import {
  QUOTE_DRAFT_PAYLOAD_VERSION,
  parseQuoteDraftPayload,
} from '@bob/core';
import type { QuoteDraftSlotView } from './client';

export interface QuoteDraftEnvelopeWire {
  readonly slot: QuoteDraftSlotView | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function canonicalIso(value: unknown): value is string {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

export function decodeQuoteDraftSlot(value: unknown): QuoteDraftSlotView | null {
  const slot = record(value);
  if (
    slot === null
    || !exactKeys(slot, ['revision', 'payloadVersion', 'payload', 'createdAt', 'updatedAt'])
    || !Number.isSafeInteger(slot.revision)
    || (slot.revision as number) < 1
    || slot.payloadVersion !== QUOTE_DRAFT_PAYLOAD_VERSION
    || !canonicalIso(slot.createdAt)
    || !canonicalIso(slot.updatedAt)
    || Date.parse(slot.updatedAt) < Date.parse(slot.createdAt)
  ) {
    return null;
  }
  const payload = parseQuoteDraftPayload(slot.payload);
  if (!payload.ok || payload.value.version !== slot.payloadVersion) return null;
  return {
    revision: slot.revision as number,
    payloadVersion: QUOTE_DRAFT_PAYLOAD_VERSION,
    payload: payload.value,
    createdAt: slot.createdAt,
    updatedAt: slot.updatedAt,
  };
}

export function decodeQuoteDraftEnvelope(value: unknown): QuoteDraftEnvelopeWire | null {
  const envelope = record(value);
  if (envelope === null || !exactKeys(envelope, ['slot'])) return null;
  if (envelope.slot === null) return { slot: null };
  const slot = decodeQuoteDraftSlot(envelope.slot);
  return slot === null ? null : { slot };
}

export function decodeQuoteDraftDeletion(value: unknown): { deleted: true } | null {
  const result = record(value);
  return result !== null && exactKeys(result, ['deleted']) && result.deleted === true
    ? { deleted: true }
    : null;
}

import {
  canonicalCreateQuotePayload,
  type CreateQuoteInput,
  type CreateQuoteOutput,
  type Totals,
} from '@bob/core';
import { portableSha256Hex } from './expense-idempotency';

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const VAT_RATE_KEYS = new Set(['0', '2.1', '5.5', '10', '20']);

export interface LocalQuoteCreationFingerprint {
  readonly keyHash: string;
  readonly payloadHash: string;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function localQuoteCreationFingerprint(
  companyId: string,
  input: Omit<CreateQuoteInput, 'companyId'>,
): LocalQuoteCreationFingerprint | null | 'invalid' {
  const key = input.idempotencyKey;
  if (key === null || key === undefined) return null;
  if (
    typeof key !== 'string'
    || key.trim().length === 0
    || key.length > MAX_IDEMPOTENCY_KEY_LENGTH
    || hasControlCharacter(key)
  ) return 'invalid';
  return {
    keyHash: portableSha256Hex(`bob:quote-creation:key:v1\0${companyId}\0${key}`),
    payloadHash: portableSha256Hex(JSON.stringify(canonicalCreateQuotePayload(input))),
  };
}

function exactCents(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function decodeTotals(value: unknown): Totals | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 5
    || !Object.hasOwn(candidate, 'ht')
    || !Object.hasOwn(candidate, 'vat')
    || !Object.hasOwn(candidate, 'ttc')
    || !Object.hasOwn(candidate, 'netToPay')
    || !Object.hasOwn(candidate, 'vatByRate')
  ) return null;
  const ht = exactCents(candidate.ht);
  const vat = exactCents(candidate.vat);
  const ttc = exactCents(candidate.ttc);
  const netToPay = exactCents(candidate.netToPay);
  const rawVatByRate = candidate.vatByRate;
  if (
    ht === null
    || vat === null
    || ttc === null
    || netToPay === null
    || ht + vat !== ttc
    || netToPay > ttc
    || rawVatByRate === null
    || typeof rawVatByRate !== 'object'
    || Array.isArray(rawVatByRate)
  ) return null;
  const vatByRate: Record<string, number> = {};
  for (const [rate, rawAmount] of Object.entries(rawVatByRate)) {
    const amount = exactCents(rawAmount);
    if (!VAT_RATE_KEYS.has(rate) || amount === null) return null;
    vatByRate[rate] = amount;
  }
  if (Object.values(vatByRate).reduce((sum, amount) => sum + amount, 0) !== vat) return null;
  return { ht, vat, ttc, netToPay, vatByRate };
}

/** Décode strictement la réponse publiée par POST /quotes avant de la checkpoint-er. */
export function decodeQuoteCreation(value: unknown): CreateQuoteOutput | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2
    || !Object.hasOwn(candidate, 'quoteId')
    || !Object.hasOwn(candidate, 'totals')
    || typeof candidate.quoteId !== 'string'
    || candidate.quoteId.length === 0
    || candidate.quoteId.length > 240
    || candidate.quoteId !== candidate.quoteId.trim()
    || hasControlCharacter(candidate.quoteId)
  ) return null;
  const totals = decodeTotals(candidate.totals);
  return totals ? { quoteId: candidate.quoteId, totals } : null;
}

export function cloneQuoteCreation(output: CreateQuoteOutput): CreateQuoteOutput {
  return {
    quoteId: output.quoteId,
    totals: { ...output.totals, vatByRate: { ...output.totals.vatByRate } },
  };
}

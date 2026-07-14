import { createHash } from 'node:crypto';
import {
  canonicalCreateQuotePayload,
  type CreateQuoteInput,
  type CreateQuoteOutput,
  type Totals,
} from '@bob/core';
import type { QuoteCreationRequest as PrismaQuoteCreationRequest } from '@prisma/client';
import type { PrismaService } from './prisma/prisma.service';

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const VAT_RATE_KEYS = new Set(['0', '2.1', '5.5', '10', '20']);

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export interface QuoteCreationFingerprint {
  readonly keyHash: string;
  readonly payloadHash: string;
}

export interface QuoteCreationRequestKey {
  readonly companyId: string;
  readonly keyHash: string;
}

export interface QuoteCreationRequestRecord extends QuoteCreationRequestKey {
  readonly payloadHash: string;
  readonly output: CreateQuoteOutput;
  readonly createdAt: string;
}

export interface QuoteCreationRequestStore {
  find(key: QuoteCreationRequestKey): Promise<QuoteCreationRequestRecord | null>;
  /** Insert-only : retourne la ligne gagnante si une autre transaction a publié la clé. */
  putIfAbsent(record: QuoteCreationRequestRecord): Promise<QuoteCreationRequestRecord>;
}

export class InvalidQuoteCreationRequestError extends Error {
  constructor(readonly field: string, message: string) {
    super(`Invalid quote creation request (${field}): ${message}`);
    this.name = 'InvalidQuoteCreationRequestError';
  }
}

function exactString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new InvalidQuoteCreationRequestError(field, 'non-empty canonical string required');
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** La clé brute ne quitte jamais cette fonction et n'est jamais exposée par le store. */
export function quoteCreationFingerprint(
  companyId: string,
  input: Omit<CreateQuoteInput, 'companyId'>,
): QuoteCreationFingerprint | null {
  const key = input.idempotencyKey;
  if (key === null || key === undefined) return null;
  exactString(companyId, 'companyId');
  if (
    typeof key !== 'string'
    || key.trim().length === 0
    || key.length > MAX_IDEMPOTENCY_KEY_LENGTH
    || hasControlCharacter(key)
  ) {
    throw new InvalidQuoteCreationRequestError(
      'idempotencyKey',
      `printable string between 1 and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters required`,
    );
  }
  return {
    keyHash: sha256(`bob:quote-creation:key:v1\0${companyId}\0${key}`),
    payloadHash: sha256(JSON.stringify(canonicalCreateQuotePayload(input))),
  };
}

function validateHash(value: unknown, field: 'keyHash' | 'payloadHash'): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new InvalidQuoteCreationRequestError(field, 'lowercase SHA-256 required');
  }
  return value;
}

function exactCents(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new InvalidQuoteCreationRequestError(field, 'non-negative safe integer required');
  }
  return value as number;
}

function validateTotals(value: unknown): Totals {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidQuoteCreationRequestError('totals', 'object required');
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 5
    || !Object.hasOwn(candidate, 'ht')
    || !Object.hasOwn(candidate, 'vat')
    || !Object.hasOwn(candidate, 'ttc')
    || !Object.hasOwn(candidate, 'netToPay')
    || !Object.hasOwn(candidate, 'vatByRate')
  ) {
    throw new InvalidQuoteCreationRequestError('totals', 'exact totals shape required');
  }
  const ht = exactCents(candidate.ht, 'totals.ht');
  const vat = exactCents(candidate.vat, 'totals.vat');
  const ttc = exactCents(candidate.ttc, 'totals.ttc');
  const netToPay = exactCents(candidate.netToPay, 'totals.netToPay');
  const rawVatByRate = candidate.vatByRate;
  if (rawVatByRate === null || typeof rawVatByRate !== 'object' || Array.isArray(rawVatByRate)) {
    throw new InvalidQuoteCreationRequestError('totals.vatByRate', 'object required');
  }
  const vatByRate: Record<string, number> = {};
  for (const [rate, amount] of Object.entries(rawVatByRate)) {
    if (!VAT_RATE_KEYS.has(rate)) {
      throw new InvalidQuoteCreationRequestError('totals.vatByRate', 'unsupported VAT rate');
    }
    vatByRate[rate] = exactCents(amount, `totals.vatByRate.${rate}`);
  }
  if (ht + vat !== ttc || netToPay > ttc) {
    throw new InvalidQuoteCreationRequestError('totals', 'incoherent totals');
  }
  if (Object.values(vatByRate).reduce((sum, amount) => sum + amount, 0) !== vat) {
    throw new InvalidQuoteCreationRequestError('totals.vatByRate', 'VAT breakdown mismatch');
  }
  return { ht, vat, ttc, netToPay, vatByRate };
}

function validateOutput(value: unknown): CreateQuoteOutput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidQuoteCreationRequestError('output', 'object required');
  }
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2
    || !Object.hasOwn(candidate, 'quoteId')
    || !Object.hasOwn(candidate, 'totals')
  ) {
    throw new InvalidQuoteCreationRequestError('output', 'exact output shape required');
  }
  return {
    quoteId: exactString(candidate.quoteId, 'output.quoteId'),
    totals: validateTotals(candidate.totals),
  };
}

function cloneOutput(output: CreateQuoteOutput): CreateQuoteOutput {
  return { quoteId: output.quoteId, totals: { ...output.totals, vatByRate: { ...output.totals.vatByRate } } };
}

function validateRecord(record: QuoteCreationRequestRecord): QuoteCreationRequestRecord {
  const companyId = exactString(record.companyId, 'companyId');
  const keyHash = validateHash(record.keyHash, 'keyHash');
  const payloadHash = validateHash(record.payloadHash, 'payloadHash');
  const output = validateOutput(record.output);
  const timestamp = Date.parse(record.createdAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== record.createdAt) {
    throw new InvalidQuoteCreationRequestError('createdAt', 'canonical UTC ISO-8601 instant required');
  }
  return { companyId, keyHash, payloadHash, output, createdAt: record.createdAt };
}

function validateKey(key: QuoteCreationRequestKey): QuoteCreationRequestKey {
  return {
    companyId: exactString(key.companyId, 'companyId'),
    keyHash: validateHash(key.keyHash, 'keyHash'),
  };
}

function cloneRecord(record: QuoteCreationRequestRecord): QuoteCreationRequestRecord {
  return { ...record, output: cloneOutput(record.output) };
}

function memoryKey(key: QuoteCreationRequestKey): string {
  return JSON.stringify([key.companyId, key.keyHash]);
}

function fromPrisma(row: PrismaQuoteCreationRequest): QuoteCreationRequestRecord {
  const output = validateOutput({
    quoteId: row.quoteId,
    totals: {
      ht: row.totalsHt,
      vat: row.totalsVat,
      ttc: row.totalsTtc,
      netToPay: row.totalsNetToPay,
      vatByRate: row.vatByRate,
    },
  });
  return validateRecord({
    companyId: row.companyId,
    keyHash: row.keyHash,
    payloadHash: row.payloadHash,
    output,
    createdAt: row.createdAt.toISOString(),
  });
}

export class InMemoryQuoteCreationRequestStore implements QuoteCreationRequestStore {
  private rows = new Map<string, QuoteCreationRequestRecord>();

  async find(key: QuoteCreationRequestKey): Promise<QuoteCreationRequestRecord | null> {
    const row = this.rows.get(memoryKey(validateKey(key)));
    return row ? cloneRecord(row) : null;
  }

  async putIfAbsent(record: QuoteCreationRequestRecord): Promise<QuoteCreationRequestRecord> {
    const candidate = validateRecord(record);
    const key = memoryKey(candidate);
    const winner = this.rows.get(key);
    if (winner) return cloneRecord(winner);
    this.rows.set(key, cloneRecord(candidate));
    return cloneRecord(candidate);
  }

  snapshot(): Map<string, QuoteCreationRequestRecord> {
    return new Map([...this.rows].map(([key, record]) => [key, cloneRecord(record)]));
  }

  restore(snapshot: Map<string, QuoteCreationRequestRecord>): void {
    this.rows = new Map([...snapshot].map(([key, record]) => [key, cloneRecord(record)]));
  }
}

export class PrismaQuoteCreationRequestStore implements QuoteCreationRequestStore {
  constructor(private readonly prisma: PrismaService) {}

  async find(key: QuoteCreationRequestKey): Promise<QuoteCreationRequestRecord | null> {
    const valid = validateKey(key);
    const row = await this.prisma.client().quoteCreationRequest.findUnique({
      where: { quote_creation_request_key: valid },
    });
    return row ? fromPrisma(row) : null;
  }

  async putIfAbsent(record: QuoteCreationRequestRecord): Promise<QuoteCreationRequestRecord> {
    const candidate = validateRecord(record);
    await this.prisma.client().quoteCreationRequest.createMany({
      data: {
        companyId: candidate.companyId,
        keyHash: candidate.keyHash,
        payloadHash: candidate.payloadHash,
        quoteId: candidate.output.quoteId,
        totalsHt: candidate.output.totals.ht,
        totalsVat: candidate.output.totals.vat,
        totalsTtc: candidate.output.totals.ttc,
        totalsNetToPay: candidate.output.totals.netToPay,
        vatByRate: candidate.output.totals.vatByRate,
        createdAt: new Date(candidate.createdAt),
      },
      skipDuplicates: true,
    });
    const winner = await this.prisma.client().quoteCreationRequest.findUnique({
      where: {
        quote_creation_request_key: {
          companyId: candidate.companyId,
          keyHash: candidate.keyHash,
        },
      },
    });
    if (!winner) {
      throw new Error('Quote creation idempotency insert completed without a tenant-visible winner.');
    }
    return fromPrisma(winner);
  }
}

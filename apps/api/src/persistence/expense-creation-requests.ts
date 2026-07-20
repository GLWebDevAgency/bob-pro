import { createHash } from 'node:crypto';
import {
  canonicalRecordExpensePayload,
  type RecordExpenseInput,
} from '@bob/core';
import type { ExpenseCreationRequest as PrismaExpenseCreationRequest } from '@prisma/client';
import type { PrismaService } from './prisma/prisma.service';

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export interface ExpenseCreationFingerprint {
  readonly keyHash: string;
  readonly payloadHash: string;
}

export interface ExpenseCreationRequestKey {
  readonly companyId: string;
  readonly keyHash: string;
}

export interface ExpenseCreationRequestRecord extends ExpenseCreationRequestKey {
  readonly payloadHash: string;
  readonly expenseId: string;
  readonly createdAt: string;
}

export interface ExpenseCreationRequestStore {
  find(key: ExpenseCreationRequestKey): Promise<ExpenseCreationRequestRecord | null>;
  /** Insert-only : retourne la ligne gagnante si une autre transaction a publié la clé. */
  putIfAbsent(record: ExpenseCreationRequestRecord): Promise<ExpenseCreationRequestRecord>;
}

export class InvalidExpenseCreationRequestError extends Error {
  constructor(readonly field: string, message: string) {
    super(`Invalid expense creation request (${field}): ${message}`);
    this.name = 'InvalidExpenseCreationRequestError';
  }
}

function exactString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new InvalidExpenseCreationRequestError(field, 'non-empty canonical string required');
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Transforme la clé opaque en empreinte tenant-salée et l'intention comptable en empreinte
 * canonique. Aucune API de ce module ne restitue ni ne stocke la clé brute.
 */
export function expenseCreationFingerprint(
  companyId: string,
  input: Omit<RecordExpenseInput, 'companyId'>,
): ExpenseCreationFingerprint | null {
  const key = input.idempotencyKey;
  if (key === null || key === undefined) return null;
  exactString(companyId, 'companyId');
  if (
    typeof key !== 'string'
    || key.trim().length === 0
    || key.length > MAX_IDEMPOTENCY_KEY_LENGTH
    || hasControlCharacter(key)
  ) {
    throw new InvalidExpenseCreationRequestError(
      'idempotencyKey',
      `printable string between 1 and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters required`,
    );
  }
  return {
    keyHash: sha256(`bob:expense-creation:key:v1\0${companyId}\0${key}`),
    payloadHash: sha256(JSON.stringify(canonicalRecordExpensePayload(input))),
  };
}

function validateHash(value: unknown, field: 'keyHash' | 'payloadHash'): string {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new InvalidExpenseCreationRequestError(field, 'lowercase SHA-256 required');
  }
  return value;
}

/** @internal Partagé avec le store déterministe situé dans `*.testing.ts`. */
export function validateExpenseCreationRequestRecord(
  record: ExpenseCreationRequestRecord,
): ExpenseCreationRequestRecord {
  const companyId = exactString(record.companyId, 'companyId');
  const expenseId = exactString(record.expenseId, 'expenseId');
  const keyHash = validateHash(record.keyHash, 'keyHash');
  const payloadHash = validateHash(record.payloadHash, 'payloadHash');
  const timestamp = Date.parse(record.createdAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== record.createdAt) {
    throw new InvalidExpenseCreationRequestError('createdAt', 'canonical UTC ISO-8601 instant required');
  }
  return { companyId, keyHash, payloadHash, expenseId, createdAt: record.createdAt };
}

/** @internal Partagé avec le store déterministe situé dans `*.testing.ts`. */
export function validateExpenseCreationRequestKey(
  key: ExpenseCreationRequestKey,
): ExpenseCreationRequestKey {
  return {
    companyId: exactString(key.companyId, 'companyId'),
    keyHash: validateHash(key.keyHash, 'keyHash'),
  };
}

function fromPrisma(row: PrismaExpenseCreationRequest): ExpenseCreationRequestRecord {
  return validateExpenseCreationRequestRecord({
    companyId: row.companyId,
    keyHash: row.keyHash,
    payloadHash: row.payloadHash,
    expenseId: row.expenseId,
    createdAt: row.createdAt.toISOString(),
  });
}

export class PrismaExpenseCreationRequestStore implements ExpenseCreationRequestStore {
  constructor(private readonly prisma: PrismaService) {}

  async find(key: ExpenseCreationRequestKey): Promise<ExpenseCreationRequestRecord | null> {
    const valid = validateExpenseCreationRequestKey(key);
    const row = await this.prisma.client().expenseCreationRequest.findUnique({
      where: { expense_creation_request_key: valid },
    });
    return row ? fromPrisma(row) : null;
  }

  async putIfAbsent(record: ExpenseCreationRequestRecord): Promise<ExpenseCreationRequestRecord> {
    const candidate = validateExpenseCreationRequestRecord(record);
    // PostgreSQL : INSERT ... ON CONFLICT DO NOTHING. Une course bloque sur l'index unique puis
    // relit, en READ COMMITTED, la ligne gagnante dès son commit.
    await this.prisma.client().expenseCreationRequest.createMany({
      data: {
        companyId: candidate.companyId,
        keyHash: candidate.keyHash,
        payloadHash: candidate.payloadHash,
        expenseId: candidate.expenseId,
        createdAt: new Date(candidate.createdAt),
      },
      skipDuplicates: true,
    });
    const winner = await this.prisma.client().expenseCreationRequest.findUnique({
      where: {
        expense_creation_request_key: {
          companyId: candidate.companyId,
          keyHash: candidate.keyHash,
        },
      },
    });
    if (!winner) {
      throw new Error('Expense creation idempotency insert completed without a tenant-visible winner.');
    }
    return fromPrisma(winner);
  }
}

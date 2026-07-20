import type { CreateQuoteOutput } from '@bob/core';
import {
  validateQuoteCreationRequestKey,
  validateQuoteCreationRequestRecord,
  type QuoteCreationRequestKey,
  type QuoteCreationRequestRecord,
  type QuoteCreationRequestStore,
} from './quote-creation-requests';

function cloneOutput(output: CreateQuoteOutput): CreateQuoteOutput {
  return {
    quoteId: output.quoteId,
    totals: { ...output.totals, vatByRate: { ...output.totals.vatByRate } },
  };
}

function cloneRecord(record: QuoteCreationRequestRecord): QuoteCreationRequestRecord {
  return { ...record, output: cloneOutput(record.output) };
}

function memoryKey(key: QuoteCreationRequestKey): string {
  return JSON.stringify([key.companyId, key.keyHash]);
}

/** Double déterministe réservé au harness de tests API. */
export class InMemoryQuoteCreationRequestStore implements QuoteCreationRequestStore {
  private rows = new Map<string, QuoteCreationRequestRecord>();

  async find(key: QuoteCreationRequestKey): Promise<QuoteCreationRequestRecord | null> {
    const row = this.rows.get(memoryKey(validateQuoteCreationRequestKey(key)));
    return row ? cloneRecord(row) : null;
  }

  async putIfAbsent(record: QuoteCreationRequestRecord): Promise<QuoteCreationRequestRecord> {
    const candidate = validateQuoteCreationRequestRecord(record);
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

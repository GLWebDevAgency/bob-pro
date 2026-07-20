import {
  validateExpenseCreationRequestKey,
  validateExpenseCreationRequestRecord,
  type ExpenseCreationRequestKey,
  type ExpenseCreationRequestRecord,
  type ExpenseCreationRequestStore,
} from './expense-creation-requests';

function cloneRecord(record: ExpenseCreationRequestRecord): ExpenseCreationRequestRecord {
  return { ...record };
}

function memoryKey(key: ExpenseCreationRequestKey): string {
  return JSON.stringify([key.companyId, key.keyHash]);
}

/** Double déterministe réservé au harness de tests API. */
export class InMemoryExpenseCreationRequestStore implements ExpenseCreationRequestStore {
  private rows = new Map<string, ExpenseCreationRequestRecord>();

  async find(key: ExpenseCreationRequestKey): Promise<ExpenseCreationRequestRecord | null> {
    const valid = validateExpenseCreationRequestKey(key);
    const row = this.rows.get(memoryKey(valid));
    return row ? cloneRecord(row) : null;
  }

  async putIfAbsent(record: ExpenseCreationRequestRecord): Promise<ExpenseCreationRequestRecord> {
    const candidate = validateExpenseCreationRequestRecord(record);
    const key = memoryKey(candidate);
    const winner = this.rows.get(key);
    if (winner) return cloneRecord(winner);
    this.rows.set(key, cloneRecord(candidate));
    return cloneRecord(candidate);
  }

  snapshot(): Map<string, ExpenseCreationRequestRecord> {
    return new Map([...this.rows].map(([key, record]) => [key, cloneRecord(record)]));
  }

  restore(snapshot: Map<string, ExpenseCreationRequestRecord>): void {
    this.rows = new Map([...snapshot].map(([key, record]) => [key, cloneRecord(record)]));
  }
}

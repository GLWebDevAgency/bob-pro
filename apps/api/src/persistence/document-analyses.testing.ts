import {
  validateDocumentAnalysisCacheKey,
  validateDocumentAnalysisCacheRecord,
  type DocumentAnalysisCacheKey,
  type DocumentAnalysisCacheRecord,
  type DocumentAnalysisCacheWrite,
  type DocumentAnalysisStore,
} from './document-analyses';

function cloneRecord(record: DocumentAnalysisCacheRecord): DocumentAnalysisCacheRecord {
  return { ...record, analysis: structuredClone(record.analysis) };
}

function cacheKey(key: DocumentAnalysisCacheKey): string {
  return JSON.stringify([key.companyId, key.documentId, key.documentVersion, key.sourceSha256]);
}

/** Double déterministe réservé au harness de tests API. */
export class InMemoryDocumentAnalysisStore implements DocumentAnalysisStore {
  private rows = new Map<string, DocumentAnalysisCacheRecord>();

  async findExact(key: DocumentAnalysisCacheKey): Promise<DocumentAnalysisCacheRecord | null> {
    const validKey = validateDocumentAnalysisCacheKey(key);
    const row = this.rows.get(cacheKey(validKey));
    return row ? cloneRecord(row) : null;
  }

  async putIfAbsent(record: DocumentAnalysisCacheWrite): Promise<DocumentAnalysisCacheRecord> {
    const candidate = validateDocumentAnalysisCacheRecord(record);
    const key = cacheKey(candidate);
    const winner = this.rows.get(key);
    if (winner) return cloneRecord(winner);
    this.rows.set(key, cloneRecord(candidate));
    return cloneRecord(candidate);
  }

  async findManyExact(
    companyId: string,
    keys: readonly Omit<DocumentAnalysisCacheKey, 'companyId'>[],
  ): Promise<DocumentAnalysisCacheRecord[]> {
    const records: DocumentAnalysisCacheRecord[] = [];
    for (const key of keys) {
      const row = this.rows.get(cacheKey(validateDocumentAnalysisCacheKey({ companyId, ...key })));
      if (row) records.push(cloneRecord(row));
    }
    return records;
  }

  snapshot(): Map<string, DocumentAnalysisCacheRecord> {
    return new Map([...this.rows].map(([key, record]) => [key, cloneRecord(record)]));
  }

  restore(snapshot: Map<string, DocumentAnalysisCacheRecord>): void {
    this.rows = new Map([...snapshot].map(([key, record]) => [key, cloneRecord(record)]));
  }
}

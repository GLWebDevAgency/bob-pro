export type DocumentArchiveJobStatus = 'pending' | 'done' | 'failed';

export interface DocumentArchiveJob {
  id: string;
  companyId: string;
  invoiceId: string;
  reason: 'invoice-issued';
  status: DocumentArchiveJobStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueDocumentArchiveJobInput {
  id: string;
  companyId: string;
  invoiceId: string;
  reason: 'invoice-issued';
  now: string;
}

export interface DocumentArchiveJobRepository {
  enqueue(input: EnqueueDocumentArchiveJobInput): Promise<void>;
  listDue(companyId: string, now: string, limit: number): Promise<DocumentArchiveJob[]>;
  markDone(id: string, at: string): Promise<void>;
  markFailed(id: string, at: string, nextAttemptAt: string, error: string): Promise<void>;
}

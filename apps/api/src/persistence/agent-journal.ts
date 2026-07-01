import { randomUUID } from 'node:crypto';
import type { JournalEntry, JournalStore } from '@bob/ai';

export interface AgentJournalRepository {
  append(companyId: string, entry: JournalEntry): Promise<void>;
  load(companyId: string, runId: string): Promise<JournalEntry[]>;
}

export class CompanyScopedJournalStore implements JournalStore {
  constructor(
    private readonly repo: AgentJournalRepository,
    private readonly companyId: string,
  ) {}

  append(entry: JournalEntry): Promise<void> {
    return this.repo.append(this.companyId, entry);
  }

  load(runId: string): Promise<JournalEntry[]> {
    return this.repo.load(this.companyId, runId);
  }
}

export class InMemoryAgentJournalRepository implements AgentJournalRepository {
  private readonly byTenantRun = new Map<string, JournalEntry[]>();

  async append(companyId: string, entry: JournalEntry): Promise<void> {
    const key = `${companyId}:${entry.runId}`;
    const list = this.byTenantRun.get(key) ?? [];
    if (list.some((e) => e.seq === entry.seq)) return;
    list.push({ ...entry, args: { ...entry.args } });
    list.sort((a, b) => a.seq - b.seq);
    this.byTenantRun.set(key, list);
  }

  async load(companyId: string, runId: string): Promise<JournalEntry[]> {
    return (this.byTenantRun.get(`${companyId}:${runId}`) ?? []).map((entry) => ({
      ...entry,
      args: { ...entry.args },
    }));
  }
}

export function newAgentJournalEntryId(): string {
  return `aje_${randomUUID()}`;
}

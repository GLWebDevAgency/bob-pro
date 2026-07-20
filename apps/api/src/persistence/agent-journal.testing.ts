import type { JournalEntry } from '@bob/ai';
import type { AgentJournalRepository } from './agent-journal';

/** Double déterministe réservé au harness de tests API. */
export class InMemoryAgentJournalRepository implements AgentJournalRepository {
  private readonly byTenantRun = new Map<string, JournalEntry[]>();

  async append(companyId: string, entry: JournalEntry): Promise<void> {
    const key = `${companyId}:${entry.runId}`;
    const list = this.byTenantRun.get(key) ?? [];
    if (list.some((candidate) => candidate.seq === entry.seq)) return;
    list.push({ ...entry, args: { ...entry.args } });
    list.sort((left, right) => left.seq - right.seq);
    this.byTenantRun.set(key, list);
  }

  async load(companyId: string, runId: string): Promise<JournalEntry[]> {
    return (this.byTenantRun.get(`${companyId}:${runId}`) ?? []).map((entry) => ({
      ...entry,
      args: { ...entry.args },
    }));
  }

  async claim(companyId: string, entry: JournalEntry): Promise<boolean> {
    const key = `${companyId}:${entry.runId}`;
    const list = this.byTenantRun.get(key) ?? [];
    if (list.some((candidate) => candidate.seq === entry.seq)) return false;
    list.push({ ...entry, args: { ...entry.args } });
    list.sort((left, right) => left.seq - right.seq);
    this.byTenantRun.set(key, list);
    return true;
  }
}

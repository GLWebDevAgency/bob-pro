import { randomUUID } from 'node:crypto';
import type { JournalEntry, JournalStore } from '@bob/ai';

export interface AgentJournalRepository {
  append(companyId: string, entry: JournalEntry): Promise<void>;
  load(companyId: string, runId: string): Promise<JournalEntry[]>;
  /**
   * Réserve atomiquement une confirmation. true = ce caller possède le droit
   * d'exécuter ; false = proposition déjà consommée. Contrairement à append(),
   * un doublon n'est jamais absorbé silencieusement.
   */
  claim(companyId: string, entry: JournalEntry): Promise<boolean>;
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

  async claim(companyId: string, entry: JournalEntry): Promise<boolean> {
    const key = `${companyId}:${entry.runId}`;
    const list = this.byTenantRun.get(key) ?? [];
    if (list.some((candidate) => candidate.seq === entry.seq)) return false;
    list.push({ ...entry, args: { ...entry.args } });
    list.sort((a, b) => a.seq - b.seq);
    this.byTenantRun.set(key, list);
    return true;
  }
}

export function newAgentJournalEntryId(): string {
  return `aje_${randomUUID()}`;
}

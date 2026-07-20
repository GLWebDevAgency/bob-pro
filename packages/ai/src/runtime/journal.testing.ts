import type { JournalEntry, JournalStore } from './journal';

/** Double append-only réservé à l'entrée `@bob/ai/testing`; jamais exporté au runtime produit. */
export class InMemoryJournalStore implements JournalStore {
  private readonly byRun = new Map<string, JournalEntry[]>();

  async append(entry: JournalEntry): Promise<void> {
    const list = this.byRun.get(entry.runId) ?? [];
    list.push(entry);
    this.byRun.set(entry.runId, list);
  }

  async load(runId: string): Promise<JournalEntry[]> {
    return [...(this.byRun.get(runId) ?? [])];
  }
}

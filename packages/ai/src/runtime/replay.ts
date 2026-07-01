import { type AgentRunRecord, type JournalEntry, type JournalPhase } from './journal';
import { type RuntimeInvocation } from './runtime';

export interface ReplayStep {
  readonly seq: number;
  readonly phase: JournalPhase;
  readonly tool: string;
  readonly label: string;
  readonly reason?: string;
}

export interface ReplaySummary {
  readonly runId: string;
  readonly executed: number;
  readonly planned: number;
  readonly denied: number;
  readonly failed: number;
  readonly steps: readonly ReplayStep[];
}

export function summarizeEntries(runId: string, entries: readonly JournalEntry[]): ReplaySummary {
  const steps: ReplayStep[] = entries.map((e) => ({
    seq: e.seq,
    phase: e.phase,
    tool: e.tool,
    label: e.label,
    ...(e.reason !== undefined ? { reason: e.reason } : {}),
  }));
  const count = (p: JournalPhase): number => entries.filter((e) => e.phase === p).length;
  return {
    runId,
    executed: count('executed'),
    planned: count('planned'),
    denied: count('denied'),
    failed: count('failed'),
    steps,
  };
}

export function summarizeRun(record: AgentRunRecord): ReplaySummary {
  return summarizeEntries(record.runId, record.entries);
}

/**
 * Invocations rejouables reconstruites depuis un journal : les actions AUTORISÉES ET VALIDÉES
 * (entrées 'planned'). Rejouer via `AgentRuntime.run` est sûr pour les outils idempotents (la clé
 * d'idempotence portée dans `args` empêche le double effet).
 */
export function invocationsFrom(entries: readonly JournalEntry[]): RuntimeInvocation[] {
  return entries
    .filter((e) => e.phase === 'planned')
    .map((e) => ({ tool: e.tool, args: e.args, label: e.label }));
}

const PHASE_ICON: Record<JournalPhase, string> = { planned: '•', executed: '✓', denied: '⛔', failed: '✗' };

/** Rendu lisible du journal (audit humain / réponse à l'utilisateur). */
export function renderReplay(summary: ReplaySummary): string {
  return summary.steps.map((s) => `${PHASE_ICON[s.phase]} ${s.label}${s.reason ? ` — ${s.reason}` : ''}`).join('\n');
}

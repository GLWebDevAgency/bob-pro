/**
 * Journal d'actions de l'agent — append-only, immuable, rejouable.
 * Chaque intention de Bob (autorisée, refusée, exécutée, échouée) laisse une entrée horodatée.
 * Sert d'AUDIT (traçabilité compta/financière : qui a fait quoi, quand, avec quel résultat) et de
 * base de REJEU (replay). Aucune entrée n'est jamais modifiée ni supprimée après ajout.
 */

export type JournalPhase = 'planned' | 'denied' | 'executed' | 'failed';

export type RuntimeMode = 'live' | 'dry-run';

export type ComplianceLevel = 'low' | 'medium' | 'high';

export interface JournalEntry {
  /** Numéro monotone dans le run (1-based). */
  readonly seq: number;
  readonly runId: string;
  /** Horodatage ISO (fourni par l'horloge injectée — déterministe en test). */
  readonly at: string;
  readonly phase: JournalPhase;
  readonly tool: string;
  readonly label: string;
  readonly args: Record<string, unknown>;
  readonly mutating: boolean;
  readonly outbound: boolean;
  readonly compliance: ComplianceLevel;
  /** Renseigné pour 'denied' / 'failed'. */
  readonly reason?: string;
  /** Renseigné pour 'executed' : résumé BORNÉ du résultat (jamais le payload complet). */
  readonly resultDigest?: string;
}

export interface ActionOutcome {
  readonly tool: string;
  readonly label: string;
  readonly status: 'executed' | 'planned' | 'denied' | 'failed';
  readonly reason?: string;
}

export interface AgentRunRecord {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly mode: RuntimeMode;
  readonly autonomy: string;
  readonly entries: readonly JournalEntry[];
  readonly outcomes: readonly ActionOutcome[];
  /** true si aucune entrée n'est en échec (les refus de policy ne sont pas des « erreurs »). */
  readonly ok: boolean;
}

/**
 * Accumulateur append-only. Chaque entrée est gelée (Object.freeze) à l'ajout ; `snapshot()` renvoie
 * une copie superficielle du tableau (le journal ne peut être muté par l'appelant).
 */
export class ActionJournal {
  private readonly _entries: JournalEntry[] = [];

  constructor(readonly runId: string) {}

  get size(): number {
    return this._entries.length;
  }

  append(e: Omit<JournalEntry, 'seq' | 'runId'>): JournalEntry {
    const entry: JournalEntry = Object.freeze({ ...e, seq: this._entries.length + 1, runId: this.runId });
    this._entries.push(entry);
    return entry;
  }

  snapshot(): JournalEntry[] {
    return [...this._entries];
  }
}

/** Port de persistance durable du journal (adapter côté API : table/append log). Append-only. */
export interface JournalStore {
  append(entry: JournalEntry): Promise<void>;
  load(runId: string): Promise<JournalEntry[]>;
}

/** Adapter mémoire (tests/démo) : jamais d'update ni de delete. */
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

/**
 * Résumé borné et déterministe d'un résultat d'outil : on ne stocke PAS le payload complet dans le
 * journal (volume + données potentiellement sensibles), seulement une empreinte lisible.
 */
export function digestResult(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return String(value).slice(0, 80);
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .slice(0, 6)
    .map((k) => {
      const v = obj[k];
      const s = v === null || typeof v !== 'object' ? String(v) : `[${Array.isArray(v) ? 'array' : 'object'}]`;
      return `${k}=${s.slice(0, 40)}`;
    });
  return parts.join(', ').slice(0, 200);
}

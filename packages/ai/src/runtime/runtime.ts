import { type AnyTool } from '../tools/tool';
import {
  ActionJournal,
  type JournalEntry,
  type AgentRunRecord,
  type ActionOutcome,
  type RuntimeMode,
  type JournalStore,
  digestResult,
} from './journal';
import { ActionPolicy, type ActionContext } from './permissions';

/** Horloge minimale (structurelle) — compatible ClockPort de @bob/core sans le coupler. */
export interface RuntimeClock {
  now(): string;
}

/** Générateur d'id minimal (structurel) — compatible IdGeneratorPort de @bob/core. */
export interface RuntimeIds {
  newId(): string;
}

export interface RuntimeInvocation {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly label: string;
}

export interface RuntimeOptions {
  /** 'live' (défaut) exécute ; 'dry-run' évalue permissions + validation mais N'EXÉCUTE PAS. */
  readonly mode?: RuntimeMode;
  /** Mode d'autonomie effectif, tracé pour l'audit (pas utilisé pour décider ici). */
  readonly autonomy?: string;
  /** Id de run fourni (rejeu) ; sinon généré. */
  readonly runId?: string;
}

export interface AgentRuntimeDeps {
  readonly tools: readonly AnyTool[];
  readonly clock: RuntimeClock;
  readonly ids: RuntimeIds;
  /** Défaut : tout autorisé. */
  readonly policy?: ActionPolicy;
  /** Optionnel : sink durable (chaque entrée est aussi persistée). */
  readonly store?: JournalStore;
}

/**
 * Runtime agentique : enveloppe l'exécution des outils avec
 *  (1) PERMISSIONS par action (policy),
 *  (2) JOURNAL immuable append-only,
 *  (3) DRY-RUN (aperçu fidèle sans effet de bord),
 *  (4) base de REJEU (via le journal).
 *
 * Ne LÈVE jamais : toute erreur (outil inconnu, args invalides, use case en échec) devient une entrée
 * de journal auditable. En mode 'live', on s'arrête à la 1re action refusée/échouée (fail-fast, cohérent
 * avec le batch de BobAgent) ; en 'dry-run', on évalue TOUT le plan pour un aperçu complet.
 */
export class AgentRuntime {
  private readonly tools: Map<string, AnyTool>;
  private readonly policy: ActionPolicy;

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.tools = new Map(deps.tools.map((t) => [t.name, t]));
    this.policy = deps.policy ?? ActionPolicy.allowAll();
  }

  async run(invocations: readonly RuntimeInvocation[], opts: RuntimeOptions = {}): Promise<AgentRunRecord> {
    const mode: RuntimeMode = opts.mode ?? 'live';
    const runId = opts.runId ?? this.deps.ids.newId();
    const autonomy = opts.autonomy ?? 'unknown';
    const startedAt = this.deps.clock.now();
    const journal = new ActionJournal(runId);
    const outcomes: ActionOutcome[] = [];

    const record = async (e: Omit<JournalEntry, 'seq' | 'runId'>): Promise<void> => {
      const entry = journal.append(e);
      if (this.deps.store) await this.deps.store.append(entry);
    };

    let stopped = false;
    for (const inv of invocations) {
      if (stopped) break; // live : rien ne s'exécute après un échec/refus
      const tool = this.tools.get(inv.tool);
      const base = { at: this.deps.clock.now(), tool: inv.tool, label: inv.label, args: inv.args };

      if (!tool) {
        const reason = `Outil inconnu : ${inv.tool}`;
        await record({ ...base, phase: 'failed', mutating: false, outbound: false, compliance: 'low', reason });
        outcomes.push({ tool: inv.tool, label: inv.label, status: 'failed', reason });
        if (mode === 'live') stopped = true;
        continue;
      }
      const meta = { mutating: tool.mutating, outbound: tool.outbound, compliance: tool.compliance };

      const ctx: ActionContext = { tool, args: inv.args, mode };
      const perm = this.policy.decide(ctx);
      if (!perm.allow) {
        const reason = perm.reason ?? 'Action refusée par la policy.';
        await record({ ...base, ...meta, phase: 'denied', reason });
        outcomes.push({ tool: inv.tool, label: inv.label, status: 'denied', reason });
        if (mode === 'live') stopped = true;
        continue;
      }

      const parsed = tool.parse(inv.args);
      if (!parsed.ok) {
        const reason = describeError(parsed.error);
        await record({ ...base, ...meta, phase: 'failed', reason });
        outcomes.push({ tool: inv.tool, label: inv.label, status: 'failed', reason });
        if (mode === 'live') stopped = true;
        continue;
      }

      // Autorisé + validé -> entrée 'planned' (intention tracée AVANT tout effet).
      await record({ ...base, ...meta, phase: 'planned' });

      if (mode === 'dry-run') {
        outcomes.push({ tool: inv.tool, label: inv.label, status: 'planned' });
        continue;
      }

      const res = await tool.run(parsed.value);
      if (!res.ok) {
        const reason = describeError(res.error);
        await record({ ...base, ...meta, phase: 'failed', reason });
        outcomes.push({ tool: inv.tool, label: inv.label, status: 'failed', reason });
        stopped = true;
        continue;
      }
      const publicResult = tool.projectPublicResult?.(res.value);
      await record({
        ...base,
        ...meta,
        phase: 'executed',
        // Pour un outil qui déclare une projection, le payload brut (token, URL, PII) ne
        // traverse jamais le journal. Sinon on conserve le digest historique borné.
        resultDigest: digestResult(publicResult ?? res.value),
      });
      outcomes.push({
        tool: inv.tool,
        label: inv.label,
        status: 'executed',
        ...(publicResult !== undefined ? { result: publicResult } : {}),
      });
    }

    const entries = journal.snapshot();
    return {
      runId,
      startedAt,
      finishedAt: this.deps.clock.now(),
      mode,
      autonomy,
      entries,
      outcomes,
      ok: entries.every((e) => e.phase !== 'failed'),
    };
  }
}

/** Résumé lisible et borné d'une AppError de @bob/core (sans coupler le type). */
export function describeError(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    if (typeof e.kind === 'string') {
      if (e.kind === 'domain' && e.error && typeof e.error === 'object') {
        const de = e.error as Record<string, unknown>;
        return `domain:${String(de.code ?? '')}${de.message ? ` ${String(de.message)}` : ''}`.trim();
      }
      if (e.kind === 'not_found') return `not_found:${String(e.entity ?? '')}`;
      if (e.kind === 'conflict')
        return `conflict:${String(e.entity ?? '')}${
          e.reason ? ` ${String(e.reason)}` : ''
        }`.trim();
      if (e.kind === 'forbidden') return `forbidden:${String(e.reason ?? '')}`.trim();
      if (e.kind === 'validation') return 'validation';
      if (e.kind === 'dependency') return `dependency:${String(e.port ?? '')}`;
      return String(e.kind);
    }
  }
  return 'error';
}

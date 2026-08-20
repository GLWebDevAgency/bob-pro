/**
 * Scheduler pur de convergence des effets Jarvis (SPEC U1-h L7).
 *
 * La file ne contient que des UUID et des métadonnées de cadence. Aucun snapshot, libellé ou
 * payload métier n'est retenu. Un seul GET vole à la fois ; les erreurs reculent selon un backoff
 * borné et une cible en panne ne bloque pas les suivantes.
 */

import {
  isJarvisRunEffectOutcomePending,
  type AppError,
  type Result,
} from '@bob/core';
import type { JarvisRunSnapshotView, JarvisRunView } from '@bob/api-client';

const MIN_ATTEMPT_INTERVAL_MS = 1_500;
const MAX_FAILURE_BACKOFF_MS = 30_000;
// Tombstones UUID-only : bornés pour qu'une longue session ne devienne jamais un cache historique.
const MAX_SETTLED_RUN_TOMBSTONES = 128;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface JarvisRunConvergenceClock {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimeout: (handle: TimerHandle) => void;
}

const SYSTEM_CLOCK: JarvisRunConvergenceClock = Object.freeze({
  now: Date.now,
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (handle: TimerHandle) => clearTimeout(handle),
});

export type JarvisRunExactReader = (
  runId: string,
  signal: AbortSignal,
) => Promise<Result<JarvisRunSnapshotView, AppError>>;

interface ConvergenceTarget {
  readonly runId: string;
  readonly minimumRevision: number;
  readonly failures: number;
  readonly dueAt: number;
  readonly order: number;
}

interface InFlightRead {
  readonly runId: string;
  readonly controller: AbortController;
}

function failureBackoffMs(failures: number): number {
  const exponent = Math.max(0, Math.min(failures - 1, 20));
  return Math.min(MAX_FAILURE_BACKOFF_MS, MIN_ATTEMPT_INTERVAL_MS * 2 ** exponent);
}

/**
 * Scheduler session-scopé, sans React ni cache de snapshot. Le provider en possède une seule
 * instance ; cette classe reste testable sans timer réel ni montage d'écran.
 */
export class JarvisRunConvergenceCoordinator {
  private readonly targets = new Map<string, ConvergenceTarget>();
  private readonly settledRunIds = new Set<string>();
  private sequence = 0;
  private nextGlobalAttemptAt = 0;
  private timer: TimerHandle | null = null;
  private flight: InFlightRead | null = null;
  private available = false;
  private acceptingObservations = true;
  private activation = 0;

  constructor(
    private readonly readRun: JarvisRunExactReader,
    private readonly onSettled: (runId: string) => void,
    private readonly clock: JarvisRunConvergenceClock = SYSTEM_CLOCK,
  ) {}

  /** Une postimage non pendante n'arme rien ; un même run ne crée jamais deux cibles. */
  observe(run: JarvisRunView): void {
    if (
      !this.acceptingObservations
      || !isJarvisRunEffectOutcomePending(run.status)
      || this.settledRunIds.has(run.runId)
    ) {
      return;
    }
    const known = this.targets.get(run.runId);
    if (known !== undefined) {
      if (run.revision > known.minimumRevision) {
        this.targets.set(run.runId, { ...known, minimumRevision: run.revision });
      }
      return;
    }
    this.targets.set(run.runId, {
      runId: run.runId,
      minimumRevision: run.revision,
      failures: 0,
      dueAt: this.clock.now(),
      order: ++this.sequence,
    });
    this.reschedule();
  }

  /**
   * Réactive l'instance lors du setup React. Le token empêche le faux cleanup StrictMode de
   * purger la file ; un vrai démontage, sans activation suivante, la purge en microtask.
   */
  activate(available: boolean): number {
    const token = ++this.activation;
    this.acceptingObservations = true;
    this.setAvailable(available);
    if (available) this.reschedule();
    return token;
  }

  /**
   * Le cleanup React pause immédiatement, puis purge en microtask seulement si aucun remount
   * StrictMode n'a repris la même instance entre-temps.
   */
  release(token: number): void {
    this.setAvailable(false);
    queueMicrotask(() => {
      if (this.activation === token) this.dispose();
    });
  }

  /**
   * Le pont AppState pilote cette borne via `focusManager`. Passer en arrière-plan annule le timer
   * et le fetch ; la cible reste due et reprend au retour au premier plan.
   */
  setAvailable(available: boolean): void {
    if (this.available === available) return;
    this.available = available;
    if (!available) {
      this.clearTimer();
      // Libérer la voie immédiatement : un transport défectueux peut ignorer AbortSignal et ne
      // jamais régler sa Promise. Sa réponse tardive reste clôturée par le controller aborté et
      // par l'identité de `flight`, tandis qu'un retour au premier plan peut repartir sans famine.
      const flight = this.flight;
      this.flight = null;
      flight?.controller.abort();
      return;
    }
    this.reschedule();
  }

  /** Frontière d'owner/unmount : purge UUID, backoff, tombstones et clôture les callbacks tardifs. */
  dispose(): void {
    this.activation += 1;
    this.acceptingObservations = false;
    this.available = false;
    this.clearTimer();
    const flight = this.flight;
    this.flight = null;
    flight?.controller.abort();
    this.targets.clear();
    this.settledRunIds.clear();
    this.sequence = 0;
    this.nextGlobalAttemptAt = 0;
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private reschedule(): void {
    this.clearTimer();
    if (!this.available || this.flight !== null || this.targets.size === 0) return;

    let candidate: ConvergenceTarget | null = null;
    for (const target of this.targets.values()) {
      if (
        candidate === null
        || target.dueAt < candidate.dueAt
        || (target.dueAt === candidate.dueAt && target.order < candidate.order)
      ) {
        candidate = target;
      }
    }
    if (candidate === null) return;

    const now = this.clock.now();
    const startsAt = Math.max(candidate.dueAt, this.nextGlobalAttemptAt);
    const runId = candidate.runId;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.attempt(runId);
    }, Math.max(0, startsAt - now));
  }

  private async attempt(runId: string): Promise<void> {
    const target = this.targets.get(runId);
    if (!this.available || this.flight !== null || target === undefined) {
      this.reschedule();
      return;
    }

    const controller = new AbortController();
    const flight: InFlightRead = { runId, controller };
    this.flight = flight;
    this.nextGlobalAttemptAt = this.clock.now() + MIN_ATTEMPT_INTERVAL_MS;

    let result: Result<JarvisRunSnapshotView, AppError> | null = null;
    try {
      result = await this.readRun(runId, controller.signal);
    } catch {
      // Une dépendance qui rejette au lieu de rendre Result suit la même loi de backoff.
      result = null;
    }

    if (this.flight === flight) this.flight = null;
    if (controller.signal.aborted || !this.available) {
      this.reschedule();
      return;
    }

    const current = this.targets.get(runId);
    if (current === undefined) {
      this.reschedule();
      return;
    }

    const exactRun = result?.ok === true ? result.value.run : null;
    const isFreshExactEcho =
      exactRun !== null
      && exactRun.runId === runId
      && exactRun.revision >= current.minimumRevision;

    if (isFreshExactEcho && !isJarvisRunEffectOutcomePending(exactRun.status)) {
      try {
        this.onSettled(runId);
      } catch {
        // Ne jamais tombstoner une convergence que l'UI n'a pas pu publier. Le callback runtime
        // est synchrone/no-throw ; ce garde transforme tout écart futur en retry borné.
        const failures = current.failures + 1;
        this.targets.set(runId, {
          ...current,
          failures,
          dueAt: this.clock.now() + failureBackoffMs(failures),
          order: ++this.sequence,
        });
        this.reschedule();
        return;
      }
      this.targets.delete(runId);
      this.settledRunIds.add(runId);
      while (this.settledRunIds.size > MAX_SETTLED_RUN_TOMBSTONES) {
        const oldest = this.settledRunIds.values().next().value as string | undefined;
        if (oldest === undefined) break;
        this.settledRunIds.delete(oldest);
      }
      this.reschedule();
      return;
    }

    const failures = isFreshExactEcho ? 0 : current.failures + 1;
    const delay = isFreshExactEcho ? MIN_ATTEMPT_INTERVAL_MS : failureBackoffMs(failures);
    this.targets.set(runId, {
      runId,
      minimumRevision: isFreshExactEcho
        ? Math.max(current.minimumRevision, exactRun.revision)
        : current.minimumRevision,
      failures,
      dueAt: this.clock.now() + delay,
      order: ++this.sequence,
    });
    this.reschedule();
  }
}

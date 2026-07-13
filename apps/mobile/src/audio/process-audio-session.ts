/**
 * Autorité audio unique du processus mobile.
 *
 * Expo Speech, l'enregistreur historique et WebRTC partagent le même micro / la même
 * sortie. Sans arbitre commun, deux moteurs peuvent s'ouvrir simultanément et dégrader
 * l'AEC, créer de l'écho ou laisser une piste native orpheline.
 */

export type ProcessAudioMode = 'legacy_input' | 'legacy_output' | 'realtime';

export interface ProcessAudioLease {
  readonly generation: number;
  readonly mode: ProcessAudioMode;
  readonly owner: string;
  /** Jeton opaque : ne jamais sérialiser ni exposer à une API. */
  readonly token: symbol;
}

export type ProcessAudioAcquireResult =
  | { readonly ok: true; readonly lease: ProcessAudioLease }
  | { readonly ok: false; readonly reason: 'audio_busy' | 'preempt_failed' | 'preempt_timeout' };

export interface ProcessAudioAcquireInput {
  readonly owner: string;
  readonly mode: ProcessAudioMode;
  /** Seul realtime peut préempter une session legacy. */
  readonly preemptLegacy?: boolean;
  /** Doit libérer explicitement son lease avant de résoudre. */
  readonly onPreempt?: () => void | Promise<void>;
}

interface ActiveAudioSession {
  readonly lease: ProcessAudioLease;
  readonly onPreempt: (() => void | Promise<void>) | null;
}

export interface ProcessAudioSnapshot {
  readonly active: null | Pick<ProcessAudioLease, 'generation' | 'mode' | 'owner'>;
  readonly permissionRequestsInFlight: number;
}

function timeout(ms: number): { promise: Promise<'timeout'>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

export class ProcessAudioSessionCoordinator {
  private active: ActiveAudioSession | null = null;
  private generation = 0;
  private permissionRequests = 0;
  private readonly permissionSettledWaiters = new Set<() => void>();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly preemptTimeoutMs = 2_000) {}

  acquire(input: ProcessAudioAcquireInput): Promise<ProcessAudioAcquireResult> {
    return this.serialized(async () => {
      const current = this.active;
      if (current !== null) {
        const canPreempt = input.mode === 'realtime'
          && input.preemptLegacy === true
          && current.lease.mode !== 'realtime';
        if (!canPreempt) return { ok: false, reason: 'audio_busy' } as const;
        if (!current.onPreempt) return { ok: false, reason: 'preempt_failed' } as const;

        const deadline = timeout(this.preemptTimeoutMs);
        let outcome: 'released' | 'failed' | 'timeout';
        try {
          outcome = await Promise.race([
            Promise.resolve()
              .then(() => current.onPreempt?.())
              .then(() => 'released' as const)
              .catch(() => 'failed' as const),
            deadline.promise,
          ]);
        } finally {
          deadline.cancel();
        }
        if (outcome === 'timeout') return { ok: false, reason: 'preempt_timeout' } as const;
        if (outcome === 'failed' || this.active === current) {
          return { ok: false, reason: 'preempt_failed' } as const;
        }
        // Une autre acquisition gagnante entre la libération et nous est impossible :
        // toutes les acquisitions passent par la même file sérialisée.
      }

      const lease: ProcessAudioLease = Object.freeze({
        generation: ++this.generation,
        mode: input.mode,
        owner: input.owner,
        token: Symbol(`bob-audio:${input.mode}:${input.owner}`),
      });
      this.active = { lease, onPreempt: input.onPreempt ?? null };
      return { ok: true, lease } as const;
    });
  }

  isCurrent(lease: ProcessAudioLease | null | undefined): boolean {
    return lease !== null
      && lease !== undefined
      && this.active?.lease.token === lease.token
      && this.active.lease.generation === lease.generation;
  }

  /** Idempotent et fence par jeton : un callback N ne libère jamais N+1. */
  release(lease: ProcessAudioLease | null | undefined): boolean {
    if (!this.isCurrent(lease)) return false;
    this.active = null;
    return true;
  }

  permissionRequestInFlight(): boolean {
    return this.permissionRequests > 0;
  }

  async withPermissionRequest<T>(run: () => Promise<T>): Promise<T> {
    this.permissionRequests += 1;
    try {
      return await run();
    } finally {
      this.permissionRequests = Math.max(0, this.permissionRequests - 1);
      if (this.permissionRequests === 0) {
        for (const resolve of this.permissionSettledWaiters) resolve();
        this.permissionSettledWaiters.clear();
      }
    }
  }

  waitForPermissionRequests(): Promise<void> {
    if (!this.permissionRequestInFlight()) return Promise.resolve();
    return new Promise((resolve) => this.permissionSettledWaiters.add(resolve));
  }

  snapshot(): ProcessAudioSnapshot {
    const lease = this.active?.lease;
    return {
      active: lease
        ? { generation: lease.generation, mode: lease.mode, owner: lease.owner }
        : null,
      permissionRequestsInFlight: this.permissionRequests,
    };
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const predecessor = this.operationTail;
    let release: () => void = () => undefined;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export const processAudioSession = new ProcessAudioSessionCoordinator();

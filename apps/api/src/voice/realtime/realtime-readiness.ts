import type { SttPort } from '@bob/ai';
import type {
  RealtimeAdmissionPort,
  RealtimeAdmissionResult,
} from './realtime-admission';
import type { BobLiveAcousticProofPort } from './realtime-acoustic-probe';

export type BobLiveRuntimeMode = 'disabled' | 'native' | 'audited';

export type BobLiveRuntimeReadiness =
  | {
      readonly ready: true;
      readonly mode: BobLiveRuntimeMode;
      readonly speechAudit: 'not_applicable' | 'ready';
    }
  | {
      readonly ready: false;
      readonly mode: 'audited';
      readonly speechAudit: 'unavailable';
    };

export interface BobLiveRuntimeReadinessPort {
  check(options?: { readonly fresh?: boolean }): Promise<BobLiveRuntimeReadiness>;
}

const DISABLED_READY = Object.freeze({
  ready: true,
  mode: 'disabled',
  speechAudit: 'not_applicable',
} as const);
const NATIVE_READY = Object.freeze({
  ready: true,
  mode: 'native',
  speechAudit: 'not_applicable',
} as const);
const AUDITED_READY = Object.freeze({
  ready: true,
  mode: 'audited',
  speechAudit: 'ready',
} as const);
const AUDITED_UNAVAILABLE = Object.freeze({
  ready: false,
  mode: 'audited',
  speechAudit: 'unavailable',
} as const);

export class NonAuditedBobLiveRuntimeReadiness implements BobLiveRuntimeReadinessPort {
  private readonly status: typeof DISABLED_READY | typeof NATIVE_READY;

  constructor(mode: 'disabled' | 'native') {
    this.status = mode === 'disabled' ? DISABLED_READY : NATIVE_READY;
  }

  async check(
    _options: { readonly fresh?: boolean } = {},
  ): Promise<typeof DISABLED_READY | typeof NATIVE_READY> {
    return this.status;
  }
}

export interface AuditedBobLiveRuntimeReadinessOptions {
  readonly successTtlMs?: number;
  readonly failureTtlMs?: number;
  readonly probeTimeoutMs?: number;
  readonly acousticSuccessTtlMs?: number;
  readonly acousticFailureTtlMs?: number;
  readonly acousticProbeTimeoutMs?: number;
  readonly now?: () => number;
}

/**
 * Sonde opérationnelle bornée de la chaîne auditée.
 *
 * Le cache très court absorbe une rafale d'admissions sans transformer Whisper en dépendance
 * synchrone par session. `fresh=true` reste disponible pour les preuves de release. Les appels
 * concurrents partagent toujours la même sonde afin de ne pas créer un thundering herd.
 */
export class AuditedBobLiveRuntimeReadiness implements BobLiveRuntimeReadinessPort {
  private readonly successTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly probeTimeoutMs: number;
  private readonly acousticSuccessTtlMs: number;
  private readonly acousticFailureTtlMs: number;
  private readonly acousticProbeTimeoutMs: number;
  private readonly now: () => number;
  private cached: {
    readonly expiresAt: number;
    readonly status: typeof AUDITED_READY | typeof AUDITED_UNAVAILABLE;
  } | null = null;
  private inFlight: Promise<typeof AUDITED_READY | typeof AUDITED_UNAVAILABLE> | null = null;
  private acousticCached: {
    readonly expiresAt: number;
    readonly healthy: boolean;
  } | null = null;
  private acousticInFlight: Promise<boolean> | null = null;

  constructor(
    private readonly auditor: Pick<SttPort, 'health'> | null,
    private readonly acousticProof: BobLiveAcousticProofPort | null,
    options: AuditedBobLiveRuntimeReadinessOptions = {},
  ) {
    this.successTtlMs = options.successTtlMs ?? 5_000;
    this.failureTtlMs = options.failureTtlMs ?? 1_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 2_000;
    this.acousticSuccessTtlMs = options.acousticSuccessTtlMs ?? 15 * 60_000;
    this.acousticFailureTtlMs = options.acousticFailureTtlMs ?? 15_000;
    this.acousticProbeTimeoutMs = options.acousticProbeTimeoutMs ?? 45_000;
    this.now = options.now ?? Date.now;
    if (
      !Number.isSafeInteger(this.successTtlMs)
      || this.successTtlMs < 0
      || !Number.isSafeInteger(this.failureTtlMs)
      || this.failureTtlMs < 0
      || !Number.isSafeInteger(this.probeTimeoutMs)
      || this.probeTimeoutMs < 1
      || !Number.isSafeInteger(this.acousticSuccessTtlMs)
      || this.acousticSuccessTtlMs < 1
      || !Number.isSafeInteger(this.acousticFailureTtlMs)
      || this.acousticFailureTtlMs < 1
      || !Number.isSafeInteger(this.acousticProbeTimeoutMs)
      || this.acousticProbeTimeoutMs < 1
      || this.acousticProbeTimeoutMs > 60_000
    ) {
      throw new Error('bob_live_readiness_invalid_options');
    }
  }

  async check(
    options: { readonly fresh?: boolean } = {},
  ): Promise<typeof AUDITED_READY | typeof AUDITED_UNAVAILABLE> {
    const now = this.now();
    if (!options.fresh && this.cached !== null && this.cached.expiresAt > now) {
      return this.cached.status;
    }
    if (this.inFlight !== null) return this.inFlight;
    const probe = this.probe();
    this.inFlight = probe;
    try {
      const status = await probe;
      this.cached = {
        expiresAt: this.now() + (status.ready ? this.successTtlMs : this.failureTtlMs),
        status,
      };
      return status;
    } finally {
      if (this.inFlight === probe) this.inFlight = null;
    }
  }

  private async probe(): Promise<typeof AUDITED_READY | typeof AUDITED_UNAVAILABLE> {
    if (this.auditor === null || this.acousticProof === null) return AUDITED_UNAVAILABLE;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const health = Promise.resolve()
        .then(() => this.auditor?.health())
        .then((result) => result?.healthy === true)
        .catch(() => false);
      const timedOut = new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), this.probeTimeoutMs);
      });
      const healthy = await Promise.race([health, timedOut]);
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (!healthy) return AUDITED_UNAVAILABLE;
      return await this.acousticReady() ? AUDITED_READY : AUDITED_UNAVAILABLE;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  /**
   * Une readiness `fresh` renouvelle la santé réseau légère, jamais un TTS payant encore valide.
   * Le premier appel d'une nouvelle réplique part sans cache et doit donc exercer la chaîne réelle.
   */
  private async acousticReady(): Promise<boolean> {
    const now = this.now();
    if (this.acousticCached !== null && this.acousticCached.expiresAt > now) {
      return this.acousticCached.healthy;
    }
    if (this.acousticInFlight !== null) return this.acousticInFlight;
    const probe = this.runAcousticProbe();
    this.acousticInFlight = probe;
    try {
      const healthy = await probe;
      this.acousticCached = {
        expiresAt: this.now() + (
          healthy ? this.acousticSuccessTtlMs : this.acousticFailureTtlMs
        ),
        healthy,
      };
      return healthy;
    } finally {
      if (this.acousticInFlight === probe) this.acousticInFlight = null;
    }
  }

  private async runAcousticProbe(): Promise<boolean> {
    if (this.acousticProof === null) return false;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const operation = Promise.resolve()
      .then(() => this.acousticProof?.prove(controller.signal))
      .then((result) => result?.healthy === true)
      .catch(() => false);
    const timedOut = new Promise<false>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort(new DOMException('Bob Live acoustic probe timeout', 'TimeoutError'));
        resolve(false);
      }, this.acousticProbeTimeoutMs);
    });
    try {
      return await Promise.race([operation, timedOut]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

function unavailableAdmission(): RealtimeAdmissionResult {
  return { allowed: false, denial: 'unavailable', retryAt: null };
}

/**
 * Ferme uniquement les nouvelles réservations lorsque la chaîne audio auditée n'est pas prête.
 * Toutes les mutations de session existante et le reaper restent délégués : une panne Whisper
 * ne doit jamais empêcher le drain ni prolonger un bail provider.
 */
export function gateRealtimeAdmissionOnBobLiveReadiness(
  admission: RealtimeAdmissionPort,
  readiness: BobLiveRuntimeReadinessPort,
): RealtimeAdmissionPort {
  return {
    reserve: async (input) => {
      try {
        const status = await readiness.check();
        if (!status.ready) return unavailableAdmission();
      } catch {
        return unavailableAdmission();
      }
      return admission.reserve(input);
    },
    bindProvider: (input) => admission.bindProvider(input),
    activate: (input) => admission.activate(input),
    renew: (input) => admission.renew(input),
    release: (input) => admission.release(input),
    claimExpired: (input) => admission.claimExpired(input),
    resolveSession: (input) => admission.resolveSession(input),
    acknowledgeAgentMissionBootstrap: (input) =>
      admission.acknowledgeAgentMissionBootstrap(input),
    claimTermination: (input) => admission.claimTermination(input),
    completeReaping: (input) => admission.completeReaping(input),
    updateContext: (input) => admission.updateContext(input),
    readContext: (input) => admission.readContext(input),
    acquire: (input) => admission.acquire(input),
  };
}

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
 * Part du TTL succès acoustique au-delà de laquelle un hit de cache déclenche une re-sonde en
 * arrière-plan. Protection production : après un long idle (TTL 15 min), le premier appel qui
 * touche encore le cache le fait rechauffer sans attendre — aucun client ne paie la sonde
 * TTS+Whisper en ligne (~12,4 s mesurés sur le Whisper staging CPU-only).
 */
export const ACOUSTIC_CACHE_REFRESH_AGE_RATIO = 0.8;

/**
 * Budget serveur maximal d'une sonde acoustique TTS+Whisper (~12,4 s mesurés sur le Whisper
 * staging CPU-only ; la borne absorbe le matériel le plus lent). Sert aussi d'ancre au
 * Retry-After des refus fail-closed : voir RESERVE_READINESS_RETRY_AFTER_MS.
 */
export const DEFAULT_ACOUSTIC_PROBE_TIMEOUT_MS = 45_000;

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
    this.acousticProbeTimeoutMs = options.acousticProbeTimeoutMs ?? DEFAULT_ACOUSTIC_PROBE_TIMEOUT_MS;
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
    const cached = this.acousticCached;
    if (cached !== null && cached.expiresAt > now) {
      if (cached.healthy) this.refreshAcousticCacheBeforeExpiry(cached.expiresAt, now);
      return cached.healthy;
    }
    if (this.acousticInFlight !== null) return this.acousticInFlight;
    return this.startAcousticProbe();
  }

  /**
   * Re-sonde NON bloquante d'un cache succès vieillissant (au-delà de
   * ACOUSTIC_CACHE_REFRESH_AGE_RATIO du TTL). Jamais concurrente : elle occupe le slot
   * acousticInFlight partagé. Le hit courant est servi immédiatement ; le résultat de la re-sonde
   * remplace le cache par la vérité la plus fraîche, y compris un échec (fail-closed). Un cache
   * échec n'est jamais rechauffé ici : sa courte expiration repasse par le chemin borné normal.
   */
  private refreshAcousticCacheBeforeExpiry(expiresAt: number, now: number): void {
    if (this.acousticInFlight !== null) return;
    const ageMs = this.acousticSuccessTtlMs - (expiresAt - now);
    const refreshAgeMs = Math.round(this.acousticSuccessTtlMs * ACOUSTIC_CACHE_REFRESH_AGE_RATIO);
    if (ageMs < refreshAgeMs) return;
    void this.startAcousticProbe();
  }

  /**
   * Démarre la sonde acoustique, publie son résultat dans le cache et libère le slot en vol.
   * La promesse rendue n'est jamais rejetée (runAcousticProbe capture tout) : un appelant qui
   * cesse de l'attendre — attente bornée d'une réservation, re-chauffage — ne la tue pas et le
   * cache est chauffé quoi qu'il arrive.
   */
  private startAcousticProbe(): Promise<boolean> {
    const probe = this.runAcousticProbe().then((healthy) => {
      this.acousticCached = {
        expiresAt: this.now() + (
          healthy ? this.acousticSuccessTtlMs : this.acousticFailureTtlMs
        ),
        healthy,
      };
      return healthy;
    });
    this.acousticInFlight = probe;
    void probe
      .catch(() => undefined)
      .finally(() => {
        if (this.acousticInFlight === probe) this.acousticInFlight = null;
      });
    return probe;
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

function unavailableAdmission(retryAt: string | null = null): RealtimeAdmissionResult {
  return { allowed: false, denial: 'unavailable', retryAt };
}

/**
 * Budget d'attente de readiness.check() pendant une réservation.
 *
 * Invariant (course sonde acoustique / budget client) : le bootstrap mobile abandonne à
 * 12 000 ms (REALTIME_BOOTSTRAP_TIMEOUT_MS côté HttpBobClient) alors que la sonde acoustique
 * complète coûte ~12,4 s mesurés sur le Whisper staging CPU-only (budget serveur : 45 s).
 * Payer la sonde en ligne pendant reserve() fait donc abandonner le client, qui pose sa fence
 * d'annulation durable pendant que la réservation aboutit côté serveur — un 409 active_lease
 * que personne ne reçoit. Ce budget court garantit budget client ≫ attente de readiness :
 * au-delà, refus indisponible fail-closed immédiat et la sonde reste EN VOL chauffer le cache.
 */
export const RESERVE_READINESS_WAIT_BUDGET_MS = 2_500;

/**
 * Horizon retryAt renvoyé quand le budget d'attente expire, aligné sur le PIRE budget de sonde
 * restant : la sonde qui nous bloque a démarré au plus tard à l'entrée de check(), donc au moment
 * du refus (budget d'attente écoulé) il lui reste au plus
 * DEFAULT_ACOUSTIC_PROBE_TIMEOUT_MS − RESERVE_READINESS_WAIT_BUDGET_MS avant de publier son
 * verdict dans le cache (succès TTL 15 min, ou échec fail-closed). Un client qui honore
 * Retry-After exactement atterrit donc toujours sur un verdict publié — jamais sur la sonde
 * encore en vol, même sur le Whisper staging CPU-only (~12,4 s mesurés, borne 45 s). Un client
 * qui retente plus tôt essuie simplement un nouveau refus fail-closed borné (2,5 s), sans
 * empoisonner de fence : le mobile régénère un sessionHandle frais à chaque tentative.
 */
export const RESERVE_READINESS_RETRY_AFTER_MS =
  DEFAULT_ACOUSTIC_PROBE_TIMEOUT_MS - RESERVE_READINESS_WAIT_BUDGET_MS;

export interface GateRealtimeAdmissionOnBobLiveReadinessOptions {
  /** Injectable pour les tests ; défaut RESERVE_READINESS_WAIT_BUDGET_MS. */
  readonly reserveReadinessWaitBudgetMs?: number;
  /** Injectable pour les tests ; défaut RESERVE_READINESS_RETRY_AFTER_MS. */
  readonly reserveReadinessRetryAfterMs?: number;
  readonly now?: () => number;
}

type ReadinessWithinBudget =
  | { readonly onTime: true; readonly status: BobLiveRuntimeReadiness }
  | { readonly onTime: false };

/**
 * Attend le check au plus budgetMs. La sonde appartient au module readiness : on cesse de
 * l'attendre sans jamais l'annuler — elle reste en vol et chauffe le cache acoustique. Un rejet
 * du check pendant ou après la course reste observé par les handlers posés ici (aucun rejet
 * non géré) et se propage à l'appelant uniquement s'il survient dans le budget.
 */
async function readinessWithinBudget(
  check: Promise<BobLiveRuntimeReadiness>,
  budgetMs: number,
): Promise<ReadinessWithinBudget> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<ReadinessWithinBudget>((resolve) => {
    timer = setTimeout(() => resolve({ onTime: false }), budgetMs);
  });
  try {
    return await Promise.race([
      check.then((status) => ({ onTime: true as const, status })),
      budget,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Ferme uniquement les nouvelles réservations lorsque la chaîne audio auditée n'est pas prête.
 * Toutes les mutations de session existante et le reaper restent délégués : une panne Whisper
 * ne doit jamais empêcher le drain ni prolonger un bail provider.
 *
 * Une réservation ne paie JAMAIS la sonde acoustique en ligne : au-delà du budget court,
 * refus fail-closed avec le retryAt de la forme d'indisponibilité déjà servie par la route
 * (denial `unavailable` → appUnavailable('bob-live-admission', Retry-After) côté service).
 */
export function gateRealtimeAdmissionOnBobLiveReadiness(
  admission: RealtimeAdmissionPort,
  readiness: BobLiveRuntimeReadinessPort,
  options: GateRealtimeAdmissionOnBobLiveReadinessOptions = {},
): RealtimeAdmissionPort {
  const waitBudgetMs = options.reserveReadinessWaitBudgetMs ?? RESERVE_READINESS_WAIT_BUDGET_MS;
  const retryAfterMs = options.reserveReadinessRetryAfterMs ?? RESERVE_READINESS_RETRY_AFTER_MS;
  const now = options.now ?? Date.now;
  if (
    !Number.isSafeInteger(waitBudgetMs)
    || waitBudgetMs < 1
    || !Number.isSafeInteger(retryAfterMs)
    || retryAfterMs < 1
  ) {
    throw new Error('bob_live_readiness_gate_invalid_options');
  }
  return {
    reserve: async (input) => {
      let outcome: ReadinessWithinBudget;
      try {
        outcome = await readinessWithinBudget(readiness.check(), waitBudgetMs);
      } catch {
        return unavailableAdmission();
      }
      if (!outcome.onTime) {
        // Fail-closed absolu : sans statut ready observé dans le budget, aucune réservation.
        // La sonde laissée en vol chauffe le cache ; le Retry-After aligné sur son pire budget
        // restant garantit qu'un retry qui l'honore atterrit sur un verdict publié, cache chaud.
        return unavailableAdmission(new Date(now() + retryAfterMs).toISOString());
      }
      if (!outcome.status.ready) return unavailableAdmission();
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

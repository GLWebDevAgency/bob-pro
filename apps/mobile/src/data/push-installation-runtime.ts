import type { BobClient } from '@bob/api-client';
import {
  type PushBindingCandidate,
  type PushInstallationStore,
  type PushPayloadMatch,
  type PushRevocationCapability,
} from './push-installation';

export type RuntimePushClient = Pick<
  BobClient,
  'registerDevice' | 'revokeDeviceBinding' | 'replayPushRevocation'
>;

/** Jeton ABA local : seule la transition qui l'a créé peut publier un owner ou le révoquer. */
export interface PushOwnerTransition {
  readonly epoch: number;
  readonly client: RuntimePushClient;
}

export interface PushRuntimeScheduler {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

export interface PushInstallationRuntimeDependencies {
  readonly store: PushInstallationStore;
  readonly scheduler?: PushRuntimeScheduler;
  readonly log?: (message: string) => void;
}

interface OwnerContext {
  readonly ownerKey: string;
  readonly client: RuntimePushClient;
  readonly epoch: number;
}

const nativeScheduler: PushRuntimeScheduler = {
  set: (delayMs, callback) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Orchestrateur réseau du registre push durable.
 *
 * Le store reste l'autorité. Toute transition écrit d'abord son tombstone; les réponses réseau
 * tardives ne peuvent confirmer un owner qui n'est plus courant. Les 202 publics sont rejoués
 * selon le calendrier durable du store et ne sont jamais interprétés comme une preuve.
 */
export class PushInstallationRuntime {
  private readonly scheduler: PushRuntimeScheduler;
  private owner: OwnerContext | null = null;
  private publicClient: RuntimePushClient | null = null;
  private epoch = 0;
  private reconciledEpoch: number | null = null;
  private appActive = false;
  private replayPromise: Promise<void> | null = null;
  private replayTimer: unknown | null = null;
  private replayScheduleGeneration = 0;
  private registrationTail: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly dependencies: PushInstallationRuntimeDependencies) {
    this.scheduler = dependencies.scheduler ?? nativeScheduler;
  }

  /**
   * Ferme synchroniquement l'ancienne fence sans toucher au coffre. Le hash de l'identité et
   * SecureStore peuvent ensuite attendre sans qu'un handler global n'accepte l'ancien owner.
   */
  beginOwnerTransition(client: RuntimePushClient): PushOwnerTransition {
    if (this.disposed) throw new Error('runtime push arrêté');
    const transition = { epoch: ++this.epoch, client };
    this.publicClient = client;
    this.owner = null;
    this.reconciledEpoch = null;
    this.cancelReplayTimer();
    return transition;
  }

  /** Publie l'owner uniquement si aucune transition plus récente n'a gagné entre-temps. */
  async completeOwnerTransition(
    transition: PushOwnerTransition,
    ownerKey: string | null,
  ): Promise<boolean> {
    if (!this.isTransitionCurrent(transition)) return false;
    this.owner =
      ownerKey === null ? null : { ownerKey, client: transition.client, epoch: transition.epoch };
    await this.reconcileOwner(transition.epoch, ownerKey);
    return this.isTransitionCurrent(transition) && this.reconciledEpoch === transition.epoch;
  }

  /** Teardown synchrone : invalide aussi les décisions payload déjà en vol. */
  abortOwnerTransition(transition: PushOwnerTransition): void {
    if (!this.isTransitionCurrent(transition)) return;
    this.epoch += 1;
    this.owner = null;
    this.reconciledEpoch = null;
    this.cancelReplayTimer();
  }

  isTransitionCurrent(transition: PushOwnerTransition, ownerKey?: string | null): boolean {
    if (this.disposed || transition.epoch !== this.epoch || transition.client !== this.publicClient)
      return false;
    if (ownerKey === undefined) return true;
    return ownerKey === null
      ? this.owner === null
      : this.owner?.epoch === transition.epoch && this.owner.ownerKey === ownerKey;
  }

  /** Invalide immédiatement l'ancien owner, puis réconcilie le coffre avant tout nouveau POST. */
  updateOwner(ownerKey: string | null, client: RuntimePushClient): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('runtime push arrêté'));
    if (
      ownerKey !== null &&
      this.owner?.ownerKey === ownerKey &&
      this.reconciledEpoch === this.epoch
    ) {
      this.publicClient = client;
      this.owner = { ...this.owner, client };
      return Promise.resolve();
    }
    const transition = this.beginOwnerTransition(client);
    return this.completeOwnerTransition(transition, ownerKey).then(() => undefined);
  }

  setAppActive(active: boolean): void {
    this.appActive = active && !this.disposed;
    if (!this.appActive) {
      this.cancelReplayTimer();
      return;
    }
    void this.replayDueRevocations();
  }

  registerCurrent(expoPushToken: string, platform: 'ios' | 'android'): Promise<void> {
    const captured = this.owner;
    const operation = this.registrationTail.then(() =>
      this.registerCaptured(captured, expoPushToken, platform),
    );
    this.registrationTail = operation.catch(() => undefined);
    return operation;
  }

  private async registerCaptured(
    captured: OwnerContext | null,
    expoPushToken: string,
    platform: 'ios' | 'android',
  ): Promise<void> {
    if (
      captured === null ||
      this.reconciledEpoch !== captured.epoch ||
      captured.epoch !== this.epoch
    )
      throw new Error('owner push non réconcilié');

    const candidate = await this.dependencies.store.prepareBinding(
      captured.ownerKey,
      expoPushToken,
    );
    if (!this.isCurrent(captured)) {
      await this.dependencies.store.prepareRevocationIfExact(candidate);
      this.scheduleReplay();
      throw new Error('owner push remplacé');
    }

    let bound = await this.submitBinding(captured.client, candidate, platform);
    if (bound === 'superseded') {
      const recovered = await this.dependencies.store.rotateAfterSuperseded(candidate);
      if (recovered === null || !this.isCurrent(captured)) {
        this.scheduleReplay();
        throw new Error('binding push superseded hors contexte');
      }
      bound = await this.submitBinding(captured.client, recovered, platform);
      if (bound !== 'bound') {
        throw new Error('binding push superseded après rotation');
      }
      if (!this.isCurrent(captured) || !(await this.dependencies.store.confirmBinding(recovered))) {
        await this.dependencies.store.prepareRevocationIfExact(recovered);
        this.scheduleReplay();
        throw new Error('confirmation push devenue obsolète');
      }
    } else if (
      !this.isCurrent(captured) ||
      !(await this.dependencies.store.confirmBinding(candidate))
    ) {
      await this.dependencies.store.prepareRevocationIfExact(candidate);
      this.scheduleReplay();
      throw new Error('confirmation push devenue obsolète');
    }

    await this.replayDueRevocations();
  }

  /** Cleanup explicite tant que l'ancien JWT est encore disponible. */
  async revokeOwnerAuthenticated(ownerKey: string, client: RuntimePushClient): Promise<void> {
    const capability = await this.dependencies.store.prepareRevocation(ownerKey);
    if (capability === null) return;
    const result = await client.revokeDeviceBinding(this.revocationInput(capability));
    if (result.ok && result.value.accepted === true) {
      await this.dependencies.store.confirmAuthenticatedRevocation(capability);
      this.scheduleReplay();
      return;
    }
    this.scheduleReplay();
    throw new Error('révocation push authentifiée indisponible');
  }

  /**
   * Révocation de permission liée à une transition exacte. Une réponse async d'un ancien effet
   * ne peut ni viser le nouvel owner, ni révoquer une candidate ABA plus récente du même owner.
   */
  async revokeTransitionOwnerAuthenticated(
    transition: PushOwnerTransition,
    ownerKey: string,
  ): Promise<boolean> {
    if (!this.isTransitionCurrent(transition, ownerKey)) return false;
    const state = await this.dependencies.store.snapshot();
    if (!this.isTransitionCurrent(transition, ownerKey)) return false;
    const active = state.active;
    if (active === null) return true;
    if (active.ownerKey !== ownerKey) return false;
    const capability = await this.dependencies.store.prepareRevocationIfActiveFence({
      installationId: state.installationId,
      ownerKey: active.ownerKey,
      bindingId: active.bindingId,
      bindingGeneration: active.generation,
    });
    if (capability === null) {
      const current = await this.dependencies.store.snapshot();
      return this.isTransitionCurrent(transition, ownerKey) && current.active === null;
    }
    let result: Awaited<ReturnType<RuntimePushClient['revokeDeviceBinding']>>;
    try {
      result = await transition.client.revokeDeviceBinding(this.revocationInput(capability));
    } catch {
      // Le tombstone est déjà durable. Une exception d'adapter ne doit ni réactiver le cache
      // permission, ni empêcher la boucle publique de reprendre la preuve plus tard.
      this.scheduleReplay();
      return true;
    }
    if (result.ok && result.value.accepted === true) {
      await this.dependencies.store.confirmAuthenticatedRevocation(capability);
      this.scheduleReplay();
      return true;
    }
    this.scheduleReplay();
    // Le tombstone write-ahead est l'autorité locale. La preuve réseau sera rejouée sans jamais
    // réactiver ce binding dans le cache permission.
    return true;
  }

  async replayDueRevocations(force = false): Promise<void> {
    if (this.replayPromise !== null) return this.replayPromise;
    const client = this.publicClient;
    if (client === null || this.disposed) return;
    const operation = (async () => {
      const capabilities = await this.dependencies.store.dueRevocations(force);
      for (const capability of capabilities) {
        let succeeded = false;
        try {
          const result = await client.replayPushRevocation(this.revocationInput(capability));
          succeeded = result.ok && result.value.accepted === true;
        } catch {
          // L'état durable porte le backoff; aucune donnée de capacité n'est journalisée.
        }
        await this.dependencies.store.recordReplayAttempt(capability, succeeded);
      }
    })()
      .catch(() => {
        this.dependencies.log?.('replay push durable indisponible');
      })
      .finally(() => {
        if (this.replayPromise === operation) this.replayPromise = null;
        this.scheduleReplay();
      });
    this.replayPromise = operation;
    return operation;
  }

  async matchPayload(payload: unknown): Promise<PushPayloadMatch> {
    const epoch = this.epoch;
    if (this.reconciledEpoch !== epoch) return 'not_ready';
    const decision = await this.dependencies.store.matchesPayload(payload);
    return epoch === this.epoch && this.reconciledEpoch === epoch ? decision : 'not_ready';
  }

  dispose(): void {
    this.disposed = true;
    this.owner = null;
    this.publicClient = null;
    this.reconciledEpoch = null;
    this.cancelReplayTimer();
  }

  private async reconcileOwner(epoch: number, ownerKey: string | null): Promise<void> {
    const state = await this.dependencies.store.snapshot();
    if (epoch !== this.epoch || this.disposed) return;
    if (state.active !== null && state.active.ownerKey !== ownerKey) {
      await this.dependencies.store.prepareRevocationIfActiveFence({
        installationId: state.installationId,
        ownerKey: state.active.ownerKey,
        bindingId: state.active.bindingId,
        bindingGeneration: state.active.generation,
      });
    }
    if (epoch !== this.epoch || this.disposed) return;
    this.reconciledEpoch = epoch;
    await this.replayDueRevocations();
  }

  private async submitBinding(
    client: RuntimePushClient,
    candidate: PushBindingCandidate,
    platform: 'ios' | 'android',
  ): Promise<'bound' | 'superseded'> {
    const result = await client.registerDevice({
      expoPushToken: candidate.expoPushToken,
      platform,
      installationId: candidate.installationId,
      bindingId: candidate.bindingId,
      bindingGeneration: candidate.bindingGeneration,
      revocationSecret: candidate.revocationSecret,
    });
    if (!result.ok) throw new Error('enregistrement push refusé');
    return result.value.status;
  }

  private revocationInput(capability: PushRevocationCapability) {
    return {
      installationId: capability.installationId,
      throughGeneration: capability.throughGeneration,
      revocationSecret: capability.revocationSecret,
    };
  }

  private isCurrent(context: OwnerContext): boolean {
    return (
      !this.disposed &&
      this.owner !== null &&
      this.owner.epoch === context.epoch &&
      this.owner.ownerKey === context.ownerKey &&
      this.reconciledEpoch === context.epoch
    );
  }

  private scheduleReplay(): void {
    this.cancelReplayTimer();
    if (!this.appActive || this.publicClient === null || this.disposed) return;
    const generation = this.replayScheduleGeneration;
    void this.dependencies.store
      .nextReplayDelayMs()
      .then((delayMs) => {
        if (
          generation !== this.replayScheduleGeneration ||
          delayMs === null ||
          !this.appActive ||
          this.disposed
        )
          return;
        this.replayTimer = this.scheduler.set(delayMs, () => {
          if (generation !== this.replayScheduleGeneration) return;
          this.replayTimer = null;
          void this.replayDueRevocations();
        });
      })
      .catch(() => {
        this.dependencies.log?.('planification replay push indisponible');
      });
  }

  private cancelReplayTimer(): void {
    this.replayScheduleGeneration += 1;
    if (this.replayTimer === null) return;
    this.scheduler.clear(this.replayTimer);
    this.replayTimer = null;
  }
}

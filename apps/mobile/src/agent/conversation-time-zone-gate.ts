import {
  parseIanaTimeZone,
  type ConfirmedTimeZone,
} from '@bob/core';

export interface ConversationTimeZoneConfirmationState {
  readonly phase: 'choosing' | 'saving';
  readonly suggestedTimeZone: string | null;
  readonly detectionRevision: number;
  readonly issue: 'detection_unavailable' | 'confirmation_failed' | null;
}

export interface ConversationTimeZoneSaveReceipt {
  readonly timeZone: string;
  readonly confirmedAt: string;
  readonly requiresSessionRefresh: boolean;
}

export interface ConversationTimeZoneConfirmationOperations {
  save(timeZone: string): Promise<ConversationTimeZoneSaveReceipt | null>;
  refreshAuthority(): Promise<ConfirmedTimeZone | null>;
}

interface TimeZoneGate {
  readonly id: number;
  readonly promise: Promise<boolean>;
  readonly resolve: (confirmed: boolean) => void;
  readonly state: ConversationTimeZoneConfirmationState;
}

interface TimeZoneConfirmationFlight {
  readonly gateId: number;
  readonly timeZone: string;
  readonly promise: Promise<void>;
}

/**
 * Arbitre pur du consentement fuseau.
 *
 * Il fournit l'exclusion same-frame qui manque à un simple `useState`, invalide les réponses
 * réseau tardives par gateId et ne produit jamais de fuseau par défaut.
 */
export class ConversationTimeZoneGateCoordinator {
  private gateSequence = 0;
  private gate: TimeZoneGate | null = null;
  private flight: TimeZoneConfirmationFlight | null = null;

  constructor(
    private readonly publish: (
      state: ConversationTimeZoneConfirmationState | null,
    ) => void,
  ) {}

  require(suggestedTimeZone: string | null): Promise<boolean> {
    if (this.gate !== null) return this.gate.promise;
    const canonicalSuggestion = parseIanaTimeZone(suggestedTimeZone);
    let resolve!: (confirmed: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    const state: ConversationTimeZoneConfirmationState = {
      phase: 'choosing',
      suggestedTimeZone: canonicalSuggestion,
      detectionRevision: 1,
      issue: canonicalSuggestion === null ? 'detection_unavailable' : null,
    };
    this.gate = {
      id: ++this.gateSequence,
      promise,
      resolve,
      state,
    };
    this.publish(state);
    return promise;
  }

  redetect(suggestedTimeZone: string | null): void {
    const gate = this.gate;
    if (gate === null || gate.state.phase === 'saving') return;
    const canonicalSuggestion = parseIanaTimeZone(suggestedTimeZone);
    const state: ConversationTimeZoneConfirmationState = {
      phase: 'choosing',
      suggestedTimeZone: canonicalSuggestion,
      detectionRevision: gate.state.detectionRevision + 1,
      issue: canonicalSuggestion === null ? 'detection_unavailable' : null,
    };
    this.gate = { ...gate, state };
    this.publish(state);
  }

  cancel(): void {
    const gate = this.gate;
    if (gate === null || gate.state.phase === 'saving') return;
    this.gate = null;
    this.gateSequence += 1;
    this.publish(null);
    gate.resolve(false);
  }

  invalidate(): void {
    const gate = this.gate;
    this.gate = null;
    this.gateSequence += 1;
    this.publish(null);
    gate?.resolve(false);
  }

  confirm(
    rawTimeZone: string,
    operations: ConversationTimeZoneConfirmationOperations,
  ): Promise<void> {
    const gate = this.gate;
    const timeZone = parseIanaTimeZone(rawTimeZone.trim());
    if (gate === null || timeZone === null) return Promise.resolve();
    if (this.flight !== null) return this.flight.promise;

    const gateId = gate.id;
    const savingState: ConversationTimeZoneConfirmationState = {
      ...gate.state,
      phase: 'saving',
      issue: null,
    };
    this.gate = { ...gate, state: savingState };
    this.publish(savingState);

    let flight!: TimeZoneConfirmationFlight;
    const promise = (async (): Promise<void> => {
      try {
        const receipt = await operations.save(timeZone);
        if (!this.isCurrent(gateId)) return;
        if (
          receipt === null
          || receipt.requiresSessionRefresh !== true
          || receipt.timeZone !== timeZone
        ) {
          this.fail(gateId);
          return;
        }

        const refreshedAuthority = await operations.refreshAuthority();
        if (!this.isCurrent(gateId)) return;
        if (
          refreshedAuthority?.timeZone !== receipt.timeZone
          || refreshedAuthority.confirmedAt !== receipt.confirmedAt
        ) {
          this.fail(gateId);
          return;
        }
        this.settle(gateId);
      } catch {
        if (this.isCurrent(gateId)) this.fail(gateId);
      } finally {
        if (this.flight === flight) this.flight = null;
      }
    })();
    flight = { gateId, timeZone, promise };
    this.flight = flight;
    return promise;
  }

  private isCurrent(gateId: number): boolean {
    return this.gate?.id === gateId;
  }

  private fail(gateId: number): void {
    const gate = this.gate;
    if (gate === null || gate.id !== gateId) return;
    const state: ConversationTimeZoneConfirmationState = {
      ...gate.state,
      phase: 'choosing',
      issue: 'confirmation_failed',
    };
    this.gate = { ...gate, state };
    this.publish(state);
  }

  private settle(gateId: number): void {
    const gate = this.gate;
    if (gate === null || gate.id !== gateId) return;
    this.gate = null;
    this.publish(null);
    gate.resolve(true);
  }
}

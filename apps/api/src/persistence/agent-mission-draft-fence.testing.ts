import type {
  AgentMissionDraftFencePort,
  AgentMissionDraftFenceResult,
  AgentMissionOwner,
} from '@bob/core';

/** Double strictement test-only ; exclu de l'artefact par tsconfig.build et la garde de bundle. */
export class InMemoryAgentMissionDraftFence implements AgentMissionDraftFencePort {
  private owned = false;
  private companyUnavailable: 'missing' | 'closed' | null = null;
  private foregroundUnavailable:
    | 'lock_timeout'
    | 'query_canceled'
    | 'transaction_timeout'
    | null = null;

  setOwned(owned: boolean): void {
    this.owned = owned;
  }

  setCompanyUnavailable(reason: 'missing' | 'closed' | null): void {
    this.companyUnavailable = reason;
  }

  setForegroundUnavailable(
    reason: 'lock_timeout' | 'query_canceled' | 'transaction_timeout' | null,
  ): void {
    this.foregroundUnavailable = reason;
  }

  async runLegacyMutationIfUnowned<T>(
    _owner: AgentMissionOwner,
    work: () => Promise<T>,
  ): Promise<AgentMissionDraftFenceResult<T>> {
    if (this.companyUnavailable !== null) {
      return { status: 'company_unavailable', reason: this.companyUnavailable };
    }
    if (this.foregroundUnavailable !== null) {
      return { status: 'foreground_unavailable', reason: this.foregroundUnavailable };
    }
    return this.owned
      ? { status: 'owned_by_agent_mission' }
      : { status: 'executed', value: await work() };
  }
}

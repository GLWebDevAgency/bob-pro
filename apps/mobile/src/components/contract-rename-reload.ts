/**
 * Relecture autoritative après un renommage de contrat ou un conflit CAS.
 *
 * Le coordinateur est volontairement indépendant de React Query : l'écran lui fournit le
 * refetch réel et il n'accepte comme succès qu'une projection du même contrat, à une révision
 * au moins égale à celle attendue. Son single-flight est synchrone, donc deux taps reçus dans
 * le même batch React ne peuvent pas lancer deux requêtes ni deux annonces.
 */

export interface ContractRenameReloadContract {
  readonly id: string;
  readonly revision: number;
  readonly label: string;
}

export interface ContractRenameReloadView {
  readonly contract: ContractRenameReloadContract;
}

export interface ContractRenameRefetchResult {
  readonly isError: boolean;
  readonly error?: unknown;
  readonly data?: ContractRenameReloadView | null;
}

export type ContractRenameReloadOutcome =
  | { readonly kind: 'reloaded'; readonly contract: ContractRenameReloadContract }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' };

export interface ContractRenameReloadInput {
  readonly contractId: string;
  /** Révision minimale qui prouve que le refetch a dépassé la vue périmée. */
  readonly minimumRevision: number;
  readonly refetch: () => Promise<ContractRenameRefetchResult>;
}

function validContract(
  value: unknown,
  input: Pick<ContractRenameReloadInput, 'contractId' | 'minimumRevision'>,
): ContractRenameReloadContract | null {
  if (typeof value !== 'object' || value === null) return null;
  const contract = value as Partial<ContractRenameReloadContract>;
  if (
    contract.id !== input.contractId
    || typeof contract.revision !== 'number'
    || !Number.isSafeInteger(contract.revision)
    || contract.revision < input.minimumRevision
    || typeof contract.label !== 'string'
  ) {
    return null;
  }
  return {
    id: contract.id,
    revision: contract.revision,
    label: contract.label,
  };
}

export function isMaintenanceContractNotFound(error: unknown, contractId: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { kind?: unknown; entity?: unknown; id?: unknown };
  return (
    candidate.kind === 'not_found'
    && candidate.entity === 'maintenance_contract'
    && candidate.id === contractId
  );
}

export class ContractRenameReloadCoordinator {
  private inFlight: Promise<ContractRenameReloadOutcome> | null = null;

  get isRunning(): boolean {
    return this.inFlight !== null;
  }

  reload(input: ContractRenameReloadInput): Promise<ContractRenameReloadOutcome> {
    if (this.inFlight !== null) return this.inFlight;
    const task = this.execute(input);
    this.inFlight = task;
    void task.finally(() => {
      if (this.inFlight === task) this.inFlight = null;
    });
    return task;
  }

  private async execute(
    input: ContractRenameReloadInput,
  ): Promise<ContractRenameReloadOutcome> {
    try {
      const result = await input.refetch();
      // React Query peut conserver une ancienne `data` avec `isError=true` après un refetch
      // raté. Cette donnée n'est jamais une preuve de fraîcheur.
      if (result.isError) {
        return isMaintenanceContractNotFound(result.error, input.contractId)
          ? { kind: 'missing' }
          : { kind: 'unavailable' };
      }
      const contract = validContract(result.data?.contract, input);
      return contract === null
        ? { kind: 'unavailable' }
        : { kind: 'reloaded', contract };
    } catch (error) {
      return isMaintenanceContractNotFound(error, input.contractId)
        ? { kind: 'missing' }
        : { kind: 'unavailable' };
    }
  }
}

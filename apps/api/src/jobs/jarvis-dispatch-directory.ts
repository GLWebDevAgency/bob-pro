/** Borne absolue partagée avec les CHECK et fonctions PostgreSQL U1-l. */
export const JARVIS_DISPATCH_DIRECTORY_MAX_PAGE_SIZE = 50;

/** Borne du worker N. Une redelivery peut être plus grande après un downgrade, jamais une fresh page. */
export const JARVIS_DISPATCH_DIRECTORY_RUNTIME_PAGE_SIZE = 25;

/** Lease dure normative d'une génération de claim ; aucun renew/start ne la prolonge. */
export const JARVIS_DISPATCH_DIRECTORY_HARD_LEASE_MS = 5 * 60_000;

/** Marge retranchée du budget base avant d'armer le watchdog monotone du worker. */
export const JARVIS_DISPATCH_DIRECTORY_WATCHDOG_MARGIN_MS = 5_000;

export interface JarvisDispatchDirectoryClaimInput {
  readonly companyId: string;
  readonly limit: number;
}

/** Identité minimale d'un work item, indépendante de tout adapter de persistence. */
export interface JarvisDispatchCoordinates {
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly runId: string;
}

export interface JarvisDispatchDirectoryClaimedCoordinate {
  /** Position absolue dans la page persistée, jamais renumérotée lors d'une reprise. */
  readonly position: number;
  readonly coordinates: JarvisDispatchCoordinates;
}

interface JarvisDispatchDirectoryOwnedPage {
  readonly claimId: string;
  readonly pageSize: number;
  readonly hasMore: boolean;
  readonly replayed: boolean;
  /** Budget monotone conservateur déjà diminué du temps de requête et de la marge. */
  readonly hardLeaseRemainingMs: number;
}

export type JarvisDispatchDirectoryClaimResult =
  | ({
      readonly status: 'claimed';
      readonly entries: readonly JarvisDispatchDirectoryClaimedCoordinate[];
    } & JarvisDispatchDirectoryOwnedPage)
  | ({ readonly status: 'ack_ready' } & JarvisDispatchDirectoryOwnedPage)
  | { readonly status: 'empty' }
  | { readonly status: 'busy' }
  | { readonly status: 'unavailable' };

export interface JarvisDispatchDirectoryClaimCommand {
  readonly companyId: string;
  readonly claimId: string;
}

export interface JarvisDispatchDirectoryStartCommand
  extends JarvisDispatchDirectoryClaimCommand {
  readonly position: number;
}

export type JarvisDispatchDirectoryRenewResult =
  | { readonly status: 'succeeded'; readonly renewed: boolean }
  | { readonly status: 'unavailable' };

export type JarvisDispatchDirectoryStartResult =
  | { readonly status: 'succeeded'; readonly started: boolean }
  | { readonly status: 'unavailable' };

export type JarvisDispatchDirectoryAckResult =
  | { readonly status: 'succeeded'; readonly acknowledged: boolean }
  | { readonly status: 'unavailable' };

/**
 * Autorité globale minimale de découverte Jarvis.
 *
 * Le binaire N ne possède volontairement aucune méthode stateless v1. SQL v1 reste déployé
 * uniquement pour l'image N-1 pendant l'expand et sa compatibilité est certifiée directement en
 * PostgreSQL.
 */
export interface JarvisDispatchRunDirectoryPort {
  claimDispatchCoordinates(
    input: JarvisDispatchDirectoryClaimInput,
  ): Promise<JarvisDispatchDirectoryClaimResult>;
  renewDispatchCoordinatesClaim(
    input: JarvisDispatchDirectoryClaimCommand,
  ): Promise<JarvisDispatchDirectoryRenewResult>;
  startDispatchCoordinate(
    input: JarvisDispatchDirectoryStartCommand,
  ): Promise<JarvisDispatchDirectoryStartResult>;
  acknowledgeDispatchCoordinates(
    input: JarvisDispatchDirectoryClaimCommand,
  ): Promise<JarvisDispatchDirectoryAckResult>;
}

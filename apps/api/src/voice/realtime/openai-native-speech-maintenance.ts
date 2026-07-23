/**
 * Capacité de maintenance du registre audio OpenAI natif.
 *
 * Elle reste séparée du repository request-time : un service qui prépare ou accuse réception
 * d'une diffusion n'obtient jamais, par construction, le pouvoir de purger son historique.
 */

export const OPENAI_NATIVE_SPEECH_MAINTENANCE_MAX_BATCH = 100;
export const OPENAI_NATIVE_SPEECH_MAINTENANCE_MAX_TENANTS = 1_000;

export interface OpenAiNativeSpeechMaintenanceInput {
  readonly companyId: string;
  readonly limit: number;
}

export type OpenAiNativeSpeechMaintenanceLane = 'expiry' | 'retention';

export interface OpenAiNativeSpeechMaintenanceDueTenantsInput {
  readonly lane: OpenAiNativeSpeechMaintenanceLane;
  readonly limit: number;
}

export interface OpenAiNativeSpeechMaintenanceClaimInput {
  readonly lane: OpenAiNativeSpeechMaintenanceLane;
  readonly claimId: string;
}

export type OpenAiNativeSpeechDueTenantsResult =
  | {
      readonly status: 'succeeded';
      readonly companyIds: readonly string[];
      /** Le scan keyset a rencontré une sentinelle au-delà de sa borne courante. */
      readonly hasMore: boolean;
      /** Lease durable de la page ; nul uniquement lorsqu'aucun travail n'a été revendiqué. */
      readonly claimId: string | null;
    }
  | { readonly status: 'unavailable' };

export type OpenAiNativeSpeechClaimAckResult =
  | { readonly status: 'succeeded'; readonly acknowledged: boolean }
  | { readonly status: 'unavailable' };

export type OpenAiNativeSpeechClaimRenewResult =
  | { readonly status: 'succeeded'; readonly renewed: boolean }
  | { readonly status: 'unavailable' };

export type OpenAiNativeSpeechReapResult =
  | {
      readonly status: 'succeeded';
      readonly expiredCount: number;
      /** Indice borné : un lot plein mérite un nouveau passage, sans prétendre compter le backlog. */
      readonly hasMore: boolean;
    }
  | { readonly status: 'unavailable' };

export type OpenAiNativeSpeechPurgeResult =
  | {
      readonly status: 'succeeded';
      readonly purgedCount: number;
      /** Compte borné à `limit`, jamais présenté comme la taille exacte du backlog. */
      readonly dependenciesBlocked: number;
      /** Indice borné : un lot plein mérite un nouveau passage. */
      readonly hasMore: boolean;
    }
  | { readonly status: 'unavailable' };

export interface OpenAiNativeSpeechMaintenancePort {
  /** Découvre uniquement les tenants dus via un curseur DB global durable et borné. */
  listDueCompanyIds(
    input: OpenAiNativeSpeechMaintenanceDueTenantsInput,
  ): Promise<OpenAiNativeSpeechDueTenantsResult>;
  /** Avance le curseur uniquement après traitement complet de la page durable revendiquée. */
  acknowledgeDueCompanyIds(
    input: OpenAiNativeSpeechMaintenanceClaimInput,
  ): Promise<OpenAiNativeSpeechClaimAckResult>;
  /** Renouvelle le lease exact avant chaque transaction tenantée bornée. */
  renewDueCompanyIdsClaim(
    input: OpenAiNativeSpeechMaintenanceClaimInput,
  ): Promise<OpenAiNativeSpeechClaimRenewResult>;
  /** Terminalise par horloge DB les livraisons non terminales arrivées à échéance. */
  reapExpired(input: OpenAiNativeSpeechMaintenanceInput): Promise<OpenAiNativeSpeechReapResult>;
  /** Purge les preuves terminales dont la rétention DB est échue et qui n'ont aucune dépendance. */
  purgeRetained(input: OpenAiNativeSpeechMaintenanceInput): Promise<OpenAiNativeSpeechPurgeResult>;
}

/** Aucun double local ne fabrique une expiration ou une suppression de preuve durable. */
export class DisabledOpenAiNativeSpeechMaintenance
implements OpenAiNativeSpeechMaintenancePort {
  async listDueCompanyIds(
    _input: OpenAiNativeSpeechMaintenanceDueTenantsInput,
  ): Promise<OpenAiNativeSpeechDueTenantsResult> {
    return { status: 'unavailable' };
  }

  async reapExpired(
    _input: OpenAiNativeSpeechMaintenanceInput,
  ): Promise<OpenAiNativeSpeechReapResult> {
    return { status: 'unavailable' };
  }

  async acknowledgeDueCompanyIds(
    _input: OpenAiNativeSpeechMaintenanceClaimInput,
  ): Promise<OpenAiNativeSpeechClaimAckResult> {
    return { status: 'unavailable' };
  }

  async renewDueCompanyIdsClaim(
    _input: OpenAiNativeSpeechMaintenanceClaimInput,
  ): Promise<OpenAiNativeSpeechClaimRenewResult> {
    return { status: 'unavailable' };
  }

  async purgeRetained(
    _input: OpenAiNativeSpeechMaintenanceInput,
  ): Promise<OpenAiNativeSpeechPurgeResult> {
    return { status: 'unavailable' };
  }
}

/**
 * Appareils enregistrés pour le push Expo (C25).
 *
 * Invariant de confidentialité : un token Expo ne peut appartenir qu'à un seul tenant/utilisateur
 * à la fois. `register` transfère atomiquement ce token vers le principal courant ; il n'ajoute
 * jamais une deuxième ligne cross-tenant. `removeByToken` reste tenant-scopé pour qu'une
 * déconnexion ne puisse révoquer que le binding qu'elle possède encore.
 */

export interface DeviceRecord {
  id: string;
  companyId: string;
  /** Sub du JWT (traçabilité multi-utilisateur) — null en démo. */
  userId: string | null;
  /** Token Expo Push (ExponentPushToken[...]). */
  expoPushToken: string;
  platform: string | null;
  /** Identité stable de l'installation, absente uniquement pour une ligne legacy N-1. */
  installationId: string | null;
  /** Binding opaque neuf à chaque principal ; protège une reconnexion d'un DELETE tardif. */
  bindingId: string | null;
  bindingGeneration: number | null;
  /** SHA-256 du secret SecureStore ; le secret brut ne quitte jamais le mobile hors révocation. */
  revocationSecretHash: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Vue minimale remise au worker d'envoi. Les capacités de révocation n'en sortent jamais. */
export interface PushDeliveryTarget {
  expoPushToken: string;
  platform: string | null;
  bindingId: string;
  bindingGeneration: number;
  updatedAt: string;
}

export interface InvalidPushDeliveryTarget {
  companyId: string;
  expoPushToken: string;
  bindingId: string;
  bindingGeneration: number;
}

export interface RegisterDeviceInput {
  id: string;
  companyId: string;
  userId: string | null;
  expoPushToken: string;
  platform: string | null;
  installationId: string;
  bindingId: string;
  bindingGeneration: number;
  revocationSecretHash: string;
  now: string;
}

export interface RevokeDeviceThroughInput {
  installationId: string;
  /** High-water mark inclusif : révoque toute génération serveur <= cette valeur. */
  throughGeneration: number;
  revocationSecretHash: string;
  scope:
    | { kind: 'authenticated'; companyId: string; userId: string | null }
    | { kind: 'public' };
}

export type DeviceRegistrationResult =
  | { readonly status: 'bound'; readonly device: DeviceRecord }
  | { readonly status: 'superseded' };

export interface DeviceRepository {
  /** Idempotent dans un tenant, rebind atomique si le token appartenait à un autre tenant. */
  register(input: RegisterDeviceInput): Promise<DeviceRegistrationResult>;
  /**
   * Cibles v2 actives uniquement. Les lignes legacy et bindings non réconciliés depuis le cutoff
   * sont exclus fail-closed ; aucun hash de capacité n'est exposé au worker.
   */
  listDeliveryTargetsByCompany(companyId: string, confirmedAfter: string): Promise<PushDeliveryTarget[]>;
  /** Compatibilité N-1 bornée au principal exact ; ne peut jamais révoquer un binding v2. */
  revokeLegacyOwnerToken(companyId: string, userId: string | null, expoPushToken: string): Promise<void>;
  /** Purge provider interne, liée au binding effectivement envoyé pour résister à un rebind tardif. */
  removeInvalidDeliveryTarget(input: InvalidPushDeliveryTarget): Promise<void>;
  /** Révocation publique one-way : aucun booléen d'existence ne doit être retourné. */
  revokeThroughGeneration(input: RevokeDeviceThroughInput): Promise<void>;
  /** Clôture de compte (CloseAccount) : purge TOUT push pour ce tenant — capacité serveur, ne
   *  repose PAS sur le secret de révocation détenu par chaque appareil (celui-ci reste un
   *  protocole client-initié résistant au vol de JWT). Best-effort, jamais bloquant. */
  deleteAllForCompany(companyId: string): Promise<void>;
}

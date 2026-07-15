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
  createdAt: string;
  updatedAt: string;
}

export interface RegisterDeviceInput {
  id: string;
  companyId: string;
  userId: string | null;
  expoPushToken: string;
  platform: string | null;
  now: string;
}

export interface DeviceRepository {
  /** Idempotent dans un tenant, rebind atomique si le token appartenait à un autre tenant. */
  register(input: RegisterDeviceInput): Promise<DeviceRecord>;
  listByCompany(companyId: string): Promise<DeviceRecord[]>;
  /** Retire un token invalidé (ticket Expo DeviceNotRegistered). Idempotent. */
  removeByToken(companyId: string, expoPushToken: string): Promise<void>;
}

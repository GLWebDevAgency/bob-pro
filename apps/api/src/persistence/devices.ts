/**
 * Appareils enregistrés pour le push Expo (C25) — un token par device, company-scoped (RLS).
 * L'enregistrement est idempotent sur (companyId, expoPushToken) : ré-enregistrer met à jour
 * la plateforme/le user et rafraîchit updatedAt (le token Expo peut être partagé entre boots).
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
  register(input: RegisterDeviceInput): Promise<DeviceRecord>;
  listByCompany(companyId: string): Promise<DeviceRecord[]>;
  /** Retire un token invalidé (ticket Expo DeviceNotRegistered). Idempotent. */
  removeByToken(companyId: string, expoPushToken: string): Promise<void>;
}

import {
  deriveConfirmedTimeZone,
  parseIanaTimeZone,
  type ConfirmedTimeZone,
} from '@bob/core';

const COMPANY_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/u;

export function validCompanyId(value: unknown): value is string {
  return typeof value === 'string' && COMPANY_ID_PATTERN.test(value);
}

/** The authenticated JWT metadata is the only production tenant authority on mobile. */
export function companyIdFromAppMetadata(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const companyId = (metadata as Record<string, unknown>)['company_id'];
  return validCompanyId(companyId) ? companyId : null;
}

/** Préférence conversationnelle tirée uniquement de la session JWT courante et liée au tenant. */
export function confirmedTimeZoneFromAppMetadata(
  metadata: unknown,
): ConfirmedTimeZone | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return null;
  const claims = metadata as Record<string, unknown>;
  return deriveConfirmedTimeZone({
    timeZone: claims.bob_time_zone,
    confirmedAt: claims.bob_time_zone_confirmed_at,
    boundCompanyId: claims.bob_time_zone_company_id,
    currentCompanyId: companyIdFromAppMetadata(metadata),
  });
}

/** Le fuseau appareil n'est qu'une suggestion à confirmer ; une valeur inconnue reste absente. */
export function detectDeviceTimeZone(): string | null {
  try {
    return parseIanaTimeZone(
      new Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  } catch {
    return null;
  }
}

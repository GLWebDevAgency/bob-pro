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

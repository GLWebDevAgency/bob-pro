/**
 * Binding propriétaire temporaire de la bêta mono-utilisateur.
 *
 * Il ne remplace pas le futur agrégat CompanyMember(owner|member). Il rend seulement explicite et
 * testable la convention que l'onboarding appliquait déjà lors du premier provisioning.
 */
export const COMPANY_OWNER_SUBJECT_PATTERN_SOURCE = '^[A-Za-z0-9-]{1,56}$';
export const COMPANY_OWNER_ID_PREFIX = 'company-';
const OWNER_SUBJECT = new RegExp(COMPANY_OWNER_SUBJECT_PATTERN_SOURCE, 'u');

export function canonicalCompanyIdForUser(userId: string): string | null {
  if (!OWNER_SUBJECT.test(userId)) return null;
  return `${COMPANY_OWNER_ID_PREFIX}${userId}`;
}

export function isCanonicalCompanyOwnerBinding(userId: string, companyId: string): boolean {
  const canonical = canonicalCompanyIdForUser(userId);
  return canonical !== null && companyId === canonical;
}

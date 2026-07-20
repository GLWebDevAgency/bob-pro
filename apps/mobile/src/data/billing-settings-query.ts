export function companyBillingSettingsQueryKey(companyId: string) {
  if (companyId.trim() === '') throw new Error('COMPANY_ID_REQUIRED_FOR_BILLING_SETTINGS');
  return ['company-billing-settings', companyId] as const;
}

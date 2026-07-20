import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { companyBillingSettingsQueryKey } from './billing-settings-query';

describe('billing settings mobile — autorité distante', () => {
  it('isole le cache par société lors d’un switch de session', () => {
    expect(companyBillingSettingsQueryKey('company-a')).not.toEqual(
      companyBillingSettingsQueryKey('company-b'),
    );
  });

  it('refuse une identité absente au lieu de créer une clé globale partageable', () => {
    expect(() => companyBillingSettingsQueryKey('')).toThrow(
      'COMPANY_ID_REQUIRED_FOR_BILLING_SETTINGS',
    );
  });

  it('ne contient plus ni AsyncStorage, ni valeur par défaut, ni logo file://', () => {
    const facade = readFileSync(
      fileURLToPath(new URL('./billing-prefs.ts', import.meta.url)),
      'utf8',
    );
    const hooks = readFileSync(fileURLToPath(new URL('./hooks.ts', import.meta.url)), 'utf8');
    expect(`${facade}\n${hooks}`).not.toMatch(
      /AsyncStorage|DEFAULT_BILLING_PREFS|logoUri|file:\/\//u,
    );
    expect(hooks).toContain('getCompanyBillingSettings');
  });
});

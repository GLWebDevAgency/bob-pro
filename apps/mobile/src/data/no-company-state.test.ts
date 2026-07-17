/**
 * Routage « session valide + company absente » (bug device live) : l'app doit tomber sur
 * l'onboarding, jamais sur les tabs en erreur. Ces tests couvrent la détection du 403 serveur
 * (NO_COMPANY de l'interceptor tenant, PROVISIONING_REQUIRED du guard), le signal dérivé du
 * cache react-query et la décision de la porte d'auth.
 */
import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  clearNoCompanyQueries,
  isNoCompanyError,
  queriesContainNoCompanyError,
  shouldRouteToProvisioning,
} from './no-company-state';

describe('isNoCompanyError — détection du 403 « pas de company »', () => {
  it('reconnaît le NO_COMPANY de l’interceptor tenant (company_id du JWT sans ligne en base)', () => {
    expect(isNoCompanyError({ kind: 'forbidden', reason: 'NO_COMPANY' })).toBe(true);
  });

  it('reconnaît le PROVISIONING_REQUIRED du guard (défense en profondeur)', () => {
    expect(isNoCompanyError({ kind: 'forbidden', reason: 'PROVISIONING_REQUIRED' })).toBe(true);
  });

  it('ne confond JAMAIS un forbidden métier (paywall, offre) avec l’absence de company', () => {
    expect(isNoCompanyError({ kind: 'forbidden', reason: 'Réservé à l’offre Pro.' })).toBe(false);
  });

  it('ignore les autres AppError et les erreurs non structurées', () => {
    expect(isNoCompanyError({ kind: 'dependency', port: 'api', cause: 'HTTP 500' })).toBe(false);
    expect(isNoCompanyError({ kind: 'not_found', entity: 'company', id: 'co-1' })).toBe(false);
    expect(isNoCompanyError(new Error('réseau'))).toBe(false);
    expect(isNoCompanyError(null)).toBe(false);
    expect(isNoCompanyError(undefined)).toBe(false);
    expect(isNoCompanyError('NO_COMPANY')).toBe(false);
  });
});

describe('queriesContainNoCompanyError — signal dérivé du cache', () => {
  it('vrai dès qu’UNE query porte le 403 « pas de company »', () => {
    expect(
      queriesContainNoCompanyError([
        { state: { error: null } },
        { state: { error: { kind: 'dependency', port: 'api', cause: 'HTTP 500' } } },
        { state: { error: { kind: 'forbidden', reason: 'NO_COMPANY' } } },
      ]),
    ).toBe(true);
  });

  it('faux sur un cache sain ou en panne ordinaire (le retry/ErrorRetry garde la main)', () => {
    expect(queriesContainNoCompanyError([])).toBe(false);
    expect(
      queriesContainNoCompanyError([
        { state: { error: null } },
        { state: { error: { kind: 'unavailable', service: 'cashflow-banking-source' } } },
      ]),
    ).toBe(false);
  });
});

describe('shouldRouteToProvisioning — la décision de la porte d’auth', () => {
  it('JWT sans company_id (compte neuf) → onboarding', () => {
    expect(
      shouldRouteToProvisioning({ companyId: null, serverReportsNoCompany: false }),
    ).toBe(true);
  });

  it('JWT AVEC company_id mais serveur NO_COMPANY (base vide) → onboarding, jamais les tabs', () => {
    expect(
      shouldRouteToProvisioning({ companyId: 'company-user-1', serverReportsNoCompany: true }),
    ).toBe(true);
  });

  it('tenant provisionné et reconnu par le serveur → l’app', () => {
    expect(
      shouldRouteToProvisioning({ companyId: 'company-user-1', serverReportsNoCompany: false }),
    ).toBe(false);
  });
});

describe('clearNoCompanyQueries — purge post-provisioning (intégration QueryClient réel)', () => {
  async function seedFailingQuery(
    queryClient: QueryClient,
    key: string,
    error: unknown,
  ): Promise<void> {
    await queryClient
      .fetchQuery({
        queryKey: [key],
        retry: false,
        queryFn: async () => {
          throw error;
        },
      })
      .catch(() => undefined);
  }

  it('retire UNIQUEMENT les queries NO_COMPANY — le signal retombe, le reste du cache survit', async () => {
    const queryClient = new QueryClient();
    await seedFailingQuery(queryClient, 'cashflow', {
      kind: 'forbidden',
      reason: 'NO_COMPANY',
    });
    await seedFailingQuery(queryClient, 'notifications', {
      kind: 'dependency',
      port: 'api',
      cause: 'HTTP 500',
    });
    queryClient.setQueryData(['tips'], { seen: true });

    expect(queriesContainNoCompanyError(queryClient.getQueryCache().getAll())).toBe(true);

    clearNoCompanyQueries(queryClient);

    expect(queriesContainNoCompanyError(queryClient.getQueryCache().getAll())).toBe(false);
    expect(queryClient.getQueryCache().find({ queryKey: ['cashflow'] })).toBeUndefined();
    expect(queryClient.getQueryCache().find({ queryKey: ['notifications'] })).toBeDefined();
    expect(queryClient.getQueryData(['tips'])).toEqual({ seen: true });
    queryClient.clear();
  });
});

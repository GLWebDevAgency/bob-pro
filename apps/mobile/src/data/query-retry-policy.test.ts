/**
 * Politique de retry des queries (fix « tunnel » Argent) : les erreurs définitives (4xx métier,
 * NO_COMPANY) ne sont JAMAIS rejouées automatiquement ; les transitoires (réseau/5xx) le sont
 * de façon BORNÉE avec backoff plafonné. Le retry manuel (ErrorRetry) n'est pas gouverné ici.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_TRANSIENT_QUERY_RETRIES,
  isTransientQueryError,
  queryRetryDelayMs,
  shouldRetryQueryFailure,
} from './query-retry-policy';

describe('isTransientQueryError — définitif vs transitoire', () => {
  it('NO_COMPANY / PROVISIONING_REQUIRED : jamais transitoire (c’est un routage onboarding)', () => {
    expect(isTransientQueryError({ kind: 'forbidden', reason: 'NO_COMPANY' })).toBe(false);
    expect(isTransientQueryError({ kind: 'forbidden', reason: 'PROVISIONING_REQUIRED' })).toBe(
      false,
    );
  });

  it('les 4xx métier sont définitifs : forbidden, not_found, conflict, validation, domain, rate_limited', () => {
    expect(isTransientQueryError({ kind: 'forbidden', reason: 'Offre insuffisante.' })).toBe(false);
    expect(isTransientQueryError({ kind: 'not_found', entity: 'invoice', id: 'inv-1' })).toBe(false);
    expect(isTransientQueryError({ kind: 'conflict', entity: 'quote', reason: 'révision' })).toBe(
      false,
    );
    expect(
      isTransientQueryError({ kind: 'validation', issues: [{ field: 'siret', message: 'KO' }] }),
    ).toBe(false);
    expect(isTransientQueryError({ kind: 'domain', error: { code: 'X' } })).toBe(false);
    expect(
      isTransientQueryError({ kind: 'rate_limited', reason: 'quota', retryAfterSeconds: 30 }),
    ).toBe(false);
  });

  it('un 4xx SANS enveloppe AppError (mappé dependency « HTTP 4xx ») est définitif', () => {
    expect(isTransientQueryError({ kind: 'dependency', port: 'api', cause: 'HTTP 403' })).toBe(
      false,
    );
    expect(isTransientQueryError({ kind: 'dependency', port: 'api', cause: 'HTTP 404' })).toBe(
      false,
    );
  });

  it('réseau et 5xx sont transitoires : unavailable, dependency 5xx, Error brut', () => {
    expect(isTransientQueryError({ kind: 'unavailable', service: 'postgres' })).toBe(true);
    expect(isTransientQueryError({ kind: 'dependency', port: 'api', cause: 'HTTP 502' })).toBe(
      true,
    );
    expect(
      isTransientQueryError({ kind: 'dependency', port: 'api', cause: 'Délai réseau dépassé après 20000 ms.' }),
    ).toBe(true);
    expect(isTransientQueryError(new Error('Network request failed'))).toBe(true);
    expect(isTransientQueryError(undefined)).toBe(true);
  });

  it('solde/source bancaire à confirmer : unavailable STABLE, jamais de retry automatique (audit QA A11)', () => {
    // Un solde périmé ne redevient pas frais en rejouant la requête : seul l'utilisateur qui
    // confirme son solde change l'état. Le retry automatique fabriquait des rafales (observé
    // en veille : 21 requêtes par cycle d'écran au lieu de 7).
    expect(isTransientQueryError({ kind: 'unavailable', service: 'bank-balance-stale' })).toBe(
      false,
    );
    expect(isTransientQueryError({ kind: 'unavailable', service: 'cashflow-banking-source' })).toBe(
      false,
    );
    expect(isTransientQueryError({ kind: 'not_found', entity: 'bank_balance_snapshot' })).toBe(
      false,
    );
  });
});

describe('shouldRetryQueryFailure — bornage', () => {
  const transient = { kind: 'unavailable', service: 'postgres' };
  const definitive = { kind: 'forbidden', reason: 'NO_COMPANY' };

  it('rejoue une transitoire tant que la borne n’est pas atteinte, puis s’arrête', () => {
    expect(shouldRetryQueryFailure(0, transient)).toBe(true);
    expect(shouldRetryQueryFailure(1, transient)).toBe(true);
    expect(shouldRetryQueryFailure(MAX_TRANSIENT_QUERY_RETRIES, transient)).toBe(false);
    expect(shouldRetryQueryFailure(99, transient)).toBe(false);
  });

  it('ne rejoue JAMAIS une définitive, même au premier échec — plus de tunnel', () => {
    expect(shouldRetryQueryFailure(0, definitive)).toBe(false);
    expect(shouldRetryQueryFailure(0, { kind: 'not_found', entity: 'company', id: 'c' })).toBe(
      false,
    );
  });
});

describe('queryRetryDelayMs — backoff exponentiel plafonné', () => {
  it('croît (1 s → 2 s → 4 s) puis plafonne à 5 s — jamais un martèlement, jamais infini', () => {
    expect(queryRetryDelayMs(0)).toBe(1_000);
    expect(queryRetryDelayMs(1)).toBe(2_000);
    expect(queryRetryDelayMs(2)).toBe(4_000);
    expect(queryRetryDelayMs(3)).toBe(5_000);
    expect(queryRetryDelayMs(10)).toBe(5_000);
  });

  it('reste sain sur une entrée négative inattendue', () => {
    expect(queryRetryDelayMs(-1)).toBe(1_000);
  });
});

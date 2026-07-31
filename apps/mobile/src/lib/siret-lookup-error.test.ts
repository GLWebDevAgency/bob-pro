import { describe, expect, it } from 'vitest';
import { discriminateSiretLookupError } from './siret-lookup-error';

describe('discriminateSiretLookupError — un motif par vérité serveur, jamais un booléen', () => {
  it('domain et validation → invalid (422 : format/Luhn refusé par le domaine)', () => {
    expect(
      discriminateSiretLookupError({
        kind: 'domain',
        error: { code: 'VALIDATION', field: 'siret', message: 'SIRET invalide' },
      }).reason,
    ).toBe('invalid');
    expect(
      discriminateSiretLookupError({ kind: 'validation', issues: [] }).reason,
    ).toBe('invalid');
  });

  it('not_found → not_found (404 : l’annuaire ne connaît pas ce SIRET)', () => {
    const failure = discriminateSiretLookupError({
      kind: 'not_found',
      entity: 'company',
      id: '91300380500017',
      code: 'BOB-SIRET-404',
      correlationId: 'corr-1',
    });
    expect(failure.reason).toBe('not_found');
    expect(failure.error.code).toBe('BOB-SIRET-404');
  });

  it('rate_limited → rate_limited AVEC le délai à afficher', () => {
    const failure = discriminateSiretLookupError({
      kind: 'rate_limited',
      reason: 'throttle lookup',
      retryAfterSeconds: 30,
    });
    expect(failure.reason).toBe('rate_limited');
    expect(failure.retryAfterSeconds).toBe(30);
  });

  it('dependency/api-contract → contract (le « 200 servi mais vu non trouvé » : chez NOUS)', () => {
    expect(
      discriminateSiretLookupError({
        kind: 'dependency',
        port: 'api-contract',
        cause: 'Réponse API invalide pour GET /company/lookup.',
      }).reason,
    ).toBe('contract');
  });

  it('dependency (autre port) et unavailable → lookup_down (annuaire/amont en panne)', () => {
    expect(
      discriminateSiretLookupError({
        kind: 'dependency',
        port: 'recherche-entreprises',
        cause: 'HTTP 429',
      }).reason,
    ).toBe('lookup_down');
    expect(
      discriminateSiretLookupError({ kind: 'unavailable', service: 'annuaire' }).reason,
    ).toBe('lookup_down');
  });

  it('kinds restants et valeurs non typées → unknown, sans jamais jeter', () => {
    expect(discriminateSiretLookupError({ kind: 'forbidden', reason: 'x' }).reason).toBe('unknown');
    expect(discriminateSiretLookupError({ kind: 'gone', entity: 'q', reason: 'x' }).reason).toBe(
      'unknown',
    );
    const untyped = discriminateSiretLookupError(new Error('boom'));
    expect(untyped.reason).toBe('unknown');
    expect(untyped.error.kind).toBe('dependency');
    expect(discriminateSiretLookupError(null).reason).toBe('unknown');
  });
});

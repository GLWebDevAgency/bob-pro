import { describe, expect, it } from 'vitest';
import {
  appConflict,
  appDomain,
  appForbidden,
  appGone,
  appNotFound,
  appRateLimited,
  appUnavailable,
  type AppError,
} from './result';

/**
 * Verrou de rétro-compat du fil (SPEC_SYSTEME_ERREUR §2.2) : `decodeHttpAppError` côté client
 * valide les clés EXACTES de l'objet `error` sérialisé par le serveur. Les métadonnées de
 * transport (`code`, `correlationId`) sont donc réservées à la frontière CLIENTE — si un
 * constructeur du domaine se met à les poser, chaque client déployé rejettera l'erreur et la
 * dégradera en `dependency/api` générique.
 */
describe('AppError — constructeurs sans métadonnées de transport', () => {
  it('chaque constructeur produit EXACTEMENT les clés de son variant', () => {
    expect(
      Object.keys(appDomain({ code: 'VALIDATION', field: 'siret', message: 'x' })).sort(),
    ).toEqual(['error', 'kind']);
    expect(Object.keys(appNotFound('company', '123')).sort()).toEqual(['entity', 'id', 'kind']);
    expect(Object.keys(appGone('quote', 'expirée')).sort()).toEqual(['entity', 'kind', 'reason']);
    expect(Object.keys(appConflict('invoice', 'révision')).sort()).toEqual([
      'entity',
      'kind',
      'reason',
    ]);
    expect(Object.keys(appForbidden('offre')).sort()).toEqual(['kind', 'reason']);
    expect(Object.keys(appRateLimited('throttle', 30)).sort()).toEqual([
      'kind',
      'reason',
      'retryAfterSeconds',
    ]);
    expect(Object.keys(appUnavailable('banking')).sort()).toEqual(['kind', 'service']);
    expect(Object.keys(appUnavailable('banking', 60)).sort()).toEqual([
      'kind',
      'retryAfterSeconds',
      'service',
    ]);
  });

  it('le rétrécissement par kind reste opérant avec les champs de transport', () => {
    const error: AppError = { ...appNotFound('company', '123'), correlationId: 'abc-corr-1234' };
    expect(error.correlationId).toBe('abc-corr-1234');
    if (error.kind === 'not_found') {
      expect(error.entity).toBe('company');
      expect(error.id).toBe('123');
    } else {
      throw new Error('le kind not_found doit rétrécir');
    }
  });
});

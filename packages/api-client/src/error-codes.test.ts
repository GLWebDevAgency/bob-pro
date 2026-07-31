import { describe, expect, it } from 'vitest';
import {
  BOB_ERROR_CODE_REGISTRY,
  BOB_ERROR_CONTEXTS,
  BOB_ERROR_ROUTE_CONTEXTS,
  BOB_ERROR_STATUSES,
  bobErrorCode,
  bobErrorContextForRoute,
  bobErrorStatus,
  newCorrelationId,
  shortCorrelationId,
  withErrorTransport,
} from './error-codes';

/**
 * VERROU DU REGISTRE (SPEC_SYSTEME_ERREUR §2.3) : la liste ci-dessous est LITTÉRALE et
 * exhaustive. Ajouter/retirer un contexte ou un statut sans passer par un edit CONSCIENT de
 * cette liste fait échouer ce test — c'est voulu : le registre est fermé.
 */
const REGISTRE_FERME: readonly string[] = [
  'BOB-API-403', 'BOB-API-404', 'BOB-API-409', 'BOB-API-410', 'BOB-API-422', 'BOB-API-429',
  'BOB-API-500', 'BOB-API-502', 'BOB-API-503',
  'BOB-SIRET-403', 'BOB-SIRET-404', 'BOB-SIRET-409', 'BOB-SIRET-410', 'BOB-SIRET-422',
  'BOB-SIRET-429', 'BOB-SIRET-500', 'BOB-SIRET-502', 'BOB-SIRET-503',
  'BOB-ADM-403', 'BOB-ADM-404', 'BOB-ADM-409', 'BOB-ADM-410', 'BOB-ADM-422', 'BOB-ADM-429',
  'BOB-ADM-500', 'BOB-ADM-502', 'BOB-ADM-503',
  'BOB-LIVE-403', 'BOB-LIVE-404', 'BOB-LIVE-409', 'BOB-LIVE-410', 'BOB-LIVE-422', 'BOB-LIVE-429',
  'BOB-LIVE-500', 'BOB-LIVE-502', 'BOB-LIVE-503',
];

describe('registre des codes courts — fermeture', () => {
  it('la matrice publiée est EXACTEMENT la liste littérale verrouillée', () => {
    expect([...BOB_ERROR_CODE_REGISTRY]).toEqual(REGISTRE_FERME);
  });

  it('patron « BOB-<CTX>-<statut> » et unicité, sans exception', () => {
    for (const code of BOB_ERROR_CODE_REGISTRY) {
      expect(code).toMatch(/^BOB-[A-Z]{2,6}-\d{3}$/);
    }
    expect(new Set(BOB_ERROR_CODE_REGISTRY).size).toBe(BOB_ERROR_CODE_REGISTRY.length);
    expect(BOB_ERROR_CODE_REGISTRY).toHaveLength(
      BOB_ERROR_CONTEXTS.length * BOB_ERROR_STATUSES.length,
    );
  });

  it('kind → statut : miroir exact du mapping serveur (unwrap, apps/api/src/http/result.ts)', () => {
    expect(bobErrorStatus({ kind: 'not_found', entity: 'company', id: 'x' })).toBe(404);
    expect(bobErrorStatus({ kind: 'gone', entity: 'quote', reason: 'x' })).toBe(410);
    expect(bobErrorStatus({ kind: 'conflict', entity: 'invoice', reason: 'x' })).toBe(409);
    expect(bobErrorStatus({ kind: 'rate_limited', reason: 'x', retryAfterSeconds: 5 })).toBe(429);
    expect(bobErrorStatus({ kind: 'unavailable', service: 'banking' })).toBe(503);
    expect(bobErrorStatus({ kind: 'forbidden', reason: 'x' })).toBe(403);
    expect(bobErrorStatus({ kind: 'validation', issues: [] })).toBe(422);
    expect(bobErrorStatus({ kind: 'domain', error: { code: 'VALIDATION' } })).toBe(422);
    expect(bobErrorStatus({ kind: 'dependency', port: 'api', cause: 'x' })).toBe(502);
  });

  it('valeur non typée → 500 (slot « défaut de programmation », jamais un 502 déguisé)', () => {
    expect(bobErrorStatus(new Error('boom'))).toBe(500);
    expect(bobErrorStatus(null)).toBe(500);
    expect(bobErrorStatus('boom')).toBe(500);
    expect(bobErrorStatus({ kind: 'jamais_vu' })).toBe(500);
  });

  it('route → contexte : table fermée, première règle gagnante, API par défaut', () => {
    expect(BOB_ERROR_ROUTE_CONTEXTS).toHaveLength(3);
    // L'admission est le POST de création EXACT — ses sous-routes sont des opérations de session.
    expect(bobErrorContextForRoute('POST', '/voice/realtime/calls')).toBe('ADM');
    expect(bobErrorContextForRoute('post', '/voice/realtime/calls/abc/speech/ack')).toBe('LIVE');
    expect(bobErrorContextForRoute('DELETE', '/voice/realtime/calls/abc')).toBe('LIVE');
    expect(bobErrorContextForRoute('GET', '/voice/realtime/speech/feed')).toBe('LIVE');
    expect(bobErrorContextForRoute('GET', '/company/lookup?siret=123')).toBe('SIRET');
    expect(bobErrorContextForRoute('GET', '/quotes')).toBe('API');
  });

  it('bobErrorCode compose contexte + statut (les codes des trois cas terrain)', () => {
    expect(bobErrorCode({ kind: 'not_found', entity: 'company', id: 'x' }, 'SIRET')).toBe(
      'BOB-SIRET-404',
    );
    expect(bobErrorCode({ kind: 'unavailable', service: 'realtime' }, 'ADM')).toBe('BOB-ADM-503');
    expect(bobErrorCode({ kind: 'dependency', port: 'api', cause: 'x' })).toBe('BOB-API-502');
    expect(bobErrorCode(undefined)).toBe('BOB-API-500');
  });

  it('chaque code produit appartient au registre (fonction totale, jamais hors liste)', () => {
    const kinds = [
      { kind: 'domain' }, { kind: 'not_found' }, { kind: 'gone' }, { kind: 'conflict' },
      { kind: 'forbidden' }, { kind: 'rate_limited' }, { kind: 'unavailable' },
      { kind: 'validation' }, { kind: 'dependency' }, { kind: 'inconnu' }, null,
    ];
    for (const context of BOB_ERROR_CONTEXTS) {
      for (const error of kinds) {
        expect(BOB_ERROR_CODE_REGISTRY).toContain(bobErrorCode(error, context));
      }
    }
  });
});

describe('corrélation — helpers', () => {
  it('shortCorrelationId : 8 premiers caractères (préfixe grep-able)', () => {
    expect(shortCorrelationId('98f73810-aaaa-4bbb-8ccc-121212121212')).toBe('98f73810');
    expect(shortCorrelationId('court')).toBe('court');
  });

  it('newCorrelationId : format UUID v4 et unicité de tirages successifs', () => {
    const ids = new Set(Array.from({ length: 64 }, () => newCorrelationId()));
    expect(ids.size).toBe(64);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('withErrorTransport attache code + correlationId sans toucher au variant', () => {
    const enriched = withErrorTransport(
      { kind: 'not_found', entity: 'company', id: '123' },
      { code: 'BOB-SIRET-404', correlationId: 'corr-12345678' },
    );
    expect(enriched).toEqual({
      kind: 'not_found',
      entity: 'company',
      id: '123',
      code: 'BOB-SIRET-404',
      correlationId: 'corr-12345678',
    });
  });
});

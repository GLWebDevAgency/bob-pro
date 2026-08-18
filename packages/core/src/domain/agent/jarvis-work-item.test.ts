/**
 * Tests du domaine work items Jarvis (spec §5.3) — lot U1-b.
 *
 * Deux verrous : l'union GELÉE des 9 statuts (miroir migration U1-a) et le parse
 * exact-keys des sources d'autorisation. Chaque garde est prouvée par une violation
 * dédiée : ces tests rougissent si la boucle `unexpected_key`, la boucle
 * `missing_key` ou le refus `Array.isArray` disparaît du parse.
 */

import { describe, expect, it } from 'vitest';

import {
  JARVIS_WORK_ITEM_STATUSES,
  parseJarvisAuthorizationSource,
  type JarvisAuthorizationSource,
  type JarvisAuthorizationSourceParseError,
} from './jarvis-work-item';

// ---------------------------------------------------------------------------
// Fixtures — une variante valide par membre de l'union, avec EXACTEMENT ses clés
// ---------------------------------------------------------------------------

const CONFIRMATION: JarvisAuthorizationSource = {
  source: 'confirmation',
  receiptId: '11111111-1111-4111-8111-111111111111',
};

const MANDATE_GRANT: JarvisAuthorizationSource = {
  source: 'mandate_grant',
  grantId: 'grant-42',
  revision: 3,
  digest: 'a'.repeat(64),
  expiresAt: '2026-08-18T10:00:00.000Z',
};

const CERTIFIED_RULE: JarvisAuthorizationSource = {
  source: 'certified_system_rule',
  ruleId: 'rule-relance-facture',
  ruleVersion: 2,
  observationScope: 'company:company-1',
};

const ALL_VARIANTS = [CONFIRMATION, MANDATE_GRANT, CERTIFIED_RULE] as const;

function omit(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

function expectRefusal(
  value: unknown,
  reason: JarvisAuthorizationSourceParseError['reason'],
): void {
  expect(parseJarvisAuthorizationSource(value)).toEqual({
    ok: false,
    error: { code: 'invalid_authorization_source', reason },
  });
}

// ---------------------------------------------------------------------------
// Union des statuts — miroir gelé de la migration U1-a
// ---------------------------------------------------------------------------

describe('JARVIS_WORK_ITEM_STATUSES — union fermée §5.3', () => {
  it('expose EXACTEMENT les 9 statuts de la migration U1-a, dans cet ordre, gelés', () => {
    expect(JARVIS_WORK_ITEM_STATUSES).toEqual([
      'prepared',
      'leased',
      'authorized',
      'retry_due',
      'succeeded',
      'failed_terminal',
      'outcome_unknown',
      'cancelling',
      'cancelled',
    ]);
    expect(JARVIS_WORK_ITEM_STATUSES).toHaveLength(9);
    expect(Object.isFrozen(JARVIS_WORK_ITEM_STATUSES)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Variantes acceptées — chaque membre de l'union, avec exactement ses clés
// ---------------------------------------------------------------------------

describe('parseJarvisAuthorizationSource — variantes acceptées', () => {
  it('accepte `confirmation` avec exactement { source, receiptId }', () => {
    expect(parseJarvisAuthorizationSource(CONFIRMATION)).toEqual({
      ok: true,
      value: CONFIRMATION,
    });
  });

  it('accepte `mandate_grant` avec exactement { source, grantId, revision, digest, expiresAt }', () => {
    expect(parseJarvisAuthorizationSource(MANDATE_GRANT)).toEqual({
      ok: true,
      value: MANDATE_GRANT,
    });
  });

  it('accepte `certified_system_rule` avec exactement { source, ruleId, ruleVersion, observationScope }', () => {
    expect(parseJarvisAuthorizationSource(CERTIFIED_RULE)).toEqual({
      ok: true,
      value: CERTIFIED_RULE,
    });
  });
});

// ---------------------------------------------------------------------------
// Gardes — chaque refus prouvé par une violation qui rend sa boucle porteuse
// ---------------------------------------------------------------------------

describe('parseJarvisAuthorizationSource — refus exact-keys', () => {
  it('invalid_shape : null, primitives et undefined ne sont jamais tolérés', () => {
    expectRefusal(null, 'invalid_shape');
    expectRefusal(undefined, 'invalid_shape');
    expectRefusal('confirmation', 'invalid_shape');
    expectRefusal(42, 'invalid_shape');
    expectRefusal(true, 'invalid_shape');
    expectRefusal([], 'invalid_shape');
  });

  it("invalid_shape : un TABLEAU décoré des clés exactes d'une confirmation reste refusé — le refus Array.isArray est porteur", () => {
    // Sans `Array.isArray`, ce tableau passerait : typeof === 'object', `source` et
    // `receiptId` présents, aucune clé intruse ni manquante -> ok:true. Le test rougit.
    const sneaky: unknown = Object.assign([], {
      source: 'confirmation',
      receiptId: '11111111-1111-4111-8111-111111111111',
    });
    expectRefusal(sneaky, 'invalid_shape');
  });

  it('unknown_source : source absente, inconnue ou non littérale', () => {
    expectRefusal({}, 'unknown_source');
    expectRefusal({ receiptId: 'receipt-1' }, 'unknown_source');
    expectRefusal({ source: 'oauth', receiptId: 'receipt-1' }, 'unknown_source');
    expectRefusal({ source: 'CONFIRMATION', receiptId: 'receipt-1' }, 'unknown_source');
    expectRefusal({ source: 42 }, 'unknown_source');
    expectRefusal({ source: null }, 'unknown_source');
  });

  it('unexpected_key : toutes les clés attendues présentes PLUS une intruse — la boucle unexpected_key est porteuse', () => {
    // Sans la boucle : aucune clé attendue ne manque, le parse rendrait ok:true. Rouge.
    expectRefusal({ ...CONFIRMATION, extra: true }, 'unexpected_key');
    expectRefusal({ ...MANDATE_GRANT, extra: 'x' }, 'unexpected_key');
    expectRefusal({ ...CERTIFIED_RULE, extra: 1 }, 'unexpected_key');
    // Une clé légitime d'une AUTRE variante est tout aussi intruse.
    expectRefusal({ ...CONFIRMATION, grantId: 'grant-42' }, 'unexpected_key');
    expectRefusal({ ...MANDATE_GRANT, receiptId: 'receipt-1' }, 'unexpected_key');
    expectRefusal({ ...CERTIFIED_RULE, digest: 'a'.repeat(64) }, 'unexpected_key');
  });

  it('missing_key : variante par variante, chaque clé retirée une à une — la boucle missing_key est porteuse', () => {
    for (const fixture of ALL_VARIANTS) {
      const record = fixture as unknown as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (key === 'source') continue; // sans `source`, c'est unknown_source (testé plus haut)
        expectRefusal(omit(record, key), 'missing_key');
      }
    }
  });

  it('missing_key : `source` seule, AUCUNE clé intruse — seul le contrôle des clés manquantes peut refuser', () => {
    // Sans la boucle missing_key, ces objets passeraient toutes les autres gardes. Rouge.
    expectRefusal({ source: 'confirmation' }, 'missing_key');
    expectRefusal({ source: 'mandate_grant' }, 'missing_key');
    expectRefusal({ source: 'certified_system_rule' }, 'missing_key');
  });
});

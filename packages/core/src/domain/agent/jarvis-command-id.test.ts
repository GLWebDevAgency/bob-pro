import { describe, expect, it } from 'vitest';
import {
  JARVIS_SYSTEM_COMMAND_NAMESPACE,
  deriveJarvisSystemCommandId,
  type JarvisSystemCommandIdResult,
} from './jarvis-command-id';

const RUN_ID = '3f2c8b1a-5d4e-4f6a-9b0c-1d2e3f4a5b6c';
const EFFECT_ID = '7a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';
const OTHER_EFFECT_ID = '9b8c7d6e-5f4a-4b3c-9d2e-1f0a9b8c7d6e';
const DIGEST_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const DIGEST_OTHER = '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae';

const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function unwrap(result: JarvisSystemCommandIdResult): string {
  if (!result.ok) throw new Error(`refus inattendu : ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('deriveJarvisSystemCommandId — vecteurs FIGÉS (byte-stables)', () => {
  // ⚠️ Ces UUID sont le CONTRAT v1 : toute dérive casse le replay zéro-write des signaux
  // déjà persistés. On ne les « corrige » jamais — une évolution d'encodage = namespace v2.
  it('reproduit les vecteurs v1 à l’octet près', () => {
    expect(unwrap(deriveJarvisSystemCommandId(RUN_ID, EFFECT_ID, 'succeeded'))).toBe(
      '0763f192-179e-886f-8802-5651579dbc83',
    );
    expect(unwrap(deriveJarvisSystemCommandId(RUN_ID, EFFECT_ID, 'succeeded', DIGEST_EMPTY))).toBe(
      '6e993f22-f813-8977-8c2b-f91ba167f69a',
    );
    expect(
      unwrap(deriveJarvisSystemCommandId(RUN_ID, EFFECT_ID, 'failed_terminal', DIGEST_OTHER)),
    ).toBe('739e3ff8-83bd-8802-8139-d2510fa9028f');
    expect(unwrap(deriveJarvisSystemCommandId(RUN_ID, OTHER_EFFECT_ID, 'submitted'))).toBe(
      'dc1cd333-fccf-8633-84ba-959ac5878a13',
    );
  });

  it('fige le namespace versionné v1', () => {
    expect(JARVIS_SYSTEM_COMMAND_NAMESPACE).toBe('bob.jarvis.system-command.v1');
  });
});

describe('deriveJarvisSystemCommandId — propriétés', () => {
  it('est déterministe : même entrée ⇒ même UUID', () => {
    const a = unwrap(deriveJarvisSystemCommandId(RUN_ID, EFFECT_ID, 'succeeded', DIGEST_EMPTY));
    const b = unwrap(deriveJarvisSystemCommandId(RUN_ID, EFFECT_ID, 'succeeded', DIGEST_EMPTY));
    expect(a).toBe(b);
  });

  it('est sensible à CHAQUE composante (runId, effectId, kind, digest, présence du digest)', () => {
    const base = unwrap(deriveJarvisSystemCommandId(RUN_ID, EFFECT_ID, 'succeeded', DIGEST_EMPTY));
    const variants = [
      base,
      // runId différent (dernier caractère).
      unwrap(
        deriveJarvisSystemCommandId(
          '3f2c8b1a-5d4e-4f6a-9b0c-1d2e3f4a5b6d',
          EFFECT_ID,
          'succeeded',
          DIGEST_EMPTY,
        ),
      ),
      // effectId différent.
      unwrap(deriveJarvisSystemCommandId(RUN_ID, OTHER_EFFECT_ID, 'succeeded', DIGEST_EMPTY)),
      // kind différent.
      unwrap(deriveJarvisSystemCommandId(RUN_ID, EFFECT_ID, 'submitted', DIGEST_EMPTY)),
      // digest différent.
      unwrap(deriveJarvisSystemCommandId(RUN_ID, EFFECT_ID, 'succeeded', DIGEST_OTHER)),
      // digest absent ≠ digest présent.
      unwrap(deriveJarvisSystemCommandId(RUN_ID, EFFECT_ID, 'succeeded')),
    ];
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('produit toujours un UUID v8 canonique (version 8, variante RFC 4122)', () => {
    const samples = [
      unwrap(deriveJarvisSystemCommandId(RUN_ID, EFFECT_ID, 'succeeded')),
      unwrap(deriveJarvisSystemCommandId(RUN_ID, EFFECT_ID, 'succeeded', DIGEST_EMPTY)),
      unwrap(deriveJarvisSystemCommandId(RUN_ID, OTHER_EFFECT_ID, 'outcome_unknown')),
      unwrap(deriveJarvisSystemCommandId(OTHER_EFFECT_ID, RUN_ID, 'cancelled_no_effect')),
    ];
    for (const uuid of samples) {
      expect(uuid).toMatch(UUID_V8);
      // Nibble de version (position 14) et de variante (position 19) — patron maison figé.
      expect(uuid[14]).toBe('8');
      expect(uuid[19]).toBe('8');
    }
  });
});

describe('deriveJarvisSystemCommandId — refus typés', () => {
  it('refuse un runId non-UUID canonique', () => {
    for (const bad of [
      '',
      'not-a-uuid',
      RUN_ID.toUpperCase(),
      `${RUN_ID} `,
      '3f2c8b1a-5d4e-9f6a-9b0c-1d2e3f4a5b6c', // version 9 : hors grammaire canonique.
      '3f2c8b1a-5d4e-4f6a-cb0c-1d2e3f4a5b6c', // variante c : hors RFC 4122.
    ]) {
      expect(deriveJarvisSystemCommandId(bad, EFFECT_ID, 'succeeded')).toEqual({
        ok: false,
        error: {
          code: 'invalid_jarvis_system_command_input',
          field: 'runId',
          reason: 'invalid_uuid',
        },
      });
    }
  });

  it('refuse un effectId non-UUID canonique', () => {
    expect(deriveJarvisSystemCommandId(RUN_ID, 'effect-1', 'succeeded')).toEqual({
      ok: false,
      error: {
        code: 'invalid_jarvis_system_command_input',
        field: 'effectId',
        reason: 'invalid_uuid',
      },
    });
  });

  it('refuse un kind hors grammaire snake_case minuscule bornée', () => {
    for (const bad of [
      '',
      'Succeeded',
      'has space',
      '_leading',
      '1leading',
      `k${'a'.repeat(64)}`,
    ]) {
      expect(deriveJarvisSystemCommandId(RUN_ID, EFFECT_ID, bad)).toEqual({
        ok: false,
        error: {
          code: 'invalid_jarvis_system_command_input',
          field: 'observationKind',
          reason: 'invalid_observation_kind',
        },
      });
    }
  });

  it('refuse un digest présent qui n’est pas un sha-256 hexadécimal minuscule', () => {
    for (const bad of [
      '',
      DIGEST_EMPTY.slice(0, 63),
      DIGEST_EMPTY.toUpperCase(),
      `${DIGEST_EMPTY}0`,
    ]) {
      expect(deriveJarvisSystemCommandId(RUN_ID, EFFECT_ID, 'succeeded', bad)).toEqual({
        ok: false,
        error: {
          code: 'invalid_jarvis_system_command_input',
          field: 'observationDigest',
          reason: 'invalid_digest',
        },
      });
    }
  });
});

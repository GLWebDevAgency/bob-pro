/**
 * Identité déterministe des commandes SYSTÈME Jarvis (spec Jarvis §5.4/§5.6 — lot U1-c).
 *
 * Une commande système/reconciler N'INVENTE jamais son `commandId` : elle le DÉRIVE de
 * `(runId, effectId, observation)`. La même observation re-soumise (retry worker, redelivery
 * level-triggered, callback dupliqué) produit donc le MÊME UUID et rejoue en zéro-write à
 * l'admission (§5.2 point 7) ; une observation différente produit un UUID différent.
 *
 * Patron identique à `deriveAgentMissionSystemCommandId` (tableau canonique JSON haché en
 * sha-256 via le `sha256Hex` du shared-kernel — pur, partagé Node/React Native — puis UUID v8
 * tronqué). Le namespace est VERSIONNÉ : toute évolution de l'encodage crée
 * `bob.jarvis.system-command.v2`, JAMAIS une mutation du v1 — une dérive byte-stable
 * casserait le replay des signaux déjà persistés (les vecteurs figés du test le verrouillent).
 *
 * Pureté totale : aucune horloge, aucun aléa, aucune dépendance hors shared-kernel.
 */

import { sha256Hex } from '../../shared-kernel/sha256';

/**
 * Préfixe de namespace versionné — premier élément du tableau canonique haché.
 * Distinct du namespace legacy `bob.agent-mission.system-command.uuid-v8.v1` : les deux
 * familles de commandes système ne peuvent jamais entrer en collision d'identité.
 */
export const JARVIS_SYSTEM_COMMAND_NAMESPACE = 'bob.jarvis.system-command.v1';
export const JARVIS_WAKE_COMMAND_NAMESPACE = 'bob.jarvis.wake-command.v1';

/** UUID canonique (minuscule, versions 1-8, variante RFC 4122) — même grammaire que le domaine. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/**
 * Kind d'observation : snake_case minuscule fermé par grammaire (1-64). Le VOCABULAIRE
 * appartient au contrat du port d'admission système (§5.6) ; ce module ne fige que la
 * dérivation — la grammaire stricte interdit toute ambiguïté de canonicalisation.
 */
const OBSERVATION_KIND = /^[a-z][a-z0-9_]{0,63}$/u;
/** Digest d'observation : empreinte sha-256 hexadécimale minuscule (64 caractères). */
const SHA256_DIGEST = /^[0-9a-f]{64}$/u;
const MAX_WAKE_ID_LENGTH = 200;

export type JarvisSystemCommandIdError = {
  readonly code: 'invalid_jarvis_system_command_input';
  readonly field: 'runId' | 'effectId' | 'observationKind' | 'observationDigest';
  readonly reason: 'invalid_uuid' | 'invalid_observation_kind' | 'invalid_digest';
};

export type JarvisSystemCommandIdResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: JarvisSystemCommandIdError };

export type JarvisWakeCommandIdError = {
  readonly code: 'invalid_jarvis_wake_command_input';
  readonly field: 'runId' | 'wakeId' | 'dueAt' | 'expectedRevision';
  readonly reason: 'invalid_uuid' | 'invalid_wake_id' | 'invalid_instant' | 'invalid_revision';
};

export type JarvisWakeCommandIdResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: JarvisWakeCommandIdError };

function uuidV8FromHex(hex: string): string {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point < 32 || (point >= 127 && point <= 159));
  });
}

function refuse(
  field: JarvisSystemCommandIdError['field'],
  reason: JarvisSystemCommandIdError['reason'],
): JarvisSystemCommandIdResult {
  return { ok: false, error: { code: 'invalid_jarvis_system_command_input', field, reason } };
}

/**
 * Dérive l'UUID v8 déterministe d'une commande système Jarvis.
 *
 * - même entrée ⇒ même UUID (replay zéro-write) ; toute composante différente ⇒ UUID différent ;
 * - `observationDigest` absent est encodé `null` dans le tableau canonique — il ne peut donc
 *   jamais entrer en collision avec un digest présent ;
 * - refus typés, sans exception : un `runId`/`effectId` non-UUID canonique est refusé, un kind
 *   hors grammaire ou un digest non sha-256 aussi.
 */
export function deriveJarvisSystemCommandId(
  runId: string,
  effectId: string,
  observationKind: string,
  observationDigest?: string,
): JarvisSystemCommandIdResult {
  if (!UUID.test(runId)) return refuse('runId', 'invalid_uuid');
  if (!UUID.test(effectId)) return refuse('effectId', 'invalid_uuid');
  if (!OBSERVATION_KIND.test(observationKind)) {
    return refuse('observationKind', 'invalid_observation_kind');
  }
  if (observationDigest !== undefined && !SHA256_DIGEST.test(observationDigest)) {
    return refuse('observationDigest', 'invalid_digest');
  }
  const canonical = [
    JARVIS_SYSTEM_COMMAND_NAMESPACE,
    runId,
    effectId,
    observationKind,
    observationDigest ?? null,
  ];
  const hex = sha256Hex(JSON.stringify(canonical));
  return {
    ok: true,
    value: uuidV8FromHex(hex),
  };
}


/** Identité déterministe d'une génération de wake durable, sans horloge ni aléa. */
export function deriveJarvisWakeCommandId(
  runId: string,
  wakeId: string,
  dueAt: string,
  expectedRevision: number,
): JarvisWakeCommandIdResult {
  if (!UUID.test(runId)) {
    return {
      ok: false,
      error: {
        code: 'invalid_jarvis_wake_command_input',
        field: 'runId',
        reason: 'invalid_uuid',
      },
    };
  }
  if (
    wakeId.length === 0
    || wakeId.length > MAX_WAKE_ID_LENGTH
    || wakeId !== wakeId.trim()
    || hasControlCharacter(wakeId)
  ) {
    return {
      ok: false,
      error: {
        code: 'invalid_jarvis_wake_command_input',
        field: 'wakeId',
        reason: 'invalid_wake_id',
      },
    };
  }
  const dueEpoch = Date.parse(dueAt);
  if (!Number.isFinite(dueEpoch) || new Date(dueEpoch).toISOString() !== dueAt) {
    return {
      ok: false,
      error: {
        code: 'invalid_jarvis_wake_command_input',
        field: 'dueAt',
        reason: 'invalid_instant',
      },
    };
  }
  if (
    !Number.isSafeInteger(expectedRevision)
    || expectedRevision < 1
    || expectedRevision > 2_147_483_647
  ) {
    return {
      ok: false,
      error: {
        code: 'invalid_jarvis_wake_command_input',
        field: 'expectedRevision',
        reason: 'invalid_revision',
      },
    };
  }
  const canonical = [
    JARVIS_WAKE_COMMAND_NAMESPACE,
    runId,
    wakeId,
    dueAt,
    expectedRevision,
  ];
  return {
    ok: true,
    value: uuidV8FromHex(sha256Hex(JSON.stringify(canonical))),
  };
}

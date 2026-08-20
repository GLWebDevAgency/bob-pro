/**
 * Codec du wire Jarvis (spec Jarvis §5.2/§5.4/§7.1 — lot U1-d, SPEC_U1D_CALLERS_REELS_20260819).
 *
 * Contrat de la tranche, écrit ICI une seule fois :
 * - `POST /jarvis/runs/:runId/commands` — 200 signifie que la transaction d'admission a produit
 *   un REÇU (`admitted` ou `replayed`) ; tout autre membre de `JarvisAdmissionResult` est projeté
 *   par le controller en statut HTTP (mapping fermé, greffe G6/G7) et remonte donc au client en
 *   `AppError` — patron exact de `decideQuoteCreation`, où l'écran refait une lecture autoritative
 *   sur `kind: 'conflict'`.
 * - `GET /jarvis/runs/:runId` — lecture stateless §5.2 : le run projeté + la présentation serveur.
 *   `presentation: null` quand la recomposition ne revérifie pas `fieldsDigest` (greffe G4,
 *   fail-closed) : l'écran n'offre alors AUCUNE confirmation.
 * - `GET /jarvis/runs/current` (lot U1-e §1) — la DÉCOUVERTE : le run NON TERMINAL de l'owner, ou
 *   `{ run: null, presentation: null }`. Un run terminal servi par cette route est un contrat
 *   CASSÉ, pas un run à reprendre : le décodage échoue plutôt que d'offrir une carte morte.
 * - `POST /jarvis/runs` (lot U1-e §1) — ouverture d'un run de modification : seuls le `commandId`
 *   mémoïsé et la cible traversent ; la révision de la cible, l'identité du run, l'action et la
 *   révision de seed sont des faits serveur.
 *
 * Le wire ne transporte JAMAIS le `state` brut d'un run (il ne porte que des digests) : les champs
 * proposés viennent du payload store PII scellé, recomposés par la projection serveur. Toute clé
 * inconnue, toute valeur hors borne, tout digest non canonique ⇒ `null` : le décodage échoue
 * FERMÉ et `req` transforme ce `null` en erreur de contrat, jamais en présentation partielle.
 */

import {
  AGENT_MISSION_KIND,
  CUSTOMER_CONTACT_CONFIRMATION_STATUSES,
  CUSTOMER_CONTACT_PHASES,
  CUSTOMER_CONTACT_SENSITIVE_FIELDS,
  JARVIS_RUN_KINDS,
  JARVIS_RUN_STATUSES,
  JARVIS_RUN_TERMINAL_STATUSES,
  isU1OpenAction,
  type CustomerContactConfirmationStatus,
  type CustomerContactPhase,
  type CustomerContactSensitiveField,
  type JarvisAdmissionKind,
  type JarvisRunStatus,
} from '@bob/core';
import type {
  CustomerContactPresentationV1,
  CustomerContactPresentedFieldV1,
  JarvisCommandReceiptView,
  JarvisCurrentRunView,
  JarvisOpenRunClientInput,
  JarvisRunCommandV1,
  JarvisRunSnapshotView,
  JarvisRunView,
} from './client';

/** Bornes du wire — un serveur qui les dépasse est refusé, jamais tronqué. */
export const JARVIS_PRESENTED_FIELDS_MAX = 24;
export const JARVIS_PRESENTED_TEXT_MAX_LENGTH = 512;
export const JARVIS_RUN_REVISION_MAX = 2_147_483_647;

const SHA_256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FIELD_ID = /^[a-z][a-z0-9_]{0,63}$/u;

const RUN_KEYS = [
  'runId',
  'kind',
  'definitionVersion',
  'status',
  'revision',
  'nextWakeAt',
  'terminalAt',
] as const;
const PRESENTATION_KEYS = [
  'schema',
  'version',
  'phase',
  'intent',
  'targetCustomerId',
  // U1-f §4 — le nom de la fiche visée. Décodé comme du texte présentable ou `null` : l'écran ne
  // compose JAMAIS un libellé lui-même (il n'a pas la fiche), il rend ce que le serveur a nommé.
  'targetLabel',
  'proposal',
  'confirmation',
] as const;
const PROPOSAL_KEYS = ['proposalId', 'proposalHash', 'fieldsDigest', 'fields'] as const;
const CONFIRMATION_KEYS = ['confirmationId', 'status', 'expiresAt', 'presentedAt'] as const;
const FIELD_KEYS = ['field', 'label', 'before', 'after', 'sensitiveField'] as const;
const SNAPSHOT_KEYS = ['run', 'presentation'] as const;
const RECEIPT_KEYS = ['outcome', 'run', 'presentation', 'eventSequence'] as const;
const OPEN_INTENT_KEYS = ['mode', 'target'] as const;
const OPEN_TARGET_KEYS = ['customerId'] as const;

export const JARVIS_PRESENTATION_SCHEMA = 'bob.jarvis-run.customer-contact-presentation';
export const JARVIS_PRESENTATION_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point < 32 || (point >= 127 && point <= 159));
  });
}

/** Texte présenté à l'humain : borné, sans caractère de contrôle, jamais vide après trim. */
function isPresentedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= JARVIS_PRESENTED_TEXT_MAX_LENGTH &&
    !hasControlCharacter(value)
  );
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA_256.test(value);
}

function isRevision(value: unknown, min = 1): value is number {
  return (
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    (value as number) >= min &&
    (value as number) <= JARVIS_RUN_REVISION_MAX
  );
}

/** Instant canonique : l'aller-retour ISO doit être EXACT (patron `instantEpoch` du domaine). */
function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

/** UUID v4 canonique — le contrat §5.4 du `commandId` utilisateur (voix comme tap). */
export function isJarvisUserCommandId(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

/** Kinds admis par le port : le catalogue des kinds MOINS la branche quote (writer N-1). */
export function isJarvisAdmissionKind(value: unknown): value is JarvisAdmissionKind {
  return (
    typeof value === 'string' &&
    value !== AGENT_MISSION_KIND &&
    (JARVIS_RUN_KINDS as readonly string[]).includes(value)
  );
}

function isRunStatus(value: unknown): value is JarvisRunStatus {
  return typeof value === 'string' && (JARVIS_RUN_STATUSES as readonly string[]).includes(value);
}

function isPhase(value: unknown): value is CustomerContactPhase {
  return (
    typeof value === 'string' && (CUSTOMER_CONTACT_PHASES as readonly string[]).includes(value)
  );
}

function isConfirmationStatus(value: unknown): value is CustomerContactConfirmationStatus {
  return (
    typeof value === 'string' &&
    (CUSTOMER_CONTACT_CONFIRMATION_STATUSES as readonly string[]).includes(value)
  );
}

function isSensitiveField(value: unknown): value is CustomerContactSensitiveField {
  return (
    typeof value === 'string' &&
    (CUSTOMER_CONTACT_SENSITIVE_FIELDS as readonly string[]).includes(value)
  );
}

export function decodeJarvisRun(value: unknown): JarvisRunView | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, RUN_KEYS) ||
    !isCanonicalUuid(value.runId) ||
    !isJarvisAdmissionKind(value.kind) ||
    !isRevision(value.definitionVersion) ||
    !isRunStatus(value.status) ||
    !isRevision(value.revision) ||
    (value.nextWakeAt !== null && !isCanonicalInstant(value.nextWakeAt)) ||
    (value.terminalAt !== null && !isCanonicalInstant(value.terminalAt))
  ) {
    return null;
  }
  return Object.freeze({
    runId: value.runId,
    kind: value.kind,
    definitionVersion: value.definitionVersion as number,
    status: value.status,
    revision: value.revision as number,
    nextWakeAt: value.nextWakeAt as string | null,
    terminalAt: value.terminalAt as string | null,
  });
}

function decodePresentedField(value: unknown): CustomerContactPresentedFieldV1 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, FIELD_KEYS) ||
    typeof value.field !== 'string' ||
    !FIELD_ID.test(value.field) ||
    !isPresentedText(value.label) ||
    (value.before !== null && !isPresentedText(value.before)) ||
    !isPresentedText(value.after) ||
    (value.sensitiveField !== null && !isSensitiveField(value.sensitiveField))
  ) {
    return null;
  }
  return Object.freeze({
    field: value.field,
    label: value.label,
    before: value.before as string | null,
    after: value.after,
    sensitiveField: value.sensitiveField as CustomerContactSensitiveField | null,
  });
}

function decodeProposal(value: unknown): CustomerContactPresentationV1['proposal'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PROPOSAL_KEYS) ||
    !isCanonicalUuid(value.proposalId) ||
    !isSha256(value.proposalHash) ||
    !isSha256(value.fieldsDigest) ||
    !Array.isArray(value.fields) ||
    value.fields.length === 0 ||
    value.fields.length > JARVIS_PRESENTED_FIELDS_MAX ||
    Object.keys(value.fields).length !== value.fields.length
  ) {
    return null;
  }
  const fields: CustomerContactPresentedFieldV1[] = [];
  const seen = new Set<string>();
  for (const raw of value.fields) {
    const field = decodePresentedField(raw);
    // Un même champ deux fois = une présentation ambiguë : elle ne doit jamais atteindre l'écran.
    if (field === null || seen.has(field.field)) return null;
    seen.add(field.field);
    fields.push(field);
  }
  return Object.freeze({
    proposalId: value.proposalId,
    proposalHash: value.proposalHash,
    fieldsDigest: value.fieldsDigest,
    fields: Object.freeze(fields),
  });
}

function decodeConfirmation(value: unknown): CustomerContactPresentationV1['confirmation'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, CONFIRMATION_KEYS) ||
    !isCanonicalUuid(value.confirmationId) ||
    !isConfirmationStatus(value.status) ||
    !isCanonicalInstant(value.expiresAt) ||
    (value.presentedAt !== null && !isCanonicalInstant(value.presentedAt))
  ) {
    return null;
  }
  return Object.freeze({
    confirmationId: value.confirmationId,
    status: value.status,
    expiresAt: value.expiresAt,
    presentedAt: value.presentedAt as string | null,
  });
}

export function decodeCustomerContactPresentation(
  value: unknown,
): CustomerContactPresentationV1 | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PRESENTATION_KEYS) ||
    value.schema !== JARVIS_PRESENTATION_SCHEMA ||
    value.version !== JARVIS_PRESENTATION_VERSION ||
    !isPhase(value.phase) ||
    (value.intent !== 'create' && value.intent !== 'update') ||
    (value.targetCustomerId !== null && !isCanonicalUuid(value.targetCustomerId)) ||
    // Une modification sans cible relue n'existe pas (§8) ; une création n'en porte jamais.
    (value.intent === 'update') !== (value.targetCustomerId !== null) ||
    // U1-f §4 — le libellé est du texte PRÉSENTABLE ou `null`. Un serveur qui enverrait autre
    // chose (objet, nombre, chaîne de contrôle) est refusé À LA FORME : l'écran n'affiche jamais
    // un nom qu'il n'a pas pu valider.
    (value.targetLabel !== null && !isPresentedText(value.targetLabel))
  ) {
    return null;
  }
  let proposal: CustomerContactPresentationV1['proposal'] = null;
  if (value.proposal !== null) {
    proposal = decodeProposal(value.proposal);
    if (proposal === null) return null;
  }
  let confirmation: CustomerContactPresentationV1['confirmation'] = null;
  if (value.confirmation !== null) {
    confirmation = decodeConfirmation(value.confirmation);
    if (confirmation === null) return null;
  }
  // Une confirmation sans proposition scellée n'a rien à confirmer : refus fermé.
  if (confirmation !== null && proposal === null) return null;
  return Object.freeze({
    schema: JARVIS_PRESENTATION_SCHEMA,
    version: JARVIS_PRESENTATION_VERSION,
    phase: value.phase,
    intent: value.intent,
    targetCustomerId: value.targetCustomerId as string | null,
    targetLabel: value.targetLabel as string | null,
    proposal,
    confirmation,
  });
}

export function decodeJarvisRunSnapshot(value: unknown): JarvisRunSnapshotView | null {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) return null;
  const run = decodeJarvisRun(value.run);
  if (run === null) return null;
  if (value.presentation === null) return Object.freeze({ run, presentation: null });
  const presentation = decodeCustomerContactPresentation(value.presentation);
  return presentation === null ? null : Object.freeze({ run, presentation });
}

/**
 * Découverte (§1). Deux formes seulement : « aucun run » (les DEUX champs à `null`) ou un run
 * NON TERMINAL. Un run terminal, ou une présentation servie sans run, sont des contrats cassés
 * — jamais une carte à demi montrable : le décodage échoue FERMÉ et `req` en fait une erreur.
 */
export function decodeJarvisCurrentRun(value: unknown): JarvisCurrentRunView | null {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) return null;
  if (value.run === null) {
    return value.presentation === null ? Object.freeze({ run: null, presentation: null }) : null;
  }
  const run = decodeJarvisRun(value.run);
  if (run === null) return null;
  // Un run terminal n'a plus rien à reprendre : le rendre « courant » afficherait une carte morte.
  if (run.terminalAt !== null || JARVIS_RUN_TERMINAL_STATUSES.has(run.status)) return null;
  if (value.presentation === null) return Object.freeze({ run, presentation: null });
  const presentation = decodeCustomerContactPresentation(value.presentation);
  return presentation === null ? null : Object.freeze({ run, presentation });
}

export function decodeJarvisCommandReceipt(value: unknown): JarvisCommandReceiptView | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, RECEIPT_KEYS) ||
    (value.outcome !== 'admitted' && value.outcome !== 'replayed') ||
    !isRevision(value.eventSequence)
  ) {
    return null;
  }
  const run = decodeJarvisRun(value.run);
  if (run === null) return null;
  if (value.presentation === null) {
    return Object.freeze({
      outcome: value.outcome,
      run,
      presentation: null,
      eventSequence: value.eventSequence as number,
    });
  }
  const presentation = decodeCustomerContactPresentation(value.presentation);
  return presentation === null
    ? null
    : Object.freeze({
        outcome: value.outcome,
        run,
        presentation,
        eventSequence: value.eventSequence as number,
      });
}

/**
 * Valide puis RECONSTRUIT le corps exact de la commande envoyée au serveur : aucune clé étrangère
 * ne peut traverser ce codec, et le domaine (`parseCustomerContactCommand`) recevra la même forme
 * exacte. `record_target_mutation`, `record_effect_*` et `wake_run` sont hors du canal client :
 * ce sont des observations SYSTÈME (§5.6), jamais un geste humain.
 */
export function encodeJarvisRunCommand(value: unknown): JarvisRunCommandV1 | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'record_presentation_ack':
      return hasExactKeys(value, ['type', 'confirmationId', 'ack']) &&
        isCanonicalUuid(value.confirmationId) &&
        // Le canal tactile n'émet QUE `screen_ack` : `voice_presentation_ack` appartient à la voix.
        value.ack === 'screen_ack'
        ? Object.freeze({
            type: 'record_presentation_ack',
            confirmationId: value.confirmationId,
            ack: 'screen_ack',
          })
        : null;
    case 'confirm':
      return hasExactKeys(value, ['type', 'confirmationId', 'proposalHash']) &&
        isCanonicalUuid(value.confirmationId) &&
        isSha256(value.proposalHash)
        ? Object.freeze({
            type: 'confirm',
            confirmationId: value.confirmationId,
            proposalHash: value.proposalHash,
          })
        : null;
    case 'reject_proposal':
      return hasExactKeys(value, ['type', 'confirmationId']) &&
        isCanonicalUuid(value.confirmationId)
        ? Object.freeze({ type: 'reject_proposal', confirmationId: value.confirmationId })
        : null;
    case 'cancel_run':
      return hasExactKeys(value, ['type', 'reason']) &&
        (value.reason === 'user_cancelled' || value.reason === 'manual_handoff')
        ? Object.freeze({ type: 'cancel_run', reason: value.reason })
        : null;
    default:
      return null;
  }
}

/**
 * Valide puis RECONSTRUIT l'intention d'ouverture : `{ mode: 'update', target: { customerId } }`
 * et rien d'autre. L'écran n'ouvre QUE des modifications (une création naît de la voix ou du
 * formulaire), et la RÉVISION de la cible n'a pas sa place ici — le client ne la possède pas,
 * donc il ne l'affirme pas : c'est le serveur qui relit la fiche (§7.1/§8).
 */
export function encodeJarvisOpenRunIntent(
  value: unknown,
): JarvisOpenRunClientInput['intent'] | null {
  if (!isRecord(value) || !hasExactKeys(value, OPEN_INTENT_KEYS) || value.mode !== 'update') {
    return null;
  }
  const target = value.target;
  if (
    !isRecord(target) ||
    !hasExactKeys(target, OPEN_TARGET_KEYS) ||
    !isCanonicalUuid(target.customerId)
  ) {
    return null;
  }
  return Object.freeze({
    mode: 'update' as const,
    target: Object.freeze({ customerId: target.customerId }),
  });
}

/**
 * Borne d'ouverture du lot (greffe G2) : la SEULE source est `rollout.ts` de @bob/core, partagée
 * avec le planner, l'orchestrateur realtime, le controller et le worker. Jamais une liste locale.
 */
export function isJarvisOpenAction(actionId: unknown, actionVersion: unknown): boolean {
  return (
    typeof actionId === 'string' &&
    Number.isSafeInteger(actionVersion) &&
    isU1OpenAction(actionId, actionVersion as number)
  );
}

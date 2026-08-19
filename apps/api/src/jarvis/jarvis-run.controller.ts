/**
 * Canal TACTILE d'un run Jarvis (spec §5.2/§5.4/§7.0/§7.1/§14 —
 * SPEC_U1D_CALLERS_REELS_20260819 §3 « TAP », greffes G1/G2/G4/G6) — lot U1-d,
 * élargi par SPEC_U1E_PARCOURS_VISIBLE_20260819 §1 (découverte et ouverture depuis l'écran).
 *
 * Quatre routes, pas une de plus :
 *   · `POST /jarvis/runs/:runId/commands` — un geste humain entre, LA transaction d'admission
 *     (§5.2) décide, un reçu fermé sort ;
 *   · `POST /jarvis/runs`                — ouverture d'un run `customer_contact@1` de
 *     MODIFICATION depuis l'écran : route DÉDIÉE, jamais un élargissement du canal de commandes
 *     (un tap n'a toujours pas le droit de semer un run par `runs/:runId/commands`) ;
 *   · `GET  /jarvis/runs/current`        — découverte : le run NON TERMINAL de l'owner, ou
 *     `null`. Miroir exact de `agent-missions/current/quote-creation/resume` : sans elle,
 *     l'appareil ne peut connaître aucun `runId` (la voix ne renvoie que la parole) ;
 *   · `GET  /jarvis/runs/:runId`         — lecture stateless §5.2 : zéro verrou, zéro écriture.
 *
 * L'ORDRE de déclaration de ces méthodes est porteur : Nest apparie dans l'ordre du prototype,
 * donc `runs/current` doit être déclarée AVANT `runs/:runId`, sinon le littéral « current » est
 * capturé comme identifiant de run (et refusé en 404, faute d'être un UUID canonique).
 *
 * Ce que ce controller ne délègue à personne :
 * - **autorité (G1)** : `authenticated_principal`. Le tap vit SANS lease Realtime — §14 et le
 *   gate « un `JarvisRun` parké se reprend sans lease » l'exigent : après la mort de la session
 *   vocale, l'artisan continue à l'écran. L'owner ET le `principalBindingHash` sont dérivés
 *   SERVEUR du bearer admis (jamais du corps) et stampés pour l'audit ;
 * - **corps exact** : toute clé inconnue, toute clé manquante, toute valeur hors borne ⇒ 422.
 *   Un corps portant `companyId`, `ownerUserId`, `occurredAt` ou `canonicalInputDigest` est
 *   refusé PAR CONSTRUCTION : ce sont des faits serveur ;
 * - **`occurredAt` et `canonicalInputDigest` calculés serveur** (G7) : deux essais du même
 *   `commandId` produisent la même empreinte — condition du rejeu zéro-write §5.2 ;
 * - **bornes d'ouverture (G2)** : `U1_OPEN_ACTIONS` de @bob/core, source UNIQUE partagée avec le
 *   planner, l'orchestrateur vocal et le worker. Jamais une liste locale ;
 * - **mapping fermé (G6)** : chaque membre de `JarvisAdmissionResult` a UN statut HTTP. Le
 *   client n'a jamais à deviner, et aucun refus ne devient un 500 muet ;
 * - **présentation fail-closed (G4)** : la projection écran est recomposée depuis le payload
 *   store PII scellé, dont la relecture revérifie `fieldsDigest`. Charge absente ou digest
 *   divergent ⇒ `presentation: null` : l'écran n'offre AUCUNE confirmation.
 *
 * Le flux devis (writer N-1) reste intact : `AgentMissionHttpOperation` et la négociation de
 * capability sont fermées ailleurs, et la capability ne traverse JAMAIS ces routes.
 */

import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Optional,
  Param,
  Post,
  type Provider,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  AGENT_MISSION_INT4_MAX,
  AGENT_MISSION_KIND,
  CUSTOMER_CONTACT_ACTION_VERSION,
  CUSTOMER_CONTACT_DEFINITION_VERSION,
  CUSTOMER_CONTACT_PROPOSED_FIELD_KEYS,
  CUSTOMER_CONTACT_SENSITIVE_FIELDS,
  CUSTOMER_CONTACT_SENSITIVE_FIELD_SOURCES,
  CUSTOMER_CONTACT_UPDATE_ACTION_ID,
  JARVIS_RUN_KINDS,
  JARVIS_RUN_TERMINAL_STATUSES,
  appConflict,
  appForbidden,
  appNotFound,
  appUnavailable,
  err,
  isCanonicalAgentMissionUserCommandId,
  isCanonicalAgentMissionUuid,
  isU1OpenAction,
  ok,
  parseCustomerContactState,
  sha256Hex,
  type AppError,
  type CustomerContactConfirmationStatus,
  type CustomerContactPhase,
  type CustomerContactProposedFieldKey,
  type CustomerContactProposedFieldsV1,
  type CustomerContactSensitiveField,
  type CustomerContactStateV1,
  type JarvisAdmissionAuthority,
  type JarvisAdmissionKind,
  type JarvisAdmissionOwner,
  type JarvisAdmissionResult,
  type JarvisAdmissionUnitOfWorkPort,
  type JarvisProposalPayloadStorePort,
  type JarvisReduceError,
  type JarvisRunEnvelope,
  type JarvisRunStatus,
  type JarvisUserAdmissionEnvelope,
  type Result,
} from '@bob/core';

import { unwrap } from '../http/result';
import { AppLogger, getPrincipal } from '../observability/logger';
import { WithoutTenantPersistenceTransaction } from '../persistence/tenant-persistence.interceptor';
import { isRealtimeCompanyId } from '../voice/realtime/realtime-admission';
import { agentMissionPrincipalBindingHash } from '../voice/realtime/realtime-agent-mission-admission';

import { jarvisAdmissionEnabled } from './jarvis-admission.provider';
import { JARVIS_ADMISSION, JARVIS_PROPOSAL_PAYLOAD_STORE } from './jarvis.tokens';

/**
 * Refus HTTP typé : `unwrap` lève toujours sur un `Result` en erreur ; la signature `never` le
 * dit au compilateur, donc rien ne « continue » après un refus.
 */
function refuse(error: AppError): never {
  unwrap<never>({ ok: false, error });
  throw new Error('JARVIS_TAP_REFUSAL_UNREACHABLE');
}

// ---------------------------------------------------------------------------
// Autorité du canal tactile (greffe G1) — bearer seul, jamais une capability
// ---------------------------------------------------------------------------

export const JARVIS_TAP_AUTHORITY = Symbol('JARVIS_TAP_AUTHORITY');

/** Les quatre seules opérations du canal — union fermée, jamais un verbe libre. */
export type JarvisTapOperation =
  'submit_run_command' | 'open_run' | 'read_current_run' | 'read_run';

export interface JarvisTapAuthorization {
  readonly operation: JarvisTapOperation;
  readonly owner: JarvisAdmissionOwner;
  readonly authority: Extract<JarvisAdmissionAuthority, { source: 'authenticated_principal' }>;
}

export interface JarvisTapAuthority {
  prepare(operation: JarvisTapOperation): Result<JarvisTapAuthorization, AppError>;
}

function validOwnerUserId(value: string): boolean {
  return value.length >= 1
    && value === value.trim()
    && Buffer.byteLength(value, 'utf8') <= 512
    && !value.includes('\u0000');
}

/**
 * Owner et liaison de principal dérivés du bearer admis (`getPrincipal`, posé par le guard) :
 * le client ne choisit ni la société, ni l'utilisateur, ni le hash de liaison.
 */
export class DurableJarvisTapAuthority implements JarvisTapAuthority {
  prepare(operation: JarvisTapOperation): Result<JarvisTapAuthorization, AppError> {
    const principal = getPrincipal();
    if (
      principal === undefined
      || principal.companyId === null
      || !isRealtimeCompanyId(principal.companyId)
      || typeof principal.userId !== 'string'
      || !validOwnerUserId(principal.userId)
    ) {
      return err(appForbidden('authenticated_jarvis_owner_required'));
    }
    let principalBindingHash: string;
    try {
      principalBindingHash = agentMissionPrincipalBindingHash(
        principal.companyId,
        principal.userId,
      );
    } catch {
      return err(appForbidden('authenticated_jarvis_owner_required'));
    }
    return ok(Object.freeze({
      operation,
      owner: Object.freeze({
        companyId: principal.companyId,
        ownerUserId: principal.userId,
      }),
      authority: Object.freeze({
        source: 'authenticated_principal' as const,
        principalBindingHash,
      }),
    }));
  }
}

/** Vertical fermé au boot : aucune route n'ouvre et aucune ne ment sur ce qu'elle a fait. */
export class DisabledJarvisTapAuthority implements JarvisTapAuthority {
  prepare(_operation: JarvisTapOperation): Result<JarvisTapAuthorization, AppError> {
    return err(appUnavailable('jarvis_tap_authority'));
  }
}

/**
 * Le drapeau est lu DEUX fois, à deux échelles : ici au boot (le vertical est ouvert ou fermé)
 * et à chaque appel dans les deps d'admission (le kill switch se coupe à chaud sans jamais
 * s'opposer aux signaux d'effets déjà autorisés).
 */
export const jarvisTapAuthorityProvider: Provider = {
  provide: JARVIS_TAP_AUTHORITY,
  useFactory: (): JarvisTapAuthority =>
    jarvisAdmissionEnabled() ? new DurableJarvisTapAuthority() : new DisabledJarvisTapAuthority(),
};

// ---------------------------------------------------------------------------
// Gardes de corps (patron `exactBody` du controller devis, helpers privés là-bas)
// ---------------------------------------------------------------------------

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function invalidBody(field: string, message: string): never {
  return refuse({ kind: 'validation', issues: [{ field, message }] });
}

function exactBody(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const body = jsonObject(value);
  if (body === null) invalidBody('body', 'Corps JSON objet requis.');
  const unknownField = Object.keys(body).find((field) => !fields.includes(field));
  if (unknownField !== undefined) invalidBody(unknownField, 'Champ non autorisé.');
  for (const field of fields) {
    if (!Object.hasOwn(body, field)) invalidBody(field, 'Champ requis.');
  }
  return body;
}

function boundedInteger(value: unknown, min: number): value is number {
  return Number.isSafeInteger(value)
    && !Object.is(value, -0)
    && (value as number) >= min
    && (value as number) <= AGENT_MISSION_INT4_MAX;
}

function isJarvisAdmissionKind(value: unknown): value is JarvisAdmissionKind {
  return typeof value === 'string'
    && value !== AGENT_MISSION_KIND
    && (JARVIS_RUN_KINDS as readonly string[]).includes(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

/**
 * Sous-ensemble des commandes `customer_contact@1` qu'un HUMAIN émet depuis un appareil,
 * RECONSTRUIT clé par clé : aucune clé étrangère ne traverse, et le domaine reçoit la forme
 * exacte qu'il sait parser. `record_customer_resolution`, `stage_proposal`, `record_target_
 * mutation`, `record_effect_*` et `wake_run` n'y sont PAS : observations système (§5.6) ou
 * gestes que seule la voix ouvre — jamais un tap.
 */
export type JarvisTapCommand =
  | {
      readonly type: 'record_presentation_ack';
      readonly confirmationId: string;
      readonly ack: 'screen_ack';
    }
  | { readonly type: 'confirm'; readonly confirmationId: string; readonly proposalHash: string }
  | { readonly type: 'reject_proposal'; readonly confirmationId: string }
  | { readonly type: 'cancel_run'; readonly reason: 'user_cancelled' | 'manual_handoff' };

export function parseJarvisTapCommand(value: unknown): JarvisTapCommand {
  const candidate = jsonObject(value);
  if (candidate === null) invalidBody('command', 'Commande JSON objet requise.');
  switch (candidate.type) {
    case 'record_presentation_ack': {
      const body = exactBody(candidate, ['type', 'confirmationId', 'ack']);
      if (!isCanonicalAgentMissionUuid(body.confirmationId)) {
        invalidBody('command.confirmationId', 'UUID canonique requis.');
      }
      // Le canal tactile n'émet QUE `screen_ack` : `voice_presentation_ack` appartient à la voix.
      if (body.ack !== 'screen_ack') invalidBody('command.ack', 'Accusé écran requis.');
      return {
        type: 'record_presentation_ack',
        confirmationId: body.confirmationId,
        ack: 'screen_ack',
      };
    }
    case 'confirm': {
      const body = exactBody(candidate, ['type', 'confirmationId', 'proposalHash']);
      if (!isCanonicalAgentMissionUuid(body.confirmationId)) {
        invalidBody('command.confirmationId', 'UUID canonique requis.');
      }
      if (!isSha256(body.proposalHash)) {
        invalidBody('command.proposalHash', 'Digest sha256 canonique requis.');
      }
      return {
        type: 'confirm',
        confirmationId: body.confirmationId,
        proposalHash: body.proposalHash,
      };
    }
    case 'reject_proposal': {
      const body = exactBody(candidate, ['type', 'confirmationId']);
      if (!isCanonicalAgentMissionUuid(body.confirmationId)) {
        invalidBody('command.confirmationId', 'UUID canonique requis.');
      }
      return { type: 'reject_proposal', confirmationId: body.confirmationId };
    }
    case 'cancel_run': {
      const body = exactBody(candidate, ['type', 'reason']);
      if (body.reason !== 'user_cancelled' && body.reason !== 'manual_handoff') {
        invalidBody('command.reason', 'Motif d’arrêt invalide.');
      }
      return { type: 'cancel_run', reason: body.reason };
    }
    default:
      return invalidBody('command.type', 'Commande hors du canal utilisateur.');
  }
}

export interface JarvisSubmitCommandBody {
  readonly kind: JarvisAdmissionKind;
  readonly definitionVersion: number;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly actionId: string;
  readonly actionVersion: number;
  readonly command: JarvisTapCommand;
}

/**
 * Corps EXACT du canal tactile. `expectedRevision` est borné à 1 : un tap ne SÈME jamais un run
 * (révision 0) — il en poursuit un, l'ouverture restant un geste vocal ou d'écran dédié.
 */
export function parseJarvisSubmitCommandBody(value: unknown): JarvisSubmitCommandBody {
  const body = exactBody(value, [
    'kind',
    'definitionVersion',
    'commandId',
    'expectedRevision',
    'actionId',
    'actionVersion',
    'command',
  ]);
  if (!isJarvisAdmissionKind(body.kind)) {
    invalidBody('kind', 'Kind de run Jarvis inconnu du port d’admission.');
  }
  if (!boundedInteger(body.definitionVersion, 1)) {
    invalidBody('definitionVersion', 'Version de définition positive requise.');
  }
  // §5.4 : le commandId utilisateur est un UUID v4 cryptographique, généré UNE fois côté client
  // et conservé jusqu'au reçu — c'est lui, et lui seul, qui rend le rejeu zéro-write possible.
  if (!isCanonicalAgentMissionUserCommandId(body.commandId)) {
    invalidBody('commandId', 'UUID v4 canonique requis.');
  }
  if (!boundedInteger(body.expectedRevision, 1)) {
    invalidBody('expectedRevision', 'Révision positive requise.');
  }
  if (typeof body.actionId !== 'string' || !boundedInteger(body.actionVersion, 1)) {
    invalidBody('actionId', 'Action canonique requise.');
  }
  // Borne d'ouverture du lot (G2) — source UNIQUE @bob/core, jamais une liste locale.
  if (!isU1OpenAction(body.actionId, body.actionVersion)) {
    invalidBody('actionId', 'Action hors des bornes d’ouverture du lot.');
  }
  return {
    kind: body.kind,
    definitionVersion: body.definitionVersion,
    commandId: body.commandId,
    expectedRevision: body.expectedRevision,
    actionId: body.actionId,
    actionVersion: body.actionVersion,
    command: parseJarvisTapCommand(body.command),
  };
}

// ---------------------------------------------------------------------------
// Ouverture depuis l'écran (§1 U1-e) — route dédiée, corps minuscule
// ---------------------------------------------------------------------------

/**
 * `start_run` d'une MODIFICATION : la seule commande du canal écran qui SÈME un run. Elle reste
 * hors de `JarvisTapCommand` à dessein — le canal `runs/:runId/commands` continue de refuser
 * toute révision de seed (`expectedRevision >= 1`), et l'ouverture passe par sa route dédiée.
 */
export interface JarvisOpenRunCommand {
  readonly type: 'start_run';
  readonly intent: {
    readonly mode: 'update';
    readonly target: { readonly customerId: string; readonly revision: number };
  };
}

/**
 * Résolution de cible émise par le SERVEUR juste après le semis (§8). Elle n'est ni du canal
 * tap (aucun humain ne l'émet) ni de l'ouverture : c'est le second maillon serveur, sans lequel
 * un run ouvert depuis l'écran resterait parké en `resolving_customer`.
 */
export interface JarvisServerResolutionCommand {
  readonly type: 'record_customer_resolution';
  readonly resolution: {
    readonly kind: 'target_verified';
    readonly customerId: string;
  };
}

/**
 * Corps EXACT de l'ouverture. Le client n'apporte QUE ce qu'il possède : son `commandId` (§5.4,
 * mémoïsé jusqu'au reçu) et l'identité de la fiche visée. Ni `kind`, ni `definitionVersion`, ni
 * `actionId`, ni `expectedRevision`, ni `runId` : une route dédiée à `customer_contact@1` PINCE
 * elle-même son action — laisser le client la choisir rouvrirait la borne G2 par la fenêtre.
 */
export interface JarvisOpenRunBody {
  readonly commandId: string;
  readonly intent: {
    readonly mode: 'update';
    readonly target: { readonly customerId: string };
  };
}

export function parseJarvisOpenRunBody(value: unknown): JarvisOpenRunBody {
  const body = exactBody(value, ['commandId', 'intent']);
  if (!isCanonicalAgentMissionUserCommandId(body.commandId)) {
    invalidBody('commandId', 'UUID v4 canonique requis.');
  }
  const candidate = jsonObject(body.intent);
  if (candidate === null) invalidBody('intent', 'Intention JSON objet requise.');
  // Le MODE est vérifié avant la forme : refuser une création faute de `target` nommerait la
  // mauvaise règle. L'écran n'ouvre QUE des modifications — la création naît de la voix ou du
  // formulaire client, et un `mode: 'create'` accepté ici sèmerait un run que personne ne
  // saurait présenter.
  if (candidate.mode !== 'update') {
    invalidBody('intent.mode', 'Ouverture de modification requise.');
  }
  const intent = exactBody(candidate, ['mode', 'target']);
  // La RÉVISION de la cible est absente du corps PAR CONSTRUCTION : l'appareil ne la possède pas
  // (aucune projection client ne la porte) et ne pourrait donc que l'inventer. Un corps qui la
  // porterait quand même est refusé comme clé inconnue.
  const target = exactBody(intent.target, ['customerId']);
  if (!isCanonicalAgentMissionUuid(target.customerId)) {
    invalidBody('intent.target.customerId', 'UUID canonique requis.');
  }
  return {
    commandId: body.commandId,
    intent: { mode: 'update', target: { customerId: target.customerId } },
  };
}

// ---------------------------------------------------------------------------
// Digest canonique d'entrée (G7) — calculé SERVEUR, stable au retry du commandId
// ---------------------------------------------------------------------------

const TAP_INPUT_NAMESPACE = 'bob.jarvis.customer-contact.tap-input.v1';

export function computeJarvisTapCanonicalInputDigest(input: {
  readonly runId: string;
  readonly commandId: string;
  readonly command: JarvisTapCommand | JarvisOpenRunCommand | JarvisServerResolutionCommand;
}): string {
  return sha256Hex(JSON.stringify([
    TAP_INPUT_NAMESPACE,
    input.runId,
    input.commandId,
    input.command,
  ]));
}

// ---------------------------------------------------------------------------
// Identité du run ouvert depuis l'écran — DÉRIVÉE, jamais tirée au sort
// ---------------------------------------------------------------------------

const SCREEN_RUN_NAMESPACE = 'bob.jarvis.customer-contact.screen-run.v1';

/** UUID canonique de forme v4 dérivé d'un digest — patron exact de l'orchestrateur vocal. */
function uuidFromDigest(digest: string): string {
  const hex = digest.slice(0, 32);
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  const uuid = `${hex.slice(0, 12)}4${hex.slice(13, 16)}${variant}${hex.slice(17)}`;
  return [
    uuid.slice(0, 8),
    uuid.slice(8, 12),
    uuid.slice(12, 16),
    uuid.slice(16, 20),
    uuid.slice(20),
  ].join('-');
}

/**
 * Identité déterministe du run semé depuis un écran, dérivée de l'owner ET du `commandId`
 * mémoïsé. Conséquence voulue : deux essais du MÊME geste (reçu perdu, réseau coupé, remontage)
 * visent le MÊME `runId`, donc le second est un rejeu zéro-write (§5.2) et non un second run
 * fantôme. Le client ne choisit jamais l'identité d'un run — c'est un fait serveur (§5.4), comme
 * `occurredAt` et `canonicalInputDigest`.
 */
export function deriveJarvisScreenRunId(owner: JarvisAdmissionOwner, commandId: string): string {
  return uuidFromDigest(
    sha256Hex(`${SCREEN_RUN_NAMESPACE} ${owner.companyId} ${owner.ownerUserId} ${commandId}`),
  );
}

/**
 * Révision de cible d'une intention d'ouverture. Elle n'est PAS une preuve : ni l'appareil ni ce
 * controller ne relisent la fiche (une lecture hors transaction serait un TOCTOU — §2 de la spec
 * U1-e). Le domaine la remplace par la révision RELUE dès la résolution de cible
 * (`record_customer_resolution` / `target_verified`), et `stage_proposal` refuse toute
 * proposition qui ne scelle pas cette révision vérifiée (`target_revision_stale`) : aucune
 * décision ne s'appuie jamais sur cette graine. Elle vaut le minimum légal du domaine.
 */
export const JARVIS_UNVERIFIED_TARGET_REVISION = 1;

/**
 * Révision d'un run JUSTE SEMÉ. Un semis part toujours de `expectedRevision = 0` et rend 1 :
 * c'est un fait du moteur, pas une observation.
 *
 * POURQUOI UNE CONSTANTE ET NON LE POSTIMAGE RENDU. Le second maillon de l'ouverture (§8) doit
 * porter la MÊME empreinte à l'admission et au rejeu — `expectedRevision` entre dans l'empreinte
 * canonique de la commande. Or le postimage d'un semis REJOUÉ est le run TEL QU'IL EST (déjà
 * résolu, révision 2) : s'y fier ferait muter l'empreinte au rejeu, le reçu ne serait plus
 * reconnu, et une ouverture rejouée retomberait en conflit au lieu de rendre son reçu original.
 */
const JARVIS_SEEDED_RUN_REVISION = 1;

// ---------------------------------------------------------------------------
// Projection wire du run (§5.1) — le `state` durable ne sort JAMAIS
// ---------------------------------------------------------------------------

export interface JarvisRunWireView {
  readonly runId: string;
  readonly kind: JarvisAdmissionKind;
  readonly definitionVersion: number;
  readonly status: JarvisRunStatus;
  readonly revision: number;
  readonly nextWakeAt: string | null;
  readonly terminalAt: string | null;
}

export function projectJarvisRunView(envelope: JarvisRunEnvelope): JarvisRunWireView | null {
  // La branche devis garde ses routes legacy (§17.1) : elle ne sort jamais par ce canal.
  if (envelope.kind === AGENT_MISSION_KIND) return null;
  return Object.freeze({
    runId: envelope.runId,
    kind: envelope.kind,
    definitionVersion: envelope.definitionVersion,
    status: envelope.status,
    revision: envelope.revision,
    nextWakeAt: envelope.nextWakeAt,
    terminalAt: envelope.terminalAt,
  });
}

// ---------------------------------------------------------------------------
// Projection écran (greffe G4) — recomposée depuis la charge PII scellée
// ---------------------------------------------------------------------------

export const JARVIS_PRESENTATION_SCHEMA = 'bob.jarvis-run.customer-contact-presentation' as const;
export const JARVIS_PRESENTATION_VERSION = 1 as const;
const PRESENTED_TEXT_MAX_LENGTH = 512;

export interface CustomerContactPresentedFieldWire {
  readonly field: string;
  readonly label: string;
  readonly before: string | null;
  readonly after: string;
  readonly sensitiveField: CustomerContactSensitiveField | null;
}

export interface CustomerContactPresentationWire {
  readonly schema: typeof JARVIS_PRESENTATION_SCHEMA;
  readonly version: typeof JARVIS_PRESENTATION_VERSION;
  readonly phase: CustomerContactPhase;
  readonly intent: 'create' | 'update';
  readonly targetCustomerId: string | null;
  readonly proposal:
    | {
        readonly proposalId: string;
        readonly proposalHash: string;
        readonly fieldsDigest: string;
        readonly fields: readonly CustomerContactPresentedFieldWire[];
      }
    | null;
  readonly confirmation:
    | {
        readonly confirmationId: string;
        readonly status: CustomerContactConfirmationStatus;
        readonly expiresAt: string;
        readonly presentedAt: string | null;
      }
    | null;
}

/**
 * Étiquettes HUMAINES des champs proposés : la formulation montrée à l'écran est aussi celle que
 * Bob vocalise (§7.0 règles 2-3) — le mobile ne reconstruit jamais de jargon. L'identifiant de
 * champ est technique et stable ; le libellé est la phrase de l'artisan.
 */
const PRESENTED_FIELDS: Readonly<
  Record<CustomerContactProposedFieldKey, { readonly id: string; readonly label: string }>
> = Object.freeze({
  displayName: { id: 'display_name', label: 'Nom' },
  legalName: { id: 'legal_name', label: 'Raison sociale' },
  email: { id: 'email', label: 'E-mail' },
  phone: { id: 'phone', label: 'Téléphone' },
  addressLine: { id: 'address_line', label: 'Adresse' },
  postalCode: { id: 'postal_code', label: 'Code postal' },
  city: { id: 'city', label: 'Ville' },
  vatNumber: { id: 'vat_number', label: 'Numéro de TVA' },
  billingChannel: { id: 'billing_channel', label: 'Facturation' },
  recipientName: { id: 'recipient_name', label: 'Destinataire' },
});

const BILLING_CHANNEL_LABELS: Readonly<Record<'email' | 'postal', string>> = Object.freeze({
  email: 'Par e-mail',
  postal: 'Par courrier',
});

/**
 * Inversion de la projection §9.1 (champ sensible -> champs proposés), DÉRIVÉE de la source du
 * domaine : une liste jumelle écrite à la main divergerait un jour, en silence.
 */
const SENSITIVE_FIELD_BY_KEY: ReadonlyMap<
  CustomerContactProposedFieldKey,
  CustomerContactSensitiveField
> = new Map(
  CUSTOMER_CONTACT_SENSITIVE_FIELDS.flatMap((sensitive) =>
    CUSTOMER_CONTACT_SENSITIVE_FIELD_SOURCES[sensitive].map(
      (key) => [key, sensitive] as const,
    )),
);

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point < 32 || (point >= 127 && point <= 159));
  });
}

function presentedText(value: string): string | null {
  return value.trim().length > 0
    && value.length <= PRESENTED_TEXT_MAX_LENGTH
    && !hasControlCharacter(value)
    ? value
    : null;
}

/** Valeur affichable d'un champ proposé — le canal de facturation se dit, il ne se code pas. */
function presentedValue(
  fields: CustomerContactProposedFieldsV1,
  key: CustomerContactProposedFieldKey,
): string | null {
  if (key === 'billingChannel') {
    const channel = fields.billingChannel;
    return channel === null ? null : BILLING_CHANNEL_LABELS[channel];
  }
  return fields[key];
}

/**
 * Champs présentés : uniquement ceux réellement PROPOSÉS, dans l'ordre canonique du digest.
 * `before` reste `null` en U1-d — l'« avant » d'une modification est la fiche RELUE (§8), que ce
 * canal ne possède pas : mieux vaut ne rien montrer qu'un avant reconstitué de mémoire.
 */
export function presentCustomerContactFields(
  fields: CustomerContactProposedFieldsV1,
): readonly CustomerContactPresentedFieldWire[] | null {
  const presented: CustomerContactPresentedFieldWire[] = [];
  for (const key of CUSTOMER_CONTACT_PROPOSED_FIELD_KEYS) {
    const raw = presentedValue(fields, key);
    if (raw === null) continue;
    const after = presentedText(raw);
    // Une valeur impossible à présenter honnêtement rend TOUTE la présentation absente.
    if (after === null) return null;
    presented.push(Object.freeze({
      field: PRESENTED_FIELDS[key].id,
      label: PRESENTED_FIELDS[key].label,
      before: null,
      after,
      sensitiveField: SENSITIVE_FIELD_BY_KEY.get(key) ?? null,
    }));
  }
  return presented.length === 0 ? null : Object.freeze(presented);
}

export function projectCustomerContactPresentation(
  state: CustomerContactStateV1,
  fields: CustomerContactProposedFieldsV1 | null,
): CustomerContactPresentationWire | null {
  const targetCustomerId = state.intent.mode === 'update' ? state.intent.target.customerId : null;
  const proposal = state.proposal;
  if (proposal === null) {
    // Rien de proposé : la présentation existe (phase, intention) mais n'offre AUCUN geste.
    return Object.freeze({
      schema: JARVIS_PRESENTATION_SCHEMA,
      version: JARVIS_PRESENTATION_VERSION,
      phase: state.phase,
      intent: state.intent.mode,
      targetCustomerId,
      proposal: null,
      confirmation: null,
    });
  }
  // Charge absente ou digest divergent (G4) : fail-closed, l'écran ne confirme rien.
  if (fields === null) return null;
  const presented = presentCustomerContactFields(fields);
  if (presented === null) return null;
  const confirmation = state.confirmation;
  return Object.freeze({
    schema: JARVIS_PRESENTATION_SCHEMA,
    version: JARVIS_PRESENTATION_VERSION,
    phase: state.phase,
    intent: state.intent.mode,
    targetCustomerId,
    proposal: Object.freeze({
      proposalId: proposal.proposalId,
      proposalHash: proposal.proposalHash,
      fieldsDigest: proposal.fieldsDigest,
      fields: presented,
    }),
    confirmation: confirmation === null
      ? null
      : Object.freeze({
          confirmationId: confirmation.confirmationId,
          status: confirmation.status,
          expiresAt: confirmation.expiresAt,
          presentedAt: confirmation.presentedAt,
        }),
  });
}

// ---------------------------------------------------------------------------
// Mapping FERMÉ du résultat d'admission vers HTTP (greffe G6)
// ---------------------------------------------------------------------------

/** L'erreur déléguée d'une définition reste une donnée : lue défensivement, jamais dépliée. */
function delegatedReason(error: unknown): string {
  const candidate = jsonObject(error);
  const code = candidate === null ? null : candidate.code;
  const reason = candidate === null ? null : candidate.reason;
  if (typeof code !== 'string') return 'delegated_error';
  return typeof reason === 'string' ? `${code}:${reason}` : code;
}

function refusedReason(error: JarvisReduceError): string {
  switch (error.code) {
    case 'legacy_route_active':
      return 'legacy_route_active';
    case 'definition_version_unknown':
      return 'definition_version_unknown';
    case 'run_terminal':
      return `run_terminal:${error.status}`;
    case 'revision_conflict':
      return 'revision_conflict';
    case 'invalid_command':
      return `invalid_command:${error.reason}`;
    case 'delegated_error':
      return delegatedReason(error.error);
  }
}

/**
 * Chaque membre du résultat a UN statut. Le switch est exhaustif : un membre ajouté au port
 * casse la compilation ici plutôt que de devenir un 500 muet en production.
 */
export function jarvisAdmissionRefusal(
  result: Exclude<JarvisAdmissionResult, { status: 'admitted' | 'replayed' }>,
  context: { readonly runId: string; readonly companyId: string },
): AppError {
  switch (result.status) {
    case 'stale_revision':
      // Révision périmée : l'écran relit l'autorité, il ne réessaie pas à l'identique.
      return appConflict('jarvis_run', 'stale_revision');
    case 'command_conflict':
      return appConflict('jarvis_run_command', 'command_conflict');
    case 'run_not_found':
      return appNotFound('jarvis_run', context.runId);
    case 'foreground_busy':
      return appConflict('jarvis_foreground', 'foreground_busy');
    case 'company_unavailable':
      return result.reason === 'missing'
        ? appNotFound('company', context.companyId)
        : appForbidden('company_closed');
    case 'capability_rejected':
      return appForbidden(`jarvis_authority_rejected:${result.reason}`);
    case 'action_refused':
      // Le kill switch est une INDISPONIBILITÉ (rien n'a été exécuté), pas un refus métier.
      return result.reason === 'admission_kill_switch'
        ? appUnavailable('jarvis_admission')
        : appForbidden(`jarvis_action_${result.reason}`);
    case 'quarantined':
      return appConflict('jarvis_run', 'quarantined');
    case 'foreground_unavailable':
      return appUnavailable('jarvis_foreground');
    case 'refused':
      return appConflict('jarvis_run', refusedReason(result.error));
  }
}

// ---------------------------------------------------------------------------
// Le controller
// ---------------------------------------------------------------------------

export interface JarvisCommandReceiptWire {
  readonly outcome: 'admitted' | 'replayed';
  readonly run: JarvisRunWireView;
  readonly presentation: CustomerContactPresentationWire | null;
  readonly eventSequence: number;
}

export interface JarvisRunSnapshotWire {
  readonly run: JarvisRunWireView;
  readonly presentation: CustomerContactPresentationWire | null;
}

/**
 * Découverte (§1) — miroir de `QuoteAgentMissionResumeView` : soit il y a un run à reprendre,
 * soit il n'y en a pas. L'union interdit l'état bâtard « pas de run mais une présentation ».
 */
export type JarvisCurrentRunWire =
  | { readonly run: null; readonly presentation: null }
  | {
      readonly run: JarvisRunWireView;
      readonly presentation: CustomerContactPresentationWire | null;
    };

const NO_CURRENT_RUN: JarvisCurrentRunWire = Object.freeze({ run: null, presentation: null });

/** Sentinelle de lecture : l'adaptateur lié ne sait pas énumérer (annuaire absent, §5.2). */
const DIRECTORY_ABSENT = 'directory_absent' as const;

/** State fiche client d'un run, ou `null` : un state illisible n'est JAMAIS interprété. */
function customerContactStateOf(
  envelope: JarvisRunEnvelope | null,
): CustomerContactStateV1 | null {
  if (envelope === null || envelope.kind !== 'customer_contact' || envelope.state === null) {
    return null;
  }
  return parseCustomerContactState(envelope.state);
}

@Controller('jarvis')
@WithoutTenantPersistenceTransaction()
export class JarvisRunController {
  constructor(
    @Inject(JARVIS_TAP_AUTHORITY)
    private readonly authority: JarvisTapAuthority,
    @Inject(AppLogger)
    private readonly logger: AppLogger,
    @Inject(JARVIS_ADMISSION)
    private readonly admission: JarvisAdmissionUnitOfWorkPort | null,
    // Le magasin PII est fourni par la liaison de persistance ; absent, la présentation reste
    // absente (G4) — jamais une proposition rendue depuis une charge non scellée.
    @Optional()
    @Inject(JARVIS_PROPOSAL_PAYLOAD_STORE)
    private readonly payloads: JarvisProposalPayloadStorePort | null = null,
  ) {}

  /**
   * Le geste humain : une enveloppe, une transaction, un reçu. 10 tentatives / 10 s — un tap est
   * un doigt, jamais une boucle.
   */
  @Post('runs/:runId/commands')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 10_000 } })
  @Header('Cache-Control', 'private, no-store')
  async submitCommand(
    @Param('runId') runId: string,
    @Body() value: unknown,
  ): Promise<JarvisCommandReceiptWire> {
    const authorization = this.authority.prepare('submit_run_command');
    if (!authorization.ok) refuse(authorization.error);
    const admission = this.requireAdmission();
    if (!isCanonicalAgentMissionUuid(runId)) refuse(appNotFound('jarvis_run', runId));
    const body = parseJarvisSubmitCommandBody(value);
    const owner = authorization.value.owner;
    // U1-e §2 — la commande part TELLE QUELLE : le canal tactile n'enrichit plus le confirm de
    // la révision ni du digest revalidés de la cible. Les produire ici serait deux fois faux —
    // le client s'auto-certifierait, et la lecture, faite hors de la transaction d'admission,
    // laisserait une fenêtre TOCTOU. C'est l'admission qui relit la cible, sous verrou (§7.1).
    const command: unknown = body.command;

    const envelope: JarvisUserAdmissionEnvelope = Object.freeze({
      companyId: owner.companyId,
      ownerUserId: owner.ownerUserId,
      kind: body.kind,
      definitionVersion: body.definitionVersion,
      runId,
      commandId: body.commandId,
      expectedRevision: body.expectedRevision,
      actionId: body.actionId,
      actionVersion: body.actionVersion,
      authority: authorization.value.authority,
      command,
      // G7 : jamais fournis par le client, identiques à chaque essai du même commandId.
      canonicalInputDigest: computeJarvisTapCanonicalInputDigest({
        runId,
        commandId: body.commandId,
        command: body.command,
      }),
      occurredAt: new Date().toISOString(),
    });

    const result = await this.guarded('admission', () => admission.runJarvisAdmission(envelope));
    if (result.status !== 'admitted' && result.status !== 'replayed') {
      this.logger.audit('jarvis.tap.refused', {
        runId,
        status: result.status,
        commandType: body.command.type,
      });
      refuse(jarvisAdmissionRefusal(result, { runId, companyId: owner.companyId }));
    }
    const run = projectJarvisRunView(result.postimage);
    if (run === null) refuse(appConflict('jarvis_run', 'legacy_route_active'));
    return {
      outcome: result.status,
      run,
      presentation: await this.presentation(owner, result.postimage),
      eventSequence: result.eventSequence,
    };
  }

  /**
   * Ouverture d'un run `customer_contact@1` de MODIFICATION depuis l'écran (§1). Tout ce qui
   * n'est pas prouvable par le client est stampé SERVEUR : l'identité du run (dérivée du
   * `commandId`), l'action et sa version (pincées par la route), la révision de seed (0), le
   * digest d'entrée, l'horloge et l'autorité. Le rejeu du MÊME `commandId` retombe sur le MÊME
   * run et rend le reçu original (`replayed`, zéro écriture).
   *
   * BORNE D'OUVERTURE (G2) OPPOSÉE ICI. L'admission ne la connaît PAS : elle ne vérifie que le
   * catalogue (`unknown_action`, `voiceMode === 'closed'`), deux bornes distinctes de la liste de
   * rollout `U1_OPEN_ACTIONS`. Fermer le rollout ferme le canal tap, le worker, le client HTTP et
   * le coordinateur mobile — si cette route restait ouverte, elle sèmerait des runs que plus rien
   * ne peut faire avancer NI annuler, et chacun confisquerait le premier plan de son owner.
   */
  @Post('runs')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 10_000 } })
  @Header('Cache-Control', 'private, no-store')
  async openRun(@Body() value: unknown): Promise<JarvisCommandReceiptWire> {
    const authorization = this.authority.prepare('open_run');
    if (!authorization.ok) refuse(authorization.error);
    const admission = this.requireAdmission();
    const body = parseJarvisOpenRunBody(value);
    // Même source UNIQUE que le canal de commandes (@bob/core), même refus : la route pince son
    // action, mais elle ne s'exempte pas de la borne qui la gouverne.
    if (!isU1OpenAction(CUSTOMER_CONTACT_UPDATE_ACTION_ID, CUSTOMER_CONTACT_ACTION_VERSION)) {
      invalidBody('actionId', 'Action hors des bornes d’ouverture du lot.');
    }
    const owner = authorization.value.owner;
    const runId = deriveJarvisScreenRunId(owner, body.commandId);
    const command: JarvisOpenRunCommand = Object.freeze({
      type: 'start_run' as const,
      intent: Object.freeze({
        mode: 'update' as const,
        target: Object.freeze({
          customerId: body.intent.target.customerId,
          revision: JARVIS_UNVERIFIED_TARGET_REVISION,
        }),
      }),
    });

    const envelope: JarvisUserAdmissionEnvelope = Object.freeze({
      companyId: owner.companyId,
      ownerUserId: owner.ownerUserId,
      kind: 'customer_contact',
      definitionVersion: CUSTOMER_CONTACT_DEFINITION_VERSION,
      runId,
      commandId: body.commandId,
      // 0 = SEMER. C'est la seule route qui l'écrit ; le canal de commandes le refuse toujours.
      expectedRevision: 0,
      actionId: CUSTOMER_CONTACT_UPDATE_ACTION_ID,
      actionVersion: CUSTOMER_CONTACT_ACTION_VERSION,
      authority: authorization.value.authority,
      command,
      canonicalInputDigest: computeJarvisTapCanonicalInputDigest({
        runId,
        commandId: body.commandId,
        command,
      }),
      occurredAt: new Date().toISOString(),
    });

    const result = await this.guarded('admission', () => admission.runJarvisAdmission(envelope));
    if (result.status !== 'admitted' && result.status !== 'replayed') {
      this.logger.audit('jarvis.tap.refused', {
        runId,
        status: result.status,
        commandType: command.type,
      });
      refuse(jarvisAdmissionRefusal(result, { runId, companyId: owner.companyId }));
    }
    // §8 — L'AUTORITE D'UNE ENTITE NE VIENT JAMAIS DU CLIENT : le semis porte une revision
    // non opposable ; le serveur enchaine donc IMMEDIATEMENT la resolution de cible, dont la
    // revision et le digest sont relus SOUS VERROU par l'admission. Sans ce second maillon un
    // run ouvert depuis l'ecran resterait parke en `resolving_customer` — aucune commande
    // humaine ne peut l'en sortir (le canal tap ne porte pas `record_customer_resolution`).
    // Le commandId est DERIVE du premier : le rejeu de l'ouverture rejoue les deux, zero-write.
    const resolved = await this.resolveOpenedTarget(owner, {
      runId,
      seedCommandId: body.commandId,
      customerId: body.intent.target.customerId,
      authority: authorization.value.authority,
      postimage: result.postimage,
      seedOutcome: result.status,
      seedEventSequence: result.eventSequence,
    });
    const run = projectJarvisRunView(resolved.postimage);
    if (run === null) refuse(appConflict('jarvis_run', 'legacy_route_active'));
    return {
      outcome: resolved.outcome,
      run,
      presentation: await this.presentation(owner, resolved.postimage),
      eventSequence: resolved.eventSequence,
    };
  }

  /**
   * Resolution de cible cote SERVEUR, juste apres le semis (§8). La revision passee ici est
   * une graine : l'admission relit la fiche sous verrou et c'est SA lecture qui fait foi.
   * Un echec laisse le run parke en `resolving_customer` — etat honnete, jamais une cible
   * inventee : l'appelant recoit le postimage du semis et pourra rejouer.
   */
  private async resolveOpenedTarget(
    owner: JarvisAdmissionOwner,
    input: {
      readonly runId: string;
      readonly seedCommandId: string;
      readonly customerId: string;
      readonly authority: JarvisUserAdmissionEnvelope['authority'];
      readonly postimage: JarvisRunEnvelope;
      readonly seedOutcome: 'admitted' | 'replayed';
      readonly seedEventSequence: number;
    },
  ): Promise<{
    readonly postimage: JarvisRunEnvelope;
    readonly outcome: 'admitted' | 'replayed';
    readonly eventSequence: number;
  }> {
    const admission = this.requireAdmission();
    const commandId = uuidFromDigest(
      sha256Hex(`${SCREEN_RUN_NAMESPACE}:target-resolution ${input.runId} ${input.seedCommandId}`),
    );
    const command: JarvisServerResolutionCommand = Object.freeze({
      type: 'record_customer_resolution' as const,
      resolution: Object.freeze({
        kind: 'target_verified' as const,
        // AUCUNE revision : le domaine prend celle que l'admission RELIT SOUS VERROU (§8).
        customerId: input.customerId,
      }),
    });
    const envelope: JarvisUserAdmissionEnvelope = Object.freeze({
      companyId: owner.companyId,
      ownerUserId: owner.ownerUserId,
      kind: 'customer_contact',
      definitionVersion: CUSTOMER_CONTACT_DEFINITION_VERSION,
      runId: input.runId,
      commandId,
      expectedRevision: JARVIS_SEEDED_RUN_REVISION,
      actionId: CUSTOMER_CONTACT_UPDATE_ACTION_ID,
      actionVersion: CUSTOMER_CONTACT_ACTION_VERSION,
      authority: input.authority,
      command,
      canonicalInputDigest: computeJarvisTapCanonicalInputDigest({
        runId: input.runId,
        commandId,
        command,
      }),
      occurredAt: new Date().toISOString(),
    });
    const result = await this.guarded('admission', () => admission.runJarvisAdmission(envelope));
    if (result.status !== 'admitted' && result.status !== 'replayed') {
      // Fail-closed HONNETE : le run existe, parke en resolving_customer. On rend le semis.
      // La RAISON, pas seulement le statut : un run parké est un incident d'exploitation, et
      // « refused » sans motif ne se diagnostique pas. Les membres de `JarvisAdmissionResult`
      // portent leur cause sous des clés distinctes — on les rend toutes, sans jamais inventer.
      const cause = result as { readonly reason?: unknown; readonly error?: { readonly reason?: unknown } };
      this.logger.audit('jarvis.tap.target_resolution_deferred', {
        runId: input.runId,
        status: result.status,
        reason:
          typeof cause.reason === 'string'
            ? cause.reason
            : typeof cause.error?.reason === 'string'
              ? cause.error.reason
              : null,
      });
      return {
        postimage: input.postimage,
        outcome: input.seedOutcome,
        eventSequence: input.seedEventSequence,
      };
    }
    return {
      postimage: result.postimage,
      outcome: result.status,
      eventSequence: result.eventSequence,
    };
  }

  /**
   * Découverte (§1) : le run NON TERMINAL de l'owner, ou `null`. Sans elle, un appareil qui n'a
   * rien dérivé (la voix ne renvoie que la parole) ne connaît AUCUN `runId` et la carte de
   * confirmation reste invisible. Lecture stateless §5.2 comme sa sœur `runs/:runId` : zéro
   * verrou, zéro écriture, jamais servie depuis un cache.
   *
   * DÉCLARÉE AVANT `runs/:runId` : Nest apparie dans l'ordre du prototype.
   */
  @Get('runs/current')
  @Throttle({ default: { limit: 30, ttl: 10_000 } })
  @Header('Cache-Control', 'private, no-store')
  async getCurrentRun(): Promise<JarvisCurrentRunWire> {
    const authorization = this.authority.prepare('read_current_run');
    if (!authorization.ok) refuse(authorization.error);
    const admission = this.requireAdmission();
    const owner = authorization.value.owner;
    const read = await this.guarded('lecture', () =>
      admission.readJarvisStateless(owner, async (view) => {
        const currentRun = view.currentRun;
        // Annuaire absent : l'adaptateur lié ne sait pas énumérer. On échoue FERMÉ plutôt que
        // de rendre `null`, qui affirmerait « aucun run en cours » sans l'avoir vérifié.
        if (typeof currentRun !== 'function') return DIRECTORY_ABSENT;
        return currentRun();
      }),
    );
    const envelope = read.value;
    if (envelope === DIRECTORY_ABSENT) refuse(appUnavailable('jarvis_current_run_directory'));
    if (envelope === null) return NO_CURRENT_RUN;
    // La branche devis garde ses routes legacy (§17.1) : elle ne sort jamais par ce canal.
    const run = projectJarvisRunView(envelope);
    if (run === null) return NO_CURRENT_RUN;
    // Un run terminal n'est pas « courant » : l'écran n'a rien à y reprendre. La garde vit ICI,
    // et pas seulement dans l'annuaire, pour que la loi soit vraie quel que soit l'adaptateur.
    if (run.terminalAt !== null || JARVIS_RUN_TERMINAL_STATUSES.has(run.status)) {
      return NO_CURRENT_RUN;
    }
    return { run, presentation: await this.presentation(owner, envelope) };
  }

  /** Lecture stateless §5.2 : zéro verrou, zéro écriture, jamais servie depuis un cache. */
  @Get('runs/:runId')
  @Throttle({ default: { limit: 30, ttl: 10_000 } })
  @Header('Cache-Control', 'private, no-store')
  async getRun(@Param('runId') runId: string): Promise<JarvisRunSnapshotWire> {
    const authorization = this.authority.prepare('read_run');
    if (!authorization.ok) refuse(authorization.error);
    const admission = this.requireAdmission();
    if (!isCanonicalAgentMissionUuid(runId)) refuse(appNotFound('jarvis_run', runId));
    const owner = authorization.value.owner;
    const read = await this.guarded(
      'lecture',
      () => admission.readJarvisStateless(owner, (view) => view.runById(runId)),
    );
    const envelope = read.value;
    if (envelope === null) refuse(appNotFound('jarvis_run', runId));
    const run = projectJarvisRunView(envelope);
    if (run === null) refuse(appConflict('jarvis_run', 'legacy_route_active'));
    return { run, presentation: await this.presentation(owner, envelope) };
  }

  private requireAdmission(): JarvisAdmissionUnitOfWorkPort {
    const admission = this.admission;
    if (admission === null) refuse(appUnavailable('jarvis_admission'));
    return admission;
  }

  /**
   * Toute panne de la transaction (keyring absent, base injoignable, contention non typée) la
   * fait ROLLBACKER : rien n'a été exécuté. L'appelant reçoit donc une INDISPONIBILITÉ — il peut
   * rejouer le MÊME `commandId` sans risque de double effet (§5.2) — jamais un 500 qui laisserait
   * planer un doute sur l'état. La cause, elle, reste NOMMÉE dans le journal : jamais avalée.
   */
  private async guarded<T>(step: 'admission' | 'lecture', work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Jarvis tap (${step}) indisponible: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
        'jarvis-tap',
      );
      refuse(appUnavailable('jarvis_admission'));
    }
  }

  /**
   * Recomposition (G4) : le state ne porte que des digests, la charge PII vit dans le magasin
   * scellé. Sa relecture revérifie `fieldsDigest` — divergence ⇒ `null` ⇒ aucune confirmation.
   */
  private async presentation(
    owner: JarvisAdmissionOwner,
    envelope: JarvisRunEnvelope,
  ): Promise<CustomerContactPresentationWire | null> {
    const state = customerContactStateOf(envelope);
    if (state === null) return null;
    const proposal = state.proposal;
    if (proposal === null) return projectCustomerContactPresentation(state, null);
    const payloads = this.payloads;
    if (payloads === null) return null;
    const payload = await payloads.readProposalPayload({
      companyId: owner.companyId,
      ownerUserId: owner.ownerUserId,
      runId: envelope.runId,
      proposalId: proposal.proposalId,
      fieldsDigest: proposal.fieldsDigest,
    });
    return payload === null ? null : projectCustomerContactPresentation(state, payload.fields);
  }
}

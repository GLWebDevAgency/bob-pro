/**
 * Vocabulaire JarvisRun (spec Jarvis §5.1) — lot U1-b, SPEC_U1B_DOMAINE_CORE_20260818.
 *
 * Composition, jamais duplication : les unions étendent les constantes AgentMission
 * existantes ; `JarvisRun` est une ENVELOPPE dont la branche `quote_creation` est une
 * projection pure de l'`AgentMissionSnapshot` — aucun second agrégat, aucun second
 * journal. Les listes marquées GENERATED sont les miroirs exacts des CHECK SQL posés
 * par la migration U1-a (20260818200000_jarvis_run_expand) ; un test apps/api échoue
 * sur toute divergence.
 */

import { type Instant } from '../../shared-kernel/time';
import {
  AGENT_MISSION_KIND,
  AGENT_MISSION_STATUSES,
  type AgentMissionSnapshot,
  type QuoteCreationMissionPhase,
} from './agent-mission';

// BEGIN GENERATED JARVIS_RUN_KINDS (miroir migration U1-a)
export const JARVIS_RUN_KINDS = Object.freeze([
  AGENT_MISSION_KIND,
  'single_business_action',
  'customer_contact',
] as const);
// END GENERATED JARVIS_RUN_KINDS
export type JarvisRunKind = (typeof JARVIS_RUN_KINDS)[number];

/** Les 11 statuts fermés de la spec §5.1 — jamais émis par le writer N-1. */
export const JARVIS_RUN_STATUSES = Object.freeze([
  'active',
  'waiting_user',
  'waiting_screen',
  'waiting_external',
  'retry_due',
  'parked',
  'cancelling',
  'completed',
  'cancelled',
  'failed_terminal',
  'quarantined',
] as const);
export type JarvisRunStatus = (typeof JARVIS_RUN_STATUSES)[number];

// BEGIN GENERATED JARVIS_RUN_PERSISTED_STATUSES (miroir migration U1-a : union legacy ∪ §5.1)
export const JARVIS_RUN_PERSISTED_STATUSES = Object.freeze([
  ...AGENT_MISSION_STATUSES,
  'waiting_user',
  'waiting_screen',
  'waiting_external',
  'retry_due',
  'parked',
  'cancelling',
  'completed',
  'failed_terminal',
  'quarantined',
] as const);
// END GENERATED JARVIS_RUN_PERSISTED_STATUSES
export type JarvisRunPersistedStatus = (typeof JARVIS_RUN_PERSISTED_STATUSES)[number];

/** Statuts terminaux : `terminalAt` posé, plus aucune transition admise (spec §5.1). */
export const JARVIS_RUN_TERMINAL_STATUSES: ReadonlySet<JarvisRunStatus> = new Set([
  'completed',
  'cancelled',
  'failed_terminal',
]);

/**
 * Statuts qui libèrent toute lease de premier plan (spec §5.1 : « un run en attente
 * externe, cancelling ou parké libère toute lease de premier plan »).
 */
export const JARVIS_RUN_LEASE_RELEASING_STATUSES: ReadonlySet<JarvisRunStatus> = new Set([
  'waiting_external',
  'cancelling',
  'parked',
]);

/**
 * Statuts qui TIENNENT le premier plan owner-scopé. Cette liste est l'autorité
 * commune du backstop SQL, de l'admission Jarvis et des lecteurs legacy : un
 * writer ne peut donc pas croire le premier plan libre alors que l'index le
 * considère occupé.
 */
export const JARVIS_FOREGROUND_HOLDING_STATUSES: readonly JarvisRunStatus[] = Object.freeze(
  JARVIS_RUN_STATUSES.filter(
    (status) =>
      !JARVIS_RUN_TERMINAL_STATUSES.has(status)
      && !JARVIS_RUN_LEASE_RELEASING_STATUSES.has(status)
      && status !== 'quarantined',
  ),
);

/**
 * Projection totale statut×phase du writer N-1 vers §5.1 — l'oracle unique de la
 * projection déterministe du cutover §17. `expired` est un terminal legacy que le
 * domaine JarvisRun n'émettra jamais : il se projette en `failed_terminal`.
 */
export function projectQuoteMissionJarvisStatus(
  status: AgentMissionSnapshot['status'],
  phase: QuoteCreationMissionPhase,
): JarvisRunStatus {
  switch (status) {
    case 'cancelled':
      return 'cancelled';
    case 'expired':
      return 'failed_terminal';
    case 'active':
      return phase === 'awaiting_quote_screen' ? 'waiting_screen' : 'waiting_user';
  }
}

/** `definitionVersion` de la projection cutover : le `protocolVersion` du writer N-1. */
export function deriveJarvisDefinitionVersion(
  snapshot: Pick<AgentMissionSnapshot, 'protocolVersion'>,
): number {
  return snapshot.protocolVersion;
}

/** Réveil durable (spec §5.1) : `wakeId` stable dans le state, `nextWakeAt` = index dérivé. */
export interface JarvisWake {
  readonly wakeId: string;
  readonly kind: 'confirmation_ttl' | 'retry' | 'external_deadline' | 'park_review';
  readonly dueAt: Instant;
}

/**
 * Dérivation pure de l'index de réveil : le minimum des réveils pendants, `null` sans
 * réveil. Le scanner fondé sur cette valeur soumet une commande idempotente au gateway
 * — il ne mute jamais le run.
 */
export function deriveNextWakeAt(wakes: readonly JarvisWake[]): Instant | null {
  let min: Instant | null = null;
  for (const wake of wakes) {
    if (min === null || Date.parse(wake.dueAt) < Date.parse(min)) {
      min = wake.dueAt;
    }
  }
  return min;
}

/**
 * Enveloppe JarvisRun — union fermée par kind. La branche `quote_creation` PROJETTE le
 * snapshot AgentMission (absorption §4.1) ; les branches U1-b portent leur state fermé
 * propre. Aucune branche ne possède de store : la persistance reste `agent_missions`.
 */
export type JarvisRunEnvelope =
  | {
      readonly kind: typeof AGENT_MISSION_KIND;
      readonly runId: string;
      readonly companyId: string;
      readonly createdBy: string;
      readonly definitionVersion: number;
      readonly status: JarvisRunStatus;
      readonly revision: number;
      readonly snapshot: AgentMissionSnapshot;
    }
  | {
      readonly kind: 'single_business_action' | 'customer_contact';
      readonly runId: string;
      readonly companyId: string;
      readonly createdBy: string;
      readonly definitionVersion: number;
      readonly status: JarvisRunStatus;
      readonly revision: number;
      readonly stateVersion: number;
      readonly state: unknown;
      readonly nextWakeAt: Instant | null;
      readonly terminalAt: Instant | null;
    };

/** Projection pure du writer N-1 vers l'enveloppe — zéro écriture, zéro copie de store. */
export function projectQuoteMissionEnvelope(
  snapshot: AgentMissionSnapshot,
): Extract<JarvisRunEnvelope, { kind: typeof AGENT_MISSION_KIND }> {
  return Object.freeze({
    kind: AGENT_MISSION_KIND,
    runId: snapshot.id,
    companyId: snapshot.companyId,
    createdBy: snapshot.ownerUserId,
    definitionVersion: deriveJarvisDefinitionVersion(snapshot),
    status: projectQuoteMissionJarvisStatus(snapshot.status, snapshot.phase),
    revision: snapshot.revision,
    snapshot,
  });
}

/** Bornes fermées d'une définition (spec §4.3) — fixées par module, jamais par le modèle. */
export interface JarvisDefinitionLimits {
  readonly maxSteps: number;
  readonly maxOpenWorkItems: number;
  readonly maxStateBytes: number;
  readonly idleTtlMs: number;
  readonly hardTtlMs: number;
  readonly maxWakes: number;
}

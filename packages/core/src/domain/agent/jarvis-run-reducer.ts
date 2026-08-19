/**
 * Reducer racine JarvisRun (spec §4.3) — lot U1-b.
 *
 * UNIQUE entrée de réduction du moteur : un switch exhaustif sur le kind, un registre
 * GELÉ des définitions. Les définitions sont des branches pures — sans runner, journal,
 * worker, gateway ni accès métier. La branche `quote_creation` DÉLÈGUE à l'agrégat
 * AgentMission existant (absorption §4.1, jamais réécriture) : U1-b ne mappe que
 * cancel/expire ; les commandes interactives rendent `legacy_route_active` — code de
 * migration dont la complétion appartient au manifeste de cutover §17.1. Un couple
 * kind/version inconnu part en quarantaine (§5.5), jamais en comportement par défaut.
 */

import { type Instant } from '../../shared-kernel/time';
import { AGENT_MISSION_KIND, AgentMission, type AgentMissionSnapshot } from './agent-mission';
import {
  projectQuoteMissionEnvelope,
  type JarvisDefinitionLimits,
  type JarvisRunEnvelope,
  type JarvisRunKind,
  type JarvisRunStatus,
  type JarvisWake,
} from './jarvis-run';
import type { JarvisWorkItemIntent } from './jarvis-work-item';

/**
 * Relecture AUTORITAIRE de la cible d'un run de modification (spec §7.1/§9.1). Produite par
 * l'ADMISSION, DANS sa transaction, sous le verrou de la ligne cible — jamais par le client
 * (il s'auto-certifierait), jamais hors transaction (TOCTOU). Absente/`null` = aucune cible
 * relue : run de création, ou cible devenue illisible — une modification ne se confirme alors
 * pas, elle est refusée.
 */
export interface JarvisTargetRevalidation {
  readonly revision: number;
  readonly sensitiveDigest: string;
}

/** Contexte de réduction : tout vient de l'admission — jamais d'horloge ambiante. */
export interface JarvisReduceContext {
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly occurredAt: Instant;
  readonly actingPrincipalId: string;
  /** effectIds préalloués par le serveur dans la transaction d'admission (spec §5.4). */
  readonly allocatedEffectIds: readonly string[];
  /**
   * Cible relue SOUS VERROU par l'admission (§7.1). Optionnelle dans le TYPE parce que les
   * définitions sans cible n'en produisent ni n'en consomment ; les définitions qui en ont
   * besoin refusent FERMÉ quand elle manque — jamais un repli sur une valeur du wire.
   */
  readonly targetRevalidation?: JarvisTargetRevalidation | null;
}

/** Événement typé/versionné produit par une réduction — append-only côté admission. */
export interface JarvisRunEventDraft {
  readonly type: string;
  readonly version: number;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * Sortie de réduction — miroir 1:1 de ce que la transaction d'admission U1-c persiste :
 * CAS du snapshot, append de l'événement, création des work items, `nextWakeAt`.
 */
export interface JarvisRunTransition {
  readonly postimage: JarvisRunEnvelope;
  readonly event: JarvisRunEventDraft;
  readonly workItemIntents: readonly JarvisWorkItemIntent[];
  readonly wakes: readonly JarvisWake[];
  readonly releasedForegroundLease: boolean;
}

export type JarvisReduceError =
  | {
      /** Commande interactive quote hors cancel/expire : la route legacy reste l'autorité
       *  jusqu'au cutover §17.1. Code de migration — owner: Claude, suppression: cutover. */
      readonly code: 'legacy_route_active';
      readonly command: string;
    }
  | {
      readonly code: 'definition_version_unknown';
      readonly kind: string;
      readonly definitionVersion: number;
    }
  | { readonly code: 'run_terminal'; readonly status: JarvisRunStatus }
  | {
      readonly code: 'revision_conflict';
      readonly expectedRevision: number;
      readonly actualRevision: number;
    }
  | { readonly code: 'invalid_command'; readonly reason: string }
  | { readonly code: 'delegated_error'; readonly error: unknown };

export type JarvisReduceResult =
  | { readonly ok: true; readonly value: JarvisRunTransition }
  | { readonly ok: false; readonly error: JarvisReduceError }
  | {
      /** Quarantaine §5.5 : version introuvable — le run est gelé SANS effet. */
      readonly ok: false;
      readonly quarantine: { readonly kind: string; readonly definitionVersion: number };
    };

/** Commandes de la branche quote absorbée en U1-b (le reste = legacy_route_active). */
export type JarvisQuoteCommand =
  | { readonly type: 'cancel_run'; readonly reason: 'user_cancelled' | 'manual_handoff' }
  | { readonly type: 'expire_run' };

export type JarvisRunCommand =
  | {
      readonly kind: typeof AGENT_MISSION_KIND;
      readonly command: JarvisQuoteCommand | { readonly type: string };
    }
  | {
      readonly kind: 'single_business_action' | 'customer_contact';
      readonly definitionVersion: number;
      readonly command: unknown;
    };

/**
 * Contrat d'une définition (spec §4.3) : transitions pures versionnées. Un module de
 * définition n'importe AUCUN port, repository, provider ni horloge ambiante — un test
 * de structure l'interdit.
 */
export interface JarvisDefinitionModule {
  readonly kind: Exclude<JarvisRunKind, typeof AGENT_MISSION_KIND>;
  readonly definitionVersion: number;
  readonly stateVersion: number;
  readonly limits: JarvisDefinitionLimits;
  readonly reduce: (
    run: Extract<
      JarvisRunEnvelope,
      { readonly kind: 'single_business_action' | 'customer_contact' }
    >,
    command: unknown,
    context: JarvisReduceContext,
  ) => JarvisReduceResult;
}

const registry = new Map<string, JarvisDefinitionModule>();

function registryKey(kind: string, definitionVersion: number): string {
  return `${kind}@${definitionVersion}`;
}

/** Enregistrement au chargement des modules — gelé : toute collision est un défaut dur. */
export function registerJarvisDefinition(module: JarvisDefinitionModule): void {
  const key = registryKey(module.kind, module.definitionVersion);
  if (registry.has(key)) {
    throw new Error(`JARVIS_DEFINITION_DUPLICATE:${key}`);
  }
  registry.set(key, module);
}

export function resolveJarvisDefinition(
  kind: string,
  definitionVersion: number,
): JarvisDefinitionModule | null {
  return registry.get(registryKey(kind, definitionVersion)) ?? null;
}

const ABSORBED_QUOTE_COMMANDS = new Set(['cancel_run', 'expire_run']);

function reduceQuoteBranch(
  snapshot: AgentMissionSnapshot,
  command: { readonly type: string },
  context: JarvisReduceContext,
): JarvisReduceResult {
  if (!ABSORBED_QUOTE_COMMANDS.has(command.type)) {
    return { ok: false, error: { code: 'legacy_route_active', command: command.type } };
  }
  const rehydrated = AgentMission.rehydrate(snapshot);
  if (!rehydrated.ok) {
    return { ok: false, error: { code: 'delegated_error', error: rehydrated.error } };
  }
  const mission = rehydrated.value;
  const result =
    command.type === 'cancel_run'
      ? mission.cancel({
          expectedRevision: context.expectedRevision,
          reason: (command as JarvisQuoteCommand & { type: 'cancel_run' }).reason,
          occurredAt: context.occurredAt,
        })
      : mission.expire({
          expectedRevision: context.expectedRevision,
          occurredAt: context.occurredAt,
        });
  if (!result.ok) {
    // Les refus structurants remontent TYPES : l'admission doit distinguer un conflit
    // CAS rejouable (§15 : la perdante recoit un stale distinguable) et un terminal
    // d'un refus metier opaque.
    const error = result.error as {
      readonly code?: string;
      readonly expectedRevision?: number;
      readonly actualRevision?: number;
      readonly status?: 'cancelled' | 'expired';
    };
    if (
      error.code === 'agent_mission_revision_conflict' &&
      typeof error.expectedRevision === 'number' &&
      typeof error.actualRevision === 'number'
    ) {
      return {
        ok: false,
        error: {
          code: 'revision_conflict',
          expectedRevision: error.expectedRevision,
          actualRevision: error.actualRevision,
        },
      };
    }
    if (error.code === 'agent_mission_terminal' && error.status !== undefined) {
      return {
        ok: false,
        error: {
          code: 'run_terminal',
          status: error.status === 'expired' ? 'failed_terminal' : 'cancelled',
        },
      };
    }
    return { ok: false, error: { code: 'delegated_error', error: result.error } };
  }
  const postSnapshot = result.value.mission.toSnapshot();
  return {
    ok: true,
    value: {
      postimage: projectQuoteMissionEnvelope(postSnapshot),
      event: {
        type: result.value.event.eventType,
        version: 1,
        data: result.value.event.data as unknown as Readonly<Record<string, unknown>>,
      },
      workItemIntents: [],
      wakes: [],
      releasedForegroundLease: true,
    },
  };
}

/** L'UNIQUE entrée de réduction du moteur (spec §4.3) — un test de structure l'impose. */
export function reduceJarvisRun(
  run: JarvisRunEnvelope,
  command: JarvisRunCommand,
  context: JarvisReduceContext,
): JarvisReduceResult {
  if (run.kind !== command.kind) {
    return { ok: false, error: { code: 'invalid_command', reason: 'kind_mismatch' } };
  }
  switch (run.kind) {
    case AGENT_MISSION_KIND:
      return reduceQuoteBranch(
        run.snapshot,
        (command as Extract<JarvisRunCommand, { kind: typeof AGENT_MISSION_KIND }>).command,
        context,
      );
    case 'single_business_action':
    case 'customer_contact': {
      const versioned = command as Extract<
        JarvisRunCommand,
        { kind: 'single_business_action' | 'customer_contact' }
      >;
      // Le run est pince sur sa definition (§5.1) : une commande construite pour une
      // autre version ne peut JAMAIS etre reduite silencieusement par celle du run.
      if (versioned.definitionVersion !== run.definitionVersion) {
        return {
          ok: false,
          error: { code: 'invalid_command', reason: 'definition_version_mismatch' },
        };
      }
      const definition = resolveJarvisDefinition(run.kind, run.definitionVersion);
      if (definition === null) {
        return {
          ok: false,
          quarantine: { kind: run.kind, definitionVersion: run.definitionVersion },
        };
      }
      return definition.reduce(
        run,
        (
          command as Extract<
            JarvisRunCommand,
            { kind: 'single_business_action' | 'customer_contact' }
          >
        ).command,
        context,
      );
    }
  }
}

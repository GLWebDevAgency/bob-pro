/**
 * Port d'admission Jarvis (spec §5.2/§5.6) — lot U1-c, SPEC_U1C_ADMISSION_DISPATCH_20260818.
 *
 * LE contrat de la transaction d'admission unique : une enveloppe entre, un résultat
 * fermé sort, et tout ce qui est persisté l'est atomiquement (reçu, événement, CAS du
 * run, work items) — toute erreur rollbacke l'ensemble. Le scope stateless ne prend
 * aucun verrou et n'écrit rien.
 */

import type { CustomerCandidate, CustomerCandidateReference } from './customer-candidate-search';
import type { JarvisRunEnvelope, JarvisRunKind } from '../../domain/agent/jarvis-run';
import type { JarvisReduceError } from '../../domain/agent/jarvis-run-reducer';
import { ACTION_CATALOG_V0 } from '../../domain/action-catalog/catalog.data';
import { isU1CandidateAction } from '../../domain/action-catalog/rollout';
import type { ActionCatalogEntry } from '../../domain/action-catalog/types';
import type { Instant } from '../../shared-kernel/time';

import type { AgentMissionRealtimeAuthorityProof } from './agent-mission-unit-of-work';

/** Kinds admis par ce port en U1 (la branche quote reste sur ses routes legacy). */
export type JarvisAdmissionKind = Exclude<JarvisRunKind, 'quote_creation'>;

export interface JarvisAdmissionOwner {
  readonly companyId: string;
  readonly ownerUserId: string;
}

/**
 * Référence minimale évaluée par le manifeste de publication serveur.
 *
 * Le catalogue décrit le cycle de vie du code ; il ne publie jamais à lui seul une action.
 * Le provider réel pourra ainsi borner tenant, cohorte et principal sans que le worker ni
 * l'admission n'interprètent eux-mêmes ces règles.
 */
export interface JarvisActionReleaseRef extends JarvisAdmissionOwner {
  readonly actionId: string;
  readonly actionVersion: number;
}

/**
 * Forme wire minimale d'une référence d'action. Cette garde ne publie RIEN : elle empêche
 * seulement les transports de réintroduire chacun leur propre regexp ou leur propre allowlist.
 * L'action autoritaire reste dérivée de la définition et du state sous verrou par l'admission.
 */
export function isCanonicalJarvisActionReference(
  actionId: unknown,
  actionVersion: unknown,
): boolean {
  return (
    typeof actionId === 'string'
    && actionId.length >= 1
    && actionId.length <= 100
    && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(actionId)
    && Number.isSafeInteger(actionVersion)
    && (actionVersion as number) >= 1
    && (actionVersion as number) <= 2_147_483_647
  );
}

export interface JarvisActionReleasePolicy {
  /**
   * Décide depuis le contexte serveur ET l'entrée catalogue exacte. Un provider positif doit
   * donc porter lui-même la loi de cycle de vie ; le catalogue seul ne publie jamais une action.
   */
  isPublished(ref: JarvisActionReleaseRef, entry: ActionCatalogEntry): boolean;
}

/** Manifest vide : état runtime sûr tant qu'aucune publication exacte n'est câblée. */
export const CLOSED_JARVIS_ACTION_RELEASE_POLICY: JarvisActionReleasePolicy = Object.freeze({
  isPublished: () => false,
});

export type JarvisActionPublicationDecision =
  | { readonly published: true }
  | {
      readonly published: false;
      readonly reason: 'unknown_action' | 'action_closed' | 'action_not_released';
    };

/** Autorité pure unique : catalogue, borne technique et manifeste sont évalués une seule fois. */
export function evaluateJarvisActionPublication(
  policy: JarvisActionReleasePolicy,
  ref: JarvisActionReleaseRef,
): JarvisActionPublicationDecision {
  const entry = ACTION_CATALOG_V0.find(
    (candidate) => candidate.actionId === ref.actionId && candidate.version === ref.actionVersion,
  );
  if (entry === undefined) return { published: false, reason: 'unknown_action' };
  if (entry.voiceMode === 'closed' || !isU1CandidateAction(ref.actionId, ref.actionVersion)) {
    return { published: false, reason: 'action_closed' };
  }
  if (!policy.isPublished(ref, entry)) {
    return { published: false, reason: 'action_not_released' };
  }
  return { published: true };
}

/**
 * Preuve d'autorité du principal (§5.2 étape 5) — union fermée :
 * `realtime_capability` se résout in-tx contre la lease (capability_rejected sinon) ;
 * `certification_fixture` n'est acceptée que sous le drapeau de harnais de
 * certification (deps), jamais en production — U1-d ajoutera les sources réelles.
 */
export type JarvisAdmissionAuthority =
  | { readonly source: 'realtime_capability'; readonly proof: AgentMissionRealtimeAuthorityProof }
  | {
      /**
       * Canal tactile authentifié (U1-d, §14) : le hash de liaison du principal est dérivé
       * SERVEUR du bearer authentifié — jamais fourni par le client — et stampé pour
       * l'audit. Le tap vit SANS lease Realtime : un run parké se reprend à l'écran.
       */
      readonly source: 'authenticated_principal';
      readonly principalBindingHash: string;
    }
  | { readonly source: 'certification_fixture' };

/**
 * Enveloppe utilisateur (voix/tap) — le commandId est un UUID cryptographique généré
 * UNE fois côté client avant le premier essai et conservé jusqu'au reçu (§5.4) ; la
 * garde de canonicité des définitions le refuse sinon.
 */
export interface JarvisUserAdmissionEnvelope extends JarvisAdmissionOwner {
  readonly kind: JarvisAdmissionKind;
  readonly definitionVersion: number;
  readonly runId: string;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly actionId: string;
  readonly actionVersion: number;
  readonly authority: JarvisAdmissionAuthority;
  readonly command: unknown;
  readonly canonicalInputDigest: string;
  /**
   * Corrélation realtime — OBLIGATOIRE quand l'autorité est `realtime_capability` : le
   * journal exige qu'une commande vocale porte sa session, son tour et le contexte
   * d'écran acquitté (CHECK de corrélation). Absente pour le canal tactile.
   */
  readonly realtimeCorrelation?: {
    readonly realtimeSessionId: string;
    readonly turnId: string;
    readonly contextRevision: number;
    readonly contextDigest: string;
  };
  readonly occurredAt: Instant;
}

interface JarvisSystemAdmissionBase extends JarvisAdmissionOwner {
  readonly kind: JarvisAdmissionKind;
  readonly definitionVersion: number;
  readonly runId: string;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly command: unknown;
  readonly occurredAt: Instant;
}

/** Observation historique d'un effet déjà autorisé — bytes/replay v1 inchangés. */
export interface JarvisEffectObservationAdmissionEnvelope extends JarvisSystemAdmissionBase {
  readonly subject: {
    readonly type: 'effect_observation';
    /** L'effet observé — borne aussi le re-stamp du replay-qui-heal à CE signal. */
    readonly effectId: string;
    readonly observationKind: string;
    /** Digest passé au dériveur UUID historique ; `null` représente son absence v1. */
    readonly observationDigest: string | null;
  };
}

/** Réveil durable d'une génération exacte du state ; aucun champ d'effet ne peut s'y glisser. */
export interface JarvisWakeAdmissionEnvelope extends JarvisSystemAdmissionBase {
  readonly subject: {
    readonly type: 'wake_due';
    readonly wakeId: string;
    readonly dueAt: Instant;
  };
}

/** Union système fermée : une variante ne peut jamais fournir les champs de l'autre. */
export type JarvisSystemAdmissionEnvelope =
  | JarvisEffectObservationAdmissionEnvelope
  | JarvisWakeAdmissionEnvelope;

/** Résultats fermés de l'admission — l'appelant n'a jamais à deviner. */
export type JarvisAdmissionResult =
  | {
      readonly status: 'admitted';
      readonly postimage: JarvisRunEnvelope;
      readonly eventSequence: number;
      readonly workItemIds: readonly string[];
    }
  | {
      /** Même commandId + même fingerprint : le reçu original, zéro write (§5.2). */
      readonly status: 'replayed';
      readonly postimage: JarvisRunEnvelope;
      readonly eventSequence: number;
      /** Greffe « replay qui heal » : signal re-stampé dans la même transaction. */
      readonly signalRestamped: boolean;
    }
  | { readonly status: 'stale_revision'; readonly actualRevision: number }
  | { readonly status: 'command_conflict' }
  | { readonly status: 'run_not_found' }
  | { readonly status: 'foreground_busy' }
  | { readonly status: 'company_unavailable'; readonly reason: 'missing' | 'closed' }
  | { readonly status: 'capability_rejected'; readonly reason: string }
  | {
      readonly status: 'action_refused';
      readonly reason:
        | 'unknown_action'
        | 'action_closed'
        | 'action_not_released'
        | 'action_binding_mismatch'
        | 'admission_kill_switch';
    }
  | { readonly status: 'quarantined' }
  | { readonly status: 'foreground_unavailable'; readonly reason: string }
  | { readonly status: 'refused'; readonly error: JarvisReduceError };

/** Résultats réservés au port système ; ils ne polluent pas les switches voix/tactiles. */
export type JarvisSystemAdmissionResult =
  | JarvisAdmissionResult
  | { readonly status: 'ignored'; readonly reason: 'wake_not_due' }
  | { readonly status: 'system_command_binding_mismatch' };

/** Lecture stateless §5.2 : zéro verrou, zéro write, réponse non persistée. */
export interface JarvisStatelessReadResult<T> {
  readonly status: 'executed';
  readonly value: T;
  readonly readAt: Instant;
}

/**
 * Ce qu'un lecteur stateless a le droit de demander — jamais un accès libre à la base.
 *
 * `runById` suppose que l'appelant CONNAÎT déjà l'identité du run (la voix la dérive de sa
 * session, le tap la tient de l'écran). `currentRun` est l'annuaire owner-scopé du run NON
 * TERMINAL, indispensable à la découverte depuis un appareil qui n'a rien à dériver (lot U1-e
 * §1) : il est OPTIONNEL parce qu'un adaptateur qui ne sait pas énumérer ne doit pas en fournir
 * une moitié — l'appelant le narrowe et échoue FERMÉ plutôt que de deviner un run. Même
 * doctrine que la résolution fermée du UoW d'admission.
 */
/**
 * État COURANT d'une fiche client cible, tel que l'écran peut honnêtement le montrer (U1-f §4/§5).
 *
 * DISPLAY-ONLY, et c'est un choix : cette lecture n'est PAS l'autorité. La garde §9.1 — relecture
 * SOUS VERROU dans la transaction d'admission, au moment du `confirm` — reste seule à décider si
 * une proposition est encore valide. Ce que porte cet objet sert à NOMMER la cible et à montrer
 * l'« avant » d'un diff : deux informations qui n'engagent rien et dont l'absence, elle, coûte
 * cher (confirmer une modification sans savoir sur QUI elle porte).
 */
export interface JarvisTargetSnapshot {
  /** Nom d'usage de la fiche — ce que l'artisan reconnaît, jamais un identifiant technique. */
  readonly displayName: string | null;
  /** Valeurs courantes des champs adressables, clés du frame sémantique. */
  readonly fields: Readonly<Record<string, string | null>>;
}

export interface JarvisStatelessReadView {
  readonly runById: (runId: string) => Promise<JarvisRunEnvelope | null>;
  readonly currentRun?: () => Promise<JarvisRunEnvelope | null>;
  /**
   * Fiche cible d'un run de modification, lue sur le MÊME snapshot que le run (U1-f §4/§5).
   * OPTIONNELLE, même doctrine que `currentRun` : un adaptateur qui ne sait pas la lire ne
   * fournit pas une moitié — l'appelant rend alors une présentation SANS libellé ni « avant »,
   * jamais une présentation qui invente l'un ou l'autre.
   */
  readonly targetSnapshot?: (customerId: string) => Promise<JarvisTargetSnapshot | null>;
  /**
   * FD-2026-0817-06 — CANDIDATS DE DOUBLON, PAR NOM, EN LECTURE SEULE (U1-g §2).
   *
   * La borne est PINCÉE PAR L'ADAPTATEUR : un `limit` choisi par l'appelant serait une
   * mini-autorité, et deux appelants finiraient par « chercher » différemment. Aucun verrou n'est
   * pris — la lecture stateless est READ ONLY, et PostgreSQL y REFUSE `FOR SHARE`.
   *
   * OPTIONNEL, même doctrine que ses sœurs : un adaptateur qui ne sait pas chercher n'en fournit
   * pas une moitié. L'appelant échoue alors FERMÉ — il ne dira JAMAIS « aucun doublon » sans
   * avoir cherché, ce qui écrirait un fait faux dans un journal immuable.
   */
  readonly customerCandidates?: (query: string) => Promise<readonly CustomerCandidate[]>;
  /**
   * Libellés PAR IDENTITÉ — id et nom, RIEN d'autre. Délibérément distinct de `targetSnapshot`,
   * qui rend aussi e-mail, téléphone, adresse et TVA : lire tout cela d'un TIERS pour n'afficher
   * qu'un nom serait de la sur-collecte. Minimisation, pas confort.
   */
  readonly customerLabels?: (
    customerIds: readonly string[],
  ) => Promise<readonly CustomerCandidateReference[]>;
}

export interface JarvisAdmissionUnitOfWorkPort {
  runJarvisAdmission(envelope: JarvisUserAdmissionEnvelope): Promise<JarvisAdmissionResult>;
  runJarvisSystemAdmission(
    envelope: JarvisSystemAdmissionEnvelope,
  ): Promise<JarvisSystemAdmissionResult>;
  readJarvisStateless<T>(
    owner: JarvisAdmissionOwner,
    read: (view: JarvisStatelessReadView) => Promise<T>,
  ): Promise<JarvisStatelessReadResult<T>>;
}

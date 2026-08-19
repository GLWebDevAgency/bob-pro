/**
 * Port d'admission Jarvis (spec §5.2/§5.6) — lot U1-c, SPEC_U1C_ADMISSION_DISPATCH_20260818.
 *
 * LE contrat de la transaction d'admission unique : une enveloppe entre, un résultat
 * fermé sort, et tout ce qui est persisté l'est atomiquement (reçu, événement, CAS du
 * run, work items) — toute erreur rollbacke l'ensemble. Le scope stateless ne prend
 * aucun verrou et n'écrit rien.
 */

import type { JarvisRunEnvelope, JarvisRunKind } from '../../domain/agent/jarvis-run';
import type { JarvisReduceError } from '../../domain/agent/jarvis-run-reducer';
import type { Instant } from '../../shared-kernel/time';

import type { AgentMissionRealtimeAuthorityProof } from './agent-mission-unit-of-work';

/** Kinds admis par ce port en U1 (la branche quote reste sur ses routes legacy). */
export type JarvisAdmissionKind = Exclude<JarvisRunKind, 'quote_creation'>;

export interface JarvisAdmissionOwner {
  readonly companyId: string;
  readonly ownerUserId: string;
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

/**
 * Enveloppe système (§5.6 — contrat écrit dans le type, pas en commentaire) :
 * - le commandId est DÉTERMINISTE (deriveJarvisSystemCommandId) ;
 * - une société fermée est ADMISE pour consigner un signal/observation ;
 * - les kill switches ne sont jamais opposés au signal d'un effet déjà autorisé ;
 * - la réduction résultante ne peut créer AUCUN work item sortant.
 */
export interface JarvisSystemAdmissionEnvelope extends JarvisAdmissionOwner {
  readonly kind: JarvisAdmissionKind;
  readonly definitionVersion: number;
  readonly runId: string;
  readonly commandId: string;
  readonly expectedRevision: number;
  readonly command: unknown;
  readonly observationKind: string;
  /** L'effet observé — borne aussi le re-stamp du replay-qui-heal à CE signal. */
  readonly effectId: string;
  readonly occurredAt: Instant;
}

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
      readonly reason: 'unknown_action' | 'action_closed' | 'admission_kill_switch';
    }
  | { readonly status: 'quarantined' }
  | { readonly status: 'foreground_unavailable'; readonly reason: string }
  | { readonly status: 'refused'; readonly error: JarvisReduceError };

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
export interface JarvisStatelessReadView {
  readonly runById: (runId: string) => Promise<JarvisRunEnvelope | null>;
  readonly currentRun?: () => Promise<JarvisRunEnvelope | null>;
}

export interface JarvisAdmissionUnitOfWorkPort {
  runJarvisAdmission(envelope: JarvisUserAdmissionEnvelope): Promise<JarvisAdmissionResult>;
  runJarvisSystemAdmission(envelope: JarvisSystemAdmissionEnvelope): Promise<JarvisAdmissionResult>;
  readJarvisStateless<T>(
    owner: JarvisAdmissionOwner,
    read: (view: JarvisStatelessReadView) => Promise<T>,
  ): Promise<JarvisStatelessReadResult<T>>;
}

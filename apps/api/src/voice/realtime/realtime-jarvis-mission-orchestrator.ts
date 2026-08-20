/**
 * Orchestrateur vocal des runs Jarvis `customer_contact@1` (spec §5.2/§5.4/§7.0/§9.1) — lot U1-d,
 * SPEC_U1D_CALLERS_REELS_20260819 §3 « VOIX ».
 *
 * Frère du `RealtimeQuoteMissionOrchestrator`, avec UNE différence de fond : il n'appelle aucun
 * service métier — il compose une `JarvisUserAdmissionEnvelope` et laisse LA transaction
 * d'admission (§5.2) décider. Le LLM ne reçoit aucune autorité : il produit une frame fermée,
 * le serveur recharge le run, dérive tout ce qui est identité (runId, commandId, proposalId,
 * digest d'entrée) et échoue FERMÉ sur toute sortie ambiguë.
 *
 * Invariants portés ici :
 * - `commandId = turnId` (§5.4, arbitrage U1-d) : dérivé serveur AVANT le LLM, stable aux
 *   replays sideband — un retry du même tour REJOUE, il ne double jamais l'exécution ;
 * - `canonicalInputDigest` est calculé SERVEUR sur la commande canonique — jamais fourni ;
 * - toutes les identités dérivées (runId de session, proposalId, confirmationId) sont
 *   DÉTERMINISTES : un même tour rejoué produit exactement la même enveloppe ;
 * - la PII des champs proposés passe par le payload store scellé AVANT `stage_proposal` ;
 * - bornes d'ouverture : `U1_OPEN_ACTIONS` (source unique), jamais une liste locale.
 */

import {
  AGENT_MISSION_RETENTION_MS,
  CUSTOMER_CONTACT_ACTION_VERSION,
  CUSTOMER_CONTACT_CREATE_ACTION_ID,
  CUSTOMER_CONTACT_DEFINITION_VERSION,
  CUSTOMER_CONTACT_MISSION_KIND_V1,
  CUSTOMER_CONTACT_UPDATE_ACTION_ID,
  JARVIS_RUN_TERMINAL_STATUSES,
  computeCustomerContactFieldsDigest,
  computeCustomerContactSensitiveDigest,
  isU1OpenAction,
  deriveCustomerContactDuplicateReview,
  parseCustomerContactState,
  sha256Hex,
  type CustomerContactProposedFieldsV1,
  type CustomerContactDuplicateProbe,
  type CustomerContactSemanticFrameV1,
  type CustomerContactStateV1,
  type JarvisAdmissionResult,
  type JarvisAdmissionUnitOfWorkPort,
  type JarvisProposalPayloadStorePort,
  type JarvisRunEnvelope,
  type JarvisUserAdmissionEnvelope,
} from '@bob/core';
import type { AgentHistoryTurn, RealtimeCustomerContactSemanticContext } from '@bob/ai';

import type { RealtimeQuoteMissionAuthority } from './realtime-quote-mission-orchestrator';

/** Même autorité de lease que le devis : dérivée SERVEUR de l'admission de session. */
export type RealtimeJarvisMissionAuthority = RealtimeQuoteMissionAuthority;

export interface RealtimeJarvisMissionOrchestrationInput {
  readonly authority: RealtimeJarvisMissionAuthority;
  readonly turnId: string;
  readonly transcript: string;
  readonly history: readonly AgentHistoryTurn[];
  readonly contextRevision: number;
  readonly contextDigest: string;
  readonly signal: AbortSignal;
}

export interface RealtimeJarvisMissionPreparedTurn {
  readonly missionKind: typeof CUSTOMER_CONTACT_MISSION_KIND_V1;
  /** Run vivant du tour, ou `null` : le runId reste alors la graine dérivée du prochain run. */
  readonly runId: string;
  readonly expectedRevision: number;
  readonly state: CustomerContactStateV1 | null;
  readonly semanticContext: RealtimeCustomerContactSemanticContext;
  readonly availableCapabilities: readonly string[];
}

export type RealtimeJarvisMissionPreparationOutcome =
  | { readonly status: 'prepared'; readonly prepared: RealtimeJarvisMissionPreparedTurn }
  | { readonly status: 'failed'; readonly canonicalSpeech: string };

export type RealtimeJarvisMissionOrchestrationOutcome =
  | { readonly status: 'failed'; readonly canonicalSpeech: string }
  | {
      readonly status: 'handled';
      readonly canonicalSpeech: string;
      readonly speechPurpose: 'action_result' | 'structured_choice';
    };

export interface RealtimeJarvisMissionOrchestratorPort {
  prepare(
    input: RealtimeJarvisMissionOrchestrationInput,
  ): Promise<RealtimeJarvisMissionPreparationOutcome>;
  runPlanned(input: {
    readonly request: RealtimeJarvisMissionOrchestrationInput;
    readonly prepared: RealtimeJarvisMissionPreparedTurn;
    readonly frame: CustomerContactSemanticFrameV1;
  }): Promise<RealtimeJarvisMissionOrchestrationOutcome>;
}

const TEMPORARY_FAILURE =
  'Je rencontre un souci temporaire et je ne peux pas vérifier l’état de la fiche client. Rien n’a été exécuté.';
const UNSAFE_UNDERSTANDING =
  'Je n’ai pas pu sécuriser cette demande. Rien n’a été exécuté. Reformule-la simplement.';
const STATE_MOVED =
  'La fiche client a changé pendant ta demande. Rien n’a été exécuté ; je repars de l’état enregistré.';
const SESSION_RUNS_EXHAUSTED =
  'J’ai déjà traité plusieurs fiches clients dans cette conversation. Rien n’a été exécuté : continue à l’écran.';
const UPDATE_CONFIRM_NEEDS_SCREEN =
  'Une modification de fiche se confirme à l’écran, où je peux revérifier la fiche avant d’écrire. Rien n’a été exécuté.';
const PAYLOAD_UNAVAILABLE =
  'Je ne peux pas mettre ces informations à l’abri avant de te les proposer. Rien n’a été exécuté.';

const DUPLICATE_CHECK_UNAVAILABLE =
  'Je ne peux pas vérifier si ce client existe déjà chez toi. Je n’ai rien ouvert et rien n’a été enregistré. Redis-le-moi dans un instant.';

/**
 * MÊME PANNE, MAIS PAS LE MÊME ÉTAT — d'où deux paroles et non une.
 *
 * Sur la REPRISE, la garde d'entrée vient d'établir qu'un run EST ouvert et tient le premier plan
 * de l'artisan (une seule mission au premier plan par propriétaire, jusqu'à 24 h). Lui dire « je
 * n'ai rien ouvert » serait faux sur l'état durable, et surtout : personne n'annule ce qu'on vient
 * de lui affirmer inexistant. La phrase doit donc rendre l'affordance d'annulation que la capacité
 * `customer_contact.run.cancel`, elle, offre bel et bien à cette phase.
 */
const DUPLICATE_RECHECK_UNAVAILABLE =
  'Je ne peux pas vérifier si ce client existe déjà chez toi. La fiche reste ouverte et rien n’a été enregistré. Redis-moi le nom dans un instant, ou dis « annule ».';

/**
 * Traduit la sonde en RÉSOLUTION du domaine. `unusable` rend `null` — et surtout PAS
 * `no_duplicates` : sceller « aucun doublon » sans avoir cherché écrirait un fait certifié faux
 * dans un journal immuable, et brûlerait l'unique fenêtre de résolution du run.
 */
function duplicateResolutionOf(probe: CustomerContactDuplicateProbe): unknown | null {
  if (probe.kind === 'no_duplicates') return { kind: 'no_duplicates' };
  if (probe.kind === 'duplicate_candidates') {
    return {
      kind: 'duplicate_candidates',
      reviewId: probe.reviewId,
      candidates: probe.candidates,
    };
  }
  return null;
}

/**
 * Ce que Bob DIT après avoir cherché — et il a vraiment cherché.
 *
 * `resumed` distingue l'OUVERTURE de la REPRISE : à la reprise, la fiche est déjà ouverte depuis le
 * tour précédent, et annoncer « j'ouvre une fiche » ferait croire à l'artisan qu'il en a désormais
 * deux. Bob raconte l'état réel, jamais une formule passe-partout.
 */
function openedSpeech(
  nom: string,
  probe: CustomerContactDuplicateProbe,
  moment: 'opened' | 'resumed' = 'opened',
): string {
  const ouverture = moment === 'resumed' ? `Je reprends la fiche de ${nom}` : `J’ouvre une fiche pour ${nom}`;
  if (probe.kind !== 'duplicate_candidates') {
    return `${ouverture}. J’ai vérifié : tu n’as aucune fiche à ce nom. Dis-moi ce qu’il faut y mettre — adresse, ville, destinataire. Rien ne sera enregistré tant que tu n’auras pas confirmé.`;
  }
  const enumeration = probe.labels
    .map((label, index) => `${['Un', 'Deux', 'Trois', 'Quatre', 'Cinq'][index]}, « ${label} »`)
    .join('. ');
  // `moreThanShown` : la page a saturé. On ne prétend JAMAIS être exhaustif — dire « tu as 5
  // fiches » quand il y en a peut-être douze ferait prendre une décision sur un faux compte.
  const tete = probe.moreThanShown
    ? `Attention : tu as au moins ${probe.labels.length} fiches proches ; voici les ${probe.labels.length} plus ressemblantes.`
    : probe.labels.length === 1
      ? `Attention : tu as déjà une fiche au nom de « ${probe.labels[0]} ».`
      : `Attention : tu as déjà ${probe.labels.length} fiches proches.`;
  const choix =
    probe.labels.length === 1
      ? 'Dis « c’est celle-là » si c’est elle, ou « crée quand même ».'
      : 'Dis le numéro si c’est l’une d’elles, ou dis « crée quand même ».';
  return probe.labels.length === 1
    ? `${tete} Rien n’a été créé. ${choix}`
    : `${tete} ${enumeration}. Rien n’a été créé. ${choix}`;
}

/** Bornes de la session vocale : au plus quatre runs fiche client par session (dérivés). */
const MAX_VOICE_RUNS_PER_SESSION = 4;

/** `customer_contact@1` côté registre realtime ⇄ `customer_contact` côté kind de run (§5.1). */
const CUSTOMER_CONTACT_RUN_KIND = 'customer_contact' as const;

/**
 * Révision d'un run JUSTE SEMÉ : un semis part de 0 et rend 1. C'est un FAIT DU MOTEUR, pas une
 * observation — et c'est pourquoi le second maillon s'y adosse plutôt qu'au postimage rendu, qui
 * vaut le run TEL QU'IL EST quand le semis est rejoué.
 */
const JARVIS_SEEDED_RUN_REVISION = 1;

/** Namespace du second maillon : la résolution dérivée du tour, jamais un identifiant neuf. */
const VOICE_RESOLUTION_NAMESPACE = 'bob.jarvis.customer-contact.voice-resolution.v1';

const VOICE_RUN_NAMESPACE = 'bob.jarvis.customer-contact.voice-run.v1';
const VOICE_INPUT_NAMESPACE = 'bob.jarvis.customer-contact.voice-input.v1';
const VOICE_PROPOSAL_NAMESPACE = 'bob.jarvis.customer-contact.voice-proposal.v1';

/** UUID canonique v4-forme dérivé d'un digest — même patron que `deriveRealtimeTurnId`. */
function uuidFromDigest(digest: string): string {
  const hex = digest.slice(0, 32);
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
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
 * Identité déterministe du n-ième run fiche client d'une session vocale. La voix ne dispose
 * d'aucun annuaire (§5.2 : la lecture stateless n'expose que `runById`) : elle DÉRIVE donc le
 * candidat, ce qui rend le seed idempotent — deux tours concurrents visent le même runId et un
 * seul gagne le CAS.
 */
export function deriveRealtimeCustomerContactRunId(
  realtimeSessionId: string,
  ordinal: number,
): string {
  return uuidFromDigest(sha256Hex(`${VOICE_RUN_NAMESPACE}\u0000${realtimeSessionId}\u0000${ordinal}`));
}

function derivedProposalId(runId: string, commandId: string, purpose: string): string {
  return uuidFromDigest(sha256Hex(`${VOICE_PROPOSAL_NAMESPACE}\u0000${runId}\u0000${commandId}\u0000${purpose}`));
}

/** Digest canonique de l'entrée admise — calculé SERVEUR, stable au retry du même tour. */
export function computeCustomerContactCanonicalInputDigest(input: {
  readonly runId: string;
  readonly commandId: string;
  readonly command: unknown;
}): string {
  return sha256Hex(
    JSON.stringify([VOICE_INPUT_NAMESPACE, input.runId, input.commandId, input.command]),
  );
}

function semanticContextFor(
  state: CustomerContactStateV1 | null,
  revision: number,
  terminal: boolean,
): RealtimeCustomerContactSemanticContext {
  if (state === null) {
    return Object.freeze({
      runAlias: null,
      runRevision: 0,
      phase: 'inactive' as const,
      intentMode: null,
      presentedDuplicateCount: 0,
      proposalPresented: false,
    });
  }
  const phase = terminal
    ? ('locked' as const)
    : state.phase === 'resolving_customer' ||
        state.phase === 'awaiting_duplicate_review' ||
        state.phase === 'preparing_proposal' ||
        state.phase === 'awaiting_confirmation'
      ? state.phase
      : ('locked' as const);
  return Object.freeze({
    runAlias: 'R1' as const,
    runRevision: revision,
    phase,
    intentMode: state.intent.mode,
    presentedDuplicateCount:
      phase === 'awaiting_duplicate_review' ? (state.duplicateReview?.candidates.length ?? 0) : 0,
    proposalPresented:
      phase === 'awaiting_confirmation' && state.confirmation?.status === 'presented',
  });
}

function capabilitiesFor(context: RealtimeCustomerContactSemanticContext): readonly string[] {
  switch (context.phase) {
    case 'inactive':
      return Object.freeze(['customer_contact.run.open']);
    case 'resolving_customer':
      // U1-g — LA REPRISE EST OFFERTE EN CRÉATION. Sans elle, un run dont la résolution a été
      // refusée n'aurait d'autre issue que l'annulation : la vivacité serait un espoir, pas une
      // propriété. En modification, la résolution est un maillon SERVEUR — rien à reprendre ici.
      return context.intentMode === 'create'
        ? Object.freeze(['customer_contact.duplicate.probe', 'customer_contact.run.cancel'])
        : Object.freeze(['customer_contact.run.cancel']);
    case 'awaiting_duplicate_review':
      return Object.freeze([
        'customer_contact.duplicate.choose',
        'customer_contact.duplicate.continue',
        'customer_contact.run.cancel',
      ]);
    case 'preparing_proposal':
      return Object.freeze(['customer_contact.proposal.stage', 'customer_contact.run.cancel']);
    case 'awaiting_confirmation':
      if (!context.proposalPresented) {
        return Object.freeze(['customer_contact.proposal.acknowledge', 'customer_contact.run.cancel']);
      }
      // §7.0 règle 3 — UNE MODIFICATION SE CONFIRME À L'ÉCRAN. La voix ne doit donc pas annoncer
      // `confirm` sur un run `update` : elle le refuserait systématiquement après avoir invité
      // l'artisan à le dire. Promettre un geste qu'on refuse toujours, c'est le faire répéter
      // pour rien — l'outil n'est pas offert, et Bob renvoie à l'écran.
      return context.intentMode === 'update'
        ? Object.freeze(['customer_contact.proposal.reject', 'customer_contact.run.cancel'])
        : Object.freeze([
            'customer_contact.proposal.confirm',
            'customer_contact.proposal.reject',
            'customer_contact.run.cancel',
          ]);
    case 'locked':
      return Object.freeze([]);
  }
}

function actionIdFor(state: CustomerContactStateV1 | null): string {
  return state === null || state.intent.mode === 'create'
    ? CUSTOMER_CONTACT_CREATE_ACTION_ID
    : CUSTOMER_CONTACT_UPDATE_ACTION_ID;
}

function speakFields(fields: CustomerContactProposedFieldsV1): string {
  const spoken: string[] = [];
  if (fields.displayName !== null) spoken.push(`nom ${fields.displayName}`);
  if (fields.legalName !== null) spoken.push(`raison sociale ${fields.legalName}`);
  if (fields.addressLine !== null) spoken.push(`adresse ${fields.addressLine}`);
  if (fields.postalCode !== null) spoken.push(`code postal ${fields.postalCode}`);
  if (fields.city !== null) spoken.push(`ville ${fields.city}`);
  if (fields.recipientName !== null) spoken.push(`destinataire ${fields.recipientName}`);
  if (fields.billingChannel !== null) {
    spoken.push(
      fields.billingChannel === 'email' ? 'facturation par e-mail' : 'facturation par courrier',
    );
  }
  return spoken.join(', ');
}

/** Traduction FERMÉE d'un refus d'admission — jamais un texte technique, jamais un « peut-être ». */
function refusalSpeech(
  result: Exclude<JarvisAdmissionResult, { status: 'admitted' | 'replayed' }>,
): string {
  switch (result.status) {
    case 'stale_revision':
      return STATE_MOVED;
    case 'command_conflict':
      return 'Je ne peux pas rejouer cette demande telle quelle. Rien n’a été exécuté ; redis-la simplement.';
    case 'run_not_found':
      return 'Je ne retrouve pas cette fiche client en cours. Rien n’a été exécuté.';
    case 'foreground_busy':
      return 'Une autre action occupe déjà Bob. Rien n’a été exécuté : termine-la d’abord.';
    case 'company_unavailable':
      return 'Je ne peux pas travailler sur cet espace pour le moment. Rien n’a été exécuté.';
    case 'capability_rejected':
      return 'Je ne peux pas sécuriser cette demande. Rien n’a été exécuté.';
    case 'action_refused':
      return 'Cette action n’est pas ouverte pour l’instant. Rien n’a été exécuté ; tu peux continuer à l’écran.';
    case 'quarantined':
      return 'Cette fiche est mise de côté pour vérification. Rien n’a été exécuté.';
    case 'foreground_unavailable':
      return TEMPORARY_FAILURE;
    case 'refused': {
      // U1-f §6 — LA DÉRIVE DE CIBLE A SA PROPRE PAROLE. `target_revision_stale` signifie que la
      // fiche a changé depuis la vérification de Bob : la proposition ne peut pas naître périmée.
      // Le générique (« l'étape enregistrée ne permet pas cette action ») était un mensonge par
      // omission — il laissait l'artisan croire à une erreur de sa part, et rejouer indéfiniment.
      const reason = (result.error as { readonly reason?: unknown } | undefined)?.reason;
      if (reason === 'target_revision_stale' || reason === 'target_revalidation_missing') {
        return 'La fiche a changé depuis que je l’ai vérifiée. Rien n’a été exécuté : redis-moi ce que tu veux modifier, je repars de l’état enregistré.';
      }
      return 'L’étape enregistrée ne permet pas cette action. Rien n’a été exécuté.';
    }
  }
}

/**
 * Ce qu'un tour vocal peut produire (U1-g §3).
 *  · `answered` — Bob RÉPOND sans rien admettre : il manque une information à l'artisan ;
 *  · `planned`  — UNE commande, le cas historique, inchangé ;
 *  · `chained`  — DEUX commandes du même tour : le semis, puis la résolution de doublons que nul
 *    humain ne peut émettre. Le second `commandId` est DÉRIVÉ du premier, donc le tour rejoué
 *    rejoue les deux ;
 *  · `failed`   — rien n'a été tenté, et la parole le dit.
 */
type CustomerContactPlannedTurn =
  | { readonly status: 'answered'; readonly outcome: RealtimeJarvisMissionOrchestrationOutcome }
  | {
      readonly status: 'planned';
      readonly command: unknown;
      readonly outcome: RealtimeJarvisMissionOrchestrationOutcome;
    }
  | {
      readonly status: 'chained';
      readonly command: unknown;
      readonly link: { readonly command: unknown; readonly commandId: string };
      readonly candidateCount: number;
      readonly outcome: RealtimeJarvisMissionOrchestrationOutcome;
      /** Parole quand le SECOND maillon est refusé : le premier a bien eu lieu. */
      readonly deferredOutcome: RealtimeJarvisMissionOrchestrationOutcome;
    }
  | { readonly status: 'failed'; readonly canonicalSpeech: string };

function handled(
  canonicalSpeech: string,
  speechPurpose: 'action_result' | 'structured_choice',
): RealtimeJarvisMissionOrchestrationOutcome {
  return Object.freeze({ status: 'handled', canonicalSpeech, speechPurpose });
}

export class RealtimeJarvisMissionOrchestrator implements RealtimeJarvisMissionOrchestratorPort {
  constructor(
    private readonly admission: JarvisAdmissionUnitOfWorkPort | null,
    private readonly payloads: JarvisProposalPayloadStorePort | null,
    private readonly now: () => Date = () => new Date(),
    /**
     * Journal d'exploitation — OPTIONNEL et sans effet par défaut. Un run parqué est un incident
     * qui doit laisser une trace, mais la voix ne doit pas dépendre d'un logger pour fonctionner.
     * Le payload ne porte JAMAIS de nom ni de requête : `runId`, statut, compte de candidats.
     */
    private readonly audit: (
      event: string,
      data: Readonly<Record<string, unknown>>,
    ) => void = () => undefined,
  ) {}

  /**
   * Lecture stateless §5.2 : zéro verrou, zéro écriture. Elle balaie les runs dérivés de la
   * session et retient le PREMIER non terminal ; sinon la première graine libre.
   */
  async prepare(
    input: RealtimeJarvisMissionOrchestrationInput,
  ): Promise<RealtimeJarvisMissionPreparationOutcome> {
    const admission = this.admission;
    if (admission === null) {
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    let scanned: {
      readonly run: JarvisRunEnvelope | null;
      readonly runId: string;
    } | null;
    try {
      const read = await admission.readJarvisStateless(
        {
          companyId: input.authority.owner.companyId,
          ownerUserId: input.authority.owner.ownerUserId,
        },
        async (view) => {
          // CONTINUITÉ §14 (U1-f §2) — LE RUN COURANT D'ABORD, TOUS SEMEURS CONFONDUS. Le foreground
          // est UNIQUE par propriétaire : si l'artisan a ouvert une modification à l'écran, c'est
          // CE run qui occupe la place, et la voix doit pouvoir le faire avancer. Ne balayer que
          // ses propres graines la rendrait aveugle à un run qu'elle ne peut pourtant ni doubler
          // (`foreground_busy`) ni ignorer : elle refuserait tout, sans jamais dire pourquoi.
          //
          // `currentRun` est optionnel : un adaptateur qui ne sait pas énumérer ne fournit pas
          // une moitié d'annuaire. Absent, on retombe sur les graines — jamais sur une devinette.
          const currentRun = view.currentRun;
          if (typeof currentRun === 'function') {
            const current = await currentRun();
            if (current !== null && current.kind === CUSTOMER_CONTACT_RUN_KIND) {
              return { run: current, runId: current.runId };
            }
          }
          for (let ordinal = 0; ordinal < MAX_VOICE_RUNS_PER_SESSION; ordinal += 1) {
            const runId = deriveRealtimeCustomerContactRunId(
              input.authority.realtimeSessionId,
              ordinal,
            );
            const run = await view.runById(runId);
            if (run === null) return { run: null, runId };
            if (!JARVIS_RUN_TERMINAL_STATUSES.has(run.status)) return { run, runId };
          }
          return null;
        },
      );
      scanned = read.value;
    } catch {
      input.signal.throwIfAborted();
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    input.signal.throwIfAborted();
    if (scanned === null) {
      return { status: 'failed', canonicalSpeech: SESSION_RUNS_EXHAUSTED };
    }
    const run = scanned.run;
    if (run !== null && run.kind !== CUSTOMER_CONTACT_RUN_KIND) {
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    const state =
      run === null || run.kind !== CUSTOMER_CONTACT_RUN_KIND || run.state === null
        ? null
        : parseCustomerContactState(run.state);
    if (
      run !== null &&
      run.kind === CUSTOMER_CONTACT_RUN_KIND &&
      run.state !== null &&
      state === null
    ) {
      // State illisible : jamais une lecture approximative — la voix se retire.
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    const semanticContext = semanticContextFor(
      state,
      run?.revision ?? 0,
      run !== null && JARVIS_RUN_TERMINAL_STATUSES.has(run.status),
    );
    return {
      status: 'prepared',
      prepared: Object.freeze({
        missionKind: CUSTOMER_CONTACT_MISSION_KIND_V1,
        runId: scanned.runId,
        expectedRevision: run?.revision ?? 0,
        state,
        semanticContext,
        availableCapabilities: capabilitiesFor(semanticContext),
      }),
    };
  }

  async runPlanned(input: {
    readonly request: RealtimeJarvisMissionOrchestrationInput;
    readonly prepared: RealtimeJarvisMissionPreparedTurn;
    readonly frame: CustomerContactSemanticFrameV1;
  }): Promise<RealtimeJarvisMissionOrchestrationOutcome> {
    const admission = this.admission;
    if (admission === null) {
      return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    }
    input.request.signal.throwIfAborted();

    // Relecture fraîche AVANT toute écriture : l'écran ou le tap ont pu avancer le run.
    const refreshed = await this.prepare(input.request);
    if (refreshed.status !== 'prepared') return refreshed;
    const current = refreshed.prepared;
    input.request.signal.throwIfAborted();
    if (
      current.runId !== input.prepared.runId ||
      current.expectedRevision !== input.prepared.expectedRevision ||
      current.semanticContext.phase !== input.prepared.semanticContext.phase ||
      current.semanticContext.proposalPresented !== input.prepared.semanticContext.proposalPresented
    ) {
      return { status: 'failed', canonicalSpeech: STATE_MOVED };
    }

    const planned = await this.planCommand(input.request, current, input.frame);
    if (planned.status === 'failed') return planned;
    // `answered` : Bob répond SANS rien admettre (il manque une information à l'artisan).
    if (planned.status === 'answered') return planned.outcome;

    const seed = await this.admit({
      request: input.request,
      runId: current.runId,
      state: current.state,
      expectedRevision: current.expectedRevision,
      commandId: input.request.turnId,
      command: planned.command,
    });
    if (seed === null) return { status: 'failed', canonicalSpeech: TEMPORARY_FAILURE };
    if (seed.status !== 'admitted' && seed.status !== 'replayed') {
      return { status: 'failed', canonicalSpeech: refusalSpeech(seed) };
    }
    if (planned.status === 'chained') {
      return this.runChainedLink(input.request, current.runId, seed, planned);
    }
    return planned.outcome;
  }

  /**
   * LA SONDE DE DOUBLONS — lecture stateless, zéro écriture, zéro verrou.
   *
   * TROIS PORTES FERMÉES ENSEMBLE, et c'est tout le lot qui en dépend : le membre de vue absent
   * (adaptateur qui ne sait pas chercher), l'exception (base indisponible) et le jeu inexploitable
   * rendent tous `null`. Aucune ne se replie sur « aucun doublon » : on ne certifie jamais ce
   * qu'on n'a pas vérifié.
   */
  private async probeDuplicates(
    request: RealtimeJarvisMissionOrchestrationInput,
    runId: string,
    query: string,
  ): Promise<CustomerContactDuplicateProbe | null> {
    const admission = this.admission;
    if (admission === null) return null;
    try {
      const read = await admission.readJarvisStateless(
        {
          companyId: request.authority.owner.companyId,
          ownerUserId: request.authority.owner.ownerUserId,
        },
        async (view) => {
          const chercher = view.customerCandidates;
          // Narrowing EXPLICITE : une vue sans recherche n'autorise pas à conclure.
          return typeof chercher === 'function' ? chercher(query) : null;
        },
      );
      request.signal.throwIfAborted();
      if (read.value === null) return null;
      const probe = deriveCustomerContactDuplicateReview({
        runId,
        commandId: request.turnId,
        query,
        candidates: read.value,
      });
      return probe.kind === 'unusable' ? null : probe;
    } catch {
      request.signal.throwIfAborted();
      return null;
    }
  }

  /**
   * UNE admission vocale : l'enveloppe complète, la corrélation realtime, le digest canonique.
   * Rend `null` sur panne d'infrastructure (l'appelant parle alors de panne temporaire).
   */
  private async admit(input: {
    readonly request: RealtimeJarvisMissionOrchestrationInput;
    readonly runId: string;
    readonly state: CustomerContactStateV1 | null;
    readonly expectedRevision: number;
    readonly commandId: string;
    readonly command: unknown;
  }): Promise<JarvisAdmissionResult | null> {
    const admission = this.admission;
    if (admission === null) return null;
    const actionId = actionIdFor(input.state);
    if (!isU1OpenAction(actionId, CUSTOMER_CONTACT_ACTION_VERSION)) return null;
    const envelope: JarvisUserAdmissionEnvelope = Object.freeze({
      companyId: input.request.authority.owner.companyId,
      ownerUserId: input.request.authority.owner.ownerUserId,
      kind: 'customer_contact',
      definitionVersion: CUSTOMER_CONTACT_DEFINITION_VERSION,
      runId: input.runId,
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      actionId,
      actionVersion: CUSTOMER_CONTACT_ACTION_VERSION,
      authority: Object.freeze({
        source: 'realtime_capability' as const,
        proof: input.request.authority.proof,
      }),
      // CORRÉLATION REALTIME — SANS ELLE L'ADMISSION REFUSE (`missing_realtime_correlation`).
      // Le journal exige qu'un événement vocal porte sa session, son tour et le contexte que le
      // modèle a réellement vu : c'est ce qui rend un tour vocal auditable et rejouable.
      realtimeCorrelation: Object.freeze({
        realtimeSessionId: input.request.authority.realtimeSessionId,
        turnId: input.request.turnId,
        contextRevision: input.request.contextRevision,
        contextDigest: input.request.contextDigest,
      }),
      command: input.command,
      canonicalInputDigest: computeCustomerContactCanonicalInputDigest({
        runId: input.runId,
        commandId: input.commandId,
        command: input.command,
      }),
      occurredAt: this.now().toISOString(),
    });
    try {
      const result = await admission.runJarvisAdmission(envelope);
      input.request.signal.throwIfAborted();
      return result;
    } catch {
      input.request.signal.throwIfAborted();
      return null;
    }
  }

  /**
   * SECOND MAILLON SERVEUR (patron `resolveOpenedTarget`, transposé à la voix) : le semis vient
   * d'être admis, on enchaîne la résolution de doublons dans le MÊME tour.
   *
   * LA GARDE ANTI-CONFLIT, non négociable. La commande de ce maillon porte une donnée VOLATILE
   * (le jeu de candidats) sous un `commandId` DÉRIVÉ : deux tentatives du même tour sur un monde
   * changé construiraient des commandes DIFFÉRENTES ⇒ le reçu serait trouvé mais l'empreinte
   * divergerait ⇒ `command_conflict` sur un run pourtant déjà résolu. On n'émet donc que si le run
   * est EXACTEMENT à l'état qu'un semis neuf produit : révision 1, phase `resolving_customer`.
   * Preuve : un reçu pour l'id dérivé existe ⟺ la résolution a été admise ⟺ la révision est ≥ 2
   * (reçu et CAS commitent ensemble, et une révision ne décroît jamais).
   */
  private async runChainedLink(
    request: RealtimeJarvisMissionOrchestrationInput,
    runId: string,
    seed: JarvisAdmissionResult,
    planned: Extract<CustomerContactPlannedTurn, { status: 'chained' }>,
  ): Promise<RealtimeJarvisMissionOrchestrationOutcome> {
    if (seed.status !== 'admitted' && seed.status !== 'replayed') {
      return { status: 'failed', canonicalSpeech: refusalSpeech(seed) };
    }
    const postimage = seed.postimage;
    const state =
      postimage.kind === 'customer_contact' ? parseCustomerContactState(postimage.state) : null;
    if (
      postimage.revision !== JARVIS_SEEDED_RUN_REVISION ||
      state === null ||
      state.phase !== 'resolving_customer' ||
      state.intent.mode !== 'create'
    ) {
      // Rejeu tardif d'un tour déjà joué : le run a avancé. Zéro écriture, parole honnête.
      return { status: 'failed', canonicalSpeech: STATE_MOVED };
    }
    const linked = await this.admit({
      request,
      runId,
      state,
      expectedRevision: JARVIS_SEEDED_RUN_REVISION,
      commandId: planned.link.commandId,
      command: planned.link.command,
    });
    if (linked === null || (linked.status !== 'admitted' && linked.status !== 'replayed')) {
      // Le PREMIER maillon a réellement eu lieu : dire « rien n'a été exécuté » serait faux.
      // Le run est parqué, et `probe_duplicates` saura le reprendre — la vivacité est tenue.
      this.audit('jarvis.voice.duplicate_resolution_deferred', {
        runId,
        status: linked === null ? 'unavailable' : linked.status,
        candidateCount: planned.candidateCount,
      });
      return planned.deferredOutcome;
    }
    return planned.outcome;
  }

  /**
   * Projection frame → COMMANDE du domaine, bornée par la phase réellement relue. Toute
   * combinaison non prévue échoue fermée : la voix n'invente jamais une transition.
   */
  private async planCommand(
    request: RealtimeJarvisMissionOrchestrationInput,
    prepared: RealtimeJarvisMissionPreparedTurn,
    frame: CustomerContactSemanticFrameV1,
  ): Promise<CustomerContactPlannedTurn> {
    const state = prepared.state;
    const operation = frame.operation;
    const phase = prepared.semanticContext.phase;

    if (operation.kind === 'open_customer_creation') {
      if (state !== null || phase !== 'inactive') {
        return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
      }
      // SANS NOM, ON N'OUVRE RIEN. Bob demande — il n'ouvre pas un run à l'aveugle qu'il faudrait
      // ensuite annuler, et il ne promet pas une vérification qu'il ne peut pas faire.
      if (operation.customerName === null) {
        return {
          status: 'answered',
          outcome: handled(
            'Pour quel client ? Dis-moi son nom : je vérifie d’abord s’il existe déjà chez toi.',
            'structured_choice',
          ),
        };
      }
      // LA RECHERCHE PRÉCÈDE LE SEMIS. Si elle est indisponible, ne rien ouvrir ne retire aucune
      // disponibilité réelle — alors qu'ouvrir d'abord laisserait un run parqué qui confisque le
      // premier plan de l'artisan jusqu'à expiration.
      const probe = await this.probeDuplicates(request, prepared.runId, operation.customerName);
      if (probe === null) return { status: 'failed', canonicalSpeech: DUPLICATE_CHECK_UNAVAILABLE };
      const resolution = duplicateResolutionOf(probe);
      if (resolution === null) {
        return { status: 'failed', canonicalSpeech: DUPLICATE_CHECK_UNAVAILABLE };
      }
      return {
        status: 'chained',
        command: { type: 'start_run', intent: { mode: 'create' } },
        link: {
          command: { type: 'record_customer_resolution', resolution },
          commandId: uuidFromDigest(
            sha256Hex(
              `${VOICE_RESOLUTION_NAMESPACE} ${prepared.runId} ${request.turnId}`,
            ),
          ),
        },
        candidateCount: probe.kind === 'duplicate_candidates' ? probe.candidates.length : 0,
        outcome: handled(
          openedSpeech(operation.customerName, probe),
          probe.kind === 'duplicate_candidates' ? 'structured_choice' : 'action_result',
        ),
        deferredOutcome: handled(
          'J’ai ouvert la fiche mais je n’ai pas fini de vérifier les doublons. Rien n’a été enregistré. Redis-moi le nom du client pour que je reprenne, ou dis « annule ».',
          'structured_choice',
        ),
      };
    }

    // REPRISE d'un run parqué : le second maillon a été refusé, l'artisan redonne le nom.
    if (operation.kind === 'probe_duplicates') {
      if (state === null || phase !== 'resolving_customer' || state.intent.mode !== 'create') {
        return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
      }
      const probe = await this.probeDuplicates(request, prepared.runId, operation.customerName);
      if (probe === null) {
        return { status: 'failed', canonicalSpeech: DUPLICATE_RECHECK_UNAVAILABLE };
      }
      const resolution = duplicateResolutionOf(probe);
      if (resolution === null) {
        return { status: 'failed', canonicalSpeech: DUPLICATE_RECHECK_UNAVAILABLE };
      }
      return {
        status: 'planned',
        command: { type: 'record_customer_resolution', resolution },
        outcome: handled(
          openedSpeech(operation.customerName, probe, 'resumed'),
          probe.kind === 'duplicate_candidates' ? 'structured_choice' : 'action_result',
        ),
      };
    }
    if (state === null) return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };

    if (operation.kind === 'cancel_run') {
      return {
        status: 'planned',
        command: { type: 'cancel_run', reason: 'user_cancelled' },
        outcome: handled(
          'C’est annulé. Aucune fiche client n’a été créée ni modifiée.',
          'action_result',
        ),
      };
    }

    if (operation.kind === 'continue_creation' || operation.kind === 'choose_duplicate') {
      const review = state.duplicateReview;
      if (phase !== 'awaiting_duplicate_review' || review === null) {
        return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
      }
      if (operation.kind === 'continue_creation') {
        return {
          status: 'planned',
          command: {
            type: 'choose_duplicate_resolution',
            reviewId: review.reviewId,
            decision: { kind: 'continue_create' },
          },
          outcome: handled(
            'Je continue la création d’une nouvelle fiche. Dis-moi les informations à y mettre.',
            'structured_choice',
          ),
        };
      }
      const candidate = review.candidates[operation.ordinal - 1];
      if (candidate === undefined) {
        return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
      }
      return {
        status: 'planned',
        command: {
          type: 'choose_duplicate_resolution',
          reviewId: review.reviewId,
          decision: { kind: 'use_existing', choiceId: candidate.choiceId },
        },
        outcome: handled(
          'J’ai retenu le client qui existe déjà. Aucune nouvelle fiche n’a été créée.',
          'action_result',
        ),
      };
    }

    if (operation.kind === 'propose_fields') {
      if (phase !== 'preparing_proposal') {
        return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
      }
      const payloads = this.payloads;
      if (payloads === null) {
        return { status: 'failed', canonicalSpeech: PAYLOAD_UNAVAILABLE };
      }
      const fields = operation.fields;
      const fieldsDigest = computeCustomerContactFieldsDigest(fields);
      const sensitiveDigest = computeCustomerContactSensitiveDigest(fields);
      const proposalId = derivedProposalId(prepared.runId, request.turnId, 'proposal');
      const confirmationId = derivedProposalId(prepared.runId, request.turnId, 'confirmation');
      let sealed: Awaited<ReturnType<JarvisProposalPayloadStorePort['sealProposalPayload']>>;
      try {
        // §5.5 : la charge PII est scellée AVANT la proposition — jamais après, jamais dans le run.
        sealed = await payloads.sealProposalPayload({
          companyId: request.authority.owner.companyId,
          ownerUserId: request.authority.owner.ownerUserId,
          runId: prepared.runId,
          proposalId,
          fieldsDigest,
          sensitiveDigest,
          fields,
          retentionExpiresAt: new Date(
            this.now().getTime() + AGENT_MISSION_RETENTION_MS,
          ).toISOString(),
        });
      } catch {
        request.signal.throwIfAborted();
        return { status: 'failed', canonicalSpeech: PAYLOAD_UNAVAILABLE };
      }
      request.signal.throwIfAborted();
      if (sealed.status !== 'sealed' && sealed.status !== 'replayed') {
        return { status: 'failed', canonicalSpeech: PAYLOAD_UNAVAILABLE };
      }
      const spoken = speakFields(fields);
      return {
        status: 'planned',
        command: {
          type: 'stage_proposal',
          proposalId,
          confirmationId,
          fieldsDigest,
          sensitiveDigest,
          targetRevision: state.intent.mode === 'create' ? null : state.intent.target.revision,
        },
        outcome: handled(
          `Voici ce que j’ai préparé : ${spoken}. Rien n’est encore enregistré. Dis-moi si tu as bien entendu, puis confirme.`,
          'structured_choice',
        ),
      };
    }

    const confirmation = state.confirmation;
    const proposal = state.proposal;
    if (phase !== 'awaiting_confirmation' || confirmation === null || proposal === null) {
      return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
    }

    if (operation.kind === 'acknowledge_presentation') {
      if (confirmation.status !== 'issued') {
        return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
      }
      return {
        status: 'planned',
        // §7.0 : `client-creer@1` est M2 + privacy_sensitive — l'ACK vocal est admis par la
        // table des accusés ; l'écran reste TOUJOURS offert pour la même proposition.
        command: {
          type: 'record_presentation_ack',
          confirmationId: confirmation.confirmationId,
          ack: 'voice_presentation_ack',
        },
        outcome: handled(
          'C’est noté, tu as bien entendu la proposition. Dis « je confirme » pour l’enregistrer, ou « annule ».',
          'structured_choice',
        ),
      };
    }

    if (operation.kind === 'reject_proposal') {
      return {
        status: 'planned',
        command: { type: 'reject_proposal', confirmationId: confirmation.confirmationId },
        outcome: handled(
          'Je laisse tomber cette proposition. Rien n’a été enregistré : redis-moi ce qu’il faut corriger.',
          'structured_choice',
        ),
      };
    }

    // confirm_proposal
    if (confirmation.status !== 'presented') {
      return { status: 'failed', canonicalSpeech: UNSAFE_UNDERSTANDING };
    }
    if (state.intent.mode === 'update') {
      // §7.0 règle 3 : une modification se confirme À L'ÉCRAN — l'artisan doit VOIR l'avant/après
      // avant qu'on récrive sa fiche. La relecture autoritaire de la cible, elle, n'est plus le
      // sujet : depuis U1-e §2 l'admission la produit pour TOUS les canaux (§7.1).
      return { status: 'failed', canonicalSpeech: UPDATE_CONFIRM_NEEDS_SCREEN };
    }
    return {
      status: 'planned',
      command: {
        // Trois clés, comme le tap : la cible relue n'est PAS une donnée de commande (U1-e §2).
        type: 'confirm',
        confirmationId: confirmation.confirmationId,
        proposalHash: proposal.proposalHash,
      },
      outcome: handled(
        'C’est confirmé. J’enregistre la fiche client et je te dis dès que c’est fait.',
        'action_result',
      ),
    };
  }
}

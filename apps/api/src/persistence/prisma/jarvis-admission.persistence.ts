/**
 * Admission Jarvis §5.2 — chair de l'extension du UoW unique (SPEC_U1C §2).
 *
 * Ce fichier est le FRÈRE de agent-mission.persistence.ts : il en réutilise les
 * helpers exportés (timeouts, verrous advisory, contexte RLS, horloge base) et
 * n'introduit AUCUN second UoW — les méthodes publiques vivent sur
 * `PrismaAgentMissionUnitOfWork`, qui délègue ici. Ordre d'écriture imposé par
 * `guard_agent_mission_event_append_v3` : CAS/INSERT du run D'ABORD
 * (`updatedAt = occurredAt`), PUIS append de l'événement (`sequence = revisionAfter`),
 * puis work items. Toute erreur rollbacke l'ensemble.
 *
 * U1-e §2 : c'est aussi ICI, et nulle part ailleurs, que la CIBLE d'un run de modification est
 * relue (`FOR UPDATE`, même transaction) et son digest sensible dérivé — le client ne peut pas
 * se certifier lui-même, et une lecture hors transaction rouvrirait une fenêtre TOCTOU.
 */

import { randomUUID } from 'node:crypto';

import {
  ACTION_CATALOG_V0,
  AGENT_MISSION_RETENTION_MS,
  computeCustomerContactTargetSensitiveDigest,
  CUSTOMER_CONTACT_MAX_DUPLICATE_CANDIDATES,
  CUSTOMER_CONTACT_V1,
  JARVIS_RUN_LEASE_RELEASING_STATUSES,
  JARVIS_RUN_STATUSES,
  JARVIS_RUN_TERMINAL_STATUSES,
  parseCustomerContactState,
  projectQuoteMissionJarvisStatus,
  reduceJarvisRun,
  resolveJarvisDefinition,
  SINGLE_BUSINESS_ACTION_V1,
  type ActionCatalogEntry,
  type AgentMissionFingerprintPort,
  type CustomerCandidate,
  type CustomerCandidateReference,
  type JarvisAdmissionKind,
  type JarvisAdmissionOwner,
  type JarvisAdmissionResult,
  type JarvisRunEnvelope,
  type JarvisRunTransition,
  type JarvisSystemAdmissionEnvelope,
  type JarvisTargetRevalidation,
  type JarvisTargetSnapshot,
  type JarvisUserAdmissionEnvelope,
} from '@bob/core';
import { Prisma } from '@prisma/client';
import {
  canonicalCustomerName,
  CUSTOMER_CANDIDATE_SEARCH_LIMIT,
  customerCandidateSearchSql,
  customerReferenceByIdsSql,
} from './customer-candidate-sql';

import {
  acquireJarvisKindOwnerLock,
  acquireMissionForegroundOwnerLock,
  databaseClock,
  lockOpenCompanyForMissionWrite,
  resolveAgentMissionAuthority,
  setMissionContext,
  setTransactionTimeouts,
  toInputJson,
} from './agent-mission.persistence';

/** Digest constant du résultat « aucun effet » (cancel gagné avant autorisation). */
/** Acteur journalise : le canal reel, jamais un defaut (§5.2, vocabulaire de la lane devis). */
function jarvisEventActor(envelope: AdmissionEnvelope): 'user_voice' | 'user_tap' | 'system' {
  if (envelope.actor !== 'user') return 'system';
  return envelope.authority.source === 'realtime_capability' ? 'user_voice' : 'user_tap';
}

/** Corrélation realtime de l'événement — exigée par le CHECK pour un acteur `user_voice`. */
function jarvisEventCorrelation(envelope: AdmissionEnvelope): {
  realtimeSessionId: string | null;
  turnId: string | null;
  contextRevision: number | null;
  contextDigest: string | null;
} {
  const correlation = envelope.actor === 'user' ? envelope.realtimeCorrelation : undefined;
  if (correlation === undefined) {
    return {
      realtimeSessionId: null,
      turnId: null,
      contextRevision: null,
      contextDigest: null,
    };
  }
  return {
    realtimeSessionId: correlation.realtimeSessionId,
    turnId: correlation.turnId,
    contextRevision: correlation.contextRevision,
    contextDigest: correlation.contextDigest,
  };
}

const NO_EFFECT_RESULT_DIGEST = 'a'.repeat(0) + '0'.repeat(64);

// Enregistrement des définitions au chargement du module (registre gelé U1-b).
void SINGLE_BUSINESS_ACTION_V1;
void CUSTOMER_CONTACT_V1;

/** Course de seed perdue : le même runId a été admis par une transaction concurrente. */
export class JarvisSeedRaceError extends Error {
  constructor(readonly actualRevision: number) {
    super('JARVIS_ADMISSION_SEED_RACE');
    this.name = 'JarvisSeedRaceError';
  }
}

/** Backstop de premier plan : un autre run non-libéré occupe déjà cet owner. */
export class JarvisForegroundBusyError extends Error {
  constructor() {
    super('JARVIS_ADMISSION_FOREGROUND_BUSY');
    this.name = 'JarvisForegroundBusyError';
  }
}

/** Dépendances par appel — le signeur HMAC vient du service, jamais de la persistence. */
export interface JarvisAdmissionDeps {
  readonly fingerprints: AgentMissionFingerprintPort;
  readonly canonicalizationVersion: number;
  /** Kill switch d'admission (§5.3) : bloque les NOUVELLES commandes user, jamais les signaux. */
  readonly admissionEnabled: boolean;
  /** Harnais de certification uniquement — jamais posé par un câblage de production. */
  readonly allowCertificationAuthority: boolean;
}

interface JarvisRunRow {
  readonly id: string;
  readonly companyId: string;
  readonly ownerUserId: string;
  readonly kind: string;
  readonly status: string;
  readonly phase: string;
  readonly revision: number;
  readonly payloadVersion: number;
  readonly payload: unknown;
  readonly definitionVersion: number | null;
  readonly nextWakeAt: Date | null;
  readonly idleExpiresAt: Date;
  readonly hardExpiresAt: Date;
  readonly terminalAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const JARVIS_RUN_COLUMNS = Prisma.sql`
  "id", "companyId", "ownerUserId", "kind", "status", "phase", "revision",
  "payloadVersion", "payload", "definitionVersion", "nextWakeAt",
  "idleExpiresAt", "hardExpiresAt", "terminalAt", "createdAt", "updatedAt"
`;

function envelopeFromRow(row: JarvisRunRow): JarvisRunEnvelope {
  return Object.freeze({
    kind: row.kind as JarvisAdmissionKind,
    runId: row.id,
    companyId: row.companyId,
    createdBy: row.ownerUserId,
    definitionVersion: row.definitionVersion ?? 0,
    status: row.status as JarvisRunEnvelope['status'],
    revision: row.revision,
    stateVersion: row.payloadVersion,
    state: row.payload,
    nextWakeAt: row.nextWakeAt === null ? null : row.nextWakeAt.toISOString(),
    terminalAt: row.terminalAt === null ? null : row.terminalAt.toISOString(),
  });
}

function catalogEntryFor(actionId: string, actionVersion: number): ActionCatalogEntry | null {
  return (
    ACTION_CATALOG_V0.find(
      (entry) => entry.actionId === actionId && entry.version === actionVersion,
    ) ?? null
  );
}

/** Phase persistée d'un run Jarvis : le miroir du state (contrat SQL de la tranche). */
function phaseOf(postimage: Extract<JarvisRunEnvelope, { readonly stateVersion: number }>): string {
  const state = postimage.state as { readonly phase?: unknown } | null;
  return state !== null && typeof state?.phase === 'string' ? state.phase : 'resolving_customer';
}

type AdmissionEnvelope =
  | (JarvisUserAdmissionEnvelope & { readonly actor: 'user' })
  | (JarvisSystemAdmissionEnvelope & {
      readonly actor: 'system';
      readonly actionId: null;
      readonly actionVersion: null;
      readonly canonicalInputDigest: string;
    });

function canonicalCommandRequest(envelope: AdmissionEnvelope): string {
  // Canonicalisation fermée v1 : champs d'identité de la commande, ordre fixe,
  // séparateur unité — le fingerprint scelle l'intention, jamais le contenu métier.
  return [
    'bob.jarvis.admission.v1',
    envelope.companyId,
    envelope.ownerUserId,
    envelope.kind,
    String(envelope.definitionVersion),
    envelope.runId,
    envelope.commandId,
    String(envelope.expectedRevision),
    // §5.4 : un commandId n'est JAMAIS réutilisable pour une autre action/observation.
    envelope.actor === 'user' ? envelope.actionId : envelope.observationKind,
    String(envelope.actor === 'user' ? envelope.actionVersion : 0),
    envelope.actor === 'system' ? envelope.effectId : '',
    envelope.canonicalInputDigest,
  ].join('\u001f');
}

interface ExistingReceipt {
  readonly missionId: string;
  readonly missionKind: string;
  readonly sequence: number;
  readonly requestFingerprintHmac: string;
  readonly fingerprintKeyVersion: number;
}

async function findJarvisReceipt(
  tx: Prisma.TransactionClient,
  owner: JarvisAdmissionOwner,
  commandId: string,
): Promise<ExistingReceipt | null> {
  const row = await tx.agentMissionEvent.findFirst({
    where: {
      companyId: owner.companyId,
      ownerUserId: owner.ownerUserId,
      commandId,
    },
    select: {
      missionId: true,
      sequence: true,
      requestFingerprintHmac: true,
      fingerprintKeyVersion: true,
      mission: { select: { kind: true } },
    },
  });
  if (row === null) return null;
  return {
    missionId: row.missionId,
    missionKind: row.mission.kind,
    sequence: row.sequence,
    requestFingerprintHmac: row.requestFingerprintHmac,
    fingerprintKeyVersion: row.fingerprintKeyVersion,
  };
}

async function findJarvisRunForUpdate(
  tx: Prisma.TransactionClient,
  owner: JarvisAdmissionOwner,
  runId: string,
  kind: JarvisAdmissionKind,
): Promise<JarvisRunRow | null> {
  await setMissionContext(tx, runId);
  const rows = await tx.$queryRaw<JarvisRunRow[]>`
    SELECT ${JARVIS_RUN_COLUMNS}
    FROM public.agent_missions
    WHERE "id" = ${runId}::UUID
      AND "companyId" = ${owner.companyId}
      AND "ownerUserId" = ${owner.ownerUserId}
      AND "kind" = ${kind}
    LIMIT 1
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/** Colonnes de `customers` qui COMPOSENT les champs sensibles §9.1 — rien d'autre ne sort. */
interface JarvisCustomerTargetRow {
  readonly revision: number;
  readonly tvaIntracom: string | null;
  readonly billingChannelType: string | null;
  readonly addrLine1: string | null;
  readonly addrZip: string | null;
  readonly addrCity: string | null;
  readonly contactName: string | null;
  readonly email: string | null;
}

/**
 * RELECTURE AUTORITAIRE DE LA CIBLE (§7.1, U1-e §2) — la seule source admissible de la révision
 * et du digest sensible revalidés :
 *  · DANS la transaction d'admission, APRÈS le verrou de la ligne de run et le verrou société :
 *    l'ordre des verrous reste global (société -> run -> cible), donc sans interblocage avec
 *    `BackendService.updateCustomer`, qui prend la société puis écrit la fiche ;
 *  · `FOR UPDATE` sur la ligne cible : entre cette lecture et le COMMIT, plus personne ne mute
 *    la fiche — la fenêtre TOCTOU d'une lecture faite dans le controller n'existe pas ici ;
 *  · dérivation par une fonction PURE du core, jamais un digest recopié d'un scellé existant
 *    (ce serait une auto-certification toujours vraie).
 * `null` = pas de cible (création, seed, kind hors fiche client) OU cible illisible : la
 * définition refuse alors la modification, elle ne la devine pas.
 */
async function readJarvisTargetRevalidation(
  tx: Prisma.TransactionClient,
  owner: JarvisAdmissionOwner,
  run: JarvisRunEnvelope,
): Promise<JarvisTargetRevalidation | null> {
  if (run.kind !== 'customer_contact') return null;
  const state = parseCustomerContactState(run.state);
  if (state === null || state.intent.mode !== 'update') return null;
  const rows = await tx.$queryRaw<JarvisCustomerTargetRow[]>`
    SELECT "revision", "tvaIntracom", "billingChannelType", "addrLine1", "addrZip", "addrCity",
           "contactName", "email"
    FROM public.customers
    WHERE "id" = ${state.intent.target.customerId}
      AND "companyId" = ${owner.companyId}
    LIMIT 1
    FOR UPDATE
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    revision: row.revision,
    sensitiveDigest: computeCustomerContactTargetSensitiveDigest({
      vatNumber: row.tvaIntracom,
      billingChannel: row.billingChannelType,
      addressLine: row.addrLine1,
      postalCode: row.addrZip,
      city: row.addrCity,
      recipientName: row.contactName,
      email: row.email,
    }),
  });
}

/** Écritures dans l'ordre du garde SQL : run PUIS événement PUIS work items. */
async function persistTransition(
  tx: Prisma.TransactionClient,
  envelope: AdmissionEnvelope,
  transition: JarvisRunTransition,
  deps: JarvisAdmissionDeps,
  options: {
    readonly isSeed: boolean;
    readonly limitsTtl: { idleMs: number; hardMs: number };
    /** Horloge BASE de la transaction (§5.2) — jamais l'Instant client. */
    readonly now: string;
    /**
     * Borne DURE du run, telle qu'elle est en base — lue avec le preimage, jamais recalculée.
     * Elle plafonne le rafraîchissement d'inactivité : une transition ne repousse jamais
     * l'échéance ferme. Absente au semis, où les deux bornes naissent ensemble.
     */
    readonly hardExpiresAt: Date;
  },
): Promise<{ readonly sequence: number; readonly workItemIds: readonly string[] }> {
  const postimage = transition.postimage;
  if (postimage.kind === 'quote_creation') {
    throw new Error('JARVIS_ADMISSION_QUOTE_BRANCH_FORBIDDEN');
  }
  const occurredAt = new Date(options.now);
  const phase = phaseOf(postimage);
  await setMissionContext(tx, postimage.runId);

  if (options.isSeed) {
    const inserted = await tx.agentMission.createMany({
      data: [
        {
          id: postimage.runId,
          companyId: postimage.companyId,
          ownerUserId: envelope.ownerUserId,
          protocolVersion: 1,
          kind: postimage.kind,
          status: postimage.status,
          phase,
          revision: postimage.revision,
          payloadVersion: postimage.stateVersion,
          payload: toInputJson(postimage.state),
          currentBinding: Prisma.DbNull,
          definitionVersion: postimage.definitionVersion,
          nextWakeAt: postimage.nextWakeAt === null ? null : new Date(postimage.nextWakeAt),
          idleExpiresAt: new Date(occurredAt.getTime() + options.limitsTtl.idleMs),
          hardExpiresAt: new Date(occurredAt.getTime() + options.limitsTtl.hardMs),
          terminalAt: postimage.terminalAt === null ? null : new Date(postimage.terminalAt),
          retentionExpiresAt: new Date(
            occurredAt.getTime() + Math.max(options.limitsTtl.hardMs, AGENT_MISSION_RETENTION_MS),
          ),
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count !== 1) {
      // skipDuplicates a avale une violation d'unique : soit une course sur le MEME
      // runId (l'autre admission a gagne), soit le backstop de premier plan
      // one_active_owner_key (un autre run non-libere existe pour cet owner).
      const existing = await tx.agentMission.findFirst({
        where: { id: postimage.runId, companyId: postimage.companyId },
        select: { revision: true },
      });
      throw existing !== null
        ? new JarvisSeedRaceError(existing.revision)
        : new JarvisForegroundBusyError();
    }
  } else {
    const updated = await tx.agentMission.updateMany({
      where: {
        id: postimage.runId,
        companyId: postimage.companyId,
        ownerUserId: envelope.ownerUserId,
        kind: postimage.kind,
        revision: envelope.expectedRevision,
      },
      data: {
        status: postimage.status,
        phase,
        revision: postimage.revision,
        payloadVersion: postimage.stateVersion,
        payload: toInputJson(postimage.state),
        definitionVersion: postimage.definitionVersion,
        nextWakeAt: postimage.nextWakeAt === null ? null : new Date(postimage.nextWakeAt),
        terminalAt: postimage.terminalAt === null ? null : new Date(postimage.terminalAt),
        updatedAt: occurredAt,
        // L'INACTIVITÉ SE MESURE DEPUIS LA DERNIÈRE TRANSITION, jamais depuis la naissance du run.
        //
        // Sans cette valeur, `idleExpiresAt` restait figé à celle du semis : la colonne mesurait
        // l'ÂGE du run, si bien qu'un run activement travaillé pendant 25 h se serait présenté
        // comme inactif au premier balayeur qui la lirait. Surtout, les lignes Jarvis VIOLAIENT
        // ainsi l'invariant que le noyau applique déjà aux lignes legacy (`agent-mission.ts`,
        // branche `status === 'active'` : `idleExpiresAt` doit valoir exactement
        // `min(updatedAt + idleTtl, hardExpiresAt)`, sinon `timestamps/inconsistent_state`) —
        // invariant que la projection déterministe du cutover §17 relira sur CES lignes.
        //
        // POURQUOI LE CLAMP EST CALCULÉ ICI, et pas par un `LEAST` SQL. Un UPDATE séparé qui
        // n'aurait touché que cette colonne est REFUSÉ par le garde du dépôt
        // (`AGENT_MISSION_IDENTITY_OR_REVISION_INVALID` : tout UPDATE doit porter
        // `revision = OLD.revision + 1`) — et ce refus est juste, il interdit toute écriture qui
        // contournerait le compare-and-swap. La borne voyage donc DANS le CAS, et `hardExpiresAt`
        // vient du preimage déjà lu `FOR UPDATE` : aucun aller-retour de plus, aucune course —
        // la borne dure est immuable après le semis.
        idleExpiresAt: new Date(
          Math.min(occurredAt.getTime() + options.limitsTtl.idleMs, options.hardExpiresAt.getTime()),
        ),
      },
    });
    if (updated.count !== 1) {
      throw new Error('JARVIS_ADMISSION_CAS_LOST');
    }
  }

  const fingerprint = deps.fingerprints.sign(canonicalCommandRequest(envelope));
  if (fingerprint === null) {
    // Rotation de clef en cours sans version signable : l'admission echoue et rollbacke —
    // jamais un evenement sans HMAC (spec §5.4).
    throw new Error('JARVIS_ADMISSION_FINGERPRINT_UNAVAILABLE');
  }
  const sequence = postimage.revision;
  await tx.agentMissionEvent.create({
    data: {
      id: randomUUID(),
      companyId: postimage.companyId,
      ownerUserId: envelope.ownerUserId,
      missionId: postimage.runId,
      sequence,
      eventType: transition.event.type,
      eventVersion: transition.event.version,
      // Le journal immuable dit le CANAL (revue C12-P0) : une commande vocale ne s'inscrit
      // jamais comme un tap. Meme vocabulaire que la lane devis (user_voice | user_tap).
      actor: jarvisEventActor(envelope),
      commandId: envelope.commandId,
      requestFingerprintHmac: fingerprint.hmac,
      fingerprintKeyVersion: fingerprint.keyVersion,
      fingerprintCanonicalizationVersion: deps.canonicalizationVersion,
      missionRevisionBefore: envelope.expectedRevision,
      missionRevisionAfter: postimage.revision,
      ...jarvisEventCorrelation(envelope),
      data: toInputJson({ ...transition.event.data, kind: transition.event.type }),
      occurredAt,
      retentionExpiresAt: new Date(occurredAt.getTime() + AGENT_MISSION_RETENTION_MS),
    },
  });

  const workItemIds: string[] = [];
  for (const intent of transition.workItemIntents) {
    const id = randomUUID();
    workItemIds.push(id);
    await tx.jarvisWorkItem.create({
      data: {
        id,
        companyId: postimage.companyId,
        runId: postimage.runId,
        ownerUserId: envelope.ownerUserId,
        effectId: intent.effectId,
        actionId: intent.actionId,
        actionVersion: intent.actionVersion,
        authorizationSource: toInputJson(intent.authorizationSource),
        actingPrincipalId: intent.actingPrincipalId,
        targetDigest: intent.targetDigest,
        payloadRef: intent.payloadRef === null ? Prisma.DbNull : toInputJson(intent.payloadRef),
        executeBy: new Date(intent.executeBy),
        status: 'prepared',
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
    });
  }
  if (postimage.status === 'cancelled' || postimage.status === 'cancelling') {
    // Greffe §5.2/§5.3 (revue C9) : les work items non autorisés du run passent `cancelled`
    // ATOMIQUEMENT avec l'événement de cancel — jamais un balayage asynchrone. L'événement
    // de cancel EST le signal du run : signalAppliedAt est posé pour ne pas re-signaler.
    await tx.jarvisWorkItem.updateMany({
      where: {
        companyId: postimage.companyId,
        runId: postimage.runId,
        status: { in: ['prepared', 'leased', 'retry_due'] },
      },
      data: {
        status: 'cancelled',
        resultDigest: NO_EFFECT_RESULT_DIGEST,
        signalAppliedAt: occurredAt,
        updatedAt: occurredAt,
      },
    });
  }
  return { sequence, workItemIds };
}

async function admitCore(
  tx: Prisma.TransactionClient,
  envelope: AdmissionEnvelope,
  deps: JarvisAdmissionDeps,
): Promise<JarvisAdmissionResult> {
  await setTransactionTimeouts(tx);
  // §5.2 : l'horloge BASE fait autorité sur journal, TTL et CAS — jamais l'Instant client.
  const now: string = (await databaseClock(tx)).toISOString();
  const company = await lockOpenCompanyForMissionWrite(tx, envelope.companyId);
  if (company !== 'open') {
    // §5.6 : une commande système reste admissible société fermée (signal/observation).
    if (envelope.actor !== 'system' || company === 'missing') {
      return { status: 'company_unavailable', reason: company };
    }
  }
  await acquireMissionForegroundOwnerLock(tx, envelope);
  await acquireJarvisKindOwnerLock(tx, envelope, envelope.kind);

  if (envelope.actor === 'user') {
    // Kill switch d'admission (§5.3) : les nouvelles commandes s'arrêtent, les signaux jamais.
    if (!deps.admissionEnabled) {
      return { status: 'action_refused', reason: 'admission_kill_switch' };
    }
    // Principal (§5.2 étape 5) : la preuve d'autorité se résout SOUS verrou, in-tx.
    // Switch EXHAUSTIF sur l'union fermée — une source inconnue est refusée, jamais tolérée.
    switch (envelope.authority.source) {
      case 'realtime_capability': {
        // Le journal exige la corrélation complète pour une commande vocale : sans elle,
        // l'admission refuse — jamais un événement vocal sans sa session (CHECK SQL).
        if (envelope.actor === 'user' && envelope.realtimeCorrelation === undefined) {
          return { status: 'capability_rejected', reason: 'missing_realtime_correlation' };
        }
        const resolution = await resolveAgentMissionAuthority(
          tx,
          { companyId: envelope.companyId, ownerUserId: envelope.ownerUserId },
          envelope.authority.proof,
          true,
        );
        if (resolution.status !== 'authorized') {
          return { status: 'capability_rejected', reason: String(resolution.reason) };
        }
        break;
      }
      case 'authenticated_principal': {
        // §14 : le canal tactile vit SANS lease Realtime. Le hash est dérivé SERVEUR
        // par le controller depuis le bearer authentifié — l'admission n'en vérifie que
        // la forme et le stampe pour l'audit (dans l'événement via la canonicalisation).
        if (!/^[a-f0-9]{64}$/.test(envelope.authority.principalBindingHash)) {
          return { status: 'capability_rejected', reason: 'malformed_principal_binding' };
        }
        break;
      }
      case 'certification_fixture': {
        if (!deps.allowCertificationAuthority) {
          return { status: 'capability_rejected', reason: 'certification_fixture_forbidden' };
        }
        break;
      }
      default: {
        const never: never = envelope.authority;
        void never;
        return { status: 'capability_rejected', reason: 'unknown_authority_source' };
      }
    }
    // Catalogue (pur, §5.2 étape 6).
    const entry = catalogEntryFor(envelope.actionId, envelope.actionVersion);
    if (entry === null) return { status: 'action_refused', reason: 'unknown_action' };
    if (entry.voiceMode === 'closed') return { status: 'action_refused', reason: 'action_closed' };
  }

  // Reçu (§5.2 étape 7) — replay zéro-write ou conflit, jamais une réexécution.
  const receipt = await findJarvisReceipt(tx, envelope, envelope.commandId);
  if (receipt !== null) {
    if (receipt.missionId !== envelope.runId || receipt.missionKind !== envelope.kind) {
      return { status: 'command_conflict' };
    }
    const matches = deps.fingerprints.matches(canonicalCommandRequest(envelope), {
      keyVersion: receipt.fingerprintKeyVersion,
      hmac: receipt.requestFingerprintHmac,
    });
    if (matches !== true) return { status: 'command_conflict' };
    const row = await findJarvisRunForUpdate(tx, envelope, envelope.runId, envelope.kind);
    if (row === null) return { status: 'command_conflict' };
    // Greffe « replay qui heal », BORNÉE (revue C1) : seul le replay SYSTÈME du signal
    // concerné re-stampe — un replay user n'éteint jamais un signal pas encore admis.
    let signalRestamped = false;
    if (envelope.actor === 'system') {
      const restamped = await tx.jarvisWorkItem.updateMany({
        where: {
          companyId: envelope.companyId,
          runId: envelope.runId,
          effectId: envelope.effectId,
          resultDigest: { not: null },
          signalAppliedAt: null,
        },
        data: { signalAppliedAt: new Date(now) },
      });
      signalRestamped = restamped.count > 0;
    }
    return {
      status: 'replayed',
      postimage: envelopeFromRow(row),
      eventSequence: receipt.sequence,
      signalRestamped,
    };
  }

  // Run courant ou seed (convention U1-b : revision 0, state null, jamais persistée).
  const row = await findJarvisRunForUpdate(tx, envelope, envelope.runId, envelope.kind);
  let run: JarvisRunEnvelope;
  let isSeed = false;
  if (row === null) {
    if (envelope.expectedRevision !== 0 || envelope.actor !== 'user') {
      return { status: 'run_not_found' };
    }
    isSeed = true;
    run = Object.freeze({
      kind: envelope.kind,
      runId: envelope.runId,
      companyId: envelope.companyId,
      createdBy: envelope.ownerUserId,
      definitionVersion: envelope.definitionVersion,
      status: 'active' as const,
      revision: 0,
      stateVersion: 1,
      state: null,
      nextWakeAt: null,
      terminalAt: null,
    });
  } else {
    if (row.status === 'quarantined') {
      // §5.5 : un run en quarantaine est GELÉ jusqu'à migration — jamais une
      // re-quarantaine qui grossirait le journal à chaque commande empoisonnée.
      return { status: 'refused', error: { code: 'run_terminal', status: 'quarantined' } };
    }
    if (row.revision !== envelope.expectedRevision) {
      return { status: 'stale_revision', actualRevision: row.revision };
    }
    run = envelopeFromRow(row);
  }

  const definition = resolveJarvisDefinition(envelope.kind, envelope.definitionVersion);
  const allocatedEffectIds = Array.from({ length: definition?.limits.maxOpenWorkItems ?? 1 }, () =>
    randomUUID(),
  );
  // §7.1 : la cible d'un run de modification est relue ICI, sous verrou, pour TOUTE commande de
  // ce run — la définition décide seule de ce qu'elle en fait. L'admission ne renifle jamais le
  // type de commande pour choisir de verrouiller ou non : le verrou est uniforme, donc l'ordre
  // des verrous l'est aussi.
  const targetRevalidation = await readJarvisTargetRevalidation(tx, envelope, run);
  const reduced = reduceJarvisRun(
    run,
    {
      kind: envelope.kind,
      definitionVersion: envelope.definitionVersion,
      command: envelope.command,
    },
    {
      commandId: envelope.commandId,
      expectedRevision: envelope.expectedRevision,
      occurredAt: now,
      actingPrincipalId: envelope.ownerUserId,
      allocatedEffectIds,
      targetRevalidation,
    },
  );
  if (!reduced.ok) {
    if ('quarantine' in reduced) {
      if (isSeed) return { status: 'quarantined' };
      // Gardes SQL (mutation_v2 + event_required, revue C2) : la quarantaine est une
      // transition COMPLÈTE — revision+1, updatedAt=occurredAt, et son événement système.
      const nextRevision = envelope.expectedRevision + 1;
      const quarantined = await tx.agentMission.updateMany({
        where: {
          id: envelope.runId,
          companyId: envelope.companyId,
          ownerUserId: envelope.ownerUserId,
          revision: envelope.expectedRevision,
        },
        data: {
          status: 'quarantined',
          revision: nextRevision,
          updatedAt: new Date(now),
        },
      });
      if (quarantined.count !== 1) throw new Error('JARVIS_ADMISSION_QUARANTINE_CAS_LOST');
      const fingerprint = deps.fingerprints.sign(canonicalCommandRequest(envelope));
      if (fingerprint === null) throw new Error('JARVIS_ADMISSION_FINGERPRINT_UNAVAILABLE');
      await tx.agentMissionEvent.create({
        data: {
          id: randomUUID(),
          companyId: envelope.companyId,
          ownerUserId: envelope.ownerUserId,
          missionId: envelope.runId,
          sequence: nextRevision,
          eventType: 'run_quarantined',
          eventVersion: 1,
          // L'événement porte le reçu de LA commande qui a heurté la quarantaine : son
          // commandId. Le garde envelope_check lie l'acteur au format du commandId
          // (user ⇔ v4, system ⇔ v8) — l'acteur reflète donc l'enveloppe, comme partout ;
          // le caractère « système » de la mise en quarantaine vit dans le TYPE §5.5.
          // Le journal immuable dit le CANAL (revue C12-P0) : une commande vocale ne s'inscrit
          // jamais comme un tap. Meme vocabulaire que la lane devis (user_voice | user_tap).
          actor: jarvisEventActor(envelope),
          commandId: envelope.commandId,
          requestFingerprintHmac: fingerprint.hmac,
          fingerprintKeyVersion: fingerprint.keyVersion,
          fingerprintCanonicalizationVersion: deps.canonicalizationVersion,
          missionRevisionBefore: envelope.expectedRevision,
          missionRevisionAfter: nextRevision,
          ...jarvisEventCorrelation(envelope),
          data: toInputJson({
            kind: 'run_quarantined',
            definitionVersion: envelope.definitionVersion,
          }),
          occurredAt: new Date(now),
          retentionExpiresAt: new Date(Date.parse(now) + AGENT_MISSION_RETENTION_MS),
        },
      });
      return { status: 'quarantined' };
    }
    if (reduced.error.code === 'revision_conflict') {
      return { status: 'stale_revision', actualRevision: reduced.error.actualRevision };
    }
    return { status: 'refused', error: reduced.error };
  }
  if (envelope.actor === 'system' && reduced.value.workItemIntents.length > 0) {
    // §5.6 : une observation système ne rouvre jamais le droit de créer un effet.
    return {
      status: 'refused',
      error: { code: 'invalid_command', reason: 'system_command_emitted_intents' },
    };
  }

  const limits = definition?.limits;
  let persisted: { readonly sequence: number; readonly workItemIds: readonly string[] };
  try {
    persisted = await persistTransition(tx, envelope, reduced.value, deps, {
      isSeed,
      limitsTtl: {
        idleMs: limits?.idleTtlMs ?? 24 * 60 * 60 * 1_000,
        hardMs: limits?.hardTtlMs ?? 7 * 24 * 60 * 60 * 1_000,
      },
      now,
      // Au semis la ligne n'existe pas encore : la valeur n'est alors pas lue (les deux bornes
      // naissent de la même horloge base, quelques lignes plus haut).
      hardExpiresAt: row?.hardExpiresAt ?? new Date(now),
    });
  } catch (error) {
    if (error instanceof JarvisSeedRaceError) {
      return { status: 'stale_revision', actualRevision: error.actualRevision };
    }
    if (error instanceof JarvisForegroundBusyError) {
      return { status: 'foreground_busy' };
    }
    throw error;
  }
  return {
    status: 'admitted',
    postimage: reduced.value.postimage,
    eventSequence: persisted.sequence,
    workItemIds: persisted.workItemIds,
  };
}

export async function runJarvisAdmissionInTransaction(
  tx: Prisma.TransactionClient,
  envelope: JarvisUserAdmissionEnvelope,
  deps: JarvisAdmissionDeps,
): Promise<JarvisAdmissionResult> {
  return admitCore(tx, { ...envelope, actor: 'user' }, deps);
}

export async function runJarvisSystemAdmissionInTransaction(
  tx: Prisma.TransactionClient,
  envelope: JarvisSystemAdmissionEnvelope,
  deps: JarvisAdmissionDeps,
): Promise<JarvisAdmissionResult> {
  return admitCore(
    tx,
    {
      ...envelope,
      actor: 'system',
      actionId: null,
      actionVersion: null,
      canonicalInputDigest: envelope.observationKind,
    },
    deps,
  );
}

/**
 * Statuts qui TIENNENT le premier plan (§5.1) — DÉRIVÉS des constantes du domaine, jamais
 * recopiés : c'est exactement le prédicat de l'index partiel `agent_missions_one_active_owner_key`
 * (migration 20260819000200), donc au plus UNE ligne de l'owner peut les porter.
 */
const JARVIS_FOREGROUND_HOLDING_STATUSES: readonly string[] = JARVIS_RUN_STATUSES.filter(
  (status) =>
    !JARVIS_RUN_TERMINAL_STATUSES.has(status) &&
    !JARVIS_RUN_LEASE_RELEASING_STATUSES.has(status) &&
    status !== 'quarantined',
);

/**
 * Statuts qu'un run COURANT ne peut pas porter : les terminaux §5.1 et le gel §5.5. Dérivés eux
 * aussi — un statut terminal ajouté au domaine sort de l'annuaire sans qu'on y touche.
 */
const JARVIS_TERMINAL_OR_FROZEN_STATUSES: readonly string[] = [
  ...JARVIS_RUN_TERMINAL_STATUSES,
  'quarantined',
];

/**
 * ANNUAIRE DU RUN COURANT (U1-e §1) — sans lui, un appareil ne connaît AUCUN `runId` : la voix
 * ne renvoie que la parole, et la carte de confirmation resterait invisible après la mort de la
 * session vocale. Owner-scopé, lecture seule, aucun verrou (il vit dans la transaction stateless
 * `readJarvisStateless`, en lecture RepeatableRead).
 *
 * Ce qu'un run COURANT est, ici et dans le controller :
 *  · non terminal — `terminalAt IS NULL` ET statut hors terminaux : les deux, parce que la
 *    colonne et le statut sont posés par la même transition et qu'une seule des deux suffirait
 *    à rendre un run fini « reprenable » si l'autre dérivait ;
 *  · pas gelé — `quarantined` (§5.5) refuse TOUTE commande : le proposer à l'écran offrirait une
 *    carte que rien ne peut faire avancer. Il ne tient pas non plus le premier plan (backstop).
 * La branche devis (`quote_creation`) garde ses routes legacy §17.1 : elle n'est jamais énumérée
 * ici — le filtre de `kind` est celui de `readJarvisRunById`, mot pour mot.
 *
 * DÉTERMINISME de l'ordre : le run qui tient le premier plan passe devant (l'index partiel en
 * garantit l'unicité), puis le plus récemment muté, puis l'identifiant — deux lectures du même
 * état rendent donc toujours le même run, jamais un choix au hasard du plan d'exécution.
 */
/**
 * U1-f §4/§5 — LA FICHE CIBLE, TELLE QU'ELLE EST, pour que l'écran puisse la NOMMER et montrer
 * l'« avant » d'une modification.
 *
 * DISPLAY-ONLY, assumé : lue SANS verrou, sur le snapshot de la lecture stateless. Le TOCTOU est
 * réel (la fiche peut bouger juste après) et il est SANS CONSÉQUENCE : rien ici n'autorise une
 * écriture. La seule autorité reste `readJarvisTargetRevalidation`, sous `FOR UPDATE`, dans la
 * transaction d'admission au moment du `confirm` (§9.1) — c'est elle qui invalide une proposition
 * dont la cible a changé. Montrer un « avant » légèrement daté est honnête ; ne rien montrer du
 * tout obligeait l'artisan à confirmer une modification sans savoir sur QUI elle portait.
 *
 * Le mapping colonnes → clés du frame est celui de la revalidation, étendu au nom et au téléphone
 * (que le sceau sensible n'inclut pas mais que l'écran présente).
 */
export async function readJarvisTargetSnapshot(
  tx: Prisma.TransactionClient,
  owner: JarvisAdmissionOwner,
  customerId: string,
): Promise<JarvisTargetSnapshot | null> {
  const rows = await tx.$queryRaw<
    Array<{
      name: string | null;
      contactName: string | null;
      email: string | null;
      phone: string | null;
      addrLine1: string | null;
      addrZip: string | null;
      addrCity: string | null;
      tvaIntracom: string | null;
      billingChannelType: string | null;
    }>
  >`
    SELECT "name", "contactName", "email", "phone", "addrLine1", "addrZip", "addrCity",
           "tvaIntracom", "billingChannelType"
    FROM public.customers
    WHERE "id" = ${customerId}
      AND "companyId" = ${owner.companyId}
    LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    displayName: row.name,
    fields: Object.freeze({
      // `displayName` et `legalName` partagent la colonne `name` : le dépôt n'en porte qu'une.
      // On la rend sous les DEUX clés plutôt que d'en inventer une seconde — l'écran n'affiche
      // de toute façon l'« avant » que des champs réellement proposés.
      displayName: row.name,
      legalName: row.name,
      email: row.email,
      phone: row.phone,
      addressLine: row.addrLine1,
      postalCode: row.addrZip,
      city: row.addrCity,
      vatNumber: row.tvaIntracom,
      recipientName: row.contactName,
      billingChannel: row.billingChannelType,
    }),
  });
}

/**
 * U1-g §2 — CANDIDATS DE DOUBLON, sur le MÊME snapshot que le run et SANS AUCUN VERROU.
 *
 * `FOR SHARE` est IMPOSSIBLE ici : la lecture stateless ouvre sa transaction en READ ONLY, et
 * PostgreSQL refuse (`cannot execute SELECT FOR SHARE in a read-only transaction`). Ce n'est pas
 * une préférence de conception, c'est une condition d'exécution — et c'est cohérent : rien n'est
 * DÉCIDÉ sur cette lecture. Le jeu rendu sera scellé par digests dans le run, et c'est ce sceau,
 * pas la ligne, qui fait foi ensuite.
 *
 * Le filtre `companyId` est explicite EN PLUS de la RLS : ceinture et bretelles, comme partout.
 */
export async function readJarvisCustomerCandidates(
  tx: Prisma.TransactionClient,
  owner: JarvisAdmissionOwner,
  query: string,
): Promise<readonly CustomerCandidate[]> {
  const rows = await tx.$queryRaw<
    Array<{
      customerId: string;
      canonicalName: string;
      matchKind: 'exact' | 'fuzzy';
      score: number;
    }>
  >(
    customerCandidateSearchSql({
      companyId: owner.companyId,
      query,
      limit: CUSTOMER_CANDIDATE_SEARCH_LIMIT,
      lock: 'none',
    }),
  );
  return rows.map((row) =>
    Object.freeze({
      customerId: row.customerId,
      canonicalName: row.canonicalName,
      matchKind: row.matchKind,
      score: row.score,
    }),
  );
}

/**
 * Libellés par identité — id et nom, RIEN d'autre. On ne relit pas la fiche complète d'un TIERS
 * pour n'en prononcer que le nom : ce serait de la sur-collecte.
 */
export async function readJarvisCustomerLabels(
  tx: Prisma.TransactionClient,
  owner: JarvisAdmissionOwner,
  customerIds: readonly string[],
): Promise<readonly CustomerCandidateReference[]> {
  if (customerIds.length === 0) return [];
  // LA BORNE EST PINCEE ICI, pas laissee a l'appelant : un adaptateur qui accepterait une liste
  // sans limite ferait de la borne du domaine une politesse. Le jeu presente ne depasse jamais
  // `CUSTOMER_CONTACT_MAX_DUPLICATE_CANDIDATES` (meme constante que la revue elle-meme).
  const bornes = customerIds.slice(0, CUSTOMER_CONTACT_MAX_DUPLICATE_CANDIDATES);
  const rows = await tx.$queryRaw<Array<{ customerId: string; canonicalName: string }>>(
    customerReferenceByIdsSql({ companyId: owner.companyId, customerIds: bornes, lock: 'none' }),
  );
  // MEME REGLE DE FRONTIERE QUE SES JUMELLES DU DEVIS : le nom sort normalise, jamais brut.
  return rows.map((row) =>
    Object.freeze({
      customerId: row.customerId,
      canonicalName: canonicalCustomerName(row.canonicalName),
    }),
  );
}

export async function readJarvisCurrentRun(
  tx: Prisma.TransactionClient,
  owner: JarvisAdmissionOwner,
): Promise<JarvisRunEnvelope | null> {
  const rows = await tx.$queryRaw<JarvisRunRow[]>`
    SELECT ${JARVIS_RUN_COLUMNS}
    FROM public.agent_missions
    WHERE "companyId" = ${owner.companyId}
      AND "ownerUserId" = ${owner.ownerUserId}
      AND "kind" IN ('single_business_action', 'customer_contact')
      AND "terminalAt" IS NULL
      AND "status" NOT IN (${Prisma.join(JARVIS_TERMINAL_OR_FROZEN_STATUSES)})
    ORDER BY
      CASE
        WHEN "status" IN (${Prisma.join(JARVIS_FOREGROUND_HOLDING_STATUSES)}) THEN 0
        ELSE 1
      END,
      "updatedAt" DESC,
      "id" ASC
    LIMIT 1
  `;
  return rows[0] === undefined ? null : envelopeFromRow(rows[0]);
}

export async function readJarvisRunById(
  tx: Prisma.TransactionClient,
  owner: JarvisAdmissionOwner,
  runId: string,
): Promise<JarvisRunEnvelope | null> {
  const rows = await tx.$queryRaw<JarvisRunRow[]>`
    SELECT ${JARVIS_RUN_COLUMNS}
    FROM public.agent_missions
    WHERE "id" = ${runId}::UUID
      AND "companyId" = ${owner.companyId}
      AND "ownerUserId" = ${owner.ownerUserId}
      AND "kind" IN ('single_business_action', 'customer_contact')
    LIMIT 1
  `;
  return rows[0] === undefined ? null : envelopeFromRow(rows[0]);
}

export { databaseClock, projectQuoteMissionJarvisStatus };

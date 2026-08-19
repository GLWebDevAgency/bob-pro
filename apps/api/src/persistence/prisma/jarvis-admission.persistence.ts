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
 */

import { randomUUID } from 'node:crypto';

import {
  ACTION_CATALOG_V0,
  AGENT_MISSION_RETENTION_MS,
  CUSTOMER_CONTACT_V1,
  SINGLE_BUSINESS_ACTION_V1,
  projectQuoteMissionJarvisStatus,
  reduceJarvisRun,
  resolveJarvisDefinition,
  type ActionCatalogEntry,
  type AgentMissionFingerprintPort,
  type JarvisAdmissionKind,
  type JarvisAdmissionOwner,
  type JarvisAdmissionResult,
  type JarvisRunEnvelope,
  type JarvisRunTransition,
  type JarvisSystemAdmissionEnvelope,
  type JarvisUserAdmissionEnvelope,
} from '@bob/core';
import { Prisma } from '@prisma/client';

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
  ].join('');
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
      actor: envelope.actor === 'user' ? 'user_tap' : 'system',
      commandId: envelope.commandId,
      requestFingerprintHmac: fingerprint.hmac,
      fingerprintKeyVersion: fingerprint.keyVersion,
      fingerprintCanonicalizationVersion: deps.canonicalizationVersion,
      missionRevisionBefore: envelope.expectedRevision,
      missionRevisionAfter: postimage.revision,
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
    if (envelope.authority.source === 'realtime_capability') {
      const resolution = await resolveAgentMissionAuthority(
        tx,
        { companyId: envelope.companyId, ownerUserId: envelope.ownerUserId },
        envelope.authority.proof,
        true,
      );
      if (resolution.status !== 'authorized') {
        return { status: 'capability_rejected', reason: String(resolution.reason) };
      }
    } else if (!deps.allowCertificationAuthority) {
      return { status: 'capability_rejected', reason: 'certification_fixture_forbidden' };
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
          actor: envelope.actor === 'user' ? 'user_tap' : 'system',
          commandId: envelope.commandId,
          requestFingerprintHmac: fingerprint.hmac,
          fingerprintKeyVersion: fingerprint.keyVersion,
          fingerprintCanonicalizationVersion: deps.canonicalizationVersion,
          missionRevisionBefore: envelope.expectedRevision,
          missionRevisionAfter: nextRevision,
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

/**
 * Jarvis U1-c — certification PostgreSQL de LA transaction d'admission (spec Jarvis
 * §5.2/§5.6, SPEC_U1C_ADMISSION_DISPATCH_20260818 §2/§5, preuves §19.2).
 *
 * Chaque preuve passe par le VRAI port (`uow.runJarvisAdmission` /
 * `runJarvisSystemAdmission` / `readJarvisStateless`) puis RELIT LA BASE par
 * l'auditeur — jamais seulement le résultat du port. Preuves :
 * (1) seed admis : run persisté revision 1, événement sequence 1, colonne phase =
 *     state.phase, definitionVersion épinglée ; (2) replay même commandId + même
 *     enveloppe => `replayed`, même eventSequence, AUCUNE nouvelle ligne ;
 * (3) même commandId, canonicalInputDigest divergent => `command_conflict`, zéro
 *     write ; (4) deux admissions concurrentes même run même expectedRevision
 *     (2 connexions, Promise.all) => une seule gagne, exactement 1 événement ;
 * (5) portée de reçu PAR RUN (preuve déplacée d'U1-a) : même commandId refusé sur
 *     un autre run, et l'index agent_mission_events_run_command_key prouvé par
 *     insert brut violé (23505) — le garde d'append est suspendu (TRIGGER USER)
 *     dans une transaction condamnée, uniquement pour atteindre l'index ;
 * (6) backstop de premier plan élargi : seed refusé `foreground_busy` face à un run
 *     `waiting_user`, puis admis après cancel ; (7) crash simulé : la connexion du
 *     worker est terminée au milieu de la transaction => zéro ligne pour ce
 *     commandId, la même enveloppe passe ensuite ; (8) lecture stateless : rend le
 *     run et n'écrit rien ; (9) voie système §5.6 : commandId DÉTERMINISTE
 *     (deriveJarvisSystemCommandId), `record_effect_receipt` appliqué + rejoué
 *     zéro-write, et une réduction qui émettrait un intent refusée
 *     `system_command_emitted_intents` ;
 * (10) quarantaine §5.5 (revue C16) : un run RÉEL épinglé sur une definitionVersion
 *     que le registre ignore (rollback de code simulé — le schéma, lui, la connaît
 *     toujours) => `quarantined`, transition COMPLÈTE relue en base (revision+1,
 *     événement système `run_quarantined` sequence=revision, ZÉRO work item), puis
 *     toute commande suivante refusée (stale_revision / refus typé) sans un write ;
 * (11) replay-qui-heal, branche VRAIE (revue C18) : résultat persisté par le VRAI
 *     repository sans signal appliqué (fenêtre de crash §5.3) => le replay SYSTÈME
 *     du même (runId, effectId, observationKind) rend `signalRestamped=true` ET pose
 *     `signalAppliedAt` en base ; un replay USER du même run ne re-stampe JAMAIS.
 * (12) cancel avant authorize : l'item non autorisé devient `cancelled`, sa lease est vidée mais
 *      son résultat no-effect reste dû ; la redelivery canonique terminalise ensuite le run.
 *
 * Même harnais que jarvis-work-items.persistence.postgres.test.ts : gates env,
 * base jetable, sociétés via l'auditeur, fingerprints déterministes.
 */
import { randomUUID } from 'node:crypto';

import {
  CLOSED_JARVIS_ACTION_RELEASE_POLICY,
  computeCustomerContactProposalHash,
  CUSTOMER_CONTACT_CREATE_ACTION_ID,
  CUSTOMER_CONTACT_LIMITS,
  CUSTOMER_CONTACT_UPDATE_ACTION_ID,
  deriveJarvisSystemCommandId,
  deriveJarvisWakeCommandId,
  parseCustomerContactState,
  sha256Hex,
  type AgentMissionFingerprintPort,
  type JarvisSystemAdmissionResult,
  type JarvisSystemAdmissionEnvelope,
  type JarvisUserAdmissionEnvelope,
} from '@bob/core';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaAgentMissionUnitOfWork } from './agent-mission.persistence';
import { TEST_ONLY_JARVIS_ACTION_RELEASE_POLICY } from '../../jarvis/jarvis-release-policy.testing';
import type { JarvisAdmissionDeps } from './jarvis-admission.persistence';
import {
  PrismaJarvisWorkItemsRepository,
  type JarvisWorkItemCoordinates,
} from './jarvis-work-items.persistence';
import { PrismaService } from './prisma.service';

const RUN_CERT = process.env.RUN_AGENT_MISSION_POSTGRES_CERT === 'true';
const DISPOSABLE = process.env.AGENT_MISSION_CERT_DATABASE_IS_DISPOSABLE === 'true';

const TEST_TIMEOUT_MS = 60_000;

const FINGERPRINTS: AgentMissionFingerprintPort = {
  sign(canonicalRequest) {
    return { keyVersion: 1, hmac: sha256Hex(`jarvis-u1c-adm-key:${canonicalRequest}`) };
  },
  matches(canonicalRequest, fingerprint) {
    if (fingerprint.keyVersion !== 1) return null;
    return fingerprint.hmac === sha256Hex(`jarvis-u1c-adm-key:${canonicalRequest}`);
  },
};

const TEST_ONLY_ADMISSION_DEPS: JarvisAdmissionDeps = {
  fingerprints: FINGERPRINTS,
  canonicalizationVersion: 1,
  admissionEnabled: true,
  // Harnais de certification : la preuve d'autorite realtime arrive avec les callers U1-d.
  allowCertificationAuthority: true,
  actionReleasePolicy: TEST_ONLY_JARVIS_ACTION_RELEASE_POLICY,
};

const START_CREATE = { type: 'start_run', intent: { mode: 'create' } } as const;

function expectAdmission<S extends JarvisSystemAdmissionResult['status']>(
  result: JarvisSystemAdmissionResult,
  status: S,
): Extract<JarvisSystemAdmissionResult, { status: S }> {
  if (result.status !== status) {
    throw new Error(`Jarvis U1-c: statut ${status} attendu, reçu ${JSON.stringify(result)}`);
  }
  return result as Extract<JarvisSystemAdmissionResult, { status: S }>;
}

function deriveSystemCommandId(runId: string, effectId: string, observationKind: string): string {
  const derived = deriveJarvisSystemCommandId(runId, effectId, observationKind);
  if (!derived.ok) {
    throw new Error(`Jarvis U1-c: dérivation système refusée ${JSON.stringify(derived.error)}`);
  }
  return derived.value;
}

function pgErrorText(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return `${error.message} ${JSON.stringify(error.meta ?? {})}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface RunAuditRow {
  readonly kind: string;
  readonly status: string;
  readonly phase: string;
  readonly revision: number;
  readonly protocolVersion: number;
  readonly payloadVersion: number;
  readonly definitionVersion: number | null;
  readonly payload: unknown;
  readonly nextWakeAt: Date | null;
  readonly terminalAt: Date | null;
}

interface EventAuditRow {
  readonly sequence: number;
  readonly eventType: string;
  readonly actor: string;
  readonly commandId: string;
  readonly requestFingerprintHmac: string;
  readonly fingerprintKeyVersion: number;
  readonly fingerprintCanonicalizationVersion: number;
  readonly missionRevisionBefore: number;
  readonly missionRevisionAfter: number;
  readonly occurredAt: Date;
}

interface RunStorageAuditRow {
  readonly snapshot: unknown;
  readonly xmin: string;
  readonly ctid: string;
}

interface WorkItemStorageAuditRow {
  readonly snapshot: unknown;
  readonly xmin: string;
  readonly ctid: string;
}

interface WorkItemAuditRow {
  readonly id: string;
  readonly effectId: string;
  readonly actionId: string;
  readonly actionVersion: number;
  readonly status: string;
  readonly leaseFence: bigint;
  readonly leaseOwner: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly nextAttemptAt: Date | null;
  readonly authorizedAt: Date | null;
  readonly authorizationDigest: string | null;
  readonly resultDigest: string | null;
  readonly signalAppliedAt: Date | null;
  readonly actingPrincipalId: string;
  readonly authorizationSource: unknown;
}

function statePhaseOf(row: RunAuditRow): string {
  const payload = row.payload as { readonly phase?: unknown } | null;
  return payload !== null && typeof payload?.phase === 'string' ? payload.phase : '';
}

function stateEffectIdOf(row: RunAuditRow): string {
  const payload = row.payload as { readonly effectId?: unknown } | null;
  if (payload === null || typeof payload?.effectId !== 'string') {
    throw new Error('Jarvis U1-c: effectId absent du state persisté.');
  }
  return payload.effectId;
}

describe.skipIf(!RUN_CERT)(
  'Jarvis U1-c — certification PostgreSQL de la transaction d’admission (§5.2/§5.6)',
  () => {
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const certAdminUrl = process.env.AGENT_MISSION_CERT_ADMIN_URL ?? '';
    const companyId = `jarvis-admission-company-${randomUUID()}`;
    let admin: PrismaClient;
    let deployer: PrismaClient;
    let workerA: PrismaService;
    let workerB: PrismaService;
    let uowA: PrismaAgentMissionUnitOfWork;
    let uowB: PrismaAgentMissionUnitOfWork;

    function freshOwner(): string {
      return `jarvis-admission-owner-${randomUUID()}`;
    }

    function userEnvelope(input: {
      readonly ownerUserId: string;
      readonly runId: string;
      readonly expectedRevision: number;
      readonly command: unknown;
      readonly commandId?: string;
      readonly canonicalInputDigest?: string;
      readonly definitionVersion?: number;
      readonly actionId?: string;
      readonly actionVersion?: number;
    }): JarvisUserAdmissionEnvelope {
      return Object.freeze({
        kind: 'customer_contact' as const,
        definitionVersion: input.definitionVersion ?? 1,
        companyId,
        ownerUserId: input.ownerUserId,
        runId: input.runId,
        commandId: input.commandId ?? randomUUID(),
        expectedRevision: input.expectedRevision,
        actionId: input.actionId ?? CUSTOMER_CONTACT_CREATE_ACTION_ID,
        actionVersion: input.actionVersion ?? 1,
        authority: { source: 'certification_fixture' } as const,
        command: input.command,
        canonicalInputDigest:
          input.canonicalInputDigest ??
          sha256Hex(`jarvis-u1c-adm-input:${JSON.stringify(input.command)}`),
        occurredAt: new Date().toISOString(),
      });
    }

    function systemEnvelope(input: {
      readonly ownerUserId: string;
      readonly runId: string;
      readonly effectId: string;
      readonly expectedRevision: number;
      readonly command: unknown;
      readonly observationKind: string;
    }): JarvisSystemAdmissionEnvelope {
      return Object.freeze({
        kind: 'customer_contact' as const,
        definitionVersion: 1,
        companyId,
        ownerUserId: input.ownerUserId,
        runId: input.runId,
        commandId: deriveSystemCommandId(input.runId, input.effectId, input.observationKind),
        expectedRevision: input.expectedRevision,
        command: input.command,
        subject: {
          type: 'effect_observation',
          observationKind: input.observationKind,
          observationDigest: null,
          effectId: input.effectId,
        },
        occurredAt: new Date().toISOString(),
      });
    }

    function wakeEnvelope(input: {
      readonly ownerUserId: string;
      readonly runId: string;
      readonly wakeId: string;
      readonly dueAt: string;
      readonly expectedRevision: number;
    }): JarvisSystemAdmissionEnvelope {
      const derived = deriveJarvisWakeCommandId(
        input.runId,
        input.wakeId,
        input.dueAt,
        input.expectedRevision,
      );
      if (!derived.ok) {
        throw new Error(`Jarvis U1-m: dérivation wake refusée ${JSON.stringify(derived.error)}`);
      }
      return Object.freeze({
        kind: 'customer_contact' as const,
        definitionVersion: 1,
        companyId,
        ownerUserId: input.ownerUserId,
        runId: input.runId,
        commandId: derived.value,
        expectedRevision: input.expectedRevision,
        command: { type: 'wake_run', wakeId: input.wakeId } as const,
        subject: {
          type: 'wake_due' as const,
          wakeId: input.wakeId,
          dueAt: input.dueAt,
        },
        occurredAt: new Date().toISOString(),
      });
    }

    /** TTL d'inactivite du vertical fiche client — miroir de `CUSTOMER_CONTACT_LIMITS`. */
    const IDLE_TTL_MS = CUSTOMER_CONTACT_LIMITS.idleTtlMs;

    /** Les trois horodatages qui portent l'invariant de TTL, lus par l'auditeur. */
    async function timestamps(
      runId: string,
    ): Promise<{ idle: Date; hard: Date; updated: Date }> {
      const rows = await admin.$queryRaw<
        Array<{ idleExpiresAt: Date; hardExpiresAt: Date; updatedAt: Date }>
      >`
        SELECT "idleExpiresAt", "hardExpiresAt", "updatedAt"
          FROM public.agent_missions
         WHERE "id" = ${runId}::uuid
      `;
      const row = rows[0];
      if (row === undefined) throw new Error(`U1-h: run introuvable ${runId}`);
      return { idle: row.idleExpiresAt, hard: row.hardExpiresAt, updated: row.updatedAt };
    }

    async function auditRun(runId: string): Promise<RunAuditRow | null> {
      const rows = await admin.$queryRaw<RunAuditRow[]>`
        SELECT "kind", "status", "phase", "revision", "protocolVersion",
               "payloadVersion", "definitionVersion", "payload", "nextWakeAt", "terminalAt"
          FROM public.agent_missions
         WHERE "id" = ${runId}::uuid
      `;
      return rows[0] ?? null;
    }

    async function requireRun(runId: string): Promise<RunAuditRow> {
      const row = await auditRun(runId);
      if (row === null) throw new Error(`Jarvis U1-c: run introuvable ${runId}`);
      return row;
    }

    async function auditRunStorage(runId: string): Promise<RunStorageAuditRow> {
      const rows = await admin.$queryRaw<RunStorageAuditRow[]>`
        SELECT to_jsonb(mission) AS "snapshot",
               mission.xmin::text AS "xmin",
               mission.ctid::text AS "ctid"
          FROM public.agent_missions AS mission
         WHERE mission."id" = ${runId}::uuid
      `;
      const row = rows[0];
      if (row === undefined) throw new Error(`Jarvis U1-m: run introuvable ${runId}`);
      return row;
    }

    async function authoritativeWake(runId: string): Promise<{
      readonly wakeId: string;
      readonly dueAt: string;
      readonly revision: number;
    }> {
      const run = await requireRun(runId);
      const state = parseCustomerContactState(run.payload);
      const wake = state?.wakes[0];
      if (
        state === null
        || state.wakes.length !== 1
        || wake === undefined
        || run.nextWakeAt?.toISOString() !== wake.dueAt
      ) {
        throw new Error(`Jarvis U1-m: wake autoritaire absent ou incohérent ${runId}`);
      }
      return { wakeId: wake.wakeId, dueAt: wake.dueAt, revision: run.revision };
    }

    async function auditEvents(runId: string): Promise<EventAuditRow[]> {
      return admin.$queryRaw<EventAuditRow[]>`
        SELECT "sequence", "eventType", "actor", "commandId",
               "requestFingerprintHmac", "fingerprintKeyVersion",
               "fingerprintCanonicalizationVersion",
               "missionRevisionBefore", "missionRevisionAfter", "occurredAt"
          FROM public.agent_mission_events
         WHERE "missionId" = ${runId}::uuid
         ORDER BY "sequence"
      `;
    }

    async function commandEventCount(commandId: string): Promise<number> {
      const rows = await admin.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS "count"
          FROM public.agent_mission_events
         WHERE "companyId" = ${companyId}
           AND "commandId" = ${commandId}::uuid
      `;
      return rows[0]?.count ?? 0;
    }

    async function auditWorkItems(runId: string): Promise<WorkItemAuditRow[]> {
      return admin.$queryRaw<WorkItemAuditRow[]>`
        SELECT "id", "effectId", "actionId", "actionVersion", "status",
               "leaseFence", "leaseOwner", "leaseToken", "leaseExpiresAt",
               "nextAttemptAt", "authorizedAt", "resultDigest", "signalAppliedAt",
               "authorizationDigest",
               "actingPrincipalId", "authorizationSource"
          FROM public.jarvis_work_items
         WHERE "runId" = ${runId}::uuid
      `;
    }

    async function auditWorkItemStorage(workItemId: string): Promise<WorkItemStorageAuditRow> {
      const rows = await admin.$queryRaw<WorkItemStorageAuditRow[]>`
        SELECT to_jsonb(item) AS "snapshot",
               item.xmin::text AS "xmin",
               item.ctid::text AS "ctid"
          FROM public.jarvis_work_items AS item
         WHERE item."id" = ${workItemId}::uuid
      `;
      const row = rows[0];
      if (row === undefined) throw new Error(`Jarvis U1-m: work item introuvable ${workItemId}`);
      return row;
    }

    async function insertWakeRestampSentinel(input: {
      readonly ownerUserId: string;
      readonly runId: string;
      readonly effectId: string;
    }): Promise<string> {
      const workItemId = randomUUID();
      await deployer.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE bob_schema_owner');
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${input.ownerUserId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.current_agent_mission_id', ${input.runId}, true)`;
        await tx.$executeRaw`
          INSERT INTO public.jarvis_work_items (
            "id", "companyId", "runId", "ownerUserId", "effectId",
            "actionId", "actionVersion", "authorizationSource", "actingPrincipalId",
            "executeBy", "status", "authorizedAt", "authorizationDigest", "resultDigest",
            "createdAt", "updatedAt"
          ) VALUES (
            ${workItemId}::uuid, ${companyId}, ${input.runId}::uuid, ${input.ownerUserId},
            ${input.effectId}::uuid, 'client-creer', 1,
            jsonb_build_object('source', 'confirmation', 'receiptId', ${randomUUID()}::text),
            ${input.ownerUserId}, clock_timestamp() + interval '1 hour', 'succeeded',
            clock_timestamp(), ${sha256Hex('jarvis-u1m-sentinel-authorization')},
            ${sha256Hex('jarvis-u1m-sentinel-result')}, clock_timestamp(), clock_timestamp()
          )
        `;
      });
      return workItemId;
    }

    async function pinWakeDueAt(
      ownerUserId: string,
      runId: string,
      dueAt: string,
    ): Promise<void> {
      await deployer.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE bob_schema_owner');
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ownerUserId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.current_agent_mission_id', ${runId}, true)`;
        await tx.$executeRawUnsafe('ALTER TABLE public.agent_missions DISABLE TRIGGER USER');
        const updated = await tx.$executeRaw`
          UPDATE public.agent_missions
             SET "payload" = jsonb_set(
                   jsonb_set(
                     "payload",
                     '{confirmation,expiresAt}',
                     to_jsonb(${dueAt}::text),
                     false
                   ),
                   '{wakes,0,dueAt}',
                   to_jsonb(${dueAt}::text),
                   false
                 ),
                 "nextWakeAt" = ${dueAt}::timestamptz
           WHERE "id" = ${runId}::uuid
             AND "companyId" = ${companyId}
        `;
        if (updated !== 1) throw new Error('Jarvis U1-m: épinglage dueAt raté.');
        await tx.$executeRawUnsafe('ALTER TABLE public.agent_missions ENABLE TRIGGER USER');
      });
    }

    async function databaseDueAtAfter(milliseconds: number): Promise<string> {
      const rows = await admin.$queryRaw<Array<{ dueAt: Date }>>`
        SELECT date_trunc('milliseconds', clock_timestamp())
               + (${milliseconds}::int * interval '1 millisecond') AS "dueAt"
      `;
      const dueAt = rows[0]?.dueAt;
      if (dueAt === undefined) throw new Error('Jarvis U1-m: horloge DB indisponible.');
      return dueAt.toISOString();
    }

    async function waitUntilDatabaseDue(dueAt: string): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const rows = await admin.$queryRaw<Array<{ due: boolean }>>`
          SELECT clock_timestamp() >= ${dueAt}::timestamptz AS "due"
        `;
        if (rows[0]?.due === true) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Jarvis U1-m: échéance DB non atteinte ${dueAt}`);
    }

    /** Seed par le VRAI port : start_run create, expectedRevision 0 (convention U1-b). */
    async function seedRun(
      ownerUserId: string,
    ): Promise<{ runId: string; envelope: JarvisUserAdmissionEnvelope }> {
      const runId = randomUUID();
      const envelope = userEnvelope({
        ownerUserId,
        runId,
        expectedRevision: 0,
        command: START_CREATE,
      });
      const admitted = expectAdmission(await uowA.runJarvisAdmission(envelope, TEST_ONLY_ADMISSION_DEPS), 'admitted');
      expect(admitted.eventSequence).toBe(1);
      return { runId, envelope };
    }

    /**
     * Conduit un run par le VRAI port jusqu'à la proposition PRÉSENTÉE (revision 4) :
     * seed → no_duplicates → stage_proposal → record_presentation_ack. Rend tout ce
     * qu'il faut pour construire la commande `confirm` (celle qui émet l'intent 1:1).
     */
    async function driveRunToPresented(ownerUserId: string): Promise<{
      readonly runId: string;
      readonly effectId: string;
      readonly confirmationId: string;
      readonly proposalHash: string;
    }> {
      const { runId } = await seedRun(ownerUserId);
      const effectId = stateEffectIdOf(await requireRun(runId));
      expectAdmission(
        await uowA.runJarvisAdmission(
          userEnvelope({
            ownerUserId,
            runId,
            expectedRevision: 1,
            command: { type: 'record_customer_resolution', resolution: { kind: 'no_duplicates' } },
          }),
          TEST_ONLY_ADMISSION_DEPS,
        ),
        'admitted',
      );
      const proposalId = randomUUID();
      const confirmationId = randomUUID();
      const fieldsDigest = sha256Hex('jarvis-u1c-adm-heal-fields');
      const sensitiveDigest = sha256Hex('jarvis-u1c-adm-heal-sensitive');
      expectAdmission(
        await uowA.runJarvisAdmission(
          userEnvelope({
            ownerUserId,
            runId,
            expectedRevision: 2,
            command: {
              type: 'stage_proposal',
              proposalId,
              confirmationId,
              fieldsDigest,
              sensitiveDigest,
              targetRevision: null,
            },
          }),
          TEST_ONLY_ADMISSION_DEPS,
        ),
        'admitted',
      );
      expectAdmission(
        await uowA.runJarvisAdmission(
          userEnvelope({
            ownerUserId,
            runId,
            expectedRevision: 3,
            command: { type: 'record_presentation_ack', confirmationId, ack: 'screen_ack' },
          }),
          TEST_ONLY_ADMISSION_DEPS,
        ),
        'admitted',
      );
      const proposalHash = computeCustomerContactProposalHash({
        runId,
        proposalId,
        actionId: CUSTOMER_CONTACT_CREATE_ACTION_ID,
        fieldsDigest,
        sensitiveDigest,
        targetRevision: null,
        effectId,
      });
      return { runId, effectId, confirmationId, proposalHash };
    }

    async function driveUpdateRunToPresented(
      ownerUserId: string,
      customerId: string,
    ): Promise<{ readonly runId: string }> {
      const runId = randomUUID();
      const admit = async (expectedRevision: number, command: unknown) =>
        expectAdmission(
          await uowA.runJarvisAdmission(
            userEnvelope({
              ownerUserId,
              runId,
              expectedRevision,
              actionId: CUSTOMER_CONTACT_UPDATE_ACTION_ID,
              command,
            }),
            TEST_ONLY_ADMISSION_DEPS,
          ),
          'admitted',
        );
      await admit(0, {
        type: 'start_run',
        intent: { mode: 'update', target: { customerId, revision: 1 } },
      });
      await admit(1, {
        type: 'record_customer_resolution',
        resolution: { kind: 'target_verified', customerId },
      });
      const confirmationId = randomUUID();
      await admit(2, {
        type: 'stage_proposal',
        proposalId: randomUUID(),
        confirmationId,
        fieldsDigest: sha256Hex('jarvis-u1m-target-lock-fields'),
        sensitiveDigest: sha256Hex('jarvis-u1m-target-lock-sensitive'),
        targetRevision: 1,
      });
      await admit(3, {
        type: 'record_presentation_ack',
        confirmationId,
        ack: 'screen_ack',
      });
      return { runId };
    }

    async function waitForRuntimeLockWait(
      blockerPid: number,
      sourceFragment: 'FROM public.customers' | 'FROM public.jarvis_work_items',
    ): Promise<{ readonly pid: number; readonly observedAt: Date } | null> {
      for (let attempt = 0; attempt < 150; attempt += 1) {
        // Même rôle runtime que l'admission bloquée : PostgreSQL ne révèle le texte complet
        // d'une requête d'un autre rôle qu'à un membre de pg_read_all_stats/superuser.
        const rows = await workerA.$queryRaw<Array<{ pid: number; observedAt: Date }>>`
          SELECT activity.pid::int AS "pid", clock_timestamp() AS "observedAt"
            FROM pg_catalog.pg_stat_activity AS activity
           WHERE activity.datname = current_database()
             AND ${blockerPid}::int = ANY(pg_catalog.pg_blocking_pids(activity.pid))
             AND position(${sourceFragment} IN activity.query) > 0
             AND position('FOR UPDATE' IN activity.query) > 0
           ORDER BY activity.pid
           LIMIT 1
        `;
        if (rows[0] !== undefined) return rows[0];
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return null;
    }

    function confirmCommand(confirmationId: string, proposalHash: string): unknown {
      // U1-e §2 : trois clés — la cible relue vient de l'admission, jamais du wire.
      return { type: 'confirm', confirmationId, proposalHash };
    }

    /** Version de définition que le REGISTRE du processus ne connaît pas (§5.5). */
    const UNKNOWN_DEFINITION_VERSION = 999;

    /**
     * §5.5 — le schéma sait TOUJOURS au moins ce que les lignes portent : en production,
     * une version neuve n'existe en base QUE si sa migration l'a ouverte (protocol_check),
     * et c'est le CODE qui peut revenir en arrière (rollback API, jamais du schéma). Le
     * harnais rejoue exactement cela : la « migration N+1 » ouvre la version 999 côté SQL
     * (bras additionnel du CHECK, relu depuis la base — jamais une copie du texte), puis
     * le registre gelé du processus, lui, l'ignore. Idempotent.
     */
    async function openProtocolGateForUnknownVersion(): Promise<void> {
      const rows = await admin.$queryRaw<Array<{ definition: string }>>`
        SELECT pg_get_constraintdef(oid) AS "definition"
          FROM pg_catalog.pg_constraint
         WHERE conname = 'agent_missions_protocol_check'
           AND conrelid = 'public.agent_missions'::regclass
      `;
      const current = rows[0]?.definition;
      if (current === undefined) {
        throw new Error('Jarvis U1-c: contrainte agent_missions_protocol_check introuvable.');
      }
      if (current.includes(String(UNKNOWN_DEFINITION_VERSION))) return;
      // Le VALIDATE U1-c a déjà pu absorber le suffixe NOT VALID : les deux formes sont admises.
      const parsed = /^CHECK\s*\((.*)\)(?:\s*NOT VALID)?$/su.exec(current);
      if (parsed?.[1] === undefined) {
        throw new Error(`Jarvis U1-c: forme de contrainte inattendue: ${current}`);
      }
      const amended = `(${parsed[1]}) OR ("kind" = 'customer_contact' AND "definitionVersion" = ${UNKNOWN_DEFINITION_VERSION} AND "protocolVersion" = ${UNKNOWN_DEFINITION_VERSION})`;
      await deployer.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE bob_schema_owner');
        await tx.$executeRawUnsafe(
          'ALTER TABLE public.agent_missions DROP CONSTRAINT agent_missions_protocol_check',
        );
        // Ré-ajout VALIDÉ (bras additif : toutes les lignes existantes le satisfont déjà).
        await tx.$executeRawUnsafe(
          `ALTER TABLE public.agent_missions ADD CONSTRAINT agent_missions_protocol_check CHECK (${amended})`,
        );
      });
    }

    /**
     * Épingle le run commité sur la version 999 (chirurgie d'auditeur, triggers USER
     * suspendus LE TEMPS de l'UPDATE sous ACCESS EXCLUSIVE — réarmés avant commit).
     * C'est la seule écriture du scénario qui ne passe pas par le port : elle fabrique
     * l'état de départ (version skew), jamais l'état prouvé.
     */
    async function pinRunOnUnknownVersion(ownerUserId: string, runId: string): Promise<void> {
      await deployer.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE bob_schema_owner');
        await tx.$executeRaw`
          SELECT set_config('app.current_company_id', ${companyId}, true)
        `;
        await tx.$executeRaw`
          SELECT set_config('app.current_user_id', ${ownerUserId}, true)
        `;
        await tx.$executeRaw`
          SELECT set_config('app.current_agent_mission_id', ${runId}, true)
        `;
        await tx.$executeRawUnsafe('ALTER TABLE public.agent_missions DISABLE TRIGGER USER');
        const updated = await tx.$executeRaw`
          UPDATE public.agent_missions
             SET "definitionVersion" = ${UNKNOWN_DEFINITION_VERSION},
                 "protocolVersion" = ${UNKNOWN_DEFINITION_VERSION}
           WHERE "id" = ${runId}::uuid
             AND "companyId" = ${companyId}
        `;
        if (updated !== 1) {
          throw new Error('Jarvis U1-c: épinglage version inconnue raté.');
        }
        await tx.$executeRawUnsafe('ALTER TABLE public.agent_missions ENABLE TRIGGER USER');
      });
    }

    async function auditWorkItemSignal(
      workItemId: string,
    ): Promise<{ readonly resultDigest: string | null; readonly signalAppliedAt: Date | null }> {
      const rows = await admin.$queryRaw<
        Array<{ resultDigest: string | null; signalAppliedAt: Date | null }>
      >`
        SELECT "resultDigest", "signalAppliedAt"
          FROM public.jarvis_work_items
         WHERE "id" = ${workItemId}::uuid
      `;
      const row = rows[0];
      if (row === undefined) throw new Error(`Jarvis U1-c: work item introuvable ${workItemId}`);
      return row;
    }

    beforeAll(async () => {
      if (!DISPOSABLE) {
        throw new Error(
          'AGENT_MISSION_CERT_DATABASE_IS_DISPOSABLE=true est obligatoire : le journal est immuable.',
        );
      }
      if (runtimeUrl === '' || directUrl === '' || certAdminUrl === '') {
        throw new Error(
          'DATABASE_URL runtime, DIRECT_URL deployer et AGENT_MISSION_CERT_ADMIN_URL sont requis.',
        );
      }
      admin = new PrismaClient({ datasourceUrl: certAdminUrl, errorFormat: 'minimal' });
      deployer = new PrismaClient({ datasourceUrl: directUrl, errorFormat: 'minimal' });
      // Deux connexions runtime distinctes : la course CAS (preuve 4) oppose deux
      // vraies transactions concurrentes, jamais un aller-retour séquentiel.
      workerA = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
      workerB = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
      uowA = new PrismaAgentMissionUnitOfWork(workerA);
      uowB = new PrismaAgentMissionUnitOfWork(workerB);
      await Promise.all([
        admin.$connect(),
        deployer.$connect(),
        workerA.$connect(),
        workerB.$connect(),
      ]);
      await admin.$executeRaw`
        INSERT INTO public.companies (
          "id", "name", "legalForm", "siren", "siret", "trade", "vatRegime",
          "addrLine1", "addrZip", "addrCity"
        ) VALUES (
          ${companyId}, ${'Jarvis admission cert 5'}, ${'EI'},
          ${'903000005'}, ${'90300000500005'},
          ${'certification'}, ${'reel_normal'},
          ${'1 rue du Test'}, ${'75001'}, ${'Paris'}
        )
      `;
    }, 30_000);

    afterAll(async () => {
      await Promise.all([
        admin?.$disconnect(),
        deployer?.$disconnect(),
        workerA?.$disconnect(),
        workerB?.$disconnect(),
      ]);
    });

    it(
      'manifest runtime vide — action specified refusée, zéro run/event/work item',
      async () => {
        const ownerUserId = freshOwner();
        const runId = randomUUID();
        const envelope = userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 0,
          command: START_CREATE,
        });

        const result = await uowA.runJarvisAdmission(envelope, {
          ...TEST_ONLY_ADMISSION_DEPS,
          actionReleasePolicy: CLOSED_JARVIS_ACTION_RELEASE_POLICY,
        });

        expect(result).toEqual({ status: 'action_refused', reason: 'action_not_released' });
        await expect(auditRun(runId)).resolves.toBeNull();
        await expect(commandEventCount(envelope.commandId)).resolves.toBe(0);
        await expect(auditWorkItems(runId)).resolves.toHaveLength(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'action annoncée publiée mais seed update réel — binding serveur refuse sans écrire',
      async () => {
        const ownerUserId = freshOwner();
        const runId = randomUUID();
        const envelope = userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 0,
          // L'enveloppe annonce implicitement client-creer@1, mais le seed réel est update.
          command: {
            type: 'start_run',
            intent: {
              mode: 'update',
              target: { customerId: `customer-${randomUUID()}`, revision: 1 },
            },
          },
        });
        const publishedCreateOnly = {
          isPublished: (ref: { readonly actionId: string }) => ref.actionId === 'client-creer',
        };

        const result = await uowA.runJarvisAdmission(envelope, {
          ...TEST_ONLY_ADMISSION_DEPS,
          actionReleasePolicy: publishedCreateOnly,
        });

        expect(result).toEqual({ status: 'action_refused', reason: 'action_binding_mismatch' });
        await expect(auditRun(runId)).resolves.toBeNull();
        await expect(commandEventCount(envelope.commandId)).resolves.toBe(0);
        await expect(auditWorkItems(runId)).resolves.toHaveLength(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'fermeture runtime — cancel_run reste admis pour drainer sans créer d’effet',
      async () => {
        const ownerUserId = freshOwner();
        const { runId } = await seedRun(ownerUserId);

        const cancelled = await uowA.runJarvisAdmission(
          userEnvelope({
            ownerUserId,
            runId,
            expectedRevision: 1,
            command: { type: 'cancel_run', reason: 'manual_handoff' },
          }),
          {
            ...TEST_ONLY_ADMISSION_DEPS,
            admissionEnabled: false,
            actionReleasePolicy: {
              isPublished: () => {
                throw new Error('policy_ne_doit_pas_etre_appelee_pour_cancel');
              },
            },
          },
        );

        expectAdmission(cancelled, 'admitted');
        const run = await requireRun(runId);
        expect(run.status).toBe('cancelled');
        expect(run.terminalAt).not.toBeNull();
        await expect(auditWorkItems(runId)).resolves.toHaveLength(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 1 — seed admis : run revision 1, événement sequence 1, phase = state.phase',
      async () => {
        const ownerUserId = freshOwner();
        const { runId, envelope } = await seedRun(ownerUserId);

        const run = await requireRun(runId);
        expect(run.kind).toBe('customer_contact');
        expect(run.status).toBe('active');
        expect(run.revision).toBe(1);
        expect(run.definitionVersion).toBe(1);
        expect(run.protocolVersion).toBe(1);
        expect(run.payloadVersion).toBe(1);
        expect(statePhaseOf(run)).toBe('resolving_customer');
        // Contrat SQL de la tranche : la colonne phase est LE miroir du state.
        expect(run.phase).toBe(statePhaseOf(run));

        const events = await auditEvents(runId);
        expect(events).toHaveLength(1);
        expect(events[0]?.sequence).toBe(1);
        expect(events[0]?.eventType).toBe('cc_run_started');
        expect(events[0]?.actor).toBe('user_tap');
        expect(events[0]?.commandId).toBe(envelope.commandId);
        expect(events[0]?.missionRevisionBefore).toBe(0);
        expect(events[0]?.missionRevisionAfter).toBe(1);
        await expect(auditWorkItems(runId)).resolves.toHaveLength(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'run create existant mais enveloppe update — binding serveur refuse sans mutation',
      async () => {
        const ownerUserId = freshOwner();
        const { runId } = await seedRun(ownerUserId);
        const before = await requireRun(runId);
        const beforeEvents = await auditEvents(runId);

        const mismatched = await uowA.runJarvisAdmission(
          userEnvelope({
            ownerUserId,
            runId,
            expectedRevision: before.revision,
            actionId: 'client-modifier',
            command: {
              type: 'record_customer_resolution',
              resolution: { kind: 'no_duplicates' },
            },
          }),
          TEST_ONLY_ADMISSION_DEPS,
        );

        expect(mismatched).toEqual({
          status: 'action_refused',
          reason: 'action_binding_mismatch',
        });
        expect(await requireRun(runId)).toEqual(before);
        expect(await auditEvents(runId)).toEqual(beforeEvents);
        await expect(auditWorkItems(runId)).resolves.toHaveLength(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 2 — replay même commandId + même enveloppe : replayed, zéro nouvelle ligne',
      async () => {
        const ownerUserId = freshOwner();
        const { runId, envelope } = await seedRun(ownerUserId);

        const replayed = expectAdmission(
          await uowA.runJarvisAdmission(envelope, {
            ...TEST_ONLY_ADMISSION_DEPS,
            admissionEnabled: false,
            actionReleasePolicy: {
              isPublished: () => {
                throw new Error('policy_ne_doit_pas_etre_appelee_pour_replay');
              },
            },
          }),
          'replayed',
        );
        expect(replayed.eventSequence).toBe(1);
        expect(replayed.signalRestamped).toBe(false);
        expect(replayed.postimage.revision).toBe(1);
        expect(replayed.postimage.runId).toBe(runId);

        const run = await requireRun(runId);
        expect(run.revision).toBe(1);
        await expect(auditEvents(runId)).resolves.toHaveLength(1);
        await expect(commandEventCount(envelope.commandId)).resolves.toBe(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'replay déjà commité — fermeture admission+manifest rend le reçu, jamais un faux refus',
      async () => {
        const ownerUserId = freshOwner();
        const { runId, envelope } = await seedRun(ownerUserId);

        const replayed = await uowA.runJarvisAdmission(envelope, {
          ...TEST_ONLY_ADMISSION_DEPS,
          admissionEnabled: false,
          actionReleasePolicy: CLOSED_JARVIS_ACTION_RELEASE_POLICY,
        });

        expectAdmission(replayed, 'replayed');
        const run = await requireRun(runId);
        expect(run.revision).toBe(1);
        await expect(auditEvents(runId)).resolves.toHaveLength(1);
        await expect(commandEventCount(envelope.commandId)).resolves.toBe(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 3 — même commandId, canonicalInputDigest divergent : command_conflict, zéro write',
      async () => {
        const ownerUserId = freshOwner();
        const { runId, envelope } = await seedRun(ownerUserId);

        const conflicting = userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 0,
          command: START_CREATE,
          commandId: envelope.commandId,
          canonicalInputDigest: sha256Hex('jarvis-u1c-adm-input-divergent'),
        });
        expectAdmission(await uowA.runJarvisAdmission(conflicting, TEST_ONLY_ADMISSION_DEPS), 'command_conflict');

        const run = await requireRun(runId);
        expect(run.revision).toBe(1);
        await expect(auditEvents(runId)).resolves.toHaveLength(1);
        await expect(commandEventCount(envelope.commandId)).resolves.toBe(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 4 — deux admissions concurrentes même run même expectedRevision : une seule gagne',
      async () => {
        const ownerUserId = freshOwner();
        const { runId } = await seedRun(ownerUserId);

        const cancelCommand = { type: 'cancel_run', reason: 'user_cancelled' } as const;
        const envelopeA = userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 1,
          command: cancelCommand,
        });
        const envelopeB = userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 1,
          command: cancelCommand,
        });
        const [resultA, resultB] = await Promise.all([
          uowA.runJarvisAdmission(envelopeA, TEST_ONLY_ADMISSION_DEPS),
          uowB.runJarvisAdmission(envelopeB, TEST_ONLY_ADMISSION_DEPS),
        ]);

        const results = [resultA, resultB];
        const winner = results.find((result) => result.status === 'admitted');
        const loser = results.find((result) => result.status !== 'admitted');
        expect(winner?.status).toBe('admitted');
        expect(['stale_revision', 'command_conflict']).toContain(loser?.status);
        if (loser?.status === 'stale_revision') {
          expect(loser.actualRevision).toBe(2);
        }

        const run = await requireRun(runId);
        expect(run.revision).toBe(2);
        expect(run.status).toBe('cancelled');
        // Exactement UN événement pour la course : le perdant n'a jamais écrit.
        await expect(auditEvents(runId)).resolves.toHaveLength(2);
        const racedWrites =
          (await commandEventCount(envelopeA.commandId)) +
          (await commandEventCount(envelopeB.commandId));
        expect(racedWrites).toBe(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 5 — portée de reçu PAR RUN : conflit inter-runs et index run_command_key violé',
      async () => {
        const ownerUserId = freshOwner();
        const { runId, envelope } = await seedRun(ownerUserId);

        // Même commandId re-présenté pour un AUTRE run du même owner : refus typé, zéro write.
        const otherRunId = randomUUID();
        const stolen = userEnvelope({
          ownerUserId,
          runId: otherRunId,
          expectedRevision: 0,
          command: START_CREATE,
          commandId: envelope.commandId,
        });
        expectAdmission(await uowA.runJarvisAdmission(stolen, TEST_ONLY_ADMISSION_DEPS), 'command_conflict');
        await expect(auditRun(otherRunId)).resolves.toBeNull();
        await expect(commandEventCount(envelope.commandId)).resolves.toBe(1);

        // L'index lui-même, prouvé par violation : insert brut d'un second événement
        // (companyId, missionId, commandId) identiques. Le garde d'append v3 exigerait le
        // CAS du run d'abord et l'unique owner-scope masquerait l'index run-scope — la
        // transaction (condamnée) suspend donc les triggers USER et spoofe l'owner pour
        // que SEUL agent_mission_events_run_command_key puisse refuser. ROLLBACK réarme tout.
        interface RawEventCopyRow {
          readonly eventType: string;
          readonly eventVersion: number;
          readonly actor: string;
          readonly commandId: string;
          readonly requestFingerprintHmac: string;
          readonly fingerprintKeyVersion: number;
          readonly fingerprintCanonicalizationVersion: number;
          readonly data: unknown;
          readonly occurredAt: Date;
          readonly retentionExpiresAt: Date;
        }
        const copies = await admin.$queryRaw<RawEventCopyRow[]>`
          SELECT "eventType", "eventVersion", "actor", "commandId",
                 "requestFingerprintHmac", "fingerprintKeyVersion",
                 "fingerprintCanonicalizationVersion", "data", "occurredAt",
                 "retentionExpiresAt"
            FROM public.agent_mission_events
           WHERE "companyId" = ${companyId}
             AND "missionId" = ${runId}::uuid
             AND "sequence" = 1
        `;
        const copy = copies[0];
        if (copy === undefined) throw new Error('Jarvis U1-c: événement seed introuvable.');
        const spoofedOwner = `${ownerUserId}-spoof`;
        // Le formatage `minimal` de Prisma avale le nom de l'index sur un 23505 : le
        // diagnostic vient donc de LA BASE elle-même (GET STACKED DIAGNOSTICS), re-levé
        // dans un message que rien ne réécrit. Valeurs inline : toutes générées par le
        // harnais (uuids/digests) ou relues d'une ligne commitée du run.
        const rawAppendProbe = `
          DO $jarvis_u1c_probe$
          DECLARE
            violated_constraint TEXT;
            violated_sqlstate TEXT;
          BEGIN
            INSERT INTO public.agent_mission_events (
              "id", "companyId", "ownerUserId", "missionId", "sequence",
              "eventType", "eventVersion", "actor", "commandId",
              "requestFingerprintHmac", "fingerprintKeyVersion",
              "fingerprintCanonicalizationVersion",
              "missionRevisionBefore", "missionRevisionAfter",
              "data", "occurredAt", "retentionExpiresAt"
            ) VALUES (
              '${randomUUID()}'::uuid, '${companyId}', '${spoofedOwner}',
              '${runId}'::uuid, 987,
              '${copy.eventType}', ${copy.eventVersion}, '${copy.actor}',
              '${copy.commandId}'::uuid,
              '${copy.requestFingerprintHmac}', ${copy.fingerprintKeyVersion},
              ${copy.fingerprintCanonicalizationVersion},
              986, 987,
              $jarvis_u1c_data$${JSON.stringify(copy.data)}$jarvis_u1c_data$::jsonb,
              '${copy.occurredAt.toISOString()}'::timestamptz,
              '${copy.retentionExpiresAt.toISOString()}'::timestamptz
            );
            RAISE EXCEPTION 'JARVIS_U1C_RUN_COMMAND_KEY_NOT_ENFORCED';
          EXCEPTION
            WHEN unique_violation THEN
              GET STACKED DIAGNOSTICS
                violated_constraint = CONSTRAINT_NAME,
                violated_sqlstate = RETURNED_SQLSTATE;
              RAISE EXCEPTION 'JARVIS_U1C_RAW_APPEND sqlstate=% constraint=%',
                violated_sqlstate, violated_constraint;
          END
          $jarvis_u1c_probe$;
        `;
        await expect(
          deployer.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('SET LOCAL ROLE bob_schema_owner');
            await tx.$executeRaw`
              SELECT set_config('app.current_company_id', ${companyId}, true)
            `;
            await tx.$executeRaw`
              SELECT set_config('app.current_user_id', ${spoofedOwner}, true)
            `;
            await tx.$executeRaw`
              SELECT set_config('app.current_agent_mission_id', ${runId}, true)
            `;
            await tx.$executeRawUnsafe(
              'ALTER TABLE public.agent_mission_events DISABLE TRIGGER USER',
            );
            await tx.$executeRawUnsafe(rawAppendProbe);
          }),
        ).rejects.toSatisfy((error: unknown) => {
          const text = pgErrorText(error);
          return (
            text.includes('sqlstate=23505') &&
            text.includes('constraint=agent_mission_events_run_command_key')
          );
        });

        // Le rollback est complet : ni la ligne brute, ni aucune autre écriture.
        await expect(auditEvents(runId)).resolves.toHaveLength(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 6 — backstop élargi : waiting_user tient le premier plan, le cancel le libère',
      async () => {
        const ownerUserId = freshOwner();
        const { runId } = await seedRun(ownerUserId);

        // Le run passe waiting_user (§5.1 non-libérant) : candidats doublons à trancher.
        const review = userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 1,
          command: {
            type: 'record_customer_resolution',
            resolution: {
              kind: 'duplicate_candidates',
              reviewId: randomUUID(),
              candidates: [
                {
                  choiceId: randomUUID(),
                  customerId: 'client-existant-1',
                  matchDigest: sha256Hex('jarvis-u1c-adm-match-1'),
                },
                {
                  choiceId: randomUUID(),
                  customerId: 'client-existant-2',
                  matchDigest: sha256Hex('jarvis-u1c-adm-match-2'),
                },
              ],
            },
          },
        });
        expectAdmission(await uowA.runJarvisAdmission(review, TEST_ONLY_ADMISSION_DEPS), 'admitted');
        const waiting = await requireRun(runId);
        expect(waiting.status).toBe('waiting_user');
        expect(waiting.phase).toBe('awaiting_duplicate_review');

        // Seed d'un SECOND run pour le même owner : le backstop SQL élargi refuse.
        const secondRunId = randomUUID();
        const secondSeed = userEnvelope({
          ownerUserId,
          runId: secondRunId,
          expectedRevision: 0,
          command: START_CREATE,
        });
        expectAdmission(await uowA.runJarvisAdmission(secondSeed, TEST_ONLY_ADMISSION_DEPS), 'foreground_busy');
        await expect(auditRun(secondRunId)).resolves.toBeNull();
        await expect(commandEventCount(secondSeed.commandId)).resolves.toBe(0);

        // cancel_run par l'admission : le premier plan est libéré dans la même vérité SQL.
        const cancel = userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 2,
          command: { type: 'cancel_run', reason: 'user_cancelled' },
        });
        expectAdmission(await uowA.runJarvisAdmission(cancel, TEST_ONLY_ADMISSION_DEPS), 'admitted');
        const cancelled = await requireRun(runId);
        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.terminalAt).not.toBeNull();

        // La MÊME enveloppe de seed passe désormais — le refus n'a rien persisté.
        expectAdmission(await uowA.runJarvisAdmission(secondSeed, TEST_ONLY_ADMISSION_DEPS), 'admitted');
        const second = await requireRun(secondRunId);
        expect(second.revision).toBe(1);
        expect(second.status).toBe('active');
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 7 — crash simulé au milieu de la transaction : zéro ligne pour ce commandId',
      async () => {
        const ownerUserId = freshOwner();
        const { runId } = await seedRun(ownerUserId);

        // Connexion dédiée : c'est ELLE qui meurt, jamais les workers des autres preuves.
        const crashWorker = new PrismaService({
          datasourceUrl: runtimeUrl,
          errorFormat: 'minimal',
        });
        await crashWorker.$connect();
        const crashUow = new PrismaAgentMissionUnitOfWork(crashWorker);
        try {
          // Le harnais bloque le run FOR UPDATE : l'admission s'arrête au milieu de SA
          // transaction (reçu déjà lu, CAS pas encore écrit).
          const blockerGate = deferred<void>();
          const blockerAcquired = deferred<number>();
          const blocker = deployer.$transaction(
            async (tx) => {
              await tx.$executeRawUnsafe('SET LOCAL ROLE bob_schema_owner');
              await tx.$executeRaw`
                SELECT set_config('app.current_company_id', ${companyId}, true)
              `;
              await tx.$executeRaw`
                SELECT set_config('app.current_user_id', ${ownerUserId}, true)
              `;
              await tx.$executeRaw`
                SELECT set_config('app.current_agent_mission_id', ${runId}, true)
              `;
              const locked = await tx.$queryRaw<Array<{ id: string }>>`
                SELECT "id" FROM public.agent_missions
                 WHERE "id" = ${runId}::uuid
                 FOR UPDATE
              `;
              blockerAcquired.resolve(locked.length);
              await blockerGate.promise;
            },
            { maxWait: 10_000, timeout: 55_000 },
          );
          const lockedRows = await blockerAcquired.promise;
          if (lockedRows !== 1) {
            blockerGate.resolve();
            await blocker;
            throw new Error('Jarvis U1-c: le harnais n’a pas verrouillé le run à bloquer.');
          }

          const envelope = userEnvelope({
            ownerUserId,
            runId,
            expectedRevision: 1,
            command: { type: 'cancel_run', reason: 'user_cancelled' },
          });
          const crashing = crashUow.runJarvisAdmission(envelope, TEST_ONLY_ADMISSION_DEPS);

          // Déconnexion forcée du worker : pg_terminate_backend depuis une connexion du
          // MÊME rôle (droit natif). Si la fenêtre est manquée, le lock_timeout local de
          // 5 s de l'admission interrompt la transaction — dans les deux cas, crash avant
          // commit.
          const deadline = Date.now() + 4_000;
          while (Date.now() < deadline) {
            const waiting = await workerB.$queryRaw<Array<{ pid: number }>>`
              SELECT pid FROM pg_stat_activity
               WHERE state = 'active'
                 AND wait_event_type = 'Lock'
                 AND query LIKE '%agent_missions%'
                 AND query LIKE '%FOR UPDATE%'
                 AND pid <> pg_backend_pid()
            `;
            const pid = waiting[0]?.pid;
            if (pid !== undefined) {
              await workerB.$queryRaw`
                SELECT pg_terminate_backend(CAST(${pid} AS INTEGER)) AS "terminated"
              `;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          // La règle NOMMÉE du refus : la terminaison administrateur du backend
          // (pg_terminate_backend ⇒ 57P01 « terminating connection due to administrator
          // command ») ou la fermeture de connexion qu'elle provoque côté client.
          await expect(crashing).rejects.toThrow(
            /57P01|terminating connection due to administrator command|closed the connection|Connection terminated/i,
          );
          blockerGate.resolve();
          await blocker;

          // LA BASE : rien n'a survécu pour ce commandId, le run est intact.
          await expect(commandEventCount(envelope.commandId)).resolves.toBe(0);
          const run = await requireRun(runId);
          expect(run.revision).toBe(1);
          expect(run.status).toBe('active');
          await expect(auditEvents(runId)).resolves.toHaveLength(1);

          // La MÊME enveloppe rejouée sur un worker sain est ADMISE (jamais `replayed`,
          // jamais `command_conflict`) : aucun reçu partiel n'a été persisté.
          expectAdmission(await uowA.runJarvisAdmission(envelope, TEST_ONLY_ADMISSION_DEPS), 'admitted');
          const settled = await requireRun(runId);
          expect(settled.revision).toBe(2);
          expect(settled.status).toBe('cancelled');
        } finally {
          await crashWorker.$disconnect().catch(() => undefined);
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 8 — readJarvisStateless rend le run et n’écrit rien',
      async () => {
        const ownerUserId = freshOwner();
        const { runId } = await seedRun(ownerUserId);
        const eventsBefore = await auditEvents(runId);

        const read = await uowA.readJarvisStateless({ companyId, ownerUserId }, async (view) =>
          view.runById(runId),
        );
        expect(read.status).toBe('executed');
        expect(read.value?.runId).toBe(runId);
        expect(read.value?.kind).toBe('customer_contact');
        expect(read.value?.revision).toBe(1);
        expect(Number.isNaN(Date.parse(read.readAt))).toBe(false);

        const missing = await uowA.readJarvisStateless({ companyId, ownerUserId }, async (view) =>
          view.runById(randomUUID()),
        );
        expect(missing.status).toBe('executed');
        expect(missing.value).toBeNull();

        // Zéro write : ni événement ni mutation du run.
        await expect(auditEvents(runId)).resolves.toEqual(eventsBefore);
        const run = await requireRun(runId);
        expect(run.revision).toBe(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 9 — voie système §5.6 : reçu d’effet appliqué, intents sortants interdits',
      async () => {
        const ownerUserId = freshOwner();
        const { runId } = await seedRun(ownerUserId);
        const effectId = stateEffectIdOf(await requireRun(runId));

        // Le run est conduit par le VRAI port jusqu'à une confirmation présentée.
        expectAdmission(
          await uowA.runJarvisAdmission(
            userEnvelope({
              ownerUserId,
              runId,
              expectedRevision: 1,
              command: {
                type: 'record_customer_resolution',
                resolution: { kind: 'no_duplicates' },
              },
            }),
            TEST_ONLY_ADMISSION_DEPS,
          ),
          'admitted',
        );
        const proposalId = randomUUID();
        const confirmationId = randomUUID();
        const fieldsDigest = sha256Hex('jarvis-u1c-adm-fields');
        const sensitiveDigest = sha256Hex('jarvis-u1c-adm-sensitive');
        expectAdmission(
          await uowA.runJarvisAdmission(
            userEnvelope({
              ownerUserId,
              runId,
              expectedRevision: 2,
              command: {
                type: 'stage_proposal',
                proposalId,
                confirmationId,
                fieldsDigest,
                sensitiveDigest,
                targetRevision: null,
              },
            }),
            TEST_ONLY_ADMISSION_DEPS,
          ),
          'admitted',
        );
        expectAdmission(
          await uowA.runJarvisAdmission(
            userEnvelope({
              ownerUserId,
              runId,
              expectedRevision: 3,
              command: {
                type: 'record_presentation_ack',
                confirmationId,
                ack: 'screen_ack',
              },
            }),
            TEST_ONLY_ADMISSION_DEPS,
          ),
          'admitted',
        );
        const proposalHash = computeCustomerContactProposalHash({
          runId,
          proposalId,
          actionId: CUSTOMER_CONTACT_CREATE_ACTION_ID,
          fieldsDigest,
          sensitiveDigest,
          targetRevision: null,
          effectId,
        });
        const presented = await requireRun(runId);
        expect(presented.revision).toBe(4);
        const presentedProposal = (presented.payload as { proposal?: { proposalHash?: unknown } })
          .proposal;
        expect(presentedProposal?.proposalHash).toBe(proposalHash);

        // §5.6 : une commande système dont la réduction émettrait un intent est REFUSÉE.
        const confirmCommand = { type: 'confirm', confirmationId, proposalHash } as const;
        const refused = expectAdmission(
          await uowA.runJarvisSystemAdmission(
            systemEnvelope({
              ownerUserId,
              runId,
              effectId,
              expectedRevision: 4,
              command: confirmCommand,
              observationKind: 'confirm_attempt',
            }),
            TEST_ONLY_ADMISSION_DEPS,
          ),
          'refused',
        );
        expect(refused.error).toEqual({
          code: 'invalid_command',
          reason: 'system_command_emitted_intents',
        });
        // Zéro write après le refus : ni événement, ni work item, ni CAS.
        const afterRefusal = await requireRun(runId);
        expect(afterRefusal.revision).toBe(4);
        await expect(auditEvents(runId)).resolves.toHaveLength(4);
        await expect(auditWorkItems(runId)).resolves.toHaveLength(0);

        // La confirmation UTILISATEUR, elle, émet l'intent 1:1 (work item prepared).
        const confirmed = expectAdmission(
          await uowA.runJarvisAdmission(
            userEnvelope({
              ownerUserId,
              runId,
              expectedRevision: 4,
              command: confirmCommand,
            }),
            TEST_ONLY_ADMISSION_DEPS,
          ),
          'admitted',
        );
        expect(confirmed.workItemIds).toHaveLength(1);
        const workItems = await auditWorkItems(runId);
        expect(workItems).toHaveLength(1);
        expect(workItems[0]?.id).toBe(confirmed.workItemIds[0]);
        expect(workItems[0]?.effectId).toBe(effectId);
        expect(workItems[0]?.actionId).toBe(CUSTOMER_CONTACT_CREATE_ACTION_ID);
        expect(workItems[0]?.actionVersion).toBe(1);
        expect(workItems[0]?.status).toBe('prepared');
        expect(workItems[0]?.leaseFence).toBe(0n);
        expect(workItems[0]?.actingPrincipalId).toBe(ownerUserId);
        const committing = await requireRun(runId);
        expect(committing.revision).toBe(5);
        expect(committing.phase).toBe('committing');
        expect(committing.status).toBe('waiting_external');

        // record_effect_receipt par la voie système : commandId DÉTERMINISTE (v8).
        const receiptEnvelope = systemEnvelope({
          ownerUserId,
          runId,
          effectId,
          expectedRevision: 5,
          command: {
            type: 'record_effect_receipt',
            effectId,
            outcome: {
              kind: 'succeeded',
              customerId: 'client-jarvis-u1c',
              customerRevision: 1,
            },
          },
          observationKind: 'effect_receipt',
        });
        const applied = expectAdmission(
          await uowA.runJarvisSystemAdmission(receiptEnvelope, TEST_ONLY_ADMISSION_DEPS),
          'admitted',
        );
        expect(applied.eventSequence).toBe(6);
        const completed = await requireRun(runId);
        expect(completed.revision).toBe(6);
        expect(completed.status).toBe('completed');
        expect(completed.phase).toBe('completed');
        expect(completed.terminalAt).not.toBeNull();
        const events = await auditEvents(runId);
        expect(events).toHaveLength(6);
        expect(events[5]?.eventType).toBe('cc_effect_receipt_recorded');
        expect(events[5]?.actor).toBe('system');
        expect(events[5]?.commandId).toBe(receiptEnvelope.commandId);
        expect(events[5]?.commandId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
        const effectCanonicalRequest = [
          'bob.jarvis.admission.v1',
          companyId,
          ownerUserId,
          'customer_contact',
          '1',
          runId,
          receiptEnvelope.commandId,
          '5',
          'effect_receipt',
          '0',
          effectId,
          'effect_receipt',
        ].join('\u001f');
        const expectedEffectFingerprint = FINGERPRINTS.sign(effectCanonicalRequest);
        if (expectedEffectFingerprint === null) {
          throw new Error('Jarvis U1-m: fingerprint effet v1 de certification indisponible.');
        }
        expect(events[5]?.requestFingerprintHmac).toBe(expectedEffectFingerprint.hmac);

        // La même observation re-soumise dérive le MÊME commandId : replay zéro-write.
        const replayed = expectAdmission(
          await uowA.runJarvisSystemAdmission(receiptEnvelope, TEST_ONLY_ADMISSION_DEPS),
          'replayed',
        );
        expect(replayed.eventSequence).toBe(6);
        await expect(auditEvents(runId)).resolves.toHaveLength(6);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'U1-m M1 — wake prématuré exact : ignored répété, aucune version logique ni foreground muté',
      async () => {
        const ownerUserId = freshOwner();
        const { runId } = await driveRunToPresented(ownerUserId);
        const wake = await authoritativeWake(runId);
        const envelope = wakeEnvelope({
          ownerUserId,
          runId,
          wakeId: wake.wakeId,
          dueAt: wake.dueAt,
          expectedRevision: wake.revision,
        });
        const storageBefore = await auditRunStorage(runId);
        const eventsBefore = await auditEvents(runId);
        const workItemsBefore = await auditWorkItems(runId);

        await expect(
          uowA.runJarvisSystemAdmission(envelope, TEST_ONLY_ADMISSION_DEPS),
        ).resolves.toEqual({ status: 'ignored', reason: 'wake_not_due' });
        await expect(
          uowA.runJarvisSystemAdmission(envelope, TEST_ONLY_ADMISSION_DEPS),
        ).resolves.toEqual({ status: 'ignored', reason: 'wake_not_due' });
        await expect(commandEventCount(envelope.commandId)).resolves.toBe(0);

        const divergentDueAt = new Date(Date.parse(wake.dueAt) + 1_000).toISOString();
        const divergent = wakeEnvelope({
          ownerUserId,
          runId,
          wakeId: wake.wakeId,
          dueAt: divergentDueAt,
          expectedRevision: wake.revision,
        });
        await expect(
          uowA.runJarvisSystemAdmission(divergent, TEST_ONLY_ADMISSION_DEPS),
        ).resolves.toEqual({ status: 'system_command_binding_mismatch' });
        await expect(commandEventCount(divergent.commandId)).resolves.toBe(0);

        const commandMismatched = {
          ...envelope,
          command: { type: 'wake_run', wakeId: randomUUID() },
        } as JarvisSystemAdmissionEnvelope;
        await expect(
          uowA.runJarvisSystemAdmission(commandMismatched, TEST_ONLY_ADMISSION_DEPS),
        ).resolves.toEqual({ status: 'system_command_binding_mismatch' });
        await expect(commandEventCount(envelope.commandId)).resolves.toBe(0);

        const stale = wakeEnvelope({
          ownerUserId,
          runId,
          wakeId: wake.wakeId,
          dueAt: wake.dueAt,
          expectedRevision: wake.revision - 1,
        });
        await expect(
          uowA.runJarvisSystemAdmission(stale, TEST_ONLY_ADMISSION_DEPS),
        ).resolves.toEqual({ status: 'stale_revision', actualRevision: wake.revision });
        await expect(commandEventCount(stale.commandId)).resolves.toBe(0);

        await expect(
          uowA.runJarvisSystemAdmission(envelope, {
            ...TEST_ONLY_ADMISSION_DEPS,
            admissionEnabled: false,
          }),
        ).resolves.toEqual({ status: 'action_refused', reason: 'admission_kill_switch' });

        const secondRunId = randomUUID();
        const secondSeed = userEnvelope({
          ownerUserId,
          runId: secondRunId,
          expectedRevision: 0,
          command: START_CREATE,
        });
        expectAdmission(
          await uowA.runJarvisAdmission(secondSeed, TEST_ONLY_ADMISSION_DEPS),
          'foreground_busy',
        );
        await expect(auditRun(secondRunId)).resolves.toBeNull();
        await expect(commandEventCount(secondSeed.commandId)).resolves.toBe(0);

        expect(await auditRunStorage(runId)).toEqual(storageBefore);
        expect(await auditEvents(runId)).toEqual(eventsBefore);
        expect(await auditWorkItems(runId)).toEqual(workItemsBefore);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'U1-m M1 — wake dû : R+1 exact puis replay OFF strictement zéro-write',
      async () => {
        const ownerUserId = freshOwner();
        const { runId } = await driveRunToPresented(ownerUserId);
        const dueAt = await databaseDueAtAfter(2_000);
        await pinWakeDueAt(ownerUserId, runId, dueAt);
        const wake = await authoritativeWake(runId);
        const envelope = wakeEnvelope({
          ownerUserId,
          runId,
          wakeId: wake.wakeId,
          dueAt: wake.dueAt,
          expectedRevision: wake.revision,
        });

        await expect(
          uowA.runJarvisSystemAdmission(envelope, TEST_ONLY_ADMISSION_DEPS),
        ).resolves.toEqual({ status: 'ignored', reason: 'wake_not_due' });
        await expect(commandEventCount(envelope.commandId)).resolves.toBe(0);

        await expect(
          uowA.runJarvisSystemAdmission(envelope, {
            ...TEST_ONLY_ADMISSION_DEPS,
            admissionEnabled: false,
          }),
        ).resolves.toEqual({ status: 'action_refused', reason: 'admission_kill_switch' });
        await expect(commandEventCount(envelope.commandId)).resolves.toBe(0);

        await waitUntilDatabaseDue(dueAt);
        const disguisedAsEffect = systemEnvelope({
          ownerUserId,
          runId,
          effectId: wake.wakeId,
          expectedRevision: wake.revision,
          command: { type: 'wake_run', wakeId: wake.wakeId },
          observationKind: 'effect_result',
        });
        const storageBeforeDisguised = await auditRunStorage(runId);
        const eventsBeforeDisguised = await auditEvents(runId);
        const workItemsBeforeDisguised = await auditWorkItems(runId);
        await expect(
          uowA.runJarvisSystemAdmission(disguisedAsEffect, {
            ...TEST_ONLY_ADMISSION_DEPS,
            admissionEnabled: false,
            actionReleasePolicy: CLOSED_JARVIS_ACTION_RELEASE_POLICY,
          }),
        ).resolves.toEqual({ status: 'system_command_binding_mismatch' });
        await expect(commandEventCount(disguisedAsEffect.commandId)).resolves.toBe(0);
        expect(await auditRunStorage(runId)).toEqual(storageBeforeDisguised);
        expect(await auditEvents(runId)).toEqual(eventsBeforeDisguised);
        expect(await auditWorkItems(runId)).toEqual(workItemsBeforeDisguised);

        const admitted = expectAdmission(
          await uowA.runJarvisSystemAdmission(envelope, TEST_ONLY_ADMISSION_DEPS),
          'admitted',
        );
        expect(admitted.eventSequence).toBe(5);
        expect(admitted.postimage).toMatchObject({ revision: 5, nextWakeAt: null });
        expect(admitted.workItemIds).toEqual([]);

        const run = await requireRun(runId);
        expect(run).toMatchObject({
          revision: 5,
          phase: 'preparing_proposal',
          nextWakeAt: null,
        });
        const state = parseCustomerContactState(run.payload);
        expect(state?.confirmation?.status).toBe('expired');
        expect(state?.wakes).toEqual([]);
        await expect(auditWorkItems(runId)).resolves.toEqual([]);

        const events = await auditEvents(runId);
        expect(events).toHaveLength(5);
        expect(events[4]).toMatchObject({
          sequence: 5,
          eventType: 'cc_proposal_expired',
          actor: 'system',
          commandId: envelope.commandId,
          missionRevisionBefore: 4,
          missionRevisionAfter: 5,
          fingerprintKeyVersion: 1,
          fingerprintCanonicalizationVersion: 1,
        });
        const canonicalInputDigest = sha256Hex(
          JSON.stringify(['bob.jarvis.wake-input.v1', 'wake_run', wake.wakeId]),
        );
        const canonicalRequest = [
          'bob.jarvis.admission.wake.v1',
          companyId,
          ownerUserId,
          'customer_contact',
          '1',
          runId,
          envelope.commandId,
          '4',
          wake.wakeId,
          wake.dueAt,
          canonicalInputDigest,
        ].join('\u001f');
        const expectedFingerprint = FINGERPRINTS.sign(canonicalRequest);
        if (expectedFingerprint === null) {
          throw new Error('Jarvis U1-m: fingerprint de certification indisponible.');
        }
        expect(events[4]?.requestFingerprintHmac).toBe(expectedFingerprint.hmac);

        // Sentinelle adversariale post-transition : elle ressemble volontairement à une
        // observation d'effet du même identifiant. Un replay wake ne doit jamais emprunter
        // la greffe historique qui re-stampe les work items d'effet.
        const sentinelId = await insertWakeRestampSentinel({
          ownerUserId,
          runId,
          effectId: wake.wakeId,
        });
        const sentinelBeforeReplay = await auditWorkItemStorage(sentinelId);
        expect(
          (await auditWorkItems(runId)).find((item) => item.id === sentinelId)?.signalAppliedAt,
        ).toBeNull();

        const storageAfterCommit = await auditRunStorage(runId);
        const eventsAfterCommit = await auditEvents(runId);
        const workItemsAfterCommit = await auditWorkItems(runId);
        const replayed = expectAdmission(
          await uowA.runJarvisSystemAdmission(envelope, {
            ...TEST_ONLY_ADMISSION_DEPS,
            admissionEnabled: false,
            actionReleasePolicy: CLOSED_JARVIS_ACTION_RELEASE_POLICY,
          }),
          'replayed',
        );
        expect(replayed).toMatchObject({
          eventSequence: 5,
          signalRestamped: false,
          postimage: { runId, revision: 5 },
        });
        expect(await auditRunStorage(runId)).toEqual(storageAfterCommit);
        expect(await auditEvents(runId)).toEqual(eventsAfterCommit);
        expect(await auditWorkItems(runId)).toEqual(workItemsAfterCommit);
        expect(await auditWorkItemStorage(sentinelId)).toEqual(sentinelBeforeReplay);
        await expect(commandEventCount(envelope.commandId)).resolves.toBe(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'U1-m M1 — l’horloge d’expiration est capturée après le verrou de la fiche cible',
      async () => {
        const ownerUserId = freshOwner();
        const customerId = randomUUID();
        await admin.$executeRaw`
          INSERT INTO public.customers (
            "id", "companyId", "type", "name", "addrLine1", "addrZip", "addrCity"
          ) VALUES (
            ${customerId}, ${companyId}, 'b2c', ${'Cible U1-m'},
            ${'1 rue du Verrou'}, ${'75001'}, ${'Paris'}
          )
        `;
        const { runId } = await driveUpdateRunToPresented(ownerUserId, customerId);
        const dueAt = await databaseDueAtAfter(3_000);
        await pinWakeDueAt(ownerUserId, runId, dueAt);
        const wake = await authoritativeWake(runId);
        const envelope = wakeEnvelope({
          ownerUserId,
          runId,
          wakeId: wake.wakeId,
          dueAt: wake.dueAt,
          expectedRevision: wake.revision,
        });
        const blockerReady = deferred<
          | { readonly ok: true; readonly pid: number }
          | { readonly ok: false; readonly error: unknown }
        >();
        const releaseBlocker = deferred<void>();
        const blocker = deployer
          .$transaction(
            async (tx) => {
              await tx.$executeRawUnsafe('SET LOCAL ROLE bob_schema_owner');
              await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
              await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ownerUserId}, true)`;
              await tx.$executeRaw`SELECT set_config('app.current_agent_mission_id', ${runId}, true)`;
              const locked = await tx.$queryRaw<Array<{ pid: number }>>`
                SELECT pg_backend_pid()::int AS "pid"
                  FROM public.customers
                 WHERE "id" = ${customerId}
                   AND "companyId" = ${companyId}
                 FOR UPDATE
              `;
              const pid = locked[0]?.pid ?? -1;
              if (pid < 0) throw new Error('Jarvis U1-m: cible à verrouiller introuvable.');
              blockerReady.resolve({ ok: true, pid });
              await releaseBlocker.promise;
              const marker = await tx.$queryRaw<Array<{ releasedAt: Date }>>`
                SELECT clock_timestamp() AS "releasedAt"
              `;
              const releasedAt = marker[0]?.releasedAt;
              if (releasedAt === undefined) {
                throw new Error('Jarvis U1-m: horloge de libération indisponible.');
              }
              return releasedAt;
            },
            { maxWait: 10_000, timeout: 12_000 },
          )
          .catch((error: unknown) => {
            blockerReady.resolve({ ok: false, error });
            throw error;
          });
        const readiness = await blockerReady.promise;
        if (!readiness.ok) {
          await Promise.allSettled([blocker]);
          throw readiness.error;
        }
        const blockerPid = readiness.pid;

        const admission = uowB.runJarvisSystemAdmission(envelope, TEST_ONLY_ADMISSION_DEPS);
        const waiting = await waitForRuntimeLockWait(blockerPid, 'FROM public.customers');
        if (waiting === null || waiting.observedAt.toISOString() >= dueAt) {
          releaseBlocker.resolve();
          await Promise.allSettled([blocker, admission]);
          throw new Error('Jarvis U1-m: attente cible pré-échéance non observée.');
        }
        await waitUntilDatabaseDue(dueAt);
        releaseBlocker.resolve();
        const [releasedAt, result] = await Promise.all([blocker, admission]);

        const admitted = expectAdmission(result, 'admitted');
        expect(admitted.eventSequence).toBe(5);
        expect(admitted.postimage).toMatchObject({ revision: 5, nextWakeAt: null });
        expect(admitted.workItemIds).toEqual([]);
        const events = await auditEvents(runId);
        expect(events).toHaveLength(5);
        const expiration = events[4];
        expect(expiration).toMatchObject({
          eventType: 'cc_proposal_expired',
          actor: 'system',
          missionRevisionBefore: 4,
          missionRevisionAfter: 5,
        });
        expect(expiration?.occurredAt.getTime()).toBeGreaterThanOrEqual(Date.parse(dueAt));
        expect(expiration?.occurredAt.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime());
        await expect(requireRun(runId)).resolves.toMatchObject({ revision: 5, nextWakeAt: null });
        await expect(auditWorkItems(runId)).resolves.toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'U1-m M1 — l’horloge d’expiration est capturée après le dernier verrou work item',
      async () => {
        const ownerUserId = freshOwner();
        const { runId } = await driveRunToPresented(ownerUserId);
        const sentinelId = await insertWakeRestampSentinel({
          ownerUserId,
          runId,
          effectId: randomUUID(),
        });
        const sentinelBefore = await auditWorkItemStorage(sentinelId);
        const dueAt = await databaseDueAtAfter(3_000);
        await pinWakeDueAt(ownerUserId, runId, dueAt);
        const wake = await authoritativeWake(runId);
        const envelope = wakeEnvelope({
          ownerUserId,
          runId,
          wakeId: wake.wakeId,
          dueAt: wake.dueAt,
          expectedRevision: wake.revision,
        });
        const blockerReady = deferred<
          | { readonly ok: true; readonly pid: number }
          | { readonly ok: false; readonly error: unknown }
        >();
        const releaseBlocker = deferred<void>();
        const blocker = admin
          .$transaction(
            async (tx) => {
              const locked = await tx.$queryRaw<Array<{ pid: number }>>`
                SELECT pg_backend_pid()::int AS "pid"
                  FROM public.jarvis_work_items
                 WHERE "id" = ${sentinelId}::uuid
                 FOR UPDATE
              `;
              const pid = locked[0]?.pid ?? -1;
              if (pid < 0) throw new Error('Jarvis U1-m: work item à verrouiller introuvable.');
              blockerReady.resolve({ ok: true, pid });
              await releaseBlocker.promise;
              const marker = await tx.$queryRaw<Array<{ releasedAt: Date }>>`
                SELECT clock_timestamp() AS "releasedAt"
              `;
              const releasedAt = marker[0]?.releasedAt;
              if (releasedAt === undefined) {
                throw new Error('Jarvis U1-m: horloge de libération work item indisponible.');
              }
              return releasedAt;
            },
            { maxWait: 10_000, timeout: 12_000 },
          )
          .catch((error: unknown) => {
            blockerReady.resolve({ ok: false, error });
            throw error;
          });
        const readiness = await blockerReady.promise;
        if (!readiness.ok) {
          await Promise.allSettled([blocker]);
          throw readiness.error;
        }

        const admission = uowB.runJarvisSystemAdmission(envelope, TEST_ONLY_ADMISSION_DEPS);
        const waiting = await waitForRuntimeLockWait(
          readiness.pid,
          'FROM public.jarvis_work_items',
        );
        if (waiting === null || waiting.observedAt.toISOString() >= dueAt) {
          releaseBlocker.resolve();
          await Promise.allSettled([blocker, admission]);
          throw new Error('Jarvis U1-m: attente work item pré-échéance non observée.');
        }
        await waitUntilDatabaseDue(dueAt);
        releaseBlocker.resolve();
        const [releasedAt, result] = await Promise.all([blocker, admission]);

        const admitted = expectAdmission(result, 'admitted');
        expect(admitted.eventSequence).toBe(5);
        expect(admitted.postimage).toMatchObject({ revision: 5, nextWakeAt: null });
        const events = await auditEvents(runId);
        expect(events).toHaveLength(5);
        const expiration = events[4];
        expect(expiration).toMatchObject({
          eventType: 'cc_proposal_expired',
          actor: 'system',
          missionRevisionBefore: 4,
          missionRevisionAfter: 5,
        });
        expect(expiration?.occurredAt.getTime()).toBeGreaterThanOrEqual(Date.parse(dueAt));
        expect(expiration?.occurredAt.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime());
        expect(await auditWorkItemStorage(sentinelId)).toEqual(sentinelBefore);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 10 — quarantaine §5.5 : version inconnue du registre => run gelé, transition complète, zéro effet',
      async () => {
        const ownerUserId = freshOwner();
        const { runId, confirmationId, proposalHash } = await driveRunToPresented(ownerUserId);
        const presented = await requireRun(runId);
        expect(presented.revision).toBe(4);

        // Version skew §5.5 : la « migration N+1 » ouvre la version 999 côté SQL, le
        // registre du processus (gelé U1-b) l'ignore — rollback de code, jamais de schéma.
        await openProtocolGateForUnknownVersion();
        await pinRunOnUnknownVersion(ownerUserId, runId);

        // La version inconnue ne contourne jamais le kill switch. Fermé, le runtime refuse
        // avant toute transition ; rouvert sous le harnais test-only, il appliquera ensuite la
        // quarantaine canonique. Révision, événements et work items restent inchangés ici.
        const closedAttempt = userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 4,
          command: { type: 'confirm', confirmationId, proposalHash },
        });
        expect(
          await uowA.runJarvisAdmission(closedAttempt, {
            ...TEST_ONLY_ADMISSION_DEPS,
            admissionEnabled: false,
          }),
        ).toEqual({ status: 'action_refused', reason: 'admission_kill_switch' });
        await expect(requireRun(runId)).resolves.toMatchObject({
          revision: 4,
          status: 'waiting_user',
          phase: 'awaiting_confirmation',
        });
        await expect(auditEvents(runId)).resolves.toHaveLength(4);
        await expect(auditWorkItems(runId)).resolves.toHaveLength(0);

        // La commande qui AURAIT émis l'intent 1:1 (confirm) arrive sur le run épinglé :
        // quarantaine — jamais un comportement par défaut, jamais un work item.
        const quarantining = userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 4,
          definitionVersion: UNKNOWN_DEFINITION_VERSION,
          command: confirmCommand(confirmationId, proposalHash),
        });
        expectAdmission(await uowA.runJarvisAdmission(quarantining, TEST_ONLY_ADMISSION_DEPS), 'quarantined');

        // LA BASE : transition COMPLÈTE (gardes SQL mutation_v2 + event_required passées)
        // — revision+1, événement système `run_quarantined` sequence=revision, état
        // métier INTACT, ZÉRO work item.
        const quarantined = await requireRun(runId);
        expect(quarantined.status).toBe('quarantined');
        expect(quarantined.revision).toBe(5);
        expect(quarantined.definitionVersion).toBe(UNKNOWN_DEFINITION_VERSION);
        expect(quarantined.terminalAt).toBeNull();
        expect(quarantined.payload).toEqual(presented.payload);
        expect(quarantined.phase).toBe(presented.phase);
        const events = await auditEvents(runId);
        expect(events).toHaveLength(5);
        expect(events[4]).toMatchObject({
          sequence: 5,
          eventType: 'run_quarantined',
          // Le reçu porte le commandId de LA commande (v4 user) : le garde envelope_check
          // lie l'acteur au format du commandId — le caractère système vit dans le TYPE.
          actor: 'user_tap',
          commandId: quarantining.commandId,
          missionRevisionBefore: 4,
          missionRevisionAfter: 5,
        });
        await expect(auditWorkItems(runId)).resolves.toHaveLength(0);

        // État GELÉ (§5.5, revue) : le gel de quarantaine DOMINE — toute commande,
        // stale ou à la révision courante, est refusée run_terminal quarantined,
        // zéro write : le journal d'un run empoisonné ne grossit jamais.
        const staleCancel = userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 4,
          definitionVersion: UNKNOWN_DEFINITION_VERSION,
          command: { type: 'cancel_run', reason: 'user_cancelled' },
        });
        const frozen = expectAdmission(await uowA.runJarvisAdmission(staleCancel, TEST_ONLY_ADMISSION_DEPS), 'refused');
        expect(frozen.error).toEqual({ code: 'run_terminal', status: 'quarantined' });
        await expect(commandEventCount(staleCancel.commandId)).resolves.toBe(0);

        const mismatched = userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 5,
          command: { type: 'cancel_run', reason: 'user_cancelled' },
        });
        const refused = expectAdmission(await uowA.runJarvisAdmission(mismatched, TEST_ONLY_ADMISSION_DEPS), 'refused');
        expect(refused.error).toEqual({ code: 'run_terminal', status: 'quarantined' });
        await expect(commandEventCount(mismatched.commandId)).resolves.toBe(0);

        // Relecture finale : rien n'a bougé depuis la quarantaine.
        const settled = await requireRun(runId);
        expect(settled.status).toBe('quarantined');
        expect(settled.revision).toBe(5);
        expect(settled.payload).toEqual(presented.payload);
        await expect(auditEvents(runId)).resolves.toHaveLength(5);
        await expect(auditWorkItems(runId)).resolves.toHaveLength(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 11 — replay-qui-heal : le replay SYSTÈME re-stampe le signal, un replay USER jamais',
      async () => {
        const ownerUserId = freshOwner();
        const { runId, effectId, confirmationId, proposalHash } =
          await driveRunToPresented(ownerUserId);

        // Confirmation UTILISATEUR : l'intent 1:1 devient un work item prepared.
        const confirmEnvelope = userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 4,
          command: confirmCommand(confirmationId, proposalHash),
        });
        const confirmed = expectAdmission(
          await uowA.runJarvisAdmission(confirmEnvelope, TEST_ONLY_ADMISSION_DEPS),
          'admitted',
        );
        expect(confirmed.workItemIds).toHaveLength(1);
        const workItemId = confirmed.workItemIds[0] ?? '';

        // Le VRAI writer §5.3 (repository, jamais un UPDATE d'auditeur) : claim →
        // authorize → résultat persisté. Le worker « crashe » AVANT markSignalApplied —
        // exactement la fenêtre de redelivery §5.3.
        const coordinates: JarvisWorkItemCoordinates = { companyId, ownerUserId, runId };
        const repository = new PrismaJarvisWorkItemsRepository(workerA);
        const leaseToken = randomUUID();
        const claimed = await repository.claimDue(coordinates, {
          leaseOwner: 'jarvis-u1c-adm-heal-worker',
          leaseToken,
          leaseDurationMs: 60_000,
          limit: 10,
        });
        expect(claimed).toHaveLength(1);
        expect(claimed[0]?.id).toBe(workItemId);
        await expect(
          repository.authorize(coordinates, {
            id: workItemId,
            leaseToken,
            leaseFence: 1n,
            authorizationDigest: sha256Hex('jarvis-u1c-adm-heal-authorization'),
          }),
        ).resolves.toBe(true);
        const resultDigest = sha256Hex('jarvis-u1c-adm-heal-result');
        await expect(
          repository.storeResult(coordinates, {
            id: workItemId,
            leaseToken,
            leaseFence: 1n,
            status: 'succeeded',
            resultDigest,
          }),
        ).resolves.toBe(true);
        const stored = await auditWorkItemSignal(workItemId);
        expect(stored.resultDigest).toBe(resultDigest);
        expect(stored.signalAppliedAt).toBeNull();

        // Borne de la greffe (revue C1/C18) : un replay USER du même run n'éteint JAMAIS
        // un signal pas encore admis.
        const userReplay = expectAdmission(
          await uowA.runJarvisAdmission(confirmEnvelope, TEST_ONLY_ADMISSION_DEPS),
          'replayed',
        );
        expect(userReplay.signalRestamped).toBe(false);
        await expect(auditWorkItemSignal(workItemId)).resolves.toMatchObject({
          signalAppliedAt: null,
        });

        // Le signal est admis par la voie canonique… et le worker meurt avant
        // markSignalApplied : signalAppliedAt reste NULL, le résultat reste pending.
        const receiptEnvelope = systemEnvelope({
          ownerUserId,
          runId,
          effectId,
          expectedRevision: 5,
          command: {
            type: 'record_effect_receipt',
            effectId,
            outcome: { kind: 'succeeded', customerId: 'client-jarvis-heal', customerRevision: 1 },
          },
          observationKind: 'effect_receipt',
        });
        const admittedSignal = expectAdmission(
          await uowA.runJarvisSystemAdmission(receiptEnvelope, TEST_ONLY_ADMISSION_DEPS),
          'admitted',
        );
        expect(admittedSignal.eventSequence).toBe(6);
        await expect(auditWorkItemSignal(workItemId)).resolves.toMatchObject({
          signalAppliedAt: null,
        });
        await expect(repository.listPendingSignals(coordinates, 10)).resolves.toHaveLength(1);

        // Redelivery : le MÊME commandId système rejoue — et la branche VRAIE heal :
        // signalRestamped=true, signalAppliedAt posé DANS la même transaction.
        const healed = expectAdmission(
          await uowA.runJarvisSystemAdmission(receiptEnvelope, TEST_ONLY_ADMISSION_DEPS),
          'replayed',
        );
        expect(healed.eventSequence).toBe(6);
        expect(healed.signalRestamped).toBe(true);
        const afterHeal = await auditWorkItemSignal(workItemId);
        expect(afterHeal.signalAppliedAt).not.toBeNull();
        await expect(repository.listPendingSignals(coordinates, 10)).resolves.toHaveLength(0);

        // Idempotence du heal : un signal déjà stampé n'est jamais re-stampé…
        const replayedAgain = expectAdmission(
          await uowA.runJarvisSystemAdmission(receiptEnvelope, TEST_ONLY_ADMISSION_DEPS),
          'replayed',
        );
        expect(replayedAgain.signalRestamped).toBe(false);
        // …et un replay USER tardif ne touche pas davantage au stamp.
        const lateUserReplay = expectAdmission(
          await uowA.runJarvisAdmission(confirmEnvelope, TEST_ONLY_ADMISSION_DEPS),
          'replayed',
        );
        expect(lateUserReplay.signalRestamped).toBe(false);
        const settled = await auditWorkItemSignal(workItemId);
        expect(settled.signalAppliedAt?.getTime()).toBe(afterHeal.signalAppliedAt?.getTime());
        await expect(auditEvents(runId)).resolves.toHaveLength(6);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "U1-h L9 — `idleExpiresAt` mesure l'INACTIVITE et suit chaque transition",
      async () => {
        // CE QUE CETTE PREUVE DEFEND. La colonne etait ecrite au semis et JAMAIS rafraichie : elle
        // mesurait l'AGE du run, si bien qu'un run activement travaille pendant 25 h se serait
        // presente comme inactif au premier balayeur qui la lirait. Surtout, les lignes Jarvis
        // VIOLAIENT ainsi l'invariant que le noyau applique deja aux lignes legacy
        // (`agent-mission.ts`, branche `status === 'active'` : `idleExpiresAt` doit valoir
        // exactement `min(updatedAt + idleTtl, hardExpiresAt)`) — invariant que la projection
        // deterministe du cutover §17 relira sur CES lignes.
        //
        // ELLE NE MANIPULE RIEN, ET C'EST UNE CONTRAINTE SUBIE, PAS UN CHOIX DE CONFORT :
        // `agent_missions` refuse toute ecriture hors du chemin applicatif — l'auditeur comme le
        // deployeur se voient opposer `permission denied`, et un UPDATE qui n'incrementerait pas la
        // revision est de toute facon refuse par le garde `AGENT_MISSION_IDENTITY_OR_REVISION_INVALID`.
        // On observe donc le run tel que le VRAI port le laisse, entre deux transitions reelles.
        //
        // CE QU'ELLE N'EXERCE PAS, ET QU'IL FAUT DIRE : le CLAMP sur `hardExpiresAt`. Avec les TTL
        // reels du vertical (24 h d'inactivite contre 7 jours de borne dure), il ne joue qu'au
        // septieme jour de vie d'un run — inatteignable ici sans maquiller la ligne, ce que la base
        // interdit. Le clamp est donc prouve la ou il vit, dans la formule
        // (`jarvis-admission.persistence.ts`), et l'invariant `idle <= hard` est verifie ci-dessous
        // a chaque etape.
        const ownerUserId = freshOwner();
        const { runId } = await seedRun(ownerUserId);

        const apresSemis = await timestamps(runId);
        expect(apresSemis.idle.getTime()).toBeGreaterThan(apresSemis.updated.getTime());
        expect(apresSemis.idle.getTime()).toBeLessThanOrEqual(apresSemis.hard.getTime());

        // Un delai REEL, court et explicite : sans lui, deux transitions tombent a quelques
        // millisecondes et l'ecart observe ne prouverait rien de solide.
        await new Promise((resolve) => setTimeout(resolve, 250));

        expectAdmission(
          await uowA.runJarvisAdmission(
            userEnvelope({
              ownerUserId,
              runId,
              expectedRevision: 1,
              command: { type: 'record_customer_resolution', resolution: { kind: 'no_duplicates' } },
            }),
            TEST_ONLY_ADMISSION_DEPS,
          ),
          'admitted',
        );

        const apresTransition = await timestamps(runId);
        // LA MESURE QUI COMPTE : la borne a AVANCE avec la transition. Sans le rafraichissement,
        // elle serait restee EXACTEMENT celle du semis.
        expect(apresTransition.idle.getTime()).toBeGreaterThan(apresSemis.idle.getTime() + 100);
        // Et elle vaut exactement `updatedAt + idleTtl` — l'invariant que le noyau exigera.
        const attendu = apresTransition.updated.getTime() + IDLE_TTL_MS;
        expect(Math.abs(apresTransition.idle.getTime() - attendu)).toBeLessThanOrEqual(50);
        // La borne DURE, elle, n'a pas bouge : une transition ne repousse jamais l'echeance ferme.
        expect(apresTransition.hard.getTime()).toBe(apresSemis.hard.getTime());
        expect(apresTransition.idle.getTime()).toBeLessThanOrEqual(apresTransition.hard.getTime());
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 12 — cancel avant authorize laisse le reçu no-effect dû puis converge terminal',
      async () => {
        const ownerUserId = freshOwner();
        const { runId, effectId, confirmationId, proposalHash } =
          await driveRunToPresented(ownerUserId);
        const confirmed = expectAdmission(
          await uowA.runJarvisAdmission(
            userEnvelope({
              ownerUserId,
              runId,
              expectedRevision: 4,
              command: confirmCommand(confirmationId, proposalHash),
            }),
            TEST_ONLY_ADMISSION_DEPS,
          ),
          'admitted',
        );
        const workItemId = confirmed.workItemIds[0] ?? '';
        const coordinates: JarvisWorkItemCoordinates = { companyId, ownerUserId, runId };
        const repository = new PrismaJarvisWorkItemsRepository(workerA);
        const claimed = await repository.claimDue(coordinates, {
          leaseOwner: 'jarvis-u1c-cancel-before-authorize',
          leaseToken: randomUUID(),
          leaseDurationMs: 60_000,
          limit: 10,
        });
        expect(claimed).toHaveLength(1);
        expect(claimed[0]?.id).toBe(workItemId);
        expect(claimed[0]?.leaseFence).toBe(1n);

        expectAdmission(
          await uowA.runJarvisAdmission(
            userEnvelope({
              ownerUserId,
              runId,
              expectedRevision: 5,
              command: { type: 'cancel_run', reason: 'user_cancelled' },
            }),
            TEST_ONLY_ADMISSION_DEPS,
          ),
          'admitted',
        );

        const cancelling = await requireRun(runId);
        expect(cancelling.status).toBe('cancelling');
        const [cancelledItem] = await auditWorkItems(runId);
        expect(cancelledItem).toMatchObject({
          id: workItemId,
          status: 'cancelled',
          leaseFence: 1n,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          authorizedAt: null,
          resultDigest: '0'.repeat(64),
          signalAppliedAt: null,
        });

        const pending = await repository.listPendingSignals(coordinates, 10);
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
          id: workItemId,
          effectId,
          status: 'cancelled',
          leaseFence: 1n,
          resultDigest: '0'.repeat(64),
        });

        const resultDigest = pending[0]?.resultDigest ?? '';
        const receipt = expectAdmission(
          await uowA.runJarvisSystemAdmission(
            systemEnvelope({
              ownerUserId,
              runId,
              effectId,
              expectedRevision: 6,
              command: {
                type: 'record_effect_receipt',
                effectId,
                outcome: {
                  kind: 'failed_terminal',
                  reasonCode: 'dispatch_cancelled_no_effect',
                },
              },
              observationKind: 'effect_result',
            }),
            TEST_ONLY_ADMISSION_DEPS,
          ),
          'admitted',
        );
        expect(receipt.eventSequence).toBe(7);
        await expect(
          repository.markSignalApplied(coordinates, {
            id: workItemId,
            leaseFence: 1n,
            resultDigest,
          }),
        ).resolves.toBe(true);

        const settled = await requireRun(runId);
        expect(settled.status).toBe('cancelled');
        expect(settled.terminalAt).not.toBeNull();
        await expect(repository.listPendingSignals(coordinates, 10)).resolves.toHaveLength(0);
        await expect(auditWorkItemSignal(workItemId)).resolves.toMatchObject({
          resultDigest: '0'.repeat(64),
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 13 — une forme N-1 contradictoire reste visible, jamais réécrite en faux no-effect',
      async () => {
        const ownerUserId = freshOwner();
        const { runId, confirmationId, proposalHash } = await driveRunToPresented(ownerUserId);
        const confirmed = expectAdmission(
          await uowA.runJarvisAdmission(
            userEnvelope({
              ownerUserId,
              runId,
              expectedRevision: 4,
              command: confirmCommand(confirmationId, proposalHash),
            }),
            TEST_ONLY_ADMISSION_DEPS,
          ),
          'admitted',
        );
        const workItemId = confirmed.workItemIds[0] ?? '';
        const coordinates: JarvisWorkItemCoordinates = { companyId, ownerUserId, runId };
        const repository = new PrismaJarvisWorkItemsRepository(workerA);
        const leaseToken = randomUUID();
        const claimed = await repository.claimDue(coordinates, {
          leaseOwner: 'jarvis-u1c-contradictory-n1',
          leaseToken,
          leaseDurationMs: 60_000,
          limit: 10,
        });
        expect(claimed).toHaveLength(1);

        const historicalAuthorizationDigest = sha256Hex('jarvis-u1c-contradictory-n1-auth');
        await admin.$executeRaw`
          UPDATE public.jarvis_work_items
             SET "authorizedAt" = statement_timestamp(),
                 "authorizationDigest" = ${historicalAuthorizationDigest}
           WHERE "id" = ${workItemId}::uuid
             AND "status" = 'leased'
        `;

        expectAdmission(
          await uowA.runJarvisAdmission(
            userEnvelope({
              ownerUserId,
              runId,
              expectedRevision: 5,
              command: { type: 'cancel_run', reason: 'user_cancelled' },
            }),
            TEST_ONLY_ADMISSION_DEPS,
          ),
          'admitted',
        );

        const run = await requireRun(runId);
        expect(run.status).toBe('cancelling');
        const [item] = await auditWorkItems(runId);
        expect(item).toMatchObject({
          id: workItemId,
          status: 'leased',
          leaseToken,
          authorizedAt: expect.any(Date),
          authorizationDigest: historicalAuthorizationDigest,
          resultDigest: null,
          signalAppliedAt: null,
        });
        await expect(repository.listPendingSignals(coordinates, 10)).resolves.toHaveLength(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'U1-m M1 — société fermée : wake neuf refusé, reçu wake exact toujours rejoué',
      async () => {
        // DERNIER scénario du fichier : closedAt est volontairement monotone et ne sera jamais
        // remis à NULL par le harnais.
        const committedOwnerUserId = freshOwner();
        const { runId: committedRunId } = await driveRunToPresented(committedOwnerUserId);
        const dueAt = await databaseDueAtAfter(300);
        await pinWakeDueAt(committedOwnerUserId, committedRunId, dueAt);
        const committedWake = await authoritativeWake(committedRunId);
        const committedEnvelope = wakeEnvelope({
          ownerUserId: committedOwnerUserId,
          runId: committedRunId,
          wakeId: committedWake.wakeId,
          dueAt: committedWake.dueAt,
          expectedRevision: committedWake.revision,
        });
        await waitUntilDatabaseDue(dueAt);
        expectAdmission(
          await uowA.runJarvisSystemAdmission(committedEnvelope, TEST_ONLY_ADMISSION_DEPS),
          'admitted',
        );

        const pendingOwnerUserId = freshOwner();
        const { runId: pendingRunId } = await driveRunToPresented(pendingOwnerUserId);
        const pendingWake = await authoritativeWake(pendingRunId);
        const pendingEnvelope = wakeEnvelope({
          ownerUserId: pendingOwnerUserId,
          runId: pendingRunId,
          wakeId: pendingWake.wakeId,
          dueAt: pendingWake.dueAt,
          expectedRevision: pendingWake.revision,
        });

        await workerA.withTenant(companyId, async (tx) => {
          const closed = await tx.$executeRaw`
            UPDATE public.companies
               SET "closedAt" = clock_timestamp(),
                   "closureReason" = ${'certification wake U1-m'}
             WHERE "id" = ${companyId}
               AND "closedAt" IS NULL
          `;
          if (closed !== 1) throw new Error('Jarvis U1-m: clôture société de certification ratée.');
        });

        const committedStorageAfterClose = await auditRunStorage(committedRunId);
        const committedEventsAfterClose = await auditEvents(committedRunId);
        const committedWorkItemsAfterClose = await auditWorkItems(committedRunId);
        const pendingStorageAfterClose = await auditRunStorage(pendingRunId);
        const pendingEventsAfterClose = await auditEvents(pendingRunId);
        const pendingWorkItemsAfterClose = await auditWorkItems(pendingRunId);

        await expect(
          uowA.runJarvisSystemAdmission(pendingEnvelope, TEST_ONLY_ADMISSION_DEPS),
        ).resolves.toEqual({ status: 'company_unavailable', reason: 'closed' });
        const replayed = expectAdmission(
          await uowA.runJarvisSystemAdmission(committedEnvelope, {
            ...TEST_ONLY_ADMISSION_DEPS,
            admissionEnabled: false,
            actionReleasePolicy: CLOSED_JARVIS_ACTION_RELEASE_POLICY,
          }),
          'replayed',
        );
        expect(replayed).toMatchObject({
          eventSequence: 5,
          signalRestamped: false,
          postimage: { runId: committedRunId, revision: 5 },
        });

        expect(await auditRunStorage(committedRunId)).toEqual(committedStorageAfterClose);
        expect(await auditEvents(committedRunId)).toEqual(committedEventsAfterClose);
        expect(await auditWorkItems(committedRunId)).toEqual(committedWorkItemsAfterClose);
        expect(await auditRunStorage(pendingRunId)).toEqual(pendingStorageAfterClose);
        expect(await auditEvents(pendingRunId)).toEqual(pendingEventsAfterClose);
        expect(await auditWorkItems(pendingRunId)).toEqual(pendingWorkItemsAfterClose);
        await expect(commandEventCount(committedEnvelope.commandId)).resolves.toBe(1);
        await expect(commandEventCount(pendingEnvelope.commandId)).resolves.toBe(0);
      },
      TEST_TIMEOUT_MS,
    );
  },
);

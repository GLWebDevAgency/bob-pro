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
 *
 * Même harnais que jarvis-work-items.persistence.postgres.test.ts : gates env,
 * base jetable, sociétés via l'auditeur, fingerprints déterministes.
 */
import { randomUUID } from 'node:crypto';

import {
  CUSTOMER_CONTACT_CREATE_ACTION_ID,
  computeCustomerContactProposalHash,
  deriveJarvisSystemCommandId,
  sha256Hex,
  type AgentMissionFingerprintPort,
  type JarvisAdmissionResult,
  type JarvisSystemAdmissionEnvelope,
  type JarvisUserAdmissionEnvelope,
} from '@bob/core';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaAgentMissionUnitOfWork } from './agent-mission.persistence';
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

const DEPS: JarvisAdmissionDeps = {
  fingerprints: FINGERPRINTS,
  canonicalizationVersion: 1,
  admissionEnabled: true,
  // Harnais de certification : la preuve d'autorite realtime arrive avec les callers U1-d.
  allowCertificationAuthority: true,
};

const START_CREATE = { type: 'start_run', intent: { mode: 'create' } } as const;

function expectAdmission<S extends JarvisAdmissionResult['status']>(
  result: JarvisAdmissionResult,
  status: S,
): Extract<JarvisAdmissionResult, { status: S }> {
  if (result.status !== status) {
    throw new Error(`Jarvis U1-c: statut ${status} attendu, reçu ${JSON.stringify(result)}`);
  }
  return result as Extract<JarvisAdmissionResult, { status: S }>;
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
  readonly terminalAt: Date | null;
}

interface EventAuditRow {
  readonly sequence: number;
  readonly eventType: string;
  readonly actor: string;
  readonly commandId: string;
  readonly missionRevisionBefore: number;
  readonly missionRevisionAfter: number;
}

interface WorkItemAuditRow {
  readonly id: string;
  readonly effectId: string;
  readonly actionId: string;
  readonly actionVersion: number;
  readonly status: string;
  readonly leaseFence: bigint;
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
    }): JarvisUserAdmissionEnvelope {
      return Object.freeze({
        kind: 'customer_contact' as const,
        definitionVersion: input.definitionVersion ?? 1,
        companyId,
        ownerUserId: input.ownerUserId,
        runId: input.runId,
        commandId: input.commandId ?? randomUUID(),
        expectedRevision: input.expectedRevision,
        actionId: CUSTOMER_CONTACT_CREATE_ACTION_ID,
        actionVersion: 1,
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
        observationKind: input.observationKind,
        effectId: input.effectId,
        occurredAt: new Date().toISOString(),
      });
    }

    async function auditRun(runId: string): Promise<RunAuditRow | null> {
      const rows = await admin.$queryRaw<RunAuditRow[]>`
        SELECT "kind", "status", "phase", "revision", "protocolVersion",
               "payloadVersion", "definitionVersion", "payload", "terminalAt"
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

    async function auditEvents(runId: string): Promise<EventAuditRow[]> {
      return admin.$queryRaw<EventAuditRow[]>`
        SELECT "sequence", "eventType", "actor", "commandId",
               "missionRevisionBefore", "missionRevisionAfter"
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
               "leaseFence", "actingPrincipalId", "authorizationSource"
          FROM public.jarvis_work_items
         WHERE "runId" = ${runId}::uuid
      `;
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
      const admitted = expectAdmission(await uowA.runJarvisAdmission(envelope, DEPS), 'admitted');
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
          DEPS,
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
          DEPS,
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
          DEPS,
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

    function confirmCommand(confirmationId: string, proposalHash: string): unknown {
      return {
        type: 'confirm',
        confirmationId,
        proposalHash,
        revalidatedTargetRevision: null,
        revalidatedSensitiveDigest: null,
      };
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
      'preuve 2 — replay même commandId + même enveloppe : replayed, zéro nouvelle ligne',
      async () => {
        const ownerUserId = freshOwner();
        const { runId, envelope } = await seedRun(ownerUserId);

        const replayed = expectAdmission(await uowA.runJarvisAdmission(envelope, DEPS), 'replayed');
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
        expectAdmission(await uowA.runJarvisAdmission(conflicting, DEPS), 'command_conflict');

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
          uowA.runJarvisAdmission(envelopeA, DEPS),
          uowB.runJarvisAdmission(envelopeB, DEPS),
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
        expectAdmission(await uowA.runJarvisAdmission(stolen, DEPS), 'command_conflict');
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
        expectAdmission(await uowA.runJarvisAdmission(review, DEPS), 'admitted');
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
        expectAdmission(await uowA.runJarvisAdmission(secondSeed, DEPS), 'foreground_busy');
        await expect(auditRun(secondRunId)).resolves.toBeNull();
        await expect(commandEventCount(secondSeed.commandId)).resolves.toBe(0);

        // cancel_run par l'admission : le premier plan est libéré dans la même vérité SQL.
        const cancel = userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 2,
          command: { type: 'cancel_run', reason: 'user_cancelled' },
        });
        expectAdmission(await uowA.runJarvisAdmission(cancel, DEPS), 'admitted');
        const cancelled = await requireRun(runId);
        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.terminalAt).not.toBeNull();

        // La MÊME enveloppe de seed passe désormais — le refus n'a rien persisté.
        expectAdmission(await uowA.runJarvisAdmission(secondSeed, DEPS), 'admitted');
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
          const crashing = crashUow.runJarvisAdmission(envelope, DEPS);

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
          await expect(crashing).rejects.toThrow();
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
          expectAdmission(await uowA.runJarvisAdmission(envelope, DEPS), 'admitted');
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
            DEPS,
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
            DEPS,
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
            DEPS,
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
        const confirmCommand = {
          type: 'confirm',
          confirmationId,
          proposalHash,
          revalidatedTargetRevision: null,
          revalidatedSensitiveDigest: null,
        } as const;
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
            DEPS,
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
            DEPS,
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
          await uowA.runJarvisSystemAdmission(receiptEnvelope, DEPS),
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

        // La même observation re-soumise dérive le MÊME commandId : replay zéro-write.
        const replayed = expectAdmission(
          await uowA.runJarvisSystemAdmission(receiptEnvelope, DEPS),
          'replayed',
        );
        expect(replayed.eventSequence).toBe(6);
        await expect(auditEvents(runId)).resolves.toHaveLength(6);
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

        // La commande qui AURAIT émis l'intent 1:1 (confirm) arrive sur le run épinglé :
        // quarantaine — jamais un comportement par défaut, jamais un work item.
        const quarantining = userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 4,
          definitionVersion: UNKNOWN_DEFINITION_VERSION,
          command: confirmCommand(confirmationId, proposalHash),
        });
        expectAdmission(await uowA.runJarvisAdmission(quarantining, DEPS), 'quarantined');

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
        const frozen = expectAdmission(await uowA.runJarvisAdmission(staleCancel, DEPS), 'refused');
        expect(frozen.error).toEqual({ code: 'run_terminal', status: 'quarantined' });
        await expect(commandEventCount(staleCancel.commandId)).resolves.toBe(0);

        const mismatched = userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 5,
          command: { type: 'cancel_run', reason: 'user_cancelled' },
        });
        const refused = expectAdmission(await uowA.runJarvisAdmission(mismatched, DEPS), 'refused');
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
          await uowA.runJarvisAdmission(confirmEnvelope, DEPS),
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
          await uowA.runJarvisAdmission(confirmEnvelope, DEPS),
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
          await uowA.runJarvisSystemAdmission(receiptEnvelope, DEPS),
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
          await uowA.runJarvisSystemAdmission(receiptEnvelope, DEPS),
          'replayed',
        );
        expect(healed.eventSequence).toBe(6);
        expect(healed.signalRestamped).toBe(true);
        const afterHeal = await auditWorkItemSignal(workItemId);
        expect(afterHeal.signalAppliedAt).not.toBeNull();
        await expect(repository.listPendingSignals(coordinates, 10)).resolves.toHaveLength(0);

        // Idempotence du heal : un signal déjà stampé n'est jamais re-stampé…
        const replayedAgain = expectAdmission(
          await uowA.runJarvisSystemAdmission(receiptEnvelope, DEPS),
          'replayed',
        );
        expect(replayedAgain.signalRestamped).toBe(false);
        // …et un replay USER tardif ne touche pas davantage au stamp.
        const lateUserReplay = expectAdmission(
          await uowA.runJarvisAdmission(confirmEnvelope, DEPS),
          'replayed',
        );
        expect(lateUserReplay.signalRestamped).toBe(false);
        const settled = await auditWorkItemSignal(workItemId);
        expect(settled.signalAppliedAt?.getTime()).toBe(afterHeal.signalAppliedAt?.getTime());
        await expect(auditEvents(runId)).resolves.toHaveLength(6);
      },
      TEST_TIMEOUT_MS,
    );
  },
);

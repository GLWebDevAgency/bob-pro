/**
 * Jarvis U1-e — LE PARCOURS VISIBLE, prouvé en PostgreSQL depuis les ROUTES
 * (SPEC_U1E_PARCOURS_VISIBLE_20260819 §1/§2, §5 étage 0 ; spec Jarvis §5.2/§7.1/§9.1/§14).
 *
 * Les suites U1-c/U1-d prouvaient la transaction puis les appelants. Celle-ci prouve ce que
 * l'ARTISAN peut atteindre : un appareil qui n'a rien dérivé retrouve son run, l'ouvre depuis
 * l'écran, et la modification qu'il confirme est celle qu'il a vue — pas une autre.
 *
 * Rien n'est simulé : chaque preuve appelle le VRAI controller (`JarvisRunController` avec son
 * autorité `DurableJarvisTapAuthority`, l'owner et le hash de liaison dérivés du bearer), branché
 * sur le VRAI adaptateur d'admission (`PrismaAgentMissionUnitOfWork` + deps de PRODUCTION,
 * `allowCertificationAuthority: false`), le VRAI magasin de charges scellées, le VRAI worker de
 * dispatch et le VRAI exécuteur d'effet, dont l'autorité métier appelle les use cases CANONIQUES
 * de la fiche client. Chaque assertion RELIT LA BASE par l'auditeur — jamais le seul reçu rendu.
 *
 *  (1) DÉCOUVERTE §1 — `GET /jarvis/runs/current` : un run ouvert par la route (semé PUIS résolu
 *      par le second maillon serveur §8) est retrouvé avec sa présentation ; le même run, une fois la proposition présentée, sort avec ses champs
 *      recomposés depuis la charge scellée ; devenu TERMINAL il ne sort plus (rien à reprendre à
 *      l'écran) ; et l'annuaire est OWNER-SCOPÉ dans les deux sens : le voisin ne voit pas le run
 *      de l'artisan, l'artisan ne voit pas celui du voisin. La lecture n'écrit RIEN (§5.2) :
 *      révision et journal sont relus identiques de part et d'autre.
 *
 *  (2) OUVERTURE §1 — `POST /jarvis/runs` sème un run `customer_contact@1` d'intention `update`
 *      sur une cible RÉELLE : le `runId` est DÉRIVÉ serveur du couple owner/`commandId`, la
 *      révision de seed (0) n'est écrite que par cette route, et le journal porte `user_tap`.
 *      Le rejeu du MÊME `commandId` retombe sur le MÊME run (`replayed`, zéro écriture — la
 *      condition du retry sans double run §5.4). Deux ouvertures CONCURRENTES (deux `commandId`,
 *      deux connexions, une seule société-owner) : une seule passe, l'autre est refusée
 *      `foreground_busy` par le backstop de premier plan, et la base ne porte QU'UN run.
 *
 *  (3) RELECTURE AUTORITAIRE §2 — le cœur. Parcours de modification COMPLET : ouverture par la
 *      route, proposition scellée, présentation acquittée par la route, puis MUTATION RÉELLE de
 *      la fiche en base (écriture canonique de l'artisan) entre la présentation et la
 *      confirmation ⇒ le `confirm` (trois clés au wire, aucune valeur revalidée) rend la
 *      proposition `invalidated`, JAMAIS `consumed` : zéro work item, zéro écriture métier. La
 *      proposition suivante, elle, aboutit : `consumed`, work item, effet exécuté par le worker
 *      RÉEL, fiche RELUE en base — la ville proposée a recouvert la fiche, la mutation de
 *      l'artisan a SURVÉCU, et la révision a été incrémentée par l'écriture canonique.
 *
 *  (4) ANNUAIRE §4 — l'autorité de rétention : avant l'échéance elle ne rend RIEN (elle ne peut
 *      pas cartographier les usagers), après elle rend le seul propriétaire échu DE CE TENANT ;
 *      `payload` lui est refusé PAR PRIVILÈGE (GRANT par colonne) et `bob_app` ne peut pas
 *      l'assumer ; une borne hors plafond est refusée, jamais rognée. Puis le BOUCLAGE : le
 *      service de purge RÉEL efface le PII échu et laisse le vivant — sans annuaire il rendait
 *      `owner_directory_absent` et `retentionExpiresAt` n'était qu'une colonne décorative.
 *
 * Même harnais que jarvis-oracles.postgres.test.ts : gates env, base jetable, sociétés créées par
 * l'auditeur, fingerprints déterministes, clients Prisma `errorFormat: 'minimal'`.
 */
import { randomUUID } from 'node:crypto';

import { HttpException } from '@nestjs/common';
import {
  CUSTOMER_CONTACT_DEFINITION_VERSION,
  CUSTOMER_CONTACT_UPDATE_ACTION_ID,
  Customer,
  UpdateCustomer,
  computeCustomerContactFieldsDigest,
  computeCustomerContactSensitiveDigest,
  sha256Hex,
  type AgentMissionFingerprintPort,
  type CustomerContactProposedFieldsV1,
  type JarvisAdmissionOwner,
  type JarvisAdmissionResult,
  type JarvisAdmissionUnitOfWorkPort,
  type JarvisStatelessReadResult,
  type JarvisStatelessReadView,
  type JarvisSystemAdmissionEnvelope,
  type JarvisUserAdmissionEnvelope,
} from '@bob/core';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  JarvisCustomerEffectExecutor,
  type JarvisCustomerEffectAuthority,
  type JarvisCustomerEffectTarget,
  type JarvisCustomerFields,
  type JarvisCustomerSnapshot,
  type JarvisCustomerWriteResult,
} from '../../jobs/jarvis-customer-effect.executor';
import {
  JarvisWorkItemDispatchService,
  jarvisEffectExecutorKey,
  type JarvisDispatchRunDirectoryPort,
  type JarvisEffectExecutor,
} from '../../jobs/jarvis-work-item-dispatch.service';
import { JarvisProposalPayloadPurgeService } from '../../jobs/jarvis-proposal-payload-purge.service';
import type { ScheduledTenantDirectory } from '../../jobs/tenant-directory';
import {
  DurableJarvisTapAuthority,
  JarvisRunController,
  deriveJarvisScreenRunId,
  type JarvisCommandReceiptWire,
  type JarvisCurrentRunWire,
} from '../../jarvis/jarvis-run.controller';
import { AppLogger, requestContext } from '../../observability/logger';
import { agentMissionPrincipalBindingHash } from '../../voice/realtime/realtime-agent-mission-admission';
import type { Persistence } from '../persistence';
import { PrismaAgentMissionUnitOfWork } from './agent-mission.persistence';
import type { JarvisAdmissionDeps } from './jarvis-admission.persistence';
import { PrismaJarvisCustomerEffectAuthority } from '../../jarvis/jarvis-customer-effect.authority';
import { PrismaJarvisDispatchRunDirectory } from './jarvis-dispatch-directory.persistence';
import { PrismaJarvisProposalPayloadStore } from './jarvis-proposal-payloads.persistence';
import { PrismaJarvisWorkItemsRepository } from './jarvis-work-items.persistence';
import { PrismaService } from './prisma.service';
import {
  PrismaCustomerRepository,
  PrismaInvoiceRepository,
  PrismaQuoteRepository,
} from './repositories';

const RUN_CERT = process.env.RUN_AGENT_MISSION_POSTGRES_CERT === 'true';
const DISPOSABLE = process.env.AGENT_MISSION_CERT_DATABASE_IS_DISPOSABLE === 'true';

/** Le parcours §2 enchaîne un run complet, deux propositions, un tick de worker et deux écritures. */
const TEST_TIMEOUT_MS = 90_000;
const PAYLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
/** Autorité de l'annuaire de rétention (SPEC_U1E §4) — le rôle NOLOGIN de `release.sh`. */
const RETENTION_DIRECTORY_ROLE = 'bob_jarvis_payload_retention_directory';

const FINGERPRINTS: AgentMissionFingerprintPort = {
  sign(canonicalRequest) {
    return { keyVersion: 1, hmac: sha256Hex(`jarvis-u1e-key:${canonicalRequest}`) };
  },
  matches(canonicalRequest, fingerprint) {
    if (fingerprint.keyVersion !== 1) return null;
    return fingerprint.hmac === sha256Hex(`jarvis-u1e-key:${canonicalRequest}`);
  },
};

/**
 * CÂBLAGE DE PRODUCTION — `allowCertificationAuthority: false`, exactement ce que pose l'adapter
 * `JARVIS_ADMISSION`. Le canal tactile est certifié SOUS ces deps : une preuve qui aurait besoin
 * du drapeau de harnais ne prouverait rien de la prod.
 */
const PRODUCTION_DEPS: JarvisAdmissionDeps = {
  fingerprints: FINGERPRINTS,
  canonicalizationVersion: 1,
  admissionEnabled: true,
  allowCertificationAuthority: false,
};

function expectAdmission<S extends JarvisAdmissionResult['status']>(
  result: JarvisAdmissionResult,
  status: S,
): Extract<JarvisAdmissionResult, { status: S }> {
  if (result.status !== status) {
    throw new Error(`Jarvis U1-e: statut ${status} attendu, reçu ${JSON.stringify(result)}`);
  }
  return result as Extract<JarvisAdmissionResult, { status: S }>;
}

function proposedFields(
  overrides: Partial<CustomerContactProposedFieldsV1> = {},
): CustomerContactProposedFieldsV1 {
  return Object.freeze({
    displayName: null,
    legalName: null,
    email: null,
    phone: null,
    addressLine: null,
    postalCode: null,
    city: null,
    vatNumber: null,
    billingChannel: null,
    recipientName: null,
    ...overrides,
  });
}

/** Fiche cible de départ — les colonnes SENSIBLES §9.1 y sont toutes peuplées, donc mutables. */
function targetCustomerFields(overrides: Partial<JarvisCustomerFields> = {}): JarvisCustomerFields {
  return {
    type: 'b2c',
    name: 'Marie Dupont',
    email: 'marie.dupont@example.test',
    phone: '0601020304',
    contactName: 'Marie Dupont',
    address: { line1: '12 rue des Lilas', zip: '75011', city: 'Paris' },
    ...overrides,
  };
}

interface RunAuditRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly phase: string;
  readonly revision: number;
  readonly payload: unknown;
  readonly terminalAt: Date | null;
}

interface EventAuditRow {
  readonly sequence: number;
  readonly eventType: string;
  readonly actor: string;
  readonly commandId: string;
  readonly data: unknown;
}

/** Ce que la preuve lit du state persisté — jamais plus, et toujours par une garde. */
interface PersistedRunState {
  readonly effectId: string;
  readonly intent:
    | { readonly mode: 'create' }
    | {
        readonly mode: 'update';
        readonly target: { readonly customerId: string; readonly revision: number };
      };
  readonly proposal: { readonly proposalHash: string } | null;
  readonly confirmation: { readonly status: string } | null;
}

interface CustomerAuditRow {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly addrLine1: string;
  readonly addrZip: string;
  readonly addrCity: string;
  /** U1-e §2 — compteur d'édition relu par l'admission ; la preuve le LIT, ne le suppose pas. */
  readonly revision: number;
}

describe.skipIf(!RUN_CERT)(
  'Jarvis U1-e — découverte, ouverture et relecture autoritaire depuis les routes (§1/§2)',
  () => {
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const certAdminUrl = process.env.AGENT_MISSION_CERT_ADMIN_URL ?? '';
    /** Société de l'artisan. Le motif de tenant Realtime borne l'identité : alphanumérique + tiret. */
    const companyId = `jarvis-u1e-company-${randomUUID()}`;
    /** Société VOISINE : elle prouve que l'annuaire ne traverse jamais le tenant. */
    const neighborCompanyId = `jarvis-u1e-voisin-${randomUUID()}`;
    let admin: PrismaClient;
    let workerA: PrismaService;
    let workerB: PrismaService;
    let uowA: PrismaAgentMissionUnitOfWork;
    let uowB: PrismaAgentMissionUnitOfWork;
    let storeA: PrismaJarvisProposalPayloadStore;
    let workItems: PrismaJarvisWorkItemsRepository;
    let controllerA: JarvisRunController;
    let controllerB: JarvisRunController;
    let authorityA: CertificationCustomerAuthority;

    function freshOwner(prefix: string): string {
      return `jarvis-u1e-${prefix}-${randomUUID()}`;
    }

    /** Adaptateur du port d'admission tel que le module le lie : deps de production épinglées. */
    function admissionPortOf(uow: PrismaAgentMissionUnitOfWork): JarvisAdmissionUnitOfWorkPort {
      return {
        runJarvisAdmission: (envelope: JarvisUserAdmissionEnvelope) =>
          uow.runJarvisAdmission(envelope, PRODUCTION_DEPS),
        runJarvisSystemAdmission: (envelope: JarvisSystemAdmissionEnvelope) =>
          uow.runJarvisSystemAdmission(envelope, PRODUCTION_DEPS),
        readJarvisStateless: <T>(
          owner: JarvisAdmissionOwner,
          read: (view: JarvisStatelessReadView) => Promise<T>,
        ): Promise<JarvisStatelessReadResult<T>> => uow.readJarvisStateless(owner, read),
      };
    }

    /**
     * Le controller RÉEL, avec l'autorité de production : owner et `principalBindingHash` sont
     * dérivés du bearer admis — aucune preuve d'ici ne les fournit par le corps.
     */
    function tapController(
      uow: PrismaAgentMissionUnitOfWork,
      prisma: PrismaService,
    ): JarvisRunController {
      return new JarvisRunController(
        new DurableJarvisTapAuthority(),
        new AppLogger(),
        admissionPortOf(uow),
        new PrismaJarvisProposalPayloadStore(prisma),
      );
    }

    /** Portée du bearer : le principal que le guard pose en production, et rien d'autre. */
    function asOwner<T>(owner: JarvisAdmissionOwner, work: () => Promise<T>): Promise<T> {
      return requestContext.run(
        {
          correlationId: `jarvis-u1e-${randomUUID()}`,
          principal: { userId: owner.ownerUserId, companyId: owner.companyId },
        },
        work,
      );
    }

    /**
     * Commandes que le canal tactile n'émet PAS (résolution de cible, mise en proposition) : elles
     * appartiennent à la voix ou au planner. Le harnais les passe par le MÊME port d'admission,
     * sous la MÊME autorité `authenticated_principal` — le journal reste donc `user_tap` de bout
     * en bout, et aucune preuve n'emprunte un chemin que la production n'a pas.
     */
    async function admitViaPort(
      uow: PrismaAgentMissionUnitOfWork,
      input: {
        readonly owner: JarvisAdmissionOwner;
        readonly runId: string;
        readonly expectedRevision: number;
        readonly command: unknown;
      },
    ): Promise<JarvisAdmissionResult> {
      const commandId = randomUUID();
      const envelope: JarvisUserAdmissionEnvelope = Object.freeze({
        kind: 'customer_contact' as const,
        definitionVersion: CUSTOMER_CONTACT_DEFINITION_VERSION,
        companyId: input.owner.companyId,
        ownerUserId: input.owner.ownerUserId,
        runId: input.runId,
        commandId,
        expectedRevision: input.expectedRevision,
        actionId: CUSTOMER_CONTACT_UPDATE_ACTION_ID,
        actionVersion: 1,
        authority: {
          source: 'authenticated_principal' as const,
          principalBindingHash: agentMissionPrincipalBindingHash(
            input.owner.companyId,
            input.owner.ownerUserId,
          ),
        },
        command: input.command,
        canonicalInputDigest: sha256Hex(`jarvis-u1e-port:${commandId}`),
        occurredAt: new Date().toISOString(),
      });
      return uow.runJarvisAdmission(envelope, PRODUCTION_DEPS);
    }

    async function auditRun(runId: string): Promise<RunAuditRow | null> {
      const rows = await admin.$queryRaw<RunAuditRow[]>`
        SELECT "id", "kind", "status", "phase", "revision", "payload", "terminalAt"
          FROM public.agent_missions
         WHERE "id" = ${runId}::uuid
      `;
      return rows[0] ?? null;
    }

    async function requireRun(runId: string): Promise<RunAuditRow> {
      const row = await auditRun(runId);
      if (row === null) throw new Error(`Jarvis U1-e: run introuvable ${runId}`);
      return row;
    }

    async function auditEvents(runId: string): Promise<EventAuditRow[]> {
      return admin.$queryRaw<EventAuditRow[]>`
        SELECT "sequence", "eventType", "actor", "commandId", "data"
          FROM public.agent_mission_events
         WHERE "missionId" = ${runId}::uuid
         ORDER BY "sequence"
      `;
    }

    async function countRuns(owner: JarvisAdmissionOwner): Promise<number> {
      const rows = await admin.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS "count"
          FROM public.agent_missions
         WHERE "companyId" = ${owner.companyId}
           AND "ownerUserId" = ${owner.ownerUserId}
      `;
      return rows[0]?.count ?? 0;
    }

    async function countWorkItems(runId: string): Promise<number> {
      const rows = await admin.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS "count"
          FROM public.jarvis_work_items
         WHERE "runId" = ${runId}::uuid
      `;
      return rows[0]?.count ?? 0;
    }

    async function auditCustomer(customerId: string): Promise<CustomerAuditRow | null> {
      const rows = await admin.$queryRaw<CustomerAuditRow[]>`
        SELECT "id", "name", "email", "addrLine1", "addrZip", "addrCity", "revision"
          FROM public.customers
         WHERE "id" = ${customerId}
      `;
      return rows[0] ?? null;
    }

    /** State persisté du run, lu DÉFENSIVEMENT : un state illisible n'est jamais interprété. */
    function stateOf(row: RunAuditRow): PersistedRunState {
      const payload = row.payload as PersistedRunState | null;
      if (payload === null || typeof payload.effectId !== 'string') {
        throw new Error('Jarvis U1-e: state persisté illisible.');
      }
      return payload;
    }

    /** L'intention de MODIFICATION du run, ou l'échec : une création n'a pas de cible. */
    function updateTargetOf(row: RunAuditRow): {
      readonly customerId: string;
      readonly revision: number;
    } {
      const intent = stateOf(row).intent;
      if (intent.mode !== 'update') {
        throw new Error(`Jarvis U1-e: intention de modification attendue, reçue ${intent.mode}`);
      }
      return intent.target;
    }

    /** Charge PII scellée AVANT `stage_proposal` — l'ordre exigé par la doctrine du magasin. */
    async function sealPayload(input: {
      readonly owner: JarvisAdmissionOwner;
      readonly runId: string;
      readonly proposalId: string;
      readonly fields: CustomerContactProposedFieldsV1;
    }): Promise<void> {
      const sealed = await storeA.sealProposalPayload({
        companyId: input.owner.companyId,
        ownerUserId: input.owner.ownerUserId,
        runId: input.runId,
        proposalId: input.proposalId,
        fieldsDigest: computeCustomerContactFieldsDigest(input.fields),
        sensitiveDigest: computeCustomerContactSensitiveDigest(input.fields),
        fields: input.fields,
        retentionExpiresAt: new Date(Date.now() + PAYLOAD_RETENTION_MS).toISOString(),
      });
      if (sealed.status !== 'sealed') {
        throw new Error(`Jarvis U1-e: scellement raté ${JSON.stringify(sealed)}`);
      }
    }

    /** Crée la fiche CIBLE par le use case canonique — jamais un INSERT d'auditeur. */
    async function seedTargetCustomer(
      owner: JarvisAdmissionOwner,
      overrides: Partial<JarvisCustomerFields> = {},
    ): Promise<string> {
      const customerId = randomUUID();
      const written = await authorityA.createCustomer(
        { companyId: owner.companyId, ownerUserId: owner.ownerUserId, customerId },
        targetCustomerFields(overrides),
      );
      expect(written).toEqual({ status: 'written' });
      // La fiche NAÎT à la révision 1 (DEFAULT SQL de l'expand additif U1-e §2).
      await expect(auditCustomer(customerId)).resolves.toMatchObject({ revision: 1 });
      return customerId;
    }

    /** Ouverture depuis l'écran : la route dédiée, le corps EXACT, rien de plus. */
    function openRun(
      controller: JarvisRunController,
      owner: JarvisAdmissionOwner,
      input: { readonly commandId: string; readonly customerId: string },
    ): Promise<JarvisCommandReceiptWire> {
      return asOwner(owner, () =>
        controller.openRun({
          commandId: input.commandId,
          intent: { mode: 'update', target: { customerId: input.customerId } },
        }),
      );
    }

    function currentRun(
      controller: JarvisRunController,
      owner: JarvisAdmissionOwner,
    ): Promise<JarvisCurrentRunWire> {
      return asOwner(owner, () => controller.getCurrentRun());
    }

    /**
     * Amène un run DÉJÀ RÉSOLU (l'ouverture par la route enchaîne le second maillon serveur §8)
     * jusqu'à la proposition PRÉSENTÉE : mise en proposition par le port (elle n'appartient pas
     * au tap), reçu de présentation par la ROUTE.
     *
     * `expectedRevision` est la révision du run APRÈS ouverture — 2 : le semis puis la résolution.
     * Aucune seconde résolution n'est émise ici : plus personne, en production, n'en émet une.
     */
    async function presentProposal(input: {
      readonly owner: JarvisAdmissionOwner;
      readonly runId: string;
      readonly customerId: string;
      readonly targetRevision: number;
      readonly expectedRevision: number;
      readonly fields: CustomerContactProposedFieldsV1;
    }): Promise<{ readonly confirmationId: string; readonly receipt: JarvisCommandReceiptWire }> {
      const proposalId = randomUUID();
      const confirmationId = randomUUID();
      await sealPayload({
        owner: input.owner,
        runId: input.runId,
        proposalId,
        fields: input.fields,
      });
      expectAdmission(
        await admitViaPort(uowA, {
          owner: input.owner,
          runId: input.runId,
          expectedRevision: input.expectedRevision,
          command: {
            type: 'stage_proposal',
            proposalId,
            confirmationId,
            fieldsDigest: computeCustomerContactFieldsDigest(input.fields),
            sensitiveDigest: computeCustomerContactSensitiveDigest(input.fields),
            targetRevision: input.targetRevision,
          },
        }),
        'admitted',
      );
      const receipt = await asOwner(input.owner, () =>
        controllerA.submitCommand(input.runId, {
          kind: 'customer_contact',
          definitionVersion: CUSTOMER_CONTACT_DEFINITION_VERSION,
          commandId: randomUUID(),
          expectedRevision: input.expectedRevision + 1,
          actionId: CUSTOMER_CONTACT_UPDATE_ACTION_ID,
          actionVersion: 1,
          command: { type: 'record_presentation_ack', confirmationId, ack: 'screen_ack' },
        }),
      );
      expect(receipt.outcome).toBe('admitted');
      return { confirmationId, receipt };
    }

    beforeAll(async () => {
      if (!DISPOSABLE) {
        throw new Error(
          'AGENT_MISSION_CERT_DATABASE_IS_DISPOSABLE=true est obligatoire : le journal est immuable.',
        );
      }
      if (runtimeUrl === '' || certAdminUrl === '') {
        throw new Error('DATABASE_URL runtime et AGENT_MISSION_CERT_ADMIN_URL sont requis.');
      }
      admin = new PrismaClient({ datasourceUrl: certAdminUrl, errorFormat: 'minimal' });
      // Deux connexions runtime distinctes : la course d'ouverture (preuve 2) oppose deux VRAIES
      // transactions concurrentes, jamais un aller-retour séquentiel.
      workerA = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
      workerB = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
      uowA = new PrismaAgentMissionUnitOfWork(workerA);
      uowB = new PrismaAgentMissionUnitOfWork(workerB);
      storeA = new PrismaJarvisProposalPayloadStore(workerA);
      workItems = new PrismaJarvisWorkItemsRepository(workerA);
      controllerA = tapController(uowA, workerA);
      controllerB = tapController(uowB, workerB);
      authorityA = new CertificationCustomerAuthority(workerA);
      await Promise.all([admin.$connect(), workerA.$connect(), workerB.$connect()]);
      await admin.$executeRaw`
        INSERT INTO public.companies (
          "id", "name", "legalForm", "siren", "siret", "trade", "vatRegime",
          "addrLine1", "addrZip", "addrCity"
        ) VALUES (
          ${companyId}, ${'Jarvis U1-e cert 11'}, ${'EI'},
          ${'903000011'}, ${'90300001100011'},
          ${'certification'}, ${'reel_normal'},
          ${'1 rue du Test'}, ${'75001'}, ${'Paris'}
        )
      `;
      await admin.$executeRaw`
        INSERT INTO public.companies (
          "id", "name", "legalForm", "siren", "siret", "trade", "vatRegime",
          "addrLine1", "addrZip", "addrCity"
        ) VALUES (
          ${neighborCompanyId}, ${'Jarvis U1-e voisin 12'}, ${'EI'},
          ${'903000012'}, ${'90300001200012'},
          ${'certification'}, ${'reel_normal'},
          ${'2 rue du Test'}, ${'75002'}, ${'Paris'}
        )
      `;
    }, 30_000);

    afterAll(async () => {
      await Promise.all([admin?.$disconnect(), workerA?.$disconnect(), workerB?.$disconnect()]);
    });

    it(
      'preuve 1 — découverte : le run ouvert sort avec sa présentation, le terminal ne sort plus, l’annuaire est owner-scopé',
      async () => {
        const owner: JarvisAdmissionOwner = {
          companyId,
          ownerUserId: freshOwner('decouverte'),
        };
        const customerId = await seedTargetCustomer(owner);
        const commandId = randomUUID();

        // (a) Un run SEMÉ puis PARKÉ : rien ne l'a fait avancer (aucun émetteur de résolution
        // n'existe encore en production) — c'est exactement l'état que l'appareil retrouve.
        const opened = await openRun(controllerA, owner, { commandId, customerId });
        const runId = opened.run.runId;
        expect(runId).toBe(deriveJarvisScreenRunId(owner, commandId));
        const reopened = await currentRun(controllerA, owner);
        expect(reopened.run).toEqual(opened.run);
        // Révision 2, et non 1 : l'ouverture est un DOUBLE maillon serveur — le semis, puis la
        // résolution de cible (§8) que nul humain ne peut émettre. Un run rendu ici à la
        // révision 1 signifierait qu'il est resté parké en `resolving_customer`, hors d'atteinte
        // de toute commande du canal tap.
        expect(reopened.run).toMatchObject({
          runId,
          kind: 'customer_contact',
          definitionVersion: CUSTOMER_CONTACT_DEFINITION_VERSION,
          status: 'active',
          revision: 2,
          terminalAt: null,
        });
        // La présentation existe DÈS l'ouverture : elle dit la phase et la cible, et n'offre
        // AUCUN geste (aucune proposition à confirmer) — jamais une carte orpheline.
        expect(reopened.presentation).toMatchObject({
          phase: 'preparing_proposal',
          intent: 'update',
          targetCustomerId: customerId,
          proposal: null,
          confirmation: null,
        });
        // La base dit la même chose que la route : l'annuaire ne rend pas un run qu'elle
        // n'aurait pas.
        await expect(requireRun(runId)).resolves.toMatchObject({
          kind: 'customer_contact',
          status: 'active',
          phase: 'preparing_proposal',
          revision: 2,
          terminalAt: null,
        });

        // (b) LECTURE STATELESS §5.2 : la découverte n'écrit rien — révision et journal sont
        // relus identiques après trois appels.
        const journalBefore = await auditEvents(runId);
        await currentRun(controllerA, owner);
        await currentRun(controllerA, owner);
        expect(await auditEvents(runId)).toEqual(journalBefore);
        await expect(requireRun(runId)).resolves.toMatchObject({ revision: 2 });

        // (c) Proposition PRÉSENTÉE : la carte sort avec ses champs, recomposés depuis la charge
        // scellée (G4) — le state durable ne porte que des digests.
        const fields = proposedFields({ city: 'Lyon', postalCode: '69003' });
        const { confirmationId } = await presentProposal({
          owner,
          runId,
          customerId,
          targetRevision: 1,
          expectedRevision: 2,
          fields,
        });
        const presented = await currentRun(controllerA, owner);
        expect(presented.run).toMatchObject({ runId, status: 'waiting_user', revision: 4 });
        expect(presented.presentation).toMatchObject({
          phase: 'awaiting_confirmation',
          intent: 'update',
          targetCustomerId: customerId,
          confirmation: { confirmationId, status: 'presented' },
        });
        expect(presented.presentation?.proposal?.fields).toEqual([
          {
            field: 'postal_code',
            label: 'Code postal',
            before: null,
            after: '69003',
            sensitiveField: 'address',
          },
          { field: 'city', label: 'Ville', before: null, after: 'Lyon', sensitiveField: 'address' },
        ]);

        // (d) OWNER-SCOPÉ, dans les deux sens. Le voisin a SON run vivant : chacun ne voit que le
        // sien, jamais celui de l'autre — la découverte ne traverse pas le tenant.
        const neighbor: JarvisAdmissionOwner = {
          companyId: neighborCompanyId,
          ownerUserId: freshOwner('voisin'),
        };
        const neighborCustomerId = await seedTargetCustomer(neighbor);
        const neighborRun = await openRun(controllerA, neighbor, {
          commandId: randomUUID(),
          customerId: neighborCustomerId,
        });
        const neighborCurrent = await currentRun(controllerA, neighbor);
        expect(neighborCurrent.run?.runId).toBe(neighborRun.run.runId);
        expect(neighborCurrent.run?.runId).not.toBe(runId);
        await expect(currentRun(controllerA, owner)).resolves.toMatchObject({ run: { runId } });

        // (e) TERMINAL : l'artisan annule depuis l'écran. Le run est fini — l'annuaire ne le rend
        // plus, et ce n'est pas « aucun run » deviné : la base porte bien son `terminalAt`.
        const cancelled = await asOwner(owner, () =>
          controllerA.submitCommand(runId, {
            kind: 'customer_contact',
            definitionVersion: CUSTOMER_CONTACT_DEFINITION_VERSION,
            commandId: randomUUID(),
            expectedRevision: 4,
            actionId: CUSTOMER_CONTACT_UPDATE_ACTION_ID,
            actionVersion: 1,
            command: { type: 'cancel_run', reason: 'user_cancelled' },
          }),
        );
        expect(cancelled.run.status).toBe('cancelled');
        expect(cancelled.run.terminalAt).not.toBeNull();
        const terminalRow = await requireRun(runId);
        expect(terminalRow.status).toBe('cancelled');
        expect(terminalRow.terminalAt).not.toBeNull();
        expect(await currentRun(controllerA, owner)).toEqual({ run: null, presentation: null });
        // Le voisin, lui, garde le sien : la clôture d'un run n'éteint pas l'annuaire du tenant
        // d'à côté.
        await expect(currentRun(controllerA, neighbor)).resolves.toMatchObject({
          run: { runId: neighborRun.run.runId },
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 2 — ouverture : le seed vient de la route, le rejeu ne sème rien, la course rend un seul run',
      async () => {
        const owner: JarvisAdmissionOwner = { companyId, ownerUserId: freshOwner('ouverture') };
        const customerId = await seedTargetCustomer(owner);
        const commandId = randomUUID();

        const opened = await openRun(controllerA, owner, { commandId, customerId });
        expect(opened.outcome).toBe('admitted');
        // Séquence 2 : le reçu rendu à l'écran est celui du SECOND maillon (la résolution), car
        // c'est lui qui décrit l'état où le run est vraiment arrivé.
        expect(opened.eventSequence).toBe(2);
        const runId = opened.run.runId;
        // L'identité du run est un FAIT SERVEUR dérivé de l'owner et du commandId mémoïsé.
        expect(runId).toBe(deriveJarvisScreenRunId(owner, commandId));

        // LA BASE : un run `customer_contact@1` d'intention update sur la cible demandée,
        // journalisé au CANAL réel du geste, et DÉJÀ SORTI de `resolving_customer`.
        const seeded = await requireRun(runId);
        expect(seeded).toMatchObject({
          kind: 'customer_contact',
          status: 'active',
          phase: 'preparing_proposal',
          revision: 2,
        });
        // La révision de cible est celle que l'admission a RELUE SOUS VERROU (§8), jamais une
        // valeur apportée par l'appelant — la route ne relit pas la fiche, elle ne pourrait pas
        // la prouver. La fiche naît à 1 : c'est donc 1 qui est scellé, parce que c'est vrai.
        expect(updateTargetOf(seeded)).toEqual({ customerId, revision: 1 });
        const seedEvents = await auditEvents(runId);
        expect(seedEvents).toHaveLength(2);
        expect(seedEvents[0]).toMatchObject({
          sequence: 1,
          eventType: 'cc_run_started',
          actor: 'user_tap',
          commandId,
        });
        // Le second événement porte un commandId DÉRIVÉ du premier : le rejeu de l'ouverture
        // rejoue les DEUX maillons à l'identique, sans jamais en semer un troisième.
        expect(seedEvents[1]).toMatchObject({
          sequence: 2,
          eventType: 'cc_customer_resolution_recorded',
          actor: 'user_tap',
        });
        expect(seedEvents[1]?.commandId).not.toBe(commandId);

        // REJEU du MÊME geste (reçu perdu, réseau coupé) : même run, reçu original, ZÉRO
        // écriture — c'est la condition du retry sans second run fantôme (§5.2/§5.4).
        const replayed = await openRun(controllerA, owner, { commandId, customerId });
        expect(replayed.outcome).toBe('replayed');
        expect(replayed.run.runId).toBe(runId);
        expect(replayed.eventSequence).toBe(2);
        expect(await auditEvents(runId)).toEqual(seedEvents);
        await expect(requireRun(runId)).resolves.toMatchObject({ revision: 2 });
        await expect(countRuns(owner)).resolves.toBe(1);

        // DEUX OUVERTURES CONCURRENTES d'un artisan qui n'a encore aucun run : deux commandId,
        // donc deux runId distincts, sur deux connexions. Le backstop de premier plan n'en
        // laisse passer qu'un — l'autre est refusé, nommé, et n'a rien écrit.
        const racer: JarvisAdmissionOwner = { companyId, ownerUserId: freshOwner('course') };
        const racerCustomerId = await seedTargetCustomer(racer);
        const firstCommandId = randomUUID();
        const secondCommandId = randomUUID();
        expect(firstCommandId).not.toBe(secondCommandId);
        const [first, second] = await Promise.allSettled([
          openRun(controllerA, racer, { commandId: firstCommandId, customerId: racerCustomerId }),
          openRun(controllerB, racer, { commandId: secondCommandId, customerId: racerCustomerId }),
        ]);
        const settled = [first, second];
        const winners = settled.filter((outcome) => outcome.status === 'fulfilled');
        const losers = settled.filter((outcome) => outcome.status === 'rejected');
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        const refusal = losers[0];
        if (refusal === undefined || refusal.status !== 'rejected') {
          throw new Error('Jarvis U1-e: la course n’a pas produit de refus.');
        }
        const rejection: unknown = refusal.reason;
        if (!(rejection instanceof HttpException)) {
          throw new Error(`Jarvis U1-e: refus non HTTP ${String(rejection)}`);
        }
        expect(rejection.getStatus()).toBe(409);
        expect(rejection.getResponse()).toEqual({
          ok: false,
          error: { kind: 'conflict', entity: 'jarvis_foreground', reason: 'foreground_busy' },
        });
        // LA BASE : un seul run pour cet artisan, celui du gagnant — le perdant n'a pas de ligne.
        await expect(countRuns(racer)).resolves.toBe(1);
        const winner = winners[0];
        if (winner === undefined || winner.status !== 'fulfilled') {
          throw new Error('Jarvis U1-e: la course n’a pas produit de gagnant.');
        }
        const winnerRunId = winner.value.run.runId;
        const loserRunId =
          winnerRunId === deriveJarvisScreenRunId(racer, firstCommandId)
            ? deriveJarvisScreenRunId(racer, secondCommandId)
            : deriveJarvisScreenRunId(racer, firstCommandId);
        await expect(auditRun(winnerRunId)).resolves.toMatchObject({ revision: 2 });
        await expect(auditRun(loserRunId)).resolves.toBeNull();
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 3 — relecture autoritaire : une mutation réelle entre présentation et confirm invalide la proposition, la suivante aboutit',
      async () => {
        const owner: JarvisAdmissionOwner = { companyId, ownerUserId: freshOwner('relecture') };
        const customerId = await seedTargetCustomer(owner);
        const executor = new JarvisCustomerEffectExecutor({
          admission: admissionPortOf(uowA),
          payloads: storeA,
          customers: authorityA,
        });
        const worker = dispatchWorker(executor, admissionPortOf(uowA));

        const opened = await openRun(controllerA, owner, {
          commandId: randomUUID(),
          customerId,
        });
        const runId = opened.run.runId;
        const staleFields = proposedFields({ city: 'Lyon', postalCode: '69003' });
        const { confirmationId, receipt } = await presentProposal({
          owner,
          runId,
          customerId,
          targetRevision: 1,
          expectedRevision: 2,
          fields: staleFields,
        });
        // Le hash que l'écran rejouera est CELUI QU'IL A REÇU : la carte confirme la proposition
        // qu'elle a montrée, elle ne recalcule rien de son côté.
        const staleProposalHash = receipt.presentation?.proposal?.proposalHash;
        if (staleProposalHash === undefined) {
          throw new Error('Jarvis U1-e: la présentation n’a pas rendu de proposalHash.');
        }
        expect(staleProposalHash).toBe(stateOf(await requireRun(runId)).proposal?.proposalHash);

        // LA MUTATION — pendant que la carte est à l'écran, l'artisan corrige l'e-mail de la
        // fiche par la voie canonique. `email` compose le champ sensible `recipient` (§9.1), et
        // l'écriture incrémente la révision : c'est CE fait, relu sous verrou par l'admission,
        // qui rendra la proposition stale. Aucune valeur revalidée n'est fabriquée ici.
        const mutatedEmail = 'contact@marie-dupont.test';
        const before = await authorityA.readCustomer({
          companyId: owner.companyId,
          ownerUserId: owner.ownerUserId,
          customerId,
        });
        if (before === null) throw new Error('Jarvis U1-e: fiche cible introuvable.');
        await expect(
          authorityA.updateCustomer(
            { companyId: owner.companyId, ownerUserId: owner.ownerUserId, customerId },
            { ...before.fields, email: mutatedEmail },
          ),
        ).resolves.toEqual({ status: 'written' });
        await expect(auditCustomer(customerId)).resolves.toMatchObject({
          email: mutatedEmail,
          revision: 2,
        });

        // LE CONFIRM — trois clés au wire (le corps exact de la route les impose), aucune
        // révision, aucun digest : le client ne peut pas certifier sa propre cible.
        const writesBefore = authorityA.writes;
        const invalidatedReceipt = await asOwner(owner, () =>
          controllerA.submitCommand(runId, {
            kind: 'customer_contact',
            definitionVersion: CUSTOMER_CONTACT_DEFINITION_VERSION,
            commandId: randomUUID(),
            expectedRevision: 4,
            actionId: CUSTOMER_CONTACT_UPDATE_ACTION_ID,
            actionVersion: 1,
            command: { type: 'confirm', confirmationId, proposalHash: staleProposalHash },
          }),
        );
        expect(invalidatedReceipt.outcome).toBe('admitted');
        // L'écran repart en préparation : plus de proposition, donc plus AUCUN geste offert.
        expect(invalidatedReceipt.presentation).toMatchObject({
          phase: 'preparing_proposal',
          proposal: null,
          confirmation: null,
        });

        // LA BASE : proposition INVALIDÉE, jamais consommée ; zéro work item, zéro écriture
        // métier ; et la révision journalisée vient de la BASE (2), pas du wire.
        const invalidated = await requireRun(runId);
        expect(invalidated.phase).toBe('preparing_proposal');
        const invalidatedState = stateOf(invalidated);
        expect(invalidatedState.confirmation?.status).toBe('invalidated');
        expect(invalidatedState.proposal).toBeNull();
        // L'intention porte désormais la cible RELUE : la prochaine proposition devra la sceller.
        expect(updateTargetOf(invalidated).revision).toBe(2);
        const invalidationEvents = await auditEvents(runId);
        const lastEvent = invalidationEvents[invalidationEvents.length - 1];
        expect(lastEvent?.eventType).toBe('cc_proposal_invalidated');
        expect(lastEvent?.actor).toBe('user_tap');
        expect(lastEvent?.data).toMatchObject({
          cause: 'stale_target',
          confirmationId,
          revalidatedTargetRevision: 2,
        });
        await expect(countWorkItems(runId)).resolves.toBe(0);
        expect(authorityA.writes).toBe(writesBefore);
        await expect(auditCustomer(customerId)).resolves.toMatchObject({
          addrCity: 'Paris',
          revision: 2,
        });

        // LA PROPOSITION SUIVANTE, à jour de la mutation : elle, aboutit. Le run est en
        // `preparing_proposal` à la révision 5 — la nouvelle proposition scelle la révision 2.
        const freshFields = proposedFields({ city: 'Lyon', postalCode: '69003' });
        const freshProposalId = randomUUID();
        const freshConfirmationId = randomUUID();
        await sealPayload({ owner, runId, proposalId: freshProposalId, fields: freshFields });
        expectAdmission(
          await admitViaPort(uowA, {
            owner,
            runId,
            expectedRevision: 5,
            command: {
              type: 'stage_proposal',
              proposalId: freshProposalId,
              confirmationId: freshConfirmationId,
              fieldsDigest: computeCustomerContactFieldsDigest(freshFields),
              sensitiveDigest: computeCustomerContactSensitiveDigest(freshFields),
              targetRevision: 2,
            },
          }),
          'admitted',
        );
        const presentedAgain = await asOwner(owner, () =>
          controllerA.submitCommand(runId, {
            kind: 'customer_contact',
            definitionVersion: CUSTOMER_CONTACT_DEFINITION_VERSION,
            commandId: randomUUID(),
            expectedRevision: 6,
            actionId: CUSTOMER_CONTACT_UPDATE_ACTION_ID,
            actionVersion: 1,
            command: {
              type: 'record_presentation_ack',
              confirmationId: freshConfirmationId,
              ack: 'screen_ack',
            },
          }),
        );
        const freshProposalHash = presentedAgain.presentation?.proposal?.proposalHash;
        if (freshProposalHash === undefined) {
          throw new Error('Jarvis U1-e: seconde présentation sans proposalHash.');
        }
        const confirmed = await asOwner(owner, () =>
          controllerA.submitCommand(runId, {
            kind: 'customer_contact',
            definitionVersion: CUSTOMER_CONTACT_DEFINITION_VERSION,
            commandId: randomUUID(),
            expectedRevision: 7,
            actionId: CUSTOMER_CONTACT_UPDATE_ACTION_ID,
            actionVersion: 1,
            command: {
              type: 'confirm',
              confirmationId: freshConfirmationId,
              proposalHash: freshProposalHash,
            },
          }),
        );
        expect(confirmed.outcome).toBe('admitted');
        // La cible n'a plus bougé depuis ce sceau : la MÊME relecture le confirme et la
        // proposition se consomme. La garde ne bloque pas ce qui n'a pas dérivé.
        const consumed = await requireRun(runId);
        expect(consumed.phase).toBe('committing');
        expect(stateOf(consumed).confirmation?.status).toBe('consumed');
        await expect(countWorkItems(runId)).resolves.toBe(1);

        // L'EFFET — worker RÉEL, exécuteur RÉEL, use case canonique : la fiche est RELUE en base.
        const tick = await worker.runForCompany(companyId);
        expect(tick.claimed).toBe(1);
        expect(tick.executed).toBe(1);
        expect(tick.failures).toBe(0);
        const edited = await auditCustomer(customerId);
        // La ville proposée a recouvert la fiche ; la correction de l'artisan a SURVÉCU (une
        // proposition périmée n'écrase jamais) ; la révision suit l'écriture canonique.
        expect(edited).toMatchObject({
          name: 'Marie Dupont',
          addrLine1: '12 rue des Lilas',
          addrZip: '69003',
          addrCity: 'Lyon',
          email: mutatedEmail,
          revision: 3,
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "preuve 4 — annuaire de rétention : l'autorité voit les propriétaires échus, RIEN d'autre, et la purge efface vraiment",
      async () => {
        // Deux propriétaires du MÊME tenant, aux échéances opposées, et un troisième chez le
        // voisin. La question posée à l'annuaire est exactement celle du balayage : « qui, ICI,
        // a du PII échu ? » — une question à laquelle aucun rôle tenanté ne peut répondre.
        const expiredOwner: JarvisAdmissionOwner = {
          companyId,
          ownerUserId: freshOwner('retention-echu'),
        };
        const livingOwner: JarvisAdmissionOwner = {
          companyId,
          ownerUserId: freshOwner('retention-vivant'),
        };
        const neighborOwner: JarvisAdmissionOwner = {
          companyId: neighborCompanyId,
          ownerUserId: freshOwner('retention-voisin'),
        };
        const fields = proposedFields({
          city: 'Lyon',
          postalCode: '69003',
          email: 'retention@example.test',
        });
        // Le CHECK `retentionExpiresAt > createdAt` REFUSE en base une échéance déjà échue : on
        // ne peut donc pas fabriquer une ligne échue d'un trait de plume, et c'est heureux —
        // l'échéance est vraiment portée par l'horloge de la base. On scelle court, puis on
        // laisse le temps passer POUR DE VRAI.
        const shortRetentionMs = 1_200;
        // Le magasin est en FK sur le run : une charge orpheline ne s'écrit pas (le scellement
        // rendrait `unavailable`). Chaque propriétaire ouvre donc son run PAR LA ROUTE, comme
        // l'artisan le ferait — la preuve porte sur des charges qui existent vraiment.
        const sealShortLived = async (
          owner: JarvisAdmissionOwner,
          controller: JarvisRunController,
        ): Promise<string> => {
          const customerId = await seedTargetCustomer(owner);
          const opened = await openRun(controller, owner, {
            commandId: randomUUID(),
            customerId,
          });
          expect(opened.outcome).toBe('admitted');
          const runId = opened.run.runId;
          const proposalId = randomUUID();
          const sealed = await storeA.sealProposalPayload({
            companyId: owner.companyId,
            ownerUserId: owner.ownerUserId,
            runId,
            proposalId,
            fieldsDigest: computeCustomerContactFieldsDigest(fields),
            sensitiveDigest: computeCustomerContactSensitiveDigest(fields),
            fields,
            retentionExpiresAt: new Date(Date.now() + shortRetentionMs).toISOString(),
          });
          expect(sealed.status).toBe('sealed');
          return runId;
        };
        // Le vivant est semé EN PREMIER, pour la durée nominale : il ne doit JAMAIS apparaître.
        const livingCustomerId = await seedTargetCustomer(livingOwner);
        const livingRun = await openRun(controllerA, livingOwner, {
          commandId: randomUUID(),
          customerId: livingCustomerId,
        });
        expect(livingRun.outcome).toBe('admitted');
        await sealPayload({
          owner: livingOwner,
          runId: livingRun.run.runId,
          proposalId: randomUUID(),
          fields,
        });
        // Les charges COURTES viennent en DERNIER : leur fenêtre de vie ne couvre plus que
        // l'assertion qui suit, jamais une dizaine de transactions PostgreSQL — sinon la preuve
        // serait un pari sur la vitesse de la machine, et elle casserait sous charge.
        await sealShortLived(expiredOwner, controllerA);
        await sealShortLived(neighborOwner, controllerB);

        // AVANT l'échéance : l'annuaire ne rend RIEN. C'est la moitié de la garde — un annuaire
        // qui rendrait les propriétaires actifs cartographierait les usagers du tenant.
        expect(await storeA.listRetentionOwners(companyId, 50)).toEqual([]);

        // ATTENTE CONDITIONNELLE, jamais une durée devinée : on interroge l'annuaire jusqu'à ce
        // que la base — seule détentrice de l'horloge qui fait foi — déclare la charge échue.
        const echeance = Date.now() + 30_000;
        let owners: readonly string[] = [];
        do {
          owners = await storeA.listRetentionOwners(companyId, 50);
          if (owners.length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        } while (Date.now() < echeance);

        // Le propriétaire échu, et lui SEUL. Ni le vivant du même tenant, ni le voisin.
        expect(owners).toEqual([expiredOwner.ownerUserId]);
        expect(await storeA.listRetentionOwners(neighborCompanyId, 50)).toEqual([
          neighborOwner.ownerUserId,
        ]);

        // L'AUTORITÉ NE PEUT PAS LIRE LE CONTENU. Le GRANT par colonne exclut `payload` : même
        // assumée directement, même sous SECURITY DEFINER, la PII lui est refusée par la base
        // (42501) — le fichier de migration n'est pas le gardien, le privilège l'est.
        // ORACLE DU CATALOGUE, jamais une tentative. Une sonde qui ferait `SET ROLE` puis
        // `SELECT payload` mourrait sur le SET ROLE lui-même (l'auditeur n'est pas membre de
        // l'autorité) et passerait pour de MAUVAISES raisons : « permission denied » aurait été
        // rendu par le mauvais refus. `has_column_privilege` interroge le privilège RÉEL, colonne
        // par colonne, sans rien assumer.
        const [privileges] = await admin.$queryRaw<
          Array<{ payload: boolean; owner: boolean; company: boolean; expiry: boolean }>
        >`
          SELECT has_column_privilege(
                   ${RETENTION_DIRECTORY_ROLE}, 'public.jarvis_proposal_payloads', 'payload', 'SELECT'
                 ) AS "payload",
                 has_column_privilege(
                   ${RETENTION_DIRECTORY_ROLE}, 'public.jarvis_proposal_payloads', 'ownerUserId', 'SELECT'
                 ) AS "owner",
                 has_column_privilege(
                   ${RETENTION_DIRECTORY_ROLE}, 'public.jarvis_proposal_payloads', 'companyId', 'SELECT'
                 ) AS "company",
                 has_column_privilege(
                   ${RETENTION_DIRECTORY_ROLE}, 'public.jarvis_proposal_payloads', 'retentionExpiresAt', 'SELECT'
                 ) AS "expiry"
        `;
        // La PII lui est refusée par le privilège lui-même : même SECURITY DEFINER, même en
        // réécrivant la fonction, l'autorité ne peut pas atteindre `payload`.
        expect(privileges?.payload).toBe(false);
        // Et elle possède EXACTEMENT les trois coordonnées dont le balayage a besoin.
        expect(privileges?.owner).toBe(true);
        expect(privileges?.company).toBe(true);
        expect(privileges?.expiry).toBe(true);

        // Le rôle RUNTIME ne peut pas devenir l'autorité : il n'a que le droit d'EXÉCUTER la
        // fonction. Sans ce verrou, `bob_app` lirait le magasin d'autrui en une ligne de SQL.
        let assumeRefusal: unknown = null;
        try {
          await workerA.$executeRawUnsafe('SET ROLE bob_jarvis_payload_retention_directory');
        } catch (cause) {
          assumeRefusal = cause;
        }
        expect(String(assumeRefusal)).toMatch(/permission denied|42501/i);

        // Bornes d'entrée de la fonction : une demande hors plafond est REFUSÉE (22023), jamais
        // rognée en silence — un balayage qui croit avoir tout vu est pire qu'un balayage en
        // panne. La borne applicative refuse déjà avant l'aller-retour, on prouve les DEUX.
        await expect(storeA.listRetentionOwners(companyId, 51)).rejects.toThrow(
          /Borne de l'annuaire de rétention/,
        );
        let boundRefusal: unknown = null;
        try {
          // Par le rôle APPLICATIF : c'est le seul à qui l'allowlist d'EXECUTE accorde l'appel,
          // et SECURITY DEFINER lui fait franchir le contrôle d'identité. Ce qui l'arrête ici est
          // donc bien la BORNE, pas un privilège.
          await workerA.$queryRawUnsafe(
            `SELECT * FROM public.list_jarvis_payload_retention_owners_v1('${companyId}', 51)`,
          );
        } catch (cause) {
          boundRefusal = cause;
        }
        expect(String(boundRefusal)).toMatch(/22023|rejected/i);

        // L'ACL est une ALLOWLIST EXACTE : même l'auditeur de certification — un rôle BYPASSRLS,
        // le plus privilégié du harnais après le déployeur — n'a pas EXECUTE. Un annuaire de
        // propriétaires atteignable par un grantee arbitraire serait une fuite de tenant.
        let auditorRefusal: unknown = null;
        try {
          await admin.$queryRawUnsafe(
            `SELECT * FROM public.list_jarvis_payload_retention_owners_v1('${companyId}', 10)`,
          );
        } catch (cause) {
          auditorRefusal = cause;
        }
        expect(String(auditorRefusal)).toMatch(/permission denied for function|42501/i);

        // BOUCLAGE PRODUIT : le service RÉEL, avec ses vraies dépendances, efface le PII échu et
        // laisse le vivant intact. Sans annuaire il rendait `owner_directory_absent` et la
        // rétention n'était qu'une colonne (le trou que ce lot ferme).
        const purge = new JarvisProposalPayloadPurgeService(
          {
            createJarvisProposalPayloadStore: () => storeA,
          } as unknown as Persistence,
          {
            listCompanyIds: async () => [companyId, neighborCompanyId],
          } as unknown as ScheduledTenantDirectory,
          new AppLogger(),
          storeA,
        );
        const summary = await purge.sweep();
        expect(summary.skipped).toBeNull();
        expect(summary.failures).toBe(0);
        expect(summary.tenants).toBe(2);
        // Les propriétaires échus des DEUX tenants : celui de cette preuve chez l'artisan, celui
        // de cette preuve chez le voisin. Les charges vivantes n'exposent personne.
        expect(summary.owners).toBe(2);
        expect(summary.purged).toBe(2);

        // Relecture par l'AUDITEUR, jamais le seul résumé rendu : le magasin ne garde que le
        // vivant, et l'annuaire s'est tu — il n'y a plus rien d'échu à découvrir.
        // Bornée aux TROIS propriétaires de cette preuve : les charges des preuves 1 et 3 vivent
        // dans les mêmes sociétés et ne sont PAS échues — les balayer serait le vrai défaut.
        const scoped = [expiredOwner, livingOwner, neighborOwner].map((one) => one.ownerUserId);
        const remaining = await admin.$queryRaw<Array<{ ownerUserId: string }>>`
          SELECT "ownerUserId" FROM public.jarvis_proposal_payloads
           WHERE "ownerUserId" = ANY (${scoped})
           ORDER BY "ownerUserId"
        `;
        expect(remaining.map((row) => row.ownerUserId)).toEqual([livingOwner.ownerUserId]);
        expect(await storeA.listRetentionOwners(companyId, 50)).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "preuve 5 — U1-f : la chaîne ARMÉE, adaptateurs de PRODUCTION — l'annuaire d'autorité trouve le travail dû et l'effet s'exécute",
      async () => {
        // CE QUE CETTE PREUVE ÉTABLIT, et qu'aucune autre ne pouvait établir : le worker de
        // production, câblé sur les TROIS adaptateurs réels (repository, annuaire SECURITY
        // DEFINER, autorité métier sur les use cases canoniques), trouve SEUL le travail dû et
        // écrit la fiche. Jusqu'à ce lot ces trois liaisons n'existaient pas : le tick rendait
        // `dependencies_absent` et un `confirm` d'artisan n'écrivait JAMAIS rien.
        const owner: JarvisAdmissionOwner = { companyId, ownerUserId: freshOwner('chaine-armee') };
        const customerId = await seedTargetCustomer(owner);
        const opened = await openRun(controllerA, owner, {
          commandId: randomUUID(),
          customerId,
        });
        expect(opened.outcome).toBe('admitted');
        const runId = opened.run.runId;

        // L'ANNUAIRE DE PRODUCTION, avant tout travail : un run ouvert n'a AUCUN work item, donc
        // il ne doit PAS apparaître. La borne de la policy n'est pas décorative — sans elle,
        // l'autorité énumérerait tous les runs actifs du tenant.
        const directory = new PrismaJarvisDispatchRunDirectory(workerA);
        const harnessPersistence = {
          companies: {
            findById: async (id: string) => {
              const rows = await admin.$queryRaw<Array<{ closedAt: Date | null }>>`
                SELECT "closedAt" FROM public.companies WHERE "id" = ${id}
              `;
              const row = rows[0];
              return row === undefined ? null : { isClosed: () => row.closedAt !== null };
            },
          },
          runWithTenant: <T>(tenantId: string, work: () => Promise<T>): Promise<T> =>
            workerA.withTenant(tenantId, () => work()),
        } as unknown as Persistence;
        const auRepos = await directory.listDispatchCoordinates(companyId, 50);
        expect(auRepos.some((coordinate) => coordinate.runId === runId)).toBe(false);

        // Parcours jusqu'à la confirmation, par les ROUTES (le canal réel de l'artisan).
        const fields = proposedFields({ city: 'Lyon', postalCode: '69003' });
        const { confirmationId } = await presentProposal({
          owner,
          runId,
          customerId,
          targetRevision: 1,
          expectedRevision: 2,
          fields,
        });
        const presented = await requireRun(runId);
        const proposalHash = stateOf(presented).proposal?.proposalHash;
        if (proposalHash === undefined) throw new Error('Jarvis U1-f: proposition attendue');
        const confirmed = await asOwner(owner, () =>
          controllerA.submitCommand(runId, {
            kind: 'customer_contact',
            definitionVersion: CUSTOMER_CONTACT_DEFINITION_VERSION,
            commandId: randomUUID(),
            expectedRevision: presented.revision,
            actionId: CUSTOMER_CONTACT_UPDATE_ACTION_ID,
            actionVersion: 1,
            command: { type: 'confirm', confirmationId, proposalHash },
          }));
        expect(confirmed.outcome).toBe('admitted');
        await expect(countWorkItems(runId)).resolves.toBe(1);

        // L'ANNUAIRE LE TROUVE MAINTENANT — sans qu'on lui ait dit QUI est l'owner. C'est la
        // question à laquelle aucun rôle tenanté ne peut répondre (les policies de
        // `jarvis_work_items` sont owner-scopées), et c'est exactement celle du worker.
        const duList = await directory.listDispatchCoordinates(companyId, 50);
        const trouve = duList.find((coordinate) => coordinate.runId === runId);
        expect(trouve).toEqual({ companyId, ownerUserId: owner.ownerUserId, runId });

        // Le voisin ne voit RIEN de ce travail : l'autorité ne traverse jamais le tenant.
        await expect(
          directory.listDispatchCoordinates(neighborCompanyId, 50),
        ).resolves.toEqual(expect.not.arrayContaining([expect.objectContaining({ runId })]));

        // LE WORKER, câblé sur les DEUX adaptateurs que ce lot livre : l'annuaire d'autorité
        // (SECURITY DEFINER) et l'autorité métier (use cases canoniques). Le repository de
        // dispatch est déjà le vrai (`workItems`).
        //
        // SEULE la lecture de `companies` reste celle du harnais, et c'est une limite du HARNAIS,
        // pas du lot : ce cluster crée une surface `companies` N-1 volontairement réduite (id,
        // name, siren, closedAt…), alors que `PrismaCompanyRepository` projette le schéma COURANT
        // — il y meurt sur `companies.apeCode does not exist`. Le remplacer ici prouverait la
        // complétude du harnais, pas celle de la chaîne. La lecture réelle de société est par
        // ailleurs exercée par toute la suite API.
        const productionWorker = new JarvisWorkItemDispatchService(
          harnessPersistence,
          { listCompanyIds: async () => [companyId] } as unknown as ScheduledTenantDirectory,
          new AppLogger(),
          workItems,
          directory,
          admissionPortOf(uowA),
          new Map<string, JarvisEffectExecutor>([
            [
              jarvisEffectExecutorKey(CUSTOMER_CONTACT_UPDATE_ACTION_ID, 1),
              new JarvisCustomerEffectExecutor({
                admission: admissionPortOf(uowA),
                payloads: storeA,
                customers: new PrismaJarvisCustomerEffectAuthority(workerA),
              }),
            ],
          ]),
        );
        const tick = await productionWorker.runForCompany(companyId);
        expect(tick).toMatchObject({ failures: 0, claimed: 1, executed: 1 });

        // LA FICHE EST ÉCRITE — relue par l'auditeur, jamais le seul résumé du tick. Et sa
        // révision a été incrémentée par le use case CANONIQUE : c'est cet entier que la garde
        // §9.1 compare au sceau d'une proposition, donc la parité humain↔Bob est réelle.
        const edited = await auditCustomer(customerId);
        expect(edited).toMatchObject({ addrCity: 'Lyon', addrZip: '69003', revision: 2 });

        // LE RUN EST REFERMÉ, dans le MÊME tick : exécution, résultat persisté, PUIS signal
        // acquitté au run. C'est ce dernier maillon qui manquait — le reçu de succès d'un
        // `customer_contact` exige l'identité ET la révision écrites, que le worker ne pouvait
        // pas construire ; il les demande désormais à l'exécuteur, qui les RELIT.
        const acheve = await requireRun(runId);
        expect(acheve.status).not.toBe('active');
        expect(acheve.phase).toBe('completed');

        const etatItems = await admin.$queryRaw<
          Array<{
            status: string;
            resultDigest: string | null;
            signalAppliedAt: Date | null;
            leaseExpiresAt: Date | null;
            nextAttemptAt: Date | null;
          }>
        >`
          SELECT "status", "resultDigest", "signalAppliedAt", "leaseExpiresAt", "nextAttemptAt"
            FROM public.jarvis_work_items WHERE "runId" = ${runId}::uuid
        `;
        // Le work item est RÉGLÉ : résultat persisté ET signal appliqué. Tant que ce dernier
        // manquait, la ligne restait éternellement « due » — un effet réussi que le run
        // n'apprenait jamais.
        expect(etatItems).toHaveLength(1);
        expect(etatItems[0]?.status).toBe('succeeded');
        expect(etatItems[0]?.signalAppliedAt).not.toBeNull();

        // Le travail est CONSOMMÉ : l'annuaire se tait, il n'a plus rien à orienter.
        const apres = await directory.listDispatchCoordinates(companyId, 50);
        expect(apres.some((coordinate) => coordinate.runId === runId)).toBe(false);

        // Bornes de l'annuaire : une demande hors plafond est REFUSÉE, jamais rognée en silence.
        await expect(directory.listDispatchCoordinates(companyId, 51)).rejects.toThrow(
          /Borne de l'annuaire de dispatch/,
        );
      },
      TEST_TIMEOUT_MS,
    );

    /**
     * Worker de dispatch RÉEL, câblé sur les autorités réelles. Deux collaborateurs viennent du
     * harnais parce que leur implémentation de production arrive avec le module (vague B) :
     * l'annuaire de coordonnées (ici une LECTURE RÉELLE de `jarvis_work_items` par l'auditeur) et
     * la surface `Persistence` consommée par la revalidation (`companies.findById`).
     */
    function dispatchWorker(
      executor: JarvisEffectExecutor,
      admission: JarvisAdmissionUnitOfWorkPort,
    ): JarvisWorkItemDispatchService {
      const persistence = {
        companies: {
          findById: async (id: string) => {
            const rows = await admin.$queryRaw<Array<{ closedAt: Date | null }>>`
              SELECT "closedAt" FROM public.companies WHERE "id" = ${id}
            `;
            const row = rows[0];
            return row === undefined ? null : { isClosed: () => row.closedAt !== null };
          },
        },
        runWithTenant: <T>(tenantId: string, work: () => Promise<T>): Promise<T> =>
          workerA.withTenant(tenantId, () => work()),
      } as unknown as Persistence;
      const directory: JarvisDispatchRunDirectoryPort = {
        listDispatchCoordinates: async (tenantId: string, limit: number) => {
          const rows = await admin.$queryRaw<Array<{ ownerUserId: string; runId: string }>>`
            SELECT DISTINCT "ownerUserId", "runId"
              FROM public.jarvis_work_items
             WHERE "companyId" = ${tenantId}
               AND "signalAppliedAt" IS NULL
             ORDER BY "runId"
             LIMIT ${limit}
          `;
          return rows.map((row) => ({
            companyId: tenantId,
            ownerUserId: row.ownerUserId,
            runId: row.runId,
          }));
        },
      };
      return new JarvisWorkItemDispatchService(
        persistence,
        { listCompanyIds: async () => [companyId] } as unknown as ScheduledTenantDirectory,
        new AppLogger(),
        workItems,
        directory,
        admission,
        new Map<string, JarvisEffectExecutor>([
          [jarvisEffectExecutorKey(CUSTOMER_CONTACT_UPDATE_ACTION_ID, 1), executor],
        ]),
      );
    }
  },
);

/**
 * Autorité métier de certification : elle ne SIMULE rien — elle appelle les use cases canoniques
 * de la fiche client (`Customer.of` + `PrismaCustomerRepository.save` à la création, le use case
 * `UpdateCustomer` à l'édition), dans une portée tenant, exactement comme le fera l'adapter de la
 * vague B. Le compteur d'écritures sert la preuve « la proposition invalidée n'a rien écrit ».
 */
class CertificationCustomerAuthority implements JarvisCustomerEffectAuthority {
  public writes = 0;

  constructor(private readonly prisma: PrismaService) {}

  async readCustomer(target: JarvisCustomerEffectTarget): Promise<JarvisCustomerSnapshot | null> {
    const customer = await this.prisma.withTenant(target.companyId, () =>
      new PrismaCustomerRepository(this.prisma).findById(target.customerId),
    );
    if (customer === null) return null;
    const { id, companyId, ...fields } = customer.toProps();
    void id;
    void companyId;
    return { customerId: target.customerId, fields };
  }

  async createCustomer(
    target: JarvisCustomerEffectTarget,
    fields: JarvisCustomerFields,
  ): Promise<JarvisCustomerWriteResult> {
    const created = Customer.of({ id: target.customerId, companyId: target.companyId, ...fields });
    if (!created.ok) {
      return { status: 'refused', reasonCode: `domain_${created.error.code.toLowerCase()}` };
    }
    this.writes += 1;
    await this.prisma.withTenant(target.companyId, () =>
      new PrismaCustomerRepository(this.prisma).save(created.value),
    );
    return { status: 'written' };
  }

  async updateCustomer(
    target: JarvisCustomerEffectTarget,
    fields: JarvisCustomerFields,
  ): Promise<JarvisCustomerWriteResult> {
    this.writes += 1;
    const result = await this.prisma.withTenant(target.companyId, () =>
      new UpdateCustomer({
        customers: new PrismaCustomerRepository(this.prisma),
        quotes: new PrismaQuoteRepository(this.prisma),
        invoices: new PrismaInvoiceRepository(this.prisma),
      }).execute({ id: target.customerId, companyId: target.companyId, ...fields }),
    );
    return result.ok ? { status: 'written' } : { status: 'refused', reasonCode: 'domain_refused' };
  }
}

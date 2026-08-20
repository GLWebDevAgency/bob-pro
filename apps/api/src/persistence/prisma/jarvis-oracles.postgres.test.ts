/**
 * Jarvis U1-d — ORACLES des callers réels (SPEC_U1D_CALLERS_REELS_20260819 §5 preuves 1-3 et 5,
 * spec Jarvis §19.3/§19.4). Les suites U1-c prouvaient LA TRANSACTION ; celle-ci prouve LES
 * APPELANTS : que la voix, le tap et l'écran arrivent au MÊME endroit, et que ce qu'ils
 * produisent ensemble atterrit vraiment dans la fiche client.
 *
 * Rien n'est simulé : chaque preuve passe par le VRAI port d'admission
 * (`uow.runJarvisAdmission` / `runJarvisSystemAdmission` / `readJarvisStateless`), le VRAI
 * magasin de charges scellées, le VRAI repository de dispatch, le VRAI worker
 * (`JarvisWorkItemDispatchService`) et le VRAI exécuteur d'effet, dont l'autorité métier appelle
 * les use cases CANONIQUES de la fiche client (`Customer.of` + `customers.save` ; `UpdateCustomer`
 * @bob/core). Chaque assertion RELIT LA BASE par l'auditeur — jamais le seul résultat rendu.
 *
 *  (1) AUTORITÉ DU TAP §14 (greffe G1) — `authenticated_principal` est admis SOUS LE CÂBLAGE DE
 *      runtime (`allowCertificationAuthority: false`), sous policy lifecycle test-only et sans
 *      aucune lease Realtime : c'est ce
 *      qui permet à un run parké de se reprendre à l'écran après la mort de la session vocale.
 *      Un hash de liaison malformé, l'autorité de harnais hors harnais et une source inconnue
 *      (le bras `default` du switch exhaustif) sont refusés `capability_rejected` — chacun avec
 *      SON motif, et ZÉRO ligne écrite.
 *
 *  (2) ORACLE VOIX/TAP §19.3 — trois runs conduits par le MÊME script : l'un entièrement à la
 *      VOIX (lease Realtime RÉELLE, `realtime_capability`, commandId = `turnId` dérivé serveur
 *      `deriveRealtimeTurnId`), l'autre entièrement au TAP (bearer authentifié, UUID v4 minté
 *      client et mémoïsé par tour §5.4), le troisième MIXTE (ouvert à la voix, terminé à
 *      l'écran). L'oracle compare TOUT SAUF les colonnes de CANAL (`actor`, `commandId`) : le
 *      reste des journaux et des états normalisés est STRICTEMENT égal, la seule autre différence
 *      admise étant la MODALITÉ du reçu de présentation (`voice_presentation_ack` vs
 *      `screen_ack`, table §7.0). Les colonnes de canal, elles, sont assertées DISCRIMINANTES :
 *      la voix journalise `user_voice`, le tap `user_tap`, et le run mixte porte les deux — dans
 *      l'ordre des tours qui les ont réellement produits. Une PREUVE NÉGATIVE ferme la boucle :
 *      les journaux acteur INCLUS doivent DIFFÉRER, donc un acteur redevenu constant (le défaut
 *      `user_tap` de la revue C12) rougirait ici. La voix n'est jamais plus permissive : la même
 *      confirmation prématurée est refusée à l'identique sur les deux canaux, sans écriture.
 *
 *  (3) DOUBLE APPAREIL (G5) — deux appareils authentifiés confirment LA MÊME proposition à la
 *      MÊME révision attendue, sur deux connexions concurrentes : un seul `admitted`, le perdant
 *      `stale_revision`/`command_conflict`, EXACTEMENT un événement et EXACTEMENT un work item
 *      — jamais deux effets pour une décision. Le perdant se rafraîchit par la lecture stateless
 *      (oracle = la base, jamais l'écran).
 *
 *  (4) E2E §19.4 n°1 — parcours complet en base : créer un client (admission → worker → exécuteur
 *      → fiche RÉELLEMENT écrite), puis le modifier avec une MUTATION D'E-MAIL glissée entre la
 *      présentation et la confirmation : la confirmation est `invalidated` (jamais `consumed`),
 *      zéro work item, zéro écriture métier — puis une nouvelle proposition, elle, aboutit, et la
 *      mutation de l'artisan SURVIT à l'effet. U1-e §2 : la dérive n'est plus FABRIQUÉE — le
 *      confirm ne porte que trois clés, l'admission relit la fiche sous verrou et dérive son
 *      digest sensible, et c'est la révision INCRÉMENTÉE en base par l'écriture canonique qui
 *      fait mordre la garde §9.1.
 *
 *  (5) ORACLE DU PARCOURS DE MODIFICATION (U1-e §2, §5 étage 0) — le MÊME script d'oracle, cette
 *      fois en `update` sur une cible RÉELLE partagée : voix et tap produisent encore un seul et
 *      même journal hors colonnes de CANAL, sceau de cible COMPRIS. Ce sceau est ensuite prouvé
 *      RELU : il égale le digest recalculé par l'auditeur depuis les colonnes sensibles §9.1 de
 *      la fiche, et diffère du digest des champs proposés (domaines séparés). Chaque run porte
 *      un work item de MODIFICATION, et la fiche n'a pas bougé d'un cran.
 *
 * Même harnais que jarvis-admission.postgres.test.ts : gates env, base jetable, sociétés créées
 * par l'auditeur, fingerprints déterministes, clients Prisma `errorFormat: 'minimal'`.
 */
import { randomUUID } from 'node:crypto';

import {
  CUSTOMER_CONTACT_CREATE_ACTION_ID,
  CUSTOMER_CONTACT_UPDATE_ACTION_ID,
  computeCustomerContactFieldsDigest,
  computeCustomerContactProposalHash,
  computeCustomerContactSensitiveDigest,
  computeCustomerContactTargetSensitiveDigest,
  deriveRealtimeTurnId,
  sha256Hex,
  type AgentMissionFingerprintPort,
  type AgentMissionOwner,
  type AgentMissionRealtimeAuthorityProof,
  type CustomerContactProposedFieldsV1,
  type JarvisAdmissionAuthority,
  type JarvisAdmissionOwner,
  type JarvisAdmissionResult,
  type JarvisAdmissionUnitOfWorkPort,
  type JarvisRunEnvelope,
  type JarvisStatelessReadResult,
  type JarvisSystemAdmissionEnvelope,
  type JarvisUserAdmissionEnvelope,
} from '@bob/core';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  JarvisCustomerEffectExecutor,
  deriveJarvisEffectCustomerId,
  jarvisCustomerEffectSuccessDigest,
} from '../../jobs/jarvis-customer-effect.executor';
import {
  JarvisWorkItemDispatchService,
  jarvisEffectExecutorKey,
  type JarvisDispatchRunDirectoryPort,
  type JarvisEffectExecutor,
} from '../../jobs/jarvis-work-item-dispatch.service';
import type { ScheduledTenantDirectory } from '../../jobs/tenant-directory';
import {
  CountingJarvisCustomerEffectAuthority,
  createReducedSchemaCustomerEffectAuthorityForTesting,
} from '../../jarvis/jarvis-customer-effect.authority.testing';
import { TEST_ONLY_JARVIS_ACTION_RELEASE_POLICY } from '../../jarvis/jarvis-release-policy.testing';
import { AppLogger } from '../../observability/logger';
import type { Persistence } from '../persistence';
import { PrismaAgentMissionUnitOfWork } from './agent-mission.persistence';
import type { JarvisAdmissionDeps } from './jarvis-admission.persistence';
import { PrismaJarvisProposalPayloadStore } from './jarvis-proposal-payloads.persistence';
import { PrismaJarvisWorkItemsRepository } from './jarvis-work-items.persistence';
import { PrismaService } from './prisma.service';

const RUN_CERT = process.env.RUN_AGENT_MISSION_POSTGRES_CERT === 'true';
const DISPOSABLE = process.env.AGENT_MISSION_CERT_DATABASE_IS_DISPOSABLE === 'true';
const ORIGINAL_DISPATCH_ENABLED = process.env.BOB_JARVIS_DISPATCH_ENABLED;

/** Le parcours e2e enchaîne deux runs complets, un tick de worker et deux écritures métier. */
const TEST_TIMEOUT_MS = 90_000;
const PAYLOAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const FINGERPRINTS: AgentMissionFingerprintPort = {
  sign(canonicalRequest) {
    return { keyVersion: 1, hmac: sha256Hex(`jarvis-u1d-oracle-key:${canonicalRequest}`) };
  },
  matches(canonicalRequest, fingerprint) {
    if (fingerprint.keyVersion !== 1) return null;
    return fingerprint.hmac === sha256Hex(`jarvis-u1d-oracle-key:${canonicalRequest}`);
  },
};

/**
 * HARNAIS D'INTÉGRATION TEST-ONLY — il exerce le code avant promotion du catalogue. Il ne prouve
 * ni publication, ni canary, ni configuration de production.
 */
const TEST_ONLY_DEPS: JarvisAdmissionDeps = {
  fingerprints: FINGERPRINTS,
  canonicalizationVersion: 1,
  admissionEnabled: true,
  allowCertificationAuthority: false,
  actionReleasePolicy: TEST_ONLY_JARVIS_ACTION_RELEASE_POLICY,
};

/**
 * HARNAIS — réservé aux preuves d'autorité elles-mêmes (preuve 1 : le drapeau est la SEULE
 * différence entre un refus et une admission). Aucun run d'oracle ne s'en sert : la voix y est
 * jouée sous une `realtime_capability` résolue contre une lease Realtime RÉELLE, provisionnée
 * par le déployeur comme dans la suite U1-c du dispatch — c'est ce qui rend l'acteur journalisé
 * (`user_voice`) probant plutôt que déclaratif.
 */
const HARNESS_DEPS: JarvisAdmissionDeps = {
  ...TEST_ONLY_DEPS,
  allowCertificationAuthority: true,
};

/**
 * Preuve d'autorité Realtime de certification — la MÊME forme que le canal vocal produit en
 * production (§14) : hashes dérivés du couple société/artisan, jamais un secret.
 */
function certificationAuthorityProof(owner: AgentMissionOwner): AgentMissionRealtimeAuthorityProof {
  const key = `${owner.companyId} ${owner.ownerUserId} 1`;
  return Object.freeze({
    protocolVersion: 1 as const,
    subjectHashCandidates: Object.freeze([sha256Hex(`jarvis-u1d-subject:${key}`)]),
    principalBindingHash: sha256Hex(`jarvis-u1d-realtime-principal:${key}`),
    capabilityHash: sha256Hex(`jarvis-u1d-capability:${key}`),
  });
}

/** Forme d'un instant ISO tel que le journal le persiste — normalisé avant toute comparaison. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
/** UUID v4 canonique : la forme exigée d'un commandId utilisateur (garde envelope_check §5.4). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function expectAdmission<S extends JarvisAdmissionResult['status']>(
  result: JarvisAdmissionResult,
  status: S,
): Extract<JarvisAdmissionResult, { status: S }> {
  if (result.status !== status) {
    throw new Error(`Jarvis U1-d: statut ${status} attendu, reçu ${JSON.stringify(result)}`);
  }
  return result as Extract<JarvisAdmissionResult, { status: S }>;
}

/**
 * Hash de liaison du principal (§14) : 64 hex minuscules, dérivés SERVEUR du bearer authentifié.
 * Le harnais le dérive d'une étiquette d'appareil — la forme est ce que l'admission vérifie, la
 * dérivation réelle appartient au controller.
 */
function principalBindingHash(deviceLabel: string): string {
  return sha256Hex(`jarvis-u1d-principal-binding:${deviceLabel}`);
}

function proposedFields(
  overrides: Partial<CustomerContactProposedFieldsV1> = {},
): CustomerContactProposedFieldsV1 {
  return Object.freeze({
    displayName: 'Marie Dupont',
    legalName: null,
    email: 'marie.dupont@example.test',
    phone: '0601020304',
    addressLine: '12 rue des Lilas',
    postalCode: '75011',
    city: 'Paris',
    vatNumber: null,
    billingChannel: null,
    recipientName: null,
    ...overrides,
  });
}

/**
 * Canal d'admission : ce qui distingue RÉELLEMENT la voix du tap, et rien d'autre —
 * la dérivation du `commandId` (§1 de la spec), la preuve d'autorité (§14), l'ACTEUR journalisé
 * (§5.2, vocabulaire de la lane devis) et la modalité du reçu de présentation (table §7.0).
 * Tout le reste du chemin est partagé, par construction.
 */
interface AdmissionChannel {
  readonly label: 'voice' | 'tap';
  readonly deps: JarvisAdmissionDeps;
  readonly authority: JarvisAdmissionAuthority;
  readonly presentationAck: 'voice_presentation_ack' | 'screen_ack';
  /** L'acteur que le journal DOIT porter pour un tour conduit par ce canal (revue C12). */
  readonly actor: 'user_voice' | 'user_tap';
  /** `step` = ordinal du tour dans le run : un tour, un commandId, stable aux replays. */
  commandId(step: number): string;
  /**
   * Corrélation realtime — le journal l'EXIGE pour un acteur `user_voice` (CHECK de
   * corrélation) : une commande vocale porte sa session, son tour et le contexte acquitté.
   */
  correlation?(step: number): {
    readonly realtimeSessionId: string;
    readonly turnId: string;
    readonly contextRevision: number;
    readonly contextDigest: string;
  };
}

/**
 * VOIX — autorité `realtime_capability` résolue in-tx contre une lease Realtime VIVANTE (donc
 * SOUS le câblage de production, sans drapeau de harnais), et `commandId = turnId` dérivé SERVEUR
 * avant tout appel LLM (`deriveRealtimeTurnId`, forme v4) : stable au replay du même tour et
 * impossible à choisir par le modèle. C'est cette preuve d'autorité — et elle seule — qui fait
 * journaliser `user_voice`.
 */
function voiceChannel(proof: AgentMissionRealtimeAuthorityProof): AdmissionChannel {
  const sessionHandle = `jarvis-u1d-voice-session-${randomUUID()}`;
  const voiceSessionId = randomUUID();
  return {
    label: 'voice',
    deps: TEST_ONLY_DEPS,
    authority: { source: 'realtime_capability', proof },
    presentationAck: 'voice_presentation_ack',
    actor: 'user_voice',
    commandId: (step) => deriveRealtimeTurnId(sessionHandle, `item_${step}`),
    correlation: (step) => ({
      realtimeSessionId: voiceSessionId,
      turnId: deriveRealtimeTurnId(sessionHandle, `item_${step}`),
      contextRevision: 1,
      contextDigest: sha256Hex(`jarvis-u1d-voice-context:${sessionHandle}:${step}`),
    }),
  };
}

/**
 * TAP — UUID v4 minté UNE fois côté client et mémoïsé jusqu'au reçu (§5.4, patron
 * `AgentMissionCommandIdRegistry`) : le registre est ici la Map, et deux appels du même tour
 * rendent le MÊME identifiant — c'est ce qui rend un retour de réseau idempotent.
 */
function tapChannel(deviceLabel: string): AdmissionChannel {
  const registry = new Map<number, string>();
  return {
    label: 'tap',
    deps: TEST_ONLY_DEPS,
    authority: {
      source: 'authenticated_principal',
      principalBindingHash: principalBindingHash(deviceLabel),
    },
    presentationAck: 'screen_ack',
    actor: 'user_tap',
    commandId: (step) => {
      const memoized = registry.get(step);
      if (memoized !== undefined) return memoized;
      const minted = randomUUID();
      registry.set(step, minted);
      return minted;
    },
  };
}

/**
 * Normalisation des valeurs VOLATILES d'un journal ou d'un état : identifiants propres au run
 * (runId, effectId, commandId, hash de proposition) et instants. Tout le reste est comparé
 * OCTET POUR OCTET — une divergence non prévue fait donc échouer l'oracle, jamais l'inverse.
 */
function normalizeVolatile(value: unknown, substitutions: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    const substituted = substitutions.get(value);
    if (substituted !== undefined) return substituted;
    return INSTANT.test(value) ? '<instant>' : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeVolatile(entry, substitutions));
  }
  if (typeof value === 'object' && value !== null) {
    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      normalized[key] = normalizeVolatile(entry, substitutions);
    }
    return normalized;
  }
  return value;
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
  readonly data: unknown;
}

interface WorkItemAuditRow {
  readonly id: string;
  readonly effectId: string;
  readonly actionId: string;
  readonly actionVersion: number;
  readonly status: string;
  readonly leaseFence: bigint;
  readonly actingPrincipalId: string;
  readonly resultDigest: string | null;
  readonly signalAppliedAt: Date | null;
}

interface CustomerAuditRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly addrLine1: string;
  readonly addrZip: string;
  readonly addrCity: string;
  /** U1-e §2 — compteur d'édition relu par l'admission ; l'oracle le LIT, ne le suppose pas. */
  readonly revision: number;
}

/** Trace d'un run conduit par le script d'oracle — de quoi comparer, jamais de quoi rejouer. */
interface OracleTrace {
  readonly runId: string;
  readonly ownerUserId: string;
  readonly effectId: string;
  readonly proposalHash: string;
  readonly presentationAck: string;
  /** Acteur ATTENDU de chaque événement écrit, dans l'ordre des tours qui l'ont produit. */
  readonly eventActors: readonly ('user_voice' | 'user_tap')[];
  readonly workItemIds: readonly string[];
  readonly substitutions: ReadonlyMap<string, string>;
}

describe.skipIf(!RUN_CERT)(
  'Jarvis U1-d — oracles voix/tap, double appareil et parcours e2e (§19.3/§19.4)',
  () => {
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const directUrl = process.env.DIRECT_URL ?? '';
    const certAdminUrl = process.env.AGENT_MISSION_CERT_ADMIN_URL ?? '';
    /** Société des oracles d'admission (preuves 1 à 3) — aucun effet métier n'y part. */
    const companyId = `jarvis-oracle-company-${randomUUID()}`;
    /** Société du parcours e2e (preuve 4) : le worker y balaye SES coordonnées, et elles seules. */
    const effectCompanyId = `jarvis-e2e-company-${randomUUID()}`;
    let admin: PrismaClient;
    let deployer: PrismaClient;
    let workerA: PrismaService;
    let workerB: PrismaService;
    let uowA: PrismaAgentMissionUnitOfWork;
    let uowB: PrismaAgentMissionUnitOfWork;
    let store: PrismaJarvisProposalPayloadStore;
    let workItems: PrismaJarvisWorkItemsRepository;

    function freshOwner(prefix: string): string {
      return `jarvis-u1d-${prefix}-${randomUUID()}`;
    }

    /**
     * Lease Realtime VIVANTE pour un artisan — le writer de lease vit hors de cette suite, alors
     * le harnais pose la MÊME ligne que lui (patron U1-c du dispatch), par le déployeur, sous le
     * rôle propriétaire. Sans elle, `realtime_capability` serait refusée `not_found` : c'est
     * exactement ce qui rend le canal vocal PROBANT ici, et non déclaré.
     */
    async function provisionRealtimeAuthority(
      ownerUserId: string,
    ): Promise<AgentMissionRealtimeAuthorityProof> {
      const owner: AgentMissionOwner = { companyId, ownerUserId };
      const authority = certificationAuthorityProof(owner);
      const subjectHash = authority.subjectHashCandidates[0];
      if (subjectHash === undefined) {
        throw new Error('Jarvis U1-d: subject hash fixture manquant.');
      }
      const sessionId = randomUUID();
      const reservedAt = new Date();
      await deployer.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE bob_schema_owner');
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ownerUserId}, true)`;
        await tx.realtimeSessionLease.create({
          data: {
            companyId,
            subjectHash,
            sessionId,
            leaseTokenHash: sha256Hex(`jarvis-u1d-lease:${companyId} ${ownerUserId}`),
            state: 'active',
            providerId: 'openai',
            providerCallId: `jarvis-u1d-cert-${sessionId}`,
            reservedAt,
            leaseExpiresAt: new Date(reservedAt.getTime() + 10 * 60_000),
            hardExpiresAt: new Date(reservedAt.getTime() + 20 * 60_000),
            activatedAt: reservedAt,
            agentMissionProtocolVersion: 1,
            agentMissionProtocolBoundAt: reservedAt,
            agentMissionCapabilityHash: authority.capabilityHash,
            agentMissionReleaseFlagVersion: 1,
            updatedAt: reservedAt,
          },
        });
        // Le reçu de bootstrap est INTERDIT à l'INSERT (garde
        // `guard_realtime_agent_mission_bootstrap_receipt_v2`) : il se pose par UPDATE, une
        // seule fois, et l'horloge base le réécrit. La lease n'est valide qu'une fois posé.
        await tx.realtimeSessionLease.update({
          where: {
            realtime_session_lease_subject: { companyId, subjectHash },
          },
          data: { agentMissionBootstrapAcknowledgedAt: reservedAt },
        });
      });
      return authority;
    }

    /** Canal vocal RÉEL d'un artisan : lease provisionnée, puis autorité `realtime_capability`. */
    async function liveVoiceChannel(ownerUserId: string): Promise<AdmissionChannel> {
      return voiceChannel(await provisionRealtimeAuthority(ownerUserId));
    }

    function userEnvelope(input: {
      readonly companyId: string;
      readonly ownerUserId: string;
      readonly runId: string;
      readonly commandId: string;
      readonly expectedRevision: number;
      readonly authority: JarvisAdmissionAuthority;
      readonly realtimeCorrelation?: JarvisUserAdmissionEnvelope['realtimeCorrelation'];
      readonly command: unknown;
      readonly actionId?: string;
    }): JarvisUserAdmissionEnvelope {
      const command = input.command;
      return Object.freeze({
        kind: 'customer_contact' as const,
        definitionVersion: 1,
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        runId: input.runId,
        commandId: input.commandId,
        expectedRevision: input.expectedRevision,
        actionId: input.actionId ?? CUSTOMER_CONTACT_CREATE_ACTION_ID,
        actionVersion: 1,
        authority: input.authority,
        ...(input.realtimeCorrelation === undefined
          ? {}
          : { realtimeCorrelation: input.realtimeCorrelation }),
        command,
        canonicalInputDigest: sha256Hex(`jarvis-u1d-oracle-input:${JSON.stringify(command)}`),
        occurredAt: new Date().toISOString(),
      });
    }

    function channelEnvelope(
      channel: AdmissionChannel,
      input: {
        readonly companyId: string;
        readonly ownerUserId: string;
        readonly runId: string;
        readonly step: number;
        readonly expectedRevision: number;
        readonly command: unknown;
        readonly actionId?: string;
      },
    ): JarvisUserAdmissionEnvelope {
      return userEnvelope({
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        runId: input.runId,
        commandId: channel.commandId(input.step),
        expectedRevision: input.expectedRevision,
        authority: channel.authority,
        ...(channel.correlation === undefined
          ? {}
          : { realtimeCorrelation: channel.correlation(input.step) }),
        command: input.command,
        ...(input.actionId === undefined ? {} : { actionId: input.actionId }),
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
      if (row === null) throw new Error(`Jarvis U1-d: run introuvable ${runId}`);
      return row;
    }

    async function auditEvents(runId: string): Promise<EventAuditRow[]> {
      return admin.$queryRaw<EventAuditRow[]>`
        SELECT "sequence", "eventType", "actor", "commandId",
               "missionRevisionBefore", "missionRevisionAfter", "data"
          FROM public.agent_mission_events
         WHERE "missionId" = ${runId}::uuid
         ORDER BY "sequence"
      `;
    }

    async function commandEventCount(tenantId: string, commandId: string): Promise<number> {
      const rows = await admin.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS "count"
          FROM public.agent_mission_events
         WHERE "companyId" = ${tenantId}
           AND "commandId" = ${commandId}::uuid
      `;
      return rows[0]?.count ?? 0;
    }

    async function auditWorkItems(runId: string): Promise<WorkItemAuditRow[]> {
      return admin.$queryRaw<WorkItemAuditRow[]>`
        SELECT "id", "effectId", "actionId", "actionVersion", "status",
               "leaseFence", "actingPrincipalId", "resultDigest", "signalAppliedAt"
          FROM public.jarvis_work_items
         WHERE "runId" = ${runId}::uuid
         ORDER BY "createdAt"
      `;
    }

    async function auditCustomer(customerId: string): Promise<CustomerAuditRow | null> {
      const rows = await admin.$queryRaw<CustomerAuditRow[]>`
        SELECT "id", "name", "type"::text AS "type", "email", "phone",
               "addrLine1", "addrZip", "addrCity", "revision"
          FROM public.customers
         WHERE "id" = ${customerId}
      `;
      return rows[0] ?? null;
    }

    async function countCustomers(tenantId: string, customerId: string): Promise<number> {
      const rows = await admin.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS "count"
          FROM public.customers
         WHERE "companyId" = ${tenantId}
           AND "id" = ${customerId}
      `;
      return rows[0]?.count ?? 0;
    }

    function stateEffectIdOf(row: RunAuditRow): string {
      const payload = row.payload as { readonly effectId?: unknown } | null;
      if (payload === null || typeof payload?.effectId !== 'string') {
        throw new Error('Jarvis U1-d: effectId absent du state persisté.');
      }
      return payload.effectId;
    }

    /** Charge PII scellée AVANT `stage_proposal` — l'ordre exigé par la doctrine du magasin. */
    async function sealPayload(input: {
      readonly companyId: string;
      readonly ownerUserId: string;
      readonly runId: string;
      readonly proposalId: string;
      readonly fields: CustomerContactProposedFieldsV1;
    }): Promise<void> {
      const sealed = await store.sealProposalPayload({
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        runId: input.runId,
        proposalId: input.proposalId,
        fieldsDigest: computeCustomerContactFieldsDigest(input.fields),
        sensitiveDigest: computeCustomerContactSensitiveDigest(input.fields),
        fields: input.fields,
        retentionExpiresAt: new Date(Date.now() + PAYLOAD_RETENTION_MS).toISOString(),
      });
      if (sealed.status !== 'sealed') {
        throw new Error(`Jarvis U1-d: scellement raté ${JSON.stringify(sealed)}`);
      }
    }

    /**
     * LE script d'oracle §19.3 — six tours, identiques quel que soit le canal :
     *   1. `start_run` · 2. `record_customer_resolution` · 3. `stage_proposal` (charge scellée
     *   d'abord) · 4. `confirm` PRÉMATURÉ (refusé, zéro write — la voix n'obtient pas ce que
     *   l'écran n'obtient pas) · 5. `record_presentation_ack` (modalité DU CANAL) · 6. `confirm`.
     * `channelAt` décide quel canal porte quel tour : c'est ce qui permet au run MIXTE d'ouvrir
     * à la voix et de finir à l'écran, sans une ligne de code de plus.
     *
     * `target` bascule le MÊME script de la création à la MODIFICATION (U1-e §2) : l'intention
     * cible une fiche RÉELLE, la résolution la vérifie, la proposition scelle sa révision, et
     * l'admission relit la cible sous verrou à chaque tour. Un seul script pour les deux
     * parcours : ce qui reste différent entre deux runs est donc bien le CANAL, jamais le code
     * de conduite.
     */
    async function driveOracleScript(input: {
      /** Société alternative pour une preuve worker ; défaut = société des oracles de canal. */
      readonly companyId?: string;
      readonly ownerUserId: string;
      readonly channelAt: (step: number) => AdmissionChannel;
      readonly proposalId: string;
      readonly confirmationId: string;
      readonly fields: CustomerContactProposedFieldsV1;
      readonly stopAfterPresentation?: boolean;
      /** Modification : la cible RÉELLE et sa révision relue en base par l'appelant. */
      readonly target?: { readonly customerId: string; readonly revision: number };
    }): Promise<OracleTrace> {
      const runId = randomUUID();
      const scriptCompanyId = input.companyId ?? companyId;
      const ownerUserId = input.ownerUserId;
      const target = input.target ?? null;
      const actionId =
        target === null ? CUSTOMER_CONTACT_CREATE_ACTION_ID : CUSTOMER_CONTACT_UPDATE_ACTION_ID;
      const targetRevision = target === null ? null : target.revision;
      const commandIds: string[] = [];
      /** Un tour ADMIS = un événement : l'acteur attendu se note ici, dans l'ordre réel. */
      const eventActors: ('user_voice' | 'user_tap')[] = [];

      const envelopeAt = (step: number, expectedRevision: number, command: unknown) => {
        const envelope = channelEnvelope(input.channelAt(step), {
          companyId: scriptCompanyId,
          ownerUserId,
          runId,
          step,
          expectedRevision,
          command,
          actionId,
        });
        commandIds[step - 1] = envelope.commandId;
        return envelope;
      };
      const admitAt = async (step: number, expectedRevision: number, command: unknown) => {
        const envelope = envelopeAt(step, expectedRevision, command);
        const channel = input.channelAt(step);
        const admitted = expectAdmission(
          await uowA.runJarvisAdmission(envelope, channel.deps),
          'admitted',
        );
        eventActors.push(channel.actor);
        return admitted;
      };

      // 1 — ouverture du run : l'effectId est ALLOUÉ par le serveur, jamais par l'appelant.
      const started = await admitAt(1, 0, {
        type: 'start_run',
        intent: target === null ? { mode: 'create' } : { mode: 'update', target },
      });
      expect(started.eventSequence).toBe(1);
      const effectId = stateEffectIdOf(await requireRun(runId));

      // 2 — résolution : aucun doublon en création ; en modification, la cible VÉRIFIÉE, dont la
      // révision fait ensuite autorité sur tout ce que la proposition scellera.
      await admitAt(2, 1, {
        type: 'record_customer_resolution',
        resolution:
          target === null
            ? { kind: 'no_duplicates' }
            : { kind: 'target_verified', customerId: target.customerId },
      });

      // 3 — la charge PII est scellée AVANT que le run ne promette son digest.
      await sealPayload({
        companyId: scriptCompanyId,
        ownerUserId,
        runId,
        proposalId: input.proposalId,
        fields: input.fields,
      });
      const fieldsDigest = computeCustomerContactFieldsDigest(input.fields);
      const sensitiveDigest = computeCustomerContactSensitiveDigest(input.fields);
      await admitAt(3, 2, {
        type: 'stage_proposal',
        proposalId: input.proposalId,
        confirmationId: input.confirmationId,
        fieldsDigest,
        sensitiveDigest,
        targetRevision,
      });
      const proposalHash = computeCustomerContactProposalHash({
        runId,
        proposalId: input.proposalId,
        actionId,
        fieldsDigest,
        sensitiveDigest,
        targetRevision,
        effectId,
      });
      // U1-e §2 : trois clés au wire, dans les DEUX parcours. Une création n'a pas de cible à
      // relire (l'admission ne fournit aucune revalidation, la définition en exige l'absence) ;
      // une modification en a une, mais c'est l'ADMISSION qui la relit sous verrou — le client
      // n'affirme jamais l'état de sa cible.
      const confirmCommand = {
        type: 'confirm',
        confirmationId: input.confirmationId,
        proposalHash,
      };

      // 4 — CONFIRMATION PRÉMATURÉE : sans reçu de présentation, la proposition n'est pas
      // consommable (§7.1). Le refus est TYPÉ et identique sur les deux canaux, et il n'écrit
      // rien — c'est la borne « la voix n'est jamais plus permissive », prouvée en base.
      const premature = envelopeAt(4, 3, confirmCommand);
      const refused = expectAdmission(
        await uowA.runJarvisAdmission(premature, input.channelAt(4).deps),
        'refused',
      );
      expect(refused.error).toEqual({
        code: 'invalid_command',
        reason: 'confirmation_not_presented',
      });
      await expect(commandEventCount(scriptCompanyId, premature.commandId)).resolves.toBe(0);

      // 5 — reçu de présentation : la MODALITÉ est celle du canal (table §7.0).
      const presentationChannel = input.channelAt(5);
      await admitAt(5, 3, {
        type: 'record_presentation_ack',
        confirmationId: input.confirmationId,
        ack: presentationChannel.presentationAck,
      });

      const workItemIds: string[] = [];
      if (input.stopAfterPresentation !== true) {
        // 6 — confirmation : l'intent 1:1 devient un work item, une seule fois.
        const confirmed = await admitAt(6, 4, confirmCommand);
        expect(confirmed.workItemIds).toHaveLength(1);
        workItemIds.push(...confirmed.workItemIds);
      }

      const substitutions = new Map<string, string>([
        [runId, '<runId>'],
        [effectId, '<effectId>'],
        [proposalHash, '<proposalHash>'],
        // La modalité du reçu EST la différence admise entre canaux : elle est neutralisée ici
        // et assertée séparément, jamais tue.
        ['voice_presentation_ack', '<presentationAck>'],
        ['screen_ack', '<presentationAck>'],
      ]);
      commandIds.forEach((commandId, index) => {
        substitutions.set(commandId, `<commandId#${index + 1}>`);
      });

      return {
        runId,
        ownerUserId,
        effectId,
        proposalHash,
        presentationAck: presentationChannel.presentationAck,
        eventActors,
        workItemIds,
        substitutions,
      };
    }

    /**
     * Journal comparé par l'oracle : TOUT, SAUF les deux colonnes de CANAL — `actor` et
     * `commandId`. Elles sont exclues parce qu'elles DOIVENT différer d'un canal à l'autre ; les
     * comparer ici rendrait l'oracle vert par construction (revue C12). Elles sont assertées à
     * part, dans les deux sens : égales à l'attendu DU canal, différentes ENTRE canaux.
     */
    function normalizeJournal(
      events: readonly EventAuditRow[],
      substitutions: ReadonlyMap<string, string>,
    ): unknown {
      return events.map((event) => ({
        sequence: event.sequence,
        eventType: event.eventType,
        missionRevisionBefore: event.missionRevisionBefore,
        missionRevisionAfter: event.missionRevisionAfter,
        data: normalizeVolatile(event.data, substitutions),
      }));
    }

    /**
     * Le MÊME journal, colonne d'ACTEUR réintroduite : témoin de la preuve NÉGATIVE. Puisque tout
     * le reste est prouvé égal, ces deux journaux ne peuvent différer QUE par l'acteur — s'ils
     * devenaient égaux, c'est que le canal aurait cessé d'être journalisé.
     */
    function journalWithActor(
      events: readonly EventAuditRow[],
      substitutions: ReadonlyMap<string, string>,
    ): unknown {
      const normalized = normalizeJournal(events, substitutions) as readonly unknown[];
      return events.map((event, index) => ({ actor: event.actor, entry: normalized[index] }));
    }

    function normalizeRun(row: RunAuditRow, substitutions: ReadonlyMap<string, string>): unknown {
      return {
        kind: row.kind,
        status: row.status,
        phase: row.phase,
        revision: row.revision,
        protocolVersion: row.protocolVersion,
        payloadVersion: row.payloadVersion,
        definitionVersion: row.definitionVersion,
        terminal: row.terminalAt !== null,
        payload: normalizeVolatile(row.payload, substitutions),
      };
    }

    beforeAll(async () => {
      // Le runtime reste fail-closed. Ce harnais ouvre explicitement le worker qu'il exerce.
      process.env.BOB_JARVIS_DISPATCH_ENABLED = 'true';
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
      // Déployeur : il ne sert QU'À poser les leases Realtime du canal vocal, jamais une ligne
      // Jarvis — celles-là passent toutes par le runtime non-superuser.
      deployer = new PrismaClient({ datasourceUrl: directUrl, errorFormat: 'minimal' });
      // Deux connexions runtime distinctes : la course du double appareil (preuve 3) oppose deux
      // VRAIES transactions concurrentes, jamais un aller-retour séquentiel.
      workerA = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
      workerB = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
      uowA = new PrismaAgentMissionUnitOfWork(workerA);
      uowB = new PrismaAgentMissionUnitOfWork(workerB);
      store = new PrismaJarvisProposalPayloadStore(workerA);
      workItems = new PrismaJarvisWorkItemsRepository(workerA);
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
          ${companyId}, ${'Jarvis oracle cert 9'}, ${'EI'},
          ${'903000009'}, ${'90300000900009'},
          ${'certification'}, ${'reel_normal'},
          ${'1 rue du Test'}, ${'75001'}, ${'Paris'}
        )
      `;
      await admin.$executeRaw`
        INSERT INTO public.companies (
          "id", "name", "legalForm", "siren", "siret", "trade", "vatRegime",
          "addrLine1", "addrZip", "addrCity"
        ) VALUES (
          ${effectCompanyId}, ${'Jarvis e2e cert 10'}, ${'EI'},
          ${'903000010'}, ${'90300001000010'},
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
      if (ORIGINAL_DISPATCH_ENABLED === undefined) {
        delete process.env.BOB_JARVIS_DISPATCH_ENABLED;
      } else {
        process.env.BOB_JARVIS_DISPATCH_ENABLED = ORIGINAL_DISPATCH_ENABLED;
      }
    });

    it(
      'preuve 1 — autorité §14 : le tap authentifié passe sous harnais test-only, chaque forme refusée nomme son motif',
      async () => {
        // (a) Autorité runtime (allowCertificationAuthority: false) sous lifecycle test-only :
        // sans lease Realtime — c'est ce qui permet la reprise à l'écran d'un run parké.
        const owner = freshOwner('tap-owner');
        const device = tapChannel('iphone-du-fondateur');
        const runId = randomUUID();
        const seed = channelEnvelope(device, {
          companyId,
          ownerUserId: owner,
          runId,
          step: 1,
          expectedRevision: 0,
          command: { type: 'start_run', intent: { mode: 'create' } },
        });
        const admitted = expectAdmission(
          await uowA.runJarvisAdmission(seed, TEST_ONLY_DEPS),
          'admitted',
        );
        expect(admitted.eventSequence).toBe(1);

        const run = await requireRun(runId);
        expect(run.kind).toBe('customer_contact');
        expect(run.revision).toBe(1);
        expect(run.phase).toBe('resolving_customer');
        const events = await auditEvents(runId);
        expect(events).toHaveLength(1);
        expect(events[0]?.eventType).toBe('cc_run_started');
        expect(events[0]?.actor).toBe('user_tap');
        expect(events[0]?.commandId).toBe(seed.commandId);
        // Le tour suivant du MÊME appareil passe lui aussi : l'autorité n'est pas un jeton
        // à usage unique, elle se re-résout à chaque commande.
        expectAdmission(
          await uowA.runJarvisAdmission(
            channelEnvelope(device, {
              companyId,
              ownerUserId: owner,
              runId,
              step: 2,
              expectedRevision: 1,
              command: {
                type: 'record_customer_resolution',
                resolution: { kind: 'no_duplicates' },
              },
            }),
            TEST_ONLY_DEPS,
          ),
          'admitted',
        );

        // (b) Hash de liaison MALFORMÉ (63 caractères) : la forme est vérifiée in-tx, sous verrou.
        const malformedOwner = freshOwner('tap-malformed');
        const malformedRunId = randomUUID();
        const malformed = userEnvelope({
          companyId,
          ownerUserId: malformedOwner,
          runId: malformedRunId,
          commandId: randomUUID(),
          expectedRevision: 0,
          authority: {
            source: 'authenticated_principal',
            principalBindingHash: principalBindingHash('appareil-tronque').slice(0, 63),
          },
          command: { type: 'start_run', intent: { mode: 'create' } },
        });
        const malformedResult = expectAdmission(
          await uowA.runJarvisAdmission(malformed, TEST_ONLY_DEPS),
          'capability_rejected',
        );
        expect(malformedResult.reason).toBe('malformed_principal_binding');
        await expect(auditRun(malformedRunId)).resolves.toBeNull();
        await expect(commandEventCount(companyId, malformed.commandId)).resolves.toBe(0);

        // (c) L'autorité de HARNAIS hors harnais : refusée par SON motif — et la MÊME enveloppe
        // passe sous les deps de certification, ce qui prouve que le drapeau est la seule
        // différence (le refus n'avait rien persisté).
        const fixtureOwner = freshOwner('fixture-owner');
        const fixtureRunId = randomUUID();
        const fixture = userEnvelope({
          companyId,
          ownerUserId: fixtureOwner,
          runId: fixtureRunId,
          commandId: randomUUID(),
          expectedRevision: 0,
          authority: { source: 'certification_fixture' },
          command: { type: 'start_run', intent: { mode: 'create' } },
        });
        const fixtureRefused = expectAdmission(
          await uowA.runJarvisAdmission(fixture, TEST_ONLY_DEPS),
          'capability_rejected',
        );
        expect(fixtureRefused.reason).toBe('certification_fixture_forbidden');
        await expect(auditRun(fixtureRunId)).resolves.toBeNull();
        expectAdmission(await uowA.runJarvisAdmission(fixture, HARNESS_DEPS), 'admitted');
        await expect(requireRun(fixtureRunId)).resolves.toMatchObject({ revision: 1 });

        // (d) SOURCE INCONNUE — le bras `default` du switch exhaustif. Le cast est délibéré :
        // il fabrique l'enveloppe qu'une révision N-1 (ou un bug de sérialisation) produirait,
        // et que le type interdit par ailleurs.
        const ghostOwner = freshOwner('ghost-owner');
        const ghostRunId = randomUUID();
        const ghost = userEnvelope({
          companyId,
          ownerUserId: ghostOwner,
          runId: ghostRunId,
          commandId: randomUUID(),
          expectedRevision: 0,
          authority: { source: 'device_pairing' } as unknown as JarvisAdmissionAuthority,
          command: { type: 'start_run', intent: { mode: 'create' } },
        });
        const ghostResult = expectAdmission(
          await uowA.runJarvisAdmission(ghost, HARNESS_DEPS),
          'capability_rejected',
        );
        expect(ghostResult.reason).toBe('unknown_authority_source');
        await expect(auditRun(ghostRunId)).resolves.toBeNull();
        await expect(commandEventCount(companyId, ghost.commandId)).resolves.toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 2 — oracle voix/tap §19.3 : trois runs, un seul journal hors CANAL — et le canal, lui, est DISCRIMINANT',
      async () => {
        // Les identifiants MINTÉS PAR L'APPELANT (proposition, confirmation) sont volontairement
        // IDENTIQUES d'un run à l'autre : ce qui reste différent après normalisation est donc
        // exactement ce que les canaux fabriquent eux-mêmes.
        const proposalId = randomUUID();
        const confirmationId = randomUUID();
        const fields = proposedFields();

        const voiceOwner = freshOwner('voice-owner');
        const voice = await liveVoiceChannel(voiceOwner);
        const voiceTrace = await driveOracleScript({
          ownerUserId: voiceOwner,
          channelAt: () => voice,
          proposalId,
          confirmationId,
          fields,
        });
        const tap = tapChannel('ipad-atelier');
        const tapTrace = await driveOracleScript({
          ownerUserId: freshOwner('tap-owner'),
          channelAt: () => tap,
          proposalId,
          confirmationId,
          fields,
        });
        // Run MIXTE §14 : ouvert à la voix (tours 1-2), la session vocale meurt, l'artisan finit
        // à l'écran (tours 3-6) — au bearer seul, sans aucune lease Realtime.
        const mixedOwner = freshOwner('mixed-owner');
        const mixedVoice = await liveVoiceChannel(mixedOwner);
        const mixedTap = tapChannel('iphone-du-fondateur');
        const mixedTrace = await driveOracleScript({
          ownerUserId: mixedOwner,
          channelAt: (step) => (step <= 2 ? mixedVoice : mixedTap),
          proposalId,
          confirmationId,
          fields,
        });

        // Le commandId de la voix est DÉRIVÉ, pas tiré au sort : re-dérivable et de forme v4.
        const voiceEvents = await auditEvents(voiceTrace.runId);
        for (const event of voiceEvents) {
          expect(event.commandId).toMatch(UUID_V4);
        }
        expect(new Set(voiceEvents.map((event) => event.commandId)).size).toBe(voiceEvents.length);

        // L'ORACLE : journaux (hors colonnes de canal) et états normalisés STRICTEMENT égaux.
        const tapEvents = await auditEvents(tapTrace.runId);
        const mixedEvents = await auditEvents(mixedTrace.runId);
        const voiceJournal = normalizeJournal(voiceEvents, voiceTrace.substitutions);
        const tapJournal = normalizeJournal(tapEvents, tapTrace.substitutions);
        const mixedJournal = normalizeJournal(mixedEvents, mixedTrace.substitutions);
        expect(voiceJournal).toEqual(tapJournal);
        expect(mixedJournal).toEqual(tapJournal);

        // LE CANAL, LUI, DIFFÈRE (revue C12) — l'acteur journalisé est le canal RÉEL du tour,
        // jamais un défaut. Le run mixte le prouve tour par tour : la voix a ouvert, l'écran a
        // fini, et la colonne le dit dans cet ordre.
        const actorsOf = (events: readonly EventAuditRow[]): readonly string[] =>
          events.map((event) => event.actor);
        const fiveTurns = (actor: 'user_voice' | 'user_tap'): readonly string[] => [
          actor,
          actor,
          actor,
          actor,
          actor,
        ];
        expect(voiceTrace.eventActors).toEqual(fiveTurns('user_voice'));
        expect(tapTrace.eventActors).toEqual(fiveTurns('user_tap'));
        expect(mixedTrace.eventActors).toEqual([
          'user_voice',
          'user_voice',
          'user_tap',
          'user_tap',
          'user_tap',
        ]);
        expect(actorsOf(voiceEvents)).toEqual(voiceTrace.eventActors);
        expect(actorsOf(tapEvents)).toEqual(tapTrace.eventActors);
        expect(actorsOf(mixedEvents)).toEqual(mixedTrace.eventActors);
        expect(actorsOf(voiceEvents)).not.toEqual(actorsOf(tapEvents));

        // L'autre colonne de canal exclue de l'oracle est vérifiée ICI, et pas moins : chaque
        // événement porte le commandId DE SON TOUR (le tour 4, refusé, n'en a écrit aucun), et
        // aucun identifiant n'est partagé entre deux canaux.
        const commandIdsOf = (
          events: readonly EventAuditRow[],
          substitutions: ReadonlyMap<string, string>,
        ): readonly unknown[] =>
          events.map((event) => normalizeVolatile(event.commandId, substitutions));
        const TURNS_THAT_WROTE = [
          '<commandId#1>',
          '<commandId#2>',
          '<commandId#3>',
          '<commandId#5>',
          '<commandId#6>',
        ];
        expect(commandIdsOf(voiceEvents, voiceTrace.substitutions)).toEqual(TURNS_THAT_WROTE);
        expect(commandIdsOf(tapEvents, tapTrace.substitutions)).toEqual(TURNS_THAT_WROTE);
        expect(commandIdsOf(mixedEvents, mixedTrace.substitutions)).toEqual(TURNS_THAT_WROTE);
        const rawCommandIds = [...voiceEvents, ...tapEvents, ...mixedEvents].map(
          (event) => event.commandId,
        );
        expect(new Set(rawCommandIds).size).toBe(rawCommandIds.length);

        // PREUVE NÉGATIVE : tout le reste étant prouvé égal ci-dessus, ces deux journaux ne
        // peuvent différer QUE par l'acteur. Si les deux canaux écrivaient le même (le défaut
        // `user_tap` d'avant la revue C12), l'égalité serait vraie et CETTE assertion rougirait.
        expect(journalWithActor(voiceEvents, voiceTrace.substitutions)).not.toEqual(
          journalWithActor(tapEvents, tapTrace.substitutions),
        );
        expect(journalWithActor(mixedEvents, mixedTrace.substitutions)).not.toEqual(
          journalWithActor(tapEvents, tapTrace.substitutions),
        );
        expect(normalizeRun(await requireRun(voiceTrace.runId), voiceTrace.substitutions)).toEqual(
          normalizeRun(await requireRun(tapTrace.runId), tapTrace.substitutions),
        );
        expect(normalizeRun(await requireRun(mixedTrace.runId), mixedTrace.substitutions)).toEqual(
          normalizeRun(await requireRun(tapTrace.runId), tapTrace.substitutions),
        );

        // La différence NEUTRALISÉE est nommée, jamais tue : la modalité du reçu §7.0.
        const presentationAckOf = (events: readonly EventAuditRow[]): unknown => {
          const presented = events.find((event) => event.eventType === 'cc_proposal_presented');
          return (presented?.data as { readonly ack?: unknown } | undefined)?.ack;
        };
        expect(voiceTrace.presentationAck).toBe('voice_presentation_ack');
        expect(tapTrace.presentationAck).toBe('screen_ack');
        // Le run MIXTE a été présenté à l'ÉCRAN : sa modalité est celle du canal qui a
        // réellement rendu la proposition, jamais celle du canal qui a ouvert le run.
        expect(mixedTrace.presentationAck).toBe('screen_ack');
        expect(presentationAckOf(voiceEvents)).toBe(voiceTrace.presentationAck);
        await expect(auditEvents(tapTrace.runId).then(presentationAckOf)).resolves.toBe(
          tapTrace.presentationAck,
        );
        await expect(auditEvents(mixedTrace.runId).then(presentationAckOf)).resolves.toBe(
          mixedTrace.presentationAck,
        );

        // Un run, un effet : chacun porte EXACTEMENT un work item, à l'identique.
        for (const trace of [voiceTrace, tapTrace, mixedTrace]) {
          const items = await auditWorkItems(trace.runId);
          expect(items).toHaveLength(1);
          expect(items[0]?.id).toBe(trace.workItemIds[0]);
          expect(items[0]?.effectId).toBe(trace.effectId);
          expect(items[0]?.actionId).toBe(CUSTOMER_CONTACT_CREATE_ACTION_ID);
          expect(items[0]?.actionVersion).toBe(1);
          expect(items[0]?.status).toBe('prepared');
          expect(items[0]?.leaseFence).toBe(0n);
          expect(items[0]?.actingPrincipalId).toBe(trace.ownerUserId);
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 3 — double appareil (G5) : deux confirmations concurrentes, un seul effet',
      async () => {
        const owner = freshOwner('device-owner');
        const proposalId = randomUUID();
        const confirmationId = randomUUID();
        const fields = proposedFields({ displayName: 'Entreprise Martin' });
        const screen = tapChannel('ipad-atelier');
        const trace = await driveOracleScript({
          ownerUserId: owner,
          channelAt: () => screen,
          proposalId,
          confirmationId,
          fields,
          stopAfterPresentation: true,
        });
        const presented = await requireRun(trace.runId);
        expect(presented.revision).toBe(4);
        expect(presented.status).toBe('waiting_user');

        // Deux appareils authentifiés du MÊME artisan : deux commandId v4 distincts, deux hash
        // de liaison distincts, la MÊME révision attendue — la course réelle du §19.3 G5.
        const confirmCommand = {
          type: 'confirm',
          confirmationId,
          proposalHash: trace.proposalHash,
        };
        const phone = tapChannel('iphone-du-fondateur');
        const tablet = tapChannel('ipad-atelier');
        const phoneEnvelope = channelEnvelope(phone, {
          companyId,
          ownerUserId: owner,
          runId: trace.runId,
          step: 6,
          expectedRevision: 4,
          command: confirmCommand,
        });
        const tabletEnvelope = channelEnvelope(tablet, {
          companyId,
          ownerUserId: owner,
          runId: trace.runId,
          step: 6,
          expectedRevision: 4,
          command: confirmCommand,
        });
        expect(phoneEnvelope.commandId).not.toBe(tabletEnvelope.commandId);
        const [phoneResult, tabletResult] = await Promise.all([
          uowA.runJarvisAdmission(phoneEnvelope, TEST_ONLY_DEPS),
          uowB.runJarvisAdmission(tabletEnvelope, TEST_ONLY_DEPS),
        ]);

        const results = [phoneResult, tabletResult];
        const winner = results.find((result) => result.status === 'admitted');
        const loser = results.find((result) => result.status !== 'admitted');
        expect(winner?.status).toBe('admitted');
        expect(['stale_revision', 'command_conflict']).toContain(loser?.status);
        if (loser?.status === 'stale_revision') {
          expect(loser.actualRevision).toBe(5);
        }
        if (winner === undefined) {
          throw new Error(
            'Jarvis U1-d: aucune des deux confirmations concurrentes n’a été admise.',
          );
        }
        const admittedWinner = expectAdmission(winner, 'admitted');
        expect(admittedWinner.workItemIds).toHaveLength(1);

        // LA BASE : une révision, un événement, UN work item — jamais deux effets pour une
        // décision, quel que soit le nombre d'appareils.
        const settled = await requireRun(trace.runId);
        expect(settled.revision).toBe(5);
        expect(settled.phase).toBe('committing');
        await expect(auditEvents(trace.runId)).resolves.toHaveLength(5);
        const racedWrites =
          (await commandEventCount(companyId, phoneEnvelope.commandId)) +
          (await commandEventCount(companyId, tabletEnvelope.commandId));
        expect(racedWrites).toBe(1);
        const items = await auditWorkItems(trace.runId);
        expect(items).toHaveLength(1);
        expect(items[0]?.id).toBe(admittedWinner.workItemIds[0]);

        // Le perdant se rafraîchit par la LECTURE STATELESS — l'oracle est la base, jamais
        // l'écran : il y lit la révision courante et la confirmation déjà consommée.
        const refreshed = await uowB.readJarvisStateless(
          { companyId, ownerUserId: owner },
          async (view) => view.runById(trace.runId),
        );
        const refreshedRun = refreshed.value;
        if (refreshedRun === null || refreshedRun.kind !== 'customer_contact') {
          throw new Error('Jarvis U1-d: le run rafraîchi n’est pas le run fiche client attendu.');
        }
        expect(refreshedRun.revision).toBe(5);
        const refreshedState = refreshedRun.state as {
          readonly confirmation?: {
            readonly status?: unknown;
            readonly consumedByCommandId?: unknown;
          };
        } | null;
        expect(refreshedState?.confirmation?.status).toBe('consumed');
        const winnerCommandId =
          (await commandEventCount(companyId, phoneEnvelope.commandId)) === 1
            ? phoneEnvelope.commandId
            : tabletEnvelope.commandId;
        expect(refreshedState?.confirmation?.consumedByCommandId).toBe(winnerCommandId);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 4 — e2e §19.4 n°1 : créer puis modifier, mutation d’e-mail entre présentation et confirm',
      async () => {
        const owner = freshOwner('e2e-owner');
        const device = tapChannel('iphone-du-fondateur');
        const authority = new CountingJarvisCustomerEffectAuthority(
          createReducedSchemaCustomerEffectAuthorityForTesting(workerA),
        );
        const admissionPort: JarvisAdmissionUnitOfWorkPort = {
          runJarvisAdmission: (envelope: JarvisUserAdmissionEnvelope) =>
            uowA.runJarvisAdmission(envelope, TEST_ONLY_DEPS),
          runJarvisSystemAdmission: (envelope: JarvisSystemAdmissionEnvelope) =>
            uowA.runJarvisSystemAdmission(envelope, TEST_ONLY_DEPS),
          readJarvisStateless: <T>(
            runOwner: JarvisAdmissionOwner,
            read: (view: {
              readonly runById: (runId: string) => Promise<JarvisRunEnvelope | null>;
            }) => Promise<T>,
          ): Promise<JarvisStatelessReadResult<T>> => uowA.readJarvisStateless(runOwner, read),
        };
        const executor = new JarvisCustomerEffectExecutor({
          admission: admissionPort,
          payloads: store,
          customers: authority,
          // §8 : la frame ne PROPOSE pas encore le type légal ; le harnais le fournit
          // explicitement plutôt que l'exécuteur ne le devine (gate documenté de l'exécuteur).
          certificationCustomerType: 'b2c',
        });
        const worker = dispatchWorker(executor, admissionPort);

        /** Conduit le run de CRÉATION jusqu'au work item, charge scellée avant la proposition. */
        const driveCreationRun = async (
          fields: CustomerContactProposedFieldsV1,
        ): Promise<{ readonly runId: string; readonly effectId: string }> => {
          const runId = randomUUID();
          const admit = async (step: number, expectedRevision: number, command: unknown) =>
            expectAdmission(
              await uowA.runJarvisAdmission(
                channelEnvelope(device, {
                  companyId: effectCompanyId,
                  ownerUserId: owner,
                  runId,
                  step,
                  expectedRevision,
                  command,
                }),
                TEST_ONLY_DEPS,
              ),
              'admitted',
            );
          await admit(1, 0, { type: 'start_run', intent: { mode: 'create' } });
          const effectId = stateEffectIdOf(await requireRun(runId));
          await admit(2, 1, {
            type: 'record_customer_resolution',
            resolution: { kind: 'no_duplicates' },
          });
          const proposalId = randomUUID();
          const confirmationId = randomUUID();
          await sealPayload({
            companyId: effectCompanyId,
            ownerUserId: owner,
            runId,
            proposalId,
            fields,
          });
          const fieldsDigest = computeCustomerContactFieldsDigest(fields);
          const sensitiveDigest = computeCustomerContactSensitiveDigest(fields);
          await admit(3, 2, {
            type: 'stage_proposal',
            proposalId,
            confirmationId,
            fieldsDigest,
            sensitiveDigest,
            targetRevision: null,
          });
          await admit(4, 3, {
            type: 'record_presentation_ack',
            confirmationId,
            ack: 'screen_ack',
          });
          const confirmed = await admit(5, 4, {
            type: 'confirm',
            confirmationId,
            proposalHash: computeCustomerContactProposalHash({
              runId,
              proposalId,
              actionId: CUSTOMER_CONTACT_CREATE_ACTION_ID,
              fieldsDigest,
              sensitiveDigest,
              targetRevision: null,
              effectId,
            }),
          });
          expect(confirmed.workItemIds).toHaveLength(1);
          return { runId, effectId };
        };


        // ---------------------------------------------------------------------------
        // A. CRÉER — admission → worker RÉEL → exécuteur RÉEL → fiche en base
        // ---------------------------------------------------------------------------
        const created = await driveCreationRun(proposedFields());
        const customerId = deriveJarvisEffectCustomerId(created.effectId);
        await expect(auditCustomer(customerId)).resolves.toBeNull();

        const createTick = await worker.runForCompany(effectCompanyId);
        expect(createTick.claimed).toBe(1);
        expect(createTick.executed).toBe(1);
        expect(createTick.failures).toBe(0);

        const customer = await auditCustomer(customerId);
        expect(customer?.name).toBe('Marie Dupont');
        expect(customer?.type).toBe('b2c');
        expect(customer?.email).toBe('marie.dupont@example.test');
        expect(customer?.addrLine1).toBe('12 rue des Lilas');
        expect(customer?.addrCity).toBe('Paris');
        // U1-e §2 — la fiche NAÎT à la révision 1 (DEFAULT SQL) : c'est la seule chose qu'on
        // puisse affirmer d'une ligne qui vient d'être écrite.
        expect(customer?.revision).toBe(1);
        await expect(countCustomers(effectCompanyId, customerId)).resolves.toBe(1);
        const createdItems = await auditWorkItems(created.runId);
        expect(createdItems).toHaveLength(1);
        expect(createdItems[0]?.status).toBe('succeeded');
        expect(createdItems[0]?.resultDigest).toBe(
          jarvisCustomerEffectSuccessDigest(created.effectId, customerId),
        );
        // U1-f — LE SIGNAL EST DÉSORMAIS APPLIQUÉ PAR LE WORKER. Avant ce lot, le reçu de succès
        // d'un `customer_contact` était INCONSTRUCTIBLE (il exige l'identité et la révision
        // écrites, qu'un digest opaque ne porte pas) : la ligne restait éternellement due et le
        // run bloqué en `committing`. L'exécuteur décrit maintenant son effet, donc la boucle se
        // referme SEULE — la simuler à la main masquerait précisément ce que ce lot établit.
        expect(createdItems[0]?.signalAppliedAt).not.toBeNull();
        const completed = await requireRun(created.runId);
        expect(completed.status).toBe('completed');
        expect(completed.phase).toBe('completed');
        expect(completed.terminalAt).not.toBeNull();

        // ---------------------------------------------------------------------------
        // B. MODIFIER — mutation d'e-mail entre la présentation et la confirmation
        //
        // U1-e §2 : plus AUCUNE valeur revalidée n'est fabriquée par ce test. Le confirm ne
        // porte que trois clés ; c'est l'admission qui relit la fiche SOUS VERROU et dérive son
        // digest sensible. La dérive prouvée ici est donc RÉELLE : une écriture canonique passe
        // entre la présentation et la confirmation, la base bouge, et la garde §9.1 mord.
        // ---------------------------------------------------------------------------
        const updateRunId = randomUUID();
        const staleFields = proposedFields({
          displayName: null,
          legalName: null,
          phone: null,
          addressLine: null,
          postalCode: null,
          city: 'Lyon',
        });
        const admitUpdate = async (step: number, expectedRevision: number, command: unknown) =>
          uowA.runJarvisAdmission(
            channelEnvelope(device, {
              companyId: effectCompanyId,
              ownerUserId: owner,
              runId: updateRunId,
              step,
              expectedRevision,
              command,
              actionId: CUSTOMER_CONTACT_UPDATE_ACTION_ID,
            }),
            TEST_ONLY_DEPS,
          );
        expectAdmission(
          await admitUpdate(20, 0, {
            type: 'start_run',
            intent: { mode: 'update', target: { customerId, revision: 1 } },
          }),
          'admitted',
        );
        const updateEffectId = stateEffectIdOf(await requireRun(updateRunId));
        expectAdmission(
          await admitUpdate(21, 1, {
            type: 'record_customer_resolution',
            resolution: { kind: 'target_verified', customerId },
          }),
          'admitted',
        );
        const staleProposalId = randomUUID();
        const staleConfirmationId = randomUUID();
        await sealPayload({
          companyId: effectCompanyId,
          ownerUserId: owner,
          runId: updateRunId,
          proposalId: staleProposalId,
          fields: staleFields,
        });
        const staleSensitiveDigest = computeCustomerContactSensitiveDigest(staleFields);
        expectAdmission(
          await admitUpdate(22, 2, {
            type: 'stage_proposal',
            proposalId: staleProposalId,
            confirmationId: staleConfirmationId,
            fieldsDigest: computeCustomerContactFieldsDigest(staleFields),
            sensitiveDigest: staleSensitiveDigest,
            targetRevision: 1,
          }),
          'admitted',
        );
        expectAdmission(
          await admitUpdate(23, 3, {
            type: 'record_presentation_ack',
            confirmationId: staleConfirmationId,
            ack: 'screen_ack',
          }),
          'admitted',
        );

        // LA MUTATION : pendant que la proposition est à l'écran, l'artisan corrige l'e-mail de
        // la fiche par la voie canonique (use case `UpdateCustomer`) — une VRAIE écriture, relue
        // en base. `email` compose le champ sensible `recipient` (§9.1).
        const mutatedEmail = 'contact@marie-dupont.test';
        const before = await authority.readCustomer({
          companyId: effectCompanyId,
          ownerUserId: owner,
          customerId,
        });
        if (before === null) throw new Error('Jarvis U1-d: fiche créée introuvable.');
        await expect(
          authority.updateCustomerAtRevision(
            { companyId: effectCompanyId, ownerUserId: owner, customerId },
            { ...before.fields, email: mutatedEmail },
            1,
          ),
        ).resolves.toEqual({ status: 'written' });
        await expect(auditCustomer(customerId)).resolves.toMatchObject({ email: mutatedEmail });

        // L'ÉCRITURE A BOUGÉ LA BASE : le use case canonique incrémente la révision de la fiche.
        // C'est CE fait, relu par l'admission, qui rendra la proposition stale — aucun test ne
        // fabrique plus la moindre valeur revalidée.
        const mutatedRow = await auditCustomer(customerId);
        expect(mutatedRow?.revision).toBe(2);

        // Les champs de la NOUVELLE proposition (la fiche telle qu'elle est maintenant + la
        // ville proposée) : ils servent au scellement du payload, jamais à certifier une cible.
        const revalidatedFields = proposedFields({
          displayName: null,
          legalName: null,
          phone: null,
          addressLine: null,
          postalCode: null,
          city: 'Lyon',
          email: mutatedEmail,
        });
        const revalidatedSensitiveDigest = computeCustomerContactSensitiveDigest(revalidatedFields);
        expect(revalidatedSensitiveDigest).not.toBe(staleSensitiveDigest);
        const writesBeforeInvalidation = authority.writes;
        // LE CONFIRM : trois clés, rien d'autre. L'admission relit la cible dans SA transaction
        // (révision 2, digest sensible recalculé sur l'e-mail COURANT) et compare au sceau posé
        // à la mise en proposition (révision 1) => `invalidated`.
        expectAdmission(
          await admitUpdate(24, 4, {
            type: 'confirm',
            confirmationId: staleConfirmationId,
            proposalHash: computeCustomerContactProposalHash({
              runId: updateRunId,
              proposalId: staleProposalId,
              actionId: CUSTOMER_CONTACT_UPDATE_ACTION_ID,
              fieldsDigest: computeCustomerContactFieldsDigest(staleFields),
              sensitiveDigest: staleSensitiveDigest,
              targetRevision: 1,
              effectId: updateEffectId,
            }),
          }),
          'admitted',
        );

        // LA BASE : proposition INVALIDÉE, jamais consommée — retour à la préparation, ZÉRO
        // work item, ZÉRO écriture métier.
        const invalidated = await requireRun(updateRunId);
        expect(invalidated.revision).toBe(5);
        expect(invalidated.phase).toBe('preparing_proposal');
        const invalidatedState = invalidated.payload as {
          readonly confirmation?: { readonly status?: unknown };
          readonly proposal?: unknown;
        };
        expect(invalidatedState.confirmation?.status).toBe('invalidated');
        expect(invalidatedState.proposal).toBeNull();
        const invalidationEvents = await auditEvents(updateRunId);
        expect(invalidationEvents).toHaveLength(5);
        expect(invalidationEvents[4]?.eventType).toBe('cc_proposal_invalidated');
        expect(invalidationEvents[4]?.data).toMatchObject({
          cause: 'stale_target',
          confirmationId: staleConfirmationId,
          proposalId: staleProposalId,
          // La révision journalisée vient de la BASE, pas du wire : 2, la valeur qu'a posée
          // l'écriture de l'artisan. Un test qui la fabriquerait ne prouverait rien.
          revalidatedTargetRevision: 2,
        });
        // L'intention porte désormais la cible RELUE : la prochaine proposition devra la sceller.
        const invalidatedIntent = (
          invalidated.payload as {
            readonly intent?: { readonly target?: { readonly revision?: unknown } };
          }
        ).intent;
        expect(invalidatedIntent?.target?.revision).toBe(2);
        await expect(auditWorkItems(updateRunId)).resolves.toHaveLength(0);
        expect(authority.writes).toBe(writesBeforeInvalidation);

        // NOUVELLE PROPOSITION, à jour de la mutation : elle, aboutit.
        const freshProposalId = randomUUID();
        const freshConfirmationId = randomUUID();
        await sealPayload({
          companyId: effectCompanyId,
          ownerUserId: owner,
          runId: updateRunId,
          proposalId: freshProposalId,
          fields: revalidatedFields,
        });
        const freshFieldsDigest = computeCustomerContactFieldsDigest(revalidatedFields);
        // Une proposition qui scellerait ENCORE la révision 1 naîtrait stale : le domaine la
        // refuse par son nom, avant toute écriture — la preuve que la cible relue fait autorité.
        const bornStale = expectAdmission(
          await admitUpdate(25, 5, {
            type: 'stage_proposal',
            proposalId: freshProposalId,
            confirmationId: freshConfirmationId,
            fieldsDigest: freshFieldsDigest,
            sensitiveDigest: revalidatedSensitiveDigest,
            targetRevision: 1,
          }),
          'refused',
        );
        expect(bornStale.error).toEqual({
          code: 'invalid_command',
          reason: 'target_revision_stale',
        });
        // Nouveau TOUR (nouveau `commandId`) : un geste corrigé n'est jamais le rejeu du geste
        // refusé — §5.4, un commandId ne sert qu'une intention.
        expectAdmission(
          await admitUpdate(28, 5, {
            type: 'stage_proposal',
            proposalId: freshProposalId,
            confirmationId: freshConfirmationId,
            fieldsDigest: freshFieldsDigest,
            sensitiveDigest: revalidatedSensitiveDigest,
            targetRevision: 2,
          }),
          'admitted',
        );
        expectAdmission(
          await admitUpdate(26, 6, {
            type: 'record_presentation_ack',
            confirmationId: freshConfirmationId,
            ack: 'screen_ack',
          }),
          'admitted',
        );
        // La cible n'a plus bougé depuis ce sceau : la MÊME relecture d'admission le confirme,
        // et la proposition se consomme. La garde ne bloque pas ce qui n'a pas dérivé.
        const reconfirmed = expectAdmission(
          await admitUpdate(27, 7, {
            type: 'confirm',
            confirmationId: freshConfirmationId,
            proposalHash: computeCustomerContactProposalHash({
              runId: updateRunId,
              proposalId: freshProposalId,
              actionId: CUSTOMER_CONTACT_UPDATE_ACTION_ID,
              fieldsDigest: freshFieldsDigest,
              sensitiveDigest: revalidatedSensitiveDigest,
              targetRevision: 2,
              effectId: updateEffectId,
            }),
          }),
          'admitted',
        );
        expect(reconfirmed.workItemIds).toHaveLength(1);

        const updateTick = await worker.runForCompany(effectCompanyId);
        expect(updateTick.claimed).toBe(1);
        expect(updateTick.executed).toBe(1);
        expect(updateTick.failures).toBe(0);

        // LA BASE, dernier mot : la ville proposée a recouvert la fiche, la mutation de
        // l'artisan a SURVÉCU à l'effet (une proposition stale n'écrase jamais), et rien n'a
        // été dupliqué.
        const edited = await auditCustomer(customerId);
        expect(edited?.addrCity).toBe('Lyon');
        expect(edited?.email).toBe(mutatedEmail);
        expect(edited?.name).toBe('Marie Dupont');
        expect(edited?.addrLine1).toBe('12 rue des Lilas');
        expect(edited?.addrZip).toBe('75011');
        // Troisième écriture canonique de la fiche : la révision suit, sans qu'aucun code
        // applicatif ne la pose à la main.
        expect(edited?.revision).toBe(3);
        await expect(countCustomers(effectCompanyId, customerId)).resolves.toBe(1);
        const updateItems = await auditWorkItems(updateRunId);
        expect(updateItems).toHaveLength(1);
        expect(updateItems[0]?.status).toBe('succeeded');
        expect(updateItems[0]?.resultDigest).toBe(
          jarvisCustomerEffectSuccessDigest(updateEffectId, customerId),
        );
        // Même fait qu'en création : le worker a signalé lui-même, le run s'est refermé seul.
        expect(updateItems[0]?.signalAppliedAt).not.toBeNull();
        await expect(requireRun(updateRunId)).resolves.toMatchObject({ status: 'completed' });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 5 — oracle voix/tap §19.3 sur le parcours de MODIFICATION : même journal hors CANAL, sceau de cible RELU en base',
      async () => {
        // LA MÊME cible pour les deux runs, créée par le use case CANONIQUE : deux fiches
        // jumelles auraient introduit une différence sans rapport avec le canal. Ce qui reste
        // différent entre les deux journaux est donc, ici encore, le canal et lui seul.
        const authority = new CountingJarvisCustomerEffectAuthority(
          createReducedSchemaCustomerEffectAuthorityForTesting(workerA),
        );
        const customerId = randomUUID();
        await expect(
          authority.createCustomer(
            { companyId, ownerUserId: freshOwner('update-oracle-target'), customerId },
            {
              type: 'b2c',
              name: 'Entreprise Martin',
              email: 'contact@martin.test',
              phone: '0601020304',
              contactName: 'Paul Martin',
              address: { line1: '3 rue des Peupliers', zip: '69003', city: 'Lyon' },
            },
          ),
        ).resolves.toEqual({ status: 'written' });
        const target = { customerId, revision: 1 };
        // La révision de départ est LUE, jamais supposée : c'est elle que les propositions
        // scelleront et que l'admission comparera à sa relecture.
        await expect(auditCustomer(customerId)).resolves.toMatchObject({ revision: 1 });

        const proposalId = randomUUID();
        const confirmationId = randomUUID();
        const fields = proposedFields({ city: 'Bordeaux', postalCode: '33000' });

        const voiceOwner = freshOwner('update-voice-owner');
        const voice = await liveVoiceChannel(voiceOwner);
        const voiceTrace = await driveOracleScript({
          ownerUserId: voiceOwner,
          channelAt: () => voice,
          proposalId,
          confirmationId,
          fields,
          target,
        });
        const tap = tapChannel('iphone-du-fondateur');
        const tapTrace = await driveOracleScript({
          ownerUserId: freshOwner('update-tap-owner'),
          channelAt: () => tap,
          proposalId,
          confirmationId,
          fields,
          target,
        });

        // L'ORACLE : journaux (hors colonnes de canal) et états normalisés STRICTEMENT égaux —
        // la garde §9.1 comprise, puisque le sceau de cible vit DANS le state comparé.
        const voiceEvents = await auditEvents(voiceTrace.runId);
        const tapEvents = await auditEvents(tapTrace.runId);
        expect(normalizeJournal(voiceEvents, voiceTrace.substitutions)).toEqual(
          normalizeJournal(tapEvents, tapTrace.substitutions),
        );
        const voiceRun = await requireRun(voiceTrace.runId);
        const tapRun = await requireRun(tapTrace.runId);
        expect(normalizeRun(voiceRun, voiceTrace.substitutions)).toEqual(
          normalizeRun(tapRun, tapTrace.substitutions),
        );

        // LE CANAL, LUI, DIFFÈRE — et la preuve NÉGATIVE ferme la boucle : tout le reste étant
        // prouvé égal, ces deux journaux ne peuvent différer QUE par l'acteur.
        const actorsOf = (events: readonly EventAuditRow[]): readonly string[] =>
          events.map((event) => event.actor);
        expect(actorsOf(voiceEvents)).toEqual(voiceTrace.eventActors);
        expect(actorsOf(tapEvents)).toEqual(tapTrace.eventActors);
        expect(actorsOf(voiceEvents)).not.toEqual(actorsOf(tapEvents));
        expect(journalWithActor(voiceEvents, voiceTrace.substitutions)).not.toEqual(
          journalWithActor(tapEvents, tapTrace.substitutions),
        );
        expect(voiceTrace.presentationAck).toBe('voice_presentation_ack');
        expect(tapTrace.presentationAck).toBe('screen_ack');

        // LE SCEAU DE CIBLE — il ne vient NI du canal NI du wire : les deux runs portent le
        // digest de la fiche RELUE, recalculable par l'auditeur depuis les colonnes sensibles
        // §9.1, et distinct du digest des champs PROPOSÉS (domaines séparés).
        const rows = await admin.$queryRaw<
          Array<{
            tvaIntracom: string | null;
            billingChannelType: string | null;
            addrLine1: string | null;
            addrZip: string | null;
            addrCity: string | null;
            contactName: string | null;
            email: string | null;
          }>
        >`
          SELECT "tvaIntracom", "billingChannelType", "addrLine1", "addrZip", "addrCity",
                 "contactName", "email"
            FROM public.customers
           WHERE "id" = ${customerId}
        `;
        const stored = rows[0];
        if (stored === undefined) throw new Error('Jarvis U1-e: fiche cible introuvable.');
        const expectedTargetDigest = computeCustomerContactTargetSensitiveDigest({
          vatNumber: stored.tvaIntracom,
          billingChannel: stored.billingChannelType,
          addressLine: stored.addrLine1,
          postalCode: stored.addrZip,
          city: stored.addrCity,
          recipientName: stored.contactName,
          email: stored.email,
        });
        interface PersistedProposal {
          readonly targetRevision: number | null;
          readonly targetSensitiveDigest: string | null;
          readonly sensitiveDigest: string;
        }
        const proposalOf = (row: RunAuditRow): PersistedProposal => {
          const payload = row.payload as { readonly proposal?: PersistedProposal | null } | null;
          const proposal = payload?.proposal;
          if (proposal === null || proposal === undefined) {
            throw new Error('Jarvis U1-e: proposition absente du state persisté.');
          }
          return proposal;
        };
        for (const row of [voiceRun, tapRun]) {
          const proposal = proposalOf(row);
          expect(proposal.targetRevision).toBe(1);
          expect(proposal.targetSensitiveDigest).toBe(expectedTargetDigest);
          expect(proposal.targetSensitiveDigest).not.toBe(proposal.sensitiveDigest);
        }

        // Un run, un effet : chacun porte EXACTEMENT un work item de MODIFICATION, ciblé.
        for (const trace of [voiceTrace, tapTrace]) {
          const items = await auditWorkItems(trace.runId);
          expect(items).toHaveLength(1);
          expect(items[0]?.id).toBe(trace.workItemIds[0]);
          expect(items[0]?.actionId).toBe(CUSTOMER_CONTACT_UPDATE_ACTION_ID);
          expect(items[0]?.actionVersion).toBe(1);
          expect(items[0]?.status).toBe('prepared');
          expect(items[0]?.actingPrincipalId).toBe(trace.ownerUserId);
        }
        // Aucun de ces deux runs n'a d'effet exécuté ici : la fiche n'a pas bougé d'un cran.
        await expect(auditCustomer(customerId)).resolves.toMatchObject({ revision: 1 });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve U1-i — commit CAS perdu avant storeResult : reprise indécidable, zéro second UPDATE et quarantaine durable',
      async () => {
        const ownerUserId = freshOwner('cas-failpoint-owner');
        const customerId = randomUUID();
        const authority = new CountingJarvisCustomerEffectAuthority(
          createReducedSchemaCustomerEffectAuthorityForTesting(workerA),
        );

        await expect(
          authority.createCustomer(
            { companyId: effectCompanyId, ownerUserId, customerId },
            {
              type: 'b2c',
              name: 'Client failpoint CAS',
              email: 'cas-failpoint@example.test',
              phone: '0600000000',
              address: { line1: '1 rue du CAS', zip: '75001', city: 'Paris' },
            },
          ),
        ).resolves.toEqual({ status: 'written' });
        await expect(auditCustomer(customerId)).resolves.toMatchObject({
          revision: 1,
          addrCity: 'Paris',
        });

        const admissionPort: JarvisAdmissionUnitOfWorkPort = {
          runJarvisAdmission: (envelope: JarvisUserAdmissionEnvelope) =>
            uowA.runJarvisAdmission(envelope, TEST_ONLY_DEPS),
          runJarvisSystemAdmission: (envelope: JarvisSystemAdmissionEnvelope) =>
            uowA.runJarvisSystemAdmission(envelope, TEST_ONLY_DEPS),
          readJarvisStateless: <T>(
            owner: JarvisAdmissionOwner,
            read: (view: {
              readonly runById: (runId: string) => Promise<JarvisRunEnvelope | null>;
            }) => Promise<T>,
          ): Promise<JarvisStatelessReadResult<T>> =>
            uowA.readJarvisStateless(owner, read),
        };
        const executor = new JarvisCustomerEffectExecutor({
          admission: admissionPort,
          payloads: store,
          customers: authority,
          certificationCustomerType: 'b2c',
        });

        const channel = tapChannel('cas-failpoint-device');
        const trace = await driveOracleScript({
          companyId: effectCompanyId,
          ownerUserId,
          channelAt: () => channel,
          proposalId: randomUUID(),
          confirmationId: randomUUID(),
          fields: proposedFields({
            displayName: null,
            legalName: null,
            email: null,
            phone: null,
            addressLine: null,
            postalCode: null,
            city: 'Nantes',
          }),
          target: { customerId, revision: 1 },
        });
        const workItemId = trace.workItemIds[0];
        if (workItemId === undefined) {
          throw new Error('Jarvis U1-i: work item CAS absent.');
        }

        // Premier worker réel : authorize -> UPDATE CAS committé -> perte AVANT storeResult.
        const writesBeforeEffect = authority.writes;
        const crashingWorker = dispatchWorker(
          executor,
          admissionPort,
          new FailBeforeStoreResultRepository(workerA),
        );
        expect(await crashingWorker.runForCompany(effectCompanyId)).toEqual({
          claimed: 1,
          executed: 0,
          unknown: 0,
          cancelled: 0,
          retried: 0,
          signalled: 0,
          failures: 1,
        });

        expect(authority.writes).toBe(writesBeforeEffect + 1);
        await expect(auditCustomer(customerId)).resolves.toMatchObject({
          addrCity: 'Nantes',
          revision: 2,
        });
        const [authorized] = await auditWorkItems(trace.runId);
        expect(authorized).toMatchObject({
          id: workItemId,
          status: 'authorized',
          leaseFence: 1n,
          resultDigest: null,
          signalAppliedAt: null,
        });

        // Le crash est simulé APRÈS le commit métier : on vieillit uniquement la lease afin que
        // le prochain tick emprunte `reclaimExpiredAuthorized`, jamais claim/authorize/execute.
        const aged = await admin.$executeRaw`
          UPDATE public.jarvis_work_items
             SET "leaseExpiresAt" = statement_timestamp() - INTERVAL '1 hour'
           WHERE "id" = ${workItemId}::uuid
             AND "status" = 'authorized'
             AND "resultDigest" IS NULL
        `;
        expect(aged).toBe(1);

        const writesAfterCommit = authority.writes;
        const recoveryWorker = dispatchWorker(executor, admissionPort);
        expect(await recoveryWorker.runForCompany(effectCompanyId)).toEqual({
          claimed: 0,
          executed: 0,
          unknown: 1,
          cancelled: 0,
          retried: 0,
          signalled: 0,
          failures: 0,
        });

        // Une modification sans reçu purpose-specific reste indécidable : aucun second appel
        // d'écriture, aucune révision 3, aucun reçu terminal inventé.
        expect(authority.writes).toBe(writesAfterCommit);
        await expect(auditCustomer(customerId)).resolves.toMatchObject({
          addrCity: 'Nantes',
          revision: 2,
        });
        const [unknown] = await auditWorkItems(trace.runId);
        expect(unknown).toMatchObject({
          id: workItemId,
          status: 'outcome_unknown',
          leaseFence: 2n,
          signalAppliedAt: null,
        });
        expect(unknown?.resultDigest).toBe(
          sha256Hex(
            JSON.stringify([
              'bob.jarvis.dispatch.outcome-unknown.v1',
              trace.effectId,
              'reconciliation_undecidable',
            ]),
          ),
        );

        const unresolvedRun = await requireRun(trace.runId);
        expect(unresolvedRun).toMatchObject({
          status: 'waiting_external',
          phase: 'committing',
          terminalAt: null,
        });
        expect(
          (unresolvedRun.payload as { readonly receipt?: unknown }).receipt,
        ).toBeNull();
        await expect(auditEvents(trace.runId)).resolves.toHaveLength(5);

        // Tick supplémentaire : l'inconnu durable n'est ni réexécuté, ni signalé, ni bougé.
        expect(await recoveryWorker.runForCompany(effectCompanyId)).toEqual({
          claimed: 0,
          executed: 0,
          unknown: 0,
          cancelled: 0,
          retried: 0,
          signalled: 0,
          failures: 0,
        });
        expect(authority.writes).toBe(writesAfterCommit);
        const [durableUnknown] = await auditWorkItems(trace.runId);
        expect(durableUnknown).toMatchObject({
          status: 'outcome_unknown',
          leaseFence: 2n,
          signalAppliedAt: null,
        });
      },
      TEST_TIMEOUT_MS,
    );

    /**
     * Worker de dispatch RÉEL, câblé sur les autorités réelles. Deux collaborateurs sont fournis
     * par le harnais parce que leur implémentation de production arrive avec le module (vague B) :
     *  · l'annuaire de coordonnées — en production un SECURITY DEFINER borné ; ici une LECTURE
     *    RÉELLE de `jarvis_work_items` par l'auditeur, jamais une liste écrite à la main ;
     *  · la surface `Persistence` consommée par la revalidation — `companies.findById` seul, servi
     *    par une lecture réelle de la colonne `closedAt` du tenant.
     */
    function dispatchWorker(
      executor: JarvisEffectExecutor,
      admissionPort: JarvisAdmissionUnitOfWorkPort,
      repository: PrismaJarvisWorkItemsRepository = workItems,
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
      const executors = new Map<string, JarvisEffectExecutor>([
        [jarvisEffectExecutorKey(CUSTOMER_CONTACT_CREATE_ACTION_ID, 1), executor],
        [jarvisEffectExecutorKey(CUSTOMER_CONTACT_UPDATE_ACTION_ID, 1), executor],
      ]);
      return new JarvisWorkItemDispatchService(
        persistence,
        { listCompanyIds: async () => [effectCompanyId] } as unknown as ScheduledTenantDirectory,
        new AppLogger(),
        repository,
        directory,
        admissionPort,
        executors,
        TEST_ONLY_JARVIS_ACTION_RELEASE_POLICY,
      );
    }
  },
);

/**
 * Failpoint U1-i : toute la chaîne utilise le vrai repository jusqu'au COMMIT client, puis le
 * résultat du premier worker est perdu avant l'UPDATE de `storeResult`. Aucun hook test-only ne
 * pénètre le code de production ; la reprise suivante relit la vraie ligne `authorized`.
 */
class FailBeforeStoreResultRepository extends PrismaJarvisWorkItemsRepository {
  override storeResult(
    ...args: Parameters<PrismaJarvisWorkItemsRepository['storeResult']>
  ): Promise<boolean> {
    void args;
    return Promise.reject(
      new Error('TEST_FAILPOINT_AFTER_CUSTOMER_COMMIT_BEFORE_STORE_RESULT'),
    );
  }
}

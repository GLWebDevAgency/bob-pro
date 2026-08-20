/**
 * Jarvis U1-d — certification PostgreSQL de l'exécuteur d'effet fiche client
 * (spec Jarvis §5.3/§9.1, SPEC_U1D §3 « EXÉCUTEUR D'EFFET », preuves §19.2).
 *
 * Le run est conduit par LE VRAI port d'admission (seed → résolution → proposition → ack →
 * confirm), le work item est réclamé par LE VRAI repository de dispatch, la charge est scellée
 * par LE VRAI magasin, et l'écriture métier passe par les use cases CANONIQUES de la fiche
 * client (`Customer.of` + `customers.save` ; `UpdateCustomer` @bob/core) — aucun insert brut ne
 * fabrique jamais ce qui est prouvé. Preuves :
 *
 *  (1) coordinateur §9.1 : le MÊME effectId exécuté DEUX fois rend le MÊME `customerId` et le
 *      MÊME digest, l'autorité n'est écrite qu'UNE fois et la base ne porte qu'UNE fiche ;
 *  (2) réconciliation par effectId (U1-c revue C10) : après l'atterrissage, la relecture tranche
 *      `landed` ; un effet jamais exécuté rend `not_landed` — aucune issue inventée ;
 *  (3) édition : le CAS recouvre la révision confirmée une seule fois ; une reprise sans reçu
 *      est indécidable et une correction ultérieure ne réécrit pas la révision du reçu ;
 *  (4) fail-closed G4 : charge scellée absente ⇒ `failed_terminal`, ZÉRO écriture métier ;
 *  (5) borne technique (G2) : une action hors `U1_CANDIDATE_ACTIONS` ne touche rien ;
 *  (6) §8 : sans type légal PROPOSÉ, la création est refusée — jamais un régime légal deviné.
 */
import { randomUUID } from 'node:crypto';

import {
  CUSTOMER_CONTACT_CREATE_ACTION_ID,
  CUSTOMER_CONTACT_UPDATE_ACTION_ID,
  Customer,
  computeCustomerContactFieldsDigest,
  computeCustomerContactProposalHash,
  computeCustomerContactSensitiveDigest,
  sha256Hex,
  type AgentMissionFingerprintPort,
  type CustomerContactProposedFieldsV1,
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

import { PrismaAgentMissionUnitOfWork } from '../persistence/prisma/agent-mission.persistence';
import { TEST_ONLY_JARVIS_ACTION_RELEASE_POLICY } from '../jarvis/jarvis-release-policy.testing';
import type { JarvisAdmissionDeps } from '../persistence/prisma/jarvis-admission.persistence';
import { PrismaJarvisProposalPayloadStore } from '../persistence/prisma/jarvis-proposal-payloads.persistence';
import {
  PrismaJarvisWorkItemsRepository,
  type JarvisWorkItemCoordinates,
  type JarvisWorkItemLease,
} from '../persistence/prisma/jarvis-work-items.persistence';
import { PrismaService } from '../persistence/prisma/prisma.service';
import { PrismaCustomerRepository } from '../persistence/prisma/repositories';
import {
  CountingJarvisCustomerEffectAuthority,
  createPrismaCustomerEffectAuthorityForTesting,
} from '../jarvis/jarvis-customer-effect.authority.testing';
import {
  JarvisCustomerEffectExecutor,
  deriveJarvisEffectCustomerId,
  jarvisCustomerEffectFailureDigest,
  jarvisCustomerEffectSuccessDigest,
} from './jarvis-customer-effect.executor';

const RUN_CERT = process.env.RUN_AGENT_MISSION_POSTGRES_CERT === 'true';
const DISPOSABLE = process.env.AGENT_MISSION_CERT_DATABASE_IS_DISPOSABLE === 'true';

const TEST_TIMEOUT_MS = 60_000;
const LEASE_DURATION_MS = 60_000;

const FINGERPRINTS: AgentMissionFingerprintPort = {
  sign(canonicalRequest) {
    return { keyVersion: 1, hmac: sha256Hex(`jarvis-u1d-effect-key:${canonicalRequest}`) };
  },
  matches(canonicalRequest, fingerprint) {
    if (fingerprint.keyVersion !== 1) return null;
    return fingerprint.hmac === sha256Hex(`jarvis-u1d-effect-key:${canonicalRequest}`);
  },
};

const TEST_ONLY_ADMISSION_DEPS: JarvisAdmissionDeps = {
  fingerprints: FINGERPRINTS,
  canonicalizationVersion: 1,
  admissionEnabled: true,
  allowCertificationAuthority: true,
  actionReleasePolicy: TEST_ONLY_JARVIS_ACTION_RELEASE_POLICY,
};

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

interface CustomerAuditRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly addrLine1: string;
  readonly addrZip: string;
  readonly addrCity: string;
  readonly revision: number;
}

describe.skipIf(!RUN_CERT)(
  'Jarvis U1-d — certification PostgreSQL de l’exécuteur d’effet fiche client (§9.1)',
  () => {
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const certAdminUrl = process.env.AGENT_MISSION_CERT_ADMIN_URL ?? '';
    const companyId = `jarvis-effect-company-${randomUUID()}`;
    let admin: PrismaClient;
    let worker: PrismaService;
    let uow: PrismaAgentMissionUnitOfWork;
    let store: PrismaJarvisProposalPayloadStore;
    let workItems: PrismaJarvisWorkItemsRepository;
    let authority: CountingJarvisCustomerEffectAuthority;
    /** Adapter port mono-argument -> UoW(envelope, deps) : exactement ce que câblera la vague B. */
    let admission: JarvisAdmissionUnitOfWorkPort;

    function userEnvelope(input: {
      readonly ownerUserId: string;
      readonly runId: string;
      readonly expectedRevision: number;
      readonly command: unknown;
      readonly actionId?: string;
    }): JarvisUserAdmissionEnvelope {
      return Object.freeze({
        kind: 'customer_contact' as const,
        definitionVersion: 1,
        companyId,
        ownerUserId: input.ownerUserId,
        runId: input.runId,
        commandId: randomUUID(),
        expectedRevision: input.expectedRevision,
        actionId: input.actionId ?? CUSTOMER_CONTACT_CREATE_ACTION_ID,
        actionVersion: 1,
        authority: { source: 'certification_fixture' } as const,
        command: input.command,
        canonicalInputDigest: sha256Hex(`jarvis-u1d-effect-input:${JSON.stringify(input.command)}`),
        occurredAt: new Date().toISOString(),
      });
    }

    function admit(
      envelope: JarvisUserAdmissionEnvelope,
      label: string,
    ): Promise<JarvisAdmissionResult> {
      return uow.runJarvisAdmission(envelope, TEST_ONLY_ADMISSION_DEPS).then((result) => {
        if (result.status !== 'admitted') {
          throw new Error(`Jarvis U1-d: ${label} refusé ${JSON.stringify(result)}`);
        }
        return result;
      });
    }

    async function runState(runId: string): Promise<{ readonly effectId: string }> {
      const rows = await admin.$queryRaw<Array<{ payload: unknown }>>`
        SELECT "payload" FROM public.agent_missions WHERE "id" = ${runId}::uuid
      `;
      const payload = rows[0]?.payload as { readonly effectId?: unknown } | undefined;
      if (payload === undefined || typeof payload.effectId !== 'string') {
        throw new Error('Jarvis U1-d: effectId absent du state persisté.');
      }
      return { effectId: payload.effectId };
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

    /** Compte les fiches portant CET identifiant : la preuve d'idempotence est locale au run. */
    async function countCustomers(customerId: string): Promise<number> {
      const rows = await admin.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS "count"
          FROM public.customers
         WHERE "companyId" = ${companyId}
           AND "id" = ${customerId}
      `;
      return rows[0]?.count ?? 0;
    }

    /**
     * Conduit un run RÉEL jusqu'à `committing` (confirm consommé, work item émis), en scellant la
     * charge AVANT `stage_proposal` — l'ordre exigé par la doctrine du magasin.
     */
    async function driveRun(input: {
      readonly ownerUserId: string;
      readonly fields: CustomerContactProposedFieldsV1;
      readonly target?: { readonly customerId: string; readonly revision: number };
      readonly sealPayload?: boolean;
    }): Promise<{
      readonly coordinates: JarvisWorkItemCoordinates;
      readonly effectId: string;
      readonly lease: JarvisWorkItemLease;
    }> {
      const ownerUserId = input.ownerUserId;
      const runId = randomUUID();
      const update = input.target;
      const actionId =
        update === undefined
          ? CUSTOMER_CONTACT_CREATE_ACTION_ID
          : CUSTOMER_CONTACT_UPDATE_ACTION_ID;
      await admit(
        userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 0,
          actionId,
          command: {
            type: 'start_run',
            intent:
              update === undefined
                ? { mode: 'create' }
                : {
                    mode: 'update',
                    target: { customerId: update.customerId, revision: update.revision },
                  },
          },
        }),
        'start_run',
      );
      const { effectId } = await runState(runId);
      await admit(
        userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 1,
          actionId,
          command: {
            type: 'record_customer_resolution',
            resolution:
              update === undefined
                ? { kind: 'no_duplicates' }
                : {
                    kind: 'target_verified',
                    customerId: update.customerId,
                  },
          },
        }),
        'record_customer_resolution',
      );

      const proposalId = randomUUID();
      const confirmationId = randomUUID();
      const fieldsDigest = computeCustomerContactFieldsDigest(input.fields);
      const sensitiveDigest = computeCustomerContactSensitiveDigest(input.fields);
      const targetRevision = update === undefined ? null : update.revision;
      if (input.sealPayload !== false) {
        // AVANT stage_proposal : le sceau promis par le run existe déjà en base.
        const sealed = await store.sealProposalPayload({
          companyId,
          ownerUserId,
          runId,
          proposalId,
          fieldsDigest,
          sensitiveDigest,
          fields: input.fields,
          retentionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
        });
        if (sealed.status !== 'sealed') {
          throw new Error(`Jarvis U1-d: scellement raté ${JSON.stringify(sealed)}`);
        }
      }
      await admit(
        userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 2,
          actionId,
          command: {
            type: 'stage_proposal',
            proposalId,
            confirmationId,
            fieldsDigest,
            sensitiveDigest,
            targetRevision,
          },
        }),
        'stage_proposal',
      );
      await admit(
        userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 3,
          actionId,
          command: { type: 'record_presentation_ack', confirmationId, ack: 'screen_ack' },
        }),
        'record_presentation_ack',
      );
      const proposalHash = computeCustomerContactProposalHash({
        runId,
        proposalId,
        actionId,
        fieldsDigest,
        sensitiveDigest,
        targetRevision,
        effectId,
      });
      await admit(
        userEnvelope({
          ownerUserId,
          runId,
          expectedRevision: 4,
          actionId,
          // U1-e §2 : le confirm ne porte QUE ces trois clés. La révision et le digest sensible
          // de la cible sont relus par l'admission, sous verrou, dans SA transaction.
          command: { type: 'confirm', confirmationId, proposalHash },
        }),
        'confirm',
      );

      const coordinates: JarvisWorkItemCoordinates = { companyId, ownerUserId, runId };
      const claimed = await workItems.claimDue(coordinates, {
        leaseOwner: 'jarvis-u1d-cert-worker',
        leaseToken: randomUUID(),
        leaseDurationMs: LEASE_DURATION_MS,
        limit: 5,
      });
      const lease = claimed[0];
      if (claimed.length !== 1 || lease === undefined) {
        throw new Error(`Jarvis U1-d: work item attendu, reçu ${claimed.length}`);
      }
      return { coordinates, effectId, lease };
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
      worker = new PrismaService({ datasourceUrl: runtimeUrl, errorFormat: 'minimal' });
      uow = new PrismaAgentMissionUnitOfWork(worker);
      store = new PrismaJarvisProposalPayloadStore(worker);
      workItems = new PrismaJarvisWorkItemsRepository(worker);
      authority = new CountingJarvisCustomerEffectAuthority(
        createPrismaCustomerEffectAuthorityForTesting(worker),
      );
      admission = {
        runJarvisAdmission: (envelope: JarvisUserAdmissionEnvelope) =>
          uow.runJarvisAdmission(envelope, TEST_ONLY_ADMISSION_DEPS),
        runJarvisSystemAdmission: (envelope: JarvisSystemAdmissionEnvelope) =>
          uow.runJarvisSystemAdmission(envelope, TEST_ONLY_ADMISSION_DEPS),
        readJarvisStateless: <T>(
          owner: JarvisAdmissionOwner,
          read: (view: {
            readonly runById: (runId: string) => Promise<JarvisRunEnvelope | null>;
          }) => Promise<T>,
        ): Promise<JarvisStatelessReadResult<T>> => uow.readJarvisStateless(owner, read),
      };
      await Promise.all([admin.$connect(), worker.$connect()]);
      await admin.$executeRaw`
        INSERT INTO public.companies (
          "id", "name", "legalForm", "siren", "siret", "trade", "vatRegime",
          "addrLine1", "addrZip", "addrCity"
        ) VALUES (
          ${companyId}, ${'Jarvis effect cert 8'}, ${'EI'},
          ${'903000008'}, ${'90300000800008'},
          ${'certification'}, ${'reel_normal'},
          ${'1 rue du Test'}, ${'75001'}, ${'Paris'}
        )
      `;
    }, 30_000);

    afterAll(async () => {
      await Promise.all([admin?.$disconnect(), worker?.$disconnect()]);
    });

    /**
     * `null` = AUCUN type de certification : le câblage de production exact, où la création
     * refuse tant que la frame ne propose pas le type légal (§8).
     */
    function executor(certificationCustomerType: 'b2c' | 'b2b' | 'b2g' | null = 'b2c') {
      return new JarvisCustomerEffectExecutor({
        admission,
        payloads: store,
        customers: authority,
        ...(certificationCustomerType === null ? {} : { certificationCustomerType }),
      });
    }

    it(
      'preuve 1 & 2 — création : même effectId ⇒ même customerId, une seule écriture, réconciliable',
      async () => {
        const fields = proposedFields();
        const { coordinates, effectId, lease } = await driveRun({
          ownerUserId: `jarvis-effect-owner-${randomUUID()}`,
          fields,
        });
        const expectedCustomerId = deriveJarvisEffectCustomerId(effectId);
        const before = authority.writes;

        const first = await executor().execute({ coordinates, lease });
        expect(first).toEqual({
          status: 'succeeded',
          resultDigest: jarvisCustomerEffectSuccessDigest(effectId, expectedCustomerId),
        });
        const created = await auditCustomer(expectedCustomerId);
        expect(created?.name).toBe('Marie Dupont');
        expect(created?.type).toBe('b2c');
        expect(created?.email).toBe('marie.dupont@example.test');
        expect(created?.addrCity).toBe('Paris');
        expect(authority.writes).toBe(before + 1);

        // Rejeu du MÊME effet : même issue, même fiche, AUCUNE seconde écriture.
        const replay = await executor().execute({ coordinates, lease });
        expect(replay).toEqual(first);
        expect(authority.writes).toBe(before + 1);
        await expect(countCustomers(expectedCustomerId)).resolves.toBe(1);

        await expect(executor().reconcileEffect({ coordinates, lease })).resolves.toEqual({
          kind: 'landed',
          outcome: first,
        });
        // Un effet jamais exécuté n'a rien fait atterrir : la réconciliation ne l'invente pas.
        const neverRun = { ...lease, effectId: randomUUID() };
        await expect(executor().reconcileEffect({ coordinates, lease: neverRun })).resolves.toEqual(
          { kind: 'not_landed' },
        );
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 3 — édition : CAS unique, reprise indécidable et reçu stable malgré N+2',
      async () => {
        const ownerUserId = `jarvis-effect-owner-${randomUUID()}`;
        const seedFields = proposedFields({ displayName: 'Entreprise Martin' });
        const created = await driveRun({ ownerUserId, fields: seedFields });
        const customerId = deriveJarvisEffectCustomerId(created.effectId);
        expect(
          (await executor().execute({ coordinates: created.coordinates, lease: created.lease }))
            .status,
        ).toBe('succeeded');

        const edited = proposedFields({
          displayName: null,
          legalName: null,
          email: null,
          phone: null,
          addressLine: null,
          postalCode: null,
          city: 'Lyon',
        });
        const update = await driveRun({
          ownerUserId,
          fields: edited,
          target: { customerId, revision: 1 },
        });
        const expectedDigest = jarvisCustomerEffectSuccessDigest(update.effectId, customerId);

        const first = await executor().execute({
          coordinates: update.coordinates,
          lease: update.lease,
        });
        expect(first).toEqual({ status: 'succeeded', resultDigest: expectedDigest });
        const afterUpdate = await auditCustomer(customerId);
        expect(afterUpdate?.addrCity).toBe('Lyon');
        // Champs NON proposés : intacts — `null` veut dire « non proposé », jamais « efface ».
        expect(afterUpdate?.name).toBe('Entreprise Martin');
        expect(afterUpdate?.email).toBe('marie.dupont@example.test');
        expect(afterUpdate?.addrLine1).toBe('12 rue des Lilas');
        expect(afterUpdate?.revision).toBe(2);

        // Crash logique après commit métier mais avant storeResult : sans reçu purpose-specific,
        // la reprise n'essaie JAMAIS un second UPDATE.
        const beforeReconcileCalls = authority.writes;
        await expect(
          executor().reconcileEffect({ coordinates: update.coordinates, lease: update.lease }),
        ).resolves.toEqual({ kind: 'undecidable' });
        expect(authority.writes).toBe(beforeReconcileCalls);
        expect((await auditCustomer(customerId))?.revision).toBe(2);

        // Une correction humaine ultérieure avance la fiche à N+2. Le reçu de CET effet reste
        // pourtant N+1 : une redelivery ne réécrit pas l'histoire avec la révision courante.
        const current = await worker.withTenant(companyId, () =>
          new PrismaCustomerRepository(worker).findById(customerId),
        );
        if (current === null) throw new Error('fiche CAS absente');
        const human = Customer.of({ ...current.toProps(), name: 'Correction humaine ultérieure' });
        if (!human.ok) throw new Error('postimage humain invalide');
        await worker.withTenant(companyId, () =>
          new PrismaCustomerRepository(worker).save(human.value),
        );
        expect((await auditCustomer(customerId))?.revision).toBe(3);
        await expect(
          executor().describeSucceededEffect({
            coordinates: update.coordinates,
            effectId: update.effectId,
          }),
        ).resolves.toEqual({
          kind: 'succeeded',
          customerId,
          customerRevision: 2,
        });
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve CAS — une mutation humaine entre le préflight et l’effet reste intacte',
      async () => {
        const ownerUserId = `jarvis-effect-owner-${randomUUID()}`;
        const created = await driveRun({ ownerUserId, fields: proposedFields() });
        const customerId = deriveJarvisEffectCustomerId(created.effectId);
        expect(
          (await executor().execute({ coordinates: created.coordinates, lease: created.lease }))
            .status,
        ).toBe('succeeded');

        const update = await driveRun({
          ownerUserId,
          fields: proposedFields({ displayName: 'Écriture Bob obsolète' }),
          target: { customerId, revision: 1 },
        });
        const current = await worker.withTenant(companyId, () =>
          new PrismaCustomerRepository(worker).findById(customerId),
        );
        if (current === null) throw new Error('fiche à concurrencer absente');
        const human = Customer.of({ ...current.toProps(), name: 'Écriture humaine autoritaire' });
        if (!human.ok) throw new Error('postimage humain invalide');
        await worker.withTenant(companyId, () =>
          new PrismaCustomerRepository(worker).save(human.value),
        );

        await expect(
          executor().execute({ coordinates: update.coordinates, lease: update.lease }),
        ).resolves.toEqual({
          status: 'failed_terminal',
          resultDigest: jarvisCustomerEffectFailureDigest(
            update.effectId,
            'target_revision_stale',
          ),
        });
        const after = await auditCustomer(customerId);
        expect(after?.name).toBe('Écriture humaine autoritaire');
        expect(after?.revision).toBe(2);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve repository — deux CAS sur N ont un gagnant unique et une absence ne devient jamais un insert',
      async () => {
        const seedRun = await driveRun({
          ownerUserId: `jarvis-effect-owner-${randomUUID()}`,
          fields: proposedFields(),
        });
        const customerId = deriveJarvisEffectCustomerId(seedRun.effectId);
        await executor().execute({ coordinates: seedRun.coordinates, lease: seedRun.lease });
        const persisted = await worker.withTenant(companyId, () =>
          new PrismaCustomerRepository(worker).findById(customerId),
        );
        if (persisted === null) throw new Error('fiche de course absente');
        const left = Customer.of({ ...persisted.toProps(), name: 'Gagnant gauche' });
        const right = Customer.of({ ...persisted.toProps(), name: 'Gagnant droite' });
        if (!left.ok || !right.ok) throw new Error('postimages de course invalides');

        const outcomes = await Promise.all([
          worker.withTenant(companyId, () =>
            new PrismaCustomerRepository(worker).saveIfRevision(left.value, 1),
          ),
          worker.withTenant(companyId, () =>
            new PrismaCustomerRepository(worker).saveIfRevision(right.value, 1),
          ),
        ]);
        expect([...outcomes].sort()).toEqual(['revision_conflict', 'saved']);
        const winner = await auditCustomer(customerId);
        expect(['Gagnant gauche', 'Gagnant droite']).toContain(winner?.name);
        expect(winner?.revision).toBe(2);

        const ghostId = randomUUID();
        const ghost = Customer.of({
          ...persisted.toProps(),
          id: ghostId,
          name: 'Ne doit pas être inséré',
        });
        if (!ghost.ok) throw new Error('fantôme invalide');
        await expect(
          worker.withTenant(companyId, () =>
            new PrismaCustomerRepository(worker).saveIfRevision(ghost.value, 1),
          ),
        ).resolves.toBe('revision_conflict');
        await expect(countCustomers(ghostId)).resolves.toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 4 — charge scellée absente : échec terminal, zéro écriture métier',
      async () => {
        const { coordinates, effectId, lease } = await driveRun({
          ownerUserId: `jarvis-effect-owner-${randomUUID()}`,
          fields: proposedFields(),
          sealPayload: false,
        });
        const before = authority.writes;

        await expect(executor().execute({ coordinates, lease })).resolves.toEqual({
          status: 'failed_terminal',
          resultDigest: jarvisCustomerEffectFailureDigest(effectId, 'payload_unavailable'),
        });
        expect(authority.writes).toBe(before);
        await expect(auditCustomer(deriveJarvisEffectCustomerId(effectId))).resolves.toBeNull();
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 5 & 6 — borne d’ouverture U1 et type légal non proposé : rien ne part',
      async () => {
        const { coordinates, effectId, lease } = await driveRun({
          ownerUserId: `jarvis-effect-owner-${randomUUID()}`,
          fields: proposedFields(),
        });
        const before = authority.writes;

        // Action hors U1_CANDIDATE_ACTIONS : refus AVANT toute lecture de run ou de charge.
        await expect(
          executor().execute({
            coordinates,
            lease: { ...lease, actionId: 'devis-creer' },
          }),
        ).resolves.toEqual({
          status: 'failed_terminal',
          resultDigest: jarvisCustomerEffectFailureDigest(effectId, 'action_not_open'),
        });

        // §8 : sans type légal proposé, la création est refusée — jamais un régime deviné.
        await expect(executor(null).execute({ coordinates, lease })).resolves.toEqual({
          status: 'failed_terminal',
          resultDigest: jarvisCustomerEffectFailureDigest(effectId, 'customer_type_unproposed'),
        });
        expect(authority.writes).toBe(before);
        await expect(auditCustomer(deriveJarvisEffectCustomerId(effectId))).resolves.toBeNull();
      },
      TEST_TIMEOUT_MS,
    );
  },
);

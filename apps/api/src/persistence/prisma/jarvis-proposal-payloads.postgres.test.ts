/**
 * Jarvis U1-d — certification PostgreSQL du magasin de payloads de proposition
 * (spec Jarvis §5.1/§5.5/§9.1, SPEC_U1D §3 « MOBILE » + greffe G4, preuves §19.2).
 *
 * Chaque preuve passe par le VRAI magasin (`sealProposalPayload` / `readProposalPayload` /
 * `purgeExpired`) puis RELIT LA BASE par l'auditeur — jamais seulement le résultat du port :
 *
 *  (1) scellement : la charge est écrite avec ses deux digests et son échéance, et se relit
 *      champ pour champ ;
 *  (2) rejeu du MÊME sceau => `replayed`, zéro écriture (`createdAt` inchangé, une seule ligne) ;
 *  (3) même clé, contenu DIFFÉRENT => `conflict` et la charge d'origine survit intacte — un
 *      sceau promis dans le run ne peut jamais être réécrit sous ses pieds ;
 *  (4) greffe G4 : un `fieldsDigest` attendu qui diverge rend la charge ABSENTE ;
 *  (5) altération au repos (l'auditeur réécrit le JSON) => absente aussi : le digest est
 *      RECALCULÉ depuis le contenu, jamais cru sur parole ;
 *  (6) RLS fail-closed : un autre propriétaire et une autre société ne voient rien, ni par le
 *      port ni par un SELECT brut sous leurs propres GUC ;
 *  (7) aucun orphelin : un run inconnu ne produit aucune ligne (FK) — `unavailable`, fail-closed ;
 *  (8) rétention §5.5 : une charge échue cesse d'être lisible AVANT même d'être purgée, la purge
 *      l'efface réellement, et la base refuse d'effacer une charge encore VIVANTE même quand
 *      l'appelant le demande (la policy est l'autorité, pas le WHERE de l'applicatif) ;
 *  (9) immuabilité : le rôle applicatif n'a AUCUN droit d'UPDATE sur cette table.
 *
 * Même harnais que jarvis-admission.postgres.test.ts : gates env, base jetable, société créée
 * par l'auditeur, runs `customer_contact` seedés par LE VRAI port d'admission.
 */
import { randomUUID } from 'node:crypto';

import {
  CUSTOMER_CONTACT_CREATE_ACTION_ID,
  computeCustomerContactFieldsDigest,
  computeCustomerContactSensitiveDigest,
  sha256Hex,
  type AgentMissionFingerprintPort,
  type CustomerContactProposedFieldsV1,
  type JarvisUserAdmissionEnvelope,
} from '@bob/core';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  JARVIS_PROPOSAL_PAYLOAD_PURGE_LIMIT_PER_OWNER,
  JARVIS_PROPOSAL_PAYLOAD_PURGE_MAX_OWNERS_PER_TENANT,
} from '../../jobs/jarvis-proposal-payload-purge.service';
import { PrismaAgentMissionUnitOfWork } from './agent-mission.persistence';
import { TEST_ONLY_JARVIS_ACTION_RELEASE_POLICY } from '../../jarvis/jarvis-release-policy.testing';
import type { JarvisAdmissionDeps } from './jarvis-admission.persistence';
import { PrismaJarvisProposalPayloadStore } from './jarvis-proposal-payloads.persistence';
import { PrismaService } from './prisma.service';

const RUN_CERT = process.env.RUN_AGENT_MISSION_POSTGRES_CERT === 'true';
const DISPOSABLE = process.env.AGENT_MISSION_CERT_DATABASE_IS_DISPOSABLE === 'true';
/**
 * Jarvis U1-e §4 — les preuves de l'ANNUAIRE D'AUTORITÉ exigent un état que la migration seule ne
 * produit pas : la fonction `list_jarvis_payload_retention_owners_v1` naît SECURITY INVOKER et ne
 * devient utilisable qu'après le bloc `provision_jarvis_payload_retention_directory` de
 * `release.sh` (bascule SECURITY DEFINER, rôle d'autorité, GRANT par colonne).
 *
 * Ce drapeau ne DÉSACTIVE donc pas une preuve : il déclare que la base sous test a bien reçu la
 * migration 20260819210000 ET son provisionnement. Le `beforeAll` ci-dessous REFUSE d'exécuter
 * quoi que ce soit si ce n'est pas vrai — un drapeau posé à tort échoue, il ne rend jamais vert.
 */
const DIRECTORY_CERT = process.env.JARVIS_PAYLOAD_RETENTION_DIRECTORY_CERT === 'true';
const RETENTION_DIRECTORY_ROLE = 'bob_jarvis_payload_retention_directory';

const TEST_TIMEOUT_MS = 60_000;
const TRANSACTION_OPTIONS = { maxWaitMs: 5_000, timeoutMs: 15_000 } as const;

const FINGERPRINTS: AgentMissionFingerprintPort = {
  sign(canonicalRequest) {
    return { keyVersion: 1, hmac: sha256Hex(`jarvis-u1d-payload-key:${canonicalRequest}`) };
  },
  matches(canonicalRequest, fingerprint) {
    if (fingerprint.keyVersion !== 1) return null;
    return fingerprint.hmac === sha256Hex(`jarvis-u1d-payload-key:${canonicalRequest}`);
  },
};

const TEST_ONLY_ADMISSION_DEPS: JarvisAdmissionDeps = {
  fingerprints: FINGERPRINTS,
  canonicalizationVersion: 1,
  admissionEnabled: true,
  allowCertificationAuthority: true,
  actionReleasePolicy: TEST_ONLY_JARVIS_ACTION_RELEASE_POLICY,
};

/** Champs proposés canoniques — la PII de fixture ne sort jamais de cette base jetable. */
function proposedFields(
  overrides: Partial<CustomerContactProposedFieldsV1> = {},
): CustomerContactProposedFieldsV1 {
  return Object.freeze({
    displayName: 'Marie Dupont',
    legalName: null,
    email: 'marie.dupont@example.test',
    phone: null,
    addressLine: '12 rue des Lilas',
    postalCode: '75011',
    city: 'Paris',
    vatNumber: null,
    billingChannel: null,
    recipientName: null,
    ...overrides,
  });
}

interface PayloadAuditRow {
  readonly ownerUserId: string;
  readonly fieldsDigest: string;
  readonly sensitiveDigest: string;
  readonly payload: unknown;
  readonly createdAt: Date;
  readonly retentionExpiresAt: Date;
}

describe.skipIf(!RUN_CERT)(
  'Jarvis U1-d — certification PostgreSQL du magasin de payloads (§5.5, G4)',
  () => {
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const certAdminUrl = process.env.AGENT_MISSION_CERT_ADMIN_URL ?? '';
    const companyA = `jarvis-payload-company-a-${randomUUID()}`;
    const companyB = `jarvis-payload-company-b-${randomUUID()}`;
    let admin: PrismaClient;
    let worker: PrismaService;
    let uow: PrismaAgentMissionUnitOfWork;
    let store: PrismaJarvisProposalPayloadStore;

    function userEnvelope(input: {
      readonly companyId: string;
      readonly ownerUserId: string;
      readonly runId: string;
      readonly expectedRevision: number;
      readonly command: unknown;
    }): JarvisUserAdmissionEnvelope {
      return Object.freeze({
        kind: 'customer_contact' as const,
        definitionVersion: 1,
        companyId: input.companyId,
        ownerUserId: input.ownerUserId,
        runId: input.runId,
        commandId: randomUUID(),
        expectedRevision: input.expectedRevision,
        actionId: CUSTOMER_CONTACT_CREATE_ACTION_ID,
        actionVersion: 1,
        authority: { source: 'certification_fixture' } as const,
        command: input.command,
        canonicalInputDigest: sha256Hex(
          `jarvis-u1d-payload-input:${JSON.stringify(input.command)}`,
        ),
        occurredAt: new Date().toISOString(),
      });
    }

    /** Run RÉEL par le VRAI port : aucune ligne fabriquée à la main sous la charge. */
    async function seedRun(
      companyId: string,
    ): Promise<{
      readonly companyId: string;
      readonly ownerUserId: string;
      readonly runId: string;
    }> {
      const ownerUserId = `jarvis-payload-owner-${randomUUID()}`;
      const runId = randomUUID();
      const result = await uow.runJarvisAdmission(
        userEnvelope({
          companyId,
          ownerUserId,
          runId,
          expectedRevision: 0,
          command: { type: 'start_run', intent: { mode: 'create' } },
        }),
        TEST_ONLY_ADMISSION_DEPS,
      );
      if (result.status !== 'admitted') {
        throw new Error(`Jarvis U1-d: seed refusé ${JSON.stringify(result)}`);
      }
      return { companyId, ownerUserId, runId };
    }

    async function auditPayload(
      runId: string,
      proposalId: string,
    ): Promise<PayloadAuditRow | null> {
      const rows = await admin.$queryRaw<PayloadAuditRow[]>`
        SELECT "ownerUserId", "fieldsDigest", "sensitiveDigest", "payload",
               "createdAt", "retentionExpiresAt"
          FROM public.jarvis_proposal_payloads
         WHERE "runId" = ${runId}::uuid
           AND "proposalId" = ${proposalId}::uuid
      `;
      return rows[0] ?? null;
    }

    async function countPayloads(runId: string): Promise<number> {
      const rows = await admin.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS "count"
          FROM public.jarvis_proposal_payloads
         WHERE "runId" = ${runId}::uuid
      `;
      return rows[0]?.count ?? 0;
    }

    /**
     * Vieillissement PAR L'AUDITEUR (harnais §19.2) : jamais par le magasin. Les DEUX
     * horodatages reculent — la contrainte `retentionExpiresAt > createdAt` est un invariant de
     * la ligne, pas un obstacle de harnais : une charge échue est une VIEILLE charge, pas une
     * charge née périmée.
     */
    async function ageRetention(runId: string, proposalId: string): Promise<void> {
      const count = await admin.$executeRaw`
        UPDATE public.jarvis_proposal_payloads
           SET "createdAt" = statement_timestamp() - INTERVAL '2 hours',
               "retentionExpiresAt" = statement_timestamp() - INTERVAL '1 hour'
         WHERE "runId" = ${runId}::uuid
           AND "proposalId" = ${proposalId}::uuid
      `;
      if (count !== 1) throw new Error('Jarvis U1-d: vieillissement de rétention raté.');
    }

    /** Altération au repos, simulée par l'auditeur : le sceau doit la détecter seul. */
    async function tamperPayload(runId: string, proposalId: string): Promise<void> {
      const count = await admin.$executeRaw`
        UPDATE public.jarvis_proposal_payloads
           SET "payload" = jsonb_set("payload", '{city}', '"Lyon"'::jsonb)
         WHERE "runId" = ${runId}::uuid
           AND "proposalId" = ${proposalId}::uuid
      `;
      if (count !== 1) throw new Error('Jarvis U1-d: altération de charge ratée.');
    }

    function sealInput(
      coordinates: {
        readonly companyId: string;
        readonly ownerUserId: string;
        readonly runId: string;
      },
      proposalId: string,
      fields: CustomerContactProposedFieldsV1,
      retentionMs = 30 * 24 * 60 * 60_000,
    ): {
      readonly companyId: string;
      readonly ownerUserId: string;
      readonly runId: string;
      readonly proposalId: string;
      readonly fieldsDigest: string;
      readonly sensitiveDigest: string;
      readonly fields: CustomerContactProposedFieldsV1;
      readonly retentionExpiresAt: string;
    } {
      return {
        ...coordinates,
        proposalId,
        fieldsDigest: computeCustomerContactFieldsDigest(fields),
        sensitiveDigest: computeCustomerContactSensitiveDigest(fields),
        fields,
        retentionExpiresAt: new Date(Date.now() + retentionMs).toISOString(),
      };
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
      await Promise.all([admin.$connect(), worker.$connect()]);
      for (const [companyId, suffix] of [
        [companyA, '6'],
        [companyB, '7'],
      ] as const) {
        await admin.$executeRaw`
          INSERT INTO public.companies (
            "id", "name", "legalForm", "siren", "siret", "trade", "vatRegime",
            "addrLine1", "addrZip", "addrCity"
          ) VALUES (
            ${companyId}, ${`Jarvis payload cert ${suffix}`}, ${'EI'},
            ${`90300000${suffix}`}, ${`90300000${suffix}0000${suffix}`},
            ${'certification'}, ${'reel_normal'},
            ${'1 rue du Test'}, ${'75001'}, ${'Paris'}
          )
        `;
      }
    }, 30_000);

    afterAll(async () => {
      await Promise.all([admin?.$disconnect(), worker?.$disconnect()]);
    });

    it(
      'preuve 1 & 2 — scellement puis rejeu du même sceau : une seule ligne, zéro réécriture',
      async () => {
        const coordinates = await seedRun(companyA);
        const proposalId = randomUUID();
        const fields = proposedFields();
        const input = sealInput(coordinates, proposalId, fields);

        await expect(store.sealProposalPayload(input)).resolves.toEqual({ status: 'sealed' });
        const written = await auditPayload(coordinates.runId, proposalId);
        expect(written?.ownerUserId).toBe(coordinates.ownerUserId);
        expect(written?.fieldsDigest).toBe(input.fieldsDigest);
        expect(written?.sensitiveDigest).toBe(input.sensitiveDigest);
        expect(written?.retentionExpiresAt.getTime()).toBeGreaterThan(
          written?.createdAt.getTime() ?? 0,
        );

        const read = await store.readProposalPayload({
          companyId: coordinates.companyId,
          ownerUserId: coordinates.ownerUserId,
          runId: coordinates.runId,
          proposalId,
          fieldsDigest: input.fieldsDigest,
        });
        expect(read?.fields).toEqual(fields);
        expect(read?.sensitiveDigest).toBe(input.sensitiveDigest);

        await expect(store.sealProposalPayload(input)).resolves.toEqual({ status: 'replayed' });
        const replayed = await auditPayload(coordinates.runId, proposalId);
        expect(replayed?.createdAt.getTime()).toBe(written?.createdAt.getTime());
        await expect(countPayloads(coordinates.runId)).resolves.toBe(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 3 — même clé, contenu différent : conflit et charge d’origine intacte',
      async () => {
        const coordinates = await seedRun(companyA);
        const proposalId = randomUUID();
        const original = proposedFields();
        await expect(
          store.sealProposalPayload(sealInput(coordinates, proposalId, original)),
        ).resolves.toEqual({ status: 'sealed' });

        const divergent = proposedFields({ email: 'autre.adresse@example.test' });
        await expect(
          store.sealProposalPayload(sealInput(coordinates, proposalId, divergent)),
        ).resolves.toEqual({ status: 'conflict' });

        const row = await auditPayload(coordinates.runId, proposalId);
        expect(row?.fieldsDigest).toBe(computeCustomerContactFieldsDigest(original));
        const read = await store.readProposalPayload({
          companyId: coordinates.companyId,
          ownerUserId: coordinates.ownerUserId,
          runId: coordinates.runId,
          proposalId,
          fieldsDigest: computeCustomerContactFieldsDigest(original),
        });
        expect(read?.fields).toEqual(original);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 4 & 5 — G4 : digest attendu divergent OU contenu altéré au repos => charge absente',
      async () => {
        const coordinates = await seedRun(companyA);
        const proposalId = randomUUID();
        const fields = proposedFields();
        const input = sealInput(coordinates, proposalId, fields);
        await expect(store.sealProposalPayload(input)).resolves.toEqual({ status: 'sealed' });

        await expect(
          store.readProposalPayload({
            companyId: coordinates.companyId,
            ownerUserId: coordinates.ownerUserId,
            runId: coordinates.runId,
            proposalId,
            fieldsDigest: computeCustomerContactFieldsDigest(proposedFields({ city: 'Lyon' })),
          }),
        ).resolves.toBeNull();

        await tamperPayload(coordinates.runId, proposalId);
        await expect(
          store.readProposalPayload({
            companyId: coordinates.companyId,
            ownerUserId: coordinates.ownerUserId,
            runId: coordinates.runId,
            proposalId,
            fieldsDigest: input.fieldsDigest,
          }),
        ).resolves.toBeNull();
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 6 — RLS : ni un autre propriétaire ni une autre société ne voient la charge',
      async () => {
        const coordinates = await seedRun(companyA);
        const proposalId = randomUUID();
        const fields = proposedFields();
        const input = sealInput(coordinates, proposalId, fields);
        await expect(store.sealProposalPayload(input)).resolves.toEqual({ status: 'sealed' });

        const intruder = `jarvis-payload-owner-${randomUUID()}`;
        await expect(
          store.readProposalPayload({
            companyId: coordinates.companyId,
            ownerUserId: intruder,
            runId: coordinates.runId,
            proposalId,
            fieldsDigest: input.fieldsDigest,
          }),
        ).resolves.toBeNull();

        // SELECT brut sans filtre applicatif : seule la policy peut encore cacher la ligne.
        const otherOwnerRows = await worker.withIsolatedOwner(
          coordinates.companyId,
          intruder,
          (tx) =>
            tx.$queryRaw<Array<{ count: number }>>`
              SELECT count(*)::int AS "count" FROM public.jarvis_proposal_payloads
            `,
          { ...TRANSACTION_OPTIONS, readOnly: true },
        );
        expect(otherOwnerRows[0]?.count).toBe(0);

        const otherCompanyRows = await worker.withIsolatedOwner(
          companyB,
          coordinates.ownerUserId,
          (tx) =>
            tx.$queryRaw<Array<{ count: number }>>`
              SELECT count(*)::int AS "count" FROM public.jarvis_proposal_payloads
            `,
          { ...TRANSACTION_OPTIONS, readOnly: true },
        );
        expect(otherCompanyRows[0]?.count).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 7 — run inconnu : aucune charge orpheline, refus typé',
      async () => {
        const coordinates = await seedRun(companyA);
        const orphanRunId = randomUUID();
        const proposalId = randomUUID();
        const result = await store.sealProposalPayload(
          sealInput({ ...coordinates, runId: orphanRunId }, proposalId, proposedFields()),
        );
        expect(result).toEqual({ status: 'unavailable' });
        await expect(countPayloads(orphanRunId)).resolves.toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 8 — rétention : échue => illisible puis purgée ; vivante => la base refuse la purge',
      async () => {
        const coordinates = await seedRun(companyA);
        const expiring = randomUUID();
        const alive = randomUUID();
        const fields = proposedFields();
        const expiringInput = sealInput(coordinates, expiring, fields);
        // Charge VIVANTE : échéance dans 10 minutes — la purge la DEMANDERA (borne future),
        // la policy la refusera.
        const aliveInput = sealInput(coordinates, alive, fields, 10 * 60_000);
        await expect(store.sealProposalPayload(expiringInput)).resolves.toEqual({
          status: 'sealed',
        });
        await expect(store.sealProposalPayload(aliveInput)).resolves.toEqual({ status: 'sealed' });

        await ageRetention(coordinates.runId, expiring);
        // Une charge échue cesse d'être lisible AVANT même que la purge passe.
        await expect(
          store.readProposalPayload({
            companyId: coordinates.companyId,
            ownerUserId: coordinates.ownerUserId,
            runId: coordinates.runId,
            proposalId: expiring,
            fieldsDigest: expiringInput.fieldsDigest,
          }),
        ).resolves.toBeNull();

        const purged = await store.purgeExpired({
          companyId: coordinates.companyId,
          ownerUserId: coordinates.ownerUserId,
          before: new Date(Date.now() + 60 * 60_000).toISOString(),
          limit: 100,
        });
        expect(purged).toBe(1);
        await expect(auditPayload(coordinates.runId, expiring)).resolves.toBeNull();
        // La charge vivante est TOUJOURS là : la policy DELETE ne concède rien avant l'échéance.
        const survivor = await auditPayload(coordinates.runId, alive);
        expect(survivor).not.toBeNull();
        const read = await store.readProposalPayload({
          companyId: coordinates.companyId,
          ownerUserId: coordinates.ownerUserId,
          runId: coordinates.runId,
          proposalId: alive,
          fieldsDigest: aliveInput.fieldsDigest,
        });
        expect(read?.fields).toEqual(fields);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'preuve 9 — immuabilité : le rôle applicatif ne peut pas réécrire une charge scellée',
      async () => {
        const coordinates = await seedRun(companyA);
        const proposalId = randomUUID();
        const input = sealInput(coordinates, proposalId, proposedFields());
        await expect(store.sealProposalPayload(input)).resolves.toEqual({ status: 'sealed' });

        await expect(
          worker.withIsolatedOwner(
            coordinates.companyId,
            coordinates.ownerUserId,
            (tx) =>
              tx.$executeRaw`
                UPDATE public.jarvis_proposal_payloads
                   SET "payload" = '{"displayName":"Autre"}'::jsonb
                 WHERE "runId" = ${coordinates.runId}::uuid
                   AND "proposalId" = ${proposalId}::uuid
              `,
            { ...TRANSACTION_OPTIONS, readOnly: false },
          ),
          // La règle NOMMÉE : aucune policy UPDATE n'existe sur jarvis_proposal_payloads
          // (payload scellé IMMUABLE) — RLS refuse l'écriture (42501 / row-level security).
        ).rejects.toThrow(/42501|row-level security|new row violates|permission denied/i);

        const row = await auditPayload(coordinates.runId, proposalId);
        expect(row?.fieldsDigest).toBe(input.fieldsDigest);
      },
      TEST_TIMEOUT_MS,
    );

    /**
     * Jarvis U1-e §4 — ANNUAIRE D'AUTORITÉ DES PROPRIÉTAIRES À PURGER.
     *
     * Sans lui, `JarvisProposalPayloadPurgeService` s'arrêtait sur `owner_directory_absent` : la
     * question « qui, dans ce tenant, a du PII échu ? » n'avait AUCUNE réponse possible, puisque
     * toutes les policies de la table sont owner-scopées et qu'elle est en FORCE RLS (preuve 6
     * ci-dessus). Les quatre preuves qui suivent tiennent la promesse SANS élargir quoi que ce
     * soit :
     *
     *  (D1) l'annuaire ne rend QUE des `ownerUserId`, dédoublonnés, bornés, et UNIQUEMENT ceux
     *       dont une charge est DÉJÀ ÉCHUE — un propriétaire dont tout le PII est vivant reste
     *       invisible, et un autre tenant n'apparaît jamais ;
     *  (D2) l'autorité ne peut PAS lire le contenu : `payload` est hors de son GRANT par colonne,
     *       et le rôle applicatif ne peut jamais devenir cette autorité ;
     *  (D3) un rôle non autorisé ne peut pas appeler l'annuaire — refus NOMMÉ, pas une page vide ;
     *  (D4) bout en bout : annuaire → purge → le PII échu a DISPARU, le vivant et celui d'un autre
     *       propriétaire sont INTACTS, et l'annuaire ne rend plus le propriétaire purgé.
     */
    describe.skipIf(!DIRECTORY_CERT)(
      'Jarvis U1-e — annuaire d’autorité des propriétaires à purger (§4)',
      () => {
        interface AuthorityAclRow {
          readonly securityDefiner: boolean;
          readonly owner: string;
          readonly payloadReadable: boolean;
          readonly ownerColumnReadable: boolean;
          readonly companyColumnReadable: boolean;
          readonly retentionColumnReadable: boolean;
          readonly appCanBecomeAuthority: boolean;
        }

        async function authorityAcl(): Promise<AuthorityAclRow | undefined> {
          const rows = await admin.$queryRaw<AuthorityAclRow[]>`
            SELECT function.prosecdef AS "securityDefiner",
                   owner.rolname AS "owner",
                   pg_catalog.has_column_privilege(
                     ${RETENTION_DIRECTORY_ROLE},
                     'public.jarvis_proposal_payloads', 'payload', 'SELECT'
                   ) AS "payloadReadable",
                   pg_catalog.has_column_privilege(
                     ${RETENTION_DIRECTORY_ROLE},
                     'public.jarvis_proposal_payloads', 'ownerUserId', 'SELECT'
                   ) AS "ownerColumnReadable",
                   pg_catalog.has_column_privilege(
                     ${RETENTION_DIRECTORY_ROLE},
                     'public.jarvis_proposal_payloads', 'companyId', 'SELECT'
                   ) AS "companyColumnReadable",
                   pg_catalog.has_column_privilege(
                     ${RETENTION_DIRECTORY_ROLE},
                     'public.jarvis_proposal_payloads', 'retentionExpiresAt', 'SELECT'
                   ) AS "retentionColumnReadable",
                   pg_catalog.pg_has_role(
                     ${process.env.APP_DATABASE_ROLE ?? 'bob_app'},
                     ${RETENTION_DIRECTORY_ROLE}, 'SET'
                   ) AS "appCanBecomeAuthority"
              FROM pg_catalog.pg_proc AS function
              JOIN pg_catalog.pg_roles AS owner ON owner.oid = function.proowner
             WHERE function.oid =
               'public.list_jarvis_payload_retention_owners_v1(text,integer)'::pg_catalog.regprocedure
          `;
          return rows[0];
        }

        beforeAll(async () => {
          const acl = await authorityAcl();
          if (acl === undefined || !acl.securityDefiner || acl.owner !== RETENTION_DIRECTORY_ROLE) {
            throw new Error(
              'JARVIS_PAYLOAD_RETENTION_DIRECTORY_CERT=true exige la migration 20260819210000 ET ' +
                'provision_jarvis_payload_retention_directory (release.sh) sur cette base.',
            );
          }
        }, 30_000);

        it(
          'preuve D1 & D2 — coordonnées ÉCHUES seulement, contenu inatteignable, autorité inaccessible',
          async () => {
            const acl = await authorityAcl();
            // GRANT PAR COLONNE : trois coordonnées, jamais la charge.
            expect(acl?.payloadReadable).toBe(false);
            expect(acl?.ownerColumnReadable).toBe(true);
            expect(acl?.companyColumnReadable).toBe(true);
            expect(acl?.retentionColumnReadable).toBe(true);
            // Le rôle applicatif exécute la fonction ; il ne DEVIENT jamais son definer.
            expect(acl?.appCanBecomeAuthority).toBe(false);

            const expiring = await seedRun(companyA);
            const alive = await seedRun(companyA);
            const neighbour = await seedRun(companyB);
            const expiringProposal = randomUUID();
            const secondExpiringProposal = randomUUID();
            const fields = proposedFields();
            for (const proposalId of [expiringProposal, secondExpiringProposal]) {
              await expect(
                store.sealProposalPayload(sealInput(expiring, proposalId, fields)),
              ).resolves.toEqual({ status: 'sealed' });
              await ageRetention(expiring.runId, proposalId);
            }
            await expect(
              store.sealProposalPayload(sealInput(alive, randomUUID(), fields)),
            ).resolves.toEqual({ status: 'sealed' });
            const neighbourProposal = randomUUID();
            await expect(
              store.sealProposalPayload(sealInput(neighbour, neighbourProposal, fields)),
            ).resolves.toEqual({ status: 'sealed' });
            await ageRetention(neighbour.runId, neighbourProposal);

            const owners = await store.listRetentionOwners(
              companyA,
              JARVIS_PROPOSAL_PAYLOAD_PURGE_MAX_OWNERS_PER_TENANT,
            );

            // DEUX charges échues du même propriétaire ⇒ UNE seule entrée.
            expect(owners.filter((owner) => owner === expiring.ownerUserId)).toEqual([
              expiring.ownerUserId,
            ]);
            // Un propriétaire dont tout le PII est VIVANT n'est pas énumérable par l'autorité.
            expect(owners).not.toContain(alive.ownerUserId);
            // Ni le voisin : la question est posée tenant par tenant.
            expect(owners).not.toContain(neighbour.ownerUserId);
            expect(new Set(owners).size).toBe(owners.length);
            expect(owners.length).toBeLessThanOrEqual(
              JARVIS_PROPOSAL_PAYLOAD_PURGE_MAX_OWNERS_PER_TENANT,
            );
            // La projection ne porte QUE des identifiants de propriétaire : aucune chaîne rendue
            // n'est un fragment de la charge scellée (nom, e-mail, adresse de la fixture).
            for (const owner of owners) {
              expect(owner.startsWith('jarvis-payload-owner-')).toBe(true);
            }

            await expect(
              store.listRetentionOwners(
                companyB,
                JARVIS_PROPOSAL_PAYLOAD_PURGE_MAX_OWNERS_PER_TENANT,
              ),
            ).resolves.toContain(neighbour.ownerUserId);
          },
          TEST_TIMEOUT_MS,
        );

        it(
          'preuve D3 — un rôle non autorisé ne peut pas appeler l’annuaire, et les bornes sont dures',
          async () => {
            // L'auditeur de certification est BYPASSRLS : s'il pouvait exécuter la fonction, il
            // énumérerait tout. La règle NOMMÉE est l'ACL EXECUTE (aucun grantee hors du rôle
            // applicatif) — refus PostgreSQL 42501 « permission denied for function ».
            await expect(
              admin.$queryRaw`
                SELECT * FROM public.list_jarvis_payload_retention_owners_v1(${companyA}, 50)
              `,
            ).rejects.toThrow(/permission denied for function|42501/iu);

            // Bornes refusées AVANT toute lecture, côté adapter : un appelant qui demande plus que
            // le plafond du balayage est un défaut d'appelant, jamais une page rognée en silence.
            await expect(
              store.listRetentionOwners(
                companyA,
                JARVIS_PROPOSAL_PAYLOAD_PURGE_MAX_OWNERS_PER_TENANT + 1,
              ),
            ).rejects.toThrow(/Borne de l'annuaire de rétention des payloads Jarvis invalide/u);
            await expect(store.listRetentionOwners(` ${companyA}`, 10)).rejects.toThrow(
              /Identifiant de société de payload Jarvis invalide/u,
            );
          },
          TEST_TIMEOUT_MS,
        );

        it(
          'preuve D4 — bout en bout : le PII échu disparaît, le vivant et le voisin restent',
          async () => {
            const doomed = await seedRun(companyA);
            const survivor = await seedRun(companyA);
            const doomedProposal = randomUUID();
            const survivorProposal = randomUUID();
            const fields = proposedFields();
            await expect(
              store.sealProposalPayload(sealInput(doomed, doomedProposal, fields)),
            ).resolves.toEqual({ status: 'sealed' });
            await expect(
              store.sealProposalPayload(sealInput(survivor, survivorProposal, fields)),
            ).resolves.toEqual({ status: 'sealed' });
            await ageRetention(doomed.runId, doomedProposal);

            const owners = await store.listRetentionOwners(
              companyA,
              JARVIS_PROPOSAL_PAYLOAD_PURGE_MAX_OWNERS_PER_TENANT,
            );
            expect(owners).toContain(doomed.ownerUserId);
            expect(owners).not.toContain(survivor.ownerUserId);

            // Le balayage réel : owner-scopé, borné, sur les seules coordonnées rendues.
            const purged = await store.purgeExpired({
              companyId: companyA,
              ownerUserId: doomed.ownerUserId,
              before: new Date().toISOString(),
              limit: JARVIS_PROPOSAL_PAYLOAD_PURGE_LIMIT_PER_OWNER,
            });
            expect(purged).toBe(1);

            // Relecture de la BASE par l'auditeur : la ligne échue n'existe plus, la vivante oui.
            await expect(auditPayload(doomed.runId, doomedProposal)).resolves.toBeNull();
            await expect(auditPayload(survivor.runId, survivorProposal)).resolves.not.toBeNull();
            await expect(
              store.listRetentionOwners(
                companyA,
                JARVIS_PROPOSAL_PAYLOAD_PURGE_MAX_OWNERS_PER_TENANT,
              ),
            ).resolves.not.toContain(doomed.ownerUserId);
          },
          TEST_TIMEOUT_MS,
        );
      },
    );
  },
);

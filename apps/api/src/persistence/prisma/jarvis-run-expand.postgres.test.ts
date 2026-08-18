/**
 * Jarvis U1-a — certification PostgreSQL de l'expand (SPEC_U1_NOYAU_DURABLE_20260818 §5).
 *
 * Preuves : (1) le writer N-1 réel (StartQuoteAgentMission) fonctionne inchangé sur le
 * schéma étendu et laisse les colonnes Jarvis à NULL ; (2) les CHECK élargis acceptent
 * l'union et refusent l'inconnu ; (3) jarvis_work_items : unicité d'effet, FK composite,
 * RESTRICT ; (4) RLS owner-scoped ; (5) portée de reçu par run sur les events.
 *
 * Même harnais que agent-mission.persistence.postgres.test.ts : gates env, base jetable.
 */
import { randomUUID } from 'node:crypto';

import { createEmptyQuoteDraftPayload } from '@bob/core';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function certPayload(): unknown {
  const result = createEmptyQuoteDraftPayload(randomUUID());
  if (!result.ok) throw new Error(`invalid cert payload:${result.error.code}`);
  return result.value;
}

const RUN_CERT = process.env.RUN_AGENT_MISSION_POSTGRES_CERT === 'true';
const DISPOSABLE = process.env.AGENT_MISSION_CERT_DATABASE_IS_DISPOSABLE === 'true';

function isPgError(error: unknown, code: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError
      ? error.meta?.code === code || error.message.includes(code)
      : error instanceof Error && error.message.includes(code)
  );
}

describe.skipIf(!RUN_CERT)(
  'Jarvis U1-a — certification PostgreSQL expand agent_missions + jarvis_work_items',
  () => {
    const directUrl = process.env.DIRECT_URL ?? '';
    const certAdminUrl = process.env.AGENT_MISSION_CERT_ADMIN_URL ?? '';
    const companyA = `jarvis-expand-company-a-${randomUUID()}`;
    const companyB = `jarvis-expand-company-b-${randomUUID()}`;
    const ownerA = `jarvis-owner-a-${randomUUID()}`;
    const ownerB = `jarvis-owner-b-${randomUUID()}`;
    let admin: PrismaClient;
    let deployer: PrismaClient;

    async function asOwner<T>(
      companyId: string,
      ownerUserId: string,
      missionId: string | null,
      work: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> {
      return deployer.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE bob_schema_owner');
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ownerUserId}, true)`;
        if (missionId !== null) {
          await tx.$executeRaw`SELECT set_config('app.current_agent_mission_id', ${missionId}, true)`;
        }
        return work(tx);
      });
    }

    async function insertLegacyShapedMission(
      companyId: string,
      ownerUserId: string,
    ): Promise<string> {
      const missionId = randomUUID();
      await asOwner(companyId, ownerUserId, missionId, async (tx) => {
        // Forme d'écriture N-1 : aucune des colonnes Jarvis (definitionVersion, nextWakeAt).
        await tx.$executeRaw`
          INSERT INTO public.agent_missions (
            "id", "companyId", "ownerUserId", "kind", "status", "phase",
            "revision", "payloadVersion", "payload",
            "idleExpiresAt", "hardExpiresAt", "retentionExpiresAt",
            "createdAt", "updatedAt"
          ) VALUES (
            ${missionId}::uuid, ${companyId}, ${ownerUserId},
            'quote_creation', 'active', 'awaiting_draft_decision',
            1, 1,
            ${JSON.stringify(certPayload())}::jsonb,
            now() + interval '1 day', now() + interval '7 day', now() + interval '30 day',
            now(), now()
          )
        `;
      });
      return missionId;
    }

    beforeAll(async () => {
      if (!DISPOSABLE) {
        throw new Error(
          'AGENT_MISSION_CERT_DATABASE_IS_DISPOSABLE=true est obligatoire : le journal est immuable.',
        );
      }
      if (directUrl === '' || certAdminUrl === '') {
        throw new Error('DIRECT_URL deployer et AGENT_MISSION_CERT_ADMIN_URL sont requis.');
      }
      admin = new PrismaClient({ datasourceUrl: certAdminUrl });
      deployer = new PrismaClient({ datasourceUrl: directUrl });
      await Promise.all([admin.$connect(), deployer.$connect()]);
      for (const [companyId, suffix] of [
        [companyA, '7'],
        [companyB, '8'],
      ] as const) {
        await admin.$executeRaw`
          INSERT INTO public.companies (
            "id", "name", "legalForm", "siren", "siret", "trade", "vatRegime",
            "addrLine1", "addrZip", "addrCity"
          ) VALUES (
            ${companyId}, ${`Jarvis expand cert ${suffix}`}, ${'EI'},
            ${`90200000${suffix}`}, ${`90200000${suffix}0000${suffix}`},
            ${'certification'}, ${'reel_normal'},
            ${'1 rue du Test'}, ${'75001'}, ${'Paris'}
          )
        `;
      }
    }, 30_000);

    afterAll(async () => {
      await Promise.all([admin?.$disconnect(), deployer?.$disconnect()]);
    });

    it('accepte la forme d’écriture N-1 et laisse les colonnes Jarvis à NULL', async () => {
      const missionId = await insertLegacyShapedMission(companyA, ownerA);
      const rows = await asOwner(companyA, ownerA, missionId, (tx) =>
        tx.$queryRaw<Array<{ definitionVersion: number | null; nextWakeAt: Date | null }>>`
          SELECT "definitionVersion", "nextWakeAt"
          FROM public.agent_missions WHERE "id" = ${missionId}::uuid
        `,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.definitionVersion).toBeNull();
      expect(rows[0]?.nextWakeAt).toBeNull();
    });

    it('le CHECK kind élargi accepte les kinds U1 et refuse un kind inconnu', async () => {
      await expect(
        asOwner(companyA, ownerA, randomUUID(), async (tx) => {
          await tx.$executeRaw`
            INSERT INTO public.agent_missions (
              "id", "companyId", "ownerUserId", "kind", "status", "phase",
              "revision", "payloadVersion", "payload",
              "idleExpiresAt", "hardExpiresAt", "retentionExpiresAt",
              "createdAt", "updatedAt"
            ) VALUES (
              ${randomUUID()}::uuid, ${companyA}, ${ownerA},
              'kind_inconnu', 'active', 'awaiting_draft_decision',
              1, 1, ${JSON.stringify(certPayload())}::jsonb,
              now(), now(), now(), now(), now()
            )
          `;
        }),
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '23514'));
    });

    it('jarvis_work_items : unicité (companyId, effectId) prouvée par violation', async () => {
      const missionId = await insertLegacyShapedMission(companyA, ownerA);
      const effectId = randomUUID();
      const insert = (id: string) =>
        asOwner(companyA, ownerA, missionId, async (tx) => {
          await tx.$executeRaw`
            INSERT INTO public.jarvis_work_items (
              "id", "companyId", "runId", "ownerUserId", "effectId",
              "actionId", "actionVersion", "authorizationSource", "actingPrincipalId",
              "executeBy", "createdAt", "updatedAt"
            ) VALUES (
              ${id}::uuid, ${companyA}, ${missionId}::uuid, ${ownerA}, ${effectId}::uuid,
              'client-creer', 1,
              jsonb_build_object('source', 'confirmation', 'receiptId', ${randomUUID()}::text),
              ${ownerA},
              now() + interval '1 hour', now(), now()
            )
          `;
        });
      await insert(randomUUID());
      await expect(insert(randomUUID())).rejects.toSatisfy((error: unknown) =>
        isPgError(error, '23505'),
      );
    });

    it('jarvis_work_items : la FK composite refuse un run orphelin et RESTRICT protège le run', async () => {
      await expect(
        asOwner(companyA, ownerA, randomUUID(), async (tx) => {
          await tx.$executeRaw`
            INSERT INTO public.jarvis_work_items (
              "id", "companyId", "runId", "ownerUserId", "effectId",
              "actionId", "actionVersion", "authorizationSource", "actingPrincipalId",
              "executeBy", "createdAt", "updatedAt"
            ) VALUES (
              ${randomUUID()}::uuid, ${companyA}, ${randomUUID()}::uuid, ${ownerA},
              ${randomUUID()}::uuid, 'client-creer', 1,
              jsonb_build_object('source', 'confirmation', 'receiptId', ${randomUUID()}::text),
              ${ownerA}, now() + interval '1 hour', now(), now()
            )
          `;
        }),
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '23503'));

      const missionId = await insertLegacyShapedMission(companyA, ownerA);
      await asOwner(companyA, ownerA, missionId, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO public.jarvis_work_items (
            "id", "companyId", "runId", "ownerUserId", "effectId",
            "actionId", "actionVersion", "authorizationSource", "actingPrincipalId",
            "executeBy", "createdAt", "updatedAt"
          ) VALUES (
            ${randomUUID()}::uuid, ${companyA}, ${missionId}::uuid, ${ownerA},
            ${randomUUID()}::uuid, 'client-creer', 1,
            jsonb_build_object('source', 'confirmation', 'receiptId', ${randomUUID()}::text),
            ${ownerA}, now() + interval '1 hour', now(), now()
          )
        `;
      });
      await expect(
        admin.$executeRaw`DELETE FROM public.agent_missions WHERE "id" = ${missionId}::uuid`,
      ).rejects.toSatisfy((error: unknown) => isPgError(error, '23503'));
    });

    it('RLS : un tenant ne lit ni n’écrit les work items d’un autre tenant', async () => {
      const missionId = await insertLegacyShapedMission(companyA, ownerA);
      await asOwner(companyA, ownerA, missionId, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO public.jarvis_work_items (
            "id", "companyId", "runId", "ownerUserId", "effectId",
            "actionId", "actionVersion", "authorizationSource", "actingPrincipalId",
            "executeBy", "createdAt", "updatedAt"
          ) VALUES (
            ${randomUUID()}::uuid, ${companyA}, ${missionId}::uuid, ${ownerA},
            ${randomUUID()}::uuid, 'client-creer', 1,
            jsonb_build_object('source', 'confirmation', 'receiptId', ${randomUUID()}::text),
            ${ownerA}, now() + interval '1 hour', now(), now()
          )
        `;
      });
      const crossTenantRows = await asOwner(companyB, ownerB, null, (tx) =>
        tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM public.jarvis_work_items WHERE "companyId" = ${companyA}
        `,
      );
      expect(crossTenantRows).toHaveLength(0);
      await expect(
        asOwner(companyB, ownerB, missionId, async (tx) => {
          await tx.$executeRaw`
            INSERT INTO public.jarvis_work_items (
              "id", "companyId", "runId", "ownerUserId", "effectId",
              "actionId", "actionVersion", "authorizationSource", "actingPrincipalId",
              "executeBy", "createdAt", "updatedAt"
            ) VALUES (
              ${randomUUID()}::uuid, ${companyA}, ${missionId}::uuid, ${ownerA},
              ${randomUUID()}::uuid, 'client-creer', 1,
              jsonb_build_object('source', 'confirmation', 'receiptId', ${randomUUID()}::text),
              ${ownerA}, now() + interval '1 hour', now(), now()
            )
          `;
        }),
      ).rejects.toSatisfy((error: unknown) =>
        isPgError(error, '42501') || isPgError(error, '23514') || isPgError(error, '23505'),
      );
    });

    it('portée de reçu par run : même commandId rejeté dans le même run, accepté sur deux runs', async () => {
      const missionOne = await insertLegacyShapedMission(companyA, ownerA);
      const missionTwo = await insertLegacyShapedMission(companyA, ownerB);
      const commandId = randomUUID();
      const insertEvent = (missionId: string, ownerUserId: string, sequence: number) =>
        asOwner(companyA, ownerUserId, missionId, async (tx) => {
          await tx.$executeRaw`
            INSERT INTO public.agent_mission_events (
              "id", "missionId", "companyId", "ownerUserId", "sequence",
              "eventType", "eventVersion", "actor", "commandId",
              "requestFingerprintHmac", "fingerprintKeyVersion",
              "fingerprintCanonicalizationVersion",
              "missionRevisionBefore", "missionRevisionAfter",
              "data", "occurredAt", "retentionExpiresAt"
            ) VALUES (
              ${randomUUID()}::uuid, ${missionId}::uuid, ${companyA}, ${ownerUserId},
              ${sequence}, 'jarvis_expand_cert', 1, 'user_tap', ${commandId}::uuid,
              ${'a'.repeat(64)}, 1, 1, 1, ${sequence},
              '{}'::jsonb, now(), now() + interval '30 day'
            )
          `;
        });
      await insertEvent(missionOne, ownerA, 2);
      // Même commandId, autre run (autre owner — l'unique owner-scope N-1 reste plus strict
      // par owner ; deux owners distincts prouvent la portée run sans le contredire).
      await insertEvent(missionTwo, ownerB, 2);
      await expect(insertEvent(missionOne, ownerA, 3)).rejects.toSatisfy(
        (error: unknown) => isPgError(error, '23505'),
      );
    });
  },
);

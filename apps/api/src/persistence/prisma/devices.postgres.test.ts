import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPersistence } from './prisma-persistence';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_DEVICE_REBIND_CERT === 'true';

describe.skipIf(!RUN_POSTGRES_CERT)('Push device rebind — certification PostgreSQL/FORCE RLS', () => {
  const companyA = `device-cert-a-${randomUUID()}`;
  const companyB = `device-cert-b-${randomUUID()}`;
  const token = `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`;
  const runtimeUrl = process.env.DATABASE_URL ?? '';
  const directUrl = process.env.DIRECT_URL ?? '';
  let admin: PrismaClient;
  let workers: PrismaService[] = [];
  let stores: PrismaPersistence[] = [];

  beforeAll(async () => {
    if (!runtimeUrl || !directUrl) {
      throw new Error('DATABASE_URL (rôle runtime) et DIRECT_URL (admin) sont requis.');
    }
    admin = new PrismaClient({ datasourceUrl: directUrl });
    workers = [
      new PrismaService({ datasourceUrl: runtimeUrl }),
      new PrismaService({ datasourceUrl: runtimeUrl }),
    ];
    stores = workers.map((worker) => new PrismaPersistence(worker));
    await Promise.all([admin.$connect(), ...workers.map((worker) => worker.$connect())]);
    await admin.company.createMany({
      data: [companyA, companyB].map((id, index) => ({
        id,
        name: `Bob Device Certification ${index + 1}`,
        legalForm: 'EI' as const,
        siren: index === 0 ? '552100554' : '732829320',
        siret: index === 0 ? '55210055400013' : '73282932000074',
        trade: 'autre' as const,
        vatRegime: 'reel_normal' as const,
        addrLine1: '1 rue de la Certification',
        addrZip: '75001',
        addrCity: 'Paris',
      })),
    });
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.device.deleteMany({ where: { expoPushToken: token } }).catch(() => undefined);
      await admin.company.deleteMany({ where: { id: { in: [companyA, companyB] } } }).catch(() => undefined);
    }
    await Promise.allSettled([
      ...workers.map((worker) => worker.$disconnect()),
      ...(admin ? [admin.$disconnect()] : []),
    ]);
  });

  function register(index: number, companyId: string, userId: string, suffix: string) {
    const store = stores[index]!;
    return store.runWithTenant(companyId, () => store.devices.register({
      id: `device-${suffix}-${randomUUID()}`,
      companyId,
      userId,
      expoPushToken: token,
      platform: index === 0 ? 'ios' : 'android',
      now: `2026-07-16T10:00:0${index}.000Z`,
    }));
  }

  it('fait converger deux rebinds concurrents vers une seule ligne globale', async () => {
    const results = await Promise.all([
      register(0, companyA, 'user-a', 'a'),
      register(1, companyB, 'user-b', 'b'),
    ]);
    expect(results).toHaveLength(2);

    const rows = await admin.device.findMany({ where: { expoPushToken: token } });
    expect(rows).toHaveLength(1);
    expect([companyA, companyB]).toContain(rows[0]?.companyId);

    // Un dernier bind déterministe prouve le transfert complet, puis l'absence cross-tenant.
    const rebound = await register(1, companyB, 'user-b-final', 'final');
    expect(rebound).toMatchObject({ companyId: companyB, userId: 'user-b-final', expoPushToken: token });
    await expect(stores[0]!.runWithTenant(companyA, () => stores[0]!.devices.listByCompany(companyA)))
      .resolves.toEqual([]);
    await expect(stores[1]!.runWithTenant(companyB, () => stores[1]!.devices.listByCompany(companyB)))
      .resolves.toMatchObject([{ companyId: companyB, userId: 'user-b-final', expoPushToken: token }]);
  }, 30_000);

  it('borne la révocation au tenant propriétaire et efface la capacité GUC après rebind', async () => {
    await register(1, companyB, 'user-b-final', 'revoke');

    await stores[0]!.runWithTenant(companyA, () => stores[0]!.devices.removeByToken(companyA, token));
    expect(await admin.device.count({ where: { expoPushToken: token, companyId: companyB } })).toBe(1);

    const currentCapability = await stores[1]!.runWithTenant(companyB, async () => {
      await stores[1]!.devices.register({
        id: `device-guc-${randomUUID()}`,
        companyId: companyB,
        userId: 'user-b-final',
        expoPushToken: token,
        platform: 'ios',
        now: '2026-07-16T10:01:00.000Z',
      });
      const rows = await workers[1]!.client().$queryRaw<Array<{ value: string }>>`
        SELECT current_setting('app.current_device_push_token', true) AS value
      `;
      return rows[0]?.value;
    });
    expect(currentCapability).toBe('');

    await stores[1]!.runWithTenant(companyB, () => stores[1]!.devices.removeByToken(companyB, token));
    expect(await admin.device.count({ where: { expoPushToken: token } })).toBe(0);
  });

  it('certifie unicité globale, FORCE RLS et politiques de rebind bornées', async () => {
    const [role] = await workers[0]!.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

    const [shape] = await admin.$queryRaw<Array<{
      rowSecurity: boolean;
      forceRowSecurity: boolean;
      globalUnique: boolean;
      legacyUnique: boolean;
    }>>`
      SELECT
        table_class.relrowsecurity AS "rowSecurity",
        table_class.relforcerowsecurity AS "forceRowSecurity",
        to_regclass('public.devices_expo_push_token_key') IS NOT NULL AS "globalUnique",
        to_regclass('public."devices_companyId_expoPushToken_key"') IS NOT NULL AS "legacyUnique"
      FROM pg_class AS table_class
      WHERE table_class.oid = 'devices'::regclass
    `;
    expect(shape).toEqual({
      rowSecurity: true,
      forceRowSecurity: true,
      globalUnique: true,
      legacyUnique: true,
    });

    const policies = await admin.$queryRaw<Array<{ policyname: string }>>`
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'devices'
      ORDER BY policyname
    `;
    expect(policies.map((policy) => policy.policyname)).toEqual([
      'device_tenant_delete',
      'device_tenant_insert',
      'device_tenant_select',
      'device_tenant_update',
      'device_token_rebind_select',
      'device_token_rebind_update',
    ]);
  });
});

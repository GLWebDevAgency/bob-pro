import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RegisterDeviceInput, RevokeDeviceThroughInput } from '../devices';
import { PrismaPersistence } from './prisma-persistence';
import { PrismaService } from './prisma.service';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_DEVICE_REBIND_CERT === 'true';
const ACTIVE_SINCE = '1970-01-01T00:00:00.000Z';

interface BindingFixture {
  companyId: string;
  userId: string;
  token: string;
  installationId: string;
  bindingId: string;
  generation: number;
  secretHash: string;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe.skipIf(!RUN_POSTGRES_CERT)('Push binding v2 — certification PostgreSQL/FORCE RLS', () => {
  const companyA = `device-cert-a-${randomUUID()}`;
  const companyB = `device-cert-b-${randomUUID()}`;
  const companyNumbers = [randomUUID(), randomUUID()].map((id) => {
    const decimal = BigInt(`0x${id.replaceAll('-', '')}`).toString().padStart(40, '0');
    const siren = `9${decimal.slice(-8)}`;
    return { siren, siret: `${siren}${decimal.slice(-13, -8)}` };
  });
  const runtimeUrl = process.env.DATABASE_URL ?? '';
  const directUrl = process.env.DIRECT_URL ?? '';
  let admin: PrismaClient;
  let workers: PrismaService[] = [];
  let stores: PrismaPersistence[] = [];
  const installationIds = new Set<string>();

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
        siren: companyNumbers[index]!.siren,
        siret: companyNumbers[index]!.siret,
        trade: 'autre' as const,
        vatRegime: 'reel_normal' as const,
        addrLine1: '1 rue de la Certification',
        addrZip: '75001',
        addrCity: 'Paris',
      })),
    });
  }, 30_000);

  afterEach(async () => {
    if (!admin) return;
    await admin.device.deleteMany({ where: { companyId: { in: [companyA, companyB] } } });
    await admin.pushInstallation.deleteMany({ where: { id: { in: [...installationIds] } } });
    await admin.company.updateMany({
      where: { id: { in: [companyA, companyB] } },
      data: { closedAt: null },
    });
    installationIds.clear();
  });

  afterAll(async () => {
    if (admin) {
      await admin.device.deleteMany({ where: { companyId: { in: [companyA, companyB] } } }).catch(() => undefined);
      await admin.pushInstallation.deleteMany({ where: { id: { in: [...installationIds] } } }).catch(() => undefined);
      await admin.company.deleteMany({ where: { id: { in: [companyA, companyB] } } }).catch(() => undefined);
    }
    await Promise.allSettled([
      ...workers.map((worker) => worker.$disconnect()),
      ...(admin ? [admin.$disconnect()] : []),
    ]);
  });

  function fixture(companyId: string, userId: string, token: string, generation = 1): BindingFixture {
    const installationId = randomUUID();
    installationIds.add(installationId);
    return {
      companyId,
      userId,
      token,
      installationId,
      bindingId: randomUUID(),
      generation,
      secretHash: randomUUID().replaceAll('-', '').padEnd(64, 'a'),
    };
  }

  function registration(value: BindingFixture, now = '2026-07-16T10:00:00.000Z'): RegisterDeviceInput {
    return {
      id: `device-${randomUUID()}`,
      companyId: value.companyId,
      userId: value.userId,
      expoPushToken: value.token,
      platform: 'ios',
      installationId: value.installationId,
      bindingId: value.bindingId,
      bindingGeneration: value.generation,
      revocationSecretHash: value.secretHash,
      now,
    };
  }

  function revoke(value: BindingFixture, kind: 'authenticated' | 'public'): RevokeDeviceThroughInput {
    return {
      installationId: value.installationId,
      throughGeneration: value.generation,
      revocationSecretHash: value.secretHash,
      scope: kind === 'public'
        ? { kind: 'public' }
        : { kind: 'authenticated', companyId: value.companyId, userId: value.userId },
    };
  }

  async function bind(worker: number, value: BindingFixture, now?: string) {
    return stores[worker]!.runWithTenant(value.companyId, () =>
      stores[worker]!.devices.register(registration(value, now)),
    );
  }

  async function targets(worker: number, companyId: string) {
    return stores[worker]!.runWithTenant(companyId, () =>
      stores[worker]!.devices.listDeliveryTargetsByCompany(companyId, ACTIVE_SINCE),
    );
  }

  async function waitForAdvisoryWaiter(backendPid: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [row] = await admin.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::integer AS waiting
        FROM pg_stat_activity
        WHERE pid = ${backendPid}
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
      `;
      if ((row?.waiting ?? 0) > 0) return;
      await delay(10);
    }
    throw new Error('Aucun waiter advisory observé : la barrière de concurrence n’est pas certifiée.');
  }

  async function withDeviceContext<T>(
    worker: number,
    companyId: string,
    context: {
      operation: string;
      installationId?: string;
      bindingId?: string;
      generation?: number;
      secretHash?: string;
      token?: string;
      userId?: string;
    },
    task: () => Promise<T>,
  ): Promise<T> {
    return stores[worker]!.runInTransaction(() => stores[worker]!.runWithTenant(companyId, async () => {
      await workers[worker]!.client().$executeRaw`
        SELECT
          set_config('app.current_device_operation', ${context.operation}, true),
          set_config('app.current_device_installation_id', ${context.installationId ?? ''}, true),
          set_config('app.current_device_binding_id', ${context.bindingId ?? ''}, true),
          set_config('app.current_device_binding_generation', ${context.generation === undefined ? '' : String(context.generation)}, true),
          set_config('app.current_device_revocation_hash', ${context.secretHash ?? ''}, true),
          set_config('app.current_device_push_token', ${context.token ?? ''}, true),
          set_config('app.current_device_user_id', ${context.userId ?? ''}, true)
      `;
      return task();
    }));
  }

  it('transfert concurrent global : un seul owner, ancienne installation neutralisée, retry refusé', async () => {
    const token = `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`;
    const a = fixture(companyA, 'user-a', token);
    const b = fixture(companyB, 'user-b', token);

    await Promise.all([bind(0, a), bind(1, b)]);
    const row = await admin.device.findUniqueOrThrow({ where: { expoPushToken: token } });
    const winner = row.installationId === a.installationId ? a : b;
    const loser = winner === a ? b : a;
    expect(row.companyId).toBe(winner.companyId);
    await expect(admin.pushInstallation.findUnique({ where: { id: loser.installationId } }))
      .resolves.toMatchObject({ currentBindingId: null, currentCompanyId: null, maxGeneration: 1 });

    const retry = await bind(loser === a ? 0 : 1, loser, '2026-07-16T10:00:02.000Z');
    expect(retry).toEqual({ status: 'superseded' });
    await expect(admin.device.findUnique({ where: { expoPushToken: token } }))
      .resolves.toMatchObject({ installationId: winner.installationId, companyId: winner.companyId });
  }, 30_000);

  it('barrière register→revoke : le waiter relit après commit et supprime le binding', async () => {
    const value = fixture(
      companyA,
      'user-a',
      `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`,
    );
    const locked = deferred();
    const release = deferred();
    const leader = stores[0]!.runWithTenant(companyA, async () => {
      await workers[0]!.client().$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended('bob-device-registry-v2', 0))
      `;
      locked.resolve();
      await release.promise;
      return stores[0]!.devices.register(registration(value));
    });
    await locked.promise;
    const waiterStarted = deferred();
    let waiterPid = 0;
    const waiter = stores[1]!.runInTransaction(() => stores[1]!.runWithTenant(companyA, async () => {
      const [backend] = await workers[1]!.client().$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid() AS pid
      `;
      waiterPid = backend!.pid;
      waiterStarted.resolve();
      return stores[1]!.devices.revokeThroughGeneration(revoke(value, 'authenticated'));
    }));
    await waiterStarted.promise;
    await waitForAdvisoryWaiter(waiterPid);
    release.resolve();

    await expect(leader).resolves.toMatchObject({ status: 'bound' });
    await expect(waiter).resolves.toBeUndefined();
    await expect(targets(0, companyA)).resolves.toEqual([]);
    await expect(admin.pushInstallation.findUnique({ where: { id: value.installationId } }))
      .resolves.toMatchObject({ maxGeneration: 1, currentBindingId: null });
  }, 30_000);

  it('barrière revoke→register : le waiter relit le high-water et reste superseded', async () => {
    const value = fixture(
      companyA,
      'user-a',
      `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`,
    );
    const locked = deferred();
    const release = deferred();
    const leader = stores[0]!.runWithTenant(companyA, async () => {
      await workers[0]!.client().$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended('bob-device-registry-v2', 0))
      `;
      locked.resolve();
      await release.promise;
      return stores[0]!.devices.revokeThroughGeneration(revoke(value, 'authenticated'));
    });
    await locked.promise;
    const waiterStarted = deferred();
    let waiterPid = 0;
    const waiter = stores[1]!.runInTransaction(() => stores[1]!.runWithTenant(companyA, async () => {
      const [backend] = await workers[1]!.client().$queryRaw<Array<{ pid: number }>>`
        SELECT pg_backend_pid() AS pid
      `;
      waiterPid = backend!.pid;
      waiterStarted.resolve();
      return stores[1]!.devices.register(registration(value));
    }));
    await waiterStarted.promise;
    await waitForAdvisoryWaiter(waiterPid);
    release.resolve();

    await expect(leader).resolves.toBeUndefined();
    await expect(waiter).resolves.toEqual({ status: 'superseded' });
    await expect(admin.device.count({ where: { installationId: value.installationId } })).resolves.toBe(0);
  }, 30_000);

  it('refuse fail-closed une transaction qui ne garantit pas READ COMMITTED', async () => {
    const value = fixture(
      companyA,
      'user-a',
      `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`,
    );
    await expect(stores[0]!.runInTransaction(async () => {
      await workers[0]!.client().$executeRawUnsafe(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      );
      return stores[0]!.runWithTenant(companyA, () => stores[0]!.devices.register(registration(value)));
    })).rejects.toThrow('Push registry requires PostgreSQL READ COMMITTED isolation.');
    await expect(admin.device.count({ where: { installationId: value.installationId } })).resolves.toBe(0);
  });

  it('rotation Expo : nouveau token exige G+1 et un retry égal ne remplace jamais le token actif', async () => {
    const initial = fixture(
      companyA,
      'user-a',
      `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`,
    );
    await bind(0, initial);
    const rotated = {
      ...initial,
      token: `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`,
      bindingId: randomUUID(),
      generation: 2,
    };
    await expect(bind(0, rotated)).resolves.toMatchObject({ status: 'bound' });
    await expect(bind(0, initial)).resolves.toEqual({ status: 'superseded' });
    await expect(bind(0, { ...rotated, token: initial.token })).resolves.toEqual({ status: 'superseded' });
    await expect(targets(0, companyA)).resolves.toMatchObject([
      { expoPushToken: rotated.token, bindingId: rotated.bindingId, bindingGeneration: 2 },
    ]);
  });

  it('swap concurrent de deux tokens : aucun deadlock et deux fences cohérents', async () => {
    const a = fixture(companyA, 'user-a', `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`);
    const b = fixture(companyB, 'user-b', `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`);
    await bind(0, a);
    await bind(1, b);
    const aNext = { ...a, token: b.token, bindingId: randomUUID(), generation: 2 };
    const bNext = { ...b, token: a.token, bindingId: randomUUID(), generation: 2 };

    await expect(Promise.all([bind(0, aNext), bind(1, bNext)])).resolves.toMatchObject([
      { status: 'bound' },
      { status: 'bound' },
    ]);
    await expect(targets(0, companyA)).resolves.toMatchObject([
      { expoPushToken: b.token, bindingId: aNext.bindingId, bindingGeneration: 2 },
    ]);
    await expect(targets(1, companyB)).resolves.toMatchObject([
      { expoPushToken: a.token, bindingId: bNext.bindingId, bindingGeneration: 2 },
    ]);
  }, 30_000);

  it('révocation authentifiée avant POST : fence créé et génération identique non ressuscitable', async () => {
    const value = fixture(
      companyA,
      'user-a',
      `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`,
    );
    await stores[0]!.runWithTenant(companyA, () => stores[0]!.devices.revokeThroughGeneration(revoke(value, 'authenticated')));
    await expect(bind(0, value)).resolves.toEqual({ status: 'superseded' });
    await expect(admin.pushInstallation.findUnique({ where: { id: value.installationId } }))
      .resolves.toMatchObject({ maxGeneration: 1, currentBindingId: null, lastConfirmedAt: null });
    await expect(admin.device.count({ where: { installationId: value.installationId } })).resolves.toBe(0);
  });

  it('logout génération N+1 révoque le binding N et bloque tous les POST retardés', async () => {
    const value = fixture(
      companyA,
      'user-a',
      `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`,
    );
    await bind(0, value);
    const next = { ...value, bindingId: randomUUID(), generation: 2 };
    await stores[0]!.runWithTenant(companyA, () => stores[0]!.devices.revokeThroughGeneration(revoke(next, 'authenticated')));

    await expect(bind(0, value)).resolves.toEqual({ status: 'superseded' });
    await expect(bind(0, next)).resolves.toEqual({ status: 'superseded' });
    await expect(targets(0, companyA)).resolves.toEqual([]);
  });

  it('replay public : mauvais secret sans effet, capacité exacte neutralisée sans oracle', async () => {
    const value = fixture(
      companyA,
      'user-a',
      `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`,
    );
    await bind(0, value);
    await stores[1]!.devices.revokeThroughGeneration({
      ...revoke(value, 'public'),
      revocationSecretHash: 'f'.repeat(64),
    });
    await expect(targets(0, companyA)).resolves.toHaveLength(1);
    await stores[1]!.devices.revokeThroughGeneration(revoke(value, 'public'));
    await expect(targets(0, companyA)).resolves.toEqual([]);
  });

  it('high-water public : through N purge <=N, conserve N+1 et le replay couvre un POST retardé', async () => {
    const delayed = fixture(
      companyA,
      'user-a',
      `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`,
      2,
    );
    const throughThree = { ...delayed, generation: 3 };
    await stores[1]!.devices.revokeThroughGeneration(revoke(throughThree, 'public'));
    await expect(bind(0, delayed)).resolves.toMatchObject({ status: 'bound' });
    await stores[1]!.devices.revokeThroughGeneration(revoke(throughThree, 'public'));
    await expect(targets(0, companyA)).resolves.toEqual([]);

    const next = { ...delayed, bindingId: randomUUID(), generation: 4 };
    await expect(bind(0, next)).resolves.toMatchObject({ status: 'bound' });
    await stores[1]!.devices.revokeThroughGeneration(revoke(throughThree, 'public'));
    await expect(targets(0, companyA)).resolves.toMatchObject([
      { bindingId: next.bindingId, bindingGeneration: 4 },
    ]);
  });

  it('delivery fail-closed : une ligne Device orpheline n’est jamais envoyée', async () => {
    const value = fixture(
      companyA,
      'user-a',
      `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`,
    );
    await bind(0, value);
    await admin.pushInstallation.update({
      where: { id: value.installationId },
      data: { currentBindingId: null, currentCompanyId: null, currentUserId: null },
    });
    await expect(admin.device.count({ where: { installationId: value.installationId } })).resolves.toBe(1);
    await expect(targets(0, companyA)).resolves.toEqual([]);
  });

  it('clôture de compte : neutralise les fences du tenant sans toucher un autre tenant', async () => {
    const a = fixture(companyA, 'user-a', `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`);
    const b = fixture(companyB, 'user-b', `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`);
    await bind(0, a);
    await bind(1, b);

    // Paramètre forgé : FORCE RLS conserve B puisque le contexte DB reste A.
    await stores[0]!.runWithTenant(companyA, () => stores[0]!.devices.deleteAllForCompany(companyB));
    await expect(targets(1, companyB)).resolves.toHaveLength(1);

    await stores[0]!.runWithTenant(companyA, () => stores[0]!.devices.deleteAllForCompany(companyA));
    await expect(targets(0, companyA)).resolves.toEqual([]);
    await expect(targets(1, companyB)).resolves.toHaveLength(1);
    await expect(admin.device.count({ where: { companyId: companyA } })).resolves.toBe(0);
    await expect(admin.pushInstallation.findUnique({ where: { id: a.installationId } }))
      .resolves.toMatchObject({ currentBindingId: null, currentCompanyId: null, maxGeneration: 1 });
    await expect(admin.pushInstallation.findUnique({ where: { id: b.installationId } }))
      .resolves.toMatchObject({ currentBindingId: b.bindingId, currentCompanyId: companyB });
  });

  it('barrière close-account→register : une requête partie avant la clôture relit et échoue', async () => {
    const value = fixture(
      companyA,
      'user-a',
      `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`,
    );
    const observedOpen = deferred();
    const resumeRegister = deferred();
    const delayedRegister = stores[0]!.runWithTenant(companyA, async () => {
      const [company] = await workers[0]!.client().$queryRaw<Array<{ closedAt: Date | null }>>`
        SELECT "closedAt" FROM "companies" WHERE "id" = ${companyA}
      `;
      expect(company?.closedAt).toBeNull();
      observedOpen.resolve();
      await resumeRegister.promise;
      return stores[0]!.devices.register(registration(value));
    });
    await observedOpen.promise;

    await stores[1]!.runWithTenant(companyA, async () => {
      await workers[1]!.client().$executeRaw`
        UPDATE "companies" SET "closedAt" = CURRENT_TIMESTAMP WHERE "id" = ${companyA}
      `;
      await stores[1]!.devices.deleteAllForCompany(companyA);
    });
    resumeRegister.resolve();

    await expect(delayedRegister).resolves.toEqual({ status: 'superseded' });
    await expect(admin.device.count({ where: { companyId: companyA } })).resolves.toBe(0);
    await expect(targets(0, companyA)).resolves.toEqual([]);
  }, 30_000);

  it('cutover N-1 fail-closed : ancien worker aveugle, ancien writer borné au legacy', async () => {
    const legacyToken = `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`;
    const legacyId = `legacy-${randomUUID()}`;
    await admin.device.create({
      data: {
        id: legacyId,
        companyId: companyA,
        userId: 'legacy-a',
        expoPushToken: legacyToken,
        platform: 'ios',
      },
    });

    const oldWorkerRows = await stores[0]!.runWithTenant(companyA, () =>
      workers[0]!.client().device.findMany({ where: { companyId: companyA } }),
    );
    expect(oldWorkerRows).toEqual([]);

    // SQL exact N-1 : seul set_config(token), puis ON CONFLICT global.
    await stores[1]!.runWithTenant(companyB, () => workers[1]!.client().$executeRaw`
      WITH rebind_capability AS MATERIALIZED (
        SELECT set_config('app.current_device_push_token', ${legacyToken}, true)
      )
      INSERT INTO "devices" (
        "id", "companyId", "userId", "expoPushToken", "platform", "createdAt", "updatedAt"
      )
      SELECT ${`legacy-new-${randomUUID()}`}, ${companyB}, 'legacy-b', ${legacyToken}, 'android',
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM rebind_capability
      ON CONFLICT ("expoPushToken") DO UPDATE SET
        "companyId" = EXCLUDED."companyId",
        "userId" = EXCLUDED."userId",
        "platform" = EXCLUDED."platform",
        "updatedAt" = EXCLUDED."updatedAt"
    `);
    await expect(admin.device.findUnique({ where: { expoPushToken: legacyToken } }))
      .resolves.toMatchObject({ companyId: companyB, installationId: null, bindingId: null });
    await expect(targets(1, companyB)).resolves.toEqual([]);

    const v2 = fixture(companyA, 'user-a', `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`);
    await bind(0, v2);
    await expect(stores[1]!.runWithTenant(companyB, () => workers[1]!.client().$executeRaw`
      WITH rebind_capability AS MATERIALIZED (
        SELECT set_config('app.current_device_push_token', ${v2.token}, true)
      )
      INSERT INTO "devices" (
        "id", "companyId", "userId", "expoPushToken", "platform", "createdAt", "updatedAt"
      )
      SELECT ${`legacy-forged-${randomUUID()}`}, ${companyB}, 'legacy-b', ${v2.token}, 'android',
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM rebind_capability
      ON CONFLICT ("expoPushToken") DO UPDATE SET
        "companyId" = EXCLUDED."companyId",
        "userId" = EXCLUDED."userId",
        "platform" = EXCLUDED."platform",
        "updatedAt" = EXCLUDED."updatedAt"
    `)).rejects.toThrow();
    await expect(admin.device.findUnique({ where: { expoPushToken: v2.token } }))
      .resolves.toMatchObject({ companyId: companyA, installationId: v2.installationId });

    // L'ancien DELETE sans opération devient un no-op; le nouvel endpoint legacy exact nettoie.
    await stores[1]!.runWithTenant(companyB, () =>
      workers[1]!.client().device.deleteMany({ where: { companyId: companyB, expoPushToken: legacyToken } }),
    );
    await expect(admin.device.count({ where: { expoPushToken: legacyToken } })).resolves.toBe(1);
    await stores[1]!.runWithTenant(companyB, () =>
      stores[1]!.devices.revokeLegacyOwnerToken(companyB, 'legacy-b', legacyToken),
    );
    await expect(admin.device.count({ where: { expoPushToken: legacyToken } })).resolves.toBe(0);
  });

  it('ticket DeviceNotRegistered tardif ne purge pas le binding auquel le token a été transféré', async () => {
    const token = `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`;
    const a = fixture(companyA, 'user-a', token);
    const b = fixture(companyB, 'user-b', token);
    await bind(0, a);
    const captured = (await targets(0, companyA))[0]!;
    await bind(1, b);

    await stores[0]!.runWithTenant(companyA, () => stores[0]!.devices.removeInvalidDeliveryTarget({
      companyId: companyA,
      expoPushToken: captured.expoPushToken,
      bindingId: captured.bindingId,
      bindingGeneration: captured.bindingGeneration,
    }));
    await expect(targets(1, companyB)).resolves.toMatchObject([{ bindingId: b.bindingId }]);
  });

  it('lookup provider : FORCE RLS ne révèle que la capacité exacte, jamais le tenant entier', async () => {
    const a = fixture(companyA, 'user-a', `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`);
    const aSibling = fixture(companyA, 'user-a', `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`);
    const b = fixture(companyB, 'user-b', `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`);
    await bind(0, a);
    await bind(0, aSibling);
    await bind(1, b);

    const visible = await withDeviceContext(0, companyA, {
      operation: 'provider-revoke-lookup',
      token: a.token,
      bindingId: a.bindingId,
      generation: a.generation,
    }, () => workers[0]!.client().$queryRaw<Array<{ bindingId: string }>>`
      SELECT "bindingId" FROM "devices" ORDER BY "bindingId"
    `);
    expect(visible).toEqual([{ bindingId: a.bindingId }]);

    const wrongGeneration = await withDeviceContext(0, companyA, {
      operation: 'provider-revoke-lookup',
      token: a.token,
      bindingId: a.bindingId,
      generation: a.generation + 1,
    }, () => workers[0]!.client().$queryRaw<Array<{ bindingId: string }>>`
      SELECT "bindingId" FROM "devices"
    `);
    expect(wrongGeneration).toEqual([]);
    const wrongTenant = await withDeviceContext(0, companyB, {
      operation: 'provider-revoke-lookup',
      token: a.token,
      bindingId: a.bindingId,
      generation: a.generation,
    }, () => workers[0]!.client().$queryRaw<Array<{ bindingId: string }>>`
      SELECT "bindingId" FROM "devices"
    `);
    expect(wrongTenant).toEqual([]);

    await stores[0]!.runWithTenant(companyA, () => stores[0]!.devices.removeInvalidDeliveryTarget({
      companyId: companyA,
      expoPushToken: a.token,
      bindingId: a.bindingId,
      bindingGeneration: a.generation,
    }));
    await expect(targets(0, companyA)).resolves.toMatchObject([{ bindingId: aSibling.bindingId }]);
    await expect(targets(1, companyB)).resolves.toMatchObject([{ bindingId: b.bindingId }]);
  });

  it('policies UPDATE exactes : aucune OR permissive ne contourne opération, high-water ou trigger', async () => {
    const value = fixture(companyA, 'user-a', `ExponentPushToken[${randomUUID().replaceAll('-', '')}]`);
    await bind(0, value);

    await expect(withDeviceContext(0, companyA, {
      operation: 'revoke-public',
      installationId: value.installationId,
      secretHash: value.secretHash,
      generation: 2,
    }, () => workers[0]!.client().$executeRaw`
      UPDATE "push_installations"
      SET "currentBindingId" = NULL, "currentCompanyId" = NULL, "currentUserId" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${value.installationId}::uuid
    `)).rejects.toThrow();
    await expect(admin.pushInstallation.findUnique({ where: { id: value.installationId } }))
      .resolves.toMatchObject({ maxGeneration: 1, currentBindingId: value.bindingId });

    await expect(withDeviceContext(0, companyA, {
      operation: 'revoke-auth',
      installationId: value.installationId,
      secretHash: value.secretHash,
      generation: 2,
      userId: value.userId,
    }, () => workers[0]!.client().$executeRaw`
      UPDATE "push_installations"
      SET "maxGeneration" = 2, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${value.installationId}::uuid
    `)).rejects.toThrow();

    await expect(withDeviceContext(0, companyA, {
      operation: 'close-account',
      installationId: value.installationId,
      secretHash: value.secretHash,
    }, () => workers[0]!.client().$executeRaw`
      UPDATE "push_installations"
      SET "maxGeneration" = 2147483647,
          "currentBindingId" = NULL, "currentCompanyId" = NULL, "currentUserId" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${value.installationId}::uuid
    `)).rejects.toThrow('account close may only neutralize current ownership');

    await expect(withDeviceContext(0, companyA, {
      operation: 'close-account',
      installationId: value.installationId,
      secretHash: value.secretHash,
    }, () => workers[0]!.client().$executeRaw`
      UPDATE "push_installations"
      SET "lastConfirmedAt" = CURRENT_TIMESTAMP,
          "currentBindingId" = NULL, "currentCompanyId" = NULL, "currentUserId" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${value.installationId}::uuid
    `)).rejects.toThrow('account close may only neutralize current ownership');

    await expect(withDeviceContext(0, companyA, {
      operation: 'register',
      installationId: value.installationId,
      secretHash: value.secretHash,
      token: value.token,
      bindingId: value.bindingId,
      generation: 2,
      userId: value.userId,
    }, () => workers[0]!.client().$executeRaw`
      UPDATE "push_installations"
      SET "maxGeneration" = 2,
          "currentBindingId" = NULL, "currentCompanyId" = NULL, "currentUserId" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${value.installationId}::uuid
    `)).rejects.toThrow('token transfer may only neutralize current ownership');

    const deliverMutationCount = await withDeviceContext(0, companyA, {
      operation: 'deliver',
    }, () => workers[0]!.client().$executeRaw`
      UPDATE "push_installations"
      SET "currentBindingId" = NULL, "currentCompanyId" = NULL, "currentUserId" = NULL,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${value.installationId}::uuid
    `);
    expect(deliverMutationCount).toBe(0);
    await expect(admin.pushInstallation.findUnique({ where: { id: value.installationId } }))
      .resolves.toMatchObject({ maxGeneration: 1, currentBindingId: value.bindingId });
  });

  it('certifie schéma, FORCE RLS, policies v2 et absence de capacité GUC résiduelle', async () => {
    const [role] = await workers[0]!.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

    const shapes = await admin.$queryRaw<Array<{
      tableName: string;
      rowSecurity: boolean;
      forceRowSecurity: boolean;
    }>>`
      SELECT table_class.relname AS "tableName",
             table_class.relrowsecurity AS "rowSecurity",
             table_class.relforcerowsecurity AS "forceRowSecurity"
      FROM pg_class AS table_class
      WHERE table_class.oid IN ('devices'::regclass, 'push_installations'::regclass)
      ORDER BY table_class.relname
    `;
    expect(shapes).toEqual([
      { tableName: 'devices', rowSecurity: true, forceRowSecurity: true },
      { tableName: 'push_installations', rowSecurity: true, forceRowSecurity: true },
    ]);

    const policies = await admin.$queryRaw<Array<{ tablename: string; policyname: string }>>`
      SELECT tablename, policyname
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('devices', 'push_installations')
      ORDER BY tablename, policyname
    `;
    expect(policies.map((policy) => `${policy.tablename}:${policy.policyname}`)).toEqual([
      'devices:device_binding_capability_select',
      'devices:device_binding_revoke_delete',
      'devices:device_close_account_delete',
      'devices:device_installation_capability_select',
      'devices:device_installation_rebind_delete',
      'devices:device_legacy_token_rebind_select',
      'devices:device_legacy_token_rebind_update',
      'devices:device_provider_revoke_lookup_select',
      'devices:device_tenant_delete',
      'devices:device_tenant_insert',
      'devices:device_tenant_select',
      'devices:device_tenant_update',
      'devices:device_token_rebind_select',
      'devices:device_token_rebind_update',
      'devices:device_token_transfer_delete',
      'devices:device_v2_register_insert',
      'push_installations:push_installation_binding_capability_select',
      'push_installations:push_installation_capability_select',
      'push_installations:push_installation_close_account_update',
      'push_installations:push_installation_delivery_select',
      'push_installations:push_installation_register_insert',
      'push_installations:push_installation_register_update',
      'push_installations:push_installation_revoke_update',
      'push_installations:push_installation_token_transfer_select',
      'push_installations:push_installation_token_transfer_update',
    ]);

    const [guc] = await workers[0]!.$queryRaw<Array<{ operation: string; installation: string }>>`
      SELECT current_setting('app.current_device_operation', true) AS operation,
             current_setting('app.current_device_installation_id', true) AS installation
    `;
    expect(guc).toEqual({ operation: '', installation: '' });
  });
});

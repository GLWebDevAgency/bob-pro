import { randomInt, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import type {
  RealtimeAdmissionLease,
  RealtimeAdmissionPolicy,
  RealtimeAdmissionResult,
} from './realtime-admission';
import { PrismaRealtimeAdmission } from './realtime-admission.prisma';
import { PrismaRealtimeGlobalCapacityInspector } from './realtime-capacity.prisma';

const RUN_POSTGRES_CERT = process.env.RUN_POSTGRES_REALTIME_CAPACITY_CERT === 'true';
const EXPECTED_PROVIDER = process.env.BOB_LIVE_PROVIDER ?? 'openai';
const EXPECTED_MODEL = EXPECTED_PROVIDER === 'mistral'
  ? process.env.MISTRAL_REALTIME_STT_MODEL ?? 'voxtral-mini-transcribe-realtime-2602'
  : process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2.1';
const EXPECTED_GLOBAL_MAX = Number(process.env.BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS ?? '5');
const EXPECTED_PROVIDER_MAX = Number(process.env.BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS ?? '6');
const EXPECTED_CONFIG_VERSION = Number(process.env.BOB_LIVE_CAPACITY_CONFIG_VERSION ?? '2');
const CAPACITY_RELEASE_HELPER = resolve(process.cwd(), 'scripts/realtime-capacity-release.sh');

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function startCapacityConfiguration(
  directUrl: string,
  enabled: boolean,
  applicationName: string,
): { readonly completion: Promise<void>; readonly terminate: () => void } {
  const child = spawn('sh', [CAPACITY_RELEASE_HELPER, 'configure'], {
    env: {
      ...process.env,
      DIRECT_URL: directUrl,
      PGAPPNAME: applicationName,
      BOB_LIVE_ENABLED: enabled ? 'true' : 'false',
      BOB_LIVE_PROVIDER: EXPECTED_PROVIDER,
      OPENAI_REALTIME_MODEL: EXPECTED_MODEL,
      MISTRAL_REALTIME_STT_MODEL: EXPECTED_MODEL,
      BOB_LIVE_GLOBAL_MAX_CONCURRENT_SESSIONS: String(EXPECTED_GLOBAL_MAX),
      BOB_LIVE_PROVIDER_MAX_CONCURRENT_SESSIONS: String(EXPECTED_PROVIDER_MAX),
      BOB_LIVE_CAPACITY_CONFIG_VERSION: String(EXPECTED_CONFIG_VERSION),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostic = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk: Buffer | string) => {
      if (diagnostic.length < 8_192) diagnostic += chunk.toString();
    });
  }
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `realtime capacity configure failed (${String(code)}/${String(signal)}): ${diagnostic}`,
      ));
    });
  });
  return { completion, terminate: () => child.kill('SIGTERM') };
}

async function waitForCapacityLock(admin: PrismaClient, applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await admin.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT (wait_event_type = 'Lock') AS waiting
        FROM pg_catalog.pg_stat_activity
       WHERE application_name = ${applicationName}
    `;
    if (rows.some((row) => row.waiting)) return;
    await wait(20);
  }
  throw new Error('Capacity close never waited on the in-flight admission singleton.');
}

function allowed(result: RealtimeAdmissionResult): RealtimeAdmissionLease | null {
  return result.allowed ? result.lease : null;
}

describe.skipIf(!RUN_POSTGRES_CERT)(
  'Bob Live C2 — plafond global PostgreSQL multi-clients',
  () => {
    const directUrl = process.env.DIRECT_URL ?? '';
    const runtimeUrl = process.env.DATABASE_URL ?? '';
    const prefix = `capacity-cert-${randomUUID()}`;
    const companyIds = Array.from(
      { length: EXPECTED_GLOBAL_MAX + 2 },
      (_, index) => `${prefix}-${index}`,
    );
    const workers: PrismaService[] = [];
    const admissions: PrismaRealtimeAdmission[] = [];
    const admitted = new Map<number, RealtimeAdmissionLease>();
    let admin: PrismaClient;
    let inspector: PrismaRealtimeGlobalCapacityInspector;

    const policy: RealtimeAdmissionPolicy = {
      globalCapacity: {
        providerId: EXPECTED_PROVIDER === 'mistral' ? 'mistral' : 'openai',
        providerModel: EXPECTED_MODEL,
        globalMaxSessions: EXPECTED_GLOBAL_MAX,
        providerMaxSessions: EXPECTED_PROVIDER_MAX,
        configVersion: EXPECTED_CONFIG_VERSION,
      },
      userLimitPerMinute: 20,
      userLimitPerHour: 100,
      tenantLimitPerMinute: 100,
      tenantLimitPerHour: 1_000,
      reservationTtlSeconds: 15,
      activeLeaseSeconds: 30,
      heartbeatSeconds: 10,
      reaperLeaseSeconds: 30,
    };

    beforeAll(async () => {
      if (!directUrl || !runtimeUrl) {
        throw new Error('DIRECT_URL and DATABASE_URL are required for the capacity certificate.');
      }
      if (
        !Number.isInteger(EXPECTED_GLOBAL_MAX)
        || EXPECTED_GLOBAL_MAX < 2
        || EXPECTED_GLOBAL_MAX > 50
        || !Number.isInteger(EXPECTED_PROVIDER_MAX)
        || EXPECTED_PROVIDER_MAX < EXPECTED_GLOBAL_MAX
      ) throw new Error('Capacity certificate limits are invalid.');

      admin = new PrismaClient({ datasourceUrl: directUrl });
      await admin.$connect();
      const sirenSeed = randomInt(100_000_000, 899_999_990);
      for (const [index, companyId] of companyIds.entries()) {
        const siren = String(sirenSeed + index).padStart(9, '0');
        await admin.company.create({
          data: {
            id: companyId,
            name: `Bob Capacity Certificate ${index}`,
            legalForm: 'EI',
            siren,
            siret: `${siren}${String(index + 1).padStart(5, '0')}`,
            trade: 'certification',
            vatRegime: 'franchise',
            addrLine1: `${index + 1} rue du Certificat`,
            addrZip: '75001',
            addrCity: 'Paris',
          },
        });
        const worker = new PrismaService({ datasourceUrl: runtimeUrl });
        await worker.$connect();
        workers.push(worker);
        admissions.push(new PrismaRealtimeAdmission(worker, policy));
      }
      inspector = new PrismaRealtimeGlobalCapacityInspector(workers[0]!);
      const initial = await inspector.inspect();
      if (!initial.ok || initial.snapshot.usedSessions !== 0) {
        throw new Error('Capacity certificate requires an empty active authority.');
      }
    });

    afterAll(async () => {
      if (admin) {
        await admin.$executeRaw`
          DELETE FROM realtime_session_leases
           WHERE "companyId" LIKE ${`${prefix}-%`}
        `;
        await admin.$executeRaw`
          DELETE FROM realtime_admission_events
           WHERE "companyId" LIKE ${`${prefix}-%`}
        `;
        await admin.company.deleteMany({ where: { id: { in: companyIds } } });
        const finalCapacity = await inspector.inspect();
        if (!finalCapacity.ok || finalCapacity.snapshot.usedSessions !== 0) {
          throw new Error('Capacity certificate leaked a realtime session lease.');
        }
      }
      await Promise.all(workers.map((worker) => worker.$disconnect()));
      await admin?.$disconnect();
    });

    it('n’expose que l’inspector agrégé au rôle runtime', async () => {
      await expect(inspector.inspect()).resolves.toMatchObject({
        ok: true,
        snapshot: {
          mode: 'active',
          providerId: policy.globalCapacity?.providerId,
          providerModel: EXPECTED_MODEL,
          globalMaxSessions: EXPECTED_GLOBAL_MAX,
          providerMaxSessions: EXPECTED_PROVIDER_MAX,
          configVersion: EXPECTED_CONFIG_VERSION,
          usedSessions: 0,
        },
      });
      await expect(workers[0]!.$queryRaw`SELECT * FROM realtime_global_capacity`).rejects.toThrow();
    });

    it('retourne un préflight typé et disponible au rôle runtime tenanté', async () => {
      const rows = await workers[0]!.withIsolatedTenant(companyIds[0]!, (tx) => tx.$queryRaw<
        Array<{ status: string; retryAt: Date | null }>
      >`
        SELECT status, "retryAt"
          FROM preflight_realtime_global_capacity_v1(
            ${policy.globalCapacity!.providerId}, ${policy.globalCapacity!.providerModel},
            ${policy.globalCapacity!.globalMaxSessions}::integer,
            ${policy.globalCapacity!.providerMaxSessions}::integer,
            ${policy.globalCapacity!.configVersion}::integer
          )
      `);
      expect(rows).toEqual([{ status: 'allowed', retryAt: null }]);
    });

    it('accorde exactement N réservations concurrentes et refuse N+1 avant provider', async () => {
      const results = await Promise.all(companyIds.slice(0, EXPECTED_GLOBAL_MAX + 1).map(
        (companyId, index) => admissions[index]!.reserve({
          companyId,
          subjectHash: index.toString(16).padStart(64, '0'),
          maxSessionSeconds: 900,
          subjectHashCandidates: [index.toString(16).padStart(64, '0')],
          principalBindingHash: index.toString(16).padStart(64, '0'),
          agentMissionBinding: null,
        }),
      ));
      for (const [index, result] of results.entries()) {
        const lease = allowed(result);
        if (lease) admitted.set(index, lease);
      }
      expect([...admitted.keys()]).toHaveLength(EXPECTED_GLOBAL_MAX);
      expect(results.filter((result) => !result.allowed)).toEqual([
        expect.objectContaining({ allowed: false, denial: 'global_capacity' }),
      ]);
      await expect(inspector.inspect()).resolves.toMatchObject({
        ok: true,
        snapshot: { usedSessions: EXPECTED_GLOBAL_MAX },
      });
    });

    it('bloque aussi un writer N-1 direct et interdit la suppression société', async () => {
      const deniedIndex = [...Array(EXPECTED_GLOBAL_MAX + 1).keys()]
        .find((index) => !admitted.has(index));
      expect(deniedIndex).toBeDefined();
      const companyId = companyIds[deniedIndex!]!;
      await expect(workers[deniedIndex!]!.withIsolatedTenant(companyId, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO realtime_session_leases (
            "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
            "reservedAt", "leaseExpiresAt", "hardExpiresAt", "updatedAt", version
          ) VALUES (
            ${companyId}, ${'f'.repeat(64)}, ${randomUUID()}::uuid, ${'e'.repeat(64)}, 'reserved',
            clock_timestamp(), clock_timestamp() + interval '15 seconds',
            clock_timestamp() + interval '15 minutes', clock_timestamp(), 1
          )
        `;
      })).rejects.toThrow();

      const activeCompanyId = companyIds[[...admitted.keys()][0]!]!;
      await expect(admin.company.delete({ where: { id: activeCompanyId } })).rejects.toThrow();
      await expect(inspector.inspect()).resolves.toMatchObject({
        ok: true,
        snapshot: { usedSessions: EXPECTED_GLOBAL_MAX },
      });
    });

    it('libère exactement une place, refuse le double release et accepte le retry', async () => {
      const [releasedIndex, releasedLease] = [...admitted.entries()][0]!;
      await expect(admissions[releasedIndex]!.release({
        ...releasedLease,
        providerTermination: 'not_created',
      })).resolves.toEqual({ ok: true, reason: null });
      await expect(admissions[releasedIndex]!.release({
        ...releasedLease,
        providerTermination: 'not_created',
      })).resolves.toEqual({ ok: false, reason: 'rejected' });
      admitted.delete(releasedIndex);

      const retryIndex = [...Array(EXPECTED_GLOBAL_MAX + 1).keys()]
        .find((index) => !admitted.has(index) && index !== releasedIndex)!;
      const retried = await admissions[retryIndex]!.reserve({
        companyId: companyIds[retryIndex]!,
        subjectHash: retryIndex.toString(16).padStart(64, '0'),
        maxSessionSeconds: 900,
        subjectHashCandidates: [retryIndex.toString(16).padStart(64, '0')],
        principalBindingHash: retryIndex.toString(16).padStart(64, '0'),
        agentMissionBinding: null,
      });
      const retriedLease = allowed(retried);
      expect(retriedLease).not.toBeNull();
      admitted.set(retryIndex, retriedLease!);
      await expect(inspector.inspect()).resolves.toMatchObject({
        ok: true,
        snapshot: { usedSessions: EXPECTED_GLOBAL_MAX },
      });
    });

    it('annule compteur et lease ensemble lors d’un rollback', async () => {
      const [releasedIndex, releasedLease] = [...admitted.entries()][0]!;
      await admissions[releasedIndex]!.release({
        ...releasedLease,
        providerTermination: 'not_created',
      });
      admitted.delete(releasedIndex);
      const before = await inspector.inspect();
      expect(before).toMatchObject({ ok: true, snapshot: { usedSessions: EXPECTED_GLOBAL_MAX - 1 } });

      const rollbackCompany = companyIds[releasedIndex]!;
      await expect(workers[releasedIndex]!.withIsolatedTenant(rollbackCompany, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO realtime_session_leases (
            "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
            "reservedAt", "leaseExpiresAt", "hardExpiresAt", "updatedAt", version
          ) VALUES (
            ${rollbackCompany}, ${'d'.repeat(64)}, ${randomUUID()}::uuid,
            ${'c'.repeat(64)}, 'reserved', clock_timestamp(),
            clock_timestamp() + interval '15 seconds',
            clock_timestamp() + interval '15 minutes', clock_timestamp(), 1
          )
        `;
        throw new Error('injected_rollback');
      })).rejects.toThrow(/injected_rollback/u);
      await expect(inspector.inspect()).resolves.toMatchObject({
        ok: true,
        snapshot: { usedSessions: EXPECTED_GLOBAL_MAX - 1 },
      });
    });

    it('ferme une release pendant une admission verrouillée sans deadlock ni dérive', async () => {
      const before = await inspector.inspect();
      if (!before.ok) throw new Error('Capacity authority unavailable before rollout race.');
      const baseline = before.snapshot.usedSessions;
      expect(baseline).toBe(EXPECTED_GLOBAL_MAX - 1);

      const companyId = companyIds.at(-1)!;
      const sessionId = randomUUID();
      let signalPreflightLocked!: () => void;
      let allowInsert!: () => void;
      const preflightLocked = new Promise<void>((resolve) => { signalPreflightLocked = resolve; });
      const insertAllowed = new Promise<void>((resolve) => { allowInsert = resolve; });
      const writer = workers.at(-1)!.withIsolatedTenant(companyId, async (tx) => {
        await tx.$queryRaw`
          SELECT set_config('statement_timeout', '6s', true),
                 set_config('lock_timeout', '3s', true)
        `;
        const [preflight] = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT status FROM preflight_realtime_global_capacity_v1(
            ${policy.globalCapacity!.providerId}, ${policy.globalCapacity!.providerModel},
            ${policy.globalCapacity!.globalMaxSessions}::integer,
            ${policy.globalCapacity!.providerMaxSessions}::integer,
            ${policy.globalCapacity!.configVersion}::integer
          )
        `;
        if (preflight?.status !== 'allowed') {
          throw new Error(`Unexpected rollout preflight: ${preflight?.status ?? 'missing'}`);
        }
        signalPreflightLocked();
        await insertAllowed;
        await tx.$executeRaw`
          INSERT INTO realtime_session_leases (
            "companyId", "subjectHash", "sessionId", "leaseTokenHash", state,
            "reservedAt", "leaseExpiresAt", "hardExpiresAt", "updatedAt", version
          ) VALUES (
            ${companyId}, ${'9'.repeat(64)}, ${sessionId}::uuid, ${'8'.repeat(64)}, 'reserved',
            clock_timestamp(), clock_timestamp() + interval '15 seconds',
            clock_timestamp() + interval '15 minutes', clock_timestamp(), 1
          )
        `;
      }, { maxWaitMs: 1_000, timeoutMs: 8_000 });

      await preflightLocked;
      const applicationName = `bob-capacity-close-${randomUUID()}`;
      const close = startCapacityConfiguration(directUrl, false, applicationName);
      try {
        await waitForCapacityLock(admin, applicationName);
        allowInsert();
        await writer;
        await close.completion;
      } catch (error) {
        allowInsert();
        close.terminate();
        await Promise.allSettled([writer, close.completion]);
        throw error;
      }

      await expect(inspector.inspect()).resolves.toMatchObject({
        ok: true,
        snapshot: { mode: 'closed', usedSessions: baseline + 1 },
      });
      await admin.$executeRaw`
        DELETE FROM realtime_session_leases WHERE "sessionId" = ${sessionId}::uuid
      `;
      const reopen = startCapacityConfiguration(
        directUrl,
        true,
        `bob-capacity-reopen-${randomUUID()}`,
      );
      await reopen.completion;
      await expect(inspector.inspect()).resolves.toMatchObject({
        ok: true,
        snapshot: { mode: 'active', usedSessions: baseline },
      });
    });

    it('refuse une policy dont la version diverge sans créer de lease', async () => {
      const mismatch = new PrismaRealtimeAdmission(workers.at(-1)!, {
        ...policy,
        globalCapacity: {
          ...policy.globalCapacity!,
          configVersion: EXPECTED_CONFIG_VERSION + 1,
        },
      });
      await expect(mismatch.reserve({
        companyId: companyIds.at(-1)!,
        subjectHash: 'b'.repeat(64),
        maxSessionSeconds: 900,
        subjectHashCandidates: ['b'.repeat(64)],
        principalBindingHash: 'b'.repeat(64),
        agentMissionBinding: null,
      })).resolves.toMatchObject({ allowed: false, denial: 'unavailable' });
      await expect(inspector.inspect()).resolves.toMatchObject({
        ok: true,
        snapshot: { usedSessions: EXPECTED_GLOBAL_MAX - 1 },
      });
    });
  },
);

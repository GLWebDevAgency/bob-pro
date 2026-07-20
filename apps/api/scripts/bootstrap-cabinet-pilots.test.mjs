import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  bootstrapConfiguredPilots,
  parsePilotBootstrapEnvironment,
} from './bootstrap-cabinet-pilots.mjs';

const cabinetId = '11111111-1111-4111-8111-111111111111';
const secondCabinetId = '44444444-4444-4444-8444-444444444444';
const founderId = '22222222-2222-4222-8222-222222222222';
const secondFounderId = '55555555-5555-4555-8555-555555555555';
const workerId = '33333333-3333-4333-8333-333333333333';

function item(overrides = {}) {
  return {
    cabinetId,
    name: 'Cabinet Pilote',
    founderUserId: founderId,
    expectedFlagVersion: 1,
    actor: 'release-ops',
    reason: 'Pilote approuve',
    ...overrides,
  };
}

function environment(items = [item()], overrides = {}) {
  return {
    CABINET_PILOT_BOOTSTRAP_CONFIG: JSON.stringify(items),
    CABINET_INVITATION_WORKER_ENABLED: 'true',
    CABINET_INVITATION_WORKER_USER_ID: workerId,
    CABINET_RELEASE_ENV: 'staging',
    JOB_CABINET_IDS: items.map((entry) => entry.cabinetId).join(','),
    ...overrides,
  };
}

test('parse la configuration et injecte uniquement le worker et environnement du deploiement', () => {
  const [input] = parsePilotBootstrapEnvironment(environment([
    item({ timeZone: 'Europe/Paris' }),
  ]));

  assert.equal(input.cabinetId, cabinetId);
  assert.equal(input.workerUserId, workerId);
  assert.equal(input.environment, 'staging');
  assert.equal(input.timeZone, 'Europe/Paris');
});

test('execute chaque bootstrap et ne retourne que le nombre traite', () => {
  const items = [
    item(),
    item({
      cabinetId: secondCabinetId,
      founderUserId: secondFounderId,
      expectedFlagVersion: 2,
    }),
  ];
  const calls = [];
  const env = environment(items, { JOB_CABINET_IDS: `${secondCabinetId},${cabinetId}` });

  const count = bootstrapConfiguredPilots(env, {
    bootstrapPilot(input, dependencies) {
      calls.push({ input, environment: dependencies.environment });
    },
  });

  assert.equal(count, 2);
  assert.deepEqual(calls.map(({ input }) => input.cabinetId), [cabinetId, secondCabinetId]);
  assert.ok(calls.every(({ environment: received }) => received === env));
});

test('ne fait rien lorsque la configuration est absente', () => {
  let called = false;
  const count = bootstrapConfiguredPilots({}, { bootstrapPilot() { called = true; } });
  assert.equal(count, 0);
  assert.equal(called, false);
});

test('refuse un ensemble different de JOB_CABINET_IDS', () => {
  assert.throws(
    () => parsePilotBootstrapEnvironment(environment([item()], { JOB_CABINET_IDS: secondCabinetId })),
    /must exactly match/,
  );
});

test('refuse les identifiants cabinet dupliques dans chaque source', () => {
  assert.throws(
    () => parsePilotBootstrapEnvironment(environment([item(), item()])),
    /cabinetId values must be unique/,
  );
  assert.throws(
    () => parsePilotBootstrapEnvironment(environment([item()], { JOB_CABINET_IDS: `${cabinetId},${cabinetId}` })),
    /JOB_CABINET_IDS values must be unique/,
  );
});

test('refuse plus de 100 pilotes et les versions non entieres', () => {
  const tooMany = Array.from({ length: 101 }, (_, index) => item({
    cabinetId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
  }));
  assert.throws(() => parsePilotBootstrapEnvironment(environment(tooMany)), /limited to 100/);
  assert.throws(
    () => parsePilotBootstrapEnvironment(environment([item({ expectedFlagVersion: 1.5 })])),
    /positive integer/,
  );
});

test('refuse le bootstrap hors release active du worker', () => {
  assert.throws(
    () => parsePilotBootstrapEnvironment(environment([item()], { CABINET_INVITATION_WORKER_ENABLED: 'false' })),
    /worker must be enabled/,
  );
  assert.throws(
    () => parsePilotBootstrapEnvironment(environment([item()], { CABINET_RELEASE_ENV: 'development' })),
    /must be staging or production/,
  );
});

test('la CLI ne journalise jamais la configuration ou les identites', () => {
  const privateMarker = 'founder-private@example.test';
  const result = spawnSync(process.execPath, ['apps/api/scripts/bootstrap-cabinet-pilots.mjs'], {
    cwd: new URL('../../..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      CABINET_PILOT_BOOTSTRAP_CONFIG: `{invalid:${privateMarker}}`,
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'bootstrap-cabinet-pilots:error');
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(privateMarker.replace('.', '\\.')));
});

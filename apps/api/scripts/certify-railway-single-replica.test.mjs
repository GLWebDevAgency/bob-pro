import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  certifySingleRailwayReplica,
  railwayTopologyExitCode,
  RAILWAY_TOPOLOGY_DRIFT_EXIT_CODE,
  RAILWAY_TOPOLOGY_UNAVAILABLE_EXIT_CODE,
  RailwayTopologyDriftError,
  RailwayTopologyUnavailableError,
} from './certify-railway-single-replica.mjs';

const certifierPath = fileURLToPath(
  new URL('./certify-railway-single-replica.mjs', import.meta.url),
);
const topologyWorkflowPath = fileURLToPath(
  new URL('../../../.github/workflows/railway-topology-drift.yml', import.meta.url),
);
const SERVICE_ID = '742e8318-c67b-47fc-8479-a1d52ce55b2f';

function captureError(callback) {
  let captured;
  try {
    callback();
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof Error, 'la certification devait échouer');
  return captured;
}

function deployConfig(
  replicaCounts = [1],
  total = replicaCounts.reduce((sum, count) => sum + count, 0),
  options = {},
) {
  return {
    drainingSeconds: options.drainingSeconds ?? null,
    numReplicas: total,
    overlapSeconds: options.overlapSeconds ?? null,
    multiRegionConfig: Object.fromEntries(
      replicaCounts.map((count, index) => [`region-${index}`, { numReplicas: count }]),
    ),
  };
}

function fixture(
  replicaCounts = [1],
  total = replicaCounts.reduce((sum, count) => sum + count, 0),
  options = {},
) {
  const latestDeploy = deployConfig(replicaCounts, total, options);
  const activeDeployments = (
    options.activeDeployments ?? [
      {
        status: 'SUCCESS',
        deploymentStopped: false,
        instances: [{ status: 'RUNNING' }],
        meta: {
          serviceManifest: {
            deploy: structuredClone(options.activeDeploy ?? latestDeploy),
          },
        },
      },
    ]
  ).map((deployment) => ({
    meta: {
      serviceManifest: {
        deploy: structuredClone(latestDeploy),
      },
    },
    ...deployment,
  }));
  return {
    environments: {
      edges: [
        {
          node: {
            name: 'production',
            serviceInstances: {
              edges: [
                {
                  node: {
                    serviceId: SERVICE_ID,
                    serviceName: 'bob-pro-api',
                    activeDeployments,
                    latestDeployment: {
                      meta: {
                        serviceManifest: {
                          deploy: latestDeploy,
                        },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      ],
    },
  };
}

test('certifie exactement un replica dans une seule région', () => {
  const expected = {
    environment: 'production',
    service: 'bob-pro-api',
    serviceId: SERVICE_ID,
    replicas: 1,
  };
  assert.deepEqual(certifySingleRailwayReplica(fixture(), 'production', 'bob-pro-api'), expected);
  assert.deepEqual(certifySingleRailwayReplica(fixture(), 'production', SERVICE_ID), expected);
});

test('refuse plusieurs replicas ou plusieurs régions', () => {
  assert.throws(
    () => certifySingleRailwayReplica(fixture([2]), 'production', SERVICE_ID),
    /exactement un replica/u,
  );
  assert.throws(
    () => certifySingleRailwayReplica(fixture([1, 0]), 'production', SERVICE_ID),
    /exactement un replica/u,
  );
});

test('refuse un chevauchement ou une période de drainage configurés', () => {
  assert.throws(
    () =>
      certifySingleRailwayReplica(
        fixture([1], 1, { overlapSeconds: 5 }),
        'production',
        'bob-pro-api',
      ),
    /overlap\/draining/u,
  );
  assert.throws(
    () =>
      certifySingleRailwayReplica(
        fixture([1], 1, { drainingSeconds: 30 }),
        'production',
        'bob-pro-api',
      ),
    /overlap\/draining/u,
  );
});

test('refuse plusieurs déploiements actifs même si le manifeste annonce un replica', () => {
  const active = {
    status: 'SUCCESS',
    deploymentStopped: false,
    instances: [{ status: 'RUNNING' }],
  };
  assert.throws(
    () =>
      certifySingleRailwayReplica(
        fixture([1], 1, { activeDeployments: [active, structuredClone(active)] }),
        'production',
        'bob-pro-api',
      ),
    /exactement un déploiement actif/u,
  );
});

test('refuse une configuration active dangereuse même si latestDeployment est sûr', () => {
  assert.throws(
    () =>
      certifySingleRailwayReplica(
        fixture([1], 1, { activeDeploy: deployConfig([2]) }),
        'production',
        'bob-pro-api',
      ),
    /activeDeployments\[0\].*exactement un replica/u,
  );
  assert.throws(
    () =>
      certifySingleRailwayReplica(
        fixture([1], 1, {
          activeDeploy: deployConfig([1], 1, { drainingSeconds: 30 }),
        }),
        'production',
        'bob-pro-api',
      ),
    /activeDeployments\[0\].*overlap\/draining/u,
  );
});

test('refuse plusieurs instances, un arrêt ou un état non RUNNING', () => {
  assert.throws(
    () =>
      certifySingleRailwayReplica(
        fixture([1], 1, {
          activeDeployments: [
            {
              status: 'SUCCESS',
              deploymentStopped: false,
              instances: [{ status: 'RUNNING' }, { status: 'RUNNING' }],
            },
          ],
        }),
        'production',
        'bob-pro-api',
      ),
    /exactement une instance RUNNING/u,
  );
  assert.throws(
    () =>
      certifySingleRailwayReplica(
        fixture([1], 1, {
          activeDeployments: [
            {
              status: 'SUCCESS',
              deploymentStopped: true,
              instances: [{ status: 'RUNNING' }],
            },
          ],
        }),
        'production',
        'bob-pro-api',
      ),
    /exactement une instance RUNNING/u,
  );
  assert.throws(
    () =>
      certifySingleRailwayReplica(
        fixture([1], 1, {
          activeDeployments: [
            {
              status: 'DEPLOYING',
              deploymentStopped: false,
              instances: [{ status: 'STARTING' }],
            },
          ],
        }),
        'production',
        'bob-pro-api',
      ),
    /exactement une instance RUNNING/u,
  );
});

test('échoue fermé si la forme Railway attendue disparaît', () => {
  assert.throws(
    () => certifySingleRailwayReplica({}, 'production', 'bob-pro-api'),
    /environments absents/u,
  );
  assert.throws(
    () => certifySingleRailwayReplica(fixture(), 'staging', 'bob-pro-api'),
    /environment introuvable/u,
  );
  const missingRuntimeShape = fixture();
  delete missingRuntimeShape.environments.edges[0].node.serviceInstances.edges[0].node
    .activeDeployments;
  assert.throws(
    () => certifySingleRailwayReplica(missingRuntimeShape, 'production', 'bob-pro-api'),
    /activeDeployments absents/u,
  );
  const missingActiveManifest = fixture();
  delete missingActiveManifest.environments.edges[0].node.serviceInstances.edges[0].node
    .activeDeployments[0].meta;
  assert.throws(
    () => certifySingleRailwayReplica(missingActiveManifest, 'production', 'bob-pro-api'),
    /activeDeployments\[0\]\.meta\.serviceManifest\.deploy absent/u,
  );
  const invalidServiceIdentity = fixture();
  invalidServiceIdentity.environments.edges[0].node.serviceInstances.edges[0].node.serviceId =
    'bob-pro-api';
  assert.throws(
    () => certifySingleRailwayReplica(invalidServiceIdentity, 'production', 'bob-pro-api'),
    /identité du service absente ou invalide/u,
  );
  const missingServiceIdentity = fixture();
  delete missingServiceIdentity.environments.edges[0].node.serviceInstances.edges[0].node.serviceId;
  assert.throws(
    () => certifySingleRailwayReplica(missingServiceIdentity, 'production', 'bob-pro-api'),
    /identité du service absente ou invalide/u,
  );
});

test('classe une topologie dangereuse comme dérive avec un code de sortie dédié', () => {
  const error = captureError(() =>
    certifySingleRailwayReplica(fixture([2]), 'production', 'bob-pro-api'),
  );

  assert.ok(error instanceof RailwayTopologyDriftError);
  assert.equal(railwayTopologyExitCode(error), RAILWAY_TOPOLOGY_DRIFT_EXIT_CODE);
});

test('classe une réponse absente ou invalide comme indisponible, jamais comme dérive', () => {
  const missingShape = captureError(() =>
    certifySingleRailwayReplica({}, 'production', 'bob-pro-api'),
  );
  assert.ok(missingShape instanceof RailwayTopologyUnavailableError);
  assert.equal(railwayTopologyExitCode(missingShape), RAILWAY_TOPOLOGY_UNAVAILABLE_EXIT_CODE);

  const malformedReplicaConfig = fixture();
  const malformedDeployment =
    malformedReplicaConfig.environments.edges[0].node.serviceInstances.edges[0].node
      .latestDeployment;
  malformedDeployment.meta.serviceManifest.deploy.multiRegionConfig = {
    region: { numReplicas: '1' },
  };
  const malformed = captureError(() =>
    certifySingleRailwayReplica(malformedReplicaConfig, 'production', 'bob-pro-api'),
  );
  assert.ok(malformed instanceof RailwayTopologyUnavailableError);
  assert.equal(railwayTopologyExitCode(malformed), RAILWAY_TOPOLOGY_UNAVAILABLE_EXIT_CODE);
});

test('le point d’entrée CLI expose réellement les verdicts succès, indisponible et dérive', () => {
  const run = (status) =>
    spawnSync(process.execPath, [certifierPath, 'production', 'bob-pro-api'], {
      input: JSON.stringify(status),
      encoding: 'utf8',
    });

  const success = run(fixture());
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout, `railway-single-replica-ok:production:${SERVICE_ID}\n`);

  const unavailable = run({});
  assert.equal(unavailable.status, RAILWAY_TOPOLOGY_UNAVAILABLE_EXIT_CODE);
  assert.match(unavailable.stderr, /environments absents/u);

  const drifted = run(fixture([2]));
  assert.equal(drifted.status, RAILWAY_TOPOLOGY_DRIFT_EXIT_CODE);
  assert.match(drifted.stderr, /exactement un replica/u);
});

test('le workflow isole les secrets, les branches et les incidents de topologie', () => {
  const workflow = readFileSync(topologyWorkflowPath, 'utf8');

  assert.match(workflow, /if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}/u);
  assert.match(workflow, /github_environment: railway-topology-staging/u);
  // Le moniteur lit la topologie avec un jeton scoped par environnement — jamais le jeton
  // de déploiement de l'environnement GitHub `production` (least-privilege, posé le 25/07).
  assert.match(workflow, /github_environment: railway-topology-production/u);
  assert.doesNotMatch(workflow, /github_environment: production$/mu);
  assert.match(workflow, /RAILWAY_TOKEN: \$\{\{ secrets\.RAILWAY_TOKEN \}\}/u);
  assert.doesNotMatch(workflow, /RAILWAY_STAGING_TOKEN/u);
  // P0 GPT 27/07 : exporter RAILWAY_ENV redirige le CLI Railway v5.26 vers son backend
  // INTERNE de staging (backboard.railway-staging.com) — jeton valide présenté à la
  // mauvaise API. Le nom de variable est interdit à jamais dans ce workflow.
  assert.doesNotMatch(workflow, /RAILWAY_ENV[^I]/u);
  assert.match(workflow, /TARGET_ENVIRONMENT_NAME/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /max-parallel: 1/u);
  assert.match(workflow, /failure_kind=drift/u);
  assert.match(workflow, /failure_kind=unavailable/u);
  assert.match(workflow, /gh api --paginate --slurp/u);
  assert.match(workflow, /map\(select\(\.pull_request == null\)\)/u);
  assert.match(workflow, /plusieurs incidents Railway possédés correspondent/u);
  assert.match(workflow, /Close owned incidents after recovery/u);
  assert.doesNotMatch(workflow, /gh issue list[\s\S]*--limit 100/u);
});

test('le workflow ne fabrique jamais de marqueur orphelin et ne spamme pas les incidents', () => {
  const workflow = readFileSync(topologyWorkflowPath, 'utf8');

  // Un échec AVANT l'étape topology (ex. install CLI) laisse failure_kind vide :
  // sans défaut, le marqueur est malformé et l'incident devient infermable (#12/#13).
  assert.match(workflow, /FAILURE_KIND="\$\{FAILURE_KIND:-unavailable\}"/u);
  // La récupération referme aussi les incidents historiques à marqueur vide.
  assert.match(workflow, /legacy-empty/u);
  assert.match(
    workflow,
    new RegExp('bob-pro:\\$INCIDENT_LABEL:\\$TARGET_ENVIRONMENT_NAME: -->', 'u'),
  );
  // L'issue ouverte EST l'état : aucun commentaire de relance à chaque tick.
  assert.doesNotMatch(workflow, /échoue encore/u);
});

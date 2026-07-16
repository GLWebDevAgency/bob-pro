import test from 'node:test';
import assert from 'node:assert/strict';
import { certifySingleRailwayReplica } from './certify-railway-single-replica.mjs';

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
                    serviceId: 'service-id',
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
  assert.deepEqual(certifySingleRailwayReplica(fixture(), 'production', 'bob-pro-api'), {
    environment: 'production',
    service: 'bob-pro-api',
    replicas: 1,
  });
});

test('refuse plusieurs replicas ou plusieurs régions', () => {
  assert.throws(
    () => certifySingleRailwayReplica(fixture([2]), 'production', 'service-id'),
    /exactement un replica/u,
  );
  assert.throws(
    () => certifySingleRailwayReplica(fixture([1, 0]), 'production', 'service-id'),
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
    /exactement un déploiement actif/u,
  );
  const missingActiveManifest = fixture();
  delete missingActiveManifest.environments.edges[0].node.serviceInstances.edges[0].node
    .activeDeployments[0].meta;
  assert.throws(
    () => certifySingleRailwayReplica(missingActiveManifest, 'production', 'bob-pro-api'),
    /activeDeployments\[0\]\.meta\.serviceManifest\.deploy absent/u,
  );
});

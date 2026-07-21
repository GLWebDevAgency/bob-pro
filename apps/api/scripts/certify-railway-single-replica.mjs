import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

export const RAILWAY_TOPOLOGY_UNAVAILABLE_EXIT_CODE = 1;
export const RAILWAY_TOPOLOGY_DRIFT_EXIT_CODE = 2;

export class RailwayTopologyUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RailwayTopologyUnavailableError';
  }
}

export class RailwayTopologyDriftError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RailwayTopologyDriftError';
  }
}

function unavailable(message) {
  throw new RailwayTopologyUnavailableError(message);
}

function drift(message) {
  throw new RailwayTopologyDriftError(message);
}

function certifyDeploymentConfig(deployment, deploymentLabel) {
  const deploy = object(object(object(deployment)?.meta)?.serviceManifest)?.deploy;
  if (!object(deploy)) {
    unavailable(`Railway status: ${deploymentLabel}.meta.serviceManifest.deploy absent`);
  }
  const regions = object(deploy.multiRegionConfig);
  if (!regions) {
    unavailable(`Railway status: ${deploymentLabel}.deploy.multiRegionConfig absent`);
  }
  const regionalReplicaCounts = Object.values(regions).map((region) => object(region)?.numReplicas);
  if (
    regionalReplicaCounts.length === 0 ||
    regionalReplicaCounts.some((count) => !Number.isInteger(count) || count < 0) ||
    !Number.isInteger(deploy.numReplicas) ||
    deploy.numReplicas < 0
  ) {
    unavailable(`Railway status: ${deploymentLabel}.deploy replica config invalide`);
  }
  if (
    regionalReplicaCounts.length !== 1 ||
    regionalReplicaCounts.reduce((total, count) => total + count, 0) !== 1 ||
    deploy.numReplicas !== 1
  ) {
    drift(
      `Railway ${deploymentLabel} doit rester à exactement un replica tant que le throttler est process-local`,
    );
  }

  if (
    !['overlapSeconds', 'drainingSeconds'].every(
      (field) => deploy[field] === null || typeof deploy[field] === 'number',
    )
  ) {
    unavailable(`Railway status: ${deploymentLabel}.deploy overlap/draining invalide`);
  }

  if (
    (deploy.overlapSeconds !== null && deploy.overlapSeconds !== 0) ||
    (deploy.drainingSeconds !== null && deploy.drainingSeconds !== 0)
  ) {
    drift(
      `Railway ${deploymentLabel} overlap/draining doit rester nul tant que le throttler est process-local`,
    );
  }
}

export function certifySingleRailwayReplica(status, environmentName, serviceNameOrId) {
  const root = object(status);
  const environments = object(root?.environments)?.edges;
  if (!Array.isArray(environments)) unavailable('Railway status: environments absents');
  const environment = environments
    .map((edge) => object(edge)?.node)
    .find((node) => object(node)?.name === environmentName);
  if (!object(environment)) unavailable(`Railway environment introuvable: ${environmentName}`);
  const services = object(environment.serviceInstances)?.edges;
  if (!Array.isArray(services)) unavailable('Railway status: serviceInstances absents');
  const matches = services
    .map((edge) => object(edge)?.node)
    .filter((node) => {
      const service = object(node);
      return service?.serviceName === serviceNameOrId || service?.serviceId === serviceNameOrId;
    });
  if (matches.length !== 1) {
    unavailable(`Railway service non unique ou introuvable: ${serviceNameOrId}`);
  }
  const service = object(matches[0]);
  certifyDeploymentConfig(service?.latestDeployment, 'latestDeployment');

  const activeDeployments = service.activeDeployments;
  if (!Array.isArray(activeDeployments)) {
    unavailable('Railway status: activeDeployments absents');
  }
  if (activeDeployments.length !== 1) {
    drift('Railway doit exposer exactement un déploiement actif');
  }
  const activeDeployment = object(activeDeployments[0]);
  const instances = activeDeployment?.instances;
  if (
    !activeDeployment ||
    typeof activeDeployment.status !== 'string' ||
    typeof activeDeployment.deploymentStopped !== 'boolean' ||
    !Array.isArray(instances) ||
    instances.some((instance) => typeof object(instance)?.status !== 'string')
  ) {
    unavailable('Railway status: déploiement actif incomplet');
  }
  if (
    activeDeployment?.status !== 'SUCCESS' ||
    activeDeployment.deploymentStopped !== false ||
    instances.length !== 1 ||
    object(instances[0])?.status !== 'RUNNING'
  ) {
    drift('Railway doit exposer exactement une instance RUNNING sur un déploiement SUCCESS');
  }
  certifyDeploymentConfig(activeDeployment, 'activeDeployments[0]');

  return { environment: environmentName, service: service.serviceName, replicas: 1 };
}

export function railwayTopologyExitCode(error) {
  return error instanceof RailwayTopologyDriftError
    ? RAILWAY_TOPOLOGY_DRIFT_EXIT_CODE
    : RAILWAY_TOPOLOGY_UNAVAILABLE_EXIT_CODE;
}

async function main() {
  const [, , environmentName, serviceNameOrId, statusPath = '-'] = process.argv;
  if (!environmentName || !serviceNameOrId) {
    throw new Error(
      'usage: certify-railway-single-replica.mjs <environment> <service> [status.json|-]',
    );
  }
  const raw =
    statusPath === '-'
      ? await new Promise((resolve, reject) => {
          let input = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (chunk) => {
            input += chunk;
          });
          process.stdin.on('end', () => resolve(input));
          process.stdin.on('error', reject);
        })
      : await readFile(statusPath, 'utf8');
  const result = certifySingleRailwayReplica(JSON.parse(raw), environmentName, serviceNameOrId);
  process.stdout.write(`railway-single-replica-ok:${result.environment}:${result.service}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Railway replica certification failed'}\n`,
    );
    process.exitCode = railwayTopologyExitCode(error);
  });
}

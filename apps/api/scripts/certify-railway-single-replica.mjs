import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function certifyDeploymentConfig(deployment, deploymentLabel) {
  const deploy = object(object(object(deployment)?.meta)?.serviceManifest)?.deploy;
  if (!object(deploy)) {
    throw new Error(`Railway status: ${deploymentLabel}.meta.serviceManifest.deploy absent`);
  }
  const regions = object(deploy.multiRegionConfig);
  if (!regions) {
    throw new Error(`Railway status: ${deploymentLabel}.deploy.multiRegionConfig absent`);
  }
  const regionalReplicaCounts = Object.values(regions).map((region) => object(region)?.numReplicas);
  if (
    regionalReplicaCounts.length !== 1 ||
    regionalReplicaCounts.some((count) => !Number.isInteger(count) || count < 0) ||
    regionalReplicaCounts.reduce((total, count) => total + count, 0) !== 1 ||
    deploy.numReplicas !== 1
  ) {
    throw new Error(
      `Railway ${deploymentLabel} doit rester à exactement un replica tant que le throttler est process-local`,
    );
  }

  if (
    (deploy.overlapSeconds !== null && deploy.overlapSeconds !== 0) ||
    (deploy.drainingSeconds !== null && deploy.drainingSeconds !== 0)
  ) {
    throw new Error(
      `Railway ${deploymentLabel} overlap/draining doit rester nul tant que le throttler est process-local`,
    );
  }
}

export function certifySingleRailwayReplica(status, environmentName, serviceNameOrId) {
  const root = object(status);
  const environments = object(root?.environments)?.edges;
  if (!Array.isArray(environments)) throw new Error('Railway status: environments absents');
  const environment = environments
    .map((edge) => object(edge)?.node)
    .find((node) => object(node)?.name === environmentName);
  if (!object(environment)) throw new Error(`Railway environment introuvable: ${environmentName}`);
  const services = object(environment.serviceInstances)?.edges;
  if (!Array.isArray(services)) throw new Error('Railway status: serviceInstances absents');
  const matches = services
    .map((edge) => object(edge)?.node)
    .filter((node) => {
      const service = object(node);
      return service?.serviceName === serviceNameOrId || service?.serviceId === serviceNameOrId;
    });
  if (matches.length !== 1) {
    throw new Error(`Railway service non unique ou introuvable: ${serviceNameOrId}`);
  }
  const service = object(matches[0]);
  certifyDeploymentConfig(service?.latestDeployment, 'latestDeployment');

  const activeDeployments = service.activeDeployments;
  if (!Array.isArray(activeDeployments) || activeDeployments.length !== 1) {
    throw new Error('Railway doit exposer exactement un déploiement actif');
  }
  const activeDeployment = object(activeDeployments[0]);
  const instances = activeDeployment?.instances;
  if (
    activeDeployment?.status !== 'SUCCESS' ||
    activeDeployment.deploymentStopped !== false ||
    !Array.isArray(instances) ||
    instances.length !== 1 ||
    object(instances[0])?.status !== 'RUNNING'
  ) {
    throw new Error(
      'Railway doit exposer exactement une instance RUNNING sur un déploiement SUCCESS',
    );
  }
  certifyDeploymentConfig(activeDeployment, 'activeDeployments[0]');

  return { environment: environmentName, service: service.serviceName, replicas: 1 };
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
    process.exitCode = 1;
  });
}

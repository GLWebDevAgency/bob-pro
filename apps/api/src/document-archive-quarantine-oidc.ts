import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { ArchiveQuarantineWorkflowIdentity } from './documents/archive-quarantine';

const RELEASE_SHA = /^[0-9a-f]{40}$/u;
const RUN_ID = /^[1-9][0-9]{0,19}$/u;
const ACTOR = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const OIDC_AUDIENCE = 'bob-document-archive-quarantine-staging';
const REPOSITORY = 'GLWebDevAgency/bob-pro';
const WORKFLOW_REF =
  'GLWebDevAgency/bob-pro/.github/workflows/document-archive-quarantine-staging.yml@refs/heads/main';
const SUBJECT = 'repo:GLWebDevAgency/bob-pro:environment:staging';
const REPOSITORY_ID = '1286748365';
const REPOSITORY_OWNER_ID = '84627817';
const FOUNDER_ACTOR_ID = '84627817';

/**
 * Authentifie une exécution manuelle GitHub staging du compte fondateur contre le SHA servi.
 * Le jeton brut ne quitte jamais le processus : seule son empreinte entre dans le journal privé.
 */
export async function verifyArchiveQuarantineOidc(input: {
  readonly token: string;
  readonly releaseSha: string;
  readonly jwks?: Parameters<typeof jwtVerify>[1];
}): Promise<ArchiveQuarantineWorkflowIdentity> {
  if (!RELEASE_SHA.test(input.releaseSha)) {
    throw new Error('ARCHIVE_QUARANTINE_OIDC_RELEASE_SHA_INVALID');
  }
  const jwks = input.jwks ?? createRemoteJWKSet(
    new URL(`${OIDC_ISSUER}/.well-known/jwks`),
    { timeoutDuration: 10_000, cooldownDuration: 30_000, cacheMaxAge: 600_000 },
  );
  const verified = await jwtVerify(input.token, jwks, {
    issuer: OIDC_ISSUER,
    audience: OIDC_AUDIENCE,
    algorithms: ['RS256'],
    clockTolerance: 5,
  });
  const claims = verified.payload;
  const runAttempt = typeof claims.run_attempt === 'string'
    ? Number(claims.run_attempt)
    : Number.NaN;
  if (
    claims.repository !== REPOSITORY
    || claims.repository_id !== REPOSITORY_ID
    || claims.repository_owner_id !== REPOSITORY_OWNER_ID
    || claims.sub !== SUBJECT
    || claims.ref !== 'refs/heads/main'
    || claims.sha !== input.releaseSha
    || claims.environment !== 'staging'
    || claims.workflow_ref !== WORKFLOW_REF
    || claims.workflow_sha !== input.releaseSha
    || claims.event_name !== 'workflow_dispatch'
    || typeof claims.actor !== 'string'
    || !ACTOR.test(claims.actor)
    || claims.actor_id !== FOUNDER_ACTOR_ID
    || typeof claims.run_id !== 'string'
    || !RUN_ID.test(claims.run_id)
    || !Number.isSafeInteger(runAttempt)
    || runAttempt < 1
  ) {
    throw new Error('ARCHIVE_QUARANTINE_OIDC_CLAIMS_INVALID');
  }
  return {
    issuer: OIDC_ISSUER,
    audience: OIDC_AUDIENCE,
    repository: REPOSITORY,
    ref: 'refs/heads/main',
    sha: input.releaseSha,
    environment: 'staging',
    workflowRef: WORKFLOW_REF,
    workflowSha: input.releaseSha,
    eventName: 'workflow_dispatch',
    subject: SUBJECT,
    repositoryId: REPOSITORY_ID,
    repositoryOwnerId: REPOSITORY_OWNER_ID,
    actor: claims.actor,
    actorId: FOUNDER_ACTOR_ID,
    runId: claims.run_id,
    runAttempt,
    tokenSha256: createHash('sha256').update(input.token, 'utf8').digest('hex'),
  };
}

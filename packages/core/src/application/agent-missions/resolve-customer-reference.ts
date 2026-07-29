import {
  type QuoteMissionStagedCustomerResolutionV1,
} from '../../domain/agent/agent-mission';
import { hasAsciiControlCharacter } from '../../shared-kernel/control-characters';
import { type Result, err, ok } from '../../shared-kernel/result';
import {
  CUSTOMER_CANDIDATE_SEARCH_LIMIT,
  type CustomerCandidate,
  type CustomerCandidateSearchPort,
} from '../ports/customer-candidate-search';
import { type IdGeneratorPort } from '../ports/services';
import { type AppError } from '../result';

export const AGENT_MISSION_MAX_CUSTOMER_REFERENCE_LENGTH = 300;

export function isCanonicalCustomerReference(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value.length >= 1
    && value.length <= AGENT_MISSION_MAX_CUSTOMER_REFERENCE_LENGTH
    && value === value.trim().replace(/\s+/gu, ' ')
    && !hasAsciiControlCharacter(value)
  );
}

function validCandidate(candidate: CustomerCandidate): boolean {
  return (
    typeof candidate === 'object'
    && candidate !== null
    && !Array.isArray(candidate)
    && Object.keys(candidate).length === 4
    && ['customerId', 'canonicalName', 'matchKind', 'score'].every(
      (key) => Object.hasOwn(candidate, key),
    )
    && typeof candidate.customerId === 'string'
    && candidate.customerId.length >= 1
    && candidate.customerId.length <= 200
    && candidate.customerId === candidate.customerId.trim()
    && !hasAsciiControlCharacter(candidate.customerId)
    && typeof candidate.canonicalName === 'string'
    && candidate.canonicalName.length >= 1
    && candidate.canonicalName.length <= 300
    && candidate.canonicalName === candidate.canonicalName.trim().replace(/\s+/gu, ' ')
    && !hasAsciiControlCharacter(candidate.canonicalName)
    && (candidate.matchKind === 'exact' || candidate.matchKind === 'fuzzy')
    && typeof candidate.score === 'number'
    && Number.isFinite(candidate.score)
    && candidate.score >= 0
    && candidate.score <= 1
  );
}

export async function resolveCustomerReference(input: {
  readonly companyId: string;
  readonly query: string;
  readonly customers: CustomerCandidateSearchPort;
  readonly ids: IdGeneratorPort;
}): Promise<Result<QuoteMissionStagedCustomerResolutionV1, AppError>> {
  if (!isCanonicalCustomerReference(input.query)) {
    return err({
      kind: 'validation',
      issues: [{ field: 'customerReference', message: 'Référence client invalide.' }],
    });
  }
  const candidates = await input.customers.search({
    companyId: input.companyId,
    query: input.query,
    limit: CUSTOMER_CANDIDATE_SEARCH_LIMIT,
  });
  if (
    !Array.isArray(candidates)
    || candidates.length > CUSTOMER_CANDIDATE_SEARCH_LIMIT
    || candidates.some((candidate) => !validCandidate(candidate))
    || new Set(candidates.map((candidate) => candidate.customerId)).size !== candidates.length
  ) {
    return err({
      kind: 'dependency',
      port: 'customer_candidate_search',
      cause: 'invalid_candidate_set',
    });
  }
  if (candidates.length === 0) return ok(Object.freeze({ kind: 'none' }));
  // LIMIT 6 est une sentinelle : même un exact parmi ces six résultats ne permet pas de prouver
  // qu'il n'existe pas d'autres homonymes. La règle produit exige donc toujours de préciser.
  if (candidates.length === CUSTOMER_CANDIDATE_SEARCH_LIMIT) {
    return ok(Object.freeze({ kind: 'too_many' }));
  }
  const exactCandidates = candidates.filter(
    (candidate) => candidate.matchKind === 'exact',
  );
  if (exactCandidates.length === 1) {
    return ok(Object.freeze({
      kind: 'exact',
      customerId: exactCandidates[0]!.customerId,
    }));
  }
  return ok(Object.freeze({
    kind: 'choices',
    decisionId: input.ids.newId(),
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze({
      choiceId: input.ids.newId(),
      customerId: candidate.customerId,
    }))),
  }));
}

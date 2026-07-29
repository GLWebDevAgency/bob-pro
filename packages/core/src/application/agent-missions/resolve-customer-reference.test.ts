import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_CANDIDATE_SEARCH_LIMIT,
  type CustomerCandidate,
  type CustomerCandidateSearchPort,
} from '../ports/customer-candidate-search';
import { type IdGeneratorPort } from '../ports/services';
import {
  isCanonicalCustomerReference,
  resolveCustomerReference,
} from './resolve-customer-reference';

class SequenceIds implements IdGeneratorPort {
  private next = 1;

  newId(): string {
    return `20000000-0000-4000-8000-${String(this.next++).padStart(12, '0')}`;
  }
}

function candidate(
  index: number,
  matchKind: 'exact' | 'fuzzy' = 'fuzzy',
): CustomerCandidate {
  return {
    customerId: `customer-${index}`,
    canonicalName: `Client ${index}`,
    matchKind,
    score: matchKind === 'exact' ? 1 : 0.8 - index / 100,
  };
}

function searchPort(
  candidates: readonly CustomerCandidate[],
  calls: Array<{ readonly companyId: string; readonly query: string; readonly limit: number }>,
): CustomerCandidateSearchPort {
  return {
    search: async (input) => {
      calls.push(input);
      return candidates;
    },
  };
}

describe('resolveCustomerReference', () => {
  it.each([
    '',
    ' Camping  les Pins ',
    'Camping  les Pins',
    'Camping\nles Pins',
    'x'.repeat(301),
  ])('refuse la référence non canonique %j avant le port', async (query) => {
    const calls: Array<{ companyId: string; query: string; limit: number }> = [];
    expect(isCanonicalCustomerReference(query)).toBe(false);

    const result = await resolveCustomerReference({
      companyId: 'company-1',
      query,
      customers: searchPort([], calls),
      ids: new SequenceIds(),
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'validation', issues: [{ field: 'customerReference' }] },
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [[], { kind: 'none' }],
    [[candidate(1, 'exact')], { kind: 'exact', customerId: 'customer-1' }],
    [
      [candidate(2), candidate(1, 'exact'), candidate(3)],
      { kind: 'exact', customerId: 'customer-1' },
    ],
    [[candidate(1)], {
      kind: 'choices',
      decisionId: '20000000-0000-4000-8000-000000000001',
      candidates: [{
        choiceId: '20000000-0000-4000-8000-000000000002',
        customerId: 'customer-1',
      }],
    }],
    [
      [candidate(1), candidate(2), candidate(3)],
      {
        kind: 'choices',
        decisionId: '20000000-0000-4000-8000-000000000001',
        candidates: [
          {
            choiceId: '20000000-0000-4000-8000-000000000002',
            customerId: 'customer-1',
          },
          {
            choiceId: '20000000-0000-4000-8000-000000000003',
            customerId: 'customer-2',
          },
          {
            choiceId: '20000000-0000-4000-8000-000000000004',
            customerId: 'customer-3',
          },
        ],
      },
    ],
    [
      Array.from({ length: CUSTOMER_CANDIDATE_SEARCH_LIMIT }, (_, index) => candidate(index + 1)),
      { kind: 'too_many' },
    ],
    [
      [
        candidate(1, 'exact'),
        ...Array.from(
          { length: CUSTOMER_CANDIDATE_SEARCH_LIMIT - 1 },
          (_, index) => candidate(index + 2),
        ),
      ],
      { kind: 'too_many' },
    ],
    [
      [candidate(1, 'exact'), candidate(2, 'exact'), candidate(3)],
      {
        kind: 'choices',
        decisionId: '20000000-0000-4000-8000-000000000001',
        candidates: [
          {
            choiceId: '20000000-0000-4000-8000-000000000002',
            customerId: 'customer-1',
          },
          {
            choiceId: '20000000-0000-4000-8000-000000000003',
            customerId: 'customer-2',
          },
          {
            choiceId: '20000000-0000-4000-8000-000000000004',
            customerId: 'customer-3',
          },
        ],
      },
    ],
  ] as const)(
    'applique la politique 0/exact/fuzzy/choix/limite sans persister de label',
    async (candidates, expected) => {
      const calls: Array<{ companyId: string; query: string; limit: number }> = [];
      const result = await resolveCustomerReference({
        companyId: 'company-1',
        query: 'Camping les Pins',
        customers: searchPort(candidates, calls),
        ids: new SequenceIds(),
      });

      expect(result).toEqual({ ok: true, value: expected });
      expect(calls).toEqual([{
        companyId: 'company-1',
        query: 'Camping les Pins',
        limit: CUSTOMER_CANDIDATE_SEARCH_LIMIT,
      }]);
      expect(JSON.stringify(result)).not.toContain('Client ');
    },
  );

  it('rejette fail-closed un résultat de port dupliqué ou à forme ouverte', async () => {
    const invalid = {
      ...candidate(1),
      transcript: 'ne doit jamais entrer',
    } as CustomerCandidate;
    const duplicate = candidate(2);

    const opened = await resolveCustomerReference({
      companyId: 'company-1',
      query: 'Client',
      customers: searchPort([invalid], []),
      ids: new SequenceIds(),
    });
    const duplicated = await resolveCustomerReference({
      companyId: 'company-1',
      query: 'Client',
      customers: searchPort([duplicate, duplicate], []),
      ids: new SequenceIds(),
    });

    expect(opened).toEqual({
      ok: false,
      error: {
        kind: 'dependency',
        port: 'customer_candidate_search',
        cause: 'invalid_candidate_set',
      },
    });
    expect(duplicated).toEqual(opened);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ApiErrorReport } from '@bob/api-client';
import { reportApiFailure } from './api-failure-reporter';

function report(overrides: Partial<ApiErrorReport> = {}): ApiErrorReport {
  return {
    at: '2026-07-31T14:03:00.000Z',
    method: 'GET',
    path: '/company/lookup',
    status: 502,
    durationMs: 210,
    code: 'BOB-SIRET-502',
    error: {
      kind: 'dependency',
      port: 'recherche-entreprises',
      cause: 'HTTP 502',
      code: 'BOB-SIRET-502',
      correlationId: 'corr-dep-1234',
    },
    ...overrides,
  };
}

describe('reportApiFailure — pont vers journal + Sentry', () => {
  it('journalise CHAQUE échec et remonte un dependency à Sentry en tags sans cause brute', () => {
    const record = vi.fn(async () => undefined);
    const capture = vi.fn();

    reportApiFailure(report(), { record, capture });

    expect(record).toHaveBeenCalledTimes(1);
    expect((record.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
      code: 'BOB-SIRET-502',
      kind: 'dependency',
      correlationId: 'corr-dep-1234',
      path: '/company/lookup',
    });
    expect(capture).toHaveBeenCalledTimes(1);
    const [error, context] = capture.mock.calls[0] as [Error, Record<string, unknown>];
    expect(error.message).toBe('api_failure BOB-SIRET-502');
    expect(context).toEqual({
      code: 'BOB-SIRET-502',
      kind: 'dependency',
      port: 'recherche-entreprises',
      correlationId: 'corr-dep-1234',
      method: 'GET',
      path: '/company/lookup',
      status: 502,
    });
    // La cause brute (peut citer une URL/donnée) ne part JAMAIS en télémétrie.
    expect(JSON.stringify(context)).not.toContain('HTTP 502');
  });

  it("n'alerte JAMAIS Sentry pour unavailable (état assumé) ni pour un refus 4xx", () => {
    const record = vi.fn(async () => undefined);
    const capture = vi.fn();

    reportApiFailure(
      report({
        code: 'BOB-API-503',
        error: { kind: 'unavailable', service: 'cashflow-banking-source' },
      }),
      { record, capture },
    );
    reportApiFailure(
      report({
        code: 'BOB-SIRET-404',
        status: 404,
        error: { kind: 'not_found', entity: 'company', id: 'x' },
      }),
      { record, capture },
    );

    expect(record).toHaveBeenCalledTimes(2);
    expect(capture).not.toHaveBeenCalled();
  });

  it('ne jette jamais, même si le journal explose', () => {
    const record = vi.fn(() => {
      throw new Error('stockage HS');
    });
    const capture = vi.fn();
    expect(() =>
      reportApiFailure(report(), { record: record as never, capture }),
    ).not.toThrow();
  });
});

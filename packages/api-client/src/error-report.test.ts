import { describe, expect, it, vi } from 'vitest';
import { emitApiErrorReport, redactPathForDiagnostics, type ApiErrorReport } from './error-report';

describe('redactPathForDiagnostics — jamais de PII dans les canaux techniques', () => {
  it('supprime ENTIÈREMENT la query string (elle peut porter un SIRET)', () => {
    expect(redactPathForDiagnostics('/company/lookup?siret=91300380500017')).toBe(
      '/company/lookup',
    );
    expect(redactPathForDiagnostics('/quotes?customer=Julien#top')).toBe('/quotes');
  });

  it('remplace les segments identifiants : UUID → :id, numérique long → :num, jeton → :token', () => {
    expect(
      redactPathForDiagnostics('/quotes/0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000/issue'),
    ).toBe('/quotes/:id/issue');
    expect(redactPathForDiagnostics('/company/lookup/91300380500017')).toBe(
      '/company/lookup/:num',
    );
    expect(
      redactPathForDiagnostics(`/voice/realtime/calls/${'a'.repeat(32)}`),
    ).toBe('/voice/realtime/calls/:token');
  });

  it('décode les segments encodés avant de décider (un %2F ne cache pas un numéro)', () => {
    expect(redactPathForDiagnostics('/company/lookup/9130%20038')).toBe(
      '/company/lookup/9130%20038',
    );
    expect(redactPathForDiagnostics('/documents/913003805000%31%37')).toBe('/documents/:num');
  });

  it('borne la longueur et laisse les routes courtes reconnaissables', () => {
    expect(redactPathForDiagnostics(`/quotes/${'segment-court/'.repeat(30)}`).length).toBeLessThanOrEqual(120);
    expect(redactPathForDiagnostics('/subscription/invoices')).toBe('/subscription/invoices');
  });
});

describe('emitApiErrorReport — observateur best-effort', () => {
  const report: ApiErrorReport = {
    at: '2026-07-31T10:00:00.000Z',
    method: 'GET',
    path: '/company/lookup',
    status: 404,
    durationMs: 12,
    code: 'BOB-SIRET-404',
    error: { kind: 'not_found', entity: 'company', id: '123' },
  };

  it('transmet le rapport tel quel à l’observateur', () => {
    const onError = vi.fn();
    emitApiErrorReport(onError, report);
    expect(onError).toHaveBeenCalledExactlyOnceWith(report);
  });

  it('avale une exception de l’observateur (jamais un second échec) et tolère son absence', () => {
    expect(() =>
      emitApiErrorReport(() => {
        throw new Error('journal plein');
      }, report),
    ).not.toThrow();
    expect(() => emitApiErrorReport(undefined, report)).not.toThrow();
  });
});

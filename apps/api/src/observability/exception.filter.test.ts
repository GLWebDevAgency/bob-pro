import { HttpException, HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AllExceptionsFilter, appErrorLogSummary } from './exception.filter';
import { rootLogger } from './logger';
import type { ErrorReporter } from './error-reporter';

function hostWith(res: unknown): ArgumentsHost {
  return { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('appErrorLogSummary', () => {
  it('extrait kind + champs descriptifs de l’enveloppe unwrap', () => {
    expect(
      appErrorLogSummary({ ok: false, error: { kind: 'unavailable', service: 'subscription-record' } }),
    ).toEqual({ kind: 'unavailable', service: 'subscription-record' });
    expect(
      appErrorLogSummary({ ok: false, error: { kind: 'dependency', port: 'ocr', cause: 'mistral-ocr HTTP 429' } }),
    ).toEqual({ kind: 'dependency', port: 'ocr', cause: 'mistral-ocr HTTP 429' });
  });

  it('n’expose JAMAIS les issues de validation ni un DomainError (liste blanche)', () => {
    expect(
      appErrorLogSummary({
        ok: false,
        error: {
          kind: 'validation',
          issues: [{ field: 'contentBase64', message: 'IBAN FR76…' }],
        },
      }),
    ).toEqual({ kind: 'validation' });
    expect(
      appErrorLogSummary({ ok: false, error: { kind: 'domain', error: { montant: 'secret' } } }),
    ).toEqual({ kind: 'domain' });
  });

  it('borne la longueur des champs et rejette les corps hors contrat', () => {
    const summary = appErrorLogSummary({
      ok: false,
      error: { kind: 'dependency', port: 'ocr', cause: 'x'.repeat(1_000) },
    });
    expect(summary?.cause).toHaveLength(300);
    expect(appErrorLogSummary(null)).toBeNull();
    expect(appErrorLogSummary('Internal server error')).toBeNull();
    expect(appErrorLogSummary({ ok: false, error: { kind: 42 } })).toBeNull();
    expect(appErrorLogSummary({ statusCode: 500, message: 'Internal server error' })).toBeNull();
  });
});

describe('AllExceptionsFilter', () => {
  it("un 'unavailable' est un refus fail-closed ASSUMÉ : warn diagnosticable, JAMAIS remonté comme incident", () => {
    const errorSpy = vi.spyOn(rootLogger, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(rootLogger, 'warn').mockImplementation(() => undefined);
    const reporter: ErrorReporter = { captureException: vi.fn() };
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };
    // Cas terrain (20/07) : aucune source bancaire connectée — état métier NORMAL, pas une panne.
    const body = { ok: false, error: { kind: 'unavailable', service: 'cashflow-banking-source' } };

    new AllExceptionsFilter(reporter).catch(
      new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE),
      hostWith(res),
    );

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const record = warnSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record.status).toBe(503);
    expect(record.appError).toEqual({ kind: 'unavailable', service: 'cashflow-banking-source' });
    // Le rapporteur alimente l'alerting (et demain Sentry) : un état assumé ne doit pas le saturer.
    expect(reporter.captureException).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith(body);
  });

  it("un 'dependency' (amont réellement en panne) reste remonté, mais en warn — pas en « exception non gérée »", () => {
    const errorSpy = vi.spyOn(rootLogger, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(rootLogger, 'warn').mockImplementation(() => undefined);
    const reporter: ErrorReporter = { captureException: vi.fn() };
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };
    const body = { ok: false, error: { kind: 'dependency', port: 'ocr', cause: 'mistral-ocr HTTP 503' } };

    new AllExceptionsFilter(reporter).catch(
      new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE),
      hostWith(res),
    );

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(reporter.captureException).toHaveBeenCalledTimes(1);
  });

  it('ne logge pas un 4xx mais renvoie le corps intact', () => {
    const errorSpy = vi.spyOn(rootLogger, 'error').mockImplementation(() => undefined);
    const reporter: ErrorReporter = { captureException: vi.fn() };
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };
    const body = { ok: false, error: { kind: 'validation', issues: [] } };

    new AllExceptionsFilter(reporter).catch(
      new HttpException(body, HttpStatus.UNPROCESSABLE_ENTITY),
      hostWith(res),
    );

    expect(errorSpy).not.toHaveBeenCalled();
    expect(reporter.captureException).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith(body);
  });

  it('garde le comportement 500 pour une exception non-HTTP (stack conservée, pas d’appError)', () => {
    const errorSpy = vi.spyOn(rootLogger, 'error').mockImplementation(() => undefined);
    const reporter: ErrorReporter = { captureException: vi.fn() };
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };

    new AllExceptionsFilter(reporter).catch(new Error('boom interne'), hostWith(res));

    const record = errorSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record.appError).toBeUndefined();
    expect(String(record.err)).toContain('boom interne');
    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ statusCode: 500, message: 'Internal server error' });
  });
});

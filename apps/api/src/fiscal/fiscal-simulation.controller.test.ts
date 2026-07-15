import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { FiscalSimulationController } from './fiscal-simulation.controller';
import type { PublicodesEvaluationService } from './publicodes-evaluation.service';
import type { AppLogger } from '../observability/logger';
import type { FiscalSimulationEnvelope, MicroSimulationResult } from './fiscal-simulation.types';

function logger(): AppLogger {
  return {
    audit: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
  } as unknown as AppLogger;
}

const sampleMicroResponse: FiscalSimulationEnvelope<MicroSimulationResult> = {
  type: 'micro',
  rulesVersion: 'modele-social@11.0.0',
  effectiveDate: '2026-07-15',
  calculatedAt: '2026-07-15T10:00:00.000Z',
  coverage: 'estimated',
  missingVariablesCount: 3,
  warnings: [],
  hypotheses: [],
  traces: [],
  result: { cotisationsCentsPerMonth: 53_350, revenuNetCentsPerYear: 2_359_800, tauxEffectifPct: 21.3 },
};

describe('FiscalSimulationController', () => {
  beforeEach(() => {
    vi.stubEnv('FISCAL_PUBLICODES_SIMULATIONS_ENABLED', 'true');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function setup() {
    const evaluation = {
      evaluateMicro: vi.fn(async () => ({ ok: true as const, value: sampleMicroResponse })),
      evaluateAssimileSalarie: vi.fn(),
    } as unknown as PublicodesEvaluationService;
    const appLogger = logger();
    const controller = new FiscalSimulationController(evaluation, appLogger);
    return { evaluation, appLogger, controller };
  }

  it('renvoie 404 (shadow) quand FISCAL_PUBLICODES_SIMULATIONS_ENABLED=false — aucun appel au moteur', async () => {
    vi.stubEnv('FISCAL_PUBLICODES_SIMULATIONS_ENABLED', 'false');
    const { controller, evaluation } = setup();
    await expect(controller.simulate({ type: 'micro' })).rejects.toThrow(HttpException);
    expect(evaluation.evaluateMicro).not.toHaveBeenCalled();
    try {
      await controller.simulate({ type: 'micro' });
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(404);
    }
  });

  it('rejette un corps invalide avec 422 avant tout appel au service (zod, controller mince)', async () => {
    const { controller, evaluation } = setup();
    await expect(controller.simulate({ type: 'micro', caAnnualCents: -1 })).rejects.toThrow(HttpException);
    expect(evaluation.evaluateMicro).not.toHaveBeenCalled();
  });

  it('rejette un champ inconnu (schema .strict())', async () => {
    const { controller } = setup();
    await expect(
      controller.simulate({
        type: 'micro',
        caAnnualCents: 3_000_000,
        activityNature: 'bic_service',
        versementLiberatoire: false,
        date: '2026-07-15',
        champInconnu: 'x',
      }),
    ).rejects.toThrow(HttpException);
  });

  it('délègue un body micro valide à evaluateMicro avec les champs mappés, journalise un audit léger, renvoie la réponse', async () => {
    const { controller, evaluation, appLogger } = setup();
    const response = await controller.simulate({
      type: 'micro',
      caAnnualCents: 3_000_000,
      activityNature: 'bic_service',
      acre: null,
      versementLiberatoire: false,
      date: '2026-07-15',
    });
    expect(response).toEqual(sampleMicroResponse);
    expect(evaluation.evaluateMicro).toHaveBeenCalledWith({
      type: 'micro',
      caAnnualCents: 3_000_000,
      activityNature: 'bic_service',
      acre: null,
      versementLiberatoire: false,
      date: '2026-07-15',
    });
    expect(appLogger.audit).toHaveBeenCalledWith(
      'fiscal.simulation_computed',
      expect.objectContaining({ type: 'micro', coverage: 'estimated' }),
    );
  });

  it('délègue un body assimile valide à evaluateAssimileSalarie', async () => {
    const { controller, evaluation } = setup();
    (evaluation.evaluateAssimileSalarie as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      value: { ...sampleMicroResponse, type: 'assimile', result: { brutMensuelCents: 319_175, coutTotalEmployeurCents: 449_260, inversionFail: false } },
    });
    await controller.simulate({ type: 'assimile', netMensuelCibleCents: 250_000, date: '2026-07-15' });
    expect(evaluation.evaluateAssimileSalarie).toHaveBeenCalledWith({
      type: 'assimile',
      netMensuelCibleCents: 250_000,
      date: '2026-07-15',
    });
  });

  it('propage une erreur de domaine du service (ex. situation non exploitable) en HttpException', async () => {
    const { controller, evaluation } = setup();
    (evaluation.evaluateMicro as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      error: { kind: 'validation', issues: [{ field: 'result', message: 'non applicable' }] },
    });
    await expect(
      controller.simulate({
        type: 'micro',
        caAnnualCents: 3_000_000,
        activityNature: 'bic_service',
        versementLiberatoire: false,
        date: '2026-07-15',
      }),
    ).rejects.toThrow(HttpException);
  });
});

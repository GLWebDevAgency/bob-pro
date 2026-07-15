import { Body, Controller, HttpException, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { appNotFound, type AppError, type Result } from '@bob/core';
import { isFiscalPublicodesSimulationsEnabled } from '../config/env';
import { AppLogger, getPrincipal } from '../observability/logger';
import { unwrap } from '../http/result';
import { WithoutTenantPersistenceTransaction } from '../persistence/tenant-persistence.interceptor';
import { PublicodesEvaluationService } from './publicodes-evaluation.service';
import type { FiscalSimulationResponse } from './fiscal-simulation.types';

const acreSchema = z
  .object({
    granted: z.boolean(),
    startDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

const microSchema = z
  .object({
    type: z.literal('micro'),
    caAnnualCents: z.number().int().positive().max(100_000_000_00),
    activityNature: z.enum(['bic_vente', 'bic_service', 'bnc', 'bnc_cipav', 'mixte']),
    acre: acreSchema.nullable().optional(),
    versementLiberatoire: z.boolean(),
    date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

const assimileSchema = z
  .object({
    type: z.literal('assimile'),
    netMensuelCibleCents: z.number().int().positive().max(100_000_000_00),
    date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

const fiscalSimulationBodySchema = z.discriminatedUnion('type', [microSchema, assimileSchema]);

function bodyOf(body: unknown): z.infer<typeof fiscalSimulationBodySchema> {
  const parsed = fiscalSimulationBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new HttpException(
      {
        ok: false,
        error: {
          kind: 'validation',
          issues: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
        },
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  return parsed.data;
}

/**
 * BOB EXPERT FISCAL — service d'évaluation Publicodes serveur (SPIKE_PUBLICODES_20260715.md,
 * SPEC_EXPERT_FISCAL.md §V2 pts.3-4-5). Controller MINCE : validation de forme (zod) + délégation
 * au service ; auth/tenant portés par le guard global (SupabaseAuthGuard, aucune liste blanche —
 * même posture que /diagnostic, /fiscal-calendar). V1 = LECTURE PURE, rien n'est persisté
 * (`@WithoutTenantPersistenceTransaction` — pas de transaction tenant à ouvrir pour un calcul).
 *
 * Flag shadow (contre-revue GPT ⑥) : `FISCAL_PUBLICODES_SIMULATIONS_ENABLED` (défaut 'false') —
 * tant qu'il n'est pas activé explicitement, l'endpoint se comporte comme s'il n'existait pas
 * (404) : PAS d'UI/voix consommant ce endpoint tant que le cadrage UX n'est pas co-challengé
 * (cf. mission).
 */
@Controller('fiscal/simulations')
export class FiscalSimulationController {
  constructor(
    private readonly evaluation: PublicodesEvaluationService,
    private readonly logger: AppLogger,
  ) {}

  @Post()
  @WithoutTenantPersistenceTransaction()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async simulate(@Body() rawBody: unknown): Promise<FiscalSimulationResponse> {
    if (!isFiscalPublicodesSimulationsEnabled()) {
      return unwrap<FiscalSimulationResponse>({ ok: false, error: appNotFound('fiscal_simulation_endpoint', 'disabled') });
    }
    const body = bodyOf(rawBody);

    let result: Result<FiscalSimulationResponse, AppError>;
    if (body.type === 'micro') {
      result = await this.evaluation.evaluateMicro({
        type: 'micro',
        caAnnualCents: body.caAnnualCents,
        activityNature: body.activityNature,
        acre: body.acre ?? null,
        versementLiberatoire: body.versementLiberatoire,
        date: body.date,
      });
    } else {
      result = await this.evaluation.evaluateAssimileSalarie({
        type: 'assimile',
        netMensuelCibleCents: body.netMensuelCibleCents,
        date: body.date,
      });
    }

    const response = unwrap(result);
    // Trace d'audit légère (pas de montants — la réponse elle-même en porte la trace complète) :
    // même convention que les autres actions sensibles (cf. backend.service.ts `logger.audit`).
    this.logger.audit('fiscal.simulation_computed', {
      type: response.type,
      coverage: response.coverage,
      companyId: getPrincipal()?.companyId ?? null,
    });
    return response;
  }
}

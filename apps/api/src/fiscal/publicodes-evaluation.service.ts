import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import Engine from 'publicodes';
import rules from 'modele-social';
import { type AppError, type DateOnly, type Result, err, ok } from '@bob/core';
import { AppLogger } from '../observability/logger';
import { fiscalPublicodesMaxConcurrency } from '../config/env';
import { PUBLICODES_RULE_MANIFEST, type PublicodesRuleName } from './publicodes-rule-manifest';
import { evaluateRule } from './publicodes-safe-eval';
import { buildCalculationTrace } from './fiscal-calculation-trace';
import { ConcurrencyGate } from './concurrency-gate';
import { mapAssimileSituation, mapMicroSituation } from './fiscal-situation.mapper';
import {
  PUBLICODES_RULES_VERSION,
  type AssimileSimulationInput,
  type AssimileSimulationResult,
  type CalculationTraceV1,
  type FiscalSimulationCoverage,
  type FiscalSimulationEnvelope,
  type FiscalSimulationWarning,
  type MicroSimulationInput,
  type MicroSimulationResult,
} from './fiscal-simulation.types';

const M = PUBLICODES_RULE_MANIFEST;

function validationError(field: string, message: string): AppError {
  return { kind: 'validation', issues: [{ field, message }] };
}

type EvaluatedValue = number | boolean | string | null | undefined;

function classifyCoverage(values: readonly EvaluatedValue[], missingVariablesCount: number): FiscalSimulationCoverage {
  if (values.some((v) => v === null || v === undefined)) return 'unsupported';
  return missingVariablesCount === 0 ? 'certified' : 'estimated';
}

/** Convertit une valeur Publicodes en euros vers des CENTIMES entiers (convention Money du repo). */
function toCents(value: EvaluatedValue, ruleLabel: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    // Ne devrait jamais se produire : classifyCoverage() a déjà écarté null/undefined en amont, et
    // les règles du manifeste sont toutes des agrégats monétaires — throw plutôt qu'un 0 silencieux.
    throw new Error(`PublicodesEvaluationService: valeur non numérique inattendue pour ${ruleLabel} (${JSON.stringify(value)}).`);
  }
  return Math.round(value * 100);
}

/**
 * Valide que chaque règle du manifeste EXISTE réellement dans l'`engine` fourni (`getRule` lève
 * pour une règle absente/privée). Extraite en fonction pure/testable indépendamment du cycle de
 * vie NestJS : `onModuleInit` l'utilise contre le VRAI `modele-social`, les tests unitaires
 * peuvent la rejouer contre un jeu de règles synthétique tronqué pour vérifier le comportement
 * d'échec (réserve n°1 du spike + contre-revue GPT ③).
 */
export function validatePublicodesRuleManifest(engine: Engine<PublicodesRuleName>): void {
  for (const [key, name] of Object.entries(PUBLICODES_RULE_MANIFEST)) {
    try {
      engine.getRule(name);
    } catch (cause) {
      throw new Error(
        `PublicodesEvaluationService: échec de démarrage — règle du manifeste absente/privée ` +
          `(clé « ${key} », dottedName « ${name} », ${PUBLICODES_RULES_VERSION}). ` +
          `Renommage amont probable : mets à jour publicodes-rule-manifest.ts. Cause : ${String(cause)}`,
      );
    }
  }
}

function buildEnvelope<TResult>(
  type: FiscalSimulationEnvelope<TResult>['type'],
  effectiveDate: DateOnly,
  coverage: FiscalSimulationCoverage,
  missingVariablesCount: number,
  warnings: FiscalSimulationWarning[],
  hypotheses: readonly string[],
  traces: CalculationTraceV1[],
  result: TResult,
): FiscalSimulationEnvelope<TResult> {
  return {
    type,
    rulesVersion: PUBLICODES_RULES_VERSION,
    effectiveDate,
    calculatedAt: new Date().toISOString(),
    coverage,
    missingVariablesCount,
    warnings,
    hypotheses,
    traces,
    result,
  };
}

/**
 * Singleton Engine Publicodes chargé au boot (SPIKE_PUBLICODES_20260715.md §4 : ~150 ms/17 MB une
 * fois par process). Provider NestJS singleton (scope par défaut) — `shallowCopy()` SYSTÉMATIQUE
 * par requête, jamais `setSituation()` sur l'instance partagée (mutation en place).
 */
@Injectable()
export class PublicodesEvaluationService implements OnModuleInit {
  private engine!: Engine<PublicodesRuleName>;
  private readonly gate = new ConcurrencyGate(fiscalPublicodesMaxConcurrency());
  private readonly warningsStore = new AsyncLocalStorage<string[]>();
  private bootMs = 0;

  constructor(private readonly logger: AppLogger) {}

  /** Temps de boot mesuré (ms) — exposé pour diagnostic/tests, documenté dans le rapport de la tâche. */
  getBootMs(): number {
    return this.bootMs;
  }

  async onModuleInit(): Promise<void> {
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    this.engine = new Engine<PublicodesRuleName>(rules, {
      logger: {
        log: () => {},
        warn: (message: string) => this.onEngineWarn(message),
        error: (message: string) => this.logger.error(message, undefined, 'PublicodesEvaluationService'),
      },
    });
    this.bootMs = performance.now() - t0;
    const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);

    // Validation manifeste AU BOOT (réserve n°1 du spike + contre-revue GPT ③) : un renommage de
    // règle amont qui échapperait à la garde de compilation (`satisfies` sur le manifeste, ex. si
    // `modele-social` est mis à jour sans régénérer les types localement) fait échouer le
    // DÉMARRAGE du process ici, jamais un calcul silencieusement faux en production.
    validatePublicodesRuleManifest(this.engine);
    const manifestEntries = Object.entries(PUBLICODES_RULE_MANIFEST);

    this.logger.log(
      `PublicodesEvaluationService démarré : ${this.bootMs.toFixed(1)} ms, ` +
        `+${heapDeltaMb.toFixed(1)} MB heap, ${manifestEntries.length} règles du manifeste validées ` +
        `(${PUBLICODES_RULES_VERSION}).`,
      'PublicodesEvaluationService',
    );
  }

  private onEngineWarn(message: string): void {
    const bucket = this.warningsStore.getStore();
    if (bucket) {
      bucket.push(message);
      return;
    }
    // Hors d'un cycle de requête suivi (ex. avertissement émis pendant le boot) : log direct.
    this.logger.warn(message, 'PublicodesEvaluationService');
  }

  private collectWarnings(missingVariablesCount: number, engineWarnings: string[], inversionFail: boolean): FiscalSimulationWarning[] {
    const warnings: FiscalSimulationWarning[] = [];
    if (missingVariablesCount > 0) {
      warnings.push({
        code: 'missing_variable',
        message:
          `${missingVariablesCount} donnée(s) non renseignée(s) par Bob (ex. département, historique ` +
          "d'activité) — le référentiel officiel applique ses hypothèses par défaut sur ces points : " +
          'considère ce résultat comme une ESTIMATION, pas un montant certifié.',
      });
    }
    for (const message of engineWarnings) {
      warnings.push({
        code: message.toLowerCase().includes('experimental') ? 'experimental_rule' : 'engine_warning',
        message,
      });
    }
    if (inversionFail) {
      warnings.push({
        code: 'inversion_fail',
        message:
          "L'inversion numérique (net → brut) n'a pas convergé avec la précision attendue — " +
          'résultat à considérer comme approximatif.',
      });
    }
    return warnings;
  }

  async evaluateMicro(input: MicroSimulationInput): Promise<Result<FiscalSimulationEnvelope<MicroSimulationResult>, AppError>> {
    const mapped = mapMicroSituation(input);
    if (!mapped.ok) return mapped;
    const { situation, hypotheses } = mapped.value;

    return this.gate.run(() =>
      this.warningsStore.run([], () => {
        const engine = this.engine.shallowCopy();
        engine.setSituation(situation);

        const cotis = evaluateRule(engine, M.microCotisations);
        const revenuNet = evaluateRule(engine, M.microRevenuNet);

        const traces = [buildCalculationTrace(engine, M.microCotisations), buildCalculationTrace(engine, M.microRevenuNet)];
        if (input.acre != null && input.acre.granted) {
          traces.push(buildCalculationTrace(engine, M.microTauxAcre));
        }

        const missing = new Set([
          ...Object.keys(cotis.missingVariables ?? {}),
          ...Object.keys(revenuNet.missingVariables ?? {}),
        ]);
        const coverage = classifyCoverage([cotis.nodeValue, revenuNet.nodeValue], missing.size);
        if (coverage === 'unsupported') {
          return err(
            validationError(
              'result',
              'Le moteur Publicodes ne produit pas de valeur exploitable pour cette situation ' +
                '("non applicable"/"non défini") — zone de trou de couverture connue.',
            ),
          );
        }

        const cotisationsCentsPerMonth = toCents(cotis.nodeValue, M.microCotisations);
        const revenuNetCentsPerYear = toCents(revenuNet.nodeValue, M.microRevenuNet);
        const tauxEffectifPct =
          input.caAnnualCents > 0
            ? Math.round(((cotisationsCentsPerMonth * 12) / input.caAnnualCents) * 1000) / 10
            : 0;

        const warnings = this.collectWarnings(missing.size, this.warningsStore.getStore() ?? [], false);

        return ok(
          buildEnvelope<MicroSimulationResult>('micro', input.date, coverage, missing.size, warnings, hypotheses, traces, {
            cotisationsCentsPerMonth,
            revenuNetCentsPerYear,
            tauxEffectifPct,
          }),
        );
      }),
    );
  }

  async evaluateAssimileSalarie(
    input: AssimileSimulationInput,
  ): Promise<Result<FiscalSimulationEnvelope<AssimileSimulationResult>, AppError>> {
    const mapped = mapAssimileSituation(input);
    if (!mapped.ok) return mapped;
    const { situation, hypotheses } = mapped.value;

    return this.gate.run(() =>
      this.warningsStore.run([], () => {
        const engine = this.engine.shallowCopy();
        engine.setSituation(situation);

        // Inversion numérique net -> brut (SPIKE_PUBLICODES_20260715.md §4, cas SASU) : mesurée à
        // ~41 ms/évaluation (N=50, engine chaud) — nettement plus coûteuse que le cas micro
        // (~5 ms), d'où la porte de concurrence (cf. concurrency-gate.ts).
        const brut = evaluateRule(engine, M.salaireBrut);
        const coutTotal = evaluateRule(engine, M.coutTotalEmployeur);
        const inversionFail = engine.inversionFail();

        const traces = [buildCalculationTrace(engine, M.salaireBrut), buildCalculationTrace(engine, M.coutTotalEmployeur)];

        const missing = new Set([
          ...Object.keys(brut.missingVariables ?? {}),
          ...Object.keys(coutTotal.missingVariables ?? {}),
        ]);
        const coverage = classifyCoverage([brut.nodeValue, coutTotal.nodeValue], missing.size);
        if (coverage === 'unsupported') {
          return err(
            validationError(
              'result',
              'Le moteur Publicodes ne produit pas de valeur exploitable pour cette situation ' +
                '("non applicable"/"non défini") — zone de trou de couverture connue.',
            ),
          );
        }

        const warnings = this.collectWarnings(missing.size, this.warningsStore.getStore() ?? [], inversionFail);

        return ok(
          buildEnvelope<AssimileSimulationResult>(
            'assimile',
            input.date,
            coverage,
            missing.size,
            warnings,
            hypotheses,
            traces,
            {
              brutMensuelCents: toCents(brut.nodeValue, M.salaireBrut),
              coutTotalEmployeurCents: toCents(coutTotal.nodeValue, M.coutTotalEmployeur),
              inversionFail,
            },
          ),
        );
      }),
    );
  }
}

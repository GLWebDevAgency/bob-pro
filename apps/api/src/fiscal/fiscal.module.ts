import { Module } from '@nestjs/common';
import { FiscalSimulationController } from './fiscal-simulation.controller';
import { PublicodesEvaluationService } from './publicodes-evaluation.service';

/**
 * BOB EXPERT FISCAL — module dédié (pattern des features récentes : cabinet/, voice/realtime/),
 * pas ajouté au fourre-tout api.controllers.ts/backend.service.ts. `PublicodesEvaluationService`
 * est un singleton NestJS (scope par défaut) : un seul `Engine` chargé au boot du process
 * (`onModuleInit`), partagé par toutes les requêtes via `shallowCopy()`.
 */
@Module({
  controllers: [FiscalSimulationController],
  providers: [PublicodesEvaluationService],
})
export class FiscalModule {}

import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { AppLogger } from './logger';
import { Metrics } from './metrics';
import { ERROR_REPORTER, errorReporterProvider } from './error-reporter';
import { ANALYTICS, analyticsProvider } from './analytics';
import { LoggingInterceptor } from './logging.interceptor';
import { AllExceptionsFilter } from './exception.filter';
import { MetricsController } from './metrics.controller';

@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    AppLogger,
    Metrics,
    errorReporterProvider,
    analyticsProvider,
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  // ERROR_REPORTER est EXPORTÉ : le module est @Global, mais un token non exporté reste
  // invisible aux autres modules. Sans lui, tout provider déclaré hors d'ici et injectant le
  // rapporteur d'incidents fait ÉCHOUER LE BOOT (constaté au boot rituel du 20/07 :
  // VoiceTraceRecorder, argument [2] introuvable) — un défaut d'injection qu'aucun test
  // unitaire ne voit, puisqu'ils câblent eux-mêmes leurs dépendances.
  exports: [AppLogger, Metrics, ANALYTICS, ERROR_REPORTER],
})
export class ObservabilityModule {}

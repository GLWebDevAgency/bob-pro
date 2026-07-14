import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { AppLogger } from './logger';
import { Metrics } from './metrics';
import { errorReporterProvider } from './error-reporter';
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
  exports: [AppLogger, Metrics, ANALYTICS],
})
export class ObservabilityModule {}

import { Module, type NestModule, type MiddlewareConsumer } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { BackendService } from './backend.service';
import { PersistenceModule } from './persistence/persistence.module';
import { ObservabilityModule } from './observability/observability.module';
import { CorrelationMiddleware } from './observability/correlation.middleware';
import { SupabaseAuthGuard } from './auth/auth.guard';
import {
  HealthController,
  CustomersController,
  CashflowController,
  QuotesController,
  InvoicesController,
  AiController,
} from './api.controllers';

@Module({
  imports: [ObservabilityModule, PersistenceModule],
  controllers: [
    HealthController,
    CustomersController,
    CashflowController,
    QuotesController,
    InvoicesController,
    AiController,
  ],
  providers: [BackendService, { provide: APP_GUARD, useClass: SupabaseAuthGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}

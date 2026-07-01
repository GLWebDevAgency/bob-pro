import { Module, type NestModule, type MiddlewareConsumer } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { BackendService } from './backend.service';
import { PersistenceModule } from './persistence/persistence.module';
import { ObservabilityModule } from './observability/observability.module';
import { CorrelationMiddleware } from './observability/correlation.middleware';
import { paymentGatewayProvider } from './payments/payment-gateway';
import { PDF_RENDERER, PdfRenderer } from './documents/pdf-renderer';
import { ocrProvider } from './ocr/ocr';
import { NOTIFIER, DemoNotifier } from './notifications/notifier';
import { RelanceService } from './jobs/relance.service';
import { SupabaseAuthGuard } from './auth/auth.guard';
import { TenantPersistenceInterceptor } from './persistence/tenant-persistence.interceptor';
import {
  HealthController,
  CustomersController,
  CashflowController,
  QuotesController,
  InvoicesController,
  AiController,
  VoiceController,
  SubscriptionController,
  JobsController,
  OnboardingController,
  DiagnosticController,
  ProfileController,
  CompanyLookupController,
  VatController,
  AddressController,
  DocumentsController,
  ExpensesController,
  ChantiersController,
  PublicSignatureController,
} from './api.controllers';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    ObservabilityModule,
    PersistenceModule,
  ],
  controllers: [
    HealthController,
    CustomersController,
    CashflowController,
    QuotesController,
    InvoicesController,
    AiController,
    VoiceController,
    SubscriptionController,
    JobsController,
    OnboardingController,
    DiagnosticController,
    ProfileController,
    CompanyLookupController,
    VatController,
    AddressController,
    DocumentsController,
    ExpensesController,
    ChantiersController,
    PublicSignatureController,
  ],
  providers: [
    BackendService,
    RelanceService,
    paymentGatewayProvider,
    ocrProvider,
    { provide: PDF_RENDERER, useClass: PdfRenderer },
    { provide: NOTIFIER, useClass: DemoNotifier },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: SupabaseAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantPersistenceInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}

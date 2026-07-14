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
import { documentIntelligenceProvider } from './documents/document-intelligence';
import { notifierProvider } from './notifications/notifier';
import { expoPushProvider } from './notifications/expo-push';
import { NotificationsApiService } from './notifications/notifications-api.service';
import { RelanceService } from './jobs/relance.service';
import { DigestService } from './jobs/digest.service';
import { DocumentArchiveService } from './jobs/document-archive.service';
import { NotificationDeliveryService } from './jobs/notification-delivery.service';
import { ScheduledTenantDirectory } from './jobs/tenant-directory';
import { SupabaseAuthGuard } from './auth/auth.guard';
import { supabaseAdminProvider } from './auth/supabase-admin';
import { TenantPersistenceInterceptor } from './persistence/tenant-persistence.interceptor';
import { CabinetController } from './cabinet/cabinet.controller';
import { CabinetApiService } from './cabinet/cabinet-api.service';
import { CabinetInvitationDeliveryScheduler } from './cabinet/cabinet-invitation-delivery.scheduler';
import { RealtimeVoiceModule } from './voice/realtime/realtime.module';
import {
  HealthController,
  CustomersController,
  CashflowController,
  QuotesController,
  InvoicesController,
  AccountingController,
  AiController,
  VoiceController,
  SubscriptionController,
  JobsController,
  OnboardingController,
  DiagnosticController,
  FiscalCalendarController,
  ProfileController,
  CompanyLookupController,
  VatController,
  AddressController,
  DocumentsController,
  DocumentFoldersController,
  DocumentFolderDeletionPlansController,
  ExpensesController,
  PaymentsController,
  ChantiersController,
  PublicSignatureController,
  NotificationsController,
  DevicesController,
 EngagementController } from './api.controllers';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    ObservabilityModule,
    PersistenceModule,
    RealtimeVoiceModule,
  ],
  controllers: [
    HealthController,
    CustomersController,
    CashflowController,
    QuotesController,
    InvoicesController,
    AccountingController,
    AiController,
    VoiceController,
    SubscriptionController,
    EngagementController,
    JobsController,
    OnboardingController,
    DiagnosticController,
    FiscalCalendarController,
    ProfileController,
    CompanyLookupController,
    VatController,
    AddressController,
    DocumentsController,
    DocumentFoldersController,
    DocumentFolderDeletionPlansController,
    ExpensesController,
    PaymentsController,
    ChantiersController,
    PublicSignatureController,
    NotificationsController,
    DevicesController,
    CabinetController,
  ],
  providers: [
    BackendService,
    RelanceService,
    DigestService,
    DocumentArchiveService,
    NotificationDeliveryService,
    ScheduledTenantDirectory,
    paymentGatewayProvider,
    ocrProvider,
    documentIntelligenceProvider,
    { provide: PDF_RENDERER, useClass: PdfRenderer },
    notifierProvider,
    expoPushProvider,
    supabaseAdminProvider,
    NotificationsApiService,
    CabinetApiService,
    CabinetInvitationDeliveryScheduler,
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

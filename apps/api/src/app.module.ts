import { Module, type NestModule, type MiddlewareConsumer } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { BackendService } from './backend.service';
import { PersistenceModule } from './persistence/persistence.module';
import { ObservabilityModule } from './observability/observability.module';
import { CorrelationMiddleware } from './observability/correlation.middleware';
import { paymentGatewayProvider } from './payments/payment-gateway';
import { StripeBillingService } from './payments/stripe-billing.service';
import { StripeWebhookController } from './payments/stripe-webhook.controller';
import { PDF_RENDERER, PdfRenderer } from './documents/pdf-renderer';
import { DOCUMENT_STORAGE, buildDocumentStorage } from './documents/storage';
import { ocrProvider } from './ocr/ocr';
import { documentIntelligenceProvider } from './documents/document-intelligence';
import { notifierProvider } from './notifications/notifier';
import { expoPushProvider } from './notifications/expo-push';
import { NotificationsApiService } from './notifications/notifications-api.service';
import { createApiThrottlerOptions } from './notifications/push-revocation-throttle';
import { RelanceService } from './jobs/relance.service';
import { DigestService } from './jobs/digest.service';
import { DocumentArchiveService } from './jobs/document-archive.service';
import { NotificationDeliveryService } from './jobs/notification-delivery.service';
import { ScheduledTenantDirectory } from './jobs/tenant-directory';
import { VoiceTracePurgeService } from './jobs/voice-trace-purge.service';
import { VoiceTraceRecorder, voiceTraceRecorderProvider } from './voice/voice-trace.recorder';
import { SupabaseAuthGuard } from './auth/auth.guard';
import { supabaseAdminProvider } from './auth/supabase-admin';
import { TenantPersistenceInterceptor } from './persistence/tenant-persistence.interceptor';
import { CabinetController } from './cabinet/cabinet.controller';
import { CabinetApiService } from './cabinet/cabinet-api.service';
import { CabinetInvitationDeliveryScheduler } from './cabinet/cabinet-invitation-delivery.scheduler';
import { RealtimeVoiceModule } from './voice/realtime/realtime.module';
import { FiscalModule } from './fiscal/fiscal.module';
import { QuoteDraftController } from './quotes/quote-draft.controller';
import { QuoteDraftService } from './quotes/quote-draft.service';
import { DiagnosticAssessmentController } from './diagnostic/diagnostic-assessment.controller';
import { DiagnosticAssessmentService } from './diagnostic/diagnostic-assessment.service';
import { AgentMissionModule } from './agent-missions/agent-mission.module';
import {
  HealthController,
  CustomersController,
  CashflowController,
  BankBalanceController,
  QuotesController,
  InvoicesController,
  AccountingController,
  AiController,
  VoiceController,
  SubscriptionController,
  JobsController,
  OnboardingController,
  AccountController,
  DiagnosticController,
  FiscalCalendarController,
  FiscalProfileController,
  ProfileController,
  CompanyLookupController,
  VatController,
  AddressController,
  DocumentsController,
  DocumentFoldersController,
  DocumentFolderDeletionPlansController,
  ExpensesController,
  PaymentsController,
  CatalogueController,
  ChantiersController,
  PublicSignatureController,
  PublicDocumentViewController,
  PublicRetractationController,
  NotificationsController,
  DevicesController,
  PublicPushRevocationsController,
  EngagementController,
} from './api.controllers';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot(createApiThrottlerOptions()),
    ObservabilityModule,
    PersistenceModule,
    RealtimeVoiceModule,
    FiscalModule,
    AgentMissionModule,
  ],
  controllers: [
    HealthController,
    CustomersController,
    CashflowController,
    BankBalanceController,
    QuotesController,
    InvoicesController,
    AccountingController,
    AiController,
    VoiceController,
    SubscriptionController,
    EngagementController,
    JobsController,
    OnboardingController,
    AccountController,
    DiagnosticController,
    FiscalCalendarController,
    FiscalProfileController,
    ProfileController,
    CompanyLookupController,
    VatController,
    AddressController,
    DocumentsController,
    DocumentFoldersController,
    DocumentFolderDeletionPlansController,
    ExpensesController,
    PaymentsController,
    CatalogueController,
    ChantiersController,
    PublicSignatureController,
    PublicDocumentViewController,
    PublicRetractationController,
    NotificationsController,
    DevicesController,
    PublicPushRevocationsController,
    QuoteDraftController,
    CabinetController,
    DiagnosticAssessmentController,
    StripeWebhookController,
  ],
  providers: [
    BackendService,
    RelanceService,
    DigestService,
    DocumentArchiveService,
    NotificationDeliveryService,
    ScheduledTenantDirectory,
    // Traçage du comportement vocal (bêta-test) : l'enregistreur est injecté dans
    // BackendService (chemin vocal réel) et la purge honore la rétention de 30 jours.
    // Les deux sont enregistrés inconditionnellement — c'est VOICE_TRACE_ENABLED, et lui seul,
    // qui décide si une ligne est écrite.
    VoiceTraceRecorder,
    voiceTraceRecorderProvider,
    VoiceTracePurgeService,
    paymentGatewayProvider,
    ocrProvider,
    documentIntelligenceProvider,
    { provide: PDF_RENDERER, useClass: PdfRenderer },
    { provide: DOCUMENT_STORAGE, useFactory: buildDocumentStorage },
    notifierProvider,
    expoPushProvider,
    supabaseAdminProvider,
    NotificationsApiService,
    CabinetApiService,
    CabinetInvitationDeliveryScheduler,
    QuoteDraftService,
    DiagnosticAssessmentService,
    StripeBillingService,
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

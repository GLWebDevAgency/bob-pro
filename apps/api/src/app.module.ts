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
import { CustomerUpdateModule } from './customers/customer-update.module';
import { ocrProvider } from './ocr/ocr';
import { documentIntelligenceProvider } from './documents/document-intelligence';
import { notifierProvider } from './notifications/notifier';
import { expoPushProvider } from './notifications/expo-push';
import { NotificationsApiService } from './notifications/notifications-api.service';
import { createApiThrottlerOptions } from './notifications/push-revocation-throttle';
import { RelanceService } from './jobs/relance.service';
import { TransmissionReminderService } from './jobs/transmission-reminder.service';
import { QuoteFollowupService } from './jobs/quote-followup.service';
import { ContractRenewalService } from './jobs/contract-renewal.service';
import { DigestService } from './jobs/digest.service';
import { DocumentArchiveService } from './jobs/document-archive.service';
import { NotificationDeliveryService } from './jobs/notification-delivery.service';
import { JarvisWorkItemDispatchService } from './jobs/jarvis-work-item-dispatch.service';
import { JarvisProposalPayloadPurgeService } from './jobs/jarvis-proposal-payload-purge.service';
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
import { JarvisModule } from './jarvis/jarvis.module';
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
  EquipmentsController,
  MaintenanceContractsController,
  InterventionsController,
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
    CustomerUpdateModule,
    RealtimeVoiceModule,
    FiscalModule,
    AgentMissionModule,
    // Vertical Jarvis (U1-d) : il possède ses providers — AppModule n'en recopie aucun. Ses
    // exports (admission, registre d'exécuteurs) alimentent le worker de dispatch déclaré ici.
    JarvisModule,
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
    EquipmentsController,
    MaintenanceContractsController,
    InterventionsController,
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
    TransmissionReminderService,
    QuoteFollowupService,
    ContractRenewalService,
    DigestService,
    DocumentArchiveService,
    NotificationDeliveryService,
    // Jarvis U1-c (§5.3) : worker de dispatch des work items. Ses autorités (annuaire, repository
    // sous GUC, UoW d'admission) sont des tokens @Optional non liés dans cette tranche — tick
    // no-op fail-closed audité tant que les callers U1-d ne fournissent pas les liaisons.
    JarvisWorkItemDispatchService,
    // Jarvis U1-d (§5.5) : rétention du magasin PII des propositions. Enregistré
    // INCONDITIONNELLEMENT — comme la purge des traces vocales, on n'écrit du PII que si le
    // balayage qui l'efface tourne aussi. Sans son annuaire de propriétaires (autorité serveur
    // bornée, lot suivant), le tick est un no-op AUDITÉ : rien n'est perdu, rien n'est promis.
    JarvisProposalPayloadPurgeService,
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

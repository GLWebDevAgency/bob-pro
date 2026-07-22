import type {
  AccountingEntryRepository,
  BankBalanceSnapshotRepository,
  CashMovementProjectionPort,
  CatalogueRepository,
  ChantierRepository,
  ChantierNoteRepository,
  ChartOfAccountsRepository,
  CompanyRepository,
  Company,
  CompanyBillingSettingsRepository,
  DiagnosticAssessmentRepository,
  CustomerRepository,
  DocumentFolderRepository,
  DocumentRepository,
  ExpenseRepository,
  FiscalProfileRepository,
  InvoiceRepository,
  Invoice,
  Payment,
  PaymentRepository,
  PublicAccessTokenRepository,
  PublicAccessGrant,
  Quote,
  QuoteDraftSlotRepository,
  QuoteRepository,
  SalesDocumentSearchPort,
  SequenceCounterPort,
  SubscriptionRepository,
  WorksiteMediaStorage,
} from '@bob/core';
import type { CabinetInfrastructure } from '../cabinet/cabinet-infrastructure';
import type { DocumentFolderDeletionPlanStore } from '../documents/document-folder-deletion-plan';
import type {
  MistralRealtimeIngressIdentityKeyRing,
  MistralRealtimeIngressTicketAuthority,
  MistralRealtimeIngressTicketPolicy,
} from '../voice/realtime/realtime-mistral-ingress-ticket';
import type {
  RealtimeAdmissionPolicy,
  RealtimeAdmissionPort,
} from '../voice/realtime/realtime-admission';
import type { MistralConversationPersistenceKeyRing } from '../voice/realtime/mistral-conversation-outbox-seal';
import type { MistralConversationTerminalReplayAuthorities } from '../voice/realtime/mistral-conversation-terminal-replay';
import type { MistralConversationAdmissionPolicy } from '../voice/realtime/mistral-conversation-admission';
import type { MistralConversationBootstrapReaperPort } from '../voice/realtime/mistral-conversation-bootstrap-reaper';
import type { BobLiveSubjectHmacKeyRingAdmission } from '../voice/realtime/mistral-conversation-subject-key-version';
import type { RealtimeControlRepositoryPort } from '../voice/realtime/realtime-control.repository';
import type { RealtimeSidebandOwnerPort } from '../voice/realtime/realtime-sideband-owner';
import type { RealtimeSpeechDeliveryRepositoryPort } from '../voice/realtime/realtime-speech-delivery.repository';
import type { RealtimeSpeechArtifactRepositoryPort } from '../voice/realtime/realtime-speech-publisher';
import type { RealtimeVoiceUsageRepositoryPort } from '../voice/realtime/realtime-voice-usage';
import type { OpenAiNativeSpeechMaintenancePort } from '../voice/realtime/openai-native-speech-maintenance';
import type { AgentJournalRepository } from './agent-journal';
import type { DeviceRepository } from './devices';
import type { DocumentAnalysisStore } from './document-analyses';
import type { DocumentArchiveJobRepository } from './document-archive-jobs';
import type { ExpenseCreationRequestStore } from './expense-creation-requests';
import type { NotificationJobRepository } from './notification-jobs';
import type { QuoteCreationRequestStore } from './quote-creation-requests';
import type { SupplierMemoryRepository } from './supplier-memory';
import type { VoiceTraceRepository } from './voice-traces';

export { PERSISTENCE } from './persistence-token';

/** E3 : encaissements datés du tenant, sans élargir le port core générique. */
export interface ServerPaymentRepository extends PaymentRepository {
  listByCompany(companyId: string): Promise<Payment[]>;
}

export type CompanyCreateIfAbsentResult = 'created' | 'existing' | 'identity_conflict';

/**
 * Écriture serveur create-only de l'identité légale. L'onboarding n'a jamais le droit de passer
 * par `save`, car un retry doit réparer les dépendances sans écraser la première fiche acceptée.
 */
export interface ServerCompanyRepository extends CompanyRepository {
  createIfAbsentOpen(company: Company): Promise<CompanyCreateIfAbsentResult>;
}

/** Verrou partagé réservé aux lectures publiques linéarisables avec rotation/clôture. */
export interface ServerQuoteRepository extends QuoteRepository {
  lockForShareById(id: string): Promise<Quote | null>;
}

export interface ServerInvoiceRepository extends InvoiceRepository {
  lockForShareById(id: string): Promise<Invoice | null>;
}

export interface ServerPublicAccessTokenRepository extends PublicAccessTokenRepository {
  /** Revalide et verrouille le grant exact dans la transaction d'utilisation publique. */
  lockActive(token: string, at: string): Promise<PublicAccessGrant | null>;
}

/**
 * Contrat de persistance du runtime API. Ce fichier ne contient aucune implémentation ou fixture :
 * Nest injecte uniquement PrismaPersistence; les doubles résident dans persistence.testing.ts,
 * exclu de l'artefact de production.
 */
export interface Persistence {
  companies: ServerCompanyRepository;
  billingSettings: CompanyBillingSettingsRepository;
  diagnosticAssessments: DiagnosticAssessmentRepository;
  customers: CustomerRepository;
  quotes: ServerQuoteRepository;
  invoices: ServerInvoiceRepository;
  documents: DocumentRepository;
  documentAnalyses: DocumentAnalysisStore;
  documentFolders: DocumentFolderRepository;
  documentFolderDeletionPlans: DocumentFolderDeletionPlanStore;
  documentArchiveJobs: DocumentArchiveJobRepository;
  notificationJobs: NotificationJobRepository;
  devices: DeviceRepository;
  payments: ServerPaymentRepository;
  publicAccessTokens: ServerPublicAccessTokenRepository;
  expenses: ExpenseRepository;
  catalogue: CatalogueRepository;
  chantiers: ChantierRepository;
  chantierNotes: ChantierNoteRepository;
  worksiteMedia: WorksiteMediaStorage;
  expenseCreationRequests: ExpenseCreationRequestStore;
  quoteCreationRequests: QuoteCreationRequestStore;
  quoteDraftSlots: QuoteDraftSlotRepository;
  accountingEntries: AccountingEntryRepository;
  chartOfAccounts: ChartOfAccountsRepository;
  agentJournal: AgentJournalRepository;
  /** Traçage du comportement vocal (bêta-test). Dormant sans VOICE_TRACE_ENABLED. */
  voiceTraces: VoiceTraceRepository;
  supplierMemory: SupplierMemoryRepository;
  subscriptions: SubscriptionRepository;
  bankBalances: BankBalanceSnapshotRepository;
  /** Projection LECTURE SEULE des mouvements postérieurs à l'observation bancaire
   *  (encaissements + règlements de dépenses) — alimente la position de trésorerie. */
  cashMovements: CashMovementProjectionPort;
  fiscalProfiles: FiscalProfileRepository;
  salesDocumentSearch: SalesDocumentSearchPort;
  counters: SequenceCounterPort;
  cabinet: CabinetInfrastructure;
  createRealtimeAdmission(policy: RealtimeAdmissionPolicy): RealtimeAdmissionPort;
  createRealtimeSpeechDeliveryRepository(): RealtimeSpeechDeliveryRepositoryPort;
  createRealtimeSidebandOwner(): RealtimeSidebandOwnerPort;
  createRealtimeSpeechArtifactRepository(): RealtimeSpeechArtifactRepositoryPort;
  createRealtimeVoiceUsageRepository(): RealtimeVoiceUsageRepositoryPort;
  createRealtimeControlRepository(): RealtimeControlRepositoryPort;
  /** Capacité DB-only séparée des repositories request-time de Bob Live. */
  createOpenAiNativeSpeechMaintenance(): OpenAiNativeSpeechMaintenancePort;
  createMistralRealtimeIngressTicketAuthority(
    policy: MistralRealtimeIngressTicketPolicy,
    identityKeys: MistralRealtimeIngressIdentityKeyRing,
  ): MistralRealtimeIngressTicketAuthority;
  /**
   * Factory serveur uniquement. `null` signifie que l'adapter de persistance ne sait pas fournir
   * l'autorité PostgreSQL réelle ; l'appelant doit alors refuser le démarrage du canary v2.
   */
  createMistralConversationTerminalReplayAuthorities(
    keys: MistralConversationPersistenceKeyRing,
    identityKeys: MistralRealtimeIngressIdentityKeyRing | null,
    subjectKeys: BobLiveSubjectHmacKeyRingAdmission,
    admissionPolicy: MistralConversationAdmissionPolicy,
  ): MistralConversationTerminalReplayAuthorities | null;
  /**
   * Canal global de rétention. `null` est accepté uniquement lorsque le replay v2 est désactivé ;
   * la composition Nest refuse sinon de démarrer.
   */
  createMistralConversationBootstrapReaper(): MistralConversationBootstrapReaperPort | null;
  runInTransaction<T>(fn: () => Promise<T>): Promise<T>;
  runWithTenant<T>(companyId: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Écriture d'OBSERVATION détachée de la transaction de requête (traçage vocal) : elle ne peut
   * ni avorter, ni être avortée par, la conversation qu'elle observe.
   */
  runDetachedWithTenant<T>(companyId: string, fn: () => Promise<T>): Promise<T>;
  runWithIdentity<T>(userId: string, fn: () => Promise<T>): Promise<T>;
  runWithCabinet<T>(userId: string, cabinetId: string, fn: () => Promise<T>): Promise<T>;
  runWithCabinetInvitation<T>(
    userId: string,
    verifiedEmail: string,
    tokenHash: string,
    fn: () => Promise<T>,
  ): Promise<T>;
}

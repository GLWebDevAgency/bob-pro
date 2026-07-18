import type {
  AccountingEntryRepository,
  BankBalanceSnapshotRepository,
  CatalogueRepository,
  ChantierRepository,
  ChantierNoteRepository,
  ChartOfAccountsRepository,
  CompanyRepository,
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
import type { RealtimeControlRepositoryPort } from '../voice/realtime/realtime-control.repository';
import type { RealtimeSidebandOwnerPort } from '../voice/realtime/realtime-sideband-owner';
import type { RealtimeSpeechDeliveryRepositoryPort } from '../voice/realtime/realtime-speech-delivery.repository';
import type { RealtimeSpeechArtifactRepositoryPort } from '../voice/realtime/realtime-speech-publisher';
import type { RealtimeVoiceUsageRepositoryPort } from '../voice/realtime/realtime-voice-usage';
import type { AgentJournalRepository } from './agent-journal';
import type { DeviceRepository } from './devices';
import type { DocumentAnalysisStore } from './document-analyses';
import type { DocumentArchiveJobRepository } from './document-archive-jobs';
import type { ExpenseCreationRequestStore } from './expense-creation-requests';
import type { NotificationJobRepository } from './notification-jobs';
import type { QuoteCreationRequestStore } from './quote-creation-requests';
import type { SupplierMemoryRepository } from './supplier-memory';

export { PERSISTENCE } from './persistence-token';

/** E3 : encaissements datés du tenant, sans élargir le port core générique. */
export interface ServerPaymentRepository extends PaymentRepository {
  listByCompany(companyId: string): Promise<Payment[]>;
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
  companies: CompanyRepository;
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
  supplierMemory: SupplierMemoryRepository;
  subscriptions: SubscriptionRepository;
  bankBalances: BankBalanceSnapshotRepository;
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
  createMistralRealtimeIngressTicketAuthority(
    policy: MistralRealtimeIngressTicketPolicy,
    identityKeys: MistralRealtimeIngressIdentityKeyRing,
  ): MistralRealtimeIngressTicketAuthority;
  runInTransaction<T>(fn: () => Promise<T>): Promise<T>;
  runWithTenant<T>(companyId: string, fn: () => Promise<T>): Promise<T>;
  runWithIdentity<T>(userId: string, fn: () => Promise<T>): Promise<T>;
  runWithCabinet<T>(userId: string, cabinetId: string, fn: () => Promise<T>): Promise<T>;
  runWithCabinetInvitation<T>(
    userId: string,
    verifiedEmail: string,
    tokenHash: string,
    fn: () => Promise<T>,
  ): Promise<T>;
}

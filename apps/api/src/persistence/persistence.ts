import { AsyncLocalStorage } from 'node:async_hooks';
import {
  seedCompany,
  seedCustomers,
  DocumentFolder,
  DEFAULT_DOCUMENT_FOLDERS,
  type CompanyRepository,
  type CustomerRepository,
  type QuoteRepository,
  type InvoiceRepository,
  type DocumentRepository,
  type DocumentFolderRepository,
  type Payment,
  type PaymentRepository,
  type PublicAccessTokenRepository,
  type ExpenseRepository,
  type AccountingEntryRepository,
  type ChartOfAccountsRepository,
  type SequenceCounterPort,
  type SubscriptionRepository,
  type FiscalProfileRepository,
} from '@bob/core';
import type { DocumentArchiveJobRepository } from './document-archive-jobs';
import type { NotificationJobRepository } from './notification-jobs';
import type { DeviceRepository } from './devices';
import type { AgentJournalRepository } from './agent-journal';
import { InMemoryAgentJournalRepository } from './agent-journal';
import type { SupplierMemoryRepository } from './supplier-memory';
import { InMemorySupplierMemoryRepository } from './supplier-memory';
import { InMemorySubscriptionRepository } from './subscriptions';
import { InMemoryFiscalProfileRepository } from './fiscal-profiles';
import type { CabinetInfrastructure } from '../cabinet/cabinet-infrastructure';
import type { DocumentFolderDeletionPlanStore } from '../documents/document-folder-deletion-plan';
import { MemoryCabinetInfrastructure } from '../cabinet/memory-cabinet-infrastructure';
import { InMemoryDocumentFolderDeletionPlanStore } from './document-folder-deletion-plans';
import type { DocumentAnalysisStore } from './document-analyses';
import { InMemoryDocumentAnalysisStore } from './document-analyses';
import type { ExpenseCreationRequestStore } from './expense-creation-requests';
import { InMemoryExpenseCreationRequestStore } from './expense-creation-requests';
import type { QuoteCreationRequestStore } from './quote-creation-requests';
import { InMemoryQuoteCreationRequestStore } from './quote-creation-requests';
import {
  InMemoryRealtimeAdmission,
  type RealtimeAdmissionPolicy,
  type RealtimeAdmissionPort,
} from '../voice/realtime/realtime-admission';
import {
  DisabledRealtimeSpeechDeliveryRepository,
  type RealtimeSpeechDeliveryRepositoryPort,
} from '../voice/realtime/realtime-speech-delivery.repository';
import {
  DisabledRealtimeSidebandOwner,
  type RealtimeSidebandOwnerPort,
} from '../voice/realtime/realtime-sideband-owner';
import { DisabledRealtimeSpeechArtifactRepository } from '../voice/realtime/realtime-speech-artifact.repository';
import type { RealtimeSpeechArtifactRepositoryPort } from '../voice/realtime/realtime-speech-publisher';
import {
  DisabledRealtimeVoiceUsageRepository,
  type RealtimeVoiceUsageRepositoryPort,
} from '../voice/realtime/realtime-voice-usage';
import {
  DisabledMistralRealtimeIngressTicketAuthority,
  type MistralRealtimeIngressIdentityKeyRing,
  type MistralRealtimeIngressTicketAuthority,
  type MistralRealtimeIngressTicketPolicy,
} from '../voice/realtime/realtime-mistral-ingress-ticket';
import {
  DisabledRealtimeControlRepository,
  type RealtimeControlRepositoryPort,
} from '../voice/realtime/realtime-control.repository';
import {
  InMemoryCompanyRepository,
  InMemoryCustomerRepository,
  InMemoryQuoteRepository,
  InMemoryInvoiceRepository,
  InMemoryDocumentRepository,
  InMemoryDocumentFolderRepository,
  InMemoryPaymentRepository,
  InMemoryPublicAccessTokenRepository,
  InMemoryExpenseRepository,
  InMemoryAccountingEntryRepository,
  InMemoryChartOfAccountsRepository,
  InMemorySequenceCounter,
  InMemoryDocumentArchiveJobRepository,
  InMemoryNotificationJobRepository,
  InMemoryDeviceRepository,
} from './in-memory';

export const PERSISTENCE = Symbol('PERSISTENCE');

/** E3 (PONT-SERVEUR v1) : encaissements datés du tenant — extension des repos CONCRETS, le port
 *  core reste inchangé (même précédent que le repo in-memory de l'api-client, WIP session B). */
export interface ServerPaymentRepository extends PaymentRepository {
  listByCompany(companyId: string): Promise<Payment[]>;
}

/** Bundle de persistance injecté dans BackendService. Deux implémentations : in-memory & Prisma. */
export interface Persistence {
  companies: CompanyRepository;
  customers: CustomerRepository;
  quotes: QuoteRepository;
  invoices: InvoiceRepository;
  documents: DocumentRepository;
  documentAnalyses: DocumentAnalysisStore;
  documentFolders: DocumentFolderRepository;
  documentFolderDeletionPlans: DocumentFolderDeletionPlanStore;
  documentArchiveJobs: DocumentArchiveJobRepository;
  notificationJobs: NotificationJobRepository;
  devices: DeviceRepository;
  payments: ServerPaymentRepository;
  publicAccessTokens: PublicAccessTokenRepository;
  expenses: ExpenseRepository;
  expenseCreationRequests: ExpenseCreationRequestStore;
  quoteCreationRequests: QuoteCreationRequestStore;
  accountingEntries: AccountingEntryRepository;
  chartOfAccounts: ChartOfAccountsRepository;
  agentJournal: AgentJournalRepository;
  supplierMemory: SupplierMemoryRepository;
  /** Abonnement persisté par tenant (pilier 2) — lu par GetSubscriptionStatus (@bob/core). */
  subscriptions: SubscriptionRepository;
  /** Profil fiscal persisté par tenant (BOB EXPERT FISCAL, Phase 1A) — @bob/core. */
  fiscalProfiles: FiscalProfileRepository;
  counters: SequenceCounterPort;
  cabinet: CabinetInfrastructure;
  /** Construit le singleton d'admission Bob Live avec le backend durable de cette persistance. */
  createRealtimeAdmission(policy: RealtimeAdmissionPolicy): RealtimeAdmissionPort;
  /** Projection/mutations du feed audio audité. Le mode démo reste volontairement sans autorité. */
  createRealtimeSpeechDeliveryRepository(): RealtimeSpeechDeliveryRepositoryPort;
  /** Bail inter-répliques du sideband ; aucune autorité simulée en mémoire. */
  createRealtimeSidebandOwner(): RealtimeSidebandOwnerPort;
  /** Cycle de vie durable des artefacts audio audités ; aucune autorité simulée en mémoire. */
  createRealtimeSpeechArtifactRepository(): RealtimeSpeechArtifactRepositoryPort;
  /** Journal d'usage append-only ; aucune autorité de facturation simulée en mémoire. */
  createRealtimeVoiceUsageRepository(): RealtimeVoiceUsageRepositoryPort;
  /** Capacités UI vocales scellées et consommées one-shot ; jamais simulées en mémoire. */
  createRealtimeControlRepository(): RealtimeControlRepositoryPort;
  /** Autorité durable des tickets WSS Mistral ; le mode mémoire reste strictement fail-closed. */
  createMistralRealtimeIngressTicketAuthority(
    policy: MistralRealtimeIngressTicketPolicy,
    identityKeys: MistralRealtimeIngressIdentityKeyRing,
  ): MistralRealtimeIngressTicketAuthority;
  /** Unité de travail : exécute `fn` atomiquement (transaction DB en prod ; direct en mémoire). */
  runInTransaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Défense tenant DB : no-op en mémoire, transaction RLS avec app.current_company_id côté Prisma. */
  runWithTenant<T>(companyId: string, fn: () => Promise<T>): Promise<T>;
  /** Identité seule pour les ressources cabinet non encore sélectionnées. */
  runWithIdentity<T>(userId: string, fn: () => Promise<T>): Promise<T>;
  /** Identité + tenant cabinet ; la membership DB reste obligatoire dans les policies. */
  runWithCabinet<T>(userId: string, cabinetId: string, fn: () => Promise<T>): Promise<T>;
  /** Capacité d'acceptation : identité + email JWT vérifié + hash exact, limitée à la transaction. */
  runWithCabinetInvitation<T>(userId: string, verifiedEmail: string, tokenHash: string, fn: () => Promise<T>): Promise<T>;
  seed(): Promise<void>;
}

export class InMemoryPersistence implements Persistence {
  private readonly transactionContext = new AsyncLocalStorage<symbol>();
  private transactionTail: Promise<void> = Promise.resolve();
  readonly companies = new InMemoryCompanyRepository();
  readonly customers = new InMemoryCustomerRepository();
  readonly quotes = new InMemoryQuoteRepository();
  readonly invoices = new InMemoryInvoiceRepository();
  readonly documents = new InMemoryDocumentRepository();
  readonly documentAnalyses = new InMemoryDocumentAnalysisStore();
  readonly documentFolders = new InMemoryDocumentFolderRepository(this.documents);
  readonly documentFolderDeletionPlans = new InMemoryDocumentFolderDeletionPlanStore();
  readonly documentArchiveJobs = new InMemoryDocumentArchiveJobRepository();
  readonly notificationJobs = new InMemoryNotificationJobRepository();
  readonly devices = new InMemoryDeviceRepository();
  readonly payments = new InMemoryPaymentRepository();
  readonly publicAccessTokens = new InMemoryPublicAccessTokenRepository();
  readonly expenses = new InMemoryExpenseRepository();
  readonly expenseCreationRequests = new InMemoryExpenseCreationRequestStore();
  readonly quoteCreationRequests = new InMemoryQuoteCreationRequestStore();
  readonly accountingEntries = new InMemoryAccountingEntryRepository();
  readonly chartOfAccounts = new InMemoryChartOfAccountsRepository();
  readonly agentJournal = new InMemoryAgentJournalRepository();
  readonly supplierMemory = new InMemorySupplierMemoryRepository();
  readonly subscriptions = new InMemorySubscriptionRepository();
  readonly fiscalProfiles = new InMemoryFiscalProfileRepository();
  readonly counters = new InMemorySequenceCounter();
  readonly cabinet = new MemoryCabinetInfrastructure();
  createRealtimeAdmission(policy: RealtimeAdmissionPolicy): RealtimeAdmissionPort {
    return new InMemoryRealtimeAdmission(policy);
  }
  createRealtimeSpeechDeliveryRepository(): RealtimeSpeechDeliveryRepositoryPort {
    return new DisabledRealtimeSpeechDeliveryRepository();
  }
  createRealtimeSidebandOwner(): RealtimeSidebandOwnerPort {
    return new DisabledRealtimeSidebandOwner();
  }
  createRealtimeSpeechArtifactRepository(): RealtimeSpeechArtifactRepositoryPort {
    return new DisabledRealtimeSpeechArtifactRepository();
  }
  createRealtimeVoiceUsageRepository(): RealtimeVoiceUsageRepositoryPort {
    return new DisabledRealtimeVoiceUsageRepository();
  }
  createRealtimeControlRepository(): RealtimeControlRepositoryPort {
    return new DisabledRealtimeControlRepository();
  }
  createMistralRealtimeIngressTicketAuthority(
    _policy: MistralRealtimeIngressTicketPolicy,
    _identityKeys: MistralRealtimeIngressIdentityKeyRing,
  ): MistralRealtimeIngressTicketAuthority {
    return new DisabledMistralRealtimeIngressTicketAuthority();
  }
  // La file sérialise les transactions racines : sans elle, le rollback par snapshot d'une
  // transaction lente pourrait effacer les écritures déjà validées par une transaction concurrente.
  // AsyncLocalStorage rend la file réentrante pour les use cases qui ouvrent une transaction dans
  // une transaction orchestrée par le backend (parité avec PrismaService).
  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore() !== undefined) return fn();

    const predecessor = this.transactionTail;
    let release: () => void = () => undefined;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;

    const snap = this.counters.snapshot();
    const cabinetSnapshot = this.cabinet.snapshot?.();
    const documentSnapshot = this.documents.snapshot();
    const documentAnalysisSnapshot = this.documentAnalyses.snapshot();
    const folderSnapshot = this.documentFolders.snapshot();
    const quoteSnapshot = this.quotes.snapshot();
    const expenseSnapshot = this.expenses.snapshot();
    const accountingEntrySnapshot = this.accountingEntries.snapshot();
    const expenseCreationRequestSnapshot = this.expenseCreationRequests.snapshot();
    const quoteCreationRequestSnapshot = this.quoteCreationRequests.snapshot();
    try {
      return await this.transactionContext.run(Symbol('in-memory-transaction'), fn);
    } catch (e) {
      this.counters.restore(snap);
      if (cabinetSnapshot !== undefined) this.cabinet.restore?.(cabinetSnapshot);
      this.documents.restore(documentSnapshot);
      this.documentAnalyses.restore(documentAnalysisSnapshot);
      this.documentFolders.restore(folderSnapshot);
      this.quotes.restore(quoteSnapshot);
      this.expenses.restore(expenseSnapshot);
      this.accountingEntries.restore(accountingEntrySnapshot);
      this.expenseCreationRequests.restore(expenseCreationRequestSnapshot);
      this.quoteCreationRequests.restore(quoteCreationRequestSnapshot);
      throw e;
    } finally {
      release();
    }
  }
  async runWithTenant<T>(_companyId: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  async runWithIdentity<T>(_userId: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  async runWithCabinet<T>(userId: string, cabinetId: string, fn: () => Promise<T>): Promise<T> {
    // Parité RLS in-memory : le contexte (userId, cabinetId) alimente les mêmes contrôles fins
    // que les GUC app.current_user_id/app.current_cabinet_id (ex. claim outbox par rôle).
    return this.cabinet.runWithCabinetContext(userId, cabinetId, fn);
  }
  async runWithCabinetInvitation<T>(
    _userId: string,
    _verifiedEmail: string,
    _tokenHash: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return fn();
  }
  async seed(): Promise<void> {
    const company = seedCompany();
    this.companies.seed(company);
    this.customers.seed(seedCustomers());
    for (const spec of DEFAULT_DOCUMENT_FOLDERS) {
      const folder = DocumentFolder.create({
        id: `${company.id}:vault:${spec.systemKey}`,
        companyId: company.id,
        name: spec.name,
        systemKey: spec.systemKey,
        now: new Date().toISOString(),
      });
      if (!folder.ok) throw new Error(`Dossier système invalide (${folder.error.code}).`);
      this.documentFolders.seed(folder.value);
    }
  }
}

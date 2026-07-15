import { DEFAULT_DOCUMENT_FOLDERS, normalizeDocumentFolderName, seedCompany, seedCustomers } from '@bob/core';
import type { Persistence } from '../persistence';
import { PrismaService } from './prisma.service';
import {
  PrismaCompanyRepository,
  PrismaCustomerRepository,
  PrismaQuoteRepository,
  PrismaInvoiceRepository,
  PrismaDocumentRepository,
  PrismaDocumentFolderRepository,
  PrismaDocumentArchiveJobRepository,
  PrismaNotificationJobRepository,
  PrismaDeviceRepository,
  PrismaPaymentRepository,
  PrismaPublicAccessTokenRepository,
  PrismaExpenseRepository,
  PrismaAccountingEntryRepository,
  PrismaChartOfAccountsRepository,
  PrismaAgentJournalRepository,
  PrismaSupplierMemoryRepository,
  PrismaSubscriptionRepository,
  PrismaSequenceCounter,
} from './repositories';
import { companyPropsToCreate, customerPropsToCreate } from './mappers';
import { createPrismaCabinetInfrastructure } from '../../cabinet/prisma-cabinet-infrastructure';
import type { CabinetInfrastructure } from '../../cabinet/cabinet-infrastructure';
import { PrismaDocumentFolderDeletionPlanStore } from '../document-folder-deletion-plans';
import { PrismaDocumentAnalysisStore } from '../document-analyses';
import { PrismaExpenseCreationRequestStore } from '../expense-creation-requests';
import { PrismaQuoteCreationRequestStore } from '../quote-creation-requests';
import type {
  RealtimeAdmissionPolicy,
  RealtimeAdmissionPort,
} from '../../voice/realtime/realtime-admission';
import { PrismaRealtimeAdmission } from '../../voice/realtime/realtime-admission.prisma';
import { PrismaRealtimeSpeechDeliveryRepository } from '../../voice/realtime/realtime-speech-delivery.prisma';
import type { RealtimeSpeechDeliveryRepositoryPort } from '../../voice/realtime/realtime-speech-delivery.repository';
import { PrismaRealtimeSidebandOwner } from '../../voice/realtime/realtime-sideband-owner.prisma';
import type { RealtimeSidebandOwnerPort } from '../../voice/realtime/realtime-sideband-owner';
import { PrismaRealtimeSpeechArtifactRepository } from '../../voice/realtime/realtime-speech.prisma';
import type { RealtimeSpeechArtifactRepositoryPort } from '../../voice/realtime/realtime-speech-publisher';
import { PrismaRealtimeVoiceUsageRepository } from '../../voice/realtime/realtime-voice-usage.prisma';
import type { RealtimeVoiceUsageRepositoryPort } from '../../voice/realtime/realtime-voice-usage';
import { PrismaMistralRealtimeIngressTicketAuthority } from '../../voice/realtime/realtime-mistral-ingress-ticket.prisma';
import type {
  MistralRealtimeIngressIdentityKeyRing,
  MistralRealtimeIngressTicketAuthority,
  MistralRealtimeIngressTicketPolicy,
} from '../../voice/realtime/realtime-mistral-ingress-ticket';
import { PrismaRealtimeControlRepository } from '../../voice/realtime/realtime-control.prisma';
import type { RealtimeControlRepositoryPort } from '../../voice/realtime/realtime-control.repository';

export class PrismaPersistence implements Persistence {
  readonly companies: PrismaCompanyRepository;
  readonly customers: PrismaCustomerRepository;
  readonly quotes: PrismaQuoteRepository;
  readonly invoices: PrismaInvoiceRepository;
  readonly documents: PrismaDocumentRepository;
  readonly documentAnalyses: PrismaDocumentAnalysisStore;
  readonly documentFolders: PrismaDocumentFolderRepository;
  readonly documentFolderDeletionPlans: PrismaDocumentFolderDeletionPlanStore;
  readonly documentArchiveJobs: PrismaDocumentArchiveJobRepository;
  readonly notificationJobs: PrismaNotificationJobRepository;
  readonly devices: PrismaDeviceRepository;
  readonly payments: PrismaPaymentRepository;
  readonly publicAccessTokens: PrismaPublicAccessTokenRepository;
  readonly expenses: PrismaExpenseRepository;
  readonly expenseCreationRequests: PrismaExpenseCreationRequestStore;
  readonly quoteCreationRequests: PrismaQuoteCreationRequestStore;
  readonly accountingEntries: PrismaAccountingEntryRepository;
  readonly chartOfAccounts: PrismaChartOfAccountsRepository;
  readonly agentJournal: PrismaAgentJournalRepository;
  readonly supplierMemory: PrismaSupplierMemoryRepository;
  readonly subscriptions: PrismaSubscriptionRepository;
  readonly counters: PrismaSequenceCounter;
  readonly cabinet: CabinetInfrastructure;

  createRealtimeAdmission(policy: RealtimeAdmissionPolicy): RealtimeAdmissionPort {
    return new PrismaRealtimeAdmission(this.prisma, policy);
  }

  createRealtimeSpeechDeliveryRepository(): RealtimeSpeechDeliveryRepositoryPort {
    return new PrismaRealtimeSpeechDeliveryRepository(this.prisma);
  }

  createRealtimeSidebandOwner(): RealtimeSidebandOwnerPort {
    return new PrismaRealtimeSidebandOwner(this.prisma);
  }

  createRealtimeSpeechArtifactRepository(): RealtimeSpeechArtifactRepositoryPort {
    return new PrismaRealtimeSpeechArtifactRepository(this.prisma);
  }

  createRealtimeVoiceUsageRepository(): RealtimeVoiceUsageRepositoryPort {
    return new PrismaRealtimeVoiceUsageRepository(this.prisma);
  }

  createRealtimeControlRepository(): RealtimeControlRepositoryPort {
    return new PrismaRealtimeControlRepository(this.prisma);
  }

  createMistralRealtimeIngressTicketAuthority(
    policy: MistralRealtimeIngressTicketPolicy,
    identityKeys: MistralRealtimeIngressIdentityKeyRing,
  ): MistralRealtimeIngressTicketAuthority {
    return new PrismaMistralRealtimeIngressTicketAuthority(this.prisma, policy, identityKeys);
  }

  constructor(private readonly prisma: PrismaService) {
    this.companies = new PrismaCompanyRepository(prisma);
    this.customers = new PrismaCustomerRepository(prisma);
    this.quotes = new PrismaQuoteRepository(prisma);
    this.invoices = new PrismaInvoiceRepository(prisma);
    this.documents = new PrismaDocumentRepository(prisma);
    this.documentAnalyses = new PrismaDocumentAnalysisStore(prisma);
    this.documentFolders = new PrismaDocumentFolderRepository(prisma);
    this.documentFolderDeletionPlans = new PrismaDocumentFolderDeletionPlanStore(prisma);
    this.documentArchiveJobs = new PrismaDocumentArchiveJobRepository(prisma);
    this.notificationJobs = new PrismaNotificationJobRepository(prisma);
    this.devices = new PrismaDeviceRepository(prisma);
    this.payments = new PrismaPaymentRepository(prisma);
    this.publicAccessTokens = new PrismaPublicAccessTokenRepository(prisma);
    this.expenses = new PrismaExpenseRepository(prisma);
    this.expenseCreationRequests = new PrismaExpenseCreationRequestStore(prisma);
    this.quoteCreationRequests = new PrismaQuoteCreationRequestStore(prisma);
    this.accountingEntries = new PrismaAccountingEntryRepository(prisma);
    this.chartOfAccounts = new PrismaChartOfAccountsRepository(prisma);
    this.agentJournal = new PrismaAgentJournalRepository(prisma);
    this.supplierMemory = new PrismaSupplierMemoryRepository(prisma);
    this.subscriptions = new PrismaSubscriptionRepository(prisma);
    this.counters = new PrismaSequenceCounter(prisma);
    this.cabinet = createPrismaCabinetInfrastructure(prisma);
  }

  runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.prisma.runInTransaction(fn);
  }

  runWithTenant<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    return this.prisma.withTenant(companyId, () => fn());
  }

  runWithIdentity<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return this.prisma.withIdentity(userId, () => fn());
  }

  runWithCabinet<T>(userId: string, cabinetId: string, fn: () => Promise<T>): Promise<T> {
    return this.prisma.withCabinet(userId, cabinetId, () => fn());
  }

  runWithCabinetInvitation<T>(
    userId: string,
    verifiedEmail: string,
    tokenHash: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.prisma.withCabinetInvitation(userId, verifiedEmail, tokenHash, () => fn());
  }

  async seed(): Promise<void> {
    const company = companyPropsToCreate(seedCompany().toProps());
    const customers = seedCustomers().map((c) => customerPropsToCreate(c.toProps()));
    // FORCE RLS s'applique aussi au bootstrap : sous le rôle applicatif non-superuser, les upserts
    // doivent passer par la transaction où le GUC tenant est posé, sinon WITH CHECK rejette (42501).
    await this.prisma.withTenant(company.id, async (tx) => {
      await tx.company.upsert({ where: { id: company.id }, create: company, update: company });
      for (const customer of customers) {
        await tx.customer.upsert({ where: { id: customer.id }, create: customer, update: customer });
      }
      for (const folder of DEFAULT_DOCUMENT_FOLDERS) {
        const id = `${company.id}:vault:${folder.systemKey}`;
        const data = {
          companyId: company.id,
          parentId: null,
          name: folder.name,
          normalizedName: normalizeDocumentFolderName(folder.name),
          systemKey: folder.systemKey,
          status: 'active' as const,
          revision: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        };
        await tx.documentFolder.upsert({ where: { id }, create: { id, ...data }, update: data });
      }
    });
  }
}

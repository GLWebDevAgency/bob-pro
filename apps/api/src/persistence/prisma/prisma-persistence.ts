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
  PrismaFiscalProfileRepository,
  PrismaSequenceCounter,
} from './repositories';
import { createPrismaCabinetInfrastructure } from '../../cabinet/prisma-cabinet-infrastructure';
import type { CabinetInfrastructure } from '../../cabinet/cabinet-infrastructure';
import { PrismaDocumentFolderDeletionPlanStore } from '../document-folder-deletion-plans';
import { PrismaDocumentAnalysisStore } from '../document-analyses';
import { PrismaExpenseCreationRequestStore } from '../expense-creation-requests';
import { PrismaSalesDocumentSearchRepository } from './sales-document-search.repository';
import { PrismaQuoteCreationRequestStore } from '../quote-creation-requests';
import {
  PrismaCatalogueRepository,
  PrismaChantierRepository,
  PrismaChantierNoteRepository,
} from './catalogue-chantiers.repository';
import { PrismaWorksiteMediaStorage } from './worksite-media.repository';
import { PrismaBankBalanceSnapshotRepository } from './bank-balance-snapshots.repository';
import { PrismaQuoteDraftSlotRepository } from './quote-draft-slots.repository';
import { PrismaCompanyBillingSettingsRepository } from './company-billing-settings.repository';
import { PrismaDiagnosticAssessmentRepository } from './diagnostic-assessment.repository';
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
import { PrismaStripeBillingRepository } from './stripe-billing.repository';
import type { MistralConversationPersistenceKeyRing } from '../../voice/realtime/mistral-conversation-outbox-seal';
import {
  TerminalReplayOnlyMistralConversationCompletion,
  type MistralConversationTerminalReplayAuthorities,
} from '../../voice/realtime/mistral-conversation-terminal-replay';
import { PrismaMistralConversationDurableAuthority } from '../../voice/realtime/mistral-conversation-authority.prisma';
import {
  DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY,
} from '../../voice/realtime/mistral-conversation-resume-ticket';
import { PrismaMistralConversationResumeAuthority } from '../../voice/realtime/mistral-conversation-resume-ticket.prisma';
import { PrismaMistralConversationKeyVersionAuthority } from '../../voice/realtime/mistral-conversation-key-version.prisma';
import { PrismaMistralConversationBootstrapTicketAuthority } from '../../voice/realtime/mistral-conversation-bootstrap-ticket.prisma';
import type { MistralConversationAdmissionPolicy } from '../../voice/realtime/mistral-conversation-admission';
import { PrismaMistralConversationAdmissionAuthority } from '../../voice/realtime/mistral-conversation-admission.prisma';
import { PrismaMistralConversationBootstrapReaper } from '../../voice/realtime/mistral-conversation-bootstrap-reaper.prisma';
import type { MistralConversationBootstrapReaperPort } from '../../voice/realtime/mistral-conversation-bootstrap-reaper';
import {
  PrismaBobLiveSubjectHmacKeyVersionAuthority,
} from '../../voice/realtime/mistral-conversation-subject-key-version.prisma';
import type { BobLiveSubjectHmacKeyRingAdmission } from '../../voice/realtime/mistral-conversation-subject-key-version';

export class PrismaPersistence implements Persistence {
  readonly companies: PrismaCompanyRepository;
  readonly billingSettings: PrismaCompanyBillingSettingsRepository;
  readonly diagnosticAssessments: PrismaDiagnosticAssessmentRepository;
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
  readonly catalogue: PrismaCatalogueRepository;
  readonly chantiers: PrismaChantierRepository;
  readonly chantierNotes: PrismaChantierNoteRepository;
  readonly worksiteMedia: PrismaWorksiteMediaStorage;
  readonly expenseCreationRequests: PrismaExpenseCreationRequestStore;
  readonly quoteCreationRequests: PrismaQuoteCreationRequestStore;
  readonly quoteDraftSlots: PrismaQuoteDraftSlotRepository;
  readonly accountingEntries: PrismaAccountingEntryRepository;
  readonly chartOfAccounts: PrismaChartOfAccountsRepository;
  readonly agentJournal: PrismaAgentJournalRepository;
  readonly supplierMemory: PrismaSupplierMemoryRepository;
  readonly subscriptions: PrismaSubscriptionRepository;
  readonly bankBalances: PrismaBankBalanceSnapshotRepository;
  readonly fiscalProfiles: PrismaFiscalProfileRepository;
  readonly salesDocumentSearch: PrismaSalesDocumentSearchRepository;
  readonly counters: PrismaSequenceCounter;
  readonly cabinet: CabinetInfrastructure;
  /** Port Stripe durable, volontairement hors du contrat Persistence générique de domaine. */
  readonly stripeBilling: PrismaStripeBillingRepository;

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

  createMistralConversationTerminalReplayAuthorities(
    keys: MistralConversationPersistenceKeyRing,
    identityKeys: MistralRealtimeIngressIdentityKeyRing | null,
    subjectKeys: BobLiveSubjectHmacKeyRingAdmission,
    admissionPolicy: MistralConversationAdmissionPolicy,
  ): MistralConversationTerminalReplayAuthorities {
    const currentSecret = keys.secret(keys.currentVersion);
    if (!(currentSecret instanceof Uint8Array) || currentSecret.byteLength !== 32) {
      throw new Error('Mistral conversation current persistence key is unavailable.');
    }
    const keyVersions = new PrismaMistralConversationKeyVersionAuthority(
      this.prisma,
      keys.currentVersion,
      currentSecret,
    );
    const subjectKeyVersions = new PrismaBobLiveSubjectHmacKeyVersionAuthority(
      this.prisma,
      subjectKeys,
    );
    const durable = new PrismaMistralConversationDurableAuthority(
      this.prisma,
      new TerminalReplayOnlyMistralConversationCompletion(),
      keys,
    );
    const resume = new PrismaMistralConversationResumeAuthority(this.prisma, durable, {
      policy: {
        ...DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY,
        // Aucun réglage d'environnement ne peut élargir ce plancher de sécurité.
        liveTakeoverEnabled: false,
      },
      ...(identityKeys ? {
        reconciliationKeys: keys,
        reconciliationIdentityKeys: identityKeys,
      } : {}),
    });
    const admission = new PrismaMistralConversationAdmissionAuthority(
      this.prisma,
      admissionPolicy,
    );
    const initialBootstrap = identityKeys
      ? new PrismaMistralConversationBootstrapTicketAuthority(
          this.prisma,
          durable,
          identityKeys,
          undefined,
          undefined,
          admissionPolicy,
        )
      : null;
    return Object.freeze({
      durable,
      resume,
      initialBootstrap,
      admission,
      termination: durable,
      assertCurrentKeyVersion: async () => {
        // Les deux attestations sont séquentielles et échouent sans exposer leurs matériaux.
        await keyVersions.assertCurrentVersion();
        await subjectKeyVersions.assertCurrentVersion();
      },
    });
  }

  createMistralConversationBootstrapReaper(): MistralConversationBootstrapReaperPort {
    return new PrismaMistralConversationBootstrapReaper(this.prisma);
  }

  constructor(private readonly prisma: PrismaService) {
    this.companies = new PrismaCompanyRepository(prisma);
    this.billingSettings = new PrismaCompanyBillingSettingsRepository(prisma);
    this.diagnosticAssessments = new PrismaDiagnosticAssessmentRepository(prisma);
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
    this.catalogue = new PrismaCatalogueRepository(prisma);
    this.chantiers = new PrismaChantierRepository(prisma);
    this.chantierNotes = new PrismaChantierNoteRepository(prisma);
    this.worksiteMedia = new PrismaWorksiteMediaStorage(prisma);
    this.expenseCreationRequests = new PrismaExpenseCreationRequestStore(prisma);
    this.quoteCreationRequests = new PrismaQuoteCreationRequestStore(prisma);
    this.quoteDraftSlots = new PrismaQuoteDraftSlotRepository(prisma);
    this.accountingEntries = new PrismaAccountingEntryRepository(prisma);
    this.chartOfAccounts = new PrismaChartOfAccountsRepository(prisma);
    this.agentJournal = new PrismaAgentJournalRepository(prisma);
    this.supplierMemory = new PrismaSupplierMemoryRepository(prisma);
    this.subscriptions = new PrismaSubscriptionRepository(prisma);
    this.bankBalances = new PrismaBankBalanceSnapshotRepository(prisma);
    this.fiscalProfiles = new PrismaFiscalProfileRepository(prisma);
    this.salesDocumentSearch = new PrismaSalesDocumentSearchRepository(prisma);
    this.counters = new PrismaSequenceCounter(prisma);
    this.cabinet = createPrismaCabinetInfrastructure(prisma);
    this.stripeBilling = new PrismaStripeBillingRepository(prisma);
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

}

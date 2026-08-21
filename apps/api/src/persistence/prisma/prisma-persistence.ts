import type { Persistence } from '../persistence';
import { PrismaService } from './prisma.service';
import {
  PrismaCompanyRepository,
  PrismaCustomerContactRepository,
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
import {
  PrismaAgentMissionDraftFence,
  PrismaAgentMissionResumeUnitOfWork,
  PrismaAgentMissionUnitOfWork,
} from './agent-mission.persistence';
import type { JarvisCustomerEffectAuthority } from '../../jobs/jarvis-customer-effect.executor';
import type { CustomerUpdateAuthorityPort } from '../../customers/customer-update.authority';
import type { JarvisDispatchRunDirectoryPort } from '../../jobs/jarvis-dispatch-directory';
import { PrismaJarvisCustomerEffectAuthority } from '../../jarvis/jarvis-customer-effect.authority';
import { PrismaJarvisDispatchRunDirectory } from './jarvis-dispatch-directory.persistence';
import {
  PrismaJarvisWorkItemsRepository,
  type JarvisWorkItemsDispatchRepository,
} from './jarvis-work-items.persistence';
import { PrismaJarvisProposalPayloadStore } from './jarvis-proposal-payloads.persistence';
import type {
  AgentMissionResumeUnitOfWorkPort,
  AgentMissionResumeV2UnitOfWorkPort,
  AgentMissionUnitOfWorkPort,
  JarvisProposalPayloadStorePort,
} from '@bob/core';
import type {
  AgentMissionFingerprintKeyBinding,
  AgentMissionFingerprintKeyVersionAuthority,
} from '../../agent-missions/agent-mission-fingerprint-key-version';
import { PrismaAgentMissionFingerprintKeyVersionAuthority } from './agent-mission-fingerprint-key-version.prisma';
import { PrismaVoiceTraceRepository } from '../voice-traces';
import { PrismaRealtimeVoiceTraceRepository } from './realtime-voice-trace.prisma';
import type { RealtimeVoiceTraceAuthorities } from '../../voice/realtime/realtime-voice-trace.repository';
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
import { PrismaEquipmentRepository } from './equipments.repository';
import {
  PrismaContractInvoicesRead,
  PrismaEquipmentContractCoverage,
  PrismaMaintenanceContractRepository,
} from './maintenance-contracts.repository';
import {
  PrismaCompanyInterventionSettingsRepository,
  PrismaInterventionRepository,
} from './interventions.repository';
import { PrismaWorksiteMediaStorage } from './worksite-media.repository';
import { PrismaBankBalanceSnapshotRepository } from './bank-balance-snapshots.repository';
import { PrismaCashMovementProjection } from './cash-movements.projection';
import { PrismaQuoteDraftSlotRepository } from './quote-draft-slots.repository';
import { PrismaCompanyBillingSettingsRepository } from './company-billing-settings.repository';
import { PrismaDiagnosticAssessmentRepository } from './diagnostic-assessment.repository';
import type {
  RealtimeAdmissionPolicy,
  RealtimeAdmissionPort,
} from '../../voice/realtime/realtime-admission';
import { PrismaRealtimeAdmission } from '../../voice/realtime/realtime-admission.prisma';
import { PrismaRealtimeGlobalCapacityInspector } from '../../voice/realtime/realtime-capacity.prisma';
import type { RealtimeGlobalCapacityInspector } from '../../voice/realtime/realtime-capacity';
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
import { PrismaOpenAiNativeSpeechMaintenance } from '../../voice/realtime/openai-native-speech-maintenance.prisma';
import type { OpenAiNativeSpeechMaintenancePort } from '../../voice/realtime/openai-native-speech-maintenance';
import { PrismaOpenAiNativeSpeechDeliveryRepository } from '../../voice/realtime/openai-native-speech-delivery.prisma';
import type { OpenAiNativeSpeechDeliveryRepositoryPort } from '../../voice/realtime/openai-native-speech-delivery';
import { PrismaRealtimeReaperDirectory } from '../../voice/realtime/realtime-reaper-directory.prisma';
import type { RealtimeReaperDirectoryPort } from '../../voice/realtime/realtime-reaper-directory';
import { PrismaStripeBillingRepository } from './stripe-billing.repository';
import type { MistralConversationPersistenceKeyRing } from '../../voice/realtime/mistral-conversation-outbox-seal';
import {
  TerminalReplayOnlyMistralConversationCompletion,
  type MistralConversationTerminalReplayAuthorities,
} from '../../voice/realtime/mistral-conversation-terminal-replay';
import { PrismaMistralConversationDurableAuthority } from '../../voice/realtime/mistral-conversation-authority.prisma';
import { DEFAULT_MISTRAL_CONVERSATION_RESUME_TICKET_POLICY } from '../../voice/realtime/mistral-conversation-resume-ticket';
import { PrismaMistralConversationResumeAuthority } from '../../voice/realtime/mistral-conversation-resume-ticket.prisma';
import { PrismaMistralConversationKeyVersionAuthority } from '../../voice/realtime/mistral-conversation-key-version.prisma';
import { PrismaMistralConversationBootstrapTicketAuthority } from '../../voice/realtime/mistral-conversation-bootstrap-ticket.prisma';
import type { MistralConversationAdmissionPolicy } from '../../voice/realtime/mistral-conversation-admission';
import { PrismaMistralConversationAdmissionAuthority } from '../../voice/realtime/mistral-conversation-admission.prisma';
import { PrismaMistralConversationBootstrapReaper } from '../../voice/realtime/mistral-conversation-bootstrap-reaper.prisma';
import type { MistralConversationBootstrapReaperPort } from '../../voice/realtime/mistral-conversation-bootstrap-reaper';
import { PrismaBobLiveSubjectHmacKeyVersionAuthority } from '../../voice/realtime/mistral-conversation-subject-key-version.prisma';
import type { BobLiveSubjectHmacKeyRingAdmission } from '../../voice/realtime/mistral-conversation-subject-key-version';
import { PrismaOpenAiNativeKeyVersionAuthority } from '../../voice/realtime/openai-native-proof-key-version.prisma';
import type {
  OpenAiNativeKeyVersionAuthorityPort,
  OpenAiNativeProofKeyRingAdmission,
} from '../../voice/realtime/openai-native-proof-key-version';

export class PrismaPersistence implements Persistence {
  readonly companies: PrismaCompanyRepository;
  readonly billingSettings: PrismaCompanyBillingSettingsRepository;
  readonly diagnosticAssessments: PrismaDiagnosticAssessmentRepository;
  readonly customers: PrismaCustomerRepository;
  readonly customerContacts: PrismaCustomerContactRepository;
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
  readonly equipments: PrismaEquipmentRepository;
  readonly maintenanceContracts: PrismaMaintenanceContractRepository;
  readonly contractInvoices: PrismaContractInvoicesRead;
  readonly equipmentContractCoverage: PrismaEquipmentContractCoverage;
  readonly interventions: PrismaInterventionRepository;
  readonly interventionSettings: PrismaCompanyInterventionSettingsRepository;
  readonly worksiteMedia: PrismaWorksiteMediaStorage;
  readonly expenseCreationRequests: PrismaExpenseCreationRequestStore;
  readonly quoteCreationRequests: PrismaQuoteCreationRequestStore;
  readonly quoteDraftSlots: PrismaQuoteDraftSlotRepository;
  readonly agentMissionDraftFence: PrismaAgentMissionDraftFence;
  readonly accountingEntries: PrismaAccountingEntryRepository;
  readonly chartOfAccounts: PrismaChartOfAccountsRepository;
  readonly agentJournal: PrismaAgentJournalRepository;
  readonly voiceTraces: PrismaVoiceTraceRepository;
  readonly supplierMemory: PrismaSupplierMemoryRepository;
  readonly subscriptions: PrismaSubscriptionRepository;
  readonly bankBalances: PrismaBankBalanceSnapshotRepository;
  readonly cashMovements: PrismaCashMovementProjection;
  readonly fiscalProfiles: PrismaFiscalProfileRepository;
  readonly salesDocumentSearch: PrismaSalesDocumentSearchRepository;
  readonly counters: PrismaSequenceCounter;
  readonly cabinet: CabinetInfrastructure;
  /** Port Stripe durable, volontairement hors du contrat Persistence générique de domaine. */
  readonly stripeBilling: PrismaStripeBillingRepository;

  createRealtimeAdmission(policy: RealtimeAdmissionPolicy): RealtimeAdmissionPort {
    return new PrismaRealtimeAdmission(this.prisma, policy);
  }

  createAgentMissionUnitOfWork(): AgentMissionUnitOfWorkPort {
    return new PrismaAgentMissionUnitOfWork(this.prisma);
  }

  /**
   * Magasin PII des propositions Jarvis (§5.5) — LE MÊME client que le reste de la persistance :
   * les GUC de la ligne cible (`withIsolatedOwner` + `app.current_agent_mission_id`) et les
   * policies RLS de la migration s'appliquent donc telles quelles, sans second pool ni seconde
   * identité de connexion.
   */
  createJarvisProposalPayloadStore(): JarvisProposalPayloadStorePort {
    return new PrismaJarvisProposalPayloadStore(this.prisma);
  }

  /**
   * Annuaire de dispatch (U1-f §1) — MÊME client Prisma : l'autorité SECURITY DEFINER est un
   * chemin de PLUS sur la même connexion, jamais une seconde persistance ni une seconde identité.
   */
  /**
   * Repository de dispatch (U1-f §1) : chaque méthode ouvre SA transaction courte sous les GUC de
   * la ligne cible — les policies owner-scopées de U1-a s'appliquent telles quelles.
   */
  createJarvisWorkItemsDispatch(): JarvisWorkItemsDispatchRepository {
    return new PrismaJarvisWorkItemsRepository(this.prisma);
  }

  createJarvisDispatchRunDirectory(): JarvisDispatchRunDirectoryPort {
    return new PrismaJarvisDispatchRunDirectory(this.prisma);
  }

  /**
   * Autorité métier de l'effet fiche client (U1-f §1) : elle appelle les use cases canoniques
   * sous `withTenant`, exactement comme l'artisan qui édite sa fiche à la main.
   */
  createJarvisCustomerEffectAuthority(
    customerUpdates: CustomerUpdateAuthorityPort,
  ): JarvisCustomerEffectAuthority {
    return new PrismaJarvisCustomerEffectAuthority(this.prisma, customerUpdates);
  }

  createAgentMissionResumeUnitOfWork(): AgentMissionResumeUnitOfWorkPort {
    return new PrismaAgentMissionResumeUnitOfWork(this.prisma);
  }

  createAgentMissionResumeV2UnitOfWork(): AgentMissionResumeV2UnitOfWorkPort {
    return new PrismaAgentMissionResumeUnitOfWork(this.prisma);
  }

  createAgentMissionFingerprintKeyVersionAuthority(
    configuredBindings: readonly AgentMissionFingerprintKeyBinding[],
    currentVersion: number,
  ): AgentMissionFingerprintKeyVersionAuthority {
    return new PrismaAgentMissionFingerprintKeyVersionAuthority(
      this.prisma,
      configuredBindings,
      currentVersion,
    );
  }

  createRealtimeGlobalCapacityInspector(): RealtimeGlobalCapacityInspector {
    return new PrismaRealtimeGlobalCapacityInspector(this.prisma);
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

  createRealtimeVoiceTraceAuthorities(): RealtimeVoiceTraceAuthorities {
    const repository = new PrismaRealtimeVoiceTraceRepository(this.prisma);
    return {
      append: repository,
      eraser: repository,
      retention: repository,
    };
  }

  createRealtimeControlRepository(): RealtimeControlRepositoryPort {
    return new PrismaRealtimeControlRepository(this.prisma);
  }

  createOpenAiNativeSpeechDeliveryRepository(): OpenAiNativeSpeechDeliveryRepositoryPort {
    return new PrismaOpenAiNativeSpeechDeliveryRepository(this.prisma);
  }

  createOpenAiNativeKeyVersionAuthority(
    subjectKeys: BobLiveSubjectHmacKeyRingAdmission,
    proofKeys: OpenAiNativeProofKeyRingAdmission,
  ): OpenAiNativeKeyVersionAuthorityPort {
    return new PrismaOpenAiNativeKeyVersionAuthority(this.prisma, subjectKeys, proofKeys);
  }

  createOpenAiNativeSpeechMaintenance(): OpenAiNativeSpeechMaintenancePort {
    return new PrismaOpenAiNativeSpeechMaintenance(this.prisma);
  }

  createRealtimeReaperDirectory(): RealtimeReaperDirectoryPort {
    return new PrismaRealtimeReaperDirectory(this.prisma);
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
      ...(identityKeys
        ? {
            reconciliationKeys: keys,
            reconciliationIdentityKeys: identityKeys,
          }
        : {}),
    });
    const admission = new PrismaMistralConversationAdmissionAuthority(this.prisma, admissionPolicy);
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
    this.customerContacts = new PrismaCustomerContactRepository(prisma);
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
    this.equipments = new PrismaEquipmentRepository(prisma);
    this.maintenanceContracts = new PrismaMaintenanceContractRepository(prisma);
    this.contractInvoices = new PrismaContractInvoicesRead(prisma);
    this.equipmentContractCoverage = new PrismaEquipmentContractCoverage(prisma);
    this.interventions = new PrismaInterventionRepository(prisma);
    this.interventionSettings = new PrismaCompanyInterventionSettingsRepository(prisma);
    this.worksiteMedia = new PrismaWorksiteMediaStorage(prisma);
    this.expenseCreationRequests = new PrismaExpenseCreationRequestStore(prisma);
    this.quoteCreationRequests = new PrismaQuoteCreationRequestStore(prisma);
    this.quoteDraftSlots = new PrismaQuoteDraftSlotRepository(prisma);
    this.agentMissionDraftFence = new PrismaAgentMissionDraftFence(prisma);
    this.accountingEntries = new PrismaAccountingEntryRepository(prisma);
    this.chartOfAccounts = new PrismaChartOfAccountsRepository(prisma);
    this.agentJournal = new PrismaAgentJournalRepository(prisma);
    this.voiceTraces = new PrismaVoiceTraceRepository(prisma);
    this.supplierMemory = new PrismaSupplierMemoryRepository(prisma);
    this.subscriptions = new PrismaSubscriptionRepository(prisma);
    this.bankBalances = new PrismaBankBalanceSnapshotRepository(prisma);
    this.cashMovements = new PrismaCashMovementProjection(prisma);
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

  runDetachedWithTenant<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    return this.prisma.detachedWithTenant(companyId, () => fn());
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

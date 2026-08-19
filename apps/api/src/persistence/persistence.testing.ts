import { AsyncLocalStorage } from 'node:async_hooks';
import { DocumentFolder, DEFAULT_DOCUMENT_FOLDERS } from '@bob/core';
import type { AgentMissionUnitOfWorkPort } from '@bob/core';
import type {
  AgentMissionFingerprintKeyBinding,
  AgentMissionFingerprintKeyVersionAuthority,
} from '../agent-missions/agent-mission-fingerprint-key-version';
import { seedCompany, seedCustomers } from '@bob/core/testing';
import type { Persistence } from './persistence';
import { InMemorySalesDocumentSearchRepository } from './sales-document-search.in-memory';
import { InMemoryAgentJournalRepository } from './agent-journal.testing';
import { InMemoryVoiceTraceRepository } from './voice-traces.testing';
import { InMemorySupplierMemoryRepository } from './supplier-memory.testing';
import { InMemorySubscriptionRepository } from './subscriptions.testing';
import { InMemoryBankBalanceSnapshotRepository } from './bank-balance-snapshots.testing';
import { InMemoryCashMovementProjection } from './cash-movements.testing';
import { InMemoryFiscalProfileRepository } from './fiscal-profiles.testing';
import { MemoryCabinetInfrastructure } from '../cabinet/memory-cabinet-infrastructure';
import { InMemoryDocumentFolderDeletionPlanStore } from './document-folder-deletion-plans.testing';
import { InMemoryDocumentAnalysisStore } from './document-analyses.testing';
import { InMemoryExpenseCreationRequestStore } from './expense-creation-requests.testing';
import { InMemoryQuoteCreationRequestStore } from './quote-creation-requests.testing';
import { InMemoryQuoteDraftSlotRepository } from './quote-draft-slots.testing';
import { InMemoryAgentMissionDraftFence } from './agent-mission-draft-fence.testing';
import { InMemoryCompanyBillingSettingsRepository } from './billing-settings.testing';
import { InMemoryDiagnosticAssessmentRepository } from './diagnostic-assessment.testing';
import { InMemoryRealtimeAdmission } from '../voice/realtime/realtime-admission.testing';
import {
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
  DisabledOpenAiNativeSpeechMaintenance,
  type OpenAiNativeSpeechMaintenancePort,
} from '../voice/realtime/openai-native-speech-maintenance';
import {
  DisabledOpenAiNativeSpeechDeliveryRepository,
  type OpenAiNativeSpeechDeliveryRepositoryPort,
} from '../voice/realtime/openai-native-speech-delivery';
import {
  DisabledRealtimeReaperDirectory,
  type RealtimeReaperDirectoryPort,
} from '../voice/realtime/realtime-reaper-directory';
import {
  DisabledRealtimeGlobalCapacityInspector,
  type RealtimeGlobalCapacityInspector,
} from '../voice/realtime/realtime-capacity';
import type { MistralConversationPersistenceKeyRing } from '../voice/realtime/mistral-conversation-outbox-seal';
import type { MistralConversationTerminalReplayAuthorities } from '../voice/realtime/mistral-conversation-terminal-replay';
import type { MistralConversationAdmissionPolicy } from '../voice/realtime/mistral-conversation-admission';
import type { MistralConversationBootstrapReaperPort } from '../voice/realtime/mistral-conversation-bootstrap-reaper';
import type { BobLiveSubjectHmacKeyRingAdmission } from '../voice/realtime/mistral-conversation-subject-key-version';
import type {
  OpenAiNativeKeyVersionAuthorityPort,
  OpenAiNativeProofKeyRingAdmission,
} from '../voice/realtime/openai-native-proof-key-version';
import type { RealtimeVoiceTraceAuthorities } from '../voice/realtime/realtime-voice-trace.repository';
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
  InMemoryChantierRepository,
  InMemoryEquipmentRepository,
  InMemoryMaintenanceContractRepository,
  InMemoryContractInvoicesRead,
  InMemoryEquipmentContractCoverage,
  InMemoryInterventionRepository,
  InMemoryCompanyInterventionSettingsRepository,
  InMemoryChantierNoteRepository,
  InMemoryWorksiteMediaStorage,
  InMemoryCatalogueRepository,
  InMemoryAccountingEntryRepository,
  InMemoryChartOfAccountsRepository,
  InMemorySequenceCounter,
  InMemoryDocumentArchiveJobRepository,
  InMemoryNotificationJobRepository,
  InMemoryDeviceRepository,
  InMemoryCustomerContactRepository,
} from './in-memory';

/** Harness transactionnel explicite. Ce module est exclu du build API de production. */
export class InMemoryPersistence implements Persistence {
  private readonly transactionContext = new AsyncLocalStorage<symbol>();
  private transactionTail: Promise<void> = Promise.resolve();
  readonly companies = new InMemoryCompanyRepository();
  readonly billingSettings = new InMemoryCompanyBillingSettingsRepository();
  readonly diagnosticAssessments = new InMemoryDiagnosticAssessmentRepository();
  readonly customers = new InMemoryCustomerRepository();
  readonly customerContacts = new InMemoryCustomerContactRepository();
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
  readonly catalogue = new InMemoryCatalogueRepository();
  readonly chantiers = new InMemoryChantierRepository();
  readonly chantierNotes = new InMemoryChantierNoteRepository();
  readonly equipments = new InMemoryEquipmentRepository();
  readonly maintenanceContracts = new InMemoryMaintenanceContractRepository();
  readonly contractInvoices = new InMemoryContractInvoicesRead(this.invoices);
  readonly equipmentContractCoverage = new InMemoryEquipmentContractCoverage(
    this.maintenanceContracts,
  );
  readonly interventions = new InMemoryInterventionRepository();
  readonly interventionSettings = new InMemoryCompanyInterventionSettingsRepository();
  readonly worksiteMedia = new InMemoryWorksiteMediaStorage();
  readonly expenseCreationRequests = new InMemoryExpenseCreationRequestStore();
  readonly quoteCreationRequests = new InMemoryQuoteCreationRequestStore();
  readonly quoteDraftSlots = new InMemoryQuoteDraftSlotRepository();
  readonly agentMissionDraftFence = new InMemoryAgentMissionDraftFence();
  readonly accountingEntries = new InMemoryAccountingEntryRepository();
  readonly chartOfAccounts = new InMemoryChartOfAccountsRepository();
  readonly agentJournal = new InMemoryAgentJournalRepository();
  readonly voiceTraces = new InMemoryVoiceTraceRepository();
  readonly supplierMemory = new InMemorySupplierMemoryRepository();
  readonly subscriptions = new InMemorySubscriptionRepository();
  readonly bankBalances = new InMemoryBankBalanceSnapshotRepository();
  readonly cashMovements = new InMemoryCashMovementProjection(this.payments, this.expenses);
  readonly fiscalProfiles = new InMemoryFiscalProfileRepository();
  readonly salesDocumentSearch = new InMemorySalesDocumentSearchRepository(
    this.quotes,
    this.invoices,
    this.customers,
  );
  readonly counters = new InMemorySequenceCounter();
  readonly cabinet = new MemoryCabinetInfrastructure();

  createRealtimeAdmission(policy: RealtimeAdmissionPolicy): RealtimeAdmissionPort {
    return new InMemoryRealtimeAdmission(policy);
  }
  createAgentMissionUnitOfWork(): AgentMissionUnitOfWorkPort | null {
    // Les tests HTTP positifs remplacent explicitement l'autorité M1-A. Un double générique ne
    // simule jamais abusivement RLS, advisory locks ou transaction_timestamp().
    return null;
  }
  createJarvisProposalPayloadStore(): null {
    // Une mémoire ne peut attester ni la RLS owner-scopée, ni le sceau recalculé au repos, ni la
    // rétention décidée par la base : la charge PII reste indisponible, jamais approximée.
    return null;
  }
  createAgentMissionResumeUnitOfWork(): null {
    // Un double mémoire ne peut pas attester RLS owner + snapshot RR strictement read-only.
    return null;
  }
  createAgentMissionResumeV2UnitOfWork(): null {
    // La projection M2-A exige le même snapshot PostgreSQL réel, enrichi du work/catalogue/TVA.
    return null;
  }
  createAgentMissionFingerprintKeyVersionAuthority(
    _configuredBindings: readonly AgentMissionFingerprintKeyBinding[],
    _currentVersion: number,
  ): AgentMissionFingerprintKeyVersionAuthority | null {
    // Le harness mémoire ne peut pas attester un agrégat global sous FORCE RLS.
    return null;
  }
  createRealtimeGlobalCapacityInspector(): RealtimeGlobalCapacityInspector {
    return new DisabledRealtimeGlobalCapacityInspector();
  }
  createRealtimeVoiceTraceAuthorities(): RealtimeVoiceTraceAuthorities | null {
    // Une mémoire de test ne peut attester ni FORCE RLS, ni append-only, ni purge globale.
    return null;
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
  createOpenAiNativeSpeechDeliveryRepository(): OpenAiNativeSpeechDeliveryRepositoryPort {
    return new DisabledOpenAiNativeSpeechDeliveryRepository();
  }
  createOpenAiNativeKeyVersionAuthority(
    _subjectKeys: BobLiveSubjectHmacKeyRingAdmission,
    _proofKeys: OpenAiNativeProofKeyRingAdmission,
  ): OpenAiNativeKeyVersionAuthorityPort | null {
    // Le harness mémoire ne peut pas attester un registre append-only PostgreSQL.
    return null;
  }
  createOpenAiNativeSpeechMaintenance(): OpenAiNativeSpeechMaintenancePort {
    return new DisabledOpenAiNativeSpeechMaintenance();
  }
  createRealtimeReaperDirectory(): RealtimeReaperDirectoryPort {
    return new DisabledRealtimeReaperDirectory();
  }
  createMistralRealtimeIngressTicketAuthority(
    _policy: MistralRealtimeIngressTicketPolicy,
    _identityKeys: MistralRealtimeIngressIdentityKeyRing,
  ): MistralRealtimeIngressTicketAuthority {
    return new DisabledMistralRealtimeIngressTicketAuthority();
  }
  createMistralConversationTerminalReplayAuthorities(
    _keys: MistralConversationPersistenceKeyRing,
    _identityKeys: MistralRealtimeIngressIdentityKeyRing | null,
    _subjectKeys: BobLiveSubjectHmacKeyRingAdmission,
    _admissionPolicy: MistralConversationAdmissionPolicy,
  ): MistralConversationTerminalReplayAuthorities | null {
    // Le harness mémoire ne fabrique jamais de mission, ticket ou outbox v2.
    return null;
  }
  createMistralConversationBootstrapReaper(): MistralConversationBootstrapReaperPort | null {
    // Une purge globale multi-tenant n'a volontairement aucun double de production en mémoire.
    return null;
  }

  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore() !== undefined) return fn();

    const predecessor = this.transactionTail;
    let release: () => void = () => undefined;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;

    try {
      return await this.runInTransactionUnderBarrier(fn);
    } finally {
      // Le verrou est TOUJOURS relâché — y compris quand une prise de snapshot lève (un fake de
      // test incomplet ne doit jamais empoisonner la file des transactions suivantes).
      release();
    }
  }

  private async runInTransactionUnderBarrier<T>(fn: () => Promise<T>): Promise<T> {
    const snap = this.counters.snapshot();
    const companySnapshot = this.companies.snapshot();
    const subscriptionSnapshot = this.subscriptions.snapshot();
    const cabinetSnapshot = this.cabinet.snapshot?.();
    const documentSnapshot = this.documents.snapshot();
    const documentInvoicePdfAttestationSnapshot = this.documents.snapshotInvoicePdfAttestations();
    const documentAnalysisSnapshot = this.documentAnalyses.snapshot();
    const folderSnapshot = this.documentFolders.snapshot();
    const quoteSnapshot = this.quotes.snapshot();
    const invoiceSnapshot = this.invoices.snapshot();
    const documentArchiveJobSnapshot = this.documentArchiveJobs.snapshotState();
    const expenseSnapshot = this.expenses.snapshot();
    const catalogueSnapshot = this.catalogue.snapshot();
    const chantierSnapshot = this.chantiers.snapshot();
    const chantierNoteSnapshot = this.chantierNotes.snapshot();
    const equipmentSnapshot = this.equipments.snapshot();
    const maintenanceContractSnapshot = this.maintenanceContracts.snapshot();
    const interventionSnapshot = this.interventions.snapshot();
    const interventionSettingsSnapshot = this.interventionSettings.snapshot();
    const worksiteMediaSnapshot = this.worksiteMedia.snapshot();
    const accountingEntrySnapshot = this.accountingEntries.snapshot();
    const expenseCreationRequestSnapshot = this.expenseCreationRequests.snapshot();
    const quoteCreationRequestSnapshot = this.quoteCreationRequests.snapshot();
    const quoteDraftSlotSnapshot = this.quoteDraftSlots.snapshot();
    const billingSettingsSnapshot = this.billingSettings.snapshot();
    const diagnosticAssessmentSnapshot = this.diagnosticAssessments.snapshot();
    try {
      return await this.transactionContext.run(Symbol('in-memory-transaction'), fn);
    } catch (error) {
      this.counters.restore(snap);
      this.companies.restore(companySnapshot);
      this.subscriptions.restore(subscriptionSnapshot);
      if (cabinetSnapshot !== undefined) this.cabinet.restore?.(cabinetSnapshot);
      this.documents.restore(documentSnapshot);
      this.documents.restoreInvoicePdfAttestations(documentInvoicePdfAttestationSnapshot);
      this.documentAnalyses.restore(documentAnalysisSnapshot);
      this.documentFolders.restore(folderSnapshot);
      this.quotes.restore(quoteSnapshot);
      this.invoices.restore(invoiceSnapshot);
      this.documentArchiveJobs.restoreState(documentArchiveJobSnapshot);
      this.expenses.restore(expenseSnapshot);
      this.catalogue.restore(catalogueSnapshot);
      this.chantiers.restore(chantierSnapshot);
      this.chantierNotes.restore(chantierNoteSnapshot);
      this.equipments.restore(equipmentSnapshot);
      this.maintenanceContracts.restore(maintenanceContractSnapshot);
      this.interventions.restore(interventionSnapshot);
      this.interventionSettings.restore(interventionSettingsSnapshot);
      this.worksiteMedia.restore(worksiteMediaSnapshot);
      this.accountingEntries.restore(accountingEntrySnapshot);
      this.expenseCreationRequests.restore(expenseCreationRequestSnapshot);
      this.quoteCreationRequests.restore(quoteCreationRequestSnapshot);
      this.quoteDraftSlots.restore(quoteDraftSlotSnapshot);
      this.billingSettings.restore(billingSettingsSnapshot);
      this.diagnosticAssessments.restore(diagnosticAssessmentSnapshot);
      throw error;
    }
  }

  async runWithTenant<T>(_companyId: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  async runDetachedWithTenant<T>(_companyId: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  async runWithIdentity<T>(_userId: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  async runWithCabinet<T>(userId: string, cabinetId: string, fn: () => Promise<T>): Promise<T> {
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
    await this.billingSettings.ensureForCompany(company.id);
    this.customers.seed(seedCustomers());
    await this.subscriptions.startTrial({
      id: `sub-${company.id}`,
      companyId: company.id,
      plan: 'business',
      trialEndsAt: '2099-12-31T23:59:59.000Z',
      now: '2026-01-01T00:00:00.000Z',
    });
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

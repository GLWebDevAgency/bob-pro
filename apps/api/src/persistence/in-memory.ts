import { randomUUID } from 'node:crypto';
import {
  DocNumber,
  Invoice,
  Quote,
  AccountingEntry,
  ChartOfAccounts,
  Expense,
  type Company,
  type Customer,
  Document,
  DocumentFolder,
  type DocumentFolderProps,
  type Payment,
  type Chantier,
  type CompanyRepository,
  type CustomerRepository,
  type QuoteRepository,
  type InvoiceRepository,
  type DocumentRepository,
  type DocumentFolderRepository,
  type DocumentFolderMembership,
  type DocumentFolderWriteResult,
  type DocumentFolderMembershipWriteResult,
  type PaymentRepository,
  type PublicAccessGrant,
  type PublicAccessTokenRepository,
  type ExpenseRepository,
  type AccountingEntryRepository,
  type ChartOfAccountsRepository,
  type ChantierRepository,
  type SequenceCounterPort,
  type CounterKey,
  type IdGeneratorPort,
  type CashflowSnapshotPort,
} from '@bob/core';
import type {
  DocumentArchiveJob,
  DocumentArchiveJobRepository,
  EnqueueDocumentArchiveJobInput,
} from './document-archive-jobs';
import {
  NotificationDedupeConflictError,
  notificationPayloadFingerprint,
  type DeliverableNotificationJob,
  type EnqueueNotificationJobInput,
  type NotificationDeliveryClaim,
  type NotificationJob,
  type NotificationJobRepository,
  type NotificationReadThroughResult,
  type NotificationUnreadPreview,
} from './notification-jobs';
import type { DeviceRecord, DeviceRepository, RegisterDeviceInput } from './devices';
import { DuplicateExpenseInvoiceError } from './expense-duplicate-error';

/**
 * Adapters in-memory (stockent les objets de domaine directement — aucune réhydratation requise).
 * Permettent de faire tourner l'API SANS base de données. Les adapters Prisma/Postgres sont le
 * prochain incrément (cf. prisma/schema.prisma + réhydratation des agrégats).
 */
export class InMemoryCompanyRepository implements CompanyRepository {
  private readonly map = new Map<string, Company>();
  seed(c: Company): void {
    this.map.set(c.id, c);
  }
  async findById(id: string): Promise<Company | null> {
    return this.map.get(id) ?? null;
  }
  async list(): Promise<Company[]> {
    return [...this.map.values()];
  }
  async save(c: Company): Promise<void> {
    this.map.set(c.id, c);
  }
}

export class InMemoryCustomerRepository implements CustomerRepository {
  private readonly map = new Map<string, Customer>();
  seed(list: Customer[]): void {
    for (const c of list) this.map.set(c.id, c);
  }
  async findById(id: string): Promise<Customer | null> {
    return this.map.get(id) ?? null;
  }
  async listByCompany(companyId: string): Promise<Customer[]> {
    return [...this.map.values()].filter((c) => c.companyId === companyId);
  }
  async save(c: Customer): Promise<void> {
    this.map.set(c.id, c);
  }
}

export class InMemoryQuoteRepository implements QuoteRepository {
  private map = new Map<string, Quote>();
  async findById(id: string): Promise<Quote | null> {
    return this.map.get(id) ?? null;
  }
  async lockById(id: string): Promise<Quote | null> {
    const stored = this.map.get(id);
    return stored ? Quote.rehydrate(stored.toSnapshot()) : null;
  }
  async listByCompany(companyId: string): Promise<Quote[]> {
    return [...this.map.values()].filter((q) => q.companyId === companyId);
  }
  async save(q: Quote): Promise<void> {
    this.map.set(q.id, q);
  }

  snapshot(): Map<string, Quote> {
    return new Map([...this.map].map(([id, quote]) => [id, Quote.rehydrate(quote.toSnapshot())]));
  }

  restore(snapshot: Map<string, Quote>): void {
    this.map = new Map([...snapshot].map(([id, quote]) => [id, Quote.rehydrate(quote.toSnapshot())]));
  }
}

export class InMemoryInvoiceRepository implements InvoiceRepository {
  private readonly map = new Map<string, Invoice>();
  async findById(id: string): Promise<Invoice | null> {
    return this.map.get(id) ?? null;
  }
  async lockById(id: string): Promise<Invoice | null> {
    // Mono-thread JS : pas de verrou réel ; on renvoie une COPIE (comme Prisma) pour isoler les
    // mutations jusqu'au save (pas de mutation en place de l'agrégat stocké en cas d'erreur).
    const stored = this.map.get(id);
    return stored ? Invoice.rehydrate(stored.toSnapshot()) : null;
  }
  async findByParentQuoteId(companyId: string, parentQuoteId: string, kind: Invoice['kind']): Promise<Invoice | null> {
    return [...this.map.values()].find((i) => i.companyId === companyId && i.parentQuoteId === parentQuoteId && i.kind === kind) ?? null;
  }
  async listByCompany(companyId: string): Promise<Invoice[]> {
    return [...this.map.values()].filter((i) => i.companyId === companyId);
  }
  async save(i: Invoice): Promise<void> {
    this.map.set(i.id, i);
  }
  async deleteById(id: string): Promise<void> {
    this.map.delete(id);
  }
}

export class InMemoryDocumentRepository implements DocumentRepository {
  private readonly map = new Map<string, Document>();
  snapshot(): ReturnType<Document['toProps']>[] {
    return [...this.map.values()].map((document) => document.toProps());
  }
  restore(snapshot: ReturnType<Document['toProps']>[]): void {
    this.map.clear();
    for (const props of snapshot) this.map.set(props.id, Document.rehydrate(props));
  }
  async save(d: Document): Promise<void> {
    this.map.set(d.id, d);
  }
  async classify(input: {
    companyId: string;
    documentId: string;
    linkedEntityType: Parameters<Document['classify']>[0]['linkedEntityType'];
    linkedEntityId: string;
    expectedRevision: number;
  }): Promise<'saved' | 'revision_conflict' | 'not_found'> {
    const current = this.map.get(input.documentId);
    if (!current || current.companyId !== input.companyId || current.status !== 'active') return 'not_found';
    if (current.revision !== input.expectedRevision) return 'revision_conflict';
    const next = Document.rehydrate(current.toProps());
    const classified = next.classify({
      linkedEntityType: input.linkedEntityType,
      linkedEntityId: input.linkedEntityId,
    });
    if (!classified.ok) return 'revision_conflict';
    this.map.set(input.documentId, next);
    return 'saved';
  }
  async findById(companyId: string, id: string): Promise<Document | null> {
    const d = this.map.get(id);
    return d && d.companyId === companyId ? d : null;
  }
  async findByEntity(companyId: string, entityType: string, entityId: string): Promise<Document[]> {
    return [...this.map.values()].filter((d) => {
      const props = d.toProps();
      return props.companyId === companyId && props.linkedEntityType === entityType && props.linkedEntityId === entityId;
    });
  }
  async listByCompany(companyId: string): Promise<Document[]> {
    return [...this.map.values()].filter((d) => d.companyId === companyId);
  }
  async listExpired(now: string): Promise<Document[]> {
    return [...this.map.values()].filter((d) => d.status === 'active' && d.retentionUntil <= now);
  }
}

export class InMemoryDocumentFolderRepository implements DocumentFolderRepository {
  private readonly map = new Map<string, DocumentFolderProps>();

  constructor(private readonly documents: InMemoryDocumentRepository) {}

  snapshot(): DocumentFolderProps[] {
    return [...this.map.values()].map((props) => ({ ...props }));
  }

  restore(snapshot: DocumentFolderProps[]): void {
    this.map.clear();
    for (const props of snapshot) this.map.set(props.id, { ...props });
  }

  seed(folder: DocumentFolder): void {
    this.map.set(folder.id, folder.toProps());
  }

  async findById(companyId: string, folderId: string): Promise<DocumentFolder | null> {
    const folder = this.map.get(folderId);
    return folder?.companyId === companyId ? DocumentFolder.rehydrate(folder) : null;
  }

  async listActiveAncestors(companyId: string, folderId: string): Promise<DocumentFolder[]> {
    const chain: DocumentFolder[] = [];
    const seen = new Set<string>();
    let current = await this.findById(companyId, folderId);
    while (current && current.status === 'active' && !seen.has(current.id)) {
      seen.add(current.id);
      chain.unshift(current);
      current = current.parentId ? await this.findById(companyId, current.parentId) : null;
    }
    return current === null ? chain : [];
  }

  async listActiveSubtree(companyId: string, folderId: string): Promise<DocumentFolder[]> {
    const root = await this.findById(companyId, folderId);
    if (!root || root.status !== 'active') return [];
    const result: DocumentFolder[] = [];
    const queue = [root];
    while (queue.length > 0) {
      const folder = queue.shift()!;
      result.push(folder);
      queue.push(
        ...[...this.map.values()]
          .filter(
            (candidate) =>
              candidate.companyId === companyId && candidate.status === 'active' && candidate.parentId === folder.id,
          )
          .map((candidate) => DocumentFolder.rehydrate(candidate)),
      );
    }
    return result;
  }

  async listChildren(input: {
    companyId: string;
    parentId: string | null;
    limit: number;
    cursor?: string | null;
  }): Promise<{ items: DocumentFolder[]; nextCursor: string | null }> {
    const sorted = [...this.map.values()]
      .filter(
        (folder) =>
          folder.companyId === input.companyId && folder.status === 'active' && folder.parentId === input.parentId,
      )
      .map((folder) => DocumentFolder.rehydrate(folder))
      .sort((a, b) => {
        const left = a.toProps();
        const right = b.toProps();
        return left.normalizedName.localeCompare(right.normalizedName) || left.id.localeCompare(right.id);
      });
    const start = input.cursor ? Math.max(0, sorted.findIndex((folder) => folder.id === input.cursor) + 1) : 0;
    const page = sorted.slice(start, start + input.limit + 1);
    const hasMore = page.length > input.limit;
    const items = page.slice(0, input.limit);
    return { items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null };
  }

  async findActiveSiblingByNormalizedName(input: {
    companyId: string;
    parentId: string | null;
    normalizedName: string;
    excludeFolderId?: string;
  }): Promise<DocumentFolder | null> {
    const props = [...this.map.values()].find(
      (candidate) =>
        candidate.companyId === input.companyId &&
        candidate.status === 'active' &&
        candidate.parentId === input.parentId &&
        candidate.normalizedName === input.normalizedName &&
        candidate.id !== input.excludeFolderId,
    );
    return props ? DocumentFolder.rehydrate(props) : null;
  }

  async save(folder: DocumentFolder, expectedRevision: number | null): Promise<DocumentFolderWriteResult> {
    const props = folder.toProps();
    const duplicate = await this.findActiveSiblingByNormalizedName({
      companyId: props.companyId,
      parentId: props.parentId,
      normalizedName: props.normalizedName,
      excludeFolderId: props.id,
    });
    if (duplicate) return { status: 'name_conflict' };
    const existing = this.map.get(props.id);
    if (expectedRevision === null) {
      if (existing) return { status: 'revision_conflict' };
    } else if (!existing || existing.revision !== expectedRevision) {
      return { status: 'revision_conflict' };
    }
    this.map.set(props.id, props);
    return { status: 'saved' };
  }

  async findDocumentMembership(companyId: string, documentId: string): Promise<DocumentFolderMembership | null> {
    const document = await this.documents.findById(companyId, documentId);
    return document
      ? { id: document.id, companyId: document.companyId, folderId: document.folderId, status: document.status, revision: document.revision }
      : null;
  }

  async listDocumentMemberships(companyId: string, folderIds: readonly string[]): Promise<DocumentFolderMembership[]> {
    const allowed = new Set(folderIds);
    return (await this.documents.listByCompany(companyId))
      .filter((document) => document.folderId !== null && allowed.has(document.folderId))
      .map((document) => ({
        id: document.id,
        companyId: document.companyId,
        folderId: document.folderId,
        status: document.status,
        revision: document.revision,
      }));
  }

  async moveDocument(input: {
    companyId: string;
    documentId: string;
    targetFolderId: string | null;
    expectedRevision: number;
  }): Promise<DocumentFolderMembershipWriteResult> {
    const document = await this.documents.findById(input.companyId, input.documentId);
    if (!document || document.status !== 'active') return { status: 'not_found' };
    if (document.revision !== input.expectedRevision) return { status: 'revision_conflict' };
    const moved = document.moveToFolder(input.targetFolderId);
    if (!moved.ok) return { status: 'revision_conflict' };
    await this.documents.save(document);
    return { status: 'saved', revision: document.revision };
  }
}

export class InMemoryDocumentArchiveJobRepository implements DocumentArchiveJobRepository {
  private readonly map = new Map<string, DocumentArchiveJob>();

  async enqueue(input: EnqueueDocumentArchiveJobInput): Promise<void> {
    const existing = [...this.map.values()].find(
      (job) => job.companyId === input.companyId && job.invoiceId === input.invoiceId && job.reason === input.reason,
    );
    if (existing) {
      if (existing.status !== 'done') {
        this.map.set(existing.id, { ...existing, status: 'pending', nextAttemptAt: input.now, updatedAt: input.now });
      }
      return;
    }
    this.map.set(input.id, {
      id: input.id,
      companyId: input.companyId,
      invoiceId: input.invoiceId,
      reason: input.reason,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: input.now,
      lastError: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  async listDue(companyId: string, now: string, limit: number): Promise<DocumentArchiveJob[]> {
    return [...this.map.values()]
      .filter((job) => job.companyId === companyId)
      .filter((job) => job.status === 'pending' || job.status === 'failed')
      .filter((job) => job.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt))
      .slice(0, limit)
      .map((job) => ({ ...job }));
  }

  async markDone(id: string, at: string): Promise<void> {
    const job = this.map.get(id);
    if (job) this.map.set(id, { ...job, status: 'done', lastError: null, updatedAt: at });
  }

  async markFailed(id: string, at: string, nextAttemptAt: string, error: string): Promise<void> {
    const job = this.map.get(id);
    if (job) {
      this.map.set(id, {
        ...job,
        status: 'failed',
        attempts: job.attempts + 1,
        nextAttemptAt,
        lastError: error.slice(0, 2000),
        updatedAt: at,
      });
    }
  }
}

export class InMemoryNotificationJobRepository implements NotificationJobRepository {
  private readonly map = new Map<string, NotificationJob>();

  private clone(job: NotificationJob): NotificationJob {
    return { ...job, notification: job.notification ? { ...job.notification } : null };
  }

  async enqueue(input: EnqueueNotificationJobInput): Promise<NotificationJob> {
    const payloadFingerprint = notificationPayloadFingerprint(input.notification);
    const existing = [...this.map.values()].find(
      (job) => job.companyId === input.companyId && job.kind === input.kind && job.dedupeKey === input.dedupeKey,
    );
    if (existing) {
      if (existing.payloadFingerprint !== payloadFingerprint) {
        throw new NotificationDedupeConflictError(input.dedupeKey);
      }
      if (existing.status !== 'done') {
        // Une clé provider identifie une requête IMMUABLE. Modifier to/subject/body sous la
        // même UUID ferait croire que B a été livré si Brevo avait déjà accepté A.
        // Un lease, même expiré, reste en place pour le chemin de récupération/quarantaine.
        if (existing.nextAttemptAt > input.now || existing.leaseToken !== null) return this.clone(existing);
        const updated: NotificationJob = {
          ...existing,
          status: 'pending',
          nextAttemptAt: input.now,
          leaseToken: null,
          lastError: null,
          updatedAt: input.now,
        };
        this.map.set(existing.id, updated);
        return this.clone(updated);
      }
      return this.clone(existing);
    }

    const created: NotificationJob = {
      id: input.id,
      companyId: input.companyId,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      channel: input.notification.channel,
      recipient: input.notification.to,
      subject: input.notification.subject,
      notification: { ...input.notification },
      payloadFingerprint,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: input.now,
      leaseToken: null,
      providerAttemptedAt: null,
      lastError: null,
      readAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.map.set(created.id, created);
    return this.clone(created);
  }

  async findById(companyId: string, id: string): Promise<NotificationJob | null> {
    const job = this.map.get(id);
    return job?.companyId === companyId ? this.clone(job) : null;
  }

  async listDue(companyId: string, now: string, limit: number): Promise<DeliverableNotificationJob[]> {
    return [...this.map.values()]
      .filter((job) => job.companyId === companyId)
      .filter((job) => job.status === 'pending' || job.status === 'failed')
      .filter((job) => job.notification !== null)
      .filter((job) => job.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt))
      .slice(0, limit)
      .map((job) => ({ ...job, notification: job.notification! }));
  }

  async claimForDelivery(
    id: string,
    companyId: string,
    expectedUpdatedAt: string,
    now: string,
    leaseUntil: string,
    leaseToken: string,
  ): Promise<NotificationDeliveryClaim> {
    const job = this.map.get(id);
    if (
      !job ||
      job.companyId !== companyId ||
      job.updatedAt !== expectedUpdatedAt ||
      (job.status !== 'pending' && job.status !== 'failed') ||
      job.notification === null ||
      job.nextAttemptAt > now
    ) {
      return { outcome: 'skipped' };
    }
    const attemptedAtMs = job.providerAttemptedAt === null ? null : Date.parse(job.providerAttemptedAt);
    const providerWindowExpired = attemptedAtMs !== null && Date.parse(now) >= attemptedAtMs + 25 * 60_000;
    const channelCannotRetry = attemptedAtMs !== null && job.channel !== 'email';
    if (providerWindowExpired || channelCannotRetry) {
      this.map.set(id, {
        ...job,
        status: 'failed',
        nextAttemptAt: '9999-12-31T23:59:59.999Z',
        leaseToken: null,
        lastError: '[manual-review:provider-outcome-uncertain] Rejeu automatique interdit.',
        updatedAt: now,
      });
      return {
        outcome: 'quarantined',
        reason: channelCannotRetry ? 'channel-without-idempotency' : 'provider-window-expired',
      };
    }
    const claimed: DeliverableNotificationJob = {
      ...job,
      notification: job.notification,
      nextAttemptAt: leaseUntil,
      leaseToken,
      providerAttemptedAt: job.providerAttemptedAt ?? now,
      updatedAt: now,
    };
    this.map.set(id, claimed);
    return { outcome: 'claimed', job: { ...claimed, notification: { ...claimed.notification } } };
  }

  async authorizeDeliveryAttempt(
    id: string,
    companyId: string,
    leaseToken: string,
    observedAt: string,
  ): Promise<boolean> {
    const job = this.map.get(id);
    if (
      !job ||
      job.companyId !== companyId ||
      job.leaseToken !== leaseToken ||
      (job.status !== 'pending' && job.status !== 'failed') ||
      job.nextAttemptAt <= observedAt ||
      job.providerAttemptedAt === null
    ) {
      return false;
    }
    return job.channel !== 'email'
      || Date.parse(observedAt) < Date.parse(job.providerAttemptedAt) + 25 * 60_000;
  }

  async markDone(id: string, companyId: string, leaseToken: string, at: string): Promise<boolean> {
    const job = this.map.get(id);
    if (
      !job ||
      job.companyId !== companyId ||
      job.status === 'done' ||
      job.leaseToken !== leaseToken
    ) {
      return false;
    }
    this.map.set(id, {
      ...job,
      notification: null,
      status: 'done',
      leaseToken: null,
      lastError: null,
      updatedAt: at,
    });
    return true;
  }

  async markFailed(
    id: string,
    companyId: string,
    leaseToken: string,
    observedAt: string,
    retryDelayMs: number,
    error: string,
  ): Promise<boolean> {
    const job = this.map.get(id);
    if (
      job &&
      job.companyId === companyId &&
      job.status !== 'done' &&
      job.leaseToken === leaseToken
    ) {
      this.map.set(id, {
        ...job,
        status: 'failed',
        attempts: job.attempts + 1,
        nextAttemptAt: new Date(Date.parse(observedAt) + retryDelayMs).toISOString(),
        leaseToken: null,
        lastError: error.slice(0, 2000),
        updatedAt: observedAt,
      });
      return true;
    }
    return false;
  }

  async listRecent(companyId: string, limit: number): Promise<NotificationJob[]> {
    return [...this.map.values()]
      .filter((job) => job.companyId === companyId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((job) => this.clone(job));
  }

  async previewUnread(companyId: string, observedAt: string): Promise<NotificationUnreadPreview> {
    const unreadCount = [...this.map.values()].filter(
      (job) =>
        job.companyId === companyId &&
        job.readAt === null &&
        job.createdAt < observedAt,
    ).length;
    return { unreadCount, throughCreatedAt: observedAt };
  }

  async markRead(id: string, companyId: string, at: string): Promise<NotificationJob | null> {
    const job = this.map.get(id);
    if (!job || job.companyId !== companyId) return null;
    if (job.readAt !== null) return this.clone(job);
    const read: NotificationJob = { ...job, readAt: at, updatedAt: at };
    this.map.set(id, read);
    return this.clone(read);
  }

  async markReadThrough(
    companyId: string,
    throughCreatedAt: string,
    at: string,
  ): Promise<NotificationReadThroughResult> {
    if (throughCreatedAt > at) return { updatedCount: 0, readAt: at, cutoffAccepted: false };
    let updatedCount = 0;
    for (const [id, job] of this.map.entries()) {
      if (
        job.companyId !== companyId ||
        job.readAt !== null ||
        job.createdAt >= throughCreatedAt
      ) {
        continue;
      }
      this.map.set(id, { ...job, readAt: at, updatedAt: at });
      updatedCount += 1;
    }
    return { updatedCount, readAt: at, cutoffAccepted: true };
  }
}

/** Appareils push Expo (C25) — idempotent sur (companyId, token). */
export class InMemoryDeviceRepository implements DeviceRepository {
  private readonly map = new Map<string, DeviceRecord>();

  async register(input: RegisterDeviceInput): Promise<DeviceRecord> {
    const existing = [...this.map.values()].find(
      (d) => d.companyId === input.companyId && d.expoPushToken === input.expoPushToken,
    );
    if (existing) {
      const updated: DeviceRecord = {
        ...existing,
        userId: input.userId,
        platform: input.platform,
        updatedAt: input.now,
      };
      this.map.set(existing.id, updated);
      return { ...updated };
    }
    const created: DeviceRecord = {
      id: input.id,
      companyId: input.companyId,
      userId: input.userId,
      expoPushToken: input.expoPushToken,
      platform: input.platform,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.map.set(created.id, created);
    return { ...created };
  }

  async listByCompany(companyId: string): Promise<DeviceRecord[]> {
    return [...this.map.values()]
      .filter((d) => d.companyId === companyId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((d) => ({ ...d }));
  }

  async removeByToken(companyId: string, expoPushToken: string): Promise<void> {
    for (const [id, d] of this.map) {
      if (d.companyId === companyId && d.expoPushToken === expoPushToken) this.map.delete(id);
    }
  }
}

export class InMemoryPaymentRepository implements PaymentRepository {
  private readonly list: Payment[] = [];
  async save(p: Payment): Promise<void> {
    this.list.push(p);
  }
  async findById(companyId: string, id: string): Promise<Payment | null> {
    return this.list.find((p) => p.companyId === companyId && p.id === id) ?? null;
  }
  async listByInvoice(invoiceId: string): Promise<Payment[]> {
    return this.list.filter((p) => p.invoiceId === invoiceId);
  }
  async findByIdempotencyKey(companyId: string, key: string): Promise<Payment | null> {
    return this.list.find((p) => p.companyId === companyId && p.idempotencyKey === key) ?? null;
  }
  /** E3 (PONT-SERVEUR v1) : encaissements datés du tenant — CA encaissé annuel (293 B), balance
   *  âgée/prescription. Même extension concrète que le repo in-memory de l'api-client. */
  async listByCompany(companyId: string): Promise<Payment[]> {
    return this.list.filter((p) => p.companyId === companyId);
  }
}

export class InMemoryPublicAccessTokenRepository implements PublicAccessTokenRepository {
  private readonly rows = new Map<string, PublicAccessGrant & { token: string; lastUsedAt: string | null }>();

  async create(input: {
    companyId: string;
    resourceType: 'quote';
    resourceId: string;
    scope: 'quote_signature';
    expiresAt: string;
  }): Promise<{ id: string; token: string }> {
    const id = randomUUID();
    const token = `pst_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
    this.rows.set(id, { id, token, ...input, revokedAt: null, lastUsedAt: null });
    return { id, token };
  }

  async findActive(token: string, at: string): Promise<PublicAccessGrant | null> {
    const row = [...this.rows.values()].find((r) => r.token === token);
    if (!row || row.revokedAt !== null || row.expiresAt <= at) return null;
    return {
      id: row.id,
      companyId: row.companyId,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      scope: row.scope,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    };
  }

  async markUsed(id: string, at: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, lastUsedAt: at });
  }

  async revoke(id: string, at: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, revokedAt: at });
  }

  async revokeActiveFor(input: {
    companyId: string;
    resourceType: 'quote';
    resourceId: string;
    scope: 'quote_signature';
    at: string;
  }): Promise<void> {
    for (const [id, row] of this.rows) {
      if (
        row.companyId === input.companyId &&
        row.resourceType === input.resourceType &&
        row.resourceId === input.resourceId &&
        row.scope === input.scope &&
        row.revokedAt === null &&
        row.expiresAt > input.at
      ) {
        this.rows.set(id, { ...row, revokedAt: input.at });
      }
    }
  }
}

export class InMemoryExpenseRepository implements ExpenseRepository {
  private map = new Map<string, Expense>();
  async save(e: Expense): Promise<void> {
    const props = e.toProps();
    // C-EXP-FIX1 (Bug 1 — DOUBLON TOCTOU) : miroir FIDÈLE de l'index UNIQUE PARTIEL Postgres
    // (companyId, supplierSiren, supplierInvoiceNumber) WHERE supplierInvoiceNumber IS NOT NULL.
    // Deux e-factures identiques (double-tap concurrent qui passe le read-then-write applicatif) NE
    // peuvent PAS coexister. NULL distinct (SIREN ou n° absent) → non contraint, comme Postgres :
    // les dépenses manuelles/OCR restent libres. Check + set SYNCHRONES (atomiques en JS mono-thread).
    const siren = props.supplierSiren ?? null;
    const invoiceNumber = props.supplierInvoiceNumber ?? null;
    if (siren !== null && invoiceNumber !== null) {
      for (const other of this.map.values()) {
        if (other.id === props.id) continue;
        const o = other.toProps();
        if (o.companyId === props.companyId && o.supplierSiren === siren && o.supplierInvoiceNumber === invoiceNumber) {
          throw new DuplicateExpenseInvoiceError(props.companyId, siren, invoiceNumber);
        }
      }
    }
    this.map.set(e.id, e);
  }
  async findById(id: string): Promise<Expense | null> {
    return this.map.get(id) ?? null;
  }
  async listByCompany(companyId: string): Promise<Expense[]> {
    return [...this.map.values()].filter((e) => e.companyId === companyId);
  }

  snapshot(): Map<string, Expense> {
    return new Map([...this.map].map(([id, expense]) => [id, Expense.rehydrate(expense.toProps())]));
  }

  restore(snapshot: Map<string, Expense>): void {
    this.map = new Map([...snapshot].map(([id, expense]) => [id, Expense.rehydrate(expense.toProps())]));
  }
}

export class InMemoryAccountingEntryRepository implements AccountingEntryRepository {
  private map = new Map<string, AccountingEntry>();

  async save(entry: AccountingEntry): Promise<void> {
    this.map.set(entry.id, AccountingEntry.rehydrate(entry.toProps()));
  }

  async findById(companyId: string, id: string): Promise<AccountingEntry | null> {
    const entry = this.map.get(id);
    return entry && entry.companyId === companyId ? AccountingEntry.rehydrate(entry.toProps()) : null;
  }

  async listByCompany(companyId: string): Promise<AccountingEntry[]> {
    return [...this.map.values()]
      .filter((entry) => entry.companyId === companyId)
      .map((entry) => AccountingEntry.rehydrate(entry.toProps()));
  }

  snapshot(): Map<string, AccountingEntry> {
    return new Map([...this.map].map(([id, entry]) => [id, AccountingEntry.rehydrate(entry.toProps())]));
  }

  restore(snapshot: Map<string, AccountingEntry>): void {
    this.map = new Map([...snapshot].map(([id, entry]) => [id, AccountingEntry.rehydrate(entry.toProps())]));
  }
}

export class InMemoryChartOfAccountsRepository implements ChartOfAccountsRepository {
  private readonly map = new Map<string, ChartOfAccounts>();

  async save(chart: ChartOfAccounts): Promise<void> {
    this.map.set(chart.companyId, ChartOfAccounts.rehydrate(chart.toProps()));
  }

  async findByCompany(companyId: string): Promise<ChartOfAccounts | null> {
    const chart = this.map.get(companyId);
    return chart ? ChartOfAccounts.rehydrate(chart.toProps()) : null;
  }
}

export class InMemoryChantierRepository implements ChantierRepository {
  private readonly map = new Map<string, Chantier>();
  async save(c: Chantier): Promise<void> {
    this.map.set(c.id, c);
  }
  async findById(id: string): Promise<Chantier | null> {
    return this.map.get(id) ?? null;
  }
  async listByCompany(companyId: string): Promise<Chantier[]> {
    return [...this.map.values()].filter((c) => c.companyId === companyId);
  }
}

export class InMemorySequenceCounter implements SequenceCounterPort {
  private readonly counters = new Map<string, number>();
  async allocate(input: { companyId: string; counterKey: CounterKey; fiscalYear: number }): Promise<{
    sequence: number;
    formatted: DocNumber;
  }> {
    const key = `${input.companyId}:${input.counterKey}:${input.fiscalYear}`;
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    // D = devis · F = facture · A = avoir (A6) — chaque famille tient SA séquence sans trou.
    const prefix = input.counterKey === 'quote' ? 'D' : input.counterKey === 'credit' ? 'A' : 'F';
    return { sequence: next, formatted: DocNumber.format(prefix, input.fiscalYear, next) };
  }
  // Annulation in-memory (rollback symétrique à la transaction Prisma) : pas de trou si fn() lève.
  snapshot(): Map<string, number> {
    return new Map(this.counters);
  }
  restore(snap: Map<string, number>): void {
    this.counters.clear();
    for (const [k, v] of snap) this.counters.set(k, v);
  }
}

export class UuidGenerator implements IdGeneratorPort {
  newId(): string {
    // Cryptographiquement aléatoire (122 bits) : ids non énumérables — important car l'id de devis
    // sert de jeton dans le lien de signature publique.
    return randomUUID();
  }
}

export class FixtureCashflowSnapshot implements CashflowSnapshotPort {
  constructor(private readonly snapshot: { bankBalance: number; receivables: number; charges: number; vatDue: number }) {}
  async get(_companyId: string): Promise<{ bankBalance: number; receivables: number; charges: number; vatDue: number }> {
    return this.snapshot;
  }
}

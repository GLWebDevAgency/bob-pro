import { randomUUID } from 'node:crypto';
import {
  DocNumber,
  Invoice,
  Quote,
  AccountingEntry,
  ChartOfAccounts,
  type Company,
  type Customer,
  type Document,
  type Payment,
  type Expense,
  type Chantier,
  type CompanyRepository,
  type CustomerRepository,
  type QuoteRepository,
  type InvoiceRepository,
  type DocumentRepository,
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
import type {
  DeliverableNotificationJob,
  EnqueueNotificationJobInput,
  NotificationJob,
  NotificationJobRepository,
} from './notification-jobs';
import type { DeviceRecord, DeviceRepository, RegisterDeviceInput } from './devices';

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
  private readonly map = new Map<string, Quote>();
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
}

export class InMemoryDocumentRepository implements DocumentRepository {
  private readonly map = new Map<string, Document>();
  async save(d: Document): Promise<void> {
    this.map.set(d.id, d);
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

  async enqueue(input: EnqueueNotificationJobInput): Promise<NotificationJob> {
    const existing = [...this.map.values()].find(
      (job) => job.companyId === input.companyId && job.kind === input.kind && job.dedupeKey === input.dedupeKey,
    );
    if (existing) {
      if (existing.status !== 'done') {
        const updated: NotificationJob = {
          ...existing,
          notification: input.notification,
          channel: input.notification.channel,
          recipient: input.notification.to,
          subject: input.notification.subject,
          status: 'pending',
          nextAttemptAt: input.now,
          lastError: null,
          readAt: null, // contenu ré-émis = non lu
          updatedAt: input.now,
        };
        this.map.set(existing.id, updated);
        return { ...updated };
      }
      return { ...existing };
    }

    const created: NotificationJob = {
      id: input.id,
      companyId: input.companyId,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      channel: input.notification.channel,
      recipient: input.notification.to,
      subject: input.notification.subject,
      notification: input.notification,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: input.now,
      lastError: null,
      readAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.map.set(created.id, created);
    return { ...created };
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

  async markDone(id: string, at: string): Promise<void> {
    const job = this.map.get(id);
    if (job) this.map.set(id, { ...job, notification: null, status: 'done', lastError: null, updatedAt: at });
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

  async listRecent(companyId: string, limit: number): Promise<NotificationJob[]> {
    return [...this.map.values()]
      .filter((job) => job.companyId === companyId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((job) => ({ ...job }));
  }

  async markRead(id: string, companyId: string, at: string): Promise<NotificationJob | null> {
    const job = this.map.get(id);
    if (!job || job.companyId !== companyId) return null;
    const read: NotificationJob = { ...job, readAt: job.readAt ?? at, updatedAt: at };
    this.map.set(id, read);
    return { ...read };
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
  private readonly map = new Map<string, Expense>();
  async save(e: Expense): Promise<void> {
    this.map.set(e.id, e);
  }
  async findById(id: string): Promise<Expense | null> {
    return this.map.get(id) ?? null;
  }
  async listByCompany(companyId: string): Promise<Expense[]> {
    return [...this.map.values()].filter((e) => e.companyId === companyId);
  }
}

export class InMemoryAccountingEntryRepository implements AccountingEntryRepository {
  private readonly map = new Map<string, AccountingEntry>();

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
    const prefix = input.counterKey === 'quote' ? 'D' : 'F';
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

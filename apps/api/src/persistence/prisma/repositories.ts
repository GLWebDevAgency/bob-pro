import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { JournalEntry } from '@bob/ai';
import {
  Company,
  Customer,
  Quote,
  Invoice,
  Document,
  Payment,
  Expense,
  DocNumber,
  type CompanyRepository,
  type CustomerRepository,
  type QuoteRepository,
  type InvoiceRepository,
  type DocumentRepository,
  type DocumentProps,
  type DocumentVersionProps,
  type PaymentRepository,
  type PublicAccessGrant,
  type PublicAccessTokenRepository,
  type ExpenseRepository,
  type ExpenseCategory,
  type ExpenseStatus,
  type ExpenseSource,
  type SequenceCounterPort,
  type CounterKey,
} from '@bob/core';
import type {
  DocumentArchiveJob,
  DocumentArchiveJobRepository,
  EnqueueDocumentArchiveJobInput,
} from '../document-archive-jobs';
import type {
  DeliverableNotificationJob,
  EnqueueNotificationJobInput,
  NotificationJob,
  NotificationJobRepository,
} from '../notification-jobs';
import type { AgentJournalRepository } from '../agent-journal';
import { newAgentJournalEntryId } from '../agent-journal';
import type { PrismaService } from './prisma.service';
import {
  companyRowToProps,
  companyPropsToCreate,
  customerRowToProps,
  customerPropsToCreate,
  quoteRowToSnapshot,
  invoiceRowToSnapshot,
  quoteLineToCreate,
  invoiceKindToDocKind,
} from './mappers';

const LINES_INCLUDE = { lines: { orderBy: { position: 'asc' as const } } };
const DOCUMENT_INCLUDE = { versions: { orderBy: { version: 'asc' as const } } };

function publicTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newPublicToken(): string {
  return `pst_${randomBytes(32).toString('base64url')}`;
}

export class PrismaCompanyRepository implements CompanyRepository {
  constructor(private readonly prisma: PrismaService) {}
  async findById(id: string): Promise<Company | null> {
    const row = await this.prisma.client().company.findUnique({ where: { id } });
    if (!row) return null;
    const r = Company.of(companyRowToProps(row));
    return r.ok ? r.value : null;
  }
  async list(): Promise<Company[]> {
    const rows = await this.prisma.client().company.findMany({ orderBy: { id: 'asc' } });
    return rows.map((row) => Company.of(companyRowToProps(row))).flatMap((r) => (r.ok ? [r.value] : []));
  }
  async save(c: Company): Promise<void> {
    const data = companyPropsToCreate(c.toProps());
    await this.prisma.client().company.upsert({ where: { id: data.id }, create: data, update: data });
  }
}

export class PrismaCustomerRepository implements CustomerRepository {
  constructor(private readonly prisma: PrismaService) {}
  async findById(id: string): Promise<Customer | null> {
    const row = await this.prisma.client().customer.findUnique({ where: { id } });
    if (!row) return null;
    const r = Customer.of(customerRowToProps(row));
    return r.ok ? r.value : null;
  }
  async listByCompany(companyId: string): Promise<Customer[]> {
    const rows = await this.prisma.client().customer.findMany({ where: { companyId } });
    return rows.map((row) => Customer.of(customerRowToProps(row))).flatMap((r) => (r.ok ? [r.value] : []));
  }
  async save(c: Customer): Promise<void> {
    const data = customerPropsToCreate(c.toProps());
    await this.prisma.client().customer.upsert({ where: { id: data.id }, create: data, update: data });
  }
}

export class PrismaQuoteRepository implements QuoteRepository {
  constructor(private readonly prisma: PrismaService) {}
  async findById(id: string): Promise<Quote | null> {
    const row = await this.prisma.client().quote.findUnique({ where: { id }, include: LINES_INCLUDE });
    if (!row) return null;
    return Quote.rehydrate(quoteRowToSnapshot(row));
  }
  async lockById(id: string): Promise<Quote | null> {
    const db = this.prisma.client();
    await db.$queryRaw`SELECT id FROM quotes WHERE id = ${id} FOR UPDATE`;
    const row = await db.quote.findUnique({ where: { id }, include: LINES_INCLUDE });
    if (!row) return null;
    return Quote.rehydrate(quoteRowToSnapshot(row));
  }
  async listByCompany(companyId: string): Promise<Quote[]> {
    const rows = await this.prisma.client().quote.findMany({ where: { companyId }, include: LINES_INCLUDE });
    return rows.map((row) => Quote.rehydrate(quoteRowToSnapshot(row)));
  }
  async save(q: Quote): Promise<void> {
    const s = q.toSnapshot();
    const totals = q.totals();
    const base = {
      companyId: s.companyId,
      customerId: s.customerId,
      status: s.status,
      number: s.number,
      depositPct: s.depositPct,
      validUntil: s.validUntil ? new Date(s.validUntil) : null,
      signerName: s.signature?.signerName ?? null,
      signedAt: s.signature ? new Date(s.signature.signedAt) : null,
      totalsHt: totals.ht,
      totalsVat: totals.vat,
      totalsTtc: totals.ttc,
      totalsNetToPay: totals.netToPay,
      vatByRate: totals.vatByRate as Record<string, number>,
    };
    const lines = s.lines.map((l, i) => quoteLineToCreate(l, { quoteId: s.id }, i));
    if (this.prisma.inTransaction()) {
      const tx = this.prisma.client();
      await tx.quote.upsert({ where: { id: s.id }, create: { id: s.id, ...base }, update: base });
      await tx.lineItem.deleteMany({ where: { quoteId: s.id } });
      await tx.lineItem.createMany({ data: lines });
    } else {
      await this.prisma.$transaction([
        this.prisma.quote.upsert({ where: { id: s.id }, create: { id: s.id, ...base }, update: base }),
        this.prisma.lineItem.deleteMany({ where: { quoteId: s.id } }),
        this.prisma.lineItem.createMany({ data: lines }),
      ]);
    }
  }
}

export class PrismaInvoiceRepository implements InvoiceRepository {
  constructor(private readonly prisma: PrismaService) {}
  async findById(id: string): Promise<Invoice | null> {
    const row = await this.prisma.client().invoice.findUnique({ where: { id }, include: LINES_INCLUDE });
    if (!row) return null;
    return Invoice.rehydrate(invoiceRowToSnapshot(row));
  }
  async lockById(id: string): Promise<Invoice | null> {
    // Verrou de ligne DANS la transaction courante (sérialise émission/encaissement concurrents) + reload frais.
    const db = this.prisma.client();
    await db.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR UPDATE`;
    const row = await db.invoice.findUnique({ where: { id }, include: LINES_INCLUDE });
    if (!row) return null;
    return Invoice.rehydrate(invoiceRowToSnapshot(row));
  }
  async findByParentQuoteId(companyId: string, parentQuoteId: string, kind: Invoice['kind']): Promise<Invoice | null> {
    const row = await this.prisma.client().invoice.findFirst({
      where: { companyId, parentQuoteId, kind: invoiceKindToDocKind(kind) },
      include: LINES_INCLUDE,
      orderBy: { id: 'asc' },
    });
    return row ? Invoice.rehydrate(invoiceRowToSnapshot(row)) : null;
  }
  async listByCompany(companyId: string): Promise<Invoice[]> {
    const rows = await this.prisma.client().invoice.findMany({ where: { companyId }, include: LINES_INCLUDE });
    return rows.map((row) => Invoice.rehydrate(invoiceRowToSnapshot(row)));
  }
  async save(i: Invoice): Promise<void> {
    const s = i.toSnapshot();
    const totals = i.totals();
    const base = {
      companyId: s.companyId,
      customerId: s.customerId,
      kind: invoiceKindToDocKind(s.kind),
      status: s.status,
      number: s.number,
      issuedAt: s.issuedAt ? new Date(s.issuedAt) : null,
      dueAt: s.dueAt ? new Date(s.dueAt) : null,
      parentQuoteId: s.parentQuoteId,
      depositPct: s.depositPct,
      paidCents: s.paid,
      totalsHt: totals.ht,
      totalsVat: totals.vat,
      totalsTtc: totals.ttc,
      totalsNetToPay: totals.netToPay,
      vatByRate: totals.vatByRate as Record<string, number>,
      legalMentions: s.mentions,
    };
    const lines = s.lines.map((l, idx) => quoteLineToCreate(l, { invoiceId: s.id }, idx));
    if (this.prisma.inTransaction()) {
      // Déjà dans la transaction d'émission/encaissement : on exécute en séquence sur le client tx.
      const tx = this.prisma.client();
      await tx.invoice.upsert({ where: { id: s.id }, create: { id: s.id, ...base }, update: base });
      await tx.lineItem.deleteMany({ where: { invoiceId: s.id } });
      await tx.lineItem.createMany({ data: lines });
    } else {
      await this.prisma.$transaction([
        this.prisma.invoice.upsert({ where: { id: s.id }, create: { id: s.id, ...base }, update: base }),
        this.prisma.lineItem.deleteMany({ where: { invoiceId: s.id } }),
        this.prisma.lineItem.createMany({ data: lines }),
      ]);
    }
  }
}

interface DocumentVersionRow {
  id: string;
  documentId: string;
  version: number;
  storageKey: string;
  sha256: string;
  mimeType: string;
  byteSize: number;
  createdAt: Date;
  reason: string;
}

interface DocumentRow {
  id: string;
  companyId: string;
  kind: string;
  origin: string;
  status: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  storageKey: string;
  linkedEntityType: string | null;
  linkedEntityId: string | null;
  documentDate: string | null;
  issuedAt: string | null;
  createdAt: Date;
  createdBy: string | null;
  retentionUntil: string;
  deletedAt: Date | null;
  versions: DocumentVersionRow[];
}

function documentRowToProps(row: DocumentRow): DocumentProps {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind as DocumentProps['kind'],
    origin: row.origin as DocumentProps['origin'],
    status: row.status as DocumentProps['status'],
    filename: row.filename,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    sha256: row.sha256,
    storageKey: row.storageKey,
    linkedEntityType: row.linkedEntityType as DocumentProps['linkedEntityType'],
    linkedEntityId: row.linkedEntityId,
    documentDate: row.documentDate,
    issuedAt: row.issuedAt,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    retentionUntil: row.retentionUntil,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    versions: row.versions.map((v) => ({
      id: v.id,
      documentId: v.documentId,
      version: v.version,
      storageKey: v.storageKey,
      sha256: v.sha256,
      mimeType: v.mimeType,
      byteSize: v.byteSize,
      createdAt: v.createdAt.toISOString(),
      reason: v.reason,
    })),
  };
}

function documentPropsToData(p: DocumentProps) {
  return {
    companyId: p.companyId,
    kind: p.kind,
    origin: p.origin,
    status: p.status,
    filename: p.filename,
    mimeType: p.mimeType,
    byteSize: p.byteSize,
    sha256: p.sha256,
    storageKey: p.storageKey,
    linkedEntityType: p.linkedEntityType,
    linkedEntityId: p.linkedEntityId,
    documentDate: p.documentDate,
    issuedAt: p.issuedAt,
    createdAt: new Date(p.createdAt),
    createdBy: p.createdBy,
    retentionUntil: p.retentionUntil,
    deletedAt: p.deletedAt ? new Date(p.deletedAt) : null,
  };
}

function documentVersionPropsToData(v: DocumentVersionProps) {
  return {
    documentId: v.documentId,
    version: v.version,
    storageKey: v.storageKey,
    sha256: v.sha256,
    mimeType: v.mimeType,
    byteSize: v.byteSize,
    createdAt: new Date(v.createdAt),
    reason: v.reason,
  };
}

export class PrismaDocumentRepository implements DocumentRepository {
  constructor(private readonly prisma: PrismaService) {}
  async save(d: Document): Promise<void> {
    const p = d.toProps();
    const db = this.prisma.client();
    await db.storedDocument.upsert({
      where: { id: p.id },
      create: { id: p.id, ...documentPropsToData(p) },
      update: documentPropsToData(p),
    });
    for (const version of p.versions) {
      await db.storedDocumentVersion.upsert({
        where: { id: version.id },
        create: { id: version.id, ...documentVersionPropsToData(version) },
        update: documentVersionPropsToData(version),
      });
    }
  }
  async findById(companyId: string, id: string): Promise<Document | null> {
    const row = await this.prisma.client().storedDocument.findFirst({ where: { id, companyId }, include: DOCUMENT_INCLUDE });
    return row ? Document.rehydrate(documentRowToProps(row)) : null;
  }
  async findByEntity(companyId: string, entityType: string, entityId: string): Promise<Document[]> {
    const rows = await this.prisma.client().storedDocument.findMany({
      where: { companyId, linkedEntityType: entityType as DocumentProps['linkedEntityType'], linkedEntityId: entityId },
      include: DOCUMENT_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => Document.rehydrate(documentRowToProps(row)));
  }
  async listByCompany(companyId: string): Promise<Document[]> {
    const rows = await this.prisma.client().storedDocument.findMany({
      where: { companyId },
      include: DOCUMENT_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => Document.rehydrate(documentRowToProps(row)));
  }
  async listExpired(now: string): Promise<Document[]> {
    const rows = await this.prisma.client().storedDocument.findMany({
      where: { status: 'active', retentionUntil: { lte: now } },
      include: DOCUMENT_INCLUDE,
      orderBy: { retentionUntil: 'asc' },
    });
    return rows.map((row) => Document.rehydrate(documentRowToProps(row)));
  }
}

function archiveJobRowToView(row: {
  id: string;
  companyId: string;
  invoiceId: string;
  reason: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}): DocumentArchiveJob {
  return {
    id: row.id,
    companyId: row.companyId,
    invoiceId: row.invoiceId,
    reason: 'invoice-issued',
    status: row.status as DocumentArchiveJob['status'],
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PrismaDocumentArchiveJobRepository implements DocumentArchiveJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(input: EnqueueDocumentArchiveJobInput): Promise<void> {
    const existing = await this.prisma.client().documentArchiveJob.findUnique({
      where: {
        uniq_document_archive_job: {
          companyId: input.companyId,
          invoiceId: input.invoiceId,
          reason: input.reason,
        },
      },
    });
    if (existing) {
      if (existing.status !== 'done') {
        await this.prisma.client().documentArchiveJob.update({
          where: { id: existing.id },
          data: { status: 'pending', nextAttemptAt: new Date(input.now), lastError: null },
        });
      }
      return;
    }
    await this.prisma.client().documentArchiveJob.create({
      data: {
        id: input.id,
        companyId: input.companyId,
        invoiceId: input.invoiceId,
        reason: input.reason,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(input.now),
      },
    });
  }

  async listDue(companyId: string, now: string, limit: number): Promise<DocumentArchiveJob[]> {
    const rows = await this.prisma.client().documentArchiveJob.findMany({
      where: {
        companyId,
        status: { in: ['pending', 'failed'] },
        nextAttemptAt: { lte: new Date(now) },
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    });
    return rows.map(archiveJobRowToView);
  }

  async markDone(id: string, at: string): Promise<void> {
    await this.prisma.client().documentArchiveJob.update({
      where: { id },
      data: { status: 'done', lastError: null, updatedAt: new Date(at) },
    });
  }

  async markFailed(id: string, at: string, nextAttemptAt: string, error: string): Promise<void> {
    const job = await this.prisma.client().documentArchiveJob.findUnique({ where: { id } });
    if (!job) return;
    await this.prisma.client().documentArchiveJob.update({
      where: { id },
      data: {
        status: 'failed',
        attempts: job.attempts + 1,
        nextAttemptAt: new Date(nextAttemptAt),
        lastError: error.slice(0, 2000),
        updatedAt: new Date(at),
      },
    });
  }
}

function notificationFromJson(value: Prisma.JsonValue | null): NotificationJob['notification'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const channel = candidate.channel;
  const to = candidate.to;
  const subject = candidate.subject;
  const body = candidate.body;
  if ((channel !== 'email' && channel !== 'sms') || typeof to !== 'string' || typeof subject !== 'string' || typeof body !== 'string') {
    return null;
  }
  return { channel, to, subject, body };
}

function notificationJobRowToView(row: {
  id: string;
  companyId: string;
  kind: string;
  dedupeKey: string;
  channel: string;
  recipient: string;
  subject: string;
  payload: Prisma.JsonValue | null;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}): NotificationJob {
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind as NotificationJob['kind'],
    dedupeKey: row.dedupeKey,
    channel: row.channel as NotificationJob['channel'],
    recipient: row.recipient,
    subject: row.subject,
    notification: notificationFromJson(row.payload),
    status: row.status as NotificationJob['status'],
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isDeliverableNotificationJob(job: NotificationJob): job is DeliverableNotificationJob {
  return job.notification !== null;
}

export class PrismaNotificationJobRepository implements NotificationJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(input: EnqueueNotificationJobInput): Promise<NotificationJob> {
    const existing = await this.prisma.client().notificationJob.findUnique({
      where: {
        uniq_notification_job: {
          companyId: input.companyId,
          kind: input.kind,
          dedupeKey: input.dedupeKey,
        },
      },
    });
    if (existing) {
      if (existing.status !== 'done') {
        const row = await this.prisma.client().notificationJob.update({
          where: { id: existing.id },
          data: {
            channel: input.notification.channel,
            recipient: input.notification.to,
            subject: input.notification.subject,
            payload: input.notification as unknown as Prisma.InputJsonValue,
            status: 'pending',
            nextAttemptAt: new Date(input.now),
            lastError: null,
          },
        });
        return notificationJobRowToView(row);
      }
      return notificationJobRowToView(existing);
    }

    const row = await this.prisma.client().notificationJob.create({
      data: {
        id: input.id,
        companyId: input.companyId,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        channel: input.notification.channel,
        recipient: input.notification.to,
        subject: input.notification.subject,
        payload: input.notification as unknown as Prisma.InputJsonValue,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(input.now),
      },
    });
    return notificationJobRowToView(row);
  }

  async listDue(companyId: string, now: string, limit: number): Promise<DeliverableNotificationJob[]> {
    const rows = await this.prisma.client().notificationJob.findMany({
      where: {
        companyId,
        status: { in: ['pending', 'failed'] },
        nextAttemptAt: { lte: new Date(now) },
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    });
    return rows.map(notificationJobRowToView).filter(isDeliverableNotificationJob);
  }

  async markDone(id: string, at: string): Promise<void> {
    await this.prisma.client().notificationJob.update({
      where: { id },
      data: { payload: Prisma.DbNull, status: 'done', lastError: null, updatedAt: new Date(at) },
    });
  }

  async markFailed(id: string, at: string, nextAttemptAt: string, error: string): Promise<void> {
    const job = await this.prisma.client().notificationJob.findUnique({ where: { id } });
    if (!job) return;
    await this.prisma.client().notificationJob.update({
      where: { id },
      data: {
        status: 'failed',
        attempts: job.attempts + 1,
        nextAttemptAt: new Date(nextAttemptAt),
        lastError: error.slice(0, 2000),
        updatedAt: new Date(at),
      },
    });
  }
}

function journalRowToEntry(row: {
  runId: string;
  seq: number;
  at: Date;
  phase: string;
  tool: string;
  label: string;
  args: Prisma.JsonValue;
  mutating: boolean;
  outbound: boolean;
  compliance: string;
  reason: string | null;
  resultDigest: string | null;
}): JournalEntry {
  return {
    seq: row.seq,
    runId: row.runId,
    at: row.at.toISOString(),
    phase: row.phase as 'planned' | 'denied' | 'executed' | 'failed',
    tool: row.tool,
    label: row.label,
    args: (row.args && typeof row.args === 'object' && !Array.isArray(row.args) ? row.args : {}) as Record<string, unknown>,
    mutating: row.mutating,
    outbound: row.outbound,
    compliance: row.compliance as 'low' | 'medium' | 'high',
    ...(row.reason !== null ? { reason: row.reason } : {}),
    ...(row.resultDigest !== null ? { resultDigest: row.resultDigest } : {}),
  };
}

export class PrismaAgentJournalRepository implements AgentJournalRepository {
  constructor(private readonly prisma: PrismaService) {}

  async append(companyId: string, entry: JournalEntry): Promise<void> {
    try {
      await this.prisma.client().agentJournalEntry.create({
        data: {
          id: newAgentJournalEntryId(),
          companyId,
          runId: entry.runId,
          seq: entry.seq,
          at: new Date(entry.at),
          phase: entry.phase,
          tool: entry.tool,
          label: entry.label,
          args: entry.args as Prisma.InputJsonValue,
          mutating: entry.mutating,
          outbound: entry.outbound,
          compliance: entry.compliance,
          reason: entry.reason ?? null,
          resultDigest: entry.resultDigest ?? null,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return;
      throw e;
    }
  }

  async load(companyId: string, runId: string): Promise<JournalEntry[]> {
    const rows = await this.prisma.client().agentJournalEntry.findMany({
      where: { companyId, runId },
      orderBy: { seq: 'asc' },
    });
    return rows.map(journalRowToEntry);
  }
}

export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaService) {}
  async save(p: Payment): Promise<void> {
    // client() => participe à la transaction d'encaissement (paiement + facture atomiques).
    await this.prisma.client().payment.create({
      data: {
        id: p.id,
        companyId: p.companyId,
        invoiceId: p.invoiceId,
        amount: p.amount,
        method: p.method,
        receivedAt: new Date(p.receivedAt),
        idempotencyKey: p.idempotencyKey,
      },
    });
  }
  async findByIdempotencyKey(companyId: string, key: string): Promise<Payment | null> {
    const row = await this.prisma.client().payment.findFirst({ where: { companyId, idempotencyKey: key } });
    if (!row) return null;
    const r = Payment.record({
      id: row.id,
      companyId: row.companyId,
      invoiceId: row.invoiceId,
      amount: row.amount,
      method: row.method,
      receivedAt: row.receivedAt.toISOString(),
      idempotencyKey: row.idempotencyKey,
    });
    return r.ok ? r.value : null;
  }
  async listByInvoice(invoiceId: string): Promise<Payment[]> {
    const rows = await this.prisma.client().payment.findMany({ where: { invoiceId } });
    return rows.flatMap((row) => {
      const r = Payment.record({
        id: row.id,
        companyId: row.companyId,
        invoiceId: row.invoiceId,
        amount: row.amount,
        method: row.method,
        receivedAt: row.receivedAt.toISOString(),
      });
      return r.ok ? [r.value] : [];
    });
  }
}

export class PrismaPublicAccessTokenRepository implements PublicAccessTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    companyId: string;
    resourceType: 'quote';
    resourceId: string;
    scope: 'quote_signature';
    expiresAt: string;
  }): Promise<{ id: string; token: string }> {
    const token = newPublicToken();
    const id = randomUUID();
    await this.prisma.client().publicAccessToken.create({
      data: {
        id,
        companyId: input.companyId,
        tokenHash: publicTokenHash(token),
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        scope: input.scope,
        expiresAt: new Date(input.expiresAt),
      },
    });
    return { id, token };
  }

  async findActive(token: string, at: string): Promise<PublicAccessGrant | null> {
    const tokenHash = publicTokenHash(token);
    return this.prisma.withPublicAccessTokenHash(tokenHash, async () => {
      const row = await this.prisma.client().publicAccessToken.findUnique({ where: { tokenHash } });
      if (!row || row.revokedAt !== null || row.expiresAt <= new Date(at)) return null;
      return {
        id: row.id,
        companyId: row.companyId,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        scope: row.scope,
        expiresAt: row.expiresAt.toISOString(),
        revokedAt: null,
      };
    });
  }

  async markUsed(id: string, at: string): Promise<void> {
    await this.prisma.client().publicAccessToken.update({ where: { id }, data: { lastUsedAt: new Date(at) } });
  }

  async revoke(id: string, at: string): Promise<void> {
    await this.prisma.client().publicAccessToken.update({ where: { id }, data: { revokedAt: new Date(at) } });
  }

  async revokeActiveFor(input: {
    companyId: string;
    resourceType: 'quote';
    resourceId: string;
    scope: 'quote_signature';
    at: string;
  }): Promise<void> {
    await this.prisma.client().publicAccessToken.updateMany({
      where: {
        companyId: input.companyId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        scope: input.scope,
        revokedAt: null,
        expiresAt: { gt: new Date(input.at) },
      },
      data: { revokedAt: new Date(input.at) },
    });
  }
}

export class PrismaExpenseRepository implements ExpenseRepository {
  constructor(private readonly prisma: PrismaService) {}
  async save(e: Expense): Promise<void> {
    const data = e.toProps();
    await this.prisma.client().expense.upsert({ where: { id: data.id }, create: data, update: data });
  }
  async findById(id: string): Promise<Expense | null> {
    const row = await this.prisma.client().expense.findUnique({ where: { id } });
    if (!row) return null;
    return Expense.rehydrate(this.toProps(row));
  }
  async listByCompany(companyId: string): Promise<Expense[]> {
    // Réhydratation (données déjà validées) : ne jamais faire disparaître une dépense persistée
    // — sinon la trésorerie sous-compterait les charges (cf. revue EN 16931 / cashflow).
    const rows = await this.prisma.client().expense.findMany({ where: { companyId } });
    return rows.map((row) => Expense.rehydrate(this.toProps(row)));
  }
  private toProps(row: {
    id: string;
    companyId: string;
    supplierName: string;
    supplierSiren: string | null;
    documentDate: string;
    totalTtcCents: number;
    totalHtCents: number | null;
    vatCents: number | null;
    vatRatePct: number | null;
    category: string;
    status: string;
    source: string;
  }) {
    return {
      id: row.id,
      companyId: row.companyId,
      supplierName: row.supplierName,
      supplierSiren: row.supplierSiren,
      documentDate: row.documentDate,
      totalTtcCents: row.totalTtcCents,
      totalHtCents: row.totalHtCents,
      vatCents: row.vatCents,
      vatRatePct: row.vatRatePct,
      category: row.category as ExpenseCategory,
      status: row.status as ExpenseStatus,
      source: row.source as ExpenseSource,
    };
  }
}

export class PrismaSequenceCounter implements SequenceCounterPort {
  constructor(private readonly prisma: PrismaService) {}
  async allocate(input: { companyId: string; counterKey: CounterKey; fiscalYear: number }): Promise<{
    sequence: number;
    formatted: DocNumber;
  }> {
    // client() => participe à la transaction d'émission (allocation + save facture atomiques = no-gap réel).
    const rows = await this.prisma.client().$queryRaw<{ next_value: number | bigint }[]>`
      INSERT INTO document_counters ("companyId", "counterKey", "fiscalYear", "nextValue")
      VALUES (${input.companyId}, ${input.counterKey}, ${input.fiscalYear}, 1)
      ON CONFLICT ("companyId", "counterKey", "fiscalYear")
      DO UPDATE SET "nextValue" = document_counters."nextValue" + 1
      RETURNING "nextValue" AS next_value`;
    const seq = Number(rows[0]?.next_value ?? 1);
    const prefix = input.counterKey === 'quote' ? 'D' : 'F';
    return { sequence: seq, formatted: DocNumber.format(prefix, input.fiscalYear, seq) };
  }
}

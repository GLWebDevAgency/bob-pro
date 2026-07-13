import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { normalizeSupplierName, type RememberSupplierInput } from '@bob/ai';
import type { JournalEntry } from '@bob/ai';
import {
  Company,
  Customer,
  Quote,
  Invoice,
  Document,
  DocumentFolder,
  Payment,
  Expense,
  ChartOfAccounts,
  AccountingEntry,
  DocNumber,
  type CompanyRepository,
  type CustomerRepository,
  type QuoteRepository,
  type InvoiceRepository,
  type DocumentRepository,
  type DocumentFolderRepository,
  type DocumentFolderMembership,
  type DocumentFolderWriteResult,
  type DocumentFolderMembershipWriteResult,
  type DocumentFolderProps,
  type DocumentProps,
  type DocumentVersionProps,
  type PaymentRepository,
  type PublicAccessGrant,
  type PublicAccessTokenRepository,
  type ExpenseRepository,
  type AccountingEntryProps,
  type AccountingEntryRepository,
  type AccountingAccountProps,
  type ChartOfAccountsRepository,
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
} from '../notification-jobs';
import type { DeviceRecord, DeviceRepository, RegisterDeviceInput } from '../devices';
import type { AgentJournalRepository } from '../agent-journal';
import { newAgentJournalEntryId } from '../agent-journal';
import { DuplicateExpenseInvoiceError } from '../expense-duplicate-error';
import type { SupplierMemoryProfile, SupplierMemoryRepository } from '../supplier-memory';
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
const ACCOUNTING_ENTRY_INCLUDE = { lines: { orderBy: { position: 'asc' as const } } };

function publicTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function newPublicToken(): string {
  return `pst_${randomBytes(32).toString('base64url')}`;
}

function supplierMemoryId(companyId: string, key: string): string {
  return createHash('sha256').update(`${companyId}:${key}`, 'utf8').digest('hex').slice(0, 32);
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
      depositDeductionCents: s.depositDeductionCents ?? 0,
      depositInvoiceId: s.depositInvoiceId ?? null,
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
  folderId: string | null;
  revision: number;
  linkedEntityType: string | null;
  linkedEntityId: string | null;
  documentDate: string | null;
  issuedAt: string | null;
  createdAt: Date;
  createdBy: string | null;
  retentionUntil: string;
  deletedAt: Date | null;
  tags: string[];
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
    folderId: row.folderId,
    revision: row.revision,
    linkedEntityType: row.linkedEntityType as DocumentProps['linkedEntityType'],
    linkedEntityId: row.linkedEntityId,
    documentDate: row.documentDate,
    issuedAt: row.issuedAt,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    retentionUntil: row.retentionUntil,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    tags: row.tags ?? [],
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
    folderId: p.folderId ?? null,
    revision: p.revision ?? 1,
    linkedEntityType: p.linkedEntityType,
    linkedEntityId: p.linkedEntityId,
    documentDate: p.documentDate,
    issuedAt: p.issuedAt,
    createdAt: new Date(p.createdAt),
    createdBy: p.createdBy,
    retentionUntil: p.retentionUntil,
    deletedAt: p.deletedAt ? new Date(p.deletedAt) : null,
    tags: [...p.tags],
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
  async classify(input: {
    companyId: string;
    documentId: string;
    linkedEntityType: NonNullable<DocumentProps['linkedEntityType']>;
    linkedEntityId: string;
    expectedRevision: number;
  }): Promise<'saved' | 'revision_conflict' | 'not_found'> {
    const updated = await this.prisma.client().storedDocument.updateMany({
      where: {
        id: input.documentId,
        companyId: input.companyId,
        status: 'active',
        revision: input.expectedRevision,
      },
      data: {
        linkedEntityType: input.linkedEntityType,
        linkedEntityId: input.linkedEntityId,
        revision: { increment: 1 },
      },
    });
    if (updated.count === 1) return 'saved';
    const exists = await this.prisma.client().storedDocument.findFirst({
      where: { id: input.documentId, companyId: input.companyId, status: 'active' },
      select: { id: true },
    });
    return exists ? 'revision_conflict' : 'not_found';
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

interface DocumentFolderRow {
  id: string;
  companyId: string;
  parentId: string | null;
  name: string;
  normalizedName: string;
  systemKey: string | null;
  status: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

function documentFolderFromRow(row: DocumentFolderRow): DocumentFolder {
  return DocumentFolder.rehydrate({
    id: row.id,
    companyId: row.companyId,
    parentId: row.parentId,
    name: row.name,
    normalizedName: row.normalizedName,
    systemKey: row.systemKey as DocumentFolderProps['systemKey'],
    status: row.status as DocumentFolderProps['status'],
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  });
}

function documentFolderWriteData(folder: DocumentFolder) {
  const props = folder.toProps();
  return {
    parentId: props.parentId,
    name: props.name,
    normalizedName: props.normalizedName,
    systemKey: props.systemKey,
    status: props.status,
    revision: props.revision,
    createdAt: new Date(props.createdAt),
    updatedAt: new Date(props.updatedAt),
    deletedAt: props.deletedAt ? new Date(props.deletedAt) : null,
  };
}

function isPrismaUniqueConflict(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'P2002';
}

export class PrismaDocumentFolderRepository implements DocumentFolderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(companyId: string, folderId: string): Promise<DocumentFolder | null> {
    const row = await this.prisma.client().documentFolder.findFirst({ where: { id: folderId, companyId } });
    return row ? documentFolderFromRow(row) : null;
  }

  async listActiveAncestors(companyId: string, folderId: string): Promise<DocumentFolder[]> {
    const chain: DocumentFolder[] = [];
    const seen = new Set<string>();
    let currentId: string | null = folderId;
    while (currentId !== null && !seen.has(currentId)) {
      seen.add(currentId);
      const row: DocumentFolderRow | null = await this.prisma.client().documentFolder.findFirst({
        where: { id: currentId, companyId, status: 'active' },
      });
      if (!row) return [];
      chain.unshift(documentFolderFromRow(row));
      currentId = row.parentId;
    }
    return currentId === null ? chain : [];
  }

  async listActiveSubtree(companyId: string, folderId: string): Promise<DocumentFolder[]> {
    const rows = await this.prisma.client().documentFolder.findMany({
      where: { companyId, status: 'active' },
      orderBy: [{ normalizedName: 'asc' }, { id: 'asc' }],
    });
    const byParent = new Map<string | null, DocumentFolderRow[]>();
    for (const row of rows) {
      const siblings = byParent.get(row.parentId) ?? [];
      siblings.push(row);
      byParent.set(row.parentId, siblings);
    }
    const root = rows.find((row) => row.id === folderId);
    if (!root) return [];
    const result: DocumentFolder[] = [];
    const queue: DocumentFolderRow[] = [root];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const row = queue.shift()!;
      if (seen.has(row.id)) return [];
      seen.add(row.id);
      result.push(documentFolderFromRow(row));
      queue.push(...(byParent.get(row.id) ?? []));
    }
    return result;
  }

  async listChildren(input: {
    companyId: string;
    parentId: string | null;
    limit: number;
    cursor?: string | null;
  }): Promise<{ items: DocumentFolder[]; nextCursor: string | null }> {
    const rows = await this.prisma.client().documentFolder.findMany({
      where: { companyId: input.companyId, parentId: input.parentId, status: 'active' },
      orderBy: [{ normalizedName: 'asc' }, { id: 'asc' }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    return {
      items: page.map(documentFolderFromRow),
      nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
    };
  }

  async findActiveSiblingByNormalizedName(input: {
    companyId: string;
    parentId: string | null;
    normalizedName: string;
    excludeFolderId?: string;
  }): Promise<DocumentFolder | null> {
    const row = await this.prisma.client().documentFolder.findFirst({
      where: {
        companyId: input.companyId,
        parentId: input.parentId,
        normalizedName: input.normalizedName,
        status: 'active',
        ...(input.excludeFolderId ? { id: { not: input.excludeFolderId } } : {}),
      },
    });
    return row ? documentFolderFromRow(row) : null;
  }

  async save(folder: DocumentFolder, expectedRevision: number | null): Promise<DocumentFolderWriteResult> {
    const props = folder.toProps();
    try {
      if (expectedRevision === null) {
        await this.prisma.client().documentFolder.create({
          data: { id: props.id, companyId: props.companyId, ...documentFolderWriteData(folder) },
        });
        return { status: 'saved' };
      }
      const updated = await this.prisma.client().documentFolder.updateMany({
        where: { id: props.id, companyId: props.companyId, revision: expectedRevision },
        data: documentFolderWriteData(folder),
      });
      return updated.count === 1 ? { status: 'saved' } : { status: 'revision_conflict' };
    } catch (cause) {
      if (isPrismaUniqueConflict(cause)) return { status: 'name_conflict' };
      throw cause;
    }
  }

  async findDocumentMembership(companyId: string, documentId: string): Promise<DocumentFolderMembership | null> {
    const row = await this.prisma.client().storedDocument.findFirst({
      where: { id: documentId, companyId },
      select: { id: true, companyId: true, folderId: true, status: true, revision: true },
    });
    return row
      ? { id: row.id, companyId: row.companyId, folderId: row.folderId, status: row.status, revision: row.revision }
      : null;
  }

  async listDocumentMemberships(companyId: string, folderIds: readonly string[]): Promise<DocumentFolderMembership[]> {
    if (folderIds.length === 0) return [];
    return this.prisma.client().storedDocument.findMany({
      where: { companyId, folderId: { in: [...folderIds] } },
      select: { id: true, companyId: true, folderId: true, status: true, revision: true },
    });
  }

  async moveDocument(input: {
    companyId: string;
    documentId: string;
    targetFolderId: string | null;
    expectedRevision: number;
  }): Promise<DocumentFolderMembershipWriteResult> {
    const updated = await this.prisma.client().storedDocument.updateMany({
      where: {
        id: input.documentId,
        companyId: input.companyId,
        status: 'active',
        revision: input.expectedRevision,
      },
      data: { folderId: input.targetFolderId, revision: { increment: 1 } },
    });
    if (updated.count === 1) return { status: 'saved', revision: input.expectedRevision + 1 };
    const exists = await this.prisma.client().storedDocument.findFirst({
      where: { id: input.documentId, companyId: input.companyId, status: 'active' },
      select: { id: true },
    });
    return exists ? { status: 'revision_conflict' } : { status: 'not_found' };
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

const PROVIDER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function notificationFromJson(value: Prisma.JsonValue | null, expectedJobId: string): NotificationJob['notification'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const channel = candidate.channel;
  const to = candidate.to;
  const subject = candidate.subject;
  const body = candidate.body;
  const idempotencyKey = candidate.idempotencyKey;
  if (
    (channel !== 'email' && channel !== 'sms')
    || typeof to !== 'string'
    || typeof subject !== 'string'
    || typeof body !== 'string'
    || (channel === 'email' && (
      typeof idempotencyKey !== 'string'
      || !PROVIDER_UUID_PATTERN.test(idempotencyKey)
      || idempotencyKey !== expectedJobId
    ))
  ) {
    return null;
  }
  return {
    channel,
    to,
    subject,
    body,
    ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
  };
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
  payloadFingerprint: string | null;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  leaseToken: string | null;
  providerAttemptedAt: Date | null;
  lastError: string | null;
  readAt: Date | null;
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
    notification: notificationFromJson(row.payload, row.id),
    payloadFingerprint: row.payloadFingerprint,
    status: row.status as NotificationJob['status'],
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    leaseToken: row.leaseToken,
    providerAttemptedAt: row.providerAttemptedAt ? row.providerAttemptedAt.toISOString() : null,
    lastError: row.lastError,
    readAt: row.readAt ? row.readAt.toISOString() : null,
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
    const payloadFingerprint = notificationPayloadFingerprint(input.notification);
    if (input.notification.channel === 'email' && input.notification.idempotencyKey !== input.id) {
      throw new Error('La clé provider email doit être égale à l’identifiant immuable du job.');
    }
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
      if (existing.payloadFingerprint !== payloadFingerprint) {
        throw new NotificationDedupeConflictError(input.dedupeKey);
      }
      if (existing.status !== 'done') {
        // Une dedupeKey + UUID provider identifie une requête IMMUABLE. Si Brevo a accepté A
        // avant un crash, remplacer son contenu par B puis recevoir duplicate_parameter ferait
        // croire à tort que B a été livré. Un nouveau contenu exige une nouvelle génération.
        // Un lease orphelin n'est jamais effacé ici : le worker le reprend dans la fenêtre
        // provider ou le met en quarantaine.
        await this.prisma.client().notificationJob.updateMany({
          where: {
            id: existing.id,
            companyId: input.companyId,
            status: { in: ['pending', 'failed'] },
            nextAttemptAt: { lte: new Date(input.now) },
            leaseToken: null,
          },
          data: {
            status: 'pending',
            nextAttemptAt: new Date(input.now),
            lastError: null,
          },
        });
        const current = await this.prisma.client().notificationJob.findUnique({ where: { id: existing.id } });
        if (!current) throw new Error(`Notification job disparu pendant enqueue: ${existing.id}`);
        return notificationJobRowToView(current);
      }
      return notificationJobRowToView(existing);
    }

    // createMany(skipDuplicates) produit INSERT ... ON CONFLICT DO NOTHING sur PostgreSQL.
    // Contrairement à create()+catch P2002, il n'invalide pas la transaction tenant courante.
    await this.prisma.client().notificationJob.createMany({
      data: [
        {
          id: input.id,
          companyId: input.companyId,
          kind: input.kind,
          dedupeKey: input.dedupeKey,
          channel: input.notification.channel,
          recipient: input.notification.to,
          subject: input.notification.subject,
          payload: input.notification as unknown as Prisma.InputJsonValue,
          payloadFingerprint,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: new Date(input.now),
        },
      ],
      skipDuplicates: true,
    });
    const winner = await this.prisma.client().notificationJob.findUnique({
      where: {
        uniq_notification_job: {
          companyId: input.companyId,
          kind: input.kind,
          dedupeKey: input.dedupeKey,
        },
      },
    });
    if (!winner) throw new Error(`Notification job absent après enqueue idempotent: ${input.dedupeKey}`);
    if (winner.payloadFingerprint !== payloadFingerprint) {
      throw new NotificationDedupeConflictError(input.dedupeKey);
    }
    return notificationJobRowToView(winner);
  }

  async findById(companyId: string, id: string): Promise<NotificationJob | null> {
    // companyId explicite = défense anti-IDOR applicative ; FORCE RLS reste le second verrou.
    const row = await this.prisma.client().notificationJob.findFirst({ where: { id, companyId } });
    return row ? notificationJobRowToView(row) : null;
  }

  async listDue(companyId: string, now: string, limit: number): Promise<DeliverableNotificationJob[]> {
    const rows = await this.prisma.client().notificationJob.findMany({
      where: {
        companyId,
        status: { in: ['pending', 'failed'] },
        nextAttemptAt: { lte: new Date(now) },
        NOT: { payload: { equals: Prisma.AnyNull } },
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    });
    return rows.map(notificationJobRowToView).filter(isDeliverableNotificationJob);
  }

  async claimForDelivery(
    id: string,
    companyId: string,
    expectedUpdatedAt: string,
    now: string,
    leaseUntil: string,
    leaseToken: string,
  ): Promise<NotificationDeliveryClaim> {
    // Le payload et son empreinte sont immuables. Le fence utile est donc l'état courant de la
    // ligne (due + token), pas updatedAt : Prisma @updatedAt peut être réécrit par une lecture/
    // ré-enqueue idempotente sans changer l'intention à livrer.
    void expectedUpdatedAt;
    const requestedLeaseMs = new Date(leaseUntil).getTime() - new Date(now).getTime();
    if (!Number.isFinite(requestedLeaseMs) || requestedLeaseMs <= 0 || requestedLeaseMs > 30 * 60_000) {
      throw new Error('Durée de lease notification invalide.');
    }
    // Une seule instruction, une seule horloge et un verrou de ligne : la décision est soit
    // « claim encore couvert par la fenêtre provider », soit « quarantaine », jamais les deux.
    const claimedRows = await this.prisma.client().$queryRaw<Array<{
      quarantined: boolean;
      channelWithoutIdempotency: boolean;
    }>>`
      WITH candidate AS (
        SELECT id,
               (
                 "providerAttemptedAt" IS NOT NULL
                 AND (
                   channel <> 'email'
                   OR "providerAttemptedAt" <= statement_timestamp() - INTERVAL '25 minutes'
                 )
               ) AS quarantine,
               ("providerAttemptedAt" IS NOT NULL AND channel <> 'email') AS channel_without_idempotency
          FROM "notification_jobs"
         WHERE id = ${id}
           AND "companyId" = ${companyId}
           AND status IN ('pending', 'failed')
           AND "nextAttemptAt" <= statement_timestamp()
           AND payload IS NOT NULL
         FOR UPDATE
      ), updated AS (
        UPDATE "notification_jobs" AS job
           SET status = CASE
                 WHEN candidate.quarantine THEN 'failed'::"NotificationJobStatus"
                 ELSE job.status
               END,
               "nextAttemptAt" = CASE
                 WHEN candidate.quarantine THEN TIMESTAMP '9999-12-31 23:59:59.999'
                 ELSE statement_timestamp() + (${requestedLeaseMs} * INTERVAL '1 millisecond')
               END,
               "leaseToken" = CASE WHEN candidate.quarantine THEN NULL ELSE ${leaseToken} END,
               "providerAttemptedAt" = CASE
                 WHEN candidate.quarantine THEN job."providerAttemptedAt"
                 ELSE coalesce(job."providerAttemptedAt", statement_timestamp())
               END,
               "lastError" = CASE
                 WHEN candidate.quarantine
                   THEN '[manual-review:provider-outcome-uncertain] Rejeu automatique interdit.'
                 ELSE job."lastError"
               END,
               "updatedAt" = statement_timestamp()
          FROM candidate
         WHERE job.id = candidate.id
        RETURNING candidate.quarantine AS quarantined,
                  candidate.channel_without_idempotency AS "channelWithoutIdempotency"
      )
      SELECT quarantined, "channelWithoutIdempotency" FROM updated
    `;
    const result = claimedRows[0];
    if (!result) return { outcome: 'skipped' };
    if (result.quarantined) {
      return {
        outcome: 'quarantined',
        reason: result.channelWithoutIdempotency
          ? 'channel-without-idempotency'
          : 'provider-window-expired',
      };
    }
    // On renvoie le payload réellement claimé, pas le snapshot issu de listDue. Même si un
    // ré-enqueue a gagné juste avant le claim, le worker enverra la version courante.
    const row = await this.prisma.client().notificationJob.findUnique({ where: { id } });
    if (!row) return { outcome: 'skipped' };
    const claimed = notificationJobRowToView(row);
    return claimed.notification === null
      ? { outcome: 'skipped' }
      : { outcome: 'claimed', job: { ...claimed, notification: claimed.notification } };
  }

  async authorizeDeliveryAttempt(
    id: string,
    companyId: string,
    leaseToken: string,
    _observedAt: string,
  ): Promise<boolean> {
    const rows = await this.prisma.client().$queryRaw<Array<{ authorized: boolean }>>`
      SELECT EXISTS (
        SELECT 1
          FROM "notification_jobs"
         WHERE id = ${id}
           AND "companyId" = ${companyId}
           AND "leaseToken" = ${leaseToken}
           AND status IN ('pending', 'failed')
           AND "nextAttemptAt" > statement_timestamp()
           AND "providerAttemptedAt" IS NOT NULL
           AND (
             channel <> 'email'
             OR "providerAttemptedAt" > statement_timestamp() - INTERVAL '25 minutes'
           )
      ) AS authorized
    `;
    return rows[0]?.authorized === true;
  }

  async markDone(id: string, companyId: string, leaseToken: string, at: string): Promise<boolean> {
    void at;
    const count = await this.prisma.client().$executeRaw`
      UPDATE "notification_jobs"
         SET payload = NULL,
             status = 'done',
             "leaseToken" = NULL,
             "lastError" = NULL,
             "updatedAt" = statement_timestamp()
       WHERE id = ${id}
         AND "companyId" = ${companyId}
         AND "leaseToken" = ${leaseToken}
         AND status IN ('pending', 'failed')
    `;
    return count === 1;
  }

  async markFailed(
    id: string,
    companyId: string,
    leaseToken: string,
    _observedAt: string,
    retryDelayMs: number,
    error: string,
  ): Promise<boolean> {
    if (!Number.isFinite(retryDelayMs) || retryDelayMs < 1 || retryDelayMs > 120 * 60_000) {
      throw new Error('Délai de retry notification invalide.');
    }
    const count = await this.prisma.client().$executeRaw`
      UPDATE "notification_jobs"
         SET status = 'failed',
             attempts = attempts + 1,
             "nextAttemptAt" = statement_timestamp() + (${retryDelayMs} * INTERVAL '1 millisecond'),
             "leaseToken" = NULL,
             "lastError" = ${error.slice(0, 2000)},
             "updatedAt" = statement_timestamp()
       WHERE id = ${id}
         AND "companyId" = ${companyId}
         AND "leaseToken" = ${leaseToken}
         AND status IN ('pending', 'failed')
    `;
    return count === 1;
  }

  async listRecent(companyId: string, limit: number): Promise<NotificationJob[]> {
    const rows = await this.prisma.client().notificationJob.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(notificationJobRowToView);
  }

  async previewUnread(companyId: string, _observedAt: string): Promise<NotificationUnreadPreview> {
    // Même statement, même horloge et même précision que notification_jobs.createdAt
    // (TIMESTAMP(3)). La borne est EXCLUSIVE : une insertion concurrente au même milliseconde
    // que l'aperçu ne peut pas élargir la portée au moment de la confirmation.
    const rows = await this.prisma.client().$queryRaw<Array<{
      unreadCount: number;
      throughCreatedAt: Date;
    }>>`
      WITH cutoff AS (
        SELECT date_trunc('milliseconds', statement_timestamp() AT TIME ZONE 'UTC') AS value
      )
      SELECT count(job.id)::integer AS "unreadCount",
             cutoff.value AS "throughCreatedAt"
        FROM cutoff
        LEFT JOIN "notification_jobs" AS job
          ON job."companyId" = ${companyId}
         AND job."readAt" IS NULL
         AND job."createdAt" < cutoff.value
       GROUP BY cutoff.value
    `;
    const snapshot = rows[0];
    if (!snapshot) throw new Error('Aperçu des notifications absent.');
    return {
      unreadCount: snapshot.unreadCount,
      throughCreatedAt: snapshot.throughCreatedAt.toISOString(),
    };
  }

  async markRead(id: string, companyId: string, at: string): Promise<NotificationJob | null> {
    // Un seul gagnant pose le premier readAt. companyId reste dans LA mutation, pas seulement
    // dans une prélecture : défense anti-IDOR applicative en plus du FORCE RLS.
    await this.prisma.client().notificationJob.updateMany({
      where: { id, companyId, readAt: null },
      data: { readAt: new Date(at), updatedAt: new Date(at) },
    });
    const current = await this.prisma.client().notificationJob.findFirst({ where: { id, companyId } });
    return current ? notificationJobRowToView(current) : null;
  }

  async markReadThrough(
    companyId: string,
    throughCreatedAt: string,
    _observedAt: string,
  ): Promise<NotificationReadThroughResult> {
    // PostgreSQL valide aussi que la borne n'est pas future. readAt et updatedAt utilisent
    // l'horloge DB ; le résultat reste idempotent grâce au prédicat readAt IS NULL.
    const rows = await this.prisma.client().$queryRaw<Array<{
      updatedCount: number;
      readAt: Date;
      cutoffAccepted: boolean;
    }>>`
      WITH timing AS (
        SELECT (${new Date(throughCreatedAt)}::timestamptz AT TIME ZONE 'UTC')::timestamp(3) AS cutoff,
               date_trunc('milliseconds', statement_timestamp() AT TIME ZONE 'UTC') AS read_at
      ), updated AS (
        UPDATE "notification_jobs" AS job
           SET "readAt" = timing.read_at,
               "updatedAt" = timing.read_at
          FROM timing
         WHERE job."companyId" = ${companyId}
           AND job."readAt" IS NULL
           AND job."createdAt" < timing.cutoff
           AND timing.cutoff <= timing.read_at
        RETURNING timing.read_at AS "readAt"
      )
      SELECT count(updated."readAt")::integer AS "updatedCount",
             timing.read_at AS "readAt",
             timing.cutoff <= timing.read_at AS "cutoffAccepted"
        FROM timing
        LEFT JOIN updated ON TRUE
       GROUP BY timing.read_at, timing.cutoff
    `;
    const result = rows[0];
    if (!result) throw new Error('Résultat de lecture des notifications absent.');
    return {
      updatedCount: result.updatedCount,
      readAt: result.readAt.toISOString(),
      cutoffAccepted: result.cutoffAccepted,
    };
  }
}

/** Appareils push Expo (C25) — idempotent sur (companyId, expoPushToken). */
export class PrismaDeviceRepository implements DeviceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async register(input: RegisterDeviceInput): Promise<DeviceRecord> {
    const row = await this.prisma.client().device.upsert({
      where: { uniq_device_token: { companyId: input.companyId, expoPushToken: input.expoPushToken } },
      create: {
        id: input.id,
        companyId: input.companyId,
        userId: input.userId,
        expoPushToken: input.expoPushToken,
        platform: input.platform,
      },
      update: { userId: input.userId, platform: input.platform },
    });
    return deviceRowToRecord(row);
  }

  async listByCompany(companyId: string): Promise<DeviceRecord[]> {
    const rows = await this.prisma.client().device.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } });
    return rows.map(deviceRowToRecord);
  }

  async removeByToken(companyId: string, expoPushToken: string): Promise<void> {
    await this.prisma.client().device.deleteMany({ where: { companyId, expoPushToken } });
  }
}

function deviceRowToRecord(row: {
  id: string;
  companyId: string;
  userId: string | null;
  expoPushToken: string;
  platform: string | null;
  createdAt: Date;
  updatedAt: Date;
}): DeviceRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId,
    expoPushToken: row.expoPushToken,
    platform: row.platform,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
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

  async claim(companyId: string, entry: JournalEntry): Promise<boolean> {
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
      return true;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false;
      throw e;
    }
  }
}

interface AccountingAccountRow {
  companyId: string;
  code: string;
  label: string;
  kind: string;
  normalSide: string;
  parentCode: string | null;
  active: boolean;
  postingAllowed: boolean;
}

function accountingAccountRowToProps(row: AccountingAccountRow): AccountingAccountProps {
  return {
    code: row.code,
    label: row.label,
    kind: row.kind as AccountingAccountProps['kind'],
    normalSide: row.normalSide as AccountingAccountProps['normalSide'],
    parentCode: row.parentCode,
    active: row.active,
    postingAllowed: row.postingAllowed,
  };
}

function accountingAccountPropsToData(companyId: string, account: AccountingAccountProps) {
  return {
    companyId,
    code: account.code,
    label: account.label,
    kind: account.kind,
    normalSide: account.normalSide,
    parentCode: account.parentCode,
    active: account.active,
    postingAllowed: account.postingAllowed,
  };
}

export class PrismaChartOfAccountsRepository implements ChartOfAccountsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(chart: ChartOfAccounts): Promise<void> {
    const props = chart.toProps();
    const codes = props.accounts.map((account) => account.code);
    const persist = async () => {
      const db = this.prisma.client();
      await db.accountingAccount.deleteMany({
        where: { companyId: props.companyId, code: { notIn: codes } },
      });
      for (const account of props.accounts) {
        const data = accountingAccountPropsToData(props.companyId, account);
        await db.accountingAccount.upsert({
          where: { companyId_code: { companyId: props.companyId, code: account.code } },
          create: data,
          update: data,
        });
      }
    };
    if (this.prisma.inTransaction()) {
      await persist();
    } else {
      await this.prisma.runInTransaction(persist);
    }
  }

  async findByCompany(companyId: string): Promise<ChartOfAccounts | null> {
    const rows = await this.prisma.client().accountingAccount.findMany({
      where: { companyId },
      orderBy: { code: 'asc' },
    });
    if (rows.length === 0) return null;
    return ChartOfAccounts.rehydrate({ companyId, accounts: rows.map(accountingAccountRowToProps) });
  }
}

interface AccountingEntryLineRow {
  position: number;
  account: string;
  label: string;
  debitCents: number;
  creditCents: number;
}

interface AccountingEntryRow {
  id: string;
  companyId: string;
  journal: string;
  sourceType: string;
  sourceId: string;
  entryDate: string;
  reference: string;
  label: string;
  lines: AccountingEntryLineRow[];
}

function accountingEntryRowToProps(row: AccountingEntryRow): AccountingEntryProps {
  return {
    id: row.id,
    companyId: row.companyId,
    journal: row.journal as AccountingEntryProps['journal'],
    sourceType: row.sourceType as AccountingEntryProps['sourceType'],
    sourceId: row.sourceId,
    entryDate: row.entryDate,
    reference: row.reference,
    label: row.label,
    lines: row.lines.map((line) => ({
      account: line.account,
      label: line.label,
      debitCents: line.debitCents,
      creditCents: line.creditCents,
    })),
  };
}

function accountingEntryLineId(entryId: string, index: number): string {
  return `${entryId}:line:${String(index + 1).padStart(4, '0')}`;
}

export class PrismaAccountingEntryRepository implements AccountingEntryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(entry: AccountingEntry): Promise<void> {
    const props = entry.toProps();
    const persist = async () => {
      const db = this.prisma.client();
      await db.accountingEntry.upsert({
        where: { id: props.id },
        create: {
          id: props.id,
          companyId: props.companyId,
          journal: props.journal,
          sourceType: props.sourceType,
          sourceId: props.sourceId,
          entryDate: props.entryDate,
          reference: props.reference,
          label: props.label,
        },
        update: {
          companyId: props.companyId,
          journal: props.journal,
          sourceType: props.sourceType,
          sourceId: props.sourceId,
          entryDate: props.entryDate,
          reference: props.reference,
          label: props.label,
        },
      });
      await db.accountingEntryLine.deleteMany({ where: { entryId: props.id } });
      await db.accountingEntryLine.createMany({
        data: props.lines.map((line, index) => ({
          id: accountingEntryLineId(props.id, index),
          companyId: props.companyId,
          entryId: props.id,
          position: index + 1,
          account: line.account,
          label: line.label,
          debitCents: line.debitCents,
          creditCents: line.creditCents,
        })),
      });
    };
    if (this.prisma.inTransaction()) {
      await persist();
    } else {
      await this.prisma.runInTransaction(persist);
    }
  }

  async findById(companyId: string, id: string): Promise<AccountingEntry | null> {
    const row = await this.prisma.client().accountingEntry.findFirst({
      where: { companyId, id },
      include: ACCOUNTING_ENTRY_INCLUDE,
    });
    return row ? AccountingEntry.rehydrate(accountingEntryRowToProps(row)) : null;
  }

  async listByCompany(companyId: string): Promise<AccountingEntry[]> {
    const rows = await this.prisma.client().accountingEntry.findMany({
      where: { companyId },
      include: ACCOUNTING_ENTRY_INCLUDE,
      orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => AccountingEntry.rehydrate(accountingEntryRowToProps(row)));
  }
}

export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  private rowToPayment(row: {
    id: string;
    companyId: string;
    invoiceId: string;
    amount: number;
    method: string;
    receivedAt: Date;
    idempotencyKey: string | null;
  }): Payment | null {
    const r = Payment.record({
      id: row.id,
      companyId: row.companyId,
      invoiceId: row.invoiceId,
      amount: row.amount,
      method: row.method as Payment['method'],
      receivedAt: row.receivedAt.toISOString(),
      idempotencyKey: row.idempotencyKey,
    });
    return r.ok ? r.value : null;
  }

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
  async findById(companyId: string, id: string): Promise<Payment | null> {
    const row = await this.prisma.client().payment.findFirst({ where: { companyId, id } });
    return row ? this.rowToPayment(row) : null;
  }
  async findByIdempotencyKey(companyId: string, key: string): Promise<Payment | null> {
    const row = await this.prisma.client().payment.findFirst({ where: { companyId, idempotencyKey: key } });
    return row ? this.rowToPayment(row) : null;
  }
  async listByInvoice(invoiceId: string): Promise<Payment[]> {
    const rows = await this.prisma.client().payment.findMany({ where: { invoiceId } });
    return rows.flatMap((row) => {
      const payment = this.rowToPayment(row);
      return payment ? [payment] : [];
    });
  }
  /** E3 (PONT-SERVEUR v1) : encaissements datés du tenant — CA encaissé annuel (293 B), balance
   *  âgée/prescription. Tri chronologique stable (findMany sans orderBy est non déterministe). */
  async listByCompany(companyId: string): Promise<Payment[]> {
    const rows = await this.prisma.client().payment.findMany({ where: { companyId }, orderBy: { receivedAt: 'asc' } });
    return rows.flatMap((row) => {
      const payment = this.rowToPayment(row);
      return payment ? [payment] : [];
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
    try {
      await this.prisma.client().expense.upsert({ where: { id: data.id }, create: data, update: data });
    } catch (err) {
      // C-EXP-FIX1 (Bug 1 — DOUBLON TOCTOU) : l'index UNIQUE PARTIEL uniq_expense_supplier_invoice
      // rejette la 2e e-facture concurrente (P2002). On la traduit en sentinelle métier (jamais un
      // 500) ; l'upsert par id ne peut violer QUE cet index (le conflit d'id, lui, fait un update).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new DuplicateExpenseInvoiceError(data.companyId, data.supplierSiren, data.supplierInvoiceNumber ?? null);
      }
      throw err;
    }
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
    supplierInvoiceNumber: string | null;
    dueAt: string | null;
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
      // C-EXP6b — champs Factur-X (additifs, null pour l'historique OCR/manuel).
      supplierInvoiceNumber: row.supplierInvoiceNumber,
      dueAt: row.dueAt,
    };
  }
}

export class PrismaSupplierMemoryRepository implements SupplierMemoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async supplierProfile(companyId: string, supplierName: string): Promise<SupplierMemoryProfile | null> {
    const key = normalizeSupplierName(supplierName);
    if (!key) return null;
    const row = await this.prisma.client().supplierMemoryProfile.findUnique({
      where: { uniq_supplier_memory_company_key: { companyId, key } },
    });
    return row ? this.toProfile(row) : null;
  }

  async rememberSupplier(companyId: string, input: RememberSupplierInput, at: string): Promise<SupplierMemoryProfile> {
    const key = normalizeSupplierName(input.name);
    const row = await this.prisma.client().supplierMemoryProfile.upsert({
      where: { uniq_supplier_memory_company_key: { companyId, key } },
      create: {
        id: supplierMemoryId(companyId, key),
        companyId,
        key,
        displayName: input.name.trim() || input.name,
        siren: input.siren ?? null,
        category: input.category,
        vatRatePct: input.vatRatePct ?? null,
        seen: 1,
        lastSeenAt: new Date(at),
      },
      update: {
        displayName: input.name.trim() || input.name,
        ...(input.siren !== undefined && input.siren !== null ? { siren: input.siren } : {}),
        category: input.category,
        ...(input.vatRatePct !== undefined && input.vatRatePct !== null ? { vatRatePct: input.vatRatePct } : {}),
        seen: { increment: 1 },
        lastSeenAt: new Date(at),
      },
    });
    return this.toProfile(row);
  }

  async knownSupplierNames(companyId: string): Promise<string[]> {
    const rows = await this.prisma.client().supplierMemoryProfile.findMany({
      where: { companyId },
      orderBy: { displayName: 'asc' },
      select: { displayName: true },
    });
    return rows.map((row) => row.displayName);
  }

  private toProfile(row: {
    companyId: string;
    key: string;
    displayName: string;
    siren: string | null;
    category: string;
    vatRatePct: number | null;
    seen: number;
    lastSeenAt: Date;
  }): SupplierMemoryProfile {
    return {
      companyId: row.companyId,
      key: row.key,
      displayName: row.displayName,
      siren: row.siren,
      category: row.category as ExpenseCategory,
      vatRatePct: row.vatRatePct,
      seen: row.seen,
      lastSeenAt: row.lastSeenAt.toISOString(),
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
    // D = devis · F = facture · A = avoir (A6, CounterKey 'credit') — trois familles, trois séquences
    // sans trou ; la table document_counters est générique (counterKey texte), aucune migration.
    const prefix = input.counterKey === 'quote' ? 'D' : input.counterKey === 'credit' ? 'A' : 'F';
    return { sequence: seq, formatted: DocNumber.format(prefix, input.fiscalYear, seq) };
  }
}

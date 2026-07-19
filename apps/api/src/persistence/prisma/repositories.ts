import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma, type Company as PrismaCompanyRow } from '@prisma/client';
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
  type PublicAccessResourceType,
  type PublicAccessScope,
  type ExpenseRepository,
  type AccountingEntryProps,
  type AccountingEntryRepository,
  type AccountingAccountProps,
  type ChartOfAccountsRepository,
  type ExpenseCategory,
  type SequenceCounterPort,
  type CounterKey,
  type SubscriptionRecord,
  type SubscriptionRepository,
  FiscalProfile,
  type FiscalProfileProps,
  type FiscalProfileRepository,
} from '@bob/core';
import type { ServerCompanyRepository } from '../persistence';
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
import type {
  DeviceRecord,
  DeviceRegistrationResult,
  DeviceRepository,
  InvalidPushDeliveryTarget,
  PushDeliveryTarget,
  RegisterDeviceInput,
  RevokeDeviceThroughInput,
} from '../devices';
import type { AgentJournalRepository } from '../agent-journal';
import { newAgentJournalEntryId } from '../agent-journal';
import { DuplicateExpenseInvoiceError } from '../expense-duplicate-error';
import { SituationOrderConflictError } from '../situation-order-conflict-error';
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
  signatureProofToPersistence,
  purchaseOrderToPersistence,
  expenseRowToProps,
  expensePropsToPersistence,
  discountToColumns,
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

type PersistedAggregateResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

type PersistedAggregateKind = 'company' | 'customer' | 'payment' | 'fiscal-profile';

/**
 * A row that exists in PostgreSQL but cannot satisfy the current domain invariants is corruption,
 * never an absent business object. Keeping this error stable lets the HTTP boundary report an
 * unavailable state and observability alert operators without fabricating an empty projection.
 */
export class PersistedDataCorruptionError extends Error {
  readonly code = 'PERSISTED_DATA_CORRUPTION' as const;

  constructor(
    readonly aggregate: PersistedAggregateKind,
    readonly recordId: string,
  ) {
    super(`PERSISTED_DATA_CORRUPTION:${aggregate}:${recordId}`);
    this.name = 'PersistedDataCorruptionError';
  }
}

function requirePersistedAggregate<T>(
  aggregate: PersistedAggregateKind,
  recordId: string,
  result: PersistedAggregateResult<T>,
): T {
  if (result.ok) return result.value;
  throw new PersistedDataCorruptionError(aggregate, recordId);
}

function requireActiveTransaction(prisma: PrismaService, operation: string): void {
  if (!prisma.inTransaction()) {
    throw new Error(`${operation} requires an active transaction.`);
  }
}

export class PrismaCompanyRepository implements ServerCompanyRepository {
  constructor(private readonly prisma: PrismaService) {}
  private toDomain(row: PrismaCompanyRow): Company {
    return requirePersistedAggregate('company', row.id, Company.of(companyRowToProps(row)));
  }
  async findById(id: string): Promise<Company | null> {
    const row = await this.prisma.client().company.findUnique({ where: { id } });
    if (!row) return null;
    return this.toDomain(row);
  }
  async lockById(id: string): Promise<Company | null> {
    requireActiveTransaction(this.prisma, 'Company lifecycle exclusive lock');
    const db = this.prisma.client();
    await db.$queryRaw`SELECT id FROM companies WHERE id = ${id} FOR UPDATE`;
    const row = await db.company.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }
  async lockForShareById(id: string): Promise<Company | null> {
    requireActiveTransaction(this.prisma, 'Company lifecycle shared lock');
    const db = this.prisma.client();
    await db.$queryRaw`SELECT id FROM companies WHERE id = ${id} FOR SHARE`;
    const row = await db.company.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }
  async list(): Promise<Company[]> {
    const rows = await this.prisma.client().company.findMany({ orderBy: { id: 'asc' } });
    return rows.map((row) => this.toDomain(row));
  }
  async createIfAbsentOpen(c: Company) {
    requireActiveTransaction(this.prisma, 'Company create-if-absent');
    if (c.isClosed()) throw new Error('COMPANY_REGISTRATION_CANNOT_CREATE_CLOSED_COMPANY');
    const data = companyPropsToCreate(c.toProps());
    const created = await this.prisma.client().company.createMany({
      data: [data],
      skipDuplicates: true,
    });
    if (created.count === 1) return 'created' as const;
    // Même id : retry idempotent. Si aucun row n'est visible, un autre identifiant légal unique
    // (notamment le SIRET) appartient déjà à une autre company ; ne jamais révéler son tenant.
    return (await this.findById(c.id)) === null ? 'identity_conflict' : ('existing' as const);
  }
  async save(c: Company): Promise<void> {
    requireActiveTransaction(this.prisma, 'Company lifecycle write');
    const data = companyPropsToCreate(c.toProps());
    const { id, ...update } = data;
    // Transition monotone : une row clôturée n'est jamais modifiée et `closedAt` ne peut jamais
    // revenir à NULL. Tous les writers prennent d'abord lockById dans la même transaction.
    const written = await this.prisma.client().company.updateMany({
      where: { id, closedAt: null },
      data: update,
    });
    if (written.count !== 1) throw new Error('COMPANY_NOT_OPEN_FOR_UPDATE');
  }
}

export class PrismaCustomerRepository implements CustomerRepository {
  constructor(private readonly prisma: PrismaService) {}
  async findById(id: string): Promise<Customer | null> {
    const row = await this.prisma.client().customer.findUnique({ where: { id } });
    if (!row) return null;
    return requirePersistedAggregate('customer', row.id, Customer.of(customerRowToProps(row)));
  }
  async listByCompany(companyId: string): Promise<Customer[]> {
    const rows = await this.prisma.client().customer.findMany({ where: { companyId } });
    return rows.map((row) =>
      requirePersistedAggregate('customer', row.id, Customer.of(customerRowToProps(row))),
    );
  }
  async save(c: Customer): Promise<void> {
    const data = customerPropsToCreate(c.toProps());
    await this.prisma
      .client()
      .customer.upsert({ where: { id: data.id }, create: data, update: data });
  }
}

export class PrismaQuoteRepository implements QuoteRepository {
  constructor(private readonly prisma: PrismaService) {}
  async findById(id: string): Promise<Quote | null> {
    const row = await this.prisma
      .client()
      .quote.findUnique({ where: { id }, include: LINES_INCLUDE });
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
  async lockForShareById(id: string): Promise<Quote | null> {
    requireActiveTransaction(this.prisma, 'Quote public read lock');
    const db = this.prisma.client();
    await db.$queryRaw`SELECT id FROM quotes WHERE id = ${id} FOR SHARE`;
    const row = await db.quote.findUnique({ where: { id }, include: LINES_INCLUDE });
    return row ? Quote.rehydrate(quoteRowToSnapshot(row)) : null;
  }
  async listByCompany(companyId: string): Promise<Quote[]> {
    const rows = await this.prisma
      .client()
      .quote.findMany({ where: { companyId }, include: LINES_INCLUDE });
    return rows.map((row) => Quote.rehydrate(quoteRowToSnapshot(row)));
  }
  async save(q: Quote): Promise<void> {
    const s = q.toSnapshot();
    const totals = q.totals();
    // R4 : la preuve honnête (méthode réelle + hash de tracé éventuel) est persistée en JSON ;
    // une signature `legacy_declared` reste NULL — on ne réinvente jamais une méthode.
    const signatureProof = signatureProofToPersistence(s.signature);
    const base = {
      companyId: s.companyId,
      customerId: s.customerId,
      status: s.status,
      number: s.number,
      depositPct: s.depositPct,
      validUntil: s.validUntil ? new Date(s.validUntil) : null,
      // A1 : date d'établissement dérivée à l'envoi par l'agrégat — NULL tant que brouillon.
      issuedAt: s.issuedAt ? new Date(s.issuedAt) : null,
      signerName: s.signature?.signerName ?? null,
      signedAt: s.signature ? new Date(s.signature.signedAt) : null,
      // A3 — demande d'exécution anticipée (L221-25) : horodatage serveur tracé à la signature,
      // NULL si jamais demandée — le gel de rétractation de la facture finale en dépend.
      earlyExecutionRequestedAt: s.signature?.earlyExecution
        ? new Date(s.signature.earlyExecution.requestedAt)
        : null,
      // A3 — qualité du client figée à la conclusion (SignQuote) ; NULL pour les signatures
      // antérieures au figeage — jamais rétro-rempli depuis la fiche courante.
      signatureCustomerType: s.signature?.customerType ?? null,
      // A3 — rétractation en ligne (L221-21) : fait horodaté serveur, NULL = jamais exercée.
      retractedAt: s.retractedAt ? new Date(s.retractedAt) : null,
      // Exception dépannage urgent (L221-10, al. 2) : posée à la création, immuable, NULL sinon.
      urgentRepairRequestedAt: s.urgentRepair ? new Date(s.urgentRepair.requestedAt) : null,
      signatureProof:
        signatureProof === null
          ? Prisma.DbNull
          : (signatureProof as unknown as Prisma.InputJsonValue),
      totalsHt: totals.ht,
      totalsVat: totals.vat,
      totalsTtc: totals.ttc,
      totalsNetToPay: totals.netToPay,
      vatByRate: totals.vatByRate as Record<string, number>,
      // B8 : bon de commande + révision optimiste (le CAS final est porté par lockById
      // dans la transaction tenant de l'adaptateur appelant).
      ...purchaseOrderToPersistence(s.purchaseOrder),
      // B3/B5 : remise globale (exclusive % OU montant) et retenue de garantie stipulée.
      globalDiscountPercent: discountToColumns(s.globalDiscount).percent,
      globalDiscountAmountCents: discountToColumns(s.globalDiscount).amountCents,
      retenueGarantiePct: s.retenueGarantiePct ?? null,
      revision: s.revision ?? 1,
    };
    const lines = s.lines.map((l, i) => quoteLineToCreate(l, { quoteId: s.id }, i));
    if (this.prisma.inTransaction()) {
      const tx = this.prisma.client();
      await tx.quote.upsert({ where: { id: s.id }, create: { id: s.id, ...base }, update: base });
      await tx.lineItem.deleteMany({ where: { quoteId: s.id } });
      await tx.lineItem.createMany({ data: lines });
    } else {
      await this.prisma.$transaction([
        this.prisma.quote.upsert({
          where: { id: s.id },
          create: { id: s.id, ...base },
          update: base,
        }),
        this.prisma.lineItem.deleteMany({ where: { quoteId: s.id } }),
        this.prisma.lineItem.createMany({ data: lines }),
      ]);
    }
  }
}

export class PrismaInvoiceRepository implements InvoiceRepository {
  constructor(private readonly prisma: PrismaService) {}
  async findById(id: string): Promise<Invoice | null> {
    const row = await this.prisma
      .client()
      .invoice.findUnique({ where: { id }, include: LINES_INCLUDE });
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
  async lockForShareById(id: string): Promise<Invoice | null> {
    requireActiveTransaction(this.prisma, 'Invoice public read lock');
    const db = this.prisma.client();
    await db.$queryRaw`SELECT id FROM invoices WHERE id = ${id} FOR SHARE`;
    const row = await db.invoice.findUnique({ where: { id }, include: LINES_INCLUDE });
    return row ? Invoice.rehydrate(invoiceRowToSnapshot(row)) : null;
  }
  async findByParentQuoteId(
    companyId: string,
    parentQuoteId: string,
    kind: Invoice['kind'],
  ): Promise<Invoice | null> {
    const row = await this.prisma.client().invoice.findFirst({
      where: { companyId, parentQuoteId, kind: invoiceKindToDocKind(kind) },
      include: LINES_INCLUDE,
      orderBy: { id: 'asc' },
    });
    return row ? Invoice.rehydrate(invoiceRowToSnapshot(row)) : null;
  }
  async findCreditNoteBySourceInvoiceId(
    companyId: string,
    sourceInvoiceId: string,
  ): Promise<Invoice | null> {
    const row = await this.prisma.client().invoice.findFirst({
      where: { companyId, sourceInvoiceId, kind: 'credit_note' },
      include: LINES_INCLUDE,
    });
    return row ? Invoice.rehydrate(invoiceRowToSnapshot(row)) : null;
  }
  async listByCompany(companyId: string): Promise<Invoice[]> {
    const rows = await this.prisma
      .client()
      .invoice.findMany({ where: { companyId }, include: LINES_INCLUDE });
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
      // A7 : figés à l'émission par le domaine (le trigger legal_traceability les verrouille).
      servicePeriodStart: s.servicePeriod ? new Date(s.servicePeriod.start) : null,
      servicePeriodEnd: s.servicePeriod?.end ? new Date(s.servicePeriod.end) : null,
      deliveryAddress: s.deliveryAddress ?? null,
      parentQuoteId: s.parentQuoteId,
      sourceInvoiceId: s.sourceInvoiceId ?? null,
      sourceInvoiceKind: s.sourceInvoiceKind ? invoiceKindToDocKind(s.sourceInvoiceKind) : null,
      sourceInvoiceNumber: s.sourceInvoiceNumber ?? null,
      sourceInvoiceIssuedAt: s.sourceInvoiceIssuedAt ? new Date(s.sourceInvoiceIssuedAt) : null,
      depositPct: s.depositPct,
      depositDeductionCents: s.depositDeductionCents ?? 0,
      depositInvoiceId: s.depositInvoiceId ?? null,
      paidCents: s.paid,
      totalsHt: totals.ht,
      totalsVat: totals.vat,
      totalsTtc: totals.ttc,
      totalsNetToPay: totals.netToPay,
      vatByRate: totals.vatByRate as Record<string, number>,
      // B3/B5 : compléments de totaux PRÉSENTS uniquement quand le fait existe (NULL sinon —
      // les pièces antérieures restent identiques au centime).
      totalsGrossHt: totals.grossHt ?? null,
      totalsDiscountCents: totals.discountCents ?? null,
      totalsRetenueGarantieCents: totals.retenueGarantieCents ?? null,
      // B2 : situation de travaux (n° d'ordre) + part « situations » de la déduction de la finale.
      situationOrder: s.situationOrder ?? null,
      situationDeductionCents: s.situationDeductionCents ?? 0,
      // B3/B5 : remise globale (exclusive % OU montant) et retenue de garantie de la pièce.
      globalDiscountPercent: discountToColumns(s.globalDiscount).percent,
      globalDiscountAmountCents: discountToColumns(s.globalDiscount).amountCents,
      retenueGarantiePct: s.retenueGarantiePct ?? null,
      // B1/A3bis : qualification d'urgence posée à la composition, immuable.
      urgentRepairRequestedAt: s.urgentRepair ? new Date(s.urgentRepair.requestedAt) : null,
      // Suivi MANUEL de transmission — mutable après émission (hors liste du trigger).
      transmissionDepositedAt: s.transmission?.depositedAt
        ? new Date(s.transmission.depositedAt)
        : null,
      transmissionAcceptedAt: s.transmission?.acceptedAt
        ? new Date(s.transmission.acceptedAt)
        : null,
      legalMentions: s.mentions,
      // A4 : régime de TVA constaté et figé à l'émission (IssueInvoice) — NULL avant émission
      // et pour les pièces émises avant le figeage.
      vatTreatmentAtIssuance: s.vatTreatmentAtIssuance ?? null,
      // B8 : bon de commande (repris du devis ou attaché en brouillon) + révision optimiste.
      ...purchaseOrderToPersistence(s.purchaseOrder),
      revision: s.revision ?? 1,
    };
    const lines = s.lines.map((l, idx) => quoteLineToCreate(l, { invoiceId: s.id }, idx));
    const persist = async (): Promise<void> => {
      const tx = this.prisma.client();
      const existing = await tx.invoice.findUnique({
        where: { id: s.id },
        select: { id: true, status: true },
      });
      if (!existing) {
        if (s.kind === 'credit_note') {
          const sourceInvoiceId = s.sourceInvoiceId;
          if (!sourceInvoiceId) throw new Error('Credit note source invoice id is required.');
          // Native UPSERT sur l'identité légale de la source : deux créations concurrentes
          // convergent sans unique_violation, donc sans empoisonner la transaction tenant.
          const published = await tx.invoice.upsert({
            where: { uniq_credit_note_source_invoice: { companyId: s.companyId, sourceInvoiceId } },
            create: { id: s.id, ...base },
            update: { sourceInvoiceId },
            select: { id: true },
          });
          if (published.id === s.id && lines.length > 0)
            await tx.lineItem.createMany({ data: lines });
          return;
        }
        try {
          await tx.invoice.create({ data: { id: s.id, ...base } });
        } catch (cause) {
          // B2 — index unique partiel uniq_invoice_parent_quote_situation_order : deux
          // générations CONCURRENTES de situation calculent le même n° d'ordre (max + 1) —
          // la base tranche, la sentinelle typée remonte en conflit 409 rejouable (jamais
          // un 500 ni un duplicata de « Situation n°N » imprimé).
          if (
            cause instanceof Prisma.PrismaClientKnownRequestError &&
            cause.code === 'P2002' &&
            s.kind === 'situation' &&
            s.parentQuoteId !== null &&
            typeof s.situationOrder === 'number'
          ) {
            throw new SituationOrderConflictError(s.companyId, s.parentQuoteId, s.situationOrder);
          }
          throw cause;
        }
        if (lines.length > 0) await tx.lineItem.createMany({ data: lines });
        return;
      }

      // Tant que la ligne parente est encore `draft`, on publie d'abord son contenu courant.
      // C'est indispensable si l'appelant ajoute une ligne puis émet dans une même transaction :
      // après le passage à `issued`, le trigger légal interdit toute réécriture des lignes.
      // Un avoir total, lui, est figé depuis sa création même lorsqu'il est encore brouillon.
      if (existing.status === 'draft' && s.kind !== 'credit_note') {
        await tx.lineItem.deleteMany({ where: { invoiceId: s.id } });
        if (lines.length > 0) await tx.lineItem.createMany({ data: lines });
      }
      await tx.invoice.update({ where: { id: s.id }, data: base });
    };
    if (this.prisma.inTransaction()) await persist();
    else await this.prisma.runInTransaction(persist);
  }
  /**
   * R6 : suppression DÉFINITIVE d'une facture BROUILLON (le use case DeleteDraftInvoice garde le
   * statut avant appel). Les lignes n'ont PAS de cascade DB (FK optionnelle -> SET NULL par
   * défaut) : on les supprime explicitement d'abord, comme `save` le fait pour un brouillon éditable.
   */
  async deleteById(id: string): Promise<void> {
    if (this.prisma.inTransaction()) {
      const tx = this.prisma.client();
      await tx.lineItem.deleteMany({ where: { invoiceId: id } });
      await tx.invoice.delete({ where: { id } });
    } else {
      await this.prisma.$transaction([
        this.prisma.lineItem.deleteMany({ where: { invoiceId: id } }),
        this.prisma.invoice.delete({ where: { id } }),
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
  displayName: string | null;
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
  reviewedAt: Date | null;
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
    displayName: row.displayName,
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
    // Ligne historique (colonne nouvellement NULL) ⇒ null : jamais validé, aucune valeur inventée.
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
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
    displayName: p.displayName ?? null,
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
    reviewedAt: p.reviewedAt ? new Date(p.reviewedAt) : null,
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
  /**
   * Classement + validation humaine atomiques. L'adapter REJOUE les deux opérations de domaine
   * (classify puis markReviewed, latch) pour que la révision persistée corresponde exactement à
   * la DocumentView retournée par le use case : +2 pour un doc jamais validé, +1 sinon.
   */
  async classify(input: {
    companyId: string;
    documentId: string;
    linkedEntityType: NonNullable<DocumentProps['linkedEntityType']>;
    linkedEntityId: string;
    reviewedAt: string;
    expectedRevision: number;
  }): Promise<'saved' | 'revision_conflict' | 'not_found'> {
    const current = await this.findById(input.companyId, input.documentId);
    if (!current || current.status !== 'active') return 'not_found';
    if (current.revision !== input.expectedRevision) return 'revision_conflict';
    const next = Document.rehydrate(current.toProps());
    const classified = next.classify({
      linkedEntityType: input.linkedEntityType,
      linkedEntityId: input.linkedEntityId,
    });
    if (!classified.ok) return 'revision_conflict';
    const reviewed = next.markReviewed(input.reviewedAt);
    if (!reviewed.ok) return 'revision_conflict';
    const nextProps = next.toProps();
    const updated = await this.prisma.client().storedDocument.updateMany({
      where: {
        id: input.documentId,
        companyId: input.companyId,
        status: 'active',
        revision: input.expectedRevision,
      },
      data: {
        linkedEntityType: nextProps.linkedEntityType,
        linkedEntityId: nextProps.linkedEntityId,
        reviewedAt: nextProps.reviewedAt ? new Date(nextProps.reviewedAt) : null,
        revision: nextProps.revision ?? input.expectedRevision + 2,
      },
    });
    if (updated.count === 1) return 'saved';
    const exists = await this.prisma.client().storedDocument.findFirst({
      where: { id: input.documentId, companyId: input.companyId, status: 'active' },
      select: { id: true },
    });
    return exists ? 'revision_conflict' : 'not_found';
  }
  /** Pose la confirmation humaine SANS déplacer ni lier (AcknowledgeDocument) — CAS sur la révision. */
  async markReviewed(input: {
    companyId: string;
    documentId: string;
    reviewedAt: string;
    expectedRevision: number;
  }): Promise<'saved' | 'revision_conflict' | 'not_found'> {
    const updated = await this.prisma.client().storedDocument.updateMany({
      where: {
        id: input.documentId,
        companyId: input.companyId,
        status: 'active',
        revision: input.expectedRevision,
        // Latch : la première validation fait foi — jamais réécrite, même sur retry perdant.
        reviewedAt: null,
      },
      data: {
        reviewedAt: new Date(input.reviewedAt),
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
  /** Renommage du libellé d'affichage, protégé par révision optimiste (même contrat que classify). */
  async rename(input: {
    companyId: string;
    documentId: string;
    displayName: string;
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
        displayName: input.displayName,
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
    const row = await this.prisma
      .client()
      .storedDocument.findFirst({ where: { id, companyId }, include: DOCUMENT_INCLUDE });
    return row ? Document.rehydrate(documentRowToProps(row)) : null;
  }
  async findByEntity(companyId: string, entityType: string, entityId: string): Promise<Document[]> {
    const rows = await this.prisma.client().storedDocument.findMany({
      where: {
        companyId,
        linkedEntityType: entityType as DocumentProps['linkedEntityType'],
        linkedEntityId: entityId,
      },
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
    const row = await this.prisma
      .client()
      .documentFolder.findFirst({ where: { id: folderId, companyId } });
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
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
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

  async save(
    folder: DocumentFolder,
    expectedRevision: number | null,
  ): Promise<DocumentFolderWriteResult> {
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

  async findDocumentMembership(
    companyId: string,
    documentId: string,
  ): Promise<DocumentFolderMembership | null> {
    const row = await this.prisma.client().storedDocument.findFirst({
      where: { id: documentId, companyId },
      select: {
        id: true,
        companyId: true,
        folderId: true,
        status: true,
        revision: true,
        reviewedAt: true,
      },
    });
    return row
      ? {
          id: row.id,
          companyId: row.companyId,
          folderId: row.folderId,
          status: row.status,
          revision: row.revision,
          reviewedAt: row.reviewedAt?.toISOString() ?? null,
        }
      : null;
  }

  async listDocumentMemberships(
    companyId: string,
    folderIds: readonly string[],
  ): Promise<DocumentFolderMembership[]> {
    if (folderIds.length === 0) return [];
    const rows = await this.prisma.client().storedDocument.findMany({
      where: { companyId, folderId: { in: [...folderIds] } },
      select: {
        id: true,
        companyId: true,
        folderId: true,
        status: true,
        revision: true,
        reviewedAt: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      folderId: row.folderId,
      status: row.status,
      revision: row.revision,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Déplacement + éventuelle validation humaine (reviewedAt non nul : le rangement vaut
   * confirmation), atomiques sous CAS de révision. La révision avance du MÊME pas que le
   * rejeu domaine (moveToFolder puis markReviewed) : +1 par mutation effective, latch respecté.
   */
  async moveDocument(input: {
    companyId: string;
    documentId: string;
    targetFolderId: string | null;
    reviewedAt: string | null;
    expectedRevision: number;
  }): Promise<DocumentFolderMembershipWriteResult> {
    const current = await this.prisma.client().storedDocument.findFirst({
      where: { id: input.documentId, companyId: input.companyId },
      select: { folderId: true, status: true, revision: true, reviewedAt: true },
    });
    if (!current || current.status !== 'active') return { status: 'not_found' };
    if (current.revision !== input.expectedRevision) return { status: 'revision_conflict' };
    const movesFolder = current.folderId !== input.targetFolderId;
    // Latch : une confirmation déjà posée n'est JAMAIS réécrite, même si l'appelant en fournit une.
    const posesReview = input.reviewedAt !== null && current.reviewedAt === null;
    const nextRevision =
      input.expectedRevision + (movesFolder ? 1 : 0) + (posesReview ? 1 : 0);
    if (nextRevision === input.expectedRevision) {
      return { status: 'saved', revision: input.expectedRevision };
    }
    const updated = await this.prisma.client().storedDocument.updateMany({
      where: {
        id: input.documentId,
        companyId: input.companyId,
        status: 'active',
        revision: input.expectedRevision,
      },
      data: {
        folderId: input.targetFolderId,
        ...(posesReview ? { reviewedAt: new Date(input.reviewedAt!) } : {}),
        revision: nextRevision,
      },
    });
    if (updated.count === 1) return { status: 'saved', revision: nextRevision };
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
    // Colonne historique `invoiceId` = id de la pièce cible (facture OU devis selon reason) —
    // le renommage de colonne serait une migration non additive, interdite.
    pieceId: row.invoiceId,
    reason: row.reason === 'quote-signed' ? 'quote-signed' : 'invoice-issued',
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
          invoiceId: input.pieceId,
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
        invoiceId: input.pieceId,
        reason: input.reason,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(input.now),
      },
    });
  }

  async findByPiece(
    companyId: string,
    pieceId: string,
    reason: DocumentArchiveJob['reason'],
  ): Promise<DocumentArchiveJob | null> {
    const row = await this.prisma.client().documentArchiveJob.findUnique({
      where: { uniq_document_archive_job: { companyId, invoiceId: pieceId, reason } },
    });
    return row === null ? null : archiveJobRowToView(row);
  }

  async countIncomplete(companyId: string, reason: DocumentArchiveJob['reason']): Promise<number> {
    return this.prisma.client().documentArchiveJob.count({
      where: { companyId, reason, status: { not: 'done' } },
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

const PROVIDER_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function notificationFromJson(
  value: Prisma.JsonValue | null,
  expectedJobId: string,
): NotificationJob['notification'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const channel = candidate.channel;
  const to = candidate.to;
  const subject = candidate.subject;
  const body = candidate.body;
  const idempotencyKey = candidate.idempotencyKey;
  if (
    (channel !== 'email' && channel !== 'sms') ||
    typeof to !== 'string' ||
    typeof subject !== 'string' ||
    typeof body !== 'string' ||
    (channel === 'email' &&
      (typeof idempotencyKey !== 'string' ||
        !PROVIDER_UUID_PATTERN.test(idempotencyKey) ||
        idempotencyKey !== expectedJobId))
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
        const current = await this.prisma
          .client()
          .notificationJob.findUnique({ where: { id: existing.id } });
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
          // Livraison planifiée (notBefore) : listDue/claim ne servent que les jobs dus — un
          // job J+7 (embargo L221-10) reste durable et invisible jusqu'à son échéance.
          nextAttemptAt: new Date(input.notBefore ?? input.now),
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
    if (!winner)
      throw new Error(`Notification job absent après enqueue idempotent: ${input.dedupeKey}`);
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

  async listDue(
    companyId: string,
    now: string,
    limit: number,
  ): Promise<DeliverableNotificationJob[]> {
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
    if (
      !Number.isFinite(requestedLeaseMs) ||
      requestedLeaseMs <= 0 ||
      requestedLeaseMs > 30 * 60_000
    ) {
      throw new Error('Durée de lease notification invalide.');
    }
    // Une seule instruction, une seule horloge et un verrou de ligne : la décision est soit
    // « claim encore couvert par la fenêtre provider », soit « quarantaine », jamais les deux.
    const claimedRows = await this.prisma.client().$queryRaw<
      Array<{
        quarantined: boolean;
        channelWithoutIdempotency: boolean;
      }>
    >`
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

  async cancelByDedupeKey(
    companyId: string,
    kind: NotificationJob['kind'],
    dedupeKey: string,
    at: string,
  ): Promise<boolean> {
    void at; // Horloge autoritaire : statement_timestamp() PostgreSQL, comme markDone/markFailed.
    // Annulation d'intention : gagne sur un lease en vol (le worker perdra markDone/markFailed —
    // la course provider résiduelle est inhérente, l'état FINAL reste `cancelled`). Un job done
    // n'est jamais réécrit. Le payload est purgé : plus jamais livrable, quoi qu'il arrive.
    const count = await this.prisma.client().$executeRaw`
      UPDATE "notification_jobs"
         SET status = 'cancelled',
             payload = NULL,
             "leaseToken" = NULL,
             "lastError" = NULL,
             "updatedAt" = statement_timestamp()
       WHERE "companyId" = ${companyId}
         AND kind = ${kind}
         AND "dedupeKey" = ${dedupeKey}
         AND status IN ('pending', 'failed')
    `;
    return count === 1;
  }

  async cancelClaimed(
    id: string,
    companyId: string,
    leaseToken: string,
    at: string,
  ): Promise<boolean> {
    void at;
    const count = await this.prisma.client().$executeRaw`
      UPDATE "notification_jobs"
         SET status = 'cancelled',
             payload = NULL,
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

  async listRecent(companyId: string, limit: number): Promise<NotificationJob[]> {
    const rows = await this.prisma.client().notificationJob.findMany({
      // Un job annulé n'a jamais rien livré : il ne surface pas dans le fil (C25).
      where: { companyId, status: { not: 'cancelled' } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(notificationJobRowToView);
  }

  async previewUnread(companyId: string, _observedAt: string): Promise<NotificationUnreadPreview> {
    // Même statement, même horloge et même précision que notification_jobs.createdAt
    // (TIMESTAMP(3)). La borne est EXCLUSIVE : une insertion concurrente au même milliseconde
    // que l'aperçu ne peut pas élargir la portée au moment de la confirmation.
    const rows = await this.prisma.client().$queryRaw<
      Array<{
        unreadCount: number;
        throughCreatedAt: Date;
      }>
    >`
      WITH cutoff AS (
        SELECT date_trunc('milliseconds', statement_timestamp() AT TIME ZONE 'UTC') AS value
      )
      SELECT count(job.id)::integer AS "unreadCount",
             cutoff.value AS "throughCreatedAt"
        FROM cutoff
        LEFT JOIN "notification_jobs" AS job
          ON job."companyId" = ${companyId}
         AND job.status <> 'cancelled'
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
    const current = await this.prisma
      .client()
      .notificationJob.findFirst({ where: { id, companyId } });
    return current ? notificationJobRowToView(current) : null;
  }

  async markReadThrough(
    companyId: string,
    throughCreatedAt: string,
    _observedAt: string,
  ): Promise<NotificationReadThroughResult> {
    // PostgreSQL valide aussi que la borne n'est pas future. readAt et updatedAt utilisent
    // l'horloge DB ; le résultat reste idempotent grâce au prédicat readAt IS NULL.
    const rows = await this.prisma.client().$queryRaw<
      Array<{
        updatedCount: number;
        readAt: Date;
        cutoffAccepted: boolean;
      }>
    >`
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

/**
 * Appareils push Expo (C25) — un token global, transféré atomiquement vers le principal courant.
 *
 * La capacité RLS est l'exact token remis par l'OS. Elle n'est ni loggée ni persistée ailleurs :
 * les policies `device_token_rebind_*` ne rendent visible/mutable que cette ligne pendant le
 * statement, puis le GUC est effacé avant de rendre la main au reste de la requête.
 */
async function assertPushRegistryReadCommitted(prisma: PrismaService): Promise<void> {
  const [row] = await prisma.client().$queryRaw<Array<{ isolation: string }>>`
    SELECT current_setting('transaction_isolation') AS isolation
  `;
  if (row?.isolation !== 'read committed') {
    throw new Error('Push registry requires PostgreSQL READ COMMITTED isolation.');
  }
}

export class PrismaDeviceRepository implements DeviceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async register(input: RegisterDeviceInput): Promise<DeviceRegistrationResult> {
    const at = new Date(input.now);
    return this.prisma.runInTransaction(async () => {
      const client = this.prisma.client();
      await assertPushRegistryReadCommitted(this.prisma);

      // IMPORTANT : le verrou est un statement distinct. En READ COMMITTED, le statement suivant
      // prend ainsi un snapshot post-commit si cette requête a attendu un concurrent. Mettre lock +
      // DML dans un même CTE conserverait un snapshot antérieur et pourrait perdre un logout.
      await client.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended('bob-device-registry-v2', 0))
      `;
      await client.$executeRaw`
        SELECT
          set_config('app.current_device_push_token', ${input.expoPushToken}, true),
          set_config('app.current_device_installation_id', ${input.installationId}, true),
          set_config('app.current_device_binding_id', ${input.bindingId}, true),
          set_config('app.current_device_binding_generation', ${String(input.bindingGeneration)}, true),
          set_config('app.current_device_revocation_hash', ${input.revocationSecretHash}, true),
          set_config('app.current_device_user_id', ${input.userId ?? ''}, true),
          set_config('app.current_device_operation', 'register', true)
      `;

      let failed = false;
      try {
        // Le guard HTTP peut avoir vu la société ouverte avant d'attendre le verrou. Cette relire
        // sous snapshot frais ferme la course close-account→register.
        const openCompany = await client.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "companies"
          WHERE "id" = ${input.companyId}
            AND "closedAt" IS NULL
          LIMIT 1
        `;
        if (openCompany.length === 0) return { status: 'superseded' };

        const installationRows = await client.$queryRaw<
          Array<{
            id: string;
            revocationSecretHash: string;
            maxGeneration: number;
            currentBindingId: string | null;
            currentCompanyId: string | null;
            currentUserId: string | null;
          }>
        >`
          SELECT "id", "revocationSecretHash", "maxGeneration", "currentBindingId",
                 "currentCompanyId", "currentUserId"
          FROM "push_installations"
          WHERE "id" = ${input.installationId}::uuid
            AND "revocationSecretHash" = ${input.revocationSecretHash}
          LIMIT 1
        `;
        const installation = installationRows[0];

        const byTokenRows = await client.$queryRaw<
          Array<{
            id: string;
            installationId: string | null;
            bindingId: string | null;
            bindingGeneration: number | null;
          }>
        >`
          SELECT "id", "installationId", "bindingId", "bindingGeneration"
          FROM "devices"
          WHERE "expoPushToken" = ${input.expoPushToken}
          LIMIT 1
        `;
        const byToken = byTokenRows[0];

        const byInstallationRows = await client.$queryRaw<
          Array<{
            id: string;
            expoPushToken: string;
            bindingId: string | null;
            bindingGeneration: number | null;
          }>
        >`
          SELECT "id", "expoPushToken", "bindingId", "bindingGeneration"
          FROM "devices"
          WHERE "installationId" = ${input.installationId}::uuid
            AND "revocationSecretHash" = ${input.revocationSecretHash}
          LIMIT 1
        `;
        const byInstallation = byInstallationRows[0];

        const bindingCollision = await client.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "devices"
          WHERE "bindingId" = ${input.bindingId}::uuid
            AND "installationId" IS DISTINCT FROM ${input.installationId}::uuid
          LIMIT 1
        `;
        const installationBindingCollision = await client.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "push_installations"
          WHERE "currentBindingId" = ${input.bindingId}::uuid
            AND "id" <> ${input.installationId}::uuid
          LIMIT 1
        `;
        if (bindingCollision.length > 0 || installationBindingCollision.length > 0) {
          return { status: 'superseded' };
        }

        if (installation) {
          const idempotent =
            input.bindingGeneration === installation.maxGeneration &&
            installation.currentBindingId === input.bindingId &&
            installation.currentCompanyId === input.companyId &&
            installation.currentUserId === input.userId &&
            // Un token Expo peut tourner. Un retry à génération égale ne peut confirmer que le
            // token déjà lié ; tout changement de token exige une génération strictement neuve.
            byInstallation?.expoPushToken === input.expoPushToken &&
            byInstallation.bindingId === input.bindingId &&
            byInstallation.bindingGeneration === input.bindingGeneration;
          if (
            input.bindingGeneration < installation.maxGeneration ||
            (input.bindingGeneration === installation.maxGeneration && !idempotent)
          ) {
            return { status: 'superseded' };
          }

          const updated = await client.$executeRaw`
            UPDATE "push_installations"
            SET "maxGeneration" = ${input.bindingGeneration},
                "currentBindingId" = ${input.bindingId}::uuid,
                "currentCompanyId" = ${input.companyId},
                "currentUserId" = ${input.userId},
                "lastConfirmedAt" = ${at},
                "updatedAt" = ${at}
            WHERE "id" = ${input.installationId}::uuid
              AND "revocationSecretHash" = ${input.revocationSecretHash}
          `;
          if (updated !== 1) return { status: 'superseded' };
        } else {
          const inserted = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            INSERT INTO "push_installations" (
              "id", "revocationSecretHash", "maxGeneration", "currentBindingId",
              "currentCompanyId", "currentUserId", "lastConfirmedAt", "createdAt", "updatedAt"
            ) VALUES (
              ${input.installationId}::uuid, ${input.revocationSecretHash},
              ${input.bindingGeneration}, ${input.bindingId}::uuid,
              ${input.companyId}, ${input.userId}, ${at}, ${at}, ${at}
            )
            ON CONFLICT ("id") DO NOTHING
            RETURNING "id"
          `);
          if (inserted.length !== 1) return { status: 'superseded' };
        }

        if (byToken?.installationId && byToken.installationId !== input.installationId) {
          await client.$executeRaw`
            UPDATE "push_installations"
            SET "currentBindingId" = NULL,
                "currentCompanyId" = NULL,
                "currentUserId" = NULL,
                "updatedAt" = ${at}
            WHERE "id" = ${byToken.installationId}::uuid
              AND "currentBindingId" IS NOT DISTINCT FROM ${byToken.bindingId}::uuid
              AND "maxGeneration" IS NOT DISTINCT FROM ${byToken.bindingGeneration}
          `;
        }

        if (byToken && byToken.installationId !== input.installationId) {
          await client.$executeRaw`
            DELETE FROM "devices"
            WHERE "id" = ${byToken.id}
              AND "expoPushToken" = ${input.expoPushToken}
          `;
        }
        if (byInstallation && byInstallation.expoPushToken !== input.expoPushToken) {
          await client.$executeRaw`
            DELETE FROM "devices"
            WHERE "id" = ${byInstallation.id}
              AND "installationId" = ${input.installationId}::uuid
              AND "revocationSecretHash" = ${input.revocationSecretHash}
          `;
        }

        const rows = await client.$queryRaw<
          Array<{
            id: string;
            companyId: string;
            userId: string | null;
            expoPushToken: string;
            platform: string | null;
            installationId: string | null;
            bindingId: string | null;
            bindingGeneration: number | null;
            revocationSecretHash: string | null;
            createdAt: Date;
            updatedAt: Date;
          }>
        >(Prisma.sql`
          INSERT INTO "devices" (
            "id", "companyId", "userId", "expoPushToken", "platform",
            "installationId", "bindingId", "bindingGeneration", "revocationSecretHash",
            "createdAt", "updatedAt"
          ) VALUES (
            ${input.id}, ${input.companyId}, ${input.userId}, ${input.expoPushToken}, ${input.platform},
            ${input.installationId}::uuid, ${input.bindingId}::uuid, ${input.bindingGeneration},
            ${input.revocationSecretHash}, ${at}, ${at}
          )
          ON CONFLICT ("expoPushToken") DO UPDATE SET
            "companyId" = EXCLUDED."companyId",
            "userId" = EXCLUDED."userId",
            "platform" = EXCLUDED."platform",
            "installationId" = EXCLUDED."installationId",
            "bindingId" = EXCLUDED."bindingId",
            "bindingGeneration" = EXCLUDED."bindingGeneration",
            "revocationSecretHash" = EXCLUDED."revocationSecretHash",
            "updatedAt" = EXCLUDED."updatedAt"
          RETURNING "id", "companyId", "userId", "expoPushToken", "platform",
                    "installationId", "bindingId", "bindingGeneration", "revocationSecretHash",
                    "createdAt", "updatedAt"
        `);
        const row = rows[0];
        return row ? { status: 'bound', device: deviceRowToRecord(row) } : { status: 'superseded' };
      } catch (error: unknown) {
        failed = true;
        throw error;
      } finally {
        // Ne laisse jamais une capacité élargir une lecture ultérieure de la transaction requête.
        if (!failed) {
          await client.$executeRaw`
            SELECT
              set_config('app.current_device_push_token', '', true),
              set_config('app.current_device_installation_id', '', true),
              set_config('app.current_device_binding_id', '', true),
              set_config('app.current_device_binding_generation', '', true),
              set_config('app.current_device_revocation_hash', '', true),
              set_config('app.current_device_user_id', '', true),
              set_config('app.current_device_operation', '', true)
          `;
        }
      }
    });
  }

  async listDeliveryTargetsByCompany(
    companyId: string,
    confirmedAfter: string,
  ): Promise<PushDeliveryTarget[]> {
    return this.prisma.runInTransaction(async () => {
      const client = this.prisma.client();
      await client.$executeRaw`
        SELECT set_config('app.current_device_operation', 'deliver', true)
      `;
      let failed = false;
      try {
        // Le fence durable est l'autorité. Une ligne Device orpheline ou partiellement purgée ne
        // doit jamais redevenir livrable, même si elle est encore visible dans le tenant.
        const rows = await client.$queryRaw<
          Array<{
            expoPushToken: string;
            platform: string | null;
            bindingId: string;
            bindingGeneration: number;
            updatedAt: Date;
          }>
        >(Prisma.sql`
          SELECT device."expoPushToken", device."platform", device."bindingId",
                 device."bindingGeneration", installation."lastConfirmedAt" AS "updatedAt"
          FROM "devices" AS device
          INNER JOIN "push_installations" AS installation
            ON installation."id" = device."installationId"
           AND installation."revocationSecretHash" = device."revocationSecretHash"
           AND installation."currentBindingId" = device."bindingId"
           AND installation."maxGeneration" = device."bindingGeneration"
           AND installation."currentCompanyId" = device."companyId"
           AND installation."currentUserId" IS NOT DISTINCT FROM device."userId"
          INNER JOIN "companies" AS company
            ON company."id" = device."companyId"
           AND company."closedAt" IS NULL
          WHERE device."companyId" = ${companyId}
            AND device."installationId" IS NOT NULL
            AND device."bindingId" IS NOT NULL
            AND device."bindingGeneration" IS NOT NULL
            AND device."revocationSecretHash" IS NOT NULL
            AND device."updatedAt" >= ${new Date(confirmedAfter)}
            AND installation."lastConfirmedAt" >= ${new Date(confirmedAfter)}
          ORDER BY device."createdAt" ASC
        `);
        return rows.map((row) => ({
          expoPushToken: row.expoPushToken,
          platform: row.platform,
          bindingId: row.bindingId,
          bindingGeneration: row.bindingGeneration,
          updatedAt: row.updatedAt.toISOString(),
        }));
      } catch (error: unknown) {
        failed = true;
        throw error;
      } finally {
        if (!failed) {
          await client.$executeRaw`
            SELECT set_config('app.current_device_operation', '', true)
          `;
        }
      }
    });
  }

  async revokeLegacyOwnerToken(
    companyId: string,
    userId: string | null,
    expoPushToken: string,
  ): Promise<void> {
    await this.prisma.runInTransaction(async () => {
      const client = this.prisma.client();
      await client.$executeRaw`
        SELECT
          set_config('app.current_device_operation', 'legacy-owner-revoke', true),
          set_config('app.current_device_user_id', ${userId ?? ''}, true)
      `;
      let failed = false;
      try {
        await client.$executeRaw`
          DELETE FROM "devices" AS device
          WHERE device."companyId" = ${companyId}
            AND device."userId" IS NOT DISTINCT FROM ${userId}
            AND device."expoPushToken" = ${expoPushToken}
            AND device."installationId" IS NULL
            AND device."bindingId" IS NULL
            AND device."bindingGeneration" IS NULL
            AND device."revocationSecretHash" IS NULL
        `;
      } catch (error: unknown) {
        failed = true;
        throw error;
      } finally {
        if (!failed) {
          await client.$executeRaw`
            SELECT
              set_config('app.current_device_operation', '', true),
              set_config('app.current_device_user_id', '', true)
          `;
        }
      }
    });
  }

  async removeInvalidDeliveryTarget(input: InvalidPushDeliveryTarget): Promise<void> {
    const device = await this.prisma.runInTransaction(async () => {
      const client = this.prisma.client();
      await client.$executeRaw`
        SELECT
          set_config('app.current_device_operation', 'provider-revoke-lookup', true),
          set_config('app.current_device_push_token', ${input.expoPushToken}, true),
          set_config('app.current_device_binding_id', ${input.bindingId}, true),
          set_config('app.current_device_binding_generation', ${String(input.bindingGeneration)}, true)
      `;
      let failed = false;
      try {
        return await client.device.findFirst({
          where: {
            companyId: input.companyId,
            expoPushToken: input.expoPushToken,
            bindingId: input.bindingId,
            bindingGeneration: input.bindingGeneration,
          },
          select: {
            installationId: true,
            bindingId: true,
            bindingGeneration: true,
            revocationSecretHash: true,
            userId: true,
          },
        });
      } catch (error: unknown) {
        failed = true;
        throw error;
      } finally {
        if (!failed) {
          await client.$executeRaw`
            SELECT
              set_config('app.current_device_operation', '', true),
              set_config('app.current_device_push_token', '', true),
              set_config('app.current_device_binding_id', '', true),
              set_config('app.current_device_binding_generation', '', true)
          `;
        }
      }
    });
    if (
      !device?.installationId ||
      !device.bindingId ||
      device.bindingGeneration === null ||
      !device.revocationSecretHash
    )
      return;
    await this.revokeThroughGeneration({
      installationId: device.installationId,
      throughGeneration: device.bindingGeneration,
      revocationSecretHash: device.revocationSecretHash,
      scope: { kind: 'authenticated', companyId: input.companyId, userId: device.userId },
    });
  }

  async revokeThroughGeneration(input: RevokeDeviceThroughInput): Promise<void> {
    const authenticated = input.scope.kind === 'authenticated';
    const userId = input.scope.kind === 'authenticated' ? input.scope.userId : null;
    const operation = authenticated ? 'revoke-auth' : 'revoke-public';
    await this.prisma.runInTransaction(async () => {
      const client = this.prisma.client();
      await assertPushRegistryReadCommitted(this.prisma);
      await client.$executeRaw`
        SELECT
          set_config('app.current_device_installation_id', ${input.installationId}, true),
          set_config('app.current_device_binding_generation', ${String(input.throughGeneration)}, true),
          set_config('app.current_device_revocation_hash', ${input.revocationSecretHash}, true),
          set_config('app.current_device_user_id', ${userId ?? ''}, true),
          set_config('app.current_device_operation', ${operation}, true)
      `;
      let failed = false;
      try {
        if (!authenticated) {
          // Un appel public absent ou au mauvais secret n'acquiert jamais le verrou global : il
          // reste one-way et ne peut pas provoquer de head-of-line blocking sans la capacité.
          const preflight = await client.$queryRaw<Array<{ present: number }>>`
            SELECT 1::integer AS present
            FROM "push_installations"
            WHERE "id" = ${input.installationId}::uuid
              AND "revocationSecretHash" = ${input.revocationSecretHash}
            LIMIT 1
          `;
          if (preflight.length === 0) return;
        }

        // Même ordre global que register, dans un statement séparé. Le SELECT/DML suivant prend
        // un snapshot frais après l'attente grâce à READ COMMITTED certifié ci-dessus.
        await client.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended('bob-device-registry-v2', 0))
        `;
        const installation = (
          await client.$queryRaw<
            Array<{
              id: string;
              maxGeneration: number;
            }>
          >`
          SELECT "id", "maxGeneration"
          FROM "push_installations"
          WHERE "id" = ${input.installationId}::uuid
            AND "revocationSecretHash" = ${input.revocationSecretHash}
          LIMIT 1
        `
        )[0];

        if (installation && installation.maxGeneration <= input.throughGeneration) {
          await client.$executeRaw`
            UPDATE "push_installations"
            SET "maxGeneration" = ${input.throughGeneration},
                "currentBindingId" = NULL,
                "currentCompanyId" = NULL,
                "currentUserId" = NULL,
                "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = ${input.installationId}::uuid
              AND "revocationSecretHash" = ${input.revocationSecretHash}
              AND "maxGeneration" <= ${input.throughGeneration}
          `;
        } else if (!installation && authenticated) {
          // Authentifié : une révocation peut précéder le POST d'inscription. Le fence empêche ce
          // POST retardé de ressusciter la session. Le chemin public ne crée jamais d'oracle/ligne.
          await client.$executeRaw`
            INSERT INTO "push_installations" (
              "id", "revocationSecretHash", "maxGeneration", "currentBindingId",
              "currentCompanyId", "currentUserId", "lastConfirmedAt", "createdAt", "updatedAt"
            ) VALUES (
              ${input.installationId}::uuid, ${input.revocationSecretHash},
              ${input.throughGeneration}, NULL, NULL, NULL, NULL,
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            )
            ON CONFLICT ("id") DO NOTHING
          `;
        }

        // Toujours purger les restes <= high-water : le parent peut déjà être plus récent alors
        // qu'une ancienne ligne Device orpheline existe après une panne partielle historique.
        await client.$executeRaw`
          DELETE FROM "devices"
          WHERE "installationId" = ${input.installationId}::uuid
            AND "revocationSecretHash" = ${input.revocationSecretHash}
            AND "bindingGeneration" <= ${input.throughGeneration}
        `;
      } catch (error: unknown) {
        failed = true;
        throw error;
      } finally {
        if (!failed) {
          await client.$executeRaw`
            SELECT
              set_config('app.current_device_installation_id', '', true),
              set_config('app.current_device_binding_id', '', true),
              set_config('app.current_device_binding_generation', '', true),
              set_config('app.current_device_revocation_hash', '', true),
              set_config('app.current_device_user_id', '', true),
              set_config('app.current_device_operation', '', true)
          `;
        }
      }
    });
  }

  /**
   * Clôture de compte (CloseAccount) : purge atomique de TOUT push pour ce tenant. Volontairement
   * PAS le protocole revokeThroughGeneration (capacité CLIENT-initiée résistante au vol de JWT,
   * exige le secret de révocation détenu par l'appareil) : ici c'est le tenant lui-même qui se
   * clôture. Les fences restent comme high-water tombstones mais sont neutralisés avant la purge
   * des Device, sous le même verrou global que register/revoke.
   */
  async deleteAllForCompany(companyId: string): Promise<void> {
    await this.prisma.runInTransaction(async () => {
      const client = this.prisma.client();
      await assertPushRegistryReadCommitted(this.prisma);
      await client.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended('bob-device-registry-v2', 0))
      `;
      await client.$executeRaw`
        SELECT set_config('app.current_device_operation', 'close-account', true)
      `;
      let failed = false;
      try {
        const installations = await client.$queryRaw<
          Array<{
            installationId: string;
            revocationSecretHash: string;
          }>
        >`
          SELECT "installationId", "revocationSecretHash"
          FROM "devices"
          WHERE "companyId" = ${companyId}
            AND "installationId" IS NOT NULL
            AND "revocationSecretHash" IS NOT NULL
        `;
        // Une capacité exacte par installation garde la nouvelle ligne neutralisée visible à
        // l'UPDATE RLS sans exposer les tombstones d'autres tenants.
        for (const installation of installations) {
          await client.$executeRaw`
            SELECT
              set_config('app.current_device_installation_id', ${installation.installationId}, true),
              set_config('app.current_device_revocation_hash', ${installation.revocationSecretHash}, true)
          `;
          await client.$executeRaw`
            UPDATE "push_installations"
            SET "currentBindingId" = NULL,
                "currentCompanyId" = NULL,
                "currentUserId" = NULL,
                "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = ${installation.installationId}::uuid
              AND "revocationSecretHash" = ${installation.revocationSecretHash}
              AND "currentCompanyId" = ${companyId}
          `;
        }
        await client.$executeRaw`
          DELETE FROM "devices"
          WHERE "companyId" = ${companyId}
        `;
      } catch (error: unknown) {
        failed = true;
        throw error;
      } finally {
        // Une erreur SQL avorte déjà la transaction et ses SET LOCAL. Ne pas masquer la cause
        // primaire par un second statement 25P02 dans le finally.
        if (!failed) {
          await client.$executeRaw`
            SELECT
              set_config('app.current_device_installation_id', '', true),
              set_config('app.current_device_revocation_hash', '', true),
              set_config('app.current_device_operation', '', true)
          `;
        }
      }
    });
  }
}

function deviceRowToRecord(row: {
  id: string;
  companyId: string;
  userId: string | null;
  expoPushToken: string;
  platform: string | null;
  installationId: string | null;
  bindingId: string | null;
  bindingGeneration: number | null;
  revocationSecretHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}): DeviceRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    userId: row.userId,
    expoPushToken: row.expoPushToken,
    platform: row.platform,
    installationId: row.installationId,
    bindingId: row.bindingId,
    bindingGeneration: row.bindingGeneration,
    revocationSecretHash: row.revocationSecretHash,
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
    args: (row.args && typeof row.args === 'object' && !Array.isArray(row.args)
      ? row.args
      : {}) as Record<string, unknown>,
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
    return ChartOfAccounts.rehydrate({
      companyId,
      accounts: rows.map(accountingAccountRowToProps),
    });
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
  }): Payment {
    const r = Payment.record({
      id: row.id,
      companyId: row.companyId,
      invoiceId: row.invoiceId,
      amount: row.amount,
      method: row.method as Payment['method'],
      receivedAt: row.receivedAt.toISOString(),
      idempotencyKey: row.idempotencyKey,
    });
    return requirePersistedAggregate('payment', row.id, r);
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
    const row = await this.prisma
      .client()
      .payment.findFirst({ where: { companyId, idempotencyKey: key } });
    return row ? this.rowToPayment(row) : null;
  }
  async listByInvoice(invoiceId: string): Promise<Payment[]> {
    const rows = await this.prisma.client().payment.findMany({ where: { invoiceId } });
    return rows.map((row) => this.rowToPayment(row));
  }
  /** E3 (PONT-SERVEUR v1) : encaissements datés du tenant — CA encaissé annuel (293 B), balance
   *  âgée/prescription. Tri chronologique stable (findMany sans orderBy est non déterministe). */
  async listByCompany(companyId: string): Promise<Payment[]> {
    const rows = await this.prisma
      .client()
      .payment.findMany({ where: { companyId }, orderBy: { receivedAt: 'asc' } });
    return rows.map((row) => this.rowToPayment(row));
  }
}

export class PrismaPublicAccessTokenRepository implements PublicAccessTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    companyId: string;
    resourceType: PublicAccessResourceType;
    resourceId: string;
    scope: PublicAccessScope;
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

  async lockActive(token: string, at: string): Promise<PublicAccessGrant | null> {
    requireActiveTransaction(this.prisma, 'Public access token use lock');
    const tokenHash = publicTokenHash(token);
    return this.prisma.withPublicAccessTokenHash(tokenHash, async () => {
      const db = this.prisma.client();
      await db.$queryRaw`
        SELECT id FROM public_access_tokens
        WHERE "tokenHash" = ${tokenHash}
        FOR UPDATE
      `;
      const row = await db.publicAccessToken.findUnique({ where: { tokenHash } });
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
    await this.prisma
      .client()
      .publicAccessToken.update({ where: { id }, data: { lastUsedAt: new Date(at) } });
  }

  async revoke(id: string, at: string): Promise<void> {
    await this.prisma
      .client()
      .publicAccessToken.update({ where: { id }, data: { revokedAt: new Date(at) } });
  }

  async revokeActiveFor(input: {
    companyId: string;
    resourceType: PublicAccessResourceType;
    resourceId: string;
    scope: PublicAccessScope;
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

  /** Clôture de compte : coupe TOUS les liens publics actifs du tenant, tous types confondus. */
  async revokeAllForCompany(input: { companyId: string; at: string }): Promise<void> {
    await this.prisma.client().publicAccessToken.updateMany({
      where: { companyId: input.companyId, revokedAt: null },
      data: { revokedAt: new Date(input.at) },
    });
  }
}

export class PrismaExpenseRepository implements ExpenseRepository {
  constructor(private readonly prisma: PrismaService) {}
  async save(e: Expense): Promise<void> {
    const data = expensePropsToPersistence(e.toProps());
    const { id, ...writeData } = data;
    try {
      await this.prisma.client().expense.upsert({
        where: { id },
        create: { id, ...writeData },
        update: writeData,
      });
    } catch (err) {
      // C-EXP-FIX1 (Bug 1 — DOUBLON TOCTOU) : l'index UNIQUE PARTIEL uniq_expense_supplier_invoice
      // rejette la 2e e-facture concurrente (P2002). On la traduit en sentinelle métier (jamais un
      // 500) ; l'upsert par id ne peut violer QUE cet index (le conflit d'id, lui, fait un update).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new DuplicateExpenseInvoiceError(
          data.companyId,
          data.supplierSiren,
          data.supplierInvoiceNumber,
        );
      }
      throw err;
    }
  }
  async findById(id: string): Promise<Expense | null> {
    const row = await this.prisma.client().expense.findUnique({ where: { id } });
    if (!row) return null;
    return Expense.rehydrate(expenseRowToProps(row));
  }
  async lockById(id: string): Promise<Expense | null> {
    // Doit être appelé dans `runInTransaction` : PostgreSQL sérialise deux preuves concurrentes
    // avant que l'une puisse écraser la date/le moyen de l'autre.
    await this.prisma.client().$queryRaw`SELECT id FROM expenses WHERE id = ${id} FOR UPDATE`;
    return this.findById(id);
  }
  async listByCompany(companyId: string): Promise<Expense[]> {
    // Réhydratation (données déjà validées) : ne jamais faire disparaître une dépense persistée
    // — sinon la trésorerie sous-compterait les charges (cf. revue EN 16931 / cashflow).
    const rows = await this.prisma.client().expense.findMany({ where: { companyId } });
    return rows.map((row) => Expense.rehydrate(expenseRowToProps(row)));
  }
}

export class PrismaSupplierMemoryRepository implements SupplierMemoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async supplierProfile(
    companyId: string,
    supplierName: string,
  ): Promise<SupplierMemoryProfile | null> {
    const key = normalizeSupplierName(supplierName);
    if (!key) return null;
    const row = await this.prisma.client().supplierMemoryProfile.findUnique({
      where: { uniq_supplier_memory_company_key: { companyId, key } },
    });
    return row ? this.toProfile(row) : null;
  }

  async rememberSupplier(
    companyId: string,
    input: RememberSupplierInput,
    at: string,
  ): Promise<SupplierMemoryProfile> {
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
        ...(input.vatRatePct !== undefined && input.vatRatePct !== null
          ? { vatRatePct: input.vatRatePct }
          : {}),
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

/**
 * Abonnements (pilier 2) — une ligne par tenant (unique companyId), lue par
 * GetSubscriptionStatus (@bob/core). startTrial IDEMPOTENT via createMany(skipDuplicates)
 * (INSERT ... ON CONFLICT DO NOTHING : n'invalide pas la transaction tenant courante,
 * même précédent que l'outbox) puis relecture — un retry de provisioning ne réinitialise
 * jamais une échéance d'essai.
 */
export class PrismaSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByCompanyId(companyId: string): Promise<SubscriptionRecord | null> {
    const row = await this.prisma.client().subscription.findUnique({ where: { companyId } });
    return row ? subscriptionRowToRecord(row) : null;
  }

  async startEarlyAccess(input: {
    id: string;
    companyId: string;
    plan: SubscriptionRecord['plan'];
    now: string;
  }): Promise<SubscriptionRecord> {
    await this.prisma.client().subscription.createMany({
      data: [
        {
          id: input.id,
          companyId: input.companyId,
          plan: input.plan,
          status: 'active',
          trialEndsAt: null,
          currentPeriodEnd: null,
          store: 'none',
          storeRef: null,
          createdAt: new Date(input.now),
          updatedAt: new Date(input.now),
        },
      ],
      skipDuplicates: true,
    });
    const row = await this.prisma
      .client()
      .subscription.findUnique({ where: { companyId: input.companyId } });
    if (!row) {
      throw new Error(`Abonnement introuvable après startEarlyAccess pour ${input.companyId}.`);
    }
    return subscriptionRowToRecord(row);
  }

  async startTrial(input: {
    id: string;
    companyId: string;
    plan: SubscriptionRecord['plan'];
    trialEndsAt: string;
    now: string;
  }): Promise<SubscriptionRecord> {
    await this.prisma.client().subscription.createMany({
      data: [
        {
          id: input.id,
          companyId: input.companyId,
          plan: input.plan,
          status: 'trialing',
          trialEndsAt: new Date(input.trialEndsAt),
          createdAt: new Date(input.now),
          updatedAt: new Date(input.now),
        },
      ],
      skipDuplicates: true,
    });
    const row = await this.prisma
      .client()
      .subscription.findUnique({ where: { companyId: input.companyId } });
    if (!row) throw new Error(`Abonnement introuvable après startTrial pour ${input.companyId}.`);
    return subscriptionRowToRecord(row);
  }

  async save(record: SubscriptionRecord): Promise<SubscriptionRecord> {
    const data = {
      plan: record.plan,
      status: record.status,
      trialEndsAt: record.trialEndsAt === null ? null : new Date(record.trialEndsAt),
      currentPeriodEnd: record.currentPeriodEnd === null ? null : new Date(record.currentPeriodEnd),
      store: record.store,
      storeRef: record.storeRef,
    };
    const row = await this.prisma.client().subscription.upsert({
      where: { companyId: record.companyId },
      create: {
        id: record.id,
        companyId: record.companyId,
        createdAt: new Date(record.createdAt),
        ...data,
      },
      update: data,
    });
    return subscriptionRowToRecord(row);
  }
}

function subscriptionRowToRecord(row: {
  id: string;
  companyId: string;
  plan: string;
  status: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  store: string | null;
  storeRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}): SubscriptionRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    plan: row.plan as SubscriptionRecord['plan'],
    status: row.status as SubscriptionRecord['status'],
    trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    store: (row.store as SubscriptionRecord['store']) ?? null,
    storeRef: row.storeRef,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Profil fiscal (BOB EXPERT FISCAL, Phase 1A) — une ligne par tenant (companyId unique), lue par
 * GetFiscalProfile/UpdateFiscalProfileField (@bob/core). Chaque colonne JSON porte un
 * FiscalDatum<T> sérialisé tel quel (cf. commentaire du modèle Prisma FiscalProfile — shape
 * choisie pour ne pas dupliquer 4 colonnes de méta par champ ni créer 5 enums Postgres). L'id de
 * la ligne (`fiscal-<companyId>`) suit le même pattern que `sub-<companyId>` (subscriptions) —
 * dérivé, jamais exposé sur l'agrégat domaine (identité = companyId, unique par tenant).
 */
export class PrismaFiscalProfileRepository implements FiscalProfileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByCompanyId(companyId: string): Promise<FiscalProfile | null> {
    const row = await this.prisma.client().fiscalProfile.findUnique({ where: { companyId } });
    if (!row) return null;
    return requirePersistedAggregate(
      'fiscal-profile',
      row.companyId,
      FiscalProfile.of(fiscalProfileRowToProps(row)),
    );
  }

  async save(profile: FiscalProfile): Promise<void> {
    const props = profile.toProps();
    const data = {
      legalForm: props.legalForm as unknown as Prisma.InputJsonValue,
      taxRegime: props.taxRegime as unknown as Prisma.InputJsonValue,
      socialStatus: props.socialStatus as unknown as Prisma.InputJsonValue,
      activityNature: props.activityNature as unknown as Prisma.InputJsonValue,
      vatRegime: props.vatRegime as unknown as Prisma.InputJsonValue,
      acre: props.acre as unknown as Prisma.InputJsonValue,
      versementLiberatoire: props.versementLiberatoire as unknown as Prisma.InputJsonValue,
      fiscalYearEnd: props.fiscalYearEnd as unknown as Prisma.InputJsonValue,
    };
    await this.prisma.client().fiscalProfile.upsert({
      where: { companyId: props.companyId },
      create: { id: `fiscal-${props.companyId}`, companyId: props.companyId, ...data },
      update: data,
    });
  }
}

function fiscalProfileRowToProps(row: {
  companyId: string;
  legalForm: Prisma.JsonValue;
  taxRegime: Prisma.JsonValue;
  socialStatus: Prisma.JsonValue;
  activityNature: Prisma.JsonValue;
  vatRegime: Prisma.JsonValue;
  acre: Prisma.JsonValue;
  versementLiberatoire: Prisma.JsonValue;
  fiscalYearEnd: Prisma.JsonValue;
}): FiscalProfileProps {
  return {
    companyId: row.companyId,
    legalForm: row.legalForm as unknown as FiscalProfileProps['legalForm'],
    taxRegime: row.taxRegime as unknown as FiscalProfileProps['taxRegime'],
    socialStatus: row.socialStatus as unknown as FiscalProfileProps['socialStatus'],
    activityNature: row.activityNature as unknown as FiscalProfileProps['activityNature'],
    vatRegime: row.vatRegime as unknown as FiscalProfileProps['vatRegime'],
    acre: row.acre as unknown as FiscalProfileProps['acre'],
    versementLiberatoire:
      row.versementLiberatoire as unknown as FiscalProfileProps['versementLiberatoire'],
    fiscalYearEnd: row.fiscalYearEnd as unknown as FiscalProfileProps['fiscalYearEnd'],
  };
}

export class PrismaSequenceCounter implements SequenceCounterPort {
  constructor(private readonly prisma: PrismaService) {}
  async allocate(input: {
    companyId: string;
    counterKey: CounterKey;
    fiscalYear: number;
  }): Promise<{
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
    if (rows.length !== 1) {
      throw new Error(`DOCUMENT_COUNTER_ALLOCATION_CORRUPT:expected_one_row:got_${rows.length}`);
    }
    const seq = Number(rows[0]!.next_value);
    if (!Number.isSafeInteger(seq) || seq < 1) {
      throw new Error('DOCUMENT_COUNTER_ALLOCATION_CORRUPT:invalid_next_value');
    }
    // D = devis · F = facture · A = avoir (A6, CounterKey 'credit') — trois familles, trois séquences
    // sans trou ; la table document_counters est générique (counterKey texte), aucune migration.
    const prefix = input.counterKey === 'quote' ? 'D' : input.counterKey === 'credit' ? 'A' : 'F';
    return { sequence: seq, formatted: DocNumber.format(prefix, input.fiscalYear, seq) };
  }
}

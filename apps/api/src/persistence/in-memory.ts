import { randomUUID } from 'node:crypto';
import {
  DocNumber,
  Invoice,
  Quote,
  AccountingEntry,
  ChartOfAccounts,
  Expense,
  Chantier,
  ChantierNote,
  type ChantierNoteRepository,
  type WorksiteMediaItem,
  type WorksiteMediaStorage,
  Company,
  type Customer,
  Document,
  DocumentFolder,
  type DocumentFolderProps,
  type Payment,
  type CustomerRepository,
  type QuoteRepository,
  type InvoiceRepository,
  type DocumentRepository,
  isExactInitialDocumentReplay,
  type DocumentFolderRepository,
  type DocumentFolderMembership,
  type DocumentFolderWriteResult,
  type DocumentFolderMembershipWriteResult,
  type PaymentRepository,
  type PublicAccessGrant,
  type PublicAccessTokenRepository,
  type PublicAccessResourceType,
  type PublicAccessScope,
  type ExpenseRepository,
  type AccountingEntryRepository,
  type ChartOfAccountsRepository,
  type ChantierRepository,
  type CatalogueItemRecord,
  type CatalogueRepository,
  type CatalogueCreateWriteResult,
  type CatalogueUpdateWriteResult,
  type CatalogueDeleteWriteResult,
  type SequenceCounterPort,
  type CounterKey,
} from '@bob/core';
import type { ServerCompanyRepository } from './persistence';
import {
  documentArchiveIntegrityProofSha256,
  isValidDocumentArchiveIntegrityProof,
  type DocumentArchiveJob,
  type DocumentArchiveJobRepository,
  type EnqueueDocumentArchiveJobInput,
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
import type {
  DeviceRecord,
  DeviceRegistrationResult,
  DeviceRepository,
  InvalidPushDeliveryTarget,
  PushDeliveryTarget,
  RegisterDeviceInput,
  RevokeDeviceThroughInput,
} from './devices';
import { DuplicateExpenseInvoiceError } from './expense-duplicate-error';
import { SituationOrderConflictError } from './situation-order-conflict-error';

/**
 * Adapters in-memory (stockent les objets de domaine directement — aucune réhydratation requise).
 * Permettent de faire tourner l'API SANS base de données. Les adapters Prisma/Postgres sont le
 * prochain incrément (cf. prisma/schema.prisma + réhydratation des agrégats).
 */
export class InMemoryCompanyRepository implements ServerCompanyRepository {
  private readonly map = new Map<string, Company>();
  private clone(c: Company): Company {
    // Quelques tests de jobs utilisent depuis l'origine un stub structurel `{ id } as Company` :
    // le seed du double doit le conserver. Toutes les écritures métier passent, elles, par un vrai
    // agrégat Company et bénéficient de la copie défensive ci-dessous.
    if (typeof c.toProps !== 'function') return c;
    const cloned = Company.of(c.toProps());
    if (!cloned.ok) throw new Error('INVALID_COMPANY_TEST_SNAPSHOT');
    return cloned.value;
  }
  seed(c: Company): void {
    this.map.set(c.id, this.clone(c));
  }
  async findById(id: string): Promise<Company | null> {
    return this.map.get(id) ?? null;
  }
  async lockById(id: string): Promise<Company | null> {
    return this.findById(id);
  }
  async lockForShareById(id: string): Promise<Company | null> {
    return this.findById(id);
  }
  async list(): Promise<Company[]> {
    return [...this.map.values()];
  }
  async createIfAbsentOpen(c: Company) {
    if (c.isClosed()) throw new Error('COMPANY_REGISTRATION_CANNOT_CREATE_CLOSED_COMPANY');
    if (this.map.has(c.id)) return 'existing' as const;
    if ([...this.map.values()].some((existing) => existing.siret === c.siret)) {
      return 'identity_conflict' as const;
    }
    this.map.set(c.id, this.clone(c));
    return 'created' as const;
  }
  async save(c: Company): Promise<void> {
    const current = this.map.get(c.id);
    if (current && typeof current.isClosed === 'function' && current.isClosed()) {
      throw new Error('COMPANY_NOT_OPEN_FOR_UPDATE');
    }
    // Les tests historiques utilisent save pour leur seed explicite. Une fois la row présente,
    // la même monotonie qu'en PostgreSQL s'applique (ouverte → ouverte/clôturée, jamais l'inverse).
    this.map.set(c.id, this.clone(c));
  }
  snapshot(): Company[] {
    return [...this.map.values()].map((company) => this.clone(company));
  }
  restore(snapshot: readonly Company[]): void {
    this.map.clear();
    for (const company of snapshot) {
      this.map.set(company.id, this.clone(company));
    }
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
  async lockForShareById(id: string): Promise<Quote | null> {
    return this.findById(id);
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
    this.map = new Map(
      [...snapshot].map(([id, quote]) => [id, Quote.rehydrate(quote.toSnapshot())]),
    );
  }
}

export class InMemoryInvoiceRepository implements InvoiceRepository {
  private readonly map = new Map<string, Invoice>();

  snapshot(): Map<string, Invoice> {
    return new Map(
      [...this.map].map(([id, invoice]) => [id, Invoice.rehydrate(invoice.toSnapshot())]),
    );
  }

  restore(snapshot: Map<string, Invoice>): void {
    this.map.clear();
    for (const [id, invoice] of snapshot) {
      this.map.set(id, Invoice.rehydrate(invoice.toSnapshot()));
    }
  }

  async findById(id: string): Promise<Invoice | null> {
    return this.map.get(id) ?? null;
  }
  async lockById(id: string): Promise<Invoice | null> {
    // Mono-thread JS : pas de verrou réel ; on renvoie une COPIE (comme Prisma) pour isoler les
    // mutations jusqu'au save (pas de mutation en place de l'agrégat stocké en cas d'erreur).
    const stored = this.map.get(id);
    return stored ? Invoice.rehydrate(stored.toSnapshot()) : null;
  }
  async lockForShareById(id: string): Promise<Invoice | null> {
    return this.findById(id);
  }
  async findByParentQuoteId(
    companyId: string,
    parentQuoteId: string,
    kind: Invoice['kind'],
  ): Promise<Invoice | null> {
    return (
      [...this.map.values()].find(
        (i) => i.companyId === companyId && i.parentQuoteId === parentQuoteId && i.kind === kind,
      ) ?? null
    );
  }
  async findCreditNoteBySourceInvoiceId(
    companyId: string,
    sourceInvoiceId: string,
  ): Promise<Invoice | null> {
    return (
      [...this.map.values()].find(
        (invoice) =>
          invoice.companyId === companyId &&
          invoice.kind === 'credit_note' &&
          invoice.creditNoteSource?.invoiceId === sourceInvoiceId,
      ) ?? null
    );
  }
  async listByCompany(companyId: string): Promise<Invoice[]> {
    return [...this.map.values()].filter((i) => i.companyId === companyId);
  }
  async save(i: Invoice): Promise<void> {
    const sourceId = i.creditNoteSource?.invoiceId;
    if (i.kind === 'credit_note' && sourceId) {
      const existing = await this.findCreditNoteBySourceInvoiceId(i.companyId, sourceId);
      if (existing && existing.id !== i.id) return;
    }
    // B2 — garde FIDÈLE de l'index unique partiel uniq_invoice_parent_quote_situation_order
    // (Postgres) : un n° d'ordre de situation ne se crée jamais deux fois sur un même devis —
    // deux générations concurrentes voient la seconde échouer, comme en production.
    if (i.kind === 'situation' && i.parentQuoteId !== null && i.situationOrder !== null) {
      const clash = [...this.map.values()].find(
        (other) =>
          other.id !== i.id &&
          other.kind === 'situation' &&
          other.companyId === i.companyId &&
          other.parentQuoteId === i.parentQuoteId &&
          other.situationOrder === i.situationOrder,
      );
      if (clash) {
        throw new SituationOrderConflictError(i.companyId, i.parentQuoteId, i.situationOrder);
      }
    }
    this.map.set(i.id, i);
  }
  async deleteById(id: string): Promise<void> {
    this.map.delete(id);
  }
}

export class InMemoryDocumentRepository implements DocumentRepository {
  private readonly map = new Map<string, Document>();
  private readonly invoicePdfAttestations = new Map<
    string,
    import('@bob/core').AttestInvoicePdfInput
  >();
  snapshot(): ReturnType<Document['toProps']>[] {
    return [...this.map.values()].map((document) => document.toProps());
  }
  snapshotInvoicePdfAttestations(): import('@bob/core').AttestInvoicePdfInput[] {
    return [...this.invoicePdfAttestations.values()].map((value) => ({ ...value }));
  }
  restore(snapshot: ReturnType<Document['toProps']>[]): void {
    this.map.clear();
    for (const props of snapshot) this.map.set(props.id, Document.rehydrate(props));
  }
  restoreInvoicePdfAttestations(
    snapshot: import('@bob/core').AttestInvoicePdfInput[],
  ): void {
    this.invoicePdfAttestations.clear();
    for (const attestation of snapshot) {
      this.invoicePdfAttestations.set(
        `${attestation.documentId}:${attestation.versionId}`,
        { ...attestation },
      );
    }
  }
  /** Fixture explicite : ce repository n'est assemblé que par persistence.testing.ts. */
  seed(d: Document): this {
    this.map.set(d.id, d);
    return this;
  }
  /** Injection de corruption réservée aux tests d'immuabilité. Le nom volontairement
   *  bruyant interdit de confondre cette porte avec une mutation de production. */
  forceReplaceForTesting(d: Document): void {
    this.map.set(d.id, d);
  }
  /** Mutation interne ÉTROITE du double pour le dossier et son latch de validation. Le check
   *  puis l'écriture sont synchrones : deux appels de la même révision ne gagnent jamais tous
   *  les deux. Toute autre variation (archive, libellé, tags, lien métier) est refusée. */
  replaceFolderMembershipIfRevision(
    d: Document,
    expectedRevision: number,
  ): 'saved' | 'revision_conflict' | 'not_found' {
    const existing = this.map.get(d.id);
    if (!existing || existing.companyId !== d.companyId || existing.status !== 'active') {
      return 'not_found';
    }
    if (existing.revision !== expectedRevision) return 'revision_conflict';
    const before = existing.toProps();
    const after = d.toProps();
    const {
      folderId: _beforeFolder,
      reviewedAt: _beforeReviewed,
      revision: _beforeRevision,
      ...preservedBefore
    } = before;
    const {
      folderId: _afterFolder,
      reviewedAt: _afterReviewed,
      revision: _afterRevision,
      ...preservedAfter
    } = after;
    if (JSON.stringify(preservedBefore) !== JSON.stringify(preservedAfter)) {
      throw new Error('InMemoryDocumentRepository: non-folder document facts changed.');
    }
    this.map.set(d.id, d);
    return 'saved';
  }
  async attestInvoicePdf(input: import('@bob/core').AttestInvoicePdfInput): Promise<boolean> {
    const document = this.map.get(input.documentId);
    if (!document) return false;
    const props = document.toProps();
    const version = props.versions.find((candidate) => candidate.id === input.versionId);
    if (
      props.companyId !== input.companyId
      || props.kind !== 'invoice_pdf'
      || props.origin !== 'generated'
      || props.status !== 'active'
      || props.linkedEntityType !== 'invoice'
      || props.mimeType !== 'application/pdf'
      || version?.version !== 1
      || props.sha256 !== input.documentSha256
      || version.sha256 !== input.documentSha256
    ) return false;
    const key = `${input.documentId}:${input.versionId}`;
    const existing = this.invoicePdfAttestations.get(key);
    if (existing) return JSON.stringify(existing) === JSON.stringify(input);
    this.invoicePdfAttestations.set(key, { ...input });
    return true;
  }

  async insertInitialOrConfirmExact(
    d: Document,
    invoicePdfAttestation?: import('@bob/core').InvoicePdfRepresentationAttestation,
  ): Promise<import('@bob/core').InitialDocumentInsertResult> {
    const existing = this.map.get(d.id);
    if (!existing) {
      this.map.set(d.id, d);
      if (invoicePdfAttestation !== undefined) {
        const props = d.toProps();
        const accepted = await this.attestInvoicePdf({
          companyId: props.companyId,
          documentId: props.id,
          versionId: props.versions[0]!.id,
          ...invoicePdfAttestation,
        });
        if (!accepted) {
          this.map.delete(d.id);
          throw new Error('Invoice PDF representation attestation rejected.');
        }
      }
      return { status: 'inserted', document: d };
    }
    if (!isExactInitialDocumentReplay(existing, d)) return { status: 'conflict' };
    if (invoicePdfAttestation !== undefined) {
      const props = d.toProps();
      const accepted = await this.attestInvoicePdf({
        companyId: props.companyId,
        documentId: props.id,
        versionId: props.versions[0]!.id,
        ...invoicePdfAttestation,
      });
      if (!accepted) throw new Error('Invoice PDF representation attestation rejected.');
    }
    return { status: 'exact', document: existing };
  }
  /** Rejoue LES DEUX opérations de domaine (classify puis markReviewed, latch) — la révision
   *  persistée correspond exactement à la DocumentView retournée par le use case. */
  async classify(input: {
    companyId: string;
    documentId: string;
    linkedEntityType: Parameters<Document['classify']>[0]['linkedEntityType'];
    linkedEntityId: string;
    reviewedAt: string;
    expectedRevision: number;
  }): Promise<'saved' | 'revision_conflict' | 'not_found'> {
    const current = this.map.get(input.documentId);
    if (!current || current.companyId !== input.companyId || current.status !== 'active')
      return 'not_found';
    if (current.revision !== input.expectedRevision) return 'revision_conflict';
    const next = Document.rehydrate(current.toProps());
    const classified = next.classify({
      linkedEntityType: input.linkedEntityType,
      linkedEntityId: input.linkedEntityId,
    });
    if (!classified.ok) return 'revision_conflict';
    const reviewed = next.markReviewed(input.reviewedAt);
    if (!reviewed.ok) return 'revision_conflict';
    this.map.set(input.documentId, next);
    return 'saved';
  }
  /** Pose la confirmation humaine SANS déplacer ni lier (AcknowledgeDocument) — latch domaine. */
  async markReviewed(input: {
    companyId: string;
    documentId: string;
    reviewedAt: string;
    expectedRevision: number;
  }): Promise<'saved' | 'revision_conflict' | 'not_found'> {
    const current = this.map.get(input.documentId);
    if (!current || current.companyId !== input.companyId || current.status !== 'active')
      return 'not_found';
    if (current.revision !== input.expectedRevision) return 'revision_conflict';
    const next = Document.rehydrate(current.toProps());
    const reviewed = next.markReviewed(input.reviewedAt);
    if (!reviewed.ok) return 'revision_conflict';
    this.map.set(input.documentId, next);
    return 'saved';
  }
  async rename(input: {
    companyId: string;
    documentId: string;
    displayName: string;
    expectedRevision: number;
  }): Promise<'saved' | 'revision_conflict' | 'not_found'> {
    const current = this.map.get(input.documentId);
    if (!current || current.companyId !== input.companyId || current.status !== 'active')
      return 'not_found';
    if (current.revision !== input.expectedRevision) return 'revision_conflict';
    const next = Document.rehydrate(current.toProps());
    const renamed = next.rename(input.displayName);
    if (!renamed.ok) return 'revision_conflict';
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
      return (
        props.companyId === companyId &&
        props.linkedEntityType === entityType &&
        props.linkedEntityId === entityId
      );
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
              candidate.companyId === companyId &&
              candidate.status === 'active' &&
              candidate.parentId === folder.id,
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
          folder.companyId === input.companyId &&
          folder.status === 'active' &&
          folder.parentId === input.parentId,
      )
      .map((folder) => DocumentFolder.rehydrate(folder))
      .sort((a, b) => {
        const left = a.toProps();
        const right = b.toProps();
        return (
          left.normalizedName.localeCompare(right.normalizedName) || left.id.localeCompare(right.id)
        );
      });
    const start = input.cursor
      ? Math.max(0, sorted.findIndex((folder) => folder.id === input.cursor) + 1)
      : 0;
    const page = sorted.slice(start, start + input.limit + 1);
    const hasMore = page.length > input.limit;
    const items = page.slice(0, input.limit);
    return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
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

  async save(
    folder: DocumentFolder,
    expectedRevision: number | null,
  ): Promise<DocumentFolderWriteResult> {
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

  async findDocumentMembership(
    companyId: string,
    documentId: string,
  ): Promise<DocumentFolderMembership | null> {
    const document = await this.documents.findById(companyId, documentId);
    return document
      ? {
          id: document.id,
          companyId: document.companyId,
          folderId: document.folderId,
          status: document.status,
          revision: document.revision,
          reviewedAt: document.reviewedAt,
        }
      : null;
  }

  async listDocumentMemberships(
    companyId: string,
    folderIds: readonly string[],
  ): Promise<DocumentFolderMembership[]> {
    const allowed = new Set(folderIds);
    return (await this.documents.listByCompany(companyId))
      .filter((document) => document.folderId !== null && allowed.has(document.folderId))
      .map((document) => ({
        id: document.id,
        companyId: document.companyId,
        folderId: document.folderId,
        status: document.status,
        revision: document.revision,
        reviewedAt: document.reviewedAt,
      }));
  }

  /** Rejoue moveToFolder PUIS markReviewed (reviewedAt non nul = rangement vaut validation,
   *  latch) sur un CLONE : une tentative perdante ne mute jamais l'agrégat partagé. */
  async moveDocument(input: {
    companyId: string;
    documentId: string;
    targetFolderId: string | null;
    reviewedAt: string | null;
    expectedRevision: number;
  }): Promise<DocumentFolderMembershipWriteResult> {
    const document = await this.documents.findById(input.companyId, input.documentId);
    if (!document || document.status !== 'active') return { status: 'not_found' };
    if (document.revision !== input.expectedRevision) return { status: 'revision_conflict' };
    const next = Document.rehydrate(document.toProps());
    const moved = next.moveToFolder(input.targetFolderId);
    if (!moved.ok) return { status: 'revision_conflict' };
    if (input.reviewedAt !== null) {
      const reviewed = next.markReviewed(input.reviewedAt);
      if (!reviewed.ok) return { status: 'revision_conflict' };
    }
    const write = this.documents.replaceFolderMembershipIfRevision(next, input.expectedRevision);
    return write === 'saved'
      ? { status: 'saved', revision: next.revision }
      : { status: write };
  }
}

export class InMemoryDocumentArchiveJobRepository implements DocumentArchiveJobRepository {
  private readonly map = new Map<string, DocumentArchiveJob>();

  private clone(job: DocumentArchiveJob): DocumentArchiveJob {
    return {
      ...job,
      integrityProof: job.integrityProof === null
        ? null
        : { ...job.integrityProof, artifacts: job.integrityProof.artifacts.map((artifact) => ({ ...artifact })) },
    };
  }

  snapshot(): DocumentArchiveJob[] {
    return [...this.map.values()].map((job) => this.clone(job));
  }

  restore(snapshot: readonly DocumentArchiveJob[]): void {
    this.map.clear();
    for (const job of snapshot) this.map.set(job.id, this.clone(job));
  }

  async enqueue(input: EnqueueDocumentArchiveJobInput): Promise<void> {
    const existing = [...this.map.values()].find(
      (job) =>
        job.companyId === input.companyId &&
        job.pieceId === input.pieceId &&
        job.reason === input.reason,
    );
    // Parité Prisma : le premier ordre et son calendrier gagnent. Un retry d'enqueue ne doit
    // réarmer ni un échec programmé, ni un lease, ni une terminaison prouvée.
    if (existing) return;
    const invoiceReasons = new Set<DocumentArchiveJob['reason']>([
      'invoice-issued',
      'invoice-issued-pdf-only-b2c',
    ]);
    const conflictingInvoiceScope = [...this.map.values()].some(
      (job) =>
        job.companyId === input.companyId
        && job.pieceId === input.pieceId
        && invoiceReasons.has(job.reason)
        && invoiceReasons.has(input.reason),
    );
    if (conflictingInvoiceScope) {
      throw new Error('Invoice archive scope is immutable once enqueued.');
    }
    this.map.set(input.id, {
      id: input.id,
      companyId: input.companyId,
      pieceId: input.pieceId,
      reason: input.reason,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: input.now,
      leaseToken: null,
      lastError: null,
      integrityProof: null,
      integrityProofSha256: null,
      completedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  async findByPiece(
    companyId: string,
    pieceId: string,
    reason: DocumentArchiveJob['reason'],
  ): Promise<DocumentArchiveJob | null> {
    const job = [...this.map.values()].find(
      (candidate) =>
        candidate.companyId === companyId &&
        candidate.pieceId === pieceId &&
        candidate.reason === reason,
    );
    return job ? this.clone(job) : null;
  }

  async countIncomplete(companyId: string, reason: DocumentArchiveJob['reason']): Promise<number> {
    return [...this.map.values()].filter(
      (job) =>
        job.companyId === companyId
        && job.reason === reason
        && (job.status !== 'done' || job.integrityProof === null),
    ).length;
  }

  async listDue(companyId: string, now: string, limit: number): Promise<DocumentArchiveJob[]> {
    return [...this.map.values()]
      .filter((job) => job.companyId === companyId)
      .filter(
        (job) =>
          job.status === 'pending'
          || job.status === 'failed'
          || (job.status === 'done' && job.integrityProof === null),
      )
      .filter((job) => job.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt))
      .slice(0, limit)
      .map((job) => this.clone(job));
  }

  async claimForArchive(
    id: string,
    companyId: string,
    expectedUpdatedAt: string,
    now: string,
    leaseUntil: string,
    leaseToken: string,
  ): Promise<{ outcome: 'claimed'; job: DocumentArchiveJob } | { outcome: 'skipped' }> {
    const job = this.map.get(id);
    const leaseMs = Date.parse(leaseUntil) - Date.parse(now);
    if (!Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > 30 * 60_000) {
      throw new Error('Durée de lease archive invalide.');
    }
    if (
      !job
      || job.companyId !== companyId
      || job.updatedAt !== expectedUpdatedAt
      || job.nextAttemptAt > now
      || job.integrityProof !== null
      || (job.status !== 'pending' && job.status !== 'failed' && job.status !== 'done')
    ) {
      return { outcome: 'skipped' };
    }
    const claimed: DocumentArchiveJob = {
      ...job,
      status: job.status === 'done' ? 'failed' : job.status,
      leaseToken,
      nextAttemptAt: leaseUntil,
      updatedAt: now,
    };
    this.map.set(id, claimed);
    return { outcome: 'claimed', job: this.clone(claimed) };
  }

  async markDone(
    id: string,
    companyId: string,
    leaseToken: string,
    proof: import('./document-archive-jobs').DocumentArchiveIntegrityProof,
    proofSha256: string,
    at: string,
  ): Promise<boolean> {
    const job = this.map.get(id);
    if (
      !job
      || job.companyId !== companyId
      || job.leaseToken !== leaseToken
      || job.nextAttemptAt <= at
      || (job.status !== 'pending' && job.status !== 'failed')
      || proof.companyId !== companyId
      || proof.pieceId !== job.pieceId
      || proof.reason !== job.reason
      || !isValidDocumentArchiveIntegrityProof(proof)
      || documentArchiveIntegrityProofSha256(proof) !== proofSha256
    ) {
      return false;
    }
    this.map.set(id, {
      ...job,
      status: 'done',
      leaseToken: null,
      lastError: null,
      integrityProof: { ...proof, artifacts: proof.artifacts.map((artifact) => ({ ...artifact })) },
      integrityProofSha256: proofSha256,
      completedAt: at,
      updatedAt: at,
    });
    return true;
  }

  async markFailed(
    id: string,
    companyId: string,
    leaseToken: string,
    at: string,
    nextAttemptAt: string,
    error: string,
  ): Promise<boolean> {
    const job = this.map.get(id);
    if (
      !job
      || job.companyId !== companyId
      || job.leaseToken !== leaseToken
      || job.nextAttemptAt <= at
      || (job.status !== 'pending' && job.status !== 'failed')
    ) {
      return false;
    }
    this.map.set(id, {
      ...job,
      status: 'failed',
      attempts: job.attempts + 1,
      leaseToken: null,
      nextAttemptAt,
      lastError: error.slice(0, 2000),
      integrityProof: null,
      integrityProofSha256: null,
      completedAt: null,
      updatedAt: at,
    });
    return true;
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
      (job) =>
        job.companyId === input.companyId &&
        job.kind === input.kind &&
        job.dedupeKey === input.dedupeKey,
    );
    if (existing) {
      if (existing.payloadFingerprint !== payloadFingerprint) {
        throw new NotificationDedupeConflictError(input.dedupeKey);
      }
      // Un job ANNULÉ ne se réactive jamais par ré-enqueue (parité Prisma : seul pending|failed
      // se relance) — l'intention révoquée reste révoquée, l'appelant voit le statut honnête.
      if (existing.status === 'pending' || existing.status === 'failed') {
        // Une clé provider identifie une requête IMMUABLE. Modifier to/subject/body sous la
        // même UUID ferait croire que B a été livré si Brevo avait déjà accepté A.
        // Un lease, même expiré, reste en place pour le chemin de récupération/quarantaine.
        if (existing.nextAttemptAt > input.now || existing.leaseToken !== null)
          return this.clone(existing);
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
      // Livraison planifiée (notBefore) : le worker ne réclame que les jobs dus — un job J+7
      // reste durable et invisible jusqu'à son échéance (embargo L221-10).
      nextAttemptAt: input.notBefore ?? input.now,
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

  async listDue(
    companyId: string,
    now: string,
    limit: number,
  ): Promise<DeliverableNotificationJob[]> {
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
    const attemptedAtMs =
      job.providerAttemptedAt === null ? null : Date.parse(job.providerAttemptedAt);
    const providerWindowExpired =
      attemptedAtMs !== null && Date.parse(now) >= attemptedAtMs + 25 * 60_000;
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
    return (
      job.channel !== 'email' ||
      Date.parse(observedAt) < Date.parse(job.providerAttemptedAt) + 25 * 60_000
    );
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

  async cancelByDedupeKey(
    companyId: string,
    kind: NotificationJob['kind'],
    dedupeKey: string,
    at: string,
  ): Promise<boolean> {
    const job = [...this.map.values()].find(
      (candidate) =>
        candidate.companyId === companyId &&
        candidate.kind === kind &&
        candidate.dedupeKey === dedupeKey,
    );
    if (!job || (job.status !== 'pending' && job.status !== 'failed')) return false;
    this.map.set(job.id, {
      ...job,
      // Payload purgé : même si un état incohérent réapparaissait, ce job n'est PLUS livrable.
      notification: null,
      status: 'cancelled',
      leaseToken: null,
      lastError: null,
      updatedAt: at,
    });
    return true;
  }

  async cancelClaimed(
    id: string,
    companyId: string,
    leaseToken: string,
    at: string,
  ): Promise<boolean> {
    const job = this.map.get(id);
    if (
      !job ||
      job.companyId !== companyId ||
      job.leaseToken !== leaseToken ||
      (job.status !== 'pending' && job.status !== 'failed')
    ) {
      return false;
    }
    this.map.set(id, {
      ...job,
      notification: null,
      status: 'cancelled',
      leaseToken: null,
      lastError: null,
      updatedAt: at,
    });
    return true;
  }

  async listRecent(companyId: string, limit: number): Promise<NotificationJob[]> {
    return [...this.map.values()]
      .filter((job) => job.companyId === companyId)
      // Un job annulé n'a jamais rien livré : il ne surface pas dans le fil (C25).
      .filter((job) => job.status !== 'cancelled')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((job) => this.clone(job));
  }

  async listDoneByKind(
    companyId: string,
    kind: NotificationJob['kind'],
  ): Promise<Array<{ dedupeKey: string; deliveredAt: string }>> {
    return [...this.map.values()]
      .filter((job) => job.companyId === companyId && job.kind === kind && job.status === 'done')
      .map((job) => ({
        dedupeKey: job.dedupeKey,
        deliveredAt: job.providerAttemptedAt ?? job.updatedAt,
      }));
  }

  async previewUnread(companyId: string, observedAt: string): Promise<NotificationUnreadPreview> {
    const unreadCount = [...this.map.values()].filter(
      (job) =>
        job.companyId === companyId &&
        job.status !== 'cancelled' &&
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
      if (job.companyId !== companyId || job.readAt !== null || job.createdAt >= throughCreatedAt) {
        continue;
      }
      this.map.set(id, { ...job, readAt: at, updatedAt: at });
      updatedCount += 1;
    }
    return { updatedCount, readAt: at, cutoffAccepted: true };
  }
}

/** Appareils push Expo (C25) — un token global, rebind atomique vers le dernier principal. */
export class InMemoryDeviceRepository implements DeviceRepository {
  private readonly map = new Map<string, DeviceRecord>();
  private readonly installations = new Map<
    string,
    {
      revocationSecretHash: string;
      maxGeneration: number;
      currentBindingId: string | null;
      currentCompanyId: string | null;
      currentUserId: string | null;
      lastConfirmedAt: string | null;
    }
  >();

  async register(input: RegisterDeviceInput): Promise<DeviceRegistrationResult> {
    const rows = [...this.map.values()];
    const byToken = rows.find((device) => device.expoPushToken === input.expoPushToken);
    const byInstallation = rows.find((device) => device.installationId === input.installationId);
    const installation = this.installations.get(input.installationId);
    if (installation) {
      if (installation.revocationSecretHash !== input.revocationSecretHash) {
        return { status: 'superseded' };
      }
      const idempotent =
        input.bindingGeneration === installation.maxGeneration &&
        installation.currentBindingId === input.bindingId &&
        installation.currentCompanyId === input.companyId &&
        installation.currentUserId === input.userId &&
        byInstallation?.expoPushToken === input.expoPushToken &&
        byInstallation.bindingId === input.bindingId &&
        byInstallation.bindingGeneration === input.bindingGeneration;
      if (
        input.bindingGeneration < installation.maxGeneration ||
        (input.bindingGeneration === installation.maxGeneration && !idempotent)
      ) {
        return { status: 'superseded' };
      }
    }

    const bindingCollision = rows.find(
      (device) =>
        device.bindingId === input.bindingId &&
        device.id !== byToken?.id &&
        device.id !== byInstallation?.id,
    );
    if (bindingCollision) return { status: 'superseded' };

    // Toute validation est terminée avant mutation : l'adapter en mémoire reste atomique comme
    // la transaction PostgreSQL et ne laisse jamais un high-water mark partiellement avancé.
    this.installations.set(input.installationId, {
      revocationSecretHash: input.revocationSecretHash,
      maxGeneration: input.bindingGeneration,
      currentBindingId: input.bindingId,
      currentCompanyId: input.companyId,
      currentUserId: input.userId,
      lastConfirmedAt: input.now,
    });

    // Un token Expo est global. Quand B le reprend, l'installation A est neutralisée avant que
    // sa réponse POST retardée puisse tenter de le récupérer avec la même génération.
    if (byToken?.installationId && byToken.installationId !== input.installationId) {
      const previous = this.installations.get(byToken.installationId);
      if (
        previous &&
        previous.currentBindingId === byToken.bindingId &&
        previous.maxGeneration === byToken.bindingGeneration
      ) {
        this.installations.set(byToken.installationId, {
          ...previous,
          currentBindingId: null,
          currentCompanyId: null,
          currentUserId: null,
        });
      }
    }
    if (byToken && byInstallation && byToken.id !== byInstallation.id) {
      this.map.delete(byInstallation.id);
    }
    const existing = byToken ?? byInstallation;
    if (existing) {
      const updated: DeviceRecord = {
        ...existing,
        companyId: input.companyId,
        userId: input.userId,
        expoPushToken: input.expoPushToken,
        platform: input.platform,
        installationId: input.installationId,
        bindingId: input.bindingId,
        bindingGeneration: input.bindingGeneration,
        revocationSecretHash: input.revocationSecretHash,
        updatedAt: input.now,
      };
      this.map.set(existing.id, updated);
      return { status: 'bound', device: { ...updated } };
    }
    const created: DeviceRecord = {
      id: input.id,
      companyId: input.companyId,
      userId: input.userId,
      expoPushToken: input.expoPushToken,
      platform: input.platform,
      installationId: input.installationId,
      bindingId: input.bindingId,
      bindingGeneration: input.bindingGeneration,
      revocationSecretHash: input.revocationSecretHash,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.map.set(created.id, created);
    return { status: 'bound', device: { ...created } };
  }

  async listDeliveryTargetsByCompany(
    companyId: string,
    confirmedAfter: string,
  ): Promise<PushDeliveryTarget[]> {
    return [...this.map.values()]
      .filter((d) => {
        if (
          d.companyId !== companyId ||
          d.installationId === null ||
          d.bindingId === null ||
          d.bindingGeneration === null ||
          d.revocationSecretHash === null ||
          d.updatedAt < confirmedAfter
        )
          return false;
        const installation = this.installations.get(d.installationId);
        return (
          installation !== undefined &&
          installation.revocationSecretHash === d.revocationSecretHash &&
          installation.currentBindingId === d.bindingId &&
          installation.maxGeneration === d.bindingGeneration &&
          installation.currentCompanyId === d.companyId &&
          installation.currentUserId === d.userId &&
          installation.lastConfirmedAt !== null &&
          installation.lastConfirmedAt >= confirmedAfter
        );
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((d) => ({
        expoPushToken: d.expoPushToken,
        platform: d.platform,
        bindingId: d.bindingId!,
        bindingGeneration: d.bindingGeneration!,
        updatedAt: d.updatedAt,
      }));
  }

  async revokeLegacyOwnerToken(
    companyId: string,
    userId: string | null,
    expoPushToken: string,
  ): Promise<void> {
    for (const [id, d] of this.map) {
      if (
        d.companyId === companyId &&
        d.userId === userId &&
        d.expoPushToken === expoPushToken &&
        d.installationId === null &&
        d.bindingId === null &&
        d.bindingGeneration === null &&
        d.revocationSecretHash === null
      ) {
        this.map.delete(id);
      }
    }
  }

  async removeInvalidDeliveryTarget(input: InvalidPushDeliveryTarget): Promise<void> {
    const device = [...this.map.values()].find(
      (candidate) =>
        candidate.companyId === input.companyId &&
        candidate.expoPushToken === input.expoPushToken &&
        candidate.bindingId === input.bindingId &&
        candidate.bindingGeneration === input.bindingGeneration,
    );
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
    const installation = this.installations.get(input.installationId);
    if (!installation) {
      if (input.scope.kind === 'public') return;
      this.installations.set(input.installationId, {
        revocationSecretHash: input.revocationSecretHash,
        maxGeneration: input.throughGeneration,
        currentBindingId: null,
        currentCompanyId: null,
        currentUserId: null,
        lastConfirmedAt: null,
      });
      return;
    }
    if (installation.revocationSecretHash !== input.revocationSecretHash) return;
    const accepted = installation.maxGeneration <= input.throughGeneration;
    if (accepted) {
      this.installations.set(input.installationId, {
        ...installation,
        maxGeneration: input.throughGeneration,
        currentBindingId: null,
        currentCompanyId: null,
        currentUserId: null,
      });
    }
    // Parité PostgreSQL : même si le parent est déjà à un high-water supérieur, une ancienne
    // ligne Device orpheline <= N doit être purgée avec la capacité exacte.
    for (const [id, device] of this.map) {
      if (
        device.installationId === input.installationId &&
        device.revocationSecretHash === input.revocationSecretHash &&
        device.bindingGeneration !== null &&
        device.bindingGeneration <= input.throughGeneration
      )
        this.map.delete(id);
    }
  }

  async deleteAllForCompany(companyId: string): Promise<void> {
    for (const [id, device] of this.map) {
      if (device.companyId !== companyId) continue;
      if (device.installationId !== null) {
        const installation = this.installations.get(device.installationId);
        if (
          installation &&
          installation.currentCompanyId === companyId &&
          installation.currentBindingId === device.bindingId
        ) {
          this.installations.set(device.installationId, {
            ...installation,
            currentBindingId: null,
            currentCompanyId: null,
            currentUserId: null,
          });
        }
      }
      this.map.delete(id);
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
  /** E3 : encaissements datés du tenant — métriques client, CA encaissé et balance âgée. */
  async listByCompany(companyId: string): Promise<Payment[]> {
    return this.list.filter((p) => p.companyId === companyId);
  }
}

export class InMemoryPublicAccessTokenRepository implements PublicAccessTokenRepository {
  private readonly rows = new Map<
    string,
    PublicAccessGrant & { token: string; lastUsedAt: string | null }
  >();

  async create(input: {
    companyId: string;
    resourceType: PublicAccessResourceType;
    resourceId: string;
    scope: PublicAccessScope;
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

  async lockActive(token: string, at: string): Promise<PublicAccessGrant | null> {
    return this.findActive(token, at);
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
    resourceType: PublicAccessResourceType;
    resourceId: string;
    scope: PublicAccessScope;
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

  async revokeAllForCompany(input: { companyId: string; at: string }): Promise<void> {
    for (const [id, row] of this.rows) {
      if (row.companyId === input.companyId && row.revokedAt === null) {
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
        if (
          o.companyId === props.companyId &&
          o.supplierSiren === siren &&
          o.supplierInvoiceNumber === invoiceNumber
        ) {
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
    return new Map(
      [...this.map].map(([id, expense]) => [id, Expense.rehydrate(expense.toProps())]),
    );
  }

  restore(snapshot: Map<string, Expense>): void {
    this.map = new Map(
      [...snapshot].map(([id, expense]) => [id, Expense.rehydrate(expense.toProps())]),
    );
  }
}

export class InMemoryAccountingEntryRepository implements AccountingEntryRepository {
  private map = new Map<string, AccountingEntry>();

  async save(entry: AccountingEntry): Promise<void> {
    this.map.set(entry.id, AccountingEntry.rehydrate(entry.toProps()));
  }

  async findById(companyId: string, id: string): Promise<AccountingEntry | null> {
    const entry = this.map.get(id);
    return entry && entry.companyId === companyId
      ? AccountingEntry.rehydrate(entry.toProps())
      : null;
  }

  async listByCompany(companyId: string): Promise<AccountingEntry[]> {
    return [...this.map.values()]
      .filter((entry) => entry.companyId === companyId)
      .map((entry) => AccountingEntry.rehydrate(entry.toProps()));
  }

  snapshot(): Map<string, AccountingEntry> {
    return new Map(
      [...this.map].map(([id, entry]) => [id, AccountingEntry.rehydrate(entry.toProps())]),
    );
  }

  restore(snapshot: Map<string, AccountingEntry>): void {
    this.map = new Map(
      [...snapshot].map(([id, entry]) => [id, AccountingEntry.rehydrate(entry.toProps())]),
    );
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
  private map = new Map<string, Chantier>();
  async save(c: Chantier): Promise<void> {
    this.map.set(c.id, c);
  }
  async findById(id: string): Promise<Chantier | null> {
    return this.map.get(id) ?? null;
  }
  async listByCompany(companyId: string): Promise<Chantier[]> {
    return [...this.map.values()].filter((c) => c.companyId === companyId);
  }

  snapshot(): Map<string, Chantier> {
    return new Map(
      [...this.map].map(([id, chantier]) => [id, Chantier.rehydrate(chantier.toProps())]),
    );
  }

  restore(snapshot: Map<string, Chantier>): void {
    this.map = new Map(
      [...snapshot].map(([id, chantier]) => [id, Chantier.rehydrate(chantier.toProps())]),
    );
  }
}

/** Agrège companyId/chantierId → nombre de lignes — même contrat que le groupBy Prisma
 * (PrismaChantierNoteRepository/PrismaWorksiteMediaStorage), pour que le double en mémoire des
 * tests exerce EXACTEMENT le même comportement (tenant-scoped, sans les chantiers à 0). */
function countByChantier(
  rows: Iterable<{ companyId: string; chantierId: string }>,
  companyId: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.companyId !== companyId) continue;
    counts.set(row.chantierId, (counts.get(row.chantierId) ?? 0) + 1);
  }
  return counts;
}

export class InMemoryChantierNoteRepository implements ChantierNoteRepository {
  private rows: ChantierNote[] = [];
  async save(n: ChantierNote): Promise<void> {
    this.rows.push(n);
  }
  async listByChantier(companyId: string, chantierId: string): Promise<ChantierNote[]> {
    return this.rows
      .filter((n) => n.companyId === companyId && n.chantierId === chantierId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async countByCompany(companyId: string): Promise<Map<string, number>> {
    return countByChantier(this.rows, companyId);
  }

  snapshot(): ChantierNote[] {
    return this.rows.map((n) => ChantierNote.rehydrate(n.toProps()));
  }

  restore(snapshot: ChantierNote[]): void {
    this.rows = snapshot.map((n) => ChantierNote.rehydrate(n.toProps()));
  }
}

export class InMemoryWorksiteMediaStorage implements WorksiteMediaStorage {
  private map = new Map<string, WorksiteMediaItem>();
  async save(item: WorksiteMediaItem): Promise<void> {
    this.map.set(item.id, item);
  }
  async listByChantier(companyId: string, chantierId: string): Promise<WorksiteMediaItem[]> {
    return [...this.map.values()]
      .filter((i) => i.companyId === companyId && i.chantierId === chantierId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async findById(companyId: string, id: string): Promise<WorksiteMediaItem | null> {
    const item = this.map.get(id);
    return item && item.companyId === companyId ? item : null;
  }
  async remove(companyId: string, id: string): Promise<void> {
    const item = this.map.get(id);
    if (item && item.companyId === companyId) this.map.delete(id);
  }
  async countByCompany(companyId: string): Promise<Map<string, number>> {
    return countByChantier(this.map.values(), companyId);
  }

  snapshot(): Map<string, WorksiteMediaItem> {
    return new Map(this.map);
  }

  restore(snapshot: Map<string, WorksiteMediaItem>): void {
    this.map = new Map(snapshot);
  }
}

/** Adapter de test/démo uniquement. Le runtime live injecte PrismaCatalogueRepository. */
export class InMemoryCatalogueRepository implements CatalogueRepository {
  private map = new Map<string, CatalogueItemRecord>();

  async listByCompany(companyId: string): Promise<readonly CatalogueItemRecord[]> {
    return [...this.map.values()]
      .filter((item) => item.companyId === companyId)
      .map((item) => ({ ...item }))
      .sort((left, right) => left.label.localeCompare(right.label, 'fr'));
  }

  async create(item: CatalogueItemRecord): Promise<CatalogueCreateWriteResult> {
    if (this.map.has(item.id)) return { status: 'id_conflict' };
    this.map.set(item.id, { ...item });
    return { status: 'created', item: { ...item } };
  }

  async update(
    input: Parameters<CatalogueRepository['update']>[0],
  ): Promise<CatalogueUpdateWriteResult> {
    const current = this.map.get(input.id);
    if (current === undefined || current.companyId !== input.companyId)
      return { status: 'not_found' };
    if (current.revision !== input.expectedRevision) return { status: 'revision_conflict' };
    const updated: CatalogueItemRecord = {
      ...input.item,
      createdAt: current.createdAt,
    };
    this.map.set(input.id, updated);
    return { status: 'updated', item: { ...updated } };
  }

  async delete(
    input: Parameters<CatalogueRepository['delete']>[0],
  ): Promise<CatalogueDeleteWriteResult> {
    const current = this.map.get(input.id);
    if (current === undefined || current.companyId !== input.companyId)
      return { status: 'not_found' };
    if (current.revision !== input.expectedRevision) return { status: 'revision_conflict' };
    this.map.delete(input.id);
    return { status: 'deleted' };
  }

  snapshot(): Map<string, CatalogueItemRecord> {
    return new Map([...this.map].map(([id, item]) => [id, { ...item }]));
  }

  restore(snapshot: Map<string, CatalogueItemRecord>): void {
    this.map = new Map([...snapshot].map(([id, item]) => [id, { ...item }]));
  }
}

export class InMemorySequenceCounter implements SequenceCounterPort {
  private readonly counters = new Map<string, number>();
  async allocate(input: {
    companyId: string;
    counterKey: CounterKey;
    fiscalYear: number;
  }): Promise<{
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

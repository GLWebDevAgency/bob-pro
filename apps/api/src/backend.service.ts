import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  CreateQuote,
  SendQuote,
  SignQuote,
  RefuseQuote,
  ExpireQuote,
  GenerateInvoiceFromQuote,
  IssueInvoice,
  RegisterPayment,
  ListCustomers,
  GetCashflow,
  SystemClock,
  buildRelance,
  ok,
  appNotFound,
  appForbidden,
  appDomain,
  Company,
  Customer,
  Subscription,
  PLAN_CATALOG,
  ADDON_CATALOG,
  planEntitlements,
  planCan,
  tierAtLeast,
  runDiagnostic,
  resolveTradeConfig,
  facturXDataFromInvoice,
  buildFacturXBasicXml,
  ExtractDocument,
  RecordExpense,
  CreateChantier,
  AutofillCompanyFromSiret,
  ValidateVatNumber,
  SearchAddress,
  CreateQuoteSignatureToken,
  ResolveQuoteSignatureToken,
  StoreDocument,
  ListDocuments,
  GetDocumentDownloadUrl,
  buildDocumentStorageKey,
  buildIssuedInvoiceAccountingEntry,
  MERCIER_PROPS,
  CASH_SNAPSHOT,
  type Result,
  type AppError,
  type CreateQuoteInput,
  type Scenario,
  type Horizon,
  type PaymentMethod,
  type Quote,
  type Invoice,
  type ClockPort,
  type QuoteLine,
  type Totals,
  type PlanTier,
  type PaymentGatewayPort,
  type PdfRendererPort,
  type InvoicePdfData,
  type CompanyProps,
  type CustomerProps,
  type DiagnosticResult,
  type TradeConfig,
  type ChantierProps,
  type CreateChantierInput,
  type CompanyLookupPort,
  type CompanyLookupResult,
  type VatValidationPort,
  type VatCheckResult,
  type AddressAutocompletePort,
  type AddressSuggestion,
  type OcrExtraction,
  type OcrPort,
  type RecordExpenseInput,
  type ExpenseProps,
  type DocumentKind,
  type DocumentLinkedEntityType,
  type DocumentOrigin,
  type DocumentView,
  type DocumentDownloadUrl,
} from '@bob/core';
import {
  BobAgent,
  ModelRouter,
  pendingToInvocations,
  type BobActions,
  type AgentRun,
  type PendingAction,
  type AgentAutonomy,
  type JournalEntry,
} from '@bob/ai';
import type { TtsResult } from '@bob/ai';
import { UuidGenerator, FixtureCashflowSnapshot, InMemoryChantierRepository } from './persistence/in-memory';
import { RechercheEntreprisesAdapter } from './adapters/recherche-entreprises.adapter';
import { ViesVatAdapter } from './adapters/vies-vat.adapter';
import { BanAddressAdapter } from './adapters/ban-address.adapter';
import { PERSISTENCE, type Persistence } from './persistence/persistence';
import { CompanyScopedJournalStore } from './persistence/agent-journal';
import { Metrics } from './observability/metrics';
import { AppLogger, getPrincipal } from './observability/logger';
import { PAYMENT_GATEWAY } from './payments/payment-gateway';
import { PDF_RENDERER } from './documents/pdf-renderer';
import { buildDocumentStorage, documentSha256 } from './documents/storage';
import { generatedInvoiceDocumentId, generatedInvoiceDocumentVersionId } from './documents/generated-document-ids';
import { OCR_PORT } from './ocr/ocr';
import { hasClaudeKey, hasGlmKey, hasDeepseekKey, hasMistralKey, hasOpenaiKey } from './config/env';
import { buildLlmForProvider, buildSttCloud, buildTtsCloud } from './ai/providers';
import { clampAgentAutonomy } from './ai/autonomy-entitlements';
import { NotificationDeliveryService } from './jobs/notification-delivery.service';
import { remainingInvoiceBalanceCents } from './billing/invoice-balance';

export interface QuoteView {
  id: string;
  companyId: string;
  customerId: string;
  status: string;
  number: string | null;
  depositPct: number | null;
  lines: QuoteLine[];
  totals: Totals;
  validUntil: string | null;
  signed: boolean;
}

export interface InvoiceView {
  id: string;
  companyId: string;
  customerId: string;
  kind: string;
  status: string;
  number: string | null;
  parentQuoteId: string | null;
  totals: Totals;
  mentions: string[];
  dueAt: string | null;
  paid: number;
}

export interface AccountingPreviewLine {
  account: string;
  label: string;
  debitCents: number;
  creditCents: number;
}

export interface InvoiceAccountingPreview {
  invoiceId: string;
  available: boolean;
  reason: string | null;
  entryId: string | null;
  reference: string | null;
  entryDate: string | null;
  label: string | null;
  totalDebitCents: number;
  totalCreditCents: number;
  lines: AccountingPreviewLine[];
}

/** Vue publique d'un devis pour la page de signature client à distance (lien tokenisé). */
export interface SignatureView {
  number: string | null;
  companyName: string;
  customerName: string;
  status: string;
  signed: boolean;
  expired: boolean;
  validUntil: string | null;
  lines: { label: string; qty: number; unitPriceHT: number; vatRate: number }[];
  totals: Totals;
}

interface ResolvedSignatureGrant {
  grantId: string;
  companyId: string;
  quoteId: string;
}

export interface UploadDocumentInput {
  contentBase64: string;
  mimeType: string;
  filename: string;
  kind?: DocumentKind;
  linkedEntityType?: DocumentLinkedEntityType | null;
  linkedEntityId?: string | null;
  documentDate?: string | null;
}

export interface ListDocumentsInput {
  kind?: DocumentKind;
  linkedEntityType?: DocumentLinkedEntityType;
  linkedEntityId?: string;
  includeDeleted?: boolean;
}

function decodeBase64Document(contentBase64: string): Result<Uint8Array, AppError> {
  const raw = contentBase64.includes(',') ? contentBase64.slice(contentBase64.indexOf(',') + 1) : contentBase64;
  const normalized = raw.replace(/\s/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'contentBase64', message: 'Base64 invalide.' }] } };
  }
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.byteLength === 0) {
    return { ok: false, error: { kind: 'validation', issues: [{ field: 'contentBase64', message: 'Document vide.' }] } };
  }
  return ok(bytes);
}

function appErrorSummary(error: AppError): string {
  if (error.kind === 'domain') return `${error.error.code}:${'field' in error.error ? error.error.field : ''}`;
  if (error.kind === 'not_found') return `not_found:${error.entity}:${error.id}`;
  if (error.kind === 'forbidden') return `forbidden:${error.reason}`;
  if (error.kind === 'validation') return `validation:${error.issues.map((i) => `${i.field}:${i.message}`).join(';')}`;
  return `dependency:${error.port}:${error.cause}`;
}

function addMinutesIso(instant: string, minutes: number): string {
  const d = new Date(instant);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString();
}

function nextArchiveRetryAt(now: string, attempts: number): string {
  const delayMinutes = Math.min(60, Math.max(1, 2 ** attempts));
  return addMinutesIso(now, delayMinutes);
}

function publicSignatureUrl(token: string): string {
  const base = (process.env.SIGN_WEB_BASE_URL ?? 'https://demo.bobpro.fr').replace(/\/$/, '');
  return `${base}/sign/${encodeURIComponent(token)}`;
}

function notificationDedupeHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Autorité serveur : wire les use cases du domaine sur le bundle Persistence injecté
 * (in-memory en démo, Prisma/Postgres en prod). L'app bascule en HttpBobClient sans changer d'écran.
 */
@Injectable()
export class BackendService {
  private readonly ids = new UuidGenerator();
  private readonly clock: ClockPort = new SystemClock();
  private readonly snapshots = new FixtureCashflowSnapshot(CASH_SNAPSHOT);
  // Module Chantiers (BTP) en mémoire pour l'instant — persistance Prisma = incrément suivant.
  private readonly chantiers = new InMemoryChantierRepository();
  // Recherche d'entreprise par SIRET (API publique gratuite) — autofill onboarding/client.
  private readonly companyLookup: CompanyLookupPort = new RechercheEntreprisesAdapter();
  // Validation TVA (VIES) + autocomplétion d'adresse (BAN) — APIs publiques gratuites.
  private readonly vat: VatValidationPort = new ViesVatAdapter();
  private readonly addresses: AddressAutocompletePort = new BanAddressAdapter();
  // STT cloud (Whisper) — actif seulement si une clé OpenAI est configurée ; sinon dictée native côté device.
  private readonly stt = buildSttCloud();
  private readonly tts = buildTtsCloud();
  private readonly documentStorage = buildDocumentStorage();
  private readonly subscription: Subscription;

  /** Tenant courant : companyId du Principal authentifié (défaut = société de seed en démo). */
  private companyId(): string {
    return getPrincipal()?.companyId ?? MERCIER_PROPS.id;
  }

  constructor(
    @Inject(PERSISTENCE) private readonly p: Persistence,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayPort,
    @Inject(PDF_RENDERER) private readonly pdf: PdfRendererPort,
    @Inject(OCR_PORT) private readonly ocr: OcrPort,
    private readonly notificationDelivery: NotificationDeliveryService,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {
    const seed = Subscription.start({ id: 'sub-mercier', companyId: MERCIER_PROPS.id, tier: 'business', status: 'active' });
    if (!seed.ok) throw new Error('abonnement de seed invalide');
    this.subscription = seed.value;
  }

  private mapQuote(q: Quote): QuoteView {
    return {
      id: q.id,
      companyId: q.companyId,
      customerId: q.customerId,
      status: q.status,
      number: q.number,
      depositPct: q.depositPct,
      lines: [...q.lines],
      totals: q.totals(),
      validUntil: q.validUntil,
      signed: q.signature !== null,
    };
  }

  private mapInvoice(i: Invoice): InvoiceView {
    return {
      id: i.id,
      companyId: i.companyId,
      customerId: i.customerId,
      kind: i.kind,
      status: i.status,
      number: i.number,
      parentQuoteId: i.parentQuoteId,
      totals: i.totals(),
      mentions: [...i.mentions],
      dueAt: i.dueAt,
      paid: i.paid,
    };
  }

  listCustomers() {
    return new ListCustomers({ customers: this.p.customers }).execute({ companyId: this.companyId() });
  }
  getCashflow(scenario: Scenario, horizon: Horizon) {
    return new GetCashflow({ snapshots: this.snapshots, expenses: this.p.expenses }).execute({
      companyId: this.companyId(),
      scenario,
      horizon,
    });
  }
  createQuote(input: Omit<CreateQuoteInput, 'companyId'>) {
    return new CreateQuote({
      quotes: this.p.quotes,
      companies: this.p.companies,
      customers: this.p.customers,
      ids: this.ids,
      clock: this.clock,
    }).execute({ companyId: this.companyId(), ...input });
  }
  async sendQuote(quoteId: string) {
    const quote = await this.ownedQuote(quoteId);
    if (!quote) return { ok: false as const, error: appNotFound('quote', quoteId) };
    const sent = await new SendQuote({ quotes: this.p.quotes, counters: this.p.counters, uow: this.p, clock: this.clock }).execute({
      quoteId,
    });
    if (!sent.ok) return sent;
    const token = await new CreateQuoteSignatureToken({
      quotes: this.p.quotes,
      publicAccessTokens: this.p.publicAccessTokens,
      clock: this.clock,
    }).execute({ quoteId });
    if (token.ok) {
      this.logger.audit('quote.signature_token_created', { quoteId, expiresAt: token.value.expiresAt });
      const emailSent = await this.enqueueAndTrySendQuoteForSignature(quote, sent.value.number, token.value.token);
      return ok({ ...sent.value, signatureToken: token.value.token, signatureTokenExpiresAt: token.value.expiresAt, emailSent });
    }
    return sent;
  }

  private async enqueueAndTrySendQuoteForSignature(quote: Quote, number: string, token: string): Promise<boolean> {
    const customer = await this.p.customers.findById(quote.customerId);
    const company = await this.p.companies.findById(quote.companyId);
    const email = customer?.toProps().email;
    if (!email) {
      this.logger.audit('quote.email_skipped', { quoteId: quote.id, reason: 'customer_email_missing' });
      return false;
    }
    const job = await this.notificationDelivery.enqueue({
      companyId: quote.companyId,
      kind: 'quote-signature',
      dedupeKey: `quote:${quote.id}:signature-token:${notificationDedupeHash(token)}`,
      notification: {
        channel: 'email',
        to: email,
        subject: `Devis ${number} à signer`,
        body: [
          `Bonjour ${customer?.name ?? ''},`,
          '',
          `${company?.name ?? 'Votre prestataire'} vous a envoyé le devis ${number}.`,
          'Vous pouvez le consulter et le signer ici :',
          publicSignatureUrl(token),
          '',
          'Ce lien est personnel. Si vous avez une question, répondez directement à votre prestataire.',
        ].join('\n'),
      },
    });
    if (job.status === 'done' || job.notification === null) return true;
    const sent = await this.notificationDelivery.tryDeliver(quote.companyId, { ...job, notification: job.notification });
    this.logger.audit(sent ? 'quote.email_sent' : 'quote.email_queued_retry', { quoteId: quote.id, number, to: email, jobId: job.id });
    return sent;
  }
  async signQuote(input: { quoteId: string; signerName: string }) {
    if (!(await this.ownedQuote(input.quoteId))) return { ok: false as const, error: appNotFound('quote', input.quoteId) };
    return new SignQuote({ quotes: this.p.quotes, uow: this.p, clock: this.clock }).execute(input);
  }
  async refuseQuote(quoteId: string) {
    if (!(await this.ownedQuote(quoteId))) return { ok: false as const, error: appNotFound('quote', quoteId) };
    const r = await new RefuseQuote({
      quotes: this.p.quotes,
      publicAccessTokens: this.p.publicAccessTokens,
      uow: this.p,
      clock: this.clock,
    }).execute({ quoteId });
    if (r.ok) this.logger.audit('quote.refused', { quoteId, status: r.value.status });
    return r;
  }
  async generateInvoice(input: { quoteId: string; mode?: 'deposit' | 'final' }) {
    if (!(await this.ownedQuote(input.quoteId))) return { ok: false as const, error: appNotFound('quote', input.quoteId) };
    return new GenerateInvoiceFromQuote({ quotes: this.p.quotes, invoices: this.p.invoices, ids: this.ids }).execute(input);
  }
  async issueInvoice(input: { invoiceId: string }) {
    if (!(await this.ownedInvoice(input.invoiceId))) return { ok: false as const, error: appNotFound('invoice', input.invoiceId) };
    const r = await new IssueInvoice({
      invoices: this.p.invoices,
      companies: this.p.companies,
      customers: this.p.customers,
      counters: this.p.counters,
      uow: this.p,
      clock: this.clock,
    }).execute(input);
    if (r.ok) {
      this.logger.audit('invoice.issued', { invoiceId: input.invoiceId, number: r.value.number });
      await this.enqueueInvoiceArchive(input.invoiceId);
      await this.runDocumentArchiveJobs({ limit: 5 });
    }
    return r;
  }
  async registerPayment(input: { invoiceId: string; amount: number; method: PaymentMethod; idempotencyKey?: string | null }) {
    if (!(await this.ownedInvoice(input.invoiceId))) return { ok: false as const, error: appNotFound('invoice', input.invoiceId) };
    const r = await new RegisterPayment({
      invoices: this.p.invoices,
      payments: this.p.payments,
      uow: this.p,
      ids: this.ids,
      clock: this.clock,
    }).execute(input);
    if (r.ok) this.logger.audit('payment.registered', { invoiceId: input.invoiceId, amount: input.amount, status: r.value.status });
    return r;
  }
  // ——— Garde multi-tenant : un accès par id n'est valide que si l'agrégat appartient au tenant courant.
  // On renvoie null (=> not_found) plutôt qu'une erreur d'autorisation, pour ne pas divulguer l'existence.
  private async ownedQuote(id: string): Promise<Quote | null> {
    const q = await this.p.quotes.findById(id);
    return q && q.companyId === this.companyId() ? q : null;
  }
  private async ownedInvoice(id: string): Promise<Invoice | null> {
    const i = await this.p.invoices.findById(id);
    return i && i.companyId === this.companyId() ? i : null;
  }

  async getQuote(id: string): Promise<Result<QuoteView, AppError>> {
    const q = await this.ownedQuote(id);
    if (!q) return { ok: false, error: appNotFound('quote', id) };
    return ok(this.mapQuote(q));
  }
  async listQuotes(): Promise<Result<QuoteView[], AppError>> {
    const list = await this.p.quotes.listByCompany(this.companyId());
    return ok(list.map((q) => this.mapQuote(q)));
  }
  async getInvoice(id: string): Promise<Result<InvoiceView, AppError>> {
    const i = await this.ownedInvoice(id);
    if (!i) return { ok: false, error: appNotFound('invoice', id) };
    return ok(this.mapInvoice(i));
  }

  async invoiceAccountingPreview(invoiceId: string): Promise<Result<InvoiceAccountingPreview, AppError>> {
    const invoice = await this.ownedInvoice(invoiceId);
    if (!invoice) return { ok: false, error: appNotFound('invoice', invoiceId) };
    const chart = await this.p.chartOfAccounts.findByCompany(invoice.companyId);
    const entry = buildIssuedInvoiceAccountingEntry({
      entryId: `preview-invoice-${invoice.id}`,
      invoice,
      ...(chart ? { chart } : {}),
    });
    if (!entry.ok) {
      return ok({
        invoiceId,
        available: false,
        reason: 'message' in entry.error && typeof entry.error.message === 'string' ? entry.error.message : 'Aperçu comptable indisponible.',
        entryId: null,
        reference: invoice.number,
        entryDate: invoice.issuedAt,
        label: null,
        totalDebitCents: 0,
        totalCreditCents: 0,
        lines: [],
      });
    }
    const props = entry.value.toProps();
    return ok({
      invoiceId,
      available: true,
      reason: null,
      entryId: props.id,
      reference: props.reference,
      entryDate: props.entryDate,
      label: props.label,
      totalDebitCents: entry.value.totalDebitCents,
      totalCreditCents: entry.value.totalCreditCents,
      lines: props.lines,
    });
  }

  async listInvoices(): Promise<Result<InvoiceView[], AppError>> {
    const list = await this.p.invoices.listByCompany(this.companyId());
    return ok(list.map((i) => this.mapInvoice(i)));
  }

  private async resolveSignatureGrant(token: string): Promise<Result<ResolvedSignatureGrant, AppError>> {
    const resolved = await new ResolveQuoteSignatureToken({
      publicAccessTokens: this.p.publicAccessTokens,
      clock: this.clock,
    }).execute({ token });
    return resolved;
  }

  // ——— Signature client à distance (public, par lien tokenisé) ———
  /** Vue publique d'un devis par token opaque. */
  async publicQuoteForSignature(token: string): Promise<Result<SignatureView, AppError>> {
    const grant = await this.resolveSignatureGrant(token);
    if (!grant.ok) return grant;
    return this.p.runWithTenant(grant.value.companyId, async () => {
      const q = await this.p.quotes.findById(grant.value.quoteId);
      if (!q) return { ok: false, error: appNotFound('quote', 'redacted') };
      const company = await this.p.companies.findById(q.companyId);
      const customer = await this.p.customers.findById(q.customerId);
      await this.p.publicAccessTokens.markUsed(grant.value.grantId, this.clock.now());
      return ok({
        number: q.number,
        companyName: company?.name ?? '',
        customerName: customer?.name ?? '',
        status: q.status,
        signed: q.signature !== null,
        expired: q.validUntil !== null && q.validUntil < this.clock.today(),
        validUntil: q.validUntil,
        lines: q.lines.map((l) => ({ label: l.label, qty: l.qty, unitPriceHT: l.unitPriceHT, vatRate: l.vatRate })),
        totals: q.totals(),
      });
    });
  }

  async publicSignQuote(token: string, signerName: string): Promise<Result<{ status: string }, AppError>> {
    const grant = await this.resolveSignatureGrant(token);
    if (!grant.ok) return grant;
    return this.p.runWithTenant(grant.value.companyId, async () => {
      const q = await this.p.quotes.findById(grant.value.quoteId);
      if (!q) return { ok: false, error: appNotFound('quote', 'redacted') };
      if (q.validUntil !== null && q.validUntil < this.clock.today()) {
        const expired = await new ExpireQuote({
          quotes: this.p.quotes,
          publicAccessTokens: this.p.publicAccessTokens,
          uow: this.p,
          clock: this.clock,
        }).execute({ quoteId: grant.value.quoteId });
        if (expired.ok) this.logger.audit('quote.expired', { quoteId: grant.value.quoteId, status: expired.value.status });
        return { ok: false, error: appForbidden('Devis expiré : signature impossible.') };
      }
      const r = await new SignQuote({ quotes: this.p.quotes, uow: this.p, clock: this.clock }).execute({ quoteId: grant.value.quoteId, signerName });
      if (r.ok) {
        await this.p.publicAccessTokens.markUsed(grant.value.grantId, this.clock.now());
        await this.p.publicAccessTokens.revoke(grant.value.grantId, this.clock.now());
        this.logger.audit('quote.public_signed', { quoteId: grant.value.quoteId, signerName });
      }
      return r;
    });
  }

  /** Surface d'actions de Bob (parité) — délègue aux mêmes use cases que l'UI manuelle. */
  private buildBobActions(): BobActions {
    return {
      computePayout: async () => {
        const r = await this.getCashflow('realiste', 30);
        if (!r.ok) return r;
        return ok({ payoutCents: r.value.payout, availableCents: r.value.available });
      },
      draftRelance: async () => {
        const r = await this.listCustomers();
        if (!r.ok) return r;
        const top = [...r.value].filter((c) => c.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding)[0];
        const draft = buildRelance({
          customerName: top?.name ?? 'le client',
          docNumber: 'dernière facture',
          amountCents: top?.outstanding ?? 0,
          daysLate: 7,
          tone: 'cordial',
          personality: 'Pote',
        });
        return ok({ subject: draft.subject, body: draft.body });
      },
      listPayableInvoices: async () => {
        const [inv, cust] = await Promise.all([this.listInvoices(), this.listCustomers()]);
        if (!inv.ok) return inv;
        const names = new Map((cust.ok ? cust.value : []).map((c) => [c.id, c.name]));
        const payable = inv.value
          .filter((i) => ['issued', 'partially_paid', 'late'].includes(i.status) && i.number)
          .map((i) => ({
            id: i.id,
            number: i.number ?? i.id,
            remainingCents: remainingInvoiceBalanceCents(i),
            customerName: names.get(i.customerId) ?? 'Client',
          }))
          .filter((i) => i.remainingCents > 0);
        return ok(payable);
      },
      listSendableQuotes: async () => {
        const [quotes, cust] = await Promise.all([this.listQuotes(), this.listCustomers()]);
        if (!quotes.ok) return quotes;
        const names = new Map((cust.ok ? cust.value : []).map((c) => [c.id, c.name]));
        return ok(
          quotes.value
            .filter((q) => ['draft', 'sent', 'viewed'].includes(q.status))
            .map((q) => ({
              id: q.id,
              number: q.number,
              customerName: names.get(q.customerId) ?? 'Client',
              totalTtcCents: q.totals.ttc,
              status: q.status,
            })),
        );
      },
      listIssuableInvoices: async () => {
        const [invoices, cust] = await Promise.all([this.listInvoices(), this.listCustomers()]);
        if (!invoices.ok) return invoices;
        const names = new Map((cust.ok ? cust.value : []).map((c) => [c.id, c.name]));
        return ok(
          invoices.value
            .filter((i) => i.status === 'draft' && !i.number)
            .map((i) => ({
              id: i.id,
              number: i.number,
              customerName: names.get(i.customerId) ?? 'Client',
              totalTtcCents: i.totals.ttc,
              status: i.status,
            })),
        );
      },
      listDocuments: async () => {
        const r = await this.listDocuments({ includeDeleted: false });
        if (!r.ok) return r;
        return ok(
          r.value.slice(0, 12).map((d) => ({
            id: d.id,
            filename: d.filename,
            kind: d.kind,
            linkedEntityType: d.linkedEntityType,
            linkedEntityId: d.linkedEntityId,
            createdAt: d.createdAt,
          })),
        );
      },
      registerPayment: async (input) =>
        this.registerPayment({
          invoiceId: input.invoiceId,
          amount: input.amountCents,
          method: 'transfer',
          idempotencyKey: input.idempotencyKey ?? `bob:payment:${input.invoiceId}:${input.amountCents}:transfer`,
        }),
      sendQuote: async (input) => this.sendQuote(input.quoteId),
      issueInvoice: async (input) => this.issueInvoice({ invoiceId: input.invoiceId }),
    };
  }

  private bobAgent(): BobAgent {
    const router = new ModelRouter({
      hasClaudeKey: hasClaudeKey(),
      hasGlmKey: hasGlmKey(),
      hasDeepseekKey: hasDeepseekKey(),
      hasMistralKey: hasMistralKey(),
      hasOpenaiKey: hasOpenaiKey(),
    });
    // Le fournisseur qui qualifie la demande (tool-calling) est choisi par le routeur ; sinon regex.
    const provider = router.route('intent.detect').model;
    const llm = provider !== 'demo' ? buildLlmForProvider(provider) : undefined;
    return new BobAgent({
      router,
      actions: this.buildBobActions(),
      llm,
      runtime: {
        clock: this.clock,
        ids: this.ids,
        store: new CompanyScopedJournalStore(this.p.agentJournal, this.companyId()),
      },
    });
  }

  async askBob(message: string, autonomy?: AgentAutonomy): Promise<Result<AgentRun, AppError>> {
    // L'assistant agentique est réservé aux offres avec IA (Solo+). Sans lui, l'app reste 100 % manuelle.
    if (!planCan(this.subscription.tier, 'ai_assistant'))
      return { ok: false, error: appForbidden("L'assistant Bob est inclus à partir de l'offre Solo.") };
    const effectiveAutonomy = clampAgentAutonomy(autonomy, this.subscription.autonomyEntitlement());
    const start = Date.now();
    const r = await this.bobAgent().ask(message, { autonomy: effectiveAutonomy });
    const ms = Date.now() - start;
    const intent = r.ok ? r.value.intent : 'error';
    const model = r.ok ? r.value.model : 'demo';
    const outcome = r.ok ? 'ok' : 'error';
    this.metrics.aiRequests.inc({ model, intent, outcome });
    this.metrics.aiDuration.observe({ model, intent }, ms / 1000);
    if (!r.ok && r.error.kind === 'dependency' && r.error.port === 'money-guard') this.metrics.aiGuardViolations.inc();
    this.logger.audit('ai.ask', { model, intent, outcome, ms, requestedAutonomy: autonomy ?? null, effectiveAutonomy });
    return r;
  }

  async agentJournal(runId: string): Promise<Result<JournalEntry[], AppError>> {
    if (!planCan(this.subscription.tier, 'ai_assistant'))
      return { ok: false, error: appForbidden("L'assistant Bob est inclus à partir de l'offre Solo.") };
    return ok(await this.p.agentJournal.load(this.companyId(), runId));
  }

  voiceCloudAvailable(): boolean {
    return !!this.stt;
  }

  voiceTtsCloudAvailable(): boolean {
    return !!this.tts && tierAtLeast(this.subscription.tier, 'pro');
  }

  async transcribe(input: { audioBase64: string; mimeType: string }): Promise<Result<{ text: string }, AppError>> {
    if (!planCan(this.subscription.tier, 'ai_assistant'))
      return { ok: false, error: appForbidden("La dictée vocale est incluse à partir de l'offre Solo.") };
    if (!this.stt)
      return { ok: false, error: appForbidden('Dictée cloud non configurée (clé OpenAI absente). Utilise la dictée native.') };
    try {
      const r = await this.stt.transcribe(input.audioBase64, input.mimeType);
      this.logger.audit('voice.transcribe', { model: r.model, chars: r.text.length });
      return ok({ text: r.text });
    } catch (e) {
      return { ok: false, error: { kind: 'dependency', port: 'whisper', cause: e instanceof Error ? e.message : 'stt' } };
    }
  }

  async synthesizeSpeech(input: { text: string }): Promise<Result<TtsResult, AppError>> {
    if (!planCan(this.subscription.tier, 'ai_assistant'))
      return { ok: false, error: appForbidden("La voix de Bob est incluse à partir de l'offre Solo.") };
    if (!tierAtLeast(this.subscription.tier, 'pro'))
      return { ok: false, error: appForbidden("La voix cloud premium est incluse à partir de l'offre Pro.") };
    if (!this.tts)
      return { ok: false, error: appForbidden('Synthèse vocale cloud non configurée (clé Mistral absente). Utilise la voix native.') };
    const text = input.text.trim();
    if (!text) return { ok: false, error: { kind: 'validation', issues: [{ field: 'text', message: 'Texte requis.' }] } };
    if (text.length > 1200)
      return { ok: false, error: { kind: 'validation', issues: [{ field: 'text', message: 'Texte trop long pour la synthèse vocale.' }] } };
    try {
      const r = await this.tts.synthesize(text);
      this.logger.audit('voice.synthesize', { model: r.model, chars: text.length, cloudAudio: r.audioBase64 !== null });
      return ok(r);
    } catch (e) {
      return { ok: false, error: { kind: 'dependency', port: 'mistral-tts', cause: e instanceof Error ? e.message : 'tts' } };
    }
  }

  async confirmBob(pending: PendingAction): Promise<Result<AgentRun, AppError>> {
    if (!planCan(this.subscription.tier, 'ai_assistant'))
      return { ok: false, error: appForbidden("L'assistant Bob est inclus à partir de l'offre Solo.") };
    try {
      const record = await this.bobAgent().runJournaled(pendingToInvocations(pending), {
        autonomy: this.subscription.autonomyEntitlement(),
      });
      const blocked = record.outcomes.find((o) => o.status === 'denied' || o.status === 'failed');
      this.logger.audit('ai.confirm', {
        tool: pending.tool,
        runId: record.runId,
        journalEntries: record.entries.length,
        outcome: blocked ? 'error' : 'ok',
      });
      if (blocked) {
        if (blocked.status === 'denied') return { ok: false, error: appForbidden(blocked.reason ?? 'Action refusée par la policy.') };
        return {
          ok: false,
          error: { kind: 'dependency', port: 'agent-runtime', cause: blocked.reason ?? 'agent execution failed' },
        };
      }
      const isBatch = pending.batch !== undefined && pending.batch.length > 0;
      return ok({
        kind: 'done',
        intent: 'encaisser',
        model: 'agent-runtime',
        plan: record.outcomes.map((o) => o.label),
        card: {
          title: 'Fait ✓',
          body: isBatch ? record.outcomes.map((o) => `✓ ${o.label}`).join('\n') : `${pending.label} — c’est noté.`,
        },
      });
    } catch (e) {
      this.logger.audit('ai.confirm', { tool: pending.tool, outcome: 'error', journal: 'failed' });
      return {
        ok: false,
        error: { kind: 'dependency', port: 'agent-journal', cause: e instanceof Error ? e.message : 'journal append failed' },
      };
    }
  }

  // ——— Monétisation ———
  getSubscription() {
    return {
      tier: this.subscription.tier,
      status: this.subscription.status,
      currentPeriodEnd: this.subscription.currentPeriodEnd,
      features: [...planEntitlements(this.subscription.tier)],
      ai: PLAN_CATALOG[this.subscription.tier].ai,
      autonomyEntitlement: this.subscription.autonomyEntitlement(),
      limits: PLAN_CATALOG[this.subscription.tier].limits,
      addOns: [...this.subscription.addOns],
      addOnCatalog: Object.values(ADDON_CATALOG),
      catalog: Object.values(PLAN_CATALOG),
    };
  }

  async getProfile(): Promise<Result<TradeConfig, AppError>> {
    const company = await this.p.companies.findById(this.companyId());
    if (!company) return { ok: false, error: appNotFound('company', this.companyId()) };
    return ok(resolveTradeConfig(company.trade, this.subscription.tier, this.subscription.addOns));
  }

  async lookupCompany(siret: string): Promise<Result<CompanyLookupResult, AppError>> {
    return new AutofillCompanyFromSiret({ lookup: this.companyLookup }).execute({ siret });
  }

  async checkVat(vatNumber: string): Promise<Result<VatCheckResult, AppError>> {
    return new ValidateVatNumber({ vat: this.vat, clock: this.clock }).execute({ vatNumber });
  }

  async searchAddress(query: string): Promise<Result<AddressSuggestion[], AppError>> {
    return new SearchAddress({ addresses: this.addresses }).execute({ query });
  }

  // ——— Module Chantiers (vertical BTP, gated par métier × palier/add-on) ———
  private async chantiersAllowed(): Promise<boolean> {
    const company = await this.p.companies.findById(this.companyId());
    if (!company) return false;
    return resolveTradeConfig(company.trade, this.subscription.tier, this.subscription.addOns).modules.some(
      (m) => m.key === 'chantiers' && m.active,
    );
  }

  async createChantier(input: Omit<CreateChantierInput, 'companyId'>): Promise<Result<{ id: string }, AppError>> {
    if (!(await this.chantiersAllowed()))
      return {
        ok: false,
        error: appForbidden('Module Chantiers réservé aux métiers du bâtiment (offre Solo minimum, ou Pack BTP).'),
      };
    const r = await new CreateChantier({
      chantiers: this.chantiers,
      customers: this.p.customers,
      ids: this.ids,
      clock: this.clock,
    }).execute({ companyId: this.companyId(), ...input });
    if (r.ok) this.logger.audit('chantier.created', { companyId: this.companyId(), id: r.value.id });
    return r;
  }

  async listChantiers(): Promise<Result<ChantierProps[], AppError>> {
    if (!(await this.chantiersAllowed()))
      return {
        ok: false,
        error: appForbidden('Module Chantiers réservé aux métiers du bâtiment (offre Solo minimum, ou Pack BTP).'),
      };
    const list = await this.chantiers.listByCompany(this.companyId());
    return ok(list.map((c) => c.toProps()));
  }

  async getDiagnostic(): Promise<Result<DiagnosticResult, AppError>> {
    const company = await this.p.companies.findById(this.companyId());
    if (!company) return { ok: false, error: appNotFound('company', this.companyId()) };
    const customers = await this.p.customers.listByCompany(this.companyId());
    const customerTypes = [...new Set(customers.map((c) => c.type))];
    return ok(
      runDiagnostic({
        country: 'FR',
        trade: company.trade,
        vatRegime: company.vatRegime,
        customerTypes,
        hasDecennale: company.hasValidDecennale(this.clock.today()),
        asOf: this.clock.today(),
      }),
    );
  }

  startCheckout(tier: PlanTier) {
    return this.gateway.createSubscriptionCheckout({
      companyId: this.companyId(),
      tier,
      successUrl: 'https://demo.bobpro.fr/abo/ok',
      cancelUrl: 'https://demo.bobpro.fr/abo/cancel',
    });
  }

  billingPortal() {
    return this.gateway.createBillingPortal({ companyId: this.companyId(), returnUrl: 'https://demo.bobpro.fr/compte' });
  }

  /** Lien de paiement en ligne d'une facture — gated par l'offre (Pro+). */
  async invoicePaymentLink(invoiceId: string): Promise<Result<{ url: string }, AppError>> {
    if (!this.subscription.can('online_payment')) {
      return { ok: false, error: appForbidden("Le paiement en ligne nécessite l'offre Pro ou Business.") };
    }
    const inv = await this.ownedInvoice(invoiceId);
    if (!inv) return { ok: false, error: appNotFound('invoice', invoiceId) };
    const link = await this.gateway.createInvoicePaymentLink({
      invoiceId,
      amountCents: inv.totals().netToPay,
      label: `Facture ${inv.number ?? ''}`,
    });
    this.logger.audit('invoice.payment_link', { invoiceId, amountCents: inv.totals().netToPay });
    return ok(link);
  }

  /** Génère le PDF conforme d'une facture (mentions figées + totaux déterministes). */
  async invoicePdf(invoiceId: string): Promise<Result<Uint8Array, AppError>> {
    const inv = await this.ownedInvoice(invoiceId);
    if (!inv) return { ok: false, error: appNotFound('invoice', invoiceId) };
    const rendered = await this.renderInvoicePdf(inv);
    if (rendered.ok) this.logger.audit('invoice.pdf', { invoiceId, number: inv.number ?? '(brouillon)', facturX: !!inv.number && !!inv.issuedAt });
    return rendered;
  }

  private async renderInvoicePdf(inv: Invoice): Promise<Result<Uint8Array, AppError>> {
    const company = await this.p.companies.findById(inv.companyId);
    const customer = await this.p.customers.findById(inv.customerId);
    if (!company || !customer) return { ok: false, error: appNotFound('company-or-customer', inv.id) };
    const addr = customer.toProps().address;
    const totals = inv.totals();
    const data: InvoicePdfData = {
      number: inv.number ?? '(brouillon)',
      companyName: company.name,
      companyAddress: `${company.address.line1}, ${company.address.zip} ${company.address.city}`,
      companyRcsOrRm: company.rcsOrRm ?? null,
      customerName: customer.name,
      customerAddress: `${addr.line1}, ${addr.zip} ${addr.city}`,
      issuedAt: inv.issuedAt,
      dueAt: inv.dueAt,
      kind: inv.kind,
      lines: inv.lines.map((l) => ({ label: l.label, qty: l.qty, unitPriceHT: l.unitPriceHT, vatRate: l.vatRate })),
      totals: { ht: totals.ht, vat: totals.vat, ttc: totals.ttc, netToPay: totals.netToPay },
      mentions: [...inv.mentions],
    };
    // Facture émise -> PDF hybride Factur-X (XML CII embarqué).
    let facturX: { xml: string } | undefined;
    if (inv.number && inv.issuedAt) {
      const buyer = customer.toProps();
      const fxData = facturXDataFromInvoice(inv, company, {
        name: customer.name,
        ...(buyer.siren ? { siren: buyer.siren } : {}),
        address: buyer.address,
      });
      facturX = { xml: buildFacturXBasicXml(fxData) };
    }
    const bytes = await this.pdf.renderInvoice(data, facturX);
    return ok(bytes);
  }

  /** XML Factur-X (CII BASIC) seul, pour transmission e-invoicing. Facture émise requise. */
  async invoiceFacturXXml(invoiceId: string): Promise<Result<string, AppError>> {
    const inv = await this.ownedInvoice(invoiceId);
    if (!inv) return { ok: false, error: appNotFound('invoice', invoiceId) };
    return this.buildInvoiceFacturXXml(inv);
  }

  private async buildInvoiceFacturXXml(inv: Invoice): Promise<Result<string, AppError>> {
    if (!inv.number || !inv.issuedAt)
      return { ok: false, error: appForbidden('Facture non émise : Factur-X indisponible.') };
    const company = await this.p.companies.findById(inv.companyId);
    const customer = await this.p.customers.findById(inv.customerId);
    if (!company || !customer) return { ok: false, error: appNotFound('company-or-customer', inv.id) };
    const buyer = customer.toProps();
    const fxData = facturXDataFromInvoice(inv, company, {
      name: customer.name,
      ...(buyer.siren ? { siren: buyer.siren } : {}),
      address: buyer.address,
    });
    return ok(buildFacturXBasicXml(fxData));
  }

  private async storeDocument(input: {
    id?: string;
    versionId?: string;
    companyId?: string;
    kind: DocumentKind;
    origin: DocumentOrigin;
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
    linkedEntityType?: DocumentLinkedEntityType | null;
    linkedEntityId?: string | null;
    documentDate?: string | null;
    issuedAt?: string | null;
    reason?: string;
  }): Promise<Result<DocumentView, AppError>> {
    const companyId = input.companyId ?? this.companyId();
    const id = input.id ?? this.ids.newId();
    const versionId = input.versionId ?? this.ids.newId();
    const sha256 = documentSha256(input.bytes);
    const storageKey = buildDocumentStorageKey({
      companyId,
      documentId: id,
      version: 1,
      sha256,
      filename: input.filename,
      mimeType: input.mimeType,
    });
    return new StoreDocument({
      documents: this.p.documents,
      storage: this.documentStorage,
      clock: this.clock,
    }).execute({
      id,
      versionId,
      companyId,
      kind: input.kind,
      origin: input.origin,
      filename: input.filename,
      mimeType: input.mimeType,
      bytes: input.bytes,
      sha256,
      storageKey,
      linkedEntityType: input.linkedEntityType ?? null,
      linkedEntityId: input.linkedEntityId ?? null,
      documentDate: input.documentDate ?? null,
      issuedAt: input.issuedAt ?? null,
      createdBy: getPrincipal()?.userId ?? null,
      reason: input.reason ?? 'initial',
    });
  }

  private async enqueueInvoiceArchive(invoiceId: string): Promise<void> {
    try {
      const now = this.clock.now();
      await this.p.documentArchiveJobs.enqueue({
        id: this.ids.newId(),
        companyId: this.companyId(),
        invoiceId,
        reason: 'invoice-issued',
        now,
      });
    } catch (e) {
      this.logger.warn(`Enqueue archivage facture impossible: ${e instanceof Error ? e.message : String(e)}`, 'documents');
    }
  }

  private async archiveIssuedInvoiceDocumentsForCompany(
    companyId: string,
    invoiceId: string,
  ): Promise<Result<{ created: number; skipped: number }, AppError>> {
    const inv = await this.p.invoices.findById(invoiceId);
    if (!inv || inv.companyId !== companyId) return { ok: false, error: appNotFound('invoice', invoiceId) };
    if (!inv.number || !inv.issuedAt) return { ok: false, error: appForbidden('Facture non émise : archivage impossible.') };
    let created = 0;
    let skipped = 0;
    try {
      const existing = await this.p.documents.findByEntity(companyId, 'invoice', invoiceId);
      const hasPdf = existing.some((d) => d.kind === 'invoice_pdf' && d.status === 'active');
      const hasFacturX = existing.some((d) => d.kind === 'facturx_xml' && d.status === 'active');

      if (!hasPdf) {
        const pdf = await this.renderInvoicePdf(inv);
        if (!pdf.ok) return pdf;
        const archived = await this.storeDocument({
          id: generatedInvoiceDocumentId(companyId, invoiceId, 'invoice_pdf'),
          versionId: generatedInvoiceDocumentVersionId(companyId, invoiceId, 'invoice_pdf'),
          companyId,
          kind: 'invoice_pdf',
          origin: 'generated',
          filename: `facture-${inv.number}.pdf`,
          mimeType: 'application/pdf',
          bytes: pdf.value,
          linkedEntityType: 'invoice',
          linkedEntityId: invoiceId,
          documentDate: inv.issuedAt,
          issuedAt: inv.issuedAt,
          reason: 'invoice-issued',
        });
        if (!archived.ok) return archived;
        created += 1;
      } else {
        skipped += 1;
      }

      if (!hasFacturX) {
        const xml = await this.buildInvoiceFacturXXml(inv);
        if (!xml.ok) return xml;
        const archived = await this.storeDocument({
          id: generatedInvoiceDocumentId(companyId, invoiceId, 'facturx_xml'),
          versionId: generatedInvoiceDocumentVersionId(companyId, invoiceId, 'facturx_xml'),
          companyId,
          kind: 'facturx_xml',
          origin: 'generated',
          filename: `factur-x-${inv.number}.xml`,
          mimeType: 'application/xml',
          bytes: Buffer.from(xml.value, 'utf-8'),
          linkedEntityType: 'invoice',
          linkedEntityId: invoiceId,
          documentDate: inv.issuedAt,
          issuedAt: inv.issuedAt,
          reason: 'invoice-issued',
        });
        if (!archived.ok) return archived;
        created += 1;
      } else {
        skipped += 1;
      }
      return ok({ created, skipped });
    } catch (e) {
      return { ok: false, error: { kind: 'dependency', port: 'document-archive', cause: e instanceof Error ? e.message : String(e) } };
    }
  }

  async runDocumentArchiveJobs(input: { companyId?: string; limit?: number } = {}): Promise<Result<{ scanned: number; archived: number; failed: number }, AppError>> {
    const companyId = input.companyId ?? this.companyId();
    const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
    return this.p.runWithTenant(companyId, async () => {
      const now = this.clock.now();
      const jobs = await this.p.documentArchiveJobs.listDue(companyId, now, limit);
      let archived = 0;
      let failed = 0;
      for (const job of jobs) {
        const result = await this.archiveIssuedInvoiceDocumentsForCompany(companyId, job.invoiceId);
        if (result.ok) {
          await this.p.documentArchiveJobs.markDone(job.id, this.clock.now());
          archived += result.value.created;
          this.logger.audit('document.archive_job.done', {
            companyId,
            invoiceId: job.invoiceId,
            created: result.value.created,
            skipped: result.value.skipped,
          });
        } else {
          failed += 1;
          const failedAt = this.clock.now();
          await this.p.documentArchiveJobs.markFailed(job.id, failedAt, nextArchiveRetryAt(failedAt, job.attempts), appErrorSummary(result.error));
          this.logger.warn(`Archivage facture en retry: ${appErrorSummary(result.error)}`, 'documents');
        }
      }
      return ok({ scanned: jobs.length, archived, failed });
    });
  }

  async runNotificationJobs(input: { companyId?: string; limit?: number } = {}): Promise<Result<{ scanned: number; sent: number; failed: number }, AppError>> {
    const companyId = input.companyId ?? this.companyId();
    const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
    try {
      return ok(await this.notificationDelivery.runForCompany(companyId, limit));
    } catch (e) {
      return {
        ok: false,
        error: { kind: 'dependency', port: 'notification-jobs', cause: e instanceof Error ? e.message : String(e) },
      };
    }
  }

  async listDocuments(input: ListDocumentsInput = {}): Promise<Result<DocumentView[], AppError>> {
    return new ListDocuments({ documents: this.p.documents }).execute({
      companyId: this.companyId(),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.linkedEntityType !== undefined ? { linkedEntityType: input.linkedEntityType } : {}),
      ...(input.linkedEntityId !== undefined ? { linkedEntityId: input.linkedEntityId } : {}),
      ...(input.includeDeleted !== undefined ? { includeDeleted: input.includeDeleted } : {}),
    });
  }

  async documentDownloadUrl(documentId: string, ttlSeconds?: number): Promise<Result<DocumentDownloadUrl, AppError>> {
    return new GetDocumentDownloadUrl({ documents: this.p.documents, storage: this.documentStorage }).execute({
      companyId: this.companyId(),
      documentId,
      ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
    });
  }

  async uploadDocument(input: UploadDocumentInput): Promise<Result<DocumentView, AppError>> {
    const decoded = decodeBase64Document(input.contentBase64);
    if (!decoded.ok) return decoded;
    const stored = await this.storeDocument({
      kind: input.kind ?? 'other',
      origin: 'uploaded',
      filename: input.filename,
      mimeType: input.mimeType,
      bytes: decoded.value,
      linkedEntityType: input.linkedEntityType ?? null,
      linkedEntityId: input.linkedEntityId ?? null,
      documentDate: input.documentDate ?? null,
      reason: 'upload',
    });
    if (stored.ok) {
      this.logger.audit('document.uploaded', {
        companyId: this.companyId(),
        documentId: stored.value.id,
        kind: stored.value.kind,
        byteSize: stored.value.byteSize,
      });
    }
    return stored;
  }

  /** OCR d'un document fournisseur (base64) -> extraction structurée, scopée au tenant. */
  async extractDocument(input: { contentBase64: string; mimeType: string }): Promise<Result<OcrExtraction, AppError>> {
    const r = await new ExtractDocument({ ocr: this.ocr }).execute(input);
    if (r.ok)
      this.logger.audit('document.ocr', {
        companyId: this.companyId(),
        mimeType: input.mimeType,
        confidence: r.value.confidence,
      });
    return r;
  }

  async recordExpense(input: Omit<RecordExpenseInput, 'companyId'>): Promise<Result<{ id: string }, AppError>> {
    const r = await new RecordExpense({ expenses: this.p.expenses, ids: this.ids, clock: this.clock }).execute({
      companyId: this.companyId(),
      ...input,
    });
    if (r.ok) this.logger.audit('expense.recorded', { companyId: this.companyId(), id: r.value.id, ttc: input.totalTtcCents });
    return r;
  }

  async listExpenses(): Promise<Result<ExpenseProps[], AppError>> {
    const list = await this.p.expenses.listByCompany(this.companyId());
    return ok(list.map((e) => e.toProps()));
  }

  // ——— Onboarding / multi-tenant ———
  /** Crée (ou met à jour) la société du tenant courant — première étape de l'onboarding. */
  async registerCompany(input: Omit<CompanyProps, 'id'>): Promise<Result<{ companyId: string }, AppError>> {
    const r = Company.of({ id: this.companyId(), ...input });
    if (!r.ok) return { ok: false, error: appDomain(r.error) };
    await this.p.companies.save(r.value);
    this.logger.audit('company.registered', { companyId: this.companyId(), name: input.name });
    return ok({ companyId: this.companyId() });
  }

  async createCustomer(input: Omit<CustomerProps, 'id' | 'companyId'>): Promise<Result<{ id: string }, AppError>> {
    const id = this.ids.newId();
    const r = Customer.of({ id, companyId: this.companyId(), ...input });
    if (!r.ok) return { ok: false, error: appDomain(r.error) };
    await this.p.customers.save(r.value);
    this.logger.audit('customer.created', { id, companyId: this.companyId() });
    return ok({ id });
  }
}

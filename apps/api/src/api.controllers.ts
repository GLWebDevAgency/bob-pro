import {
  Controller,
  Get,
  Post,
  Body,
  Headers,
  Param,
  Query,
  HttpException,
  HttpStatus,
  StreamableFile,
} from '@nestjs/common';
import type {
  CreateQuoteInput,
  Scenario,
  Horizon,
  PaymentMethod,
  PlanTier,
  CompanyProps,
  CustomerProps,
  RecordExpenseInput,
  CreateChantierInput,
  DocumentKind,
  DocumentLinkedEntityType,
  ExpenseCategory,
} from '@bob/core';
import { type AgentAutonomy, type PendingAction } from '@bob/ai';
import { Throttle } from '@nestjs/throttler';
import { BackendService } from './backend.service';
import { RelanceService } from './jobs/relance.service';
import { DocumentArchiveService } from './jobs/document-archive.service';
import { NotificationsApiService } from './notifications/notifications-api.service';
import { unwrap } from './http/result';

@Controller('health')
export class HealthController {
  constructor(private readonly backend: BackendService) {}

  @Get()
  health() {
    return { ok: true, service: 'bob-pro-api', mode: process.env.DEMO_MODE !== 'false' ? 'demo' : 'live' };
  }

  @Get('ready')
  async ready() {
    // C24b : sonde SANS tenant (aucun Principal sur /health ; plus de repli société de démo).
    const r = await this.backend.readiness();
    if (!r.ok) throw new HttpException({ ready: false, error: r.error }, HttpStatus.SERVICE_UNAVAILABLE);
    return { ready: true, customers: r.value.customers };
  }
}

@Controller('customers')
export class CustomersController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async list() {
    return unwrap(await this.backend.listCustomers());
  }
  @Post()
  async create(@Body() body: Omit<CustomerProps, 'id' | 'companyId'>) {
    return unwrap(await this.backend.createCustomer(body));
  }
}

@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly backend: BackendService) {}
  @Post('company')
  async company(@Body() body: Omit<CompanyProps, 'id'>) {
    return unwrap(await this.backend.registerCompany(body));
  }
}

@Controller('diagnostic')
export class DiagnosticController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async get() {
    return unwrap(await this.backend.getDiagnostic());
  }
}

@Controller('profile')
export class ProfileController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async get() {
    return unwrap(await this.backend.getProfile());
  }
}

@Controller('company')
export class CompanyLookupController {
  constructor(private readonly backend: BackendService) {}
  // PUBLIC assumé (guard C24b) : à l'étape SIRET de l'inscription, l'utilisateur n'a pas encore
  // de compte (aucun JWT possible) et les données renvoyées sont l'annuaire OFFICIEL public
  // (Recherche d'entreprises) — zéro donnée tenant. Garde-fou : ce throttle 20/min par IP
  // (anti-abus + protège le quota amont 7 req/s).
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Get('lookup')
  async lookup(@Query('siret') siret: string) {
    return unwrap(await this.backend.lookupCompany(siret ?? ''));
  }
}

@Controller('vat')
export class VatController {
  constructor(private readonly backend: BackendService) {}
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Get('check')
  async check(@Query('vat') vat: string) {
    return unwrap(await this.backend.checkVat(vat ?? ''));
  }
}

@Controller('address')
export class AddressController {
  constructor(private readonly backend: BackendService) {}
  // Autocomplétion : throttle plus large (BAN ~50 req/s), keyé par IP.
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Get('search')
  async search(@Query('q') q: string) {
    return unwrap(await this.backend.searchAddress(q ?? ''));
  }
}

@Controller('cashflow')
export class CashflowController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async get(@Query('scenario') scenario: Scenario = 'realiste', @Query('horizon') horizon = '30') {
    return unwrap(await this.backend.getCashflow(scenario, Number(horizon) as Horizon));
  }
}

@Controller('quotes')
export class QuotesController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async list() {
    return unwrap(await this.backend.listQuotes());
  }
  @Get(':id')
  async get(@Param('id') id: string) {
    return unwrap(await this.backend.getQuote(id));
  }
  @Post()
  async create(@Body() body: Omit<CreateQuoteInput, 'companyId'>) {
    return unwrap(await this.backend.createQuote(body));
  }
  @Post(':id/send')
  async send(@Param('id') id: string) {
    return unwrap(await this.backend.sendQuote(id));
  }
  @Post(':id/sign')
  async sign(@Param('id') id: string, @Body() body: { signerName: string }) {
    return unwrap(await this.backend.signQuote({ quoteId: id, signerName: body.signerName }));
  }
  @Post(':id/refuse')
  async refuse(@Param('id') id: string) {
    return unwrap(await this.backend.refuseQuote(id));
  }
  @Post(':id/invoice')
  async invoice(@Param('id') id: string, @Body() body: { mode?: 'deposit' | 'final' }) {
    return unwrap(await this.backend.generateInvoice({ quoteId: id, mode: body.mode }));
  }
}

@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly backend: BackendService,
    private readonly relances: RelanceService,
  ) {}
  @Get()
  async list() {
    return unwrap(await this.backend.listInvoices());
  }
  /** C25 ② : envoi RÉEL d'une relance ciblée (ton du plan @bob/core, mise en demeure incluse —
   * le geste utilisateur EST la validation). Throttlé : action sortante vers un tiers. */
  @Post(':id/relance')
  @Throttle({ default: { limit: 5, ttl: 10_000 } })
  async sendRelance(@Param('id') id: string) {
    return unwrap(await this.relances.sendRelance(id));
  }
  @Get(':id')
  async get(@Param('id') id: string) {
    return unwrap(await this.backend.getInvoice(id));
  }
  @Get(':id/accounting-preview')
  async accountingPreview(@Param('id') id: string) {
    return unwrap(await this.backend.invoiceAccountingPreview(id));
  }
  @Get(':id/payment-accounting-preview')
  async paymentAccountingPreview(@Param('id') id: string, @Query('amount') amount: string, @Query('method') method?: PaymentMethod) {
    return unwrap(
      await this.backend.paymentAccountingPreview({
        invoiceId: id,
        amountCents: Number(amount),
        method: method ?? 'transfer',
      }),
    );
  }
  @Post(':id/issue')
  async issue(@Param('id') id: string) {
    return unwrap(await this.backend.issueInvoice({ invoiceId: id }));
  }
  @Post(':id/pay')
  async pay(
    @Param('id') id: string,
    @Body() body: { amount: number; method: PaymentMethod; idempotencyKey?: string | null },
    @Headers('idempotency-key') idempotencyHeader?: string,
  ) {
    return unwrap(
      await this.backend.registerPayment({
        invoiceId: id,
        amount: body.amount,
        method: body.method,
        idempotencyKey: idempotencyHeader ?? body.idempotencyKey ?? null,
      }),
    );
  }
  @Post(':id/payment-link')
  async paymentLink(@Param('id') id: string) {
    return unwrap(await this.backend.invoicePaymentLink(id));
  }
  @Get(':id/pdf')
  async pdf(@Param('id') id: string): Promise<StreamableFile> {
    const bytes = unwrap(await this.backend.invoicePdf(id));
    return new StreamableFile(Buffer.from(bytes), {
      type: 'application/pdf',
      disposition: `inline; filename="facture-${id}.pdf"`,
    });
  }
  @Get(':id/facturx.xml')
  async facturx(@Param('id') id: string): Promise<StreamableFile> {
    const xml = unwrap(await this.backend.invoiceFacturXXml(id));
    return new StreamableFile(Buffer.from(xml, 'utf-8'), {
      type: 'application/xml',
      disposition: `attachment; filename="factur-x-${id}.xml"`,
    });
  }
}

@Controller('accounting')
export class AccountingController {
  constructor(private readonly backend: BackendService) {}
  @Get('entries')
  async entries() {
    return unwrap(await this.backend.listAccountingEntries());
  }
  @Get('fec')
  async fec(@Query('from') from: string, @Query('to') to: string): Promise<StreamableFile> {
    const fec = unwrap(await this.backend.exportFec({ from: from ?? '', to: to ?? '' }));
    return new StreamableFile(Buffer.from(fec.content, 'utf-8'), {
      type: fec.mimeType,
      disposition: `attachment; filename="${fec.filename}"`,
    });
  }
  @Get('fec-description')
  async fecDescription(@Query('from') from: string, @Query('to') to: string): Promise<StreamableFile> {
    const fec = unwrap(await this.backend.exportFec({ from: from ?? '', to: to ?? '' }));
    return new StreamableFile(Buffer.from(fec.descriptionContent, 'utf-8'), {
      type: fec.mimeType,
      disposition: `attachment; filename="${fec.descriptionFilename}"`,
    });
  }
  @Get('fec-metadata')
  async fecMetadata(@Query('from') from: string, @Query('to') to: string) {
    const fec = unwrap(await this.backend.exportFec({ from: from ?? '', to: to ?? '' }));
    return {
      filename: fec.filename,
      descriptionFilename: fec.descriptionFilename,
      entryCount: fec.entryCount,
      rowCount: fec.rowCount,
      warnings: fec.warnings,
    };
  }
}

@Controller('documents')
export class DocumentsController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async list(
    @Query('kind') kind?: DocumentKind,
    @Query('linkedEntityType') linkedEntityType?: DocumentLinkedEntityType,
    @Query('linkedEntityId') linkedEntityId?: string,
    @Query('includeDeleted') includeDeleted?: string,
  ) {
    return unwrap(
      await this.backend.listDocuments({
        ...(kind !== undefined ? { kind } : {}),
        ...(linkedEntityType !== undefined ? { linkedEntityType } : {}),
        ...(linkedEntityId !== undefined ? { linkedEntityId } : {}),
        ...(includeDeleted !== undefined ? { includeDeleted: includeDeleted === 'true' } : {}),
      }),
    );
  }
  @Post('upload')
  async upload(
    @Body()
    body: {
      contentBase64: string;
      mimeType: string;
      filename: string;
      kind?: DocumentKind;
      linkedEntityType?: DocumentLinkedEntityType | null;
      linkedEntityId?: string | null;
      documentDate?: string | null;
    },
  ) {
    return unwrap(await this.backend.uploadDocument(body));
  }
  @Get(':id/download-url')
  async downloadUrl(@Param('id') id: string, @Query('ttl') ttl?: string) {
    return unwrap(await this.backend.documentDownloadUrl(id, ttl ? Number(ttl) : undefined));
  }
  @Post('ocr')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async ocr(@Body() body: { contentBase64: string; mimeType: string }) {
    return unwrap(await this.backend.extractDocument(body));
  }
}

@Controller('public/sign')
export class PublicSignatureController {
  constructor(private readonly backend: BackendService) {}
  @Get(':token')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async get(@Param('token') token: string) {
    return unwrap(await this.backend.publicQuoteForSignature(token));
  }
  @Post(':token')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async sign(@Param('token') token: string, @Body() body: { signerName: string }) {
    return unwrap(await this.backend.publicSignQuote(token, body.signerName));
  }
}

@Controller('chantiers')
export class ChantiersController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async list() {
    return unwrap(await this.backend.listChantiers());
  }
  @Post()
  async create(@Body() body: Omit<CreateChantierInput, 'companyId'>) {
    return unwrap(await this.backend.createChantier(body));
  }
}

@Controller('expenses')
export class ExpensesController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async list() {
    return unwrap(await this.backend.listExpenses());
  }
  @Post('defaults')
  async defaults(
    @Body()
    body: {
      supplierName: string;
      supplierSiren?: string | null;
      vatRatePctApplied?: number | null;
      categoryGuess: ExpenseCategory;
    },
  ) {
    return unwrap(await this.backend.suggestExpenseDefaults(body));
  }
  @Post()
  async create(@Body() body: Omit<RecordExpenseInput, 'companyId'>) {
    return unwrap(await this.backend.recordExpense(body));
  }
}

/** Fil de notifications (C25) — le mobile lit ce que les jobs produisent, company-scoped (Principal + RLS). */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsApiService) {}
  @Get()
  async list(@Query('limit') limit?: string) {
    return unwrap(await this.notifications.list(limit));
  }
  @Post(':id/read')
  async markRead(@Param('id') id: string) {
    return unwrap(await this.notifications.markRead(id));
  }
}

/** Appareils push Expo (C25) — enregistrement idempotent par tenant/user. */
@Controller('devices')
export class DevicesController {
  constructor(private readonly notifications: NotificationsApiService) {}
  @Post()
  async register(@Body() body: { expoPushToken?: string; platform?: string }) {
    return unwrap(await this.notifications.registerDevice(body));
  }
}

@Controller('jobs')
export class JobsController {
  constructor(
    private readonly backend: BackendService,
    private readonly relances: RelanceService,
    private readonly documentArchives: DocumentArchiveService,
  ) {}
  @Post('run-relances')
  run() {
    return this.relances.runRelances();
  }
  @Post('run-document-archives')
  runDocumentArchives() {
    return this.documentArchives.run();
  }
  @Post('run-notifications')
  runNotifications() {
    return this.backend.runNotificationJobs({ limit: 25 });
  }
}

@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  get() {
    return this.backend.getSubscription();
  }
  @Post('checkout')
  checkout(@Body() body: { tier: PlanTier }) {
    return this.backend.startCheckout(body.tier);
  }
  @Post('portal')
  portal() {
    return this.backend.billingPortal();
  }
}

@Controller('ai')
export class AiController {
  constructor(private readonly backend: BackendService) {}
  @Post('ask')
  @Throttle({ default: { limit: 5, ttl: 10_000 } })
  async ask(@Body() body: { message: string; autonomy?: AgentAutonomy }) {
    return unwrap(await this.backend.askBob(body.message, body.autonomy));
  }
  @Post('confirm')
  @Throttle({ default: { limit: 10, ttl: 10_000 } })
  async confirm(@Body() body: PendingAction) {
    return unwrap(await this.backend.confirmBob(body));
  }
  @Get('runs/:runId/journal')
  async journal(@Param('runId') runId: string) {
    return unwrap(await this.backend.agentJournal(runId));
  }
}

@Controller('voice')
export class VoiceController {
  constructor(private readonly backend: BackendService) {}
  @Get('config')
  config() {
    return { cloudAvailable: this.backend.voiceCloudAvailable(), ttsCloudAvailable: this.backend.voiceTtsCloudAvailable() };
  }
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('transcribe')
  async transcribe(@Body() body: { audioBase64?: string; mimeType?: string }) {
    return unwrap(await this.backend.transcribe({ audioBase64: body.audioBase64 ?? '', mimeType: body.mimeType ?? 'audio/m4a' }));
  }
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('synthesize')
  async synthesize(@Body() body: { text?: string }) {
    return unwrap(await this.backend.synthesizeSpeech({ text: body.text ?? '' }));
  }
}

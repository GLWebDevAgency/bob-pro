import {
  Controller,
  Get,
  Post,
  Body,
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
} from '@bob/core';
import { Throttle } from '@nestjs/throttler';
import { BackendService } from './backend.service';
import { RelanceService } from './jobs/relance.service';
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
    const r = await this.backend.listCustomers();
    if (!r.ok) throw new HttpException({ ready: false, error: r.error }, HttpStatus.SERVICE_UNAVAILABLE);
    return { ready: true, customers: r.value.length };
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
  @Post(':id/invoice')
  async invoice(@Param('id') id: string, @Body() body: { mode?: 'deposit' | 'final' }) {
    return unwrap(await this.backend.generateInvoice({ quoteId: id, mode: body.mode }));
  }
}

@Controller('invoices')
export class InvoicesController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async list() {
    return unwrap(await this.backend.listInvoices());
  }
  @Get(':id')
  async get(@Param('id') id: string) {
    return unwrap(await this.backend.getInvoice(id));
  }
  @Post(':id/issue')
  async issue(@Param('id') id: string) {
    return unwrap(await this.backend.issueInvoice({ invoiceId: id }));
  }
  @Post(':id/pay')
  async pay(@Param('id') id: string, @Body() body: { amount: number; method: PaymentMethod }) {
    return unwrap(await this.backend.registerPayment({ invoiceId: id, amount: body.amount, method: body.method }));
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

@Controller('documents')
export class DocumentsController {
  constructor(private readonly backend: BackendService) {}
  @Post('ocr')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async ocr(@Body() body: { contentBase64: string; mimeType: string }) {
    return unwrap(await this.backend.extractDocument(body));
  }
}

@Controller('expenses')
export class ExpensesController {
  constructor(private readonly backend: BackendService) {}
  @Get()
  async list() {
    return unwrap(await this.backend.listExpenses());
  }
  @Post()
  async create(@Body() body: Omit<RecordExpenseInput, 'companyId'>) {
    return unwrap(await this.backend.recordExpense(body));
  }
}

@Controller('jobs')
export class JobsController {
  constructor(private readonly relances: RelanceService) {}
  @Post('run-relances')
  run() {
    return this.relances.runRelances();
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
  async ask(@Body() body: { message: string }) {
    return unwrap(await this.backend.askBob(body.message));
  }
}

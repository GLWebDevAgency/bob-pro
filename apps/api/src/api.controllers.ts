import { Controller, Get, Post, Body, Param, Query, HttpException, HttpStatus } from '@nestjs/common';
import type { CreateQuoteInput, Scenario, Horizon, PaymentMethod } from '@bob/core';
import { BackendService } from './backend.service';
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
}

@Controller('ai')
export class AiController {
  constructor(private readonly backend: BackendService) {}
  @Post('ask')
  async ask(@Body() body: { message: string }) {
    return unwrap(await this.backend.askBob(body.message));
  }
}

import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { BackendService } from './backend.service';
import { PersistenceModule } from './persistence/persistence.module';
import { SupabaseAuthGuard } from './auth/auth.guard';
import {
  HealthController,
  CustomersController,
  CashflowController,
  QuotesController,
  InvoicesController,
  AiController,
} from './api.controllers';

@Module({
  imports: [PersistenceModule],
  controllers: [
    HealthController,
    CustomersController,
    CashflowController,
    QuotesController,
    InvoicesController,
    AiController,
  ],
  providers: [BackendService, { provide: APP_GUARD, useClass: SupabaseAuthGuard }],
})
export class AppModule {}

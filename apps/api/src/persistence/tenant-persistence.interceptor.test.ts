import { ForbiddenException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { requestContext } from '../observability/logger';
import { ExpensesController, QuotesController } from '../api.controllers';
import type { Persistence } from './persistence';
import {
  TenantPersistenceInterceptor,
  WithoutTenantPersistenceTransaction,
} from './tenant-persistence.interceptor';

class TestController {
  regular(): void {}

  @WithoutTenantPersistenceTransaction()
  worker(): void {}
}

function contextFor(handler: (...args: never[]) => unknown, url: string, controller: object = TestController): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ url }) }),
  } as unknown as ExecutionContext;
}

describe('TenantPersistenceInterceptor — frontières transactionnelles', () => {
  it('enveloppe une route tenant ordinaire dans la transaction RLS', async () => {
    const runWithTenant = vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => fn());
    const companies = { findById: async () => null };
    const interceptor = new TenantPersistenceInterceptor(
      { runWithTenant, companies } as unknown as Persistence,
      new Reflector(),
    );
    const next = { handle: vi.fn(() => of('ok')) } satisfies CallHandler;

    const value = await requestContext.run(
      {
        correlationId: 'tenant-interceptor-test',
        principal: { userId: 'user-1', companyId: 'co-1' },
      },
      () => lastValueFrom(interceptor.intercept(
        contextFor(TestController.prototype.regular, '/customers'),
        next,
      )),
    );

    expect(value).toBe('ok');
    expect(runWithTenant).toHaveBeenCalledOnce();
    expect(runWithTenant).toHaveBeenCalledWith('co-1', expect.any(Function));
  });

  it('refuse une route tenant ordinaire sur une company clôturée (403 ACCOUNT_CLOSED)', async () => {
    const runWithTenant = vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => fn());
    const companies = { findById: async () => ({ isClosed: () => true }) };
    const interceptor = new TenantPersistenceInterceptor(
      { runWithTenant, companies } as unknown as Persistence,
      new Reflector(),
    );
    const next = { handle: vi.fn(() => of('ok')) } satisfies CallHandler;

    let thrown: unknown = null;
    await requestContext.run(
      {
        correlationId: 'tenant-interceptor-closed-test',
        principal: { userId: 'user-1', companyId: 'co-closed' },
      },
      async () => {
        try {
          await lastValueFrom(interceptor.intercept(
            contextFor(TestController.prototype.regular, '/customers'),
            next,
          ));
        } catch (e) {
          thrown = e;
        }
      },
    );

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as ForbiddenException).getResponse()).toMatchObject({ code: 'ACCOUNT_CLOSED' });
    // Le handler ne doit JAMAIS s'exécuter sur un tenant clôturé.
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('laisse un worker décoré gérer ses claims courts hors transaction HTTP', async () => {
    const runWithTenant = vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => fn());
    const companies = { findById: async () => null };
    const interceptor = new TenantPersistenceInterceptor(
      { runWithTenant, companies } as unknown as Persistence,
      new Reflector(),
    );
    const next = { handle: vi.fn(() => of('accepted')) } satisfies CallHandler;

    const value = await requestContext.run(
      {
        correlationId: 'tenant-worker-test',
        principal: { userId: 'user-1', companyId: 'co-1' },
      },
      () => lastValueFrom(interceptor.intercept(
        contextFor(TestController.prototype.worker, '/jobs/run-notifications'),
        next,
      )),
    );

    expect(value).toBe('accepted');
    expect(runWithTenant).not.toHaveBeenCalled();
    expect(next.handle).toHaveBeenCalledOnce();
  });

  it('laisse POST /expenses ouvrir sa transaction atomique autour du claim idempotent', async () => {
    const runWithTenant = vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => fn());
    const companies = { findById: async () => null };
    const interceptor = new TenantPersistenceInterceptor(
      { runWithTenant, companies } as unknown as Persistence,
      new Reflector(),
    );
    const next = { handle: vi.fn(() => of('created')) } satisfies CallHandler;

    const value = await requestContext.run(
      {
        correlationId: 'expense-idempotency-boundary-test',
        principal: { userId: 'user-1', companyId: 'co-1' },
      },
      () => lastValueFrom(interceptor.intercept(
        contextFor(ExpensesController.prototype.create, '/expenses', ExpensesController),
        next,
      )),
    );

    expect(value).toBe('created');
    expect(runWithTenant).not.toHaveBeenCalled();
  });

  it('laisse POST /quotes ouvrir la racine qui rollback le devis concurrent perdant', async () => {
    const runWithTenant = vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => fn());
    const companies = { findById: async () => null };
    const interceptor = new TenantPersistenceInterceptor(
      { runWithTenant, companies } as unknown as Persistence,
      new Reflector(),
    );
    const next = { handle: vi.fn(() => of('created')) } satisfies CallHandler;

    const value = await requestContext.run(
      {
        correlationId: 'quote-idempotency-boundary-test',
        principal: { userId: 'user-1', companyId: 'co-1' },
      },
      () => lastValueFrom(interceptor.intercept(
        contextFor(QuotesController.prototype.create, '/quotes', QuotesController),
        next,
      )),
    );

    expect(value).toBe('created');
    expect(runWithTenant).not.toHaveBeenCalled();
  });

  it('laisse aussi la confirmation Factur-X donner la racine au coordinator de dépense', async () => {
    const runWithTenant = vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => fn());
    const companies = { findById: async () => null };
    const interceptor = new TenantPersistenceInterceptor(
      { runWithTenant, companies } as unknown as Persistence,
      new Reflector(),
    );
    const next = { handle: vi.fn(() => of('approved')) } satisfies CallHandler;

    const value = await requestContext.run(
      {
        correlationId: 'facturx-expense-boundary-test',
        principal: { userId: 'user-1', companyId: 'co-1' },
      },
      () => lastValueFrom(interceptor.intercept(
        contextFor(
          ExpensesController.prototype.confirmImportFacturX,
          '/expenses/import-facturx/confirm',
          ExpensesController,
        ),
        next,
      )),
    );

    expect(value).toBe('approved');
    expect(runWithTenant).not.toHaveBeenCalled();
  });
});

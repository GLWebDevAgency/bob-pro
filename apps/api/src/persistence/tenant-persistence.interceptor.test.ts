import { ForbiddenException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { requestContext } from '../observability/logger';
import {
  AccountController,
  ExpensesController,
  OnboardingController,
  QuotesController,
} from '../api.controllers';
import type { Persistence } from './persistence';
import {
  AllowsMissingCompanyRow,
  TenantPersistenceInterceptor,
  WithoutTenantPersistenceTransaction,
} from './tenant-persistence.interceptor';

class TestController {
  regular(): void {}

  @WithoutTenantPersistenceTransaction()
  worker(): void {}

  @AllowsMissingCompanyRow()
  provisioning(): void {}
}

/** Company ouverte factice — le cas nominal d'une route tenant. */
const openCompany = { isClosed: () => false };

function contextFor(
  handler: (...args: never[]) => unknown,
  url: string,
  controller: object = TestController,
  method = 'GET',
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ method, url }) }),
  } as unknown as ExecutionContext;
}

describe('TenantPersistenceInterceptor — frontières transactionnelles', () => {
  it('enveloppe une route tenant ordinaire dans la transaction RLS', async () => {
    const runWithTenant = vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => fn());
    const companies = { findById: async () => openCompany };
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
      () =>
        lastValueFrom(
          interceptor.intercept(contextFor(TestController.prototype.regular, '/customers'), next),
        ),
    );

    expect(value).toBe('ok');
    expect(runWithTenant).toHaveBeenCalledOnce();
    expect(runWithTenant).toHaveBeenCalledWith('co-1', expect.any(Function));
  });

  it('refuse une route tenant ordinaire quand la company du JWT est ABSENTE de la base (403 NO_COMPANY)', async () => {
    const runWithTenant = vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => fn());
    // JWT avec app_metadata.company_id posé, mais base réinitialisée : findById → null.
    const companies = { findById: async () => null };
    const interceptor = new TenantPersistenceInterceptor(
      { runWithTenant, companies } as unknown as Persistence,
      new Reflector(),
    );
    const next = { handle: vi.fn(() => of('ok')) } satisfies CallHandler;

    let thrown: unknown = null;
    await requestContext.run(
      {
        correlationId: 'tenant-interceptor-no-company-test',
        principal: { userId: 'user-1', companyId: 'co-stale' },
      },
      async () => {
        try {
          await lastValueFrom(
            interceptor.intercept(contextFor(TestController.prototype.regular, '/customers'), next),
          );
        } catch (e) {
          thrown = e;
        }
      },
    );

    expect(thrown).toBeInstanceOf(ForbiddenException);
    // Code stable + enveloppe AppError décodable par les clients (contrat http/result.ts).
    expect((thrown as ForbiddenException).getResponse()).toMatchObject({
      code: 'NO_COMPANY',
      error: { kind: 'forbidden', reason: 'NO_COMPANY' },
    });
    // Aucun handler tenant ne doit s'exécuter sans company : pas d'agrégat fantôme sur base vide.
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('laisse POST /onboarding/company re-provisionner MALGRÉ une company absente (@AllowsMissingCompanyRow)', async () => {
    const runWithTenant = vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => fn());
    const companies = { findById: async () => null };
    const interceptor = new TenantPersistenceInterceptor(
      { runWithTenant, companies } as unknown as Persistence,
      new Reflector(),
    );
    const next = { handle: vi.fn(() => of('provisioned')) } satisfies CallHandler;

    const value = await requestContext.run(
      {
        correlationId: 'tenant-interceptor-reprovisioning-test',
        principal: { userId: 'user-1', companyId: 'co-stale' },
      },
      () =>
        lastValueFrom(
          interceptor.intercept(
            contextFor(
              OnboardingController.prototype.company,
              '/onboarding/company',
              OnboardingController,
            ),
            next,
          ),
        ),
    );

    // La transaction tenant reste ouverte (GUC RLS posé) et le handler recrée la company.
    expect(value).toBe('provisioned');
    expect(runWithTenant).toHaveBeenCalledWith('co-stale', expect.any(Function));
    expect(next.handle).toHaveBeenCalledOnce();
  });

  it('une route décorée @AllowsMissingCompanyRow refuse toujours une company CLÔTURÉE', async () => {
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
        correlationId: 'tenant-interceptor-closed-optional-test',
        principal: { userId: 'user-1', companyId: 'co-closed' },
      },
      async () => {
        try {
          await lastValueFrom(
            interceptor.intercept(
              contextFor(TestController.prototype.provisioning, '/onboarding/company'),
              next,
            ),
          );
        } catch (e) {
          thrown = e;
        }
      },
    );

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as ForbiddenException).getResponse()).toMatchObject({ code: 'ACCOUNT_CLOSED' });
    expect(next.handle).not.toHaveBeenCalled();
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
          await lastValueFrom(
            interceptor.intercept(contextFor(TestController.prototype.regular, '/customers'), next),
          );
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

  it('admet un worker ouvert via une transaction RLS COURTE puis exécute le handler hors transaction', async () => {
    let transactionOpen = false;
    const runWithTenant = vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => {
      transactionOpen = true;
      try {
        return await fn();
      } finally {
        transactionOpen = false;
      }
    });
    const companies = { findById: vi.fn(async () => openCompany) };
    const interceptor = new TenantPersistenceInterceptor(
      { runWithTenant, companies } as unknown as Persistence,
      new Reflector(),
    );
    const next = {
      handle: vi.fn(() => {
        expect(transactionOpen).toBe(false);
        return of('accepted');
      }),
    } satisfies CallHandler;

    const value = await requestContext.run(
      {
        correlationId: 'tenant-worker-test',
        principal: { userId: 'user-1', companyId: 'co-1' },
      },
      () =>
        lastValueFrom(
          interceptor.intercept(
            contextFor(TestController.prototype.worker, '/jobs/run-notifications'),
            next,
          ),
        ),
    );

    expect(value).toBe('accepted');
    expect(runWithTenant).toHaveBeenCalledOnce();
    expect(runWithTenant).toHaveBeenCalledWith('co-1', expect.any(Function));
    expect(companies.findById).toHaveBeenCalledWith('co-1');
    expect(next.handle).toHaveBeenCalledOnce();
  });

  it('refuse un worker tenant après une clôture déjà commitée', async () => {
    const runWithTenant = vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => fn());
    const companies = { findById: async () => ({ isClosed: () => true }) };
    const interceptor = new TenantPersistenceInterceptor(
      { runWithTenant, companies } as unknown as Persistence,
      new Reflector(),
    );
    const next = { handle: vi.fn(() => of('accepted')) } satisfies CallHandler;

    let thrown: unknown = null;
    await requestContext.run(
      {
        correlationId: 'tenant-worker-closed-test',
        principal: { userId: 'user-1', companyId: 'co-closed' },
      },
      async () => {
        try {
          await lastValueFrom(
            interceptor.intercept(
              contextFor(TestController.prototype.worker, '/account', TestController, 'DELETE'),
              next,
            ),
          );
        } catch (error) {
          thrown = error;
        }
      },
    );

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as ForbiddenException).getResponse()).toMatchObject({
      code: 'ACCOUNT_CLOSED',
    });
    expect(runWithTenant).toHaveBeenCalledOnce();
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('refuse aussi un worker tenant dont la company a disparu (403 NO_COMPANY)', async () => {
    const runWithTenant = vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => fn());
    const companies = { findById: async () => null };
    const interceptor = new TenantPersistenceInterceptor(
      { runWithTenant, companies } as unknown as Persistence,
      new Reflector(),
    );
    const next = { handle: vi.fn(() => of('accepted')) } satisfies CallHandler;

    let thrown: unknown = null;
    await requestContext.run(
      {
        correlationId: 'tenant-worker-no-company-test',
        principal: { userId: 'user-1', companyId: 'co-missing' },
      },
      async () => {
        try {
          await lastValueFrom(
            interceptor.intercept(
              contextFor(TestController.prototype.worker, '/documents/doc-1/analysis'),
              next,
            ),
          );
        } catch (error) {
          thrown = error;
        }
      },
    );

    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as ForbiddenException).getResponse()).toMatchObject({
      code: 'NO_COMPANY',
      error: { kind: 'forbidden', reason: 'NO_COMPANY' },
    });
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('laisse DELETE /account reprendre après clôture pour terminer la suppression auth, hors transaction', async () => {
    let transactionOpen = false;
    const runWithTenant = vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => {
      transactionOpen = true;
      try {
        return await fn();
      } finally {
        transactionOpen = false;
      }
    });
    const companies = { findById: async () => ({ isClosed: () => true }) };
    const interceptor = new TenantPersistenceInterceptor(
      { runWithTenant, companies } as unknown as Persistence,
      new Reflector(),
    );
    const next = {
      handle: vi.fn(() => {
        expect(transactionOpen).toBe(false);
        return of('closed');
      }),
    } satisfies CallHandler;

    const value = await requestContext.run(
      {
        correlationId: 'tenant-close-retry-test',
        principal: { userId: 'user-1', companyId: 'co-closed' },
      },
      () =>
        lastValueFrom(
          interceptor.intercept(
            contextFor(
              AccountController.prototype.close,
              '/account?retry=1',
              AccountController,
              'DELETE',
            ),
            next,
          ),
        ),
    );

    expect(value).toBe('closed');
    expect(runWithTenant).toHaveBeenCalledOnce();
    expect(next.handle).toHaveBeenCalledOnce();
  });

  it('ne crée aucun contexte tenant pour une route système sans principal', async () => {
    const runWithTenant = vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => fn());
    const companies = { findById: vi.fn(async () => openCompany) };
    const interceptor = new TenantPersistenceInterceptor(
      { runWithTenant, companies } as unknown as Persistence,
      new Reflector(),
    );
    const next = { handle: vi.fn(() => of('webhook')) } satisfies CallHandler;

    const value = await requestContext.run({ correlationId: 'system-without-principal-test' }, () =>
      lastValueFrom(
        interceptor.intercept(
          contextFor(
            TestController.prototype.worker,
            '/payments/stripe/webhook',
            TestController,
            'POST',
          ),
          next,
        ),
      ),
    );

    expect(value).toBe('webhook');
    expect(runWithTenant).not.toHaveBeenCalled();
    expect(companies.findById).not.toHaveBeenCalled();
  });

  it('laisse POST /expenses ouvrir sa transaction atomique autour du claim idempotent', async () => {
    const runWithTenant = vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => fn());
    const companies = { findById: async () => openCompany };
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
      () =>
        lastValueFrom(
          interceptor.intercept(
            contextFor(ExpensesController.prototype.create, '/expenses', ExpensesController),
            next,
          ),
        ),
    );

    expect(value).toBe('created');
    expect(runWithTenant).toHaveBeenCalledOnce();
  });

  it('laisse POST /quotes ouvrir la racine qui rollback le devis concurrent perdant', async () => {
    const runWithTenant = vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => fn());
    const companies = { findById: async () => openCompany };
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
      () =>
        lastValueFrom(
          interceptor.intercept(
            contextFor(QuotesController.prototype.create, '/quotes', QuotesController),
            next,
          ),
        ),
    );

    expect(value).toBe('created');
    expect(runWithTenant).toHaveBeenCalledOnce();
  });

  it('laisse aussi la confirmation Factur-X donner la racine au coordinator de dépense', async () => {
    const runWithTenant = vi.fn(async (_companyId: string, fn: () => Promise<unknown>) => fn());
    const companies = { findById: async () => openCompany };
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
      () =>
        lastValueFrom(
          interceptor.intercept(
            contextFor(
              ExpensesController.prototype.confirmImportFacturX,
              '/expenses/import-facturx/confirm',
              ExpensesController,
            ),
            next,
          ),
        ),
    );

    expect(value).toBe('approved');
    expect(runWithTenant).toHaveBeenCalledOnce();
  });
});

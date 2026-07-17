import { describe, expect, it, vi } from 'vitest';
import type { OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { BackendService } from './backend.service';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import { InMemoryPersistence } from './persistence/persistence.testing';

const OWNER: Principal = { userId: 'owner-user', companyId: 'company-owner' };
const INTRUDER: Principal = { userId: 'intruder-user', companyId: 'company-intruder' };

function asPrincipal<T>(principal: Principal, fn: () => T): T {
  return requestContext.run({ correlationId: 'bank-balance-test', principal }, fn);
}

function harness() {
  const persistence = new InMemoryPersistence();
  const service = new BackendService(
    persistence,
    {} as PaymentGatewayPort,
    {} as PdfRendererPort,
    {} as OcrPort,
    {
      setUserCompanyId: vi.fn(async () => undefined),
      deleteUser: vi.fn(async () => undefined),
    } as SupabaseAdminPort,
    {} as NotificationDeliveryService,
    {
      aiRequests: { inc: vi.fn() },
      aiDuration: { observe: vi.fn() },
      aiGuardViolations: { inc: vi.fn() },
    } as unknown as Metrics,
    { audit: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() } as unknown as AppLogger,
  );
  return { persistence, service };
}

describe('solde bancaire runtime — vérité tenant et absence de fallback', () => {
  it('alimente la trésorerie avec la valeur exacte confirmée, y compris négative', async () => {
    const { service } = harness();
    const observedAt = new Date().toISOString();

    const recorded = await asPrincipal(OWNER, () =>
      service.recordManualBankBalance({
        amountCents: -48_725,
        observedAt,
      }),
    );
    expect(recorded).toMatchObject({
      ok: true,
      value: {
        companyId: OWNER.companyId,
        amountCents: -48_725,
        source: 'manual_confirmed',
        reconciliationStatus: 'unreconciled',
        observedAt,
        freshness: { status: 'fresh' },
      },
    });

    const projection = await asPrincipal(OWNER, () => service.getCashflow('realiste', 30));
    expect(projection).toMatchObject({
      ok: true,
      value: {
        available: -48_725,
        payout: 0,
        risk: true,
        vatDue: 0,
        basis: {
          modelVersion: 'cashflow-projection/2',
          kind: 'dated_documents',
          scenario: 'realiste',
          horizonDays: 30,
          receivableCollectionRatePct: 90,
        },
      },
    });
  });

  it('isole strictement les observations bancaires entre propriétaires', async () => {
    const { service } = harness();
    const observedAt = new Date().toISOString();
    const recorded = await asPrincipal(OWNER, () =>
      service.recordManualBankBalance({
        amountCents: 901_250,
        observedAt,
      }),
    );
    expect(recorded.ok).toBe(true);

    const intruderView = await asPrincipal(INTRUDER, () => service.latestQualifiedBankBalance());
    expect(intruderView).toEqual({
      ok: false,
      error: {
        kind: 'not_found',
        entity: 'bank_balance_snapshot',
        id: INTRUDER.companyId,
      },
    });
  });

  it('reste indisponible sans observation au lieu de produire un faux zéro', async () => {
    const { service } = harness();

    await expect(asPrincipal(OWNER, () => service.getCashflow('realiste', 30))).resolves.toEqual({
      ok: false,
      error: { kind: 'unavailable', service: 'cashflow-banking-source' },
    });
  });
});

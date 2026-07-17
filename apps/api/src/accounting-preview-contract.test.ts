import { describe, expect, it, vi } from 'vitest';
import {
  Invoice,
  type OcrPort,
  type PaymentGatewayPort,
  type PdfRendererPort,
} from '@bob/core';
import { BackendService } from './backend.service';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { Metrics } from './observability/metrics';
import { InMemoryPersistence } from './persistence/persistence.testing';

const COMPANY_ID = 'company-1';
const PRINCIPAL: Principal = { userId: 'owner-1', companyId: COMPANY_ID };

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

function asOwner<T>(fn: () => T): T {
  return requestContext.run({ correlationId: 'accounting-preview-contract', principal: PRINCIPAL }, fn);
}

describe('contrat des aperçus comptables', () => {
  it('ne sérialise aucun total ni tableau sentinelle quand un aperçu de facture est indisponible', async () => {
    const { persistence, service } = harness();
    const invoice = Invoice.composeStandalone({
      id: 'invoice-without-lines',
      companyId: COMPANY_ID,
      customerId: 'customer-1',
    });
    if (!invoice.ok) throw new Error('La facture de test doit être valide.');
    await persistence.invoices.save(invoice.value);

    const result = await asOwner(() => service.invoiceAccountingPreview(invoice.value.id));

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.available) return;
    expect(result.value.reason.length).toBeGreaterThan(0);
    expect(result.value).toEqual({
      invoiceId: invoice.value.id,
      available: false,
      reason: result.value.reason,
    });
    expect(result.value).not.toHaveProperty('lines');
    expect(result.value).not.toHaveProperty('totalDebitCents');
    expect(result.value).not.toHaveProperty('totalCreditCents');
  });

  it('ne porte les lignes et totaux que dans la variante disponible', async () => {
    const { persistence, service } = harness();
    const invoice = Invoice.composeStandalone({
      id: 'invoice-with-line',
      companyId: COMPANY_ID,
      customerId: 'customer-1',
    });
    if (!invoice.ok) throw new Error('La facture de test doit être valide.');
    const line = invoice.value.addLine({
      id: 'line-1',
      label: 'Intervention',
      category: 'labor',
      qty: 1,
      unitPriceHT: 10_000,
      vatRate: 20,
    });
    if (!line.ok) throw new Error('La ligne de test doit être valide.');
    await persistence.invoices.save(invoice.value);

    const result = await asOwner(() => service.invoiceAccountingPreview(invoice.value.id));

    expect(result.ok).toBe(true);
    if (!result.ok || !result.value.available) return;
    expect(result.value.totalDebitCents).toBe(12_000);
    expect(result.value.totalCreditCents).toBe(12_000);
    expect(result.value.lines.length).toBeGreaterThanOrEqual(2);
    expect(result.value).not.toHaveProperty('reason');
  });
});

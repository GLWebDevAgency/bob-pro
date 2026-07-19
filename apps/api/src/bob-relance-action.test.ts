import { describe, expect, it, vi } from 'vitest';
import type { OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import type { BobActions } from '@bob/ai';
import { BackendService } from './backend.service';
import type { RelanceService } from './jobs/relance.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

/**
 * M2 — action hôte envoyer_relance (buildBobActions.sendRelance) : PURE délégation au MÊME
 * RelanceService que POST /invoices/:id/relance (sendRelanceForInvoice, tenant du Principal).
 * Mêmes gardes serveur (facture relançable, email client, ton du plan @bob/core) — l'hôte
 * n'ajoute AUCUNE logique. Sans RelanceService câblé, l'action est ABSENTE : le registre
 * n'expose pas l'outil (jamais un stub silencieux).
 */
const PRINCIPAL: Principal = { userId: 'u-owner', companyId: 'company-mercier' };

function makeService(relances: RelanceService | null) {
  const service = new BackendService(
    new InMemoryPersistence(),
    {} as PaymentGatewayPort,
    {} as PdfRendererPort,
    {} as OcrPort,
    {
      setUserCompanyId: async () => undefined,
      deleteUser: async () => undefined,
    } as SupabaseAdminPort,
    {} as NotificationDeliveryService,
    {} as Metrics,
    { audit: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() } as unknown as AppLogger,
    undefined,
    undefined,
    null,
    relances,
  );
  return service;
}

function bobActions(service: BackendService): BobActions {
  return (service as unknown as { buildBobActions(): BobActions }).buildBobActions();
}

function asPrincipal<T>(fn: () => Promise<T>): Promise<T> {
  return requestContext.run({ correlationId: 'test', principal: PRINCIPAL }, fn);
}

describe('buildBobActions.sendRelance — même service et mêmes gardes que le bouton « Relancer »', () => {
  it('délègue à RelanceService.sendRelanceForInvoice avec le tenant du Principal', async () => {
    const sendRelanceForInvoice = vi.fn(async () => ({
      ok: true as const,
      value: { jobId: 'job-1', status: 'pending', tone: 'ferme' },
    }));
    const service = makeService({ sendRelanceForInvoice } as unknown as RelanceService);

    const actions = bobActions(service);
    expect(actions.sendRelance).toBeDefined();

    const r = await asPrincipal(() => actions.sendRelance!({ invoiceId: 'inv-1' }));
    expect(r).toEqual({ ok: true, value: { jobId: 'job-1', status: 'pending', tone: 'ferme' } });
    expect(sendRelanceForInvoice).toHaveBeenCalledWith('company-mercier', 'inv-1');
  });

  it('restitue le refus honnête du service tel quel (facture non relançable)', async () => {
    const refusal = {
      ok: false as const,
      error: {
        kind: 'validation' as const,
        issues: [
          { field: 'invoiceId', message: 'Facture non relançable — réglée, annulée ou pas encore échue.' },
        ],
      },
    };
    const service = makeService({
      sendRelanceForInvoice: vi.fn(async () => refusal),
    } as unknown as RelanceService);

    const r = await asPrincipal(() => bobActions(service).sendRelance!({ invoiceId: 'inv-9' }));
    expect(r).toEqual(refusal);
  });

  it('sans RelanceService câblé : action ABSENTE — le registre n’exposera pas l’outil', () => {
    const actions = bobActions(makeService(null));
    expect(actions.sendRelance).toBeUndefined();
  });
});

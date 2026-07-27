import { describe, expect, it, vi } from 'vitest';
import type { Invoice, OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
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

function makeService(
  relances: RelanceService | null,
  p: InMemoryPersistence = new InMemoryPersistence(),
) {
  const service = new BackendService(
    p,
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

// ── Revue adversariale P0 « Encaisser » — draftRelance (outil « relancer » de Bob) ────────────

function dateOnlyDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Facture échue MINIMALE satisfaisant mapInvoice/ListCustomers (mêmes champs que la vue). */
function overdueInvoice(id: string, daysLate: number): Invoice {
  return {
    id,
    companyId: 'company-mercier',
    customerId: 'cust-martin',
    kind: 'final',
    status: 'issued',
    number: `F-${id}`,
    parentQuoteId: null,
    totals: () => ({ ht: 100_000, vatByRate: {}, vat: 20_000, ttc: 120_000, netToPay: 120_000 }),
    mentions: [],
    dueAt: dateOnlyDaysAgo(daysLate),
    paid: 0,
    lines: [],
    depositDeductionCents: 0,
    depositInvoiceId: null,
    purchaseOrder: null,
    revision: 1,
    creditNoteSource: null,
    situationOrder: null,
    situationDeductionCents: 0,
    globalDiscount: null,
    retenueGarantiePct: null,
    urgentRepair: null,
    transmission: null,
    issuedAt: dateOnlyDaysAgo(daysLate + 30),
  } as unknown as Invoice;
}

describe('buildBobActions.draftRelance — cadence société injectée (une seule vérité écran/voix/cron)', () => {
  async function seededPersistence(): Promise<InMemoryPersistence> {
    const p = new InMemoryPersistence();
    await p.seed();
    await p.invoices.save(overdueInvoice('inv-16', 16));
    return p;
  }

  it('sans cadence société : J+16 propose le ton NEUTRE (DEFAULT_RELANCE_POLICY, J+10)', async () => {
    const p = await seededPersistence();
    const draft = await asPrincipal(() => bobActions(makeService(null, p)).draftRelance({ invoiceId: 'inv-16' }));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.value.subject).toContain('relance');
    expect(draft.value.subject).not.toContain('petit rappel');
  });

  it('cadence société (cordial J+15) : le MÊME J+16 propose le ton CORDIAL — parité avec le cron', async () => {
    const p = await seededPersistence();
    await p.billingSettings.update({
      companyId: 'company-mercier',
      expectedRevision: 1,
      patch: {
        relancePolicy: {
          cordialAfterDays: 15,
          neutreAfterDays: 30,
          fermeAfterDays: 45,
          miseEnDemeureAfterDays: 60,
        },
      },
    });

    const draft = await asPrincipal(() => bobActions(makeService(null, p)).draftRelance({ invoiceId: 'inv-16' }));
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    // Avant le correctif, la voix ignorait la cadence société et escaladait déjà au neutre.
    expect(draft.value.subject).toContain('petit rappel');
  });
});

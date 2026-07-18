import { describe, expect, it, vi } from 'vitest';
import type { OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { InMemoryDocumentStorage } from './documents/storage.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

const MERCIER: Principal = { userId: 'u-mercier', companyId: MERCIER_PROPS.id };
const INTRUS: Principal = { userId: 'u-intrus', companyId: 'company-intrus' };

function asPrincipal<T>(principal: Principal, fn: () => T): T {
  return requestContext.run({ correlationId: 'document-view-link-test', principal }, fn);
}

function makeService() {
  const persistence = new InMemoryPersistence();
  for (const companyId of [MERCIER_PROPS.id, 'company-intrus']) {
    void persistence.subscriptions.startTrial({
      id: `sub-${companyId}`,
      companyId,
      plan: 'business',
      trialEndsAt: '2099-12-31T23:59:59.000Z',
      now: '2026-01-01T00:00:00.000Z',
    });
  }
  const renderer: PdfRendererPort = {
    renderInvoice: vi.fn(async (data) => new TextEncoder().encode(`%PDF-1.7\ninvoice:${data.number}`)),
    renderQuote: vi.fn(async (data) => new TextEncoder().encode(`%PDF-1.7\nquote:${data.number}`)),
  };
  const notificationDelivery = {
    enqueue: vi.fn(async (input: { notification: unknown }) => ({
      id: 'job-1',
      status: 'pending',
      notification: input.notification,
    })),
    tryDeliver: vi.fn(async () => true),
  } as unknown as NotificationDeliveryService;
  const logger = { audit: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() } as unknown as AppLogger;
  const metrics = {
    aiRequests: { inc: vi.fn() },
    aiDuration: { observe: vi.fn() },
    aiGuardViolations: { inc: vi.fn() },
  } as unknown as Metrics;
  const service = new BackendService(
    persistence,
    {} as PaymentGatewayPort,
    renderer,
    {} as OcrPort,
    { setUserCompanyId: vi.fn(), deleteUser: vi.fn() },
    notificationDelivery,
    metrics,
    logger,
    undefined,
    new InMemoryDocumentStorage(),
  );
  return { service, persistence, renderer };
}

async function createSentQuote(service: BackendService): Promise<string> {
  const quote = await service.createQuote({
    customerId: 'cust-martin',
    lines: [{ label: 'Prestation view-link', category: 'labor', qty: 1, unitPriceHT: 50_000, vatRate: 20 }],
  });
  if (!quote.ok) throw new Error('fixture: createQuote KO');
  const sent = await service.sendQuote(quote.value.quoteId);
  if (!sent.ok) throw new Error('fixture: sendQuote KO');
  return quote.value.quoteId;
}

async function createIssuedInvoice(service: BackendService): Promise<string> {
  const quoteId = await createSentQuote(service);
  const signed = await service.signQuote({ quoteId, signerName: 'Client view-link' });
  if (!signed.ok) throw new Error('fixture: signQuote KO');
  const generated = await service.generateInvoice({ quoteId, mode: 'final' });
  if (!generated.ok) throw new Error('fixture: generateInvoice KO');
  const issued = await service.issueInvoice({ invoiceId: generated.value.invoiceId });
  if (!issued.ok) throw new Error('fixture: issueInvoice KO');
  return generated.value.invoiceId;
}

describe('Lien public de VISUALISATION — devis', () => {
  it('crée le lien pour un devis envoyé, résout la vue publique, marque le jeton utilisé', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://view.bob.test');
    const { service, persistence } = makeService();
    await persistence.seed();
    await asPrincipal(MERCIER, async () => {
      const quoteId = await createSentQuote(service);
      const link = await service.createQuoteViewLink(quoteId);
      expect(link.ok).toBe(true);
      if (!link.ok) return;
      expect(link.value.viewUrl.startsWith('https://view.bob.test/view/')).toBe(true);

      const token = decodeURIComponent(link.value.viewUrl.split('/view/')[1]!);
      const view = await service.publicDocumentView(token);
      expect(view.ok).toBe(true);
      if (!view.ok) return;
      expect(view.value.kind).toBe('quote');
      if (view.value.kind !== 'quote') return;
      expect(view.value.status).toBe('sent');
      expect(view.value.companyName).toBe(MERCIER_PROPS.name);
    });
    vi.unstubAllEnvs();
  });

  it('refuse un devis BROUILLON (jamais un lien de consultation avant envoi)', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://view.bob.test');
    const { service, persistence } = makeService();
    await persistence.seed();
    await asPrincipal(MERCIER, async () => {
      const quote = await service.createQuote({
        customerId: 'cust-martin',
        lines: [{ label: 'Brouillon', category: 'labor', qty: 1, unitPriceHT: 10_000, vatRate: 20 }],
      });
      if (!quote.ok) throw new Error('fixture KO');
      const link = await service.createQuoteViewLink(quote.value.quoteId);
      expect(link.ok).toBe(false);
      if (!link.ok) expect(link.error.kind).toBe('domain');
    });
    vi.unstubAllEnvs();
  });

  it('rotation : un nouveau lien tue immédiatement l’ancien (même mécanique que la signature)', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://view.bob.test');
    const { service, persistence } = makeService();
    await persistence.seed();
    await asPrincipal(MERCIER, async () => {
      const quoteId = await createSentQuote(service);
      const first = await service.createQuoteViewLink(quoteId);
      if (!first.ok) throw new Error('fixture KO');
      const firstToken = decodeURIComponent(first.value.viewUrl.split('/view/')[1]!);

      const second = await service.createQuoteViewLink(quoteId);
      if (!second.ok) throw new Error('fixture KO');
      const secondToken = decodeURIComponent(second.value.viewUrl.split('/view/')[1]!);

      const oldView = await service.publicDocumentView(firstToken);
      expect(oldView.ok).toBe(false);
      const newView = await service.publicDocumentView(secondToken);
      expect(newView.ok).toBe(true);
    });
    vi.unstubAllEnvs();
  });

  it('PDF public d’un devis : appelle renderQuote (pas d’archive à servir, un devis n’est jamais figé)', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://view.bob.test');
    const { service, persistence, renderer } = makeService();
    await persistence.seed();
    await asPrincipal(MERCIER, async () => {
      const quoteId = await createSentQuote(service);
      const link = await service.createQuoteViewLink(quoteId);
      if (!link.ok) throw new Error('fixture KO');
      const token = decodeURIComponent(link.value.viewUrl.split('/view/')[1]!);

      const pdf = await service.publicDocumentPdf(token);
      expect(pdf.ok).toBe(true);
      expect(renderer.renderQuote).toHaveBeenCalledTimes(1);
    });
    vi.unstubAllEnvs();
  });
});

describe('Lien public de VISUALISATION — facture', () => {
  it('crée le lien pour une facture ÉMISE et résout la vue publique', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://view.bob.test');
    const { service, persistence } = makeService();
    await persistence.seed();
    await asPrincipal(MERCIER, async () => {
      const invoiceId = await createIssuedInvoice(service);
      const link = await service.createInvoiceViewLink(invoiceId);
      expect(link.ok).toBe(true);
      if (!link.ok) return;

      const token = decodeURIComponent(link.value.viewUrl.split('/view/')[1]!);
      const view = await service.publicDocumentView(token);
      expect(view.ok).toBe(true);
      if (!view.ok) return;
      expect(view.value.kind).toBe('invoice');
      if (view.value.kind !== 'invoice') return;
      expect(view.value.status).toBe('issued');
      expect(view.value.number).not.toBeNull();
    });
    vi.unstubAllEnvs();
  });

  it('refuse une facture BROUILLON (jamais numérotée) — guard « ÉMISE uniquement »', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://view.bob.test');
    const { service, persistence } = makeService();
    await persistence.seed();
    await asPrincipal(MERCIER, async () => {
      const quoteId = await createSentQuote(service);
      const signed = await service.signQuote({ quoteId, signerName: 'Client' });
      if (!signed.ok) throw new Error('fixture KO');
      const generated = await service.generateInvoice({ quoteId, mode: 'final' });
      if (!generated.ok) throw new Error('fixture KO');

      const link = await service.createInvoiceViewLink(generated.value.invoiceId);
      expect(link.ok).toBe(false);
      if (!link.ok) expect(link.error.kind).toBe('domain');
    });
    vi.unstubAllEnvs();
  });

  it('PDF public d’une facture ÉMISE : sert exactement l’archive immuable (même octets que invoicePdf authentifié)', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://view.bob.test');
    const { service, persistence } = makeService();
    await persistence.seed();
    await asPrincipal(MERCIER, async () => {
      const invoiceId = await createIssuedInvoice(service);
      const authed = await service.invoicePdf(invoiceId);
      if (!authed.ok) throw new Error('fixture KO');

      const link = await service.createInvoiceViewLink(invoiceId);
      if (!link.ok) throw new Error('fixture KO');
      const token = decodeURIComponent(link.value.viewUrl.split('/view/')[1]!);
      const publicPdf = await service.publicDocumentPdf(token);
      expect(publicPdf.ok).toBe(true);
      if (!publicPdf.ok) return;
      expect(publicPdf.value).toEqual(authed.value);
    });
    vi.unstubAllEnvs();
  });
});

describe('Lien public de VISUALISATION — jeton invalide / cross-tenant', () => {
  it('jeton inconnu → not_found générique (anti-énumération)', async () => {
    const { service, persistence } = makeService();
    await persistence.seed();
    const view = await service.publicDocumentView('inconnu');
    expect(view.ok).toBe(false);
    if (!view.ok) expect(view.error.kind).toBe('not_found');
  });

  it('un jeton `quote_signature` ne résout jamais publicDocumentView (canaux publics étanches)', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://view.bob.test');
    const { service, persistence } = makeService();
    await persistence.seed();
    await asPrincipal(MERCIER, async () => {
      const quoteId = await createSentQuote(service);
      const signatureLink = await service.createQuoteSignatureLink(quoteId);
      if (!signatureLink.ok) throw new Error('fixture KO');
      const token = decodeURIComponent(signatureLink.value.signatureUrl.split('/sign/')[1]!);

      const view = await service.publicDocumentView(token);
      expect(view.ok).toBe(false);
      if (!view.ok) expect(view.error.kind).toBe('not_found');
    });
    vi.unstubAllEnvs();
  });

  it('cross-tenant : un intrus ne peut pas créer de lien sur un devis d’un AUTRE tenant → not_found', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://view.bob.test');
    const { service, persistence } = makeService();
    await persistence.seed();
    const quoteId = await asPrincipal(MERCIER, () => createSentQuote(service));

    const result = await asPrincipal(INTRUS, () => service.createQuoteViewLink(quoteId));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
    vi.unstubAllEnvs();
  });

  it('cross-tenant : un intrus ne peut pas créer de lien sur une facture d’un AUTRE tenant → not_found', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://view.bob.test');
    const { service, persistence } = makeService();
    await persistence.seed();
    const invoiceId = await asPrincipal(MERCIER, () => createIssuedInvoice(service));

    const result = await asPrincipal(INTRUS, () => service.createInvoiceViewLink(invoiceId));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
    vi.unstubAllEnvs();
  });

  it('une partie BDD manquante rend les vues publiques indisponibles, jamais avec un nom vide', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://view.bob.test');
    const { service, persistence } = makeService();
    await persistence.seed();
    await asPrincipal(MERCIER, async () => {
      const quoteId = await createSentQuote(service);
      const viewLink = await service.createQuoteViewLink(quoteId);
      const signatureLink = await service.createQuoteSignatureLink(quoteId);
      if (!viewLink.ok || !signatureLink.ok) throw new Error('fixture KO');

      vi.spyOn(persistence.customers, 'findById').mockResolvedValue(null);
      const viewToken = decodeURIComponent(viewLink.value.viewUrl.split('/view/')[1]!);
      const signatureToken = decodeURIComponent(
        signatureLink.value.signatureUrl.split('/sign/')[1]!,
      );

      await expect(service.publicDocumentView(viewToken)).resolves.toEqual({
        ok: false,
        error: { kind: 'unavailable', service: 'document-parties' },
      });
      await expect(service.publicQuoteForSignature(signatureToken)).resolves.toEqual({
        ok: false,
        error: { kind: 'unavailable', service: 'document-parties' },
      });
    });
    vi.unstubAllEnvs();
  });
});

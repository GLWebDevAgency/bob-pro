import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';
import { InMemoryDocumentStorage } from './documents/storage.testing';
import { renderPdfFixture } from './documents/pdf-fixtures.testing';

/**
 * B8 — outil vocal lier_bon_commande, HÔTE RÉEL (buildBobActions → use case core
 * AttachPurchaseOrderToQuote) : « la RATP m'a envoyé un bon de commande n° 4500123 » propose,
 * la confirmation opaque (/ai/confirm) attache RÉELLEMENT le numéro d'engagement au devis, et
 * la facture générée ensuite le reprend automatiquement (Invoice.fromSignedQuote — la mention
 * figurera sur le PDF, exigence de paiement grands comptes + Chorus Pro).
 */

const MERCIER: Principal = { userId: 'u-mercier', companyId: MERCIER_PROPS.id };

beforeEach(() => {
  // Configuration réelle du service de signature (sendQuote) — origine réservée aux tests.
  vi.stubEnv('SIGN_WEB_BASE_URL', 'https://sign.bob.test');
  // Le routeur reste en configuration live : les demandes couvertes ici sont résolues par les
  // règles déterministes avant que l'adapter HTTP puisse utiliser cette clé sentinelle.
  vi.stubEnv('OPENAI_API_KEY', 'test-only-never-sent');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeService() {
  const p = new InMemoryPersistence();
  // askBob exige l'entitlement ai_assistant : ligne d'abonnement explicite, comme en réel.
  void p.subscriptions.startTrial({
    id: `sub-${MERCIER_PROPS.id}`,
    companyId: MERCIER_PROPS.id,
    plan: 'business',
    trialEndsAt: '2099-12-31T23:59:59.000Z',
    now: '2026-01-01T00:00:00.000Z',
  });
  const admin: SupabaseAdminPort = {
    setUserCompanyId: vi.fn(async () => undefined),
    deleteUser: vi.fn(async () => undefined),
  };
  const audit = vi.fn();
  const logger = { audit, error: vi.fn(), warn: vi.fn(), log: vi.fn() } as unknown as AppLogger;
  const notificationDelivery = {
    enqueue: vi.fn(async (input: { notification: unknown }) => ({
      id: 'job-po-voice',
      status: 'pending',
      notification: input.notification,
    })),
    tryDeliver: vi.fn(async () => true),
  } as unknown as NotificationDeliveryService;
  const metrics = {
    aiRequests: { inc: vi.fn() },
    aiDuration: { observe: vi.fn() },
    aiGuardViolations: { inc: vi.fn() },
  } as unknown as Metrics;
  const service = new BackendService(
    p,
    {} as PaymentGatewayPort,
    {
      renderInvoice: vi.fn(async (_data, facturX) =>
        renderPdfFixture('invoice', facturX?.xml)),
      renderQuote: vi.fn(async () => renderPdfFixture('quote')),
    } as PdfRendererPort,
    {} as OcrPort,
    admin,
    notificationDelivery,
    metrics,
    logger,
    undefined,
    new InMemoryDocumentStorage(),
  );
  return { service, p, audit };
}

function asMercier<T>(run: () => T): T {
  return requestContext.run({ correlationId: 'bob-po-voice', principal: MERCIER }, run);
}

/** Devis RÉEL signé d'un client créé pour l'occasion (jamais un statut fabriqué). */
async function signedRatpQuote(service: BackendService): Promise<{ quoteId: string }> {
  const customer = await service.createCustomer({
    name: 'RATP',
    type: 'b2g',
    // Identité publique réelle : le flux BT-13 ne doit pas contourner l'exigence BT-49/0225.
    siren: '775663438',
    address: { line1: '54 quai de la Rapée', zip: '75012', city: 'Paris' },
  });
  if (!customer.ok) throw new Error('fixage du décor : createCustomer KO');
  const quote = await service.createQuote({
    customerId: customer.value.id,
    lines: [
      { label: 'Rénovation local technique', category: 'labor', qty: 1, unitPriceHT: 1_000_000, vatRate: 20 },
    ],
  });
  if (!quote.ok) throw new Error('fixage du décor : createQuote KO');
  const sent = await service.sendQuote(quote.value.quoteId);
  if (!sent.ok) throw new Error('fixage du décor : sendQuote KO');
  const signed = await service.signQuote({
    quoteId: quote.value.quoteId,
    signerName: 'Mme Responsable Achats',
  });
  if (!signed.ok) throw new Error('fixage du décor : signQuote KO');
  return { quoteId: quote.value.quoteId };
}

describe('B8 — flow vocal lier_bon_commande (hôte réel → use case core → reprise facture)', () => {
  it('propose sur la voix, attache à la confirmation opaque, puis la facture générée reprend le numéro d’engagement', async () => {
    const { service, p, audit } = makeService();
    await p.seed();
    await asMercier(async () => {
      const { quoteId } = await signedRatpQuote(service);

      // 1) La voix : proposition (plancher de consentement) — rien n'est attaché avant.
      const proposed = await service.askBob('La RATP m’a envoyé un bon de commande n° 4500123');
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      expect(proposed.value.kind).toBe('proposed');
      expect(proposed.value.intent).toBe('lier_bon_commande');
      expect(proposed.value.pending?.tool).toBe('lier_bon_commande');
      expect(proposed.value.pending?.args).toMatchObject({ quoteId, number: '4500123' });
      expect(typeof proposed.value.pending?.proposalId).toBe('string');
      const before = await p.quotes.findById(quoteId);
      expect(before?.purchaseOrder).toBeNull();

      // 2) Confirmation par la proposition serveur opaque : MÊME use case que l'écran.
      const confirmed = await service.confirmBob({ proposalId: proposed.value.pending?.proposalId });
      expect(confirmed.ok).toBe(true);
      if (!confirmed.ok) return;
      expect(confirmed.value.kind).toBe('done');
      const after = await p.quotes.findById(quoteId);
      expect(after?.purchaseOrder?.number).toBe('4500123');
      expect(audit).toHaveBeenCalledWith(
        'quote.purchase_order_attached',
        expect.objectContaining({ quoteId, number: '4500123' }),
      );
      const quoteNumber = after?.number;
      expect(typeof quoteNumber).toBe('string');

      // 3) L'HÔTE HTTP (/ai/confirm) rend le MÊME enchaînement B8 que BobAgent.confirm :
      // carte « Bon de commande lié ✓ » + proposition de facture + choix verbatim + voix.
      expect(confirmed.value.card.title).toBe('Bon de commande lié ✓');
      expect(confirmed.value.card.body).toContain(
        `Je crée la facture du devis ${quoteNumber} avec ce bon de commande ?`,
      );
      expect(confirmed.value.choices?.[0]?.value).toBe(`Fais la facture du devis ${quoteNumber}`);
      expect(confirmed.value.spokenPrompt).toContain('Je crée la facture');

      // 4) ENCHAÎNEMENT VOCAL RÉEL : « Oui » + historique (la carte de l'étape 3) déclenche la
      // passerelle invoiceChainRef — délégation VERBATIM au flow generer_facture_devis EXISTANT,
      // et la facture dérivée reprend le bon de commande (fait par le core, jamais re-saisi).
      const invoiceProposed = await service.askBob({
        message: 'Oui',
        history: [
          { role: 'user', text: 'La RATP m’a envoyé un bon de commande n° 4500123' },
          { role: 'bob', text: confirmed.value.card.body },
        ],
      });
      expect(invoiceProposed.ok).toBe(true);
      if (!invoiceProposed.ok) return;
      expect(invoiceProposed.value.kind).toBe('proposed');
      expect(invoiceProposed.value.intent).toBe('generer_facture');
      expect(invoiceProposed.value.pending?.args).toMatchObject({ quoteId, mode: 'final' });
      const invoiceDone = await service.confirmBob({
        proposalId: invoiceProposed.value.pending?.proposalId,
      });
      expect(invoiceDone.ok).toBe(true);
      const invoices = await p.invoices.listByCompany(MERCIER_PROPS.id);
      const derived = invoices.find((invoice) => invoice.parentQuoteId === quoteId);
      expect(derived?.purchaseOrder?.number).toBe('4500123');

      // 5) Pièce STRUCTURÉE : la facture émise porte le numéro d'engagement dans le XML
      // Factur-X (BT-13, BuyerOrderReferencedDocument) — le canal que lisent Chorus Pro et
      // les AP grands comptes, pas seulement la mention du PDF.
      expect(derived).toBeDefined();
      const issued = await service.issueInvoice({ invoiceId: derived!.id });
      expect(issued.ok).toBe(true);
      const xml = await service.invoiceFacturXXml(derived!.id);
      expect(xml.ok).toBe(true);
      if (!xml.ok) return;
      expect(xml.value).toContain('<ram:BuyerOrderReferencedDocument>');
      expect(xml.value).toContain('<ram:IssuerAssignedID>4500123</ram:IssuerAssignedID>');
    });
  });

  it('client sans devis en cours : refus honnête, aucune mutation, aucun audit d’attachement', async () => {
    const { service, p, audit } = makeService();
    await p.seed();
    await asMercier(async () => {
      const { quoteId } = await signedRatpQuote(service);
      const r = await service.askBob('La Mairie de Vitry m’a envoyé un bon de commande n° 88');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.kind).toBe('answer');
      expect(r.value.card.body).toContain('Je ne trouve pas de devis en cours pour');
      const untouched = await p.quotes.findById(quoteId);
      expect(untouched?.purchaseOrder).toBeNull();
      expect(audit).not.toHaveBeenCalledWith('quote.purchase_order_attached', expect.anything());
    });
  });
});

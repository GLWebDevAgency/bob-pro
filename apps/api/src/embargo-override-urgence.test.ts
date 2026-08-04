import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  InvoicePdfData,
  OcrPort,
  PaymentGatewayPort,
  PdfRendererPort,
  QuotePdfData,
} from '@bob/core';
import { retractationExpiresAt } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InMemoryDocumentStorage } from './documents/storage.testing';
import { renderPdfFixture } from './documents/pdf-fixtures.testing';
import { waitForDocumentArchive } from './documents/archive-test-wait.testing';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import { InMemoryPersistence } from './persistence/persistence.testing';

/**
 * Embargo L221-10 (contrat hors établissement B2C) — flow SERVEUR complet des trois issues :
 *  1. DÉFAUT légal : encaissement PROGRAMMÉ à J+7 (outbox planifiée `notBefore`, message
 *     honnête au client — art. L221-10, al. 1) ;
 *  2. OVERRIDE responsabilisé : flag EXPLICITE `embargoOverride: true` → pièce produite ET
 *     payment.embargo_overridden journalisé (doctrine fondateur : averti, confirmé, tracé) ;
 *  3. EXCEPTION dépannage urgent (art. L221-10, al. 2 et L221-28, 8°) : intervention urgente
 *     expressément sollicitée, posée À LA CRÉATION du devis → pas d'embargo, mention datée sur
 *     le PDF, bloc rétractation ADAPTÉ (limité au strict nécessaire), formulaire R221-1 conservé.
 * Flow serveur réel (BackendService + InMemoryPersistence) — jamais de mock du domaine.
 */

const OWNER: Principal = { userId: 'owner-embargo', companyId: MERCIER_PROPS.id };

afterEach(() => {
  vi.unstubAllEnvs();
});

function asOwner<T>(run: () => T): T {
  return requestContext.run({ correlationId: 'embargo-l221-10', principal: OWNER }, run);
}

function makeService() {
  const persistence = new InMemoryPersistence();
  const renderedQuotes: QuotePdfData[] = [];
  const renderer: PdfRendererPort = {
    renderInvoice: vi.fn(async (data: InvoicePdfData, facturX) =>
      renderPdfFixture(`archive:${data.number}`, facturX?.xml),
    ),
    renderQuote: vi.fn(async (data: QuotePdfData) => {
      renderedQuotes.push(structuredClone(data));
      return renderPdfFixture(`quote:${data.number}`);
    }),
  };
  const enqueue = vi.fn(
    async (input: { notification: unknown }) => ({
      id: 'embargo-job-1',
      status: 'pending',
      notification: input.notification,
    }),
  );
  const notificationDelivery = {
    enqueue,
    tryDeliver: vi.fn(async () => true),
  } as unknown as NotificationDeliveryService;
  const audit = vi.fn();
  const logger = {
    audit,
    error: vi.fn(),
    warn: vi.fn(),
    log: vi.fn(),
  } as unknown as AppLogger;
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
  return { persistence, renderedQuotes, service, enqueue, audit };
}

/** Devis B2C envoyé puis signé SUR PLACE (onsite_draw → contrat hors établissement). */
async function onsiteSignedQuote(
  service: BackendService,
  persistence: InMemoryPersistence,
  input: { customerId?: string; urgentRepairRequested?: boolean } = {},
): Promise<string> {
  return asOwner(async () => {
    const quote = await service.createQuote({
      customerId: input.customerId ?? 'cust-durand',
      depositPct: 30,
      lines: [
        { label: 'Dépannage fuite', category: 'labor', qty: 1, unitPriceHT: 120_000, vatRate: 20 },
      ],
      ...(input.urgentRepairRequested === true ? { urgentRepairRequested: true } : {}),
    });
    if (!quote.ok) throw new Error('createQuote failed');
    const sent = await service.sendQuote(quote.value.quoteId);
    if (!sent.ok) throw new Error('sendQuote failed');
    const signed = await service.signQuote({
      quoteId: quote.value.quoteId,
      signerName: 'Mme Durand',
    });
    if (!signed.ok) throw new Error('signQuote failed');
    await waitForDocumentArchive({
      label: `signed quote ${quote.value.quoteId}`,
      drain: () => service.runDocumentArchiveJobs({ limit: 50 }),
      ready: async () =>
        (await persistence.documentArchiveJobs.findByPiece(
          MERCIER_PROPS.id,
          quote.value.quoteId,
          'quote-signed',
        ))?.status === 'done',
    });
    return quote.value.quoteId;
  });
}

describe('L221-10 — refus serveur par défaut, porteur de l’affordance d’override', () => {
  it('acompte pendant la fenêtre → OFF_PREMISES_PAYMENT_EMBARGO avec overridable + risque concret', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();
    const quoteId = await onsiteSignedQuote(service, persistence);

    const refused = await asOwner(() =>
      service.generateInvoice({ quoteId, mode: 'deposit' }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok || refused.error.kind !== 'domain') throw new Error('erreur domaine attendue');
    expect(refused.error.error).toMatchObject({
      code: 'OFF_PREMISES_PAYMENT_EMBARGO',
      overridable: true,
    });
    if (refused.error.error.code === 'OFF_PREMISES_PAYMENT_EMBARGO') {
      expect(refused.error.error.overrideRisk).toContain('L242-1');
      expect(refused.error.error.message).toContain('L221-10');
    }
  });
});

describe('L221-10 — override responsabilisé (flag explicite, journalisé)', () => {
  it('embargoOverride: true → pièce produite + payment.embargo_overridden audité', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service, audit } = makeService();
    await persistence.seed();
    const quoteId = await onsiteSignedQuote(service, persistence);

    const overridden = await asOwner(() =>
      service.generateInvoice({ quoteId, mode: 'deposit', embargoOverride: true }),
    );
    expect(overridden.ok).toBe(true);
    const call = audit.mock.calls.find(([event]) => event === 'payment.embargo_overridden');
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({
      quoteId,
      companyId: MERCIER_PROPS.id,
      invoiceKind: 'deposit',
    });
  });

  it('sans le flag (ou flag non-true), jamais d’override implicite', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service, audit } = makeService();
    await persistence.seed();
    const quoteId = await onsiteSignedQuote(service, persistence);

    const refused = await asOwner(() => service.generateInvoice({ quoteId, mode: 'deposit' }));
    expect(refused.ok).toBe(false);
    expect(
      audit.mock.calls.some(([event]) => event === 'payment.embargo_overridden'),
    ).toBe(false);
  });
});

describe('L221-10 — DÉFAUT légal : encaissement programmé à J+7 (outbox planifiée)', () => {
  it('programme le job à la fin d’embargo (notBefore), dédupé par devis, message honnête', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service, enqueue, audit } = makeService();
    await persistence.seed();
    const quoteId = await onsiteSignedQuote(service, persistence);

    const scheduled = await asOwner(() => service.scheduleEmbargoPayment(quoteId));
    expect(scheduled.ok).toBe(true);
    if (!scheduled.ok) return;
    expect(scheduled.value.scheduledFor).toBeTruthy();
    expect(scheduled.value.availableFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const call = enqueue.mock.calls.find(
      ([input]) => (input as unknown as { kind: string }).kind === 'embargo-scheduled-payment',
    );
    expect(call).toBeDefined();
    const input = call?.[0] as {
      dedupeKey: string;
      notBefore?: string;
      notification: { channel: string; to: string; body: string };
    };
    expect(input.dedupeKey).toBe(`quote:${quoteId}:embargo-scheduled-payment:v1`);
    // Le job ne devient DÛ qu'à la fin exacte de l'embargo : il part seul au premier jour légal.
    expect(input.notBefore).toBe(scheduled.value.scheduledFor);
    expect(input.notification.channel).toBe('email');
    expect(input.notification.to).toBe('m.durand@email.fr');
    expect(input.notification.body).toContain('L221-10');
    expect(input.notification.body).toContain('acompte');
    // HONNÊTETÉ : aucun lien de paiement n'existe dans ce message — il annonce l'envoi séparé
    // par l'entreprise (l'artisan est notifié à la livraison), jamais « avec ce message ».
    expect(input.notification.body).toContain('dans un envoi séparé');
    expect(input.notification.body).not.toContain('avec ce message');
    expect(audit.mock.calls.some(([event]) => event === 'payment.embargo_scheduled')).toBe(true);
  });

  it('devis SANS acompte : la pièce visée est la FINALE — date au gel de rétractation (J+14), libellé honnête', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service, enqueue } = makeService();
    await persistence.seed();
    // Pas de depositPct : netToPay = totalité TTC, la seule pièce encaissable est la FINALE,
    // gelée pendant le délai de rétractation (L221-18, pas d'exécution anticipée demandée).
    const quoteId = await asOwner(async () => {
      const quote = await service.createQuote({
        customerId: 'cust-durand',
        lines: [
          { label: 'Remplacement chaudière', category: 'labor', qty: 1, unitPriceHT: 400_000, vatRate: 20 },
        ],
      });
      if (!quote.ok) throw new Error('createQuote failed');
      const sent = await service.sendQuote(quote.value.quoteId);
      if (!sent.ok) throw new Error('sendQuote failed');
      const signed = await service.signQuote({
        quoteId: quote.value.quoteId,
        signerName: 'Mme Durand',
      });
      if (!signed.ok) throw new Error('signQuote failed');
      return quote.value.quoteId;
    });

    const scheduled = await asOwner(() => service.scheduleEmbargoPayment(quoteId));
    expect(scheduled.ok).toBe(true);
    if (!scheduled.ok) return;
    // La date programmée honore le gel de la finale : fin EXACTE du délai de rétractation
    // (L221-19) — jamais la promesse J+7 impossible à tenir (la finale serait refusée).
    const quote = await persistence.quotes.findById(quoteId);
    const expectedFreezeEnd = retractationExpiresAt(quote!.signature!.signedAt);
    expect(scheduled.value.scheduledFor).toBe(expectedFreezeEnd);

    const call = enqueue.mock.calls.find(
      ([input]) => (input as unknown as { kind: string }).kind === 'embargo-scheduled-payment',
    );
    const input = call?.[0] as { notBefore?: string; notification: { body: string } };
    expect(input.notBefore).toBe(expectedFreezeEnd);
    // Libellé honnête : sans acompte prévu, annoncer « l'acompte prévu de {TTC total} » est faux.
    expect(input.notification.body).toContain('le règlement du devis');
    expect(input.notification.body).not.toContain('acompte');
  });

  it('hors embargo (client pro) : refus honnête — rien à programmer', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();
    const quoteId = await onsiteSignedQuote(service, persistence, { customerId: 'cust-martin' });

    const scheduled = await asOwner(() => service.scheduleEmbargoPayment(quoteId));
    expect(scheduled.ok).toBe(false);
    if (scheduled.ok) return;
    expect(scheduled.error.kind).toBe('validation');
  });
});

describe('Exception dépannage urgent (L221-10, al. 2 / L221-28, 8°)', () => {
  it('posée à la création (b2c) : pas d’embargo — acompte immédiat sans aucun override', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service, audit } = makeService();
    await persistence.seed();
    const quoteId = await onsiteSignedQuote(service, persistence, { urgentRepairRequested: true });

    const quote = await persistence.quotes.findById(quoteId);
    expect(quote?.urgentRepair).not.toBeNull();

    const acompte = await asOwner(() => service.generateInvoice({ quoteId, mode: 'deposit' }));
    expect(acompte.ok).toBe(true);
    // Exception légale ≠ override : rien à journaliser.
    expect(
      audit.mock.calls.some(([event]) => event === 'payment.embargo_overridden'),
    ).toBe(false);
  });

  it('refusée à la création pour un client professionnel (le régime ne vise que le consommateur)', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();
    const created = await asOwner(() =>
      service.createQuote({
        customerId: 'cust-martin',
        urgentRepairRequested: true,
        lines: [
          { label: 'Dépannage', category: 'labor', qty: 1, unitPriceHT: 45_000, vatRate: 20 },
        ],
      }),
    );
    expect(created.ok).toBe(false);
    if (created.ok || created.error.kind !== 'domain') throw new Error('erreur domaine attendue');
    expect(created.error.error).toMatchObject({
      code: 'VALIDATION',
      field: 'urgentRepairRequested',
    });
  });

  it('PDF du devis : mention datée + bloc ADAPTÉ EN TÊTE, avis type COMPLET conservé, formulaire R221-1 conservé', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service, renderedQuotes } = makeService();
    await persistence.seed();
    // L'original du contrat est rendu et archivé À LA SIGNATURE (A8) — c'est CE rendu qu'on vérifie.
    await onsiteSignedQuote(service, persistence, { urgentRepairRequested: true });
    const data = renderedQuotes.at(-1);
    expect(data).toBeDefined();
    if (!data) return;
    // Mention datée sur le devis — la trace visible qui fonde l'exception (jamais implicite).
    expect(
      data.mentions.some((m) => m.includes('Intervention urgente sollicitée par le client le')),
    ).toBe(true);
    expect(data.retractation).not.toBeNull();
    if (!data.retractation) return;
    // Bloc ADAPTÉ EN TÊTE : exception L221-28, 8° limitée au strict nécessaire.
    expect(data.retractation.noticeLines[0]).toBe('Droit de rétractation — intervention urgente');
    expect(
      data.retractation.noticeLines.some((l) => l.includes('strictement nécessaires')),
    ).toBe(true);
    // L'avis type COMPLET SUIT le bloc adapté — jamais substitué : le droit RÉSIDUEL exige
    // l'information complète (modalités, effets L221-24, paiement proportionnel) et la mention
    // de la fonctionnalité de rétractation EN LIGNE (L221-5, 7° / L221-21 — un devis urgent
    // reste signable par lien ; l'omettre coûterait la présomption R221-3, délai 12 mois
    // L221-20, amende L242-13).
    const text = data.retractation.noticeLines.join('\n');
    expect(data.retractation.noticeLines).toContain('Droit de rétractation');
    expect(data.retractation.noticeLines).toContain('Effets de rétractation');
    expect(text).toContain('Renoncer au contrat ici');
    expect(text).toContain('nous vous rembourserons tous les paiements reçus');
    expect(text).toContain('montant proportionnel');
    // PRUDENCE : le droit subsiste au-delà du strict nécessaire → le formulaire R221-1 RESTE.
    expect(data.retractation.formLines[0]).toBe('Formulaire de rétractation');
  });

  it('PDF du devis SANS urgence : avis type complet inchangé (aucune régression A3)', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service, renderedQuotes } = makeService();
    await persistence.seed();
    await onsiteSignedQuote(service, persistence);
    const data = renderedQuotes.at(-1);
    expect(data?.retractation?.noticeLines[0]).toBe('Droit de rétractation');
    expect(
      data?.mentions.some((m) => m.includes('Intervention urgente')) ?? false,
    ).toBe(false);
  });
});

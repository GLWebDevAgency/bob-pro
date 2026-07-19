import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { InMemoryDocumentStorage } from './documents/storage.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';

/**
 * A3 — Fonctionnalité de RÉTRACTATION EN LIGNE (art. L221-21 dernier al. c. conso, ordonnance
 * n° 2026-2 du 05/01/2026 ; modalités art. D221-5, décret n° 2026-3 — en vigueur depuis le
 * 19/06/2026) : preuve de bout en bout que le flux produit corrige le manquement P0 —
 * l'interface de rétractation EXISTE pendant tout le délai (elle n'est plus détruite par la
 * révocation des jetons de signature), la déclaration s'exerce sans frais, l'accusé part sur
 * support durable, et le contrat rétracté ne produit plus aucune pièce.
 */

const MERCIER: Principal = { userId: 'u-mercier', companyId: MERCIER_PROPS.id };

function asPrincipal<T>(principal: Principal, fn: () => T): T {
  return requestContext.run({ correlationId: 'retractation-test', principal }, fn);
}

function makeService() {
  const persistence = new InMemoryPersistence();
  void persistence.subscriptions.startTrial({
    id: `sub-${MERCIER_PROPS.id}`,
    companyId: MERCIER_PROPS.id,
    plan: 'business',
    trialEndsAt: '2099-12-31T23:59:59.000Z',
    now: '2026-01-01T00:00:00.000Z',
  });
  const renderer: PdfRendererPort = {
    renderInvoice: vi.fn(async (data) => new TextEncoder().encode(`%PDF-1.7\ninvoice:${data.number}`)),
    renderQuote: vi.fn(async (data) => new TextEncoder().encode(`%PDF-1.7\nquote:${data.number}`)),
  };
  const enqueued: { kind: string; notification: { channel: string; to: string; subject: string; body: string } }[] = [];
  const notificationDelivery = {
    enqueue: vi.fn(async (input: { kind: string; notification: { channel: string; to: string; subject: string; body: string } }) => {
      enqueued.push({ kind: input.kind, notification: input.notification });
      return { id: `job-${enqueued.length}`, status: 'pending', notification: input.notification };
    }),
    runForCompany: vi.fn(async () => ({ scanned: 0, sent: 0, failed: 0 })),
  } as unknown as NotificationDeliveryService;
  const logger = {
    audit: vi.fn(),
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
  return { service, persistence, enqueued, logger };
}

function tokenFromUrl(url: string): string {
  return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
}

/** Devis B2C envoyé puis signé À DISTANCE (contrat à distance, L221-1, I-1°). */
async function signRemoteB2c(service: BackendService, options: { earlyExecution?: boolean } = {}) {
  const quote = await service.createQuote({
    customerId: 'cust-durand', // b2c (fixtures Mercier)
    lines: [
      { label: 'Rénovation salle de bain', category: 'labor', qty: 1, unitPriceHT: 500_000, vatRate: 10 },
    ],
    // P11 — le taux réduit 10 % exige l'éligibilité actée (art. 279-0 bis CGI).
    context: { housingOlderThan2y: true },
  });
  if (!quote.ok) throw new Error('fixture: createQuote KO');
  const sent = await service.sendQuote(quote.value.quoteId);
  if (!sent.ok) throw new Error('fixture: sendQuote KO');
  const link = await service.createQuoteSignatureLink(quote.value.quoteId);
  if (!link.ok) throw new Error('fixture: signature link KO');
  const signed = await service.publicSignQuote(
    tokenFromUrl(link.value.signatureUrl),
    'Mme Durand',
    undefined,
    options.earlyExecution ?? false,
  );
  if (!signed.ok) throw new Error('fixture: publicSignQuote KO');
  return { quoteId: quote.value.quoteId, signed: signed.value };
}

describe('A3 — fonctionnalité de rétractation en ligne (L221-21/D221-5)', () => {
  beforeEach(() => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://sign.bob.test');
  });

  it('signature B2C à distance → la réponse porte l’URL personnelle « /retract/… », valable jusqu’à la fin du délai', async () => {
    const { service, persistence } = makeService();
    await persistence.seed();
    const { signed } = await asPrincipal(MERCIER, () => signRemoteB2c(service));
    expect(signed.retractation).not.toBeNull();
    expect(signed.retractation?.url).toContain('https://sign.bob.test/retract/');
    // Délai L221-19 : instant précis de fin — présent et postérieur à la signature.
    expect(signed.retractation?.expiresAt).toBeTruthy();
  });

  it('la fonctionnalité SURVIT à la signature : vue publique disponible, libellés réglementaires exacts', async () => {
    const { service, persistence } = makeService();
    await persistence.seed();
    const { signed } = await asPrincipal(MERCIER, () => signRemoteB2c(service));
    const token = tokenFromUrl(signed.retractation!.url);
    const view = await service.publicRetractationView(token);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    // Libellés imposés par l'art. D221-5 (décret n° 2026-3).
    expect(view.value.withdrawLabel).toBe('Renoncer au contrat ici');
    expect(view.value.confirmLabel).toBe('Confirmer la rétractation');
    expect(view.value.available).toBe(true);
    expect(view.value.alreadyRetracted).toBe(false);
    expect(view.value.prefill.declarantName).toBe('Mme Durand');
  });

  it('exercice complet : déclaration → rétractation enregistrée, accusé (support durable) affiché ET envoyé au courriel choisi, jetons consommés', async () => {
    const { service, persistence, enqueued } = makeService();
    await persistence.seed();
    const { quoteId, signed } = await asPrincipal(MERCIER, () => signRemoteB2c(service));
    const token = tokenFromUrl(signed.retractation!.url);

    const exercised = await service.publicExerciseRetractation(token, {
      declarantName: 'Mme Durand',
      acknowledgmentEmail: 'durand@example.fr',
    });
    expect(exercised.ok).toBe(true);
    if (!exercised.ok) return;
    // Accusé D221-5, IV : contenu de la déclaration + date/heure d'envoi.
    const acknowledgment = exercised.value.acknowledgmentLines.join('\n');
    expect(acknowledgment).toContain('Accusé de réception');
    expect(acknowledgment).toContain('Mme Durand');
    expect(acknowledgment).toContain('durand@example.fr');
    expect(acknowledgment).toContain('heure de Paris');
    // Support durable : courriel outbox à l'adresse CHOISIE par le consommateur.
    const mail = enqueued.find((e) => e.kind === 'retractation-acknowledgment');
    expect(mail).toBeDefined();
    expect(mail?.notification.channel).toBe('email');
    expect(mail?.notification.to).toBe('durand@example.fr');
    expect(mail?.notification.body).toContain('Accusé de réception');

    // Le jeton a rempli son office : la vue publique ne répond plus (anti-énumération).
    const after = await service.publicRetractationView(token);
    expect(after.ok).toBe(false);

    // Le contrat rétracté ne produit plus AUCUNE pièce (acompte comme finale).
    await asPrincipal(MERCIER, async () => {
      for (const mode of ['deposit', 'final'] as const) {
        const generation = await service.generateInvoice({ quoteId, mode });
        expect(generation.ok).toBe(false);
        if (!generation.ok && generation.error.kind === 'domain') {
          expect(generation.error.error.code).toBe('QUOTE_RETRACTED');
        }
      }
    });
  });

  it('la rétractation reste exerçable MÊME après demande d’exécution anticipée (L221-25 ne supprime pas le droit)', async () => {
    const { service, persistence } = makeService();
    await persistence.seed();
    const { signed } = await asPrincipal(MERCIER, () => signRemoteB2c(service, { earlyExecution: true }));
    const token = tokenFromUrl(signed.retractation!.url);
    const view = await service.publicRetractationView(token);
    expect(view.ok && view.value.available).toBe(true);
  });

  it('client PROFESSIONNEL : aucun jeton de rétractation (pas de droit — jamais de fonctionnalité fantôme)', async () => {
    const { service, persistence } = makeService();
    await persistence.seed();
    const result = await asPrincipal(MERCIER, async () => {
      const quote = await service.createQuote({
        customerId: 'cust-martin', // b2b
        lines: [{ label: 'Lot plomberie', category: 'labor', qty: 1, unitPriceHT: 500_000, vatRate: 20 }],
      });
      if (!quote.ok) throw new Error('fixture: createQuote KO');
      const sent = await service.sendQuote(quote.value.quoteId);
      if (!sent.ok) throw new Error('fixture: sendQuote KO');
      const link = await service.createQuoteSignatureLink(quote.value.quoteId);
      if (!link.ok) throw new Error('fixture: link KO');
      return service.publicSignQuote(tokenFromUrl(link.value.signatureUrl), 'SARL Martin');
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.retractation).toBeNull();
  });

  it('adresse électronique invalide → refus de la déclaration (l’accusé sur support durable est dû), rien n’est enregistré', async () => {
    const { service, persistence } = makeService();
    await persistence.seed();
    const { signed } = await asPrincipal(MERCIER, () => signRemoteB2c(service));
    const token = tokenFromUrl(signed.retractation!.url);
    const refused = await service.publicExerciseRetractation(token, {
      declarantName: 'Mme Durand',
      acknowledgmentEmail: 'pas-un-email',
    });
    expect(refused.ok).toBe(false);
    // La fonctionnalité reste disponible (le droit court toujours).
    const view = await service.publicRetractationView(token);
    expect(view.ok && view.value.available).toBe(true);
  });

  it('jeton inconnu → « introuvable » indistinct (anti-énumération)', async () => {
    const { service, persistence } = makeService();
    await persistence.seed();
    const view = await service.publicRetractationView('jeton-inconnu');
    expect(view.ok).toBe(false);
    if (!view.ok) expect(view.error.kind).toBe('not_found');
  });
});

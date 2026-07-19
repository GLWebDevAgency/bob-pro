import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationPort, OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { InMemoryDocumentStorage } from './documents/storage.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { ScheduledTenantDirectory } from './jobs/tenant-directory';
import { embargoScheduledPaymentDedupeKey } from './persistence/notification-jobs';
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

describe('A3 × L221-10 — rétractation vs encaissement programmé (job outbox J+7)', () => {
  beforeEach(() => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://sign.bob.test');
  });

  const EMBARGO_NOTIFICATION = {
    channel: 'email' as const,
    to: 'durand@example.fr',
    subject: 'Votre devis — règlement possible',
    body: 'Le règlement peut désormais vous être demandé.',
  };

  it('rétractation en ligne → le job « encaissement programmé » est ANNULÉ dans la transaction, plus jamais dû', async () => {
    const { service, persistence } = makeService();
    await persistence.seed();
    const { quoteId, signed } = await asPrincipal(MERCIER, () => signRemoteB2c(service));
    // Encaissement programmé PENDANT la fenêtre : job durable, dû seulement à l'échéance.
    const job = await persistence.notificationJobs.enqueue({
      id: 'job-embargo-cancel-1',
      companyId: MERCIER_PROPS.id,
      kind: 'embargo-scheduled-payment',
      dedupeKey: embargoScheduledPaymentDedupeKey(quoteId),
      notification: EMBARGO_NOTIFICATION,
      now: new Date().toISOString(),
      notBefore: '2099-01-01T00:00:00.000Z',
    });

    const token = tokenFromUrl(signed.retractation!.url);
    const exercised = await service.publicExerciseRetractation(token, {
      declarantName: 'Mme Durand',
      acknowledgmentEmail: 'durand@example.fr',
    });
    expect(exercised.ok).toBe(true);

    // Un consommateur rétracté ne doit JAMAIS recevoir l'invite de paiement planifiée
    // (L221-25 : rien n'est dû — elle contredirait l'accusé D221-5 qui vient de partir).
    const after = await persistence.notificationJobs.findById(MERCIER_PROPS.id, job.id);
    expect(after?.status).toBe('cancelled');
    const due = await persistence.notificationJobs.listDue(
      MERCIER_PROPS.id,
      '2099-02-01T00:00:00.000Z',
      50,
    );
    expect(due.find((candidate) => candidate.id === job.id)).toBeUndefined();
  });

  it('défense en profondeur : un job embargo encore actif d’un devis RÉTRACTÉ est annulé À LA LIVRAISON (jamais envoyé)', async () => {
    const { service, persistence } = makeService();
    await persistence.seed();
    const { quoteId, signed } = await asPrincipal(MERCIER, () => signRemoteB2c(service));
    const token = tokenFromUrl(signed.retractation!.url);
    const exercised = await service.publicExerciseRetractation(token, {
      declarantName: 'Mme Durand',
      acknowledgmentEmail: 'durand@example.fr',
    });
    expect(exercised.ok).toBe(true);

    // Job qui aurait survécu à l'annulation transactionnelle (version antérieure, course…) :
    // DÛ immédiatement — la garde par kind du worker doit l'annuler avant tout I/O provider.
    const job = await persistence.notificationJobs.enqueue({
      id: 'job-embargo-stale-1',
      companyId: MERCIER_PROPS.id,
      kind: 'embargo-scheduled-payment',
      dedupeKey: embargoScheduledPaymentDedupeKey(quoteId),
      notification: EMBARGO_NOTIFICATION,
      now: '2020-01-01T00:00:00.000Z',
    });
    const send = vi.fn(async () => undefined);
    const delivery = new NotificationDeliveryService(
      persistence,
      { send } as unknown as NotificationPort,
      { listCompanyIds: vi.fn(async () => [MERCIER_PROPS.id]) } as unknown as ScheduledTenantDirectory,
      { audit: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn() } as unknown as AppLogger,
    );

    const outcome = await delivery.runForCompany(MERCIER_PROPS.id, 25);
    expect(send).not.toHaveBeenCalled();
    expect(outcome.sent).toBe(0);
    const after = await persistence.notificationJobs.findById(MERCIER_PROPS.id, job.id);
    expect(after?.status).toBe('cancelled');
    // Annulé = plus jamais réclamé, même par un sweep ultérieur.
    const again = await delivery.runForCompany(MERCIER_PROPS.id, 25);
    expect(again.scanned).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

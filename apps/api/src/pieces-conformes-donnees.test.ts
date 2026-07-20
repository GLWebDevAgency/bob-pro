import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InvoicePdfData, OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { Company } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InvoicesController } from './api.controllers';
import { InMemoryDocumentStorage } from './documents/storage.testing';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { RelanceService } from './jobs/relance.service';
import type { Metrics } from './observability/metrics';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import { InMemoryPersistence } from './persistence/persistence.testing';

/**
 * ÉPIC « pièces conformes » — socle DONNÉES A2/A6/A7 (AUDIT_INDISPENSABLES_V1) :
 * - A6 : capital social (art. R123-238 c. com.) porté par Company, sociétés uniquement ;
 * - A2 : médiateur de la consommation (art. L612-1/L616-1 c. conso) porté par Company ;
 * - A7 : date de la prestation + adresse de chantier/livraison (art. L441-9 c. com.,
 *   242 nonies A CGI) figées à l'émission de la facture.
 * Flow serveur réel (BackendService + InMemoryPersistence), jamais de mock du domaine.
 */

const OWNER: Principal = { userId: 'owner-legal', companyId: MERCIER_PROPS.id };

afterEach(() => {
  vi.unstubAllEnvs();
});

function asOwner<T>(run: () => T): T {
  return requestContext.run({ correlationId: 'pieces-conformes-donnees', principal: OWNER }, run);
}

function makeService() {
  const persistence = new InMemoryPersistence();
  const rendered: InvoicePdfData[] = [];
  const renderer: PdfRendererPort = {
    renderInvoice: vi.fn(async (data) => {
      rendered.push(structuredClone(data));
      return new TextEncoder().encode(`%PDF-1.7\narchive:${data.number}`);
    }),
    renderQuote: vi.fn(async (data) => new TextEncoder().encode(`%PDF-1.7\nquote:${data.number}`)),
  };
  const notificationDelivery = {
    enqueue: vi.fn(async (input: { notification: unknown }) => ({
      id: 'notification-job-legal',
      status: 'pending',
      notification: input.notification,
    })),
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
  const storage = new InMemoryDocumentStorage();
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
    storage,
  );
  return { persistence, rendered, service, audit };
}

async function signedQuoteId(service: BackendService): Promise<string> {
  const quote = await service.createQuote({
    customerId: 'cust-martin',
    lines: [
      { label: 'Rénovation salle d’eau', category: 'labor', qty: 1, unitPriceHT: 180_000, vatRate: 20 },
    ],
  });
  if (!quote.ok) throw new Error('createQuote failed');
  const sent = await service.sendQuote(quote.value.quoteId);
  if (!sent.ok) throw new Error('sendQuote failed');
  const signed = await service.signQuote({
    quoteId: quote.value.quoteId,
    signerName: 'M. Martin',
  });
  if (!signed.ok) throw new Error('signQuote failed');
  return quote.value.quoteId;
}

describe('A2/A6 — PATCH /company/legal (BackendService.updateCompanyLegal)', () => {
  it('écrit puis efface le médiateur conso ; la fiche société relue reste la seule vérité', async () => {
    const { persistence, service, audit } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const written = await service.updateCompanyLegal({
        mediateurConso: { nom: 'CM2C', coordonnees: '14 rue Saint-Jean, 75017 Paris — cm2c.net' },
      });
      expect(written.ok).toBe(true);
      if (!written.ok) return;
      expect(written.value.mediateurConso).toEqual({
        nom: 'CM2C',
        coordonnees: '14 rue Saint-Jean, 75017 Paris — cm2c.net',
      });
      expect(audit).toHaveBeenCalledWith('company.legal_updated', {
        companyId: MERCIER_PROPS.id,
        capitalChanged: false,
        mediateurChanged: true,
        // A3 — coordonnées de l'entreprise (modèles R221-1/R221-3) : non touchées ici.
        emailChanged: false,
        phoneChanged: false,
        // Identité bloquant l'émission (art. R123-237 c. com.) : non touchée ici non plus.
        rcsOrRmChanged: false,
        addressChanged: false,
      });

      const reread = await service.getCompanyMe();
      expect(reread.ok && reread.value.mediateurConso?.nom).toBe('CM2C');

      // Effacement EXPLICITE (null) — un champ non transmis reste inchangé.
      const erased = await service.updateCompanyLegal({ mediateurConso: null });
      expect(erased.ok && erased.value.mediateurConso).toBeUndefined();
    });
  });

  it('A6 fail-closed : refuse le capital social pour une EI (pas de capital hors société)', async () => {
    const { persistence, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const rejected = await service.updateCompanyLegal({ capitalSocialCents: 500_000 });
      expect(rejected).toMatchObject({
        ok: false,
        error: { kind: 'domain', error: { code: 'VALIDATION', field: 'capitalSocialCents' } },
      });
      const reread = await service.getCompanyMe();
      expect(reread.ok && reread.value.capitalSocialCents).toBeUndefined();
    });
  });

  it('A6 : accepte et persiste le capital d’une société (centimes entiers > 0)', async () => {
    const { persistence, service } = makeService();
    await persistence.seed();
    const sarl = Company.of({ ...MERCIER_PROPS, legalForm: 'SARL' });
    if (!sarl.ok) throw new Error('sarl');
    persistence.companies.seed(sarl.value);

    await asOwner(async () => {
      const written = await service.updateCompanyLegal({ capitalSocialCents: 1_000_000 });
      expect(written.ok && written.value.capitalSocialCents).toBe(1_000_000);
      const reread = await service.getCompanyMe();
      expect(reread.ok && reread.value.capitalSocialCents).toBe(1_000_000);
    });
  });
});

describe('A7 — période de prestation + adresse de chantier figées à l’émission', () => {
  it('émet avec période + adresse, les persiste et les recopie sur l’avoir total', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const quoteId = await signedQuoteId(service);
      const generated = await service.generateInvoice({ quoteId, mode: 'final' });
      expect(generated.ok).toBe(true);
      if (!generated.ok) return;

      const issued = await service.issueInvoice({
        invoiceId: generated.value.invoiceId,
        servicePeriod: { start: '2026-06-02', end: '2026-06-13' },
        deliveryAddress: 'Chantier — 8 allée des Roses, 92190 Meudon',
      });
      expect(issued.ok).toBe(true);

      const persisted = await persistence.invoices.findById(generated.value.invoiceId);
      expect(persisted?.servicePeriod).toEqual({ start: '2026-06-02', end: '2026-06-13' });
      expect(persisted?.deliveryAddress).toBe('Chantier — 8 allée des Roses, 92190 Meudon');

      // Avoir total : reprise À L'IDENTIQUE (art. 242 nonies A CGI — référence à la pièce initiale).
      const credit = await service.createCreditNote({ invoiceId: generated.value.invoiceId });
      expect(credit.ok).toBe(true);
      if (!credit.ok) return;
      const creditNote = await persistence.invoices.findById(credit.value.creditNoteId);
      expect(creditNote?.servicePeriod).toEqual({ start: '2026-06-02', end: '2026-06-13' });
      expect(creditNote?.deliveryAddress).toBe('Chantier — 8 allée des Roses, 92190 Meudon');
    });
  });

  it('rejette une période incohérente : la facture reste brouillon, aucun numéro consommé', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const quoteId = await signedQuoteId(service);
      const generated = await service.generateInvoice({ quoteId, mode: 'final' });
      if (!generated.ok) throw new Error('generateInvoice failed');

      const rejected = await service.issueInvoice({
        invoiceId: generated.value.invoiceId,
        servicePeriod: { start: '2026-06-13', end: '2026-06-02' },
      });
      expect(rejected).toMatchObject({
        ok: false,
        error: { kind: 'domain', error: { code: 'VALIDATION', field: 'servicePeriod' } },
      });
      const persisted = await persistence.invoices.findById(generated.value.invoiceId);
      expect(persisted?.status).toBe('draft');
      expect(persisted?.number).toBeNull();
    });
  });
});

describe('POST /invoices/:id/issue — contrôleur (corps A7 optionnel, allowlist stricte)', () => {
  function controller(overrides: Partial<BackendService> = {}) {
    return new InvoicesController(overrides as BackendService, {} as RelanceService);
  }

  it('sans corps : délègue avec le seul id du chemin (compat clients existants)', async () => {
    const issueInvoice = vi.fn(async () => ({ ok: true as const, value: { number: 'F-2026-0001' } }));
    const value = controller({ issueInvoice } as never);

    await expect(value.issue('inv-1')).resolves.toEqual({ number: 'F-2026-0001' });
    expect(issueInvoice).toHaveBeenCalledWith({ invoiceId: 'inv-1' });
  });

  it('tolère le corps legacy { invoiceId, terms } sans le transmettre (réglages serveur décident)', async () => {
    const issueInvoice = vi.fn(async () => ({ ok: true as const, value: { number: 'F-2026-0001' } }));
    const value = controller({ issueInvoice } as never);

    await value.issue('inv-1', {
      invoiceId: 'inv-1',
      terms: { days: 30, endOfMonth: false, label: 'Paiement à 30 jours' },
    });
    expect(issueInvoice).toHaveBeenCalledWith({ invoiceId: 'inv-1' });
  });

  it('rejette un invoiceId de corps incohérent avec le chemin', async () => {
    const issueInvoice = vi.fn();
    const value = controller({ issueInvoice } as never);

    await expect(value.issue('inv-1', { invoiceId: 'inv-AUTRE' })).rejects.toMatchObject({
      status: 422,
    });
    expect(issueInvoice).not.toHaveBeenCalled();
  });

  it('transmet période + adresse validées (trim), en refusant les formes invalides', async () => {
    const issueInvoice = vi.fn(async () => ({ ok: true as const, value: { number: 'F-2026-0001' } }));
    const value = controller({ issueInvoice } as never);

    await value.issue('inv-1', {
      servicePeriod: { start: '2026-06-02', end: null },
      deliveryAddress: '  Chantier — 8 allée des Roses, 92190 Meudon  ',
    });
    expect(issueInvoice).toHaveBeenCalledWith({
      invoiceId: 'inv-1',
      servicePeriod: { start: '2026-06-02', end: null },
      deliveryAddress: 'Chantier — 8 allée des Roses, 92190 Meudon',
    });

    for (const body of [
      { servicePeriod: { start: '2026-02-30', end: null } },
      { servicePeriod: { start: '2026-06-02', end: 'demain' } },
      { servicePeriod: { start: '2026-06-02', end: null, extra: true } },
      { deliveryAddress: '' },
      { deliveryAddress: 'X'.repeat(501) },
      { champInconnu: 1 },
    ]) {
      await expect(value.issue('inv-1', body)).rejects.toMatchObject({ status: 422 });
    }
    expect(issueInvoice).toHaveBeenCalledTimes(1);
  });
});

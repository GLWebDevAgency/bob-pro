import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  InvoicePdfData,
  OcrPort,
  PaymentGatewayPort,
  PdfRendererPort,
  QuotePdfData,
} from '@bob/core';
import { RETRACTATION_EARLY_EXECUTION_LABEL } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { PdfRenderer } from './documents/pdf-renderer';
import { InMemoryDocumentStorage } from './documents/storage.testing';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import { InMemoryPersistence } from './persistence/persistence.testing';

/**
 * A3 — Droit de rétractation 14 jours B2C (AUDIT_INDISPENSABLES_V1) : flow SERVEUR complet.
 * Sources : art. L221-18 s. c. conso (délai), L221-1 (à distance / hors établissement — tout
 * devis B2C signé via l'app y est soumis), L221-5/L221-9 + annexe R221-1 (formulaire type
 * joint au contrat), annexe R221-3 (avis d'information type), L221-25 (exécution anticipée),
 * L221-20 (sanction : délai porté à 12 mois si information non fournie).
 * Flow serveur réel (BackendService + InMemoryPersistence) + rendu pdf-lib réel — jamais de
 * mock du domaine.
 */

const OWNER: Principal = { userId: 'owner-a3', companyId: MERCIER_PROPS.id };

afterEach(() => {
  vi.unstubAllEnvs();
});

function asOwner<T>(run: () => T): T {
  return requestContext.run({ correlationId: 'retractation-a3', principal: OWNER }, run);
}

function makeService() {
  const persistence = new InMemoryPersistence();
  const renderedQuotes: QuotePdfData[] = [];
  const renderer: PdfRendererPort = {
    renderInvoice: vi.fn(async (data: InvoicePdfData) => {
      return new TextEncoder().encode(`%PDF-1.7\narchive:${data.number}`);
    }),
    renderQuote: vi.fn(async (data: QuotePdfData) => {
      renderedQuotes.push(structuredClone(data));
      return new TextEncoder().encode(`%PDF-1.7\nquote:${data.number}`);
    }),
  };
  const notificationDelivery = {
    enqueue: vi.fn(async (input: { notification: unknown }) => ({
      id: 'notification-job-a3',
      status: 'pending',
      notification: input.notification,
    })),
    tryDeliver: vi.fn(async () => true),
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
  return { persistence, renderedQuotes, service };
}

/** Devis ENVOYÉ avec lien de signature — retourne l'id et le token public. */
async function sentQuote(
  service: BackendService,
  customerId: string,
  depositPct?: number,
): Promise<{ quoteId: string; token: string }> {
  return asOwner(async () => {
    const quote = await service.createQuote({
      customerId,
      lines: [
        { label: 'Remplacement chauffe-eau', category: 'labor', qty: 1, unitPriceHT: 120_000, vatRate: 20 },
      ],
      ...(depositPct !== undefined ? { depositPct } : {}),
    });
    if (!quote.ok) throw new Error('createQuote failed');
    const sent = await service.sendQuote(quote.value.quoteId);
    if (!sent.ok || !sent.value.signatureToken) throw new Error('sendQuote failed');
    return { quoteId: quote.value.quoteId, token: sent.value.signatureToken };
  });
}

describe('A3 — payload public de signature : information AVANT signature', () => {
  it('client PARTICULIER (b2c) : avis d’information type + libellé EXACT de la case L221-25', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();
    const { token } = await sentQuote(service, 'cust-durand');

    const view = await service.publicQuoteForSignature(token);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const retractation = view.value.retractation;
    expect(retractation).not.toBeNull();
    if (!retractation) return;
    // Avis d'information type (annexe art. R221-3 c. conso) : intitulé + délai + point de départ.
    expect(retractation.noticeLines[0]).toBe('Droit de rétractation');
    expect(
      retractation.noticeLines.some((l) =>
        l.includes('délai de quatorze jours'),
      ),
    ).toBe(true);
    expect(
      retractation.noticeLines.some((l) =>
        l.includes('quatorze jours après le jour de la conclusion du contrat'),
      ),
    ).toBe(true);
    // Coordonnées réelles du professionnel insérées (jamais inventées).
    expect(retractation.noticeLines.some((l) => l.includes(MERCIER_PROPS.name))).toBe(true);
    // Libellé de la case : SOURCE UNIQUE @bob/core, servi tel quel à la page.
    expect(retractation.earlyExecutionLabel).toBe(RETRACTATION_EARLY_EXECUTION_LABEL);
    expect(retractation.earlyExecutionLabel).toContain('L221-25');
  });

  it('client PROFESSIONNEL (b2b) : aucun bloc rétractation (le droit n’existe pas)', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();
    const { token } = await sentQuote(service, 'cust-martin');

    const view = await service.publicQuoteForSignature(token);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.retractation).toBeNull();
  });
});

describe('A3 — signature publique : demande d’exécution anticipée tracée (L221-25)', () => {
  it('b2c + case cochée → renonciation horodatée SERVEUR persistée dans la signature', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();
    const { quoteId, token } = await sentQuote(service, 'cust-durand');

    const signed = await service.publicSignQuote(token, 'Mme Durand', undefined, true);
    expect(signed.ok).toBe(true);

    const quote = await persistence.quotes.findById(quoteId);
    expect(quote?.signature?.earlyExecution).toBeDefined();
    expect(quote?.signature?.earlyExecution?.requestedAt).toBe(quote?.signature?.signedAt);
  });

  it('b2c SANS case → aucune renonciation fabriquée', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();
    const { quoteId, token } = await sentQuote(service, 'cust-durand');

    const signed = await service.publicSignQuote(token, 'Mme Durand');
    expect(signed.ok).toBe(true);
    const quote = await persistence.quotes.findById(quoteId);
    expect(quote?.signature?.earlyExecution).toBeUndefined();
  });

  it('b2b + drapeau posé → IGNORÉ (un droit inexistant ne se renonce pas)', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();
    const { quoteId, token } = await sentQuote(service, 'cust-martin');

    const signed = await service.publicSignQuote(token, 'M. Martin', undefined, true);
    expect(signed.ok).toBe(true);
    const quote = await persistence.quotes.findById(quoteId);
    expect(quote?.signature).not.toBeNull();
    expect(quote?.signature?.earlyExecution).toBeUndefined();
  });
});

describe('A3 — gel serveur du passage devis signé → facture FINALE', () => {
  it('b2c signé SANS exécution anticipée : finale REFUSÉE (message honnête + date), ACOMPTE possible', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();
    const { quoteId, token } = await sentQuote(service, 'cust-durand', 30);
    expect((await service.publicSignQuote(token, 'Mme Durand')).ok).toBe(true);

    await asOwner(async () => {
      const final = await service.generateInvoice({ quoteId, mode: 'final' });
      expect(final.ok).toBe(false);
      if (final.ok) return;
      expect(final.error.kind).toBe('domain');
      if (final.error.kind !== 'domain') return;
      const domainError = final.error.error;
      expect(domainError.code).toBe('RETRACTATION_PERIOD_ACTIVE');
      if (domainError.code !== 'RETRACTATION_PERIOD_ACTIVE') return;
      // Message honnête : pourquoi (délai légal), jusqu'à quand, ce qui reste possible.
      expect(domainError.message).toContain('L221-18');
      expect(domainError.message).toContain('rétractation');
      expect(domainError.message).toContain("L'acompte prévu au devis reste facturable");
      expect(domainError.availableFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(domainError.expiresAt > new Date().toISOString()).toBe(true);

      // L'ACOMPTE n'est jamais gelé (nuance L221-10 : l'interdiction d'encaissement ne vise que
      // le démarchage hors établissement pendant 7 jours — laissée à l'arbitrage juridique).
      const deposit = await service.generateInvoice({ quoteId, mode: 'deposit' });
      expect(deposit.ok).toBe(true);
    });
  });

  it('b2c avec exécution anticipée cochée à la signature : AUCUN gel, finale immédiate', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();
    const { quoteId, token } = await sentQuote(service, 'cust-durand');
    expect((await service.publicSignQuote(token, 'Mme Durand', undefined, true)).ok).toBe(true);

    await asOwner(async () => {
      const final = await service.generateInvoice({ quoteId, mode: 'final' });
      expect(final.ok).toBe(true);
    });
  });

  it('b2b : rien ne change — finale immédiate pendant les 14 jours', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();
    const { quoteId, token } = await sentQuote(service, 'cust-martin');
    expect((await service.publicSignQuote(token, 'M. Martin')).ok).toBe(true);

    await asOwner(async () => {
      const final = await service.generateInvoice({ quoteId, mode: 'final' });
      expect(final.ok).toBe(true);
    });
  });
});

describe('A3 — PDF du devis B2C : bloc d’information + formulaire détachable', () => {
  it('l’original archivé à la signature (A8) porte le bloc rétractation (b2c) — jamais pour un pro', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, renderedQuotes, service } = makeService();
    await persistence.seed();

    const b2c = await sentQuote(service, 'cust-durand');
    expect((await service.publicSignQuote(b2c.token, 'Mme Durand')).ok).toBe(true);
    const renderedB2c = renderedQuotes.at(-1);
    expect(renderedB2c?.retractation).not.toBeNull();
    expect(renderedB2c?.retractation?.noticeLines[0]).toBe('Droit de rétractation');
    // Formulaire détachable : modèle type annexe R221-1 (joint au contrat, L221-5/L221-9).
    expect(renderedB2c?.retractation?.formLines[0]).toBe('Formulaire de rétractation');
    expect(
      renderedB2c?.retractation?.formLines.some((l) => l.includes('(*) Rayez la mention inutile.')),
    ).toBe(true);

    const b2b = await sentQuote(service, 'cust-martin');
    expect((await service.publicSignQuote(b2b.token, 'M. Martin')).ok).toBe(true);
    expect(renderedQuotes.at(-1)?.retractation).toBeNull();
  });
});

/** Texte visible du PDF (flux Flate + chaînes hex WinAnsi) — même helper que les tests A1/A5. */
function pdfVisibleText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes);
  const chunks: string[] = [raw.toString('latin1')];
  let cursor = 0;
  for (;;) {
    const start = raw.indexOf('stream', cursor);
    if (start === -1) break;
    const dataStart = raw.indexOf('\n', start) + 1;
    const end = raw.indexOf('endstream', dataStart);
    if (dataStart === 0 || end === -1) break;
    try {
      chunks.push(inflateSync(raw.subarray(dataStart, end)).toString('latin1'));
    } catch {
      // Flux non compressé ou binaire — déjà couvert par le texte brut.
    }
    cursor = end + 'endstream'.length;
  }
  const joined = chunks.join('\n');
  const hexStrings = [...joined.matchAll(/<([0-9A-Fa-f\s]+)>/g)]
    .map((match) => Buffer.from((match[1] ?? '').replace(/\s+/g, ''), 'hex').toString('latin1'))
    .join('\n');
  return `${joined}\n${hexStrings}`;
}

describe('A3 — rendu pdf-lib réel du bloc rétractation', () => {
  const baseQuoteData: QuotePdfData = {
    number: 'D-2026-0044',
    companyName: 'Mercier Plomberie',
    companyAddress: '12 rue des Artisans, 92000 Nanterre',
    companyRcsOrRm: 'RM 92',
    customerName: 'Mme Durand',
    customerAddress: '12 rue des Lilas, 92310 Sèvres',
    validUntil: '2026-08-19',
    lines: [{ label: 'Remplacement chauffe-eau', qty: 1, unitPriceHT: 120_000, vatRate: 20 }],
    totals: { ht: 120_000, vat: 24_000, ttc: 144_000, netToPay: 144_000 },
    depositPct: null,
    signedBy: null,
    mentions: [],
  };

  it('b2c : avis d’information + formulaire détachable imprimés (texte réglementaire)', async () => {
    const bytes = await new PdfRenderer().renderQuote({
      ...baseQuoteData,
      retractation: {
        noticeLines: [
          'Droit de rétractation',
          'Vous avez le droit de vous rétracter du présent contrat sans donner de motif dans un délai de quatorze jours.',
          'Effets de rétractation',
          'En cas de rétractation de votre part du présent contrat, nous vous rembourserons tous les paiements reçus de vous sans retard excessif.',
        ],
        formLines: [
          'Formulaire de rétractation',
          '(Veuillez compléter et renvoyer le présent formulaire uniquement si vous souhaitez vous rétracter du contrat.)',
          "À l'attention de Mercier Plomberie, 12 rue des Artisans, 92000 Nanterre :",
          '(*) Rayez la mention inutile.',
        ],
      },
    });
    const text = pdfVisibleText(bytes);
    expect(text).toContain('Droit de r');
    expect(text).toContain('quatorze jours');
    expect(text).toContain('Effets de r');
    expect(text).toContain('Formulaire de r');
    expect(text).toContain('Rayez la mention inutile');
  });

  it('sans bloc (pro ou legacy) : rien d’imprimé, aucune page ajoutée', async () => {
    const bytes = await new PdfRenderer().renderQuote({ ...baseQuoteData, retractation: null });
    const text = pdfVisibleText(bytes);
    expect(text).not.toContain('Formulaire de r');
    expect(text).not.toContain('quatorze jours');
  });
});

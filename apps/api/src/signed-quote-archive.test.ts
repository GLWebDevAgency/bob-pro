import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { SignQuote } from '@bob/core';
import type { OcrPort, PaymentGatewayPort, PdfRendererPort, QuotePdfData } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { documentSha256 } from './documents/storage';
import { InMemoryDocumentStorage } from './documents/storage.testing';
import { renderPdfFixture } from './documents/pdf-fixtures.testing';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import { InMemoryPersistence } from './persistence/persistence.testing';

/**
 * A8 — archivage immuable du devis signé (le contrat).
 * Sources : art. L213-1 code conso (conservation 10 ans des contrats électroniques B2C ≥ 120 €) ;
 * valeur probante de l'écrit électronique, art. 1366-1367 code civil.
 * Doctrine : MÊME mécanique que l'original des factures émises — outbox durable dans la
 * transaction de signature, rendu + stockage après commit, service exclusif de l'octet archivé.
 */

const OWNER: Principal = { userId: 'owner-a8', companyId: MERCIER_PROPS.id };

afterEach(() => {
  vi.unstubAllEnvs();
});

function asOwner<T>(run: () => T): T {
  return requestContext.run({ correlationId: 'signed-quote-archive', principal: OWNER }, run);
}

function makeService() {
  const persistence = new InMemoryPersistence();
  const renderedQuotes: QuotePdfData[] = [];
  const renderer: PdfRendererPort = {
    renderInvoice: vi.fn(async (data, facturX) =>
      renderPdfFixture(`invoice:${data.number}`, facturX?.xml)),
    // Les octets encodent numéro + signataire + mentions : toute dérive de l'état courant
    // (médiateur, régime TVA…) produirait des octets DIFFÉRENTS — l'immutabilité est observable.
    renderQuote: vi.fn(async (data) => {
      renderedQuotes.push(structuredClone(data));
      return renderPdfFixture(
        `quote:${data.number}:${data.signedBy ?? 'non-signe'}:${data.mentions.join('|')}`,
      );
    }),
  };
  const notificationDelivery = {
    enqueue: vi.fn(async (input: { notification: unknown }) => ({
      id: 'notification-job-a8',
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
  return { logger, persistence, renderedQuotes, renderer, service, storage };
}

async function createSentQuote(
  service: BackendService,
  customerId: 'cust-durand' | 'cust-martin' = 'cust-durand',
): Promise<string> {
  const quote = await service.createQuote({
    customerId,
    lines: [
      {
        label: 'Remplacement chauffe-eau',
        category: 'labor',
        qty: 1,
        unitPriceHT: 150_000,
        vatRate: 20,
      },
    ],
  });
  if (!quote.ok) throw new Error('fixture: createQuote KO');
  const sent = await service.sendQuote(quote.value.quoteId);
  if (!sent.ok) throw new Error('fixture: sendQuote KO');
  return quote.value.quoteId;
}

async function signedQuoteArchive(persistence: InMemoryPersistence, quoteId: string) {
  const documents = await persistence.documents.findByEntity(MERCIER_PROPS.id, 'quote', quoteId);
  return documents.filter(
    (document) => document.kind === 'signed_quote' && document.status === 'active',
  );
}

async function drainArchive(service: BackendService, companyId?: string): Promise<void> {
  const run = await service.runDocumentArchiveJobs({ ...(companyId ? { companyId } : {}), limit: 50 });
  expect(run.ok).toBe(true);
  if (run.ok) expect(run.value.failed).toBe(0);
}

async function viewToken(service: BackendService, quoteId: string): Promise<string> {
  const link = await service.createQuoteViewLink(quoteId);
  if (!link.ok) throw new Error('fixture: createQuoteViewLink KO');
  return decodeURIComponent(link.value.viewUrl.split('/view/')[1]!);
}

/**
 * Fait avancer explicitement le harness au-delà du backoff d'un job échoué.
 *
 * Un nouvel `enqueue` avec la même clé métier ne doit jamais court-circuiter le calendrier de
 * retry : PostgreSQL conserve le premier ordre (ON CONFLICT DO NOTHING). Le test manipule donc
 * uniquement l'horloge persistée de l'adapter in-memory, comme le ferait le passage du temps en
 * production, sans changer l'identité ni le contenu de l'ordre durable.
 */
function expireArchiveBackoffForTesting(
  persistence: InMemoryPersistence,
  quoteId: string,
): void {
  const snapshot = persistence.documentArchiveJobs.snapshot();
  const matching = snapshot.filter(
    (job) =>
      job.companyId === MERCIER_PROPS.id
      && job.pieceId === quoteId
      && job.reason === 'quote-signed',
  );
  expect(matching).toHaveLength(1);
  persistence.documentArchiveJobs.restore(
    snapshot.map((job) =>
      job === matching[0]
        ? { ...job, nextAttemptAt: '1970-01-01T00:00:00.000Z' }
        : job,
    ),
  );
}

describe('A8 — signature sur place : le contrat est figé', () => {
  it('archive l’original à la signature (sha stable) puis le sert à l’identique malgré un changement ultérieur', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, renderer, service, storage } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      // Médiateur B2C posé AVANT signature : la mention s'imprime au rendu du devis (A2).
      const legal = await service.updateCompanyLegal({
        mediateurConso: { nom: 'CM2C', coordonnees: '14 rue Saint-Jean, 75017 Paris' },
      });
      expect(legal.ok).toBe(true);

      const quoteId = await createSentQuote(service);
      expect(await signedQuoteArchive(persistence, quoteId)).toHaveLength(0);

      const signed = await service.signQuote({ quoteId, signerName: 'Mme Durand' });
      expect(signed.ok).toBe(true);
      await drainArchive(service);

      // Archive présente : UN original actif, job d'archivage abouti.
      const archives = await signedQuoteArchive(persistence, quoteId);
      expect(archives).toHaveLength(1);
      const archive = archives[0]!.toProps();
      const job = await persistence.documentArchiveJobs.findByPiece(
        MERCIER_PROPS.id,
        quoteId,
        'quote-signed',
      );
      expect(job?.status).toBe('done');

      // Hash stable : le SHA-256 des métadonnées correspond EXACTEMENT aux octets stockés.
      const stored = await storage.get(MERCIER_PROPS.id, archive.storageKey);
      expect(stored).not.toBeNull();
      if (stored === null) return;
      expect(documentSha256(stored.bytes)).toBe(archive.sha256);
      expect(stored.bytes.byteLength).toBe(archive.byteSize);
      const originalPdf = await PDFDocument.load(stored.bytes);
      expect(originalPdf.getSubject()).toContain('Mme Durand');
      expect(originalPdf.getSubject()).toContain('CM2C');

      // L'archive est complète : la donnée peut évoluer pour les PROCHAINES pièces…
      const changed = await service.updateCompanyLegal({
        mediateurConso: { nom: 'MEDIATION PRO', coordonnees: '1 avenue Neuve, 75001 Paris' },
      });
      expect(changed.ok).toBe(true);

      // …mais toute consultation du devis signé sert l'octet archivé, jamais un re-rendu.
      const rendersBefore = vi.mocked(renderer.renderQuote).mock.calls.length;
      const pdf = await service.publicDocumentPdf(await viewToken(service, quoteId));
      expect(pdf.ok).toBe(true);
      if (!pdf.ok) return;
      expect(pdf.value).toEqual(stored.bytes);
      const servedPdf = await PDFDocument.load(pdf.value);
      expect(servedPdf.getSubject()).toContain('CM2C');
      expect(servedPdf.getSubject()).not.toContain('MEDIATION PRO');
      expect(vi.mocked(renderer.renderQuote).mock.calls.length).toBe(rendersBefore);
    });
  });

  it('un ré-enqueue après preuve ne réarme jamais le job ni ne crée un second original', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const quoteId = await createSentQuote(service);
      const signed = await service.signQuote({ quoteId, signerName: 'Mme Durand' });
      expect(signed.ok).toBe(true);
      await drainArchive(service);
      expect(await signedQuoteArchive(persistence, quoteId)).toHaveLength(1);
      const completed = await persistence.documentArchiveJobs.findByPiece(
        MERCIER_PROPS.id,
        quoteId,
        'quote-signed',
      );
      expect(completed?.integrityProof).not.toBeNull();

      // Un nouvel id de commande pour la même clé métier est un retry d'enqueue, pas une
      // autorisation de réexécuter une terminaison probante append-only.
      await persistence.documentArchiveJobs.enqueue({
        id: 'job-replay',
        companyId: MERCIER_PROPS.id,
        pieceId: quoteId,
        reason: 'quote-signed',
        now: new Date().toISOString(),
      });
      const run = await service.runDocumentArchiveJobs();
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(run.value).toEqual({ scanned: 0, archived: 0, failed: 0 });
      expect(await persistence.documentArchiveJobs.findByPiece(
        MERCIER_PROPS.id,
        quoteId,
        'quote-signed',
      )).toEqual(completed);
      expect(await signedQuoteArchive(persistence, quoteId)).toHaveLength(1);
    });
  });

  it('annule ENTIÈREMENT la signature si l’ordre durable d’archivage ne peut pas être écrit', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const quoteId = await createSentQuote(service);
      vi.spyOn(persistence.documentArchiveJobs, 'enqueue').mockRejectedValueOnce(
        new Error('postgres unavailable'),
      );

      const failed = await service.signQuote({ quoteId, signerName: 'Mme Durand' });
      expect(failed).toEqual({
        ok: false,
        error: {
          kind: 'dependency',
          port: 'document-archive-outbox',
          cause: 'postgres unavailable',
        },
      });
      // Rollback complet : devis non signé, aucun ordre, aucun original.
      expect((await persistence.quotes.findById(quoteId))?.signature).toBeNull();
      expect(
        await persistence.documentArchiveJobs.findByPiece(MERCIER_PROPS.id, quoteId, 'quote-signed'),
      ).toBeNull();
      expect(await signedQuoteArchive(persistence, quoteId)).toHaveLength(0);

      const retry = await service.signQuote({ quoteId, signerName: 'Mme Durand' });
      expect(retry.ok).toBe(true);
      await drainArchive(service);
      expect(await signedQuoteArchive(persistence, quoteId)).toHaveLength(1);
    });
  });
});

describe('A8 — worker d’archive : terminaison fenced et observable', () => {
  it('ne rend ni ne contacte Storage pendant une transaction tenant', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, renderer, service, storage } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      let tenantTransactionDepth = 0;
      const runWithTenant = persistence.runWithTenant.bind(persistence);
      vi.spyOn(persistence, 'runWithTenant').mockImplementation(async (companyId, operation) => {
        tenantTransactionDepth += 1;
        try {
          return await runWithTenant(companyId, operation);
        } finally {
          tenantTransactionDepth -= 1;
        }
      });
      const renderQuote = renderer.renderQuote.bind(renderer);
      vi.spyOn(renderer, 'renderQuote').mockImplementation(async (data) => {
        expect(tenantTransactionDepth).toBe(0);
        return renderQuote(data);
      });
      const put = storage.put.bind(storage);
      const get = storage.get.bind(storage);
      vi.spyOn(storage, 'put').mockImplementation(async (input) => {
        expect(tenantTransactionDepth).toBe(0);
        return put(input);
      });
      vi.spyOn(storage, 'get').mockImplementation(async (companyId, key) => {
        expect(tenantTransactionDepth).toBe(0);
        return get(companyId, key);
      });

      const quoteId = await createSentQuote(service);
      const signed = await service.signQuote({ quoteId, signerName: 'Mme Durand' });
      expect(signed.ok).toBe(true);
      const run = await service.runDocumentArchiveJobs();

      expect(run).toEqual({
        ok: true,
        value: { scanned: 1, archived: 1, failed: 0 },
      });
      expect(await signedQuoteArchive(persistence, quoteId)).toHaveLength(1);
    });
  });

  it('réarme immédiatement le job si sa preuve est générée mais refusée à la finalisation', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { logger, persistence, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const quoteId = await createSentQuote(service);
      const pausedWorker = vi.spyOn(service, 'runDocumentArchiveJobs').mockResolvedValueOnce({
        ok: true,
        value: { scanned: 0, archived: 0, failed: 0 },
      });
      const signed = await service.signQuote({ quoteId, signerName: 'Mme Durand' });
      expect(signed.ok).toBe(true);
      pausedWorker.mockRestore();

      vi.spyOn(persistence.documentArchiveJobs, 'markDone').mockResolvedValueOnce(false);
      const markFailed = vi.spyOn(persistence.documentArchiveJobs, 'markFailed');

      const run = await service.runDocumentArchiveJobs();

      expect(run).toEqual({
        ok: true,
        value: { scanned: 1, archived: 0, failed: 1 },
      });
      expect(markFailed).toHaveBeenCalledWith(
        expect.any(String),
        MERCIER_PROPS.id,
        expect.any(String),
        expect.any(String),
        expect.any(String),
        '[archive-completion-rejected-after-proof]',
      );
      expect(
        await persistence.documentArchiveJobs.findByPiece(
          MERCIER_PROPS.id,
          quoteId,
          'quote-signed',
        ),
      ).toMatchObject({
        status: 'failed',
        attempts: 1,
        leaseToken: null,
        lastError: '[archive-completion-rejected-after-proof]',
        integrityProof: null,
      });
      expect(logger.audit).toHaveBeenCalledWith(
        'document.archive_job.completion_rejected',
        expect.objectContaining({
          companyId: MERCIER_PROPS.id,
          pieceId: quoteId,
          reason: 'quote-signed',
          outcome: 'retry_scheduled',
        }),
      );
    });
  });

  it('ne compte pas un faux échec si un worker concurrent a déjà persisté la même preuve', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { logger, persistence, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const quoteId = await createSentQuote(service);
      const pausedWorker = vi.spyOn(service, 'runDocumentArchiveJobs').mockResolvedValueOnce({
        ok: true,
        value: { scanned: 0, archived: 0, failed: 0 },
      });
      const signed = await service.signQuote({ quoteId, signerName: 'Mme Durand' });
      expect(signed.ok).toBe(true);
      pausedWorker.mockRestore();

      const originalMarkDone = persistence.documentArchiveJobs.markDone.bind(
        persistence.documentArchiveJobs,
      );
      vi.spyOn(persistence.documentArchiveJobs, 'markDone').mockImplementationOnce(
        async (...args) => {
          // Simule précisément l'autre worker qui termine entre notre rendu et notre CAS :
          // l'état durable est `done`, mais notre appel observe un refus de fence.
          expect(await originalMarkDone(...args)).toBe(true);
          return false;
        },
      );
      const markFailed = vi.spyOn(persistence.documentArchiveJobs, 'markFailed');

      const run = await service.runDocumentArchiveJobs();

      expect(run).toEqual({
        ok: true,
        value: { scanned: 1, archived: 0, failed: 0 },
      });
      expect(markFailed).toHaveBeenCalledOnce();
      expect(
        await persistence.documentArchiveJobs.findByPiece(
          MERCIER_PROPS.id,
          quoteId,
          'quote-signed',
        ),
      ).toMatchObject({
        status: 'done',
        attempts: 0,
        leaseToken: null,
        lastError: null,
      });
      expect(logger.audit).toHaveBeenCalledWith(
        'document.archive_job.completion_cas_lost',
        expect.objectContaining({
          companyId: MERCIER_PROPS.id,
          pieceId: quoteId,
          reason: 'quote-signed',
          outcome: 'concurrent_completion_observed',
          currentStatus: 'done',
        }),
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  it('journalise explicitement un lease perdu sans preuve au lieu de disparaître silencieusement', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { logger, persistence, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const quoteId = await createSentQuote(service);
      const pausedWorker = vi.spyOn(service, 'runDocumentArchiveJobs').mockResolvedValueOnce({
        ok: true,
        value: { scanned: 0, archived: 0, failed: 0 },
      });
      const signed = await service.signQuote({ quoteId, signerName: 'Mme Durand' });
      expect(signed.ok).toBe(true);
      pausedWorker.mockRestore();

      vi.spyOn(persistence.documentArchiveJobs, 'markDone').mockResolvedValueOnce(false);
      vi.spyOn(persistence.documentArchiveJobs, 'markFailed').mockResolvedValueOnce(false);

      const run = await service.runDocumentArchiveJobs();

      expect(run).toEqual({
        ok: true,
        value: { scanned: 1, archived: 0, failed: 0 },
      });
      expect(logger.audit).toHaveBeenCalledWith(
        'document.archive_job.completion_cas_lost',
        expect.objectContaining({
          companyId: MERCIER_PROPS.id,
          pieceId: quoteId,
          reason: 'quote-signed',
          outcome: 'lease_lost_without_completion',
          currentStatus: 'pending',
          integrityProofSha256: null,
        }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('lease perdu sans preuve persistée'),
        'documents',
      );
    });
  });
});

describe('A8 — signature à distance (lien public tokenisé)', () => {
  it('archive l’original du contrat comme la signature sur place', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service, storage } = makeService();
    await persistence.seed();

    const { quoteId, token } = await asOwner(async () => {
      const id = await createSentQuote(service);
      const link = await service.createQuoteSignatureLink(id);
      if (!link.ok) throw new Error('fixture: createQuoteSignatureLink KO');
      return { quoteId: id, token: decodeURIComponent(link.value.signatureUrl.split('/sign/')[1]!) };
    });

    // La signature publique n'a AUCUN principal authentifié (client final sur son téléphone).
    const signed = await service.publicSignQuote(token, 'Mme Durand');
    expect(signed.ok).toBe(true);
    await drainArchive(service, MERCIER_PROPS.id);

    const archives = await signedQuoteArchive(persistence, quoteId);
    expect(archives).toHaveLength(1);
    const archive = archives[0]!.toProps();
    const stored = await storage.get(MERCIER_PROPS.id, archive.storageKey);
    expect(stored).not.toBeNull();
    if (stored === null) return;
    expect(documentSha256(stored.bytes)).toBe(archive.sha256);
    expect(
      (
        await persistence.documentArchiveJobs.findByPiece(MERCIER_PROPS.id, quoteId, 'quote-signed')
      )?.status,
    ).toBe('done');
  });
});

describe('A8 — devis non signé : jamais d’archive', () => {
  it('un devis envoyé reste rendu dynamiquement, sans document ni ordre d’archivage', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, renderer, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const quoteId = await createSentQuote(service);

      expect(await signedQuoteArchive(persistence, quoteId)).toHaveLength(0);
      expect(
        await persistence.documentArchiveJobs.findByPiece(MERCIER_PROPS.id, quoteId, 'quote-signed'),
      ).toBeNull();

      const pdf = await service.publicDocumentPdf(await viewToken(service, quoteId));
      expect(pdf.ok).toBe(true);
      expect(renderer.renderQuote).toHaveBeenCalledTimes(1);
      expect(await signedQuoteArchive(persistence, quoteId)).toHaveLength(0);
    });
  });
});

describe('A8 — barrière de complétude', () => {
  it('isole un snapshot scellé invalide et traite quand même le job suivant de la page', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      // Les kicks best-effort sont neutralisés : ce test exerce explicitement une seule page du
      // scheduler durable avec deux candidats présents avant le LIST.
      const kick = vi.spyOn(service, 'runDocumentArchiveJobs').mockResolvedValue({
        ok: true,
        value: { scanned: 0, archived: 0, failed: 0 },
      });
      const firstQuoteId = await createSentQuote(service);
      const secondQuoteId = await createSentQuote(service);
      expect((await service.signQuote({ quoteId: firstQuoteId, signerName: 'Mme Durand' })).ok)
        .toBe(true);
      expect((await service.signQuote({ quoteId: secondQuoteId, signerName: 'M. Martin' })).ok)
        .toBe(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      kick.mockRestore();

      const state = persistence.documentArchiveJobs.snapshotState();
      const first = state.jobs.find((job) => job.pieceId === firstQuoteId);
      expect(first?.renderSnapshot).not.toBeNull();
      persistence.documentArchiveJobs.restoreState({
        ...state,
        jobs: state.jobs.map((job) =>
          job.pieceId === firstQuoteId && job.renderSnapshot !== null
            ? {
                ...job,
                renderSnapshot: { ...job.renderSnapshot, json: '{}' },
              }
            : job),
      });

      await expect(service.runDocumentArchiveJobs({ limit: 10 })).resolves.toEqual({
        ok: true,
        value: { scanned: 2, archived: 1, failed: 1 },
      });
      expect(await signedQuoteArchive(persistence, firstQuoteId)).toHaveLength(0);
      expect(await signedQuoteArchive(persistence, secondQuoteId)).toHaveLength(1);
      expect(
        (
          await persistence.documentArchiveJobs.findByPiece(
            MERCIER_PROPS.id,
            firstQuoteId,
            'quote-signed',
          )
        )?.status,
      ).toBe('failed');
      expect(
        (
          await persistence.documentArchiveJobs.findByPiece(
            MERCIER_PROPS.id,
            secondQuoteId,
            'quote-signed',
          )
        )?.status,
      ).toBe('done');
    });
  });

  it('bloque les données relues au rendu tant que l’original du contrat n’est pas archivé, puis débloque', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, renderer, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const quoteId = await createSentQuote(service);
      // L'archivage inline échoue (rendu indisponible) : la signature reste acquise, l'ordre
      // durable reste en échec — c'est exactement la fenêtre que la barrière doit fermer.
      vi.mocked(renderer.renderQuote).mockRejectedValueOnce(new Error('renderer down'));
      const signed = await service.signQuote({ quoteId, signerName: 'Mme Durand' });
      expect(signed.ok).toBe(true);
      await expect(service.runDocumentArchiveJobs()).resolves.toEqual({
        ok: true,
        value: { scanned: 1, archived: 0, failed: 1 },
      });
      expect(
        (
          await persistence.documentArchiveJobs.findByPiece(
            MERCIER_PROPS.id,
            quoteId,
            'quote-signed',
          )
        )?.status,
      ).toBe('failed');
      expect(await signedQuoteArchive(persistence, quoteId)).toHaveLength(0);

      // Médiateur (imprimé sur le devis, A2) : bloqué.
      await expect(
        service.updateCompanyLegal({
          mediateurConso: { nom: 'MEDIATION PRO', coordonnees: '1 avenue Neuve, 75001 Paris' },
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'company_billing_settings',
          reason: 'signed_quote_archive_missing',
        },
      });
      // Régime de TVA (mention 293 B relue au rendu) : bloqué aussi.
      await expect(
        service.updateCompanyProfile({ trade: 'plombier', vatRegime: 'franchise' }),
      ).resolves.toEqual({
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'company_billing_settings',
          reason: 'signed_quote_archive_missing',
        },
      });

      // Le backoff interdit un rejeu immédiat ; après son expiration, le worker reprend le même
      // ordre durable, fige l'original et fait tomber la barrière.
      const beforeRetry = await service.runDocumentArchiveJobs();
      expect(beforeRetry).toEqual({
        ok: true,
        value: { scanned: 0, archived: 0, failed: 0 },
      });
      expireArchiveBackoffForTesting(persistence, quoteId);
      const run = await service.runDocumentArchiveJobs();
      expect(run.ok).toBe(true);
      expect(await signedQuoteArchive(persistence, quoteId)).toHaveLength(1);

      const unlocked = await service.updateCompanyLegal({
        mediateurConso: { nom: 'MEDIATION PRO', coordonnees: '1 avenue Neuve, 75001 Paris' },
      });
      expect(unlocked.ok).toBe(true);
    });
  });

  it('accent PDF (relu au rendu du devis depuis la refonte) : bloqué pendant la fenêtre, précis, puis débloqué', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, renderer, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const quoteId = await createSentQuote(service);
      vi.mocked(renderer.renderQuote).mockRejectedValueOnce(new Error('renderer down'));
      const signed = await service.signQuote({ quoteId, signerName: 'Mme Durand' });
      expect(signed.ok).toBe(true);
      await expect(service.runDocumentArchiveJobs()).resolves.toEqual({
        ok: true,
        value: { scanned: 1, archived: 0, failed: 1 },
      });
      expect(await signedQuoteArchive(persistence, quoteId)).toHaveLength(0);

      const settings = await service.getCompanyBillingSettings();
      expect(settings.ok).toBe(true);
      if (!settings.ok) return;

      // pdfAccentColor est désormais imprimé sur le DEVIS (quotePdfData) : le changer pendant
      // la fenêtre signature→archive fabriquerait une archive ≠ du contrat signé — 409.
      await expect(
        service.updateCompanyBillingSettings({
          expectedRevision: settings.value.revision,
          patch: { pdfAccentColor: 'green' },
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          kind: 'conflict',
          entity: 'company_billing_settings',
          reason: 'signed_quote_archive_missing',
        },
      });

      // Barrière PRÉCISE : un réglage qui n'est relu par AUCUNE pièce archivée passe.
      const neutral = await service.updateCompanyBillingSettings({
        expectedRevision: settings.value.revision,
        patch: { defaultQuoteValidityDays: 45 },
      });
      expect(neutral.ok).toBe(true);
      if (!neutral.ok) return;

      // À l'expiration du backoff, le même ordre est repris : la barrière tombe et la couleur
      // peut changer (forward-only — l'original reste servi octet à octet).
      const beforeRetry = await service.runDocumentArchiveJobs();
      expect(beforeRetry).toEqual({
        ok: true,
        value: { scanned: 0, archived: 0, failed: 0 },
      });
      expireArchiveBackoffForTesting(persistence, quoteId);
      const run = await service.runDocumentArchiveJobs();
      expect(run.ok).toBe(true);
      expect(await signedQuoteArchive(persistence, quoteId)).toHaveLength(1);

      const unlocked = await service.updateCompanyBillingSettings({
        expectedRevision: neutral.value.revision,
        patch: { pdfAccentColor: 'green' },
      });
      expect(unlocked.ok).toBe(true);
    });
  });
});

describe('A8 — fail-closed : archive corrompue, ambiguë ou absente', () => {
  it('refuse de servir autre chose que l’octet exact archivé — jamais de régénération', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, renderer, service, storage } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const quoteId = await createSentQuote(service);
      const signed = await service.signQuote({ quoteId, signerName: 'Mme Durand' });
      expect(signed.ok).toBe(true);
      await drainArchive(service);
      const archive = (await signedQuoteArchive(persistence, quoteId))[0]!.toProps();
      const original = await storage.get(MERCIER_PROPS.id, archive.storageKey);
      expect(original).not.toBeNull();
      if (original === null) return;
      const token = await viewToken(service, quoteId);
      const rendersAfterSignature = vi.mocked(renderer.renderQuote).mock.calls.length;

      // Octets altérés à taille identique : le contrôle SHA refuse l'objet.
      const corrupted = new Uint8Array(original.bytes);
      corrupted[corrupted.length - 1] = (corrupted.at(-1) ?? 0) ^ 1;
      await storage.remove(MERCIER_PROPS.id, archive.storageKey);
      await storage.put({
        companyId: MERCIER_PROPS.id,
        key: archive.storageKey,
        bytes: corrupted,
        contentType: 'application/pdf',
      });
      await expect(service.publicDocumentPdf(token)).resolves.toEqual({
        ok: false,
        error: { kind: 'unavailable', service: 'signed-quote-archive' },
      });

      // Objet absent : indisponibilité, jamais un re-rendu opportuniste de l'état courant.
      await storage.remove(MERCIER_PROPS.id, archive.storageKey);
      await expect(service.publicDocumentPdf(token)).resolves.toEqual({
        ok: false,
        error: { kind: 'unavailable', service: 'signed-quote-archive' },
      });

      // Objet restauré : le service reprend, à l'identique.
      await storage.put({
        companyId: MERCIER_PROPS.id,
        key: archive.storageKey,
        bytes: original.bytes,
        contentType: 'application/pdf',
      });
      const restored = await service.publicDocumentPdf(token);
      expect(restored.ok).toBe(true);
      if (restored.ok) expect(restored.value).toEqual(original.bytes);

      // Deux originaux actifs pour le même devis : ambiguïté refusée, jamais un choix arbitraire.
      const duplicate = await service.uploadDocument({
        contentBase64: Buffer.from(original.bytes).toString('base64'),
        mimeType: 'application/pdf',
        filename: 'copie-devis-signe.pdf',
        kind: 'signed_quote',
        linkedEntityType: 'quote',
        linkedEntityId: quoteId,
      });
      expect(duplicate.ok).toBe(true);
      await expect(service.publicDocumentPdf(token)).resolves.toEqual({
        ok: false,
        error: { kind: 'unavailable', service: 'signed-quote-archive' },
      });

      // Aucun de ces refus n'a déclenché de rendu dynamique.
      expect(vi.mocked(renderer.renderQuote).mock.calls.length).toBe(rendersAfterSignature);
    });
  });
});

describe('A8 — devis signés AVANT la mécanique d’archivage (legacy)', () => {
  it('sans ordre d’archivage : rendu dynamique honnête, jamais de rétro-génération d’un faux original', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, renderer, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const quoteId = await createSentQuote(service);
      // Signature pré-A8 simulée : le use case domaine signe SANS outbox d'archivage.
      const signed = await new SignQuote({
        companies: persistence.companies,
        customers: persistence.customers,
        quotes: persistence.quotes,
        publicAccessTokens: persistence.publicAccessTokens,
        uow: persistence,
        clock: { now: () => new Date().toISOString(), today: () => '2026-07-19' },
      }).execute({ quoteId, signerName: 'Client Historique' });
      expect(signed.ok).toBe(true);
      expect(
        await persistence.documentArchiveJobs.findByPiece(MERCIER_PROPS.id, quoteId, 'quote-signed'),
      ).toBeNull();

      const rendersBefore = vi.mocked(renderer.renderQuote).mock.calls.length;
      const pdf = await service.publicDocumentPdf(await viewToken(service, quoteId));
      expect(pdf.ok).toBe(true);
      expect(vi.mocked(renderer.renderQuote).mock.calls.length).toBe(rendersBefore + 1);
      // Toujours aucune archive : la consultation ne fabrique jamais un original rétroactif.
      expect(await signedQuoteArchive(persistence, quoteId)).toHaveLength(0);
    });
  });
});

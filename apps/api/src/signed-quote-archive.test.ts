import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignQuote } from '@bob/core';
import type { OcrPort, PaymentGatewayPort, PdfRendererPort, QuotePdfData } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { documentSha256 } from './documents/storage';
import { InMemoryDocumentStorage } from './documents/storage.testing';
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
    renderInvoice: vi.fn(async (data) =>
      new TextEncoder().encode(`%PDF-1.7\ninvoice:${data.number}`),
    ),
    // Les octets encodent numéro + signataire + mentions : toute dérive de l'état courant
    // (médiateur, régime TVA…) produirait des octets DIFFÉRENTS — l'immutabilité est observable.
    renderQuote: vi.fn(async (data) => {
      renderedQuotes.push(structuredClone(data));
      return new TextEncoder().encode(
        `%PDF-1.7\nquote:${data.number}:${data.signedBy ?? 'non-signe'}:${data.mentions.join('|')}`,
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
  return { persistence, renderedQuotes, renderer, service, storage };
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

async function viewToken(service: BackendService, quoteId: string): Promise<string> {
  const link = await service.createQuoteViewLink(quoteId);
  if (!link.ok) throw new Error('fixture: createQuoteViewLink KO');
  return decodeURIComponent(link.value.viewUrl.split('/view/')[1]!);
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
      const originalText = new TextDecoder().decode(stored.bytes);
      expect(originalText).toContain('Mme Durand');
      expect(originalText).toContain('CM2C');

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
      const servedText = new TextDecoder().decode(pdf.value);
      expect(servedText).toContain('CM2C');
      expect(servedText).not.toContain('MEDIATION PRO');
      expect(vi.mocked(renderer.renderQuote).mock.calls.length).toBe(rendersBefore);
    });
  });

  it('rejoue l’archivage sans jamais créer un second original (idempotence du job)', async () => {
    vi.stubEnv('SIGN_WEB_BASE_URL', 'https://signature.example.test');
    const { persistence, service } = makeService();
    await persistence.seed();

    await asOwner(async () => {
      const quoteId = await createSentQuote(service);
      const signed = await service.signQuote({ quoteId, signerName: 'Mme Durand' });
      expect(signed.ok).toBe(true);
      expect(await signedQuoteArchive(persistence, quoteId)).toHaveLength(1);

      // Rejouer un ordre (reprise worker) : l'original existant est conservé tel quel.
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
      expect(run.value.failed).toBe(0);
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
      expect(await signedQuoteArchive(persistence, quoteId)).toHaveLength(1);
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

      // Réparation : l'ordre est rejoué (worker/cron), l'original est figé, la barrière tombe.
      await persistence.documentArchiveJobs.enqueue({
        id: 'job-repair',
        companyId: MERCIER_PROPS.id,
        pieceId: quoteId,
        reason: 'quote-signed',
        now: new Date().toISOString(),
      });
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

      // Réparation de l'archive : la barrière tombe, la couleur peut changer (forward-only —
      // le contrat archivé reste servi octet à octet, cf. test « le contrat est figé »).
      await persistence.documentArchiveJobs.enqueue({
        id: 'job-repair-accent',
        companyId: MERCIER_PROPS.id,
        pieceId: quoteId,
        reason: 'quote-signed',
        now: new Date().toISOString(),
      });
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

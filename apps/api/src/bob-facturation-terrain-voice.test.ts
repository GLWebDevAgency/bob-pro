import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OcrPort, PaymentGatewayPort, PdfRendererPort } from '@bob/core';
import { STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE } from '@bob/core';
import { MERCIER_PROPS } from '@bob/core/testing';
import { BackendService } from './backend.service';
import { InMemoryPersistence } from './persistence/persistence.testing';
import { requestContext, type AppLogger, type Principal } from './observability/logger';
import type { SupabaseAdminPort } from './auth/supabase-admin';
import type { NotificationDeliveryService } from './jobs/notification-delivery.service';
import type { Metrics } from './observability/metrics';
import { InMemoryDocumentStorage } from './documents/storage.testing';

/**
 * B1/B2/B4 — PARITÉ VOCALE de la facturation terrain, HÔTE RÉEL (buildBobActions → use cases
 * core) : facture directe dictée (ComposeStandaloneInvoice), situation de travaux
 * (GenerateInvoiceFromQuote mode 'situation', garde de cumul restituée VERBATIM), conditions
 * de paiement client (UpdateCustomer). La confirmation passe par la proposition serveur opaque
 * (/ai/confirm) — MÊMES cartes et MÊMES refus honnêtes que BobAgent.confirm local.
 */

const MERCIER: Principal = { userId: 'u-mercier', companyId: MERCIER_PROPS.id };

beforeEach(() => {
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
      id: 'job-terrain-voice',
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
      renderInvoice: vi.fn(async () => new TextEncoder().encode('%PDF-1.7\ninvoice')),
      renderQuote: vi.fn(async () => new TextEncoder().encode('%PDF-1.7\nquote')),
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
  return requestContext.run({ correlationId: 'bob-terrain-voice', principal: MERCIER }, run);
}

describe('B1 — facture_directe à la voix (hôte réel → ComposeStandaloneInvoice)', () => {
  it('b2b : « facture 500 € HT à Kerbrat… » propose, la confirmation opaque crée le brouillon STANDALONE (totaux du domaine)', async () => {
    const { service, p, audit } = makeService();
    await p.seed();
    await asMercier(async () => {
      const kerbrat = await service.createCustomer({
        name: 'Kerbrat SARL',
        type: 'b2b',
        address: { line1: '4 rue du Port', zip: '29200', city: 'Brest' },
      });
      expect(kerbrat.ok).toBe(true);
      if (!kerbrat.ok) return;

      const proposed = await service.askBob(
        'Facture 500 € HT à Kerbrat pour la maintenance de la chaufferie (TVA 20 %)',
      );
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      expect(proposed.value.kind).toBe('proposed');
      expect(proposed.value.intent).toBe('facture_directe');
      expect(proposed.value.pending?.tool).toBe('facture_directe');
      expect(proposed.value.pending?.args).toMatchObject({
        customerId: kerbrat.value.id,
        lines: [
          {
            label: 'Maintenance de la chaufferie',
            category: 'labor',
            qty: 1,
            unitPriceHT: 50000,
            vatRate: 20,
          },
        ],
      });
      // Rien n'est créé avant la confirmation.
      const before = await p.invoices.listByCompany(MERCIER_PROPS.id);
      const confirmed = await service.confirmBob({ proposalId: proposed.value.pending?.proposalId });
      expect(confirmed.ok).toBe(true);
      if (!confirmed.ok) return;
      expect(confirmed.value.kind).toBe('done');
      expect(confirmed.value.intent).toBe('facture_directe');
      expect(confirmed.value.card.title).toBe('Facture directe créée ✓');
      // Le total annoncé est CELUI du domaine (500 € HT + 20 % = 600 € TTC).
      expect(confirmed.value.card.body).toContain('600,00');

      const after = await p.invoices.listByCompany(MERCIER_PROPS.id);
      const created = after.find((invoice) => !before.some((existing) => existing.id === invoice.id));
      expect(created).toBeDefined();
      expect(created?.kind).toBe('final');
      expect(created?.status).toBe('draft');
      expect(created?.parentQuoteId).toBeNull();
      expect(created?.totals().ttc).toBe(60000);
      expect(audit).toHaveBeenCalledWith(
        'invoice.standalone_composed',
        expect.objectContaining({ customerId: kerbrat.value.id, urgentOnSiteRepair: false }),
      );
    });
  });

  it('b2c SANS urgence : refus HONNÊTE (message du domaine verbatim), aucune facture créée', async () => {
    const { service, p, audit } = makeService();
    await p.seed();
    await asMercier(async () => {
      const quiviger = await service.createCustomer({
        name: 'Mme Quiviger',
        type: 'b2c',
        address: { line1: '9 rue Haute', zip: '29200', city: 'Brest' },
      });
      expect(quiviger.ok).toBe(true);
      if (!quiviger.ok) return;
      const before = await p.invoices.listByCompany(MERCIER_PROPS.id);

      const r = await service.askBob(
        'Facture 380 € TTC à Quiviger pour dépannage de la chaudière (TVA 20 %) — sans urgence',
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.kind).toBe('answer');
      expect(r.value.card.body).toBe(STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE);

      const after = await p.invoices.listByCompany(MERCIER_PROPS.id);
      expect(after).toHaveLength(before.length);
      expect(audit).not.toHaveBeenCalledWith('invoice.standalone_composed', expect.anything());
    });
  });

  it('b2c URGENCE dite : la qualification A3bis traverse jusqu’au use case (fait tracé, audité)', async () => {
    const { service, p, audit } = makeService();
    await p.seed();
    await asMercier(async () => {
      const quiviger = await service.createCustomer({
        name: 'Mme Quiviger',
        type: 'b2c',
        address: { line1: '9 rue Haute', zip: '29200', city: 'Brest' },
      });
      expect(quiviger.ok).toBe(true);
      if (!quiviger.ok) return;

      const proposed = await service.askBob(
        'Facture 380 € TTC à Quiviger pour dépannage de la chaudière (TVA 20 %, intervention urgente demandée par le client)',
      );
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      expect(proposed.value.kind).toBe('proposed');
      expect(proposed.value.pending?.args).toMatchObject({ urgentOnSiteRepair: true });
      const confirmed = await service.confirmBob({ proposalId: proposed.value.pending?.proposalId });
      expect(confirmed.ok).toBe(true);
      expect(audit).toHaveBeenCalledWith(
        'invoice.standalone_composed',
        expect.objectContaining({ urgentOnSiteRepair: true }),
      );
    });
  });
});

describe('B2 — facturer_situation à la voix (hôte réel → GenerateInvoiceFromQuote mode situation)', () => {
  /** Devis RÉEL signé d'un client pro créé pour l'occasion (b2b : aucun gel de rétractation). */
  async function signedKerbratQuote(service: BackendService): Promise<{ quoteId: string; number: string }> {
    const customer = await service.createCustomer({
      name: 'Kerbrat SARL',
      type: 'b2b',
      address: { line1: '4 rue du Port', zip: '29200', city: 'Brest' },
    });
    if (!customer.ok) throw new Error('fixage du décor : createCustomer KO');
    const quote = await service.createQuote({
      customerId: customer.value.id,
      lines: [
        { label: 'Rénovation chaufferie', category: 'labor', qty: 1, unitPriceHT: 1_000_000, vatRate: 20 },
      ],
    });
    if (!quote.ok) throw new Error('fixage du décor : createQuote KO');
    const sent = await service.sendQuote(quote.value.quoteId);
    if (!sent.ok) throw new Error('fixage du décor : sendQuote KO');
    const signed = await service.signQuote({ quoteId: quote.value.quoteId, signerName: 'M. Kerbrat' });
    if (!signed.ok) throw new Error('fixage du décor : signQuote KO');
    return { quoteId: quote.value.quoteId, number: sent.value.number };
  }

  it('« situation de 40 % » : propose, la confirmation crée la situation n° 1 ; le CUMUL dépassé est restitué VERBATIM ensuite', async () => {
    const { service, p, audit } = makeService();
    await p.seed();
    await asMercier(async () => {
      const { quoteId, number } = await signedKerbratQuote(service);

      const proposed = await service.askBob(`Facture une situation de 40 % sur le devis ${number}`);
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      expect(proposed.value.kind).toBe('proposed');
      expect(proposed.value.intent).toBe('facturer_situation');
      expect(proposed.value.pending?.tool).toBe('facturer_situation');
      expect(proposed.value.pending?.args).toMatchObject({ quoteId, situation: { percent: 40 } });

      const confirmed = await service.confirmBob({ proposalId: proposed.value.pending?.proposalId });
      expect(confirmed.ok).toBe(true);
      if (!confirmed.ok) return;
      expect(confirmed.value.kind).toBe('done');
      expect(confirmed.value.card.title).toBe('Situation générée ✓');
      const invoices = await p.invoices.listByCompany(MERCIER_PROPS.id);
      const situation = invoices.find((i) => i.parentQuoteId === quoteId && i.kind === 'situation');
      expect(situation).toBeDefined();
      expect(situation?.situationOrder).toBe(1);
      // 40 % du marché HT (1 000 000) → 400 000 HT.
      expect(situation?.totals().ht).toBe(400000);
      expect(audit).toHaveBeenCalledWith(
        'invoice.situation_generated',
        expect.objectContaining({ quoteId }),
      );

      // Situation 1 ÉMISE (le brouillon réserve déjà sa part — on émet pour le réalisme du flux).
      // Puis 80 % : 40 + 80 > 100 → la garde de CUMUL du domaine refuse ; le message est
      // restitué VERBATIM à la confirmation (mêmes mots que l'UI), rien n'est créé.
      const over = await service.askBob(`Facture une situation de 80 % sur le devis ${number}`);
      expect(over.ok).toBe(true);
      if (!over.ok) return;
      expect(over.value.kind).toBe('proposed');
      const refused = await service.confirmBob({ proposalId: over.value.pending?.proposalId });
      expect(refused.ok).toBe(true);
      if (!refused.ok) return;
      expect(refused.value.kind).toBe('answer');
      expect(refused.value.card.title).toBe('Refusé — rien n’a été modifié');
      expect(refused.value.card.body).toContain('Cumul acompte + situations supérieur au marché');
      const afterRefusal = await p.invoices.listByCompany(MERCIER_PROPS.id);
      expect(afterRefusal.filter((i) => i.parentQuoteId === quoteId && i.kind === 'situation')).toHaveLength(1);
    });
  });
});

describe('BT-23 — émission vocale verticale sur l’hôte serveur réel', () => {
  it('facture mixte : demande le fait, le conserve dans la proposition opaque et fige S1', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asMercier(async () => {
      const customer = await service.createCustomer({
        name: 'Atelier Kerbrat SARL',
        type: 'b2b',
        siren: '732829320',
        address: { line1: '4 rue du Port', zip: '29200', city: 'Brest' },
      });
      expect(customer.ok).toBe(true);
      if (!customer.ok) return;
      const quote = await service.createQuote({
        customerId: customer.value.id,
        lines: [
          {
            label: 'Pose du chauffe-eau', category: 'labor', qty: 2,
            unitPriceHT: 5500, vatRate: 20,
          },
          {
            label: 'Chauffe-eau 200 litres', category: 'supply', qty: 1,
            unitPriceHT: 80000, vatRate: 20,
          },
        ],
      });
      if (!quote.ok) throw new Error('create quote');
      expect((await service.sendQuote(quote.value.quoteId)).ok).toBe(true);
      expect((await service.signQuote({
        quoteId: quote.value.quoteId,
        signerName: 'Mme Kerbrat',
      })).ok).toBe(true);
      const generated = await service.generateInvoice({
        quoteId: quote.value.quoteId,
        mode: 'final',
      });
      if (!generated.ok) throw new Error('generate invoice');
      const bobLists = (
        service as unknown as {
          buildBobActions(): {
            listIssuableInvoices(): Promise<{
              ok: true;
              value: { id: string; operationCategoryRequired: boolean }[];
            }>;
          };
        }
      ).buildBobActions();
      const candidates = await bobLists.listIssuableInvoices();
      expect(
        candidates.ok
          ? candidates.value.find((invoice) => invoice.id === generated.value.invoiceId)
          : null,
      ).toMatchObject({ operationCategoryRequired: true });

      const question = await service.askBob(
        `Émets la facture ${generated.value.invoiceId}`,
      );
      expect(question.ok && question.value.kind).toBe('answer');
      expect(question.ok && question.value.ask?.[0]?.id).toBe(
        'emettre_facture.operationCategory',
      );
      const followUp = question.ok
        ? question.value.ask?.[0]?.options.find((option) => option.value === 'services')?.followUp
        : undefined;
      if (!followUp) throw new Error('BT-23 follow-up');

      const proposed = await service.askBob(followUp);
      expect(proposed.ok && proposed.value.kind).toBe('proposed');
      expect(proposed.ok && proposed.value.pending?.args).toMatchObject({
        invoiceId: generated.value.invoiceId,
        operationCategory: 'services',
      });
      if (!proposed.ok || !proposed.value.pending?.proposalId) throw new Error('proposal');

      const confirmed = await service.confirmBob({
        proposalId: proposed.value.pending.proposalId,
      });
      expect(confirmed.ok && confirmed.value.kind).toBe('done');
      const persisted = await p.invoices.findById(generated.value.invoiceId);
      expect(persisted?.status).toBe('issued');
      expect(persisted?.frenchBillingModeAtIssuance).toBe('S1');
    });
  });
});

describe('B4 — definir_conditions_paiement à la voix (hôte réel → UpdateCustomer)', () => {
  it('« Kerbrat paie à 45 jours fin de mois » : propose, la confirmation pose Customer.paymentTerms (fiche relue à l’identique)', async () => {
    const { service, p, audit } = makeService();
    await p.seed();
    await asMercier(async () => {
      const kerbrat = await service.createCustomer({
        name: 'Kerbrat SARL',
        type: 'b2b',
        address: { line1: '4 rue du Port', zip: '29200', city: 'Brest' },
      });
      expect(kerbrat.ok).toBe(true);
      if (!kerbrat.ok) return;

      const proposed = await service.askBob('Le client Kerbrat paie à 45 jours fin de mois');
      expect(proposed.ok).toBe(true);
      if (!proposed.ok) return;
      expect(proposed.value.kind).toBe('proposed');
      expect(proposed.value.intent).toBe('conditions_paiement');
      expect(proposed.value.pending?.tool).toBe('definir_conditions_paiement');
      expect(proposed.value.pending?.args).toEqual({
        customerId: kerbrat.value.id,
        days: 45,
        endOfMonth: true,
        label: '45 jours fin de mois',
      });

      const confirmed = await service.confirmBob({ proposalId: proposed.value.pending?.proposalId });
      expect(confirmed.ok).toBe(true);
      if (!confirmed.ok) return;
      expect(confirmed.value.kind).toBe('done');
      expect(confirmed.value.card.title).toBe('Conditions enregistrées ✓');
      const updated = await p.customers.findById(kerbrat.value.id);
      expect(updated?.paymentTerms).toEqual({ days: 45, endOfMonth: true, label: '45 jours fin de mois' });
      // La fiche est RELUE puis réécrite : le nom et l'adresse restent identiques.
      expect(updated?.name).toBe('Kerbrat SARL');
      expect(updated?.address.city).toBe('Brest');
      expect(audit).toHaveBeenCalledWith(
        'customer.updated',
        expect.objectContaining({ id: kerbrat.value.id }),
      );
    });
  });

  it('plafond L441-10 (pro, 90 jours) : refus AVANT toute proposition — la fiche ne bouge pas', async () => {
    const { service, p } = makeService();
    await p.seed();
    await asMercier(async () => {
      const kerbrat = await service.createCustomer({
        name: 'Kerbrat SARL',
        type: 'b2b',
        address: { line1: '4 rue du Port', zip: '29200', city: 'Brest' },
      });
      expect(kerbrat.ok).toBe(true);
      if (!kerbrat.ok) return;

      const r = await service.askBob('Kerbrat paie à 90 jours');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.kind).toBe('answer');
      expect(r.value.card.title).toBe('Refusé — rien n’a été modifié');
      expect(r.value.card.body).toContain('L441-10');
      const untouched = await p.customers.findById(kerbrat.value.id);
      expect(untouched?.paymentTerms).toBeUndefined();
    });
  });
});

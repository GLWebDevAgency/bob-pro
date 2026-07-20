import { describe, expect, it } from 'vitest';
import { STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE } from '@bob/core';
import { LocalBobClient } from './local-client';
import { FixtureClock } from './in-memory/services';

/**
 * ÉPIC « facturation terrain » — PARITÉ du client local (démo/offline) : mêmes use cases core
 * que l'API pour la facture directe (B1), les situations de travaux (B2) et le suivi de
 * transmission — un écran branché sur le client local se comporte comme sur le serveur.
 */

function makeClient(): LocalBobClient {
  return new LocalBobClient({ clock: new FixtureClock('2026-06-01') });
}

describe('B1 — composeStandaloneInvoice (facture directe)', () => {
  it('B2B : brouillon composé avec remises B3, totaux nets, puis visible via getInvoice', async () => {
    const client = makeClient();
    const r = await client.composeStandaloneInvoice({
      customerId: 'cust-martin',
      lines: [
        {
          label: 'Régie juin — 5 jours',
          category: 'labor',
          qty: 5,
          unitPriceHT: 60_000,
          vatRate: 20,
          discount: { type: 'percent', value: 10 },
        },
      ],
      globalDiscount: { type: 'amount', cents: 20_000 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 300 000 − 10 % = 270 000 ; − 20 000 global = 250 000 HT net ; TVA 20 % = 50 000.
    expect(r.value.totals).toMatchObject({
      grossHt: 300_000,
      discountCents: 50_000,
      ht: 250_000,
      vat: 50_000,
      ttc: 300_000,
    });
    const view = await client.getInvoice(r.value.invoiceId);
    expect(view.ok && view.value).toMatchObject({
      kind: 'final',
      status: 'draft',
      parentQuoteId: null,
      globalDiscount: { type: 'amount', cents: 20_000 },
      urgentRepair: null,
    });
  });

  it('B2C SANS urgence tracée : refus fail-closed avec le message source unique', async () => {
    const client = makeClient();
    const r = await client.composeStandaloneInvoice({
      customerId: 'cust-bernard',
      lines: [{ label: 'Dépannage', category: 'labor', qty: 1, unitPriceHT: 12_000, vatRate: 10 }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r.error)).toContain(STANDALONE_B2C_REQUIRES_URGENT_REPAIR_MESSAGE.slice(0, 40));
  });

  it('B2C avec urgence : fait horodaté à la composition, exposé par la vue', async () => {
    const client = makeClient();
    const r = await client.composeStandaloneInvoice({
      customerId: 'cust-bernard',
      lines: [{ label: 'Fuite — intervention immédiate', category: 'labor', qty: 1, unitPriceHT: 18_000, vatRate: 10 }],
      // Taux réduit 10 % : éligibilité travaux (logement > 2 ans) — même contexte que CreateQuote.
      context: { housingOlderThan2y: true },
      urgentOnSiteRepair: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const view = await client.getInvoice(r.value.invoiceId);
    expect(view.ok && view.value.urgentRepair).not.toBeNull();
  });
});

describe('B2 — generateInvoice mode situation', () => {
  async function signedB2bQuote(client: LocalBobClient): Promise<string> {
    const created = await client.createQuote({
      customerId: 'cust-lefevre',
      lines: [
        { label: 'Rénovation fournil — gros œuvre', category: 'labor', qty: 1, unitPriceHT: 600_000, vatRate: 20 },
        { label: 'Fournitures', category: 'supply', qty: 1, unitPriceHT: 400_000, vatRate: 20 },
      ],
    });
    if (!created.ok) throw new Error('createQuote failed');
    const quoteId = created.value.quoteId;
    const sent = await client.sendQuote(quoteId);
    if (!sent.ok) throw new Error('sendQuote failed');
    const signed = await client.signQuote({ quoteId, signerName: 'Boulangerie Lefèvre' });
    if (!signed.ok) throw new Error('signQuote failed');
    return quoteId;
  }

  it('deux situations successives (n° 1 puis n° 2), lignes = prorata, retenue absente sans stipulation', async () => {
    const client = makeClient();
    const quoteId = await signedB2bQuote(client);
    const s1 = await client.generateInvoice({ quoteId, mode: 'situation', situation: { percent: 30 } });
    expect(s1.ok).toBe(true);
    if (!s1.ok) return;
    const v1 = await client.getInvoice(s1.value.invoiceId);
    expect(v1.ok && v1.value).toMatchObject({ kind: 'situation', situationOrder: 1 });
    // 30 % de 1 000 000 HT = 300 000 HT, TVA 20 % → TTC 360 000, net à payer = TTC (pas de retenue).
    expect(v1.ok && v1.value.totals).toMatchObject({ ht: 300_000, ttc: 360_000, netToPay: 360_000 });

    const s2 = await client.generateInvoice({
      quoteId,
      mode: 'situation',
      situation: { amountHtCents: 200_000 },
    });
    expect(s2.ok).toBe(true);
    if (!s2.ok) return;
    const v2 = await client.getInvoice(s2.value.invoiceId);
    expect(v2.ok && v2.value).toMatchObject({ kind: 'situation', situationOrder: 2 });
  });

  it('garde de cumul : une situation au-delà du marché est refusée avec le reste facturable', async () => {
    const client = makeClient();
    const quoteId = await signedB2bQuote(client);
    const s1 = await client.generateInvoice({ quoteId, mode: 'situation', situation: { percent: 80 } });
    expect(s1.ok).toBe(true);
    const s2 = await client.generateInvoice({ quoteId, mode: 'situation', situation: { percent: 30 } });
    expect(s2.ok).toBe(false);
    if (s2.ok) return;
    expect(JSON.stringify(s2.error)).toContain('reste facturable');
  });

  it('aperçu de finale couverte à 100 % : aucune écriture artificielle, comme sur le serveur', async () => {
    const client = makeClient();
    const quoteId = await signedB2bQuote(client);
    const situation = await client.generateInvoice({
      quoteId,
      mode: 'situation',
      situation: { percent: 100 },
    });
    expect(situation.ok).toBe(true);
    if (!situation.ok) return;
    const issued = await client.issueInvoice({ invoiceId: situation.value.invoiceId });
    expect(issued.ok).toBe(true);

    const final = await client.generateInvoice({ quoteId, mode: 'final' });
    expect(final.ok).toBe(true);
    if (!final.ok) return;
    const preview = await client.invoiceAccountingPreview(final.value.invoiceId);

    expect(preview).toEqual({
      ok: true,
      value: {
        invoiceId: final.value.invoiceId,
        available: false,
        reason:
          'Aucune écriture à passer : le solde est entièrement couvert par les situations émises ' +
          '(chiffre d’affaires et TVA déjà constatés à chaque situation).',
      },
    });
  });

  it('montant de situation exigé avec son mode, refusé hors de son mode', async () => {
    const client = makeClient();
    const quoteId = await signedB2bQuote(client);
    const missing = await client.generateInvoice({ quoteId, mode: 'situation' });
    expect(missing.ok).toBe(false);
    const misplaced = await client.generateInvoice({
      quoteId,
      mode: 'final',
      situation: { percent: 10 },
    });
    expect(misplaced.ok).toBe(false);
  });
});

describe('Suivi de transmission + guide (canal de facturation)', () => {
  it('facture émise : patch partiel dépôt puis acceptation, guide email par défaut sur getInvoice', async () => {
    const client = makeClient();
    const composed = await client.composeStandaloneInvoice({
      customerId: 'cust-martin',
      lines: [{ label: 'Régie', category: 'labor', qty: 1, unitPriceHT: 50_000, vatRate: 20 }],
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    const invoiceId = composed.value.invoiceId;
    // Brouillon : rien à transmettre (refus domaine).
    const early = await client.recordInvoiceTransmission({ invoiceId, depositedAt: '2026-06-02' });
    expect(early.ok).toBe(false);
    const issued = await client.issueInvoice({ invoiceId });
    expect(issued.ok).toBe(true);
    const deposit = await client.recordInvoiceTransmission({ invoiceId, depositedAt: '2026-06-02' });
    expect(deposit.ok && deposit.value.transmission).toEqual({
      depositedAt: '2026-06-02',
      acceptedAt: null,
    });
    const accept = await client.recordInvoiceTransmission({ invoiceId, acceptedAt: '2026-06-05' });
    expect(accept.ok && accept.value.transmission).toEqual({
      depositedAt: '2026-06-02',
      acceptedAt: '2026-06-05',
    });
    const view = await client.getInvoice(invoiceId);
    expect(view.ok && view.value.transmission).toEqual({
      depositedAt: '2026-06-02',
      acceptedAt: '2026-06-05',
    });
    // Guide : canal ABSENT de la fiche Martin → email par défaut, e-mail du client vérifié.
    expect(view.ok && view.value.transmissionGuide).toMatchObject({ channel: 'email' });
  });

  it('brouillon : AUCUN guide de transmission (rien à transmettre)', async () => {
    const client = makeClient();
    const composed = await client.composeStandaloneInvoice({
      customerId: 'cust-martin',
      lines: [{ label: 'Régie', category: 'labor', qty: 1, unitPriceHT: 50_000, vatRate: 20 }],
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    const view = await client.getInvoice(composed.value.invoiceId);
    expect(view.ok && view.value.transmissionGuide).toBeUndefined();
  });
});

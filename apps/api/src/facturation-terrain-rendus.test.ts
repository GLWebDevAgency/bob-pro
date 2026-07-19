import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { InvoicePdfData, QuotePdfData } from '@bob/core';
import { PdfRenderer } from './documents/pdf-renderer';

/**
 * ÉPIC « facturation terrain » — RENDUS PDF (PdfRenderer réel) :
 *  • B3 : remises VISIBLES par ligne + récapitulatif (HT brut / rabais / HT net) — la mention
 *    L441-9 voyage dans le bloc mentions (buildMentions, testé côté core) ;
 *  • B2 : sous-titre « Situation n°N — avancement X % du marché » ;
 *  • B5 : ligne DÉDIÉE de retenue de garantie déduite du net à payer.
 */

/** Même helper que pieces-conformes-rendus.test.ts / purchase-order-flow.test.ts. */
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

const baseInvoiceData: InvoicePdfData = {
  number: 'F-2026-0042',
  companyName: 'Mercier Plomberie',
  companyAddress: '12 rue des Artisans, 92000 Nanterre',
  companyRcsOrRm: 'RM 92',
  customerName: 'Boulangerie Lefèvre',
  customerAddress: '3 place du Marché, 92310 Sèvres',
  issuedAt: '2026-07-19',
  dueAt: '2026-08-18',
  kind: 'final',
  lines: [{ label: 'Rénovation fournil', qty: 1, unitPriceHT: 180_000, vatRate: 20 }],
  totals: { ht: 180_000, vat: 36_000, ttc: 216_000, netToPay: 216_000 },
  mentions: [],
  billingPresentation: { accentColor: 'navy', rib: null, insurance: null },
};

describe('B3 — remises visibles (facture)', () => {
  it('remise de ligne + récapitulatif HT brut / rabais / HT net', async () => {
    const bytes = await new PdfRenderer().renderInvoice({
      ...baseInvoiceData,
      lines: [
        {
          label: 'Rénovation fournil',
          qty: 1,
          unitPriceHT: 200_000,
          vatRate: 20,
          discount: { type: 'percent', value: 10 },
        },
      ],
      totals: {
        ht: 175_000,
        vat: 35_000,
        ttc: 210_000,
        netToPay: 210_000,
        grossHt: 200_000,
        discountCents: 25_000,
      },
    });
    const text = pdfVisibleText(bytes);
    expect(text).toContain('remise 10 %');
    expect(text).toContain('Total HT brut');
    expect(text).toContain('Rabais, remises et ristournes');
    expect(text).toContain('Total HT net');
  });

  it('sans remise : AUCUN récapitulatif ni libellé « net » parasite (pièces antérieures intactes)', async () => {
    const bytes = await new PdfRenderer().renderInvoice(baseInvoiceData);
    const text = pdfVisibleText(bytes);
    expect(text).not.toContain('Total HT brut');
    expect(text).not.toContain('Rabais');
    expect(text).not.toContain('remise');
    expect(text).toContain('Total HT :');
  });
});

describe('B2 — situation de travaux (facture)', () => {
  it('sous-titre « Situation n°N — avancement X % du marché »', async () => {
    const bytes = await new PdfRenderer().renderInvoice({
      ...baseInvoiceData,
      kind: 'situation',
      situation: { order: 2, advancementPct: 30 },
    });
    const text = pdfVisibleText(bytes);
    expect(text).toContain('Situation n');
    expect(text).toContain('avancement 30 % du march');
  });

  it('avancement non résolvable : n° imprimé SEUL, jamais un pourcentage inventé', async () => {
    const bytes = await new PdfRenderer().renderInvoice({
      ...baseInvoiceData,
      kind: 'situation',
      situation: { order: 1, advancementPct: null },
    });
    const text = pdfVisibleText(bytes);
    expect(text).toContain('Situation n');
    expect(text).not.toContain('avancement');
  });
});

describe('B5 — retenue de garantie (facture)', () => {
  it('ligne dédiée avec taux, déduite du net à payer', async () => {
    const bytes = await new PdfRenderer().renderInvoice({
      ...baseInvoiceData,
      kind: 'situation',
      situation: { order: 1, advancementPct: 30 },
      retenueGarantiePct: 5,
      totals: {
        ht: 300_000,
        vat: 60_000,
        ttc: 360_000,
        netToPay: 342_000,
        retenueGarantieCents: 18_000,
      },
    });
    const text = pdfVisibleText(bytes);
    expect(text).toContain('Retenue de garantie (5 %)');
    expect(text).toContain('Net a payer');
  });

  it('sans retenue : aucune ligne de retenue', async () => {
    const bytes = await new PdfRenderer().renderInvoice(baseInvoiceData);
    expect(pdfVisibleText(bytes)).not.toContain('Retenue de garantie');
  });
});

describe('B3 — remises visibles (devis)', () => {
  it('remise de ligne + récapitulatif sur la proposition', async () => {
    const data: QuotePdfData = {
      number: 'D-2026-0031',
      companyName: 'Mercier Plomberie',
      companyAddress: '12 rue des Artisans, 92000 Nanterre',
      companyRcsOrRm: 'RM 92',
      customerName: 'Boulangerie Lefèvre',
      customerAddress: '3 place du Marché, 92310 Sèvres',
      validUntil: '2026-08-19',
      lines: [
        {
          label: 'Rénovation fournil',
          qty: 1,
          unitPriceHT: 200_000,
          vatRate: 20,
          discount: { type: 'amount', cents: 25_000 },
        },
      ],
      totals: {
        ht: 175_000,
        vat: 35_000,
        ttc: 210_000,
        netToPay: 210_000,
        grossHt: 200_000,
        discountCents: 25_000,
      },
      depositPct: null,
      signedBy: null,
      mentions: [],
    };
    const text = pdfVisibleText(await new PdfRenderer().renderQuote(data));
    expect(text).toContain('remise 250,00');
    expect(text).toContain('Total HT brut');
    expect(text).toContain('Rabais, remises et ristournes');
  });
});

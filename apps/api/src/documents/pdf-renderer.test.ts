import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { InvoicePdfData, QuotePdfData } from '@bob/core';
import {
  PDF_ACCENT_HEX,
  PdfRenderer,
  monogramInitials,
  parseSignatureSvgDataUrl,
} from './pdf-renderer';
import {
  hexFillTriplet,
  pdfFillColors,
  pdfPageTexts,
  pdfStructuralText,
  pdfVisibleText,
} from './pdf-text.testing';

/**
 * Refonte premium « Fintech chaleureuse » des PDF devis/factures :
 *  • WYSIWYG couleur : les accents imprimés = les pastilles EXACTES du sélecteur mobile
 *    (themes.marine.d1 / semantic.success / semantic.b2g / semantic.warning) ;
 *  • accent tenant étendu au DEVIS (additif, fallback navy pour les adapters existants) ;
 *  • pagination à blocs mesurés (le renderer historique débordait sous y=0) + footer 2e passe ;
 *  • signature : carte état signé (fail-closed : tracé dessiné UNIQUEMENT si l'image existe) ;
 *  • logo : slot + monogramme fallback (jamais un trou) ;
 *  • intouchables : Factur-X (attach + XMP), strings légales verbatim en un seul drawText.
 */

const PICKER_SWATCHES: Record<string, string> = {
  // apps/mobile/app/reglages-facturation.tsx — pastilles touchées par l'artisan.
  navy: '#0C2340', // themes.marine.d1
  green: '#0E7C5A', // semantic.success
  purple: '#4338CA', // semantic.b2g
  orange: '#C77A12', // semantic.warning
};

const baseInvoice: InvoicePdfData = {
  number: 'F-2026-0100',
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
  mentions: ['Mention légale A', 'Mention légale B'],
  billingPresentation: { accentColor: 'navy', rib: null, insurance: null },
};

const baseQuote: QuotePdfData = {
  number: 'D-2026-0200',
  companyName: 'Mercier Plomberie',
  companyAddress: '12 rue des Artisans, 92000 Nanterre',
  companyRcsOrRm: 'RM 92',
  customerName: 'Mme Durand',
  customerAddress: '12 rue des Lilas, 92310 Sèvres',
  validUntil: '2026-08-19',
  lines: [{ label: 'Remplacement chauffe-eau', qty: 1, unitPriceHT: 120_000, vatRate: 10 }],
  totals: { ht: 120_000, vat: 12_000, ttc: 132_000, netToPay: 132_000 },
  depositPct: null,
  signedBy: null,
  mentions: ['Devis gratuit.'],
};

// PNG 1×1 valide (slot logo) — le contenu importe peu, le MIME réel est sniffé.
const TINY_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const padSignatureDataUrl = (): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="120" viewBox="0 0 300 120">' +
      '<path d="M 10 60 Q 40 20 80 60" fill="none" stroke="#0C2340" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M 90 60 L 120 60" fill="none" stroke="#0C2340" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>',
  )}`;

describe('WYSIWYG couleur — recalage des accents sur les tokens du sélecteur mobile', () => {
  it('les 4 aplats `base` sont EXACTEMENT les pastilles touchées par l’artisan', () => {
    for (const [accent, hex] of Object.entries(PICKER_SWATCHES)) {
      expect(PDF_ACCENT_HEX[accent as keyof typeof PDF_ACCENT_HEX].base).toBe(hex);
    }
  });

  it.each(['navy', 'green', 'purple', 'orange'] as const)(
    'facture %s : le bandeau/héros peignent base ET deep recalés',
    async (accent) => {
      const bytes = await new PdfRenderer().renderInvoice({
        ...baseInvoice,
        billingPresentation: { ...baseInvoice.billingPresentation, accentColor: accent },
      });
      const fills = await pdfFillColors(bytes);
      expect(fills).toContain(hexFillTriplet(PDF_ACCENT_HEX[accent].base));
      expect(fills).toContain(hexFillTriplet(PDF_ACCENT_HEX[accent].deep));
    },
  );

  it('devis : l’accent tenant arrive par accentColor (plomberie additive)', async () => {
    const bytes = await new PdfRenderer().renderQuote({ ...baseQuote, accentColor: 'green' });
    const fills = await pdfFillColors(bytes);
    expect(fills).toContain(hexFillTriplet(PDF_ACCENT_HEX.green.base));
  });

  it('devis sans accentColor (adapters existants) : fallback navy, jamais un crash', async () => {
    const bytes = await new PdfRenderer().renderQuote(baseQuote);
    const fills = await pdfFillColors(bytes);
    expect(fills).toContain(hexFillTriplet(PDF_ACCENT_HEX.navy.base));
  });
});

describe('Pagination — blocs mesurés, en-tête de tableau réimprimé, footer 2e passe', () => {
  it('une pièce longue pagine au lieu de déborder sous y=0, chaque mention reste intégrale', async () => {
    const lines = Array.from({ length: 36 }, (_, i) => ({
      label: `Poste ${i + 1} — fourniture et pose, main d'œuvre qualifiée comprise`,
      qty: 1,
      unitPriceHT: 10_000,
      vatRate: 20,
    }));
    const mentions = Array.from({ length: 12 }, (_, i) => `Mention légale numéro ${i + 1}.`);
    const bytes = await new PdfRenderer().renderInvoice({ ...baseInvoice, lines, mentions });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    const text = await pdfVisibleText(bytes);
    // L'en-tête de tableau est réimprimé sur chaque page où la table continue.
    expect((text.match(/DESIGNATION/g) ?? []).length).toBeGreaterThan(1);
    for (const mention of mentions) expect(text).toContain(mention);
    // Footer tamponné en 2e passe sur TOUTES les pages.
    for (const pageText of await pdfPageTexts(bytes)) {
      expect(pageText).toContain('Page');
      expect(pageText).toContain('Facture F-2026-0100');
    }
  });

  it('petite pièce : une seule page, titre et héros présents', async () => {
    const bytes = await new PdfRenderer().renderInvoice(baseInvoice);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const text = await pdfVisibleText(bytes);
    expect(text).toContain('Facture F-2026-0100');
    expect(text).toContain('Net a payer');
    expect(text).toContain('Emise le 2026-07-19');
    expect(text).toContain('Echeance : 2026-08-18');
  });
});

describe('Avoir — banneau ambre de rectification, footer créditeur', () => {
  it('la référence à la pièce annulée reste UNE string verbatim, jamais d’échéance', async () => {
    const bytes = await new PdfRenderer().renderInvoice({
      ...baseInvoice,
      number: 'A-2026-0009',
      kind: 'credit_note',
      creditNoteSource: {
        invoiceId: 'inv-1',
        kind: 'final',
        number: 'F-2026-0100',
        issuedAt: '2026-07-01',
      },
    });
    const pages = await pdfPageTexts(bytes);
    const runs = pages.join('\n').split('\n');
    expect(runs).toContain('Annule totalement la facture n° F-2026-0100 du 2026-07-01');
    const text = pages.join('\n');
    expect(text).toContain('Avoir A-2026-0009');
    expect(text).not.toContain('Facture A-2026-0009');
    expect(text).not.toContain('Echeance');
  });
});

describe('Cartes RIB / assurance — colonne gauche des totaux', () => {
  it('IBAN groupé par 4, BIC, assurance décennale gatée par le serveur', async () => {
    const bytes = await new PdfRenderer().renderInvoice({
      ...baseInvoice,
      billingPresentation: {
        accentColor: 'green',
        rib: { iban: 'FR7630001007941234567890185', bic: 'BDFEFRPP' },
        insurance: {
          insurer: 'AXA',
          policyNo: 'DEC-2026-1182',
          coverage: 'Couverture France entière, gros œuvre et second œuvre.',
          expiresAt: '2027-01-31',
        },
      },
    });
    const text = await pdfVisibleText(bytes);
    expect(text).toContain('Coordonnees de paiement');
    expect(text).toContain('IBAN : FR76 3000 1007 9412 3456 7890 185');
    expect(text).toContain('BIC : BDFEFRPP');
    expect(text).toContain('Assurance professionnelle');
    expect(text).toContain('AXA - police DEC-2026-1182');
    expect(text).toContain("Valable jusqu'au 2027-01-31");
  });
});

describe('Signature du devis — dignité du geste, fail-closed', () => {
  it('non signé : cadre de seing honnête', async () => {
    const text = await pdfVisibleText(await new PdfRenderer().renderQuote(baseQuote));
    expect(text).toContain('Date et signature du client');
    expect(text).not.toContain('Signe par');
  });

  it('signé sans tracé archivé (V1) : pastille + « Signe par … le JJ/MM/AAAA », jamais de fausse image', async () => {
    const text = await pdfVisibleText(
      await new PdfRenderer().renderQuote({
        ...baseQuote,
        signedBy: 'Mme Durand',
        signedAt: '2026-07-19T10:30:00.000Z',
      }),
    );
    expect(text).toContain('Signe par Mme Durand');
    expect(text).toContain('le 19/07/2026');
    expect(text).not.toContain('Date et signature du client');
  });

  it('signé avec tracé (cible) : le SVG du pad est dessiné vectoriellement', async () => {
    const bytes = await new PdfRenderer().renderQuote({
      ...baseQuote,
      signedBy: 'Mme Durand',
      signedAt: '2026-07-19T10:30:00.000Z',
      signatureSvg: padSignatureDataUrl(),
    });
    const text = await pdfVisibleText(bytes);
    expect(text).toContain('Signe par Mme Durand');
    expect(text).not.toContain('Date et signature du client');
  });

  it('tracé illisible : fail-closed sur la carte compacte (jamais de placeholder)', async () => {
    const text = await pdfVisibleText(
      await new PdfRenderer().renderQuote({
        ...baseQuote,
        signedBy: 'Mme Durand',
        signatureSvg: 'data:image/png;base64,QUJD',
      }),
    );
    expect(text).toContain('Signe par Mme Durand');
  });

  it('parseSignatureSvgDataUrl : data-URL du pad → viewBox + paths ; déchets → null', () => {
    const parsed = parseSignatureSvgDataUrl(padSignatureDataUrl());
    expect(parsed?.width).toBe(300);
    expect(parsed?.height).toBe(120);
    expect(parsed?.paths).toHaveLength(2);
    expect(parseSignatureSvgDataUrl('data:image/png;base64,QUJD')).toBeNull();
    expect(parseSignatureSvgDataUrl('data:image/svg+xml;utf8,<svg></svg>')).toBeNull();
  });
});

describe('Logo — slot + monogramme fallback (jamais un trou)', () => {
  it('sans logo : monogramme aux initiales de la société', async () => {
    const bytes = await new PdfRenderer().renderInvoice(baseInvoice);
    const runs = (await pdfPageTexts(bytes))[0]!.split('\n');
    expect(runs).toContain('MP');
  });

  it('logo PNG valide : embarqué, le monogramme s’efface', async () => {
    const bytes = await new PdfRenderer().renderInvoice({ ...baseInvoice, logoBytes: TINY_PNG });
    const runs = (await pdfPageTexts(bytes))[0]!.split('\n');
    expect(runs).not.toContain('MP');
    expect(Buffer.from(bytes).toString('latin1')).toContain('/Image');
  });

  it('octets invalides : fail-safe silencieux vers le monogramme', async () => {
    const bytes = await new PdfRenderer().renderInvoice({
      ...baseInvoice,
      logoBytes: Uint8Array.from([1, 2, 3, 4]),
    });
    const runs = (await pdfPageTexts(bytes))[0]!.split('\n');
    expect(runs).toContain('MP');
  });

  it('monogramInitials : deux lettres significatives, toujours quelque chose', () => {
    expect(monogramInitials('Mercier Plomberie')).toBe('MP');
    expect(monogramInitials('Bob')).toBe('BO');
    expect(monogramInitials('  ')).toBe('B');
  });
});

describe('Rétractation A3 — pages dédiées, sobriété du corps', () => {
  const retractation = {
    noticeLines: [
      'Droit de rétractation',
      'Vous avez le droit de vous rétracter du présent contrat sans donner de motif dans un délai de quatorze jours.',
      'Effets de rétractation',
      'En cas de rétractation de votre part du présent contrat, nous vous rembourserons tous les paiements reçus de vous sans retard excessif.',
    ],
    formLines: [
      'Formulaire de rétractation',
      "À l'attention de Mercier Plomberie, 12 rue des Artisans, 92000 Nanterre :",
      'Date :',
      '(*) Rayez la mention inutile.',
    ],
  };

  it('avis + formulaire détachable sur pages dédiées, intertitre en un seul draw', async () => {
    const bytes = await new PdfRenderer().renderQuote({ ...baseQuote, retractation });
    const pages = await pdfPageTexts(bytes);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const noticePage = pages.find((p) => p.includes('Droit de rétractation'));
    expect(noticePage).toBeDefined();
    expect(noticePage!.split('\n')).toContain('Effets de rétractation');
    const formPage = pages.find((p) => p.includes('Formulaire de rétractation'));
    expect(formPage).toBeDefined();
    expect(formPage).toContain('Rayez la mention inutile');
    expect(formPage).not.toBe(noticePage);
  });
});

describe('Intouchables — Factur-X (attach + XMP) traverse la refonte à l’identique', () => {
  it('factur-x.xml attaché (AFRelationship Data) + XMP BASIC présents', async () => {
    const bytes = await new PdfRenderer().renderInvoice(baseInvoice, {
      xml: '<rsm:CrossIndustryInvoice>fixture</rsm:CrossIndustryInvoice>',
    });
    const structural = pdfStructuralText(bytes);
    expect(structural).toContain('factur-x.xml');
    expect(structural).toContain('AFRelationship');
    expect(structural).toContain('CrossIndustryInvoice');
    expect(structural).toContain('<fx:ConformanceLevel>BASIC</fx:ConformanceLevel>');
    // Et le document reste lisible/extrayable comme n'importe quelle pièce.
    expect(await pdfVisibleText(bytes)).toContain('Facture F-2026-0100');
  });
});

describe('Acompte devis + chips', () => {
  it('chip acompte verbatim sous le héros ; « Valable jusqu’au » en chip de bandeau', async () => {
    const text = await pdfVisibleText(
      await new PdfRenderer().renderQuote({
        ...baseQuote,
        depositPct: 30,
        totals: { ...baseQuote.totals, netToPay: 39_600 },
      }),
    );
    expect(text).toContain('Acompte a la signature (30 %) : 396,00');
    expect(text).toContain("Valable jusqu'au 2026-08-19");
  });
});

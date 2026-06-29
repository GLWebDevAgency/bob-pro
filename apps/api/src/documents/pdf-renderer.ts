import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatEUR, type PdfRendererPort, type InvoicePdfData } from '@bob/core';

export const PDF_RENDERER = Symbol('PDF_RENDERER');

// WinAnsi (Helvetica) ne sait pas encoder l'espace fine U+202F ni les guillemets typographiques.
const sanitize = (s: string): string =>
  s
    .replace(/[  ]/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-');

const money = (cents: number): string => sanitize(formatEUR(cents));

function wrap(text: string, max: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if ((current + ' ' + w).trim().length > max) {
      if (current) lines.push(current.trim());
      current = w;
    } else {
      current = `${current} ${w}`;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

export class PdfRenderer implements PdfRendererPort {
  async renderInvoice(data: InvoicePdfData): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page: PDFPage = doc.addPage([595, 842]);
    const font: PDFFont = await doc.embedFont(StandardFonts.Helvetica);
    const bold: PDFFont = await doc.embedFont(StandardFonts.HelveticaBold);
    const ink = rgb(0.05, 0.14, 0.25);
    const slate = rgb(0.36, 0.42, 0.48);
    let y = 800;
    const draw = (text: string, size = 10, f: PDFFont = font, color = ink): void => {
      page.drawText(sanitize(text), { x: 40, y, size, font: f, color });
      y -= size + 6;
    };

    draw(`Facture ${data.number}`, 22, bold);
    y -= 8;
    draw(data.companyName, 12, bold);
    draw(data.companyAddress);
    if (data.companyRcsOrRm) draw(data.companyRcsOrRm);
    y -= 12;
    draw(`Client : ${data.customerName}`, 11, bold);
    draw(data.customerAddress);
    if (data.issuedAt) draw(`Emise le ${data.issuedAt}`);
    if (data.dueAt) draw(`Echeance : ${data.dueAt}`);
    y -= 12;

    draw('Designation', 10, bold);
    for (const l of data.lines) {
      draw(`${l.label}  -  ${l.qty} x ${money(l.unitPriceHT)} HT  (TVA ${l.vatRate} %)`);
    }
    y -= 10;
    draw(`Total HT : ${money(data.totals.ht)}`, 11);
    draw(`TVA : ${money(data.totals.vat)}`, 11);
    draw(`Total TTC : ${money(data.totals.ttc)}`, 13, bold);
    draw(`Net a payer : ${money(data.totals.netToPay)}`, 13, bold);
    y -= 16;

    draw('Mentions legales', 9, bold);
    for (const m of data.mentions) {
      for (const chunk of wrap(m, 100)) draw(chunk, 7, font, slate);
    }
    return doc.save();
  }
}

import { PDFDocument, StandardFonts, rgb, AFRelationship, PDFName, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatEUR, type PdfRendererPort, type InvoicePdfData, type QuotePdfData } from '@bob/core';

export const PDF_RENDERER = Symbol('PDF_RENDERER');

// WinAnsi (Helvetica) ne sait pas encoder l'espace fine U+202F ni les guillemets typographiques.
// Échappements \u explicites : robuste aux normalisations de fichier (formatEUR insère U+202F).
const sanitize = (s: string): string =>
  s
    .replace(/[\u00a0\u202f\u2007\u2009]/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, '-');

const money = (cents: number): string => sanitize(formatEUR(cents));

function accentColor(accent: InvoicePdfData['billingPresentation']['accentColor']) {
  switch (accent) {
    case 'green':
      return rgb(0.03, 0.48, 0.29);
    case 'purple':
      return rgb(0.42, 0.30, 0.72);
    case 'orange':
      return rgb(0.88, 0.43, 0.08);
    case 'navy':
      return rgb(0.05, 0.14, 0.25);
  }
}

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

/**
 * Paquet XMP déclarant le fichier comme Factur-X (profil BASIC) — reconnaissance par les
 * plateformes e-invoicing. NB : la conformité PDF/A-3 stricte (polices embarquées, OutputIntent sRGB)
 * exige un post-traitement (Ghostscript/veraPDF) en prod ; ici le XML CII et l'association de fichier
 * sont corrects, ce qui est l'essentiel du payload e-invoicing.
 */
function facturXXmp(): string {
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>3</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
   <fx:DocumentType>INVOICE</fx:DocumentType>
   <fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>
   <fx:Version>1.0</fx:Version>
   <fx:ConformanceLevel>BASIC</fx:ConformanceLevel>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
   <pdfaExtension:schemas>
    <rdf:Bag>
     <rdf:li rdf:parseType="Resource">
      <pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>
      <pdfaSchema:namespaceURI>urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#</pdfaSchema:namespaceURI>
      <pdfaSchema:prefix>fx</pdfaSchema:prefix>
      <pdfaSchema:property>
       <rdf:Seq>
        <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentFileName</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>Name of the embedded XML invoice file</pdfaProperty:description></rdf:li>
        <rdf:li rdf:parseType="Resource"><pdfaProperty:name>DocumentType</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>INVOICE</pdfaProperty:description></rdf:li>
        <rdf:li rdf:parseType="Resource"><pdfaProperty:name>Version</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The actual version of the Factur-X data</pdfaProperty:description></rdf:li>
        <rdf:li rdf:parseType="Resource"><pdfaProperty:name>ConformanceLevel</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category><pdfaProperty:description>The conformance level of the Factur-X data</pdfaProperty:description></rdf:li>
       </rdf:Seq>
      </pdfaSchema:property>
     </rdf:li>
    </rdf:Bag>
   </pdfaExtension:schemas>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

export class PdfRenderer implements PdfRendererPort {
  async renderInvoice(data: InvoicePdfData, facturX?: { xml: string }): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page: PDFPage = doc.addPage([595, 842]);
    const font: PDFFont = await doc.embedFont(StandardFonts.Helvetica);
    const bold: PDFFont = await doc.embedFont(StandardFonts.HelveticaBold);
    const ink = rgb(0.05, 0.14, 0.25);
    const slate = rgb(0.36, 0.42, 0.48);
    const accent = accentColor(data.billingPresentation.accentColor);
    page.drawRectangle({ x: 0, y: 834, width: 595, height: 8, color: accent });
    let y = 800;
    const draw = (text: string, size = 10, f: PDFFont = font, color = ink): void => {
      page.drawText(sanitize(text), { x: 40, y, size, font: f, color });
      y -= size + 6;
    };

    draw(`Facture ${data.number}`, 22, bold, accent);
    y -= 8;
    draw(data.companyName, 12, bold);
    draw(data.companyAddress);
    if (data.companyRcsOrRm) draw(data.companyRcsOrRm);
    y -= 12;
    draw(`Client : ${data.customerName}`, 11, bold);
    draw(data.customerAddress);
    if (data.issuedAt) draw(`Emise le ${data.issuedAt}`);
    if (data.dueAt) draw(`Echeance : ${data.dueAt}`);
    // B8 — numéro d'engagement du client (bon de commande) : exigence de paiement des grands
    // comptes et obligation Chorus Pro. Zone références, sobre, avec la date de réception si connue.
    if (data.purchaseOrder) {
      const receivedAt = data.purchaseOrder.receivedAt
        ? ` du ${data.purchaseOrder.receivedAt.slice(0, 10)}`
        : '';
      draw(`Bon de commande n° ${data.purchaseOrder.number}${receivedAt}`);
    }
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

    if (data.billingPresentation.rib) {
      draw('Coordonnees de paiement', 9, bold, accent);
      draw(`IBAN : ${data.billingPresentation.rib.iban}`, 8);
      if (data.billingPresentation.rib.bic) {
        draw(`BIC : ${data.billingPresentation.rib.bic}`, 8);
      }
      y -= 8;
    }

    if (data.billingPresentation.insurance) {
      const insurance = data.billingPresentation.insurance;
      draw('Assurance professionnelle', 9, bold, accent);
      draw(`${insurance.insurer} - police ${insurance.policyNo}`, 8);
      for (const chunk of wrap(insurance.coverage, 100)) draw(chunk, 7, font, slate);
      draw(`Valable jusqu'au ${insurance.expiresAt}`, 7, font, slate);
      y -= 8;
    }

    draw('Mentions legales', 9, bold);
    for (const m of data.mentions) {
      for (const chunk of wrap(m, 100)) draw(chunk, 7, font, slate);
    }

    if (facturX) {
      // Pièce jointe associée : factur-x.xml (AFRelationship Data) — fait du PDF un hybride Factur-X.
      const xmlBytes = new TextEncoder().encode(facturX.xml);
      const now = new Date();
      await doc.attach(xmlBytes, 'factur-x.xml', {
        mimeType: 'application/xml',
        description: 'Facture electronique Factur-X (CII)',
        afRelationship: AFRelationship.Data,
        creationDate: now,
        modificationDate: now,
      });
      const metaStream = doc.context.stream(facturXXmp(), { Type: 'Metadata', Subtype: 'XML' });
      doc.catalog.set(PDFName.of('Metadata'), doc.context.register(metaStream));
    }

    return doc.save();
  }

  /** Devis — même famille visuelle que la facture (pdf-lib, une page A4) mais sans RIB/assurance/
   *  Factur-X : ce n'est pas une pièce comptable probante. Accent fixe (navy) : un devis n'a pas
   *  de `billingPresentation` (réglages propres aux factures). */
  async renderQuote(data: QuotePdfData): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page: PDFPage = doc.addPage([595, 842]);
    const font: PDFFont = await doc.embedFont(StandardFonts.Helvetica);
    const bold: PDFFont = await doc.embedFont(StandardFonts.HelveticaBold);
    const ink = rgb(0.05, 0.14, 0.25);
    const slate = rgb(0.36, 0.42, 0.48);
    const accent = rgb(0.05, 0.14, 0.25);
    page.drawRectangle({ x: 0, y: 834, width: 595, height: 8, color: accent });
    let y = 800;
    const draw = (text: string, size = 10, f: PDFFont = font, color = ink): void => {
      page.drawText(sanitize(text), { x: 40, y, size, font: f, color });
      y -= size + 6;
    };

    draw(`Devis ${data.number}`, 22, bold, accent);
    y -= 8;
    draw(data.companyName, 12, bold);
    draw(data.companyAddress);
    if (data.companyRcsOrRm) draw(data.companyRcsOrRm);
    y -= 12;
    draw(`Client : ${data.customerName}`, 11, bold);
    draw(data.customerAddress);
    if (data.validUntil) draw(`Valable jusqu'au ${data.validUntil}`);
    y -= 12;

    draw('Designation', 10, bold);
    for (const l of data.lines) {
      draw(`${l.label}  -  ${l.qty} x ${money(l.unitPriceHT)} HT  (TVA ${l.vatRate} %)`);
    }
    y -= 10;
    draw(`Total HT : ${money(data.totals.ht)}`, 11);
    draw(`TVA : ${money(data.totals.vat)}`, 11);
    draw(`Total TTC : ${money(data.totals.ttc)}`, 13, bold);
    if (data.depositPct !== null) {
      draw(`Acompte a la signature (${data.depositPct} %) : ${money(data.totals.netToPay)}`, 10, font, slate);
    }
    y -= 8;

    if (data.signedBy) {
      draw(`Signe par ${data.signedBy}`, 9, bold, accent);
    }

    return doc.save();
  }
}

import { AFRelationship, PDFDocument, PDFName } from 'pdf-lib';

/**
 * Conteneur PDF minimal mais structurellement réel pour les tests de flux d'archive. Les anciens
 * faux octets `%PDF-...` contournaient précisément le parseur binaire que ces tests doivent
 * maintenant traverser.
 */
export async function renderPdfFixture(marker: string, facturXXml?: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([10, 10]);
  pdf.setSubject(marker);
  pdf.setCreationDate(new Date('2026-01-01T00:00:00.000Z'));
  pdf.setModificationDate(new Date('2026-01-01T00:00:00.000Z'));
  if (facturXXml !== undefined) {
    await pdf.attach(new TextEncoder().encode(facturXXml), 'factur-x.xml', {
      mimeType: 'application/xml',
      afRelationship: AFRelationship.Alternative,
    });
    const metadata = [
      '<pdfaid:part>3</pdfaid:part>',
      '<pdfaid:conformance>B</pdfaid:conformance>',
      '<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>',
      '<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>',
    ].join('');
    const metadataStream = pdf.context.stream(metadata, { Type: 'Metadata', Subtype: 'XML' });
    pdf.catalog.set(PDFName.of('Metadata'), pdf.context.register(metadataStream));
  }
  return pdf.save();
}

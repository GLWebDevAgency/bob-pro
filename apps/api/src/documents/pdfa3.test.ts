import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AFRelationship, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  decodeAndVerifySrgb2014Profile,
  facturXPdfFileId,
  inspectInvoicePdfRepresentation,
  loadSrgb2014Profile,
  SRGB_2014_PROFILE_BYTE_SIZE,
  SRGB_2014_PROFILE_SHA256,
} from './pdfa3';

describe('profil ICC sRGB2014 — autorité binaire fail-closed', () => {
  it('charge exactement l’asset officiel versionné', () => {
    const profile = loadSrgb2014Profile();
    expect(profile).toHaveLength(SRGB_2014_PROFILE_BYTE_SIZE);
    expect(createHash('sha256').update(profile).digest('hex')).toBe(SRGB_2014_PROFILE_SHA256);
  });

  it('refuse un asset altéré au lieu de produire un faux PDF/A', () => {
    const encoded = readFileSync(
      join(process.cwd(), 'assets', 'color', 'sRGB2014.icc.base64'),
      'utf8',
    );
    const corrupted = `${encoded.slice(0, -2)}AA`;
    expect(() => decodeAndVerifySrgb2014Profile(corrupted)).toThrowError(
      /PDF_ICC_PROFILE_INVALID/u,
    );
  });
});

describe('identifiant de fichier PDF/A', () => {
  it('est stable, long de 16 octets et séparé par le XML figé', () => {
    const first = facturXPdfFileId('<invoice id="1"/>');
    expect(first).toMatch(/^[0-9a-f]{32}$/u);
    expect(facturXPdfFileId('<invoice id="1"/>')).toBe(first);
    expect(facturXPdfFileId('<invoice id="2"/>')).not.toBe(first);
  });
});

describe('représentation byte-derived du PDF de facture', () => {
  const facturXXmp = [
    '<pdfaid:part>3</pdfaid:part>',
    '<pdfaid:conformance>B</pdfaid:conformance>',
    '<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>',
    '<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>',
  ].join('');

  function attachMetadata(pdf: PDFDocument, metadata: string): void {
    const metaStream = pdf.context.stream(metadata, { Type: 'Metadata', Subtype: 'XML' });
    pdf.catalog.set(PDFName.of('Metadata'), pdf.context.register(metaStream));
  }

  it('reconnaît un PDF simple sans fichier associé', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();

    await expect(inspectInvoicePdfRepresentation(await pdf.save())).resolves.toMatchObject({
      ok: true,
      profile: 'plain_pdf',
      detectorVersion: 1,
      embeddedXmlSha256: null,
    });
  });

  it('reconnaît le conteneur Factur-X exact émis par le renderer', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    await pdf.attach(new TextEncoder().encode('<CrossIndustryInvoice/>'), 'factur-x.xml', {
      mimeType: 'application/xml',
      afRelationship: AFRelationship.Alternative,
    });
    attachMetadata(pdf, facturXXmp);

    await expect(inspectInvoicePdfRepresentation(await pdf.save())).resolves.toMatchObject({
      ok: true,
      profile: 'facturx_pdfa3',
      detectorVersion: 1,
      embeddedXmlSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it('refuse une pièce jointe ambiguë au lieu de la prendre pour un PDF simple', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage();
    await pdf.attach(new TextEncoder().encode('preuve'), 'autre.xml', {
      mimeType: 'application/xml',
      afRelationship: AFRelationship.Data,
    });

    await expect(inspectInvoicePdfRepresentation(await pdf.save())).resolves.toEqual({
      ok: false,
      reason: 'unknown_or_ambiguous',
    });
  });

  it('accepte un XMP ordinaire mais refuse un XMP Factur-X sans pièce jointe', async () => {
    const ordinary = await PDFDocument.create();
    ordinary.addPage();
    attachMetadata(ordinary, '<dc:title>Facture lisible</dc:title>');
    await expect(inspectInvoicePdfRepresentation(await ordinary.save())).resolves.toMatchObject({
      ok: true,
      profile: 'plain_pdf',
    });

    const partial = await PDFDocument.create();
    partial.addPage();
    attachMetadata(partial, facturXXmp);
    await expect(inspectInvoicePdfRepresentation(await partial.save())).resolves.toEqual({
      ok: false,
      reason: 'unknown_or_ambiguous',
    });
  });

  it('refuse factur-x.xml sans XMP ou avec une relation AF incorrecte', async () => {
    const withoutXmp = await PDFDocument.create();
    withoutXmp.addPage();
    await withoutXmp.attach(new TextEncoder().encode('<CrossIndustryInvoice/>'), 'factur-x.xml', {
      mimeType: 'application/xml',
      afRelationship: AFRelationship.Alternative,
    });
    await expect(inspectInvoicePdfRepresentation(await withoutXmp.save())).resolves.toEqual({
      ok: false,
      reason: 'unknown_or_ambiguous',
    });

    const wrongRelationship = await PDFDocument.create();
    wrongRelationship.addPage();
    await wrongRelationship.attach(
      new TextEncoder().encode('<CrossIndustryInvoice/>'),
      'factur-x.xml',
      { mimeType: 'application/xml', afRelationship: AFRelationship.Data },
    );
    attachMetadata(wrongRelationship, facturXXmp);
    await expect(
      inspectInvoicePdfRepresentation(await wrongRelationship.save()),
    ).resolves.toEqual({ ok: false, reason: 'unknown_or_ambiguous' });
  });

  it('refuse plusieurs pièces jointes et un EmbeddedFile orphelin', async () => {
    const multiple = await PDFDocument.create();
    multiple.addPage();
    await multiple.attach(new TextEncoder().encode('<CrossIndustryInvoice/>'), 'factur-x.xml', {
      mimeType: 'application/xml',
      afRelationship: AFRelationship.Alternative,
    });
    await multiple.attach(new TextEncoder().encode('preuve'), 'preuve.txt', {
      mimeType: 'text/plain',
      afRelationship: AFRelationship.Data,
    });
    attachMetadata(multiple, facturXXmp);
    await expect(inspectInvoicePdfRepresentation(await multiple.save())).resolves.toEqual({
      ok: false,
      reason: 'unknown_or_ambiguous',
    });

    const orphan = await PDFDocument.create();
    orphan.addPage();
    orphan.context.register(orphan.context.stream(new TextEncoder().encode('orphan'), {
      Type: 'EmbeddedFile',
      Subtype: 'application#2Fxml',
    }));
    await expect(inspectInvoicePdfRepresentation(await orphan.save())).resolves.toEqual({
      ok: false,
      reason: 'unknown_or_ambiguous',
    });
  });

  it('refuse des octets qui ne forment pas un PDF', async () => {
    await expect(
      inspectInvoicePdfRepresentation(new TextEncoder().encode('not-a-pdf')),
    ).resolves.toEqual({ ok: false, reason: 'unknown_or_ambiguous' });
  });
});
